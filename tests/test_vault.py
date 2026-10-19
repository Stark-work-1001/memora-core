# -*- coding: utf-8 -*-
"""vault.py 的单元测试：文件名安全化、front-matter 往返、原子写、日更、索引页。"""
from __future__ import annotations

import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path

from memora_core import db as dbmod
from memora_core.store import Store
from memora_core.vault import (
    AUTOGEN_BANNER,
    Vault,
    dump_frontmatter,
    parse_frontmatter,
    safe_filename,
    unique_path,
)


def make_vault(case: unittest.TestCase) -> Vault:
    root = tempfile.mkdtemp(prefix="memora-vault-")
    case.addCleanup(shutil.rmtree, root, True)
    return Vault(Path(root) / "vault")


def make_store(case: unittest.TestCase, vault: Vault | None = None) -> Store:
    root = tempfile.mkdtemp(prefix="memora-vstore-")
    case.addCleanup(shutil.rmtree, root, True)
    db_path = os.path.join(root, "memora.db")
    dbmod.init_db(db_path)
    store = Store(db_path, vault)
    case.addCleanup(store.close)
    return store


def memory(mid: str = "m-000000000001", **overrides) -> dict:
    base = {
        "id": mid, "title": "BM25 排序原理", "kind": "knowledge", "status": "approved",
        "scope_id": "global", "agent_id": "dsh", "trust": 0.82, "importance": 0.6,
        "confidence": 0.5, "recorded_at": "2026-01-02T03:04:05Z",
        "updated_at": "2026-01-03T04:05:06Z", "body": "BM25 是经典的概率检索模型。",
        "metadata": {"tags": ["检索", "打分"]}, "edges": [], "documents": [],
    }
    base.update(overrides)
    return base


class SafeFilenameTest(unittest.TestCase):
    def test_keeps_chinese_and_replaces_illegal(self) -> None:
        self.assertEqual(safe_filename("记忆中枢"), "记忆中枢")
        self.assertEqual(safe_filename('a<b>c:d"e/f\\g|h?i*j'), "a-b-c-d-e-f-g-h-i-j")
        self.assertEqual(safe_filename("检索: 原理/实践"), "检索-原理-实践")

    def test_control_chars_and_whitespace(self) -> None:
        self.assertEqual(safe_filename("a\x00b\x1fc"), "a-b-c")
        self.assertEqual(safe_filename("  多个   空格  "), "多个-空格")

    def test_length_truncation(self) -> None:
        long_name = "很长" * 100
        result = safe_filename(long_name, max_len=20)
        self.assertEqual(len(result), 20)
        self.assertEqual(safe_filename("x" * 200, max_len=64), "x" * 64)

    def test_empty_and_reserved(self) -> None:
        self.assertEqual(safe_filename(""), "untitled")
        self.assertEqual(safe_filename("///"), "untitled")
        self.assertEqual(safe_filename("CON"), "x-CON")
        self.assertEqual(safe_filename("com1"), "x-com1")

    def test_unique_path_suffix(self) -> None:
        root = Path(tempfile.mkdtemp(prefix="memora-name-"))
        self.addCleanup(shutil.rmtree, root, True)
        target = root / "同名.md"
        self.assertEqual(unique_path(target), target)
        target.write_text("x", encoding="utf-8")
        self.assertEqual(unique_path(target).name, "同名-2.md")
        (root / "同名-2.md").write_text("x", encoding="utf-8")
        self.assertEqual(unique_path(target).name, "同名-3.md")


class FrontmatterTest(unittest.TestCase):
    def test_roundtrip_scalars_lists_and_quotes(self) -> None:
        data = {
            "id": "m-1", "title": "中文 标题", "trust": 0.82, "count": 3,
            "tags": ["检索", "a b"], "empty": "", "marker": 'say "hi"',
            "sources": [],
        }
        text = dump_frontmatter(data)
        self.assertTrue(text.startswith("---\n"))
        self.assertTrue(text.endswith("---\n"))
        parsed, body = parse_frontmatter(text + "正文\n")
        self.assertEqual(body, "正文\n")
        self.assertEqual(parsed["id"], "m-1")
        self.assertEqual(parsed["title"], "中文 标题")
        self.assertAlmostEqual(parsed["trust"], 0.82)
        self.assertEqual(parsed["count"], 3)
        self.assertEqual(parsed["tags"], ["检索", "a b"])
        self.assertEqual(parsed["marker"], 'say "hi"')
        self.assertEqual(parsed["sources"], [])

    def test_roundtrip_through_json_like_payload(self) -> None:
        payload = {
            "id": "m-9", "title": "带: 冒号 和 # 井号", "kind": "fact", "status": "candidate",
            "scope": "workspace:demo", "agent": "claude-code", "trust": 0.5,
            "importance": 1.0, "tags": ["x"], "recorded_at": "2026-01-02T03:04:05Z",
            "updated_at": "2026-01-02T03:04:05Z", "sources": ["document:abc"],
        }
        parsed, _ = parse_frontmatter(dump_frontmatter(payload) + "\n正文")
        self.assertEqual(parsed, payload)

    def test_no_frontmatter(self) -> None:
        data, body = parse_frontmatter("# 只是正文\n")
        self.assertEqual(data, {})
        self.assertEqual(body, "# 只是正文\n")
        data, body = parse_frontmatter("---\nbroken")
        self.assertEqual(data, {})


class RenderTest(unittest.TestCase):
    def setUp(self) -> None:
        self.vault = make_vault(self)

    def test_write_memory_has_required_frontmatter(self) -> None:
        evidence = [{
            "kind": "user_stated", "quote": "BM25 是经典的概率检索模型", "trust": 0.9,
            "verified": True, "uri": "https://example.com/bm25",
        }]
        blocks = [
            {"type": "formula", "content": "score = IDF * tf", "caption": "打分公式"},
            {"type": "code", "lang": "python", "content": "def f(x):\n    return x", "caption": "实现"},
            {"type": "table", "fields": {"columns": ["k1", "含义"], "rows": [["1.2", "默认"]]}},
        ]
        rel = self.vault.write_memory(memory(), evidence, blocks)
        self.assertEqual(rel, "memories/m-000000000001-BM25-排序原理.md")
        text = self.vault.read(rel)
        parsed, body = parse_frontmatter(text)
        for field in ("id", "title", "kind", "status", "scope", "agent", "trust", "importance",
                      "tags", "recorded_at", "updated_at", "sources"):
            self.assertIn(field, parsed, "front-matter 缺少 %s" % field)
        self.assertEqual(parsed["scope"], "global")
        self.assertEqual(parsed["agent"], "dsh")
        self.assertAlmostEqual(parsed["trust"], 0.82)
        self.assertEqual(parsed["tags"], ["检索", "打分"])
        self.assertTrue(parsed["sources"])
        self.assertIn("user_stated", parsed["sources"][0])

        self.assertIn("BM25 是经典的概率检索模型", body)
        self.assertIn("$$", body)
        self.assertIn("score = IDF * tf", body)
        self.assertIn("```python", body)
        self.assertIn("| k1 | 含义 |", body)
        self.assertIn("> BM25 是经典的概率检索模型", body)
        self.assertIn("信任 0.90", body)

    def test_backlinks(self) -> None:
        edges = [{"src": "m-000000000001", "dst": "m-000000000002", "rel": "supports"}]
        rel = self.vault.write_memory(memory(edges=edges))
        text = self.vault.read(rel)
        self.assertIn("[[m-000000000002]]", text)
        self.assertIn("## 相关记忆", text)
        self.assertNotIn("[[m-000000000001]]", text)

    def test_didactic_and_summary(self) -> None:
        mem = memory(
            summary="一句话摘要",
            didactic={
                "definition": "BM25 的定义",
                "formula": "score = IDF * tf",
                "examples": ["例一", "例二"],
            },
        )
        text = self.vault.read(self.vault.write_memory(mem))
        self.assertIn("> 一句话摘要", text)
        self.assertIn("## 教学要点", text)
        self.assertIn("BM25 的定义", text)
        self.assertIn("例一", text)
        self.assertIn("$$", text)

    def test_other_block_types(self) -> None:
        blocks = [
            {"type": "image", "content": "https://example.com/a.png", "caption": "示意图"},
            {"type": "list", "content": "- 一\n- 二"},
            {"type": "quote", "content": "引用一句话"},
            {"type": "database", "content": "SELECT 1", "caption": "查询"},
            {"type": "derivation", "content": "推导过程"},
        ]
        text = self.vault.read(self.vault.write_memory(memory(), [], blocks))
        self.assertIn("![示意图](https://example.com/a.png)", text)
        self.assertIn("- 一", text)
        self.assertIn("> 引用一句话", text)
        self.assertIn("```sql", text)
        self.assertIn("推导过程", text)

    def test_table_from_pipe_content(self) -> None:
        blocks = [{"type": "table", "content": "| a | b |\n| 1 | 2 |"}]
        text = self.vault.read(self.vault.write_memory(memory(), [], blocks))
        self.assertIn("| a | b |", text)

    def test_requires_id(self) -> None:
        with self.assertRaises(ValueError):
            self.vault.write_memory({"title": "无 id"})

    def test_rewrite_is_idempotent(self) -> None:
        mem = memory()
        rel = self.vault.write_memory(mem)
        first = self.vault.read(rel)
        again = self.vault.write_memory(mem)
        self.assertEqual(again, rel)
        self.assertEqual(self.vault.read(again), first)

    def test_title_change_keeps_path(self) -> None:
        rel = self.vault.write_memory(memory())
        rotated = self.vault.write_memory(memory(title="改名后的标题"))
        self.assertEqual(rotated, rel)


class AtomicWriteTest(unittest.TestCase):
    def test_no_tmp_left_and_atomic(self) -> None:
        vault = make_vault(self)
        rel = vault.write_report("周报", "# 周报\n")
        target = vault.path(rel)
        self.assertTrue(target.exists())
        leftovers = [p.name for p in target.parent.iterdir() if p.name.endswith(".tmp")]
        self.assertEqual(leftovers, [])

    def test_failed_write_leaves_old_content(self) -> None:
        vault = make_vault(self)
        target = vault.path("reports/keep.md")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("旧内容", encoding="utf-8")
        with self.assertRaises(AttributeError):
            vault._write_atomic(target, None)  # type: ignore[arg-type]
        self.assertEqual(target.read_text(encoding="utf-8"), "旧内容")
        leftovers = [p.name for p in target.parent.iterdir() if p.name.endswith(".tmp")]
        self.assertEqual(leftovers, [])

    def test_path_escape_rejected(self) -> None:
        vault = make_vault(self)
        vault._ensure_dirs()
        with self.assertRaises(ValueError):
            vault.path("../../etc/passwd")
        safe = vault.write_document("../../逃逸/笔记.md", "内容")
        self.assertTrue(safe.startswith("逃逸/"))
        self.assertTrue(vault.path(safe).exists())


class DailyTest(unittest.TestCase):
    def setUp(self) -> None:
        self.vault = make_vault(self)

    def test_append_creates_header_once(self) -> None:
        rel = self.vault.append_daily({"title": "第一条", "body": "内容 A", "kind": "fact"})
        self.assertRegex(rel, r"^daily/\d{4}-\d{2}-\d{2}\.md$")
        text = self.vault.read(rel)
        self.assertIn("请勿手工修改", text)
        self.assertIn(AUTOGEN_BANNER, text)
        self.assertEqual(text.count("generated_by: memora-core"), 1)

    def test_multiple_appends_same_day(self) -> None:
        day = "2026-03-04"
        for index in range(3):
            self.vault.append_daily({
                "title": "第 %d 条" % index, "body": "内容 %d" % index,
                "at": "%sT0%d:00:00Z" % (day, index), "day": day,
            })
        rel = "daily/%s.md" % day
        text = self.vault.read(rel)
        self.assertEqual(text.count("<!-- memora:entry -->"), 3)
        self.assertEqual(text.count("generated_by: memora-core"), 1)
        for clock in ("00:00:00", "01:00:00", "02:00:00"):
            self.assertIn(clock, text)
        self.assertIn("内容 2", text)
        self.assertLess(text.index("内容 0"), text.index("内容 1"))

    def test_entry_metadata(self) -> None:
        rel = self.vault.append_daily({
            "title": "带元数据", "body": "正文", "kind": "decision",
            "memory_id": "m-123", "scope_id": "workspace:demo", "agent_id": "dsh",
            "tags": ["a", "b"],
        })
        text = self.vault.read(rel)
        self.assertIn("m-123", text)
        self.assertIn("workspace:demo", text)
        self.assertIn("#a", text)
        self.assertIn("类型 *decision*", text)

    def test_daily_registers_document(self) -> None:
        vault = make_vault(self)
        store = make_store(self, vault)
        day = "2026-05-06"
        rel = vault.append_daily({"title": "t", "body": "b", "day": day})
        doc = store.get_document("daily:%s" % day)
        self.assertIsNotNone(doc)
        self.assertEqual(doc["kind"], "daily")
        self.assertEqual(doc["day"], day)
        self.assertEqual(doc["path"], rel)
        self.assertEqual(doc["hash"], vault._hash(vault.read(rel)))
        self.assertEqual(doc["bytes"], len(vault.read(rel).encode("utf-8")))


class DocumentRegistrationTest(unittest.TestCase):
    def test_write_document_registers(self) -> None:
        vault = make_vault(self)
        store = make_store(self, vault)
        rel = vault.write_document("notes/学习/笔记: 一.md", "# 笔记\n")
        self.assertEqual(rel, "notes/学习/笔记-一.md")
        doc = store.get_document("file:%s" % rel)
        self.assertEqual(doc["path"], rel)
        self.assertEqual(doc["origin"], "import")
        self.assertEqual(doc["kind"], "note")

    def test_write_report_registers(self) -> None:
        vault = make_vault(self)
        store = make_store(self, vault)
        rel = vault.write_report("weekly/review", "# 周报\n")
        self.assertEqual(rel, "reports/weekly-review.md")
        doc = store.get_document("report:weekly-review.md")
        self.assertEqual(doc["kind"], "report")
        self.assertEqual(doc["title"], "weekly-review")

    def test_write_report_overwrites(self) -> None:
        vault = make_vault(self)
        first = vault.write_report("r", "第一版")
        second = vault.write_report("r", "第二版")
        self.assertEqual(first, second)
        self.assertEqual(vault.read(second), "第二版")

    def test_document_without_store(self) -> None:
        vault = make_vault(self)
        rel = vault.write_document("notes/x.md", "内容")
        self.assertTrue(vault.path(rel).exists())


class IndexTest(unittest.TestCase):
    def test_rebuild_index(self) -> None:
        vault = make_vault(self)
        store = make_store(self, vault)
        for index in range(3):
            store.add_memory({
                "title": "索引条目 %d" % index,
                "body": "正文 %d" % index,
                "kind": "knowledge" if index % 2 else "fact",
                "scope_id": "global" if index == 0 else "workspace:demo",
                "recorded_at": "2026-0%d-01T00:00:00Z" % (index + 1),
            })
        rel = vault.rebuild_index(store)
        self.assertEqual(rel, "README.md")
        text = vault.read(rel)
        self.assertIn("记忆库索引", text)
        self.assertIn("## 按类型", text)
        self.assertIn("## 按作用域", text)
        self.assertIn("## 按月份", text)
        self.assertIn("## 最近 50 条记忆", text)
        self.assertIn("2026-01", text)
        self.assertIn("fact：2", text)
        self.assertIn("knowledge：1", text)
        self.assertIn("workspace:demo：2", text)
        self.assertEqual(text.count("- ["), 3)
        doc = store.get_document("index:README")
        self.assertEqual(doc["kind"], "index")

    def test_rebuild_index_limit_50(self) -> None:
        vault = make_vault(self)
        store = make_store(self, vault)
        for index in range(60):
            store.add_memory({
                "title": "条目 %02d" % index, "body": "b", "kind": "fact", "scope_id": "global",
            })
        text = vault.read(vault.rebuild_index(store))
        recent = text.split("## 最近 50 条记忆")[1]
        self.assertEqual(recent.count("- ["), 50)

    def test_rebuild_index_requires_store(self) -> None:
        vault = make_vault(self)
        with self.assertRaises(ValueError):
            vault.rebuild_index()


class ListingTest(unittest.TestCase):
    def test_list_files_and_kinds(self) -> None:
        vault = make_vault(self)
        store = make_store(self, vault)
        mem = store.add_memory({
            "title": "列目录", "body": "b", "kind": "fact", "scope_id": "global",
        })
        vault.append_daily({"title": "d", "body": "b", "day": "2026-06-07"})
        vault.write_report("r", "报告")
        vault.write_document("notes/n.md", "笔记")
        vault.write_memory(memory(mem["id"]))
        vault.rebuild_index(store)

        all_files = vault.list_files()
        self.assertGreaterEqual(len(all_files), 5)
        self.assertTrue(all(item["bytes"] > 0 for item in all_files))
        self.assertTrue(all("updated_at" in item for item in all_files))

        self.assertEqual(len(vault.list_files("memory")), 1)
        self.assertEqual(len(vault.list_files("daily")), 1)
        self.assertEqual(len(vault.list_files("report")), 1)
        self.assertEqual(len(vault.list_files("note")), 1)
        self.assertEqual(len(vault.list_files("index")), 1)

    def test_read_missing(self) -> None:
        vault = make_vault(self)
        with self.assertRaises(FileNotFoundError):
            vault.read("nope.md")


class MemoryMirrorIntegrationTest(unittest.TestCase):
    def test_store_writes_parse_back(self) -> None:
        vault = make_vault(self)
        store = make_store(self, vault)
        mem = store.add_memory({
            "title": "集成镜像", "body": "正文", "kind": "knowledge", "scope_id": "global",
            "metadata": {"tags": ["集成"]},
        })
        store.add_evidence(mem["id"], {"kind": "tool_output", "quote": "工具输出"})
        store.add_block(mem["id"], {"type": "formula", "content": "a=b"})
        rel = vault.relative_memory_path(mem["id"])
        parsed, body = parse_frontmatter(vault.read(rel))
        self.assertEqual(parsed["id"], mem["id"])
        self.assertEqual(parsed["kind"], "knowledge")
        self.assertEqual(parsed["tags"], ["集成"])
        self.assertIn("工具输出", body)
        self.assertIn("$$", body)
        store_doc = store.get_document("mem:" + mem["id"])
        self.assertEqual(store_doc["path"], rel)

    def test_remove_memory(self) -> None:
        vault = make_vault(self)
        store = make_store(self, vault)
        mem = store.add_memory({
            "title": "待删", "body": "b", "kind": "fact", "scope_id": "global",
        })
        rel = vault.relative_memory_path(mem["id"])
        self.assertTrue(vault.remove_memory(mem["id"]))
        self.assertFalse(vault.path(rel).exists())
        self.assertIsNone(vault.relative_memory_path(mem["id"]))
        self.assertFalse(vault.remove_memory(mem["id"]))


class OwnershipGuardTest(unittest.TestCase):
    def test_mirror_states_it_is_generated(self) -> None:
        """镜像文件必须自带「自动生成，勿手改」提示，避免人被误导去手改。"""
        vault = make_vault(self)
        text = vault.read(vault.write_memory(memory()))
        self.assertIn("请勿手工编辑", text)
        daily = vault.read(vault.append_daily({"title": "t", "body": "b", "day": "2026-07-08"}))
        self.assertIn("请勿手工修改", daily)

    def test_frontmatter_is_json_serializable(self) -> None:
        vault = make_vault(self)
        mem = memory(metadata={"tags": ["a"], "nested": {"k": 1}})
        text = vault.read(vault.write_memory(mem))
        parsed, _ = parse_frontmatter(text)
        self.assertEqual(parsed["tags"], ["a"])
        json.dumps(parsed, ensure_ascii=False)


if __name__ == "__main__":
    unittest.main()
