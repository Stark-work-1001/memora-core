# memora 1.0.2

[中文](README.zh-CN.md) · [Architecture preview](docs/Minimal-Architecture.svg.html) · [Change log](CHANGELOG.md) · [Run the desktop](RELEASE_NOTES.en.md)

**A focused memory application for connected agents: retrieve, classify and consolidate memory, manage Markdown, and explore knowledge in 2D/3D.** There is one application and one build. Existing extended components remain in the source tree.

![Architecture](docs/Minimal-Architecture.svg)

## What the default application does

- Connect agents through 11 MCP tools; show reported agent/model identities and expiring heartbeat status. Reasoning and task scheduling stay with the connecting agent.
- Capture and deduplicate sourced memory. Judge proposes a validated category, durability and risk assessment; deterministic routing saves its destination. Candidates remain reviewable. User confirmation consolidates them into retrieval and Markdown mirrors.
- Retrieve approved memory using Rust exact vector top-k/RRF and SQLite FTS5. Responses disclose actual retrieval mode and missing model/index coverage. Without an embedding provider, only lexical retrieval is available.
- Manage immutable human/agent/shared Markdown versions, original dates, drafts, publication and mirror repair. Published documents can become pending knowledge chunks for review and indexing.
- Retain semantic and hierarchical brain views, 2D/3D switching, search, layouts, focus/camera rotation, fog and hierarchy flow. Stored relations are distinct from geometric proximity. No reference dictionary content is bundled.

The default build does not start a chat model, scan local conversation histories, execute workflows or dispatch tasks. Their existing source components are preserved and accessible from the source installation's extended CLI.

## Develop and run

```powershell
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements-lock.txt
.venv/Scripts/python -m pip install -e .
# Native kernel: requires Rust and Windows MSVC build tools
.venv/Scripts/python -m pip install ./native
.venv/Scripts/python -m memora --data ./agent-data serve --port 8765
```

Open `http://127.0.0.1:8765`, or run `start-memora.ps1`. Point `--data` at an existing memory directory to keep its database, IDs, dates, document versions and relations. The default desktop retains its existing Electron user-data location. No project data is moved by a build.

Configure two roles under **Model connections**. Local endpoints include `http://127.0.0.1:11434/v1` (Ollama) and `http://127.0.0.1:1234/v1` (LM Studio/compatible server). Cloud connections require an explicitly selected HTTPS endpoint. Keys are read from named environment variables and are not written into `memora.json`. Source installations also retain environment-configured sentence-transformers/GGUF backends. No weights or live model connections are provided by default.

`MEMORA_*` is the canonical environment prefix, with existing `MM_*` values accepted as fallback. For example: `MEMORA_EMBED_URL`, `MEMORA_EMBED_MODEL`, `MEMORA_JUDGE_URL`, `MEMORA_JUDGE_MODEL`, `MEMORA_ALLOW_REMOTE=1`. `MEMORA_DATA` selects storage. Existing populated legacy data locations are detected before creating an empty default store.

## Agent connection

```powershell
.venv/Scripts/python -m memora --data ./agent-data setup
```

Paste the generated configuration into the agent host. The workbench also displays an absolute configuration for the running installation. MCP clients refresh `memora.json` on their next call after a UI change. Have the agent call `memory_peer_heartbeat` every 30 seconds; a stdio configuration alone does not imply a live peer. Peer identity is self-reported by a trusted connected client, not authenticated identity discovery.

The tools are `memory_status`, `memory_peer_heartbeat`, `memory_peers`, `memory_capture`, `memory_recall`, `memory_classify`, `memory_queue`, `memory_index`, `memory_document_list`, `memory_document_get`, and `memory_document_put`. Review is available in the local UI; an operator-controlled MCP host can explicitly enable `MEMORA_ENABLE_REVIEW=1`. The connecting agent supplies captured content; default memora does not run a separate conversation summarizer. Judge advises, routing maps its output to a memory destination, and neither is an autonomous dispatcher.

## Architecture and technology

| Layer | Responsibility | Why retained |
|---|---|---|
| Rust + PyO3 | Exact cosine top-k and reciprocal rank fusion | Native retrieval loops; mandatory in the standalone build, explicit Python fallback in source mode |
| SQLite / FTS5, native C | Authoritative transactions, full-text retrieval, provenance, audit | Mature storage; existing schema v2 and vector fingerprints remain compatible |
| Python | Thin MCP/HTTP service, model I/O, classification routing, Markdown lifecycle | Reuses proven storage and adapters; does not duplicate native retrieval loops |
| TypeScript / three.js / Rust WASM | Retained 2D/3D views and layout physics | Brain assets load only when opened; existing graph implementation preserved |
| Electron + frozen Python | Unpack-and-run Windows desktop | Reuses the existing shell and runtime; Tauri is not added as another mandatory shell |
| C++ / llama.cpp | Optional external model service or source-only binding | No inference engine, model weights or GPU runtime is forced into the default build |

This is a reduced runtime dependency graph, not a claim that rewriting all Python in Rust would make model calls faster. Vector encoding/Judge latency depends on configured models; Electron remains the largest fixed desktop runtime cost. No new end-to-end speedup is claimed without measurement.

## Source layout and build

| Path | Purpose |
|---|---|
| `memora/` | Absorbed implementation: `core.py`, `service.py`, `store.py`, `mcp.py`, `workbench.py` |
| `memora/documents.py`, `memora/projections.py`, `memora/static/brain/` | Preserved Markdown and brain functionality |
| `memora/agent.py`, `workflows.py`, `local_sources.py`, `bridge.py`, `advanced.py` | Retained extended components; not included in the focused desktop backend |
| `memory_merge/` | Thin legacy import/CLI aliases; no second implementation or runtime dependency for the new application |
| `native/`, `frontend/`, `desktop/` | Rust kernel, retained graph sources and Electron shell |
| `tools/build_desktop.py`, `tools/smoke_desktop.py`, `tools/release.py` | Unified build, isolated smoke tests, local ZIP packaging |
| `tools/legacy/`, `docs/history/1.0.1/` | Historical scripts and guides; not active build entry points |
| `dist/desktop/win-unpacked/` | Single standalone desktop output; no root `public/` or `release/` trees |

```powershell
.venv/Scripts/python -m unittest discover -s tests -v
npm --prefix frontend test
# Rebuild graphs only when their sources change
npm --prefix frontend run build
.venv/Scripts/python tools/build_desktop.py
.venv/Scripts/python tools/smoke_desktop.py
.venv/Scripts/python tools/release.py --skip-build
```

Extended source workbench: `python -m memora --data ./agent-data advanced agent --port 8766`. Old `memory-merge` commands/imports are compatibility aliases. Historical names inside schema triggers, canary strings and license attribution remain intentionally stable to protect existing data and upstream provenance; active Memora builds do not load the legacy package.

## Research conclusion and execution record

Use one memory lifecycle and existing storage instead of assembling multiple agent orchestration systems. Separate semantic relations from learning hierarchy, keep Markdown revisions independent of approved memory, and keep model output advisory. Small models cooperate through bounded tool inputs and verified output; the connecting agent owns scheduling. LINGSHU/DSH is a design reference for conditions and provenance, not a runtime protocol dependency.

The 1.0.2 execution plan was namespace absorption → focused runtime/CLI/MCP → retained document and graph adapters → one allowlisted build → lifecycle, regression and desktop validation. See [implementation record](docs/REFACTOR-1.0.2.md) and [change log](CHANGELOG.md). Existing references below are historical research/reuse records, not newly verified license claims. The original [research inventory](docs/REFERENCES.md) and [copied-source notices](THIRD_PARTY_NOTICES.md) distinguish copied implementation, optional dependencies and design-only references.

## References and open-source components

Apache-2.0 applies to Memora's new work. Absorbed MIT code retains its licenses/notices. Model, optional service and reference project licenses remain their own. LM Studio is an optional proprietary application, not an open-source component. See [LICENSE](LICENSE), [NOTICE](NOTICE), [third-party notices](THIRD_PARTY_NOTICES.md), [research inventory](docs/REFERENCES.md) and the full inventory below.

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

