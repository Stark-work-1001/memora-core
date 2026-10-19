# memora 1.0.2 重构记录

本次在已经展开的现有项目根目录中继续开发。不创建旧工作区，不重建 public / release 目录，不做自用 / 发布功能分叉，不上传 GitHub。

## 最终边界

默认应用只有一个记忆生命周期：智能体 MCP 接入 → 接收和去重 → Judge / 规则分类 → 保存类别和去向 → 用户确认沉淀 → Rust 向量 / SQLite 词法检索。Markdown 文档管理和语义 / 层级脑图继续保留在默认桌面中。

接入智能体拥有推理与调度。Embedding 只负责编码；Judge 给出经过严格结构校验的类别、持久性、重要性和风险建议；运行时把这些建议映射到分类、transient 或 review。类别是原有的事实、知识、决策、偏好、步骤、经验六类；持久性和风险是独立字段，不再扩张一套分类模型系统。

分类真实保存至数据库，含审计和重试信息。模型异常时保留候选；确认沉淀后向量失败会报告 pending_retry，可补建索引。无向量模型时明确退化为关键词检索。程序不将模型判定自动视为用户批准。

## 代码与目录

| 调整 | 结果 |
|---|---|
| 主实现命名空间 | `memory_merge/` 实现吸收进入 `memora/`；原路径仅保留模块身份一致的薄兼容别名 |
| 默认入口 | `memora` / `python -m memora` / `memora-mcp`，默认启动精简工作台 |
| 核心模块 | `memora/core.py` 统一生命周期，`service.py` 复用检索，`mcp.py` 提供 11 项默认工具 |
| 模型配置 | 两个角色，环境变量或 `memora.json`；本地 / 云端分别配置，API 密钥不写入配置文件 |
| 跨进程更新 | MCP / UI 在下次请求时检查配置时间戳并刷新，避免独立宿主仍用旧绑定 |
| 文档与脑图 | `documents.py` 延续原实现；`projections.py` 从原 Agent 提取共享投影，不依赖聊天或工作流启动 |
| Rust 模块 | `memora_native` / `memora-native` 1.0.2，保留原算法与安全边界 |
| 构建 | 新的白名单 staging，仅含 22 个应用模块、精简界面与原脑图资源；单一输出至 dist |
| 历史工具 | 旧的分 public / release 发布脚本与生成旧文档脚本存入 `tools/legacy/`，不再作为当前入口 |
| 扩展组件 | 聊天、工作流、本地档案、组织协调和桥接源码保留；源码扩展入口可继续访问 |

## 数据兼容

不更改已发布的 SQLite schema v2。记忆 ID、时间、状态、来源、向量指纹、日期、Markdown 历史和显式关系继续使用原数据。新增分类去向保存在现有 meta 中，不增加数据库迁移。文档和协调侧库按需使用，仍兼容原文件。

旧的 `MM_*` 配置继续作为回退；`MEMORA_*` 优先。旧默认数据目录有数据库时保留识别；桌面保持原 Electron 用户目录。旧命令 / 导入仍可用，新默认构建不打入兼容包。

schema 触发器名、分词器 ID、模型 canary 校验文本属于已有数据协议，不能为了清除历史名称而改写。许可、NOTICE、出处引用继续保留 Memory Merge 等项目名称，这是授权追溯而非运行依赖。没有复制参考站点词典数据。

## 构建与验证

当前命令：`tools/build_desktop.py` → `tools/smoke_desktop.py` → `tools/release.py --skip-build`。desktop 输出在 `desktop-standalone/`，后端在 `build/dist/memora-backend`。本次的单一 ZIP 位于 `release/`，构建内容清单为 `BUILD_MANIFEST.json`。（路径已按 2026-10-18 的目录重构更新；本文记录的是 1.0.2 当时的行为。）旧版本归档不代表当前还有两种功能版本。

自动验证包含：原有存储 / 迁移 / 检索 / 扩展组件回归、新核心分类沉淀和向量回查、失败与重试、MCP 审核边界、文档版本日期、跨进程配置、旧导入模块身份、HTTP 同源与 token 防护、实际 MCP stdio 往返、冻结后端、桌面启动及脑图加载。详细结果写入 `build/reports/SMOKE_VALIDATION.json`，界面验证写入 `artifacts/ui-1.0.2/report.json`。

真实本地 / 云端模型需要用户配置，测试模型只验证协议和流程，不冒充真实模型服务。未实测新的端到端提速；减少默认执行组件并不意味着 Electron 基础运行时消失。

原 1.0.1 README / 使用说明保留于 `docs/history/1.0.1`；参考清单继续完整保存在当前中英文 README、`docs/REFERENCES.md` 与 `THIRD_PARTY_NOTICES.md`。
