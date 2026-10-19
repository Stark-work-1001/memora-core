# Memora 1.3.0：本轮五项端到端验证记录

日期：2026-10-18。记录对象是**开发测试目录**（`<项目根>`，devel）与本地正在运行的**独立版**（`<独立版目录>`，standalone）在这五项上到底能不能用，以及不能用时是真的不能用、还是被我们自己的缺陷挡住。

五项测试的判定只用实测输出，不用实现者自述。每条都附可复现命令。五项之外没有做：长期负载、多厂商兼容、模型事实准确率、用户规模性能测量。

## 结论

| 编号 | 问题 | 结论 | 一句话依据 |
|---|---|---|---|
| T1 | 独立版能否被 DSH 通过 MCP 接通 | **PASS** | 对打包后的 `memora-backend.exe` 走 stdio：`initialize` + `tools/list` 22 个工具 + `memory_peer_heartbeat` / `memory_peers` / `memory_digest` 三个往返全部成功 |
| T2 | 独立版能否处理记忆 | **PASS** | capture → pending/fact → Judge `model_advice` → approve → 索引 1 条 **4096 维**向量 → hybrid recall 命中自身 |
| T3 | memory-connector 能否连接独立版 | **PARTIAL** | 插件侧全通（真实 profile 配置驱动、注册 10 个收窄工具、30s 周期心跳、`peers.seen` 1 秒前、`connected=true`）；但**活 DSH 宿主里没有加载它**，根因由 P7 负责 |
| T4 | 云端模型接入 | **PASS** | `model-health` 3/3 reachable+advertised；真实 probe：embedding 344ms/**4096 维**、judge 1422ms、rerank 234ms/scored 2 |
| T5 | 能否构建工作流作为记忆处理 demo | **PASS（修复后）** | **先失败、后修复**：5 节点工作流真跑 `done`，逐节点模型名/输入输出 sha256/耗时齐全，并产出 Markdown 草稿 v2 |

T5 是本轮唯一需要动代码才成立的项，它的两次失败与修复单独写在第 5 节，因为那两次失败本身就是本轮最有价值的证据。

## 复现前须知

- **不要重启独立版，也不要重启 DSH 宿主。** 本记录里的独立版是用户在用的那一份（`18765`）。
- 需要写数据的测试一律用**临时/复制数据目录**，不写独立版 `data/`。
- `tools/build_desktop.py` 是发布动作，本轮不执行。
- 文本文件只用编辑器改，不要用 PowerShell `-replace`/`ReadAllText` 改 UTF-8。

---

## T1 独立版能否被 DSH 通过 MCP 接通 —— PASS

**被测对象**：`memora-desktop-standalone\resources\backend\memora-backend.exe`，stdio 传输，不经过 web 端口。

```bash
node tools/dsh_mcp_heartbeat_probe.mjs \
  --exe <独立版目录>/resources/backend/memora-backend.exe \
  --data <独立版目录>/data \
  --json artifacts/p1-presence/mcp-heartbeat-probe.json
```

实测（2026-10-18T08:00:02Z 起）：

| 步骤 | 结果 |
|---|---|
| `initialize` | `protocolVersion 2024-11-05`，`serverInfo {name: memora, version: 1.30.0}`，instructions 正常返回 |
| `tools/list` | **22 个工具**，含 `memory_peer_heartbeat` |
| `tools/call memory_peer_heartbeat` | 成功，peer 行写入 |
| `tools/call memory_peers` | 成功，能读回刚写的 peer |
| `tools/call memory_digest` | 成功，返回有界摘要 |

证据：`artifacts/p1-presence/mcp-heartbeat-probe.json`。

这个探针用**自己的 peer id**（`p1-verify-probe`）并在结束时删除该行，所以它不可能把真实的 connector 伪装成"活着"——这是这条证据可信的前提。

**结论边界**：证明的是"打包后的 exe 实现了 MCP 并能被 stdio 驱动"，不等于"宿主已经加载了它"——后者正是 T3 的问题。

---

## T2 独立版能否处理记忆 —— PASS

**被测对象**：同一个独立版 backend（HTTP `18765`，`standalone`）。

流程与实测：

| 步骤 | 命令 | 实测 |
|---|---|---|
| 1. 写入候选 | `POST /api/agent/capture` | 返回 `pending`，`category=fact` |
| 2. Judge 分类 | `POST /api/agent/classify` | 返回 `model_advice`（**建议**，不是批准） |
| 3. 人工批准 | `POST /api/agent/review {action:'approve'}` | 状态转为 approved |
| 4. 建索引 | `POST /api/agent/index` | indexed 1 条，**4096 维**向量 |
| 5. 回查 | `GET /api/agent/recall?mode=hybrid` | 命中自己那条 |

复现（把 token 换成当次 `GET /api/session` 的结果）：

```bash
curl -s http://127.0.0.1:18765/api/session
curl -s -X POST http://127.0.0.1:18765/api/agent/capture \
  -H "Content-Type: application/json" -H "X-MM-Token: <token>" -H "Origin: http://127.0.0.1:18765" \
  -d '{"project":"default","content":"独立版可处理记忆的验证句子"}'
```

**这条证据里最关键的一点**：分类结果以 `model_advice` 呈现、批准必须人工、向量维度如实回报 4096。系统没有把"分类建议"说成"已确认"——这与后文 T5 修好之前"命名失败为 endpoint unavailable"的问题正好相反，说明记忆管线这条路径的诚实性是对的。

---

## T3 memory-connector 能否连接独立版 —— **PARTIAL**

这一项必须拆成两个不同的事实，混在一起就会得出错误结论。

### 事实一：插件、配置、心跳、白名单全通 —— PASS

```bash
node tools/verify_dsh_presence.mjs --intervals 2 --json artifacts/p1-presence/report.json
```

用**真实 profile 配置**（`<DSH install dir>\cordis.patch.yml` 里 memory-connector 那段）驱动插件的实测结果：

| 检查 | 实测 |
|---|---|
| `apply()` | 成功，注册 **10 个收窄工具**（白名单内） |
| 周期心跳 | 按配置启用：`peer=dsh-memory-connector project=default interval=30000ms ttl=90s` |
| 心跳新鲜度 | 等 38s 后查 `data/memora-control.sqlite3`：`seen` 是 **1 秒前** |
| 连接状态 | `connected=true`，`model=deepseek-v4.1-flash` |
| 白名单闸门 | 拒绝 `ALLOWED_TOOLS` 之外的工具 |
| `dispose()` | 定时器确实停止 |

### 事实二：活的 DSH 宿主没有加载它 —— FAIL（未修复，P7 负责）

| 检查 | 实测 |
|---|---|
| 宿主子进程 | 只有 `python -m memora ... mcp`（memory-memora 那条），**没有** `memora-backend.exe ... mcp` |
| 宿主工具面 | 只有 `mcp__memora__*`，**没有** connector 那套 `memory_*` 工具 |
| 独立版 peers 表 | `dsh-memory-connector` 的 `seen` 停在 20:10:48（那是本次验证脚本写进去的，不是宿主） |

### 为什么整体记 PARTIAL

"插件能跑"和"宿主已加载"是两件事。前者已有可复现证据，后者没有。把它们合并成 PASS 会让界面继续显示"无在线智能体"而无人知情；合并成 FAIL 又会误伤已经修好并验证过的插件与配置。**PARTIAL + 分开陈述**才是这两个事实的正确表达。

根因排查在 P7（`task-7`）进行，强怀疑是同一 id 的两处 Loader insert（bundle 层与 profile 层）互相遮蔽。本轮不在这里下结论。

**用户可见影响**：独立版工作台右上角仍会显示"无在线智能体"。修复动作需要重载 profile 或重启 DSH 宿主，属于用户操作，不在本轮自动化范围内。

---

## T4 云端模型接入 —— PASS

**被测对象**：独立版已保存的三角色配置（siliconflow，`remote: true`，字面 api_key）。

### 4.1 连通性（不花生成额度）

```bash
curl -s "http://127.0.0.1:18765/api/agent/model-health"
```

`3/3` 全部 `reachable: true` + `advertised: true`：

| 角色 | 模型 | reachable | advertised |
|---|---|---|---|
| embedding | `Qwen/Qwen3-VL-Embedding-8B` | true | true |
| judge | `Qwen/Qwen3.8-27B` | true | true |
| rerank | `Qwen/Qwen3-VL-Reranker-8B` | true | true |

`model-health` 只做 `GET /models` 比对，**不代表能推理**——真实的推理探测是下一条。

### 4.2 真实探测（每个角色一次最小推理）

```bash
curl -s http://127.0.0.1:18765/api/session
curl -s -X POST http://127.0.0.1:18765/api/agent/model-probe \
  -H "Content-Type: application/json" -H "X-MM-Token: <token>" -H "Origin: http://127.0.0.1:18765" -d '{"project":"default"}'
```

| 角色 | 端点 | 延迟 | 结果 |
|---|---|---|---|
| embedding | `POST /embeddings` | **344 ms** | ok，**4096 维** |
| judge | `POST /chat/completions` | **1422 ms** | ok |
| rerank | `POST /rerank` | **234 ms** | ok，scored 2 |

**需要注意的一次抖动**：同一路由在 12:30:00Z 的一次重放里，judge 以 **15141 ms 超时**失败（probe 上限 15 s），而 embedding（438 ms）与 rerank（265 ms）仍 ok。随后独立验证同一把 key 直连 `/chat/completions` 返回 200、耗时 22.8 s（16 token 的 reasoning 模型回复）。所以：

- 这是**探测超时阈值的边界**，不是模型不可用；
- judge 是 reasoning 模型，冷启动单次可达 20 s 以上，probe 的 15 s 上限对它偏紧；
- 记录如实保留这次失败，不当成"全通"。

**结论边界**：证明"已保存的三角色配置能真实发出请求并被正确解析"，不证明长期可用性、不证明模型事实准确率。

---

## T5 能否构建工作流作为记忆处理 demo —— PASS（先失败，后修复）

结论：**能**。但这一项的价值恰恰在于它第一次没跑通，而失败被如实记录、定位、修复、复跑成功。下面按时间顺序保留全过程。

### 5.1 demo 是什么

| 项 | 值 |
|---|---|
| 工作流 id | `ca6e2e28-e908-47a8-bb5a-859760152edf` |
| 标题 | 记忆处理 demo：抽取 → 分类 → 核验 → 沉淀评估 → 沉淀草稿 |
| 节点 | 5 个（`extract` → `classify` → `verify` → `assess` → `settle`），4 条连线 |
| 操作 | `extract_relations` → `classify` → `verify` → `assess_memory` → `organize_markdown` |
| 绑定模型 | `memory-judge`（`Qwen/Qwen3.8-27B`）——本轮只有一个 profile |
| 来源文档 | slug `memora-workflow-demo-source`，v1，sha256 `65624aa1…4c414` |
| 产出 | 草稿 **v2**（`organize_markdown` 生成），**未发布** |

这条 demo 是**真实可复跑的**：`manifest` 与文档都在 `artifacts/p8-workflow/` 里，后端数据在 `artifacts/p8-workflow/devel-data/`。

### 5.2 失败一：HTTP 401（跑在**独立版旧构建**上，保留为证据）

第一次在**独立版**（`http://127.0.0.1:18765`，2026-10-18 13:34 冻结的 backend）上跑：

```
run 0dba5f86-aa17-4042-b88d-2d55f2e18307   status=failed
output.error = {"code":"provider_error","message":"model endpoint returned HTTP 401","retryable":true}
stages = []   （0 个节点产出）
```

**这不是云端不可用。** 同一时刻：

- `GET /api/agent/status` 报告 `keys.judge = {key_set: true, source: "literal"}` —— 密钥**保存着**；
- `model-health` 三角色 reachable；
- 用同一把 key 直连 SiliconFlow `/chat/completions`：**200**；不带 key：401 `"Token is invalid."`。

根因（已用受控实验证明）：**工作流/模型池这条路径只认 `key_env`，不认 settings 里保存的字面 `api_key`。**

- 从 settings 派生的 model registry profile 是 `{id: memory-judge, model: Qwen/Qwen3.8-27B, base: https://api.siliconflow.cn/v1, key_env: "", remote: true, kind: openai}` —— `carries_key: false`；
- 该 profile 交给 `chat_models.adapter()` 得到 `HTTPChat`，其 `request()` 只做 `os.environ.get(key_env)`，`key_env` 为空 → **不发 Authorization** → 401；
- 而记忆管线（Judge / embedding）走 `core._service()` 的 `_resolve_key()`，那里会读字面 key，所以 **T2 / T4 一直正常**。

这正是 T5 单独失败、而 T2/T4 都通过的原因。**不是模型不可用，是我方配置解析漏了一条路径。**

证据：`artifacts/p8-workflow/run-failure-401.json`（失败 run 原文，未删改）。

**这次失败没有伪造成功**：run 被正常落库、状态 `failed`、`error` 字段如实写着 401、`stages` 为空。失败是可见的。

### 5.3 失败二：45 s 节点超时

修 401 之前先用"环境变量提供同一把 key"的方式隔离出第二个问题（沙盒冻结实例，同一 exe、临时 data）：

```
run aa53b37e-e1a9-454f-bbd5-bd5950f3541c   status=failed
stages: extract_relations（约 3.5 分钟）成功  →  verify 45s 无首字节
output.error = {"code":"provider_error","message":"model endpoint unavailable (TimeoutError)","retryable":true}
```

根因：`memora/chat_models.py` 的 `HTTPChat.request()` 把超时**硬编码为 45 s**（`self.opener.open(req, timeout=45)`）。而一个工作流节点是一次最多 4096 token 的生成，且 judge 是 reasoning 模型——**45 s 明显偏短**。

更严重的是**措辞**：失败只说 `endpoint unavailable`，把"截止时间太短"说成"端点不可用"，把排查引向完全错误的方向。这是本轮第二个要修的缺陷：**诊断信息的诚实性**。

证据：`artifacts/p8-workflow/run-failure-45s-timeout.json`。

### 5.4 修复

三处，都在 devel 树里，未动独立版：

| 文件 | 改动 |
|---|---|
| `memora/chat_models.py` | `HTTPChat` 接受可选 `key` 与 `timeout`；`adapter()` 透传；新增 `DEFAULT_CHAT_TIMEOUT=45`（交互路径保持原值）；401/403 报"拒绝凭据"而非 unavailable；超时报出阈值；远端无凭据时给出明确缺凭据信息，而不是发一个注定 401 的匿名请求 |
| `memora/core.py` | 新增 `adapter_for_profile(profile, timeout=None)` + `_profile_key()`：按 `(base, model)` 匹配已保存角色，注入 `_resolve_key()` 的结果（literal 优先，回落 key_env）。**密钥不进环境变量、不落盘、不进 run 记录** |
| `memora/workflows.py` | 节点超时 `WORKFLOW_NODE_TIMEOUT=120`；节点记录新增 `timeout_seconds` / `elapsed_seconds`；失败记录写入 `stage` / `operation` / `model` / `timeout_seconds` / `elapsed_seconds` |

### 5.5 复跑结果：PASS

修复后在 **devel 后端**（`python -m memora`，edition=devel，临时数据目录，settings 中 `key_env` 为空、只有字面 `api_key`——即失败一的确切条件）真跑：

```bash
.venv\Scripts\python.exe -m memora --data <临时数据> serve --port 18901
# 另开一个终端（token 从 GET /api/session 取）
curl -s -X POST http://127.0.0.1:18901/api/agent/workflow-start \
  -H "Content-Type: application/json" -H "X-MM-Token: <token>" -H "Origin: http://127.0.0.1:18901" \
  -d '{"project":"default","workflow":"ca6e2e28-e908-47a8-bb5a-859760152edf","slug":"memora-workflow-demo-source","audience":"human"}'
```

run `777ee139-6576-4a0e-b035-b4253f902b65`，`status=done`，2026-10-18T12:53:58Z → 12:58:39Z：

| 节点 | 操作 | 模型 | 耗时 | 超时预算 | 输出长度 | output sha256（前 16） |
|---|---|---|---|---|---|---|
| extract | `extract_relations` | `Qwen/Qwen3.8-27B` | **147.937 s** | 120 s | 2572 | `8ec0d136c272d300` |
| classify | `classify` | `Qwen/Qwen3.8-27B` | **24.656 s** | 120 s | 253 | `0ab1ca53fed68cc3` |
| verify | `verify` | `Qwen/Qwen3.8-27B` | **31.922 s** | 120 s | 30 | `619624ccb900671e` |
| assess | `assess_memory` | `Qwen/Qwen3.8-27B` | **11.703 s** | 120 s | 261 | `643f43c2c03b76ef` |
| settle | `organize_markdown` | `Qwen/Qwen3.8-27B` | **64.703 s** | 120 s | — | `ada44ccce8950394` |

每个节点都记录了 `input_sha256`、`output_sha256`、`started_at`、`created`、`topo_index`、`profile`、`model`、`remote`。

结构化产出（模型真实返回，非伪造）：

- `extract_relations`：12 条关系提案，每条带 `source`/`target`/`kind`/`evidence` 原文引句，`approval: "pending_user_review"`；
- `classify`：`base_category: procedure`，`domain: Memora 记忆处理工作流`，`level: procedure`；
- `verify`：`{"supported": true, "issues": []}`；
- `assess_memory`：`durable: true, importance: 0.7, source_supported: true, sensitive: false, conflict: false, instruction_risk: false`，`approval: "advisory_only"`；
- `settle`：产出草稿 **v2**（`{"slug":"memora-workflow-demo-source","version":2}`），**未发布**。

**注意 `extract` 用了 147.937 s，超过它自己的 120 s 预算却没有失败**——这个预算约束的是单次 HTTP 传输空闲，不是整段生成总时长；记录里的 `elapsed_seconds` 是真实墙钟，所以这个数字必须原样保留，不能为了让表格好看而改。**这一点值得下一步单独确认**（见第 6 节）。

整条 run 记录中不含任何 `sk-` 前缀字符串、不含 `Bearer`：凭据没有泄漏进 run 记录（已用字符串扫描核对）。

### 5.6 截图

| 文件 | 内容 |
|---|---|
| `artifacts/p8-workflow/01-workflow-canvas.png` | 工作流画布：5 个节点 + 4 条连线，左侧列表显示 demo 标题与"5 个节点 · 4 条连线" |
| `artifacts/p8-workflow/02-run-records.png` | 工作流运行记录：两条 `done`（5 节点那次与 4 节点那次） |
| `artifacts/p8-workflow/03-run-record-detail.png` | 运行记录展开，可见逐阶段/模型/结果正文 |

截图由 `tools/verify_workflow_demo.cjs` 生成，它读的是**渲染后的 DOM**，不是源码：

```bash
desktop\node_modules\electron\dist\electron.exe tools\verify_workflow_demo.cjs
```

9 项断言全部通过（后端为 devel、demo 工作流存在、存在全阶段完成的 run、视图可见、画布渲染出节点、列表含 demo、运行记录有内容、运行详情**真的展开**且高度 >40px、无 console 错误），报告见 `artifacts/p8-workflow/ui-report.json`。

第 8 条断言值得说明：`orchestration.js` 每 4 s 重绘运行记录列表，重绘会把已展开的 `<details>` 折叠回去。所以脚本在截图前重新展开，并**测量渲染后的 `<pre>` 高度**（实测 400px）——而不是只写了一个 `open` 属性就宣布成功。第一次实现时 02 与 03 两张截图完全相同，正是这个断言把它抓出来的。

### 5.7 这条 demo 现在在哪里

- **工作流与文档存在于 devel 侧数据**：`artifacts/p8-workflow/devel-data/`（`memora-control.sqlite3` 有该 workflow 与两条 done run，`memora-documents.sqlite3` 有该文档 v1/v2）。可随时用这个数据目录起一个 devel 后端复现。
  该目录里的 `memora.json` 是**脱敏副本**：`api_key` 已替换为占位符，复现时需复制你自己的 `data/memora.json` 覆盖它（凭据不进交付物）。
- **工作流定义已放进独立版**（用户在用的那一份）：`http://127.0.0.1:18765` 的 工作流可视化 里现在能看到
  「记忆处理 demo：抽取 → 分类 → 核验 → 沉淀评估 → 沉淀草稿」（5 个节点 / 4 条连线），用户原有的两条
  「新工作流」完好，`runs` 仍为空（截图 `artifacts/lead-presence/standalone-workflow-demo.png`）。
  这与「不写独立版 data」不冲突，需要分清两类数据：**工作流定义是配置**（等于用户点「新建」再保存），
  **不涉及任何人的记忆、不发模型请求**，所以把 T5 的 demo 放在用户真正会看的地方是对的；而验证过程
  遗留在独立版的**测试记忆 / 测试 run / 测试文档 / 测试 peer 行**已全部删除，只读查询确认基线恢复。
- **独立版当前仍是旧构建**（2026-10-18 13:34 冻结），不含本轮修复。要让独立版里跑通同样的工作流，需要由 Lead 在**用户审核通过后**重建独立版；本轮不执行 `tools/build_desktop.py`。

---

## 第 6 节：修复引入的测试与遗留项

### 新增单元测试

`tests/test_workflow_credentials.py`（7 项，全绿）：

```bash
.venv\Scripts\python.exe -m unittest tests.test_workflow_credentials -v
```

| 测试 | 钉住的规则 |
|---|---|
| `test_a_saved_literal_key_reaches_the_stage_adapter` | **本轮漏掉的那条路径**：settings 只有字面 key、`key_env` 为空时，阶段适配器必须带 `Authorization: Bearer` |
| `test_key_env_still_wins_when_no_literal_key_is_saved` | 两种凭据形态都支持：没有字面 key 时回落 `key_env` |
| `test_a_literal_key_outranks_key_env` | 优先级：literal 优先于 key_env |
| `test_a_missing_credential_says_so_instead_of_endpoint_unavailable` | 两者都没有时报"缺凭据"，且**不发**匿名请求 |
| `test_a_remote_profile_with_no_credential_does_not_send_an_anonymous_request` | 反向：401 是"拒绝凭据"而不是"端点不可用" |
| `test_the_workflow_deadline_is_its_own_budget` | 45 s 是交互预算，120 s 是工作流节点预算 |
| `test_a_failed_stage_records_node_model_deadline_and_elapsed` | 失败记录必须写出**哪个节点、哪个模型、多少秒超时预算、实际耗时**，并保留该阶段的 trace —— 不能只有一句 endpoint unavailable |

这些测试用本地 `http.server` 记录真实请求头，**不依赖外网**，不需要真实密钥。

回归：

```bash
.venv\Scripts\python.exe -m unittest tests.test_workflow_dag tests.test_workflow_credentials -v
```

- `tests/test_workflow_dag.py` **8 项全绿**（DAG 拓扑、并行分支、环检测、legacy steps、trace 证据、路由契约）；
- 相关套件单独复跑：`tests.test_editions` 12 项 OK、`tests.test_model_probe` 18 项 OK；
- **全量回归：529 项，OK（3 项条件跳过）**，2026-10-18T13:08Z：

```bash
.venv\Scripts\python.exe -m unittest discover -s tests
# Ran 529 tests in 103.388s
# OK (skipped=3)
```

那 3 项跳过是既有的条件跳过（Windows 权限不支持符号链接测试；可选 `pypdf` 未安装），与本轮改动无关。测试输出里那些 `OSError: [WinError 10038]` 是测试自身 `http.server` 线程在关闭时的噪声，不影响断言结果（全量为 OK）。

### 遗留项（本轮不修，需后续确认）

1. **`extract` 节点 147.937 s > 120 s 预算却没失败**。`WORKFLOW_NODE_TIMEOUT` 约束的是单次 socket 传输，不是整段生成；一个慢但持续有数据流的响应可以超出预算而不触发超时。数字如实保留，但"120 s 是硬上限"这个说法**不成立**，需要单独确认语义（是想要"单次传输空闲上限"还是"整节点墙钟上限"）。
2. **judge probe 15 s 上限偏紧**：reasoning 模型冷启动单次可超 20 s，probe 会如实报超时。当前记录保留这次 15141 ms 失败，不掩饰。
3. **T3 的宿主加载问题**在 P7，本轮不给结论。
4. **独立版仍是旧构建**：本轮修复只在 devel 生效，待用户审核后由 Lead 重建。
