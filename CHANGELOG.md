# Changelog

本文件记录 memora-core 的版本变化。 / This file records the notable changes of memora-core.

## [1.1.0] — 说到做到 / Make it true

1.1.0 的主线：产品在界面、响应和文档里说的每一句话，都有一个会运行的东西在核对。每条修复都有
一个在 1.0.0 上失败、在 1.1.0 上通过的测试。完整的决策、证据与风险见 [HANDBACK.md](HANDBACK.md)。
*Theme: every claim the product makes — in the UI, in a response, in the docs — is checked by
something that runs. Every fix comes with a test that fails on 1.0.0 and passes on 1.1.0.*

### 修复 / Fixed

- **源码树可以运行了**：发布的仓库缺 `memora_core/__init__.py` 与 `__main__.py`（从发布 exe 的字节码
  逐字节恢复），文档里每条 `python -m memora_core …` 在 1.0.0 的源码树上都跑不起来。
  *The published tree was missing two modules; every documented source command failed.*
- **3D 脑图不再空白**：挂载点 0 px 高 + 服务端 `frame-ancestors 'none'` 两个原因各自就能让图谱页空白；
  `?view` / `?focus` 生效。*The graph view rendered nothing in 1.0.0 (two independent causes).*
- **前后端契约**：总览页总数 / 今日 / 候选 / 作用域 / 趋势在真实数据上都是 0，冲突页每条"缺少 A"，
  智能体行 "[object Object]"，模型超时设置被忽略，文档原文永远为空——前端按后端的真实响应重写，
  并新增在真浏览器 + 真后端上跑 12 个路由的 e2e。*Frontend now reads the real backend shapes; an
  end-to-end test drives all 12 routes against a real backend.*
- **工作流引擎**：异步运行（`?async=1` → 202）与逐步进度事件；协作式取消、CAS 收尾、重启后回收
  孤儿 run；"遗忘衰减"真的归档而不是新建记忆，"更新推翻"真的推翻；未知节点种类直接失败；
  6 个模板只给声明的输入就能跑；无模型与零档位网关行为一致；job 表有了执行器。
  *Async runs with progress, cooperative cancel, honest persist ops, a job worker.*
- **检索**：默认混合检索在留出测试集上 nDCG@10 0.455 → 0.602（`tools/eval_retrieval.py --split test`）；
  `Store` 路径不再只能搜到最近 500 条；FTS 先过滤再截断；向量缓存按模型与维度区分并随编辑失效；
  挂死的模型端点不再让每次搜索卡 15 秒（快速失败 + 熔断）。
  *Default hybrid search 0.455 → 0.602 nDCG@10 on the held-out split; five correctness bugs fixed.*
- **健康检查**：不再每次调用都跑完整 `integrity_check`（423 MB 的库：1,843 ms → 4.4 ms；桌面外壳的
  就绪探针 1.5 s 超时，1.0.0 在这个规模下启动不了）；表清单从 `sqlite_master` 推导（28 张，不是 23）。
  *Health no longer scans the whole database per call; table census derived from the schema.*
- **日期**：日记页、按天统计、时间线按本地日历日切分（ADR-0003）。*Day buckets use the local calendar.*
- MCP `memory_health` 没配模型时也报 `degraded: []`；一帧畸形的 `_meta` 让 stdio 进程退出；
  界面导入 N 条记录变成 1 条垃圾记忆；编辑模型档位丢掉已保存的密钥引用；损坏的主密钥文件被静默
  替换；静态资源每次刷新重传 ~1 MB；每个 HTTP 连接泄漏一个 SQLite 连接。

### 安全 / Security

- 拒绝浏览器跨站写请求（ADR-0001）：1.0.0 里任何网页都能经 multipart / 空 body 的 POST 导入"已批准"
  的记忆、批准候选、跑工作流。*Any web page could write to the hub in 1.0.0.*
- 不得自我认证（ADR-0002）：agent、导入文件、工作流不能批准记忆，也不能把信任度抬过 0.5；
  `memory_forget(hard=true)` 需要 `confirm`；`sensitivity=secret` 不导出、不写进 Markdown 镜像、
  不交给 agent 侧召回。*The README's trust rule is now enforced on every write path.*
- 桌面外壳：主窗口不能被导航到外部页面，权限请求默认拒绝，IPC 校验发送方，Electron fuses 收紧。
- Windows 上新建的主密钥由 DPAPI 绑定当前用户；首次创建不再竞争。

### 变更（接口）/ Changed (interfaces)

均为附加字段或有迁移路径的收紧，详见对应 ADR。*All additive or tightened with a migration path.*

- 交换导入默认 `trust: "cap"`（approved 降为候选）；原样恢复自己的备份用 `trust: "preserve"`（HTTP/CLI）。
- MCP `memory_update` 改 `status=approved` → -32602；`memory_forget` 硬删除需 `confirm=<id>`。
- `POST /api/runs/{id}/cancel`：200 / 202 收尾中 / 409 已结束 / 404。
- 混合检索离线时不再把本地 hash 指纹当向量通道；检索响应新增 `channels_used`、`vector_model`、
  `semantic`、`reranked`、`score_kind`。
- 数据库结构版本记在 `PRAGMA user_version`，按版本迁移；比程序新的库拒绝打开（ADR-0004）。
- 发布包顶层的 `memora-backend.exe` 标为弃用，1.2.0 移除（ADR-0005）。

### 新增 / Added

- `tools/eval_retrieval.py`（检索评测，数据集为 `old/datasets/memory-eval-v1`）、`tools/inspect_exe.py`
  （读产物本身，查未声明的第三方包）、`tools/desensitize_scan.py`（产物里的构建机身份）、
  `tools/release.py`（可复现的发布包 + SHA256SUMS）、`.github/workflows/ci.yml`。
- 文档与代码对账测试（`tests/test_docs_drift.py`）；`docs/adr/` 五条决策记录。
- `data/inbox/` 自动吸收（文档一直这样写，1.0.0 没有调用方）；别的进程写库后界面自动刷新。

### 移除 / Removed

- 后端 exe 里顺带打包的 numpy / Pillow / fontTools（31.1 MiB → 11.5 MiB）；55 个 Chromium 语言包中的 53 个；
  katex.css 里浏览器用不到的 woff / ttf 字体（1.46 MB → 0.37 MB，且只在渲染公式时加载）。
  发布 zip 211.6 MiB → 160.5 MiB，解压后 429.2 MiB → 342.7 MiB。
- 绕过状态机、会自动批准的 `Store.decide_candidate`；未使用的 `TfidfModel`；`Paths` 里从未被读写的
  `models.json` / `secrets.bin` / `settings.json`；生成器里与 `algorithms.json` 不同步的算法目录副本。

[1.1.0]: https://github.com/Stark-work-1001/memora-core/compare/v1.0.0...v1.1.0

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
