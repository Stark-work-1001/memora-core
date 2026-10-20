# -*- coding: utf-8 -*-
"""tests/test_inbox.py — data/inbox/ 自动吸收（OPERATIONS.md 承诺的行为，1.0.0 没有调用方）。"""
from __future__ import annotations

import os
import shutil
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from memora_core import db as dbmod  # noqa: E402
from memora_core import ingest, server  # noqa: E402
from memora_core.paths import Paths  # noqa: E402


class InboxTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="memora-inbox-"))
        self.paths = Paths(self.tmp).ensure()
        dbmod.init_db(self.paths.db)
        self.runtime = server.Runtime(self.paths)

    def tearDown(self):
        self.runtime.shutdown.set()
        store = self.runtime._store
        if store is not None:
            store.close()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def drop(self, name: str, text: str, age: float) -> Path:
        path = self.paths.inbox / name
        path.write_bytes(text.encode("utf-8"))
        stamp = time.time() - age
        os.utime(path, (stamp, stamp))
        return path

    def test_files_still_being_written_are_left_alone(self):
        fresh = self.drop("fresh.md", "# fresh\nstill copying", age=0)
        result = ingest.watch_inbox(self.runtime.store(), inbox=self.paths.inbox, settle_seconds=5)
        self.assertEqual(result["absorbed"], 0)
        self.assertTrue(fresh.exists())

    def test_settled_files_are_absorbed_and_moved(self):
        self.drop("settled.md", "# settled note\nabsorb me", age=60)
        result = ingest.watch_inbox(self.runtime.store(), inbox=self.paths.inbox, settle_seconds=5)
        self.assertEqual(result["absorbed"], 1)
        self.assertTrue((self.paths.inbox / "processed" / "settled.md").exists())
        count = self.runtime.store().con.execute("SELECT count(*) FROM document").fetchone()[0]
        self.assertGreaterEqual(count, 1)

    def test_empty_inbox_leaves_no_audit_rows(self):
        con = self.runtime.store().con
        before = con.execute("SELECT count(*) FROM audit").fetchone()[0]
        for _ in range(3):
            ingest.watch_inbox(self.runtime.store(), inbox=self.paths.inbox, settle_seconds=5)
        self.assertEqual(con.execute("SELECT count(*) FROM audit").fetchone()[0], before)

    def test_server_watcher_absorbs_dropped_files(self):
        self.drop("from-explorer.txt", "dropped into the inbox folder by hand", age=60)
        with mock.patch.object(server, "INBOX_POLL_SECONDS", 0.2):
            self.runtime.start_inbox_watcher()
            deadline = time.time() + 10
            target = self.paths.inbox / "processed" / "from-explorer.txt"
            while time.time() < deadline and not target.exists():
                time.sleep(0.1)
        self.assertTrue(target.exists(), "服务端的收件箱线程应该吸收并移走文件")


if __name__ == "__main__":
    unittest.main()
