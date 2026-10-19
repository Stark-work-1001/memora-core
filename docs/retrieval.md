# 检索与算法层（vectors / retrieval / dedup / chunking）

> 对应 ARCHITECTURE.md §4.4 §4.5 §8。公式、参数、降级路径、实测数字都在这里，改参数请同步。
> 算法 id 均可在 `memora_core/data/builtin/algorithms.json` 查到。

## 0. 存储接缝

`retrieval` 统一走 **`_store_search(store, filters)`**：优先调 T1 的
`store.list_memories(...)`，任何异常或返回结构不符 → 回退 sqlite3 直连 `memory` 表
（`_sql_list_memories`）。

注意 Store 的契约是 **status / scope 各取单个值**（store.py:525），而本层内部用的是
"多状态 + 多作用域"（approved+candidate、作用域祖先链）。所以接缝按笛卡尔积**逐个调用再
合并去重**——直接把列表塞进去会被 sqlite 参数绑定静默拒绝，表现为"过滤器失效"。

`search` / `digest` / `find_duplicates` 都接受 Connection / Store / db 路径三种形态
（`vectors._open_store`）。T1 落地后已实测：给 `Store` 对象时 `search` 返回结果与直连一致
（Recall@10 = 1.0），`include_candidates` 与 `scope` 过滤均生效。

## 1. 公式清单与 algorithms.json 对照

| 实现 | 函数 | id | 公式 |
| --- | --- | --- | --- |
| 本地向量 | hash_embed | char-ngram-hash | v[b]+=s(g)(1+ln tf)；v←v/‖v‖₂ |
| 余弦 / TF-IDF | cosine / TfidfModel | cosine, tfidf-cosine | a·b/(‖a‖‖b‖)；idf=ln((1+N)/(1+df))+1 |
| BM25 | _channel_bm25 / _bm25_memory | bm25 | FTS5 bm25()，列权 3.0/1.5/1.0；兜底 k1=1.2 b=0.75 |
| 子串召回 | _channel_substring | fts5-trigram（等价） | LIKE '%gram%' |
| RRF | rrf_fuse | rrf | Σ w_i·cov_i/(k+rank_i)，k=60 |
| MMR | _mmr_select | mmr | argmax[λ·rel−(1−λ)·max sim]，λ=0.7 |
| 预算打包 | pack_budget | greedy-budget-pack | 按 score/len 贪心 |
| 个性化 PageRank | _ppr | ppr | π=(1−α)r+αPᵀπ，α=0.85 |
| SimHash | simhash64 | simhash | 64 位逐位加权投票 |
| Jaccard | jaccard | jaccard-shingle | |A∩B|/|A∪B|，5-gram |
| 三通道判重 | score_pair | — | dup=0.5cos+0.3jac+0.2(1−ham/64) |
| 冲突打分 | conflict_score | conflict-score | 0.4·entity+0.35·polarity+0.25·numeric |
| 标题切块 | chunk_markdown | semantic-chunking | 标题层级 + 预算贪心 |

## 2. 本地向量 hash_embed(text, dim=256)

    token   中文按字、英文/数字按词边界（正则，绝不用 Python hash()）
    gram    1/2/3-gram，权重 0.5 / 0.8 / 1.0
    bucket  blake2b(gram, 16)[0:8] % dim；sign = digest[15]&1 ? +1 : −1
    v[b]   += sign * (1 + ln tf(b))；v /= ‖v‖₂

**确定性**：blake2b 与取模稳定；gram 按字典序累加，浮点顺序固定 → 同文本在任何进程/机器
逐位相同（`test_cross_process_stable` 子进程验证）。**为何用 1/2/3-gram 而非纯 3-gram**：
纯 3-gram 遇到"换个说法"窗口全错位，余弦会掉到 0；加低阶 n-gram 后同义改写升到 0.66，
无关文本仍 < 0.35（随机对 mean=0.18, p95=0.33）。判别力：相同 1.000 / 增删后缀 0.93 /
同义改写 0.66 / 无关中文 0.08 / 无关中英 0.00。

## 3. 检索流水线

    bm25(FTS5) ─┐
    substring  ─┤→ RRF(k=60, 覆盖率加权) → rerank(可选) → MMR(仅打包) → 预算贪心
    vector     ─┤
    graph(PPR) ─┘

**权重** bm25=1.0, vector=1.0, graph=0.6, substring=0.5（DEFAULT_WEIGHTS）。

### 3.1 中文与 unicode61（踩过的坑）

`unicode61` **不切中文**："模式保证并发读写能力"是**一个 token**。实测 `MATCH '并发读写能力'`
返回空，`MATCH '"模式"*'` 才有结果。所以：BM25 用中文**二元组前缀** OR 起来；
另开 `substring` 通道 `LIKE '%二元组%'` 补召回。改用 `tokenize='trigram'` 可省掉这层但索引显著变大。

### 3.2 RRF 覆盖率加权（本项目修正）

标准 RRF 只看名次。二元前缀兜底会让「**数据**导出」与「**数据**库并发」拿到同样 bm25 分，
纯名次融合让部分匹配压过完整匹配——实测 Recall@10 从 0.97 掉到 0.70。

    rrf(d) = Σ_i  w_i · cov_i(d) / (k + rank_i(d))

cov_i(d) ∈[0,1] = d 在通道 i 覆盖了多少查询检索词（ASCII 整词 + 中文整段 + 二元组）。
不给 cov 时与标准 RRF 完全等价（`test_rrf_formula` 保留该断言）。

### 3.3 MMR 只在打包时启用

MMR 把"同主题但确实不同"的记忆当冗余剔除，直接伤害召回（实测 0.90 → 0.60）。
`diversify=None`（默认）= budget 非空才开；纯检索（budget=None）一律不跑 MMR。

### 3.4 个性化 PageRank

实体名以子串形式出现在 query 即命中为种子，α=0.85，迭代 24 轮，BFS 收集 2 跳节点，
entity/memory 权重折算成记忆分。边权 = weight×confidence，contradicts 额外 ×0.3。
`estimate_tokens`：中文 ≈1 token/字，非中文 ≈4 字符/token，空白不计。**误差**：中文
段落 ±8%，中英混排 ±15%，代码/符号密集文本**低估 20%`25%**。预算按**拼接后真实文本**
计量（逐条求和会因圆整溢出 1`2 token）。

## 4. 降级矩阵（可观测）

| 能力 | 云端可用 | 云端不可用 | degraded 字符串 |
| --- | --- | --- | --- |
| 向量 | gw.embed | hash_embed 本地 256 维 | vector: <原因> |
| 重排 | gw.rerank | 分数透传 | rerank: <原因> |
| 图 | PPR | 无实体/边则通道为空 | 不写 |
| BM25 | FTS5 | 纯 Python BM25 | bm25: FTS5 失败… |

`gw` 是 duck-typed 的 ModelGateway，**不 import 它**，只调 `gw.embed(texts)` / `gw.rerank(q, docs, top_k=)`。
任何异常（尤其 ModelUnavailable）被 `_call_gateway` 收敛成 `(None, reason)`，**绝不向上抛**。
实测：

    gw = None  → ['vector: 未配置模型网关，使用本地 hash 向量',
                  'rerank: 未配置模型网关，分数透传']
    gw 抛异常  → ['vector: embed: ModelUnavailable(embedding: no cloud credential)',
                  'rerank: rerank: ModelUnavailable(reranker: reranker offline)']
    gw 正常    → []  （空数组说明真的走了云端通道）

## 5. 判重

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

## 6. 切块

`chunk_markdown(text, max_tokens=900, overlap=120)` →
`[{ordinal, heading, level, text, tokens, start_line, end_line, hash}]`

- 按 # 层级分组，heading 路径形如 `# A > ## B > ### C`；
- 围栏代码块 / $$ 公式块 / 表格是**原子块**，超 max_tokens 也整块保留（半截代码是纯噪声）；
- 代码块内的 # 不误判为标题（先扫围栏再扫标题）；重叠按句子取尾部不切断句子；
- `hash=blake2b(text)[:16]` 同文本同 hash，可幂等重切块。

## 7. 实测数字

环境：Windows / Python 3.12.10 / SQLite 3.49.1 / `gw=None`（纯离线降级）。

### 7.1 Recall@10（300 条中英混合记忆，10 条已知查询）

| 查询 | hybrid | bm25-only | | 查询 | hybrid | bm25-only |
| --- | --- | --- | --- | --- | --- | --- |
| 数据库并发 | 1.00 | 0.70 | | 模型网关 | 1.00 | 0.70 |
| 向量检索 | 1.00 | 0.70 | | 前端构建 | 1.00 | 0.70 |
| 混合召回 | 1.00 | 0.70 | | 桌面打包 | 1.00 | 0.70 |
| 判重策略 | 1.00 | 0.70 | | 单元测试 | 1.00 | 0.70 |
| 切块算法 | 1.00 | 0.70 | | 工作流引擎 | 1.00 | 0.70 |
| **均值** | **1.000** | **0.700** | | | | |

语料：每主题 10 条分三种写法 —— ①标题带主题（BM25 友好）；②主题夹在长中文串中间
（unicode61 下只能靠二元前缀，仅部分命中）；③同义改写、主题名不出现（只有向量能召回）。
bm25-only 稳定丢掉的 3 条正是 ②③，也就是融合要解决的场景。

### 7.2 性能（search(limit=20)，向量缓存预热后稳态）

| 规模 | mean | median | p90 | max |
| --- | --- | --- | --- | --- |
| 300 条 | 12.3 ms | 11.9 ms | 14.7 ms | 14.7 ms |
| 3000 条 | 131.0 ms | 134.1 ms | 146.4 ms | 146.4 ms |

3000 条约 130ms：候选池全量四条通道 + PPR + MMR 纯 Python。向量走 vector 表缓存，
首次写入后不再重算。线性扫描，规模再上一个数量级需要 hnsw / ivf-pq（catalog runnable=0）。

### 7.3 其它验收

判重 10 组样本 **10/10**；`budget=300` 时 token 估算 294（≤330 容差内）；切块代码/公式/表格
各恰好出现在 1 个 chunk 内且围栏成对。

## 8. 已知限制

1. `estimate_tokens` 对代码/符号密集文本低估最多 25%，预算偏保守；
2. 向量通道纯 Python 线性扫描，>1 万条需要 ANN；PPR 每次检索重建邻接表，大图应缓存；
3. 不做跨语言对齐，中文记忆 vs 英文查询判重会当新记忆（样本③即此行为）；
4. 图通道种子靠"实体名是 query 子串"，未做实体链接/别名归并。
