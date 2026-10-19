# HTTP API 参考

基址：`http://127.0.0.1:8790`
所有请求与响应都是 UTF-8 JSON；SSE 在 `/api/events`。
写操作必须带 `Content-Type: application/json`。仅监听回环地址。

## 通用约定

- 成功：HTTP 2xx + JSON 对象
- 失败：HTTP 4xx/5xx + `{"error": "中文错误说明", "code": "MACHINE_CODE"}`
- 分页：`limit`（默认 50，上限 500）/ `offset`
- 时间：UTC ISO8601，形如 `2026-10-19T13:21:20Z`
- 降级：任何可能用到云模型的接口，返回体里都可能有
  `degraded: ["vector", "rerank"]`，前端必须把它显示出来

---

## 健康与总览

### GET /api/health

```json
{
  "ok": true,
  "version": "1.0.0",
  "uptime_s": 128,
  "data_dir": "<data-dir>",
  "db": { "memory": 132, "document": 12, "chunk": 340 },
  "models": {
    "chat": {"ok": false}, "embedding": {"ok": true},
    "reranker": {"ok": false}, "judge": {"ok": false}
  },
  "degraded": ["chat", "reranker", "judge"]
}
```

### GET /api/overview

仪表盘聚合：`totals` / `by_kind` / `by_scope` / `daily`（近 30 天）/
`recent_runs` / `pending_reviews` / `agents`

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

### POST /api/memories/{id}/approve  /  /reject

`{"note": "审核意见"}`

### GET/POST /api/memories/{id}/evidence

---

## 检索与召回

### GET /api/search

参数：`q`（必填）、`strategy`（hybrid|bm25|vector|graph）、`scope`、
`limit`、`budget`、`include_candidates`

```json
{
  "hits": [
    { "id": "m-8f3a1c", "kind": "fact", "title": "示例", "snippet": "片段",
      "score": 0.83, "channels": {"bm25": 0.71, "vector": 0.88, "graph": 0.4},
      "trust": 0.9, "citation": "[m:m-8f3a1c]" }
  ],
  "degraded": ["rerank"],
  "took_ms": 42, "strategy": "hybrid", "total": 7
}
```

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
- `POST /api/workflows/{id}/run` — `{"inputs": {}, "scope": "global"}` 返回 run 对象
- `GET /api/runs?limit=` 与 `GET /api/runs/{id}`
  （含 steps，每步 status / model / degraded / 耗时）
- `POST /api/runs/{id}/cancel`

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
- `GET /api/jobs` 与 `POST /api/jobs/{id}/retry`
- `GET /api/exchange/export?scope=&status=` 与 `POST /api/exchange/import`
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
HTTP 模式：`POST /mcp`，同样接受 JSON-RPC；返回 application/json 或 SSE 流。
