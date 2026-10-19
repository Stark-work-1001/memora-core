# Memora 1.1.0：任务完成简报

开发和运行继续位于 `<项目根>`，未重建旧工作区。应用是统一功能版本；未新建 public / release 双轨目录，未上传 GitHub。交付位于当前项目 `dist/`。

## 使用入口

- 根目录 `Start-Memora.cmd`：启动模型、共享记忆后端和当前桌面；默认选择 `dsh` 项目，可通过 PowerShell `-Project` 更改。
- 浏览器工作台：`http://127.0.0.1:8765/?project=dsh`。
- MCP：stdio 或 `http://127.0.0.1:18184/mcp`；HTTP 令牌由本地文件读取，文档不公开令牌值。
- 冻结程序：`desktop-standalone/Memora.exe`；ZIP 内推荐运行 `Launch-Memora.cmd`，它包含桌面失败时的 Web 回退。同一程序的 ZIP 为 `release/memora-1.1.0-windows-x64.zip`，校验见 `release/BUILD_DELIVERY.json` 和 `.sha256`。

## 已实际启用

Qwen3-Embedding-0.6B：1024 维编码。Qwen3.8 2B Q4_K_M：Judge，并复用于提炼、核验和语义比较。两者运行在 Rocky WSL CUDA，权重仍在 `<模型目录>`。安装的是 Memora 独立推理环境，没有修改其他应用的 Python 环境。GGUF 的蒸馏来源未核实。

已实现有来源的会话吸收、SQL／带日期 Markdown 归档、稳定事件去重、持久租约任务、模型提炼、Judge 路由、来源核验、重复／冲突处理、政策控制的自动沉淀、Rust 向量召回，以及可编辑模型池和文档工作流。Markdown 原日期、多用途版本、双脑图和 2D／3D 能力保留。数据库沿用原记忆 schema v2；队列使用独立 sidecar，不迁入参考项目数据库。

## 验证结果

Python 161 项：159 通过、2 条件跳过；前端图算法 6 项通过；DSH 插件过滤 1 项通过。四个 SQLite quick_check 均为 ok。UI 验证包含文档版本／日期、检索、云端选项、模型协议保留、已有工作流编辑和双脑图。

真实 DSH 官方 `sdk-minimal` profile 两会话验证通过：A 的陈述自动积累，B 自动获得召回证据并正确回答。测试仅用本地 Qwen，没有云端凭据。冻结后端检查另用合成模型 fixture，覆盖 20 MCP 工具、持久吸收／核验／索引、Bearer HTTP、文档日期和原生内核。完整证据与范围见 `VALIDATION-1.1.0.md`。

已修复封装目录继承 Low 完整性标签导致的 `0x80000003` 启动崩溃；整个程序与运行库改为 Medium 后默认沙箱验证成功。构建及启动器加入限定程序目录的修复，数据目录保持原样。最新 smoke 要求默认启动退出码 0，不接受关闭沙箱的替代结果。详见 [启动修复记录](../../DESKTOP-STARTUP-FIX-1.1.0.md)。

## 用户需要知道

1. 当前只有两个真实模型，多个轻量角色复用 Judge；其他角色留有模型绑定／工作流插槽。router 尚未实现自主规划，工作流按用户声明顺序执行。
2. 2B 模型可能误判或虚构。已限制助手单方面陈述自动沉淀、要求精确引句和来源核验；重要记忆建议人工或独立更强 verifier 审核。判断冲突时保守留待审，不自动覆盖旧知识。
3. DSH desktop profile 已安装 Memora 管理块并保留备份。旧 stdio 子进程已通过官方重连机制换成当前后端。更新的生命周期模块路径在 DSH 下次重载 profile／正常重启后生效；本次没有中断整个 DSH。最新插件已在隔离真实 profile 中验证。
4. 自动积累队列可恢复；文档工作流进程中断需要重新运行。其他智能体可按 MCP 接入，尚未逐个测试所有软件，也未导入所有本地历史。
5. ZIP 不包含私人数据库、凭据、模型权重和 GPU 依赖。当前工作目录本身包含运行数据，不应整目录直接发布。完整备份需暂停所有写入后复制整个 data，不能只备份一个数据库。

## 文档

仓库介绍：根目录中英文 README；架构预览：`docs/ARCHITECTURE-1.1.0.svg.html`；技术与调研：`docs/IMPLEMENTATION-1.1.0.md`；运行维护：`docs/OPERATIONS-1.1.0.md`；变化：`CHANGELOG.md`；ZIP 使用说明：中英文 RELEASE_NOTES。参考项目、开源方案和实际依赖链接已保留／补入 README 与 `docs/DEPENDENCIES.md`。
