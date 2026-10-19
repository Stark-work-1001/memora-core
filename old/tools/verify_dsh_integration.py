"""Offline verification of the Memora/D SH integration: rendering, drift, heartbeat.

WHAT IT PROVES (and why each item is here)
------------------------------------------
The failure this replaces was silent: a profile that parses, loads, and yet points every spawn
path at a directory that no longer exists. Nothing crashed; the UI just said "no agent online".
So the assertions are about the *content* of the rendered profile, not about whether some
command exited zero:

  1. stale roots are FOUND when present and GONE after rendering (the scan must be able to fail,
     otherwise a green check means nothing);
  2. rendering is idempotent -- a second run is byte-identical, so re-running the installer is
     never harmful and `--check` can be exact;
  3. the connector insert list (which sits OUTSIDE the managed BEGIN/END markers, and was
     hand-added once) is replaced in place, and unrelated patch entries survive untouched;
  4. the rendered patch parses through the DSH host's own js-yaml;
  5. the heartbeat block is present AND sane: enabled, positive interval, ttl > interval,
     stable peer id -- plus the negative controls (disabled / missing / bad interval) that prove
     the check is capable of failing;
  6. the installed profile on this machine passes exactly the same checks -- the point of all of
     the above is to make that statement meaningful.

Run:
    .venv\\Scripts\\python.exe tools\\verify_dsh_integration.py
    (add --profile-quiet to skip the installed-profile section)
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))
if str(HERE.parent) not in sys.path:
    sys.path.insert(0, str(HERE.parent))

import dsh_profile  # noqa: E402
from paths import DEV  # noqa: E402

FAILURES: list[str] = []


def check(name: str, ok: bool, detail: str = '') -> None:
    # ASCII only: this script is also run under Windows consoles whose code page is not UTF-8,
    # and mojibake in a verification report is a bad reason to distrust a green result.
    print(f'  {"PASS" if ok else "FAIL"}  {name}{("  -- " + detail) if detail else ""}')
    if not ok:
        FAILURES.append(name)


def current_version() -> str:
    """The package version, which the managed block stamps into MEMORA_RUNTIME_VERSION."""
    from memora import __version__
    return __version__


def adapter_identity() -> tuple[str, Path]:
    """The adapter revision and its path, exactly as `install_dsh.py` derives them.

    The revision is the content hash of the lifecycle adapter, and it is part of the rendered
    block, so a synthetic value here would make "does the installed profile equal a fresh
    render?" fail for a reason that has nothing to do with drift.
    """
    import hashlib
    source = DEV / 'integrations/dsh/memora-plugin.mjs'
    revision = hashlib.sha256(source.read_bytes()).hexdigest()[:16]
    return revision, DEV / 'runtime/dsh/adapters' / f'memora-plugin-{revision}.mjs'


def render(text: str, dsh: Path, version: str | None = None) -> str:
    """Render exactly as the installer would for this tree."""
    revision, adapter = adapter_identity()
    return dsh_profile.render_profile(
        text, DEV, dsh, version or current_version(), revision, adapter)


SYNTHETIC = '''# user layer
- id: ui-theme
  name: "@deepseek-ai/dsh-client-ui-theme"
  config:
    preference: light

# BEGIN MEMORA MANAGED INTEGRATION
- insert:
    - id: memory-memora
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        command: "<project root>/.venv/Scripts/python.exe"
        args: ['-m', 'memora', '--data', "<project root>/data", 'mcp']
# END MEMORA MANAGED INTEGRATION
- insert:
    - id: memory-connector
      name: dsh-memory-connector
      config:
        backend: memora
        backends:
          memora:
            command: '<data dir>/memora-desktop-standalone/resources/backend/memora-backend.exe'
            args:
              - '--data'
              - '<data dir>/memora-desktop-standalone/data'
              - 'mcp'
            defaultProject: default
- id: my-own-entry
  name: some-private-plugin
  config:
    keep: me
'''


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dsh',
                        default=os.environ.get('MEMORA_DSH_ROOT')
                        or os.path.join(os.path.expanduser('~'), '.dsh'))
    parser.add_argument('--profile', default='desktop')
    parser.add_argument('--profile-quiet', action='store_true',
                        help='skip the section that inspects the installed profile')
    args = parser.parse_args()
    dsh = Path(args.dsh).resolve()

    print('1. stale-root scan can fail, and finds both owned blocks')
    stale_before = dsh_profile.stale_references(SYNTHETIC)
    check('stale pre-move paths detected in the synthetic profile', len(stale_before) >= 4,
          f'{len(stale_before)} line(s)')
    check('detected lines include the connector backend, not only the managed block',
          any('memora-desktop-standalone' in line for _, line in stale_before))
    rendered = render(SYNTHETIC, dsh)
    check('rendered profile has no pre-move path', dsh_profile.stale_references(rendered) == [],
          str(dsh_profile.stale_references(rendered)))
    check('rendered profile points at the development tree',
          str(DEV / '.venv/Scripts/python.exe').replace('\\', '/') in rendered)
    check('rendered connector backend points at the packaged product',
          str(dsh_profile.product_root(DEV) / 'resources/backend/memora-backend.exe')
          .replace('\\', '/') in rendered)

    print('\n2. rendering is idempotent (second run is byte-identical)')
    twice = render(rendered, dsh)
    check('re-rendering a rendered profile changes nothing', twice == rendered)
    check('rendering is a pure function of (text, tree)', render(SYNTHETIC, dsh) == rendered)

    print('\n3. unrelated patch entries survive the connector/ managed replacement')
    check('user entry before the blocks is preserved', '- id: ui-theme' in rendered)
    check('user entry after the blocks is preserved', '- id: my-own-entry' in rendered)
    check('user entry body is preserved', 'keep: me' in rendered)
    check('exactly one managed BEGIN marker remains', rendered.count(dsh_profile.BEGIN) == 1)
    check('exactly one managed END marker remains', rendered.count(dsh_profile.END) == 1)
    check('exactly one memory-connector insert row', rendered.count('- id: memory-connector') == 1)

    print('\n4. the rendered patch parses through the DSH host own js-yaml')
    entries, error = dsh_profile.parse_yaml(rendered)
    check('rendered patch parses', error is None, error or f'{len(entries or [])} entries')
    check('parsed top-level list keeps the user entry',
          error is None and any(e.get('id') == 'my-own-entry' for e in entries))

    print('\n5. heartbeat block is rendered AND asserted')
    summary = dsh_profile.heartbeat_summary(entries or [])
    check('heartbeat row found', summary.get('found') is True)
    check('heartbeat passes its own assertions', summary.get('ok') is True,
          str(summary.get('problems') or ''))
    check('heartbeat enabled', summary.get('enabled') is True)
    check('heartbeat interval is positive', (summary.get('interval_ms') or 0) > 0,
          f'{summary.get("interval_ms")}ms')
    check('heartbeat ttl exceeds the interval', summary.get('ttl_s', 0) * 1000 >
          (summary.get('interval_ms') or 0))
    check('heartbeat peer id is stable and non-empty', bool(summary.get('peer')),
          str(summary.get('peer')))

    print('\n5b. negative controls: the heartbeat check can actually fail')
    disabled = rendered.replace('          enabled: true', '          enabled: false')
    check('disabled heartbeat is reported broken',
          dsh_profile.heartbeat_summary(dsh_profile.parse_yaml(disabled)[0]).get('ok') is False)
    bad_interval = rendered.replace('          intervalMs: 30000', '          intervalMs: 0')
    check('zero interval is reported broken',
          dsh_profile.heartbeat_summary(dsh_profile.parse_yaml(bad_interval)[0]).get('ok') is False)
    missing = rendered.replace('        heartbeat:', '        heartbeat_disabled_for_test:')
    check('missing heartbeat block is reported broken',
          dsh_profile.heartbeat_summary(dsh_profile.parse_yaml(missing)[0]).get('ok') is False)
    drop_row = rendered.replace('    - id: memory-connector', '    - id: memory-connector-renamed')
    check('missing connector row is reported broken (and says so explicitly)',
          dsh_profile.heartbeat_summary(dsh_profile.parse_yaml(drop_row)[0]).get('found') is False)

    if not args.profile_quiet:
        print(f'\n6. the profile installed on this machine ({args.profile}) passes the same checks')
        target = dsh / 'config/dsh-home/profiles' / args.profile / 'cordis.patch.yml'
        if not target.exists():
            check('installed profile exists', False, str(target))
        else:
            text = target.read_text('utf-8')
            check('installed profile has no pre-move path',
                  dsh_profile.stale_references(text) == [],
                  str(dsh_profile.stale_references(text)))
            installed_entries, installed_error = dsh_profile.parse_yaml(text)
            check('installed profile parses', installed_error is None,
                  installed_error or f'{len(installed_entries or [])} entries')
            installed_heartbeat = dsh_profile.heartbeat_summary(installed_entries or [])
            check('installed profile heartbeat is configured', installed_heartbeat.get('ok') is True,
                  str(installed_heartbeat.get('problems') or installed_heartbeat))
            check('installed profile is exactly what the installer would write',
                  render(text, dsh) == text)

    print()
    if FAILURES:
        print(f'{len(FAILURES)} check(s) FAILED: ' + ', '.join(FAILURES))
        return 1
    print('All DSH integration checks passed.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
