# -*- coding: utf-8 -*-
"""memora-core HTTP API 服务端（仅标准库）。

职责：
  * 把 store / retrieval / workflows / agents / exchange / models / mcp 的能力
    暴露成一套稳定 JSON API（见 docs/API.md）；
  * 托管 memora_core/static 下的前端构建产物（含脑图页）；
  * GET /api/events 提供 SSE 长连接，事件来自 events.py 的进程内总线。

安全基线：只绑回环 + Host 头校验（防 DNS rebinding）+ CSP / nosniff / no-store /
no-referrer；写操作强制 application/json；请求体上限 8MB；异常一律 JSON 且不泄露堆栈。

容错基线：任何依赖模块缺失或抛错都只让相关端点返回 503，服务本身不倒地；
/api/health 永远可用，并如实列出哪些能力不可用。
"""
from __future__ import annotations

import gzip
import importlib
import json
import os
import re
import select
import socket
import threading
import time
import traceback
import urllib.parse
import webbrowser
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable, Iterable

from . import __version__
from . import db as dbmod
from . import events as eventbus
from .paths import Paths, package_dir

VERSION = __version__
DEFAULT_PORT = 8790
DEFAULT_HOST = "127.0.0.1"
LOOPBACK_HOSTS = ("127.0.0.1", "localhost", "::1")

MAX_BODY = 8 * 1024 * 1024          # 请求体上限 8MB
GZIP_MIN_BYTES = 1024               # 超过 1KB 的响应走 gzip
MAX_REQUESTS_PER_CONN = 200         # 单连接请求数上限（keep-alive 复用上限）
HEARTBEAT_SECONDS = 15.0            # SSE 心跳注释行间隔
SSE_POLL_SECONDS = 0.5              # SSE 轮询切片（用于及时发现客户端断开）
SSE_BACKLOG = 5                     # SSE 建连时补发的历史事件条数
SSE_MAX_LIFETIME = 3600.0           # 单条 SSE 连接最长存活（防止忘记关闭）
STATIC_DIR = package_dir() / "static"
STATIC_INDEX = "index.html"
STATIC_BRAIN = "brain.html"

# 统一安全响应头。CSP 与前端 index.html 里的 meta 保持一致（同源、无 CDN）。
SECURITY_HEADERS = {
    "Content-Security-Policy": (
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; "
        "worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; "
        "form-action 'self'; object-src 'none'"
    ),
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "geolocation=(), microphone=(), camera=()",
}

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".ico": "image/x-icon",
    ".webp": "image/webp",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".wasm": "application/wasm",
    ".webmanifest": "application/manifest+json",
}

JSON_TYPE = "application/json; charset=utf-8"
NDJSON_TYPE = "application/x-ndjson; charset=utf-8"
MARKDOWN_TYPE = "text/markdown; charset=utf-8"

CAPABILITY_MODULES = ("store", "retrieval", "workflows", "agents", "exchange",
                      "models", "mcp", "ingest", "vault")


# ============================================================ 错误与响应
class ApiError(Exception):
    """携带 HTTP 状态、中文说明与机器码的业务异常。"""

    def __init__(self, status: int, message: str, code: str = "ERROR",
                 extra: dict | None = None, headers: dict | None = None) -> None:
        super().__init__(message)
        self.status = int(status)
        self.message = str(message)
        self.code = str(code or "ERROR")
        self.extra = dict(extra or {})
        self.headers = dict(headers or {})

    def payload(self) -> dict:
        out = {"error": self.message, "code": self.code}
        out.update(self.extra)
        return out


class Resp:
    """原始响应（非 JSON 或需要自定义头部时使用）。"""

    __slots__ = ("payload", "status", "headers", "content_type")

    def __init__(self, payload: Any = None, status: int = 200,
                 headers: dict | None = None, content_type: str | None = None) -> None:
        self.payload = payload
        self.status = int(status)
        self.headers = dict(headers or {})
        self.content_type = content_type


def _json_error(status: int, message: str, code: str = "ERROR") -> ApiError:
    return ApiError(status, message, code)


# ============================================================ 依赖装载
def _load_module(name: str):
    """唯一导入缝：测试用 monkeypatch 把它换成抛 ImportError 即可模拟模块缺失。"""
    return importlib.import_module("memora_core." + name)


class Request:
    """一次 HTTP 请求的只读视图。"""

    __slots__ = ("method", "path", "query_string", "query", "headers", "params",
                 "body", "runtime")

    def __init__(self, method: str, path: str, query_string: str,
                 headers: Any, params: dict, body: bytes, runtime: "Runtime") -> None:
        self.method = method
        self.path = path
        self.query_string = query_string
        self.query = urllib.parse.parse_qs(query_string, keep_blank_values=True)
        self.headers = headers
        self.params = params
        self.body = body
        self.runtime = runtime

    # -- 查询参数 -------------------------------------------------
    def q(self, key: str, default: Any = None) -> Any:
        values = self.query.get(key)
        return values[0] if values else default

    def qint(self, key: str, default: int, low: int = 1, high: int = 500) -> int:
        raw = self.q(key)
        if raw is None or str(raw).strip() == "":
            return default
        try:
            value = int(str(raw).strip())
        except (TypeError, ValueError):
            raise ApiError(400, "参数 %s 必须是整数" % key, "BAD_PARAM",
                           {"param": key}) from None
        return max(low, min(high, value))

    def qbool(self, key: str, default: bool = False) -> bool:
        raw = self.q(key)
        if raw is None:
            return default
        return str(raw).strip().lower() in ("1", "true", "yes", "on", "y")

    # -- 请求体 ---------------------------------------------------
    def text(self) -> str:
        return self.body.decode("utf-8", "replace")

    def json(self, require: bool = True) -> dict:
        raw = self.body
        if not raw or not raw.strip():
            if require:
                raise ApiError(400, "请求体不能为空，需要 JSON 对象", "EMPTY_BODY")
            return {}
        try:
            data = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            raise ApiError(400, "JSON 解析失败：请求体不是合法 JSON", "BAD_JSON") from None
        if not isinstance(data, dict):
            raise ApiError(400, "请求体必须是 JSON 对象", "BAD_JSON")
        return data


# ============================================================ 运行时
class Runtime:
    """一次服务进程的共享状态：数据目录、懒加载模块、单例 Store/网关、关停信号。"""

    def __init__(self, paths: Paths, static_dir: str | os.PathLike | None = None) -> None:
        self.paths = paths
        self.static_dir = Path(static_dir) if static_dir else STATIC_DIR
        self.started_at = time.time()
        self.started_mono = time.monotonic()
        self.shutdown = threading.Event()
        self.active = 0            # 在途请求数（优雅退出用）
        self.requests = 0          # 累计请求数
        self.static_hits = 0
        self.sse_clients = 0
        self.log: deque[str] = deque(maxlen=200)
        self._lock = threading.RLock()
        self._mods: dict[str, Any] = {}
        self._errors: dict[str, str] = {}
        self._store: Any = None
        self._gw: Any = None
        self._gw_error: str | None = None
        self._active_lock = threading.Lock()

    # -- 模块 -----------------------------------------------------
    def module(self, name: str):
        with self._lock:
            cached = self._mods.get(name)
            if cached is not None:
                return cached
            try:
                mod = _load_module(name)
            except Exception as exc:  # noqa: BLE001 - 任何导入失败都降级
                detail = "%s: %s" % (type(exc).__name__, exc)
                self._errors[name] = detail
                raise ApiError(503, "依赖模块不可用：%s（%s）" % (name, detail),
                               "MODULE_UNAVAILABLE", {"module": name}) from None
            self._mods[name] = mod
            self._errors.pop(name, None)
            return mod

    def have(self, name: str) -> bool:
        try:
            self.module(name)
            return True
        except ApiError:
            return False

    def reset(self) -> None:
        """丢弃模块与连接缓存（测试里模拟"模块被改名"后用）。"""
        with self._lock:
            self._mods.clear()
            self._errors.clear()
            self._store = None
            self._gw = None
            self._gw_error = None

    def capabilities(self) -> dict:
        """逐个**重新**探测依赖模块，供 /api/health 如实报告。"""
        out = {}
        for name in CAPABILITY_MODULES:
            try:
                _load_module(name)
                out[name] = {"ok": True, "error": None}
            except Exception as exc:  # noqa: BLE001
                detail = "%s: %s" % (type(exc).__name__, exc)
                with self._lock:
                    self._errors[name] = detail
                out[name] = {"ok": False, "error": detail}
        db_ok, db_error = self.db_probe()
        out["db"] = {"ok": db_ok, "error": db_error}
        return out

    def db_probe(self) -> tuple[bool, str | None]:
        try:
            con = dbmod.connect(self.paths.db)
            try:
                con.execute("SELECT 1").fetchone()
            finally:
                con.close()
            return True, None
        except Exception as exc:  # noqa: BLE001
            return False, "%s: %s" % (type(exc).__name__, exc)

    # -- Store / 网关 ---------------------------------------------
    def store(self):
        with self._lock:
            if self._store is not None:
                return self._store
        store_mod = self.module("store")
        vault = None
        try:
            vault_mod = self.module("vault")
            vault = vault_mod.Vault(self.paths.vault)
        except ApiError:
            vault = None
        try:
            instance = store_mod.Store(self.paths.db, vault)
        except Exception as exc:  # noqa: BLE001
            raise ApiError(503, "记忆库初始化失败：%s" % exc, "STORE_UNAVAILABLE") from None
        with self._lock:
            self._store = instance
        return instance

    def gateway(self):
        """模型网关；不可用时抛 503。"""
        with self._lock:
            if self._gw is not None:
                return self._gw
            if self._gw_error:
                raise ApiError(503, "模型网关不可用：%s" % self._gw_error,
                               "MODELS_UNAVAILABLE")
        models_mod = self.module("models")
        try:
            gw = models_mod.ModelGateway(self.store())
        except ApiError:
            raise
        except Exception as exc:  # noqa: BLE001
            with self._lock:
                self._gw_error = "%s: %s" % (type(exc).__name__, exc)
            raise ApiError(503, "模型网关不可用：%s" % exc, "MODELS_UNAVAILABLE") from None
        with self._lock:
            self._gw = gw
            self._gw_error = None
        return gw

    def gateway_or_none(self):
        """检索类接口允许无网关（确定性降级），这里吞掉 503。"""
        try:
            return self.gateway()
        except ApiError:
            return None

    def model_health(self) -> dict:
        try:
            gw = self.gateway()
            health = gw.health()
            return health if isinstance(health, dict) else {}
        except Exception:  # noqa: BLE001 - 网关挂了也要能报健康
            return {}

    def degraded(self) -> list[str]:
        health = self.model_health()
        if not health:
            return ["chat", "embedding", "reranker", "judge"]
        return sorted(k for k, v in health.items() if not (v or {}).get("ok"))

    # -- 生命周期 -------------------------------------------------
    def bootstrap(self) -> dict:
        """启动时尽力灌入内置模板/智能体/算法；任何一步失败都只记录不抛。"""
        report: dict[str, Any] = {"templates": None, "agents": None, "algorithms": None,
                                  "errors": []}
        store = None
        try:
            store = self.store()
        except Exception as exc:  # noqa: BLE001
            report["errors"].append("store: %s" % exc)
        if store is not None:
            try:
                workflows = self.module("workflows")
                report["templates"] = workflows.seed_templates(store)
            except Exception as exc:  # noqa: BLE001
                report["errors"].append("workflows: %s" % exc)
            try:
                agents_mod = self.module("agents")
                report["agents"] = agents_mod.seed_agents(store)
            except Exception as exc:  # noqa: BLE001
                report["errors"].append("agents: %s" % exc)
        try:
            report["algorithms"] = _seed_algorithms(self.paths)
        except Exception as exc:  # noqa: BLE001
            report["errors"].append("algorithms: %s" % exc)
        return report

    # -- 计数 -----------------------------------------------------
    def enter(self) -> None:
        with self._active_lock:
            self.active += 1
            self.requests += 1

    def leave(self) -> None:
        with self._active_lock:
            self.active = max(0, self.active - 1)

    def uptime(self) -> int:
        return int(time.monotonic() - self.started_mono)

    def log_line(self, text: str) -> None:
        self.log.append("%s %s" % (time.strftime("%H:%M:%S"), text))


def _seed_algorithms(paths: Paths) -> int:
    """把内置算法目录写入 memory_algo（幂等，供 GET /api/algorithms 直接读库）。"""
    data = dbmod.read_builtin("algorithms.json") or []
    if not data:
        return 0
    con = dbmod.connect(paths.db)
    try:
        with dbmod.transaction(con):
            for item in data:
                con.execute(
                    "INSERT OR REPLACE INTO memory_algo(id,name,category,summary,detail,formula,"
                    "reference,offline,runnable,params) VALUES(?,?,?,?,?,?,?,?,?,?)",
                    (item["id"], item["name"], item["category"], item["summary"],
                     item.get("detail", ""), item.get("formula"), item.get("reference"),
                     int(item.get("offline", 1)), int(item.get("runnable", 0)),
                     dbmod.dumps(item.get("params", {}))),
                )
    finally:
        con.close()
    return len(data)


# ============================================================ 通用小工具
def _emit(event_type: str, data: dict) -> None:
    """广播事件；事件总线异常绝不影响业务响应。"""
    try:
        eventbus.publish(event_type, data)
    except Exception:  # noqa: BLE001
        pass


def _clamp01(value: Any, default: float = 0.5) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return max(0.0, min(1.0, number))


def _paginate(req: Request, default_limit: int = 50) -> tuple[int, int]:
    limit = req.qint("limit", default_limit, 1, 500)
    offset = req.qint("offset", 0, 0, 10 ** 7)
    return limit, offset


def _audit(rt: Runtime, action: str, target: str | None, detail: Any = None,
           actor: str = "api") -> None:
    try:
        rt.store().audit(action, target, actor=actor, detail=detail)
    except Exception:  # noqa: BLE001 - 审计失败不阻塞主流程
        pass


def _iso(ts: float | None = None) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts if ts is not None else time.time()))


def _row_dicts(rt: Runtime, sql: str, args: tuple = (), limit: int = 200) -> list[dict]:
    """直接读表（conflict/job/setting 这类没有 Store 包装的表）。"""
    con = rt.store().con
    rows = con.execute(sql, args).fetchmany(max(1, int(limit)))
    return [dict(r) for r in rows]


def _json_field(row: dict, field: str, default: Any = None) -> dict:
    value = row.get(field)
    if isinstance(value, (dict, list)):
        return value
    return dbmod.loads(value, default) or (default if default is not None else {})


# ============================================================ 路由表
_RAW_ROUTES: list[tuple[str, str, Callable]] = []


def route(path: str, method: str):
    def deco(fn: Callable) -> Callable:
        _RAW_ROUTES.append((path, method.upper(), fn))
        return fn
    return deco


_PLACEHOLDER = re.compile(r"^\{[A-Za-z_][A-Za-z0-9_]*\}$")


def _compile(path: str) -> tuple[list[str], list[str]]:
    parts = [p for p in path.strip("/").split("/") if p != ""] if path.strip("/") else []
    names = [p[1:-1] for p in parts if _PLACEHOLDER.match(p)]
    return parts, names


class Matcher:
    """极简路由匹配器：字面段优先于占位段，避免 /api/documents/import 被 {id} 吃掉。"""

    def __init__(self, table: Iterable[tuple[str, str, Callable]] = ()) -> None:
        self.entries: list[tuple[list[str], str, Callable, int]] = []
        for path, method, fn in table:
            parts, _ = _compile(path)
            literals = sum(1 for p in parts if not _PLACEHOLDER.match(p))
            self.entries.append((parts, method, fn, literals))
        # 字面段多的优先；同分时路径长的优先（更具体的路由先匹配）
        self.entries.sort(key=lambda e: (-e[3], -len(e[0])))

    def match(self, path: str, method: str) -> tuple[Callable | None, dict, bool]:
        """返回 (handler, path_params, path_known)。path_known 用于区分 404 与 405。"""
        segments = [s for s in path.strip("/").split("/") if s != ""] if path.strip("/") else []
        path_known = False
        for parts, entry_method, fn, _ in self.entries:
            if len(parts) != len(segments):
                continue
            params: dict[str, str] = {}
            ok = True
            for expected, actual in zip(parts, segments):
                if _PLACEHOLDER.match(expected):
                    params[expected[1:-1]] = actual
                elif expected != actual:
                    ok = False
                    break
            if not ok:
                continue
            path_known = True
            if entry_method == method:
                return fn, params, True
        return None, {}, path_known


MATCHER = Matcher()


def _rebuild_matcher() -> None:
    global MATCHER
    MATCHER = Matcher(_RAW_ROUTES)


def methods_for(path: str) -> list[str]:
    segments = [s for s in path.strip("/").split("/") if s != ""] if path.strip("/") else []
    out = []
    for parts, method, _fn, _lit in MATCHER.entries:
        if len(parts) != len(segments):
            continue
        if all(_PLACEHOLDER.match(e) or e == a for e, a in zip(parts, segments)):
            out.append(method)
    return sorted(set(out))


# ============================================================ 健康与总览
@route("/api/health", "GET")
def api_health(rt: Runtime, req: Request):
    capabilities = rt.capabilities()
    db_counts: dict = {}
    db_ok = False
    integrity = None
    try:
        con = dbmod.connect(rt.paths.db)
        try:
            info = dbmod.health(con)
        finally:
            con.close()
        db_ok = bool(info.get("ok"))
        integrity = info.get("integrity")
        for key in ("memory", "document", "chunk", "evidence", "edge", "entity",
                    "workflow_run", "agent", "conflict", "job"):
            value = (info.get("counts") or {}).get(key, -1)
            db_counts[key] = None if value is None or value < 0 else value
    except Exception as exc:  # noqa: BLE001
        integrity = "error: %s" % exc
    health = rt.model_health()
    models = {role: {"ok": bool((info or {}).get("ok")),
                     "degraded": bool((info or {}).get("degraded", not (info or {}).get("ok"))),
                     "provider": (info or {}).get("provider"),
                     "model": (info or {}).get("model")}
              for role, info in (health or {}).items()}
    unavailable = sorted(k for k, v in capabilities.items() if not v.get("ok"))
    degraded = list(rt.degraded())
    degraded += [name for name in unavailable if name not in degraded]
    return {
        "ok": True,
        "version": VERSION,
        "uptime_s": rt.uptime(),
        "started_at": _iso(rt.started_at),
        "data_dir": str(rt.paths.root),
        "pid": os.getpid(),
        "db": db_counts,
        "db_ok": db_ok,
        "db_integrity": integrity,
        "models": models,
        "degraded": sorted(set(degraded)),
        "unavailable": unavailable,
        "capabilities": capabilities,
        "events": eventbus.stats(),
        "requests": rt.requests,
        "sse_clients": rt.sse_clients,
    }


@route("/api/overview", "GET")
def api_overview(rt: Runtime, req: Request):
    out: dict[str, Any] = {"totals": {}, "by_kind": {}, "by_scope": [], "daily": [],
                           "recent_runs": [], "pending_reviews": [], "agents": [],
                           "degraded": rt.degraded(), "generated_at": _iso()}
    stats: dict = {}
    try:
        stats = rt.store().stats()
    except Exception as exc:  # noqa: BLE001
        out["store_error"] = str(exc)
    out["totals"] = {
        "memories": (stats.get("memories") or {}).get("total", 0),
        "approved": (stats.get("memories") or {}).get("approved", 0),
        "candidates": (stats.get("memories") or {}).get("candidate", 0),
        "documents": stats.get("documents", 0),
        "chunks": stats.get("chunks", 0),
        "evidence": stats.get("evidence", 0),
        "edges": stats.get("edges", 0),
        "entities": stats.get("entities", 0),
        "scopes": stats.get("scopes", 0),
        "conflicts_open": (stats.get("conflicts") or {}).get("open", 0),
    }
    out["by_kind"] = (stats.get("memories") or {}).get("by_kind", {})
    try:
        con = rt.store().con
        out["by_scope"] = [
            {"scope_id": row["scope_id"], "count": int(row["c"])}
            for row in con.execute(
                "SELECT scope_id, count(*) AS c FROM memory GROUP BY scope_id "
                "ORDER BY c DESC LIMIT 20"
            ).fetchall()
        ]
        since = time.strftime("%Y-%m-%d", time.gmtime(time.time() - 30 * 86400))
        out["daily"] = [
            {"day": row["day"], "count": int(row["c"])}
            for row in con.execute(
                "SELECT substr(recorded_at, 1, 10) AS day, count(*) AS c FROM memory "
                "WHERE recorded_at >= ? GROUP BY day ORDER BY day", (since,)
            ).fetchall()
        ]
        out["pending_reviews"] = [
            dict(row) for row in con.execute(
                "SELECT id, title, kind, status, trust, review_due, recorded_at FROM memory "
                "WHERE status = 'candidate' OR (review_due IS NOT NULL AND review_due <= ?) "
                "ORDER BY review_due IS NULL, review_due, recorded_at DESC LIMIT 10",
                (_iso(),)
            ).fetchall()
        ]
    except Exception as exc:  # noqa: BLE001
        out["aggregate_error"] = str(exc)
    try:
        workflows = rt.module("workflows")
        out["recent_runs"] = workflows.list_runs(rt.store(), limit=5)
    except Exception:  # noqa: BLE001
        out["recent_runs"] = []
    try:
        agents_mod = rt.module("agents")
        out["agents"] = agents_mod.agent_status(rt.store())
    except Exception:  # noqa: BLE001
        out["agents"] = []
    return out


# ============================================================ 记忆
@route("/api/memories", "GET")
def api_memories_list(rt: Runtime, req: Request):
    limit, offset = _paginate(req)
    filters = {
        "q": req.q("q") or "",
        "scope": req.q("scope"),
        "kind": req.q("kind"),
        "status": req.q("status"),
        "agent": req.q("agent"),
        "session": req.q("session"),
        "sort": req.q("sort"),
        "order": req.q("order"),
        "limit": limit,
        "offset": offset,
        "include_archived": req.qbool("include_archived"),
    }
    result = rt.store().list_memories(filters)
    result.setdefault("limit", limit)
    result.setdefault("offset", offset)
    result["degraded"] = []
    return result


@route("/api/memories", "POST")
def api_memories_create(rt: Runtime, req: Request):
    body = req.json()
    for field in ("title", "body", "kind"):
        if not str(body.get(field) or "").strip():
            raise ApiError(400, "缺少必填字段：%s" % field, "MISSING_FIELD",
                           {"field": field})
    body.setdefault("scope_id", "global")
    store = rt.store()
    try:
        memory = store.add_memory(body)
    except ValueError as exc:
        raise ApiError(400, "记忆写入失败：%s" % exc, "BAD_MEMORY") from None
    for evidence in body.get("evidence") or []:
        try:
            store.add_evidence(memory["id"], evidence)
        except Exception:  # noqa: BLE001 - 单条证据失败不影响主记录
            continue
    for block in body.get("blocks") or []:
        try:
            store.add_block(memory["id"], block)
        except Exception:  # noqa: BLE001
            continue
    for ent in body.get("entities") or []:
        try:
            entity = store.upsert_entity(str(ent.get("name") or ""),
                                         str(ent.get("kind") or "concept"),
                                         str(ent.get("definition") or ""),
                                         body.get("scope_id"))
            store.link_memory_entity(memory["id"], entity["id"])
        except Exception:  # noqa: BLE001
            continue
    _emit("memory", {"action": "create", "memory_id": memory["id"],
                     "title": memory.get("title"), "scope": memory.get("scope_id")})
    return Resp(store.get_memory(memory["id"]) or memory, status=201)


@route("/api/memories/{id}", "GET")
def api_memories_get(rt: Runtime, req: Request):
    store = rt.store()
    mid = req.params["id"]
    memory = store.get_memory(mid)
    if not memory:
        raise ApiError(404, "记忆不存在：%s" % mid, "MEMORY_NOT_FOUND")
    try:
        memory["history"] = _row_dicts(
            rt, "SELECT id, at, actor, action, detail FROM audit WHERE target = ? "
                "ORDER BY at DESC, id DESC LIMIT 20", (mid,), 20)
    except Exception:  # noqa: BLE001
        memory["history"] = []
    return memory


@route("/api/memories/{id}", "PATCH")
def api_memories_patch(rt: Runtime, req: Request):
    mid = req.params["id"]
    body = req.json()
    if not body:
        raise ApiError(400, "请求体不能为空", "EMPTY_BODY")
    store = rt.store()
    try:
        memory = store.update_memory(mid, body)
    except KeyError:
        raise ApiError(404, "记忆不存在：%s" % mid, "MEMORY_NOT_FOUND") from None
    except ValueError as exc:
        message = str(exc)
        if "迁移" in message:
            raise ApiError(409, "非法状态迁移：%s" % message, "BAD_TRANSITION") from None
        raise ApiError(400, "更新失败：%s" % message, "BAD_MEMORY") from None
    _emit("memory", {"action": "update", "memory_id": mid,
                     "fields": sorted(body.keys())})
    return memory


@route("/api/memories/{id}", "DELETE")
def api_memories_delete(rt: Runtime, req: Request):
    mid = req.params["id"]
    hard = req.qbool("hard")
    if hard and str(req.q("confirm") or "") != mid:
        raise ApiError(400, "硬删除需要 confirm=%s" % mid, "CONFIRM_REQUIRED")
    store = rt.store()
    try:
        result = store.delete_memory(mid, hard=hard)
    except KeyError:
        raise ApiError(404, "记忆不存在：%s" % mid, "MEMORY_NOT_FOUND") from None
    _emit("memory", {"action": "hard_delete" if hard else "archive", "memory_id": mid})
    return result


@route("/api/memories/{id}/review", "POST")
def api_memories_review(rt: Runtime, req: Request):
    mid = req.params["id"]
    body = req.json(require=False)
    try:
        grade = int(body.get("grade", 4))
    except (TypeError, ValueError):
        raise ApiError(400, "grade 必须是 0..5 的整数", "BAD_GRADE") from None
    if not 0 <= grade <= 5:
        raise ApiError(400, "grade 必须是 0..5 的整数", "BAD_GRADE")
    return _sm2_review(rt, mid, grade)


def _sm2_review(rt: Runtime, mid: str, grade: int) -> dict:
    """SM-2 复习打分：更新 stability / difficulty / review_due 并写 review_log。"""
    store = rt.store()
    memory = store.get_memory(mid)
    if not memory:
        raise ApiError(404, "记忆不存在：%s" % mid, "MEMORY_NOT_FOUND")
    con = store.con
    row = con.execute(
        "SELECT ease, interval FROM review_log WHERE memory_id = ? ORDER BY at DESC, id DESC "
        "LIMIT 1", (mid,)).fetchone()
    ease = float(row["ease"]) if row and row["ease"] else 2.5
    interval = float(row["interval"]) if row and row["interval"] else 0.0
    repeats = int(con.execute(
        "SELECT count(*) FROM review_log WHERE memory_id = ? AND grade >= 3", (mid,)
    ).fetchone()[0])
    if grade >= 3:
        if repeats == 0:
            interval = 1.0
        elif repeats == 1:
            interval = 6.0
        else:
            interval = max(1.0, round(interval * ease))
        ease = max(1.3, ease + 0.1 - (5 - grade) * (0.08 + (5 - grade) * 0.02))
    else:
        interval = 1.0
        repeats = 0
    difficulty = round(max(0.0, min(1.0, (5 - grade) / 5.0)), 3)
    due = _iso(time.time() + interval * 86400)
    stamp = _iso()
    with store._txn() as conn:
        conn.execute(
            "INSERT INTO review_log(id, memory_id, grade, algorithm, interval, ease, due, at) "
            "VALUES(?,?,?,?,?,?,?,?)",
            ("rv-" + os.urandom(6).hex(), mid, grade, "sm2", interval, ease, due, stamp),
        )
        conn.execute(
            "UPDATE memory SET review_due = ?, last_reviewed = ?, review_count = review_count + 1, "
            "stability = ?, difficulty = ?, updated_at = ? WHERE id = ?",
            (due, stamp, interval, difficulty, stamp, mid),
        )
        conn.execute(
            "INSERT INTO audit(id, at, actor, action, target, detail) VALUES(?,?,?,?,?,?)",
            ("a-" + os.urandom(6).hex(), stamp, "api", "memory.review", mid,
             dbmod.dumps({"grade": grade, "due": due, "interval": interval})),
        )
    _emit("memory", {"action": "review", "memory_id": mid, "grade": grade, "due": due})
    updated = store.get_memory(mid) or {}
    return {"ok": True, "memory_id": mid, "grade": grade, "ease": round(ease, 3),
            "interval": interval, "due": due, "difficulty": difficulty,
            "review_count": updated.get("review_count"),
            "status": updated.get("status", memory.get("status"))}


@route("/api/memories/{id}/approve", "POST")
def api_memories_approve(rt: Runtime, req: Request):
    return _set_status(rt, req, "approved")


@route("/api/memories/{id}/reject", "POST")
def api_memories_reject(rt: Runtime, req: Request):
    return _set_status(rt, req, "rejected")


def _set_status(rt: Runtime, req: Request, status: str) -> dict:
    mid = req.params["id"]
    body = req.json(require=False)
    note = str(body.get("note") or "")
    store = rt.store()
    try:
        memory = store.set_status(mid, status, note)
    except KeyError:
        raise ApiError(404, "记忆不存在：%s" % mid, "MEMORY_NOT_FOUND") from None
    except ValueError as exc:
        raise ApiError(409, "状态迁移被拒绝：%s" % exc, "BAD_TRANSITION") from None
    _emit("memory", {"action": status, "memory_id": mid, "note": note})
    return memory


@route("/api/memories/{id}/evidence", "GET")
def api_memories_evidence(rt: Runtime, req: Request):
    mid = req.params["id"]
    store = rt.store()
    if not store.get_memory(mid):
        raise ApiError(404, "记忆不存在：%s" % mid, "MEMORY_NOT_FOUND")
    items = store.list_evidence(mid)
    return {"items": items, "total": len(items), "memory_id": mid}


@route("/api/memories/{id}/evidence", "POST")
def api_memories_evidence_add(rt: Runtime, req: Request):
    mid = req.params["id"]
    body = req.json()
    if not str(body.get("quote") or body.get("uri") or "").strip():
        raise ApiError(400, "证据至少需要 quote 或 uri", "MISSING_FIELD")
    store = rt.store()
    if not store.get_memory(mid):
        raise ApiError(404, "记忆不存在：%s" % mid, "MEMORY_NOT_FOUND")
    evidence = store.add_evidence(mid, body)
    _emit("memory", {"action": "evidence", "memory_id": mid,
                     "evidence_id": evidence.get("id")})
    return Resp(evidence, status=201)


# ============================================================ 检索与召回
@route("/api/search", "GET")
def api_search(rt: Runtime, req: Request):
    query = str(req.q("q") or "").strip()
    if not query:
        raise ApiError(400, "参数 q 不能为空", "MISSING_FIELD", {"param": "q"})
    strategy = str(req.q("strategy") or "hybrid")
    limit = req.qint("limit", 20, 1, 200)
    budget = req.qint("budget", 0, 0, 100000) or None
    retrieval = rt.module("retrieval")
    result = retrieval.search(
        rt.store(), rt.gateway_or_none(), query,
        scope=req.q("scope"), limit=limit, strategy=strategy, budget=budget,
        include_candidates=req.qbool("include_candidates"),
    )
    result.setdefault("strategy", strategy)
    return result


@route("/api/recall", "POST")
def api_recall(rt: Runtime, req: Request):
    body = req.json()
    query = str(body.get("query") or body.get("q") or "").strip()
    if not query:
        raise ApiError(400, "字段 query 不能为空", "MISSING_FIELD", {"field": "query"})
    agent_id = str(body.get("agent") or body.get("agent_id") or "api")
    scope = body.get("scope")
    limit = max(1, min(100, int(body.get("limit") or 10)))
    budget = int(body.get("budget") or 1200)
    retrieval = rt.module("retrieval")
    gw = rt.gateway_or_none()
    store = rt.store()
    result = retrieval.recall_for_agent(store, gw, query, agent_id, scope, limit)
    pack = retrieval.digest(store, gw, scope=scope or result.get("scope") or "global",
                            budget=budget, task=query, agent_id=agent_id)
    result["digest"] = pack.get("text") or ""
    result["digest_items"] = pack.get("items") or []
    result["budget"] = budget
    result["tokens"] = pack.get("tokens")
    result["degraded"] = sorted(set(result.get("degraded") or []) | set(pack.get("degraded") or []))
    _emit("log", {"action": "recall", "agent": agent_id, "query": query,
                  "hits": len(result.get("hits") or [])})
    return result


# ============================================================ 文档库
@route("/api/documents", "GET")
def api_documents_list(rt: Runtime, req: Request):
    limit, offset = _paginate(req)
    result = rt.store().list_documents({
        "kind": req.q("kind"), "q": req.q("q"), "scope": req.q("scope"),
        "status": req.q("status"), "day": req.q("day"), "origin": req.q("origin"),
        "limit": limit, "offset": offset,
    })
    return result


@route("/api/documents/{id}", "GET")
def api_documents_get(rt: Runtime, req: Request):
    doc_id = req.params["id"]
    store = rt.store()
    document = store.get_document(doc_id)
    if not document:
        raise ApiError(404, "文档不存在：%s" % doc_id, "DOCUMENT_NOT_FOUND")
    chunks = _row_dicts(
        rt, "SELECT id, ordinal, heading, level, tokens, start_line, end_line, "
            "substr(text, 1, 400) AS preview FROM chunk WHERE document_id = ? "
            "ORDER BY ordinal LIMIT 500", (document["id"],), 500)
    document["chunks"] = chunks
    return document


@route("/api/documents/{id}/raw", "GET")
def api_documents_raw(rt: Runtime, req: Request):
    doc_id = req.params["id"]
    store = rt.store()
    document = store.get_document(doc_id)
    if not document:
        raise ApiError(404, "文档不存在：%s" % doc_id, "DOCUMENT_NOT_FOUND")
    rel = str(document.get("path") or "")
    text = ""
    try:
        text = rt.module("vault").Vault(rt.paths.vault).read(rel)
    except Exception:  # noqa: BLE001 - vault 缺失时直接读文件
        candidate = (rt.paths.vault / rel).resolve()
        try:
            if rt.paths.vault.resolve() in candidate.parents and candidate.exists():
                text = candidate.read_text(encoding="utf-8")
        except (OSError, ValueError):
            text = ""
    if not text:
        raise ApiError(404, "原始文件不存在：%s" % rel, "RAW_NOT_FOUND")
    return Resp(text, headers={"X-Document-Id": str(document["id"])},
                content_type=MARKDOWN_TYPE)


@route("/api/documents/import", "POST")
def api_documents_import(rt: Runtime, req: Request):
    ingest = rt.module("ingest")
    store = rt.store()
    ctype = str(req.headers.get("Content-Type") or "").lower()
    if ctype.startswith("multipart/form-data"):
        parts = _parse_multipart(req.headers.get("Content-Type") or "", req.body)
        uploaded = None
        fields: dict[str, str] = {}
        for name, filename, data in parts:
            if filename:
                uploaded = (filename, data)
            else:
                fields[name] = data.decode("utf-8", "replace")
        if uploaded is None:
            raise ApiError(400, "multipart 请求里没有文件", "MISSING_FILE")
        filename, data = uploaded
        target = rt.paths.tmp / ("upload-" + os.urandom(4).hex() + "-" +
                                 _safe_name(filename))
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        try:
            result = ingest.ingest_file(store, target, scope=fields.get("scope") or "global",
                                        kind=fields.get("kind") or "note")
        finally:
            try:
                target.unlink()
            except OSError:
                pass
        _emit("memory", {"action": "document_import", "path": str(target),
                         "document_id": result.get("document_id")})
        return Resp(result, status=201)
    body = req.json()
    scope = str(body.get("scope") or "global")
    if body.get("path"):
        try:
            result = ingest.ingest_file(store, body["path"], scope=scope,
                                        kind=str(body.get("kind") or "note"))
        except FileNotFoundError as exc:
            raise ApiError(404, "文件不存在：%s" % exc, "FILE_NOT_FOUND") from None
        except (IsADirectoryError, ValueError) as exc:
            raise ApiError(400, "导入失败：%s" % exc, "BAD_IMPORT") from None
        _emit("memory", {"action": "document_import", "path": str(body["path"]),
                         "document_id": result.get("document_id")})
        return Resp(result, status=201)
    if body.get("text"):
        result = ingest.ingest_text(store, str(body["text"]),
                                    title=str(body.get("title") or "未命名文档"),
                                    scope=scope, kind=str(body.get("kind") or "note"))
        _emit("memory", {"action": "document_import", "title": body.get("title"),
                         "document_id": result.get("document_id")})
        return Resp(result, status=201)
    raise ApiError(400, "需要 path 或 text 字段", "MISSING_FIELD")


@route("/api/documents/{id}/reindex", "POST")
def api_documents_reindex(rt: Runtime, req: Request):
    doc_id = req.params["id"]
    store = rt.store()
    document = store.get_document(doc_id)
    if not document:
        raise ApiError(404, "文档不存在：%s" % doc_id, "DOCUMENT_NOT_FOUND")
    rel = str(document.get("path") or "")
    text = ""
    try:
        text = rt.module("vault").Vault(rt.paths.vault).read(rel)
    except Exception:  # noqa: BLE001
        candidate = rt.paths.vault / rel
        if candidate.exists():
            text = candidate.read_text(encoding="utf-8")
    if not text:
        raise ApiError(404, "原始文件不存在：%s" % rel, "RAW_NOT_FOUND")
    chunks = rt.module("ingest").chunk_text(text)
    count = store.replace_chunks(document["id"], chunks)
    _audit(rt, "document.reindex", document["id"], {"chunks": count})
    _emit("memory", {"action": "document_reindex", "document_id": document["id"],
                     "chunks": count})
    return {"ok": True, "document_id": document["id"], "chunks": count}


def _safe_name(name: str) -> str:
    base = os.path.basename(str(name or "upload.bin")).replace("\x00", "")
    cleaned = re.sub(r"[^0-9A-Za-z._\u4e00-\u9fff-]", "_", base).strip("._") or "upload.bin"
    return cleaned[-80:]


def _parse_multipart(content_type: str, body: bytes) -> list[tuple[str, str, bytes]]:
    match = re.search(r'boundary="?([^";]+)"?', content_type or "")
    if not match:
        raise ApiError(400, "multipart 缺少 boundary", "BAD_MULTIPART")
    boundary = b"--" + match.group(1).strip().encode("latin-1", "replace")
    out: list[tuple[str, str, bytes]] = []
    for part in body.split(boundary):
        if not part or part.strip(b"-\r\n") == b"":
            continue
        if b"\r\n\r\n" not in part:
            continue
        head, data = part.split(b"\r\n\r\n", 1)
        if data.endswith(b"\r\n"):
            data = data[:-2]
        name, filename = "", ""
        for line in head.decode("utf-8", "replace").split("\r\n"):
            if line.lower().startswith("content-disposition"):
                found = re.search(r'name="([^"]*)"', line)
                name = found.group(1) if found else ""
                found = re.search(r'filename="([^"]*)"', line)
                filename = found.group(1) if found else ""
        out.append((name, filename, data))
    return out


# ============================================================ 图
@route("/api/graph", "GET")
def api_graph(rt: Runtime, req: Request):
    view = str(req.q("view") or "semantic")
    if view not in ("semantic", "hierarchy", "timeline", "evidence"):
        raise ApiError(400, "view 必须是 semantic|hierarchy|timeline|evidence",
                       "BAD_PARAM", {"param": "view"})
    limit = req.qint("limit", 800, 1, 5000)
    graph = rt.store().graph(view, req.q("scope"), limit)
    graph.setdefault("meta", {})
    graph["meta"].setdefault("view", view)
    return graph


# ============================================================ 工作流
@route("/api/workflows", "GET")
def api_workflows(rt: Runtime, req: Request):
    workflows = rt.module("workflows")
    templates = workflows.list_templates(rt.store())
    return {"items": templates, "total": len(templates)}


@route("/api/workflows/{id}", "GET")
def api_workflow_get(rt: Runtime, req: Request):
    workflows = rt.module("workflows")
    template = workflows.get_template(rt.store(), req.params["id"])
    if not template:
        raise ApiError(404, "工作流模板不存在：%s" % req.params["id"], "TEMPLATE_NOT_FOUND")
    return template


@route("/api/workflows/{id}/run", "POST")
def api_workflow_run(rt: Runtime, req: Request):
    tid = req.params["id"]
    body = req.json(require=False)
    inputs = body.get("inputs") if isinstance(body.get("inputs"), dict) else {}
    scope = str(body.get("scope") or inputs.get("scope") or "global")
    workflows = rt.module("workflows")
    store = rt.store()
    emitter = eventbus.EventBus()
    bus = eventbus.subscribe(("run",))
    try:
        run = workflows.run_workflow(store, rt.gateway_or_none(), tid, inputs,
                                     scope=scope, trigger="api", emitter=emitter.put)
    except Exception as exc:  # noqa: BLE001
        bus.close()
        message = str(exc)
        if "不存在" in message or "not found" in message.lower():
            raise ApiError(404, "工作流模板不存在：%s" % tid, "TEMPLATE_NOT_FOUND") from None
        raise ApiError(503, "工作流执行失败：%s" % message, "WORKFLOW_FAILED") from None
    queued = bus.drain(limit=200)
    bus.close()
    _emit("run", {"run_id": run.get("id"), "template_id": tid,
                  "status": run.get("status"), "scope": scope,
                  "steps": len(run.get("steps") or [])})
    if queued:
        run = dict(run)
        run["emitted"] = len(queued)
    return Resp(run, status=201)


@route("/api/runs", "GET")
def api_runs(rt: Runtime, req: Request):
    workflows = rt.module("workflows")
    limit = req.qint("limit", 20, 1, 200)
    runs = workflows.list_runs(rt.store(), limit=limit, template_id=req.q("template_id"),
                               status=req.q("status"))
    return {"items": runs, "total": len(runs), "limit": limit}


@route("/api/runs/{id}", "GET")
def api_run_get(rt: Runtime, req: Request):
    workflows = rt.module("workflows")
    run = workflows.get_run(rt.store(), req.params["id"])
    if not run:
        raise ApiError(404, "运行记录不存在：%s" % req.params["id"], "RUN_NOT_FOUND")
    return run


@route("/api/runs/{id}/cancel", "POST")
def api_run_cancel(rt: Runtime, req: Request):
    workflows = rt.module("workflows")
    try:
        run = workflows.cancel_run(rt.store(), req.params["id"])
    except Exception as exc:  # noqa: BLE001
        raise ApiError(404, "取消失败：%s" % exc, "RUN_NOT_FOUND") from None
    _emit("run", {"run_id": req.params["id"], "status": (run or {}).get("status", "cancelled"),
                  "action": "cancel"})
    return run


# ============================================================ 模型
@route("/api/models", "GET")
def api_models(rt: Runtime, req: Request):
    try:
        gw = rt.gateway()
        profiles = [p.to_dict() for p in gw.profiles()]
        roles = gw.roles()
        health = gw.health()
        secrets = gw.list_secrets()
    except ApiError as exc:
        if exc.code not in ("MODELS_UNAVAILABLE", "MODULE_UNAVAILABLE"):
            raise
        return {"roles": {}, "by_role": {}, "profiles": [], "health": {},
                "degraded": ["chat", "embedding", "reranker", "judge"],
                "unavailable": ["models"], "note": exc.message}
    by_role: dict[str, list] = {}
    for profile in profiles:
        by_role.setdefault(str(profile.get("role")), []).append(profile)
    return {"roles": roles, "by_role": by_role, "profiles": profiles,
            "health": health, "secrets": secrets, "degraded": rt.degraded(),
            "count": len(profiles)}


MODEL_COLUMNS = ("id", "role", "label", "provider", "model", "base_url", "api_key_ref",
                 "dim", "batch", "timeout_ms", "params", "priority", "enabled", "created_at")


@route("/api/models", "POST")
def api_models_upsert(rt: Runtime, req: Request):
    body = req.json()
    if not str(body.get("role") or "").strip() or not str(body.get("model") or "").strip():
        raise ApiError(400, "role 与 model 必填", "MISSING_FIELD")
    gw = rt.gateway()
    store = rt.store()
    pid = str(body.get("id") or "").strip()
    role = str(body["role"]).strip()
    if not pid:
        pid = "%s-%s" % (role, re.sub(r"[^0-9A-Za-z._-]+", "-", str(body["model"]))[:40])
    params = body.get("params") if isinstance(body.get("params"), dict) else {}
    hint = ""
    api_key = str(body.get("api_key") or "")
    ref = str(body.get("api_key_ref") or ("model:%s" % pid))
    if api_key:
        hint = gw.set_secret(ref, api_key)
    row = {
        "id": pid, "role": role, "label": str(body.get("label") or pid),
        "provider": str(body.get("provider") or "openai-compatible"),
        "model": str(body["model"]),
        "base_url": body.get("base_url"),
        "api_key_ref": ref if (api_key or body.get("api_key_ref")) else None,
        "dim": body.get("dim"), "batch": int(body.get("batch") or 16),
        "timeout_ms": int(body.get("timeout_ms") or 60000),
        "params": dbmod.dumps(params), "priority": int(body.get("priority") or 0),
        "enabled": 1 if body.get("enabled", True) else 0,
        "created_at": _iso(),
    }
    columns = [c for c in MODEL_COLUMNS if c != "created_at"]
    assignments = ", ".join("%s = excluded.%s" % (c, c) for c in columns if c != "id")
    con = store.con
    try:
        con.execute("INSERT INTO model_profile(%s) VALUES(%s) ON CONFLICT(id) DO UPDATE SET %s"
                    % (", ".join(MODEL_COLUMNS), ", ".join("?" * len(MODEL_COLUMNS)),
                       assignments),
                    tuple(row[c] for c in MODEL_COLUMNS))
    except Exception as exc:  # noqa: BLE001
        raise ApiError(503, "模型档位写入失败：%s" % exc, "MODEL_WRITE_FAILED") from None
    _audit(rt, "model.upsert", pid, {"role": role, "model": row["model"]})
    saved = next((p.to_dict(with_secret=True, hint=hint) for p in gw.profiles()
                  if p.id == pid), None)
    if saved is None:
        saved = {"id": pid, "role": role, "model": row["model"]}
    saved["hint"] = hint
    return Resp({"profile": saved, "hint": hint, "note": "密钥只返回 hint，不回显明文"},
                status=201)


@route("/api/models/calls", "GET")
def api_models_calls(rt: Runtime, req: Request):
    limit = req.qint("limit", 50, 1, 500)
    gw = rt.gateway()
    calls = gw.calls(role=req.q("role"), limit=limit)
    return {"items": calls, "total": len(calls), "limit": limit}


@route("/api/models/{id}/test", "POST")
def api_models_test(rt: Runtime, req: Request):
    pid = req.params["id"]
    gw = rt.gateway()
    result = gw.test(pid)
    _emit("log", {"action": "model_test", "profile": pid,
                  "ok": bool(result.get("ok"))})
    if not result.get("ok") and str(result.get("mode")) == "unknown":
        raise ApiError(404, "模型档位不存在：%s" % pid, "PROFILE_NOT_FOUND")
    return result


# ============================================================ 算法目录
@route("/api/algorithms", "GET")
def api_algorithms(rt: Runtime, req: Request):
    items: list[dict] = []
    try:
        rows = _row_dicts(rt, "SELECT * FROM memory_algo ORDER BY category, name", (), 500)
        for row in rows:
            row["params"] = _json_field(row, "params", {})
            row["offline"] = bool(row.get("offline"))
            row["runnable"] = bool(row.get("runnable"))
            items.append(row)
    except Exception:  # noqa: BLE001
        items = []
    if not items:
        items = dbmod.read_builtin("algorithms.json") or []
    return {"items": items, "total": len(items)}


# ============================================================ 智能体
@route("/api/agents", "GET")
def api_agents(rt: Runtime, req: Request):
    agents_mod = rt.module("agents")
    items = agents_mod.agent_status(rt.store())
    return {"items": items, "total": len(items),
            "by_status": _count_by(items, "status")}


def _count_by(items: Iterable[dict], key: str) -> dict:
    out: dict[str, int] = {}
    for item in items:
        value = str(item.get(key) or "unknown")
        out[value] = out.get(value, 0) + 1
    return out


@route("/api/agents/probe", "POST")
def api_agents_probe(rt: Runtime, req: Request):
    agents_mod = rt.module("agents")
    body = req.json(require=False)
    agents_list = body.get("agents") if isinstance(body.get("agents"), list) else None
    result = agents_mod.probe_all(rt.store(), agents=agents_list)
    _emit("agent", {"action": "probe", "probed": len(result.get("results") or result or [])})
    return result


@route("/api/agents/heartbeat", "POST")
def api_agents_heartbeat(rt: Runtime, req: Request):
    body = req.json()
    agent_id = str(body.get("agent") or body.get("agent_id") or "").strip()
    if not agent_id:
        raise ApiError(400, "字段 agent 必填", "MISSING_FIELD", {"field": "agent"})
    payload = {"status": body.get("status") or "online",
               "detail": body.get("detail") if isinstance(body.get("detail"), dict) else {},
               "source": body.get("source") or "http"}
    agents_mod = rt.module("agents")
    result = agents_mod.heartbeat(rt.store(), agent_id, payload)
    _emit("agent", {"action": "heartbeat", "agent": agent_id,
                    "status": payload["status"]})
    return result


@route("/api/agents/{id}/config", "GET")
def api_agents_config(rt: Runtime, req: Request):
    agent_id = req.params["id"]
    agents_mod = rt.module("agents")
    items = agents_mod.agent_status(rt.store())
    agent = next((a for a in items if a.get("id") == agent_id), None)
    if not agent:
        raise ApiError(404, "智能体不存在：%s" % agent_id, "AGENT_NOT_FOUND")
    data_arg = str(rt.paths.root)
    stdio = {"command": "python", "args": ["-m", "memora_core", "--data", data_arg,
                                           "mcp-stdio"]}
    config = {
        "mcpServers": {"memora": dict(stdio)},
        "http": {"base_url": "http://127.0.0.1:%d" % getattr(rt, "port", DEFAULT_PORT),
                 "mcp": "POST /mcp", "rest": "/api/*", "sse": "/api/events"},
    }
    return {"agent": agent_id, "display_name": agent.get("display_name"),
            "ecosystem": agent.get("ecosystem"), "protocols": agent.get("protocols") or [],
            "config": config, "hint": agent.get("config_hint") or "",
            "status": agent.get("status")}


# ============================================================ 冲突 / 任务 / 设置 / 交换
@route("/api/conflicts", "GET")
def api_conflicts(rt: Runtime, req: Request):
    status = req.q("status")
    limit, offset = _paginate(req)
    if status:
        rows = _row_dicts(rt, "SELECT * FROM conflict WHERE status = ? "
                              "ORDER BY created_at DESC LIMIT ? OFFSET ?",
                          (status, limit, offset), limit)
    else:
        rows = _row_dicts(rt, "SELECT * FROM conflict ORDER BY created_at DESC "
                              "LIMIT ? OFFSET ?", (limit, offset), limit)
    for row in rows:
        row["detail"] = _json_field(row, "detail", {})
    total = 0
    try:
        con = rt.store().con
        total = int(con.execute("SELECT count(*) FROM conflict").fetchone()[0])
    except Exception:  # noqa: BLE001
        total = len(rows)
    return {"items": rows, "total": total, "limit": limit, "offset": offset}


@route("/api/conflicts/{id}/resolve", "POST")
def api_conflicts_resolve(rt: Runtime, req: Request):
    cid = req.params["id"]
    body = req.json(require=False)
    resolution = body.get("resolution") or body.get("note") or body
    try:
        result = rt.store().resolve_conflict(cid, resolution)
    except KeyError:
        raise ApiError(404, "冲突不存在：%s" % cid, "CONFLICT_NOT_FOUND") from None
    _emit("log", {"action": "conflict_resolve", "conflict_id": cid})
    return result


@route("/api/jobs", "GET")
def api_jobs(rt: Runtime, req: Request):
    limit, offset = _paginate(req)
    rows = _row_dicts(rt, "SELECT * FROM job ORDER BY created_at DESC LIMIT ? OFFSET ?",
                      (limit, offset), limit)
    for row in rows:
        row["payload"] = _json_field(row, "payload", {})
    return {"items": rows, "total": len(rows), "limit": limit, "offset": offset,
            "by_status": _count_by(rows, "status")}


@route("/api/jobs/{id}/retry", "POST")
def api_jobs_retry(rt: Runtime, req: Request):
    job_id = req.params["id"]
    store = rt.store()
    con = store.con
    row = con.execute("SELECT * FROM job WHERE id = ?", (job_id,)).fetchone()
    if row is None:
        raise ApiError(404, "任务不存在：%s" % job_id, "JOB_NOT_FOUND")
    stamp = _iso()
    with store._txn() as conn:
        conn.execute("UPDATE job SET status = 'queued', run_after = ?, last_error = NULL, "
                     "updated_at = ? WHERE id = ?", (stamp, stamp, job_id))
        conn.execute(
            "INSERT INTO audit(id, at, actor, action, target, detail) VALUES(?,?,?,?,?,?)",
            ("a-" + os.urandom(6).hex(), stamp, "api", "job.retry", job_id, "{}"))
    _audit(rt, "job.retry", job_id, {"previous": row["status"]})
    _emit("log", {"action": "job_retry", "job_id": job_id})
    return {"ok": True, "job_id": job_id, "status": "queued", "requeued_at": stamp}


@route("/api/exchange/export", "GET")
def api_exchange_export(rt: Runtime, req: Request):
    exchange = rt.module("exchange")
    scope = req.q("scope") or None
    status = req.q("status") or "approved"
    text = exchange.export_jsonl(rt.store(), scope=scope, status=status)
    if str(req.q("format") or "").lower() == "json":
        return {"schema": getattr(exchange, "EXCHANGE_SCHEMA", "memora-exchange/1"),
                "scope": scope, "status": status,
                "count": len([line for line in text.splitlines() if line.strip()]),
                "jsonl": text}
    return Resp(text, headers={"X-Exchange-Schema":
                               str(getattr(exchange, "EXCHANGE_SCHEMA", ""))},
                content_type=NDJSON_TYPE)


@route("/api/exchange/import", "POST")
def api_exchange_import(rt: Runtime, req: Request):
    exchange = rt.module("exchange")
    text = req.text()
    body: dict = {}
    stripped = text.strip()
    if stripped.startswith("{"):
        try:
            parsed = json.loads(stripped)
        except ValueError:
            parsed = None
        if isinstance(parsed, dict) and not parsed.get("schema") == "JSONRPC":
            body = parsed if ("jsonl" in parsed or "records" in parsed) else {}
    payload = body.get("jsonl") or body.get("text")
    if payload is None and body.get("records") is not None:
        payload = "\n".join(json.dumps(r, ensure_ascii=False)
                            for r in body["records"] if isinstance(r, dict))
    if payload is None:
        payload = text
    if not str(payload).strip():
        raise ApiError(400, "导入内容为空", "EMPTY_BODY")
    scope = str(body.get("scope") or req.q("scope") or "global")
    agent_id = body.get("agent") or body.get("agent_id")
    result = exchange.import_jsonl(rt.store(), str(payload), agent_id=agent_id,
                                   scope=scope,
                                   dry_run=bool(body.get("dry_run")))
    _emit("memory", {"action": "exchange_import", "scope": scope,
                     "result": {k: result[k] for k in list(result)[:5]}})
    return result


@route("/api/settings", "GET")
def api_settings_get(rt: Runtime, req: Request):
    rows = _row_dicts(rt, "SELECT key, value FROM setting ORDER BY key", (), 500)
    values = {row["key"]: dbmod.loads(row["value"], row["value"]) for row in rows}
    return {"values": values, "total": len(values),
            "runtime": {"version": VERSION, "data_dir": str(rt.paths.root),
                        "port": getattr(rt, "port", DEFAULT_PORT),
                        "host": getattr(rt, "host", DEFAULT_HOST)}}


@route("/api/settings", "POST")
def api_settings_set(rt: Runtime, req: Request):
    body = req.json()
    store = rt.store()
    values = body.get("values") if isinstance(body.get("values"), dict) else None
    if values is None:
        if "key" in body:
            values = {str(body["key"]): body.get("value")}
        elif body.get("settings") and isinstance(body["settings"], dict):
            values = body["settings"]
        else:
            values = {str(k): v for k, v in body.items()
                      if k not in ("key", "value", "settings")}
    if not values:
        raise ApiError(400, "需要 key/value 或 values 对象", "MISSING_FIELD")
    for key, value in values.items():
        store.set_setting(str(key), value)
    _audit(rt, "setting.set", None, {"keys": sorted(values)})
    return {"ok": True, "updated": sorted(values), "count": len(values)}


# ============================================================ MCP over HTTP
@route("/mcp", "POST")
def api_mcp(rt: Runtime, req: Request):
    mcp_mod = rt.module("mcp")
    handler = getattr(mcp_mod, "handle_http", None)
    if not callable(handler):
        raise ApiError(503, "MCP HTTP 接口不可用：mcp.handle_http 未实现", "MCP_UNAVAILABLE")
    body = req.json()
    headers = {str(k): str(v) for k, v in req.headers.items()}
    try:
        result = handler(rt.store(), rt.gateway_or_none(), body, headers)
    except Exception as exc:  # noqa: BLE001
        raise ApiError(500, "MCP 调用失败：%s" % exc, "MCP_ERROR") from None
    if result is None:
        return Resp({"ok": True, "accepted": True}, status=202)
    return result


# ============================================================ 静态资源
def _safe_static_path(rt: Runtime, raw_path: str) -> tuple[Path | None, str | None]:
    """把 URL 路径解析成 static 下的真实文件；任何越界都返回 (None, 原因)。"""
    decoded = urllib.parse.unquote(raw_path or "")
    if "%" in decoded:  # 二次编码：再解一次，用于判定而不是用于拼接
        decoded = urllib.parse.unquote(decoded)
    if "\x00" in decoded or "\r" in decoded or "\n" in decoded:
        return None, "非法字符"
    normalized = decoded.replace("\\", "/")
    if normalized.startswith("/"):
        normalized = normalized[1:]
    if ".." in normalized.split("/"):
        return None, "路径穿越"
    if normalized.startswith("/") or re.match(r"^[A-Za-z]:", normalized):
        return None, "绝对路径"
    relative = normalized or STATIC_INDEX
    if relative.endswith("/"):
        relative += STATIC_INDEX
    if relative in ("brain", "brain/"):
        relative = STATIC_BRAIN
    root = rt.static_dir.resolve()
    target = (root / relative).resolve()
    try:
        if root != target and root not in target.parents:
            return None, "越出静态目录"
    except (OSError, ValueError):
        return None, "非法路径"
    return target, None


def _accepts_html(headers: Any) -> bool:
    return "text/html" in str(headers.get("Accept") or "").lower()


# ============================================================ HTTP 处理器
class MemoraHandler(BaseHTTPRequestHandler):
    """单个 TCP 连接上的请求处理器（keep-alive 复用，受 MAX_REQUESTS_PER_CONN 限制）。"""

    protocol_version = "HTTP/1.1"
    server_version = "memora-core/" + VERSION
    sys_version = ""
    timeout = 60

    runtime: Runtime  # 由 MemoraHTTPServer 注入（见 __init__）

    def __init__(self, request: Any, client_address: Any, server: Any) -> None:
        # BaseHTTPRequestHandler.__init__ 会立刻开始处理请求，所以 runtime 必须先挂上
        self.runtime = server.runtime
        self._served = 0
        self._responded = False
        super().__init__(request, client_address, server)

    # -- 日志 -----------------------------------------------------
    def log_message(self, fmt: str, *args: Any) -> None:  # noqa: D102
        try:
            self.runtime.log_line("%s %s" % (self.address_string(), fmt % args))
        except Exception:  # noqa: BLE001
            pass

    def log_error(self, fmt: str, *args: Any) -> None:  # noqa: D102
        self.log_message(fmt, *args)

    # -- HTTP 方法 ------------------------------------------------
    def do_GET(self) -> None:  # noqa: N802
        self._handle("GET")

    def do_HEAD(self) -> None:  # noqa: N802
        self._handle("HEAD")

    def do_POST(self) -> None:  # noqa: N802
        self._handle("POST")

    def do_PATCH(self) -> None:  # noqa: N802
        self._handle("PATCH")

    def do_PUT(self) -> None:  # noqa: N802
        self._handle("PUT")

    def do_DELETE(self) -> None:  # noqa: N802
        self._handle("DELETE")

    def do_OPTIONS(self) -> None:  # noqa: N802
        self._handle("OPTIONS")

    # -- 主流程 ---------------------------------------------------
    def _handle(self, method: str) -> None:
        rt = self.runtime
        self._served = getattr(self, "_served", 0) + 1
        rt.enter()
        try:
            if self._served > MAX_REQUESTS_PER_CONN:
                self.close_connection = True
                self._send_json(503, {"error": "单连接请求数超限，请重连",
                                      "code": "TOO_MANY_REQUESTS"}, close=True)
                return
            if self._served >= MAX_REQUESTS_PER_CONN:
                self.close_connection = True  # 本连接最后一帧，响应头带 Connection: close
            if not self._host_ok():
                self._send_json(403, {"error": "Host 头不被允许（仅支持回环地址）",
                                      "code": "BAD_HOST"}, close=True)
                return
            parsed = urllib.parse.urlsplit(self.path)
            raw_path = parsed.path or "/"
            if "\x00" in raw_path or "\r" in raw_path or "\n" in raw_path:
                self._send_json(400, {"error": "非法请求路径", "code": "BAD_PATH"})
                return
            path = urllib.parse.unquote(raw_path)
            if path.startswith("/api/") or path in ("/api", "/mcp"):
                self._dispatch_api(method, path, parsed.query)
            else:
                self._serve_static(method, path, raw_path)
        except ApiError as exc:
            if not self._responded:
                self._send_json(exc.status, exc.payload(), extra_headers=exc.headers)
            else:
                self.close_connection = True
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            self.close_connection = True
        except Exception as exc:  # noqa: BLE001 - 兜底：绝不泄露堆栈
            self.runtime.log_line("ERROR %s %s: %s" % (type(exc).__name__, self.path, exc))
            try:
                self._send_json(500, {"error": "服务内部错误", "code": "INTERNAL_ERROR"},
                                close=True)
            except Exception:  # noqa: BLE001
                self.close_connection = True
            if os.environ.get("MEMORA_DEBUG"):
                traceback.print_exc()
        finally:
            rt.leave()

    def _host_ok(self) -> bool:
        raw = str(self.headers.get("Host") or "").strip()
        if not raw:
            return True  # HTTP/1.0 客户端可能没有 Host，放行（仍只绑回环）
        host = raw.lower()
        port = getattr(self.runtime, "port", DEFAULT_PORT)
        allowed = {"127.0.0.1:%d" % port, "localhost:%d" % port, "[::1]:%d" % port,
                   "127.0.0.1", "localhost", "[::1]"}
        return host in allowed

    # -- API 分发 -------------------------------------------------
    def _dispatch_api(self, method: str, path: str, query: str) -> None:
        rt = self.runtime
        lookup_method = "GET" if method == "HEAD" else method
        handler, params, known = MATCHER.match(path, lookup_method)
        if handler is None:
            if known and method != "OPTIONS":
                allowed = methods_for(path)
                raise ApiError(405, "方法不被允许：%s %s" % (method, path), "METHOD_NOT_ALLOWED",
                               headers={"Allow": ", ".join(allowed) or "GET"})
            if method == "OPTIONS":
                allowed = methods_for(path)
                if allowed:
                    self._send_bytes(204, b"", extra_headers={"Allow": ", ".join(allowed)},
                                     compress=False)
                    return
            raise ApiError(404, "未知接口：%s" % path, "NOT_FOUND")
        if method == "OPTIONS":
            allowed = methods_for(path)
            self._send_bytes(204, b"", extra_headers={"Allow": ", ".join(allowed)},
                             compress=False)
            return
        if path == "/api/events" and method in ("GET", "HEAD"):
            self._serve_events(Request(method, path, query, self.headers, params, b"", rt))
            return
        body = b""
        if method in ("POST", "PUT", "PATCH"):
            ctype = str(self.headers.get("Content-Type") or "").lower()
            has_body = self.headers.get("Content-Length") not in (None, "0")
            if has_body:
                is_json = ctype.startswith("application/json")
                is_form = ctype.startswith("multipart/form-data") and path.endswith("/import")
                if not (is_json or is_form):
                    raise ApiError(400, "写操作必须使用 Content-Type: application/json",
                                   "BAD_CONTENT_TYPE")
            body = self._read_body()
        request = Request(method, path, query, self.headers, params, body, rt)
        result = handler(rt, request)
        self._send_result(result)

    def _read_body(self) -> bytes:
        header = self.headers.get("Content-Length")
        if header is None:
            return b""
        try:
            length = int(header)
        except (TypeError, ValueError):
            self.close_connection = True
            raise ApiError(400, "Content-Length 非法", "BAD_LENGTH") from None
        if length < 0:
            self.close_connection = True
            raise ApiError(400, "Content-Length 非法", "BAD_LENGTH")
        if length > MAX_BODY:
            # 先把已到达的数据读掉，否则客户端会收到 RST 而不是 413
            self._drain(length)
            self.close_connection = True
            raise ApiError(413, "请求体过大（上限 %d 字节）" % MAX_BODY, "BODY_TOO_LARGE")
        if length == 0:
            return b""
        data = self.rfile.read(length)
        if len(data) != length:
            self.close_connection = True
            raise ApiError(400, "请求体不完整", "SHORT_BODY")
        return data

    def _drain(self, declared: int) -> None:
        """丢弃超大请求体（有上限），让客户端能正常读到 413 而不是连接被重置。"""
        remaining = min(max(0, declared), MAX_BODY * 2)
        while remaining > 0:
            try:
                chunk = self.rfile.read(min(65536, remaining))
            except OSError:
                return
            if not chunk:
                return
            remaining -= len(chunk)

    # -- 静态资源 -------------------------------------------------
    def _serve_static(self, method: str, path: str, raw_path: str) -> None:
        rt = self.runtime
        if method not in ("GET", "HEAD"):
            raise ApiError(405, "静态资源只支持 GET/HEAD", "METHOD_NOT_ALLOWED",
                           headers={"Allow": "GET, HEAD"})
        target, reason = _safe_static_path(rt, raw_path)
        if target is None:
            raise ApiError(400, "非法静态路径：%s" % (reason or ""), "BAD_PATH")
        content_type = CONTENT_TYPES.get(target.suffix.lower())
        if not target.is_file():
            # SPA 回退：未命中且浏览器要 HTML 时，/brain/* 回脑图页，其余回主应用
            if _accepts_html(self.headers) or path.strip("/") in ("", "brain"):
                fallback = STATIC_BRAIN if path.strip("/").startswith("brain") else STATIC_INDEX
                target = (rt.static_dir / fallback).resolve()
                content_type = CONTENT_TYPES[".html"]
            else:
                raise ApiError(404, "静态资源不存在：%s" % path, "NOT_FOUND")
        try:
            data = target.read_bytes()
        except OSError:
            raise ApiError(404, "静态资源不存在：%s" % path, "NOT_FOUND") from None
        rt.static_hits += 1
        suffix_type = content_type or CONTENT_TYPES.get(target.suffix.lower(),
                                                        "application/octet-stream")
        headers = {"X-Static-Path": target.name}
        if method == "HEAD":
            self._send_headers(200, suffix_type, len(data), headers)
            return
        self._send_bytes(200, data, content_type=suffix_type, extra_headers=headers,
                         compress=target.suffix.lower() not in (".png", ".ico", ".woff2"))

    # -- SSE ------------------------------------------------------
    def _serve_events(self, req: Request) -> None:
        rt = self.runtime
        types = None
        raw_types = req.q("types") or req.q("type")
        if raw_types:
            types = tuple(t.strip() for t in str(raw_types).split(",") if t.strip())
        bus = eventbus.subscribe(types)
        rt.sse_clients += 1
        deadline = time.monotonic() + SSE_MAX_LIFETIME
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self.send_header("X-Accel-Buffering", "no")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            # SSE 是无限流：用 Connection: close 分帧，不能带 Content-Length。
            self.close_connection = True
            self._sse_write("retry: 3000\n\n")
            backlog = eventbus.recent(SSE_BACKLOG, types)
            if not backlog:
                backlog = [eventbus.normalize({"type": "heartbeat", "data": {
                    "reason": "connected", "uptime_s": rt.uptime()}})]
            for event in backlog:
                self._sse_write(eventbus.sse_frame(event))
            last_beat = time.monotonic()
            while not rt.shutdown.is_set() and time.monotonic() < deadline:
                if bus.wait(SSE_POLL_SECONDS):
                    for event in bus.drain(limit=64):
                        self._sse_write(eventbus.sse_frame(event))
                if self._client_gone():
                    break                       # 客户端断开：立刻退订，不留订阅泄漏
                if time.monotonic() - last_beat >= HEARTBEAT_SECONDS:
                    self._sse_write(eventbus.sse_comment("ping"))
                    last_beat = time.monotonic()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
            pass
        finally:
            rt.sse_clients = max(0, rt.sse_clients - 1)
            eventbus.unsubscribe(bus)
            self.close_connection = True

    def _client_gone(self) -> bool:
        """非阻塞地判断对端是否已关闭（select 可读 + MSG_PEEK 读到 EOF）。"""
        try:
            ready, _, _ = select.select([self.connection], [], [], 0)
            if not ready:
                return False
            peeked = self.connection.recv(1, socket.MSG_PEEK)
            return peeked == b""
        except (OSError, ValueError):
            return True

    def _sse_write(self, text: str) -> None:
        payload = text.encode("utf-8")
        self.wfile.write(payload)
        self.wfile.flush()

    # -- 响应输出 -------------------------------------------------
    def _send_result(self, result: Any) -> None:
        if result is None:
            self._send_bytes(204, b"", extra_headers=None, compress=False)
            return
        if isinstance(result, Resp):
            status = result.status
            payload = result.payload
            headers = dict(result.headers)
            if result.content_type:
                headers.setdefault("Content-Type", result.content_type)
            if isinstance(payload, (bytes, bytearray)):
                self._send_bytes(status, bytes(payload), content_type=result.content_type,
                                 extra_headers=headers)
                return
            if isinstance(payload, str):
                self._send_bytes(status, payload.encode("utf-8"),
                                 content_type=result.content_type or "text/plain; charset=utf-8",
                                 extra_headers=headers)
                return
            self._send_json(status, payload, extra_headers=headers)
            return
        self._send_json(200, result)

    def _send_json(self, status: int, payload: Any, extra_headers: dict | None = None,
                   close: bool = False, status_override: int | None = None) -> None:
        body = b"" if payload is None else json.dumps(
            payload, ensure_ascii=False, default=str, separators=(",", ":")
        ).encode("utf-8")
        self._send_bytes(status_override or status, body, content_type=JSON_TYPE,
                         extra_headers=extra_headers, close=close)

    def _send_headers(self, status: int, content_type: str, length: int,
                      extra_headers: dict | None = None, close: bool = False,
                      encoded: bool = False, vary: bool = False) -> None:
        self.send_response_only(status)
        self.send_header("Date", self.date_time_string())
        self.send_header("Server", self.version_string())
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(max(0, length)))
        if encoded:
            self.send_header("Content-Encoding", "gzip")
        if vary:
            self.send_header("Vary", "Accept-Encoding")
        for key, value in SECURITY_HEADERS.items():
            self.send_header(key, value)
        for key, value in (extra_headers or {}).items():
            self.send_header(str(key), str(value))
        if close or getattr(self, "close_connection", False):
            self.send_header("Connection", "close")
            self.close_connection = True
        else:
            self.send_header("Connection", "keep-alive")
        self.end_headers()
        self._responded = True

    def _send_bytes(self, status: int, body: bytes, content_type: str = JSON_TYPE,
                    extra_headers: dict | None = None, compress: bool = True,
                    close: bool = False) -> None:
        encoded = False
        body = body or b""
        if (compress and len(body) >= GZIP_MIN_BYTES
                and "gzip" in str(self.headers.get("Accept-Encoding") or "").lower()):
            body = gzip.compress(body, compresslevel=6)
            encoded = True
        self._send_headers(status, content_type, len(body), extra_headers, close=close,
                           encoded=encoded, vary=compress)
        if getattr(self, "command", "") == "HEAD" or status == 204 or status == 304:
            return
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True


class MemoraHTTPServer(ThreadingHTTPServer):
    """线程化 HTTP 服务；SSE 长连接与普通请求共用线程池。"""

    daemon_threads = True
    allow_reuse_address = True
    request_queue_size = 256          # >= 128：高并发下不丢连接

    def __init__(self, address: tuple[str, int], runtime: Runtime,
                 handler: type[MemoraHandler] = MemoraHandler) -> None:
        self.runtime = runtime
        self.handler_class = handler
        runtime.port = int(address[1])
        runtime.host = str(address[0])
        super().__init__(address, handler)

    def server_bind(self) -> None:
        """跳过 getfqdn 的反查（Windows 上可能阻塞数秒），其余与 TCPServer.server_bind 一致。

        SO_REUSEADDR 在 Windows 上语义不同（WinError 10022），只在非 Windows 上设置；
        socketserver 的 allow_reuse_address 已经在跨平台范围内处理了常规场景。
        """
        if os.name != "nt" and self.allow_reuse_address:
            try:
                self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            except OSError:
                pass
        self.socket.bind(self.server_address)
        self.server_address = self.socket.getsockname()
        host, port = self.server_address[:2]
        self.server_name = host
        self.server_port = port

    def handle_error(self, request, client_address) -> None:  # noqa: D102
        self.runtime.log_line("ERROR 处理请求失败：%s" % (client_address,))


# ============================================================ 组装与启动
def register_events_route() -> None:
    """SSE 路由单独挂载（它不走 JSON 响应管线，需要直写 socket）。"""


@route("/api/events", "GET")
def api_events(rt: Runtime, req: Request):
    raise ApiError(500, "SSE 由连接层直接处理", "INTERNAL_ERROR")


_rebuild_matcher()

# 供 selftest / 文档使用的稳定路由清单：[(路径, 方法), ...]
ROUTES: list[tuple[str, str]] = [(path, method) for path, method, _fn in _RAW_ROUTES]


def routes() -> list[tuple[str, str]]:
    return list(ROUTES)


def create_server(rt: Runtime, host: str = DEFAULT_HOST,
                  port: int = DEFAULT_PORT) -> MemoraHTTPServer:
    """建服务但不 serve_forever（测试可以直接拿到 httpd）。"""
    if host not in LOOPBACK_HOSTS:
        raise ValueError("只允许绑定回环地址（127.0.0.1 / localhost / ::1），收到：%s" % host)
    dbmod.init_db(rt.paths.db)
    httpd = MemoraHTTPServer((host, port), rt)
    rt.port = int(httpd.server_address[1])
    rt.host = host
    return httpd


def serve(paths: Paths, port: int = DEFAULT_PORT, host: str = DEFAULT_HOST,
          open_ui: bool = False) -> int:
    """启动 HTTP 服务。返回进程退出码（0 正常退出）。"""
    if host not in LOOPBACK_HOSTS:
        print("拒绝启动：只允许绑定回环地址（收到 %s）" % host, flush=True)
        return 2
    try:
        paths.ensure()
    except OSError as exc:
        print("数据目录不可用：%s" % exc, flush=True)
        return 2
    dbmod.init_db(paths.db)                      # 启动前初始化数据库（幂等）
    rt = Runtime(paths)
    report = rt.bootstrap()                      # 内置模板/智能体/算法（失败不阻塞）
    try:
        httpd = create_server(rt, host=host, port=port)
    except OSError as exc:
        print("端口 %d 无法监听：%s" % (port, exc), flush=True)
        return 1
    url = "http://127.0.0.1:%d" % rt.port
    print("Memora-Core 已启动: %s" % url, flush=True)
    if report.get("errors"):
        rt.log_line("bootstrap warnings: %s" % "; ".join(report["errors"]))
    _emit("system", {"action": "serve_start", "url": url, "version": VERSION})
    if open_ui:
        threading.Thread(target=_open_browser, args=(url,), daemon=True).start()
    try:
        httpd.serve_forever(poll_interval=0.2)
    except KeyboardInterrupt:
        print("\n收到中断信号，正在优雅退出…", flush=True)
    finally:
        graceful_shutdown(httpd, rt, timeout=5.0)
    return 0


def _open_browser(url: str) -> None:
    try:
        webbrowser.open(url + "/")
    except Exception:  # noqa: BLE001
        pass


def graceful_shutdown(httpd: MemoraHTTPServer, rt: Runtime, timeout: float = 5.0) -> None:
    """关闭监听 → 通知 SSE 断开 → 等待在途请求（不超过 timeout 秒）。"""
    rt.shutdown.set()
    try:
        httpd.shutdown()
    except Exception:  # noqa: BLE001
        pass
    deadline = time.monotonic() + max(0.0, float(timeout))
    while rt.active > 0 and time.monotonic() < deadline:
        time.sleep(0.05)
    try:
        httpd.server_close()
    except Exception:  # noqa: BLE001
        pass


def main(argv: Iterable[str] | None = None) -> int:  # pragma: no cover - 便捷入口
    import argparse
    parser = argparse.ArgumentParser(prog="memora_core.server")
    parser.add_argument("--data", default=None)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--open", action="store_true")
    args = parser.parse_args(list(argv or []))
    return serve(Paths(args.data), port=args.port, host=args.host, open_ui=args.open)


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
