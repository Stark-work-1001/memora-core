# -*- coding: utf-8 -*-
"""store.py 的单元测试（每次用临时目录建库，绝不碰 data/）。"""
from __future__ import annotations

import json
import os
import shutil
import sqlite3
import tempfile
import threading
import unittest

from memora_core import db as dbmod
from memora_core.store import Store


def make_store(case: unittest.TestCase, vault=None) -> Store:
    """在临时目录里建一个新库，并在测试结束时清理。"""
    root = tempfile.mkdtemp(prefix="memora-store-")
    case.addCleanup(shutil.rmtree, root, True)
    db_path = os.path.join(root, "memora.db")
    dbmod.init_db(db_path)
    store = Store(db_path, vault)
    case.addCleanup(store.close)
    return store


class ScopeTest(unittest.TestCase):
    def test_ensure_scope_creates_and_derives_path(self) -> None:
        store = make_store(self)
        root = store.ensure_scope("workspace:demo", "workspace", name="演示工作区")
        self.assertEqual(root["id"], "workspace:demo")
        self.assertEqual(root["path"], "workspace:demo")
        self.assertEqual(root["kind"], "workspace")

        child = store.ensure_scope("agent:dsh", "agent", name="DSH", parent_id="workspace:demo")
        self.assertEqual(child["parent_id"], "workspace:demo")
        self.assertEqual(child["path"], "workspace:demo/agent:dsh")

        again = store.ensure_scope("workspace:demo", "workspace")
        self.assertEqual(again["path"], "workspace:demo")

        scopes = store.list_scopes()
        self.assertEqual([s["id"] for s in scopes], ["workspace:demo", "agent:dsh"])
        self.assertEqual(scopes[0]["depth"], 0)
        self.assertEqual(scopes[1]["path"], "workspace:demo/agent:dsh")
        self.assertEqual(scopes[1]["depth"], 1)

    def test_ensure_scope_validation(self) -> None:
        store = make_store(self)
        with self.assertRaises(ValueError):
            store.ensure_scope("", "workspace")
        with self.assertRaises(ValueError):
            store.ensure_scope("workspace:x", "nonsense")
        with self.assertRaises(ValueError):
            store.ensure_scope("workspace:x", "workspace", parent_id="workspace:missing")

    def test_add_memory_autocreates_scope(self) -> None:
        store = make_store(self)
        store.add_memory({"title": "t", "body": "b", "kind": "fact", "scope_id": "agent:codex"})
        scopes = {s["id"]: s for s in store.list_scopes()}
        self.assertIn("agent:codex", scopes)
        self.assertEqual(scopes["agent:codex"]["kind"], "agent")


class MemoryCrudTest(unittest.TestCase):
    def test_add_memory_defaults(self) -> None:
        store = make_store(self)
        mem = store.add_memory({"title": "默认值", "body": "正文", "kind": "fact", "scope_id": "global"})
        self.assertTrue(mem["id"].startswith("m-"))
        self.assertEqual(mem["status"], "candidate")
        self.assertAlmostEqual(mem["trust"], 0.5)
        self.assertAlmostEqual(mem["importance"], 0.5)
        self.assertAlmostEqual(mem["confidence"], 0.5)
        self.assertTrue(mem["recorded_at"].endswith("Z"))
        self.assertEqual(mem["recorded_at"], mem["updated_at"])
        self.assertEqual(mem["sensitivity"], "normal")
        self.assertEqual(mem["source_count"], 0)
        self.assertGreater(mem["tokens"], 0)

    def test_add_memory_validation(self) -> None:
        store = make_store(self)
        for bad in (
            {"body": "b", "kind": "fact", "scope_id": "global"},
            {"title": "t", "kind": "fact", "scope_id": "global"},
            {"title": "t", "body": "b", "scope_id": "global"},
            {"title": "t", "body": "b", "kind": "fact"},
        ):
            with self.assertRaises(ValueError):
                store.add_memory(bad)
        base = {"title": "t", "body": "b", "kind": "fact", "scope_id": "global"}
        with self.assertRaises(ValueError):
            store.add_memory(dict(base, kind="unknown-kind"))
        with self.assertRaises(ValueError):
            store.add_memory(dict(base, status="nope"))
        with self.assertRaises(ValueError):
            store.add_memory(dict(base, sensitivity="nope"))
        store.add_memory(dict(base, id="fixed-id"))
        with self.assertRaises(ValueError):
            store.add_memory(dict(base, id="fixed-id"))

    def test_get_memory_expands_json_and_children(self) -> None:
        store = make_store(self)
        mem = store.add_memory({
            "title": "展开", "body": "正文", "kind": "knowledge", "scope_id": "global",
            "didactic": {"definition": "定义", "formula": "a=b+c"},
            "metadata": {"tags": ["x", "y"], "origin": "test"},
            "trust": 1.7, "importance": -1,
        })
        self.assertAlmostEqual(mem["trust"], 1.0)
        self.assertAlmostEqual(mem["importance"], 0.0)
        loaded = store.get_memory(mem["id"])
        self.assertIsInstance(loaded["didactic"], dict)
        self.assertEqual(loaded["didactic"]["formula"], "a=b+c")
        self.assertIsInstance(loaded["metadata"], dict)
        self.assertEqual(loaded["tags"], ["x", "y"])
        for key in ("evidence", "blocks", "entities", "edges", "documents"):
            self.assertEqual(loaded[key], [])
        self.assertIsNone(store.get_memory("m-missing"))

    def test_update_memory(self) -> None:
        store = make_store(self)
        mem = store.add_memory({"title": "旧", "body": "b", "kind": "fact", "scope_id": "global"})
        updated = store.update_memory(mem["id"], {
            "title": "新", "metadata": {"tags": ["a"]}, "importance": 0.9,
            "recorded_at": "2000-01-01T00:00:00Z",
        })
        self.assertEqual(updated["title"], "新")
        self.assertEqual(updated["tags"], ["a"])
        self.assertAlmostEqual(updated["importance"], 0.9)
        self.assertNotEqual(updated["recorded_at"], "2000-01-01T00:00:00Z")
        with self.assertRaises(KeyError):
            store.update_memory("m-missing", {"title": "x"})

    def test_delete_memory_soft_and_hard(self) -> None:
        store = make_store(self)
        soft = store.add_memory({"title": "软删", "body": "b", "kind": "fact", "scope_id": "global"})
        result = store.delete_memory(soft["id"])
        self.assertFalse(result["hard"])
        self.assertEqual(store.get_memory(soft["id"])["status"], "archived")

        hard = store.add_memory({"title": "硬删", "body": "b", "kind": "fact", "scope_id": "global"})
        store.add_evidence(hard["id"], {"kind": "user_stated", "quote": "q"})
        result = store.delete_memory(hard["id"], hard=True)
        self.assertTrue(result["hard"])
        self.assertIsNone(store.get_memory(hard["id"]))
        left = store.con.execute(
            "SELECT count(*) FROM evidence WHERE memory_id = ?", (hard["id"],)
        ).fetchone()[0]
        self.assertEqual(left, 0)
        with self.assertRaises(KeyError):
            store.delete_memory("m-missing")


class StatusMachineTest(unittest.TestCase):
    def test_illegal_transition_rejected(self) -> None:
        store = make_store(self)
        mem = store.add_memory({"title": "状态", "body": "b", "kind": "fact", "scope_id": "global"})
        with self.assertRaises(ValueError):
            store.set_status(mem["id"], "superseded")
        self.assertEqual(store.get_memory(mem["id"])["status"], "candidate")

    def test_legal_chain(self) -> None:
        store = make_store(self)
        mem = store.add_memory({"title": "链路", "body": "b", "kind": "fact", "scope_id": "global"})
        self.assertEqual(store.set_status(mem["id"], "approved")["status"], "approved")
        self.assertEqual(store.set_status(mem["id"], "superseded")["status"], "superseded")
        self.assertEqual(store.set_status(mem["id"], "archived")["status"], "archived")
        with self.assertRaises(ValueError):
            store.set_status(mem["id"], "approved")

    def test_more_transitions(self) -> None:
        store = make_store(self)
        reject = store.add_memory({"title": "拒绝", "body": "b", "kind": "fact", "scope_id": "global"})
        self.assertEqual(store.set_status(reject["id"], "rejected")["status"], "rejected")
        self.assertEqual(store.set_status(reject["id"], "candidate")["status"], "candidate")
        merge = store.add_memory({"title": "合并", "body": "b", "kind": "fact", "scope_id": "global"})
        store.set_status(merge["id"], "approved")
        self.assertEqual(store.set_status(merge["id"], "merged")["status"], "merged")
        with self.assertRaises(ValueError):
            store.set_status(reject["id"], "unknown")
        with self.assertRaises(KeyError):
            store.set_status("m-missing", "approved")

    def test_agent_only_trust_cap(self) -> None:
        store = make_store(self)
        mem = store.add_memory({
            "title": "断言", "body": "b", "kind": "fact", "scope_id": "global", "trust": 0.9,
        })
        store.add_evidence(mem["id"], {"kind": "agent_asserted", "quote": "模型自己说的"})
        self.assertLessEqual(store.get_memory(mem["id"])["trust"], 0.5)
        self.assertLessEqual(store.set_status(mem["id"], "approved")["trust"], 0.5)


class ListMemoriesTest(unittest.TestCase):
    def setUp(self) -> None:
        self.store = make_store(self)
        self.store.ensure_scope("workspace:demo", "workspace")
        self.store.ensure_scope("task:demo-1", "task", parent_id="workspace:demo")
        self.store.add_memory({
            "title": "BM25 检索", "body": "BM25 是概率检索模型，用于记忆检索打分。",
            "kind": "knowledge", "scope_id": "global", "agent_id": "dsh", "importance": 0.9,
        })
        self.store.add_memory({
            "title": "HNSW 图", "body": "HNSW 做近似最近邻搜索。",
            "kind": "knowledge", "scope_id": "workspace:demo", "session_id": "s-1",
        })
        self.store.add_memory({
            "title": "子任务记忆", "body": "属于 task:demo-1 的记忆。",
            "kind": "task", "scope_id": "task:demo-1", "importance": 0.2,
        })
        self.store.add_memory({
            "title": "中间重要度", "body": "用于排序断言的中间项。",
            "kind": "fact", "scope_id": "global", "importance": 0.6,
        })

    def test_shape_and_defaults(self) -> None:
        out = self.store.list_memories({})
        self.assertEqual(set(out), {"items", "total", "limit", "offset", "query"})
        self.assertEqual(out["total"], 4)
        self.assertEqual(out["limit"], 50)
        self.assertEqual(out["offset"], 0)
        self.assertIn("snippet", out["items"][0])
        self.assertEqual(out["query"]["sort"], "updated_at")

    def test_fts_query_and_snippet(self) -> None:
        out = self.store.list_memories({"q": "BM25"})
        self.assertEqual(out["total"], 1)
        self.assertIn("BM25", out["items"][0]["snippet"])
        self.assertIn("[", out["items"][0]["snippet"])

    def test_cjk_query_falls_back_to_substring(self) -> None:
        out = self.store.list_memories({"q": "近似最近邻"})
        self.assertEqual(out["total"], 1)
        self.assertEqual(out["items"][0]["title"], "HNSW 图")

    def test_scope_prefix_includes_children(self) -> None:
        out = self.store.list_memories({"scope": "workspace:demo"})
        self.assertEqual({i["title"] for i in out["items"]}, {"HNSW 图", "子任务记忆"})

    def test_filters(self) -> None:
        self.assertEqual(self.store.list_memories({"kind": "task"})["total"], 1)
        self.assertEqual(self.store.list_memories({"agent": "dsh"})["total"], 1)
        self.assertEqual(self.store.list_memories({"session": "s-1"})["total"], 1)
        self.assertEqual(self.store.list_memories({"status": "candidate"})["total"], 4)
        self.assertEqual(self.store.list_memories({"status": "approved"})["total"], 0)

    def test_sort_order_and_paging(self) -> None:
        asc = self.store.list_memories({"sort": "importance", "order": "asc", "limit": 2})
        self.assertEqual([i["title"] for i in asc["items"]], ["子任务记忆", "HNSW 图"])
        desc = self.store.list_memories({"sort": "importance", "order": "desc", "limit": 2})
        self.assertEqual(desc["items"][0]["title"], "BM25 检索")
        page = self.store.list_memories({"limit": 1, "offset": 2})
        self.assertEqual(page["total"], 4)
        self.assertEqual(len(page["items"]), 1)
        capped = self.store.list_memories({"limit": 10 ** 6})
        self.assertEqual(capped["limit"], 500)
        self.assertEqual(self.store.list_memories({"limit": 0})["limit"], 1)

    def test_include_archived(self) -> None:
        mem = self.store.add_memory({
            "title": "归档", "body": "b", "kind": "fact", "scope_id": "global",
        })
        self.store.delete_memory(mem["id"])
        self.assertEqual(self.store.list_memories({})["total"], 4)
        self.assertEqual(self.store.list_memories({"include_archived": True})["total"], 5)
        self.assertEqual(self.store.list_memories({"status": "archived"})["total"], 1)

    def test_empty_query_result_shape(self) -> None:
        out = self.store.list_memories({"q": "完全不存在的关键词zzz"})
        self.assertEqual(out["items"], [])
        self.assertEqual(out["total"], 0)


class FtsAcceptanceTest(unittest.TestCase):
    """验收：连续 add 200 条后，已知关键词的 FTS 命中率 100%。"""

    def test_200_memories_all_searchable(self) -> None:
        store = make_store(self)
        total = 200
        keywords = []
        for index in range(total):
            keyword = "kw%04d" % index
            keywords.append(keyword)
            store.add_memory({
                "title": "第 %d 条 %s" % (index, keyword),
                "body": "这是 记忆中枢 的回归条目 %s ，记录第 %d 条 验收关键词 。"
                        % (keyword, index),
                "kind": "fact", "scope_id": "global", "importance": 0.5,
            })
        self.assertEqual(store.stats()["memories"]["total"], total)

        hits = 0
        for keyword in keywords:
            out = store.list_memories({"q": keyword})
            if out["total"] == 1 and out["items"][0]["title"].endswith(keyword):
                hits += 1
        self.assertEqual(hits, total, "ASCII 关键词的 FTS 命中率应为 100%%")

        # 纯 FTS 路径（不经过 LIKE 兜底）也必须全部命中，证明触发器同步正常
        con = store.con
        fts_hits = 0
        for keyword in keywords:
            if store._fts_ids(con, keyword):
                fts_hits += 1
        self.assertEqual(fts_hits, total, "memory_fts 触发器应同步全部 200 条")

        # 中文前缀查询也必须能命中
        cn = store.list_memories({"q": "记忆中枢", "limit": 500})
        self.assertEqual(cn["total"], total)

    def test_rebuild_fts(self) -> None:
        store = make_store(self)
        for index in range(5):
            store.add_memory({
                "title": "重建 %d" % index, "body": "rebuild keyword rk%d" % index,
                "kind": "fact", "scope_id": "global",
            })
        result = store.rebuild_fts()
        self.assertEqual(result["memory_fts"], 5)
        self.assertEqual(store.list_memories({"q": "rk3"})["total"], 1)


class ConcurrencyTest(unittest.TestCase):
    """验收：8 线程各写 25 条，不丢不重。"""

    def test_parallel_writes(self) -> None:
        store = make_store(self)
        threads = 8
        per_thread = 25
        errors: list[BaseException] = []
        ids: list[str] = []
        lock = threading.Lock()

        def worker(index: int) -> None:
            try:
                for step in range(per_thread):
                    mem = store.add_memory({
                        "title": "线程 %d 第 %d 条" % (index, step),
                        "body": "并发写入 body t%d s%d parallel" % (index, step),
                        "kind": "fact", "scope_id": "global",
                    })
                    with lock:
                        ids.append(mem["id"])
            except BaseException as exc:  # noqa: BLE001 - 测试里要收集全部异常
                with lock:
                    errors.append(exc)

        workers = [threading.Thread(target=worker, args=(i,)) for i in range(threads)]
        for thread in workers:
            thread.start()
        for thread in workers:
            thread.join(60)
        self.assertEqual(errors, [])
        self.assertEqual(len(ids), threads * per_thread)
        self.assertEqual(len(set(ids)), threads * per_thread)

        rows = store.con.execute("SELECT count(*) FROM memory").fetchone()[0]
        self.assertEqual(rows, threads * per_thread)
        distinct = store.con.execute("SELECT count(DISTINCT id) FROM memory").fetchone()[0]
        self.assertEqual(distinct, threads * per_thread)
        for index in range(threads):
            found = store.list_memories({"q": "t%d" % index, "limit": 500})
            self.assertGreaterEqual(found["total"], per_thread)
        self.assertGreater(store.stats()["audit"], threads * per_thread)


class EvidenceBlockTest(unittest.TestCase):
    def test_add_evidence_defaults_and_count(self) -> None:
        store = make_store(self)
        mem = store.add_memory({"title": "证据", "body": "b", "kind": "fact", "scope_id": "global"})
        first = store.add_evidence(mem["id"], {"kind": "user_stated", "quote": "用户原话"})
        self.assertAlmostEqual(first["trust"], 0.9)
        self.assertFalse(first["verified"])
        second = store.add_evidence(
            mem["id"], {"kind": "web", "uri": "https://example.com", "verified": True}
        )
        self.assertAlmostEqual(second["trust"], 0.6)
        self.assertTrue(second["verified"])
        self.assertEqual(len(store.list_evidence(mem["id"])), 2)
        refreshed = store.get_memory(mem["id"])
        self.assertEqual(refreshed["source_count"], 2)
        self.assertEqual(len(refreshed["evidence"]), 2)

    def test_add_evidence_validation(self) -> None:
        store = make_store(self)
        mem = store.add_memory({"title": "证据", "body": "b", "kind": "fact", "scope_id": "global"})
        with self.assertRaises(ValueError):
            store.add_evidence(mem["id"], {"kind": "made-up"})
        with self.assertRaises(KeyError):
            store.add_evidence("m-missing", {"kind": "user_stated"})

    def test_add_block_ordinals_and_fields(self) -> None:
        store = make_store(self)
        mem = store.add_memory({"title": "块", "body": "b", "kind": "knowledge", "scope_id": "global"})
        formula = store.add_block(mem["id"], {"type": "formula", "content": "E=mc^2"})
        self.assertEqual(formula["ordinal"], 1)
        code = store.add_block(mem["id"], {"type": "code", "lang": "python", "content": "x = 1"})
        self.assertEqual(code["ordinal"], 2)
        table = store.add_block(mem["id"], {
            "type": "table", "fields": {"columns": ["a"], "rows": [["1"]]},
        })
        self.assertEqual(table["fields"]["columns"], ["a"])
        with self.assertRaises(ValueError):
            store.add_block(mem["id"], {"type": "unknown"})
        with self.assertRaises(KeyError):
            store.add_block("m-missing", {"type": "formula", "content": ""})
        self.assertEqual([b["type"] for b in store.list_blocks(mem["id"])],
                         ["formula", "code", "table"])


class GraphTest(unittest.TestCase):
    def _seed(self) -> Store:
        store = make_store(self)
        store.ensure_scope("global", "global")
        store.ensure_scope("workspace:demo", "workspace", parent_id="global")
        store.ensure_scope("agent:dsh", "agent", parent_id="workspace:demo")
        base = store.add_memory({
            "title": "BM25 打分", "body": "BM25 是概率检索模型。", "kind": "knowledge",
            "scope_id": "agent:dsh", "importance": 0.9,
        })
        child = store.add_memory({
            "title": "BM25 参数 k1", "body": "k1 控制词频饱和。", "kind": "knowledge",
            "scope_id": "agent:dsh", "importance": 0.4,
        })
        store.set_status(base["id"], "approved")
        store.set_status(child["id"], "approved")
        entity = store.upsert_entity("BM25", "concept", "检索打分算法")
        other = store.upsert_entity("稀疏检索", "concept")
        store.link_memory_entity(base["id"], entity["id"])
        store.link_memory_entity(child["id"], entity["id"])
        store.link_memory_entity(base["id"], other["id"])
        store.add_edge(entity["id"], "entity", other["id"], "entity", "hypernym", 0.9, 0.8)
        store.add_edge(base["id"], "memory", child["id"], "memory", "part_of", 0.7, 0.9)
        store.add_edge(child["id"], "memory", base["id"], "memory", "supports", 0.6, 0.8)
        doc = store.add_document({"path": "notes/bm25.md", "kind": "note", "text": "# BM25"})
        store.replace_chunks(doc["id"], [{"text": "BM25 是概率检索模型", "heading": "BM25"}])
        chunk_id = store.con.execute(
            "SELECT id FROM chunk WHERE document_id = ?", (doc["id"],)
        ).fetchone()[0]
        store.add_evidence(base["id"], {
            "kind": "document", "quote": "BM25 是概率检索模型",
            "document_id": doc["id"], "chunk_id": chunk_id,
        })
        return store

    def test_four_views_are_non_empty_and_json_serializable(self) -> None:
        store = self._seed()
        for view in ("semantic", "hierarchy", "timeline", "evidence"):
            with self.subTest(view=view):
                result = store.graph(view)
                self.assertTrue(result["nodes"], "%s 视图节点不应为空" % view)
                self.assertTrue(result["edges"], "%s 视图边不应为空" % view)
                self.assertEqual(
                    set(result["meta"]),
                    {"view", "scope", "node_count", "edge_count", "truncated", "built_at",
                     "limit"},
                )
                self.assertEqual(result["meta"]["view"], view)
                self.assertEqual(result["meta"]["node_count"], len(result["nodes"]))
                self.assertEqual(result["meta"]["edge_count"], len(result["edges"]))
                self.assertFalse(result["meta"]["truncated"])
                payload = json.dumps(result, ensure_ascii=False)
                restored = json.loads(payload)
                self.assertEqual(len(restored["nodes"]), len(result["nodes"]))
                for node in result["nodes"]:
                    self.assertIn("degree", node)
                    self.assertIn("kind", node)
                    self.assertTrue(str(node["label"]))
                for edge in result["edges"]:
                    self.assertIn("source", edge)
                    self.assertIn("target", edge)
                    self.assertIn("rel", edge)

    def test_semantic_view_content(self) -> None:
        store = self._seed()
        result = store.graph("semantic")
        kinds = {node["kind"] for node in result["nodes"]}
        self.assertEqual(kinds, {"memory", "entity"})
        rels = {edge["rel"] for edge in result["edges"]}
        self.assertIn("mentions", rels)
        self.assertIn("hypernym", rels)
        self.assertIn("part_of", rels)
        entity = [n for n in result["nodes"] if n["kind"] == "entity"]
        self.assertTrue(any(n["label"] == "BM25" for n in entity))
        self.assertTrue(all(n["degree"] > 0 for n in result["nodes"]))

    def test_hierarchy_view_content(self) -> None:
        store = self._seed()
        result = store.graph("hierarchy")
        kinds = {node["kind"] for node in result["nodes"]}
        self.assertEqual(kinds, {"scope", "memory"})
        depths = {node["id"]: node["depth"] for node in result["nodes"]}
        self.assertEqual(depths["global"], 0)
        self.assertEqual(depths["workspace:demo"], 1)
        self.assertEqual(depths["agent:dsh"], 2)
        mem = [n for n in result["nodes"] if n["kind"] == "memory"][0]
        self.assertEqual(mem["depth"], 3)
        self.assertEqual(mem["parent"], "agent:dsh")
        rels = {edge["rel"] for edge in result["edges"]}
        self.assertIn("contains", rels)
        self.assertIn("in_scope", rels)

    def test_timeline_view_content(self) -> None:
        store = self._seed()
        result = store.graph("timeline")
        days = [n for n in result["nodes"] if n["kind"] == "day"]
        self.assertEqual(len(days), 1)
        self.assertGreater(days[0]["t"], 0)
        self.assertRegex(days[0]["bucket"], r"^\d{4}-\d{2}-\d{2}$")
        mems = [n for n in result["nodes"] if n["kind"] == "memory"]
        self.assertTrue(all(n["t"] > 0 for n in mems))
        self.assertEqual({e["rel"] for e in result["edges"]}, {"contains", "temporal_next"})

    def test_evidence_view_content(self) -> None:
        store = self._seed()
        result = store.graph("evidence")
        kinds = {node["kind"] for node in result["nodes"]}
        self.assertEqual(kinds, {"memory", "evidence", "document", "chunk"})
        ev_edges = [e for e in result["edges"] if e["rel"] == "evidence"]
        self.assertEqual(ev_edges[0]["kind"], "document")
        self.assertAlmostEqual(ev_edges[0]["trust"], 0.7)

    def test_scope_filter_and_truncation(self) -> None:
        store = self._seed()
        scoped = store.graph("semantic", scope_id="agent:dsh")
        self.assertEqual(scoped["meta"]["scope"], "agent:dsh")
        self.assertTrue(scoped["nodes"])
        empty = store.graph("semantic", scope_id="workspace:empty")
        self.assertEqual(empty["nodes"], [])
        self.assertEqual(empty["meta"]["node_count"], 0)
        truncated = store.graph("semantic", limit=1)
        self.assertTrue(truncated["meta"]["truncated"])
        self.assertLessEqual(len(truncated["nodes"]), 3)

    def test_invalid_view(self) -> None:
        store = self._seed()
        with self.assertRaises(ValueError):
            store.graph("brain")


class EntityEdgeTest(unittest.TestCase):
    def test_upsert_entity_idempotent(self) -> None:
        store = make_store(self)
        first = store.upsert_entity("BM25", "concept", "检索算法")
        second = store.upsert_entity("BM25", "concept")
        self.assertEqual(first["id"], second["id"])
        updated = store.upsert_entity("BM25", "concept", "更精确的定义")
        self.assertEqual(updated["definition"], "更精确的定义")
        other = store.upsert_entity("BM25", "term")
        self.assertNotEqual(other["id"], first["id"])
        with self.assertRaises(ValueError):
            store.upsert_entity("", "concept")

    def test_link_and_edges(self) -> None:
        store = make_store(self)
        mem = store.add_memory({"title": "链接", "body": "b", "kind": "fact", "scope_id": "global"})
        entity = store.upsert_entity("查询扩展", "concept")
        store.link_memory_entity(mem["id"], entity["id"])
        store.link_memory_entity(mem["id"], entity["id"])  # 幂等
        loaded = store.get_memory(mem["id"])
        self.assertEqual(len(loaded["entities"]), 1)
        self.assertEqual(loaded["entities"][0]["role"], "mention")

        edge = store.add_edge(mem["id"], "memory", entity["id"], "entity", "mentions", 0.8, 0.9)
        self.assertAlmostEqual(edge["weight"], 0.8)
        updated = store.add_edge(mem["id"], "memory", entity["id"], "entity", "mentions", 1.5, 1.5)
        self.assertEqual(edge["id"], updated["id"])
        self.assertAlmostEqual(updated["weight"], 1.5)
        self.assertAlmostEqual(updated["confidence"], 1.0)
        self.assertEqual(len(store.get_memory(mem["id"])["edges"]), 1)
        with self.assertRaises(ValueError):
            store.add_edge("", "memory", "x", "entity", "mentions")
        with self.assertRaises(ValueError):
            store.add_edge("a", "nope", "b", "entity", "mentions")
        with self.assertRaises(KeyError):
            store.link_memory_entity(mem["id"], "en-missing")


class DocumentTest(unittest.TestCase):
    def test_add_and_get_document(self) -> None:
        store = make_store(self)
        doc = store.add_document({"path": "notes/a.md", "kind": "note", "title": "A", "text": "hello"})
        self.assertTrue(doc["id"].startswith("doc-"))
        self.assertEqual(len(doc["hash"]), 64)
        self.assertEqual(doc["bytes"], 0)
        updated = store.add_document({
            "path": "notes/a.md", "kind": "note", "title": "A2", "text": "hello world",
            "bytes": 11,
        })
        self.assertEqual(updated["id"], doc["id"])
        self.assertEqual(updated["title"], "A2")
        self.assertEqual(updated["bytes"], 11)
        self.assertNotEqual(updated["hash"], doc["hash"])
        self.assertEqual(store.list_documents({})["total"], 1)
        self.assertEqual(store.get_document(doc["id"])["title"], "A2")
        self.assertEqual(store.get_document("notes/a.md")["id"], doc["id"])
        self.assertIsNone(store.get_document("doc-missing"))
        with self.assertRaises(ValueError):
            store.add_document({"kind": "note"})

    def test_list_documents_filters(self) -> None:
        store = make_store(self)
        store.add_document({"path": "notes/a.md", "kind": "note", "day": "2026-01-01"})
        store.add_document({"path": "reports/r.md", "kind": "report", "day": "2026-01-02"})
        self.assertEqual(store.list_documents({"kind": "report"})["total"], 1)
        self.assertEqual(store.list_documents({"day": "2026-01-01"})["total"], 1)
        self.assertEqual(store.list_documents({"q": "reports"})["total"], 1)
        page = store.list_documents({"limit": 1, "offset": 1})
        self.assertEqual(page["total"], 2)
        self.assertEqual(len(page["items"]), 1)

    def test_replace_chunks(self) -> None:
        store = make_store(self)
        doc = store.add_document({"path": "notes/b.md", "kind": "note"})
        count = store.replace_chunks(doc["id"], [
            {"text": "第一段", "heading": "H1", "level": 1},
            {"text": "第二段", "heading": "H2"},
        ])
        self.assertEqual(count, 2)
        rows = store.con.execute(
            "SELECT ordinal, heading FROM chunk WHERE document_id = ? ORDER BY ordinal",
            (doc["id"],),
        ).fetchall()
        self.assertEqual([r["ordinal"] for r in rows], [1, 2])
        again = store.replace_chunks(doc["id"], [{"text": "只有一段"}])
        self.assertEqual(again, 1)
        self.assertIsNotNone(store.get_document(doc["id"])["indexed_at"])
        fts = store.con.execute(
            "SELECT count(*) FROM chunk_fts WHERE chunk_fts MATCH ?", ("第一段",)
        ).fetchone()[0]
        self.assertEqual(fts, 0, "替换后旧切块必须从 FTS 移除")
        with self.assertRaises(KeyError):
            store.replace_chunks("doc-missing", [])


class CandidateConflictTest(unittest.TestCase):
    def test_candidate_lifecycle(self) -> None:
        store = make_store(self)
        mem = store.add_memory({"title": "候选", "body": "b", "kind": "fact", "scope_id": "global"})
        target = store.add_memory({"title": "目标", "body": "b", "kind": "fact", "scope_id": "global"})
        cand = store.add_candidate({
            "memory_id": mem["id"], "action": "add", "scope_id": "global",
            "dedup": {"jaccard": 0.1}, "payload": {"title": "候选"},
        })
        self.assertEqual(cand["status"], "pending")
        self.assertEqual(cand["dedup"]["jaccard"], 0.1)
        self.assertEqual(target["status"], "candidate")
        with self.assertRaises(ValueError):
            store.add_candidate({"action": "nope"})

    def test_decide_candidate_is_gone(self) -> None:
        # 它绕过状态机并会自动批准（见 store.py 注释、ADR-0002）；不允许悄悄加回来
        self.assertFalse(hasattr(make_store(self), "decide_candidate"))

    def test_conflicts(self) -> None:
        store = make_store(self)
        conflict = store.add_conflict({
            "kind": "contradiction", "a_id": "m-1", "b_id": "m-2", "score": 0.8,
            "detail": {"why": "互斥"},
        })
        self.assertEqual(conflict["status"], "open")
        self.assertEqual(conflict["detail"]["why"], "互斥")
        self.assertAlmostEqual(conflict["score"], 0.8)
        resolved = store.resolve_conflict(conflict["id"], {"keep": "m-1"})
        self.assertEqual(resolved["status"], "resolved")
        self.assertIn("m-1", resolved["resolution"])
        self.assertIsNotNone(resolved["resolved_at"])
        text = store.resolve_conflict(conflict["id"], "保留 m-2")
        self.assertEqual(text["resolution"], "保留 m-2")
        with self.assertRaises(ValueError):
            store.add_conflict({"kind": "nope"})
        with self.assertRaises(KeyError):
            store.resolve_conflict("x-missing", "x")


class SettingStatsAuditTest(unittest.TestCase):
    def test_settings_roundtrip(self) -> None:
        store = make_store(self)
        self.assertIsNone(store.get_setting("missing"))
        self.assertEqual(store.get_setting("missing", 42), 42)
        store.set_setting("ui.theme", {"dark": True, "accent": "teal"})
        self.assertEqual(store.get_setting("ui.theme")["accent"], "teal")
        store.set_setting("ui.theme", [1, 2, 3])
        self.assertEqual(store.get_setting("ui.theme"), [1, 2, 3])
        store.set_setting("plain", "text-value")
        self.assertEqual(store.get_setting("plain"), "text-value")
        with self.assertRaises(ValueError):
            store.set_setting("", 1)

    def test_stats_shape(self) -> None:
        store = make_store(self)
        store.add_memory({"title": "统计", "body": "b", "kind": "fact", "scope_id": "global"})
        stats = store.stats()
        for key in ("memories", "evidence", "blocks", "entities", "edges", "documents",
                    "chunks", "scopes", "candidates", "conflicts", "audit", "generated_at"):
            self.assertIn(key, stats)
        self.assertEqual(stats["memories"]["total"], 1)
        self.assertEqual(stats["memories"]["candidate"], 1)
        self.assertEqual(stats["memories"]["by_kind"], {"fact": 1})

    def test_every_write_is_audited(self) -> None:
        store = make_store(self)
        mem = store.add_memory({"title": "审计", "body": "b", "kind": "fact", "scope_id": "global"})
        store.update_memory(mem["id"], {"title": "审计2"})
        store.add_evidence(mem["id"], {"kind": "user_stated"})
        store.add_block(mem["id"], {"type": "formula", "content": "x"})
        entity = store.upsert_entity("审计实体", "concept")
        store.link_memory_entity(mem["id"], entity["id"])
        store.add_edge(mem["id"], "memory", entity["id"], "entity", "mentions")
        store.set_status(mem["id"], "approved")
        store.add_document({"path": "notes/x.md", "kind": "note"})
        store.add_candidate({"action": "add"})
        store.add_conflict({"kind": "duplicate"})
        store.set_setting("k", 1)
        store.delete_memory(mem["id"])
        actions = [r["action"] for r in store.con.execute(
            "SELECT action FROM audit ORDER BY at, rowid"
        ).fetchall()]
        for expected in (
            "memory.create", "memory.update", "evidence.add", "block.add", "entity.create",
            "memory.entity.link", "edge.add", "memory.set_status", "document.upsert",
            "candidate.add", "conflict.add", "setting.set", "memory.delete",
        ):
            self.assertIn(expected, actions)
        row = store.con.execute(
            "SELECT * FROM audit WHERE action = 'memory.create' LIMIT 1"
        ).fetchone()
        detail = json.loads(row["detail"])
        self.assertEqual(detail["kind"], "fact")
        self.assertEqual(row["actor"], "system")

    def test_audit_actor_override(self) -> None:
        store = make_store(self)
        store.audit("memory.create", "m-1", actor="claude-code", detail={"a": 1})
        row = store.con.execute("SELECT * FROM audit ORDER BY rowid DESC LIMIT 1").fetchone()
        self.assertEqual(row["actor"], "claude-code")
        self.assertEqual(json.loads(row["detail"]), {"a": 1})


class MirrorTest(unittest.TestCase):
    """Store 与 Vault 的联动：写入即镜像，且 document 行可追溯。"""

    def test_add_memory_mirrors_to_vault(self) -> None:
        from memora_core.vault import Vault

        root = tempfile.mkdtemp(prefix="memora-mirror-")
        self.addCleanup(shutil.rmtree, root, True)
        db_path = os.path.join(root, "memora.db")
        dbmod.init_db(db_path)
        vault = Vault(os.path.join(root, "vault"))
        store = Store(db_path, vault)
        self.addCleanup(store.close)

        mem = store.add_memory({
            "title": "镜像测试", "body": "正文内容", "kind": "knowledge", "scope_id": "global",
        })
        rel = vault.relative_memory_path(mem["id"])
        self.assertIsNotNone(rel)
        text = vault.read(rel)
        self.assertIn("镜像测试", text)
        doc = store.get_document("mem:" + mem["id"])
        self.assertEqual(doc["kind"], "memory")
        self.assertEqual(doc["hash"], vault._hash(text))

        store.update_memory(mem["id"], {"title": "镜像测试改名"})
        self.assertEqual(vault.relative_memory_path(mem["id"]), rel,
                         "改名后沿用原文件名，避免产生孤儿镜像")

        store.delete_memory(mem["id"], hard=True)
        self.assertFalse(vault.path(rel).exists())
        self.assertIsNone(store.get_document("mem:" + mem["id"]))


class SchemaGuardTest(unittest.TestCase):
    def test_no_bare_commit_and_transactions_used(self) -> None:
        """写操作必须走 transaction()，源码里不应出现裸 commit。"""
        import memora_core.store as store_mod

        with open(store_mod.__file__, encoding="utf-8") as handle:
            source = handle.read()
        self.assertNotIn(".commit()", source)
        self.assertIn("dbmod.transaction", source)
        self.assertIn("from __future__ import annotations", source)

    def test_close_and_reopen(self) -> None:
        root = tempfile.mkdtemp(prefix="memora-reopen-")
        self.addCleanup(shutil.rmtree, root, True)
        db_path = os.path.join(root, "memora.db")
        dbmod.init_db(db_path)
        store = Store(db_path)
        mem = store.add_memory({"title": "重开", "body": "b", "kind": "fact", "scope_id": "global"})
        store.close()
        reopened = Store(db_path)
        self.addCleanup(reopened.close)
        self.assertEqual(reopened.get_memory(mem["id"])["title"], "重开")
        self.assertIsInstance(reopened.con, sqlite3.Connection)


if __name__ == "__main__":
    unittest.main()
