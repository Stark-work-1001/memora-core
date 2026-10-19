"""Append-or-refresh the Memora-owned entries of an existing DSH profile patch.

Directory contract (see docs/DIRECTORY-LAYOUT.md): this file lives in <dev>/tools/. Source,
adapters, backups and dev runtime state live under <dev>/; the interpreter is <dev>/.venv; the
memory store is <dev>/data.

WHAT CHANGED AND WHY
--------------------
The installer used to be one-way: it rendered a block, staged it, and `Install-Dsh.ps1`
copied it over the profile after a hash check. Nothing compared the *installed* profile with
what the current tree would render, so when the repository moved out of its old working
directory (and the packaged product became a sibling directory) the profile
kept absolute paths that no longer existed. Every string was still a string and the YAML still
parsed; the MCP child simply could not be spawned, so no peer ever registered and the UI
honestly said "无在线智能体（1 个已过期）".

Two things now make that class of drift loud instead of silent:

  * `--check` re-renders from the current tree and diffs the profile against it, naming every
    stale `.memory` line by number. It writes nothing.
  * the `memory-connector` insert list is rendered here too (it used to be hand-maintained
    outside the managed markers, which is why re-running the installer never fixed it), and it
    now carries the periodic `heartbeat` block.

Rendering itself lives in `tools/dsh_profile.py`: the PowerShell entry point, the check, the
tests and this installer must all agree on one block, and they cannot if each builds its own.
"""
import argparse
import hashlib
import json
import shutil
import sys as _sys
from datetime import datetime
from pathlib import Path
from pathlib import Path as _Path

if str(_Path(__file__).resolve().parent) not in _sys.path:
    _sys.path.insert(0, str(_Path(__file__).resolve().parent))
from paths import DEV as ROOT

# The venv's editable install still maps the package to the pre-move root
# (__editable___memora_1_3_0_finder.py MAPPING -> the old D: drive path), so importing
# `memora` here would otherwise depend on the current directory. Importing __version__ is
# worth two lines; failing the installer with ModuleNotFoundError is not.
if str(ROOT) not in _sys.path:
    _sys.path.insert(0, str(ROOT))

import dsh_profile

BEGIN = dsh_profile.BEGIN
END = dsh_profile.END


def active_plugin_path(version_source):
    """Copy the lifecycle adapter to its revision-addressed path and return it.

    A changed module URL is what avoids Node's ESM cache in the live Cordis host, so the file
    name carries the adapter's content hash and is regenerated on every change.
    """
    adapter_revision = hashlib.sha256(version_source.read_bytes()).hexdigest()[:16]
    active_plugin = ROOT / 'runtime/dsh/adapters' / f'memora-plugin-{adapter_revision}.mjs'
    active_plugin.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(version_source, active_plugin)
    return adapter_revision, active_plugin


def render(text, dsh, profile_name, version, interval_ms=30000):
    """Render the current profile text with both Memora-owned blocks refreshed."""
    plugin_source = ROOT / 'integrations/dsh/memora-plugin.mjs'
    adapter_revision, active_plugin = active_plugin_path(plugin_source)
    generated = dsh_profile.render_profile(
        text, ROOT, dsh, version, adapter_revision, active_plugin, interval_ms)
    return generated, adapter_revision, active_plugin


def report(text, label):
    """Print the stale references in `text`, if any."""
    stale = dsh_profile.stale_references(text)
    for number, line in stale:
        print(f'  STALE {label}:{number}: {line}')
    return stale


def main():
    from memora import __version__
    parser = argparse.ArgumentParser(
        description='Refresh the Memora-owned entries of an existing DSH profile patch.')
    parser.add_argument('--dsh',
                        default=os.environ.get('MEMORA_DSH_ROOT')
                        or os.path.join(os.path.expanduser('~'), '.dsh'))
    parser.add_argument('--profile', default='desktop')
    parser.add_argument(
        '--check', action='store_true',
        help='report drift and stale absolute paths without writing anything')
    parser.add_argument(
        '--heartbeat-interval-ms', type=int, default=30000,
        help='periodic heartbeat interval written into the connector block (default 30000)')
    args = parser.parse_args()

    dsh = Path(args.dsh).resolve()
    profile = dsh / 'config/dsh-home/profiles' / args.profile
    if not profile.is_dir():
        raise SystemExit('Existing DSH profile required; this installer does not create or '
                         'replace a profile')
    target = profile / 'cordis.patch.yml'
    text = target.read_text('utf-8') if target.exists() else ''
    generated, adapter_revision, active_plugin = render(
        text, dsh, args.profile, __version__, args.heartbeat_interval_ms)

    print(f'profile:   {target}')
    # Printed, not merely rendered: the adapter's first statement is an import() of this path,
    # and a dead one fails before any hook is registered -- so a run that silently resolved to
    # nothing is exactly the failure this installer exists to make impossible.
    print(f'  llmModule: {dsh_profile.llm_module(dsh)}')
    # The scan covers the WHOLE file, not just the managed block: the connector insert list sits
    # outside the BEGIN/END markers (it was hand-added once), which is exactly why re-running the
    # old installer never fixed its .memory paths.
    stale = report(text, 'installed')
    entries, parse_error = dsh_profile.parse_yaml(generated)
    if parse_error:
        print(f'  YAML:    NOT PARSED ({parse_error})')
        healthy = False
    else:
        print(f'  YAML:    parses, {len(entries)} top-level patch entries')
        healthy = True
    heartbeat = dsh_profile.heartbeat_summary(entries) if healthy else {'ok': False}
    if heartbeat.get('found'):
        state = 'ok' if heartbeat['ok'] else 'BROKEN'
        print(f'  heartbeat: {state} enabled={heartbeat.get("enabled")} '
              f'interval={heartbeat.get("interval_ms")}ms ttl={heartbeat.get("ttl_s")}s '
              f'peer={heartbeat.get("peer")} project={heartbeat.get("project")}')
        for problem in heartbeat.get('problems') or []:
            print(f'    heartbeat problem: {problem}')
        print(f'  connector backend: {heartbeat.get("backend_command")} '
              f'--data {heartbeat.get("backend_data")}')
    else:
        print('  heartbeat: BROKEN — the memory-connector insert row is missing from the '
              'profile, so nothing refreshes peer presence')
    if stale:
        print(f'  drift:   {len(stale)} stale line(s) in the installed profile will be replaced')
    else:
        print('  drift:   none')

    if args.check:
        changed = generated != text
        # Byte inequality is not the same failure as semantic inequality. The renderer writes
        # long strings on one line and normalizes flow-sequence spacing, so a profile that was
        # once applied by a different yaml.dump setting differs byte-wise while parsing to the
        # SAME rows. Treating that as drift made --check permanently red, which is how a real
        # drift signal gets ignored -- so compare the parsed rows, and report formatting
        # separately.
        semantics_match = True
        if changed and healthy:
            installed_entries, installed_error = dsh_profile.parse_yaml(text)
            rendered_entries, render_error = dsh_profile.parse_yaml(generated)
            semantics_match = (installed_error is None and render_error is None
                               and installed_entries == rendered_entries)
        clean = healthy and heartbeat.get('ok') and not stale and semantics_match
        if clean and changed:
            print('  format:  byte-diff only (same parsed rows; --check never rewrites for style)')
        print(f'  result:  {"clean" if clean else "DRIFT"} (--check wrote nothing)')
        raise SystemExit(0 if clean else 1)

    if not target.exists():
        raise SystemExit(f'existing profile patch required: {target}')
    repo_backup, beside = dsh_profile.backup(target, ROOT, args.profile)

    # Stage locally. The PowerShell entry applies it with native filesystem APIs, checks the
    # original hash, and never rewrites unrelated user configuration.
    staged = ROOT / 'runtime/dsh' / (f'{args.profile}.cordis.patch.generated.yml')
    staged.parent.mkdir(parents=True, exist_ok=True)
    # newline='\n' keeps the staged file byte-identical to what read_text() would hand back
    # (Python's text mode would otherwise write CRLF on Windows, so the installed file and the
    # re-rendered one would differ by line endings alone and --check could never be clean).
    staged.write_text(generated, 'utf-8', newline='\n')
    manifest = {
        'target': str(target),
        'generated': str(staged),
        'original_sha256': hashlib.sha256(target.read_bytes()).hexdigest(),
        'backups': [str(repo_backup), str(beside)],
        'connector_block_replaced': True,
        'heartbeat': {'enabled': True, 'interval_ms': args.heartbeat_interval_ms},
        'adapter': str(active_plugin),
        'adapter_revision': adapter_revision,
        'stamped': datetime.now().isoformat(timespec='seconds'),
    }
    (ROOT / 'runtime/dsh-install.json').write_text(json.dumps(manifest, indent=2), 'utf-8')

    # Kept as the readable sample of exactly what this installer owns.
    sample = ROOT / 'integrations/dsh/memora.cordis.yml'
    sample.write_text(
        dsh_profile.render_managed_block(ROOT, dsh, __version__, adapter_revision, active_plugin),
        'utf-8', newline='\n')

    print('Staged Memora MCP + lifecycle + connector integration for DSH profile:',
          args.profile)
    print('Will replace  :', target)
    print('Profile backup:', repo_backup)
    print('Profile backup:', beside)
    print('Adapter       :', active_plugin)
    print('Connector     : backend repointed, heartbeat enabled every '
          f'{args.heartbeat_interval_ms}ms')
    print('Apply with    : powershell -NoProfile -File '
          'integrations/dsh/Install-Dsh.ps1  (verifies the hash, then copies)')


if __name__ == '__main__':
    main()
