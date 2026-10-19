"""Single full-feature desktop build. No private/public feature split or root release tree.

The release carries the whole application: every module under memora/ is staged and collected, so
the packaged build has the same feature surface as the source tree (advanced CLI, agent runtime,
local sources, evaluation, ops). Nothing is excluded from a delivered build.

Directory contract (see docs/RELEASING.md and docs/DIRECTORY-LAYOUT.md):
  this file lives in      <dev>/tools/           (the development repository)
  source is read from     <dev>/
  build material          <dev>/cache/
  intermediates           <dev>/pyinstaller/  and  <dev>/dist/
  the product is written  <memory>/memora-desktop-standalone/   (Memora.exe at its root)
  the install package is  <memory>/memora-release/               (written by tools/release.py)

  The product is deliberately OUTSIDE this repository: it is what a user runs, and a build must
  not overwrite the copy someone is using while the source tree is being edited.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import sys as _sys
import tempfile
from pathlib import Path
from pathlib import Path as _Path

if str(_Path(__file__).resolve().parent) not in _sys.path: _sys.path.insert(0, str(_Path(__file__).resolve().parent))
from paths import CACHE, DESKTOP_SHELL, DIST, PRODUCT, PYINSTALLER
from paths import DEV as ROOT

if str(ROOT) not in sys.path: sys.path.insert(0, str(ROOT))

# Everything in memora/ ships. The set is discovered from the source tree rather than listed, so a
# module added tomorrow is packaged without editing this file; EXCLUDED stays as an empty set purely
# so the manifest and the packaging contract tests keep a single well-named source of truth.
MODULES = {path.stem for path in (ROOT / 'memora').glob('*.py')}
EXCLUDED = set()
# Top-level files under memora/static/ that ship, discovered rather than listed. This was a
# hand-written set of four names and dag-embed.js was silently left out of the bundle: the workbench
# HTML loaded /dag-embed.js, the ASSETS route existed, but the file was not in the frozen build, so
# the embedded canvas would have 404'd only in the packaged app. Directory copies (brain/, dag/)
# were already discovered; the loose files were not.
STATIC = sorted(path.name for path in (ROOT / 'memora/static').glob('*') if path.is_file())
# Subdirectories of memora/static/ that ship, also discovered: a new brain view must ship by
# existing in the source tree.
STATIC_DIRS = sorted(path.name for path in (ROOT / 'memora/static').glob('*') if path.is_dir())
# Modules that must be forced into the frozen PYZ with --hidden-import, independent of whether the
# entry point's import graph reaches them. Staging a module is necessary but not sufficient:
# PyInstaller collects only what is reachable from the entry point, so a module reached through a
# late import is staged, never collected, and fails only when the feature is first used in the
# packaged build (verified once: memora.docindex was absent from PYZ-00.toc while present on disk).
# Kept as a named constant so packaging tests can assert the contract instead of slicing this file's
# source text.
# memora.brain_preview is imported lazily inside a request handler, exactly like docindex, so
# it must be forced or the packaged app raises ImportError the first time the brain view runs.
FORCED_HIDDEN_IMPORTS = ('memora_native', 'memora.docindex', 'memora.brain_preview')
GUIDES = ('Minimal-Architecture.svg', 'Minimal-Architecture.svg.html', 'REFACTOR-1.0.2.md',
          'VALIDATION-1.0.2.md', 'REFERENCES.md', 'OPEN_SOURCE_REUSE.md', 'DEPENDENCIES.md',
          'ARCHITECTURE-1.1.0.svg', 'ARCHITECTURE-1.1.0.svg.html', 'IMPLEMENTATION-1.1.0.md', 'OPERATIONS-1.1.0.md', 'VALIDATION-1.1.0.md', 'DELIVERY-1.1.0.md', 'DESKTOP-STARTUP-FIX-1.1.0.md',
          'DESENSITIZATION-AUDIT-1.3.0.md')


def run(args, cwd=ROOT, env=None):
    subprocess.run(args, cwd=cwd, env=env, check=True)


def copy_guides(backend):
    """Ship the whole documentation set, not a hand-picked subset.

    A full build means the packaged copy answers the same questions as the source tree; the GUIDES
    tuple is kept for the files that were historically bundled and is now redundant, so the copy is
    a directory copy and can never silently drop a new document.
    """
    target = backend / 'docs'
    if target.exists(): shutil.rmtree(target)
    shutil.copytree(ROOT / 'docs', target)


def flatten_product():
    """Move electron-builder's <output>/win-unpacked/* up into the product root.

    electron-builder can only emit a directory build into win-unpacked/, so the product would
    otherwise be desktop-standalone/win-unpacked/Memora.exe. The contract for this repository is
    that desktop-standalone/ IS the application directory: one Memora.exe, one resources/, one
    data/. Nesting it means every consumer has to remember an extra path component, and the two
    real failures this tree already had (three indistinguishable copies of the same application,
    no obvious executable) both came from exactly that.
    """
    PRODUCT.mkdir(parents=True, exist_ok=True)
    inner = PRODUCT / 'win-unpacked'
    if not inner.is_dir():
        raise SystemExit('electron-builder did not produce %s; inspect the npm run pack output' % inner)
    for child in sorted(inner.iterdir()):
        target = PRODUCT / child.name
        if target.exists():
            # A stale copy from a previous build is not a merge candidate.
            if target.is_dir(): shutil.rmtree(target)
            else: target.unlink()
        shutil.move(str(child), str(target))
    inner.rmdir()
    # electron-builder also drops these at the OUTPUT root, not inside win-unpacked; they describe
    # the packer run, not the application, and must not ship.
    for name in ('builder-debug.yml', 'builder-effective-config.yaml', 'builder-debug.txt'):
        stray = PRODUCT / name
        if stray.exists(): stray.unlink()
    return PRODUCT


def main(argv=None):
    parser = argparse.ArgumentParser(description='Build inside the development tree by default; standalone updates require explicit authorization.')
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--backend-only', action='store_true', help='Build dist/memora-backend only (the safe default)')
    mode.add_argument('--allow-standalone-update', action='store_true',
                      help='Only after user authorization: also update the sibling standalone product')
    options = parser.parse_args(argv)
    if sys.platform != 'win32': raise SystemExit('This recipe builds Windows x64; source/Web supports other platforms.')
    from windows_integrity import inspect_program_labels, integrity_level
    if integrity_level(sys.executable) < 8192:
        raise SystemExit('The build Python launcher has Low integrity. Run tools/Build-Desktop.ps1 from a normal Windows session first.')
    import memora_native
    from memora import __version__
    if not all(hasattr(memora_native, api) for api in ('topk', 'rrf')): raise SystemExit('Install the Rust topk/RRF kernel from ./native first')
    PYINSTALLER.mkdir(parents=True, exist_ok=True)
    DIST.mkdir(parents=True, exist_ok=True)
    # A fresh allowlisted staging tree prevents stale expanded components re-entering a build.
    with tempfile.TemporaryDirectory(prefix='focused-', dir=PYINSTALLER) as tmp:
        staging = Path(tmp)
        for name in MODULES:
            dest = staging / 'memora' / (name + '.py')
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / 'memora' / dest.name, dest)
        assets = staging / 'memora/static'
        assets.mkdir(parents=True)
        for name in STATIC: shutil.copyfile(ROOT / 'memora/static' / name, assets / name)
        # Directory copy, not a file list: a new brain or dag asset must ship by existing in the
        # source tree, so a feature cannot pass in development and then be missing from the bundle.
        for name in STATIC_DIRS: shutil.copytree(ROOT / 'memora/static' / name, assets / name)
        entry = staging / 'entry.py'
        entry.write_text('import multiprocessing\nif __name__=="__main__":\n    multiprocessing.freeze_support()\n    from memora.__main__ import main\n    main()\n', 'utf-8')
        env = dict(os.environ, PYTHONPATH=str(staging), PYTHONHASHSEED='0')
        args = [sys.executable, '-m', 'PyInstaller', '--noconfirm', '--clean', '--onedir', '--name', 'memora-backend',
                '--distpath', str(DIST), '--workpath', str(PYINSTALLER / 'work'),
                '--specpath', str(PYINSTALLER), '--paths', str(staging),
                '--add-data', str(assets) + os.pathsep + 'memora/static', '--copy-metadata', 'mcp',
                '--collect-submodules', 'mcp.server.fastmcp', '--collect-submodules', 'mcp.shared',
                '--collect-submodules', 'uvicorn']
        # Forced inclusions (see FORCED_HIDDEN_IMPORTS): staging is not collecting.
        for name in FORCED_HIDDEN_IMPORTS:
            args += ['--hidden-import', name]
        # A full build must contain every module, not only the ones the entry point imports. Most of
        # memora/ (advanced CLI, agent runtime, local sources, evaluation, ops) is reached through
        # late imports, so PyInstaller's graph alone would leave them out of the frozen PYZ with no
        # error until the feature is used. Forcing them keeps the packaged surface equal to source.
        for name in sorted(MODULES):
            if name not in ('__init__', '__main__'): args += ['--hidden-import', 'memora.' + name]
        # Only genuine environment gaps are excluded: no wheel for these ships with this recipe, and
        # they are optional extras (pyproject [project.optional-dependencies]) rather than features.
        for name in ('tkinter', 'torch', 'transformers', 'sentence_transformers', 'llama_cpp'):
            args += ['--exclude-module', name]
        run([*args, str(entry)], staging, env)
    backend = DIST / 'memora-backend'
    for name in ('LICENSE', 'NOTICE', 'README.md', 'README.zh-CN.md', 'CHANGELOG.md', 'PRIVACY.md', 'THIRD_PARTY_NOTICES.md', 'RELEASE_NOTES.en.md', 'RELEASE_NOTES.zh-CN.md'):
        shutil.copyfile(ROOT / name, backend / name)
    shutil.copytree(ROOT / 'LICENSES', backend / 'LICENSES', dirs_exist_ok=True)
    notices = backend / 'LICENSES/graphs'
    notices.mkdir(parents=True, exist_ok=True)
    for vendor in ('dictionary-graph', 'original-dev'):
        shutil.copyfile(ROOT / 'frontend/vendor' / vendor / 'LICENSE', notices / (vendor + '-MIT.txt'))
    shutil.copytree(ROOT / 'frontend/vendor/original-dev/licenses', notices / 'inherited', dirs_exist_ok=True)
    copy_guides(backend)
    manifest = {'name': 'memora', 'version': __version__, 'profile': 'single', 'modules': sorted(MODULES),
                'excluded_extended_modules': sorted(EXCLUDED), 'features': ['mcp-stdio-http', 'vector-retrieval', 'classification', 'markdown', '2d-3d-brain', 'durable-accumulation', 'model-workflows'],
                'bundled_user_data': False, 'native_module': 'memora_native', 'native_version': memora_native.__version__}
    (backend / 'BUILD_MANIFEST.json').write_text(json.dumps(manifest, indent=2), 'utf-8')
    if not options.allow_standalone_update:
        print('Built development backend only: ' + str(backend) + '. Standalone was not updated.')
        return
    if not (DESKTOP_SHELL / 'node_modules/electron-builder').exists():
        run(['npm.cmd', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], DESKTOP_SHELL)
    run([sys.executable, str(ROOT / 'tools/fetch_electron.py')])
    # electron-builder caches its signing helper under %LOCALAPPDATA%. That directory is not
    # writable from every execution context (it fails with `mkdir ...\winCodeSign: Access is
    # denied`, which surfaces only as ERR_ELECTRON_BUILDER_CANNOT_EXECUTE after four retries), and
    # the helper is what rewrites the EXE resources. Point the cache at a directory this process
    # owns instead of disabling signing: an unrewritten EXE is Electron's own binary and cannot
    # bind resources/app.asar.
    builder_cache = CACHE / 'electron-builder'
    builder_cache.mkdir(parents=True, exist_ok=True)
    run(['npm.cmd', 'run', 'pack'], DESKTOP_SHELL, dict(os.environ, ELECTRON_BUILDER_CACHE=str(builder_cache)))
    # electron-builder writes <output>/win-unpacked/. The product directory must be the application
    # root directly: "unzip the release and double-click Memora.exe" has to be literally true, and a
    # second copy of the same app nested one level down is exactly what made the previous tree
    # impossible to navigate. Flatten it here so every downstream tool has ONE product path.
    desktop = flatten_product()
    for name in ('Launch-Memora.cmd', 'Launch-Memora.ps1', 'Repair-Desktop.cmd', 'Repair-Desktop.ps1'):
        shutil.copyfile(DESKTOP_SHELL / name, desktop / name)
    shutil.copyfile(ROOT / 'RELEASE_NOTES.zh-CN.md', desktop / '使用说明.md')
    shutil.copyfile(ROOT / 'RELEASE_NOTES.en.md', desktop / 'DESKTOP_GUIDE.md')
    # The portable data folder is part of the artifact, not a packaging afterthought: a fresh copy
    # must start with working schema and an empty document store. tools/release.py re-validates it
    # (and refuses to zip a data/ that contains user state) before every package.
    from release import stage_data  # noqa: E402 - sibling module imported after ROOT is known
    # stage_data() returns the DIRECTORY it built (see release.py), not a list of names: the caller
    # substitutes it into the copy that becomes the ZIP. Iterating it here raised
    # "TypeError: can only join an iterable" -- i.e. every desktop build after that change died
    # *after* flattening the product, leaving a half-finished standalone directory. Print the names
    # of what it staged instead, and only after the build itself succeeded.
    staged = stage_data()
    print('staged data/: ' + ', '.join(sorted(p.name for p in staged.iterdir())))
    powershell = Path(os.environ['SystemRoot']) / 'System32/WindowsPowerShell/v1.0/powershell.exe'
    run([str(powershell), '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
         str(desktop / 'Repair-Desktop.ps1')])
    print(inspect_program_labels(desktop))
    print('Built desktop-standalone/Memora.exe — one application, with Markdown and brain views.')


if __name__ == '__main__': main()
