"""Single source of truth for the DSH profile patch Memora owns (render + drift check).

WHY THIS MODULE EXISTS
----------------------
`tools/install_dsh.py` used to render the managed block itself, and nothing ever compared
that block with the tree it was installed into. The tree moved
out of its old working directory (and the packaged product became a sibling
directory), the profile kept the old absolute paths, and
that failure is invisible on its own terms: the YAML stays valid, the strings stay strings, the
host keeps loading a plugin whose spawn paths do not exist. It only showed up as
"无在线智能体（1 个已过期）" in the UI.

So the paths are rendered here from `tools/paths.py` (never typed by hand), and
`install_dsh.py --check` compares the installed profile against a freshly rendered block.
A stale absolute path is reported by line, by value.

TWO OWNED BLOCKS, NOT ONE
-------------------------
The profile patch carries two Memora-relevant insert lists:

  1. the managed block (`# BEGIN/END MEMORA MANAGED INTEGRATION`) holding `memory-memora`
     and `memora-lifecycle`, which `install_dsh.py` has always generated;
  2. the `memory-connector` insert list -- the installed connector plugin's backend wiring.
     It was hand-adapted once (backup `cordis.patch.yml.bak-connector-adapt-*`) and is NOT
     inside the managed markers, which is exactly why re-running the installer never fixed it.

Both drifted for the same reason, so both are rendered here and both are replaced in place by
`render_profile()`. The replacement is textual and idempotent: the second run produces
byte-identical text, and every unrelated patch entry is left untouched (a YAML round-trip
through a dumper would reflow the whole file and bury the real change in noise).
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
from datetime import datetime
from pathlib import Path

BEGIN = '# BEGIN MEMORA MANAGED INTEGRATION'
END = '# END MEMORA MANAGED INTEGRATION'

#: The connector insert list this module also owns.
CONNECTOR_ID = 'memory-connector'

#: The pre-move project root. Any occurrence in a rendered profile is drift, by definition.
STALE_ROOT = '.memory/memora'

#: Where the host keeps its installed plugins. The lifecycle adapter is loaded BY the host out of
#: this tree, so this is also where a working `dsh-llm` already sits unpacked on disk.
#:
#: THE DEFAULT IS ONE MACHINE'S LAYOUT, SO IT MUST BE OVERRIDABLE. It used to be a bare literal,
#: which meant every caller inherited an assumption about this disk: a fresh checkout, a second
#: developer, or a CI runner has no drive-letter root at all, and rendering then raised a SystemExit whose
#: message blamed a missing plugin rather than the unresolvable root. Worse, tests written against
#: the literal could only report the absence of a drive-letter root -- they could never exercise the ordering
#: they existed to pin. `MEMORA_DSH_PLUGIN_ROOT` names the directory that actually holds the
#: plugins; when it is unset the per-user DSH plugin directory is used.
PLUGIN_ROOT = os.environ.get('MEMORA_DSH_PLUGIN_ROOT') or os.path.join(os.path.expanduser('~'), '.dsh', 'plugins')

#: `@deepseek-ai/dsh-llm` as vendored inside an installed plugin.
VENDORED_LLM = ('node_modules', '@deepseek-ai', 'dsh-llm', 'lib', 'index.js')

#: Plugins whose vendored `dsh-llm` is preferred, in order. `dsh-mnemon` leads because it is the
#: plugin this integration runs inside. The order is not cosmetic: every other plugin under
#: `PLUGIN_ROOT` vendors a copy too (seven do, spanning 0.2.0-rc.1 .. 0.2.1-rc.2), so without it
#: the winner would be decided by directory name and `dsh-blender-plugin` would beat
#: `dsh-mnemon`. Version skew is deliberately NOT the criterion -- the adapter takes exactly one
#: symbol from this module, `createUserMessage`, whose shape is identical in every copy here.
LLM_PLUGIN_ORDER = ('dsh-mnemon',)


def quote(value):
    """JSON-quote a path for the YAML dialect this profile uses (forward slashes)."""
    return json.dumps(str(value).replace('\\', '/'), ensure_ascii=False)


def product_root(dev):
    """The packaged, unzip-and-run application beside the development repository.

    This is the memory store the user actually runs, so the connector's backend must point
    here rather than at the development venv: two `--data` roots mean the agent and the UI are
    not looking at the same memories, which is the hardest misconfiguration to notice.
    """
    return Path(dev).resolve().parent / 'memora-desktop-standalone'


def llm_candidates(dsh, plugin_root=None):
    """Every path `llmModule` may legitimately take, best first.

    The first is the DSH source-tree layout, kept because that is still how a source-tree
    deployment is wired. The rest are copies vendored by installed plugins, enumerated in sorted
    order: an installer whose output depends on filesystem enumeration order cannot be diffed,
    and `--check` is a diff.

    `plugin_root` exists so the ORDER can be tested without this machine's disk. It defaults to
    `PLUGIN_ROOT`, which is what every real caller wants; a caller that supplies its own root is
    asserting something about ordering, and ordering is a property of this function rather than of
    whichever plugins happen to be installed here. Reading the module global directly also made
    the function untestable in principle: `mock.patch` on it would have changed what production
    code sees, not what the test asked about.
    """
    yield Path(dsh) / 'app/src/packages/llm/llm/lib/index.js'
    root = Path(PLUGIN_ROOT if plugin_root is None else plugin_root)
    if not root.is_dir():
        return
    preferred, rest = [], []
    for plugin in sorted(p for p in root.iterdir() if p.is_dir()):
        vendored = plugin.joinpath(*VENDORED_LLM)
        (preferred if plugin.name in LLM_PLUGIN_ORDER else rest).append(vendored)
    yield from preferred
    yield from rest


def llm_module(dsh, plugin_root=None):
    """The `dsh-llm` entry point the lifecycle adapter will `import()` -- or fail loudly.

    WHY THIS IS NOT A CONSTANT
    ---------------------------
    The renderer used to hard-code `<dsh>/app/src/packages/llm/llm/lib/index.js`, a path that only
    ever existed in the DSH source tree. Once the packaged desktop took over, that path was still
    rendered into the profile verbatim: valid YAML, valid string, dead target. The adapter's first
    statement is `import(pathToFileURL(config.llmModule))`, so it died there with
    ERR_MODULE_NOT_FOUND -- before a single `ctx.on()` was registered. That is why automatic
    recall, automatic capture and the peer heartbeat all went quiet together, and why the only
    symptom on screen was a settings toggle that refused to save.

    Deleting the key is not an alternative: `config.llmModule` goes straight into `pathToFileURL()`,
    so an absent or empty value raises TypeError [ERR_INVALID_ARG_TYPE] at the same line, with the
    same consequence. The line has to hold a path that exists.

    Probing therefore fixes the working case and raising fixes the broken one: rendering can no
    longer emit an `llmModule` the host would be unable to load.
    """
    root = Path(PLUGIN_ROOT if plugin_root is None else plugin_root)
    tried = []
    for candidate in llm_candidates(dsh, plugin_root=plugin_root):
        tried.append(candidate)
        if candidate.is_file():
            return candidate
    listing = '\n    '.join(str(p) for p in tried) or '(nothing to try)'
    # Name the root that was actually searched and how to redirect it: the previous message
    # blamed a missing plugin even when the real fault was a root that does not exist here.
    reachable = '' if root.is_dir() else (
        f'\n  The plugin root {root} does not exist on this machine.'
        '\n  Set MEMORA_DSH_PLUGIN_ROOT to the directory that holds the installed plugins.')
    raise SystemExit(
        'Cannot resolve @deepseek-ai/dsh-llm for the lifecycle adapter. Probed:\n    '
        + listing + reachable + '\n  Install a plugin that vendors it (dsh-mnemon does), or point '
        'dsh_profile.PLUGIN_ROOT (MEMORA_DSH_PLUGIN_ROOT) at the directory that holds it.')


def render_managed_block(dev, dsh, version, adapter_revision, adapter_path):
    """Render the managed block (MCP client + lifecycle adapter) for the current tree."""
    dev, dsh = Path(dev).resolve(), Path(dsh).resolve()
    venv_python = dev / '.venv/Scripts/python.exe'
    data = dev / 'data'
    tmp = dev / 'runtime/tmp'
    return f'''{BEGIN}
- insert:
    - id: memory-memora
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: memora
        transport: stdio
        command: {quote(venv_python)}
        args: ['-m', 'memora', '--data', {quote(data)}, 'mcp']
        cwd: {quote(dev)}
        env:
          PYTHONUTF8: '1'
          MEMORA_RUNTIME_VERSION: '{version}'
          TEMP: {quote(tmp)}
          TMP: {quote(tmp)}
        toolCallTimeoutMs: 180000
        failOnStartupError: false
    - id: memora-lifecycle
      name: {quote(adapter_path)}
      config:
        project: dsh
        adapterRevision: '{adapter_revision}'
        url: 'http://127.0.0.1:18184/mcp'
        tokenFile: {quote(data / 'mcp-token')}
        outbox: {quote(data / 'integrations/dsh-outbox')}
        llmModule: {quote(llm_module(dsh))}
        startScript: {quote(dev / 'start-memora.ps1')}
{END}
'''


def render_connector_block(dev, interval_ms=30000):
    """Render the `memory-connector` insert list: backend wiring + periodic heartbeat.

    `heartbeat.enabled: true` is what makes "connected" a state the host can keep claiming.
    memora records presence only when a peer calls `memory_peer_heartbeat` and expires the row
    after its ttl, so a connector that heartbeats once and never again is shown as expired five
    minutes later -- exactly the "1 个已过期" state this profile was in. The connector ships the
    timer disabled by default (an unconfigured host must not open background traffic against a
    memory store it may not own); this profile turns it on explicitly, so the choice is visible
    in the one file a person reads when asking "why is the agent not listed?".
    """
    dev = Path(dev).resolve()
    product = product_root(dev)
    tmp = product / 'data/.tmp'
    return f'''- id: {CONNECTOR_ID}
  # ID-TARGETED OVERRIDE, NOT AN INSERT. The package ships its own cordis.patch.yml
  # (`dsh.bundle.patch`) with an insert of this same id, and cordis's applyEntryPatches only
  # appends inserts -- it never de-duplicates by id. A second insert here therefore put the same
  # id in the composed tree twice, and which row the Loader created was decided by map order, so
  # the heartbeat could be dropped without any file saying so. Overriding by id keeps exactly one
  # row for this id in the whole profile.
  #
  # The `name` MUST equal the row being overridden (`memory-connector`, the package name); a
  # mismatch makes applyEntryPatches warn "name mismatch ... skipping" and the config silently
  # never applies.
  name: 'memory-connector'
  config:
    pluginRoot: '{PLUGIN_ROOT}'
    # memora 是已注册的后端模块名（lib/backends/index.js REGISTRY）；后端指向哪一份记忆
    # 由下面 backends.memora 决定，两者不要混。
    backend: memora
    backends:
      memora:
        # 独立可运行桌面程序自带的 backend：用户实际在用的那一份记忆库。
        # 用打包后的 exe 而不是开发目录的 venv——两者读写不同的 data/，
        # 混用会让智能体与界面看到的不是同一份记忆。
        command: {quote(product / 'resources/backend/memora-backend.exe')}
        args:
          - '--data'
          - {quote(product / 'data')}
          - 'mcp'
        label: memora (desktop-standalone)
        # 独立版工作台默认分区是 default，接入方必须一致，否则写入落在另一个分区。
        defaultProject: default
        env:
          PYTHONUTF8: '1'
          TEMP: {quote(tmp)}
          TMP: {quote(tmp)}
    localOnly: true
    timeoutMs: 60000
    bootTimeoutMs: 120000
    # 周期心跳：不开启时，连接器只在模型显式调用 memory_peer_heartbeat 的那一刻被记为在线，
    # ttl 到期后工作台就显示「已过期」。实现见 lib/backends/memora.js 的 heartbeat 段，
    # ALLOWED_TOOLS 闸门不变：心跳走的是同一个 memory_peer_heartbeat。
    heartbeat:
      enabled: true
      intervalMs: {interval_ms}
      project: default
      peer: dsh-memory-connector
      name: 'DSH Desktop (memory-connector)'
      model: 'deepseek-v4.1-flash'
      ttl: 90
      capabilities:
        automatic_recall: true
        automatic_capture: true
'''


def normalize(text):
    """Backslashes to slashes, so a stale Windows path cannot hide behind escaping."""
    return text.replace('\\\\', '/')


def stale_references(text):
    """Every (line number, line) of `text` that still names the pre-move root."""
    out = []
    for number, line in enumerate(normalize(text).splitlines(), 1):
        if STALE_ROOT in line:
            out.append((number, line.strip()))
    return out


def apply_managed_block(text, block):
    """Replace the managed block, or append it when the file has none yet."""
    if BEGIN in text:
        head, tail = text.split(BEGIN, 1)
        if END not in tail:
            raise SystemExit('Incomplete managed block; refusing to replace unrelated patches')
        _, rest = tail.split(END, 1)
        return head + block.rstrip() + rest
    return text.rstrip() + '\n\n' + block


def connector_span(text, entry_id):
    """Character span of the row that declares `entry_id`, or None.

    Two shapes are owned here, and both must be replaced rather than appended to:

      * `- insert:` followed by the row (`    - id: <entry_id>`), the old shape;
      * a top-level id-targeted override (`- id: <entry_id>`), the current shape.

    The end is the next top-level list item (a line starting with `- ` at column 0), so the span
    covers exactly this row and nothing else. Missing the override shape is not a cosmetic bug:
    the previous version could only find `- insert:`, so re-running the installer against the
    override shape appended a SECOND row for the same id -- recreating the very duplicate this
    module exists to prevent.
    """
    marker = f'- id: {entry_id}'
    index = text.find(marker)
    if index < 0:
        return None
    # An override starts at its own line; an insert list starts at the enclosing `- insert:`.
    line_start = text.rfind('\n', 0, index) + 1
    if text[line_start:index].strip() == '':
        start = line_start
    else:
        start = text.rfind('- insert:', 0, index)
        if start < 0:
            return None
    end = len(text)
    nxt = text.find('\n- ', index)
    if nxt >= 0:
        end = nxt + 1
    return start, end


def apply_connector_block(text, block):
    """Replace the `memory-connector` row in place; append it when absent."""
    span = connector_span(text, CONNECTOR_ID)
    if span is None:
        separator = '' if text.endswith('\n') else '\n'
        return text + separator + block
    start, end = span
    tail = block.rstrip() + '\n'
    return text[:start] + tail + text[end:]


def render_profile(text, dev, dsh, version, adapter_revision, adapter_path, interval_ms=30000):
    """Apply both owned blocks to `text`; the result is what the profile should contain."""
    staged = apply_managed_block(
        text, render_managed_block(dev, dsh, version, adapter_revision, adapter_path))
    return apply_connector_block(staged, render_connector_block(dev, interval_ms))


def parse_yaml(text):
    """Parse the patch through the DSH host's own js-yaml, when it is reachable.

    PyYAML is not a dependency here, and installing a parser just to check one file is worse
    than borrowing the parser the host actually uses at boot (it accepts the `!!js` scalars
    this profile dialect allows; a generic schema would reject them).
    Returns `(entry_count, None)` on success, `(None, reason)` when unavailable or invalid.
    """
    candidates = [
        Path(os.environ.get('MEMORA_DSH_ROOT') or os.path.join(os.path.expanduser('~'), '.dsh'),
         'app/src/vendor/cordis/node_modules/@deepseek-ai/'
             'cordis-plugin-include/node_modules/js-yaml'),
    ]
    candidates.append(Path(__file__).resolve().parents[1] / 'desktop/node_modules/js-yaml')
    module = next((c for c in candidates if c.is_dir()), None)
    if module is None:
        return None, 'js-yaml not found; YAML parse skipped'
    # `-r`, not `-e`: this is a CommonJS package, so the check must require() it rather than
    # evaluate it as an ES module (which fails with a bare-specifier error on some versions).
    program = (
        'const yaml=require(process.argv[1]);const fs=require("fs");'
        'const t=fs.readFileSync(0,"utf8");'
        'try{const d=yaml.load(t);'
        'if(!Array.isArray(d)){console.log(JSON.stringify({ok:false,error:"top-level is not an array"}))}'
        'else{console.log(JSON.stringify({ok:true,entries:JSON.parse(JSON.stringify(d))} ))}}'
        'catch(e){console.log(JSON.stringify({ok:false,error:e.message}))}'
    )
    try:
        result = subprocess.run(
            ['node', '-e', program, str(module)],
            input=text, capture_output=True, text=True, encoding='utf-8',
        )
    except OSError as error:
        return None, f'node unavailable: {error}'
    if result.returncode != 0:
        tail = (result.stderr or result.stdout or 'node failed').strip().splitlines()
        return None, tail[-1] if tail else 'node failed'
    payload = json.loads(result.stdout.strip().splitlines()[-1])
    if not payload.get('ok'):
        return None, payload.get('error', 'parse failed')
    return payload['entries'], None


def connector_row(entries):
    """The `memory-connector` row of a parsed patch list, or None.

    Both shapes count: an insert row (`- insert: [- id: memory-connector]`) and a top-level
    id-targeted override (`- id: memory-connector`). The override is the current shape; keeping
    the insert branch means an older profile still produces a readable heartbeat summary instead
    of a false "row is missing".
    """
    for entry in entries or []:
        if not isinstance(entry, dict):
            continue
        if entry.get('id') == CONNECTOR_ID and entry.get('insert') is None:
            return entry
        for row in entry.get('insert') or []:
            if isinstance(row, dict) and row.get('id') == CONNECTOR_ID:
                return row
    return None


def heartbeat_summary(entries):
    """What the installed connector block says about the periodic heartbeat.

    Returned as data (not just printed) so `--check` can fail on it: "the heartbeat is
    configured" is a claim this project makes to the user, and a claim that nothing verifies is
    how the previous version ended up with a connector that never heartbeat at all.
    """
    row = connector_row(entries)
    if row is None:
        return {'found': False, 'ok': False, 'problem': 'no memory-connector insert row'}
    heartbeat = (row.get('config') or {}).get('heartbeat') or {}
    interval = heartbeat.get('intervalMs')
    ttl = heartbeat.get('ttl', 90)
    backend = ((row.get('config') or {}).get('backends') or {}).get('memora') or {}
    problems = []
    if heartbeat.get('enabled') is not True:
        problems.append('heartbeat.enabled is not true')
    if not isinstance(interval, int) or interval <= 0:
        problems.append(f'heartbeat.intervalMs must be a positive integer, got {interval!r}')
    elif isinstance(ttl, int) and ttl * 1000 <= interval:
        problems.append(f'heartbeat.ttl ({ttl}s) must exceed intervalMs ({interval}ms)')
    if not heartbeat.get('peer'):
        problems.append('heartbeat.peer missing (the peer id must be stable)')
    if not heartbeat.get('project'):
        problems.append('heartbeat.project missing')
    return {
        'found': True,
        'ok': not problems,
        'enabled': heartbeat.get('enabled'),
        'interval_ms': interval,
        'ttl_s': ttl,
        'peer': heartbeat.get('peer'),
        'project': heartbeat.get('project'),
        'name': heartbeat.get('name'),
        'backend_command': backend.get('command'),
        'backend_data': (backend.get('args') or [None, None])[1],
        'problems': problems,
    }


def backup(target, dev, profile_name):
    """Copy the profile patch into the repo's integration-backup folder and beside itself."""
    stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
    repo_backup = Path(dev) / 'artifacts/integration-backups' / f'{profile_name}-{stamp}.patch.yml'
    repo_backup.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(target, repo_backup)
    beside = target.with_name(target.name + f'.bak-{stamp}')
    shutil.copyfile(target, beside)
    return repo_backup, beside
