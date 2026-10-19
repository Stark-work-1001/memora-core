# -*- coding: utf-8 -*-
"""本地确定性向量 + TF-IDF + 向量缓存。

为什么要有这个模块：云端 embedding 不可用时，向量通道不能静默失效，否则混合召回
退化成纯关键词检索。这里提供一个**跨进程、跨机器完全稳定**的替代实现：

    hash_embed(text, dim=256)
      1) 切 token：中文按单字、英文按词边界（正则，不用 Python hash()）
      2) 取 3-gram（token 少于 3 个时退化为 token 本身）
      3) 每个 gram 做 blake2b(digest_size=16)：
           bucket = int(digest[0:8], 'big') % dim
           sign   = +1 / -1   （由 digest[15] 最低位决定）
      4) 带符号累加：v[bucket] += sign * (1 + ln(cf))
      5) L2 归一：v ← v / ||v||₂

对应 data/builtin/algorithms.json 的 char-ngram-hash / cosine / tfidf-cosine 三条。

确定性保证：blake2b 与取模都是稳定运算；累加按 gram 字典序进行，因此同一文本在
任何进程、任何机器上得到逐位相同的向量（浮点加法顺序固定）。

estimate_tokens 也放在这里：它是 chunking / retrieval 共用的文本度量，放在最底层的
模块可以避免 chunking ↔ retrieval 的循环 import；retrieval 直接 re-export 它。
"""
from __future__ import annotations

import hashlib
import math
import operator
import re
import sqlite3
from array import array
from pathlib import Path

__all__ = [
    "DIM", "MODEL_LOCAL", "tokenize", "grams", "hash_embed", "cosine",
    "estimate_tokens", "TfidfModel", "VectorIndex", "pack_vec", "unpack_vec",
]

DIM = 256
MODEL_LOCAL = "local-hash-256"
_GRAM_SEP = "\x1f"
# (n, weight)：3-gram 为主，1/2-gram 补稀疏性
NGRAM_SCALES = ((1, 0.5), (2, 0.8), (3, 1.0))

# 中文（含扩展 A/B、日文假名、谚文）逐字成 token；其余语言按词边界。
_CJK = "\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af"
_TOKEN_RE = re.compile(r"[%s]|[A-Za-z][A-Za-z0-9_'\u2019-]*|\d+(?:[.,]\d+)*" % _CJK)
_CJK_CHAR_RE = re.compile(r"[%s]" % _CJK)


# ---------------------------------------------------------------------------
# 分词 / n-gram
# ---------------------------------------------------------------------------

def tokenize(text: str) -> list[str]:
    """确定性分词：中文按字、英文/数字按词边界。标点与空白被丢弃。"""
    if not text:
        return []
    out: list[str] = []
    for match in _TOKEN_RE.finditer(text):
        tok = match.group(0)
        # ASCII 起始 → 英文/数字，统一小写；中文等保持原样
        out.append(tok.lower() if tok[0] < "\u0080" else tok)
    return out


def grams(text: str, n: int = 3) -> list[str]:
    """取 token 级 n-gram。token 数不足 n 时退化为 token 本身（保证短查询可用）。"""
    toks = tokenize(text)
    if not toks:
        return []
    if len(toks) <= n:
        return list(toks)
    return [_GRAM_SEP.join(toks[i:i + n]) for i in range(len(toks) - n + 1)]


def scaled_grams(text: str) -> list[tuple[str, float]]:
    """多尺度 n-gram：1/2/3-gram 带权，3-gram 为主（权重 1.0），1/2-gram 只用来补
    短文本与改写场景的稀疏性。这是对纯 3-gram 公式的有意增强，理由见 docs/retrieval.md：
    纯 3-gram 在"同一概念换个说法"时窗口完全错位，相似度会掉到 0。
    """
    toks = tokenize(text)
    if not toks:
        return []
    out: list[tuple[str, float]] = []
    for n, weight in NGRAM_SCALES:
        if n == 1:
            out.extend((t, weight) for t in toks)
        elif len(toks) >= n:
            out.extend((_GRAM_SEP.join(toks[i:i + n]), weight)
                       for i in range(len(toks) - n + 1))
    return out


# ---------------------------------------------------------------------------
# 哈希向量
# ---------------------------------------------------------------------------

def _bucket_sign(gram: str, dim: int) -> tuple[int, float]:
    digest = hashlib.blake2b(gram.encode("utf-8"), digest_size=16).digest()
    bucket = int.from_bytes(digest[:8], "big") % dim
    sign = 1.0 if (digest[15] & 1) else -1.0
    return bucket, sign


def hash_embed(text: str, dim: int = DIM) -> list[float]:
    """字符/token 3-gram 哈希向量，L2 归一。空文本返回全零向量。"""
    if dim <= 0:
        raise ValueError("dim must be positive")
    vec = [0.0] * dim
    if not text:
        return vec
    counts: dict[str, float] = {}
    for gram, weight in scaled_grams(text):
        counts[gram] = counts.get(gram, 0.0) + weight
    if not counts:
        return vec
    # 按字典序累加，保证浮点加法顺序与输入写入顺序无关 → 跨进程逐位一致
    for gram in sorted(counts):
        bucket, sign = _bucket_sign(gram, dim)
        vec[bucket] += sign * (1.0 + math.log(counts[gram]))
    norm = math.sqrt(sum(v * v for v in vec))
    if norm <= 0.0:
        return vec
    return [v / norm for v in vec]


def cosine(a, b) -> float:
    """余弦相似度。任一为空/全零时返回 0.0。"""
    if a is None or b is None:
        return 0.0
    n = min(len(a), len(b))
    if n == 0:
        return 0.0
    dot = 0.0
    na = 0.0
    nb = 0.0
    for i in range(n):
        x = a[i]
        y = b[i]
        dot += x * y
        na += x * x
        nb += y * y
    if na <= 0.0 or nb <= 0.0:
        return 0.0
    return dot / (math.sqrt(na) * math.sqrt(nb))


# ---------------------------------------------------------------------------
# token 估算
# ---------------------------------------------------------------------------

def estimate_tokens(text: str) -> int:
    """token 估算：中文字符 ≈ 1 token，非中文 ≈ 4 字符 / token。

    实测口径（见 docs/retrieval.md）：中文段落误差约 ±8%，中英混排 ±15%，
    纯英文技术文本（含大量符号/代码）可低估 20%~25%。用途是预算打包的上界控制，
    不用于精确计费。
    """
    if not text:
        return 0
    cjk = len(_CJK_CHAR_RE.findall(text))
    rest = max(0, len(text) - cjk)
    # 空白不占 token
    rest -= text.count(" ") + text.count("\n") + text.count("\t")
    rest = max(0, rest)
    return max(1, int(round(cjk + rest / 4.0)))


# ---------------------------------------------------------------------------
# TF-IDF（语料内统计）
# ---------------------------------------------------------------------------

class TfidfModel:
    """语料内 TF-IDF 余弦模型。用于同义词不敏感、但术语重叠有效的离线相似度。

        m = TfidfModel().fit([...docs...])
        m.similarity("a", "b")        # → float
        m.top_terms("a", k=8)         # → [(term, weight)]
    """

    def __init__(self, ngram: tuple[int, int] = (1, 2)):
        self.ngram = ngram
        self.idf: dict[str, float] = {}
        self.docs = 0
        self._terms: list[set[str]] = []

    # -- 内部 ----------------------------------------------------------------
    def _terms_of(self, text: str) -> list[str]:
        toks = tokenize(text)
        lo, hi = self.ngram
        out: list[str] = []
        for n in range(max(1, lo), max(1, hi) + 1):
            if len(toks) < n:
                continue
            if n == 1:
                out.extend(toks)
            else:
                out.extend(_GRAM_SEP.join(toks[i:i + n]) for i in range(len(toks) - n + 1))
        return out

    # -- 训练/推理 -----------------------------------------------------------
    def fit(self, docs) -> "TfidfModel":
        df: dict[str, int] = {}
        self._terms = []
        n = 0
        for doc in docs:
            terms = set(self._terms_of(doc))
            self._terms.append(terms)
            for term in terms:
                df[term] = df.get(term, 0) + 1
            n += 1
        self.docs = n
        self.idf = {t: math.log((1 + n) / (1 + c)) + 1.0 for t, c in df.items()}
        return self

    def transform(self, text: str) -> dict[str, float]:
        """→ {term: tf-idf 权重}，已 L2 归一。"""
        terms = self._terms_of(text)
        if not terms:
            return {}
        tf: dict[str, int] = {}
        for term in terms:
            tf[term] = tf.get(term, 0) + 1
        unknown_idf = math.log((1 + self.docs) / 1.0) + 1.0 if self.docs else 1.0
        out: dict[str, float] = {}
        for term, count in tf.items():
            weight = (1.0 + math.log(count)) * self.idf.get(term, unknown_idf)
            out[term] = weight
        norm = math.sqrt(sum(w * w for w in out.values()))
        if norm > 0:
            out = {t: w / norm for t, w in out.items()}
        return out

    def similarity(self, a: str, b: str) -> float:
        va = self.transform(a)
        vb = self.transform(b)
        if not va or not vb:
            return 0.0
        if len(va) > len(vb):
            va, vb = vb, va
        return sum(w * vb.get(t, 0.0) for t, w in va.items())

    def top_terms(self, text: str, k: int = 8) -> list[tuple[str, float]]:
        vec = self.transform(text)
        return sorted(vec.items(), key=lambda kv: -kv[1])[:k]

    def to_dict(self) -> dict:
        return {"ngram": list(self.ngram), "docs": self.docs, "idf": self.idf}

    @classmethod
    def from_dict(cls, data: dict) -> "TfidfModel":
        model = cls(tuple(data.get("ngram") or (1, 2)))
        model.docs = int(data.get("docs") or 0)
        model.idf = dict(data.get("idf") or {})
        return model


# ---------------------------------------------------------------------------
# 向量序列化
# ---------------------------------------------------------------------------

def pack_vec(vec) -> bytes:
    """list[float] → float32 little-endian BLOB。"""
    return array("f", [float(v) for v in vec]).tobytes()


def unpack_vec(blob: bytes) -> list[float]:
    if not blob:
        return []
    arr = array("f")
    arr.frombytes(blob)
    return list(arr)


# ---------------------------------------------------------------------------
# 向量缓存（vector 表）
# ---------------------------------------------------------------------------

def _open_store(store):
    """兼容 sqlite3.Connection / Store 对象 / db 路径，返回 (con, 是否自持)。"""
    from . import db as _db

    if isinstance(store, sqlite3.Connection):
        return store, False
    for attr in ("con", "conn", "connection"):
        con = getattr(store, attr, None)
        if isinstance(con, sqlite3.Connection):
            return con, False
    for attr in ("db_path", "db", "path"):
        value = getattr(store, attr, None)
        if isinstance(value, sqlite3.Connection):
            return value, False
        if isinstance(value, (str, Path)):
            return _db.connect(value), True
    if isinstance(store, (str, Path)):
        return _db.connect(store), True
    raise TypeError("VectorIndex 需要 sqlite3.Connection / Store / db 路径，收到 %r" % type(store))


class VectorIndex:
    """vector 表的读写封装 + 纯 Python 线性最近邻。

    - put: 归一化后写 float32 BLOB（norm 也落库，重算时可校验）
    - get: 读回 list[float]
    - nearest: 稀疏点积线性扫描；矩阵按 (model, count, max(rowid)) 做进程内缓存，
      批量查询时只解一次 BLOB。
    """

    def __init__(self, store, model: str = MODEL_LOCAL):
        self.store = store
        self.model = model
        self.con, self._owned = _open_store(store)
        self._cache: dict[str, tuple] = {}

    # -- 生命周期 ------------------------------------------------------------
    def close(self) -> None:
        if self._owned and self.con is not None:
            try:
                self.con.close()
            finally:
                self.con = None

    def __enter__(self) -> "VectorIndex":
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    # -- 写 ----------------------------------------------------------------
    def put(self, owner_kind: str, owner_id: str, vec, model: str | None = None) -> dict:
        model = model or self.model
        vec = [float(v) for v in vec]
        norm = math.sqrt(sum(v * v for v in vec))
        self.con.execute(
            "INSERT OR REPLACE INTO vector(owner_kind, owner_id, model, dim, vec, norm, created_at)"
            " VALUES(?,?,?,?,?,?, datetime('now'))",
            (owner_kind, str(owner_id), model, len(vec), pack_vec(vec), norm),
        )
        self._cache.pop(owner_kind, None)
        return {"owner_kind": owner_kind, "owner_id": str(owner_id), "model": model,
                "dim": len(vec), "norm": round(norm, 6)}

    def put_many(self, owner_kind: str, pairs, model: str | None = None) -> int:
        model = model or self.model
        n = 0
        for owner_id, vec in pairs:
            self.put(owner_kind, owner_id, vec, model)
            n += 1
        return n

    # -- 读 ----------------------------------------------------------------
    def get(self, owner_kind: str, owner_id: str, model: str | None = None):
        if model:
            row = self.con.execute(
                "SELECT vec FROM vector WHERE owner_kind=? AND owner_id=? AND model=?",
                (owner_kind, str(owner_id), model)).fetchone()
            return unpack_vec(row[0]) if row else None
        rows = self.con.execute(
            "SELECT model, vec FROM vector WHERE owner_kind=? AND owner_id=?",
            (owner_kind, str(owner_id))).fetchall()
        if not rows:
            return None
        for want in (self.model, MODEL_LOCAL):
            for name, blob in rows:
                if name == want:
                    return unpack_vec(blob)
        return unpack_vec(rows[0][1])

    # -- 检索 --------------------------------------------------------------
    def _matrix(self, owner_kind: str, model: str | None):
        model = model or self.model
        row = self.con.execute(
            "SELECT count(*), coalesce(max(rowid), 0) FROM vector WHERE owner_kind=? AND model=?",
            (owner_kind, model)).fetchone()
        signature = (model, int(row[0]), int(row[1]))
        cached = self._cache.get(owner_kind)
        if cached and cached[0] == signature:
            return cached[1], cached[2]
        ids: list[str] = []
        mats: list[array] = []
        cur = self.con.execute(
            "SELECT owner_id, vec FROM vector WHERE owner_kind=? AND model=? ORDER BY owner_id",
            (owner_kind, model))
        for owner_id, blob in cur:
            arr = array("f")
            arr.frombytes(blob)
            ids.append(str(owner_id))
            mats.append(arr)
        self._cache[owner_kind] = (signature, ids, mats)
        return ids, mats

    def nearest(self, vec, owner_kind: str = "memory", limit: int = 20,
                model: str | None = None, allowed_ids=None):
        """线性扫描取 top-limit 余弦（向量入库时已 L2 归一，余弦=点积）。"""
        if vec is None or limit <= 0:
            return []
        ids, mats = self._matrix(owner_kind, model)
        if not ids:
            return []
        pairs = [(i, float(w)) for i, w in enumerate(vec) if w]
        if not pairs:
            return []
        dim = len(vec)
        pairs = [(i, w) for i, w in pairs if i < dim]
        idx = [i for i, _ in pairs]
        weights = [w for _, w in pairs]
        single = len(idx) == 1
        getter = operator.itemgetter(*idx)
        mul = operator.mul
        out: list[tuple[str, float]] = []
        for pos, mat in enumerate(mats):
            if len(mat) < dim:
                continue
            if allowed_ids is not None and ids[pos] not in allowed_ids:
                continue
            if single:
                score = getter(mat) * weights[0]
            else:
                score = math.fsum(map(mul, getter(mat), weights))
            if score > 1e-9:
                out.append((ids[pos], score))
        out.sort(key=lambda kv: (-kv[1], kv[0]))
        return out[:limit]

    # -- 统计 --------------------------------------------------------------
    def stats(self) -> dict:
        rows = self.con.execute(
            "SELECT owner_kind, model, count(*) AS n, sum(dim) AS dims, sum(length(vec)) AS bytes"
            " FROM vector GROUP BY owner_kind, model ORDER BY owner_kind, model").fetchall()
        items = [{"owner_kind": r[0], "model": r[1], "count": int(r[2]),
                  "avg_dim": round((r[3] or 0) / max(1, int(r[2])), 1), "bytes": int(r[4] or 0)}
                 for r in rows]
        return {"items": items, "total": sum(i["count"] for i in items),
                "bytes": sum(i["bytes"] for i in items)}
