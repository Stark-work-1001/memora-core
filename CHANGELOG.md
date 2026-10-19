# Changelog

本文件记录 memora-core 的版本变化。 / This file records the notable changes of memora-core.

## [1.0.0] — 首个公开发布版 / First public release

### 新增 / Added

- **记忆模型**：六层作用域、十种记忆类型、八类证据、八种富形式，候选 / 已审核 / 历史版本分层。
  *Memory model: six scopes, ten memory types, eight evidence kinds, eight rich forms, with
  candidate / approved / history layers.*
- **18 条内置记忆工作流**，每条可查看 DAG、节点参数、运行记录与逐步输入输出。
  *18 built-in memory workflows, each with an inspectable DAG, parameters, run history and per-step I/O.*
- **混合检索**：BM25（FTS5 + 中文按字二元兜底）+ 向量 + 实体图 → RRF 融合 → cross-encoder
  重排 → MMR 去冗余 → token 预算打包；通道缺失时显式降级。
  *Hybrid retrieval: BM25 (FTS5 + CJK bigram fallback) + vectors + entity graph → RRF fusion →
  cross-encoder rerank → MMR de-duplication → token-budget packing, with explicit degradation.*
- **四种脑图**：语义、层级、时间线、证据视图，含相机平滑转场、标签避让、LOD、路径查找与导出 PNG。
  *Four brain graphs: semantic, hierarchical, timeline and evidence views.*
- **多协议接入**：MCP stdio / MCP HTTP / REST + SSE / 心跳文件 / 本地会话目录扫描。
  *Multi-protocol access: MCP stdio, MCP HTTP, REST + SSE, heartbeat files, session scanning.*
- **模型接入**：chat / embedding / reranker / judge 四角色，支持 OpenAI 兼容端点、DashScope、Ollama。
  *Model access: chat / embedding / reranker / judge roles over OpenAI-compatible, DashScope and Ollama endpoints.*
- **桌面版**：Electron 外壳 + PyInstaller 单文件后端，解压即用，无需安装 Python。
  *Desktop build: Electron shell + single-file PyInstaller backend, runnable straight after unzipping.*

### 安全 / Security

- 发布前完成脱敏处理：移除本机绝对路径，演示数据中的个人偏好与项目名替换为合成示例，
  测试中的局域网地址改为 RFC 5737 文档保留地址，运行期数据目录不随仓库分发。
  *Desensitization before release: local absolute paths removed, personal preferences and project
  names in the demo seed replaced with synthetic samples, a real LAN address replaced with the
  RFC 5737 documentation range, runtime data directory not distributed.*

[1.0.0]: https://github.com/Stark-work-1001/memora-core/releases/tag/v1.0.0
