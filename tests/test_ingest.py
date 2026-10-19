# -*- coding: utf-8 -*-
"""tests/test_ingest.py — 文档吸收：格式解析、切块、FTS 可搜、inbox 监听。"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from memora_core import db as dbmod
from memora_core import ingest
from memora_core.paths import Paths
from memora_core.store import Store
from memora_core.vault import Vault

FENCE = chr(96) * 3

SAMPLE_MD = "\n".join([
    "# 记忆中枢的检索设计",
    "",
    "记忆中枢不是记忆库。库只管存，中枢要负责**取回**。",
    "",
    "## 一、三通道召回",
    "",
    "我们同时跑 BM25、向量与图三路，然后用 RRF 融合：",
    "",
    FENCE + "text",
    "score(d) = sum_i 1 / (k + rank_i(d))",
    FENCE,
    "",
    "其中 k 取 60，这是 Robertson 的经典取值。",
    "",
    "## 二、预算打包公式",
    "",
    "上下文预算是硬约束，单条记忆的边际收益按重要性递减：",
    "",
    "$$",
    "U(S) = importance_i - lambda * tokens_i",
    "$$",
    "",
    "当 U 不再增加时停止装入。",
    "",
    "## 三、离线降级",
    "",
    "云端不可用时，向量退化为本地字符 n-gram 哈希（256 维），",
    "重排退化为分数透传，判定退化为阈值规则。",
    "",
    FENCE + "python",
    "def fallback(vec):",
    "    return [hash_ngram(t) for t in vec]",
    FENCE,
    "",
    "## 四、常见误区",
    "",
    "- 把 candidate 当成 approved 直接召回",
    "- 用 simhash 单独判重而不看语义",
    "- 在降级状态下依赖语义相似度做精确判断",
    "",
])

HTML_SAMPLE = "\n".join([
    "<html><head><title>吸收测试页</title></head>",
    "<body>",
    "<h1>主标题</h1>",
    "<p>第一段<strong>加粗</strong>内容。</p>",
    "<p>第二段内容。</p>",
    "<pre>code block here</pre>",
    "<ul><li>项目一</li><li>项目二</li></ul>",
    "<script>var x = 1;</script>",
    "</body></html>",
])


def make_store(prefix: str = "memora-ingest-") -> tuple[Store, Paths]:
    tmp = Path(tempfile.mkdtemp(prefix=prefix))
    paths = Paths(tmp).ensure()
    dbmod.init_db(paths.db)
    return Store(paths.db, Vault(paths.vault)), paths


class ParseTest(unittest.TestCase):
    def test_html_strips_tags_keeps_paragraphs(self):
        text = ingest.html_to_markdown(HTML_SAMPLE)
        self.assertNotIn("<p>", text)
        self.assertNotIn("<script", text)
        self.assertNotIn("var x = 1", text, "script 内容必须丢弃")
        self.assertIn("第一段", text)
        self.assertIn("加粗", text)
        self.assertIn("# 主标题", text)
        self.assertIn("项目一", text)
        self.assertIn("code block here", text)
        self.assertIn("\n\n", text, "段落之间必须保留空行")

    def test_md_title_from_heading(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "a.md"
            path.write_text("# 我的标题\n\n正文", encoding="utf-8")
            parsed = ingest.parse_document(path)
            self.assertEqual(parsed["title"], "我的标题")

    def test_md_title_from_frontmatter(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "b.md"
            path.write_text("---\ntitle: 前置标题\n---\n\n正文", encoding="utf-8")
            parsed = ingest.parse_document(path)
            self.assertEqual(parsed["title"], "前置标题")

    def test_txt_parse(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "c.txt"
            path.write_text("纯文本文档内容", encoding="utf-8")
            parsed = ingest.parse_document(path)
            self.assertEqual(parsed["text"], "纯文本文档内容")
            self.assertEqual(parsed["title"], "c")

    def test_json_parse(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "d.json"
            path.write_text(json.dumps({"title": "JSON 标题", "body": "JSON 正文",
                                        "extra": 42}, ensure_ascii=False), encoding="utf-8")
            parsed = ingest.parse_document(path)
            self.assertEqual(parsed["title"], "JSON 标题")
            self.assertIn("JSON 正文", parsed["text"])
            self.assertIn("extra", parsed["text"])

    def test_jsonl_parse(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "e.jsonl"
            path.write_text("\n".join([
                json.dumps({"title": "第一条", "body": "甲"}, ensure_ascii=False),
                json.dumps({"title": "第二条", "body": "乙"}, ensure_ascii=False)]),
                encoding="utf-8")
            parsed = ingest.parse_document(path)
            self.assertIn("第一条", parsed["text"])
            self.assertIn("第二条", parsed["text"])

    def test_pdf_without_pypdf_raises_explicitly(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "fake.pdf"
            path.write_bytes(b"%PDF-1.4\nnot a real pdf")
            try:
                import pypdf  # noqa: F401
                installed = True
            except Exception:  # noqa: BLE001
                installed = False
            if installed:
                with self.assertRaises(Exception):
                    ingest.parse_document(path)
            else:
                with self.assertRaises(RuntimeError) as ctx:
                    ingest.parse_document(path)
                self.assertIn("pypdf", str(ctx.exception))
                self.assertIn("未安装", str(ctx.exception))

    def test_unsupported_binary_is_not_faked(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "blob.bin"
            path.write_bytes(bytes(range(4)))
            self.assertFalse(ingest.supported(path))


class IngestTextTest(unittest.TestCase):
    def setUp(self):
        self.store, self.paths = make_store()

    def tearDown(self):
        self.store.close()

    def test_ingest_text_creates_document_and_chunks(self):
        result = ingest.ingest_text(self.store, SAMPLE_MD, title="检索设计",
                                    scope="workspace:demo")
        self.assertGreater(result["chunks"], 0, "必须切出至少一块")
        self.assertTrue(result["document_id"].startswith("doc-"))
        doc = self.store.get_document(result["document_id"])
        self.assertIsNotNone(doc)
        self.assertEqual(doc["title"], "检索设计")
        self.assertEqual(doc["scope_id"], "workspace:demo")
        self.assertGreater(doc["chunk_count"], 0)

    def test_ingest_text_mirrors_to_vault_notes(self):
        result = ingest.ingest_text(self.store, SAMPLE_MD, title="镜像检查")
        self.assertTrue(result["vault_path"], "必须镜像到 vault/notes/")
        self.assertTrue(result["vault_path"].startswith("notes/"))
        mirrored = Path(self.paths.vault) / result["vault_path"]
        self.assertTrue(mirrored.exists(), "镜像文件必须真实存在")
        self.assertIn("记忆中枢", mirrored.read_text(encoding="utf-8"))

    def test_ingest_text_rejects_empty(self):
        with self.assertRaises(ValueError):
            ingest.ingest_text(self.store, "   ", title="空")


class IngestFileTest(unittest.TestCase):
    def setUp(self):
        self.store, self.paths = make_store()
        self.tmp = Path(tempfile.mkdtemp(prefix="memora-docs-"))

    def tearDown(self):
        self.store.close()

    def write(self, name: str, text: str) -> Path:
        path = self.tmp / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        return path

    def test_ingest_markdown_with_code_and_formula(self):
        path = self.write("design.md", SAMPLE_MD)
        result = ingest.ingest_file(self.store, path, scope="workspace:demo")
        self.assertGreater(result["chunks"], 0)
        self.assertEqual(result["title"], "记忆中枢的检索设计")

        rows = self.store.con.execute(
            "SELECT text FROM chunk WHERE document_id = ? ORDER BY ordinal",
            (result["document_id"],)).fetchall()
        self.assertGreater(len(rows), 0)
        joined = "\n".join(r["text"] for r in rows)
        self.assertIn("RRF", joined)
        self.assertIn("score(d)", joined, "代码块必须整块保留")
        self.assertIn("importance_i", joined, "公式必须整块保留")

        hits = self.store.con.execute(
            "SELECT count(*) FROM chunk_fts WHERE chunk_fts MATCH ?", ("RRF",)).fetchone()[0]
        self.assertGreater(hits, 0, "FTS 必须能搜到 RRF")

    def test_chunks_have_heading_paths(self):
        path = self.write("headings.md", SAMPLE_MD)
        result = ingest.ingest_file(self.store, path)
        rows = self.store.con.execute(
            "SELECT heading, level FROM chunk WHERE document_id = ?", (result["document_id"],)
        ).fetchall()
        headings = [r["heading"] for r in rows if r["heading"]]
        self.assertTrue(headings, "切块必须带标题路径")
        self.assertTrue(any("三通道召回" in h for h in headings))

    def test_ingest_html(self):
        path = self.write("page.html", HTML_SAMPLE)
        result = ingest.ingest_file(self.store, path)
        self.assertGreater(result["chunks"], 0)
        self.assertEqual(result["title"], "吸收测试页")
        joined = ingest.document_text(self.store, result["document_id"])
        self.assertIn("第一段", joined)
        self.assertNotIn("<", joined)

    def test_ingest_txt(self):
        path = self.write("note.txt", "第一段纯文本。\n\n第二段纯文本。")
        result = ingest.ingest_file(self.store, path)
        self.assertGreater(result["chunks"], 0)
        self.assertIn("第一段", ingest.document_text(self.store, result["document_id"]))

    def test_ingest_jsonl(self):
        path = self.write("feed.jsonl", "\n".join([
            json.dumps({"title": "条目甲", "body": "内容甲"}, ensure_ascii=False),
            json.dumps({"title": "条目乙", "body": "内容乙"}, ensure_ascii=False)]))
        result = ingest.ingest_file(self.store, path)
        self.assertGreater(result["chunks"], 0)
        joined = ingest.document_text(self.store, result["document_id"])
        self.assertIn("内容甲", joined)
        self.assertIn("内容乙", joined)
        headings = [r["heading"] for r in self.store.con.execute(
            "SELECT heading FROM chunk WHERE document_id = ?", (result["document_id"],))]
        self.assertTrue(any("条目甲" in (h or "") for h in headings),
                        "条目标题应保留在 heading 路径里: %s" % headings)

    def test_missing_file(self):
        with self.assertRaises(FileNotFoundError):
            ingest.ingest_file(self.store, self.tmp / "nope.md")

    def test_directory_passed_as_file(self):
        with self.assertRaises(IsADirectoryError):
            ingest.ingest_file(self.store, self.tmp)

    def test_document_id_is_stable_for_same_content(self):
        path = self.write("same.md", "# 同样内容\n\n不变。")
        first = ingest.ingest_file(self.store, path)
        second = ingest.ingest_file(self.store, path)
        self.assertEqual(first["document_id"], second["document_id"],
                         "同路径重复吸收必须复用文档行")
        total = self.store.con.execute("SELECT count(*) FROM document").fetchone()[0]
        self.assertEqual(total, 1)


class IngestDirectoryTest(unittest.TestCase):
    def setUp(self):
        self.store, self.paths = make_store()
        self.tmp = Path(tempfile.mkdtemp(prefix="memora-dir-"))

    def tearDown(self):
        self.store.close()

    def test_directory_ingest(self):
        (self.tmp / "a").mkdir()
        (self.tmp / "a" / "one.md").write_text("# 一\n\n内容一", encoding="utf-8")
        (self.tmp / "a" / "two.md").write_text("# 二\n\n内容二", encoding="utf-8")
        (self.tmp / "skip.bin").write_bytes(bytes(range(2)))
        result = ingest.ingest_directory(self.store, self.tmp)
        self.assertEqual(result["files"], 2, "只吸收 .md")
        self.assertEqual(result["ingested"], 2)
        self.assertGreater(result["chunks"], 0)
        self.assertEqual(result["errors"], [])

    def test_directory_requires_dir(self):
        path = self.tmp / "x.md"
        path.write_text("# x", encoding="utf-8")
        with self.assertRaises(NotADirectoryError):
            ingest.ingest_directory(self.store, path)

    def test_directory_missing(self):
        with self.assertRaises(FileNotFoundError):
            ingest.ingest_directory(self.store, self.tmp / "nowhere")

    def test_one_bad_file_does_not_stop_batch(self):
        (self.tmp / "good.md").write_text("# 好\n\n正文", encoding="utf-8")
        (self.tmp / "empty.md").write_text("   ", encoding="utf-8")
        result = ingest.ingest_directory(self.store, self.tmp)
        self.assertEqual(result["ingested"], 1)
        self.assertEqual(len(result["errors"]), 1)


class InboxTest(unittest.TestCase):
    def setUp(self):
        self.store, self.paths = make_store()
        self.inbox = Path(self.paths.inbox)
        self.inbox.mkdir(parents=True, exist_ok=True)

    def tearDown(self):
        self.store.close()

    def test_watch_inbox_absorbs_and_moves(self):
        source = self.inbox / "投递.md"
        source.write_text("# 投递文档\n\n来自 inbox 的内容。", encoding="utf-8")
        result = ingest.watch_inbox(self.store, inbox=self.inbox)
        self.assertEqual(result["absorbed"], 1)
        self.assertEqual(result["errors"], [])
        self.assertFalse(source.exists(), "吸收后必须移出 inbox")
        moved = self.inbox / "processed" / "投递.md"
        self.assertTrue(moved.exists(), "必须移动到 processed/")
        doc = self.store.con.execute("SELECT count(*) FROM document").fetchone()[0]
        self.assertEqual(doc, 1)

    def test_watch_inbox_empty(self):
        result = ingest.watch_inbox(self.store, inbox=self.inbox)
        self.assertEqual(result["absorbed"], 0)
        self.assertEqual(result["errors"], [])

    def test_watch_inbox_bad_file_goes_to_failed(self):
        bad = self.inbox / "空.md"
        bad.write_text("   ", encoding="utf-8")
        result = ingest.watch_inbox(self.store, inbox=self.inbox)
        self.assertEqual(result["absorbed"], 0)
        self.assertEqual(len(result["errors"]), 1)
        self.assertTrue((self.inbox / "failed" / "空.md").exists())

    def test_watch_inbox_ignores_processed_dir(self):
        processed = self.inbox / "processed"
        processed.mkdir(parents=True, exist_ok=True)
        (processed / "old.md").write_text("# 旧\n\n不应重复吸收", encoding="utf-8")
        result = ingest.watch_inbox(self.store, inbox=self.inbox)
        self.assertEqual(result["absorbed"], 0)


class ChunkSearchTest(unittest.TestCase):
    """chunk_fts 的 unicode61 分词把连续汉字当单 token，必须由 LIKE 兜底。"""

    def setUp(self):
        self.store, self.paths = make_store("memora-fts-")
        self.text = "\n".join([
            "# 记忆中枢", "",
            "## 三、离线降级", "",
            "云端不可用时向量退化为 char n-gram hash（256 维）。", "",
            "## 四、RRF 融合", "",
            "RRF 融合多路召回，k 取 60。", "",
        ])
        self.doc = ingest.ingest_text(self.store, self.text, title="切块检索")

    def tearDown(self):
        self.store.close()

    def test_ascii_token_matched_by_fts(self):
        hits = ingest.search_chunks(self.store, "RRF")
        self.assertEqual(len(hits), 1)
        self.assertIn("RRF", hits[0]["heading"])
        self.assertEqual(hits[0]["document_id"], self.doc["document_id"])

    def test_cjk_substring_matched_by_fallback(self):
        for term in ("降级", "离线", "融合"):
            hits = ingest.search_chunks(self.store, term)
            self.assertEqual(len(hits), 1, "LIKE 兜底必须命中 %r" % term)
            self.assertIn(term, hits[0]["text"] + (hits[0]["heading"] or ""))

    def test_search_scoped_to_document(self):
        other = ingest.ingest_text(self.store, "# 别的文档\n\nRRF 也在这里。", title="另一篇")
        hits = ingest.search_chunks(self.store, "RRF")
        self.assertEqual(len(hits), 2, "两篇文档都应命中")
        scoped = ingest.search_chunks(self.store, "RRF",
                                      document_id=self.doc["document_id"])
        self.assertEqual(len(scoped), 1)
        self.assertEqual(scoped[0]["document_id"], self.doc["document_id"])
        self.assertNotEqual(scoped[0]["document_id"], other["document_id"])

    def test_empty_query(self):
        self.assertEqual(ingest.search_chunks(self.store, "   "), [])

    def test_no_match(self):
        self.assertEqual(ingest.search_chunks(self.store, "完全不存在的内容zzz"), [])


class ChunkingTest(unittest.TestCase):
    def test_chunk_text_returns_blocks(self):
        chunks = ingest.chunk_text(SAMPLE_MD)
        self.assertGreater(len(chunks), 0)
        for chunk in chunks:
            self.assertIn("text", chunk)
            self.assertIn("hash", chunk)
            self.assertTrue(chunk["text"].strip())

    def test_fallback_chunks_without_module(self):
        chunks = ingest._fallback_chunks("段落一\n\n段落二\n\n段落三", max_tokens=50)
        self.assertGreater(len(chunks), 0)
        self.assertTrue(all("hash" in c for c in chunks))

    def test_long_document_multiple_chunks(self):
        long_text = "\n\n".join("## 小节 %d\n\n%s" % (i, "内容 " * 200) for i in range(8))
        chunks = ingest.chunk_text(long_text, max_tokens=100)
        self.assertGreater(len(chunks), 1, "长文档必须切成多块")


if __name__ == "__main__":
    unittest.main(verbosity=2)