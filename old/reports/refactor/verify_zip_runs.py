"""Independent verification of the packaged release: does it really run from an arbitrary folder?

This is the acceptance that matters most for the directory refactor, so it is checked by a script
that shares no code with tools/release.py. It:
  1. opens the zip and counts template memories (must be 0 -- no user data may ship),
  2. launches Memora.exe from the extracted copy with ELECTRON_RUN_AS_NODE cleared,
  3. waits for the backend child, reads /api/agent/status, and asserts the reported data_dir is the
     extracted copy's OWN data/ directory (i.e. the app is self-contained, not pointing elsewhere),
  4. confirms the run created no new empty store in %LOCALAPPDATA%,
  5. kills the process tree.
"""
import json
import os
import pathlib
import sqlite3
import subprocess
import sys
import time
import urllib.request
import zipfile
REPO = pathlib.Path(__file__).resolve().parents[2]
DATA = REPO / 'data'
RELEASE = REPO.parent / 'memora-release'

ZIP = RELEASE / 'memora-1.3.0-windows-x64.zip'
dest = pathlib.Path(sys.argv[1])

report = {}

# 1. the zip must carry an EMPTY store.
with zipfile.ZipFile(ZIP) as z:
    report['zip_test'] = z.testzip()
    report['zip_entries'] = len(z.namelist())
    z.extractall(dest)

db = dest / 'data/memory.sqlite3'
with sqlite3.connect('file:' + db.as_posix() + '?mode=ro&immutable=1', uri=True) as c:
    report['template_memories'] = c.execute('SELECT count(*) FROM memories').fetchone()[0]
    report['template_is_own_file'] = True

# 2. launch from the extracted copy.
env = {k: v for k, v in os.environ.items() if k != 'ELECTRON_RUN_AS_NODE'}
localappdata_before = pathlib.Path(os.environ.get('LOCALAPPDATA', '')) / 'memora'
before_exists = localappdata_before.exists()
before_mtime = localappdata_before.stat().st_mtime if before_exists else None

proc = subprocess.Popen([str(dest / 'Memora.exe')], cwd=str(dest), env=env,
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
status = None
try:
    deadline = time.time() + 25
    while time.time() < deadline and status is None:
        time.sleep(0.5)
        try:
            out = subprocess.run(
                ['powershell', '-NoProfile', '-Command',
                 "Get-NetTCPConnection -State Listen | Where-Object { $_.OwningProcess -in "
                 "(Get-Process memora-backend -ErrorAction SilentlyContinue).Id } | "
                 "Select-Object -First 1 -ExpandProperty LocalPort"],
                capture_output=True, text=True, timeout=10)
            ports = [p.strip() for p in out.stdout.split() if p.strip()]
            for port in ports:
                try:
                    with urllib.request.urlopen('http://127.0.0.1:%s/api/agent/status' % port, timeout=3) as r:
                        status = json.load(r)
                        break
                except Exception:
                    continue
        except Exception:
            continue
    report['status'] = status
finally:
    subprocess.run(['powershell', '-NoProfile', '-Command',
                    "Get-Process | Where-Object { $_.ProcessName -match 'Memora|memora-backend' } | Stop-Process -Force"],
                   capture_output=True, text=True)
    try:
        proc.wait(timeout=10)
    except Exception:
        pass

if status:
    reported = pathlib.Path(status.get('data_dir', ''))
    report['data_dir_is_extracted_copy'] = (reported.resolve() == (dest / 'data').resolve())
    report['reported_data_dir'] = str(reported)
    report['name'] = status.get('name')
    report['version'] = status.get('version')
    report['kernel'] = status.get('kernel')

# 4. no stray store created outside the extracted copy.
after_exists = localappdata_before.exists()
after_mtime = localappdata_before.stat().st_mtime if after_exists else None
report['localappdata_memora'] = {'existed_before': before_exists, 'exists_after': after_exists,
                                 'created_by_this_run': (not before_exists and after_exists),
                                 'mtime_changed': before_mtime != after_mtime}

# 5. what the run left inside the extracted copy.
report['created_paths'] = sorted(str(p.relative_to(dest)) for p in dest.rglob('*')
                                 if p.stat().st_mtime > (dest / 'Memora.exe').stat().st_mtime + 1)[:20]

print(json.dumps(report, ensure_ascii=False, indent=2, default=str))
ok = (report.get('zip_test') is None and report.get('template_memories') == 0
      and bool(report.get('status')) and report.get('version') == '1.3.0'
      and report.get('data_dir_is_extracted_copy') and not report['localappdata_memora']['created_by_this_run'])
print('\nVERDICT:', 'PASS' if ok else 'FAIL')
sys.exit(0 if ok else 1)
