# -*- coding: utf-8 -*-
"""tests/test_exchange.py — memora-exchange/1 导出、格式识别、归一、导入与去重。"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from memora_core import db as dbmod
from memora_core import exchange as ex
from memora_core.paths import Paths
from memora_core.store import Store
from memora_core.vault import Vault

REQUIRED = {"schema", "id", "title", "body", "kind", "category", "scope", "agent", "trust",
            "importance", "status", "recorded_at", "tags", "evidence", "blocks", "entities",
            "edges"}


def make_store(prefix: str = "memora-exchange-") -> Store:
    tmp = Path(tempfile.mkdtemp(prefix=prefix))
    paths = Paths(tmp).ensure()
    dbmod.init_db(paths.db)
    return Store(paths.db, Vault(paths.vault))


def seed_rich(store: Store) -> list[dict]:
    """造三条带证据/块/实体/关系的已审核记忆。"""
    out = []
    mem = store.add_memory({
        "scope_id": "workspace:demo", "agent_id": "claude-code", "kind": "fact",
        "category": "检索", "title": "RRF 融合能稳定提升召回",
        "body": "RRF（Reciprocal Rank Fusion）按 1/(k+rank) 融合多路召回，无需分数归一化。",
        "status": "approved", "trust": 0.9, "importance": 0.8,
        "metadata": {"tags": ["检索", "融合"]},
    })
    store.add_evidence(mem["id"], {"kind": "tool_output", "quote": "RRF k=60 实测提升 12%",
                                    "uri": "bench://rrf", "verified": True})
    store.add_block(mem["id"], {"type": "formula", "caption": "RRF 公式",
                                 "content": "score = sum(1 / (k + rank_i))"})
    entity = store.upsert_entity("RRF", "concept", "倒数排名融合", "workspace:demo")
    store.link_memory_entity(mem["id"], entity["id"], "mention")
    out.append(mem)

    mem2 = store.add_memory({
        "scope_id": "global", "agent_id": "codex-cli", "kind": "preference",
        "title": "先查再写", "body": "写入记忆前先 memory_search，避免重复。",
        "status": "approved", "trust": 0.85, "importance": 0.7,
        "metadata": {"tags": ["工作流"]},
    })
    store.add_edge(mem["id"], "memory", mem2["id"], "memory", "semantic", 0.9, 0.8)
    out.append(mem2)

    mem3 = store.add_memory({
        "scope_id": "workspace:demo", "agent_id": "claude-code", "kind": "decision",
        "title": "候选态不进默认召回", "body": "只有 approved 参与默认召回，candidate 需审核。",
        "status": "candidate", "trust": 0.5, "importance": 0.6,
    })
    out.append(mem3)
    return out


class ExportTest(unittest.TestCase):
    def setUp(self):
        self.store = make_store()
        self.memories = seed_rich(self.store)

    def tearDown(self):
        self.store.close()

    def test_export_is_jsonl_with_required_fields(self):
        text = ex.export_jsonl(self.store)
        lines = [ln for ln in text.splitlines() if ln.strip()]
        self.assertEqual(len(lines), 2, "默认只导出 approved")
        for line in lines:
            obj = json.loads(line)
            self.assertTrue(REQUIRED.issubset(obj.keys()),
                            "缺少字段: %s" % (REQUIRED - set(obj)))
            self.assertEqual(obj["schema"], "memora-exchange/1")

    def test_export_includes_evidence_and_blocks(self):
        text = ex.export_jsonl(self.store, scope="workspace:demo")
        obj = json.loads(text.splitlines()[0])
        self.assertTrue(obj["evidence"], "应带证据")
        self.assertEqual(obj["evidence"][0]["kind"], "tool_output")
        self.assertTrue(obj["evidence"][0]["verified"])
        self.assertEqual(obj["blocks"][0]["type"], "formula")
        self.assertIn("score = sum", obj["blocks"][0]["content"])
        self.assertEqual(obj["entities"][0]["name"], "RRF")
        self.assertTrue(obj["edges"])

    def test_export_excludes_evidence_when_disabled(self):
        text = ex.export_jsonl(self.store, include_evidence=False)
        for line in text.splitlines():
            self.assertEqual(json.loads(line)["evidence"], [])

    def test_export_status_filter(self):
        text = ex.export_jsonl(self.store, status="candidate")
        objs = [json.loads(ln) for ln in text.splitlines() if ln.strip()]
        self.assertEqual(len(objs), 1)
        self.assertEqual(objs[0]["status"], "candidate")

    def test_export_scope_filter(self):
        text = ex.export_jsonl(self.store, status=None)
        objs = [json.loads(ln) for ln in text.splitlines() if ln.strip()]
        self.assertEqual(len(objs), 3)
        scoped = ex.export_jsonl(self.store, scope="workspace:demo", status=None)
        titles = {json.loads(ln)["title"] for ln in scoped.splitlines() if ln.strip()}
        self.assertEqual(len(titles), 2)
        self.assertNotIn("先查再写", titles)

    def test_export_empty_store(self):
        fresh = make_store("memora-exchange-empty-")
        try:
            self.assertEqual(ex.export_jsonl(fresh), "")
        finally:
            fresh.close()


class RoundTripTest(unittest.TestCase):
    def test_export_import_roundtrip(self):
        source = make_store()
        dest = make_store("memora-exchange-dest-")
        try:
            seed_rich(source)
            text = ex.export_jsonl(source, status=None)
            exported = [json.loads(ln) for ln in text.splitlines() if ln.strip()]
            report = ex.import_jsonl(dest, text, agent_id="claude-code")
            self.assertEqual(report["errors"], [])
            self.assertEqual(report["imported"], len(exported))
            self.assertEqual(report["skipped"], 0)
            self.assertEqual(report["deduped"], 0)

            rows = dest.con.execute(
                "SELECT id, title, kind, scope_id, status FROM memory ORDER BY id").fetchall()
            self.assertEqual(len(rows), len(exported))
            source_titles = sorted(o["title"] for o in exported)
            dest_titles = sorted(r["title"] for r in rows)
            self.assertEqual(source_titles, dest_titles, "标题必须一一对应")
            source_ids = sorted(o["id"] for o in exported)
            self.assertEqual(sorted(r["id"] for r in rows), source_ids, "id 必须保真")

            # 证据/块/实体/边也要跟着回来
            ev = dest.con.execute("SELECT count(*) FROM evidence").fetchone()[0]
            blocks = dest.con.execute("SELECT count(*) FROM block").fetchone()[0]
            entities = dest.con.execute("SELECT count(*) FROM entity").fetchone()[0]
            edges = dest.con.execute("SELECT count(*) FROM edge").fetchone()[0]
            self.assertEqual(ev, 1)
            self.assertEqual(blocks, 1)
            self.assertEqual(entities, 1)
            self.assertEqual(edges, 1)
        finally:
            source.close()
            dest.close()

    def test_import_is_searchable(self):
        dest = make_store("memora-exchange-fts-")
        source = make_store("memora-exchange-src-")
        try:
            seed_rich(source)
            text = ex.export_jsonl(source, status=None)
            ex.import_jsonl(dest, text)
            found = dest.list_memories({"q": "RRF"})
            self.assertGreater(found["total"], 0, "导入后必须能被 FTS 搜到")
        finally:
            source.close()
            dest.close()


class DedupTest(unittest.TestCase):
    def setUp(self):
        self.store = make_store("memora-exchange-dedup-")

    def tearDown(self):
        self.store.close()

    def test_same_payload_twice_is_deduped(self):
        record = {
            "schema": "memora-exchange/1", "id": "m-fixed-1",
            "title": "离线降级下仍可检索", "body": "BM25 与字符哈希向量在离线时兜底。",
            "kind": "fact", "category": "", "scope": "global", "agent": "tester",
            "trust": 0.8, "importance": 0.6, "status": "approved",
            "recorded_at": "2026-01-01T00:00:00Z", "tags": ["降级"],
            "evidence": [], "blocks": [], "entities": [], "edges": [],
        }
        text = json.dumps(record, ensure_ascii=False)
        first = ex.import_jsonl(self.store, text)
        self.assertEqual(first["imported"], 1)
        second = ex.import_jsonl(self.store, text)
        self.assertEqual(second["imported"], 0)
        self.assertEqual(second["deduped"], 1)
        self.assertEqual(second["skipped"], 1)

    def test_near_duplicate_is_deduped(self):
        body = "记忆中枢把多个智能体的记忆收敛到一处，SQLite 是事务真源。"
        base = {"schema": "memora-exchange/1", "kind": "knowledge", "scope": "global",
                "trust": 0.5, "importance": 0.5, "status": "approved",
                "recorded_at": "2026-01-01T00:00:00Z", "category": "", "agent": "",
                "tags": [], "evidence": [], "blocks": [], "entities": [], "edges": []}
        first = dict(base, id="m-a", title="记忆中枢定位", body=body)
        second = dict(base, id="m-b", title="记忆中枢定位", body=body)
        ex.import_jsonl(self.store, json.dumps(first, ensure_ascii=False))
        report = ex.import_jsonl(self.store, json.dumps(second, ensure_ascii=False))
        self.assertEqual(report["imported"], 0)
        self.assertEqual(report["deduped"], 1)

    def test_distinct_content_is_imported(self):
        base = {"schema": "memora-exchange/1", "kind": "fact", "scope": "global",
                "trust": 0.5, "importance": 0.5, "status": "approved",
                "recorded_at": "2026-01-01T00:00:00Z", "category": "", "agent": "",
                "tags": [], "evidence": [], "blocks": [], "entities": [], "edges": []}
        a = dict(base, id="m-x", title="向量维度", body="本地字符哈希向量固定 256 维。")
        b = dict(base, id="m-y", title="端口约定", body="HTTP API 默认监听 127.0.0.1:8790。")
        report = ex.import_jsonl(self.store, "\n".join(
            [json.dumps(a, ensure_ascii=False), json.dumps(b, ensure_ascii=False)]))
        self.assertEqual(report["imported"], 2)
        self.assertEqual(report["deduped"], 0)

    def test_dry_run_does_not_write(self):
        text = json.dumps({"schema": "memora-exchange/1", "id": "m-dry", "title": "试运行",
                           "body": "不应落库", "kind": "fact", "scope": "global"},
                          ensure_ascii=False)
        report = ex.import_jsonl(self.store, text, dry_run=True)
        self.assertEqual(report["imported"], 1)
        self.assertTrue(report["dry_run"])
        rows = self.store.con.execute("SELECT count(*) FROM memory").fetchone()[0]
        self.assertEqual(rows, 0)


class DetectFormatTest(unittest.TestCase):
    def test_detect_memora(self):
        self.assertEqual(ex.detect_format({"schema": "memora-exchange/1",
                                           "title": "t", "body": "b"}), "memora")

    def test_detect_mem0(self):
        self.assertEqual(ex.detect_format({"memory": "用户喜欢深色主题",
                                           "user_id": "u-1"}), "mem0")

    def test_detect_mcp_memory_service(self):
        self.assertEqual(ex.detect_format({"content": "SQLite WAL 模式",
                                           "memory_type": "note"}), "mcp-memory-service")

    def test_detect_basic_memory(self):
        self.assertEqual(ex.detect_format({"permalink": "notes/a",
                                           "entity_type": "note"}), "basic-memory")

    def test_detect_generic(self):
        self.assertEqual(ex.detect_format({"foo": "bar"}), "generic")

    def test_detect_non_dict(self):
        self.assertEqual(ex.detect_format("不是字典"), "generic")


class ToMemoraTest(unittest.TestCase):
    def test_mem0_normalized(self):
        out = ex.to_memora({"memory": "偏好使用 TypeScript", "user_id": "u1",
                            "categories": ["preference"]}, "mem0", "agent:mem0")
        self.assertEqual(out["title"], "偏好使用 TypeScript")
        self.assertEqual(out["body"], "偏好使用 TypeScript")
        self.assertEqual(out["tags"], ["preference"])
        self.assertEqual(out["scope"], "agent:mem0")
        self.assertEqual(out["schema"], "memora-exchange/1")

    def test_mcp_memory_service_normalized(self):
        out = ex.to_memora({"content": "# 标题\n\n正文内容", "tags": ["x"],
                            "memory_type": "observation"}, "mcp-memory-service", "global")
        self.assertEqual(out["title"], "# 标题 正文内容"[:80])
        self.assertIn("正文内容", out["body"])
        self.assertEqual(out["tags"], ["x"])
        self.assertEqual(out["kind"], "experience")

    def test_basic_memory_normalized(self):
        out = ex.to_memora({"permalink": "proj/notes/a", "content": "内容",
                            "frontmatter": {"tags": ["p"]}}, "basic-memory", "global")
        self.assertEqual(out["title"], "proj/notes/a")
        self.assertEqual(out["tags"], ["p"])

    def test_generic_never_raises(self):
        for payload in ({}, {"foo": 1}, {"text": "只有文本"}):
            out = ex.to_memora(payload, "generic", "global")
            self.assertTrue(out["title"])
            self.assertIn("schema", out)

    def test_bad_kind_falls_back(self):
        out = ex.to_memora({"title": "t", "body": "b", "kind": "不存在的类型"},
                           "memora", "global")
        self.assertIn(out["kind"], ex.MEMORY_KINDS)


class ImportErrorTest(unittest.TestCase):
    def setUp(self):
        self.store = make_store("memora-exchange-err-")

    def tearDown(self):
        self.store.close()

    def test_bad_json_line_is_reported(self):
        text = "{\"title\": \"ok\", \"body\": \"b\", \"kind\": \"fact\", \"scope\": \"global\"}\n" \
               "这不是 JSON\n"
        report = ex.import_jsonl(self.store, text)
        self.assertEqual(report["imported"], 1)
        self.assertEqual(len(report["errors"]), 1)
        self.assertEqual(report["errors"][0]["line"], 2)

    def test_empty_body_is_skipped(self):
        text = json.dumps({"schema": "memora-exchange/1", "id": "m-e", "title": "",
                           "body": "", "kind": "fact", "scope": "global"})
        report = ex.import_jsonl(self.store, text)
        self.assertEqual(report["imported"], 0)
        self.assertEqual(report["skipped"], 1)
        self.assertTrue(report["errors"])

    def test_empty_text(self):
        report = ex.import_jsonl(self.store, "")
        self.assertEqual(report["imported"], 0)
        self.assertEqual(report["errors"], [])

    def test_json_array_accepted(self):
        payload = [{"title": "甲", "body": "内容甲", "kind": "fact", "scope": "global"},
                   {"title": "乙", "body": "内容乙", "kind": "fact", "scope": "global"}]
        report = ex.import_jsonl(self.store, json.dumps(payload, ensure_ascii=False))
        self.assertEqual(report["imported"], 2)


class ScoreTest(unittest.TestCase):
    def test_identical_text_scores_high(self):
        score = ex.score_pair("同一个句子的内容", "同一个句子的内容")
        self.assertGreater(score["dup"], 0.9)

    def test_different_text_scores_low(self):
        score = ex.score_pair("完全无关的甲内容", "另外一段乙内容")
        self.assertLess(score["dup"], 0.8)

    def test_fallback_matches_contract(self):
        score = ex.fallback_score("abc def", "abc def")
        for key in ("cos", "jac", "ham", "dup", "band"):
            self.assertIn(key, score)

    def test_simhash_is_stable(self):
        self.assertEqual(ex.simhash64("稳定文本"), ex.simhash64("稳定文本"))
        self.assertNotEqual(ex.simhash64("文本甲"), ex.simhash64("完全不同的文本乙"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
