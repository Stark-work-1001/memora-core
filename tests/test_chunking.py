# -*- coding: utf-8 -*-
"""切块自测：标题路径、代码块/公式/表格不切断、token 预算、重叠、hash 稳定性。

跑法：
    python -m unittest tests.test_chunking -v
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from memora_core.chunking import chunk_markdown, chunk_text, split_blocks
from memora_core.vectors import estimate_tokens

FENCE = chr(96) * 3

SAMPLE = "\n".join([
    "# 记忆中枢架构",
    "",
    "总体介绍：本系统由检索层、判重层、存储层组成，目标是让多个智能体共享记忆。",
    "",
    "## 检索层",
    "",
    "### 混合召回",
    "",
    "检索层把 BM25、向量、图三条通道的结果用 RRF 融合。",
    "",
    FENCE + "python",
    "# 这一行里有个 # 号，但它不是 Markdown 标题",
    "def search(query, limit=10):",
    "    return rrf_fuse(bm25(query), vector(query))",
    FENCE,
    "",
    "融合公式如下：",
    "",
    "$$",
    r"score(d) = \sum_{i} \frac{w_i}{k + rank_i(d)}",
    "$$",
    "",
    "各通道默认权重：",
    "",
    "| 通道 | 权重 |",
    "| --- | --- |",
    "| bm25 | 1.0 |",
    "| vector | 1.0 |",
    "| graph | 0.6 |",
    "",
    "## 判重层",
    "",
    "判重层用 simhash、jaccard、cosine 三通道加权。",
    "",
    "### 阈值",
    "",
    "重复度 ≥0.92 自动合并，0.80–0.92 交判定层，<0.80 为新记忆。",
    "",
    "## 存储层",
    "",
    "SQLite 是事务真源，Markdown 是可读镜像。",
])


class TestMarkdownChunks(unittest.TestCase):
    def setUp(self):
        self.chunks = chunk_markdown(SAMPLE, max_tokens=900, overlap=120)

    def test_returns_expected_keys(self):
        for key in ("ordinal", "heading", "level", "text", "tokens",
                    "start_line", "end_line", "hash"):
            self.assertIn(key, self.chunks[0])

    def test_ordinals_contiguous(self):
        self.assertEqual([c["ordinal"] for c in self.chunks],
                         list(range(len(self.chunks))))

    def test_heading_path(self):
        paths = [c["heading"] for c in self.chunks]
        self.assertIn("# 记忆中枢架构", paths)
        self.assertIn("# 记忆中枢架构 > ## 检索层 > ### 混合召回", paths)
        self.assertIn("# 记忆中枢架构 > ## 判重层 > ### 阈值", paths)
        self.assertIn("# 记忆中枢架构 > ## 存储层", paths)
        self.assertEqual(self.chunks[-1]["level"], 2)

    def test_code_block_not_split(self):
        code = [c for c in self.chunks if FENCE + "python" in c["text"]]
        self.assertEqual(len(code), 1, "代码块必须恰好出现在一个 chunk 里")
        body = code[0]["text"]
        self.assertEqual(body.count(FENCE), 2, "开闭围栏都必须保留")
        self.assertIn("# 这一行里有个 # 号", body)
        self.assertIn("def search(query, limit=10):", body)
        self.assertIn("return rrf_fuse", body)

    def test_formula_block_not_split(self):
        formulas = [c for c in self.chunks if "$$" in c["text"]]
        self.assertEqual(len(formulas), 1)
        self.assertEqual(formulas[0]["text"].count("$$"), 2)
        self.assertIn("rank_i(d)", formulas[0]["text"])

    def test_table_kept_whole(self):
        tables = [c for c in self.chunks if "| bm25 |" in c["text"]]
        self.assertEqual(len(tables), 1)
        body = tables[0]["text"]
        for row in ("| 通道 | 权重 |", "| --- | --- |", "| vector | 1.0 |", "| graph | 0.6 |"):
            self.assertIn(row, body)

    def test_heading_inside_code_is_not_heading(self):
        self.assertNotIn("# 这一行里有个 # 号", self.chunks[0]["text"])
        for chunk in self.chunks:
            self.assertNotIn("# 这一行", chunk["heading"])

    def test_line_numbers(self):
        for chunk in self.chunks:
            self.assertGreaterEqual(chunk["start_line"], 1)
            self.assertGreaterEqual(chunk["end_line"], chunk["start_line"])
            self.assertLessEqual(chunk["end_line"], len(SAMPLE.split("\n")))
        code = [c for c in self.chunks if FENCE + "python" in c["text"]][0]
        lines = SAMPLE.split("\n")
        self.assertIn(FENCE + "python", lines[code["start_line"] - 1:code["end_line"]])

    def test_hash_stable_and_distinct(self):
        again = chunk_markdown(SAMPLE, max_tokens=900, overlap=120)
        self.assertEqual([c["hash"] for c in self.chunks], [c["hash"] for c in again])
        self.assertEqual(len({c["hash"] for c in self.chunks}), len(self.chunks))

    def test_tokens_match_estimate(self):
        for chunk in self.chunks:
            self.assertEqual(chunk["tokens"], estimate_tokens(chunk["text"]))

    def test_no_empty_chunks(self):
        for chunk in self.chunks:
            self.assertTrue(chunk["text"].strip())


class TestChunkSplitting(unittest.TestCase):
    def test_respects_max_tokens(self):
        para = "这是用来测试切块的句子。" * 200      # 2400 tokens
        chunks = chunk_markdown("# 大段落\n\n" + para, max_tokens=100, overlap=20)
        self.assertGreater(len(chunks), 1)
        for chunk in chunks:
            self.assertLessEqual(chunk["tokens"], 100,
                                 "普通段落必须遵守 max_tokens，实测 %d" % chunk["tokens"])

    def test_atomic_block_may_exceed_budget(self):
        big_code = "\n".join([FENCE + "python"] + ["x = %d" % i for i in range(300)]
                             + [FENCE])
        chunks = chunk_markdown("# 巨型代码\n\n" + big_code, max_tokens=50)
        code = [c for c in chunks if FENCE + "python" in c["text"]]
        self.assertEqual(len(code), 1, "超预算的代码块宁可整块保留，也不能切碎")

    def test_overlap_present(self):
        para = "".join("第%d句话讲述某个技术细节。" % i for i in range(120))
        chunks = chunk_markdown("# 长文\n\n" + para, max_tokens=60, overlap=20)
        self.assertGreater(len(chunks), 2)
        overlaps = 0
        for prev, cur in zip(chunks, chunks[1:]):
            tail = prev["text"][-12:]
            if tail and tail in cur["text"]:
                overlaps += 1
        self.assertGreater(overlaps, 0, "相邻块之间应有重叠内容")

    def test_empty_input(self):
        self.assertEqual(chunk_markdown(""), [])
        self.assertEqual(chunk_markdown("   \n\n  "), [])
        self.assertEqual(chunk_text(""), [])

    def test_headings_only_document(self):
        self.assertEqual(chunk_markdown("# 只有标题\n\n## 没有正文\n"), [])

    def test_nested_heading_paths(self):
        md = "\n".join(["# A", "", "a1", "", "## B", "", "b1", "", "### C", "", "c1",
                        "", "## D", "", "d1", "", "# E", "", "e1"])
        paths = [c["heading"] for c in chunk_markdown(md)]
        self.assertIn("# A", paths)
        self.assertIn("# A > ## B", paths)
        self.assertIn("# A > ## B > ### C", paths)
        self.assertIn("# A > ## D", paths, "同级标题应退栈，不能继承 C")
        self.assertIn("# E", paths)

    def test_setext_not_treated_as_heading(self):
        md = "标题\n===\n\n正文内容在这里。"
        chunks = chunk_markdown(md)
        self.assertTrue(chunks)
        self.assertEqual(chunks[0]["heading"], "")


class TestChunkText(unittest.TestCase):
    def test_plain_text_no_headings(self):
        text = ("第一段讲数据库并发问题。" * 40 + "\n\n" + "第二段讲向量检索。" * 40)
        chunks = chunk_text(text, max_tokens=60, overlap=10)
        self.assertGreater(len(chunks), 1)
        for chunk in chunks:
            self.assertEqual(chunk["heading"], "")
            self.assertEqual(chunk["level"], 0)

    def test_short_text_single_chunk(self):
        chunks = chunk_text("一句话的短文本。", max_tokens=900)
        self.assertEqual(len(chunks), 1)
        self.assertEqual(chunks[0]["text"], "一句话的短文本。")

    def test_code_preserved_in_chunk_text(self):
        text = FENCE + "bash\necho hi\n" + FENCE
        chunks = chunk_text(text, max_tokens=900)
        self.assertEqual(len(chunks), 1)
        self.assertIn("echo hi", chunks[0]["text"])

    def test_english_text(self):
        text = " ".join("Sentence number %d about retrieval systems." % i for i in range(200))
        chunks = chunk_text(text, max_tokens=80, overlap=15)
        self.assertGreater(len(chunks), 1)
        for chunk in chunks:
            self.assertLessEqual(chunk["tokens"], 90)


class TestSplitBlocks(unittest.TestCase):
    def test_kinds(self):
        blocks = split_blocks(SAMPLE)
        kinds = {b.kind for b in blocks}
        self.assertIn("heading", kinds)
        self.assertIn("code", kinds)
        self.assertIn("formula", kinds)
        self.assertIn("table", kinds)
        self.assertIn("para", kinds)

    def test_atomic_flags(self):
        blocks = split_blocks(SAMPLE)
        for block in blocks:
            if block.kind in ("code", "formula", "table"):
                self.assertTrue(block.atomic, "%s 必须标记 atomic" % block.kind)

    def test_unclosed_fence_consumes_rest(self):
        blocks = split_blocks("# T\n\n" + FENCE + "python\nno closing fence\nstill code")
        code = [b for b in blocks if b.kind == "code"]
        self.assertEqual(len(code), 1)
        self.assertIn("still code", code[0].text)


if __name__ == "__main__":
    unittest.main(verbosity=2)
