# memora 1.0.2 · 记忆体

[English](README.md) · [架构预览](docs/Minimal-Architecture.svg.html) · [改动记录](CHANGELOG.md) · [桌面使用说明](RELEASE_NOTES.zh-CN.md)

**面向智能体的精简记忆软件：连接智能体、检索记忆、分类与沉淀，同时保留 Markdown 文档管理和二维 / 三维脑图。** 统一一份代码、一套功能和一个构建，不再区分自用版与发布版。

![架构](docs/Minimal-Architecture.svg)

## 当前功能

- **智能体接入**：11 个默认 MCP 工具；显示接入方报告的名称、模型、位置与心跳状态。推理和任务调度由接入的智能体完成。
- **记忆分类与沉淀**：来源记录、去重、Judge 判定、分类与去向保存、待审、确认沉淀、增量向量索引和 Markdown 镜像。判定失败仍保留候选，可重试或手工分类。
- **记忆检索**：Rust 向量 top-k / RRF + SQLite FTS5；如实报告向量、混合或关键词检索及索引覆盖。未接向量模型时只有关键词检索，不伪装成语义检索。
- **Markdown 文档管理**：人类 / 智能体 / 共享用途、多版本、原始日期、导入、编辑、发布和镜像修复。文档发布后可分段进入待审知识；文档发布不等于记忆审核通过。
- **脑图**：保留词义关系与层级脑图、2D / 3D 切换、搜索、布局、节点聚焦与相机旋转、距离雾化、层级流动。布局距离不冒充语义证据；不捆绑参考词典的内容。

默认构建不启动独立聊天模型、会话扫描器、工作流或任务派发系统。这些已有组件仍保存在源码中，可从扩展入口使用。Markdown 与脑图仍属于当前应用。

## 开发与启动

```powershell
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements-lock.txt
.venv/Scripts/python -m pip install -e .
# Rust 内核需要 Rust / Windows MSVC 构建工具
.venv/Scripts/python -m pip install ./native
.venv/Scripts/python -m memora --data ./agent-data serve --port 8765
```

访问 `http://127.0.0.1:8765`，或运行 `start-memora.ps1`。使用 `--data` 指向已有数据目录，继续使用其中的数据库、记忆 ID、日期、文档版本和关系。桌面程序保持原 Electron 用户数据位置；构建不迁移用户数据。

在“模型连接”中配置两个职责：**Embedding** 将记忆和问题编码为向量，Rust 负责相似度排序；**Judge** 判断类别、持久性、重要性及风险，路由规则再将结果映射到记忆分类、短期信息或待审队列。Judge 提供判定依据，本身不等于完整的重定向器，也不负责智能体调度。来源文本由接入智能体提供，默认程序不另开一个会话总结模型。

本地可用 Ollama 的 `http://127.0.0.1:11434/v1`，或 LM Studio / llama.cpp 的 OpenAI 兼容接口。选择云端后填写对应的 HTTPS 地址。密钥只读取指定环境变量，不写进 `memora.json`。源码仍支持环境变量配置的 sentence-transformers / GGUF 可选后端；桌面包不强制捆绑这些重型依赖、权重和 GPU 运行时。

新配置使用 `MEMORA_*`，原 `MM_*` 作为兼容回退。例如 `MEMORA_EMBED_URL`、`MEMORA_EMBED_MODEL`、`MEMORA_JUDGE_URL`、`MEMORA_JUDGE_MODEL`，云端需明确设置 `MEMORA_ALLOW_REMOTE=1`。`MEMORA_DATA` 指定存储位置；已有旧默认目录存在数据库时会优先延续使用，避免升级后看到空库。

## 智能体连接

```powershell
.venv/Scripts/python -m memora --data ./agent-data setup
```

将输出配置加入智能体宿主。“智能体接入”页面也会显示当前安装的绝对路径配置。多个 MCP 宿主进程将在下次调用时刷新界面保存的模型配置。接入方每 30 秒调用 `memory_peer_heartbeat`；仅添加配置不代表在线，超时后显示离线。名称与模型是受信任接入方自报的信息，不是自动发现或身份认证。

默认工具：`memory_status`、`memory_peer_heartbeat`、`memory_peers`、`memory_capture`、`memory_recall`、`memory_classify`、`memory_queue`、`memory_index`、`memory_document_list`、`memory_document_get`、`memory_document_put`。用户在本地界面确认沉淀；操作者控制的 MCP 实例可显式启用 `MEMORA_ENABLE_REVIEW=1`。

## 技术栈与取舍

| 技术 | 当前职责 | 取舍 |
|---|---|---|
| Rust + PyO3 | 精确向量 top-k 与 RRF 融合 | 热循环下沉到原生内核；standalone 必须包含，源码可明确回退 |
| SQLite / FTS5（原生 C） | 事务、全文检索、来源、审计 | 继续使用成熟存储和兼容的 v2 数据结构，不重写底层数据库 |
| Python | 轻量 MCP / HTTP、模型 I/O、分类路由、文档生命周期 | 复用已验证实现；默认不加载聊天、扫描和工作流组件 |
| TypeScript / three.js / Rust WASM | 原有 2D / 3D 展示和布局物理 | 打开脑图时才加载；保留现有可视化实现 |
| Electron + 冻结 Python | Windows 解压即用桌面 | 延续已有封装，不再增加一套必需的 Tauri 壳 |
| C++ / llama.cpp | 可选外部推理，或源码环境的可选绑定 | 不把推理引擎、模型权重和 GPU 依赖强行打进精简包 |

简化针对运行依赖和职责。Python 不承担向量扫描热循环；模型编码与判定的耗时取决于模型服务。Electron 仍有固定体积和内存成本，本次不宣称未经实测的端到端提速。

## 开发目录与构建

| 目录 / 文件 | 用途 |
|---|---|
| `memora/` | 已吸收重构的主实现：`core.py`、`service.py`、`store.py`、`mcp.py`、`workbench.py` |
| `memora/documents.py`、`projections.py`、`static/brain/` | 保留的 Markdown 与脑图 |
| `memora/agent.py`、`workflows.py`、`local_sources.py`、`bridge.py`、`advanced.py` | 保留的扩展组件，默认桌面后端不打入 |
| `memory_merge/` | 旧导入 / CLI 薄兼容层，没有第二套实现，新程序不依赖它 |
| `native/`、`frontend/`、`desktop/` | Rust 内核、原有脑图源码、Electron 壳 |
| `tools/build_desktop.py`、`smoke_desktop.py`、`release.py` | 统一构建、隔离验证、本地 ZIP 打包 |
| `tools/legacy/`、`docs/history/1.0.1/` | 历史脚本与文档，不是当前构建入口 |
| `dist/desktop/win-unpacked/` | 唯一桌面构建产物；不重建根目录 `public/` 或 `release/` |

```powershell
.venv/Scripts/python -m unittest discover -s tests -v
npm --prefix frontend test
# 仅在修改脑图源码后重建图形资源
npm --prefix frontend run build
.venv/Scripts/python tools/build_desktop.py
.venv/Scripts/python tools/smoke_desktop.py
.venv/Scripts/python tools/release.py --skip-build
```

源码扩展入口：`python -m memora --data ./agent-data advanced agent --port 8766`。旧命令与导入通过兼容层延续。schema 触发器、模型校验文本与授权声明中的历史标识刻意保留；它们属于数据兼容和出处记录，不再定义当前运行架构。

## 调研结论与执行记录

使用统一的记忆生命周期，不再将多套智能体调度系统装进默认应用。语义关系与学习层级分开保存；Markdown 版本和已审核记忆分开管理；模型输出需经过结构校验与确认。“灵枢 / DSH”用于条件路由和来源设计的参考，不作为本程序的必需协议或核心依赖。

本次执行顺序：吸收命名空间 → 精简运行时 / CLI / MCP → 接回文档和脑图 → 单一白名单构建 → 流程、回归、桌面验证。详细见[重构记录](docs/REFACTOR-1.0.2.md)与 [Change log](CHANGELOG.md)。下面保留以前全部参考项目、链接、方案和用途；许可为既有调研快照，不将设计研究写成代码复用，不将参考项目写成当前依赖。原始调研细节见 [REFERENCES](docs/REFERENCES.md)。

## 参考项目与开源方案

本项目新增代码采用 Apache-2.0。吸收的 MIT 代码保留其版权、许可与出处；模型、可选服务及参考项目适用各自条款。LM Studio 属于可选专有应用，不列为开源组件。见 [LICENSE](LICENSE)、[NOTICE](NOTICE)、[第三方说明](THIRD_PARTY_NOTICES.md)及以下完整清单。

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

