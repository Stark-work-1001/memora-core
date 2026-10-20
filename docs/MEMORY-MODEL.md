# 记忆模型（Memora-Core 的语义内核）

> 这份文档回答一个问题：**什么算"一条记忆"**，它住在哪一层、以什么形式存在、
> 怎样被判定、怎样被复用、什么时候该被推翻。所有代码实现都以本文为准。

## 1. 记忆不是"聊天记录"

聊天记录是**原始材料**（raw），记忆是**经过判定的可复用断言**（assertion）。
两者在库里是分开的：

| 层 | 表 | 是否参与召回 | 说明 |
|---|---|---|---|
| 原始材料 | document / chunk | 是（作为来源） | 外部文档、会话落盘、按日期 Markdown |
| 候选 | memory(status=candidate) | 否（默认） | 已提炼但未经核验 |
| 已审核记忆 | memory(status=approved) | **是** | 唯一默认召回对象 |
| 历史版本 | memory(status=superseded/merged) | 否（可回溯） | 保留链路，不删除 |

"会话沉淀"工作流的本质就是 raw → candidate → approved 的三级跃迁。

## 2. 六个层级（scope）

    global                  跨项目、跨智能体的稳定事实与用户习惯
    └─ workspace:<项目>      与某个代码库/工作区绑定的知识
       └─ agent:<智能体>     某个智能体自己的记忆与偏好
          └─ task:<任务>     一次任务的过程性记忆
             └─ conversation:<会话>  对话级上下文
    └─ document:<文档>       文档派生记忆（挂在文档作用域下）

- 召回时**默认继承**：查询 task 作用域时，会同时看 global / workspace / agent。
- 写入时**默认就近**：不显式指定就落在当前会话所属的作用域。
- 跨作用域提升（promotion）是一条显式动作，不是自动的——避免局部经验污染全局。

## 3. 十种记忆类型（kind）

| kind | 含义 | 典型来源 | 默认信任 |
|---|---|---|---|
| fact | 已验证的事实/状态 | 用户陈述、工具输出 | 0.7–0.9 |
| knowledge | 知识（定义/定理/特征/公式） | 文档、学习 | 0.7 |
| decision | 决策（背景/选项/取舍/结果） | 会话、复盘 | 0.6 |
| preference | 用户习惯与偏好 | 用户明示/多次行为 | 0.8 |
| procedure | 可复用的操作步骤 | 工具调用序列 | 0.6 |
| experience | 经验教训（可复用判断规则） | 复盘 | 0.55 |
| task | 任务描述与目标 | 会话开始 | 0.6 |
| turn | 关键对话回合 | 会话 | 0.5 |
| tool | 工具调用与其结果 | 工具日志 | 0.8（结果） |
| artifact | 产物（文件、代码、图表） | 工具输出 | 0.7 |

类型只是**检索与展示的分类维度**，不决定真假。真假由证据决定。

## 4. 证据（evidence）：记忆"怎么知道的"

每条记忆可以挂多条证据。证据有种类、原句引文、来源 URI、哈希、信任分：

    user_stated    0.90   用户直接说
    verification   0.85   独立二次核验通过
    tool_output    0.80   工具/命令的真实输出
    code_run       0.80   代码执行结果
    document       0.70   外部文档
    web            0.60   网络来源（需谨慎）
    derived        0.50   由其它记忆推导
    agent_asserted 0.45   智能体自述（**最弱**）

**硬规则**：只有 agent_asserted 证据的记忆，trust ≤ 0.5，且不允许自动进入 approved。
这是"智能体不能靠嘴说自己记得"的技术保障。

## 5. 形式（block）：记忆可以不是纯文本

一条记忆可以携带任意多个富形式块：formula（LaTeX，前端 KaTeX 渲染）、
derivation（推导步骤，步骤化）、code（带语言标记的代码围栏）、table（结构化表格）、
image（相对 vault 路径的图片）、database（对某张表/某次查询的引用，含 SQL 与快照）、
list / quote。

学习场景的六层教学结构就落在 memory.didactic 这个 JSON 字段里：
definition / theorem / property / formula / derivation / example。
一条知识记忆既可以有正文，也可以有这六层结构化拆解。

## 6. 关系（edge）：脑图的数据基础

    semantic      语义相近（向量或人工）
    hypernym      上位词（A 是 B 的一种）
    hyponym       下位词
    part_of       组成关系
    instance_of   实例关系
    causes        因果关系
    supports      证据支撑
    contradicts   互相矛盾（触发冲突工作流）
    supersedes    新版本取代旧版本
    derived_from  派生来源
    mentions      提及（记忆提到某个实体）
    prerequisite  学习先修
    alias         别名（实体归一）
    temporal_next 时间相邻

边带 weight / confidence / origin(explicit|inferred|llm|cooccurrence) 和
valid_from / valid_to（双时序：何时为真 vs 何时被记录）。

## 7. 记忆的生命周期（状态机）

    candidate ──approve──> approved ──supersede──> superseded
        │                     │  └──merge──> merged
        └──reject──> rejected └──archive──> archived

- 只有 approved 参与默认召回。
- superseded / merged 保留链路与来源，可回溯，不参与召回。
- 删除分两级：archive（软，保留）与 purge（硬，需显式同意，写审计）。

## 8. 判定（judge）：七种动作

新记忆进来时，与已有的近邻记忆比较，判定层给出：

| 动作 | 进入条件 | 结果 |
|---|---|---|
| add | 相似度 < 0.80，无矛盾 | 新建 |
| update | 同义但新内容更完整/更准确 | 就地更新，保留旧证据 |
| merge | 互补且同主题 | 合并正文，保留双方来源 |
| supersede | 新版本取代旧版本（含时间先后） | 旧置 superseded，记 valid_to |
| link | 相关但独立 | 建立边，不合并 |
| noop | 完全重复（归一化文本相同，或去重分 dup ≥ 0.92 且没有更强的证据） | 仅追加证据 |
| ask | 冲突且证据不足 | 进人工审核队列 |

> **顺序约束**：ASK 必须排在 MERGE **之前**。一旦自动合并把冲突压平，用户就永远看不到
> 两个智能体在同一件事上的分歧——而这恰恰是"把多个智能体的记忆集中到一处"的核心价值。

阈值（本项目设定，可配置）：
dup ≥ 0.92 自动合并候选 / 0.80–0.92 交判定层 / < 0.80 新记忆。

> **重要更正（来自 docs/research/R2-papers.md）**：上述阈值**不是论文结论**，是社区经验带，
> 且强依赖所用 embedding 模型。它们被标为「本项目设定」，必须用语义改写测试集校准后才算可用；
> 未校准前，界面会把自动合并标成"建议"而不是"已执行"。

> **第二条硬约束**：**降级模式下禁止自动 MERGE / SUPERSEDE**。误合并不可逆、漏合并可修复，
> 所以模型不可用时只入队不执行，恢复后重跑 consolidation。

## 9. 复习（review）：记忆会被"用"出来的强度

每条记忆有 stability / difficulty / review_due，由 SM-2 维护：
评分 0–5 → 更新难度因子 EF 与下次间隔。界面上"复习"页给出今日到期条目。
这解决"记忆写进去就再也想不起来"的问题。

## 10. 衰减（decay）：不是遗忘，是归档

w(t) = w0 · exp(−λΔt)，半衰期默认 30 天；长期未用且低重要度的记忆转 archived，
仍在库里、仍可被显式搜索命中，只是不再占用默认召回预算。

## 11. 与工作流的对应

| 工作流 | 记忆模型里的动作 |
|---|---|
| 智能体会话沉淀 | raw → candidate → approved，写证据与日期 Markdown |
| 混合召回与重排序 | approved 集合上的 BM25+向量+图召回 → RRF → rerank → MMR → 预算打包 |
| 新记忆去重与合并 | 近邻召回 → 分层阈值 → 判定七动作 → 写回与审计 |
| 记忆更新与推翻 | 双时序比较 → supersede → 历史链 |
| 冲突与来源审计 | contradicts 边 → 证据强度排序 → 报告 → 人工裁决 |
| 细节与抽象线索 | 每条细节生成 cue，检索时 cue→detail |
| 学习笔记与复习 | didactic 六层 + SM-2 排程 |
| 增量索引维护 | 变更检测 → FTS/向量增量 → 孤儿清理 |
| 跨智能体记忆分发 | 作用域解析 → 摘要包 → 交换格式导出 → 分发留痕 |

## 12. 不做什么（边界）

- **不做**自动把智能体自述升格为事实；没有证据就是候选。
- **不做**静默覆盖：任何 supersede / merge 都留下审计与被合并链路。
- **不做**假成功：模型不可用时明确降级并在界面标注，不返回伪造向量或伪造判定。
- **不做**把"空间距离"当语义关系：脑图布局只是投影，真实关系以 edge 表为准。