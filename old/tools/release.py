"""Create one local ZIP of the validated portable desktop; never publish or stage public/release.

Two things changed after 1.2.0 and both are enforced here rather than described:

* The ZIP carries its own data/ directory (empty schema-valid databases, a markdown/ folder for
  user documents, and a {} settings template), so unpacking is the whole install. It must
  therefore hold no user memory, no token and no integration state -- this script builds that
  directory from scratch and refuses to package anything else.
* Desensitization is a gate, not a claim. A secret-shaped value or a developer absolute path that
  survives in a shipped text file aborts the build, and the report records what was scanned.
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import sys as _sys
import zipfile
from pathlib import Path
from pathlib import Path as _Path

from artifact_integrity import tree_sha256
from windows_integrity import inspect_program_labels

if str(_Path(__file__).resolve().parent) not in _sys.path: _sys.path.insert(0, str(_Path(__file__).resolve().parent))
from paths import DEV as ROOT
from paths import PRODUCT as DESKTOP

# The packaged app's LIVE data directory. It holds the user's memories, documents and their model
# configuration, so nothing in this script may delete or rewrite it as a side effect of packaging.
PRODUCT_DATA = DESKTOP / 'data'
REPORTS = ROOT / 'reports'
RELEASE = ROOT.parent / 'memora-release'

TEXT_SUFFIXES = {".json", ".py", ".js", ".mjs", ".cjs", ".txt", ".md", ".cfg", ".ini", ".toml",
                 ".yml", ".yaml", ".html", ".css", ".ps1", ".cmd", ".bat", ".sh", ".lock"}
SECRET_PATTERNS = {
    'literal API key': re.compile(rb'sk-[A-Za-z0-9_-]{24,}'),
    'bearer header': re.compile(rb'Bearer\s+[A-Za-z0-9._-]{24,}'),
    'private key block': re.compile(rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'),
    'assigned credential': re.compile(rb'"(?:api_key|token|secret|password)"\s*:\s*"[^"<>]{16,}"'),
}
# Machine identifiers that must never travel with a distribution.
HOST_PATTERNS = {
    'developer drive path': re.compile(rb'[A-Za-z]:\\\\(?![A-Za-z]:\\)[A-Za-z0-9_.\\-]{3,120}'),
    'windows user profile': re.compile(rb'C:[/\\]Users[/\\]', re.I),
    'wsl home': re.compile(rb'/home/[A-Za-z][A-Za-z0-9._-]+/'),
}
FORBIDDEN_DATA = {'mcp-token', 'accumulation.json'}
FORBIDDEN_DATA_DIRS = {'integrations', 'documents', '.tmp', 'backups'}
FORBIDDEN_SUFFIXES = {'.sqlite3-shm', '.sqlite3-wal', '.key', '.log', '.pem'}


def sha(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''): h.update(chunk)
    return h.hexdigest()


def text_files(root):
    for file in sorted(root.rglob("*")):
        if file.is_file() and file.suffix.lower() in TEXT_SUFFIXES:
            yield file


def scan(root, patterns):
    """Return [{kind, file, sample}] for every pattern hit -- empty means nothing shaped like it shipped."""
    problems = []
    for file in text_files(root):
        try: raw = file.read_bytes()
        except OSError: continue
        for kind, pattern in patterns.items():
            match = pattern.search(raw)
            if match:
                problems.append({'kind': kind, 'file': file.relative_to(root).as_posix(),
                                 'sample': match.group(0)[:40].decode('latin-1', 'replace')})
    return problems


def stage_data():
    """Build a fresh, schema-valid data/ in a TEMPORARY directory and return its path.

    It used to write straight into the packaged application's data/ after rmtree()-ing it, which
    destroyed the user's store and their model configuration on every packaging run. A template is
    an artifact for the ZIP; it must never be assembled by deleting a live directory.

    A fresh install must start with working databases and an empty document store -- never with
    rows copied from the developer's own store, which is exactly what a shutil.copytree of
    ROOT/'data' would have shipped.
    """
    import sqlite3
    import tempfile

    from memora.core import MemoryRuntime
    DATA = Path(tempfile.mkdtemp(prefix='memora-template-'))
    runtime = MemoryRuntime(DATA)
    try:
        # Touch the sidecar stores so each ships with its own schema rather than being created on
        # a first write that may never happen (a read-only first session would otherwise find none).
        _ = runtime.documents, runtime.control, runtime.jobs
        runtime.store.health()
    finally:
        runtime.close()
    markdown = DATA / 'markdown'
    markdown.mkdir(exist_ok=True)
    (markdown / '.gitkeep').write_text('', encoding='utf-8')
    # An empty object is the honest starting state: a half-filled role (backend set, url blank) is
    # a configuration error the app cannot start with, while {} means nothing configured yet.
    (DATA / 'memora.json').write_text(json.dumps({}, indent=2) + chr(10), encoding='utf-8')
    # Checkpoint every database to a single file: a shipped -wal/-shm pair is both stale state and
    # an invitation to copy a database mid-transaction. The connection must be genuinely closed
    # first -- `with sqlite3.connect(...)` is a transaction scope, not a close, so the sidecars stay
    # locked and Windows refuses the unlink with WinError 32.
    for db in sorted(DATA.glob("*.sqlite3")):
        c = sqlite3.connect(db)
        try:
            c.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            c.close()
        finally:
            try: c.close()
            except Exception: pass
        for sidecar in (DATA / (db.name + "-wal"), DATA / (db.name + "-shm")):
            if sidecar.exists(): sidecar.unlink()
    scratch = DATA / '.tmp'
    if scratch.exists(): shutil.rmtree(scratch)
    # Return the DIRECTORY, not a name list: the caller substitutes it into the copy that becomes
    # the ZIP. A bare list of names was enough when the template was written in place, and it is
    # exactly that assumption that made packaging able to overwrite the installed app.
    return DATA


def inspect_data(data=None):
    """The data directory that will SHIP must be empty of user state and complete in schema.

    Takes the directory explicitly: it inspects the staged copy, never the installed application.
    """
    DATA = Path(data) if data is not None else PRODUCT_DATA
    import sqlite3
    problems = []
    for entry in sorted(DATA.iterdir()):
        if entry.is_dir() and entry.name in FORBIDDEN_DATA_DIRS:
            problems.append('forbidden data folder: ' + entry.name)
        elif entry.is_file():
            if entry.name in FORBIDDEN_DATA:
                problems.append('credential or runtime state: ' + entry.name)
            if entry.suffix in FORBIDDEN_SUFFIXES:
                problems.append('forbidden data file: ' + entry.name)
    # immutable=1 keeps the check read-only in the strict sense: a plain read-only open still
    # creates a -shm WAL index when it finds a WAL header, which would put sidecars back into the
    # artifact this function is here to keep clean.
    for db in sorted(DATA.glob("*.sqlite3")):
        with sqlite3.connect("file:" + db.as_posix() + "?mode=ro&immutable=1", uri=True) as c:
            ok = c.execute("PRAGMA integrity_check").fetchone()[0]
            if ok != 'ok': problems.append('%s integrity: %s' % (db.name, ok))
            tables = c.execute("SELECT count(*) FROM sqlite_master WHERE type='table'").fetchone()[0]
            if tables == 0: problems.append('%s has no schema' % db.name)
    memory = DATA / "memory.sqlite3"
    if not memory.exists(): problems.append('memory.sqlite3 is missing')
    else:
        with sqlite3.connect("file:" + memory.as_posix() + "?mode=ro&immutable=1", uri=True) as c:
            rows = c.execute("SELECT count(*) FROM memories").fetchone()[0]
            if rows: problems.append('packaged memory.sqlite3 holds %d user memories' % rows)
    if not (DATA / "markdown").is_dir(): problems.append("markdown/ is missing")
    settings = DATA / "memora.json"
    if not settings.exists(): problems.append('memora.json template is missing')
    elif settings.read_text('utf-8').strip() != '{}': problems.append('memora.json is not the empty template')
    return problems


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--skip-build', action='store_true')
    args = p.parse_args()
    from memora import __version__
    if not args.skip_build:
        subprocess.run([sys.executable, str(ROOT / 'tools/build_desktop.py')], check=True)
    # The data directory is part of the artifact, so it exists BEFORE the smoke run that hashes the
    # tree; a tree hash taken without it would not describe what ships.
    staged_dir = stage_data()
    staged = sorted(p.name for p in staged_dir.iterdir())
    if not args.skip_build:
        subprocess.run([sys.executable, str(ROOT / 'tools/smoke_desktop.py')], check=True)
    report = json.loads((REPORTS / 'SMOKE_VALIDATION.json').read_text('utf-8'))
    backend = DESKTOP / 'resources/backend/memora-backend.exe'
    if (report.get('version') != __version__ or report.get('backend_sha256') != sha(backend)
            or report.get('artifact_tree_sha256') != tree_sha256(DESKTOP) or not report.get('passed')
            or report.get('desktop_default_exit_code') != 0 or not report.get('desktop_ready')
            or report.get('desktop_test_sandbox_workaround') or not report.get('windows_integrity')):
        raise SystemExit('Run tools/smoke_desktop.py on the current desktop before packaging.')

    # ---- build the artifact in a COPY. The installed app must not be touched at all: its data/
    # holds the user's memories and their model configuration, and an earlier version of this script
    # deleted it on every packaging run.
    import tempfile
    staging_root = Path(tempfile.mkdtemp(prefix='memora-package-'))
    package = staging_root / 'Memora'
    shutil.copytree(DESKTOP, package, symlinks=False,
                    ignore=shutil.ignore_patterns('data'))
    package_data = package / 'data'
    shutil.copytree(staged_dir, package_data)

    # Copying files does NOT copy their mandatory integrity label: a copy lands at whatever the
    # creating process holds, so the staged tree reads as Low and the integrity gate refuses it.
    # Repair the COPY (never the installed product) before inspecting it.
    repair = package / 'Repair-Desktop.ps1'
    if sys.platform == 'win32' and repair.exists():
        subprocess.run([str(Path(os.environ.get('SystemRoot', r'C:\Windows')) / 'System32/WindowsPowerShell/v1.0/powershell.exe'),
                        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', str(repair)],
                       cwd=str(package), check=False)
    labels = inspect_program_labels(package)
    data_problems = inspect_data(package_data)
    if data_problems:
        raise SystemExit('Packaged data/ is not a clean template: ' + '; '.join(data_problems))
    for sidecar in sorted(package_data.glob('*.sqlite3-*')):
        sidecar.unlink()
    leftovers = [p.name for p in package_data.iterdir() if p.suffix in FORBIDDEN_SUFFIXES]
    if leftovers:
        raise SystemExit('Packaged data/ still holds sidecars: ' + ', '.join(leftovers))
    secrets = scan(package, SECRET_PATTERNS)
    if secrets:
        raise SystemExit('Refusing to package: secret-shaped content: ' + json.dumps(secrets[:6]))
    hosts = scan(package, HOST_PATTERNS)
    if hosts:
        raise SystemExit('Refusing to package: host-specific content: ' + json.dumps(hosts[:6]))
    files = sorted(f for f in package.rglob("*") if f.is_file())
    for file in files:
        relative = file.relative_to(package).as_posix()
        if file.is_symlink():
            raise RuntimeError('Unexpected symlink in the packaged desktop: ' + relative)
        # certifi's public trust anchors are required for cloud HTTPS, not private credentials.
        public_ca = relative == 'resources/backend/_internal/certifi/cacert.pem'
        if file.suffix in {'.sqlite3', '.db', '.key', '.log'} and not relative.startswith('data/'):
            raise RuntimeError('Unexpected runtime data in build: ' + relative)
        if public_ca and b'PRIVATE KEY' in file.read_bytes():
            raise RuntimeError('Unexpected private key in CA bundle')
    RELEASE.mkdir(parents=True, exist_ok=True)
    destination = RELEASE / ('memora-' + __version__ + '-windows-x64.zip')
    temporary = destination.with_suffix('.zip.tmp')
    with zipfile.ZipFile(temporary, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for file in files:
            archive.write(file, file.relative_to(package).as_posix())
        # Empty folders do not survive a file-only archive; markdown/ must exist after unpacking.
        for directory in sorted(package.rglob("*")):
            if directory.is_dir() and not any(directory.iterdir()):
                archive.writestr(directory.relative_to(package).as_posix() + "/", "")
    with zipfile.ZipFile(temporary) as archive:
        if archive.testzip() is not None: raise RuntimeError('ZIP integrity verification failed')
    os.replace(temporary, destination)
    # Count BEFORE removing the staging tree: text_files(package) after the rmtree walks a directory
    # that no longer exists and silently reports 0 files scanned, which reads like a clean scan.
    files_scanned = sum(1 for _ in text_files(package))
    shutil.rmtree(staging_root, ignore_errors=True)
    info = {"version": __version__, "file": destination.name, "sha256": sha(destination),
            "bytes": destination.stat().st_size, "profile": "single-portable", "unpack_and_run": True,
            "bundled_data": {"path": "data/", "entries": staged,
                             "template": "empty schema-v2 databases, markdown/ for documents, memora.json = {}"},
            "features": report["features"], "validation": "SMOKE_VALIDATION.json",
            "artifact_tree_sha256": report["artifact_tree_sha256"],
            "product_untouched": str(DESKTOP),
            "desensitization": {"files_scanned": files_scanned,
                                "secret_patterns": len(SECRET_PATTERNS),
                                "host_patterns": len(HOST_PATTERNS), "problems": 0},
            "mandatory_integrity": labels["mandatory_integrity"]}
    (RELEASE / 'BUILD_DELIVERY.json').write_text(json.dumps(info, ensure_ascii=False, indent=2), 'utf-8')
    (RELEASE / (destination.name + '.sha256')).write_text(info['sha256'] + '  ' + destination.name + chr(10), 'utf-8')
    print(json.dumps(info, indent=2))


if __name__ == "__main__": main()
