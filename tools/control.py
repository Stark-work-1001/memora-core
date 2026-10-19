#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""memora-core / 记忆中枢 — 协调者控制面。

这是一个标准库实现的 HTTP 服务，用于让多路子智能体并行工作而互不阻塞：
  * 任务看板（派发 / 认领 / 更新状态 / 备注）
  * 插槽锁（同一文件/模块只允许一个持有者）
  * 结构化问答（子智能体把阻塞问题留在问答板，由协调者解决）
  * 决定记录（architecture decisions）
  * 变更日志（谁写了哪个文件）

子智能体通过 "python tools/control.py ..." 的 CLI 访问（可加 --port 指定端口，默认取
环境变量 MEMORA_CONTROL_PORT，缺省 8899）。不要直接改这个文件。

用法示例：
  python tools/control.py serve --port 8899
  python tools/control.py board
  python tools/control.py claim T1 --owner backend-core
  python tools/control.py ask "问题正文" --kinds docs
  python tools/control.py say "进展"
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import threading
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent.parent
STATE = ROOT / ".control"
DB_PATH = STATE / "control.db"
SCHEMA = """
CREATE TABLE IF NOT EXISTS task (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, owner TEXT, status TEXT NOT NULL DEFAULT 'todo',
  priority INTEGER NOT NULL DEFAULT 0, deps TEXT NOT NULL DEFAULT '[]',
  brief TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS slot (
  name TEXT PRIMARY KEY, owner TEXT, note TEXT, taken_at TEXT);
CREATE TABLE IF NOT EXISTS question (
  id TEXT PRIMARY KEY, asker TEXT, body TEXT NOT NULL, kinds TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'open', answer TEXT, answered_by TEXT,
  created_at TEXT NOT NULL, answered_at TEXT);
CREATE TABLE IF NOT EXISTS decision (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
  owner TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS intent (
  id TEXT PRIMARY KEY, owner TEXT, body TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS change_log (
  id TEXT PRIMARY KEY, owner TEXT, paths TEXT NOT NULL DEFAULT '[]', note TEXT,
  created_at TEXT NOT NULL);
"""

_LOCK = threading.Lock()


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def uid(prefix: str) -> str:
    return prefix + "-" + uuid.uuid4().hex[:10]


def connect() -> sqlite3.Connection:
    STATE.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DB_PATH, timeout=15, check_same_thread=False)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA busy_timeout=8000")
    return con


def init() -> None:
    with _LOCK, connect() as con:
        con.executescript(SCHEMA)


def rows(con, sql, args=()):
    return [dict(r) for r in con.execute(sql, args).fetchall()]


def op_dispatch(con, payload):
    tasks = payload.get("tasks") or []
    out = []
    with con:
        for t in tasks:
            tid = t.get("id") or uid("T")
            con.execute(
                "INSERT OR REPLACE INTO task(id,title,owner,status,priority,deps,brief,notes,created_at,updated_at)"
                " VALUES(?,?,?,?,?,?,?,?,?,?)",
                (tid, t.get("title", ""), t.get("owner"), t.get("status", "todo"),
                 int(t.get("priority", 0)), json.dumps(t.get("deps", []), ensure_ascii=False),
                 t.get("brief", ""), json.dumps(t.get("notes", []), ensure_ascii=False), now(), now()))
            out.append(tid)
    return {"dispatched": out}


def op_claim(con, payload):
    tid, owner = payload["id"], payload["owner"]
    with con:
        cur = con.execute("UPDATE task SET owner=?, status='doing', updated_at=? WHERE id=?",
                          (owner, now(), tid))
        if cur.rowcount == 0:
            raise KeyError("task not found: " + tid)
    return {"claimed": tid, "owner": owner}


def op_status(con, payload):
    tid, status = payload["id"], payload["status"]
    note = payload.get("note")
    with con:
        row = con.execute("SELECT notes FROM task WHERE id=?", (tid,)).fetchone()
        if row is None:
            raise KeyError("task not found: " + tid)
        notes = json.loads(row["notes"] or "[]")
        if note:
            notes.append({"at": now(), "note": note})
        con.execute("UPDATE task SET status=?, notes=?, updated_at=? WHERE id=?",
                    (status, json.dumps(notes, ensure_ascii=False), now(), tid))
    return {"task": tid, "status": status}


def op_slot(con, payload):
    name, owner = payload["name"], payload["owner"]
    action = payload.get("action", "take")
    with con:
        if action == "release":
            con.execute("DELETE FROM slot WHERE name=? AND owner=?", (name, owner))
            return {"released": name}
        row = con.execute("SELECT owner FROM slot WHERE name=?", (name,)).fetchone()
        if row and row["owner"] != owner:
            return {"denied": True, "held_by": row["owner"]}
        con.execute("INSERT OR REPLACE INTO slot(name,owner,note,taken_at) VALUES(?,?,?,?)",
                    (name, owner, payload.get("note"), now()))
    return {"taken": name, "owner": owner}


def op_ask(con, payload):
    qid = uid("Q")
    with con:
        con.execute("INSERT INTO question(id,asker,body,kinds,status,created_at) VALUES(?,?,?,?,?,?)",
                    (qid, payload.get("asker"), payload["body"],
                     json.dumps(payload.get("kinds", []), ensure_ascii=False), "open", now()))
    return {"question": qid}


def op_answer(con, payload):
    with con:
        cur = con.execute("UPDATE question SET status='answered', answer=?, answered_by=?, answered_at=?"
                          " WHERE id=?", (payload["answer"], payload.get("by", "coordinator"), now(), payload["id"]))
        if cur.rowcount == 0:
            raise KeyError("question not found: " + payload["id"])
    return {"answered": payload["id"]}


def op_say(con, payload):
    with con:
        con.execute("INSERT INTO intent(id,owner,body,created_at) VALUES(?,?,?,?)",
                    (uid("I"), payload.get("owner"), payload["body"], now()))
    return {"ok": True}


def op_decision(con, payload):
    did = uid("D")
    with con:
        con.execute("INSERT INTO decision(id,title,body,owner,created_at) VALUES(?,?,?,?,?)",
                    (did, payload["title"], payload.get("body", ""), payload.get("owner"), now()))
    return {"decision": did}


def op_changed(con, payload):
    with con:
        con.execute("INSERT INTO change_log(id,owner,paths,note,created_at) VALUES(?,?,?,?,?)",
                    (uid("C"), payload.get("owner"), json.dumps(payload.get("paths", []), ensure_ascii=False),
                     payload.get("note"), now()))
    return {"ok": True}


OPS = {
    "dispatch": op_dispatch, "claim": op_claim, "status": op_status, "slot": op_slot,
    "ask": op_ask, "answer": op_answer, "say": op_say, "decision": op_decision,
    "changed": op_changed,
}


def snapshot() -> dict:
    with connect() as con:
        return {
            "tasks": rows(con, "SELECT * FROM task ORDER BY priority DESC, created_at"),
            "slots": rows(con, "SELECT * FROM slot ORDER BY taken_at"),
            "questions": rows(con, "SELECT * FROM question ORDER BY created_at"),
            "decisions": rows(con, "SELECT * FROM decision ORDER BY created_at"),
            "intents": rows(con, "SELECT * FROM intent ORDER BY created_at DESC LIMIT 200"),
            "changes": rows(con, "SELECT * FROM change_log ORDER BY created_at DESC LIMIT 300"),
        }


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    def _send(self, code, body: bytes, ctype="application/json; charset=utf-8"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, code=200):
        self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"))

    def do_GET(self):
        parts = urlsplit(self.path)
        if parts.path in ("/", "/index.html"):
            page = Path(__file__).parent / "control.html"
            if page.exists():
                return self._send(200, page.read_bytes(), "text/html; charset=utf-8")
            return self._send(200, b"<h1>memora-core control</h1>", "text/html; charset=utf-8")
        if parts.path == "/api/snapshot":
            return self._json(snapshot())
        if parts.path == "/api/health":
            return self._json({"ok": True, "at": now()})
        return self._json({"error": "not found"}, 404)

    def do_POST(self):
        parts = urlsplit(self.path)
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw.decode("utf-8") or "{}")
        except Exception as exc:
            return self._json({"error": "bad json: " + str(exc)}, 400)
        if parts.path == "/api/op":
            name = payload.get("op")
            fn = OPS.get(name)
            if fn is None:
                return self._json({"error": "unknown op " + str(name)}, 400)
            try:
                with _LOCK, connect() as con:
                    return self._json(fn(con, payload.get("payload") or {}))
            except KeyError as exc:
                return self._json({"error": str(exc)}, 404)
            except Exception as exc:
                return self._json({"error": type(exc).__name__ + ": " + str(exc)}, 500)
        return self._json({"error": "not found"}, 404)


def serve(port: int) -> None:
    init()
    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    httpd.daemon_threads = True
    print("control plane on http://127.0.0.1:" + str(port), flush=True)
    httpd.serve_forever()


def call(port: int, op: str, payload: dict) -> dict:
    import urllib.request
    data = json.dumps({"op": op, "payload": payload}, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request("http://127.0.0.1:" + str(port) + "/api/op", data=data,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception as exc:
        return {"error": type(exc).__name__ + ": " + str(exc),
                "hint": "is the control server running on " + str(port) + "?"}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="control")
    ap.add_argument("--port", type=int, default=int(os.environ.get("MEMORA_CONTROL_PORT", "8899")))
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("serve")
    sub.add_parser("init")
    sub.add_parser("snapshot")

    p_dispatch = sub.add_parser("dispatch")
    p_dispatch.add_argument("file", help="JSON file with {tasks:[...]}")
    p_claim = sub.add_parser("claim")
    p_claim.add_argument("id")
    p_claim.add_argument("--owner", required=True)
    p_status = sub.add_parser("status")
    p_status.add_argument("id")
    p_status.add_argument("value")
    p_status.add_argument("--note")
    p_slot = sub.add_parser("slot")
    p_slot.add_argument("name")
    p_slot.add_argument("--owner", required=True)
    p_slot.add_argument("--release", action="store_true")
    p_ask = sub.add_parser("ask")
    p_ask.add_argument("body")
    p_ask.add_argument("--kinds", default="")
    p_ask.add_argument("--asker", default=os.environ.get("AGENT_NAME", "agent"))
    p_answer = sub.add_parser("answer")
    p_answer.add_argument("id")
    p_answer.add_argument("answer")
    p_answer.add_argument("--by", default="coordinator")
    p_say = sub.add_parser("say")
    p_say.add_argument("body")
    p_say.add_argument("--owner", default=os.environ.get("AGENT_NAME", "agent"))
    p_dec = sub.add_parser("decision")
    p_dec.add_argument("title")
    p_dec.add_argument("--body", default="")
    p_dec.add_argument("--owner", default=os.environ.get("AGENT_NAME", "coordinator"))
    p_chg = sub.add_parser("changed")
    p_chg.add_argument("paths", nargs="+")
    p_chg.add_argument("--owner", default=os.environ.get("AGENT_NAME", "agent"))
    p_chg.add_argument("--note")
    p_board = sub.add_parser("board")
    p_board.add_argument("--json", action="store_true")

    args = ap.parse_args(argv)
    if args.cmd == "serve":
        serve(args.port)
        return 0
    if args.cmd == "init":
        init()
        print("control db initialised at " + str(DB_PATH))
        return 0
    if args.cmd == "snapshot":
        print(json.dumps(snapshot(), ensure_ascii=False, indent=2))
        return 0
    if args.cmd == "board":
        snap = snapshot()
        if args.json:
            print(json.dumps(snap, ensure_ascii=False, indent=2))
            return 0
        print("TASKS (" + str(len(snap["tasks"])) + ")")
        for t in snap["tasks"]:
            print("  [%-8s] %-6s %-16s %s" % (t["status"], t["id"], t["owner"] or "-", t["title"]))
        open_q = [q for q in snap["questions"] if q["status"] == "open"]
        print("")
        print("OPEN QUESTIONS (" + str(len(open_q)) + ")")
        for q in open_q:
            print("  %s %s: %s" % (q["id"], q["asker"], q["body"][:110]))
        print("")
        print("SLOTS (" + str(len(snap["slots"])) + "): " + ", ".join(s["name"] + "=" + str(s["owner"]) for s in snap["slots"]))
        return 0

    if args.cmd == "dispatch":
        payload = json.loads(Path(args.file).read_text(encoding="utf-8"))
        out = call(args.port, "dispatch", payload)
    elif args.cmd == "claim":
        out = call(args.port, "claim", {"id": args.id, "owner": args.owner})
    elif args.cmd == "status":
        out = call(args.port, "status", {"id": args.id, "status": args.value, "note": args.note})
    elif args.cmd == "slot":
        out = call(args.port, "slot", {"name": args.name, "owner": args.owner,
                                       "action": "release" if args.release else "take"})
    elif args.cmd == "ask":
        out = call(args.port, "ask", {"body": args.body, "asker": args.asker,
                                      "kinds": [k for k in args.kinds.split(",") if k]})
    elif args.cmd == "answer":
        out = call(args.port, "answer", {"id": args.id, "answer": args.answer, "by": args.by})
    elif args.cmd == "say":
        out = call(args.port, "say", {"body": args.body, "owner": args.owner})
    elif args.cmd == "decision":
        out = call(args.port, "decision", {"title": args.title, "body": args.body, "owner": args.owner})
    elif args.cmd == "changed":
        out = call(args.port, "changed", {"paths": args.paths, "owner": args.owner, "note": args.note})
    else:
        ap.error("unknown command")
        return 2
    print(json.dumps(out, ensure_ascii=False))
    return 0 if not out.get("error") and not out.get("denied") else 1


if __name__ == "__main__":
    sys.exit(main())
