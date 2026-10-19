# Versioning and the two editions

Two copies of Memora exist on this machine, and they are different products:

| Directory | Edition id | What it is | Who it is for |
| --- | --- | --- | --- |
| `<项目根>` | `devel` | the development and test tree: source, tests, tooling, the build recipe | whoever is changing and reviewing the code |
| `<独立版目录>` | `standalone` | the packaged, unzip-and-run desktop application | the user |

They are independent: separate processes, separate ports, separate data directories. Neither is a
mode of the other, and nothing in the development tree is allowed to reach into the packaged
application's `data/`.

**This iteration does not produce a release package.** The deliverable is the development tree plus,
at the end of the review, a rebuilt desktop application. `memora-release/` is not touched.

## 1. The banner, and why it is not a constant

The top-left corner of the window shows the wordmark `memora`, and directly under it:

```
memora
<edition> · v<version>
```

where `<edition>` is `devel` or `standalone`. One line, one dot: amber for the working tree, green
for the copy the user runs.

The page does not decide that word. The page asks `GET /api/agent/status` and renders what the
backend reports, because the same `memory.html` / `memory.js` is served by both editions: a
hardcoded `devel` would keep claiming `devel` after packaging, which is exactly the confusion the
banner exists to remove.

`memora/core.py` decides it from how the interpreter was started, never from a path:

```python
def running_edition(frozen=None, env=None):
    frozen = bool(getattr(sys, 'frozen', False)) if frozen is None else bool(frozen)
    override = ... env['MEMORA_EDITION'] ...
    return 'standalone' if frozen else 'devel'
```

* `sys.frozen` is set by the PyInstaller bootloader, so a packaged backend reports `standalone`
  wherever the user copies it.
* Anything else - `python -m memora`, a test, a script importing the package - reports `devel`.
* `MEMORA_EDITION` is an **override**, not the primary signal. It exists so a frozen build can be
  labelled explicitly for an acceptance run; an unrecognised value is ignored rather than trusted,
  because a typo must not invent a third edition the stylesheet has no rule for.

`GET /api/agent/status` carries, next to the existing keys:

| Field | Example | Meaning |
| --- | --- | --- |
| `edition` | `"devel"` | the id above, decided by the running process |
| `edition_label` | `"开发测试版 devel"` | the same fact for prose (tooltips, logs); the banner itself shows the raw id |
| `version` | `"1.3.0"` | unchanged: `memora/__init__.py` `__version__` |
| `data_dir` | `<用户目录>\\memora\\data` | unchanged: which store this process opened |

No other key of `status()` changed. `tests/test_editions.py::test_the_existing_status_shape_is_unchanged`
pins that.

## 2. The version number

`memora/__init__.py` `__version__` is the single source of truth. `pyproject.toml` reads it through
`attr`; nothing else may hard-code it.

The packaged application copies that value into `resources/backend/BUILD_MANIFEST.json` at build
time. The banner prints the version the **backend** reports, so the manifest and the running build
must agree; `tests/test_editions.py` asserts the manifest equals `__version__` whenever a build
exists and skips when it does not (a missing build is not a version defect).

The standalone application currently installed was frozen from the same `1.3.0` source, but it
predates the `edition` field: its `/api/agent/status` has no `edition` key and its bundled page has
no banner yet. Rebuilding with `tools/build_desktop.py` refreshes the page assets and the backend
together; that is the step that makes the standalone copy show `standalone`.

Until that build happens, `tools/verify_editions.py` reports, in one run:

* `devel reports edition=devel` - PASS (the source backend answers over HTTP);
* `the code path a frozen build takes reports standalone` - **PASS, and labelled SIMULATED**: a child
  process runs with `sys.frozen = True`, which is what the PyInstaller bootloader sets, so the branch
  the packaged build executes is really exercised. This is evidence about the CODE, never about the
  shipped executable;
* `standalone reports edition=standalone` - **FAIL**: the installed executable genuinely does not
  report the field. That failure is the correct result and the record of what still has to happen.
  It is deliberately not softened into a skip, because "the packaged app has not been rebuilt" is a
  fact the release decision depends on.

The same split holds for the UI check: `artifacts/p5-editions/brand-standalone.png` shows the
packaged copy with no banner, which is true. After the rebuild, the same command must be re-run and
both editions must pass, including "the two editions render DIFFERENT, non-empty text".

## 3. Ports

| Purpose | Port | Where it is declared |
| --- | --- | --- |
| development workbench | `8765` | `tools/paths.py` `DEV_PORT`; `python -m memora serve` default |
| development MCP HTTP | `18184` | `tools/paths.py` `DEV_MCP_PORT`; `runtime_manager.py` passes `--mcp-port 18184` |
| packaged desktop application | `18765` | `tools/paths.py` `PRODUCT_PORT`; `desktop/main.cjs` default, overridable by `MEMORA_PORT` |

The three are distinct, and `python -m memora serve --port 0` asks the OS for a free port, which is
how the verification scripts run: they never bind a convention port, so they cannot fight a session
that is already open. `tests/test_editions.py` and `tools/verify_editions.py` both check the
convention ports come from `tools/paths.py` rather than from a literal repeated in a script.

Both editions can run at the same time: different processes, different ports, different `data/`.
That is the point of the split - the dev session can be open in a browser while the packaged
application is open next to it.

## 4. How the two are kept in sync

The development tree is where changes are made and reviewed; the packaged application is rebuilt
from it. The order is fixed, because the reverse (edit the packaged copy) leaves the repository
describing something nobody is running:

1. Change and review in `<项目根>`.
2. Run the suite: `.venv\Scripts\python.exe -m unittest discover -s tests`.
3. Rebuild the application with `tools/build_desktop.py` (never run it from an agent session; it is
   a release action). It stages `memora/static/*` into the frozen backend and copies the backend
   into `resources/backend/`.
4. Verify the shipped static assets are byte-identical to the source tree
   (`tests/test_packaged_assets.py` compares SHA-256 for the assets it inspects) and that the
   packaged backend answers `edition=standalone`
   (`.venv\Scripts\python.exe tools\verify_editions.py`).
5. Smoke the packaged application itself (`tools/smoke_desktop.py`).

A change is not "in the standalone copy" until steps 3-5 pass. A change is not "reviewed" because
the standalone copy works: the standalone copy is built from the development tree, never edited.

## 5. Verification

| Command | What it proves |
| --- | --- |
| `.venv\Scripts\python.exe tools\verify_editions.py --json reports/p5-editions.json` | starts the development backend and the packaged backend at the same time on OS-assigned ports; asserts `edition=devel` / `edition=standalone`, distinct PIDs, distinct ports, distinct `data_dir`, equal version; reports the convention ports with the PID that owns them, and stops both |
| `.venv\Scripts\python.exe -m unittest tests.test_editions -v` | the edition rule (frozen vs source vs override), the `status()` shape, and manifest/version agreement when a build exists |
| `desktop\node_modules\electron\dist\electron.exe tools\verify_edition_ui.cjs` | loads both editions in a hidden Electron window and reads the rendered DOM: the edition word under the wordmark, the `v<version>` line, the `data-edition` attribute, and the geometry (below the printed wordmark, inside the left sidebar). Writes `artifacts/p5-editions/*.png` |
| `node tools\verify_dsh_presence.mjs --intervals 2 --json artifacts/p1-presence/report.json` | drives the INSTALLED memory-connector with the INSTALLED profile's own config (parsed from the profile patch, so a stale script cannot pass) and proves the periodic heartbeat advances `peers.seen` with nobody calling the tool, that the whitelist gate still refuses tools outside `ALLOWED_TOOLS`, and that `dispose()` stops the timer. It proves the plugin and its configuration, never that the running DSH host loaded it |
| `node tools\dsh_mcp_heartbeat_probe.mjs --exe <packaged exe> --data <dir> --json artifacts/p1-presence/mcp-heartbeat-probe.json` | raw JSON-RPC to the packaged backend over stdio, with no connector in between: `initialize` + `tools/list` (22 tools) + `memory_peer_heartbeat` / `memory_peers` / `memory_digest`. Uses its own peer id and deletes that row, so it cannot make the real connector look alive |
| `.venv\Scripts\python.exe -m unittest tests.test_workflow_credentials -v` | the workflow credential path: a saved literal `api_key` with an empty `key_env` must reach the stage adapter as a `Bearer` header (the 401 this round found); `key_env` still works as the fallback and loses to a literal key; a missing credential is reported AS a missing credential, and no anonymous request is sent; the workflow stage deadline is its own budget, separate from the interactive one. Uses a local `http.server`, never the network |
| `.venv\Scripts\python.exe -m unittest tests.test_workflow_dag tests.test_workflow_credentials -v` | the DAG engine (topological order, parallel branches, cycle refusal before execution, legacy rows, per-stage trace evidence) together with the credential path above |
| `desktop\node_modules\electron\dist\electron.exe tools\verify_workflow_demo.cjs` | starts nothing: it reads a RUNNING devel backend (`P8_BASE`, default `http://127.0.0.1:18901`), clicks through to 工作流可视化, and asserts against the rendered DOM that the demo workflow and a `done` run with all stages are visible, then screenshots the canvas and the run record. Writes `artifacts/p8-workflow/*.png` + `ui-report.json` |
| `node tools\verify_agent_presence.mjs` | the LIVE host, not a fixture: composes the profile's patches with the host's own `applyEntryPatches`, asserts one row per id (duplicate inserts are what made the previous round's diagnosis impossible), that the row that actually boots carries the heartbeat and the right backend, that the connector entry is in the live Loader and `active`, that a `memora-backend.exe ... mcp` child exists, and that `peers.seen` advances by itself. `active` alone is explicitly NOT accepted as evidence — a plugin that returns early is still `active` |
| `.venv\Scripts\python.exe -m unittest tests.test_dsh_profile_composition -v` | the profile composition rules without a live host: the connector block renders in override form, re-rendering is idempotent, an old insert-form block migrates, no id appears twice, and the heartbeat fields survive a rewrite |
| `.venv\Scripts\python.exe tools\install_dsh.py --check` | dry run of the profile installer: names every stale path and every semantic drift, and distinguishes semantic drift from formatting-only drift so a correct profile stops reporting DRIFT forever |
| `desktop\node_modules\electron\dist\electron.exe tools\ui_validation_p6_brain.cjs` | the three brain types in a hidden window: 语义关系 is back to straight links (`control === null` on all 24 edges, 分类着色 off by default), 星云关系图 bows only its cross-section links at the measured 0.16 ratio, 层级脑图 is untouched, and picking 2D for the star-cloud type falls back to 3D with an explanation instead of an empty stage |
| `desktop\node_modules\electron\dist\electron.exe tools\ui_validation_p9_bestview.cjs` | 最佳视角 across all three renderers (34 checks): 语义关系 and 星云关系图 turn to a non-default angle on the first frame and fill most of the stage, 层级脑图 does the same through the vendor's own `rig.bestOrientation` (the run records whether the seam or the host produced that pose, because the host already picks one), the 最佳视角 toolbar button exists in all three and re-runs the search, the same link's drawn geometry is measured before and after a camera turn (sagitta 0.0487 → 0.0927 → 0.1096 of its chord, screen bow 10.88 → 18.28 → 18.44 px), the outline's two instanced shaders are the bending ones while its arrowheads are left unbent, and `graph.edges[*].control` is asserted untouched. Performance: one flex rewrite of the whole 26-link set averages 0.0003 ms over 2000 rewrites, and the throttled tick relaxes to 55 ms above 12000 vertices. Frame times with/without the layer are recorded in the report but deliberately NOT asserted — see `artifacts/p9-bestview-flex/REPORT.md` for why a frame-time threshold here would be a flaky test |

The UI check is deliberately separate from the source-level tests. A static test that reads
`memory.js` passes for a hardcoded label; the Electron check requires the same route to render two
different words in two different processes, which a constant cannot do.

The DOM contract the page must satisfy is small and stable, so the check does not depend on how the
banner is implemented:

| Element | Required |
| --- | --- |
| `aside .brand` | contains the `memora` wordmark (the existing brand link) |
| `#edition` | the banner block, positioned after the wordmark in the sidebar, with `data-edition="devel"` or `"standalone"` |
| `#edition-mark` | the visible edition word, exactly `devel` or `standalone` |
| `#edition-version` | `v` + `status().version` |

Anything else - colours, dot, letter-spacing, tooltip copy - is free. The banner lives in
`memory.html` / `memory.js` / `memory.css`, which this round's P5 scope does not own; the backend
provides the facts, the page renders them, and this document is the contract between the two.

None of these scripts restarts, stops or configures the DSH host process. `verify_editions.py`,
`verify_edition_ui.cjs` and `verify_workflow_demo.cjs` either start their own backend or read one that
is already running; `verify_dsh_presence.mjs` and `dsh_mcp_heartbeat_probe.mjs` drive the installed
package directly and never touch the host.

One exception is stated rather than hidden: `verify_dsh_presence.mjs` exercises the real connector
against the installed profile, and the heartbeat it proves lands where that profile points - the
standalone application's `memora-control.sqlite3`. That is a `peers` row (presence, rewritten every
30 s, TTL 90 s), never a memory, document or workflow. The probe script avoids even that by using its
own transient peer id and deleting the row.

## 5b. This round's change, and what it does NOT reach yet

The 1.3.0 round changed the development tree only. Two things follow, and neither is a formality:

* **The fix is in `devel`, not in the packaged copy.** The workflow credential path (`core.adapter_for_profile`
  + `chat_models.HTTPChat`) and the per-stage deadline (`workflows.WORKFLOW_NODE_TIMEOUT`) are source
  changes. The installed standalone backend was frozen at 2026-10-18 13:34 and still behaves the old
  way: a workflow run there fails with `provider_error: model endpoint returned HTTP 401` because its
  stage adapter reads only `key_env`. That failed run is kept as evidence in
  `docs/VALIDATION-1.3.0.md` (T5), together with the successful run on the fixed devel backend.
* **The user reviews before the standalone copy is rebuilt.** Per the agreed order, the packaged
  application is rebuilt (`tools/build_desktop.py`) only after that review passes - not as part of
  this round, and not from an agent session. Until then, treating "the fix works in devel" as "the
  user's copy is fixed" would be exactly the confusion this document exists to prevent.

The demo workflow created for T5 lives in the devel-side data captured under
`artifacts/p8-workflow/devel-data/`. Rows written into the standalone `data/` while investigating were
removed again, and the packaged copy's store was confirmed back to its previous contents (two
pre-existing `新工作流` rows, empty `runs`, empty `docs`, the same single approved memory).

## 6. What "independent" means, concretely

* `standalone` has its own `data/` (portable, next to the executable). The development tree's
  `data/` is never opened by it.
* The verification scripts never write to `memora-desktop-standalone/data/`; they copy
  `memora.json` into a temporary directory so the packaged backend starts with the saved model
  settings and nothing else.
* A build replaces `resources/backend/` and the page assets; it does not migrate, read or rewrite
  the user's memories.
* The development tree is the only place with tests, tooling and the build recipe. The packaged
  application ships the application, its docs and its licences - not `tools/`, not `tests/`.
