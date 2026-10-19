import pathlib
import sqlite3
REPO = pathlib.Path(__file__).resolve().parents[2]
DATA = REPO / 'data'
RELEASE = REPO.parent / 'memora-release'

p = DATA / 'memora-control.sqlite3'
c = sqlite3.connect('file:' + p.as_posix() + '?mode=ro&immutable=1', uri=True)
for name, sql in c.execute("SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name"):
    print('=== %s ===' % name)
    print(sql)
    print()
c.close()
