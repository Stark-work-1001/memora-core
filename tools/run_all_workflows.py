# -*- coding: utf-8 -*-
"""跑一遍全部内置工作流，报告可用性（验收用）。"""
from __future__ import annotations
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from memora_core.store import Store            # noqa: E402
from memora_core.vault import Vault            # noqa: E402
from memora_core import workflows              # noqa: E402

VALUES = {
    "content": "验收内容", "query": "BM25 记忆", "scope": "global", "budget": 400,
    "candidate": {"title": "验收候选", "body": "BM25 打分很重要", "kind": "knowledge"},
    "memory": {"id": "m-1"}, "a_id": "m-1", "b_id": "m-2", "workspace": "D:/x",
    "window": "7d", "since": "2026-10-01", "topic": "BM25", "count": 3,
    "agent": "coordinator", "event_id": "acc", "text": "验收文本",
    "path": str(ROOT / "data" / "vault" / "notes"), "items": [], "session": {"id": "s1"},
}


def main(data="data"):
    store = Store(Path(data) / "memora.db", Vault(Path(data) / "vault"))
    rows = []
    for t in workflows.list_templates(store):
        tid = t["id"]
        spec = t.get("spec") or {}
        names = list((spec.get("inputs") or {}).keys())
        inputs = {n: VALUES.get(n, "验收") for n in names}
        try:
            r = workflows.run_workflow(store, None, tid, inputs, scope="global",
                                       trigger="acceptance")
            st = r.get("status")
            rows.append((tid, st, len(r.get("steps") or []), len(r.get("degraded") or []),
                         str(r.get("error") or "")[:60]))
        except Exception as exc:
            rows.append((tid, "EXC:" + type(exc).__name__, 0, 0, str(exc)[:60]))
    for r in rows:
        print("%-28s %-9s steps=%-2d degraded=%-2d %s" % r)
    good = sum(1 for r in rows if r[1] in ("ok", "partial"))
    print("")
    print("usable=%d failed=%d total=%d" % (good, len(rows) - good, len(rows)))
    return 0 if good else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1] if len(sys.argv) > 1 else "data"))
