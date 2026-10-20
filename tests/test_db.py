# -*- coding: utf-8 -*-
"""tests/test_db.py — 表清单、结构版本与迁移、本地日历日。

表清单不再手写：db.census 从 sqlite_master 推导、对照 schema.sql。1.0.0 的手写名单有 23 个名字，
漏了 7 张真实表、多算了 2 张 FTS 虚表，selftest 和 README 的"23 张表"都来自它。
"""
from __future__ import annotations

import re
import shutil
import sqlite3
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from memora_core import db as dbmod  # noqa: E402

SCHEMA = (Path(__file__).resolve().parent.parent / "memora_core" / "data" / "schema.sql").read_text(
    encoding="utf-8")


class CensusTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="memora-db-test-"))
        self.path = self.tmp / "memora.db"
        dbmod.init_db(self.path)
        self.con = dbmod.connect(self.path)

    def tearDown(self) -> None:
        self.con.close()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_census_matches_schema_sql(self):
        declared_real = len(re.findall(r"CREATE TABLE IF NOT EXISTS", SCHEMA))
        declared_virtual = len(re.findall(r"CREATE VIRTUAL TABLE IF NOT EXISTS", SCHEMA))
        info = dbmod.health(self.con)
        self.assertEqual(info["tables"]["real"], declared_real)
        self.assertEqual(info["tables"]["virtual"], declared_virtual)
        self.assertEqual(info["tables"]["missing"], [])
        self.assertEqual(info["tables"]["unexpected"], [])
        self.assertEqual(len(info["counts"]), declared_real + declared_virtual)

    def test_tables_the_1_0_0_census_could_not_see_are_counted(self):
        counts = dbmod.health(self.con)["counts"]
        for table in ("agent_probe", "block", "memory_entity", "meta", "scope", "secret", "setting"):
            self.assertIn(table, counts)
            self.assertGreaterEqual(counts[table], 0)

    def test_fts_shadow_tables_are_not_counted_as_tables(self):
        counts = dbmod.health(self.con)["counts"]
        self.assertFalse([t for t in counts if t.startswith(("memory_fts_", "chunk_fts_"))])

    def test_a_dropped_table_is_reported_missing(self):
        self.con.execute("DROP TABLE setting")
        info = dbmod.health(self.con)
        self.assertIn("setting", info["tables"]["missing"])
        self.assertFalse(info["ok"])

    def test_default_health_does_not_scan_integrity_but_deep_does(self):
        with mock.patch.object(dbmod, "integrity", wraps=dbmod.integrity) as spy:
            shallow = dbmod.health(self.con)
            self.assertEqual(spy.call_count, 0)
            deep = dbmod.health(self.con, deep=True)
            spy.assert_called_once_with(self.con, full=True)
        self.assertIsNone(shallow["integrity"])
        self.assertEqual(shallow["integrity_mode"], "skipped")
        self.assertEqual(deep["integrity"], "ok")
        self.assertTrue(deep["ok"])


class SchemaVersionTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="memora-db-version-"))
        self.path = self.tmp / "memora.db"

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def version(self) -> int:
        con = dbmod.connect(self.path)
        try:
            return dbmod.schema_version(con)
        finally:
            con.close()

    def columns(self, table: str) -> list[str]:
        con = dbmod.connect(self.path)
        try:
            return [row[1] for row in con.execute("PRAGMA table_info(%s)" % table)]
        finally:
            con.close()

    def test_fresh_db_is_stamped_with_the_current_version(self):
        report = dbmod.init_db(self.path)
        self.assertTrue(report["fresh"])
        self.assertEqual(self.version(), dbmod.SCHEMA_VERSION)

    def test_a_1_0_0_database_is_adopted(self):
        dbmod.init_db(self.path)
        con = dbmod.connect(self.path)
        con.execute("PRAGMA user_version = 0")  # 1.0.0 从不写 user_version
        con.close()
        report = dbmod.init_db(self.path)
        self.assertFalse(report["fresh"])
        self.assertEqual(report["from"], 1)
        self.assertEqual(self.version(), dbmod.SCHEMA_VERSION)

    def test_a_newer_database_is_refused_and_left_untouched(self):
        dbmod.init_db(self.path)
        con = dbmod.connect(self.path)
        con.execute("PRAGMA user_version = %d" % (dbmod.SCHEMA_VERSION + 5))
        con.close()
        before = self.path.read_bytes()
        with self.assertRaises(dbmod.SchemaTooNew):
            dbmod.init_db(self.path)
        self.assertEqual(self.version(), dbmod.SCHEMA_VERSION + 5)
        self.assertEqual(self.path.read_bytes(), before)

    def test_migrations_run_once_in_order(self):
        dbmod.init_db(self.path)
        target = dbmod.SCHEMA_VERSION + 1
        migrations = {target: ("ALTER TABLE setting ADD COLUMN probe_col TEXT",)}
        with mock.patch.object(dbmod, "SCHEMA_VERSION", target), \
                mock.patch.object(dbmod, "MIGRATIONS", migrations):
            first = dbmod.init_db(self.path)
            second = dbmod.init_db(self.path)
            self.assertEqual(self.version(), target)
        self.assertEqual(first["applied"], [target])
        self.assertEqual(second["applied"], [])
        self.assertIn("probe_col", self.columns("setting"))

    def test_a_failing_migration_rolls_back_completely(self):
        dbmod.init_db(self.path)
        target = dbmod.SCHEMA_VERSION + 1
        migrations = {target: ("ALTER TABLE setting ADD COLUMN half_done TEXT", "NOT VALID SQL")}
        with mock.patch.object(dbmod, "SCHEMA_VERSION", target), \
                mock.patch.object(dbmod, "MIGRATIONS", migrations):
            with self.assertRaises(sqlite3.Error):
                dbmod.init_db(self.path)
        self.assertEqual(self.version(), dbmod.SCHEMA_VERSION)
        self.assertNotIn("half_done", self.columns("setting"))


class LocalDayTest(unittest.TestCase):
    def test_local_morning_is_today_not_yesterday(self):
        local_morning = time.mktime(time.strptime("2026-10-20 07:30:00", "%Y-%m-%d %H:%M:%S"))
        stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(local_morning))
        self.assertEqual(dbmod.local_day(stamp), "2026-10-20")
        self.assertEqual(dbmod.local_clock(stamp), "07:30:00")

    def test_formats_seen_in_the_database_parse(self):
        for stamp in ("2026-10-19T23:30:00Z", "2026-10-19 23:30:00", "2026-10-19T23:30:00+00:00"):
            with self.subTest(stamp=stamp):
                self.assertIsNotNone(dbmod.parse_stamp(stamp))
        self.assertEqual(dbmod.local_day("garbage"), "garbage")
        self.assertEqual(dbmod.local_clock(""), "")

    def test_today_is_the_local_date(self):
        self.assertEqual(dbmod.today(), time.strftime("%Y-%m-%d", time.localtime()))


if __name__ == "__main__":
    unittest.main()
