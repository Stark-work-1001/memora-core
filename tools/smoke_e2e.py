# -*- coding: utf-8 -*-
"""端到端冒烟：真起服务、真打接口、真跑工作流、真跑 MCP，全部有证据。

    python tools/smoke_e2e.py [--keep]

与 tools/verify.py 的分工：
  verify.py  = 静态 + 单元 + 断言式验收（CI 用）
  smoke_e2e.py = 人看的"产品真的能用吗"演练（会打印真实返回）
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = []


def line(title, ok, detail=""):
    mark = "OK  " if ok else "FAIL"
    OUT.append({"title": title, "ok": ok, "detail": detail})
    print("[%s] %s%s" % (mark, title, ("  ->  " + str(detail)[:400]) if detail else ""))
    return ok


def free_port() -> int:
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p


def http(base, path, method="GET", body=None, timeout=60):
    data = json.dumps(body, ensure_ascii=False).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method)
    if data:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read().decode("utf-8", "replace")
            try:
                return r.status, json.loads(raw)
            except ValueError:
                return r.status, raw[:300]
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")[:300]
    except Exception as e:
        return -1, "%s: %s" % (type(e).__name__, e)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--keep", action="store_true")
    ap.add_argument("--data", default=None)
    args = ap.parse_args()

    data = Path(args.data) if args.data else Path(tempfile.mkdtemp(prefix="memora-smoke-"))
    data.mkdir(parents=True, exist_ok=True)
    port = free_port()
    base = "http://127.0.0.1:%d" % port
    print("data dir :", data)
    print("port     :", port)
    print()

    # ---------- 0. 种子
    rc, out = subprocess.getstatusoutput(
        '"%s" tools/seed_demo.py --data "%s" --reset' % (sys.executable, data))
    line("seed demo data", rc == 0, out.strip().splitlines()[-1] if out.strip() else "")

    # ---------- 1. 起服务
    proc = subprocess.Popen([sys.executable, "-m", "memora_core", "--data", str(data),
                             "serve", "--port", str(port)],
                            cwd=str(ROOT), stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True)
    up = False
    try:
        for _ in range(160):
            time.sleep(0.25)
            if proc.poll() is not None:
                break
            st, _b = http(base, "/api/health", timeout=2)
            if st == 200:
                up = True
                break
        ok = line("server up", up)
        if not ok:
            try:
                proc.kill()
                print((proc.stdout.read() or "")[-2000:])
            except Exception:
                pass
            return 1

        st, b = http(base, "/api/health")
        line("health", st == 200, json.dumps(b, ensure_ascii=False)[:300])

        st, b = http(base, "/api/overview")
        line("overview", st == 200, json.dumps(sorted(b.keys()) if isinstance(b, dict) else b))

        st, b = http(base, "/api/memories?limit=5")
        n = (b or {}).get("total") if isinstance(b, dict) else None
        line("list memories", st == 200 and (n or 0) > 0, "total=%s" % n)

        st, b = http(base, "/api/search?q=%s&limit=5" % "SQLite".replace(" ", "%20"))
        hits = (b or {}).get("hits") if isinstance(b, dict) else None
        line("search", st == 200 and bool(hits), "hits=%s degraded=%s" % (
            len(hits or []), (b or {}).get("degraded")))

        st, b = http(base, "/api/graph?view=semantic&limit=200")
        line("graph semantic", st == 200 and bool((b or {}).get("nodes")),
             "nodes=%s edges=%s" % (len((b or {}).get("nodes") or []), len((b or {}).get("edges") or [])))

        for view in ("hierarchy", "timeline", "evidence"):
            st, b = http(base, "/api/graph?view=%s&limit=200" % view)
            line("graph " + view, st == 200, "nodes=%s" % len((b or {}).get("nodes") or []))

        st, b = http(base, "/api/workflows")
        tpl = (b or {}).get("templates") or (b or {}).get("items") or []
        line("workflows list", st == 200, "templates=%d" % len(tpl))

        if tpl:
            tid = tpl[0].get("id")
            st, b = http(base, "/api/workflows/%s/run" % tid,
                         "POST", {"inputs": {}, "scope": "global"})
            line("workflow run", st in (200, 201, 202),
                 "status=%s steps=%s" % ((b or {}).get("status"), len((b or {}).get("steps") or [])))

        st, b = http(base, "/api/runs?limit=5")
        line("runs", st == 200, "runs=%s" % len((b or {}).get("runs") or (b or {}).get("items") or []))

        st, b = http(base, "/api/algorithms")
        alg = (b or {}).get("algorithms") or (b or {}).get("items") or []
        line("algorithms", st == 200 and len(alg) >= 20, "count=%d" % len(alg))

        st, b = http(base, "/api/agents")
        ag = (b or {}).get("agents") or (b or {}).get("items") or []
        line("agents", st == 200, "count=%d online=%d" % (
            len(ag), sum(1 for a in ag if a.get("status") == "online")))

        st, b = http(base, "/api/models")
        line("models", st == 200, json.dumps(b, ensure_ascii=False)[:200])

        st, b = http(base, "/api/documents?limit=5")
        line("documents", st == 200, "docs=%s" % ((b or {}).get("total") if isinstance(b, dict) else "?"))

        st, b = http(base, "/api/conflicts")
        line("conflicts", st == 200, "open=%s" % len((b or {}).get("conflicts") or []))

        st, b = http(base, "/")
        line("index.html", st == 200 and isinstance(b, str) and len(b) > 200, "bytes=%s" % (
            len(b) if isinstance(b, str) else "?"))

        for asset in ("/app.js", "/app.css", "/brain.js"):
            st, b = http(base, asset)
            line("static " + asset, st == 200, "bytes=%s" % (len(b) if isinstance(b, (str, bytes)) else "?"))

        # ---------- 写路径
        st, b = http(base, "/api/memories", "POST", {
            "title": "冒烟写入：一条可被检索到的记忆",
            "body": "这条记忆由 smoke_e2e.py 写入，用于验证写入-索引-检索的完整链路是否打通。",
            "kind": "fact", "scope_id": "global", "status": "approved",
        })
        mid = None
        if isinstance(b, dict):
            mid = (b.get("memory") or b).get("id")
        line("create memory", st in (200, 201) and bool(mid), mid)

        time.sleep(0.4)
        st, b = http(base, "/api/search?q=%s&limit=3" % "冒烟写入".replace(" ", "%20"))
        line("search after write", st == 200 and bool((b or {}).get("hits")),
             "hits=%d" % len((b or {}).get("hits") or []))

        if mid:
            st, b = http(base, "/api/memories/%s/review" % mid, "POST", {"grade": 5})
            line("review (SM-2)", st in (200, 201), json.dumps(b, ensure_ascii=False)[:200])

        # ---------- MCP stdio
        frames = [
            {"jsonrpc": "2.0", "id": 1, "method": "initialize",
             "params": {"protocolVersion": "2024-11-05", "capabilities": {},
                        "clientInfo": {"name": "smoke", "version": "1"}}},
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
            {"jsonrpc": "2.0", "id": 3, "method": "tools/call",
             "params": {"name": "memory_health", "arguments": {}}},
        ]
        payload = "".join(json.dumps(f, ensure_ascii=False) + "\n" for f in frames)
        p = subprocess.run([sys.executable, "-m", "memora_core", "--data", str(data), "mcp-stdio"],
                           input=payload, capture_output=True, text=True, timeout=120, cwd=str(ROOT))
        replies = []
        for ln in (p.stdout or "").splitlines():
            ln = ln.strip()
            if ln.startswith("{"):
                try:
                    replies.append(json.loads(ln))
                except ValueError:
                    pass
        server = next((r.get("result", {}).get("serverInfo") for r in replies if r.get("id") == 1), None)
        tools = next((r.get("result", {}).get("tools") for r in replies if r.get("id") == 2), [])
        call = next((r for r in replies if r.get("id") == 3), None)
        line("mcp initialize", bool(server), server)
        line("mcp tools/list", len(tools or []) >= 15, "tools=%d" % len(tools or []))
        line("mcp tools/call", bool(call and "result" in call), json.dumps(call, ensure_ascii=False)[:240])
    finally:
        try:
            proc.terminate(); proc.wait(timeout=10)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass

    passed = sum(1 for o in OUT if o["ok"])
    print()
    print("==== %d passed / %d failed ====" % (passed, len(OUT) - passed))
    rep = ROOT / "reports" / "SMOKE.json"
    rep.parent.mkdir(parents=True, exist_ok=True)
    rep.write_text(json.dumps({"passed": passed, "results": OUT}, ensure_ascii=False, indent=2),
                   encoding="utf-8")
    print("report ->", rep)
    if not args.keep and not args.data:
        shutil.rmtree(data, ignore_errors=True)
    else:
        print("data kept at", data)
    return 0 if passed == len(OUT) else 1


if __name__ == "__main__":
    raise SystemExit(main())
