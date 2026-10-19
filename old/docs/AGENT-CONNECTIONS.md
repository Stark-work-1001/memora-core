# 开发版智能体接入

开发数据目录与 standalone 数据目录独立。开发入口 `Start-Memora.cmd` / `start-memora.ps1`
现在打开源码桌面壳；没有 Electron 时打开开发服务页面。不会修复、更新或启动兄弟目录的桌面成品。
托管后端会比较源码指纹，避免同一个版本号复用旧 Python 实现。

## 配置与验证

1. 启动开发版，进入「智能体接入」。通用 MCP JSON、Codex TOML、DSH patch 均从当前进程生成。
   解释器、工作目录、`--data` 是绝对路径。CLI 也可输出：`.venv/Scripts/python.exe -m memora setup`。
   Windows 的 TEMP/TMP 指向该库下的 `.tmp`；直接 MCP / CLI 启动也会先创建它，避免冻结后端
   连接时 SQLite 在不同盘临时目录失败。
2. 将 Codex TOML 合并到宿主的 `config.toml`，或将通用 JSON 合并到对应 MCP 配置。
   不覆盖已有其它服务器。重新加载 MCP 后先调用 `memory_status`，核对 `data_dir` 为开发数据目录。
3. 调用 `memory_knowledge_context(project, query)`，检查引用和实际检索模式；没有模型仍能全文检索。
4. 需要在线状态时，由宿主每 30 秒调用 `memory_peer_heartbeat`。MCP 配置生成、服务器握手、
   智能体心跳是三件不同的事。没有心跳的 Codex 工具连接仍可使用，不应伪造在线状态。

Codex 字段按 [官方 MCP 文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) 校对。
MCP 允许工具调用，不保证 Codex 自动调用任何特定工具，也不保证自动执行会话结束钩子。
推荐在宿主的项目说明中明确：任务开始检索相关证据，结束用稳定 event_id 调用 `memory_absorb`。
不把回忆注入文本再次当作新的用户事实归档。

## DeepSeek Harness 生命周期

生成的 DSH patch 包含 `@deepseek-ai/dsh-mcp-client` 与源码生命周期插件。
MCP 工具连接用 stdio；生命周期用同一数据目录的 HTTP MCP（默认 18184，Bearer 来自该库的
`mcp-token`）。配置输出中的 `gateway_command` 给出准确启动参数。使用非默认数据目录时需要
按该命令启动，不能借用另一份库的 18184 服务。

适配器支持新版 `sessionQuery.observeSession`、`snapshotEvents` 和旧版 `eventAt`；释放 observation
lease，并排除注入上下文、思考块和工具私有内容。`agent/turn-stopping` 与 idle 都能触发持久 outbox，
稳定 seq / event_id 避免重复。捕获完成后才推进游标，服务不可达时保留 outbox 重试。

默认尝试从宿主依赖解析 `@deepseek-ai/dsh-llm`；独立源码插件如无法解析，可显式配置 `llmModule`
为宿主对应模块。消息适配失败只关闭自动注入，仍注册捕获和心跳，并输出明确诊断。

本次未更改运行中宿主的配置、未重新加载用户的 Codex / DSH，也未向 standalone 发送写探针。
旧的 DSH presence 文档记录了以 standalone 为目标的历史操作；本次开发验收不要运行那些写探针。

## 工作流与模型

「工作流可视化」可从 8 个模板载入可编辑 DAG：会话沉淀、学习笔记、外部文档、混合重排、
冲突审计、项目复盘、抽象线索、增量索引。模板缺模型会明确提示；可为每个节点选择同能力模型。

Embedding 节点索引已审核记忆和已发布文档，不将草稿偷偷加入检索。
Rerank 节点读取上游召回结果；生成节点保留来源、核验轨迹和草稿版本。
提炼候选必须携带原文精确引文，并进入待审队列。核验失败不生成成功草稿。
同名模型的自核验不能满足自动沉淀的独立核验条件；绑定不同模型仍不等于证明训练来源独立。
