# -*- coding: utf-8 -*-
"""tests/test_resources.py — 连接不泄漏；静态资源可缓存；响应头不重复。"""
from __future__ import annotations

import http.client
import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tests.test_server import ServerCase  # noqa: E402


class ConnectionLeakTest(ServerCase):
    def test_sqlite_connections_do_not_grow_with_requests(self):
        # 每个请求新开一个 TCP 连接 → 服务端每次一个新线程
        self.get_json("/api/memories?limit=1")
        store = self.runtime.store()
        for _ in range(25):
            status, _body = self.get_json("/api/memories?limit=1")
            self.assertEqual(status, 200)
        time.sleep(0.2)  # 让最后一个连接线程走完 finish()
        # 1.0.0：25 个请求后至少 25 个打开的连接（审计：20 个请求 → 21 个）
        self.assertLessEqual(store.open_connections(), 3)


class StaticCachingTest(ServerCase):
    def raw_get(self, path: str, headers: dict | None = None) -> tuple[int, dict, bytes]:
        con = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            con.request("GET", path, headers=headers or {})
            response = con.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            con.close()

    def test_static_files_revalidate_with_etag(self):
        status, headers, body = self.raw_get("/app.css")
        self.assertEqual(status, 200)
        self.assertTrue(body)
        self.assertEqual(headers.get("Cache-Control"), "no-cache")
        etag = headers.get("ETag")
        self.assertTrue(etag)
        status, headers, body = self.raw_get("/app.css", {"If-None-Match": etag})
        self.assertEqual(status, 304)
        self.assertEqual(body, b"")

    def test_gzip_result_is_reused(self):
        first = self.raw_get("/katex.css", {"Accept-Encoding": "gzip"})
        second = self.raw_get("/katex.css", {"Accept-Encoding": "gzip"})
        self.assertEqual(first[1].get("Content-Encoding"), "gzip")
        self.assertEqual(first[2], second[2])
        self.assertTrue(self.runtime.gzip_cache)

    def test_api_responses_stay_no_store(self):
        status, headers, _raw = self.call("GET", "/api/health")
        self.assertEqual(headers.get("Cache-Control"), "no-store")

    def test_headers_are_not_sent_twice(self):
        con = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            con.request("GET", "/api/exchange/export")
            response = con.getresponse()
            names = [name.lower() for name, _value in response.getheaders()]
            response.read()
        finally:
            con.close()
        for name in ("content-type", "cache-control"):
            self.assertEqual(names.count(name), 1, name)


if __name__ == "__main__":
    unittest.main()
