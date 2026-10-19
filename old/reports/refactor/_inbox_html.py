import pathlib
REPO = pathlib.Path(__file__).resolve().parents[2]
DATA = REPO / 'data'
RELEASE = REPO.parent / 'memora-release'

t = REPO / 'memora' / 'static' / 'memory.html'.read_text('utf-8').splitlines()
for i, line in enumerate(t, 1):
    if 'id="inbox"' in line:
        start = i - 3
        break
else:
    raise SystemExit('inbox section not found')
for j in range(start, start + 45):
    print(j + 1, t[j][:175])
