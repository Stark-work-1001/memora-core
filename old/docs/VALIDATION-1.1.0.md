# Memora 1.1.0：验证记录

验证使用合成数据和 `validation` / `dsh-validation` / 独立 `dsh-check-*` 项目范围，不扫描用户全部历史，不调用云端凭据。验证数据保留在本地便于复核，不进入桌面 ZIP。

| 检查 | 证据与说明 |
|---|---|
| Python 全量回归 | 161 项：159 通过、2 条件跳过，0 失败／错误。`artifacts/validation-1.1.0/unit.json`、`unit.log`，由 `tools/run_checks.py` 生成；包含存储兼容、路由、队列、跨进程认领、精确引句、冲突、核验和预算测试 |
| DSH 插件过滤 | `node --test integrations/dsh/memora-plugin.test.mjs`，真实用户／助手文本、事件序号和日期 |
| 前端图算法 | `npm --prefix frontend test`，6 项；图资源已重建 |
| 工作台 UI | `artifacts/ui-1.1.0/report.json` 与截图，Electron 实际渲染检索、待审、文档版本／日期、云端选项、编排和双脑图 |
| 本地真实模型 | `deployment/model-manifest.json`；1024 维向量与结构化 Judge，实际 CUDA；健康检查与真实推理区分 |
| DSH 跨会话自动记忆 | `artifacts/dsh-profile-test/validation.json`，真实官方 `sdk-minimal` profile、本地 Qwen，A 的用户陈述进入队列，B 自动注入来源记忆并正确回答 |
| 实际文档工作流 | 本地 `validation` 项目的运行记录包含模型、输入／输出散列；摘要内容不变时不凭空生成新版本，草稿生成另有单元验证 |
| 冻结后端 / 桌面 | `build/reports/SMOKE_VALIDATION.json`，临时合成数据、移除外部语言运行时 PATH、MCP 20 工具、真实 Rust 内核、SQLite v2、Markdown 日期版本、启动和字节码路径扫描 |
| ZIP | `release/BUILD_DELIVERY.json` 与 `.sha256`，要求当前后端散列与通过的 smoke 一致；检查不夹带运行数据库／配置，ZIP CRC 校验 |

完整回归有两项条件跳过：Windows 当前权限不支持符号链接测试；可选 pypdf 未安装。PDF 不在本次核心交付范围。一次早期回归出现临时任务失败，保留日志，定向重复和后续全量检查复核；以最终 `unit.json` 为准，不删除失败证据。

本次验证不构成长期负载、所有云厂商兼容、所有智能体宿主、百万级向量规模或模型事实准确率的认证。2B 模型会产生不可靠输出，已加入来源和助手陈述检查，但仍需按用途保留人工审核。MCP 心跳在线是传输／自报状态，不代表宿主所有业务流程都已验证。

桌面启动问题已定位为封装目录继承 Low 强制完整性标签，修正整个程序与运行库为 Medium 后，默认沙箱启动成功。此前关闭沙箱的验证仅作历史诊断；最终 smoke 不再允许该回退，发布门槛要求默认启动退出码 0，并独立检查 Windows 标签。修复范围及对照实验见 [桌面启动修复](DESKTOP-STARTUP-FIX-1.1.0.md)。
