# Memora 1.1.0：实施记录与调研判断

本次在现有项目内继续迭代，保留数据库、Markdown、脑图和历史组件。默认运行时重新包含有界的模型工作流和自动积累，但不启动第二套通用智能体聊天／任意任务派发系统。

## 参考与实际复用的区别

| 资料 | 阅读或检查的部分 | 本次采用与边界 |
|---|---|---|
| [agentic-box/memora](https://github.com/agentic-box/memora)，本地 0.5.5 压缩包 | README、absorb_profile、session_guard、db_routing、write_gate、hierarchy | 采用会话守卫、写入门和吸收流水线的设计思路；未安装同名 memora-mcp 包，未把其数据库混入当前 schema |
| 本地 DSH memory / 灵枢 0.8.1 | 历次路由与来源设计记录、参考包元数据 | “灵枢”是项目名，不能代替语义协议的形式定义。这里用明确的 project、source、event、relation 和 model contract；不绑定其营销命名或专有协议 |
| [Engram MCP](https://github.com/edg-l/engram-mcp) 与本地 Rust 参考包 | 本地 Cargo.toml、README 与模块边界 | 参考原生检索／模块化思路。Cargo 元数据为 MIT，历史清单存在许可差异，复制前仍需核对 LICENSE；本次未复制实现 |
| [Shodh Memory](https://github.com/varun29ankuS/shodh-memory)、[SynaBun](https://github.com/danilokhury/Synabun) | 本地参考包与已有研究清单 | 记忆生命周期和工具边界的研究参考；非当前运行依赖 |
| [Basic Memory](https://github.com/basicmachines-co/basic-memory) | 既有 Markdown / 图关系研究 | 设计参考；强 copyleft 实现不直接并入 Apache 核心 |
| [Qwen3 Embedding](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B) | 官方模型卡和 last-token 示例 | 实际部署官方 safetensors；左 padding、最后有效 token、L2 归一化；查询指令只用于 query |
| [llama.cpp server](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md) | 官方服务器参数、OpenAI 兼容接口 | 实际构建 b11695，CUDA 13.0 / sm_120；GGUF 模型权重外置 |
| 用户提供的 MIT 双脑图及 [AI Coding Dictionary](https://www.aicodingdictionary.com/) | 既有复制源码和交互方案 | 保留 2D/3D、相机聚焦、雾化、层级流动、布局；使用记忆库投影，不带入参考网站的词典内容 |

以上链接与历史完整清单保留在两份 README。参考目录未修改。除部署的官方依赖和已继承的 MIT 脑图外，不声称以上项目都被复制进本程序。历史链接／许可来自既有清单，不等于逐项重新核验；新增研究依据以本地包和官方文档为准。

## 模块落地

- `core.py` 是组合根，延迟加载存储、文档、角色、队列和工作流。
- `accumulation.py` 把归档、精确引句提炼、Judge、核验、语义比较和沉淀组合起来；每段最多 6,000 字符、每段最多 8 个候选。没有把超长会话尾部悄悄丢掉；边界分段仍可能损失跨段语义，这是后续改进点。
- `jobs.py` 使用独立 SQLite 表进行唯一事件判定、原子认领、180 秒租约和 30 秒续租。最多五次自动尝试；手工重试保留候选 ID 和已缓存提炼结果。
- `model_registry.py` 管理补充生成角色；Embedding / Judge 基础连接仍只有一个配置入口，避免同一角色出现两套冲突设置。
- `workflows.py` 对不可变文档输入依次执行模型阶段，保留输入版本、日期、输出散列、模型标识和草稿来源。模型配置在运行开始时快照，后续编辑不会偷换当前阶段模型。
- `mcp.py` 提供 20 个默认工具和已发布文档资源；`gateway.py` 把相同运行时挂到仅回环的 Bearer HTTP 传输。标准输入输出协议仍可独立运行。
- DSH 插件只使用官方生命周期事件和 MCP，过滤工具输出／思考内容／注入上下文，真实用户与助手文本才归档；持久发件箱与游标保证重试身份稳定。不同项目／发件箱有不同 peer ID。

## 分类、层级与关系

六个基础类别解决记忆用途；领域、资源类型和学习层级解决组织方式；`supports` / `contradicts` / `related` 等解决有证据的语义关系；`part_of` / `prerequisite` / `sequence` 等表达结构或学习路径。它们不应压成一个巨大的枚举，更不该用图的物理距离代替关系。

检索先限定 project 是访问范围和相关性控制。学科是可选过滤维度；过早建立互相隔离的学科数据库会降低跨学科召回。现有精确向量扫描 + FTS5 + RRF 可直接沿用。更大规模需用真实数据评估 ANN、分片和召回质量，不能只凭 Rust 名称推断性能。

## 自动积累的实际边界

自动政策属于本地操作者设置，不允许普通捕获请求自行开启。模型结构有效不等于内容正确：精确引句、用户来源、核验、风险与冲突检查共同限制自动沉淀。用户明确“请记住”能保留低分的有效请求，但不能绕过其他检查。助手承诺／猜测留待审；重复和冲突记录保留原文档，不自动删除旧知识。

2B 模型实测出现过无工具依据的建议，未执行其推荐命令。核验仍然由同一个小模型复用时，不能视为独立模型的强证明；重要知识应由人工或更强的独立 verifier 复核。云端开关仅解决传输授权，不消除错误风险。

自动积累队列支持中断恢复；文档工作流记录持久化、执行线程不持久化，进程异常后需要重新发起。默认没有跨服务器任务派发、任意 SQL 执行、自主规划 router 或所有宿主的自动历史抓取。本次专门完成当前 DSH 对象的实际适配。

## 执行计划与完成情况

已完成：参考检查、数据连续性、模块化积累／编排、真实模型 CUDA 部署、DSH 两会话验证、界面和回归检查、单一桌面构建。旧默认 1.0.2 文档在 `docs/history/1.0.2/`。测试证据见 `VALIDATION-1.1.0.md`；操作步骤见 [`docs/history/1.1.0/OPERATIONS.md`](history/1.1.0/OPERATIONS.md)。

后续扩展插槽：独立更强 verifier、学习层级分类器、文档重构模型、只读 SQL 分析模型、自主路由模型，以及更多宿主生命周期插件。当前 10 个角色不代表部署了 10 个模型。
