# memora 1.0.2 · 桌面使用说明

这是统一功能的精简桌面程序，不再分自用版和发布版。源码介绍见 README，本文件只说明使用、升级和边界。

1. 解压 `memora-1.0.2-windows-x64.zip` 到可写目录，运行 `Memora.exe`。开发目录中可直接运行 `dist/desktop/win-unpacked/Memora.exe`。
2. 无需另装 Python、Node 或 Rust。向量 / 判定模型服务仍需你配置；不包含模型权重。首次没有向量模型时显示关键词检索，没有 Judge 时显示规则分类。
3. 数据保存在原 Electron 用户数据目录下的 `memory`；也可启动前设置 `MEMORA_DATA` 指向已有记忆目录。升级前关闭旧程序，备份整个数据目录，包括三个 SQLite 文件、文档镜像和配置。
4. 在“模型连接”配置 Embedding / Judge，在“智能体接入”复制 MCP 配置。密钥通过环境变量提供；已保存的模型配置在各 MCP 进程下次调用时更新。
5. “分类与沉淀”添加或确认记忆，“Markdown 文档”维护日期和版本，“脑图”切换语义 / 层级与二维 / 三维。保存文档、发布文档、审核记忆是不同步骤。

保留 schema v2、记忆 ID、日期、向量指纹和既有文档版本。旧工作流、聊天、档案扫描、HTTP 桥接组件仍在源码扩展入口，精简桌面不包含这些执行功能。无真实模型端到端连通验证时，不声称已连接模型。

构建记录在包内 `resources/backend/BUILD_MANIFEST.json`，构建验证在开发目录 `dist/SMOKE_VALIDATION.json`，详细改动在 `docs/REFACTOR-1.0.2.md` 和 `CHANGELOG.md`。本次只本地交付，没有上传 GitHub。
