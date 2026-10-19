import pathlib
REPO = pathlib.Path(__file__).resolve().parents[2]
DATA = REPO / 'data'
RELEASE = REPO.parent / 'memora-release'

root = REPO
for f in ('memora/core.py', 'memora/service.py', 'memora/mcp.py', 'memora/workbench.py'):
    path = root / f
    if not path.exists():
        continue
    for i, line in enumerate(path.read_text('utf-8').splitlines(), 1):
        low = line.lower()
        if 'def recall' in low or 'include_user' in low or "tier" in low:
            print('%s:%d: %s' % (f, i, line.strip()[:160]))
