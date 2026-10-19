# 工作流引擎（DAG 执行器）

> 代码：`memora_core/workflows.py` · 提示词：`memora_core/prompts.py` · 测试：`tests/test_workflows.py`
> 契约：`docs/ARCHITECTURE.md` §4.6（冻结签名）/ §8（降级矩阵）

18 条内置模板不是文档插图，是**能跑的执行体**：每一步有状态、有耗时、有降级标记，
全部输入与步骤输出落库，可按同一输入重跑对比。这是"记忆中枢"与"存储桶"的分界线。

## 1. 对外接口（冻结）

    NODE_HANDLERS: dict[str, Callable[[WorkflowContext, dict], dict]]
    class WorkflowContext          # store/gw/inputs/scope/run_id/emitter/degraded/artifacts

    seed_templates(store) -> int                       # 幂等：按 id 覆盖，行数恒为 18
    list_templates(store) -> list[dict]                # 含 nodes / edges / fallbacks
    get_template(store, template_id) -> dict | None
    run_workflow(store, gw, template_id, inputs, scope='global', trigger='manual',
                 parent_run_id=None) -> dict
    cancel_run(store, run_id) -> dict

    # 扩展（不破坏冻结签名，均为关键字参数或新增函数）
    run_workflow(..., emitter=None, cancel=None, max_workers=4, mode="fail")
    get_run(store, run_id) / list_runs(store, limit=50, template_id=None, status=None)
    register_handler(kind, handler, *, override=True) / handler_catalog()

`run_workflow` 返回：

    {id, template_id, template_name, scope_id, trigger, status,
     steps: [{node_id, name, kind, status, model, degraded, ms, input, output, error,
              attempts, degraded_reasons}],
     output: {...}, error: null, started_at, finished_at, degraded: ["vector","judge"]}

`status` ∈ `queued | running | ok | failed | partial | cancelled`。
`partial` 的语义是「跑完了但有能力降级」，绝不冒充 `ok`。

## 2. 执行语义（测试逐条覆盖）

1. **拓扑分层**：按 `edges` 建 DAG，Kahn 分层，入度 0 的层先跑；同层用
   `concurrent.futures.ThreadPoolExecutor`（上限 4）并行。成环的节点追加在末层，不会死循环。
2. **只读祖先**：派发节点时，`ctx.artifacts` 换成「祖先链快照」，兄弟分支互不可见
   （`ctx.artifacts` 不含自身，自身产物在返回后写入）。分支结论因此可解释。
3. **边条件 `when`**：`always` / `on_success` / `on_degraded` / `if:<key>`
   （读祖先产物里的布尔字段，支持 `node.key` 限定）。一个节点有多条入边时，**任一成立即执行**；
   全部不成立则 `skipped`（仍写 `workflow_step` 行）。
4. **失败传播**：节点抛非 `ModelUnavailable` → 该节点 `failed`，所有下游（含间接）`skipped`，
   run = `failed`，`run.error` 带异常类型与消息。
   传 `mode="skip"` 时改为「只掐失败节点的下游、其余分支继续」，run = `partial`
   （用于输入不合法之类不该拖垮整条流程的场景）。
5. **降级**：节点抛 `ModelUnavailable` → 查 `template['fallbacks'][node_id]`，
   有则执行 `fallback:<name>` 处理器；无则把该能力记进 `run.degraded` 并继续。
   该节点 `status=degraded`、`degraded=true`，run = `partial`。
   fallback 自己也失败时 → `failed`（并保留两步 attempts 记录）。
6. **可复现**：`workflow_run.input/output/metadata` 与 `workflow_step` 全量落库；
   `step.input` 存「实际喂进去的可见产物摘要」，`step.output` 截断到 4KB（超出给 `truncated/preview`）。
   同一输入重跑，节点序列、状态序列、输入一致；LLM 内容不保证逐字相同，但 `model` 与
   `degraded` 每次都会写清楚。

   线程与连接：`Store.con` 是 thread-local 的 sqlite 连接。并行层里每个线程拿**自己的
   Store 实例**（同 db_path / 同 Vault），执行完立即关闭；调用方那个 Store 不受影响。

## 3. 17 种节点

| kind | 行为要点 | 无模型时 |
|---|---|---|
| input | 校验并规整输入；缺必填抛 `WorkflowInputError` | 纯规则 |
| transform | normalize / chunk / fields / split / greedy-budget / lessons 六种实现 | 纯规则 |
| extract | `prompts.extract` 走 LLM；无模型用「标题 + 句子 + 意图词」 | 规则抽取 |
| classify | 复用 `judge.classify`（自带 LLM→关键词兜底） | 关键词 |
| retrieve | `retrieval.search`；另支持 graph 扩展 / 近似召回 / 证据链追踪 | BM25+本地向量 |
| embed | `gw.embed` → 失败用 `vectors.hash_embed`，写 `vector` 表 | char n-gram hash 256 维 |
| rerank | `gw.rerank`；失败原顺序透传并标 degraded | 分数透传 |
| fuse | rrf / mmr / weighted / band / conflict-score / exponential-decay / weight-threshold | 纯算法 |
| judge | dedup 七动作 / 冲突裁决 / 时序关系 / 可信度排序 | `judge.*` 规则兜底 |
| verify | 引句核验 / 哈希核验 / 孤儿 GC / 频次核验 | 纯规则 |
| persist | memory / markdown / report / audit / candidate / recall_log（按 `target|table` 分派） | 纯规则 |
| index | FTS 重建 / 向量增量 / 影子索引统计 | 纯规则 |
| graph | 建实体与边 / 并查集社区 / 度中心性 | 纯 python |
| generate | `gw.chat`；失败走抽取式（首句 / 要点 / 填空卡 / 模板报告） | 抽取式 |
| decide | 调 judge 选动作；失败按上游判定 / 冲突 / 核验结果规则选择 | 规则 |
| schedule | 写 `job` 表（延时 / 周期），**不起定时器** | 纯规则 |
| emit | `ctx.emitter` 广播 SSE；无订阅者写 audit（`via: audit`） | 写 audit |

缺失的 kind 登记为 noop 并标 degraded（架构 §4.6），不会静默吞掉。

## 4. 降级矩阵落地（节点 → fallback）

模板 `fallbacks` 里的名字，一律以 `fallback:<name>` 注册在 `NODE_HANDLERS`。

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

没有 fallback 声明的节点，抛 `ModelUnavailable` 时标 degraded 继续，run 记 `partial`。

## 5. 可观测性

- `workflow_step`：`status=`ok|degraded|failed|skipped|cancelled`、`ms`、
  `model`（`provider/model`，未用模型为空）、`degraded`、`tokens`、`error`。
- 输出里的 `_meta` 记录 `attempts`（handler → fallback 两次尝试）与
  `degraded_reasons`（哪个能力、因为什么降级），读回时提升为 step 顶层字段。
- `run.degraded` 是去重后的能力名列表（`vector` / `rerank` / `judge` / `generate` …），
  界面据此显示「当前处于离线降级」。
- 所有写操作带 audit：`workflow.seed` / `workflow.run.start` / `workflow.run.end` /
  `workflow.cancel` / `workflow.emit` / `job.enqueue`。

## 6. 输入规整与必填判定

模板 `inputs` 的说明是中文（「原文内容」「检索语句」「候选记忆」…），执行器把它映射成语义槽位：

    content / query / candidate / memory / document / session / workspace / topic

- 只有上述槽位算「必填」；时间窗、预算、智能体名等按可选处理（不阻塞既有调用方）。
- `input` 节点默认只检查**自己的上游没有 input 节点**的模板，避免同一份输入被要求两次；
  节点 `params.required` 可显式覆盖。
- 槽位满足支持同义键（`content` / `text` / `body` 互通，`query` 可由文本键回退）。
- 缺失时抛 `WorkflowInputError`，错误信息里列出缺哪些槽位、已给哪些键。

## 6.1 宽容输入校验（2026-10-19 决策）

模板 `inputs` 声明的多个槽位**不再逐项硬性要求**：

| 情形 | 行为 |
|---|---|
| 一个主槽位被满足（给了 `content` 或 `query` 等任一段文本） | 其余槽位用同一段文本**回填**，`step.output.backfilled` 记录回填了哪些 |
| 一个可用输入都没给 | 仍然抛 `WorkflowInputError`（这是唯一硬失败条件） |
| 节点 `params.required=[...]` 显式声明 | **严格逐项校验**，只看该槽位自己的键，不回填、不走文本别名 |

理由：用户点一次「运行」不该被三四个必填项挡在门外；真实缺信息时下游节点会自己降级并留痕
（`run.degraded`）。需要严格语义时用 `required` 显式声明。

实测：18 条模板在只给 `{"content": "..."}` 时**全部** ok/partial，无一条因校验失败；空输入
仍报错；`required=[...]` 严格生效。

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

    python -m unittest tests.test_workflows -v      # 28 个用例

覆盖：seed 幂等（3 次 = 18 行）/ list & get / 17 handler 全覆盖 + fallback 名字全解析 /
三条模板无模型跑通（ok|partial）+ step 行数 == 节点数 / 可复现结构 /
`if:` 分支不执行 / `on_degraded` 边只在降级时触发 / 失败传播（下游 skipped + run failed）/
输入缺失 / 降级 fallback（attempts 两步）/ 同层并行（峰值并发 ≥2）/ 祖先可见性与兄弟隔离 /
4KB 截断 / 取消 / 结束运行取消冲突 / 运行与步骤落库 / mode=skip 分支隔离 /
提示词渲染与解析。

## 9. 已知边界

- **不启动定时器**：`schedule` 只写 `job` 表；真正的调度由 job 执行器（另一模块）负责。
- **社区发现是连通分量**、**中心度是度中心性**：无第三方图库，Louvain/PageRank 位置用
  并查集与度中心性代替，输出可解释、可复现。
- **本地近似召回是加权启发式**：`sim` = max(jaccard, simhash 相似度, hash 余弦)，
  用于分层分带，不等价于语义相似度；有 embedding 时优先走云端向量。
- **`input` 节点默认是"硬闸门"**：缺必填输入 → `WorkflowInputError` → run failed（默认 mode="fail"）。
  若某个调用方希望"输入不合法就跳过"，用 `mode="skip"` 或模板里的 `if:` 分支表达，而不是改 input 行为。
