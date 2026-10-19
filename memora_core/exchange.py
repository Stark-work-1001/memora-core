# -*- coding: utf-8 -*-
"""统一交换格式：JSONL 一行一条，跨工具搬运记忆。

格式标识 memora-exchange/1。每条最少字段：
  schema, id, title, body, kind, category, scope, agent, trust, importance,
  status, recorded_at, tags, evidence[], blocks[], entities[], edges[]

导入侧做三件事：
  1) 格式归一（memora / mem0 / mcp-memory-service / basic-memory / generic）
  2) 双通道去重（dedup.score_pair 可用则用，否则本地 simhash+集合相似）
  3) 落库并回报 {imported, skipped, deduped, errors}

只依赖 store 的公开写入方法；缺失的方法用 duck typing 跳过，不自己实现存储层。
"""
from __future__ import annotations

import hashlib
import json
import re
import sqlite3
from typing import Any, Iterable

from . import db as _db

EXCHANGE_SCHEMA = "memora-exchange/1"
FORMATS = ("memora", "mem0", "mcp-memory-service", "basic-memory", "generic")

REQUIRED_FIELDS = (
    "schema", "id", "title", "body", "kind", "category", "scope", "agent", "trust",
    "importance", "status", "recorded_at", "tags", "evidence", "blocks", "entities", "edges",
)

MEMORY_KINDS = frozenset({
    "fact", "knowledge", "decision", "preference", "procedure", "experience",
    "task", "turn", "tool", "artifact",
})
STATUSES = frozenset({
    "draft", "candidate", "approved", "rejected", "superseded", "merged", "archived",
})
EVIDENCE_KINDS = frozenset({
    "user_stated", "agent_asserted", "tool_output", "document", "web",
    "derived", "verification", "code_run",
})
BLOCK_TYPES = frozenset({
    "formula", "image", "code", "table", "database", "list", "quote", "derivation",
})
EDGE_RELS = frozenset({
    "semantic", "hypernym", "hyponym", "part_of", "instance_of", "causes", "contradicts",
    "supports", "supersedes", "derived_from", "mentions", "temporal_next", "alias", "prerequisite",
})

# 去重阈值（与 dedup.THRESHOLD_MERGE 对齐）
DUP_MERGE = 0.92
DUP_NEAR = 0.86

_CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]")
_TOKEN_RE = re.compile(r"[A-Za-z][A-Za-z0-9_'-]*|\d+(?:[.,]\d+)*|[\u3400-\u9fff]")


# ============================================================
# 小工具
# ============================================================

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


def _con(store):
    con = getattr(store, "con", None)
    if con is not None:
        return con
    import sqlite3 as _s
    path = getattr(store, "db_path", None) or getattr(store, "db", None)
    conn = _s.connect(str(path), timeout=15.0, isolation_level=None)
    conn.row_factory = _s.Row
    return conn


def _clamp01(value: Any, default: float = 0.5) -> float:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return default
    if out != out:
        return default
    return max(0.0, min(1.0, out))


def _astr(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, (dict, list)):
        return _dumps(value)
    return str(value)


def _alist(value: Any) -> list:
    if value is None:
        return []
    if isinstance(value, list):
        return value
    if isinstance(value, tuple):
        return list(value)
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return []
        if text.startswith("["):
            parsed = _loads(text, None)
            if isinstance(parsed, list):
                return parsed
        return [s.strip() for s in re.split(r"[,;]", text) if s.strip()]
    return [value]


def _hash_text(*parts: Any) -> str:
    raw = "|".join(_astr(p) for p in parts)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _norm_text(text: str) -> str:
    return " ".join(str(text or "").lower().split())


def _tokens(text: str) -> set[str]:
    """中英混排的实词集合；中文按单字，英文按词。"""
    out: set[str] = set()
    for match in _TOKEN_RE.finditer(str(text or "").lower()):
        tok = match.group(0)
        if len(tok) >= 2 or _CJK_RE.match(tok):
            out.add(tok)
    return out


def simhash64(text: str) -> int:
    """64 位 simhash（字符 3-gram，纯标准库）。"""
    weights = [0] * 64
    raw = _norm_text(text)
    if not raw:
        return 0
    grams = [raw[i:i + 3] for i in range(max(1, len(raw) - 2))]
    for gram in grams:
        digest = int.from_bytes(hashlib.blake2b(gram.encode("utf-8"), digest_size=8).digest(),
                                "big")
        for bit in range(64):
            weights[bit] += 1 if (digest >> bit) & 1 else -1
    out = 0
    for bit in range(64):
        if weights[bit] > 0:
            out |= (1 << bit)
    return out


def _hamming(a: int, b: int) -> int:
    return bin(a ^ b).count("1")


def fallback_score(new_text: str, old_text: str) -> dict:
    """dedup 模块不可用时的本地三通道相似度：jac / simhash / 余弦（字符集）。"""
    ta, tb = _tokens(new_text), _tokens(old_text)
    union = ta | tb
    jac = (len(ta & tb) / len(union)) if union else 0.0
    ham = _hamming(simhash64(new_text), simhash64(old_text))
    cosine = (len(ta & tb) / ((len(ta) ** 0.5) * (len(tb) ** 0.5))) if ta and tb else 0.0
    dup = 0.5 * cosine + 0.3 * jac + 0.2 * (1.0 - ham / 64.0)
    return {"cos": round(cosine, 6), "jac": round(jac, 6), "ham": ham,
            "dup": round(dup, 6), "band": "merge" if dup >= DUP_MERGE else "new"}


def score_pair(new_text: str, old_text: str) -> dict:
    """优先用 dedup.score_pair；任何异常都退化为本地实现。"""
    try:
        from . import dedup  # noqa: PLC0415
        fn = getattr(dedup, "score_pair", None)
        if callable(fn):
            return dict(fn(new_text, old_text))
    except Exception:  # noqa: BLE001 - 依赖未就绪时走本地实现
        pass
    return fallback_score(new_text, old_text)


# ============================================================
# B1. 导出
# ============================================================

def _row_to_exchange(store, row: dict, include_evidence: bool = True) -> dict:
    """把 memory 行展开成交换格式的一条记录。"""
    con = _con(store)
    mid = str(row["id"])
    meta = _loads(row.get("metadata"), {}) or {}
    item = {
        "schema": EXCHANGE_SCHEMA,
        "id": mid,
        "title": row.get("title") or "",
        "body": row.get("body") or "",
        "summary": row.get("summary") or "",
        "kind": row.get("kind") or "fact",
        "category": row.get("category") or "",
        "scope": row.get("scope_id") or "global",
        "agent": row.get("agent_id") or "",
        "session": row.get("session_id") or "",
        "trust": _clamp01(row.get("trust"), 0.5),
        "importance": _clamp01(row.get("importance"), 0.5),
        "confidence": _clamp01(row.get("confidence"), 0.5),
        "status": row.get("status") or "candidate",
        "recorded_at": row.get("recorded_at") or "",
        "updated_at": row.get("updated_at") or "",
        "tags": list(meta.get("tags") or []),
        "evidence": [],
        "blocks": [],
        "entities": [],
        "edges": [],
    }
    if row.get("didactic"):
        didactic = _loads(row.get("didactic"), {}) or {}
        if didactic:
            item["didactic"] = didactic
    if include_evidence:
        evidence = con.execute(
            "SELECT * FROM evidence WHERE memory_id = ? ORDER BY created_at, id", (mid,)
        ).fetchall()
        item["evidence"] = [{
            "kind": e["kind"], "quote": e["quote"] or "", "uri": e["uri"] or "",
            "trust": _clamp01(e["trust"], 0.5), "verified": bool(e["verified"]),
            "note": e["note"] or "", "created_at": e["created_at"],
        } for e in evidence]
    blocks = con.execute(
        "SELECT * FROM block WHERE memory_id = ? ORDER BY ordinal, id", (mid,)
    ).fetchall()
    item["blocks"] = [{
        "type": b["type"], "lang": b["lang"] or "", "caption": b["caption"] or "",
        "content": b["content"] or "", "ordinal": int(b["ordinal"]),
        "fields": _loads(b["fields"], {}) or {},
    } for b in blocks]
    entities = con.execute(
        "SELECT e.id, e.name, e.kind, e.definition, me.role FROM memory_entity me "
        "JOIN entity e ON e.id = me.entity_id WHERE me.memory_id = ? ORDER BY e.name", (mid,)
    ).fetchall()
    item["entities"] = [{"id": e["id"], "name": e["name"], "kind": e["kind"],
                         "definition": e["definition"] or "", "role": e["role"]}
                        for e in entities]
    edges = con.execute(
        "SELECT * FROM edge WHERE src = ? OR dst = ? ORDER BY rel, id", (mid, mid)
    ).fetchall()
    item["edges"] = [{
        "src": e["src"], "src_kind": e["src_kind"], "dst": e["dst"], "dst_kind": e["dst_kind"],
        "rel": e["rel"], "weight": float(e["weight"] or 1.0),
        "confidence": float(e["confidence"] or 0.5), "origin": e["origin"] or "explicit",
    } for e in edges]
    return item


def export_jsonl(store, *, scope=None, status="approved", include_evidence=True) -> str:
    """导出为 JSONL 文本；status=None 表示不限状态。"""
    con = _con(store)
    where: list[str] = []
    params: list[Any] = []
    if status:
        statuses = [str(s) for s in _alist(status) if str(s).strip()]
        if statuses:
            where.append("m.status IN (%s)" % ",".join("?" * len(statuses)))
            params.extend(statuses)
    if scope:
        ids = _scope_ids(con, str(scope))
        if ids:
            where.append("m.scope_id IN (%s)" % ",".join("?" * len(ids)))
            params.extend(ids)
        else:
            return ""
    sql = "SELECT m.* FROM memory m"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY m.recorded_at, m.id"
    rows = con.execute(sql, tuple(params)).fetchall()
    lines: list[str] = []
    for raw in rows:
        lines.append(_dumps(_row_to_exchange(store, dict(raw), include_evidence)))
    return "\n".join(lines) + ("\n" if lines else "")


def _scope_ids(con, scope: str) -> list[str]:
    try:
        row = con.execute("SELECT path FROM scope WHERE id = ?", (scope,)).fetchone()
        if row is not None and row["path"]:
            path = str(row["path"])
            rows = con.execute(
                "SELECT id FROM scope WHERE path = ? OR path LIKE ?", (path, path + "/%")
            ).fetchall()
            if rows:
                return [str(r["id"]) for r in rows]
        rows = con.execute(
            "SELECT id FROM scope WHERE id = ? OR id LIKE ?", (scope, scope + "%")
        ).fetchall()
        return [str(r["id"]) for r in rows]
    except sqlite3.Error:
        return [scope]


# ============================================================
# B2. 格式识别与归一
# ============================================================

def detect_format(payload: dict) -> str:
    """识别一条记录的来源格式。"""
    if not isinstance(payload, dict):
        return "generic"
    schema = _astr(payload.get("schema")).strip().lower()
    if schema.startswith("memora-exchange") or schema == "memora":
        return "memora"
    if schema.startswith("mem0"):
        return "mem0"
    if "mcp-memory-service" in schema or schema.startswith("mcp-memory"):
        return "mcp-memory-service"
    if schema.startswith("basic-memory") or schema.startswith("basic_memory"):
        return "basic-memory"

    keys = set(payload.keys())
    # mem0：memory + user_id/agent_id 双主键 + hash
    if {"memory", "user_id"} <= keys or ({"memory", "hash"} <= keys and "agent_id" in keys):
        return "mem0"
    # mcp-memory-service：content + tags + memory_type + 无 body
    if {"content", "memory_type"} <= keys and "body" not in keys:
        return "mcp-memory-service"
    # basic-memory：frontmatter / permalink / entity_type
    if {"permalink", "entity_type"} <= keys or ("frontmatter" in keys and "title" in keys):
        return "basic-memory"
    # memora：我们自己导出的键集合
    if {"title", "body", "kind", "scope"} <= keys:
        return "memora"
    if "title" in keys and "body" in keys and "scope" in keys:
        return "memora"
    return "generic"


def to_memora(obj: dict, fmt: str, scope: str) -> dict:
    """把任意来源记录归一成 memora 交换记录（不落库）。"""
    src = dict(obj or {})
    name = (fmt or "generic").strip().lower()
    if name == "mem0":
        body = _astr(src.get("memory") or src.get("data") or src.get("text") or "")
        title = _astr(src.get("title") or _first_line(body))
        tags = _alist(src.get("categories") or src.get("tags"))
        out = _base_record(src, title=title, body=body, scope=scope, tags=tags,
                           agent=_astr(src.get("agent_id") or ""),
                           kind="preference" if tags else "fact")
        meta = src.get("metadata") if isinstance(src.get("metadata"), dict) else {}
        if src.get("created_at"):
            out["recorded_at"] = _astr(src.get("created_at"))
        if meta:
            out["tags"] = list(dict.fromkeys(out["tags"] + _alist(meta.get("tags"))))
        return out
    if name == "mcp-memory-service":
        body = _astr(src.get("content") or src.get("text") or src.get("memory") or "")
        title = _astr(src.get("title") or _first_line(body))
        out = _base_record(src, title=title, body=body, scope=scope,
                           tags=_alist(src.get("tags")),
                           agent=_astr(src.get("agent_id") or src.get("owner") or ""),
                           kind=_kind_from(src.get("memory_type")))
        return out
    if name == "basic-memory":
        body = _astr(src.get("content") or src.get("body") or src.get("markdown") or "")
        title = _astr(src.get("title") or src.get("permalink") or _first_line(body))
        front = src.get("frontmatter") if isinstance(src.get("frontmatter"), dict) else {}
        tags = _alist(src.get("tags") or front.get("tags"))
        out = _base_record(src, title=title, body=body, scope=scope, tags=tags,
                           agent=_astr(src.get("agent_id") or ""),
                           kind=_kind_from(src.get("entity_type") or front.get("type")))
        if src.get("created_at") or front.get("created"):
            out["recorded_at"] = _astr(src.get("created_at") or front.get("created"))
        return out
    if name == "memora":
        out = _base_record(
            src,
            title=_astr(src.get("title")),
            body=_astr(src.get("body") or src.get("content")),
            scope=_astr(src.get("scope") or src.get("scope_id") or scope) or scope,
            tags=_alist(src.get("tags")),
            agent=_astr(src.get("agent") or src.get("agent_id") or ""),
            kind=_astr(src.get("kind")),
        )
        if src.get("summary"):
            out["summary"] = _astr(src.get("summary"))
        if src.get("category"):
            out["category"] = _astr(src.get("category"))
        if src.get("confidence") is not None:
            out["confidence"] = _clamp01(src.get("confidence"), 0.5)
        if src.get("updated_at"):
            out["updated_at"] = _astr(src.get("updated_at"))
        if isinstance(src.get("didactic"), dict):
            out["didactic"] = src["didactic"]
        # 富结构必须原样带回去，否则往返会丢证据/块/实体/边
        out["evidence"] = [e for e in _alist(src.get("evidence")) if isinstance(e, dict)]
        out["blocks"] = [b for b in _alist(src.get("blocks")) if isinstance(b, dict)]
        out["entities"] = [e for e in _alist(src.get("entities"))
                           if isinstance(e, (dict, str))]
        out["edges"] = [e for e in _alist(src.get("edges")) if isinstance(e, dict)]
        return out
    # generic：尽力而为
    body = _astr(src.get("body") or src.get("content") or src.get("text")
                 or src.get("memory") or src.get("value") or "")
    title = _astr(src.get("title") or src.get("name") or _first_line(body))
    return _base_record(src, title=title, body=body, scope=scope,
                        tags=_alist(src.get("tags")), agent=_astr(src.get("agent") or ""),
                        kind=_kind_from(src.get("kind") or src.get("type")))


def _first_line(text: str, size: int = 80) -> str:
    flat = " ".join(str(text or "").split())
    return flat[:size] if flat else ""


def _kind_from(value: Any) -> str:
    kind = _astr(value).strip().lower()
    if kind in MEMORY_KINDS:
        return kind
    mapping = {"preference": "preference", "fact": "fact", "note": "knowledge",
               "observation": "experience", "decision": "decision", "todo": "task",
               "procedure": "procedure", "concept": "knowledge", "insight": "knowledge"}
    return mapping.get(kind, "knowledge")


def _base_record(src: dict, *, title: str, body: str, scope: str, tags: list,
                 agent: str, kind: str) -> dict:
    """构造完整的 memora 记录骨架（保留全部必填字段）。"""
    status = _astr(src.get("status")).strip() or "candidate"
    if status not in STATUSES:
        status = "candidate"
    mem_kind = kind if kind in MEMORY_KINDS else "knowledge"
    return {
        "schema": EXCHANGE_SCHEMA,
        "id": _astr(src.get("id") or "") or "m-" + _hash_text(title, body)[:12],
        "title": title or "未命名记忆",
        "body": body,
        "summary": _astr(src.get("summary") or ""),
        "kind": mem_kind,
        "category": _astr(src.get("category") or ""),
        "scope": scope or "global",
        "agent": agent,
        "session": _astr(src.get("session") or ""),
        "trust": _clamp01(src.get("trust"), 0.5),
        "importance": _clamp01(src.get("importance"), 0.5),
        "confidence": _clamp01(src.get("confidence"), 0.5),
        "status": status,
        "recorded_at": _astr(src.get("recorded_at") or src.get("created_at") or _db.now()),
        "updated_at": _astr(src.get("updated_at") or ""),
        "tags": [str(t) for t in (tags or []) if str(t).strip()],
        "evidence": [],
        "blocks": [],
        "entities": [],
        "edges": [],
    }


# ============================================================
# B3. 导入
# ============================================================

def parse_jsonl(text: str) -> tuple[list[dict], list[dict]]:
    """按行解析；空行跳过，坏行记错误。也接受单个 JSON 数组/对象。"""
    items: list[dict] = []
    errors: list[dict] = []
    raw = (text or "").strip()
    if not raw:
        return items, errors
    if raw.startswith("["):
        parsed = _loads(raw, None)
        if isinstance(parsed, list):
            for index, obj in enumerate(parsed):
                if isinstance(obj, dict):
                    items.append(obj)
                else:
                    errors.append({"line": 0, "index": index, "error": "不是 JSON 对象"})
            return items, errors
    for lineno, line in enumerate(raw.splitlines(), start=1):
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except ValueError as exc:
            errors.append({"line": lineno, "error": "JSON 解析失败: %s" % exc})
            continue
        if isinstance(obj, list):
            items.extend([o for o in obj if isinstance(o, dict)])
        elif isinstance(obj, dict):
            items.append(obj)
        else:
            errors.append({"line": lineno, "error": "不是 JSON 对象"})
    return items, errors


def import_jsonl(store, text, *, agent_id=None, scope="global", dry_run=False) -> dict:
    """导入 JSONL；去重后落库，返回 {imported, skipped, deduped, errors}。"""
    con = _con(store)
    items, errors = parse_jsonl(text)
    report = {
        "imported": 0, "skipped": 0, "deduped": 0, "errors": errors,
        "total": len(items), "dry_run": bool(dry_run), "ids": [], "dedup": [],
        "formats": {},
    }
    known = _existing_index(con, scope)
    for index, obj in enumerate(items):
        fmt = detect_format(obj)
        report["formats"][fmt] = report["formats"].get(fmt, 0) + 1
        try:
            record = to_memora(obj, fmt, scope)
        except Exception as exc:  # noqa: BLE001
            report["errors"].append({"index": index, "error": "归一失败: %s" % exc})
            report["skipped"] += 1
            continue
        title, body = record["title"], record["body"]
        if not body.strip() and not title.strip():
            report["errors"].append({"index": index, "error": "标题与正文都为空"})
            report["skipped"] += 1
            continue
        dup = _match_known(title, body, known)
        if dup is not None:
            report["deduped"] += 1
            report["skipped"] += 1
            report["dedup"].append({"index": index, "target": dup["id"],
                                    "dup": dup["dup"], "title": title[:60]})
            continue
        if dry_run:
            report["imported"] += 1
            report["ids"].append(record["id"])
            known.append({"id": record["id"], "text": _norm_text(title + " " + body),
                          "sh": simhash64(title + " " + body), "tokens": _tokens(title + " " + body)})
            continue
        try:
            saved = _persist(store, record, agent_id=agent_id, scope=scope)
        except Exception as exc:  # noqa: BLE001
            report["errors"].append({"index": index, "id": record["id"],
                                     "error": "%s: %s" % (type(exc).__name__, exc)})
            report["skipped"] += 1
            continue
        report["imported"] += 1
        report["ids"].append(saved.get("id") or record["id"])
        known.append({"id": saved.get("id") or record["id"],
                      "text": _norm_text(title + " " + body),
                      "sh": simhash64(title + " " + body),
                      "tokens": _tokens(title + " " + body)})
    if not dry_run and report["imported"]:
        _rebuild_fts(store)
        _audit(store, "exchange.import", None,
               {"imported": report["imported"], "skipped": report["skipped"],
                "deduped": report["deduped"], "errors": len(report["errors"]),
                "scope": scope, "agent": agent_id})
    return report


def _existing_index(con, scope: str | None = None) -> list[dict]:
    """已存在记忆的去重索引（id/归一文本/simhash/token 集）。"""
    try:
        rows = con.execute("SELECT id, title, body FROM memory").fetchall()
    except sqlite3.Error:
        return []
    out: list[dict] = []
    for row in rows:
        text = _norm_text("%s %s" % (row["title"] or "", row["body"] or ""))
        out.append({"id": str(row["id"]), "text": text, "sh": simhash64(text),
                    "tokens": _tokens(text)})
    return out


def _match_known(title: str, body: str, known: Iterable[dict]) -> dict | None:
    """双通道去重：完全同文/高 simhash → 命中；再用 score_pair 复核近似。"""
    text = _norm_text("%s %s" % (title, body))
    sh = simhash64(text)
    toks = _tokens(text)
    best: dict | None = None
    for entry in known:
        if entry["text"] == text:
            return {"id": entry["id"], "dup": 1.0}
        ham = _hamming(sh, entry["sh"])
        if ham <= 3:
            return {"id": entry["id"], "dup": round(1.0 - ham / 64.0, 6), "channel": "simhash"}
        if not toks or not entry["tokens"]:
            continue
        union = toks | entry["tokens"]
        overlap = len(toks & entry["tokens"]) / len(union) if union else 0.0
        if overlap < 0.6:
            continue
        score = score_pair(text, entry["text"])
        dup = float(score.get("dup") or 0.0)
        if dup >= DUP_NEAR and (best is None or dup > best["dup"]):
            best = {"id": entry["id"], "dup": round(dup, 6), "channel": "score_pair",
                    "jac": score.get("jac"), "ham": score.get("ham")}
    return best


def _rebuild_fts(store) -> None:
    fn = getattr(store, "rebuild_fts", None)
    if not callable(fn):
        return
    try:
        fn()
    except Exception:  # noqa: BLE001 - FTS 重建失败不影响导入结果
        pass


def _audit(store, action: str, target: str | None, detail: Any = None) -> None:
    fn = getattr(store, "audit", None)
    if not callable(fn):
        return
    try:
        fn(action, target, detail=detail)
    except Exception:  # noqa: BLE001
        pass


def _persist(store, record: dict, *, agent_id: str | None, scope: str) -> dict:
    """把一条归一记录写成记忆（含证据/块/实体/边），返回 store 的记忆对象。"""
    scope_id = record.get("scope") or scope or "global"
    payload = {
        "id": record["id"],
        "scope_id": scope_id,
        "agent_id": agent_id or record.get("agent") or None,
        "session_id": record.get("session") or None,
        "kind": record["kind"],
        "category": record.get("category") or None,
        "title": record["title"],
        "body": record["body"],
        "summary": record.get("summary") or None,
        "status": record["status"],
        "trust": record["trust"],
        "importance": record["importance"],
        "confidence": record.get("confidence", 0.5),
        "recorded_at": record.get("recorded_at"),
        "metadata": {"tags": list(record.get("tags") or []), "imported": EXCHANGE_SCHEMA},
    }
    if record.get("didactic"):
        payload["didactic"] = record["didactic"]
    adder = getattr(store, "add_memory", None)
    if not callable(adder):
        raise TypeError("store 缺少 add_memory")
    memory = adder(payload)
    mid = str(memory.get("id") or record["id"])
    _attach_evidence(store, mid, record.get("evidence") or [])
    _attach_blocks(store, mid, record.get("blocks") or [])
    _attach_entities(store, mid, record.get("entities") or [], scope_id)
    _attach_edges(store, mid, record.get("edges") or [])
    return memory


def _attach_evidence(store, mid: str, evidence: list) -> int:
    fn = getattr(store, "add_evidence", None)
    if not callable(fn):
        return 0
    count = 0
    for item in evidence:
        if not isinstance(item, dict):
            continue
        kind = str(item.get("kind") or "agent_asserted")
        if kind not in EVIDENCE_KINDS:
            kind = "agent_asserted"
        try:
            fn(mid, {"kind": kind, "quote": item.get("quote") or "",
                     "uri": item.get("uri") or None, "trust": _clamp01(item.get("trust"), 0.5),
                     "verified": bool(item.get("verified")), "note": item.get("note") or None})
            count += 1
        except Exception:  # noqa: BLE001 - 单条证据失败不放弃整条记忆
            continue
    return count


def _attach_blocks(store, mid: str, blocks: list) -> int:
    fn = getattr(store, "add_block", None)
    if not callable(fn):
        return 0
    count = 0
    for index, item in enumerate(blocks, start=1):
        if not isinstance(item, dict):
            continue
        btype = str(item.get("type") or "quote")
        if btype not in BLOCK_TYPES:
            btype = "quote"
        try:
            fn(mid, {"type": btype, "lang": item.get("lang") or None,
                     "caption": item.get("caption") or None,
                     "content": item.get("content") or "",
                     "ordinal": int(item.get("ordinal") or index),
                     "fields": item.get("fields") or {}})
            count += 1
        except Exception:  # noqa: BLE001
            continue
    return count


def _attach_entities(store, mid: str, entities: list, scope_id: str) -> int:
    upsert = getattr(store, "upsert_entity", None)
    link = getattr(store, "link_memory_entity", None)
    if not callable(upsert) or not callable(link):
        return 0
    count = 0
    for item in entities:
        if isinstance(item, str):
            name, kind, role = item, "concept", "mention"
        elif isinstance(item, dict):
            name = str(item.get("name") or "").strip()
            kind = str(item.get("kind") or "concept")
            role = str(item.get("role") or "mention")
        else:
            continue
        if not name:
            continue
        try:
            entity = upsert(name, kind, str(item.get("definition") or "") if isinstance(item, dict)
                            else "", scope_id)
            link(mid, entity["id"], role)
            count += 1
        except Exception:  # noqa: BLE001
            continue
    return count


def _attach_edges(store, mid: str, edges: list) -> int:
    fn = getattr(store, "add_edge", None)
    if not callable(fn):
        return 0
    count = 0
    for item in edges:
        if not isinstance(item, dict):
            continue
        src = str(item.get("src") or mid)
        dst = str(item.get("dst") or "")
        rel = str(item.get("rel") or "semantic")
        if not dst or rel not in EDGE_RELS:
            continue
        src_kind = str(item.get("src_kind") or "memory")
        dst_kind = str(item.get("dst_kind") or "memory")
        if src_kind not in ("memory", "entity", "chunk", "document"):
            src_kind = "memory"
        if dst_kind not in ("memory", "entity", "chunk", "document"):
            dst_kind = "memory"
        try:
            fn(src, src_kind, dst, dst_kind, rel, float(item.get("weight") or 1.0),
               _clamp01(item.get("confidence"), 0.5), str(item.get("origin") or "explicit"))
            count += 1
        except Exception:  # noqa: BLE001
            continue
    return count


# ============================================================
# B4. 便捷入口
# ============================================================

def export_to_file(store, path, **kwargs) -> dict:
    """导出到文件（CLI/接口复用）。"""
    text = export_jsonl(store, **kwargs)
    with open(path, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(text)
    lines = [ln for ln in text.splitlines() if ln.strip()]
    return {"path": str(path), "records": len(lines), "bytes": len(text.encode("utf-8"))}


def import_from_file(store, path, **kwargs) -> dict:
    """从文件导入（CLI/接口复用）。"""
    text = open(path, "r", encoding="utf-8").read()
    return import_jsonl(store, text, **kwargs)