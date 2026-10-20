# HTTP API 服务端（memora_core/server.py）

一句话：**只绑回环、只用标准库**，把 store / retrieval / workflows / agents / exchange / models / mcp
暴露成一套稳定 JSON API，并托管前端静态资源（含脑图页）。

    python -m memora_core serve --port 8790          # 启动（默认 127.0.0.1:8790）
    python -m memora_core.server --port 8790 --open  # 直接跑 server 模块

启动时先 `init_db`（建库或按 `PRAGMA user_version` 迁移；遇到比程序新的库拒绝启动、退出码 3，
见 ADR-0004），再尽力灌入内置模板 / 智能体 / 算法（失败只记录，不阻塞），
随后打印一行 `Memora-Core 已启动: http://127.0.0.1:<port>`。`Ctrl+C` 会关闭监听、
通知 SSE 断开，并等待在途请求最多 5 秒。

## 1. 传输层

| 项 | 值 | 说明 |
| --- | --- | --- |
| 服务器 | `ThreadingHTTPServer` | `daemon_threads = True` |
| 协议 | `protocol_version = "HTTP/1.1"` | keep-alive |
| 连接队列 | `request_queue_size = 256` | 要求 ≥ 128 |
| 单连接请求数 | `MAX_REQUESTS_PER_CONN = 200` | 达上限前最后一帧带 `Connection: close` |
| 响应长度 | 一律显式 `Content-Length` | keep-alive 必需；`204/304` 由框架省略 |
| 压缩 | ≥ 1KB 且客户端接受 gzip | 图片/字体不压 |
| 请求体上限 | `MAX_BODY = 8MB` | 超限先读掉再回 `413`（避免 RST） |

## 2. 安全基线

- **只绑回环**：`serve()` / `create_server()` 拒绝 `127.0.0.1|localhost|::1` 之外的地址。
- **Host 头校验**（防 DNS rebinding）：只接受 `127.0.0.1:<port>` / `localhost:<port>` /
  `[::1]:<port>`，否则 `403 BAD_HOST`。
- **响应头**：`Content-Security-Policy`（同源、无 CDN、`frame-ancestors 'self'`）、
  `X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、
  `X-Frame-Options: SAMEORIGIN`、`Permissions-Policy`。API 响应 `Cache-Control: no-store`；
  静态资源 `no-cache` + `ETag`（见 §7）。只允许**同源**嵌入：图谱页用同源 iframe 嵌 `/brain.html`
  （1.0.0 的 `'none'` / `DENY` 让这个 iframe 永远空白）。
- **跨站写请求闸门**（ADR-0001）：`POST/PUT/PATCH/DELETE` 若 `Sec-Fetch-Site: cross-site`，
  或带的 `Origin` 不是本服务自己的回环源（`http://127.0.0.1:<port>` / `localhost` / `[::1]`），
  先读掉请求体再回 `403 BAD_ORIGIN`。不带这两个头的客户端（agent、curl、MCP 宿主）不受影响。
- **写操作**：`POST/PUT/PATCH` 带 body 时必须 `Content-Type: application/json`
  （只有 `POST /api/documents/import` 额外允许 `multipart/form-data`——它是唯一解析 multipart 的路由；
  1.0.0 对所有 `*/import` 放行），否则 `400 BAD_CONTENT_TYPE`。
- **路径穿越**：解码一次、再解码一次判二次编码，拒绝 `..`、绝对路径、盘符、NUL/CR/LF，
  最终用 `resolve()` 断言仍位于 `static/` 之内。
- **异常**：只回 {"error": "服务内部错误", "code": "INTERNAL_ERROR"}，堆栈只进进程日志。

## 3. 错误契约

    {"error": "中文说明", "code": "MACHINE_CODE"}

常用 code：`NOT_FOUND`(404) `METHOD_NOT_ALLOWED`(405) `BAD_HOST`(403) `BAD_PATH`(400)
`BAD_JSON`(400) `BAD_CONTENT_TYPE`(400) `BAD_ORIGIN`(403) `BAD_TRUST_POLICY`(400)
`BODY_TOO_LARGE`(413) `MISSING_FIELD`(400)
`MEMORY_NOT_FOUND`(404) `BAD_TRANSITION`(409) `CONFIRM_REQUIRED`(400)
`MODULE_UNAVAILABLE`(503) `INTERNAL_ERROR`(500)。

## 4. 路由

`ROUTES = [('/api/health', 'GET'), ...]`（selftest 与服务端共享这一份清单，当前 **45** 条）。
路径参数写成花括号占位，由 `Matcher` 匹配：**字面段优先于占位段**
（所以 `/api/documents/import` 不会被 `/api/documents/{id}` 吃掉），
路径存在但方法不符返回 `405` + `Allow`，否则 `404`。

| 分组 | 端点 |
| --- | --- |
| 健康 | `GET /api/health`、`GET /api/overview` |
| 记忆 | `GET/POST /api/memories`；`GET/PATCH/DELETE /api/memories/{id}`；`POST .../review` `.../approve` `.../reject`；`GET/POST .../evidence` |
| 检索 | `GET /api/search`、`POST /api/recall` |
| 文档 | `GET /api/documents`、`GET /api/documents/{id}`、`.../raw`、`POST .../import`、`POST .../reindex` |
| 图 | `GET /api/graph?view=semantic|hierarchy|timeline|evidence` |
| 工作流 | `GET /api/workflows`、`GET /api/workflows/{id}`、`POST /api/workflows/{id}/run`（默认同步 201；`?async=1` → 202）、`GET /api/runs`、`GET /api/runs/{id}`、`POST /api/runs/{id}/cancel`（200 / 202 收尾中 / 409 / 404） |
| 模型 | `GET/POST /api/models`、`POST /api/models/{id}/test`、`GET /api/models/calls` |
| 智能体 | `GET /api/agents`、`POST /api/agents/probe`、`POST /api/agents/heartbeat`、`GET /api/agents/{id}/config` |
| 其它 | `GET /api/algorithms`、`GET /api/conflicts`、`POST /api/conflicts/{id}/resolve`、`GET /api/jobs`、`POST /api/jobs/{id}/retry`、`GET /api/exchange/export`、`POST /api/exchange/import`、`GET/POST /api/settings` |
| 协议 | `POST /mcp`（转 `mcp.handle_http`，缺失则 503）、`GET /api/events`（SSE） |

`GET /api/health` 永远可用，而且**便宜**：返回版本、运行时长、`db` 计数（10 键子集，行数缓存
5 秒）、每个模型 role 的 `ok`、`capabilities`、`unavailable` 与 `degraded`，以及：

| 字段 | 含义 |
|---|---|
| `db_integrity` | 最近一次完整性结论：`ok` / 问题描述 / `pending`（后台 quick_check 还没跑完） |
| `db_integrity_mode` / `db_integrity_checked_at` | `quick_check`（进程启动后后台跑一次）或 `integrity_check`（`?deep=1`） |
| `db_tables` | 表清单：从 `sqlite_master` 推导、对照 `schema.sql`（`real` / `virtual` / `missing` / `unexpected`） |
| `db_census` | 全部表的行数（`?lite=1` 时为 `null`） |
| `db_bytes` / `schema_version` / `sqlite` | 库大小、结构版本、SQLite 版本 |

参数：`?lite=1` 不数行（桌面外壳的就绪探针用）；`?deep=1` 同步跑完整 `integrity_check`。
1.0.0 每次调用都跑完整 `integrity_check`：211 MB 的库单次约 1.1 s、422 MB 约 2.9 s，而外壳的
就绪探针超时 1.5 s——库长到 ~0.4 GB 后应用就再也启动不了。

## 5. 容错

依赖模块通过唯一导入缝 `_load_module(name)` 装载，任何 `ImportError` / 异常都被捕获：
该模块相关端点返回 `503 MODULE_UNAVAILABLE`（中文说明），其余端点照常，
`/api/health` 把失败模块如实列进 `unavailable` / `degraded`。
失败**不缓存**：模块恢复后下一次请求立即可用。
`retrieval.search` 一类接口允许网关缺失（`gateway_or_none`），走确定性降级而不是报错。

## 6. SSE（GET /api/events）

- `Content-Type: text/event-stream`，先发 `retry: 3000`，再补发最近 5 条历史事件
  （没有历史就补一帧 `heartbeat`），保证**建连立刻有数据**。
- 每 **15 秒**发一行心跳注释 `: ping <ts>`；队列上限 200，满了丢最旧的。
- 事件来自 `events.py`：`subscribe()` 拿总线，`publish()` 广播，
  `publish_run()` 是工作流事件的便捷入口（`/api/workflows/{id}/run` 会自动广播）。
- 经 HTTP `/mcp` 的写工具调用之后广播一条 `memory` 事件（`action: "mcp"`）。
- **外部写入**：有界面在听时，后台每 2 秒看一次 `PRAGMA data_version`；别的进程（`mcp-stdio`
  里的 agent、命令行导入）写了库、且最近 3 秒没有本进程的事件，就补发 `memory` 事件
  （`action: "external"`）。1.0.0 里 agent 经 stdio 写入后界面一直显示旧数据。
- 断开检测：0.5s 轮询切片 + `select` / `MSG_PEEK`，客户端一断立刻 `unsubscribe`，
  订阅数不会泄漏；单连接最长 1 小时。

## 7. 静态托管

`memora_core/static/` 下的 `index.html / app.js / app.css / brain.js / brain.html / katex.css`。
未命中且 `Accept: text/html` 时回退：`/brain*` 回 `brain.html`，其余回 `index.html`（SPA）。
未命中且不要 HTML 则 `404` JSON。

缓存：`Cache-Control: no-cache` + 弱 `ETag`（大小 + 修改时间）。文件没变时 `If-None-Match`
得到 `304`、不传正文；gzip 结果按（路径, mtime, 大小）缓存在进程里。1.0.0 一律 `no-store`、
无 ETag、每次重读重压（katex.css 单次 gzip 约 68 ms），每次刷新重传约 1 MB。

## 7.1 收件箱

服务运行时每 10 秒检查 `data/inbox/`：5 秒内没再变化的文件交给 `ingest.watch_inbox` 吸收，
之后移到 `inbox/processed/`（失败移 `inbox/failed/`），并广播 `memory` 事件（`action: "inbox"`）。

## 8. 已知边界

- `POST /api/models` 不回显 `api_key` 明文，只返回 `hint`。
- `GET /api/exchange/export` 默认返回 `application/x-ndjson` 原始流，
  加 `?format=json` 才包成 JSON 对象；`sensitivity=secret` 的记忆默认不导出（`?include_secret=1`）。
- `POST /api/exchange/import` 接受包装对象 `{jsonl | text | records, scope, agent, dry_run, trust}`
  （界面发的就是 `{text, scope}`；1.0.0 不认 `text`，整份 JSONL 被当成一条记录导入）。
  `trust`：`cap`（默认，导入文件不受信）或 `preserve`（原样恢复自己的备份），见 ADR-0002。
- Windows 没有可投递的 SIGINT，`Ctrl+C` 的端到端验证在 POSIX 上做；
  Windows 下用 `serve()` 的进程内 `KeyboardInterrupt` 用例覆盖同一路径。
- 不提供 SSL/HTTPS：只绑回环，外层边界由宿主（Electron）负责。
