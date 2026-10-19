# -*- coding: utf-8 -*-
"""SQLite 连接、初始化、事务与健康检查。

事务真源是 data/memora.db（WAL）。所有写操作都在 transaction() 里完成，
外部不要自行 conn.commit()。
"""
from __future__ import annotations

import json
import sqlite3
import threading
import time
from contextlib import contextmanager
from pathlib import Path

from .paths import package_dir

SCHEMA_PATH = package_dir() / "data" / "schema.sql"
_BUILTIN = package_dir() / "data" / "builtin"

_LOCAL = threading.local()


def read_builtin(name: str):
    path = _BUILTIN / name
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def connect(db_path: str | Path) -> sqlite3.Connection:
    path = Path(db_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(str(path), timeout=15.0, check_same_thread=False,
                          isolation_level=None)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA synchronous=NORMAL")
    con.execute("PRAGMA foreign_keys=ON")
    con.execute("PRAGMA busy_timeout=8000")
    con.execute("PRAGMA temp_store=MEMORY")
    return con


def init_db(db_path: str | Path) -> None:
    con = connect(db_path)
    try:
        sql = SCHEMA_PATH.read_text(encoding="utf-8")
        con.executescript(sql)
        con.execute("INSERT OR REPLACE INTO meta(key, value) VALUES('schema_version', '1')")
        con.execute("INSERT OR IGNORE INTO meta(key, value) VALUES('created_at', datetime('now'))")
    finally:
        con.close()


@contextmanager
def transaction(con: sqlite3.Connection):
    """BEGIN IMMEDIATE ... COMMIT / ROLLBACK。不支持嵌套（调用方自行避免）。"""
    con.execute("BEGIN IMMEDIATE")
    try:
        yield con
    except BaseException:
        con.execute("ROLLBACK")
        raise
    else:
        con.execute("COMMIT")


def rebuild_fts(con: sqlite3.Connection) -> dict:
    """重建 memory_fts / chunk_fts。用于导入后或索引损坏时。"""
    out = {}
    con.execute("INSERT INTO memory_fts(memory_fts) VALUES('rebuild')")
    out["memory_fts"] = con.execute("SELECT count(*) FROM memory_fts").fetchone()[0]
    con.execute("INSERT INTO chunk_fts(chunk_fts) VALUES('rebuild')")
    out["chunk_fts"] = con.execute("SELECT count(*) FROM chunk_fts").fetchone()[0]
    return out


def health(con: sqlite3.Connection) -> dict:
    def count(table: str) -> int:
        try:
            return int(con.execute("SELECT count(*) FROM " + table).fetchone()[0])
        except sqlite3.Error:
            return -1

    tables = ["memory", "memory_fts", "document", "chunk", "chunk_fts", "evidence", "entity",
              "edge", "candidate", "conflict", "workflow_template", "workflow_run",
              "workflow_step", "model_profile", "model_call", "agent", "agent_session",
              "recall_log", "review_log", "job", "audit", "vector", "memory_algo"]
    integrity = con.execute("PRAGMA integrity_check").fetchone()[0]
    page = con.execute("PRAGMA page_count").fetchone()[0]
    size = con.execute("PRAGMA page_size").fetchone()[0]
    return {
        "ok": integrity == "ok",
        "integrity": integrity,
        "counts": {t: count(t) for t in tables},
        "db_bytes": page * size,
        "journal": con.execute("PRAGMA journal_mode").fetchone()[0],
        "sqlite": sqlite3.sqlite_version,
    }


def now() -> str:
    """统一时间格式：UTC ISO8601 秒级。"""
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def today() -> str:
    return time.strftime("%Y-%m-%d", time.gmtime())


def dumps(obj) -> str:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def loads(text, default=None):
    if text is None or text == "":
        return default
    if isinstance(text, (dict, list)):
        return text
    try:
        return json.loads(text)
    except (TypeError, ValueError):
        return default
