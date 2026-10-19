# -*- coding: utf-8 -*-
"""tests/test_server.py — HTTP API 服务端：路由、安全、SSE、静态、容错。

覆盖：
  1. 路由表与匹配器（字面段优先、405、参数提取）
  2. 安全基线（Host 校验、路径穿越、Content-Type、请求体上限、错误不泄露堆栈）
  3. 静态托管（index / SPA 回退 / gzip / 未命中 404）
  4. 全部核心 API 的真实往返
  5. SSE 真收一帧 + 断开后订阅被清理
  6. 依赖模块缺失时服务不倒、health 如实降级、相关端点 503
  7. serve() 真启动：init_db、启动横幅、Ctrl+C 优雅退出
"""
from __future__ import annotations

import http.client
import io
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from memora_core import __version__
from memora_core import db as dbmod
from memora_core import events as eventbus
from memora_core import server
from memora_core.paths import Paths

REPO = Path(__file__).resolve().parent.parent


# ============================================================ 基础设施
class _BlockFinder:
    """模拟"某个子模块被改名/删除"：在 import 系统层面直接抛 ImportError。"""

    def __init__(self, targets: tuple[str, ...]) -> None:
        self.targets = tuple("memora_core." + t for t in targets)

    def find_spec(self, name, path=None, target=None):  # noqa: D102
        for blocked in self.targets:
            if name == blocked or name.startswith(blocked + "."):
                raise ImportError("模拟模块缺失：%s 不可用" % name)
        return None


def urlencode_query(path: str) -> str:
    """把含中文的路径/查询串安全编码（只保留下 URL 结构字符）。"""
    return urllib.parse.quote(path, safe="/?=&%:")


class ServerCase(unittest.TestCase):
    """起一台真服务（端口 0 由系统分配），整个测试类共用。"""

    bootstrap = True

    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = Path(tempfile.mkdtemp(prefix="memora-server-test-"))
        cls.paths = Paths(cls.tmp).ensure()
        dbmod.init_db(cls.paths.db)
        cls.runtime = server.Runtime(cls.paths)
        if cls.bootstrap:
            cls.runtime.bootstrap()
        cls.httpd = server.create_server(cls.runtime, port=0)
        cls.port = cls.runtime.port
        cls.base = "http://127.0.0.1:%d" % cls.port
        cls.thread = threading.Thread(
            target=cls.httpd.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls) -> None:
        server.graceful_shutdown(cls.httpd, cls.runtime, timeout=3.0)
        shutil.rmtree(cls.tmp, ignore_errors=True)

    # -- 请求助手 -------------------------------------------------
    def call(self, method: str, path: str, body=None, ctype: str = "application/json",
             headers: dict | None = None, timeout: float = 20.0) -> tuple[int, dict, bytes]:
        data = None
        if body is not None:
            data = body if isinstance(body, bytes) else json.dumps(
                body, ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(self.base + urlencode_query(path),
                                         data=data, method=method)
        if data is not None:
            request.add_header("Content-Type", ctype)
        for key, value in (headers or {}).items():
            request.add_header(key, value)
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return response.status, dict(response.headers), response.read()
        except urllib.error.HTTPError as exc:
            return exc.code, dict(exc.headers), exc.read()

    def get_json(self, path: str, **kwargs) -> tuple[int, dict]:
        status, headers, raw = self.call("GET", path, **kwargs)
        self.assertIn("application/json", headers.get("Content-Type", ""))
        return status, json.loads(raw.decode("utf-8"))


# ============================================================ 1. 路由表与匹配器
class RouteTableTest(unittest.TestCase):
    def test_routes_exported_and_shaped(self):
        self.assertGreaterEqual(len(server.ROUTES), 30, "路由数量应覆盖文档里的全部端点")
        for item in server.ROUTES:
            self.assertIsInstance(item, tuple)
            self.assertEqual(len(item), 2)
            path, method = item
            self.assertTrue(path.startswith("/"), path)
            self.assertIn(method, ("GET", "POST", "PATCH", "DELETE", "PUT", "HEAD"))

    def test_documented_endpoints_present(self):
        routes = set(server.ROUTES)
        required = {
            ("/api/health", "GET"), ("/api/overview", "GET"), ("/api/events", "GET"),
            ("/api/memories", "GET"), ("/api/memories", "POST"),
            ("/api/memories/{id}", "GET"), ("/api/memories/{id}", "PATCH"),
            ("/api/memories/{id}", "DELETE"), ("/api/memories/{id}/review", "POST"),
            ("/api/memories/{id}/approve", "POST"), ("/api/memories/{id}/reject", "POST"),
            ("/api/memories/{id}/evidence", "GET"), ("/api/memories/{id}/evidence", "POST"),
            ("/api/search", "GET"), ("/api/recall", "POST"),
            ("/api/documents", "GET"), ("/api/documents/{id}", "GET"),
            ("/api/documents/{id}/raw", "GET"), ("/api/documents/import", "POST"),
            ("/api/documents/{id}/reindex", "POST"),
            ("/api/graph", "GET"), ("/api/workflows", "GET"),
            ("/api/workflows/{id}", "GET"), ("/api/workflows/{id}/run", "POST"),
            ("/api/runs", "GET"), ("/api/runs/{id}", "GET"), ("/api/runs/{id}/cancel", "POST"),
            ("/api/models", "GET"), ("/api/models", "POST"),
            ("/api/models/{id}/test", "POST"), ("/api/models/calls", "GET"),
            ("/api/algorithms", "GET"), ("/api/agents", "GET"),
            ("/api/agents/probe", "POST"), ("/api/agents/heartbeat", "POST"),
            ("/api/agents/{id}/config", "GET"),
            ("/api/conflicts", "GET"), ("/api/conflicts/{id}/resolve", "POST"),
            ("/api/jobs", "GET"), ("/api/jobs/{id}/retry", "POST"),
            ("/api/exchange/export", "GET"), ("/api/exchange/import", "POST"),
            ("/api/settings", "GET"), ("/api/settings", "POST"),
            ("/mcp", "POST"),
        }
        missing = required - routes
        self.assertFalse(missing, "缺少路由：%s" % sorted(missing))

    def test_no_duplicate_route(self):
        self.assertEqual(len(server.ROUTES), len(set(server.ROUTES)))

    def test_matcher_prefers_literal_segment(self):
        handler, params, known = server.MATCHER.match("/api/documents/import", "POST")
        self.assertTrue(known)
        self.assertIsNotNone(handler)
        self.assertEqual(params, {})
        self.assertEqual(handler.__name__, "api_documents_import")

    def test_matcher_extracts_path_params(self):
        handler, params, _ = server.MATCHER.match("/api/memories/m-abc123", "GET")
        self.assertEqual(params, {"id": "m-abc123"})
        self.assertEqual(handler.__name__, "api_memories_get")

    def test_matcher_detects_wrong_method(self):
        handler, _params, known = server.MATCHER.match("/api/health", "DELETE")
        self.assertIsNone(handler)
        self.assertTrue(known, "路径存在但方法不匹配时应能识别（用于返回 405）")
        self.assertEqual(server.methods_for("/api/health"), ["GET"])

    def test_unknown_path_not_known(self):
        handler, _params, known = server.MATCHER.match("/api/does-not-exist", "GET")
        self.assertIsNone(handler)
        self.assertFalse(known)


# ============================================================ 2/3. 安全与静态
class SecurityTest(ServerCase):
    def test_host_header_rejected(self):
        status, headers, raw = self.call("GET", "/api/health",
                                         headers={"Host": "evil.example.com"})
        self.assertEqual(status, 403)
        self.assertIn("application/json", headers["Content-Type"])
        self.assertEqual(json.loads(raw.decode())["code"], "BAD_HOST")

    def test_host_header_localhost_allowed(self):
        status, _headers, raw = self.call("GET", "/api/health",
                                          headers={"Host": "localhost:%d" % self.port})
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(raw.decode())["ok"])

    def test_security_headers_present(self):
        _status, headers, _raw = self.call("GET", "/api/health")
        self.assertIn("default-src 'self'", headers["Content-Security-Policy"])
        self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(headers["Referrer-Policy"], "no-referrer")
        self.assertIn("Content-Length", headers, "keep-alive 必须有显式 Content-Length")

    def test_path_traversal_blocked(self):
        for path in ("/../../etc/passwd", "/../memora_core/server.py",
                     "/%2e%2e%2f%2e%2e%2fetc%2fpasswd", "/....//....//etc/passwd",
                     "/C:/Windows/win.ini", "/%252e%252e%252fetc%252fpasswd",
                     "/brain/../../server.py"):
            status, _headers, raw = self.call("GET", path)
            self.assertIn(status, (400, 404), "%s 返回了 %s" % (path, status))
            text = raw.decode("utf-8", "replace")
            self.assertNotIn("root:", text)
            self.assertNotIn("import gzip", text)

    def test_write_requires_json_content_type(self):
        status, _headers, raw = self.call("POST", "/api/memories", "title=x",
                                          ctype="application/x-www-form-urlencoded")
        self.assertEqual(status, 400)
        self.assertEqual(json.loads(raw.decode())["code"], "BAD_CONTENT_TYPE")

    def test_bad_json_returns_400(self):
        status, _headers, raw = self.call("POST", "/api/memories", b"{not json")
        self.assertEqual(status, 400)
        payload = json.loads(raw.decode())
        self.assertEqual(payload["code"], "BAD_JSON")
        self.assertIn("JSON", payload["error"])

    def test_body_size_limit(self):
        big = b'{"title":"x","body":"' + b"a" * (server.MAX_BODY + 1024) + b'"}'
        status, _headers, raw = self.call("POST", "/api/memories", big)
        self.assertEqual(status, 413)
        self.assertEqual(json.loads(raw.decode())["code"], "BODY_TOO_LARGE")

    def test_unknown_route_404_json(self):
        status, _headers, raw = self.call("GET", "/api/definitely-not-here")
        self.assertEqual(status, 404)
        payload = json.loads(raw.decode())
        self.assertEqual(payload["code"], "NOT_FOUND")
        self.assertIn("error", payload)

    def test_method_not_allowed_405(self):
        status, headers, raw = self.call("DELETE", "/api/health")
        self.assertEqual(status, 405)
        self.assertEqual(json.loads(raw.decode())["code"], "METHOD_NOT_ALLOWED")
        self.assertIn("GET", headers.get("Allow", ""))

    def test_internal_error_hides_traceback(self):
        def boom(_rt, _req):
            raise RuntimeError("内部炸了：/secret/path.py line 42")

        server._RAW_ROUTES.append(("/api/_boom", "GET", boom))
        server._rebuild_matcher()
        try:
            status, _headers, raw = self.call("GET", "/api/_boom")
        finally:
            server._RAW_ROUTES.pop()
            server._rebuild_matcher()
        self.assertEqual(status, 500)
        payload = json.loads(raw.decode())
        self.assertEqual(payload["code"], "INTERNAL_ERROR")
        self.assertEqual(payload["error"], "服务内部错误")
        self.assertNotIn("Traceback", raw.decode())
        self.assertNotIn("line 42", raw.decode())

    def test_connection_cap_header(self):
        original = server.MAX_REQUESTS_PER_CONN
        server.MAX_REQUESTS_PER_CONN = 2
        try:
            conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
            conn.request("GET", "/api/health")
            first = conn.getresponse()
            first.read()
            self.assertEqual(first.status, 200)
            self.assertNotEqual(first.getheader("Connection"), "close")
            conn.request("GET", "/api/health")
            second = conn.getresponse()
            second.read()
            self.assertEqual(second.status, 200)
            self.assertEqual(second.getheader("Connection"), "close",
                             "达到单连接上限时应主动声明关闭连接")
            conn.close()
        finally:
            server.MAX_REQUESTS_PER_CONN = original

    def test_protocol_and_backlog_constants(self):
        self.assertEqual(server.MemoraHandler.protocol_version, "HTTP/1.1")
        self.assertGreaterEqual(server.MemoraHTTPServer.request_queue_size, 128)
        self.assertEqual(server.MAX_REQUESTS_PER_CONN, 200)
        self.assertEqual(server.MAX_BODY, 8 * 1024 * 1024)


class StaticTest(ServerCase):
    def test_index_served_at_root(self):
        status, headers, raw = self.call("GET", "/", headers={"Accept": "text/html"})
        self.assertEqual(status, 200)
        self.assertIn("text/html", headers["Content-Type"])
        self.assertIn(b"memora-core", raw)

    def test_static_assets(self):
        for name, expected in (("/app.js", "application/javascript"),
                               ("/app.css", "text/css"),
                               ("/brain.js", "application/javascript"),
                               ("/katex.css", "text/css"),
                               ("/brain.html", "text/html")):
            status, headers, raw = self.call("GET", name)
            self.assertEqual(status, 200, name)
            self.assertIn(expected, headers["Content-Type"])
            self.assertGreater(len(raw), 100, name)

    def test_spa_fallback(self):
        status, headers, raw = self.call("GET", "/memories/123",
                                         headers={"Accept": "text/html"})
        self.assertEqual(status, 200)
        self.assertIn("text/html", headers["Content-Type"])
        self.assertIn(b"app.js", raw)
        status, _h, raw = self.call("GET", "/brain/abc", headers={"Accept": "text/html"})
        self.assertEqual(status, 200)
        self.assertIn(b"brain.js", raw)

    def test_missing_asset_404_without_html_accept(self):
        status, headers, raw = self.call("GET", "/nope.js", headers={"Accept": "*/*"})
        self.assertEqual(status, 404)
        self.assertIn("application/json", headers["Content-Type"])

    def test_large_asset_gzip(self):
        status, headers, raw = self.call("GET", "/app.js",
                                         headers={"Accept-Encoding": "gzip"})
        self.assertEqual(status, 200)
        self.assertEqual(headers.get("Content-Encoding"), "gzip")
        self.assertLess(len(raw), (REPO / "memora_core" / "static" / "app.js").stat().st_size)


# ============================================================ 4. 核心 API
class ApiTest(ServerCase):
    def test_health_reports_capabilities(self):
        status, payload = self.get_json("/api/health")
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["version"], __version__)
        self.assertIn("uptime_s", payload)
        self.assertIn("db", payload)
        self.assertIsInstance(payload["capabilities"], dict)
        for name in ("store", "retrieval", "workflows", "agents", "exchange", "models", "mcp"):
            self.assertIn(name, payload["capabilities"])
        self.assertIn("degraded", payload)
        self.assertTrue(all(v["ok"] for v in payload["capabilities"].values()),
                        payload["capabilities"])

    def test_overview(self):
        status, payload = self.get_json("/api/overview")
        self.assertEqual(status, 200)
        for key in ("totals", "by_kind", "by_scope", "daily", "recent_runs",
                    "pending_reviews", "agents"):
            self.assertIn(key, payload)

    def test_memory_lifecycle(self):
        status, _headers, raw = self.call("POST", "/api/memories", {
            "title": "API 测试记忆", "body": "SQLite 是事务真源，Markdown 只是镜像。",
            "kind": "fact", "scope_id": "global", "status": "candidate",
            "didactic": {"definition": "定义"}, "importance": 0.8,
            "evidence": [{"kind": "tool_output", "quote": "原始输出", "uri": "cmd:test"}],
            "blocks": [{"type": "code", "lang": "python", "content": "print(1)"}],
            "entities": [{"name": "SQLite", "kind": "tool"}],
        })
        self.assertEqual(status, 201)
        created = json.loads(raw.decode())
        mid = created["id"]
        self.assertEqual(created["status"], "candidate")

        status, detail = self.get_json("/api/memories/" + mid)
        self.assertEqual(status, 200)
        self.assertEqual(detail["id"], mid)
        for key in ("evidence", "blocks", "entities", "edges", "documents", "history"):
            self.assertIn(key, detail)
        self.assertEqual(len(detail["evidence"]), 1)
        self.assertEqual(len(detail["blocks"]), 1)
        self.assertGreaterEqual(len(detail["entities"]), 1)

        status, patched = self.get_json("/api/memories/" + mid, )  # GET 保持
        status, _h, raw = self.call("PATCH", "/api/memories/" + mid,
                                    {"importance": 0.95, "category": "工程"})
        self.assertEqual(status, 200)
        self.assertAlmostEqual(json.loads(raw.decode())["importance"], 0.95, places=3)

        status, _h, raw = self.call("POST", "/api/memories/%s/approve" % mid,
                                    {"note": "看起来可靠"})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(raw.decode())["status"], "approved")

        status, _h, raw = self.call("POST", "/api/memories/%s/review" % mid, {"grade": 5})
        self.assertEqual(status, 200)
        review = json.loads(raw.decode())
        self.assertEqual(review["grade"], 5)
        self.assertIn("due", review)
        self.assertEqual(review["review_count"], 1)

        status, evidence = self.get_json("/api/memories/%s/evidence" % mid)
        self.assertEqual(status, 200)
        self.assertEqual(status, 200)
        status, _h, raw = self.call("POST", "/api/memories/%s/evidence" % mid, {
            "kind": "user_stated", "quote": "用户说的"})
        self.assertEqual(status, 201)
        self.assertEqual(json.loads(raw.decode())["memory_id"], mid)

        status, _h, raw = self.call("POST", "/api/memories/%s/reject" % mid, {})
        self.assertEqual(status, 409, "approved → rejected 是非法迁移")
        self.assertEqual(json.loads(raw.decode())["code"], "BAD_TRANSITION")

        status, _h, raw = self.call("DELETE", "/api/memories/" + mid)
        self.assertEqual(status, 200)
        status, _h, raw = self.call("GET", "/api/memories/" + mid)
        self.assertEqual(json.loads(raw.decode())["status"], "archived")

    def test_memory_validation_and_404(self):
        status, _h, raw = self.call("POST", "/api/memories", {"title": "缺正文", "kind": "fact"})
        self.assertEqual(status, 400)
        self.assertEqual(json.loads(raw.decode())["code"], "MISSING_FIELD")
        status, _h, raw = self.call("GET", "/api/memories/m-does-not-exist")
        self.assertEqual(status, 404)
        self.assertEqual(json.loads(raw.decode())["code"], "MEMORY_NOT_FOUND")
        status, _h, raw = self.call("DELETE", "/api/memories/m-x?hard=true")
        self.assertEqual(status, 400)
        self.assertEqual(json.loads(raw.decode())["code"], "CONFIRM_REQUIRED")

    def test_memory_list_filters(self):
        status, payload = self.get_json("/api/memories?limit=5&offset=0")
        self.assertEqual(status, 200)
        for key in ("items", "total", "limit", "offset"):
            self.assertIn(key, payload)
        self.assertLessEqual(payload["limit"], 500)

    def test_search_and_recall(self):
        self.call("POST", "/api/memories", {
            "title": "检索用的记忆", "body": "BM25 与向量混合召回，再用 RRF 融合。",
            "kind": "knowledge", "scope_id": "global", "status": "approved"})
        status, payload = self.get_json("/api/search?q=混合召回&limit=5")
        self.assertEqual(status, 200)
        self.assertIn("hits", payload)
        self.assertIn("degraded", payload)
        self.assertIn("took_ms", payload)
        self.assertTrue(payload["hits"])
        hit = payload["hits"][0]
        for key in ("id", "title", "snippet", "score", "channels", "citation"):
            self.assertIn(key, hit)

        status, _h, raw = self.call("POST", "/api/recall",
                                    {"query": "混合召回", "agent": "unittest", "limit": 5})
        self.assertEqual(status, 200)
        recall = json.loads(raw.decode())
        self.assertIn("digest", recall)
        self.assertIn("hits", recall)
        self.assertIn("[m:", recall["digest"])

        status, _h, raw = self.call("GET", "/api/search")
        self.assertEqual(status, 400)
        self.assertEqual(json.loads(raw.decode())["code"], "MISSING_FIELD")

    def test_graph_views(self):
        status, payload = self.get_json("/api/graph?view=semantic&limit=50")
        self.assertEqual(status, 200)
        self.assertIn("nodes", payload)
        self.assertIn("edges", payload)
        self.assertEqual(payload["meta"]["view"], "semantic")
        for view in ("hierarchy", "timeline", "evidence"):
            status, payload = self.get_json("/api/graph?view=" + view)
            self.assertEqual(status, 200, view)
        status, _h, raw = self.call("GET", "/api/graph?view=badview")
        self.assertEqual(status, 400)

    def test_workflows_and_runs(self):
        status, payload = self.get_json("/api/workflows")
        self.assertEqual(status, 200)
        self.assertGreaterEqual(payload["total"], 10, "内置应有 18 个工作流模板")
        first = payload["items"][0]
        self.assertIn("id", first)

        status, template = self.get_json("/api/workflows/" + first["id"])
        self.assertEqual(status, 200)
        self.assertEqual(template["id"], first["id"])

        status, _h, raw = self.call("POST", "/api/workflows/%s/run" % first["id"],
                                    {"inputs": {"query": "事务真源"}, "scope": "global"})
        self.assertIn(status, (201,))
        run = json.loads(raw.decode())
        self.assertIn("id", run)
        self.assertIn(run["status"], ("ok", "partial", "failed", "cancelled", "running"))
        self.assertIn("steps", run)

        status, runs = self.get_json("/api/runs?limit=5")
        self.assertEqual(status, 200)
        self.assertTrue(runs["items"])
        status, one = self.get_json("/api/runs/" + run["id"])
        self.assertEqual(status, 200)
        self.assertEqual(one["id"], run["id"])

        status, _h, raw = self.call("GET", "/api/runs/run-does-not-exist")
        self.assertEqual(status, 404)

    def test_models_endpoints(self):
        status, payload = self.get_json("/api/models")
        self.assertEqual(status, 200)
        for key in ("roles", "by_role", "profiles", "health", "degraded"):
            self.assertIn(key, payload)

        status, _h, raw = self.call("POST", "/api/models", {
            "role": "embedding", "provider": "openai-compatible",
            "model": "text-embedding-3-small", "base_url": "http://127.0.0.1:1",
            "api_key": "sk-unittest-secret", "dim": 1536})
        self.assertIn(status, (201,))
        body = json.loads(raw.decode())
        self.assertIn("profile", body)
        self.assertNotIn("sk-unittest-secret", raw.decode(), "密钥不得回显")
        self.assertTrue(body["hint"])

        status, payload = self.get_json("/api/models")
        ids = [p["id"] for p in payload["profiles"]]
        self.assertIn(body["profile"]["id"], ids)

        status, _h, raw = self.call("POST", "/api/models/%s/test" % body["profile"]["id"], {})
        self.assertIn(status, (200, 503))
        if status == 200:
            self.assertIn("ok", json.loads(raw.decode()))

        status, calls = self.get_json("/api/models/calls")
        self.assertEqual(status, 200)
        self.assertIn("items", calls)

    def test_algorithms_catalog(self):
        status, payload = self.get_json("/api/algorithms")
        self.assertEqual(status, 200)
        self.assertGreaterEqual(payload["total"], 30, "算法目录应有 34 条")
        self.assertIn("id", payload["items"][0])

    def test_agents_endpoints(self):
        status, payload = self.get_json("/api/agents")
        self.assertEqual(status, 200)
        self.assertGreaterEqual(payload["total"], 3)
        agent = payload["items"][0]
        for key in ("id", "status", "probes", "sessions", "memories", "last_seen"):
            self.assertIn(key, agent)

        status, _h, raw = self.call("POST", "/api/agents/heartbeat",
                                    {"agent": "unittest-agent", "status": "online",
                                     "detail": {"pid": os.getpid()}})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(raw.decode())["id"], "unittest-agent")

        status, payload = self.get_json("/api/agents/unittest-agent/config")
        self.assertEqual(status, 200)
        self.assertIn("mcpServers", payload["config"])
        self.assertIn("mcp-stdio", json.dumps(payload["config"]))

        status, _h, raw = self.call("POST", "/api/agents/probe", {})
        self.assertEqual(status, 200)
        self.assertIn("results", json.loads(raw.decode()))

        status, _h, raw = self.call("GET", "/api/agents/nope/config")
        self.assertEqual(status, 404)

    def test_conflicts_jobs_settings(self):
        status, payload = self.get_json("/api/conflicts")
        self.assertEqual(status, 200)
        self.assertIn("items", payload)

        status, payload = self.get_json("/api/jobs")
        self.assertEqual(status, 200)
        self.assertIn("items", payload)

        status, _h, raw = self.call("POST", "/api/settings",
                                    {"key": "ui.theme", "value": "dark"})
        self.assertEqual(status, 200)
        status, payload = self.get_json("/api/settings")
        self.assertEqual(payload["values"].get("ui.theme"), "dark")

        status, _h, raw = self.call("POST", "/api/settings", {"values": {"a": 1, "b": 2}})
        self.assertEqual(json.loads(raw.decode())["count"], 2)

    def test_exchange_export_import(self):
        self.call("POST", "/api/memories", {
            "title": "交换格式测试", "body": "导出后应能以 memora-exchange/1 导入。",
            "kind": "fact", "scope_id": "global", "status": "approved"})
        status, headers, raw = self.call("GET", "/api/exchange/export?status=approved")
        self.assertEqual(status, 200)
        self.assertIn("ndjson", headers["Content-Type"])
        text = raw.decode("utf-8")
        self.assertIn("memora-exchange/1", text)

        status, _h, raw = self.call("POST", "/api/exchange/import", raw)
        self.assertEqual(status, 200)
        result = json.loads(raw.decode())
        self.assertIsInstance(result, dict)

        status, _h, raw = self.call("GET", "/api/exchange/export?format=json")
        self.assertEqual(status, 200)
        self.assertIn("jsonl", json.loads(raw.decode()))

    def test_documents_flow(self):
        status, _h, raw = self.call("POST", "/api/documents/import", {
            "text": "# 服务端测试文档\n\n这是正文，用于验证导入与切块。",
            "title": "服务端测试文档", "scope": "global"})
        self.assertEqual(status, 201)
        imported = json.loads(raw.decode())
        doc_id = imported["document_id"]
        self.assertGreaterEqual(imported["chunks"], 1)

        status, payload = self.get_json("/api/documents?limit=5")
        self.assertEqual(status, 200)
        self.assertTrue(payload["items"])

        status, document = self.get_json("/api/documents/" + doc_id)
        self.assertEqual(status, 200)
        self.assertIn("chunks", document)

        status, headers, raw = self.call("GET", "/api/documents/%s/raw" % doc_id)
        self.assertEqual(status, 200)
        self.assertIn("text/markdown", headers["Content-Type"])
        self.assertIn("服务端测试文档", raw.decode("utf-8"))

        status, _h, raw = self.call("POST", "/api/documents/%s/reindex" % doc_id, {})
        self.assertEqual(status, 200)
        self.assertGreaterEqual(json.loads(raw.decode())["chunks"], 1)

        status, _h, raw = self.call("GET", "/api/documents/doc-missing")
        self.assertEqual(status, 404)

    def test_mcp_over_http(self):
        status, _h, raw = self.call("POST", "/mcp", {
            "jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}})
        self.assertEqual(status, 200)
        payload = json.loads(raw.decode())
        self.assertEqual(payload["jsonrpc"], "2.0")
        names = [tool["name"] for tool in payload["result"]["tools"]]
        self.assertIn("memory_recall", names)
        self.assertGreaterEqual(len(names), 15)

    def test_keep_alive_reuses_connection(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            for _ in range(3):
                conn.request("GET", "/api/health")
                response = conn.getresponse()
                body = response.read()
                self.assertEqual(response.status, 200)
                self.assertEqual(int(response.getheader("Content-Length")), len(body))
                self.assertNotEqual(response.getheader("Connection"), "close")
        finally:
            conn.close()


# ============================================================ 5. SSE
class SseTest(ServerCase):
    bootstrap = False

    def test_sse_emits_real_frame_and_cleans_up(self):
        before = eventbus.subscriber_count()
        request = urllib.request.Request(self.base + "/api/events")
        request.add_header("Accept", "text/event-stream")
        response = urllib.request.urlopen(request, timeout=15)
        try:
            self.assertEqual(response.status, 200)
            self.assertIn("text/event-stream", response.headers.get("Content-Type"))
            self.assertIn("no-store", response.headers.get("Cache-Control"))
            # 建连即应收到一帧事件（历史补发或 heartbeat），不必等 15 秒心跳
            frame = self._read_event_frame(response, timeout=8.0)
            self.assertIn("event:", frame)
            self.assertIn("data:", frame)
            self.assertIn('"type"', frame)

            eventbus.publish("run", {"run_id": "run-sse-unittest", "status": "ok"})
            frame = self._read_event_frame(response, timeout=10.0,
                                           want="event: run")
            self.assertIn("event: run", frame)
            self.assertIn("run-sse-unittest", frame)
        finally:
            response.close()
        deadline = time.time() + 5
        while time.time() < deadline and eventbus.subscriber_count() > before:
            time.sleep(0.05)
        self.assertEqual(eventbus.subscriber_count(), before, "客户端断开后订阅必须被清理")

    def _read_event_frame(self, response, timeout: float, want: str = "") -> str:
        """在超时内读到一整个**事件**帧（跳过 retry 行与心跳注释行）。"""
        box: dict[str, str] = {"frame": ""}

        def worker():
            buffer = ""
            started = time.time()
            while time.time() - started < timeout:
                line = response.readline()
                if not line:
                    break
                text = line.decode("utf-8", "replace")
                if not text.strip():          # 空行 = 帧结束
                    if buffer.strip():
                        if (not want or want in buffer) and "data:" in buffer:
                            box["frame"] = buffer
                            return
                        buffer = ""
                    continue
                if text.startswith(":") or text.startswith("retry:"):
                    continue                  # 心跳注释 / 重连提示不算事件
                buffer += text
            box["frame"] = buffer

        thread = threading.Thread(target=worker, daemon=True)
        thread.start()
        thread.join(timeout + 2)
        self.assertIn("frame", box, "SSE 没有在 %.1fs 内返回数据" % timeout)
        self.assertTrue(box["frame"].strip(), "SSE 帧为空")
        return box["frame"]


class EventBusUnitTest(unittest.TestCase):
    def setUp(self) -> None:
        eventbus.clear()

    def tearDown(self) -> None:
        eventbus.clear()

    def test_publish_subscribe_and_drain(self):
        bus = eventbus.subscribe()
        payload = eventbus.publish("memory", {"memory_id": "m-1"})
        self.assertEqual(payload["type"], "memory")
        drained = bus.drain()
        self.assertEqual(len(drained), 1)
        self.assertEqual(drained[0]["data"]["memory_id"], "m-1")
        bus.close()
        self.assertEqual(eventbus.subscriber_count(), 0)

    def test_callable_emit_and_put_forms(self):
        """workflows.RunEmitter 支持 callable / .emit / .put 三种投递形态。"""
        bus = eventbus.subscribe()
        bus({"type": "run", "data": {"a": 1}})
        bus.emit({"type": "run", "data": {"a": 2}})
        bus.put(("run", {"a": 3}))
        self.assertEqual([e["data"]["a"] for e in bus.drain()], [1, 2, 3])
        bus.close()

    def test_type_filter(self):
        bus = eventbus.subscribe(("memory",))
        eventbus.publish("run", {"x": 1})
        eventbus.publish("memory", {"y": 2})
        drained = bus.drain()
        self.assertEqual([e["type"] for e in drained], ["memory"])
        bus.close()

    def test_queue_is_bounded(self):
        bus = eventbus.subscribe()
        for index in range(eventbus.QUEUE_SIZE + 50):
            eventbus.publish("log", {"i": index})
        self.assertEqual(len(bus.queue), eventbus.QUEUE_SIZE)
        self.assertEqual(bus.queue[-1]["data"]["i"], eventbus.QUEUE_SIZE + 49)
        bus.close()

    def test_sse_frame_and_comment(self):
        frame = eventbus.sse_frame({"id": 7, "type": "run", "data": {"k": "中文"},
                                    "ts": 1.5})
        self.assertTrue(frame.startswith("event: run\n"))
        self.assertIn("id: 7", frame)
        self.assertIn('"中文"', frame)
        self.assertTrue(frame.endswith("\n\n"))
        self.assertTrue(eventbus.sse_comment("ping").startswith(": ping"))

    def test_closed_bus_ignores_events(self):
        bus = eventbus.subscribe()
        bus.close()
        self.assertFalse(bus.put({"type": "log", "data": {}}))
        self.assertEqual(eventbus.subscriber_count(), 0)

    def test_recent_history(self):
        eventbus.publish("memory", {"n": 1})
        eventbus.publish("memory", {"n": 2})
        recent = eventbus.recent(1)
        self.assertEqual(len(recent), 1)
        self.assertEqual(recent[-1]["data"]["n"], 2)


# ============================================================ 6. 缺模块容错
class MissingModuleTest(ServerCase):
    bootstrap = False

    def _block(self, *targets: str) -> _BlockFinder:
        finder = _BlockFinder(targets)
        for name in list(sys.modules):
            if any(name == "memora_core." + t or name.startswith("memora_core." + t + ".")
                   for t in targets):
                sys.modules.pop(name, None)
        sys.meta_path.insert(0, finder)
        self.runtime.reset()
        return finder

    def _unblock(self, finder: _BlockFinder) -> None:
        try:
            sys.meta_path.remove(finder)
        except ValueError:
            pass
        self.runtime.reset()

    def test_workflows_missing_degrades_gracefully(self):
        finder = self._block("workflows")
        try:
            status, _h, raw = self.call("GET", "/api/workflows")
            self.assertEqual(status, 503)
            payload = json.loads(raw.decode())
            self.assertEqual(payload["code"], "MODULE_UNAVAILABLE")
            self.assertRegex(payload["error"], r"[\u4e00-\u9fff]+",
                             "错误信息必须是中文")

            status, health = self.get_json("/api/health")
            self.assertEqual(status, 200, "health 必须始终可用")
            self.assertTrue(health["ok"])
            self.assertFalse(health["capabilities"]["workflows"]["ok"])
            self.assertIn("workflows", health["unavailable"])
            self.assertIn("workflows", health["degraded"])
            self.assertTrue(health["capabilities"]["store"]["ok"])

            status, payload = self.get_json("/api/memories?limit=1")
            self.assertEqual(status, 200, "其它能力不受影响")
        finally:
            self._unblock(finder)
        status, _h, raw = self.call("GET", "/api/workflows")
        self.assertEqual(status, 200, "恢复后应立刻可用（不缓存失败）")

    def test_store_missing_keeps_health_alive(self):
        finder = self._block("store")
        try:
            status, health = self.get_json("/api/health")
            self.assertEqual(status, 200)
            self.assertFalse(health["capabilities"]["store"]["ok"])
            self.assertIn("store", health["unavailable"])
            status, _h, raw = self.call("GET", "/api/memories")
            self.assertEqual(status, 503)
            self.assertEqual(json.loads(raw.decode())["code"], "MODULE_UNAVAILABLE")
            status, _h, raw = self.call("GET", "/")
            self.assertEqual(status, 200, "静态资源与依赖模块无关，必须仍可访问")
        finally:
            self._unblock(finder)

    def test_models_missing_reports_degraded(self):
        finder = self._block("models")
        try:
            status, health = self.get_json("/api/health")
            self.assertEqual(status, 200)
            self.assertFalse(health["capabilities"]["models"]["ok"])
            self.assertTrue(health["degraded"], "模型缺失必须体现在 degraded 里")
            status, payload = self.get_json("/api/models")
            self.assertEqual(status, 200)
            self.assertIn("models", payload.get("unavailable", []))
            status, payload = self.get_json("/api/search?q=test")
            self.assertEqual(status, 200, "无模型时应走确定性降级而不是失败")
        finally:
            self._unblock(finder)

    def test_real_module_rename_simulation(self):
        """真的把 memora_core.workflows 从 sys.modules 摘掉并阻断导入。"""
        finder = self._block("agents")
        try:
            controller = mock.patch.object(server, "_load_module",
                                           side_effect=lambda name: _import_or_raise(name))
            controller.start()
            try:
                self.runtime.reset()
                status, _h, raw = self.call("POST", "/api/agents/probe", {})
                self.assertEqual(status, 503)
            finally:
                controller.stop()
        finally:
            self._unblock(finder)


def _import_or_raise(name: str):
    """测试助手：blackhole 模块直接抛 ImportError。"""
    import importlib
    return importlib.import_module("memora_core." + name)


# ============================================================ 7. serve() 真启动
class ServeProcessTest(unittest.TestCase):
    """真的用 python -m memora_core serve 起一个进程，验证横幅与 Ctrl+C 优雅退出。"""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="memora-serve-test-"))
        self.port = _free_port()
        self.proc = None

    def tearDown(self) -> None:
        if self.proc is not None:
            if self.proc.poll() is None:
                self.proc.kill()
                self.proc.wait(timeout=10)
            for stream in (self.proc.stdout, self.proc.stderr):
                try:
                    if stream is not None:
                        stream.close()
                except OSError:
                    pass
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_serve_banner_and_graceful_exit(self):
        env = dict(os.environ)
        env["PYTHONIOENCODING"] = "utf-8"
        env["PYTHONPATH"] = str(REPO)
        self.proc = subprocess.Popen(
            [sys.executable, "-m", "memora_core", "--data", str(self.tmp),
             "serve", "--port", str(self.port)],
            cwd=str(REPO), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            env=env, text=True, encoding="utf-8")
        try:
            line = self.proc.stdout.readline().strip()
            self.assertIn("Memora-Core 已启动: http://127.0.0.1:", line)
            self.assertIn(str(self.port), line)
            # 数据库在启动前被初始化
            self.assertTrue((self.tmp / "memora.db").exists(), "启动前必须 init_db")
            status, _headers, raw = self._get("/api/health")
            self.assertEqual(status, 200)
            self.assertTrue(json.loads(raw.decode())["ok"])
            status, _h, raw = self._post("/mcp", {"jsonrpc": "2.0", "id": 2,
                                                  "method": "tools/list"})
            self.assertEqual(status, 200)
        finally:
            self._interrupt()
            try:
                self.proc.wait(timeout=15)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(timeout=10)
        # POSIX 下 SIGINT 走 KeyboardInterrupt → serve() 优雅退出并返回 0；
        # Windows 没有可投递的 SIGINT（kill 等价于 TerminateProcess），只断言不挂死。
        if os.name != "nt":
            self.assertEqual(self.proc.returncode, 0,
                             "Ctrl+C 后应正常退出，实际 %s；stderr=%s"
                             % (self.proc.returncode,
                                (self.proc.stderr.read() or "")[:800]))
        else:
            self.assertIsNotNone(self.proc.returncode, "进程必须能被结束（不能挂死）")

    def _interrupt(self) -> None:
        if os.name == "nt":
            self.proc.kill()          # Windows 无 SIGINT 投递通道
        else:
            self.proc.send_signal(signal.SIGINT)

    def _get(self, path: str):
        return _plain_call("GET", "http://127.0.0.1:%d%s" % (self.port, path))

    def _post(self, path: str, body: dict):
        return _plain_call("POST", "http://127.0.0.1:%d%s" % (self.port, path), body)


def _plain_call(method: str, url: str, body: dict | None = None):
    data = None if body is None else json.dumps(body).encode("utf-8")
    request = urllib.request.Request(url, data=data, method=method)
    if data is not None:
        request.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, dict(response.headers), response.read()
    except urllib.error.HTTPError as exc:
        return exc.code, dict(exc.headers), exc.read()


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


# ============================================================ 8. serve() 单元行为
class ServeFunctionTest(unittest.TestCase):
    def test_rejects_non_loopback_host(self):
        tmp = Path(tempfile.mkdtemp(prefix="memora-serve-unit-"))
        try:
            buffer = io.StringIO()
            with redirect_stdout(buffer):
                code = server.serve(Paths(tmp), port=0, host="0.0.0.0")
            self.assertEqual(code, 2)
            self.assertIn("回环", buffer.getvalue())
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_create_server_rejects_non_loopback(self):
        tmp = Path(tempfile.mkdtemp(prefix="memora-serve-unit-"))
        try:
            runtime = server.Runtime(Paths(tmp).ensure())
            with self.assertRaises(ValueError):
                server.create_server(runtime, host="192.0.2.5", port=0)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_serve_handles_ctrl_c(self):
        """serve() 收到 KeyboardInterrupt 时应关监听、等在途请求、返回 0。"""
        tmp = Path(tempfile.mkdtemp(prefix="memora-serve-unit-"))
        port = _free_port()
        result: dict[str, int] = {}

        def run() -> None:
            result["code"] = server.serve(Paths(tmp), port=port)

        thread = threading.Thread(target=run, daemon=True)
        buffer = io.StringIO()
        redirect = redirect_stdout(buffer)      # 保持重定向直到横幅打印完成
        redirect.__enter__()
        try:
            thread.start()
            deadline = time.time() + 15
            while time.time() < deadline:
                try:
                    status, _headers, raw = _plain_call(
                        "GET", "http://127.0.0.1:%d/api/health" % port)
                    if status == 200:
                        break
                except Exception:  # noqa: BLE001 - 还没起来
                    pass
                time.sleep(0.1)
            self.assertIn("Memora-Core 已启动: http://127.0.0.1:%d" % port,
                          buffer.getvalue())
            # 用 Ctrl+C 语义打断：向 serve 线程注入 KeyboardInterrupt
            import ctypes
            exc_type = ctypes.py_object(KeyboardInterrupt)
            ctypes.pythonapi.PyThreadState_SetAsyncExc(
                ctypes.c_ulong(thread.ident), exc_type)
            thread.join(timeout=15)
            self.assertFalse(thread.is_alive(), "Ctrl+C 后 serve() 必须退出")
            self.assertEqual(result.get("code"), 0)
        finally:
            redirect.__exit__(None, None, None)
            shutil.rmtree(tmp, ignore_errors=True)

    def test_graceful_shutdown_waits_for_inflight(self):
        tmp = Path(tempfile.mkdtemp(prefix="memora-serve-unit-"))
        try:
            paths = Paths(tmp).ensure()
            dbmod.init_db(paths.db)
            runtime = server.Runtime(paths)
            httpd = server.create_server(runtime, port=0)
            threading.Thread(target=httpd.serve_forever,
                             kwargs={"poll_interval": 0.02}, daemon=True).start()
            started = time.monotonic()
            runtime.enter()                      # 模拟一个在途请求
            timer = threading.Timer(0.3, runtime.leave)
            timer.start()
            server.graceful_shutdown(httpd, runtime, timeout=5.0)
            timer.join()
            self.assertLess(time.monotonic() - started, 5.0)
            self.assertEqual(runtime.active, 0)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":  # pragma: no cover
    unittest.main(verbosity=2)
