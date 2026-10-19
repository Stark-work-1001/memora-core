# -*- coding: utf-8 -*-
"""判定层：分类 / 查重裁决 / 冲突裁决 / 断言核验 / 摘要 / 抽象线索。

**规则**：每个函数都是「先试 LLM，失败走确定性规则兜底」，返回值里永远带
degraded 与 reason。绝不伪造：LLM 说成功了就按 LLM 的结论，失败就明说降级。

提示词来自 memora_core/data/builtin/prompts.json，用 {{var}} 渲染。
"""

from __future__ import annotations

import json
import re

from .models import (
    JudgeFormatError,
    ModelUnavailable,
    load_prompt,
    render_prompt,
)

__all__ = [
    "KINDS",
    "classify",
    "dedup_verdict",
    "conflict_verdict",
    "verify_claims",
    "summarize",
    "abstraction_cues",
    "rule_classify",
    "rule_conflict",
    "rule_verify",
    "rule_summary",
    "rule_cues",
]

KINDS = ("fact", "knowledge", "decision", "preference", "procedure", "experience",
         "task", "tool", "turn", "artifact")

#: 关键词规则（顺序即优先级：偏好 > 决策 > 任务 > 过程 > 工具 > 制品 > 知识 > 事实）
_RULES = (
    ("preference", ("我喜欢", "我讨厌", "我偏好", "更希望", "不要用", "请使用", "习惯",
                    "prefer", "always use", "never use", "i like", "i hate")),
    ("decision", ("决定", "确定采用", "选定", "拍板", "改为", "选用", "decided", "choose",
                  "we will use", "决定使用")),
    ("task", ("待办", "todo", "下一步", "需要完成", "待处理", "计划做", "follow up")),
    ("procedure", ("步骤", "流程", "先", "然后", "最后", "how to", "step 1", "操作步骤")),
    ("experience", ("踩坑", "经验", "教训", "试过", "发现了一个", "lesson", "gotcha")),
    ("tool", ("命令", "脚本", "api", "接口", "用 python", "curl", "工具", "command")),
    ("artifact", ("文件", "文档", "路径", "仓库", "链接", "http://", "https://", ".md")),
    ("knowledge", ("定义", "原理", "概念", "定理", "公式", "是指", "means that", "定义是")),
)

_CATEGORY_RULES = (
    ("engineering", ("代码", "接口", "python", "sql", "api", "构建", "部署", "bug", "重构",
                     "repository", "git", "测试")),
    ("product", ("需求", "用户", "体验", "功能", "设计", "路线图", "product")),
    ("research", ("论文", "实验", "dataset", "benchmark", "研究", "模型效果")),
    ("ops", ("服务器", "监控", "告警", "备份", "运维", "docker", "k8s")),
    ("personal", ("我", "家人", "健康", "日程", "旅行", "生活")),
)

_HIGH = ("必须", "绝不", "永远", "重要", "紧急", "不要", "禁止", "critical", "must", "never")
_MID = ("需要", "应该", "建议", "偏好", "希望", "should", "prefer")

_NEGATIONS = ("不", "没", "无", "非", "未", "别", "禁止", "never", "not", "no", "without")

_NUMBER_RE = re.compile(r"[-+]?\d+(?:\.\d+)?")
_SENTENCE_RE = re.compile(r"[^。！？\.\!\?\n]+[。！？\.\!\?]?")

CONFLICT_CUES = ("不是", "并非", "而不是", "已于", "已被", "改为", "不再", "取消", "撤销",
                 "superseded", "replaced by", "no longer", "instead of", "不同于")


# ============================================================
# 公共小工具
# ============================================================
def _body(obj) -> str:
    """兼容 dict / str：判定函数对「记忆对象」和「纯文本」都要能用。"""
    if isinstance(obj, str):
        return obj
    if not isinstance(obj, dict):
        return "" if obj is None else str(obj)
    for key in ("body", "text", "content", "summary", "title"):
        value = obj.get(key)
        if isinstance(value, str) and value.strip():
            return value
    return json.dumps(obj, ensure_ascii=False)


def _id(obj):
    if isinstance(obj, dict):
        return obj.get("id") or obj.get("target_id")
    return None


def _clamp(value, low=0.0, high=1.0) -> float:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return low
    if out != out:  # NaN
        return low
    return max(low, min(high, out))


def _llm(store, gw, template: str, variables: dict, role="judge"):
    """渲染提示词并调用 gw.judge；任何异常向上抛给调用方做兜底。"""
    if gw is None:
        raise ModelUnavailable(role, "未配置")
    prompt = render_prompt(load_prompt(template, ""), **variables).strip()
    if not prompt:
        raise JudgeFormatError("提示词模板缺失：" + template, role=role)
    return gw.judge(prompt, role=role)


def _keywords(text: str) -> set:
    """轻量分词：CJK 用字符二元组（bigram），其余用单词。用于重叠度判定。"""
    lowered = (text or "").lower()
    out = set(re.findall(r"[a-z0-9_\-]{2,}", lowered))
    for run in re.findall(r"[\u4e00-\u9fff]+", lowered):
        if len(run) == 1:
            out.add(run)
        for idx in range(len(run) - 1):
            out.add(run[idx:idx + 2])
    return out


def _sentences(text: str) -> list:
    return [s.strip() for s in _SENTENCE_RE.findall(text or "") if s.strip()]


# ============================================================
# 1. 分类
# ============================================================
def classify(store, gw, text, kinds=None) -> dict:
    """LLM 分类；失败走关键词规则。返回 {kind, category, importance, reason, degraded}。"""
    body = _body(text)
    allowed = [k for k in (kinds or KINDS) if k in KINDS] or list(KINDS)
    try:
        data = _llm(store, gw, "classify", {"body": body})
        kind = data.get("kind")
        if kind not in KINDS:
            raise JudgeFormatError("kind 不在允许集合内：%r" % (kind,))
        return {
            "kind": kind,
            "category": str(data.get("category") or "general")[:64],
            "importance": _clamp(data.get("importance"), 0.0, 1.0),
            "reason": str(data.get("reason") or "")[:400],
            "degraded": False,
        }
    except (ModelUnavailable, JudgeFormatError, ValueError, TypeError, KeyError) as exc:
        rule = rule_classify(body, allowed)
        rule["degraded"] = True
        rule["reason"] = "规则兜底：%s｜LLM：%s" % (rule["reason"], _reason_text(exc))
        return rule


def rule_classify(body: str, kinds=None) -> dict:
    allowed = set(kinds or KINDS)
    text = (body or "").lower()
    kind = "fact"
    for name, cues in _RULES:
        if name in allowed and any(cue in text for cue in cues):
            kind = name
            break
    category = "general"
    for name, cues in _CATEGORY_RULES:
        if any(cue in text for cue in cues):
            category = name
            break
    importance = 0.3
    if any(cue in text for cue in _HIGH):
        importance = 0.8
    elif any(cue in text for cue in _MID):
        importance = 0.55
    if len(body or "") >= 60:
        importance = min(0.9, importance + 0.05)
    return {"kind": kind, "category": category, "importance": round(importance, 2),
            "reason": "关键词匹配 %s/%s" % (kind, category), "degraded": False}


# ============================================================
# 2. 查重裁决
# ============================================================
_ACTIONS = ("add", "update", "supersede", "merge", "link", "noop", "ask")


def dedup_verdict(store, gw, new_mem, old_mem, knn) -> dict:
    """返回 {action, target_id, confidence, reason, merged_body, degraded}。"""
    old_id = _id(old_mem)
    try:
        data = _llm(store, gw, "dedup_judge", {
            "new": _body(new_mem) or json.dumps(new_mem, ensure_ascii=False, default=str),
            "old": _body(old_mem) or json.dumps(old_mem, ensure_ascii=False, default=str),
        })
        action = str(data.get("action") or "").lower()
        if action not in _ACTIONS:
            raise JudgeFormatError("action 不合法：%r" % (action,))
        return {
            "action": action,
            "target_id": data.get("target_id") or old_id,
            "confidence": _clamp(data.get("confidence"), 0.0, 1.0),
            "reason": str(data.get("reason") or "")[:400],
            "merged_body": data.get("merged_body") or None,
            "degraded": False,
        }
    except (ModelUnavailable, JudgeFormatError, ValueError, TypeError, KeyError) as exc:
        out = _rule_dedup(new_mem, old_mem, knn)
        out["degraded"] = True
        out["reason"] = "%s｜LLM：%s" % (out["reason"], _reason_text(exc))
        return out


def _rule_dedup(new_mem, old_mem, knn) -> dict:
    sim = 0.0
    if isinstance(knn, (int, float)):
        sim = _clamp(knn)
    elif isinstance(knn, dict):
        for key in ("score", "similarity", "sim", "cos"):
            if isinstance(knn.get(key), (int, float)):
                sim = _clamp(knn[key])
                break
    elif isinstance(knn, (list, tuple)) and knn:
        first = knn[0]
        if isinstance(first, dict):
            for key in ("score", "similarity", "sim"):
                if isinstance(first.get(key), (int, float)):
                    sim = _clamp(first[key])
                    break
        elif isinstance(first, (int, float)):
            sim = _clamp(first)
        elif isinstance(first, (list, tuple)) and len(first) >= 2 and isinstance(first[1], (int, float)):
            sim = _clamp(first[1])

    new_body = _body(new_mem).strip()
    old_body = _body(old_mem).strip()
    old_id = _id(old_mem)

    if not old_body:
        return {"action": "add", "target_id": None, "confidence": 0.6,
                "reason": "没有可比对的旧记忆", "merged_body": None}
    if new_body and new_body == old_body:
        return {"action": "noop", "target_id": old_id, "confidence": 0.9,
                "reason": "正文完全一致", "merged_body": None}
    if sim >= 0.95:
        return {"action": "noop", "target_id": old_id, "confidence": 0.85,
                "reason": "相似度 %.2f ≥ 0.95，视为重复" % sim, "merged_body": None}
    if sim >= 0.86:
        longer = new_body if len(new_body) >= len(old_body) else old_body
        return {"action": "update", "target_id": old_id, "confidence": 0.7,
                "reason": "相似度 %.2f ≥ 0.86，新内容更完整则更新" % sim,
                "merged_body": longer if longer else None}
    if sim >= 0.72:
        merged = old_body
        if new_body and new_body not in old_body:
            merged = (old_body + "\n" + new_body).strip()
        return {"action": "merge", "target_id": old_id, "confidence": 0.6,
                "reason": "相似度 %.2f ≥ 0.72，互补可合并" % sim, "merged_body": merged}
    if sim >= 0.55:
        return {"action": "link", "target_id": old_id, "confidence": 0.5,
                "reason": "相似度 %.2f ≥ 0.55，相关但独立" % sim, "merged_body": None}
    if sim <= 0 and _keywords(new_body) and _keywords(old_body):
        overlap = _keywords(new_body) & _keywords(old_body)
        if overlap and len(overlap) / max(1, len(_keywords(new_body))) >= 0.8:
            return {"action": "link", "target_id": old_id, "confidence": 0.45,
                    "reason": "关键词高度重叠但相似度未知", "merged_body": None}
    if sim <= 0:
        return {"action": "ask", "target_id": old_id, "confidence": 0.3,
                "reason": "相似度未知，需人工裁决", "merged_body": None}
    return {"action": "add", "target_id": None, "confidence": 0.7,
            "reason": "相似度 %.2f < 0.55，视为新记忆" % sim, "merged_body": None}


# ============================================================
# 3. 冲突裁决
# ============================================================
def conflict_verdict(store, gw, a, b) -> dict:
    """返回 {preferred: a|b|ask, reasons, confidence, degraded}。"""
    try:
        data = _llm(store, gw, "conflict", {
            "a": _body(a) or json.dumps(a, ensure_ascii=False, default=str),
            "b": _body(b) or json.dumps(b, ensure_ascii=False, default=str),
        })
        preferred = str(data.get("preferred") or "").lower()
        if preferred in ("memory_a", "first", "1"):
            preferred = "a"
        elif preferred in ("memory_b", "second", "2"):
            preferred = "b"
        if preferred not in ("a", "b", "ask"):
            raise JudgeFormatError("preferred 不合法：%r" % (preferred,))
        reasons = data.get("reasons")
        if isinstance(reasons, str):
            reasons = [reasons]
        if not isinstance(reasons, list):
            reasons = []
        return {"preferred": preferred, "reasons": [str(r)[:300] for r in reasons][:8],
                "confidence": _clamp(data.get("confidence"), 0.0, 1.0), "degraded": False}
    except (ModelUnavailable, JudgeFormatError, ValueError, TypeError, KeyError) as exc:
        out = rule_conflict(a, b)
        out["degraded"] = True
        out["reasons"] = list(out["reasons"]) + ["LLM：%s" % _reason_text(exc)]
        return out


def rule_conflict(a, b) -> dict:
    """确定性冲突检测：数值冲突 / 极性冲突 / 显式推翻词 / 来源可信度。"""
    body_a, body_b = _body(a), _body(b)
    reasons = []
    conf = 0.0
    preferred = "ask"

    nums_a = set(_NUMBER_RE.findall(body_a))
    nums_b = set(_NUMBER_RE.findall(body_b))
    if nums_a and nums_b and nums_a != nums_b:
        reasons.append("数值不同：a=%s b=%s" % (sorted(nums_a), sorted(nums_b)))
        conf = max(conf, 0.55)

    neg_a = any(token in body_a for token in ("不", "没", "非", "无", "not ", "never"))
    neg_b = any(token in body_b for token in ("不", "没", "非", "无", "not ", "never"))
    if neg_a != neg_b:
        overlap = _keywords(body_a) & _keywords(body_b)
        if len(overlap) >= 2:
            reasons.append("极性相反（一方含否定），共同主题：%s" % sorted(overlap)[:4])
            conf = max(conf, 0.5)

    newer = None
    for label, body in (("a", body_a), ("b", body_b)):
        if any(cue in body for cue in CONFLICT_CUES):
            newer = label
            reasons.append("%s 含明确推翻词（改为/不再/取代）" % label)
            conf = max(conf, 0.6)
            break

    trust_a = a.get("trust") if isinstance(a, dict) else None
    trust_b = b.get("trust") if isinstance(b, dict) else None
    if isinstance(trust_a, (int, float)) and isinstance(trust_b, (int, float)):
        if abs(trust_a - trust_b) >= 0.2:
            preferred = "a" if trust_a > trust_b else "b"
            reasons.append("来源可信度差异 a=%.2f b=%.2f" % (trust_a, trust_b))
            conf = max(conf, 0.65)
        elif newer and not preferred:
            preferred = newer
    elif newer:
        preferred = newer

    if not reasons:
        reasons.append("未命中确定性冲突特征，需人工裁决")
        conf = 0.25
    if preferred == "ask" and conf >= 0.55:
        reasons.append("特征命中但不足以自动选择，建议人工裁决")
    return {"preferred": preferred, "reasons": reasons, "confidence": round(conf, 2)}


# ============================================================
# 4. 断言核验
# ============================================================
def verify_claims(store, gw, candidate, quotes) -> dict:
    """返回 {supported, unsupported, verdict, degraded}。"""
    quote_list = _quote_list(quotes)
    try:
        data = _llm(store, gw, "verify", {
            "candidate": _body(candidate),
            "quotes": quote_list,
        })
        supported = _str_list(data.get("supported"))
        unsupported = _str_list(data.get("unsupported"))
        verdict = str(data.get("verdict") or "").lower()
        if verdict not in ("pass", "fail"):
            verdict = "pass" if not unsupported else "fail"
        return {"supported": supported, "unsupported": unsupported, "verdict": verdict,
                "degraded": False}
    except (ModelUnavailable, JudgeFormatError, ValueError, TypeError, KeyError) as exc:
        out = rule_verify(candidate, quote_list)
        out["degraded"] = True
        out["reasons"] = ["LLM：%s" % _reason_text(exc)]
        return out


def rule_verify(candidate, quotes) -> dict:
    """确定性核验：把候选切成句子，逐句看是否有足够 token 重叠的引句支撑。"""
    quote_list = _quote_list(quotes)
    claims = [c for c in _sentences(_body(candidate)) if len(c) >= 2]
    supported, unsupported = [], []
    for claim in claims:
        tokens = _keywords(claim)
        hit = False
        for quote in quote_list:
            if claim and claim in quote:
                hit = True
                break
            if not tokens:
                continue
            q_tokens = _keywords(quote)
            covered = len(tokens & q_tokens) / max(1, len(tokens))
            if covered >= 0.5:
                hit = True
                break
        (supported if hit else unsupported).append(claim)
    verdict = "pass" if claims and not unsupported else "fail"
    return {"supported": supported, "unsupported": unsupported, "verdict": verdict}


def _quote_list(quotes) -> list:
    if quotes is None:
        return []
    if isinstance(quotes, str):
        return [quotes]
    out = []
    for item in quotes:
        if isinstance(item, str):
            out.append(item)
        elif isinstance(item, dict):
            value = item.get("quote") or item.get("text") or item.get("body")
            if isinstance(value, str):
                out.append(value)
        elif item is not None:
            out.append(str(item))
    return out


def _str_list(value) -> list:
    if isinstance(value, str):
        return [value]
    if not isinstance(value, list):
        return []
    return [str(v)[:500] for v in value if str(v).strip()]


# ============================================================
# 5. 摘要
# ============================================================
def summarize(store, gw, text, max_tokens=180) -> dict:
    """返回 {summary, degraded}。LLM 失败走抽取式（首句 + 关键词句）。"""
    body = _body(text)
    budget = int(max_tokens or 180)
    prompt = render_prompt(load_prompt("summarize", ""), text=body, budget=budget) \
        or ("用不超过 %d tokens 压缩下面的内容，只输出摘要正文，不要解释。\n%s" % (budget, body))
    try:
        if gw is None:
            raise ModelUnavailable("judge", "未配置")
        summary = gw.chat([{"role": "user", "content": prompt}], role="judge",
                          max_tokens=budget, temperature=0.1)
        summary = (summary or "").strip()
        if not summary:
            raise JudgeFormatError("摘要为空", role="judge")
        return {"summary": summary, "degraded": False}
    except (ModelUnavailable, JudgeFormatError, ValueError, TypeError) as exc:
        out = rule_summary(body, budget)
        out["degraded"] = True
        out["reason"] = "抽取式兜底｜LLM：%s" % _reason_text(exc)
        return out


def rule_summary(text, budget=180) -> dict:
    """抽取式：首句 + 按长度均衡挑句，直到接近预算。"""
    sentences = _sentences(text)
    if not sentences:
        return {"summary": "", "degraded": False}
    target_chars = max(40, int(budget) * 2)  # 中文约 1 token / 2 字符
    picked = [sentences[0]]
    used = len(sentences[0])
    scored = sorted(sentences[1:], key=len, reverse=True)
    for sentence in scored:
        if used + len(sentence) > target_chars:
            continue
        picked.append(sentence)
        used += len(sentence)
        if used >= target_chars * 0.8:
            break
    summary = "".join(picked)
    return {"summary": summary[:target_chars], "degraded": False}


# ============================================================
# 6. 抽象线索
# ============================================================
def abstraction_cues(store, gw, text) -> dict:
    """返回 {cues:[...], degraded}。规则兜底 = 标题化 + 问句式。"""
    body = _body(text)
    try:
        data = _llm(store, gw, "abstraction", {"body": body, "text": body})
        cues = _str_list(data.get("cues"))
        if not cues:
            raise JudgeFormatError("cues 为空")
        return {"cues": cues[:6], "degraded": False}
    except (ModelUnavailable, JudgeFormatError, ValueError, TypeError, KeyError) as exc:
        out = rule_cues(body)
        out["degraded"] = True
        out["reason"] = "标题转线索兜底｜LLM：%s" % _reason_text(exc)
        return out


def rule_cues(text) -> dict:
    """把标题/首句/关键名词变成问句线索，能不看原文就指向该细节。"""
    lines = [ln.strip() for ln in (text or "").splitlines() if ln.strip()]
    cues = []
    if lines:
        head = re.sub(r"^#+\s*", "", lines[0])
        head = re.sub(r"[。\.;；:：]+$", "", head)
        if head:
            cues.append("%s是什么？" % head[:80])
            cues.append("%s的关键点有哪些？" % head[:80])
    entities = []
    seen = set()
    for token in re.findall(r"[A-Za-z][A-Za-z0-9_\-]{2,}|[\u4e00-\u9fff]{2,6}", text or ""):
        if token in seen or token in ("这个", "那个", "我们", "可以", "需要", "一个"):
            continue
        seen.add(token)
        entities.append(token)
        if len(entities) >= 6:
            break
    for token in entities[:3]:
        cues.append("关于 %s 的具体细节是什么？" % token)
    if not cues:
        snippet = (text or "").strip()[:40]
        cues.append(("关于「%s」的结论是什么？" % snippet) if snippet else "这段内容讲了什么？")
    return {"cues": cues[:6], "degraded": False}


# ============================================================
# 内部
# ============================================================
def _reason_text(exc) -> str:
    if isinstance(exc, ModelUnavailable):
        return "模型不可用(%s)" % (exc.reason or "")
    if isinstance(exc, JudgeFormatError):
        return "返回格式错误"
    return "%s: %s" % (exc.__class__.__name__, exc)
