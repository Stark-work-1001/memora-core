# -*- coding: utf-8 -*-
"""tests/test_workflow_persist.py — persist 节点逐个操作的真实副作用（engine 1.1.0）。

1.0.0 里 21 个 persist 节点大多掉进「新增候选记忆」：forget-decay 的归档/硬删除把记忆 1→3 条、
一条也没归档；update-supersede 新建记忆而不推翻；dedup-merge 写入 4 条记忆；table=job 写进
recall_log。这里每个操作都断言**库里真实发生了什么**（以及没发生什么）。
"""
from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from memora_core import db as dbmod  # noqa: E402
from memora_core import workflows  # noqa: E402
from memora_core.store import Store  # noqa: E402
from memora_core.vault import Vault  # noqa: E402

OLD_STAMP = "2026-01-01T00:00:00Z"


class PersistCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.mkdtemp(prefix="memora-persist-")
        dbmod.init_db(os.path.join(self.tmp, "memora.db"))
        self.store = Store(os.path.join(self.tmp, "memora.db"), Vault(os.path.join(self.tmp, "vault")))
        workflows.seed_templates(self.store)

    def tearDown(self) -> None:
        self.store.close()

    def memory(self, title: str, body: str, **extra) -> dict:
        data = {"title": title, "body": body, "kind": "fact", "scope_id": "global",
                "status": "approved"}
        data.update(extra)
        return self.store.add_memory(data)

    def count(self, sql: str, args: tuple = ()) -> int:
        return int(self.store.con.execute(sql, args).fetchone()[0])

    def run_tpl(self, tid: str, inputs: dict) -> dict:
        return workflows.run_workflow(self.store, None, tid, inputs)

    def step(self, run: dict, node_id: str) -> dict:
        return [s for s in run["steps"] if s["node_id"] == node_id][0]

    def add_template(self, tid: str, nodes: list, edges: list) -> None:
        stamp = dbmod.now()
        spec = {"nodes": nodes, "edges": edges, "fallbacks": {}, "inputs": {}, "trigger": {}}
        with self.store._txn() as con:
            con.execute("INSERT INTO workflow_template(id, name, description, category, version, "
                        "spec, builtin, enabled, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
                        (tid, tid, "", "test", 1, dbmod.dumps(spec), 0, 1, stamp, stamp))


class TestForgetDecay(PersistCase):
    def test_archives_old_low_value_memory_and_creates_nothing(self) -> None:
        stale = self.memory("很久以前", "一条很久没用过的低价值记忆。", importance=0.2,
                            recorded_at=OLD_STAMP, updated_at=OLD_STAMP)
        fresh = self.memory("最近的", "最近才写的重要记忆。", importance=0.9)
        before = self.count("SELECT count(*) FROM memory")
        run = self.run_tpl("forget-decay", {"scope": "global"})
        self.assertEqual(run["status"], "ok", run["error"])
        self.assertEqual(self.count("SELECT count(*) FROM memory"), before, "归档不能新建记忆")
        self.assertEqual(self.store.get_memory(stale["id"])["status"], "archived")
        self.assertEqual(self.store.get_memory(fresh["id"])["status"], "approved")
        archive = self.step(run, "archive")
        self.assertEqual([a["id"] for a in archive["output"]["archived"]], [stale["id"]])
        audit = self.count("SELECT count(*) FROM audit WHERE action = 'memory.set_status' "
                           "AND target = ?", (stale["id"],))
        self.assertEqual(audit, 1, "归档走 store 状态机并审计")

    def test_purge_requires_explicit_consent(self) -> None:
        victim = self.memory("敏感", "一条要硬删除的敏感记忆。", sensitivity="secret")
        run = self.run_tpl("forget-decay", {"scope": "global", "purge_ids": [victim["id"]]})
        purge = self.step(run, "purge")
        self.assertEqual(purge["status"], "skipped")
        self.assertIn("显式同意", purge["output"]["reason"])
        self.assertIsNotNone(self.store.get_memory(victim["id"]), "没有同意绝不删除")

        run = self.run_tpl("forget-decay", {"scope": "global", "explicit_consent": True,
                                            "purge_ids": [victim["id"]]})
        purge = self.step(run, "purge")
        self.assertEqual(purge["status"], "ok")
        self.assertEqual([p["id"] for p in purge["output"]["purged"]], [victim["id"]])
        self.assertIsNone(self.store.get_memory(victim["id"]))
        self.assertEqual(self.count("SELECT count(*) FROM audit WHERE action = 'workflow.purge'"), 1)


class TestUpdateSupersede(PersistCase):
    def test_supersede_sets_fields_status_and_edge(self) -> None:
        old = self.memory("旧", "项目使用 MySQL。")
        new = self.memory("新", "项目改用 SQLite。")
        before = self.count("SELECT count(*) FROM memory")
        run = self.run_tpl("update-supersede", {"new_id": new["id"], "old_id": old["id"],
                                                "valid_from": "2026-10-01T00:00:00Z"})
        self.assertIn(run["status"], ("ok", "partial"), run["error"])
        self.assertEqual(self.count("SELECT count(*) FROM memory"), before, "推翻不能新建记忆")
        row = self.store.get_memory(old["id"])
        self.assertEqual(row["status"], "superseded")
        self.assertEqual(row["superseded_by"], new["id"])
        self.assertEqual(row["valid_to"], "2026-10-01T00:00:00Z")
        edges = self.count("SELECT count(*) FROM edge WHERE src = ? AND dst = ? AND rel = 'supersedes'",
                           (new["id"], old["id"]))
        self.assertEqual(edges, 1)
        self.assertEqual(self.step(run, "history")["status"], "ok")

    def test_pair_from_a_b_uses_temporal_relation(self) -> None:
        old = self.memory("旧", "项目使用 MySQL。", recorded_at=OLD_STAMP)
        new = self.memory("新", "项目改用 SQLite。", recorded_at="2026-10-01T00:00:00Z")
        run = workflows.run_workflow(self.store, None, "update-supersede",
                                     {"a_id": new["id"], "b_id": old["id"]})
        self.assertEqual(self.step(run, "temporal")["output"]["relation"], "after")
        self.assertEqual(self.store.get_memory(old["id"])["status"], "superseded")

    def test_unapproved_new_memory_only_files_a_review_candidate(self) -> None:
        old = self.memory("旧", "项目使用 MySQL。")
        new = self.memory("新", "项目改用 SQLite。", status="candidate")
        run = self.run_tpl("update-supersede", {"new_id": new["id"], "old_id": old["id"]})
        supersede = self.step(run, "supersede")
        self.assertFalse(supersede["output"]["applied"])
        self.assertTrue(supersede["output"]["needs_review"])
        self.assertEqual(self.store.get_memory(old["id"])["status"], "approved", "旧记忆不能被改动")
        self.assertEqual(self.count("SELECT count(*) FROM candidate WHERE action = 'supersede' "
                                    "AND status = 'needs_review'"), 1)
        self.assertEqual(self.step(run, "history")["status"], "skipped")

    def test_illegal_transition_fails_explicitly_and_rolls_back(self) -> None:
        old = self.memory("旧", "一条还没批准的旧记忆。", status="candidate")
        new = self.memory("新", "新的已批准记忆。")
        run = self.run_tpl("update-supersede", {"new_id": new["id"], "old_id": old["id"]})
        self.assertEqual(run["status"], "failed")
        self.assertIn("非法状态迁移", self.step(run, "supersede")["error"])
        row = self.store.get_memory(old["id"])
        self.assertIsNone(row["superseded_by"], "失败时整组改动回滚")
        self.assertEqual(self.count("SELECT count(*) FROM edge WHERE rel = 'supersedes'"), 0)

    def test_without_a_pair_nothing_is_written(self) -> None:
        before = self.count("SELECT count(*) FROM memory")
        run = self.run_tpl("update-supersede", {"candidate": {"title": "x", "body": "未入库的候选"}})
        self.assertEqual(self.step(run, "supersede")["status"], "skipped")
        self.assertEqual(self.count("SELECT count(*) FROM memory"), before)


class TestDedupMerge(PersistCase):
    def test_duplicate_is_not_written(self) -> None:
        self.memory("事务真源", "SQLite 是事务真源，Markdown 是可读镜像。")
        before = self.count("SELECT count(*) FROM memory")
        run = self.run_tpl("dedup-merge", {"candidate": {
            "title": "事务真源", "body": "SQLite 是事务真源，Markdown 是可读镜像。", "kind": "fact"}})
        merge = self.step(run, "merge_write")
        # 规则判定可能给 noop（重复）或 merge/update（需人工审核）——都不能新建记忆
        self.assertNotIn(merge["output"]["action"], ("add", "link"))
        self.assertEqual(self.count("SELECT count(*) FROM memory"), before,
                         "重复候选不能新建记忆（1.0.0 写入了 4 条）")
        self.assertEqual(self.count("SELECT count(*) FROM recall_log"), 0)

    def test_new_candidate_is_added_once_as_candidate(self) -> None:
        before = self.count("SELECT count(*) FROM memory")
        run = self.run_tpl("dedup-merge", {"candidate": {
            "title": "全新", "body": "量子退火在组合优化中的应用。", "kind": "knowledge"}})
        merge = self.step(run, "merge_write")
        self.assertEqual(merge["output"]["action"], "add")
        self.assertEqual(self.count("SELECT count(*) FROM memory"), before + 1)
        added = self.store.get_memory(merge["output"]["memory_id"])
        self.assertEqual(added["status"], "candidate")


class TestLinksAndChildren(PersistCase):
    def test_detail_abstraction_pairs_cues_with_stored_details(self) -> None:
        detail = self.memory("BM25", "BM25 按词频饱和与文档长度归一给分。")
        before = self.count("SELECT count(*) FROM memory")
        run = self.run_tpl("detail-abstraction", {"items": [detail["id"]]})
        pair = self.step(run, "pair")
        self.assertEqual(pair["status"], "ok", pair["error"])
        cue_edges = self.count("SELECT count(*) FROM edge WHERE rel = 'cue_of' AND dst = ?",
                               (detail["id"],))
        self.assertGreaterEqual(cue_edges, 2)
        self.assertEqual(self.count("SELECT count(*) FROM memory"), before, "配对不新建记忆")

    def test_detail_abstraction_with_plain_text_is_skipped_not_faked(self) -> None:
        run = self.run_tpl("detail-abstraction", {"items": ["一段没有入库的文本细节。"]})
        self.assertEqual(self.step(run, "pair")["status"], "skipped")
        self.assertEqual(self.count("SELECT count(*) FROM edge WHERE rel = 'cue_of'"), 0)

    def test_split_decompose_writes_children_and_part_of_edges(self) -> None:
        parent = self.memory("复合", "SQLite 是事务真源。Markdown 是可读镜像。向量只是缓存。")
        run = self.run_tpl("split-decompose", {"memory": parent["id"]})
        self.assertIn(run["status"], ("ok", "partial"), run["error"])
        children = self.step(run, "persist")["output"]["items"]
        self.assertEqual(len(children), 3)
        edges = self.count("SELECT count(*) FROM edge WHERE rel = 'part_of' AND dst = ?",
                           (parent["id"],))
        self.assertEqual(edges, 3)
        for child in children:
            self.assertEqual(self.store.get_memory(child["id"])["status"], "candidate")


class TestReviewAndTables(PersistCase):
    def test_quiz_without_answers_writes_no_review_log(self) -> None:
        self.memory("数据库", "项目改用 SQLite 作为事务真源。")
        run = self.run_tpl("review-quiz-generate", {"topic": "SQLite", "count": 1})
        self.assertEqual(self.step(run, "grade")["status"], "skipped")
        self.assertEqual(self.step(run, "update")["status"], "skipped")
        self.assertEqual(self.count("SELECT count(*) FROM review_log"), 0)
        self.assertEqual(self.count("SELECT count(*) FROM memory"), 1, "1.0.0 这里会新建记忆")

    def test_quiz_with_answers_updates_mastery(self) -> None:
        memory = self.memory("数据库", "项目改用 SQLite 作为事务真源。")
        first = self.run_tpl("review-quiz-generate", {"topic": "SQLite", "count": 1})
        card = self.step(first, "generate")["output"]["items"][0]
        self.assertEqual(card["source_id"], memory["id"])
        run = self.run_tpl("review-quiz-generate", {"topic": "SQLite", "count": 1,
                                                    "answers": [card["answer"]]})
        grade = self.step(run, "grade")
        self.assertEqual(grade["output"]["items"][0]["grade"], 5)
        self.assertEqual(self.step(run, "update")["output"]["written"], 1)
        self.assertEqual(self.count("SELECT count(*) FROM review_log WHERE memory_id = ?",
                                    (memory["id"],)), 1)
        self.assertEqual(self.store.get_memory(memory["id"])["review_count"], 1)

    def test_table_job_writes_a_job_row_not_recall_log(self) -> None:
        self.add_template("t-job", [{"id": "p", "kind": "persist",
                                     "params": {"table": "job", "job": "quick-capture"}}], [])
        run = self.run_tpl("t-job", {})
        self.assertEqual(run["status"], "ok", run["error"])
        self.assertEqual(self.count("SELECT count(*) FROM job WHERE kind = 'quick-capture'"), 1)
        self.assertEqual(self.count("SELECT count(*) FROM recall_log"), 0)

    def test_unresolvable_persist_op_fails(self) -> None:
        self.add_template("t-bad", [{"id": "p", "kind": "persist",
                                     "params": {"table": "nonsense"}}], [])
        run = self.run_tpl("t-bad", {})
        self.assertEqual(run["status"], "failed")
        self.assertIn("persist 操作无法解析", run["error"])
        self.assertEqual(self.count("SELECT count(*) FROM memory"), 0)

    def test_graph_persist_writes_no_memories(self) -> None:
        self.memory("BM25", "BM25 与 RRF 用于 Memora 的混合召回。")
        before = self.count("SELECT count(*) FROM memory")
        run = self.run_tpl("knowledge-graph-build", {"scope": "global"})
        persist = self.step(run, "persist")
        self.assertEqual(persist["output"]["op"], "graph")
        self.assertEqual(persist["output"]["written"], 0)
        self.assertGreater(persist["output"]["entities"], 0)
        self.assertEqual(self.count("SELECT count(*) FROM memory"), before)
        self.assertEqual(self.count("SELECT count(*) FROM edge WHERE rel = 'hypernym'"), 0,
                         "没有判定实现，不能编造上下位关系")

    def test_doc_knowledgeize_writes_document_once(self) -> None:
        doc = Path(self.tmp) / "note.md"
        doc.write_bytes("# BM25\n\nBM25 按词频饱和给分。RRF 融合多路召回。\n".encode("utf-8"))
        run = self.run_tpl("doc-knowledgeize", {"path": str(doc), "scope": "global"})
        persist = self.step(run, "persist")
        self.assertEqual(persist["status"], "ok", persist["error"])
        doc_id = persist["output"]["document_id"]
        self.assertGreater(self.count("SELECT count(*) FROM chunk WHERE document_id = ?", (doc_id,)), 0)
        self.assertEqual(self.count("SELECT count(*) FROM vector WHERE owner_kind = 'chunk'"),
                         persist["output"]["chunk_count"])
        embed = self.step(run, "embed")
        self.assertEqual(embed["status"], "degraded", "hash 向量必须在 step 上标降级")
        again = self.run_tpl("doc-knowledgeize", {"path": str(doc), "scope": "global"})
        self.assertTrue(self.step(again, "dedupe_file")["output"]["duplicate"])
        self.assertEqual(self.step(again, "persist")["status"], "skipped")

    def test_conflict_audit_writes_conflict_rows(self) -> None:
        self.memory("port", "The service port is 8790 for Memora.")
        self.memory("port", "The service port is not 8790 for Memora.")
        run = self.run_tpl("conflict-source-audit", {"scope": "global"})
        persist = self.step(run, "persist")
        self.assertEqual(persist["status"], "ok", persist["error"])
        self.assertEqual(self.count("SELECT count(*) FROM conflict"), persist["output"]["written"])
        self.assertGreaterEqual(persist["output"]["written"], 1)
        self.assertTrue(persist["output"]["report_path"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
