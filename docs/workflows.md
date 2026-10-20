# 工作流引擎（DAG 执行器）

> 代码：`memora_core/workflows.py` · 提示词：`memora_core/prompts.py` · 模板生成器：`tools/build_assets.py`
> 测试：`tests/test_workflows.py` · `tests/test_workflow_templates.py` · `tests/test_workflow_persist.py` ·
> `tests/test_workflow_runtime.py` · 验收脚本：`tools/run_all_workflows.py`
> 契约：`docs/ARCHITECTURE.md` §4.6（冻结签名）/ §8（降级矩阵）

18 条内置模板不是文档插图，是**能跑的执行体**：每一步有状态、有耗时、有降级标记，
全部输入与步骤输出落库，可按同一输入重跑对比。这是"记忆中枢"与"存储桶"的分界线。

## 1. 对外接口（冻结签名 + 1.1.0 扩展）

    NODE_HANDLERS: dict[str, Callable[[WorkflowContext, dict], dict]]
    class WorkflowContext          # store/gw/inputs/scope/run_id/emitter/degraded/artifacts/cancel

    seed_templates(store) -> int                       # 幂等：按 id 覆盖；逐条 validate_template
    list_templates(store) -> list[dict]                # 含 nodes / edges / fallbacks / trigger_active / problems
    get_template(store, template_id) -> dict | None
    run_workflow(store, gw, template_id, inputs, scope='global', trigger='manual',
                 parent_run_id=None) -> dict           # 同步：跑完才返回
    cancel_run(store, run_id) -> dict                  # 请求取消（见 §2.8）

    # 扩展（不破坏冻结签名，均为关键字参数或新增函数）
    run_workflow(..., emitter=None, cancel=None, max_workers=4, mode="fail")
    start_workflow(store, gw, template_id, inputs, scope, trigger, ...) -> dict   # 异步，立即返回
    cancel_run(store, run_id, wait=2.0, reason="api") -> dict
    get_run(store, run_id) / list_runs(store, limit=50, template_id=None, status=None)
    validate_template(template) -> list[str] / persist_op(params) -> str | None
    register_handler(kind, handler, *, override=True) / handler_catalog() / known_kind(kind)
    start_background(store, gw_factory=None) / stop_background(db_path=None, timeout=5.0)
    reap_interrupted(store) / claim_job(store) / process_job(store, job, gw) / retry_job(store, job_id)
    job_worker_status(db_path=None)

`run_workflow` / `get_run` 返回：

    {id, template_id, template_name, scope_id, trigger, status, cancel_requested,
     steps: [{node_id, name, kind, status, model, degraded, ms, input, output, error,
              attempts, degraded_reasons}],
     output: {...}, error, started_at, finished_at, degraded: ["vector","judge"],
     meta: {steps_total, step_count, models, owner, cancel_*, …}}

`status` ∈ `queued | running | ok | failed | partial | cancelled`：`queued` 只出现在异步运行等待
运行池空位时（§2.7）。`partial` 的语义是「跑完了但有能力降级」，绝不冒充 `ok`。
step 的 `status` ∈ `running | ok | degraded | failed | skipped | cancelled`：`running` 是节点开跑时先落的
一行（轮询能看到正在跑哪一步）；处理器返回 `{"status": "skipped"}`（前置条件不满足，例如硬删除没有
显式同意）时该步记 `skipped`，原因在 `output.reason`。

### 1.1 HTTP（server.py）

| 路由 | 行为 |
|---|---|
| `POST /api/workflows/{id}/run` | 默认**同步**：跑完返回 `201` + run（1.0.0 的形状），`emitted` = 本次运行真正发布的 run 事件数。`?async=1` 或 body `{"async": true}`：**立即** `202` + run（`queued`/`running`）+ `Location: /api/runs/{id}`。可选 body `mode`=`fail`/`skip`（非法 → 400）。模板不存在 → 404 `TEMPLATE_NOT_FOUND` |
| `POST /api/runs/{id}/cancel` | `200` 已收尾为 `cancelled`；`202` 请求已记下、执行器还在收尾（`cancel_requested: true`）；`409 RUN_FINISHED` 运行已结束（或取消生效前已跑完）；`404 RUN_NOT_FOUND`。最多等 2 秒 |
| `GET /api/runs` / `GET /api/runs/{id}` | 列表 / 详情（详情含 `steps`，正在跑的步 `status=running`） |
| `GET /api/workflows` / `/{id}` | 模板，附 `trigger_active` / `trigger_note`（触发器是否真的会触发）与 `problems` |
| `GET /api/jobs` | job 列表 + `worker`（job 消费者状态） |
| `POST /api/jobs/{id}/retry` | 重新排队（attempts 归零）；`409 JOB_RUNNING` / `404 JOB_NOT_FOUND`；只写一条 `job.retry` 审计 |

服务启动时 `Runtime.bootstrap()` 调 `start_background`（启动回收 + job 消费者）；
`graceful_shutdown()` 调 `stop_background`（停消费者、请求取消本库仍在执行的运行）。

## 2. 执行语义（测试逐条覆盖）

1. **拓扑分层**：按 `edges` 建 DAG，Kahn 分层，入度 0 的层先跑；同层用
   `concurrent.futures.ThreadPoolExecutor`（上限 4）并行。成环的节点追加在末层，不会死循环
   （内置模板由 `validate_template` 保证无环）。
2. **只读祖先、最近优先**：派发节点时 `ctx.artifacts` 换成「祖先链快照」，兄弟分支互不可见，
   并按「远 → 近」排列（跳数少 = 近，同跳数按模板节点顺序）。`ctx.text_for` / `first_list` /
   `values` 与各节点的候选读取都取**最近的祖先**（1.0.0 按节点 id 字母序，读到的是字母序最前的祖先）。
   节点可以用 `params.from=<节点 id>` 显式指定读哪个祖先的条目。
3. **边条件 `when`**：`always` / `on_success` / `on_degraded` / `on_failure` / `if:<key>`。
   `if:` 只读**该边源节点及其祖先**的产物（最近优先，支持 `node.key` 限定），兄弟分支的字段打不开闸门。
   一个节点有多条入边时任一成立即执行；全部不成立则 `skipped`（仍写 step 行）。未知写法不成立
   （1.0.0 一律放行），且 `validate_template` 会报出来。
4. **失败传播**：节点抛非 `ModelUnavailable` → 该节点 `failed`，沿非 `on_failure` 边的所有下游
   `skipped`；从失败节点经 `on_failure` 边可达的「失败处理分支」照常执行（1.0.0 里它永远不会触发）。
   `mode="fail"`（默认）：除失败处理分支外其余未执行节点全部 `skipped`，run = `failed`；
   `mode="skip"`：只掐失败节点的下游，其余分支继续，run = `partial`。
5. **降级**：执行器开跑前先把「没有任何可用档位的网关」折叠成「无网关」，所以 `gw=None` 与
   0 档位的真实 `ModelGateway`（HTTP / MCP 路径）**行为与输出逐模板一致**
   （`tests/test_workflow_templates.py`、`tools/run_all_workflows.py --gateway both`）。节点只在
   对应角色有可用档位时才调模型（`_llm(ctx, role)`），否则走确定性实现并标降级。
   配置了模型、调用时抛 `ModelUnavailable` → 在 `_offline(ctx)` 里执行模板 `fallbacks[node_id]`
   （fallback **绝不碰模型**；1.0.0 只有 3/32 个 fallback 关掉了模型通路）；没声明 fallback 的节点
   离线重跑自身（1.0.0 返回空产物）。该步 `degraded`，`attempts` 记两次尝试（`handler` →
   `fallback` / `offline-rerun`），run = `partial`。离线实现自己也失败 → `failed`。
6. **可复现**：`workflow_run.input/output/metadata` 与 `workflow_step` 全量落库；
   `step.input` 存「实际喂进去的可见产物摘要」，`step.output` 截断到 4KB（超出给 `truncated/preview`）。
   线程与连接：`Store.con` 是 thread-local。并行层每个线程用一个**不带 vault 构造、再挂上共享 vault
   引用**的 Store（1.0.0 用 `Store(db, vault)` 构造，会把共享 Vault 重新 attach 到这个短命实例上），
   执行完立即关闭。
7. **异步与进度**：`start_workflow` 插入 `queued` 行，交给有界运行池（`RUN_POOL_SIZE=2` 个线程），
   立即返回；池子接手时 CAS `queued→running`。每次运行经事件总线发 `run` 类型事件（不新增类型），
   `data.phase` ∈ `queued | start | step | emit | cancel_requested | end`，`step` 事件带
   `{node_id, name, kind, status, ordinal, ms, degraded, error}` 与 `progress {done, total}`；
   每个节点开跑（`running`）和结束各发一次。同步运行同样发这些事件。
8. **协作式取消**：`cancel_run` 先把请求记进 `metadata.cancel_requested`（只对 `queued/running` 生效的
   CAS 写，不会把一个刚结束的运行改成 `cancelled`），**不**直接改状态。执行器在层边界、节点开跑前
   检查取消令牌（进程内事件 + DB 标记，后者跨进程、0.25 s 节流轮询）；长循环节点经
   `ctx.check_cancel()` 检查（classify、cue 生成、向量写入、建图、persist 的逐条写入循环）。没跑的节点记
   `cancelled`，run = `cancelled`，终态写是 CAS（`... WHERE status='running'`）。
   排队中 → 直接收尾；不在本进程执行且执行者进程已不在（孤儿）→ 直接收尾；执行者还活着 → 只留标记。
   取消请求到达时所有节点已跑完 → 按事实收尾（`ok/partial/failed`），`meta.cancel_ignored` 说明，
   `cancel_run` 在等待期内看到这个终态就抛 `WorkflowConflict`，否则返回 `running` + `cancel_requested`。
   已结束 → `WorkflowConflict`（HTTP 409），不存在 → `WorkflowNotFound`（404）。
9. **启动回收**：`start_background` 先调 `reap_interrupted`：执行者已不在的 `queued/running` 运行 →
   `failed`，`error = "interrupted: the server stopped before this run finished…"`，它们 `running` 的步
   同样标 `failed`；`running` 的 job 还有次数就退回 `queued`，否则 `failed`。运行行的
   `metadata.owner = {pid, boot}` 用来判断执行者是否还活着（同库的 MCP stdio 进程正在跑的运行不动）。

## 3. 17 种节点

| kind | 行为要点 | 无模型时 |
|---|---|---|
| input | 校验并规整输入（缺必填抛 `WorkflowInputError`），并把声明的输入变成材料：记忆 id → 记忆正文；`turns`/`session` → 会话转写；`params.formats`+`path` → 读文件/目录；`items` → 条目；`params.strategy` → 按策略收集候选记忆；`params.by` 含 `updated_at` → `since` 之后变更的记忆；`params.collect` → 工作区 / 近期会话转写。没有正文就是没有（1.0.0 会把 inputs 的 JSON 当正文） | 纯规则 |
| transform | normalize / chunk / fields / split（含 `one_proposition`）/ greedy-budget / lessons | 纯规则 |
| extract | `prompts.extract` 走 LLM；无模型用「标题 + 句子 + 意图词」。`kinds` 含实体类型或 `alias_merge` 时是实体抽取（没有模型实现，按大写词 / 名词短语规则抽取并标降级）；`scope_memories` 时读作用域内已审核记忆 | 规则抽取 |
| classify | 复用 `judge.classify`（自带 LLM→关键词兜底） | 关键词 |
| retrieve | `retrieval.search`（查询取 `query`/`topic`/正文）；另有 graph 扩展 / 近似召回 / 证据链；没有查询但有 `strategy` 时按重要度列出作用域内已审核记忆（`engine=browse`，写明不是相关性检索） | BM25+本地向量 |
| embed | `gw.embed` → 否则本地 hash 向量（**step 标 degraded**）；只给有 id 的对象写 `vector`（`owner_kind` 可为 chunk） | char n-gram hash 256 维 |
| rerank | `gw.rerank`；否则原顺序透传并标 degraded | 分数透传 |
| fuse | rrf / mmr / weighted / band / conflict-score / exponential-decay（`archive_below` 给每条打 `archive` 标记）/ weight-threshold | 纯算法 |
| judge | dedup 七动作（只和召回到的旧记忆比，没召回到 → add）/ 冲突裁决 / 时序关系 / 可信度排序 / `rubric=grade` 批改（`inputs.answers`，没有作答 → skipped） | `judge.*` 规则兜底 |
| verify | 引句核验 / 内容哈希（全文 sha256，与 ingest 同口径）/ 孤儿 GC / 频次核验 / 题目规则（answerable / no_leak / not_trivial） | 纯规则 |
| persist | 按 `persist_op(params)` 分派到唯一操作（§3.1），解析不了 → failed | 纯规则 |
| index | FTS 重建 / 向量增量（**真的写**缺失的向量；1.0.0 只数一下）/ 索引统计 | 纯规则 |
| graph | 建实体 + 共现窗口内的 `semantic` 边（不编造 hypernym 等关系；模板要这些关系时 step 标降级）/ 并查集社区 / 度中心性 | 纯 python |
| generate | `gw.chat`；失败走抽取式（首句 / 要点 / 逐条填空题带 `source_id` / 逐条线索 `pairs`） | 抽取式 |
| decide | 调 judge 选动作；否则按上游判定 / 冲突 / 核验结果规则选择（没有冲突对时给 `none`） | 规则 |
| schedule | `params.job`=目标模板 → 写 `job`（由 job 消费者执行）；`algorithm=sm2` → 计算首次复习到期时间（不入队）；都不是 → failed；给了 `cron` → 只入队一次并标降级 | 纯规则 |
| emit | 发布到事件总线（`run` 事件，`phase=emit`），如实报告 `published / subscribers / delivered / via` | 写 audit |

未注册的 kind（含 `fallback:*` 别名）→ 该步 `failed`，错误「未知节点类型」（1.0.0 登记为 noop + degraded）。

### 3.1 persist 操作（`params.op`，内置模板全部显式声明）

| op | 做什么（全部经 Store API，`origin="workflow"`） | 做不到时 |
|---|---|---|
| memory | `add_memory` 写 **draft / candidate**（模板要 approved 也写 candidate 并报告 `requested_status`）；`from` 指定来源节点；`idempotent_by`；`review_due_from` | 来源没有条目 → skipped |
| markdown / report / audit | vault 日记镜像 / 报告 / 审计 | vault 不可用 → degraded |
| candidate / recall_log / job | 写对应表（job 与 schedule 同一入队实现，必须给 `job`） | candidate / recall_log 写失败 → degraded；job 没目标或写失败 → failed |
| archive | 对条目（有 `archive` 标记时只取标记为真的）`set_status(archived)` | 状态机不允许的逐条列在 `skipped` |
| purge | `delete_memory(hard=True)`，**只在** `inputs.explicit_consent=true` 且给了 `inputs.purge_ids` 时；`audit` 另写 `workflow.purge` | 没同意 / 没 id → skipped，一条不删 |
| supersede | 一个事务里：旧记忆 `status=superseded`、`superseded_by`、`valid_to`（按 `set_fields`）+ `新 --supersedes--> 旧` 边；对子来自 `new_id/old_id`、`a_id/b_id`+时间关系、或 `candidate`+`target_id` | 没有对子 → skipped；新记忆未批准 → 登记 `needs_review` 候选、不动旧记忆；非法迁移 → failed 并回滚 |
| link | `add_edge(rel)`：`supersedes` 用上游实际推翻的对子；`cue_of` 把线索登记为 cue 实体连到细节记忆；`part_of` 把写出的子记忆连到输入记忆 | 端点不全 → skipped |
| review_log | 上游批改结果逐条写 `review_log` 并按 SM-2 更新记忆（与 `/api/memories/{id}/review` 同一算法） | 没有批改结果 → skipped |
| merge | noop → 不写；add → 新候选；link → 新候选 + semantic 边；merge/update/supersede/ask → 登记 `needs_review` 候选，不自动改写已有记忆 | 没有上游判定 → failed |
| document | `ingest.ingest_text`（document + chunk + vault/notes 镜像），输出 chunk id 供向量化 | 内容哈希重复 → skipped |
| conflict | 冲突分 ≥ `min_score` 的对子写 `conflict`（同一对已有 open 冲突则跳过）+ 审计报告 | vault 不可用 → 报告不写、degraded |
| graph | 只汇总上游真实写入的实体 / 边数量，`written=0` | — |

## 4. 降级矩阵落地（节点 → fallback）

模板 `fallbacks` 里的名字，一律以 `fallback:<name>` 注册在 `NODE_HANDLERS`，只能经模板 `fallbacks`
显式引用（节点 kind 不能借 `fallback:` 前缀别名）。执行时一律包在 `_offline(ctx)` 里：
`ctx.gw=None`、`ctx.use_llm=False`，fallback 不可能再调模型。

| 节点 | fallback | 确定性实现 |
|---|---|---|
| extract | rule-extract | 标题 + 句子 + 意图词 |
| classify | rule-classify | 关键词分类 |
| judge（去重） | score-rule / score-threshold | 阈值 0.92 / 0.80 / 0.55 分带 |
| judge（冲突） | trust-and-time-order | 可信度差 ≥0.2 胜出，否则时间序 |
| judge（时序） | timestamp-order | 时间戳先后 |
| judge（证据） | trust-weight-order | trust × (1 + 0.1·来源数) |
| verify | quote-check-only | 关键词重叠 ≥50% 视为有引句支撑 |
| retrieve（向量通道） | bm25-only / fts-near | 全文通道 / 全文近似召回 |
| retrieve（图通道） | skip | 返回空结果继续 |
| rerank | score-passthrough | 分数与顺序透传 |
| embed | char-ngram-hash | 本地 256 维 hash 向量 |
| generate（摘要） | lead-sentences | 首句 + 均衡挑句 |
| generate（线索） | title-as-cue / cloze-from-text / cloze-template | 问句 / 填空卡 |
| generate（报告/摘要包） | template-report / template-digest | 模板渲染 + 编号引用 |
| extract（实体/决策） | capitalized-noun-phrase / keyword-time-slice / frequency-count | 大写词 / 关键词时间切片 / 频次 |
| graph | cooccurrence / cooccurrence-window / connected-components / degree | 共现建边 / 连通分量 / 度中心性 |
| index | mark-degraded-keep-old | 保留旧向量不写入 |
| fuse | simple-age-rule | 简单年龄衰减 |
| 任意 | skip | 显式跳过该分支 |

没有 fallback 声明的节点，抛 `ModelUnavailable` 时**离线重跑自身**（`attempts` 记 `offline-rerun`），
产物就是 gw=None 时的确定性结果；离线也需要模型（极少数自定义处理器）才给空产物并标 degraded。
run 记 `partial`。

## 5. 可观测性

- `workflow_step`：`status` ∈ `running|ok|degraded|failed|skipped|cancelled`、`ms`、
  `model`（`provider/model`，未用模型为空）、`degraded`、`tokens`、`error`。
- 输出里的 `_meta` 记录 `attempts`（handler → fallback / offline-rerun）与
  `degraded_reasons`（哪个能力、因为什么降级），读回时提升为 step 顶层字段。
- `run.degraded` 是去重后的能力名列表（`vector` / `rerank` / `judge` / `generate` …），
  界面据此显示「当前处于离线降级」；`run.meta.models` = `gateway` | `none`。
- 进度：事件总线 `run` 事件（§2.7）；`GET /api/runs/{id}` 逐步可见。
- 审计：`workflow.seed` / `workflow.seed.invalid` / `workflow.run.queued` / `workflow.run.start` /
  `workflow.run.end` / `workflow.run.finalize_conflict` / `workflow.run.reaped` / `workflow.cancel` /
  `workflow.emit` / `workflow.purge` / `job.enqueue` / `job.ok|failed|cancelled|retry_scheduled` /
  `job.reaped` / `job.retry`，以及各 persist 操作经 Store 写的 `memory.*` / `edge.add` /
  `candidate.add` / `conflict.add` / `memory.review`。

## 6. 输入规整与必填判定

模板 `inputs` 的说明是中文（「原文内容」「检索语句」「候选记忆」…），执行器把它映射成语义槽位：

    content / query / candidate / memory / document / session / workspace / topic

- 只有上述槽位算「必填」；时间窗、预算、智能体名等按可选处理（不阻塞既有调用方）。
  说明里写了「可选」的输入一律不进必填槽位（例如 update-supersede 的 `new_id` / `old_id`）。
- 模板**没有声明任何输入**时至少要一段正文；声明了输入但全是可选槽位（forget-decay 的
  `scope`、incremental-index 的 `since` …）时**不要求任何输入**（1.0.0 退回要求 `content`，
  6 条模板只给声明的输入也过不了闸门）。
- 给了模板为该槽位声明的键就算满足（detail-abstraction 用 `items` 声明「记忆」槽位）。
- `input` 节点默认只检查**自己没有上游节点**的情况，避免同一份输入被要求两次；
  节点 `params.required` 可显式覆盖。
- 槽位满足支持同义键（`content` / `text` / `body` 互通，`query` 可由文本键回退）。
- 缺失时抛 `WorkflowInputError`，错误信息里列出缺哪些槽位、已给哪些键。
- `validate_template` 用「只给声明的输入」模拟一遍闸门；18 条内置模板全部通过（单测断言）。

## 6.1 宽容输入校验（2026-10-19 决策）

模板 `inputs` 声明的多个槽位**不再逐项硬性要求**：

| 情形 | 行为 |
|---|---|
| 一个主槽位被满足（给了 `content` 或 `query` 等任一段文本） | 其余槽位用同一段文本**回填**，`step.output.backfilled` 记录回填了哪些 |
| 一个可用输入都没给 | 仍然抛 `WorkflowInputError`（这是唯一硬失败条件） |
| 节点 `params.required=[...]` 显式声明 | **严格逐项校验**，只看该槽位自己的键，不回填、不走文本别名 |

理由：用户点一次「运行」不该被三四个必填项挡在门外；真实缺信息时下游节点会自己降级并留痕
（`run.degraded`）。需要严格语义时用 `required` 显式声明。

实测（`python tools/run_all_workflows.py`）：18 条模板只给**各自声明的输入**时全部 ok/partial，
gw=None 与 0 档位网关两条路径逐模板一致；没有任何声明输入时，只有声明了必填槽位的模板报错；
`required=[...]` 严格生效。

## 7. 提示词模板（prompts.py）

    load(name, default='')                 # 读 builtin/prompts.json
    render(template, variables_map=None, *, strict=False, **kw)
    render_named(name, variables_map=None, *, strict=False, **kw)
    parse_json(text, expect=dict)          # 宽容解析（围栏 / 前后噪音 / 括号配平）
    builtin_prompts() / variables() / missing()

- `{{var}}` 与 `{{ var }}` 都支持；dict/list 自动 JSON 序列化，`None` 渲染为空串。
- 未提供的变量**保留原样**（不会被二次解析）；`strict=True` 时抛 `PromptVariableError`。
- 文件里没有、但节点要用的模板放在 `DEFAULT_PROMPTS`（文件同名键优先），因此用户热改文件即可覆盖。

## 8. 测试

    python -m unittest tests.test_workflows tests.test_workflow_templates \
        tests.test_workflow_persist tests.test_workflow_runtime -v
    python tools/run_all_workflows.py            # 18 条模板 × {gw=None, 0 档位网关}，比对一致性

- `test_workflows`：seed 幂等 / list & get / kind 全注册 + 模板全部通过校验 / 三条模板无模型跑通 /
  可复现结构 / `if:` 分支 / `on_degraded` / 失败传播 / 输入缺失 / 降级 fallback / 并行 / 祖先可见性 /
  4KB 截断 / 取消（真的调用 `cancel_run`）/ 结束运行取消冲突 / 落库 / mode=skip / 提示词。
- `test_workflow_templates`：18 条通过 `validate_template`、校验器逐类抓坏模板、17 种 node.kind
  （「21 种」= 17 + 4 个 trigger.kind）、只给声明输入全部可跑、gw=None 与 0 档位网关逐模板一致、
  fallback 离线且不调模型、无 fallback 节点离线重跑、未知 kind 运行时 failed、触发器状态、
  session-distill 只写候选。
- `test_workflow_persist`：每个 persist 操作的真实副作用（归档 / 显式同意的硬删除 / 推翻四种情形 /
  去重合并 / 线索配对 / 父子边 / 复习日志 / job 表 / 未知操作 / 图汇总 / 文档库与重复 / 冲突表）。
- `test_workflow_runtime`：异步 202 语义与逐步事件、`queued`、排队中取消、运行中取消（节点内取消点 /
  节点边界 / 跨进程 DB 标记）、两种竞态、CAS 终态写、启动回收（执行者已死 / 还活着）、孤儿取消、
  `if:` 谱系 / 最近祖先 / `on_failure`、emit 如实报告、并行层不改共享 vault、hash 向量标降级、
  job 领取 / 退避 / 无目标 / 重试审计 / 后台消费者、会话结束用网关、HTTP 路由（202 / 200 / 409 / 404）。

## 9. 已知边界

- **没有定时调度器**：`schedule`（cron）/ `ingest` 触发器只是模板元数据，模板列表 / 详情如实给出
  `trigger_active: false` 与 `trigger_note`；这类模板请手动运行或由智能体调用。会话结束触发
  （session-distill）照常生效。不做 cron 的原因：forget-decay 这类有破坏性的模板不能在没有
  人工同意界面的情况下无人值守地跑。
- **job 消费者只在 `serve` 启动的服务进程里运行**（`Runtime.bootstrap` → `start_background`）。
  MCP stdio 进程会入队（例如 quick-capture），由服务进程消费；服务没开时任务留在 `queued`。
- **异步运行的队列不跨重启**：服务停止时仍在排队 / 执行的运行，下次启动由回收标 `failed`
  （优雅关停时先请求取消，能在节点边界收尾的记 `cancelled`）。
- **执行者存活判断**靠 `metadata.owner = {pid, boot}`：PID 复用的极小概率下，回收可能把一条孤儿运行
  当成「还活着」而保留；同一进程里模块被重新加载过时也保守地视为活着。
- **取消是协作式的**：不检查取消的长节点（例如一次很慢的模型调用）要等它返回才停；`cancel_run`
  最多等 2 秒，之后返回 `cancel_requested: true`，执行器稍后收尾。
- **推翻要求新记忆已被人批准**；否则只登记待审核候选。**硬删除只在显式同意 + 明确的 id 列表**时执行。
- **社区发现是连通分量**、**中心度是度中心性**：无第三方图库，Louvain/PageRank 位置用
  并查集与度中心性代替，输出可解释、可复现。
- **本地近似召回是加权启发式**：`sim` = max(jaccard, simhash 相似度, hash 余弦)，一律在本地计算，
  用于分层分带，不等价于语义相似度（召回候选的那一步若配置了 embedding 会用云端向量）。
- **没有模型实现的判断一律是规则并标降级**：实体抽取（大写词 / 名词短语）、关系类型（只建共现
  `semantic` 边）、批改（字符串相似度）、时序关系（时间戳）。
- **`input` 节点默认是"硬闸门"**：缺必填输入 → `WorkflowInputError` → run failed（默认 mode="fail"）。
  若某个调用方希望"输入不合法就跳过"，用 `mode="skip"` 或模板里的 `if:` 分支表达，而不是改 input 行为。
