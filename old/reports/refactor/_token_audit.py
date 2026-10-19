"""Which --mm-* tokens do the two new-ui tests require that memory.css does not define?"""
import pathlib
import re
REPO = pathlib.Path(__file__).resolve().parents[2]
DATA = REPO / 'data'
RELEASE = REPO.parent / 'memora-release'

css = REPO / 'memora' / 'static' / 'memory.css'.read_text('utf-8')
defined = set(re.findall(r'(--mm-[a-z0-9-]+)\s*:', css))
print('defined tokens:', len(defined))

for name in ('test_document_status_ui_static.py', 'test_session_browse_ui_static.py'):
    path = REPO / 'tests' / name
    text = path.read_text('utf-8')
    used = set(re.findall(r'var\((--mm-[a-z0-9-]+)', text))
    missing = sorted(used - defined)
    print(name, '-> requires', len(used), 'missing:', missing)
