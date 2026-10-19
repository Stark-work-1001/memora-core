# memora-core · 记忆中枢 / Memory Hub

> **中文** · [English](#english-readme)
> 发布仓库 / Published in: `github.com/Stark-work-1001/memora-core`

**把多个智能体散落的记忆，收敛成一个能看、能搜、能学、能复用的本地记忆中枢。**

**Consolidate the memory scattered across many agents into one local memory hub you can see, search, learn from, and reuse.**

SQLite 是事务真源，Markdown 是可读镜像；云端模型（chat / embedding / reranker / judge）驱动记忆工作流；
2D/3D 脑图让记忆可以被"看见"；任何 MCP 客户端都能直接接进来读写。

SQLite is the transactional source of truth and Markdown is a readable mirror. Cloud models
(chat / embedding / reranker / judge) drive the memory workflows, 2D/3D brain graphs make the
memory visible, and any MCP client can read and write it directly.

---

## 为什么需要它 / Why

你现在的记忆是这样散着的：

- Claude Code 记在 `~/.claude/projects` 的会话里
- Codex 记在 `~/.codex/sessions` 的 rollout 里
- 其他智能体记在各自的 profile 与会话目录里
- 你自己记在零散的 Markdown 笔记里
- 智能体之间的"经验"根本没有交汇点，同一个坑会被踩第二遍

memora-core 做的事情是：**把它们拉到一处，统一成同一种"记忆"，再用模型把它变成可复用的资产。**

What memora-core does: **pull them all into one place, normalize them into a single kind of
"memory", then turn them into a reusable asset with models.**

---

## 它有什么 / What is inside

### 一、记忆模型（不是聊天记录）/ A memory model, not a chat log

| 层 / Layer | 说明 / Description |
|---|---|
| 原始材料 / Raw material | 外部文档 / 会话落盘 / 按日期 Markdown |
| 候选 / Candidate | 已提炼但未核验（不参与默认召回） |
| 已审核 / Approved | 唯一默认召回对象 |
| 历史版本 / History | 被推翻 / 被合并的旧记忆，保留链路可回溯 |

六层作用域（global / workspace / agent / task / conversation / document），
十种记忆类型（fact / knowledge / decision / preference / procedure / experience / task / turn / tool / artifact），
八种证据（用户陈述 / 工具输出 / 文档 / 验证 / 网络 / 推导 / 智能体自述 / 代码执行），
八种富形式（公式 / 推导 / 代码 / 表格 / 图片 / 数据库引用 / 列表 / 引文）。

**硬规则**：只有"智能体自述"作为证据的记忆，信任度不超过 0.5，且不会被自动升格为事实。

**Hard rule**: a memory whose only evidence is "agent-asserted" never exceeds 0.5 trust and is
never promoted to a fact on its own.

详见 [docs/MEMORY-MODEL.md](docs/MEMORY-MODEL.md) · See [docs/MEMORY-MODEL.md](docs/MEMORY-MODEL.md).

### 二、18 条内置记忆工作流 / 18 built-in memory workflows

智能体会话沉淀 · 学习笔记与复习 · 外部文档知识化 · 混合召回与重排序 · 冲突与来源审计 ·
项目决策与经验复盘 · 细节与抽象线索 · 增量索引维护 · 新记忆去重与合并 · 记忆更新与推翻 ·
记忆拆解与原子化 · 跨智能体记忆分发 · 遗忘与衰减归档 · 矛盾调查 · 用户习惯学习 ·
快速捕获 · 知识图谱构建 · 复习题生成与批改

每条都可��在界面里看到 DAG 图、节点参数、运行记录与每一步的输入输出。
Each workflow shows its DAG, node parameters, run history, and per-step input/output in the UI.

### 三、混合检索 / Hybrid retrieval

BM25（FTS5 + 中文按字二元兜底）+ 向量 + 实体图 三路召回 → `RRF` 融合 → cross-encoder 重排 →
MMR 去冗余 → token 预算打包。任何一路不可用都会**显式降级**并在界面标注，不伪造结果。

BM25 (FTS5 with a CJK bigram fallback) + vectors + entity graph, fused with RRF, re-ranked by a
cross-encoder, de-duplicated with MMR, and packed into a token budget. When a channel is
unavailable the system **degrades explicitly** and labels it in the UI — it never fabricates results.

### 四、四种脑图 / Four brain graphs

语义脑图（3D 力导向词义网络）· 层级脑图（2D 树 / 3D 径向）· 时间线脑图 · 证据脑图。
点节点 → 相机平滑转到最佳视角，邻居联动；支持标签避让、LOD、路径查找、mini-map、导出 PNG。

Semantic (3D force-directed), hierarchical (2D tree / 3D radial), timeline, and evidence graphs.
Click a node and the camera smoothly moves to the best viewpoint with neighbours linked;
label avoidance, LOD, path finding, mini-map and PNG export are supported.

### 五、多协议接入 / Multi-protocol access

MCP stdio / MCP HTTP / REST + SSE / 心跳文件 / 本地会话目录扫描。
自动识别常见智能体宿主（Claude Code、Codex CLI、Cursor、Claude Desktop 等）的在场状态，
并给出每个宿主的**可复制接入片段**。

### 六、模型接入 / Model access

四个角色分别配置：对话模型、向量模型、重排模型、判定模型。
支持 OpenAI 兼容端点、DashScope、Ollama。密钥加密落盘，每次调用留痕，失败如实降级。

Four roles configured separately: chat, embedding, reranker and judge. OpenAI-compatible
endpoints, DashScope and Ollama are supported. Keys are encrypted on disk, every call is
traced, and failures degrade honestly.

### 七、算法目录 / Algorithm catalogue

34 个记忆算法的名称、分类、简介、公式与出处全部内置展示（BM25 / RRF / MMR / SimHash /
个性化 PageRank / Louvain / ForceAtlas2 / SM-2 / SRS / 双时序 …）。
标注哪些已在本机启用、哪些因算力不足仅登记不运行。

---

## 快速开始 / Quick start

### 桌面版（解压即用）/ Desktop (unzip and run)

1. 下载 `release/memora-core-1.0.0-windows-x64.zip`
2. 解压到任意目录
3. 双击 `MemoraCore\MemoraCore.exe`（或 `启动记忆中枢.cmd`）

无需安装 Python。首次启动会在 `%APPDATA%\MemoraCore\data` 建库、灌入内置模板，
并在 <http://127.0.0.1:8790> 提供界面与 API。

Unzip the release archive, double-click `MemoraCore\MemoraCore.exe`. No Python required. On first
launch it creates the database under `%APPDATA%\MemoraCore\data`, loads the built-in templates,
and serves the UI and API on <http://127.0.0.1:8790>.

### 源码运行 / Run from source

    python -m memora_core setup          # 初始化数据目录与数据库
    python -m memora_core serve          # 启动界面与 API（默认 127.0.0.1:8790）
    python -m memora_core doctor         # 健康检查
    python -m memora_core selftest       # 端到端自检（不联网）

后端只用 Python 标准库，不需要 `pip install`。需要 Python 3.12。

The backend uses the Python standard library only — no `pip install` needed. Python 3.12 is required.

### 智能体接入 / Agent access

    python -m memora_core --data <数据目录> mcp-stdio

配置片段见 [AGENTS.md](AGENTS.md)。Configuration snippets live in [AGENTS.md](AGENTS.md).

### 桌面版打包 / Build the desktop app

    cd desktop && npm install             # electron 44.7.2 + electron-builder 26.0.12
    cd .. && python tools/build_desktop.py

产物在 `dist/MemoraCore/`（绿色目录，复制走即可运行）。

---

## 目录结构 / Repository layout

    memora_core/            后端（Python，仅标准库）
      data/schema.sql       23 张表的真源结构
      data/builtin/         18 工作流 / 34 算法 / 6 智能体登记 / 8 提示词
      static/               已打包的前端产物
    frontend/               前端 TypeScript 源码（esbuild 打包）
    desktop/                Electron 外壳
    tools/                  构建、打包、控制面、资产生成、演示数据
    tests/                  单元与集成测试
    docs/                   架构、记忆模型、接口、运维、第三方、三份调研
    release/                解压即用的发布包（zip）
    data/                   运行时数据（首次启动生成，不随仓库分发）

---

## 设计原则 / Design principles

1. **真源唯一**：SQLite 是唯一写入真源，Markdown 是派生产物。两个写入者必然冲突。
2. **无证据不升格**：智能体说自己记得，不算记得。
3. **降级必须可见**：没有云端模型时可以工作，但必须让用户看见"现在是离线模式"。
4. **不静默覆盖**：任何推翻、合并都留审计与来源链。
5. **布局不是关系**：脑图里的空间距离是投影，真实关系看 edge 表。
6. **协议优先**：不为某个宿主做私有集成，所有接入走 MCP / REST 标准面。

1. **One source of truth**: SQLite is the only write target; Markdown is derived. Two writers conflict.
2. **No evidence, no promotion**: an agent saying it remembers is not remembering.
3. **Visible degradation**: it works without cloud models, but always says so.
4. **No silent overwrite**: every supersede and merge keeps an audit trail.
5. **Layout is not relation**: graph distance is a projection; the edge table holds the truth.
6. **Protocol first**: no private integrations — everything goes through MCP / REST.

---

## 文档 / Documentation

- [架构与接口契约 / Architecture](docs/ARCHITECTURE.md)
- [记忆模型 / Memory model](docs/MEMORY-MODEL.md)
- [智能体接入手册 / Agent handbook](AGENTS.md)
- [接口 / API](docs/API.md) · [运维 / Operations](docs/OPERATIONS.md) · [模型接入 / Models](docs/models.md)
- [检索 / Retrieval](docs/retrieval.md) · [协议 / Protocols](docs/protocols.md) · [文档索引 / Index](docs/INDEX.md)
- [调研：开源记忆系统横评 / Research R1](docs/research/R1-repos.md) ·
  [调研：记忆算法与论文 / R2](docs/research/R2-papers.md) ·
  [调研：脑图与智能体协议 / R3](docs/research/R3-viz-protocols.md)

---

## 脱敏说明 / Desensitization note

本仓库是**公开发布版**，发布前已按数据脱敏规范做过处理：

- 移除了所有本机绝对路径（构建目录、用户目录、缓存目录），改为仓库相对路径或环境变量
- 演示数据（`tools/seed_demo.py`）中的个人偏好与项目名已替换为合成示例
- 局域网测试地址改为 RFC 5737 文档保留地址（`192.0.2.0/24`）
- 运行期数据目录 `data/`（含真实记忆内容）不随仓库分发
- 构建产物已逐字节扫描，确认不含本机路径或用户名

This is a **public release**. Local absolute paths, personal preferences in the demo seed, and a
real LAN address have been replaced with portable paths, synthetic samples, and the RFC 5737
documentation range. The runtime data directory is not distributed. Build artifacts were
scanned byte by byte and contain no local paths or user names.

---

## 许可 / License

MIT，见 [LICENSE](LICENSE)。第三方组件与借鉴来源见 [docs/THIRD-PARTY.md](docs/THIRD-PARTY.md)。

MIT — see [LICENSE](LICENSE). Third-party components and design references are listed in
[docs/THIRD-PARTY.md](docs/THIRD-PARTY.md).

---

<a name="english-readme"></a>

# English

**A local memory hub that collects the memory scattered across your agents into one place you
can see, search, learn from, and reuse.**

SQLite is the transactional source of truth and Markdown is a readable mirror. Cloud models
(chat / embedding / reranker / judge) drive the memory workflows, 2D/3D brain graphs make the
memory visible, and any MCP client can read and write it directly.

## Why

Your memory today is scattered: Claude Code keeps it in `~/.claude/projects`, Codex keeps it in
`~/.codex/sessions`, other agents keep it in their own profile directories, and you keep it in
loose Markdown notes. There is no meeting point, so the same lesson gets learned twice.

memora-core **pulls them all into one place, normalizes them into a single kind of "memory", and
turns them into a reusable asset with models.**

## What is inside

1. **A memory model, not a chat log** — raw material, candidates, approved memories and history
   are distinct layers. Six scopes, ten memory types, eight evidence kinds, eight rich forms.
   *Hard rule: a memory backed only by "agent-asserted" evidence never exceeds 0.5 trust and is
   never promoted to a fact.*
2. **18 built-in memory workflows** — session distillation, spaced review, document ingestion,
   hybrid recall, conflict auditing, decision retrospectives, de-duplication, supersession,
   atomic splitting, cross-agent distribution, decay archival, knowledge-graph building and more.
   Each shows its DAG, parameters, run history and per-step I/O.
3. **Hybrid retrieval** — BM25 (FTS5 with a CJK bigram fallback) + vectors + an entity graph,
   fused with RRF, re-ranked by a cross-encoder, de-duplicated with MMR, packed into a token
   budget. Any unavailable channel **degrades explicitly**; the system never fabricates results.
4. **Four brain graphs** — semantic (3D force-directed), hierarchical (2D tree / 3D radial),
   timeline and evidence views, with smooth camera transitions, label avoidance, LOD, path
   finding and PNG export.
5. **Multi-protocol access** — MCP stdio, MCP HTTP, REST + SSE, heartbeat files and local session
   scanning, with ready-to-paste configuration snippets for common agent hosts.
6. **Model access** — chat, embedding, reranker and judge roles configured separately; OpenAI
   compatible endpoints, DashScope and Ollama supported; keys encrypted at rest, every call traced.
7. **Algorithm catalogue** — 34 memory algorithms with names, taxonomy, formula and provenance,
   each marked as enabled locally or registered-only.

## Quick start

**Desktop (unzip and run)**

1. Download `release/memora-core-1.0.0-windows-x64.zip`
2. Unzip it anywhere
3. Double-click `MemoraCore\MemoraCore.exe` (or `启动记忆中枢.cmd`)

No Python required. On first launch it creates the database under `%APPDATA%\MemoraCore\data`,
loads the built-in templates, and serves the UI and API on <http://127.0.0.1:8790>.

**Run from source**

    python -m memora_core setup          # initialize the data directory and database
    python -m memora_core serve          # serve the UI and API (default 127.0.0.1:8790)
    python -m memora_core doctor         # health check
    python -m memora_core selftest       # end-to-end self test (offline)

The backend uses the Python standard library only — no `pip install` needed. Python 3.12 required.

**Agent access**

    python -m memora_core --data <data-dir> mcp-stdio

See [AGENTS.md](AGENTS.md) for the client-side configuration snippets.

**Build the desktop app**

    cd desktop && npm install             # electron 44.7.2 + electron-builder 26.0.12
    cd .. && python tools/build_desktop.py

The result is a portable green directory in `dist/MemoraCore/`.

## Repository layout

    memora_core/            backend (Python, standard library only)
    frontend/               frontend TypeScript sources (bundled with esbuild)
    desktop/                Electron shell
    tools/                  build, packaging, asset generation, demo seeding
    tests/                  unit and integration tests
    docs/                   architecture, memory model, API, operations, research
    release/                ready-to-run release archives (zip)
    data/                   runtime data (created on first run, not distributed)

## Design principles

1. **One source of truth** — SQLite is the only write target; Markdown is derived.
2. **No evidence, no promotion** — an agent asserting it remembers is not remembering.
3. **Visible degradation** — it works offline, but it always says so.
4. **No silent overwrite** — every supersede and merge keeps an audit trail.
5. **Layout is not relation** — graph distance is a projection; the edge table holds the truth.
6. **Protocol first** — no private host integrations; everything goes through MCP / REST.

## Desensitization note

This repository is a **public release**. Every local absolute path (build, user and cache
directories) was replaced with repository-relative paths or environment variables; the personal
preferences and project names in the demo seed were replaced with synthetic samples; a real LAN
address in the tests was replaced with the RFC 5737 documentation range; the runtime data
directory containing real memories is not distributed; and the build artifacts were scanned byte
by byte and contain no local paths or user names.

## License

MIT — see [LICENSE](LICENSE). Third-party components and design references are listed in
[docs/THIRD-PARTY.md](docs/THIRD-PARTY.md).
