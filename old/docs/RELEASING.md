# Releasing Memora

This document replaces the pre-1.2.0 version, which described `memory_merge/__init__.py` as the
version source and a `tools/release.py` that collected files by allowlist and ran a second test pass
from the unpacked tree. Neither is true any more: the version lives in `memora/__init__.py`, and
`tools/release.py` now validates a smoke report and zips the built desktop tree.

Everything below was checked against this working tree. Section 7 states, command by command, what
was executed and what was only read.

**Paths below are relative to this repository unless they are described as siblings of it.** The
repository root IS the source tree (it used to be a `devel/` subdirectory, which a later refactor
flattened away). The packaged application and the install packages are siblings of the repository,
not children of it; see [DIRECTORY-LAYOUT.md](DIRECTORY-LAYOUT.md) for the one-page version.

## 1. Version-control state at `v1.2.0`

The repository has **no remote**. It was created locally, and at the time of tagging it had never
been pushed anywhere and `v1.2.0` is its **first tag**.

| Fact | Value |
| --- | --- |
| Branch | `main` |
| Commits reachable from the tag | 19 |
| First commit | `f68d32d` — "baseline: memora 1.1.0 before DAG + UI + connector work" (2026-10-16) |
| Release commit (tag target) | `960acf8` — "docs: extract the eleven-source memory taxonomy from the unreachable agent-next.js" (2026-10-17) |
| Tag | `v1.2.0`, **annotated** object, not a lightweight ref |
| Working tree | clean at the moment of tagging |
| Tracked files | 443 |
| Remotes | none — `git remote -v` prints nothing |

The tree is clean because everything the build and the runtime generate is ignored (section 2). A
clean `git status` therefore means "no source edits pending", not "nothing was built".

## 2. What is tracked and what is not

`.gitignore` lives at the repository root and is therefore relative to it. The packaged
application at `<project>/memora-desktop-standalone/` and the install packages at
`<project>/memora-release/` are outside this repository. The build tree (`dist/`,
`pyinstaller/`), the download cache (`cache/`), the live memory store (`data/`) and the
interpreter (`.venv/`) are inside it but ignored.

| Path (relative to the repository root) | Why |
| --- | --- |
| `runtime/` | local runtime state and the `runtime/tmp` scratch directory |
| `artifacts/` | intermediate validation output (screenshots, historical snapshots) |
| `.venv/`, `__pycache__/`, `*.egg-info/` | interpreter and build by-products |
| `pip-*` | orphaned pip build temp directories from interrupted installs |
| `native/target/`, `*.pyd`, `*.so` | compiled Rust kernel output |
| `frontend/node_modules/`, `desktop/node_modules/` | installed npm dependencies |
| `*.sqlite3`, `*.db`, `*.log`, `*.key`, `*.pem`, `.env*` | defensive: user data and credentials must never be committed |
| `bench/results/`, `frontend/vendor/*/data/` | reproducible outputs and vendored data |

The live memory database is `data/` at the repository root. It is gitignored because it holds
private memories and a saved API key in clear text. Backups of it belong in `data/backups/`.

**The deliverable ZIP is not tracked.** This is intentional and consistent: `release/` is outside
the repository, every release ZIP is reproducible from a tagged commit via the build, and a binary
blob inside git would only grow history. It also means a `git archive` of the tag does **not**
contain the desktop build — that must be produced with section 4.

## 3. Cutting a version

The version number exists in exactly one place: `memora/__init__.py` (`__version__ = "1.2.0"`).
`pyproject.toml` reads it via `attr`, so it must not be edited there. The git tag is `v` + that
string.

1. **Bump the version.** Edit `__version__` in `memora/__init__.py`. Nothing else hard-codes it.
2. **Write the CHANGELOG entry.** Add a `## <version> — <date>` section at the top of
   `CHANGELOG.md`. Describe what actually changed and, in a "Not included" line, what deliberately
   did not. Do not restructure the older sections.
3. **Run the suite.** From the project root:

   ```powershell
   $env:TEMP = '<project root>/runtime/tmp'
   $env:TMP  = $env:TEMP
   .venv\Scripts\python.exe -m unittest discover -s tests
   ```

   The `runtime/tmp` redirect matters: several tests create and migrate SQLite databases, and
   pointing them at a scratch directory inside the project keeps the system temp dir clean and keeps
   the paths short enough for Windows. At `v1.2.0` this reports `Ran 305 tests` / `OK (skipped=1)`.
   The one skip is a test that needs a real frozen build to inspect; it skips rather than pretending
   to pass.
4. **Build.** Use the launcher, never the spec (section 5a):

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File tools\Build-Desktop.ps1
   ```

   The launcher sets the build interpreter to Medium integrity, pins `TEMP`/`TMP` to
   `runtime\tmp`, and runs `tools/build_desktop.py`. It refuses to run if `.venv\Scripts\python.exe`
   is missing or is a reparse point.
5. **Package the ZIP** (optional but this is what gets attached to a release):

   ```powershell
   .venv\Scripts\python.exe tools\release.py
   ```

   `tools/release.py` refuses to package unless `build/reports/SMOKE_VALIDATION.json` matches the current
   `__version__`, the backend SHA-256, and the desktop tree hash. Pass `--skip-build` to reuse an
   existing build.
6. **Commit**, then tag the release commit:

   ```powershell
   git tag -a v1.2.0 -m "<summary of the release>"
   git tag -n
   ```

   Always `-a`. A lightweight tag carries no tagger, no date and no message, and cannot be described
   later. Verify with `git cat-file -p v1.2.0` — the object must say `type tag` and contain a
   `tagger` line.

## 4. What the build produces and where

`tools/build_desktop.py` is a Windows x64 recipe; it exits immediately on any other platform.
Build intermediates go under `<project>/build/`, the application goes to
`<project>/desktop-standalone/`, and packages go to `<project>/release/`. All of them are siblings
of this repository, not children of it.

| Output | Path | Produced by |
| --- | --- | --- |
| Frozen backend (one directory) | `build/dist/memora-backend/` | PyInstaller, driven by `build_desktop.py` |
| Backend manifest | `build/dist/memora-backend/BUILD_MANIFEST.json` | `build_desktop.py` |
| Electron application | `../memora-desktop-standalone/Memora.exe` | `npm run pack` in `desktop/` |
| Distribution ZIP | `release/memora-<version>-windows-x64.zip` + `.sha256` | `tools/release.py` |
| Delivery record | `release/BUILD_DELIVERY.json` | `tools/release.py` |
| Smoke report | `build/reports/SMOKE_VALIDATION.json` | `tools/smoke_desktop.py` |
| Template data folder | `desktop-standalone/data/` | `tools/release.py::stage_data` |

`desktop-standalone/` **is** the application directory: `Memora.exe`, `resources/`, `data/` and
`locales/` sit directly in it. `electron-builder` can only emit a directory build into
`win-unpacked/`, so `build_desktop.py::flatten_product()` moves the contents up one level after
packing and deletes the packer's own `builder-debug.yml`. That flattening is load-bearing: without
it the tree grows a second nested copy of the same application, which is how this project ended up
with three indistinguishable builds and no obvious executable.

`BUILD_MANIFEST.json` is the fastest way to confirm a build matches the source: its `version` field
must equal `memora.__version__` and its `modules` list must be the staged module set.

## 5. The two traps that have actually bitten this project

### (a) `tools/build_desktop.py` is the only correct entry point — the spec is a build artifact

`build_desktop.py` stages a throwaway tree and then lets PyInstaller write the spec into it:

```python
# tools/build_desktop.py - the staging directory is a temporary one, removed on exit
with tempfile.TemporaryDirectory(prefix='focused-', dir=BUILD / 'pyinstaller') as tmp:

# PyInstaller is told to write the spec into build/pyinstaller and to --clean
args = [sys.executable, '-m', 'PyInstaller', '--noconfirm', '--clean', '--onedir', '--name', 'memora-backend',
        '--distpath', str(BUILD / 'dist'), '--workpath', str(BUILD / 'pyinstaller/work'),
        '--specpath', str(BUILD / 'pyinstaller'), '--paths', str(staging),
```

The generated `build/pyinstaller/memora-backend.spec` then **bakes that temporary path into itself**:

```python
# build/pyinstaller/memora-backend.spec:5
datas = [('<project root>/build/pyinstaller/focused-sap8ng09/memora/static', 'memora/static')]

# build/pyinstaller/memora-backend.spec:14-15
    ['<project root>/build/pyinstaller/focused-sap8ng09/entry.py'],
    pathex=['<project root>/build/pyinstaller/focused-sap8ng09'],
```

`focused-sap8ng09` is one random temporary directory name from one past run. It no longer exists, so
running `pyinstaller build/pyinstaller/memora-backend.spec` — or anything else that consumes the spec
— fails on a missing input. And the next `build_desktop.py` run deletes and recreates it anyway,
because the staging tree is a `TemporaryDirectory` and PyInstaller is invoked with `--clean`. The
spec is a **generated file**, not configuration: it is never tracked (`build/` is outside the
repository) and must never be edited by hand or used to start a build.

Use `tools\Build-Desktop.ps1` or `python tools/build_desktop.py`. Both regenerate everything.

### (b) A new module or a new `static/` subdirectory is not shipped by adding it to a list

PyInstaller collects **only what is reachable from the entry point**, plus whatever is force-included.
Staging a file is necessary but not sufficient. Both halves of this have already failed once, which
is why 1.2.0 exists at all — the DAG canvas and the document index worked in the source tree all day
and 404'd in the frozen bundle.

**New Python module.** It must be in `MODULES` *and*, if nothing imports it, listed in
`FORCED_HIDDEN_IMPORTS`:

```python
# tools/build_desktop.py - staged into the bundle (discovered from memora/*.py, so a new module is
# staged automatically)
MODULES = {path.stem for path in (ROOT / 'memora').glob('*.py')}

# tools/build_desktop.py - force-included, because no module imports docindex yet
FORCED_HIDDEN_IMPORTS = ('memora_native', 'memora.docindex')
```

The comment above that constant records the measurement rather than the theory: with `docindex` in
`MODULES` but no `--hidden-import`, `memora.docindex` was absent from the frozen `PYZ-00.toc`.
`--hidden-import` is the same mechanism already used for `memora_native`

(`build_desktop.py:66`).

**New `memora/static/` subdirectory.** Individual files are listed in `STATIC`, but subdirectories
are copied wholesale so that a new asset ships by merely existing:

```python
# tools/build_desktop.py:54, 57 - directory copies, not file lists
shutil.copytree(ROOT / 'memora/static/brain', assets / 'brain')
shutil.copytree(ROOT / 'memora/static/dag', assets / 'dag')
```

So: adding a **file** to an existing static directory needs nothing; adding a **new subdirectory**
needs a `copytree` line, and shipping it to the browser also needs a route in `memora/workbench.py`
`ASSETS` (routing is exact-match in `memora/web.py`, so `/dag` and `/dag/` are separate entries).

`tests/test_packaged_assets.py` now fails the build if a static subdirectory is copied by hand-picked
filenames, if a non-dunder module is in neither `MODULES` nor `EXCLUDED`, or if `docindex` loses its
`--hidden-import`. It runs without a build; the parts that need a real frozen bundle skip instead of
faking a pass.

## 6. CI has never run

`.github/workflows/ci.yml` defines five jobs — `test` (3 OSes x Python 3.11/3.12/3.13), `native`
(Rust kernel build + benchmark smoke), `package` (wheel build, clean-venv install, CLI smoke),
`docker` (image build + container smoke), and `lint` (ruff plus a TypeScript check).

**None of these has ever executed.** There is no remote, so no push event has ever fired
`on: push` / `on: pull_request`, and nothing has ever been reported against this workflow. No result
from it exists, good or bad, and this document makes no claim about whether it would pass. Treat the
suite that has actually been run — section 3 step 3, 305 tests locally — as the only evidence.

What it would take to make CI meaningful:

1. Create a remote (e.g. an empty GitHub repository) and add it: `git remote add origin <url>`.
2. Push `main` and the tag: `git push -u origin main` then `git push origin v1.2.0`.
3. Watch the first run and expect to *fix* things: the workflow has been reviewed but never
   exercised, so a first-run failure is the norm, not a regression. The `native` and `package` jobs
   assume a Rust toolchain and build dependencies that no one has yet proven available on the runners.

Until step 2 happens, the workflow is inert configuration. It is tracked in git, so it is versioned
with the code — it is simply not running.

## 7. Provenance of this document

Executed while writing it:

- `git status --porcelain`, `git status -sb`, `git log --oneline -5`, `git log --reverse`,
  `git rev-list --count HEAD`, `git for-each-ref`, `git reflog`, `git remote -v`, `git ls-files`,
  `git check-ignore -v build dist artifacts runtime`
- the full suite exactly as written in section 3 step 3 (305 tests, `OK (skipped=1)`)
- `git tag -a v1.2.0 ...`, `git tag -n`, `git cat-file -p v1.2.0`

Read but **not executed**, because this document was written without network access:

- `tools/build_desktop.py`, `tools/Build-Desktop.ps1`, `tools/release.py`, `build/memora-backend.spec`.
  Their behaviour above is quoted from their source, not from a build run. Confirm the staging-path
  claim yourself with `Test-Path build/focused-sap8ng09` (it is `False`) and by opening
  `build/memora-backend.spec` line 5.
