# -*- coding: utf-8 -*-
"""DAG 工作流执行器：节点处理器注册表、步骤记录、降级与可复现。

设计要点（与 docs/ARCHITECTURE.md §4.6 / §8 对齐）：
  * 模板来自 data/builtin/workflow_templates.json（18 条），seed 幂等写入
    workflow_template 表；run 落 workflow_run + workflow_step，可回放、可对比。
  * 节点按 kind 分派到 NODE_HANDLERS；fallback 处理器以 "fallback:" 前缀注册。
  * 节点抛 ModelUnavailable → 走模板 fallbacks 指定的确定性实现；没有则标 degraded
    继续，run 状态为 partial。其它异常 → 节点 failed、下游 skipped、run failed。
  * 每个节点只读「祖先链」的 artifacts（兄弟分支互相不可见），保证分支可解释。
  * 同层节点用线程池并行；每个线程拿自己的 sqlite 连接（Store.con 是 thread-local）。

不做什么：
  * 不自己实现 store / retrieval / judge / vectors —— 一律调用既有模块。
  * 不伪造成功：模型不可用必然体现在 step.degraded 与 run.degraded 上。
"""
from __future__ import annotations

import json
import re
import sqlite3
import time
import traceback
import uuid
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable, Iterator, Mapping

from . import chunking, db as dbmod, prompts, retrieval, vectors
from .db import dumps, loads, now

try:  # models.py 由别人并行维护：拿不到就退化成本模块内的占位异常
    from .models import ModelUnavailable
except ImportError:  # pragma: no cover - models 尚未落地时的容错
    class ModelUnavailable(RuntimeError):  # type: ignore[no-redef]
        """模型不可用（占位实现）。"""

        def __init__(self, role: str = "chat", reason: str = "未配置", **kw: Any) -> None:
            super().__init__("%s: %s" % (role, reason))
            self.role = role
            self.reason = reason
            self.detail = dict(kw)

try:  # judge.py 同理：判定层不在时用规则兜底（judge 节点内部已做二次兜底）
    from . import judge as judge_mod
except ImportError:  # pragma: no cover
    judge_mod = None  # type: ignore[assignment]

try:  # 模型消息工具（角色 → provider/model 标签），拿不到就退回简单标签
    from .models import load_prompt as _models_load_prompt
    from .models import render_prompt as _models_render_prompt
except ImportError:  # pragma: no cover
    _models_load_prompt = None  # type: ignore[assignment]
    _models_render_prompt = None  # type: ignore[assignment]

try:
    from .store import Store
except ImportError:  # pragma: no cover - store.py 并行开发中
    Store = None  # type: ignore[assignment]

__all__ = [
    "NODE_HANDLERS",
    "KINDS",
    "FALLBACK_PREFIX",
    "MAX_WORKERS",
    "OUTPUT_LIMIT",
    "WorkflowContext",
    "WorkflowError",
    "WorkflowInputError",
    "WorkflowNotFound",
    "WorkflowConflict",
    "WorkflowRunCancelled",
    "seed_templates",
    "list_templates",
    "get_template",
    "run_workflow",
    "get_run",
    "list_runs",
    "cancel_run",
    "register_handler",
    "iso_now",
]

#: 17 种节点（架构 §4.6）
KINDS: tuple[str, ...] = (
    "input", "transform", "extract", "classify", "retrieve", "embed", "rerank", "fuse",
    "judge", "verify", "persist", "index", "graph", "generate", "decide", "schedule", "emit",
)

FALLBACK_PREFIX = "fallback:"
MAX_WORKERS = 4
OUTPUT_LIMIT = 4096          # workflow_step.output 截断（字节）
INPUT_LIMIT = 2048
TEXT_LIMIT = 2000            # 传给下游节点的单段文本上限
LOOP_LIMIT = 20000           # fuse/journal 防爆
TIMEOUT_NOTE = "节点串行执行（同批并行）"

DEFAULT_KIND = "fact"
CANDIDATE_ACTIONS = ("add", "update", "supersede", "merge", "link", "noop", "ask")


# ============================================================
# 0. 异常与时钟
# ============================================================
class WorkflowError(RuntimeError):
    """工作流层错误基类。"""


class WorkflowInputError(WorkflowError, ValueError):
    """输入校验失败（缺必填项 / 类型不符）。"""


class WorkflowNotFound(WorkflowError, LookupError):
    """模板或运行不存在。"""


class WorkflowConflict(WorkflowError):
    """状态冲突（如：运行已结束却要求取消）。"""


class WorkflowRunCancelled(WorkflowError):
    """运行被取消。"""


def iso_now() -> str:
    """UTC ISO8601 秒级（与 db.now() 同口径）。"""
    return now()


def _now_ms() -> float:
    return time.perf_counter() * 1000.0


def _new_id(prefix: str) -> str:
    return "%s-%s" % (prefix, uuid.uuid4().hex[:12])


# ============================================================
# 1. 小工具
# ============================================================
_SENT_RE = re.compile(r"[^。！？\.\!\?\n]+[。！？\.\!\?]?")
_WORD_RE = re.compile(r"[A-Za-z][A-Za-z0-9_\-]{2,}|[\u4e00-\u9fff]{2,8}")
_HEADING_RE = re.compile(r"^\s{0,3}(#{1,6})\s+(.+?)\s*$")
_BANNED_TITLE = {"这个", "那个", "我们", "可以", "需要", "一个", "然后", "因为", "所以",
                 "就是", "这是", "如果", "但是", "而且", "没有", "已经", "它们"}


def _as_int(value: Any, default: int = 0) -> int:
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return default


def _as_float(value: Any, default: float = 0.0) -> float:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return default
    if out != out:  # NaN
        return default
    return out


def _clamp(value: Any, low: float = 0.0, high: float = 1.0) -> float:
    out = _as_float(value, low)
    return max(low, min(high, out))


def _as_list(value: Any) -> list:
    if value is None:
        return []
    if isinstance(value, list):
        return list(value)
    if isinstance(value, tuple):
        return list(value)
    return [value]


def _as_dict(value: Any) -> dict:
    if isinstance(value, dict):
        return dict(value)
    if isinstance(value, str):
        parsed = loads(value, None)
        return parsed if isinstance(parsed, dict) else {}
    return {}


def _sentences(text: Any) -> list[str]:
    return [s.strip() for s in _SENT_RE.findall(str(text or "")) if s.strip()]


def _first_sentence(text: Any, limit: int = 120) -> str:
    for sentence in _sentences(text):
        if len(sentence) >= 2:
            return sentence[:limit]
    return str(text or "").strip()[:limit]


def _clip_text(text: Any, limit: int = TEXT_LIMIT) -> str:
    value = "" if text is None else str(text)
    return value if len(value) <= limit else value[:limit] + "…"


def _clip_json(payload: Any, limit: int = OUTPUT_LIMIT) -> dict:
    """把节点输出裁到 limit 字节以内（保留 dict 形状，超限放预览串）。"""
    value = payload if isinstance(payload, dict) else {"value": payload}
    try:
        raw = json.dumps(value, ensure_ascii=False, default=str)
    except (TypeError, ValueError):
        return {"repr": str(value)[:limit], "truncated": True}
    if len(raw.encode("utf-8")) <= limit:
        return value
    preview = raw[: max(64, limit // 2)]
    return {
        "truncated": True, "bytes": len(raw.encode("utf-8")), "preview": preview,
        "keys": sorted(str(k) for k in value.keys()),
    }


def _est_tokens(text: Any) -> int:
    return vectors.estimate_tokens(str(text or ""))


def _text_of(obj: Any) -> str:
    """把记忆/hit/普通 dict 抽取成一段正文文本。"""
    if obj is None:
        return ""
    if isinstance(obj, str):
        return obj
    if isinstance(obj, (list, tuple)):
        return "\n".join(_text_of(x) for x in obj if x is not None)
    if not isinstance(obj, dict):
        return str(obj)
    for key in ("body", "content", "text", "summary", "snippet"):
        value = obj.get(key)
        if isinstance(value, str) and value.strip():
            return value
    title = obj.get("title")
    return str(title or "")


def _title_of(obj: Any, fallback: str = "未命名") -> str:
    if isinstance(obj, dict):
        for key in ("title", "name", "query"):
            value = obj.get(key)
            if isinstance(value, str) and value.strip():
                return _clip_text(value.strip(), 120)
    text = _text_of(obj).strip()
    if not text:
        return fallback
    head = re.sub(r"^#+\s*", "", text.splitlines()[0]).strip()
    return _clip_text(head or text, 120)


def _kind_of(value: Any, allowed: Iterable[str]) -> str:
    allowed_set = tuple(allowed)
    text = str(value or "").strip()
    return text if text in allowed_set else (allowed_set[0] if allowed_set else DEFAULT_KIND)


def _hash(text: Any) -> str:
    import hashlib

    return hashlib.sha1(str(text or "").encode("utf-8")).hexdigest()[:16]


def _norm(text: Any) -> str:
    """归一化：去重空白、全角标点转半角、小写。"""
    value = str(text or "")
    table = {"，": ",", "。": ".", "；": ";", "：": ":", "！": "!", "？": "?",
             "（": "(", "）": ")", "【": "[", "】": "]", "“": '"', "”": '"',
             "‘": "'", "’": "'", "　": " "}
    for src, dst in table.items():
        value = value.replace(src, dst)
    value = re.sub(r"[ \t\u00a0]+", " ", value)
    value = re.sub(r"\n{3,}", "\n\n", value)
    return value.strip().lower()


def _intent_words(text: str) -> list[str]:
    """意图词：动词性/模态性的中文词与英文祈使词（规则抽取用）。"""
    cues = ("需要", "必须", "应该", "不要", "禁止", "决定", "采用", "改为", "偏好", "喜欢",
            "讨厌", "习惯", "步骤", "先", "然后", "最后", "注意", "风险", "bug", "修复",
            "部署", "测试", "配置", "接口", "命令", "脚本", "经验", "教训", "待办", "下一步",
            "todo", "must", "should", "never", "always", "prefer", "decide", "step", "fix")
    lowered = (text or "").lower()
    found = [word for word in cues if word.lower() in lowered]
    return list(dict.fromkeys(found))[:12]


def _keywords_of(text: str, limit: int = 12) -> list[str]:
    out: list[str] = []
    for token in _WORD_RE.findall(text or ""):
        if token in _BANNED_TITLE or token in out:
            continue
        out.append(token)
        if len(out) >= limit:
            break
    return out


def _rule_title(text: str, fallback: str = "片段") -> str:
    body = str(text or "").strip()
    if not body:
        return fallback
    for line in body.splitlines():
        match = _HEADING_RE.match(line)
        if match:
            return _clip_text(match.group(2).strip(), 120)
    first = _first_sentence(body, 120)
    return _clip_text(first or body[:120], 120) or fallback


def _rule_summary(text: Any, max_tokens: int = 180) -> str:
    """抽取式摘要：首句 + 均衡挑句，直到接近预算。"""
    sentences = _sentences(text)
    if not sentences:
        return _clip_text(text, max(40, max_tokens * 2))
    budget = max(40, int(max_tokens or 180) * 2)
    picked = [sentences[0]]
    used = len(sentences[0])
    for sentence in sorted(sentences[1:], key=len, reverse=True):
        if used + len(sentence) > budget:
            continue
        picked.append(sentence)
        used += len(sentence)
        if used >= budget * 0.8:
            break
    return "".join(picked)[:budget]


def _bullet_points(text: Any, limit: int = 5) -> list[str]:
    return [s[:200] for s in _sentences(text)[:limit]]


def _jaccard(a: str, b: str) -> float:
    left = set(_WORD_RE.findall(str(a or "").lower())) or {ch for ch in str(a or "")}
    right = set(_WORD_RE.findall(str(b or "").lower())) or {ch for ch in str(b or "")}
    if not left or not right:
        return 0.0
    return len(left & right) / len(left | right)


def _l2(vec: list[float]) -> list[float]:
    import math

    norm = math.sqrt(sum(float(v) * float(v) for v in vec)) or 1.0
    return [float(v) / norm for v in vec]


def _cosine(a: list[float], b: list[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    return sum(float(x) * float(y) for x, y in zip(a, b))


def _profile_label(profile: Any) -> str:
    """把模型档位渲染成 provider/model 标签（step.model 用）。"""
    if profile is None:
        return ""
    name = getattr(profile, "model", None)
    provider = getattr(profile, "provider", None)
    if isinstance(profile, dict):
        name = profile.get("model")
        provider = profile.get("provider")
    if name and provider:
        return "%s/%s" % (provider, name)
    return str(name or provider or "")


def _active_label(gw: Any, role: str = "") -> str:
    """从网关取当前生效的 role → "provider/model"；拿不到返回空串。"""
    if gw is None:
        return ""
    try:
        roles = gw.roles() or {}
    except Exception:
        return ""
    profile = roles.get(role) if role else None
    if profile is None:
        for value in roles.values():
            if value is not None:
                profile = value
                break
    return _profile_label(profile)


def _unavailable(exc: BaseException) -> bool:
    """节点里被包装过的 ModelUnavailable 也要能识别（跨模块 try/except 容错）。"""
    return isinstance(exc, ModelUnavailable) or type(exc).__name__ == "ModelUnavailable"



# ============================================================
# 2. 运行上下文
# ============================================================
@dataclass
class WorkflowContext:
    """一次运行的上下文。

    store / gw / inputs / scope / run_id / emitter / degraded / artifacts 是冻结字段；
    其余字段是执行器内部记账，节点可以读，但不要改（改了也不会影响调度）。

    可见性：executor 派发节点时把 artifacts 换成「仅祖先链」的快照，
    因此节点看不到兄弟分支的产物，分支结果才是可解释的。
    """

    store: Any = None
    gw: Any = None
    inputs: dict = field(default_factory=dict)
    scope: str = "global"
    run_id: str = ""
    emitter: Any = None
    degraded: list = field(default_factory=list)
    artifacts: dict = field(default_factory=dict)
    # —— 执行器内部记账 ——
    run_key: str = "tpl"
    template_id: str = ""
    template_name: str = ""
    node_id: str = ""
    node: dict = field(default_factory=dict)
    params: dict = field(default_factory=dict)
    ordinal: int = 0
    parent_run_id: str = ""
    trigger: str = "manual"
    template: dict = field(default_factory=dict)
    fallbacks: dict = field(default_factory=dict)
    step_meta: dict = field(default_factory=dict)
    cancel: Any = None
    use_llm: bool = True

    # ---------------- 只读便利 ----------------
    def ancestor(self, node_id: str) -> dict:
        """祖先节点的输出（默认可见集合）。"""
        return self.artifacts.get(str(node_id)) or {}

    def values(self) -> list:
        """所有可见产物里的 values 列表（retrieve / fuse 的默认候选池）。"""
        out: list = []
        for art in self.artifacts.values():
            if isinstance(art, dict):
                values = art.get("values")
                if isinstance(values, list):
                    out.extend(values)
        return out

    def first_list(self, *keys: str) -> list:
        """按 key 顺序在可见产物里找第一个非空列表。"""
        for key in keys:
            for art in self.artifacts.values():
                if isinstance(art, dict):
                    value = art.get(key)
                    if isinstance(value, list) and value:
                        return list(value)
        return []

    def text_for(self, *keys: str) -> str:
        """按 key 顺序在可见产物里找第一段非空文本。"""
        for key in keys:
            if key in self.inputs and isinstance(self.inputs[key], str):
                if self.inputs[key].strip():
                    return str(self.inputs[key])
            for art in self.artifacts.values():
                if isinstance(art, dict):
                    value = art.get(key)
                    if isinstance(value, str) and value.strip():
                        return value
        return ""

    def queue(self, node: dict) -> list:
        """获取/初始化节点的 FIFO 队列（fan-out 用）。"""
        bucket = self.step_meta.setdefault("queues", {})
        key = str(node.get("id") or "")
        if key not in bucket:
            bucket[key] = []
        if not bucket[key]:
            bucket[key] = _queue_seed(self, node)
        return bucket[key]

    # ---------------- 记录 ----------------
    def mark_degraded(self, capability: str, reason: str = "") -> None:
        """登记一次降级（run.degraded 是去重后的能力名列表）。"""
        name = str(capability or "unknown").strip() or "unknown"
        if name not in self.degraded:
            self.degraded.append(name)
        detail = self.step_meta.setdefault("degraded_reasons", {})
        if reason:
            detail.setdefault(name, str(reason)[:200])

    def note(self, metrics: Mapping[str, Any]) -> None:
        """记录 step 级观测（model / tokens / 命中数…）。"""
        if isinstance(metrics, Mapping):
            self.step_meta.setdefault("metrics", {}).update(dict(metrics))

    def cancelled(self) -> bool:
        if self.cancel is None:
            return False
        return bool(self.cancel(self.run_id))


# ============================================================
# 3. 处理器注册表
# ============================================================
NODE_HANDLERS: dict[str, Callable[[WorkflowContext, dict], dict]] = {}


def register_handler(kind: str, handler: Callable[[WorkflowContext, dict], dict],
                     *, override: bool = True) -> None:
    """登记（或以 fallback:<name> 形式）覆盖一个节点处理器。"""
    key = str(kind or "").strip()
    if not key:
        raise ValueError("handler 需要非空的 kind / 名字")
    if not callable(handler):
        raise TypeError("handler 必须可调用: %s" % key)
    if not override and key in NODE_HANDLERS:
        return
    NODE_HANDLERS[key] = handler


def resolve_handler(kind: str) -> Callable[[WorkflowContext, dict], dict] | None:
    """先查原名，再查 fallback:<name>；都缺失时返回 None。"""
    key = str(kind or "").strip()
    handler = NODE_HANDLERS.get(key)
    if handler is not None:
        return handler
    if not key.startswith(FALLBACK_PREFIX):
        return NODE_HANDLERS.get(FALLBACK_PREFIX + key)
    return None


def handler_catalog() -> dict:
    """已注册处理器清单（测试与自检用）。"""
    return {
        "kinds": [kind for kind in KINDS if kind in NODE_HANDLERS],
        "fallbacks": sorted(name[len(FALLBACK_PREFIX):] for name in NODE_HANDLERS
                            if name.startswith(FALLBACK_PREFIX)),
        "total": len(NODE_HANDLERS),
    }


# ============================================================
# 4. 模板：seed / list / get
# ============================================================
TEMPLATES_FILE = "workflow_templates.json"


def _builtin_templates() -> list[dict]:
    """读取内置模板列表（文件缺失返回空列表，不抛）。"""
    data = dbmod.read_builtin(TEMPLATES_FILE)
    if isinstance(data, dict):
        data = data.get("templates") or data.get("items") or []
    if not isinstance(data, list):
        return []
    out: list[dict] = []
    for item in data:
        if isinstance(item, dict) and str(item.get("id") or "").strip():
            out.append(item)
    return out


def _spec_of(template: Mapping[str, Any] | None) -> dict:
    """模板的 DAG 规格：优先 spec 字段，兼容平铺结构。"""
    data = dict(template or {})
    spec = data.get("spec")
    if isinstance(spec, str):
        spec = loads(spec, {}) or {}
    if not isinstance(spec, dict):
        spec = {}
    merged = dict(spec)
    for key in ("nodes", "edges", "fallbacks", "inputs", "trigger"):
        if key not in merged and key in data:
            merged[key] = data[key]
    merged["nodes"] = [n for n in _as_list(merged.get("nodes")) if isinstance(n, dict)]
    merged["edges"] = [e for e in _as_list(merged.get("edges")) if isinstance(e, dict)]
    fallbacks = merged.get("fallbacks")
    merged["fallbacks"] = dict(fallbacks) if isinstance(fallbacks, dict) else {}
    return merged


def _template_row(db_row: Mapping[str, Any]) -> dict:
    """DB 行 → 模板 dict（spec 展开成节点/边，同时保留 spec 原文）。"""
    item = dict(db_row)
    raw_spec = item.get("spec")
    spec = loads(raw_spec, {}) if isinstance(raw_spec, str) else raw_spec
    spec = spec if isinstance(spec, dict) else {}
    item["spec"] = spec
    item["nodes"] = _as_list(spec.get("nodes"))
    item["edges"] = _as_list(spec.get("edges"))
    item["fallbacks"] = dict(spec.get("fallbacks") or {}) if isinstance(spec.get("fallbacks"), dict) else {}
    item["inputs"] = spec.get("inputs") or {}
    item["trigger"] = spec.get("trigger") or {}
    item["builtin"] = bool(item.get("builtin"))
    item["enabled"] = bool(item.get("enabled"))
    return item


def seed_templates(store) -> int:
    """把内置模板写进 workflow_template（幂等：按 id 覆盖，行数恒为内置条数）。

    返回写入（插入或更新）的模板条数。
    """
    templates = _builtin_templates()
    if not templates:
        return 0
    stamp = iso_now()
    written = 0
    con = store.con
    with store._txn() as con:
        for template in templates:
            tid = str(template.get("id")).strip()
            spec = {
                "nodes": _as_list(template.get("nodes")),
                "edges": _as_list(template.get("edges")),
                "fallbacks": template.get("fallbacks") or {},
                "inputs": template.get("inputs") or {},
                "trigger": template.get("trigger") or {},
            }
            existing = con.execute(
                "SELECT created_at FROM workflow_template WHERE id = ?", (tid,)
            ).fetchone()
            created = str(existing["created_at"]) if existing else stamp
            con.execute(
                "INSERT INTO workflow_template(id, name, description, category, version, spec, "
                "builtin, enabled, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) "
                "ON CONFLICT(id) DO UPDATE SET name = excluded.name, "
                "description = excluded.description, category = excluded.category, "
                "version = excluded.version, spec = excluded.spec, builtin = excluded.builtin, "
                "updated_at = excluded.updated_at",
                (
                    tid, str(template.get("name") or tid), template.get("description") or "",
                    template.get("category") or "", _as_int(template.get("version"), 1),
                    dumps(spec), 1, 1, created, stamp,
                ),
            )
            written += 1
        store.audit("workflow.seed", None, detail={"templates": written})
    return written


def list_templates(store) -> list[dict]:
    """列出全部模板（按 category, id 排序；含 nodes / edges / fallbacks）。"""
    rows = store.con.execute(
        "SELECT * FROM workflow_template ORDER BY category, id"
    ).fetchall()
    return [_template_row(row) for row in rows]


def get_template(store, template_id: str) -> dict | None:
    """按 id 取模板；不存在返回 None。"""
    if not str(template_id or "").strip():
        return None
    row = store.con.execute(
        "SELECT * FROM workflow_template WHERE id = ?", (str(template_id),)
    ).fetchone()
    return _template_row(row) if row is not None else None


# ============================================================
# 5. DAG 结构
# ============================================================
def _node_map(nodes: Iterable[Mapping[str, Any]]) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for index, node in enumerate(nodes):
        if not isinstance(node, Mapping):
            continue
        nid = str(node.get("id") or "").strip()
        if not nid or nid in out:
            continue
        item = dict(node)
        item["id"] = nid
        item["kind"] = str(item.get("kind") or "input").strip() or "input"
        item["params"] = _as_dict(item.get("params"))
        item["ordinal"] = index
        out[nid] = item
    return out


def _parent_map(edges: Iterable[Mapping[str, Any]], nodes: dict[str, dict]) -> dict[str, list[dict]]:
    """node_id → 入边列表（只保留两端都存在的边）。"""
    parents: dict[str, list[dict]] = {nid: [] for nid in nodes}
    for edge in edges:
        if not isinstance(edge, Mapping):
            continue
        src = str(edge.get("from") or edge.get("source") or "").strip()
        dst = str(edge.get("to") or edge.get("target") or "").strip()
        if src not in nodes or dst not in nodes:
            continue
        parents[dst].append({
            "from": src, "to": dst,
            "when": str(edge.get("when") or "always").strip() or "always",
        })
    for dst in parents:
        parents[dst].sort(key=lambda e: nodes[e["from"]]["ordinal"])
    return parents


def _level_order(nodes: dict[str, dict], parents: dict[str, list[dict]]) -> list[list[str]]:
    """Kahn 分层：同一层入度（未完成父边）为 0，可并行。环里的节点追加在末层。"""
    remaining = {nid: len(parents[nid]) for nid in nodes}
    children: dict[str, list[str]] = {nid: [] for nid in nodes}
    for dst, edges in parents.items():
        for edge in edges:
            children[edge["from"]].append(dst)
    ready = deque(sorted((nid for nid, deg in remaining.items() if deg == 0),
                         key=lambda nid: nodes[nid]["ordinal"]))
    order: list[list[str]] = []
    seen: set[str] = set()
    while ready:
        layer = []
        for _ in range(len(ready)):
            layer.append(ready.popleft())
        order.append(layer)
        nxt: list[str] = []
        for nid in layer:
            seen.add(nid)
            for child in children.get(nid, []):
                remaining[child] -= 1
                if remaining[child] == 0 and child not in seen:
                    nxt.append(child)
        nxt.sort(key=lambda nid: nodes[nid]["ordinal"])
        ready.extend(nxt)
    leftover = [nid for nid in nodes if nid not in seen]
    if leftover:
        leftover.sort(key=lambda nid: nodes[nid]["ordinal"])
        order.append(leftover)
    return order


def _ancestors(node_id: str, parents: dict[str, list[dict]]) -> set[str]:
    """某节点的严格祖先集合（沿入边回溯，visited 去环）。"""
    seen: set[str] = set()
    stack = [edge["from"] for edge in parents.get(node_id, [])]
    while stack:
        current = stack.pop()
        if current in seen:
            continue
        seen.add(current)
        for edge in parents.get(current, []):
            if edge["from"] not in seen:
                stack.append(edge["from"])
    return seen


def _self_and_ancestors(node_id: str, parents: dict[str, list[dict]]) -> list[str]:
    """可见集合：自身 + 祖先（自身在最后，方便「同 key 取最近」）。"""
    names = _ancestors(node_id, parents)
    ordered = [nid for nid in names]
    ordered.sort()
    return ordered + [node_id]


#: run_workflow(mode=...) 可选值：fail（默认，失败即整体失败）/ skip（失败仅跳过下游）
RUN_MODES = ("fail", "skip")


def _when_holds(when: str, status: str, degraded: bool, ctx_artifacts: Mapping[str, Any]) -> bool:
    """边条件：always / on_success / on_degraded / if:<key>（读祖先产物里的布尔字段）。"""
    token = str(when or "always").strip().lower()
    if token in ("", "always", "true", "1"):
        return True
    if token in ("on_success", "success", "ok"):
        return status == "ok"
    if token in ("on_degraded", "degraded", "on_degrade"):
        return bool(degraded)
    if token in ("on_failure", "failure", "failed"):
        return status == "failed"
    if token.startswith("if:"):
        return _truthy_key(token[3:].strip(), ctx_artifacts)
    return True


def _truthy_key(key: str, ctx_artifacts: Mapping[str, Any]) -> bool:
    """读 artifacts 里的布尔字段：先按 "node.key"，再按裸 key（最新产物优先）。"""
    if not key:
        return False
    if "." in key:
        head, _, tail = key.partition(".")
        art = ctx_artifacts.get(head)
        if isinstance(art, Mapping):
            return bool(art.get(tail))
        return False
    for nid in reversed(list(ctx_artifacts.keys())):
        art = ctx_artifacts.get(nid)
        if isinstance(art, Mapping) and key in art:
            return bool(art.get(key))
    return False



def _queue_seed(ctx: WorkflowContext, node: Mapping[str, Any]) -> list:
    """fan-out 的种子：优先父边 from 的产物，其次 inputs，最后空队列。"""
    params = _as_dict(node.get("params"))
    for key in ("from", "source", "over"):
        if key in params:
            return list(_as_list(ctx.artifacts.get(str(params[key]))))
    for value in ctx.artifacts.values():
        if isinstance(value, Mapping):
            for field_name in ("items", "units", "values", "results"):
                inner = value.get(field_name)
                if isinstance(inner, list) and inner:
                    return list(inner)
    for key in ("items", "units", "content", "text", "candidate", "query"):
        if key in ctx.inputs and ctx.inputs.get(key):
            return list(_as_list(ctx.inputs.get(key)))
    return []


# ============================================================
# 6. 运行记录（落库）
# ============================================================
RUN_COLUMNS = ("id", "template_id", "template_name", "scope_id", "trigger", "status",
               "input", "output", "error", "parent_run_id", "created_at", "started_at",
               "finished_at", "metadata")


def _run_row(row: Mapping[str, Any], steps: list[dict] | None = None) -> dict:
    """DB 行 → 冻结格式的 run dict。"""
    item = dict(row)
    meta = loads(item.get("metadata"), {}) or {}
    if not isinstance(meta, dict):
        meta = {}
    degraded = [str(x) for x in _as_list(meta.get("degraded"))]
    out = {
        "id": item.get("id"),
        "template_id": item.get("template_id"),
        "template_name": item.get("template_name"),
        "scope_id": item.get("scope_id"),
        "trigger": item.get("trigger"),
        "status": item.get("status"),
        "input": loads(item.get("input"), {}) or {},
        "output": loads(item.get("output"), {}) or {},
        "error": item.get("error"),
        "parent_run_id": item.get("parent_run_id"),
        "started_at": item.get("started_at"),
        "finished_at": item.get("finished_at"),
        "created_at": item.get("created_at"),
        "degraded": degraded,
        "steps": steps if steps is not None else [],
    }
    extra = {k: v for k, v in meta.items() if k not in ("degraded",)}
    if extra:
        out["meta"] = extra
    return out


def _step_row(row: Mapping[str, Any]) -> dict:
    item = dict(row)
    art = loads(item.get("output"), {}) or {}
    meta = art.pop("_meta", None) if isinstance(art, dict) else None
    meta = meta if isinstance(meta, dict) else {}
    if meta.get("truncated"):
        art["truncated"] = True
    started = item.get("started_at")
    finished = item.get("finished_at")
    ms = None
    if meta.get("ms") is not None:
        ms = meta.get("ms")
    elif started and finished:
        ms = _ms_between(started, finished)
    return {
        "id": item.get("id"),
        "run_id": item.get("run_id"),
        "ordinal": _as_int(item.get("ordinal"), 0),
        "node_id": item.get("node_id"),
        "name": item.get("name"),
        "kind": item.get("kind"),
        "status": item.get("status"),
        "model": item.get("model") or "",
        "degraded": bool(item.get("degraded")),
        "ms": ms,
        "tokens": _as_int(item.get("tokens"), 0),
        "input": loads(item.get("input"), {}) or {},
        "output": art,
        "error": item.get("error"),
        "started_at": started,
        "finished_at": finished,
        "attempts": _as_list(meta.get("attempts")),
        "degraded_reasons": dict(meta.get("degraded_reasons") or {}),
    }


def _ms_between(started: str, finished: str) -> int | None:
    try:
        from datetime import datetime

        fmt = "%Y-%m-%dT%H:%M:%SZ"
        left = datetime.strptime(str(started), fmt)
        right = datetime.strptime(str(finished), fmt)
        return int(max(0.0, (right - left).total_seconds() * 1000))
    except (TypeError, ValueError):
        return None


def _steps_of_run(store, run_id: str) -> list[dict]:
    rows = store.con.execute(
        "SELECT * FROM workflow_step WHERE run_id = ? ORDER BY ordinal, rowid", (run_id,)
    ).fetchall()
    return [_step_row(row) for row in rows]


def _persist_step(store, run_id: str, ctx: WorkflowContext, ordinal: int, *,
                  status: str, output: Any = None, error: str | None = None,
                  degraded: bool = False, started: str = "", finished: str = "",
                  model: str = "", tokens: int = 0, input_payload: Any = None) -> None:
    """写一行 workflow_step（按 run_id + node_id 幂等覆盖）。"""
    node = ctx.node or {}
    step_id = "%s:%s" % (run_id, ctx.node_id)
    payload = _clip_json(output if output is not None else {})
    meta = dict(ctx.step_meta.get("metrics") or {})
    meta["attempts"] = _as_list(ctx.step_meta.get("attempts"))
    meta["ms"] = ctx.step_meta.get("ms")
    if meta["ms"] is None:
        meta["ms"] = (ctx.step_meta.get("metrics") or {}).get("ms")
    meta["degraded_reasons"] = dict(ctx.step_meta.get("degraded_reasons") or {})
    payload["_meta"] = meta
    input_data = input_payload if input_payload is not None else _node_input(ctx)
    with store._txn() as con:
        con.execute(
            "INSERT INTO workflow_step(id, run_id, ordinal, node_id, name, kind, status, model, "
            "input, output, error, degraded, started_at, finished_at, tokens) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) "
            "ON CONFLICT(id) DO UPDATE SET status = excluded.status, model = excluded.model, "
            "input = excluded.input, output = excluded.output, error = excluded.error, "
            "degraded = excluded.degraded, started_at = excluded.started_at, "
            "finished_at = excluded.finished_at, tokens = excluded.tokens",
            (
                step_id, run_id, ordinal, ctx.node_id, str(node.get("name") or ctx.node_id),
                str(node.get("kind") or ""), status, model or None,
                dumps(_clip_json(input_data, INPUT_LIMIT)), dumps(payload), error,
                1 if degraded else 0, started or None, finished or None, int(tokens or 0),
            ),
        )


def _persist_run(store, run_id: str, *, status: str | None = None, output: Any = None,
                 error: str | None = None, finished: str | None = None,
                 degraded: Iterable[str] | None = None, meta: Mapping[str, Any] | None = None,
                 started: str | None = None) -> None:
    """更新 workflow_run 的状态/产物/耗时。"""
    sets: list[str] = []
    args: list[Any] = []
    if status is not None:
        sets.append("status = ?")
        args.append(status)
    if output is not None:
        sets.append("output = ?")
        args.append(dumps(_clip_json(output, OUTPUT_LIMIT * 4)))
    if error is not None or status in ("ok", "partial", "cancelled"):
        sets.append("error = ?")
        args.append(error)
    if finished is not None:
        sets.append("finished_at = ?")
        args.append(finished)
    if started is not None:
        sets.append("started_at = ?")
        args.append(started)
    if degraded is not None or meta is not None:
        row = store.con.execute(
            "SELECT metadata FROM workflow_run WHERE id = ?", (run_id,)
        ).fetchone()
        current = loads(row["metadata"], {}) if row is not None else {}
        current = current if isinstance(current, dict) else {}
        if degraded is not None:
            current["degraded"] = list(dict.fromkeys(str(x) for x in degraded))
        if meta:
            for key, value in meta.items():
                current[key] = value
        sets.append("metadata = ?")
        args.append(dumps(current))
    if not sets:
        return
    args.append(run_id)
    with store._txn() as con:
        con.execute("UPDATE workflow_run SET %s WHERE id = ?" % ", ".join(sets), tuple(args))


def _cancel_requested(store, run_id: str) -> bool:
    """取消标记放在 workflow_run.metadata.cancel_requested，跨进程/线程可见。"""
    try:
        row = store.con.execute(
            "SELECT metadata FROM workflow_run WHERE id = ?", (run_id,)
        ).fetchone()
    except sqlite3.Error:  # pragma: no cover
        return False
    if row is None:
        return False
    meta = loads(row["metadata"], {}) or {}
    return bool(isinstance(meta, dict) and meta.get("cancel_requested"))


class RunEmitter:
    """SSE 广播 + audit 留痕。emitter 可为任意 callable(payload) 或带 emit 的对象。"""

    def __init__(self, store: Any, emitter: Any = None) -> None:
        self.store = store
        self.emitter = emitter

    def emit(self, event_type: Any, data: Mapping[str, Any] | None = None) -> bool:
        """emit("type", data) 或 emit({"type": ..., "data": ...}) 两种形态都接受。"""
        if isinstance(event_type, Mapping):
            payload = {"type": str(event_type.get("type") or "event"),
                       "data": dict(event_type.get("data") or {})}
        else:
            payload = {"type": str(event_type), "data": dict(data or {})}
        delivered = False
        target = self.emitter
        if target is not None:
            try:
                if callable(target):
                    target(payload)
                    delivered = True
                elif hasattr(target, "emit"):
                    target.emit(payload)
                    delivered = True
                elif hasattr(target, "put"):
                    target.put(payload)
                    delivered = True
            except Exception:  # 广播失败绝不影响运行
                delivered = False
        try:
            self.store.audit("workflow.event", str(data.get("run_id") or ""), actor="workflow",
                             detail={"type": event_type, "delivered": delivered,
                                     "node": data.get("node_id"), "status": data.get("status")})
        except Exception:  # pragma: no cover
            pass
        return delivered


# ============================================================
# 7. 节点输入快照（可复现：step.input 存实际喂进去的东西）
# ============================================================
def _node_input(ctx: WorkflowContext) -> dict:
    """节点实际可见的输入摘要（落 workflow_step.input）。"""
    visible: dict[str, Any] = {}
    for nid, art in ctx.artifacts.items():
        if not isinstance(art, Mapping):
            visible[nid] = {"type": type(art).__name__}
            continue
        brief: dict[str, Any] = {}
        for key in ("status", "mode", "summary", "title", "degraded", "values", "items",
                    "units", "hits", "candidates", "text"):
            if key not in art:
                continue
            value = art.get(key)
            if isinstance(value, list):
                brief[key] = len(value)
            elif isinstance(value, str):
                brief[key] = _clip_text(value, 80)
            else:
                brief[key] = value
        visible[nid] = brief
    return {
        "node": ctx.node_id,
        "kind": ctx.node.get("kind"),
        "params": dict(ctx.params),
        "inputs": {k: _clip_text(v, 120) if isinstance(v, str) else v
                   for k, v in ctx.inputs.items() if not isinstance(v, (dict, list))},
        "scope": ctx.scope,
        "visible": visible,
    }



# ============================================================
# 8. 输入规整（input 节点与 executor 共用）
# ============================================================
#: 模板 inputs 里出现的中文说明 → 语义槽位
SLOT_HINTS: dict[str, str] = {
    "原文": "content", "内容": "content", "文本": "content", "检索": "query", "查询": "query",
    "工作区": "workspace", "目标": "scope", "作用域": "scope", "候选": "candidate",
    "记忆": "memory", "文档": "path", "文件": "path", "目录": "path", "会话": "session",
    "智能体": "agent", "时间窗": "since", "预算": "budget", "主题": "topic", "数量": "count",
    "题目": "count", "幂等": "event_id", "生效": "valid_from", "上次": "since",
}
REQUIRED_ALWAYS = ("content",)
REQUIRED_BY_SLOT: dict[str, tuple[str, ...]] = {
    "query": ("query", "content", "text"),
    "candidate": ("candidate", "content", "memory", "text"),
    "memory": ("memory", "candidate", "content", "text"),
    "document": ("path", "content", "text"),
    "topic": ("topic", "query", "content", "text"),
    "session": ("session", "turns", "content", "text"),
    "workspace": ("workspace", "path", "scope"),
}
#: 只有这些槽位会被当作「必填」；其余（时间窗 / 预算 / 智能体名）按可选处理
REQUIRED_SLOTS: tuple[str, ...] = ("content", "query", "candidate", "memory", "document",
                                   "session", "workspace", "topic")
SLOT_KEYWORDS: dict[str, tuple[str, ...]] = {
    "query": ("query", "q", "关键词", "检索语句"),
    "candidate": ("candidate", "candidate_id"),
    "memory": ("memory", "memory_id", "mid"),
    "document": ("path", "document", "file"),
    "topic": ("topic", "topic_id"),
    "session": ("session", "session_id", "turns", "window", "since"),
    "workspace": ("workspace", "project"),
}
TEXT_KEYS = ("content", "text", "body", "query", "memory", "candidate", "topic")


def _slot_of(description: Any) -> str:
    """把模板 inputs 的中文说明映射成语义槽位。"""
    text = str(description or "")
    for hint, slot in SLOT_HINTS.items():
        if hint in text:
            return slot
    return ""


def _coerce_value(key: str, value: Any) -> Any:
    """按 key 规整类型：预算/数量转 int，其余保留。"""
    if key in ("budget", "count", "limit", "top_k") and isinstance(value, str):
        digits = re.findall(r"-?\d+", value)
        if digits:
            return int(digits[0])
    return value


def _input_requirements(node: Mapping[str, Any], template: Mapping[str, Any],
                        nodes: dict[str, dict], parents: dict[str, list[dict]]) -> list[str]:
    """input 节点真正需要的输入槽位。

    默认看模板 inputs 声明（中文说明 → 槽位）；若该节点有上游且上游是 input，
    则由上游负责，避免重复要求。额外声明 required 时以声明为准。
    """
    params = _as_dict(node.get("params"))
    declared = params.get("required")
    if isinstance(declared, (list, tuple)):
        return [str(x) for x in declared]
    if any(edge["from"] in nodes for edge in parents.get(str(node.get("id")), [])):
        return []
    slots: list[str] = []
    for key, description in (_as_dict(template.get("inputs"))).items():
        slot = _slot_of(description) or str(key)
        if slot in REQUIRED_SLOTS and slot not in slots:
            slots.append(slot)
    if not slots:
        return list(REQUIRED_ALWAYS)
    return slots


def _strict_required(node: Mapping[str, Any]) -> bool:
    """节点是否显式声明了 required=[...]（声明即严格，不再做同文本回填）。"""
    return isinstance(_as_dict(node.get("params")).get("required"), (list, tuple))


def _primary_text(norm: Mapping[str, Any]) -> str:
    """取一段可用于回填的正文：优先 content/text，其次 query/memory 等文本键。"""
    for key in ("content", "text", "body", "query", "memory", "candidate", "topic"):
        value = norm.get(key)
        if isinstance(value, str) and value.strip():
            return value
        if isinstance(value, Mapping):
            body = _text_of(value)
            if body.strip():
                return body
    return ""


def _normalize_inputs(raw: Any) -> dict:
    """inputs 规整：dict 直接用；JSON 串解析；其它标量包成 content。"""
    if raw is None:
        return {}
    if isinstance(raw, Mapping):
        return {str(k): v for k, v in raw.items()}
    if isinstance(raw, str):
        parsed = loads(raw.strip(), None) if raw.strip().startswith("{") else None
        if isinstance(parsed, dict):
            return {str(k): v for k, v in parsed.items()}
        return {"content": raw}
    return {"content": raw}


def _present(value: Any) -> bool:
    if value is None:
        return False
    if isinstance(value, str):
        return bool(value.strip())
    if isinstance(value, (list, tuple, dict, set)):
        return len(value) > 0
    return True


def _satisfied(norm: Mapping[str, Any], slot: str, *, strict: bool = False) -> bool:
    """某个槽位是否已被满足。

    strict=True（显式 required 声明）时只看该槽位自己的键，不做文本别名回退，
    这样 required=["content","query"] 才能真的要求两个都有。
    """
    for key in SLOT_KEYWORDS.get(slot, (slot,)) + (slot,):
        if _present(norm.get(key)):
            return True
        # 允许 <slot>_id 这类命名
        for name, value in norm.items():
            if name.startswith(key + "_") and _present(value):
                return True
    if strict:
        return False
    if slot in ("query", "candidate", "memory", "topic", "document", "content", "session"):
        for key in TEXT_KEYS:
            if _present(norm.get(key)):
                return True
    if slot == "workspace" and (_present(norm.get("scope")) or _present(norm.get("path"))):
        return True
    return False


# ============================================================
# 9. 节点实现 · A 组（input / transform / extract / classify / retrieve）
# ============================================================
def node_input(ctx: WorkflowContext, node: dict) -> dict:
    """校验并规整输入；缺失必填项抛 WorkflowInputError。"""
    raw = ctx.inputs
    norm = _normalize_inputs(raw)
    template = _as_dict(ctx.step_meta.get("template"))
    nodes = _node_map(template.get("nodes") or [])
    parents = _parent_map(template.get("edges") or [], nodes)
    required = _input_requirements(node, template, nodes, parents)

    # 宽容语义（2026-10-19 决策）：模板声明的多个槽位里，只要有一个"主槽位"被满足，
    # 其余槽位就用同一段文本回填，而不是硬性拒绝。理由：用户点一次「运行」不该被
    # 三四个必填项挡在门外；真实缺信息时下游节点会自己降级并留痕，比入口报错更有用。
    # 严格模式：节点 params 里显式声明 required=[...] 时，behavior 与旧版一致（逐项校验）。
    strict = _strict_required(node)
    backfilled: list[str] = []
    donor = _primary_text(norm)
    if strict:
        # 严格模式：逐项按自己的键校验，不做任何回填
        missing = [slot for slot in required if not _satisfied(norm, slot, strict=True)]
    elif not required:
        missing = []
    elif not donor and not any(_satisfied(norm, slot) for slot in required):
        # 一个可用输入都没有：这是唯一硬失败条件
        missing = list(required)
    else:
        for slot in required:
            if _satisfied(norm, slot):
                continue
            if donor:
                norm[slot] = donor
                backfilled.append(slot)
        missing = [slot for slot in required if not _satisfied(norm, slot)]
    if missing:
        raise WorkflowInputError(
            "模板 %s 缺少必填输入：%s（已给：%s）"
            % (ctx.template_id, ", ".join(missing), ", ".join(sorted(norm)) or "无")
        )

    coerced = {key: _coerce_value(key, value) for key, value in norm.items()}
    # 语义别名：让下游节点总能拿到 content / query
    text = ""
    for key in TEXT_KEYS:
        value = coerced.get(key)
        if isinstance(value, str) and value.strip():
            text = value
            break
    if text:
        coerced.setdefault("content", text)
    if "content" not in coerced and "text" not in coerced:
        coerced["content"] = json.dumps(coerced, ensure_ascii=False, default=str)

    ctx.note({"chars": len(str(coerced.get("content") or "")), "slots": len(required)})
    return {
        "status": "ok",
        "inputs": coerced,
        "required": required,
        "strict": strict,
        "backfilled": backfilled,
        "provided": sorted(k for k, v in coerced.items() if _present(v)),
        "text": _clip_text(coerced.get("content"), TEXT_LIMIT),
        "chars": len(str(coerced.get("content") or "")),
        "scope": ctx.scope,
    }


def node_transform(ctx: WorkflowContext, node: dict) -> dict:
    """分片 / 切块 / 归一化 / 字段裁剪 / 预算打包（按 params 选择实现）。"""
    params = ctx.params
    algorithm = str(params.get("algorithm") or params.get("mode") or "").strip().lower()
    text = ctx.text_for("text", "content", "body")

    if algorithm in ("greedy-budget", "budget", "budget-pack", "pack"):
        return _pack_budget(ctx, params)
    if algorithm in ("normalize", "clean", "canonical"):
        norm = _norm(text)
        return {"status": "ok", "mode": "normalize", "text": _clip_text(norm),
                "chars": len(norm), "hash": _hash(norm)}
    if algorithm in ("split", "sentence-split", "split-sentences", "atomic", "propositions",
                     "one-proposition"):
        return _split_sentences(text, params)
    if algorithm in ("fields", "project", "select", "trim"):
        keep = [str(x) for x in _as_list(params.get("fields") or params.get("keep"))]
        items = [_trim_fields(item, keep) for item in ctx.values()]
        return {"status": "ok", "mode": "fields", "items": items, "count": len(items)}
    if "chunk" in algorithm or "tokens" in params or "chunk_tokens" in params or \
            params.get("headings") or params.get("keep_headings") or params.get("math") or \
            params.get("extract_filters"):
        return _chunk_text(ctx, params, text)
    if algorithm in ("lessons", "lesson"):
        return _lessons(ctx, params)
    norm = _norm(text)
    return {"status": "ok", "mode": "normalize", "text": _clip_text(norm), "chars": len(norm)}


def _trim_fields(item: Any, keep: list[str]) -> dict:
    if not isinstance(item, Mapping):
        return {"value": item}
    if not keep:
        return dict(item)
    return {key: item.get(key) for key in keep if key in item}


def _chunk_text(ctx: WorkflowContext, params: Mapping[str, Any], text: str) -> dict:
    """分片 / 切块：按 token 走 chunking，附带标题与公式识别。"""
    max_tokens = _as_int(params.get("chunk_tokens") or params.get("tokens")
                         or params.get("max_tokens"), 900)
    overlap = _as_int(params.get("overlap"), 120)
    keep_headings = bool(params.get("headings") or params.get("keep_headings"))
    chunks = []
    try:
        if keep_headings or "#" in text:
            chunks = chunking.chunk_markdown(text, max_tokens=max_tokens, overlap=overlap)
        else:
            chunks = chunking.chunk_text(text, max_tokens=max_tokens, overlap=overlap)
    except Exception as exc:  # chunking 不可用时的最小实现
        ctx.mark_degraded("chunking", type(exc).__name__)
        chunks = _fallback_chunks(text, max_tokens, overlap)
    units = [{"ordinal": i, "text": c.get("text") or "", "heading": c.get("heading") or "",
              "tokens": _as_int(c.get("tokens"), _est_tokens(c.get("text"))),
              "hash": c.get("hash") or _hash(c.get("text"))}
             for i, c in enumerate(chunks)]
    formulas = [u["text"] for u in units if "$" in u["text"] or "\\(" in u["text"]]
    headings = [u["heading"] for u in units if u["heading"]]
    out = {
        "status": "ok", "mode": "chunk", "units": units, "count": len(units),
        "max_tokens": max_tokens, "overlap": overlap,
        "headings": list(dict.fromkeys(headings))[:20],
        "formulas": formulas[:10], "tokens": sum(u["tokens"] for u in units),
    }
    if params.get("math"):
        out["math"] = [f for f in formulas if any(ch in f for ch in ("$", "\\frac", "^", "_"))]
    if params.get("extract_filters"):
        out["filters"] = _extract_filters(text)
    if params.get("cite"):
        out["citations"] = [{"ref": "[%d]" % (i + 1), "hash": u["hash"]}
                            for i, u in enumerate(units)]
    return out


def _fallback_chunks(text: str, max_tokens: int, overlap: int) -> list[dict]:
    """chunking 模块不可用时的行/段切分。"""
    paragraphs = [p.strip() for p in re.split(r"\n{2,}", text or "") if p.strip()] or [text]
    out: list[dict] = []
    buffer: list[str] = []
    used = 0
    for paragraph in paragraphs:
        cost = _est_tokens(paragraph)
        if buffer and used + cost > max_tokens:
            body = "\n\n".join(buffer)
            out.append({"text": body, "heading": "", "tokens": used, "hash": _hash(body)})
            buffer = [body[-max(0, overlap):]] if overlap else []
            used = _est_tokens(buffer[0]) if buffer else 0
        buffer.append(paragraph)
        used += cost
    if buffer:
        body = "\n\n".join(buffer)
        out.append({"text": body, "heading": "", "tokens": used, "hash": _hash(body)})
    return out


def _extract_filters(text: str) -> dict:
    """从查询串里抠过滤子句：key:value / kind=x / scope=…"""
    filters: dict[str, Any] = {}
    for match in re.finditer(r"([A-Za-z_]{2,20})\s*[:=]\s*([^\s,;]+)", text or ""):
        filters[match.group(1).lower()] = match.group(2)
    return filters


def _split_sentences(text: str, params: Mapping[str, Any]) -> dict:
    """拆句 / 命题原子化：一句一个单位，保留哈希便于去重。"""
    units = []
    for index, sentence in enumerate(_sentences(text)):
        if len(sentence.strip()) < 2:
            continue
        units.append({"ordinal": index, "text": _clip_text(sentence, 400),
                      "hash": _hash(sentence), "chars": len(sentence)})
    return {"status": "ok", "mode": "split", "units": units, "count": len(units)}


def _pack_budget(ctx: WorkflowContext, params: Mapping[str, Any]) -> dict:
    """贪心预算打包（token 预算）；没有候选时退化为文本切块。"""
    budget = _as_int(params.get("budget") or ctx.inputs.get("budget"), 800)
    items = _candidates(ctx, ("items", "hits", "values", "results"))
    if not items:
        text = ctx.text_for("text", "content", "body")
        units = _chunk_text(ctx, {"tokens": max(80, budget // 2), "overlap": 0}, text)["units"]
        packed = []
        used = 0
        for unit in units:
            cost = _as_int(unit.get("tokens"), 1)
            if used + cost > budget:
                continue
            packed.append(unit)
            used += cost
        return {"status": "ok", "algorithm": "greedy-budget", "packed": packed,
                "count": len(packed), "tokens": used, "budget": budget}
    normalized = []
    for item in items:
        row = dict(item) if isinstance(item, Mapping) else {"id": _hash(item), "title": str(item)}
        row.setdefault("tokens", _est_tokens(_text_of(row)))
        row.setdefault("score", 0.0)
        normalized.append(row)
    try:
        packed, used = retrieval.pack_budget(normalized, budget)
    except Exception:
        packed, used = normalized, sum(int(i.get("tokens") or 0) for i in normalized)
    lines = []
    for index, item in enumerate(packed):
        ref = "[%d]" % (index + 1) if params.get("cite") else ""
        lines.append("%s %s %s" % (ref, item.get("title") or item.get("id") or "",
                                   _clip_text(_text_of(item), 120)))
    return {"status": "ok", "algorithm": "greedy-budget", "items": packed,
            "count": len(packed), "tokens": used, "budget": budget,
            "text": "\n".join(lines)}


def _lessons(ctx: WorkflowContext, params: Mapping[str, Any]) -> dict:
    """把抽取结果压成「经验」条目（复盘用）。"""
    kind = str(params.get("kind") or "experience")
    items = _candidates(ctx, ("items", "values", "results"))
    lessons = []
    for item in items:
        row = dict(item) if isinstance(item, Mapping) else {"body": str(item)}
        body = _text_of(row)
        if not body.strip():
            continue
        lessons.append({
            "title": row.get("title") or _rule_title(body),
            "body": _clip_text(body, 600),
            "kind": kind,
            "fields": {k: row.get(k) for k in ("context", "options", "choice", "rationale",
                                               "outcome", "reusable_lesson") if row.get(k)},
            "hash": _hash(body),
        })
    return {"status": "ok", "kind": kind, "items": lessons, "count": len(lessons)}


#: 记忆类型（与 store.MEMORY_KINDS 对齐，避免硬依赖）
KINDS_OF_MEMORY = ("fact", "knowledge", "decision", "preference", "procedure", "experience",
                   "task", "turn", "tool", "artifact")


def node_extract(ctx: WorkflowContext, node: dict) -> dict:
    """抽取候选：有 gw 走 LLM，无则规则抽取（标题 + 句子 + 意图词）。"""
    params = ctx.params
    text = ctx.text_for("text", "content", "body")
    if not text.strip():
        return {"status": "ok", "mode": "empty", "items": [], "count": 0,
                "reason": "上游没有可抽取的文本"}

    quote_required = bool(params.get("quote_required"))
    if ctx.use_llm and ctx.gw is not None:
        items = _llm_extract(ctx, text, params)
        if items:
            ctx.note({"llm_items": len(items)})
            return {"status": "ok", "mode": "llm", "items": items, "count": len(items),
                    "quote_required": quote_required, "model": _active_label(ctx.gw, "extractor")}
    items = _rule_extract(text, params)
    ctx.mark_degraded("extract", "未配置可用的抽取模型，使用规则抽取")
    return {"status": "ok", "mode": "rule", "items": items, "count": len(items),
            "quote_required": quote_required, "degraded": True,
            "intents": _intent_words(text), "keywords": _keywords_of(text)[:8]}


def _llm_extract(ctx: WorkflowContext, text: str, params: Mapping[str, Any]) -> list[dict]:
    """LLM 抽取；失败返回空列表交给规则兜底（不抛出，避免整条 run 失败）。"""
    try:
        prompt = prompts.render_named("extract", {"chunk": _clip_text(text, 6000)})
        if not prompt.strip():
            return []
        reply = ctx.gw.chat([{"role": "user", "content": prompt}], role="extractor",
                            max_tokens=900, temperature=0.1)
        payload = prompts.parse_json(reply, expect=(dict, list))
    except Exception as exc:
        if _unavailable(exc):
            raise ModelUnavailable("extractor", str(exc)) from exc
        ctx.mark_degraded("extract", "LLM 抽取失败：%s" % type(exc).__name__)
        return []
    rows = payload if isinstance(payload, list) else payload.get("items") or []
    out = []
    for row in _as_list(rows):
        if not isinstance(row, Mapping):
            continue
        body = str(row.get("body") or row.get("text") or "").strip()
        if not body:
            continue
        out.append({
            "title": _clip_text(row.get("title") or _rule_title(body), 120),
            "body": _clip_text(body, 1200),
            "kind": _kind_of(row.get("kind"), KINDS_OF_MEMORY),
            "category": _clip_text(row.get("category") or "general", 40),
            "importance": _clamp(row.get("importance"), 0.5),
            "confidence": _clamp(row.get("confidence"), 0.5),
            "quote": _clip_text(row.get("quote") or "", 400),
            "source": "llm",
        })
    return out


def _rule_extract(text: str, params: Mapping[str, Any]) -> list[dict]:
    """规则抽取：按标题/段落切候选，标题取首句，正文按句聚合成一条断言。"""
    heading = ""
    for line in str(text or "").splitlines():
        match = _HEADING_RE.match(line)
        if match:
            heading = match.group(2).strip()
            break
    sentences = _sentences(text)
    if not sentences:
        sentences = [str(text).strip()] if str(text).strip() else []
    max_items = _as_int(params.get("max_items"), 5)
    items: list[dict] = []
    for index, sentence in enumerate(sentences[:max_items]):
        body = sentence.strip()
        if len(body) < 2:
            continue
        title = heading or _rule_title(body)
        if index > 0 and heading:
            title = "%s · %s" % (heading, _clip_text(body, 24))
        items.append({
            "title": _clip_text(title, 120),
            "body": _clip_text(body, 800),
            "kind": _guess_kind(body),
            "category": "general",
            "importance": 0.55 if len(body) >= 40 else 0.4,
            "confidence": 0.45,
            "quote": _clip_text(body, 400),
            "source": "rule",
        })
    return items


def _guess_kind(text: str) -> str:
    """关键词猜记忆类型（与 judge.rule_classify 同口径，但独立可用）。"""
    lowered = str(text or "").lower()
    rules = (
        ("preference", ("我喜欢", "我讨厌", "偏好", "习惯", "prefer", "always use", "never use")),
        ("decision", ("决定", "采用", "选定", "改为", "decided", "we will use")),
        ("task", ("待办", "todo", "下一步", "需要完成", "follow up")),
        ("procedure", ("步骤", "流程", "先", "然后", "最后", "step 1", "how to")),
        ("experience", ("踩坑", "经验", "教训", "lesson", "gotcha")),
        ("tool", ("命令", "脚本", "接口", "curl", "command", "api")),
        ("artifact", ("文件", "文档", "路径", "仓库", "http://", "https://", ".md")),
        ("knowledge", ("定义", "原理", "概念", "定理", "公式", "是指")),
    )
    for kind, cues in rules:
        if any(cue in lowered for cue in cues):
            return kind
    return "fact"


def node_classify(ctx: WorkflowContext, node: dict) -> dict:
    """分类：优先 judge.classify（自带 LLM→规则兜底），缺失时用本地关键词规则。"""
    params = ctx.params
    kinds = [str(k) for k in _as_list(params.get("kinds")) if str(k) in KINDS_OF_MEMORY] \
        or list(KINDS_OF_MEMORY)
    items = _candidates(ctx, ("items", "candidates", "values", "results"))
    if not items:
        text = ctx.text_for("text", "content", "body")
        items = [{"title": _rule_title(text), "body": text}]
    out_items = []
    degraded = False
    reason = ""
    for item in items:
        row = dict(item) if isinstance(item, Mapping) else {"body": str(item)}
        body = _text_of(row) or str(row.get("title") or "")
        if judge_mod is not None:
            verdict = judge_mod.classify(ctx.store, ctx.gw, body, kinds)
            degraded = degraded or bool(verdict.get("degraded"))
            reason = reason or str(verdict.get("reason") or "")
            merged = dict(row)
            merged.update({
                "kind": _kind_of(verdict.get("kind"), kinds),
                "category": verdict.get("category") or row.get("category") or "general",
                "importance": _clamp(verdict.get("importance"),
                                     _as_float(row.get("importance"), 0.5)),
            })
            out_items.append(merged)
        else:
            kind = _guess_kind(body)
            kind = kind if kind in kinds else kinds[0]
            merged = dict(row)
            merged.update({"kind": kind, "category": "general",
                           "importance": _clamp(row.get("importance"), 0.5)})
            out_items.append(merged)
            degraded = True
            reason = "judge 模块不可用"
    if degraded:
        ctx.mark_degraded("classify", reason or "规则分类")
    return {"status": "ok", "items": out_items, "count": len(out_items), "kinds": kinds,
            "degraded": degraded, "reason": reason}


def node_retrieve(ctx: WorkflowContext, node: dict) -> dict:
    """召回：调 retrieval.search（参数来自 node.params），另含图扩展 / 近似召回 / 证据链。"""
    params = ctx.params
    query = str(params.get("query") or ctx.text_for("query", "text", "content") or "").strip()
    top_k = _as_int(params.get("top_k") or params.get("limit"), 20)
    scope = str(params.get("scope") or ctx.scope or "global")
    engine = str(params.get("engine") or "").strip().lower()
    by = str(params.get("by") or "").strip().lower()

    if by in ("evidence_chain", "evidence"):
        return _evidence_chain(ctx, params)
    if engine == "graph":
        return _graph_expand(ctx, params, query)
    methods = _as_list(params.get("methods"))
    if methods or "min_score" in params:
        return _near_dup(ctx, params, query, top_k, scope)

    strategy = "hybrid"
    if engine in ("fts5", "fts", "bm25", "fulltext"):
        strategy = "bm25"
    elif engine in ("vector", "semantic", "embedding"):
        strategy = "vector"
    elif engine == "substring":
        strategy = "substring"
    if query:
        res = retrieval.search(ctx.store, ctx.gw, query, scope=scope, limit=top_k,
                               strategy=strategy)
    else:
        res = {"hits": [], "degraded": ["query: 空查询，跳过召回"], "total": 0,
               "strategy": strategy}
    hits = list(res.get("hits") or [])
    degraded = list(res.get("degraded") or [])
    for hit in hits:
        if not isinstance(hit, dict):
            continue
        title = str(hit.get("title") or "")
        snippet = str(hit.get("snippet") or "")
        blend = max(_jaccard(query, title), _jaccard(query, snippet)) if query else 0.0
        hit["sim"] = round(_clamp(blend), 4)
        hit["score"] = round(_as_float(hit.get("score"), 0.0), 6)
        hit["title"] = title
    for reason in degraded:
        ctx.mark_degraded(str(reason).split(":")[0].strip() or "retrieve", str(reason))
    ctx.note({"hits": len(hits), "strategy": strategy,
              "tokens": sum(_as_int(h.get("tokens")) for h in hits if isinstance(h, dict))})
    return {"status": "ok", "engine": engine or "hybrid",
            "strategy": res.get("strategy", strategy), "hits": hits, "count": len(hits),
            "total": res.get("total", len(hits)), "query": query, "scope": scope,
            "degraded": bool(degraded), "degraded_reasons": degraded}


def _evidence_chain(ctx: WorkflowContext, params: Mapping[str, Any]) -> dict:
    """按 id 追踪证据链（trace_a / trace_b 用）。"""
    target = str(params.get("id") or ctx.inputs.get("a_id") or ctx.inputs.get("b_id") or "")
    if not target:
        for key in ("a_id", "b_id", "memory", "id"):
            if ctx.inputs.get(key):
                target = str(ctx.inputs[key])
                break
    if not target:
        return {"status": "ok", "by": "evidence_chain", "hits": [], "count": 0,
                "reason": "没有可追踪的 id"}
    memory = None
    try:
        memory = ctx.store.get_memory(target)
    except Exception:
        memory = None
    if memory is None:
        return {"status": "ok", "by": "evidence_chain", "hits": [], "count": 0,
                "reason": "记忆不存在：%s" % target}
    evidence = []
    try:
        evidence = ctx.store.list_evidence(target) or []
    except Exception:
        evidence = []
    chain = [{
        "id": memory.get("id"), "title": memory.get("title"), "kind": memory.get("kind"),
        "status": memory.get("status"), "trust": _as_float(memory.get("trust"), 0.5),
        "recorded_at": memory.get("recorded_at"), "evidence": len(evidence),
        "evidence_kinds": list(dict.fromkeys(str(e.get("kind")) for e in evidence)),
        "quotes": [_clip_text(e.get("quote"), 200) for e in evidence if e.get("quote")][:5],
    }]
    return {"status": "ok", "by": "evidence_chain", "hits": chain, "count": len(chain),
            "values": chain}


def _graph_expand(ctx: WorkflowContext, params: Mapping[str, Any], query: str) -> dict:
    """实体图扩展：从图视图里按 query 命中节点，再取 hops 邻居。"""
    hops = max(1, _as_int(params.get("hops"), 1))
    top_k = _as_int(params.get("top_k"), 20)
    try:
        graph = ctx.store.graph("semantic", ctx.scope, 500)
    except Exception as exc:
        ctx.mark_degraded("graph", "图视图不可用：%s" % type(exc).__name__)
        graph = {"nodes": [], "edges": []}
    nodes = [n for n in _as_list(graph.get("nodes")) if isinstance(n, Mapping)]
    edges = [e for e in _as_list(graph.get("edges")) if isinstance(e, Mapping)]
    seeds = []
    if query:
        for node in nodes:
            label = str(node.get("label") or node.get("title") or "")
            if query and label and (query in label or label in query):
                seeds.append(str(node.get("id")))
    if not seeds:
        seeds = [str(n.get("id")) for n in nodes[:3]]
    reachable = set(seeds)
    frontier = set(seeds)
    for _ in range(hops):
        nxt = set()
        for edge in edges:
            src, dst = str(edge.get("src")), str(edge.get("dst"))
            if src in frontier and dst not in reachable:
                nxt.add(dst)
            elif dst in frontier and src not in reachable:
                nxt.add(src)
        reachable |= nxt
        frontier = nxt
    by_id = {str(n.get("id")): n for n in nodes}
    hits = []
    for nid in reachable:
        node = by_id.get(nid)
        if not node:
            continue
        hits.append({"id": nid, "title": node.get("label") or node.get("title") or nid,
                     "kind": node.get("kind") or "entity",
                     "score": 1.0 if nid in seeds else 0.5,
                     "sim": 1.0 if nid in seeds else 0.5,
                     "hops": 0 if nid in seeds else hops})
    hits.sort(key=lambda h: (-h["score"], str(h["id"])))
    hits = hits[:top_k]
    return {"status": "ok", "engine": "graph", "hits": hits, "count": len(hits),
            "nodes": len(nodes), "edges": len(edges), "seeds": len(seeds)}


def _near_dup(ctx: WorkflowContext, params: Mapping[str, Any], query: str,
              top_k: int, scope: str) -> dict:
    """近似召回（去重场景）：召回候选 → 逐条算 simhash/jaccard/余弦，落 0-1 相似度。"""
    methods = [str(m).lower() for m in _as_list(params.get("methods"))] or ["cosine"]
    min_score = _as_float(params.get("min_score"), 0.0)
    raw = (ctx.inputs.get("content") or ctx.inputs.get("candidate")
           or ctx.text_for("content", "text", "candidate") or query or "")
    probe = _text_of(raw) if isinstance(raw, Mapping) else str(raw or "")
    if probe.strip():
        res = retrieval.search(ctx.store, ctx.gw, probe[:500], scope=scope,
                               limit=max(top_k * 3, 20), strategy="hybrid")
    else:
        res = {"hits": [], "degraded": [], "total": 0}
    hits = []
    probe_vec = _l2(vectors.hash_embed(probe)) if probe.strip() else []
    for hit in _as_list(res.get("hits")):
        if not isinstance(hit, Mapping):
            continue
        text = "%s\n%s" % (hit.get("title") or "", hit.get("snippet") or "")
        sims = {}
        if "simhash" in methods:
            sims["simhash"] = round(_simhash_similarity(probe, text), 4)
        if "jaccard" in methods:
            sims["jaccard"] = round(_jaccard(probe, text), 4)
        if "cosine" in methods or not sims:
            sims["cosine"] = round(_cosine(probe_vec, _l2(vectors.hash_embed(text))), 4)
        best = max(sims.values()) if sims else 0.0
        if best < min_score:
            continue
        hits.append({
            "id": hit.get("id"), "title": hit.get("title") or "", "kind": hit.get("kind"),
            "snippet": _clip_text(hit.get("snippet") or "", 240), "score": round(best, 4),
            "sim": round(best, 4), "sims": sims, "trust": hit.get("trust"),
            "citation": hit.get("citation"),
        })
    hits.sort(key=lambda h: (-h["sim"], str(h.get("id"))))
    hits = hits[:top_k]
    degraded = list(res.get("degraded") or [])
    for reason in degraded:
        ctx.mark_degraded(str(reason).split(":")[0].strip() or "retrieve", str(reason))
    ctx.note({"hits": len(hits), "methods": methods})
    return {"status": "ok", "engine": "near-dup", "methods": methods, "hits": hits,
            "count": len(hits), "probe_chars": len(probe), "min_score": min_score,
            "degraded": bool(degraded)}


def _simhash(text: str, bits: int = 64) -> int:
    """simhash：token 哈希到位向量，按位加权求和后取符号。"""
    import hashlib

    tokens = _WORD_RE.findall(str(text or "").lower()) or list(str(text or ""))
    if not tokens:
        return 0
    vector = [0] * bits
    for token in tokens:
        digest = int(hashlib.md5(token.encode("utf-8")).hexdigest(), 16)
        for bit in range(bits):
            vector[bit] += 1 if (digest >> bit) & 1 else -1
    out = 0
    for bit in range(bits):
        if vector[bit] > 0:
            out |= 1 << bit
    return out


def _simhash_similarity(a: str, b: str) -> float:
    left, right = _simhash(a), _simhash(b)
    if not left and not right:
        return 0.0
    distance = bin(left ^ right).count("1")
    return max(0.0, 1.0 - distance / 64.0)


def _candidates(ctx: WorkflowContext, keys: Iterable[str]) -> list:
    """按 key 顺序在可见产物里找候选列表（同 key 取最近的产物）。"""
    for key in keys:
        for art in reversed(list(ctx.artifacts.values())):
            if isinstance(art, Mapping):
                value = art.get(key)
                if isinstance(value, list) and value:
                    return list(value)
    return ctx.values()



# ============================================================
# 10. 节点实现 · B 组（embed / rerank / fuse / judge / verify）
# ============================================================
def node_embed(ctx: WorkflowContext, node: dict) -> dict:
    """向量化：优先 gw.embed（云端），失败/缺失用 vectors.hash_embed；写 vector 表。"""
    params = ctx.params
    incremental = bool(params.get("incremental"))
    owner_kind = str(params.get("owner_kind") or "memory")
    items = _embed_targets(ctx)
    texts = [_text_of(item)[:2000] for item in items]
    if not texts:
        return {"status": "ok", "mode": "empty", "count": 0, "model": vectors.MODEL_LOCAL,
                "reason": "没有可向量化的对象"}

    mode = "hash"
    model = vectors.MODEL_LOCAL
    vecs: list[list[float]] = []
    if ctx.use_llm and ctx.gw is not None:
        try:
            vecs = [list(map(float, v)) for v in (ctx.gw.embed(texts) or [])]
            if len(vecs) != len(texts):
                raise ValueError("向量条数不符：%d != %d" % (len(vecs), len(texts)))
            mode = "cloud"
            model = _active_label(ctx.gw, "embedding") or "cloud-embed"
            ctx.note({"model": model})
        except Exception as exc:
            if _unavailable(exc):
                raise ModelUnavailable("embedding", str(exc)) from exc
            ctx.mark_degraded("embed", "云端向量失败：%s" % type(exc).__name__)
            vecs = []
    if not vecs:
        vecs = [_l2(vectors.hash_embed(text)) for text in texts]
        ctx.mark_degraded("vector", "未配置 embedding，使用本地 char n-gram hash（256 维）")

    dims = 0
    pairs = []
    for item, vec in zip(items, vecs):
        owner_id = _owner_id(item)
        dims = len(vec)
        if not owner_id:
            continue
        if incremental and _has_vector(ctx.store, owner_kind, owner_id, model):
            continue
        pairs.append((owner_id, vec))
    written = 0
    try:
        with vectors.VectorIndex(ctx.store, model=model) as index:
            written = index.put_many(owner_kind, pairs, model=model)
    except Exception as exc:
        ctx.mark_degraded("vector", "向量落库失败：%s" % type(exc).__name__)
        written = 0
    ctx.note({"vectors": written, "dim": dims, "tokens": sum(_est_tokens(t) for t in texts)})
    return {"status": "ok", "mode": mode, "model": model, "count": len(pairs),
            "written": written, "dim": dims, "owner_kind": owner_kind,
            "incremental": incremental}


def _embed_targets(ctx: WorkflowContext) -> list:
    """待向量化对象：优先上游 items/hits，其次 inputs.text/content。"""
    items = _candidates(ctx, ("items", "hits", "units", "values", "results"))
    if items:
        return items
    text = ctx.text_for("text", "content", "body")
    if text.strip():
        return [{"id": "text:" + _hash(text), "title": _rule_title(text), "body": text}]
    return []


def _owner_id(item: Any) -> str:
    if isinstance(item, Mapping):
        for key in ("id", "memory_id", "owner_id"):
            value = item.get(key)
            if value:
                return str(value)
        return "text:" + _hash(_text_of(item))
    return "text:" + _hash(str(item))


def _has_vector(store, owner_kind: str, owner_id: str, model: str) -> bool:
    try:
        row = store.con.execute(
            "SELECT 1 FROM vector WHERE owner_kind = ? AND owner_id = ? AND model = ?",
            (owner_kind, owner_id, model)).fetchone()
        return row is not None
    except sqlite3.Error:  # pragma: no cover
        return False


def node_rerank(ctx: WorkflowContext, node: dict) -> dict:
    """重排：调 gw.rerank；失败/未配置时分数透传并标 degraded。"""
    params = ctx.params
    top_k = _as_int(params.get("top_k"), 20)
    query = str(params.get("query") or ctx.text_for("query", "text", "content") or "")
    items = _candidates(ctx, ("hits", "items", "values", "results"))
    if not items:
        return {"status": "ok", "count": 0, "hits": [], "reason": "没有可重排的候选"}
    docs = [_text_of(item)[:2000] for item in items]
    degraded = False
    reason = ""
    model = ""
    order: list[tuple[int, float]] = []
    if ctx.use_llm and ctx.gw is not None:
        try:
            order = [(int(p[0]), float(p[1]))
                     for p in (ctx.gw.rerank(query, docs, top_k=top_k) or [])]
            model = _active_label(ctx.gw, "reranker")
        except Exception as exc:
            if _unavailable(exc):
                raise ModelUnavailable("reranker", str(exc)) from exc
            degraded, reason = True, "重排失败：%s" % type(exc).__name__
    else:
        degraded, reason = True, "未配置重排模型，分数透传"
    if not order:
        degraded = True
        reason = reason or "重排返回空，分数透传"
        order = [(idx, _as_float(item.get("score"), 0.0)) for idx, item in enumerate(items)]
    ranked = []
    for idx, value in order:
        if 0 <= idx < len(items):
            row = dict(items[idx]) if isinstance(items[idx], Mapping) else {"value": items[idx]}
            row["rerank_score"] = round(value, 6)
            row["score"] = round(value, 6)
            ranked.append(row)
    if not ranked:  # 返回的下标全部非法：保持原顺序
        ranked = [dict(i) if isinstance(i, Mapping) else {"value": i} for i in items]
        degraded, reason = True, "重排返回下标非法，分数透传"
    ranked = ranked[:top_k]
    if degraded:
        ctx.mark_degraded("rerank", reason)
    ctx.note({"hits": len(ranked), "model": model})
    return {"status": "ok", "hits": ranked, "items": ranked, "count": len(ranked),
            "algorithm": "score-passthrough" if degraded else "cross-encoder",
            "degraded": degraded, "reason": reason, "model": model}


def node_fuse(ctx: WorkflowContext, node: dict) -> dict:
    """融合：RRF / MMR / 加权 / 冲突打分 / 分层分带 / 指数衰减（按 algorithm 分派）。"""
    params = ctx.params
    algorithm = str(params.get("algorithm") or "").strip().lower()
    if not algorithm and "bands" in params:
        algorithm = "band"
    if not algorithm:
        algorithm = "weighted" if params.get("weights") else "rrf"

    if algorithm in ("rrf", "reciprocal-rank-fusion"):
        return _fuse_rrf(ctx, params)
    if algorithm in ("mmr", "maximal-marginal-relevance"):
        return _fuse_mmr(ctx, params)
    if algorithm in ("band", "bands", "score-band", "tier"):
        return _fuse_bands(ctx, params)
    if algorithm in ("conflict-score", "conflict", "contradiction"):
        return _fuse_conflict(ctx, params)
    if algorithm in ("exponential-decay", "decay", "age-decay"):
        return _fuse_decay(ctx, params)
    if algorithm in ("weight-threshold", "threshold", "prune"):
        return _fuse_threshold(ctx, params)
    return _fuse_weighted(ctx, params)


def _channel_lists(ctx: WorkflowContext) -> list[tuple[str, list]]:
    """把可见产物里形如 {hits:[…]} 的列表收集成「通道」。"""
    out: list[tuple[str, list]] = []
    for nid, art in ctx.artifacts.items():
        if not isinstance(art, Mapping):
            continue
        for key in ("hits", "items", "values", "results"):
            value = art.get(key)
            if isinstance(value, list) and value:
                out.append((str(nid), value))
                break
    return out


def _fuse_rrf(ctx: WorkflowContext, params: Mapping[str, Any]) -> dict:
    k = _as_int(params.get("k"), 60) or 60
    weights = _as_dict(params.get("weights"))
    channels = _channel_lists(ctx)
    per_channel: dict[str, list[tuple[str, float]]] = {}
    titles: dict[str, dict] = {}
    for name, rows in channels:
        ranked: list[tuple[str, float]] = []
        for item in rows:
            row = dict(item) if isinstance(item, Mapping) else {"id": _hash(item),
                                                                "title": str(item)}
            cid = str(row.get("id") or _hash(_text_of(row)))
            ranked.append((cid, _as_float(row.get("score"), 0.0)))
            titles.setdefault(cid, row)
        per_channel[name] = ranked
    try:
        fused = retrieval.rrf_fuse(per_channel, weights or None, k=k)
    except Exception:
        fused = {}
        for name, ranked in per_channel.items():
            weight = _as_float(weights.get(name), 1.0)
            if weight <= 0.0:
                weight = 1.0
            for rank, (cid, _raw) in enumerate(ranked, start=1):
                item = fused.setdefault(cid, {"id": cid, "rrf": 0.0, "channels": {}})
                item["rrf"] += weight / (k + rank)
    items = []
    for cid, info in sorted(fused.items(), key=lambda kv: (-kv[1]["rrf"], kv[0])):
        row = dict(titles.get(cid) or {"id": cid})
        row["rrf"] = round(_as_float(info.get("rrf"), 0.0), 8)
        row["score"] = row["rrf"]
        row["channels"] = info.get("channels") or {}
        items.append(row)
    ctx.note({"fused": len(items), "channels": len(per_channel)})
    return {"status": "ok", "algorithm": "rrf", "k": k, "items": items, "hits": items,
            "count": len(items), "channels": sorted(per_channel)}


def _fuse_mmr(ctx: WorkflowContext, params: Mapping[str, Any]) -> dict:
    lam = _as_float(params.get("lambda_", params.get("lambda")), 0.7)
    limit = _as_int(params.get("top_k") or params.get("limit"), 0)
    items = _candidates(ctx, ("items", "hits", "values", "results"))
    if not items:
        return {"status": "ok", "algorithm": "mmr", "items": [], "count": 0}
    rows = [dict(i) if isinstance(i, Mapping) else {"id": _hash(i), "title": str(i)}
            for i in items]
    if not limit:
        limit = len(rows)
    tokens = {}
    for row in rows:
        cid = str(row.get("id") or _hash(_text_of(row)))
        tokens[cid] = set(_WORD_RE.findall(_text_of(row).lower()))
    max_score = max((_as_float(r.get("score"), 0.0) for r in rows), default=1.0) or 1.0
    selected: list[dict] = []
    pool = list(rows)
    while pool and len(selected) < limit:
        best, best_value = None, -1e18
        for row in pool:
            cid = str(row.get("id") or _hash(_text_of(row)))
            rel = _as_float(row.get("score"), 0.0) / max_score
            redundancy = 0.0
            if selected and tokens.get(cid):
                for chosen in selected:
                    other = tokens.get(str(chosen.get("id"))) or set()
                    if other:
                        inter = len(tokens[cid] & other)
                        union = len(tokens[cid] | other) or 1
                        redundancy = max(redundancy, inter / union)
            value = lam * rel - (1 - lam) * redundancy
            if value > best_value:
                best, best_value = row, value
        if best is None:
            break
        selected.append(best)
        pool.remove(best)
    dropped = len(rows) - len(selected)
    ctx.note({"kept": len(selected), "dropped": dropped})
    return {"status": "ok", "algorithm": "mmr", "lambda": lam, "items": selected,
            "hits": selected, "count": len(selected), "dropped": dropped}


def _fuse_weighted(ctx: WorkflowContext, params: Mapping[str, Any]) -> dict:
    weights = _as_dict(params.get("weights"))
    scores: dict[str, float] = {}
    titles: dict[str, dict] = {}
    for name, rows in _channel_lists(ctx):
        weight = _as_float(weights.get(name), 1.0)
        top = max((_as_float(r.get("score"), 0.0) for r in rows
                   if isinstance(r, Mapping)), default=1.0) or 1.0
        for item in rows:
            row = dict(item) if isinstance(item, Mapping) else {"id": _hash(item),
                                                                "title": str(item)}
            cid = str(row.get("id") or _hash(_text_of(row)))
            scores[cid] = scores.get(cid, 0.0) + weight * (_as_float(row.get("score"), 0.0) / top)
            titles.setdefault(cid, row)
    items = []
    for cid, score in sorted(scores.items(), key=lambda kv: (-kv[1], kv[0])):
        row = dict(titles.get(cid) or {"id": cid})
        row["score"] = round(score, 6)
        items.append(row)
    return {"status": "ok", "algorithm": "weighted", "items": items, "hits": items,
            "count": len(items), "weights": weights or {"default": 1.0}}


def _fuse_bands(ctx: WorkflowContext, params: Mapping[str, Any]) -> dict:
    """相似度分层：自动合并 / 进判定 / 新建（阈值来自 params.bands）。"""
    bands = _as_dict(params.get("bands")) or {"auto_merge": 0.92, "judge": 0.8, "new": 0.0}
    auto = _as_float(bands.get("auto_merge"), 0.92)
    judge_at = _as_float(bands.get("judge"), 0.8)
    items = _candidates(ctx, ("hits", "items", "values", "results"))
    banded = []
    counts = {"auto_merge": 0, "judge": 0, "new": 0}
    for item in items:
        row = dict(item) if isinstance(item, Mapping) else {"id": _hash(item),
                                                            "title": str(item)}
        score = max(_as_float(row.get("sim"), 0.0), _as_float(row.get("score"), 0.0))
        # RRF 分很小，先归一化到 0-1，避免全部落进 new
        if score > 1.0:
            score = _clamp(score / (score + 1.0))
        if score >= auto:
            band = "auto_merge"
        elif score >= judge_at:
            band = "judge"
        else:
            band = "new"
        counts[band] += 1
        row["band"] = band
        row["sim"] = round(score, 4)
        banded.append(row)
    order = {"auto_merge": 0, "judge": 1, "new": 2}
    banded.sort(key=lambda r: (order[r["band"]], -r["sim"], str(r.get("id"))))
    ctx.note({"bands": counts})
    return {"status": "ok", "algorithm": "band", "bands": bands, "items": banded,
            "hits": banded, "count": len(banded), "counts": counts,
            "has_judge": counts["judge"] > 0 or counts["auto_merge"] > 0}


def _fuse_conflict(ctx: WorkflowContext, params: Mapping[str, Any]) -> dict:
    """冲突打分：对同主题记忆两两比对（重叠 / 极性 / 数值），产出冲突对。"""
    items = _candidates(ctx, ("items", "hits", "values", "results"))
    rows = [dict(i) if isinstance(i, Mapping) else {"id": _hash(i)} for i in items]
    pairs = []
    for i in range(len(rows)):
        for j in range(i + 1, len(rows)):
            left, right = rows[i], rows[j]
            body_a, body_b = _text_of(left), _text_of(right)
            overlap = _jaccard(body_a, body_b)
            score = 0.0
            cues = []
            if overlap >= 0.3:
                score += overlap * 0.5
                cues.append("主题重叠 %.2f" % overlap)
            neg_a = any(t in body_a for t in ("不", "没", "非", "无", "not ", "never"))
            neg_b = any(t in body_b for t in ("不", "没", "非", "无", "not ", "never"))
            if neg_a != neg_b and overlap >= 0.2:
                score += 0.3
                cues.append("极性相反")
            nums_a = set(re.findall(r"[-+]?\d+(?:\.\d+)?", body_a))
            nums_b = set(re.findall(r"[-+]?\d+(?:\.\d+)?", body_b))
            if nums_a and nums_b and nums_a != nums_b:
                score += 0.2
                cues.append("数值不同")
            if score <= 0:
                continue
            pairs.append({"a": left.get("id"), "b": right.get("id"),
                          "a_title": _title_of(left), "b_title": _title_of(right),
                          "score": round(_clamp(score), 4), "cues": cues})
    pairs.sort(key=lambda p: -p["score"])
    ctx.note({"pairs": len(pairs)})
    return {"status": "ok", "algorithm": "conflict-score", "items": pairs, "pairs": pairs,
            "count": len(pairs), "max_score": pairs[0]["score"] if pairs else 0.0,
            "has_conflict": bool(pairs)}


def _fuse_decay(ctx: WorkflowContext, params: Mapping[str, Any]) -> dict:
    """指数衰减权重：w = w0 · exp(-dt · ln2 / half_life)。"""
    import math

    half_life = max(1.0, _as_float(params.get("half_life_days"), 30.0))
    stamp_now = time.gmtime()
    now_ts = time.mktime((stamp_now.tm_year, stamp_now.tm_mon, stamp_now.tm_mday,
                          0, 0, 0, 0, 0, 0))
    items = _candidates(ctx, ("items", "values", "hits", "results"))
    out = []
    for item in items:
        row = dict(item) if isinstance(item, Mapping) else {"id": _hash(item),
                                                            "title": str(item)}
        stamp = str(row.get("recorded_at") or row.get("updated_at") or row.get("at") or "")
        age_days = 0.0
        if len(stamp) >= 10:
            try:
                parts = [int(x) for x in re.split(r"[-T:Z]", stamp[:19]) if x.isdigit()]
                if len(parts) >= 3:
                    ts = time.mktime((parts[0], parts[1], parts[2], 0, 0, 0, 0, 0, 0))
                    age_days = max(0.0, (now_ts - ts) / 86400.0)
            except (TypeError, ValueError):
                age_days = 0.0
        w0 = _as_float(row.get("importance"), _as_float(row.get("score"), 0.5)) or 0.5
        weight = w0 * math.exp(-math.log(2) * age_days / half_life)
        row["age_days"] = round(age_days, 2)
        row["decay_weight"] = round(weight, 6)
        row["score"] = round(weight, 6)
        out.append(row)
    out.sort(key=lambda r: -r["decay_weight"])
    ctx.note({"decayed": len(out)})
    return {"status": "ok", "algorithm": "exponential-decay", "half_life_days": half_life,
            "items": out, "hits": out, "count": len(out)}


def _fuse_threshold(ctx: WorkflowContext, params: Mapping[str, Any]) -> dict:
    min_weight = _as_float(params.get("min_weight"), 0.2)
    items = _candidates(ctx, ("edges", "items", "values", "results"))
    kept = []
    for item in items:
        row = dict(item) if isinstance(item, Mapping) else {"value": item}
        if _as_float(row.get("weight"), 1.0) >= min_weight:
            kept.append(row)
    dropped = len(items) - len(kept)
    return {"status": "ok", "algorithm": "weight-threshold", "min_weight": min_weight,
            "items": kept, "edges": kept, "count": len(kept), "dropped": dropped}


def node_judge(ctx: WorkflowContext, node: dict) -> dict:
    """判定：dedup / conflict / temporal / trust，统一返回动作决策。"""
    params = ctx.params
    actions = [str(a) for a in _as_list(params.get("actions"))] or list(CANDIDATE_ACTIONS)
    relations = [str(r) for r in _as_list(params.get("relations"))]
    rubric = str(params.get("rubric") or "").strip().lower()
    candidate = _judge_subject(ctx)
    near = _candidates(ctx, ("hits", "items", "values", "results"))
    # 1) 冲突裁决（keep_a / keep_b）优先：冲突压平了就再也看不到分歧
    if rubric == "contradiction" or any(a in actions for a in ("keep_a", "keep_b")):
        return _judge_conflict(ctx, params, candidate)
    # 2) 时序裁决（before / after / overlap / unknown）
    if relations:
        return _judge_temporal(ctx, params, candidate, near, relations)
    # 3) 来源可信度排序（rubric=source-trust）
    if rubric in ("source-trust", "trust", "evidence"):
        return _judge_trust(ctx, params, near, rubric=rubric)
    # 4) 去重七动作
    if actions:
        return _judge_dedup(ctx, params, candidate, near, actions)
    return _judge_trust(ctx, params, near)


def _judge_subject(ctx: WorkflowContext) -> dict:
    """判定对象：inputs 里的候选 / 上游第一条候选。"""
    for key in ("candidate", "memory", "a", "content", "text"):
        value = ctx.inputs.get(key)
        if isinstance(value, Mapping):
            return dict(value)
        if isinstance(value, str) and value.strip():
            return {"title": _rule_title(value), "body": value}
    items = _candidates(ctx, ("items", "values", "results"))
    if items:
        first = items[0]
        return dict(first) if isinstance(first, Mapping) else {"body": str(first)}
    text = ctx.text_for("content", "text", "body")
    return {"title": _rule_title(text), "body": text} if text else {}


def _judge_dedup(ctx: WorkflowContext, params: Mapping[str, Any], candidate: dict,
                 near: list, actions: list[str]) -> dict:
    """去重裁决：交给 judge.dedup_verdict（LLM→规则兜底），并保留置信度与理由。"""
    best = near[0] if near and isinstance(near[0], Mapping) else None
    knn = {"score": _as_float((best or {}).get("sim"),
                              _as_float((best or {}).get("score"), 0.0))}
    if judge_mod is not None:
        verdict = judge_mod.dedup_verdict(ctx.store, ctx.gw, candidate, best or {}, knn)
    else:  # judge 模块缺失时的最小规则
        verdict = _rule_dedup(candidate, best, knn["score"])
        verdict["degraded"] = True
    action = str(verdict.get("action") or "add").lower()
    if action not in actions:
        action = "ask" if "ask" in actions else actions[0]
    degraded = bool(verdict.get("degraded"))
    if degraded:
        ctx.mark_degraded("judge", str(verdict.get("reason") or "判定降级"))
    ctx.note({"action": action, "confidence": _as_float(verdict.get("confidence"), 0.0)})
    return {
        "status": "ok", "mode": "dedup", "action": action,
        "target_id": verdict.get("target_id") or (best or {}).get("id"),
        "confidence": _clamp(verdict.get("confidence"), 0.0),
        "reason": _clip_text(verdict.get("reason") or "", 300),
        "merged_body": verdict.get("merged_body"),
        "candidate": candidate, "best_match": (best or {}).get("id"),
        "knn": knn, "actions": actions, "degraded": degraded,
        "has_conflict": action in ("ask", "supersede"),
        "should_merge": action in ("merge", "update", "supersede", "noop"),
        "should_add": action == "add",
    }


def _rule_dedup(candidate: Mapping[str, Any], best: Mapping[str, Any] | None, sim: float) -> dict:
    """确定性去重裁决（阈值与 docs/MEMORY-MODEL.md §8 一致）。"""
    new_body = _text_of(candidate)
    old_body = _text_of(best or {})
    if not old_body:
        return {"action": "add", "target_id": None, "confidence": 0.6,
                "reason": "没有可比对的旧记忆", "merged_body": None}
    if new_body and new_body == old_body:
        return {"action": "noop", "target_id": (best or {}).get("id"), "confidence": 0.9,
                "reason": "正文完全一致", "merged_body": None}
    if sim >= 0.92:
        return {"action": "noop", "target_id": (best or {}).get("id"), "confidence": 0.8,
                "reason": "相似度 %.2f 大于等于 0.92，疑似重复" % sim, "merged_body": None}
    if sim >= 0.8:
        return {"action": "merge", "target_id": (best or {}).get("id"), "confidence": 0.6,
                "reason": "相似度 %.2f 落在 0.80-0.92，交判定层建议" % sim,
                "merged_body": (old_body + "\n" + new_body).strip()}
    if sim >= 0.55:
        return {"action": "link", "target_id": (best or {}).get("id"), "confidence": 0.5,
                "reason": "相似度 %.2f，相关但独立" % sim, "merged_body": None}
    return {"action": "add", "target_id": None, "confidence": 0.7,
            "reason": "相似度 %.2f 小于 0.55，视为新记忆" % sim, "merged_body": None}


def _judge_conflict(ctx: WorkflowContext, params: Mapping[str, Any], candidate: dict) -> dict:
    """冲突裁决：judge.conflict_verdict；缺省按可信度+时间序。"""
    a = _subject_by_key(ctx, "a_id") or candidate
    b = _subject_by_key(ctx, "b_id")
    if not b:
        items = _candidates(ctx, ("hits", "items", "values", "results"))
        b = dict(items[1]) if len(items) > 1 and isinstance(items[1], Mapping) else {}
    if judge_mod is not None:
        verdict = judge_mod.conflict_verdict(ctx.store, ctx.gw, a, b)
    else:
        verdict = _rule_conflict(a, b)
        verdict["degraded"] = True
    preferred = str(verdict.get("preferred") or "ask")
    action = {"a": "keep_a", "b": "keep_b"}.get(preferred, "ask_user")
    degraded = bool(verdict.get("degraded"))
    if degraded:
        ctx.mark_degraded("judge", "冲突裁决降级为可信度+时间序规则")
    return {"status": "ok", "mode": "conflict", "action": action, "preferred": preferred,
            "a": _title_of(a, "A"), "b": _title_of(b, "B"),
            "reasons": list(verdict.get("reasons") or [])[:8],
            "confidence": _clamp(verdict.get("confidence"), 0.0), "degraded": degraded,
            "has_conflict": preferred == "ask"}


def _rule_conflict(a: Mapping[str, Any], b: Mapping[str, Any]) -> dict:
    """确定性冲突裁决：可信度差 >=0.2 胜出，否则看时间序，最后请人工。"""
    trust_a = _as_float((a or {}).get("trust"), 0.5)
    trust_b = _as_float((b or {}).get("trust"), 0.5)
    reasons = ["来源可信度 a=%.2f b=%.2f" % (trust_a, trust_b)]
    if abs(trust_a - trust_b) >= 0.2:
        return {"preferred": "a" if trust_a > trust_b else "b", "reasons": reasons,
                "confidence": 0.65}
    at_a = str((a or {}).get("recorded_at") or "")
    at_b = str((b or {}).get("recorded_at") or "")
    if at_a and at_b and at_a != at_b:
        reasons.append("时间序 a=%s b=%s" % (at_a, at_b))
        return {"preferred": "a" if at_a >= at_b else "b", "reasons": reasons,
                "confidence": 0.55}
    reasons.append("信息不足，需人工裁决")
    return {"preferred": "ask", "reasons": reasons, "confidence": 0.3}


def _subject_by_key(ctx: WorkflowContext, key: str) -> dict:
    raw = ctx.inputs.get(key)
    if isinstance(raw, Mapping):
        return dict(raw)
    if isinstance(raw, str) and raw.strip():
        try:
            memory = ctx.store.get_memory(raw)
        except Exception:
            memory = None
        if memory:
            return memory
        return {"id": raw, "title": raw}
    return {}


def _judge_temporal(ctx: WorkflowContext, params: Mapping[str, Any], candidate: dict,
                    near: list, relations: list[str]) -> dict:
    """时序裁决：before / after / overlap / unknown。"""
    a = _subject_by_key(ctx, "a_id") or candidate
    b = _subject_by_key(ctx, "b_id") or (dict(near[0])
                                         if near and isinstance(near[0], Mapping) else {})
    at_a = str((a or {}).get("recorded_at") or (a or {}).get("valid_from") or "")
    at_b = str((b or {}).get("recorded_at") or (b or {}).get("valid_from") or "")
    relation = "unknown"
    if at_a and at_b:
        relation = "before" if at_a < at_b else ("after" if at_a > at_b else "overlap")
    if relation not in relations and "unknown" in relations:
        relation = "unknown"
    degraded = ctx.gw is None
    if degraded:
        ctx.mark_degraded("judge", "未配置判定模型，时序关系按时间戳规则")
    return {"status": "ok", "mode": "temporal", "relation": relation, "action": relation,
            "a_at": at_a, "b_at": at_b, "a": _title_of(a, "A"), "b": _title_of(b, "B"),
            "relations": relations, "degraded": degraded,
            "should_supersede": relation == "after"}


def _judge_trust(ctx: WorkflowContext, params: Mapping[str, Any], near: list,
                 rubric: str = "source-trust") -> dict:
    """来源可信度排序（证据强度 × 来源数）。"""
    ranked = []
    for item in near:
        row = dict(item) if isinstance(item, Mapping) else {"title": str(item)}
        trust = _as_float(row.get("trust"), 0.5)
        sources = _as_int(row.get("source_count"), 0)
        ranked.append({"id": row.get("id"), "title": _title_of(row), "trust": round(trust, 4),
                       "sources": sources, "weight": round(trust * (1 + 0.1 * sources), 4)})
    ranked.sort(key=lambda r: -r["weight"])
    return {"status": "ok", "mode": "trust", "rubric": rubric, "items": ranked,
            "count": len(ranked), "top": ranked[0] if ranked else None,
            "values": ranked, "degraded": False}


def node_verify(ctx: WorkflowContext, node: dict) -> dict:
    """核验：引句核验 / 来源核验 / 哈希核验 / 规则核验（按 params 分派）。"""
    params = ctx.params
    if params.get("by") == "content_hash" or params.get("hash"):
        return _verify_hash(ctx, params)
    if params.get("rules") and not params.get("require_quote") \
            and not params.get("min_occurrences"):
        rules = [str(r) for r in _as_list(params.get("rules"))]
        if any(
            ("mismatch" in rule) or ("missing_owner" in rule) or ("dim" in rule)
            for rule in rules
        ):
            return _verify_gc(ctx, params, rules)
    if params.get("min_occurrences"):
        return _verify_occurrences(ctx, params)
    return _verify_quotes(ctx, params)


def _verify_quotes(ctx: WorkflowContext, params: Mapping[str, Any]) -> dict:
    """引句核验：候选的每条断言都要有原文引句支撑。"""
    items = _candidates(ctx, ("items", "values", "results"))
    candidate = _judge_subject(ctx)
    pool_text = ctx.text_for("content", "text", "body")
    quotes = [str(q) for q in _as_list(params.get("quotes"))] or _sentences(pool_text)
    results = []
    degraded = False
    if judge_mod is not None and candidate:
        verdict = judge_mod.verify_claims(ctx.store, ctx.gw, candidate, quotes)
        degraded = bool(verdict.get("degraded"))
        results.append({"title": _title_of(candidate),
                        "supported": verdict.get("supported") or [],
                        "unsupported": verdict.get("unsupported") or [],
                        "verdict": verdict.get("verdict")})
    for item in items:
        row = dict(item) if isinstance(item, Mapping) else {"body": str(item)}
        body = _text_of(row)
        if not body.strip():
            continue
        claim_quotes = quotes or _sentences(pool_text) or [body]
        verdict = _rule_verify(row, claim_quotes)
        results.append({"title": _title_of(row), "supported": verdict["supported"],
                        "unsupported": verdict["unsupported"], "verdict": verdict["verdict"]})
    if not results:
        results = [{"title": "无候选", "supported": [], "unsupported": [], "verdict": "fail"}]
    passed = [r for r in results if r["verdict"] == "pass"]
    require_quote = bool(params.get("require_quote"))
    reject_agent_only = bool(params.get("reject_agent_only_claims"))
    agent_only = 0
    if reject_agent_only:
        agent_only = sum(1 for item in items if isinstance(item, Mapping)
                         and str(item.get("source") or "") == "agent_asserted")
        if agent_only and not passed:
            ctx.mark_degraded("verify", "存在仅有智能体自述的证据，已降为候选")
    verdict = "pass" if passed and len(passed) == len(results) else (
        "pass" if passed and not require_quote else "fail")
    if degraded:
        ctx.mark_degraded("verify", "引句核验降级为规则重叠判定")
    return {"status": "ok", "mode": "quote", "require_quote": require_quote,
            "reject_agent_only": reject_agent_only, "agent_only": agent_only,
            "items": results, "count": len(results), "passed": len(passed),
            "failed": len(results) - len(passed), "degraded": degraded,
            "verdict": verdict, "covered": bool(passed)}


def _rule_verify(candidate: Mapping[str, Any], quotes: list[str]) -> dict:
    """确定性核验：逐句看是否有 >=50% 关键词重叠的引句支撑。"""
    body = _text_of(candidate)
    sentences = _sentences(body) or ([body] if body.strip() else [])
    supported, unsupported = [], []
    for claim in sentences:
        tokens = set(_WORD_RE.findall(claim.lower())) or set(claim)
        hit = False
        for quote in quotes:
            if claim and claim.strip() and claim.strip() in str(quote):
                hit = True
                break
            other = set(_WORD_RE.findall(str(quote).lower()))
            if tokens and other and len(tokens & other) / max(1, len(tokens)) >= 0.5:
                hit = True
                break
        (supported if hit else unsupported).append(claim[:200])
    return {"supported": supported, "unsupported": unsupported,
            "verdict": "pass" if sentences and not unsupported else "fail"}


def _verify_hash(ctx: WorkflowContext, params: Mapping[str, Any]) -> dict:
    """内容哈希核验：同一内容只处理一次（文档吸收去重）。"""
    text = ctx.text_for("content", "text", "body")
    digest = _hash(_norm(text))
    expected = str(params.get("hash") or ctx.inputs.get("hash") or "")
    duplicate = False
    try:
        row = ctx.store.con.execute(
            "SELECT id FROM document WHERE hash = ? LIMIT 1", (digest,)).fetchone()
        duplicate = row is not None
    except sqlite3.Error:  # pragma: no cover
        duplicate = False
    if expected and expected != digest:
        duplicate = True
    return {"status": "ok", "mode": "content_hash", "hash": digest, "expected": expected,
            "duplicate": duplicate, "values": [],
            "verdict": "skip" if duplicate else "pass", "should_skip": duplicate}


def _verify_gc(ctx: WorkflowContext, params: Mapping[str, Any], rules: list[str]) -> dict:
    """孤儿清理核验：没有主人的向量 / 维度不符。"""
    con = ctx.store.con
    orphans, bad_dim = [], []
    try:
        rows = con.execute("SELECT owner_kind, owner_id, model, dim FROM vector").fetchall()
    except sqlite3.Error:  # pragma: no cover
        rows = []
    for row in rows:
        owner_kind = str(row["owner_kind"])
        owner_id = str(row["owner_id"])
        table = {"memory": "memory", "chunk": "chunk", "entity": "entity"}.get(owner_kind)
        if table:
            exists = con.execute("SELECT 1 FROM %s WHERE id = ?" % table,
                                 (owner_id,)).fetchone()
            if exists is None:
                orphans.append({"owner_kind": owner_kind, "owner_id": owner_id})
        if owner_kind == "memory" and int(row["dim"] or 0) not in (0, vectors.DIM):
            bad_dim.append({"owner_id": owner_id, "dim": row["dim"]})
    removed = 0
    if orphans:
        with ctx.store._txn() as txn:
            for item in orphans:
                txn.execute("DELETE FROM vector WHERE owner_kind = ? AND owner_id = ?",
                            (item["owner_kind"], item["owner_id"]))
                removed += 1
        ctx.store.audit("vector.gc", None, actor="workflow",
                        detail={"removed": removed, "rules": rules})
    return {"status": "ok", "mode": "gc", "rules": rules, "orphans": orphans,
            "bad_dim": bad_dim, "removed": removed,
            "count": len(orphans) + len(bad_dim), "verdict": "pass"}


def _verify_occurrences(ctx: WorkflowContext, params: Mapping[str, Any]) -> dict:
    """频次核验：同一模式至少出现 N 次才成立（偏好学习用）。"""
    need = max(1, _as_int(params.get("min_occurrences"), 2))
    items = _candidates(ctx, ("items", "values", "results"))
    counts: dict[str, int] = {}
    for item in items:
        body = _text_of(item)
        if body.strip():
            key = body.strip()[:80]
            counts[key] = counts.get(key, 0) + 1
    kept = [{"text": key, "count": value} for key, value in counts.items() if value >= need]
    kept.sort(key=lambda r: -r["count"])
    return {"status": "ok", "mode": "occurrence", "min_occurrences": need,
            "items": kept, "count": len(kept), "passed": len(kept),
            "verdict": "pass" if kept else "fail", "total_observed": len(items)}



# ============================================================
# 11. 节点实现 · C 组（persist / index / graph / generate / decide / schedule / emit）
# ============================================================
def node_persist(ctx: WorkflowContext, node: dict) -> dict:
    """落库：memory / markdown 镜像 / 报告 / audit / candidate / recall_log。"""
    params = ctx.params
    target = str(params.get("target") or "").strip().lower()
    table = str(params.get("table") or "").strip().lower()
    if table == "audit" or target == "audit":
        return _persist_audit(ctx, params)
    if target in ("markdown", "daily", "mirror") or params.get("layout") == "daily":
        return _persist_markdown(ctx, params)
    if target in ("report", "reports") or params.get("report"):
        return _persist_report(ctx, params)
    if table in ("recall_log", "candidate", "job"):
        return _persist_table(ctx, params, table)
    return _persist_memory(ctx, params)


def _persist_memory(ctx: WorkflowContext, params: Mapping[str, Any]) -> dict:
    """写记忆（store.add_memory）；幂等键命中则复用原记录。"""
    status = str(params.get("status") or "candidate")
    if status not in ("draft", "candidate", "approved", "rejected"):
        status = "candidate"
    idem_key = str(params.get("idempotent_by") or "").strip()
    items = _candidates(ctx, ("items", "values", "candidates", "results"))
    payload_rows = []
    for item in items:
        row = dict(item) if isinstance(item, Mapping) else {"body": str(item)}
        body = _text_of(row)
        if not body.strip():
            continue
        payload_rows.append({
            "title": row.get("title") or _rule_title(body),
            "body": _clip_text(body, 4000),
            "kind": _kind_of(row.get("kind"), KINDS_OF_MEMORY),
            "category": row.get("category") or "general",
            "importance": _clamp(row.get("importance"), 0.5),
            "confidence": _clamp(row.get("confidence"), 0.45),
            "quote": row.get("quote") or "",
            "source": row.get("source") or "workflow",
        })
    if not payload_rows:
        text = ctx.text_for("content", "text", "body")
        if not text.strip():
            return {"status": "ok", "target": "memory", "written": 0,
                    "reason": "没有可写入的记忆内容"}
        meta = ctx.inputs.get("candidate")
        if isinstance(meta, Mapping):
            payload_rows.append(dict(meta))
        else:
            payload_rows.append({"title": _rule_title(text), "body": _clip_text(text, 4000),
                                 "kind": _kind_of(params.get("kind"), KINDS_OF_MEMORY),
                                 "category": "general"})

    written = []
    reused = 0
    for row in payload_rows:
        idem = ""
        if idem_key:
            source = ctx.inputs.get(idem_key)
            if source:
                idem = "flow-" + _hash("%s|%s" % (idem_key, source))
        data = {
            "title": str(row.get("title") or _rule_title(_text_of(row)))[:200],
            "body": str(row.get("body") or _text_of(row)),
            "kind": _kind_of(row.get("kind"), KINDS_OF_MEMORY),
            "scope_id": str(params.get("scope") or ctx.scope or "global"),
            "status": status,
            "category": row.get("category") or "general",
            "importance": _clamp(row.get("importance"), 0.5),
            "confidence": _clamp(row.get("confidence"), 0.45),
            "agent_id": ctx.inputs.get("agent") or ctx.inputs.get("agent_id"),
            "metadata": {"workflow": ctx.template_id, "run_id": ctx.run_id,
                         "node": ctx.node_id, "source": row.get("source") or "workflow"},
        }
        if idem:
            data["id"] = idem
            existing = None
            try:
                existing = ctx.store.get_memory(idem)
            except Exception:
                existing = None
            if existing:
                reused += 1
                written.append({"id": existing.get("id"), "title": existing.get("title"),
                                "status": existing.get("status"), "reused": True})
                continue
        try:
            memory = ctx.store.add_memory(data)
        except ValueError as exc:
            # 已存在 / 字段非法：不当作运行失败，记下来继续
            ctx.mark_degraded("persist", "写记忆被拒：%s" % exc)
            written.append({"title": data["title"], "error": str(exc)[:200]})
            continue
        quote = str(row.get("quote") or "").strip()
        if quote:
            try:
                ctx.store.add_evidence(memory["id"], {
                    "kind": "agent_asserted", "quote": _clip_text(quote, 1000),
                    "note": "工作流抽取引句", "verifier": ctx.template_id,
                })
            except (ValueError, KeyError):
                pass
        written.append({"id": memory.get("id"), "title": memory.get("title"),
                        "status": memory.get("status"), "kind": memory.get("kind")})
    ctx.note({"written": len(written), "reused": reused})
    return {"status": "ok", "target": "memory", "written": len(written), "reused": reused,
            "items": written, "count": len(written), "memory_status": status,
            "memory_id": (written[0].get("id") if written and written[0].get("id") else None)}


def _persist_markdown(ctx: WorkflowContext, params: Mapping[str, Any]) -> dict:
    """写 Markdown 镜像（vault.append_daily / write_document）。"""
    vault = getattr(ctx.store, "vault", None)
    text = ctx.text_for("content", "text", "body")
    title = _rule_title(text)
    chunk = {"title": title, "body": _clip_text(text, 2000),
             "kind": _kind_of(params.get("kind"), KINDS_OF_MEMORY),
             "memory_id": params.get("memory_id"), "scope": ctx.scope,
             "agent": ctx.inputs.get("agent"), "tags": _as_list(params.get("tags"))}
    if vault is None:
        ctx.mark_degraded("persist", "vault 不可用，Markdown 镜像跳过（真源已写库）")
        try:
            ctx.store.audit("markdown.skip", ctx.run_id, actor="workflow",
                            detail={"reason": "vault unavailable", "title": title})
        except Exception:
            pass
        return {"status": "ok", "target": "markdown", "written": 0, "path": None,
                "degraded": True, "reason": "vault 不可用"}
    layout = str(params.get("layout") or "daily")
    try:
        if layout == "daily":
            path = vault.append_daily(chunk)
        else:
            path = vault.write_document("notes/%s.md" % _hash(text), _clip_text(text, 6000))
        ctx.note({"path": path})
        return {"status": "ok", "target": "markdown", "written": 1, "path": path,
                "layout": layout, "title": title}
    except Exception as exc:
        ctx.mark_degraded("persist", "Markdown 写入失败：%s" % type(exc).__name__)
        return {"status": "ok", "target": "markdown", "written": 0, "path": None,
                "degraded": True, "reason": str(exc)[:200]}


def _persist_report(ctx: WorkflowContext, params: Mapping[str, Any]) -> dict:
    """写报告（vault.write_report），内容来自 generate 或产物汇总。"""
    vault = getattr(ctx.store, "vault", None)
    body = ctx.text_for("markdown", "report", "text", "content")
    if not body.strip():
        body = _render_report(ctx)
    name = str(params.get("name") or "%s-%s" % (ctx.template_id, ctx.run_id[-6:]))
    if vault is None:
        ctx.mark_degraded("persist", "vault 不可用，报告只写库")
        return {"status": "ok", "target": "report", "written": 0, "path": None,
                "degraded": True, "chars": len(body)}
    try:
        path = vault.write_report(name, body)
        ctx.note({"path": path})
        return {"status": "ok", "target": "report", "written": 1, "path": path,
                "chars": len(body)}
    except Exception as exc:
        ctx.mark_degraded("persist", "报告写入失败：%s" % type(exc).__name__)
        return {"status": "ok", "target": "report", "written": 0, "path": None,
                "degraded": True, "reason": str(exc)[:200]}


def _render_report(ctx: WorkflowContext) -> str:
    """没有 generate 时，用产物汇总生成报告正文。"""
    lines = ["# %s 运行报告" % ctx.template_name, "",
             "- 运行：%s" % ctx.run_id, "- 模板：%s" % ctx.template_id,
             "- 作用域：%s" % ctx.scope, "- 生成：%s" % iso_now(), ""]
    for nid, art in ctx.artifacts.items():
        if not isinstance(art, Mapping):
            continue
        summary = art.get("summary") or art.get("text") or art.get("reason") or ""
        lines.append("## %s" % nid)
        if summary:
            lines.extend(["", _clip_text(summary, 600), ""])
    return "\n".join(lines)


def _persist_audit(ctx: WorkflowContext, params: Mapping[str, Any]) -> dict:
    """写审计（store.audit）；detail 取上游关键产物。"""
    action = str(params.get("action") or "workflow.%s" % ctx.node_id)
    detail = {"run_id": ctx.run_id, "template": ctx.template_id, "node": ctx.node_id,
              "scope": ctx.scope, "artifacts": sorted(ctx.artifacts)}
    for nid, art in ctx.artifacts.items():
        if isinstance(art, Mapping):
            for key in ("action", "verdict", "summary", "reason"):
                if art.get(key):
                    detail["%s.%s" % (nid, key)] = _clip_text(art.get(key), 200)
    try:
        ctx.store.audit(action, str(params.get("target") or ctx.template_id),
                        actor="workflow", detail=detail)
    except Exception as exc:
        ctx.mark_degraded("persist", "审计写入失败：%s" % type(exc).__name__)
        return {"status": "ok", "target": "audit", "written": 0, "degraded": True}
    return {"status": "ok", "target": "audit", "written": 1, "action": action,
            "keys": sorted(detail)}


def _persist_table(ctx: WorkflowContext, params: Mapping[str, Any], table: str) -> dict:
    """写 candidate / recall_log（保留判定链与召回留痕）。"""
    if table == "candidate":
        subject = _judge_subject(ctx)
        payload = {
            "batch_id": ctx.run_id, "scope_id": ctx.scope,
            "action": str(params.get("action") or "add"),
            "status": str(params.get("status") or "pending"),
            "payload": subject,
            "dedup": {"items": len(_candidates(ctx, ("hits", "items")))},
            "run_id": ctx.run_id,
        }
        try:
            candidate = ctx.store.add_candidate(payload)
            return {"status": "ok", "target": "candidate", "written": 1,
                    "id": candidate.get("id"), "action": payload["action"]}
        except ValueError as exc:
            ctx.mark_degraded("persist", "候选写入失败：%s" % exc)
            return {"status": "ok", "target": "candidate", "written": 0, "degraded": True}
    hits = _candidates(ctx, ("hits", "items", "values", "results"))
    ids = [str(h.get("id")) for h in hits if isinstance(h, Mapping) and h.get("id")]
    row_id = _new_id("rl")
    try:
        with ctx.store._txn() as con:
            con.execute(
                "INSERT INTO recall_log(id, query, scope_id, agent_id, strategy, hit_ids, "
                "scores, latency_ms, tokens, degraded, created_at) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                (row_id, str(ctx.inputs.get("query") or ""), ctx.scope,
                 ctx.inputs.get("agent") or ctx.inputs.get("agent_id"),
                 str(params.get("strategy") or "hybrid"), dumps(ids), dumps({}),
                 _as_int((ctx.step_meta.get("metrics") or {}).get("ms"), 0),
                 sum(_as_int(h.get("tokens")) for h in hits if isinstance(h, Mapping)),
                 1 if ctx.degraded else 0, iso_now()),
            )
        return {"status": "ok", "target": "recall_log", "written": 1, "id": row_id,
                "hits": len(ids)}
    except sqlite3.Error as exc:
        ctx.mark_degraded("persist", "召回日志写入失败：%s" % exc)
        return {"status": "ok", "target": "recall_log", "written": 0, "degraded": True}


def node_index(ctx: WorkflowContext, node: dict) -> dict:
    """索引维护：FTS 重建 / 向量增量 / 孤儿统计。"""
    params = ctx.params
    engine = str(params.get("engine") or "").strip().lower()
    if engine in ("fts5", "fts") or params.get("fts"):
        try:
            counts = ctx.store.rebuild_fts()
            return {"status": "ok", "engine": "fts5", "counts": counts,
                    "tokenize": params.get("tokenize") or "unicode61"}
        except sqlite3.Error as exc:
            ctx.mark_degraded("index", "FTS 重建失败：%s" % exc)
            return {"status": "ok", "engine": "fts5", "degraded": True,
                    "reason": str(exc)[:200]}
    if params.get("incremental") or params.get("vectors"):
        items = _embed_targets(ctx)
        pending = [i for i in items if isinstance(i, Mapping) and i.get("id")
                   and not _has_vector(ctx.store, "memory", str(i["id"]), vectors.MODEL_LOCAL)]
        return {"status": "ok", "mode": "vector-incremental", "eligible": len(items),
                "pending": len(pending), "engine": "vector"}
    con = ctx.store.con
    try:
        memories = con.execute("SELECT count(*) FROM memory").fetchone()[0]
        vector_n = con.execute("SELECT count(*) FROM vector").fetchone()[0]
        orphans = con.execute(
            "SELECT count(*) FROM vector v WHERE v.owner_kind = 'memory' AND NOT EXISTS "
            "(SELECT 1 FROM memory m WHERE m.id = v.owner_id)").fetchone()[0]
    except sqlite3.Error as exc:  # pragma: no cover
        ctx.mark_degraded("index", "索引统计失败：%s" % exc)
        return {"status": "ok", "degraded": True}
    return {"status": "ok", "mode": "stats", "memories": memories, "vectors": vector_n,
            "orphans": orphans, "engine": engine or "generic"}


def node_graph(ctx: WorkflowContext, node: dict) -> dict:
    """图操作：建实体/边、社区发现（连通分量）、中心度（度中心性）。"""
    params = ctx.params
    algorithm = str(params.get("algorithm") or "").strip().lower()
    if algorithm in ("louvain", "community", "connected-components"):
        return _graph_community(ctx, params)
    if algorithm in ("pagerank", "centrality", "degree"):
        return _graph_centrality(ctx, params)
    return _graph_build(ctx, params)


def _entity_names(ctx: WorkflowContext, params: Mapping[str, Any]) -> list[str]:
    """实体候选：extract 的 items + 文本里的高频词。"""
    kinds = [str(k) for k in _as_list(params.get("kinds"))]
    names: list[str] = []
    for item in _candidates(ctx, ("items", "values", "results")):
        if isinstance(item, Mapping):
            kind = str(item.get("kind") or "")
            if kinds and kind and kind not in kinds:
                continue
            name = str(item.get("title") or item.get("name") or "").strip()
            if name and name not in names:
                names.append(name[:80])
    if not names:
        names = _keywords_of(ctx.text_for("content", "text", "body"), 8)
    return names[:30]


def _graph_build(ctx: WorkflowContext, params: Mapping[str, Any]) -> dict:
    """建实体与边（store.upsert_entity / add_edge），幂等。"""
    rels = [str(r) for r in _as_list(params.get("rels"))] or ["mentions"]
    names = _entity_names(ctx, params)
    created, edges, linked = [], [], 0
    scope = str(params.get("scope") or ctx.scope)
    entity_ids: dict[str, str] = {}
    for name in names:
        try:
            entity = ctx.store.upsert_entity(name, "concept", scope_id=scope)
            entity_ids[name] = str(entity.get("id"))
            created.append({"id": entity.get("id"), "name": name})
        except (ValueError, KeyError) as exc:
            ctx.mark_degraded("graph", "实体登记失败：%s" % exc)
    memory_items = [i for i in _candidates(ctx, ("items", "values", "results"))
                    if isinstance(i, Mapping) and str(i.get("id") or "").startswith("m-")]
    for item in memory_items:
        for name, eid in entity_ids.items():
            if name and name in _text_of(item):
                try:
                    ctx.store.link_memory_entity(str(item["id"]), eid, "mention")
                    linked += 1
                except (KeyError, ValueError):
                    continue
    ids = list(entity_ids.values())
    rel = rels[0] if rels[0] != "mentions" else "semantic"
    for i in range(len(ids)):
        for j in range(i + 1, len(ids)):
            try:
                edge = ctx.store.add_edge(ids[i], "entity", ids[j], "entity", rel,
                                          weight=0.6, confidence=0.5, origin="cooccurrence")
                edges.append({"src": ids[i], "dst": ids[j], "rel": rel, "id": edge.get("id")})
            except (ValueError, KeyError) as exc:
                ctx.mark_degraded("graph", "建边失败：%s" % exc)
                break
    ctx.note({"entities": len(created), "edges": len(edges)})
    return {"status": "ok", "mode": "build", "entities": created, "edges": edges,
            "count": len(created), "links": linked, "rels": rels,
            "values": [{"id": e["id"], "title": e["name"], "kind": "entity"} for e in created],
            "has_graph": bool(created)}


def _graph_community(ctx: WorkflowContext, params: Mapping[str, Any]) -> dict:
    """社区发现：无第三方图库时用并查集连通分量（可解释、可复现）。"""
    try:
        graph = ctx.store.graph("semantic", ctx.scope, 500)
    except Exception:
        graph = {"nodes": [], "edges": []}
    edges = [e for e in _as_list(graph.get("edges")) if isinstance(e, Mapping)]
    nodes = [n for n in _as_list(graph.get("nodes")) if isinstance(n, Mapping)]
    parent: dict[str, str] = {str(n.get("id")): str(n.get("id")) for n in nodes}

    def find(x: str) -> str:
        root = x
        while parent.get(root, root) != root:
            root = parent.get(root, root)
        return root

    for edge in edges:
        src, dst = find(str(edge.get("src"))), find(str(edge.get("dst")))
        if src != dst:
            parent[dst] = src
    groups: dict[str, list[str]] = {}
    for nid in parent:
        groups.setdefault(find(nid), []).append(nid)
    communities = [{"id": "c%d" % idx, "members": members, "size": len(members)}
                   for idx, members in enumerate(sorted(groups.values(), key=len, reverse=True))]
    ctx.note({"communities": len(communities)})
    return {"status": "ok", "algorithm": "connected-components", "communities": communities,
            "count": len(communities), "nodes": len(nodes), "edges": len(edges),
            "values": [{"id": c["id"], "title": "社区 %s (%d)" % (c["id"], c["size"])}
                       for c in communities],
            "has_graph": bool(communities)}


def _graph_centrality(ctx: WorkflowContext, params: Mapping[str, Any]) -> dict:
    """中心度：度中心性（PageRank 的降级替代，结果可解释）。"""
    try:
        graph = ctx.store.graph("semantic", ctx.scope, 500)
    except Exception:
        graph = {"nodes": [], "edges": []}
    degree: dict[str, float] = {}
    for node in _as_list(graph.get("nodes")):
        if isinstance(node, Mapping):
            degree[str(node.get("id"))] = 0.0
    for edge in _as_list(graph.get("edges")):
        if not isinstance(edge, Mapping):
            continue
        src, dst = str(edge.get("src")), str(edge.get("dst"))
        weight = _as_float(edge.get("weight"), 1.0)
        degree[src] = degree.get(src, 0.0) + weight
        degree[dst] = degree.get(dst, 0.0) + weight
    top = max(degree.values(), default=1.0) or 1.0
    ranked = [{"id": nid, "degree": round(value, 4), "score": round(value / top, 4)}
              for nid, value in degree.items()]
    ranked.sort(key=lambda r: -r["degree"])
    ctx.note({"nodes": len(ranked)})
    return {"status": "ok", "algorithm": "degree", "items": ranked[:50], "count": len(ranked),
            "top": ranked[0] if ranked else None, "values": ranked[:50],
            "has_graph": bool(ranked)}


def node_generate(ctx: WorkflowContext, node: dict) -> dict:
    """生成：调 gw.chat；失败走抽取式模板（首句 / 要点列表 / 卡片 / 题面）。"""
    params = ctx.params
    style = str(params.get("style") or params.get("output")
                or params.get("format") or "").lower()
    text = ctx.text_for("content", "text", "body", "markdown")
    if style in ("cue-question", "cues"):
        return _generate_cues(ctx, params, text)
    if params.get("types") or style in ("quiz", "questions"):
        return _generate_quiz(ctx, params, text)
    if style in ("markdown", "digest") or params.get("cite"):
        return _generate_digest(ctx, params, text)
    return _generate_text(ctx, params, text)


def _generate_text(ctx: WorkflowContext, params: Mapping[str, Any], text: str) -> dict:
    """通用生成：LLM 优先，失败抽取式（首句 + 要点）。"""
    max_tokens = _as_int(params.get("max_tokens"), 400)
    prompt = (str(params.get("prompt") or "").strip()
              or "用不超过 %d tokens 概括下面的内容，保留关键事实与来源，只输出正文。\n%s"
              % (max_tokens, _clip_text(text, 6000)))
    degraded = False
    reason = ""
    model = ""
    content = ""
    if ctx.use_llm and ctx.gw is not None:
        try:
            content = str(ctx.gw.chat([{"role": "user", "content": prompt}], role="chat",
                                      max_tokens=max_tokens, temperature=0.2) or "").strip()
            model = _active_label(ctx.gw, "chat")
        except Exception as exc:
            if _unavailable(exc):
                raise ModelUnavailable("chat", str(exc)) from exc
            degraded, reason = True, "生成失败：%s" % type(exc).__name__
    else:
        degraded, reason = True, "未配置对话模型，使用抽取式模板"
    if not content:
        degraded = True
        reason = reason or "模型返回空，使用抽取式模板"
        summary = _rule_summary(text, max_tokens)
        bullets = _bullet_points(text, 5)
        content = summary or text[:600]
        ctx.mark_degraded("generate", reason)
        return {"status": "ok", "mode": "extractive", "text": _clip_text(content, 2000),
                "summary": _clip_text(content, 600), "bullets": bullets,
                "first_sentence": _first_sentence(text, 200), "degraded": True,
                "reason": reason, "model": model or ""}
    ctx.note({"tokens": _est_tokens(content), "model": model})
    return {"status": "ok", "mode": "llm", "text": _clip_text(content, 4000),
            "summary": _clip_text(content, 800), "bullets": _bullet_points(content, 5),
            "degraded": degraded, "model": model, "style": params.get("style") or "summary"}


def _generate_cues(ctx: WorkflowContext, params: Mapping[str, Any], text: str) -> dict:
    """抽象线索：judge.abstraction_cues 优先，否则问句模板。"""
    cues: list[str] = []
    degraded = False
    if judge_mod is not None:
        verdict = judge_mod.abstraction_cues(ctx.store, ctx.gw, text)
        cues = [str(c) for c in _as_list(verdict.get("cues"))]
        degraded = bool(verdict.get("degraded"))
    if not cues:
        title = _rule_title(text, "这段内容")
        cues = ["%s是什么？" % title, "%s的关键点有哪些？" % title]
        degraded = True
    if degraded:
        ctx.mark_degraded("generate", "抽象线索使用问句模板兜底")
    return {"status": "ok", "mode": "cue", "cues": cues[:6], "text": "\n".join(cues[:6]),
            "count": len(cues[:6]), "degraded": degraded}


def _generate_quiz(ctx: WorkflowContext, params: Mapping[str, Any], text: str) -> dict:
    """生成题目：无模型时用填空模板（从正文挖关键词做空）。"""
    count = max(1, _as_int(params.get("count") or ctx.inputs.get("count"), 3))
    types = [str(t) for t in _as_list(params.get("types"))] or ["single"]
    items = _candidates(ctx, ("items", "values", "hits", "results"))
    source = text or "\n".join(_text_of(i) for i in items)
    degraded = False
    cards: list[dict] = []
    if ctx.use_llm and ctx.gw is not None:
        try:
            prompt = prompts.render_named("quiz", {"count": count, "budget": 800}) \
                + "\n\n材料：\n" + _clip_text(source, 3000)
            reply = ctx.gw.chat([{"role": "user", "content": prompt}], role="chat",
                                max_tokens=900, temperature=0.3)
            payload = prompts.parse_json(reply, expect=(list, dict))
            rows = payload if isinstance(payload, list) else payload.get("items") or []
            for row in _as_list(rows)[:count]:
                if isinstance(row, Mapping) and row.get("question"):
                    cards.append({"type": str(row.get("type") or "short"),
                                  "question": _clip_text(row.get("question"), 300),
                                  "answer": _clip_text(row.get("answer"), 300),
                                  "explanation": _clip_text(row.get("explanation"), 300),
                                  "source_id": row.get("source_id")})
        except Exception as exc:
            if _unavailable(exc):
                raise ModelUnavailable("chat", str(exc)) from exc
            degraded = True
    if not cards:
        degraded = True
        ctx.mark_degraded("generate", "题目由填空模板生成（未使用模型）")
        for sentence in _sentences(source)[:count]:
            words = _keywords_of(sentence, 3)
            blank = words[0] if words else ""
            question = sentence.replace(blank, "____", 1) if blank else sentence
            cards.append({"type": "blank", "question": _clip_text(question, 300),
                          "answer": blank, "explanation": "出自原文",
                          "source_id": None})
    return {"status": "ok", "mode": "cloze" if degraded else "llm", "items": cards,
            "count": len(cards), "types": types, "degraded": degraded}


def _generate_digest(ctx: WorkflowContext, params: Mapping[str, Any], text: str) -> dict:
    """摘要包：retrieval.digest（预算内打包 + 引用），失败退回抽取式摘要。"""
    budget = _as_int(params.get("budget") or ctx.inputs.get("budget"), 800)
    query = str(ctx.inputs.get("query") or ctx.inputs.get("topic") or "")
    degraded = False
    try:
        digest = retrieval.digest(ctx.store, ctx.gw, scope=ctx.scope, budget=budget,
                                  task=query or None,
                                  agent_id=ctx.inputs.get("agent")
                                  or ctx.inputs.get("agent_id"))
        body = str(digest.get("text") or "")
        if body.strip():
            return {"status": "ok", "mode": "digest", "text": _clip_text(body, 4000),
                    "items": digest.get("items") or [], "count": digest.get("count", 0),
                    "tokens": digest.get("tokens", 0), "budget": budget,
                    "degraded": bool(digest.get("degraded")),
                    "format": params.get("format") or "markdown"}
        degraded = True
    except Exception as exc:
        degraded = True
        ctx.mark_degraded("generate", "摘要包失败：%s" % type(exc).__name__)
    body = _rule_summary(text, budget)
    return {"status": "ok", "mode": "extractive", "text": _clip_text(body, 4000),
            "summary": _clip_text(body, 600), "count": 1, "budget": budget,
            "degraded": degraded, "format": params.get("format") or "markdown"}


def node_decide(ctx: WorkflowContext, node: dict) -> dict:
    """在若干动作里选一个并记录理由（可调 judge，可规则）。"""
    params = ctx.params
    actions = [str(a) for a in _as_list(params.get("actions"))] or ["keep", "ask_user"]
    evidence = {
        "claims": len(_candidates(ctx, ("items", "values", "results"))),
        "verdicts": {nid: art.get("verdict") for nid, art in ctx.artifacts.items()
                     if isinstance(art, Mapping) and art.get("verdict")},
        "actions": {nid: art.get("action") for nid, art in ctx.artifacts.items()
                    if isinstance(art, Mapping) and art.get("action")},
    }
    degraded = False
    action = ""
    reason = ""
    confidence = 0.0
    if ctx.use_llm and ctx.gw is not None:
        try:
            prompt = prompts.render_named("decide_action", {
                "actions": actions, "evidence": json.dumps(evidence, ensure_ascii=False)})
            payload = ctx.gw.judge(prompt, role="judge")
            candidate = str(payload.get("action") or "").strip()
            if candidate in actions:
                action = candidate
                reason = str(payload.get("reason") or "")[:300]
                confidence = _clamp(payload.get("confidence"), 0.5)
        except Exception as exc:
            if _unavailable(exc):
                raise ModelUnavailable("judge", str(exc)) from exc
            degraded = True
    if not action:
        degraded = ctx.gw is None or degraded
        action, reason, confidence = _rule_decide(ctx, actions)
        if degraded:
            ctx.mark_degraded("decide", "规则选择动作（未使用判定模型）")
    ctx.note({"action": action, "confidence": confidence})
    return {"status": "ok", "action": action, "reason": reason,
            "confidence": round(confidence, 4), "actions": actions,
            "evidence": evidence, "degraded": degraded,
            "mode": "rule" if degraded else "llm"}


def _rule_decide(ctx: WorkflowContext, actions: list[str]) -> tuple[str, str, float]:
    """规则选择：按已产出的判定结果 / 冲突对 / 失败核验决定动作。"""
    arts = {nid: art for nid, art in ctx.artifacts.items() if isinstance(art, Mapping)}
    for art in arts.values():
        action = str(art.get("action") or "")
        if action in actions:
            return action, "沿用上游判定结论：%s" % (art.get("reason") or action), 0.6
    if "ask_user" in actions and any(art.get("has_conflict") for art in arts.values()):
        return "ask_user", "存在冲突且证据不足，交人工裁决", 0.55
    if "mark_stale" in actions and any(art.get("failed") for art in arts.values()):
        return "mark_stale", "核验未通过，标记为待复核", 0.5
    failed = any(str(art.get("verdict") or "") == "fail" for art in arts.values())
    if failed and "ask_user" in actions:
        return "ask_user", "核验失败，交人工确认", 0.5
    return actions[0], "没有更强信号，选择首选动作", 0.4


def node_schedule(ctx: WorkflowContext, node: dict) -> dict:
    """写 job 表（延时/周期），不真的起定时器。"""
    params = ctx.params
    job_kind = str(params.get("job") or params.get("kind") or "workflow")
    delay = _as_int(params.get("delay_s") or params.get("delay_seconds"), 0)
    algorithm = str(params.get("algorithm") or "").strip().lower()
    payload = {
        "run_id": ctx.run_id, "template": ctx.template_id, "node": ctx.node_id,
        "inputs": {k: v for k, v in ctx.inputs.items() if not isinstance(v, (dict, list))},
        "scope": ctx.scope, "algorithm": algorithm or None,
        "params": {k: v for k, v in params.items() if k not in ("job",)},
    }
    run_after = None
    if delay:
        run_after = time.strftime("%Y-%m-%dT%H:%M:%SZ",
                                  time.gmtime(time.time() + max(0, delay)))
    job_id = _new_id("job")
    stamp = iso_now()
    try:
        with ctx.store._txn() as con:
            con.execute(
                "INSERT INTO job(id, kind, status, payload, attempts, max_attempts, run_after, "
                "last_error, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
                (job_id, job_kind, "queued", dumps(payload), 0,
                 _as_int(params.get("max_attempts"), 5), run_after, None, stamp, stamp),
            )
        ctx.store.audit("job.enqueue", job_id, actor="workflow",
                        detail={"kind": job_kind, "run_id": ctx.run_id,
                                "run_after": run_after})
    except sqlite3.Error as exc:
        ctx.mark_degraded("schedule", "任务入队失败：%s" % exc)
        return {"status": "ok", "job_id": None, "kind": job_kind, "degraded": True,
                "reason": str(exc)[:200]}
    ctx.note({"job": job_id})
    return {"status": "ok", "job_id": job_id, "kind": job_kind, "run_after": run_after,
            "cron": params.get("cron"), "queued": True}


def node_emit(ctx: WorkflowContext, node: dict) -> dict:
    """事件广播：走 ctx.emitter（SSE），没有就写 audit。"""
    params = ctx.params
    channel = str(params.get("channel") or "ui")
    event_type = str(params.get("event") or "workflow.%s" % ctx.node_id)
    body = ctx.text_for("markdown", "text", "summary", "content")
    data = {"run_id": ctx.run_id, "template": ctx.template_id, "node_id": ctx.node_id,
            "channel": channel, "status": "ok", "preview": _clip_text(body, 200)}
    if params.get("format"):
        data["format"] = params["format"]
    if params.get("schema"):
        data["schema"] = params["schema"]
    delivered = False
    emitter = ctx.emitter
    if emitter is not None:
        payload = {"type": event_type, "data": data}
        try:
            if callable(emitter):
                emitter(payload)
                delivered = True
            elif hasattr(emitter, "emit"):
                emitter.emit(payload)
                delivered = True
            elif hasattr(emitter, "put"):
                emitter.put(payload)
                delivered = True
        except Exception as exc:
            ctx.mark_degraded("emit", "广播失败：%s" % type(exc).__name__)
    try:
        ctx.store.audit("workflow.emit", ctx.run_id, actor="workflow",
                        detail={"type": event_type, "channel": channel,
                                "delivered": delivered})
    except Exception:  # pragma: no cover
        pass
    # 没有 SSE 订阅者时写 audit 是设计行为（不是能力降级），只在输出里如实标注
    return {"status": "ok", "event": event_type, "channel": channel,
            "delivered": delivered, "via": "sse" if delivered else "audit",
            "payload": data, "body": _clip_text(body, 600)}



# ============================================================
# 12. 降级实现（fallback:<name>）
# ============================================================
# 每个模板 fallbacks 里出现的名字都必须有确定性实现；它们一律不碰模型。
from contextlib import contextmanager


@contextmanager
def _offline(ctx: WorkflowContext):
    """临时关闭模型通路：fallback 实现必须是确定性的。"""
    prev_llm, prev_gw = ctx.use_llm, ctx.gw
    ctx.use_llm, ctx.gw = False, None
    try:
        yield ctx
    finally:
        ctx.use_llm, ctx.gw = prev_llm, prev_gw


def fb_rule_extract(ctx: WorkflowContext, node: dict) -> dict:
    """规则抽取：标题 + 句子 + 意图词。"""
    text = ctx.text_for("text", "content", "body")
    params = dict(ctx.params)
    params["max_items"] = _as_int(params.get("max_items"), 5)
    items = _rule_extract(text, params)
    ctx.mark_degraded("extract", "规则抽取（fallback）")
    return {"status": "ok", "mode": "rule", "items": items, "count": len(items),
            "intents": _intent_words(text), "degraded": True, "fallback": "rule-extract"}


def fb_rule_classify(ctx: WorkflowContext, node: dict) -> dict:
    """关键词分类。"""
    kinds = [str(k) for k in _as_list(ctx.params.get("kinds"))] or list(KINDS_OF_MEMORY)
    items = _candidates(ctx, ("items", "values", "results")) or [
        {"title": _rule_title(ctx.text_for("text", "content")),
         "body": ctx.text_for("text", "content")}]
    out = []
    for item in items:
        row = dict(item) if isinstance(item, Mapping) else {"body": str(item)}
        kind = _guess_kind(_text_of(row))
        merged = dict(row)
        merged["kind"] = kind if kind in kinds else kinds[0]
        merged["category"] = row.get("category") or "general"
        merged["importance"] = _clamp(row.get("importance"), 0.5)
        out.append(merged)
    ctx.mark_degraded("classify", "关键词规则分类（fallback）")
    return {"status": "ok", "mode": "rule", "items": out, "count": len(out), "kinds": kinds,
            "degraded": True, "fallback": "rule-classify"}


def fb_score_threshold(ctx: WorkflowContext, node: dict) -> dict:
    """阈值规则判定：cos / jaccard 落在哪个带就给哪个动作。"""
    near = _candidates(ctx, ("hits", "items", "values", "results"))
    candidate = _judge_subject(ctx)
    best = near[0] if near and isinstance(near[0], Mapping) else {}
    sim = max(_as_float(best.get("sim"), 0.0), _as_float(best.get("score"), 0.0))
    verdict = _rule_dedup(candidate, best, sim)
    ctx.mark_degraded("judge", "阈值规则判定（fallback: score-threshold）")
    return {"status": "ok", "mode": "threshold", "action": verdict["action"],
            "target_id": verdict.get("target_id"), "confidence": verdict["confidence"],
            "reason": verdict["reason"], "sim": round(sim, 4), "knn": {"score": sim},
            "degraded": True, "fallback": "score-threshold",
            "should_merge": verdict["action"] in ("merge", "update", "supersede", "noop"),
            "should_add": verdict["action"] == "add",
            "has_conflict": verdict["action"] == "ask"}


def fb_quote_check_only(ctx: WorkflowContext, node: dict) -> dict:
    """仅做引句核验（不调模型）。"""
    with _offline(ctx):
        out = _verify_quotes(ctx, dict(ctx.params))
    out["fallback"] = "quote-check-only"
    out["degraded"] = True
    return out


def fb_heading_based_split(ctx: WorkflowContext, node: dict) -> dict:
    """按标题层级切分（didactic 六层的确定性拆法）。"""
    text = ctx.text_for("text", "content", "body")
    params = {"headings": True, "tokens": _as_int(ctx.params.get("tokens"), 600), "overlap": 0}
    out = _chunk_text(ctx, params, text)
    layers: dict[str, list] = {}
    for unit in out.get("units") or []:
        heading = str(unit.get("heading") or "").lower()
        for layer in ("definition", "theorem", "property", "formula", "derivation", "example"):
            if layer in heading:
                layers.setdefault(layer, []).append(unit)
    ctx.mark_degraded("extract", "按标题切分教学层（fallback）")
    return {"status": "ok", "mode": "heading-split", "units": out.get("units") or [],
            "layers": {k: len(v) for k, v in layers.items()}, "count": out.get("count", 0),
            "degraded": True, "fallback": "heading-based-split"}


def fb_keep_source_tex(ctx: WorkflowContext, node: dict) -> dict:
    """保留原文 TeX（不做 KaTeX 转换）。"""
    text = ctx.text_for("text", "content", "body")
    formulas = re.findall(r"\$\$?.+?\$\$?|\\\(.+?\\\)|\\\[.+?\\\]", text, re.S)
    ctx.mark_degraded("transform", "公式保留原文 TeX（fallback）")
    return {"status": "ok", "mode": "keep-source-tex", "formulas": formulas[:50],
            "count": len(formulas), "output": "tex", "degraded": True,
            "fallback": "keep-source-tex"}


def fb_cloze_from_text(ctx: WorkflowContext, node: dict) -> dict:
    """从正文生成填空卡（SM-2 复习用）。"""
    text = ctx.text_for("text", "content", "body")
    cards = []
    for sentence in _sentences(text)[:5]:
        words = _keywords_of(sentence, 2)
        blank = words[0] if words else ""
        cards.append({"type": "cloze",
                      "question": sentence.replace(blank, "____", 1) if blank else sentence,
                      "answer": blank, "source": "fallback"})
    ctx.mark_degraded("generate", "填空卡由正文生成（fallback）")
    return {"status": "ok", "mode": "cloze", "cards": cards, "items": cards,
            "count": len(cards), "degraded": True, "fallback": "cloze-from-text"}


def fb_lead_sentences(ctx: WorkflowContext, node: dict) -> dict:
    """抽取式摘要：首句 + 均衡挑句。"""
    text = ctx.text_for("text", "content", "body")
    budget = _as_int(ctx.params.get("max_tokens"), 180)
    summary = _rule_summary(text, budget)
    ctx.mark_degraded("generate", "抽取式摘要（fallback: lead-sentences）")
    return {"status": "ok", "mode": "extractive", "summary": _clip_text(summary, 1200),
            "text": _clip_text(summary, 2000), "bullets": _bullet_points(text, 3),
            "degraded": True, "fallback": "lead-sentences"}


def fb_capitalized_noun_phrase(ctx: WorkflowContext, node: dict) -> dict:
    """实体抽取：大写词 / 中文名词短语。"""
    text = ctx.text_for("text", "content", "body")
    names: list[str] = []
    for match in re.finditer(r"\b[A-Z][A-Za-z0-9_\-]{1,30}\b", text):
        token = match.group(0)
        if token not in names:
            names.append(token)
    for token in _keywords_of(text, 12):
        if token not in names:
            names.append(token)
    kinds = [str(k) for k in _as_list(ctx.params.get("kinds"))] or ["concept"]
    items = [{"title": name, "body": name, "kind": kinds[0], "source": "fallback"}
             for name in names[:20]]
    ctx.mark_degraded("extract", "大写词/名词短语实体（fallback）")
    return {"status": "ok", "mode": "capitalized", "items": items, "count": len(items),
            "degraded": True, "fallback": "capitalized-noun-phrase"}


def _cooccurrence_pairs(ctx: WorkflowContext, window: int = 120) -> list[dict]:
    """共现关系：在滑动窗口内同时出现的实体两两配对。"""
    names = _entity_names(ctx, ctx.params) or _keywords_of(
        ctx.text_for("content", "text"), 10)
    text = ctx.text_for("content", "text", "body")
    pairs = []
    for i in range(len(names)):
        for j in range(i + 1, len(names)):
            left, right = names[i], names[j]
            pos_a, pos_b = text.find(left), text.find(right)
            if pos_a < 0 or pos_b < 0:
                continue
            if abs(pos_a - pos_b) <= window:
                pairs.append({"src": left, "dst": right, "rel": "semantic",
                              "confidence": round(max(0.3, 1.0 - abs(pos_a - pos_b)
                                                      / max(1, window)), 3)})
    return pairs[:60]


def fb_cooccurrence(ctx: WorkflowContext, node: dict) -> dict:
    """共现建边。"""
    pairs = _cooccurrence_pairs(ctx, _as_int(ctx.params.get("window"), 120))
    ctx.mark_degraded("graph", "共现窗口建边（fallback）")
    return {"status": "ok", "mode": "cooccurrence", "pairs": pairs, "items": pairs,
            "count": len(pairs), "degraded": True, "fallback": "cooccurrence"}


def fb_cooccurrence_window(ctx: WorkflowContext, node: dict) -> dict:
    """共现窗口建边（relations 节点的 fallback）。"""
    out = fb_cooccurrence(ctx, node)
    out["fallback"] = "cooccurrence-window"
    return out


def fb_char_ngram_hash(ctx: WorkflowContext, node: dict) -> dict:
    """本地 char n-gram hash 向量（256 维）。"""
    items = _embed_targets(ctx)
    pairs = []
    for item in items:
        pairs.append((_owner_id(item), _l2(vectors.hash_embed(_text_of(item)[:2000]))))
    written = 0
    try:
        with vectors.VectorIndex(ctx.store, model=vectors.MODEL_LOCAL) as index:
            written = index.put_many("memory", pairs, model=vectors.MODEL_LOCAL)
    except Exception as exc:
        ctx.mark_degraded("vector", "本地向量写入失败：%s" % type(exc).__name__)
    ctx.mark_degraded("vector", "char n-gram hash 向量（fallback）")
    return {"status": "ok", "mode": "hash", "model": vectors.MODEL_LOCAL,
            "count": len(pairs), "written": written, "dim": vectors.DIM,
            "degraded": True, "fallback": "char-ngram-hash"}


def fb_bm25_only(ctx: WorkflowContext, node: dict) -> dict:
    """只用全文通道召回。"""
    query = str(ctx.params.get("query") or ctx.text_for("query", "text", "content") or "")
    top_k = _as_int(ctx.params.get("top_k"), 40)
    if query.strip():
        res = retrieval.search(ctx.store, None, query, scope=ctx.scope, limit=top_k,
                               strategy="bm25")
    else:
        res = {"hits": [], "degraded": []}
    hits = list(res.get("hits") or [])
    for hit in hits:
        if isinstance(hit, dict):
            hit["sim"] = round(_clamp(_jaccard(query, str(hit.get("title") or ""))), 4)
    ctx.mark_degraded("vector", "仅全文通道（fallback: bm25-only）")
    return {"status": "ok", "engine": "bm25", "hits": hits, "count": len(hits),
            "strategy": "bm25", "degraded": True, "fallback": "bm25-only"}


def fb_skip(ctx: WorkflowContext, node: dict) -> dict:
    """该分支在降级时直接跳过（返回空结果，不算失败）。"""
    ctx.mark_degraded(str(node.get("id") or "skip"), "降级时跳过（fallback: skip）")
    return {"status": "ok", "skipped": True, "hits": [], "items": [], "count": 0,
            "reason": "降级路径要求跳过该步", "degraded": True, "fallback": "skip"}


def fb_score_passthrough(ctx: WorkflowContext, node: dict) -> dict:
    """分数透传：保持原有顺序。"""
    items = _candidates(ctx, ("hits", "items", "values", "results"))
    rows = [dict(i) if isinstance(i, Mapping) else {"value": i} for i in items]
    ctx.mark_degraded("rerank", "分数透传（fallback: score-passthrough）")
    return {"status": "ok", "algorithm": "score-passthrough", "hits": rows, "items": rows,
            "count": len(rows), "degraded": True, "fallback": "score-passthrough"}


def fb_trust_weight_order(ctx: WorkflowContext, node: dict) -> dict:
    """按可信度权重排序证据。"""
    with _offline(ctx):
        out = _judge_trust(ctx, dict(ctx.params),
                           _candidates(ctx, ("hits", "items", "values")))
    out["degraded"] = True
    out["fallback"] = "trust-weight-order"
    return out


def fb_template_report(ctx: WorkflowContext, node: dict) -> dict:
    """模板化报告（不用模型）。"""
    body = _render_report(ctx)
    ctx.mark_degraded("generate", "模板化报告（fallback: template-report）")
    return {"status": "ok", "mode": "template", "markdown": body,
            "text": _clip_text(body, 3000), "degraded": True,
            "fallback": "template-report"}


def fb_keyword_time_slice(ctx: WorkflowContext, node: dict) -> dict:
    """关键词 + 时间窗切片抽取决策要点。"""
    text = ctx.text_for("text", "content", "body")
    cues = ("决定", "采用", "选择", "改为", "因为", "结果", "decided", "chose", "because")
    picked = [s for s in _sentences(text) if any(cue in s for cue in cues)][:5]
    items = [{"title": _rule_title(s), "body": _clip_text(s, 500), "kind": "decision",
              "context": _clip_text(text[:200], 200)} for s in picked]
    ctx.mark_degraded("extract", "关键词时间切片（fallback）")
    return {"status": "ok", "mode": "keyword-time-slice", "items": items,
            "count": len(items), "degraded": True, "fallback": "keyword-time-slice"}


def fb_title_as_cue(ctx: WorkflowContext, node: dict) -> dict:
    """标题转抽象线索。"""
    text = ctx.text_for("text", "content", "body")
    title = _rule_title(text, "这段内容")
    cues = ["%s是什么？" % title, "%s的关键点有哪些？" % title, "为什么是 %s？" % title]
    ctx.mark_degraded("generate", "标题转线索（fallback: title-as-cue）")
    return {"status": "ok", "mode": "cue", "cues": cues, "text": "\n".join(cues),
            "count": len(cues), "degraded": True, "fallback": "title-as-cue"}


def fb_mark_degraded_keep_old(ctx: WorkflowContext, node: dict) -> dict:
    """标降级、保留旧向量，不做增量写。"""
    try:
        existing = ctx.store.con.execute("SELECT count(*) FROM vector").fetchone()[0]
    except sqlite3.Error:
        existing = 0
    ctx.mark_degraded("vector", "保留旧向量（fallback: mark-degraded-keep-old）")
    return {"status": "ok", "mode": "keep-old", "existing": existing, "written": 0,
            "degraded": True, "fallback": "mark-degraded-keep-old"}


def fb_score_rule(ctx: WorkflowContext, node: dict) -> dict:
    """纯评分规则判定（dedup 版）。"""
    near = _candidates(ctx, ("hits", "items", "values", "results"))
    best = near[0] if near and isinstance(near[0], Mapping) else {}
    sim = max(_as_float(best.get("sim"), 0.0), _as_float(best.get("score"), 0.0))
    verdict = _rule_dedup(_judge_subject(ctx), best, sim)
    ctx.mark_degraded("judge", "评分规则判定（fallback: score-rule）")
    return {"status": "ok", "mode": "score-rule", "action": verdict["action"],
            "target_id": verdict.get("target_id"), "confidence": verdict["confidence"],
            "reason": verdict["reason"], "sim": round(sim, 4), "knn": {"score": sim},
            "degraded": True, "fallback": "score-rule",
            "should_merge": verdict["action"] in ("merge", "update", "supersede", "noop"),
            "should_add": verdict["action"] == "add",
            "has_conflict": verdict["action"] == "ask"}


def fb_fts_near(ctx: WorkflowContext, node: dict) -> dict:
    """全文近似召回（去重场景的 fallback）。"""
    params = dict(ctx.params)
    params["methods"] = params.get("methods") or ["jaccard"]
    out = _near_dup(ctx, params, str(ctx.inputs.get("content") or ""),
                    _as_int(params.get("top_k"), 10), ctx.scope)
    out["engine"] = "fts-near"
    out["degraded"] = True
    out["fallback"] = "fts-near"
    ctx.mark_degraded("vector", "全文近似召回（fallback: fts-near）")
    return out


def fb_timestamp_order(ctx: WorkflowContext, node: dict) -> dict:
    """按时间戳判断先后。"""
    a = _subject_by_key(ctx, "a_id") or _judge_subject(ctx)
    b = _subject_by_key(ctx, "b_id")
    at_a = str(a.get("recorded_at") or a.get("valid_from") or "")
    at_b = str(b.get("recorded_at") or b.get("valid_from") or "")
    relation = "unknown"
    if at_a and at_b:
        relation = "before" if at_a < at_b else ("after" if at_a > at_b else "overlap")
    ctx.mark_degraded("judge", "时间戳先后（fallback: timestamp-order）")
    return {"status": "ok", "mode": "timestamp", "relation": relation, "action": relation,
            "a_at": at_a, "b_at": at_b, "degraded": True, "fallback": "timestamp-order",
            "should_supersede": relation == "after"}


def fb_sentence_split(ctx: WorkflowContext, node: dict) -> dict:
    """按句拆解（记忆原子化）。"""
    out = _split_sentences(ctx.text_for("text", "content", "body"), ctx.params)
    out["degraded"] = True
    out["fallback"] = "sentence-split"
    ctx.mark_degraded("transform", "按句拆解（fallback: sentence-split）")
    return out


def fb_template_digest(ctx: WorkflowContext, node: dict) -> dict:
    """模板化摘要包（编号引用 + 标题）。"""
    hits = _candidates(ctx, ("hits", "items", "values", "results"))
    budget = _as_int(ctx.params.get("budget") or ctx.inputs.get("budget"), 800)
    lines = []
    used = 0
    for index, hit in enumerate(hits):
        row = dict(hit) if isinstance(hit, Mapping) else {"title": str(hit)}
        text = "- [%d] %s：%s" % (index + 1, row.get("title") or "",
                                  _clip_text(_text_of(row), 160)
                                  or (row.get("snippet") or ""))
        cost = _est_tokens(text)
        if used + cost > budget:
            break
        lines.append(text)
        used += cost
    body = "\n".join(lines) or "（暂无可用记忆）"
    ctx.mark_degraded("generate", "模板化摘要包（fallback: template-digest）")
    return {"status": "ok", "mode": "template-digest", "text": body, "markdown": body,
            "count": len(lines), "tokens": used, "budget": budget, "degraded": True,
            "fallback": "template-digest"}


def fb_simple_age_rule(ctx: WorkflowContext, node: dict) -> dict:
    """简单年龄规则衰减（不看重要度）。"""
    params = dict(ctx.params)
    params["half_life_days"] = _as_float(params.get("half_life_days"), 30.0)
    with _offline(ctx):
        out = _fuse_decay(ctx, params)
    for row in out.get("items") or []:
        row["archive"] = _as_float(row.get("age_days"), 0.0) > 90
    out.update({"algorithm": "simple-age-rule", "degraded": True,
                "fallback": "simple-age-rule"})
    ctx.mark_degraded("fuse", "简单年龄规则（fallback: simple-age-rule）")
    return out


def fb_trust_and_time_order(ctx: WorkflowContext, node: dict) -> dict:
    """可信度优先、其次时间序裁决冲突。"""
    a = _subject_by_key(ctx, "a_id") or _judge_subject(ctx)
    b = _subject_by_key(ctx, "b_id")
    verdict = _rule_conflict(a, b)
    action = {"a": "keep_a", "b": "keep_b"}.get(str(verdict.get("preferred")), "ask_user")
    ctx.mark_degraded("judge", "可信度+时间序裁决（fallback: trust-and-time-order）")
    return {"status": "ok", "mode": "trust-and-time-order",
            "preferred": verdict["preferred"], "action": action,
            "reasons": verdict["reasons"], "confidence": verdict["confidence"],
            "degraded": True, "fallback": "trust-and-time-order",
            "has_conflict": verdict["preferred"] == "ask"}


def fb_frequency_count(ctx: WorkflowContext, node: dict) -> dict:
    """频次统计：同一模式出现 N 次才算习惯。"""
    text = ctx.text_for("text", "content", "body")
    counts: dict[str, int] = {}
    for token in _WORD_RE.findall(text):
        if token in _BANNED_TITLE or len(token) < 2:
            continue
        counts[token] = counts.get(token, 0) + 1
    ranked = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
    items = [{"title": name, "count": count, "kind": "preference"}
             for name, count in ranked if count >= 2]
    ctx.mark_degraded("extract", "频次统计（fallback: frequency-count）")
    return {"status": "ok", "mode": "frequency", "items": items[:20],
            "count": len(items[:20]), "degraded": True, "fallback": "frequency-count"}


def fb_connected_components(ctx: WorkflowContext, node: dict) -> dict:
    """连通分量社区发现。"""
    out = _graph_community(ctx, ctx.params)
    out.update({"degraded": True, "fallback": "connected-components"})
    ctx.mark_degraded("graph", "连通分量社区（fallback）")
    return out


def fb_degree(ctx: WorkflowContext, node: dict) -> dict:
    """度中心性。"""
    out = _graph_centrality(ctx, ctx.params)
    out.update({"degraded": True, "fallback": "degree"})
    ctx.mark_degraded("graph", "度中心性（fallback）")
    return out


def fb_cloze_template(ctx: WorkflowContext, node: dict) -> dict:
    """填空模板生成题目。"""
    out = _generate_quiz(ctx, dict(ctx.params), ctx.text_for("text", "content", "body"))
    out.update({"degraded": True, "fallback": "cloze-template"})
    ctx.mark_degraded("generate", "填空模板出题（fallback）")
    return out


def fb_string_similarity(ctx: WorkflowContext, node: dict) -> dict:
    """字符串相似度批改（无模型）。"""
    reference = str(ctx.inputs.get("reference") or ctx.text_for("reference", "answer") or "")
    answer = str(ctx.inputs.get("answer") or ctx.text_for("answer") or "")
    score = round(_jaccard(reference, answer) * 5, 2) if reference or answer else 0.0
    ctx.mark_degraded("judge", "字符串相似度批改（fallback: string-similarity）")
    return {"status": "ok", "mode": "string-similarity", "score": score, "max": 5,
            "hit": sorted(set(_WORD_RE.findall(reference.lower()))
                          & set(_WORD_RE.findall(answer.lower())))[:10],
            "degraded": True, "fallback": "string-similarity"}


FALLBACKS: dict[str, Callable[[WorkflowContext, dict], dict]] = {
    "rule-extract": fb_rule_extract,
    "rule-classify": fb_rule_classify,
    "score-threshold": fb_score_threshold,
    "quote-check-only": fb_quote_check_only,
    "heading-based-split": fb_heading_based_split,
    "keep-source-tex": fb_keep_source_tex,
    "cloze-from-text": fb_cloze_from_text,
    "lead-sentences": fb_lead_sentences,
    "capitalized-noun-phrase": fb_capitalized_noun_phrase,
    "cooccurrence": fb_cooccurrence,
    "cooccurrence-window": fb_cooccurrence_window,
    "char-ngram-hash": fb_char_ngram_hash,
    "bm25-only": fb_bm25_only,
    "skip": fb_skip,
    "score-passthrough": fb_score_passthrough,
    "trust-weight-order": fb_trust_weight_order,
    "template-report": fb_template_report,
    "keyword-time-slice": fb_keyword_time_slice,
    "title-as-cue": fb_title_as_cue,
    "mark-degraded-keep-old": fb_mark_degraded_keep_old,
    "score-rule": fb_score_rule,
    "fts-near": fb_fts_near,
    "timestamp-order": fb_timestamp_order,
    "sentence-split": fb_sentence_split,
    "template-digest": fb_template_digest,
    "simple-age-rule": fb_simple_age_rule,
    "trust-and-time-order": fb_trust_and_time_order,
    "frequency-count": fb_frequency_count,
    "connected-components": fb_connected_components,
    "degree": fb_degree,
    "cloze-template": fb_cloze_template,
    "string-similarity": fb_string_similarity,
}


def _register_defaults() -> None:
    """把 17 种节点与 32 个 fallback 注册进 NODE_HANDLERS。"""
    kinds = {
        "input": node_input, "transform": node_transform, "extract": node_extract,
        "classify": node_classify, "retrieve": node_retrieve, "embed": node_embed,
        "rerank": node_rerank, "fuse": node_fuse, "judge": node_judge,
        "verify": node_verify, "persist": node_persist, "index": node_index,
        "graph": node_graph, "generate": node_generate, "decide": node_decide,
        "schedule": node_schedule, "emit": node_emit,
    }
    for kind, handler in kinds.items():
        register_handler(kind, handler)
    for name, handler in FALLBACKS.items():
        register_handler(FALLBACK_PREFIX + name, handler)


_register_defaults()



# ============================================================
# 13. 运行辅助（执行器内部）
# ============================================================
def _skip_artifacts(ctx: WorkflowContext, status: str = "skipped", reason: str = "") -> dict:
    """失败 / 跳过节点的占位产物（下游据此判定与记录）。"""
    return {"status": status, "skipped": True, "reason": reason or "上游未成功",
            "values": [], "items": [], "hits": []}


def _template_spec(template: Mapping[str, Any]) -> dict:
    """把模板（DB 行或内置 dict）统一成 DAG 规格。"""
    spec = _spec_of(template)
    if not spec.get("nodes"):
        spec = dict(template or {})
        spec["nodes"] = [n for n in _as_list(spec.get("nodes")) if isinstance(n, Mapping)]
        spec["edges"] = [e for e in _as_list(spec.get("edges")) if isinstance(e, Mapping)]
        spec["fallbacks"] = dict(spec.get("fallbacks") or {})
    return spec


def _load_template(store, template_id: str) -> dict:
    """取模板；DB 里没有就先补种内置模板再取。"""
    template = get_template(store, template_id)
    if template is not None:
        return template
    seed_templates(store)
    template = get_template(store, template_id)
    if template is None:
        raise WorkflowNotFound("工作流模板不存在：%s" % template_id)
    return template


def _run_output(steps: list) -> dict:
    """汇总运行输出：终态节点的产物 + 关键字段（summary / hits / action / job）。"""
    done = [s for s in steps if s.get("status") in ("ok", "degraded")]
    last = done[-1] if done else (steps[-1] if steps else {})
    out = dict(last.get("output") or {}) if isinstance(last, dict) else {}
    summary = ""
    if isinstance(out, dict):
        for key in ("text", "summary", "markdown", "reason", "preview", "body"):
            value = out.get(key)
            if isinstance(value, str) and value.strip():
                summary = _clip_text(value, 600)
                break
    output = {
        "summary": summary,
        "last_node": last.get("node_id") if isinstance(last, dict) else None,
        "step_count": len(steps),
        "steps": {s.get("node_id"): s.get("status") for s in steps},
    }
    for key in ("hits", "items", "values", "action", "job_id", "path", "verdict",
                "communities", "count", "memory_id", "relation", "entities", "written",
                "candidates"):
        if isinstance(out, dict) and key in out:
            value = out[key]
            output[key] = len(value) if isinstance(value, list) else value
    if isinstance(out, dict) and isinstance(out.get("text"), str):
        output["text"] = _clip_text(out["text"], 400)
    return output


def _handler_for(node: Mapping[str, Any]) -> Callable[[WorkflowContext, dict], dict]:
    """取节点处理器；缺失时登记为 noop 并标 degraded（架构 §4.6）。"""
    kind = str(node.get("kind") or "").strip()
    handler = resolve_handler(kind)
    if handler is not None:
        return handler

    def _noop(ctx: WorkflowContext, _node: dict) -> dict:
        ctx.mark_degraded(kind or "unknown", "节点类型未实现，登记为 noop")
        return {"status": "ok", "noop": True, "kind": kind, "degraded": True,
                "reason": "节点类型未实现：%s" % kind}

    return _noop


def _thread_store(store):
    """为工作线程准备 Store 实例（同库同 vault，各自持有连接）。"""
    vault = getattr(store, "vault", None)
    if Store is not None and getattr(store, "db_path", None) is not None:
        try:
            return Store(store.db_path, vault)
        except Exception:  # pragma: no cover
            return store
    return store


def _close_store(candidate, original) -> None:
    """关闭线程内自建的 Store（调用方那个不关）。"""
    if candidate is original or candidate is None:
        return
    closer = getattr(candidate, "close", None)
    if callable(closer):
        try:
            closer()
        except Exception:  # pragma: no cover
            pass


def _visible_snapshot(artifacts: Mapping[str, Any], node_id: str,
                      parents: Mapping[str, list[dict]]) -> dict:
    """祖先链快照：只暴露祖先与自身（兄弟分支不可见）。"""
    names = _self_and_ancestors(node_id, parents)
    return {name: artifacts[name] for name in names if name in artifacts}


def _edge_decision(node_id: str, parents: Mapping[str, list[dict]],
                   artifacts: Mapping[str, Any], statuses: Mapping[str, str],
                   degraded: Mapping[str, bool]) -> tuple[bool, str]:
    """按入边 when 决定节点是否执行：至少一条边成立才跑。"""
    edges = parents.get(node_id) or []
    if not edges:
        return True, ""
    reasons = []
    for edge in edges:
        src = edge["from"]
        status = statuses.get(src, "skipped")
        is_degraded = bool(degraded.get(src)) or status == "degraded"
        if _when_holds(edge.get("when", "always"), status, is_degraded, artifacts):
            return True, ""
        reasons.append("%s[%s]" % (src, edge.get("when")))
    return False, "边条件未命中：" + ", ".join(reasons)


def _node_context(store, gw, template, node, *, run_id, tpl_id, tpl_name, inputs, scope,
                  artifacts, ordinal, emitter, fallbacks) -> WorkflowContext:
    """装配节点上下文（可见集合由调用方给）。"""
    ctx = WorkflowContext(
        store=store, gw=gw, inputs=dict(inputs or {}), scope=scope, run_id=run_id,
        emitter=emitter, degraded=[], artifacts=dict(artifacts or {}),
        run_key=run_id, template_id=tpl_id, template_name=tpl_name,
        node_id=str(node.get("id") or ""), node=dict(node),
        params=dict(node.get("params") or {}), ordinal=ordinal,
        template=template, fallbacks=dict(fallbacks or {}), use_llm=gw is not None,
    )
    ctx.step_meta["template"] = template
    ctx.step_meta["attempts"] = []
    ctx.step_meta["metrics"] = {}
    return ctx


def _record_skip(store, run_id, node, *, tpl_id, tpl_name, template, fallbacks, inputs,
                 scope, gw, emitter, ordinal, status, reason) -> dict:
    """把跳过 / 取消的节点落成 workflow_step 行。"""
    ctx = _node_context(store, gw, template, node, run_id=run_id, tpl_id=tpl_id,
                        tpl_name=tpl_name, inputs=inputs, scope=scope, artifacts={},
                        ordinal=ordinal, emitter=emitter, fallbacks=fallbacks)
    ctx.step_meta["attempts"] = [{"kind": status, "reason": reason}]
    ctx.step_meta["metrics"] = {"ms": 0}
    output = _skip_artifacts(ctx, status, reason)
    _persist_step(store, run_id, ctx, ordinal, status=status, output=output,
                  started=iso_now(), finished=iso_now())
    return {"node_id": ctx.node_id, "status": status, "output": output, "degraded": False,
            "error": None, "degraded_list": [], "skipped": True, "ms": 0}


# ============================================================
# 14. 单节点执行（失败传播 / 降级都收敛在这里）
# ============================================================
def _execute_node(store, gw, template, node, *, run_id, inputs, scope, visible,
                  ordinal, cancel, emitter, fallbacks, tpl_id, tpl_name) -> dict:
    """执行单个节点；返回 {status, output, degraded, error, degraded_list, ms}。"""
    ctx = _node_context(store, gw, template, node, run_id=run_id, tpl_id=tpl_id,
                        tpl_name=tpl_name, inputs=inputs, scope=scope, artifacts=visible,
                        ordinal=ordinal, emitter=emitter, fallbacks=fallbacks)
    runner = _handler_for(node)
    ctx.step_meta["attempts"].append({"kind": "handler", "name": str(node.get("kind"))})
    started_iso = iso_now()
    started_ms = _now_ms()
    status = "ok"
    output: Any = {}
    error: str | None = None
    degraded = False
    model = ""
    tokens = 0
    skipped = False

    try:
        result = runner(ctx, dict(node))
        output = result if isinstance(result, dict) else {"value": result}
        if not isinstance(result, dict):
            ctx.mark_degraded(str(node.get("kind")), "处理器返回非 dict，已包装")
    except Exception as exc:
        ctx.step_meta.setdefault("metrics", {})["ms"] = int(_now_ms() - started_ms)
        if _unavailable(exc):
            status, output, error, degraded = _run_fallback(ctx, template, node, exc)
        else:
            status = "failed"
            error = "%s: %s" % (type(exc).__name__, str(exc)[:400])
            output = {"error": error, "trace": traceback.format_exc(limit=3)[-600:]}
    finally:
        metrics = ctx.step_meta.setdefault("metrics", {})
        if "ms" not in metrics:
            metrics["ms"] = int(max(0, _now_ms() - started_ms))

    finished_iso = iso_now()
    if isinstance(output, Mapping):
        degraded = degraded or bool(output.get("degraded"))
        model = str(output.get("model")
                    or (ctx.step_meta.get("metrics") or {}).get("model") or "")
        tokens = _as_int(output.get("tokens")
                         or (ctx.step_meta.get("metrics") or {}).get("tokens"), 0)
        skipped = bool(output.get("skipped"))
        if isinstance(output.get("_meta"), Mapping):
            output = dict(output)
            output.pop("_meta", None)
    if degraded and status == "ok":
        status = "degraded"

    _persist_step(store, run_id, ctx, ordinal, status=status, output=output, error=error,
                  degraded=degraded, started=started_iso, finished=finished_iso,
                  model=model, tokens=tokens)
    return {"node_id": ctx.node_id, "status": status,
            "output": dict(output) if isinstance(output, dict) else {"value": output},
            "degraded": bool(degraded), "error": error,
            "degraded_list": list(ctx.degraded), "skipped": skipped,
            "ms": (ctx.step_meta.get("metrics") or {}).get("ms")}


def _run_fallback(ctx: WorkflowContext, template, node, exc) -> tuple:
    """ModelUnavailable：有 fallback 就执行，没有就标 degraded 继续。"""
    node_id = str(node.get("id") or "")
    name = str((template.get("fallbacks") or {}).get(node_id) or "").strip()
    handler = resolve_handler(FALLBACK_PREFIX + name) if name else None
    role = str(getattr(exc, "role", node.get("kind")) or node.get("kind"))
    ctx.step_meta["attempts"].append({
        "kind": "fallback", "name": name or None, "available": bool(handler),
        "reason": str(exc)[:200]})
    ctx.mark_degraded(role, str(exc)[:200])
    if handler is None:
        reason = "模型不可用且无 fallback：%s" % str(exc)[:200]
        return ("degraded",
                {"degraded": True, "reason": reason, "values": [], "items": [], "hits": []},
                None, True)
    try:
        result = handler(ctx, dict(node))
    except Exception as exc2:
        err = "模型不可用且 fallback 失败：%s / %s" % (type(exc).__name__,
                                                      type(exc2).__name__)
        return "failed", {"fallback": name, "error": err,
                          "detail": str(exc2)[:300]}, err, True
    output = result if isinstance(result, dict) else {"value": result}
    output.setdefault("fallback", name)
    output.setdefault("fallback_reason", str(exc)[:200])
    output["degraded"] = True
    return "degraded", output, None, True


# ============================================================
# 15. 对外接口
# ============================================================
def run_workflow(store, gw, template_id: str, inputs: dict, scope: str = "global",
                 trigger: str = "manual", parent_run_id: str | None = None,
                 emitter: Any = None, cancel: Any = None,
                 max_workers: int = MAX_WORKERS, mode: str = "fail") -> dict:
    """执行一条工作流，返回冻结格式的 run dict。

    语义：
      1. 拓扑分层，同层并行（ThreadPoolExecutor，上限 4）；
      2. 节点只读祖先链产物（兄弟分支不可见）；
      3. 边 when 支持 always / on_success / on_degraded / if:<key>；
      4. 节点抛非 ModelUnavailable → failed，下游 skipped，run failed；
      5. ModelUnavailable → 有 fallback 执行之，无则标 degraded 继续，run partial；
      6. 全部输入与步骤输出落库，可按同一输入重跑对比。

    mode：
      "fail"（默认）—— 节点失败即整体失败，下游 skipped，run = failed；
      "skip"—— 该节点仍 failed，但只跳过它的下游，其余分支继续，run = partial。
    """
    if store is None:
        raise WorkflowError("run_workflow 需要 store")
    mode = str(mode or "fail").strip().lower()
    if mode not in RUN_MODES:
        raise ValueError("未知运行模式：%s（可选 %s）" % (mode, "/".join(RUN_MODES)))
    template = _load_template(store, str(template_id or ""))
    spec = _template_spec(template)
    nodes = _node_map(spec.get("nodes") or [])
    if not nodes:
        raise WorkflowError("模板没有可执行节点：%s" % template_id)
    parents = _parent_map(spec.get("edges") or [], nodes)
    order = _level_order(nodes, parents)

    run_inputs = _normalize_inputs(inputs)
    run_id = _new_id("run")
    stamp = iso_now()
    tpl_id = str(template.get("id") or template_id)
    tpl_name = str(template.get("name") or tpl_id)
    fallbacks = dict(spec.get("fallbacks") or {})
    sink = emitter if emitter is not None else RunEmitter(store)
    ordinals: dict[str, int] = {}
    for layer in order:
        for nid in layer:
            ordinals[nid] = len(ordinals)

    with store._txn() as con:
        con.execute(
            "INSERT INTO workflow_run(id, template_id, template_name, scope_id, trigger, status, "
            "input, output, error, parent_run_id, created_at, started_at, finished_at, metadata) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (run_id, tpl_id, tpl_name, scope, trigger, "running", dumps(run_inputs), "{}",
             None, parent_run_id, stamp, stamp, None, dumps({"degraded": []})),
        )
        store.audit("workflow.run.start", run_id, actor="workflow",
                    detail={"template": tpl_id, "scope": scope, "trigger": trigger})

    artifacts: dict[str, Any] = {}
    statuses: dict[str, str] = {}
    degraded_map: dict[str, bool] = {}
    steps: list[dict] = []
    all_degraded: list[str] = []
    run_status = "ok"
    run_error: str | None = None
    cancelled = False

    def _cancelled() -> bool:
        if callable(cancel) and bool(cancel(run_id)):
            return True
        return _cancel_requested(store, run_id)

    try:
        for layer in order:
            if _cancelled():
                cancelled = True
                break
            runnable: list[str] = []
            for nid in layer:
                if nid in statuses:
                    # 已被失败传播 / 取消处理过，不要重复执行
                    continue
                ok, reason = _edge_decision(nid, parents, artifacts, statuses, degraded_map)
                if ok:
                    runnable.append(nid)
                    continue
                record = _record_skip(store, run_id, nodes[nid], tpl_id=tpl_id,
                                      tpl_name=tpl_name, template=template,
                                      fallbacks=fallbacks, inputs=run_inputs, scope=scope,
                                      gw=gw, emitter=sink, ordinal=ordinals[nid],
                                      status="skipped", reason=reason)
                artifacts[nid] = record["output"]
                statuses[nid] = "skipped"
                degraded_map[nid] = False
                steps.append(record)
            if not runnable:
                continue

            results: dict[str, dict] = {}
            if len(runnable) == 1 or max_workers <= 1:
                for nid in runnable:
                    results[nid] = _execute_node(
                        store, gw, template, nodes[nid], run_id=run_id, inputs=run_inputs,
                        scope=scope, visible=_visible_snapshot(artifacts, nid, parents),
                        ordinal=ordinals[nid], cancel=_cancelled, emitter=sink,
                        fallbacks=fallbacks, tpl_id=tpl_id, tpl_name=tpl_name)
            else:
                workers = min(MAX_WORKERS, max_workers, len(runnable))
                with ThreadPoolExecutor(max_workers=workers) as pool:
                    futures = {}
                    for nid in runnable:
                        thread_store = _thread_store(store)
                        futures[pool.submit(
                            _execute_node, thread_store, gw, template, nodes[nid],
                            run_id=run_id, inputs=run_inputs, scope=scope,
                            visible=_visible_snapshot(artifacts, nid, parents),
                            ordinal=ordinals[nid], cancel=_cancelled, emitter=sink,
                            fallbacks=fallbacks, tpl_id=tpl_id,
                            tpl_name=tpl_name)] = (nid, thread_store)
                    for future, (nid, thread_store) in futures.items():
                        try:
                            results[nid] = future.result()
                        except Exception as exc:  # 线程内兜底
                            results[nid] = {"node_id": nid, "status": "failed",
                                            "output": {}, "degraded": False,
                                            "error": "%s: %s" % (type(exc).__name__, exc),
                                            "degraded_list": [], "skipped": False, "ms": 0}
                        finally:
                            _close_store(thread_store, store)

            failed_now: list[str] = []
            for nid in runnable:
                result = results.get(nid) or {"node_id": nid, "status": "failed",
                                              "output": {}, "error": "节点没有返回结果"}
                artifacts[nid] = result.get("output") or {}
                statuses[nid] = str(result.get("status") or "failed")
                degraded_map[nid] = bool(result.get("degraded"))
                for name in result.get("degraded_list") or []:
                    if name not in all_degraded:
                        all_degraded.append(str(name))
                steps.append(result)
                if statuses[nid] == "failed":
                    failed_now.append(nid)
                    run_error = result.get("error") or run_error

            if failed_now:
                _skip_downstream(store, run_id, nodes, parents, artifacts, statuses,
                                 ordinals, failed_now, steps, run_inputs, scope, gw, sink,
                                 tpl_id, tpl_name, template, fallbacks)
                if mode == "fail":
                    run_status = "failed"
                    break
                # mode=skip：只掐掉失败节点的下游，其它分支继续跑
                run_status = "partial"
                run_error = run_error or "节点失败（mode=skip）：%s" % ", ".join(failed_now)
            if _cancelled():
                cancelled = True
                break
    except Exception as exc:
        run_status = "failed"
        run_error = "%s: %s" % (type(exc).__name__, str(exc)[:400])
        try:
            store.audit("workflow.run.error", run_id, actor="workflow",
                        detail={"error": run_error})
        except Exception:  # pragma: no cover
            pass

    if cancelled:
        run_status = "cancelled"
        _mark_cancelled(store, run_id, nodes, statuses, ordinals, steps, run_inputs, scope,
                        gw, sink, tpl_id, tpl_name, template, fallbacks)
    elif run_status != "failed" and all_degraded:
        run_status = "partial"

    steps.sort(key=lambda s: ordinals.get(str(s.get("node_id")), 0))
    output = _run_output(steps)
    finished = iso_now()
    _persist_run(store, run_id, status=run_status, output=output,
                 error=None if run_status in ("ok", "partial") else run_error,
                 finished=finished, degraded=all_degraded,
                 meta={"step_count": len(steps)})
    try:
        store.audit("workflow.run.end", run_id, actor="workflow",
                    detail={"status": run_status, "steps": len(steps),
                            "degraded": all_degraded, "error": run_error})
    except Exception:  # pragma: no cover
        pass
    return get_run(store, run_id) or {"id": run_id, "status": run_status, "steps": steps}


def _skip_downstream(store, run_id, nodes, parents, artifacts, statuses, ordinals, failed,
                     steps, inputs, scope, gw, emitter, tpl_id, tpl_name, template,
                     fallbacks) -> None:
    """失败传播：所有下游节点（含间接）标 skipped 并落库。"""
    downstream: set = set()
    frontier = list(failed)
    while frontier:
        current = frontier.pop()
        for nid, edges in parents.items():
            if nid in downstream or nid in failed:
                continue
            if any(edge["from"] == current for edge in edges):
                downstream.add(nid)
                frontier.append(nid)
    reason = "上游失败：%s" % ", ".join(sorted(failed))
    for nid in sorted(downstream, key=lambda n: ordinals.get(n, 0)):
        if statuses.get(nid) in ("ok", "degraded", "failed", "skipped"):
            continue
        record = _record_skip(store, run_id, nodes[nid], tpl_id=tpl_id, tpl_name=tpl_name,
                              template=template, fallbacks=fallbacks, inputs=inputs,
                              scope=scope, gw=gw, emitter=emitter,
                              ordinal=ordinals.get(nid, 0), status="skipped", reason=reason)
        artifacts[nid] = record["output"]
        statuses[nid] = "skipped"
        steps.append(record)


def _mark_cancelled(store, run_id, nodes, statuses, ordinals, steps, inputs, scope, gw,
                    emitter, tpl_id, tpl_name, template, fallbacks) -> None:
    """取消时把未执行的节点标 cancelled 并落库。"""
    for nid in sorted(nodes, key=lambda n: ordinals.get(n, 0)):
        if nid in statuses:
            continue
        record = _record_skip(store, run_id, nodes[nid], tpl_id=tpl_id, tpl_name=tpl_name,
                              template=template, fallbacks=fallbacks, inputs=inputs,
                              scope=scope, gw=gw, emitter=emitter,
                              ordinal=ordinals.get(nid, 0), status="cancelled",
                              reason="运行被取消")
        statuses[nid] = "cancelled"
        steps.append(record)


def cancel_run(store, run_id: str) -> dict:
    """取消一次运行：写取消标记；已结束的运行抛 WorkflowConflict。"""
    row = store.con.execute(
        "SELECT * FROM workflow_run WHERE id = ?", (str(run_id),)).fetchone()
    if row is None:
        raise WorkflowNotFound("运行不存在：%s" % run_id)
    status = str(row["status"])
    if status in ("ok", "partial", "failed", "cancelled"):
        raise WorkflowConflict("运行已结束（%s），无法取消：%s" % (status, run_id))
    meta = loads(row["metadata"], {}) or {}
    meta = meta if isinstance(meta, dict) else {}
    meta["cancel_requested"] = True
    meta["cancel_requested_at"] = iso_now()
    with store._txn() as con:
        con.execute("UPDATE workflow_run SET metadata = ?, status = ? WHERE id = ?",
                    (dumps(meta), "cancelled", str(run_id)))
    store.audit("workflow.cancel", str(run_id), actor="workflow", detail={"previous": status})
    return get_run(store, str(run_id)) or {"id": run_id, "status": "cancelled"}


def get_run(store, run_id: str) -> dict | None:
    """读一次运行（含步骤）。"""
    row = store.con.execute(
        "SELECT * FROM workflow_run WHERE id = ?", (str(run_id),)).fetchone()
    if row is None:
        return None
    return _run_row(row, _steps_of_run(store, str(run_id)))


def list_runs(store, limit: int = 50, template_id: str | None = None,
              status: str | None = None) -> list:
    """列出运行记录（不含步骤，供列表页）。"""
    sql = "SELECT * FROM workflow_run"
    where: list = []
    args: list = []
    if template_id:
        where.append("template_id = ?")
        args.append(str(template_id))
    if status:
        where.append("status = ?")
        args.append(str(status))
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY created_at DESC, rowid DESC LIMIT ?"
    args.append(max(1, _as_int(limit, 50)))
    rows = store.con.execute(sql, tuple(args)).fetchall()
    return [_run_row(row) for row in rows]
