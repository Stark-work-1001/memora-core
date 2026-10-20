# -*- coding: utf-8 -*-
"""领域仓库：把 schema.sql 的表封装成可用的领域对象。

职责边界：
  * 只做「读写 + 不变量 + 审计」，不做检索排序策略（见 retrieval.py）。
  * 所有写操作走 db.transaction()（BEGIN IMMEDIATE），并在同一事务内写 audit。
  * 写成功后把记忆镜像到 Vault（Markdown），镜像失败只记审计，绝不回滚真源。
"""
from __future__ import annotations

import calendar
import hashlib
import json
import re
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import TYPE_CHECKING, Any, Iterator

from . import db as dbmod
from .db import dumps, loads, now

if TYPE_CHECKING:  # pragma: no cover - 仅用于类型检查
    from .vault import Vault

# ---------------------------------------------------------------- 常量

MEMORY_FIELDS: tuple[str, ...] = (
    "id", "scope_id", "agent_id", "session_id", "kind", "category", "title", "body", "summary",
    "didactic", "status", "trust", "importance", "confidence", "sensitivity", "stability",
    "difficulty", "review_due", "review_count", "last_reviewed", "valid_from", "valid_to",
    "recorded_at", "updated_at", "superseded_by", "merged_into", "lang", "source_count",
    "tokens", "pinned", "metadata",
)
MEMORY_JSON_FIELDS: tuple[str, ...] = ("didactic", "metadata")
REQUIRED_MEMORY_FIELDS: tuple[str, ...] = ("title", "body", "kind", "scope_id")

MEMORY_KINDS: tuple[str, ...] = (
    "fact", "knowledge", "decision", "preference", "procedure", "experience",
    "task", "turn", "tool", "artifact",
)
STATUSES: tuple[str, ...] = (
    "draft", "candidate", "approved", "rejected", "superseded", "merged", "archived",
)
# 架构 §3.2：candidate → approved|rejected；approved → superseded|merged|archived。
# draft 是 schema 里存在的「未提交草稿」入口状态，这里显式登记，不做隐式放行。
STATUS_TRANSITIONS: dict[str, frozenset[str]] = {
    "draft": frozenset({"candidate", "approved", "rejected"}),
    "candidate": frozenset({"approved", "rejected", "draft"}),
    "approved": frozenset({"superseded", "merged", "archived"}),
    "rejected": frozenset({"candidate"}),
    "superseded": frozenset({"archived"}),
    "merged": frozenset({"archived"}),
    "archived": frozenset(),
}
SENSITIVITIES: tuple[str, ...] = ("normal", "private", "secret")

EVIDENCE_KINDS: tuple[str, ...] = (
    "user_stated", "agent_asserted", "tool_output", "document", "web",
    "derived", "verification", "code_run",
)
# 架构 §3.3 默认信任权重
EVIDENCE_TRUST: dict[str, float] = {
    "user_stated": 0.9, "verification": 0.85, "tool_output": 0.8, "code_run": 0.8,
    "document": 0.7, "web": 0.6, "derived": 0.5, "agent_asserted": 0.45,
}
AGENT_ONLY_TRUST_CAP = 0.5

# 写入来源（ADR-0002 不得自我认证）。README 的硬规则："只有 agent_asserted 证据的记忆，信任度
# 不超过 0.5，且绝不自动晋升"。1.0.0 只在 set_status 一处执行它：PATCH、MCP memory_update、
# 导入、内置 session-distill 工作流都能让 agent 或一份导入文件自己给自己盖"已批准 / 0.99"。
# 现在每个写入口都说明来源：
#   user     本机界面 / HTTP（人）       restore  人明确要求"原样恢复自己的备份"
#   agent    MCP 工具调用               import   交换格式导入（默认）
#   workflow 工作流落库
# 不受信来源（agent/import/workflow）：不能创建或迁移到 approved（创建时降为 candidate），
# 信任度封顶 AGENT_ONLY_TRUST_CAP，声称的证据照录但 verified 恒为 0。批准只能由人来做。
ORIGINS: tuple[str, ...] = ("user", "restore", "agent", "import", "workflow")
UNTRUSTED_ORIGINS: frozenset[str] = frozenset({"agent", "import", "workflow"})
TEXT_FIELDS: frozenset[str] = frozenset({"title", "body", "summary"})
SECRET_MIRROR_NOTE = "（敏感级别 secret：正文不写入 Markdown 镜像，只保存在 memora.db。）"


class NotPermitted(ValueError):
    """该来源无权做这件事（例如 agent 批准记忆）。ValueError 子类：HTTP 400，MCP -32602。"""


def _origin(value: Any) -> str:
    origin = str(value or "user").strip().lower()
    if origin not in ORIGINS:
        raise ValueError("未知写入来源: %s" % value)
    return origin

BLOCK_TYPES: tuple[str, ...] = (
    "formula", "image", "code", "table", "database", "list", "quote", "derivation",
)

SORTS: dict[str, str] = {
    "updated_at": "m.updated_at", "recorded_at": "m.recorded_at", "importance": "m.importance",
    "trust": "m.trust", "review_due": "m.review_due",
}
NUMERIC_SORTS: frozenset[str] = frozenset({"importance", "trust"})

# 语义脑图允许出现的边关系（架构 §4.2 graph semantic 视图）
SEMANTIC_RELS: tuple[str, ...] = (
    "semantic", "hypernym", "hyponym", "part_of", "causes", "supports", "contradicts", "alias",
)
HIERARCHY_RELS: tuple[str, ...] = ("part_of", "supersedes")
GRAPH_VIEWS: tuple[str, ...] = ("semantic", "hierarchy", "timeline", "evidence")

DEFAULT_LIMIT = 50
MAX_LIMIT = 500
QUERY_CAP = 4000
SNIPPET_CHARS = 180
EDGE_SAMPLE = 6000

_CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]")
_SPLIT_RE = re.compile(r"[\s,;:!?()\[\]{}<>\"'|/\\~@#$%^&*+=]+")


SCOPE_KINDS: tuple[str, ...] = (
    "global", "workspace", "agent", "task", "conversation", "document",
)

CANDIDATE_ACTIONS: tuple[str, ...] = ("add", "update", "supersede", "merge", "link", "noop", "ask")
CANDIDATE_STATUSES: tuple[str, ...] = (
    "pending", "auto_applied", "needs_review", "applied", "rejected",
)
CONFLICT_KINDS: tuple[str, ...] = (
    "duplicate", "contradiction", "stale", "scope_clash", "source_clash", "orphan",
)


# ---------------------------------------------------------------- 小工具


def _as_float(value: Any, default: float) -> float:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return default
    if out != out:  # NaN
        return default
    return out


def _as_int(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _clamp01(value: Any, default: float) -> float:
    return max(0.0, min(1.0, _as_float(value, default)))


def _clip(text: Any, size: int = SNIPPET_CHARS) -> str:
    flat = " ".join(str(text or "").split())
    if len(flat) <= size:
        return flat
    return flat[: size - 1].rstrip() + "…"


def _jsonable(value: Any) -> str:
    if isinstance(value, str):
        return value
    return dumps(value if value is not None else {})


def _local_midnight(day: str) -> int:
    """本地日历日 YYYY-MM-DD 的零点（epoch 秒）；解析不了返回 0。"""
    try:
        return int(time.mktime(time.strptime(str(day)[:10], "%Y-%m-%d")))
    except (ValueError, OverflowError):
        return 0


def _epoch(ts: Any) -> int:
    """把 'YYYY-MM-DDTHH:MM:SSZ' / 'YYYY-MM-DD HH:MM:SS' / 'YYYY-MM-DD' 解析为 UTC epoch 秒。"""
    if not ts:
        return 0
    raw = str(ts).strip().replace("T", " ").rstrip("Z")
    for fmt, size in (("%Y-%m-%d %H:%M:%S", 19), ("%Y-%m-%d %H:%M", 16), ("%Y-%m-%d", 10)):
        try:
            parsed = time.strptime(raw[:size], fmt)
        except (ValueError, OverflowError):
            continue
        return int(calendar.timegm(parsed))
    return 0


def _escape_like(text: str) -> str:
    return text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _fts_expr(query: str) -> str:
    """把用户查询规范成 FTS5 表达式：按标点/空白切分，逐段前缀短语 AND。

    中文没有词边界，unicode61 会把整段连续汉字当作一个 token，
    因此前缀短语只能命中「以该段开头」的 token；
    中段子串由 LIKE 补充（见 list_memories）。
    所有段都包成 "..." 短语并加 * 前缀，避免 MATCH 语法注入。
    """
    parts: list[str] = []
    for seg in _SPLIT_RE.split(query or ""):
        seg = seg.strip()
        if not seg:
            continue
        parts.append('"%s"*' % seg.replace('"', '""'))
    return " AND ".join(parts)


def _quote_phrase(query: str) -> str:
    return '"%s"*' % (query or "").replace('"', '""')


class Store:
    """记忆中枢的领域仓库。

    线程模型：每个线程持有自己的 sqlite3 连接（threading.local），
    写事务一律 BEGIN IMMEDIATE，读操作在 WAL 快照下不加锁。
    """

    def __init__(self, db_path: str | Path, vault: "Vault | None" = None) -> None:
        self.db_path = Path(db_path)
        self.vault = vault
        self.mirror = vault is not None  # 是否在写操作后镜像到 Markdown
        self._local = threading.local()
        self._lock = threading.RLock()
        self._conns: list[sqlite3.Connection] = []
        if vault is not None:
            attach = getattr(vault, "attach", None)
            if callable(attach):
                try:
                    attach(self)  # 让 vault 能回写 document 行
                except Exception:  # pragma: no cover - 镜像不可用不影响真源
                    pass

    # ------------------------------------------------------------ 连接

    @property
    def con(self) -> sqlite3.Connection:
        """当前线程的连接（懒创建，首次使用才打开）。"""
        con = getattr(self._local, "con", None)
        if con is None:
            con = dbmod.connect(self.db_path)
            self._local.con = con
            with self._lock:
                self._conns.append(con)
        return con

    def release_thread(self) -> None:
        """关闭**当前线程**的连接。短命线程（HTTP 服务每个 TCP 连接一个线程）结束前调用。

        1.0.0 从不关：每个连接线程留下一个打开的 sqlite 连接，20 个请求后 21 个。
        """
        con = getattr(self._local, "con", None)
        if con is None:
            return
        self._local.con = None
        with self._lock:
            try:
                self._conns.remove(con)
            except ValueError:
                pass
        try:
            con.close()
        except sqlite3.Error:  # pragma: no cover
            pass

    def open_connections(self) -> int:
        """本实例当前打开的连接数（诊断与测试用）。"""
        with self._lock:
            return len(self._conns)

    def close(self) -> None:
        """关闭本实例创建过的所有连接。"""
        with self._lock:
            conns, self._conns = self._conns, []
        for con in conns:
            try:
                con.close()
            except sqlite3.Error:  # pragma: no cover
                pass
        self._local = threading.local()

    @contextmanager
    def _txn(self) -> Iterator[sqlite3.Connection]:
        """写事务：已在事务中则复用（audit 追加到同一事务），
        否则 BEGIN IMMEDIATE。"""
        con = self.con
        if con.in_transaction:
            yield con
            return
        with dbmod.transaction(con):
            yield con

    # ------------------------------------------------------------ 审计

    def audit(
        self,
        action: str,
        target: str | None = None,
        actor: str = "system",
        detail: Any = None,
    ) -> None:
        """写一条审计记录；调用方已在事务中时追加到同一事务。"""
        payload = dumps(detail) if detail is not None else "{}"
        with self._txn() as con:
            con.execute(
                "INSERT INTO audit(id, at, actor, action, target, detail) VALUES(?,?,?,?,?,?)",
                ("a-" + uuid.uuid4().hex[:12], now(), actor, action, target, payload),
            )

    # ------------------------------------------------------------ 作用域

    def ensure_scope(
        self,
        scope_id: str,
        kind: str,
        name: str = "",
        parent_id: str | None = None,
    ) -> dict:
        """幂等地创建/更新作用域；path 由父作用域的 path 派生。"""
        sid = (scope_id or "").strip()
        if not sid:
            raise ValueError("scope_id 不能为空")
        skind = (kind or "workspace").strip() or "workspace"
        if skind not in SCOPE_KINDS:
            raise ValueError("未知作用域类型: %s" % skind)
        with self._txn() as con:
            row = con.execute("SELECT * FROM scope WHERE id = ?", (sid,)).fetchone()
            if row is not None:
                if name and name != (row["name"] or ""):
                    con.execute("UPDATE scope SET name = ? WHERE id = ?", (name, sid))
                    self.audit("scope.update", sid, detail={"name": name})
                    row = con.execute("SELECT * FROM scope WHERE id = ?", (sid,)).fetchone()
                return dict(row)
            parent_path = ""
            if parent_id:
                prow = con.execute("SELECT path FROM scope WHERE id = ?", (parent_id,)).fetchone()
                if prow is None:
                    raise ValueError("父作用域不存在: %s" % parent_id)
                parent_path = str(prow["path"])
            path = sid if not parent_path else "%s/%s" % (parent_path, sid)
            con.execute(
                "INSERT INTO scope(id, kind, parent_id, path, name, metadata, created_at) "
                "VALUES(?,?,?,?,?,?,?)",
                (sid, skind, parent_id, path, name, "{}", now()),
            )
            self.audit("scope.create", sid, detail={"kind": skind, "path": path})
            row = con.execute("SELECT * FROM scope WHERE id = ?", (sid,)).fetchone()
            return dict(row)

    def list_scopes(self) -> list[dict]:
        """按 path 排序返回全部作用域，附带未归档记忆数量与深度。"""
        rows = self.con.execute(
            "SELECT s.*, (SELECT count(*) FROM memory m WHERE m.scope_id = s.id "
            "AND m.status <> 'archived') AS memory_count FROM scope s ORDER BY s.path"
        ).fetchall()
        out: list[dict] = []
        for row in rows:
            item = dict(row)
            item["metadata"] = loads(item.get("metadata"), {}) or {}
            item["depth"] = max(0, str(item.get("path") or "").count("/"))
            out.append(item)
        return out

    def _scope_subtree(self, scope_id: str) -> list[str]:
        """作用域及其所有后代（scope.path 前缀）；找不到时退化为 id 前缀。"""
        con = self.con
        row = con.execute("SELECT path FROM scope WHERE id = ?", (scope_id,)).fetchone()
        if row is not None and row["path"]:
            path = str(row["path"])
            rows = con.execute(
                "SELECT id FROM scope WHERE path = ? OR path LIKE ? ESCAPE '\\' ORDER BY path",
                (path, _escape_like(path) + "/%"),
            ).fetchall()
            ids = [str(r["id"]) for r in rows]
            if ids:
                return ids
        rows = con.execute(
            "SELECT id FROM scope WHERE id = ? OR id LIKE ? ESCAPE '\\' ORDER BY id",
            (scope_id, _escape_like(scope_id) + "%"),
        ).fetchall()
        return [str(r["id"]) for r in rows] or [scope_id]

    def _scope_clause(self, scope_id: str | None) -> tuple[str, list[Any]]:
        """作用域前缀过滤子句（含子作用域）。"""
        if not scope_id:
            return "", []
        ids = self._scope_subtree(str(scope_id))
        if not ids:
            return " AND 1 = 0", []
        marks = ",".join("?" * len(ids))
        return " AND m.scope_id IN (%s)" % marks, list(ids)

    # ------------------------------------------------------------ 记忆

    def add_memory(self, data: dict, origin: str = "user") -> dict:
        """新增一条记忆。必填 title/body/kind/scope_id，其余按契约给默认值。

        origin 见 ORIGINS：不受信来源请求 approved 时降为 candidate（metadata.requested_status
        记下原请求），信任度封顶 AGENT_ONLY_TRUST_CAP。
        """
        origin = _origin(origin)
        payload = dict(data or {})
        missing = [k for k in REQUIRED_MEMORY_FIELDS if not str(payload.get(k) or "").strip()]
        if missing:
            raise ValueError("缺少必填字段: %s" % ", ".join(missing))
        mid = str(payload.get("id") or "").strip() or "m-" + uuid.uuid4().hex[:12]
        stamp = now()
        payload["id"] = mid
        payload.setdefault("status", "candidate")
        payload.setdefault("trust", 0.5)
        payload.setdefault("importance", 0.5)
        payload.setdefault("confidence", 0.5)
        payload.setdefault("recorded_at", stamp)
        payload.setdefault("updated_at", stamp)
        payload.setdefault("sensitivity", "normal")
        payload.setdefault("source_count", 0)
        payload.setdefault("review_count", 0)
        payload.setdefault("pinned", 0)
        payload["didactic"] = payload.get("didactic") or {}
        payload["metadata"] = payload.get("metadata") or {}

        status = str(payload["status"]).strip()
        if status not in STATUSES:
            raise ValueError("未知记忆状态: %s" % status)
        kind = str(payload["kind"]).strip()
        if kind not in MEMORY_KINDS:
            raise ValueError("未知记忆类型: %s" % kind)
        if str(payload["sensitivity"]).strip() not in SENSITIVITIES:
            raise ValueError("未知敏感级别: %s" % payload["sensitivity"])
        payload["trust"] = _clamp01(payload["trust"], 0.5)
        payload["importance"] = _clamp01(payload["importance"], 0.5)
        payload["confidence"] = _clamp01(payload["confidence"], 0.5)
        if not payload.get("tokens"):
            payload["tokens"] = max(1, len(str(payload["body"])) // 3)
        demoted = False
        if origin in UNTRUSTED_ORIGINS:
            metadata = dict(payload["metadata"]) if isinstance(payload["metadata"], dict) else {}
            if status == "approved":
                status = payload["status"] = "candidate"
                metadata["requested_status"] = "approved"
                demoted = True
            metadata["origin"] = origin
            payload["metadata"] = metadata
            payload["trust"] = min(payload["trust"], AGENT_ONLY_TRUST_CAP)

        row = {k: payload.get(k) for k in MEMORY_FIELDS}
        for field in MEMORY_JSON_FIELDS:
            row[field] = _jsonable(row.get(field))
        row["pinned"] = 1 if row.get("pinned") else 0
        row["review_count"] = _as_int(row.get("review_count"), 0)
        row["source_count"] = _as_int(row.get("source_count"), 0)
        row["tokens"] = _as_int(row.get("tokens"), 1)

        with self._txn() as con:
            if con.execute("SELECT 1 FROM memory WHERE id = ?", (mid,)).fetchone():
                raise ValueError("记忆已存在: %s" % mid)
            scope_id = str(row["scope_id"])
            if not con.execute("SELECT 1 FROM scope WHERE id = ?", (scope_id,)).fetchone():
                prefix = scope_id.split(":", 1)[0]
                # 作用域缺失时按 id 前缀推断种类并自动登记，避免记忆悬空
                self.ensure_scope(
                    scope_id, prefix if prefix in SCOPE_KINDS else "workspace",
                    name=scope_id.split(":", 1)[-1],
                )
            columns = ", ".join(MEMORY_FIELDS)
            marks = ", ".join("?" * len(MEMORY_FIELDS))
            con.execute(
                "INSERT INTO memory(%s) VALUES(%s)" % (columns, marks),
                tuple(row[k] for k in MEMORY_FIELDS),
            )
            self.audit(
                "memory.create", mid,
                detail={"title": row["title"], "kind": kind, "scope": scope_id, "status": status,
                        "origin": origin, "demoted": demoted},
            )
        self._mirror(mid)
        return self.get_memory(mid) or {}

    def get_memory(self, mid: str) -> dict | None:
        """返回展开后的记忆：JSON 字段解析为对象，
        并附带 evidence/blocks/entities/edges/documents。"""
        row = self.con.execute("SELECT * FROM memory WHERE id = ?", (mid,)).fetchone()
        if row is None:
            return None
        item = dict(row)
        for field in MEMORY_JSON_FIELDS:
            item[field] = loads(item.get(field), {}) or {}
        item["tags"] = list((item.get("metadata") or {}).get("tags") or [])
        item["evidence"] = self.list_evidence(mid)
        item["blocks"] = self.list_blocks(mid)
        item["entities"] = self._memory_entities(mid)
        item["edges"] = self._memory_edges(mid)
        item["documents"] = self._memory_documents(mid)
        return item

    def update_memory(self, mid: str, patch: dict, origin: str = "user") -> dict:
        """局部更新记忆；状态变更走状态机。先校验全部字段、再在**一个**事务里写入。

        1.0.0 先提交状态迁移、再校验其它字段：kind 非法时返回 400，但状态已经改了。
        不受信来源不能把状态改成 approved，信任度只能调低到 AGENT_ONLY_TRUST_CAP 以内。
        正文变化时作废该记忆的缓存向量（否则检索仍按旧文本的向量命中）。
        """
        origin = _origin(origin)
        payload = {k: v for k, v in dict(patch or {}).items() if k in MEMORY_FIELDS}
        payload.pop("id", None)
        status = payload.pop("status", None)
        status = str(status).strip() if status is not None and str(status).strip() else None
        if status is not None and status not in STATUSES:
            raise ValueError("未知记忆状态: %s" % status)
        if status == "approved" and origin in UNTRUSTED_ORIGINS:
            raise NotPermitted("来源 %s 不能批准记忆：批准只能由人在界面里完成（%s）" % (origin, mid))
        fields: dict[str, Any] = {}
        for key, value in payload.items():
            if key == "recorded_at":
                continue  # 记录时间不可改
            if key in MEMORY_JSON_FIELDS:
                fields[key] = _jsonable(value)
            elif key in ("trust", "importance", "confidence"):
                fields[key] = _clamp01(value, 0.5)
            elif key == "pinned":
                fields[key] = 1 if value else 0
            elif key == "kind" and str(value) not in MEMORY_KINDS:
                raise ValueError("未知记忆类型: %s" % value)
            elif key == "sensitivity" and str(value) not in SENSITIVITIES:
                raise ValueError("未知敏感级别: %s" % value)
            else:
                fields[key] = value
        if origin in UNTRUSTED_ORIGINS and "trust" in fields:
            fields["trust"] = min(fields["trust"], AGENT_ONLY_TRUST_CAP)
        fields["updated_at"] = now()
        with self._txn() as con:
            row = con.execute("SELECT * FROM memory WHERE id = ?", (mid,)).fetchone()
            if row is None:
                raise KeyError("记忆不存在: %s" % mid)
            if status is not None:
                self._transition(con, row, status, "", origin)
            assignments = ", ".join("%s = ?" % k for k in fields)
            con.execute(
                "UPDATE memory SET %s WHERE id = ?" % assignments,
                tuple(fields[k] for k in fields) + (mid,),
            )
            if TEXT_FIELDS & set(fields):
                con.execute("DELETE FROM vector WHERE owner_kind = 'memory' AND owner_id = ?",
                            (mid,))
            self._apply_trust_ceiling(con, mid)
            self.audit("memory.update", mid, detail={"fields": sorted(fields), "origin": origin})
        self._mirror(mid)
        return self.get_memory(mid) or {}

    def _trust_ceiling(self, con: sqlite3.Connection, mid: str) -> float | None:
        """信任度上限；None 表示不封顶。

        * 证据全是 agent_asserted → AGENT_ONLY_TRUST_CAP（README 硬规则，对谁都成立）；
        * 不受信来源创建、且还没被人批准 → AGENT_ONLY_TRUST_CAP。
        """
        kinds = [str(r["kind"]) for r in con.execute(
            "SELECT kind FROM evidence WHERE memory_id = ?", (mid,)).fetchall()]
        if kinds and all(k == "agent_asserted" for k in kinds):
            return AGENT_ONLY_TRUST_CAP
        row = con.execute("SELECT status, metadata FROM memory WHERE id = ?", (mid,)).fetchone()
        if row is not None and str(row["status"]) != "approved":
            origin = str((loads(row["metadata"], {}) or {}).get("origin") or "user")
            if origin in UNTRUSTED_ORIGINS:
                return AGENT_ONLY_TRUST_CAP
        return None

    def _apply_trust_ceiling(self, con: sqlite3.Connection, mid: str) -> None:
        ceiling = self._trust_ceiling(con, mid)
        if ceiling is not None:
            con.execute("UPDATE memory SET trust = min(trust, ?) WHERE id = ?", (ceiling, mid))

    def delete_memory(self, mid: str, hard: bool = False) -> dict:
        """软删除＝标记 archived（保留审计链）；
        hard=True 物理删除（级联证据/块/关系）。"""
        with self._txn() as con:
            row = con.execute("SELECT id, status FROM memory WHERE id = ?", (mid,)).fetchone()
            if row is None:
                raise KeyError("记忆不存在: %s" % mid)
            if hard:
                con.execute("DELETE FROM memory WHERE id = ?", (mid,))
                # 这些表没有指向 memory 的外键，1.0.0 硬删除后会留下孤儿行
                con.execute("DELETE FROM edge WHERE (src = ? AND src_kind = 'memory') "
                            "OR (dst = ? AND dst_kind = 'memory')", (mid, mid))
                con.execute("DELETE FROM vector WHERE owner_kind = 'memory' AND owner_id = ?",
                            (mid,))
                con.execute("DELETE FROM review_log WHERE memory_id = ?", (mid,))
                con.execute("DELETE FROM candidate WHERE memory_id = ? OR target_id = ?",
                            (mid, mid))
                con.execute("DELETE FROM conflict WHERE a_id = ? OR b_id = ?", (mid, mid))
                self.audit("memory.delete", mid, detail={"hard": True})
                result = {"id": mid, "hard": True, "status": "deleted"}
            else:
                con.execute(
                    "UPDATE memory SET status = 'archived', updated_at = ? WHERE id = ?",
                    (now(), mid),
                )
                self.audit("memory.delete", mid,
                           detail={"hard": False, "from": row["status"]})
                result = {"id": mid, "hard": False, "status": "archived"}
        if hard:
            self._prune_mirror(mid)
        else:
            self._mirror(mid)
        result["at"] = now()
        return result

    def set_status(self, mid: str, status: str, note: str = "", origin: str = "user") -> dict:
        """状态机迁移；非法迁移抛 ValueError（candidate→superseded 就是非法）。
        不受信来源迁移到 approved 抛 NotPermitted。"""
        origin = _origin(origin)
        target = (status or "").strip()
        if target not in STATUSES:
            raise ValueError("未知记忆状态: %s" % target)
        if target == "approved" and origin in UNTRUSTED_ORIGINS:
            raise NotPermitted("来源 %s 不能批准记忆：批准只能由人在界面里完成（%s）" % (origin, mid))
        with self._txn() as con:
            row = con.execute("SELECT * FROM memory WHERE id = ?", (mid,)).fetchone()
            if row is None:
                raise KeyError("记忆不存在: %s" % mid)
            self._transition(con, row, target, note, origin)
        self._mirror(mid)
        updated = self.get_memory(mid)
        return updated if updated is not None else {"id": mid, "status": target}

    def _transition(self, con: sqlite3.Connection, row: sqlite3.Row, target: str, note: str,
                    origin: str) -> None:
        """在调用方的事务里执行一次状态迁移（校验 + 封顶 + 审计）。"""
        mid = str(row["id"])
        current = str(row["status"])
        if target != current and target not in STATUS_TRANSITIONS.get(current, frozenset()):
            raise ValueError("非法状态迁移: %s → %s（%s）" % (current, target, mid))
        trust = _as_float(row["trust"], 0.5)
        capped = False
        if target == "approved" and trust > AGENT_ONLY_TRUST_CAP:
            kinds = [str(r["kind"]) for r in con.execute(
                "SELECT kind FROM evidence WHERE memory_id = ?", (mid,)
            ).fetchall()]
            if kinds and all(k == "agent_asserted" for k in kinds):
                trust = AGENT_ONLY_TRUST_CAP  # 架构 §3.3：只有 agent_asserted 证据时封顶
                capped = True
        con.execute(
            "UPDATE memory SET status = ?, trust = ?, updated_at = ? WHERE id = ?",
            (target, trust, now(), mid),
        )
        self.audit(
            "memory.set_status", mid,
            detail={"from": current, "to": target, "note": note, "trust_capped": capped,
                    "origin": origin},
        )

    def list_memories(self, filters: dict | None = None) -> dict:
        """分页查询记忆，返回 {items,total,limit,offset,query}；items 带 snippet。

        过滤：q / scope（含前缀子作用域）/ kind / status / agent / session /
        sort / order / limit / offset / include_archived。
        """
        flt = dict(filters or {})
        limit = max(1, min(MAX_LIMIT, _as_int(flt.get("limit"), DEFAULT_LIMIT)))
        offset = max(0, _as_int(flt.get("offset"), 0))
        order = "asc" if str(flt.get("order") or "desc").lower() == "asc" else "desc"
        sort_key = str(flt.get("sort") or "")
        sort = sort_key if sort_key in SORTS else "updated_at"
        q = str(flt.get("q") or "").strip()
        include_archived = bool(flt.get("include_archived"))

        where: list[str] = []
        params: list[Any] = []
        clause, sparams = self._scope_clause(flt.get("scope"))
        if clause:
            where.append(clause.strip()[len("AND "):] if clause.strip().startswith("AND ")
                         else clause.strip())
            params.extend(sparams)
        for column, key in (("m.kind", "kind"), ("m.status", "status"),
                            ("m.agent_id", "agent"), ("m.session_id", "session")):
            value = flt.get(key)
            if value:
                where.append("%s = ?" % column)
                params.append(str(value))
        if not flt.get("status") and not include_archived:
            where.append("m.status <> 'archived'")

        con = self.con
        rank: dict[str, int] = {}
        if q:
            fts_ids = self._fts_ids(con, q)
            seen = set(fts_ids)
            ids = fts_ids + [i for i in self._like_ids(con, q) if i not in seen]
            if not ids:
                return {
                    "items": [], "total": 0, "limit": limit, "offset": offset,
                    "query": self._echo(flt, q, sort, order, limit, offset),
                }
            rank = {mid: idx for idx, mid in enumerate(ids)}
            marks = ",".join("?" * len(ids))
            where.append("m.id IN (%s)" % marks)
            params.extend(ids)

        where_sql = (" WHERE " + " AND ".join(where)) if where else ""
        if rank:
            rows = con.execute("SELECT m.* FROM memory m%s" % where_sql, tuple(params)).fetchall()
            items = [dict(r) for r in rows]
            numeric = sort in NUMERIC_SORTS
            items.sort(
                key=lambda r: _as_float(r.get(sort), 0.0) if numeric else str(r.get(sort) or ""),
                reverse=(order == "desc"),
            )
            items.sort(key=lambda r: rank.get(str(r.get("id")), 10 ** 9))
            total = len(items)
            page = items[offset: offset + limit]
        else:
            total = int(con.execute(
                "SELECT count(*) FROM memory m%s" % where_sql, tuple(params)
            ).fetchone()[0])
            direction = "ASC" if order == "asc" else "DESC"
            rows = con.execute(
                "SELECT m.* FROM memory m%s ORDER BY %s %s, m.id ASC LIMIT ? OFFSET ?"
                % (where_sql, SORTS[sort], direction),
                tuple(params) + (limit, offset),
            ).fetchall()
            page = [dict(r) for r in rows]

        snippets = self._snippet_map(con, [str(r["id"]) for r in page], q)
        out_items: list[dict] = []
        for row in page:
            item = dict(row)
            for field in MEMORY_JSON_FIELDS:
                item[field] = loads(item.get(field), {}) or {}
            item["tags"] = list((item.get("metadata") or {}).get("tags") or [])
            item["snippet"] = snippets.get(str(row["id"])) or _clip(row.get("body"))
            out_items.append(item)
        return {
            "items": out_items, "total": total, "limit": limit, "offset": offset,
            "query": self._echo(flt, q, sort, order, limit, offset),
        }

    @staticmethod
    def _echo(flt: dict, q: str, sort: str, order: str, limit: int, offset: int) -> dict:
        """回显生效的查询参数，方便前端与调试。"""
        return {
            "q": q, "scope": flt.get("scope"), "kind": flt.get("kind"),
            "status": flt.get("status"), "agent": flt.get("agent"),
            "session": flt.get("session"), "sort": sort, "order": order,
            "limit": limit, "offset": offset,
            "include_archived": bool(flt.get("include_archived")),
        }

    def _fts_ids(self, con: sqlite3.Connection, query: str) -> list[str]:
        """FTS5 前缀短语召回；表达式非法时退化为整串短语。"""
        expr = _fts_expr(query)
        if not expr:
            return []
        sql = (
            "SELECT m.id AS id FROM memory_fts JOIN memory m ON m.rowid = memory_fts.rowid "
            "WHERE memory_fts MATCH ? ORDER BY bm25(memory_fts) LIMIT ?"
        )
        for candidate in (expr, _quote_phrase(query)):
            try:
                rows = con.execute(sql, (candidate, QUERY_CAP)).fetchall()
            except sqlite3.OperationalError:
                continue
            return [str(r["id"]) for r in rows]
        return []

    def _like_ids(self, con: sqlite3.Connection, query: str) -> list[str]:
        """中文子串补充召回：unicode61 把连续汉字当单 token，中段子串只能靠 LIKE。"""
        terms = [query] + [s for s in _SPLIT_RE.split(query) if len(s) >= 2]
        seen: list[str] = []
        known: set[str] = set()
        for term in terms[:6]:
            pattern = "%" + _escape_like(term) + "%"
            rows = con.execute(
                "SELECT m.id AS id FROM memory m WHERE (m.title LIKE ? ESCAPE '\\' "
                "OR m.body LIKE ? ESCAPE '\\' OR coalesce(m.summary, '') LIKE ? ESCAPE '\\') "
                "ORDER BY m.updated_at DESC, m.id LIMIT ?",
                (pattern, pattern, pattern, QUERY_CAP),
            ).fetchall()
            for row in rows:
                mid = str(row["id"])
                if mid not in known:
                    known.add(mid)
                    seen.append(mid)
            if len(seen) >= QUERY_CAP:
                break
        return seen

    def _snippet_map(
        self, con: sqlite3.Connection, ids: list[str], query: str
    ) -> dict[str, str]:
        """用 FTS5 snippet() 生成高亮片段（[ ] 标记），
        失败时由调用方回落正文前 180 字。"""
        out: dict[str, str] = {}
        if not ids or not query:
            return out
        expr = _fts_expr(query)
        if not expr:
            return out
        marks = ",".join("?" * len(ids))
        sql = (
            "SELECT m.id AS id, snippet(memory_fts, -1, '[', ']', '…', 16) AS sn "
            "FROM memory_fts JOIN memory m ON m.rowid = memory_fts.rowid "
            "WHERE memory_fts MATCH ? AND m.id IN (%s)" % marks
        )
        try:
            rows = con.execute(sql, tuple([expr] + ids)).fetchall()
        except sqlite3.OperationalError:
            return out
        for row in rows:
            out[str(row["id"])] = _clip(row["sn"])
        return out

    # ------------------------------------------------------------ 证据 / 块

    def add_evidence(self, mid: str, data: dict, origin: str = "user") -> dict:
        """新增证据；trust 缺省取架构 §3.3 的 kind 权重，并同步 source_count。"""
        payload = dict(data or {})
        kind = str(payload.get("kind") or "").strip()
        if kind not in EVIDENCE_KINDS:
            raise ValueError("未知证据类型: %s" % kind)
        origin = _origin(origin)
        if origin in UNTRUSTED_ORIGINS:
            # 不受信来源声称的证据照录（种类、引文），但不能自称"已核验"
            payload["verified"] = False
            payload["verifier"] = None
        eid = str(payload.get("id") or "").strip() or "e-" + uuid.uuid4().hex[:12]
        trust = _clamp01(payload.get("trust"), EVIDENCE_TRUST.get(kind, 0.5))
        created = str(payload.get("created_at") or now())
        with self._txn() as con:
            if not con.execute("SELECT 1 FROM memory WHERE id = ?", (mid,)).fetchone():
                raise KeyError("记忆不存在: %s" % mid)
            con.execute(
                "INSERT INTO evidence(id, memory_id, document_id, chunk_id, session_id, turn_id, "
                "kind, quote, uri, hash, trust, verified, verifier, note, created_at) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    eid, mid, payload.get("document_id"), payload.get("chunk_id"),
                    payload.get("session_id"), payload.get("turn_id"), kind,
                    payload.get("quote"), payload.get("uri"), payload.get("hash"), trust,
                    1 if payload.get("verified") else 0, payload.get("verifier"),
                    payload.get("note"), created,
                ),
            )
            rows = con.execute(
                "SELECT kind FROM evidence WHERE memory_id = ?", (mid,)
            ).fetchall()
            kinds = [str(r["kind"]) for r in rows]
            row = con.execute("SELECT trust FROM memory WHERE id = ?", (mid,)).fetchone()
            mem_trust = _as_float(row["trust"], 0.5)
            if kinds and all(k == "agent_asserted" for k in kinds):
                mem_trust = min(mem_trust, AGENT_ONLY_TRUST_CAP)  # 只封顶，绝不抬高
            con.execute(
                "UPDATE memory SET source_count = ?, trust = ?, updated_at = ? WHERE id = ?",
                (len(kinds), mem_trust, now(), mid),
            )
            self._apply_trust_ceiling(con, mid)
            self.audit("evidence.add", mid,
                       detail={"evidence_id": eid, "kind": kind, "trust": trust})
        self._mirror(mid)
        row = self.con.execute("SELECT * FROM evidence WHERE id = ?", (eid,)).fetchone()
        return self._evidence_dict(row) if row else {"id": eid, "memory_id": mid, "kind": kind}

    @staticmethod
    def _evidence_dict(row: sqlite3.Row) -> dict:
        item = dict(row)
        item["verified"] = bool(item.get("verified"))
        item["trust"] = _as_float(item.get("trust"), 0.5)
        return item

    def list_evidence(self, mid: str) -> list[dict]:
        rows = self.con.execute(
            "SELECT * FROM evidence WHERE memory_id = ? ORDER BY created_at, id", (mid,)
        ).fetchall()
        return [self._evidence_dict(r) for r in rows]

    def add_block(self, mid: str, data: dict) -> dict:
        """新增富形式块（公式/代码/表格/图片/数据库引用…）。"""
        payload = dict(data or {})
        btype = str(payload.get("type") or "").strip()
        if btype not in BLOCK_TYPES:
            raise ValueError("未知块类型: %s" % btype)
        bid = str(payload.get("id") or "").strip() or "b-" + uuid.uuid4().hex[:12]
        ordinal = _as_int(payload.get("ordinal"), 0)
        with self._txn() as con:
            if not con.execute("SELECT 1 FROM memory WHERE id = ?", (mid,)).fetchone():
                raise KeyError("记忆不存在: %s" % mid)
            if ordinal <= 0:
                row = con.execute(
                    "SELECT coalesce(max(ordinal), 0) + 1 FROM block WHERE memory_id = ?", (mid,)
                ).fetchone()
                ordinal = int(row[0])
            con.execute(
                "INSERT INTO block(id, memory_id, ordinal, type, lang, caption, content, fields) "
                "VALUES(?,?,?,?,?,?,?,?)",
                (bid, mid, ordinal, btype, payload.get("lang"), payload.get("caption"),
                 str(payload.get("content") or ""), _jsonable(payload.get("fields") or {})),
            )
            self.audit("block.add", mid,
                       detail={"block_id": bid, "type": btype, "ordinal": ordinal})
        self._mirror(mid)
        row = self.con.execute("SELECT * FROM block WHERE id = ?", (bid,)).fetchone()
        return self._block_dict(row) if row else {"id": bid, "memory_id": mid, "type": btype}

    @staticmethod
    def _block_dict(row: sqlite3.Row) -> dict:
        item = dict(row)
        item["fields"] = loads(item.get("fields"), {}) or {}
        return item

    def list_blocks(self, mid: str) -> list[dict]:
        rows = self.con.execute(
            "SELECT * FROM block WHERE memory_id = ? ORDER BY ordinal, id", (mid,)
        ).fetchall()
        return [self._block_dict(r) for r in rows]

    # ------------------------------------------------------------ 实体与图

    def upsert_entity(
        self, name: str, kind: str, definition: str = "", scope_id: str | None = None
    ) -> dict:
        """按 (name, kind) 幂等登记实体。"""
        label = (name or "").strip()
        if not label:
            raise ValueError("实体名不能为空")
        ekind = (kind or "concept").strip() or "concept"
        with self._txn() as con:
            row = con.execute(
                "SELECT * FROM entity WHERE name = ? AND kind = ?", (label, ekind)
            ).fetchone()
            if row is not None:
                if definition and definition != (row["definition"] or ""):
                    con.execute(
                        "UPDATE entity SET definition = ?, scope_id = coalesce(?, scope_id) "
                        "WHERE id = ?", (definition, scope_id, row["id"]),
                    )
                    self.audit("entity.update", str(row["id"]), detail={"name": label})
                    row = con.execute(
                        "SELECT * FROM entity WHERE id = ?", (row["id"],)
                    ).fetchone()
                return dict(row)
            eid = "en-" + uuid.uuid4().hex[:12]
            con.execute(
                "INSERT INTO entity(id, name, kind, definition, scope_id, importance, created_at) "
                "VALUES(?,?,?,?,?,?,?)",
                (eid, label, ekind, definition or "", scope_id, 0.5, now()),
            )
            self.audit("entity.create", eid, detail={"name": label, "kind": ekind})
            row = con.execute("SELECT * FROM entity WHERE id = ?", (eid,)).fetchone()
            return dict(row)

    def link_memory_entity(self, mid: str, entity_id: str, role: str = "mention") -> None:
        """建立 memory → entity 的提及关系（幂等）。"""
        with self._txn() as con:
            if not con.execute("SELECT 1 FROM memory WHERE id = ?", (mid,)).fetchone():
                raise KeyError("记忆不存在: %s" % mid)
            if not con.execute("SELECT 1 FROM entity WHERE id = ?", (entity_id,)).fetchone():
                raise KeyError("实体不存在: %s" % entity_id)
            con.execute(
                "INSERT OR IGNORE INTO memory_entity(memory_id, entity_id, role) VALUES(?,?,?)",
                (mid, entity_id, role or "mention"),
            )
            self.audit("memory.entity.link", mid,
                       detail={"entity_id": entity_id, "role": role or "mention"})

    def add_edge(
        self,
        src: str,
        src_kind: str,
        dst: str,
        dst_kind: str,
        rel: str,
        weight: float = 1.0,
        confidence: float = 0.5,
        origin: str = "explicit",
        **kw: Any,
    ) -> dict:
        """新增/更新一条边（(src,src_kind,dst,dst_kind,rel) 唯一）。"""
        if not (src and dst and rel):
            raise ValueError("edge 需要 src / dst / rel")
        if src_kind not in ("memory", "entity", "chunk", "document"):
            raise ValueError("未知 src_kind: %s" % src_kind)
        if dst_kind not in ("memory", "entity", "chunk", "document"):
            raise ValueError("未知 dst_kind: %s" % dst_kind)
        eid = str(kw.get("id") or "") or "d-" + uuid.uuid4().hex[:12]
        with self._txn() as con:
            con.execute(
                "INSERT INTO edge(id, src, src_kind, dst, dst_kind, rel, weight, confidence, "
                "origin, valid_from, valid_to, metadata) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) "
                "ON CONFLICT(src, src_kind, dst, dst_kind, rel) DO UPDATE SET "
                "weight = excluded.weight, confidence = excluded.confidence, "
                "origin = excluded.origin, metadata = excluded.metadata",
                (
                    eid, src, src_kind, dst, dst_kind, rel, _as_float(weight, 1.0),
                    _clamp01(confidence, 0.5), origin or "explicit", kw.get("valid_from"),
                    kw.get("valid_to"), _jsonable(kw.get("metadata") or {}),
                ),
            )
            self.audit("edge.add", "%s->%s" % (src, dst),
                       detail={"rel": rel, "src_kind": src_kind, "dst_kind": dst_kind})
            row = con.execute(
                "SELECT * FROM edge WHERE src = ? AND src_kind = ? AND dst = ? AND dst_kind = ? "
                "AND rel = ?", (src, src_kind, dst, dst_kind, rel),
            ).fetchone()
        return self._edge_dict(row) if row else {"id": eid, "src": src, "dst": dst, "rel": rel}

    @staticmethod
    def _edge_dict(row: sqlite3.Row) -> dict:
        item = dict(row)
        item["metadata"] = loads(item.get("metadata"), {}) or {}
        item["weight"] = _as_float(item.get("weight"), 1.0)
        item["confidence"] = _as_float(item.get("confidence"), 0.5)
        return item

    def _memory_entities(self, mid: str) -> list[dict]:
        rows = self.con.execute(
            "SELECT e.*, me.role AS role FROM memory_entity me JOIN entity e ON e.id = me.entity_id "
            "WHERE me.memory_id = ? ORDER BY e.name", (mid,),
        ).fetchall()
        return [dict(r) for r in rows]

    def _memory_edges(self, mid: str) -> list[dict]:
        rows = self.con.execute(
            "SELECT * FROM edge WHERE src = ? OR dst = ? ORDER BY rel, id", (mid, mid)
        ).fetchall()
        return [self._edge_dict(r) for r in rows]

    def _memory_documents(self, mid: str) -> list[dict]:
        rows = self.con.execute(
            "SELECT DISTINCT d.id AS id, d.path AS path, d.title AS title, d.kind AS kind, "
            "d.hash AS hash, d.day AS day FROM evidence ev JOIN document d ON d.id = ev.document_id "
            "WHERE ev.memory_id = ? ORDER BY d.path", (mid,),
        ).fetchall()
        return [dict(r) for r in rows]

    # ------------------------------------------------------------ 图视图

    def graph(self, view: str, scope_id: str | None = None, limit: int = 1000) -> dict:
        """四种脑图视图；节点/边都是可直接 json.dumps 的 dict。"""
        name = (view or "semantic").strip().lower()
        if name not in GRAPH_VIEWS:
            raise ValueError("未知图视图: %s（可选 %s）" % (view, "/".join(GRAPH_VIEWS)))
        cap = max(1, min(5000, _as_int(limit, 1000)))
        builders = {
            "semantic": self._graph_semantic,
            "hierarchy": self._graph_hierarchy,
            "timeline": self._graph_timeline,
            "evidence": self._graph_evidence,
        }
        nodes, edges, truncated = builders[name](scope_id, cap)
        return {
            "nodes": nodes,
            "edges": edges,
            "meta": {
                "view": name,
                "scope": scope_id,
                "node_count": len(nodes),
                "edge_count": len(edges),
                "truncated": bool(truncated),
                "built_at": now(),
                "limit": cap,
            },
        }

    def _graph_memories(
        self, con: sqlite3.Connection, scope_id: str | None, cap: int, order: str
    ) -> tuple[list[sqlite3.Row], bool]:
        """取图用记忆集合；多取一条用于判定 truncated。"""
        clause, params = self._scope_clause(scope_id)
        sql = "SELECT m.* FROM memory m WHERE m.status <> 'archived'" + clause
        sql += " ORDER BY %s LIMIT ?" % order
        rows = con.execute(sql, tuple(params) + (cap + 1,)).fetchall()
        return rows[:cap], len(rows) > cap

    @staticmethod
    def _finish_degrees(nodes: dict[str, dict], edges: list[dict]) -> list[dict]:
        degree: dict[str, int] = {}
        for edge in edges:
            degree[edge["source"]] = degree.get(edge["source"], 0) + 1
            degree[edge["target"]] = degree.get(edge["target"], 0) + 1
        for key, node in nodes.items():
            node["degree"] = int(degree.get(key, 0))
        return list(nodes.values())

    def _graph_semantic(
        self, scope_id: str | None, cap: int
    ) -> tuple[list[dict], list[dict], bool]:
        """词义网络：memory 节点 + entity 节点 + 语义边 + mention 边。"""
        con = self.con
        mems, truncated = self._graph_memories(con, scope_id, cap, "m.importance DESC, m.id")
        mem_ids = [str(r["id"]) for r in mems]
        if not mem_ids:
            return [], [], truncated
        nodes: dict[str, dict] = {}
        for row in mems:
            mid = str(row["id"])
            nodes[mid] = {
                "id": mid, "kind": "memory", "label": row["title"] or mid,
                "mem_kind": row["kind"], "scope": row["scope_id"], "status": row["status"],
                "trust": _as_float(row["trust"], 0.5),
            }
        marks = ",".join("?" * len(mem_ids))
        ent_rows = con.execute(
            "SELECT DISTINCT e.* FROM entity e JOIN memory_entity me ON me.entity_id = e.id "
            "WHERE me.memory_id IN (%s) ORDER BY e.importance DESC, e.name LIMIT ?" % marks,
            tuple(mem_ids) + (cap,),
        ).fetchall()
        for row in ent_rows:
            eid = str(row["id"])
            nodes[eid] = {
                "id": eid, "kind": "entity", "label": row["name"] or eid,
                "entity_kind": row["kind"], "definition": _clip(row["definition"], 120),
            }
        edges: list[dict] = []
        mentions = con.execute(
            "SELECT memory_id, entity_id, role FROM memory_entity WHERE memory_id IN (%s)"
            % marks, tuple(mem_ids),
        ).fetchall()
        for row in mentions:
            sid, tid = str(row["memory_id"]), str(row["entity_id"])
            if sid in nodes and tid in nodes:
                edges.append({
                    "id": "me:%s:%s" % (sid, tid), "source": sid, "target": tid,
                    "rel": "mentions", "weight": 1.0, "confidence": 1.0,
                    "origin": "explicit", "role": row["role"],
                })
        ids = mem_ids + [str(r["id"]) for r in ent_rows]
        rels = ",".join("?" * len(SEMANTIC_RELS))
        imarks = ",".join("?" * len(ids))
        rows = con.execute(
            "SELECT * FROM edge WHERE rel IN (%s) AND (src IN (%s) OR dst IN (%s)) "
            "ORDER BY weight DESC, id LIMIT ?" % (rels, imarks, imarks),
            tuple(SEMANTIC_RELS) + tuple(ids) + tuple(ids) + (EDGE_SAMPLE,),
        ).fetchall()
        for row in rows:
            src, dst = str(row["src"]), str(row["dst"])
            if src in nodes and dst in nodes:
                item = self._edge_dict(row)
                edges.append({
                    "id": item["id"], "source": src, "target": dst, "rel": item["rel"],
                    "weight": item["weight"], "confidence": item["confidence"],
                    "origin": item["origin"],
                })
        return self._finish_degrees(nodes, edges), edges, truncated

    def _graph_hierarchy(
        self, scope_id: str | None, cap: int
    ) -> tuple[list[dict], list[dict], bool]:
        """层级图：scope 树（global→workspace→agent→task）+ 记忆的 part_of/supersedes。"""
        con = self.con
        nodes: dict[str, dict] = {}
        edges: list[dict] = []
        if scope_id:
            ids = self._scope_subtree(scope_id)
            marks = ",".join("?" * len(ids))
            scope_rows = con.execute(
                "SELECT * FROM scope WHERE id IN (%s) ORDER BY path LIMIT ?" % marks,
                tuple(ids) + (cap,),
            ).fetchall()
        else:
            scope_rows = con.execute(
                "SELECT * FROM scope ORDER BY path LIMIT ?", (cap,)
            ).fetchall()
        for row in scope_rows:
            sid = str(row["id"])
            nodes[sid] = {
                "id": sid, "kind": "scope", "label": row["name"] or sid,
                "scope_kind": row["kind"], "depth": max(0, str(row["path"] or "").count("/")),
                "parent": row["parent_id"], "path": row["path"],
            }
        for row in scope_rows:
            parent = row["parent_id"]
            if parent and str(parent) in nodes:
                edges.append({
                    "id": "sc:%s:%s" % (parent, row["id"]), "source": str(parent),
                    "target": str(row["id"]), "rel": "contains", "weight": 1.0,
                    "confidence": 1.0, "origin": "explicit",
                })
        mems, truncated = self._graph_memories(con, scope_id, cap, "m.updated_at DESC, m.id")
        mem_ids = [str(r["id"]) for r in mems]
        for row in mems:
            mid = str(row["id"])
            scope_ref = str(row["scope_id"])
            parent_node = nodes.get(scope_ref)
            nodes[mid] = {
                "id": mid, "kind": "memory", "label": row["title"] or mid,
                "mem_kind": row["kind"], "status": row["status"],
                "depth": (int(parent_node["depth"]) + 1) if parent_node else 0,
                "parent": scope_ref if parent_node else row["superseded_by"],
            }
            if parent_node is not None:
                edges.append({
                    "id": "ms:%s" % mid, "source": mid, "target": scope_ref,
                    "rel": "in_scope", "weight": 1.0, "confidence": 1.0,
                    "origin": "explicit",
                })
        if mem_ids:
            marks = ",".join("?" * len(mem_ids))
            rels = ",".join("?" * len(HIERARCHY_RELS))
            rows = con.execute(
                "SELECT * FROM edge WHERE rel IN (%s) AND src IN (%s) AND dst IN (%s) LIMIT ?"
                % (rels, marks, marks),
                tuple(HIERARCHY_RELS) + tuple(mem_ids) + tuple(mem_ids) + (EDGE_SAMPLE,),
            ).fetchall()
            for row in rows:
                item = self._edge_dict(row)
                edges.append({
                    "id": item["id"], "source": str(row["src"]), "target": str(row["dst"]),
                    "rel": item["rel"], "weight": item["weight"],
                    "confidence": item["confidence"], "origin": item["origin"],
                })
        return self._finish_degrees(nodes, edges), edges, truncated

    def _graph_timeline(
        self, scope_id: str | None, cap: int
    ) -> tuple[list[dict], list[dict], bool]:
        """时间线：按 recorded_at 的**本地**日历日分桶（与日记页一致），桶内按时间串成
        temporal_next。日节点的 t 是本地零点。"""
        con = self.con
        mems, truncated = self._graph_memories(con, scope_id, cap, "m.recorded_at DESC, m.id")
        nodes: dict[str, dict] = {}
        edges: list[dict] = []
        buckets: dict[str, list[str]] = {}
        for row in mems:
            mid = str(row["id"])
            stamp = str(row["recorded_at"] or "")
            bucket = dbmod.local_day(stamp) if stamp else "0000-00-00"
            day_id = "day:" + bucket
            if day_id not in nodes:
                nodes[day_id] = {
                    "id": day_id, "kind": "day", "label": bucket, "bucket": bucket,
                    "t": _local_midnight(bucket), "depth": 0,
                }
            nodes[mid] = {
                "id": mid, "kind": "memory", "label": row["title"] or mid,
                "mem_kind": row["kind"], "bucket": bucket, "t": _epoch(stamp), "depth": 1,
            }
            edges.append({
                "id": "td:%s:%s" % (bucket, mid), "source": day_id, "target": mid,
                "rel": "contains", "weight": 1.0, "confidence": 1.0, "origin": "explicit",
            })
            buckets.setdefault(bucket, []).append(mid)
        for ids in buckets.values():
            ids.sort(key=lambda mid: int(nodes[mid]["t"]))
            for prev, nxt in zip(ids, ids[1:]):
                gap = max(0, int(nodes[nxt]["t"]) - int(nodes[prev]["t"]))
                edges.append({
                    "id": "tn:%s:%s" % (prev, nxt), "source": prev, "target": nxt,
                    "rel": "temporal_next", "weight": float(gap), "confidence": 1.0,
                    "origin": "inferred",
                })
        return self._finish_degrees(nodes, edges), edges, truncated

    def _graph_evidence(
        self, scope_id: str | None, cap: int
    ) -> tuple[list[dict], list[dict], bool]:
        """证据图：memory → evidence → document/chunk，边标注 evidence.kind 与 trust。"""
        con = self.con
        mems, truncated = self._graph_memories(con, scope_id, cap, "m.importance DESC, m.id")
        mem_ids = [str(r["id"]) for r in mems]
        if not mem_ids:
            return [], [], truncated
        nodes: dict[str, dict] = {}
        edges: list[dict] = []
        for row in mems:
            mid = str(row["id"])
            nodes[mid] = {
                "id": mid, "kind": "memory", "label": row["title"] or mid,
                "mem_kind": row["kind"], "trust": _as_float(row["trust"], 0.5),
            }
        marks = ",".join("?" * len(mem_ids))
        ev_rows = con.execute(
            "SELECT * FROM evidence WHERE memory_id IN (%s) ORDER BY created_at, id LIMIT ?"
            % marks, tuple(mem_ids) + (cap * 3,),
        ).fetchall()
        for row in ev_rows:
            eid, mid = str(row["id"]), str(row["memory_id"])
            if mid not in nodes:
                continue
            trust = _as_float(row["trust"], 0.5)
            nodes[eid] = {
                "id": eid, "kind": "evidence", "label": "%s · %s" % (
                    row["kind"], _clip(row["quote"] or row["uri"] or "证据", 60)),
                "evidence_kind": row["kind"], "trust": trust,
                "verified": bool(row["verified"]),
            }
            edges.append({
                "id": "ev:%s:%s" % (mid, eid), "source": mid, "target": eid,
                "rel": "evidence", "kind": row["kind"], "trust": trust,
                "weight": trust, "confidence": trust, "origin": "explicit",
            })
            doc_id, chunk_id = row["document_id"], row["chunk_id"]
            if doc_id:
                doc = con.execute(
                    "SELECT id, path, title, kind FROM document WHERE id = ?", (doc_id,)
                ).fetchone()
                if doc is not None:
                    did = str(doc["id"])
                    nodes.setdefault(did, {
                        "id": did, "kind": "document",
                        "label": doc["title"] or doc["path"], "doc_kind": doc["kind"],
                        "path": doc["path"],
                    })
                    edges.append({
                        "id": "ed:%s:%s" % (eid, did), "source": eid, "target": did,
                        "rel": "document", "kind": "document", "trust": trust,
                        "weight": 1.0, "confidence": trust, "origin": "explicit",
                    })
            if chunk_id:
                chunk = con.execute(
                    "SELECT id, heading, text FROM chunk WHERE id = ?", (chunk_id,)
                ).fetchone()
                if chunk is not None:
                    cid = str(chunk["id"])
                    nodes.setdefault(cid, {
                        "id": cid, "kind": "chunk",
                        "label": _clip(chunk["heading"] or chunk["text"] or cid, 60),
                    })
                    edges.append({
                        "id": "ec:%s:%s" % (eid, cid), "source": eid, "target": cid,
                        "rel": "chunk", "kind": "chunk", "trust": trust,
                        "weight": 1.0, "confidence": trust, "origin": "explicit",
                    })
        return self._finish_degrees(nodes, edges), edges, truncated

    # ------------------------------------------------------------ 文档

    def add_document(self, data: dict) -> dict:
        """按 vault 相对路径 upsert 文档行（hash/bytes/updated_at 由调用方给出）。"""
        payload = dict(data or {})
        path = str(payload.get("path") or "").strip()
        if not path:
            raise ValueError("document.path 不能为空")
        text_hash = str(payload.get("hash") or "") or hashlib.sha256(
            str(payload.get("text") or path).encode("utf-8")
        ).hexdigest()
        stamp = now()
        with self._txn() as con:
            row = con.execute("SELECT * FROM document WHERE path = ?", (path,)).fetchone()
            if row is not None:
                doc_id = str(row["id"])
                con.execute(
                    "UPDATE document SET kind = ?, title = ?, scope_id = ?, day = ?, hash = ?, "
                    "bytes = ?, frontmatter = ?, origin = ?, status = ?, updated_at = ? WHERE id = ?",
                    (
                        payload.get("kind") or row["kind"], payload.get("title") or row["title"],
                        payload.get("scope_id") or row["scope_id"],
                        payload.get("day") or row["day"], text_hash,
                        _as_int(payload.get("bytes"), _as_int(row["bytes"], 0)),
                        _jsonable(payload.get("frontmatter") or {}),
                        payload.get("origin") or row["origin"],
                        payload.get("status") or row["status"], stamp, doc_id,
                    ),
                )
                self.audit("document.upsert", doc_id, detail={"path": path, "updated": True})
            else:
                doc_id = str(payload.get("id") or "").strip() or "doc-" + uuid.uuid4().hex[:12]
                con.execute(
                    "INSERT INTO document(id, kind, path, title, scope_id, day, hash, bytes, "
                    "frontmatter, origin, status, created_at, updated_at, indexed_at) "
                    "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (
                        doc_id, payload.get("kind") or "note", path, payload.get("title"),
                        payload.get("scope_id"), payload.get("day"), text_hash,
                        _as_int(payload.get("bytes"), 0),
                        _jsonable(payload.get("frontmatter") or {}),
                        payload.get("origin") or "memora", payload.get("status") or "active",
                        stamp, stamp, None,
                    ),
                )
                self.audit("document.upsert", doc_id, detail={"path": path, "updated": False})
            row = con.execute("SELECT * FROM document WHERE id = ?", (doc_id,)).fetchone()
        return self._document_dict(row) if row else {"id": doc_id, "path": path}

    @staticmethod
    def _document_dict(row: sqlite3.Row) -> dict:
        item = dict(row)
        item["frontmatter"] = loads(item.get("frontmatter"), {}) or {}
        return item

    def list_documents(self, filters: dict | None = None) -> dict:
        """分页查询文档，返回 {items,total,limit,offset,query}。"""
        flt = dict(filters or {})
        limit = max(1, min(MAX_LIMIT, _as_int(flt.get("limit"), DEFAULT_LIMIT)))
        offset = max(0, _as_int(flt.get("offset"), 0))
        where: list[str] = []
        params: list[Any] = []
        for column, key in (("d.kind", "kind"), ("d.scope_id", "scope"), ("d.day", "day"),
                            ("d.status", "status"), ("d.origin", "origin")):
            if flt.get(key):
                where.append("%s = ?" % column)
                params.append(str(flt[key]))
        q = str(flt.get("q") or "").strip()
        if q:
            where.append("(d.path LIKE ? ESCAPE '\\' OR d.title LIKE ? ESCAPE '\\')")
            params.extend(["%" + _escape_like(q) + "%"] * 2)
        where_sql = (" WHERE " + " AND ".join(where)) if where else ""
        con = self.con
        total = int(con.execute(
            "SELECT count(*) FROM document d%s" % where_sql, tuple(params)
        ).fetchone()[0])
        rows = con.execute(
            "SELECT d.* FROM document d%s ORDER BY d.updated_at DESC, d.path LIMIT ? OFFSET ?"
            % where_sql, tuple(params) + (limit, offset),
        ).fetchall()
        return {
            "items": [self._document_dict(r) for r in rows],
            "total": total, "limit": limit, "offset": offset,
            "query": {"q": q, "kind": flt.get("kind"), "scope": flt.get("scope"),
                      "day": flt.get("day")},
        }

    def get_document(self, doc_id: str) -> dict | None:
        """按 id 取文档；找不到时按 vault 相对路径再试一次。"""
        row = self.con.execute("SELECT * FROM document WHERE id = ?", (doc_id,)).fetchone()
        if row is None:
            row = self.con.execute("SELECT * FROM document WHERE path = ?", (doc_id,)).fetchone()
        if row is None:
            return None
        item = self._document_dict(row)
        item["chunk_count"] = int(self.con.execute(
            "SELECT count(*) FROM chunk WHERE document_id = ?", (item["id"],)
        ).fetchone()[0])
        return item

    def replace_chunks(self, doc_id: str, chunks: list[dict]) -> int:
        """整体替换文档切块，返回写入数量（触发器会同步 chunk_fts）。"""
        payload = list(chunks or [])
        with self._txn() as con:
            if not con.execute("SELECT 1 FROM document WHERE id = ?", (doc_id,)).fetchone():
                raise KeyError("文档不存在: %s" % doc_id)
            con.execute("DELETE FROM chunk WHERE document_id = ?", (doc_id,))
            for index, chunk in enumerate(payload):
                text = str(chunk.get("text") or "")
                if not text:
                    continue
                cid = str(chunk.get("id") or "").strip() or "ch-" + uuid.uuid4().hex[:12]
                digest = str(chunk.get("hash") or "") or hashlib.sha256(
                    text.encode("utf-8")
                ).hexdigest()
                con.execute(
                    "INSERT INTO chunk(id, document_id, ordinal, heading, level, text, tokens, "
                    "start_line, end_line, hash) VALUES(?,?,?,?,?,?,?,?,?,?)",
                    (
                        cid, doc_id, _as_int(chunk.get("ordinal"), index + 1),
                        chunk.get("heading"), chunk.get("level"), text,
                        _as_int(chunk.get("tokens"), max(1, len(text) // 3)),
                        chunk.get("start_line"), chunk.get("end_line"), digest,
                    ),
                )
            stamp = now()
            con.execute("UPDATE document SET indexed_at = ?, updated_at = ? WHERE id = ?",
                        (stamp, stamp, doc_id))
            count = int(con.execute(
                "SELECT count(*) FROM chunk WHERE document_id = ?", (doc_id,)
            ).fetchone()[0])
            self.audit("document.chunks", doc_id, detail={"chunks": count})
        return count

    # ------------------------------------------------------------ 候选 / 冲突

    def add_candidate(self, data: dict) -> dict:
        """登记一条候选（去重/冲突/判定的中间产物）。"""
        payload = dict(data or {})
        action = str(payload.get("action") or "add").strip()
        if action not in CANDIDATE_ACTIONS:
            raise ValueError("未知候选动作: %s" % action)
        status = str(payload.get("status") or "pending").strip()
        if status not in CANDIDATE_STATUSES:
            raise ValueError("未知候选状态: %s" % status)
        cid = str(payload.get("id") or "").strip() or "cand-" + uuid.uuid4().hex[:12]
        with self._txn() as con:
            con.execute(
                "INSERT INTO candidate(id, batch_id, memory_id, scope_id, action, target_id, "
                "payload, dedup, judge, status, run_id, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    cid, payload.get("batch_id"), payload.get("memory_id"),
                    payload.get("scope_id"), action, payload.get("target_id"),
                    _jsonable(payload.get("payload") or {}),
                    _jsonable(payload.get("dedup") or {}),
                    _jsonable(payload.get("judge") or {}), status, payload.get("run_id"), now(),
                ),
            )
            self.audit("candidate.add", cid, detail={"action": action, "status": status})
            row = con.execute("SELECT * FROM candidate WHERE id = ?", (cid,)).fetchone()
        return self._candidate_dict(row) if row else {"id": cid}

    @staticmethod
    def _candidate_dict(row: sqlite3.Row) -> dict:
        item = dict(row)
        for field in ("payload", "dedup", "judge"):
            item[field] = loads(item.get(field), {}) or {}
        return item

    # 1.1.0 删除了 decide_candidate：它没有任何生产调用方，却用原生 SQL 改记忆状态、绕过状态机
    # （candidate → superseded 本是非法迁移）；auto_applied 的 add/update 会把记忆自动批准
    # （违反 ADR-0002）；supersede 的方向还是反的（把新候选标成"被旧目标取代"）。
    # 采纳裁决请走 set_status / update_memory（带 origin），见 workflows 的 persist 节点。

    def add_conflict(self, data: dict) -> dict:
        """登记冲突（重复/矛盾/过期/作用域冲突/来源冲突/孤立）。"""
        payload = dict(data or {})
        kind = str(payload.get("kind") or "").strip()
        if kind not in CONFLICT_KINDS:
            raise ValueError("未知冲突类型: %s" % kind)
        cid = str(payload.get("id") or "").strip() or "x-" + uuid.uuid4().hex[:12]
        with self._txn() as con:
            con.execute(
                "INSERT INTO conflict(id, kind, a_id, b_id, score, detail, status, resolution, "
                "created_at) VALUES(?,?,?,?,?,?,?,?,?)",
                (
                    cid, kind, payload.get("a_id"), payload.get("b_id"),
                    _clamp01(payload.get("score"), 0.0),
                    _jsonable(payload.get("detail") or {}),
                    payload.get("status") or "open", payload.get("resolution"), now(),
                ),
            )
            self.audit("conflict.add", cid, detail={"kind": kind})
            row = con.execute("SELECT * FROM conflict WHERE id = ?", (cid,)).fetchone()
        return self._conflict_dict(row) if row else {"id": cid}

    @staticmethod
    def _conflict_dict(row: sqlite3.Row) -> dict:
        item = dict(row)
        item["detail"] = loads(item.get("detail"), {}) or {}
        item["score"] = _as_float(item.get("score"), 0.0)
        return item

    def resolve_conflict(self, cid: str, resolution: Any) -> dict:
        """关闭冲突并记录处置说明。"""
        text = resolution if isinstance(resolution, str) else dumps(resolution or {})
        with self._txn() as con:
            if not con.execute("SELECT 1 FROM conflict WHERE id = ?", (cid,)).fetchone():
                raise KeyError("冲突不存在: %s" % cid)
            con.execute(
                "UPDATE conflict SET status = 'resolved', resolution = ?, resolved_at = ? "
                "WHERE id = ?", (text, now(), cid),
            )
            self.audit("conflict.resolve", cid, detail={"resolution": text[:200]})
            row = con.execute("SELECT * FROM conflict WHERE id = ?", (cid,)).fetchone()
        return self._conflict_dict(row) if row else {"id": cid, "status": "resolved"}

    # ------------------------------------------------------------ 设置 / 统计

    def get_setting(self, key: str, default: Any = None) -> Any:
        """读设置；值按 JSON 解析，解析失败原样返回字符串。"""
        row = self.con.execute("SELECT value FROM setting WHERE key = ?", (key,)).fetchone()
        if row is None:
            return default
        try:
            return json.loads(row["value"])
        except (TypeError, ValueError):
            return row["value"]

    def set_setting(self, key: str, value: Any) -> None:
        """写设置（JSON 序列化）。"""
        if not str(key or "").strip():
            raise ValueError("setting key 不能为空")
        with self._txn() as con:
            con.execute(
                "INSERT INTO setting(key, value) VALUES(?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (str(key), dumps(value)),
            )
            self.audit("setting.set", str(key))

    def stats(self) -> dict:
        """库内计数快照，供 /api/health 与仪表盘使用。"""
        con = self.con

        def count(sql: str) -> int:
            return int(con.execute(sql).fetchone()[0])

        by_status = {str(r["status"]): int(r["c"]) for r in con.execute(
            "SELECT status, count(*) AS c FROM memory GROUP BY status ORDER BY status"
        ).fetchall()}
        by_kind = {str(r["kind"]): int(r["c"]) for r in con.execute(
            "SELECT kind, count(*) AS c FROM memory GROUP BY kind ORDER BY kind"
        ).fetchall()}
        return {
            "memories": {
                "total": count("SELECT count(*) FROM memory"),
                "approved": by_status.get("approved", 0),
                "candidate": by_status.get("candidate", 0),
                "archived": by_status.get("archived", 0),
                "by_status": by_status,
                "by_kind": by_kind,
            },
            "evidence": count("SELECT count(*) FROM evidence"),
            "blocks": count("SELECT count(*) FROM block"),
            "entities": count("SELECT count(*) FROM entity"),
            "edges": count("SELECT count(*) FROM edge"),
            "documents": count("SELECT count(*) FROM document"),
            "chunks": count("SELECT count(*) FROM chunk"),
            "scopes": count("SELECT count(*) FROM scope"),
            "candidates": {
                "total": count("SELECT count(*) FROM candidate"),
                "pending": count("SELECT count(*) FROM candidate WHERE status = 'pending'"),
            },
            "conflicts": {
                "total": count("SELECT count(*) FROM conflict"),
                "open": count("SELECT count(*) FROM conflict WHERE status = 'open'"),
            },
            "audit": count("SELECT count(*) FROM audit"),
            "generated_at": now(),
        }

    def rebuild_fts(self) -> dict:
        """重建 memory_fts / chunk_fts（导入后或索引损坏时）。"""
        with self._txn() as con:
            result = dbmod.rebuild_fts(con)
            self.audit("fts.rebuild", None, detail=result)
        return result

    # ------------------------------------------------------------ 镜像

    def _mirror(self, mid: str) -> None:
        """把记忆镜像成 Markdown；失败只记审计，绝不影响真源事务。"""
        if not self.mirror or self.vault is None:
            return
        try:
            memory = self.get_memory(mid)
            if memory is None:
                return
            if str(memory.get("sensitivity") or "") == "secret":
                # Markdown 镜像是普通文件，常被同步盘/笔记软件带走：secret 只留在 memora.db。
                memory = dict(memory, body=SECRET_MIRROR_NOTE, summary="", didactic={},
                              evidence=[dict(e, quote="") for e in memory.get("evidence") or []],
                              blocks=[])
            self.vault.write_memory(
                memory, memory.get("evidence") or [], memory.get("blocks") or []
            )
        except Exception as exc:  # pragma: no cover - 依赖文件系统
            try:
                self.audit("vault.mirror.failed", mid, detail={"error": str(exc)[:300]})
            except sqlite3.Error:
                pass

    def _prune_mirror(self, mid: str) -> None:
        """硬删除时移除对应镜像文件（若 vault 支持）。"""
        if not self.mirror or self.vault is None:
            return
        handler = getattr(self.vault, "remove_memory", None)
        if callable(handler):
            try:
                handler(mid)
            except Exception:  # pragma: no cover - 依赖文件系统
                pass


def open_store(db_path: str | Path, vault: "Vault | None" = None) -> Store:
    """便捷入口：确保 schema 已建后返回 Store。"""
    dbmod.init_db(db_path)
    return Store(db_path, vault)
