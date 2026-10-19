"""Independent acceptance check for the directory refactor.

Deliberately does not import the project's own tooling for the claims that matter most (product
layout, data integrity, release contents); it re-derives them from the filesystem and the zip.
Every line prints PASS/FAIL with the measured value, so the report can be read without trusting
any prose in this repository.
"""
import hashlib
import json
import os
import pathlib
import sqlite3
import sys
import zipfile

ROOT = REPO
results = []


def check(name, ok, detail=''):
    results.append((name, bool(ok), detail))
    print('%-4s %-52s %s' % ('PASS' if ok else 'FAIL', name, detail))


# ---------------------------------------------------------------- 1. six top-level directories
entries = sorted(p.name for p in ROOT.iterdir() if p.is_dir() and p.name != '.git')
check('six top-level directories, exact set', entries == ['.venv', 'build', 'data', 'desktop-standalone', 'devel', 'release'], ','.join(entries))

# ---------------------------------------------------------------- 2. product is directly runnable
product = ROOT / 'desktop-standalone'
check('product root has Memora.exe', (product / 'Memora.exe').is_file(), str((product / 'Memora.exe').stat().st_size) + ' bytes')
check('product root has resources/app.asar', (product / 'resources/app.asar').is_file())
check('product root has resources/backend/memora-backend.exe', (product / 'resources/backend/memora-backend.exe').is_file())
check('product ships its own data template', (product / 'data/memory.sqlite3').is_file() and (product / 'data/markdown').is_dir())
for dead in ('win-unpacked', 'release-win-unpacked', 'memora-data', 'desktop'):
    check('no duplicate/nested product dir: ' + dead, not (product / dead).exists())
check('no packer debug droppings in product', not list(product.glob('builder-*')))

# ---------------------------------------------------------------- 3. the built tree matches its own smoke report
report = json.loads((ROOT / 'build/reports/SMOKE_VALIDATION.json').read_text('utf-8'))
digest = hashlib.sha256()
files = 0
for f in sorted(product.rglob('*'), key=lambda p: p.relative_to(product).as_posix()):
    if not f.is_file():
        continue
    files += 1
    h = hashlib.sha256()
    with f.open('rb') as s:
        for block in iter(lambda: s.read(1024 * 1024), b''):
            h.update(block)
    digest.update(f.relative_to(product).as_posix().encode() + b'\0' + h.digest())
check('product tree hash == smoke report', digest.hexdigest() == report['artifact_tree_sha256'], digest.hexdigest()[:16] + ' / ' + str(files) + ' files')
backend_sha = hashlib.sha256((product / 'resources/backend/memora-backend.exe').read_bytes()).hexdigest()
check('backend sha256 == smoke report', backend_sha == report['backend_sha256'], backend_sha[:16])
check('smoke report says passed', report.get('passed') is True, 'version ' + str(report.get('version')))
check('smoke report: desktop launches', report.get('desktop_default_exit_code') == 0 and report.get('desktop_ready') is True)

# ---------------------------------------------------------------- 4. live data untouched
db = ROOT / 'data/memory.sqlite3'
with sqlite3.connect('file:' + db.as_posix() + '?mode=ro&immutable=1', uri=True) as c:
    memories = c.execute('SELECT count(*) FROM memories').fetchone()[0]
    documents = c.execute('SELECT count(*) FROM documents').fetchone()[0]
    integrity = c.execute('PRAGMA integrity_check').fetchone()[0]
markdown = len([p for p in (ROOT / 'data/markdown').iterdir() if p.is_file()])
check('live database integrity', integrity == 'ok', integrity)
check('live memories preserved', memories == 914, str(memories))
check('live documents preserved', documents == 51, str(documents))
check('live markdown mirrors preserved', markdown == 914, str(markdown))
check('memory backups live under data/', (ROOT / 'data/backups').is_dir(), ','.join(p.name for p in (ROOT / 'data/backups').iterdir()))

# ---------------------------------------------------------------- 5. release package
zips = sorted((ROOT / 'release').glob('memora-1.3.0-windows-x64.zip*'))
check('release zip + sha256 exist', len(zips) == 2, ','.join(p.name for p in zips))
zpath = ROOT / 'release/memora-1.3.0-windows-x64.zip'
sha_file = (ROOT / 'release/memora-1.3.0-windows-x64.zip.sha256').read_text('utf-8').split()[0]
actual = hashlib.sha256(zpath.read_bytes()).hexdigest()
check('release zip sha256 matches sidecar', actual == sha_file, actual[:16])
with zipfile.ZipFile(zpath) as z:
    names = set(z.namelist())
    check('release zip integrity', z.testzip() is None, str(len(names)) + ' entries')
    for required in ('Memora.exe', 'resources/app.asar', 'resources/backend/memora-backend.exe',
                     'data/memory.sqlite3', 'data/memora.json', 'data/markdown/.gitkeep',
                     'Launch-Memora.cmd', 'Launch-Memora.ps1', 'Repair-Desktop.ps1'):
        check('zip contains ' + required, required in names)
    import tempfile
    tmp = tempfile.mkdtemp(prefix='memora-acceptance-')
    try:
        z.extract('data/memory.sqlite3', tmp)
        tdb = pathlib.Path(tmp) / 'data/memory.sqlite3'
        conn = sqlite3.connect('file:' + tdb.as_posix() + '?mode=ro&immutable=1', uri=True)
        try:
            shipped = conn.execute('SELECT count(*) FROM memories').fetchone()[0]
        finally:
            # Windows refuses to unlink a file that still has an open handle, so close before the
            # temporary directory is removed. A leaked handle here is the script's bug, not the
            # product's.
            conn.close()
        check('zip ships NO user memories', shipped == 0, str(shipped))
    finally:
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)

historical = sorted(p.name for p in (ROOT / 'release').glob('memora-1.[012].*-windows-x64.zip'))
check('historical packages retained', len(historical) == 5, ','.join(historical))

# ---------------------------------------------------------------- 6. source tree is coherent
devel = ROOT / 'devel'
check('source lives under devel/', (devel / 'memora/core.py').is_file() and (devel / 'pyproject.toml').is_file())
check('electron shell source under devel/desktop', (devel / 'desktop/main.cjs').is_file() and (devel / 'desktop/package.json').is_file())
check('no source left at project root', not (ROOT / 'memora').exists() and not (ROOT / 'pyproject.toml').exists())
check('CI config under devel/.github', (devel / '.github/workflows/ci.yml').is_file())

# stale-path audit over the code that actually runs (skip frozen legacy + history)
import re
STALE = [r'dist/desktop', r'dist\\\\desktop', r'dist/SMOKE', r'dist/BUILD_DELIVERY',
         r'artifacts/cache', r'runtime/electron-builder-cache', r"ROOT / 'dist'"]
skips = ('runtime', 'artifacts', 'node_modules', '__pycache__', 'legacy', 'history', 'build')
hits = []
for p in sorted(devel.rglob('*')):
    if not p.is_file() or p.suffix not in ('.py', '.ps1', '.md', '.json', '.yml', '.toml'):
        continue
    rel = p.relative_to(devel).as_posix()
    if any(part in skips for part in rel.split('/')):
        continue
    try:
        text = p.read_text('utf-8')
    except Exception:
        continue
    for i, line in enumerate(text.splitlines(), 1):
        if any(re.search(pat, line) for pat in STALE):
            hits.append('%s:%d' % (rel, i))
check('no stale build paths in runnable source', not hits, '; '.join(hits[:5]))

# ---------------------------------------------------------------- 7. anchors resolve as documented
anchor_test = '''
import sys, pathlib
sys.path.insert(0, sys.argv[1])
import importlib.util
spec = importlib.util.spec_from_file_location("bd", pathlib.Path(sys.argv[1]) / "tools/build_desktop.py")
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print(m.ROOT.resolve()); print(m.PROJECT.resolve())
print((m.PROJECT / "desktop-standalone").resolve())
print((m.BUILD / "dist/memora-backend").resolve())
'''
import subprocess
REPO = pathlib.Path(__file__).resolve().parents[2]
DATA = REPO / 'data'
RELEASE = REPO.parent / 'memora-release'
out = subprocess.run([str(ROOT / '.venv/Scripts/python.exe'), '-c', anchor_test, str(devel)],
                     capture_output=True, text=True)
lines = [l.strip() for l in out.stdout.splitlines() if l.strip()]
check('build_desktop anchors: DEVEL', len(lines) > 0 and pathlib.Path(lines[0]) == devel.resolve(), lines[0] if lines else out.stderr[:120])
check('build_desktop anchors: PROJECT', len(lines) > 1 and pathlib.Path(lines[1]) == ROOT.resolve(), lines[1] if len(lines) > 1 else '')
check('build_desktop anchors: PRODUCT', len(lines) > 2 and pathlib.Path(lines[2]) == product.resolve(), lines[2] if len(lines) > 2 else '')
check('build_desktop anchors: backend input', len(lines) > 3 and pathlib.Path(lines[3]) == (ROOT / 'build/dist/memora-backend').resolve(), lines[3] if len(lines) > 3 else '')

# ---------------------------------------------------------------- 8. the default data dir trap is closed
out = subprocess.run([str(ROOT / '.venv/Scripts/python.exe'), '-c',
                      'from memora.config import default_data_dir; print(default_data_dir())'],
                     capture_output=True, text=True, cwd=str(ROOT))
resolved = out.stdout.strip()
check('default_data_dir() resolves the live store from any cwd',
      pathlib.Path(resolved) == (ROOT / 'data').resolve(), resolved or out.stderr[-120:])

# ---------------------------------------------------------------- 9. summary
failed = [name for name, ok, _ in results if not ok]
print('\n%d checks, %d failed' % (len(results), len(failed)))
if failed:
    print('FAILED:')
    for f in failed:
        print('  -', f)
out_path = ROOT / 'build/reports/refactor/acceptance-results.json'
out_path.write_text(json.dumps([{'check': n, 'ok': o, 'detail': d} for n, o, d in results],
                               ensure_ascii=False, indent=2), 'utf-8')
print('written:', out_path)
sys.exit(1 if failed else 0)
