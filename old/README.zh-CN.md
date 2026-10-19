# memora 1.3.0 · 记忆体

> **旧版本线（归档）。** 本目录保存重写前的 **memora 1.x** 代码库（Apache-2.0），
> 公开仅供历史留存与查阅。仓库根目录的 **memora-core** 才是当前维护的发布版。
> 本目录不是当前产品：按其当时的形态公开，仅移除了本地路径与个人标识。
> 公开前的逐处改动见 [docs/DESENSITIZATION-AUDIT-public.md](docs/DESENSITIZATION-AUDIT-public.md)。

本次开发目录升级提供统一知识检索、8 类可编辑记忆工作流、Embedding / Judge / Rerank 能力分工、
来源核验和二维／三维记忆选择保持。详见 [升级与研究映射](docs/UPGRADE-MEMORY-SYSTEM.md) 和
[智能体接入](docs/AGENT-CONNECTIONS.md)。**开发更新不会自动同步 standalone。**

[English](README.md) · [架构](docs/ARCHITECTURE.md) · [传输层契约](docs/TRANSPORT.md) · [质量门禁](docs/QUALITY.md) · [规划](docs/ROADMAP.md) · [运行维护](docs/OPERATIONS.md) · [目录布局](docs/DIRECTORY-LAYOUT.md) · [决策记录](docs/DECISIONS.md) · [改动记录](CHANGELOG.md)

**为智能体积累和检索长期记忆。** 会话经 MCP 进入 Markdown / SQL 归档，提炼模型生成有出处的候选，Judge 判定持久性与风险，规则路由和来源核验决定待审或按策略沉淀，再由 Embedding 和 Rust 检索内核提供召回。保留 Markdown 文档库和二维／三维脑图；新增可编辑模型池、分工和文档工作流。

一份代码、一套功能、一个桌面构建；不区分自用版与发布版。本 README 介绍仓库，解压包的启动和升级说明见 [Release 使用说明](RELEASE_NOTES.zh-CN.md)。

![模块化架构](docs/ARCHITECTURE-1.1.0.svg)

## 当前部署与启动

本次实际部署：项目与运行数据就在本 README 所在目录，模型权重单独放在部署时指定的权重目录（不随仓库分发），推理运行于 WSL 发行版。双击根目录 **`Start-Memora.cmd`**，或：

```powershell
.\start-memora.ps1              # 模型服务、共享后端、桌面窗口
.\start-memora.ps1 -Headless    # 模型服务与后台服务
# 浏览器界面 http://127.0.0.1:8765
# MCP HTTP  http://127.0.0.1:18184/mcp（Bearer 令牌）
```

现有两个模型已真实启用，不是占位连接：

| 实际模型 / 别名 | 职责 | 部署 |
|---|---|---|
| Qwen3-Embedding-0.6B / `qwen3-embedding-0.6b` | 1024 维 last-token 向量编码，问题使用检索指令模板 | Rocky PyTorch / transformers，CUDA，18181 |
| 本地 Qwen3.8-2B-Q4_K_M.gguf / `qwen3.8-2b-judge` | Judge 分类、持久性、重要性、风险；复用于提炼、核验、语义比较 | Rocky llama.cpp b11695，CUDA，18182 |

GGUF 元数据名称为 **Qwen3.8 2B**，架构 `qwen35`；“Distill”训练来源尚未核实，不将文件名称当作模型血统证明。权重校验和与运行参数见 [模型清单](deployment/model-manifest.json)。不把模型权重和 GPU 环境塞进桌面 ZIP。

## 记忆如何随使用积累

1. 新任务通过 `memory_digest` 取得有来源、带大小预算的已审核记忆。
2. `memory_absorb` 接收用户／助手消息及原始日期、会话标识、稳定事件 ID；保存 SQL 和带日期的 Markdown 草稿，再创建持久任务。
3. 提炼要求原文精确引句；Judge 输出经过结构验证，再做来源核验和向量邻近记忆比较。仅助手声称的事实不能自动通过。冲突留待审；等价提案关联到既有记忆，保留原会话。
4. 默认新数据目录关闭自动沉淀；本次本地部署已开启带核验的策略。只有通过持久性、风险、来源等门槛的候选才能沉淀。明确“请记住”的用户意图保留，但不绕过风险和来源检查。
5. 已通过记忆进入 Markdown 镜像和增量向量索引。中断任务由租约恢复，五次失败后可在界面重试。模型不可用不伪装成成功。

**Judge 不是整个重定向器。** 它提供判定建议，确定性规则结合政策、核验和冲突决定去向。Embedding 只编码；Rust 做相似度排序。六个基础类别是事实、知识、决策、偏好、操作步骤和经验教训；领域、学习层级及语义关系是独立维度。项目先限定检索范围，不强制把物理／化学等学科拆成互不连通的数据库。

## MCP 和 DSH 测试对象

默认 22 个 MCP 工具，支持 stdio 与可选带 Bearer 的 HTTP。核心入口：`memory_absorb`、`memory_digest`、`memory_recall`、`memory_capture`、`memory_queue`、`memory_job_get/retry`、`memory_models`、`memory_workflow_save/run/runs`。本地界面审核；只有操作者显式设置 `MEMORA_ENABLE_REVIEW=1` 才暴露审核工具。

```powershell
../.venv/Scripts/python -m memora --data ../data setup
../.venv/Scripts/python -m memora --data ../data serve --port 8765 --mcp-port 18184
# DSH 现有 desktop profile：备份后只安装 Memora 管理的插件块
.\integrations\dsh\Install-Dsh.ps1 -DshRoot <你的 DSH 安装目录>
```

DSH 使用官方 MCP 插件加本项目生命周期插件：首步自动召回、空闲时自动归档、每 30 秒心跳和发件箱重试。**真实 DSH `sdk-minimal` 双会话测试已通过**：A 记住验证饮品，B 自动召回并回答；使用本地 Qwen，无云端凭据。桌面 profile 已安装适配，未修改 DSH 核心源码。实际运行报告见 [验证说明](docs/VALIDATION-1.1.0.md)。其他宿主可按 MCP 接入，但自动回调需宿主支持；不宣称所有智能体均已逐一验证。心跳身份由接入方自报，不是身份认证。

## 工作流与模型编排

“模型连接”管理 Embedding / Judge 两个基础角色；“工作流与模型编排”可编辑本地或云端模型池、8 个补充角色绑定和按顺序执行的 1—12 个处理阶段。

| 补充角色 | 当前使用情况 |
|---|---|
| curator 记忆提炼、verifier 来源核验、relation 语义比较 | 默认复用现有 2B Judge，真实积累链路已调用 |
| summarizer 两层项目归纳、documenter Markdown 重组 | 可在工作流选择任意已配置模型；本地摘要实测通过 |
| classifier 领域／层级、sql_analyst 只读数据分析 | 已实现相应工作流操作，按阶段显式选模型 |
| router 路由模型 | 保留绑定契约；当前按用户声明的阶段顺序调度，不声称已启用自主规划模型 |

7 类操作：两层摘要、Markdown 重组、分类、关系提案、只读 SQL 分析、核验、记忆价值评估。每个阶段保存模型标识、输入／输出散列和结果；处理后生成**新草稿**，保留源日期与版本。SQL 仅提供预定义参数化查询的结果，不执行模型生成的 SQL。当前是有界顺序工作流，不是任意代码执行器或通用 DAG 平台；工作流进程中断需重新运行，自动积累队列另有持久恢复机制。

## 存储、文档和脑图

`data/memory.sqlite3` 保持原 schema v2、记忆 ID、向量指纹和来源；文档、协作、任务分别位于 `memora-documents.sqlite3`、`memora-control.sqlite3`、`memora-jobs.sqlite3`。Markdown 在 `data/markdown/` 和 `data/documents/`，SQL 是权威记录，文件是可修复镜像。用途分 human / agent / shared，不把用途标签当作权限隔离。保留原始日期、不可变版本和发布状态。

脑图保留词义关系／学习层级、二维／三维、布局、搜索、相机聚焦、距离雾化和层级流动，按需加载。连线取自已保存关系；布局距离不是事实证据。不捆绑参考网站词典内容，不修改外部参考目录。

## 技术栈与选择

| 技术 | 实际职责与判断 |
|---|---|
| Rust + PyO3，原生内核 1.0.2 | 精确 top-k / RRF 热循环；桌面包必须包含。应用版本 1.2.0 与独立内核版本不同属正常 |
| SQLite / FTS5（C） | 事务、全文检索、日期、来源和审计；延续验证过的存储而非重写数据库 |
| Python 3.12 / MCP SDK | 模型 I/O、路由、文档、HTTP / MCP、任务租约；不承担向量扫描热循环 |
| C++ / llama.cpp b11695，CUDA 13.0 | GGUF Judge GPU 推理，RTX 5080 Laptop，sm_120 |
| PyTorch 2.13.0+cu130 / transformers 5.19.0 | 官方 safetensors Embedding 编码；独立 WSL 虚拟环境 |
| TypeScript / three.js / Rust WASM | 保留的 2D／3D 视图和布局物理 |
| Electron 44.7.2 / PyInstaller 6.22.3 | 单一 Windows 解压即用 UI / 冻结后端；不再并列增加必须维护的 Tauri 壳 |

把计算热路径交给 Rust / C++，把 Python 用于编排与 I/O，比只按语言名称重写所有模块更可维护。当前向量检索仍为精确扫描，适合现有规模；百万级数据需独立评估 ANN 与分片。未测量端到端对照前不宣称 Rust 能让所有步骤同比提速。

## 模块与开发

`memora/core.py` 组合模块；`service.py` 检索；`accumulation.py` 积累；`jobs.py` 持久队列；`model_registry.py` 模型角色；`workflows.py` 文档编排；`mcp.py` / `gateway.py` 传输；`documents.py` 文档；`control.py` 协作元数据。`native/`、`frontend/`、`desktop/` 分别为检索内核、脑图和桌面壳；`deployment/` 部署；`integrations/dsh/` 宿主适配。打包版包含 `memora/` 下的**全部**模块（按目录自动收集 + PyInstaller 强制包含），桌面功能面与源码完全一致，没有「源码才有」的模块。

**仓库根就是源码树。** 仓库外的同级目录只有两个：打包成品 `../memora-desktop-standalone` 与安装包 `../memora-release`。构建产物、缓存、开发期记忆库与运行时状态都在仓库内。移动任何东西前先看 [目录布局](docs/DIRECTORY-LAYOUT.md)——脚本统一经 `tools/paths.py` 推导项目根，那是布局的唯一真源。

```powershell
# 在仓库根目录执行
.venv/Scripts/python -m pip install -r requirements-lock.txt
.venv/Scripts/python -m pip install -e .
.venv/Scripts/python -m pip install ./native
# 现有 Rocky 已部署。新机器需 CUDA、C++ 编译工具及模型，安装步骤见运行维护文档。
.venv/Scripts/python tools/run_checks.py
node --test frontend/tests/*.test.mjs
node frontend/build.mjs
.venv/Scripts/python tools/build_desktop.py          # 产出 ../memora-desktop-standalone/Memora.exe
.venv/Scripts/python tools/smoke_desktop.py          # 产出 reports/SMOKE_VALIDATION.json
.venv/Scripts/python tools/release.py --skip-build   # 产出 ../memora-release/memora-<version>-windows-x64.zip
```

### 验证基线

以下为 1.3.0 在本地实测值，复现命令见 [质量门禁](docs/QUALITY.md)：

| 门禁 | 结果 |
|---|---|
| Python 测试 | `Ran 560 tests` — `OK (skipped=5)`（有构建产物时；无构建为 7） |
| 前端 `node --test` | 125 / 125 通过 |
| `ruff check .` | All checks passed（ruff 0.17.1） |
| `mypy` | `Success: no issues found in 66 source files`（mypy 2.4.0） |

跳过项全部有正当理由（详见 QUALITY.md）：4 个需已部署的 DSH profile，1 个需可选依赖 `pypdf`，2 个比对冻结产物的用例在 `dist/memora-backend` 存在时会**真正执行**——所以跳过数是「有构建 5 / 无构建 7」。node 必须在 `PATH` 上：缺 node 时 90 个静态 UI 测试会**静默跳过而不是失败**，另有 11 个根本不会被收集，所以 CI 先装 node 再跑测试。

### 传输层与桌面壳的稳定性

1.3.0 重建了这两个子系统，它们现在有**契约**而不只是惯例：

- **HTTP 传输层。** `LoopbackHTTPServer`：listen backlog 128、HTTP/1.1 keep-alive、每个响应显式带 `Content-Length`、超过 1400 字节才 gzip、每连接最多 100 个请求。实测 200 并发 0 失败；改造前 50 并发有 24 次 ECONNREFUSED。改动前必读 [传输层契约](docs/TRANSPORT.md)。
- **桌面壳。** Electron 壳是 supervisor 而非启动器：用 `/api/agent/status` 校验身份（`name`/`version`/`data_dir`）、端口 18765–18795 自动回退、后端异常退出按 500/1500/4000ms 退避重启 3 次并显示重连页、写滚动 `<data>/desktop.log`、用 `taskkill /T` 清理整棵进程树。安全边界（`contextIsolation`、`sandbox`、Origin 白名单、外链仅 https）原样保留。

仓库**没有 git 远程**；`.github/workflows/ci.yml` 定义了 5 个 job，但都还没有在托管 runner 上跑过。

日常使用：`./dev-serve.ps1` 直接跑当前源码（改完刷新即见）；`./start-memora.ps1` 启动托管运行时并拉起打包桌面壳。两者都用 `<项目>/data` 作为记忆库。

记忆库在 `<仓库>/data/`，开发期临时文件在 `runtime/`，打包用的 Electron 缓存在 `cache/`。独立模型运行环境位于 Rocky 用户目录，权重仍在指定模型目录。全新源码安装需上述依赖；ZIP 自带 Python / Node / Rust 运行所需文件，外部推理服务仍单独部署。云端通过 HTTPS 和按角色显式授权接入，密钥只从指定环境变量读；不写入模型配置。`MEMORA_*` 为规范前缀，`MM_*` 仅兼容旧配置。

## 调研结论与执行记录

参考独立的 [agentic-box/memora 0.5.5](https://github.com/agentic-box/memora) 的吸收、会话守卫、写门、层级和路由设计，**没有安装其同名 Python 包**，避免命名空间冲突；保留本项目既有数据库。对参考目录里的 Engram、Shodh、SynaBun、DSH memory 进行模块职责对比；对许可有矛盾或强 copyleft 的实现保持设计参考，不拼接不兼容源码。详见 [实施与调研](docs/IMPLEMENTATION-1.1.0.md)。

本次执行：参考与数据连续性检查 → 模块化积累 / 编排 → Rocky CUDA 推理 → MCP / DSH 双会话实测 → 回归与图形界面检查 → 冻结构建 / 本地 ZIP。保留旧扩展源码和兼容别名；不让旧包名成为新运行时依赖。旧 schema 的触发器、探针字符串和许可归属保持稳定。

## 参考项目与开源方案

新增代码 Apache-2.0；吸收的 MIT 代码和双脑图源码保留版权与许可。[LICENSE](LICENSE)、[NOTICE](NOTICE)、[第三方说明](THIRD_PARTY_NOTICES.md) 区分实际复用与研究参考。下表保留历次完整清单，许可列属于历史调研记录，非本次逐项重新核验；模型和服务各自遵循上游条款。

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
