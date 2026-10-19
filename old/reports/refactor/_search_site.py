import pathlib
REPO = pathlib.Path(__file__).resolve().parents[2]
DATA = REPO / 'data'
RELEASE = REPO.parent / 'memora-release'

t = REPO / 'memora' / 'static' / 'memory.js'.read_text('utf-8').splitlines()
needles = ["api('recall'", 'search-form', 'function search', 'search-info', 'enterRetrieve']
for i, line in enumerate(t, 1):
    if any(n in line for n in needles):
        print(i, line[:180])
