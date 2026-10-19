import pathlib
import re
REPO = pathlib.Path(__file__).resolve().parents[2]
DATA = REPO / 'data'
RELEASE = REPO.parent / 'memora-release'

test = REPO / 'tests' / 'test_model_connect_ui_static.py'.read_text('utf-8')
i = test.index('    # -- 14.')
print('--- test source ---')
print(test[i:i + 1400])
