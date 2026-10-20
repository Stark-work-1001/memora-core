# -*- coding: utf-8 -*-
"""宽容输入验收：只给 content 一个输入，看 18 条模板是否都能跑。

用法：python tools/run_all_workflows_min.py [数据目录]（默认新建临时目录，不碰真实数据；
目录未初始化时自动 init_db + 播种模板）。退出码：全部 ok/partial 且空输入按预期失败 → 0，否则 1。
"""
from __future__ import annotations
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from memora_core import db as dbmod   # noqa: E402
from memora_core.store import Store   # noqa: E402
from memora_core.vault import Vault   # noqa: E402
from memora_core import workflows     # noqa: E402


def main(data=None):
    root = Path(data) if data else Path(tempfile.mkdtemp(prefix="memora-runmin-"))
    root.mkdir(parents=True, exist_ok=True)
    dbmod.init_db(root / "memora.db")
    store = Store(root / "memora.db", Vault(root / "vault"))
    workflows.seed_templates(store)
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
    store.close()
    return 0 if ok == len(rows) and r0.get("status") == "failed" else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1] if len(sys.argv) > 1 else None))
