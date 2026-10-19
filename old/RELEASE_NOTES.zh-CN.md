# memora 1.3.0 · 桌面使用说明

这是统一功能的 Windows x64 桌面程序。仓库介绍见 README；本文件说明本地交付、启动和升级。本次没有上传 GitHub。

1. **解压即用。** 把 `memora-1.3.0-windows-x64.zip` 解压到任意可写目录，推荐运行 **Launch-Memora.cmd**（或 `Launch-Memora.ps1`）；正常桌面环境也可直接双击 `Memora.exe`。Python、Node、Rust 均无需另装。
2. **数据就在包内。** 解压目录下的 `data/` 是这套安装自己的存储：`memory.sqlite3`（已建好 schema v2 的空库）、`markdown/`（Markdown 文档与镜像目录）、`memora.json`（内容为 `{}` 的模板，不含任何密钥）。首次启动不写 `%APPDATA%`，整套目录可以整体搬移。
3. **模型需要自己连。** 模型权重、CUDA 和推理服务不在 ZIP 内。启动后在“模型连接”里填写你自己的本地或云端 API：Embedding 必需，Judge 与 Rerank 可选；不配置也不影响启动和浏览，只是召回退化为词法检索。
4. **当前机器推荐入口：项目根目录 `Start-Memora.cmd`。** 它启动已配置的模型、共享后端和当前桌面，数据集中在项目 `data/`。浏览器也可访问 `http://127.0.0.1:8765`。
5. **功能入口。**“智能体接入”提供 MCP 配置和心跳状态；“模型连接”管理 Embedding / Judge / Rerank；“工作流与模型编排”编辑其他角色、顺序阶段、自动沉淀政策和重试任务；“分类与沉淀”审核记忆；“Markdown 文档”保留日期和多版本；“脑图”保留语义／层级、2D／3D 与相机聚焦。工作流生成新草稿，不自动发布文档。

## 1.3.0 变化

- 桌面 ZIP 自带 `data/`（空库 + `markdown/` + 空模板配置），解压即用，不再把状态散落到用户目录。
- 新增可选的 Rerank 第二级检索：把 `rerank` 作为与 embedding / judge 并列的模型角色配置；只对首阶段候选列表的头部重排，文档先截断再外发；未配置或调用失败时保持原排序并在响应里写明 `warning`，不编造分数。
- 模型凭据可按角色写入 `memora.json`（仅本人可读），也可沿用 `key_env` 指定的环境变量；所有读取路径只返回 `key_set` 布尔值，不返回值；清除是显式动作，留空保存不会误删已存密钥。
- 分发前脱敏：清除了随包文档里的本地绝对路径与机器标识，`tools/release.py` 在内置闸门里拒绝任何形似密钥或主机特征残留，并把检查项记录进 `release/BUILD_DELIVERY.json`。
- 本地数据合并：旧的独立存储（7 条记忆，其中 4 条为真实知识）已并入项目 `data/`，并重建了派生状态，因此这 4 条既可被全文检索命中，也有对应的 Markdown 镜像；退役的完整性基线与清空后的旧库归档在 `artifacts/legacy-memory-20261017/`，没有就地删除。

## 升级与备份

移动／升级前关闭所有写入进程，备份整个 `data/` 目录：四个 SQLite、`markdown/`、`memora.json`、令牌和发件箱。可通过环境变量 `MEMORA_DATA` 指向已有数据目录以复用旧数据。

## 验证与边界

真实本地模型与冻结包 smoke 分开记录，不把合成 fixture 写成模型实测。`resources/backend/BUILD_MANIFEST.json` 是构建清单；开发目录 `build/reports/SMOKE_VALIDATION.json` 是 smoke 结果；`release/BUILD_DELIVERY.json` 和 ZIP 旁 `.sha256` 是交付校验。完整改动见 `CHANGELOG.md`，包内文档副本位于 `resources/backend/docs/`。应用 1.3.0 与原生内核 1.0.2 独立版本化。

小模型可能判断错误，重要知识仍建议复核；DAG 执行仍是单工作线程的有序执行，不是并行调度。

## Windows 启动与完整性标签

程序和 DLL 若继承 Low 完整性标签会导致 Electron 过早退出。构建和启动器只把程序文件修正为 Medium，保留 DACL 和数据目录。ZIP 解压到继承 Low 的目录时，先运行 `Launch-Memora.cmd` 或 `Repair-Desktop.cmd`，随后可直接打开 `Memora.exe`，无需关闭沙箱。
