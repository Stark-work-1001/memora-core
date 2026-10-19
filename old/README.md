# memora 1.3.0

> **Legacy line — archived.** This directory holds the pre-rewrite **memora 1.x**
> codebase (Apache-2.0), published for history and study. The maintained release is
> **memora-core** in the repository root. This tree is not the current product: it is
> released as it stood, with machine-local paths and personal identifiers removed.
> Every change made before publication is listed in
> [docs/DESENSITIZATION-AUDIT-public.md](docs/DESENSITIZATION-AUDIT-public.md).

The development upgrade adds unified memory/document/session retrieval, eight editable memory workflows,
capability-aware Embedding/Judge/Rerank nodes, source verification, and persistent 2D/3D graph selection.
See [upgrade design and research](docs/UPGRADE-MEMORY-SYSTEM.md) and [agent connections](docs/AGENT-CONNECTIONS.md).
Development builds do not update the sibling standalone application without explicit authorization.

[中文](README.zh-CN.md) · [Architecture](docs/ARCHITECTURE.md) · [Transport](docs/TRANSPORT.md) · [Quality](docs/QUALITY.md) · [Roadmap](docs/ROADMAP.md) · [Operations](docs/OPERATIONS.md) · [Directory layout](docs/DIRECTORY-LAYOUT.md) · [Decisions](docs/DECISIONS.md) · [Changes](CHANGELOG.md)

**Persistent, sourced memory for connected agents.** MCP conversation intake creates Markdown / SQL archives and durable extraction jobs. Small models propose memories, Judge assesses durability and risk, deterministic routing plus verification controls consolidation, and Embedding with a Rust kernel powers retrieval. Markdown management and the existing 2D/3D brain views remain available. Editable model roles and document workflows are included in the same application.

One source tree and one build. This README describes the repository; [desktop release instructions](RELEASE_NOTES.en.md) describe the ZIP.

![Architecture](docs/ARCHITECTURE-1.1.0.svg)

## Running deployment

The installed project is the directory this README sits in; model weights are kept in a separate weights directory chosen at deployment time, outside the repository. Inference runs in a WSL distribution. Run **Start-Memora.cmd**, or `./start-memora.ps1 -Headless` for background operation. UI: `http://127.0.0.1:8765`; authenticated MCP HTTP: `http://127.0.0.1:18184/mcp`.

Both supplied models have been exercised with real inference:

| Model | Work | Runtime |
|---|---|---|
| Qwen3-Embedding-0.6B, alias `qwen3-embedding-0.6b` | 1024-dimensional last-token embeddings and instruction-formatted queries | Private PyTorch / transformers environment, CUDA, port 18181 |
| Local Qwen3.8-2B-Q4_K_M.gguf, alias `qwen3.8-2b-judge` | Judge; shared curator, verifier and semantic-comparison roles | llama.cpp b11695, CUDA 13.0, port 18182 |

The GGUF identifies itself as **Qwen3.8 2B**, architecture `qwen35`. Its distillation provenance has **not** been verified. See [weight hashes and runtime metadata](deployment/model-manifest.json). Weights and GPU dependencies are external to the desktop ZIP.

## Memory lifecycle

- A fresh task calls `memory_digest` for bounded approved evidence, with IDs and explicit truncation metadata.
- `memory_absorb` archives dated user/assistant turns using stable session/event identifiers and queues recoverable processing.
- Candidate extraction requires exact source quotes. Judge supplies structured durability, importance, category and risk advice. Verification and vector-neighbor comparison detect unsupported claims, duplicates and conflicts. Assistant-only claims remain pending; source archives are retained.
- Fresh data directories default to manual approval. This machine explicitly enables automatic consolidation with verification. A direct user request to remember is preserved, without bypassing source/risk checks. Failures remain retryable, with a five-attempt durable queue.
- Approved memories receive Markdown mirrors and incremental embeddings. Missing models are disclosed as unavailable or lexical-only retrieval.

Judge is an adviser, not the entire router: deterministic rules combine its output, provenance, conflicts and operator policy. Embedding encodes text; Rust ranks vectors. Six base categories coexist with separate domain/learning-level metadata and typed relationships. A project scopes retrieval without requiring disconnected discipline-specific databases.

## MCP and the DSH integration

The default surface has **22 tools** over stdio or optional bearer-protected Streamable HTTP. It includes capture/recall/classification, `memory_absorb`, `memory_digest`, jobs/retry, model-role inspection and workflow save/run/history. Review is a local UI action unless the operator explicitly enables `MEMORA_ENABLE_REVIEW=1`.

```powershell
../.venv/Scripts/python -m memora --data ../data setup
../.venv/Scripts/python -m memora --data ../data serve --port 8765 --mcp-port 18184
./integrations/dsh/Install-Dsh.ps1 -DshRoot <path-to-your-dsh-install>
```

DSH uses its official MCP client plus a separate lifecycle plugin: recall before the first step, automatic capture on idle, durable outbox delivery and expiring heartbeats. The existing desktop profile has been configured without changing DSH core source. A **real shipped `sdk-minimal` two-session test passed**: session B received automatically recalled evidence from A, using local Qwen and no cloud credentials. Other MCP hosts can connect, but lifecycle automation requires host support; universal compatibility is not claimed. Peer identities are self-reported, not authenticated identity discovery.

## Model orchestration

Primary Embedding/Judge endpoints are edited under Model Connections. The orchestration page provides an editable completion-model pool, eight supplementary role bindings and 1–12 ordered stages.

| Roles | Status |
|---|---|
| curator / verifier / relation | Default bindings reuse the supplied 2B Judge; exercised in the accumulation path |
| summarizer / documenter | Explicit per-stage selection; a real local summarization run completed |
| classifier / sql_analyst | Classification and predefined read-only record analysis operations implemented |
| router | Binding contract reserved; current dispatch follows declared order, not autonomous model planning |

Seven operations cover summarization, Markdown organization, classification, relation proposals, read-only SQL analysis, verification and memory assessment. Stages record model identities and input/output hashes; changed content becomes a **new draft**, preserving source dates/version. Model-generated SQL/scripts are never executed. This is a bounded sequential workflow facility, not a generic DAG executor. Interrupted document workflows must be rerun; the accumulation queue has separate durable recovery.

## Storage, Markdown and brain views

`data/memory.sqlite3` preserves schema v2, memory IDs and fingerprints. Sidecars are `memora-documents.sqlite3`, `memora-control.sqlite3` and `memora-jobs.sqlite3`. SQL is authoritative; `markdown/` and `documents/` hold repairable Markdown mirrors. Immutable versions retain original dates. human/agent/shared audiences describe purpose, not access control. Back up the **whole** data directory after stopping every writer; individual database backups are not an atomic multi-database snapshot.

Retained semantic/hierarchical brain views include 2D/3D switching, search, layouts, camera focus, distance fog and directional hierarchy flow. Connections reflect stored relationships; layout distance is not semantic evidence. No reference dictionary dataset is bundled.

## Technology choices

| Technology | Actual responsibility |
|---|---|
| Rust / PyO3, native kernel 1.0.2 | Exact vector top-k and RRF hot loops; required by the desktop build; independently versioned from app 1.2.0 |
| SQLite / FTS5, native C | Transactions, full-text search, provenance and audit |
| Python 3.12 / MCP SDK | Model I/O, bounded routing, leased jobs, documents and transport |
| C++ / llama.cpp b11695 / CUDA 13.0 | GPU GGUF inference; RTX 5080 Laptop, sm_120 |
| PyTorch 2.13.0+cu130 / transformers 5.19.0 | Official safetensors embeddings, private WSL environment |
| TypeScript / three.js / Rust WASM | Retained graph visualization and layout physics |
| Electron 44.7.2 / PyInstaller 6.22.3 | A single unpack-and-run Windows shell/backend |

Native code handles measured computational boundaries; Python handles I/O and orchestration. Rewriting every module cannot remove inference latency. Retrieval is currently exact scanning, appropriate to the present scale; million-record ANN/sharding needs separate evaluation. No unmeasured end-to-end speedup is claimed. No additional mandatory Tauri shell is introduced.

## Development and modules

`core.py` composes `service.py`, `accumulation.py`, `jobs.py`, `model_registry.py`, `workflows.py`, `documents.py` and `control.py`; `mcp.py` / `gateway.py` expose transports. `native/`, `frontend/`, `desktop/`, `deployment/` and `integrations/dsh/` keep retrieval, views, shell, inference and host integration separate. The packaged build carries **every** module under `memora/` (staged by discovery, force-included in the PyInstaller graph), so the desktop surface equals the source surface; nothing is source-only.

This repository root **is** the source tree. Its siblings outside the repository are the packaged application (`../memora-desktop-standalone`) and the install packages (`../memora-release`); build output, caches, the development memory store and runtime state live inside the repository. See [directory layout](docs/DIRECTORY-LAYOUT.md) before moving anything — scripts resolve the project root through `tools/paths.py`, which is the single source of truth for the layout.

```powershell
# from the repository root
.venv/Scripts/python -m pip install -r requirements-lock.txt
.venv/Scripts/python -m pip install -e .
.venv/Scripts/python -m pip install ./native
.venv/Scripts/python tools/run_checks.py
node --test frontend/tests/*.test.mjs
node frontend/build.mjs
.venv/Scripts/python tools/build_desktop.py    # -> ../memora-desktop-standalone/Memora.exe
.venv/Scripts/python tools/smoke_desktop.py    # -> reports/SMOKE_VALIDATION.json
.venv/Scripts/python tools/release.py --skip-build   # -> ../memora-release/memora-<version>-windows-x64.zip
```

### Verification baseline

Measured on this tree at 1.3.0 (reproduce with the commands in [QUALITY.md](docs/QUALITY.md)):

| Gate | Result |
|---|---|
| Python suite | `Ran 560 tests` — `OK (skipped=5)` with a build present, 7 without |
| Frontend (`node --test`) | 125 / 125 passing |
| `ruff check .` | All checks passed (ruff 0.17.1) |
| `mypy` | `Success: no issues found in 66 source files` (mypy 2.4.0) |

The skips are legitimate and enumerated in QUALITY.md: 4 require a deployed DSH profile, 1 needs the optional `pypdf` extra, and 2 compare the frozen bundle byte-for-byte — those two **run** when `dist/memora-backend` exists and skip when it does not, which is why the count is 5 with a build and 7 without. Node must be on `PATH`: without it 90 static UI tests **skip instead of failing** and 11 are never collected, which is why CI installs node first.

### Transport and desktop shell stability

Two subsystems were rebuilt in 1.3.0 and now have contracts rather than conventions:

- **HTTP transport.** `LoopbackHTTPServer` with a listen backlog of 128, HTTP/1.1 keep-alive, an explicit `Content-Length` on every response, gzip above 1400 bytes and a 100-request cap per connection. Measured 200 concurrent requests, 0 failures; the previous server returned ECONNREFUSED for 24 of 50. Read [TRANSPORT.md](docs/TRANSPORT.md) before changing any of it.
- **Desktop shell.** The Electron shell is a supervisor, not a launcher: it probes `/api/agent/status` for identity (`name`/`version`/`data_dir`), falls back across ports 18765–18795, restarts a backend that dies with bounded backoff (3 attempts at 500/1500/4000 ms) behind a reconnect page, writes a rolling `<data>/desktop.log`, and takes the whole process tree down with `taskkill /T`. Security boundaries — `contextIsolation`, `sandbox`, origin allowlist, https-only external links — are unchanged.

The repository has **no git remote**; `.github/workflows/ci.yml` defines five jobs but none has run on a hosted runner yet.

Day-to-day: `./dev-serve.ps1` runs the current source with live reload of edits; `./start-memora.ps1` starts the managed host plus the packaged desktop shell. Both use `<project>/data` for the memory store.

The existing machine is configured. On a new machine, deploy external weights and CUDA prerequisites first; see [operations](docs/OPERATIONS.md). The ZIP includes language runtimes but not model services. Source installation uses the dependencies above. Cloud endpoints require explicit per-role HTTPS consent and named environment variables for keys. `MEMORA_*` is canonical; `MM_*` is a compatibility fallback. Project-local data/cache/temp paths avoid splitting the active installation across workspaces. The WSL inference environment remains in its own user directory.

## Research and execution record

The independent [agentic-box/memora 0.5.5](https://github.com/agentic-box/memora) archive informed absorption, session guards, write gates, routing and hierarchy. Its conflicting Python package was **not installed**. Engram, Shodh, SynaBun and DSH memory informed module boundaries; license ambiguity and copyleft references are not silently treated as reusable Apache code. Existing storage and copied MIT graph sources were preserved. See [research and implementation](docs/IMPLEMENTATION-1.1.0.md).

Executed: reference/data continuity review → modular accumulation/orchestration → Rocky CUDA deployment → real MCP/DSH sessions → regression/UI checks → frozen desktop/ZIP. Historical schema names/canaries/license attribution stay stable. New code uses the Memora namespace; the old package is a thin compatibility layer, not a new-runtime dependency.

## References and open-source components

New code: Apache-2.0. Absorbed MIT implementations and graph sources retain their notices. See [LICENSE](LICENSE), [NOTICE](NOTICE), [third-party notices](THIRD_PARTY_NOTICES.md). The complete inherited inventory below is retained; historical license entries are not presented as newly reverified. Models and optional services retain their own terms.

| Project / 项目 | License / 许可 | Role / 用途 |
|---|---|---|
| [Memory Merge](https://github.com/Stark-work-1001/memory-merge) | MIT | 复用记忆内核 / reused memory core |
| [Obsidian 3D Mindmap](https://github.com/Stark-work-1001/obsidian-3d-mindmap) | MIT | 用户提供脑图源码的相关仓库 / related source repository |
| [Obsidian 3D Mindmap Refresh](https://github.com/Stark-work-1001/obsidian-3d-mindmap-refresh) | MIT | 用户提供双脑图源码的相关仓库 / related source repository |
| [Obsidian 3D Graph](https://github.com/Apoo711/obsidian-3d-graph) | MIT (copied notice) | 布局来源追溯 / inherited layout attribution; see THIRD_PARTY_NOTICES |
| [three.js](https://github.com/mrdoob/three.js) | MIT | 3D 渲染 / 3D rendering |
| [KaTeX](https://github.com/KaTeX/KaTeX) | MIT | 数学公式与字体 / math and fonts |
| [MCP Python SDK](https://github.com/modelcontextprotocol/python-sdk) | MIT | 内置 MCP stdio 服务 / built-in MCP server |
| [MCP Reference Servers / Memory](https://github.com/modelcontextprotocol/servers/tree/main/src/memory) | upstream MIT + Apache-2.0 notices | 知识图谱交换格式兼容 / graph interchange compatibility |
| [Mem0](https://github.com/mem0ai/mem0) | Apache-2.0 | 架构研究：记忆提炼；没有复制其实现 / research only |
| [Graphiti](https://github.com/getzep/graphiti) | Apache-2.0 | 架构研究：时间与来源关系；没有集成图数据库 / research only |
| [Ollama](https://github.com/ollama/ollama) | MIT | 本地模型 HTTP、发现、装卸 / local model protocol |
| [llama.cpp](https://github.com/ggml-org/llama.cpp) | MIT | 可选 C++ GGUF 推理 / optional C++ inference |
| [llama-cpp-python](https://github.com/abetlen/llama-cpp-python) | MIT | 可选 Python/C++ 桥接 / optional bindings |
| [LM Studio](https://lmstudio.ai/) | proprietary application | 可选兼容服务；未捆绑，非开源组件 / optional external app, not bundled |
| [Electron](https://github.com/electron/electron) | MIT + bundled notices | 桌面封装 / desktop shell |
| [electron-builder](https://github.com/electron-userland/electron-builder) | MIT | 桌面目录打包 / desktop packaging |
| [Tauri](https://github.com/tauri-apps/tauri) | MIT OR Apache-2.0 | 方案对比；1.0.0 未提供 Tauri 壳 / evaluated, not shipped |
| [PyO3](https://github.com/PyO3/pyo3) | MIT OR Apache-2.0 | 可选 Rust/Python 向量内核 / native vector kernel in standalone |
| [maturin](https://github.com/PyO3/maturin) | MIT OR Apache-2.0 | 可选 Rust 扩展构建 / native build |
| [wasm-bindgen](https://github.com/wasm-bindgen/wasm-bindgen) | MIT OR Apache-2.0 | 复制脑图的 Rust/WASM 桥 / inherited WASM bridge |
| [glam](https://github.com/bitshifter/glam-rs) | MIT OR Apache-2.0 | 脑图向量计算 / graph math |
| [serde](https://github.com/serde-rs/serde) | MIT OR Apache-2.0 | 脑图 WASM 序列化 / serialization |
| [serde-wasm-bindgen](https://github.com/RReverser/serde-wasm-bindgen) | MIT | WASM 数据转换 / WASM data conversion |
| [SQLite](https://sqlite.org/) | public domain | 本地事务存储和 FTS5 / storage and lexical index |
| [Python / CPython](https://github.com/python/cpython) | PSF-2.0 + included notices | 后端运行时 / backend runtime |
| [Rust](https://github.com/rust-lang/rust) | MIT OR Apache-2.0 | 可选本地内核与脑图 WASM / native and WASM tooling |
| [Node.js](https://github.com/nodejs/node) | MIT + included notices | 前端构建与 Electron 运行时 / build runtime |
| [TypeScript](https://github.com/microsoft/TypeScript) | Apache-2.0 | 复制的脑图源码 / typed graph source |
| [esbuild](https://github.com/evanw/esbuild) | MIT | 离线前端打包 / offline frontend bundles |
| [PyInstaller](https://github.com/pyinstaller/pyinstaller) | GPL-2.0-or-later with bootloader exception | 独立后端发布包 / frozen backend packaging |
| [Sentence Transformers](https://github.com/huggingface/sentence-transformers) | Apache-2.0 | 可选进程内向量后端 / optional embedding backend |
| [pypdf](https://github.com/py-pdf/pypdf) | BSD-3-Clause | 可选 PDF 导入 / optional PDF ingestion |
| [Qwen3 Embedding](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B) | Apache-2.0 (model card) | 原系统向量预设；不捆绑权重 / embedding preset, no weights bundled |
| [Dictionary of AI Coding](https://github.com/mattpocock/dictionary-of-ai-coding) | see upstream content terms | 复制代码中的词典来源追溯；不发布词典数据 / attribution only, dataset excluded |
| [AI Coding Dictionary](https://www.aicodingdictionary.com/) | see upstream content terms | 词义图原始设计参考；不捆绑站点内容 / design attribution, not bundled |
| [AI Hero](https://www.aihero.dev/) | see site terms | 上游词典内容署名 / upstream content attribution |
| [Basic Memory](https://github.com/basicmachines-co/basic-memory) | AGPL-3.0-or-later (provided checkout) | Markdown knowledge links; design study only / 仅研究，未复制代码 |
| [MCP Memory Service](https://github.com/doobidoo/mcp-memory-service) | Apache-2.0 (historical inventory) | MCP + local retrieval comparison / 检索方案对比 |
| [灵枢 LINGSHU / DSH Memory](https://github.com/FuRongJun-1999/dsh-memory) | MIT (provided 0.8.1) | Source conditions, evidence and confirmed writes; no code copied / 来源与条件路由研究 |
| [Engram (Go)](https://github.com/Gentleman-Programming/engram) | MIT (reference inventory) | Provided source and Windows 3.4.0 archives; FTS-first continuity / 工程记忆方案 |
| [Engram (Python)](https://github.com/raya-ac/engram) | Engram Public Use License 1.0 (provided 0.8.1) | Custom non-sale terms; no code incorporated / 自定义限制许可，仅研究 |
| [Engram (deepseek-ai)](https://github.com/deepseek-ai/Engram) | Apache-2.0 (reference inventory) | Model-internal memory research, different from an agent store / 模型内记忆研究 |
| [engram-mcp](https://github.com/edg-l/engram-mcp) | Conflicting MIT / Apache-2.0 metadata in provided 0.11.0 | Rust + SQLite comparison; no code copied / Rust 方案研究，许可待上游澄清 |
| [Memora (agentic-box; separate project)](https://github.com/agentic-box/memora) | MIT (provided memora-mcp 0.5.5) | Same-name independent project; collective MCP memory research / 同名独立项目，未移植 |
| [MemoRAG](https://github.com/qhjqhj00/MemoRAG) | MIT (provided 0.1.5 notice) | Memory model → retrieval → generation; not shipped / 长上下文研究，未集成权重 |
| [Shodh Memory](https://github.com/varun29ankuS/shodh-memory) | Apache-2.0 (provided notice) | Rust/edge memory and non-LLM retrieval comparison / 边缘记忆研究 |
| [SynaBun](https://github.com/danilokhury/Synabun) | Apache-2.0 (provided 2.0.4 notice) | Local memory/3D interface/agent workspace comparison / 本地协作界面对比 |
| [3d-force-graph](https://github.com/vasturiano/3d-force-graph) | MIT | Camera focus, DAG and directional particles studied; own implementation / 交互研究，独立实现 |
| [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol) | See upstream specification terms | Tool transport and coordination boundaries / MCP 协议参考 |
| [A2A protocol](https://github.com/a2aproject/A2A) | Apache-2.0 | Task interoperability reference; no A2A compliance claimed / 任务协议对比，未宣称兼容实现 |
| [Letta](https://github.com/letta-ai/letta) | Historical snapshot: see REFERENCES.md | Inherited design study; not a runtime dependency / 继承研究，非运行依赖 |
| [Zep](https://github.com/getzep/zep) | Historical snapshot: see REFERENCES.md | Inherited design study; not a runtime dependency / 继承研究，非运行依赖 |
| [Cognee](https://github.com/topoteretes/cognee) | Historical snapshot: see REFERENCES.md | Inherited design study; not a runtime dependency / 继承研究，非运行依赖 |
| [MemOS](https://github.com/MemTensor/MemOS) | Historical snapshot: see REFERENCES.md | Inherited design study; not a runtime dependency / 继承研究，非运行依赖 |
| [Memobase](https://github.com/memodb-io/memobase) | Historical snapshot: see REFERENCES.md | Inherited design study; not a runtime dependency / 继承研究，非运行依赖 |
| [A-MEM](https://github.com/agiresearch/A-mem) | Historical snapshot: see REFERENCES.md | Inherited design study; not a runtime dependency / 继承研究，非运行依赖 |
| [LightRAG](https://github.com/HKUDS/LightRAG) | Historical snapshot: see REFERENCES.md | Inherited design study; not a runtime dependency / 继承研究，非运行依赖 |
| [MCP reference servers](https://github.com/modelcontextprotocol/servers) | Historical snapshot: see REFERENCES.md | Inherited design study; not a runtime dependency / 继承研究，非运行依赖 |
| [Claude-Mem](https://github.com/thedotmack/claude-mem) | Historical snapshot: see REFERENCES.md | Inherited design study; not a runtime dependency / 继承研究，非运行依赖 |
| [LangMem](https://github.com/langchain-ai/langmem) | Historical snapshot: see REFERENCES.md | Inherited design study; not a runtime dependency / 继承研究，非运行依赖 |
| [Hindsight](https://github.com/vectorize-io/hindsight) | Historical snapshot: see REFERENCES.md | Inherited design study; not a runtime dependency / 继承研究，非运行依赖 |
| [OpenViking](https://github.com/volcengine/OpenViking) | Historical snapshot: see REFERENCES.md | Inherited design study; not a runtime dependency / 继承研究，非运行依赖 |
| [Qwen3-Embedding evaluation code](https://github.com/QwenLM/Qwen3-Embedding) | Historical snapshot: see REFERENCES.md | Inherited design study; not a runtime dependency / 继承研究，非运行依赖 |
| [sqlite-vec](https://github.com/asg017/sqlite-vec) | Historical snapshot: see REFERENCES.md | Inherited design study; not a runtime dependency / 继承研究，非运行依赖 |
| [Qwen3-Embedding-0.6B-GGUF](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF) | See historical model card inventory | Model research only; no weights bundled / 模型参考，不含权重 |
| [Qwen3-1.7B-GGUF](https://huggingface.co/Qwen/Qwen3-1.7B-GGUF) | See historical model card inventory | Model research only; no weights bundled / 模型参考，不含权重 |
| [Qwen3.8-2B-Distill](https://huggingface.co/empero-ai/Qwen3.8-2B-Distill) | See historical model card inventory | Model research only; no weights bundled / 模型参考，不含权重 |

| [agentic-box/memora 0.5.5](https://github.com/agentic-box/memora) | MIT in supplied archive | Absorption, session guards, write gates and hierarchy design study; not installed / 设计参考，不安装同名包 |
| [Qwen3-Embedding-0.6B](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B) | Apache-2.0 model card | Actual local safetensors model; last-token pooling / 本地实际向量模型 |
| [llama.cpp b11695](https://github.com/ggml-org/llama.cpp/tree/b11695) | MIT | Actual external CUDA Judge runtime / 实际外部推理 |
| [llama.cpp server](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md) | MIT | OpenAI-compatible server deployment / 部署参考 |
| [Engram MCP](https://github.com/edg-l/engram-mcp) | MIT in provided Cargo.toml; verify upstream LICENSE before copying | Rust modularity/retrieval design study; no code copied / Rust 模块化设计参考 |
| [PyTorch](https://github.com/pytorch/pytorch) | BSD-3-Clause | Actual WSL embedding runtime / 实际向量推理依赖 |
| [Transformers](https://github.com/huggingface/transformers) | Apache-2.0 | Official model loading and last-token encoding / 官方模型加载 |
| [CUDA Toolkit](https://developer.nvidia.com/cuda-toolkit) | NVIDIA terms; not wholly open source | External CUDA 13.0 compiler/runtime / 外部 GPU 工具链 |

Complete installed/build dependency links: [DEPENDENCIES](docs/DEPENDENCIES.md). Inference versions: [Rocky lock](deployment/inference-rocky.lock.txt). These inventories distinguish deployment/build packages from actual frozen runtime imports.

Desktop startup repair / 桌面启动修复：[diagnosis and validation](docs/DESKTOP-STARTUP-FIX-1.1.0.md). Windows references: [Mandatory Integrity Control](https://learn.microsoft.com/en-us/windows/win32/secauthz/mandatory-integrity-control), [image-load policy](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-process_mitigation_image_load_policy), [token policy](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-token_mandatory_policy). Compared [Electron sandbox issue 51761](https://github.com/electron/electron/issues/51761); its DACL workaround was not adopted. These are diagnostic references, not added runtime dependencies.
