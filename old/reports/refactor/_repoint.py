"""Repoint the build scripts at tools/paths.py after the tree was flattened.

Each entry is (file, [(old, new)], note). A missing anchor is reported and that file is left alone,
so a partial conversion can never be written silently.
"""
import pathlib

DEV = pathlib.Path(__file__).resolve().parents[2]          # .../memora
print('DEV =', DEV)

PATCHES = {
    'tools/build_desktop.py': [
        (
            "ROOT = Path(__file__).resolve().parents[1]            # devel/ -- the source tree\n"
            "PROJECT = ROOT.parent                                  # project root\n"
            "BUILD = PROJECT / 'build'\n"
            "PRODUCT = PROJECT / 'desktop-standalone'",
            "from paths import DEV as ROOT, PRODUCT, CACHE, DIST, PYINSTALLER, DESKTOP_SHELL",
        ),
        ("(BUILD / 'pyinstaller').mkdir(parents=True, exist_ok=True)", "PYINSTALLER.mkdir(parents=True, exist_ok=True)"),
        ("(BUILD / 'dist').mkdir(parents=True, exist_ok=True)", "DIST.mkdir(parents=True, exist_ok=True)"),
        ("dir=BUILD / 'pyinstaller'", "dir=PYINSTALLER"),
        ("'--distpath', str(BUILD / 'dist'), '--workpath', str(BUILD / 'pyinstaller/work'),",
         "'--distpath', str(DIST), '--workpath', str(PYINSTALLER / 'work'),"),
        ("'--specpath', str(BUILD / 'pyinstaller'), '--paths', str(staging),",
         "'--specpath', str(PYINSTALLER), '--paths', str(staging),"),
        ("backend = BUILD / 'dist/memora-backend'", "backend = DIST / 'memora-backend'"),
        ("(ROOT / 'desktop/node_modules/electron-builder').exists()", "(DESKTOP_SHELL / 'node_modules/electron-builder').exists()"),
        ("run(['npm.cmd', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], ROOT / 'desktop')",
         "run(['npm.cmd', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], DESKTOP_SHELL)"),
        ("builder_cache = BUILD / 'cache/electron-builder'", "builder_cache = CACHE / 'electron-builder'"),
        ("run(['npm.cmd', 'run', 'pack'], ROOT / 'desktop',", "run(['npm.cmd', 'run', 'pack'], DESKTOP_SHELL,"),
        ("shutil.copyfile(ROOT / 'desktop' / name, desktop / name)", "shutil.copyfile(DESKTOP_SHELL / name, desktop / name)"),
    ],
    'tools/smoke_desktop.py': [
        (
            "ROOT = Path(__file__).resolve().parents[1]            # devel/ -- the source tree\n"
            "PROJECT = ROOT.parent                                  # project root\n"
            "DESKTOP = PROJECT / 'desktop-standalone'\n"
            "REPORTS = PROJECT / 'build/reports'",
            "from paths import DEV as ROOT, PRODUCT as DESKTOP, REPORTS",
        ),
    ],
    'tools/release.py': [
        (
            "ROOT = Path(__file__).resolve().parents[1]          # devel/\n"
            "PROJECT = ROOT.parent                                # project root\n"
            "DESKTOP = PROJECT / 'desktop-standalone'\n",
            "from paths import DEV as ROOT, PRODUCT as DESKTOP\n",
        ),
        ("REPORTS = PROJECT / 'build/reports'", "REPORTS = ROOT / 'reports'"),
        ("RELEASE = PROJECT / 'release'", "RELEASE = ROOT.parent / 'memora-release'"),
    ],
    'tools/fetch_electron.py': [
        (
            "ROOT = Path(__file__).resolve().parents[1]      # devel/\n"
            "PROJECT = ROOT.parent                            # project root\n"
            "DESKTOP = ROOT / 'desktop'                       # electron shell source\n"
            "CACHE = PROJECT / 'build/cache'",
            "from paths import DEV as ROOT, DESKTOP_SHELL as DESKTOP, CACHE",
        ),
    ],
    'tools/runtime_manager.py': [
        (
            "ROOT = Path(__file__).resolve().parents[1]   # devel/\n"
            "PROJECT = ROOT.parent                         # project root\n"
            "STATE = ROOT / 'runtime'                      # development runtime state, inside the source tree\n"
            "DATA = PROJECT / 'data'                       # the live memory store, outside the source tree\n"
            "VENV_PYTHON = PROJECT / '.venv/Scripts/python.exe'",
            "from paths import DEV as ROOT, RUNTIME as STATE, DATA, VENV_PYTHON",
        ),
    ],
    'tools/install_dsh.py': [
        (
            "ROOT = Path(__file__).resolve().parents[1]      # devel/\n"
            "PROJECT = ROOT.parent                            # project root",
            "from paths import DEV as ROOT, DATA as _DATA",
        ),
    ],
}

for relative, replacements in PATCHES.items():
    path = DEV / relative
    if not path.exists():
        print('MISSING FILE', relative)
        continue
    text = path.read_text('utf-8')
    missed = []
    for old, new in replacements:
        if old not in text:
            missed.append(old[:60].replace('\n', ' / '))
            continue
        text = text.replace(old, new, 1)
    if missed:
        print('%-32s SKIPPED, anchors missing: %s' % (relative, missed))
        continue
    path.write_text(text, 'utf-8')
    print('%-32s patched (%d)' % (relative, len(replacements)))
