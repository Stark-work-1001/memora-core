# Memora 1.2.0 开发进度汇报

> 报告时间：2026-10-17 · 版本：**1.2.0** · 分支 main · HEAD `095dc3d`
> 本文件记录本轮全量开发的功能、测试与接口现状。所有数字均为实跑结果，非估计。

---

## 一、总体状态

| 项目 | 状态 |
|---|---|
| 版本 | `1.2.0`（`memora/__init__.py` 为唯一来源） |
| Python 测试 | **423 通过 / 1 条件跳过** |
| 前端测试 | **66 通过 / 0 失败** |
| 运行服务 | **已按用户要求全部停止**（8765 / 18181 / 18182 均停止） |
| 工作树 | 15 个未提交变更（脑图聚焦改动，见第四节） |

### 本轮开发的五个方向

| 代号 | 方向 | 状态 |
|---|---|---|
| D1 | 文档证据包后端路由 | ✅ 完成 |
| D3 | 脑图相机聚焦与层级流动 | ✅ 完成 |
| D4 | 工作流画布自动布局 | ✅ 完成 |
| D5 | 对话归档与浏览面板 | ✅ 完成 |
| E1 | 会话详情与检索路由 | ✅ 完成 |

---

## 二、功能交付明细

### D1 · 文档级证据包路由

`GET /api/agent/document-rag?project=&query=&mode=&audience=&versions=&slug=&budget=&max_tokens=&limit=`

返回 `DocIndex.rag()` 的完整信封，原样不改：`context` / `citations` / `references` / `generation` /
`retrieval_mode` / `audience_filter` / `audience_rule` / `versions` / `slug` / `nonce` / `omitted` /
`truncated` / `warnings` / `budget` / `trust` / `instruction`。

实测（文档 chunk 已建索引后）：

```json
refs: 3   citations: 3   nonce: 6ed49b873b9a
<<<evidence 6ed49b873b9a>>>
[chunk:dceca82b0b71f4e8ab79ec975e; document:runbook; audience:human;
 version:1; lines:5-6; recorded:unknown; digest:0ff6e0d20be6]
Memora 运行手册 > 启动顺序
先启动 WSL 里的 embedding 服务…
```

**安全性质**：每块用**每次调用重新生成**的 nonce 包裹，文档内容无法伪造分隔符；
实测攻击文档携带伪造的 `<<<end ATTACKER-NONCE>>>` 无法越狱，且会被标记 `instruction-like`。

### D3 · 脑图聚焦与层级流动

修复前实测到的四个缺陷（不是推测，是浏览器里量出来的）：

1. **球体取景**——按较紧的屏幕轴拟合包围球，2 节点簇浪费 70~90% 窗口
2. **孤立节点过放大**——无邻居的节点拟合自身，相机压到 12 单位下限，一个圆盘占满舞台
3. **取景与面板竞速**——相机在侧栏打开**前**移动，按 1436px 算，面板一开变 1032px
4. **流动提示看不出动**——解码合成截图测得每帧仅变化 **0.006%** 像素

新增三个只读模块（`focus.ts` 纯取景策略、`focus-dom.ts` 布局胶水、`brain-focus.ts` 宿主适配），
`frontend/vendor/**` 145 个文件哈希未变。层级视图现在每个子节点端有方向箭头 + 48 个沿父→子
移动的点，`prefers-reduced-motion` 下动画关闭但方向保留。

### D4 · 工作流画布自动布局

自动排版规则（三条款，按序判定）：

1. 完全没有存储坐标 → 排版。这是全部堆在原点的情形
2. 有坐标但零连线 → 尊重坐标。无连接的卡片没有可推断的顺序
3. 有连线 → 除非至少一条**边的起点**带坐标，否则排版

自动排版是**视图决策**，不置 `dirty`，打开未排版的工作流不会悄悄排队一次保存。

**同时修复了一个既有缺陷**：`.dag-empty` 使用 `display:flex`，优先级高于浏览器默认的
`[hidden]{display:none}`，那个不可见的全屏遮罩一直盖在画布上**吞掉所有指针事件——
节点拖拽从来就没工作过**。修复后加 `.dag-empty[hidden]{display:none}`。

### D5 · 对话归档面板

从空列表升级为可浏览的会话档案：标题 / 智能体 / 轮数 / 起止时间 / 归档相对时间，
点击展开逐轮原文（角色、序号、时间、内容），支持跨会话搜索与 60 秒缓存。

**数据来源诚实标注**：单条会话的 HTTP 路由当时不存在，面板通过 `memory_absorb` 归档时写下的
共享文档读取原文，并在界面明写这一事实与原因。

### E1 · 会话详情与检索路由

补齐两条真服务端路由：

| 路由 | 说明 |
|---|---|
| `GET /api/agent/session?project=&id=&limit=&cursor=` | 单会话 + 分页轮次（`cursor` 为排他 seq 游标） |
| `GET /api/agent/session-search?project=&query=&limit=` | FTS5 + bm25 排序，报告搜索范围与覆盖数 |

`id` 采用**会话行 id**（全库唯一 UUID）而非 `external_id`（仅在 `(project, agent)` 内唯一），
因此项目范围内查找永不含糊。

---

## 三、测试与验证

| 类别 | 结果 |
|---|---|
| Python | `Ran 423 tests / OK (skipped=1)` |
| 前端 | `66 tests / 66 pass / 0 fail` |
| 打包一致性 | 13 项（无需构建即可运行） |
| 验收工具 | `tools/acceptance_1_2_0.py` 35 项 / 0 失败 |
| vendor 完整性 | 145 文件聚合哈希未变 |

### 端到端实测（本轮亲自执行）

| 验证项 | 结果 |
|---|---|
| 混合检索 | `mode=hybrid`，10 条结果，索引覆盖 10/10 |
| 向量真实参与 | 结果标签 `命中 融合 · 向量第 1 位 · 相似度 0.7461` |
| 文档 chunk 索引 | 0 → **3 块 / 3 向量**，generation 0→6 |
| 文档证据包 | 空信封 → **3 条真实引用 + nonce + 行号** |
| 语义关系边 | **5 条**（第 6 条被正确拒绝：目标不是已审核记忆） |
| 会话入库 | 4 会话 / **19 轮**（全库共 596 轮，其中 dsh 项目 559 轮） |
| 会话检索 | `query=RRF` → 2 条命中，覆盖 4 会话 / 19 轮 |
| 工作流执行 | 3 节点拓扑执行，n1 成功 / n2 因模型输出不合 schema 明确失败 |

---

## 四、未完成与已知问题

### 4.1 脑图聚焦代码未提交（15 个文件在工作树）

D3 的改动仍在工作树中未提交，**功能已完成并通过验证**（前端 66/66），但需要一次提交固化。

### 4.2 工作流执行暴露模型能力缺口

`extract_relations` 与 `verify` 两个操作要求模型返回**严格 JSON**，而当前唯一配置的
`memory-judge`（Qwen3.8-2B 蒸馏模型）返回了自然语言：

```json
{"code":"invalid_input","message":"workflow stage must return strict JSON","retryable":false}
```

**这是正确的失败**（引擎未放松解析、未伪装成功），但说明：**10 个角色只配了 1 个模型**，
2B 判定模型无法胜任关系抽取与校验。P2 扩展插槽里的「独立更强 verifier」正是为此预留。

### 4.3 拉丁词检索在 dsh 项目命中为零

`dsh` 项目搜索 `memora` / `workbench` 等拉丁词返回 0 条，而 CJK 词（如 `文件`）正常命中 20 条。
查证结果：**FTS 索引完整**（559 条索引行 = 559 条轮次），问题在于归档文本里本就没有这些拉丁词
（`LIKE '%memora%'` 同样为 0 行）。**这是数据问题，不是索引缺陷。**

### 4.4 其他已知限制

- `demo` 项目的文档 `docs` 表结构无 `audience` 列，版本流在 `revisions` 表——查询时需注意
- 脑图物理布局在两次页面加载之间最多漂移 4.9 世界单位（非确定性），因此 reduced-motion 的
  对照必须在**同一次页面加载内**比较
- `MEMORA_RUNTIME_VERSION` 在 DSH profile 中仍写 `1.1.0`，该值**无人读取**（纯装饰），
  项目内模板已同步为 1.2.0

---

## 五、模型接入接口（供后续接云端 embedding / judge 使用）

### 5.1 当前配置

`data/memora.json`：

```json
{
  "embedding": {
    "backend": "openai",
    "url": "http://127.0.0.1:18181/v1",
    "model": "qwen3-embedding-0.6b",
    "remote": false,
    "preset": "qwen3-embedding",
    "revision": "sha256:0437e45c…:last-token:fp16:transformers-5.19.0",
    "timeout": 120
  },
  "judge": {
    "backend": "openai",
    "url": "http://127.0.0.1:18182/v1",
    "model": "qwen3.8-2b-judge",
    "remote": false,
    "revision": "sha256:4aa0fb13…:llama-b11695",
    "timeout": 120
  }
}
```

### 5.2 支持的 backend

| 角色 | 允许值 |
|---|---|
| embedding | `openai` / `sentence-transformers` / `llama-cpp` |
| judge | `openai` / `llama-cpp` |

`openai` 指任意 **OpenAI 兼容 HTTP 接口**——llama.cpp server、Ollama、vLLM、LM Studio、TEI，
以及各类云端 API 都走这一条。

### 5.3 接云端模型的四条硬性要求

1. **`MM_ALLOW_REMOTE=1`** —— 非回环地址默认拒绝
2. **必须 `https://`** —— 远程地址用 http 会被拒（`providers.py:85`）
3. **密钥走环境变量**，配置里只写变量名（`key_env`）
4. **URL 不得含用户名/密码/查询串/片段**（`providers.py:83`）

违反任一条会抛 `ProviderConfigError('remote provider requires explicit consent and HTTPS')`。
回环地址（`127.0.0.1` / `::1`）不受此限——这是本地部署不需要额外开关的原因。

### 5.4 可用的环境变量（完整清单）

```
MM_EMBED_BACKEND   MM_EMBED_URL     MM_EMBED_MODEL   MM_EMBED_KEY
MM_EMBED_DIM       MM_EMBED_PRESET  MM_EMBED_TASK    MM_EMBED_REVISION
MM_EMBED_BATCH     MM_EMBED_DEVICE  MM_EMBED_PATH    MM_EMBED_GPU_LAYERS
MM_EMBED_QUERY_TEMPLATE   MM_EMBED_TIMEOUT
MM_JUDGE_BACKEND   MM_JUDGE_URL     MM_JUDGE_MODEL   MM_JUDGE_KEY
MM_JUDGE_EXTRA     MM_JUDGE_PATH    MM_JUDGE_GPU_LAYERS
MM_JUDGE_REVISION  MM_JUDGE_RESPONSE_FORMAT   MM_JUDGE_NO_THINK   MM_JUDGE_TIMEOUT
MM_ALLOW_REMOTE    MM_TRUST_AGENT_CONFIRM     MM_ENABLE_REVIEW
```

### 5.5 换云端模型的最小步骤

**方式一（界面）**：「模型连接」页把接入方式改成「云端 OpenAI 兼容」，填 API 地址与模型名，
密钥环境变量名，保存即可。

**方式二（配置）**：改 `data/memora.json` 对应角色的 `url` / `model` / `remote: true` / `key_env`。

两种方式都需在启动进程前设置 `MM_ALLOW_REMOTE=1` 与对应密钥。

**换 embedding 模型后必须重建向量索引**——不同模型的向量不会混用，旧向量会被标记为不兼容
（`incompatible_vectors`），检索时若存在不兼容向量会给出提示。

### 5.6 Provider 能力

| 方法 | 签名 |
|---|---|
| `embed(text)` | 生成向量 |
| `chat(messages, max_tokens=300, schema_format=None)` | 对话补全 |
| `judge(text)` | 判定（结构化输出） |

`Provider.__init__` 可配置：`base` / `model` / `key` / `allow_remote` / `timeout` / `dimensions` /
`preset` / `query_template` / `task` / `revision` / `batch_size` / `response_format` / `no_think` / `extra`。

---

## 六、服务启停

当前**所有服务已停止**。重新启动有两个脚本：

| 脚本 | 用途 |
|---|---|
| `dev-serve.ps1` | 跑**当前源码**，改代码刷新页面即生效；自动探测端口占用、自动确保模型服务 |
| `start-memora.ps1` | 跑**打包后的桌面程序**，适合日常使用 |

```powershell
.\dev-serve.ps1                  # 8765，自动检查 18181/18182
.\dev-serve.ps1 -Port 8770 -NoModels   # 换端口，只调界面
```

---

## 七、下一步候选

| 优先级 | 事项 | 理由 |
|---|---|---|
| 高 | 接入更强的模型到 `relation` / `verifier` 角色 | 当前 10 角色仅 1 模型，复杂工作流跑不通 |
| 高 | 换云端模型后重建向量索引 | 换模型必须重建，否则旧向量不兼容 |
| 中 | 提交脑图聚焦改动 | 功能已完成，仅差固化 |
| 中 | 工作流只用 2B 能胜任的操作 | 立即可用，但能力受限 |
| 低 | `docs` 表结构文档化 | 避免再次误判列名 |

---

## 八、本轮暴露并修正的问题（供追溯）

| 问题 | 性质 | 处理 |
|---|---|---|
| `.dag-empty` 吞掉所有指针事件 | **真实产品缺陷** | 已修复，拖拽恢复 |
| 打包遗漏 `dag/` 与 `docindex` | 打包清单缺陷 | 已补 `--hidden-import` 与目录复制 |
| 三条硬编码工具数断言 | 测试写法缺陷 | 改为契约集合比对 |
| PowerShell 写中文变 `?` | 调用方编码错误 | 改用 Python UTF-8，脏数据已审阅拒绝 |
| 子智能体用系统 Python 而非 venv | 环境不一致 | 已查明 venv 有 mcp、系统无 |
| 归档死代码导致启动失败 | **协调者判断失误** | 已回滚，教训入决策日志 |

---

*本报告所有数据来源于本地实跑，可复现：`python -m unittest discover -s tests`、
`node --test tests/*.test.mjs`（frontend 目录）、`tools/acceptance_1_2_0.py`。*