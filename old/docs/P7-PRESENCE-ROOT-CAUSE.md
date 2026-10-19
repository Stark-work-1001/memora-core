# P7 · memory-connector 为什么没在 DSH 宿主里跑起来

> 状态：**已修复并在线验证**（2026-10-18 21:12 +08:00）。
> 一句话：连接器**一直被加载了**，但它的入口读了一个不存在的配置字段，读的时候抛异常、
> 异常被自己 catch 成一条日志，于是「装配成功、注册 0 个工具、不起心跳」——插件在宿主
> 清单里是 `enabled/active`，但什么都没做。

---

## 1. 结论先行

用户看到的「无在线智能体（1 个接入方心跳已失效）」由**两个独立缺陷**共同造成，而且它们
在现象上完全一样，这也是上一轮排查把它误判成「插件没加载」的原因。

| # | 缺陷 | 表现 | 是否本次修复 |
|---|------|------|--------------|
| A | 入口用 `ctx.config` 读配置 | 抛异常被吞 → 注册 0 工具、零心跳、**不 spawn MCP 子进程** | 已修：改 `apply(ctx, config)` |
| B | 同一个 id 出现两条 Loader 行 | 合并后同 id 两行，最终留下哪一行取决于 Map 顺序 | 已修：profile 改成按 id 覆写 |

**A 是真正的病灶**；B 是让 A 变得难以诊断、并随时可能再次致病的结构性隐患。

---

## 2. 缺陷 A：`ctx.config` 不是配置

### 2.1 源码证据

cordis 调用函数插件时，配置是**第二个实参**。
`<DSH install dir>/resources/app.asar/dsh/node_modules/@deepseek-ai/cordis/lib/index.js`
（`Fiber._runner.execute`）：

```js
if (isConstructor(runtime.callback)) {
    const instance = new runtime.callback(this.ctx, this.config)
    ...
} else return runtime.callback(this.ctx, this.config)
```

而 `ctx.config` 在 cordis 里是一个**服务属性**，反射层要求先 `inject`：

```js
const error = new Error(`cannot get property "${prop}" without inject`)
```

对照同一个宿主里工作正常的 `arsenal-plugin`：

```js
export async function apply(ctx, suppliedConfig) {
  const config = normalizeConfig(suppliedConfig)
```

连接器原来是：

```js
export function apply(ctx) {
  let cfg
  try {
    cfg = resolveConfig(ctx.config ?? {})   // 抛 cannot get property "config" without inject
  } catch (e) {
    ctx.logger?.error?.(... '配置解析失败，已拒绝装配' ...)
    return () => {}                          // 静默变成「零工具插件」
  }
```

### 2.2 最小复现（不依赖宿主）

用普通 `node` + 连接器自带的 cordis 就能复现，改前/改后只差一个字段：

```
$ node repro.mjs        # 修复前
registered: 0
ctx.config error: "cannot get property \"config\" without inject"

$ node repro.mjs        # 修复后
registered: 10
   memory_status, memory_digest, memory_rag_context, memory_document_rag_context,
   memory_recall, memory_document_get, memory_capture, memory_absorb,
   memory_peer_heartbeat, memory_peers
```

换成宿主自带的 cordis（`app.asar` 里那份）+ 真实 profile 那一行 config，结果一致：
修复前 0 个工具，修复后 10 个。

### 2.3 为什么它「看起来是加载了的」

宿主插件清单（`pluginInventory/list`，读的是宿主自己的 Loader 状态）在修复前就已经是：

```json
{ "entryId": "include:memory-connector", "moduleName": "dsh-memory-connector",
  "enabled": true, "fiberPhase": "active" }
```

**`active` 只说明 fiber 起来了，不说明 `apply()` 里做了什么。** 一个提前
`return () => {}` 的插件同样报 `active`。所以「清单里 active」+「没有 MCP 子进程」=
「入口跑了但立刻退出」，而上一轮只看到后半句就推断成「没加载」。

---

## 3. 缺陷 B：同一个 id，两条 Loader 行

### 3.1 合并规则（用宿主自己的代码验证）

`@deepseek-ai/cordis-plugin-include` 的 `applyEntryPatches`，对 `insert` 只做 append：

```js
if (insert) {
  if (id) { ...target.config.push(...insert) }
  else { data.push(...insert) }     // 无按 id 去重
  buildMap(insert)
  continue
}
```

而 `EntryGroup.update` 用 **id 做 key 建 map**，同 id 后者覆盖前者：

```js
const newMap = Object.fromEntries(config.map(options => [options.id ?? Symbol('anonymous'), options]))
```

所以「同 id 两条 insert」的实际语义是：**两条都进树；最终 `create()` 的只有后一条**。
哪一条是「后」取决于层序，而不是任何一个文件明确表达的意图。

实测（改前，profile 仍是 insert 形态）：

```
composed rows: 5
duplicate ids: ["memory-connector"]
### id = memory-connector => 2 rows
  [0] name=memory-connector      heartbeat=ABSENT
  [1] name=dsh-memory-connector  heartbeat=YES
  EntryGroup.update newMap entry name = dsh-memory-connector (the ONLY one that gets create()d)
```

这一轮之所以**没有**造成「加载了但没心跳」：profile 那条恰好排在后面、恰好带 heartbeat。
换一次层序就会反过来，症状还是同一句话。能用、但靠运气，所以必须消除。

> 同时确认：`arsenal-plugin` 有完全相同的毛病（bundle 与 profile 各 insert 一次同 id）。

### 3.2 为什么改成覆写，而不是删掉 bundle 那条

宿主自己的约定写在 `@deepseek-ai/dsh-base` 的 `cordis.patch.yml` 头部：

> Later bundle patches and the user's profile `cordis.patch.yml` **address these rows by id**,
> with the last write winning per row.

并且 profile 里的 `llm-verifier` 本来就是这么写的（`- id: llm-verifier` 覆写 bundle 的 insert）。
所以：

* **bundle 保留 insert** —— 它是包自带的默认装配，插件被单独装到别的 profile 时也要能跑；
* **profile 改成同 id 覆写** —— 整个 profile 里 `id: memory-connector` 只出现一次，
  config 只有一处真相。

覆写条目的硬要求：`name` 必须与被覆写行的 `name` **完全一致**，否则
`applyEntryPatches` 会 `warn('patch: name mismatch ... skipping')` 并整条跳过。
bundle 那行的 `name` 是 `'memory-connector'`（即 `package.json` dependencies 的键名）。

---

## 4. 修复清单

| 文件 | 改动 |
|------|------|
| `<插件目录>/memory-connector/lib/index.js` ⚠ **仓库外** | 入口改 `apply(ctx, suppliedConfig)`；新增 `readPluginConfig()` 按「第二实参 → `ctx.fiber.entry.options.config` → `{}`」取配置，**不再读 `ctx.config`**。重装插件会丢，见 §8 |
| `<插件目录>/memory-connector/tests/*.mjs` ⚠ **仓库外** | 4 个测试文件从「config 挂在假 ctx 上」改成「作为第二实参传入」，并新增一条断言：`apply()` 一次都不许读 `ctx.config`（负向对照已验证：把 bug 贴回副本立刻 FAIL） |
| `.../profiles/desktop/cordis.patch.yml` | `memory-connector`：`- insert:` → `- id:` 覆写；`arsenal` 同样处理 |
| `tools/dsh_profile.py` | `render_connector_block()` 输出覆写形态；`connector_span()` 能识别覆写并在重跑时**替换而非追加**；`connector_row()` 两种形态都认 |
| `tools/install_dsh.py` | `--check` 区分「语义漂移」与「纯格式漂移」（此前 profile 语义完全正确也会永久报 DRIFT） |
| `tests/test_dsh_profile_composition.py` | 新增 10 项静态回归：覆写形态、幂等、旧 insert 形态可迁移、profile 无重复 id、心跳字段存活、验证脚本入口 |

---

## 5. 验证

### 5.1 一键验证

```
node tools/verify_agent_presence.mjs
```

它把四件不同的事**分开报**，因为它们的修法完全不同：

| 检查 id | 回答什么 |
|---|---|
| `single-insert-row-per-id` | 合并后有没有同 id 多行 |
| `no-dangling-id-override` | 覆写项有没有指向不存在的行（会静默不生效） |
| `composed-connector-row-correct` | 合并后真正要跑的那一行，心跳/后端是否对 |
| `connector-entry-in-live-loader` / `-active` | 活宿主的 Loader 里在不在、是不是 active |
| `connector-mcp-child-running` | 有没有 `memora-backend.exe ... mcp` 子进程 |
| `peer-seen-advances` / `peer-connected` | 一个心跳间隔后 `peers.seen` 有没有前进 |

实测输出（2026-10-18 21:19 最终状态，报告存 `artifacts/p7-presence/final.json`）：

```
PASS single-insert-row-per-id        rows=23, 每个 id 只出现一次
PASS no-dangling-id-override         （10 个 bundle 层在 app.asar 内，纯 node 读不到，
                                      与之相关的覆写目标只标注"未判定"，不算失败）
PASS composed-connector-row-correct  heartbeat=true backend=...memora-backend.exe defaultProject=default
PASS connector-entry-in-live-loader  include:memory-connector  (moduleName=memory-connector)
PASS connector-entry-active          enabled=true fiberPhase=active
PASS connector-mcp-child-running     pid 11448  ...memora-backend.exe --data .../data mcp
PASS heartbeat-configured-in-profile interval=30000ms ttl=90s peer=dsh-memory-connector
PASS peer-row-exists                 seen=13:18:24Z age=15.3s ttl=90 connected=true
PASS peer-seen-advances              13:18:24Z -> 13:18:54Z (+30s)
PASS peer-connected                  age=23.3s ttl=90
PRESENCE OK: one insert row per id, connector active in the live Loader, MCP child running, peers.seen advancing.
```

> 注意最后两行：等待一个 `intervalMs` 之后 `peers.seen` **前进 30 秒**，这正是"周期心跳在跑"
> 而不是"有人手动打过一次卡"的判据。如果只跑 `--no-wait`，这两项不会出现。

### 5.2 独立版界面真正读的那一份

```
GET http://127.0.0.1:18765/api/agent/peers

{"items":[{"id":"dsh-memory-connector","project":"default",
           "name":"DSH Desktop (memory-connector)","model":"deepseek-v4.1-flash",
           "seen":1792329144.59,"ttl":90,"connected":true,
           "last_seen_age_seconds":27}],
 "connected":1,"total":1,"scope":"all"}
```

`connected: 1 / total: 1` —— 那句「无在线智能体（1 个接入方心跳已失效）」已经不成立。

### 5.3 静态回归

```
.venv/Scripts/python.exe -m unittest tests.test_dsh_profile_composition   # 10 passed
.venv/Scripts/python.exe tools/install_dsh.py --check                     # result: clean
```

---

## 6. 用户需要做什么

### 6.1 现在：什么都不用做

修复已经**在当前运行的宿主里生效**，不需要重启、不需要重载 profile。实测时间线：

```
18:30:07  宿主启动（全程未重启、未重载）
20:57:43  修改 memory-connector/lib/index.js（插件入口）
21:04:23  memora-backend.exe ... mcp 子进程出现（父进程 = 宿主 8088）
21:18:24  peers.seen 正常前进（30s 一跳）
```

宿主 HMR 监听了 profile 的 `cordis.patch.yml` 与被加载的插件模块。模块一变就重新 import、
重新 `apply()`；新代码的 `apply(ctx, config)` 这次拿到了带 `heartbeat` 的配置，于是注册
10 个工具、5 秒后首跳、之后 30 秒一次周期心跳。profile 那次改动（insert → 覆写）同样被 HMR
重新解析，最终活宿主里的 `moduleName` 已经是 `memory-connector`，说明覆写生效了。

**如果之后重启 DSH**：磁盘上的 profile 与插件代码都是修好的形态，重启后直接正确。

### 6.2 两分钟自检（重启后又不在了，照这个走）

只跑一条命令：

```
node tools/verify_agent_presence.mjs
```

然后**只看两处**，就能把两个根因分开：

| 你看到 | 结论 | 下一步 |
|---|---|---|
| `FAIL single-insert-row-per-id … duplicates: [{id:"memory-connector", rows:2}]` | **B：重复 id 回来了**（profile 被换回 insert 形态，或安装器被旧版本渲染过） | 跑 `.venv/Scripts/python.exe tools/install_dsh.py` 重新渲染并落地，再 `--check` 复核 |
| `FAIL connector-entry-in-live-loader`（找不到 `include:memory-connector`） | 插件根本没被装配（profile 里那一行没了 / 包解析失败） | 看宿主启动 stderr 里的 `skipping profile bundle`；跑 `install_dsh.py --check` |
| `PASS connector-entry-active` 但 `FAIL connector-mcp-child-running` | **A：入口又读不到配置**（`apply()` 没拿到 config，提前 return） | 跑 `.venv/Scripts/python.exe -m unittest tests.test_dsh_profile_composition`，再跑连接器自己的 `node tests/selfcheck.mjs`（里面有 `apply() 没有读 ctx.config` 这一条） |
| `PASS` 到 `peer-row-exists`，但 `FAIL peer-seen-advances` | 心跳没在跑 / 独立版没在跑 | 先确认独立版在工作（`GET http://127.0.0.1:18765/api/agent/peers`），再看 `memora-backend.exe` 是否在 |
| 全 `PASS` | 一切正常，问题在界面那一侧 | 看 `/api/agent/peers` 的 `connected/total` |

**关键分辨点**：`connector-entry-active` 通过 **不代表插件干了活**。
`active` 只说明 fiber 起来了；一个提前 `return` 的插件同样是 `active`。
真正干活的两个证据是 `connector-mcp-child-running`（有子进程）和
`peer-seen-advances`（一个间隔后 seen 前进）。这两条不过，就是 A。


---

## 7. 给 Lead 的 UI 文案需求（`memora/static/memory.js`，本次未修改该文件）

现在右上角是无在线智能体（1 个接入方心跳已失效）。建议在没有在线接入方时，把**原因**说清楚，
并指向自检命令，而不是只报事实：

```
无在线智能体
最近一次心跳：{age} 前（已超过 {ttl}s 有效期）
DSH 连接器（memory-connector）由宿主进程加载；若长期不刷新，运行
node tools/verify_agent_presence.mjs 查看是「未加载」「已加载但未注册工具」还是「心跳未发出」。
```

要点：

1. **不要**把「未加载」和「加载了但没心跳」说成同一句话——本次两个缺陷都表现为同一句
   「心跳已失效」，而它们的修法完全不同；文案区分开能省掉一整轮排查。
2. 在线时至少显示 `name` + `last_seen_age_seconds`，让「在线」是个可核对的数字，而不是一个色块。
3. 若该页有刷新按钮，刷新应重新拉 `/api/agent/peers`（该接口已返回 `connected/total`）。

---

## 8. 不在本仓库的文件（**重装会丢，别踩**）

### 8.1 `<插件目录>/memory-connector/lib/index.js`

这就是缺陷 A 的修复位置，**它在 memora 仓库之外**，是 DSH 的外挂插件目录。

> ⚠ **重装 / 重新解压 / 重新 link 这个插件会覆盖或替换这个文件，本次修复随之丢失。**
> 届时症状会原样复现：插件在宿主清单里 `enabled/active`，但注册 0 个工具、不起心跳、
> 没有 MCP 子进程，工作台又是"无在线智能体"。

**怎么确认修复还在**（不用读代码，看行为即可）：

```
node tools/verify_agent_presence.mjs --no-wait
```

* `PASS connector-mcp-child-running` ⇒ 修复在（插件真的干了活，必然 spawn 子进程）；
* `FAIL connector-mcp-child-running` 但 `PASS connector-entry-active` ⇒ 修复丢了，重贴。

也可以直接跑插件自带的自检，它会断言"没有读 `ctx.config`"：

```
cd <插件目录>/memory-connector && node tests/selfcheck.mjs
```

（本次同时把该插件的 4 个测试文件从"把 config 挂在假 ctx 上"改成"作为第二实参传入"，
因为旧写法本身就在验证一个真实宿主不成立的契约——这正是这个 bug 能长期全绿的原因。）

### 8.2 是否已写进安装流程？

**没有，也不应该自动写。** `tools/install_dsh.py` 只负责 **profile 的 `cordis.patch.yml`**
（本仓库拥有的那两块），它不拥有、也不该改写第三方插件的源码。所以：

* profile 那半边（缺陷 B）→ 由 `install_dsh.py` 渲染 + `--check` 守护，重装 profile 会自动带回；
* 插件源码那半边（缺陷 A）→ **手工修复，重装插件需重贴**，用上面的两条命令确认。

若将来要做成自动化，正确的位置是该插件自己的仓库/发布物，而不是 memora 的安装器。

---

## 9. 仍未解决 / 需要另一轮的事

1. **连接器的 10 个 `memory_*` 工具没有出现在当前智能体的工具面里。** 它们在宿主侧注册成功
   （验证脚本证明），但当前会话的工具列表里只有 `mcp__memora__*`（来自另一条
   `@deepseek-ai/dsh-mcp-client` 行）。这属于 **agent preset 的工具装载**问题，与在线状态
   无关；心跳是插件自己的定时器，不依赖工具可见性，所以「在线」已经修好。
2. **`arsenal-plugin` 是正常的，不需要再修。** 本轮一开始把它误判成"没有上报"，原因是看错了
   文件名：它的心跳文件名是 `<hostname>.json`（见 `lib/heartbeat.js` 的
   `safeFileStem(beat.host)`），本地是 **`WIN-MNI8FILL2II.json`**；之前一直盯着的
   `deepseek-harness.json` 是别的主机名留下的陈旧文件。实测它每 30 秒写一次
   （`pid: 8088`，正是宿主进程），中枢 `/api/v1/agents` 里 `state: online`。
   它的入口本来就写对了（`apply(ctx, suppliedConfig)`），本次只是把重复 id 一并去掉。
3. `profile/node_modules/dsh-memory-connector` 这个手工链接现在已无人使用（覆写项用的是
   `memory-connector`）。留着无害，`pnpm install` 也不会删它；下次清理 profile 依赖时可以一并去掉。