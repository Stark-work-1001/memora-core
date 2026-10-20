# -*- coding: utf-8 -*-
"""SQLite 连接、初始化、事务与健康检查。

事务真源是 data/memora.db（WAL）。所有写操作都在 transaction() 里完成，
外部不要自行 conn.commit()。
"""
from __future__ import annotations

import json
import re
import sqlite3
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from .paths import package_dir

SCHEMA_PATH = package_dir() / "data" / "schema.sql"
_BUILTIN = package_dir() / "data" / "builtin"

_LOCAL = threading.local()

SCHEMA_VERSION = 1
"""数据库结构版本，记在 ``PRAGMA user_version``。

1.0.0 从不写 user_version（恒为 0），只在 meta 表里无条件写 '1'，所以 0 视同 1。
改动 schema.sql 里**已有**表的结构时：SCHEMA_VERSION + 1，并在 MIGRATIONS 里登记把上一版
升到这一版的语句（新库直接按 schema.sql 建成最新结构，不走迁移）。
"""

MIGRATIONS: dict[int, tuple[str, ...]] = {}
"""{目标版本: (SQL, ...)}：按版本号升序执行，每一版一个事务，版本号与改动同时提交。"""


class SchemaTooNew(RuntimeError):
    """数据库来自更新版本的 memora-core。拒绝打开，而不是把它的版本号改写回旧值。"""


_TABLE_RE = re.compile(r"CREATE\s+(VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)",
                       re.IGNORECASE)


def expected_tables() -> dict[str, list[str]]:
    """schema.sql 声明的表：{"real": [...], "virtual": [...]}。表清单的唯一真源。"""
    real, virtual = [], []
    for match in _TABLE_RE.finditer(SCHEMA_PATH.read_text(encoding="utf-8")):
        (virtual if match.group(1) else real).append(match.group(2))
    return {"real": sorted(set(real)), "virtual": sorted(set(virtual))}


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


def schema_version(con: sqlite3.Connection) -> int:
    return int(con.execute("PRAGMA user_version").fetchone()[0])


def init_db(db_path: str | Path) -> dict:
    """建库或升级到 SCHEMA_VERSION。返回 {"fresh", "from", "to", "applied"}。

    新库：执行 schema.sql，直接盖上最新版本号。旧库：先按 MIGRATIONS 逐版升级，再执行
    schema.sql（全是 IF NOT EXISTS，只补新表/索引/触发器）。比本程序新的库：抛 SchemaTooNew，
    库文件不做任何改动——1.0.0 会把任何库的版本号无条件改写成 '1'。
    """
    con = connect(db_path)
    try:
        fresh = con.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='meta'"
                            ).fetchone() is None
        found = schema_version(con)
        if found > SCHEMA_VERSION:
            raise SchemaTooNew("数据库结构版本 %d 比本程序支持的 %d 新，请用更新版本的 memora-core "
                               "打开（库文件未做任何改动）" % (found, SCHEMA_VERSION))
        current = SCHEMA_VERSION if fresh else max(found, 1)
        applied: list[int] = []
        for target in sorted(v for v in MIGRATIONS if v > current):
            with transaction(con):
                for statement in MIGRATIONS[target]:
                    con.execute(statement)
                con.execute("PRAGMA user_version = %d" % int(target))
            applied.append(target)
        con.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))
        con.execute("PRAGMA user_version = %d" % SCHEMA_VERSION)
        con.execute("INSERT OR REPLACE INTO meta(key, value) VALUES('schema_version', ?)",
                    (str(SCHEMA_VERSION),))
        con.execute("INSERT OR IGNORE INTO meta(key, value) VALUES('created_at', ?)", (now(),))
        return {"fresh": fresh, "from": 0 if fresh else max(found, 1), "to": SCHEMA_VERSION,
                "applied": applied}
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


def census(con: sqlite3.Connection, counts: bool = True) -> dict:
    """库里实际存在的表与行数，对照 schema.sql 的声明。

    1.0.0 用一张手写的 23 表名单：漏了 7 张真实表（agent_probe、block、memory_entity、meta、
    scope、secret、setting），又把 2 张 FTS 虚表算了进去，selftest 和 README 的"23 张表"都来自它。
    现在名单从 sqlite_master 推导，FTS 影子表（*_data/_idx/_content/_docsize/_config）不计。
    """
    expected = expected_tables()
    rows = con.execute("SELECT name, sql FROM sqlite_master WHERE type='table' "
                       "AND name NOT LIKE 'sqlite_%' ORDER BY name").fetchall()
    present_virtual = sorted(r[0] for r in rows
                             if str(r[1] or "").upper().startswith("CREATE VIRTUAL TABLE"))
    shadow_prefixes = tuple(name + "_" for name in present_virtual)
    present_real = sorted(r[0] for r in rows if r[0] not in present_virtual
                          and not r[0].startswith(shadow_prefixes))
    out = {
        "real": len(present_real),
        "virtual": len(present_virtual),
        "expected_real": len(expected["real"]),
        "expected_virtual": len(expected["virtual"]),
        "missing": sorted(set(expected["real"] + expected["virtual"])
                          - set(present_real) - set(present_virtual)),
        "unexpected": sorted(set(present_real) - set(expected["real"])),
    }
    if counts:
        tally = {}
        for table in present_real + present_virtual:
            try:
                tally[table] = int(con.execute('SELECT count(*) FROM "%s"' % table).fetchone()[0])
            except sqlite3.Error:
                tally[table] = -1
        out["counts"] = tally
    return out


def integrity(con: sqlite3.Connection, full: bool = False) -> str:
    """'ok' 或第一条问题描述。full=False 用 quick_check（不校验索引内容，快一个量级以内）。"""
    pragma = "integrity_check" if full else "quick_check"
    return str(con.execute("PRAGMA %s(1)" % pragma).fetchone()[0])


def health(con: sqlite3.Connection, deep: bool = False, counts: bool = True) -> dict:
    """数据库健康。默认**不做**完整性扫描（1.0.0 每次都跑 integrity_check：422 MB 的库
    单次约 2 s，而界面和桌面外壳都在轮询它）；deep=True 时跑完整 integrity_check。

    ok 的含义：deep 时 = 完整性检查通过；否则 = 能查询且 schema.sql 声明的表都在。
    integrity 为 None 表示本次没有检查（由调用方报告最近一次的结果）。
    """
    info = census(con, counts=counts)
    page = con.execute("PRAGMA page_count").fetchone()[0]
    size = con.execute("PRAGMA page_size").fetchone()[0]
    checked = integrity(con, full=True) if deep else None
    return {
        "ok": (checked == "ok") if deep else not info["missing"],
        "integrity": checked,
        "integrity_mode": "integrity_check" if deep else "skipped",
        "counts": info.get("counts", {}),
        "tables": {key: info[key] for key in ("real", "virtual", "expected_real",
                                              "expected_virtual", "missing", "unexpected")},
        "db_bytes": page * size,
        "journal": con.execute("PRAGMA journal_mode").fetchone()[0],
        "sqlite": sqlite3.sqlite_version,
        "schema_version": schema_version(con),
    }


def now() -> str:
    """统一时间格式：UTC ISO8601 秒级。"""
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def today() -> str:
    """**本地**日历日。日记页、按天统计、时间线都按用户所在地的一天切分。

    1.0.0 按 UTC 切：东八区早上 8 点前的工作落进前一天的日记，UTC-5 晚上 7 点后的落进第二天。
    时间戳本身（now()）仍是 UTC。
    """
    return time.strftime("%Y-%m-%d", time.localtime())


def parse_stamp(stamp) -> datetime | None:
    """解析库里出现过的时间格式：…Z、带偏移、'YYYY-MM-DD HH:MM:SS'（SQLite datetime()）。
    无时区的按 UTC 理解。解析不了返回 None。"""
    text = str(stamp or "").strip()
    if not text:
        return None
    try:
        value = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value


def local_day(stamp) -> str:
    """把存储时间戳换算成本地日历日 YYYY-MM-DD；解析不了时退回前 10 个字符。"""
    value = parse_stamp(stamp)
    if value is None:
        return str(stamp or "")[:10]
    return value.astimezone().strftime("%Y-%m-%d")


def local_clock(stamp) -> str:
    """本地钟点 HH:MM:SS（日记条目标题用）；解析不了返回空串。"""
    value = parse_stamp(stamp)
    return value.astimezone().strftime("%H:%M:%S") if value is not None else ""


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
