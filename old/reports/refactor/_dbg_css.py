import pathlib
import re
REPO = pathlib.Path(__file__).resolve().parents[2]
DATA = REPO / 'data'
RELEASE = REPO.parent / 'memora-release'

css = REPO / 'memora' / 'static' / 'memory.css'.read_text('utf-8')
new = css.split('12. 模型连接', 1)[1]
print('--- literals in section 12+ BEFORE stripping ---')
lits = re.findall(r'#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(', new)
print(lits)

m = re.search(r'\.dag-embed\s*\{[^}]*\}', new)
print('--- .dag-embed block match:', bool(m))
if m:
    print(repr(m.group(0)[:220]))

for match in re.finditer(r'#[0-9a-fA-F]{3,8}\b', new):
    start = new.rfind('\n', 0, match.start())
    print('literal', match.group(0), 'line context:', new[start:match.end()][:120].strip())
