# -*- coding: utf-8 -*-
"""混合召回：BM25 + 子串 + 图（+ embedding 模型可用时的向量）→ RRF → 重排 → MMR → 预算打包。

流水线（每一步都可单独降级，绝不抛异常给上层）：

    query
      ├─ bm25      FTS5 bm25(title 3.0 / summary 1.5 / body 1.0)，ASCII 词 + 中文二元组前缀
      ├─ substring 候选池内字面子串匹配（不区分大小写）：ASCII 词 + 中文二元组，池内 IDF 加权
      ├─ vector    只用网关的 embedding 模型（云端向量缓存在 vector 表，键 provider/model@dim）
      └─ graph     个性化 PageRank（α=0.85，2 跳）
           ↓  RRF：score(d)=Σ_c w_c·cov_c(d)/(k+rank_c(d)), k=60
           ↓  rerank（可选；未配置/失败 = 不重排，保持 RRF 顺序）
           ↓  MMR（λ=0.7，只在打包时；冗余度用向量通道的向量，没有时用本地词形草图）
           ↓  预算贪心打包（score/len）
        {hits, degraded, took_ms, strategy, total,
         channels_used, vector_model, semantic, reranked, score_kind}

没有可用的 embedding 模型时，hybrid **不含**向量通道：本地 hash_embed 是词形草图
（特征哈希），不是语义向量；在 memory-eval-v1 dev 集上把它混进融合让默认检索
从 0.517 掉到 0.397（nDCG@10），比它自己的关键词部分还差。显式 strategy=vector
（或含 vector 的组合）时才用草图兜底，并标成 vector_model='local-hash-256'、semantic=false。
数字的来源与复现命令见 docs/retrieval.md（tools/eval_retrieval.py）。

降级契约：gw 是 duck-typed 的 ModelGateway，只调用 gw.embed / gw.rerank；网关有
interactive() 时整次检索在它的快速失败模式里调用（不重试、单次超时与总预算有上限）。
任何异常都被吞掉，原因写进返回值的 degraded 字符串数组。

候选池一律 SQL 直读 memory 表：1.0.0 给 Store 时走 Store.list_memories，被它的分页
上限 500 截断，更早的记忆永远搜不到、也判不了重。sensitivity='secret' 的记忆默认不进池
（include_secret=True 才包含）。
"""
from __future__ import annotations

import contextlib
import functools
import hashlib
import json
import math
import operator
import re
import sqlite3
import time
import unicodedata
from array import array
from typing import Any

from . import db as _db
from .vectors import (
    DIM,
    MODEL_LOCAL,
    VectorIndex,
    cached_vectors,
    cloud_model_key,
    cosine,
    estimate_tokens,
    hash_embed,
    unpack_vec,
    _open_store,
)

__all__ = [
    "estimate_tokens", "search", "digest", "recall_for_agent",
    "K_RRF", "DEFAULT_WEIGHTS", "MMR_LAMBDA", "pack_budget", "rrf_fuse", "CHANNELS",
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
MAX_LIKE_GRAMS = 32        # 子串通道最多用多少个检索词；1.0.0 的 12 会截掉长问句后半与 ASCII 词
                           # （dev：hybrid 0.608 → 0.625，32 以上不再变化）
SUBSTRING_MIN_ASCII = 3    # 子串通道里 ASCII 词的最短长度
SUBSTRING_ASCII_FIRST = False   # 截断检索词时 ASCII 词是否排在中文二元组前面
SUBSTRING_IDF = False      # 子串通道按池内 IDF（True）还是按词长（False）给命中加权
COVERAGE_FUSION = False    # RRF 是否按"覆盖了多少查询词"给关键词通道加权。1.0.0 默认开；
                           # 换成切分 BM25 后它在 dev 上是负作用（0.608 关 / 0.570 开）
BM25_COVERAGE = True       # bm25 通道内部是否按覆盖率重排
BM25_MEMORY_FALLBACK = True     # FTS 无结果时是否再跑一次纯 Python BM25
CACHE_VECTORS = True
# 向量通道来自 embedding 模型时，bm25/substring/graph 的 RRF 权重乘以它（只作用于已有向量的记忆；
# 还没补算到向量的记忆按原权重参与，不会因此被埋掉）。用本机 Ollama qwen3-embedding:0.6b 在
# memory-eval-v1 dev 上调：1.0 → 0.717，0.3 → 0.782，0.1 → 0.809，0.02 → 0.832（向量单独 0.831，
# 关键词单独 0.625）。只测过这一个模型；换弱模型时可调大。
SEMANTIC_LEXICAL_SCALE = 0.02
MAX_CLOUD_EMBED = 400      # 单次 search 最多为多少条记忆补算云端向量（其余在 degraded 里说明）
BACKFILL_SECONDS = 3.0     # 单次 search 花在补算向量上的时间上限（冷缓存不能吃掉整次检索的预算）
EMBED_CHUNK = 64           # 补算时每次 embed 调用的条数（失败只损失这一块）
POOL_CAP = 50000           # 候选池上限；超出时 degraded 里说明
CHANNEL_COMBINATIONS = True     # strategy 支持 "bm25+substring" 这类通道组合
BM25_ENGINE = "lexical"    # "lexical"：Python 侧二元组切分 BM25（默认）；"fts5"：1.0.0 的 unicode61 FTS5
BM25_K1 = 1.2
BM25_B = 0.75
BM25_CHAR_WEIGHT = 0.25    # 中文单字回退项的权重（二元组 = 1.0）
BM25_STEM = True           # 英文复数词尾归一（S-stemmer）
BM25_PREFIX = True         # 英文词 ≥3 字符时追加前缀匹配（lint → linter）
BM25_STOPWORDS = True      # 查询侧去掉虚词（索引侧从不去）

MODEL_CLOUD = "cloud-embed"     # 网关拿不到档位名时的标签；1.0.0 用它做唯一缓存键（已弃用）
DEFAULT_STATUS = ("approved",)
CHANNELS = ("bm25", "substring", "vector", "graph")

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


def _has_column(con: sqlite3.Connection, table: str, column: str) -> bool:
    try:
        return any(row[1] == column for row in
                   con.execute("PRAGMA table_info(%s)" % table).fetchall())
    except sqlite3.Error:
        return False


class _PoolFilter:
    """候选池的过滤条件。池查询和 FTS 查询共用它：FTS 的 LIMIT 必须在作用域/状态/
    敏感度过滤**之后**生效（1.0.0 先 LIMIT 再在 Python 里过滤，域外强命中会挤掉域内结果）。"""

    def __init__(self, scope_ids=None, include_candidates: bool = False,
                 include_secret: bool = False, con: sqlite3.Connection | None = None):
        statuses = list(DEFAULT_STATUS)
        if include_candidates:
            statuses.append("candidate")
        self.statuses = statuses
        self.scope_ids = list(scope_ids) if scope_ids else None
        self.include_secret = bool(include_secret)
        self.exclude_secret = bool(not self.include_secret and con is not None
                                   and _has_column(con, "memory", "sensitivity"))

    def where(self, alias: str = "") -> tuple[str, list]:
        prefix = alias + "." if alias else ""
        parts = ["%sstatus IN (%s)" % (prefix, ",".join("?" * len(self.statuses)))]
        args: list[Any] = list(self.statuses)
        if self.scope_ids:
            parts.append("%sscope_id IN (%s)" % (prefix, ",".join("?" * len(self.scope_ids))))
            args.extend(self.scope_ids)
        if self.exclude_secret:
            parts.append("coalesce(%ssensitivity, 'normal') <> 'secret'" % prefix)
        return " AND ".join(parts), args


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
    """内部 filters 约定：{status:[...], scope_ids:[...], limit:int}，一律 SQL 直读。

    1.0.0 这里先试 Store.list_memories：它把 limit 钳在 MAX_LIMIT=500，于是给 Store
    （服务端、MCP、工作流都是这么调的）时只有最近更新的 500 条记忆可被检索和判重。
    """
    return _sql_list_memories(_connect(store), dict(filters or {}))


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

def _fetch_pool(store, con, scope_ids, include_candidates: bool, limit: int,
                include_secret: bool = False, info: dict | None = None) -> list[dict]:
    """候选池：approved（+candidate），限定作用域，默认排除 sensitivity='secret'。

    直接 SQL，不经 Store.list_memories（其 500 条上限见 _store_search）。
    limit 是 SQL LIMIT（按 pinned / importance / recorded_at 取前 limit 条），上限 POOL_CAP；
    info 给出时写入 {"filter": _PoolFilter, "truncated": bool}。
    """
    if con is None:
        con = _connect(store)
    flt = _PoolFilter(scope_ids, include_candidates, include_secret, con)
    where, args = flt.where()
    cap = max(1, min(int(limit or POOL_CAP), POOL_CAP))
    sql = ("SELECT %s FROM memory WHERE %s ORDER BY pinned DESC, importance DESC,"
           " recorded_at DESC LIMIT ?" % (_SQL_COLUMNS, where))
    rows = [_row_to_memory(r) for r in con.execute(sql, (*args, cap + 1)).fetchall()]
    if info is not None:
        info["filter"] = flt
        info["truncated"] = len(rows) > cap
    return rows[:cap]


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
                  degraded: list[str], coverage_out: dict | None = None, *,
                  flt: "_PoolFilter | None" = None, texts: dict | None = None
                  ) -> list[tuple[str, float]]:
    """FTS5 bm25。flt 给出时作用域/状态/敏感度过滤写进 SQL，LIMIT 在过滤之后生效。
    texts（{id: 小写全文}）给出时覆盖率直接在内存里算，不再逐条 SELECT。"""
    expr = _fts_expression(query)
    if not expr:
        return []
    where, args = flt.where("m") if flt is not None else ("", [])
    sql = ("SELECT m.id AS id, bm25(memory_fts, ?, ?, ?) AS s FROM memory_fts"
           " JOIN memory m ON m.rowid = memory_fts.rowid WHERE memory_fts MATCH ?"
           + (" AND " + where if where else "") + " ORDER BY s LIMIT ?")
    try:
        rows = con.execute(sql, (*BM25_WEIGHTS, expr, *args, limit)).fetchall()
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
            text = texts.get(mid) if texts is not None else None
            if text is None:
                row = con.execute("SELECT title, body, coalesce(summary,'') FROM memory"
                                  " WHERE id=?", (mid,)).fetchone()
                text = " ".join(r or "" for r in row) if row else ""
            coverage = _query_coverage(text, terms)
            rescored.append((mid, score * (0.2 + 0.8 * coverage) if BM25_COVERAGE else score))
            if coverage_out is not None:
                coverage_out[mid] = coverage
        rescored.sort(key=lambda kv: (-kv[1], kv[0]))
        return rescored[:limit]
    return out[:limit]


# --- Python 侧 BM25：与 FTS5 unicode61 不同，按文字类别切分 ------------------------------
#
# unicode61 把一整段中文（以及紧贴中文的 ASCII，如"使用WAL模式"）当成一个 token，
# 1.0.0 只能用"二元组前缀 OR"去碰运气。这里在 Python 侧切分：
#   文档：ASCII/拉丁/希腊/西里尔词按词边界；中文/假名/谚文连续段切成重叠二元组
#         （单字段取单字），另记单字用于回退；文字类别一变就断开，"使用wal模式" → 使用 / wal / 模式
#   查询：同样切分；去掉英文虚词与"两个字都是虚字"的二元组（只在查询侧去，索引侧不去）；
#         英文词做复数归一（S-stemmer）并追加前缀匹配；中文单字以 BM25_CHAR_WEIGHT 回退
#   打分：BM25（k1=1.2, b=0.75），列权重 title 3.0 / summary 1.5 / body 1.0，IDF 在候选池内统计
# 不建持久倒排表：每条记忆只在进程内缓存"规范化文本 + 加权长度"（按原文比对失效），
# 查询时对候选池做 C 级子串扫描。memory-eval-v1 dev 集上，这一条通道单独就从 FTS5 的
# 0.469 升到约 0.61（nDCG@10，见 docs/retrieval.md）。

_WORD_CHARS = "0-9a-z_À-ɏͰ-ϿЀ-ӿ"
_LEX_RUN_RE = re.compile("[%s]+|[%s]+" % (_CJK_CLASS, _WORD_CHARS))
_LEX_CJK_RE = re.compile("[%s]" % _CJK_CLASS)
# 查询侧英文虚词：OR 语义下 'what does it' 会命中每一条英文记忆
_STOP_WORDS = frozenset((
    "a an the is are was were be been being am do does did done doing have has had having "
    "of to in on at by for from with about into onto over under than then as and or but if so "
    "nor it its this that these those there here what which who whom whose when where why how "
    "i me my we us our you your he him his she her they them their can could should would will "
    "shall may might must any some all each every also just very").split())
# 查询侧中文虚字：两个字都在表里的二元组（"是什""什么"）没有主题信息
_STOP_CHARS = frozenset("的了是在和与及或吗呢吧啊么什怎哪谁这那个也都就而被把着过之其为以于"
                        "对从但所如若则即该此每各有没不要会能可还又再很更最")
_LEX_CACHE: dict = {}        # id → (原文三元组, 规范化三元组, 拼接文本, 加权长度, 列权重)
_LEX_CACHE_LIMIT = 200000


def _lex_norm(text: str) -> str:
    """NFKC（全角 → 半角）+ 小写。"""
    text = text or ""
    if not unicodedata.is_normalized("NFKC", text):
        text = unicodedata.normalize("NFKC", text)
    return text.lower()


def _stem(word: str) -> str:
    """S-stemmer（Harman 1991）：只归一英文复数词尾，其它词原样返回。"""
    if not BM25_STEM or len(word) <= 3 or not word.isascii() or not word.isalpha():
        return word
    if word.endswith("ies") and not word.endswith(("eies", "aies")):
        return word[:-3] + "y"
    if word.endswith("es") and not word.endswith(("aes", "ees", "oes")) and len(word) > 4:
        return word[:-1]
    if word.endswith("s") and not word.endswith(("us", "ss")):
        return word[:-1]
    return word


def _lex_doc(mem: dict) -> tuple:
    """→ (规范化 (title, summary, body), 拼接文本, 加权长度)，按原文缓存在进程内。"""
    raw = (mem.get("title") or "", mem.get("summary") or "", mem.get("body") or "")
    mid = mem.get("id")
    hit = _LEX_CACHE.get(mid)
    if hit is not None and hit[4] == BM25_WEIGHTS and hit[0] == raw:
        return hit[1], hit[2], hit[3]
    norm = tuple(_lex_norm(part) for part in raw)
    length = 0.0
    for text, weight in zip(norm, BM25_WEIGHTS):
        if not weight or not text:
            continue
        count = 0
        for tok in _LEX_RUN_RE.findall(text):
            count += max(1, len(tok) - 1) if _LEX_CJK_RE.match(tok) else 1
        length += weight * count
    joined = "\n".join(norm)
    if len(_LEX_CACHE) >= _LEX_CACHE_LIMIT:
        _LEX_CACHE.clear()
    _LEX_CACHE[mid] = (raw, norm, joined, length, BM25_WEIGHTS)
    return norm, joined, length


def _lex_query(query: str, stop: bool | None = None) -> list[tuple[str, str, float]]:
    """查询切分 → [(kind, term, weight)]，kind ∈ word / prefix / gram / char。
    全是虚词时（例如只问 "what is it"）不去虚词再切一次。"""
    stop = BM25_STOPWORDS if stop is None else stop
    groups: list[tuple[str, str, float]] = []
    for tok in _LEX_RUN_RE.findall(_lex_norm(query)):
        if _LEX_CJK_RE.match(tok):
            if len(tok) == 1:
                groups.append(("char", tok, BM25_CHAR_WEIGHT))
                continue
            for pos in range(len(tok) - 1):
                gram = tok[pos:pos + 2]
                if stop and gram[0] in _STOP_CHARS and gram[1] in _STOP_CHARS:
                    continue
                groups.append(("gram", gram, 1.0))
            for ch in tok:
                if not (stop and ch in _STOP_CHARS):
                    groups.append(("char", ch, BM25_CHAR_WEIGHT))
        else:
            if stop and tok in _STOP_WORDS:
                continue
            word = _stem(tok)
            groups.append(("word", word, 1.0))
            if BM25_PREFIX and len(word) >= 3 and not word.isdigit():
                groups.append(("prefix", word, 1.0))
    seen: set = set()
    out = []
    for kind, term, weight in groups:
        if (kind, term) not in seen:
            seen.add((kind, term))
            out.append((kind, term, weight))
    if not out and stop:
        return _lex_query(query, stop=False)
    return out


def _word_root(word: str) -> str:
    """子串预筛用的词根：policy 要能找到 policies。"""
    return word[:-1] if word.endswith("y") and len(word) > 3 else word


@functools.lru_cache(maxsize=4096)
def _word_re(root: str):
    return re.compile("(?<![%s])%s[%s]*" % (_WORD_CHARS, re.escape(root), _WORD_CHARS))


def _lex_tf(kind: str, term: str, fields: tuple) -> float:
    """某个查询项在一条记忆里的加权词频（title 3.0 / summary 1.5 / body 1.0）。"""
    total = 0.0
    for text, weight in zip(fields, BM25_WEIGHTS):
        if not weight or not text:
            continue
        if kind in ("gram", "char"):
            count = text.count(term)
        else:
            count = 0
            for match in _word_re(_word_root(term)).finditer(text):
                stem = _stem(match.group(0))
                if kind == "word":
                    count += stem == term
                elif stem != term and stem.startswith(term):
                    count += 1
        total += weight * count
    return total


class _Scan:
    """候选池文本的子串扫描（同一次检索里 bm25 与 substring 共用、按词记忆）。"""

    def __init__(self, texts: dict):
        self.texts = texts
        self.memo: dict = {}

    def ids(self, needle: str) -> list:
        hit = self.memo.get(needle)
        if hit is None:
            hit = [mid for mid, text in self.texts.items() if needle in text]
            self.memo[needle] = hit
        return hit


def _channel_bm25_lexical(query: str, docs: dict, limit: int, scan: "_Scan | None" = None
                          ) -> list[tuple[str, float]]:
    """docs = {id: (规范化三列, 拼接文本, 加权长度)}（_lex_doc 的结果）。"""
    groups = _lex_query(query)
    if not groups or not docs:
        return []
    if scan is None:
        scan = _Scan({mid: doc[1] for mid, doc in docs.items()})
    n_docs = len(docs)
    avg = (sum(doc[2] for doc in docs.values()) / n_docs) or 1.0
    k1, b = BM25_K1, BM25_B
    scores: dict[str, float] = {}
    for kind, term, weight in groups:
        probe = term if kind in ("gram", "char") else _word_root(term)
        hits = []
        for mid in scan.ids(probe):
            doc = docs.get(mid)
            if doc is None:
                continue
            tf = _lex_tf(kind, term, doc[0])
            if tf > 0:
                hits.append((mid, tf, doc[2]))
        if not hits:
            continue
        df = len(hits)
        idf = math.log(1.0 + (n_docs - df + 0.5) / (df + 0.5)) * weight
        for mid, tf, length in hits:
            scores[mid] = scores.get(mid, 0.0) + idf * tf * (k1 + 1) / (
                tf + k1 * (1 - b + b * length / avg))
    ranked = sorted(scores.items(), key=lambda kv: (-kv[1], kv[0]))
    return ranked[:limit]


def _channel_bm25_memory(pool: list[dict], query: str, limit: int) -> list[tuple[str, float]]:
    """纯 Python BM25（与默认 lexical 引擎相同），给 FTS5 不可用时兜底。"""
    return _channel_bm25_lexical(query, {m["id"]: _lex_doc(m) for m in pool}, limit)


def lexical_candidates(pool: list[dict], text: str, k: int) -> list[dict]:
    """判重预筛：池里与 text 字面最接近的候选（dedup.find_duplicates 用）。

    = 规范化后 title+body 与 text 完全相同的记忆（一条不漏）
      ∪ 以 text 前 400 字作查询的切分 BM25 前 k 名（近似重复字面重叠高，必在前列）。
    池不大于 k 时原样返回，结果与全量比对完全一致。
    """
    if len(pool) <= k:
        return list(pool)
    probe = _lex_norm(text or "")
    exact = []
    docs = {}
    for mem in pool:
        norm, joined, length = _lex_doc(mem)
        docs[mem["id"]] = (norm, joined, length)
        combined = "\n".join(p for p in (norm[0], norm[2]) if p)
        if combined == probe:
            exact.append(mem["id"])
    groups_query = (text or "")[:400]
    ranked = _channel_bm25_lexical(groups_query, docs, k)
    keep = list(dict.fromkeys(exact + [mid for mid, _ in ranked]))
    by_id = {m["id"]: m for m in pool}
    return [by_id[mid] for mid in keep if mid in by_id]


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


def _substring_terms(query: str) -> list[str]:
    """子串通道的检索词：ASCII 词（≥ SUBSTRING_MIN_ASCII 字符，小写）+ 中文二元组
    （单字成段时取单字），去重后截到 MAX_LIKE_GRAMS 个。"""
    ascii_terms = [tok.lower() for tok in _ASCII_TOKEN_RE.findall(query or "")
                   if len(tok) >= SUBSTRING_MIN_ASCII]
    cjk_terms = _cjk_terms(query)
    ordered = ascii_terms + cjk_terms if SUBSTRING_ASCII_FIRST else cjk_terms + ascii_terms
    return [t for t in dict.fromkeys(ordered) if t][:MAX_LIKE_GRAMS]


def _pool_texts(con: sqlite3.Connection, allowed: set[str]) -> dict[str, str]:
    """{id: 小写全文}，只给直接调用子串通道、没有候选池文本的旧调用方用。"""
    out: dict[str, str] = {}
    for row in con.execute("SELECT id, title, body, coalesce(summary,'') FROM memory"):
        if row[0] in allowed:
            out[row[0]] = "\n".join(p for p in (row[1] or "", row[3] or "", row[2] or "") if p).lower()
    return out


def _channel_substring(con: sqlite3.Connection, query: str, allowed: set[str],
                       limit: int, scope_ids=None, coverage_out: dict | None = None, *,
                       texts: dict | None = None, scan: "_Scan | None" = None
                       ) -> list[tuple[str, float]]:
    """字面子串召回（不区分大小写）：在候选池文本里找 ASCII 词与中文二元组。

    unicode61 把整段中文、以及紧贴中文的 ASCII（"使用WAL模式"）切成一个 token，
    FTS 查不到，这一步补召回。1.0.0 用 SQL LIKE 逐词全表扫描、最多 12 个词（中文二元组排前，
    ASCII 词常被截掉），并且把 % 和 _ 直接删掉（snake_case 变成 snakecase 就搜不到了）；
    现在是 Python 字面匹配，不存在通配符转义问题。
    分数 = Σ 命中词权重 / Σ 全部词权重 × (0.2 + 0.8·覆盖率)。
    """
    query = _lex_norm(query)
    grams = _substring_terms(query)
    if not grams:
        return []
    if texts is None:
        texts = _pool_texts(con, allowed)
    if scan is None:
        scan = _Scan(texts)
    n_docs = max(1, len(texts))
    postings = {}
    for gram in grams:
        ids = scan.ids(gram)
        if ids:
            postings[gram] = ids
    if not postings:
        return []
    if SUBSTRING_IDF:
        weight = {g: math.log(1.0 + (n_docs - len(ids) + 0.5) / (len(ids) + 0.5))
                  for g, ids in postings.items()}
        weight_total = sum(weight.values()) or 1.0
    else:
        weight = {g: float(len(g)) for g in postings}
        weight_total = float(sum(len(g) for g in grams)) or 1.0
    matched: dict[str, float] = {}
    for gram, ids in postings.items():
        for mid in ids:
            matched[mid] = matched.get(mid, 0.0) + weight[gram]
    cov_terms = _coverage_terms(query)
    hits: dict[str, float] = {}
    for mid, value in matched.items():
        if mid not in allowed:
            continue
        # 命中权重 × 该文档对查询词的整体覆盖率：覆盖越全排得越前，
        # 避免"数据导出"只因共享「数据」二字就压过真正的目标记忆。
        coverage = _query_coverage(texts[mid], cov_terms)
        hits[mid] = (value / weight_total) * (0.2 + 0.8 * coverage)
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


def _fresh(entry, mem: dict, dim: int) -> bool:
    """缓存向量可用：维度对、且晚于记忆最后一次更新（created_at > updated_at，同为 UTC
    ISO-8601 秒）。与更新落在同一秒的向量视为过期、下次检索重算一次，杜绝"先算向量、
    同一秒内又改了文本"留下旧向量。1.0.0 的缓存行（'YYYY-MM-DD HH:MM:SS'）在同一天
    会被判过期并重算一次。"""
    return (entry is not None and len(entry[0]) == dim
            and entry[2] > str(mem.get("updated_at") or ""))


def _ensure_vectors(store, pool: list[dict], model: str = MODEL_LOCAL) -> dict:
    """池内每条记忆的本地词形草图（hash_embed）。读 vector 表缓存；缺失或比记忆更旧的
    现算，并一次性批量写回。返回 {id: 向量}（float32 array 或 list）。"""
    con = _connect(store)
    try:
        cached = cached_vectors(con, "memory", model)
    except sqlite3.Error:
        cached = {}
    out: dict = {}
    fresh: list = []
    for mem in pool:
        entry = cached.get(mem["id"])
        if _fresh(entry, mem, DIM):
            out[mem["id"]] = entry[0]
        else:
            vec = hash_embed(_text_of(mem))
            out[mem["id"]] = vec
            fresh.append((mem["id"], vec))
    if fresh and CACHE_VECTORS:
        try:
            VectorIndex(con, model=model).put_many("memory", fresh, model=model)
        except sqlite3.Error:
            pass
    return out


def _embedding_label(gw) -> str:
    """网关当前 embedding 档位的 'provider/model'；duck-typed 网关拿不到时为 MODEL_CLOUD。"""
    prof = None
    roles_fn = getattr(gw, "roles", None)
    if callable(roles_fn):
        try:
            prof = (roles_fn() or {}).get("embedding")
        except Exception:
            prof = None
    if prof is not None:
        if isinstance(prof, dict):
            provider, model = prof.get("provider"), prof.get("model")
        else:
            provider, model = getattr(prof, "provider", None), getattr(prof, "model", None)
        if provider and model:
            return "%s/%s" % (provider, model)
        if model:
            return str(model)
    label = getattr(gw, "embedding_label", None)
    if isinstance(label, str) and label.strip():
        return label.strip()
    return MODEL_CLOUD


def _cloud_channel(con: sqlite3.Connection, gw, query: str, pool: list[dict], limit: int,
                   degraded: list[str]):
    """云端向量通道。成功 → (ranked, vecs, model_key)；不可用 → (None, 原因, None)。

    先嵌入 query（失败就不再为候选池调用网关，挂死的端点只付一次超时），得到维度后
    按 'provider/model@dim' 读缓存；缺失或过期的最多补算 MAX_CLOUD_EMBED 条（分块调用，
    失败只损失当前块）。仍没有向量的候选数写进 degraded —— 1.0.0 只看前 400 条且不说。
    """
    got, reason = _call_gateway(gw, "embed", [query])
    if not got:
        return None, reason or "embed: 网关返回空的 query 向量", None
    try:
        qvec = [float(v) for v in got[0]]
    except (TypeError, IndexError, ValueError):
        return None, "embed: query 向量格式无法解析", None
    qnorm = math.sqrt(sum(v * v for v in qvec))
    if not qvec or qnorm <= 0:
        return None, "embed: query 向量为空或全零", None
    dim = len(qvec)
    key = cloud_model_key(_embedding_label(gw), dim)
    try:
        cached = cached_vectors(con, "memory", key)
    except sqlite3.Error:
        cached = {}
    have: dict = {}
    missing: list[dict] = []
    for mem in pool:
        entry = cached.get(mem["id"])
        if _fresh(entry, mem, dim):
            have[mem["id"]] = entry
        else:
            missing.append(mem)
    todo = missing[:MAX_CLOUD_EMBED]
    written: list = []
    backfill_started = time.perf_counter()
    for start in range(0, len(todo), EMBED_CHUNK):
        if start and time.perf_counter() - backfill_started > BACKFILL_SECONDS:
            break                   # 剩下的留给后续检索；未覆盖的条数下面会写进 degraded
        chunk = todo[start:start + EMBED_CHUNK]
        texts = [_text_of(m)[:4000] for m in chunk]
        embedded, why = _call_gateway(gw, "embed", texts)
        if not embedded or len(embedded) != len(texts):
            degraded.append("vector: 补算记忆向量失败（%s），已有向量照常使用"
                            % (why or "返回条数与请求不符"))
            break
        bad = False
        for mem, vec in zip(chunk, embedded):
            try:
                arr = array("f", [float(v) for v in vec])
            except (TypeError, ValueError):
                bad = True
                break
            if len(arr) != dim:
                bad = True
                break
            have[mem["id"]] = (arr, math.sqrt(sum(v * v for v in arr)), "")
            written.append((mem["id"], arr))
        if bad:
            degraded.append("vector: 网关返回的记忆向量与 query 向量（%d 维）不一致，已停止补算" % dim)
            break
    if written and CACHE_VECTORS:
        try:
            VectorIndex(con, model=key).put_many("memory", written, model=key)
        except sqlite3.Error:
            degraded.append("vector: 向量缓存写入失败（本次结果不受影响）")
    if not have:
        return None, "没有任何候选记忆有 %s 的向量" % key, None
    lacking = len(pool) - len(have)
    if lacking:
        degraded.append("vector: %d/%d 条候选记忆还没有 %s 的向量（每次检索最多补算 %d 条、"
                        "%.0f 秒），它们本次只参与关键词通道"
                        % (lacking, len(pool), key, MAX_CLOUD_EMBED, BACKFILL_SECONDS))
    mul = operator.mul
    ranked = []
    for mid, (arr, norm, _stamp) in have.items():
        if norm <= 0:
            continue
        score = sum(map(mul, qvec, arr)) / (qnorm * norm)
        if score > 0:
            ranked.append((mid, score))
    ranked.sort(key=lambda kv: (-kv[1], kv[0]))
    return ranked[:limit], {mid: entry[0] for mid, entry in have.items()}, key


def _sketch_channel(con: sqlite3.Connection, query: str, pool: list[dict], limit: int):
    """本地词形草图通道（local-hash-256）。向量已 L2 归一，余弦 = 稀疏点积。"""
    vecs = _ensure_vectors(con, pool)
    qvec = hash_embed(query)
    pairs = [(idx, weight) for idx, weight in enumerate(qvec) if weight]
    if not pairs:
        return [], vecs
    idxs = [idx for idx, _ in pairs]
    weights = [weight for _, weight in pairs]
    getter = operator.itemgetter(*idxs)
    mul = operator.mul
    single = len(idxs) == 1
    ranked = []
    for mid, vec in vecs.items():
        if len(vec) < DIM:
            continue
        score = getter(vec) * weights[0] if single else math.fsum(map(mul, getter(vec), weights))
        if score > 1e-9:
            ranked.append((mid, score))
    ranked.sort(key=lambda kv: (-kv[1], kv[0]))
    return ranked[:limit], vecs


def _channel_vector(store, gw, query: str, pool: list[dict], limit: int,
                    degraded: list[str], *, sketch: bool = True, info: dict | None = None,
                    con: sqlite3.Connection | None = None):
    """向量通道。返回 (ranked, vecs)；info 里写 {"model": 键, "semantic": bool}。

    1) 网关的 embedding 可用 → 云端向量（semantic=True）；
    2) 否则若 sketch=True（调用方显式点名了 vector）→ 本地词形草图 local-hash-256，
       degraded 写明"以词形草图代替，不是语义向量"；
    3) 否则（hybrid）→ 不跑向量通道，degraded 写明原因。绝不把草图当语义向量混进融合。
    """
    info = info if info is not None else {}
    if con is None:
        con = _connect(store)
    if gw is not None:
        ranked, vecs, key = _cloud_channel(con, gw, query, pool, limit, degraded)
        if ranked is not None:
            info.update(model=key, semantic=True)
            return ranked, vecs
        reason = vecs
    else:
        reason = "未配置模型网关（没有 embedding 模型）"
    if not sketch:
        degraded.append("vector: %s；本次没有向量通道（本地 hash 词形草图不参与 hybrid 融合）"
                        % reason)
        return [], {}
    degraded.append("vector: %s；已改用本地 %s 词形哈希草图（字符 n-gram 特征哈希，不是语义向量）"
                    % (reason, MODEL_LOCAL))
    try:
        ranked, vecs = _sketch_channel(con, query, pool, limit)
    except Exception as exc:
        degraded.append("vector: 本地草图不可用（%s）" % type(exc).__name__)
        return [], {}
    info.update(model=MODEL_LOCAL, semantic=False)
    return ranked, vecs


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


def _mmr_select(candidates: list[dict], vectors: dict, limit: int,
                lam: float = MMR_LAMBDA) -> list[dict]:
    """MMR：argmax[λ·rel(d) − (1−λ)·max_{s∈S} sim(d,s)]。

    每选中一条只算一次"剩余候选 × 新选中"的相似度并增量更新各自的最大值
    （O(limit·window) 次余弦；1.0.0 每轮对已选集合重算，O(limit²·window)）。"""
    if not candidates or limit <= 0:
        return []
    pool = list(candidates)
    top = max(c.get("score", 0.0) for c in pool) or 1.0
    mul = operator.mul
    norms: dict = {}

    def norm_of(cid, vec):
        value = norms.get(cid)
        if value is None:
            value = math.sqrt(sum(map(mul, vec, vec)))
            norms[cid] = value
        return value

    redundancy: dict = {}          # 候选 id → 到已选集合的最大相似度（未选任何条目时没有）
    selected: list[dict] = []
    while pool and len(selected) < limit:
        best_pos = 0
        best_value = -1e18
        for pos, cand in enumerate(pool):
            rel = cand.get("score", 0.0) / top
            red = redundancy.get(cand["id"]) if vectors.get(cand["id"]) is not None else None
            value = lam * rel - (1 - lam) * (red if red is not None else 0.0)
            if value > best_value:
                best_value = value
                best_pos = pos
        best = pool.pop(best_pos)
        selected.append(best)
        bvec = vectors.get(best["id"])
        bnorm = norm_of(best["id"], bvec) if bvec is not None else 0.0
        for cand in pool:
            vec = vectors.get(cand["id"])
            if vec is None:
                continue
            cnorm = norm_of(cand["id"], vec)
            sim = (sum(map(mul, vec, bvec)) / (cnorm * bnorm)
                   if bvec is not None and cnorm > 0 and bnorm > 0 else 0.0)
            old = redundancy.get(cand["id"])
            redundancy[cand["id"]] = sim if old is None else max(old, sim)
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
    # hybrid 列出全部通道，但向量通道只在 embedding 模型可用时参与（见 _channel_vector）
    "hybrid": ("bm25", "substring", "vector", "graph"),
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


def _resolve_strategy(strategy) -> tuple[str, tuple | None]:
    """→ (规范名, 通道元组)；未知策略通道为 None。支持 "bm25+substring" 这类组合。"""
    name = str(strategy or "hybrid").strip().lower()
    if name in _STRATEGY_ALIASES:
        return name, _STRATEGY_ALIASES[name]
    if "+" in name:
        picked: list[str] = []
        for part in name.split("+"):
            mapped = _STRATEGY_ALIASES.get(part.strip())
            if mapped is None or len(mapped) != 1:
                return name, None
            if mapped[0] not in picked:
                picked.append(mapped[0])
        ordered = tuple(c for c in CHANNELS if c in picked)
        return "+".join(ordered), ordered
    return name, None


def _interactive(gw):
    """网关的快速失败上下文（ModelGateway.interactive）；没有就是空上下文。"""
    factory = getattr(gw, "interactive", None) if gw is not None else None
    if callable(factory):
        try:
            ctx = factory()
            if hasattr(ctx, "__enter__") and hasattr(ctx, "__exit__"):
                return ctx
        except Exception:
            pass
    return contextlib.nullcontext()


def search(store, gw, query, *, scope=None, limit=20, strategy="hybrid",
           budget=None, include_candidates=False, diversify=None,
           include_secret=False) -> dict:
    """混合召回主入口。永不抛异常；降级原因写进 degraded。

    strategy:  hybrid（默认）/ bm25 / substring / vector / graph，或用 + 连接的通道组合
               （如 "bm25+substring"）。hybrid 只在 embedding 模型可用时含向量通道；
               显式点名 vector 时，没有模型就用本地词形草图并如实标注。
    diversify: None → 给了 budget 就开 MMR（打包场景去冗余）；True / False 强制开 / 关。
    include_secret: 默认 False，sensitivity='secret' 的记忆不进候选池（智能体召回、digest
               都用默认值）；用户自己的界面检索（HTTP /api/search）传 True。

    返回值在 1.0.0 的 {hits, degraded, took_ms, strategy, total} 之外新增（只增不改）：
        channels_used  实际跑成功的通道，例如 ["bm25", "substring", "graph"]
        vector_model   None | 'provider/model@dim'（embedding 模型）| 'local-hash-256'（草图）
        semantic       向量通道是否来自真正的 embedding 模型
        reranked       是否经过重排模型
        score_kind     'rrf'：hit.score 是 RRF 原始和（约 0.01~0.05，只用于排序，不是 0~1 归一分）；
                       'rrf+rerank'：0.65·RRF/最高 RRF + 0.35·重排分/最高重排分，0~1 之间的相对分
    """
    ctx = _interactive(gw)
    try:
        ctx.__enter__()
        entered = True
    except Exception:
        entered = False
    try:
        return _search(store, gw, query, scope=scope, limit=limit, strategy=strategy,
                       budget=budget, include_candidates=include_candidates,
                       diversify=diversify, include_secret=include_secret)
    finally:
        if entered:
            try:
                ctx.__exit__(None, None, None)
            except Exception:
                pass


def _search(store, gw, query, *, scope, limit, strategy, budget, include_candidates,
            diversify, include_secret) -> dict:
    started = time.perf_counter()
    degraded: list[str] = []
    query = (query or "").strip()
    limit = max(0, int(limit or 0))
    strategy, active = _resolve_strategy(strategy)
    if active is None:
        degraded.append("strategy: 未知策略 %r，回退 hybrid" % strategy)
        strategy, active = "hybrid", _STRATEGY_ALIASES["hybrid"]
    # hybrid 的向量通道只接受真正的 embedding 模型；显式点名 vector 才允许草图兜底
    sketch_ok = strategy != "hybrid"

    diversify = bool(budget) if diversify is None else bool(diversify)
    result = {"hits": [], "degraded": degraded, "took_ms": 0, "strategy": strategy, "total": 0,
              "channels_used": [], "vector_model": None, "semantic": False,
              "reranked": False, "score_kind": "rrf"}

    def finish() -> dict:
        result["degraded"] = list(dict.fromkeys(degraded))
        result["took_ms"] = round((time.perf_counter() - started) * 1000, 3)
        return result

    if not query or limit == 0:
        return finish()

    try:
        con = _connect(store)
    except Exception as exc:
        degraded.append("store: 无法连接数据库（%s）" % type(exc).__name__)
        return finish()

    try:
        scope_ids = _expand_scope(con, scope)
    except Exception:
        scope_ids = None
    pool_info: dict = {}
    try:
        pool = _fetch_pool(store, con, scope_ids, include_candidates, POOL_CAP,
                           include_secret=include_secret, info=pool_info)
    except Exception as exc:
        degraded.append("store: 候选池读取失败（%s）" % type(exc).__name__)
        pool = []
    if pool_info.get("truncated"):
        degraded.append("store: 候选记忆超过 %d 条，只检索了 pinned/重要度最高的 %d 条"
                        % (POOL_CAP, POOL_CAP))
    if not pool:
        return finish()

    by_id = {m["id"]: m for m in pool}
    allowed = set(by_id)
    flt = pool_info.get("filter")
    depth = max(limit * 10, 50)
    docs = texts = scan = None
    if "bm25" in active or "substring" in active:
        docs = {m["id"]: _lex_doc(m) for m in pool}
        texts = {mid: doc[1] for mid, doc in docs.items()}
        scan = _Scan(texts)

    channels: dict[str, list[tuple[str, float]]] = {}
    coverage: dict[str, dict[str, float]] = {}
    used: list[str] = []
    if "bm25" in active:
        try:
            cov: dict[str, float] = {}
            if BM25_ENGINE == "fts5":
                ranked = _channel_bm25(con, query, allowed, depth, degraded, cov, flt=flt,
                                       texts=texts)
                if not ranked and BM25_MEMORY_FALLBACK:
                    ranked = _channel_bm25_lexical(query, docs, depth, scan)
            else:
                ranked = _channel_bm25_lexical(query, docs, depth, scan)
                if COVERAGE_FUSION and ranked:
                    terms = _coverage_terms(_lex_norm(query))
                    cov = {mid: _query_coverage(texts[mid], terms) for mid, _ in ranked}
            channels["bm25"] = ranked
            if cov:
                coverage["bm25"] = cov
            used.append("bm25")
        except Exception as exc:
            degraded.append("bm25: 通道失败（%s）" % type(exc).__name__)

    if "substring" in active:
        try:
            cov_sub: dict[str, float] = {}
            channels["substring"] = _channel_substring(con, query, allowed, depth, scope_ids,
                                                       cov_sub, texts=texts, scan=scan)
            if cov_sub:
                coverage["substring"] = cov_sub
            used.append("substring")
        except Exception as exc:
            degraded.append("substring: 通道失败（%s）" % type(exc).__name__)

    vecs: dict = {}
    if "vector" in active:
        vinfo: dict = {}
        try:
            ranked, vecs = _channel_vector(store, gw, query, pool, depth, degraded,
                                           sketch=sketch_ok, info=vinfo, con=con)
            if vinfo.get("model"):
                channels["vector"] = ranked
                used.append("vector")
                result["vector_model"] = vinfo["model"]
                result["semantic"] = bool(vinfo.get("semantic"))
        except Exception as exc:
            degraded.append("vector: 通道失败（%s）" % type(exc).__name__)

    if "graph" in active:
        try:
            channels["graph"] = _channel_graph(con, query, scope_ids, depth, allowed)
            used.append("graph")
        except Exception as exc:
            degraded.append("graph: 通道失败（%s）" % type(exc).__name__)

    result["channels_used"] = used
    channels = {name: ranked for name, ranked in channels.items() if ranked}
    coverage = {name: cov for name, cov in coverage.items() if name in channels}
    weights = dict(DEFAULT_WEIGHTS)
    scaled = bool(result["semantic"] and "vector" in channels and SEMANTIC_LEXICAL_SCALE != 1.0)
    if scaled:
        for name in ("bm25", "substring", "graph"):
            weights[name] = weights.get(name, 0.0) * SEMANTIC_LEXICAL_SCALE
    cov_arg = coverage if COVERAGE_FUSION else None
    fused = rrf_fuse(channels, weights, coverage=cov_arg)
    if scaled:
        # 还没有向量的记忆只能靠关键词通道被看到：按原权重计分，不让补算进度决定它能否出现
        lexical = {n: r for n, r in channels.items() if n != "vector"}
        full = rrf_fuse(lexical, DEFAULT_WEIGHTS, coverage=cov_arg)
        for doc_id, item in fused.items():
            if doc_id not in vecs and doc_id in full:
                item["rrf"] = full[doc_id]["rrf"]
    if not fused:
        return finish()

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
        return finish()
    window = ranked_items[:max(limit * 4, 40)]
    for item in window:
        item["score"] = item["rrf"]

    # --- 重排（可选；未配置或失败 = 不重排，保持 RRF 顺序与分数）
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
                result["reranked"] = True
                result["score_kind"] = "rrf+rerank"
            except (TypeError, ValueError, IndexError):
                degraded.append("rerank: 返回格式无法解析；未重排，保持 RRF 顺序")
        else:
            degraded.append("rerank: %s；未重排，保持 RRF 顺序"
                            % (reason or "网关返回空"))
    else:
        degraded.append("rerank: 未配置模型网关；未重排，保持 RRF 顺序")

    items = [_hit(by_id[i["id"]], i["score"], i["channels"], query) for i in window]

    # --- MMR 去冗余
    # 只在"打包上下文"时启用：纯检索场景下同主题的多条记忆本来就都该返回。
    # 冗余度用向量通道的向量；向量通道没跑时用窗口内记忆的本地词形草图（量的是字面重复，
    # 这正是打包时要去掉的东西）。
    if diversify and len(items) > limit:
        mmr_vecs = vecs
        if not mmr_vecs:
            try:
                mmr_vecs = _ensure_vectors(con, [by_id[i["id"]] for i in items])
            except Exception:
                mmr_vecs = {}
        items = _mmr_select(items, mmr_vecs, limit)
    elif len(items) > limit:
        items = items[:limit]

    # --- 预算贪心打包
    packed_tokens = None
    if budget:
        items, packed_tokens = pack_budget(items, int(budget))

    result["hits"] = items
    result["total"] = len(fused)
    result["tokens"] = (packed_tokens if packed_tokens is not None
                        else sum(i["tokens"] for i in items))
    if budget:
        result["budget"] = int(budget)
    return finish()


def digest(store, gw, *, scope="global", budget=1200, task=None, agent_id=None,
           include_secret=False) -> dict:
    """把预算内的记忆打成一段可直接塞进上下文的文本。

    include_secret 默认 False：sensitivity='secret' 的记忆不会被打包给智能体。"""
    started = time.perf_counter()
    degraded: list[str] = []
    budget = int(budget or 0)
    query = (task or "").strip()
    items: list[dict] = []
    if query:
        found = search(store, gw, query, scope=scope, limit=60, budget=None,
                       include_candidates=False, include_secret=include_secret)
        degraded.extend(found.get("degraded") or [])
        items = found.get("hits") or []
    else:
        try:
            con = _connect(store)
            scope_ids = _expand_scope(con, scope)
            pool = _fetch_pool(store, con, scope_ids, False, 500,
                               include_secret=include_secret)
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


def recall_for_agent(store, gw, query, agent_id, scope=None, limit=10,
                     include_secret=False) -> dict:
    """智能体召回：作用域继承 + 写 recall_log（写失败不影响召回）。

    include_secret 默认 False：sensitivity='secret' 的记忆不会召回给智能体。"""
    started = time.perf_counter()
    resolved = scope or ("agent:%s" % agent_id if agent_id else "global")
    result = search(store, gw, query, scope=resolved, limit=limit, strategy="hybrid",
                    include_secret=include_secret)
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
