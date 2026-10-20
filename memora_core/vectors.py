# -*- coding: utf-8 -*-
"""本地确定性哈希草图 + 向量缓存（vector 表）。

hash_embed 是**特征哈希**（feature hashing）：把 1/2/3-gram token 哈希进 256 个桶。
它是一个**词形草图**，不是语义向量 —— 只有字面重叠的文本才会相近，同义改写、跨语言
都不会。memory-eval-v1 test 集上它单独做检索 nDCG@10 只有 0.287、零结果率 0（任何查询都能
"相似"到一批记忆），1.0.0 把它混进融合后默认检索（0.455）比纯关键词（0.550）还差
（python tools/eval_retrieval.py --split test），所以 1.1.0 起它**不再**混进默认 hybrid 融合；
只在显式 strategy=vector（且没有可用 embedding 模型）时使用，并在响应里标成
vector_model='local-hash-256'、semantic=false。判重（dedup.score_pair）与 MMR 去冗余
用它度量"字面有多像"，这正是它擅长的。

    hash_embed(text, dim=256)
      1) 切 token：中文按单字、英文按词边界（正则，不用 Python hash()）
      2) 取 3-gram（token 少于 3 个时退化为 token 本身）
      3) 每个 gram 做 blake2b(digest_size=16)：
           bucket = int(digest[0:8], 'big') % dim
           sign   = +1 / -1   （由 digest[15] 最低位决定）
      4) 带符号累加：v[bucket] += sign * (1 + ln(cf))
      5) L2 归一：v ← v / ||v||₂

对应 data/builtin/algorithms.json 的 char-ngram-hash / cosine 两条。

向量缓存的 model 列：本地草图为 'local-hash-256'；云端 embedding 为
cloud_model_key(provider/model, dim) = 'provider/model@dim'（1.0.0 一律写成常量
'cloud-embed'，换模型/维度后新旧向量被静默混算）。缓存行的 created_at 与
memory.updated_at 同格式（UTC ISO-8601 秒），检索只采信 created_at > updated_at 的向量；
记忆文本改动时调用 forget_owner 主动作废。

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
import time
from array import array
from pathlib import Path

__all__ = [
    "DIM", "MODEL_LOCAL", "tokenize", "grams", "hash_embed", "cosine",
    "estimate_tokens", "VectorIndex", "pack_vec", "unpack_vec",
    "cloud_model_key", "vector_stamp", "cached_vectors", "forget_owner",
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
    """1/2/3-gram token 的特征哈希草图，L2 归一。空文本返回全零向量。

    词形草图，不是语义 embedding：只反映字面重叠。"""
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
    """token 估算：中文字符 ≈ 1 token，非中文 ≈ 4 字符 / token，空白不计。

    粗略启发式，只用于预算打包的量级控制，不用于计费。仓库里没有参考 tokenizer，
    所以它的误差**没有测量过**（1.0.0 文档里的 ±8% / ±15% / 20~25% 无法复现，已撤下）。
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


def vector_stamp() -> str:
    """缓存向量的 created_at：UTC ISO-8601 秒，与 memory.updated_at 同格式，可直接按字符串比较。"""
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def cloud_model_key(label: str, dim: int) -> str:
    """云端 embedding 在 vector 表里的 model 键：'provider/model@dim'。

    1.0.0 把所有云端模型都存成常量 'cloud-embed'：换了模型或维度后，旧向量和新查询向量
    按 min(len) 截断后照样算余弦，结果是无声的垃圾。键里带上模型身份与维度就不会混用。
    """
    label = str(label or "").strip() or "cloud-embed"
    return "%s@%d" % (label, int(dim))


# 进程内向量矩阵缓存：(db 文件, owner_kind, model) → (签名, {owner_id: (array, norm, created_at)})
_MATRIX_CACHE: dict = {}
_MATRIX_CACHE_LIMIT = 8


def _db_key(con: sqlite3.Connection) -> str:
    try:
        for row in con.execute("PRAGMA database_list").fetchall():
            if row[1] == "main":
                return str(row[2] or "") or "memory:%d" % id(con)
    except sqlite3.Error:
        pass
    return "memory:%d" % id(con)


def _forget_cached(con: sqlite3.Connection, owner_kind: str, model: str | None = None) -> None:
    db = _db_key(con)
    for key in list(_MATRIX_CACHE):
        if key[0] == db and key[1] == owner_kind and (model is None or key[2] == model):
            _MATRIX_CACHE.pop(key, None)


def cached_vectors(store, owner_kind: str, model: str) -> dict:
    """一次读出某个 model 的全部缓存向量：{owner_id: (array('f'), norm, created_at)}。

    结果按 (行数, max(rowid), rowid 之和, 最新 created_at) 做签名缓存在进程内，
    向量行不变时下次检索不再逐条 SELECT + 解 BLOB（1.0.0 在 1 万条时为此花 170 ms）。
    本进程内的写入（VectorIndex.put / put_many / forget_owner）会立即作废对应缓存。
    """
    con, owned = _open_store(store)
    try:
        row = con.execute(
            "SELECT count(*), coalesce(max(rowid), 0), coalesce(total(rowid), 0),"
            " coalesce(max(created_at), '') FROM vector WHERE owner_kind=? AND model=?",
            (owner_kind, model)).fetchone()
        signature = (int(row[0]), int(row[1]), float(row[2]), str(row[3]))
        key = (_db_key(con), owner_kind, model)
        cached = _MATRIX_CACHE.get(key)
        if cached is not None and cached[0] == signature:
            return cached[1]
        data: dict = {}
        cur = con.execute("SELECT owner_id, vec, norm, created_at FROM vector"
                          " WHERE owner_kind=? AND model=?", (owner_kind, model))
        for owner_id, blob, norm, created_at in cur:
            arr = array("f")
            arr.frombytes(blob or b"")
            data[str(owner_id)] = (arr, float(norm or 0.0), str(created_at or ""))
        while len(_MATRIX_CACHE) >= _MATRIX_CACHE_LIMIT:
            _MATRIX_CACHE.pop(next(iter(_MATRIX_CACHE)), None)
        _MATRIX_CACHE[key] = (signature, data)
        return data
    finally:
        if owned:
            con.close()


def forget_owner(store, owner_kind: str, owner_id: str, model: str | None = None) -> int:
    """作废某个对象的缓存向量（默认所有 model）。返回作废的行数。

    记忆的 title / body / summary 改动后应调用（store.update_memory），立即释放旧文本的向量。
    检索另外只采信 created_at > memory.updated_at 的向量作为兜底。
    """
    con, owned = _open_store(store)
    try:
        if model:
            cur = con.execute("DELETE FROM vector WHERE owner_kind=? AND owner_id=? AND model=?",
                              (owner_kind, str(owner_id), model))
        else:
            cur = con.execute("DELETE FROM vector WHERE owner_kind=? AND owner_id=?",
                              (owner_kind, str(owner_id)))
        _forget_cached(con, owner_kind, model)
        return int(cur.rowcount or 0)
    finally:
        if owned:
            con.close()


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
            " VALUES(?,?,?,?,?,?,?)",
            (owner_kind, str(owner_id), model, len(vec), pack_vec(vec), norm, vector_stamp()),
        )
        self._cache.pop(owner_kind, None)
        _forget_cached(self.con, owner_kind, model)
        return {"owner_kind": owner_kind, "owner_id": str(owner_id), "model": model,
                "dim": len(vec), "norm": round(norm, 6)}

    def put_many(self, owner_kind: str, pairs, model: str | None = None) -> int:
        """批量写入，一个事务（调用方已在事务里时并入调用方的事务）。"""
        model = model or self.model
        stamp = vector_stamp()
        rows = []
        for owner_id, vec in pairs:
            vec = [float(v) for v in vec]
            norm = math.sqrt(sum(v * v for v in vec))
            rows.append((owner_kind, str(owner_id), model, len(vec), pack_vec(vec), norm, stamp))
        if not rows:
            return 0
        began = False
        if not self.con.in_transaction:
            self.con.execute("BEGIN")
            began = True
        try:
            self.con.executemany(
                "INSERT OR REPLACE INTO vector(owner_kind, owner_id, model, dim, vec, norm,"
                " created_at) VALUES(?,?,?,?,?,?,?)", rows)
            if began:
                self.con.execute("COMMIT")
        except BaseException:
            if began:
                self.con.execute("ROLLBACK")
            raise
        finally:
            self._cache.pop(owner_kind, None)
            _forget_cached(self.con, owner_kind, model)
        return len(rows)

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
