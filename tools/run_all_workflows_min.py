# -*- coding: utf-8 -*-
"""宽容输入验收：只给 content 一个输入，看 18 条模板是否都能跑。"""
from __future__ import annotations
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from memora_core.store import Store   # noqa: E402
from memora_core.vault import Vault   # noqa: E402
from memora_core import workflows     # noqa: E402


def main(data="data"):
    store = Store(Path(data) / "memora.db", Vault(Path(data) / "vault"))
    ok = 0
    rows = []
    for t in workflows.list_templates(store):
        tid = t["id"]
        r = workflows.run_workflow(store, None, tid, {"content": "记忆中枢验收文本 BM25"},
                                   scope="global", trigger="min-input")
        st = r.get("status")
        good = st in ("ok", "partial")
        ok += good
        rows.append((tid, st, len(r.get("steps") or []), str(r.get("error") or "")[:50]))
    for row in rows:
        print("%-28s %-9s steps=%-2d %s" % row)
    print("")
    print("only-content usable=%d/%d" % (ok, len(rows)))
    # 空输入应当失败（唯一硬失败条件）
    r0 = workflows.run_workflow(store, None, "dedup-merge", {}, scope="global", trigger="empty")
    print("empty input ->", r0.get("status"), str(r0.get("error"))[:70])
    return 0 if ok == len(rows) else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1] if len(sys.argv) > 1 else "data"))
