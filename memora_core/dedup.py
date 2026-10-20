# -*- coding: utf-8 -*-
"""分层判重与动作决策。

三通道加权（对应 algorithms.json 的 simhash / jaccard-shingle / cosine）：

    dup = 0.5·cos + 0.3·jaccard + 0.2·(1 − hamming/64）

分层：
    dup ≥ 0.92        → band='merge'   自动合并候选
    0.80 ≤ dup < 0.92 → band='judge'   交判定层（LLM judge 或规则）
    dup < 0.80        → band='new'     视为新记忆

动作链（decide_action，按顺序短路）：

  R0  candidate 无有效文本                        → add（空内容不入库，理由写清楚）
  R1  无邻居                                      → add
  R2  归一化文本完全相同，或 dup ≥ 0.92 且不构成"更新" → noop（target=旧记忆）
  R3  dup ≥ 0.92 且构成更新（新证据更强/显式 supersedes）→ merge（保留双方内容）
  R4  冲突分 ≥ 0.50（CONFLICT_ASK）：
        R4a 新证据更强（trust/confidence/来源数占优）→ supersede
        R4b 否则                                    → ask
  R5  0.80 ≤ dup < 0.92：
        R5a 新覆盖旧（旧被新蕴含，或新带更新词且时间更晚）→ supersede
        R5b 互补（互不蕴含且主题重叠 0.2~0.7）          → merge
        R5c 否则                                        → update
  R6  dup < 0.80 但同主题（topic_overlap ≥ 0.30 且 cos ≥ 0.45）：
        R6a 冲突且证据不足 → ask
        R6b 新覆盖旧      → supersede
        R6c 互补          → merge
        R6d 否则          → link
  R7  其余                                          → add

"互补"= 互不蕴含且各自都有对方没有的内容；"覆盖"= 旧文本的实词基本被新文本包含。
"""
from __future__ import annotations

import hashlib
import math
import re
import sqlite3

from . import db as _db
from .vectors import cosine, hash_embed, tokenize

__all__ = [
    "simhash64", "hamming", "shingles", "jaccard", "norm_text", "term_set",
    "score_pair", "conflict_score", "decide_action", "find_duplicates",
    "THRESHOLD_MERGE", "THRESHOLD_JUDGE", "DUP_WEIGHTS",
]

THRESHOLD_MERGE = 0.92
THRESHOLD_JUDGE = 0.80
DUP_WEIGHTS = {"cos": 0.5, "jac": 0.3, "ham": 0.2}
CONFLICT_ASK = 0.50            # 0.4·实体重叠 + 0.35·极性反转 + 0.25·数值矛盾
RELATED_SHARED_TERMS = 3      # 共享实词数 ≥3 视为"同一主题"
TOPIC_OVERLAP_LINK = 0.25     # 或 Jaccard(实词) ≥0.25
MERGE_OVERLAP = 0.28          # 主题重叠到这条线以上直接合并
SUBSUME_RATIO = 0.85
HAM_BITS = 64

_CJK_CLASS = "\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af"
_ASCII_TOKEN_RE = re.compile(r"[A-Za-z][A-Za-z0-9_'-]*|\d+(?:[.,]\d+)*")
_CJK_RUN_RE = re.compile("[%s]+" % _CJK_CLASS)
_NUMBER_RE = re.compile(r"-?\d+(?:\.\d+)?")
_NEGATIONS = ("不", "没", "无", "未", "别", "非", "禁止", "不支持", "不能",
              "not ", "no ", "never", "cannot", "can't", "don't", "doesn't", "isn't")
_UPDATE_WORDS = ("更新", "改为", "改成", "调整为", "变更为", "现在", "目前", "不再",
                 "替代", "取代", "已改", "已修正", "反之", "updated", "changed to",
                 "now ", "instead", "replaced", "renamed", "deprecated")
_STOPWORDS = {
    "the", "a", "an", "of", "to", "in", "on", "for", "and", "or", "is", "are", "was",
    "were", "be", "with", "by", "as", "at", "from", "that", "this", "it", "we", "i",
    "的", "了", "是", "在", "和", "与", "也", "就", "都", "而", "及", "或", "把", "被",
    "一个", "我们", "他们", "这个", "那个",
}


# ---------------------------------------------------------------------------
# 归一化
# ---------------------------------------------------------------------------

def norm_text(text: str) -> str:
    """小写 + 去标点 + 折叠空白。用于"完全相同"判断与 shingle。"""
    if not text:
        return ""
    text = text.lower()
    text = re.sub(r"[\s\u3000]+", " ", text)
    text = re.sub(r"[^\w%s]+" % _CJK_CLASS, " ", text)
    return re.sub(r"\s+", " ", text).strip()


def term_set(text: str) -> set[str]:
    """实词集合：ASCII 词（≥2 字符）+ 中文二元组。判"同主题/覆盖/互补"用。"""
    out: set[str] = set()
    for tok in _ASCII_TOKEN_RE.findall(text or ""):
        low = tok.lower()
        if len(low) >= 2 and low not in _STOPWORDS:
            out.add(low)
    for run in _CJK_RUN_RE.findall(text or ""):
        for i in range(max(1, len(run) - 1)):
            gram = run[i:i + 2]
            if gram not in _STOPWORDS:
                out.add(gram)
    return out


def _numbers(text: str) -> set[str]:
    return set(_NUMBER_RE.findall(text or ""))


def _has_negation(text: str) -> bool:
    low = (text or "").lower()
    return any(marker in low for marker in _NEGATIONS)


# 分句：中文标点 / 英文句号 / 逗号都要切，否则"读不阻塞写"会被误判成整句否定
_CLAUSE_RE = re.compile(r"[,，。.;；!！?？\n]+")


def _clause_polarity(text: str) -> dict[str, bool]:
    """→ {子句实词指纹: 是否含否定}。用于逐子句比极性，而不是整篇比。"""
    out: dict[str, bool] = {}
    for clause in _CLAUSE_RE.split(text or ""):
        terms = term_set(clause)
        if len(terms) < 2:
            continue
        key = "|".join(sorted(terms))
        out[key] = _has_negation(clause)
    return out


def _polarity_flip(new_text: str, old_text: str) -> float:
    """同一件事（共享实词 ≥50%）出现相反极性 → 1.0。"""
    def terms_of(clause: str) -> set[str]:
        return term_set(clause)

    flips = 0
    compared = 0
    for new_clause, new_neg in _clause_polarity(new_text).items():
        new_terms = set(new_clause.split("|"))
        for old_clause, old_neg in _clause_polarity(old_text).items():
            old_terms = set(old_clause.split("|"))
            inter = new_terms & old_terms
            if len(inter) < 2:
                continue
            # 用"包含度"而不是 Jaccard：一边是短句、一边是长句时 Jaccard 会被稀释，
            # 而"SQLite 使用 WAL 模式" ⊂ "SQLite 使用 WAL 模式保证并发读写性能" 正是要抓的情形。
            containment = max(len(inter) / len(new_terms), len(inter) / len(old_terms))
            if containment < 0.6:
                continue
            compared += 1
            if new_neg != old_neg:
                flips += 1
    if not compared:
        return 0.0
    return 1.0 if flips else 0.0


def _has_update_word(text: str) -> bool:
    low = (text or "").lower()
    return any(word in low for word in _UPDATE_WORDS)


# ---------------------------------------------------------------------------
# SimHash
# ---------------------------------------------------------------------------

def _token_weights(text: str) -> dict[str, float]:
    counts: dict[str, float] = {}
    for tok in tokenize(text):
        counts[tok] = counts.get(tok, 0.0) + 1.0
    # 中文二元组权重更低，避免单字噪声主导
    for run in _CJK_RUN_RE.findall(text or ""):
        for i in range(max(1, len(run) - 1)):
            gram = run[i:i + 2]
            counts[gram] = counts.get(gram, 0.0) + 0.5
    return counts


def simhash64(text: str) -> int:
    """64 位指纹：每个 token 的 blake2b 64 位哈希按权重投票，逐位取符号。"""
    weights = _token_weights(text or "")
    if not weights:
        return 0
    acc = [0.0] * HAM_BITS
    for token in sorted(weights):
        weight = weights[token]
        digest = hashlib.blake2b(token.encode("utf-8"), digest_size=8).digest()
        value = int.from_bytes(digest, "big")
        for bit in range(HAM_BITS):
            if value >> bit & 1:
                acc[bit] += weight
            else:
                acc[bit] -= weight
    out = 0
    for bit in range(HAM_BITS):
        if acc[bit] > 0:
            out |= 1 << bit
    return out


def hamming(a: int, b: int) -> int:
    return bin((a ^ b) & ((1 << HAM_BITS) - 1)).count("1")


# ---------------------------------------------------------------------------
# Shingle / Jaccard
# ---------------------------------------------------------------------------

def shingles(text: str, k: int = 5) -> set[str]:
    """字符级 k-gram shingle（对中文与英文都稳定）。文本过短时整体作为一个 shingle。"""
    normalized = norm_text(text).replace(" ", "")
    if not normalized:
        return set()
    if len(normalized) <= k:
        return {normalized}
    return {normalized[i:i + k] for i in range(len(normalized) - k + 1)}


def jaccard(a, b) -> float:
    """两个集合（或两段文本）的 Jaccard。"""
    if isinstance(a, str):
        a = shingles(a)
    if isinstance(b, str):
        b = shingles(b)
    if not a or not b:
        return 0.0
    inter = len(a & b)
    union = len(a | b)
    return inter / union if union else 0.0


# ---------------------------------------------------------------------------
# 三通道打分
# ---------------------------------------------------------------------------

def _band(dup: float) -> str:
    if dup >= THRESHOLD_MERGE:
        return "merge"
    if dup >= THRESHOLD_JUDGE:
        return "judge"
    return "new"


def score_pair(new_text: str, old_text: str, new_vec=None, old_vec=None) -> dict:
    """三通道加权重复度 → {cos, jac, ham, dup, band}。"""
    vec_a = new_vec if new_vec is not None else hash_embed(new_text or "")
    vec_b = old_vec if old_vec is not None else hash_embed(old_text or "")
    cos = cosine(vec_a, vec_b)
    jac = jaccard(new_text, old_text)
    ham = hamming(simhash64(new_text or ""), simhash64(old_text or ""))
    dup = (DUP_WEIGHTS["cos"] * cos
           + DUP_WEIGHTS["jac"] * jac
           + DUP_WEIGHTS["ham"] * (1.0 - ham / float(HAM_BITS)))
    return {
        "cos": round(cos, 6),
        "jac": round(jac, 6),
        "ham": int(ham),
        "dup": round(dup, 6),
        "band": _band(dup),
    }


# ---------------------------------------------------------------------------
# 冲突
# ---------------------------------------------------------------------------

def conflict_score(new_text: str, old_text: str) -> dict:
    """c = 0.4·entity_overlap + 0.35·polarity_flip + 0.25·numeric_conflict。"""
    ta, tb = term_set(new_text), term_set(old_text)
    union = ta | tb
    overlap = (len(ta & tb) / len(union)) if union else 0.0
    # 只在"讲的是同一件事"时才算极性冲突，且必须逐子句比对
    polarity = _polarity_flip(new_text, old_text) if overlap >= 0.20 else 0.0
    na, nb = _numbers(new_text), _numbers(old_text)
    numeric = 1.0 if (na and nb and not (na & nb) and overlap >= 0.25) else 0.0
    score = 0.4 * overlap + 0.35 * polarity + 0.25 * numeric
    return {"score": round(score, 6), "entity_overlap": round(overlap, 6),
            "polarity_flip": polarity, "numeric_conflict": numeric}


def _subsumes(a_terms: set[str], b_terms: set[str], ratio: float = SUBSUME_RATIO) -> bool:
    """a 是否基本包含 b 的内容（b 的实词有 ratio 比例出现在 a 里）。"""
    if not b_terms:
        return False
    return len(b_terms & a_terms) / len(b_terms) >= ratio


def _combine(candidate: dict) -> str:
    parts = [candidate.get("title") or "", candidate.get("body") or ""]
    if not any(parts) and candidate.get("text"):
        return str(candidate["text"])
    return "\n".join(p for p in parts if p)


def _evidence_strength(item: dict) -> float:
    """证据强度：trust 为主，confidence 与来源数加权。"""
    trust = float(item.get("trust") or 0.5)
    confidence = float(item.get("confidence") or 0.5)
    sources = float(item.get("source_count") or len(item.get("evidence") or []) or 0)
    return trust * 0.6 + confidence * 0.3 + min(sources, 5.0) / 5.0 * 0.1


# ---------------------------------------------------------------------------
# 动作决策
# ---------------------------------------------------------------------------

def decide_action(candidate: dict, neighbors: list[dict]) -> dict:
    """返回 {action, reason, target_id, band, dup, signals}。

    candidate: {title, body, text, trust, confidence, recorded_at, valid_from,
                source_count, evidence, supersedes}
    neighbors: [{id, title, body, text, dup, cos, jac, ham, trust, ...}]（已按 dup 降序更佳）
    """
    text = _combine(candidate)
    result = {"action": "add", "reason": "", "target_id": None, "band": "new",
              "dup": 0.0, "confidence": 0.0, "signals": {}}
    if not norm_text(text):
        result["reason"] = "候选内容为空，不进入判重，直接 reject 候选（add 后由审核层丢弃）"
        result["action"] = "ask"
        result["confidence"] = 0.0
        return result
    if not neighbors:
        result["reason"] = "无邻居记忆，视为全新"
        result["confidence"] = 0.95
        return result

    ranked = sorted(neighbors, key=lambda n: -float(n.get("dup") or 0.0))
    best = ranked[0]
    best_text = _combine(best)
    dup = float(best.get("dup") or 0.0)
    band = best.get("band") or _band(dup)
    c_terms, b_terms = term_set(text), term_set(best_text)
    conflict = conflict_score(text, best_text)
    union = c_terms | b_terms
    uniq_new = len(c_terms - b_terms) / len(union) if union else 0.0
    uniq_old = len(b_terms - c_terms) / len(union) if union else 0.0
    # 各自"独有的部分"占自己实词的比例 —— 判断是否只是换个说法
    novelty_new = len(c_terms - b_terms) / len(c_terms) if c_terms else 0.0
    novelty_old = len(b_terms - c_terms) / len(b_terms) if b_terms else 0.0
    signals = {
        "dup": round(dup, 6), "cos": float(best.get("cos") or 0.0),
        "jac": float(best.get("jac") or 0.0), "ham": int(best.get("ham") or 0),
        "topic_overlap": round(len(c_terms & b_terms) / len(union), 6) if union else 0.0,
        "shared_terms": len(c_terms & b_terms),
        "uniq_new": round(uniq_new, 6),
        "uniq_old": round(uniq_old, 6),
        "novelty_new": round(novelty_new, 6),
        "novelty_old": round(novelty_old, 6),
        "conflict": conflict,
        "new_covers_old": _subsumes(c_terms, b_terms),
        "old_covers_new": _subsumes(b_terms, c_terms),
        "update_word": _has_update_word(text),
        "evidence_new": round(_evidence_strength(candidate), 4),
        "evidence_old": round(_evidence_strength(best), 4),
    }
    result["signals"] = signals
    result["band"] = band
    result["dup"] = round(dup, 6)
    result["target_id"] = best.get("id")
    explicit_supersede = bool(candidate.get("supersedes")) or (
        candidate.get("supersedes") == best.get("id"))

    # R2: 完全重复
    if norm_text(text) == norm_text(best_text):
        result.update(action="noop", confidence=0.99,
                      reason="归一化文本完全相同，丢弃重复写入")
        return result

    # R2/R3: 高重复带
    if dup >= THRESHOLD_MERGE:
        if explicit_supersede or signals["evidence_new"] > signals["evidence_old"] + 0.08:
            result.update(action="merge", confidence=0.85,
                          reason="重复度 %.3f 且新候选证据更强，合并为一条并保留双方表述" % dup)
        else:
            result.update(action="noop", confidence=0.9,
                          reason="重复度 %.3f ≥ %.2f，视为已存在" % (dup, THRESHOLD_MERGE))
        return result

    # R4: 冲突（在任何"合并/落库"之前裁决，避免把矛盾静默合并掉）
    if conflict["score"] >= CONFLICT_ASK:
        if explicit_supersede or signals["evidence_new"] > signals["evidence_old"] + 0.1:
            result.update(action="supersede", confidence=0.7,
                          reason="冲突分 %.3f 且新证据更强（%.2f > %.2f），标记旧记忆被取代"
                                 % (conflict["score"], signals["evidence_new"],
                                    signals["evidence_old"]))
        else:
            result.update(action="ask", confidence=0.4,
                          reason="冲突分 %.3f 但证据不足以裁决，交判定层/人工"
                                 % conflict["score"])
        return result

    # R5: 判定带（同一条记忆的不同表述）
    if dup >= THRESHOLD_JUDGE:
        if signals["new_covers_old"] and not signals["old_covers_new"]:
            result.update(action="supersede", confidence=0.72,
                          reason="重复度 %.3f，新内容覆盖旧内容（旧实词被新包含）" % dup)
        elif signals["update_word"] and not signals["old_covers_new"]:
            result.update(action="supersede", confidence=0.68,
                          reason="重复度 %.3f 且带更新语义（改为/现在/不再…），新值取代旧值" % dup)
        elif signals["new_covers_old"] and signals["old_covers_new"]:
            result.update(action="merge", confidence=0.75,
                          reason="重复度 %.3f 且互相蕴含，合并为一条并补充来源" % dup)
        elif signals["uniq_new"] >= 0.20 and signals["uniq_old"] >= 0.20:
            result.update(action="merge", confidence=0.7,
                          reason="重复度 %.3f 但双方各有独有内容（%.2f / %.2f），合并保留互补信息"
                                 % (dup, signals["uniq_new"], signals["uniq_old"]))
        else:
            result.update(action="update", confidence=0.6,
                          reason="重复度 %.3f，作为同一条记忆的细化并入（更新 body）" % dup)
        return result

    # R6: 低重复但同主题（共享实词 ≥3 或主题重叠 ≥0.25）
    if signals["shared_terms"] >= RELATED_SHARED_TERMS or \
            signals["topic_overlap"] >= TOPIC_OVERLAP_LINK:
        if signals["new_covers_old"] and not signals["old_covers_new"]:
            result.update(action="supersede", confidence=0.6,
                          reason="同主题（共享 %d 个实词）且新内容覆盖旧内容（重复度 %.3f）"
                                 % (signals["shared_terms"], dup))
        elif signals["update_word"] and not signals["old_covers_new"]:
            result.update(action="supersede", confidence=0.58,
                          reason="同主题（共享 %d 个实词）且带更新语义，新值取代旧值"
                                 % signals["shared_terms"])
        elif (dup >= 0.50 or signals["topic_overlap"] >= MERGE_OVERLAP
              or (signals["novelty_new"] >= 0.40 and signals["novelty_old"] >= 0.40
                  and dup >= 0.35)) and not conflict["polarity_flip"]:
            result.update(action="merge", confidence=0.58,
                          reason="同主题（共享 %d 个实词、重复度 %.3f、主题重叠 %.2f），"
                                 "合并成一条更完整的记忆"
                                 % (signals["shared_terms"], dup, signals["topic_overlap"]))
        else:
            result.update(action="link", confidence=0.6,
                          reason="共享 %d 个实词（主题重叠 %.2f）但讲的是不同侧面，"
                                 "建立语义关系边而非合并"
                                 % (signals["shared_terms"], signals["topic_overlap"]))
        return result

    # R7
    result.update(action="add", confidence=0.85,
                  reason="与最近邻仅共享 %d 个实词、重复度 %.3f，视为新记忆"
                         % (signals["shared_terms"], dup))
    return result


# ---------------------------------------------------------------------------
# 邻居检索
# ---------------------------------------------------------------------------

def _connect(store) -> sqlite3.Connection:
    from .retrieval import _connect as _c
    return _c(store)


DEDUP_PREFILTER = 200          # 池超过这么多条时，只对字面预筛出的候选做三通道全量打分


def find_duplicates(store, candidate: dict, limit: int = 10) -> list[dict]:
    """在库里找 candidate 的近似重复，按 dup 降序返回。

    候选池 = 作用域内全部 approved + candidate 记忆（含 secret：判重必须看到一切）。
    1.0.0 给 Store 时池被 Store.list_memories 的 500 条上限截断（更早的完全重复判不出来），
    给连接时截在 5000。现在不截断；池大于 DEDUP_PREFILTER 时先做字面预筛
    （规范化全文完全相同的一条不漏 + 切分 BM25 前 max(10·limit, 200) 名），再逐条打分。
    """
    from .retrieval import POOL_CAP, _expand_scope, _fetch_pool, lexical_candidates

    text = _combine(candidate)
    if not norm_text(text):
        return []
    con = _connect(store)
    scope_id = candidate.get("scope_id")
    scope_ids = _expand_scope(con, scope_id) if scope_id else None
    pool = _fetch_pool(store, con, scope_ids, True, POOL_CAP, include_secret=True)
    if len(pool) > DEDUP_PREFILTER:
        pool = lexical_candidates(pool, text, max(limit * 10, DEDUP_PREFILTER))
    new_vec = hash_embed(text)
    out: list[dict] = []
    for memory in pool:
        if candidate.get("id") and memory["id"] == candidate.get("id"):
            continue
        old_text = _combine(memory)
        if not norm_text(old_text):
            continue
        scored = score_pair(text, old_text, new_vec=new_vec)
        if scored["dup"] <= 0.05:
            continue
        scored.update({
            "id": memory["id"],
            "title": memory.get("title") or "",
            "status": memory.get("status"),
            "scope_id": memory.get("scope_id"),
            "trust": memory.get("trust"),
            "recorded_at": memory.get("recorded_at"),
        })
        out.append(scored)
    out.sort(key=lambda item: (-item["dup"], item["id"]))
    return out[:limit]


def apply_decision(store, candidate: dict, decision: dict) -> dict:
    """把 decide_action 的结果落成 candidate 表的 payload（不改变记忆本身）。"""
    con = _connect(store)
    cid = candidate.get("id") or hashlib.blake2b(
        (norm_text(_combine(candidate)) + _db.now()).encode("utf-8"),
        digest_size=12).hexdigest()
    status = "needs_review" if decision["action"] == "ask" else "pending"
    try:
        con.execute(
            "INSERT OR REPLACE INTO candidate(id, scope_id, action, target_id, payload,"
            " dedup, judge, status, created_at) VALUES(?,?,?,?,?,?,?,?,?)",
            (cid, candidate.get("scope_id") or "global", decision["action"],
             decision.get("target_id"),
             _db.dumps({k: candidate.get(k) for k in ("title", "body", "kind")}),
             _db.dumps(decision.get("signals") or {}),
             _db.dumps({"reason": decision.get("reason"), "confidence": decision.get("confidence")}),
             status, _db.now()))
    except sqlite3.Error:
        return {"ok": False, "id": cid, "error": "candidate 写入失败"}
    return {"ok": True, "id": cid, "status": status, "action": decision["action"]}
