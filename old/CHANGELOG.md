# Changelog

## Unreleased — development memory system upgrade

- Unified cross-source retrieval, typed trust, bounded evidence, explicit graph expansion and
  lexical-only reranking; stricter validation of reranker results.
- Eight editable workflow recipes; real Embedding/Rerank execution, sourced candidate extraction,
  learning/review and abstraction stages, dependency isolation and working cancellation.
- Independent-verifier requirement for automatic consolidation; saved model credentials also reach
  background extraction calls.
- Source-specific Codex/DSH configuration, modern DSH session surfaces, resilient lifecycle hooks,
  source launch identity and development source revision checks.
- 2D relationship layout, collision-aware labels, cleaner 3D titles and stable selection across
  dimensions; document evidence preview connected to its existing backend.
- Backend-only builds by default. No standalone update without explicit authorization.

## Unreleased — 2026-10-18 (development build, not a release)

### Fifth round: audit follow-up (a demo workflow the user could not see)

Re-checking the round’s evidence surfaced one more real defect, plus a repository-hygiene fix that
should have been caught earlier.

- **A selected workflow could open onto a blank canvas.** `loadWorkflows()` selects the first workflow,
  renders it and calls `canvas.fit()`. During the first paint the SVG has not been laid out yet, so
  `getBoundingClientRect()` is 0×0; fitting against that box produced `translate(-178 -62) scale(0.25)`
  and parked every node outside the viewport. The stage looked empty while the status line cheerfully
  said 已保存 5 个节点, and pressing 适应窗口 appeared to "fix" it — which is exactly what made it read
  like a rendering glitch instead of a fit bug. `fit()` now refuses to commit a view from a canvas it
  cannot measure and re-runs on the next frame. Four frontend tests pin it: defer on a 0×0 box, commit
  once measurable, commit immediately when already measured, and still reset the view for an empty graph.
- **The demo workflow is now IN the standalone app**, where the five tests were actually asked about.
  A workflow definition is configuration, not memory: it is what a user makes by clicking 新建 and
  saving, it involves nobody’s memories, and it calls no model until pressed — so it does not depend on
  the credential fix or the rebuild. The two 新工作流 the user already had are untouched and `runs` is
  still empty; what was removed earlier (test memories, test runs, test documents, test peer rows)
  stays removed.
### Fourth round: best viewing angle and links that flex with the view

The user asked for two things across all three brain types: the map should rotate itself to the angle
it reads best at, and the links should flex and stretch as the view turns rather than sliding rigidly.
Both are now true for 语义关系, 星云关系图 and 层级脑图.

- **No new angle-search algorithm was needed — the call was missing.** `frameDictionaryOverview()` fitted
  the camera range while keeping whatever azimuth and polar it happened to have, so the opening view was
  a lottery (a cloud seen edge-on collapses into a stripe and the whole view opened looking broken).
  It now runs the existing `bestAngles()` search — 24 azimuths × 6 elevations, scored by projected screen
  fill and penalising stripes — before fitting. The hierarchy view already had `rig.bestOrientation()`
  and already used it on its first frame; measurement showed that, rather than assuming it, and the
  acceptance records which of the two produced the pose instead of claiming credit. What
  `frontend/best-view.ts` adds is the shared *contract*: wait for the layout to settle, run once, never
  steal the camera from a reader who has turned it, jump instead of fly under `prefers-reduced-motion`,
  and expose the same seam to the new 最佳视角 toolbar button so the button and the first frame cannot
  drift apart.
- **Links now bow according to how you are looking at them.** All three renderers drew their geometry
  once from world space and never touched it again, so a link pointing at the camera collapsed to a few
  pixels and nothing about the drawing said which way the graph was being read. One rule is applied per
  link: `facing = |axis · view|`, `bow = baked + 0.18 × len × facing²`, bowed along the direction that is
  most visible on screen. Measured on one edge as the camera turns from side-on to end-on: sagitta
  3.33 → 6.33 → 7.49 world units, screen bow 10.9 → 18.3 → 18.4 px. The hierarchy view does it in the
  vertex shader from three.js’s built-in `cameraPosition`, so it costs no CPU at any size; the other two
  rewrite the position attribute, throttled and skipped entirely when the camera has not turned.
- **The deformation is derived, never written back.** `graph.edges[i].control` keeps exactly what the
  layout baked (all 24 still `null` in 语义关系, still the measured 0.16 ratio in 星云关系图). Writing the
  view factor into `control` would contaminate the baked data a little more on every camera move, so the
  reference-site measurements could never be checked again, and the error would accumulate instead of
  reversing when the camera returns. A test asserts the data is untouched after a full turn.
- **Two performance assertions were wrong, and both failures are kept in the report.** The first was a
  genuine defect: `rewrite()` called `scene.update()` at the end, so every rewrite rendered a whole extra
  frame — 13 ms of p95 overhead on a 24-edge graph. The second was a measurement defect: the two
  “baselines” it compared were themselves 41 ms and 55.6 ms apart (35%), larger than the 18.5 ms effect
  being measured, so the assertion was scoring noise and would have flaked forever. Frame time is now
  recorded and explicitly *not* asserted, with the conditions that make that necessary written down
  (offscreen window, software rasterisation, camera turning throughout); the performance evidence is an
  absolute cost instead — 0.0003 ms per rewrite of all 26 links, measured over 2000 rewrites.
- **A tooltip-scale fact worth knowing**: `projections.py` passes `limit=400` to `store.graph()`, so the
  brain view draws at most 400 nodes however many memories a project holds. The 880-node figure this
  round had been quoting is the store’s size, not the graph’s; the acceptance now measures at the real
  cap. Raising it is a projection-layer decision and is not part of this round.
### Third round: the five end-to-end tests, and what they exposed

Five questions were asked about the **running** standalone build: can DSH talk to it over MCP, can it
process a memory, can memory-connector reach it, are the cloud models really connected, and can a
workflow be built as a memory-processing demo. The answers are recorded in
`docs/VALIDATION-1.3.0.md`; this section lists what had to change because of them. T1, T2 and T4 passed
with no code change. T3 and T5 each exposed a real defect, and neither was the defect first suspected.

- **在线智能体 was broken by reading config the wrong way, not by a missing loader row.** The connector’s
  entry point was `apply(ctx)` and read `ctx.config`. Cordis passes a function plugin its config as the
  **second argument**; `ctx.config` is an injected service property, so reading it throws
  `cannot get property "config" without inject`. The plugin caught that itself and
  `return () => {}` — so the host listed it as `enabled: true / fiberPhase: active` while it registered
  **zero tools, ran no heartbeat and never spawned an MCP child**. `active` only means the fiber came up,
  which is why the previous round concluded, wrongly, that the plugin had not been loaded at all. It is
  now `apply(ctx, suppliedConfig)`, matching the `arsenal-plugin` entry that had always worked; a
  minimal reproduction goes from 0 to 10 registered tools on that one change. The duplicate-id patch row
  (bundle layer + profile layer, resolved by Map order rather than by intent) was a genuine latent
  hazard and is fixed too: the profile now overrides by id, so `id: memory-connector` appears exactly
  once. `tools/verify_agent_presence.mjs` reports ten separate checks, because "the plugin can run" and
  "the host has loaded it" fail for completely different reasons. The fix took effect **without a
  restart**: the host hot-reloaded the changed module (host start 18:30 → module edited 20:57 → MCP
  child visible 21:04).
- **A workflow stage could not authenticate, and the error blamed the provider.** A workflow run against
  the standalone build failed with `provider_error: model endpoint returned HTTP 401` while the *same*
  saved key worked for Judge and embedding. The workflow path derives a model profile from the saved role
  settings, and that profile carries `key_env: ""` — the workbench stores the credential as a literal
  `api_key` and never echoes it — while `HTTPChat.request()` read **only** `os.environ[key_env]`. So every
  stage request went out with no `Authorization` header. The memory pipeline uses
  `core._resolve_key()` (literal first, then `key_env`), which is exactly why T2 and T4 passed and only
  T5 failed. Fixed by joining the profile with the owning role’s credential in
  `core.adapter_for_profile` (never into the environment, never to disk, never into the run record) and
  letting the adapter accept it. Two related honesty defects went with it: a 401/403 now reads "the
  endpoint answered and rejected the credential" instead of "unavailable", and a remote profile with no
  credential at all says so instead of sending a doomed anonymous request.
- **The stage deadline was the wrong kind of deadline, and it said the wrong thing.** `HTTPChat`
  hard-coded `timeout=45`, and a workflow stage is one bounded 4096-token generation from a reasoning
  model — 45 s expires on a cold start. Worse, the failure said `endpoint unavailable`, which sends an
  operator to the network instead of to the budget. Workflow stages now pass their own 120 s transport
  deadline, and the record names `stage`, `operation`, `model`, `timeout_seconds` and
  `elapsed_seconds`. The remaining subtlety is documented rather than papered over: that deadline bounds
  **silence**, not total generation, so a stream that keeps producing is never cut. The measured demo
  proved it — `extract` finished in 147.9 s against a 120 s idle deadline. A separate
  `WORKFLOW_NODE_WALL_CLOCK` (300 s) now bounds the stage itself, both numbers are recorded, and an
  overrun gets its own flag so it can never be read as an outage again.
- **The real key sat in an un-ignored path inside the repository.** Found while auditing the workflow
  fixtures: `data/memora.json` holds a saved `api_key` in clear (by design — the workbench shows
  `key_set` and the user expects it to survive a restart), and `data/integrations/dsh-outbox/*.json`
  queue turns whose tool arguments can quote configured keys. `.gitignore` covered `*.sqlite3` but not
  `.json`, and the repository root is the source tree, so `git add -A` would have staged the user’s
  credential. It was never committed — no history, no remote — and `/data/` is now ignored, verified
  with `git check-ignore`. The test fixtures that merely *look* like keys (`sk-demo-…`, `sk-literal-…`)
  are deliberate and stay.
- **The brain view gained a third type instead of losing one.** The nebula rendering replaced 语义关系,
  which was rejected: the original semantic-relation view is back (spring layout, every `control: null`,
  one straight line per edge, 分类着色 off by default again), and the reference site’s look now lives in
  its own `matt` brain type (`星云关系图`, cross-section links bowed by the measured 0.16 × length,
  分类着色 on because the shells are the point). `frontend/matt.ts` is the only entry that installs the
  nebula bake; the hierarchy view is untouched, byte-identical. 星云关系图 has no 2D form — the shells
  and arcs *are* the 3D structure — so choosing 2D while it is selected is pulled back to 3D with a note
  that explains why, instead of showing an empty stage.
- **The first frame now picks a viewpoint, not just a distance.** `frameDictionaryOverview()` fitted the
  range while keeping whatever azimuth and polar the camera happened to have, so the opening view was a
  lottery: a cloud seen edge-on collapses into a stripe and the whole view opened looking broken. It now
  runs the existing `bestAngles()` search (24 azimuths × 6 elevations, scored by projected screen fill
  and penalising stripes) before fitting. No new algorithm was needed — the search already existed and
  was simply not called on this path.
### Second round: nebula graph + edition banner

- **语义关系脑图 now reuses the reference site's nebula structure.** The vendored renderer already supported
  curved links and section colours; what it was fed was a spring-embedded cloud of dots with `control: null`
  on every edge, so every link drew as a straight line and the graph had no visible grouping. A new
  `frontend/matt-layout.ts` bakes, from the projection's own `## 分类标题` sections: one overlapping
  spherical shell per section (centres on a near-horizontal ring, radius = farthest member, radial fill
  profile min 0.15 / mean 0.60 / max 1.00), and one Bezier control point per cross-section link. The
  reference site's three rules were recovered from its own baked JSON by measurement, not guessed:
  same-section edges are straight (185/185, offset 0.000); cross-section edges bow by exactly
  **0.16 × edge length** (358/358, one discrete value); and the bow direction is **away from the whole
  cloud's centre** — reconstructing all 358 control points from that rule lands within 0.0087 of the
  stored values, which is the reference's own rounding bound (the first hypothesis, "perpendicular to
  the edge", was measured and rejected: |cos| 0.42–0.55 with sign flips). The bake is deterministic
  (seed from the graph content), runs on real projects as well as the demo graph, and was measured at
  3.7 ms / 60 nodes through 272 ms / 880 nodes. The hierarchy view is untouched: its bundle hashes
  byte-identical before and after. One deliberate fidelity trade is documented in
  `artifacts/p4-matt/REPORT.md`: shell overlap is shallower than the reference because Memora's demo
  sections hold 2–4 members where the reference holds 6–16, and the reference's 71% overlap would
  collapse them into one blob.
- **Version banner under the wordmark: devel vs standalone.** Two independent copies of the application
  exist on one machine (the development tree being edited, and the packaged app the user runs) and from
  a screenshot they were indistinguishable. `GET /api/agent/status` now carries `edition` (`devel` or
  `standalone`, decided by `sys.frozen` in the running process — never by a path guess, with
  `MEMORA_EDITION` as an explicit, validated override) and `edition_label`. The page renders
  `memora / <edition> / v<version>` directly under the wordmark: amber dot for devel, green for
  standalone, and an honest "版本未知" when a backend predates the field. The duplicated bottom-left
  version line was removed, so the version is stated once.
- **Port isolation is verified, not just documented.** `tools/verify_editions.py` starts both backends
  at once on OS-assigned ports and asserts: distinct editions, PIDs, ports and data directories; equal
  versions; the three convention ports (8765 / 18184 / 18765) match `tools/paths.py`; and neither run
  steals a convention port. `tools/verify_edition_ui.cjs` reads the rendered DOM in a hidden Electron
  window and checks the banner's text, data attribute and geometry (below the printed wordmark, inside
  the left sidebar) for both editions. Both pass 15/15 and 22/22 after the rebuild.
- `docs/VERSIONING.md` records the directory contract, the edition rule, the port table, the fixed
  sync order (edit → review → rebuild → verify assets byte-identical → smoke) and the acceptance
  commands.

### First round: the four reported defects


Four defects reported against the 1.3.0 standalone build, plus two build/path defects found while
fixing them. No release package was produced: this round is development-tree work only.

- **在线智能体 showed "无在线智能体（1 个已过期）"** for two independent reasons. (1) The DSH profile's
  Memora entries still pointed at the retired `<数据目录>/...` root — the managed block AND the
  hand-maintained `memory-connector` insert list AND the connector's own bundle layer — so the MCP
  child could never be spawned. (2) The connector declared a `heartbeatTimer` and never started it,
  so a peer was recorded online only in the instant a model happened to call `memory_peer_heartbeat`
  and expired one ttl later. `tools/dsh_profile.py` now renders both blocks from the current tree,
  `tools/install_dsh.py --check` names every stale reference and asserts the heartbeat block, and the
  connector gained a configured periodic heartbeat (default off; this profile enables it at 30s/ttl 90)
  that still goes through the same `ALLOWED_TOOLS` gate and is cleared on dispose.
- **脑图 showed one placeholder node** because the shipped `data/` is empty and the demo graph was
  behind a button. The brain view now decides its data source on entry: no approved memory → the
  read-only demo graph (14 nodes / 24 edges / 3 hierarchy links) with a persistent "演示数据" banner;
  any approved memory → the real projection, and the preview is refused server-side as before. The
  toggle is therefore an exit from the demo, and its label says so.
- **点击节点没有最佳视角 / 连线看不见 / 2D 层级塌成一条线.** The framing code was already correct —
  the earlier measurement read the camera mid-animation. What was actually broken: the dictionary's
  resting edge opacity (0.22, tuned for a 543-term dark-theme dictionary) made links invisible on
  Memora's light background; its label layer has no collision test, so a dense first frame overprinted
  labels; the 2D hierarchy collapsed to one row because the demo graph carries only 3 hierarchy edges
  so every depth propagated to 0; and the vendored "显示标签" switch could not actually hide labels
  (it set `display:none` but never cleared `slot.visible`). All four are fixed from outside the
  vendored trees (`frontend/graph-look.ts`, `frontend/plane.ts`); `vendor/**` is untouched.
- **真实模型连接 only showed Embedding and Judge.** `core.py::model_health()` iterated a hard-coded
  pair, so `rerank` was structurally invisible, and neither route made a real call — it only asked
  `GET /models` whether the model name was listed. `model_health()` now walks `core.ROLES` (adding
  `rerank`), and a new `POST /api/agent/model-probe` performs one real minimal inference per saved
  role (`/embeddings`, `/chat/completions`, `/rerank`) and reports HTTP status, latency, model and the
  actual error. It probes only the saved configuration, never a caller-supplied endpoint, refuses
  redirects and caps the timeout at 15s. The 模型配置 page's 测试连接 button is enabled against it and
  the workflow panel paints every role the server reports, including 未配置 ones.
- **Build defect:** `tools/build_desktop.py` passed the directory returned by `release.stage_data()`
  to `', '.join(...)`, raising `TypeError: can only join an iterable` after the product had already
  been flattened — every desktop build failed halfway and left a partial standalone directory.
- **Environment defect:** the venv's editable install still mapped `memora` to the retired root, so
  `import memora` depended on the current directory and the build could not start at all. Reinstalling
  the editable package against this checkout fixed it; `tools/install_dsh.py` no longer relies on it.
- Validation for this round: 502 Python tests (0 failures), 71 frontend tests, TypeScript clean, a
  33-assertion Electron acceptance run for the brain views, an end-to-end run against the packaged
  application (online peer, demo preview, 3/3 real model probes), and `tools/smoke_desktop.py` passing
  on the rebuilt product. The user's live `data/` was not modified.

## 1.3.0 — 2026-10-17

- Packaged data: the desktop ZIP now ships its own `data/` beside `Memora.exe` — an empty schema-v2 `memory.sqlite3`, an (empty) `markdown/` document folder, and a template `memora.json` containing `{}`. Unpacking the ZIP and double-clicking is the whole install; the backend pins the app's `data/` as its store instead of scattering state into `%APPDATA%`.
- Reranking as an optional second retrieval stage: `rerank` is a first-class model role beside `embedding` and `judge`, an OpenAI-compatible /rerank provider can be configured per role, and retrieval reorders only the head of the first-stage list (`RERANK_TOP_N`) with truncated documents. When no provider is configured, or when the call fails, the response is byte-identical to 1.2.0's first-stage ranking and carries an explicit `warning`; no score is ever invented.
- Model credentials: a literal API key may be saved per role in `memora.json` (restricted to the owner) as well as read from an environment variable named by `key_env`. Read paths return `key_set: true/false` and never the value; clearing is explicit (`api_key_clear`), so a settings save that omits the field cannot silently delete a stored key.
- Desensitization for distribution: absolute developer paths and machine identifiers were removed from the documents that ship inside the bundle, and `tools/release.py` now refuses to package when a secret-shaped or host-specific string survives. The scan records what it checked in `release/BUILD_DELIVERY.json` instead of asserting a clean result without evidence.
- Release validation: `tools/release.py` verifies `build/reports/SMOKE_VALIDATION.json` against the current `__version__`, the packaged backend's SHA-256 and the desktop tree hash before writing a ZIP, and the packaged `data/` is checked to hold no user memory, no token and no integration state.
- Data consolidation on this machine: a retired standalone store (7 legacy memories, 4 of them real) was merged into the project's `data/` directory and its derived state rebuilt, so the four merged rows are retrievable through FTS and have Markdown mirrors like every other row. The retired integrity baseline and the emptied old database were archived under `artifacts/legacy-memory-20261017/` rather than deleted in place.
- Not included: no GitHub publication and no personal/public split; model weights, CUDA and inference services remain external to the ZIP. Reranking is off until a provider is configured. DAG execution is still one ordered worker. Memory schema v2, memory IDs, fingerprints and immutable document versions are unchanged.

## 1.2.0 — 2026-10-17

- Added a workflow DAG engine and a standalone canvas served at `/dag`: nodes, edges, an optional dispatcher agent and a node inspector, editing the same stored workflows the workbench already ran. Cycles are detected, marked on the canvas and refused on save, and a cyclic graph is rejected before a run row or a worker exists, so it never executes even the acyclic prefix. 整理布局 re-layers by longest path; execution walks one topological order in a single worker and is not a parallel scheduler.
- Rebuilt the workbench on a `--mm-*` design-token layer: every colour and size in memory.css resolves to a token declared in the two `:root` blocks, and the animated backdrop is CSS-only (composited transform/opacity, `pointer-events: none`, static under `prefers-reduced-motion`).
- Made retrieval the first page instead of a plain form: hero search, an evidence-pack preview, recent conversations and live processing state in one view.
- Fixed the workbench SSE endpoint and the seam around it. The workbench adapter answers `/api/agent/events` with the project scope and mirrors `Agent.snapshot`, and a snapshot that fails now reports itself in a final frame instead of leaving the caller a silently dead stream.
- Document-level RAG: added the MCP evidence tool `memory_rag_context` (nonced source quotes, citation list, the real retrieval mode, `generation: client_required`), a workbench 证据包预览 that issues exactly one request per click and never runs on load, and the document chunk index in `memora/docindex.py`.
- Repointed the DSH memory-connector off the retired `memory-merge` backend onto `memora`. This is **not enabled in the DSH profile** in this release: the profile still declares `MEMORA_RUNTIME_VERSION: '1.1.0'`. That label is cosmetic — the profile already runs `-m memora` from the venv editable install, so it picks up 1.2.0 code immediately — and re-running `tools/install_dsh.py` rewrites it. Editing the profile was out of scope for this release.
- Packaging: shipped `static/dag/` as a directory copy and forced `memora.docindex` into the frozen bundle with `--hidden-import`, and added packaging consistency tests, because the canvas and the document index had both worked all day in the source tree while a packaged build 404'd for them.
- Release consistency: the workbench nav now links to `/dag?project=<the current project>`, so the canvas is reachable by a click instead of a typed URL, and `memora.__version__`, `BUILD_MANIFEST.json` and this file now all read 1.2.0.
- Not included: no GitHub publication and no personal/public functionality split; model weights, CUDA and inference services remain external to the desktop ZIP. The document index and the MCP evidence tool ship but are not on by default. DAG execution is one ordered worker, not parallel scheduling. Memory schema v2, memory IDs, fingerprints and immutable document versions are unchanged.

## 1.1.0 — 2026-10-16

- Fixed packaged Windows startup: inherited Low mandatory integrity labels caused an early Electron crash. Normalize program/runtime labels to Medium, retain DACLs and the sandbox, provide scoped portable repair, and require a successful default desktop launch before packaging.
- Added modular conversation absorption with dated SQL/Markdown archives, exact source quotes, extraction, Judge routing, verification and optional automatic consolidation.
- Added durable leased jobs with retry/idempotency; semantic duplicate/conflict proposals retain archives and prevent automatic conflict approval.
- Deployed the supplied embedding and GGUF Judge on Rocky WSL with CUDA, pinned model hashes, a private ML environment and an explicit WSL keepalive.
- Added authenticated MCP HTTP alongside stdio, 20 tools, bounded context digests, editable model roles and ordered document workflows with model/output traces.
- Installed external DSH lifecycle hooks and official MCP client entries; tested two real DSH sdk-minimal sessions with automatic capture/recall and no cloud credentials.
- Retained Markdown dates/versions and semantic/hierarchical 2D/3D views; preserved v2 memory storage and independently versioned Rust kernel.
- Unified launcher/data/cache paths in the current project; refreshed bilingual docs, reference inventory, architecture preview, desktop build and local ZIP.
- Added a portable launcher using the bundled backend and built-in PowerShell, with a web fallback that preserves the production sandbox defaults; bound package validation to the complete desktop tree.
- Fixed Windows runtime stopping to target the verified listening process rather than leaving the venv launcher's child alive with stale code.
- No GitHub publication; no personal/public functionality split. Weights and GPU runtime remain external to the desktop ZIP.

## 1.0.2 — 2026-10-16

- Unified the personal/distribution application after flattening the development tree; one build under dist, no public/release staging.
- Absorbed the implementation into memora and renamed the Rust module memora_native; old memory_merge imports and CLI remain thin compatibility aliases.
- Focused default runtime on MCP agent connection, vector retrieval, persisted Judge/rule classification and explicit consolidation.
- Preserved Markdown management, immutable audience-specific versions/dates, and the existing semantic/hierarchical 2D/3D brain views.
- Added model connection settings with per-role remote consent, env-only keys and cross-process configuration refresh.
- Excluded chat/workflow/archive scanners/dispatch engines from the default standalone backend while retaining their source components.
- Added pipeline, failure/retry, HTTP, configuration, compatibility, MCP and desktop validation; retained schema v2, model fingerprints and original data history.
- Rewrote Chinese/English introductions and desktop guides; preserved the complete prior reference inventory and license provenance.

## 1.0.1 — 2026-10-15

Rust native top-k buffer safety and RRF integration; peer heartbeat/task leases; resource catalogs and logical project threads; immutable Markdown record dates; model workflows with provenance and draft output; authenticated optional MCP HTTP bridge; 2D graph view, 3D camera focus, distance fog, layouts and directional flow; bilingual research/stack/operations docs; isolated sanitized source/standalone delivery. Original v2 memory schema and review APIs retained. SDK stdio transport now uses duplicated descriptors so shutdown cannot close the embedding host streams.

## 1.0.0 — 2026-10-15

Memora memory entity: model assembly, chat, dual 3D graph views, local agent sources, MCP delegation, preserved knowledge/Markdown/database core, Apache-2.0 distribution.

# Changelog

Versions follow PEP 440; git tags are `v` + version from 0.2 on.

## 0.2.0a1 (unreleased)

Upgrade of the 0.1 prototype into a complete local memory system. Measured on
`datasets/memory-eval-v1` (test split): nDCG@10 0.340 -> 0.649 lexical, 0.827 with local embeddings;
queries returning nothing 45.8% -> 0%. Details in docs/EVALUATION.md.

### Security and safety
- Agents can no longer approve their own memories: `memory_remember(confirmed=True)` stays pending
  unless `MM_TRUST_AGENT_CONFIRM=1`.
- Evidence packs fence each memory with a per-response nonce; stored text can no longer forge
  citation headers or block boundaries.
- Forgotten and rejected content leaves the full-text index, vector table and judge cache; pending,
  rejected and deleted content is never in the index at all.
- New `purge`: deletes a memory and all derived copies, scrubs freed pages (`secure_delete`),
  truncates the WAL and vacuums; reports what it cannot reach.
- Secret screening covers source, tags and event ids, full-width text, more token formats, Chinese
  key words, payment cards (Luhn); notes *about* passwords are no longer rejected.
- Fixes from an independent review (24 findings, docs/REVIEW.md), including redaction of import
  metadata, the viewer serving forgotten text by id, and a Windows UNC path in `memory_import`
  causing SMB access.
- Viewer review mode (`web --review`) protected by token, Origin, Host and content-type checks.

### Retrieval
- Bigram analyzer for Chinese/Japanese/Korean/Thai text, query-side stopwords, unigram backoff,
  prefix matching; tags indexed; filters by category, tags, kind, polarity, status.
- Optional embeddings: Qwen3 preset (query instruction, Matryoshka dimensions), batching, incremental
  indexing, float32 storage, immutable model fingerprints, canary-based drift detection.
- Fusion tuned on dev data: vector-first RRF with lexical backfill (weights 0.01/1.0).
- Optional Rust kernel for exact top-k search (85-125x faster than pure Python at 10k-100k vectors).
- `:user` scope for cross-project preferences; profile and cited start-of-task briefing.

### Memory lifecycle
- States: pending, approved, rejected, archived, superseded, deleted; explicit transition table.
- `supersedes` is enforced; contradictions are surfaced; exact/normalised duplicates become
  sightings with a support count; negative ("do not repeat") memories.

### Ingestion
- Markdown (heading-aware, cites heading path and lines), text, PDF (optional `pypdf`), browser
  bookmarks, JSONL highlights; per-document review; re-import versioning.
- Two-way Markdown: mirror edits and inbox notes become pending proposals (`sync`, `sync --watch`).
- Session archive with redaction, JSONL import format, Claude Code transcript adapter and hook.

### Models
- In-process backends: sentence-transformers and llama.cpp (optional extras).
- Judge: strict schema, constrained decoding when available, thinking-model handling, caching per
  content and model, calibration against the user's review decisions; prompt judge-v3 chosen on half
  the corpus (held-out category agreement 46% -> 71% with Qwen3-1.7B). Off by default; see docs/MODELS.md.

### Operations and packaging
- Schema migrations: refuse newer databases, verified pre-migration backup, one transaction, heal
  after downgrade by older code; tested against databases written by the real 0.1 code.
- `doctor`, `drill` (backup + restore round trip), `restore`, `maintain`, `report`, `rebuild` (now
  rebuilds the index too), `prune-vectors`.
- Typed errors with stable codes for MCP and CLI; CLI no longer crashes printing non-GBK text on
  Chinese Windows consoles.
- Platform data directory by default (0.1's in-checkout `data/` is still used if it exists).
- `pip install .`, `memory-merge-mcp` entry point, Dockerfile (non-root), CI for Linux/macOS/Windows
  x Python 3.11-3.13 (not yet run), issue/PR templates, CONTRIBUTING, SECURITY.
- Evaluation harness and labelled dataset; benchmarks for vectors, embeddings and the judge.

### Breaking changes
- `tags`/`locator` returned as JSON values; `memory_review_queue` returns an object; identical
  content in a project is stored once; `rebuild` also rebuilds the index; see docs/OPERATIONS.md
  "Upgrading from 0.1".

### Repository
- `.gitignore` added (data, databases, keys, env files); `.gitattributes` pins LF.
- LICENSE-STATUS.md corrected: the project is MIT-licensed.
- README restructured; credits moved to docs/REFERENCES.md with commits and licenses.

## 0.1.0a1 (published 2026-10-13)

Released as git tag `0.1.0`, GitHub Release `memory-merge-v0.1.0-alpha.1`, Python package version
`0.1.0a1`: the same code under three names. Source ZIP SHA-256
`aa3a601b09de675041473ba6b72279e449118e0300c78233df0a169fdf37d470` (44,358 bytes).

- SQLite store with outbox-based Markdown mirror, pending/approved review, six categories,
  project scopes, idempotent events, typed edges.
- MCP stdio server (official SDK), lexical retrieval with substring fallback, optional
  OpenAI-compatible embeddings and judge, RAG evidence packs, read-only mind-graph viewer.
- 15 tests.
