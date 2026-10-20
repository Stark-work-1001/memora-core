# HTTP API 参考

基址：`http://127.0.0.1:8790`
所有请求与响应都是 UTF-8 JSON；SSE 在 `/api/events`。
写操作必须带 `Content-Type: application/json`。仅监听回环地址。
浏览器发出的跨站写请求（`Origin` 不是本服务、或 `Sec-Fetch-Site: cross-site`）一律 `403 BAD_ORIGIN`；
不带这两个头的程序化客户端不受影响（ADR-0001）。

## 通用约定

- 成功：HTTP 2xx + JSON 对象
- 失败：HTTP 4xx/5xx + `{"error": "中文错误说明", "code": "MACHINE_CODE"}`
- 分页：`limit`（默认 50，上限 500）/ `offset`
- 时间：存储与返回都是 UTC ISO8601，形如 `2026-10-19T13:21:20Z`；**按天**的统计与日记页按
  服务所在机器的**本地**日历日切分（ADR-0003）
- 降级：任何可能用到云模型的接口，返回体里都可能有非空的 `degraded` 列表（健康接口里是角色名，
  检索接口里是说明替代了什么的中文句子），前端必须把它显示出来

---

## 健康与总览

### GET /api/health

```json
{
  "ok": true,
  "version": "1.1.0",
  "uptime_s": 128,
  "data_dir": "<data-dir>",
  "db": { "memory": 132, "document": 12, "chunk": 340 },
  "db_ok": true,
  "db_integrity": "ok",
  "db_integrity_mode": "quick_check",
  "db_tables": { "real": 28, "virtual": 2, "expected_real": 28, "expected_virtual": 2,
                 "missing": [], "unexpected": [] },
  "db_census": { "memory": 132, "agent_probe": 40, "...": 0 },
  "schema_version": 1,
  "sqlite": "3.49.1",
  "models": {
    "chat": {"ok": false}, "embedding": {"ok": true},
    "reranker": {"ok": false}, "judge": {"ok": false},
    "extractor": {"ok": false}, "vision": {"ok": false}
  },
  "degraded": ["chat", "extractor", "judge", "reranker", "vision"]
}
```

`?lite=1`：不数行（`db` 为 `{}`、`db_census` 为 `null`），给就绪探针用；`?deep=1`：同步跑完整
`integrity_check`。默认不扫完整性：后台每个进程跑一次 `quick_check`，结论在 `db_integrity`
（还没跑完时是 `pending`）。`degraded` 是**列表**——没配任何模型时它天然非空。

### GET /api/overview

仪表盘聚合：`totals` / `by_kind` / `by_scope` / `daily`（近 30 天，**本地**日历日）/ `today`
（服务端本地日期，用来从 `daily` 里取"今日新增"）/ `recent_runs` / `pending_reviews` / `agents`

---

## 记忆

### GET /api/memories

查询参数：`q, scope, kind, status, agent, session, sort, order, limit, offset,
include_archived`

返回：

```json
{
  "items": [
    { "id": "m-8f3a1c", "title": "示例", "body": "正文", "kind": "fact",
      "status": "approved", "scope_id": "global", "agent_id": "claude-code",
      "trust": 0.9, "importance": 0.7,
      "recorded_at": "2026-10-19T10:00:00Z", "snippet": "含 <em>事务真源</em> 的片段" }
  ],
  "total": 132, "limit": 50, "offset": 0, "query": "事务"
}
```

### POST /api/memories

```json
{
  "title": "标题", "body": "正文", "kind": "fact",
  "scope_id": "workspace:memora-core", "category": "工程",
  "importance": 0.8, "status": "candidate",
  "didactic": { "definition": "定义", "formula": "E=mc^2" },
  "blocks": [ {"type": "code", "lang": "python", "content": "print(1)"} ],
  "evidence": [ {"kind": "tool_output", "quote": "原始输出片段", "uri": "cmd:python -V"} ],
  "entities": [ {"name": "SQLite", "kind": "tool"} ]
}
```

### GET /api/memories/{id}

返回完整对象，额外带 `evidence` / `blocks` / `entities` /
`edges` / `documents` / `history`。

### PATCH /api/memories/{id}

局部更新；传 `status` 时走状态机校验（非法迁移返回 409）。

### DELETE /api/memories/{id}?hard=false

默认软删（archive）；`hard=true` 需 `confirm=<id>` 参数，写审计。

### POST /api/memories/{id}/review

`{"grade": 0}` 到 `{"grade": 5}`，SM-2 更新
`stability / difficulty / review_due`，写 review_log。

### POST /api/memories/{id}/approve  ·  POST /api/memories/{id}/reject

`{"note": "审核意见"}`

### GET/POST /api/memories/{id}/evidence

---

## 检索与召回

### GET /api/search

参数：`q`（必填）、`strategy`（hybrid|bm25|substring|vector|graph，也可组合如 `bm25+substring`）、
`scope`、`limit`、`budget`、`include_candidates`。本机界面的搜索包含 `sensitivity=secret` 的记忆；
agent 侧的 `/api/recall` 与 MCP 不包含。

```json
{
  "hits": [
    { "id": "m-8f3a1c", "kind": "fact", "title": "示例", "snippet": "片段",
      "score": 0.0246, "channels": {"bm25": 0.71, "vector": 0, "graph": 0.4},
      "trust": 0.9, "citation": "[m:m-8f3a1c]" }
  ],
  "degraded": ["vector: 未配置模型网关（没有 embedding 模型）；本次没有向量通道（本地 hash 词形草图不参与 hybrid 融合）",
               "rerank: 未配置模型网关；未重排，保持 RRF 顺序"],
  "took_ms": 42, "strategy": "hybrid", "total": 7,
  "channels_used": ["bm25", "substring", "graph"], "vector_model": null,
  "semantic": false, "reranked": false, "score_kind": "rrf"
}
```

`score` 是 RRF 融合分（量级约 0.01–0.05，不是 0–1 的归一化分）；`degraded` 是说明替代了什么的句子。
`channels_used` / `vector_model` / `semantic` / `reranked` / `score_kind` 为 1.1.0 新增的附加字段：
离线时 `vector_model` 为 `null`、`semantic` 为 `false`。

### POST /api/recall

智能体专用：`{"query": "...", "agent": "claude-code", "scope": "workspace:x",
"limit": 10, "budget": 1200}`
返回带 `digest` 字段的可直接注入上下文的文本包。

---

## 文档库

- `GET /api/documents?kind=&q=&limit=`
- `GET /api/documents/{id}` — 元数据 + 分块列表
- `GET /api/documents/{id}/raw` — 原始 Markdown（text/markdown）
- `POST /api/documents/import` — `{"path": "D:/x.md", "scope": "workspace:x"}`
  或 multipart 上传
- `POST /api/documents/{id}/reindex`

---

## 图（脑图数据）

### GET /api/graph?view=semantic|hierarchy|timeline|evidence&scope=&limit=

```json
{
  "nodes": [
    { "id": "m-8f3a1c", "kind": "memory", "label": "节点标题",
      "x": 0.1, "y": -0.3, "degree": 5, "importance": 0.7,
      "t": 1760000000, "depth": 2 }
  ],
  "edges": [ { "source": "m-8f3a1c", "target": "e-001", "rel": "hypernym", "weight": 0.8 } ],
  "meta": { "view": "semantic", "node_count": 240, "edge_count": 610, "truncated": false }
}
```

---

## 工作流

- `GET /api/workflows` — 18 个模板（含 spec 的 nodes / edges）
- `POST /api/workflows/{id}/run` — `{"inputs": {}, "scope": "global"}`：默认同步执行，`201` 返回
  run 对象（1.0.0 行为）。`?async=1` 或 body `{"async": true}`：立即 `202` + `Location`，run 状态
  `queued`/`running`，进度经 SSE 的 `run` 事件推送（`phase: start | step | end`）。`emitted` 是本次
  run 自己发出的事件数（1.0.0 数的是全局无关事件）
- `GET /api/runs?limit=` 与 `GET /api/runs/{id}`
  （含 `steps`，每步 status / model / degraded / 耗时；1.1.0 起含 `cancel_requested`）
- `POST /api/runs/{id}/cancel` — `200` 已取消；`202` + `cancel_requested: true` 正在收尾（协作式取消，
  阻塞中的模型调用返回后才停）；`409 RUN_FINISHED` 已结束；`404 RUN_NOT_FOUND`。
  服务重启时仍处于 running 的 run 记为 `failed`（"interrupted: …"）
- 模板列表 / 详情附加 `trigger_active` / `trigger_note` / `problems`：定时与吸收触发器**不会自动运行**
  （没有 cron 调度器，见 docs/workflows.md），需要手动或经 agent 运行

---

## 模型

- `GET /api/models` — 按角色分组 + 健康状态
- `POST /api/models` — 新建/更新档位（api_key 写入后不回显，只返回 hint）
- `POST /api/models/{id}/test` — 真实连通性测试
- `GET /api/models/calls?limit=` — 调用日志

---

## 智能体

- `GET /api/agents` — 每个智能体：状态、最近心跳、探针证据、会话数、记忆数
- `POST /api/agents/probe` — 立即跑一轮探活
- `POST /api/agents/heartbeat` — 外部宿主上报
  `{"agent": "dsh", "status": "online", "detail": {}}`
- `GET /api/agents/{id}/config` — 生成该宿主的接入配置片段

---

## 其它

- `GET /api/algorithms` — 34 条算法目录
- `GET /api/conflicts` 与 `POST /api/conflicts/{id}/resolve`
- `GET /api/jobs`（附 `worker`：服务进程内的作业执行器状态）与 `POST /api/jobs/{id}/retry`
  （`409 JOB_RUNNING`）。1.0.0 的 job 表只进不出，1.1.0 起由执行器认领、按退避重试并记录结果
- `GET /api/exchange/export?scope=&status=&include_secret=` 与 `POST /api/exchange/import`
  （包装对象 `{jsonl | text | records, scope, agent, dry_run, trust}`；`trust` 默认 `cap`：
  导入文件里的 `approved` 降为候选、信任度封顶 0.5，报告里 `demoted` 给出条数；`preserve` 原样
  恢复自己的备份。secret 记忆默认不导出。见 ADR-0002）
- `GET/POST /api/settings`
- `GET /api/events` — SSE：event: run | memory | agent | log，data: JSON

---

## MCP 工具（stdio 与 HTTP 同一套）

```
memory_health        memory_stats         memory_scope_list
memory_capture       memory_remember      memory_recall
memory_search        memory_digest        memory_get
memory_update        memory_forget        memory_relate
memory_evidence      memory_review        memory_graph
memory_session_begin memory_session_end   memory_agent_status
memory_workflow_run  memory_workflow_list memory_export
memory_import
```

stdio 帧格式：一行一个 JSON-RPC 2.0 对象（换行分隔，无 Content-Length 头）。
HTTP 模式：`POST /mcp`，同样接受**单个** JSON-RPC 对象，返回 application/json（不提供 SSE 流）。
agent 不能批准记忆（`memory_update` 改 `status=approved` 返回 -32602），`memory_forget` 的
`hard=true` 需要 `confirm=<id>`（ADR-0002）。
