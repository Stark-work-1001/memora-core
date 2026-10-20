# memora-core 1.1.0 — the handback

| | |
|---|---|
| Answers | [HANDOVER.md](HANDOVER.md), section 6 |
| Version | 1.1.0 (from 1.0.0 = commit `8df63d6`) |
| State | Working tree only — nothing committed, tagged or pushed |

## 0. In one paragraph

I picked one axis: **true**. 1.0.0's biggest problems were not missing features; they were claims
the product made that were false, and nothing that ran could notice. The published source tree
could not run. The headline 3D view shipped blank. Any web page could write "approved" memories
that recall then handed to every agent. Two forget/supersede workflows created memories instead of
removing them, and said `ok`. The default retrieval was worse than its own keyword channels. The
overview page showed 0 memories on a database of 21. So 1.1.0 makes every claim hold and puts
something that runs behind each one: CI, a retrieval harness, a real-browser end-to-end test,
a docs-vs-code test, and a test per fix that fails on 1.0.0.

| Measure | 1.0.0 | 1.1.0 | Command |
|---|---|---|---|
| Python tests | 440 (3 fail on the published tree) | **622, all pass** | `python -m unittest discover -s tests -t .` |
| Frontend tests | 11 unit, never against a backend | **35** incl. 12-route e2e on a real backend | `cd frontend && npm test` |
| e2e checks passing on 1.0.0 code | — | 3 of 16 (it catches the shipped bugs) | e2e against `git archive 8df63d6` |
| Retrieval nDCG@10, held-out test split | 0.455 | **0.602** | `python tools/eval_retrieval.py --split test` |
| `/api/health` on a 423 MB database | 1,843 ms every call | **4.4 ms** (`?deep=1` 1,973 ms on request) | bench in §3 |
| Backend exe | 31.1 MiB, 750 modules, undeclared numpy/Pillow | **11.5 MiB**, 268 modules | `python tools/inspect_exe.py dist/memora-backend.exe` |
| Release zip / unpacked | 211.6 / 429.2 MiB, 55 locales | **160.5 / 342.7 MiB**, 2 locales | `python tools/release.py` |
| Main page load (gzip) | 1,068 KB | **128 KB** | frontend agent's measurement |
| Workflow templates runnable with only their declared inputs | 12 / 18 | **18 / 18**, gw=None ≡ zero-profile gateway | `python tools/run_all_workflows.py` |

## 1. What I decided

### The plan, in the order it was executed

1. **Establish the authoritative tree** (§2.1).
2. **Close the holes that let outsiders write**: cross-site write gate (ADR-0001), no self-certification
   (ADR-0002), Electron navigation and permission guards, MCP frame robustness, secrets kept out of
   exports, the Markdown mirror and agent recall.
3. **Make the visible product work**: the graph view, every page's numbers, health that stays cheap.
4. **Finish the engine** that 1.0.0 started (async runs, progress, cancel, honest persist ops, a job
   worker, a reaper) — delegated to one agent with a precise brief.
5. **Measure retrieval, then improve it** — delegated to a second agent.
6. **Fix the frontend contract and build the loop that would have caught it** — a third agent.
7. **Make the release reproducible and say what is in it** (ADR-0005), CI, docs, ADRs, this report.

Three implementing agents worked on disjoint files in parallel; five read-only auditors went first.
I reviewed and re-ran their claims (§3 marks what I re-ran myself).

### What I rejected, and why

| Considered | Decision | Why |
|---|---|---|
| Rewrite the frontend in a framework | **No** | Every frontend bug found was a contract or CSS bug (0-px mount, wrong field names, `Boolean([])`, a non-bubbling event). A framework fixes none of those; a test against the real backend fixes all of them and now exists. Revisit only if the page count grows a lot. |
| Replace the CJK bigram path with native FTS5 trigram | **No** | Measured worse: 0.458 nDCG@10 (21 % zero-result queries), 0.484 with a LIKE fallback, vs 0.550 for the 1.0.0 bigram path and 0.602 for the 1.1.0 one; index ~6× larger. |
| Add an ANN / HNSW dependency | **No** | At ≤10k memories exact search is cheap (warm p50 75 ms at 10k for the whole default search). The quality problem was a bad channel, not a slow one. |
| Build the cron scheduler the templates imply | **No (for now)** | Unattended destructive templates (forget-decay) with no consent UI. Triggers nothing fires are now reported `trigger_active: false`; the job queue got a real worker. |
| Split `workflows.py` | **Deferred** | Behaviour first: 1.0.0's tests passed for the wrong reasons (all 4 audit mutants survived). Now 18 of 19 mutants die, so a split is finally safe. It grew to 6,531 lines — the next thing I would do. |
| A bearer token on REST | **No** | Breaks every existing REST integration with no migration path. ADR-0001 closes the remotely reachable hole (browsers); the local trust model is documented. |
| Delete `old/` (381 files, 51 MB) | **No** | It is a documented, frozen archive with its own licence notices; it is not built, tested or shipped, so deleting it removes no maintenance. Its labelled dataset is what the retrieval harness uses. |
| Drop the duplicate backend exe now | **Deprecate, remove in 1.2.0** | docs/INDEX.md promised it; an MCP host may point at it. It now costs 12 MB instead of 32 MB. |
| PyInstaller `--onedir` | **No** | Changes the backend path every copied MCP config contains. |
| Asar-integrity fuse, signing, auto-update | **Not by me** | Need the owner's certificate and release host; enabling integrity without signed integrity data can stop the app from starting. |
| Overrule any §4 constraint | **None overruled** | Two tightenings of published behaviour (import trust default, agent approval) are justified by constraint 4 itself — the old behaviour returned success for certification that never happened — and each has a migration path (ADR-0002). |
| Auto-migrate 1.0.0's plain `master.key` to DPAPI | **No** | Would surprise users who move `data/` between machines. New keys are DPAPI-bound; old ones keep working; migration is an explicit rename (docs/OPERATIONS.md). |

### A second opinion on the architecture (HANDOVER §5)

- **Workflow DAG**: right instinct, wrong granularity. Seventeen generic node kinds with free-form
  `params` let templates say things the engine silently ignored — 13 of 21 persist nodes fell through
  to "create a memory". 1.1.0 validates every template at seed time and gives persist typed ops. I would
  go further: fewer generic kinds, more named operations, and templates treated as code. Offline,
  13 of 18 templates run `partial`; ask which ones anyone needs.
- **Memory state machine**: the right shape; it just was not enforced. It now has one choke point in
  `store.py` with write origins.
- **Scope hierarchy**: flat in practice (no API creates a parent), and recall expands *upwards* while
  lists expand *downwards*. Unchanged in 1.1.0. Either drop the hierarchy or add parent creation and
  document both directions.
- **Plugin/host model**: MCP-first is right. Agent identity is self-declared; the trust model no longer
  depends on it.
- **Frontend**: keep it framework-free; keep the e2e. Generating the TS types from the backend would be
  the next step.

### What is missing (features that should exist)

1. **Backups.** Documented in 1.0.0, never implemented (OPERATIONS.md now says so). The SQLite backup
   API makes a daily rotated copy cheap.
2. **A consent screen for destructive workflows**, which then unlocks a scheduler.
3. **Settings that do something.** 1.0.0's settings form saved values no code read; it is read-only now.
4. **Conflict resolution that acts.** `resolve` only records the decision; the UI now says so.
5. **A stored CJK-segmented index** for beyond ~10k memories (the new BM25 scans the pool).
6. **An offline semantic option** for the desktop build — the only way past 0.60 nDCG without a cloud
   model (a local embedding model reached 0.834 in the harness).
7. **Signing and an update channel** (needs the owner).

## 2. What I verified, and what I took on faith

### 2.1 Which tree is authoritative

- The 20 Python modules at `8df63d6` are **byte-identical** to the bytecode inside the shipped
  `memora-backend.exe` (compared code objects, constants, names, line tables). The frontend build is
  deterministic: rebuilding `frontend/src` reproduces all six shipped bundles byte-for-byte. Shipped data
  and static files equal the repository after CRLF normalisation.
- **The published tree is missing `memora_core/__init__.py` and `__main__.py`.** HANDOVER's "22 modules"
  counts them, so they existed in the owner's working copy only — the exact drift §7 warns about. I
  recovered both from the shipped bytecode (identical code objects and line numbers).
- The release zip is **not** reproducible from the tag: its `app.asar` says `"license": "Apache-2.0"`.

### 2.2 Your section 2, claim by claim

| Claim | Verdict | Evidence |
|---|---|---|
| Daily note splits on UTC | **Right**, and wider | Also the overview's daily counts, the timeline graph, imported documents' `day`; west of Greenwich evening work lands on tomorrow. `test_vault::test_daily_page_is_the_local_calendar_day` fails on 1.0.0 (`2026-10-19 != 2026-10-20`). |
| Health runs a full integrity scan per call while the UI polls | **Right, and worse** | 1,843 ms per call at 423 MB; the desktop readiness probe times out at 1.5 s, so the app could not start at that size. The poll never stopped, because `degraded` is a list and `Boolean([])` is true. |
| Census is a hand-written 23-name list against 28 tables | **Exactly right** | Missing 7 real tables, counts 2 virtual; it is also where README's "23" came from (selftest). |
| "A cheap class of bug" | **Right** | Hand-maintained lists and types drifted everywhere: the frontend read fields the backend never sent; README said 4 model roles (6), docs/INDEX.md 13 relations (14); OPERATIONS described files that never existed. `tests/test_docs_drift.py` now holds 23 numeric claims and two coverage checks. |
| Runs execute in the request thread, progress only at the end | **Right** | Plus: the UI read `step_list`, the backend sent `steps`, so the timeline always showed 0 steps. |
| Cancel cancels a flag nobody watches | **Wrong as stated, broken anyway** | The flag *was* watched at layer boundaries; but a running node never stopped, the status flipped to `cancelled` while nodes kept writing, and two races could end a cancelled run `ok` or a finished run `cancelled`. |
| 17 node kinds; templates use 21 names, 4 unhandled | **Wrong** | Templates use exactly 17 node kinds, all handled. "21" = 17 node kinds + 4 *trigger* kinds (agent, ingest, manual, session-end). `python S/work-engine/kinds_count.py …` |
| Job table accepts work nothing consumes | **Right** | And `persist` with `table="job"` wrote a `recall_log` row. |
| One design never finished | **Right, wider than listed** | The worst part was not listed: forget-decay *created* memories (1 → 3) and reported `ok`; update-supersede created memories instead of superseding. |
| Doc quality numbers can't be reproduced; no harness | **Partly** | Some numbers did reproduce — from a toy unit fixture where every gold document contains the query verbatim. The real labelled dataset existed in `old/datasets/memory-eval-v1`, unused. |
| CJK path never compared with native SQLite | **Right**; now answered | Hand-rolled bigram + LIKE beats native trigram (0.550 vs 0.458). The 1.0.0 default lost because it mixed a hash "vector" into fusion (0.455). |
| Hand-rolled DOM, no framework | Right | — |
| One bundle per page | **Wrong** | Two bundles: a 12-page hash-routed SPA and the standalone brain view. |
| Each page polls on its own | **Wrong** | One global health timer plus one SSE stream; pages refetch on events. The timer was the bug. |
| Unversioned assets force `no-store`; 2.3 MB every reload | **Partly** | Unversioned and `no-store`: right. "Only safe policy": wrong — `no-cache` + ETag is safe and now used. 2.3 MB is the folder; a page load was ~1.07 MB gzipped (now 128 KB). |
| Splash sandboxed, main window not | **Wrong at runtime** | Electron ≥ 20 sandboxes renderers by default. The real hole was elsewhere: no `will-navigate` guard, so a link in a memory could navigate the window that holds the preload bridge. |
| 55 locales; backend shipped twice; no signing, update or CI | **Right** | Plus undeclared numpy/Pillow/fontTools in the backend and default Electron fuses. |
| README table count is wrong | **Right**, and more | THIRD-PARTY.md said "no third-party runtime dependencies"; OPERATIONS promised inbox auto-ingest, backups, migrations, `secrets.bin` and a machine-derived key; the README promised a byte-level desensitization scan that no tool performed. |
| Scale line (22 modules, 440 tests, 429 MB release) | **Partly** | 20 modules in the published tree; 440 tests of which 3 fail there; 429 MiB is the *unpacked* size (the zip is 211.6 MiB). |

### 2.3 Taken on faith or not verified

- **Real cloud model paths.** No network models were called. A local Ollama embedding model was measured
  by the retrieval agent (I did not re-run that number); DashScope/OpenAI paths are covered only by fakes.
- **The CI workflow has never run** (nothing was pushed). Its Ubuntu leg and every POSIX branch
  (`_pid_alive`, non-Windows `master.key`) are unexecuted.
- **Agent-measured numbers I did not re-run**: retrieval latency (379 → 75 ms warm p50 at 10k), page-load
  bytes, the with-model nDCG (0.834), the mutant counts. Re-run commands are in §3.
- Browsers' Local Network Access prompts might already have blunted the CSRF; ADR-0001 does not rely on it.
- The owner's own identity strings: the desensitization scan looks for **this** build machine's
  identity. Run `python tools/desensitize_scan.py` on yours.

## 3. What changed, and the command that proves it

Every row's test fails on 1.0.0 code (checked by running it with the old file restored from git).
"Re-run by lead" means I ran it myself on the final tree; the rest are the implementing agents' runs,
whose suites are all inside the 622 / 35 totals I did re-run.

| Area | Claim | Proof | Re-run by lead |
|---|---|---|---|
| Source tree | Runs; `python -m memora_core …` works | `python tools/verify.py` → 10 passed / 0 failed | yes |
| Graph view | Renders in the packaged app | packaged 1.1.0: brain canvas 1159×656, 452 nodes; `frontend/tests/brain-render.test.mjs` | yes |
| CSRF | Cross-site writes refused, other clients unaffected | `tests/test_security.py` (13; all fail on 1.0.0) | yes |
| Trust | No self-certification; secrets stay home | `tests/test_trust.py` (24) | yes |
| Health | Cheap; census from schema; migrations | `tests/test_health.py`, `tests/test_db.py`; bench: 1,843 → 4.4 ms at 423 MB | yes |
| Days | Local calendar | `tests/test_vault.py::test_daily_page_is_the_local_calendar_day` | yes |
| Engine | Async, progress, cancel, persist ops, jobs, reaper | `tests/test_workflow_runtime.py` (30), `test_workflow_persist.py` (19), `test_workflow_templates.py` (18); `python tools/run_all_workflows.py` → 18/18, both paths identical | yes |
| Retrieval | 0.455 → 0.602 nDCG@10 (test split) | `python tools/eval_retrieval.py --split test`; 1.0.0 via `--code-root <export of 8df63d6>`; gate `tests/test_retrieval_eval.py` | yes |
| Frontend | Numbers on screen = API | `cd frontend && npm test` → 35/35 | yes |
| Shell | Navigation guard, permissions, fuses | CDP probe of the packaged app; fuse wire `010001011` vs 1.0.0 `101100011` | yes |
| Packaging | Only declared packages; no build-machine identity | `python tools/inspect_exe.py <exe> --check`; `python tools/desensitize_scan.py dist/` (1.0.0 exe fails the first) | yes |
| Docs | Claims match code | `tests/test_docs_drift.py` | yes |
| Secrets | Damaged key reported, never replaced; DPAPI | `tests/test_secrets.py` | yes |

## 4. What I broke, and what I am unsure about

**Deliberate behaviour changes** (all with migration paths; ADR-0002, ADR-0005):

- Exchange import defaults to `trust: "cap"`: imported `approved` records land as candidates
  (`demoted` in the report). Restoring your own backup: `trust: "preserve"` (HTTP/CLI, never MCP).
- MCP `memory_update` cannot approve; `memory_forget(hard=true)` needs `confirm`; `memory_remember`
  trust ≤ 0.5 until a human approves.
- Offline hybrid search has no vector channel (it was a hash fingerprint labelled as similarity).
- `emitted` on a run now counts that run's own events; the route's extra summary `run` event is gone.
- The workflow cancel endpoint can answer `202` (still finishing) and `409` (already finished).
- `data/inbox/` is now actually consumed: files move to `inbox/processed/`.
- New `master.key` files on Windows are DPAPI-bound: copying `data/` to another machine means re-entering
  API keys (the UI says so).

**Risks I am carrying forward**

- `workflows.py` is 6,531 lines (from 4,269). Better tested than before, but it is the module to split next.
- The new BM25 scans the candidate pool in Python; past ~10k memories it needs a stored segmented index.
- The 0.02 keyword weight under a real embedding model was tuned on one local model only.
- Cancellation is cooperative: a blocking model call finishes before the run stops (the API says `202`).
- Daily pages written before the upgrade are not re-filed.
- The brain-render test rewrites its PNG snapshots on every run (diff noise).

**Left on the build machine**: `%APPDATA%\MemoraCore` (created by test launches; safe to delete);
`dist/` (gitignored build output); numpy and Pillow installed in the scratch build environment to prove
the build now excludes them.

## 5. Where to start reading

1. **[.github/workflows/ci.yml](.github/workflows/ci.yml)** — the shape of 1.1.0 is "what runs on every
   change": verify, the retrieval harness, the reproducible frontend build, the real-browser tests, the
   frozen-backend content check.
2. **[docs/adr/README.md](docs/adr/README.md)** and the five ADRs — every decision that touches a published
   interface, with its evidence and its migration path.
3. **[frontend/tests/e2e-app.test.mjs](frontend/tests/e2e-app.test.mjs)** — the contract between the
   real UI and the real backend, written as a test. It is the single file that would have caught most of
   what 1.0.0 shipped.

Then, for the code: the top of `memora_core/store.py` (write origins and the trust rule) and
`docs/workflows.md` (the engine as it now is).
