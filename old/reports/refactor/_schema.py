import pathlib
import sqlite3
REPO = pathlib.Path(__file__).resolve().parents[2]
DATA = REPO / 'data'
RELEASE = REPO.parent / 'memora-release'

p = DATA / 'memory.sqlite3'
c = sqlite3.connect('file:' + p.as_posix() + '?mode=ro&immutable=1', uri=True)

print('=== tables ===')
tables = [r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
print(tables)

for name in ('memories', 'documents', 'sessions', 'turns', 'meta'):
    if name not in tables:
        continue
    row = c.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (name,)).fetchone()
    print('\n=== %s ===' % name)
    print(row[0])

print('\n=== project distribution in memories ===')
for r in c.execute('SELECT project, status, count(*) FROM memories GROUP BY project, status ORDER BY project'):
    print(r)

print('\n=== meta keys ===')
for r in c.execute('SELECT key, substr(value,1,80) FROM meta ORDER BY key'):
    print(r)

c.close()
