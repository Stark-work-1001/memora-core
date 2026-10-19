# -*- coding: utf-8 -*-
"""判重层自测：simhash / jaccard / 三通道打分 / 10 组动作决策 / 邻居检索。

跑法：
    python -m unittest tests.test_dedup -v
"""
from __future__ import annotations

import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from memora_core import db as D
from memora_core import dedup as Dd
from memora_core.vectors import hash_embed


def _text(item):
    return "\n".join(p for p in (item.get("title") or "", item.get("body") or "") if p)


def score_into(neighbor, scored):
    merged = dict(neighbor)
    merged.update({k: scored[k] for k in ("dup", "cos", "jac", "ham", "band")})
    return merged


class TestFingerprints(unittest.TestCase):
    def test_simhash_deterministic(self):
        a = Dd.simhash64("数据库使用 WAL 模式保证并发读写")
        self.assertEqual(a, Dd.simhash64("数据库使用 WAL 模式保证并发读写"))
        self.assertIsInstance(a, int)
        self.assertGreaterEqual(a, 0)
        self.assertLess(a, 1 << 64)

    def test_simhash_empty(self):
        self.assertEqual(Dd.simhash64(""), 0)

    def test_hamming(self):
        self.assertEqual(Dd.hamming(0, 0), 0)
        self.assertEqual(Dd.hamming(0, 0b1111), 4)
        self.assertEqual(Dd.hamming(0b1010, 0b0101), 4)
        self.assertEqual(Dd.hamming(0xFFFFFFFFFFFFFFFF, 0), 64)

    def test_near_duplicate_low_hamming(self):
        a = Dd.simhash64("数据库使用 WAL 模式保证并发读写性能")
        b = Dd.simhash64("数据库使用 WAL 模式保证并发读写性能。")
        c = Dd.simhash64("今天天气不错适合出门散步")
        self.assertLessEqual(Dd.hamming(a, b), 3)
        self.assertGreater(Dd.hamming(a, c), 10)

    def test_shingles_and_jaccard(self):
        s = Dd.shingles("数据库使用 WAL 模式")
        self.assertTrue(all(len(x) == 5 for x in s))
        self.assertEqual(Dd.jaccard("数据库使用 WAL 模式", "数据库使用 WAL 模式"), 1.0)
        self.assertEqual(Dd.jaccard("", "abc"), 0.0)
        self.assertEqual(Dd.jaccard({"a", "b"}, {"a", "b"}), 1.0)
        self.assertEqual(Dd.jaccard({"a"}, {"b"}), 0.0)
        self.assertAlmostEqual(Dd.jaccard({"a", "b"}, {"b", "c"}), 1 / 3, places=6)

    def test_shingles_short_text(self):
        self.assertEqual(Dd.shingles("ab"), {"ab"})

    def test_score_pair_shape_and_formula(self):
        a = "数据库使用 WAL 模式保证并发读写"
        b = "数据库采用 WAL 模式以保证并发读写"
        out = Dd.score_pair(a, b)
        for key in ("cos", "jac", "ham", "dup", "band"):
            self.assertIn(key, out)
        expected = (0.5 * out["cos"] + 0.3 * out["jac"]
                    + 0.2 * (1 - out["ham"] / 64.0))
        self.assertAlmostEqual(out["dup"], round(expected, 6), places=5)
        self.assertIn(out["band"], ("merge", "judge", "new"))

    def test_band_thresholds(self):
        self.assertEqual(Dd.score_pair("同一个句子", "同一个句子")["band"], "merge")
        self.assertEqual(Dd.score_pair("完全无关的甲", "彻底不同的乙丙丁戊")["band"], "new")

    def test_identical_pair_full_score(self):
        out = Dd.score_pair("数据库使用 WAL 模式", "数据库使用 WAL 模式")
        self.assertAlmostEqual(out["dup"], 1.0, places=6)
        self.assertEqual(out["ham"], 0)


class TestConflict(unittest.TestCase):
    def test_polarity_flip(self):
        out = Dd.conflict_score("SQLite 不使用 WAL 模式", "SQLite 使用 WAL 模式")
        self.assertGreaterEqual(out["polarity_flip"], 1.0)
        self.assertGreater(out["score"], 0.3)

    def test_numeric_conflict(self):
        out = Dd.conflict_score("默认端口是 8790", "默认端口是 9000")
        self.assertGreaterEqual(out["numeric_conflict"], 1.0)

    def test_no_conflict_on_unrelated(self):
        out = Dd.conflict_score("前端使用 esbuild", "今天天气不错")
        self.assertLess(out["score"], 0.2)

    def test_formula_weights(self):
        out = Dd.conflict_score("SQLite 不使用 WAL 模式", "SQLite 使用 WAL 模式")
        expected = (0.4 * out["entity_overlap"] + 0.35 * out["polarity_flip"]
                    + 0.25 * out["numeric_conflict"])
        self.assertAlmostEqual(out["score"], round(expected, 6), places=5)


# ---------------------------------------------------------------------------
# 10 组动作决策样本
# ---------------------------------------------------------------------------

OLD = {
    "id": "m_old",
    "title": "数据库并发配置",
    "body": "SQLite 使用 WAL 模式保证并发读写性能，读不阻塞写。",
    "trust": 0.6,
    "confidence": 0.6,
    "source_count": 1,
}

CASES = [
    # (名称, 候选, 期望动作)
    ("①完全重复",
     {"title": "数据库并发配置", "body": "SQLite 使用 WAL 模式保证并发读写性能，读不阻塞写。"},
     "noop"),
    ("②同义改写（中文）",
     {"title": "数据库并发配置", "body": "SQLite 采用 WAL 模式来保证并发读写的性能，读操作不会阻塞写操作。"},
     "merge"),
    ("③同义改写（英文）",
     {"title": "Database concurrency", "body":
      "SQLite uses WAL mode to guarantee concurrent read and write performance."},
     "add"),   # 与中文旧记忆不同语言 → 应视为新记忆（不做跨语言误合并）
    ("④互补信息",
     {"title": "数据库并发配置", "body":
      "SQLite 用 WAL 模式，读不阻塞写、写不阻塞读，适合读多写少的业务场景。"},
     "merge"),
    ("⑤冲突且证据不足",
     {"title": "数据库并发配置", "body": "SQLite 不使用 WAL 模式，无法保证并发读写性能。"},
     "ask"),
    ("⑥冲突但新证据更强",
     {"title": "数据库并发配置", "body": "SQLite 不使用 WAL 模式，无法保证并发读写性能。",
      "trust": 0.95, "confidence": 0.9, "source_count": 4},
     "supersede"),
    ("⑦完全无关",
     {"title": "前端构建", "body": "前端使用 esbuild 打包 TypeScript 产物。"},
     "add"),
    ("⑧相关但独立",
     {"title": "数据库备份", "body": "WAL 模式下需要用 sqlite3 的 backup API 做一致性备份。"},
     "link"),
    ("⑨更新覆盖",
     {"title": "数据库并发配置", "body":
      "SQLite 现在改为使用 WAL2 模式保证并发读写性能，读不阻塞写。"},
     "supersede"),
    ("⑩无关的英文新主题",
     {"title": "Cooking notes", "body": "Pasta needs salted boiling water and olive oil."},
     "add"),
]


class TestDecideAction(unittest.TestCase):
    def test_ten_samples_accuracy(self):
        rows = []
        correct = 0
        for name, candidate, expect in CASES:
            scored = Dd.score_pair(_text(candidate), _text(OLD))
            neighbors = [score_into(OLD, scored)]
            decision = Dd.decide_action(candidate, neighbors)
            ok = decision["action"] == expect
            correct += 1 if ok else 0
            rows.append((name, decision["action"], expect, ok, decision["dup"],
                         decision["reason"]))
        print("\n[判重决策] 样本准确率 %d/%d" % (correct, len(CASES)))
        for name, got, expect, ok, dup, reason in rows:
            print("  %s %-14s got=%-9s expect=%-9s dup=%.3f  %s"
                  % ("PASS" if ok else "FAIL", name, got, expect, dup, reason[:44]))
        self.assertGreaterEqual(correct, 9, "决策准确率必须 ≥9/10，实测 %d/10" % correct)

    def test_no_neighbors_is_add(self):
        out = Dd.decide_action({"title": "全新主题", "body": "全新内容"}, [])
        self.assertEqual(out["action"], "add")
        self.assertIsNone(out["target_id"])

    def test_empty_candidate(self):
        out = Dd.decide_action({"title": "", "body": ""}, [])
        self.assertEqual(out["action"], "ask")
        self.assertIn("空", out["reason"])

    def test_target_id_points_at_neighbor(self):
        scored = Dd.score_pair(_text(CASES[0][1]), _text(OLD))
        out = Dd.decide_action(CASES[0][1], [score_into(OLD, scored)])
        self.assertEqual(out["target_id"], "m_old")

    def test_signals_present(self):
        scored = Dd.score_pair(_text(CASES[1][1]), _text(OLD))
        out = Dd.decide_action(CASES[1][1], [score_into(OLD, scored)])
        for key in ("dup", "cos", "jac", "ham", "topic_overlap", "shared_terms",
                    "uniq_new", "uniq_old", "novelty_new", "novelty_old",
                    "conflict", "new_covers_old", "old_covers_new", "update_word",
                    "evidence_new", "evidence_old"):
            self.assertIn(key, out["signals"])
        self.assertIn("band", out)
        self.assertIn("confidence", out)

    def test_all_actions_reachable(self):
        seen = set()
        for _name, candidate, _expect in CASES:
            scored = Dd.score_pair(_text(candidate), _text(OLD))
            seen.add(Dd.decide_action(candidate, [score_into(OLD, scored)])["action"])
        for action in ("noop", "merge", "add", "ask", "supersede", "link"):
            self.assertIn(action, seen, "动作 %s 在这 10 组样本里未被覆盖" % action)

    def test_explicit_supersede_hint(self):
        scored = Dd.score_pair(_text(CASES[1][1]), _text(OLD))
        candidate = dict(CASES[1][1])
        candidate["supersedes"] = "m_old"
        out = Dd.decide_action(candidate, [score_into(OLD, scored)])
        self.assertIn(out["action"], ("merge", "supersede"))


# ---------------------------------------------------------------------------
# 邻居检索（真实 SQLite）
# ---------------------------------------------------------------------------

class TestFindDuplicates(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="memora_dedup_"))
        cls.db_path = cls.tmp / "memora.db"
        D.init_db(cls.db_path)
        cls.con = D.connect(cls.db_path)
        rows = [
            ("d1", "数据库并发配置", "SQLite 使用 WAL 模式保证并发读写性能，读不阻塞写。"),
            ("d2", "前端构建", "前端使用 esbuild 打包 TypeScript 产物。"),
            ("d3", "数据库备份", "WAL 模式下需要用 sqlite3 的 backup API 做一致性备份。"),
            ("d4", "数据库迁移", "升级 schema 版本时需要写迁移脚本并做兼容处理。"),
        ]
        cls.con.executemany(
            "INSERT INTO memory(id, scope_id, kind, title, body, status, trust, importance,"
            " recorded_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
            [(mid, "global", "fact", title, body, "approved", 0.8, 0.5,
              "2025-01-01T00:00:00Z", "2025-01-01T00:00:00Z") for mid, title, body in rows])

    @classmethod
    def tearDownClass(cls):
        try:
            cls.con.close()
        finally:
            shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_finds_exact_duplicate(self):
        found = Dd.find_duplicates(self.con, {
            "title": "数据库并发配置",
            "body": "SQLite 使用 WAL 模式保证并发读写性能，读不阻塞写。"}, limit=5)
        self.assertTrue(found)
        self.assertEqual(found[0]["id"], "d1")
        self.assertGreaterEqual(found[0]["dup"], 0.92)
        self.assertIn(found[0]["band"], ("merge", "judge"))

    def test_sorted_by_dup_desc(self):
        found = Dd.find_duplicates(self.con, {
            "title": "数据库并发配置",
            "body": "SQLite 采用 WAL 模式保证并发读写性能"}, limit=5)
        dups = [item["dup"] for item in found]
        self.assertEqual(dups, sorted(dups, reverse=True))

    def test_unrelated_returns_low_scores(self):
        found = Dd.find_duplicates(self.con, {
            "title": "烹饪笔记", "body": "意大利面需要加盐的沸水和橄榄油。"}, limit=5)
        for item in found:
            self.assertLess(item["dup"], 0.8)

    def test_empty_candidate_returns_nothing(self):
        self.assertEqual(Dd.find_duplicates(self.con, {"title": "", "body": ""}), [])

    def test_result_carries_context(self):
        found = Dd.find_duplicates(self.con, {
            "title": "数据库并发配置",
            "body": "SQLite 使用 WAL 模式保证并发读写性能，读不阻塞写。"}, limit=5)
        for key in ("id", "title", "dup", "cos", "jac", "ham", "band", "status"):
            self.assertIn(key, found[0])

    def test_does_not_match_itself(self):
        found = Dd.find_duplicates(self.con, {
            "id": "d1", "title": "数据库并发配置",
            "body": "SQLite 使用 WAL 模式保证并发读写性能，读不阻塞写。"}, limit=10)
        self.assertNotIn("d1", [item["id"] for item in found])

    def test_apply_decision_writes_candidate(self):
        decision = {"action": "ask", "reason": "测试", "target_id": "d1",
                    "signals": {"dup": 0.9}, "confidence": 0.4}
        out = Dd.apply_decision(self.con, {"title": "测试候选", "body": "测试候选内容",
                                           "scope_id": "global"}, decision)
        self.assertTrue(out["ok"])
        self.assertEqual(out["status"], "needs_review")
        row = self.con.execute("SELECT action, status FROM candidate WHERE id=?",
                               (out["id"],)).fetchone()
        self.assertEqual(tuple(row), ("ask", "needs_review"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
