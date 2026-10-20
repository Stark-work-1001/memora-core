# -*- coding: utf-8 -*-
"""tests/test_api_contract.py — 前端 e2e 发现、需要后端配合的两处契约。"""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tests.test_server import ServerCase  # noqa: E402


class ModelProfileEditTest(ServerCase):
    def upsert(self, body: dict) -> dict:
        status, _headers, raw = self.call("POST", "/api/models", body=body)
        self.assertEqual(status, 201, raw[:300])
        return json.loads(raw.decode("utf-8"))["profile"]

    def ref_of(self, pid: str):
        return self.runtime.store().con.execute(
            "SELECT api_key_ref FROM model_profile WHERE id = ?", (pid,)).fetchone()[0]

    def test_editing_without_a_new_key_keeps_the_stored_key(self):
        self.upsert({"id": "chat-edit", "role": "chat", "model": "m1", "api_key": "sk-keep-me-1234"})
        ref = self.ref_of("chat-edit")
        self.assertTrue(ref)
        # 1.0.0：只改超时，api_key_ref 被写成 NULL，已保存的密钥从此不再被使用
        self.upsert({"id": "chat-edit", "role": "chat", "model": "m1", "timeout_ms": 7000})
        self.assertEqual(self.ref_of("chat-edit"), ref)

    def test_explicit_null_still_clears_the_key(self):
        self.upsert({"id": "chat-clear", "role": "chat", "model": "m1", "api_key": "sk-clear-5678"})
        self.upsert({"id": "chat-clear", "role": "chat", "model": "m1", "api_key_ref": None})
        self.assertIsNone(self.ref_of("chat-clear"))


class ConflictTitlesTest(ServerCase):
    def test_conflict_rows_carry_both_titles(self):
        store = self.runtime.store()
        a = store.add_memory({"title": "side A title", "body": "a", "kind": "fact", "scope_id": "global"})
        b = store.add_memory({"title": "side B title", "body": "b", "kind": "fact", "scope_id": "global"})
        store.add_conflict({"kind": "contradiction", "a_id": a["id"], "b_id": b["id"], "score": 0.7})
        status, body = self.get_json("/api/conflicts")
        self.assertEqual(status, 200)
        row = next(r for r in body["items"] if r["a_id"] == a["id"])
        self.assertEqual(row["a_title"], "side A title")
        self.assertEqual(row["b_title"], "side B title")


if __name__ == "__main__":
    unittest.main()
