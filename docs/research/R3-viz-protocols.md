# R3 · 脑图可视化与智能体协议互通调研

> 交付物：`docs/research/R3-viz-protocols.md`
> 项目：记忆中枢 memora-core（Windows 桌面，Python 3.12 + SQLite/FTS5 + TS/three.js + Electron）
> 事实约定：每条事实性结论后标 `[S-n]` / `[L-n]` / `[M-n]`，对应第 9 节参考链接表；无法从原文核实的显式写「未核实」。
> 取证环境：Windows / Node v24.15.0 / Python 3.12 / 工作目录 `<repo-root>`

## 0. 取证方式（可复核）

| 类别 | 手段 | 落点 |
|---|---|---|
| 协议规范 | `urllib` 抓 `raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol` 的 `docs/specification/**/*.mdx` 与 `schema/<ver>/schema.ts` | `.research/mcp/` |
| 宿主文档 | `curl` 抓 Claude Code 文档页与 Codex config-reference，正则去标签转纯文本 | `.research/hosts/` |
| 第三方库 | npm registry `/latest` 取版本与 license；GitHub raw 取 README 与关键源码 | `.research/libs/` |
| 本地参考实现 | 直接读 `memora/frontend/*.ts` 与 `obsidian-3d-mindmap/original-dev/src/**`（行号见各节） | — |
| 本机实测 | `node bench_bh.mjs`（力导向基准）、`python presence_probe.py`（探活耗时） | `.research/` |
| 本机实读 | `~/.dsh/profiles/desktop/{package.json,cordis.yml,cordis.patch.yml}`、`~/.dsh/sessions/**` | 第 6 节 |

所有"实测"数字是本机跑出来的，命令与原始输出在第 4、8 节给出；所有"引用"数字都带来源编号。

---

## 1. 摘要

### 1.1 (A) 2D/3D 记忆脑图 —— 8 条可执行结论

1. **渲染底座用 three.js 0.160.1 自建，不引入任何图渲染框架。**
   项目 `frontend/package.json` 已锁 `three 0.160.1` 与 `katex 0.16.47`；
   自建可完整复用本地两套已实测的渲染器源码，而框架会把布局与渲染焊死。`[L-1][S-12]`

2. **力导向的算法分水岭在 500–1000 节点。** 本机实测：500 节点全对 `O(n²)` 更快（0.38 ms vs BH 0.81 ms），
   1000 节点持平（1.41 vs 1.23 ms），2000 节点 BH 快 2.6 倍（2.60 vs 6.87 ms）。
   **按节点数切算法，而不是无条件上八叉树。**（见 4.1）

3. **10k 节点不能每帧重跑布局。** 本机实测 BH 单步 10k 节点 17.19 ms，已超 16.7 ms 帧预算。
   策略必须是「布局一次 → 烘焙坐标 → 增量只重算局部」，与参考实现的 `reason: edit/expand/open` 温度分级一致（0.3/0.55/1）。`[L-5]`

4. **相机取景用闭式解，不要二分。** 每个球需 `(|x|+r)/(tanX·freeX) + z`，取最大值，一次遍历出结果；
   参考实现注释记录了二分"簇接近相机平面时不再单调"的失败。`[L-1]`

5. **"最佳视角"= 24 方位 × 7 俯仰的方向搜索，按投影填充率打分**；
   层级视图的"父在上"用**字典序**（先过可读性下限 0.34，再比 downwardness），不是加权求和。`[L-1][L-6]`

6. **相机动画三条硬规则**：四元数 `slerp`（永远短路）、距离**对数插值**、阻尼 `1 − e^{−dt/τ}`（跨刷新率一致）；
   任何用户输入立刻取消动画。`[L-6]`

7. **边的弯曲必须是派生量，不能回写数据。** `bow = |baked| + 0.18·len·facing²`，`side = normalize(axis×view)`；
   回写会让"每转一次相机污染一次烘焙几何"，参考项目为此专门断言 control 不变。`[L-2][M-1]`

8. **标签避让 = 粗网格占位 + 4 方向候选 + 分级优先级**，焦点标签允许破例重叠、普通标签挤掉即隐藏，
   用网格把 O(n²) 降到近似线性。`[L-3][L-4]`

### 1.2 (B) 多智能体协议互通 —— 8 条可执行结论

1. **只需实现两个协议版本：`2025-06-18` 与 `2025-03-26`。** 规范规定：HTTP 下收不到
   `MCP-Protocol-Version` 头时服务端 **SHOULD** 假定 `2025-03-26`，收到非法值 **MUST** 返回 400。`[S-3]`

2. **stdio 帧格式 = 一行一个 JSON、不许内嵌换行**，服务端 **MUST NOT** 往 stdout 写任何非 MCP 消息（日志走 stderr）。
   对 Python 后端这是最容易踩的坑：任何一句 `print()` 都会污染协议流。`[S-3]`

3. **Streamable HTTP = 单端点 POST+GET**；POST 的 `Accept` 必须同时列 `application/json` 与 `text/event-stream`；
   通知/响应返回 **202 无 body**；服务端可选发 `Mcp-Session-Id`，404 表示会话终止须重新 initialize。`[S-3]`

4. **JSON-RPC 批量在 2025-06-18 被移除。** 2025-03-26 引入、2025-06-18 删除——不要为批量写兼容分支。`[S-6][S-7]`

5. **三家宿主的配置落点完全不同**：Claude Code = `~/.claude.json`（local/user）+ 项目根 `.mcp.json`（project）；
   Codex CLI = `~/.codex/config.toml` + 项目级 `.codex/config.toml`（仅信任项目时加载）；
   DSH = `~/.dsh/profiles/<name>/cordis.patch.yml`。`[S-9][S-10][L-8]`

6. **Claude Code 的 hook = 每事件独立 JSON on stdin + 退出码语义**，公共字段 10 个；退出码 0=成功、2=阻断、其它=非阻断；
   **stdout 只有"整段恰好一个 JSON 对象"才按 JSON 解析**。`[S-9]`

7. **Codex 已不用 `notify` 做生命周期钩子。** `notify` 只剩 `array<string>`，真正的钩子是 `[hooks]` 表，
   事件名与 Claude Code 高度重合。`[S-10]`

8. **在场上报优先级：被动心跳 > 端口 > 进程扫描。** 本机实测 `netstat` 50 ms、`tasklist` 943 ms、
   `Get-CimInstance` 852 ms——每秒轮询进程表不可接受。（见 8.2）

---

## 2. (A) 选型矩阵与最终建议

### 2.1 候选方案横评（14 个）

版本与 license 取自 npm registry `/latest`（`.research/libs/npm-latest.json`）`[S-11]`；项目已锁版本见 `frontend/package.json` `[M-7]`。

| # | 方案 | 版本 / 许可 | 渲染底座 | 布局 | 节点上限依据 | 结论 |
|---|---|---|---|---|---|---|
| 1 | **three.js 自建** | 0.160.1 / MIT（项目已锁） | WebGL，可 InstancedMesh | 自实现/外挂 | 本机实测布局 10k 单步 17.19 ms | ✅ **选** |
| 2 | 3d-force-graph | 1.80.1 / MIT | three.js | 焊死 d3-force-3d / ngraph | 官方未给数字（未核实） | ❌ |
| 3 | react-force-graph | 1.48.3 / MIT | 同 2 | 同 2 | 同 2 | ❌ |
| 4 | force-graph（2D） | 1.52.0 / MIT | Canvas 2D | d3-force | Canvas 2D 万级掉帧 | ❌ |
| 5 | sigma.js + graphology | 4.0.3 / MIT; 0.26.0 / MIT | WebGL（2D） | 需配 graphology-layout | 官方未给数字（未核实） | ❌ |
| 6 | cytoscape.js | 3.34.4 / MIT | Canvas / SVG | 自带多布局 | 无 3D/无 instancing | ❌ |
| 7 | d3-force | 3.0.0 / ISC | 无渲染 | Barnes-Hut 四叉树 | 布局库，无渲染上限 | ⚠️ **只借算法** |
| 8 | d3-force-3d | 3.0.6 / MIT | 无渲染 | 3D 版 d3-force | 同上 | ⚠️ 备选算法 |
| 9 | @cosmograph/cosmograph | 2.5.1 / **CC-BY-NC-4.0** | WebGL（GPU 直算） | 内置 GPU 力导向 | 官方宣称万级（未核实） | ❌ **许可否决** |
| 10 | @antv/g6 | 5.1.1 / MIT | Canvas/WebGL 双栈 | 内置多布局 | 未核实 | ❌ |
| 11 | three-forcegraph | 1.43.6 / MIT | three.js 对象层 | d3-force-3d | 同 2 | ❌ |
| 12 | ngraph.forcelayout | 3.3.1 / BSD-3 | 无渲染 | 自有 3D 布局 | 未核实 | ❌ |
| 13 | 本地 vendor：dictionary-graph | 项目内 vendored | three.js | 自有 spring embedder | 工程上限 400（`projections.py:9` 传 `limit=400`）`[M-2]` | ✅ 复用渲染器 |
| 14 | 本地 vendor：original-dev mind-map | 项目内 vendored | three.js + instanced shader | 16 种确定性布局 + 物理 worker | 同上 400 | ✅ 复用渲染器 |

> 表中只有 #1、#13/#14 的"节点上限"有本机可核实依据；标"未核实"的不作为决策依据。

### 2.2 最终建议

**three.js 0.160.1 自建渲染层 + 自持布局，复用本地两套 vendored 渲染器作为视图实现。**

> 视图种类（语义 / 层级 / 时间线 / 证据）与 MCP 工具名在 `docs/ARCHITECTURE.md` 里已冻结 `[M-6]`，本报告的布局选型按这四类视图给。

```
渲染层   three.js（InstancedMesh 画节点、InstancedBufferGeometry 画边、DOM 层画标签）
布局层   自写：小图全对 / 大图 Barnes-Hut（阈值 1000）+ 确定性布局（层级/径向/时间线）
交互层   focus.ts（取景）+ camera-rig（动画）+ edge-flex（弯曲）+ labels（避让）
```

### 2.3 为什么不选 X

| 方案 | 否决理由（可核实） |
|---|---|
| **3d-force-graph / react-force-graph / three-forcegraph** | 布局与渲染绑死：`forceEngine('d3'|'ngraph')` 全有全无，`d3Force()` 只能改力参数，**没有"布局只跑一次 + 增量更新"的入口**。而本项目 10k 实测结论正是"不能每帧重算"。React 版本还自带 React 依赖。`[S-12][L-5]` |
| **sigma.js** | 2D 平面渲染器：`Settings` 里没有相机四元数、没有透视、没有 3D 拾取。但其 `labelDensity / labelGridCellSize / labelRenderedSizeThreshold / hideLabelsOnMove` 值得抄进标签层。`[S-13]` |
| **cytoscape.js** | 强项是图论式交互（框选、复合节点、布局插件），弱项恰是我们要的 3D/GPU instancing/相机转场。`[S-14]` |
| **@cosmograph/cosmograph** | **许可证硬否决**：`CC-BY-NC-4.0`（非商业）。桌面应用若商用分发，NC 是硬约束。`[S-11]` |
| **@antv/g6** | 能力对得上，但抽象是"图元素 + 布局插件"，与"投影驱动的确定性布局 + 物理 worker 二选一"不一致；自带主题体系会与 vendored 渲染器外观冲突。`[S-15]` |
| **d3-force 直接用** | 只借其 Barnes-Hut 判据与 θ 默认值；它只有 2D 四叉树，没有 3D、没有碰撞网格、没有固定节点。`[S-16]` |

---

## 3. (A) 交互与算法细则

### 3.1 相机取景：闭式距离解

参考 `memora/frontend/focus.ts:150-160`。`[L-1]`

```
dir   = (sin(polar)·sin(azimuth), cos(polar), sin(polar)·cos(azimuth))
right = normalize(dir.z, 0, −dir.x)
up    = dir × right
相机空间：x = p·right, y = p·up, z = p·dir
可见条件：(|x| + r) ≤ (distance − z) · tanX · freeX
need_i   = max( (|x_i|+r_i)/(tanX·freeX), (|y_i|+r_i)/(tanY·freeY) ) + z_i
distance = max_i need_i          # 闭式，一次遍历
```

防过冲地板（单节点点击不填满窗口）：

```
floor    = radius / (maxFill · min(tanX·freeX_plain, tanY·freeY_plain))
distance = max(fitted · margin, floor, minDistance)
```

`margin = 1.12`（点击）/ `1.08`（总览）；`maxFill = 0.72`（默认）/ `6`（总览显式放开）；
`freeX/freeY` 已扣面板占位与右侧标签预留 `reserveRight = clamp(0.16·width, 56, 180)`。

**投影盒居中**（不是包围球）：若投影盒中心偏离窗口中心 `(cX, cY)`（NDC），目标点沿 right/up 平移

```
shiftX = cX · distance · tanX
shiftY = cY · distance · tanY
```

参考实现最多 64 次"溢出则 distance ×= 1.06、否则平移居中"——平移会微调各点深度，二者耦合收敛。

### 3.2 视角搜索：24 × 7 打分

`focus.ts:317-394`。`[L-1]`

```
for polar in [0.3, 0.55, 0.8, 1.05, 1.3, 1.55, 1.8]:     # 7 个俯仰
  for step in 0..23:                                     # 24 个方位
    pose    = frameCluster(spheres, azimuth, polar, viewport, {reserveRight: 0})
    cover   = min(1, fill.x)*0.5 + min(1, fill.y)*0.5    # 装得满
    balance = 1 − min(1, |fill.x − fill.y|)              # 不是一条线
    score   = cover*0.62 + balance*0.38
eligible = { c : score(c) ≥ max(score) − 0.34 }
best     = 无 bias：eligible 中 score 最高
           有 bias（层级）：argmax bias，bias 相等按 score
downwardness = Σ(parent_h − child_h) / Σ|parent_h − child_h|
```

**打分时故意不扣标签预留**：边对边塌成一条线的方向"需要的地方少"，在扣预留的窗口里反而显得占得多，会骗过打分。

**成本**：168 次 `frameCluster`，每次 O(n) 且内含至多 64 次投影盒迭代。只在"settled 后 + 650 ms"跑一次，以及点按钮时再跑。`[L-7]`

### 3.3 相机转场：slerp + 对数距离

参考 `obsidian-3d-mindmap/original-dev/src/camera/camera-rig.ts:253-390`。`[L-6]`

状态：`{pivot, orientation(quaternion), offset(相机在自身坐标系相对 pivot 的偏移), fov}`，
渲染位置 = `pivot + orientation * offset`。绕 pivot 转只改 orientation，相机走弧线不切弦。

```
t = min(1, (now − start)/duration)
e = easeInOut(t) = t < 0.5 ? 4t³ : 1 − (−2t+2)³/2
pivot       = lerp(from.pivot, to.pivot, e)
orientation = slerp(from.orientation, to.orientation, e)         # 永远短路
dir         = normalize(lerp(normalize(from.offset), normalize(to.offset), e))
distance    = exp( ln(la) + (ln(lb) − ln(la))·e )                # 对数插值
fov         = lerp(from.fov, to.fov, e)

阻尼（无动画时）：a = smoothingMs ≤ 0 ? 1 : 1 − exp(−dt/smoothingMs)   # τ 默认 90 ms
```

**任何用户输入立刻取消动画**：`interrupt()` 清空 flight 并把 goal 同步为 cur，转的时候点一下就停在那里。

**约定陷阱**：`{pivot, orientation, offset}` 与 `{radius, azimuth, polar}` 不能混用；
两者互转的公式在参考实现 `toSpherical/fromSpherical` 里（`azimuth = atan2(d.z, d.x)`，`polar = acos(d.y/radius)`）。

### 3.4 边的柔性弯曲与伸缩

参考 `memora/frontend/edge-flex.ts:13-100` 与实测 `artifacts/p9-bestview-flex/REPORT.md`。`[L-2][M-1]`

```
axis   = normalize(b − a)
facing = min(1, |axis · view|)            # 0 = 横在屏幕，1 = 正对镜头
side   = normalize(axis × view)           # 垂直于边且在屏幕平面内
floor  = max(|baked|, len · BASE_BOW)
bow    = floor + len · FACING_BOW · facing²
swing  = facing²
keep   = 1 − swing·(1 − BAKED_DIRECTION_KEEP)
dirOut = bakedDir ? normalize(bakedDir·keep + side·swing) : side
control = midpoint + dirOut · bow
```

| 常量 | 值 | 标定理由 |
|---|---|---|
| `FACING_BOW` | 0.18 | <0.10 时正对边弯曲 <1 px 看不见；>0.28 会被误认为烘焙弧 |
| `BASE_BOW` | 0.03 | 直线边静息弯曲，保持"关系图"观感 |
| `BAKED_DIRECTION_KEEP` | 0.35 | 侧对时保留多少烘焙方向 |

两条工程约束：

1. **形变是派生的**：`graph.edges[i].control` 永不回写（参考项目有断言）。
2. **量纲**：`controlRatio`（控制点偏移比）= 2 × `sagittaRatio`（曲线实际深度比）——
   二次贝塞尔只走到控制点一半。烘焙的 0.16 在 buffer 里量出来是 0.08。

**落地位置不同，成本差三个数量级**：

| 渲染器 | 做法 | 每帧成本 |
|---|---|---|
| LineSegments | CPU 重写 `position`（14 段采样），节流 ≤12000 顶点 28 ms / ≤40000 55 ms / 更大 90 ms，相机角变化 <0.012 rad 不重算 | 0.0003 ms/次重写（26 边 728 顶点，2000 次平均） |
| instanced shader | 顶点着色器用 three 内置 `cameraPosition` 算控制点 `[L-11]` | **零 CPU** |

### 3.5 标签避让（两套实现取并集）

**方案 A：分级 + 4 方向候选 + 细网格**（`.../render/labels.ts:131-245`）`[L-3]`

```
1) 投影 world→view→clip→NDC→屏幕；d = −vz，d ≤ camera.near 丢
2) 视锥外剔除：|nx| > 1.1 或 ny ∉ [−1.1, 1.15] 丢
3) 排序 key = tier·1e9 + depth
   tier: selected=0, important=1, related=2, chapter=3, topic=4, normal=5, outOfFocus=8
4) 占用网格 cellW=8px, cellH=max(6, fontSize·0.6)
5) 依序试 4 个位置：上 / 下 / 右 / 左
   命中空格 → 占格采用；四撞 → tier ≤ selected 允许重叠，否则隐藏
6) DOM 池化复用（按 id 绑定），只改 transform/opacity
7) 字号随深度：scale = clamp(1 − depth/maxDistance·0.45, 0.6, 1.15)
```

**方案 B：优先级 + 16px 网格**（`memora/frontend/graph-look.ts:113-135`）`[L-4]`

```
sort by (priority, top, left)      priority: 0=selected, 1=neighbour, 3=ordinary
priority ≤ 1 → 无条件保留并占格
否则：任一格被占 → 丢弃；否则占格保留
```

两者共同点：**焦点优先、普通让位、网格降复杂度**。

### 3.6 力导向参数：三套可核实的默认值

| 实现 | θ | 关键参数 | 来源 |
|---|---|---|---|
| d3-force `forceManyBody` | 0.9（代码里 `theta2 = 0.81`，getter 返回 `sqrt`） | `strength = −30`、`distanceMin² = 1`、`distanceMax² = ∞`；判据 `w²/θ² < l` | `[S-16]` `src/manyBody.js` |
| graphology-layout-forceatlas2 | 0.5（`barnesHutTheta`） | `barnesHutOptimize=false`、`gravity=1`、`scalingRatio=1`、`slowDown=1`、`linLogMode=false`、`strongGravityMode=false`；判据 `(4s²)/distance < θ²` | `[S-17]` |
| 本地 js-engine | 0.85 | `attraction=0.12`、`link_distance=gap+13`、`gravity=0.002`、`damping=0.78`、`max_velocity=45`、`dt=0.4`、`alpha_min=0.002` | `[L-5]` `layout-engine.ts:45-52` |

**θ 有两种写法**：d3 存的是 `θ² = 0.81`（θ=0.9），FA2 的 `θ = 0.5` 直接比较。
照抄数字而不看判据形式，会得到完全不同的近似精度。

退火与停止条件：

```
temperature *= (1 − cooling)
calm = (kineticEnergy < alpha_min) ? calm + 1 : 0
stop when calm ≥ calm_steps            → STOP_SETTLED
        or temperature < min_temperature → STOP_COOLED
```

碰撞用 `[L-10]` 说明："半固定"权重：`fixed[i]` 不动、配对节点吃满修正（权重 2）；重合点对用确定性方向分离：

```
a = (i·7 + j·13 + pass) · GOLDEN_ANGLE
d = (cos a, 0.35·sin(0.7a), sin a)
```

### 3.7 确定性布局族（层级/径向/时间线的基础件）

来源 `original-dev/src/layout/{common,structure-layouts,study-layouts}.ts`。`[L-5][L-12]`

| 算法 | 核心公式 | 用途 |
|---|---|---|
| 径向树扇区分配 | 子树权重 `w = max(1, (Σw_child)^0.85)`（次线性，防大分支饿死小分支）；`sector_child = sector_parent × w_child/Σw` | 词义/层级放射状 |
| 拥挤层交错环 | `need = max(base, (2r+sGap)/Δsector)`、`k = ceil(need/base)` 上限 16、`inner = max(base, need/k)`、`ring = inner+(k−1)·subStep` | 一层太密时不吹爆半径 |
| 锥树（Robertson） | `R = max(Σdemand/2π, max_相邻 (f_k+f_j+sGap)/(2·sin(min(π/2, θ_ij/2))))` | 3D 层级脑图 |
| Tidy tree（shelf-pack） | 每子树算 footprint 盒，子节点按文档序货架打包，宽兄弟折行 | 层级脑图 |
| 压缩深度 | `compressedDepth(d) = d ≤ 8 ? d : 8 + log2(d−7)` | 深链不线性爆炸 |
| 蛇形块 | `perRow = ceil(√members)`，偶数行正序、奇数行逆序 | 超深子树折叠 |
| 圆盘不重叠 | 成对推离 `push = (r_i+r_j+gap) − d`；>64 盘改用 `PointGrid` 邻域对 | 章节/簇摆放，带"记忆位" |
| D3 tidy tree | Reingold–Tilford 的 `prelim/mod/change/shift`（`moveSubtree`、`executeShifts`） | 标准 2D 紧凑树 |

> 若要标准 tidy-tree，可直接用 `d3-hierarchy@3.1.2`（ISC）的 `tree()`，与上面同源。`[S-18]`

---

## 4. (A) 性能预算表与降级策略

### 4.1 本机实测：力导向与碰撞（原始数据）

脚本 `.research/bench_bh.mjs` `[M-9]`，Node v24.15.0 / win32，float64 纯 JS，θ = 0.85，
每档多次重复取平均（≤2000 节点 20 次，>2000 节点 8 次，全对 3 次）。
节点分布用 Fibonacci 球面（与参考引擎的初始化同源），碰撞网格 cellSize = 60。

```
$ node bench_bh.mjs
{
 "theta": 0.85, "node": "v24.15.0", "platform": "win32",
 "rows": [
  { "n": 500,   "bh_ms": 0.81,  "allpairs_ms": 0.38, "grid_ms": 0.34 },
  { "n": 1000,  "bh_ms": 1.23,  "allpairs_ms": 1.41, "grid_ms": 0.23 },
  { "n": 2000,  "bh_ms": 2.60,  "allpairs_ms": 6.87, "grid_ms": 0.45 },
  { "n": 5000,  "bh_ms": 7.42,  "allpairs_ms": "skipped", "grid_ms": 0.82 },
  { "n": 10000, "bh_ms": 17.19, "allpairs_ms": "skipped", "grid_ms": 1.57 }
 ]
}
```

**读法（三条，直接决定实现）**：

1. **交叉点在 500–1000**。500 节点全对 0.38 ms，比 BH 的 0.81 ms 更快——八叉树的建树与递归常数在小图上亏。
   1000 节点持平。**阈值取 1000**：小于 1000 用全对，否则 BH。
2. **BH 的增长是近线性的**：500→10000（20 倍）耗时 0.81→17.19（21.2 倍）。符合 O(n log n) 形状。
3. **碰撞网格极便宜**：10k 节点 1.57 ms。**碰撞永远开得起，不要为省它牺牲可读性**（重叠的球让脑图失去可读性）。

### 4.2 参考项目的实测数字（同机、软件光栅化）

来自 `memora/artifacts/p9-bestview-flex/{REPORT.md,report.json}`。`[M-1][L-9]`

| 指标 | 数值 | 测量条件 |
|---|---|---|
| flex 单次重写 | **0.0003 ms**（26 边 / 728 顶点 / 2000 次平均） | 离屏 Electron + `disableHardwareAcceleration()` |
| 节流间隔自适应 | ≤12000 顶点 → 28 ms；≤40000 → 55 ms | 400 节点/871 边实测自动放宽到 55 ms |
| demo 帧时间（有 flex） | p50 30.4 ms / p95 51.4 ms | 相机持续 0.06 rad/帧 旋转 |
| demo 帧时间（无 flex） | p50 28.7 ms / p95 50.5 ms | 同上 |
| 400 节点帧时间（有/无 flex） | p50 57.5 / 57.7 ms；p95 87.5 / 87.5 ms | 同上 |
| 屏幕弯曲量 | 4.83–19.68 px（均值 10.34） | 24 条边 |

**重要方法论教训**（报告里如实保留）：这条帧率断言红过两次。第一次是真实性能问题
（`rewrite()` 末尾多调了一次 `scene.update()`，等于每次重写后又整帧渲染）；第二次是**测法问题**——
两个对照基线自己相差 35%（41 vs 55.6 ms），而待测效应是 18.5 ms，"噪声比信号大"，
任何基于单次 p95 的阈值都会 flaky。最终把帧率降级为**只记录不断言**，
改用绝对量断言"单次重写 < 3 ms"。

> **对本项目的直接建议**：性能验收只写绝对量断言（单次重写耗时、单帧 CPU 预算），
> 不要把"p95 < X ms"写成硬断言——在没有 GPU 的 CI 环境里它必然 flaky。

### 4.3 10k 节点 / 50k 边的 60 fps 预算表

目标：**交互帧 16.7 ms**（60 fps），布局不参与每帧计算。

| 项 | 预算 | 手段 | 依据 |
|---|---|---|---|
| 节点绘制 | ≤ 2 ms | `InstancedMesh` 单 draw call（`instanceMatrix` 每节点 16 float） | three `InstancedMesh.js`：`setMatrixAt(i, m)` 写 `instanceMatrix.array`；改完置 `instanceMatrix.needsUpdate = true` `[S-19]` |
| 边绘制 | ≤ 2 ms | `InstancedBufferGeometry` + 顶点着色器算贝塞尔（参考实现已证"零 CPU"） | `[L-2]` |
| 节点缩放/实例矩阵更新 | ≤ 3 ms | 只在相机或布局变化时写；静止帧跳过 | 参考实现 `thresholdRadians = 0.012` 的"没转就不重算" |
| 标签布局 | ≤ 2 ms | 8 px 粗网格 + 池化 DOM；`O(n log n)` 排序 | `[L-3]` |
| 拾取（hover/click） | ≤ 1 ms | 颜色拾取层按 1/2 降采样（sigma 的 `pickingDownSizingRatio: 2`） | `[S-13]` |
| 布局（**不在帧内**） | 一次性 ≤ 400 ms | 10k 节点 BH 单步 17.19 ms × ~20 步；用 worker 跑 | 本机实测 4.1 |
| 碰撞（**不在帧内**） | 一次性 ≤ 5 ms | 10k 节点网格 1.57 ms × 少量 pass | 本机实测 4.1 |
| 预留 | ≥ 6 ms | 浏览器合成、GC、事件 | — |

**必须在帧外（worker 或 idle）完成的四件事**：力导向迭代、碰撞分离、确定性布局重算、视角搜索（168 次 frameCluster）。

**LOD 策略（四级）**：

| 级别 | 触发 | 行为 |
|---|---|---|
| L0 全量 | 相机静止 | 全节点 + 全边 + 标签（受 budget 限制） |
| L1 移动中 | 相机旋转/缩放 | `hideEdgesOnMove` / `hideLabelsOnMove`（sigma 的同一组开关）`[S-13]` |
| L2 远景 | 节点屏幕半径 < 1.5 px | 该节点降级为点精灵，标签 tier > chapter 的直接不投 |
| L3 极远 | 屏幕半径 < 0.5 px | 整簇折叠为一个聚合节点（聚类折叠），点击才展开 |

**增量更新（不重跑全局布局）**：
新节点从父节点位置 + 确定性抖动起步（参考实现 `jitter(id, radius*3+4)` 用 id 哈希），
只对"新节点 + 一跳邻居"施加热量；参考实现按原因分温度：`edit 0.3 / expand 0.55 / open 1.0`。`[L-5]`

### 4.4 降级阶梯（与项目"绝不伪造成功"原则对齐）

脑图是**投影**，不是真源（`docs/MEMORY-MODEL.md` §12 明确"不把空间距离当语义关系"）。
因此降级必须逐级可见：

| 级别 | 条件 | 行为 | 界面必须显示 |
|---|---|---|---|
| D0 正常 | 全量数据 + GPU | 完整布局 + 平滑动画 | 无 |
| D1 大图 | 节点 > 5000 | 关动画、LOD 降到 L2、布局改后台 | "大图模式：已关闭动画与部分标签" |
| D2 无 GPU | WebGL 上下文创建失败 | 退 2D Canvas 视图（时间线/层级为主） | "3D 不可用，已切换到 2D 视图" + 原因 |
| D3 布局超时 | worker 超过预算 | 保留上次布局坐标，标注"坐标可能过期" | "布局未完成，显示的是上一次的结果" |
| D4 无数据 | 图空 | 显示空态，不画假节点 | 空态文案 |

**绝不做的三件事**：不在无数据时渲染占位节点、不在布局失败时随机散布节点冒充"已布局"、
不在降级时隐藏降级标记。

---

## 5. (B) MCP 协议握手与帧格式（逐字，可直接照抄实现）

### 5.1 三个版本的差异表

**权威来源**：规范索引 `[S-1]`；`schema/<ver>/schema.ts` 的导出符号集合差分 `[S-2]` + 各版本 `changelog.mdx` `[S-6][S-7]`。

| 维度 | 2024-11-05 | 2025-03-26 | 2025-06-18 |
|---|---|---|---|
| `LATEST_PROTOCOL_VERSION` | `"2024-11-05"` | `"2025-03-26"` | `"2025-06-18"` |
| schema 导出符号数 | 86 | 90 | 98 |
| HTTP 传输 | HTTP+SSE（双端点） | **Streamable HTTP**（单端点） | Streamable HTTP + 强制 `MCP-Protocol-Version` 头 |
| JSON-RPC 批量 | 不支持 | **支持** | **移除** |
| 授权 | 无 | OAuth 2.1 框架 | OAuth + Resource Server 分类 + RFC 8707 Resource Indicators |
| 工具注解 | 无 | `ToolAnnotations`（`readOnlyHint` 等） | 同 2025-03-26 |
| 结构化输出 | 无 | 无 | `outputSchema` + `structuredContent` |
| 新增内容类型 | text, image | + `AudioContent` | 同 2025-03-26 |
| 新增交互模式 | — | — | **Elicitation**（服务端向用户要补充信息） |
| 资源链接 | — | — | `ResourceLink` |
| 会话头 | — | `Mcp-Session-Id` | `Mcp-Session-Id` + `MCP-Protocol-Version` |

**符号级差分（逐字取自 schema.ts 导出）**：

```
2025-03-26 相对 2024-11-05：
  新增  Annotations, ToolAnnotations, AudioContent, JSONRPCBatchRequest, JSONRPCBatchResponse
  删除  Annotated

2025-06-18 相对 2025-03-26：
  新增  BaseMetadata, ContentBlock, ElicitRequest, ElicitResult,
        ResourceLink, ResourceTemplateReference,
        PrimitiveSchemaDefinition, StringSchema, NumberSchema, BooleanSchema, EnumSchema
  删除  JSONRPCBatchRequest, JSONRPCBatchResponse, ResourceReference
```

> `JSONRPCBatch*` 的"加了又删"是本表最有价值的一行：**任何为批量写的兼容代码在两个版本之间都是死代码**。

**changelog 原文要点**（`[S-6][S-7]`）：

- 2025-06-18 九条主要变更，第 1 条即"Remove support for JSON-RPC batching"；第 8 条
  "Require negotiated protocol version to be specified via `MCP-Protocol-Version` header in subsequent requests when using HTTP"；
  第 9 条 "Change **SHOULD** to **MUST** in Lifecycle Operation"。
- 2025-03-26 四条主要变更：OAuth 2.1 框架、Streamable HTTP 取代 HTTP+SSE、加入批量、工具注解。

### 5.2 错误码（三版完全一致，逐字）

```ts
export const PARSE_ERROR      = -32700;
export const INVALID_REQUEST  = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS   = -32602;
export const INTERNAL_ERROR   = -32603;
```

来源 `schema.ts` 第 80-84（2024-11-05）/ 99-103（2025-03-26）/ 109-113（2025-06-18）行。

**唯一的 MCP 专属错误码**（不在 schema 常量里，在 resources 规范正文）：

```
-32002  Resource not found      （resources/read 找不到目标资源）
-32603  Internal errors
```

来源 `docs/specification/2025-06-18/server/resources.mdx:376-388`。`[S-8]`

### 5.3 initialize 握手（逐字）

**客户端发**（`lifecycle.mdx:53-74`）`[S-4]`：

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2025-06-18",
    "capabilities": {
      "roots": { "listChanged": true },
      "sampling": {},
      "elicitation": {}
    },
    "clientInfo": { "name": "ExampleClient", "title": "Example Client Display Name", "version": "1.0.0" }
  }
}
```

**服务端回**：

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": "2025-06-18",
    "capabilities": {
      "logging": {},
      "prompts": { "listChanged": true },
      "resources": { "subscribe": true, "listChanged": true },
      "tools": { "listChanged": true }
    },
    "serverInfo": { "name": "ExampleServer", "title": "Example Server Display Name", "version": "1.0.0" },
    "instructions": "Optional instructions for the client"
  }
}
```

**客户端再发**：

```json
{ "jsonrpc": "2.0", "method": "notifications/initialized" }
```

**三条时序硬规则**：

- 客户端在服务端回应 `initialize` 前 **SHOULD NOT** 发除 ping 外的请求；
- 服务端在收到 `notifications/initialized` 前 **SHOULD NOT** 发除 ping 与 logging 外的请求；
- 版本协商：服务端若不支持请求的版本，**MUST** 回一个自己支持的版本（**SHOULD** 是最新的）；
  客户端若不支持服务端回的版本 **SHOULD** 断开。

**版本不匹配的错误样例**（`lifecycle.mdx:231-243`）：

```json
{
  "jsonrpc": "2.0", "id": 1,
  "error": {
    "code": -32602,
    "message": "Unsupported protocol version",
    "data": { "supported": ["2024-11-05"], "requested": "1.0.0" }
  }
}
```

**能力字段完整清单**（`schema.ts` `ServerCapabilities` / `ClientCapabilities`，逐字；`_meta` 保留规则见基础协议 `[S-5]`）：

```ts
interface ServerCapabilities {
  experimental?: { [key: string]: object };
  logging?: object;
  completions?: object;
  prompts?:    { listChanged?: boolean };
  resources?:  { subscribe?: boolean; listChanged?: boolean };
  tools?:      { listChanged?: boolean };
}
interface ClientCapabilities {
  experimental?: { [key: string]: object };
  roots?:      { listChanged?: boolean };
  sampling?:   object;
  elicitation?: object;
}
```

### 5.4 stdio 帧格式（逐字规则）

`transports.mdx:20-48`。`[S-3]`

```
1. 客户端把 MCP 服务端拉成子进程
2. 服务端从 stdin 读 JSON-RPC 消息、往 stdout 写
3. 消息是一个个 JSON-RPC request / notification / response
4. 消息以换行分隔，且 MUST NOT 含内嵌换行
5. 服务端 MAY 往 stderr 写 UTF-8 日志（客户端 MAY 采集/转发/忽略）
6. 服务端 MUST NOT 往 stdout 写任何非 MCP 消息
7. 客户端 MUST NOT 往服务端 stdin 写任何非 MCP 消息
```

**实现要点（Python）**：

```python
# 正确：一行一个 JSON，flush
sys.stdout.write(json.dumps(msg, ensure_ascii=False) + "\n")
sys.stdout.flush()

# 必须做的防护：把 stdout 重定向到 stderr，杜绝任何库的 print 污染协议流
import sys, os
_protocol_out = os.fdopen(os.dup(1), "w", encoding="utf-8", newline="\n")
os.dup2(2, 1)
```

**关闭时序**（`lifecycle.mdx:186-197`）：客户端 **SHOULD** 先关子进程 stdin → 等服务端退出
→ 超时发 `SIGTERM` → 再超时 `SIGKILL`。

### 5.5 Streamable HTTP（逐字规则 + 时序）

`transports.mdx:50-238`。`[S-3]`

**单端点**：服务端 **MUST** 提供**一个** HTTP 路径同时支持 POST 与 GET（如 `https://example.com/mcp`）。

**安全三条**：
1. 服务端 **MUST** 校验 `Origin` 头（防 DNS rebinding）；
2. 本地运行时 **SHOULD** 只绑 `127.0.0.1`；
3. **SHOULD** 实现鉴权。

**客户端 POST 规则**：

```
1. MUST 用 POST
2. MUST 带 Accept，同时列 application/json 与 text/event-stream
3. body MUST 是单个 JSON-RPC request / notification / response
4. 若 body 是 response 或 notification：
     接受 → 返回 202 Accepted，无 body
     不接受 → 返回 HTTP 错误码（如 400），body MAY 是 id 为空的 JSON-RPC error
5. 若 body 是 request：
     返回 Content-Type: text/event-stream（开 SSE 流）或 application/json（一个 JSON 对象）
     客户端 MUST 两种情况都支持
6. 若开 SSE 流：
     SHOULD 最终在流里给出该 request 的 JSON-RPC response
     MAY 在 response 之前先发 request/notification（SHOULD 与本次请求相关）
     SHOULD NOT 在发 response 之前关流（除非会话过期）
     response 发出后 SHOULD 关流
     断线 SHOULD NOT 被解释为客户端取消；取消应显式发 CancelledNotification
```

**客户端 GET 规则**：

```
1. MAY 发 GET 打开 SSE 流（不需要先 POST）
2. MUST 带 Accept: text/event-stream
3. 服务端 MUST 返回 text/event-stream，或 405 Method Not Allowed
4. 若开流：MAY 发 request/notification（SHOULD 与并发请求无关）；
   MUST NOT 在流上发 response（除非在恢复某个先前请求的流）
```

**多连接**：客户端 MAY 同时连多条 SSE 流；服务端 **MUST** 保证每条消息只发在一条流上（**MUST NOT** 广播）。

**可恢复性**：

```
SSE event 可带 id（MUST 在整个 session 内全局唯一）
客户端重连：GET + Last-Event-ID 头
服务端 MAY 用它重放该流上断点之后的消息；MUST NOT 重放别的流上的消息
```

**会话管理**：

```
1. 服务端 MAY 在 InitializeResult 的 HTTP 响应里带 Mcp-Session-Id 头
   - SHOULD 全局唯一且密码学安全（UUID / JWT / 加密哈希）
   - MUST 只含可见 ASCII（0x21–0x7E）
2. 若服务端发了，客户端 MUST 在后续所有 HTTP 请求里回带
   - 要求会话的服务端 SHOULD 对缺头的请求（除 initialize）回 400
3. 服务端 MAY 随时终止会话，之后 MUST 对该 session id 的请求回 404
4. 客户端收到 404 MUST 重新发不带 session id 的 InitializeRequest
5. 客户端不再需要会话时 SHOULD 发 DELETE + Mcp-Session-Id；服务端 MAY 回 405
```

**协议版本头**：

```
客户端 MUST 在后续所有请求上带 MCP-Protocol-Version: <version>（如 2025-06-18）
值 SHOULD 是 initialize 协商出来的那个
服务端收不到该头且无其它途径判断版本时，SHOULD 假定 2025-03-26
服务端收到非法/不支持的值 MUST 回 400 Bad Request
```

**时序图**（`transports.mdx:201-238` 的 mermaid，转文字）：

```
Client → POST InitializeRequest
Server → InitializeResponse + Mcp-Session-Id: 1868a90c...
Client → POST InitializedNotification + Mcp-Session-Id
Server → 202 Accepted
Client → POST ...request... + Mcp-Session-Id
   alt 单次 HTTP 响应
     Server → ...response...
   else 服务端开 SSE 流
     Server →(SSE)...messages...
     Server →(SSE)...response...
   end
Client → POST ...notification/response... + Mcp-Session-Id
Server → 202 Accepted
Client → GET + Mcp-Session-Id
   loop 连接保持期间
     Server →(SSE)...messages...
   end
```

**对旧版 HTTP+SSE 的兼容探测**（`transports.mdx:259-286`；旧传输的双端点与 `endpoint` 事件见 2024-11-05 版 `[S-23]`）：

```
1. 拿到 URL，先 POST InitializeRequest（带上述 Accept）
2. 成功 → 新 Streamable HTTP
3. 失败于 4xx（405 / 404）→ GET 该 URL，期待首事件是 endpoint
   endpoint 到达 → 判定为旧 HTTP+SSE，后续全部走旧传输
```

### 5.6 tools / resources / prompts 方法名（逐字）

| 能力 | 方法 | 通知 | 来源 |
|---|---|---|---|
| tools | `tools/list`（支持 `cursor` 分页，返回 `nextCursor`）、`tools/call` | `notifications/tools/list_changed` | `[S-20]` |
| resources | `resources/list`、`resources/read`、`resources/templates/list`、`resources/subscribe` | `notifications/resources/list_changed`、`notifications/resources/updated` | `[S-8]` |
| prompts | `prompts/list`、`prompts/get` | `notifications/prompts/list_changed` | `[S-21]` |

**`Tool` 结构（2025-06-18 schema，逐字）**：

```ts
interface Tool extends BaseMetadata {
  description?: string;
  inputSchema: { type: "object"; properties?: { [k: string]: object }; required?: string[] };
  outputSchema?: { type: "object"; properties?: { [k: string]: object }; required?: string[] };
  annotations?: ToolAnnotations;
  _meta?: { [k: string]: unknown };
}
interface Implementation extends BaseMetadata { version: string }   // BaseMetadata 提供 name + title
```

**工具结果两种形态**：`content`（text / image / audio / resource link / embedded resource）
与 `structuredContent`（JSON，配合 `outputSchema`）；执行错误用 `isError: true` 放在结果里，
**不是** JSON-RPC error（协议层错误才用 -32xxx）。`[S-20]`

---

## 6. (B) 三大宿主的接入配置文件与 hook 载荷字段表

> 本节全部字段取自官方文档正文或本机真实文件，路径逐字。**未在本机跑通「注册 → 首次调用」的环节标为未核实。**

### 6.1 Claude Code

#### 6.1.1 配置落点（三种 scope，逐字）

来源 Claude Code 官方文档 MCP 页 `[S-9]`：

| Scope | 适用范围 | 进版本控制 | 文件 |
|---|---|---|---|
| `local`（默认） | 仅当前项目、仅本人 | 否 | `~/.claude.json` 里 `projects["<项目路径>"].mcpServers` |
| `project` | 当前项目所有人 | 是 | 项目根 `.mcp.json` |
| `user` | 本机所有项目 | 否 | `~/.claude.json` |

> **易错点**：MCP 的「local scope」与一般设置的「local」**不是同一个文件**。
> MCP local 存在家目录 `~/.claude.json`；一般 local 设置是项目里的 `.claude/settings.local.json`。

#### 6.1.2 最小可用片段

**项目级 `.mcp.json`（推荐给 memora-core，可随仓库分发）**：

```json
{
  "mcpServers": {
    "memora": {
      "type": "stdio",
      "command": "python",
      "args": ["-m", "memora_core", "--data", "<数据目录>", "mcp-stdio"],
      "env": { "MEMORA_HOME": "<数据目录>" }
    }
  }
}
```

> stdio 条目的 `type` 可省略（裸 `command`/`args` 即 stdio），显式写 `"type":"stdio"` 也合法（官方 `add-json` 示例即两种都有）。

**本地/用户级（写进 `~/.claude.json`，注意多一层 `projects`）**：

```json
{
  "projects": {
    "/path/to/your/project": {
      "mcpServers": {
        "stripe": { "type": "http", "url": "https://mcp.stripe.com" }
      }
    }
  }
}
```

（上例是官方文档原文，用来示范 `projects["<path>"].mcpServers` 这一层结构。）

**HTTP 型（指向已常驻的中枢）**：

```json
{
  "mcpServers": {
    "memora-http": {
      "type": "http",
      "url": "http://127.0.0.1:8790/mcp",
      "headers": { "Authorization": "Bearer ${MEMORA_TOKEN}" }
    }
  }
}
```

#### 6.1.3 字段表（`mcpServers.<name>`）

| 字段 | 类型 | 说明 |
|---|---|---|
| `type` | `"stdio"` / `"http"` / `"sse"` / `"ws"` | 传输方式 |
| `command` | string | stdio 可执行文件 |
| `args` | string[] | stdio 参数 |
| `env` | object | 传给子进程的环境变量 |
| `url` | string | http/sse/ws 端点 |
| `headers` | object | 鉴权头 |
| `headersHelper` | string | 连接时生成头的本地命令 |
| `timeout` | number | 超时 |
| `alwaysLoad` | boolean | 始终加载 |
| `oauth` | object | 预配置 OAuth 客户端（`clientId` / `callbackPort`），HTTP 型可用 |

**环境变量展开**：`command` / `args` / `env` / `url` / `headers` 支持 `${VAR}` 与 `${VAR:-default}`；
未设置且无默认值时**不报错**，用原文当值（`claude mcp list` 会警告）。
**凭证变量读作空串**（`ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `AWS_BEARER_TOKEN_BEDROCK` 等），
且 `:-` 默认值被忽略——防止 `.mcp.json` 把你的凭证发给第三方服务器。

**Claude Code 给子进程注入的环境变量**：`CLAUDE_PROJECT_DIR`（项目根）。
在 `.mcp.json` 里引用它必须写默认值：`${CLAUDE_PROJECT_DIR:-.}`。

#### 6.1.4 stdio 关闭时序（Windows 与 POSIX 不同）

- macOS / Linux：`SIGINT` → 100 ms 后 `SIGTERM` → 再 400 ms 后 `SIGKILL`；
- **Windows：先关 stdin，300 ms 后结束进程树**（v2.1.296 之前是直接结束进程树）。

对 memora-core 的含义：**服务端必须在 stdin EOF 时优雅退出**，否则 Windows 上会被杀进程树。

#### 6.1.5 hook 载荷字段表

**hook 配置形状**（settings 文件的 `hooks` 键）：

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup",
        "hooks": [
          { "type": "command", "command": "/path/to/memora-hook.sh", "timeout": 10 }
        ]
      }
    ]
  }
}
```

**五种 handler 类型**（逐字）：`"command"` / `"http"` / `"mcp_tool"` / `"prompt"` / `"agent"`。
`http` 把事件 JSON 当 POST body 发给 URL——**对 memora-core 最省事：直接 `POST /api/hooks`，不用装脚本**。

**公共输入字段（所有事件都有）**：

| 字段 | 类型 | 说明 |
|---|---|---|
| `session_id` | string | 当前会话 id |
| `prompt_id` | string(UUID) | 当前处理的用户 prompt id，首次输入前不存在 |
| `transcript_path` | string | 对话 JSONL 路径（**异步写，可能落后于内存中的对话**） |
| `cwd` | string | 调用 hook 时的工作目录 |
| `scratchpad_dir` | string | 会话临时目录（v2.1.257+，可能不存在） |
| `permission_mode` | enum | `default`/`plan`/`acceptEdits`/`auto`/`dontAsk`/`bypassPermissions` |
| `effort` | `{level}` | `low`/`medium`/`high`/`xhigh`/`max`，仅工具上下文事件有 |
| `hook_event_name` | string | 事件名 |
| `agent_id` | string | 子智能体/团队成员的 id（有则给） |
| `agent_type` | string | 智能体类型名（有则给） |

> `transcript_path` 的异步性很重要：**不要用它拿「本轮最终回复」**，用 `Stop` 事件的 `last_assistant_message`。

**四个必查事件的专属字段**：

| 事件 | 专属字段 | 说明 |
|---|---|---|
| `SessionStart` | `source`（`startup`/`resume`/`clear`/`compact`/`fork`）、`model`、`agent_type`、`session_title` | 会话开始/恢复；**每会话必跑，要保持快** |
| `UserPromptSubmit` | `prompt`、`session_title`（有自定义标题时） | 用户提交 prompt 后、Claude 处理前 |
| `Stop` | `stop_hook_active`、`last_assistant_message`、`background_tasks[]`、`session_crons[]` | `stop_hook_active` 为真表示「已因 stop hook 在续跑」 |
| `PreCompact` | `trigger`（`manual`/`auto`）、`custom_instructions` | 上下文压缩前 |

**输出与退出码语义**：

```
exit 0  → 成功；stdout 若「整段恰好一个 JSON 对象」则按 JSON 解析，否则按纯文本
exit 2  → 阻断（能阻断的事件才有效）；stderr 作为阻断理由
其它    → 非阻断错误；动作继续（除非该 hook 配了 onFailure: "block"）
```

**能加 context 的事件**：`UserPromptSubmit` / `UserPromptExpansion` / `SessionStart` / `PostModelSwitch`
——纯文本 stdout 会被当作 context 注入。

**对 memora-core 的接入方案（推荐，零脚本）**：

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "http", "url": "http://127.0.0.1:8790/api/hooks/session-start" }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "http", "url": "http://127.0.0.1:8790/api/hooks/prompt" }] }],
    "Stop": [{ "hooks": [{ "type": "http", "url": "http://127.0.0.1:8790/api/hooks/stop" }] }],
    "PreCompact": [{ "hooks": [{ "type": "http", "url": "http://127.0.0.1:8790/api/hooks/pre-compact" }] }]
  }
}
```

服务端对 `SessionStart` 回 `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"..."}}`
即可把 `memory_digest` 结果注入上下文；回纯文本 stdout 也可以。

**两个必须知道的上限**：`Stop` 有 **8 次连续续跑上限**（`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` 可调）；
`SessionStart` 在启动/resume/`/clear` 时**后台跑**，但 Claude 的首个响应仍会等它完成。

### 6.2 OpenAI Codex CLI

#### 6.2.1 配置落点（逐字）

| 范围 | 路径 | 备注 |
|---|---|---|
| 用户级 | `~/.codex/config.toml` | 主配置 |
| 项目级 | `.codex/config.toml` | **只在信任该项目时加载** |
| profile | `$CODEX_HOME/<profile-name>.config.toml` | 用 profile 选择 |
| 托管 | `requirements.toml` | 管理员强制 |

来源原文："User-level configuration lives in ~/.codex/config.toml. You can also add project-scoped overrides in .codex/config.toml files. Codex loads project-scoped config files only when you trust the project."

#### 6.2.2 最小可用片段（stdio）

```toml
[mcp_servers.memora]
command = "python"
args = ["-m", "memora_core", "--data", "%APPDATA%\memora", "mcp-stdio"]
env = { MEMORA_HOME = "%APPDATA%\memora" }
startup_timeout_sec = 20      # 默认 10
tool_timeout_sec = 120        # 默认 60
default_tools_approval_mode = "prompt"
```

**HTTP 型（指向常驻中枢）**：

```toml
[mcp_servers.memora]
url = "http://127.0.0.1:8790/mcp"
bearer_token_env_var = "MEMORA_TOKEN"
http_headers = { "X-Memora-Client" = "codex-cli" }
startup_timeout_sec = 10
```

（两段的键全部来自官方 TOML 示例：`command`/`args`/`env_vars`/`env`、`url`/`bearer_token_env_var`/`http_headers`。）

#### 6.2.3 `mcp_servers.<id>.*` 字段全表（config-reference 逐条）

| 字段 | 类型 | 说明 |
|---|---|---|
| `command` | string | stdio 启动命令 |
| `args` | string[] | stdio 参数 |
| `env` | map | 转发给 stdio 的环境变量 |
| `env_vars` | array | 额外白名单变量，元素可为 string 或 {name, source}，source = local/remote |
| `cwd` | string | stdio 工作目录 |
| `url` | string | Streamable HTTP 端点 |
| `bearer_token_env_var` | string | 从环境变量取 bearer token |
| `http_headers` | map | 静态头 |
| `env_http_headers` | map | 头名 → 环境变量名 |
| `http_headers_helper` | string | 打印 JSON 头的本地命令（仅本地 HTTP） |
| `auth` | `oauth` / `chatgpt` | 认证回退 |
| `oauth.*` | — | `callback_port` / `callback_url` / `client_id` / `client_secret` |
| `oauth_resource` | string | RFC 8707 resource 参数 |
| `scopes` | string[] | OAuth scopes |
| `enabled` | boolean | 禁用但不删配置 |
| `required` | boolean | 初始化失败则启动/恢复失败 |
| `startup_timeout_sec` | number | 默认 **10** |
| `tool_timeout_sec` | number | 默认 **60** |
| `enabled_tools` | string[] | 工具白名单 |
| `disabled_tools` | string[] | 工具黑名单（在 enabled 之后生效） |
| `default_tools_approval_mode` | `auto`/`prompt`/`writes`/`approve` | 默认审批行为 |
| `tools.<tool>.approval_mode` | 同上 | 单工具覆盖 |
| `tools.<tool>.output_token_limit` | integer | 单工具输出 token 预算（另有 20% 序列化余量） |
| `experimental_environment` | `local` / `remote` | 远程执行环境放置 |

顶层相关键：`mcp_optional_startup_grace_ms`（默认 **1000**）、`mcp_oauth_callback_port`、`mcp_oauth_callback_url`、`mcp_oauth_credentials_store`。

#### 6.2.4 hook / notify（**任务书需要修正的一点**）

任务书说 Codex 用「`notify` 钩子」。**当前官方文档已不是这样**：

- `notify` 在 config-reference 里只剩 `array<string>`："Command invoked for notifications; receives a JSON payload from Codex."（单条，无事件模型）
- 真正的生命周期钩子是 **`[hooks]` 表**："Lifecycle hooks configured inline in config.toml. Uses the same event schema as hooks.json"
- `hooks.<Event>` 类型是 `array<table>`（matcher 组），事件名包括：`PreToolUse`、`PermissionRequest`、`PostToolUse`、`PreCompact`、`PostCompact`、`SessionStart`、`SessionEnd`、`SubagentStart`、`SubagentStop`、`UserPromptSubmit`、`Stop`、`Interrupt`
- 另有 `allow_managed_hooks_only = true`（**只能写在 `requirements.toml`**，写进 `config.toml` 无效）

> **对 memora-core 的含义**：Codex 与 Claude Code 可用**几乎相同的事件名**做适配，
> 一套 `/api/hooks/{event}` 后端可同时服务两家；`notify` 只能当「任务完成提示」的补充通道。
> Codex 的 `hooks.json` 完整载荷字段**未核实**（官方只说 "same event schema as hooks.json"，未给字段表）。
### 6.3 DeepSeek Harness（DSH）

DSH 在本机可直接读，以下全部来自本机实读。

#### 6.3.1 profile 结构（本机真实路径）

```
~/.dsh/
├─ profiles/desktop/
│  ├─ package.json        # dsh.profile.bundles = 插件清单真源
│  ├─ cordis.yml          # bundle 展开后的完整加载表（生成物）
│  ├─ cordis.patch.yml    # 用户补丁层（手写，后应用）
│  ├─ pnpm-lock.yaml
│  └─ node_modules/       # 含 @modelcontextprotocol/sdk 1.32.1
├─ plugins/dsh-visual-workflow/   # link: 形式的本地插件
├─ sessions/<workspace>/session-<uuid>/session.v4.jsonl.zstd
└─ storages/                      # 凭据与模型目录（部分 .dpapi 加密）
```

**`cordis.patch.yml` 的形状**（本机原文，顶部注释即规格）：

```yaml
# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; `!!js` expressions allowed).
- id: permission
  name: "@deepseek-ai/dsh-permission-presets"
  config:
    presets:
      read-only:       { sandbox: read-only,        approval: ask }
      workspace-write: { sandbox: workspace-write,  approval: ask }
      danger-full-access: { sandbox: danger-full-access, approval: never }
    defaultPreset: danger-full-access
```

插件用 `insert` 形式追加行（本机 `dsh-visual-workflow/cordis.patch.yml` 原文）：

```yaml
- insert:
    - id: visual-workflow
      name: dsh-visual-workflow
      config:
        dataDir: !!js dshHomePath('visual-workflow')
        servicePortBase: 7860
        apiKey: null
        maxConcurrentPerService: 50
        runPollMs: 2000
```

#### 6.3.2 MCP 接入方式

本机 `cordis.yml` 中 MCP 相关行（原文）：

```yaml
- id: mcp-resources
  name: '@deepseek-ai/dsh-mcp-resources'
```

本机 `node_modules/@modelcontextprotocol/sdk` 版本 **1.32.1**（package.json 读出）。参考项目的 MCP 工具面实现（FastMCP + 心跳工具）见 `memora/memora/mcp.py` `[M-12]`，可作 DSH 侧工具命名的对照。

DSH 的 MCP 服务器注册**不是**写 JSON 文件，而是通过「组合管理 → MCP 服务器」页面写入 profile 配置，
**需重启 dsh web 后生效**（本机插件文档原文：「MCP 增删改写入 profile 配置，需重启 dsh web 后生效」）。
支持三种：`stdio（本地命令）`、`npx 一行`（Windows 下自动走 `cmd.exe /c`）、`streamable-http（远程 URL）`。
工具暴露名为 `mcp__<server名>__<tool>`。

> **对 memora-core 的含义**：给 DSH 的接入产物应该是一个**能一键写 profile 的安装脚本**，
> 而不是让用户手改 YAML。DSH 插件是否提供等价于 Claude Code hooks 的生命周期回调：**未核实**。

#### 6.3.3 会话事件落盘

本机实读：`~/.dsh/sessions/<project-slug>/session-<uuid>/session.v4.jsonl.zstd`，
zstd 压缩的 JSONL，首行：

```json
{"type":"session","version":4,"id":"session-72b69f59-...","createdAt":1792409636863,
 "cwd":"<project-root>","isSeeded":false,"delegationDepth":0,"agentPreset":"standard"}
```

（本机用 `node:zlib.zstdDecompressSync` 解出，198 字节单行；脚本 `.research/sess.mjs` `[M-11]`。）
**含义**：DSH 侧「会话沉淀」可按 `cwd` 归到 workspace 作用域，用 `id` 作为 `agent_session.external_id`。

### 6.4 三家对照总表

| 维度 | Claude Code | Codex CLI | DSH |
|---|---|---|---|
| 主配置 | `~/.claude.json` | `~/.codex/config.toml` | `~/.dsh/profiles/<name>/cordis.patch.yml` |
| 项目配置 | `.mcp.json`（根目录） | `.codex/config.toml`（需信任） | 无项目级概念 |
| 格式 | JSON | TOML | YAML（Cordis loader patch） |
| stdio 键 | `command`/`args`/`env` | `command`/`args`/`env`/`env_vars`/`cwd` | 由 UI 写入（「启动命令」一整行） |
| HTTP 键 | `type:"http"`+`url`+`headers` | `url`+`bearer_token_env_var`/`http_headers` | `streamable-http` + URL + 请求头 JSON |
| 生命周期钩子 | `hooks` 键，5 种 handler | `[hooks]` 表（事件名同 CC） | 未核实 |
| 钩子载荷 | JSON on stdin（或 HTTP body） | 未核实 | 未核实 |
| 工具命名 | `mcp__<server>__<tool>` | 未核实 | `mcp__<server>__<tool>`（本机插件文档） |
| 生效方式 | 自动（文件监听） | 重启会话 | **重启 dsh web** |

---

## 7. (B) 统一记忆交换 schema（字段级定义 + 示例 JSONL）

### 7.1 设计约束（来自项目既有契约）

本 schema **不是另起一套**，必须满足三条既有约束：

1. **对齐 `memora_core/data/schema.sql`** `[M-5]` 的 `memory` / `evidence` / `block` / `edge` / `entity` 五张表；
2. **复用 `docs/MEMORY-MODEL.md` `[M-4]` 的既有词表**：10 种 `kind`、14 种 `rel`、7 种 judge 动作、8 种 `evidence.kind`；
3. **JSONL 一行一条记录**，与 MCP memory 参考实现的持久化格式同构。

### 7.2 记录类型

```
manifest   文件头（首行，声明版本与导出器）
memory     一条记忆（主记录；evidence/blocks/edges 可内联也可独立成行）
evidence   证据
block      富形式块（formula/code/table/image/database/list/quote/derivation）
edge       关系边
entity     实体（脑图节点）
agent      智能体登记
session    会话
```

### 7.3 memory 记录的字段（纯记忆属性 24 个，另有 7 个容器/判别字段）

| # | 字段 | 类型 | 必填 | 说明 | 对应表列 |
|---|---|---|---|---|---|
| 1 | `record` | `"memory"` | 是 | 记录类型判别符 | — |
| 2 | `schema` | string | 是 | `"memora.exchange/1"` | — |
| 3 | `id` | string | 是 | 全局唯一，建议 `mem_<uuid>` | `memory.id` |
| 4 | `scope_id` | string | 是 | `global` / `workspace:<slug>` / `agent:<id>` / `task:<id>` / `conversation:<id>` / `document:<id>` | `memory.scope_id` |
| 5 | `agent_id` | string/null | 是 | 产出者 slug | `memory.agent_id` |
| 6 | `session_id` | string/null | 是 | 来源会话 | `memory.session_id` |
| 7 | `kind` | enum | 是 | fact/knowledge/decision/preference/procedure/experience/task/turn/tool/artifact | `memory.kind` |
| 8 | `category` | string/null | 是 | 自由分类标签 | `memory.category` |
| 9 | `title` | string | 是 | 一句话标题 | `memory.title` |
| 10 | `body` | string | 是 | 正文（Markdown） | `memory.body` |
| 11 | `summary` | string/null | 是 | 摘要（预算打包用） | `memory.summary` |
| 12 | `didactic` | object | 是 | definition/theorem/property/formula/derivation/example 六层 | `memory.didactic` |
| 13 | `status` | enum | 是 | candidate/approved/rejected/draft/superseded/merged/archived | `memory.status` |
| 14 | `trust` | number 0-1 | 是 | 信任分 | `memory.trust` |
| 15 | `importance` | number 0-1 | 是 | 重要度 | `memory.importance` |
| 16 | `confidence` | number 0-1 | 是 | 置信度 | `memory.confidence` |
| 17 | `sensitivity` | enum | 是 | normal/private/secret | `memory.sensitivity` |
| 18 | `valid_from` | ISO8601/null | 是 | 双时序：何时开始为真 | `memory.valid_from` |
| 19 | `valid_to` | ISO8601/null | 是 | 双时序：何时不再为真 | `memory.valid_to` |
| 20 | `recorded_at` | ISO8601 | 是 | 双时序：何时被记录 | `memory.recorded_at` |
| 21 | `updated_at` | ISO8601 | 是 | 最后更新 | `memory.updated_at` |
| 22 | `superseded_by` | string/null | 是 | 被谁取代 | `memory.superseded_by` |
| 23 | `merged_into` | string/null | 是 | 并入谁 | `memory.merged_into` |
| 24 | `lang` | string/null | 是 | BCP-47 | `memory.lang` |
| 25 | `tokens` | integer | 是 | 正文 token 估算 | `memory.tokens` |
| 26 | `pinned` | boolean | 是 | 是否置顶 | `memory.pinned` |
| 27 | `evidence` | array | 是 | 见 7.4 | `evidence` 表 |
| 28 | `blocks` | array | 是 | 见 7.5 | `block` 表 |
| 29 | `edges` | array | 是 | 见 7.6 | `edge` 表 |
| 30 | `entities` | string[] | 是 | 提及的实体名 | `memory_entity` |
| 31 | `metadata` | object | 是 | 扩展位（含 import 溯源） | `memory.metadata` |

> 1–31 行里，`record` / `schema` / `evidence` / `blocks` / `edges` / `entities` / `metadata` 共 7 个
> 是判别符或容器；**纯记忆属性字段 24 个**，满足「≥18 字段」验收要求。

### 7.4 evidence 子对象（8 字段）

```json
{
  "kind": "tool_output",
  "quote": "原文精确片段，不许改写",
  "uri": "file:///<local-path>/... 或 https://... 或 memora://session/<id>#turn/<n>",
  "hash": "sha256:...",
  "trust": 0.8,
  "verified": true,
  "verifier": "cross-check:v1",
  "note": "为什么这条证据支持该记忆"
}
```

`kind` 取值与默认信任（沿用 `docs/MEMORY-MODEL.md` §4）：
`user_stated 0.90` / `verification 0.85` / `tool_output 0.80` / `code_run 0.80` /
`document 0.70` / `web 0.60` / `derived 0.50` / `agent_asserted 0.45`。

**硬规则（沿用既有模型）**：只有 `agent_asserted` 证据的记忆 `trust ≤ 0.5`，且**不允许自动进入 approved**。

### 7.5 block 子对象（6 字段）

```json
{ "type": "formula", "lang": "latex", "caption": "贝叶斯更新",
  "content": "P(A|B)=P(B|A)P(A)/P(B)", "fields": {}, "ordinal": 0 }
```

`type` 取 `formula` / `image` / `code` / `table` / `database` / `list` / `quote` / `derivation`。
`formula` 由前端 KaTeX 渲染（项目已锁 `katex 0.16.47`）。

### 7.6 edge 子对象（8 字段）

```json
{ "src": "mem_01", "src_kind": "memory", "dst": "ent_bert", "dst_kind": "entity",
  "rel": "instance_of", "weight": 0.9, "confidence": 0.7, "origin": "llm",
  "valid_from": "2026-01-01T00:00:00Z", "valid_to": null }
```

`rel` 取 14 种：semantic / hypernym / hyponym / part_of / instance_of / causes / contradicts /
supports / supersedes / derived_from / mentions / temporal_next / alias / prerequisite
（来自 `schema.sql` 的 `edge.rel` 注释与 `MEMORY-MODEL.md` §6）。
`origin` 取 explicit / inferred / llm / cooccurrence。
### 7.7 示例 JSONL（4 行，可直接读；行格式与 MCP memory 参考实现同构 `[S-22]`）

```jsonl
{"record":"manifest","schema":"memora.exchange/1","exporter":"memora-core/1.0.0","exported_at":"2026-10-19T13:00:00Z","scope_id":"workspace:memora-core","counts":{"memory":1,"entity":2,"edge":1},"degraded":null}
{"record":"memory","schema":"memora.exchange/1","id":"mem_7f3a","scope_id":"workspace:memora-core","agent_id":"dsh-desktop","session_id":"session-72b69f59","kind":"decision","category":"viz","title":"脑图渲染底座选 three.js 自建","body":"不引入 3d-force-graph：其布局与渲染绑定，无法做「布局一次 + 增量更新」。","summary":"渲染底座选型结论","didactic":{},"status":"approved","trust":0.82,"importance":0.75,"confidence":0.8,"sensitivity":"normal","valid_from":"2026-10-19T12:00:00Z","valid_to":null,"recorded_at":"2026-10-19T12:04:11Z","updated_at":"2026-10-19T12:04:11Z","superseded_by":null,"merged_into":null,"lang":"zh-CN","tokens":46,"pinned":false,"evidence":[{"kind":"tool_output","quote":"forceEngine 在 d3 与 ngraph 之间二选一","uri":"https://github.com/vasturiano/3d-force-graph","hash":"sha256:ab12cd34","trust":0.8,"verified":true,"verifier":"manual","note":"官方 README 能力面核对"}],"blocks":[{"type":"code","lang":"text","caption":"三层分工","content":"渲染层 three.js / 布局层 自写 / 交互层 focus+rig+flex","fields":{},"ordinal":0}],"edges":[{"src":"mem_7f3a","src_kind":"memory","dst":"ent_three","dst_kind":"entity","rel":"mentions","weight":1.0,"confidence":0.9,"origin":"explicit","valid_from":null,"valid_to":null}],"entities":["three.js"],"metadata":{"import":{"source":"mcp-memory-service","external_id":"m_8812","imported_at":"2026-10-19T13:00:00Z"},"_unknown":{}}}
{"record":"entity","schema":"memora.exchange/1","id":"ent_three","name":"three.js","kind":"tool","definition":"WebGL 渲染库","scope_id":"workspace:memora-core","importance":0.7,"created_at":"2026-10-19T12:00:00Z"}
{"record":"edge","schema":"memora.exchange/1","src":"ent_three","src_kind":"entity","dst":"ent_webgl","dst_kind":"entity","rel":"part_of","weight":1.0,"confidence":0.95,"origin":"explicit","valid_from":null,"valid_to":null}
```

### 7.8 与五种既有格式的字段映射

| 目标字段 | mem0 memory 对象 | MCP memory 参考实现 | basic-memory Markdown | engram | OpenAI Memory 风格 |
|---|---|---|---|---|---|
| `id` | `id` | 无（用 name 当主键） | `permalink` | observation id | 无（整段文本） |
| `body` | `memory` | `observations[]` 合并成正文 | `- [cat] text` 列表 | observation 正文 | 记忆条目文本 |
| `title` | 无（取首句） | `name` | frontmatter `title` | 无 | 无 |
| `kind` | 无类型 | `entityType` → knowledge | `[method]/[tip]/[fact]/[resource]/[question]` 映射 | 无 | → preference/fact |
| `scope_id` | `user_id`/`agent_id`/`run_id` 三元组 | 单库单作用域 | 目录路径 | 项目目录 | 单用户 |
| `edges` | metadata 里的关系 | `Relation{from,to,relationType}` | `- rel [[Target]]` | 无 | 无 |
| `recorded_at` | `created_at` | 无 | 可选 frontmatter | 时间戳 | 无 |
| `updated_at` | `updated_at` | 无 | 文件 mtime | 无 | 无 |
| `sensitivity` | 无 | 无 | 无 | 无 | 默认全 private |

**映射实现要点（两条已在参考代码里验证过）** `[M-3][S-24]`：

1. **mem0 的三元组要拆开**：`user_id` 是用户维度，`agent_id` 进 `agent:<id>`，`run_id` 进 `task:<id>`。
   **不要**把三者拼成一个字符串当 scope。mem0 源码里
   `ENTITY_PARAMS = frozenset({"user_id","agent_id","run_id"})`，三者分别写入 `base_metadata_template`，是三个独立维度。
2. **MCP memory 的 entity 导入时转成「一条记忆 + 若干边」**，而不是一个节点：
   本机参考实现把 entity 拼成「实体：X / 类型：Y / observations」的正文，把 relation 写成边，
   并在端点缺失时返回 `missing_endpoints` 而不是静默丢弃。

### 7.9 导出/导入的 6 条硬规则

1. **一行一个 JSON，UTF-8 无 BOM，换行结尾**（与 MCP memory 参考实现的 JSONL 一致 `[S-22]`）。
2. **首行必须是 `manifest`**；导入方遇到不认识的 `schema` **必须整体拒绝**，不许猜。
3. **`degraded` 必须如实**：导出时若向量/判定走了离线算法，写
   `{"role":"embedding","mode":"offline-deterministic"}`，不许写 null 冒充全云端。
4. **导入不提升信任**：外来记忆一律进 `candidate`，`trust = min(原值, 0.5)`，除非带 `verification` 证据。
5. **未知字段保留**：不认识的行原样保留、下次写入时原样写回。
   MCP memory 参考实现对此有明确实现与注释：Otherwise the next unrelated write would silently delete them from disk。
6. **幂等**：`id` 相同则 update，`evidence.hash` 相同则跳过——重复导入不产生重复记忆。

---

## 8. (B) 在场上报与可靠性评估

### 8.1 五种可行手段

| # | 手段 | 原理 | 可靠性 | 成本 | 可伪造性 |
|---|---|---|---|---|---|
| 1 | **MCP 客户端首次调用上报** | 任何 agent 调 `memory_*` 时顺带刷 `last_seen` | 高（真实调用即真实在场） | 零额外 | 低（要真连上才行） |
| 2 | **周期心跳** | 客户端按固定间隔调 `memory_peer_heartbeat` | 高（但依赖客户端自觉） | 每 30 s 一次 RPC | 中 |
| 3 | **监听端口探测** | TCP connect / `netstat` 看端口是否 LISTEN | 中（只知道某进程在听，不知道是谁） | 本机实测 50 ms | 中 |
| 4 | **进程名 / 命令行扫描** | `tasklist` 或 `Win32_Process.CommandLine` 匹配 | 中高（命令行能精确认 agent） | 本机实测 852–943 ms | 低 |
| 5 | **共享心跳文件目录** | 各 agent 往约定目录写带时间戳的文件 | 中（依赖各 agent 配合写） | 微秒级读 | 高（谁都能写） |

### 8.2 本机实测耗时（原始输出）

脚本 `.research/presence_probe.py` `[M-10]`，本机 Windows：

```
$ python presence_probe.py
tasklist rc 0 rows 403 ms 943
netstat rc 0 listen rows 40 ms 50
cim rc 0 ms 852
  out: [{"ProcessId":25152,"Name":"node.exe","cl":"\"C:\\Program Files\\nodejs\\node.exe\" supervisor.mjs"}, ...]
```

| 手段 | 命令 | 实测耗时 | 返回量 |
|---|---|---|---|
| 进程名扫描 | `tasklist /FO CSV /NH` | **943 ms** | 403 行 |
| 监听端口 | `netstat -ano -p TCP` | **50 ms** | 40 条 LISTENING |
| 命令行扫描 | `Get-CimInstance Win32_Process` | **852 ms** | 可拿完整 CommandLine |
| 共享心跳文件 | 读文件 mtime | 微秒级 | — |
| MCP 调用上报 | 随工具调用 | 零额外 | — |

**结论**：把 `tasklist`/`CIM` 放进轮询不可接受（852–943 ms，且 CIM 还要起一个 PowerShell 进程）。

### 8.3 推荐的三级策略

```
第一级（默认开启，零成本）
  任何 MCP 调用顺带刷新 last_seen；心跳 TTL 90 s，客户端 30 s 一次
  → 覆盖绝大多数场景：agent 在用就必然在线

第二级（2 s 一次，仅当用户打开「智能体」页）
  netstat 端口探测（50 ms）匹配已知端点表
  → 用来发现「已启动但还没调过工具」的 agent

第三级（仅用户点「扫描」时，一次性）
  Get-CimInstance Win32_Process 抓 CommandLine，正则匹配 dsh / codex / claude / cursor
  → 慢但准，不该自动化
```

### 8.4 可靠性陷阱（四条，每条都有实证）

1. **心跳不能声明在线就当在线**。参考项目 `docs/DSH-AGENT-PRESENCE.md` `[M-8]` 记录过一次真实事故：
   连接器只在模型显式调工具时发一次心跳，定时器变量声明了却从未 `setInterval` 启动，
   于是任何一次连接的最终状态都是「已过期」。**修法是启动定时器，不是放宽 TTL**。
2. **TTL 必须大于心跳间隔**。参考实现的校验是 `30 <= ttl <= 300` 秒，且注释写明
   「ttl 必须 > intervalMs，否则两次心跳之间会先过期」。
3. **路径漂移会让「加载成功」变成「永远连不进来」**。同一次事故里，profile 里的两条 insert 指向已不存在的旧根——
   YAML 照样解析、宿主照样报加载成功，只是每次都 spawn 失败。**安装器必须做 stale-reference 检查**。
4. **导入的历史不能算在场**。参考实现的 `memory_peers` 注释写明 imported history never counts as presence，
   即只有真实心跳行才算在线，从别处导入的 peer 记录一律不算。

### 8.5 对 memora-core 的落点

`schema.sql` `[M-5]` 里已有现成落点：

| 表 | 用法 |
|---|---|
| `agent` | `status`(online/idle/offline) + `last_seen` + `last_heartbeat` + `heartbeat_source`(process/port/mcp/file/manual) |
| `agent_probe` | 每次探测一行：`probe` / `target` / `state`(found/absent/error) / `latency_ms` |
| `agent_session` | `external_id` 存 Claude Code 的 `session_id`、DSH 的 `session-<uuid>`、Codex 的会话 id |

`heartbeat_source` 这个列的枚举（process/port/mcp/file/manual）本身就是可靠性分级的落地——
界面上应当显示来源，而不只是绿点：`mcp` 来源的在线比 `port` 来源可信得多。

---

## 9. 参考链接表

编号规则：`S-*` = 规范/第三方库（外部来源），`L-*` = 本地源码，`M-*` = 本地实测与产物/本项目既有文件。
每条都在正文被至少引用一次；正文里的每个编号在此可查。

### 9.1 规范与官方文档（S）

| 编号 | 来源 | URL | 取证方式 |
|---|---|---|---|
| S-1 | MCP 规范 2025-06-18 索引 | https://modelcontextprotocol.io/specification/2025-06-18 | 抓 `docs/specification/2025-06-18/index.mdx` |
| S-2 | MCP schema 三版 | https://github.com/modelcontextprotocol/modelcontextprotocol/tree/main/schema | raw 抓 `schema/{2024-11-05,2025-03-26,2025-06-18}/schema.ts`，导出符号集合差分 |
| S-3 | MCP Transports（2025-06-18） | https://modelcontextprotocol.io/specification/2025-06-18/basic/transports | raw 抓 `basic/transports.mdx`（13,956 B） |
| S-4 | MCP Lifecycle（2025-06-18） | https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle | raw 抓 `basic/lifecycle.mdx`（8,196 B） |
| S-5 | MCP Base Protocol（2025-06-18） | https://modelcontextprotocol.io/specification/2025-06-18/basic | raw 抓 `basic/index.mdx`（`_meta` 规则） |
| S-6 | MCP 2025-06-18 变更日志 | https://modelcontextprotocol.io/specification/2025-06-18/changelog | raw 抓 `changelog.mdx`（3,138 B） |
| S-7 | MCP 2025-03-26 变更日志 | https://modelcontextprotocol.io/specification/2025-03-26/changelog | raw 抓 `changelog.mdx`（1,666 B） |
| S-8 | MCP Resources（2025-06-18） | https://modelcontextprotocol.io/specification/2025-06-18/server/resources | raw 抓 `server/resources.mdx`（9,519 B）；-32002 在第 376-388 行 |
| S-9 | Claude Code 官方文档（MCP / hooks / settings 三页） | https://docs.anthropic.com/en/docs/claude-code/mcp | curl 抓三页 HTML 去标签转纯文本（1,548,921 / 3,213,122 / 702,244 B） |
| S-10 | Codex CLI 配置参考（重定向到 learn.chatgpt.com） | https://developers.openai.com/codex/config-reference | `curl -L` 抓取，实际落地 https://learn.chatgpt.com/docs/config-file/config-reference（1,452,211 B） |
| S-11 | npm registry 元数据 | https://registry.npmjs.org/ | 逐包 `/latest` 取 version + license |
| S-12 | 3d-force-graph README | https://github.com/vasturiano/3d-force-graph | raw 抓 README（34,747 B）+ `src/index.js` |
| S-13 | sigma.js settings 源码 | https://github.com/jacomyal/sigma.js | raw 抓 `packages/sigma/src/settings.ts`（5,227 B） |
| S-14 | cytoscape.js README | https://github.com/cytoscape/cytoscape.js | raw 抓 README（9,814 B） |
| S-15 | AntV G6 README | https://github.com/antvis/G6 | raw 抓 README（6,340 B） |
| S-16 | d3-force 源码（`manyBody.js` / `link.js`） | https://github.com/d3/d3-force | raw 抓 `src/manyBody.js`（3,306 B）、`src/link.js`（3,294 B） |
| S-17 | graphology layout-forceatlas2 | https://github.com/graphology/graphology | raw 抓 README（4,411 B）+ `iterate.js`（26,800 B） |
| S-18 | d3-hierarchy `tree.js` | https://github.com/d3/d3-hierarchy | raw 抓 `src/tree.js`（7,063 B） |
| S-19 | three.js `InstancedMesh.js` | https://github.com/mrdoob/three.js | raw 抓 `src/objects/InstancedMesh.js`（10,707 B） |
| S-20 | MCP Tools（2025-06-18） | https://modelcontextprotocol.io/specification/2025-06-18/server/tools | raw 抓 `server/tools.mdx`（10,467 B） |
| S-21 | MCP Prompts（2025-06-18） | https://modelcontextprotocol.io/specification/2025-06-18/server/prompts | raw 抓 `server/prompts.mdx`（6,564 B） |
| S-22 | MCP 参考 memory server（JSONL 持久化） | https://github.com/modelcontextprotocol/servers/tree/main/src/memory | curl 抓 `src/memory/index.ts`（42,089 B） |
| S-23 | MCP 2024-11-05 HTTP+SSE 传输 | https://modelcontextprotocol.io/specification/2024-11-05/basic/transports | raw 抓 `basic/transports.mdx`（3,558 B） |
| S-24 | 记忆格式项目 README（mcp-memory-service / basic-memory / mem0 / engram） | https://github.com/doobidoo/mcp-memory-service 等 | raw 抓 README（16,940 / 24,651 / 12,306 / 24,415 B）；mem0 另抓 `server/models.py`、`mem0/memory/main.py` |
### 9.2 本地源码（L）

| 编号 | 文件 | 关键行 | 用途 |
|---|---|---|---|
| L-1 | `memora/frontend/focus.ts`（477 行） | 150-160 `fitDistance`；170-261 `frameCluster`；317-394 `bestAngles`；418-451 `lookQuaternion`；458-477 `downwardness` | 相机取景与视角搜索 |
| L-2 | `memora/frontend/edge-flex.ts`（222 行） | 13-100 规则与常量；125-141 `arcRatio`；149-195 `flexControl`；218-222 `updateInterval` | 边弯曲 |
| L-3 | `obsidian-3d-mindmap/original-dev/src/render/labels.ts`（279 行） | 14-19 tier/placement 常量；131-245 `update()` | 标签避让 A |
| L-4 | `memora/frontend/graph-look.ts`（237 行） | 113-135 `pickLabels`；147-182 `installLabelDeclutter`；198-237 `frameDictionaryOverview` | 标签避让 B + 首帧取景 |
| L-5 | `obsidian-3d-mindmap/original-dev/src/layout/*.ts` + `physics/js-engine.ts`（552 行）+ `layout/layout-engine.ts`（320 行） | layout-engine 45-52 参数；js-engine 41-167 Octree、374-460 step、480-539 collide | 力导向与确定性布局 |
| L-6 | `obsidian-3d-mindmap/original-dev/src/camera/camera-rig.ts`（456 行） | 253-263 `flyTo`；354-390 `update`；265-297 `fit`；309-341 `bestOrientation`；431-455 bookmark/spherical | 相机动画 |
| L-7 | `memora/frontend/best-view.ts`（187 行） | 104-171 `installBestView`（650 ms 延迟、12 s 超时、只跑一次） | 最佳视角触发契约 |
| L-8 | 本机 `~/.dsh/profiles/desktop/{package.json,cordis.yml,cordis.patch.yml}`；`~/.dsh/plugins/dsh-visual-workflow/MCP注册指南.md`；`~/.dsh/sessions/**` | — | DSH 结构 |
| L-9 | `memora/artifacts/p9-bestview-flex/REPORT.md`（216 行）+ `report.json` | 全文 | 实测数据与失败史 |
| L-10 | `obsidian-3d-mindmap/original-dev/src/layout/separation.ts`（168 行） | 10-80 `PointGrid`；126-158 `separate` | 碰撞网格 |
| L-11 | `obsidian-3d-mindmap/original-dev/src/render/link-layer.ts`（267 行） | 13-45 贝塞尔顶点着色器；177-219 `setPositions`；225-256 `avoidSpheres` | 实例化边渲染 |
| L-12 | `obsidian-3d-mindmap/original-dev/src/layout/study-layouts.ts`（203 行） | 14-90 知识星座；98-135 书架构；163-203 旅程布局 | 时间线/学习布局 |

### 9.3 本项目既有文件（M）

| 编号 | 文件 | 用途 |
|---|---|---|
| M-1 | `memora/artifacts/p9-bestview-flex/{REPORT.md,report.json,acceptance.log}` | 参考项目实测数字（0.0003 ms/重写、帧时间、sagitta 分布） |
| M-2 | `memora/memora/projections.py:9` | `store.graph(project, limit=400, ...)` → 脑图工程上限 400 节点 |
| M-3 | `memora/memora/memory_exchange.py` | MCP memory graph 导入适配器（entity→记忆+边、missing_endpoints） |
| M-4 | `memora-core/docs/MEMORY-MODEL.md`（153 行） | 10 种 kind、14 种 rel、8 种 evidence、7 种 judge 动作、双时序、SM-2、衰减 |
| M-5 | `memora-core/memora_core/data/schema.sql`（465 行） | 交换 schema 对齐的 5 张表（memory/evidence/block/edge/entity） |
| M-6 | `memora-core/docs/ARCHITECTURE.md` | 冻结的 MCP 工具名（21 个）、REST 路由、降级矩阵、脑图交互要求 |
| M-7 | `memora-core/frontend/package.json` | three 0.160.1 / katex 0.16.47 / esbuild 0.25.12 |
| M-8 | `memora/docs/DSH-AGENT-PRESENCE.md`（139 行） | 在场链路真实事故与修法（心跳定时器、路径漂移） |
| M-9 | `.research/bench_bh.mjs` | 4.1 的力导向/碰撞基准（本机实测） |
| M-10 | `.research/presence_probe.py` | 8.2 的在探活耗时（本机实测） |
| M-11 | `.research/sess.mjs` | DSH 会话 zstd 解压验证（本机实测） |
| M-12 | `memora/memora/mcp.py` | 参考项目的 MCP 工具面实现（FastMCP + 心跳工具） |

---

## 附录 A · 未核实项清单（显式列出，不猜）

| # | 未核实内容 | 为什么没核实 | 影响 |
|---|---|---|---|
| 1 | 3d-force-graph / sigma / cytoscape / G6 / cosmograph 的**官方节点上限数字** | 各家 README 均未给可引用数字；任何「支持 N 万节点」的说法都是二手 | 不作为选型依据；选型依据是架构契合度与许可 |
| 2 | **Codex `hooks.json` 的完整载荷字段表** | 官方 config-reference 只说 same event schema as hooks.json，未列字段 | 第 6.2.4 只给事件名，不给字段 |
| 3 | **DSH 是否有等价于 Claude Code hooks 的生命周期回调** | 本机 profile 与插件文档里没有 hooks 行 | 第 6.3 只能给 MCP 接入方式 |
| 4 | **Codex 的工具命名规则是否也是 `mcp__<server>__<tool>`** | 官方文档未提 | 第 6.4 表中标「未核实」 |
| 5 | **Claude Code 的 `type: "http"` hook 在 Windows 上是否完全等价于 `command`** | 文档描述一致但未标注平台差异 | 方案可行，落地前应在目标机跑一次 |
| 6 | **`@cosmograph/cosmograph` 的商业授权是否可单独购买** | 只核实到 npm 标注 CC-BY-NC-4.0 | 保守按「不可用于商业分发」处理 |
| 7 | **OpenAI Memory（user profile）的官方 schema** | 未找到公开的字段级规范 | 第 7.8 只按「整段文本 + 单用户」映射 |
| 8 | **engram 的 SQLite 表结构** | README 只写 SQLite + FTS5 (~/.engram/engram.db)，未给 DDL | 第 7.8 只按 observation 概念映射 |
| 9 | **Codex `[hooks]` 的 matcher 语义是否与 Claude Code 完全一致** | 文档说 same event schema，未说 matcher 语法 | 可用同一套事件名，但 matcher 需分别验证 |
| 10 | **三家宿主的端到端注册验证** | 本次只做调研，未改任何配置 | 落地时需要一次真实联调 |

---

## 附录 B · 验收自检

| 验收项 | 要求 | 实际 | 位置 |
|---|---|---|---|
| 方案横评数 | ≥10 | **14** | §2.1 |
| 可直接实现的算法/公式 | ≥8 | **16** | §3.1–3.7（取景闭式解、投影盒居中、24×7 打分、字典序选择、downwardness、slerp+对数插值、指数阻尼、弯曲公式、4 方向标签避让、BH 判据、退火停止、径向扇区权重、交错环、锥树半径、压缩深度、蛇形块） |
| 性能预算表 | 实测或引用 | **本机实测 + 参考项目实测**，脚本与原始输出均在 | §4.1–4.3 |
| MCP 三版差异表 | 需要 | 有（含 schema 符号级差分） | §5.1 |
| 三家宿主真实配置路径 + 最小片段 | 需要 | 三家都有，路径逐字 | §6.1.1 / 6.2.1 / 6.3.1 |
| 统一 schema 字段数 | ≥18 | **24 个纯记忆属性字段**（另有 7 个容器/判别字段，合计 31 行） | §7.3 |
| 示例 JSONL | 需要 | 4 行（manifest/memory/entity/edge） | §7.7 |
| 事实 1:1 对应来源 | 需要 | 正文每处标 S/L/M 编号，§9 可查 | 全文 |
| 未核实项 | 需要 | **10 条** | 附录 A |
