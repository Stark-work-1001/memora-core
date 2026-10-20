# -*- coding: utf-8 -*-
"""MCP 工具面：stdio 与 HTTP 共用同一套 22 个工具。

帧格式：一行一个 JSON-RPC 2.0 对象（换行分隔），**不使用 Content-Length**。
stdout 只允许写协议帧，所有调试输出走 stderr。

支持的 JSON-RPC 方法：
    initialize / notifications/initialized / ping / tools/list / tools/call /
    resources/list（空数组）

错误处理：参数错 -32602，内部错 -32603，解析错 -32700，方法不存在 -32601，
**任何情况下都不允许异常冒到 stdout**。
"""
from __future__ import annotations

import datetime as _dt
import io
import json
import sys
import traceback
import uuid
from typing import Any, Callable

from . import __version__
from . import agents as agents_mod
from . import db as _db
from . import exchange as exchange_mod

SERVER_NAME = "memora-core"
SERVER_VERSION = __version__
PROTOCOL_VERSION = "2024-11-05"

PARAM_ERROR = -32602
INTERNAL_ERROR = -32603
PARSE_ERROR = -32700
METHOD_NOT_FOUND = -32601
INVALID_REQUEST = -32600

# 22 个工具名（冻结，顺序即展示顺序）
TOOL_NAMES = (
    "memory_capture", "memory_remember", "memory_recall", "memory_search", "memory_digest",
    "memory_get", "memory_update", "memory_forget", "memory_relate", "memory_evidence",
    "memory_review", "memory_graph", "memory_session_begin", "memory_session_end",
    "memory_agent_status", "memory_scope_list", "memory_stats", "memory_workflow_run",
    "memory_workflow_list", "memory_export", "memory_import", "memory_health",
)

# 写入类工具（调用后写 audit）
WRITE_TOOLS = frozenset({
    "memory_capture", "memory_remember", "memory_update", "memory_forget", "memory_relate",
    "memory_evidence", "memory_review", "memory_session_begin", "memory_session_end",
    "memory_workflow_run", "memory_import",
})
# 召回类工具（调用后写 recall_log）
RECALL_TOOLS = frozenset({"memory_recall", "memory_digest", "memory_search"})

MEMORY_KINDS = ("fact", "knowledge", "decision", "preference", "procedure", "experience",
                "task", "turn", "tool", "artifact")


# ============================================================
# 上下文与错误
# ============================================================

class McpError(Exception):
    """带 JSON-RPC 错误码的异常，由 dispatch 捕获后转成错误对象。"""

    def __init__(self, code: int, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class ToolContext:
    """一次工具调用的参数袋。"""

    __slots__ = ("store", "gw", "agent_id", "args", "name")

    def __init__(self, store, gw, agent_id: str, args: dict, name: str = "") -> None:
        self.store = store
        self.gw = gw
        self.agent_id = agent_id or "unknown"
        self.args = dict(args or {})
        self.name = name

    def get(self, key: str, default: Any = None) -> Any:
        return self.args.get(key, default)

    def require(self, key: str) -> Any:
        value = self.args.get(key)
        if value is None or (isinstance(value, str) and not value.strip()):
            raise McpError(PARAM_ERROR, "缺少必填参数: %s" % key)
        return value

    def scope(self, default: str = "global") -> str:
        value = self.args.get("scope") or self.args.get("scope_id") or default
        return str(value)

    def limit(self, default: int = 20, cap: int = 200) -> int:
        try:
            value = int(self.args.get("limit") or default)
        except (TypeError, ValueError):
            raise McpError(PARAM_ERROR, "limit 必须是整数") from None
        return max(1, min(cap, value))


def _con(store):
    con = getattr(store, "con", None)
    if con is not None:
        return con
    import sqlite3
    path = getattr(store, "db_path", None) or getattr(store, "db", None)
    conn = sqlite3.connect(str(path), timeout=15.0, isolation_level=None)
    conn.row_factory = sqlite3.Row
    return conn


def _loads(value: Any, default: Any = None) -> Any:
    if isinstance(value, (dict, list)):
        return value
    if not value:
        return default
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return default


def _dumps(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def _audit(store, action: str, target: str | None, detail: Any = None) -> None:
    fn = getattr(store, "audit", None)
    if not callable(fn):
        return
    try:
        fn(action, target, detail=detail)
    except Exception:  # noqa: BLE001
        pass


def _write_recall_log(store, query: str, scope: str, agent_id: str, result: dict,
                      strategy: str = "hybrid") -> None:
    """召回日志；失败不影响召回结果。"""
    try:
        con = _con(store)
        hits = result.get("hits") or []
        con.execute(
            "INSERT INTO recall_log(id, query, scope_id, agent_id, strategy, hit_ids, scores, "
            "latency_ms, tokens, degraded, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            ("rl-" + uuid.uuid4().hex[:12], query, scope, agent_id, strategy,
             _dumps([h.get("id") for h in hits]),
             _dumps({h.get("id"): h.get("score") for h in hits}),
             int(result.get("took_ms") or 0), int(result.get("tokens") or 0),
             1 if result.get("degraded") else 0, _db.now()),
        )
    except Exception:  # noqa: BLE001
        pass


# ============================================================
# 工具实现
# ============================================================

def _t_capture(ctx: ToolContext) -> dict:
    text = str(ctx.require("text") or "").strip()
    title = str(ctx.get("title") or "").strip() or (text[:60] or "草稿")
    kind = str(ctx.get("kind") or "knowledge")
    if kind not in MEMORY_KINDS:
        raise McpError(PARAM_ERROR, "未知记忆类型: %s" % kind)
    tags = list(ctx.get("tags") or [])
    memory = ctx.store.add_memory({
        "scope_id": ctx.scope(), "agent_id": ctx.agent_id, "kind": kind,
        "title": title, "body": text, "status": "candidate", "trust": 0.4,
        "importance": float(ctx.get("importance") or 0.4),
        "metadata": {"tags": tags, "source": "mcp", "capture": True},
    }, origin="agent")
    return {"id": memory.get("id"), "title": memory.get("title"),
            "status": memory.get("status"), "kind": memory.get("kind"),
            "scope": memory.get("scope_id")}


def _t_remember(ctx: ToolContext) -> dict:
    body = str(ctx.get("text") or ctx.get("body") or "").strip()
    title = str(ctx.get("title") or "").strip()
    if not body and not title:
        raise McpError(PARAM_ERROR, "text 与 title 至少需要一个")
    if not title:
        title = " ".join(body.split())[:60] or "未命名记忆"
    kind = str(ctx.get("kind") or "fact")
    if kind not in MEMORY_KINDS:
        raise McpError(PARAM_ERROR, "未知记忆类型: %s（可选 %s）" % (kind, "/".join(MEMORY_KINDS)))
    evidence_kind = str(ctx.get("evidence_kind") or "agent_asserted")
    trust_map = {"user_stated": 0.9, "tool_output": 0.8, "code_run": 0.8, "document": 0.7,
                 "verification": 0.85, "web": 0.6, "derived": 0.5, "agent_asserted": 0.45}
    if evidence_kind not in trust_map:
        raise McpError(PARAM_ERROR, "未知证据类型: %s" % evidence_kind)
    memory = ctx.store.add_memory({
        "scope_id": ctx.scope(), "agent_id": ctx.agent_id, "kind": kind,
        "category": ctx.get("category"), "title": title, "body": body,
        "status": "candidate", "trust": trust_map[evidence_kind],
        "importance": float(ctx.get("importance") or 0.5),
        "metadata": {"tags": list(ctx.get("tags") or []), "source": "mcp"},
    }, origin="agent")
    quote = ctx.get("quote") or ctx.get("evidence_quote") or ""
    evidence = None
    if quote:
        try:
            evidence = ctx.store.add_evidence(memory["id"], {
                "kind": evidence_kind, "quote": str(quote),
                "uri": ctx.get("uri"), "note": "mcp memory_remember"}, origin="agent")
        except Exception as exc:  # noqa: BLE001 - 证据落库失败不放弃记忆
            evidence = {"error": str(exc)}
    return {"id": memory.get("id"), "status": memory.get("status"),
            "kind": memory.get("kind"), "title": memory.get("title"),
            "trust": memory.get("trust"), "scope": memory.get("scope_id"),
            "evidence": evidence}


def _t_recall(ctx: ToolContext) -> dict:
    query = str(ctx.require("query") or "").strip()
    scope = ctx.scope("agent:%s" % ctx.agent_id)
    limit = ctx.limit(10)
    result, logged = _retrieve(ctx, query, scope, limit, "hybrid")
    if not logged:
        _write_recall_log(ctx.store, query, scope, ctx.agent_id, result, "hybrid")
    return {"query": query, "scope": scope, "agent": ctx.agent_id,
            "hits": result.get("hits") or [], "degraded": result.get("degraded") or [],
            "total": result.get("total"), "took_ms": result.get("took_ms"),
            "strategy": result.get("strategy"), **_retrieval_meta(result)}


def _t_search(ctx: ToolContext) -> dict:
    query = str(ctx.require("query") or "").strip()
    scope = ctx.scope()
    limit = ctx.limit(20)
    strategy = str(ctx.get("strategy") or "hybrid")
    # 纯检索：不写 recall_log（AGENTS.md §5），也不走 recall_for_agent
    result, _ = _retrieve(ctx, query, scope, limit, strategy, plain=True)
    return {"query": query, "scope": scope, "strategy": result.get("strategy") or strategy,
            "hits": result.get("hits") or [], "total": result.get("total"),
            "degraded": result.get("degraded") or [], "took_ms": result.get("took_ms"),
            **_retrieval_meta(result)}


def _retrieval_meta(result: dict) -> dict:
    """检索实际跑了什么（附加字段）：agent 据此判断"相似"是不是语义的。"""
    return {key: result.get(key) for key in ("channels_used", "vector_model", "semantic",
                                             "reranked", "score_kind") if key in result}


def _retrieve(ctx: ToolContext, query: str, scope: str, limit: int,
              strategy: str, plain: bool = False) -> tuple[dict, bool]:
    """统一调用 retrieval；plain=True 走不写日志的 search 入口。"""
    try:
        from . import retrieval  # noqa: PLC0415
    except Exception as exc:  # noqa: BLE001
        return {"hits": [], "degraded": ["retrieval: 模块不可用（%s）" % exc], "total": 0,
                "took_ms": 0, "strategy": strategy}, False
    recall = getattr(retrieval, "recall_for_agent", None)
    search = getattr(retrieval, "search", None)
    try:
        if strategy == "hybrid" and callable(recall) and not plain:
            return dict(recall(ctx.store, ctx.gw, query, ctx.agent_id, scope, limit)), True
        if callable(search):
            return dict(search(ctx.store, ctx.gw, query, scope=scope, limit=limit,
                               strategy=strategy)), False
    except Exception as exc:  # noqa: BLE001
        return {"hits": [], "degraded": ["retrieval: 调用失败（%s）" % exc], "total": 0,
                "took_ms": 0, "strategy": strategy}, False
    return {"hits": [], "degraded": ["retrieval: 没有可用的检索入口"], "total": 0,
            "took_ms": 0, "strategy": strategy}, False


def _t_digest(ctx: ToolContext) -> dict:
    scope = ctx.scope()
    budget = int(ctx.get("budget") or 1200)
    task = ctx.get("task")
    try:
        from . import retrieval  # noqa: PLC0415
        fn = getattr(retrieval, "digest", None)
        if callable(fn):
            result = dict(fn(ctx.store, ctx.gw, scope=scope, budget=budget, task=task,
                             agent_id=ctx.agent_id))
            _write_recall_log(ctx.store, str(task or ""), scope, ctx.agent_id, result, "digest")
            return result
    except Exception as exc:  # noqa: BLE001
        return {"scope": scope, "text": "", "items": [], "count": 0,
                "degraded": ["digest: %s" % exc]}
    return {"scope": scope, "text": "", "items": [], "count": 0,
            "degraded": ["digest: 模块不可用"]}


def _t_get(ctx: ToolContext) -> dict:
    mid = str(ctx.require("id") or "").strip()
    memory = ctx.store.get_memory(mid)
    if memory is None:
        raise McpError(PARAM_ERROR, "记忆不存在: %s" % mid)
    return memory


def _t_update(ctx: ToolContext) -> dict:
    mid = str(ctx.require("id") or "").strip()
    patch = dict(ctx.get("patch") or {})
    for key in ("title", "body", "summary", "kind", "category", "status", "scope_id",
                "trust", "importance", "confidence", "tags", "pinned"):
        if key in ctx.args:
            patch[key] = ctx.args[key]
    if not patch:
        raise McpError(PARAM_ERROR, "没有可更新的字段")
    if "tags" in patch:
        memory = ctx.store.get_memory(mid)
        if memory is None:
            raise McpError(PARAM_ERROR, "记忆不存在: %s" % mid)
        meta = dict(memory.get("metadata") or {})
        meta["tags"] = list(patch.pop("tags") or [])
        patch["metadata"] = meta
    # agent 通道：不能自己批准，信任度只能调低（store.NotPermitted → -32602）
    return ctx.store.update_memory(mid, patch, origin="agent")


def _t_forget(ctx: ToolContext) -> dict:
    mid = str(ctx.require("id") or "").strip()
    hard = bool(ctx.get("hard"))
    if hard and str(ctx.get("confirm") or "").strip() != mid:
        # MEMORY-MODEL §7：物理删除需显式同意。HTTP DELETE 一直要求 confirm=<id>，MCP 1.0.0 没有。
        raise McpError(PARAM_ERROR, "物理删除不可恢复：需要同时传 confirm=<记忆 id> 表示明确同意")
    return ctx.store.delete_memory(mid, hard=hard)


def _t_relate(ctx: ToolContext) -> dict:
    src = str(ctx.require("src") or ctx.require("from") or "").strip()
    dst = str(ctx.require("dst") or ctx.require("to") or "").strip()
    rel = str(ctx.get("rel") or "semantic")
    origin = str(ctx.get("origin") or "explicit")
    edge = ctx.store.add_edge(src, str(ctx.get("src_kind") or "memory"), dst,
                              str(ctx.get("dst_kind") or "memory"), rel,
                              float(ctx.get("weight") or 1.0),
                              float(ctx.get("confidence") or 0.5), origin)
    return edge


def _t_evidence(ctx: ToolContext) -> dict:
    mid = str(ctx.require("id") or "").strip()
    kind = str(ctx.get("kind") or "agent_asserted")
    payload = {"kind": kind, "quote": ctx.get("quote"), "uri": ctx.get("uri"),
               "note": ctx.get("note"), "verified": bool(ctx.get("verified"))}
    if ctx.get("trust") is not None:
        payload["trust"] = float(ctx.get("trust"))
    return ctx.store.add_evidence(mid, payload, origin="agent")


def _t_review(ctx: ToolContext) -> dict:
    mid = str(ctx.require("id") or "").strip()
    try:
        grade = int(ctx.get("grade", 4))
    except (TypeError, ValueError):
        raise McpError(PARAM_ERROR, "grade 必须是 0..5 的整数") from None
    if not 0 <= grade <= 5:
        raise McpError(PARAM_ERROR, "grade 必须是 0..5 的整数")
    return _sm2(ctx.store, mid, grade)


def _sm2(store, mid: str, grade: int) -> dict:
    """SM-2 复习调度：写 review_log 并更新 memory 的到期时间。"""
    memory = store.get_memory(mid)
    if memory is None:
        raise McpError(PARAM_ERROR, "记忆不存在: %s" % mid)
    con = _con(store)
    row = con.execute(
        "SELECT ease, interval FROM review_log WHERE memory_id = ? ORDER BY at DESC, id DESC "
        "LIMIT 1", (mid,)).fetchone()
    ease = float(row["ease"]) if row and row["ease"] else 2.5
    interval = float(row["interval"]) if row and row["interval"] else 0.0
    repeats = int(con.execute(
        "SELECT count(*) FROM review_log WHERE memory_id = ? AND grade >= 3", (mid,)
    ).fetchone()[0])
    if grade >= 3:
        if repeats == 0:
            interval = 1.0
        elif repeats == 1:
            interval = 6.0
        else:
            interval = max(1.0, round(interval * ease))
        ease = max(1.3, ease + 0.1 - (5 - grade) * (0.08 + (5 - grade) * 0.02))
    else:
        interval = 1.0
        repeats = 0
    due = (_dt.datetime.now(_dt.timezone.utc) + _dt.timedelta(days=interval)).strftime(
        "%Y-%m-%dT%H:%M:%SZ")
    stamp = _db.now()
    txn = getattr(store, "_txn", None)
    try:
        if callable(txn):
            with txn() as conn:
                _write_review(conn, mid, grade, ease, interval, due, stamp)
        else:
            _write_review(con, mid, grade, ease, interval, due, stamp)
    except Exception as exc:  # noqa: BLE001
        raise McpError(INTERNAL_ERROR, "复习写库失败: %s" % exc) from exc
    return {"id": mid, "grade": grade, "ease": round(ease, 4), "interval_days": interval,
            "due": due, "review_count": repeats + (1 if grade >= 3 else 0)}


def _write_review(con, mid: str, grade: int, ease: float, interval: float, due: str,
                  stamp: str) -> None:
    con.execute(
        "INSERT INTO review_log(id, memory_id, grade, algorithm, interval, ease, due, at) "
        "VALUES(?,?,?,?,?,?,?,?)",
        ("rv-" + uuid.uuid4().hex[:12], mid, grade, "sm2", interval, ease, due, stamp),
    )
    con.execute(
        "UPDATE memory SET review_due = ?, last_reviewed = ?, review_count = review_count + 1, "
        "stability = ?, updated_at = ? WHERE id = ?",
        (due, stamp, interval, stamp, mid),
    )
    con.execute(
        "INSERT INTO audit(id, at, actor, action, target, detail) VALUES(?,?,?,?,?,?)",
        ("a-" + uuid.uuid4().hex[:12], stamp, "agent", "memory.review", mid,
         _dumps({"grade": grade, "due": due})),
    )


def _t_graph(ctx: ToolContext) -> dict:
    view = str(ctx.get("view") or "semantic")
    scope = ctx.get("scope") or ctx.get("scope_id") or None
    limit = int(ctx.get("limit") or 1000)
    return ctx.store.graph(view, scope, limit)


def _t_session_begin(ctx: ToolContext) -> dict:
    external = str(ctx.get("external_id") or ctx.get("session") or "").strip()
    if not external:
        external = "mcp-" + uuid.uuid4().hex[:12]
    return agents_mod.register_session(
        ctx.store, ctx.agent_id, external, title=str(ctx.get("title") or ""),
        cwd=str(ctx.get("cwd") or ""), scope_id=ctx.get("scope"))


def _t_session_end(ctx: ToolContext) -> dict:
    external = str(ctx.get("external_id") or ctx.get("session") or "").strip()
    if not external:
        raise McpError(PARAM_ERROR, "缺少必填参数: external_id")
    turns = ctx.get("turns")
    if isinstance(turns, str):
        turns = _loads(turns, [])
    return agents_mod.end_session(ctx.store, ctx.agent_id, external, turns=turns, gw=ctx.gw)


def _t_agent_status(ctx: ToolContext) -> dict:
    if ctx.get("probe"):
        agents_mod.probe_all(ctx.store)
    rows = agents_mod.agent_status(ctx.store)
    return {"agents": rows, "total": len(rows),
            "online": [r["id"] for r in rows if r.get("status") == "online"],
            "self": {"id": ctx.agent_id,
                     "status": next((r["status"] for r in rows if r["id"] == ctx.agent_id),
                                    "unregistered")}}


def _t_scope_list(ctx: ToolContext) -> dict:
    scopes = ctx.store.list_scopes()
    return {"scopes": scopes, "total": len(scopes)}


def _t_stats(ctx: ToolContext) -> dict:
    stats = dict(ctx.store.stats())
    try:
        rows = agents_mod.agent_status(ctx.store)
        stats["agents"] = {"total": len(rows),
                           "online": sum(1 for r in rows if r.get("status") == "online")}
    except Exception:  # noqa: BLE001
        stats["agents"] = {"total": 0, "online": 0}
    return stats


def _t_workflow_run(ctx: ToolContext) -> dict:
    template = ctx.get("template") or ctx.get("template_id") or ctx.get("id")
    if not template:
        raise McpError(PARAM_ERROR, "缺少必填参数: template")
    inputs = ctx.get("inputs") or {}
    if isinstance(inputs, str):
        inputs = _loads(inputs, {})
    try:
        from . import workflows  # noqa: PLC0415
    except Exception as exc:  # noqa: BLE001
        raise McpError(INTERNAL_ERROR, "工作流模块不可用: %s" % exc) from exc
    runner = getattr(workflows, "run_workflow", None)
    if not callable(runner):
        raise McpError(INTERNAL_ERROR, "工作流模块缺少 run_workflow")
    try:
        return runner(ctx.store, ctx.gw, str(template), inputs, scope=ctx.scope(),
                      trigger="agent")
    except Exception as exc:  # noqa: BLE001
        raise McpError(INTERNAL_ERROR, "工作流执行失败: %s: %s" % (type(exc).__name__, exc)) from exc


def _t_workflow_list(ctx: ToolContext) -> dict:
    try:
        from . import workflows  # noqa: PLC0415
        fn = getattr(workflows, "list_templates", None)
        if callable(fn):
            items = fn(ctx.store)
            return {"templates": items, "total": len(items)}
    except Exception as exc:  # noqa: BLE001
        return {"templates": [], "total": 0, "degraded": ["workflows: %s" % exc]}
    return {"templates": [], "total": 0, "degraded": ["workflows: 模块不可用"]}


def _t_export(ctx: ToolContext) -> dict:
    status = ctx.get("status")
    if status is None:
        status = "approved"
    text = exchange_mod.export_jsonl(ctx.store, scope=ctx.get("scope"), status=status,
                                     include_evidence=bool(ctx.get("include_evidence", True)))
    lines = [ln for ln in text.splitlines() if ln.strip()]
    return {"schema": exchange_mod.EXCHANGE_SCHEMA, "records": len(lines), "jsonl": text,
            "bytes": len(text.encode("utf-8"))}


def _t_import(ctx: ToolContext) -> dict:
    text = ctx.get("jsonl") or ctx.get("text") or ctx.get("data")
    if not text:
        raise McpError(PARAM_ERROR, "缺少必填参数: jsonl")
    if isinstance(text, list):
        text = "\n".join(_dumps(item) for item in text)
    # agent 通道的导入永远按 cap 策略（不能借导入自我认证，ADR-0002）
    return exchange_mod.import_jsonl(ctx.store, str(text), agent_id=ctx.agent_id,
                                     scope=ctx.scope(), dry_run=bool(ctx.get("dry_run")),
                                     trust="cap")


def _t_health(ctx: ToolContext) -> dict:
    con = _con(ctx.store)
    try:
        db_health = _db.health(con)
    except Exception as exc:  # noqa: BLE001
        db_health = {"ok": False, "error": "%s: %s" % (type(exc).__name__, exc)}
    models_health: Any = {}
    degraded: list[str] = []
    gw = ctx.gw or _make_gateway(ctx.store)
    if gw is None:
        degraded.append("models: 模型网关不可用")
    else:
        try:
            models_health = gw.health()
        except Exception as exc:  # noqa: BLE001
            models_health = {}
            degraded.append("models: %s: %s" % (type(exc).__name__, exc))
    try:
        rows = agents_mod.agent_status(ctx.store)
        agents_summary = {"total": len(rows),
                          "online": [r["id"] for r in rows if r.get("status") == "online"]}
    except Exception:  # noqa: BLE001
        agents_summary = {"total": 0, "online": []}
    if not db_health.get("ok", False):
        missing = ((db_health.get("tables") or {}).get("missing")) or []
        degraded.append("db: " + ("缺表 " + ",".join(missing) if missing
                                  else str(db_health.get("error") or "不可用")))
    # gw.health() 返回 {role: {...}}。1.0.0 在这里读 ["roles"]（永远是空），所以没配任何模型时
    # memory_health 仍报 degraded=[]——违反 AGENTS.md §6 与降级契约。
    roles = models_health if isinstance(models_health, dict) else {}
    if isinstance(roles.get("roles"), dict):
        roles = roles["roles"]
    for role, item in sorted(roles.items()):
        if isinstance(item, dict) and (item.get("degraded") or not item.get("ok", True)):
            degraded.append("model:%s 不可用" % role)
    # ok = 中枢本身可用（数据库正常）。模型不可用只进 degraded：AGENTS.md §6 要求此时照常使用。
    return {"ok": bool(db_health.get("ok")),
            "version": SERVER_VERSION, "protocol": PROTOCOL_VERSION,
            "db": db_health, "models": models_health, "agents": agents_summary,
            "degraded": degraded, "agent_id": ctx.agent_id}


HANDLERS: dict[str, Callable[[ToolContext], dict]] = {
    "memory_capture": _t_capture,
    "memory_remember": _t_remember,
    "memory_recall": _t_recall,
    "memory_search": _t_search,
    "memory_digest": _t_digest,
    "memory_get": _t_get,
    "memory_update": _t_update,
    "memory_forget": _t_forget,
    "memory_relate": _t_relate,
    "memory_evidence": _t_evidence,
    "memory_review": _t_review,
    "memory_graph": _t_graph,
    "memory_session_begin": _t_session_begin,
    "memory_session_end": _t_session_end,
    "memory_agent_status": _t_agent_status,
    "memory_scope_list": _t_scope_list,
    "memory_stats": _t_stats,
    "memory_workflow_run": _t_workflow_run,
    "memory_workflow_list": _t_workflow_list,
    "memory_export": _t_export,
    "memory_import": _t_import,
    "memory_health": _t_health,
}


# ============================================================
# 工具描述（tools/list 用）
# ============================================================

def _schema(properties: dict, required: list | None = None) -> dict:
    return {"type": "object", "properties": properties,
            "required": list(required or []), "additionalProperties": True}


_STR_SCOPE = {"type": "string", "description": "作用域，如 global / workspace:proj / agent:*"}
_STR_LIMIT = {"type": "integer", "description": "返回条数上限", "minimum": 1, "maximum": 200}

TOOL_SPECS: dict[str, dict] = {
    "memory_capture": dict(
        description="快速落草稿（零丢失）。写入 candidate 状态，之后由工作流提炼。",
        inputSchema=_schema({"text": {"type": "string", "description": "草稿正文"},
                             "title": {"type": "string"}, "kind": {"type": "string"},
                             "scope": _STR_SCOPE,
                             "tags": {"type": "array", "items": {"type": "string"}},
                             "importance": {"type": "number"}}, ["text"])),
    "memory_remember": dict(
        description="直接写一条记忆（默认 candidate）。没有证据时 evidence_kind 用 agent_asserted。",
        inputSchema=_schema({"text": {"type": "string"},
                             "title": {"type": "string"},
                             "kind": {"type": "string", "enum": list(MEMORY_KINDS)},
                             "scope": _STR_SCOPE,
                             "evidence_kind": {"type": "string",
                                               "enum": ["agent_asserted", "user_stated",
                                                        "tool_output", "code_run", "document",
                                                        "verification", "web", "derived"]},
                             "quote": {"type": "string"},
                             "uri": {"type": "string"}},
                            ["text"])),
    "memory_recall": dict(
        description="语义 + 全文 + 图混合召回（写 recall_log 并刷新在场）。",
        inputSchema=_schema({"query": {"type": "string"}, "scope": _STR_SCOPE,
                             "limit": _STR_LIMIT}, ["query"])),
    "memory_search": dict(
        description="纯检索：不写 recall_log（在场刷新由传输层心跳统一负责）。",
        inputSchema=_schema({"query": {"type": "string"}, "scope": _STR_SCOPE,
                             "strategy": {"type": "string"}, "limit": _STR_LIMIT},
                            ["query"])),
    "memory_digest": dict(
        description="生成预算内的上下文包（带 [m:记忆id] 引用）。",
        inputSchema=_schema({"scope": _STR_SCOPE, "budget": {"type": "integer"},
                             "task": {"type": "string"}})),
    "memory_get": dict(description="按 id 读取一条记忆（含证据/块/实体/关系）",
                       inputSchema=_schema({"id": {"type": "string"}}, ["id"])),
    "memory_update": dict(description="局部更新一条记忆",
                          inputSchema=_schema({"id": {"type": "string"}}, ["id"])),
    "memory_forget": dict(description="删除记忆（默认软删除 archived，hard=true 物理删除）",
                          inputSchema=_schema({"id": {"type": "string"},
                                               "hard": {"type": "boolean"},
                                               "confirm": {"type": "string"}}, ["id"])),
    "memory_relate": dict(description="建立关系边（含 contradicts / supersedes）",
                          inputSchema=_schema({"src": {"type": "string"},
                                               "dst": {"type": "string"},
                                               "rel": {"type": "string"}}, ["src", "dst"])),
    "memory_evidence": dict(description="给记忆追加证据",
                            inputSchema=_schema({"id": {"type": "string"},
                                                 "kind": {"type": "string"},
                                                 "quote": {"type": "string"}}, ["id"])),
    "memory_review": dict(description="复习评分（SM-2），返回下次到期时间",
                          inputSchema=_schema({"id": {"type": "string"},
                                               "grade": {"type": "integer", "minimum": 0,
                                                         "maximum": 5}}, ["id"])),
    "memory_graph": dict(description="取关系图（semantic / hierarchy / timeline / evidence）",
                         inputSchema=_schema({"view": {"type": "string"}, "scope": _STR_SCOPE,
                                              "limit": {"type": "integer"}})),
    "memory_session_begin": dict(description="会话开始（登记 agent_session 并刷新在场）",
                                 inputSchema=_schema({"external_id": {"type": "string"},
                                                      "title": {"type": "string"},
                                                      "cwd": {"type": "string"},
                                                      "scope": _STR_SCOPE})),
    "memory_session_end": dict(description="会话结束（沉淀 turns 并触发会话工作流）",
                               inputSchema=_schema({"external_id": {"type": "string"},
                                                    "turns": {"type": "array"}},
                                                   ["external_id"])),
    "memory_agent_status": dict(description="谁在线、谁在取记忆",
                                inputSchema=_schema({"probe": {"type": "boolean"}})),
    "memory_scope_list": dict(description="列出作用域及记忆数量",
                              inputSchema=_schema({})),
    "memory_stats": dict(description="库内计数快照", inputSchema=_schema({})),
    "memory_workflow_run": dict(description="运行一个工作流模板",
                                inputSchema=_schema({"template": {"type": "string"},
                                                     "inputs": {"type": "object"},
                                                     "scope": _STR_SCOPE}, ["template"])),
    "memory_workflow_list": dict(description="列出工作流模板", inputSchema=_schema({})),
    "memory_export": dict(description="导出为 memora-exchange/1 JSONL",
                          inputSchema=_schema({"scope": _STR_SCOPE,
                                               "status": {"type": "string"}})),
    "memory_import": dict(description="从 JSONL 导入（自动去重）",
                          inputSchema=_schema({"jsonl": {"type": "string"},
                                               "scope": _STR_SCOPE,
                                               "dry_run": {"type": "boolean"}}, ["jsonl"])),
    "memory_health": dict(description="健康与降级状态（DB/模型/智能体）",
                          inputSchema=_schema({})),
}

TOOLS: dict[str, dict] = {
    name: {"description": TOOL_SPECS[name]["description"],
           "inputSchema": TOOL_SPECS[name]["inputSchema"],
           "handler": HANDLERS[name]}
    for name in TOOL_NAMES
}


def list_tool_names() -> list[str]:
    """冻结的 22 个工具名。"""
    return list(TOOL_NAMES)


def tool_definitions() -> list[dict]:
    """tools/list 的返回体。"""
    return [{"name": name, "description": TOOLS[name]["description"],
             "inputSchema": TOOLS[name]["inputSchema"]} for name in TOOL_NAMES]


# ============================================================
# 分发
# ============================================================

def _make_gateway(store):
    """按需构造 ModelGateway；失败返回 None（降级，不阻断工具面）。"""
    try:
        from .models import ModelGateway  # noqa: PLC0415
        return ModelGateway(store)
    except Exception:  # noqa: BLE001
        return None


def dispatch(store, gw, name, args, agent_id="unknown") -> dict:
    """执行一个工具，永远返回 dict：{ok, result} 或 {ok, error:{code,message}}。"""
    args = dict(args or {})
    tool = TOOLS.get(name)
    if tool is None:
        return {"ok": False, "name": name, "agent_id": agent_id,
                "error": {"code": PARAM_ERROR,
                          "message": "未知工具: %s（可用 %s）" % (name, ", ".join(TOOL_NAMES))}}
    # 约定：每次 tools/call 都要刷新在场（ARCHITECTURE §6）
    try:
        agents_mod.heartbeat(store, agent_id, {"source": "mcp",
                                               "capabilities": {"tools": [name]}})
    except Exception as exc:  # noqa: BLE001 - 心跳失败不能阻断工具
        _stderr("heartbeat failed: %s" % exc)
    ctx = ToolContext(store, gw, agent_id, args, name)
    try:
        result = tool["handler"](ctx)
    except McpError as exc:
        _audit(store, "mcp.error", name,
               {"agent_id": agent_id, "code": exc.code, "message": exc.message})
        return {"ok": False, "name": name, "agent_id": agent_id,
                "error": {"code": exc.code, "message": exc.message}}
    except (KeyError, ValueError, TypeError) as exc:
        message = "%s: %s" % (type(exc).__name__, exc)
        _audit(store, "mcp.error", name, {"agent_id": agent_id, "message": message})
        return {"ok": False, "name": name, "agent_id": agent_id,
                "error": {"code": PARAM_ERROR, "message": message}}
    except Exception as exc:  # noqa: BLE001 - 任何异常都要转成 JSON-RPC 错误
        message = "%s: %s" % (type(exc).__name__, exc)
        _stderr(traceback.format_exc())
        _audit(store, "mcp.error", name, {"agent_id": agent_id, "message": message})
        return {"ok": False, "name": name, "agent_id": agent_id,
                "error": {"code": INTERNAL_ERROR, "message": message}}
    if name in WRITE_TOOLS:
        _audit(store, "mcp." + name, _result_id(result),
               {"agent_id": agent_id, "args": sorted(args)})
    return {"ok": True, "name": name, "agent_id": agent_id, "result": result}


def _result_id(result: Any) -> str | None:
    """从工具返回值里提取主对象 id（写审计用）。"""
    if not isinstance(result, dict):
        return None
    for key in ("id", "memory_id", "session_id"):
        value = result.get(key)
        if value:
            return str(value)
    for key in ("memory", "session", "evidence", "block"):
        nested = result.get(key)
        if isinstance(nested, dict) and nested.get("id"):
            return str(nested["id"])
    return None


def _stderr(message: str) -> None:
    """调试输出只走 stderr，绝不污染协议流。"""
    try:
        print("[memora-mcp] %s" % message, file=sys.stderr, flush=True)
    except Exception:  # noqa: BLE001
        pass


# ============================================================
# JSON-RPC 层
# ============================================================

def _rpc_ok(msg_id: Any, result: Any) -> dict:
    return {"jsonrpc": "2.0", "id": msg_id, "result": result}


def _rpc_err(msg_id: Any, code: int, message: str) -> dict:
    return {"jsonrpc": "2.0", "id": msg_id if msg_id is not None else None,
            "error": {"code": code, "message": message}}


def initialize_result(client_info: dict | None = None) -> dict:
    """initialize 的返回体。"""
    return {
        "protocolVersion": PROTOCOL_VERSION,
        "capabilities": {"tools": {}, "resources": {}},
        "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
        "instructions": "memora-core 记忆中枢：开工先 memory_recall，收尾用 memory_session_end。",
    }


def handle_rpc(store, gw, body: dict, headers: dict | None = None,
               agent_id: str = "unknown") -> dict | None:
    """处理一个 JSON-RPC 对象；通知类返回 None（不回帧）。

    任何异常都变成 JSON-RPC 错误帧：1.0.0 里一帧 params._meta 或 params.clientInfo 是字符串
    就抛 AttributeError，stdio 服务进程直接退出（HTTP 上是非 JSON-RPC 的 500）。
    """
    try:
        return _handle_rpc(store, gw, body, headers, agent_id)
    except Exception as exc:  # noqa: BLE001
        _stderr(traceback.format_exc())
        msg_id = body.get("id") if isinstance(body, dict) else None
        return _rpc_err(msg_id, INTERNAL_ERROR, "%s: %s" % (type(exc).__name__, exc))


def _handle_rpc(store, gw, body: dict, headers: dict | None = None,
                agent_id: str = "unknown") -> dict | None:
    if not isinstance(body, dict):
        return _rpc_err(None, INVALID_REQUEST, "JSON-RPC 消息必须是对象")
    method = body.get("method")
    msg_id = body.get("id")
    params = body.get("params") or {}
    is_notification = "id" not in body
    if not isinstance(params, dict):
        params = {}

    if method == "initialize":
        client = params.get("clientInfo")
        client = client if isinstance(client, dict) else {}
        who = str(client.get("name") or agent_id or "unknown")
        try:
            agents_mod.heartbeat(store, who, {"source": "mcp", "protocol": "mcp-stdio",
                                              "version": client.get("version") or "",
                                              "capabilities": {"client": True}})
        except Exception:  # noqa: BLE001
            pass
        return _rpc_ok(msg_id, initialize_result(client))
    if method in ("notifications/initialized", "initialized") or (
            isinstance(method, str) and method.startswith("notifications/")):
        return None
    if method == "ping":
        return _rpc_ok(msg_id, {})
    if method == "tools/list":
        return _rpc_ok(msg_id, {"tools": tool_definitions()})
    if method == "tools/call":
        name = str(params.get("name") or "")
        args = params.get("arguments") or {}
        if not isinstance(args, dict):
            return _rpc_err(msg_id, PARAM_ERROR, "tools/call 的 arguments 必须是对象")
        meta = params.get("_meta")
        meta = meta if isinstance(meta, dict) else {}
        who = str(params.get("agentId") or meta.get("agentId") or agent_id)
        outcome = dispatch(store, gw, name, args, agent_id=who)
        if not outcome.get("ok"):
            err = outcome.get("error") or {}
            return _rpc_err(msg_id, int(err.get("code") or INTERNAL_ERROR),
                            str(err.get("message") or "工具调用失败"))
        payload = outcome.get("result")
        text = json.dumps(payload, ensure_ascii=False, default=str)
        return _rpc_ok(msg_id, {
            "content": [{"type": "text", "text": text}],
            "structuredContent": payload,
            "isError": False,
        })
    if method == "resources/list":
        return _rpc_ok(msg_id, {"resources": []})
    if method == "prompts/list":
        return _rpc_ok(msg_id, {"prompts": []})
    if is_notification:
        return None
    return _rpc_err(msg_id, METHOD_NOT_FOUND, "未实现的方法: %s" % method)


def handle_http(store, gw, body: dict, headers: dict) -> dict:
    """给 server.py 复用：接受一个 JSON-RPC 对象，返回 JSON-RPC 响应对象。"""
    agent = (headers or {}).get("X-Memora-Agent") or (headers or {}).get("x-memora-agent")
    who = str(agent or "http-client")
    response = handle_rpc(store, gw, body, headers or {}, agent_id=who)
    if response is None:
        return _rpc_ok(body.get("id") if isinstance(body, dict) else None, {})
    return response


def process_line(store, gw, line: str, agent_id: str = "unknown") -> dict | None:
    """处理一行输入，返回要写回的行对象（通知返回 None）。"""
    text = (line or "").strip()
    if not text:
        return None
    try:
        body = json.loads(text)
    except ValueError as exc:
        return _rpc_err(None, PARSE_ERROR, "JSON 解析失败: %s" % exc)
    if isinstance(body, list):
        responses = []
        for item in body:
            resp = handle_rpc(store, gw, item, {}, agent_id=agent_id)
            if resp is not None:
                responses.append(resp)
        return responses or None  # type: ignore[return-value]
    return handle_rpc(store, gw, body, {}, agent_id=agent_id)


# ============================================================
# stdio 主循环
# ============================================================

def _build_store(paths):
    """按 paths 构造 Store（有 Vault 则带上 Markdown 镜像）。"""
    db_path = getattr(paths, "db", None)
    if db_path is None:
        raise RuntimeError("paths 缺少 db 属性")
    _db.init_db(db_path)
    from .store import Store  # noqa: PLC0415
    vault = None
    try:
        from .vault import Vault  # noqa: PLC0415
        vault = Vault(getattr(paths, "vault"))
    except Exception:  # noqa: BLE001 - vault 不可用不影响真源
        vault = None
    return Store(db_path, vault)


def run_stdio(paths, agent_id=None):
    """主循环：读 stdin 行 → JSON-RPC → 写 stdout 行。返回退出码。"""
    store = _build_store(paths)
    gw = _make_gateway(store)
    who = agent_id or "unknown"
    try:
        agents_mod.seed_agents(store)
    except Exception as exc:  # noqa: BLE001
        _stderr("seed_agents failed: %s" % exc)
    try:
        agents_mod.heartbeat(store, who, {"source": "mcp", "protocol": "mcp-stdio",
                                          "detail": "stdio 会话启动"})
    except Exception as exc:  # noqa: BLE001
        _stderr("heartbeat failed: %s" % exc)
    _stderr("memora-core MCP stdio ready (agent=%s, tools=%d)" % (who, len(TOOL_NAMES)))

    stdin = getattr(sys.stdin, "buffer", sys.stdin)
    stdout = getattr(sys.stdout, "buffer", sys.stdout)
    exit_code = 0
    try:
        for raw in stdin:
            try:
                line = raw.decode("utf-8") if isinstance(raw, bytes) else str(raw)
            except UnicodeDecodeError:
                line = raw.decode("utf-8", "replace") if isinstance(raw, bytes) else str(raw)
            stripped = line.strip()
            if not stripped:
                continue
            response = process_line(store, gw, stripped, agent_id=who)
            if response is None:
                continue
            payload = response if isinstance(response, list) else [response]
            for item in payload:
                frame = json.dumps(item, ensure_ascii=False, default=str) + "\n"
                stdout.write(frame.encode("utf-8"))
            stdout.flush()
    except KeyboardInterrupt:  # pragma: no cover - 交互式中断
        exit_code = 130
    except BrokenPipeError:  # pragma: no cover - 客户端提前关闭
        exit_code = 0
    finally:
        try:
            agents_mod.heartbeat(store, who, {"source": "mcp", "status": "idle",
                                              "detail": "stdio 会话结束"})
        except Exception:  # noqa: BLE001
            pass
        closer = getattr(store, "close", None)
        if callable(closer):
            try:
                closer()
            except Exception:  # noqa: BLE001
                pass
    return exit_code