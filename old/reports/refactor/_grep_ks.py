import pathlib
REPO = pathlib.Path(__file__).resolve().parents[2]
DATA = REPO / 'data'
RELEASE = REPO.parent / 'memora-release'

p = REPO / 'tests' / 'test_model_connect_ui_static.py'
for i, line in enumerate(p.read_text('utf-8').splitlines(), 1):
    if 'key_set' in line or 'render({' in line or 'keySet' in line:
        print(i, line[:160])
