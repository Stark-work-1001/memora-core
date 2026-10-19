"""Make `from paths import ...` work no matter how a tool script is invoked.

Each tool script gets a two-line preamble that puts its own directory on sys.path before importing
paths. This is what lets `python tools/build_desktop.py` run from any working directory, which the
launchers rely on.
"""
import pathlib

DEV = pathlib.Path(__file__).resolve().parents[2]

SCRIPTS = ('build_desktop.py', 'smoke_desktop.py', 'release.py', 'fetch_electron.py',
           'runtime_manager.py', 'install_dsh.py')

PREAMBLE = ("import sys as _sys\n"
            "from pathlib import Path as _Path\n"
            "if str(_Path(__file__).resolve().parent) not in _sys.path: _sys.path.insert(0, str(_Path(__file__).resolve().parent))\n")

for name in SCRIPTS:
    path = DEV / 'tools' / name
    text = path.read_text('utf-8')
    if '_sys.path.insert(0, str(_Path(__file__).resolve().parent))' in text:
        print('%-24s already has preamble' % name)
        continue
    marker = 'from paths import '
    index = text.find(marker)
    if index == -1:
        print('%-24s NO paths import, skipped' % name)
        continue
    text = text[:index] + PREAMBLE + text[index:]
    path.write_text(text, 'utf-8')
    print('%-24s preamble added' % name)
