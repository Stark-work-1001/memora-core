# -*- coding: utf-8 -*-
"""智能体登记、在场探测与会话生命周期。

"记忆中枢"与"记忆库"的分水岭：中枢必须知道**谁在运行、谁刚取过记忆**。

设计约束：
  * 纯标准库。进程探测在 Windows 走 ctypes + CreateToolhelp32Snapshot，
    非 Windows 回退 ps 命令。**不使用 psutil**。
  * 所有探针结果为 found / absent / error 三态，逐条写 agent_probe 表。
  * 任一探针命中 → online；全部未命中 → offline。
  * 只做读写与判定，不实现检索/去重/工作流（那些模块由别的层负责）。
"""
from __future__ import annotations

import calendar
import ctypes
import json
import os
import socket
import subprocess
import sys
import threading
import time
import uuid
from contextlib import contextmanager
from typing import Any

from . import db as _db

DEFAULT_TTL = 90.0          # 心跳/文件/MCP 探针的有效期（秒）
PORT_TIMEOUT = 0.3          # 端口探针超时（秒）
SESSION_WORKFLOW = "session-distill"   # 内置"智能体会话沉淀"模板 id
PROBE_KINDS = ("process", "port", "file", "mcp")
PROBE_STATES = ("found", "absent", "error")


# ============================================================
# 基础工具
# ============================================================

def _now() -> str:
    return _db.now()


def _uid(prefix: str) -> str:
    return prefix + uuid.uuid4().hex[:12]


def _epoch(ts: Any) -> float:
    """把 'YYYY-MM-DDTHH:MM:SSZ' / 'YYYY-MM-DD HH:MM:SS' 解析为 UTC epoch 秒。"""
    if not ts:
        return 0.0
    raw = str(ts).strip().replace("T", " ").rstrip("Z")
    for fmt, size in (("%Y-%m-%d %H:%M:%S", 19), ("%Y-%m-%d %H:%M", 16), ("%Y-%m-%d", 10)):
        try:
            return float(calendar.timegm(time.strptime(raw[:size], fmt)))
        except (ValueError, OverflowError):
            continue
    return 0.0


def _loads(value: Any, default: Any = None) -> Any:
    if isinstance(value, (dict, list)):
        return value
    if not value:
        return default
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return default


def _dumps(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


@contextmanager
def _txn(store):
    """优先复用 Store 的事务（保证 audit 与业务写入同事务），否则自己开一个。"""
    txn = getattr(store, "_txn", None)
    if callable(txn):
        with txn() as con:
            yield con
        return
    con = _con(store)
    with _db.transaction(con):
        yield con


def _con(store):
    """从 Store 拿到 sqlite3 连接（duck typing）。"""
    con = getattr(store, "con", None)
    if con is not None:
        return con
    import sqlite3
    path = getattr(store, "db_path", None) or getattr(store, "db", None)
    if path is None:
        raise TypeError("store 没有可用的数据库连接")
    conn = sqlite3.connect(str(path), timeout=15.0, isolation_level=None)
    conn.row_factory = sqlite3.Row
    return conn


def _audit(store, action: str, target: str | None, detail: Any = None) -> None:
    fn = getattr(store, "audit", None)
    if not callable(fn):
        return
    try:
        fn(action, target, detail=detail)
    except Exception:  # noqa: BLE001 - 审计失败不能影响主流程
        pass


def _agent_row(store, agent_id: str) -> dict | None:
    row = _con(store).execute("SELECT * FROM agent WHERE id = ?", (agent_id,)).fetchone()
    if row is None:
        return None
    item = dict(row)
    item["capabilities"] = _loads(item.get("capabilities"), {}) or {}
    item["metadata"] = _loads(item.get("metadata"), {}) or {}
    return item


def _touch_last_seen(con, agent_id: str, stamp: str) -> None:
    con.execute("UPDATE agent SET last_seen = ? WHERE id = ?", (stamp, agent_id))


def _insert_agent(con, aid: str, *, display_name: str, ecosystem: str, kind: str,
                  status: str, stamp: str, capabilities: dict, metadata: dict) -> None:
    con.execute(
        "INSERT INTO agent(id, display_name, ecosystem, kind, status, first_seen, last_seen, "
        "last_heartbeat, heartbeat_source, capabilities, metadata, static_registered, enabled) "
        "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (aid, display_name, ecosystem, kind, status, stamp, stamp, None, None,
         _dumps(capabilities), _dumps(metadata), 0, 1),
    )


def _write_probe(con, agent_id: str, probe: str, state: str, detail: str,
                 latency_ms: float, target: str = "") -> dict:
    row = {
        "id": _uid("ap-"),
        "agent_id": agent_id,
        "probe": probe,
        "target": target or "",
        "state": state,
        "detail": detail,
        "latency_ms": int(round(latency_ms)),
        "at": _now(),
    }
    con.execute(
        "INSERT INTO agent_probe(id, agent_id, probe, target, state, detail, latency_ms, at) "
        "VALUES(?,?,?,?,?,?,?,?)",
        (row["id"], row["agent_id"], row["probe"], row["target"], row["state"],
         row["detail"], row["latency_ms"], row["at"]),
    )
    return row


# ============================================================
# A1. 内置登记
# ============================================================

def builtin_agents() -> list[dict]:
    """读取内置智能体登记表（data/builtin/agents.json）。"""
    data = _db.read_builtin("agents.json") or []
    return [dict(item) for item in data if isinstance(item, dict) and item.get("id")]


def seed_agents(store) -> int:
    """把内置登记写入 agent 表；已存在则更新静态字段（保留运行态）。幂等，返回条数。"""
    items = builtin_agents()
    stamp = _now()
    count = 0
    with _txn(store) as con:
        for item in items:
            aid = str(item["id"]).strip()
            display = str(item.get("name") or aid)
            ecosystem = str(item.get("ecosystem") or "custom")
            kind = str(item.get("kind") or "unknown")
            capabilities = {
                "protocols": list(item.get("protocols") or []),
                "config_hint": item.get("config_hint") or "",
            }
            metadata = {"probes": list(item.get("probes") or []), "builtin": True}
            row = con.execute("SELECT id FROM agent WHERE id = ?", (aid,)).fetchone()
            if row is None:
                con.execute(
                    "INSERT INTO agent(id, display_name, ecosystem, kind, status, first_seen, "
                    "last_seen, last_heartbeat, heartbeat_source, capabilities, metadata, "
                    "static_registered, enabled) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (aid, display, ecosystem, kind, "offline", stamp, stamp, None, None,
                     _dumps(capabilities), _dumps(metadata), 1, 1),
                )
            else:
                con.execute(
                    "UPDATE agent SET display_name = ?, ecosystem = ?, kind = ?, "
                    "capabilities = ?, metadata = ?, static_registered = 1 WHERE id = ?",
                    (display, ecosystem, kind, _dumps(capabilities), _dumps(metadata), aid),
                )
            count += 1
        if count:
            _audit(store, "agent.seed", None, {"count": count, "ids": [i["id"] for i in items]})
    return count


def register_agent(store, agent_id: str, *, display_name: str = "", ecosystem: str = "custom",
                   kind: str = "unknown", capabilities: dict | None = None) -> dict:
    """登记一个自定义智能体（非内置）。已存在则只补齐字段。"""
    aid = (agent_id or "").strip()
    if not aid:
        raise ValueError("agent_id 不能为空")
    stamp = _now()
    with _txn(store) as con:
        row = con.execute("SELECT id FROM agent WHERE id = ?", (aid,)).fetchone()
        if row is None:
            _insert_agent(con, aid, display_name=display_name or aid, ecosystem=ecosystem,
                          kind=kind, status="offline", stamp=stamp,
                          capabilities=capabilities or {}, metadata={"custom": True})
            _audit(store, "agent.register", aid, {"custom": True})
    return _agent_row(store, aid) or {}


# ============================================================
# A2. 四种探针
# ============================================================

class _PROCESSENTRY32W(ctypes.Structure):
    _fields_ = [
        ("dwSize", ctypes.c_ulong),
        ("cntUsage", ctypes.c_ulong),
        ("th32ProcessID", ctypes.c_ulong),
        ("th32DefaultHeapID", ctypes.c_void_p),
        ("th32ModuleID", ctypes.c_ulong),
        ("cntThreads", ctypes.c_ulong),
        ("th32ParentProcessID", ctypes.c_ulong),
        ("pcPriClassBase", ctypes.c_long),
        ("dwFlags", ctypes.c_ulong),
        ("szExeFile", ctypes.c_wchar * 260),
    ]


class _UNICODE_STRING(ctypes.Structure):
    _fields_ = [("Length", ctypes.c_ushort), ("MaximumLength", ctypes.c_ushort),
                ("Buffer", ctypes.c_void_p)]


def _win_cmdline(k32, ntdll, pid: int) -> str:
    """用 NtQueryInformationProcess(60) + ReadProcessMemory 取命令行；失败返回空串。"""
    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    PROCESS_VM_READ = 0x0010
    handle = k32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return ""
    try:
        need = ctypes.c_ulong(0)
        buf = ctypes.create_string_buffer(65536)
        status = ntdll.NtQueryInformationProcess(
            ctypes.c_void_p(handle), 60, buf, 65536, ctypes.byref(need))
        if status != 0:
            return ""
        info = _UNICODE_STRING.from_buffer_copy(buf.raw[:ctypes.sizeof(_UNICODE_STRING)])
        if not info.Buffer or not info.Length:
            return ""
        remote = ctypes.c_void_p(info.Buffer)
        handle2 = k32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, False, pid)
        if not handle2:
            return ""
        try:
            out = ctypes.create_string_buffer(info.Length + 2)
            read = ctypes.c_size_t(0)
            ok = k32.ReadProcessMemory(ctypes.c_void_p(handle2), remote, out, info.Length,
                                       ctypes.byref(read))
            if not ok:
                return ""
            return out.raw[:read.value].decode("utf-16-le", "replace")
        finally:
            k32.CloseHandle(ctypes.c_void_p(handle2))
    finally:
        k32.CloseHandle(ctypes.c_void_p(handle))


def windows_processes(with_cmdline: bool = True) -> list[dict]:
    """枚举 Windows 进程：[{pid, exe, cmdline}]。纯 ctypes，无第三方依赖。"""
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    ntdll = ctypes.WinDLL("ntdll", use_last_error=True) if with_cmdline else None
    TH32CS_SNAPPROCESS = 0x00000002
    snapshot = k32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if not snapshot or int(snapshot) == -1:
        raise OSError("CreateToolhelp32Snapshot 失败: %s" % ctypes.get_last_error())
    out: list[dict] = []
    try:
        entry = _PROCESSENTRY32W()
        entry.dwSize = ctypes.sizeof(_PROCESSENTRY32W)
        ok = k32.Process32FirstW(ctypes.c_void_p(snapshot), ctypes.byref(entry))
        while ok:
            pid = int(entry.th32ProcessID)
            exe = entry.szExeFile or ""
            line = ""
            if with_cmdline and ntdll is not None and pid:
                try:
                    line = _win_cmdline(k32, ntdll, pid)
                except (OSError, ValueError, ctypes.ArgumentError):
                    line = ""
            out.append({"pid": pid, "exe": exe, "cmdline": line})
            ok = k32.Process32NextW(ctypes.c_void_p(snapshot), ctypes.byref(entry))
    finally:
        k32.CloseHandle(ctypes.c_void_p(snapshot))
    return out


def unix_processes() -> list[dict]:
    """非 Windows 回退：调用 ps 取 pid / comm / args。"""
    try:
        proc = subprocess.run(["ps", "-A", "-o", "pid=,comm=,args="], capture_output=True,
                              timeout=5, check=False)
    except (OSError, subprocess.SubprocessError) as exc:
        raise OSError("ps 不可用: %s" % exc) from exc
    out: list[dict] = []
    for line in proc.stdout.decode("utf-8", "replace").splitlines():
        parts = line.strip().split(None, 2)
        if len(parts) < 2:
            continue
        out.append({
            "pid": int(parts[0]) if parts[0].isdigit() else 0,
            "exe": os.path.basename(parts[1]),
            "cmdline": parts[2] if len(parts) > 2 else parts[1],
        })
    return out


def process_list(with_cmdline: bool = True) -> list[dict]:
    """当前机器的进程快照（Windows ctypes / 其它平台 ps）。"""
    if sys.platform == "win32":
        return windows_processes(with_cmdline=with_cmdline)
    return unix_processes()


def match_process(patterns: list, processes: list[dict]) -> tuple[str, str]:
    """在进程快照里找命中；返回 (state, detail)。"""
    needles = [str(p).lower() for p in (patterns or []) if str(p).strip()]
    if not needles:
        return "error", "process 探针没有配置 match"
    hits: list[tuple[str, dict]] = []
    for proc in processes:
        haystack = ("%s %s" % (proc.get("exe") or "", proc.get("cmdline") or "")).lower()
        for needle in needles:
            if needle in haystack:
                hits.append((needle, proc))
                break
    if not hits:
        return "absent", "在 %d 个进程中未发现 %s" % (len(processes), "/".join(needles))
    needle, proc = hits[0]
    detail = "命中 '%s'：pid=%s %s" % (needle, proc.get("pid"), proc.get("exe"))
    if len(hits) > 1:
        detail += "（另有 %d 个同类进程）" % (len(hits) - 1)
    return "found", detail


def probe_port(ports: list, timeout: float = PORT_TIMEOUT) -> tuple[str, str]:
    """对 127.0.0.1:<port> 做 TCP 连接测试。"""
    wanted: list[int] = []
    for item in ports or []:
        try:
            wanted.append(int(item))
        except (TypeError, ValueError):
            continue
    if not wanted:
        return "error", "port 探针没有配置端口"
    for port in wanted:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(timeout)
        try:
            sock.connect(("127.0.0.1", port))
            return "found", "127.0.0.1:%d 可连接" % port
        except OSError:
            continue
        finally:
            sock.close()
    return "absent", "端口均不可连接: %s" % ",".join(str(p) for p in wanted)


def probe_file(paths: list, ttl: float = DEFAULT_TTL) -> tuple[str, str]:
    """心跳文件存在且 mtime 在 TTL 内才算命中。"""
    wanted = [str(p) for p in (paths or []) if str(p).strip()]
    if not wanted:
        return "error", "file 探针没有配置路径"
    now = time.time()
    seen: list[str] = []
    for raw in wanted:
        path = os.path.expanduser(raw)
        if not os.path.exists(path):
            seen.append("%s 不存在" % path)
            continue
        try:
            mtime = os.path.getmtime(path)
        except OSError as exc:
            seen.append("%s 无法 stat（%s）" % (path, exc))
            continue
        age = now - mtime
        if age <= ttl:
            return "found", "心跳文件 %s（%.0fs 前更新，TTL %.0fs）" % (path, age, ttl)
        seen.append("%s 过期（%.0fs > TTL %.0fs）" % (path, age, ttl))
    return "absent", "；".join(seen)


def probe_mcp(store, agent_id: str, ttl: float = DEFAULT_TTL,
              patterns: list | None = None) -> tuple[str, str]:
    """查 agent 表最近一次 MCP 调用时间（由 mcp.py 的 heartbeat(source='mcp') 写入）。"""
    row = _agent_row(store, agent_id)
    if row is None:
        return "absent", "智能体未登记: %s" % agent_id
    source = str(row.get("heartbeat_source") or "")
    stamp = row.get("last_heartbeat") or ""
    at = _epoch(stamp)
    if not stamp or not at:
        return "absent", "尚无 MCP 调用记录"
    age = time.time() - at
    if source == "mcp" and age <= ttl:
        return "found", "最后一次 MCP 调用 %.0fs 前（%s）" % (age, stamp)
    if source != "mcp":
        return "absent", "最后一次心跳来源是 %r，不是 mcp" % (source or "unknown")
    return "absent", "最后一次 MCP 调用已过期（%.0fs > TTL %.0fs）" % (age, ttl)


# ============================================================
# A3. 汇总探测
# ============================================================

def probe_specs(store, agent_id: str) -> list[dict]:
    """读取登记表里的探针配置（内置写进 metadata.probes）。"""
    row = _agent_row(store, agent_id)
    if row is None:
        return []
    meta = row.get("metadata") or {}
    specs = meta.get("probes") or []
    return [dict(s) for s in specs if isinstance(s, dict) and s.get("type")]


def run_probe(store, agent_id: str, spec: dict, ttl: float = DEFAULT_TTL,
              processes: list[dict] | None = None) -> dict:
    """执行单个探针配置，返回 {agent_id, probe, state, detail, latency_ms}（不写库）。"""
    kind = str(spec.get("type") or "").strip().lower()
    match = spec.get("match") or []
    if isinstance(match, (str, int)):
        match = [match]
    started = time.perf_counter()
    state, detail = "error", ""
    try:
        if kind == "process":
            snapshot = processes if processes is not None else process_list()
            state, detail = match_process(match, snapshot)
        elif kind == "port":
            state, detail = probe_port(match)
        elif kind == "file":
            state, detail = probe_file(match, ttl=ttl)
        elif kind == "mcp":
            state, detail = probe_mcp(store, agent_id, ttl=ttl, patterns=match)
        else:
            state, detail = "error", "未知探针类型: %r" % kind
    except Exception as exc:  # noqa: BLE001 - 探针失败降级为 error，绝不中断
        state, detail = "error", "%s: %s" % (type(exc).__name__, exc)
    latency = (time.perf_counter() - started) * 1000.0
    return {
        "agent_id": agent_id,
        "probe": kind,
        "state": state,
        "detail": detail,
        "latency_ms": int(round(latency)),
        "target": ",".join(str(m) for m in match),
    }


def probe_all(store, ttl: float = DEFAULT_TTL, agents: list[str] | None = None) -> dict:
    """对所有已登记智能体跑一遍探针，写 agent_probe 并更新在线状态。"""
    con = _con(store)
    rows = con.execute("SELECT id FROM agent WHERE enabled = 1 ORDER BY id").fetchall()
    wanted = [str(r["id"]) for r in rows]
    if agents:
        keep = {str(a) for a in agents}
        wanted = [a for a in wanted if a in keep]

    snapshot: list[dict] = []
    proc_error = ""
    try:
        snapshot = process_list()
    except Exception as exc:  # noqa: BLE001 - 取不到进程表时 process 探针逐条标 error
        proc_error = "%s: %s" % (type(exc).__name__, exc)

    results: list[dict] = []
    online: list[str] = []
    offline: list[str] = []
    stamp = _now()
    with _txn(store) as con:
        for aid in wanted:
            hits = 0
            for spec in probe_specs(store, aid):
                if str(spec.get("type") or "").lower() == "process" and proc_error:
                    outcome = {"agent_id": aid, "probe": "process", "state": "error",
                               "detail": "进程表不可用: %s" % proc_error, "latency_ms": 0,
                               "target": ""}
                else:
                    outcome = run_probe(store, aid, spec, ttl=ttl, processes=snapshot)
                saved = _write_probe(con, aid, outcome["probe"], outcome["state"],
                                     outcome["detail"], outcome["latency_ms"], outcome["target"])
                results.append({"agent_id": aid, "probe": saved["probe"],
                                "state": saved["state"], "detail": saved["detail"],
                                "latency_ms": saved["latency_ms"]})
                if outcome["state"] == "found":
                    hits += 1
            status = "online" if hits else "offline"
            if hits:
                online.append(aid)
            else:
                offline.append(aid)
            _apply_online_state(con, aid, status, stamp)
        if wanted:
            _audit(store, "agent.probe", None,
                   {"agents": len(wanted), "online": online, "probes": len(results)})
    return {"results": results, "online": online, "offline": offline,
            "checked": len(wanted), "at": stamp, "ttl": ttl}


def _apply_online_state(con, agent_id: str, status: str, stamp: str) -> None:
    """把在线/离线状态写回 agent 行；online_since 记录在 metadata 里。"""
    row = con.execute("SELECT status, metadata FROM agent WHERE id = ?", (agent_id,)).fetchone()
    if row is None:
        return
    meta = _loads(row["metadata"], {}) or {}
    changed = str(row["status"]) != status
    if status == "online":
        meta.setdefault("online_since", stamp)
        con.execute("UPDATE agent SET status = ?, last_seen = ?, metadata = ? WHERE id = ?",
                    (status, stamp, _dumps(meta), agent_id))
    else:
        meta.pop("online_since", None)
        con.execute("UPDATE agent SET status = ?, metadata = ? WHERE id = ?",
                    (status, _dumps(meta), agent_id))
    if changed:
        _audit_state(con, agent_id, status, stamp)


def _audit_state(con, agent_id: str, status: str, stamp: str) -> None:
    try:
        con.execute(
            "INSERT INTO audit(id, at, actor, action, target, detail) VALUES(?,?,?,?,?,?)",
            (_uid("a-"), stamp, "agent", "agent.status", agent_id, _dumps({"status": status})),
        )
    except Exception:  # noqa: BLE001
        pass


# ============================================================
# A4. 心跳
# ============================================================

def heartbeat(store, agent_id: str, payload: dict | None = None) -> dict:
    """更新 last_heartbeat / status / capabilities；未登记的智能体自动登记。"""
    aid = (agent_id or "").strip()
    if not aid:
        raise ValueError("agent_id 不能为空")
    body = dict(payload or {})
    stamp = _now()
    source = str(body.get("source") or body.get("heartbeat_source") or "manual")
    status = str(body.get("status") or "online")
    if status not in ("online", "idle", "offline"):
        status = "online"
    with _txn(store) as con:
        row = con.execute("SELECT * FROM agent WHERE id = ?", (aid,)).fetchone()
        if row is None:
            con.execute(
                "INSERT INTO agent(id, display_name, ecosystem, kind, status, first_seen, last_seen,"
                " last_heartbeat, heartbeat_source, capabilities, metadata, static_registered, "
                "enabled) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (aid, str(body.get("display_name") or aid),
                 str(body.get("ecosystem") or "custom"), str(body.get("kind") or "unknown"),
                 status, stamp, stamp, stamp, source,
                 _dumps(body.get("capabilities") or {}),
                 _dumps({"auto_registered": True}), 0, 1),
            )
            _audit(store, "agent.register", aid, {"auto": True, "source": source})
            row = con.execute("SELECT * FROM agent WHERE id = ?", (aid,)).fetchone()
        caps = _loads(row["capabilities"], {}) or {}
        incoming = body.get("capabilities")
        if isinstance(incoming, dict) and incoming:
            caps = _merge_caps(caps, incoming)
        meta = _loads(row["metadata"], {}) or {}
        for key in ("detail", "host", "cwd", "version", "protocol", "session"):
            if body.get(key) not in (None, ""):
                meta[key] = body[key]
        meta["last_heartbeat_source"] = source
        if status == "online":
            meta.setdefault("online_since", stamp)
        con.execute(
            "UPDATE agent SET last_seen = ?, last_heartbeat = ?, heartbeat_source = ?, "
            "status = ?, capabilities = ?, metadata = ? WHERE id = ?",
            (stamp, stamp, source, status, _dumps(caps), _dumps(meta), aid),
        )
        _audit(store, "agent.heartbeat", aid, {"source": source, "status": status})
        saved = con.execute("SELECT * FROM agent WHERE id = ?", (aid,)).fetchone()
    item = dict(saved)
    item["capabilities"] = _loads(item.get("capabilities"), {}) or {}
    item["metadata"] = _loads(item.get("metadata"), {}) or {}
    item["ok"] = True
    return item


def _merge_caps(old: dict, new: dict) -> dict:
    out = dict(old)
    for key, value in new.items():
        if isinstance(value, (list, tuple)):
            merged = list(out.get(key) or [])
            for entry in value:
                if entry not in merged:
                    merged.append(entry)
            out[key] = merged
        elif isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _merge_caps(out[key], value)
        else:
            out[key] = value
    return out


# ============================================================
# A5. 状态汇总
# ============================================================

def _probe_summary(con, agent_id: str) -> list[dict]:
    """每个探针类型的最新一次结果 + 历史命中率。"""
    rows = con.execute(
        "SELECT * FROM agent_probe WHERE agent_id = ? ORDER BY at DESC, id DESC", (agent_id,)
    ).fetchall()
    latest: dict[str, dict] = {}
    for row in rows:
        probe = str(row["probe"])
        if probe not in latest:
            latest[probe] = {"probe": probe, "state": row["state"], "detail": row["detail"],
                             "latency_ms": row["latency_ms"], "at": row["at"],
                             "target": row["target"], "found": 0, "total": 0}
        latest[probe]["total"] += 1
        if str(row["state"]) == "found":
            latest[probe]["found"] += 1
    return [latest[key] for key in sorted(latest)]


def _session_summary(con, agent_id: str) -> dict:
    rows = con.execute(
        "SELECT * FROM agent_session WHERE agent_id = ? ORDER BY started_at DESC, id DESC",
        (agent_id,),
    ).fetchall()
    active = [r for r in rows if str(r["status"]) == "active"]
    recent = [{"id": r["id"], "external_id": r["external_id"], "title": r["title"],
               "status": r["status"], "started_at": r["started_at"], "ended_at": r["ended_at"]}
              for r in rows[:5]]
    return {"total": len(rows), "active": len(active), "recent": recent}


def _memory_summary(con, agent_id: str) -> dict:
    row = con.execute(
        "SELECT count(*) AS total, "
        "sum(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved, "
        "max(recorded_at) AS last_at FROM memory WHERE agent_id = ?", (agent_id,)
    ).fetchone()
    total = int(row["total"] or 0) if row else 0
    approved = int(row["approved"] or 0) if row else 0
    return {"total": total, "approved": approved, "last_at": row["last_at"] if row else None}


def agent_status(store) -> list[dict]:
    """每个智能体的运行态：状态/在线起点/最后活动/探针/会话/记忆。"""
    con = _con(store)
    rows = con.execute("SELECT * FROM agent ORDER BY id").fetchall()
    out: list[dict] = []
    for row in rows:
        item = dict(row)
        meta = _loads(item.get("metadata"), {}) or {}
        caps = _loads(item.get("capabilities"), {}) or {}
        out.append({
            "id": item["id"],
            "display_name": item["display_name"],
            "ecosystem": item["ecosystem"],
            "kind": item["kind"],
            "status": item["status"],
            "online_since": meta.get("online_since"),
            "last_seen": item["last_seen"],
            "last_heartbeat": item.get("last_heartbeat"),
            "heartbeat_source": item.get("heartbeat_source"),
            "static_registered": bool(item.get("static_registered")),
            "enabled": bool(item.get("enabled")),
            "protocols": caps.get("protocols") or [],
            "config_hint": caps.get("config_hint") or "",
            "capabilities": caps,
            "probes": _probe_summary(con, item["id"]),
            "sessions": _session_summary(con, item["id"]),
            "memories": _memory_summary(con, item["id"]),
        })
    return out


# ============================================================
# A6. 会话生命周期
# ============================================================

def register_session(store, agent_id: str, external_id: str, title: str = "", cwd: str = "",
                     scope_id: str | None = None) -> dict:
    """登记（或复用）一个外部会话。UNIQUE(agent_id, external_id) 保证幂等。"""
    aid = (agent_id or "").strip()
    ext = (external_id or "").strip()
    if not aid:
        raise ValueError("agent_id 不能为空")
    if not ext:
        raise ValueError("external_id 不能为空")
    stamp = _now()
    with _txn(store) as con:
        row = con.execute(
            "SELECT * FROM agent_session WHERE agent_id = ? AND external_id = ?", (aid, ext)
        ).fetchone()
        if row is None:
            if not con.execute("SELECT 1 FROM agent WHERE id = ?", (aid,)).fetchone():
                _insert_agent(con, aid, display_name=aid, ecosystem="custom", kind="unknown",
                              status="online", stamp=stamp, capabilities={},
                              metadata={"auto_registered": True})
            sid = _uid("as-")
            con.execute(
                "INSERT INTO agent_session(id, agent_id, external_id, title, cwd, scope_id, "
                "status, started_at, ended_at, spec) VALUES(?,?,?,?,?,?,?,?,?,?)",
                (sid, aid, ext, title or "", cwd or "", scope_id, "active", stamp, None, "{}"),
            )
            _audit(store, "agent.session.begin", sid,
                   {"agent_id": aid, "external_id": ext, "title": title})
        else:
            sid = str(row["id"])
            con.execute(
                "UPDATE agent_session SET title = ?, cwd = ?, scope_id = coalesce(?, scope_id), "
                "status = 'active', ended_at = NULL WHERE id = ?",
                (title or row["title"], cwd or row["cwd"], scope_id, sid),
            )
            _audit(store, "agent.session.resume", sid,
                   {"agent_id": aid, "external_id": ext, "title": title})
        _touch_last_seen(con, aid, stamp)
        saved = con.execute("SELECT * FROM agent_session WHERE id = ?", (sid,)).fetchone()
    item = dict(saved)
    item["spec"] = _loads(item.get("spec"), {}) or {}
    item["resumed"] = row is not None
    return item


def end_session(store, agent_id: str, external_id: str, turns=None) -> dict:
    """结束会话；turns 作为会话明细存档，并尝试触发会话沉淀工作流。"""
    aid = (agent_id or "").strip()
    ext = (external_id or "").strip()
    if not aid:
        raise ValueError("agent_id 不能为空")
    if not ext:
        raise ValueError("external_id 不能为空")
    stamp = _now()
    turn_list = list(turns or []) if isinstance(turns, (list, tuple)) else []
    with _txn(store) as con:
        row = con.execute(
            "SELECT * FROM agent_session WHERE agent_id = ? AND external_id = ?", (aid, ext)
        ).fetchone()
        if row is None:
            if not con.execute("SELECT 1 FROM agent WHERE id = ?", (aid,)).fetchone():
                _insert_agent(con, aid, display_name=aid, ecosystem="custom", kind="unknown",
                              status="online", stamp=stamp, capabilities={},
                              metadata={"auto_registered": True})
            sid = _uid("as-")
            con.execute(
                "INSERT INTO agent_session(id, agent_id, external_id, title, cwd, scope_id, "
                "status, started_at, ended_at, spec) VALUES(?,?,?,?,?,?,?,?,?,?)",
                (sid, aid, ext, "", "", None, "ended", stamp, stamp,
                 _dumps({"turns": turn_list})),
            )
            _audit(store, "agent.session.end", sid,
                   {"agent_id": aid, "external_id": ext, "orphan": True, "turns": len(turn_list)})
        else:
            sid = str(row["id"])
            spec = _loads(row["spec"], {}) or {}
            if turn_list:
                spec["turns"] = turn_list
            con.execute(
                "UPDATE agent_session SET status = 'ended', ended_at = ?, spec = ? WHERE id = ?",
                (stamp, _dumps(spec), sid),
            )
            _audit(store, "agent.session.end", sid,
                   {"agent_id": aid, "external_id": ext, "turns": len(turn_list)})
        _touch_last_seen(con, aid, stamp)
        saved = con.execute("SELECT * FROM agent_session WHERE id = ?", (sid,)).fetchone()
    item = dict(saved)
    item["spec"] = _loads(item.get("spec"), {}) or {}
    item["turns"] = len(turn_list)
    item["workflow"] = _try_session_workflow(store, aid, item, turn_list)
    return item


def _try_session_workflow(store, agent_id: str, session: dict, turns: list) -> dict | None:
    """若 workflows 模块已就绪，跑"智能体会话沉淀"；未就绪时安静跳过。"""
    try:
        from . import workflows  # noqa: PLC0415 - 依赖可能尚未落地
    except Exception:  # noqa: BLE001
        return None
    runner = getattr(workflows, "run_workflow", None)
    if not callable(runner):
        return None
    try:
        result = runner(store, None, SESSION_WORKFLOW, {
            "agent_id": agent_id,
            "external_id": session.get("external_id"),
            "title": session.get("title"),
            "turns": turns,
        }, scope=session.get("scope_id") or "global", trigger="session-end")
        return {"id": (result or {}).get("id"), "status": (result or {}).get("status"),
                "template": SESSION_WORKFLOW}
    except Exception as exc:  # noqa: BLE001 - 工作流失败不影响会话结账
        return {"error": "%s: %s" % (type(exc).__name__, exc),
                "template": SESSION_WORKFLOW}


# ============================================================
# A7. 周期探活
# ============================================================

_WATCH_LOCK = threading.Lock()
_WATCHERS: dict[int, dict] = {}


def watch(store, interval: int | float = 20) -> dict:
    """启动后台探活线程（守护线程，不阻塞主流程）。重复调用复用同一线程。"""
    period = max(1.0, float(interval or 20))
    with _WATCH_LOCK:
        for state in list(_WATCHERS.values()):
            if (state["thread"].is_alive() and state.get("store_id") == id(store)
                    and state.get("period") == period):
                return {"started": False, "already_running": True, "interval": period,
                        "thread": state["thread"].name, "ticks": state["ticks"]}
        stop = threading.Event()
        state = {"store": store, "period": period, "ticks": 0, "stop": stop,
                 "store_id": id(store), "last": None}

        def loop() -> None:
            while not stop.is_set():
                try:
                    state["last"] = probe_all(store)
                except Exception as exc:  # noqa: BLE001 - 后台线程绝不能让异常冒泡
                    state["last"] = {"error": "%s: %s" % (type(exc).__name__, exc)}
                state["ticks"] += 1
                if stop.wait(period):
                    break

        thread = threading.Thread(target=loop, name="memora-agent-watch", daemon=True)
        state["thread"] = thread
        _WATCHERS[id(thread)] = state
        thread.start()
    return {"started": True, "already_running": False, "interval": period,
            "thread": thread.name, "ticks": 0}


def stop_watch() -> int:
    """停止所有后台探活线程，返回停止数量（测试用）。"""
    with _WATCH_LOCK:
        count = 0
        for key, state in list(_WATCHERS.items()):
            state["stop"].set()
            thread = state["thread"]
            if thread.is_alive():
                thread.join(timeout=2.0)
                count += 1
            _WATCHERS.pop(key, None)
        return count


def watch_state() -> list[dict]:
    """当前后台探活线程状态（调试与测试用）。"""
    with _WATCH_LOCK:
        return [{"name": s["thread"].name, "alive": s["thread"].is_alive(),
                 "interval": s["period"], "ticks": s["ticks"]} for s in _WATCHERS.values()]


def probe_once(store, agent_id: str, ttl: float = DEFAULT_TTL) -> dict:
    """对单个智能体跑一遍探针并落库（接口/调试复用）。"""
    return probe_all(store, ttl=ttl, agents=[agent_id])
