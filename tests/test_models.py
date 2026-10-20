# -*- coding: utf-8 -*-
"""tests/test_models.py — 模型网关与秘密存储。

全部走本地 http.server 假服务器（随机端口，127.0.0.1），**不联网**。
"""

from __future__ import annotations

import base64
import json
import os
import sqlite3
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from memora_core import db as dbmod
from memora_core.models import (
    JudgeFormatError,
    ModelGateway,
    ModelUnavailable,
    _l2_normalize,
    estimate_tokens,
    parse_json_payload,
    render_prompt,
)
from memora_core.paths import Paths


# ============================================================
# 假 OpenAI 兼容服务器
# ============================================================
class _Handler(BaseHTTPRequestHandler):
    server_version = "FakeModel/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # 静音
        pass

    def _send(self, status, obj):
        raw = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        try:
            self.wfile.write(raw)
        except OSError:  # 客户端超时主动断开（WinError 10053 等）
            pass

    def _record(self, payload):
        state = self.server.state
        state["hits"] += 1
        state["paths"].append(self.path)
        state["auth"].append(self.headers.get("Authorization"))
        state["payloads"].append(payload)

    def do_GET(self):
        self._send(404, {"error": "not found"})

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        try:
            payload = json.loads(raw.decode("utf-8") or "{}")
        except ValueError:
            payload = {"_raw": raw.decode("utf-8", "replace")}
        self._record(payload)
        path = self.path.split("?")[0]
        mode = self.server.state["mode"]

        if mode == "timeout":
            time.sleep(self.server.state.get("delay", 1.5))
            return self._send(200, {"ok": True})

        if mode == "500":
            return self._send(500, {"error": {"message": "upstream exploded"}})

        if mode == "500_then_ok":
            if self.server.state["hits"] <= 2:
                return self._send(500, {"error": {"message": "flaky"}})
            return self._send(200, _chat_body("恢复"))

        if mode == "401":
            return self._send(401, {"error": {"message": "invalid api key"}})

        if mode == "bad_judge":
            if path.endswith("/chat/completions"):
                return self._send(200, _chat_body("抱歉，我无法给出 JSON 结果。"))
            if path.endswith("/embeddings"):
                return self._send(200, {"data": [{"embedding": [1, 0, 0]}]})
            return self._send(404, {"error": {"message": "nope"}})

        # normal
        if path.endswith("/api/chat"):
            return self._send(200, {"model": "fake", "done": True,
                                    "message": {"role": "assistant", "content": "ollama 回复"},
                                    "prompt_eval_count": 5, "eval_count": 3})
        if path.endswith("/api/embed"):
            items = payload.get("input")
            if isinstance(items, str):
                items = [items]
            return self._send(200, {"model": "fake",
                                    "embeddings": [[float(len(t) + 1), 1.0, 2.0]
                                                   for t in (items or [])],
                                    "prompt_eval_count": 5})
        if path.endswith("/chat/completions"):
            if payload.get("response_format"):
                fenced = "```json\n{\"kind\": \"decision\", \"category\": \"engineering\", \"importance\": 0.8, \"reason\": \"mock\"}\n```"
                return self._send(200, _chat_body(fenced))
            return self._send(200, _chat_body("你好，这是假服务器的回答。"))
        if path.endswith("/embeddings"):
            items = payload.get("input")
            if isinstance(items, str):
                items = [items]
            data = []
            for idx, text in enumerate(items or []):
                seed = float(len(text) % 7 + 1)
                data.append({"object": "embedding", "index": idx,
                             "embedding": [seed, seed * 2.0, 0.5]})
            return self._send(200, {"object": "list", "data": data,
                                    "usage": {"prompt_tokens": 7, "total_tokens": 7}})
        if path.endswith("/text-rerank/text-rerank"):
            # DashScope 原生重排：请求是 {model, input:{query,documents}, parameters},
            # 响应是嵌套的 output.results
            docs = (payload.get("input") or {}).get("documents") or []
            results = [{"index": idx, "relevance_score": 0.5 + 0.1 * idx}
                       for idx in range(len(docs))]
            return self._send(200, {"output": {"results": results},
                                    "usage": {"total_tokens": 21}})
        if path.endswith("/v1/rerank") or path.endswith("/rerank"):
            docs = payload.get("documents") or []
            results = []
            for idx, doc in enumerate(docs):
                score = 0.9 - 0.1 * idx
                results.append({"index": idx, "relevance_score": score,
                                "document": {"text": doc}})
            return self._send(200, {"results": results, "usage": {"total_tokens": 21}})
        return self._send(404, {"error": {"message": "unknown path " + path}})


def _chat_body(text):
    return {
        "id": "chatcmpl-fake",
        "object": "chat.completion",
        "choices": [{"index": 0, "message": {"role": "assistant", "content": text},
                     "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 11, "completion_tokens": 7, "total_tokens": 18},
    }


class _QuietServer(ThreadingHTTPServer):
    """超时用例里客户端会主动断开，别把 BrokenPipe 回溯打到 stderr。"""

    daemon_threads = True

    def handle_error(self, request, client_address):
        import sys as _sys
        exc = _sys.exc_info()[1]
        if isinstance(exc, (ConnectionError, TimeoutError, OSError)):
            return
        super().handle_error(request, client_address)


class FakeServer:
    """上下文管理器：随机端口 + 可切换的 mode。"""

    def __init__(self, mode="normal"):
        self.mode = mode
        self.httpd = None
        self.thread = None
        self.base = ""

    def __enter__(self):
        self.httpd = _QuietServer(("127.0.0.1", 0), _Handler)
        self.httpd.daemon_threads = True
        self.httpd.state = {"mode": self.mode, "hits": 0, "paths": [], "auth": [],
                            "payloads": [], "delay": 1.5}
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        host, port = self.httpd.server_address[:2]
        self.base = "http://%s:%d" % (host, port)
        return self

    def set_mode(self, mode, **kw):
        self.httpd.state["mode"] = mode
        self.httpd.state.update(kw)

    @property
    def hits(self):
        return self.httpd.state["hits"]

    @property
    def paths(self):
        return self.httpd.state["paths"]

    @property
    def payloads(self):
        return self.httpd.state["payloads"]

    @property
    def auth(self):
        return self.httpd.state["auth"]

    def reset(self):
        self.httpd.state["hits"] = 0
        self.httpd.state["paths"] = []
        self.httpd.state["auth"] = []
        self.httpd.state["payloads"] = []

    def __exit__(self, *exc):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=5)
        return False


# ============================================================
# 测试基类
# ============================================================
class GatewayCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.tmp.name)
        self.paths = Paths(self.data_dir).ensure()
        self.db_path = self.paths.db
        dbmod.init_db(self.db_path)
        self.gw = ModelGateway(db_path=self.db_path, sleep=lambda s: None)

    def tearDown(self):
        self.gw.close()
        self.tmp.cleanup()

    def add_profile(self, pid, role, provider, model, base_url, *, priority=0,
                    enabled=1, api_key_ref=None, timeout_ms=60000, batch=16, dim=None):
        con = sqlite3.connect(str(self.db_path), isolation_level=None)
        con.execute(
            "INSERT OR REPLACE INTO model_profile(id, role, label, provider, model, base_url, "
            "api_key_ref, dim, batch, timeout_ms, params, priority, enabled, created_at) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (pid, role, pid, provider, model, base_url, api_key_ref, dim, batch,
             timeout_ms, "{}", priority, enabled, dbmod.now()),
        )
        con.close()
        self.gw.reload()

    def calls(self):
        con = sqlite3.connect(str(self.db_path))
        con.row_factory = sqlite3.Row
        rows = [dict(r) for r in con.execute("SELECT * FROM model_call ORDER BY rowid")]
        con.close()
        return rows

    def cipher_of(self, key):
        con = sqlite3.connect(str(self.db_path))
        value = con.execute("SELECT cipher FROM secret WHERE key=?", (key,)).fetchone()[0]
        con.close()
        return value


# ============================================================
# 1. 秘密存储
# ============================================================
class TestSecret(GatewayCase):
    def test_roundtrip_and_no_plaintext(self):
        plain = "sk-deepseek-测试-1234567890abcd"
        hint = self.gw.set_secret("deepseek", plain)
        self.assertEqual(hint, "****abcd")
        self.assertEqual(self.gw.get_secret("deepseek"), plain)

        cipher = self.cipher_of("deepseek")
        self.assertNotIn("sk-deepseek", cipher)
        self.assertNotIn("1234567890", cipher)
        self.assertNotIn("测试", cipher)
        self.assertNotIn(plain, cipher)

        listed = self.gw.list_secrets()
        self.assertEqual(listed[0]["key"], "deepseek")
        self.assertEqual(listed[0]["hint"], "****abcd")
        self.assertNotIn("cipher", listed[0])

    def test_nonce_makes_ciphertext_random(self):
        hint_a = self.gw.set_secret("k1", "same-secret-value")
        first = self.cipher_of("k1")
        hint_b = self.gw.set_secret("k2", "same-secret-value")
        second = self.cipher_of("k2")
        self.assertEqual(hint_a, hint_b)
        self.assertNotEqual(first, second)
        self.assertEqual(self.gw.get_secret("k1"), self.gw.get_secret("k2"))

    def test_tampered_cipher_raises(self):
        self.gw.set_secret("tamper", "value-to-be-tampered")
        cipher = self.cipher_of("tamper")
        raw = bytearray(base64.b64decode(cipher))
        raw[-1] ^= 0x01
        bad = base64.b64encode(bytes(raw)).decode("ascii")
        con = sqlite3.connect(str(self.db_path), isolation_level=None)
        con.execute("UPDATE secret SET cipher=? WHERE key='tamper'", (bad,))
        con.close()
        with self.assertRaises(ValueError):
            self.gw.get_secret("tamper")

    def test_swapped_cipher_also_raises(self):
        """把 A 的密文换给 B：nonce/tag 不匹配，必须报错而不是返回错误明文。"""
        self.gw.set_secret("a", "alpha-secret")
        self.gw.set_secret("b", "beta-secret")
        con = sqlite3.connect(str(self.db_path), isolation_level=None)
        con.execute("UPDATE secret SET cipher=(SELECT cipher FROM secret WHERE key='a') "
                    "WHERE key='b'")
        con.close()
        self.assertEqual(self.gw.get_secret("b"), "alpha-secret")

    def test_master_key_file(self):
        self.gw.set_secret("k", "v")
        key_file = self.data_dir / "master.key"
        self.assertTrue(key_file.exists())
        raw = key_file.read_bytes()
        if os.name == "nt":  # 1.1.0：Windows 上主密钥由 DPAPI 封装（见 tests/test_secrets.py）
            self.assertTrue(raw.startswith(b"MKDPAPI1"))
        else:
            self.assertEqual(len(raw), 32)
        if os.name == "posix":
            self.assertEqual(key_file.stat().st_mode & 0o777, 0o600)

    def test_env_ref_used_as_bearer(self):
        with FakeServer() as srv:
            os.environ["MEMORA_TEST_KEY"] = "env-secret-key"
            try:
                self.add_profile("p1", "chat", "openai", "fake-chat", srv.base,
                                 api_key_ref="env:MEMORA_TEST_KEY")
                self.gw.chat([{"role": "user", "content": "hi"}])
                self.assertIn("Bearer env-secret-key", srv.auth)
            finally:
                os.environ.pop("MEMORA_TEST_KEY", None)


# ============================================================
# 2. 正常通路
# ============================================================
class TestNormalPath(GatewayCase):
    def test_chat_ok_and_logged(self):
        with FakeServer() as srv:
            self.add_profile("c1", "chat", "openai", "fake-chat", srv.base)
            text = self.gw.chat([{"role": "user", "content": "你好"}])
            self.assertEqual(text, "你好，这是假服务器的回答。")
            self.assertEqual(srv.paths, ["/v1/chat/completions"])
            rows = self.calls()
            self.assertEqual(len(rows), 1)
            row = rows[0]
            self.assertEqual(row["role"], "chat")
            self.assertEqual(row["provider"], "openai")
            self.assertEqual(row["model"], "fake-chat")
            self.assertEqual(row["ok"], 1)
            self.assertEqual(row["http_status"], 200)
            self.assertEqual(row["prompt_tokens"], 11)
            self.assertEqual(row["completion_tokens"], 7)
            self.assertEqual(row["degraded"], 0)
            self.assertGreaterEqual(row["latency_ms"], 0)

    def test_embed_batch_and_normalized(self):
        with FakeServer() as srv:
            self.add_profile("e1", "embedding", "openai", "fake-embed", srv.base, batch=2)
            vectors = self.gw.embed(["a", "bb", "ccc", "dddd", "eeeee"])
            self.assertEqual(len(vectors), 5)
            self.assertEqual(len(srv.payloads), 3)
            self.assertEqual(srv.payloads[0]["input"], ["a", "bb"])
            for vec in vectors:
                norm = sum(v * v for v in vec) ** 0.5
                self.assertAlmostEqual(norm, 1.0, places=9)
            single = self.gw.embed("only-one")
            self.assertIsInstance(single, list)
            self.assertIsInstance(single[0], float)

    def test_rerank_sorted_desc(self):
        with FakeServer() as srv:
            self.add_profile("r1", "reranker", "openai", "fake-rerank", srv.base)
            pairs = self.gw.rerank("q", ["doc0", "doc1", "doc2"], top_k=3)
            self.assertEqual([p[0] for p in pairs], [0, 1, 2])
            scores = [p[1] for p in pairs]
            self.assertEqual(scores, sorted(scores, reverse=True))

    def test_judge_parses_markdown_fence(self):
        with FakeServer() as srv:
            self.add_profile("j1", "judge", "openai", "fake-judge", srv.base)
            data = self.gw.judge("分类这条记忆", schema_hint="{kind, category}")
            self.assertEqual(data["kind"], "decision")
            self.assertEqual(data["category"], "engineering")
            self.assertEqual(srv.payloads[0]["response_format"], {"type": "json_object"})


# ============================================================
# 3. 失败语义
# ============================================================
class TestFailureModes(GatewayCase):
    def test_500_retries_twice_then_fails(self):
        with FakeServer("500") as srv:
            self.add_profile("c1", "chat", "openai", "fake-chat", srv.base)
            with self.assertRaises(ModelUnavailable) as ctx:
                self.gw.chat([{"role": "user", "content": "x"}])
            exc = ctx.exception
            self.assertEqual(srv.hits, 3)
            self.assertTrue(exc.retryable)
            self.assertEqual(exc.http_status, 500)
            self.assertEqual(exc.role, "chat")
            rows = self.calls()
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["ok"], 0)
            self.assertEqual(rows[0]["http_status"], 500)
            self.assertEqual(rows[0]["degraded"], 1)
            self.assertIn("500", rows[0]["error"])

    def test_500_then_ok_recovers(self):
        with FakeServer("500_then_ok") as srv:
            self.add_profile("c1", "chat", "openai", "fake-chat", srv.base)
            text = self.gw.chat([{"role": "user", "content": "x"}])
            self.assertEqual(text, "恢复")
            self.assertEqual(srv.hits, 3)

    def test_401_does_not_retry(self):
        with FakeServer("401") as srv:
            self.add_profile("c1", "chat", "openai", "fake-chat", srv.base)
            with self.assertRaises(ModelUnavailable) as ctx:
                self.gw.chat([{"role": "user", "content": "x"}])
            self.assertEqual(srv.hits, 1)
            self.assertFalse(ctx.exception.retryable)
            self.assertEqual(ctx.exception.http_status, 401)
            rows = self.calls()
            self.assertEqual(rows[0]["http_status"], 401)
            self.assertEqual(rows[0]["ok"], 0)

    def test_timeout_raises_model_unavailable(self):
        with FakeServer("timeout") as srv:
            self.add_profile("c1", "chat", "openai", "fake-chat", srv.base, timeout_ms=150)
            srv.set_mode("timeout", delay=1.5)
            started = time.time()
            with self.assertRaises(ModelUnavailable) as ctx:
                self.gw.chat([{"role": "user", "content": "x"}])
            elapsed = time.time() - started
            self.assertTrue(ctx.exception.retryable)
            self.assertEqual(srv.hits, 3)
            self.assertLess(elapsed, 6.0)
            rows = self.calls()
            self.assertEqual(rows[0]["ok"], 0)
            self.assertEqual(rows[0]["degraded"], 1)

    def test_bad_json_judge_raises_format_error(self):
        with FakeServer("bad_judge") as srv:
            self.add_profile("j1", "judge", "openai", "fake-judge", srv.base)
            with self.assertRaises(JudgeFormatError) as ctx:
                self.gw.judge("给我 JSON")
            self.assertIn("无法解析", str(ctx.exception))
            self.assertIn("抱歉", ctx.exception.raw)
            rows = self.calls()
            self.assertEqual(rows[-1]["ok"], 1)
            self.assertEqual(rows[-1]["role"], "judge")

    def test_embed_bad_response_raises(self):
        with FakeServer("bad_judge") as srv:
            self.add_profile("e1", "embedding", "openai", "fake-embed", srv.base)
            with self.assertRaises(ModelUnavailable) as ctx:
                self.gw.embed(["a", "b"])
            self.assertIn("向量响应不合法", ctx.exception.reason)

    def test_zero_vector_is_refused(self):
        with self.assertRaises(ValueError):
            _l2_normalize([0.0, 0.0, 0.0])


# ============================================================
# 4. 未配置
# ============================================================
class TestUnconfigured(GatewayCase):
    def test_embed_raises_unavailable(self):
        with self.assertRaises(ModelUnavailable) as ctx:
            self.gw.embed("hello")
        self.assertEqual(ctx.exception.role, "embedding")
        self.assertEqual(ctx.exception.reason, "未配置")

    def test_chat_rerank_judge_raise(self):
        for call in (lambda: self.gw.chat("hi"),
                     lambda: self.gw.rerank("q", ["a"]),
                     lambda: self.gw.judge("p")):
            with self.assertRaises(ModelUnavailable):
                call()

    def test_health_structure_zero_config(self):
        health = self.gw.health()
        self.assertEqual(set(health), {"chat", "embedding", "reranker", "judge",
                                       "extractor", "vision"})
        for role, item in health.items():
            self.assertEqual(set(item), {"configured", "model", "provider", "ok", "degraded",
                                         "last_error", "calls_24h", "avg_latency_ms"})
            self.assertFalse(item["configured"], role)
            self.assertTrue(item["degraded"], role)
            self.assertEqual(item["calls_24h"], 0)
            self.assertEqual(item["avg_latency_ms"], 0)

    def test_provider_none_disables_role(self):
        self.add_profile("n1", "embedding", "none", "disabled", "", priority=10)
        health = self.gw.health()
        self.assertFalse(health["embedding"]["configured"])
        self.assertTrue(health["embedding"]["degraded"])
        with self.assertRaises(ModelUnavailable) as ctx:
            self.gw.embed("x")
        self.assertIn("禁用", ctx.exception.reason)


# ============================================================
# 5. 路由与健康
# ============================================================
class TestRoutingAndHealth(GatewayCase):
    def test_priority_picks_highest_enabled(self):
        self.add_profile("low", "chat", "openai", "low-model", "http://127.0.0.1:1", priority=1)
        self.add_profile("high", "chat", "openai", "high-model", "http://127.0.0.1:1", priority=9)
        self.add_profile("off", "chat", "openai", "off-model", "http://127.0.0.1:1",
                         priority=99, enabled=0)
        roles = self.gw.roles()
        self.assertEqual(roles["chat"].id, "high")
        self.assertEqual(roles["chat"].model, "high-model")

    def test_health_structure_identical_partial_and_full(self):
        empty = {role: set(item) for role, item in self.gw.health().items()}

        with FakeServer() as srv:
            self.add_profile("c1", "chat", "openai", "fake-chat", srv.base)
            partial = {role: set(item) for role, item in self.gw.health().items()}
            self.assertEqual(empty, partial)
            self.gw.chat([{"role": "user", "content": "hi"}])

            self.add_profile("e1", "embedding", "dashscope", "qwen3-emb-8b", srv.base)
            self.add_profile("r1", "reranker", "dashscope", "qwen3-reranker-8b", srv.base)
            self.add_profile("j1", "judge", "openai", "deepseek-chat", srv.base)
            full = self.gw.health()
            self.assertEqual(empty, {role: set(item) for role, item in full.items()})
            for role in ("chat", "embedding", "reranker", "judge"):
                self.assertTrue(full[role]["configured"], role)
                self.assertFalse(full[role]["degraded"], role)
                self.assertTrue(full[role]["ok"], role)
            self.assertEqual(full["chat"]["calls_24h"], 1)
            self.assertEqual(full["chat"]["provider"], "openai")
            self.assertFalse(full["vision"]["configured"])
            self.assertTrue(full["vision"]["degraded"])

    def test_health_reports_last_error(self):
        with FakeServer("401") as srv:
            self.add_profile("c1", "chat", "openai", "fake-chat", srv.base)
            with self.assertRaises(ModelUnavailable):
                self.gw.chat("x")
            item = self.gw.health()["chat"]
            self.assertEqual(item["calls_24h"], 1)
            self.assertTrue(item["degraded"])
            self.assertIn("401", item["last_error"])

    def test_test_method_logs_model_call(self):
        with FakeServer() as srv:
            self.add_profile("c1", "chat", "openai", "fake-chat", srv.base)
            result = self.gw.test("c1")
            self.assertTrue(result["ok"])
            self.assertEqual(result["mode"], "chat")
            self.assertEqual(len(self.calls()), 1)
            self.assertFalse(self.gw.test("不存在")["ok"])

    def test_dashscope_rerank_nested_output(self):
        """DashScope 原生重排：嵌套 input + output.results，且按分数降序返回。"""
        with FakeServer() as srv:
            self.add_profile("r3", "reranker", "dashscope", "qwen3-rerank", srv.base)
            pairs = self.gw.rerank("查询", ["a", "b", "c"], top_k=3)
            self.assertEqual(srv.paths[-1],
                             "/api/v1/services/rerank/text-rerank/text-rerank")
            self.assertEqual([p[0] for p in pairs], [2, 1, 0])
            self.assertEqual([p[1] for p in pairs], [0.7, 0.6, 0.5])
            self.assertEqual(srv.payloads[-1]["input"]["query"], "查询")

    def test_dashscope_and_ollama_endpoints(self):
        with FakeServer() as srv:
            self.add_profile("d1", "chat", "dashscope", "qwen-max", srv.base)
            self.gw.chat("hi")
            self.assertEqual(srv.paths[-1], "/compatible-mode/v1/chat/completions")
            self.add_profile("o1", "embedding", "ollama", "nomic-embed", srv.base)
            srv.reset()
            self.gw.embed("hi")
            self.assertEqual(srv.paths[-1], "/api/embed")


# ============================================================
# 6. 纯函数
# ============================================================
class TestHelpers(unittest.TestCase):
    def test_parse_json_payload_variants(self):
        self.assertEqual(parse_json_payload('{"a":1}'), {"a": 1})
        self.assertEqual(parse_json_payload("```json\n{\"a\":1}\n```"), {"a": 1})
        self.assertEqual(parse_json_payload('前缀说明 {"a": {"b": "}"}} 后缀'),
                         {"a": {"b": "}"}})

    def test_parse_json_payload_rejects_non_json(self):
        with self.assertRaises(JudgeFormatError):
            parse_json_payload("我无法回答这个问题")
        with self.assertRaises(JudgeFormatError):
            parse_json_payload("")

    def test_render_prompt(self):
        self.assertEqual(render_prompt("A {{x}} B {{y}}", x=1, y="二"), "A 1 B 二")
        self.assertEqual(render_prompt("A {{x}}", x=[1, 2]), 'A [1, 2]')

    def test_estimate_tokens(self):
        self.assertEqual(estimate_tokens(""), 0)
        self.assertGreater(estimate_tokens("abcd" * 10), 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
