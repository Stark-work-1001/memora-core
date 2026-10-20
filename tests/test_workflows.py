# -*- coding: utf-8 -*-
"""tests/test_workflows.py — DAG 工作流执行器。

覆盖点：
  * seed_templates 幂等（连跑 3 次行数恒为 18）
  * 无模型（gw=None）下 quick-capture / hybrid-recall-rerank / dedup-merge 跑通
  * 每个节点都写 workflow_step 行（steps 数 == 节点数）
  * 分支：when=if:<key> 未命中时下游不执行
  * 失败传播：节点抛非 ModelUnavailable → 下游 skipped、run failed
  * 降级：ModelUnavailable → 执行 fallbacks，run partial
  * 并行：同层节点真的并发（峰值并发 > 1）
  * 可见性：节点只读祖先产物，兄弟分支不可见
  * 取消：cancel_run（真的调用它）后运行落 cancelled，取消之后的节点不开始
  * 模板：节点 kind 全部已注册、只给声明的输入能过 input 闸门（validate_template）
  更多见 test_workflow_templates / test_workflow_persist / test_workflow_runtime。
  * 提示词模板渲染（prompts.py）

全部使用临时目录里的真实 SQLite，不联网。
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from memora_core import db as dbmod
from memora_core import prompts, workflows
from memora_core.models import ModelUnavailable
from memora_core.store import Store
from memora_core.vault import Vault

FENCE = chr(96) * 3


# ============================================================
# 基类：每个用例一套临时库
# ============================================================
class WorkflowTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.mkdtemp(prefix="memora-t4-")
        self.db_path = os.path.join(self._tmp, "memora.db")
        dbmod.init_db(self.db_path)
        self.store = Store(self.db_path, Vault(os.path.join(self._tmp, "vault")))
        workflows.seed_templates(self.store)
        self._added: list = []

    def tearDown(self) -> None:
        for key in self._added:
            workflows.NODE_HANDLERS.pop(key, None)
        self.store.close()

    # ---------------- 小工具 ----------------
    def register(self, key: str, handler) -> None:
        """注册临时处理器，tearDown 时移除（不污染全局注册表）。"""
        workflows.register_handler(key, handler)
        self._added.append(key)

    def add_template(self, template_id: str, nodes: list, edges: list,
                     *, fallbacks: dict = None, inputs: dict = None) -> dict:
        """往库里塞一条自定义模板（测试专用）。"""
        spec = {"nodes": nodes, "edges": edges, "fallbacks": fallbacks or {},
                "inputs": inputs or {}, "trigger": {"kind": "manual"}}
        stamp = dbmod.now()
        with self.store._txn() as con:
            con.execute(
                "INSERT OR REPLACE INTO workflow_template(id, name, description, category, "
                "version, spec, builtin, enabled, created_at, updated_at) "
                "VALUES(?,?,?,?,?,?,?,?,?,?)",
                (template_id, "测试-" + template_id, "测试模板", "test", 1, dbmod.dumps(spec),
                 0, 1, stamp, stamp),
            )
        return workflows.get_template(self.store, template_id)

    def run_tpl(self, template_id: str, inputs: dict = None, **kw) -> dict:
        return workflows.run_workflow(self.store, kw.pop("gw", None), template_id,
                                      inputs or {}, **kw)

    def step_rows(self, run_id: str) -> list:
        rows = self.store.con.execute(
            "SELECT * FROM workflow_step WHERE run_id = ? ORDER BY ordinal", (run_id,)
        ).fetchall()
        return [dict(row) for row in rows]


# ============================================================
# 1. 模板 seed / list / get
# ============================================================
class TestTemplates(WorkflowTestCase):
    def test_seed_is_idempotent(self) -> None:
        counts = []
        for _ in range(3):
            workflows.seed_templates(self.store)
            counts.append(self.table_count("workflow_template"))
        self.assertEqual(counts, [18, 18, 18])

    def test_list_and_get(self) -> None:
        templates = workflows.list_templates(self.store)
        self.assertEqual(len(templates), 18)
        for template in templates:
            self.assertTrue(template["nodes"], template["id"])
            self.assertIsInstance(template["fallbacks"], dict)
        picked = workflows.get_template(self.store, "quick-capture")
        self.assertIsNotNone(picked)
        self.assertEqual(picked["name"], "快速捕获")
        self.assertEqual([n["id"] for n in picked["nodes"]],
                         ["append_raw", "mirror", "enqueue"])
        self.assertIsNone(workflows.get_template(self.store, "does-not-exist"))

    def test_handlers_cover_all_kinds(self) -> None:
        catalog = workflows.handler_catalog()
        self.assertEqual(sorted(catalog["kinds"]), sorted(workflows.KINDS))
        self.assertEqual(len(catalog["kinds"]), 17)
        for template in workflows.list_templates(self.store):
            for name in (template["fallbacks"] or {}).values():
                self.assertIn(name, catalog["fallbacks"],
                              "模板 %s 引用了未注册的 fallback: %s" % (template["id"], name))
            for node in template["nodes"]:
                self.assertTrue(workflows.known_kind(node["kind"]),
                                "模板 %s 的节点 %s kind 未注册" % (template["id"], node["id"]))
            # 校验含：只给声明的输入就能通过 input 节点的必填校验
            self.assertEqual(workflows.validate_template(template), [], template["id"])

    def table_count(self, table: str) -> int:
        return int(self.store.con.execute("SELECT count(*) FROM " + table).fetchone()[0])


# ============================================================
# 2. 三条核心模板在无模型下必须跑通
# ============================================================
class TestOfflineRuns(WorkflowTestCase):
    def assert_run_ok(self, run: dict, expected_steps: int) -> None:
        self.assertIn(run["status"], ("ok", "partial"), run.get("error"))
        self.assertEqual(len(run["steps"]), expected_steps)
        rows = self.step_rows(run["id"])
        self.assertEqual(len(rows), expected_steps, "每个节点都必须有 workflow_step 行")
        self.assertEqual(sorted(r["node_id"] for r in rows),
                         sorted(s["node_id"] for s in run["steps"]))
        for step in run["steps"]:
            self.assertIn(step["status"], ("ok", "degraded"))
            self.assertIsInstance(step["output"], dict)
            self.assertIsNotNone(step["ms"])

    def test_quick_capture_offline(self) -> None:
        run = self.run_tpl("quick-capture", {
            "content": "决定使用 SQLite 作为事务真源，Markdown 作为可读镜像。",
            "agent": "dsh", "event_id": "evt-1"})
        self.assert_run_ok(run, 3)
        kinds = {s["node_id"]: s["kind"] for s in run["steps"]}
        self.assertEqual(kinds, {"append_raw": "persist", "mirror": "persist",
                                 "enqueue": "schedule"})
        memories = self.store.list_memories({"limit": 10})
        self.assertEqual(memories["total"], 1)
        self.assertEqual(memories["items"][0]["status"], "draft")
        jobs = self.store.con.execute("SELECT count(*) FROM job").fetchone()[0]
        self.assertEqual(jobs, 1, "schedule 节点必须写 job 行")

    def test_quick_capture_is_idempotent_by_event_id(self) -> None:
        payload = {"content": "同一条内容", "agent": "dsh", "event_id": "evt-2"}
        first = self.run_tpl("quick-capture", payload)
        second = self.run_tpl("quick-capture", payload)
        self.assertEqual(first["status"], "ok")
        self.assertEqual(second["status"], "ok")
        self.assertEqual(self.store.list_memories({"limit": 10})["total"], 1)
        reused = [s for s in second["steps"] if s["node_id"] == "append_raw"][0]
        self.assertEqual(reused["output"]["reused"], 1)

    def test_hybrid_recall_rerank_offline(self) -> None:
        self.store.add_memory({"title": "事务真源", "body": "SQLite 是事务真源，Markdown 是镜像。",
                               "kind": "fact", "scope_id": "global", "status": "approved"})
        run = self.run_tpl("hybrid-recall-rerank",
                           {"query": "事务真源", "scope": "global", "budget": 400})
        self.assert_run_ok(run, 8)
        self.assertIn("rerank", run["degraded"], "无重排模型时必须记录降级")
        rerank = [s for s in run["steps"] if s["node_id"] == "rerank"][0]
        self.assertEqual(rerank["status"], "degraded")
        self.assertTrue(rerank["degraded"])
        fuse = [s for s in run["steps"] if s["node_id"] == "fuse"][0]
        self.assertEqual(fuse["output"]["algorithm"], "rrf")
        pack = [s for s in run["steps"] if s["node_id"] == "pack"][0]
        self.assertIn("count", pack["output"])

    def test_dedup_merge_offline(self) -> None:
        existing = self.store.add_memory({
            "title": "事务真源", "body": "SQLite 是事务真源，Markdown 是可读镜像。",
            "kind": "fact", "scope_id": "global", "status": "approved"})
        run = self.run_tpl("dedup-merge", {"candidate": {
            "title": "事务真源", "body": "SQLite 是事务真源，Markdown 是可读镜像。",
            "kind": "fact", "scope_id": "global"}})
        self.assert_run_ok(run, 6)
        judge = [s for s in run["steps"] if s["node_id"] == "judge"][0]
        self.assertIn(judge["output"]["action"],
                      ("add", "update", "supersede", "merge", "link", "noop", "ask"))
        if judge["output"]["action"] == "noop":
            self.assertEqual(judge["output"]["target_id"], existing["id"])
        audit = [s for s in run["steps"] if s["node_id"] == "audit"][0]
        self.assertEqual(audit["output"]["target"], "audit")

    def test_run_is_reproducible_in_structure(self) -> None:
        inputs = {"query": "事务真源", "scope": "global", "budget": 200}
        first = self.run_tpl("hybrid-recall-rerank", inputs)
        second = self.run_tpl("hybrid-recall-rerank", inputs)
        self.assertEqual([s["node_id"] for s in first["steps"]],
                         [s["node_id"] for s in second["steps"]])
        self.assertEqual([s["status"] for s in first["steps"]],
                         [s["status"] for s in second["steps"]])
        self.assertEqual(first["input"], second["input"])
        self.assertEqual(len(self.step_rows(first["id"])), len(self.step_rows(second["id"])))


# ============================================================
# 3. 分支（when: if:<key>）
# ============================================================
class TestBranch(WorkflowTestCase):
    def test_if_condition_skips_unmatched_branch(self) -> None:
        hits: list = []
        lock = threading.Lock()

        def main(ctx, node):
            with lock:
                hits.append(node["id"])
            return {"status": "ok", "text": "分支源", "route": ctx.inputs.get("route") == "yes",
                    "flag": bool(ctx.inputs.get("flag"))}

        def yes(ctx, node):
            with lock:
                hits.append(node["id"])
            return {"status": "ok", "text": "命中分支", "branch": "yes"}

        def no(ctx, node):
            with lock:
                hits.append(node["id"])
            return {"status": "ok", "text": "未命中分支", "branch": "no"}

        self.register("t-branch-main", main)
        self.register("t-branch-yes", yes)
        self.register("t-branch-no", no)
        self.add_template("t-branch", [
            {"id": "start", "name": "起点", "kind": "t-branch-main", "params": {}},
            {"id": "left", "name": "命中分支", "kind": "t-branch-yes", "params": {}},
            {"id": "right", "name": "未命中分支", "kind": "t-branch-no", "params": {}},
        ], [
            {"from": "start", "to": "left", "when": "if:flag"},
            {"from": "start", "to": "right", "when": "if:route"},
        ])
        run = self.run_tpl("t-branch", {"flag": True})
        statuses = {s["node_id"]: s["status"] for s in run["steps"]}
        self.assertEqual(statuses["start"], "ok")
        self.assertEqual(statuses["left"], "ok", "if:flag 为真时命中分支必须执行")
        self.assertEqual(statuses["right"], "skipped", "if:route 未命中时该分支不能执行")
        self.assertNotIn("right", hits, "未命中的处理器不能被调用")
        self.assertIn("left", hits)
        self.assertEqual(len(self.step_rows(run["id"])), 3, "跳过的节点也要留 step 行")
        self.assertIn(run["status"], ("ok", "partial"))

    def test_on_degraded_edge_only_fires_when_degraded(self) -> None:
        seen: list = []

        def flaky(ctx, node):
            raise ModelUnavailable("chat", "测试：模型不可用")

        def after(ctx, node):
            seen.append(node["id"])
            return {"status": "ok", "text": "降级后处理"}

        self.register("t-flaky", flaky)
        self.register("t-after", after)
        self.add_template("t-ondown", [
            {"id": "flaky", "name": "会降级", "kind": "t-flaky", "params": {}},
            {"id": "after", "name": "降级分支", "kind": "t-after", "params": {}},
        ], [{"from": "flaky", "to": "after", "when": "on_degraded"}])
        run = self.run_tpl("t-ondown", {})
        statuses = {s["node_id"]: s["status"] for s in run["steps"]}
        self.assertEqual(statuses["flaky"], "degraded")
        self.assertEqual(statuses["after"], "ok")
        self.assertEqual(seen, ["after"])
        self.assertEqual(run["status"], "partial")


# ============================================================
# 4. 失败传播
# ============================================================
class TestFailure(WorkflowTestCase):
    def test_failed_node_skips_downstream(self) -> None:
        def boom(ctx, node):
            raise RuntimeError("注入的必失败节点")

        def never(ctx, node):
            raise AssertionError("下游节点不应该被执行")

        def ok(ctx, node):
            return {"status": "ok", "text": "正常节点"}

        self.register("t-boom", boom)
        self.register("t-never", never)
        self.register("t-ok", ok)
        self.add_template("t-fail", [
            {"id": "a", "name": "正常", "kind": "t-ok", "params": {}},
            {"id": "b", "name": "失败", "kind": "t-boom", "params": {}},
            {"id": "c", "name": "下游1", "kind": "t-never", "params": {}},
            {"id": "d", "name": "下游2", "kind": "t-never", "params": {}},
        ], [
            {"from": "a", "to": "b", "when": "always"},
            {"from": "b", "to": "c", "when": "always"},
            {"from": "c", "to": "d", "when": "always"},
        ])
        run = self.run_tpl("t-fail", {})
        self.assertEqual(run["status"], "failed")
        self.assertIn("RuntimeError", run["error"] or "")
        statuses = {s["node_id"]: s["status"] for s in run["steps"]}
        self.assertEqual(statuses, {"a": "ok", "b": "failed", "c": "skipped",
                                    "d": "skipped"})
        rows = self.step_rows(run["id"])
        self.assertEqual(len(rows), 4, "失败与被跳过的步骤都要落库")
        self.assertEqual([r["node_id"] for r in rows], ["a", "b", "c", "d"])
        failed = [r for r in rows if r["node_id"] == "b"][0]
        self.assertIn("注入的必失败节点", failed["error"] or "")

    def test_missing_input_raises_workflow_input_error(self) -> None:
        # a) 处理器本身抛 WorkflowInputError
        ctx = workflows.WorkflowContext(store=self.store, inputs={"agent": "dsh"},
                                        template_id="quick-capture", run_id="run-x",
                                        template=workflows.get_template(self.store,
                                                                        "quick-capture"))
        ctx.step_meta["template"] = workflows.get_template(self.store, "quick-capture")
        node = {"id": "append_raw", "kind": "input", "params": {}}
        with self.assertRaises(workflows.WorkflowInputError):
            workflows.node_input(ctx, node)
        # b) 在执行器里表现为该节点 failed、run failed（不吞异常）
        run = self.run_tpl("dedup-merge", {})
        self.assertEqual(run["status"], "failed")
        self.assertIn("WorkflowInputError", run["error"] or "")
        self.assertEqual(run["steps"][0]["node_id"], "candidate_in")
        self.assertEqual(run["steps"][0]["status"], "failed")
        self.assertIn("candidate", run["steps"][0]["error"] or "")

    def test_skip_mode_keeps_other_branches(self) -> None:
        """mode=skip：失败节点的下游被跳过，兄弟分支继续跑，run=partial。"""

        def boom(ctx, node):
            raise RuntimeError("注入：该分支失败")

        def fine(ctx, node):
            return {"status": "ok", "text": "兄弟分支正常"}

        self.register("t-boom2", boom)
        self.register("t-fine", fine)
        self.add_template("t-skipmode", [
            {"id": "root", "name": "根", "kind": "t-fine", "params": {}},
            {"id": "bad", "name": "坏分支", "kind": "t-boom2", "params": {}},
            {"id": "down", "name": "坏分支下游", "kind": "t-fine", "params": {}},
            {"id": "good", "name": "好分支", "kind": "t-fine", "params": {}},
        ], [
            {"from": "root", "to": "bad", "when": "always"},
            {"from": "bad", "to": "down", "when": "always"},
            {"from": "root", "to": "good", "when": "always"},
        ])
        run = self.run_tpl("t-skipmode", {}, mode="skip")
        self.assertEqual(run["status"], "partial")
        statuses = {s["node_id"]: s["status"] for s in run["steps"]}
        self.assertEqual(statuses["bad"], "failed")
        self.assertEqual(statuses["down"], "skipped")
        self.assertEqual(statuses["good"], "ok", "兄弟分支必须继续执行")
        self.assertEqual(len(self.step_rows(run["id"])), 4)
        with self.assertRaises(ValueError):
            self.run_tpl("t-skipmode", {}, mode="nonsense")

    def test_unknown_template_raises(self) -> None:
        with self.assertRaises(workflows.WorkflowNotFound):
            self.run_tpl("no-such-template", {})


# ============================================================
# 5. 降级路径
# ============================================================
class TestFallback(WorkflowTestCase):
    def test_model_unavailable_uses_registered_fallback(self) -> None:
        calls: list = []

        def needs_model(ctx, node):
            raise ModelUnavailable("judge", "测试：判定模型不可用")

        def fallback(ctx, node):
            calls.append(node["id"])
            ctx.mark_degraded("judge", "走了 fallback")
            return {"status": "ok", "action": "ask", "degraded": True, "reason": "fallback"}

        self.register("t-needs-model", needs_model)
        self.register("fallback:my-fallback", fallback)
        self.add_template("t-fb", [
            {"id": "judge", "name": "判定", "kind": "t-needs-model", "params": {}},
            {"id": "after", "name": "后续", "kind": "emit", "params": {}},
        ], [
            {"from": "judge", "to": "after", "when": "always"},
        ], fallbacks={"judge": "my-fallback"})
        run = self.run_tpl("t-fb", {})
        self.assertEqual(run["status"], "partial")
        self.assertEqual(calls, ["judge"])
        step = [s for s in run["steps"] if s["node_id"] == "judge"][0]
        self.assertEqual(step["status"], "degraded")
        self.assertTrue(step["degraded"])
        self.assertEqual(step["output"]["fallback"], "my-fallback")
        self.assertEqual(step["attempts"][0]["kind"], "handler")
        self.assertEqual(step["attempts"][1]["kind"], "fallback")
        self.assertIn("judge", run["degraded"])

    def test_model_unavailable_without_fallback_marks_degraded(self) -> None:
        def needs_model(ctx, node):
            raise ModelUnavailable("reranker", "测试：无 fallback")

        self.register("t-no-fb", needs_model)
        self.add_template("t-nofb", [
            {"id": "only", "name": "单独", "kind": "t-no-fb", "params": {}},
        ], [])
        run = self.run_tpl("t-nofb", {})
        self.assertEqual(run["status"], "partial")
        self.assertEqual(run["steps"][0]["status"], "degraded")
        self.assertIn("reranker", run["degraded"])

    def test_no_model_takes_the_handlers_own_offline_path(self) -> None:
        """gw=None：rerank 不抛 ModelUnavailable，走处理器自己的分数透传（不是 fallback）。

        fallback 真正被执行的路径（配置了模型、调用时不可用）见
        test_workflow_templates.TestFallbacksAreOffline。
        """
        self.store.add_memory({"title": "事务真源", "body": "SQLite 是事务真源。",
                               "kind": "fact", "scope_id": "global", "status": "approved"})
        run = self.run_tpl("hybrid-recall-rerank",
                           {"query": "事务真源", "scope": "global", "budget": 200})
        rerank = [s for s in run["steps"] if s["node_id"] == "rerank"][0]
        self.assertTrue(rerank["degraded"])
        self.assertEqual(rerank["output"]["algorithm"], "score-passthrough")
        self.assertEqual([a["kind"] for a in rerank["attempts"]], ["handler"])
        self.assertIsInstance(rerank["output"].get("hits"), list)


# ============================================================
# 6. 执行语义：并行 / 可见性 / 取消
# ============================================================
class TestExecutionSemantics(WorkflowTestCase):
    def test_siblings_run_in_parallel(self) -> None:
        state = {"active": 0, "peak": 0}
        lock = threading.Lock()

        def slow(ctx, node):
            with lock:
                state["active"] += 1
                state["peak"] = max(state["peak"], state["active"])
            time.sleep(0.12)
            with lock:
                state["active"] -= 1
            return {"status": "ok", "text": "并行节点 %s" % node["id"]}

        def merge(ctx, node):
            return {"status": "ok", "seen": sorted(ctx.artifacts)}

        self.register("t-slow", slow)
        self.register("t-merge", merge)
        self.add_template("t-par", [
            {"id": "left", "name": "左", "kind": "t-slow", "params": {}},
            {"id": "right", "name": "右", "kind": "t-slow", "params": {}},
            {"id": "mid", "name": "中", "kind": "t-slow", "params": {}},
            {"id": "merge", "name": "汇合", "kind": "t-merge", "params": {}},
        ], [
            {"from": "left", "to": "merge", "when": "always"},
            {"from": "right", "to": "merge", "when": "always"},
            {"from": "mid", "to": "merge", "when": "always"},
        ])
        run = self.run_tpl("t-par", {})
        self.assertEqual(run["status"], "ok")
        self.assertGreaterEqual(state["peak"], 2, "同层节点必须并行执行")

    def test_node_sees_only_ancestors(self) -> None:
        def produce(name):
            def handler(ctx, node):
                return {"status": "ok", "text": "来自 %s" % name}
            return handler

        def inspect(ctx, node):
            return {"status": "ok", "visible": sorted(ctx.artifacts), "text": "仓库检查"}

        self.register("t-pa", produce("a"))
        self.register("t-pb", produce("b"))
        self.register("t-pc", produce("c"))
        self.register("t-inspect", inspect)
        self.add_template("t-visible", [
            {"id": "a", "name": "A", "kind": "t-pa", "params": {}},
            {"id": "b", "name": "B", "kind": "t-pb", "params": {}},
            {"id": "c", "name": "C", "kind": "t-pc", "params": {}},
            {"id": "z", "name": "Z", "kind": "t-inspect", "params": {}},
        ], [
            {"from": "a", "to": "b", "when": "always"},
            {"from": "b", "to": "c", "when": "always"},
            {"from": "c", "to": "z", "when": "always"},
        ])
        run = self.run_tpl("t-visible", {})
        z = [s for s in run["steps"] if s["node_id"] == "z"][0]
        self.assertEqual(z["output"]["visible"], ["a", "b", "c"])

    def test_sibling_cannot_see_each_other(self) -> None:
        def left(ctx, node):
            time.sleep(0.05)
            return {"status": "ok", "text": "左分支"}

        def right(ctx, node):
            return {"status": "ok", "visible": sorted(ctx.artifacts)}

        self.register("t-left", left)
        self.register("t-right", right)
        self.add_template("t-sib", [
            {"id": "root", "name": "根", "kind": "input", "params": {}},
            {"id": "left", "name": "左", "kind": "t-left", "params": {}},
            {"id": "right", "name": "右", "kind": "t-right", "params": {}},
        ], [
            {"from": "root", "to": "left", "when": "always"},
            {"from": "root", "to": "right", "when": "always"},
        ], inputs={"content": "根内容"})
        run = self.run_tpl("t-sib", {"content": "根内容"})
        right_step = [s for s in run["steps"] if s["node_id"] == "right"][0]
        self.assertNotIn("left", right_step["output"]["visible"])
        self.assertIn("root", right_step["output"]["visible"])

    def test_output_is_truncated_to_4kb(self) -> None:
        def huge(ctx, node):
            return {"status": "ok", "blob": "x" * 20000, "text": "巨大输出"}

        self.register("t-huge", huge)
        self.add_template("t-huge", [{"id": "big", "name": "大输出", "kind": "t-huge",
                                      "params": {}}], [])
        run = self.run_tpl("t-huge", {})
        row = self.step_rows(run["id"])[0]
        self.assertLessEqual(len(row["output"].encode("utf-8")), workflows.OUTPUT_LIMIT + 64)
        self.assertTrue(json.loads(row["output"]).get("truncated"))

    def test_cancel_run(self) -> None:
        """真的调用 cancel_run（1.0.0 的这条测试只传了 cancel 回调，从没调用过它）。"""
        gate = threading.Event()
        started: list = []

        def slow(ctx, node):
            started.append(node["id"])
            gate.set()
            time.sleep(0.2)
            return {"status": "ok", "text": node["id"]}

        self.register("t-slow2", slow)
        self.add_template("t-cancel", [
            {"id": "first", "name": "一", "kind": "t-slow2", "params": {}},
            {"id": "second", "name": "二", "kind": "t-slow2", "params": {}},
        ], [{"from": "first", "to": "second", "when": "always"}])
        holder: dict = {}

        def runner():
            holder["run"] = self.run_tpl("t-cancel", {})

        thread = threading.Thread(target=runner)
        thread.start()
        self.assertTrue(gate.wait(timeout=5))
        run_id = self.store.con.execute(
            "SELECT id FROM workflow_run WHERE template_id = 't-cancel'").fetchone()[0]
        response = workflows.cancel_run(self.store, run_id)
        thread.join(timeout=5)
        self.assertEqual(response["status"], "cancelled")
        run = holder.get("run") or {}
        self.assertEqual(run.get("status"), "cancelled")
        self.assertEqual(started, ["first"], "取消之后的节点不能开始")
        statuses = {r["node_id"]: r["status"] for r in self.step_rows(run["id"])}
        self.assertEqual(statuses, {"first": "ok", "second": "cancelled"})

    def test_cancel_finished_run_conflicts(self) -> None:
        run = self.run_tpl("quick-capture", {"content": "内容", "agent": "dsh"})
        self.assertEqual(run["status"], "ok")
        with self.assertRaises(workflows.WorkflowConflict):
            workflows.cancel_run(self.store, run["id"])
        with self.assertRaises(workflows.WorkflowNotFound):
            workflows.cancel_run(self.store, "run-missing")

    def test_run_and_steps_are_persisted(self) -> None:
        run = self.run_tpl("quick-capture", {"content": "落库检查", "agent": "dsh",
                                             "event_id": "evt-9"})
        row = self.store.con.execute(
            "SELECT * FROM workflow_run WHERE id = ?", (run["id"],)).fetchone()
        self.assertIsNotNone(row)
        self.assertEqual(row["status"], "ok")
        self.assertEqual(json.loads(row["input"])["content"], "落库检查")
        self.assertIsNotNone(row["started_at"])
        self.assertIsNotNone(row["finished_at"])
        self.assertEqual(len(self.step_rows(run["id"])), 3)
        fetched = workflows.get_run(self.store, run["id"])
        self.assertEqual(fetched["id"], run["id"])
        self.assertEqual(len(workflows.list_runs(self.store)), 1)


# ============================================================
# 7. 提示词模板
# ============================================================
class TestPrompts(unittest.TestCase):
    def test_builtin_prompts_are_loaded(self) -> None:
        table = prompts.builtin_prompts()
        for name in ("extract", "classify", "dedup_judge", "verify", "digest", "quiz"):
            self.assertIn(name, table)
            self.assertTrue(table[name].strip())

    def test_render_replaces_variables(self) -> None:
        self.assertEqual(prompts.render("a {{x}} b {{ y }}", {"x": 1, "y": [2]}),
                         "a 1 b [2]")
        self.assertEqual(prompts.render("{{nope}}", {}), "{{nope}}")
        with self.assertRaises(prompts.PromptVariableError):
            prompts.render("{{nope}}", {}, strict=True)

    def test_render_named_uses_builtin_template(self) -> None:
        text = prompts.render_named("classify", {"body": "这是一条偏好"})
        self.assertIn("这是一条偏好", text)
        self.assertNotIn("{{body}}", text)

    def test_parse_json_is_lenient(self) -> None:
        self.assertEqual(prompts.parse_json('前言 {"a": 1} 后记'), {"a": 1})
        fenced = FENCE + 'json\n[{"a": 1}]\n' + FENCE
        self.assertEqual(prompts.parse_json(fenced, expect=list), [{"a": 1}])
        with self.assertRaises(prompts.PromptError):
            prompts.parse_json("我不会输出 JSON")


if __name__ == "__main__":
    unittest.main(verbosity=2)
