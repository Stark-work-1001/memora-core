"""Fix the remaining PROJECT references left after the main repoint."""
import pathlib

DEV = pathlib.Path(__file__).resolve().parents[2]

# ---------------------------------------------------------------- runtime_manager.py
p = DEV / 'tools/runtime_manager.py'
t = p.read_text('utf-8')
t = t.replace("cwd=PROJECT,", "cwd=ROOT,")
p.write_text(t, 'utf-8')
print('runtime_manager.py: cwd -> ROOT')

# ---------------------------------------------------------------- install_dsh.py
p = DEV / 'tools/install_dsh.py'
t = p.read_text('utf-8')
t = t.replace("from paths import DEV as ROOT, DATA as _DATA",
              "from paths import DEV as ROOT, DATA, VENV")
t = t.replace("command: {quote(PROJECT / '.venv/Scripts/python.exe')}",
              "command: {quote(VENV / 'Scripts/python.exe')}")
t = t.replace("args: ['-m', 'memora', '--data', {quote(PROJECT / 'data')}, 'mcp']",
              "args: ['-m', 'memora', '--data', {quote(DATA)}, 'mcp']")
t = t.replace("cwd: {quote(PROJECT)}", "cwd: {quote(ROOT)}")
t = t.replace("tokenFile: {quote(PROJECT / 'data/mcp-token')}",
              "tokenFile: {quote(DATA / 'mcp-token')}")
t = t.replace("outbox: {quote(PROJECT / 'data/integrations/dsh-outbox')}",
              "outbox: {quote(DATA / 'integrations/dsh-outbox')}")
p.write_text(t, 'utf-8')
print('install_dsh.py: PROJECT -> DATA/VENV/ROOT')

# ---------------------------------------------------------------- fetch_electron docstring
p = DEV / 'tools/fetch_electron.py'
t = p.read_text('utf-8')
t = t.replace(
    "Directory contract: this file lives in <project>/devel/tools/. The Electron npm package (and its\n"
    "checksums.json) is under devel/desktop/node_modules, while the downloaded archive is build material\n"
    "and therefore belongs under <project>/build/cache.",
    "Directory contract: this file lives in <dev>/tools/. The Electron npm package (and its\n"
    "checksums.json) is under <dev>/desktop/node_modules, while the downloaded archive is build\n"
    "material and therefore belongs under <dev>/cache.")
p.write_text(t, 'utf-8')
print('fetch_electron.py: docstring')

# ---------------------------------------------------------------- build_desktop docstring
p = DEV / 'tools/build_desktop.py'
t = p.read_text('utf-8')
t = t.replace(
    "Directory contract (see docs/RELEASING.md and build/reports/refactor/LAYOUT.md):\n"
    "  this file lives in      <project>/devel/tools/\n"
    "  source is read from     <project>/devel/\n"
    "  intermediates go to     <project>/build/{pyinstaller,dist,cache}\n"
    "  the product is written  <project>/desktop-standalone/   (Memora.exe at its root)\n"
    "  the install package is  <project>/release/               (written by tools/release.py)",
    "Directory contract (see docs/RELEASING.md and docs/DIRECTORY-LAYOUT.md):\n"
    "  this file lives in      <dev>/tools/           (the development repository)\n"
    "  source is read from     <dev>/\n"
    "  build material          <dev>/cache/\n"
    "  intermediates           <dev>/pyinstaller/  and  <dev>/dist/\n"
    "  the product is written  <memory>/memora-desktop-standalone/   (Memora.exe at its root)\n"
    "  the install package is  <memory>/memora-release/               (written by tools/release.py)\n"
    "\n"
    "  The product is deliberately OUTSIDE this repository: it is what a user runs, and a build must\n"
    "  not overwrite the copy someone is using while the source tree is being edited.")
p.write_text(t, 'utf-8')
print('build_desktop.py: docstring')

# ---------------------------------------------------------------- install_dsh docstring
p = DEV / 'tools/install_dsh.py'
t = p.read_text('utf-8')
t = t.replace(
    "Directory contract (see build/reports/refactor/LAYOUT.md): this file lives in\n"
    "<project>/devel/tools/. Source, adapters, backups and dev runtime state live under devel/;\n"
    "the interpreter is the project .venv; the memory store is <project>/data.",
    "Directory contract (see docs/DIRECTORY-LAYOUT.md): this file lives in <dev>/tools/. Source,\n"
    "adapters, backups and dev runtime state live under <dev>/; the interpreter is <dev>/.venv; the\n"
    "memory store is <dev>/data.")
p.write_text(t, 'utf-8')
print('install_dsh.py: docstring')
