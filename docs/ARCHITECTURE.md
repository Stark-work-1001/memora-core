# memora-core / 记忆中枢 — 架构与接口契约（冻结版 v1）

> 本文件是并行开发的**唯一契约**。所有子智能体必须按此实现，不得擅自改签名；
> 需要变更时先写 docs/decisions/ 并在控制面记录 decision，由协调者裁决。

## 0. 一句话

把多个智能体（DSH / Claude Code / Codex / Cursor / 任意 MCP 客户端）散落的记忆，
收敛到一个本地桌面应用里：**SQLite 是事务真源 + Markdown 是可读镜像**，
用云端模型（chat / embedding / reranker / judge）跑记忆工作流，
用 2D/3D 脑图（词义 / 层级 / 时间线 / 证据）给用户看与学，
无云凭据时**确定性降级**且界面明确标注，绝不伪造成功。

## 1. 技术栈（已定，不再讨论）

| 层 | 选型 | 理由 |
|---|---|---|
| 后端 | Python 3.12，**仅标准库**（http.server / sqlite3 / urllib / json / hashlib / threading） | 零依赖 = 打包小、无供应链风险、断网可用 |
| 协议 | MCP stdio（换行分隔 JSON-RPC 2.0）+ MCP Streamable HTTP + REST + SSE | 覆盖所有主流智能体 |
| 数据库 | SQLite（WAL + FTS5），单文件 | 事务真源、随程序分发 |
| 文档库 | Markdown 文件树（按日期 + 按记忆 id + 索引页） | 人类可读、可 git、可被其它工具吸收 |
| 前端 | TypeScript + esbuild 打包，three.js 0.160（本地） | 与既有工具链一致 |
| 桌面 | Electron（本地 44.7.2 dist 缓存）+ PyInstaller 后端 | 已缓存、可离线构建 |

## 2. 目录布局（冻结）

    memora-core/
    ├─ memora_core/                 # Python 包（后端）
    │  ├─ __init__.py
    │  ├─ __main__.py               # CLI: serve / setup / mcp-stdio / selftest / export
    │  ├─ paths.py                  # 数据目录解析（--data / MEMORA_HOME / 默认）
    │  ├─ db.py                     # 连接、schema 初始化、事务、FTS 重建
    │  ├─ store.py                  # 领域仓库：memory/scope/evidence/block/entity/edge/document/candidate/conflict
    │  ├─ vault.py                  # Markdown 镜像写入、front-matter、索引页、安全文件名
    │  ├─ models.py                 # 模型网关：chat/embedding/reranker/judge + 秘密存储 + 调用日志 + 降级
    │  ├─ vectors.py                # 本地 hash 词形指纹（确定性，**不是语义**）+ 云端向量缓存（按 provider/model@dim）
    │  ├─ retrieval.py              # BM25 / 向量 / 图 / RRF / 重排 / MMR / 预算打包
    │  ├─ chunking.py               # 语义切块、Markdown 解析（标题/代码/公式/表格）
    │  ├─ ingest.py                 # 文档吸收（md/txt/html/json/jsonl/pdf 文本）
    │  ├─ dedup.py                  # simhash / jaccard / 余弦 分层判重 + 动作决策
    │  ├─ judge.py                  # 判定层：分类/持久性/冲突/去重裁决（LLM + 规则兜底）
    │  ├─ workflows.py              # DAG 执行器：节点处理器注册表、步骤记录、降级
    │  ├─ agents.py                 # 智能体登记/探活（进程/端口/心跳文件/MCP）/会话
    │  ├─ exchange.py               # 统一交换格式导入导出（jsonl）
    │  ├─ server.py                 # HTTP + SSE 路由
    │  ├─ mcp.py                    # MCP stdio + HTTP 工具面
    │  ├─ static/                   # 前端构建产物（由 frontend 构建写入）
    │  └─ data/schema.sql, data/builtin/*.json
    ├─ frontend/                    # TS 源码 + build.mjs
    ├─ desktop/                     # Electron main/preload + package.json
    ├─ tools/                       # control.py（控制面）/ build_assets.py / package.py / verify.py
    ├─ tests/                       # 单元与集成自测（标准库 unittest）
    ├─ docs/                        # 架构、调研、接口、验收、用户手册
    └─ data/                        # 运行时数据（首次启动生成）

### 2.1 运行时数据目录（默认 ./data，可 --data 覆盖）

    data/
    ├─ memora.db            # SQLite 真源
    ├─ vault/               # Markdown 文档库（镜像 + 外部吸收）
    │  ├─ daily/YYYY-MM-DD.md
    │  ├─ memories/<id>.md
    │  ├─ notes/            # 导入的外部文档（保留原相对路径）
    │  ├─ reports/          # 审计/复盘/学习报告
    │  └─ README.md         # 自动生成的库索引
    ├─ inbox/               # 外部投递（智能体/用户丢文件进来即被吸收）
    ├─ exports/             # 导出（jsonl / markdown 包）
    ├─ heartbeat/           # 智能体心跳文件（其它宿主写入）
    ├─ backups/             # 自动备份
    ├─ models.json          # 模型配置（密钥仍单独加密存放）
    ├─ secrets.bin          # 加密后的密钥
    └─ logs/                # 运行日志

## 3. 领域模型（见 memora_core/data/schema.sql，已写好，勿改表结构，可加索引）

核心表：agent, agent_session, scope, document, chunk, memory, evidence, block, entity,
memory_entity, edge, vector, candidate, conflict, workflow_template, workflow_run,
workflow_step, model_profile, model_call, recall_log, review_log, memory_algo, job,
audit, setting, secret。

### 3.1 作用域（scope）约定
- id 形如：global / workspace:<slug> / agent:<agent-id> / task:<slug> / conversation:<id> / document:<doc-id>
- path 为斜杠路径，父在前（global → global/workspace:x）便于前缀检索。
- 召回默认作用域继承：global → workspace → agent → task/conversation。

### 3.2 记忆状态机
candidate → approved | rejected；approved → superseded | merged | archived。
**只有 approved 参与默认召回**；candidate 只在审核界面与显式 include_candidates 时出现。

### 3.3 信任与证据
- evidence.kind：user_stated / agent_asserted / tool_output / document / web / derived / verification / code_run
- 默认信任权重：user_stated 0.9、tool_output 0.8、document 0.7、verification 0.85、web 0.6、
  agent_asserted 0.45、derived 0.5、code_run 0.8
- **规则**：只有 agent_asserted 证据的记忆，trust ≤ 0.5，且不得自动 approved（需人工或第二来源）。

## 4. Python 内部接口（冻结签名）

### 4.1 db.py

    def connect(db_path: str | Path) -> sqlite3.Connection      # WAL, foreign_keys, busy_timeout, row_factory=Row
    def init_db(db_path: str | Path) -> None                    # 执行 schema.sql（幂等）
    def transaction(con)                                        # contextmanager: BEGIN IMMEDIATE/COMMIT/ROLLBACK
    def rebuild_fts(con) -> dict                                # 重建 memory_fts / chunk_fts
    def health(con) -> dict                                     # 表计数、大小、fts 完整性

### 4.2 store.py — class Store

    Store(db_path, vault: Vault)
    # 作用域
    def ensure_scope(scope_id, kind, name='', parent_id=None) -> dict
    def list_scopes() -> list[dict]
    # 记忆
    def add_memory(data: dict) -> dict                 # 必填: title, body, kind, scope_id
    def get_memory(mid: str) -> dict | None
    def update_memory(mid: str, patch: dict) -> dict
    def delete_memory(mid: str, hard: bool=False) -> dict
    def list_memories(filters: dict) -> dict           # {items, total, limit, offset}
    def set_status(mid: str, status: str, note: str='') -> dict
    def add_evidence(mid: str, data: dict) -> dict
    def list_evidence(mid: str) -> list[dict]
    def add_block(mid: str, data: dict) -> dict
    def list_blocks(mid: str) -> list[dict]
    # 实体与图
    def upsert_entity(name, kind, definition='', scope_id=None) -> dict
    def link_memory_entity(mid, entity_id, role='mention') -> None
    def add_edge(src, src_kind, dst, dst_kind, rel, weight=1.0, confidence=0.5, origin='explicit', **kw) -> dict
    def graph(view: str, scope_id=None, limit=1000) -> dict     # {nodes, edges, meta}
    # 文档
    def add_document(data: dict) -> dict
    def list_documents(filters: dict) -> dict
    def get_document(doc_id: str) -> dict | None
    def replace_chunks(doc_id: str, chunks: list[dict]) -> int
    # 候选/冲突/审计
    def add_candidate(data: dict) -> dict
    # decide_candidate 已在 1.1.0 删除（绕过状态机、会自动批准）；采纳裁决走 set_status / update_memory
    def add_conflict(data: dict) -> dict
    def resolve_conflict(cid, resolution) -> dict
    def audit(action, target, actor='system', detail=None) -> None
    # 设置/统计
    def get_setting(key, default=None); def set_setting(key, value) -> None
    def stats() -> dict

### 4.3 vault.py — class Vault

    Vault(root: Path)
    def write_memory(memory, evidence, blocks) -> str      # 返回相对路径
    def append_daily(entry: dict) -> str
    def write_document(rel_path: str, text: str) -> str
    def write_report(name: str, markdown: str) -> str
    def rebuild_index(store) -> str
    def read(rel_path: str) -> str
    def list_files(kind: str='') -> list[dict]

### 4.4 models.py — class ModelGateway

    class ModelUnavailable(RuntimeError)      # 携带 role 与原因
    ModelGateway(store)                        # 从 model_profile + 加密密钥读取
    def roles(self) -> dict                    # role -> profile|None
    def health(self) -> dict                   # 每个 role: configured/ok/degraded/last_error
    def embed(self, texts, role='embedding') -> list[list[float]]
    def rerank(self, query, docs, top_k=20, role='reranker') -> list[tuple[int,float]]
    def chat(self, messages, role='chat', max_tokens=1024, temperature=0.2, json_mode=False) -> str
    def judge(self, prompt, schema_hint='', role='judge') -> dict   # 解析 JSON，失败抛 JudgeFormatError
    def test(self, profile_id) -> dict          # 连通性测试，写入 model_call
    def set_secret(self, key, value) -> None
    def get_secret(self, key) -> str | None

**协议**：OpenAI 兼容（/v1/chat/completions、/v1/embeddings、/v1/rerank 或 /rerank），
也支持 DashScope 原生与 Ollama。所有调用写 model_call。任何失败**必须**抛 ModelUnavailable，
由上层降级并标记 degraded=true，**不得**返回假数据。

### 4.5 retrieval.py

    def search(store, gw, query, *, scope=None, limit=20, strategy='hybrid',
               budget=None, include_candidates=False, diversify=None,
               include_secret=False) -> dict
    # {hits:[{id, kind, title, snippet, score, channels:{bm25,vector,graph}, trust, citation}],
    #  degraded:[...], took_ms, strategy, total,
    #  channels_used, vector_model, semantic, reranked, score_kind}   # 后五个 1.1.0 起
    def digest(store, gw, *, scope, budget=1200, task=None, agent_id=None,
               include_secret=False) -> dict
    def recall_for_agent(store, gw, query, agent_id, scope, limit=10,
                         include_secret=False) -> dict

### 4.6 workflows.py

    NODE_HANDLERS: dict[str, Callable]     # kind -> handler(ctx, node) -> dict
    class WorkflowContext                  # store/gw/inputs/scope/run_id/degraded/log
    def run_workflow(store, gw, template_id, inputs, scope='global', trigger='manual') -> dict
    def list_templates(store) -> list[dict]
    def seed_templates(store) -> int

**节点种类（必须全部实现；模板里出现未登记的种类时，载入校验记为 problems，运行到该步骤直接失败——
1.0.0 是登记为 noop 并标 degraded，一个什么都没做的 run 报 partial）**：
input, transform, extract, classify, retrieve, embed, rerank, fuse, judge, verify,
persist, index, graph, generate, decide, schedule, emit。

**降级契约**：节点抛 ModelUnavailable → 执行该节点 fallbacks 指定的确定性实现；
若也不存在 → 步骤标 degraded=1 并继续，run 状态 partial。

### 4.7 agents.py

    def seed_agents(store) -> int                       # 从 builtin/agents.json
    def probe_all(store) -> dict                        # 进程/端口/心跳文件/MCP 四种探针
    def heartbeat(store, agent_id, payload) -> dict
    def agent_status(store) -> list[dict]               # online/idle/offline 与判据
    def register_session(...); def end_session(...)

### 4.8 exchange.py

    EXCHANGE_SCHEMA = 'memora-exchange/1'
    def export_jsonl(store, *, scope=None, status='approved') -> str
    def import_jsonl(store, text, *, agent_id=None, scope='global') -> dict
    def detect_format(payload: dict) -> str    # memora|mem0|mcp-memory-service|basic-memory|generic

## 5. HTTP API（server.py，前缀 /api，JSON UTF-8，SSE 在 /api/events）

默认监听 **127.0.0.1:8790**（--port 可改）。安全：仅回环、Host 头校验、CSP、nosniff、no-store；
写操作要求 Content-Type: application/json。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /api/health | 版本、运行时长、降级状态、计数 |
| GET | /api/overview | 仪表盘聚合（趋势、分布、近期运行、待审） |
| GET | /api/memories | 过滤：q, scope, kind, status, agent, limit, offset, sort |
| POST | /api/memories | 新建（默认 candidate） |
| GET/PATCH/DELETE | /api/memories/{id} | 详情（含 evidence/blocks/edges）/ 修改 / 删除 |
| POST | /api/memories/{id}/review | {grade:0..5} → SM-2 更新 |
| POST | /api/memories/{id}/approve, /reject | 审核 |
| GET/POST | /api/memories/{id}/evidence | 证据 |
| GET | /api/search | ?q&strategy&scope&limit&budget → 命中 + 降级标记 |
| POST | /api/recall | 智能体召回（含 digest 打包） |
| GET | /api/documents, /api/documents/{id}, /api/documents/{id}/raw | 文档库 |
| POST | /api/documents/import | {path} 或 multipart 上传 |
| POST | /api/documents/{id}/reindex | 重切块重建索引 |
| GET | /api/graph | ?view=semantic|hierarchy|timeline|evidence&scope&limit |
| GET | /api/workflows, /api/workflows/{id} | 模板 |
| POST | /api/workflows/{id}/run | {inputs, scope} → run |
| GET | /api/runs, /api/runs/{id} | 运行记录（含步骤） |
| GET/POST | /api/models | 模型档位 |
| POST | /api/models/{id}/test | 连通性测试 |
| GET | /api/models/calls | 调用日志 |
| GET | /api/algorithms | 算法目录 |
| GET | /api/agents, POST /api/agents/probe, POST /api/agents/heartbeat | 智能体 |
| GET | /api/conflicts, POST /api/conflicts/{id}/resolve | 冲突 |
| GET | /api/jobs, POST /api/jobs/{id}/retry | 任务队列 |
| POST | /api/exchange/import, GET /api/exchange/export | 交换 |
| GET/POST | /api/settings | 设置 |
| GET | /api/events | SSE：{type: run|memory|agent|log, data} |

## 6. MCP 工具面（mcp.py，stdio + HTTP /mcp）

工具（名字冻结）：
memory_capture, memory_remember, memory_recall, memory_search, memory_digest,
memory_get, memory_update, memory_forget, memory_relate, memory_evidence, memory_review,
memory_graph, memory_session_begin, memory_session_end, memory_agent_status,
memory_scope_list, memory_stats, memory_workflow_run, memory_workflow_list,
memory_export, memory_import, memory_health。

要求：stdio 走换行分隔 JSON-RPC 2.0；HTTP 走 POST /mcp（JSON-RPC）+ SSE 流；
每次调用记录 recall_log / audit 并刷新 agent 在场。

## 7. 前端契约

- 构建产物写入 memora_core/static/：index.html, app.js, app.css, brain/*。
- 仅用同源 /api/*；不引入 CDN；three.js 由 esbuild 打进 bundle。
- 页面：总览 / 记忆库 / 文档库 / 检索 / 工作流（含 DAG 画布）/ 运行记录 /
  脑图（语义·层级·时间线·证据）/ 智能体 / 模型 / 算法目录 / 冲突 / 设置。
- 视觉：深色 + 青绿主色，等宽数字，卡片化，支持 1280×800 起。
- 脑图：three.js；节点点击 → 相机四元数 slerp 转场到最佳视角；邻居高亮、标签避让、
  LOD、聚类折叠、搜索定位、时间过滤、mini-map、2D/3D 切换、导出 PNG。

## 8. 降级矩阵（必须可观测）

| 能力 | 云端可用 | 云端不可用 |
|---|---|---|
| 抽取 | LLM 抽取 | 规则抽取（标题+句子切分+意图词） |
| 分类 | LLM 分类 | 关键词规则分类 |
| 向量 | 云端 embedding | **无向量通道**（hybrid 只跑关键词 + 图；`strategy=vector` 退回本地 hash 指纹并在 degraded 里说明） |
| 重排 | cross-encoder | 不重排，保持 RRF 顺序（`reranked: false`） |
| 判定 | judge 模型 | 阈值规则（cos / jaccard / simhash） |
| 摘要 | LLM | 首句/抽取式 |

界面上必须显示「当前处于离线降级」标识与每个 role 的状态。

## 9. 代码规范

- Python：3.12 语法、from __future__ import annotations、类型注解、无第三方依赖。
- 所有用户可见文案中文；日志英文 key + 中文消息。
- 任何写库操作必须带 audit；任何模型调用必须带 model_call。
- 文件必须 UTF-8 无 BOM；行宽 ≤ 110。
