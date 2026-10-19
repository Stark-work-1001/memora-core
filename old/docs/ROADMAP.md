# Memora 规划书 / ROADMAP

> 本次开发升级更新：统一入口已由 `knowledge.py` 实现，原记忆/文档接口保持兼容；
> 增加 8 个工作流模板和真实 Embedding / Rerank 节点、图关系扩展、DSH 新会话接口兼容。
> 同源核验现会阻止自动沉淀；真实部署仍需绑定独立模型并做质量对照，不能将代码门禁视为模型评测。
> router 自主规划仍未实现，当前使用用户编排的 DAG。下文 1.3.0 基线与旧“不做”项属历史状态；
> 本次需求覆盖其中 rerank、图遍历与统一检索的取舍。见 [本次升级](UPGRADE-MEMORY-SYSTEM.md)。

> 状态基线：**2026-10-19 / 1.3.0**，全部为实测值，不是估计值。
> 本文取代此前散落在 `DELIVERY-*.md`、`IMPLEMENTATION-*.md` 与决策日志里的零散「下一步」。
> 更新约定：每完成一项就改状态并把新发现补进来；不再另外散记。
>
> 上一版停留在 1.2.0，其 P0 四项（版本号不一致、画布无入口、CHANGELOG 缺条目、重打包复验）
> 已全部完成，见 §1。

---

## 1. 当前实测基线

```text
版本              1.3.0（memora/__init__.py、frontend/package.json、BUILD_MANIFEST.json 一致）
Python 测试       560 用例 / 0 失败 / 5 跳过（无构建产物时为 7）
前端测试          node --test 125 / 125 通过
ruff              0.17.1，ruff check . 零错误
mypy              2.4.0，66 个源文件零 error
MCP 工具面        22 个（create_server() 实际枚举）
桌面壳             supervisor：健康探测 + 端口回退 + 有界重启 + 进程树清理
HTTP 传输          200 并发 0 失败（改造前 50 并发 24 次 ECONNREFUSED）
git               本地 26 个提交，无远程
```

跳过项全部有正当理由，不是被掩盖的失败：4 个需要已部署的 DSH profile，1 个需要可选依赖 pypdf，
以及 2 个 BUNDLE 类——它们**在 `dist/memora-backend` 存在时会真正执行**，所以跳过数在
「有构建 5 / 无构建 7」之间变化。写死一个数字而不说明前提，正是基线容易过期的原因。

---

## 2. 已完成（1.3.0，供追溯）

### 2.1 HTTP 传输层

裸 `ThreadingHTTPServer`（backlog 5 / HTTP/1.0）换成 `LoopbackHTTPServer`：backlog 128、
`allow_reuse_address`、`daemon_threads`、HTTP/1.1 keep-alive、每响应显式 `Content-Length`、
gzip（阈值 1400 字节，`compressobj(16+MAX_WBITS)`）、每连接 100 请求上限。
实测 200 并发 0 失败；`memory.js` 148191 → 50125 字节。契约见 [TRANSPORT.md](TRANSPORT.md)。

### 2.2 桌面壳从启动器变为 supervisor

主动健康探测（`/api/agent/status` 校验 name/version/data_dir）、端口 18765–18795 自动回退、
后端异常退出自动重启 3 次（退避 500/1500/4000ms）、重连页、`<data>/desktop.log` 诊断日志
（1MB 滚动 + token 脱敏）、Windows `taskkill /T` 进程树清理、`unresponsive` 处理。
安全边界（contextIsolation / sandbox / Origin 白名单 / 外链 https 限制）原样保留。
生命周期见 [ARCHITECTURE.md](ARCHITECTURE.md) §3。

### 2.3 质量地基

ruff + mypy 配置落地并双双清零；`requirements-dev.txt` 锁版本；CI 重写为 5 个 job
（lint / test / native / package / docker）。**test job 强制安装 node**——缺 node 时 90 个静态
UI 测试会静默跳过而不是失败，这是覆盖率陷阱。详见 [QUALITY.md](QUALITY.md)。

### 2.4 两个真实缺陷

- `memora/workflows.py` 抛出 `ProviderError` 却从未 import：工作流超时路径会 `NameError`，
  而不是报告提供方失败。
- `tests/test_packaged_assets.py` 的 `BUNDLE`/`PRODUCT` 路径写死为早已不存在的
  `build/dist/...` 与 `desktop-standalone`，导致打包守卫测试**永远 skip**——守卫没在守任何东西。
  已改为真实路径 `dist/memora-backend` 与 `../memora-desktop-standalone`。

### 2.5 测试环境耦合

`test_dsh_profile_composition` 原本断言「本地装了哪个插件」，测的是机器而不是代码。
改为在临时目录合成插件树，直接断言排序性质。

### 2.6 更早的 1.2.0 收尾（上一版 ROADMAP 的 P0）

画布导航入口、版本号提升、CHANGELOG 补条目、重打包复验——四项均已闭合。

---

## 3. 未完成，按价值排序

### P0 · 独立 verifier（最高价值）

**现状**：Judge 与生成层同源。`deployment/model-manifest.json` 中
`distillation_origin_verified: false`，且默认绑定里 `curator` / `verifier` / `relation`
三个角色**复用同一个 2B Judge**。

**为什么最优先**：自己核验自己不是独立证据。当核验方与被核验方是同一个模型时，「核验通过」
只说明该模型自洽，不说明内容正确。这是当前质量链条上唯一的结构性弱点，其余问题都是覆盖面问题。

**完成标准**：verifier 绑定到一个与生成侧不同的模型；有对照测量说明独立核验改变了什么裁决。

### P1 · 两级检索统一入口

**现状**：`service.rag()`（记忆行）与 `docindex.rag()`（文档块）是两套并行实现，共享
nonce / RRF / BM25 约定但**代码不共用**。调用方必须自己知道该调哪一个。

**为什么排第二**：这是使用者每天都会碰到的摩擦，且两份实现已经开始各自演化——分叉成本随
时间上升。但它是设计决策（合并还是明确保留为两个视角），不应顺手改。

**完成标准**：要么合并为统一入口，要么在文档与工具面上把两者明确表述为两个视角并给出选择规则。

### P2 · router 角色仍是预留空壳

**现状**：编排页有 `router` 绑定位，但当前按**用户声明的阶段顺序**调度，不做自主规划。
README 对此是自陈的，不是隐瞒。

**为什么排第三**：这是「工作流」从记录器变成调度器的分界，但它依赖 P0——没有独立核验的
调度器只是把不独立的判断自动化。

**完成标准**：router 真正参与阶段选择，且其选择可审计、可回放、可关闭。

### P3 · mypy 范围未覆盖 `tools/` 与 `tests/`

**现状**：`pyproject.toml` 的 `[tool.mypy] files = ["memora", "memory_merge"]`。
`tools/` 下 30 余个脚本、`tests/` 全部用例都在类型检查之外。

**为什么排第四**：`tools/` 里恰恰是路径推导、构建清单这类错一次就静默出错的地方——
BUNDLE 路径写死导致守卫永不执行的缺陷就出在这一类代码里。

**完成标准**：把 `tools/` 纳入 `files` 并清零；`tests/` 视收益决定。

### P4 · CI 从未真实跑过

**现状**：`.github/workflows/ci.yml` 有 5 个 job，但仓库**无远程**（`git remote -v` 为空，
本地 26 个提交）。这五个 job 一次都没有在真实 CI 上执行过。

**为什么排最后**：它不是能力问题，是发布前提问题。在推送到任何远程之前，CI 配置只是声明。
需要先决定是否公开、推到哪里，那不是执行方该替你定的。

**完成标准**：存在远程，且五个 job 至少各绿一次。

---

## 4. 已知取舍（记录在案，不是待办）

这些是**已决定不做**或**已决定按现状保留**的项，写在这里是为了下次不要重新讨论一遍。

| 项 | 现状与理由 |
| --- | --- |
| `doc_*` 表不进 `schema.py` 迁移体系 | 决策 D9 的既定代价：新表由 `docindex.py` 自行 DDL，因此不参与版本迁移与自动备份。已知，接受。 |
| audience 是用途元数据，不是权限边界 | 项目四处独立写明这一点。若要收紧成硬边界需引入主体概念，那是新架构。模型在本地、数据不出本地，真正的信任边界在进程与磁盘。 |
| 旧 agent 控制台代码原地保留 | 归档风险大于收益（曾导致 advanced 部署启动失败），且 `test_agent.py` 仍依赖它。命名后续再议。 |
| 图遍历检索、rerank、自动合并、自动冲突消解 | 故意不建，见 [DECISIONS.md](DECISIONS.md)。显著性与衰减只记录与报告，不参与排序。 |
| 原生内核可选 | 它是速度边界，不是正确性边界；纯 Python 路径覆盖其缺失。 |

---

## 5. 待决事项（需要判断，不是待办）

### ① memory-connector 是否在 DSH profile 启用

连接器代码已就绪（白名单 7、`localOnly` 出境闸门、`memory_review` 永不注册），**故意未启用**。

DSH 的 MCP 客户端给每个工具加 `mcp__<serverName>__<rawName>` 前缀。profile 现有那条用
`serverName: memora`，因此 DSH 看到 22 个工具。连接器若也用同名 `serverName`，前缀完全相同，
DSH 的命名空间预留逻辑会**确定性抛错**——第二个实例启动失败，不是「可能重复」。

| 方案 | 做法 | 结果 |
| --- | --- | --- |
| A · 换 serverName | 连接器用 `memora-gated` 之类 | 两套并存、前缀不同，但**收窄失去意义**——模型同时看得见 22 个和 7 个 |
| B · 停用现有那条 | 给 `memory-memora` 加 `disabled: true` | 真正收窄到 7 个 |

**B 才是连接器存在的意义**，但代价是现有那条承担的三个能力（会话前 `memory_digest` 注入、
空闲 `memory_absorb` + 磁盘 outbox、30 秒 `memory_peer_heartbeat`）由 `memora-lifecycle`
插件提供，**连接器本身不提供**。换用 B 前必须确认这三个能力另有来源，否则会静默丢失。

**结论：这不是可以顺手决定的开关。建议先补齐 B 方案丢失的能力，再启用。**

### ② audience 是检索过滤器还是权限边界

见 §4。目前按「用途元数据」实现，每次响应回报 `audience_filter`，每个命中携带自身
`audience`。维持现状是当前倾向，但若产品语义变化，需同步改写四处文档并引入主体概念。

### ③ 仓库是否公开、CI 在哪里跑

见 §3 P4。决定权在项目所有者，不在执行方。

---

## 6. 相关文档

- [TRANSPORT.md](TRANSPORT.md) — 传输层契约，改传输层前必读
- [ARCHITECTURE.md](ARCHITECTURE.md) — 分层、传输层决策、supervisor 生命周期
- [QUALITY.md](QUALITY.md) — 三道门禁如何跑、如何复现数字
- [DIRECTORY-LAYOUT.md](DIRECTORY-LAYOUT.md) — 目录契约与数据目录风险
- [OPERATIONS.md](OPERATIONS.md) — 备份、迁移、维护、故障排查
