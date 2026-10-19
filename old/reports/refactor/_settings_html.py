import pathlib
REPO = pathlib.Path(__file__).resolve().parents[2]
DATA = REPO / 'data'
RELEASE = REPO.parent / 'memora-release'

t = REPO / 'memora' / 'static' / 'memory.html'.read_text('utf-8').splitlines()
for i, line in enumerate(t, 1):
    if 'id="settings"' in line or 'model-settings' in line or 'settings-form' in line or '模型配置' in line:
        print(i, line[:160])
