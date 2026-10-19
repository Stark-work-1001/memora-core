# -*- coding: utf-8 -*-
"""混合召回：BM25 + 向量 + 图 + 子串 → RRF → 重排 → MMR → 预算打包。

流水线（每一步都可单独降级，绝不抛异常给上层）：

    query
      ├─ bm25      FTS5 bm25(title 3.0 / summary 1.5 / body 1.0)
      ├─ substring LIKE '%gram%' 中文二元兜底
      ├─ vector    云端 embedding → 失败退本地 hash_embed
      └─ graph     个性化 PageRank（α=0.85，2 跳）
           ↓  RRF：score(d)=Σ_c w_c/(k+rank_c(d)), k=60
           ↓  rerank（可选，失败则分数透传）
           ↓  MMR（λ=0.7，本地向量算冗余）
           ↓  预算贪心打包（score/len）
        {hits, degraded, took_ms, strategy, total}

降级契约：gw 是 duck-typed 的 ModelGateway，只调用 gw.embed / gw.rerank；
任何异常（尤其是 models.ModelUnavailable）都被吞掉，原因写进返回值的 degraded 字符串数组。

依赖 store 的部分：优先走 store.list_memories，失败回退 sqlite3 直连
（T1 的 store.py 落地后只需确认字段名一致，接缝在 _store_search / _fetch_pool）。
"""
from __future__ import annotations

import hashlib
import json
import math
import re
import sqlite3
import time
from typing import Any

from . import db as _db
from .vectors import (
    MODEL_LOCAL,
    cosine,
    estimate_tokens,
    hash_embed,
    unpack_vec,
    _open_store,
)

__all__ = [
    "estimate_tokens", "search", "digest", "recall_for_agent",
    "K_RRF", "DEFAULT_WEIGHTS", "MMR_LAMBDA", "pack_budget", "rrf_fuse",
]

# ---------------------------------------------------------------------------
# 参数（全部可在 docs/retrieval.md 查到出处）
# ---------------------------------------------------------------------------
K_RRF = 60
DEFAULT_WEIGHTS = {"bm25": 1.0, "vector": 1.0, "graph": 0.6, "substring": 0.5}
MMR_LAMBDA = 0.7
PPR_ALPHA = 0.85
PPR_HOPS = 2
PPR_ITERS = 24
RERANK_MIX = 0.35          # 重排分数在最终分里的占比；0.65 留给 RRF
BM25_WEIGHTS = (3.0, 1.5, 1.0)   # title / summary / body —— 与 memory_fts 建表顺序一致
SNIPPET_CHARS = 180
MAX_FTS_TERMS = 24
MAX_LIKE_GRAMS = 12
CACHE_VECTORS = True
MAX_CLOUD_EMBED = 400      # 单次 search 最多为多少条记忆补云端向量（超出走缓存/本地）

MODEL_CLOUD = "cloud-embed"
DEFAULT_STATUS = ("approved",)

_CJK_CLASS = "\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af"
_CJK_RUN_RE = re.compile("[%s]+" % _CJK_CLASS)
_ASCII_TOKEN_RE = re.compile(r"[A-Za-z][A-Za-z0-9_'\u2019-]*|\d+(?:[.,]\d+)*")


# ===========================================================================
# 0. 存储适配
# ===========================================================================

def _connect(store) -> sqlite3.Connection:
    """从 Store / 连接 / 路径拿到 sqlite3 连接。"""
    return _open_store(store)[0]


def _row_to_memory(row: Any) -> dict:
    if isinstance(row, dict):
        data = dict(row)
    else:
        data = {k: row[k] for k in row.keys()}
    data.setdefault("summary", "")
    data.setdefault("trust", 0.5)
    data.setdefault("importance", 0.5)
    data.setdefault("status", "approved")
    data.setdefault("scope_id", "global")
    for key in ("title", "body"):
        if data.get(key) is None:
            data[key] = ""
    return data


_SQL_COLUMNS = ("id, scope_id, agent_id, kind, title, body, summary, status, trust, importance,"
                " recorded_at, updated_at, tokens, lang, source_count, pinned")


def _sql_list_memories(con: sqlite3.Connection, filters: dict) -> list[dict]:
    where = ["1=1"]
    args: list[Any] = []
    statuses = filters.get("status")
    if statuses:
        if isinstance(statuses, str):
            statuses = [statuses]
        where.append("status IN (%s)" % ",".join("?" * len(statuses)))
        args.extend(statuses)
    scopes = filters.get("scope_ids")
    if scopes:
        where.append("scope_id IN (%s)" % ",".join("?" * len(scopes)))
        args.extend(scopes)
    sql = "SELECT %s FROM memory WHERE %s" % (_SQL_COLUMNS, " AND ".join(where))
    order = "pinned DESC, importance DESC, recorded_at DESC"
    if filters.get("order"):
        order = str(filters["order"])
    sql += " ORDER BY " + order + " LIMIT ?"
    args.append(int(filters.get("limit") or 20000))
    return [_row_to_memory(r) for r in con.execute(sql, args).fetchall()]


def _store_search(store, filters: dict | None = None) -> list[dict]:
    """优先 store.list_memories，失败回退直连 SQL。

    内部 filters 约定：{status:[...], scope_ids:[...], limit:int}
    Store.list_memories 的契约是 status/scope 各取**单个值**（Store 见 store.py:525），
    因此这里按 status 逐个调用再合并 —— 直接把列表塞进去会被 sqlite 参数绑定拒绝。
    """
    filters = dict(filters or {})
    statuses = filters.get("status")
    if isinstance(statuses, str):
        statuses = [statuses]
    scope_ids = filters.get("scope_ids")
    if isinstance(scope_ids, str):
        scope_ids = [scope_ids]
    limit = int(filters.get("limit") or 20000)

    fn = getattr(store, "list_memories", None)
    if callable(fn):
        try:
            rows: list[dict] = []
            seen: set[str] = set()
            for scope_id in (scope_ids or [None]):
                for status in (statuses or [None]):
                    call = {"limit": limit}
                    if status:
                        call["status"] = status
                    if scope_id:
                        call["scope"] = scope_id
                    result = fn(call)
                    items = (result.get("items") if isinstance(result, dict) else result) or []
                    for item in items:
                        data = _row_to_memory(item)
                        if data.get("id") in seen:
                            continue
                        seen.add(data.get("id"))
                        rows.append(data)
            if rows or not statuses and not scope_ids:
                return rows
            if statuses and not rows:
                return []   # 库里确实没有这些状态的行，不要白白回退
            return rows
        except Exception:
            pass  # Store 未就绪或签名不符 → 直连
    return _sql_list_memories(_connect(store), filters)


# ===========================================================================
# 1. 作用域展开
# ===========================================================================

def _expand_scope(con: sqlite3.Connection, scope) -> list[str] | None:
    """把 scope 展开成"自身 + 祖先 + global"。None 表示不限制。"""
    if not scope:
        return None
    seeds = [scope] if isinstance(scope, str) else [str(s) for s in scope if s]
    if not seeds:
        return None
    out: list[str] = []
    for seed in seeds:
        out.append(seed)
        cur = seed
        for _ in range(8):  # 防环
            try:
                row = con.execute("SELECT parent_id FROM scope WHERE id=?", (cur,)).fetchone()
            except sqlite3.Error:
                row = None
            if not row or not row[0]:
                break
            cur = row[0]
            if cur not in out:
                out.append(cur)
    if "*" not in out:
        out.append("global")
    return list(dict.fromkeys(out))


# ===========================================================================
# 2. 候选池
# ===========================================================================

def _fetch_pool(store, con, scope_ids, include_candidates: bool, limit: int) -> list[dict]:
    statuses = list(DEFAULT_STATUS)
    if include_candidates:
        statuses.append("candidate")
    filters = {"status": statuses, "limit": max(limit, 20000)}
    if scope_ids:
        filters["scope_ids"] = scope_ids
    try:
        rows = _store_search(store, filters)
    except Exception:
        rows = _sql_list_memories(con, filters)
    if scope_ids:
        allowed = set(scope_ids)
        rows = [r for r in rows if r.get("scope_id") in allowed]
    if include_candidates:
        keep = set(statuses) | {"draft"}
        rows = [r for r in rows if r.get("status") in keep]
    else:
        rows = [r for r in rows if r.get("status") in DEFAULT_STATUS]
    return rows


def _text_of(memory: dict) -> str:
    return "\n".join(p for p in (memory.get("title") or "", memory.get("summary") or "",
                                 memory.get("body") or "") if p)


# ===========================================================================
# 3. 四条召回通道
# ===========================================================================

def _cjk_terms(text: str) -> list[str]:
    """中文二元组：unicode61 会把整段中文切成一个大 token，BM25 靠二元前缀兜底。"""
    out: list[str] = []
    for run in _CJK_RUN_RE.findall(text or ""):
        if len(run) == 1:
            out.append(run)
        else:
            out.extend(run[i:i + 2] for i in range(len(run) - 1))
    return out


def _fts_expression(query: str) -> str | None:
    """把查询翻译成 FTS5 表达式：ASCII 词 + 中文二元前缀，OR 连接。"""
    terms: list[str] = []
    for tok in _ASCII_TOKEN_RE.findall(query or ""):
        terms.append(tok.lower())
    terms.extend(_cjk_terms(query))
    uniq: list[str] = []
    for term in terms:
        cleaned = term.replace('"', "")
        if len(cleaned) < 1 or cleaned in uniq:
            continue
        uniq.append(cleaned)
    uniq = uniq[:MAX_FTS_TERMS]
    if not uniq:
        return None
    return " OR ".join('"%s"*' % t for t in uniq)


def _channel_bm25(con: sqlite3.Connection, query: str, allowed: set[str], limit: int,
                  degraded: list[str], coverage_out: dict | None = None
                  ) -> list[tuple[str, float]]:
    expr = _fts_expression(query)
    if not expr:
        return []
    sql = ("SELECT m.id AS id, bm25(memory_fts, ?, ?, ?) AS s FROM memory_fts"
           " JOIN memory m ON m.rowid = memory_fts.rowid"
           " WHERE memory_fts MATCH ? ORDER BY s LIMIT ?")
    try:
        rows = con.execute(sql, (*BM25_WEIGHTS, expr, limit)).fetchall()
    except sqlite3.Error as exc:
        degraded.append("bm25: FTS5 查询失败（%s），改用内存 BM25" % str(exc)[:80])
        return []
    out = []
    for row in rows:
        mid = row[0]
        if mid not in allowed:
            continue
        # FTS5 的 bm25() 越小越相关（负值），翻成正分
        out.append((mid, -float(row[1])))
    out.sort(key=lambda kv: (-kv[1], kv[0]))
    # 前缀匹配会把「数据」这种高频二元组也当成命中，导致"数据导出"和"数据库并发"
    # 拿到同样的 bm25 分。用查询覆盖率做最后一次重排，把真正命中主题的排前面。
    terms = _coverage_terms(query)
    if terms:
        rescored = []
        for mid, score in out:
            row = con.execute("SELECT title, body, coalesce(summary,'') FROM memory WHERE id=?",
                              (mid,)).fetchone()
            coverage = _query_coverage(" ".join(r or "" for r in row), terms) if row else 0.0
            rescored.append((mid, score * (0.2 + 0.8 * coverage)))
            if coverage_out is not None:
                coverage_out[mid] = coverage
        rescored.sort(key=lambda kv: (-kv[1], kv[0]))
        return rescored[:limit]
    return out[:limit]


def _channel_bm25_memory(pool: list[dict], query: str, limit: int) -> list[tuple[str, float]]:
    """FTS5 不可用时的纯 Python BM25（k1=1.2, b=0.75），列权重与 FTS 一致。"""
    def terms(text: str) -> list[str]:
        out = [t.lower() for t in _ASCII_TOKEN_RE.findall(text or "")]
        out.extend(_cjk_terms(text))
        return out

    q_terms = list(dict.fromkeys(terms(query)))
    if not q_terms:
        return []
    docs = []
    for mem in pool:
        title = terms(mem.get("title"))
        summary = terms(mem.get("summary"))
        body = terms(mem.get("body"))
        length = len(title) + len(summary) + len(body)
        weighted = {}
        for col, weight in zip((title, summary, body), BM25_WEIGHTS):
            for term in col:
                weighted[term] = weighted.get(term, 0.0) + weight
        docs.append((mem["id"], weighted, length))
    if not docs:
        return []
    avgdl = sum(d[2] for d in docs) / len(docs) or 1.0
    df = {t: sum(1 for d in docs if t in d[1]) for t in q_terms}
    n_docs = len(docs)
    k1, b = 1.2, 0.75
    out: list[tuple[str, float]] = []
    for mid, tf, length in docs:
        score = 0.0
        for term in q_terms:
            f = tf.get(term, 0.0)
            if f <= 0:
                continue
            idf = math.log(1.0 + (n_docs - df[term] + 0.5) / (df[term] + 0.5))
            score += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * length / avgdl))
        if score > 0:
            out.append((mid, score))
    out.sort(key=lambda kv: (-kv[1], kv[0]))
    return out[:limit]


def _coverage_terms(query: str) -> list[str]:
    """查询的"检索词"：整词 + 中文二元组。整词权重最高（放在最前面）。"""
    terms: list[str] = []
    for tok in _ASCII_TOKEN_RE.findall(query or ""):
        terms.append(tok.lower())
    for run in _CJK_RUN_RE.findall(query or ""):
        terms.append(run)                       # 整段中文（往往就是主题名）
    terms.extend(_cjk_terms(query))             # 再补二元组
    return [t for t in dict.fromkeys(terms) if t]


def _query_coverage(text: str, query_terms: list[str]) -> float:
    """召回文本覆盖了查询里多少个检索词（0~1）。用于给子串通道排序。"""
    if not query_terms:
        return 0.0
    lowered = (text or "").lower()
    hit = sum(1 for term in query_terms if term and term in lowered)
    return hit / float(len(query_terms))


def _channel_substring(con: sqlite3.Connection, query: str, allowed: set[str],
                       limit: int, scope_ids, coverage_out: dict | None = None
                       ) -> list[tuple[str, float]]:
    """中文子串召回：LIKE '%gram%'。unicode61 把中文切成整段 token，这一步补召回。"""
    grams: list[str] = []
    for run in _CJK_RUN_RE.findall(query or ""):
        if len(run) == 1:
            grams.append(run)
        else:
            grams.extend(run[i:i + 2] for i in range(len(run) - 1))
    for tok in _ASCII_TOKEN_RE.findall(query or ""):
        if len(tok) >= 3:
            grams.append(tok.lower())
    grams = [g for g in dict.fromkeys(grams) if g][:MAX_LIKE_GRAMS]
    if not grams:
        return []
    hits: dict[str, float] = {}
    cov_terms = _coverage_terms(query)
    weight_total = sum(len(g) for g in grams)
    for gram in grams:
        like = "%" + gram.replace("%", "").replace("_", "") + "%"
        sql = ("SELECT id, title, body, coalesce(summary,'') AS summary FROM memory"
               " WHERE (title LIKE ? OR body LIKE ? OR coalesce(summary,'') LIKE ?)"
               " AND status IN ('approved','candidate')")
        args: list[Any] = [like, like, like]
        if scope_ids:
            sql += " AND scope_id IN (%s)" % ",".join("?" * len(scope_ids))
            args.extend(scope_ids)
        sql += " LIMIT ?"
        args.append(limit * 20)
        try:
            rows = con.execute(sql, args).fetchall()
        except sqlite3.Error:
            return []
        for mid, title, body, summary in rows:
            if mid not in allowed:
                continue
            # 命中权重 × 该文档对查询词的整体覆盖率：覆盖越全排得越前，
            # 避免"数据导出"只因共享「数据」二字就压过真正的目标记忆。
            coverage = _query_coverage("%s %s %s" % (title or "", body or "", summary or ""),
                                       cov_terms)
            hits[mid] = hits.get(mid, 0.0) + (len(gram) / weight_total) * (0.2 + 0.8 * coverage)
            if coverage_out is not None:
                coverage_out[mid] = max(float(coverage_out.get(mid, 0.0)), coverage)
    ranked = sorted(hits.items(), key=lambda kv: (-kv[1], kv[0]))
    return ranked[:limit]


def _call_gateway(gw, method: str, *args, **kwargs):
    """duck-typed 调用模型网关，任何异常都收敛成 (None, reason)。"""
    if gw is None:
        return None, "%s: 未配置模型网关" % method
    fn = getattr(gw, method, None)
    if not callable(fn):
        return None, "%s: 网关没有该方法" % method
    try:
        return fn(*args, **kwargs), None
    except Exception as exc:  # ModelUnavailable 或任何其它异常
        name = type(exc).__name__
        return None, "%s: %s(%s)" % (method, name, str(exc)[:80])


def _ensure_vectors(store, pool: list[dict], model: str = MODEL_LOCAL) -> dict[str, list[float]]:
    """确保池内每条记忆都有本地向量（缺失的算出来并写进 vector 表缓存）。"""
    from .vectors import VectorIndex

    index = VectorIndex(store, model=model)
    out: dict[str, list[float]] = {}
    missing: list[tuple[str, str]] = []
    try:
        for mem in pool:
            vec = index.get("memory", mem["id"], model=model)
            if vec:
                out[mem["id"]] = vec
            else:
                missing.append((mem["id"], _text_of(mem)))
        for mid, text in missing:
            vec = hash_embed(text)
            out[mid] = vec
            if CACHE_VECTORS:
                try:
                    index.put("memory", mid, vec, model=model)
                except sqlite3.Error:
                    pass
    finally:
        index.close()
    return out


def _cloud_vectors(gw, pool: list[dict], store) -> tuple[dict[str, list[float]], str | None] | None:
    """批量取云端 embedding 并缓存到 vector 表；任何失败返回 None 让上层退本地。"""
    from .vectors import VectorIndex

    if gw is None or not pool:
        return None
    index = VectorIndex(store, model=MODEL_CLOUD)
    out: dict[str, list[float]] = {}
    missing: list[dict] = []
    try:
        for mem in pool[:MAX_CLOUD_EMBED]:
            vec = index.get("memory", mem["id"], model=MODEL_CLOUD)
            if vec:
                out[mem["id"]] = vec
            else:
                missing.append(mem)
        if missing:
            texts = [_text_of(m)[:4000] for m in missing]
            embedded, reason = _call_gateway(gw, "embed", texts)
            if not embedded:
                return None
            if len(embedded) != len(texts):
                return None
            for mem, vec in zip(missing, embedded):
                vec = [float(v) for v in vec]
                out[mem["id"]] = vec
                if CACHE_VECTORS:
                    try:
                        index.put("memory", mem["id"], vec, model=MODEL_CLOUD)
                    except sqlite3.Error:
                        pass
    finally:
        index.close()
    return out, None


def _channel_vector(store, gw, query: str, pool: list[dict], limit: int,
                    degraded: list[str]) -> tuple[list[tuple[str, float]], dict[str, list[float]]]:
    """向量通道：云端 embedding 优先，任何失败退回本地 hash 向量。

    返回 (ranked, vecs)。vecs 同时供 MMR 复用 —— 若最终用了本地向量，就一定是
    本地空间里的余弦，MMR 可以直接用。
    """
    cloud = _cloud_vectors(gw, pool, store) if gw is not None else None
    if cloud is not None:
        mem_vecs = cloud[0]
        embedded, reason = _call_gateway(gw, "embed", [query])
        if embedded:
            try:
                query_vec = [float(v) for v in embedded[0]]
            except (TypeError, IndexError, ValueError):
                query_vec = []
            if query_vec and mem_vecs:
                ranked = []
                for mid, vec in mem_vecs.items():
                    score = cosine(query_vec, vec)
                    if score > 0:
                        ranked.append((mid, score))
                ranked.sort(key=lambda kv: (-kv[1], kv[0]))
                return ranked[:limit], mem_vecs
        degraded.append("vector: %s" % (reason or "云端 query embedding 为空"))
    elif gw is not None:
        _, reason = _call_gateway(gw, "embed", [query])
        degraded.append("vector: %s" % (reason or "云端 embedding 不可用"))
    else:
        degraded.append("vector: 未配置模型网关，使用本地 hash 向量")

    try:
        local_vecs = _ensure_vectors(store, pool)
    except Exception as exc:
        degraded.append("vector: 向量缓存不可用（%s）" % type(exc).__name__)
        return [], {}
    query_vec = hash_embed(query)
    ranked = []
    for mid, vec in local_vecs.items():
        score = cosine(query_vec, vec)
        if score > 0:
            ranked.append((mid, score))
    ranked.sort(key=lambda kv: (-kv[1], kv[0]))
    return ranked[:limit], local_vecs


# --- 图通道：个性化 PageRank ------------------------------------------------

def _build_graph(con: sqlite3.Connection, scope_ids) -> tuple[dict, dict]:
    """(邻接表, 记忆→实体)。边来自 edge 表 + memory_entity。"""
    adj: dict[str, dict[str, float]] = {}
    mem_entities: dict[str, list[str]] = {}

    def link(src: str, dst: str, weight: float) -> None:
        adj.setdefault(src, {})
        adj.setdefault(dst, {})
        adj[src][dst] = max(adj[src].get(dst, 0.0), weight)
        adj[dst][src] = max(adj[dst].get(src, 0.0), weight)

    try:
        rows = con.execute("SELECT src, src_kind, dst, dst_kind, rel, weight, confidence FROM edge"
                           " WHERE valid_to IS NULL OR valid_to = ''").fetchall()
    except sqlite3.Error:
        rows = []
    for src, src_kind, dst, dst_kind, rel, weight, confidence in rows:
        w = max(0.05, float(weight or 1.0) * float(confidence or 0.5))
        if rel == "contradicts":
            w *= 0.3
        link("%s:%s" % (src_kind, src), "%s:%s" % (dst_kind, dst), w)
    try:
        me = con.execute("SELECT memory_id, entity_id, role FROM memory_entity").fetchall()
    except sqlite3.Error:
        me = []
    for memory_id, entity_id, role in me:
        link("memory:%s" % memory_id, "entity:%s" % entity_id, 1.0 if role != "mention" else 0.8)
        mem_entities.setdefault(memory_id, []).append(entity_id)
    return adj, mem_entities


def _ppr(adj: dict, seeds: dict[str, float], alpha: float = PPR_ALPHA,
         iters: int = PPR_ITERS) -> dict[str, float]:
    """π = (1−α)·r + α·Pᵀπ。邻接按出度归一，孤立点自环。"""
    nodes = list(adj.keys())
    if not nodes or not seeds:
        return {}
    total = sum(seeds.values()) or 1.0
    restart = {n: seeds.get(n, 0.0) / total for n in nodes}
    out_deg = {n: sum(adj[n].values()) or 1.0 for n in nodes}
    pi = dict(restart)
    for _ in range(iters):
        nxt = {n: (1 - alpha) * restart[n] for n in nodes}
        for node in nodes:
            share = alpha * pi[node] / out_deg[node]
            if share <= 0:
                continue
            for nb, weight in adj[node].items():
                nxt[nb] = nxt.get(nb, 0.0) + share * weight
        pi = nxt
        norm = sum(pi.values())
        if norm > 0:
            pi = {k: v / norm for k, v in pi.items()}
    return pi


def _channel_graph(con: sqlite3.Connection, query: str, scope_ids, limit: int,
                   allowed: set[str] | None = None) -> list[tuple[str, float]]:
    """图通道。**必须**像 bm25/substring/vector 一样只返回 allowed 里的记忆 id。

    注意 _build_graph 目前不按作用域裁剪节点（edge / memory_entity 表没有 scope 维度），
    所以这里必须自己过滤：否则跨作用域数据下会把池外的记忆塞进融合层，
    下游 by_id[...] 直接 KeyError。
    """
    adj, mem_entities = _build_graph(con, scope_ids)
    if not adj:
        return []
    lowered = (query or "").lower()
    seeds: dict[str, float] = {}
    try:
        entities = con.execute("SELECT id, name FROM entity").fetchall()
    except sqlite3.Error:
        entities = []
    for entity_id, name in entities:
        name = (name or "").strip()
        if len(name) < 2:
            continue
        if name.lower() in lowered:
            seeds["entity:%s" % entity_id] = float(len(name))
    # 查询里没直接出现的实体，用中文二元组反查一次（弱种子）
    grams = set(_cjk_terms(query))
    if grams and len(seeds) < 3:
        for entity_id, name in entities:
            if len(name or "") < 2 or "entity:%s" % entity_id in seeds:
                continue
            overlap = sum(1 for g in grams if g in name)
            if overlap >= 2:
                seeds["entity:%s" % entity_id] = float(overlap) * 0.5
    if not seeds:
        return []
    pi = _ppr(adj, seeds)
    # 2 跳内：BFS 收集可达节点
    reachable = set(seeds)
    frontier = set(seeds)
    for _ in range(PPR_HOPS):
        nxt: set[str] = set()
        for node in frontier:
            nxt.update(adj.get(node, {}).keys())
        nxt -= reachable
        reachable |= nxt
        frontier = nxt
    scores: dict[str, float] = {}
    for node, value in pi.items():
        if node in reachable and node.startswith("memory:"):
            mid = node.split(":", 1)[1]
            if allowed is not None and mid not in allowed:
                continue
            scores[mid] = max(scores.get(mid, 0.0), value)
    for memory_id, entity_ids in mem_entities.items():
        if memory_id in scores:
            continue
        if allowed is not None and memory_id not in allowed:
            continue
        bonus = sum(pi.get("entity:%s" % e, 0.0) for e in entity_ids)
        if bonus > 0:
            scores[memory_id] = bonus
    ranked = sorted(scores.items(), key=lambda kv: (-kv[1], kv[0]))
    return ranked[:limit]


# ===========================================================================
# 4. 融合 / 重排 / 去冗余 / 打包
# ===========================================================================

def rrf_fuse(channels: dict[str, list[tuple[str, float]]], weights: dict[str, float] | None = None,
             k: int = K_RRF, coverage: dict[str, dict[str, float]] | None = None) -> dict[str, dict]:
    """score(d)=Σ_i w_i/(k+rank_i(d))。rank 从 1 开始。

    coverage（可选）：{channel: {doc_id: 0~1}}，表示该文档在这个通道里"覆盖了多少查询词"。
    给定时权重变为 w_i·cov_i(d)。为什么需要：BM25 用中文二元前缀做兜底时，
    "数据导出"只因共享「数据」二字就能拿到和「数据库并发」同样的名次，
    纯按名次融合会让部分匹配压过完整匹配（实测 Recall@10 从 0.97 掉到 0.70）。
    未给定时行为与标准 RRF 完全一致。
    """
    weights = weights or DEFAULT_WEIGHTS
    fused: dict[str, dict] = {}
    for name, ranked in channels.items():
        weight = float(weights.get(name, 0.0))
        if weight <= 0 or not ranked:
            continue
        cov = (coverage or {}).get(name) or {}
        for rank, (doc_id, raw) in enumerate(ranked, start=1):
            factor = weight * float(cov.get(doc_id, 1.0)) if cov else weight
            item = fused.setdefault(doc_id, {"id": doc_id, "rrf": 0.0, "channels": {}})
            item["rrf"] += factor / (k + rank)
            item["channels"][name] = round(float(raw), 6)
    return fused


def _mmr_select(candidates: list[dict], vectors: dict[str, list[float]], limit: int,
                lam: float = MMR_LAMBDA) -> list[dict]:
    """MMR：argmax[λ·rel(d) − (1−λ)·max_{s∈S} sim(d,s)]。"""
    if not candidates or limit <= 0:
        return []
    pool = list(candidates)
    top = max(c.get("score", 0.0) for c in pool) or 1.0
    selected: list[dict] = []
    while pool and len(selected) < limit:
        best = None
        best_value = -1e18
        for cand in pool:
            rel = cand.get("score", 0.0) / top
            vec = vectors.get(cand["id"])
            redundancy = 0.0
            if vec is not None and selected:
                redundancy = max(cosine(vec, vectors.get(s["id"]) or []) for s in selected)
            value = lam * rel - (1 - lam) * redundancy
            if value > best_value:
                best_value = value
                best = cand
        selected.append(best)
        pool.remove(best)
    return selected


def pack_budget(items: list[dict], budget: int) -> tuple[list[dict], int]:
    """贪心预算打包：按 score/len 降序装入，直到 token 预算耗尽。"""
    if not budget or budget <= 0:
        return list(items), sum(int(i.get("tokens") or 0) for i in items)
    greedy = sorted(items, key=lambda i: (-(i.get("score", 0.0) /
                                           max(1, int(i.get("tokens") or 1))), i["id"]))
    chosen: list[dict] = []
    used = 0
    for item in greedy:
        cost = int(item.get("tokens") or 0)
        if used + cost > budget:
            continue
        chosen.append(item)
        used += cost
    order = {item["id"]: idx for idx, item in enumerate(items)}
    chosen.sort(key=lambda i: order[i["id"]])
    return chosen, used


# ===========================================================================
# 5. 摘要片段
# ===========================================================================

def _snippet(memory: dict, query: str) -> str:
    body = (memory.get("body") or "").strip()
    summary = (memory.get("summary") or "").strip()
    source = body or summary
    if not source:
        return (memory.get("title") or "")[:SNIPPET_CHARS]
    lowered = source.lower()
    anchor = -1
    for gram in _cjk_terms(query) + [t.lower() for t in _ASCII_TOKEN_RE.findall(query or "")]:
        pos = lowered.find(gram)
        if pos >= 0:
            anchor = pos
            break
    if anchor < 0:
        anchor = 0
    half = SNIPPET_CHARS // 2
    start = max(0, anchor - half // 2)
    piece = re.sub(r"\s+", " ", source[start:start + SNIPPET_CHARS]).strip()
    if start > 0:
        piece = "…" + piece
    if start + SNIPPET_CHARS < len(source):
        piece = piece + "…"
    return piece


def _citation(memory: dict) -> str:
    return "[m:%s]" % memory.get("id", "")


def _hit(memory: dict, score: float, channels: dict, query: str) -> dict:
    snippet = _snippet(memory, query)
    tokens = estimate_tokens(memory.get("title") or "") + estimate_tokens(snippet)
    merged = {name: 0.0 for name in DEFAULT_WEIGHTS}
    merged.update({k: float(v) for k, v in (channels or {}).items()})
    return {
        "id": memory.get("id"),
        "kind": memory.get("kind") or "fact",
        "title": memory.get("title") or "",
        "snippet": snippet,
        "score": round(float(score), 6),
        "channels": merged,
        "trust": round(float(memory.get("trust") or 0.0), 4),
        "citation": _citation(memory),
        "tokens": tokens,
        "scope_id": memory.get("scope_id"),
        "status": memory.get("status"),
    }


# ===========================================================================
# 6. 对外接口
# ===========================================================================

_STRATEGY_ALIASES = {
    "hybrid": ("bm25", "vector", "graph", "substring"),
    "bm25": ("bm25",),
    "bm25-only": ("bm25",),
    "keyword": ("bm25",),
    "fulltext": ("bm25",),
    "vector": ("vector",),
    "semantic": ("vector",),
    "graph": ("graph",),
    "substring": ("substring",),
    "like": ("substring",),
}


def search(store, gw, query, *, scope=None, limit=20, strategy="hybrid",
           budget=None, include_candidates=False, diversify=None) -> dict:
    """混合召回主入口。永不抛异常；降级原因写进 degraded。

    diversify:
        None  → 给了 budget 就开（打包场景默认去冗余），否则关
        True  → 强制 MMR
        False → 强制关闭
    """
    started = time.perf_counter()
    degraded: list[str] = []
    query = (query or "").strip()
    limit = max(0, int(limit or 0))
    strategy = (strategy or "hybrid").lower()
    active = _STRATEGY_ALIASES.get(strategy)
    if active is None:
        degraded.append("strategy: 未知策略 %r，回退 hybrid" % strategy)
        active = _STRATEGY_ALIASES["hybrid"]
        strategy = "hybrid"

    diversify = bool(budget) if diversify is None else bool(diversify)
    result = {"hits": [], "degraded": degraded, "took_ms": 0, "strategy": strategy, "total": 0}
    if not query or limit == 0:
        result["took_ms"] = round((time.perf_counter() - started) * 1000, 3)
        return result

    try:
        con = _connect(store)
    except Exception as exc:
        degraded.append("store: 无法连接数据库（%s）" % type(exc).__name__)
        result["took_ms"] = round((time.perf_counter() - started) * 1000, 3)
        return result

    try:
        scope_ids = _expand_scope(con, scope)
    except Exception:
        scope_ids = None
    try:
        pool = _fetch_pool(store, con, scope_ids, include_candidates, max(limit * 20, 200))
    except Exception as exc:
        degraded.append("store: 候选池读取失败（%s）" % type(exc).__name__)
        pool = []
    if not pool:
        result["took_ms"] = round((time.perf_counter() - started) * 1000, 3)
        return result

    by_id = {m["id"]: m for m in pool}
    allowed = set(by_id)

    channels: dict[str, list[tuple[str, float]]] = {}
    coverage: dict[str, dict[str, float]] = {}
    try:
        if "bm25" in active:
            cov: dict[str, float] = {}
            ranked = _channel_bm25(con, query, allowed, max(limit * 10, 50), degraded, cov)
            if not ranked:
                ranked = _channel_bm25_memory(pool, query, max(limit * 10, 50))
            channels["bm25"] = ranked
            if cov:
                coverage["bm25"] = cov
    except Exception as exc:
        degraded.append("bm25: 通道失败（%s）" % type(exc).__name__)

    try:
        if "substring" in active:
            cov_sub: dict[str, float] = {}
            channels["substring"] = _channel_substring(con, query, allowed,
                                                       max(limit * 10, 50), scope_ids, cov_sub)
            if cov_sub:
                coverage["substring"] = cov_sub
    except Exception as exc:
        degraded.append("substring: 通道失败（%s）" % type(exc).__name__)

    local_vecs: dict[str, list[float]] = {}
    if "vector" in active:
        try:
            ranked, local_vecs = _channel_vector(store, gw, query, pool,
                                                 max(limit * 10, 50), degraded)
            channels["vector"] = ranked
        except Exception as exc:
            degraded.append("vector: 通道失败（%s）" % type(exc).__name__)

    try:
        if "graph" in active:
            channels["graph"] = _channel_graph(con, query, scope_ids, max(limit * 10, 50),
                                              allowed)
    except Exception as exc:
        degraded.append("graph: 通道失败（%s）" % type(exc).__name__)

    channels = {name: ranked for name, ranked in channels.items() if ranked}
    coverage = {name: cov for name, cov in coverage.items() if name in channels}
    fused = rrf_fuse(channels, coverage=coverage)
    if not fused:
        result["took_ms"] = round((time.perf_counter() - started) * 1000, 3)
        return result

    # 兜底：任何通道漏出池外 id（例如图通道连到了作用域外记忆）都在这里统一剔除。
    # 单点修复容易漏（_channel_graph 就曾同时有两处），这里再挡一道，保证 by_id[...] 安全。
    dropped = [doc_id for doc_id in fused if doc_id not in by_id]
    if dropped:
        for doc_id in dropped:
            fused.pop(doc_id, None)
        degraded.append("fuse: 丢弃 %d 条作用域外命中（%s）"
                        % (len(dropped), ", ".join(dropped[:3])))

    ranked_items = sorted(fused.values(), key=lambda d: (-d["rrf"], d["id"]))
    if not ranked_items:
        result["degraded"] = list(dict.fromkeys(degraded))
        result["took_ms"] = round((time.perf_counter() - started) * 1000, 3)
        return result
    window = ranked_items[:max(limit * 4, 40)]
    for item in window:
        item["score"] = item["rrf"]

    # --- 重排（可选，失败一律分数透传）
    if gw is not None:
        docs = [_text_of(by_id[i["id"]])[:2000] for i in window]
        top_k = min(len(docs), max(limit * 2, 20))
        reranked, reason = _call_gateway(gw, "rerank", query, docs, top_k=top_k)
        if reranked:
            try:
                norm: dict[int, float] = {}
                for pair in reranked:
                    idx, value = int(pair[0]), float(pair[1])
                    if 0 <= idx < len(window):
                        norm[idx] = value
                hi = max(norm.values()) if norm else 1.0
                hi = hi if hi > 0 else 1.0
                base = max(i["score"] for i in window) or 1.0
                for idx, item in enumerate(window):
                    left = (1 - RERANK_MIX) * item["score"] / base
                    right = RERANK_MIX * norm.get(idx, 0.0) / hi
                    item["score"] = left + right
                window.sort(key=lambda i: (-i["score"], i["id"]))
            except (TypeError, ValueError, IndexError):
                degraded.append("rerank: 返回格式无法解析，分数透传")
        else:
            degraded.append("rerank: %s" % (reason or "网关返回空，分数透传"))
    else:
        degraded.append("rerank: 未配置模型网关，分数透传")

    items = [_hit(by_id[i["id"]], i["score"], i["channels"], query) for i in window]

    # --- MMR 去冗余
    # 只在"打包上下文"时启用：纯检索场景下同主题的 10 条记忆本来就都该返回，
    # 用 MMR 把它们当成冗余剔除会直接拉低 Recall@10（实测 0.9 → 0.6）。
    if diversify and len(items) > limit:
        if local_vecs:
            items = _mmr_select(items, local_vecs, limit)
        else:
            items = items[:limit]
    elif len(items) > limit:
        items = items[:limit]

    # --- 预算贪心打包
    used = None
    if budget:
        items, used = pack_budget(items, int(budget))

    result["hits"] = items
    result["total"] = len(fused)
    result["tokens"] = used if used is not None else sum(i["tokens"] for i in items)
    if budget:
        result["budget"] = int(budget)
    result["degraded"] = list(dict.fromkeys(degraded))
    result["took_ms"] = round((time.perf_counter() - started) * 1000, 3)
    return result


def digest(store, gw, *, scope="global", budget=1200, task=None, agent_id=None) -> dict:
    """把预算内的记忆打成一段可直接塞进上下文的文本。"""
    started = time.perf_counter()
    degraded: list[str] = []
    budget = int(budget or 0)
    query = (task or "").strip()
    items: list[dict] = []
    if query:
        found = search(store, gw, query, scope=scope, limit=60, budget=None,
                       include_candidates=False)
        degraded.extend(found.get("degraded") or [])
        items = found.get("hits") or []
    else:
        try:
            con = _connect(store)
            scope_ids = _expand_scope(con, scope)
            pool = _fetch_pool(store, con, scope_ids, False, 500)
            pool.sort(key=lambda m: (-(float(m.get("importance") or 0.0)),
                                     str(m.get("recorded_at") or "")))
            items = [_hit(m, float(m.get("importance") or 0.0) or 0.0001, {"digest": 1.0}, "")
                     for m in pool]
        except Exception as exc:
            degraded.append("store: digest 读取失败（%s）" % type(exc).__name__)
    packed, used = pack_budget(items, budget) if budget else (items, sum(i["tokens"] for i in items))
    lines = []
    for item in packed:
        lines.append("- %s %s：%s" % (item["citation"], item["title"], item["snippet"]))
    return {
        "scope": scope,
        "task": task,
        "agent_id": agent_id,
        "budget": budget,
        "tokens": used,
        "text": "\n".join(lines),
        "items": [{"id": i["id"], "title": i["title"], "tokens": i["tokens"],
                   "score": i["score"], "citation": i["citation"]} for i in packed],
        "count": len(packed),
        "degraded": list(dict.fromkeys(degraded)),
        "took_ms": round((time.perf_counter() - started) * 1000, 3),
    }


def recall_for_agent(store, gw, query, agent_id, scope=None, limit=10) -> dict:
    """智能体召回：作用域继承 + 写 recall_log（写失败不影响召回）。"""
    started = time.perf_counter()
    resolved = scope or ("agent:%s" % agent_id if agent_id else "global")
    result = search(store, gw, query, scope=resolved, limit=limit, strategy="hybrid")
    result["agent_id"] = agent_id
    result["query"] = query
    result["scope"] = resolved
    result["degraded"] = list(dict.fromkeys(result.get("degraded") or []))
    try:
        con = _connect(store)
        con.execute(
            "INSERT INTO recall_log(id, query, scope_id, agent_id, strategy, hit_ids, scores,"
            " latency_ms, tokens, degraded, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            (hashlib.blake2b(("%s|%s|%s" % (query, agent_id, _db.now())).encode("utf-8"),
                             digest_size=12).hexdigest(),
             query, resolved, agent_id, result.get("strategy"),
             json.dumps([h["id"] for h in result["hits"]], ensure_ascii=False),
             json.dumps({h["id"]: h["score"] for h in result["hits"]}, ensure_ascii=False),
             int(result.get("took_ms") or 0), int(result.get("tokens") or 0),
             1 if result["degraded"] else 0, _db.now()))
    except Exception:
        result["degraded"].append("recall_log: 写入失败（不影响召回结果）")
    result["took_ms"] = round((time.perf_counter() - started) * 1000, 3)
    return result
