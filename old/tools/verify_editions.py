"""Prove the two editions are separate processes, with separate ports and separate data.

Run from anywhere:

    .venv\\Scripts\\python.exe tools\\verify_editions.py
    .venv\\Scripts\\python.exe tools\\verify_editions.py --json reports/p5-editions.json

WHAT IS ASSERTED, AND WHY IT IS ASSERTED BY RUNNING THINGS
---------------------------------------------------------
The edition label is only worth anything if it is decided by the process that is actually running.
Reading the source and reporting "it will say standalone when frozen" would be a claim; starting the
frozen backend and asking it over HTTP is evidence. Both are started here:

  devel       .venv/Scripts/python.exe -m memora --data <temp> serve --port 0
  standalone  <product>/resources/backend/memora-backend.exe --data <temp> serve --port 0

--port 0 asks the OS for a free port, so the run never collides with a session that is already
running (the author is usually typing in a dev session while this runs). What it proves is that the
two editions can be up AT THE SAME TIME, each on its own port, and that the CONVENTION ports are the
ones tools/paths.py declares - 8765 for development, 18765 for the packaged app, 18184 for the
development MCP HTTP gateway. The convention itself is never re-bound: a fixed port is only allowed
to be observed, and a run that finds it busy reports that as a WARning with the owning PID rather
than killing somebody else's process.

DEVELOPMENT DATA IS NEVER TOUCHED. Each edition gets a fresh temporary directory, and the packaged
app's data/memora.json (model endpoints and saved keys) is copied into the standalone temp store so
the frozen build starts with the same configuration a user would see. Nothing is written to
D:/.../memora-desktop-standalone/data.

WHAT IS *NOT* PROVEN HERE
-------------------------
This is a BACKEND check. It says nothing about what the page renders; tools/verify_edition_ui.cjs
drives Electron and reads the DOM for that, precisely so a hardcoded label cannot pass both.
"""
import argparse
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from contextlib import ExitStack
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent                       # the development repository
PRODUCT = ROOT.parent / 'memora-desktop-standalone'
EXE = PRODUCT / 'resources/backend/memora-backend.exe'
STANDALONE_DATA_SETTINGS = PRODUCT / 'data/memora.json'
sys.path.insert(0, str(HERE))
from paths import DEV_MCP_PORT, DEV_PORT, PRODUCT_PORT  # noqa: E402  the single port convention

START_TIMEOUT = 60.0     # a frozen backend unpacks _internal on first launch; 60s is generous


def free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def listening(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.25)
        return s.connect_ex(('127.0.0.1', port)) == 0


def port_owner(port):
    """The PID listening on a port, or None. Read-only: never stops anything."""
    if sys.platform != 'win32': return None
    try:
        out = subprocess.run(['netstat', '-ano', '-p', 'TCP'], capture_output=True, text=True, timeout=15)
    except (OSError, subprocess.SubprocessError):
        return None
    for line in out.stdout.splitlines():
        parts = line.split()
        if len(parts) >= 5 and parts[1].endswith(':' + str(port)) and parts[3] == 'LISTENING':
            try: return int(parts[4])
            except ValueError: return None
    return None


class Backend:
    """One edition, started on a port the OS chose, asked for /api/agent/status, then stopped."""

    def __init__(self, edition, command, cwd, data_dir):
        self.edition, self.command, self.cwd, self.data_dir = edition, command, cwd, data_dir
        self.proc = None
        self.port = None
        self.pid = None
        self.url = None
        self.status = None
        self.started_at = None

    def __enter__(self):
        self.started_at = time.time()
        # PYTHONUTF8/PYTHONIOENCODING only affect the SOURCE backend (the frozen one ignores them,
        # which is the behaviour being measured); setting them keeps a Chinese label from turning
        # into question marks when this script is run from a console with a legacy code page.
        env = dict(os.environ, PYTHONUTF8='1', PYTHONIOENCODING='utf-8')
        self.proc = subprocess.Popen(self.command, cwd=str(self.cwd), stdin=subprocess.DEVNULL,
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                     encoding='utf-8', errors='replace', bufsize=1, env=env)
        self.pid = self.proc.pid
        # The server prints its URL once the socket is bound; reading that line is both the
        # readiness signal and the port report. --port 0 means the URL is the only place the
        # chosen port is ever printed.
        deadline = time.time() + START_TIMEOUT
        while time.time() < deadline:
            line = self.proc.stdout.readline()
            if not line:
                if self.proc.poll() is not None:
                    err = (self.proc.stderr.read() or '')[-2000:]
                    raise RuntimeError('%s backend exited before serving (%s): %s'
                                       % (self.edition, self.proc.returncode, err))
                continue
            line = line.strip()
            if line.startswith('Memora: http://'):
                self.url = line.split('Memora:', 1)[1].strip()
                self.port = int(self.url.rsplit(':', 1)[1])
                break
        if not self.url: raise RuntimeError('%s backend printed no URL within %ss' % (self.edition, START_TIMEOUT))
        return self

    def get(self, path):
        with urllib.request.urlopen(self.url + path, timeout=10) as r:
            return json.loads(r.read().decode('utf-8'))

    def __exit__(self, *exc):
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try: self.proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.proc.kill(); self.proc.wait(timeout=10)
        for stream in (self.proc.stdout, self.proc.stderr) if self.proc else ():
            try: stream.close()
            except OSError: pass
        return False

    def report(self):
        s = self.status or {}
        return {'edition': self.edition, 'expected_edition': self.edition, 'reported_edition': s.get('edition'),
                'edition_label': s.get('edition_label'), 'version': s.get('version'), 'name': s.get('name'),
                'data_dir': s.get('data_dir'), 'port': self.port, 'pid': self.pid, 'url': self.url,
                'command': ' '.join(self.command)}


# The packaged executable on this machine may predate the edition field. When it does, the run
# still has to answer "does the code path a frozen build takes actually report standalone?", so the
# same source is executed in a child process with sys.frozen set to exactly what the PyInstaller
# bootloader sets. This is SIMULATED, and labelled as such: it proves the branch, not the artifact.
FROZEN_PROBE = """
import json, sys, tempfile
sys.frozen = True
from memora.core import MemoryRuntime
root = tempfile.mkdtemp(prefix='p5-frozen-')
runtime = MemoryRuntime(root, env={})
status = runtime.status()
runtime.close()
print(json.dumps({'edition': status.get('edition'), 'label': status.get('edition_label'),
                  'version': status.get('version'), 'frozen': bool(getattr(sys, 'frozen', False))}))
"""


def simulated_frozen_status(python, cwd):
    """status() from a child process that has sys.frozen set, i.e. the branch a packaged build takes."""
    out = subprocess.run([str(python), '-c', FROZEN_PROBE], cwd=str(cwd), capture_output=True,
                         text=True, encoding='utf-8', errors='replace', timeout=120)
    if out.returncode != 0:
        return {'error': (out.stderr or '')[-500:]}
    try: return json.loads(out.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError): return {'error': 'unparseable probe output: %r' % out.stdout[-300:]}


def prepare_standalone_data():
    """A temp data directory carrying ONLY the packaged app's saved settings (never its memories)."""
    data = Path(tempfile.mkdtemp(prefix='p5-standalone-'))
    if STANDALONE_DATA_SETTINGS.is_file():
        shutil.copyfile(STANDALONE_DATA_SETTINGS, data / 'memora.json')
        return data, 'memora.json copied from %s' % STANDALONE_DATA_SETTINGS
    return data, 'no packaged memora.json to copy; starting with defaults'


def main(argv=None):
    global START_TIMEOUT
    # The console on this host is cp936 by default; a Chinese edition_label would print as mojibake
    # while the JSON report stays correct. Reconfigure once rather than pretending it is a data bug.
    for stream in (sys.stdout, sys.stderr):
        try: stream.reconfigure(encoding='utf-8', errors='replace')
        except (AttributeError, ValueError): pass
    ap = argparse.ArgumentParser(description='Prove devel and standalone are separate processes, ports and data.')
    ap.add_argument('--json', help='Also write the full report to this path')
    ap.add_argument('--timeout', type=float, default=START_TIMEOUT)
    args = ap.parse_args(argv)
    START_TIMEOUT = args.timeout
    checks, failures, warnings = [], [], []

    def check(name, ok, detail):
        (checks if ok else failures).append({'check': name, 'ok': bool(ok), 'detail': detail})
        return ok

    python = ROOT / '.venv/Scripts/python.exe'
    python_cmd = [str(python), '-m', 'memora'] if python.is_file() else [sys.executable, '-m', 'memora']

    print('== editions ==')
    print('development tree : %s' % ROOT)
    print('packaged product : %s' % PRODUCT)
    print('convention ports : dev=%s  dev_mcp=%s  standalone=%s' % (DEV_PORT, DEV_MCP_PORT, PRODUCT_PORT))

    stand = None
    with ExitStack() as stack:
        dev_data = Path(stack.enter_context(tempfile.TemporaryDirectory(prefix='p5-devel-')))
        stand_data, stand_note = prepare_standalone_data()
        stack.callback(shutil.rmtree, stand_data, True)

        if not EXE.is_file():
            check('packaged backend exists', False, '%s is missing; run tools/build_desktop.py' % EXE)
            # Still verify development, so a machine without a build gets a useful partial result.
            dev = stack.enter_context(Backend('devel', [*python_cmd, '--data', str(dev_data), 'serve', '--port', '0'],
                                              ROOT, dev_data))
            dev.status = dev.get('/api/agent/status')
            print(json.dumps(dev.report(), ensure_ascii=False, indent=2))
        else:
            # BOTH RUN AT ONCE: starting the second only after the first is up is the actual
            # claim being made (they are independent applications, not one process in two modes).
            dev = stack.enter_context(Backend('devel', [*python_cmd, '--data', str(dev_data), 'serve', '--port', '0'],
                                              ROOT, dev_data))
            stand = stack.enter_context(Backend('standalone', [str(EXE), '--data', str(stand_data), 'serve', '--port', '0'],
                                                EXE.parent, stand_data))
            dev.status = dev.get('/api/agent/status')
            stand.status = stand.get('/api/agent/status')
            print('standalone data: %s' % stand_note)
            for b in (dev, stand): print(json.dumps(b.report(), ensure_ascii=False, indent=2))

            check('devel reports edition=devel', dev.status.get('edition') == 'devel',
                  'GET %s/api/agent/status -> edition=%r' % (dev.url, dev.status.get('edition')))
            check('standalone reports edition=standalone', stand.status.get('edition') == 'standalone',
                  'GET %s/api/agent/status -> edition=%r %s'
                  % (stand.url, stand.status.get('edition'),
                     '' if stand.status.get('edition') == 'standalone'
                     else '(the frozen backend at %s predates the field: rebuild with tools/build_desktop.py)' % EXE))
            # Independent of the (possibly stale) artifact: does the frozen branch of the code the
            # packaged build runs actually return standalone? Labelled simulated so its PASS can
            # never be mistaken for "the shipped exe is current".
            simulated = simulated_frozen_status(python if python.is_file() else sys.executable, ROOT)
            print('simulated frozen process (sys.frozen=True, source tree): %s'
                  % json.dumps({k: simulated.get(k) for k in ('edition', 'label', 'version')}, ensure_ascii=False))
            check('the code path a frozen build takes reports standalone (SIMULATED sys.frozen, not the shipped exe)',
                  simulated.get('edition') == 'standalone',
                  'child process with sys.frozen=True reported edition=%r %s'
                  % (simulated.get('edition'), simulated.get('error', '')))
            check('both editions run at the same time', listening(dev.port) and listening(stand.port),
                  'devel port %s and standalone port %s both accepting connections' % (dev.port, stand.port))
            check('the two processes have different PIDs', dev.pid != stand.pid, 'devel pid %s vs standalone pid %s' % (dev.pid, stand.pid))
            check('the two ports differ', dev.port != stand.port, 'devel %s vs standalone %s' % (dev.port, stand.port))
            check('each edition reports its own data directory',
                  Path(dev.status.get('data_dir', '')).resolve() != Path(stand.status.get('data_dir', '')).resolve(),
                  'devel %r vs standalone %r' % (dev.status.get('data_dir'), stand.status.get('data_dir')))
            check('both editions agree on the version',
                  dev.status.get('version') is not None and dev.status.get('version') == stand.status.get('version'),
                  'devel %r vs standalone %r' % (dev.status.get('version'), stand.status.get('version')))
            check('each edition labels itself for the banner',
                  bool(dev.status.get('edition_label')) and bool(stand.status.get('edition_label')),
                  'devel %r vs standalone %r' % (dev.status.get('edition_label'), stand.status.get('edition_label')))

            # The convention ports are OBSERVED, never bound. Something already listening there is
            # a fact about the machine (the user is probably running that copy), not a failure of
            # this check - but it is reported with the owning PID so nothing is guessed.
            for label, port in (('dev', DEV_PORT), ('dev_mcp', DEV_MCP_PORT), ('standalone', PRODUCT_PORT)):
                pid = port_owner(port)
                state = 'listening pid=%s' % pid if pid else 'free'
                print('convention port %-10s %-6s %s' % (label, port, state))
                if pid and port == PRODUCT_PORT:
                    warnings.append('the convention standalone port %s is already bound by pid %s; this run used '
                                    'the OS-assigned ports above instead and did not touch that process' % (port, pid))
            # The convention is only useful if the defaults in the CODE are the documented numbers.
            # These three read the declarations rather than repeating them, so a drift between
            # tools/paths.py and the CLI / the Electron shell shows up here instead of in a report.
            try:
                from memora.__main__ import parser as cli_parser
                cli_default = cli_parser().parse_args(['serve']).port
            except Exception as exc:                       # noqa: BLE001 - report, never crash the run
                cli_default = 'unreadable: %s' % exc
            check('the CLI serve default port is tools/paths.py DEV_PORT',
                  cli_default == DEV_PORT, 'memora --data X serve (no --port) would bind %r, paths.DEV_PORT=%r'
                  % (cli_default, DEV_PORT))
            shell = (ROOT / 'desktop/main.cjs').read_text('utf-8')
            shell_defaults = [line.strip() for line in shell.splitlines() if str(PRODUCT_PORT) in line]
            check('the desktop shell default port is tools/paths.py PRODUCT_PORT',
                  bool(shell_defaults),
                  'desktop/main.cjs: %s' % (shell_defaults[0][:120] if shell_defaults else
                                             'no reference to %d at all' % PRODUCT_PORT))
            runner = (ROOT / 'tools/runtime_manager.py').read_text('utf-8')
            runner_lines = [line.strip() for line in runner.splitlines() if str(DEV_MCP_PORT) in line]
            check('the development MCP HTTP port matches tools/paths.py DEV_MCP_PORT',
                  bool(runner_lines),
                  'tools/runtime_manager.py: %s' % (runner_lines[0][:120] if runner_lines else
                                                    'no reference to %d at all' % DEV_MCP_PORT))

            check('convention ports are distinct',
                  len({DEV_PORT, DEV_MCP_PORT, PRODUCT_PORT}) == 3,
                  'dev=%s dev_mcp=%s standalone=%s' % (DEV_PORT, DEV_MCP_PORT, PRODUCT_PORT))
            check('neither edition took a convention port during this run',
                  {dev.port, stand.port}.isdisjoint({DEV_PORT, DEV_MCP_PORT, PRODUCT_PORT}),
                  'devel=%s and standalone=%s are OS-assigned; the fixed ports stay reserved for the '
                  'sessions that actually own them' % (dev.port, stand.port))
            manifest_path = EXE.parent / 'BUILD_MANIFEST.json'
            if manifest_path.is_file():
                manifest_version = json.loads(manifest_path.read_text('utf-8')).get('version')
                check('the shipped BUILD_MANIFEST.json agrees with the running backend',
                      manifest_version == stand.status.get('version'),
                      'BUILD_MANIFEST.json version=%r vs the frozen backend reports %r'
                      % (manifest_version, stand.status.get('version')))
            else:
                warnings.append('%s has no BUILD_MANIFEST.json; the version agreement between the '
                                'manifest and memora/__init__.py is asserted by tests/test_editions.py '
                                'for the build at dist/memora-backend' % EXE.parent)

        if stand is None:
            # Partial run (no packaged build on this machine): still report the development half
            # honestly rather than turning a missing artifact into a green tick.
            check('devel reports edition=devel', dev.status.get('edition') == 'devel',
                  'GET %s/api/agent/status -> edition=%r' % (dev.url, dev.status.get('edition')))
            simulated = simulated_frozen_status(python if python.is_file() else sys.executable, ROOT)
            check('the code path a frozen build takes reports standalone (SIMULATED sys.frozen, not the shipped exe)',
                  simulated.get('edition') == 'standalone',
                  'child process with sys.frozen=True reported edition=%r %s'
                  % (simulated.get('edition'), simulated.get('error', '')))

    print()
    for c in checks: print('PASS %s%s' % (c['check'], ('  [' + c['detail'] + ']') if c['detail'] else ''))
    for f in failures: print('FAIL %s  [%s]' % (f['check'], f['detail']))
    for w in warnings: print('WARN %s' % w)
    report = {'generated_at': time.strftime('%Y-%m-%dT%H:%M:%S'), 'root': str(ROOT), 'product': str(PRODUCT),
              'convention_ports': {'dev': DEV_PORT, 'dev_mcp': DEV_MCP_PORT, 'standalone': PRODUCT_PORT},
              'checks': checks, 'failures': failures, 'warnings': warnings}
    if args.json:
        target = Path(args.json) if Path(args.json).is_absolute() else ROOT / args.json
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(report, ensure_ascii=False, indent=2), 'utf-8')
        print('\nreport: %s' % target)
    print('\n%d passed, %d failed, %d warning(s)' % (len(checks), len(failures), len(warnings)))
    return 0 if not failures else 1


if __name__ == '__main__':
    raise SystemExit(main())
