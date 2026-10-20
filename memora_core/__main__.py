# -*- coding: utf-8 -*-
"""memora-core 命令行入口。

    python -m memora_core setup                  # 初始化数据目录与数据库（幂等）
    python -m memora_core serve [--port 8790]    # 启动 HTTP API + 前端
    python -m memora_core mcp-stdio              # 以 MCP stdio 服务器运行（给智能体接入）
    python -m memora_core selftest               # 自检（不联网）
    python -m memora_core export --out x.jsonl   # 导出统一交换格式
    python -m memora_core import --in x.jsonl    # 导入
    python -m memora_core seed                   # 重新灌入内置模板/算法/智能体
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import __version__
from . import db as dbm
from .paths import Paths


def _data(args) -> Paths:
    return Paths(getattr(args, "data", None)).ensure()


def cmd_setup(args) -> int:
    paths = _data(args)
    dbm.init_db(paths.db)
    con = dbm.connect(paths.db)
    try:
        info = dbm.health(con)
    finally:
        con.close()
    seeded = {}
    try:
        from . import workflows, agents as agents_mod
        if hasattr(workflows, "seed_templates"):
            seeded["templates"] = workflows.seed_templates(_store(paths))
        if hasattr(agents_mod, "seed_agents"):
            seeded["agents"] = agents_mod.seed_agents(_store(paths))
    except Exception as exc:
        seeded["skipped"] = f"{type(exc).__name__!s}: {exc!s}"
    _seed_algorithms(paths)
    print(json.dumps({"version": __version__, "data": str(paths.root),
                      "integrity": info["integrity"], "seeded": seeded,
                      "counts": info["counts"]}, ensure_ascii=False, indent=2))
    return 0 if info["ok"] else 1


def _store(paths: Paths):
    from .store import Store
    from .vault import Vault
    return Store(paths.db, Vault(paths.vault))


def _seed_algorithms(paths: Paths) -> int:
    """把内置算法目录写入 memory_algo（只做展示与元数据，不执行）。"""
    algos = dbm.read_builtin("algorithms.json") or []
    con = dbm.connect(paths.db)
    try:
        with dbm.transaction(con):
            for a in algos:
                con.execute(
                    "INSERT OR REPLACE INTO memory_algo(id,name,category,summary,detail,formula,"
                    "reference,offline,runnable,params) VALUES(?,?,?,?,?,?,?,?,?,?)",
                    (a["id"], a["name"], a["category"], a["summary"], a.get("detail", ""),
                     a.get("formula"), a.get("reference"), int(a.get("offline", 1)),
                     int(a.get("runnable", 0)), dbm.dumps(a.get("params", {}))))
        return len(algos)
    finally:
        con.close()


def cmd_seed(args) -> int:
    paths = _data(args)
    dbm.init_db(paths.db)
    n = _seed_algorithms(paths)
    out = {"algorithms": n}
    try:
        from . import workflows
        out["templates"] = workflows.seed_templates(_store(paths))
    except Exception as exc:
        out["templates_error"] = f"{type(exc).__name__!s}: {exc!s}"
    try:
        from . import agents as agents_mod
        out["agents"] = agents_mod.seed_agents(_store(paths))
    except Exception as exc:
        out["agents_error"] = f"{type(exc).__name__!s}: {exc!s}"
    print(json.dumps(out, ensure_ascii=False, indent=2))
    return 0


def cmd_serve(args) -> int:
    paths = _data(args)
    dbm.init_db(paths.db)
    _seed_algorithms(paths)
    try:
        from .server import serve
    except Exception as exc:
        print(f"server module unavailable: {type(exc).__name__!s}: {exc!s}", file=sys.stderr)
        return 2
    return serve(paths, port=args.port, host=args.host, open_ui=args.open)


def cmd_mcp(args) -> int:
    paths = _data(args)
    dbm.init_db(paths.db)
    try:
        from .mcp import run_stdio
    except Exception as exc:
        print(f"mcp module unavailable: {type(exc).__name__!s}: {exc!s}", file=sys.stderr)
        return 2
    return run_stdio(paths)


def cmd_selftest(args) -> int:
    from .selftest import run_selftest
    return run_selftest(_data(args), verbose=args.verbose)


def cmd_export(args) -> int:
    paths = _data(args)
    from .exchange import export_jsonl
    store = _store(paths)
    text = export_jsonl(store, scope=args.scope, status=args.status,
                        include_secret=args.include_secret)
    if args.out:
        # write_bytes：JSONL 一律 LF（write_text 在 Windows 上会写成 CRLF）
        Path(args.out).write_bytes(text.encode("utf-8"))
        print(json.dumps({"written": args.out, "bytes": len(text.encode())}, ensure_ascii=False))
    else:
        sys.stdout.write(text)
    return 0


def cmd_import(args) -> int:
    paths = _data(args)
    from .exchange import import_jsonl
    store = _store(paths)
    text = Path(args.inp).read_text(encoding="utf-8")
    out = import_jsonl(store, text, agent_id=args.agent, scope=args.scope, trust=args.trust)
    print(json.dumps(out, ensure_ascii=False, indent=2))
    return 0


def cmd_doctor(args) -> int:
    paths = _data(args)
    dbm.init_db(paths.db)
    con = dbm.connect(paths.db)
    try:
        h = dbm.health(con, deep=True)
    finally:
        con.close()
    report = {"version": __version__, "data": paths.as_dict(), "db": h,
              "builtin": {"algorithms": len(dbm.read_builtin("algorithms.json") or []),
                          "templates": len(dbm.read_builtin("workflow_templates.json") or []),
                          "agents": len(dbm.read_builtin("agents.json") or []),
                          "prompts": len(dbm.read_builtin("prompts.json") or [])}}
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if h["ok"] else 1


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="memora_core", description="memora-core / 记忆中枢")
    ap.add_argument("--version", action="version", version="memora-core " + __version__)
    ap.add_argument("--data", default=None, help="数据目录（默认 ./data）")
    sub = ap.add_subparsers(dest="cmd")

    p = sub.add_parser("setup"); p.set_defaults(fn=cmd_setup)
    p = sub.add_parser("serve"); p.set_defaults(fn=cmd_serve)
    p.add_argument("--port", type=int, default=8790)
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--open", action="store_true", help="启动后尝试打开浏览器")
    p = sub.add_parser("mcp-stdio"); p.set_defaults(fn=cmd_mcp)
    p = sub.add_parser("selftest"); p.set_defaults(fn=cmd_selftest)
    p.add_argument("--verbose", action="store_true")
    p = sub.add_parser("seed"); p.set_defaults(fn=cmd_seed)
    p = sub.add_parser("doctor"); p.set_defaults(fn=cmd_doctor)
    p = sub.add_parser("export"); p.set_defaults(fn=cmd_export)
    p.add_argument("--out", default=None)
    p.add_argument("--scope", default=None)
    p.add_argument("--status", default="approved")
    p.add_argument("--include-secret", action="store_true",
                   help="连 sensitivity=secret 的记忆一起导出（默认不导出）")
    p = sub.add_parser("import"); p.set_defaults(fn=cmd_import)
    p.add_argument("--in", dest="inp", required=True)
    p.add_argument("--agent", default=None)
    p.add_argument("--scope", default="global")
    p.add_argument("--trust", choices=("cap", "preserve"), default="cap",
                   help="cap（默认）：导入文件不受信，approved 降为 candidate；"
                        "preserve：原样恢复你自己的备份（ADR-0002）")
    return ap


def main(argv=None) -> int:
    ap = build_parser()
    args = ap.parse_args(argv)
    if not getattr(args, "cmd", None):
        ap.print_help()
        return 0
    return int(args.fn(args) or 0)


if __name__ == "__main__":
    raise SystemExit(main())
