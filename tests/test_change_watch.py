# -*- coding: utf-8 -*-
"""tests/test_change_watch.py — 别的进程写库后，界面（SSE）收到 memory 事件。

1.0.0：mcp-stdio 跑在另一个进程里，它的写入不经过服务端，界面从来不知道（页面只听 SSE、不轮询）。
"""
from __future__ import annotations

import json
import sqlite3
import sys
import threading
import time
import unittest
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from memora_core import db as dbmod  # noqa: E402
from memora_core import server  # noqa: E402
from tests.test_server import ServerCase  # noqa: E402


class ExternalWriteTest(ServerCase):
    def test_write_from_another_connection_reaches_sse(self):
        request = urllib.request.Request(self.base + "/api/events?types=memory")
        request.add_header("Accept", "text/event-stream")
        response = urllib.request.urlopen(request, timeout=15)
        frames: list[str] = []

        def reader() -> None:
            buffer = ""
            deadline = time.time() + 15
            while time.time() < deadline:
                line = response.readline()
                if not line:
                    return
                text = line.decode("utf-8", "replace")
                if text.strip():
                    buffer += text
                    continue
                if "external" in buffer:
                    frames.append(buffer)
                    return
                buffer = ""

        thread = threading.Thread(target=reader, daemon=True)
        thread.start()
        try:
            # 等观察者起来并越过安静期，再用一条**独立连接**写库（模拟 mcp-stdio 进程）
            time.sleep(server.CHANGE_QUIET_SECONDS + server.CHANGE_POLL_SECONDS)
            con = dbmod.connect(self.paths.db)
            try:
                con.execute("INSERT INTO setting(key, value) VALUES('probe', '1') "
                            "ON CONFLICT(key) DO UPDATE SET value = excluded.value")
            finally:
                con.close()
            thread.join(timeout=12)
        finally:
            response.close()
        self.assertTrue(frames, "外部写入后 SSE 应收到 action=external 的 memory 事件")
        payload = json.loads([ln for ln in frames[0].splitlines() if ln.startswith("data:")][0][5:])
        self.assertEqual((payload.get("data") or payload).get("action"), "external")


if __name__ == "__main__":
    unittest.main()
