# -*- coding: utf-8 -*-
"""端到端自检：不联网、不依赖外部服务，覆盖"内存中立的真源 + 检索 + 工作流 + 协议"。

设计原则：**每一项独立可跳过**。某个模块还没实现时报告 skip 而不是崩掉，
这样在并行开发期也能反复运行，最后一份报告就是验收证据。

    python -m memora_core selftest [--verbose]

输出 JSON：{ok, passed, failed, skipped, checks:[{name, status, ms, detail}]}
"""
from __future__ import annotations

import json
import shutil
import sys
import tempfile
import time
import traceback
from pathlib import Path

from . import db as dbm
from .paths import Paths

RESULT: list[dict] = []


def check(name):
    def deco(fn):
        def run(paths: Paths, verbose: bool):
            t0 = time.perf_counter()
            try:
                detail = fn(paths, verbose)
                status = "pass"
            except NotImplementedError as exc:
                detail, status = str(exc) or "not implemented", "skip"
            except Exception as exc:  # noqa: BLE001
                detail = "%s: %s" % (type(exc).__name__, exc)
                if verbose:
                    detail += "\n" + traceback.format_exc()
                status = "fail"
            ms = int((time.perf_counter() - t0) * 1000)
            RESULT.append({"name": name, "status": status, "ms": ms, "detail": str(detail)[:1200]})
            return status
        run._name = name  # type: ignore[attr-defined]
        return run
    return deco


# --------------------------------------------------------------------------- checks
@check("db.schema")
def c_schema(paths, verbose):
    dbm.init_db(paths.db)
    con = dbm.connect(paths.db)
    try:
        h = dbm.health(con, deep=True)
    finally:
        con.close()
    if not h["ok"]:
        raise RuntimeError("integrity: " + str(h["integrity"]))
    missing = h["tables"]["missing"]
    if missing:
        raise RuntimeError("missing tables: " + ",".join(missing))
    return "%d tables + %d FTS, schema v%d, sqlite %s, db %d bytes" % (
        h["tables"]["real"], h["tables"]["virtual"], h["schema_version"], h["sqlite"],
        h["db_bytes"])


@check("builtin.assets")
def c_assets(paths, verbose):
    out = {}
    for name in ("workflow_templates.json", "algorithms.json", "agents.json", "prompts.json"):
        data = dbm.read_builtin(name)
        if data is None:
            raise RuntimeError("missing builtin: " + name)
        out[name.split(".")[0]] = len(data)
    if out["workflow_templates"] < 10:
        raise RuntimeError("too few workflow templates: %d" % out["workflow_templates"])
    return json.dumps(out, ensure_ascii=False)


@check("store.crud")
def c_store(paths, verbose):
    from .store import Store
    from .vault import Vault
    store = Store(paths.db, Vault(paths.vault))
    scope = store.ensure_scope("global", "global", "全局")
    mem = store.add_memory({
        "title": "自检记忆：memora-core 使用 SQLite 作为事务真源",
        "body": "记忆中枢把 SQLite 作为唯一写入真源，Markdown 只是可读镜像。",
        "kind": "fact", "scope_id": scope["id"], "status": "approved", "trust": 0.9,
    })
    got = store.get_memory(mem["id"])
    if not got or got["title"] != mem["title"]:
        raise RuntimeError("get_memory mismatch")
    listed = store.list_memories({"q": "事务真源", "limit": 5})
    if not listed.get("items"):
        raise RuntimeError("fts search returned nothing")
    st = store.stats() if hasattr(store, "stats") else {}
    return "memory=%s fts_hits=%d stats_keys=%d" % (mem["id"], len(listed["items"]), len(st))


@check("vault.mirror")
def c_vault(paths, verbose):
    from .store import Store
    from .vault import Vault
    vault = Vault(paths.vault)
    store = Store(paths.db, vault)
    items = store.list_memories({"limit": 1}).get("items") or []
    if not items:
        raise RuntimeError("no memory to mirror")
    rel = vault.write_memory(items[0], store.list_evidence(items[0]["id"]), store.list_blocks(items[0]["id"]))
    path = paths.vault / rel
    if not path.exists():
        raise RuntimeError("mirror file missing: " + str(path))
    text = path.read_text(encoding="utf-8")
    if "---" not in text.split("\n")[0]:
        raise RuntimeError("front-matter missing")
    return "%s (%d bytes)" % (rel, len(text.encode()))


@check("retrieval.search")
def c_search(paths, verbose):
    from .store import Store
    from .vault import Vault
    from . import retrieval
    store = Store(paths.db, Vault(paths.vault))
    gw = None
    try:
        from .models import ModelGateway
        gw = ModelGateway(store)
    except Exception:
        gw = None
    res = retrieval.search(store, gw, "事务真源 Markdown 镜像", scope="global", limit=5)
    hits = res.get("hits") or []
    if not hits:
        raise RuntimeError("no hits")
    return "hits=%d degraded=%s took=%sms" % (len(hits), res.get("degraded"), res.get("took_ms"))


@check("workflows.registry")
def c_workflows(paths, verbose):
    from . import workflows
    from .store import Store
    from .vault import Vault
    store = Store(paths.db, Vault(paths.vault))
    n = workflows.seed_templates(store)
    tpls = workflows.list_templates(store)
    handlers = getattr(workflows, "NODE_HANDLERS", {})
    need = {"input", "transform", "extract", "classify", "retrieve", "embed", "rerank", "fuse",
            "judge", "verify", "persist", "index", "graph", "generate", "decide", "schedule", "emit"}
    missing = sorted(need - set(handlers))
    if missing:
        raise RuntimeError("missing node handlers: " + ",".join(missing))
    return "templates=%d (seeded %d) handlers=%d" % (len(tpls), n, len(handlers))


@check("workflows.run")
def c_workflow_run(paths, verbose):
    from . import workflows
    from .store import Store
    from .vault import Vault
    store = Store(paths.db, Vault(paths.vault))
    gw = None
    try:
        from .models import ModelGateway
        gw = ModelGateway(store)
    except Exception:
        gw = None
    run = workflows.run_workflow(store, gw, "hybrid-recall-rerank",
                                 {"query": "事务真源", "scope": "global", "budget": 400},
                                 scope="global", trigger="selftest")
    if not run or run.get("status") not in ("ok", "partial"):
        raise RuntimeError("run status=%s error=%s" % (run or {}).get("status"), (run or {}).get("error"))
    steps = run.get("steps") or []
    return "run=%s status=%s steps=%d degraded=%d" % (
        run.get("id"), run.get("status"), len(steps), sum(1 for s in steps if s.get("degraded")))


@check("graph.views")
def c_graph(paths, verbose):
    from .store import Store
    from .vault import Vault
    store = Store(paths.db, Vault(paths.vault))
    out = {}
    for view in ("semantic", "hierarchy", "timeline", "evidence"):
        g = store.graph(view, None, 200)
        json.dumps(g)  # 必须可序列化
        out[view] = (len(g.get("nodes") or []), len(g.get("edges") or []))
    return json.dumps(out, ensure_ascii=False)


@check("agents.probe")
def c_agents(paths, verbose):
    from . import agents as agents_mod
    from .store import Store
    from .vault import Vault
    store = Store(paths.db, Vault(paths.vault))
    n = agents_mod.seed_agents(store)
    res = agents_mod.probe_all(store)
    status = agents_mod.agent_status(store)
    return "seeded=%d probed=%d agents=%d" % (n, len(res.get("results", res)), len(status))


@check("models.health")
def c_models(paths, verbose):
    from .models import ModelGateway
    from .store import Store
    from .vault import Vault
    store = Store(paths.db, Vault(paths.vault))
    gw = ModelGateway(store)
    h = gw.health()
    roles = sorted(h.keys())
    if "chat" not in roles:
        raise RuntimeError("health missing chat role")
    degraded = sum(1 for v in h.values() if not v.get("ok"))
    return "roles=%s degraded=%d" % (",".join(roles), degraded)


@check("mcp.handshake")
def c_mcp(paths, verbose):
    from . import mcp as mcp_mod
    tools = mcp_mod.list_tool_names() if hasattr(mcp_mod, "list_tool_names") else None
    if tools is None:
        tools = sorted(getattr(mcp_mod, "TOOLS", {}).keys())
    if len(tools) < 15:
        raise RuntimeError("too few MCP tools: %d" % len(tools))
    required = {"memory_recall", "memory_remember", "memory_capture", "memory_digest"}
    missing = required - set(tools)
    if missing:
        raise RuntimeError("missing tools: " + ",".join(sorted(missing)))
    return "%d tools" % len(tools)


@check("exchange.roundtrip")
def c_exchange(paths, verbose):
    from .exchange import export_jsonl, import_jsonl
    from .store import Store
    from .vault import Vault
    store = Store(paths.db, Vault(paths.vault))
    text = export_jsonl(store, scope=None, status="approved")
    if not text.strip():
        raise RuntimeError("export empty")
    out = import_jsonl(store, text, agent_id="selftest", scope="global")
    return "export_bytes=%d import=%s" % (len(text.encode()), json.dumps(out, ensure_ascii=False)[:300])


@check("server.routes")
def c_server(paths, verbose):
    from . import server
    routes = getattr(server, "ROUTES", None)
    if routes is None:
        raise NotImplementedError("server.ROUTES 未导出")
    need = {"/api/health", "/api/memories", "/api/search", "/api/graph", "/api/workflows", "/api/events"}
    missing = need - {r if isinstance(r, str) else r[0] for r in routes}
    if missing:
        raise RuntimeError("missing routes: " + ",".join(sorted(missing)))
    return "%d routes" % len(routes)


@check("frontend.assets")
def c_frontend(paths, verbose):
    static = Path(__file__).resolve().parent / "static"
    # index.html 是 SPA 外壳，本来就只有几百字节；真正的大件是 app.js / app.css / brain.js。
    need = ["index.html", "app.js", "app.css", "brain.js"]
    floors = {"index.html": 200, "app.js": 50000, "app.css": 5000, "brain.js": 50000}
    sizes = {}
    for name in need:
        p = static / name
        if not p.exists():
            raise RuntimeError("missing static: " + name)
        sizes[name] = p.stat().st_size
        if sizes[name] < floors.get(name, 1000):
            raise RuntimeError("suspiciously small: %s (%d bytes < %d)"
                               % (name, sizes[name], floors.get(name, 1000)))
    return json.dumps(sizes)


CHECKS = [c_schema, c_assets, c_store, c_vault, c_search, c_workflows, c_workflow_run,
          c_graph, c_agents, c_models, c_mcp, c_exchange, c_server, c_frontend]


def run_selftest(paths: Paths, verbose: bool = False, keep: bool = False) -> int:
    tmp = Path(tempfile.mkdtemp(prefix="memora-selftest-"))
    original_db, original_vault = paths.db, paths.vault
    try:
        paths.db = tmp / "memora.db"
        paths.vault = tmp / "vault"
        paths.vault.mkdir(parents=True, exist_ok=True)
        for fn in CHECKS:
            fn(paths, verbose)
    finally:
        paths.db, paths.vault = original_db, original_vault
        if not keep:
            shutil.rmtree(tmp, ignore_errors=True)
    passed = sum(1 for r in RESULT if r["status"] == "pass")
    failed = sum(1 for r in RESULT if r["status"] == "fail")
    skipped = sum(1 for r in RESULT if r["status"] == "skip")
    report = {"ok": failed == 0, "passed": passed, "failed": failed, "skipped": skipped,
              "checks": RESULT}
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if failed == 0 else 1


if __name__ == "__main__":  # pragma: no cover
    p = Paths(sys.argv[1] if len(sys.argv) > 1 else None).ensure()
    raise SystemExit(run_selftest(p, verbose=True))
