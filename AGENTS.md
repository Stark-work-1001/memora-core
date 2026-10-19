# AGENTS.md — 给接入本仓库的智能体读的操作手册

> 这份文件写给**智能体**，不是写给人类。人类看 README.md。
> 你要做的事情：把你自己会话里值得留下的东西写进记忆中枢，并在开始新任务前把需要的记忆取回来。

## 0. 三种接入方式，选一种

| 方式 | 适用 | 怎么配 |
|---|---|---|
| **MCP stdio**（推荐） | Claude Code / Codex CLI / Cursor / Claude Desktop / 任何 MCP 客户端 | 配置文件里加一个 server，命令指向 memora-core |
| **MCP HTTP** | 已常驻运行的中枢，多个客户端共享 | POST http://127.0.0.1:8790/mcp |
| **REST** | 插件 / hooks / 脚本 | http://127.0.0.1:8790/api/* |

### Claude Code（~/.claude.json）

    {
      "mcpServers": {
        "memora": {
          "command": "python",
          "args": ["-m", "memora_core", "--data", "<数据目录>", "mcp-stdio"]
        }
      }
    }

### Codex CLI（~/.codex/config.toml）

    [mcp_servers.memora]
    command = "python"
    args = ["-m", "memora_core", "--data", "<数据目录>", "mcp-stdio"]

### DSH / 其它插件式宿主

用宿主自己的 MCP 客户端插件，把上面的 stdio 命令填进去即可；若宿主支持生命周期 hook，
在 SessionStart 调 memory_recall，在 Stop 调 memory_session_end 自动沉淀。

## 1. 开工前：先取记忆

    memory_recall(query="<本次任务的关键词>", scope="workspace:<项目>", limit=10)
    memory_digest(scope="workspace:<项目>", budget=1200)

digest 返回的是**已审核**记忆的打包文本，带 [m:记忆id] 引用；引用要保留，方便用户追溯。

## 2. 干活中：随手记

- 用户说了偏好、禁忌、约定 → memory_remember(kind="preference")
- 得到一个已验证的事实（工具真实输出、命令真实结果）→ memory_remember(kind="fact", evidence_kind="tool_output")
- 做出一个有取舍的决策 → memory_remember(kind="decision", ...)
- 只是过程性内容、还不确定 → memory_capture(...)（先落草稿，之后由工作流提炼）

## 3. 收尾时：沉淀会话

    memory_session_end(agent="claude-code", external_id="<会话id>", title="...", turns=[...])

它会走"智能体会话沉淀"工作流：提炼 → 分类 → 判重 → 来源核验 → 落库 → 写日期 Markdown。

## 4. 规则（重要）

1. **不要伪造**：没有证据就写 evidence_kind="agent_asserted"，它会以低信任入候选，不会自动成为事实。
2. **带引文**：quote 必须是原文精确片段，不许改写。
3. **就近作用域**：项目相关的记忆写 workspace:<项目>，跨项目的稳定偏好写 global。
4. **不要重复写**：不确定是否已有，先 memory_search，再决定 add / update / merge。
5. **冲突要报**：发现与已有记忆矛盾，调 memory_relate(rel="contradicts") 并说明，不要静默覆盖。

## 5. 工具速查

| 工具 | 一句话 |
|---|---|
| memory_recall | 语义 + 全文 + 图混合召回，返回带引用与降级标记 |
| memory_search | 纯检索（不写日志、不刷新在场） |
| memory_digest | 生成预算内的上下文包 |
| memory_capture | 快速落草稿（零丢失） |
| memory_remember | 直接写一条记忆（默认 candidate） |
| memory_get / memory_update / memory_forget | 读 / 改 / 删 |
| memory_relate | 建立关系边（含 contradicts / supersedes） |
| memory_evidence | 追加证据 |
| memory_review | 复习评分（SM-2） |
| memory_graph | 取关系图（四视图） |
| memory_session_begin / end | 会话生命周期 |
| memory_agent_status | 谁在线、谁在取记忆 |
| memory_scope_list / memory_stats | 作用域与统计 |
| memory_workflow_run / list | 跑工作流 |
| memory_export / import | 交换格式 |
| memory_health | 健康与降级状态 |

## 6. 降级时怎么办

memory_health 或任何返回里的 degraded 字段非空，说明云端模型不可用，
中枢正在用离线确定性算法（BM25 / 字符哈希向量 / 规则判定）。这时：

- 记忆读写仍然正常工作，**不要停止使用**。
- 不要依赖"语义相似度"做精确判断，改用关键词。
- 在给用户的回复里如实说明"当前处于离线降级模式"。
