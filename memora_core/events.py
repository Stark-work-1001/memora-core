# -*- coding: utf-8 -*-
"""进程内事件总线：SSE（/api/events）与 workflows.emitter 共用的唯一通道。

设计要点：
  * 纯标准库、无依赖；任何线程都可以 publish。
  * 每个订阅者一条有界队列，满了丢最旧的（慢客户端不拖垮服务端）。
  * 同时记录一份环形历史，SSE 连接建立时先补发最近事件（含 heartbeat），
    这样即使没有新事件，客户端也能立刻收到一帧真实数据。
  * publish 永不抛异常：事件总线坏掉不允许影响业务请求。
"""
from __future__ import annotations

import itertools
import json
import threading
import time
from collections import deque
from typing import Any, Iterable

# 事件类型：与 docs/API.md「GET /api/events — event: run | memory | agent | log」一致，
# 另外加 heartbeat（服务端心跳）与 system（启停/降级）两种内部类型。
EVENT_TYPES = ("run", "memory", "agent", "log", "heartbeat", "system")

# 单订阅者队列上限。20 条足够 SSE 客户端从容消费，又不至于积压成内存泄漏。
QUEUE_SIZE = 200

# 环形历史容量（补发给新连接）。
HISTORY_SIZE = 100

_HISTORY: deque[dict] = deque(maxlen=HISTORY_SIZE)
_SEQ = itertools.count(1)
_LOCK = threading.RLock()
_SUBSCRIBERS: "list[EventBus]" = []
_STARTED_AT = time.time()


class EventBus:
    """一个订阅者 = 一条有界队列。可以当 Callable / .emit() / .put() 三种形态被调用，
    正好覆盖 workflows.RunEmitter 支持的全部投递方式。"""

    __slots__ = ("queue", "types", "_closed", "_cond")

    def __init__(self, types: Iterable[str] | None = None) -> None:
        allowed = {str(t) for t in (types or ()) if str(t)}
        self.queue: deque[dict] = deque(maxlen=QUEUE_SIZE)
        self.types: set[str] = allowed
        self._closed = False
        self._cond = None  # 延迟建，避免每个订阅者都吃一把锁的开销

    # -- 投递接口 -------------------------------------------------
    def put(self, payload: Any) -> bool:
        """接受 {"type":..,"data":..} 或 (type, data) 形态；永不抛异常。"""
        try:
            event = normalize(payload)
        except Exception:  # noqa: BLE001 - 事件投递失败不允许影响调用方
            return False
        if event is None:
            return False
        if self._closed:
            return False
        if self.types and event["type"] not in self.types:
            return False
        self.queue.append(event)
        cond = self._cond
        if cond is not None:
            with cond:
                cond.notify_all()
        return True

    emit = put

    def __call__(self, payload: Any) -> bool:
        return self.put(payload)

    # -- 消费接口 -------------------------------------------------
    def drain(self, limit: int = 64) -> list[dict]:
        out: list[dict] = []
        while self.queue and len(out) < max(1, limit):
            out.append(self.queue.popleft())
        return out

    def empty(self) -> bool:
        return not self.queue

    def close(self) -> None:
        """关闭订阅：清空队列并摘掉全局登记（客户端断开时调用，防止订阅泄漏）。"""
        self._closed = True
        self.queue.clear()
        with _LOCK:
            try:
                _SUBSCRIBERS.remove(self)
            except ValueError:
                pass
        cond = self._cond
        if cond is not None:
            with cond:
                cond.notify_all()

    # -- 等待（SSE 循环用） ---------------------------------------
    def wait(self, timeout: float) -> bool:
        """阻塞最多 timeout 秒等待新事件；返回是否可能已有数据。

        这里用每实例独立 Condition，避免所有连接争同一把锁造成惊群。
        """
        if self.queue:
            return True
        if self._closed:
            return False
        if self._cond is None:
            self._cond = threading.Condition()
        deadline = time.monotonic() + max(0.0, float(timeout))
        with self._cond:
            while not self.queue and not self._closed:
                remain = deadline - time.monotonic()
                if remain <= 0:
                    break
                self._cond.wait(remain)
        return bool(self.queue)


# ---------------------------------------------------------------- 模块级 API
def normalize(payload: Any) -> dict | None:
    """把任意投递形态归一成 {"type", "data", "id", "ts"}；无法识别返回 None。"""
    if payload is None:
        return None
    if isinstance(payload, dict):
        if "type" in payload:
            etype = str(payload.get("type") or "log")
            data = payload.get("data")
            if data is None:
                data = {k: v for k, v in payload.items() if k not in ("type", "data")}
        else:
            etype, data = "log", payload
    elif isinstance(payload, (tuple, list)) and len(payload) == 2:
        etype, data = str(payload[0]), payload[1]
    else:
        etype, data = "log", payload
    if not isinstance(data, dict):
        data = {"value": data}
    return {
        "id": next(_SEQ),
        "type": etype if etype in EVENT_TYPES else "log",
        "data": data,
        "ts": round(time.time(), 3),
    }


def subscribe(types: Iterable[str] | None = None) -> EventBus:
    """新建订阅。返回的 EventBus 必须 close()，否则会一直占着补发名单。"""
    bus = EventBus(types)
    with _LOCK:
        _SUBSCRIBERS.append(bus)
    return bus


def unsubscribe(bus: EventBus | None) -> None:
    if bus is not None:
        bus.close()


def publish(event_type: Any, data: dict | None = None) -> dict | None:
    """广播一个事件；返回归一化后的对象（方便调用方回显 id）。永不抛异常。"""
    try:
        event = normalize({"type": event_type, "data": data or {}})
        if event is None:
            return None
        with _LOCK:
            _HISTORY.append(event)
            targets = list(_SUBSCRIBERS)
        for bus in targets:
            try:
                bus.put(event)
            except Exception:  # noqa: BLE001 - 单个订阅者失败不影响其它人
                continue
        return event
    except Exception:  # noqa: BLE001
        return None


def publish_run(run: dict, event_type: str = "run") -> dict | None:
    """工作流运行事件的便捷入口（只保留前端需要的字段，避免把整棵 output 塞进 SSE）。"""
    run = run or {}
    return publish(event_type, {
        "run_id": run.get("id"),
        "template_id": run.get("template_id"),
        "template_name": run.get("template_name"),
        "status": run.get("status"),
        "error": run.get("error"),
        "scope": run.get("scope_id") or run.get("scope"),
    })


def history(limit: int = 20) -> list[dict]:
    with _LOCK:
        items = list(_HISTORY)
    return items[-max(1, int(limit)):]


def recent(limit: int = 20, types: Iterable[str] | None = None) -> list[dict]:
    """按类型过滤的最近事件（SSE 建连补发用）。"""
    allowed = {str(t) for t in (types or ()) if str(t)}
    items = [e for e in history(HISTORY_SIZE) if not allowed or e["type"] in allowed]
    return items[-max(1, int(limit)):]


def heartbeat() -> dict:
    """服务端心跳事件：SSE 每 15 秒发注释行，同时每 15 秒补一条心跳事件。"""
    return publish("heartbeat", {"uptime_s": int(time.time() - _STARTED_AT),
                                 "subscribers": subscriber_count()}) or {}


def subscriber_count() -> int:
    with _LOCK:
        return len(_SUBSCRIBERS)


def clear() -> None:
    """测试用：清空历史与全部订阅。"""
    with _LOCK:
        _HISTORY.clear()
        for bus in list(_SUBSCRIBERS):
            try:
                bus.close()
            except Exception:  # noqa: BLE001
                pass
        _SUBSCRIBERS.clear()


def stats() -> dict:
    with _LOCK:
        subs = len(_SUBSCRIBERS)
        buffered = sum(len(b.queue) for b in _SUBSCRIBERS)
    return {"subscribers": subs, "buffered": buffered, "history": len(_HISTORY),
            "event_types": list(EVENT_TYPES), "uptime_s": int(time.time() - _STARTED_AT)}


# ---------------------------------------------------------------- SSE 编码
def sse_frame(event: dict, event_name: str | None = None) -> str:
    """把一条事件编码成 SSE 帧（event/data/id 三段 + 空行结尾）。"""
    etype = str(event_name or event.get("type") or "message")
    payload = json.dumps(
        {"type": event.get("type"), "data": event.get("data") or {}, "ts": event.get("ts")},
        ensure_ascii=False, separators=(",", ":"),
    )
    lines = ["event: %s" % etype]
    if event.get("id") is not None:
        lines.append("id: %s" % event["id"])
    for line in payload.splitlines() or [""]:
        lines.append("data: %s" % line)
    return "\n".join(lines) + "\n\n"


def sse_comment(text: str = "ping") -> str:
    """SSE 注释行（心跳）：冒号开头，客户端解析器会忽略但连接保持活跃。"""
    return ": %s %s\n\n" % (text, int(time.time()))


__all__ = [
    "EVENT_TYPES", "EventBus", "QUEUE_SIZE", "HISTORY_SIZE",
    "subscribe", "unsubscribe", "publish", "publish_run", "normalize",
    "history", "recent", "heartbeat", "subscriber_count", "clear", "stats",
    "sse_frame", "sse_comment",
]
