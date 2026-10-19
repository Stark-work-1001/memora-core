"""Fetch the official Electron runtime and verify its npm-distributed SHA-256 checksum.

Directory contract: this file lives in <dev>/tools/. The Electron npm package (and its
checksums.json) is under <dev>/desktop/node_modules, while the downloaded archive is build
material and therefore belongs under <dev>/cache.
"""
import hashlib
import json
import os
import subprocess
import sys as _sys
import urllib.request
import uuid
import zipfile
from pathlib import Path
from pathlib import Path as _Path

if str(_Path(__file__).resolve().parent) not in _sys.path: _sys.path.insert(0, str(_Path(__file__).resolve().parent))
from paths import CACHE
from paths import DESKTOP_SHELL as DESKTOP


def main():
    pkg = json.loads((DESKTOP / 'package.json').read_text('utf-8'))
    version = pkg['devDependencies']['electron']
    name = f'electron-v{version}-win32-x64.zip'
    CACHE.mkdir(parents=True, exist_ok=True)
    archive = CACHE / name
    expected = json.loads((DESKTOP / 'node_modules/electron/checksums.json').read_text('utf-8'))[name]
    if not archive.is_file() or hashlib.sha256(archive.read_bytes()).hexdigest() != expected:
        request = urllib.request.Request(f'https://github.com/electron/electron/releases/download/v{version}/{name}?build={uuid.uuid4().hex}', headers={'User-Agent': 'Memora-release-build'})
        with urllib.request.urlopen(request, timeout=45) as response, archive.open('wb') as output:
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk: break
                output.write(chunk)
    if hashlib.sha256(archive.read_bytes()).hexdigest() != expected:
        raise RuntimeError('Electron checksum mismatch')
    destination = DESKTOP / 'node_modules/electron/dist'
    destination.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive) as z: z.extractall(destination)
    # An extracted runtime can inherit Low labels from a development directory.
    powershell = Path(os.environ['SystemRoot']) / 'System32/WindowsPowerShell/v1.0/powershell.exe'
    subprocess.run([str(powershell), '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
                    str(DESKTOP / 'Repair-Desktop.ps1'), '-ApplicationDirectory', str(destination), '-ElectronRuntime'], check=True)
    (destination.parent / 'path.txt').write_text('electron.exe', 'utf-8')
    print('Official Electron runtime verified and ready.')


if __name__ == '__main__': main()
