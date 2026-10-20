# -*- coding: utf-8 -*-
"""DAG 工作流执行器：节点处理器注册表、步骤记录、降级与可复现。

设计要点（与 docs/ARCHITECTURE.md §4.6 / §8 对齐）：
  * 模板来自 data/builtin/workflow_templates.json（18 条），seed 幂等写入
    workflow_template 表；run 落 workflow_run + workflow_step，可回放、可对比。
  * 节点按 kind 精确分派到 NODE_HANDLERS（未注册 kind → 该步 failed）；fallback 处理器以
    "fallback:" 前缀注册，只能经模板 fallbacks 引用。模板在 seed 时经 validate_template 校验。
  * 没有可用档位的网关 ≡ 无网关；节点只在对应角色可用时调模型。节点抛 ModelUnavailable →
    离线执行模板 fallbacks 指定的确定性实现（没声明就离线重跑自身），run 状态为 partial。
    其它异常 → 节点 failed、下游 skipped（on_failure 分支照跑）、run failed。
  * 每个节点只读「祖先链」的 artifacts（兄弟分支互相不可见，最近的祖先优先），保证分支可解释。
  * 同层节点用线程池并行；每个线程拿自己的 sqlite 连接（Store.con 是 thread-local）。
  * run_workflow 同步；start_workflow 异步（有界运行池，status=queued→running）。每一步经事件总线
    发 run 事件；取消是协作式的（cancel_run 记请求，执行器在节点边界收尾，终态写 CAS）。
  * 服务进程里：start_background = 启动回收（interrupted → failed）+ job 消费者线程。

不做什么：
  * 不自己实现 store / retrieval / judge / vectors —— 一律调用既有模块。
  * 不伪造成功：模型不可用必然体现在 step.degraded 与 run.degraded 上；persist 每个操作要么照参数
    做到，要么返回 skipped / failed 并说明原因。
"""
from __future__ import annotations

import json
import os
import re
import sqlite3
import threading
import time
import traceback
import uuid
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable, Iterator, Mapping

from . import chunking, db as dbmod, prompts, retrieval, vectors
from .db import dumps, loads, now

try:  # 进程内事件总线（SSE 的唯一来源）；缺失时运行照跑，只是不广播
    from . import events as _events
except ImportError:  # pragma: no cover
    _events = None  # type: ignore[assignment]

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
    # 1.1.0：异步运行 / 校验 / 后台（回收 + job 消费者）
    "start_workflow",
    "validate_template",
    "persist_op",
    "RunEmitter",
    "TERMINAL_STATUSES",
    "reap_interrupted",
    "start_background",
    "stop_background",
    "claim_job",
    "process_job",
    "retry_job",
    "job_worker_status",
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


def _role_usable(gw: Any, role: str) -> bool:
    """网关上该角色是否有可用档位（ModelGateway.profile(role) 不抛即可用）。

    没有 profile() 的 duck-typed 网关（测试替身）视为可用，由调用时的异常决定降级。
    """
    if gw is None:
        return False
    probe = getattr(gw, "profile", None)
    if not callable(probe):
        return True
    try:
        probe(role)
        return True
    except Exception:
        return False


def _effective_gateway(gw: Any) -> Any:
    """没有任何可用档位的网关 ≡ 无网关。

    1.0.0 经 HTTP/MCP 运行时拿到的是「0 个档位的真实 ModelGateway」，与测试里的 gw=None
    走的是两条路：有的节点调模型抛 ModelUnavailable 走 fallback，有的 fallback 自己又去调模型
    （review-quiz-generate 因此失败），没有 fallback 的节点直接返回空。现在执行器开跑前先折叠：
    两种情况行为与输出完全一致（tests/test_workflow_templates.py 逐模板比对）。
    """
    if gw is None:
        return None
    roles = getattr(gw, "roles", None)
    if not callable(roles):
        return gw
    try:
        table = roles() or {}
    except Exception:
        return None
    for role, profile in dict(table).items():
        if profile is not None and _role_usable(gw, str(role)):
            return gw
    return None


def _llm(ctx: "WorkflowContext", role: str) -> Any:
    """节点要调用模型时的唯一入口：该角色可用才返回网关，否则 None（走确定性实现）。"""
    if not ctx.use_llm or ctx.gw is None:
        return None
    return ctx.gw if _role_usable(ctx.gw, role) else None


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

    def nearest(self) -> list:
        """可见产物（dict），**最近的祖先在前**。

        执行器保证 ctx.artifacts 按「远 → 近」排列（见 _self_and_ancestors），
        所以这里倒序即可；1.0.0 按节点 id 字母序排列，text_for 会读到字母序最前的祖先。
        """
        return [art for art in reversed(list(self.artifacts.values())) if isinstance(art, dict)]

    def values(self) -> list:
        """所有可见产物里的 values 列表（最近的祖先在前）。"""
        out: list = []
        for art in self.nearest():
            values = art.get("values")
            if isinstance(values, list):
                out.extend(values)
        return out

    def first_list(self, *keys: str) -> list:
        """按 key 顺序在可见产物里找第一个非空列表（同 key 取最近的祖先）。"""
        for key in keys:
            for art in self.nearest():
                value = art.get(key)
                if isinstance(value, list) and value:
                    return list(value)
        return []

    def text_for(self, *keys: str) -> str:
        """按 key 顺序找第一段非空文本：先看运行输入，再看可见产物（最近的祖先优先）。"""
        for key in keys:
            if key in self.inputs and isinstance(self.inputs[key], str):
                if self.inputs[key].strip():
                    return str(self.inputs[key])
            for art in self.nearest():
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
        """运行是否已被请求取消（执行器把协作式取消令牌放在 ctx.cancel）。"""
        if self.cancel is None:
            return False
        try:
            return bool(self.cancel(self.run_id))
        except Exception:  # 取消探测失败不能让节点失败
            return False

    def check_cancel(self) -> None:
        """长循环里调用：已请求取消时抛 WorkflowRunCancelled，执行器把该步记为 cancelled。"""
        if self.cancelled():
            raise WorkflowRunCancelled("运行已被请求取消：%s" % self.run_id)


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
    """按名字**精确**查找处理器；缺失返回 None。

    1.0.0 找不到 <kind> 时会退到 fallback:<kind>，于是一个节点 kind 可以悄悄别名成某个
    降级实现（例如 kind="skip"）。现在 fallback 只能经模板 fallbacks 显式引用。
    """
    key = str(kind or "").strip()
    return NODE_HANDLERS.get(key) if key else None


def known_kind(kind: str) -> bool:
    """kind 是否是已注册的节点处理器（fallback:* 不算节点 kind）。"""
    key = str(kind or "").strip()
    return bool(key) and not key.startswith(FALLBACK_PREFIX) and key in NODE_HANDLERS


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
    item.update(trigger_status(item["trigger"]))
    problems = spec.get("problems")
    item["problems"] = list(problems) if isinstance(problems, list) else []
    return item


#: 真的会被触发的触发器类型。本版本**没有**定时调度器，也不在写入新记忆时自动触发模板：
#: schedule（cron）/ ingest 只是模板元数据（docs/workflows.md §9）。
ACTIVE_TRIGGER_KINDS: tuple[str, ...] = ("manual", "agent", "session-end")
TRIGGER_NOTES: dict[str, str] = {
    "manual": "手动运行：界面「运行」或 POST /api/workflows/{id}/run",
    "agent": "由智能体显式调用（MCP memory_workflow_run 或 REST），不会自动触发",
    "session-end": "智能体会话结束（memory_session_end）时自动运行",
    "schedule": "未激活：本版本没有定时调度器，cron 只是元数据；请手动运行",
    "ingest": "未激活：写入新记忆时不会自动运行；请手动运行或由智能体调用",
}


def trigger_status(trigger: Any) -> dict:
    """模板触发器是否真的会触发（列表/详情响应里的 trigger_active / trigger_note）。"""
    kind = str(_as_dict(trigger).get("kind") or "manual").strip() or "manual"
    note = TRIGGER_NOTES.get(kind) or (
        "未激活：没有任何组件会触发 %s 类型的触发器；请手动运行" % kind)
    return {"trigger_active": kind in ACTIVE_TRIGGER_KINDS, "trigger_note": note}


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
            problems = validate_template(spec)
            if problems:
                # 内置模板不该有问题（tests/test_workflow_templates.py 逐条断言）；万一有，
                # 照样写入但把问题挂在 spec.problems 上，列表/详情响应如实带出。
                spec["problems"] = problems
                store.audit("workflow.seed.invalid", tid, detail={"problems": problems[:20]})
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


#: persist 节点的操作；每个 persist 节点必须能解析成其中之一（validate_template 校验）
PERSIST_OPS: tuple[str, ...] = (
    "memory", "markdown", "report", "audit", "candidate", "recall_log", "job", "review_log",
    "archive", "purge", "supersede", "link", "merge", "document", "conflict", "graph",
)
PERSIST_COMMON_KEYS = frozenset({"op", "from"})
#: 每种操作会读取的参数；模板里出现其它参数 = 写了却没人读（1.0.0 的 rel / set_fields /
#: keep_* / require / mirror / audit 就是这样被静默忽略的）
PERSIST_PARAM_KEYS: dict[str, frozenset] = {
    "memory": frozenset({"status", "kind", "scope", "idempotent_by", "review_due_from"}),
    "markdown": frozenset({"target", "layout", "kind", "tags", "memory_id"}),
    "report": frozenset({"target", "report", "name"}),
    "audit": frozenset({"table", "target", "action"}),
    "candidate": frozenset({"table", "action", "status"}),
    "recall_log": frozenset({"table", "strategy"}),
    "job": frozenset({"table", "job", "delay_s", "max_attempts"}),
    "review_log": frozenset({"table", "rel", "algorithm"}),
    "archive": frozenset({"status", "note"}),
    "purge": frozenset({"require", "audit"}),
    "supersede": frozenset({"set_fields"}),
    "link": frozenset({"rel", "weight", "confidence"}),
    "merge": frozenset({"keep_sources", "keep_history"}),
    "document": frozenset({"mirror", "kind"}),
    "conflict": frozenset({"min_score", "name"}),
    "graph": frozenset(),
}
#: 边条件写法
WHEN_KINDS: tuple[str, ...] = ("always", "on_success", "on_degraded", "on_failure", "if")
_SAMPLE_INPUT = "示例"


def persist_op(params: Mapping[str, Any] | None) -> str | None:
    """persist 节点的操作名：显式 params.op 优先，否则按 1.0.0 模板用过的参数推导。

    无法解析（未知 table / target / status）返回 None —— 执行时该步 failed，
    seed 时 validate_template 报告；不再像 1.0.0 那样一律掉进「新增记忆」。
    """
    data = _as_dict(params)
    explicit = str(data.get("op") or "").strip().lower()
    if explicit:
        return explicit if explicit in PERSIST_OPS else None
    target = str(data.get("target") or "").strip().lower()
    table = str(data.get("table") or "").strip().lower()
    rel = str(data.get("rel") or "").strip()
    status = str(data.get("status") or "").strip().lower()
    if table == "audit" or target == "audit":
        return "audit"
    if target in ("markdown", "daily", "mirror") or data.get("layout") == "daily":
        return "markdown"
    if target in ("report", "reports") or data.get("report"):
        return "report"
    if table in ("recall_log", "candidate", "job", "review_log"):
        return table
    if rel == "review_log":
        return "review_log"
    if data.get("require"):
        return "purge"
    if status == "archived":
        return "archive"
    if data.get("set_fields"):
        return "supersede"
    if rel:
        return "link"
    if data.get("keep_sources") or data.get("keep_history"):
        return "merge"
    if data.get("mirror"):
        return "document"
    if table or target:
        return None
    if status and status not in ("draft", "candidate", "approved"):
        return None
    return "memory"


def _has_cycle(nodes: Mapping[str, Any], parents: Mapping[str, list[dict]]) -> bool:
    remaining = {nid: len(parents.get(nid) or []) for nid in nodes}
    children: dict[str, list[str]] = {nid: [] for nid in nodes}
    for dst, edges in parents.items():
        for edge in edges:
            children[edge["from"]].append(dst)
    ready = [nid for nid, deg in remaining.items() if deg == 0]
    done = 0
    while ready:
        current = ready.pop()
        done += 1
        for child in children.get(current, []):
            remaining[child] -= 1
            if remaining[child] == 0:
                ready.append(child)
    return done != len(nodes)


def validate_template(template: Mapping[str, Any]) -> list[str]:
    """静态校验一条模板；返回问题列表（空列表 = 通过）。

    seed 时对内置模板逐条执行（问题写进 spec.problems 并审计），单测对 18 条逐条断言。
    校验：节点 id 非空且唯一 / kind 已注册（fallback:* 不能当 kind）/ persist 操作可解析且
    参数都会被读取 / schedule 有目标模板或是 sm2 计划 / input 的 strategy 已知 /
    params.from 指向存在的节点 / 边两端存在、when 合法、无环 / fallbacks 的键是节点且名字已注册 /
    只给模板声明的输入就能通过 input 节点的必填校验。
    """
    problems: list[str] = []
    spec = _template_spec(template or {})
    raw_nodes = [n for n in _as_list(spec.get("nodes")) if isinstance(n, Mapping)]
    seen: set[str] = set()
    for node in raw_nodes:
        nid = str(node.get("id") or "").strip()
        if not nid:
            problems.append("存在没有 id 的节点")
            continue
        if nid in seen:
            problems.append("节点 id 重复：%s" % nid)
        seen.add(nid)
    nodes = _node_map(raw_nodes)
    if not nodes:
        return problems + ["模板没有节点"]
    for nid, node in nodes.items():
        kind = node["kind"]
        if not known_kind(kind):
            problems.append("节点 %s 的 kind 未注册：%s" % (nid, kind))
            continue
        params = node.get("params") or {}
        source = params.get("from")
        if source and str(source) not in nodes:
            problems.append("节点 %s 的 from 指向不存在的节点：%s" % (nid, source))
        if kind == "persist":
            op = persist_op(params)
            if op is None:
                problems.append("节点 %s 的 persist 操作无法解析：%s" % (nid, dumps(params)))
            else:
                unread = sorted(set(params) - PERSIST_PARAM_KEYS.get(op, frozenset())
                                - PERSIST_COMMON_KEYS)
                if unread:
                    problems.append("节点 %s（persist:%s）有不会被读取的参数：%s"
                                    % (nid, op, ", ".join(unread)))
        elif kind == "schedule":
            if not params.get("job") and str(params.get("algorithm") or "").lower() != "sm2":
                problems.append("节点 %s（schedule）既没有 job（目标模板 id）也不是 sm2 计划" % nid)
        elif kind == "input" and params.get("strategy"):
            if _strategy_kind(params.get("strategy")) is None:
                problems.append("节点 %s 的候选收集策略未实现：%s" % (nid, params.get("strategy")))
    for edge in _as_list(spec.get("edges")):
        if not isinstance(edge, Mapping):
            problems.append("边不是对象：%r" % (edge,))
            continue
        src = str(edge.get("from") or edge.get("source") or "").strip()
        dst = str(edge.get("to") or edge.get("target") or "").strip()
        if src not in nodes or dst not in nodes:
            problems.append("边 %s→%s 的端点不存在" % (src, dst))
        if _when_kind(edge.get("when")) == "unknown":
            problems.append("边 %s→%s 的 when 不合法：%s" % (src, dst, edge.get("when")))
    parents = _parent_map(spec.get("edges") or [], nodes)
    if _has_cycle(nodes, parents):
        problems.append("DAG 有环")
    for nid, name in (spec.get("fallbacks") or {}).items():
        if str(nid) not in nodes:
            problems.append("fallbacks 的键不是节点：%s" % nid)
        if (FALLBACK_PREFIX + str(name)) not in NODE_HANDLERS:
            problems.append("fallback 未注册：%s → %s" % (nid, name))
    sample = {str(key): _SAMPLE_INPUT for key in _as_dict(spec.get("inputs"))}
    for nid, node in nodes.items():
        if node["kind"] != "input":
            continue
        gate = _input_gate(node, spec, sample)
        if gate["missing"]:
            problems.append("只给声明的输入（%s）时 input 节点 %s 仍缺：%s"
                            % (", ".join(sorted(sample)) or "无", nid, ", ".join(gate["missing"])))
    return problems


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


def _ancestor_distances(node_id: str, parents: Mapping[str, list[dict]]) -> dict[str, int]:
    """严格祖先 → 最短跳数（沿入边 BFS，visited 去环）。"""
    dist: dict[str, int] = {}
    frontier = deque((edge["from"], 1) for edge in parents.get(node_id, []))
    while frontier:
        current, hops = frontier.popleft()
        if current in dist or current == node_id:
            continue
        dist[current] = hops
        for edge in parents.get(current, []):
            if edge["from"] not in dist:
                frontier.append((edge["from"], hops + 1))
    return dist


def _ancestors(node_id: str, parents: Mapping[str, list[dict]]) -> set[str]:
    """某节点的严格祖先集合。"""
    return set(_ancestor_distances(node_id, parents))


def _self_and_ancestors(node_id: str, parents: Mapping[str, list[dict]],
                        nodes: Mapping[str, Mapping[str, Any]] | None = None) -> list[str]:
    """可见集合，按「远 → 近」排列，自身在最后。

    近 = 跳数少；跳数相同按模板节点顺序（靠后者视为更近）。WorkflowContext.nearest()
    倒序读取，所以 text_for / first_list / _candidates 都是「最近的祖先优先」。
    """
    dist = _ancestor_distances(node_id, parents)
    table = nodes or {}

    def order(name: str) -> tuple:
        ordinal = _as_int((table.get(name) or {}).get("ordinal"), 0)
        return (-dist[name], ordinal, name)

    return sorted(dist, key=order) + [node_id]


def _lineage_artifacts(src: str, parents: Mapping[str, list[dict]],
                       artifacts: Mapping[str, Any],
                       nodes: Mapping[str, Mapping[str, Any]] | None = None) -> dict:
    """边 src→dst 的 if: 条件只看 src 自身与 src 的祖先（最近优先），看不到兄弟分支。"""
    chain = _self_and_ancestors(src, parents, nodes)
    names = [src] + list(reversed(chain[:-1]))
    return {name: artifacts[name] for name in names if name in artifacts}


#: run_workflow(mode=...) 可选值：fail（默认，失败即整体失败）/ skip（失败仅跳过下游）
RUN_MODES = ("fail", "skip")


def _when_kind(when: Any) -> str:
    """边条件归类：always / on_success / on_degraded / on_failure / if / unknown。"""
    token = str(when if when is not None else "always").strip().lower()
    if token in ("", "always", "true", "1"):
        return "always"
    if token in ("on_success", "success", "ok"):
        return "on_success"
    if token in ("on_degraded", "degraded", "on_degrade"):
        return "on_degraded"
    if token in ("on_failure", "failure", "failed"):
        return "on_failure"
    if token.startswith("if:") and token[3:].strip():
        return "if"
    return "unknown"


def _when_holds(when: str, status: str, degraded: bool, ctx_artifacts: Mapping[str, Any]) -> bool:
    """边条件：always / on_success / on_degraded / on_failure / if:<key>。

    if:<key> 读 ctx_artifacts（调用方传入「源节点 + 源节点的祖先」，最近优先）里的布尔字段，
    `node.key` 只认该节点。未知写法不成立（1.0.0 未知写法一律放行）。
    """
    kind = _when_kind(when)
    if kind == "always":
        return True
    if kind == "on_success":
        return status == "ok"
    if kind == "on_degraded":
        return bool(degraded)
    if kind == "on_failure":
        return status == "failed"
    if kind == "if":
        return _truthy_key(str(when).strip()[3:].strip(), ctx_artifacts)
    return False


def _truthy_key(key: str, ctx_artifacts: Mapping[str, Any]) -> bool:
    """读产物里的布尔字段：`node.key` 只认该节点；裸 key 取第一个（即最近的）含该键的产物。"""
    if not key:
        return False
    if "." in key:
        head, _, tail = key.partition(".")
        art = ctx_artifacts.get(head)
        if isinstance(art, Mapping):
            return bool(art.get(tail))
        return False
    for art in ctx_artifacts.values():
        if isinstance(art, Mapping) and key in art:
            return bool(art.get(key))
    return False



def _queue_seed(ctx: WorkflowContext, node: Mapping[str, Any]) -> list:
    """fan-out 的种子：优先父边 from 的产物，其次 inputs，最后空队列。"""
    params = _as_dict(node.get("params"))
    for key in ("from", "source", "over"):
        if key in params:
            return list(_as_list(ctx.artifacts.get(str(params[key]))))
    for value in ctx.nearest():
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
        "cancel_requested": bool(meta.get("cancel_requested")),
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


def _finalize_run(store, run_id: str, *, status: str, output: Any, error: str | None,
                  finished: str, degraded: Iterable[str] | None = None,
                  meta: Mapping[str, Any] | None = None,
                  expect: Iterable[str] = ("running",)) -> bool:
    """终态写（compare-and-set）：只有当前状态仍在 expect 里才写，返回是否写成。

    读 metadata、合并、写回都在同一个 BEGIN IMMEDIATE 事务里，不会吞掉并发写进来的
    cancel_requested；运行已被别人收尾（回收 / 孤儿取消）时返回 False，绝不覆盖。
    """
    allowed = tuple(expect)
    marks = ",".join("?" * len(allowed))
    with store._txn() as con:
        row = con.execute("SELECT status, metadata FROM workflow_run WHERE id = ?",
                          (run_id,)).fetchone()
        if row is None or str(row["status"]) not in allowed:
            return False
        current = loads(row["metadata"], {}) or {}
        current = current if isinstance(current, dict) else {}
        if degraded is not None:
            current["degraded"] = list(dict.fromkeys(str(x) for x in degraded))
        for key, value in dict(meta or {}).items():
            current[key] = value
        cur = con.execute(
            "UPDATE workflow_run SET status = ?, output = ?, error = ?, finished_at = ?, "
            "metadata = ? WHERE id = ? AND status IN (%s)" % marks,
            tuple([status, dumps(_clip_json(output if output is not None else {},
                                            OUTPUT_LIMIT * 4)),
                   error, finished, dumps(current), run_id] + list(allowed)))
        return cur.rowcount == 1


def _read_cancel_flag(con, run_id: str) -> tuple[bool, str]:
    """读 workflow_run.metadata.cancel_requested（跨进程/线程可见的取消请求）。"""
    try:
        row = con.execute("SELECT metadata FROM workflow_run WHERE id = ?", (run_id,)).fetchone()
    except sqlite3.Error:  # pragma: no cover
        return False, ""
    if row is None:
        return False, ""
    meta = loads(row["metadata"], {}) or {}
    if isinstance(meta, dict) and meta.get("cancel_requested"):
        return True, str(meta.get("cancel_reason") or "api")
    return False, ""


def _cancel_requested(store, run_id: str) -> bool:
    """兼容 1.0.0 的辅助函数：该运行是否已被请求取消。"""
    return _read_cancel_flag(store.con, run_id)[0]


#: 事件总线允许的类型（运行进度一律用已有的 run 类型，不新增类型）
_EVENT_TYPES: tuple[str, ...] = tuple(getattr(_events, "EVENT_TYPES", None)
                                      or ("run", "memory", "agent", "log", "heartbeat", "system"))


class RunEmitter:
    """运行事件出口：发布到进程内事件总线（events.publish → SSE），可选再转发给调用方的 emitter。

    1.0.0 的默认实例没有任何投递目标，emit 节点却报告 delivered=true / via=sse；
    data=None 时还会抛 AttributeError（被吞掉）。现在 send() 如实返回：
      published   事件进了总线（历史环 + 当时在线的订阅者）
      subscribers 发布时在线的 SSE 订阅者数
      forwarded   调用方给的 emitter（callable / .emit / .put）收到了
    事件类型只用总线已有的类型；未知类型按 log 发布并把原名放进 data.event。
    """

    def __init__(self, store: Any = None, emitter: Any = None, run_id: str = "") -> None:
        self.store = store
        self.emitter = emitter
        self.run_id = run_id
        self.count = 0
        self._lock = threading.Lock()

    def send(self, event_type: Any, data: Mapping[str, Any] | None = None) -> dict:
        if isinstance(event_type, Mapping):
            etype = str(event_type.get("type") or "run")
            payload = dict(event_type.get("data") or {})
        else:
            etype = str(event_type or "run")
            payload = dict(data or {})
        if etype not in _EVENT_TYPES:
            payload.setdefault("event", etype)
            etype = "log"
        if self.run_id:
            payload.setdefault("run_id", self.run_id)
        published = None
        subscribers = 0
        if _events is not None:
            try:
                subscribers = int(_events.subscriber_count())
            except Exception:  # pragma: no cover
                subscribers = 0
            published = _events.publish(etype, payload)
        forwarded = False
        target = self.emitter
        if target is not None and not isinstance(target, RunEmitter):
            message = {"type": etype, "data": payload}
            try:
                if callable(target):
                    target(message)
                elif hasattr(target, "emit"):
                    target.emit(message)
                elif hasattr(target, "put"):
                    target.put(message)
                else:
                    raise TypeError("emitter 不可调用")
                forwarded = True
            except Exception:  # 转发失败绝不影响运行
                forwarded = False
        if published is not None:
            with self._lock:
                self.count += 1
        return {"type": etype, "published": published is not None,
                "id": (published or {}).get("id"),
                "subscribers": subscribers if published is not None else 0,
                "forwarded": forwarded}

    def emit(self, event_type: Any, data: Mapping[str, Any] | None = None) -> bool:
        """兼容 1.0.0 的签名：返回是否真的投递出去了（进了总线或转发成功）。"""
        report = self.send(event_type, data)
        return bool(report["published"] or report["forwarded"])


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
    """把模板 inputs 的中文说明映射成语义槽位；说明里写了「可选」的输入不进必填槽位。"""
    text = str(description or "")
    if "可选" in text:
        return "optional"
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


def _declared_slots(template: Mapping[str, Any]) -> dict[str, list[str]]:
    """模板 inputs 声明 → {语义槽位: [声明的键…]}（中文说明映射成槽位，映射不到就用键名）。"""
    out: dict[str, list[str]] = {}
    for key, description in _as_dict(template.get("inputs")).items():
        slot = _slot_of(description) or str(key)
        out.setdefault(slot, []).append(str(key))
    return out


def _input_requirements(node: Mapping[str, Any], template: Mapping[str, Any],
                        nodes: dict[str, dict], parents: dict[str, list[dict]]) -> list[str]:
    """input 节点真正需要的输入槽位（只有 REQUIRED_SLOTS 里的槽位算必填）。

      * 节点 params.required=[...] 显式声明 → 以声明为准（严格模式）；
      * 该节点有上游节点 → 上游负责，不重复要求；
      * 模板**没有声明任何输入** → 至少要一段正文（content）；
      * 声明了输入但全是可选槽位（作用域 / 时间窗 / 预算 / 智能体…）→ 不要求任何输入。
        1.0.0 这里退回要求 content，于是 forget-decay 等 6 条模板只给声明的输入也跑不起来。
    """
    params = _as_dict(node.get("params"))
    declared = params.get("required")
    if isinstance(declared, (list, tuple)):
        return [str(x) for x in declared]
    if any(edge["from"] in nodes for edge in parents.get(str(node.get("id")), [])):
        return []
    slots = _declared_slots(template)
    if not slots:
        return list(REQUIRED_ALWAYS)
    return [slot for slot in slots if slot in REQUIRED_SLOTS]


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


def _satisfied(norm: Mapping[str, Any], slot: str, *, strict: bool = False,
               declared: Iterable[str] = ()) -> bool:
    """某个槽位是否已被满足。

    declared：模板为该槽位声明的键（例如 detail-abstraction 用 items 声明「记忆」槽位），
    给了声明的键就算满足。strict=True（显式 required 声明）时只看该槽位自己的键，
    不做文本别名回退，这样 required=["content","query"] 才能真的要求两个都有。
    """
    for key in tuple(declared) + SLOT_KEYWORDS.get(slot, (slot,)) + (slot,):
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


def _input_gate(node: Mapping[str, Any], template: Mapping[str, Any],
                norm: Mapping[str, Any]) -> dict:
    """必填校验（node_input 与 validate_template 共用）。

    返回 {required, strict, missing, backfilled, norm}；norm 是回填后的输入副本。
    """
    nodes = _node_map(_as_list(template.get("nodes")))
    parents = _parent_map(_as_list(template.get("edges")), nodes)
    required = _input_requirements(node, template, nodes, parents)
    declared = _declared_slots(template)
    strict = _strict_required(node)
    work = dict(norm)
    backfilled: list[str] = []
    donor = _primary_text(work)

    def satisfied(slot: str, strict_mode: bool = False) -> bool:
        return _satisfied(work, slot, strict=strict_mode, declared=declared.get(slot, ()))

    # 宽容语义（2026-10-19 决策）：模板声明的多个槽位里，只要有一个"主槽位"被满足，
    # 其余槽位就用同一段文本回填，而不是硬性拒绝；显式 required=[...] 时逐项严格校验。
    if strict:
        missing = [slot for slot in required if not satisfied(slot, True)]
    elif not required:
        missing = []
    elif not donor and not any(satisfied(slot) for slot in required):
        missing = list(required)  # 一个可用输入都没有：唯一的硬失败条件
    else:
        for slot in required:
            if satisfied(slot):
                continue
            if donor:
                work[slot] = donor
                backfilled.append(slot)
        missing = [slot for slot in required if not satisfied(slot)]
    return {"required": required, "strict": strict, "missing": missing,
            "backfilled": backfilled, "norm": work}


# ============================================================
# 9. 节点实现 · A 组（input / transform / extract / classify / retrieve）
# ============================================================
READ_MAX_FILES = 20            # input 节点读目录时最多读几个文件
READ_MAX_CHARS = 200_000       # input 节点读文件的正文上限
ITEMS_LIMIT = 200              # items / 策略收集的条目上限
TRANSCRIPT_LIMIT = 40_000      # 会话转写文本上限
BACKSLASH = chr(92)


def node_input(ctx: WorkflowContext, node: dict) -> dict:
    """校验并规整输入；缺失必填项抛 WorkflowInputError。

    校验之外，input 节点按 params 把「模板声明的输入」变成下游真正能用的材料（只读，不写库）：
      * memory / candidate 是记忆 id     → 解析成该记忆（标题 + 正文）
      * turns / session                  → 会话转写文本（session-distill）
      * params.formats + inputs.path     → 读取文件 / 目录正文（doc-knowledgeize）
      * inputs.items                     → 记忆 id / 文本列表解析成条目（detail-abstraction）
      * params.strategy                  → 按策略从库里收集候选记忆（forget-decay / conflict-source-audit）
      * params.by 含 updated_at          → since 之后变更过的记忆（incremental-index）
      * params.collect=workspace-sessions → 该工作区（cwd）时间窗内的会话转写（project-retro）
    1.0.0 没有正文时会把整个 inputs 的 JSON 当正文往下传；现在没有就是没有（reason 说明）。
    """
    norm = _normalize_inputs(ctx.inputs)
    template = _as_dict(ctx.step_meta.get("template"))
    gate = _input_gate(node, template, norm)
    if gate["missing"]:
        raise WorkflowInputError(
            "模板 %s 缺少必填输入：%s（已给：%s）"
            % (ctx.template_id, ", ".join(gate["missing"]), ", ".join(sorted(norm)) or "无")
        )
    coerced = {key: _coerce_value(key, value) for key, value in gate["norm"].items()}
    params = ctx.params
    extra: dict[str, Any] = {}
    items: list[dict] = []

    for key in ("memory", "candidate"):
        resolved = _resolve_memory_ref(ctx, coerced.get(key))
        if resolved is not None:
            coerced[key] = resolved
            extra.setdefault("resolved", []).append(key)
    if not _primary_text(coerced):
        transcript = _transcript_of(coerced)
        if transcript:
            coerced["content"] = transcript
            extra["transcript_chars"] = len(transcript)
    if params.get("formats") and not _primary_text(coerced) and _present(coerced.get("path")):
        loaded = _read_path_input(str(coerced.get("path")), params)
        coerced["content"] = loaded.pop("text")
        extra["loaded"] = loaded
    if isinstance(coerced.get("items"), list) and coerced.get("items"):
        items = _resolve_items(ctx, coerced["items"])
    if params.get("strategy"):
        collected = _collect_by_strategy(ctx, params, coerced)
        items = items or collected.pop("items")
        collected.pop("items", None)
        extra["collected"] = collected
    if "updated_at" in [str(x) for x in _as_list(params.get("by"))]:
        changed = _changed_since(ctx, coerced)
        items = items or changed.pop("items")
        changed.pop("items", None)
        extra["changed"] = changed
    collect = str(params.get("collect") or "")
    if collect in ("workspace-sessions", "recent-sessions") and not _primary_text(coerced):
        gathered = _workspace_sessions(ctx, coerced, any_workspace=collect == "recent-sessions")
        if gathered.get("text"):
            coerced["content"] = gathered.pop("text")
        gathered.pop("text", None)
        extra["gathered"] = gathered

    text = _primary_text(coerced)
    if not text and items:
        text = "\n\n".join(body for body in (_text_of(item) for item in items) if body.strip())
    if text:
        coerced.setdefault("content", text)
    ctx.note({"chars": len(text), "slots": len(gate["required"]), "items": len(items)})
    out = {
        "status": "ok",
        "inputs": coerced,
        "required": gate["required"],
        "strict": gate["strict"],
        "backfilled": gate["backfilled"],
        "provided": sorted(k for k, v in coerced.items() if _present(v)),
        "text": _clip_text(text, TEXT_LIMIT),
        "chars": len(text),
        "scope": ctx.scope,
    }
    if items:
        out["items"] = items
        out["count"] = len(items)
    out.update(extra)
    if not text and not items:
        out["reason"] = "输入里没有可处理的正文或条目"
    return out


def _memory_brief(row: Any) -> dict:
    """记忆行 → 下游节点用的精简 dict。"""
    item = dict(row)
    return {
        "id": item.get("id"), "title": item.get("title") or "",
        "body": _clip_text(item.get("body") or "", TEXT_LIMIT),
        "kind": item.get("kind"), "status": item.get("status"), "scope_id": item.get("scope_id"),
        "importance": _as_float(item.get("importance"), 0.5),
        "trust": _as_float(item.get("trust"), 0.5),
        "sensitivity": item.get("sensitivity"), "recorded_at": item.get("recorded_at"),
        "updated_at": item.get("updated_at"), "last_reviewed": item.get("last_reviewed"),
        "valid_from": item.get("valid_from"),
    }


def _resolve_memory_ref(ctx: WorkflowContext, value: Any) -> dict | None:
    """记忆引用（id 字符串 / 只有 id 的 dict）→ 记忆摘要；不是已入库记忆返回 None（保持原值）。"""
    mid = ""
    if isinstance(value, str):
        text = value.strip()
        if text and len(text) <= 80 and not any(ch.isspace() for ch in text):
            mid = text
    elif isinstance(value, Mapping) and value.get("id") and not _text_of(
            {k: v for k, v in value.items() if k != "title"}).strip():
        mid = str(value.get("id"))
    if not mid:
        return None
    try:
        memory = ctx.store.get_memory(mid)
    except Exception:
        memory = None
    return _memory_brief(memory) if memory else None


def _resolve_items(ctx: WorkflowContext, raw_items: list) -> list[dict]:
    """items 输入：记忆 id 解析成记忆，文本 / dict 原样成条目。"""
    out: list[dict] = []
    for value in raw_items[:ITEMS_LIMIT]:
        memory = _resolve_memory_ref(ctx, value)
        if memory is not None:
            out.append(memory)
            continue
        if isinstance(value, Mapping):
            row = dict(value)
            body = _text_of(row)
            if body.strip():
                row.setdefault("title", _rule_title(body))
                out.append(row)
        elif isinstance(value, str) and value.strip():
            out.append({"title": _rule_title(value), "body": value})
    return out


def _transcript_of(norm: Mapping[str, Any]) -> str:
    """turns（[{role, content|text}] 或字符串列表）/ session → 可读转写文本。"""
    turns = norm.get("turns")
    session = norm.get("session")
    if not isinstance(turns, list):
        if isinstance(session, Mapping):
            turns = session.get("turns")
            if not isinstance(turns, list):
                return _text_of(session)
        elif isinstance(session, str):
            return session.strip()[:TRANSCRIPT_LIMIT]
    if not isinstance(turns, list):
        return ""
    lines: list[str] = []
    for turn in turns:
        if isinstance(turn, Mapping):
            role = str(turn.get("role") or turn.get("speaker") or turn.get("author") or "").strip()
            body = turn.get("content")
            if body is None:
                body = turn.get("text")
            if body is not None and not isinstance(body, str):
                body = json.dumps(body, ensure_ascii=False, default=str)
            body = str(body or "").strip()
            if body:
                lines.append("%s: %s" % (role, body) if role else body)
        elif isinstance(turn, str) and turn.strip():
            lines.append(turn.strip())
    return "\n".join(lines)[:TRANSCRIPT_LIMIT]


def _read_path_input(raw_path: str, params: Mapping[str, Any]) -> dict:
    """读取 inputs.path 指向的文件或目录（只读）；与 POST /api/documents/import 的 path 导入同一信任级别。"""
    from pathlib import Path

    from . import ingest as ingest_mod

    target = Path(raw_path).expanduser()
    if not target.exists():
        raise WorkflowInputError("路径不存在：%s" % raw_path)
    allowed = {"." + str(f).lower().lstrip(".") for f in _as_list(params.get("formats"))}
    files: list = []
    if target.is_file():
        files = [target]
    else:
        for item in sorted(target.rglob("*")):
            if not item.is_file():
                continue
            if allowed and item.suffix.lower() not in allowed:
                continue
            if not ingest_mod.supported(item):
                continue
            files.append(item)
            if len(files) >= READ_MAX_FILES:
                break
    if not files:
        raise WorkflowInputError("目录里没有可读取的文档（%s）：%s"
                                 % ("/".join(sorted(allowed)) or "任意格式", raw_path))
    parts: list[str] = []
    errors: list[dict] = []
    used = 0
    title = ""
    for item in files:
        try:
            parsed = ingest_mod.parse_document(item)
        except Exception as exc:
            errors.append({"path": str(item), "error": "%s: %s" % (type(exc).__name__,
                                                                  str(exc)[:160])})
            continue
        text = str(parsed.get("text") or "")
        if not text.strip():
            continue
        title = title or str(parsed.get("title") or item.stem)
        room = READ_MAX_CHARS - used
        text = text[:max(0, room)]
        parts.append(text if len(files) == 1 else "# %s\n\n%s" % (parsed.get("title") or item.stem,
                                                                  text))
        used += len(text)
        if used >= READ_MAX_CHARS:
            break
    if not parts:
        raise WorkflowInputError("文档解析结果为空：%s（%s）" % (raw_path, errors[:3]))
    return {"text": "\n\n".join(parts), "source": str(target), "title": title,
            "files": [str(f) for f in files], "chars": used, "errors": errors,
            "truncated": used >= READ_MAX_CHARS}


def _strategy_kind(strategy: Any) -> str | None:
    """input 节点的候选收集策略：unused（久未使用 + 低重要度）/ recent（作用域内最近的已审核记忆）。"""
    text = str(strategy or "").lower()
    if "unused" in text or "low-importance" in text:
        return "unused"
    if "entity-overlap" in text or "vector-near" in text or "recent" in text:
        return "recent"
    return None


def _iso_days_ago(days: float) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - float(days) * 86400.0))


def _window_days(value: Any) -> float:
    """时间窗："7d" / "2w" / "12h" / 7 → 天数；无法解析返回 0（不限）。"""
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return max(0.0, float(value))
    match = re.match(r"^\s*(\d+(?:\.\d+)?)\s*([dwh]?)", str(value or "").lower())
    if not match:
        return 0.0
    amount = float(match.group(1))
    unit = match.group(2) or "d"
    return amount * {"d": 1.0, "w": 7.0, "h": 1.0 / 24.0}[unit]


def _scope_filter(store: Any, scope: str) -> tuple[str, list]:
    """作用域过滤子句（含子作用域；SQL 里记忆表别名为 m）。"""
    clause = getattr(store, "_scope_clause", None)
    if callable(clause):
        try:
            sql, args = clause(scope)
            return str(sql), list(args)
        except Exception:
            pass
    return " AND m.scope_id = ?", [scope]


def _collect_by_strategy(ctx: WorkflowContext, params: Mapping[str, Any],
                         norm: Mapping[str, Any]) -> dict:
    """按 params.strategy 从库里收集候选记忆（只读）。未知策略 → WorkflowError（该步 failed）。"""
    strategy = str(params.get("strategy") or "")
    kind = _strategy_kind(strategy)
    if kind is None:
        raise WorkflowError("未实现的候选收集策略：%s" % strategy)
    scope = str(norm.get("scope") or ctx.scope or "global")
    limit = max(1, min(ITEMS_LIMIT, _as_int(params.get("limit") or norm.get("limit"), ITEMS_LIMIT)))
    clause, args = _scope_filter(ctx.store, scope)
    con = ctx.store.con
    if kind == "unused":
        days = max(1, _as_int(norm.get("unused_days") or params.get("unused_days"), 90))
        ceiling = _clamp(norm.get("max_importance", params.get("max_importance", 0.3)), 0.0, 1.0)
        cutoff = _iso_days_ago(days)
        rows = con.execute(
            "SELECT m.* FROM memory m WHERE m.status = 'approved' AND m.pinned = 0 "
            "AND m.importance <= ? AND coalesce(m.last_reviewed, m.updated_at, m.recorded_at) < ?"
            + clause + " ORDER BY m.importance ASC, m.updated_at ASC LIMIT ?",
            tuple([ceiling, cutoff] + args + [limit])).fetchall()
        applied = ("已审核、未置顶、importance <= %.2f、%d 天未使用（最后复习/更新早于 %s）"
                   % (ceiling, days, cutoff))
    else:
        since = str(norm.get("since") or "").strip()
        sql = "SELECT m.* FROM memory m WHERE m.status = 'approved'" + clause
        values: list = list(args)
        if since:
            sql += " AND m.updated_at >= ?"
            values.append(since)
        sql += " ORDER BY m.updated_at DESC LIMIT ?"
        values.append(limit)
        rows = con.execute(sql, tuple(values)).fetchall()
        applied = ("作用域内最近的已审核记忆%s；两两冲突由下游 conflict-score 打分"
                   "（实体重叠 / 向量近邻预筛未实现）" % ("（自 %s 起）" % since if since else ""))
    items = [_memory_brief(row) for row in rows]
    return {"items": items, "strategy": strategy, "applied": applied, "scope": scope,
            "collected": len(items)}


def _changed_since(ctx: WorkflowContext, norm: Mapping[str, Any]) -> dict:
    """since（上次水位）之后更新过的记忆；没给 since 视为首次全量（同样受条目上限约束）。"""
    since = str(norm.get("since") or "").strip()
    sql = "SELECT m.* FROM memory m WHERE m.status != 'archived'"
    values: list = []
    if since:
        sql += " AND m.updated_at >= ?"
        values.append(since)
    sql += " ORDER BY m.updated_at ASC LIMIT ?"
    values.append(ITEMS_LIMIT)
    rows = ctx.store.con.execute(sql, tuple(values)).fetchall()
    items = [_memory_brief(row) for row in rows]
    watermark = max((str(i.get("updated_at") or "") for i in items), default=since)
    return {"items": items, "since": since or None, "changed": len(items),
            "watermark": watermark or None, "capped": len(items) >= ITEMS_LIMIT}


def _norm_path(value: Any) -> str:
    return str(value or "").strip().replace(BACKSLASH, "/").rstrip("/").lower()


def _workspace_sessions(ctx: WorkflowContext, norm: Mapping[str, Any], *,
                        any_workspace: bool = False) -> dict:
    """时间窗内的会话转写：project-retro 只要该工作区（会话 cwd）的；
    preference-learning（any_workspace=True）要全部会话的。"""
    workspace = str(norm.get("workspace") or "").strip()
    if not workspace and not any_workspace:
        return {"text": "", "sessions": 0, "reason": "没有给 workspace"}
    want = _norm_path(workspace)
    days = _window_days(norm.get("window"))
    cutoff = _iso_days_ago(days) if days else ""
    rows = ctx.store.con.execute(
        "SELECT id, title, cwd, spec, started_at, ended_at FROM agent_session "
        "ORDER BY coalesce(ended_at, started_at) DESC LIMIT 500").fetchall()
    parts: list[str] = []
    used = 0
    for row in rows:
        if not any_workspace and _norm_path(row["cwd"]) != want:
            continue
        stamp = str(row["ended_at"] or row["started_at"] or "")
        if cutoff and stamp and stamp < cutoff:
            continue
        spec = loads(row["spec"], {}) or {}
        text = _transcript_of({"turns": spec.get("turns") if isinstance(spec, dict) else None})
        if not text.strip():
            continue
        parts.append("## %s\n\n%s" % (row["title"] or row["id"], text))
        used += len(text)
        if used >= TRANSCRIPT_LIMIT:
            break
    return {"text": "\n\n".join(parts)[:TRANSCRIPT_LIMIT], "sessions": len(parts),
            "workspace": workspace or None, "window_days": days or None,
            "reason": "" if parts else "没有找到时间窗内%s带转写的会话"
                      % ("" if any_workspace else "该工作区（cwd）")}


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
                     "one-proposition") or params.get("one_proposition"):
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


#: 实体抽取模式（extract 节点 params.kinds 含这些类型或 alias_merge=true）
ENTITY_KINDS = ("concept", "person", "project", "tool", "term", "entity", "organization", "place")
CORPUS_LIMIT = 20_000


def node_extract(ctx: WorkflowContext, node: dict) -> dict:
    """抽取：候选记忆（LLM → 规则）或实体（规则：大写词 + 中文名词短语）。

    params.scope_memories=true 且上游没有正文时，读作用域内已审核记忆作为语料
    （knowledge-graph-build 没有 input 节点，1.0.0 在这里永远是空）。
    """
    params = ctx.params
    text = ctx.text_for("text", "content", "body")
    source = "upstream"
    if not text.strip() and params.get("scope_memories"):
        text = _scope_corpus(ctx)
        source = "scope-memories"
    if not text.strip():
        return {"status": "ok", "mode": "empty", "items": [], "count": 0,
                "reason": "上游没有可抽取的文本", "source": source}

    entity_mode = bool(params.get("alias_merge")) or any(
        str(k) in ENTITY_KINDS for k in _as_list(params.get("kinds")))
    if entity_mode:
        items = _rule_entities(text, params)
        ctx.mark_degraded("extract", "实体抽取没有模型实现：按大写词 / 中文名词短语规则抽取")
        out = {"status": "ok", "mode": "rule-entities", "items": items, "count": len(items),
               "degraded": True, "source": source}
        if source == "scope-memories":
            out["text"] = text  # 下游 graph 节点按共现窗口建边要看到语料
        return out
    quote_required = bool(params.get("quote_required"))
    gw = _llm(ctx, "extractor")
    if gw is not None:
        items = _llm_extract(ctx, text, params)
        if items:
            ctx.note({"llm_items": len(items)})
            return {"status": "ok", "mode": "llm", "items": items, "count": len(items),
                    "quote_required": quote_required, "model": _active_label(gw, "extractor"),
                    "source": source}
    items = _rule_extract(text, params)
    ctx.mark_degraded("extract", "未配置可用的抽取模型，使用规则抽取")
    return {"status": "ok", "mode": "rule", "items": items, "count": len(items),
            "quote_required": quote_required, "degraded": True, "source": source,
            "intents": _intent_words(text), "keywords": _keywords_of(text)[:8]}


def _rule_entities(text: str, params: Mapping[str, Any]) -> list[dict]:
    """实体：英文大写开头的词 + 中文 2-8 字名词短语（去停用词），保持出现顺序。"""
    names: list[str] = []
    for match in re.finditer(r"\b[A-Z][A-Za-z0-9_\-]{1,30}\b", text or ""):
        if match.group(0) not in names:
            names.append(match.group(0))
    for token in _keywords_of(text, 20):
        if token not in names:
            names.append(token)
    kinds = [str(k) for k in _as_list(params.get("kinds"))] or ["concept"]
    return [{"title": name, "body": name, "kind": kinds[0], "source": "rule"}
            for name in names[:30]]


def _scope_corpus(ctx: WorkflowContext) -> str:
    """作用域内已审核记忆的标题 + 正文（按更新时间倒序，字数上限 CORPUS_LIMIT）。"""
    clause, args = _scope_filter(ctx.store, ctx.scope or "global")
    rows = ctx.store.con.execute(
        "SELECT m.title, m.body FROM memory m WHERE m.status = 'approved'" + clause
        + " ORDER BY m.updated_at DESC LIMIT ?", tuple(args + [ITEMS_LIMIT])).fetchall()
    parts: list[str] = []
    used = 0
    for row in rows:
        piece = "%s\n%s" % (row["title"] or "", row["body"] or "")
        parts.append(piece)
        used += len(piece)
        if used >= CORPUS_LIMIT:
            break
    return "\n\n".join(parts)[:CORPUS_LIMIT]


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
        ctx.check_cancel()
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
    query = str(params.get("query")
                or ctx.text_for("query", "topic", "text", "content") or "").strip()
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
    if not query and params.get("strategy"):
        return _browse_scope(ctx, params, scope, top_k)
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


def _browse_scope(ctx: WorkflowContext, params: Mapping[str, Any], scope: str,
                  top_k: int) -> dict:
    """没有查询语句时的「按策略挑选」：按重要度列出作用域内的已审核记忆（不是检索，不打相关分）。"""
    clause, args = _scope_filter(ctx.store, scope)
    rows = ctx.store.con.execute(
        "SELECT m.* FROM memory m WHERE m.status = 'approved'" + clause
        + " ORDER BY m.importance DESC, m.updated_at DESC LIMIT ?",
        tuple(args + [max(1, top_k)])).fetchall()
    hits = []
    for row in rows:
        brief = _memory_brief(row)
        hits.append({"id": brief["id"], "title": brief["title"], "kind": brief["kind"],
                     "snippet": _clip_text(brief["body"], 240), "body": brief["body"],
                     "score": brief["importance"], "trust": brief["trust"]})
    ctx.note({"hits": len(hits), "strategy": "browse"})
    return {"status": "ok", "engine": "browse", "strategy": "browse", "hits": hits,
            "count": len(hits), "total": len(hits), "query": "", "scope": scope,
            "requested_strategy": params.get("strategy"),
            "reason": "没有查询语句：按重要度列出作用域内的已审核记忆（未做相关性检索）"}


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
        # 判重要看见 secret 记忆（否则会把敏感记忆再写一遍）；它们的正文不进运行记录
        res = retrieval.search(ctx.store, ctx.gw, probe[:500], scope=scope,
                               limit=max(top_k * 3, 20), strategy="hybrid", include_secret=True)
    else:
        res = {"hits": [], "degraded": [], "total": 0}
    secret_ids = _secret_ids(ctx.store, [h.get("id") for h in _as_list(res.get("hits"))
                                         if isinstance(h, Mapping)])
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
        secret = hit.get("id") in secret_ids
        hits.append({
            "id": hit.get("id"), "title": hit.get("title") or "", "kind": hit.get("kind"),
            "snippet": "（secret：正文不写入运行记录）" if secret else
            _clip_text(hit.get("snippet") or "", 240), "score": round(best, 4),
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


def _secret_ids(store: Any, ids: list) -> set:
    """这些记忆里 sensitivity='secret' 的 id（它们的正文不写进 workflow_step）。"""
    wanted = [str(i) for i in ids if i]
    if not wanted:
        return set()
    try:
        rows = store.con.execute(
            "SELECT id FROM memory WHERE sensitivity = 'secret' AND id IN (%s)"
            % ",".join("?" * len(wanted)), tuple(wanted)).fetchall()
    except sqlite3.Error:  # pragma: no cover
        return set()
    return {str(row["id"]) for row in rows}


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
    """向量化并写 vector 表：embedding 角色可用走 gw.embed，否则本地 hash 向量（step 标 degraded）。"""
    params = ctx.params
    return _embed_items(ctx, _embed_targets(ctx),
                        owner_kind=str(params.get("owner_kind") or "memory"),
                        incremental=bool(params.get("incremental")))


def _embed_items(ctx: WorkflowContext, items: list, *, owner_kind: str = "memory",
                 incremental: bool = False) -> dict:
    """embed / index(增量) 共用。只给有 id 的对象写向量（1.0.0 会给纯文本造 text:<hash>
    的假主人，写进 vector 表后又被孤儿清理删掉）。本地 hash 向量 = 降级，step 如实标 degraded。"""
    rows = [(item, _text_of(item)[:2000]) for item in items]
    rows = [(item, text) for item, text in rows if text.strip()]
    owned = [(item, text) for item, text in rows if _real_owner(item)]
    if not owned:
        reason = "没有可向量化的对象" if not rows else "上游条目没有记忆/块 id，向量未落库"
        return {"status": "ok", "mode": "empty", "count": 0, "written": 0,
                "model": vectors.MODEL_LOCAL, "owner_kind": owner_kind, "reason": reason,
                "unowned": len(rows) - len(owned)}
    mode = "hash"
    model = vectors.MODEL_LOCAL
    reason = ""
    vecs: list[list[float]] = []
    gw = _llm(ctx, "embedding")
    if gw is not None:
        try:
            vecs = [list(map(float, v)) for v in (gw.embed([t for _, t in owned]) or [])]
            if len(vecs) != len(owned):
                raise ValueError("向量条数不符：%d != %d" % (len(vecs), len(owned)))
            mode = "cloud"
            # 与检索同一口径：云端向量按 provider/model@dim 存（vectors.cloud_model_key），
            # 否则检索永远读不到工作流写进去的向量
            label = _active_label(gw, "embedding") or "cloud-embed"
            model = vectors.cloud_model_key(label, len(vecs[0])) if vecs else label
            ctx.note({"model": model})
        except Exception as exc:
            if _unavailable(exc):
                raise ModelUnavailable("embedding", str(exc)) from exc
            reason = "云端向量失败：%s" % type(exc).__name__
            vecs = []
    if not vecs:
        vecs = [_l2(vectors.hash_embed(text)) for _, text in owned]
        reason = reason or "未配置 embedding，使用本地 char n-gram hash（256 维）"
        ctx.mark_degraded("vector", reason)
    pairs = []
    dims = 0
    existing = 0
    for (item, _text), vec in zip(owned, vecs):
        ctx.check_cancel()
        owner_id = _owner_id(item)
        dims = len(vec)
        if incremental and _has_vector(ctx.store, owner_kind, owner_id, model):
            existing += 1
            continue
        pairs.append((owner_id, vec))
    written = 0
    if pairs:
        try:
            with vectors.VectorIndex(ctx.store, model=model) as index:
                written = index.put_many(owner_kind, pairs, model=model)
        except Exception as exc:
            reason = "向量落库失败：%s" % type(exc).__name__
            ctx.mark_degraded("vector", reason)
            written = 0
    ctx.note({"vectors": written, "dim": dims})
    out = {"status": "ok", "mode": mode, "model": model, "count": len(pairs), "written": written,
           "dim": dims, "owner_kind": owner_kind, "incremental": incremental,
           "existing": existing, "unowned": len(rows) - len(owned)}
    if mode == "hash" or written < len(pairs):
        out["degraded"] = True
        out["reason"] = reason
    return out


def _embed_targets(ctx: WorkflowContext) -> list:
    """待向量化对象：params.from 指定的节点，否则最近祖先的 items/hits/units/chunks/values。"""
    keys = ("items", "hits", "units", "chunks", "values", "results")
    source = str(ctx.params.get("from") or "").strip()
    if source:
        return _from_items(ctx, source, keys)
    return _candidates(ctx, keys)


def _from_items(ctx: WorkflowContext, source: str, keys: Iterable[str]) -> list:
    """读指定祖先节点产物里的第一个非空列表（source 不可见 → 空）。"""
    art = ctx.artifacts.get(source)
    if not isinstance(art, Mapping):
        return []
    for key in keys:
        value = art.get(key)
        if isinstance(value, list) and value:
            return list(value)
    return []


def _real_owner(item: Any) -> bool:
    return isinstance(item, Mapping) and any(item.get(k) for k in ("id", "memory_id", "owner_id"))


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
    gw = _llm(ctx, "reranker")
    if gw is not None:
        try:
            order = [(int(p[0]), float(p[1]))
                     for p in (gw.rerank(query, docs, top_k=top_k) or [])]
            model = _active_label(gw, "reranker")
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
    archive_below = (_as_float(params.get("archive_below"), 0.1)
                     if "archive_below" in params else None)
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
        if archive_below is not None:
            row["archive"] = weight < archive_below
        out.append(row)
    out.sort(key=lambda r: -r["decay_weight"])
    ctx.note({"decayed": len(out)})
    result = {"status": "ok", "algorithm": "exponential-decay", "half_life_days": half_life,
              "items": out, "hits": out, "count": len(out)}
    if archive_below is not None:
        result["archive_below"] = archive_below
        result["to_archive"] = sum(1 for row in out if row.get("archive"))
    return result


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
    if rubric == "grade":
        return _judge_grade(ctx, params)
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
    # 4) 去重七动作：比对对象只能是召回到的旧记忆（hits），不能是上游抽取出来的候选本身
    #    （1.0.0 没有召回命中时拿候选自己去比，得出「正文完全一致 → noop」）
    if actions:
        return _judge_dedup(ctx, params, candidate, ctx.first_list("hits"), actions)
    return _judge_trust(ctx, params, near)


def _judge_grade(ctx: WorkflowContext, params: Mapping[str, Any]) -> dict:
    """批改：inputs.answers 与题目答案键做字符串相似度（0-5 分）。没有作答 → 该步 skipped。

    answers 是 ["答案", ...]（按题目顺序）或 [{index, answer}, ...]。批改没有模型实现，
    一律标降级（string-similarity），分数写进 items[].grade，下游 persist(review_log) 回写掌握度。
    """
    quiz = [dict(i) for i in _candidates(ctx, ("items",))
            if isinstance(i, Mapping) and i.get("question")]
    answers = ctx.inputs.get("answers")
    if not isinstance(answers, list) or not answers:
        return {"status": "skipped", "mode": "grade", "items": [], "graded": 0,
                "questions": len(quiz),
                "reason": "没有作答（inputs.answers=[...]），无法批改；作答后带 answers 再运行"}
    graded = []
    for index, answer in enumerate(answers):
        if isinstance(answer, Mapping):
            position = _as_int(answer.get("index"), index)
            given = str(answer.get("answer") or "")
        else:
            position, given = index, str(answer or "")
        if not 0 <= position < len(quiz):
            continue
        card = quiz[position]
        expected = str(card.get("answer") or "")
        if expected.strip() and given.strip() == expected.strip():
            score = 5
        else:
            score = int(round(_jaccard(expected, given) * 5)) if (expected or given) else 0
        graded.append({"index": position, "question": card.get("question"), "answer": given,
                       "expected": expected, "grade": max(0, min(5, score)),
                       "memory_id": card.get("source_id")})
    reason = "按字符串相似度批改（批改没有模型实现）"
    ctx.mark_degraded("judge", reason)
    return {"status": "ok", "mode": "grade", "items": graded, "graded": len(graded),
            "algorithm": "string-similarity", "degraded": True, "reason": reason}


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
    if best is None:
        verdict = {"action": "add", "target_id": None, "confidence": 0.7, "degraded": False,
                   "reason": "没有召回到相似的旧记忆，按新增处理", "merged_body": None}
    elif judge_mod is not None:
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
    # 时序关系没有模型实现，始终按时间戳规则判定——不论有没有配置判定模型都如实标降级
    degraded = True
    ctx.mark_degraded("judge", "时序关系没有模型实现：按 recorded_at / valid_from 时间戳规则判定")
    return {"status": "ok", "mode": "temporal", "relation": relation, "action": relation,
            "a_id": (a or {}).get("id"), "b_id": (b or {}).get("id"), "rule": "timestamp",
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
    quiz_rules = [str(r) for r in _as_list(params.get("rules")) if str(r) in QUIZ_RULES]
    if quiz_rules:
        return _verify_quiz(ctx, quiz_rules)
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


QUIZ_RULES = ("answerable", "no_leak", "not_trivial")


def _verify_quiz(ctx: WorkflowContext, rules: list[str]) -> dict:
    """题目校验（规则）：answerable=有答案键 / no_leak=题干不含答案 / not_trivial=题干至少 8 字。"""
    cards = [dict(i) for i in _candidates(ctx, ("items",))
             if isinstance(i, Mapping) and i.get("question")]
    kept, rejected = [], []
    for card in cards:
        question = str(card.get("question") or "")
        answer = str(card.get("answer") or "").strip()
        failed = []
        if "answerable" in rules and not answer:
            failed.append("answerable")
        if "no_leak" in rules and answer and answer.lower() in question.lower():
            failed.append("no_leak")
        if "not_trivial" in rules and len(question.strip()) < 8:
            failed.append("not_trivial")
        if failed:
            rejected.append(dict(card, failed_rules=failed))
        else:
            kept.append(card)
    return {"status": "ok", "mode": "quiz", "rules": rules, "items": kept, "rejected": rejected,
            "count": len(kept), "passed": len(kept), "failed": len(rejected),
            "verdict": "pass" if kept else "fail"}


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
    """内容哈希核验：同一内容只吸收一次。哈希口径与 ingest 一致（全文 sha256），
    1.0.0 用截断文本的 sha1 前 16 位去比 document.hash（sha256），永远不会命中。"""
    import hashlib

    text, _title, _origin = _document_source(ctx)
    digest = hashlib.sha256(str(text).encode("utf-8")).hexdigest()
    expected = str(params.get("hash") or ctx.inputs.get("hash") or "")
    row = None
    try:
        row = ctx.store.con.execute(
            "SELECT id FROM document WHERE hash = ? LIMIT 1", (digest,)).fetchone()
    except sqlite3.Error:  # pragma: no cover
        row = None
    duplicate = row is not None or bool(expected and expected != digest)
    return {"status": "ok", "mode": "content_hash", "hash": digest, "expected": expected,
            "duplicate": duplicate, "document_id": row["id"] if row is not None else None,
            "values": [], "verdict": "skip" if duplicate else "pass", "should_skip": duplicate,
            "is_new": not duplicate}


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
    """落库：按 persist_op(params) 分派到**唯一**的操作；解析不了 → 该步 failed。

    1.0.0 只认 target/table 的几个值，其余全部掉进「新增候选记忆」：forget-decay 的归档/硬删除、
    update-supersede 的推翻、dedup-merge 的合并写回都变成了插入新记忆。现在每个操作要么照参数
    做到（经 Store API，origin=workflow），要么返回 skipped / 抛错并说明原因。
    """
    op = persist_op(ctx.params)
    handler = PERSIST_HANDLERS.get(op or "")
    if handler is None:
        raise WorkflowError("persist 操作无法解析（params=%s）；可用操作：%s"
                            % (dumps(ctx.params), "/".join(PERSIST_OPS)))
    out = handler(ctx, ctx.params)
    out.setdefault("op", op)
    return out


def _persist_memory(ctx: WorkflowContext, params: Mapping[str, Any]) -> dict:
    """写记忆（store.add_memory，origin=workflow）；幂等键命中则复用原记录。

    条目来源：params.from 指定的节点（显式）> 最近祖先的 items/values/candidates/results >
    运行输入的正文（quick-capture）。工作流只能写 draft / candidate：模板要 approved 时写
    candidate 并在输出里如实报告（批准只能由人做，README 硬规则）。
    """
    requested = str(params.get("status") or "candidate").strip().lower()
    status = requested if requested in ("draft", "candidate") else "candidate"
    default_kind = str(params.get("kind") or "").strip()
    idem_key = str(params.get("idempotent_by") or "").strip()
    source = str(params.get("from") or "").strip()
    keys = ("items", "values", "candidates", "results", "units")
    if source:
        items = _from_items(ctx, source, keys)
        if not items:
            return {"status": "skipped", "target": "memory", "written": 0, "from": source,
                    "reason": "来源节点 %s 没有可写入的条目" % source}
    else:
        items = _candidates(ctx, keys[:4])
    payload_rows = []
    for item in items:
        row = dict(item) if isinstance(item, Mapping) else {"body": str(item)}
        body = _text_of(row)
        if not body.strip():
            continue
        payload_rows.append({
            "title": row.get("title") or _rule_title(body),
            "body": _clip_text(body, 4000),
            "kind": row.get("kind") or default_kind,
            "category": row.get("category") or "general",
            "importance": _clamp(row.get("importance"), 0.5),
            "confidence": _clamp(row.get("confidence"), 0.45),
            "quote": row.get("quote") or "",
            "source": row.get("source") or "workflow",
        })
    if not payload_rows and not source:
        text = ctx.text_for("content", "text", "body")
        if not text.strip():
            return {"status": "skipped", "target": "memory", "written": 0,
                    "reason": "没有可写入的记忆内容"}
        meta = ctx.inputs.get("candidate")
        if isinstance(meta, Mapping) and _text_of(meta).strip():
            payload_rows.append(dict(meta))
        else:
            payload_rows.append({"title": _rule_title(text), "body": _clip_text(text, 4000),
                                 "kind": default_kind, "category": "general"})
    due = ""
    due_source = str(params.get("review_due_from") or "").strip()
    if due_source:
        due = str(_as_dict(ctx.artifacts.get(due_source)).get("due") or "")
    written = []
    reused = 0
    for row in payload_rows:
        ctx.check_cancel()
        idem = ""
        if idem_key:
            value = ctx.inputs.get(idem_key)
            if value:
                idem = "flow-" + _hash("%s|%s" % (idem_key, value))
        metadata = {"workflow": ctx.template_id, "run_id": ctx.run_id, "node": ctx.node_id,
                    "source": row.get("source") or "workflow"}
        if requested != status:
            metadata["requested_status"] = requested
        data = {
            "title": str(row.get("title") or _rule_title(_text_of(row)))[:200],
            "body": str(row.get("body") or _text_of(row)),
            "kind": _kind_of(row.get("kind") or default_kind, KINDS_OF_MEMORY),
            "scope_id": str(params.get("scope") or ctx.scope or "global"),
            "status": status,
            "category": row.get("category") or "general",
            "importance": _clamp(row.get("importance"), 0.5),
            "confidence": _clamp(row.get("confidence"), 0.45),
            "agent_id": ctx.inputs.get("agent") or ctx.inputs.get("agent_id"),
            "metadata": metadata,
        }
        if due:
            data["review_due"] = due
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
            memory = ctx.store.add_memory(data, origin="workflow")
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
                }, origin="workflow")
            except (ValueError, KeyError):
                pass
        written.append({"id": memory.get("id"), "title": memory.get("title"),
                        "status": memory.get("status"), "kind": memory.get("kind")})
    ctx.note({"written": len(written), "reused": reused})
    out = {"status": "ok", "target": "memory", "written": len(written), "reused": reused,
           "items": written, "count": len(written), "memory_status": status,
           "memory_id": (written[0].get("id") if written and written[0].get("id") else None)}
    if source:
        out["from"] = source
    if due:
        out["review_due"] = due
    if requested != status:
        out["requested_status"] = requested
        out["note"] = "工作流不能批准记忆：已写为 %s，等待人工审核" % status
    return out


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


def _truthy(value: Any) -> bool:
    if value is True:
        return True
    return str(value or "").strip().lower() in ("1", "true", "yes", "y", "on")


def _nearest_with(ctx: WorkflowContext, key: str, *, mode: Iterable[str] = ()) -> dict:
    """最近的、含 key（且 mode 在给定集合里，若给了）的祖先产物；没有返回 {}。"""
    modes = tuple(mode)
    for art in ctx.nearest():
        if key in art and (not modes or str(art.get("mode") or "") in modes):
            return art
    return {}


def _mid_of(value: Any) -> str:
    if isinstance(value, Mapping):
        return str(value.get("id") or "").strip()
    return str(value or "").strip()


def _persist_archive(ctx: WorkflowContext, params: Mapping[str, Any]) -> dict:
    """归档（store.set_status → archived，状态机校验，origin=workflow）。

    对象：params.from 或最近祖先的 items/hits；若条目带 archive 标记（衰减节点给出）只归档
    archive=true 的。不能归档的（状态机不允许 / 已归档 / 不存在）逐条列在 skipped 里。
    """
    source = str(params.get("from") or "").strip()
    keys = ("items", "hits", "values", "results")
    items = _from_items(ctx, source, keys) if source else _candidates(ctx, keys)
    owned = [i for i in items if isinstance(i, Mapping) and i.get("id")]
    flagged = any("archive" in i for i in owned)
    targets = [i for i in owned if i.get("archive")] if flagged else owned
    note = str(params.get("note") or "工作流 %s 归档（run %s）" % (ctx.template_id, ctx.run_id))
    archived: list[dict] = []
    skipped: list[dict] = []
    for item in targets:
        ctx.check_cancel()
        mid = str(item["id"])
        memory = ctx.store.get_memory(mid)
        if memory is None:
            skipped.append({"id": mid, "reason": "记忆不存在"})
            continue
        current = str(memory.get("status") or "")
        if current == "archived":
            skipped.append({"id": mid, "reason": "已归档"})
            continue
        try:
            ctx.store.set_status(mid, "archived", note=note, origin="workflow")
        except ValueError as exc:
            skipped.append({"id": mid, "reason": str(exc)[:160]})
            continue
        archived.append({"id": mid, "title": memory.get("title"), "from": current})
    out = {"status": "ok", "target": "memory", "archived": archived, "skipped": skipped,
           "written": len(archived), "count": len(archived), "considered": len(targets),
           "below_threshold_only": flagged}
    if not targets:
        out["reason"] = "没有达到归档条件的记忆"
    return out


def _persist_purge(ctx: WorkflowContext, params: Mapping[str, Any]) -> dict:
    """硬删除（store.delete_memory(hard=True)）——只在**显式同意**时执行。

    需要 inputs.explicit_consent=true 且 inputs.purge_ids=[记忆 id…]；缺任何一个 → skipped，
    一条都不删。params.audit=true 时另写一条 workflow.purge 审计（store 本身也审计每条删除）。
    """
    requirement = str(params.get("require") or "explicit_consent").strip()
    if requirement != "explicit_consent":
        raise WorkflowError("未知的 purge 前置条件：%s" % requirement)
    consent = _truthy(ctx.inputs.get("explicit_consent"))
    ids = [_mid_of(x) for x in _as_list(ctx.inputs.get("purge_ids")) if _mid_of(x)]
    if not consent:
        return {"status": "skipped", "target": "memory", "purged": [], "written": 0,
                "reason": "硬删除需要显式同意：inputs.explicit_consent=true 且 "
                          "inputs.purge_ids=[记忆 id…]；本次未删除任何记忆"}
    if not ids:
        return {"status": "skipped", "target": "memory", "purged": [], "written": 0,
                "reason": "已同意但没有给出 purge_ids，未删除任何记忆"}
    purged: list[dict] = []
    missing: list[str] = []
    for mid in ids[:ITEMS_LIMIT]:
        ctx.check_cancel()
        memory = ctx.store.get_memory(mid)
        if memory is None:
            missing.append(mid)
            continue
        ctx.store.delete_memory(mid, hard=True)
        purged.append({"id": mid, "title": memory.get("title"),
                       "sensitivity": memory.get("sensitivity")})
    if params.get("audit"):
        ctx.store.audit("workflow.purge", ctx.run_id, actor="workflow",
                        detail={"template": ctx.template_id, "consent": True,
                                "purged": [p["id"] for p in purged], "missing": missing})
    return {"status": "ok", "target": "memory", "purged": purged, "missing": missing,
            "written": len(purged), "count": len(purged)}


def _supersede_pair(ctx: WorkflowContext) -> dict:
    """推翻对 (new_id, old_id)：new_id+old_id > a_id+b_id（按上游时间关系判谁新）> candidate+target_id。"""
    inputs = ctx.inputs
    new_id, old_id = _mid_of(inputs.get("new_id")), _mid_of(inputs.get("old_id"))
    if not (new_id and old_id):
        a_id, b_id = _mid_of(inputs.get("a_id")), _mid_of(inputs.get("b_id"))
        if a_id and b_id:
            relation = str(_nearest_with(ctx, "relation").get("relation") or "unknown")
            if relation == "after":
                new_id, old_id = a_id, b_id
            elif relation == "before":
                new_id, old_id = b_id, a_id
            else:
                return {"reason": "a/b 的时间关系是 %s，无法判断谁推翻谁；未改动任何记忆" % relation,
                        "a_id": a_id, "b_id": b_id}
        else:
            new_id = _mid_of(inputs.get("candidate"))
            old_id = _mid_of(inputs.get("target_id") or inputs.get("old_id"))
    if not (new_id and old_id):
        return {"reason": "没有可推翻的记忆对：需要 new_id+old_id、a_id+b_id 或 "
                          "candidate(已入库 id)+target_id；未改动任何记忆"}
    if new_id == old_id:
        return {"reason": "新旧记忆是同一条：%s" % new_id}
    new, old = ctx.store.get_memory(new_id), ctx.store.get_memory(old_id)
    if new is None or old is None:
        return {"reason": "记忆不存在：%s" % (new_id if new is None else old_id),
                "new_id": new_id, "old_id": old_id}
    return {"new_id": new_id, "old_id": old_id, "new": new, "old": old}


def _persist_supersede(ctx: WorkflowContext, params: Mapping[str, Any]) -> dict:
    """推翻：旧记忆 superseded_by=新、valid_to=生效时间、status=superseded，并建 新 --supersedes--> 旧。

    只按 params.set_fields 列出的字段改；三步在一个事务里（全成或全不成）。新记忆还没被人批准时
    不动旧记忆，登记一条待审核的 supersede 候选（批准只能由人做）。
    """
    pair = _supersede_pair(ctx)
    if pair.get("reason"):
        out = {"status": "skipped", "target": "memory", "applied": False}
        out.update({k: v for k, v in pair.items() if k not in ("new", "old")})
        return out
    new_id, old_id, new, old = pair["new_id"], pair["old_id"], pair["new"], pair["old"]
    valid_to = str(ctx.inputs.get("valid_from") or new.get("valid_from") or iso_now())
    if str(new.get("status")) != "approved":
        candidate = ctx.store.add_candidate({
            "batch_id": ctx.run_id, "memory_id": old_id, "scope_id": old.get("scope_id"),
            "action": "supersede", "target_id": new_id, "status": "needs_review",
            "run_id": ctx.run_id,
            "payload": {"new": _memory_brief(new), "old": _memory_brief(old),
                        "valid_to": valid_to},
            "judge": {"source": ctx.template_id, "node": ctx.node_id}})
        return {"status": "ok", "target": "candidate", "applied": False, "needs_review": True,
                "candidate_id": candidate.get("id"), "new_id": new_id, "old_id": old_id,
                "written": 1,
                "reason": "新记忆尚未批准（%s）：已登记待审核的 supersede 候选，旧记忆未改动"
                          % new.get("status")}
    fields = [str(f) for f in _as_list(params.get("set_fields"))] or \
        ["valid_to", "superseded_by", "status"]
    note = "被 %s 推翻（工作流 %s）" % (new_id, ctx.template_id)
    edge: dict = {}
    with ctx.store._txn():
        if "status" in fields:
            ctx.store.set_status(old_id, "superseded", note=note, origin="workflow")
        patch = {}
        if "valid_to" in fields:
            patch["valid_to"] = valid_to
        if "superseded_by" in fields:
            patch["superseded_by"] = new_id
        if patch:
            ctx.store.update_memory(old_id, patch, origin="workflow")
        edge = ctx.store.add_edge(new_id, "memory", old_id, "memory", "supersedes",
                                  weight=1.0, confidence=0.8, origin="inferred")
    return {"status": "ok", "target": "memory", "applied": True, "new_id": new_id,
            "old_id": old_id, "valid_to": valid_to, "fields": fields,
            "edge_id": edge.get("id"), "written": 1}


def _input_memory_id(ctx: WorkflowContext, key: str = "memory") -> str:
    """运行输入 key 指向的已入库记忆 id（字符串 id 或带 id 的 dict）；不是已入库记忆返回空串。"""
    mid = _mid_of(ctx.inputs.get(key))
    if not mid or len(mid) > 80:
        return ""
    try:
        return mid if ctx.store.get_memory(mid) else ""
    except Exception:
        return ""


def _persist_link(ctx: WorkflowContext, params: Mapping[str, Any]) -> dict:
    """建关系边（store.add_edge，幂等）。端点按 rel 推导：

      supersedes → 上游 supersede 实际推翻的 (新, 旧)；
      cue_of     → 上游线索 pairs：每条线索登记为 cue 实体，连到细节记忆；
      part_of    → params.from（或最近的记忆写入步）写出的子记忆 → 输入 memory 指向的原记忆；
      其它       → 上游 pairs=[{src, dst, src_kind?, dst_kind?}]，没有就 failed。
    端点不全 → skipped 并说明，不会编造边。
    """
    rel = str(params.get("rel") or "").strip()
    weight = _as_float(params.get("weight"), 1.0)
    confidence = _clamp(params.get("confidence"), 0.7)
    pairs: list[tuple[str, str, str, str]] = []
    reason = ""
    if rel == "supersedes":
        upstream = _nearest_with(ctx, "applied")
        if upstream.get("applied") and upstream.get("new_id") and upstream.get("old_id"):
            pairs.append((str(upstream["new_id"]), "memory", str(upstream["old_id"]), "memory"))
        else:
            reason = "上游没有实际推翻任何记忆，不建历史链"
    elif rel == "cue_of":
        unpaired = 0
        for pair in _as_list(_nearest_with(ctx, "pairs").get("pairs")):
            detail = _mid_of((pair or {}).get("detail_id")) if isinstance(pair, Mapping) else ""
            if not detail or ctx.store.get_memory(detail) is None:
                unpaired += 1
                continue
            for cue in _as_list(pair.get("cues")):
                cue_text = str(cue or "").strip()
                if not cue_text:
                    continue
                entity = ctx.store.upsert_entity(cue_text[:200], "cue", scope_id=ctx.scope)
                pairs.append((str(entity.get("id")), "entity", detail, "memory"))
        if not pairs:
            reason = "没有已入库的细节记忆可配对（items 需为记忆 id；未配对 %d 条）" % unpaired
    elif rel == "part_of":
        parent = _input_memory_id(ctx, "memory")
        source = str(params.get("from") or "").strip()
        children = _from_items(ctx, source, ("items",)) if source else \
            _as_list(_nearest_with(ctx, "items", mode=()).get("items"))
        child_ids = [_mid_of(c) for c in children if _mid_of(c) and _mid_of(c) != parent]
        if not parent:
            reason = "原记忆不是已入库记忆（inputs.memory 需为记忆 id），无法建立 part_of"
        elif not child_ids:
            reason = "没有写入的子记忆可连到原记忆"
        else:
            pairs = [(child, "memory", parent, "memory") for child in child_ids]
    else:
        for pair in _as_list(_nearest_with(ctx, "pairs").get("pairs")):
            if isinstance(pair, Mapping) and pair.get("src") and pair.get("dst"):
                pairs.append((str(pair["src"]), str(pair.get("src_kind") or "memory"),
                              str(pair["dst"]), str(pair.get("dst_kind") or "memory")))
        if not pairs:
            raise WorkflowError("link(rel=%s)：上游没有 pairs=[{src, dst}]，无法推导边的端点" % rel)
    if not pairs:
        return {"status": "skipped", "target": "edge", "rel": rel, "edges": [], "written": 0,
                "reason": reason}
    edges = []
    for src, src_kind, dst, dst_kind in pairs:
        ctx.check_cancel()
        edge = ctx.store.add_edge(src, src_kind, dst, dst_kind, rel, weight=weight,
                                  confidence=confidence, origin="inferred")
        edges.append({"id": edge.get("id"), "src": src, "dst": dst, "rel": rel})
    ctx.note({"edges": len(edges)})
    return {"status": "ok", "target": "edge", "rel": rel, "edges": edges[:50],
            "written": len(edges), "count": len(edges)}


def _sm2_review_write(store: Any, mid: str, grade: int) -> dict:
    """SM-2 复习：与 POST /api/memories/{id}/review 同一算法（写 review_log + 更新 review_* 字段）。"""
    con = store.con
    row = con.execute("SELECT ease, interval FROM review_log WHERE memory_id = ? "
                      "ORDER BY at DESC, id DESC LIMIT 1", (mid,)).fetchone()
    ease = float(row["ease"]) if row and row["ease"] else 2.5
    interval = float(row["interval"]) if row and row["interval"] else 0.0
    repeats = int(con.execute("SELECT count(*) FROM review_log WHERE memory_id = ? AND grade >= 3",
                              (mid,)).fetchone()[0])
    if grade >= 3:
        interval = 1.0 if repeats == 0 else (6.0 if repeats == 1 else max(1.0, round(interval * ease)))
        ease = max(1.3, ease + 0.1 - (5 - grade) * (0.08 + (5 - grade) * 0.02))
    else:
        interval = 1.0
    difficulty = round(max(0.0, min(1.0, (5 - grade) / 5.0)), 3)
    due = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + interval * 86400))
    stamp = iso_now()
    with store._txn() as txn:
        txn.execute("INSERT INTO review_log(id, memory_id, grade, algorithm, interval, ease, due, at) "
                    "VALUES(?,?,?,?,?,?,?,?)", (_new_id("rv"), mid, grade, "sm2", interval, ease,
                                                due, stamp))
        txn.execute("UPDATE memory SET review_due = ?, last_reviewed = ?, "
                    "review_count = review_count + 1, stability = ?, difficulty = ?, "
                    "updated_at = ? WHERE id = ?", (due, stamp, interval, difficulty, stamp, mid))
        store.audit("memory.review", mid, actor="workflow",
                    detail={"grade": grade, "due": due, "interval": interval})
    return {"memory_id": mid, "grade": grade, "interval": interval, "ease": round(ease, 3),
            "due": due}


def _persist_review_log(ctx: WorkflowContext, params: Mapping[str, Any]) -> dict:
    """更新掌握度：上游批改（judge rubric=grade）的每条结果写 review_log 并按 SM-2 更新记忆。"""
    graded = [g for g in _as_list(_nearest_with(ctx, "items", mode=("grade",)).get("items"))
              if isinstance(g, Mapping)]
    if not graded:
        return {"status": "skipped", "target": "review_log", "written": 0,
                "reason": "没有批改结果（需要 inputs.answers），未写复习日志"}
    rows: list[dict] = []
    unlinked = 0
    for item in graded:
        ctx.check_cancel()
        mid = _mid_of(item.get("memory_id"))
        if not mid or ctx.store.get_memory(mid) is None:
            unlinked += 1
            continue
        rows.append(_sm2_review_write(ctx.store, mid, max(0, min(5, _as_int(item.get("grade"), 0)))))
    out = {"status": "ok" if rows else "skipped", "target": "review_log", "written": len(rows),
           "items": rows, "count": len(rows), "unlinked": unlinked,
           "algorithm": str(params.get("algorithm") or "sm2")}
    if not rows:
        out["reason"] = "批改结果没有对应的已入库记忆（题目素材不是记忆）"
    return out


def _write_candidate_memory(ctx: WorkflowContext, subject: Mapping[str, Any], extra: dict) -> dict:
    body = _text_of(subject)
    data = {"title": str(subject.get("title") or _rule_title(body))[:200], "body": body,
            "kind": _kind_of(subject.get("kind"), KINDS_OF_MEMORY),
            "scope_id": str(subject.get("scope_id") or ctx.scope or "global"),
            "status": "candidate",
            "metadata": dict({"workflow": ctx.template_id, "run_id": ctx.run_id,
                              "node": ctx.node_id}, **extra)}
    return ctx.store.add_memory(data, origin="workflow")


def _persist_merge(ctx: WorkflowContext, params: Mapping[str, Any]) -> dict:
    """合并写回：按上游判定动作执行。

      noop → 不写（重复）；add → 新增候选记忆；link → 新增候选记忆 + semantic 边连到目标；
      merge / update / supersede / ask → 会改动已有记忆：登记待审核候选（needs_review），
      不自动改写——keep_sources / keep_history 因此天然成立（原记忆与来源一字未动）。
    """
    verdict = _nearest_with(ctx, "action", mode=("dedup", "threshold", "score-rule"))
    if not verdict:
        raise WorkflowError("merge 操作需要上游判定节点（judge）给出 action")
    action = str(verdict.get("action") or "")
    target = _mid_of(verdict.get("target_id"))
    subject = verdict.get("candidate") if isinstance(verdict.get("candidate"), Mapping) \
        else _judge_subject(ctx)
    base = {"action": action, "target_id": target or None, "confidence": verdict.get("confidence")}
    if action == "noop":
        return dict(base, status="skipped", target="memory", applied=False, written=0,
                    reason="判定为重复（noop，目标 %s）：不写入" % (target or "—"))
    if action in ("add", "link"):
        if not _text_of(subject).strip():
            raise WorkflowError("判定为 %s，但候选没有正文" % action)
        memory = _write_candidate_memory(ctx, subject, {"judge_action": action})
        out = dict(base, status="ok", target="memory", applied=True, written=1,
                   memory_id=memory.get("id"), memory_status=memory.get("status"))
        if action == "link" and target and ctx.store.get_memory(target) is not None:
            edge = ctx.store.add_edge(memory["id"], "memory", target, "memory", "semantic",
                                      weight=0.6, confidence=_clamp(verdict.get("confidence"), 0.5),
                                      origin="inferred")
            out["edge_id"] = edge.get("id")
        return out
    candidate = ctx.store.add_candidate({
        "batch_id": ctx.run_id, "scope_id": ctx.scope, "action": action if action in
        CANDIDATE_ACTIONS else "ask", "target_id": target or None, "status": "needs_review",
        "run_id": ctx.run_id,
        "payload": {"candidate": dict(subject or {}), "merged_body": verdict.get("merged_body"),
                    "keep_sources": bool(params.get("keep_sources")),
                    "keep_history": bool(params.get("keep_history"))},
        "judge": {"confidence": verdict.get("confidence"), "reason": verdict.get("reason")}})
    return dict(base, status="ok", target="candidate", applied=False, needs_review=True,
                written=1, candidate_id=candidate.get("id"),
                reason="判定为 %s：会改动已有记忆，已登记待审核候选（不自动合并）" % action)


def _document_source(ctx: WorkflowContext) -> tuple[str, str, str]:
    """文档全文（不是给下游的 2000 字摘录）、标题、来源：运行输入正文 > input 节点读到的文件。"""
    for key in ("content", "text", "body"):
        value = ctx.inputs.get(key)
        if isinstance(value, str) and value.strip():
            return value, _rule_title(value), "workflow:%s" % ctx.run_id
    for art in ctx.nearest():
        inputs = art.get("inputs")
        if isinstance(inputs, Mapping) and isinstance(inputs.get("content"), str) \
                and inputs["content"].strip():
            loaded = _as_dict(art.get("loaded"))
            text = inputs["content"]
            return (text, str(loaded.get("title") or _rule_title(text)),
                    str(loaded.get("source") or "workflow:%s" % ctx.run_id))
    text = ctx.text_for("content", "text", "body")
    return text, _rule_title(text), "workflow:%s" % ctx.run_id


def _persist_document(ctx: WorkflowContext, params: Mapping[str, Any]) -> dict:
    """写文档库（ingest.ingest_text：document 行 + chunk + vault/notes 镜像）。

    上游内容哈希核验判定为重复 → skipped，不重复写。输出 chunks（id + 文本）供下游向量化。
    """
    mirror = str(params.get("mirror") or "markdown").strip().lower()
    if mirror != "markdown":
        raise WorkflowError("document 操作只支持 mirror=markdown（收到 %s）" % mirror)
    check = _nearest_with(ctx, "duplicate", mode=("content_hash",))
    if check.get("duplicate"):
        return {"status": "skipped", "target": "document", "written": 0,
                "document_id": check.get("document_id"), "hash": check.get("hash"),
                "reason": "内容哈希已存在（文档 %s），不重复写入" % (check.get("document_id") or "—")}
    text, title, origin = _document_source(ctx)
    if not text.strip():
        return {"status": "skipped", "target": "document", "written": 0, "reason": "没有文档正文"}
    from . import ingest as ingest_mod

    result = ingest_mod.ingest_text(ctx.store, text, title=title, scope=ctx.scope,
                                    kind=str(params.get("kind") or "note"), origin=origin)
    doc_id = result.get("document_id")
    rows = ctx.store.con.execute(
        "SELECT id, text FROM chunk WHERE document_id = ? ORDER BY ordinal LIMIT 500",
        (doc_id,)).fetchall()
    chunks = [{"id": row["id"], "text": _clip_text(row["text"], 2000)} for row in rows]
    ctx.note({"document": doc_id, "chunks": len(chunks)})
    return {"status": "ok", "target": "document", "written": 1, "document_id": doc_id,
            "path": result.get("path"), "title": title, "origin": origin, "chunks": chunks,
            "chunk_count": len(chunks), "bytes": result.get("bytes")}


def _persist_conflict(ctx: WorkflowContext, params: Mapping[str, Any]) -> dict:
    """写冲突表（store.add_conflict，同一对已有 open 冲突则跳过）+ 审计报告（vault reports/）。"""
    min_score = _clamp(params.get("min_score"), 0.5)
    proposal = _nearest_with(ctx, "action")
    written: list[dict] = []
    skipped = 0
    for pair in _as_list(_nearest_with(ctx, "pairs").get("pairs")):
        ctx.check_cancel()
        if not isinstance(pair, Mapping):
            continue
        a_id, b_id = _mid_of(pair.get("a")), _mid_of(pair.get("b"))
        score = _as_float(pair.get("score"), 0.0)
        if not (a_id and b_id) or score < min_score:
            skipped += 1
            continue
        exists = ctx.store.con.execute(
            "SELECT id FROM conflict WHERE status = 'open' AND ((a_id = ? AND b_id = ?) OR "
            "(a_id = ? AND b_id = ?))", (a_id, b_id, b_id, a_id)).fetchone()
        if exists is not None:
            skipped += 1
            continue
        row = ctx.store.add_conflict({
            "kind": "contradiction", "a_id": a_id, "b_id": b_id, "score": score,
            "detail": {"cues": pair.get("cues"), "run_id": ctx.run_id,
                       "template": ctx.template_id, "proposal": proposal.get("action")}})
        written.append({"id": row.get("id"), "a_id": a_id, "b_id": b_id, "score": score})
    body = ctx.text_for("markdown", "report", "text") or _render_report(ctx)
    name = str(params.get("name") or "%s-%s" % (ctx.template_id, ctx.run_id[-6:]))
    vault = getattr(ctx.store, "vault", None)
    path = None
    out = {"status": "ok", "target": "conflict", "conflicts": written, "written": len(written),
           "skipped_pairs": skipped, "min_score": min_score, "proposal": proposal.get("action")}
    if vault is None:
        ctx.mark_degraded("persist", "vault 不可用，审计报告未写文件")
        out.update({"degraded": True, "reason": "vault 不可用，审计报告未写文件"})
    else:
        path = vault.write_report(name, body)
    out["report_path"] = path
    return out


def _persist_graph(ctx: WorkflowContext, params: Mapping[str, Any]) -> dict:
    """「写图库」：实体与边已由上游 graph 节点写进 entity / edge 表；社区与中心度是只读计算，
    没有专门的表可写。这里只汇总上游真实写入的数量，written=0（不假装又写了一遍）。"""
    entities = edges = 0
    communities = None
    for art in ctx.nearest():
        if art.get("mode") == "build":
            entities += len(_as_list(art.get("entities")))
            edges += len(_as_list(art.get("edges")))
        if art.get("algorithm") == "connected-components" and communities is None:
            communities = _as_int(art.get("count"), 0)
    return {"status": "ok", "target": "graph", "written": 0, "entities": entities,
            "edges": edges, "communities": communities,
            "note": "实体与边由上游 graph 节点写入；社区 / 中心度是只读计算结果，没有表可写"}


def _persist_job(ctx: WorkflowContext, params: Mapping[str, Any]) -> dict:
    """写 job 表（与 schedule 节点同一入队实现）；必须给 params.job（目标模板 id）。"""
    target = str(params.get("job") or "").strip()
    if not target:
        raise WorkflowError("persist(table=job) 需要 params.job（目标模板 id）")
    job = _enqueue_job(ctx, target, delay=max(0, _as_int(params.get("delay_s"), 0)),
                       max_attempts=_as_int(params.get("max_attempts"), JOB_MAX_ATTEMPTS))
    return {"status": "ok", "target": "job", "written": 1, "job_id": job["id"],
            "kind": target, "run_after": job["run_after"]}


PERSIST_HANDLERS: dict[str, Callable[[WorkflowContext, Mapping[str, Any]], dict]] = {
    "memory": _persist_memory,
    "markdown": _persist_markdown,
    "report": _persist_report,
    "audit": _persist_audit,
    "candidate": lambda ctx, params: _persist_table(ctx, params, "candidate"),
    "recall_log": lambda ctx, params: _persist_table(ctx, params, "recall_log"),
    "job": _persist_job,
    "review_log": _persist_review_log,
    "archive": _persist_archive,
    "purge": _persist_purge,
    "supersede": _persist_supersede,
    "link": _persist_link,
    "merge": _persist_merge,
    "document": _persist_document,
    "conflict": _persist_conflict,
    "graph": _persist_graph,
}


def node_index(ctx: WorkflowContext, node: dict) -> dict:
    """索引维护：FTS 重建 / 向量增量（真的写向量）/ 索引统计。"""
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
        # 1.0.0 这里只数了 pending 就返回 ok；现在对没有向量的对象真的写向量
        out = _embed_items(ctx, _embed_targets(ctx),
                           owner_kind=str(params.get("owner_kind") or "memory"),
                           incremental=True)
        out["engine"] = "vector"
        out["index_mode"] = "vector-incremental"
        return out
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
            "orphans": orphans, "engine": engine or "generic",
            "note": "只统计索引状态，不写入"}


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
    """建实体与边（store.upsert_entity / add_edge），幂等。

    关系类型没有判定实现：只在共现窗口内建 semantic 边（origin=cooccurrence）。1.0.0 把
    params.rels[0]（例如 hypernym）套到所有实体两两之间——那是编造的关系。模板要求的关系类型
    若不只是 semantic / mentions，step 标 degraded 并写明只建了共现边。
    """
    rels = [str(r) for r in _as_list(params.get("rels"))] or ["mentions"]
    names = _entity_names(ctx, params)
    created, edges, linked = [], [], 0
    scope = str(params.get("scope") or ctx.scope)
    entity_ids: dict[str, str] = {}
    for name in names:
        ctx.check_cancel()
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
    text = ctx.text_for("content", "text", "body")
    window = max(10, _as_int(params.get("window"), 120))
    for left, right, confidence in _cooccurring(list(entity_ids), text, window):
        ctx.check_cancel()
        try:
            edge = ctx.store.add_edge(entity_ids[left], "entity", entity_ids[right], "entity",
                                      "semantic", weight=confidence, confidence=confidence,
                                      origin="cooccurrence")
            edges.append({"src": entity_ids[left], "dst": entity_ids[right], "rel": "semantic",
                          "id": edge.get("id"), "confidence": confidence})
        except (ValueError, KeyError) as exc:
            ctx.mark_degraded("graph", "建边失败：%s" % exc)
            break
    unsupported = [r for r in rels if r not in ("semantic", "mentions")]
    out = {"status": "ok", "mode": "build", "entities": created, "edges": edges,
           "count": len(created), "links": linked, "rels_requested": rels,
           "rels_applied": ["semantic"] if edges else [], "window": window,
           "values": [{"id": e["id"], "title": e["name"], "kind": "entity"} for e in created],
           "has_graph": bool(created)}
    if unsupported:
        reason = "关系类型 %s 没有判定实现，只建了共现窗口内的 semantic 边" % "/".join(unsupported)
        ctx.mark_degraded("graph", reason)
        out.update({"degraded": True, "reason": reason})
    ctx.note({"entities": len(created), "edges": len(edges)})
    return out


def _cooccurring(names: list[str], text: str, window: int) -> list[tuple[str, str, float]]:
    """首次出现位置相距不超过 window 个字符的实体对（置信度随距离递减，最多 60 对）。"""
    out: list[tuple[str, str, float]] = []
    if not text:
        return out
    positions = {name: text.find(name) for name in names}
    for i in range(len(names)):
        for j in range(i + 1, len(names)):
            left, right = names[i], names[j]
            pos_a, pos_b = positions[left], positions[right]
            if pos_a < 0 or pos_b < 0 or abs(pos_a - pos_b) > window:
                continue
            out.append((left, right,
                        round(max(0.3, 1.0 - abs(pos_a - pos_b) / max(1, window)), 3)))
            if len(out) >= 60:
                return out
    return out


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
    gw = _llm(ctx, "chat")
    if gw is not None:
        try:
            content = str(gw.chat([{"role": "user", "content": prompt}], role="chat",
                                  max_tokens=max_tokens, temperature=0.2) or "").strip()
            model = _active_label(gw, "chat")
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
    """抽象线索：judge.abstraction_cues 优先，否则问句模板。

    上游给的是条目（detail-abstraction 的 items）时逐条生成，输出 pairs=[{detail_id, cues}]，
    下游 persist(op=link, rel=cue_of) 据此把线索和细节配对。
    """
    sources = [dict(i) for i in _candidates(ctx, ("items",)) if isinstance(i, Mapping)
               and _text_of(i).strip()]
    if not sources:
        sources = [{"id": None, "title": _rule_title(text, "这段内容"), "body": text}]
    pairs: list[dict] = []
    degraded = False
    for item in sources[:ITEMS_LIMIT]:
        ctx.check_cancel()
        body = _text_of(item)
        cues: list[str] = []
        if judge_mod is not None:
            verdict = judge_mod.abstraction_cues(ctx.store, ctx.gw, body)
            cues = [str(c) for c in _as_list(verdict.get("cues")) if str(c).strip()]
            degraded = degraded or bool(verdict.get("degraded"))
        if not cues:
            title = _rule_title(body, "这段内容")
            cues = ["%s是什么？" % title, "%s的关键点有哪些？" % title]
            degraded = True
        pairs.append({"detail_id": item.get("id"), "title": _title_of(item), "cues": cues[:6]})
    if degraded:
        ctx.mark_degraded("generate", "抽象线索使用问句模板兜底")
    flat = [cue for pair in pairs for cue in pair["cues"]]
    return {"status": "ok", "mode": "cue", "cues": flat[:60], "pairs": pairs,
            "text": "\n".join(flat[:60]), "count": len(flat), "degraded": degraded}


def _generate_quiz(ctx: WorkflowContext, params: Mapping[str, Any], text: str) -> dict:
    """生成题目：chat 角色可用走 LLM，否则逐条素材生成填空题（答案键 + 来源记忆 id）。"""
    count = max(1, _as_int(params.get("count") or ctx.inputs.get("count"), 3))
    types = [str(t) for t in _as_list(params.get("types"))] or ["single"]
    items = [i for i in _candidates(ctx, ("items", "values", "hits", "results"))
             if isinstance(i, Mapping)]
    source = text or "\n".join(_text_of(i) for i in items)
    degraded = False
    reason = ""
    cards: list[dict] = []
    gw = _llm(ctx, "chat")
    if gw is not None:
        try:
            prompt = prompts.render_named("quiz", {"count": count, "budget": 800}) \
                + "\n\n材料：\n" + _clip_text(source, 3000)
            reply = gw.chat([{"role": "user", "content": prompt}], role="chat",
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
            reason = "出题失败：%s" % type(exc).__name__
    if not cards:
        degraded = True
        reason = reason or "未配置对话模型：题目由填空模板生成"
        ctx.mark_degraded("generate", reason)
        cards = _cloze_cards(items, source, count)
    return {"status": "ok", "mode": "cloze" if degraded else "llm", "items": cards,
            "count": len(cards), "types": types, "degraded": degraded,
            "reason": reason if degraded else ""}


def _cloze_cards(items: list, source: str, count: int) -> list[dict]:
    """填空题：优先逐条素材（保留 source_id，批改后能回写掌握度），否则按句子。"""
    cards: list[dict] = []
    material = [(i.get("id"), _text_of(i)) for i in items if _text_of(i).strip()]
    if not material:
        material = [(None, sentence) for sentence in _sentences(source)]
    for source_id, body in material:
        sentence = _first_sentence(body, 300) or body[:300]
        words = _keywords_of(sentence, 3)
        blank = words[0] if words else ""
        if not blank:
            continue
        cards.append({"type": "blank", "question": _clip_text(sentence.replace(blank, "____", 1),
                                                               300),
                      "answer": blank, "explanation": "出自原文", "source_id": source_id})
        if len(cards) >= count:
            break
    return cards


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
    gw = _llm(ctx, "judge")
    if gw is not None:
        try:
            prompt = prompts.render_named("decide_action", {
                "actions": actions, "evidence": json.dumps(evidence, ensure_ascii=False)})
            payload = gw.judge(prompt, role="judge")
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
        degraded = gw is None or degraded
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
    arts = {nid: art for nid, art in reversed(list(ctx.artifacts.items()))
            if isinstance(art, Mapping)}  # 最近的祖先优先
    scored = [art for art in arts.values() if art.get("algorithm") == "conflict-score"]
    if scored and not any(_as_list(art.get("pairs")) for art in scored):
        return "none", "没有发现冲突对，不需要任何动作", 0.9
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


JOB_MAX_ATTEMPTS = 5


def node_schedule(ctx: WorkflowContext, node: dict) -> dict:
    """调度。

      * params.job = 目标模板 id → 写一行 job（queued），由 job 消费者（服务进程里的后台线程，
        见 start_background）领取后用 run_workflow 执行该模板；
      * params.algorithm = sm2（无 job）→ 计算复习到期时间（SM-2 首次间隔 1 天），
        下游 persist 用 review_due_from 写进 memory.review_due，不入队；
      * 其它情况 → 该步 failed（1.0.0 会写一行谁也不消费的 job，并原样回显 cron）。
    本版本没有 cron 调度器：给了 cron 时只入队一次，step 标 degraded 并说明。
    """
    params = ctx.params
    algorithm = str(params.get("algorithm") or "").strip().lower()
    target = str(params.get("job") or "").strip()
    if not target and algorithm == "sm2":
        return _sm2_plan(ctx, params)
    if not target:
        raise WorkflowError("schedule 节点缺少 job（目标模板 id）：没有消费者能执行无目标的任务")
    if get_template(ctx.store, target) is None and \
            target not in {str(t.get("id")) for t in _builtin_templates()}:
        raise WorkflowNotFound("schedule 的目标模板不存在：%s" % target)
    job = _enqueue_job(ctx, target, delay=max(0, _as_int(params.get("delay_s")
                                                          or params.get("delay_seconds"), 0)),
                       max_attempts=_as_int(params.get("max_attempts"), JOB_MAX_ATTEMPTS))
    ctx.note({"job": job["id"]})
    out = {"status": "ok", "job_id": job["id"], "kind": target, "target_template": target,
           "run_after": job["run_after"], "queued": True}
    if params.get("cron"):
        reason = "cron 未生效：本版本没有定时调度器，任务只入队一次"
        ctx.mark_degraded("schedule", reason)
        out.update({"cron": params.get("cron"), "cron_active": False, "degraded": True,
                    "reason": reason})
    return out


def _enqueue_job(ctx: WorkflowContext, target: str, *, delay: int = 0,
                 max_attempts: int = JOB_MAX_ATTEMPTS) -> dict:
    """写一行 job（status=queued，run_after=现在+delay）。写失败直接抛（该步 failed）。"""
    inputs = {str(k): v for k, v in ctx.inputs.items()}
    if len(dumps(inputs)) > 65536:
        inputs = {k: v for k, v in inputs.items() if not isinstance(v, (dict, list))}
    payload = {"target_template": target, "inputs": inputs, "scope": ctx.scope,
               "source": {"run_id": ctx.run_id, "template": ctx.template_id, "node": ctx.node_id}}
    run_after = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + max(0, delay)))
    job_id = _new_id("job")
    stamp = iso_now()
    with ctx.store._txn() as con:
        con.execute(
            "INSERT INTO job(id, kind, status, payload, attempts, max_attempts, run_after, "
            "last_error, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
            (job_id, target, "queued", dumps(payload), 0, max(1, max_attempts), run_after, None,
             stamp, stamp),
        )
        ctx.store.audit("job.enqueue", job_id, actor="workflow",
                        detail={"kind": target, "run_id": ctx.run_id, "run_after": run_after})
    return {"id": job_id, "run_after": run_after}


def _sm2_plan(ctx: WorkflowContext, params: Mapping[str, Any]) -> dict:
    """SM-2 首次复习计划：间隔 1 天（I1=1），ease 取 params.ease（默认 2.5）。"""
    ease = _as_float(params.get("ease"), 2.5)
    due = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + 86400))
    planned = len([i for i in _candidates(ctx, ("items",)) if isinstance(i, Mapping)])
    return {"status": "ok", "mode": "sm2-plan", "algorithm": "sm2", "ease": ease,
            "interval_days": 1, "due": due, "planned": planned, "queued": False,
            "note": "SM-2 首次间隔 1 天；下游 persist(review_due_from) 写入 memory.review_due，不入 job 队列"}


def node_emit(ctx: WorkflowContext, node: dict) -> dict:
    """事件广播：发布到进程内事件总线（SSE /api/events，类型 run、phase=emit）并写 audit。

    如实报告：published（进了总线）/ subscribers（当时在线的 SSE 订阅者）/ delivered（至少一个
    订阅者或调用方 emitter 收到）。1.0.0 不论有没有人收到都报 delivered=true、via=sse。
    """
    params = ctx.params
    channel = str(params.get("channel") or "ui")
    event_name = str(params.get("event") or "workflow.%s" % ctx.node_id)
    body = ctx.text_for("markdown", "text", "summary", "content")
    data = {"phase": "emit", "run_id": ctx.run_id, "template_id": ctx.template_id,
            "node_id": ctx.node_id, "event": event_name, "channel": channel,
            "preview": _clip_text(body, 200)}
    if params.get("format"):
        data["format"] = params["format"]
    if params.get("schema"):
        data["schema"] = params["schema"]
    sink = ctx.emitter if isinstance(ctx.emitter, RunEmitter) else RunEmitter(
        ctx.store, ctx.emitter, ctx.run_id)
    report = sink.send("run", data)
    delivered = report["subscribers"] > 0 or report["forwarded"]
    via = "sse" if report["subscribers"] > 0 else ("emitter" if report["forwarded"] else "audit")
    try:
        ctx.store.audit("workflow.emit", ctx.run_id, actor="workflow",
                        detail={"event": event_name, "channel": channel, "delivered": delivered,
                                "subscribers": report["subscribers"]})
    except Exception:  # pragma: no cover
        pass
    out = {"status": "ok", "event": event_name, "channel": channel,
           "published": report["published"], "subscribers": report["subscribers"],
           "forwarded": report["forwarded"], "delivered": delivered, "via": via,
           "event_id": report.get("id"), "payload": data, "body": _clip_text(body, 600)}
    if params.get("schema") or params.get("format"):
        out["note"] = "只广播事件；交换格式文件请用 GET /api/exchange/export 导出"
    return out



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
    """本地 char n-gram hash 向量（256 维）；只给有 id 的对象写向量。"""
    with _offline(ctx):
        out = _embed_items(ctx, _embed_targets(ctx),
                           owner_kind=str(ctx.params.get("owner_kind") or "memory"),
                           incremental=bool(ctx.params.get("incremental")))
    ctx.mark_degraded("vector", "char n-gram hash 向量（fallback）")
    out.update({"degraded": True, "fallback": "char-ngram-hash"})
    return out


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
            "a_id": a.get("id"), "b_id": b.get("id"),
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
    """取模板；只有**内置**模板缺行时才补种（1.0.0 对任何未知 id 都整表重灌并写 seed 审计）。"""
    template = get_template(store, template_id)
    if template is not None:
        return template
    if template_id in {str(t.get("id")) for t in _builtin_templates()}:
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
    """取节点处理器；未注册的 kind → 必然失败的处理器（该步 failed，错误写清楚）。

    1.0.0 把缺失的 kind 登记为 noop 并标 degraded：run 落 partial、error 为空，看不出出了错。
    """
    kind = str(node.get("kind") or "").strip()
    handler = resolve_handler(kind) if known_kind(kind) else None
    if handler is not None:
        return handler

    def _unknown(ctx: WorkflowContext, _node: dict) -> dict:
        raise WorkflowError("未知节点类型：%s（没有注册处理器；内置类型：%s）"
                            % (kind or "（空）", "/".join(KINDS)))

    return _unknown


def _thread_store(store):
    """并行层工作线程用的 Store：同库、独立连接，执行完由调用方关闭。

    不走 Store(db, vault)：构造函数会 vault.attach(新实例)，把服务里唯一的共享 Vault 指向这个
    短命的线程 Store（关闭后 vault 再写 document 行就落到无人管理的连接上）。这里先不带 vault
    构造，再挂上共享 vault 的引用（不改 vault.store）。
    """
    if Store is None or not isinstance(store, Store) or getattr(store, "db_path", None) is None:
        return store
    try:
        clone = Store(store.db_path, None)
    except Exception:  # pragma: no cover
        return store
    vault = getattr(store, "vault", None)
    clone.vault = vault
    clone.mirror = bool(getattr(store, "mirror", vault is not None))
    return clone


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
                      parents: Mapping[str, list[dict]],
                      nodes: Mapping[str, Mapping[str, Any]] | None = None) -> dict:
    """祖先链快照：只暴露祖先（兄弟分支不可见），按「远 → 近」排列。"""
    names = _self_and_ancestors(node_id, parents, nodes)
    return {name: artifacts[name] for name in names if name in artifacts}


def _edge_decision(node_id: str, parents: Mapping[str, list[dict]],
                   artifacts: Mapping[str, Any], statuses: Mapping[str, str],
                   degraded: Mapping[str, bool],
                   nodes: Mapping[str, Mapping[str, Any]] | None = None) -> tuple[bool, str]:
    """按入边 when 决定节点是否执行：至少一条边成立才跑。if: 只看该边源节点的谱系。"""
    edges = parents.get(node_id) or []
    if not edges:
        return True, ""
    reasons = []
    for edge in edges:
        src = edge["from"]
        status = statuses.get(src, "skipped")
        is_degraded = bool(degraded.get(src)) or status == "degraded"
        lineage = _lineage_artifacts(src, parents, artifacts, nodes)
        if _when_holds(edge.get("when", "always"), status, is_degraded, lineage):
            return True, ""
        reasons.append("%s[%s]" % (src, edge.get("when")))
    return False, "边条件未命中：" + ", ".join(reasons)


def _node_context(store, gw, template, node, *, run_id, tpl_id, tpl_name, inputs, scope,
                  artifacts, ordinal, emitter, fallbacks, cancel=None) -> WorkflowContext:
    """装配节点上下文（可见集合由调用方给；cancel 是协作式取消令牌）。"""
    ctx = WorkflowContext(
        store=store, gw=gw, inputs=dict(inputs or {}), scope=scope, run_id=run_id,
        emitter=emitter, degraded=[], artifacts=dict(artifacts or {}),
        run_key=run_id, template_id=tpl_id, template_name=tpl_name,
        node_id=str(node.get("id") or ""), node=dict(node),
        params=dict(node.get("params") or {}), ordinal=ordinal,
        template=template, fallbacks=dict(fallbacks or {}), use_llm=gw is not None,
        cancel=cancel,
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
    """执行单个节点；返回 {status, output, degraded, error, degraded_list, ms}。

    开跑前先落一行 status=running 的 step（轮询 GET /api/runs/{id} 能看到正在跑哪一步；进程崩溃
    时由启动回收标 failed）。处理器抛 WorkflowRunCancelled → 该步 cancelled；返回
    {"status": "skipped"} → 该步 skipped（前置条件不满足，原因写在 output.reason）。
    """
    ctx = _node_context(store, gw, template, node, run_id=run_id, tpl_id=tpl_id,
                        tpl_name=tpl_name, inputs=inputs, scope=scope, artifacts=visible,
                        ordinal=ordinal, emitter=emitter, fallbacks=fallbacks, cancel=cancel)
    runner = _handler_for(node)
    ctx.step_meta["attempts"].append({"kind": "handler", "name": str(node.get("kind"))})
    started_iso = iso_now()
    started_ms = _now_ms()
    _persist_step(store, run_id, ctx, ordinal, status="running", output={}, started=started_iso)
    status = "ok"
    output: Any = {}
    error: str | None = None
    degraded = False
    model = ""
    tokens = 0
    skipped = False

    try:
        ctx.check_cancel()
        result = runner(ctx, dict(node))
        output = result if isinstance(result, dict) else {"value": result}
        if not isinstance(result, dict):
            ctx.mark_degraded(str(node.get("kind")), "处理器返回非 dict，已包装")
    except WorkflowRunCancelled as stop:
        status, error = "cancelled", str(stop)[:200]
        output = {"cancelled": True, "reason": error}
    except Exception as exc:
        ctx.step_meta.setdefault("metrics", {})["ms"] = int(_now_ms() - started_ms)
        if _unavailable(exc):
            try:
                status, output, error, degraded = _run_fallback(ctx, template, node, exc)
            except WorkflowRunCancelled as stop:
                status, error = "cancelled", str(stop)[:200]
                output = {"cancelled": True, "reason": error}
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
        skipped = bool(output.get("skipped")) or str(output.get("status") or "") == "skipped"
        if isinstance(output.get("_meta"), Mapping):
            output = dict(output)
            output.pop("_meta", None)
        if status == "ok" and str(output.get("status") or "") == "skipped":
            status = "skipped"
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
    """ModelUnavailable：声明了 fallback 就执行它；没声明就离线重跑节点本身（处理器在无模型时的
    分支就是确定性实现）。两条路都在 _offline(ctx) 里——fallback 绝不碰模型。

    1.0.0 只有 3/32 个 fallback 自己关了模型通路（review-quiz-generate 的 cloze-template 又去调
    模型而失败）；没声明 fallback 的节点直接返回空产物。
    """
    node_id = str(node.get("id") or "")
    name = str((template.get("fallbacks") or {}).get(node_id) or "").strip()
    handler = resolve_handler(FALLBACK_PREFIX + name) if name else None
    role = str(getattr(exc, "role", node.get("kind")) or node.get("kind"))
    kind = "fallback" if handler is not None else "offline-rerun"
    if handler is None:
        handler = _handler_for(node)
    ctx.step_meta["attempts"].append({
        "kind": kind, "name": name or None, "available": True, "reason": str(exc)[:200]})
    ctx.mark_degraded(role, str(exc)[:200])
    try:
        with _offline(ctx):
            result = handler(ctx, dict(node))
    except WorkflowRunCancelled:
        raise
    except Exception as exc2:
        if _unavailable(exc2):
            reason = "模型不可用且离线实现同样需要模型：%s" % str(exc2)[:200]
            return ("degraded",
                    {"degraded": True, "reason": reason, "values": [], "items": [], "hits": []},
                    None, True)
        err = "模型不可用且%s失败：%s / %s" % ("fallback " + name if name else "离线重跑",
                                            type(exc).__name__, type(exc2).__name__)
        return "failed", {"fallback": name or None, "error": err,
                          "detail": str(exc2)[:300]}, err, True
    output = dict(result) if isinstance(result, dict) else {"value": result}
    if name:
        output.setdefault("fallback", name)
    output["offline"] = True
    output.setdefault("fallback_reason", str(exc)[:200])
    output["degraded"] = True
    return "degraded", output, None, True


# ============================================================
# 15. 对外接口
# ============================================================
TERMINAL_STATUSES: tuple[str, ...] = ("ok", "partial", "failed", "cancelled")
LIVE_STATUSES: tuple[str, ...] = ("queued", "running")
CANCEL_WAIT_S = 2.0            # cancel_run 最多等执行器收尾的秒数
RUN_POOL_SIZE = 2              # 异步运行池线程数（有界：多出来的运行排队，status=queued）
INTERRUPTED_ERROR = "interrupted: the server stopped before this run finished（服务在运行结束前停止）"
_BOOT_ID = uuid.uuid4().hex[:12]
_REGISTRY_LOCK = threading.RLock()
_ACTIVE: dict[str, "_RunHandle"] = {}
_POOL: ThreadPoolExecutor | None = None


def _db_key(path: Any) -> str:
    return os.path.normcase(os.path.abspath(str(path or "")))


class _RunHandle:
    """本进程里正在执行（或排队）的一次运行：取消事件 + 收尾事件。"""

    __slots__ = ("run_id", "db", "event", "done", "reason")

    def __init__(self, run_id: str, db: str) -> None:
        self.run_id = run_id
        self.db = db
        self.event = threading.Event()
        self.done = threading.Event()
        self.reason = ""


def _register(run_id: str, store) -> _RunHandle:
    handle = _RunHandle(run_id, _db_key(getattr(store, "db_path", "")))
    with _REGISTRY_LOCK:
        _ACTIVE[run_id] = handle
    return handle


def _unregister(handle: _RunHandle) -> None:
    with _REGISTRY_LOCK:
        if _ACTIVE.get(handle.run_id) is handle:
            _ACTIVE.pop(handle.run_id, None)
    handle.done.set()


def _active_handle(run_id: str) -> _RunHandle | None:
    with _REGISTRY_LOCK:
        return _ACTIVE.get(str(run_id))


class _CancelToken:
    """协作式取消令牌：进程内事件（即时）+ 调用方 cancel 回调 + DB 标记（跨进程，节流轮询）。

    执行器在层边界、节点开跑前检查；长循环的节点经 ctx.check_cancel() 检查。DB 轮询用令牌
    自己的连接（加锁），并行层的工作线程也能安全调用。
    """

    POLL_S = 0.25

    def __init__(self, store, run_id: str, handle: _RunHandle, external: Any = None) -> None:
        self.run_id = run_id
        self.handle = handle
        self.external = external
        self.db_path = getattr(store, "db_path", None)
        self._lock = threading.Lock()
        self._last = 0.0
        self._con = None

    def __call__(self, _run_id: str | None = None) -> bool:
        if self.handle.event.is_set():
            return True
        if callable(self.external):
            try:
                if self.external(self.run_id):
                    self._trip("caller")
                    return True
            except Exception:
                pass
        if self.db_path is None:
            return False
        with self._lock:
            moment = time.monotonic()
            if moment - self._last < self.POLL_S:
                return False
            self._last = moment
            try:
                if self._con is None:
                    self._con = dbmod.connect(self.db_path)
                flagged, reason = _read_cancel_flag(self._con, self.run_id)
            except sqlite3.Error:
                return False
        if flagged:
            self._trip(reason or "api")
        return flagged

    def _trip(self, reason: str) -> None:
        if not self.handle.reason:
            self.handle.reason = reason
        self.handle.event.set()

    def close(self) -> None:
        with self._lock:
            if self._con is not None:
                try:
                    self._con.close()
                except sqlite3.Error:  # pragma: no cover
                    pass
                self._con = None


def _check_mode(mode: Any) -> str:
    value = str(mode or "fail").strip().lower()
    if value not in RUN_MODES:
        raise ValueError("未知运行模式：%s（可选 %s）" % (value, "/".join(RUN_MODES)))
    return value


def _prepare_run(store, template_id: str, inputs: Any, scope: str, trigger: str,
                 parent_run_id: str | None, status: str) -> dict:
    """解析模板、分层、插入 workflow_run 行（status=running 或 queued）。"""
    template = _load_template(store, str(template_id or ""))
    spec = _template_spec(template)
    nodes = _node_map(spec.get("nodes") or [])
    if not nodes:
        raise WorkflowError("模板没有可执行节点：%s" % template_id)
    parents = _parent_map(spec.get("edges") or [], nodes)
    order = _level_order(nodes, parents)
    ordinals: dict[str, int] = {}
    for layer in order:
        for nid in layer:
            ordinals[nid] = len(ordinals)
    run_inputs = _normalize_inputs(inputs)
    run_id = _new_id("run")
    stamp = iso_now()
    tpl_id = str(template.get("id") or template_id)
    tpl_name = str(template.get("name") or tpl_id)
    meta = {"degraded": [], "steps_total": len(nodes),
            "owner": {"pid": os.getpid(), "boot": _BOOT_ID}}
    with store._txn() as con:
        con.execute(
            "INSERT INTO workflow_run(id, template_id, template_name, scope_id, trigger, status, "
            "input, output, error, parent_run_id, created_at, started_at, finished_at, metadata) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (run_id, tpl_id, tpl_name, scope, trigger, status, dumps(run_inputs), "{}", None,
             parent_run_id, stamp, stamp if status == "running" else None, None, dumps(meta)),
        )
        store.audit("workflow.run.start" if status == "running" else "workflow.run.queued",
                    run_id, actor="workflow",
                    detail={"template": tpl_id, "scope": scope, "trigger": trigger})
    return {"run_id": run_id, "template": template, "spec": spec, "nodes": nodes,
            "parents": parents, "order": order, "ordinals": ordinals, "inputs": run_inputs,
            "scope": scope, "trigger": trigger, "tpl_id": tpl_id, "tpl_name": tpl_name,
            "fallbacks": dict(spec.get("fallbacks") or {})}


def run_workflow(store, gw, template_id: str, inputs: dict, scope: str = "global",
                 trigger: str = "manual", parent_run_id: str | None = None,
                 emitter: Any = None, cancel: Any = None,
                 max_workers: int = MAX_WORKERS, mode: str = "fail") -> dict:
    """同步执行一条工作流，返回冻结格式的 run dict（另带 events_published）。

    语义：
      1. 拓扑分层，同层并行（ThreadPoolExecutor，上限 4）；
      2. 节点只读祖先链产物（兄弟分支不可见，最近的祖先优先）；
      3. 边 when：always / on_success / on_degraded / on_failure / if:<key>（只看源节点谱系）；
      4. 节点抛非 ModelUnavailable → failed，下游 skipped，run failed（on_failure 分支照跑）；
      5. ModelUnavailable → 离线执行声明的 fallback（没声明就离线重跑节点），run partial；
      6. 全部输入与步骤输出落库；每一步经事件总线发 run 事件（phase=start/step/end）；
      7. 协作式取消：cancel_run 记下请求，执行器在节点边界收尾为 cancelled（CAS 终态写）。

    mode："fail"（默认）节点失败即整体失败；"skip" 只跳过失败节点的下游，其余分支继续，run=partial。
    """
    if store is None:
        raise WorkflowError("run_workflow 需要 store")
    checked = _check_mode(mode)
    plan = _prepare_run(store, template_id, inputs, scope, trigger, parent_run_id, "running")
    return _execute_run(store, gw, plan, emitter=emitter, cancel=cancel,
                        max_workers=max_workers, mode=checked)


def _run_pool() -> ThreadPoolExecutor:
    global _POOL
    with _REGISTRY_LOCK:
        if _POOL is None:
            _POOL = ThreadPoolExecutor(max_workers=RUN_POOL_SIZE, thread_name_prefix="memora-run")
        return _POOL


def start_workflow(store, gw, template_id: str, inputs: dict, scope: str = "global",
                   trigger: str = "manual", parent_run_id: str | None = None,
                   emitter: Any = None, max_workers: int = MAX_WORKERS,
                   mode: str = "fail") -> dict:
    """异步执行：插入 status=queued 的运行行，交给有界运行池（RUN_POOL_SIZE 个线程），**立即**
    返回 run（queued，或池子已经接手时是 running）。进度：事件总线 run 事件
    （phase=queued/start/step/end）与 GET /api/runs/{id}（逐步落库，正在跑的步 status=running）。
    """
    if store is None:
        raise WorkflowError("start_workflow 需要 store")
    checked = _check_mode(mode)
    plan = _prepare_run(store, template_id, inputs, scope, trigger, parent_run_id, "queued")
    run_id = plan["run_id"]
    handle = _register(run_id, store)
    RunEmitter(store, emitter, run_id).send("run", {
        "phase": "queued", "template_id": plan["tpl_id"], "template_name": plan["tpl_name"],
        "status": "queued", "scope": scope,
        "progress": {"done": 0, "total": len(plan["nodes"])}})
    try:
        _run_pool().submit(_pool_entry, store, gw, plan, emitter, max_workers, checked, handle)
    except RuntimeError as exc:
        _unregister(handle)
        _finalize_run(store, run_id, status="failed", output={}, error="运行池不可用：%s" % exc,
                      finished=iso_now(), expect=("queued",))
        raise WorkflowError("运行池不可用：%s" % exc) from exc
    return get_run(store, run_id) or {"id": run_id, "status": "queued", "steps": []}


def _pool_entry(store, gw, plan: dict, emitter: Any, max_workers: int, mode: str,
                handle: _RunHandle) -> None:
    """运行池线程入口：queued → running（CAS；排队时已被取消的不再执行），然后执行。"""
    run_id = plan["run_id"]
    try:
        stamp = iso_now()
        with store._txn() as con:
            cur = con.execute("UPDATE workflow_run SET status = 'running', started_at = ? "
                              "WHERE id = ? AND status = 'queued'", (stamp, run_id))
            started = cur.rowcount == 1
            if started:
                store.audit("workflow.run.start", run_id, actor="workflow",
                            detail={"template": plan["tpl_id"], "async": True})
        if started:
            _execute_run(store, gw, plan, emitter=emitter, max_workers=max_workers, mode=mode,
                         handle=handle)
    except Exception as exc:  # 执行器自身崩溃：落 failed，绝不留 running
        _finalize_run(store, run_id, status="failed", output={},
                      error="执行器异常：%s: %s" % (type(exc).__name__, str(exc)[:300]),
                      finished=iso_now(), expect=LIVE_STATUSES)
    finally:
        _unregister(handle)


def _execute_run(store, gw, plan: dict, *, emitter: Any = None, cancel: Any = None,
                 max_workers: int = MAX_WORKERS, mode: str = "fail",
                 handle: _RunHandle | None = None) -> dict:
    """执行一条已插入（status=running）的运行，收尾为终态（CAS）并返回 run dict。"""
    run_id, nodes, parents = plan["run_id"], plan["nodes"], plan["parents"]
    ordinals, template, fallbacks = plan["ordinals"], plan["template"], plan["fallbacks"]
    run_inputs, scope, tpl_id, tpl_name = plan["inputs"], plan["scope"], plan["tpl_id"], plan["tpl_name"]
    own_handle = handle is None
    if handle is None:
        handle = _register(run_id, store)
    token = _CancelToken(store, run_id, handle, cancel)
    sink = RunEmitter(store, emitter, run_id)
    gw_eff = _effective_gateway(gw)
    total = len(nodes)
    artifacts: dict[str, Any] = {}
    statuses: dict[str, str] = {}
    degraded_map: dict[str, bool] = {}
    steps: list[dict] = []
    all_degraded: list[str] = []
    run_status = "ok"
    run_error: str | None = None
    cancelled = False

    def step_event(nid: str, record: Mapping[str, Any]) -> None:
        node = nodes[nid]
        sink.send("run", {
            "phase": "step", "template_id": tpl_id, "status": "running",
            "step": {"node_id": nid, "name": node.get("name") or nid, "kind": node.get("kind"),
                     "status": record.get("status"), "ordinal": ordinals.get(nid, 0),
                     "ms": record.get("ms"), "degraded": bool(record.get("degraded")),
                     "error": record.get("error")},
            "progress": {"done": len(statuses), "total": total}})

    def skip(nid: str, status: str, reason: str) -> None:
        record = _record_skip(store, run_id, nodes[nid], tpl_id=tpl_id, tpl_name=tpl_name,
                              template=template, fallbacks=fallbacks, inputs=run_inputs,
                              scope=scope, gw=gw_eff, emitter=sink, ordinal=ordinals[nid],
                              status=status, reason=reason)
        artifacts[nid] = record["output"]
        statuses[nid] = status
        degraded_map[nid] = False
        steps.append(record)
        step_event(nid, record)

    def run_one(target_store, nid: str) -> dict:
        return _execute_node(
            target_store, gw_eff, template, nodes[nid], run_id=run_id, inputs=run_inputs,
            scope=scope, visible=_visible_snapshot(artifacts, nid, parents, nodes),
            ordinal=ordinals[nid], cancel=token, emitter=sink, fallbacks=fallbacks,
            tpl_id=tpl_id, tpl_name=tpl_name)

    sink.send("run", {"phase": "start", "template_id": tpl_id, "template_name": tpl_name,
                      "status": "running", "scope": scope, "models": gw_eff is not None,
                      "progress": {"done": 0, "total": total}})
    try:
        for layer in plan["order"]:
            if token():
                cancelled = True
                break
            runnable: list[str] = []
            for nid in layer:
                if nid in statuses:
                    continue  # 已被失败传播处理过
                ok, reason = _edge_decision(nid, parents, artifacts, statuses, degraded_map, nodes)
                if ok:
                    runnable.append(nid)
                else:
                    skip(nid, "skipped", reason)
            if not runnable:
                continue
            for nid in runnable:
                step_event(nid, {"status": "running"})
            results: dict[str, dict] = {}
            if len(runnable) == 1 or max_workers <= 1:
                for nid in runnable:
                    if token():
                        cancelled = True
                        break
                    results[nid] = run_one(store, nid)
            else:
                workers = min(MAX_WORKERS, max_workers, len(runnable))
                with ThreadPoolExecutor(max_workers=workers) as pool:
                    futures = {}
                    for nid in runnable:
                        thread_store = _thread_store(store)
                        futures[pool.submit(run_one, thread_store, nid)] = (nid, thread_store)
                    for future, (nid, thread_store) in futures.items():
                        try:
                            results[nid] = future.result()
                        except Exception as exc:  # 线程内兜底
                            results[nid] = {"node_id": nid, "status": "failed", "output": {},
                                            "degraded": False, "skipped": False, "ms": 0,
                                            "error": "%s: %s" % (type(exc).__name__, exc),
                                            "degraded_list": []}
                        finally:
                            _close_store(thread_store, store)
            failed_now: list[str] = []
            for nid in runnable:
                result = results.get(nid)
                if result is None:
                    continue  # 取消：没开始的节点在收尾时统一记 cancelled
                artifacts[nid] = result.get("output") or {}
                statuses[nid] = str(result.get("status") or "failed")
                degraded_map[nid] = bool(result.get("degraded"))
                for name in result.get("degraded_list") or []:
                    if name not in all_degraded:
                        all_degraded.append(str(name))
                steps.append(result)
                step_event(nid, result)
                if statuses[nid] == "failed":
                    failed_now.append(nid)
                    run_error = result.get("error") or run_error
                elif statuses[nid] == "cancelled":
                    cancelled = True
            if failed_now:
                handlers = _failure_handlers(failed_now, parents)
                for nid in _downstream_of(failed_now, parents, protect=handlers):
                    if nid not in statuses:
                        skip(nid, "skipped", "上游失败：%s" % ", ".join(sorted(failed_now)))
                if mode == "fail":
                    run_status = "failed"
                    # 只剩失败处理分支（on_failure 边可达）继续跑；其余未执行节点 skipped
                    for nid in sorted(nodes, key=lambda n: ordinals.get(n, 0)):
                        if nid not in statuses and nid not in handlers:
                            skip(nid, "skipped", "运行已失败（mode=fail）：%s"
                                 % ", ".join(sorted(failed_now)))
                else:
                    if run_status != "failed":
                        run_status = "partial"
                    run_error = run_error or "节点失败（mode=skip）：%s" % ", ".join(failed_now)
            if cancelled:
                break
    except Exception as exc:
        run_status = "failed"
        run_error = "%s: %s" % (type(exc).__name__, str(exc)[:400])
        try:
            store.audit("workflow.run.error", run_id, actor="workflow", detail={"error": run_error})
        except Exception:  # pragma: no cover
            pass

    pending = [nid for nid in nodes if nid not in statuses]
    if not cancelled and pending and token():
        cancelled = True
    meta: dict[str, Any] = {"step_count": total, "models": "gateway" if gw_eff is not None else "none"}
    if cancelled:
        run_status = "cancelled"
        run_error = "运行被取消（%s）" % (handle.reason or "api")
        for nid in sorted(pending, key=lambda n: ordinals.get(n, 0)):
            if nid not in statuses:
                skip(nid, "cancelled", run_error)
    elif handle.event.is_set():
        meta["cancel_ignored"] = "取消请求到达时所有节点已执行完，按实际结果收尾"
    if run_status == "ok" and all_degraded:
        run_status = "partial"
    steps.sort(key=lambda s: ordinals.get(str(s.get("node_id")), 0))
    output = _run_output(steps)
    landed = _finalize_run(store, run_id, status=run_status, output=output,
                           error=None if run_status in ("ok", "partial") else run_error,
                           finished=iso_now(), degraded=all_degraded, meta=meta)
    try:
        store.audit("workflow.run.end" if landed else "workflow.run.finalize_conflict", run_id,
                    actor="workflow", detail={"status": run_status, "steps": len(steps),
                                              "degraded": all_degraded, "error": run_error})
    except Exception:  # pragma: no cover
        pass
    final = get_run(store, run_id) or {"id": run_id, "status": run_status, "steps": steps}
    sink.send("run", {"phase": "end", "template_id": tpl_id, "template_name": tpl_name,
                      "status": final.get("status"), "error": final.get("error"),
                      "degraded": final.get("degraded"),
                      "progress": {"done": len(statuses), "total": total}})
    token.close()
    if own_handle:
        _unregister(handle)
    else:
        handle.done.set()
    final["events_published"] = sink.count
    return final


def _failure_handlers(failed: Iterable[str], parents: Mapping[str, list[dict]]) -> set[str]:
    """失败处理分支：从失败节点经 on_failure 边直达的节点及其全部下游。"""
    failed_set = set(failed)
    roots = {dst for dst, edges in parents.items() for edge in edges
             if edge["from"] in failed_set and _when_kind(edge.get("when")) == "on_failure"}
    out = set(roots)
    frontier = list(roots)
    while frontier:
        current = frontier.pop()
        for dst, edges in parents.items():
            if dst not in out and any(edge["from"] == current for edge in edges):
                out.add(dst)
                frontier.append(dst)
    return out


def _downstream_of(failed: Iterable[str], parents: Mapping[str, list[dict]],
                   protect: set[str] | frozenset = frozenset()) -> list[str]:
    """失败传播范围：沿非 on_failure 边可达的下游（不进入失败处理分支 protect）。"""
    failed_set = set(failed)
    seen: set[str] = set()
    frontier = list(failed_set)
    while frontier:
        current = frontier.pop()
        for dst, edges in parents.items():
            if dst in seen or dst in failed_set or dst in protect:
                continue
            if any(edge["from"] == current and _when_kind(edge.get("when")) != "on_failure"
                   for edge in edges):
                seen.add(dst)
                frontier.append(dst)
    return sorted(seen)


def cancel_run(store, run_id: str, wait: float = CANCEL_WAIT_S, reason: str = "api") -> dict:
    """请求取消一次运行。

      * 不存在 → WorkflowNotFound；已结束 → WorkflowConflict（HTTP 409 RUN_FINISHED）。
      * 先把请求记进 metadata（cancel_requested / _at / _reason；只对 queued/running 生效的 CAS
        写，不会覆盖一个刚结束的运行）。状态**不**在这里改成 cancelled——由执行器收尾。
      * 本进程排队中 → 直接收尾为 cancelled；本进程执行中 → 置取消事件，最多等 wait 秒
        （≤ CANCEL_WAIT_S）让执行器在节点边界收尾；还没收尾就返回当前状态（cancel_requested=true）。
      * 不在本进程：执行它的进程还活着 → 只留标记（对方执行器轮询到后收尾）；
        进程已不在（孤儿运行）→ 直接收尾为 cancelled。
      * 等待期间运行先跑完（ok/partial/failed）→ WorkflowConflict：取消没有生效。
    """
    rid = str(run_id)
    row = store.con.execute("SELECT status FROM workflow_run WHERE id = ?", (rid,)).fetchone()
    if row is None:
        raise WorkflowNotFound("运行不存在：%s" % rid)
    previous = str(row["status"])
    if previous in TERMINAL_STATUSES:
        raise WorkflowConflict("运行已结束（%s），无法取消：%s" % (previous, rid))
    stamp = iso_now()
    meta: dict = {}
    recorded = False
    with store._txn() as con:
        current = con.execute("SELECT status, metadata FROM workflow_run WHERE id = ?",
                              (rid,)).fetchone()
        if current is not None and str(current["status"]) in LIVE_STATUSES:
            previous = str(current["status"])
            meta = loads(current["metadata"], {}) or {}
            meta = meta if isinstance(meta, dict) else {}
            meta.update({"cancel_requested": True, "cancel_requested_at": stamp,
                         "cancel_reason": reason or "api"})
            cur = con.execute("UPDATE workflow_run SET metadata = ? WHERE id = ? AND status IN "
                              "('queued', 'running')", (dumps(meta), rid))
            recorded = cur.rowcount == 1
    if not recorded:
        now_row = store.con.execute("SELECT status FROM workflow_run WHERE id = ?", (rid,)).fetchone()
        raise WorkflowConflict("运行已结束（%s），无法取消：%s"
                               % (now_row["status"] if now_row else "?", rid))
    store.audit("workflow.cancel", rid, actor="workflow",
                detail={"previous": previous, "reason": reason})
    RunEmitter(store, None, rid).send("run", {"phase": "cancel_requested", "status": previous,
                                              "reason": reason})
    handle = _active_handle(rid)
    if handle is not None:
        if not handle.reason:
            handle.reason = reason or "api"
        handle.event.set()
        if not (previous == "queued" and _finalize_unstarted(store, rid, ("queued",),
                                                             "运行在排队时被取消")):
            handle.done.wait(max(0.0, min(float(wait or 0.0), CANCEL_WAIT_S)))
    elif _owner_alive(meta) is not True:
        _finalize_unstarted(store, rid, LIVE_STATUSES,
                            "运行被取消（执行它的进程已不在：孤儿运行，直接收尾）")
    run = get_run(store, rid) or {"id": rid, "status": "cancelled", "steps": []}
    if run.get("status") in ("ok", "partial", "failed"):
        raise WorkflowConflict("取消未生效：运行在取消生效前已结束（%s）：%s"
                               % (run.get("status"), rid))
    return run


def _finalize_unstarted(store, run_id: str, expect: Iterable[str], reason: str) -> bool:
    """不经执行器直接把运行收尾为 cancelled（排队中 / 孤儿）；没跑的节点补 cancelled 步。"""
    stamp = iso_now()
    landed = _finalize_run(store, run_id, status="cancelled", output={}, error=reason,
                           finished=stamp, meta={"cancelled_at": stamp}, expect=expect)
    if not landed:
        return False
    with store._txn() as con:
        con.execute("UPDATE workflow_step SET status = 'cancelled', error = ?, finished_at = ? "
                    "WHERE run_id = ? AND status IN ('running', 'pending')",
                    (reason, stamp, run_id))
    _fill_missing_steps(store, run_id, "cancelled", reason)
    RunEmitter(store, None, run_id).send("run", {"phase": "end", "status": "cancelled",
                                                 "error": reason})
    return True


def _fill_missing_steps(store, run_id: str, status: str, reason: str) -> None:
    """给还没有 workflow_step 行的节点补一行（时间线完整：每个节点都有记录）。"""
    row = store.con.execute("SELECT template_id FROM workflow_run WHERE id = ?",
                            (run_id,)).fetchone()
    template = get_template(store, str(row["template_id"])) if row is not None else None
    if not template:
        return
    nodes = _node_map(_template_spec(template).get("nodes") or [])
    parents = _parent_map(_template_spec(template).get("edges") or [], nodes)
    ordinals: dict[str, int] = {}
    for layer in _level_order(nodes, parents):
        for nid in layer:
            ordinals[nid] = len(ordinals)
    present = {str(r["node_id"]) for r in store.con.execute(
        "SELECT node_id FROM workflow_step WHERE run_id = ?", (run_id,)).fetchall()}
    for nid, node in nodes.items():
        if nid in present:
            continue
        ctx = WorkflowContext(store=store, run_id=run_id, node_id=nid, node=dict(node),
                              params=dict(node.get("params") or {}))
        ctx.step_meta.update({"attempts": [{"kind": status, "reason": reason}],
                              "metrics": {"ms": 0}})
        _persist_step(store, run_id, ctx, ordinals.get(nid, 0), status=status,
                      output=_skip_artifacts(ctx, status, reason), error=reason,
                      started=iso_now(), finished=iso_now(), input_payload={})


def _pid_alive(pid: int) -> bool:
    """进程是否还在（Windows 用 OpenProcess/GetExitCodeProcess；POSIX 用 signal 0）。"""
    if pid <= 0:
        return False
    if pid == os.getpid():
        return True
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes

        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
        kernel.GetExitCodeProcess.argtypes = (wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD))
        kernel.CloseHandle.argtypes = (wintypes.HANDLE,)
        proc = kernel.OpenProcess(0x1000, False, int(pid))  # PROCESS_QUERY_LIMITED_INFORMATION
        if not proc:
            return ctypes.get_last_error() == 5  # 拒绝访问 = 进程存在
        try:
            code = wintypes.DWORD()
            if not kernel.GetExitCodeProcess(proc, ctypes.byref(code)):
                return True
            return code.value == 259  # STILL_ACTIVE
        finally:
            kernel.CloseHandle(proc)
    try:
        os.kill(int(pid), 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def _owner_alive(meta: Mapping[str, Any] | None) -> bool | None:
    """执行该运行（或领取该任务）的进程是否还活着：True / False / None（没有记录，未知）。

    本进程（同一 boot id）的运行不在 _ACTIVE 里就是孤儿 → False；同 pid 不同 boot id
    （模块被重新加载过）保守地视为活着。
    """
    owner = meta.get("owner") if isinstance(meta, Mapping) else None
    if not isinstance(owner, Mapping):
        return None
    if owner.get("boot") == _BOOT_ID:
        return False
    pid = _as_int(owner.get("pid"), 0)
    if pid <= 0:
        return None
    return True if pid == os.getpid() else _pid_alive(pid)


def reap_interrupted(store) -> dict:
    """启动回收（start_background 调用）：执行者已不在的 queued/running 运行 → failed，
    error=INTERRUPTED_ERROR，它们 running 的步也标 failed；running 的 job → 还有次数就退回
    queued，否则 failed。执行者进程还活着的（例如同库的 MCP stdio 进程正在跑）不动。"""
    reaped: list[str] = []
    rows = store.con.execute("SELECT id, metadata FROM workflow_run "
                             "WHERE status IN ('queued', 'running')").fetchall()
    for row in rows:
        rid = str(row["id"])
        if _active_handle(rid) is not None:
            continue
        meta = loads(row["metadata"], {}) or {}
        if _owner_alive(meta if isinstance(meta, dict) else {}) is True:
            continue
        stamp = iso_now()
        if not _finalize_run(store, rid, status="failed", output={}, error=INTERRUPTED_ERROR,
                             finished=stamp, meta={"reaped_at": stamp}, expect=LIVE_STATUSES):
            continue
        with store._txn() as con:
            con.execute("UPDATE workflow_step SET status = 'failed', error = ?, finished_at = ? "
                        "WHERE run_id = ? AND status IN ('running', 'pending')",
                        (INTERRUPTED_ERROR, stamp, rid))
            store.audit("workflow.run.reaped", rid, actor="workflow",
                        detail={"error": INTERRUPTED_ERROR})
        RunEmitter(store, None, rid).send("run", {"phase": "end", "status": "failed",
                                                  "error": INTERRUPTED_ERROR})
        reaped.append(rid)
    return {"runs": reaped, "jobs": _reap_jobs(store)}


def _reap_jobs(store) -> dict:
    requeued: list[str] = []
    failed: list[str] = []
    rows = store.con.execute("SELECT * FROM job WHERE status = 'running'").fetchall()
    for row in rows:
        payload = loads(row["payload"], {}) or {}
        payload = payload if isinstance(payload, dict) else {}
        if _job_in_progress(str(row["id"])):
            continue
        if _owner_alive({"owner": payload.get("claimed_by")}) is True:
            continue
        payload.pop("claimed_by", None)
        stamp = iso_now()
        again = _as_int(row["attempts"], 0) < max(1, _as_int(row["max_attempts"], JOB_MAX_ATTEMPTS))
        with store._txn() as con:
            con.execute("UPDATE job SET status = ?, last_error = ?, payload = ?, run_after = ?, "
                        "updated_at = ? WHERE id = ? AND status = 'running'",
                        ("queued" if again else "failed", INTERRUPTED_ERROR, dumps(payload),
                         stamp if again else row["run_after"], stamp, row["id"]))
            store.audit("job.reaped", str(row["id"]), actor="jobs",
                        detail={"requeued": again, "error": INTERRUPTED_ERROR})
        (requeued if again else failed).append(str(row["id"]))
    return {"requeued": requeued, "failed": failed}


# ============================================================
# 16. job 消费者（服务进程里的后台线程）
# ============================================================
JOB_POLL_S = 1.0               # 没有到期任务时的轮询间隔
JOB_BACKOFF_S = 30             # 失败重试的基础退避（30 s、60 s、120 s …）
JOB_BACKOFF_MAX_S = 3600
_WORKERS: dict[str, "_JobWorker"] = {}


def claim_job(store, now: str | None = None) -> dict | None:
    """原子领取一个到期任务：BEGIN IMMEDIATE 里选出最早到期的 queued 行，再
    UPDATE ... WHERE id=? AND status='queued'（跨进程也只有一个领取者成功）；attempts+1。"""
    stamp = now or iso_now()
    with store._txn() as con:
        row = con.execute(
            "SELECT * FROM job WHERE status = 'queued' AND (run_after IS NULL OR run_after <= ?) "
            "ORDER BY coalesce(run_after, created_at), created_at LIMIT 1", (stamp,)).fetchone()
        if row is None:
            return None
        payload = loads(row["payload"], {}) or {}
        payload = payload if isinstance(payload, dict) else {}
        payload["claimed_by"] = {"pid": os.getpid(), "boot": _BOOT_ID, "at": stamp}
        cur = con.execute("UPDATE job SET status = 'running', attempts = attempts + 1, "
                          "payload = ?, updated_at = ? WHERE id = ? AND status = 'queued'",
                          (dumps(payload), stamp, row["id"]))
        if cur.rowcount != 1:
            return None
    job = dict(row)
    job.update({"status": "running", "attempts": _as_int(row["attempts"], 0) + 1,
                "payload": payload})
    return job


def process_job(store, job: Mapping[str, Any], gw: Any = None) -> dict:
    """执行一个已领取的任务。目标模板 = payload.target_template，或（1.0.0 的旧行）kind 本身。

    run ok/partial → job ok；cancelled → cancelled；failed / 异常 → 还有次数就按指数退避重排
    （run_after 推后），否则 failed（last_error 写原因）。没有目标模板 → 直接 failed，不重试。
    """
    job_id = str(job.get("id"))
    payload = _as_dict(job.get("payload"))
    kind = str(job.get("kind") or "")
    attempts = max(1, _as_int(job.get("attempts"), 1))
    retry_left = attempts < max(1, _as_int(job.get("max_attempts"), JOB_MAX_ATTEMPTS))
    target = str(payload.get("target_template") or "").strip()
    if not target and kind and kind != "workflow" and get_template(store, kind) is not None:
        target = kind
    if not target:
        return _finish_job(store, job_id, payload, "failed",
                           "任务类型 %s 没有可执行的目标模板（例如 1.0.0 入队的 SM-2 计划）" % kind)
    source = _as_dict(payload.get("source"))
    try:
        run = run_workflow(store, gw, target, _as_dict(payload.get("inputs")),
                           scope=str(payload.get("scope") or "global"), trigger="job",
                           parent_run_id=source.get("run_id") or payload.get("run_id"))
    except WorkflowNotFound as exc:
        return _finish_job(store, job_id, payload, "failed", str(exc))
    except Exception as exc:
        return _finish_job(store, job_id, payload, "retry" if retry_left else "failed",
                           "%s: %s" % (type(exc).__name__, str(exc)[:300]), attempts=attempts)
    payload["last_run_id"] = run.get("id")
    payload["last_run_status"] = run.get("status")
    status = str(run.get("status") or "")
    if status in ("ok", "partial"):
        return _finish_job(store, job_id, payload, "ok", None)
    if status == "cancelled":
        return _finish_job(store, job_id, payload, "cancelled", run.get("error") or "运行被取消")
    return _finish_job(store, job_id, payload, "retry" if retry_left else "failed",
                       run.get("error") or "运行失败（%s）" % status, attempts=attempts)


def _finish_job(store, job_id: str, payload: dict, outcome: str, error: str | None,
                attempts: int = 1) -> dict:
    stamp = iso_now()
    run_after = None
    status = outcome
    if outcome == "retry":
        delay = min(JOB_BACKOFF_MAX_S, JOB_BACKOFF_S * (2 ** max(0, attempts - 1)))
        run_after = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + delay))
        status = "queued"
    payload.pop("claimed_by", None)
    with store._txn() as con:
        if run_after:
            con.execute("UPDATE job SET status = ?, last_error = ?, run_after = ?, payload = ?, "
                        "updated_at = ? WHERE id = ? AND status = 'running'",
                        (status, error, run_after, dumps(payload), stamp, job_id))
        else:
            con.execute("UPDATE job SET status = ?, last_error = ?, payload = ?, updated_at = ? "
                        "WHERE id = ? AND status = 'running'",
                        (status, error, dumps(payload), stamp, job_id))
        store.audit("job.retry_scheduled" if outcome == "retry" else "job.%s" % outcome, job_id,
                    actor="jobs", detail={"error": error, "run_id": payload.get("last_run_id"),
                                          "run_after": run_after})
    RunEmitter(store, None, "").send("log", {"action": "job", "job_id": job_id,
                                             "status": status, "error": error,
                                             "run_id": payload.get("last_run_id")})
    return {"id": job_id, "status": status, "error": error, "run_after": run_after,
            "run_id": payload.get("last_run_id")}


def retry_job(store, job_id: str) -> dict:
    """手动重试：非 running 的任务重新排队（attempts 归零、立即到期）；running → 冲突。
    只写**一条** job.retry 审计（1.0.0 的路由写了两条）。"""
    row = store.con.execute("SELECT status FROM job WHERE id = ?", (str(job_id),)).fetchone()
    if row is None:
        raise WorkflowNotFound("任务不存在：%s" % job_id)
    previous = str(row["status"])
    if previous == "running":
        raise WorkflowConflict("任务正在执行，不能重试：%s" % job_id)
    stamp = iso_now()
    with store._txn() as con:
        cur = con.execute("UPDATE job SET status = 'queued', run_after = ?, last_error = NULL, "
                          "attempts = 0, updated_at = ? WHERE id = ? AND status != 'running'",
                          (stamp, stamp, str(job_id)))
        if cur.rowcount != 1:
            raise WorkflowConflict("任务正在执行，不能重试：%s" % job_id)
        store.audit("job.retry", str(job_id), actor="api", detail={"previous": previous})
    return {"ok": True, "job_id": str(job_id), "status": "queued", "requeued_at": stamp,
            "previous": previous}


class _JobWorker:
    """一个库一个消费者线程（守护线程）：领取到期任务 → process_job → 再领取；没有就等 poll 秒。"""

    def __init__(self, store, gw_factory: Callable[[], Any] | None, poll: float = JOB_POLL_S):
        self.store = store
        self.gw_factory = gw_factory
        self.poll = float(poll)
        self.stop_event = threading.Event()
        self.processed = 0
        self.failed = 0
        self.current: str | None = None
        self.last_error: str | None = None
        self.started_at = iso_now()
        self.thread = threading.Thread(target=self._loop, name="memora-jobs", daemon=True)

    def _gateway(self) -> Any:
        if self.gw_factory is None:
            return None
        try:
            return self.gw_factory()
        except Exception:
            return None

    def _loop(self) -> None:
        while not self.stop_event.is_set():
            try:
                job = claim_job(self.store)
            except Exception as exc:
                self.last_error = "%s: %s" % (type(exc).__name__, str(exc)[:200])
                job = None
            if job is None:
                self.stop_event.wait(self.poll)
                continue
            self.current = str(job["id"])
            try:
                if process_job(self.store, job, gw=self._gateway()).get("status") == "failed":
                    self.failed += 1
            except Exception as exc:
                self.last_error = "%s: %s" % (type(exc).__name__, str(exc)[:200])
            finally:
                self.processed += 1
                self.current = None

    def status(self) -> dict:
        return {"running": self.thread.is_alive(), "processed": self.processed,
                "failed": self.failed, "current": self.current, "last_error": self.last_error,
                "poll_s": self.poll, "started_at": self.started_at}


def _job_in_progress(job_id: str) -> bool:
    with _REGISTRY_LOCK:
        return any(worker.current == job_id for worker in _WORKERS.values())


def _default_gateway_factory(store) -> Callable[[], Any]:
    def factory() -> Any:
        try:
            from .models import ModelGateway
        except ImportError:  # pragma: no cover
            return None
        return ModelGateway(store)

    return factory


def start_background(store, gw_factory: Callable[[], Any] | None = None) -> dict:
    """服务启动钩子（server.Runtime.bootstrap 调一次）：先回收上次没收尾的运行 / 任务，
    再为该库启动 job 消费者线程（每个库一个，重复调用复用正在跑的那个）。"""
    report = reap_interrupted(store)
    key = _db_key(getattr(store, "db_path", ""))
    with _REGISTRY_LOCK:
        worker = _WORKERS.get(key)
        if worker is None or not worker.thread.is_alive():
            worker = _JobWorker(store, gw_factory if gw_factory is not None
                                else _default_gateway_factory(store))
            _WORKERS[key] = worker
            worker.thread.start()
    return {"reaped_runs": len(report["runs"]), "requeued_jobs": len(report["jobs"]["requeued"]),
            "failed_jobs": len(report["jobs"]["failed"]), "job_worker": True}


def stop_background(db_path: Any = None, timeout: float = 5.0) -> dict:
    """服务关停钩子（server.graceful_shutdown 调一次）：停该库的 job 消费者，请求取消该库上
    仍在本进程执行的运行（原因 server shutdown），在 timeout 内等它们在节点边界收尾为 cancelled；
    没来得及收尾的由下次启动的 reap_interrupted 标 failed。db_path=None 表示全部。"""
    deadline = time.monotonic() + max(0.0, float(timeout))
    key = _db_key(db_path) if db_path else None
    with _REGISTRY_LOCK:
        keys = [k for k in _WORKERS if key is None or k == key]
        workers = [_WORKERS.pop(k) for k in keys]
        handles = [h for h in _ACTIVE.values() if key is None or h.db == key]
    for worker in workers:
        worker.stop_event.set()
    for handle in handles:
        if not handle.reason:
            handle.reason = "server shutdown"
        handle.event.set()
    for handle in handles:
        handle.done.wait(max(0.0, deadline - time.monotonic()))
    for worker in workers:
        worker.thread.join(max(0.0, deadline - time.monotonic()))
    return {"workers": len(workers), "cancelled": len(handles),
            "unfinished": sum(1 for h in handles if not h.done.is_set())}


def job_worker_status(db_path: Any = None) -> dict:
    """job 消费者状态（GET /api/jobs 的 worker 字段）。"""
    with _REGISTRY_LOCK:
        if db_path:
            worker = _WORKERS.get(_db_key(db_path))
        else:
            worker = next(iter(_WORKERS.values()), None)
    if worker is None:
        return {"running": False,
                "note": "本进程没有 job 消费者（只有 serve 启动的服务进程会启动它）"}
    return worker.status()


# ============================================================
# 17. 读运行记录
# ============================================================


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
