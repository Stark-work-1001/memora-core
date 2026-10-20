# -*- coding: utf-8 -*-
"""检索质量回归门槛：tools/eval_retrieval.py 在 memory-eval-v1 的 **dev** 集上跑默认检索。

dev 用来调参与守门，test 是留出集，只在发布时跑一次并写进 docs/retrieval.md：
    python tools/eval_retrieval.py --split test

门槛（离线 gw=None，数字全部可由上面的命令复现）：
  * 默认 hybrid 的 nDCG@10 ≥ DEV_NDCG_FLOOR（1.1.0 实测 0.625，留 0.01 余量）；1.0.0 是 0.397
  * 默认 hybrid 不比它自己的关键词部分差：≥ bm25、≥ substring、≥ bm25+substring
  * dev 上零结果率为 0；离线 hybrid 不含向量通道、不报 semantic
数据集按 README 里冻结的 SHA-256 校验；文件被改过则测试失败，而不是悄悄换了基准。

跑法：python -m unittest tests.test_retrieval_eval -v
"""
from __future__ import annotations

import importlib.util
import math
import sys
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

DATASET = ROOT / "old" / "datasets" / "memory-eval-v1"
DEV_NDCG_FLOOR = 0.615
EPS = 1e-9


def _load_harness():
    spec = importlib.util.spec_from_file_location("eval_retrieval",
                                                  str(ROOT / "tools" / "eval_retrieval.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


H = _load_harness()


class TestMetrics(unittest.TestCase):
    """指标是自己实现的，这里用手算的例子钉住定义。"""

    def test_graded_ndcg_recall_mrr(self):
        relevant = {"a": 2, "b": 1, "c": 0}
        got = H.query_metrics(["x", "a", "y", "b"], relevant, k=10)
        dcg = (2 ** 2 - 1) / math.log2(3) + (2 ** 1 - 1) / math.log2(5)
        idcg = (2 ** 2 - 1) / math.log2(2) + (2 ** 1 - 1) / math.log2(3)
        self.assertAlmostEqual(got["ndcg"], dcg / idcg, places=9)
        self.assertEqual(got["recall"], 1.0)          # grade 0 不算相关
        self.assertAlmostEqual(got["mrr"], 0.5)
        self.assertEqual(got["success"], 1.0)
        self.assertEqual(got["zero"], 0.0)

    def test_cutoff_and_empty(self):
        relevant = {"a": 1}
        self.assertEqual(H.query_metrics(["x"] * 10 + ["a"], relevant, k=10)["recall"], 0.0)
        empty = H.query_metrics([], relevant, k=10)
        self.assertEqual((empty["ndcg"], empty["zero"]), (0.0, 1.0))

    def test_percentile_nearest_rank(self):
        self.assertEqual(H.percentile([5, 1, 3, 2, 4], 0.5), 3)
        self.assertEqual(H.percentile([5, 1, 3, 2, 4], 0.95), 5)


@unittest.skipUnless((DATASET / "queries.jsonl").is_file(), "memory-eval-v1 不在仓库里")
class TestRetrievalQualityGate(unittest.TestCase):
    STRATEGIES = ["hybrid", "bm25", "substring", "bm25+substring"]

    @classmethod
    def setUpClass(cls):
        started = time.perf_counter()
        cls.check = H.check_dataset(DATASET)
        cls.report = H.evaluate(DATASET, "dev", cls.STRATEGIES)
        cls.seconds = time.perf_counter() - started

    def overall(self, name):
        return self.report["strategies"][name]["overall"]

    def test_dataset_is_the_frozen_one(self):
        self.assertIs(self.check["ok"], True, self.check["files"])
        self.assertEqual(self.report["queries"], 64)
        self.assertEqual(self.report["corpus"], 240)

    def test_default_ndcg_floor(self):
        ndcg = self.overall("hybrid")["ndcg"]
        print("\n[eval dev] %s  (%.1f s)" % ("  ".join(
            "%s nDCG@10=%.3f" % (name, self.overall(name)["ndcg"]) for name in self.STRATEGIES),
            self.seconds))
        self.assertGreaterEqual(ndcg, DEV_NDCG_FLOOR,
                                "默认检索 dev nDCG@10 %.3f 低于门槛 %.3f" % (ndcg, DEV_NDCG_FLOOR))

    def test_default_not_worse_than_its_keyword_parts(self):
        hybrid = self.overall("hybrid")["ndcg"]
        for part in ("bm25", "substring", "bm25+substring"):
            self.assertGreaterEqual(hybrid + EPS, self.overall(part)["ndcg"],
                                    "hybrid %.3f 比 %s %.3f 差" % (hybrid, part,
                                                                 self.overall(part)["ndcg"]))

    def test_no_zero_result_queries(self):
        self.assertEqual(self.overall("hybrid")["zero"], 0.0)

    def test_offline_default_reports_no_vector_channel(self):
        reported = self.report["strategies"]["hybrid"]["reported"]
        self.assertEqual(reported["channels_used"], ["bm25,substring,graph"])
        self.assertEqual(reported["vector_model"], ["None"])
        self.assertEqual(reported["semantic"], ["False"])

    def test_runs_quickly(self):
        self.assertLess(self.seconds, 30.0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
