# Quality gates

Everything on this page runs on a fresh checkout with no network and no model configured. The three
gates are **lint**, **types** and **tests**, and all three are executed by CI on every push, so a
local failure and a red build are the same thing.

The rule this page exists to enforce: **a gate you cannot run is not a gate.** Until 1.3.0 this
repository carried a ruff section that described itself as "configured here but not installed", and
an ignore rule for a `.mypy_cache/` that no tool ever created. Neither had ever been executed. The
first real run reported 4140 violations.

---

## 1. Set up once

```bash
# from the repository root
.venv/Scripts/python.exe -m pip install -r requirements.txt -r requirements-dev.txt
```

`requirements.txt` is the runtime dependency set (the application will not import without it).
`requirements-dev.txt` is ruff and mypy only -- linting and type checking source, never shipped
inside the product or the frozen desktop bundle. Both are pinned exactly, because ruff adds lint
rules between releases and an unpinned linter turns "the tree is clean" into a claim about the day
somebody happened to run it.

### Node is required for the full test suite

The static UI tests execute the real shipped JavaScript through node. Without node on `PATH` they do
not fail -- they **skip**, quietly. Measured on this tree, same commit, only `PATH` differing:

| node on `PATH` | Result |
|---|---|
| yes | `Ran 560 tests` -- `OK (skipped=5)` (7 without a build; see section 4) |
| no | `Ran 549 tests` -- `OK` with 95 skips |

A green run without node collects **11 fewer tests** and skips **90 more** than one with it, and
nothing in the summary line says so beyond a skip count nobody baseline-reads. That is why the steps
below put node on `PATH` and why CI asserts `node --version` as its own step.

On Windows, in Git Bash:

```bash
export PATH="/c/Program Files/nodejs:/c/Windows/System32:/c/Windows:$PATH"
export TEMP=<project root>/runtime/tmp
export TMP=$TEMP
```

CI installs node (v20) before the suite for exactly this reason, and asserts `node --version` in a
dedicated step so a missing node fails the job instead of shrinking it.

A short ASCII `TEMP` is worth setting locally too: several tests create scratch databases and temp
profiles, and a long or non-ASCII temp path produces Windows path-length failures that look like
product defects.

---

## 2. Lint: `ruff check .`

```bash
.venv/Scripts/python.exe -m ruff check .        # add --fix for the auto-fixable ones
```

Expected output on a clean tree:

```
All checks passed!
```

> The tree is clean as of 1.3.0. An earlier revision of this page carried a "known exception" for
> `tests/test_http_transport.py` (two unused imports). That has been fixed and the note was removed
> rather than left to rot: a documented exception is a licence for the exception to stay.

### What it checks

`select = ["E4", "E7", "E9", "F", "W", "I"]` -- real defects (pyflakes: undefined names, unused
imports, shadowed redefinitions), syntax errors (`E9`), a small pycodestyle subset, trailing
whitespace, and import hygiene (`I`). Nothing here is a style preference the tree does not already
satisfy.

### What is switched off, and the measurement behind it

| Rule | Hits (approx.) | Why it stays off |
|---|---|---|
| `E501` line-too-long | 918 | The code is written in long single-purpose lines on purpose. Reflowing ~900 lines buries the change the config exists to catch. `line-length = 120` is still configured so editors and formatters agree. |
| `E701` multiple-statements (colon) | 1176 | `if x: return y` is the established house style across the repository. |
| `E702` multiple-statements (semicolon) | 626 | Same decision, other form. |

These numbers are measured, not remembered -- and they are **approximate on purpose**, because they
grow every time somebody writes an ordinary line of this codebase. Re-measure rather than editing a
stale figure by hand:

```bash
.venv/Scripts/python.exe -m ruff check . --select E501,E701,E702 --statistics
```

The previous config claimed `E501` had 3847 hits. A fresh run reported roughly a quarter of that,
which is what a number nobody re-ran looks like.

### Excluded directories

Every entry is machine output or another language, never hand-written Python:

| Path | What it is |
|---|---|
| `pyinstaller/` | PyInstaller work directory. `focused-*/` contains a **whole earlier copy of the package**, so every `memora/` violation used to be counted twice. |
| `archive/` | Frozen pre-1.0.2 source snapshots, kept for reference, never imported. |
| `dist/`, `build/` | Build output. `dist/memora-backend` ships an entire CPython runtime. |
| `runtime/`, `artifacts/`, `cache/`, `datasets/`, `preview-data/`, `reports/` | Logs, screenshots, SQLite databases, build caches, and one-off investigation scripts under `reports/refactor/` that still point at a pre-move absolute root. |
| `desktop/`, `frontend/` | Node and TypeScript trees. Ruff is a Python linter and there is not one `.py` file under either. Their gate is `tsc --noEmit`, run separately in CI. |
| `native/` | The Rust extension, plus its `target/` directory. |
| `bench/` | Measurement scripts, deliberately not held to the application standard. |

### The two per-file exceptions

`memora/gateway.py` and `memory_merge/web.py` each have one un-sorted import block, exempted by
name in `[tool.ruff.lint.per-file-ignores]`. Both are owned elsewhere. Naming them individually
rather than excluding a directory keeps a future unsorted import elsewhere in `memora/` visible.

---

## 3. Types: `mypy`

```bash
.venv/Scripts/python.exe -m mypy
```

Expected output on a clean tree:

```
Success: no issues found in 66 source files
```

### Scope, and why it is not wider

The scope is the packages that actually ship: `files = ["memora", "memory_merge"]`. `tools/` and
`tests/` are one-off scripts and test doubles that mutate dictionaries freely.

This codebase annotates almost nothing -- `def f(x)`, not `def f(x: int)`. A strict profile
(`disallow_untyped_defs` and friends) would emit thousands of notes about code nobody is going to
annotate this week, and a type checker that is red on arrival gets switched off within a day. The
settings instead target the class of defect that untyped code genuinely produces:

- `ignore_missing_imports = true` -- `memora_native` (compiled from `./native`), `llama_cpp`,
  `pypdf` and `sentence-transformers` are optional and absent from a bare venv.
- `no_implicit_optional = true`, `warn_redundant_casts = true`, `warn_unused_configs = true`.
- `check_untyped_defs = false` -- bodies of unannotated functions are not checked yet.

To widen the net, add paths to `files` in `pyproject.toml`. To tighten the strictness, flip one
setting at a time and fix what it reports; the current profile is the one that reports zero errors,
so any tightening is measured against a green baseline.

---

## 4. Tests: the full suite

```bash
.venv/Scripts/python.exe -m unittest discover -s tests -t . -v
```

The `-t .` matters: it sets the top-level directory so `tests` is imported as a package
(`tests.helpers` and friends need that), and it is what CI runs.

### Current baseline

```
Ran 560 tests in 119.970s

OK (skipped=5)
```

**0 failures, 0 errors.** The skip count is **5 with a build present and 7 without one**, and that
difference is the point rather than an inconsistency — the two BUNDLE tests (section 7) run when
`dist/memora-backend` exists and skip when it does not. Quoting a single number without saying which
state it was measured in is how a "7 skips" baseline becomes wrong the first time somebody builds.

| Count | Skip reason | Why it is expected |
|---|---|---|
| 4 | `no DSH profile at <DSH install dir>` | These tests assert on a *deployed* DSH profile. The file exists only on a machine where Memora has been installed into a DSH host. Everything they check about the renderer itself is covered by the non-skipped tests in the same module. |
| 2 | `no build at dist/memora-backend; run tools/build_desktop.py first` | These compare the frozen bundle byte-for-byte against the source. They cannot run before a build exists, and they must not silently pass without one. The path used to be spelled `build/dist/...` and never existed, so both tests skipped *forever*; see section 7. **These are the two that appear only when there is no build.** |
| 1 | `pypdf not installed (optional extra)` | PDF import is an optional extra (`pip install .[pdf]`). The non-PDF ingest path is covered by the tests that do run. |

If the skip count moves, treat it as a change in coverage and find out which one moved. A skip that
appears on a machine with node installed is a real signal.

### Node changes the test COUNT, not just the skip count

Measured on this tree, same commit, only `PATH` differing:

| node on `PATH` | Result |
|---|---|
| yes | `Ran 560 tests` — `OK (skipped=5)` |
| no | `Ran 549 tests` — `OK` with 95 skips |

Without node, **11 tests are not collected at all** and 90 more skip with
`node is required to execute memory.js`. Nothing in the summary line says so beyond a skip count
nobody baseline-reads. Both runs are "green".

### The failure this baseline replaced

`test_preferred_plugin_is_probed_first` asserted that this machine had a plugin named in
`LLM_PLUGIN_ORDER` installed under `<plugin dir>`. Exactly one plugin here vendors
`dsh-llm` -- `knowledge-process-suite` -- and it is not the preferred name, so the test failed
while the ordering logic it existed to verify was correct. It reported the machine, not the code.

It now builds a synthetic plugin tree in a tmpdir (`dsh-aaa-unpreferred`, `dsh-mnemon`,
`dsh-zzz-unpreferred`) and asserts the ordering property directly: alphabetically-first and
alphabetically-last both lose, so the winner can only come from `LLM_PLUGIN_ORDER`. Two companion
tests pin the fallback order and the missing-root degradation. Nothing is swallowed and no assertion
was deleted; the environment-dependent half became a `skipTest` with a reason, and the
environment-independent half became a real test.

### `MEMORA_DSH_PLUGIN_ROOT`

`tools/dsh_profile.py` probes for a vendored `@deepseek-ai/dsh-llm` under `PLUGIN_ROOT`, which
defaults to `<plugin dir>` -- one machine's layout. Override it when the plugins live
elsewhere:

```bash
export MEMORA_DSH_PLUGIN_ROOT=/path/to/installed/plugins
```

When that root does not exist the probe now says so explicitly and names the variable, instead of
reporting a missing plugin for what is actually a wrong directory.

---

## 5. CI

`.github/workflows/ci.yml` runs five jobs:

| Job | Runner | What it proves |
|---|---|---|
| `lint` | ubuntu | `ruff check .`, `mypy`, and `tsc --noEmit` for the frontend. Tools come from `requirements-dev.txt`, so CI and a developer agree on the violation count. |
| `test` | ubuntu / windows / macos x py3.11 / 3.12 / 3.13 | The full unittest suite **with node installed first** and `node --version` asserted as its own step. |
| `native` | ubuntu / windows / macos | Builds the Rust kernel, then runs the equivalence, service and PDF tests plus a benchmark smoke run. |
| `package` | ubuntu | Builds a wheel, installs it into a clean venv, and runs three CLI commands from it. |
| `docker` | ubuntu | Builds the image and runs `memora health` inside the container. |

The `lint` job deliberately installs the **pinned** tools rather than `pip install ruff`. An
unpinned linter means CI can go red on a day nobody changed anything, which trains people to ignore
the job.

The `test` job installs node **before** running the suite and asserts it is on `PATH`. Without
that step the 85 static UI tests skip instead of failing, and a job that covers less than it appears
to is worse than a job that fails.

---

## 6. Reproducing the numbers on this page

```bash
export PATH="/c/Program Files/nodejs:/c/Windows/System32:/c/Windows:$PATH"
export TEMP=<project root>/runtime/tmp; export TMP=$TEMP

.venv/Scripts/python.exe -m ruff check .          # All checks passed!
.venv/Scripts/python.exe -m mypy                  # Success: no issues found in 66 source files
.venv/Scripts/python.exe -m unittest discover -s tests -t . -v   # OK (skipped=5, or 7 without a build)
```

The skip count depends on whether `dist/memora-backend` exists -- see section 7.

---

## 7. Verifying the packaged product

The suite has three layers of packaging tests, split by what genuinely needs a build
(`tests/test_packaged_assets.py`). Knowing which layer you are running is the difference between a
gate and a decoration.

| Layer | Needs a build | What it proves |
|---|---|---|
| `ManifestTests` | **no** | `tools/build_desktop.py`'s module list and static-asset manifests cover the source tree. This is the gate. |
| `SourceTests` | **no** | The source tree really contains the files and endpoints the manifests claim to ship. |
| `BuiltBundleTests` | **yes** | The frozen bundle contains the canvas files byte-for-byte and its `BUILD_MANIFEST.json` lists `docindex`. These are post-build spot checks, not the gate. |

### The BUNDLE tests need a build, and the path was wrong

`BuiltBundleTests` compares `dist/memora-backend/_internal/memora/static/dag/` against
`memora/static/dag/`. If the bundle is absent every test in the class calls `skipTest` with
`no build at <BUNDLE>; run tools/build_desktop.py first`.

**This is the defect that made the guard useless.** `BUNDLE` and `PRODUCT` were once spelled
`build/dist/memora-backend` and `desktop-standalone` -- both *inside* the repository, both obsolete
since the tree was flattened. Nothing failed: the directories simply never existed, so both BUNDLE
tests skipped **forever** while the suite reported green. A packaging guard that can only skip is not
a guard. They are now derived from the real layout:

```text
BUNDLE  = <repo>/dist/memora-backend
PRODUCT = <repo>/../memora-desktop-standalone
```

To run them:

```bash
.venv/Scripts/python tools/build_desktop.py        # produces dist/memora-backend/
.venv/Scripts/python -m unittest tests.test_packaged_assets -v
```

### Do not build while the suite is running

The BUNDLE tests read `dist/memora-backend` while it exists. Running `tools/build_desktop.py`
concurrently rewrites that directory underneath them, and the suite reports a byte-comparison failure
("app.js shipped changed") that reflects the build, not the code. Measured once on this tree; the
failure disappeared on re-run with no source change. Build, *then* test.

### Verifying the product directory

`MANIFEST.json` inside the bundle records the shipped version and module list:

```bash
.venv/Scripts/python -c "import json;print(json.load(open('dist/memora-backend/BUILD_MANIFEST.json'))['version'])"
```

For the end-to-end smoke check, `tools/smoke_desktop.py` drives the packaged shell and writes
`reports/SMOKE_VALIDATION.json`. It requires a build and an already-working desktop environment; it
is a post-packaging acceptance check, not part of the unit suite.

