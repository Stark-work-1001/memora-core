# DSH 接入与「智能体在线」状态

这篇文档解释工作台右上角 **“无在线智能体（1 个已过期）”** 是怎么来的、修了什么、以及需要
用户执行哪一步才会生效。它同时是这套链路的回归清单。

## 症状与两层原因

界面显示的“已过期”是**如实**的：`memora-control.sqlite3` 里确实有一行 peer，但它的
`seen` 早于 ttl。修好它需要同时解决两件互不相关的事——任何一件单独修都不会让界面变绿：

1. **路径漂移（接不进来）**。DSH profile `<DSH install dir>\cordis.patch.yml`
   里，Memora 相关的两条 insert 列表都还指向已经不在的旧根 `<数据目录>/...`：
   - managed block（`memory-memora` + `memora-lifecycle`），由 `tools/install_dsh.py` 生成；
   - `memory-connector` 那条（连接器插件的后端接线），**不在** BEGIN/END 标记里，是某次
     手工适配加进去的——这正是“重跑安装器也没修好”的原因。

   仓库从 `<项目根>` 迁移到 `<项目根>`、独立版变成兄弟目录
   `<独立版目录>` 之后，profile 没有被重新生成。字符串还是字符串，
   YAML 照样能解析，宿主照样“加载成功”，只是每次要 spawn 的子进程路径不存在 → 永远连不进来。

2. **心跳没有周期化（进来了也很快过期）**。memora 只在 peer **主动调用**
   `memory_peer_heartbeat` 的那一刻记 `seen`，并在该行的 `ttl` 秒后把所有引用判为离线
   （`memora/control.py::peers` 里 `connected = time.time() - seen <= ttl`）。
   连接器（`<插件目录>\memory-connector`）过去只在模型**显式**调用工具时才发一次，
   定时器变量 `heartbeatTimer` 声明了却从未被 `setInterval` 启动 → 任何一次连接的最终状态都是
   “已过期”。

## 改了什么

### 1. 渲染与检查集中到一个模块

`tools/dsh_profile.py`（新增）是所有渲染/检查的唯一来源：它从 `tools/paths.py` 取路径，
产出两段内容——managed block 与 `memory-connector` insert 列表——并原地替换。
替换是**文本级**的（不是 YAML 往返），所以文件里其它 entry 的排版、注释、顺序一个字节都不动。
渲染是幂等的：第二次运行产出逐字节相同的文本。

```
tools/dsh_profile.py          render_managed_block / render_connector_block /
                              render_profile / stale_references / parse_yaml /
                              heartbeat_summary / backup
tools/install_dsh.py          --check 干跑；默认模式：备份 → 渲染 → staging → manifest
integrations/dsh/Install-Dsh.ps1   hash 校验后应用；文件在 staging 期间被改过就重新渲染重试
```
### 2. 连接器后端指向“用户实际在用的那一份”

`memory-connector` 的 `backends.memora` 现在指向独立版：

```yaml
command: "<独立版目录>/resources/backend/memora-backend.exe"
args: ['--data', "<独立版目录>/data", 'mcp']
defaultProject: default
```

用打包 exe 而不是开发目录 venv，是因为两者读**不同**的 `data/`：混用会让智能体看到的记忆和
用户在界面上看到的不是同一份，这是最难被发现的一类错配。

### 3. 周期心跳（连接器，默认关闭、profile 显式打开）

`lib/backends/memora.js` 新增 `resolveHeartbeatConfig()` 与定时器：

```yaml
# 与 backends: 同级（也接受写在 backends.memora 里）
heartbeat:
  enabled: true
  intervalMs: 30000
  ttl: 90          # 必须 > intervalMs，否则两次心跳之间会先过期
  project: default
  peer: dsh-memory-connector
  name: 'DSH Desktop (memory-connector)'
```

设计要点：

* **默认关闭**。没有显式要求心跳的宿主不该在后台往某个 `--data` 写“我在线”。开启是 profile 的
  显式决定，写在一眼能看到的位置。
* **走同一条路**。周期心跳调用的还是 `memory_peer_heartbeat`，照样过 `ALLOWED_TOOLS` 注册闸与
  `callTool()` 的每次调用闸——它不是白名单的例外，只是同一工具名的第二个调用点。
* **装配期不握手**。DSH 的 `apply(ctx)` 是同步契约；定时器首跳延后 5 秒，**首跳失败就每 5 秒重试，
  连上之后才切到 `intervalMs`**。记忆服务比宿主晚起是常态，这条路径必须自己收敛，而不是让
  “连不上”被当成“在线”。
* **卸载即停**。`dispose` 里 `clearTimeout`/`clearInterval` 并关闭子进程。

为什么不用 memora 自带的 `integrations/dsh/memora-plugin.mjs` 那条路：它确实有
`setInterval(heartbeat, 30000)`，但它驱动的是 **memora 自己的 dev runtime**（HTTP MCP
`127.0.0.1:18184`），而用户实际在用的是独立版进程 + 独立版 `data/`。改连接器才是让**用户那一份**
常驻，也符合“不为了让界面变绿而伪造心跳行”的原则——心跳由真实接入方向真实记忆库发出。

## 生效步骤（用户需要做的唯一一件事）

profile 已经被就地更新，但**运行中的 DSH 宿主不会自己重读它**（本次改动也刻意没有重启宿主）。
请在 DSH 里重载 profile（或退出并重新打开 DSH）。重载之后：

1. 连接器插件用新配置重新装配，spawn 独立版 `memora-backend.exe`；
2. 约 5 秒后首跳成功，`peers` 行刷新，`ttl=90`；
3. 之后每 30 秒一次，首页右上角从“无在线智能体（1 个已过期）”变成在线。

如果不想重载整个 DSH，也可以在 DSH 里**重载/重装 `memory-connector` 插件的 entry**（插件源码是
符号链接原地注册的，重载 entry 即生效）——但 profile 的 patch 改动仍然要宿主重新组合配置才可见，
所以推荐直接重载 profile。
## 一键自检

```powershell
# 1) profile 是否正确（不写文件，只报告）：旧路径清零 / YAML 可解析 / 心跳已配置且间隔>0
powershell -NoProfile -ExecutionPolicy Bypass -File integrations\dsh\Install-Dsh.ps1 -Check

# 2) 渲染、幂等、心跳断言（含负向对照）与“已安装 profile == 重新渲染的结果”
.venv\Scripts\python.exe tools\verify_dsh_integration.py

# 3) 端到端：驱动真连接器 + 独立版 exe，等 1-2 个心跳周期，断言 peers.seen 前进、
#    connected=true、白名单闸门未松、dispose 后定时器停止
node tools\verify_dsh_presence.mjs --json artifacts\p1-presence\report.json
```

第 3 条会改写**独立版** `data/memora-control.sqlite3` 里的 peers 行（只有这一行，这是心跳的
正常写入），不会碰任何记忆数据。

## 若界面仍是“已过期”

按顺序排查：

1. `Install-Dsh.ps1 -Check` 是否 `clean`？不 clean 说明 profile 又被改回去了（插件管理器、
   其它工具都可能写它），重跑一次安装器即可。
2. 宿主是否真的重载过？重载前运行的是旧配置，插件仍然不会注册工具。
3. 连接器日志里有没有 `周期心跳已按配置启用：peer=... interval=30000ms`？没有说明
   `memory-connector` 这一行没被加载起来（重点看 `name: dsh-memory-connector` 能否被 profile 解析）。
4. peers 行存在但 `age > ttl`：心跳在写，但写到了**另一个** `--data`。
   用 `tools\verify_dsh_presence.mjs` 打印的 `backend`/`data` 与实际库比对。

## 已知风险

* **独立版 backend exe 是 13:34 的旧构建**。心跳工具（`memory_peer_heartbeat`）在 1.3.0 就有，
  所以本方案不依赖新构建；但 P3 的 `/api/agent/model-probe` 之类**新**路由不在这个 exe 里。
  等 Lead 统一跑 `tools/build_desktop.py` 同步独立版时，这些一起生效。
* **profile 是活文档**。插件管理器、其它插件、用户手改都可能改动它；`-Check` 是唯一能发现
  “又飘回去了”的手段，建议在发布/交接前跑一次。
* **本地 venv 的 editable 安装仍指向旧根**（`__editable___memora_1_3_0_finder.py` 的 MAPPING
  还是 `<项目根>\memora`）。这会让“从任意目录 `import memora`”依赖 cwd；
  `install_dsh.py` 已在 `sys.path` 里补了仓库根来规避。**重装 venv / 重装 editable 包**能根治，
  但那不属于本次改动范围。
