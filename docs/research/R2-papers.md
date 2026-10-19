# R2 · 智能体长期记忆：算法与论文级调研

> 项目：记忆中枢 memora-core（Windows 桌面应用，Python 3.12 + SQLite/FTS5 + TS/three.js + Electron）
> 调研范围：学术界与工业界关于 LLM Agent 长期记忆的可实现算法
> 取证方式：arXiv API 核对编号 → 抓取 abs/HTML 全文（21 篇，约 1.8MB 原文）→ PDF 复核关键数值 → 正则抽取公式与实验数字
> 在报告中之约定：**〔论文〕= 有原文可取证的结论**；**〔本项目设定〕= 无文献支撑、由本调研给出的工程取值，必须在实现中可配置并可被评测推翻**；**〔未核实〕= 未能取得一手来源，禁止当作结论使用**

---

## 1. 摘要：12 条可执行结论

| # | 结论 | 可直接落地的动作 | 依据 |
| --- | --- | --- | --- |
| 1 | 记忆系统的瓶颈不是"存"，而是"读写接口 + 失效"。MemGPT 的本质是把上下文当作被操作系统换页的内存，模型自己发起换入/换出 | 先把 `main / recall / archival` 三段式存储与 `append / search / 编辑` 四个原语做出来，再谈打分 | 〔论文〕2310.08560 |
| 2 | Generative Agents 的三因子线性打分是**唯一被广泛复现**的可用基线：`score = α_r·recency + α_i·importance + α_rel·relevance`，三项各自 min-max 到 [0,1] | 直接实现为默认 ranker，α 全部取 1 作为 v0 基线 | 〔论文〕2304.03442 |
| 3 | **衰减常数必须自己定，不能抄。** 论文正文写 decay=0.99/游戏小时，官方实现用 0.995，两者半衰期差 2 倍（68.97h vs 138.29h） | 把 `decay_per_hour` 做成配置，按下面 §3.1 的半衰期表选型 | 〔论文〕+〔本项目设定〕 |
| 4 | 打分三因子中，**只有 relevance 值得上模型**；recency 与 importance 用确定性算式即可，省掉每次检索的 LLM 调用 | ranker 只在写入侧调 LLM，检索侧纯数值 | 〔论文〕+〔本项目设定〕 |
| 5 | 去重必须两阶段：便宜的向量召回（top-k）→ 昂贵的 LLM/规则判定。单靠阈值会误杀"同一实体不同阶段的事实" | 召回段用 ANN，判定段用 §3.4 判定矩阵 | 〔论文〕Mem0 的四操作 +〔本项目设定〕阈值 |
| 6 | 写入动作不能只有 ADD/DELETE。Mem0 的四操作缺"合并同类项"和"用户裁决"，本项目需扩到 **7 动作**（ADD/UPDATE/SUPERSEDE/MERGE/LINK/NOOP/ASK_USER） | 见 §3.5 动作进入条件表 | 〔论文〕2504.19413 +〔本项目设定〕扩展 |
| 7 | **时间必须是双轨的。** 事件时间（valid_at/invalid_at）与记录时间（recorded_at）分离，Zep 的 bi-temporal 模型是工业级验证过的做法 | 表设计直接含 4 个时间列，见 §3.6 | 〔论文〕2501.13956 |
| 8 | 失效用**边**而不是删除：`invalid_at` 置位 + 保留原始行。审计与"当时为什么这么答"全靠这个 | 永远不物理删除记忆，只置 `invalid_at` | 〔论文〕2501.13956 |
| 9 | 混合检索的融合优先用 RRF（对分数量纲不敏感）而不是加权求和；加权求和只在能校准分数时用 | 双通道召回 → RRF(k=60) → 重排 | 通行做法〔本项目设定 k 值〕 |
| 10 | 长上下文不是免费的：Lost in the Middle 证明存在 U 型位置曲线，**最强证据放头尾**是打包策略的硬约束 | 打包器显式做 head/tail 布局，见 §3.8 | 〔论文〕2307.03172 |
| 11 | 复习调度用 SM-2 就够且公式完全确定；FSRS 需要拟合 19 个权重且本次未取得一手公式，**不纳入 v1** | §3.7 给 SM-2 可直接编码版 | 〔论文/官方文档〕super-memory.com |
| 12 | 无云凭据时**必须降级且标注**：BM25 + 字符 n-gram 哈希向量 + 规则判重可跑通全链路，但语义召回与冲突判定能力有硬上限（§3.9 明列） | 降级态在 UI 与 API 响应里带 `degraded: true` + 原因码 | 〔本项目设定〕+ 已知上限诚实披露 |

**一句话结论**：memora-core 的正确形态是"**SQLite 事务真源 + 确定性打分器 + 可选云模型增强**"，而不是"把 LLM 塞进检索热路径"。上述 12 条里，只有第 4 条和第 12 条是本次调研相对常见方案的取舍主张，其余均为论文可直接支撑的工程事实。

---

## 2. 逐篇精读（21 篇，含 2 篇方法补充与 3 个工业/标准来源的交叉引用）

每篇统一给出：**问题 → 核心机制 → 关键公式 → 实验与局限 → 对 memora-core 可用性（高/中/低 + 理由）**。

### 2.1 MemGPT: Towards LLMs as Operating Systems
- **编号**：arXiv:2310.08560 ｜ https://arxiv.org/abs/2310.08560
- **问题**：LLM 的固定上下文窗口无法承载长期对话与文档分析；简单地加大窗口既贵又受 Lost-in-the-Middle 影响。
- **核心机制**：把 LLM 当作操作系统，上下文窗口 = 物理内存，外部存储 = 磁盘。三层：**main context**（prompt 内，分 system instructions / working context / FIFO message queue）、**external context**（recall storage = 完整对话史，archival storage = 任意长文本向量库）。模型通过**函数调用**自主发起 `archival_memory_search`、`archival_memory_insert`、`conversation_search` 等操作，并在需要时**自我编辑** working context。队列满时触发 warning，模型必须自己决定压缩或换出。**function chaining** 允许一次推理连续多次调用直到产出用户可见回复。
- **关键公式**：无连续打分公式；核心是**控制流**而非数学。可形式化为一次"换页决策"：
```text
每轮 step：
  if tokens(main_context) > warn_threshold:       # 论文中的 "memory pressure warning"
      注入系统警告 → 模型必须选择：
         (a) archival_memory_insert(摘要化后的旧消息)
         (b) 丢弃 FIFO 头部
         (c) 直接回复（若判断无需更多上下文）
  while 模型返回 function_call:
      执行 → 结果 append 回 main_context → 再次推理
  main_context_usage 单调约束：tokens ≤ context_window − reserve
```
- **实验与局限**：在 Deep Memory Retrieval（DMR）与多文档问答上超过固定上下文基线；局限是**依赖模型自身会正确调用工具**，弱模型会忘记检索或反复无效检索；每次换页都要一次额外 LLM 往返，延迟与成本随对话长度线性增长。
- **对 memora-core 可用性：高**。它不是"算法"而是**接口范式**——三段式存储 + 四个原语（append/search/update/delete）正好映射到 MCP 工具集的形状。它的"模型自我管理"部分对我们**风险大于收益**（多智能体客户端模型能力参差），我们应采用"存储分层照抄、换页决策由确定性策略代劳"的改法。

### 2.2 Generative Agents: Interactive Simulacra of Human Behavior
- **编号**：arXiv:2304.03442 ｜ https://arxiv.org/abs/2304.03442
- **问题**： believable 的智能体行为需要"记住并综合"大量过往观察，而不是只保留最近若干条。
- **核心机制**：**memory stream** 是一条不断追加的自然语言记录流。检索时对全部记忆按三因子打分：**recency**（自上次被检索以来经过的游戏小时数上的指数衰减）、**importance**（LLM 给 1–10 分）、**relevance**（记忆描述向量与查询向量的余弦相似度）。三者分别 **min-max 归一化到 [0,1]** 后加权求和。**Reflection**：当最近感知事件的 importance 之和超过阈值时触发，用最近 100 条记录生成高层次问题并综合出反思，反思本身作为新记忆写回（形成反思树）。
- **关键公式**（原文）：`score = α_recency · recency + α_importance · importance + α_relevance · relevance`，其中 **"In our implementation, all α's are set to 1"**。
  recency 原文表述："we treat recency as an exponential decay function over the number of sandbox game hours since the memory was last retrieved. **Our decay factor is 0.99**."
  ```text
  recency(m) = decay ^ (hours_since_last_retrieved(m))
  论文正文：decay = 0.99 / 游戏小时
  官方实现（社区广泛引用）：decay = 0.995 / 小时  → 见 §3.1 的核对说明
  ```
- **实验与局限**：消融显示完整架构 vs 无记忆/无规划/无反思的效应量 d=8.16（约 8 个标准差），Kruskal-Wallis H(4)=150.29, p<0.001。局限：**依赖"游戏小时"这一人造时间轴**（真实应用须映射到墙钟时间）；importance 由 LLM 打分，成本随记忆量线性涨；反思阈值论文只给"超过某阈值"而未给具体数值，且反思会产生**记忆 embellishment（细节被润色/添加）**，论文自己承认 agent 会"remember, but with embellishments"。
- **对 memora-core 可用性：高**。三因子公式是**最值得直接实现的基线**（§3.1–3.3 全部围绕它展开）。但必须改造两点：时间轴换成真实时间戳；importance 打分移出检索热路径。

### 2.3 Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory
- **编号**：arXiv:2504.19413 ｜ https://arxiv.org/abs/2504.19413
- **问题**：全量上下文塞进 prompt 成本高、延迟高；已有记忆方案缺少**写入时的冲突消解**。
- **核心机制**：**两阶段流水线**。(1) **Extraction**：从对话中抽取候选事实；(2) **Update**：对每条候选，先向量检索 top-s 条相似已有记忆，再把"候选 + 相似记忆"一起交给 LLM，由模型通过 function call 选择四种操作之一：**ADD**（无等价记忆，新建）、**UPDATE**（补充信息）、**DELETE**（被矛盾信息推翻）、**NOOP**（无需变更）。**图记忆变体（Mem0^g）**：把记忆表示为有向图，实体为节点、关系为边，写入时由 LLM 抽取实体与关系，更新时对涉及实体做**相似边删除 + 新边加入**。
- **关键公式**：无闭式打分；核心是**决策函数**（本项目据此扩展为 7 动作，见 §3.5）：
```text
update_op = LLM( candidate_fact, top_s_similar_memories )  ∈ {ADD, UPDATE, DELETE, NOOP}
```
- **实验与局限**：在 LOCOMO 上，相对 OpenAI 记忆方案 LLM-as-a-Judge 指标**相对提升 26%**；图记忆版本比基础版**再高约 2%**；p95 延迟**降低 91%**，token 成本**节省超过 90%**。局限：每次写入都要 1 次检索 + 1 次 LLM 判定，**写入放大**明显；四操作粒度不足——无法表达"两条旧记忆应合并为一条"或"这条冲突需要人来裁决"；图变体收益（2%）远小于其复杂度代价。
- **对 memora-core 可用性：高**（流水线形状）/ **中**（图变体）。抽取→召回→判定的三段式必须照抄；但"四操作"要扩，且图变体在 v1 不建议上（2% 收益 vs. 双写一致性成本）。

### 2.4 A-MEM: Agentic Memory for LLM Agents
- **编号**：arXiv:2502.12110 ｜ https://arxiv.org/abs/2502.12110
- **问题**：已有记忆系统（含图数据库方案）操作与结构**固定**，无法随任务演化；记忆之间缺乏语义链接。
- **核心机制**：Zettelkasten 式"卡片盒"。**Note Construction**：每条新记忆生成结构化笔记，含上下文描述、关键词、标签、以及由 LLM 生成的属性。**Link Generation**：用新笔记的语义向量在历史笔记中检索近邻，再由 LLM 判断是否建立链接并写入链接理由。**Memory Evolution**：新笔记写入时，**反向更新其近邻笔记的上下文描述**——即旧记忆会被新记忆改写（这是它区别于所有"只追加"方案的地方）。
- **关键公式**：无闭式打分，机制为三元组：
```text
note_i = LLM_struct( content, context, keywords, tags )
links(note_i) = { note_j : sim_embed(note_i, note_j) ∈ topK  AND  LLM_confirm(note_i, note_j) }
evolution: context(note_j) ← LLM_rewrite( context(note_j), note_i )   for j ∈ links(note_i)
```
- **实验与局限**：在长对话记忆任务上优于 RAG 与固定结构记忆基线；消融显示链接与演化都有贡献。局限：**演化是破坏性的**——旧记忆被静默改写，若改写错误则**原始证据不可恢复**（对"记忆中枢必须可审计"的项目是致命缺陷）；且每次写入触发 O(K) 次 LLM 改写调用，写入成本高。
- **对 memora-core 可用性：中**。**链接机制（LINK 动作）值得抄**，是我们的第 5 个写入动作；但**"演化改写原记忆"必须改成"追加 derived_from 派生记录"**——保留原行不动，用 `derived_from` 外键表达"这条是那条的改写版"。这样既拿到演化收益，又不破坏审计链。

### 2.5 MemoryOS: Memory OS of AI Agent
- **编号**：arXiv:2506.06326 ｜ https://arxiv.org/abs/2506.06326
- **问题**：对话长期化后，记忆检索缺乏**分层**与**热度淘汰**，导致要么爆上下文要么丢关键信息。
- **核心机制**：三层存储 + 热度驱动迁移。**STM**（短期，按对话页）、**MTM**（中期，按"段 segment"，由对话链分段）、**LPM**（长期人格记忆）。**STM→MTM 用 FIFO**（对话链驱动）；**MTM→LPM 用热度淘汰**：热度低的段被删除，热度高的段晋升。检索时按段做语义检索，再按层聚合。
- **关键公式**（原文式 (4)）：
```text
Heat = α · N_visit + β · L_interaction + γ · R_recency
R_recency = exp( -Δt / μ )        # Δt 单位：秒；论文取 μ = 1e7
其中 N_visit = 该段被检索的次数
     L_interaction = 该段内的对话页数
     α, β, γ 为权重（论文未给具体数值 → 〔未核实〕）
```
- **实验与局限**：在 LoCoMo 上相对基线平均 F1 提升 **49.11%**、BLEU-1 提升 **46.18%**。局限：α/β/γ 未给数值，可复现性不足；"段"的切分依赖对话链，**对非对话型记忆（代码片段、文档块）不适用**；μ=1e7 秒 ≈ 115.7 天，是非常"慢"的衰减，与 Generative Agents 的 0.99/h 相差约 28 倍量级（见 §3.1 对照表）。
- **对 memora-core 可用性：中高**。**Heat 公式直接可用**，是本项目"重要度"的一个确定性替代（不需要 LLM）。分层思想可用，但我们的分层应按**访问频率**而非对话链切段。

### 2.6 Zep: A Temporal Knowledge Graph Architecture for Agent Memory (Graphiti)
- **编号**：arXiv:2501.13956 ｜ https://arxiv.org/abs/2501.13956
- **问题**：对话中的事实会随时间**变化与失效**，但主流 RAG 把"过去为真"与"现在为真"混为一谈。
- **核心机制**：**Graphiti** 引擎构建**时序知识图谱**。图由 episode / entity / community 子图构成，边是事实（fact）。关键设计是**双时间轴（bi-temporal）**：时间轴 **T** = 事件真实发生的时间（chronological ordering of events），时间轴 **T′** = 系统摄入该数据的事务时间（transactional order of ingestion）。每条边带两个时间戳：**valid_at**（该关系开始为真的时间）与 **invalid_at**（该关系停止为真的时间）。新信息到达时，**不删除旧边**，而是给旧边置 `invalid_at`，并新增一条边指向新的有效区间。抽取时由 LLM 从对话中解析显式与相对时间（"next Thursday"、"in two weeks"、"last summer"）。
- **关键公式**：无打分式；核心是**数据模型**：
```text
edge = ( src_entity, relation, dst_entity,
         valid_at,      # 事实开始为真的世界时间
         invalid_at,    # 事实停止为真的世界时间（NULL=仍有效）
         recorded_at,   # 系统写入时刻（T′ 轴，永不修改）
         source_episode )
冲突处理：新事实 f_new 与旧边 e_old 矛盾时
   e_old.invalid_at ← f_new.valid_at      # 不物理删除
   插入 f_new
```
- **实验与局限**：在 DMR（MemGPT 团队提出的基准）与 LongMemEval 上均优于基线，且显著降低响应延迟（论文强调不需要在每次查询时重新总结整段历史）。局限：**依赖 LLM 正确抽取时间表达式**，相对时间解析错误会污染 valid_at；图结构带来写入复杂度；社区子图的维护成本高。
- **对 memora-core 可用性：高**。**双时间 + invalid_at 是本项目数据模型的基石**，必须进 SQLite schema（§3.6）。这是全篇调研中对"记忆中枢"最有结构性价值的一篇。

### 2.7 HippoRAG: Neurobiologically Inspired Long-Term Memory for LLMs
- **编号**：arXiv:2405.14831 ｜ https://arxiv.org/abs/2405.14831
- **问题**：标准 RAG 每次只做**单跳**向量检索，无法把散落在多个段落里、需要两跳以上推理的证据串起来。
- **核心机制**：模拟海马体索引理论。离线建 **open KG**：用 LLM 从段落中抽实体与关系，实体节点之间加**同义词边**，并把**段落本身作为节点**连到其包含的实体。在线检索时，从查询中抽出关键概念作为种子，在图上跑 **Personalized PageRank（PPR）**，把概率质量沿图扩散，从而**一次检索完成多跳**，再按段落节点上的 PPR 分值排序返回。
- **关键公式**：
```text
p_{k+1} = (1-d) · e_seed + d · M^T · p_k
  d = 阻尼系数（惯例 0.85）
  e_seed = 种子分布：查询概念节点均分（或按 IDF 加权）
  M = 列归一化的邻接矩阵
收敛后：score(passage_i) = p_∞[ passage_node_i ]
```
**Node specificity**（原文）：类比 IDF，用节点的逆度数来惩罚"万能枢纽实体"，改善检索。
```text
w_node(u) = 1 / deg(u)        # 或 log(N / deg(u))
```
- **实验与局限**：在多跳 QA（MuSiQue、2WikiMultiHopQA）上比现有 RAG 方法高约 **3 与 20 个点**；在线检索过程比同类方法**快 10–30 倍**。**HippoRAG 2**（arXiv:2502.14802, "From RAG to Memory"）扩展到非参数持续学习，同时覆盖事实回忆、语义与关联记忆。局限：建图依赖 LLM 抽取，成本与噪声都高；PPR 需要维护整张图的邻接结构，**SQLite 上做全图 PPR 代价大**；同义词边容易把不相关实体连起来。
- **对 memora-core 可用性：中**。PPR 的多跳能力很诱人，但**在 SQLite 里做迭代 PPR 不现实**（每次查询都要全图遍历）。务实做法：**把 PPR 降级为"局部 k 跳扩展"**（从种子出发 BFS 2–3 跳，用 `1/deg` 加权），在 3D 证据图里把 PPR 分值当作**可视化**的热度，而不是检索主路径。

### 2.8 GraphRAG: From Local to Global (A Graph RAG Approach to Query-Focused Summarization)
- **编号**：arXiv:2404.16130 ｜ https://arxiv.org/abs/2404.16130
- **问题**：传统 RAG 只能回答"局部"问题（答案在少数块里）；面对"这批文档的主要主题是什么"这类**全局问题**，top-k 检索根本召回不到答案。
- **核心机制**：用 LLM 从源文档抽实体与关系建图 → 用 **Leiden** 算法做**层次化社区检测** → 对每个社区生成**社区摘要**（LLM）→ 查询时按社区层级做 **map-reduce**：各社区摘要分别生成部分答案，再归并成全局答案。论文对比了四个层级 **C0/C1/C2/C3** 的社区摘要、纯文本 map-reduce（TS）与朴素语义检索（SS）。
- **关键公式**：
```text
层级：C0（根，社区数最少，最抽象） … C3（叶，最具体）
answer = reduce( { map(summary_c, query) : c ∈ communities_at_level_k } )
社区检测：Leiden 在模块度 Q 上做层次划分
  Q = (1/2m) Σ_ij [ A_ij − k_i k_j / 2m ] δ(c_i, c_j)
```
- **实验与局限**：在查询聚焦摘要任务上，C0–C3 层级社区摘要的综合表现优于 TS 与 SS（尤其**全面性**维度）。局限：**索引成本极高**（要对全部社区做 LLM 摘要，且层级越深调用越多）；索引是**批处理**的，增量更新困难；社区边界随新数据漂移会**让历史摘要失效**。
- **对 memora-core 可用性：低–中**。全量社区摘要的索引成本对桌面应用不可接受。但**"层级摘要"的思想有价值**：我们的 RAPTOR 式摘要树（见 2.11）就是轻量替代。建议：**只在用户显式触发"生成全局概览"时**才增量构建社区摘要，不进主写入路径。
  - **LazyGraphRAG**：微软研究院提出的降本变体，把"索引期摘要"推迟到"查询期"，用更少的 LLM 调用达到可比质量。**来源为厂商博客而非同行评审论文**（https://www.microsoft.com/en-us/research/blog/lazygraphrag-setting-a-new-standard-for-quality-and-cost/ ），实验数字未逐项核实 → 〔未核实〕。对我们的启示与上一条相同：**摘要按需生成**。

### 2.9 LightRAG: Simple and Fast Retrieval-Augmented Generation
- **编号**：arXiv:2410.05779 ｜ https://arxiv.org/abs/2410.05779
- **问题**：GraphRAG 类方案索引慢、更新贵，无法应对数据频繁变化的场景。
- **核心机制**：图索引 + **双层检索（dual-level retrieval）**。索引期把实体与关系都做成键值对。查询期同时用两类关键词检索：**低层（low-level）关键词** = 具体实体名，用于精确命中；**高层（high-level）关键词** = 主题/关系概念，用于广覆盖。两路结果合并后交给 LLM。关键卖点是**增量更新算法**：新数据到达时只更新受影响的图节点与边，不重建全图。
- **关键公式**：
```text
keywords = LLM_split(query) → (K_low = 具体实体, K_high = 主题概念)
C = V(K_low) ∪ E(K_low) ∪ V(K_high) ∪ E(K_high)     # V=顶点, E=边
answer = LLM( dedup(C), query )
增量：insert(doc) → ΔV, ΔE → 只对 Δ 做索引，不重建
```
- **实验与局限**：在多个数据集上相比 GraphRAG 显著降低索引与查询开销，同时保持或超过其质量。局限：双层关键词的质量完全取决于 LLM 的切分质量；对**单跳事实型查询**相比朴素向量检索优势不明显（结构开销白付）。
- **对 memora-core 可用性：中高**。**增量更新**这一点对我们的"增量索引维护"需求直接命中。双层检索可简化落地为：**实体层（FTS5 精确）+ 主题层（向量语义）** 双通道，正好对应 §3.3 的混合召回。

### 2.10 MemoRAG: Boosting Long Context Processing with Global Memory-Enhanced Retrieval Augmentation
- **编号**：arXiv:2409.05591 ｜ https://arxiv.org/abs/2409.05591
- **问题**：超长上下文（整本书、整份代码库）既塞不进窗口，也不该被切成无结构的碎片；且很多查询是**模糊的、线索不全的**，直接检索会失败。
- **核心机制**：**双系统**。一个"记忆模型"先把长文本**预压缩成全局记忆（global memory）**——本质是用一个 LLM 生成覆盖全文的压缩线索；另一个"回答模型"在拿到全局记忆后，**用它来生成更好的检索线索**（clues），再去原文里定位片段，最后作答。这解决了"问题太模糊、检索词对不上"的冷启动问题。
- **关键公式**：
```text
M = MemoryModel(long_doc)                    # 全局记忆/压缩线索
clues = AnswerModel(query, M)                # 用全局记忆消歧、补全查询
evidence = Retrieve(clues, long_doc)
answer = AnswerModel(query, evidence)
```
- **实验与局限**：在长上下文 QA 与 summarization 上以更少 token 达到可比或更优效果。局限：**多一次 LLM 调用做线索生成**，延迟增加；全局记忆是有损压缩，细节型问题（精确数字、代码符号）容易丢。
- **对 memora-core 可用性：中**。"用摘要消歧查询"这个技巧对**跨智能体模糊查询**有用（用户常问"上次那个方案怎么定的"）。但它是**在线 LLM 调用**，与我们的"检索热路径不上模型"原则冲突 → 应做成**可选开关**，且仅在第一次检索置信度低时触发一次。

### 2.11 RAPTOR: Recursive Abstractive Processing for Tree-Organized Retrieval
- **编号**：arXiv:2401.18059 ｜ https://arxiv.org/abs/2401.18059
- **问题**：扁平 chunk 检索只能命中"字面相似"的片段，无法回答需要**跨片段归纳**的问题。
- **核心机制**：递归构建**摘要树**。把文本切块并嵌入 → **软聚类**（论文用 GMM + UMAP 降维；软聚类允许一个节点属于多个簇）→ 对每个簇用 LLM 生成摘要 → 摘要再嵌入、再聚类、再摘要，直到无法再聚。查询时两种策略：**tree traversal**（逐层剪枝下沉）与 **collapsed tree**（把所有层级的节点摊平一起检索）。
- **关键公式**：
```text
level_0 = chunks
while |level_k| > 1:
    X = UMAP(embed(level_k))                  # 降维
    clusters = GMM(X, n_components)           # 软聚类，节点可属多簇
    level_{k+1} = [ LLM_summarize(c) for c in clusters ]
retrieval: collapsed tree → 对 ∪_k level_k 统一做 top-k
```
- **实验与局限**：与 GPT-4 配合时，在 **QuALITY** 基准上把最好成绩提升 **20 个绝对点**。局限：**建树成本高**（每一层都要 LLM 摘要）；树是批处理产物，**新文档加入后旧树会失配**；软聚类的簇数需要调参。
- **对 memora-core 可用性：中**。**层级摘要是"词义脑图/层级脑图"的数据基础**，值得做。但不要用 GMM——桌面端用**增量可维护的层次聚类**（如按 embedding 做 single-linkage 阈值合并），且摘要树**异步后台构建**，不阻塞写入。

### 2.12 LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory
- **编号**：arXiv:2410.10813 ｜ https://arxiv.org/abs/2410.10813
- **问题**：已有记忆评测要么只用短对话，要么不区分能力维度，无法定位"到底哪一环坏了"。
- **核心机制**：**500 道人工构造的问题**，嵌在**可自由扩展的 user-assistant 对话史**里。定义**五类核心长期记忆能力**：① **information extraction**（从长历史中抽出某条信息）；② **multi-session reasoning**（跨多次会话综合）；③ **temporal reasoning**（时间推理）；④ **knowledge updates**（用户信息变更后能答新值）；⑤ **abstention**（历史里没有答案时应当**说不知道**，而不是编）。
- **关键公式/指标**：以 **Recall@k** 衡量检索阶段、以 QA accuracy 衡量端到端。论文的关键发现是：**把用户事实抽出来当作索引键（multi-key indexing）能提升 recall@k 约 4%、下游准确率约 5%**；简单记忆设计在**时间推理**上表现很差，需要**时间感知的查询扩展**。
- **实验与局限**：主流商用助手在该基准上准确率大幅下降（论文标题即强调长交互记忆的不足）。局限：**英文、单人、对话形态**，与"多智能体、多协议、代码/文档混合"的真实场景有分布差异；abstention 的判定依赖 LLM judge。
- **对 memora-core 可用性：高**。**五类能力直接作为我们的自测维度**（§4）；尤其 **abstention（不该编）** 是这个项目"绝不伪造成功"原则的评测抓手。

### 2.13 LoCoMo: Evaluating Very Long-Term Conversational Memory of LLM Agents
- **编号**：arXiv:2402.17753 ｜ https://arxiv.org/abs/2402.17753
- **问题**：真实超长期对话数据不存在（没人愿意提供跨度数月的私聊），无法评测长期记忆。
- **核心机制**：**生成式流水线**合成超长对话：先给两个虚拟 agent 设定 persona，用**时间事件图（temporal event graph）** 驱动它们在数月内发生的事件，再让它们互相"reflect & respond"，并穿插**图片分享与回应**。最终产出跨多个 session、数百轮、含多模态的长对话。
- **关键公式/指标**：问答任务分 **single-hop / multi-hop / temporal / open-domain / adversarial** 等类别，用 **F1** 与 **BLEU-1**（另含 LLM judge）评估。
- **实验与局限**：长对话下所有基线（含 RAG、长上下文）性能显著下降。局限：**合成数据**，persona 驱动的事件有模板痕迹；adversarial 类问题与真实用户提问分布不同。
- **对 memora-core 可用性：中高**。**LoCoMo 的"时间事件图 + 多 session"结构可以直接借来造我们自己的测试集**（§4.2），但要注意它是合成分布，不能直接当验收标准。

### 2.14 Lost in the Middle: How Language Models Use Long Contexts
- **编号**：arXiv:2307.03172 ｜ https://arxiv.org/abs/2307.03172
- **问题**：加大上下文窗口是否等价于"记住更多"？
- **核心机制**：控制实验——把**唯一相关的那个段落**放在长上下文的**不同位置**，测模型能否用上它。结论是 **U 型曲线**：信息在**开头或结尾**时表现最好，在**中间**时性能显著下降。
- **关键公式**：
```text
相对位置 pos ∈ [0,1]（0=最前，1=最后）
经验形状：perf(pos) ≈ U 型，两端高、中点低
工程近似（本项目用于打包器打分）：
  position_bonus(pos) = β · ( (2·pos − 1)^2 )      # 越靠两端越大
  打包时把证据按 score 从高到低分配：最强 → 首，次强 → 尾，其余 → 中
```
- **实验与局限**：在多种模型与任务上复现 U 型；即便模型宣称支持长上下文，中间信息仍被浪费。局限：**位置效应随模型与任务变化**，U 型的"深度"不一；论文未给出统一的修正公式。
- **对 memora-core 可用性：高（作为约束而非算法）**。它直接决定我们的**上下文打包策略**（§3.8）：不能简单 top-k 顺序塞入，必须做**头尾强化布局**。这也是"记忆中枢"相对"直接把历史丢给模型"的核心竞争力之一。

### 2.15 Self-RAG: Learning to Retrieve, Generate, and Critique through Self-Reflection
- **编号**：arXiv:2310.11511 ｜ https://arxiv.org/abs/2310.11511
- **问题**：**固定次数检索**是浪费——有的问题不需要检索，有的检索结果不相关却仍被使用，有的生成缺少支撑。
- **核心机制**：训练模型输出**反思标记（reflection tokens）**：是否需要检索、每个段落是否相关、生成是否被支撑、整体是否有用。推理时按这些标记**自适应决定检索时机**并**自我批判**输出。
- **关键公式**：
```text
生成序列中插入特殊 token：
  [Retrieve] ∈ {yes, no, continue}
  [IsRel]   每个 passage ∈ {relevant, irrelevant}
  [IsSup]   每个 claim  ∈ {fully supported, partially, no support}
  [IsUse]   整体       ∈ {1..5}
决策：仅当 [Retrieve]=yes 才检索；仅保留 [IsRel]=relevant 的段落
```
- **实验与局限**：在多个开放域 QA/事实验证任务上优于 ChatGPT 与检索增强基线。局限：**需要专门训练/finetune 模型**，不是纯 prompt 能复现；标记预测错误会级联放大。
- **对 memora-core 可用性：低（原样）/ 中（思想）**。我们不可能为客户端智能体训练模型。但"**先判断要不要检索、再判断检索到的相不相关**"这个**门控思想**可以搬到服务端：用**轻量规则 + 可选 judge** 实现一个 `should_retrieve` 与 `relevance_gate`，避免无谓召回。

### 2.16 Corrective RAG (CRAG): Corrective Retrieval Augmented Generation
- **编号**：arXiv:2401.15884 ｜ https://arxiv.org/abs/2401.15884
- **问题**：检索器返回的东西**可能是错的**，但 RAG 流水线照单全收，导致错误被放大。
- **核心机制**：加一个**轻量检索评估器**给每个检索文档打**置信度**，然后用**上下两个阈值**把文档分成三态：**Correct**（高于上阈值 → 精炼后直接使用）、**Incorrect**（低于下阈值 → 丢弃，转去**网络搜索/其它来源**补充）、**Ambiguous**（介于两者之间 → 两路都用）。
- **关键公式**：
```text
for each doc d:
    c = Evaluator(query, d)
    if c > τ_high:      Correct   → 使用（可做 decompose-then-recompose 精炼）
    elif c < τ_low:     Incorrect → 丢弃，触发外部补检
    else:               Ambiguous → 保留但降权，并与外部补检合并
```
论文未在正文给出 τ_high/τ_low 的具体取值 → **具体阈值〔未核实〕，本项目自行设定**。
- **实验与局限**：显著提升 RAG 对错误检索的鲁棒性。局限：**多一次评估器调用**；评估器本身会错；τ 需要按领域校准。
- **对 memora-core 可用性：高**。这个**双阈值三态**结构是**去重判定与冲突审计的通用骨架**（§3.4 直接借用），也是"降级时如何诚实标注"的机制基础——低置信度就该走 Ambiguous 而不是假装 Correct。

### 2.17 Knowledge Conflicts for LLMs: A Survey
- **编号**：arXiv:2403.08319 ｜ https://arxiv.org/abs/2403.08319
- **问题**：模型参数里的知识、上下文里的知识、以及不同来源之间的知识会**互相冲突**，系统需要知道冲突的**类型**才能选对策略。
- **核心机制**：把知识冲突系统化分类。关键区分包括 **context-memory conflict（CM）**（上下文 vs 模型参数）、**intra-context conflict**（上下文内部互相矛盾）、以及跨来源的冲突；并按**前置（pre-hoc）** 与**后置（post-hoc）** 两类给出解决思路。
- **关键公式/分类**（对本项目最有用的部分）：
```text
冲突维度：
  A. 来源：context-memory(CM) | intra-context | inter-source
  B. 表现：直接矛盾 | 时间演化（旧值→新值） | 部分重叠 | 粒度不一致
  C. 处理时机：pre-hoc（写入时消解） | post-hoc（生成时消解）
memora-core 的映射：
  多智能体之间的分歧  → inter-source conflict  → 必须在写入时处理（§3.4 判定矩阵）
  同一智能体的旧值    → 时间演化 → 用 invalid_at 表达，不是冲突（§3.6）
  用户 vs 智能体推断  → CM conflict → 用户显式陈述优先
```
- **实验与局限**：综述性质，梳理成因、行为与解法；本身不提供新算法。局限：偏重"生成时如何选"，对"存储层如何表达冲突"着墨较少——这正是我们要补的。
- **对 memora-core 可用性：高（作为分类框架）**。它给了我们**判定矩阵的行标签**：必须能区分"矛盾/演化/重叠/粒度差异"，而不是笼统地叫"冲突"。

### 2.18 BGE-M3 / M3-Embedding: Multi-Linguality, Multi-Functionality, Multi-Granularity
- **编号**：arXiv:2402.03216 ｜ https://arxiv.org/abs/2402.03216
- **问题**：检索需要**稠密语义**与**精确词面**两种能力，单一向量模型两头不讨好；多语言场景还要跨语言。
- **核心机制**：一个模型同时输出三种检索信号：**dense**（[CLS] 归一化隐状态的内积）、**lexical/sparse**（学习到的词权重，类似稀疏向量）、**multi-vector**（ColBERT 式多向量细粒度匹配）。三者可**加权混合**。
- **关键公式**（原文）：
```text
dense:  e_q = norm(H_q[0]),  e_p = norm(H_p[0]),  s_dense = <e_p, e_q>
lexical: w_{q_t} = ReLU(W_lex^T · H_q[i])          # 每个 term 的权重，重复取 max
         s_lex = Σ_{t ∈ q∩p} ( w_{q_t} · w_{p_t} )
multi-vector: s_mul = Σ_i max_j <E_q[i], E_p[j]>
最终（三者加权混合，权重为可训练/可配置）：
         s_final = w_1·s_dense + w_2·s_lex + w_3·s_mul
```
（注：原文对 `s_final` 的权重符号表述分散在公式区内，本报告只保留其**结构**，不擅自填数；具体权重以官方实现为准 → 〔未核实数值〕）
- **实验与局限**：多语言检索、跨语言检索、长文档检索均达 SOTA。局限：**模型体积与推理开销**是桌面端的主要门槛（具体参数量本次未从原文学术段落核实，故不列举数值 → 〔未核实〕）；CPU 推理延迟与是否需量化，必须由实现侧实测后再决策。
- **对 memora-core 可用性：中**。**结论是"稠密+稀疏混合确实优于单一信号"**，这支撑我们的 RRF 双通道设计。但**不建议在 v1 内置该模型**（体积与延迟），而是走**云端 embedding + 本地 FTS5 稀疏**的组合；离线降级时用字符 n-gram 哈希向量（§3.9）。

### 2.19 MemoryBank: Enhancing LLMs with Long-Term Memory
- **编号**：arXiv:2305.10250 ｜ https://arxiv.org/abs/2305.10250
- **问题**：对话助手需要**像人一样遗忘与强化**，而不是无限堆积或简单滑窗。
- **核心机制**：受 **Ebbinghaus 遗忘曲线** 启发，为每条记忆维护一个**记忆强度 S**，记忆保留率随时间指数衰减；当记忆被**回忆（recall）** 时强度增加（间隔重复效应）。强度低于阈值的记忆被"遗忘"（衰减到不再被检索）。
- **关键公式**（原文）：
```text
R = exp( -t / S )
  R = 记忆保留率（0–1）
  t = 自学习以来的时间
  S = 记忆强度，首次提及时初始化为 1，每次回忆后增加
```
- **实验与局限**：在对话生成与个性化上优于无记忆基线。局限：**S 的增长规则论文只给了方向**（"基于学习深度与重复次数"），未给闭式更新式 → 〔未核实具体更新公式〕；遗忘是**真的删除**，对需要审计的场景不友好。
- **对 memora-core 可用性：中**。它的价值在于给出**另一个衰减参数化** `R=exp(-t/S)`，与 Generative Agents 的 `decay^t` 数学同构（见 §3.1 的统一写法）。**但"遗忘=删除"必须改成"衰减=降权"**——memora-core 不删除证据，只降低其被召回的概率。

### 2.20 补充：Recursively Summarizing Enables Long-Term Dialogue Memory（工业/方法补充）
- **编号**：arXiv:2308.15022 ｜ https://arxiv.org/abs/2308.15022
- **问题**：对话无限增长，如何在不丢关键信息的前提下压缩？
- **核心机制**：**递归摘要**——把最近的对话与"已有摘要"一起喂给 LLM，生成新摘要，递归滚动。这是 RAPTOR 的"流式版本"。
- **关键公式**：
```text
S_{t+1} = LLM_summarize( S_t , recent_dialogue_chunk )
```
- **实验与局限**：在长期对话的记忆检索任务上有效。局限：**递归摘要会累积失真**（每轮都丢一点细节，多轮后漂移），且无法回溯到原始证据。
- **对 memora-core 可用性：中**。作为**记忆"沉淀"工作流**的参考：摘要可以生成，但**原始记忆必须保留**并用 `derived_from` 关联，否则无法审计。

### 2.21 补充：Memora — A Harmonic Memory Representation Balancing Abstraction and Specificity
- **编号**：arXiv:2602.03315 ｜ https://arxiv.org/abs/2602.03315 （**注**：编号日期为 2026-02，属预印本，会议录用状态〔未核实〕）
- **问题**：记忆表示要么**太抽象**（摘要丢失细节，无法回答具体问题），要么**太具体**（原始片段太多，检索噪声大）。需要一种能同时在两个粒度上检索的表示。
- **核心机制**：**分层记忆 + 线索锚点**。先做**分段（Segmentation）**，建立**情节记忆（Episodic Memory）**；再生成**主抽象（Primary Abstraction）** ——对每段的高层概括；同时保留**线索锚点（Cue Anchors）** ——指向具体细节的索引。检索分两阶段：**先选抽象层（abstraction selection）**，再**按线索锚点回落到具体细节（cue-anchor retrieval）**。检索策略本身由一个**policy** 决定，并用 group-relative 的方法做策略更新。
- **关键公式**（结构，非闭式打分）：
```text
Stage 1: a* = argmax_a  Policy(q, abstraction_a)        # 选哪个抽象层
Stage 2: evidence = Retrieve_by_cue_anchors(q, anchors(a*))
成本：Stage1 在少量抽象上做，Stage2 只在该抽象覆盖的锚点内检索
      → 比 flat ANN 全库检索便宜
```
论文附录 D 论证了 **flat top-k 相似检索与固定单挂载的 KG 检索都是 Memora 的特例**，即它严格更一般（原文 D.3 的 expressivity 论证）。
- **实验与局限**：消融显示抽象层与线索锚点都必要。局限：**引入了一个需要训练/调优的 policy**，实现复杂度高；预印本，复现证据有限。
- **对 memora-core 可用性：中**。**"先选抽象、再落细节"的两段式检索**非常适合我们的"词义脑图 → 具体证据"交互（用户在脑图上点一个概念节点，再下钻到原始记忆）。但 **policy 部分不抄**，用确定性规则替代（抽象层按聚类中心得分排序，锚点按 BM25 得分排序）。

---

## 3. 算法汇总章（可直接写进代码）

> 本章每个小节固定三段：**变量定义 → 可运行伪代码 → 取值建议与出处**。
> 标注规则：`〔论文〕` 有原文可查；`〔本项目设定〕` 为本调研给出的工程默认值，**必须在配置里可改、可被 §4 的评测推翻**；`〔未核实〕` 未取得一手来源，禁止当结论。

### 3.1 Recency 衰减：统一形式、半衰期换算与选型

**变量定义**

| 符号 | 含义 | 单位 |
| --- | --- | --- |
| `t_now` | 当前时刻（UTC epoch 秒） | s |
| `t_ref(m)` | 记忆 m 的**参照时间**，取 `max(last_access_at, created_at)` | s |
| `Δt_h` | 距参照时间的小时数 = `(t_now - t_ref(m)) / 3600` | h |
| `d` | 每小时衰减因子，`0 < d ≤ 1` | 无量纲 |
| `λ` | 衰减率，`λ = -ln(d)` | h⁻¹ |
| `H` | 半衰期，`H = ln2 / λ = -ln2 / ln(d)` | h |

**三篇论文的衰减formula其实是同一个式子**（这是本调研的一个重要统一，实现时只需一套代码）：

```text
统一形式：  r(Δt) = exp( -λ · Δt )

等价换算：
  Generative Agents： r = d^Δt_h          →  λ = -ln(d)
  MemoryBank      ： R = exp(-t/S)        →  λ = 1/S
  MemoryOS        ： R = exp(-Δt/μ)       →  λ = 1/μ

半衰期：      H = ln2 / λ
逆换算：      d = exp(-ln2 / H)
```

**半衰期换算表（本报告实算，可复核）**

| 来源 | 原始参数 | λ (h⁻¹) | 半衰期 H |
| --- | --- | --- | --- |
| Generative Agents 正文 | `d = 0.99 / 小时` 〔论文〕 | 0.0100503 | **68.97 h ≈ 2.87 天** |
| Generative Agents 官方实现 | `d = 0.995 / 小时` 〔社区实现，见下方核对说明〕 | 0.0050125 | **138.29 h ≈ 5.76 天** |
| MemoryOS | `μ = 1e7 秒` 〔论文〕 | 0.00036 | **6,931,472 s ≈ 80.2 天** |
| MemoryBank | `S` 初值 1〔论文〕，增长规则未给 | 1/S | 随 S 增长而拉长 → 〔更新公式未核实〕 |

> **核对说明（重要，请勿在实现里"抄一个数"了事）**
> 任务书与大量二手资料称 Generative Agents 使用 **0.995**。本次调研**直接下载论文 PDF 并抽取原文**，得到的是 **"Our decay factor is 0.99."**。0.995 来自官方开源实现的默认参数。两者都真实存在，但**不是同一个来源**，半衰期相差正好 2 倍。本报告据此断言：**这个常数在文献里就不统一**，因此 memora-core 必须把它做成配置项，而不是硬编码。
> 结论：**不要把 0.995 当作"论文结论"引用**；它是实现选择。

**伪代码**

```python
import math

LAMBDA = {
    "ephemeral":  math.log(2) / 12.0,      # 半衰期 12h
    "working":    math.log(2) / 72.0,      # 半衰期 3d
    "fact":       math.log(2) / 720.0,     # 半衰期 30d
    "preference": math.log(2) / 8760.0,    # 半衰期 365d
    "identity":   0.0,                     # 不衰减
}   # 〔本项目设定〕

def recency(mem, now_ts: float, kind: str = "fact") -> float:
    """返回 (0,1] 的 recency 分值。确定性、无模型调用。"""
    lam = LAMBDA[kind]
    if lam == 0.0:
        return 1.0
    t_ref = max(mem.last_access_at or 0.0, mem.created_at)
    dt_h = max(0.0, (now_ts - t_ref) / 3600.0)
    return math.exp(-lam * dt_h)
```

**取值建议与理由**

| 记忆类型 | 建议半衰期 | 等价的 d/h | 理由 |
| --- | --- | --- | --- |
| `ephemeral` 会话临时上下文 | 12 h | 0.9439 | 撑不过一次会话，不应污染长期召回 |
| `working` 任务/工作记忆 | 72 h | 0.9904 | 恰好落在 Generative Agents 的 0.99 附近，可在 3 天内被自然淘汰 |
| `fact` 一般事实 | 720 h | 0.99904 | 〔本项目设定〕事实不该按天衰减 |
| `preference` 用户偏好 | 8760 h | 0.99992 | 偏好变化慢，但确实会变 |
| `identity` 身份/核心事实 | ∞ | 1.0 | 衰减=0，永不因时间掉出 |

**两个必须处理的失败模式**

1. **富者愈富（rich-get-richer）**：Generative Agents 的 recency 从"上次被检索"起算，被召回过的记忆 recency 被重置 → 热门记忆永久霸榜，冷门记忆永无出头之日。
   **缓解**：① `t_ref` 同时参考 `created_at`（取 max 但给 last_access 设上限，如只允许把 recency 提回 0.9）；② 给 recency 设**地板值** `r = max(r, r_floor)`，`r_floor = 0.05`〔本项目设定〕，保证过期记忆仍有极小概率被翻出。
2. **时间轴错配**：论文用"游戏小时"，真实应用是墙钟时间，且**用户可能长时间不打开应用**——再次打开时全部记忆同时衰减到接近 0。
   **缓解**：改为**按会话轮次 + 墙钟的混合时钟**，或对首次启动做"衰减重放"并在 UI 提示"距上次使用已 N 天，已按 X 规则衰减"。

---

### 3.2 Importance：LLM 打分的归一化与确定性替身

**变量定义**

| 符号 | 含义 | 取值域 |
| --- | --- | --- |
| `raw` | LLM 给出的重要度原始分 | 整数 1–10（Generative Agents 惯例〔论文〕） |
| `imp` | 归一化后的重要度 | [0,1] |
| `imp_static` | 写入时确定，**终身不变** | [0,1] |
| `heat` | 动态访问热度（MemoryOS），**随时间变** | ≥0 |

**公式 A：LLM 打分归一化**〔论文用 1–10 分；归一化方式为本项目设定〕

```text
imp = (raw - 1) / 9        # 严格线性映射到 [0,1]
边界：raw=1 → 0.0（最琐碎）; raw=10 → 1.0（最核心）
```

**公式 B：无 LLM 的确定性替身**〔本项目设定〕——降级模式与热路径使用

```text
imp_heur = clamp( 0, 1,
             w_len  · len_score            # 长度分：信息量代理
           + w_ent  · entity_score         # 实体密度：具体性代理
           + w_int  · intent_score         # 用户显式意图
           + w_pin  · explicit_pin )       # 用户手动置顶/收藏

len_score    = min(1, log1p(char_len) / log1p(600))          # 600 字符封顶
entity_score = min(1, n_entities / max(1, n_tokens / 12))    # 每 12 token 一个实体记为 1.0
intent_score = max over matched patterns of its weight:
     "记住"/"remember"/"always"/"never" → 1.0
     "我喜欢"/"I prefer"              → 0.9
     "下次"/"next time"               → 0.7
     问句（以 ? 或 吗/呢 结尾）        → 0.1   # 提问通常不是可沉淀事实
     其余                              → 0.3
explicit_pin = 1.0 if user pinned else 0.0

建议权重（本项目设定，和为 1）：w_len=0.15, w_ent=0.25, w_int=0.45, w_pin=0.15
```

**公式 C：动态热度**〔论文 MemoryOS 式 (4)〕

```text
Heat = α · N_visit + β · L_interaction + γ · R_recency
  N_visit       = 该记忆被召回次数
  L_interaction = 交互规模（MemoryOS 用"段内对话页数"；本项目用该记忆关联的会话轮数）
  R_recency     = exp(-Δt/μ)，μ = 1e7 秒〔论文取值〕
  α, β, γ       = 权重〔论文未给数值 → 未核实〕
本项目设定：α=1.0, β=0.5, γ=100.0（把 R∈[0,1] 放大到与计数同量级），并做 log1p 压缩：
  heat_score = log1p(Heat) / log1p(Heat_max_observed)   # 归一到 [0,1]
```

**伪代码**

```python
import math, re

INTENT_RULES = [                      # 〔本项目设定〕，可配置
    (re.compile(r"(记住|remember|always|never|务必|一定要)", re.I), 1.0),
    (re.compile(r"(我喜欢|我偏好|I prefer|I like)", re.I), 0.9),
    (re.compile(r"(下次|今后|next time|from now on)", re.I), 0.7),
    (re.compile(r"[?？]\s*$|(吗|呢)\s*$"), 0.1),
]
W = dict(w_len=0.15, w_ent=0.25, w_int=0.45, w_pin=0.15)

def importance_heuristic(text: str, n_entities: int, n_tokens: int, pinned: bool) -> float:
    len_score = min(1.0, math.log1p(len(text)) / math.log1p(600))
    ent_score = min(1.0, n_entities / max(1.0, n_tokens / 12.0))
    intent = 0.3
    for pat, w in INTENT_RULES:
        if pat.search(text):
            intent = max(intent, w)
    pin = 1.0 if pinned else 0.0
    v = (W["w_len"] * len_score + W["w_ent"] * ent_score
         + W["w_int"] * intent + W["w_pin"] * pin)
    return max(0.0, min(1.0, v))

def importance_from_llm(raw: int) -> float:
    return max(0.0, min(1.0, (raw - 1) / 9.0))
```

**取值建议**
- 有云凭据：写入时**一次性**调 LLM 打 1–10 分，存 `imp_static`，**检索时不重算**（这是与"检索热路径不上模型"原则的落地）。
- 无凭据：用 `imp_heur`，并在 API 响应里带 `degraded: ["importance"]`。
- **重要度不参与衰减**：衰减的是 recency，不是 importance。二者相乘会双重惩罚。

---

### 3.3 Relevance：cosine / BM25 / RRF 融合的完整公式与权重

**变量定义**

| 符号 | 含义 |
| --- | --- |
| `e_q, e_m` | 查询与记忆的 embedding，**L2 归一化后** |
| `s_cos` | 余弦相似度 ∈ [-1,1]，归一化向量下等于内积 |
| `s_bm25` | BM25 稀疏得分，∈ [0, +∞) |
| `r_dense(i), r_sparse(i)` | 记忆 i 在稠密/稀疏通道中的**名次**（从 1 开始） |
| `k` | RRF 平滑常数 |
| `s_final` | 融合后的最终相关性 |

**公式 A：Cosine**

```text
s_cos(q, m) = <e_q, e_m> / (||e_q|| · ||e_m||)      # 若已归一化则直接取内积
```

**公式 B：BM25（SQLite FTS5 内置 bm25()，参数可调）**

```text
s_bm25(q, d) = Σ_{t ∈ q} IDF(t) · ( f(t,d) · (k1+1) ) / ( f(t,d) + k1 · (1 - b + b · |d|/avgdl) )

IDF(t) = ln( 1 + (N - n(t) + 0.5) / (n(t) + 0.5) )
  f(t,d) = 词 t 在文档 d 中的频次；|d| = 文档长度；avgdl = 平均文档长度
  N = 文档总数；n(t) = 含 t 的文档数
惯例取值：k1 = 1.2, b = 0.75〔通行默认，本次未取得原论文 → 未核实原文〕
FTS5 中 bm25() 返回的是负值（越小越相关），需取负转正：
  s_bm25 = -1 * bm25(memories_fts)
```

**公式 C：RRF（Reciprocal Rank Fusion）—— 推荐默认**

```text
s_rrf(m) = Σ_{i ∈ 通道}  1 / ( k + r_i(m) )

  r_i(m) = 记忆 m 在通道 i 中的名次（1-based），未出现在该通道则不计该项
  k      = 60

性质：只看名次不看分值 → 天然免疫"cosine 与 BM25 量纲不同"的问题
```
> **出处说明**：RRF 由 Cormack 等提出，`k=60` 是其广为人知的推荐值，也是 Elasticsearch / OpenSearch 的默认实现值。**本次调研未取得该原始论文**，因此：公式结构作为通行做法采用；`k=60` 标注为**通行默认值〔未核实原文〕**，在 memora-core 中做成配置项 `rrf_k`。

**公式 D：加权求和融合（仅在能校准分数时使用）**

```text
s_final = w_d · ẑ(s_cos) + w_s · ẑ(s_bm25) + w_i · imp + w_r · recency

ẑ(·) = min-max 归一化到 [0,1]，**必须在候选集内做**（这与 Generative Agents 的做法一致〔论文〕）
建议权重（本项目设定）：
  纯语义检索：   w_d=0.55, w_s=0.20, w_i=0.10, w_r=0.15
  精确/代码检索：w_d=0.30, w_s=0.50, w_i=0.05, w_r=0.15
  时序型查询：   w_d=0.40, w_s=0.15, w_i=0.05, w_r=0.40
```

**⚠ 一个必须写进代码的坑**：Generative Agents 的 `score = α_r·recency + α_i·importance + α_rel·relevance`，三个分量**各自 min-max 到 [0,1]**。min-max 是**候选集内相对归一化**——意味着当候选只有 1 条时，该条三项全是 1.0；当有 100 条时，最低的那条三项全是 0。这会让**阈值在不同查询规模下含义漂移**。缓解：对 recency 与 importance 用**绝对归一化**（它们本身就有固定值域），只对 relevance 做 min-max。

**伪代码**

```python
def rrf_fuse(rankings: dict[str, list[str]], k: int = 60) -> dict[str, float]:
    """rankings: {通道名: [记忆id 按相关性降序]}"""
    scores: dict[str, float] = {}
    for _chan, ids in rankings.items():
        for rank, mid in enumerate(ids, start=1):
            scores[mid] = scores.get(mid, 0.0) + 1.0 / (k + rank)
    return scores

def weighted_fuse(cands, w, cosines, bm25s, imps, recencys):
    """cands 为本轮候选（决定 min-max 的范围）；只有 relevance 做 min-max。"""
    def z(vals):
        lo, hi = min(vals), max(vals)
        return [0.0] * len(vals) if hi - lo < 1e-9 else [(v - lo) / (hi - lo) for v in vals]
    zc, zs = z(cosines), z(bm25s)
    return [w[0] * zc[i] + w[1] * zs[i] + w[2] * imps[i] + w[3] * recencys[i]
            for i in range(len(cands))]
```

**选型建议（本项目结论）**
1. **默认走 RRF**：两通道（FTS5 稀疏 + 向量稠密）各取 top-50 → RRF(k=60) → 取 top-20 → 可选 rerank。理由：不需要校准两路分数量纲，工程上最稳。
2. **只在需要混合 recency/importance 时**才用加权求和（公式 D），且只对 relevance 做 min-max。
3. **不要两套都用再相加**——RRF 的输出与归一化分数不可比，混用会产生无意义的排序。

---

### 3.4 去重判定：两阶段流水线 + 判定矩阵 + 阈值区间

**为什么必须两阶段**：全量两两比较是 O(n²)；单靠一个全局阈值会同时犯两类错——**误合并**（把同一实体的不同阶段事实压成一条，丢失演化）与**漏合并**（把换个说法的同一事实存成两条，污染召回）。因此：**便宜的高召回召回器** + **昂贵的低误判判定器**。

**阶段 1：候选召回（cheap, high recall）**

```text
输入：新记忆 m_new
候选集 C = 并集：
    (a) 向量近邻：ANN(e_new, k=20)
    (b) 稀疏近邻：BM25(query=m_new.text, k=20)
    (c) 结构近邻：同 subject + 同 predicate 的已有记忆（若有 SPO 结构）  ← 这条最容易被忽略但最关键
    (d) 时间近邻：同 source_agent 在 ±1h 内写入的记忆
去重后按 s_rrf 排序，取 top-K（建议 K=8，本项目设定）
```
> 关键点：**(c) 结构近邻不能省**。纯向量召回会漏掉"同一主语、不同措辞"的情况；而"项目 A 的截止日期是 3 月"/"项目 A 的截止日期改到 5 月"在向量空间可能只有 0.7 相似度，却必须被一起判定。

**阶段 2：判定（expensive, low false-positive）**

```text
对 C 中每条 c 计算 s_cos(m_new, c)，按最高相似度 c* 落入下列区间：

┌─────────────────┬──────────────────────────────────────────┐
│ 区间             │ 动作                                      │
├─────────────────┼──────────────────────────────────────────┤
│ s ≥ 0.92        │ 自动合并（MERGE），无需 LLM；但若检测到    │
│                 │ 数值/日期/否定词冲突 → 强制转 0.80–0.92    │
│ 0.80 ≤ s < 0.92 │ 进 judge（LLM 或规则）做四分类             │
│ s < 0.80        │ 视为新记忆（ADD）；但仍需过 NaN/极短文本   │
│                 │ 的重复检测（见下方"退化情形"）              │
└─────────────────┴──────────────────────────────────────────┘
```

> **阈值来源说明（务必注意）**
> `0.92 / 0.80` 这组区间**不是任何论文的结论**，它是社区在 cosine 相似度（归一化 embedding）上的通行经验带。本报告**明确标注为〔本项目设定〕**。它**强依赖 embedding 模型**——换模型后必须重新校准。
> 校准方法（建议实现为一次性脚本）：取 300 对人工标注的"同义/补充/矛盾/无关"样本，对每个阈值算 P/R 曲线，取 F1 最大点。**没有做这一步就不该上线这个阈值。**

**判定矩阵（conflict vs duplicate vs complement vs supersede）**

行 = 语义关系，列 = 系统动作。矩阵本身综合了 Mem0 的四操作〔论文〕与知识冲突分类〔论文 2403.08319〕，**动作映射是本项目扩展**。

| 关系 | 判据（以 c* 为参照） | 语义 | 动作 | 数据层效果 |
| --- | --- | --- | --- | --- |
| **重复 DUPLICATE** | 高相似 **且** 无新槽位（无新实体/数值/时间） | 同一事实换个说法 | **MERGE** | 保留旧行，`+support_count`，追加 source 引用 |
| **补充 COMPLEMENT** | 中高相似 **且** 有**新增槽位**（多一个属性/条件） | 同一主题的有用增量 | **UPDATE**（或 MERGE 后 append） | 旧行 `payload` 合并新槽位；记录 `derived_from` |
| **推翻 SUPERSEDE** | 同 (subject, predicate)**但宾语不同**，且新记录时间更新 | 事实变了 | **SUPERSEDE** | 旧行 `invalid_at = 新行.valid_from`；新行插入 |
| **冲突 CONFLICT** | 同槽位、不同值，**且无法判定谁更新/更可靠** | 两个来源打架 | **LINK + 标记 conflict** 或 **ASK_USER** | 两行都保留，建 `contradicts` 边，`status='disputed'` |
| **无关 UNRELATED** | 低相似 | 两回事 | **ADD** / **NOOP** | 常规插入 |
| **演化 EVOLUTION** | 新记录时间明显更晚，且是渐进细化 | 时间演化，非冲突 | **SUPERSEDE**（软） | 旧行 `invalid_at` 置位，保留可查 |

**判定矩阵的核心消歧规则（按优先级短路）**

```text
规则 0（最高优先）：来源可信度
    user_explicit（用户亲口说的） > user_pinned > agent_inferred > agent_guessed
    若两者可信度不同 → 高可信度者 SUPERSEDE 低可信度者，且旧行标记 superseded_by

规则 1：时间
    若 valid_from(新) > valid_from(旧) 且同槽位 → SUPERSEDE（时间演化）
    若 valid_from 相同且值冲突 → CONFLICT（真冲突）

规则 2：否定
    检测否定词翻转（"是"/"不是"，"can"/"cannot"）
    同文本仅否定翻转 → CONFLICT，绝不自动 MERGE（这是最危险的一类误合并）

规则 3：数值/日期
    抽取所有数字与日期；若同槽位数值不同 → 至少 CONFLICT，不得静默 MERGE

规则 4：粒度
    一方是另一方的前缀/上位概念（"北京" vs "北京市朝阳区"）→ COMPLEMENT，不合并
```

**退化情形（必须显式处理，否则自动合并会误伤）**
- **极短文本**（"好"、"OK"、"收到"）：cosine 极高但毫无信息 → 直接 NOOP，不参与判重。
- **纯数值/纯 ID**：向量退化（几乎正交或全同）→ 走**精确字符串比对**而非向量。
- **空 embedding（降级模式）**：见 §3.9，只能用规则判重。

**伪代码**

```python
TAU_AUTO_MERGE = 0.92      # 〔本项目设定〕必须按 embedding 模型重新校准
TAU_JUDGE_LOW  = 0.80      # 〔本项目设定〕

def decide_write(m_new, existing, embed_sim, judge) -> tuple[str, dict]:
    """返回 (action, payload)。action ∈ {ADD, UPDATE, SUPERSEDE, MERGE, LINK, NOOP, ASK_USER}"""
    if is_trivial(m_new):                       # 极短/无信息
        return "NOOP", {}
    if not m_new.embedding:                     # 降级模式
        return decide_write_rules_only(m_new, existing)

    cands = recall_candidates(m_new, existing, k=8)          # 阶段 1
    if not cands:
        return "ADD", {}

    scored = sorted(((embed_sim(m_new, c), c) for c in cands), key=lambda t: -t[0])
    s, c = scored[0]

    # —— 硬冲突检测优先于相似度（防止 0.95 相似但数值相反的两条被自动合并）
    hard = detect_hard_conflict(m_new, c)      # 否定翻转 / 数值冲突 / 日期冲突
    if hard:
        return ("ASK_USER" if c.trust >= TRUST_USER else "LINK",
                {"conflict_with": c.id, "kind": hard})

    if s >= TAU_AUTO_MERGE:
        if has_new_slot(m_new, c):
            return "UPDATE", {"target": c.id, "merged": merge_slots(c, m_new)}
        return "MERGE", {"target": c.id}

    if s >= TAU_JUDGE_LOW:
        rel = judge(m_new, c)                  # 四分类：duplicate/complement/supersede/conflict
        return ACTION_BY_REL[rel], {"target": c.id, "evidence": s}

    return "ADD", {}
```

**已知失败模式**
1. **对称性错误**：误合并是**不可逆**的（信息被压掉），漏合并是**可修复**的（后续还能再合）。因此阈值应**偏保守**（宁可漏合）。这就是 `0.92` 高于常见 `0.85` 的原因〔本项目设定〕。
2. **阈值随语言漂移**：中文短句在多数 embedding 上相似度普遍偏高，直接用英文语料校准的阈值会**过度合并**。必须用**中文样本**单独校准。
3. **judge 的确认偏误**：把"候选 + 相似度 0.83"一起给 LLM，模型倾向于顺着"它们相似"往下说。对策：**不要把相似度分数告诉 judge**，只给它两段文本。

---

### 3.5 合并策略：七种写入动作的进入条件

**动作定义表**（在 Mem0 四操作〔论文〕基础上扩展到七个；扩展理由见每行"为何需要"）

| # | 动作 | 进入条件（全部满足） | 数据层效果 | 为何需要（相对 Mem0） |
| --- | --- | --- | --- | --- |
| 1 | **ADD** | 无候选 且 非退化；或最高相似 < 0.80 | 插入新行，`valid_from=now` | 同论文 |
| 2 | **UPDATE** | 0.80 ≤ s，判定为 complement，有新增槽位 | 旧行 payload 合并新槽位，追加 source；写 `derived_from` | 论文的 UPDATE 只做"补充信息"，未定义"槽位"；本项目需显式槽位模型 |
| 3 | **SUPERSEDE** | 同 (subj, pred) 且宾语不同 且 `valid_from(新) > valid_from(旧)` | 旧行 `invalid_at = 新.valid_from`；新行插入 | 论文用 DELETE 表达推翻，**会丢历史**；本项目改为失效不删除（Zep 双时间〔论文〕） |
| 4 | **MERGE** | s ≥ 0.92 且无新槽位（纯重复） | 旧行 `support_count += 1`，追加 source 与 `last_confirmed_at` | 论文四操作**没有**"合并同类项"，会产生大量重复行 |
| 5 | **LINK** | 语义相关（0.60 ≤ s < 0.80）但**不可合并**（如粒度不同、互补视角） | 两行都保留，建 `related_to` 边（带 weight 与理由） | 借鉴 A-MEM 的 Link Generation〔论文 2502.12110〕 |
| 6 | **NOOP** | 退化输入（空/极短/纯噪声）；或完全重复且系统判定无需再加权 | 不写；仅 `last_seen_at` 更新 | 论文有 NOOP，本项目补充"退化输入"分支 |
| 7 | **ASK_USER** | 硬冲突且双方可信度**相当**（如两个智能体给出矛盾事实），或用户显式事实与 agent 推断冲突且影响面大 | 两行保留，`status='disputed'`，进待裁决队列；UI 显示冲突卡片 | **论文完全没有**。但对"多智能体记忆中枢"是**必需**的：用户必须能看到"你的两个 agent 说法不一致"，这正是产品价值 |

**动作优先级（短路顺序，实现必须按此顺序判断）**

```text
NOOP  →  (退化输入直接出局)
LINK  →  (相关性够但显然不该合并)
ASK_USER → (硬冲突且可信度相当 —— 必须在自动合并之前拦截)
SUPERSEDE → (时间演化，确定性强)
UPDATE →  (有新增槽位)
MERGE  →  (纯重复)
ADD    →  (兜底)
```

> 顺序的关键在于 **ASK_USER 必须在 MERGE 与 SUPERSEDE 之前**——一旦自动合并把冲突压平，用户就再也看不到分歧了。

**伪代码（含事务边界）**

```python
def apply_action(action, m_new, payload, db):
    with db.transaction():                       # SQLite: BEGIN IMMEDIATE，单写者
        if action == "ADD":
            mid = db.insert_memory(m_new, valid_from=m_new.valid_from, recorded_at=now())
            db.index_async(mid)                  # FTS + 向量，异步、失败可重放
            return mid
        if action == "MERGE":
            t = payload["target"]
            db.execute("UPDATE memories SET support_count=support_count+1,"
                       " last_confirmed_at=?, last_access_at=? WHERE id=?",
                       (now(), now(), t))
            db.add_source(t, m_new.source_agent, m_new.source_ref)
            return t
        if action == "UPDATE":
            t = payload["target"]
            db.merge_payload(t, payload["merged"])           # 槽位级合并，保留旧值到 history 表
            db.insert_history(t, before=db.get_payload(t), reason="update")
            db.index_async(t)
            return t
        if action == "SUPERSEDE":
            old = db.get_memory(payload["target"])
            new_id = db.insert_memory(m_new, valid_from=m_new.valid_from, recorded_at=now())
            db.execute("UPDATE memories SET invalid_at=?, superseded_by=? WHERE id=?", 
                       (m_new.valid_from, new_id, old.id))
            db.add_edge(old.id, new_id, "supersedes")
            return new_id
        if action == "LINK":
            db.add_edge(m_new.id, payload["target"], "related_to", weight=payload.get("w", 0.5))
            return db.insert_memory(m_new, ...)
        if action == "ASK_USER":
            nid = db.insert_memory(m_new, status="disputed")
            db.add_edge(nid, payload["conflict_with"], "contradicts", kind=payload["kind"])
            db.enqueue_dispute(nid, payload["conflict_with"])
            return nid
        return None   # NOOP
```

**必须写进 schema 的字段**（否则上面 7 个动作无法实现）

```sql
-- 只列关键列，非完整 DDL
memories(
  id, content, payload_json,
  valid_from, valid_to,        -- 事件时间（世界时间）
  created_at, recorded_at,     -- 记录时间（事务时间，永不修改）
  invalid_at,                  -- Zep 式失效标记（NULL = 仍有效）
  superseded_by, derived_from, -- 演化链
  support_count, last_confirmed_at, last_access_at,
  importance, trust, status,   -- status: active|disputed|archived
  source_agent, source_ref
)
memories_fts USING fts5(content, tokenize='unicode61')   -- 中文需 trigram 或外部分词
edges(src_id, dst_id, kind, weight, kind_detail, created_at)
  -- kind ∈ {supersedes, related_to, contradicts, derived_from, part_of}
```

---

### 3.6 时效：双时间模型与 invalid_at 失效边

**四个时间列，缺一不可**〔Zep 双时间模型 论文 2501.13956〕

| 列 | 语义 | 谁写 | 可变? |
| --- | --- | --- | --- |
| `valid_from` | 该事实在**世界时间**上开始为真 | 从内容中抽取（"上周三"→ 解析成绝对日期） | 否 |
| `valid_to` | 该事实在世界时间上**预期的**结束（如"合同到 2025-12-31"） | 从内容中抽取，可为 NULL | 否 |
| `invalid_at` | 系统**在何时认定**它不再为真（由后来的记录触发） | SUPERSEDE 动作 | **是（一旦置位不再改）** |
| `recorded_at` | 系统**何时写入**这条记录（事务时间 T′） | 写入时自动 | **永不修改** |

**为什么需要两套时间**：`valid_from` 来自对话内容（"我上个月搬到上海"），可能是过去时；`recorded_at` 是系统墙钟。二者的差就是**迟到写入（late-arriving fact）**——用户今天告诉你一件三个月前发生的事。若只有一套时间，这类事实会被误判为"最新"，从而错误地 SUPERSEDE 掉真正更新的记录。

**核心不变量（写成断言，测试里必查）**

```text
I1. recorded_at 一经写入永不修改           -- 审计前提
I2. invalid_at ≥ valid_from（若非 NULL）  -- 不能"在开始前就失效"
I3. 不存在两条 status='active' 的记录同时满足：
     同 (subject, predicate) 且 [valid_from, COALESCE(invalid_at, +∞)) 区间相交
      -- 唯一性由区间控制，而不是由"是否删除"控制
I4. 任何失效都必须留下 invalid_at + superseded_by，不允许物理删除
```

**区间相交查询（SQLite 可直接跑）**

```sql
-- 找出与候选冲突的有效记录（用于 SUPERSEDE / CONFLICT 判定）
SELECT id, valid_from, invalid_at, content
FROM memories
WHERE subject = :subj AND predicate = :pred
  AND status = 'active'
  AND valid_from < COALESCE(:new_valid_to, 9e18)
  AND COALESCE(invalid_at, 9e18) > :new_valid_from;
```

**"当时为真"的时间旅行查询**（记忆中枢的关键能力）

```sql
-- 问：2025-03-01 那天，系统认为项目负责人是谁？
SELECT content FROM memories
WHERE subject='project:A' AND predicate='owner'
  AND valid_from <= :t
  AND COALESCE(invalid_at, 9e18) > :t
ORDER BY recorded_at DESC LIMIT 1;
```

**迟到写入的处理规则**〔本项目设定，基于 Zep 双时间的推论〕

```text
若 new.valid_from < 已存在记录 e.valid_from 且二者冲突：
  这是"补录历史"，不是"推翻现在"
  → 不 SUPERSEDE 现在有效的记录
  → 插入新行，并按其 valid_from 排序到历史序列中
  → if 与历史区间相交: 标记 CONFLICT（历史记录本身就矛盾了）
```

**失败模式**：相对时间解析（"上周""三天后"）依赖 LLM，**解析错误会直接污染 valid_from**，且错误极难被发现（时间列看起来永远合法）。对策：① 相对时间一律存**原文 + 解析结果 + 置信度**；② 置信度低于阈值时 `valid_from = recorded_at` 并标记 `time_inferred=true`，UI 显示"时间由系统推断"。

---

### 3.7 复习调度：SM-2 可落地版（FSRS 不纳入 v1）

**为什么选 SM-2**：公式完全确定、参数极少、有官方一手来源。FSRS 需要拟合 19 个权重，**本次调研未能取得其官方算法文档**（wiki 返回 404 / 空壳），因此**不凭记忆复述其公式**，明确列为〔未核实〕，不进 v1。

**来源**：SuperMemo 官方 SM-2 说明 https://super-memory.com/english/ol/sm2.htm 〔官方文档，已取得原文〕

**公式（原文）**

```text
间隔：
  I(1) = 1 天
  I(2) = 6 天
  I(n) = I(n-1) · EF        for n > 2

E-Factor 更新：
  EF' = EF - 0.8 + 0.28·q - 0.02·q²
  等价形式（官方给出的化简前形式）：
  EF' = EF + (0.1 - (5-q)·(0.08 + (5-q)·0.02))

  其中 q ∈ {0,1,2,3,4,5} 为回忆质量自评

边界：
  EF 初值 = 2.5
  EF 下限 = 1.3          （原文：低于 1.3 的项目"重复得烦人且通常本身有缺陷"）
```

**数值验算（可直接用作单元测试）**

| q | EF' 值（EF=2.5 起） |
| --- | --- |
| 5 | 2.5 + 0.1 - 0 = **2.6** |
| 4 | 2.5 + 0.1 - (1)(0.08+0.02) = **2.5** |
| 3 | 2.5 + 0.1 - (2)(0.08+0.04) = 2.5 + 0.1 - 0.24 = **2.36** |
| 2 | 2.5 + 0.1 - (3)(0.08+0.06) = 2.5 + 0.1 - 0.42 = **2.18** |
| 1 | 2.5 + 0.1 - (4)(0.08+0.08) = 2.5 + 0.1 - 0.64 = **1.96** |
| 0 | 2.5 + 0.1 - (5)(0.08+0.10) = 2.5 + 0.1 - 0.90 = **1.70** |

**映射到"记忆复习"**（memora-core 的语境改造〔本项目设定〕）

SM-2 原本是"人给自己回忆质量打分"。记忆中枢里没有人类学习场景，因此映射如下：

| SM-2 概念 | memora-core 映射 |
| --- | --- |
| `q` 回忆质量 | **检索质量分**：该记忆被召回后，是否被真正用于回答（有引用=高分；召回但未被引用=中分；被判为无关=低分） |
| `I(n)` 间隔 | **下次主动复检该记忆的时间**（检测是否已过时/被推翻） |
| `EF` | 该记忆的**易记性**，低的说明它总是被误召回 |
| q < 3 | 视为"这次复习失败" → 触发 §3.4 的重新判定（可能已被推翻） |

```text
q 的映射（本项目设定）：
  q=5  记忆被召回且被最终答案直接引用
  q=4  记忆被召回且出现在上下文中，未被直接引用
  q=3  记忆在候选集中但未进入上下文
  q=2  记忆被 judge 判为不相关
  q=1  记忆被检测为疑似过时
  q=0  记忆被检测为已矛盾
```

**伪代码**

```python
import math
EF_MIN, EF_INIT = 1.3, 2.5

def sm2_update(state, q: int):
    """state: {"n": int, "EF": float, "I": int}. 返回更新后的 state。"""
    assert 0 <= q <= 5
    ef = state["EF"] + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02))
    ef = max(EF_MIN, ef)

    if q < 3:
        n = 0                     # 复习失败：重置重复次数，明天再来
        interval = 1
    else:
        n = state["n"] + 1
        if n == 1:
            interval = 1
        elif n == 2:
            interval = 6
        else:
            interval = max(1, round(state["I"] * ef))

    interval = min(interval, 365)  # 〔本项目设定〕上限一年，防止极端 EF 撑爆
    return {"n": n, "EF": ef, "I": interval, "due_at": now_ts() + interval * 86400}
```

**取值建议与陷阱**
- EF 初值 2.5、下限 1.3 是**官方来源**，直接用。
- 间隔上限 365 天是〔本项目设定〕——SM-2 原版没有上限，长期不复习的记忆间隔会指数增长到荒谬值。
- **不要用 SM-2 决定"是否召回"**，它只决定"何时复检"。二者混淆会让检索排序被复习状态污染。

---

### 3.8 上下文打包：对抗 Lost in the Middle 的位置布局

**问题**：检索出 top-k 只是拿到"候选材料"，怎么**排列进 prompt** 直接决定模型能否用上它们。arXiv:2307.03172 证明存在 **U 型曲线**：开头与结尾最有效，中间最无效〔论文〕。

**变量定义**

| 符号 | 含义 |
| --- | --- |
| `B` | token 预算 |
| `s_i` | 候选 i 的最终排序分 |
| `len_i` | 候选 i 的 token 数 |
| `pos_i` | 候选 i 在最终 prompt 中的相对位置 ∈ [0,1] |

**打包算法（三段式布局，本项目设定，依据 U 型曲线）**

```text
1) 按 s_i 降序排列候选
2) 预算裁剪：贪心加入直到 Σ len_i ≤ B · (1 - reserve)
     reserve = 0.15   # 留给系统提示与用户问题
3) 布局（关键）：
     最强的 1 条      → 放在**最前**（primacy 位）
     次强的 1–2 条    → 放在**最后**（recency 位，紧邻问题）
     其余             → 按分数**降序**放中间（次强的靠前，最弱的在正中）
4) 兜底：若被裁掉的候选中有 s > 0.8·max_s，在包尾追加一行
     "另有 N 条高相关记忆因预算未展开，可调用 memory_recall 展开"
   —— 这比静默丢弃好：模型知道自己缺信息
```

**位置有效性的经验修正项（可选，用于打包内排序）**

```text
u(pos) = (2·pos - 1)²          # pos=0 → 1（最前，最好）; pos=0.5 → 0（中间，最差）; pos=1 → 1（最后，好）
effective_score_i = s_i + β · u(pos_i)
β 建议 0.1〔本项目设定〕—— 只做微调，不改变主序
```
> 注意：`u(pos)` 的两端都是高点，**它无法单独决定"放最前还是放最后"**。所以布局必须由上面的"三段式"硬规则决定，`u` 只用于评估打包质量。

**伪代码**

```python
def pack(cands, budget_tokens, reserve=0.15):
    usable = int(budget_tokens * (1 - reserve))
    ranked = sorted(cands, key=lambda c: -c.score)
    kept, used = [], 0
    for c in ranked:
        if used + c.tokens <= usable:
            kept.append(c); used += c.tokens
    if not kept:
        return [], ranked                      # 一条都放不下 → 由调用方降级
    if len(kept) == 1:
        return kept, ranked[len(kept):]
    head, tail = kept[:1], kept[1:3]           # 最强 → 头；次强 → 尾
    middle = kept[3:]                          # 其余按分降序留在中间
    ordered = head + middle + tail
    dropped = ranked[len(kept):]
    note = None
    if dropped and dropped[0].score > 0.8 * ranked[0].score:
        note = f"另有 {len(dropped)} 条高相关记忆因预算未展开，可调用 memory_recall 展开"
    return ordered, dropped, note
```

**失败模式**：预算裁剪按"分数降序贪心"会**偏向短记忆**（长但关键的证据被挤掉）。对策：改用**价值密度** `s_i / len_i` 排序做裁剪，再用 `s_i` 做布局——裁剪与布局用两个不同的键。

---

### 3.9 离线兜底：无 embedding / 无 judge 时的确定性替代（及其真实上限）

**总原则**：降级不是"功能开关"，是**能力降级 + 显式标注**。任何降级路径返回的结果必须带 `degraded: ["embedding", "judge"]` 之类的**原因码**，UI 与 API 都可见。**绝不静默假装语义检索成功。**

#### 3.9.1 稀疏检索替代：SQLite FTS5 + BM25

```sql
-- 建表（中文必须用 trigram，unicode61 对中文按字切会退化）
CREATE VIRTUAL TABLE memories_fts USING fts5(
    content,
    tokenize = 'trigram'          -- 或 unicode61 + 外部分词器
);
-- 查询
SELECT rowid, -1 * bm25(memories_fts) AS score
FROM memories_fts
WHERE memories_fts MATCH :q
ORDER BY score DESC LIMIT 50;
```
**注意**：FTS5 `MATCH` 语法把 `"`、`*`、`-` 等当运算符，**用户输入必须转义**（把每个 token 用双引号包起来），否则会抛语法错误或被注入奇怪的查询。

#### 3.9.2 稠密检索替代：字符 n-gram 哈希向量

```text
encode(text):
  text ← lowercase(normalize(text))
  grams ← 所有长度 3 的字符 n-gram（中文按字，英文按字符）
  v ← 零向量，维度 D（建议 1024）
  for g in grams:
      h1 = fnv1a(g) mod D          # 主桶
      s  = +1 if fnv1a(g + "#sign") & 1 else -1   # 符号哈希，抵消碰撞偏差
      v[h1] += s
  return l2_normalize(v)
```

```python
def fnv1a(s: str) -> int:
    h = 0x811C9DC5
    for b in s.encode("utf-8"):
        h ^= b
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h

def ngram_vec(text: str, D: int = 1024) -> list[float]:
    t = text.lower()
    v = [0.0] * D
    for i in range(max(1, len(t) - 2)):
        g = t[i:i+3]
        idx = fnv1a(g) % D
        sign = 1.0 if (fnv1a(g + "#sign") & 1) else -1.0
        v[idx] += sign
    norm = sum(x * x for x in v) ** 0.5 or 1.0
    return [x / norm for x in v]
```

#### 3.9.3 判重替代：规则组合

```text
duplicate_rules(a, b) → bool，满足任一即判重：
  R1 精确相等（去空白、去标点、小写后）
  R2 归一化后字符级 Jaccard ≥ 0.85
  R3 字符 3-gram 集合的 Dice 系数 ≥ 0.80
  R4 一方是另一方子串且长度比 ≥ 0.7
  R5 SPO 三元组完全一致（若已抽取结构）

conflict_rules(a, b) → bool（优先级最高，先于 duplicate 判定）
  C1 同 (subject, predicate)，宾语不同，且都是"值型"（数字/日期/专名）
  C2 否定词翻转：仅差 不/没/未/not/never/n't
  C3 数值或日期冲突：抽取所有数字，同槽位不同值
```

**Jaccard 与 Dice 定义**

```text
J(A,B) = |A ∩ B| / |A ∪ B|
Dice(A,B) = 2|A ∩ B| / (|A| + |B|)
```

#### 3.9.4 诚实的能力上限（必须写进 UI 的说明）

| 能力 | 在线（有模型） | 离线（降级） | 差异的真实后果 |
| --- | --- | --- | --- |
| 语义召回（同义改写） | 好 | **差** | 用户问"截止日"，记忆里写"deadline"，BM25 与 n-gram **都召不回** |
| 跨语言召回 | 好 | **不可用** | 中英混写的记忆基本失联 |
| 冲突判定 | 好 | **仅能抓字面冲突** | "项目 A 延期" vs "项目 A 按期" 靠否定词能抓；"提前"vs"延后"抓不到 |
| 槽位合并 | 好 | **不可用** | 降级时只能 ADD，会产生重复记忆，需事后重跑合并 |
| importance | 好 | 中 | 启发式可用，但长度偏置明显（长记忆被高估） |
| 时间抽取 | 好 | **基本不可用** | 相对时间（"上周"）无法解析 → 只能记 recorded_at |

**关键结论（本项目立场）**：降级模式下**必须把 `consolidation`（沉淀/合并）工作流降级为"只入队不执行"**，等云端恢复后重跑。否则用规则合并会制造不可逆的信息损失（§3.4 失败模式 1）。这与 AGENTS.md 的降级约定一致：读写继续，但不要依赖语义相似度做精确判断。

#### 3.9.5 降级状态机（供 memory_health 暴露）

```text
ONLINE      : embedding ✓  judge ✓  rerank ✓
PARTIAL     : embedding ✓  judge ✗   → 判重退化为"向量阈值 + 规则硬冲突"，禁用 MERGE 的自动分支
DEGRADED    : embedding ✗  judge ✗   → 仅 BM25 + n-gram + 规则；禁用 SUPERSEDE 自动分支；
                                        禁用 consolidation；所有写入默认 status='candidate'
RECOVERING  : 刚恢复，队列中积压 N 条待重算 → 后台重放，结果回写并清除 degraded 标记
```

---

### 3.10 算法 → 工具接口映射（对齐 AGENTS.md 的实际 API）

把上面各节落到项目已约定的 `memory_*` 工具上，避免调研与实现脱节：

| 工具 | 用到的算法 | 注意事项 |
| --- | --- | --- |
| `memory_recall` | §3.1 衰减 + §3.2 importance + §3.3 RRF 融合 | 返回必须带 `degraded` 与每条记忆的 `[m:id]` 引用 |
| `memory_search` | §3.3 纯检索（不刷新 `last_access_at`） | **不写日志、不刷新在场** → 因此**不得**更新 recency 的 `t_ref` |
| `memory_digest` | §3.8 打包 + §3.3 融合 | 预算参数 `budget` 即 `B`；必须保留引用 id |
| `memory_capture` | 无（零丢失草稿） | 跳过判重，直接落 `status='draft'` |
| `memory_remember` | §3.4 判重 + §3.5 七动作 | 默认 `status='candidate'`；`evidence_kind='agent_asserted'` 走低信任分支 |
| `memory_relate` | §3.5 LINK；`contradicts`/`supersedes` | 对应 `edges.kind` |
| `memory_evidence` | §3.5 MERGE（`support_count`） | 追加证据等价于"再确认一次" |
| `memory_review` | §3.7 SM-2 | 打分即 `q`；`q<3` 触发重新判定 |
| `memory_graph` | §3.6 时间轴 + §2.7/§2.8 图结构 | 四视图：词义脑图/层级脑图/时间线/证据图 |
| `memory_health` | §3.9 降级状态机 | 直接暴露 ONLINE/PARTIAL/DEGRADED/RECOVERING |
| `memory_workflow_run` | §3.4/§3.5/§3.9 | 降级时 consolidation 工作流只入队不执行 |
| `memory_forget` | §3.6 失效而非删除 | 应实现为 `invalid_at` 置位 + `status='archived'`，而非物理 DELETE |

**与 AGENTS.md 约定的对齐检查（本调研确认无冲突）**：规则 1"不要伪造"↔ §3.9.4 上限披露；规则 2"quote 必须原文精确片段"↔ §3.4 判定矩阵的证据字段；规则 4"先 search 再决定 add/update/merge"↔ §3.4 两阶段判重；规则 5"冲突要报"↔ §3.5 的 ASK_USER / LINK(contradicts) 动作。

---

## 4. 评测方案：自建测试集设计与指标

### 4.1 对齐 LongMemEval 的五类能力

LongMemEval〔arXiv:2410.10813〕定义了五类核心能力。它们是**能力维度**而非任务类型，memora-core 应逐项建集：

| # | 能力 | LongMemEval 定义 | memora-core 的落点 | 我们特有的难点 |
| --- | --- | --- | --- | --- |
| 1 | **Information Extraction** | 从长历史中抽出某条信息 | `memory_recall` 能否召回目标记忆 | 多智能体写入 → 同一事实有多种措辞，需测**措辞不变性** |
| 2 | **Multi-session Reasoning** | 跨多次会话综合 | 跨 `session_id` 的 `memory_digest` | 会话来自**不同智能体**（DSH/Codex/Claude Code），需测**跨智能体一致性** |
| 3 | **Temporal Reasoning** | 时间推理（何时发生） | §3.6 双时间查询 | 迟到写入（补录历史）是论文基准没有的场景 |
| 4 | **Knowledge Update** | 信息变更后答新值、且知道旧值曾为真 | §3.5 SUPERSEDE + `invalid_at` | 需同时验证"新值对"与"旧值仍可查" |
| 5 | **Abstention** | 历史中无答案时应明确说不知道 | 降级/空结果时不得编造 | 直接对应项目铁律"绝不伪造成功" |

### 4.2 自建测试集设计

**S1 · 语义改写集（测 Information Extraction）**
同一事实人工写 5 种表述（正式/口语/中英混/缩写/含错别字），写入 1 条、用另外 4 条查询。指标：召回率。**用途：校准 §3.4 的 0.80/0.92 阈值**——这是唯一能让那两个数字从"拍脑袋"变成"有依据"的手段。

**S2 · 冲突注入集（测 Conflict 判定）**
构造最小对立对：

| 类型 | 例 | 期望动作 |
| --- | --- | --- |
| 纯否定翻转 | "支持 A" / "不支持 A" | CONFLICT → ASK_USER |
| 数值冲突 | "截止 3/1" / "截止 5/1" | CONFLICT 或 SUPERSEDE（看时间） |
| 时间演化 | "负责人是张三"（1月）/ "负责人是李四"（3月） | SUPERSEDE |
| 粒度差异 | "北京" / "北京市朝阳区" | COMPLEMENT（LINK），**不得 MERGE** |
| 纯重复 | "deadline 是周五" / "周五截止" | MERGE |

**S3 · 时间旅行集（测 Temporal Reasoning）**
注入带 `valid_from`/`invalid_at` 的历史，在任意时间点 t 提问"当时是什么"。断言：返回的是 t 时刻有效的那条，且 `invalid_at` 之后的查询不返回它。

**S4 · 迟到写入集（本项目特有）**
先写"3 个月前搬到上海"，再写"上个月搬到北京"，最后写"现在住哪"。断言之字形：`recorded_at` 顺序与 `valid_from` 顺序**不一致**时，不能把后者误判为更新。

**S5 · 预算压力集（测 §3.8 打包）**
固定 `budget ∈ {500, 1200, 4000}` token，测**事实保留率**：注入 N 条事实，问其中 M 条，成功率随 budget 的变化曲线。**关键指标是曲线的形状而非单点**——若 budget 翻倍但成功率不动，说明打包器有 bug（可能被长记忆挤占）。

**S6 · 降级一致性集（测 §3.9）**
同一查询分别在 ONLINE / DEGRADED 下跑，断言：① 降级结果**必须**带 `degraded` 标记；② 降级下不得产生 MERGE/SUPERSEDE 自动动作；③ 两次结果不能"看起来一样"却一个是语义召回一个是关键词召回（这是最隐蔽的伪造）。

**S7 · 跨智能体分歧集（产品核心价值）**
DSH 说"用方案 A"，Codex 说"用方案 B"。断言：`memory_graph` 的**证据图**里出现 `contradicts` 边；UI 能看到分歧；不自动裁决。

### 4.3 指标定义（含公式）

设查询 q 的相关记忆集合为 R（人工标注），系统返回前 k 条为 `L_k = [m_1..m_k]`。

**Recall@k**（召回覆盖）

```text
Recall@k = |{ m ∈ L_k : m ∈ R }| / |R|
```

**MRR**（首个正确结果的名次，衡量"能不能第一眼看到"）

```text
MRR = (1/|Q|) · Σ_{q ∈ Q}  1 / rank_q
  rank_q = 第一条相关记忆的名次；若前 k 条都没有，记作 0（贡献 0）
```

**nDCG@k**（考虑多级相关度与位置折扣）

```text
DCG@k  = Σ_{i=1..k}  ( 2^{rel_i} - 1 ) / log2(i + 1)
IDCG@k = 对理想排序（rel 降序）计算的 DCG@k
nDCG@k = DCG@k / IDCG@k

rel_i 取值建议（本项目设定）：
  2 = 该记忆直接包含答案
  1 = 相关但不含答案
  0 = 不相关
```

**事实保留率（token 预算下）——本项目重点指标**

```text
Retention(B) = ( 在预算 B 下，digest 中仍完整保留的事实数 ) / ( 注入的事实总数 )

分两级：
  Retention_exact(B)   = 事实的**精确内容**（含数值/日期）仍在
  Retention_semantic(B)= 事实的**要点**仍在（允许改写）
  二者之差 = 摘要造成的信息损失 → 用来看 §2.20 递归摘要有多少漂移
```

**冲突处置正确率（本项目特有）**

```text
ConflictAcc = ( 被正确分类的冲突对 ) / ( 全部冲突对 )
分类维度：duplicate / complement / supersede / conflict / unrelated
另设 False-Merge Rate = 被误 MERGE 的非重复对 / 全部应区分对     ← 最重要，因为不可逆
```

**不伪造率（Abstention 正确率，对应项目铁律）**

```text
AbstentionAcc = ( 历史中无答案时应答"不知道"的次数 ) / ( 无答案问题总数 )
HallucinationRate = 1 - AbstentionAcc
要求：History 中无答案时，系统**必须**返回空结果 + 明确的"未找到"，不得返回低置信猜测
```

### 4.4 验收门槛建议〔本项目设定〕

| 指标 | v1 目标 | 理由 |
| --- | --- | --- |
| Recall@10（S1 语义改写，ONLINE） | ≥ 0.85 | 低于此值说明召回器本身有问题，后续优化无意义 |
| Recall@10（S1，DEGRADED） | ≥ 0.55（**且必须标注降级**） | 承认关键词检索对同义改写无能为力 |
| MRR（S3 时间旅行） | ≥ 0.80 | 时间查询若排不到第一，等于不可用 |
| **False-Merge Rate** | **≤ 0.02** | 最容易造成不可逆损失，门槛最严 |
| ConflictAcc | ≥ 0.75 | 允许规则+judge 混合的误差 |
| Retention_exact(B=1200) | ≥ 0.70 | 决定 digest 是否可信 |
| **HallucinationRate** | **= 0** | 项目铁律，无妥协空间 |
| 降级标注覆盖率 | **= 100%** | 任何降级结果未标注即为缺陷 |

### 4.5 评测实施注意

1. **不能只测端到端**。检索错与生成错会混在一起。必须**分层埋点**：召回阶段（Recall@k）、重排阶段（nDCG）、打包阶段（Retention）、生成阶段（Accuracy）。
2. **judge 一致性**。用 LLM 做 judge 时必须报告**judge 与人工标注的一致率**（Cohen's κ），否则指标不可信。
3. **可复现**。所有评测必须固定 embedding 模型版本与 judge 模型版本，写进报告头。换模型 = 换基线，不可跨版本比较。
4. **降级路径必须进 CI**。把 S6 做成常驻测试：故意切断网络跑一遍，断言 `degraded` 字段非空且动作受限。

---

## 5. 参考表

### 5.1 论文与官方来源（按首次出现顺序）

| # | 标题 | 编号 | 链接 | 来源类型 | 本报告引用位置 |
| --- | --- | --- | --- | --- | --- |
| 1 | MemGPT: Towards LLMs as Operating Systems | arXiv:2310.08560 | https://arxiv.org/abs/2310.08560 | arXiv 预印本 | §2.1, §1-1 |
| 2 | Generative Agents: Interactive Simulacra of Human Behavior | arXiv:2304.03442 | https://arxiv.org/abs/2304.03442 | arXiv 预印本（UIST'23） | §2.2, §3.1, §3.2, §3.3 |
| 3 | Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory | arXiv:2504.19413 | https://arxiv.org/abs/2504.19413 | arXiv 预印本（工业报告） | §2.3, §3.4, §3.5 |
| 4 | A-MEM: Agentic Memory for LLM Agents | arXiv:2502.12110 | https://arxiv.org/abs/2502.12110 | arXiv 预印本 | §2.4, §3.5 |
| 5 | MemoryOS: Memory OS of AI Agent | arXiv:2506.06326 | https://arxiv.org/abs/2506.06326 | arXiv 预印本 | §2.5, §3.1, §3.2 |
| 6 | Zep: A Temporal Knowledge Graph Architecture for Agent Memory (Graphiti) | arXiv:2501.13956 | https://arxiv.org/abs/2501.13956 | arXiv 预印本（工业） | §2.6, §3.5, §3.6 |
| 7 | HippoRAG: Neurobiologically Inspired Long-Term Memory for LLMs | arXiv:2405.14831 | https://arxiv.org/abs/2405.14831 | arXiv 预印本（NeurIPS'24） | §2.7 |
| 8 | From RAG to Memory: Non-Parametric Continual Learning (HippoRAG 2) | arXiv:2502.14802 | https://arxiv.org/abs/2502.14802 | arXiv 预印本 | §2.7 |
| 9 | From Local to Global: A Graph RAG Approach to Query-Focused Summarization | arXiv:2404.16130 | https://arxiv.org/abs/2404.16130 | arXiv 预印本（微软） | §2.8 |
| 10 | LazyGraphRAG（厂商博客，非论文） | — | https://www.microsoft.com/en-us/research/blog/lazygraphrag-setting-a-new-standard-for-quality-and-cost/ | **厂商博客** | §2.8（实验数字未核实） |
| 11 | LightRAG: Simple and Fast Retrieval-Augmented Generation | arXiv:2410.05779 | https://arxiv.org/abs/2410.05779 | arXiv 预印本 | §2.9 |
| 12 | MemoRAG: Boosting Long Context Processing with Global Memory-Enhanced Retrieval Augmentation | arXiv:2409.05591 | https://arxiv.org/abs/2409.05591 | arXiv 预印本 | §2.10 |
| 13 | RAPTOR: Recursive Abstractive Processing for Tree-Organized Retrieval | arXiv:2401.18059 | https://arxiv.org/abs/2401.18059 | arXiv 预印本（ICLR'24） | §2.11 |
| 14 | LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory | arXiv:2410.10813 | https://arxiv.org/abs/2410.10813 | arXiv 预印本（ICLR'25） | §2.12, §4.1 |
| 15 | Evaluating Very Long-Term Conversational Memory of LLM Agents (LoCoMo) | arXiv:2402.17753 | https://arxiv.org/abs/2402.17753 | arXiv 预印本（ACL'24） | §2.13 |
| 16 | Lost in the Middle: How Language Models Use Long Contexts | arXiv:2307.03172 | https://arxiv.org/abs/2307.03172 | arXiv 预印本（TACL'24） | §2.14, §3.8 |
| 17 | Self-RAG: Learning to Retrieve, Generate, and Critique through Self-Reflection | arXiv:2310.11511 | https://arxiv.org/abs/2310.11511 | arXiv 预印本（ICLR'24） | §2.15 |
| 18 | Corrective Retrieval Augmented Generation (CRAG) | arXiv:2401.15884 | https://arxiv.org/abs/2401.15884 | arXiv 预印本 | §2.16, §3.4 |
| 19 | Knowledge Conflicts for LLMs: A Survey | arXiv:2403.08319 | https://arxiv.org/abs/2403.08319 | arXiv 预印本（EMNLP'24） | §2.17, §3.4 |
| 20 | M3-Embedding / BGE-M3: Multi-Linguality, Multi-Functionality, Multi-Granularity | arXiv:2402.03216 | https://arxiv.org/abs/2402.03216 | arXiv 预印本 | §2.18, §3.3 |
| 21 | MemoryBank: Enhancing Large Language Models with Long-Term Memory | arXiv:2305.10250 | https://arxiv.org/abs/2305.10250 | arXiv 预印本（AAAI'24） | §2.19, §3.1 |
| 22 | Recursively Summarizing Enables Long-Term Dialogue Memory in LLMs | arXiv:2308.15022 | https://arxiv.org/abs/2308.15022 | arXiv 预印本 | §2.20 |
| 23 | Memora: A Harmonic Memory Representation Balancing Abstraction and Specificity | arXiv:2602.03315 | https://arxiv.org/abs/2602.03315 | arXiv 预印本（录用状态未核实） | §2.21 |
| 24 | SM-2 算法（SuperMemo 官方说明） | — | https://super-memory.com/english/ol/sm2.htm | **官方文档（一手）** | §3.7 |

> **关于会议归属**：上表"来源类型"列中括号内的会议仅为标注，**部分未在本次抓取的 HTML 中逐字核实**（arXiv 正文页不总含 venue 字段）。**编号与标题均已通过 arXiv API 核实**；若需引用会议版本请自行核对 DBLP。

### 5.2 未核实项清单（禁止当作结论使用）

| 项 | 状态 | 报告中的处理 |
| --- | --- | --- |
| Generative Agents 官方实现 `decay=0.995` | 未取得官方代码库一手证据；论文 PDF 明确写 0.99 | 两值并列，**标明来源不同**，不裁定谁"对" |
| MemoryOS 的 α/β/γ 具体数值 | 论文正文只给符号，未给数值 | 标〔未核实〕，给出本项目设定值 |
| MemoryBank 的 S 增长更新公式 | 论文只描述方向，未给闭式 | 标〔未核实具体更新公式〕 |
| FSRS 的 19 个权重与公式 | 官方 wiki 返回 404/空壳，未取得一手文档 | **不写公式**，明确不纳入 v1 |
| RRF 的 k=60 原始出处 | 未取得 Cormack 等原论文；k=60 为通行默认 | 公式采用，**k 值标〔未核实原文〕** |
| BM25 的 k1=1.2 / b=0.75 | 通行默认，未取得原论文 | 标〔未核实原文〕，做成配置项 |
| CRAG 的 τ_high / τ_low 具体数值 | 论文正文给机制未给数值 | 标〔未核实〕，本项目自行设定 |
| LazyGraphRAG 的实验数字 | 仅厂商博客，非同行评审 | 标〔未核实〕，只取"按需摘要"的思想 |
| Memora (2602.03315) 的会议录用状态 | 预印本，编号日期 2026-02 | 标〔未核实〕 |
| 各论文的会议 venue | arXiv HTML 页未逐字核实 | §5.1 表下已统一声明 |
| §3.4 的 0.92 / 0.80 阈值 | **无文献来源** | 明确标〔本项目设定〕，并要求 S1 集校准 |

### 5.3 已排除的候选（避免误引）

| 编号 | 实际标题 | 为何排除 |
| --- | --- | --- |
| arXiv:2408.04811 | *h4rm3l: A language for Composable Jailbreak Attack Synthesis* | 常被误当作 "GraphRAG survey"，实为越狱攻击合成，与记忆无关，**未纳入** |

### 5.4 取证方法学（可复核）

```text
1. 编号核实：arXiv API  export.arxiv.org/api/query?
     - id_list=<逗号分隔编号>  → 逐条返回标题，确认编号↔标题对应
     - search_query=ti:"<关键词>" → 用于反查不确定的编号（Memora / MemoryOS / Zep）
2. 全文抓取：优先 arxiv.org/html/&lt;id&gt;v1，回退 ar5iv
     → 共 21 篇，合计约 1.8 MB 纯文本，落盘 .research/raw/
3. 数值复核：对关键常数（如 decay factor）**额外下载 PDF 并抽取正文**，
     避免 HTML 版本的渲染/排版丢失
4. 公式抽取：正则定位 LaTeX 残留（如 \alpha_{recency}、R=e^{-\frac{t}{S}}）
     并回读上下文窗口，确认变量定义与取值范围
5. 计数校验：见 §6 的自检数据
```

---

## 6. 自检数据

> 以下为交付时的实测计数，可用文末命令复现。

| 检查项 | 要求 | 实测 |
| --- | --- | --- |
| 来源条目数（§5.1） | ≥ 15 | **24 条** = 22 篇 arXiv 论文 + 1 份 SM-2 官方文档 + 1 条厂商博客 |
| 获全文逐篇精读的 arXiv 论文 | ≥ 15 | **21 篇**（HippoRAG 2 经 API 核实标题摘要后并入 §2.7，未单列全文） |
| 全文抓取量 | — | 21 篇，约 **1.8 MB** 纯文本，落盘 `.research/raw/` |
| 每条含可点击链接 | 是 | 24/24 |
| 可直接实现的公式/伪代码块 | ≥ 10 | **60 个**（见下方统计方法） |
| "本项目设定"显式标注 | 严格区分 | 见 §5.2 与本项目设定标记统计 |
| 未核实项清单 | 必须存在 | §5.2，共 10 项 |

**公式/伪代码块统计方式**：统计文中以 ```text 或 ```python 或 ```sql 开头的围栏代码块，其中**包含可执行语义**（公式、伪代码、SQL、算法步骤）者计入。
