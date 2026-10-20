# 检索与算法层（vectors / retrieval / dedup / chunking）

> 对应 ARCHITECTURE.md §4.4 §4.5 §8。公式、参数、降级路径都在这里。
> **本页每一个质量 / 延迟数字都能用仓库里的 `tools/eval_retrieval.py` 复现，命令写在数字旁边。**
> 改检索参数：先在 dev 集上跑、再改这里；test 集只在发布时跑一次。
> 算法 id 均可在 `memora_core/data/builtin/algorithms.json` 查到（未实现的条目 runnable=0）。

## 0. 怎么测

| 项 | 说明 |
| --- | --- |
| 数据集 | `old/datasets/memory-eval-v1`（原地引用，不复制不修改）：240 条记忆、160 条分级相关性查询，dev 64 / test 96，7 种查询类型 × zh/en/ja/混排。语料里故意埋了几条提示注入文本，只当数据 |
| 完整性 | README 里冻结的 SHA-256 由脚本校验（CRLF 归一为 LF 后比较，Windows 检出也一致）；不一致则退出码 2 |
| 写库 | 每条语料一条 approved 记忆；title = 正文前 60 字（MCP `memory_remember` 的默认规则）；project → `workspace:<project>`，`@user` → `global`；查询的 scope = 它的 project；默认经 `Store` 对象检索（与服务端 / MCP 同一路径） |
| 指标 | R@10（grade≥1）、MRR@10、nDCG@10（分级，增益 2^g−1）、succ@10（前 10 含 grade-2）、zero（零结果率）、p50/p95（毫秒，预热一次后逐查询计时）。指标自己实现，`tests/test_retrieval_eval.py` 用手算例子钉住定义 |
| 对照组 | `trigram` = SQLite 原生 FTS5 `tokenize='trigram'`（≥3 字的词）；`trigram+like` = 再对 1–2 字的中文段做 LIKE。回答"手写切分是否比 SQLite 自带的强" |
| 回归门槛 | `tests/test_retrieval_eval.py`（dev，约 1.5 秒）：默认 nDCG@10 ≥ 0.615，且不低于 bm25 / substring / bm25+substring；零结果率 0 |
| 环境 | 本页所有数字：Windows 11 / Python 3.12.13 / SQLite 3.50.4 |

    python tools/eval_retrieval.py --split test                               # 留出集（发布时跑一次）
    python tools/eval_retrieval.py --split dev --breakdown --paired hybrid bm25+substring
    python tools/eval_retrieval.py --split dev --set MAX_LIKE_GRAMS=12        # 在 dev 上做消融
    python tools/eval_retrieval.py --split dev --budget 1200                  # 像检索页那样打包（MMR）
    python tools/eval_retrieval.py --split test --code-root <1.0.0 检出目录>   # 同一 harness 测旧版本
    python tools/eval_retrieval.py --split dev --gateway-data <数据目录>       # 用该目录配置的模型（会真实调用）
    python tools/eval_retrieval.py --latency-at 1000,10000 --via connection  # 合成语料上的延迟

## 1. 结果

### 1.1 离线（gw=None），test 集（96 条，留出）

`python tools/eval_retrieval.py --split test`（1.0.0 一列加 `--code-root <1.0.0 检出>`）：

| 策略 | 1.0.0 R@10 / MRR / nDCG / zero | 1.1.0 R@10 / MRR / nDCG / zero |
| --- | --- | --- |
| **hybrid（默认）** | 0.526 / 0.524 / **0.455** / 0.000 | 0.710 / 0.670 / **0.602** / 0.000 |
| bm25 | 0.511 / 0.568 / 0.483 / 0.010 | 0.682 / 0.670 / 0.598 / 0.021 |
| substring | 0.620 / 0.587 / 0.520 / 0.031 | 0.623 / 0.606 / 0.534 / 0.010 |
| bm25+substring | 0.642 / 0.609 / 0.550 / 0.010 | 0.710 / 0.670 / 0.602 / 0.000 |
| vector（本地 hash 草图） | 0.345 / 0.334 / 0.287 / 0.000 | 0.345 / 0.334 / 0.287 / 0.000 |
| trigram（SQLite 原生） | 0.519 / 0.495 / 0.458 / 0.208 | — 同左 — |
| trigram+like（SQLite 原生） | 0.542 / 0.537 / 0.484 / 0.167 | — 同左 — |

dev 集（64 条）nDCG@10，`--split dev`：默认 0.397 → **0.625**；bm25 0.469 → 0.611；substring 0.504 → 0.546；
bm25+substring 0.517 → 0.625；vector 0.255；trigram 0.442；trigram+like 0.483。

怎么读这张表：

- **1.0.0 的默认比它自己的关键词部分还差**（test 0.455 vs bm25+substring 0.550，逐查询 17 好 / 35 差）。
  原因是 hash"向量"：它是词形草图，随便一个查询都能让大半条记忆拿到正分（vector 一行 zero=0），
  混进 RRF 等于往融合里加噪声。1.1.0 没有 embedding 模型时 hybrid 不再含这条通道。
- **手写切分 vs SQLite 原生**：原生 trigram 0.458、trigram+LIKE 0.484，1.0.0 的"二元组前缀 + LIKE"
  （bm25+substring）0.550，1.1.0 默认 0.602。trigram 无法匹配 1–2 字的中文词，五分之一的查询零结果。
- 1.1.0 离线时 hybrid 与 bm25+substring 相同：评测集没有实体 / 关系边，图通道为空。
- 按类型（test，1.1.0 默认）：keyword 0.956、scoped 0.753、short 0.716、question 0.631、
  cross-lingual 0.442、negative 0.417、paraphrase 0.346（`--breakdown`）。改写与跨语言是任何词法检索的弱项，
  要靠 embedding 模型。

### 1.2 有 embedding 模型

本机 Ollama `qwen3-embedding:0.6b`（1024 维，未配重排模型），`--gateway-data <配置了该档位的数据目录>`：

| | dev nDCG@10 | test nDCG@10 |
| --- | --- | --- |
| 1.0.0 hybrid | 0.712 | 0.737 |
| **1.1.0 hybrid（默认）** | **0.832** | **0.834** |
| 1.1.0 vector（只用向量） | 0.831 | 0.839 |
| 1.1.0 bm25+substring | 0.625 | 0.602 |

test 逐查询：hybrid 对 bm25+substring 55 好 / 16 差；对 vector 9 好 / 12 差（差异在噪声内）。
p50 ≈ 126 ms，基本是一次 query embedding 的 HTTP 往返。只测过这一个模型。

### 1.3 dev 上的决定（每一条都有 dev 数字，test 未参与）

| 步骤 | dev nDCG@10（默认） |
| --- | --- |
| 1.0.0 | 0.397 |
| 去掉 hash 草图（= FTS5 bm25 + 子串） | 0.517 |
| bm25 换成 Python 侧切分 BM25（覆盖率加权仍开） | 0.570 |
| 关闭 RRF 覆盖率加权 | 0.608 |
| 子串检索词上限 12 → 32（32 以上不再变化） | 0.625 |
| 带 `--budget 1200`（MMR + 打包，检索页的用法） | 0.618（1.0.0 同条件 0.398） |

最终配置上的消融（dev，`--set NAME=VALUE`）：FTS5 引擎 0.546；覆盖率加权 0.577；查询侧不去虚词 0.560；
不做复数归一 0.604；不做前缀 0.612；单字权重 0.1 / 0.5 → 0.618 / 0.622；子串按池内 IDF 加权 0.619；
子串权重 0.25 / 1.0 → 0.621 / 0.617；k=20 0.625；b=0.5 0.617；列权 1/1/1 0.621；ASCII 子串最短 2 字 0.631。
64 条查询下 ±0.01 是噪声，没有为了这种差距改默认值。

有 embedding 模型时关键词通道的权重系数 `SEMANTIC_LEXICAL_SCALE`（dev，上面那个模型）：
1.0 → 0.717，0.5 → 0.749，0.3 → 0.782，0.2 → 0.786，0.1 → 0.809，0.05 → 0.824，**0.02 → 0.832**。
系数越小越接近"向量排序、关键词打破平局"；还没有向量的记忆不乘这个系数（见 §2.3）。

## 2. 流水线

    候选池  SQL 直读 memory：approved（+candidate）、作用域自身+祖先+global、默认排除 sensitivity='secret'
      ├─ bm25      Python 侧切分 BM25（默认引擎；BM25_ENGINE='fts5' 换回 1.0.0 的 FTS5）
      ├─ substring 候选池内字面子串：ASCII 词（≥3 字符）+ 中文二元组，最多 32 个
      ├─ vector    只用 embedding 模型（gw.embed）；没有模型时 hybrid 不含这条通道
      └─ graph     个性化 PageRank（α=0.85，2 跳）
           ↓  RRF k=60；权重 bm25 1.0 / substring 0.5 / graph 0.6 / vector 1.0；
              有语义向量时 bm25/substring/graph ×0.02（对还没有向量的记忆不乘）
           ↓  rerank（gw.rerank；未配置或失败 = 不重排，保持 RRF 顺序与分数）
           ↓  MMR（只在给了 budget 时，λ=0.7）
           ↓  预算贪心打包（score/len）

| strategy | 通道 |
| --- | --- |
| `hybrid`（默认） | bm25 + substring + graph，embedding 模型可用时再加 vector |
| `bm25` / `substring` / `graph` | 单通道 |
| `vector`（别名 `semantic`） | embedding 模型；没有模型时用本地词形草图并如实标注 |
| `a+b` | 通道组合，如 `bm25+substring`（规范化为固定顺序） |

### 2.1 响应（只增不改）

1.0.0 的 `{hits, degraded, took_ms, strategy, total}` 不变，新增：

| 字段 | 含义 |
| --- | --- |
| `channels_used` | 实际跑成功的通道，如 `["bm25","substring","graph"]` |
| `vector_model` | `null`（没跑向量通道）/ `"provider/model@dim"`（embedding 模型）/ `"local-hash-256"`（本地草图） |
| `semantic` | 向量通道是否来自真正的 embedding 模型 |
| `reranked` | 是否经过重排模型 |
| `score_kind` | `"rrf"`：`hit.score` 是 RRF 原始和（约 0.01–0.05，只用于排序，**不是 0–1 相似度**）；`"rrf+rerank"`：0.65·RRF/最高 RRF + 0.35·重排分/最高重排分，0–1 的相对分 |

`hit.channels` 仍含 bm25 / vector / graph / substring 四个键（没命中为 0.0）；`channels.vector` 的含义
看 `vector_model`。参数 `include_secret`（默认 False）见 §2.6。

### 2.2 切分 BM25（默认关键词通道）

unicode61 **不切中文**："模式保证并发读写能力"是一个 token，紧贴中文的 ASCII（"使用WAL模式"）也粘在一起；
1.0.0 只能用"二元组前缀 OR"去碰。现在在 Python 侧切分，查询与文档同一套规则：

- 规范化：NFKC（全角 → 半角）+ 小写；按文字类别断开（中文/假名/谚文 vs 拉丁/希腊/西里尔/数字），
  "使用wal模式" → 使用 / wal / 模式。
- 文档：中文连续段切重叠二元组（单字段取单字），另记单字；英文按词。
- 查询：同样切分；英文去虚词（the / what / how …）、中文去"两个字都是虚字"的二元组（是什、什么…），
  只在查询侧去；英文做复数归一（S-stemmer：policies→policy、migrations→migration）并对 ≥3 字符的词追加前缀匹配
  （lint → linter）；中文单字以 0.25 的权重回退。全是虚词的查询不去虚词重来一次。
- 打分：BM25，k1=1.2、b=0.75，IDF=ln(1+(N−df+0.5)/(df+0.5)) 在**候选池内**统计；列权 title 3 / summary 1.5 / body 1。
- 实现：不建持久倒排表（那需要 schema 变更）。每条记忆在进程内缓存"规范化文本 + 加权长度"（原文变了即失效），
  查询时对候选池做 C 级子串扫描 + 词边界正则核对。1 万条约 75 ms（§6）。

### 2.3 向量通道与缓存

- 只用 embedding 模型。先嵌入 query（失败就不再为候选池调用网关，挂死的端点只付一次超时），
  再按 `vector` 表里 `model = 'provider/model@dim'` 的缓存取候选池向量。1.0.0 一律用常量 `cloud-embed`，
  换模型或维度后新旧向量按 min(len) 混算；旧的 `cloud-embed` 行 1.1.0 不再读。
- 新鲜度：只采信 `created_at > memory.updated_at`（同为 UTC ISO-8601 秒）的缓存行；`store.update_memory`
  改了 title/body/summary 时直接删掉该记忆的向量行；`vectors.forget_owner()` 供其它写入路径调用。
- 补算：缺失或过期的向量每次检索最多补 400 条、最多 3 秒（`MAX_CLOUD_EMBED` / `BACKFILL_SECONDS`），
  分块调用，失败只损失当前块。仍没有向量的条数写进 degraded（1.0.0 只看候选池前 400 条，其余静默缺席）；
  这些记忆照常参与关键词通道，并且不乘 `SEMANTIC_LEXICAL_SCALE`，不会因为补算进度被埋掉。
- 打分：余弦（纯 Python 点积）。向量矩阵按 (行数, max rowid, rowid 之和, 最新 created_at) 签名缓存在进程内。

### 2.4 本地词形草图 hash_embed（不是语义向量）

    token   中文按字、英文/数字按词边界（正则，不用 Python hash()）
    gram    1/2/3-gram，权重 0.5 / 0.8 / 1.0
    bucket  blake2b(gram, 16)[0:8] % 256；sign = digest[15]&1 ? +1 : −1
    v[b]   += sign * (1 + ln tf(b))；v /= ‖v‖₂

这是特征哈希：只有字面重叠的文本才相近，同义改写和跨语言都不会。单独检索 test nDCG@10 0.287、
零结果率 0（任何查询都能找到"相似"记忆，这正是它不能冒充语义向量的原因）。现在只用在：判重 dup 的余弦分量、
打包时 MMR 的冗余度、显式 `strategy=vector` 且没有模型时的兜底（`vector_model='local-hash-256'`、
`semantic=false`，degraded 写明"不是语义向量"）。确定性：同文本在任何进程逐位相同（`test_cross_process_stable`）。

### 2.5 子串通道、MMR、PPR、token 估算

- **子串**：候选池文本里字面查找（不区分大小写），ASCII 词 ≥3 字符 + 中文二元组，最多 32 个；
  分数 = Σ命中词长 / Σ全部词长 × (0.2 + 0.8·覆盖率)。1.0.0 用 SQL LIKE 逐词全表扫描、最多 12 个词（中文二元组排前，
  ASCII 词常被截掉），并把 `%`、`_` 直接删掉（`snake_case` 变成 `snakecase`）；现在是字面匹配，没有通配符转义问题。
- **RRF 覆盖率加权**（w·cov/(k+rank)）：1.0.0 默认开，用来压"只共享「数据」二字"的二元组前缀假阳性；
  换成切分 BM25 后它在 dev 上是负作用（0.625 vs 0.577），默认关（`COVERAGE_FUSION`）。
- **MMR**：只在给了 budget 时启用（检索页总是给）。冗余度用向量通道的向量，没有时用窗口内记忆的本地草图；
  每选中一条只算一轮相似度。dev 上带 budget 1200 为 0.618（不带 0.625）。
- **PPR**：实体名以子串形式出现在 query 即为种子，α=0.85，24 轮，BFS 收 2 跳；边权 weight×confidence，
  contradicts ×0.3。评测集没有实体和边，这条通道没有被上面的数字测到。
- **estimate_tokens**：中文 ≈1 token/字，其它 ≈4 字符/token，空白不计。只用于预算打包的量级控制；
  仓库里没有参考 tokenizer，**误差未测量**（1.0.0 写的 ±8% / ±15% / 20–25% 无从复现，已撤下）。

### 2.6 敏感度

`search` / `recall_for_agent` / `digest` 都有 `include_secret=False`：`sensitivity='secret'` 的记忆默认
**不进候选池**，所以智能体召回（MCP memory_recall / memory_search / memory_digest、HTTP /api/recall、工作流）
看不到它们；用户自己的界面检索（HTTP /api/search）传 True。判重（`find_duplicates`）始终能看到 secret。

## 3. 降级、快速失败与熔断

| 能力 | 可用时 | 不可用时 | degraded 里怎么说 |
| --- | --- | --- | --- |
| 向量（hybrid） | embedding 模型 | 不跑向量通道 | `vector: <原因>；本次没有向量通道（本地 hash 词形草图不参与 hybrid 融合）` |
| 向量（strategy=vector） | embedding 模型 | 本地词形草图 | `vector: <原因>；已改用本地 local-hash-256 词形哈希草图（…不是语义向量）` |
| 向量覆盖 | 全部候选有向量 | 部分候选还没有 | `vector: N/M 条候选记忆还没有 <model@dim> 的向量…` |
| 重排 | gw.rerank | 不重排，保持 RRF 顺序与分数 | `rerank: <原因>；未重排，保持 RRF 顺序` |
| 图 | PPR | 无实体/边则为空 | 不写 |
| bm25 | 切分 BM25 | （FTS5 引擎失败时）切分 BM25 兜底 | `bm25: FTS5 查询失败…` |

1.0.0 文档写的"分数透传 + FTS 加权"不对：重排失败就是原样保持 RRF 结果，没有任何额外加权。

`gw` 是 duck-typed 的 ModelGateway，只调 `gw.embed` / `gw.rerank`，任何异常都收敛进 degraded，绝不向上抛。
网关有 `interactive()` 时整次检索在它的快速失败模式里调用（`models.py`）：

- 不重试；单次请求超时 ≤ 4 秒（`INTERACTIVE_TIMEOUT_MS`），整次检索的模型调用 ≤ 8 秒（`INTERACTIVE_BUDGET_MS`），
  预算用完的请求不再发出。后台调用（工作流）照旧：档位超时 + 2 次重试 + 退避。
- 熔断（每个角色）：超时 / 连不上 / 5xx / 429 之后 60 秒内（`BREAKER_COOLDOWN_S`）该角色直接判不可用、不发请求；
  冷却后放行一次，成功即关闭。4xx（鉴权、参数）不熔断；因交互预算截短而超时的不熔断；`test()`（用户测连通性）不受熔断限制。
  熔断期间 `health()` 该角色 ok=false、degraded=true、last_error 写明"熔断中（N 秒后重试）"，`status()["circuits"]` 给完整状态。
- 结果：挂死的端点在第一次检索里最多耗 8 秒（embed 4 秒 + rerank 4 秒），之后 60 秒内的检索不再碰网络
  （`tests/test_retrieval.py::TestGatewayFailFast`）。1.0.0 没有这层：检索里的每个模型调用都按档位超时
  （默认 60 秒）尝试 3 次并退避，也没有熔断。

## 4. 判重

**候选池**：作用域内全部 approved + candidate 记忆，包括 secret（判重必须看到一切）。1.0.0 给 `Store`
时池被 `Store.list_memories` 的 500 条上限截断（更早的完全重复判不出来），给连接时截在 5000。现在不截断；
池超过 200 条时先做字面预筛（`retrieval.lexical_candidates`：规范化后 title+body 完全相同的一条不漏 +
以候选文本前 400 字为查询的切分 BM25 前 max(10·limit, 200) 名），只对预筛结果做下面的三通道打分。

**三通道** dup = 0.5·cos + 0.3·jaccard(5-gram) + 0.2·(1−hamming/64)；
≥0.92 → merge 带；0.80–0.92 → judge 带；<0.80 → new。

**决策链**（`decide_action`，按序短路）：

| 规则 | 条件 | 动作 |
| --- | --- | --- |
| R0 | 归一化文本为空 | ask（内容缺失） |
| R1 | 无邻居 | add |
| R2 | 归一化文本完全相同 | noop |
| R3 | dup ≥ 0.92 | 证据明显更强 → merge；否则 noop |
| R4 | 冲突分 ≥ 0.50 | 新证据强 → supersede；否则 ask |
| R5 | 0.80 ≤ dup < 0.92 | 覆盖/更新词 → supersede；互相蕴含或各有独有内容 → merge；否则 update |
| R6 | 共享实词 ≥3 或主题重叠 ≥0.25 | 覆盖/更新词 → supersede；高重叠/各有独有 → merge；否则 link |
| R7 | 其余 | add |

冲突分**先于任何合并**裁决，避免把矛盾静默合并。极性反转必须**逐子句**比对——
整篇比对会被"读不阻塞写"里的「不」字误判成否定（实测该 bug 让 ask 变成 merge）。
dup 阈值之外还用 `shared_terms / novelty / topic_overlap` 补位：中文改写常让 dup 停在
0.55–0.70（字符 shingle 抖动大），光靠阈值会把同义改写误判成新记忆。

## 5. 切块

`chunk_markdown(text, max_tokens=900, overlap=120)` →
`[{ordinal, heading, level, text, tokens, start_line, end_line, hash}]`

- 按 # 层级分组，heading 路径形如 `# A > ## B > ### C`；
- 围栏代码块 / $$ 公式块 / 表格是**原子块**，超 max_tokens 也整块保留（半截代码是纯噪声）；
- 代码块内的 # 不误判为标题（先扫围栏再扫标题）；重叠按句子取尾部不切断句子；
- `hash=blake2b(text)[:16]` 同文本同 hash，可幂等重切块。

## 6. 性能

`python tools/eval_retrieval.py --latency-at 1000,10000 --strategies hybrid,bm25 --via connection`
（合成语料 = `tests/test_retrieval.py` 的夹具重复到目标规模；gw=None；`search(limit=20)`；1.0.0 一列加 `--code-root`）：

| 规模 | 1.0.0 默认：冷 / 热 p50 / 热 p95 | 1.1.0 默认：冷 / 热 p50 / 热 p95 |
| --- | --- | --- |
| 1 200 条 | 318.6 / 43.0 / 43.7 ms | 18.6 / 8.8 / 9.4 ms |
| 10 200 条 | 2709.5 / 378.5 / 409.0 ms | 136.6 / 75.2 / 86.4 ms |

1.0.0 的大头是向量通道：逐条 SELECT 读 hash 向量 + 纯 Python 余弦，冷启动还要现算并逐条写回。
给 `Store` 时 1.0.0 看起来更快（`--via store`，10 200 条热 p50 48 ms），那是因为它只检索了 500 条（§4 缺陷 A）。
1.1.0 的耗时基本是切分 BM25 与子串通道对候选池的线性扫描，随规模线性增长；有 embedding 模型时另加一次
query embedding 的往返（§1.2 的本机模型约 120 ms）和纯 Python 余弦。

## 7. 已知限制

1. 离线词法检索对改写与跨语言查询仍弱（test：paraphrase 0.346、cross-lingual 0.442），这是 embedding 模型的用武之地。
2. 切分 BM25 与子串通道每次检索线性扫描候选池（1 万条约 75 ms）。再大一个数量级需要持久的切分倒排表，
   那是 schema 变更（memory_fts 用的是 unicode61，不切中文）。
3. 云端向量打分是纯 Python 点积，没有 ANN（catalog 里 hnsw / ivf-pq 为 runnable=0）；未测过 1 万条以上的云端向量规模。
4. memory-eval-v1 只有 240 条记忆、160 条查询、一个标注者；64 条的 dev 上 ±0.01 是噪声。
   绝对数字只作参考，同一数据上的对比才是主要信号。
5. `SEMANTIC_LEXICAL_SCALE=0.02` 只用一个 embedding 模型（本机 qwen3-embedding:0.6b）在 dev 上调过；
   换成弱得多的模型时，关键词通道可能需要更大的权重。
6. 图通道种子靠"实体名是 query 子串"，没有实体链接/别名归并；评测集没有实体，图通道没被测量。
7. `estimate_tokens` 的误差没有测量过。
