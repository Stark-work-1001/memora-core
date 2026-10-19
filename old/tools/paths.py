"""One place that knows where things are.

The layout has changed shape more than once, and every change broke a different script because
each one recomputed the project root from its own `parents[N]`. This module is the single answer::

    <data dir>/
      memora/                     development + test tree (this repository)
        memora/                   the Python package
        tools/  tests/  frontend/  desktop/
        data/                     LIVE memory store used by development and tests
        cache/                    downloaded build material
        dist/                     PyInstaller output (memora-backend/)
        pyinstaller/              PyInstaller workpath + generated spec
        reports/                  build/validation evidence
        archive/  artifacts/      frozen history and dev artifacts
        runtime/                  development runtime state (logs, tmp, adapters)
        .venv/                    interpreter and dependencies
      memora-desktop-standalone/  the packaged, unzip-and-run application
      memora-release/             install packages (zip + sha256)

WHY IT IS A MODULE AND NOT A CONSTANT IN EACH SCRIPT
----------------------------------------------------
`tools/` used to assume it lived in `<root>/devel/tools`, so `parents[1]` was the source tree and
`parents[1].parent` was the project root. When the tree was flattened — the contents of devel/ and
build/ moved up, and the product moved OUT to a sibling directory — every one of those assumptions
silently pointed at the wrong place: the build would have read an empty source tree and written the
product inside the repository, while the running product lived elsewhere. A shared module means the
next move is one edit, and `python tools/paths.py` prints what it resolved so a wrong assumption is
visible instead of silent.
"""
import sys
from pathlib import Path

# tools/paths.py -> tools -> DEV (this repository)
DEV = Path(__file__).resolve().parents[1]
# The packaged app and the release packages are siblings of this repository, not children of it:
# the product is what a user runs, and it must not be rebuilt or polluted by a dev build.
MEMORY = DEV.parent
PRODUCT = MEMORY / 'memora-desktop-standalone'
RELEASE = MEMORY / 'memora-release'

# Inside the development tree.
PACKAGE = DEV / 'memora'
STATIC = PACKAGE / 'static'
FRONTEND = DEV / 'frontend'
DESKTOP_SHELL = DEV / 'desktop'          # Electron shell source (main.cjs, package.json, node_modules)
TESTS = DEV / 'tests'
DOCS = DEV / 'docs'
DATA = DEV / 'data'                       # LIVE store: 914 memories. Development and tests only.
VENV = DEV / '.venv'

# Build material and output, all inside the repo so a build is self-contained and disposable.
CACHE = DEV / 'cache'
DIST = DEV / 'dist'
PYINSTALLER = DEV / 'pyinstaller'
REPORTS = DEV / 'reports'
ARCHIVE = DEV / 'archive'
ARTIFACTS = DEV / 'artifacts'
RUNTIME = DEV / 'runtime'

VENV_PYTHON = VENV / 'Scripts/python.exe'

# Ports. Development and tests own one pair; the packaged application must never collide with a
# running dev session, because both would open the same SQLite database and the WAL handoff between
# two writers is not something a user can be asked to reason about.
DEV_PORT = 8765
DEV_MCP_PORT = 18184
PRODUCT_PORT = 18765

# Environment variable the packaged app and the dev launcher both honour, so a caller never has to
# guess which one it is talking to.
PORT_ENV = 'MEMORA_PORT'


def summary():
    names = ('DEV', 'MEMORY', 'PRODUCT', 'RELEASE', 'PACKAGE', 'STATIC', 'FRONTEND',
             'DESKTOP_SHELL', 'DATA', 'VENV', 'CACHE', 'DIST', 'PYINSTALLER', 'REPORTS',
             'RUNTIME')
    out = {name: str(globals()[name]) for name in names}
    out['exists'] = {name: globals()[name].exists() for name in names}
    out['ports'] = {'dev': DEV_PORT, 'dev_mcp': DEV_MCP_PORT, 'product': PRODUCT_PORT}
    out['python'] = str(VENV_PYTHON)
    out['python_exists'] = VENV_PYTHON.exists()
    return out


if __name__ == '__main__':
    import json
    json.dump(summary(), sys.stdout, ensure_ascii=False, indent=2)
    print()
