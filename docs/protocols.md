# protocols.md — 协议接入层（MCP / 在场 / 交换格式 / 吸收）

本文件描述 **memora-core 如何被"别的智能体"接进来**，以及中枢如何"看见"谁在运行。
对应实现：`memora_core/mcp.py`、`agents.py`、`exchange.py`、`ingest.py`。

---

## 1. 三种接入方式

| 方式 | 适用 | 端点 / 命令 |
|---|---|---|
| MCP stdio | Claude Code / Codex CLI / Cursor / 任何 MCP 客户端 | 子进程，见下方命令 |
| MCP HTTP | 已常驻运行的中枢，多客户端共享 | POST http://127.0.0.1:8790/mcp |
| REST | 插件 / hooks / 脚本 | http://127.0.0.1:8790/api/* |

stdio 启动命令：`python -m memora_core --data <数据目录> mcp-stdio`

三种方式的工具面完全一致：同一份 `TOOLS` 字典，同一套 `dispatch()`。

---

## 2. JSON-RPC 帧格式

**一行一个 JSON-RPC 2.0 对象，以换行分隔。不使用 Content-Length 头。**

    -> {"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}
    <- {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05",...}}

- stdout **只允许**写协议帧；任何调试输出必须走 stderr（`_stderr()`）。
- 通知（无 `id`，如 `notifications/initialized`）在 stdio 上**不回帧**；HTTP `/mcp` 上回
  `200 {"jsonrpc":"2.0","id":null,"result":{}}`（与 1.0.0 相同，保持兼容）。
- 任何一帧出错（含 `params`、`clientInfo`、`_meta` 不是对象）都回 JSON-RPC 错误帧，**不会**让
  stdio 进程退出（1.0.0 一帧畸形的 `_meta` 就让进程以退出码 1 结束）。
- 解析失败回 `-32700`，未知方法回 `-32601`，参数错回 `-32602`，内部错回 `-32603`。
- 任何异常都会被 `dispatch()` 捕获转成错误帧，**绝不污染协议流**。

| 方法 | 返回 |
|---|---|
| `initialize` | protocolVersion=2024-11-05、capabilities:{tools:{}}、serverInfo |
| `notifications/initialized` | 无响应 |
| `ping` | 空对象 |
| `tools/list` | 22 个工具描述 |
| `tools/call` | content + structuredContent + isError:false |
| `resources/list` / `prompts/list` | 空数组 |

---

## 3. 22 个工具（名字冻结）

    memory_capture       memory_remember      memory_recall        memory_search
    memory_digest        memory_get           memory_update        memory_forget
    memory_relate        memory_evidence      memory_review        memory_graph
    memory_session_begin memory_session_end   memory_agent_status  memory_scope_list
    memory_stats         memory_workflow_run  memory_workflow_list memory_export
    memory_import        memory_health

### 调用契约

每次 `tools/call` **必然**做三件事：

1. `heartbeat(store, agent_id, {'source':'mcp'})` —— 刷新在场，供 `mcp` 探针判定；
2. 召回类（`memory_recall` / `memory_digest`）写 `recall_log`；`memory_search` 是**纯检索**，
   按 AGENTS.md 约定不写日志；
3. 写入类（capture / remember / update / forget / relate / evidence / review /
   session_* / workflow_run / import）写 `audit`。

错误语义：参数问题一律 `-32602`（含"记忆不存在"、"未知工具"），依赖模块故障
（工作流未就绪、写库异常）一律 `-32603`。

---

## 4. 在场探测：四种探针

| 探针 | 判据 | 纯标准库实现 |
|---|---|---|
| `process` | 进程名或命令行包含登记关键字 | Windows：ctypes + CreateToolhelp32Snapshot；其它平台回退 ps |
| `port` | 127.0.0.1:port TCP 可连接 | socket.connect，超时 300ms |
| `file` | 心跳文件存在且 mtime 在 TTL 内 | os.path.getmtime，默认 TTL 90s |
| `mcp` | agent.last_heartbeat 在 TTL 内且来源是 mcp | 读 agent 表 |

**判定规则**：任一探针 found → online；全部未命中 → offline；探针自身异常记 error
（error 不算命中，也不会中断其它探针）。

每条探针结果都写 `agent_probe(id, agent_id, probe, target, state, detail, latency_ms, at)`。
**不使用 psutil**。

`memora_core/data/builtin/agents.json` 登记 6 个智能体（dsh-desktop / claude-code /
codex-cli / cursor / claude-desktop / generic-mcp），`seed_agents()` 幂等写入并保留运行态。

### 会话

    register_session(store, agent_id, external_id, title='', cwd='', scope_id=None) -> dict
    end_session(store, agent_id, external_id, turns=None) -> dict

`UNIQUE(agent_id, external_id)` 保证幂等：重复开始会复用同一行并标记 resumed=True；
结束会话时 turns 存档到 `agent_session.spec`，并触发内置 `session-distill` 工作流
（工作流模块未就绪时安静跳过，返回 workflow: null）。

### 后台探活

`watch(store, interval=20)` 启动守护线程 memora-agent-watch，周期调用 probe_all，
不阻塞主流程；重复调用复用同一线程。`stop_watch()` / `watch_state()` 供测试与调试。

---

## 5. 统一交换格式 memora-exchange/1

JSONL，一行一条。必填字段：

    schema, id, title, body, kind, category, scope, agent, trust, importance,
    status, recorded_at, tags, evidence[], blocks[], entities[], edges[]

    {"schema":"memora-exchange/1","id":"m-abc","title":"...","body":"...",
     "kind":"fact","category":"检索","scope":"workspace:demo","agent":"claude-code",
     "trust":0.9,"importance":0.8,"status":"approved","recorded_at":"2026-10-19T10:00:00Z",
     "tags":["检索"],"evidence":[{"kind":"tool_output","quote":"..."}],
     "blocks":[{"type":"formula","content":"..."}],
     "entities":[{"name":"RRF","kind":"concept"}],
     "edges":[{"src":"m-abc","dst":"m-def","rel":"semantic"}]}

### 导出

    export_jsonl(store, *, scope=None, status='approved', include_evidence=True) -> str

status=None 表示不限状态。证据/块/实体/边总是随记忆一起导出，保证往返不丢结构。

### 导入

    import_jsonl(store, text, *, agent_id=None, scope='global', dry_run=False) -> dict
    # -> {imported, skipped, deduped, errors, total, dry_run, ids, dedup, formats}

去重是**双通道**：① 归一文本完全相同、或 simhash 汉明距离 ≤ 3 → 判重；
② 词集 Jaccard ≥ 0.6 时再调 `dedup.score_pair`（不可用则用本地三通道实现），dup ≥ 0.86 判重。
导入成功后重建 FTS（`store.rebuild_fts`），因此导入的记忆立即可被搜索。

### 格式识别

    detect_format(payload) -> memora | mem0 | mcp-memory-service | basic-memory | generic
    to_memora(obj, fmt, scope) -> dict

| 格式 | 识别特征 | 归一规则 |
|---|---|---|
| memora | schema 前缀 / 含 title+body+scope | 原样保留，补齐缺失字段 |
| mem0 | memory + user_id，或 memory + hash + agent_id | memory → body，categories → tags |
| mcp-memory-service | content + memory_type，无 body | content → body，memory_type → kind |
| basic-memory | permalink + entity_type，或 frontmatter + title | permalink 兜底标题 |
| generic | 其余 | 依次试 body/content/text/memory/value |

---

## 6. 文档吸收

    ingest_file(store, path, *, scope='global', agent_id=None, kind='note') -> dict
    ingest_text(store, text, *, title, scope='global', kind='note', origin='user') -> dict
    ingest_directory(store, path, *, scope='global', pattern='**/*.md') -> dict
    watch_inbox(store) -> dict

| 类型 | 处理 |
|---|---|
| .md | 取首个标题或 front-matter title，按标题层级切块 |
| .txt | 纯文本，按段落切块 |
| .html/.htm | html.parser 去标签；h1..h6 → #，pre → 代码围栏，li → -；丢弃 script/style |
| .json | 对象取 title/body，其余键转列表；数组逐条转 Markdown |
| .jsonl | 每行一条，转 Markdown 块 |
| .pdf | **需要 pypdf，未安装时明确报错**，绝不伪造正文 |

写入链路：镜像到 `vault/notes/` → upsert `document` 行（同路径复用）→
`chunking.chunk_markdown` 切块（模块缺失时退化为段落切块）→ `replace_chunks` 触发
`chunk_fts` 同步。因此吸收完的文件**立刻可被 FTS 检索**。

`watch_inbox()` 扫描 `data/inbox/`，成功吸收的移到 processed/，失败的移到 failed/，
同名文件自动加序号，绝不覆盖。

### 切块检索：为什么需要 LIKE 兜底

`chunk_fts` 用的是 schema 冻结的 `unicode61` 分词器，它把**连续汉字当成一个 token**，
于是 `MATCH '降级'` 命中不了标题 `## 三、离线降级`。因此
`ingest.search_chunks(store, query, limit=20, document_id=None)` 走双通道：先 `chunk_fts MATCH`
（英文/数字/整段中文精确命中），再用 `LIKE` 补中文子串，最后按 id 去重。不改 schema。

---

## 7. 降级矩阵

| 依赖 | 不可用时的行为 |
|---|---|
| retrieval | 召回返回空 hits，degraded 写明原因，不抛异常 |
| workflows | memory_workflow_* 返回 -32603；会话沉淀跳过 |
| chunking | 退化为段落切块（_fallback_chunks） |
| dedup | 退化为本地 simhash + Jaccard + 余弦 |
| vault | 镜像失败只记审计，真源照常写入 |
| models | memory_health 的 `degraded` 逐个列出不可用的角色（`model:<role> 不可用`）；`ok` 只表示中枢本身可用（1.0.0 读错了键，没配任何模型时也报 `degraded: []`） |
| pypdf | PDF 吸收明确报错"需要 pypdf，未安装" |
