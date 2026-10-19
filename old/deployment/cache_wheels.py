"""Recover immutable wheel downloads from pip's existing HTTP cache, without changing it."""
import os
import zipfile
from pathlib import Path

cache = Path.home() / '.cache/pip/http-v2'
target = Path.home() / '.local/share/memora/wheelhouse'
target.mkdir(parents=True, exist_ok=True)
count = 0
for body in cache.rglob('*.body'):
    if not zipfile.is_zipfile(body): continue
    try:
        with zipfile.ZipFile(body) as archive:
            wheel = next(n for n in archive.namelist() if n.endswith('.dist-info/WHEEL'))
            stem = wheel.split('/')[0][:-10]
            tags = [line.split(': ', 1)[1] for line in archive.read(wheel).decode().splitlines() if line.startswith('Tag: ')]
            if not tags: continue
            # Preserve compressed multi-interpreter tags (py2.py3); retaining only
            # py2 incorrectly hides otherwise compatible universal wheels.
            interpreters = sorted({tag.split('-')[0] for tag in tags})
            suffix = tags[0].split('-', 1)[1]
            tag = '.'.join(interpreters) + '-' + suffix if len({tag.split('-', 1)[1] for tag in tags}) == 1 else tags[0]
            filename = stem + '-' + tag + '.whl'
        destination = target / filename
        if not destination.exists(): os.link(body, destination)
        count += 1
    except (StopIteration, ValueError, OSError, zipfile.BadZipFile): continue
print('Recovered cached wheels:', count, flush=True)
