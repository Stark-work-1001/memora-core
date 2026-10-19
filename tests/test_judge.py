# -*- coding: utf-8 -*-
"""tests/test_judge.py — 判定层：LLM 通路 + 确定性规则兜底。

同 test_models：全部本地假服务器，不联网。
"""

from __future__ import annotations

import json
import sqlite3
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from memora_core import db as dbmod
from memora_core import judge
from memora_core.models import ModelGateway, ModelUnavailable
from memora_core.paths import Paths


# ============================================================
# 假判定服务器：按提示词内容决定回什么
# ============================================================
class _JudgeHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        payload = json.loads(raw.decode("utf-8") or "{}")
        state = self.server.state
        state["payloads"].append(payload)
        state["hits"] += 1
        prompt = payload["messages"][-1]["content"]

        if state["mode"] == "bad":
            return self._send(200, self._chat("我不会输出 JSON，抱歉。"))

        if "抽象线索" in prompt:
            return self._send(200, self._chat('{"cues": ["为什么选择 SQLite？", '
                                              '"降级策略是什么？"]}'))
        if "断言" in prompt:
            return self._send(200, self._chat(
                '{"supported": ["项目使用 SQLite"], "unsupported": [], "verdict": "pass"}'))
        if "矛盾" in prompt:
            return self._send(200, self._chat(
                '{"preferred": "b", "reasons": ["b 更新"], "confidence": 0.81}'))
        if "比较" in prompt:
            return self._send(200, self._chat(
                '{"action": "merge", "target_id": "m-old", "confidence": 0.77, '
                '"reason": "互补", "merged_body": "合并后的正文"}'))
        if "归入以下 kind" in prompt:
            return self._send(200, self._chat(
                '{"kind": "decision", "category": "engineering", "importance": 0.9, '
                '"reason": "明确的技术选型"}'))
        if "摘要" in prompt or "压缩" in prompt:
            return self._send(200, self._chat("这是 LLM 生成的摘要。"))
        return self._send(200, self._chat('{"ok": true}'))

    def _chat(self, text):
        return {"id": "x", "object": "chat.completion",
                "choices": [{"index": 0, "message": {"role": "assistant", "content": text}}],
                "usage": {"prompt_tokens": 5, "completion_tokens": 5}}

    def _send(self, status, obj):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        try:
            self.wfile.write(data)
        except OSError:
            pass


class _Quiet(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        pass


class FakeJudgeServer:
    def __init__(self, mode="normal"):
        self.mode = mode

    def __enter__(self):
        self.httpd = _Quiet(("127.0.0.1", 0), _JudgeHandler)
        self.httpd.state = {"mode": self.mode, "payloads": [], "hits": 0}
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        host, port = self.httpd.server_address[:2]
        self.base = "http://%s:%d" % (host, port)
        return self

    @property
    def payloads(self):
        return self.httpd.state["payloads"]

    @property
    def hits(self):
        return self.httpd.state["hits"]

    def __exit__(self, *exc):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=5)
        return False


# ============================================================
# 假 store（T1 未就绪时的最小接口 + 显式适配）
# ============================================================
class FakeStore:
    """只提供 store.get_setting/set_setting/audit/stats 与 db_path。"""

    def __init__(self, db_path):
        self.db_path = str(db_path)
        self._settings = {}
        self.audits = []

    def get_setting(self, key, default=None):
        return self._settings.get(key, default)

    def set_setting(self, key, value):
        self._settings[key] = value

    def audit(self, action, target=None, actor="system", detail=None):
        self.audits.append({"action": action, "target": target, "actor": actor,
                            "detail": detail})

    def stats(self):
        return {"memories": 0, "candidates": 0}


class JudgeCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.tmp.name)
        self.paths = Paths(self.data_dir).ensure()
        self.db_path = self.paths.db
        dbmod.init_db(self.db_path)
        self.store = FakeStore(self.db_path)
        # 走 store.db_path 适配路径（等价于 T1 只暴露 db_path 的情形）
        self.gw = ModelGateway(store=self.store, sleep=lambda s: None)

    def tearDown(self):
        self.gw.close()
        self.tmp.cleanup()

    def configure(self, base_url, role="judge"):
        con = sqlite3.connect(str(self.db_path), isolation_level=None)
        con.execute(
            "INSERT OR REPLACE INTO model_profile(id, role, label, provider, model, base_url, "
            "api_key_ref, dim, batch, timeout_ms, params, priority, enabled, created_at) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            ("j1", role, "judge", "openai", "fake-judge", base_url, None, None, 16,
             60000, "{}", 1, 1, dbmod.now()),
        )
        con.close()
        self.gw.reload()


# ============================================================
# 1. 无配置 → 规则兜底
# ============================================================
class TestRuleFallback(JudgeCase):
    def test_gateway_reports_unavailable(self):
        with self.assertRaises(ModelUnavailable):
            self.gw.embed("x")

    def test_classify_degrades_with_rules(self):
        out = judge.classify(self.store, self.gw, "我喜欢用深色主题，请保持深色。")
        self.assertTrue(out["degraded"])
        self.assertEqual(out["kind"], "preference")
        self.assertIn("规则兜底", out["reason"])
        self.assertIn("未配置", out["reason"])
        self.assertTrue(0.0 <= out["importance"] <= 1.0)
        self.assertEqual(set(out), {"kind", "category", "importance", "reason", "degraded"})

    def test_classify_kind_by_keyword(self):
        cases = {
            "我们决定采用 SQLite 作为事务真源": "decision",
            "待办：明天补测试": "task",
            "步骤：先备份，然后迁移": "procedure",
            "这是一个定义：BM25 是概率检索模型": "knowledge",
        }
        for text, expected in cases.items():
            out = judge.classify(self.store, self.gw, text)
            self.assertEqual(out["kind"], expected, text)
            self.assertTrue(out["degraded"])

    def test_dedup_thresholds(self):
        new = {"id": "m-new", "body": "SQLite 是事务真源"}
        old = {"id": "m-old", "body": "SQLite 是事务真源"}

        same = judge.dedup_verdict(self.store, self.gw, new, old, 1.0)
        self.assertEqual(same["action"], "noop")
        self.assertEqual(same["target_id"], "m-old")
        self.assertTrue(same["degraded"])

        near = judge.dedup_verdict(self.store, self.gw,
                                   {"body": "SQLite 是事务真源，WAL"}, old, 0.9)
        self.assertIn(near["action"], ("update", "noop"))
        self.assertEqual(near["target_id"], "m-old")

        merged = judge.dedup_verdict(self.store, self.gw, {"body": "补充：WAL 模式"}, old, 0.8)
        self.assertEqual(merged["action"], "merge")
        self.assertTrue(merged["merged_body"])
        self.assertIn("SQLite 是事务真源", merged["merged_body"])

        linked = judge.dedup_verdict(self.store, self.gw, {"body": "向量检索用余弦"}, old, 0.6)
        self.assertEqual(linked["action"], "link")

        fresh = judge.dedup_verdict(self.store, self.gw, {"body": "完全不同的内容"}, old, 0.1)
        self.assertEqual(fresh["action"], "add")
        self.assertIsNone(fresh["target_id"])

        unknown = judge.dedup_verdict(self.store, self.gw, {"body": "完全不同的内容"}, old, None)
        self.assertEqual(unknown["action"], "ask")

    def test_conflict_numeric_detection(self):
        a = {"id": "a", "trust": 0.5, "body": "默认超时是 60 秒"}
        b = {"id": "b", "trust": 0.5, "body": "默认超时是 30 秒"}
        out = judge.conflict_verdict(self.store, self.gw, a, b)
        self.assertTrue(out["degraded"])
        self.assertIn(out["preferred"], ("a", "b", "ask"))
        joined = " ".join(out["reasons"])
        self.assertIn("数值不同", joined)
        self.assertGreaterEqual(out["confidence"], 0.5)

    def test_conflict_trust_and_cues(self):
        a = {"id": "a", "trust": 0.9, "body": "部署在 8790 端口"}
        b = {"id": "b", "trust": 0.4, "body": "部署在 9090 端口"}
        out = judge.conflict_verdict(self.store, self.gw, a, b)
        self.assertEqual(out["preferred"], "a")
        self.assertIn("可信度", " ".join(out["reasons"]))

        a2 = {"body": "接口使用 GET"}
        b2 = {"body": "接口已改为 POST"}
        out2 = judge.conflict_verdict(self.store, self.gw, a2, b2)
        self.assertEqual(out2["preferred"], "b")
        self.assertEqual(set(out2), {"preferred", "reasons", "confidence", "degraded"})

    def test_conflict_polarity(self):
        a = {"body": "这个方案可以上线"}
        b = {"body": "这个方案不可以上线，风险太大"}
        out = judge.conflict_verdict(self.store, self.gw, a, b)
        self.assertIn("极性", " ".join(out["reasons"]))

    def test_verify_claims_rules(self):
        candidate = "项目使用 SQLite。事务用 WAL 模式。"
        quotes = ["我们决定项目使用 SQLite 作为真源。",
                  "事务用 WAL 模式，synchronous=NORMAL。"]
        out = judge.verify_claims(self.store, self.gw, candidate, quotes)
        self.assertTrue(out["degraded"])
        self.assertEqual(out["verdict"], "pass")
        self.assertEqual(out["unsupported"], [])
        self.assertEqual(len(out["supported"]), 2)

        bare = judge.verify_claims(self.store, self.gw, candidate, [])
        self.assertEqual(bare["verdict"], "fail")
        self.assertTrue(bare["unsupported"])

    def test_summarize_extractive(self):
        text = ("记忆中枢用 SQLite 作为事务真源。SQLite 支持 WAL 模式，读写并发更好。"
                "Markdown 是可读镜像。云端模型负责抽取与判定。")
        out = judge.summarize(self.store, self.gw, text, max_tokens=60)
        self.assertTrue(out["degraded"])
        self.assertTrue(out["summary"])
        self.assertTrue(text.startswith(out["summary"][:10]))
        self.assertLessEqual(len(out["summary"]), 60 * 2 + 20)

    def test_summarize_empty_text(self):
        out = judge.summarize(self.store, self.gw, "", max_tokens=50)
        self.assertEqual(out["summary"], "")
        self.assertTrue(out["degraded"])

    def test_abstraction_cues_rules(self):
        text = "# 模型网关设计\n网关负责 chat/embedding/reranker 判定，失败必须显式降级。"
        out = judge.abstraction_cues(self.store, self.gw, text)
        self.assertTrue(out["degraded"])
        self.assertTrue(out["cues"])
        self.assertTrue(all(isinstance(c, str) and c for c in out["cues"]))
        self.assertIn("？", out["cues"][0])
        self.assertLessEqual(len(out["cues"]), 6)


# ============================================================
# 2. 配置了 judge → 走 LLM
# ============================================================
class TestLLMPath(JudgeCase):
    def test_all_functions_use_llm(self):
        with FakeJudgeServer() as srv:
            self.configure(srv.base)

            cls = judge.classify(self.store, self.gw, "我们决定采用 SQLite")
            self.assertFalse(cls["degraded"])
            self.assertEqual(cls["kind"], "decision")
            self.assertEqual(cls["category"], "engineering")
            self.assertAlmostEqual(cls["importance"], 0.9)

            ddup = judge.dedup_verdict(self.store, self.gw,
                                       {"body": "新的正文"}, {"id": "m-old", "body": "旧正文"}, 0.8)
            self.assertFalse(ddup["degraded"])
            self.assertEqual(ddup["action"], "merge")
            self.assertEqual(ddup["merged_body"], "合并后的正文")

            conf = judge.conflict_verdict(self.store, self.gw, {"body": "a"}, {"body": "b"})
            self.assertFalse(conf["degraded"])
            self.assertEqual(conf["preferred"], "b")
            self.assertAlmostEqual(conf["confidence"], 0.81)

            ver = judge.verify_claims(self.store, self.gw, "项目使用 SQLite", ["项目使用 SQLite"])
            self.assertFalse(ver["degraded"])
            self.assertEqual(ver["verdict"], "pass")

            summ = judge.summarize(self.store, self.gw, "很长的正文。第二句。", max_tokens=50)
            self.assertFalse(summ["degraded"])
            self.assertEqual(summ["summary"], "这是 LLM 生成的摘要。")

            cues = judge.abstraction_cues(self.store, self.gw, "# 标题\n正文")
            self.assertFalse(cues["degraded"])
            self.assertEqual(len(cues["cues"]), 2)

    def test_prompt_template_is_rendered(self):
        with FakeJudgeServer() as srv:
            self.configure(srv.base)
            judge.classify(self.store, self.gw, "唯一标记文本-ZZZ")
            prompts = [p["messages"][-1]["content"] for p in srv.payloads]
            self.assertTrue(any("唯一标记文本-ZZZ" in p for p in prompts))
            self.assertFalse(any("{{body}}" in p for p in prompts))
            # json_mode 打开
            self.assertEqual(srv.payloads[0]["response_format"], {"type": "json_object"})

    def test_bad_llm_json_degrades_to_rules(self):
        with FakeJudgeServer("bad") as srv:
            self.configure(srv.base)
            out = judge.classify(self.store, self.gw, "我喜欢深色主题")
            self.assertTrue(out["degraded"])
            self.assertEqual(out["kind"], "preference")
            self.assertIn("返回格式错误", out["reason"])

            cues = judge.abstraction_cues(self.store, self.gw, "# 标题\n正文")
            self.assertTrue(cues["degraded"])
            self.assertTrue(cues["cues"])

    def test_unreachable_gateway_degrades(self):
        # 指向一个必然拒绝连接的地址
        self.configure("http://127.0.0.1:1")
        gw = ModelGateway(store=self.store, retries=0, sleep=lambda s: None)
        try:
            out = judge.classify(self.store, gw, "待办：明天补测试")
            self.assertTrue(out["degraded"])
            self.assertEqual(out["kind"], "task")
            self.assertIn("模型不可用", out["reason"])
        finally:
            gw.close()


# ============================================================
# 3. 适配层
# ============================================================
class TestStoreAdapter(JudgeCase):
    def test_store_con_is_preferred(self):
        con = sqlite3.connect(str(self.db_path), isolation_level=None)
        con.row_factory = sqlite3.Row

        class StoreWithCon:
            db_path = None  # 故意给假值

            def __init__(self, con):
                self.con = con

        gw = ModelGateway(store=StoreWithCon(con))
        try:
            con.execute(
                "INSERT OR REPLACE INTO model_profile(id, role, label, provider, model, base_url, "
                "api_key_ref, dim, batch, timeout_ms, params, priority, enabled, created_at) "
                "VALUES('x','chat','x','openai','m','http://127.0.0.1:1',NULL,NULL,16,60000,'{}',1,1,?)",
                (dbmod.now(),),
            )
            self.assertEqual(gw.roles()["chat"].id, "x")
        finally:
            gw.close()
            self.assertIsNone(gw._self_con)  # 复用了外部连接，没有自建
            con.close()

    def test_self_connection_when_no_store(self):
        gw = ModelGateway(db_path=self.db_path)
        try:
            self.assertEqual(gw.roles()["chat"], None)
            self.assertIsNotNone(gw._self_con)
        finally:
            gw.close()
            self.assertIsNone(gw._self_con)


if __name__ == "__main__":
    unittest.main(verbosity=2)
