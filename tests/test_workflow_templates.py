# -*- coding: utf-8 -*-
"""tests/test_workflow_templates.py — 内置模板的静态校验与离线行为（engine 1.1.0）。

  * 18 条内置模板全部通过 validate_template；校验器真的能抓到坏模板（逐类构造）
  * 「21 种节点、4 种没有处理器」的说法不成立：模板里 node.kind 只有 17 种且全部已注册，
    多出来的 4 个名字是 trigger.kind（不是节点）
  * 每条模板只给它声明的输入就能跑（1.0.0 有 6 条连输入闸门都过不去）
  * gw=None 与「0 个档位的真实 ModelGateway」逐模板结果一致（1.0.0 的 HTTP/MCP 路径与测试路径不同）
  * fallback 绝不碰模型；没声明 fallback 的节点在模型抛 ModelUnavailable 时离线重跑
  * 未知 kind 运行时该步 failed（不是 noop + degraded），也不能借 fallback:* 别名
  * session-distill 只写候选、绝不批准；模板触发器是否真的会触发如实标注
全部离线：socket.connect 被打补丁成直接抛错。
"""
from __future__ import annotations

import json
import os
import socket
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from memora_core import db as dbmod  # noqa: E402
from memora_core import models, workflows  # noqa: E402
from memora_core.models import ModelUnavailable  # noqa: E402
from memora_core.store import Store  # noqa: E402
from memora_core.vault import Vault  # noqa: E402

BUILTIN = Path(__file__).resolve().parent.parent / "memora_core" / "data" / "builtin"


def _no_network(self, address):  # noqa: ANN001
    raise OSError("tests: outbound network blocked (%r)" % (address,))


def fresh_store(prefix: str = "memora-tpl-") -> Store:
    tmp = tempfile.mkdtemp(prefix=prefix)
    dbmod.init_db(os.path.join(tmp, "memora.db"))
    store = Store(os.path.join(tmp, "memora.db"), Vault(os.path.join(tmp, "vault")))
    workflows.seed_templates(store)
    return store


def sample_values(store: Store, root: Path) -> dict:
    """每条模板声明的输入都给一个真实可用的值（与 tools/run_all_workflows.py 同口径）。"""
    old = store.add_memory({"title": "数据库选型（旧）", "body": "项目使用 MySQL 作为数据库。",
                            "kind": "fact", "scope_id": "global", "status": "approved",
                            "recorded_at": "2026-01-01T00:00:00Z",
                            "updated_at": "2026-01-01T00:00:00Z", "importance": 0.2})
    new = store.add_memory({"title": "数据库选型（新）", "body": "项目改用 SQLite 作为事务真源。",
                            "kind": "decision", "scope_id": "global", "status": "approved"})
    doc = root / "doc.md"
    doc.write_bytes("# BM25\n\nBM25 按词频饱和与文档长度归一给分。\n".encode("utf-8"))
    return {
        "content": "我们决定使用 SQLite 作为事务真源。BM25 很重要。", "query": "事务真源",
        "scope": "global", "budget": 400,
        "candidate": {"title": "验收候选", "body": "BM25 打分很重要", "kind": "knowledge"},
        "memory": new["id"], "a_id": new["id"], "b_id": old["id"], "valid_from": "2026-10-01",
        "new_id": new["id"], "old_id": old["id"], "workspace": str(root / "ws"),
        "window": "7d", "since": "2026-01-01", "topic": "数据库", "count": 2,
        "agent": "tests", "event_id": "evt-1", "text": "先定义，再推导。", "path": str(doc),
        "items": [new["id"]],
        "session": {"turns": [{"role": "user", "content": "以后默认用 SQLite。"}]},
    }


def run_all(store: Store, gw, values: dict) -> dict:
    out = {}
    for template in workflows.list_templates(store):
        names = list((template.get("spec") or {}).get("inputs") or {})
        inputs = {name: values.get(name, "示例") for name in names}
        run = workflows.run_workflow(store, gw, template["id"], inputs)
        out[template["id"]] = (run["status"], [(s["node_id"], s["status"]) for s in run["steps"]],
                               list(run["degraded"]), run["error"])
    return out


class FakeGateway:
    """「配置了模型但调用时不可用」：roles()/profile() 说 chat/judge/extractor/reranker 都有档位，
    真正调用时抛 ModelUnavailable——这是 fallback 才会真正执行的路径。"""

    ROLES = ("chat", "judge", "extractor", "reranker", "embedding")

    def __init__(self) -> None:
        self.calls: list[str] = []

    def roles(self) -> dict:
        return {role: {"provider": "fake", "model": "fake-1"} for role in self.ROLES}

    def profile(self, role):  # noqa: ANN001
        return {"provider": "fake", "model": "fake-1"}

    def _fail(self, role: str):
        self.calls.append(role)
        raise ModelUnavailable(role, "测试：网络不通")

    def chat(self, messages, role="chat", **kw):  # noqa: ANN001
        self._fail(role)

    def judge(self, prompt, role="judge", **kw):  # noqa: ANN001
        self._fail(role)

    def embed(self, texts, role="embedding", **kw):  # noqa: ANN001
        self._fail(role)

    def rerank(self, query, docs, top_k=20, role="reranker"):  # noqa: ANN001
        self._fail(role)


class TestBuiltinTemplatesValidate(unittest.TestCase):
    def test_all_18_builtin_templates_validate(self) -> None:
        templates = workflows._builtin_templates()
        self.assertEqual(len(templates), 18)
        for template in templates:
            self.assertEqual(workflows.validate_template(template), [], template["id"])

    def test_seeded_templates_carry_no_problems(self) -> None:
        store = fresh_store()
        try:
            for template in workflows.list_templates(store):
                self.assertEqual(template["problems"], [], template["id"])
        finally:
            store.close()

    def test_node_kinds_are_17_and_all_registered(self) -> None:
        """反驳交接文档的「21 种节点、4 种没有处理器」：21 = 17 个 node.kind + 4 个 trigger.kind。"""
        data = json.loads((BUILTIN / "workflow_templates.json").read_text(encoding="utf-8"))
        node_kinds = {n["kind"] for t in data for n in t["nodes"]}
        trigger_kinds = {t["trigger"]["kind"] for t in data}
        self.assertEqual(len(node_kinds), 17)
        self.assertEqual(node_kinds, set(workflows.KINDS))
        self.assertTrue(all(workflows.known_kind(k) for k in node_kinds))
        self.assertEqual(sorted(trigger_kinds - node_kinds),
                         ["agent", "ingest", "manual", "session-end"])
        self.assertEqual(len(node_kinds | trigger_kinds), 21)

    def test_every_persist_node_resolves_to_an_explicit_op(self) -> None:
        for template in workflows._builtin_templates():
            for node in template["nodes"]:
                if node["kind"] == "persist":
                    op = workflows.persist_op(node.get("params"))
                    self.assertIn(op, workflows.PERSIST_OPS, (template["id"], node["id"]))
                    self.assertEqual(node["params"].get("op"), op, (template["id"], node["id"]))

    def test_session_distill_persists_candidates_only(self) -> None:
        template = {t["id"]: t for t in workflows._builtin_templates()}["session-distill"]
        persist = [n for n in template["nodes"] if n["id"] == "persist"][0]
        self.assertEqual(persist["params"]["status"], "candidate")


def _tpl(nodes, edges=(), **extra) -> dict:
    spec = {"id": "t", "nodes": list(nodes), "edges": list(edges), "fallbacks": {}, "inputs": {}}
    spec.update(extra)
    return spec


class TestValidatorCatchesBrokenTemplates(unittest.TestCase):
    def problems(self, template: dict) -> str:
        return " | ".join(workflows.validate_template(template))

    def test_unknown_kind_and_fallback_alias(self) -> None:
        self.assertIn("kind 未注册：nope", self.problems(_tpl([{"id": "a", "kind": "nope"}])))
        # 1.0.0 的 resolve_handler 会把 kind="skip" 解析成 fallback:skip
        self.assertIn("kind 未注册：skip", self.problems(_tpl([{"id": "a", "kind": "skip"}])))

    def test_persist_ops(self) -> None:
        bad_table = _tpl([{"id": "p", "kind": "persist", "params": {"table": "nonsense"}}])
        self.assertIn("persist 操作无法解析", self.problems(bad_table))
        unread = _tpl([{"id": "p", "kind": "persist", "params": {"op": "archive", "keep_sources": 1}}])
        self.assertIn("不会被读取的参数：keep_sources", self.problems(unread))
        self.assertEqual(workflows.persist_op({"table": "job"}), "job")
        self.assertEqual(workflows.persist_op({"rel": "supersedes"}), "link")
        self.assertEqual(workflows.persist_op({"status": "archived"}), "archive")
        self.assertEqual(workflows.persist_op({"require": "explicit_consent"}), "purge")
        self.assertIsNone(workflows.persist_op({"status": "weird"}))

    def test_structure(self) -> None:
        self.assertIn("没有 job", self.problems(_tpl([{"id": "s", "kind": "schedule"}])))
        dangling = _tpl([{"id": "a", "kind": "emit"}], [{"from": "a", "to": "zz"}])
        self.assertIn("端点不存在", self.problems(dangling))
        bad_when = _tpl([{"id": "a", "kind": "emit"}, {"id": "b", "kind": "emit"}],
                        [{"from": "a", "to": "b", "when": "sometimes"}])
        self.assertIn("when 不合法", self.problems(bad_when))
        cycle = _tpl([{"id": "a", "kind": "emit"}, {"id": "b", "kind": "emit"}],
                     [{"from": "a", "to": "b"}, {"from": "b", "to": "a"}])
        self.assertIn("有环", self.problems(cycle))
        fb = _tpl([{"id": "a", "kind": "emit"}], fallbacks={"zz": "skip", "a": "no-such"})
        text = self.problems(fb)
        self.assertIn("fallbacks 的键不是节点：zz", text)
        self.assertIn("fallback 未注册：a → no-such", text)
        source = _tpl([{"id": "p", "kind": "persist", "params": {"op": "memory", "from": "ghost"}}])
        self.assertIn("from 指向不存在的节点：ghost", self.problems(source))

    def test_input_gate_must_be_satisfiable_by_declared_inputs(self) -> None:
        strict = _tpl([{"id": "in", "kind": "input", "params": {"required": ["query"]}}],
                      inputs={"scope": "作用域"})
        self.assertIn("仍缺：query", self.problems(strict))
        ok = _tpl([{"id": "in", "kind": "input"}], inputs={"scope": "作用域", "since": "时间窗"})
        self.assertEqual(workflows.validate_template(ok), [])


class OfflineCase(unittest.TestCase):
    def setUp(self) -> None:
        self._connect = socket.socket.connect
        socket.socket.connect = _no_network
        self.stores: list[Store] = []

    def tearDown(self) -> None:
        socket.socket.connect = self._connect
        for store in self.stores:
            store.close()

    def make(self) -> tuple[Store, dict]:
        store = fresh_store()
        self.stores.append(store)
        return store, sample_values(store, Path(store.db_path).parent)


class TestDeclaredInputsAndOfflineEquivalence(OfflineCase):
    def test_every_template_runs_with_only_its_declared_inputs(self) -> None:
        store, values = self.make()
        results = run_all(store, None, values)
        self.assertEqual(len(results), 18)
        failed = {tid: r for tid, r in results.items() if r[0] not in ("ok", "partial")}
        self.assertEqual(failed, {})

    def test_zero_profile_gateway_behaves_exactly_like_no_gateway(self) -> None:
        store_a, values_a = self.make()
        store_b, values_b = self.make()
        gateway = models.ModelGateway(store_b)
        self.assertTrue(all(p is None for p in gateway.roles().values()), "前提：0 个档位")
        without = run_all(store_a, None, values_a)
        with_gw = run_all(store_b, gateway, values_b)
        for tid in without:
            self.assertEqual(without[tid][:3], with_gw[tid][:3], tid)
        # 1.0.0 在这条路径上 review-quiz-generate failed（fallback 又去调模型）
        self.assertIn(with_gw["review-quiz-generate"][0], ("ok", "partial"))

    def test_effective_gateway_collapses_empty_gateway(self) -> None:
        store, _values = self.make()
        self.assertIsNone(workflows._effective_gateway(models.ModelGateway(store)))
        fake = FakeGateway()
        self.assertIs(workflows._effective_gateway(fake), fake)


class TestFallbacksAreOffline(OfflineCase):
    def test_declared_fallback_runs_offline_and_never_calls_the_model(self) -> None:
        store, values = self.make()
        fake = FakeGateway()
        run = workflows.run_workflow(store, fake, "review-quiz-generate",
                                     {"topic": "数据库", "count": 2})
        steps = {s["node_id"]: s for s in run["steps"]}
        generate = steps["generate"]
        self.assertEqual(generate["status"], "degraded", generate["error"])
        self.assertEqual(generate["output"]["fallback"], "cloze-template")
        self.assertEqual([a["kind"] for a in generate["attempts"]], ["handler", "fallback"])
        self.assertTrue(generate["output"]["items"], "fallback 必须真的出题")
        self.assertEqual(fake.calls.count("chat"), 1, "fallback 不能再去调模型")
        self.assertIn(run["status"], ("ok", "partial"))

    def test_rerank_fallback_score_passthrough_really_runs(self) -> None:
        store, values = self.make()
        fake = FakeGateway()
        run = workflows.run_workflow(store, fake, "hybrid-recall-rerank",
                                     {"query": "SQLite", "scope": "global", "budget": 200})
        rerank = [s for s in run["steps"] if s["node_id"] == "rerank"][0]
        self.assertEqual(rerank["output"].get("fallback"), "score-passthrough")
        self.assertEqual(rerank["attempts"][-1]["kind"], "fallback")

    def test_node_without_fallback_reruns_offline_instead_of_returning_nothing(self) -> None:
        store, values = self.make()
        fake = FakeGateway()
        run = workflows.run_workflow(store, fake, "conflict-source-audit", {"scope": "global"})
        propose = [s for s in run["steps"] if s["node_id"] == "propose"][0]
        self.assertEqual(propose["status"], "degraded")
        self.assertEqual(propose["attempts"][-1]["kind"], "offline-rerun")
        self.assertTrue(propose["output"].get("action"), "离线重跑必须给出规则决定，不是空产物")
        self.assertTrue(propose["output"].get("offline"))


class TestRuntimeKinds(OfflineCase):
    def add_template(self, store: Store, tid: str, nodes: list) -> None:
        stamp = dbmod.now()
        spec = {"nodes": nodes, "edges": [], "fallbacks": {}, "inputs": {}, "trigger": {}}
        with store._txn() as con:
            con.execute("INSERT INTO workflow_template(id, name, description, category, version, "
                        "spec, builtin, enabled, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
                        (tid, tid, "", "test", 1, dbmod.dumps(spec), 0, 1, stamp, stamp))

    def test_unknown_kind_fails_the_step_with_a_clear_error(self) -> None:
        store, _ = self.make()
        for kind in ("nope", "skip", "fallback:skip"):
            self.add_template(store, "t-" + kind.replace(":", "-"), [{"id": "x", "kind": kind}])
            run = workflows.run_workflow(store, None, "t-" + kind.replace(":", "-"), {})
            self.assertEqual(run["status"], "failed", kind)
            self.assertEqual(run["steps"][0]["status"], "failed", kind)
            self.assertIn("未知节点类型", run["error"] or "", kind)
        self.assertIsNone(workflows.resolve_handler("skip"))

    def test_trigger_activity_is_reported(self) -> None:
        store, _ = self.make()
        table = {t["id"]: t for t in workflows.list_templates(store)}
        self.assertFalse(table["forget-decay"]["trigger_active"])
        self.assertIn("没有定时调度器", table["forget-decay"]["trigger_note"])
        self.assertFalse(table["dedup-merge"]["trigger_active"])
        self.assertTrue(table["session-distill"]["trigger_active"])
        self.assertTrue(table["quick-capture"]["trigger_active"])

    def test_session_distill_never_approves(self) -> None:
        store, values = self.make()
        before = {m["id"] for m in store.list_memories({"limit": 100})["items"]}
        run = workflows.run_workflow(store, None, "session-distill",
                                     {"session": values["session"], "agent": "tests"})
        self.assertIn(run["status"], ("ok", "partial"), run["error"])
        created = [m for m in store.list_memories({"limit": 100, "status": "candidate"})["items"]
                   if m["id"] not in before]
        self.assertTrue(created, "会话里有内容，应该写出候选")
        for memory in created:
            full = store.get_memory(memory["id"])
            self.assertEqual(full["status"], "candidate")
            self.assertLessEqual(full["trust"], 0.5)
            self.assertEqual(full["metadata"].get("origin"), "workflow")


if __name__ == "__main__":
    unittest.main(verbosity=2)
