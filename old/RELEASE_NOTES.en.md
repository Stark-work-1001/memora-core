# memora 1.3.0 · Desktop guide

One Windows x64 application; no separate personal/public edition. The README describes the repository. This guide describes the local desktop delivery. Nothing was published to GitHub.

1. **Unpack and run.** Extract `memora-1.3.0-windows-x64.zip` to any writable directory and run **Launch-Memora.cmd** (or `Launch-Memora.ps1`); in a normal desktop session `Memora.exe` works directly. No Python, Node or Rust installation is required.
2. **The data is in the package.** `data/` beside the executable is this installation's store: `memory.sqlite3` (an empty schema-v2 database, already created), `markdown/` (the Markdown document and mirror folder) and `memora.json` (a template containing `{}`, with no credentials). Nothing is written to `%APPDATA%` on first launch, so the whole folder can be moved as one unit.
3. **Models must be connected by you.** Weights, CUDA and inference services are not in the ZIP. After launch, fill in your own local or cloud API under Model Connections: Embedding is required, Judge and Rerank are optional; leaving them unset still starts and browses, only retrieval degrades to lexical.
4. **On the configured machine, use Start-Memora.cmd in the project root.** It starts the configured models, the shared backend and the desktop, with data under the project's `data/`. The web UI is `http://127.0.0.1:8765`.
5. **Where things are.** Agent Connections exposes MCP configuration and heartbeat state. Model Connections configures Embedding / Judge / Rerank. Workflows and Model Orchestration edit other roles, ordered stages, consolidation policy and retryable jobs. Review consolidates memories, Markdown documents keep dates and versions, and the brain views keep semantic/hierarchical 2D/3D with camera focus. Workflow output is a new draft, never an automatically published document.

## What 1.3.0 changes

- The desktop ZIP now carries its own `data/` (empty database, `markdown/`, empty template settings), so unpacking is the install and state no longer scatters into user directories.
- Optional reranking as a second retrieval stage: `rerank` is a model role configured beside embedding and judge. It reorders only the head of the first-stage candidate list and truncates documents before they leave the process. With no provider, or on failure, the original order is returned together with an explicit `warning`; no score is invented.
- Model credentials may be saved per role in `memora.json` (owner-restricted) as well as read from the environment variable named by `key_env`. Every read path returns `key_set` as a boolean and never the value; clearing is explicit, so saving settings with the field left blank cannot delete a stored key.
- Desensitization for distribution: developer absolute paths and machine identifiers were removed from the documents that ship inside the bundle, and `tools/release.py` refuses to package while a secret-shaped or host-specific string survives, recording what it checked in `release/BUILD_DELIVERY.json`.
- Data consolidation on this machine: a retired standalone store (7 memories, 4 of them real) was merged into the project `data/` and its derived state rebuilt, so those four rows are retrievable through the full-text index and have Markdown mirrors; the retired integrity baseline and the emptied old database were archived under `artifacts/legacy-memory-20261017/` instead of being deleted in place.

## Before upgrading

Stop every process that writes, then back up the whole `data/` directory: four SQLite files, `markdown/`, `memora.json`, the token and the integration outbox. Set `MEMORA_DATA` to reuse an existing data directory.

## Validation and limits

Real local-model runs and frozen-build synthetic fixtures are recorded separately; a fixture is never reported as a model measurement. `resources/backend/BUILD_MANIFEST.json` is the build manifest, `build/reports/SMOKE_VALIDATION.json` is the smoke result, and `release/BUILD_DELIVERY.json` plus the ZIP's `.sha256` are the delivery record. See `CHANGELOG.md`; bundled document copies are under `resources/backend/docs/`. Application 1.3.0 and native kernel 1.0.2 are versioned independently.

Small models can misjudge; review important knowledge. DAG execution remains one ordered worker, not parallel scheduling.

## Windows launch and integrity labels

An EXE or DLL that inherits a Low mandatory integrity label makes Electron exit early. Builds and launchers relabel only program files to Medium and leave DACLs and data folders alone. If extraction inherits Low labels, run `Launch-Memora.cmd` or `Repair-Desktop.cmd` first, then open `Memora.exe` directly; no sandbox bypass is needed.
