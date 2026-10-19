# -*- coding: utf-8 -*-
"""tests/test_agents.py — 智能体登记、四种探针、会话生命周期、后台探活。

全部离线：临时数据目录 + 本地 socket 服务 + 临时文件，不联网、不依赖 psutil。
"""

from __future__ import annotations

import json
import os
import socket
import sqlite3
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from memora_core import agents as ag
from memora_core import db as dbmod
from memora_core.paths import Paths
from memora_core.store import Store
from memora_core.vault import Vault


def make_store() -> tuple[Store, Paths]:
    tmp = Path(tempfile.mkdtemp(prefix="memora-agents-"))
    paths = Paths(tmp).ensure()
    dbmod.init_db(paths.db)
    return Store(paths.db, Vault(paths.vault)), paths


def free_port() -> int:
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


class AgentSeedTest(unittest.TestCase):
    def setUp(self):
        self.store, self.paths = make_store()

    def tearDown(self):
        self.store.close()

    def test_seed_agents_idempotent(self):
        builtin = ag.builtin_agents()
        self.assertEqual(len(builtin), 6, "内置应有 6 个智能体")
        first = ag.seed_agents(self.store)
        second = ag.seed_agents(self.store)
        self.assertEqual(first, 6)
        self.assertEqual(second, 6)
        rows = self.store.con.execute("SELECT count(*) FROM agent").fetchone()[0]
        self.assertEqual(rows, 6, "重复 seed 不应产生重复行")

    def test_seed_records_probes(self):
        ag.seed_agents(self.store)
        row = ag._agent_row(self.store, "dsh-desktop")
        self.assertIsNotNone(row)
        self.assertTrue(row["static_registered"])
        self.assertEqual(row["ecosystem"], "dsh")
        probes = row["metadata"]["probes"]
        kinds = {p["type"] for p in probes}
        self.assertEqual(kinds, {"process", "port", "file"})
        self.assertIn("mcp", {p["type"] for p in ag._agent_row(self.store, "generic-mcp")
                              ["metadata"]["probes"]})

    def test_register_custom_agent(self):
        item = ag.register_agent(self.store, "my-bot", display_name="我的智能体",
                                 ecosystem="custom", kind="plugin")
        self.assertEqual(item["id"], "my-bot")
        self.assertEqual(item["display_name"], "我的智能体")
        self.assertFalse(item["static_registered"])


class ProbeTest(unittest.TestCase):
    def setUp(self):
        self.store, self.paths = make_store()
        ag.seed_agents(self.store)

    def tearDown(self):
        self.store.close()

    # ---------- process ----------
    def test_process_probe_finds_self(self):
        """用当前 Python 进程名做 match，进程探针必须命中。"""
        snapshot = ag.process_list()
        self.assertGreater(len(snapshot), 0, "进程快照不能为空")
        exe = Path(sys.executable).name
        state, detail = ag.match_process([exe], snapshot)
        self.assertEqual(state, "found", "应命中当前 Python 进程: %s" % detail)
        self.assertIn("pid=", detail)

    def test_process_probe_absent(self):
        state, detail = ag.match_process(
            ["绝对不存在的进程名-zzz-9999"], ag.process_list())
        self.assertEqual(state, "absent")
        self.assertIn("未发现", detail)

    def test_process_probe_without_match_is_error(self):
        state, _ = ag.match_process([], ag.process_list())
        self.assertEqual(state, "error")

    def test_process_probe_never_uses_psutil(self):
        """模块源码里不能出现 psutil。"""
        source = Path(ag.__file__).read_text(encoding="utf-8")
        self.assertNotIn("import psutil", source)
        self.assertIn("CreateToolhelp32Snapshot", source)

    # ---------- port ----------
    def test_port_probe_found(self):
        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
        listener.listen(1)
        try:
            state, detail = ag.probe_port([port])
        finally:
            listener.close()
        self.assertEqual(state, "found", detail)
        self.assertIn(str(port), detail)

    def test_port_probe_absent(self):
        state, detail = ag.probe_port([free_port()])
        self.assertEqual(state, "absent")

    def test_port_probe_timeout_is_bounded(self):
        started = time.perf_counter()
        ag.probe_port([free_port()])
        elapsed = time.perf_counter() - started
        self.assertLess(elapsed, 2.0, "端口探针必须有界（超时 300ms）")

    # ---------- file ----------
    def test_file_probe_fresh_heartbeat(self):
        path = Path(self.paths.heartbeat) / "probe.json"
        path.write_text(json.dumps({"ok": True}), encoding="utf-8")
        state, detail = ag.probe_file([str(path)], ttl=90)
        self.assertEqual(state, "found", detail)

    def test_file_probe_stale_heartbeat(self):
        path = Path(self.paths.heartbeat) / "old.json"
        path.write_text("{}", encoding="utf-8")
        old = time.time() - 1000
        os.utime(path, (old, old))
        state, detail = ag.probe_file([str(path)], ttl=90)
        self.assertEqual(state, "absent")
        self.assertIn("过期", detail)

    def test_file_probe_missing(self):
        state, _ = ag.probe_file([str(Path(self.paths.tmp) / "nope.json")])
        self.assertEqual(state, "absent")

    # ---------- mcp ----------
    def test_mcp_probe_requires_heartbeat(self):
        state, detail = ag.probe_mcp(self.store, "generic-mcp", ttl=90)
        self.assertEqual(state, "absent")

    def test_mcp_probe_after_heartbeat(self):
        ag.heartbeat(self.store, "generic-mcp", {"source": "mcp"})
        state, detail = ag.probe_mcp(self.store, "generic-mcp", ttl=90)
        self.assertEqual(state, "found", detail)
        self.assertIn("MCP", detail)

    def test_mcp_probe_ignores_other_sources(self):
        ag.heartbeat(self.store, "generic-mcp", {"source": "manual"})
        state, detail = ag.probe_mcp(self.store, "generic-mcp", ttl=90)
        self.assertEqual(state, "absent")
        self.assertIn("manual", detail)

    # ---------- 汇总 ----------
    def test_probe_all_writes_agent_probe_rows(self):
        before = self.store.con.execute("SELECT count(*) FROM agent_probe").fetchone()[0]
        result = ag.probe_all(self.store)
        after = self.store.con.execute("SELECT count(*) FROM agent_probe").fetchone()[0]
        self.assertEqual(result["checked"], 6)
        self.assertGreater(after - before, 0, "必须逐条写 agent_probe")
        self.assertEqual(len(result["results"]), after - before)
        for item in result["results"]:
            self.assertIn(item["state"], ("found", "absent", "error"))
            self.assertIn("latency_ms", item)
            self.assertIn("probe", item)
            self.assertIn("detail", item)

    def test_probe_all_online_matches_found(self):
        result = ag.probe_all(self.store)
        found_agents = {r["agent_id"] for r in result["results"] if r["state"] == "found"}
        self.assertEqual(set(result["online"]), found_agents)
        for aid in result["online"]:
            row = ag._agent_row(self.store, aid)
            self.assertEqual(row["status"], "online")
        for aid in result["offline"]:
            row = ag._agent_row(self.store, aid)
            self.assertEqual(row["status"], "offline")

    def test_probe_error_does_not_crash(self):
        ag.register_agent(self.store, "broken", display_name="坏配置")
        with ag._txn(self.store) as con:
            con.execute("UPDATE agent SET metadata = ? WHERE id = ?",
                        (json.dumps({"probes": [{"type": "不存在的探针", "match": []}]}),
                         "broken"))
        result = ag.probe_all(self.store, agents=["broken"])
        self.assertEqual(result["checked"], 1)
        self.assertEqual(result["results"][0]["state"], "error")
        self.assertIn("broken", result["offline"])


class HeartbeatTest(unittest.TestCase):
    def setUp(self):
        self.store, self.paths = make_store()
        ag.seed_agents(self.store)

    def tearDown(self):
        self.store.close()

    def test_heartbeat_updates_fields(self):
        item = ag.heartbeat(self.store, "claude-code", {
            "source": "mcp", "status": "online",
            "capabilities": {"tools": ["memory_recall"], "protocols": ["mcp-stdio"]},
            "detail": "测试心跳",
        })
        self.assertTrue(item["ok"])
        self.assertEqual(item["status"], "online")
        self.assertEqual(item["heartbeat_source"], "mcp")
        self.assertIn("mcp-stdio", item["capabilities"]["protocols"])
        self.assertIn("memory_recall", item["capabilities"]["tools"])
        self.assertTrue(item["last_heartbeat"])

    def test_heartbeat_merges_capabilities(self):
        ag.heartbeat(self.store, "claude-code", {"capabilities": {"tools": ["a"]}})
        item = ag.heartbeat(self.store, "claude-code", {"capabilities": {"tools": ["b"]}})
        self.assertEqual(sorted(item["capabilities"]["tools"]), ["a", "b"])

    def test_heartbeat_autoregisters(self):
        item = ag.heartbeat(self.store, "brand-new", {"source": "mcp"})
        self.assertEqual(item["id"], "brand-new")
        self.assertFalse(item["static_registered"])

    def test_heartbeat_requires_agent_id(self):
        with self.assertRaises(ValueError):
            ag.heartbeat(self.store, "", {})

    def test_heartbeat_writes_audit(self):
        ag.heartbeat(self.store, "claude-code", {"source": "mcp"})
        row = self.store.con.execute(
            "SELECT count(*) FROM audit WHERE action = 'agent.heartbeat'").fetchone()[0]
        self.assertGreaterEqual(row, 1)


class StatusTest(unittest.TestCase):
    def setUp(self):
        self.store, self.paths = make_store()
        ag.seed_agents(self.store)

    def tearDown(self):
        self.store.close()

    def test_agent_status_shape(self):
        ag.heartbeat(self.store, "claude-code", {"source": "mcp"})
        ag.register_session(self.store, "claude-code", "sess-1", title="会话一")
        self.store.add_memory({"scope_id": "global", "agent_id": "claude-code",
                               "kind": "fact", "title": "一条事实", "body": "正文",
                               "status": "approved"})
        rows = ag.agent_status(self.store)
        self.assertEqual(len(rows), 6)
        by_id = {r["id"]: r for r in rows}
        item = by_id["claude-code"]
        for key in ("status", "online_since", "last_seen", "probes", "sessions", "memories"):
            self.assertIn(key, item)
        self.assertEqual(item["status"], "online")
        self.assertTrue(item["online_since"])
        self.assertEqual(item["sessions"]["total"], 1)
        self.assertEqual(item["sessions"]["active"], 1)
        self.assertEqual(item["memories"]["total"], 1)
        self.assertEqual(item["memories"]["approved"], 1)
        self.assertIn("mcp-stdio", by_id["claude-code"]["protocols"])

    def test_agent_status_includes_probe_history(self):
        ag.probe_all(self.store, agents=["codex-cli"])
        rows = {r["id"]: r for r in ag.agent_status(self.store)}
        probes = rows["codex-cli"]["probes"]
        self.assertTrue(probes)
        self.assertEqual({p["probe"] for p in probes}, {"process", "file"})
        for probe in probes:
            self.assertIn("state", probe)
            self.assertIn("detail", probe)
            self.assertIn("latency_ms", probe)


class SessionTest(unittest.TestCase):
    def setUp(self):
        self.store, self.paths = make_store()
        ag.seed_agents(self.store)

    def tearDown(self):
        self.store.close()

    def test_register_and_end_session(self):
        session = ag.register_session(self.store, "codex-cli", "ext-42", title="重构检索",
                                      cwd="D:/proj", scope_id="workspace:proj")
        self.assertEqual(session["status"], "active")
        self.assertEqual(session["external_id"], "ext-42")
        self.assertEqual(session["scope_id"], "workspace:proj")
        self.assertFalse(session["resumed"])
        ended = ag.end_session(self.store, "codex-cli", "ext-42",
                               turns=[{"role": "user", "text": "你好"}])
        self.assertEqual(ended["status"], "ended")
        self.assertTrue(ended["ended_at"])
        self.assertEqual(ended["turns"], 1)

    def test_register_session_is_idempotent(self):
        first = ag.register_session(self.store, "codex-cli", "ext-1")
        second = ag.register_session(self.store, "codex-cli", "ext-1", title="改名")
        self.assertEqual(first["id"], second["id"])
        self.assertTrue(second["resumed"])
        self.assertEqual(second["title"], "改名")
        rows = self.store.con.execute(
            "SELECT count(*) FROM agent_session WHERE agent_id = ?", ("codex-cli",)
        ).fetchone()[0]
        self.assertEqual(rows, 1)

    def test_end_session_reopens(self):
        ag.register_session(self.store, "codex-cli", "ext-7")
        ag.end_session(self.store, "codex-cli", "ext-7")
        again = ag.register_session(self.store, "codex-cli", "ext-7")
        self.assertEqual(again["status"], "active")
        self.assertIsNone(again["ended_at"])

    def test_end_session_orphan_creates_row(self):
        item = ag.end_session(self.store, "claude-desktop", "never-started")
        self.assertEqual(item["status"], "ended")
        self.assertEqual(item["turns"], 0)

    def test_session_requires_ids(self):
        with self.assertRaises(ValueError):
            ag.register_session(self.store, "", "x")
        with self.assertRaises(ValueError):
            ag.register_session(self.store, "codex-cli", "")


class WatchTest(unittest.TestCase):
    def setUp(self):
        self.store, self.paths = make_store()
        ag.seed_agents(self.store)

    def tearDown(self):
        ag.stop_watch()
        self.store.close()

    def test_watch_starts_daemon_thread(self):
        info = ag.watch(self.store, interval=1)
        try:
            self.assertTrue(info["started"])
            self.assertFalse(info["already_running"])
            self.assertEqual(info["thread"], "memora-agent-watch")
            thread = ThreadLookup.find("memora-agent-watch")
            self.assertIsNotNone(thread)
            self.assertTrue(thread.daemon, "探活线程必须是守护线程，不能阻塞主流程")
            self.assertTrue(thread.is_alive())
        finally:
            ag.stop_watch()

    def test_watch_is_idempotent(self):
        ag.watch(self.store, interval=1)
        second = ag.watch(self.store, interval=1)
        self.assertFalse(second["started"])
        self.assertTrue(second["already_running"])
        ag.stop_watch()

    def test_watch_records_probes_and_stops(self):
        ag.watch(self.store, interval=1)
        deadline = time.time() + 10
        while time.time() < deadline:
            probes = self.store.con.execute(
                "SELECT count(*) FROM agent_probe").fetchone()[0]
            if probes:
                break
            time.sleep(0.1)
        self.assertGreater(probes, 0, "后台线程必须写入探针结果")
        stopped = ag.stop_watch()
        self.assertGreaterEqual(stopped, 1)
        self.assertEqual(ag.watch_state(), [])


class ThreadLookup:
    @staticmethod
    def find(name: str):
        for thread in threading.enumerate():
            if thread.name == name:
                return thread
        return None


if __name__ == "__main__":
    unittest.main(verbosity=2)
