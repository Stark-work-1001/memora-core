import pathlib
REPO = pathlib.Path(__file__).resolve().parents[2]
DATA = REPO / 'data'
RELEASE = REPO.parent / 'memora-release'

t = REPO / 'memora' / 'static' / 'memory.js'.read_text('utf-8').splitlines()
for i, line in enumerate(t, 1):
    if "recall" in line and ('api(' in line or 'api (' in line):
        print(i, line[:200])
