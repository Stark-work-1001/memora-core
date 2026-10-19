# -*- coding: utf-8 -*-
"""生成演示数据：让首次打开 memora-core 的人看到的不是一个空壳。

    python tools/seed_demo.py --data data/demo
    python tools/seed_demo.py --data data/demo --reset

设计遵循 docs/MEMORY-MODEL.md：六层作用域、十种记忆类型、八类证据、八种富形式、
十三种关系边都有覆盖；含 3 组冲突/重复样本；学习型记忆带 didactic 六层。
全部来自公开事实或工程常识，不含任何用户隐私。
"""
from __future__ import annotations

import argparse
import json
import random
import shutil
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from memora_core import db as dbm  # noqa: E402
from memora_core.paths import Paths  # noqa: E402

random.seed(1017)
NL = chr(10)


def iso(days_ago: float = 0, hours: float = 0) -> str:
    t = datetime.now(timezone.utc) - timedelta(days=days_ago, hours=hours)
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


# 演示作用域：全部为合成示例，不映射任何真实项目或真实用户。
SCOPES = [
    ("global", "global", "全局", None),
    ("workspace:memora-core", "workspace", "memora-core 项目", "global"),
    ("workspace:demo-project", "workspace", "示例项目", "global"),
    ("agent:dsh", "agent", "DeepSeek Harness", "global"),
    ("agent:claude-code", "agent", "Claude Code", "global"),
    ("agent:codex", "agent", "Codex CLI", "global"),
    ("task:demo-onboarding", "task", "示例任务", "workspace:memora-core"),
    ("conversation:demo-session", "conversation", "示例会话", "task:demo-onboarding"),
]

# 演示偏好：合成示例文本，来源统一标记 demo:seed，不描述任何真实个人。
USER_PREFS = [
    ("示例偏好：先给结论再给理由",
     "演示条目：展示偏好类记忆如何被登记、审核与按作用域召回。内容为合成的示例文本。",
     "preference", "global", 0.92, 0.9,
     [("user_stated", "示例：先给结论再给理由", "demo:seed")]),
    ("示例偏好：中文交付、英文标识符",
     "演示条目：展示同一项目内用户可见文案与代码标识符可以使用不同语言。内容为合成的示例文本。",
     "preference", "global", 0.9, 0.85,
     [("user_stated", "示例：面向用户的文案用中文", "demo:seed")]),
    ("示例否决：没有来源的记忆不自动升格",
     "演示条目：展示否决类偏好如何表达一条不做什么的约束。内容为合成的示例文本。",
     "preference", "global", 0.88, 0.8,
     [("user_stated", "示例：没有证据的记忆不升格为事实", "demo:seed")]),
]

FACTS = [
    ("SQLite 开启 WAL 后支持并发读加单写",
     "WAL 模式下读不会被写阻塞，写操作串行化；适合桌面单进程多线程场景。",
     "fact", "workspace:memora-core", 0.9, 0.8,
     [("tool_output", "journal_mode=wal", "sqlite:PRAGMA journal_mode")]),
    ("FTS5 的 bm25 支持列权重",
     "bm25(memory_fts, 3.0, 1.5, 1.0) 把 title 权重设为 3 倍，body 为 1 倍。",
     "knowledge", "workspace:memora-core", 0.85, 0.7,
     [("document", "bm25(table, w1, w2)", "https://sqlite.org/fts5.html")]),
    ("Python 标准库 http.server 默认 backlog 只有 5",
     "浏览器一次页面加载会并发多个连接，backlog=5 会导致 ECONNREFUSED，必须显式调大。",
     "experience", "workspace:memora-core", 0.8, 0.75,
     [("code_run", "request_queue_size = 5", "cpython/Lib/socketserver.py")]),
    ("DSH 插件显示名优先取 locale 的 meta.title",
     "若 locale 文件里没有 meta.title，会回退显示 package.json 的 name。",
     "fact", "agent:dsh", 0.8, 0.6,
     [("document", "meta.title", "DSH 插件文档")]),
    ("Tauri 裸 cargo build 产出的是永久 dev 模式",
     "dev 由 custom-protocol feature 决定，只有 tauri build 会开启；否则跳过资源嵌入并转连 devUrl。",
     "experience", "agent:codex", 0.82, 0.7,
     [("tool_output", "ERR_CONNECTION_REFUSED", "cargo build --release")]),
    ("本地向量用字符 n-gram 哈希可以做到确定性",
     "同文本必然同向量，跨进程一致的前提是不能用内置 hash（带随机种子）。",
     "knowledge", "workspace:memora-core", 0.85, 0.65,
     [("code_run", "hash 每次进程不同", "python -c print(hash)")]),
]

DECISIONS = [
    ("决策：SQLite 是唯一写入真源",
     "背景：Markdown 可读性最好，但两个写入者会互相覆盖。取舍：SQLite 事务真源加 Markdown 派生镜像。"
     "结果：冲突只可能出现在镜像生成环节，可由重建索引修复。",
     "decision", "workspace:memora-core", 0.9, 0.95,
     [("user_stated", "示例需求：存放形式包括 Markdown 文档和 SQLite 数据库", "demo:seed")]),
    ("决策：判定层用七种动作而不是增删改",
     "add / update / merge / supersede / link / noop / ask。记忆演化比 CRUD 复杂，"
     "合并与推翻必须可追溯，冲突必须能挂起等人工裁决。",
     "decision", "workspace:memora-core", 0.88, 0.9,
     [("derived", "七动作模型", "docs/MEMORY-MODEL.md")]),
    ("决策：模型不可用时降级而不是失败",
     "记忆中枢的核心价值是本地可用；云端模型只是增强。降级必须显式标注，不能假装成功。",
     "decision", "global", 0.85, 0.85,
     [("user_stated", "示例需求：用记忆算法做脱离云端风险的兜底", "demo:seed")]),
]

PROCEDURES = [
    ("接入一个新的 MCP 客户端",
     "1. 拿到 stdio 命令 python -m memora_core --data DIR mcp-stdio" + NL +
     "2. 在客户端配置的 mcpServers 里加上它" + NL +
     "3. 重启客户端，调 memory_health 确认连通" + NL +
     "4. 在智能体页确认它已上线",
     "procedure", "global", 0.85, 0.75, [("document", "mcpServers", "AGENTS.md")]),
    ("重建检索索引",
     "1. 设置页点重建索引，或 POST /api/documents/ID/reindex" + NL +
     "2. 等增量索引维护工作流跑完" + NL +
     "3. 在检索页验证命中",
     "procedure", "workspace:memora-core", 0.8, 0.6, [("document", "重建索引", "docs/API.md")]),
]

TOOLS = [
    ("Codex 的 rollout 会话是 JSONL，单文件可达数十 MB",
     "路径形如 sessions/YYYY/MM/DD/rollout-*.jsonl，逐行 JSON，含工具调用与结果。",
     "tool", "agent:codex", 0.8, 0.6, [("tool_output", "32975660 bytes", "codex sessions dir")]),
    ("PyInstaller 的 collect-submodules 比手写 hidden-import 稳",
     "手写列表会漏掉运行期才导入的模块；collect-submodules 按包扫描。",
     "tool", "workspace:memora-core", 0.82, 0.65, [("tool_output", "collect-submodules", "pyinstaller")]),
]

FORMULA_BM25 = (r"score(q,d) = " + chr(92) + r"sum_{t " + chr(92) + r"in q} IDF(t) " +
                r" " + chr(92) + r"cdot " + chr(92) + r"frac{f(t,d)(k_1+1)}" +
                r"{f(t,d) + k_1(1-b+b " + chr(92) + r"cdot |d|/avgdl)}")
FORMULA_RRF = (r"score(d) = " + chr(92) + r"sum_i " + chr(92) + r"frac{w_i}{k + " +
               chr(92) + r"text{rank}_i(d)}, " + chr(92) + r"quad k = 60")
FORMULA_MMR = (r"MMR = " + chr(92) + r"arg" + chr(92) + r"max_{d " + chr(92) + r"in R " +
               chr(92) + r"setminus S}[ " + chr(92) + r"lambda " + chr(92) + r"cdot sim(d,q) - " +
               "(1-" + chr(92) + r"lambda) " + chr(92) + r"cdot " + chr(92) + r"max_{s " +
               chr(92) + r"in S} sim(d,s) ]")
FORMULA_SM2 = (r"EF' = EF + (0.1 - (5-q)(0.08 + (5-q) " + chr(92) + r"cdot 0.02)), " +
               chr(92) + r"quad I_n = I_{n-1} " + chr(92) + r"cdot EF")

KNOWLEDGE = [
    {
        "title": "BM25 的相关性打分公式",
        "body": "BM25 在词频饱和与文档长度归一之间取平衡，是全文检索的事实标准。"
                "FTS5 内置 bm25 可直接用，并可对列加权。",
        "trust": 0.9, "importance": 0.85,
        "didactic": {
            "definition": "BM25 是概率检索模型，用词频、逆文档频率与文档长度归一估算相关性。",
            "formula": FORMULA_BM25,
            "property": "k1 控制词频饱和速度（常用 1.2 到 2.0）；b 控制长度归一强度（常用 0.75）。",
            "derivation": "由二元独立模型出发，对词频做饱和假设、对长度做归一，取对数几率得到。",
            "example": "查询「事务真源」，title 含该词的文档权重 3 倍，排在只在正文提及的之前。",
        },
        "entities": [("BM25", "concept"), ("FTS5", "tool")],
    },
    {
        "title": "倒数排名融合 RRF",
        "body": "多路召回分数不可比时，用名次倒数加权融合，k 越大越平滑。",
        "trust": 0.88, "importance": 0.8,
        "didactic": {
            "definition": "RRF 用各通道的排名而非分数做融合，天然避免归一化问题。",
            "formula": FORMULA_RRF,
            "property": "k 越大头部与尾部差距越小；权重表达通道置信度。",
            "example": "BM25 第 1 名加向量第 5 名的文档，得分高于只在单通道排第 2 的文档。",
        },
        "entities": [("RRF", "concept"), ("混合检索", "concept")],
    },
    {
        "title": "最大边际相关 MMR 去冗余",
        "body": "在相关性与冗余之间折中，避免把十条几乎相同的记忆塞进上下文。",
        "trust": 0.85, "importance": 0.75,
        "didactic": {
            "definition": "贪心地选择与查询相关、同时与已选集合不相似的条目。",
            "formula": FORMULA_MMR,
            "property": "lambda 取 1 退化为纯相关性；取 0 退化为纯多样性。常用 0.7。",
        },
        "entities": [("MMR", "concept")],
    },
    {
        "title": "SM-2 间隔复习算法",
        "body": "按回忆质量调整间隔与难度因子，是早期 Anki 使用的经典算法。",
        "trust": 0.87, "importance": 0.7,
        "didactic": {
            "definition": "以难度因子 EF 与间隔 I 刻画记忆强度，答对间隔增长，答错重置。",
            "formula": FORMULA_SM2,
            "property": "EF 初值 2.5、下限 1.3；q 小于 3 时间隔重置为 1 天。",
            "example": "连续三次 q=5，间隔依次约为 1、6、15 天。",
        },
        "entities": [("SM-2", "concept"), ("间隔复习", "concept")],
    },
    {
        "title": "双时序：何时为真与何时被记录",
        "body": "记忆有两个时间轴：事实在现实世界生效的时间，和它被写进系统的时间。查询要能分别使用。",
        "trust": 0.86, "importance": 0.78,
        "didactic": {
            "definition": "双时序建模：valid_from 与 valid_to 表示事实有效期，recorded_at 表示记录时间。",
            "property": "迟到写入的事实应设置过去的 valid_from，而不是把 recorded_at 当成生效时间。",
            "example": "A 是项目负责人，3 月生效，但 10 月才被记录。",
        },
        "entities": [("双时序", "concept"), ("知识图谱", "concept")],
    },
]

ENTITIES = [
    ("SQLite", "tool", "嵌入式关系数据库，本项目的真源存储。"),
    ("Markdown", "concept", "纯文本标记语言，本项目的可读镜像格式。"),
    ("MCP", "concept", "Model Context Protocol，智能体与工具之间的标准协议。"),
    ("BM25", "concept", "经典全文检索相关性模型。"),
    ("RRF", "concept", "倒数排名融合。"),
    ("MMR", "concept", "最大边际相关去冗余。"),
    ("SM-2", "concept", "间隔复习算法。"),
    ("记忆中枢", "concept", "本产品 memora-core。"),
    ("DeepSeek Harness", "tool", "DSH，宿主环境之一。"),
    ("Claude Code", "tool", "Anthropic 的命令行编程智能体。"),
    ("Codex CLI", "tool", "OpenAI 的命令行编程智能体。"),
    ("双时序", "concept", "有效时间与记录时间的二维建模。"),
    ("FTS5", "tool", "SQLite 的全文检索扩展。"),
    ("向量检索", "concept", "用嵌入向量做语义相似检索。"),
    ("混合检索", "concept", "多路召回融合。"),
    ("间隔复习", "concept", "按遗忘曲线安排复习。"),
    ("知识图谱", "concept", "实体与关系的结构化表示。"),
]

RELATIONS = [
    ("SQLite", "FTS5", "part_of"), ("SQLite", "Markdown", "semantic"),
    ("BM25", "RRF", "semantic"), ("RRF", "MMR", "semantic"),
    ("RRF", "混合检索", "part_of"), ("BM25", "混合检索", "part_of"),
    ("向量检索", "混合检索", "part_of"), ("FTS5", "BM25", "supports"),
    ("MCP", "DeepSeek Harness", "supports"), ("MCP", "Claude Code", "supports"),
    ("MCP", "Codex CLI", "supports"), ("记忆中枢", "SQLite", "derived_from"),
    ("记忆中枢", "MCP", "part_of"), ("SM-2", "间隔复习", "instance_of"),
    ("双时序", "知识图谱", "part_of"),
]

DOCS = [
    ("notes/sqlite-wal.md", "SQLite WAL 速记",
     "# SQLite WAL 速记" + NL + NL + "WAL 让读不阻塞写。" + NL + NL +
     "PRAGMA journal_mode=WAL;" + NL + NL +
     "注意 checkpoint 与 wal 文件增长。" + NL + NL +
     "| 模式 | 读写并发 |" + NL + "|---|---|" + NL + "| delete | 阻塞 |" + NL + "| wal | 读不阻塞 |" + NL),
    ("notes/mcp-handshake.md", "MCP 握手要点",
     "# MCP 握手要点" + NL + NL + "1. 客户端发 initialize" + NL +
     "2. 服务端回 protocolVersion、capabilities、serverInfo" + NL +
     "3. 客户端发 notifications/initialized" + NL + "4. 之后才能 tools/list" + NL + NL +
     "stdio 帧是一行一个 JSON。" + NL),
    ("notes/retrieval-design.md", "混合检索设计",
     "# 混合检索设计" + NL + NL + "三路召回：BM25、向量、实体图。" + NL + NL +
     "融合用 RRF（k=60）。" + NL + NL +
     "- 重排失败时透传原顺序并标 degraded" + NL + "- 预算打包按 score 与长度之比贪心" + NL),
    ("notes/review-schedule.md", "复习排程",
     "# 复习排程" + NL + NL + "SM-2 的 EF 与间隔。" + NL + NL +
     "- q 大于等于 3 间隔增长" + NL + "- q 小于 3 重置为 1 天" + NL),
]

CONFLICTS = [
    ("默认端口是 8790 与默认端口是 8080 互斥", "contradiction"),
    ("向量维度 256 与向量维度 1024 互斥（用了不同模型）", "contradiction"),
    ("两条几乎相同的 BM25 描述", "duplicate"),
]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="data/demo")
    ap.add_argument("--reset", action="store_true")
    args = ap.parse_args()

    paths = Paths(args.data).ensure()
    if args.reset:
        for p in [paths.db, Path(str(paths.db) + "-wal"), Path(str(paths.db) + "-shm")]:
            if p.exists():
                p.unlink()
        if paths.vault.exists():
            shutil.rmtree(paths.vault, ignore_errors=True)
        paths.ensure()
    dbm.init_db(paths.db)

    from memora_core.store import Store
    from memora_core.vault import Vault
    store = Store(paths.db, Vault(paths.vault))

    for sid, kind, name, parent in SCOPES:
        store.ensure_scope(sid, kind, name, parent)

    ents = {}
    for name, kind, definition in ENTITIES:
        e = store.upsert_entity(name, kind, definition, "global")
        ents[name] = e["id"]

    try:
        import memora_core.agents as agents_mod
        agents_mod.seed_agents(store)
    except Exception as exc:
        print("agent seed skipped:", type(exc).__name__, exc)

    made = []

    def add(spec, agent=None, recorded=None):
        title, body, kind, scope, trust, importance, evs = spec
        m = store.add_memory({
            "title": title, "body": body, "kind": kind, "category": kind,
            "scope_id": scope, "agent_id": agent, "status": "approved",
            "trust": trust, "importance": importance,
            "confidence": min(0.95, trust + 0.05),
            "recorded_at": recorded or iso(random.uniform(0, 20)),
            "tags": json.dumps([kind], ensure_ascii=False),
        })
        for ek, quote, uri in evs:
            store.add_evidence(m["id"], {"kind": ek, "quote": quote, "uri": uri,
                                         "trust": 0.9 if ek == "user_stated" else 0.75})
        made.append(m)
        return m

    for spec in USER_PREFS:
        add(spec, agent="dsh", recorded=iso(25))
    for spec in FACTS:
        add(spec, agent=random.choice(["dsh", "claude-code", "codex"]))
    for spec in DECISIONS:
        add(spec)
    for spec in PROCEDURES:
        add(spec)
    for spec in TOOLS:
        add(spec)

    for k in KNOWLEDGE:
        m = store.add_memory({
            "title": k["title"], "body": k["body"], "kind": "knowledge", "category": "学习",
            "scope_id": "workspace:memora-core", "status": "approved",
            "trust": k["trust"], "importance": k["importance"], "confidence": 0.9,
            "didactic": json.dumps(k["didactic"], ensure_ascii=False),
            "recorded_at": iso(random.uniform(1, 15)),
        })
        store.add_evidence(m["id"], {"kind": "document", "quote": k["body"][:20],
                                     "uri": "https://en.wikipedia.org", "trust": 0.7})
        if k["didactic"].get("formula"):
            store.add_block(m["id"], {"type": "formula", "lang": "latex",
                                      "caption": "核心公式", "content": k["didactic"]["formula"]})
        if k["title"].startswith("BM25"):
            store.add_block(m["id"], {"type": "code", "lang": "sql", "caption": "FTS5 用法",
                                      "content": "SELECT rowid, bm25(memory_fts,3.0,1.5,1.0) AS s" + NL +
                                                 "FROM memory_fts WHERE memory_fts MATCH 'sqlite';"})
            store.add_block(m["id"], {"type": "table", "caption": "参数",
                                      "content": "参数|含义|建议" + NL + "k1|词频饱和|1.2-2.0" + NL +
                                                 "b|长度归一|0.75"})
        for name, kind in k.get("entities", []):
            eid = ents.get(name) or store.upsert_entity(name, kind, "", "global")["id"]
            ents[name] = eid
            store.link_memory_entity(m["id"], eid, "mention")
        made.append(m)

    for a, b, rel in RELATIONS:
        if a in ents and b in ents:
            store.add_edge(ents[a], "entity", ents[b], "entity", rel,
                           weight=0.8, confidence=0.7, origin="explicit")
    store.add_edge(ents["BM25"], "entity", ents["记忆中枢"], "entity", "hyponym",
                   weight=0.9, confidence=0.8)

    for rel, title, text in DOCS:
        doc = store.add_document({
            "kind": "note", "path": rel, "title": title, "scope_id": "workspace:memora-core",
            "day": iso()[:10], "hash": "", "bytes": len(text.encode()), "origin": "import",
        })
        target = paths.vault / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding="utf-8")
        try:
            from memora_core.chunking import chunk_markdown
            chunks = chunk_markdown(text)
        except Exception:
            chunks = [{"ordinal": 0, "heading": title, "level": 1, "text": text,
                       "tokens": max(1, len(text) // 2), "start_line": 1,
                       "end_line": text.count(chr(10)) + 1, "hash": ""}]
        store.replace_chunks(doc["id"], chunks)

    try:
        store.add_candidate({
            "scope_id": "workspace:memora-core", "action": "add",
            "payload": json.dumps({"title": "候选：HTTP 服务要显式设置 Content-Length",
                                   "body": "keep-alive 复用时缺 Content-Length 会让客户端挂起而不是报错。",
                                   "kind": "experience"}, ensure_ascii=False),
            "dedup": json.dumps({"dup": 0.42, "band": "new"}, ensure_ascii=False),
            "status": "pending",
        })
    except Exception as exc:
        print("candidate skipped:", exc)

    if len(made) >= 2:
        for text, kind in CONFLICTS:
            try:
                store.add_conflict({"kind": kind, "a_id": made[0]["id"], "b_id": made[1]["id"],
                                    "score": 0.71,
                                    "detail": json.dumps({"summary": text}, ensure_ascii=False),
                                    "status": "open"})
            except Exception as exc:
                print("conflict skipped:", exc)

    n_mirror = 0
    for m in made:
        try:
            store.vault.write_memory(store.get_memory(m["id"]),
                                     store.list_evidence(m["id"]),
                                     store.list_blocks(m["id"]))
            n_mirror += 1
        except Exception as exc:
            print("mirror failed:", m["id"], exc)
    for m in made[:10]:
        try:
            store.vault.append_daily({"time": iso(), "memory_id": m["id"],
                                      "title": m.get("title"), "kind": m.get("kind"),
                                      "scope": m.get("scope_id")})
        except Exception:
            pass
    try:
        store.vault.rebuild_index(store)
    except Exception as exc:
        print("index rebuild skipped:", exc)

    con = dbm.connect(paths.db)
    try:
        h = dbm.health(con)
    finally:
        con.close()
    print(json.dumps({"data": str(paths.root), "memories": len(made), "mirrored": n_mirror,
                      "entities": len(ents), "documents": len(DOCS),
                      "counts": h["counts"]}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
