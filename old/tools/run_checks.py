"""Save reproducible regression results without mixing them into application data.

This file lives in <project>/devel/tools/, so ROOT (its parents[1]) is devel/: the test tree it
discovers and the scratch it points TEMP at are both inside the source tree, which is what the
discovery arguments below require. The only product-level output path is under build/reports so
evidence does not accumulate inside devel/artifacts.
"""
import json
import os
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'reports/unit'


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    temporary = ROOT / 'runtime/tmp'; temporary.mkdir(parents=True, exist_ok=True)
    os.environ.update(TEMP=str(temporary), TMP=str(temporary))
    started = time.monotonic()
    with (OUT / 'unit.log').open('w', encoding='utf-8') as stream:
        result = unittest.TextTestRunner(stream=stream, verbosity=2).run(
            unittest.defaultTestLoader.discover(str(ROOT / 'tests'), top_level_dir=str(ROOT)))
    report = {'tests': result.testsRun, 'failures': len(result.failures), 'errors': len(result.errors),
              'skipped': [(str(t), reason) for t, reason in result.skipped],
              'elapsed_seconds': round(time.monotonic() - started, 2), 'passed': result.wasSuccessful()}
    (OUT / 'unit.json').write_text(json.dumps(report, indent=2), 'utf-8'); print(json.dumps(report, indent=2))
    if not result.wasSuccessful(): raise SystemExit(1)


if __name__ == '__main__': main()
