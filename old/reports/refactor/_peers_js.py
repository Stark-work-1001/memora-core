import pathlib
REPO = pathlib.Path(__file__).resolve().parents[2]
DATA = REPO / 'data'
RELEASE = REPO.parent / 'memora-release'

root = REPO
js = (root / 'memora/static/memory.js').read_text('utf-8')
lines = js.splitlines()
print('=== peers references in memory.js ===')
for i, line in enumerate(lines, 1):
    if 'peer' in line.lower():
        print(i, line[:190])
