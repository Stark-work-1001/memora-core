# -*- coding: utf-8 -*-
"""tests/test_mcp.py — JSON-RPC 帧、22 个工具、错误码、真实 stdio 子进程握手。"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from memora_core import __version__
from memora_core import agents as ag
from memora_core import db as dbmod
from memora_core import mcp
from memora_core.paths import Paths
from memora_core.store import Store
from memora_core.vault import Vault

FROZEN = (
    "memory_capture", "memory_remember", "memory_recall", "memory_search", "memory_digest",
    "memory_get", "memory_update", "memory_forget", "memory_relate", "memory_evidence",
    "memory_review", "memory_graph", "memory_session_begin", "memory_session_end",
    "memory_agent_status", "memory_scope_list", "memory_stats", "memory_workflow_run",
    "memory_workflow_list", "memory_export", "memory_import", "memory_health",
)
REPO = Path(__file__).resolve().parent.parent


def make_store(prefix: str = "memora-mcp-") -> tuple[Store, Paths]:
    tmp = Path(tempfile.mkdtemp(prefix=prefix))
    paths = Paths(tmp).ensure()
    dbmod.init_db(paths.db)
    return Store(paths.db, Vault(paths.vault)), paths


def rpc(store, body: dict, agent_id: str = "test-agent") -> dict:
    """走 handle_rpc（不做行解析），返回响应对象。"""
    return mcp.handle_rpc(store, None, body, {}, agent_id=agent_id)


class ToolRegistryTest(unittest.TestCase):
    def test_exactly_22_frozen_tools(self):
        self.assertEqual(len(mcp.TOOL_NAMES), 22)
        self.assertEqual(tuple(mcp.TOOL_NAMES), FROZEN)
        self.assertEqual(mcp.list_tool_names(), list(FROZEN))
        self.assertEqual(set(mcp.TOOLS), set(FROZEN))

    def test_every_tool_has_description_and_schema(self):
        for name in FROZEN:
            spec = mcp.TOOLS[name]
            self.assertTrue(spec["description"], "%s 缺少 description" % name)
            self.assertEqual(spec["inputSchema"]["type"], "object")
            self.assertIn("properties", spec["inputSchema"])
            self.assertTrue(callable(spec["handler"]), "%s 缺少 handler" % name)

    def test_tools_list_frame(self):
        store, _ = make_store()
        try:
            response = rpc(store, {"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
            self.assertEqual(response["jsonrpc"], "2.0")
            self.assertEqual(response["id"], 1)
            tools = response["result"]["tools"]
            self.assertEqual(len(tools), 22)
            names = [t["name"] for t in tools]
            self.assertEqual(names, list(FROZEN))
            for item in tools:
                self.assertIn("inputSchema", item)
        finally:
            store.close()


class HandshakeTest(unittest.TestCase):
    def setUp(self):
        self.store, self.paths = make_store()
        ag.seed_agents(self.store)

    def tearDown(self):
        self.store.close()

    def test_initialize(self):
        response = rpc(self.store, {"jsonrpc": "2.0", "id": 0, "method": "initialize",
                                    "params": {"protocolVersion": "2024-11-05",
                                               "clientInfo": {"name": "claude-code",
                                                              "version": "1.2.3"}}})
        result = response["result"]
        self.assertEqual(result["protocolVersion"], "2024-11-05")
        self.assertEqual(result["serverInfo"]["name"], "memora-core")
        self.assertEqual(result["serverInfo"]["version"], __version__)  # 1.0.0 把版本号硬编码在 mcp.py 里
        self.assertIn("tools", result["capabilities"])
        row = ag._agent_row(self.store, "claude-code")
        self.assertEqual(row["heartbeat_source"], "mcp", "握手必须刷新在场")

    def test_initialized_notification_has_no_response(self):
        self.assertIsNone(mcp.process_line(
            self.store, None, json.dumps({"jsonrpc": "2.0",
                                          "method": "notifications/initialized"})))

    def test_ping(self):
        response = rpc(self.store, {"jsonrpc": "2.0", "id": 2, "method": "ping"})
        self.assertEqual(response["result"], {})

    def test_resources_list_empty(self):
        response = rpc(self.store, {"jsonrpc": "2.0", "id": 3, "method": "resources/list"})
        self.assertEqual(response["result"]["resources"], [])

    def test_unknown_method(self):
        response = rpc(self.store, {"jsonrpc": "2.0", "id": 4, "method": "does/not/exist"})
        self.assertEqual(response["error"]["code"], mcp.METHOD_NOT_FOUND)


class FrameTest(unittest.TestCase):
    def setUp(self):
        self.store, self.paths = make_store()

    def tearDown(self):
        self.store.close()

    def test_parse_error(self):
        response = mcp.process_line(self.store, None, "{不是 JSON}")
        self.assertEqual(response["error"]["code"], mcp.PARSE_ERROR)
        self.assertIsNone(response["id"])

    def test_blank_line_ignored(self):
        self.assertIsNone(mcp.process_line(self.store, None, "   "))

    def test_frame_has_no_content_length(self):
        frame = json.dumps(rpc(self.store, {"jsonrpc": "2.0", "id": 1,
                                            "method": "tools/list"}), ensure_ascii=False)
        self.assertNotIn("Content-Length", frame)
        self.assertNotIn("\n", frame, "一帧必须在一行内")

    def test_batch_array(self):
        body = [{"jsonrpc": "2.0", "id": 1, "method": "ping"},
                {"jsonrpc": "2.0", "id": 2, "method": "tools/list"}]
        response = mcp.process_line(self.store, None, json.dumps(body))
        self.assertIsInstance(response, list)
        self.assertEqual(len(response), 2)


class ToolCallTest(unittest.TestCase):
    def setUp(self):
        self.store, self.paths = make_store()
        ag.seed_agents(self.store)

    def tearDown(self):
        self.store.close()

    def call(self, name: str, args: dict, agent_id: str = "claude-code") -> dict:
        response = rpc(self.store, {"jsonrpc": "2.0", "id": 9, "method": "tools/call",
                                    "params": {"name": name, "arguments": args}},
                       agent_id=agent_id)
        return response

    def test_tools_call_returns_content(self):
        response = self.call("memory_remember", {
            "text": "SQLite WAL 允许并发读", "title": "WAL 并发",
            "kind": "fact", "evidence_kind": "tool_output", "quote": "PRAGMA journal_mode=WAL"})
        self.assertIn("result", response, response)
        result = response["result"]
        self.assertEqual(result["isError"], False)
        self.assertEqual(result["content"][0]["type"], "text")
        payload = json.loads(result["content"][0]["text"])
        self.assertEqual(payload["kind"], "fact")
        self.assertEqual(result["structuredContent"]["id"], payload["id"])

    def test_tools_call_refreshes_heartbeat(self):
        self.call("memory_stats", {})
        row = ag._agent_row(self.store, "claude-code")
        self.assertEqual(row["heartbeat_source"], "mcp")
        self.assertTrue(row["last_heartbeat"])

    def test_recall_writes_recall_log(self):
        self.call("memory_remember", {"text": "RRF 融合多路召回", "title": "RRF"})
        self.call("memory_recall", {"query": "RRF", "scope": "global"})
        rows = self.store.con.execute(
            "SELECT query, agent_id FROM recall_log ORDER BY created_at DESC").fetchall()
        self.assertGreaterEqual(len(rows), 1)
        self.assertEqual(rows[0]["agent_id"], "claude-code")

    def test_search_does_not_write_recall_log(self):
        before = self.store.con.execute("SELECT count(*) FROM recall_log").fetchone()[0]
        self.call("memory_search", {"query": "任何东西", "scope": "global"})
        after = self.store.con.execute("SELECT count(*) FROM recall_log").fetchone()[0]
        self.assertEqual(before, after)

    def test_write_tool_writes_audit(self):
        response = self.call("memory_remember", {"text": "写入审计检查", "title": "审计"})
        mid = response["result"]["structuredContent"]["id"]
        row = self.store.con.execute(
            "SELECT count(*) FROM audit WHERE action = 'mcp.memory_remember' AND target = ?",
            (mid,)).fetchone()[0]
        self.assertEqual(row, 1)

    def test_unknown_tool_is_parameter_error(self):
        response = self.call("memory_不存在", {})
        self.assertEqual(response["error"]["code"], mcp.PARAM_ERROR)
        self.assertIn("未知工具", response["error"]["message"])

    def test_missing_required_argument(self):
        response = self.call("memory_get", {})
        self.assertEqual(response["error"]["code"], mcp.PARAM_ERROR)
        self.assertIn("id", response["error"]["message"])

    def test_missing_memory_is_parameter_error(self):
        response = self.call("memory_get", {"id": "m-不存在"})
        self.assertEqual(response["error"]["code"], mcp.PARAM_ERROR)

    def test_bad_limit_type(self):
        response = self.call("memory_search", {"query": "x", "limit": "很多"})
        self.assertEqual(response["error"]["code"], mcp.PARAM_ERROR)

    def test_internal_error_is_wrapped(self):
        """工作流模板不存在时必须是 -32603 错误帧，不能抛到协议流。"""
        response = self.call("memory_workflow_run", {"template": "不存在的模板"})
        self.assertIn("error", response)
        self.assertEqual(response["error"]["code"], mcp.INTERNAL_ERROR)

    def test_workflow_tools_degrade_gracefully(self):
        """workflows 模块未就绪时必须返回错误帧而不是崩溃。"""
        outcome = mcp.dispatch(self.store, None, "memory_workflow_list", {}, "tester")
        self.assertTrue(outcome["ok"], outcome)
        self.assertIn("templates", outcome["result"])
        self.assertIn("total", outcome["result"])


class ToolSurfaceTest(unittest.TestCase):
    """逐个工具跑一次最小调用，确保 22 个都不炸协议流。"""

    def setUp(self):
        self.store, self.paths = make_store()
        ag.seed_agents(self.store)

    def tearDown(self):
        self.store.close()

    def test_all_tools_execute(self):
        created = mcp.dispatch(self.store, None, "memory_remember",
                               {"text": "被其它工具引用的记忆", "title": "锚点"}, "tester")
        mid = created["result"]["id"]
        # 导出只带 approved，先把锚点记忆审核通过——由人（store 的 user 来源）批准：
        # agent 经 memory_update 自己批准已被禁止（ADR-0002，见 tests/test_trust.py）
        self.store.set_status(mid, "approved")
        session = mcp.dispatch(self.store, None, "memory_session_begin",
                               {"external_id": "s-1", "title": "会话"}, "tester")
        export = mcp.dispatch(self.store, None, "memory_export", {"status": None}, "tester")
        jsonl = export["result"]["jsonl"]
        self.assertTrue(jsonl.strip(), "导出不能为空，否则无法验证导入")
        cases = {
            "memory_capture": {"text": "草稿"},
            "memory_remember": {"text": "第二条"},
            "memory_recall": {"query": "记忆"},
            "memory_search": {"query": "记忆"},
            "memory_digest": {"scope": "global", "budget": 200},
            "memory_get": {"id": mid},
            "memory_update": {"id": mid, "importance": 0.9},
            "memory_relate": {"src": mid, "dst": mid, "rel": "supports"},
            "memory_evidence": {"id": mid, "kind": "user_stated", "quote": "用户原话"},
            "memory_review": {"id": mid, "grade": 5},
            "memory_graph": {"view": "semantic"},
            "memory_session_begin": {"external_id": "s-2"},
            "memory_session_end": {"external_id": "s-2", "turns": [{"text": "hi"}]},
            "memory_agent_status": {},
            "memory_scope_list": {},
            "memory_stats": {},
            "memory_workflow_list": {},
            "memory_export": {"status": None},
            "memory_import": {"text": jsonl, "dry_run": True},
            "memory_health": {},
            "memory_forget": {"id": mid},
        }
        self.assertTrue(session["ok"])
        for name, args in cases.items():
            outcome = mcp.dispatch(self.store, None, name, args, "tester")
            self.assertIn("ok", outcome, name)
            if not outcome["ok"]:
                code = outcome["error"]["code"]
                self.assertEqual(code, mcp.INTERNAL_ERROR,
                                 "%s 不该是参数错: %s" % (name, outcome["error"]))
        self.assertEqual(len(cases) + 1, 22, "必须覆盖全部 22 个工具")

    def test_review_writes_sm2(self):
        mid = mcp.dispatch(self.store, None, "memory_remember",
                           {"text": "复习对象", "title": "复习"}, "tester")["result"]["id"]
        outcome = mcp.dispatch(self.store, None, "memory_review", {"id": mid, "grade": 5},
                               "tester")
        self.assertTrue(outcome["ok"], outcome)
        self.assertEqual(outcome["result"]["interval_days"], 1.0)
        again = mcp.dispatch(self.store, None, "memory_review", {"id": mid, "grade": 4}, "tester")
        self.assertGreater(again["result"]["due"], "")
        row = self.store.get_memory(mid)
        self.assertEqual(row["review_count"], 2)
        self.assertTrue(row["review_due"])

    def test_review_grade_range(self):
        mid = mcp.dispatch(self.store, None, "memory_remember",
                           {"text": "复习范围", "title": "范围"}, "tester")["result"]["id"]
        outcome = mcp.dispatch(self.store, None, "memory_review", {"id": mid, "grade": 9},
                               "tester")
        self.assertFalse(outcome["ok"])
        self.assertEqual(outcome["error"]["code"], mcp.PARAM_ERROR)

    def test_session_lifecycle_via_mcp(self):
        begin = mcp.dispatch(self.store, None, "memory_session_begin",
                             {"external_id": "ext-9", "title": "生命周期"}, "codex-cli")
        self.assertTrue(begin["ok"], begin)
        self.assertEqual(begin["result"]["status"], "active")
        end = mcp.dispatch(self.store, None, "memory_session_end",
                           {"external_id": "ext-9", "turns": [{"text": "再见"}]}, "codex-cli")
        self.assertTrue(end["ok"], end)
        self.assertEqual(end["result"]["status"], "ended")

    def test_agent_status_lists_online(self):
        mcp.dispatch(self.store, None, "memory_stats", {}, "claude-code")
        outcome = mcp.dispatch(self.store, None, "memory_agent_status", {}, "claude-code")
        self.assertTrue(outcome["ok"])
        ids = [a["id"] for a in outcome["result"]["agents"]]
        self.assertIn("claude-code", ids)


class HttpTest(unittest.TestCase):
    def setUp(self):
        self.store, self.paths = make_store()

    def tearDown(self):
        self.store.close()

    def test_handle_http_initialize(self):
        response = mcp.handle_http(self.store, None,
                                   {"jsonrpc": "2.0", "id": 1, "method": "initialize",
                                    "params": {}},
                                   {"X-Memora-Agent": "http-client"})
        self.assertEqual(response["result"]["serverInfo"]["name"], "memora-core")

    def test_handle_http_notification(self):
        response = mcp.handle_http(self.store, None,
                                   {"jsonrpc": "2.0", "method": "notifications/initialized"},
                                   {})
        self.assertEqual(response["jsonrpc"], "2.0")

    def test_handle_http_tools_call(self):
        response = mcp.handle_http(self.store, None,
                                   {"jsonrpc": "2.0", "id": 2, "method": "tools/call",
                                    "params": {"name": "memory_stats", "arguments": {}}},
                                   {"X-Memora-Agent": "http-client"})
        self.assertIn("result", response)


class StdioProcessTest(unittest.TestCase):
    """真起一个 python -m memora_core mcp-stdio 子进程，走完整 stdin/stdout 握手。"""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="memora-mcp-stdio-"))
        self.paths = Paths(self.tmp).ensure()
        dbmod.init_db(self.paths.db)

    def test_stdio_handshake_and_call(self):
        frames = [
            {"jsonrpc": "2.0", "id": 1, "method": "initialize",
             "params": {"protocolVersion": "2024-11-05",
                        "capabilities": {}, "clientInfo": {"name": "claude-code",
                                                           "version": "1.0"}}},
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
            {"jsonrpc": "2.0", "id": 3, "method": "tools/call",
             "params": {"name": "memory_remember",
                        "arguments": {"text": "stdio 通道可用", "title": "stdio 测试",
                                      "kind": "fact"}}},
            {"jsonrpc": "2.0", "id": 4, "method": "tools/call",
             "params": {"name": "memory_stats", "arguments": {}}},
        ]
        stdin_text = "\n".join(json.dumps(f, ensure_ascii=False) for f in frames) + "\n"
        env = dict(os.environ)
        env["PYTHONIOENCODING"] = "utf-8"
        proc = subprocess.run(
            [sys.executable, "-m", "memora_core", "--data", str(self.tmp), "mcp-stdio"],
            input=stdin_text.encode("utf-8"), capture_output=True, cwd=str(REPO),
            env=env, timeout=120,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr.decode("utf-8", "replace")[-2000:])
        lines = [ln for ln in proc.stdout.decode("utf-8").splitlines() if ln.strip()]
        self.assertEqual(len(lines), 4, "通知不回帧，其余 4 条必须都有响应")
        responses = [json.loads(ln) for ln in lines]
        by_id = {r["id"]: r for r in responses}
        self.assertEqual(by_id[1]["result"]["protocolVersion"], "2024-11-05")
        self.assertEqual(len(by_id[2]["result"]["tools"]), 22)
        call = by_id[3]["result"]
        self.assertFalse(call["isError"])
        payload = json.loads(call["content"][0]["text"])
        self.assertEqual(payload["kind"], "fact")
        self.assertIn("id", payload)
        self.assertIn("memories", by_id[4]["result"]["structuredContent"])
        # 全程 stdout 只能有协议帧
        for line in lines:
            obj = json.loads(line)
            self.assertEqual(obj["jsonrpc"], "2.0")
            self.assertIn(("result", "error")[0], obj)

    def test_stdio_survives_bad_frame(self):
        frames = [
            {"jsonrpc": "2.0", "id": 1, "method": "ping"},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/call",
             "params": {"name": "memory_get", "arguments": {}}},
        ]
        stdin_text = "这不是 JSON\n" + "\n".join(
            json.dumps(f, ensure_ascii=False) for f in frames) + "\n"
        env = dict(os.environ)
        env["PYTHONIOENCODING"] = "utf-8"
        proc = subprocess.run(
            [sys.executable, "-m", "memora_core", "--data", str(self.tmp), "mcp-stdio"],
            input=stdin_text.encode("utf-8"), capture_output=True, cwd=str(REPO),
            env=env, timeout=120,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr.decode("utf-8", "replace")[-1500:])
        responses = [json.loads(ln) for ln in proc.stdout.decode("utf-8").splitlines()
                     if ln.strip()]
        self.assertEqual(len(responses), 3, "坏帧必须回错误帧而不是中断")
        self.assertEqual(responses[0]["error"]["code"], mcp.PARSE_ERROR)
        self.assertEqual(responses[1]["result"], {})
        self.assertEqual(responses[2]["error"]["code"], mcp.PARAM_ERROR)


if __name__ == "__main__":
    unittest.main(verbosity=2)