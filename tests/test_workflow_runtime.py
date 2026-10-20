# -*- coding: utf-8 -*-
"""tests/test_workflow_runtime.py — 执行器运行时（engine 1.1.0）：异步运行与进度事件、协作式取消
（含 1.0.0 的两种竞态）、启动回收、孤儿运行、边语义（if: 谱系 / 最近祖先 / on_failure）、
emit 如实报告、并行层不改共享 vault、job 消费者（领取 / 退避 / 重试 / 后台线程）、会话结束用网关。
"""
from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from memora_core import agents as agents_mod  # noqa: E402
from memora_core import db as dbmod  # noqa: E402
from memora_core import events, models, workflows  # noqa: E402
from memora_core.store import Store  # noqa: E402
from memora_core.vault import Vault  # noqa: E402


class RuntimeCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.mkdtemp(prefix="memora-runtime-")
        self.db_path = os.path.join(self.tmp, "memora.db")
        dbmod.init_db(self.db_path)
        self.store = Store(self.db_path, Vault(os.path.join(self.tmp, "vault")))
        workflows.seed_templates(self.store)
        self._handlers: list[str] = []
        self._procs: list[subprocess.Popen] = []

    def tearDown(self) -> None:
        workflows.stop_background(self.db_path, timeout=5.0)
        for key in self._handlers:
            workflows.NODE_HANDLERS.pop(key, None)
        for proc in self._procs:
            if proc.poll() is None:
                proc.kill()
                proc.wait()
        self.store.close()

    # ---------------- 小工具 ----------------
    def register(self, key: str, handler) -> None:
        workflows.register_handler(key, handler)
        self._handlers.append(key)

    def add_template(self, tid: str, nodes: list, edges: list = (), **spec_extra) -> None:
        spec = {"nodes": nodes, "edges": list(edges), "fallbacks": {}, "inputs": {},
                "trigger": {"kind": "manual"}}
        spec.update(spec_extra)
        stamp = dbmod.now()
        with self.store._txn() as con:
            con.execute("INSERT OR REPLACE INTO workflow_template(id, name, description, category, "
                        "version, spec, builtin, enabled, created_at, updated_at) "
                        "VALUES(?,?,?,?,?,?,?,?,?,?)",
                        (tid, tid, "", "test", 1, dbmod.dumps(spec), 0, 1, stamp, stamp))

    def status(self, run_id: str) -> str:
        con = sqlite3.connect(self.db_path)
        try:
            return con.execute("SELECT status FROM workflow_run WHERE id = ?", (run_id,)).fetchone()[0]
        finally:
            con.close()

    def step_status(self, run_id: str, node_id: str) -> str | None:
        con = sqlite3.connect(self.db_path)
        try:
            row = con.execute("SELECT status FROM workflow_step WHERE run_id = ? AND node_id = ?",
                              (run_id, node_id)).fetchone()
            return row[0] if row else None
        finally:
            con.close()

    def wait_for(self, predicate, timeout: float = 8.0) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if predicate():
                return
            time.sleep(0.02)
        self.fail("条件在 %.1f 秒内没有成立" % timeout)

    def wait_run(self, run_id: str, timeout: float = 10.0) -> dict:
        self.wait_for(lambda: self.status(run_id) in workflows.TERMINAL_STATUSES, timeout)
        return workflows.get_run(self.store, run_id)

    def spawn(self, code: str) -> subprocess.Popen:
        proc = subprocess.Popen([sys.executable, "-c", code])
        self._procs.append(proc)
        return proc

    def set_owner(self, run_id: str, pid: int) -> None:
        row = self.store.con.execute("SELECT metadata FROM workflow_run WHERE id = ?",
                                     (run_id,)).fetchone()
        meta = json.loads(row["metadata"])
        meta["owner"] = {"pid": pid, "boot": "another-process"}
        with self.store._txn() as con:
            con.execute("UPDATE workflow_run SET metadata = ? WHERE id = ?",
                        (json.dumps(meta), run_id))

    def gated_handler(self, key: str, gate: threading.Event, calls: list | None = None) -> None:
        def handler(ctx, node):
            if calls is not None:
                calls.append((ctx.run_id, node["id"]))
            gate.wait(10)
            return {"status": "ok", "text": node["id"]}
        self.register(key, handler)


class TestAsyncRuns(RuntimeCase):
    def test_async_returns_immediately_and_publishes_step_events(self) -> None:
        gate = threading.Event()
        self.gated_handler("t-gate", gate)
        self.add_template("t-async", [{"id": "a", "kind": "t-gate"}, {"id": "b", "kind": "emit"}],
                          [{"from": "a", "to": "b"}])
        bus = events.subscribe(("run",))
        try:
            started = time.monotonic()
            run = workflows.start_workflow(self.store, None, "t-async", {})
            self.assertLess(time.monotonic() - started, 1.0, "异步运行必须立即返回")
            self.assertIn(run["status"], ("queued", "running"))
            self.wait_for(lambda: self.step_status(run["id"], "a") == "running")
            self.assertEqual(self.status(run["id"]), "running")
            gate.set()
            final = self.wait_run(run["id"])
            self.assertEqual(final["status"], "ok")
            mine = [e for e in bus.drain(500) if e["data"].get("run_id") == run["id"]]
            self.assertTrue(mine and all(e["type"] == "run" for e in mine), "只用已有的 run 事件类型")
            phases = [e["data"]["phase"] for e in mine]
            self.assertEqual(phases[0], "queued")
            self.assertIn("start", phases)
            self.assertEqual(phases[-1], "end")
            steps = [(e["data"]["step"]["node_id"], e["data"]["step"]["status"])
                     for e in mine if e["data"]["phase"] == "step"]
            self.assertEqual(steps[:2], [("a", "running"), ("a", "ok")])
            self.assertIn(("b", "ok"), steps)
            self.assertEqual(mine[-1]["data"]["status"], "ok")
        finally:
            gate.set()
            bus.close()

    def test_runs_beyond_pool_size_wait_as_queued(self) -> None:
        gate = threading.Event()
        calls: list = []
        self.gated_handler("t-gate2", gate, calls)
        self.add_template("t-pool", [{"id": "a", "kind": "t-gate2"}])
        try:
            runs = [workflows.start_workflow(self.store, None, "t-pool", {})
                    for _ in range(workflows.RUN_POOL_SIZE + 1)]
            busy, waiting = runs[:-1], runs[-1]
            self.wait_for(lambda: all(self.status(r["id"]) == "running" for r in busy))
            time.sleep(0.1)
            self.assertEqual(self.status(waiting["id"]), "queued")
            gate.set()
            for run in runs:
                self.assertEqual(self.wait_run(run["id"])["status"], "ok")
        finally:
            gate.set()

    def test_cancel_while_queued_never_executes(self) -> None:
        gate = threading.Event()
        calls: list = []
        self.gated_handler("t-gate3", gate, calls)
        self.add_template("t-q", [{"id": "a", "kind": "t-gate3"}, {"id": "b", "kind": "t-gate3"}],
                          [{"from": "a", "to": "b"}])
        try:
            runs = [workflows.start_workflow(self.store, None, "t-q", {})
                    for _ in range(workflows.RUN_POOL_SIZE + 1)]
            waiting = runs[-1]
            self.wait_for(lambda: all(self.status(r["id"]) == "running" for r in runs[:-1]))
            result = workflows.cancel_run(self.store, waiting["id"])
            self.assertEqual(result["status"], "cancelled")
            self.assertEqual({s["node_id"]: s["status"] for s in result["steps"]},
                             {"a": "cancelled", "b": "cancelled"})
            gate.set()
            for run in runs[:-1]:
                self.wait_run(run["id"])
            time.sleep(0.2)
            self.assertNotIn(waiting["id"], [rid for rid, _ in calls], "排队时取消的运行不能再执行")
            self.assertEqual(self.status(waiting["id"]), "cancelled")
        finally:
            gate.set()


class TestCancel(RuntimeCase):
    def chain(self, tid: str, first_kind: str) -> list:
        calls: list = []

        def after(ctx, node):
            calls.append(node["id"])
            return {"status": "ok", "text": node["id"]}

        self.register("t-after-" + tid, after)
        self.add_template(tid, [{"id": "a", "kind": first_kind},
                                {"id": "b", "kind": "t-after-" + tid},
                                {"id": "c", "kind": "t-after-" + tid}],
                          [{"from": "a", "to": "b"}, {"from": "b", "to": "c"}])
        return calls

    def looping(self, key: str, started: threading.Event) -> None:
        def handler(ctx, node):
            started.set()
            for _ in range(800):
                ctx.check_cancel()  # 长循环节点的协作式取消点
                time.sleep(0.01)
            return {"status": "ok"}
        self.register(key, handler)

    def test_cancel_mid_run_ends_cancelled_and_later_nodes_never_start(self) -> None:
        started = threading.Event()
        self.looping("t-loop", started)
        calls = self.chain("t-cancel", "t-loop")
        run = workflows.start_workflow(self.store, None, "t-cancel", {})
        self.assertTrue(started.wait(5))
        result = workflows.cancel_run(self.store, run["id"])
        self.assertEqual(result["status"], "cancelled")
        self.assertTrue(result["cancel_requested"])
        self.assertEqual(calls, [], "取消之后的节点不能开始")
        self.assertEqual({s["node_id"]: s["status"] for s in result["steps"]},
                         {"a": "cancelled", "b": "cancelled", "c": "cancelled"})
        self.assertIn("运行被取消", result["error"])
        with self.assertRaises(workflows.WorkflowConflict):
            workflows.cancel_run(self.store, run["id"])
        with self.assertRaises(workflows.WorkflowNotFound):
            workflows.cancel_run(self.store, "run-missing")

    def test_cancel_of_sync_run_without_cancel_points_stops_at_node_boundary(self) -> None:
        started = threading.Event()

        def slow(ctx, node):
            started.set()
            time.sleep(0.4)  # 不检查取消：只能在节点边界停下
            return {"status": "ok"}

        self.register("t-slow", slow)
        calls = self.chain("t-cancel2", "t-slow")
        box: dict = {}
        worker = threading.Thread(target=lambda: box.update(
            run=workflows.run_workflow(self.store, None, "t-cancel2", {})))
        worker.start()
        self.assertTrue(started.wait(5))
        rid = self.store.con.execute("SELECT id FROM workflow_run WHERE template_id = 't-cancel2'"
                                     ).fetchone()[0]
        result = workflows.cancel_run(self.store, rid)
        worker.join(5)
        self.assertEqual(result["status"], "cancelled")
        self.assertEqual(box["run"]["status"], "cancelled")
        statuses = {s["node_id"]: s["status"] for s in box["run"]["steps"]}
        self.assertEqual(statuses, {"a": "ok", "b": "cancelled", "c": "cancelled"})
        self.assertEqual(calls, [])

    def test_cancel_flag_written_by_another_process_is_honoured(self) -> None:
        started = threading.Event()
        self.looping("t-loop2", started)
        calls = self.chain("t-cancel3", "t-loop2")
        run = workflows.start_workflow(self.store, None, "t-cancel3", {})
        self.assertTrue(started.wait(5))
        con = sqlite3.connect(self.db_path)  # 模拟别的进程：只改 DB 标记，不碰本进程的事件
        try:
            meta = json.loads(con.execute("SELECT metadata FROM workflow_run WHERE id = ?",
                                          (run["id"],)).fetchone()[0])
            meta["cancel_requested"] = True
            con.execute("UPDATE workflow_run SET metadata = ? WHERE id = ?",
                        (json.dumps(meta), run["id"]))
            con.commit()
        finally:
            con.close()
        self.assertEqual(self.wait_run(run["id"])["status"], "cancelled")
        self.assertEqual(calls, [])

    def test_cancel_arriving_after_the_last_check_does_not_claim_cancelled(self) -> None:
        holder: dict = {}

        def last(ctx, node):
            holder["response"] = workflows.cancel_run(ctx.store, ctx.run_id, wait=0)
            return {"status": "ok"}

        self.register("t-last", last)
        self.add_template("t-race-c", [{"id": "only", "kind": "t-last"}])
        run = workflows.run_workflow(self.store, None, "t-race-c", {})
        self.assertEqual(holder["response"]["status"], "running")
        self.assertTrue(holder["response"]["cancel_requested"])
        self.assertEqual(run["status"], "ok", "所有节点都跑完了：终态按事实是 ok")
        self.assertEqual(self.status(run["id"]), "ok")
        self.assertIn("cancel_ignored", run["meta"])

    def test_final_write_is_compare_and_set(self) -> None:
        run = workflows.run_workflow(self.store, None, "quick-capture", {"content": "x"})
        landed = workflows._finalize_run(self.store, run["id"], status="failed", output={},
                                         error="late writer", finished=workflows.iso_now())
        self.assertFalse(landed, "终态已写，迟到的收尾不能覆盖")
        self.assertEqual(self.status(run["id"]), "ok")

    def test_run_finishing_during_cancel_is_never_overwritten(self) -> None:
        plan = workflows._prepare_run(self.store, "quick-capture", {"content": "x"}, "global",
                                      "manual", None, "running")
        rid = plan["run_id"]
        original = workflows.iso_now

        def finishing_now() -> str:
            con = sqlite3.connect(self.db_path)
            con.execute("UPDATE workflow_run SET status = 'ok' WHERE id = ?", (rid,))
            con.commit()
            con.close()
            return original()

        workflows.iso_now = finishing_now
        try:
            with self.assertRaises(workflows.WorkflowConflict):
                workflows.cancel_run(self.store, rid)
        finally:
            workflows.iso_now = original
        self.assertEqual(self.status(rid), "ok")
        self.assertFalse(workflows.get_run(self.store, rid)["cancel_requested"])


class TestReaperAndOrphans(RuntimeCase):
    def orphan_run(self) -> str:
        plan = workflows._prepare_run(self.store, "quick-capture", {"content": "x"}, "global",
                                      "manual", None, "running")
        rid = plan["run_id"]
        with self.store._txn() as con:
            con.execute("INSERT INTO workflow_step(id, run_id, ordinal, node_id, name, kind, status, "
                        "input, output, started_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
                        (rid + ":append_raw", rid, 0, "append_raw", "原文落库", "persist",
                         "running", "{}", "{}", dbmod.now()))
        return rid

    def test_reaper_fails_runs_whose_executor_is_gone_and_spares_live_ones(self) -> None:
        dead = self.spawn("pass")
        dead.wait()
        live = self.spawn("import time; time.sleep(60)")
        gone = self.orphan_run()
        self.set_owner(gone, dead.pid)
        alive = self.orphan_run()
        self.set_owner(alive, live.pid)
        mine = self.orphan_run()  # 本进程（同一 boot）但不在执行：孤儿
        report = workflows.reap_interrupted(self.store)
        self.assertIn(gone, report["runs"])
        self.assertIn(mine, report["runs"])
        self.assertNotIn(alive, report["runs"], "执行者进程还活着的运行不能被回收")
        for rid in (gone, mine):
            run = workflows.get_run(self.store, rid)
            self.assertEqual(run["status"], "failed")
            self.assertEqual(run["error"], workflows.INTERRUPTED_ERROR)
            self.assertIn("interrupted", run["error"])
            self.assertEqual(run["steps"][0]["status"], "failed")
        self.assertEqual(self.status(alive), "running")

    def test_cancelling_an_orphan_finalizes_it_directly(self) -> None:
        rid = self.orphan_run()
        result = workflows.cancel_run(self.store, rid)
        self.assertEqual(result["status"], "cancelled")
        statuses = {s["node_id"]: s["status"] for s in result["steps"]}
        self.assertEqual(statuses, {"append_raw": "cancelled", "mirror": "cancelled",
                                    "enqueue": "cancelled"})

    def test_cancelling_a_run_of_a_live_other_process_only_records_the_request(self) -> None:
        live = self.spawn("import time; time.sleep(60)")
        rid = self.orphan_run()
        self.set_owner(rid, live.pid)
        result = workflows.cancel_run(self.store, rid, wait=0)
        self.assertEqual(result["status"], "running")
        self.assertTrue(result["cancel_requested"])


class TestEdgeSemantics(RuntimeCase):
    def test_if_gate_reads_only_the_source_lineage(self) -> None:
        self.register("t-root", lambda ctx, node: {"status": "ok", "text": "root"})
        self.register("t-flag", lambda ctx, node: {"status": "ok", "flag": True})
        self.register("t-plain", lambda ctx, node: {"status": "ok", "text": node["id"]})
        self.add_template("t-if", [
            {"id": "root", "kind": "t-root"}, {"id": "left", "kind": "t-flag"},
            {"id": "right", "kind": "t-plain"}, {"id": "target", "kind": "t-plain"},
        ], [{"from": "root", "to": "left"}, {"from": "root", "to": "right"},
            {"from": "right", "to": "target", "when": "if:flag"}])
        run = workflows.run_workflow(self.store, None, "t-if", {})
        statuses = {s["node_id"]: s["status"] for s in run["steps"]}
        self.assertEqual(statuses["left"], "ok")
        self.assertEqual(statuses["target"], "skipped",
                         "兄弟分支 left 的 flag 不能打开 right→target 的闸门")

    def test_text_for_reads_the_nearest_ancestor(self) -> None:
        self.register("t-say", lambda ctx, node: {"status": "ok", "text": node["id"].upper()})
        self.register("t-read", lambda ctx, node: {"status": "ok",
                                                    "seen": ctx.text_for("text")})
        # 链 a → c → b → z：最近的祖先 b 在字母序里既不是第一个（a）也不是最后一个（c）
        self.add_template("t-near", [{"id": "a", "kind": "t-say"}, {"id": "c", "kind": "t-say"},
                                     {"id": "b", "kind": "t-say"}, {"id": "z", "kind": "t-read"}],
                          [{"from": "a", "to": "c"}, {"from": "c", "to": "b"},
                           {"from": "b", "to": "z"}])
        run = workflows.run_workflow(self.store, None, "t-near", {})
        reader = [s for s in run["steps"] if s["node_id"] == "z"][0]
        self.assertEqual(reader["output"]["seen"], "B", "最近的祖先是 b（1.0.0 读到字母序最前的 a）")

    def test_on_failure_edge_fires_in_both_modes(self) -> None:
        def boom(ctx, node):
            raise RuntimeError("注入失败")

        self.register("t-boom", boom)
        self.register("t-ok", lambda ctx, node: {"status": "ok", "text": node["id"]})
        self.add_template("t-onfail", [
            {"id": "boom", "kind": "t-boom"}, {"id": "handler", "kind": "t-ok"},
            {"id": "normal", "kind": "t-ok"},
        ], [{"from": "boom", "to": "handler", "when": "on_failure"},
            {"from": "boom", "to": "normal", "when": "always"}])
        for mode, expected in (("fail", "failed"), ("skip", "partial")):
            run = workflows.run_workflow(self.store, None, "t-onfail", {}, mode=mode)
            statuses = {s["node_id"]: s["status"] for s in run["steps"]}
            self.assertEqual(run["status"], expected, mode)
            self.assertEqual(statuses, {"boom": "failed", "handler": "ok", "normal": "skipped"}, mode)


class TestHonestOutputs(RuntimeCase):
    def test_emit_reports_delivery_truthfully(self) -> None:
        self.add_template("t-emit", [{"id": "say", "kind": "emit", "params": {"channel": "ui"}}])
        events.clear()  # 测试专用：保证此刻没有任何 SSE 订阅者
        run = workflows.run_workflow(self.store, None, "t-emit", {"content": "hi"})
        out = run["steps"][0]["output"]
        self.assertTrue(out["published"])
        self.assertEqual(out["subscribers"], 0)
        self.assertFalse(out["delivered"], "没有订阅者就不能报告已送达（1.0.0 恒为 true）")
        self.assertEqual(out["via"], "audit")
        bus = events.subscribe(("run",))
        try:
            run = workflows.run_workflow(self.store, None, "t-emit", {"content": "hi"})
            out = run["steps"][0]["output"]
            self.assertTrue(out["delivered"])
            self.assertEqual(out["via"], "sse")
            got = [e for e in bus.drain(200) if e["data"].get("phase") == "emit"
                   and e["data"].get("run_id") == run["id"]]
            self.assertEqual(len(got), 1)
        finally:
            bus.close()
        self.assertTrue(workflows.RunEmitter(None).emit("run", None), "data=None 不能再抛异常")
        self.assertEqual(workflows.RunEmitter(None).send("workflow.custom", {})["type"], "log")

    def test_parallel_layer_does_not_reattach_the_shared_vault(self) -> None:
        self.register("t-par", lambda ctx, node: {"status": "ok", "text": node["id"]})
        self.add_template("t-vault", [{"id": "x", "kind": "t-par"}, {"id": "y", "kind": "t-par"},
                                      {"id": "z", "kind": "t-par"}])
        run = workflows.run_workflow(self.store, None, "t-vault", {})
        self.assertEqual(run["status"], "ok")
        self.assertIs(self.store.vault.store, self.store, "共享 vault 必须仍指向服务的 Store")

    def test_hash_vectors_mark_the_step_degraded_and_index_really_writes(self) -> None:
        memory = self.store.add_memory({"title": "BM25", "body": "BM25 按词频饱和给分。",
                                        "kind": "fact", "scope_id": "global", "status": "approved"})
        run = workflows.run_workflow(self.store, None, "incremental-index", {"since": "2000-01-01"})
        step = [s for s in run["steps"] if s["node_id"] == "reindex_vec"][0]
        self.assertEqual(step["status"], "degraded")
        self.assertGreaterEqual(step["output"]["written"], 1)
        vectors = self.store.con.execute("SELECT count(*) FROM vector WHERE owner_id = ?",
                                         (memory["id"],)).fetchone()[0]
        self.assertGreaterEqual(vectors, 1)
        fake = self.store.con.execute("SELECT count(*) FROM vector WHERE owner_id LIKE 'text:%'"
                                      ).fetchone()[0]
        self.assertEqual(fake, 0, "不给纯文本造假主人")

    def test_handler_level_cancel_token_is_wired(self) -> None:
        seen: dict = {}

        def probe(ctx, node):
            seen["callable"] = callable(ctx.cancel)
            seen["cancelled"] = ctx.cancelled()
            return {"status": "ok"}

        self.register("t-probe", probe)
        self.add_template("t-token", [{"id": "p", "kind": "t-probe"}])
        workflows.run_workflow(self.store, None, "t-token", {})
        self.assertEqual(seen, {"callable": True, "cancelled": False})


class TestSessionEndGateway(RuntimeCase):
    def test_session_end_passes_a_gateway_and_skips_empty_sessions(self) -> None:
        captured: list = []
        # agents 在调用时 `from . import workflows`：拿 sys.modules 里当前那个模块对象打补丁
        # （整套测试里 test_server 会卸载并重新导入 workflows，测试文件顶部 import 的可能是旧对象）
        import importlib

        live = importlib.import_module("memora_core.workflows")
        original = live.run_workflow

        def spy(store, gw, template_id, inputs, **kw):
            captured.append(gw)
            return {"id": "run-x", "status": "ok", "degraded": []}

        live.run_workflow = spy
        try:
            agents_mod.end_session(self.store, "codex-cli", "ext-1",
                                   turns=[{"role": "user", "content": "记住：默认用 SQLite"}])
            given = object()
            agents_mod.end_session(self.store, "codex-cli", "ext-2",
                                   turns=[{"role": "user", "content": "x"}], gw=given)
            empty = agents_mod.end_session(self.store, "codex-cli", "ext-3", turns=[])
        finally:
            live.run_workflow = original
        # 按类名比：整套测试里 models 也可能被重新导入过（类对象不再是同一个）
        self.assertEqual(type(captured[0]).__name__, "ModelGateway", "1.0.0 这里永远是 None")
        self.assertIs(captured[1], given)
        self.assertEqual(len(captured), 2)
        self.assertTrue(empty["workflow"]["skipped"])


class TestJobs(RuntimeCase):
    def job(self, job_id: str) -> dict:
        row = self.store.con.execute("SELECT * FROM job WHERE id = ?", (job_id,)).fetchone()
        item = dict(row)
        item["payload"] = json.loads(item["payload"])
        return item

    def test_enqueued_job_is_claimed_once_and_runs_its_target(self) -> None:
        source = workflows.run_workflow(self.store, None, "quick-capture",
                                        {"content": "默认用 SQLite 作为事务真源。", "agent": "t"})
        job_id = [s for s in source["steps"] if s["node_id"] == "enqueue"][0]["output"]["job_id"]
        claimed = workflows.claim_job(self.store)
        self.assertEqual(claimed["id"], job_id)
        self.assertEqual(claimed["attempts"], 1)
        self.assertIsNone(workflows.claim_job(self.store), "同一任务只能被领取一次")
        result = workflows.process_job(self.store, claimed)
        self.assertEqual(result["status"], "ok", result)
        row = self.job(job_id)
        self.assertEqual(row["status"], "ok")
        run = workflows.get_run(self.store, row["payload"]["last_run_id"])
        self.assertEqual(run["template_id"], "session-distill")
        self.assertEqual(run["trigger"], "job")
        self.assertEqual(run["parent_run_id"], source["id"])

    def test_failing_job_backs_off_then_fails(self) -> None:
        def boom(ctx, node):
            raise RuntimeError("注入：目标模板失败")

        self.register("t-jboom", boom)
        self.add_template("t-jobfail", [{"id": "x", "kind": "t-jboom"}])
        self.add_template("t-enq", [{"id": "s", "kind": "schedule",
                                     "params": {"job": "t-jobfail", "max_attempts": 2}}])
        workflows.run_workflow(self.store, None, "t-enq", {})
        first = workflows.process_job(self.store, workflows.claim_job(self.store))
        self.assertEqual(first["status"], "queued", "还有次数：退避后重排")
        self.assertGreater(first["run_after"], workflows.iso_now())
        self.assertIsNone(workflows.claim_job(self.store), "退避期内不能被领取")
        claimed = workflows.claim_job(self.store, now="2999-01-01T00:00:00Z")
        second = workflows.process_job(self.store, claimed)
        self.assertEqual(second["status"], "failed")
        self.assertIn("注入", self.job(claimed["id"])["last_error"])

    def test_job_without_target_fails_without_retry(self) -> None:
        stamp = dbmod.now()
        with self.store._txn() as con:
            con.execute("INSERT INTO job(id, kind, status, payload, attempts, max_attempts, "
                        "run_after, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
                        ("job-legacy", "workflow", "queued", "{}", 0, 5, None, stamp, stamp))
        result = workflows.process_job(self.store, workflows.claim_job(self.store))
        self.assertEqual(result["status"], "failed")
        self.assertIn("没有可执行的目标模板", result["error"])

    def test_retry_writes_exactly_one_audit_row(self) -> None:
        stamp = dbmod.now()
        with self.store._txn() as con:
            con.execute("INSERT INTO job(id, kind, status, payload, attempts, max_attempts, "
                        "last_error, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
                        ("job-1", "session-distill", "failed", "{}", 5, 5, "x", stamp, stamp))
        result = workflows.retry_job(self.store, "job-1")
        self.assertEqual(result["status"], "queued")
        audits = self.store.con.execute("SELECT count(*) FROM audit WHERE action = 'job.retry' "
                                        "AND target = 'job-1'").fetchone()[0]
        self.assertEqual(audits, 1)
        self.assertEqual(self.job("job-1")["attempts"], 0)
        with self.store._txn() as con:
            con.execute("UPDATE job SET status = 'running' WHERE id = 'job-1'")
        with self.assertRaises(workflows.WorkflowConflict):
            workflows.retry_job(self.store, "job-1")
        with self.assertRaises(workflows.WorkflowNotFound):
            workflows.retry_job(self.store, "job-missing")

    def test_background_worker_consumes_jobs_and_stops(self) -> None:
        report = workflows.start_background(self.store)
        self.assertTrue(report["job_worker"])
        self.assertTrue(workflows.job_worker_status(self.db_path)["running"])
        source = workflows.run_workflow(self.store, None, "quick-capture",
                                        {"content": "后台消费者验收。", "agent": "t"})
        job_id = [s for s in source["steps"] if s["node_id"] == "enqueue"][0]["output"]["job_id"]
        self.wait_for(lambda: self.job(job_id)["status"] == "ok", timeout=15)
        stopped = workflows.stop_background(self.db_path, timeout=5)
        self.assertEqual(stopped["workers"], 1)
        self.assertFalse(workflows.job_worker_status(self.db_path)["running"])


class TestHttpRoutes(unittest.TestCase):
    """真服务（端口 0）：异步运行 202 + Location、取消 200/202/409/404、job 重试、触发器字段。"""

    @classmethod
    def setUpClass(cls) -> None:
        from memora_core import server
        from memora_core.paths import Paths

        cls.server = server
        cls.tmp = Path(tempfile.mkdtemp(prefix="memora-wf-http-"))
        paths = Paths(cls.tmp).ensure()
        dbmod.init_db(paths.db)
        cls.runtime = server.Runtime(paths)
        cls.report = cls.runtime.bootstrap()
        # 服务用的 workflows 模块对象（整套测试里可能被 test_server 重新导入过）
        cls.wf = cls.runtime.module("workflows")
        cls.httpd = server.create_server(cls.runtime, port=0)
        cls.base = "http://127.0.0.1:%d" % cls.runtime.port
        threading.Thread(target=cls.httpd.serve_forever, kwargs={"poll_interval": 0.02},
                         daemon=True).start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.graceful_shutdown(cls.httpd, cls.runtime, timeout=3.0)
        for key in ("t-http-gate",):
            cls.wf.NODE_HANDLERS.pop(key, None)

    def call(self, method: str, path: str, body=None) -> tuple[int, dict, dict]:
        import urllib.error
        import urllib.request

        data = json.dumps(body).encode("utf-8") if body is not None else None
        request = urllib.request.Request(self.base + path, data=data, method=method,
                                         headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=20) as resp:
                return resp.status, dict(resp.headers), json.loads(resp.read() or b"{}")
        except urllib.error.HTTPError as exc:
            return exc.code, dict(exc.headers), json.loads(exc.read() or b"{}")

    def wait_terminal(self, run_id: str) -> dict:
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            status, _h, run = self.call("GET", "/api/runs/" + run_id)
            if run.get("status") in self.wf.TERMINAL_STATUSES:
                return run
            time.sleep(0.05)
        self.fail("运行没有结束：%s" % run_id)

    def test_bootstrap_started_the_background(self) -> None:
        self.assertTrue(self.report["background"]["job_worker"])
        status, _h, jobs = self.call("GET", "/api/jobs")
        self.assertEqual(status, 200)
        self.assertTrue(jobs["worker"]["running"])

    def test_async_run_returns_202_and_cancel_semantics(self) -> None:
        status, headers, run = self.call("POST", "/api/workflows/quick-capture/run?async=1",
                                         {"inputs": {"content": "异步运行验收", "agent": "t"}})
        self.assertEqual(status, 202)
        self.assertIn(run["status"], ("queued", "running"))
        self.assertEqual(headers.get("Location"), "/api/runs/" + run["id"])
        final = self.wait_terminal(run["id"])
        self.assertEqual(final["status"], "ok")
        status, _h, err = self.call("POST", "/api/runs/%s/cancel" % run["id"])
        self.assertEqual((status, err["code"]), (409, "RUN_FINISHED"))
        status, _h, err = self.call("POST", "/api/runs/run-nope/cancel")
        self.assertEqual((status, err["code"]), (404, "RUN_NOT_FOUND"))

    def test_cancel_running_run_over_http(self) -> None:
        gate = threading.Event()

        def gated(ctx, node):
            while not gate.is_set():
                ctx.check_cancel()
                time.sleep(0.01)
            return {"status": "ok"}

        self.wf.register_handler("t-http-gate", gated)
        store = self.runtime.store()
        spec = {"nodes": [{"id": "a", "kind": "t-http-gate"}, {"id": "b", "kind": "emit"}],
                "edges": [{"from": "a", "to": "b"}], "fallbacks": {}, "inputs": {}, "trigger": {}}
        with store._txn() as con:
            con.execute("INSERT OR REPLACE INTO workflow_template(id, name, description, category, "
                        "version, spec, builtin, enabled, created_at, updated_at) "
                        "VALUES(?,?,?,?,?,?,?,?,?,?)", ("t-http", "t-http", "", "test", 1,
                                                        dbmod.dumps(spec), 0, 1, dbmod.now(),
                                                        dbmod.now()))
        try:
            status, _h, run = self.call("POST", "/api/workflows/t-http/run", {"async": True})
            self.assertEqual(status, 202)
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                if self.call("GET", "/api/runs/" + run["id"])[2]["status"] == "running":
                    break
                time.sleep(0.02)
            status, _h, cancelled = self.call("POST", "/api/runs/%s/cancel" % run["id"])
            self.assertEqual(status, 200)
            self.assertEqual(cancelled["status"], "cancelled")
            self.assertEqual({s["node_id"]: s["status"] for s in cancelled["steps"]},
                             {"a": "cancelled", "b": "cancelled"})
        finally:
            gate.set()

    def test_sync_run_still_returns_201_with_truthful_emitted(self) -> None:
        status, _h, run = self.call("POST", "/api/workflows/quick-capture/run",
                                    {"inputs": {"content": "同步运行", "agent": "t"}})
        self.assertEqual(status, 201)
        self.assertEqual(run["status"], "ok")
        self.assertEqual(run["emitted"], 2 + 2 * 3, "start + end + 每步 running/结束")

    def test_templates_report_trigger_activity_and_retry_404(self) -> None:
        status, _h, payload = self.call("GET", "/api/workflows")
        table = {t["id"]: t for t in payload["items"]}
        self.assertFalse(table["incremental-index"]["trigger_active"])
        status, _h, one = self.call("GET", "/api/workflows/session-distill")
        self.assertTrue(one["trigger_active"])
        status, _h, err = self.call("POST", "/api/jobs/job-nope/retry")
        self.assertEqual((status, err["code"]), (404, "JOB_NOT_FOUND"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
