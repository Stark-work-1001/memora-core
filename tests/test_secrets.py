# -*- coding: utf-8 -*-
"""tests/test_secrets.py — 主密钥：绝不静默替换；首次创建不竞争；Windows 上用 DPAPI 封装。"""
from __future__ import annotations

import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from memora_core import models  # noqa: E402
from memora_core.paths import Paths  # noqa: E402


class SecretBoxTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="memora-secret-"))
        self.paths = Paths(self.tmp)
        self.key = self.tmp / "master.key"

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def box(self) -> models.SecretBox:
        return models.SecretBox(self.paths)

    def test_round_trip_with_a_fresh_key(self):
        cipher = self.box().encrypt("sk-test-123456")
        self.assertEqual(self.box().decrypt(cipher), "sk-test-123456", "新实例读同一把钥匙")
        raw = self.key.read_bytes()
        if os.name == "nt":
            self.assertTrue(raw.startswith(b"MKDPAPI1"), "Windows 上新钥匙应由 DPAPI 封装")
            self.assertNotEqual(len(raw), 32)
        else:
            self.assertEqual(len(raw), 32)

    def test_a_1_0_0_plain_key_keeps_working_and_is_not_rewritten(self):
        self.key.write_bytes(bytes(range(32)))
        cipher = self.box().encrypt("legacy")
        self.assertEqual(self.box().decrypt(cipher), "legacy")
        self.assertEqual(self.key.read_bytes(), bytes(range(32)))

    def test_a_damaged_key_is_reported_and_never_replaced(self):
        # 1.0.0：长度不对的密钥文件被静默替换成 sha256(内容)，已保存的密钥从此解不开且没有提示
        self.key.write_bytes(b"0123456789")
        with self.assertRaises(models.SecretKeyUnavailable) as caught:
            self.box().encrypt("x")
        self.assertIn("损坏", str(caught.exception))
        self.assertEqual(self.key.read_bytes(), b"0123456789")

    def test_a_dpapi_key_from_elsewhere_is_reported(self):
        self.key.write_bytes(b"MKDPAPI1" + b"\x00" * 64)
        with self.assertRaises(models.SecretKeyUnavailable):
            self.box().encrypt("x")
        self.assertEqual(self.key.read_bytes(), b"MKDPAPI1" + b"\x00" * 64)

    def test_losing_the_creation_race_adopts_the_winners_key(self):
        winner = os.urandom(32)
        self.key.write_bytes(winner)
        # 模拟"刚检查过文件不存在，另一个进程就先建好了"
        self.assertEqual(self.box()._create_master(), winner)
        self.assertEqual(self.key.read_bytes(), winner)

    @unittest.skipUnless(os.name == "nt", "DPAPI 只在 Windows 上")
    def test_dpapi_round_trip(self):
        wrapped = models._dpapi(b"k" * 32, protect=True)
        self.assertIsNotNone(wrapped)
        self.assertEqual(models._dpapi(wrapped, protect=False), b"k" * 32)


if __name__ == "__main__":
    unittest.main()
