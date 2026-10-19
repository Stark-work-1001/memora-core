# Release Notes — memora-core 1.0.0 · 记忆中枢

## 中文

**memora-core（记忆中枢）1.0.0 —— 首个公开发布版。** 纯本地的智能体记忆中枢：把 Claude Code、
Codex CLI 及其他宿主里散落的记忆收敛到一处，统一成可检索、可审计、可复用的记忆资产。
后端只用 Python 标准库；桌面版解压即用；任何 MCP 客户端可直接接入读写。

**本版包含**

- **记忆模型**：六层作用域、十种类型、八类证据、八种富形式，候选 / 已审核 / 历史版本分层。
  只有"智能体自述"作证据的记忆信任度不超过 0.5，且永不自动升格为事实。
- **18 条内置工作流**：会话沉淀、文档知识化、混合召回、冲突审计、去重合并、遗忘归档、
  知识图谱、复习题批改等，界面可看 DAG、参数与逐步输入输出。
- **混合检索**：BM25（FTS5 + 中文按字二元兜底）+ 向量 + 实体图 → RRF 融合 → cross-encoder
  重排 → MMR 去冗余 → token 预算打包；任一通道不可用时显式降级，不伪造结果。
- **四种脑图**：语义（3D 力导向）、层级（2D 树 / 3D 径向）、时间线、证据视图。
- **多协议接入**：MCP stdio / MCP HTTP / REST+SSE / 心跳文件 / 本地会话目录扫描。
- **模型接入**：chat / embedding / reranker / judge 四角色，支持 OpenAI 兼容端点、DashScope、Ollama。
- **桌面版**：Electron 外壳 + PyInstaller 单文件后端，双击即用，无需安装 Python。

**验证**：440 项单元与集成测试全部通过；端到端自检 14/14；独立验收脚本
`python tools/verify.py` 覆盖源码布局、Python 编译、后端仅标准库（AST 级扫描）、前端产物、
真实起服打接口、MCP stdio 握手（22 个工具），10 项通过 0 项失败。

**已知限制**：本版未接真实云端模型，模型不可用时按设计降级（抽取式摘要、字符 n-gram 哈希
向量、阈值规则），界面显示"离线降级"；配置密钥后建议先调 `POST /api/models/{id}/test`。

**脱敏**：已移除全部本机绝对路径；演示数据中的个人偏好与项目名替换为合成示例；测试中的
局域网地址改为 RFC 5737 文档保留地址；运行期数据目录不随仓库分发；发布包经逐条目、
逐字节扫描，确认不含本机路径与用户名。

**下载**：`memora-core-1.0.0-windows-x64.zip`（Windows x64，解压双击即用）、
`memora-core-1.0.0-source.zip`（源码，需 Python 3.12）。许可 MIT。

---

## English

**memora-core (Memory Hub) 1.0.0 — the first public release.** A fully local memory hub for AI
agents: it collects the memory scattered across Claude Code, Codex CLI and other hosts into one
place and normalizes it into a searchable, auditable, reusable asset. The backend uses only the
Python standard library, the desktop build runs straight after unzipping, and any MCP client can
read and write it directly.

**What it ships**

- **A memory model, not a chat log** — six scopes, ten memory types, eight evidence kinds,
  eight rich forms, with separate candidate / approved / history layers. A memory backed only by
  "agent-asserted" evidence never exceeds 0.5 trust and is never promoted to a fact.
- **18 built-in workflows** — session distillation, document ingestion, hybrid recall, conflict
  auditing, de-duplication and merging, decay archival, knowledge-graph building, review-question
  grading, each with an inspectable DAG and per-step I/O.
- **Hybrid retrieval** — BM25 (FTS5 with a CJK bigram fallback) + vectors + an entity graph, fused
  with RRF, re-ranked by a cross-encoder, de-duplicated with MMR and packed into a token budget.
  An unavailable channel degrades explicitly; results are never fabricated.
- **Four brain graphs** — semantic (3D force-directed), hierarchical (2D tree / 3D radial),
  timeline and evidence views.
- **Multi-protocol access** — MCP stdio, MCP HTTP, REST + SSE, heartbeat files, session scanning.
- **Model access** — chat / embedding / reranker / judge roles over OpenAI-compatible endpoints,
  DashScope and Ollama.
- **Desktop build** — an Electron shell around a single-file PyInstaller backend: unzip, double
  click, no Python installation required.

**Verification** — 440 unit and integration tests pass, the offline end-to-end self test passes
14/14, and the independent acceptance script `python tools/verify.py` passes 10/10 (source layout,
Python compilation, stdlib-only backend, frontend assets, a live server, an MCP stdio handshake with
22 tools).

**Known limitation** — no real cloud model is wired up yet. When a model is unavailable the system
degrades by design (extractive summarisation, character n-gram hash vectors, threshold rules) and
the UI shows an "offline degraded" badge. After adding keys, call
`POST /api/models/{id}/test` first.

**Desensitization** — every local absolute path was removed; the personal preferences and project
names in the demo seed were replaced with synthetic samples; a real LAN address in the tests became
the RFC 5737 documentation range; the runtime data directory is not distributed; every entry of the
release archives was scanned, byte by byte, for local paths and user names.

**Download** — `memora-core-1.0.0-windows-x64.zip` (Windows x64, unzip and run) and
`memora-core-1.0.0-source.zip` (source, needs Python 3.12). Licensed under MIT.
