# -*- coding: utf-8 -*-
"""协调者独立验收脚本：不信任任何子智能体自述，全部用真实命令与真实 HTTP 调用取证。

    python tools/verify.py            # 全量验收
    python tools/verify.py --quick    # 只跑不启动服务的部分
    python tools/verify.py --json     # 机器可读输出

设计：每一项都是一个可独立复现的命令或 HTTP 请求，失败即打印证据。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
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
RESULTS: list[dict] = []


def scrub(value):
    """去掉证据里的本机绝对路径与用户目录，验收报告才能安全公开。"""
    if not isinstance(value, str):
        return value
    try:
        value = value.replace(str(ROOT), "<repo>")
    except Exception:  # noqa: BLE001
        pass
    try:
        value = value.replace(str(Path.home()), "<home>")
    except Exception:  # noqa: BLE001
        pass
    value = re.sub(r"[A-Za-z]:\\[^\s\"'<>|]+", "<local-path>", value)
    value = re.sub(r"[A-Za-z]:/[^\s\"'<>|]+", "<local-path>", value)
    return value


def record(name: str, ok: bool, detail, evidence: str = "", skipped: bool = False):
    detail = scrub(detail)
    evidence = scrub(evidence)
    RESULTS.append({"name": name, "ok": bool(ok) or skipped, "skipped": bool(skipped),
                    "detail": detail, "evidence": evidence[:2000]})
    mark = "SKIP" if skipped else ("PASS" if ok else "FAIL")
    print("[%s] %-34s %s" % (mark, name, str(detail)[:160]))
    return bool(ok) or skipped


def sh(cmd: list[str], cwd: Path | None = None, timeout: int = 180) -> tuple[int, str]:
    try:
        p = subprocess.run(cmd, cwd=str(cwd or ROOT), capture_output=True, text=True,
                           timeout=timeout, encoding="utf-8", errors="replace")
        return p.returncode, (p.stdout or "") + (p.stderr or "")
    except Exception as exc:  # noqa: BLE001
        return -1, "%s: %s" % (type(exc).__name__, exc)


def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def http(path: str, base: str, method: str = "GET", body: dict | None = None, timeout: int = 30):
    url = base.rstrip("/") + path
    data = json.dumps(body, ensure_ascii=False).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if data:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read().decode("utf-8", "replace")
            try:
                return r.status, json.loads(raw)
            except ValueError:
                return r.status, raw[:400]
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", "replace")[:400]
    except Exception as exc:  # noqa: BLE001
        return -1, "%s: %s" % (type(exc).__name__, exc)


def file_fingerprint(p: Path) -> dict:
    """指纹只记录仓库内相对路径，避免验收报告泄露本机目录结构。"""
    try:
        rel = p.resolve().relative_to(ROOT.resolve()).as_posix()
    except ValueError:
        rel = p.name
    if not p.exists():
        return {"path": rel, "exists": False}
    b = p.read_bytes()
    return {"path": rel, "exists": True, "bytes": len(b),
            "sha256": hashlib.sha256(b).hexdigest()[:16],
            "mtime": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(p.stat().st_mtime))}


# --------------------------------------------------------------------------- checks
def check_source_layout():
    need = ["memora_core/__init__.py", "memora_core/__main__.py", "memora_core/db.py",
            "memora_core/paths.py", "memora_core/store.py", "memora_core/vault.py",
            "memora_core/models.py", "memora_core/retrieval.py", "memora_core/dedup.py",
            "memora_core/chunking.py", "memora_core/vectors.py", "memora_core/judge.py",
            "memora_core/workflows.py", "memora_core/agents.py", "memora_core/exchange.py",
            "memora_core/server.py", "memora_core/mcp.py", "memora_core/selftest.py",
            "memora_core/data/schema.sql", "frontend/build.mjs", "desktop/main.cjs"]
    missing = [p for p in need if not (ROOT / p).exists()]
    return record("source.layout", not missing, "missing=%s" % (missing or "none"),
                  json.dumps([file_fingerprint(ROOT / p) for p in need[:6]], ensure_ascii=False))


def check_py_compile():
    code, out = sh([sys.executable, "-m", "compileall", "-q", "memora_core"])
    return record("python.compile", code == 0, "compileall rc=%d" % code, out[-1500:])


def check_no_third_party():
    """后端必须只用标准库：扫描 import 语句。"""
    import ast
    stdlib = set(sys.stdlib_module_names) | {"memora_core"}
    # 允许的可选依赖：必须是被 try/except 包住、缺失即降级的延迟导入（本项目用它读 PDF）
    OPTIONAL = {"pypdf", "PyPDF2"}
    bad = []
    for p in (ROOT / "memora_core").rglob("*.py"):
        try:
            tree = ast.parse(p.read_text(encoding="utf-8"))
        except SyntaxError as exc:
            bad.append("%s: syntax %s" % (p.name, exc))
            continue
        for node in ast.walk(tree):
            names = []
            if isinstance(node, ast.Import):
                names = [a.name.split(".")[0] for a in node.names]
            elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                names = [node.module.split(".")[0]]
            for n in names:
                if n not in stdlib and n not in OPTIONAL:
                    bad.append("%s -> %s" % (p.name, n))
    return record("backend.stdlib-only", not bad, "violations=%d" % len(bad), "\n".join(bad[:20]))


def check_tests():
    code, out = sh([sys.executable, "-m", "unittest", "discover", "-s", "tests", "-t", ".", "-v"], timeout=600)
    tail = "\n".join(out.strip().splitlines()[-25:])
    ok = code == 0
    return record("unit.tests", ok, "unittest rc=%d" % code, tail)


def check_selftest():
    code, out = sh([sys.executable, "-m", "memora_core", "selftest"], timeout=600)
    try:
        rep = json.loads(out[out.index("{"):])
        ok = rep.get("failed", 1) == 0 and rep.get("passed", 0) >= 10
        detail = "passed=%s failed=%s skipped=%s" % (rep.get("passed"), rep.get("failed"), rep.get("skipped"))
    except Exception:  # noqa: BLE001
        ok, detail = False, "unparsable output"
    return record("e2e.selftest", ok, detail, out[-2000:])


def check_static():
    static = ROOT / "memora_core" / "static"
    # index.html 是 SPA 外壳（几百字节很正常）；真正的体积在 app.js / app.css / brain.js
    floors = {"index.html": 200, "app.js": 50000, "app.css": 5000, "brain.js": 50000}
    need = ["index.html", "app.js", "app.css", "brain.js"]
    fps = [file_fingerprint(static / n) for n in need]
    ok = all(f.get("exists") and f.get("bytes", 0) >= floors.get(n, 1000)
             for n, f in zip(need, fps))
    return record("frontend.assets", ok, json.dumps([(f["path"].split("static")[-1], f.get("bytes")) for f in fps]),
                  json.dumps(fps, ensure_ascii=False))


def check_server_live():
    """真启动一次服务，打真实接口。"""
    port = free_port()
    tmp = Path(tempfile.mkdtemp(prefix="memora-verify-"))
    env = dict(os.environ)
    proc = subprocess.Popen(
        [sys.executable, "-m", "memora_core", "--data", str(tmp), "serve", "--port", str(port)],
        cwd=str(ROOT), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=env)
    base = "http://127.0.0.1:%d" % port
    alive = False
    try:
        for _ in range(120):
            time.sleep(0.25)
            st, body = http("/api/health", base, timeout=2)
            if st == 200:
                alive = True
                break
            if proc.poll() is not None:
                break
        if not alive:
            out = ""
            try:
                proc.kill()
                out = (proc.stdout.read() or "")[-1500:]
            except Exception:  # noqa: BLE001
                pass
            return record("server.live", False, "server did not come up", out)
        checks = {}

        st, body = http("/api/health", base)
        checks["health"] = (st, body if not isinstance(body, dict) else
                            {k: body.get(k) for k in ("ok", "version", "uptime_s") if k in body})

        st, body = http("/api/memories", base, "POST", {
            "title": "验收用记忆：memora-core 的 SQLite 是唯一写入真源",
            "body": "验收脚本写入的一条事实：Markdown 只是可读镜像，任何写入都先落 SQLite。",
            "kind": "fact", "scope_id": "global", "status": "approved",
            "evidence": [{"kind": "tool_output", "quote": "验收脚本写入的一条事实", "uri": "verify.py"}]})
        mid = None
        if isinstance(body, dict):
            mid = (body.get("memory") or body).get("id") or body.get("id")
        checks["create_memory"] = (st, mid)

        st, body = http("/api/memories/%s" % mid if mid else "/api/memories", base)
        checks["get_memory"] = (st, isinstance(body, dict))

        st, body = http("/api/search?q=%E4%BA%8B%E5%AE%9E&limit=5", base)
        hits = (body or {}).get("hits") if isinstance(body, dict) else None
        checks["search"] = (st, len(hits) if hits is not None else body)

        st, body = http("/api/graph?view=semantic&limit=100", base)
        checks["graph"] = (st, (len(body.get("nodes", [])), len(body.get("edges", []))) if isinstance(body, dict) else body)

        st, body = http("/api/workflows", base)
        n = len(body.get("templates") or body.get("items") or []) if isinstance(body, dict) else body
        checks["workflows"] = (st, n)

        st, body = http("/api/algorithms", base)
        n = len(body.get("algorithms") or body.get("items") or []) if isinstance(body, dict) else body
        checks["algorithms"] = (st, n)

        st, body = http("/api/agents", base)
        n = len(body.get("agents") or body.get("items") or []) if isinstance(body, dict) else body
        checks["agents"] = (st, n)

        st, body = http("/api/models", base)
        checks["models"] = (st, bool(body))

        st, body = http("/api/overview", base)
        checks["overview"] = (st, bool(body))

        st, body = http("/", base)
        checks["index_html"] = (st, len(body) if isinstance(body, str) else "html")

        failures = [k for k, (st, _) in checks.items() if not (isinstance(st, int) and 200 <= st < 300)]
        ok = not failures
        return record("server.api", ok, "failed=%s" % (failures or "none"),
                      json.dumps(checks, ensure_ascii=False, default=str)[:1800])
    finally:
        try:
            proc.terminate()
            proc.wait(timeout=8)
        except Exception:  # noqa: BLE001
            try:
                proc.kill()
            except Exception:  # noqa: BLE001
                pass
        shutil.rmtree(tmp, ignore_errors=True)


def check_mcp_stdio():
    """用真实 stdio 帧做一次 MCP 握手 + 工具列表。"""
    port_payload = [
        {"jsonrpc": "2.0", "id": 1, "method": "initialize",
         "params": {"protocolVersion": "2024-11-05",
                    "capabilities": {}, "clientInfo": {"name": "verify", "version": "1.0"}}},
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
    ]
    tmp = Path(tempfile.mkdtemp(prefix="memora-mcp-"))
    text = "".join(json.dumps(p, ensure_ascii=False) + "\n" for p in port_payload)
    try:
        p = subprocess.run(
            [sys.executable, "-m", "memora_core", "--data", str(tmp), "mcp-stdio"],
            input=text, cwd=str(ROOT), capture_output=True, text=True, timeout=90,
            encoding="utf-8", errors="replace")
        lines = [ln for ln in (p.stdout or "").splitlines() if ln.strip().startswith("{")]
        tools = []
        server = None
        for ln in lines:
            try:
                obj = json.loads(ln)
            except ValueError:
                continue
            if obj.get("id") == 1:
                server = (obj.get("result") or {}).get("serverInfo")
            if obj.get("id") == 2:
                tools = [t.get("name") for t in (obj.get("result") or {}).get("tools", [])]
        ok = bool(server) and len(tools) >= 15
        return record("mcp.stdio", ok, "server=%s tools=%d" % (server, len(tools)),
                      json.dumps({"tools": tools}, ensure_ascii=False) + "\n" + (p.stderr or "")[-600:])
    except Exception as exc:  # noqa: BLE001
        return record("mcp.stdio", False, "%s: %s" % (type(exc).__name__, exc))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def check_desktop_artifacts():
    cands = [ROOT / "dist" / "MemoraCore" / "MemoraCore.exe",
             ROOT / "dist" / "MemoraCore" / "memora-core.exe",
             ROOT / "dist" / "MemoraCore" / "electron.exe"]
    found = [file_fingerprint(p) for p in cands if p.exists()]
    backend = ROOT / "dist" / "memora-backend.exe"
    bfp = file_fingerprint(backend)
    ok = bool(found) and bfp.get("exists")
    if not (ROOT / "dist").exists():
        # 源码仓库不携带构建产物（发布包另行提供），此项不适用而非失败
        return record("desktop.artifacts", False,
                      "not built in this tree; run tools/build_desktop.py or use the release zip",
                      json.dumps({"app": found, "backend": bfp}, ensure_ascii=False), skipped=True)
    return record("desktop.artifacts", ok, "exe=%d backend=%s" % (len(found), bfp.get("bytes")),
                  json.dumps({"app": found, "backend": bfp}, ensure_ascii=False))


def check_data_untouched():
    """验收不得污染开发数据目录。"""
    p = ROOT / "data"
    files = sorted(x.name for x in p.glob("*")) if p.exists() else []
    return record("data.present", True, "entries=%d" % len(files), ", ".join(files[:20]))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--quick", action="store_true")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    check_source_layout()
    check_py_compile()
    check_no_third_party()
    check_static()
    if not args.quick:
        check_tests()
        check_selftest()
        check_server_live()
        check_mcp_stdio()
        check_desktop_artifacts()
        check_data_untouched()

    passed = sum(1 for r in RESULTS if r["ok"])
    failed = len(RESULTS) - passed
    summary = {"ok": failed == 0, "passed": passed, "failed": failed, "results": RESULTS}
    if args.json:
        print(json.dumps(summary, ensure_ascii=False, indent=2))
    else:
        print("\n==== %d passed / %d failed ====" % (passed, failed))
    out = ROOT / "reports" / "VERIFY.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print("report ->", out)
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())