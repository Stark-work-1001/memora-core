# store.py / vault.py 实现说明

> 数据真源层。SQLite 是唯一写入者，Markdown 是它的可读镜像。
> 契约见 docs/ARCHITECTURE.md §3 §4.1 §4.2 §4.3；
> 本文件只讲**怎么实现的**与**为什么这么做**。

## 1. 数据分层

| 层 | 角色 | 谁写 |
|---|---|---|
| memora.db（WAL + FTS5） | 事务真源，所有不变量在这里生效 | Store（唯一写者） |
| vault/*.md | 人类可读镜像，可由真源**完整重放** | Vault |
| document 表 | 镜像文件 ↔ 真源的追溯凭据 | Vault 写入后 upsert |

镜像永远不是第二个写入者：
任何 md 都能由「记忆 + 证据 + 块 + 关系」重新渲染出来。

## 2. 数据不变量

1. **记忆必填**：title / body / kind / scope_id 缺一即 `ValueError`；
   kind 必须属于 schema 注释里的 10 类。
2. **默认值**（ARCHITECTURE §4.2）：status=candidate、trust=importance=confidence=0.5、
   recorded_at=updated_at=now(UTC)、id=`m-`+uuid4[:12]。
3. **范围钳制**：trust / importance / confidence 一律夹到 [0,1]；NaN 视作默认值。
   block.ordinal、review_count、source_count、tokens 走整数化，非法值退默认。
4. **状态机**（§3.2）：candidate→approved|rejected，approved→superseded|merged|archived。
   `candidate→superseded` 抛 ValueError。另把 schema 里存在的 `draft` 显式登记为入口态
   （draft→candidate|approved|rejected），不做隐式放行；archived 是终态。
5. **信任封顶**（§3.3）：证据 kind 缺省取权重表
   （user_stated 0.9 … agent_asserted 0.45）。
   若一条记忆**只有** agent_asserted 证据，其 trust 被封顶到 0.5，且批准时也不放宽。
   注意方向：只会**压低**，绝不抬高用户给的信任。
6. **JSON 字段**：didactic / metadata / frontmatter / block.fields / edge.metadata / candidate.payload
   写入前 dumps，读出时 loads；`get_memory` 返回的永远是展开后的对象。
7. **作用域**：scope.path 为斜杠路径（父在前）。记忆的 scope 缺失时按 id 前缀
   （global/workspace/agent/task/conversation/document）自动登记，避免记忆悬空；
   `scope` 过滤走 path 前缀，含全部子作用域。
8. **唯一性**：entity 由 (name, kind) 唯一、edge 由 (src,src_kind,dst,dst_kind,rel) 唯一，
   重复写入是 upsert 而非新行；memory_entity 的主键保证重复 link 幂等。

## 3. 并发模型

- 每个线程持有自己的连接（`threading.local`，属性 `Store.con` 懒创建），
  首次使用才连库。
- 所有写操作走 `db.transaction(con)`：BEGIN IMMEDIATE + COMMIT/ROLLBACK；源码里没有裸 commit。
- `Store._txn()` 是唯一入口：**已在事务中则复用**，这样 `audit()` 可以无条件调用，
  不会把审计写到事务外的另一个连接上
  （否则会和自己的写事务抢同一个锁，SQLite 直接报 locked）。
- 读操作在 WAL 快照下不加锁，因此「8 线程各写 25 条」与读并发互不阻塞。
- 验收实测：8×25=200 条并发写入，id 无重复、行数 200、audit 数 ≥ 200。

## 4. FTS 与中文

schema 的 `memory_fts` 用 `unicode61` 分词器 + 触发器同步。实测结论：

- 触发器工作正常：INSERT/UPDATE/DELETE 都会同步 memory_fts（有专门的断言测试）。
- **unicode61 不切分中文**：一整段连续汉字是**一个** token，
  所以 `MATCH '记忆'` 命中 0 条，
  只有 `MATCH '记忆*'`（前缀）能命中，且只匹配「以该段开头」的 token。
- 因此查询走两路合并：
  1. **FTS**：`_fts_expr()` 把查询按标点/空白切段，
     每段包成 `"seg"*` 短语并 AND 起来（前缀短语），
     用 bm25() 排序。这样做同时杜绝了 MATCH 语法注入。
  2. **LIKE**：整串 + 各分段做 `title/body/summary LIKE %term%`
     （转义 `%` `_` `\`），补齐中文中段子串。
  两路按「FTS 在前、LIKE 补充且去重」合并，
  所以既保留相关性排序，又不会漏召回。
- 改分词器（trigram）需要改 schema，属于冻结契约，本层不动；
  库里也没有 fts5vocab（不建未声明的对象），
  所以不依赖任何未建对象。
- `snippet`：优先用 FTS5 的 `snippet(memory_fts, -1, '[', ']', '…', 16)`，
  该行没有 FTS 命中时退回正文前 180 字（折叠空白）。

## 5. 图视图（4 种，全部可直接 JSON 序列化）

| view | 节点 | 边 | 特殊字段 |
|---|---|---|---|
| semantic | memory + entity | mentions 与 8 种语义关系（见下） | degree、kind、label |
| hierarchy | scope 树 + memory | contains / in_scope / part_of / supersedes | depth、parent |
| timeline | day 桶 + memory | contains、temporal_next（同桶串起） | t（epoch 秒）、bucket |
| evidence | memory→evidence→document/chunk | evidence / document / chunk | trust、degree |

- `meta` 四种视图统一为 `{view, scope, node_count, edge_count, truncated, built_at, limit}`。
- 记忆集合一律「未归档」，按视图各自的排序取 limit 条，
  多取一条判定 `truncated`。
- semantic 的关系白名单：semantic / hypernym / hyponym / part_of / causes /
  supports / contradicts / alias。
- degree 由边表统一回填（`_finish_degrees`），保证节点度数与边列表永远自洽。
- 边只保留两端节点都在集合内的，避免悬空边把前端画崩。

## 6. Vault 镜像规则

- **路径**：`memories/<id>-<标题>.md`（id 在前 → 改名不产生新文件、不产生孤儿镜像；
  标题是给人看的后缀）。文件名安全化：
  NFKC → 非法字符 `<>:"/\|?*` 与控制字符换成 `-` →
  空白/连字符折叠 → 截断到 64 字 → 空串回退 `untitled` →
  Windows 保留名（CON/COM1…）加 `x-` 前缀。
- **front-matter**：id/title/kind/status/scope/agent/trust/importance/tags/recorded_at/updated_at/sources。
  特殊字符加双引号并转义，列表用 `[a, b]`；
  vault.py 自带 `parse_frontmatter`，可做回读验证。
- **正文**：标题 → 元信息行 → 摘要引用块 → 正文 →
  教学要点（didactic）→ 证据列表（带引句、
  信任、来源）→ 富形式块（formula 用 `$$..$$`、code/database 用围栏、table 用管道表、
  image 用 `![alt](url)`）→ **相关记忆 `[[id]]` 反向链接** →
  尾部「自动镜像，勿手改」。
- **原子性**：先写同目录 `.tmp`（mkstemp + flush + fsync）再 `os.replace`；
  任何异常都会删掉临时文件并保留旧内容。
- **可追溯**：每次写入后 upsert document 行（kind/path/hash/bytes/frontmatter/day/updated_at）。
  记忆用 `mem:<id>`、日更用 `daily:<day>`、报告用 `report:<name>`、任意文件用 `file:<rel>`、
  索引页用 `index:README` 作为主键，重复渲染只更新不新增。
- **日更**：`daily/YYYY-MM-DD.md`，首次创建写 front-matter + **顶部自动生成提示**，
  之后每次追加 `<!-- memora:entry -->` 分隔 + `## HH:MM:SS · 标题` 时间戳，
  同日多次追加顺序可追溯。
- **索引页**：`README.md`，按 kind / scope / 月份统计 + 最近 50 条带链接的记忆。
- **硬删除**：`remove_memory` 删文件 + 删 document 行 + 记审计。

## 7. 审计

所有写操作末尾调用 `self.audit(action, target, detail)`，同一事务内落 audit 表
（id/at/actor/action/target/detail）。actor 默认 `system`，MCP/HTTP 层可传具体智能体 id。
镜像失败**只记审计不抛错**：真源已经提交，镜像可以重放，
不该因为磁盘问题回滚业务事务。

## 8. 已知边界（不在本层解决）

- 语义向量（vector 表）、检索融合与重排属于 retrieval.py；本层只提供数据与图。
- `memory_fts` 的分词方式由 schema 固定，
  若要换 trigram 需要 schema 变更（违反冻结契约）。
- Vault 的并发写只保证单进程内串行；
  多进程同时镜像同一文件依赖 os.replace 的原子性，
  最后写入者胜出（镜像可重放，因此这是可接受的）。
