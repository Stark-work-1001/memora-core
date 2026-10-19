"""Fix dev-serve.ps1 anchors for the flattened tree."""
import pathlib
REPO = pathlib.Path(__file__).resolve().parents[2]
DATA = REPO / 'data'
RELEASE = REPO.parent / 'memora-release'

DEV = pathlib.Path(__file__).resolve().parents[2]
p = DEV / 'dev-serve.ps1'
text = p.read_text('utf-8')

old = (
    "# This script lives in <project>/devel/. Source and its runtime scratch are here; the interpreter\n"
    "# and the memory store are siblings of devel/, one level up.\n"
    "$develDir = $PSScriptRoot\n"
    "$projectDir = Split-Path -Parent $develDir\n"
    "$pythonPath = Join-Path $projectDir '.venv\\Scripts\\python.exe'"
)
new = (
    "# This script lives at the ROOT of the development tree (<project root>\\). The interpreter,\n"
    "# the source and the live memory store are all here. The packaged application is a sibling one\n"
    "# level up (..\\memora-desktop-standalone) and serves its own data/ on its own port (18765), so a\n"
    "# dev session and the installed app can run at the same time without sharing a database.\n"
    "$devDir = $PSScriptRoot\n"
    "$memoryDir = Split-Path -Parent $devDir\n"
    "$pythonPath = Join-Path $devDir '.venv\\Scripts\\python.exe'"
)
if old not in text:
    raise SystemExit('anchor not found in dev-serve.ps1')
text = text.replace(old, new)

text = text.replace("$env:TEMP = Join-Path $develDir 'runtime\\tmp'",
                    "$env:TEMP = Join-Path $devDir 'runtime\\tmp'")
text = text.replace("$starter = Join-Path $develDir 'deployment\\Start-Models.ps1'",
                    "$starter = Join-Path $devDir 'deployment\\Start-Models.ps1'")
text = text.replace("& $pythonPath -m memora --data (Join-Path $projectDir 'data') serve --port $Port",
                    "& $pythonPath -m memora --data (Join-Path $devDir 'data') serve --port $Port")

p.write_text(text, 'utf-8')
print('dev-serve.ps1 patched')

# Report anything still pointing at the old names.
for i, line in enumerate(text.splitlines(), 1):
    if 'develDir' in line or 'projectDir' in line:
        print('  residual %d: %s' % (i, line.strip()))
