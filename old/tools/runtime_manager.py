"""Run the Windows memory host and keep its Rocky model services alive.

Only processes recorded by this manager are stopped. Model services never shut
down the WSL distribution or other users' inference workloads.
"""
import argparse
import hashlib
import json
import os
import signal
import subprocess
import sys
import sys as _sys
import time
import urllib.request
from pathlib import Path as _Path
from urllib.parse import urlsplit

if str(_Path(__file__).resolve().parent) not in _sys.path: _sys.path.insert(0, str(_Path(__file__).resolve().parent))
from paths import DATA, VENV_PYTHON
from paths import DEV as ROOT
from paths import RUNTIME as STATE

if str(ROOT) not in sys.path: sys.path.insert(0, str(ROOT))


def source_revision(root=ROOT):
    """Content identity prevents reusing old source code under the same development version."""
    package = root / 'memora'
    digest = hashlib.sha256()
    for path in sorted(package.glob('*.py')):
        digest.update(path.name.encode()); digest.update(b'\0'); digest.update(path.read_bytes())
    return digest.hexdigest()


def reusable(old, status, revision, version, port=None):
    return bool(status and status.get('name') == 'memora' and status.get('version') == version
        and status.get('data_dir') == str(DATA) and old.get('data') == str(DATA)
        and old.get('source_revision') == revision
        and (port is None or urlsplit(old.get('url', '')).port == port))


def is_alive(pid):
    if os.name == 'nt':
        import ctypes
        handle = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)
        if not handle: return False
        try:
            code = ctypes.c_ulong()
            return bool(ctypes.windll.kernel32.GetExitCodeProcess(handle, ctypes.byref(code))) and code.value == 259
        finally: ctypes.windll.kernel32.CloseHandle(handle)
    try: os.kill(pid, 0); return True
    except OSError: return False


def get(url, timeout=2):
    with urllib.request.urlopen(url, timeout=timeout) as response: return json.load(response)


def spawn(args, stdout, stderr, env=None):
    flags = (subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP) if os.name == 'nt' else 0
    with stdout.open('ab') as out, stderr.open('ab') as err:
        return subprocess.Popen(args, cwd=ROOT, env=env, stdin=subprocess.DEVNULL, stdout=out, stderr=err, creationflags=flags, close_fds=True)


def stop_host(old, status):
    if status.get('name') != 'memora' or status.get('data_dir') != str(DATA):
        raise SystemExit('Refusing to stop a different memory runtime')
    if os.name == 'nt':
        from urllib.parse import urlsplit
        port = urlsplit(old['url']).port
        subprocess.run(['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', str(ROOT / 'tools/Stop-Host.ps1'),
                        '-Port', str(port), '-Data', str(DATA)], check=True)
    else: os.kill(old['pid'], signal.SIGTERM)


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    from memora import __version__
    revision = source_revision()
    p = argparse.ArgumentParser(); p.add_argument('action', choices=['start', 'stop', 'status'])
    p.add_argument('--port', type=int, default=8765); p.add_argument('--no-models', action='store_true'); args = p.parse_args()
    STATE.mkdir(exist_ok=True); (STATE / 'tmp').mkdir(exist_ok=True); record = STATE / 'active.json'
    old = json.loads(record.read_text('utf-8-sig')) if record.exists() else {}
    running = None
    if old:
        try: running = get(old['url'] + '/api/agent/status')
        except Exception: pass
    if args.action == 'status':
        print(json.dumps({'running': running is not None, 'runtime': old, 'status': running}, ensure_ascii=False, indent=2)); return
    if args.action == 'stop':
        if running and old.get('data') == str(DATA):
            stop_host(old, running)
        print('Stopped the managed memora host.'); return
    if reusable(old, running, revision, __version__, args.port):
        print(json.dumps(old, indent=2)); return
    if running and old.get('data') == str(DATA):
        stop_host(old, running); time.sleep(1)
    env = dict(os.environ, PYTHONUTF8='1', TEMP=str(STATE / 'tmp'), TMP=str(STATE / 'tmp'))
    keepalive = old.get('wsl_keepalive_pid')
    if not args.no_models:
        # systemd services alone do not keep a WSL VM alive. Own one explicit
        # long-lived wsl.exe connection instead of relying on an open terminal.
        alive = False
        if keepalive:
            alive = is_alive(keepalive)
        if not alive:
            subprocess.run(['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', str(ROOT / 'deployment/Start-Models.ps1')], check=True)
            keepalive = int((STATE / 'wsl-host.pid').read_text('ascii').strip())
    child = spawn([str(VENV_PYTHON), '-m', 'memora', '--data', str(DATA), 'serve', '--port', str(args.port), '--mcp-port', '18184'],
                  STATE / 'host.out.log', STATE / 'host.err.log', env)
    url = f'http://127.0.0.1:{args.port}'
    for _ in range(80):
        if child.poll() is not None: raise SystemExit('Memora host exited; inspect runtime/host.err.log')
        try:
            status = get(url + '/api/agent/status')
            if status.get('version') == __version__: break
        except Exception: pass
        time.sleep(.25)
    else: child.terminate(); raise SystemExit('Memora startup timed out')
    state = {'version': __version__, 'source_revision': revision, 'pid': child.pid, 'url': url, 'mcp_url': 'http://127.0.0.1:18184/mcp',
             'data': str(DATA), 'wsl_keepalive_pid': keepalive}
    temporary = record.with_suffix('.tmp'); temporary.write_text(json.dumps(state, indent=2), 'utf-8'); os.replace(temporary, record)
    print(json.dumps(state, indent=2))


if __name__ == '__main__': main()
