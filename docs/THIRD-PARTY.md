# 第三方组件与借鉴来源

本项目**后端只使用 Python 标准库**（http.server / sqlite3 / urllib / json / hashlib / hmac /
zlib / html.parser / concurrent.futures / ctypes），没有运行时第三方依赖。

## 运行时依赖

| 组件 | 版本 | 许可 | 用途 |
|---|---|---|---|
| Python | 3.12 | PSF | 后端运行时 |
| SQLite (bundled) | 3.4x | Public Domain | 事务真源 + FTS5 全文索引 |
| Electron | 44.7.2 | MIT | 桌面外壳 |
| three.js | 0.160.1 | MIT | 脑图渲染 |
| KaTeX | 0.16.47 | MIT | 公式渲染 |
| esbuild | 0.25.12 | MIT | 前端打包（构建期） |
| PyInstaller | 6.22.3 | GPL-2.0 with exception | 后端打包（构建期，产物不受 GPL 约束） |

## 设计与算法来源（借鉴机制，未嵌入其代码）

| 来源 | 借鉴的机制 | 本项目落点 |
|---|---|---|
| MemGPT (arXiv 2310.08560) | core / archival / recall 三层记忆与分页 | 作用域分层 + digest 预算打包 |
| Generative Agents (2304.03442) | recency / importance / relevance 三元打分 | retrieval 排序权重 |
| Mem0 (2504.19413) | ADD/UPDATE/DELETE/NOOP 的更新决策 | 判定七动作（扩展为 add/update/merge/supersede/link/noop/ask） |
| A-MEM (2502.12110) | Zettelkasten 式动态链接 | edge 表 + 自动 link 动作 |
| MemoryOS (2506.06326) | 分层存储与热度迁移 | 衰减归档工作流 |
| Graphiti / Zep | 双时序（valid_from/valid_to + recorded_at） | memory 与 edge 的双时间字段 |
| HippoRAG | 个性化 PageRank 检索 | graph 召回通道 |
| MemoRAG (2409.05591) | 全局线索 + 检索后重排 | cue 抽象工作流 + rerank 节点 |
| RAPTOR (2401.18059) | 递归摘要树 | 算法目录登记（未启用） |
| mcp-memory-service | 混合检索、可审计沉淀 | 混合召回与冲突审计工作流 |
| Basic Memory | Markdown 为可读层 + SQLite 索引 | vault 镜像 + document/chunk 表 |
| SynaBun | 2D/3D 知识浏览 | 四种脑图视图 |
| Microsoft Memora | 细节与抽象线索分离 | 细节与抽象线索工作流 |
| Hy-Memory | 快慢双通道 | quick-capture 与 session-distill 分离 |

## 许可

本项目 **MIT**。上述借鉴均为**机制层面**的实现，未复制其源码；
若未来引入其代码，需在此处补充对应许可证全文。

## 引用纪律（调研文档）

[docs/research/](research/) 三份调研报告在写作时遵守以下纪律，以便可以随仓库公开：

| 纪律 | 做法 |
|---|---|
| 只引可合法使用的素材 | 引用限于 MIT / Apache-2.0 / BSD 等许可项目的**事实性接口信息**（表、字段、函数、参数、约束），并注明「仓库 URL + 文件路径 + 行号」 |
| 无许可条目只记设计取向 | 对**未选择开源许可**或**限制商用**的项目，只记录其设计取向与批判结论，**不复制源码、DDL、常量与注释原文** |
| 学术素材标注来源 | 论文引用区分〔论文〕/〔本项目设定〕/〔未核实〕，公式与结论均可追至 arXiv 编号 |
| 公开协议只引规范字段 | MCP 等开放协议只引用方法名、字段名与帧格式规则，不整段复制规范正文 |

运行时依赖均不改动其原始许可；打包期工具（PyInstaller）的许可不影响本项目代码的 MIT 授权。
