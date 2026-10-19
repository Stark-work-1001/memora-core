# 统一记忆系统升级（开发目录）

本次需求覆盖此前 ROADMAP / DECISIONS 中“不做 rerank、图遍历、统一检索”的旧取舍。
修改范围仅为 `<项目根>`。**没有用户明确授权，不运行桌面构建、发布、同步脚本，
不写入 `../memora-desktop-standalone`，不改动其用户数据。**

## 产品闭环

会话 / 学习输入 / 外部文档 → 不可变 Markdown 原稿 + SQLite → 提炼候选 → Judge → 来源核验 →
审核 / 配置的沉淀策略 → Embedding 索引 → 全文 + 向量 + 显式关系检索 → Rerank → 带引用的上下文。
模型可按节点替换，用户可编辑 DAG，运行记录保留各节点输入输出摘要、模型及失败原因。
数据库继续作为事务真源，Markdown 是可读镜像和版本化文档；不能让两个写入者静默覆盖。

## 研究对应表（2026-10-19）

这些是架构借鉴和本项目实现的功能映射，不声称把上游完整产品、权重或代码全部嵌入。
不因参考项目的性能宣传而宣称本项目已达到其基准。已有 vendored 脑图保留原许可。

| 原始资料 | 采用的机制 / 本地落点 |
| --- | --- |
| [Basic Memory](https://docs.basicmemory.com/reference/technical-information) | 可读 Markdown、SQLite 检索、显式关系、MCP；统一检索保留来源引用 |
| [MCP Memory Service](https://github.com/doobidoo/mcp-memory-service) | 混合检索、可审计沉淀、后台任务；统一搜索及工作流运行轨迹 |
| [DSH Memory](https://github.com/haitang1/dsh-memory) | 会话开始恢复、结束吸收、作用域和版本；接入配置及生命周期说明 |
| [DSH ENGRAM](https://github.com/kenz1117/dsh-engram) | 稀疏回忆、按需上下文与独立证据；检索后核验、复习与学习路径模板 |
| [ENGRAM](https://github.com/Gentleman-Programming/engram), [raya-ac/engram](https://github.com/raya-ac/engram) | SQLite / FTS5、会话续接、可质疑与被替代的记忆；会话复盘、显式关系扩展和来源信任区分 |
| [Hy-Memory](https://github.com/Tencent-Hunyuan/Hy-Memory) | 快速记录 / 慢速提炼分离，事实与可复用经验分层；会话、学习、经验模板 |
| [SynaBun](https://github.com/danilokhury/Synabun) | SQLite 记忆与二维/三维知识浏览；关系图检索和布局 |
| [Microsoft Memora](https://github.com/microsoft/Memora), [论文](https://arxiv.org/abs/2602.03315) | 原始细节与抽象 / cue 分离；带来源的抽象与检索线索模板 |
| [MemoRAG](https://github.com/qhjqhj00/MemoRAG), [论文](https://arxiv.org/abs/2409.05591) | 全局记忆线索辅助检索；先召回后重排、摘要保留证据，未引入专用长上下文权重 |
| [AI Coding Dictionary](https://www.aicodingdictionary.com/) | 保留移植渲染组件；分类簇、球体、聚焦邻居、标签避让；不把空间距离当关系 |
| [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) | 绝对解释器、cwd、数据目录的 stdio 配置；工具协商证明连接，心跳证明在场 |

## 验收要求

- 无模型也可全文检索；Embedding 故障降级必须可见，Rerank 可以单独作用于全文结果。
- 一个入口搜索已审核记忆、已发布文档块、归档会话，来源类型和信任状态必须区分。
- 证据包有随机边界、预算、引用、遗漏清单；原始会话不是已审核记忆。
- Embedding / Rerank 调用对应接口，禁止把所有节点当聊天 completion 调用。
- DAG 分支只读取祖先输出；并行分支不会相互污染。核验不通过不得保存成功草稿。
- 提炼必须提供原文精确引文；未审核候选不能自动进入已批准检索。
- Codex 与 DSH 的配置可复制且绑定当前开发数据；配置生成不等于已连接。
- 所有回归验证使用临时测试数据，桌面成品不随开发升级自动更新。
