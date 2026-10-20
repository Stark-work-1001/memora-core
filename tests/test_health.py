# -*- coding: utf-8 -*-
"""tests/test_health.py — /api/health 便宜、完整、如实；MCP memory_health 如实报告降级。

1.0.0：每次 /api/health 都跑完整 integrity_check（211 MB 的库约 1.1 s、422 MB 约 2.9 s），
而桌面外壳的就绪探针超时 1.5 s；表清单是手写的 23 个名字；memory_health 读错了键，
没配任何模型时仍报 degraded=[]。
"""
from __future__ import annotations

import json
import sys
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from memora_core import db as dbmod  # noqa: E402
from tests.test_server import ServerCase  # noqa: E402


class HealthEndpointTest(ServerCase):
    def test_default_health_never_runs_a_full_integrity_scan(self):
        with mock.patch.object(dbmod, "integrity", wraps=dbmod.integrity) as spy:
            for _ in range(5):
                status, body = self.get_json("/api/health")
                self.assertEqual(status, 200)
            time.sleep(0.3)  # 后台 quick_check 至多一次
        self.assertFalse([c for c in spy.call_args_list if c.kwargs.get("full")])
        self.assertLessEqual(spy.call_count, 1)
        self.assertIn(body["db_integrity"], ("ok", "pending"))

    def test_census_covers_every_table(self):
        status, body = self.get_json("/api/health")
        self.assertEqual(status, 200)
        tables = body["db_tables"]
        self.assertEqual(tables["missing"], [])
        self.assertEqual(tables["real"], tables["expected_real"])
        self.assertEqual(len(body["db_census"]), tables["real"] + tables["virtual"])
        for key in ("memory", "document", "chunk", "evidence", "edge", "entity",
                    "workflow_run", "agent", "conflict", "job"):
            self.assertIn(key, body["db"])  # 1.0.0 的 10 键子集保留（兼容）
        self.assertEqual(body["schema_version"], dbmod.SCHEMA_VERSION)
        self.assertTrue(body["sqlite"])

    def test_lite_skips_counting(self):
        status, body = self.get_json("/api/health?lite=1")
        self.assertEqual(status, 200)
        self.assertEqual(body["db"], {})
        self.assertIsNone(body["db_census"])
        self.assertTrue(body["db_ok"])

    def test_deep_runs_integrity_check(self):
        status, body = self.get_json("/api/health?deep=1")
        self.assertEqual(status, 200)
        self.assertEqual(body["db_integrity"], "ok")
        self.assertEqual(body["db_integrity_mode"], "integrity_check")
        self.assertTrue(body["db_integrity_checked_at"])

    def test_overview_daily_buckets_are_local_days(self):
        local_morning = time.time() - (time.time() % 60)
        stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(local_morning))
        status, _headers, raw = self.call("POST", "/api/memories", body={
            "title": "overview local day", "body": "x", "kind": "fact", "recorded_at": stamp})
        self.assertEqual(status, 201, raw[:200])
        status, body = self.get_json("/api/overview")
        self.assertEqual(body["today"], time.strftime("%Y-%m-%d", time.localtime()))
        days = {row["day"]: row["count"] for row in body["daily"]}
        self.assertIn(dbmod.local_day(stamp), days)
        self.assertGreaterEqual(days[dbmod.local_day(stamp)], 1)

    def test_mcp_memory_health_reports_unconfigured_models(self):
        frame = {"jsonrpc": "2.0", "id": 7, "method": "tools/call",
                 "params": {"name": "memory_health", "arguments": {}}}
        status, _headers, raw = self.call("POST", "/mcp", body=frame)
        self.assertEqual(status, 200)
        result = json.loads(raw.decode("utf-8"))["result"]["structuredContent"]
        self.assertTrue(result["ok"], "中枢本身可用：模型缺失只进 degraded（AGENTS.md §6）")
        self.assertTrue([d for d in result["degraded"] if d.startswith("model:")],
                        "没配任何模型时 degraded 必须列出不可用的角色：%r" % result["degraded"])


if __name__ == "__main__":
    unittest.main()
