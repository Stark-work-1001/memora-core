# -*- coding: utf-8 -*-
"""改大文件前的安全快照。

    python tools/safety.py snap memora_core/workflows.py
    python tools/safety.py list
    python tools/safety.py restore memora_core/workflows.py --to <stamp>

背景：协调者用 read(默认 2000 行) + write 的方式改 4199 行的 workflows.py，
文件被静默截断到 1323 行，且**仍能通过 compileall**（前半段是合法 Python）。
因此任何超过 SNAP_LINES 行的文件，在写入前都应先快照。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STORE = ROOT / ".snapshots"
SNAP_LINES = 400


def _stamp() -> str:
    return time.strftime("%Y%m%d-%H%M%S")


def snap(rel: str) -> dict:
    src = (ROOT / rel).resolve()
    if not src.exists():
        raise SystemExit("文件不存在: " + str(src))
    data = src.read_bytes()
    digest = hashlib.sha256(data).hexdigest()[:16]
    stamp = _stamp()
    dest = STORE / rel.replace("\\", "/") / (stamp + "-" + digest + ".bak")
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dest)
    meta = {"path": rel, "stamp": stamp, "sha256": digest,
            "bytes": len(data), "lines": data.count(b"\n") + 1,
            "at": time.strftime("%Y-%m-%dT%H:%M:%S")}
    (dest.with_suffix(".json")).write_text(json.dumps(meta, ensure_ascii=False, indent=2),
                                           encoding="utf-8")
    return meta


def list_snaps(rel: str | None = None) -> list[dict]:
    base = STORE / rel.replace("\\", "/") if rel else STORE
    out = []
    if not base.exists():
        return out
    for meta in sorted(base.rglob("*.json")):
        try:
            out.append(json.loads(meta.read_text(encoding="utf-8")))
        except ValueError:
            continue
    return out


def restore(rel: str, to: str | None) -> str:
    snaps = list_snaps(rel)
    if not snaps:
        raise SystemExit("没有快照: " + rel)
    chosen = None
    for s in snaps:
        if to is None or s["stamp"] == to or s["sha256"] == to:
            chosen = s
    if chosen is None:
        raise SystemExit("找不到匹配快照: " + str(to))
    src = STORE / rel.replace("\\", "/") / (chosen["stamp"] + "-" + chosen["sha256"] + ".bak")
    if not src.exists():
        raise SystemExit("快照文件缺失: " + str(src))
    dest = ROOT / rel
    snap(rel)  # 先给当前状态留一份，避免恢复又变成破坏
    shutil.copy2(src, dest)
    return "已恢复 %s <- %s (%d bytes)" % (rel, src.name, chosen["bytes"])


def guard(rel: str) -> dict:
    """写入前的护栏：超过 SNAP_LINES 行的文件必须先快照。"""
    src = ROOT / rel
    if not src.exists():
        return {"ok": True, "reason": "新文件，无需快照"}
    lines = src.read_bytes().count(b"\n") + 1
    if lines < SNAP_LINES:
        return {"ok": True, "reason": "小文件（%d 行），无需快照" % lines}
    return snap(rel) | {"ok": True, "reason": "已自动快照（%d 行 > %d）" % (lines, SNAP_LINES)}


def main() -> int:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("snap"); p.add_argument("path")
    p = sub.add_parser("guard"); p.add_argument("path")
    p = sub.add_parser("list"); p.add_argument("path", nargs="?")
    p = sub.add_parser("restore"); p.add_argument("path"); p.add_argument("--to", default=None)
    args = ap.parse_args()
    if args.cmd == "snap":
        print(json.dumps(snap(args.path), ensure_ascii=False, indent=2))
    elif args.cmd == "guard":
        print(json.dumps(guard(args.path), ensure_ascii=False, indent=2))
    elif args.cmd == "list":
        print(json.dumps(list_snaps(args.path), ensure_ascii=False, indent=2))
    elif args.cmd == "restore":
        print(restore(args.path, args.to))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
