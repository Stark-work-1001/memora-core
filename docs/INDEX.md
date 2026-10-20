# 文档索引

| 文档 | 读者 | 内容 |
|---|---|---|
| [README.md](../README.md) | 用户 | 产品是什么、有什么、怎么开始 |
| [AGENTS.md](../AGENTS.md) | 智能体 | 接入手册：三种方式、最小配置、工具速查、降级行为 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 开发者 | 冻结契约：目录、表结构、模块签名、HTTP 路由、MCP 工具面、降级矩阵 |
| [MEMORY-MODEL.md](MEMORY-MODEL.md) | 设计者/开发者 | 什么算一条记忆：六层作用域、十种类型、八类证据、十四种关系、状态机、判定七动作 |
| [API.md](API.md) | 集成方 | REST + SSE + MCP 的字段级参考 |
| [OPERATIONS.md](OPERATIONS.md) | 运维/用户 | 启动、备份、索引维护、故障排查、隐私 |
| [THIRD-PARTY.md](THIRD-PARTY.md) | 合规 | 依赖与借鉴来源 |
| [research/R1-repos.md](research/R1-repos.md) | 研究者 | 开源记忆系统仓库横评与批判 |
| [research/R2-papers.md](research/R2-papers.md) | 研究者 | 记忆算法与论文精读（21 篇 / 60 个可执行公式块） |
| [research/R3-viz-protocols.md](research/R3-viz-protocols.md) | 研究者 | 2D/3D 脑图选型与智能体协议细节 |

## 交付物位置

- **发布包（解压即用）**：`release/memora-core-1.1.0-windows-x64.zip`
  —— 内含 `MemoraCore/MemoraCore.exe`（桌面程序）与 `memora-backend.exe`（后端可执行；1.1.0 起标为弃用的副本，1.2.0 移除，见 ADR-0005）
- 源码包：`release/memora-core-1.1.0-source.zip`
- 本地构建产物：`dist/MemoraCore/MemoraCore.exe`、`dist/memora-backend.exe`
  （运行 `python tools/build_desktop.py` 生成，仓库不预置）
- 验收报告：`reports/VERIFY.json`（运行 `python tools/verify.py` 生成）
- 演示数据：运行 `python tools/seed_demo.py --data data/demo` 生成，
  内容为合成示例，不含任何真实个人信息
