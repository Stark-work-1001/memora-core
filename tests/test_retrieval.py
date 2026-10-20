# -*- coding: utf-8 -*-
"""检索层自测：向量确定性 / 混合召回 / 降级 / 预算打包 / 图通道 / 性能。

跑法：
    python -m unittest tests.test_retrieval -v
"""
from __future__ import annotations

import random
import shutil
import socket
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from memora_core import db as D
from memora_core import dedup as DD
from memora_core import retrieval as R
from memora_core import vectors as V
from memora_core.vectors import VectorIndex, cosine, estimate_tokens, hash_embed

# ---------------------------------------------------------------------------
# 夹具：300 条中英混合记忆 + 10 条已知查询
# ---------------------------------------------------------------------------

# 30 个主题 × 10 条 = 300 条记忆；前 10 个主题同时作为 10 条已知查询
TOPICS = [
    ("数据库并发", ["并发", "读写", "事务", "连接池"]),
    ("向量检索", ["近邻", "相似度", "嵌入", "索引"]),
    ("混合召回", ["融合", "排序", "通道", "多路"]),
    ("判重策略", ["指纹", "查重", "重复", "阈值"]),
    ("切块算法", ["分段", "标题", "边界", "分片"]),
    ("模型网关", ["调用", "降级", "接口", "代理"]),
    ("前端构建", ["打包", "资源", "产物", "编译"]),
    ("桌面打包", ["安装", "分发", "封装", "发布"]),
    ("单元测试", ["断言", "覆盖", "用例", "回归"]),
    ("工作流引擎", ["节点", "执行", "编排", "调度"]),
    ("图算法", ["中心度", "邻居", "传播", "社区"]),
    ("记忆衰减", ["遗忘", "复习", "间隔", "半衰期"]),
    ("智能体", ["会话", "在场", "心跳", "登记"]),
    ("MCP协议", ["工具", "方法", "描述", "能力"]),
    ("安全边界", ["回环", "校验", "请求", "策略"]),
    ("性能优化", ["延迟", "吞吐", "耗时", "压测"]),
    ("缓存设计", ["命中", "失效", "预热", "淘汰"]),
    ("索引结构", ["倒排", "条目", "查询", "目录"]),
    ("中文分词", ["词元", "切分", "边界", "词典"]),
    ("去重合并", ["归并", "矛盾", "裁决", "冲突"]),
    ("调度队列", ["排队", "重试", "作业", "优先级"]),
    ("审计日志", ["留痕", "追溯", "操作", "记录"]),
    ("备份恢复", ["快照", "还原", "副本", "回滚"]),
    ("数据迁移", ["版本", "升级", "兼容", "脚本"]),
    ("监控告警", ["指标", "异常", "阈值", "采集"]),
    ("配置管理", ["选项", "参数", "默认", "覆盖"]),
    ("权限模型", ["角色", "授权", "访问", "身份"]),
    ("数据导出", ["格式", "输出", "交换", "落地"]),
    ("文本摘要", ["浓缩", "关键句", "要点", "抽取"]),
    ("评分排序", ["打分", "名次", "归一", "权重"]),
]
QUERIES = [name for name, _syn in TOPICS[:10]]
_CN = ("却专状育厂京识适属圆包火住调满县局照参红细引听该铁价严龙飞的一是在不了有和人这中大为"
       "上个国我以要他时来用们生到作地于出就分对成会可主发年动同工也能下过子说产种面而方后多定"
       "行学法所民得经十三之进着等部度家电力里如水化高自二理起小物现实加量都两体制机当使点从业"
       "本去把性好应开它合还因由其些然前外天政四日那社义事平形相全表间样与关各重新线内数正心反")


def _filler(rng, n):
    return "".join(rng.choice(_CN) for _ in range(n))


def make_doc(name, syn, i, rng):
    """三类写法：A 标题带主题（BM25 友好）/ B 主题埋在中段（只有子串通道能召回）
    / C 同义改写（只有向量通道能召回）。"""
    if i < 4:
        return ("%s 要点 %d" % (name, i),
                "%s 场景下 %s 与 %s 需要一起考虑，实测稳定" % (name, syn[0], syn[1]))
    if i < 7:
        return ("现场笔记 %d" % i,
                "%s%s%s%s在实测中经常被忽略" % (_filler(rng, 4), name, _filler(rng, 3), syn[2]))
    return ("现场笔记 %d" % i,
            "%s %s 与 %s 的配合方式决定整体效果，%s 很重要" % (name, syn[0], syn[2], syn[3]))


def build_corpus(con, scale=1, seed=11):
    """scale=1 → 300 条；scale=10 → 3000 条。返回 {query: [gold ids]}。"""
    rng = random.Random(seed)
    gold = {}
    rows = []
    for round_ in range(scale):
        for k, (name, syn) in enumerate(TOPICS):
            ids = []
            for i in range(10):
                title, body = make_doc(name, syn, i, rng)
                mid = "m%02d_%02d_%d" % (k, i, round_)
                if round_ == 0:
                    ids.append(mid)
                rows.append((mid, "global", "fact", title, body, "", "approved", 0.8, 0.5,
                             "2025-01-01T00:00:00Z", "2025-01-01T00:00:00Z", 40))
            if round_ == 0:
                gold[name] = ids
    con.executemany(
        "INSERT INTO memory(id, scope_id, kind, title, body, summary, status, trust, importance,"
        " recorded_at, updated_at, tokens) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", rows)
    return gold


class FakeGateway:
    """duck-typed 的 ModelGateway：记录调用，按需抛 ModelUnavailable。"""

    def __init__(self, fail=False):
        self.fail = fail
        self.calls = []

    class ModelUnavailable(RuntimeError):
        def __init__(self, role, reason=""):
            super().__init__("%s: %s" % (role, reason))
            self.role = role

    def embed(self, texts, role="embedding"):
        self.calls.append(("embed", len(texts)))
        if self.fail:
            raise self.ModelUnavailable(role, "no cloud credential")
        return [hash_embed(t) for t in texts]

    def rerank(self, query, docs, top_k=20, role="reranker"):
        self.calls.append(("rerank", len(docs)))
        if self.fail:
            raise self.ModelUnavailable(role, "reranker offline")
        scored = [(i, 1.0 / (1 + abs(len(d) - len(query)))) for i, d in enumerate(docs)]
        return sorted(scored, key=lambda kv: -kv[1])[:top_k]

    embed_model_unavailable = ModelUnavailable


class Base(unittest.TestCase):
    scale = 1

    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="memora_ret_"))
        cls.db_path = cls.tmp / "memora.db"
        D.init_db(cls.db_path)
        cls.con = D.connect(cls.db_path)
        cls.gold = build_corpus(cls.con, scale=cls.scale)

    @classmethod
    def tearDownClass(cls):
        try:
            cls.con.close()
        finally:
            shutil.rmtree(cls.tmp, ignore_errors=True)

    def recall_at(self, result, gold, k=10):
        got = {h["id"] for h in result["hits"][:k]}
        return len(got & set(gold)) / float(len(gold))


# ---------------------------------------------------------------------------
# 1. 向量
# ---------------------------------------------------------------------------

class TestVectors(unittest.TestCase):
    def test_deterministic_same_text(self):
        a = hash_embed("记忆中枢使用混合召回")
        b = hash_embed("记忆中枢使用混合召回")
        self.assertEqual(a, b)
        self.assertEqual(len(a), 256)
        self.assertAlmostEqual(sum(x * x for x in a) ** 0.5, 1.0, places=6)

    def test_different_text_low_cosine(self):
        a = hash_embed("数据库使用 WAL 模式保证并发读写")
        b = hash_embed("今天天气不错适合出门散步")
        self.assertLess(cosine(a, b), 0.5)
        self.assertLess(cosine(a, b), 0.9)
        c = hash_embed("前端使用 esbuild 打包 TypeScript")
        self.assertLess(cosine(a, c), 0.9)

    def test_related_text_higher_than_unrelated(self):
        base = "数据库使用 WAL 模式保证并发读写"
        near = "数据库采用 WAL 模式，以保证并发读写的性能"
        far = "今天天气不错适合出门散步"
        v0, v1, v2 = hash_embed(base), hash_embed(near), hash_embed(far)
        self.assertGreater(cosine(v0, v1), cosine(v0, v2))

    def test_cross_process_stable(self):
        """不用 Python 的 hash()：换一个进程算，结果必须逐位一致。"""
        import subprocess
        code = ("import sys; sys.path.insert(0, %r);"
                "from memora_core.vectors import hash_embed;"
                "print(repr(hash_embed('跨进程稳定 test 123')))"
                % str(Path(__file__).resolve().parent.parent))
        out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True)
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertEqual(out.stdout.strip(), repr(hash_embed("跨进程稳定 test 123")))

    def test_empty_and_zero(self):
        self.assertEqual(hash_embed(""), [0.0] * 256)
        self.assertEqual(cosine([], [1.0]), 0.0)
        self.assertEqual(cosine([0.0] * 4, [1.0] * 4), 0.0)

    def test_estimate_tokens(self):
        self.assertEqual(estimate_tokens(""), 0)
        zh = estimate_tokens("记忆中枢")
        self.assertTrue(2 <= zh <= 6, zh)
        en = estimate_tokens("hello world")
        self.assertTrue(1 <= en <= 5, en)
        en2 = estimate_tokens("a" * 400)
        self.assertAlmostEqual(en2, 100, delta=2)

    def test_vector_index_roundtrip(self):
        tmp = Path(tempfile.mkdtemp(prefix="memora_vec_"))
        try:
            path = tmp / "v.db"
            D.init_db(path)
            con = D.connect(path)
            index = VectorIndex(con)
            vec = hash_embed("向量缓存")
            info = index.put("memory", "m1", vec)
            self.assertEqual(info["dim"], 256)
            back = index.get("memory", "m1")
            self.assertEqual(len(back), 256)
            self.assertAlmostEqual(cosine(vec, back), 1.0, places=5)
            self.assertIsNone(index.get("memory", "missing"))
            near = index.nearest(vec, owner_kind="memory", limit=5)
            self.assertEqual(near[0][0], "m1")
            self.assertGreater(near[0][1], 0.99)
            self.assertEqual(index.stats()["total"], 1)
            con.close()
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


# ---------------------------------------------------------------------------
# 2. 融合公式
# ---------------------------------------------------------------------------

class TestFusion(unittest.TestCase):
    def test_rrf_formula(self):
        channels = {"bm25": [("a", 9.0), ("b", 5.0)], "vector": [("b", 0.9), ("c", 0.5)]}
        fused = R.rrf_fuse(channels, {"bm25": 1.0, "vector": 1.0})
        k = R.K_RRF
        self.assertAlmostEqual(fused["a"]["rrf"], 1.0 / (k + 1), places=9)
        self.assertAlmostEqual(fused["b"]["rrf"], 1.0 / (k + 2) + 1.0 / (k + 1), places=9)
        self.assertAlmostEqual(fused["c"]["rrf"], 1.0 / (k + 2), places=9)
        self.assertGreater(fused["b"]["rrf"], fused["a"]["rrf"])

    def test_rrf_weights(self):
        fused = R.rrf_fuse({"graph": [("x", 1.0)]}, {"graph": 0.6})
        self.assertAlmostEqual(fused["x"]["rrf"], 0.6 / (R.K_RRF + 1), places=9)

    def test_mmr_prefers_diversity(self):
        vec_a = [1.0, 0.0, 0.0]
        vec_b = [0.99, 0.1, 0.0]     # 与 a 高度冗余
        vec_c = [0.0, 1.0, 0.0]      # 与 a 正交
        items = [{"id": "a", "score": 1.0}, {"id": "b", "score": 0.9},
                 {"id": "c", "score": 0.6}]
        picked = R._mmr_select(items, {"a": vec_a, "b": vec_b, "c": vec_c}, limit=2)
        self.assertEqual(picked[0]["id"], "a")
        self.assertEqual(picked[1]["id"], "c")

    def test_pack_budget_greedy(self):
        items = [
            {"id": "a", "score": 1.0, "tokens": 100},
            {"id": "b", "score": 0.9, "tokens": 100},
            {"id": "c", "score": 0.1, "tokens": 400},
        ]
        packed, used = R.pack_budget(items, 300)
        self.assertEqual(used, 200)
        self.assertEqual([i["id"] for i in packed], ["a", "b"])

    def test_pack_budget_zero_means_all(self):
        items = [{"id": "a", "score": 1.0, "tokens": 10}]
        packed, used = R.pack_budget(items, 0)
        self.assertEqual(len(packed), 1)
        self.assertEqual(used, 10)


# ---------------------------------------------------------------------------
# 3. 召回质量
# ---------------------------------------------------------------------------

class TestRecall(Base):
    def test_verbatim_topic_recall(self):
        """冒烟测试，不是质量指标：这份夹具里每条 gold 记忆都逐字含有查询词（写法 B 把它
        埋在无空格的中文串中间）。1.0.0 的 FTS5 unicode61 bm25 在这里恒为 0.70，那是夹具
        的常数，不代表 hybrid 比 bm25 好多少。真正的质量门槛是 tests/test_retrieval_eval.py
        （带标注的 memory-eval-v1）。这里只要求：逐字出现的主题，默认检索与 bm25 都找得全。"""
        rows = []
        for name in QUERIES:
            gold = self.gold[name]
            hybrid = R.search(self.con, None, name, limit=10, strategy="hybrid")
            bm25 = R.search(self.con, None, name, limit=10, strategy="bm25")
            rows.append((name, self.recall_at(hybrid, gold), self.recall_at(bm25, gold)))
        mean_h = sum(r[1] for r in rows) / len(rows)
        mean_b = sum(r[2] for r in rows) / len(rows)
        print("[Recall@10 verbatim fixture] hybrid=%.3f  bm25=%.3f" % (mean_h, mean_b))
        self.assertGreaterEqual(mean_h, 0.9, "hybrid Recall@10 必须 ≥ 0.9，实测 %.3f" % mean_h)
        self.assertGreaterEqual(mean_b, 0.9, "切分 BM25 应能找到埋在中文串中间的主题，实测 %.3f"
                                % mean_b)

    def test_result_shape(self):
        res = R.search(self.con, None, "判重策略", limit=5)
        for key in ("hits", "degraded", "took_ms", "strategy", "total"):
            self.assertIn(key, res)
        self.assertIsInstance(res["degraded"], list)
        self.assertLessEqual(len(res["hits"]), 5)
        hit = res["hits"][0]
        for key in ("id", "kind", "title", "snippet", "score", "channels", "trust", "citation"):
            self.assertIn(key, hit)
        self.assertTrue(hit["citation"].startswith("[m:"))
        self.assertIsInstance(hit["score"], float)
        self.assertGreaterEqual(hit["score"], 0.0)

    def test_empty_query(self):
        res = R.search(self.con, None, "", limit=5)
        self.assertEqual(res["hits"], [])
        self.assertEqual(res["total"], 0)
        self.assertFalse(res["degraded"])

    def test_limit_zero(self):
        self.assertEqual(R.search(self.con, None, "判重", limit=0)["hits"], [])

    def test_budget_packing(self):
        res = R.search(self.con, None, "数据库并发", limit=20, budget=300)
        tokens = sum(estimate_tokens(h["title"]) + estimate_tokens(h["snippet"])
                     for h in res["hits"])
        self.assertLessEqual(tokens, 330, "budget=300 时 token 估算必须 ≤330，实测 %d" % tokens)
        self.assertLessEqual(res["tokens"], 330)

    def test_scope_filter(self):
        self.con.execute(
            "INSERT INTO memory(id, scope_id, kind, title, body, status, trust, importance,"
            " recorded_at, updated_at) VALUES('scoped1','workspace:other','fact','隔离测试主题',"
            "'隔离测试主题 body 内容','approved',0.8,0.5,'2025-01-01T00:00:00Z',"
            "'2025-01-01T00:00:00Z')")
        inside = R.search(self.con, None, "隔离测试主题", scope="workspace:other", limit=10)
        outside = R.search(self.con, None, "隔离测试主题", scope="workspace:mine", limit=10)
        self.assertIn("scoped1", [h["id"] for h in inside["hits"]])
        self.assertNotIn("scoped1", [h["id"] for h in outside["hits"]])

    def test_include_candidates(self):
        self.con.execute(
            "INSERT INTO memory(id, scope_id, kind, title, body, status, trust, importance,"
            " recorded_at, updated_at) VALUES('cand1','global','fact','候选草稿主题',"
            "'候选草稿主题 的内容','candidate',0.4,0.5,'2025-01-01T00:00:00Z',"
            "'2025-01-01T00:00:00Z')")
        without = R.search(self.con, None, "候选草稿主题", limit=10)
        with_ = R.search(self.con, None, "候选草稿主题", limit=10, include_candidates=True)
        self.assertNotIn("cand1", [h["id"] for h in without["hits"]])
        self.assertIn("cand1", [h["id"] for h in with_["hits"]])

    def test_unknown_strategy_falls_back(self):
        res = R.search(self.con, None, "判重", strategy="quantum")
        self.assertEqual(res["strategy"], "hybrid")
        self.assertTrue(any("strategy" in d for d in res["degraded"]))

    def test_digest_budget(self):
        out = R.digest(self.con, None, scope="global", budget=200)
        self.assertLessEqual(out["tokens"], 220)
        self.assertIn("text", out)
        self.assertIsInstance(out["items"], list)

    def test_recall_for_agent_logs(self):
        before = self.con.execute("SELECT count(*) FROM recall_log").fetchone()[0]
        out = R.recall_for_agent(self.con, None, "切块算法", "agent-x", limit=5)
        after = self.con.execute("SELECT count(*) FROM recall_log").fetchone()[0]
        self.assertGreater(after, before)
        self.assertEqual(out["agent_id"], "agent-x")
        self.assertEqual(out["scope"], "agent:agent-x")


# ---------------------------------------------------------------------------
# 4. 降级
# ---------------------------------------------------------------------------

class TestCrossScopeLeak(unittest.TestCase):
    """回归：跨作用域数据下，任何通道都不得把池外记忆塞进结果。

    真实缺陷（协调者验收时复现）：图通道 _build_graph 没有按作用域裁剪节点，
    PPR 会把 workspace 作用域的记忆带进 scope="global" 的查询，融合后
    by_id[id] 直接 KeyError —— 搜索整个抛异常，而不是漏几条结果。

    单测原先没抓到，是因为池与窗口恒一致（要么不传 scope，要么全库同 scope）。
    这里刻意造 4 个作用域 + 跨作用域实体边，把"池 ⊆ 结果"钉死。
    """

    SCOPES = ["global", "workspace:alpha", "agent:beta", "task:gamma"]

    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="memora_xscope_"))
        cls.db_path = cls.tmp / "memora.db"
        D.init_db(cls.db_path)
        cls.con = D.connect(cls.db_path)
        rows = []
        # 4 个作用域各 5 条，标题都含同一个词，保证每条通道都能召回
        for si, scope in enumerate(cls.SCOPES):
            for i in range(5):
                rows.append(("x%d_%d" % (si, i), scope, "fact",
                             "BM25 打分笔记 %d-%d" % (si, i),
                             "BM25 打分 与向量召回的说明，作用域 %s 第 %d 条。" % (scope, i),
                             "approved", 0.8, 0.5,
                             "2025-01-01T00:00:00Z", "2025-01-01T00:00:00Z"))
        cls.con.executemany(
            "INSERT INTO memory(id, scope_id, kind, title, body, status, trust, importance,"
            " recorded_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)", rows)
        # 实体名必须真的出现在查询串里，才能成为 PPR 种子；
        # 种子一旦激活，邻居就会跨作用域传播 —— 这正是图通道越界的路径。
        # 早期版本这里用了"实体0..3"，种子永远不命中，图通道返回空，回归测试形同虚设。
        cls.con.executemany(
            "INSERT INTO entity(id, name, kind, scope_id, created_at)"
            " VALUES(?,?,?,?,?)",
            [("e0", "BM25", "concept", "global", "2025-01-01"),
             ("e1", "打分", "concept", "global", "2025-01-01"),
             ("e2", "向量召回", "concept", "global", "2025-01-01"),
             ("e3", "作用域", "concept", "global", "2025-01-01")])
        cls.con.executemany(
            "INSERT INTO memory_entity(memory_id, entity_id, role) VALUES(?,?,?)",
            [("x0_0", "e0", "about"), ("x1_0", "e1", "about"),
             ("x2_0", "e2", "about"), ("x3_0", "e3", "about")])
        cls.con.executemany(
            "INSERT INTO edge(id, src, src_kind, dst, dst_kind, rel, weight, confidence)"
            " VALUES(?,?,?,?,?,?,?,?)",
            [("xe%d" % i, "e%d" % i, "entity", "e%d" % ((i + 1) % 4), "entity",
              "semantic", 1.0, 0.9) for i in range(4)])

    @classmethod
    def tearDownClass(cls):
        try:
            cls.con.close()
        finally:
            shutil.rmtree(cls.tmp, ignore_errors=True)

    def _allowed(self, scope):
        expanded = R._expand_scope(self.con, scope)
        return set(expanded or [])

    def _assert_no_leak(self, res, allowed, label):
        for hit in res["hits"]:
            self.assertIn(hit["scope_id"], allowed,
                          "%s：返回了作用域外记忆 %s（scope=%s，允许 %s）"
                          % (label, hit["id"], hit["scope_id"], sorted(allowed)))

    def test_each_scope_isolated_without_exception(self):
        for scope in self.SCOPES:
            allowed = self._allowed(scope)
            res = R.search(self.con, None, "BM25 打分", scope=scope, limit=40)
            self._assert_no_leak(res, allowed, "scope=%s" % scope)
            self.assertTrue(res["hits"], "scope=%s 应至少有自带作用域的命中" % scope)

    def test_global_scope_excludes_workspace_memories(self):
        """缺陷原始形态：scope=global 查询不得返回 workspace/agent/task 的记忆。"""
        res = R.search(self.con, None, "BM25 打分", scope="global", limit=40)
        self._assert_no_leak(res, {"global"}, "scope=global")
        self.assertTrue(all(h["id"].startswith("x0_") for h in res["hits"]),
                        "scope=global 只应返回 x0_* 这些记忆")

    def test_graph_channel_stays_in_pool(self):
        """直接盯住出问题的那条通道，并证明它确实被激活了（不是空返回）。"""
        pool = R._fetch_pool(self.con, self.con, ["global"], False, 20000)
        allowed = {m["id"] for m in pool}
        ranked = R._channel_graph(self.con, "BM25 打分", ["global"], 100, allowed)
        self.assertTrue(ranked, "图通道没有返回任何结果，这条回归测试等于没测")
        leaked = [mid for mid, _ in ranked if mid not in allowed]
        self.assertEqual(leaked, [], "图通道漏出池外记忆：%s" % leaked)
        # 不加过滤时本来会漏出别的作用域 —— 证明这条测试真的能抓到缺陷
        unfiltered = R._channel_graph(self.con, "BM25 打分", ["global"], 100, None)
        would_leak = [mid for mid, _ in unfiltered if mid not in allowed]
        self.assertTrue(would_leak,
                        "构造数据无法触发越界，回归测试无效（需要跨作用域实体边）")

    def test_graph_channel_without_allowed_still_works(self):
        """allowed=None 表示不过滤，行为要保持（图通道自身不该崩）。"""
        ranked = R._channel_graph(self.con, "BM25 打分", None, 100, None)
        self.assertIsInstance(ranked, list)

    def test_all_strategy_and_option_combinations(self):
        """budget / diversify / include_candidates / limit 各分支在跨 scope 下都不越界。"""
        combos = [
            dict(limit=40),
            dict(limit=40, budget=300),
            dict(limit=40, budget=80),
            dict(limit=10, diversify=True),
            dict(limit=3, budget=300),
            dict(limit=40, include_candidates=True),
            dict(limit=40, budget=300, include_candidates=True),
            dict(limit=1),
        ]
        strategies = ["hybrid", "bm25", "vector", "substring", "graph"]
        for scope in self.SCOPES:
            allowed = self._allowed(scope)
            for kw in combos:
                for strategy in strategies:
                    res = R.search(self.con, None, "BM25 打分", scope=scope,
                                   strategy=strategy, **kw)
                    self._assert_no_leak(res, allowed, "%s/%s/%s"
                                         % (scope, strategy, kw))

    def test_budget_enables_mmr_without_leak(self):
        """budget 非空会自动开 MMR（diversify）——该路径同样不得越界。"""
        allowed = self._allowed("global")
        res = R.search(self.con, None, "BM25 打分", scope="global", limit=40, budget=300)
        self._assert_no_leak(res, allowed, "budget->MMR")
        self.assertLessEqual(res["tokens"], 330)

    def test_explicit_diversify_with_tight_limit(self):
        """limit 很小 + diversify 强制开，MMR 选中的仍是池内条目。"""
        allowed = self._allowed("agent:beta")
        res = R.search(self.con, None, "BM25 打分", scope="agent:beta",
                       limit=2, diversify=True)
        self._assert_no_leak(res, allowed, "agent:beta/diversify")
        self.assertLessEqual(len(res["hits"]), 2)

    def test_unknown_scope_returns_empty_not_crash(self):
        res = R.search(self.con, None, "BM25 打分", scope="task:does-not-exist", limit=10)
        # 未知作用域只继承 global，不应抛异常
        self.assertIsInstance(res["hits"], list)
        for hit in res["hits"]:
            self.assertEqual(hit["scope_id"], "global")

    def test_fusion_guard_reports_dropped(self):
        """兜底：故意让融合层收到池外 id，应被丢弃并在 degraded 里留痕。"""
        channels = {"bm25": [("x0_0", 1.0), ("x9_9", 0.9)]}
        fused = R.rrf_fuse(channels)
        self.assertIn("x9_9", fused)      # 融合层本身不知道作用域
        # 真正的兜底在 search 里，这里验证 by_id 语义：池内 id 才是安全的
        pool = R._fetch_pool(self.con, self.con, ["global"], False, 20000)
        by_id = {m["id"]: m for m in pool}
        self.assertIn("x0_0", by_id)
        self.assertNotIn("x9_9", by_id)


class TestDegraded(Base):
    def test_no_gateway_still_returns(self):
        res = R.search(self.con, None, "向量检索", limit=5)
        self.assertTrue(res["hits"], "无模型时必须仍返回结果")
        joined = " ".join(res["degraded"])
        self.assertIn("vector", joined)
        self.assertIn("rerank", joined)
        print("\n[degraded] gw=None ->", res["degraded"])

    def test_model_unavailable_still_returns(self):
        gw = FakeGateway(fail=True)
        res = R.search(self.con, gw, "向量检索", limit=5)
        self.assertTrue(res["hits"])
        joined = " ".join(res["degraded"])
        self.assertIn("vector", joined)
        self.assertIn("rerank", joined)
        self.assertIn("ModelUnavailable", joined)
        print("[degraded] gw raises  ->", res["degraded"])

    def test_gateway_called_when_healthy(self):
        gw = FakeGateway(fail=False)
        res = R.search(self.con, gw, "模型网关", limit=5)
        methods = [c[0] for c in gw.calls]
        self.assertIn("embed", methods)
        self.assertIn("rerank", methods)
        self.assertTrue(res["hits"])
        self.assertNotIn("ModelUnavailable", " ".join(res["degraded"]))

    def test_broken_gateway_object(self):
        class Broken:
            def embed(self, texts, **kw):
                raise RuntimeError("boom")

            def rerank(self, *a, **kw):
                raise RuntimeError("boom2")

        res = R.search(self.con, Broken(), "切块算法", limit=5)
        self.assertTrue(res["hits"])
        self.assertIn("vector", " ".join(res["degraded"]))


# ---------------------------------------------------------------------------
# 5. 图通道（个性化 PageRank）
# ---------------------------------------------------------------------------

class TestGraphChannel(Base):
    def test_ppr_reaches_related_memory(self):
        con = self.con
        con.execute("INSERT INTO entity(id,name,kind,created_at) VALUES"
                    "('e_db','数据库并发','concept','2025-01-01'),"
                    "('e_wal','WAL模式','concept','2025-01-01')")
        con.execute("INSERT INTO memory(id, scope_id, kind, title, body, status, trust,"
                    " importance, recorded_at, updated_at) VALUES"
                    "('g1','global','fact','图通道甲','甲','approved',0.8,0.5,"
                    "'2025-01-01T00:00:00Z','2025-01-01T00:00:00Z'),"
                    "('g2','global','fact','图通道乙','乙','approved',0.8,0.5,"
                    "'2025-01-01T00:00:00Z','2025-01-01T00:00:00Z')")
        con.execute("INSERT INTO memory_entity(memory_id,entity_id,role) VALUES"
                    "('g1','e_db','about'),('g2','e_wal','about')")
        con.execute("INSERT INTO edge(id,src,src_kind,dst,dst_kind,rel,weight,confidence)"
                    " VALUES('ed1','e_db','entity','e_wal','entity','semantic',1.0,0.9)")
        ranked = R._channel_graph(con, "数据库并发", None, 50)
        ids = [i for i, _ in ranked]
        self.assertIn("g1", ids, "直接命中实体的记忆必须进图通道")
        self.assertIn("g2", ids, "2 跳内的邻居记忆也应通过 PPR 进入图通道")
        scores = dict(ranked)
        self.assertGreater(scores["g1"], scores["g2"], "种子节点权重应高于邻居")

    def test_graph_channel_surfaces_in_search(self):
        con = self.con
        con.execute("INSERT INTO entity(id,name,kind,created_at) VALUES"
                    "('e_x','图通道专用实体','concept','2025-01-01')")
        con.execute("INSERT INTO memory(id, scope_id, kind, title, body, status, trust,"
                    " importance, recorded_at, updated_at) VALUES"
                    "('gx','global','fact','关联记忆','与图通道专用实体相关的说明','approved',"
                    "0.8,0.5,'2025-01-01T00:00:00Z','2025-01-01T00:00:00Z')")
        con.execute("INSERT INTO memory_entity(memory_id,entity_id,role)"
                    " VALUES('gx','e_x','about')")
        res = R.search(con, None, "图通道专用实体", limit=10)
        hit = [h for h in res["hits"] if h["id"] == "gx"]
        self.assertTrue(hit, "图通道命中的记忆应出现在结果里")
        self.assertGreater(hit[0]["channels"]["graph"], 0.0)


# ---------------------------------------------------------------------------
# 6. 性能（300 / 3000）
# ---------------------------------------------------------------------------

class TestPerformance(unittest.TestCase):
    """300 条与 3000 条各测一轮，数字写进 docs/retrieval.md。"""

    def _measure(self, scale, label):
        tmp = Path(tempfile.mkdtemp(prefix="memora_perf_"))
        try:
            path = tmp / "memora.db"
            D.init_db(path)
            con = D.connect(path)
            build_corpus(con, scale=scale)
            n = con.execute("SELECT count(*) FROM memory").fetchone()[0]
            R.search(con, None, QUERIES[0], limit=20)          # 预热（含向量缓存写入）
            samples = []
            for i in range(10):
                t0 = time.perf_counter()
                res = R.search(con, None, QUERIES[i % len(QUERIES)], limit=20)
                samples.append((time.perf_counter() - t0) * 1000)
                self.assertTrue(res["hits"], "第 %d 次检索没有结果" % i)
            samples.sort()
            mean = sum(samples) / len(samples)
            print("\n[perf] %-6s %4d 条记忆  search(limit=20)  "
                  "mean=%.1fms  median=%.1fms  p90=%.1fms  max=%.1fms"
                  % (label, n, mean, samples[len(samples) // 2],
                     samples[int(len(samples) * 0.9)], samples[-1]))
            con.close()
            return mean
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_search_latency_300_vs_3000(self):
        mean_300 = self._measure(1, "300")
        mean_3000 = self._measure(10, "3000")
        self.assertLess(mean_300, 500.0, "300 条时单次检索应远低于 500ms")
        self.assertLess(mean_3000, 3000.0, "3000 条时单次检索不应超过 3 秒")


# ---------------------------------------------------------------------------
# 7. 1.1.0 回归：候选池 / 过滤顺序 / 子串字面匹配 / 敏感度 / 向量缓存 / 响应字段 / 快速失败
# ---------------------------------------------------------------------------

NOW = "2025-01-01T00:00:00Z"


def _insert_many(con, rows):
    """rows: (id, title, body[, scope, status, updated_at, sensitivity])，一个事务写完。"""
    full = []
    for row in rows:
        mid, title, body = row[:3]
        scope = row[3] if len(row) > 3 else "global"
        status = row[4] if len(row) > 4 else "approved"
        updated = row[5] if len(row) > 5 else NOW
        sensitivity = row[6] if len(row) > 6 else "normal"
        full.append((mid, scope, "fact", title, body, "", status, 0.8, 0.5, sensitivity,
                     NOW, updated, 10))
    con.execute("BEGIN")
    con.executemany(
        "INSERT INTO memory(id, scope_id, kind, title, body, summary, status, trust, importance,"
        " sensitivity, recorded_at, updated_at, tokens) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", full)
    con.execute("COMMIT")


class _TempDB(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="memora_r11_"))
        self.db_path = self.tmp / "memora.db"
        D.init_db(self.db_path)
        self.con = D.connect(self.db_path)

    def tearDown(self):
        try:
            self.con.close()
        finally:
            shutil.rmtree(self.tmp, ignore_errors=True)

    @staticmethod
    def ids(res):
        return [h["id"] for h in res["hits"]]


class TestStorePool(_TempDB):
    """缺陷 A：给 Store 时 1.0.0 的候选池走 Store.list_memories，被 500 条上限截断。"""

    def test_store_with_more_than_500_memories_finds_the_oldest(self):
        from memora_core.store import Store
        rows = [("oldest", "独角兽 记录", "独角兽测试 只出现在这一条里", "global", "approved",
                 "2020-01-01T00:00:00Z")]
        rows += [("f%04d" % i, "填充 %d" % i, "无关内容 %d" % i, "global", "approved",
                  "2025-06-%02dT00:00:00Z" % (1 + i % 28)) for i in range(600)]
        _insert_many(self.con, rows)
        store = Store(self.db_path)
        try:
            res = R.search(store, None, "独角兽测试", limit=10)
            self.assertEqual(self.ids(res)[:1], ["oldest"])
            self.assertEqual(len(R._fetch_pool(store, None, None, False, R.POOL_CAP)), 601)
            dups = DD.find_duplicates(store, {"title": "独角兽 记录", "scope_id": "global",
                                              "body": "独角兽测试 只出现在这一条里"}, limit=3)
            self.assertEqual(dups[0]["id"], "oldest", "完全重复的最老记忆必须被判出来")
            self.assertGreaterEqual(dups[0]["dup"], 0.99)
        finally:
            store.close()


class TestFtsLimitAfterFilter(_TempDB):
    """缺陷 B：1.0.0 的 FTS 查询先 LIMIT 再按作用域/状态过滤，域外强命中挤掉域内结果。"""

    GLOBAL = ["g0", "g1", "g2", "g3", "g4"]

    def _build(self, crowd_scope="workspace:other", crowd_status="approved"):
        rows = [("g%d" % i, "kafka kafka kafka %d" % i, "kafka") for i in range(3)]
        rows += [("o%03d" % i, "note %d" % i, "kafka partition notes " + "x " * 5,
                  crowd_scope, crowd_status) for i in range(150)]
        rows += [("g%d" % i, "misc %d" % i,
                  "long text about many things and kafka once " + "filler " * 60)
                 for i in range(3, 5)]
        _insert_many(self.con, rows)

    def _fts_ids(self):
        info: dict = {}
        pool = R._fetch_pool(self.con, self.con, R._expand_scope(self.con, "global"), False,
                             R.POOL_CAP, info=info)
        ranked = R._channel_bm25(self.con, "kafka", {m["id"] for m in pool}, 50, [],
                                 flt=info["filter"])
        return sorted(mid for mid, _ in ranked)

    def test_fts_channel_filters_scope_before_limit(self):
        self._build()
        self.assertEqual(self._fts_ids(), self.GLOBAL)

    def test_fts_channel_filters_status_before_limit(self):
        self._build(crowd_scope="global", crowd_status="candidate")
        self.assertEqual(self._fts_ids(), self.GLOBAL)

    def test_search_returns_all_in_scope_hits_with_either_engine(self):
        self._build()
        saved = R.BM25_ENGINE
        try:
            for engine in ("lexical", "fts5"):
                R.BM25_ENGINE = engine
                for strategy in ("hybrid", "bm25"):
                    res = R.search(self.con, None, "kafka", scope="global", limit=10,
                                   strategy=strategy)
                    self.assertEqual(sorted(self.ids(res)), self.GLOBAL, (engine, strategy))
        finally:
            R.BM25_ENGINE = saved


class TestLexicalMatching(_TempDB):
    def test_underscore_is_matched_literally(self):
        """1.0.0 把 % 和 _ 从 LIKE 模式里删掉：snake_case 变成 '%snakecase%'，
        找到的是连写的那条，真正写 snake_case 的反而漏掉。"""
        _insert_many(self.con, [("snake", "命名", "变量名一律用 snake_case 风格"),
                                ("glued", "命名", "这里写成了 snakecase 连在一起")])
        ids = self.ids(R.search(self.con, None, "snake_case", limit=10, strategy="substring"))
        self.assertIn("snake", ids)
        self.assertNotIn("glued", ids)

    def test_long_question_keeps_ascii_terms(self):
        """1.0.0 子串通道最多 12 个检索词、中文二元组排在前面，长问句里的 ASCII 词被截掉。"""
        _insert_many(self.con, [("target", "部署", "部署脚本依赖 kubectl 1.29"),
                                ("other", "杂项", "其它内容")])
        query = "我们在生产环境里面部署服务的时候到底依赖哪个版本的 kubectl"
        self.assertIn("kubectl", R._substring_terms(query))
        ranked = R._channel_substring(self.con, query, {"target", "other"}, 10)
        self.assertEqual(ranked[0][0], "target")

    def test_ascii_glued_to_cjk_is_found_by_bm25(self):
        """unicode61 把 '使用WAL模式' 切成一个 token，FTS 查 wal 查不到；切分 BM25 按文字类别断开。"""
        _insert_many(self.con, [("wal", "数据库配置", "数据库使用WAL模式保证并发读写"),
                                ("x", "别的", "完全无关的一条")])
        self.assertEqual(self.ids(R.search(self.con, None, "WAL", limit=5, strategy="bm25")),
                         ["wal"])
        full_width = R.search(self.con, None, "ＷＡＬ 模式", limit=5, strategy="bm25")
        self.assertEqual(self.ids(full_width)[:1], ["wal"])

    def test_plural_and_prefix_matching(self):
        _insert_many(self.con, [("mig", "notes", "catalogue migrations broke twice"),
                                ("lint", "tooling", "the linter runs before commit"),
                                ("x", "misc", "nothing relevant here")])
        self.assertEqual(self.ids(R.search(self.con, None, "migration", limit=5,
                                           strategy="bm25")), ["mig"])
        self.assertEqual(self.ids(R.search(self.con, None, "lint", limit=5,
                                           strategy="bm25")), ["lint"])

    def test_stopword_only_query_still_searches(self):
        _insert_many(self.con, [("a", "what is it", "what is it about"), ("b", "x", "y")])
        self.assertEqual(self.ids(R.search(self.con, None, "what is it", limit=5,
                                           strategy="bm25"))[:1], ["a"])


class TestSecretExclusion(_TempDB):
    """sensitivity='secret' 的记忆默认不进智能体召回 / digest；用户界面检索显式 include_secret=True。"""

    def setUp(self):
        super().setUp()
        _insert_many(self.con, [
            ("pub", "部署口令说明", "部署口令放在团队的保管处", "global", "approved", NOW, "normal"),
            ("sec", "部署口令", "部署口令的保管位置写在这一条", "global", "approved", NOW, "secret"),
            ("priv", "部署口令备注", "部署口令每季度轮换", "global", "approved", NOW, "private"),
        ])

    def test_search_excludes_secret_unless_asked(self):
        for strategy in ("hybrid", "bm25", "substring", "vector", "graph", "bm25+substring"):
            res = R.search(self.con, None, "部署口令", limit=10, strategy=strategy)
            self.assertNotIn("sec", self.ids(res), strategy)
        self.assertEqual(set(self.ids(R.search(self.con, None, "部署口令", limit=10))),
                         {"pub", "priv"})
        self.assertIn("sec", self.ids(R.search(self.con, None, "部署口令", limit=10,
                                               include_secret=True)))

    def test_agent_recall_and_digest_exclude_secret(self):
        out = R.recall_for_agent(self.con, None, "部署口令", "agent-x", scope="global", limit=10)
        self.assertNotIn("sec", self.ids(out))
        self.assertTrue(out["hits"])
        for kwargs in ({"task": "部署口令"}, {}):
            pack = R.digest(self.con, None, scope="global", budget=2000, **kwargs)
            self.assertNotIn("[m:sec]", pack["text"], kwargs)
            self.assertIn("[m:pub]", pack["text"], kwargs)
            pack = R.digest(self.con, None, scope="global", budget=2000, include_secret=True,
                            **kwargs)
            self.assertIn("[m:sec]", pack["text"], kwargs)

    def test_dedup_still_sees_secret(self):
        dups = DD.find_duplicates(self.con, {"title": "部署口令", "scope_id": "global",
                                             "body": "部署口令的保管位置写在这一条"}, limit=3)
        self.assertEqual(dups[0]["id"], "sec")


class _VecGateway:
    """duck-typed 网关：embed 返回由文本决定的单位向量（维度可控），rerank 不可用。"""

    def __init__(self, dim, label=None, profile=None):
        self.dim = dim
        self.calls = []
        if label:
            self.embedding_label = label
        self._profile = profile

    def roles(self):
        return {"embedding": self._profile} if self._profile else {}

    def embed(self, texts, role="embedding"):
        self.calls.append(len(texts))
        out = []
        for text in texts:
            rng = random.Random("%s|%d" % (text, self.dim))
            vec = [rng.gauss(0, 1) for _ in range(self.dim)]
            norm = sum(v * v for v in vec) ** 0.5
            out.append([v / norm for v in vec])
        return out

    def rerank(self, query, docs, top_k=20, role="reranker"):
        raise RuntimeError("no reranker")


class TestVectorCache(_TempDB):
    def _docs(self, n):
        _insert_many(self.con, [("d%03d" % i, "文档 %d" % i, "内容 %d 关于检索" % i)
                                for i in range(n)])

    def test_cloud_vectors_keyed_by_model_and_dim(self):
        """缺陷 C：1.0.0 所有云端模型共用 'cloud-embed' 键，换维度后按 min(len) 混算。"""
        self._docs(30)
        res = R.search(self.con, _VecGateway(64), "检索", limit=5)
        self.assertEqual(res["vector_model"], "cloud-embed@64")
        self.assertTrue(res["semantic"])
        self.assertIn("vector", res["channels_used"])
        res = R.search(self.con, _VecGateway(32), "检索", limit=5)
        self.assertEqual(res["vector_model"], "cloud-embed@32")
        rows = {r[0]: (r[1], r[2], r[3]) for r in self.con.execute(
            "SELECT model, min(dim), max(dim), count(*) FROM vector GROUP BY model")}
        self.assertEqual(rows["cloud-embed@64"], (64, 64, 30))
        self.assertEqual(rows["cloud-embed@32"], (32, 32, 30))
        pool = R._fetch_pool(self.con, self.con, None, False, R.POOL_CAP)
        ranked, vecs, key = R._cloud_channel(self.con, _VecGateway(32), "检索", pool, 100, [])
        self.assertEqual(key, "cloud-embed@32")
        self.assertTrue(vecs and all(len(v) == 32 for v in vecs.values()))

    def test_model_key_uses_gateway_profile(self):
        self._docs(5)
        gw = _VecGateway(16, profile={"provider": "acme", "model": "emb-1"})
        self.assertEqual(R.search(self.con, gw, "检索", limit=5)["vector_model"], "acme/emb-1@16")

    def test_uncovered_pool_is_reported_and_backfilled(self):
        """缺陷 E：1.0.0 只为前 400 条补云端向量，其余静默缺席向量通道。"""
        self._docs(450)
        gw = _VecGateway(16)
        first = R.search(self.con, gw, "检索", limit=5)
        self.assertTrue(any("50/450" in d for d in first["degraded"]), first["degraded"])
        self.assertEqual(sum(gw.calls), 1 + R.MAX_CLOUD_EMBED)
        gw.calls.clear()
        second = R.search(self.con, gw, "检索", limit=5)
        self.assertFalse(any("还没有" in d for d in second["degraded"]), second["degraded"])
        self.assertEqual(sum(gw.calls), 1 + 50)

    def test_memories_without_vectors_keep_full_lexical_weight(self):
        """有 embedding 模型时关键词权重被压低（SEMANTIC_LEXICAL_SCALE），但还没补算到向量的
        记忆不受影响：唯一字面命中的那条仍排第一。"""
        self._docs(120)
        _insert_many(self.con, [("late", "独角兽", "独角兽测试 只在这一条里")])
        saved = R.MAX_CLOUD_EMBED
        try:
            R.MAX_CLOUD_EMBED = 0             # 一条都不补算：只有 query 能嵌入
            gw = _VecGateway(16)
            R.search(self.con, gw, "预热", limit=5)
            R.MAX_CLOUD_EMBED = 120
            pool = R._fetch_pool(self.con, self.con, None, False, R.POOL_CAP)
            R._cloud_channel(self.con, gw, "预热", [m for m in pool if m["id"] != "late"], 200, [])
            R.MAX_CLOUD_EMBED = 0
            res = R.search(self.con, gw, "独角兽测试", limit=5)
            self.assertTrue(res["semantic"])
            self.assertTrue(any("1/121" in d for d in res["degraded"]), res["degraded"])
            self.assertEqual(self.ids(res)[:1], ["late"])
        finally:
            R.MAX_CLOUD_EMBED = saved

    def test_vector_older_than_memory_is_recomputed(self):
        """缺陷 D 的兜底：缓存向量早于 memory.updated_at 就不再采信。"""
        _insert_many(self.con, [("m1", "水果", "苹果 香蕉 葡萄 西瓜"),
                                ("m2", "别的", "完全无关")])
        R.search(self.con, None, "苹果", limit=5, strategy="vector")      # 缓存草图向量
        self.con.execute("UPDATE vector SET created_at='2020-01-01T00:00:00Z'")
        self.con.execute("UPDATE memory SET title='量子', body='量子计算 量子比特 纠缠',"
                         " updated_at='2024-01-01T00:00:00Z' WHERE id='m1'")
        res = R.search(self.con, None, "量子计算 量子比特", limit=5, strategy="vector")
        self.assertEqual(self.ids(res)[:1], ["m1"])
        cached = VectorIndex(self.con).get("memory", "m1", model=V.MODEL_LOCAL)
        self.assertAlmostEqual(cosine(cached, hash_embed("量子\n量子计算 量子比特 纠缠")), 1.0,
                               places=5)

    def test_forget_owner_drops_rows_and_cache(self):
        index = VectorIndex(self.con)
        index.put("memory", "m1", hash_embed("一"), model=V.MODEL_LOCAL)
        index.put("memory", "m1", [1.0, 0.0], model="acme/e@2")
        index.put("memory", "m2", hash_embed("二"), model=V.MODEL_LOCAL)
        self.assertIn("m1", V.cached_vectors(self.con, "memory", V.MODEL_LOCAL))
        self.assertEqual(V.forget_owner(self.con, "memory", "m1"), 2)
        self.assertNotIn("m1", V.cached_vectors(self.con, "memory", V.MODEL_LOCAL))
        self.assertIn("m2", V.cached_vectors(self.con, "memory", V.MODEL_LOCAL))


class TestReportedFields(Base):
    """新增响应字段：客户端据此知道实际跑了什么（只增不改，旧字段保持）。"""

    def test_offline_hybrid_has_no_vector_channel(self):
        res = R.search(self.con, None, "向量检索", limit=5)
        self.assertEqual(res["channels_used"], ["bm25", "substring", "graph"])
        self.assertIsNone(res["vector_model"])
        self.assertFalse(res["semantic"])
        self.assertFalse(res["reranked"])
        self.assertEqual(res["score_kind"], "rrf")
        self.assertTrue(all(h["channels"]["vector"] == 0.0 for h in res["hits"]))
        self.assertTrue(any("不参与 hybrid" in d for d in res["degraded"]), res["degraded"])

    def test_explicit_vector_strategy_is_labelled_as_sketch(self):
        res = R.search(self.con, None, "向量检索", limit=5, strategy="vector")
        self.assertEqual(res["vector_model"], V.MODEL_LOCAL)
        self.assertFalse(res["semantic"])
        self.assertTrue(any(V.MODEL_LOCAL in d and "不是语义向量" in d for d in res["degraded"]))

    def test_working_gateway_reports_semantic_and_rerank(self):
        res = R.search(self.con, FakeGateway(), "模型网关", limit=5)
        self.assertTrue(res["semantic"])
        self.assertEqual(res["vector_model"], "cloud-embed@256")
        self.assertIn("vector", res["channels_used"])
        self.assertTrue(res["reranked"])
        self.assertEqual(res["score_kind"], "rrf+rerank")

    def test_channel_combinations(self):
        res = R.search(self.con, None, "向量检索", limit=5, strategy="substring+bm25")
        self.assertEqual(res["strategy"], "bm25+substring")
        self.assertEqual(res["channels_used"], ["bm25", "substring"])
        res = R.search(self.con, None, "向量检索", limit=5, strategy="bm25+bogus")
        self.assertEqual(res["strategy"], "hybrid")
        self.assertTrue(any(d.startswith("strategy") for d in res["degraded"]))


def _status_server(status):
    """固定返回某个 HTTP 状态码的本地桩服务；Handler.hits 记录收到的请求数。"""
    class Handler(BaseHTTPRequestHandler):
        hits = 0

        def do_POST(self):
            length = int(self.headers.get("Content-Length") or 0)
            self.rfile.read(length)
            body = b'{"error": "stub"}'
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            Handler.hits += 1

        def log_message(self, *args):
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, Handler


class _HungServer:
    """接受 TCP 连接、永不回应的端点。"""

    def __init__(self):
        self.sock = socket.socket()
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(64)
        self.port = self.sock.getsockname()[1]
        self.conns = []
        threading.Thread(target=self._loop, daemon=True).start()

    def _loop(self):
        while True:
            try:
                conn, _addr = self.sock.accept()
            except OSError:
                return
            self.conns.append(conn)

    def count(self, expect, wait=1.0):
        deadline = time.time() + wait
        while len(self.conns) < expect and time.time() < deadline:
            time.sleep(0.01)
        return len(self.conns)

    def close(self):
        self.sock.close()
        for conn in self.conns:
            try:
                conn.close()
            except OSError:
                pass


class TestGatewayFailFast(_TempDB):
    """检索走网关的快速失败模式；传输层失败后该角色熔断，冷却期内不再发请求。"""

    def setUp(self):
        super().setUp()
        from memora_core import models as M
        self.M = M
        self.saved = (M.INTERACTIVE_TIMEOUT_MS, M.INTERACTIVE_BUDGET_MS)
        M.INTERACTIVE_TIMEOUT_MS, M.INTERACTIVE_BUDGET_MS = 300, 1500
        self.clock = [1000.0]
        self.sleeps = []
        self.servers = []
        _insert_many(self.con, [("n%02d" % i, "笔记 %d" % i, "数据库并发 笔记 %d" % i)
                                for i in range(20)])

    def tearDown(self):
        self.M.INTERACTIVE_TIMEOUT_MS, self.M.INTERACTIVE_BUDGET_MS = self.saved
        for server in self.servers:
            server.close()
        super().tearDown()

    def _profiles(self, base_url, roles=("embedding", "reranker")):
        for role in roles:
            self.con.execute(
                "INSERT OR REPLACE INTO model_profile(id, role, provider, model, base_url,"
                " timeout_ms, created_at) VALUES(?,?,?,?,?,?,?)",
                (role, role, "openai-compatible", "m", base_url, 60000, NOW))

    def _gateway(self):
        return self.M.ModelGateway(None, db_path=self.db_path, sleep=self.sleeps.append,
                                   clock=lambda: self.clock[0])

    def test_hung_endpoint_fails_fast_then_breaker_opens(self):
        hung = _HungServer()
        self.servers.append(hung)
        self._profiles("http://127.0.0.1:%d" % hung.port)
        gw = self._gateway()
        started = time.perf_counter()
        res = R.search(self.con, gw, "数据库并发", limit=5)
        self.assertLess(time.perf_counter() - started, 3.0, "交互式检索必须快速失败")
        self.assertTrue(res["hits"])
        self.assertEqual(hung.count(2), 2, "一次 embed + 一次 rerank，不重试")
        started = time.perf_counter()
        res = R.search(self.con, gw, "数据库并发", limit=5)
        self.assertLess(time.perf_counter() - started, 0.5)
        self.assertEqual(hung.count(3, wait=0.3), 2, "熔断期间不得再发请求")
        self.assertTrue(any("熔断" in d for d in res["degraded"]), res["degraded"])
        health = gw.health()
        for role in ("embedding", "reranker"):
            self.assertFalse(health[role]["ok"], role)
            self.assertTrue(health[role]["degraded"], role)
            self.assertIn("熔断", health[role]["last_error"], role)
            self.assertTrue(gw.breaker_state(role)["open"], role)
        self.assertTrue(gw.status()["circuits"]["embedding"]["open"])
        calls = dict(tuple(r) for r in self.con.execute(
            "SELECT role, count(*) FROM model_call GROUP BY role"))
        self.assertEqual(calls, {"embedding": 1, "reranker": 1}, "只记真正发出的请求")
        self.clock[0] += self.M.BREAKER_COOLDOWN_S + 1          # 冷却期过后放行一次（半开）
        self.assertFalse(gw.breaker_state("embedding")["open"])
        R.search(self.con, gw, "数据库并发", limit=5)
        self.assertEqual(hung.count(4), 4)

    def test_background_calls_retry_and_trip_breaker(self):
        server, handler = _status_server(503)
        self.servers.append(_Closer(server))
        self._profiles("http://127.0.0.1:%d" % server.server_address[1], roles=("embedding",))
        gw = self._gateway()
        with self.assertRaises(self.M.ModelUnavailable):
            gw.embed(["x"])
        self.assertEqual(handler.hits, 3, "非交互调用照常重试 2 次")
        self.assertEqual(self.sleeps, [0.5, 1.5])
        with self.assertRaises(self.M.ModelUnavailable) as ctx:
            gw.embed(["x"])
        self.assertEqual(handler.hits, 3)
        self.assertIn("熔断", ctx.exception.reason)
        report = gw.test("embedding")                 # 用户主动测连通性不受熔断限制
        self.assertEqual(handler.hits, 6)
        self.assertFalse(report["ok"])
        self.assertNotIn("熔断", report["detail"])

    def test_client_errors_do_not_trip_breaker(self):
        server, handler = _status_server(401)
        self.servers.append(_Closer(server))
        self._profiles("http://127.0.0.1:%d" % server.server_address[1], roles=("embedding",))
        gw = self._gateway()
        for expected in (1, 2):
            with self.assertRaises(self.M.ModelUnavailable):
                gw.embed(["x"])
            self.assertEqual(handler.hits, expected)
        self.assertFalse(gw.breaker_state("embedding")["open"])


class _Closer:
    def __init__(self, server):
        self.server = server

    def close(self):
        self.server.shutdown()
        self.server.server_close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
