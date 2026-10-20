# -*- coding: utf-8 -*-
"""跑一遍全部内置工作流（验收用）：每条模板只给它**声明的输入**。

用法：
    python tools/run_all_workflows.py [--data DIR] [--gateway none|empty|both]

  --data     数据目录（默认：新建临时目录，不碰真实数据；目录未初始化时自动 init_db + 播种模板）
  --gateway  none  = gw=None（测试路径）；empty = 0 个档位的真实 ModelGateway（HTTP/MCP 路径）；
             both（默认）= 两条路径各用一个全新目录跑一遍，并逐模板比对状态序列。
退出码：0 全部 ok/partial 且两条路径一致；1 有模板 failed / 抛异常；2 两条路径结果不一致。
外发网络被禁用（socket.connect 直接抛错），确认离线行为不依赖网络。
"""
from __future__ import annotations
import argparse
import socket
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from memora_core import db as dbmod          # noqa: E402
from memora_core import models               # noqa: E402
from memora_core import workflows            # noqa: E402
from memora_core.store import Store          # noqa: E402
from memora_core.vault import Vault          # noqa: E402


def _no_network(self, address):  # noqa: ANN001
    raise OSError("run_all_workflows 禁止外发网络：%r" % (address,))


def prepare(data: Path) -> tuple[Store, dict]:
    """初始化库、播种模板，并造一组样本（两条新旧记忆、一条久未使用的记忆、样本文档、会话）。"""
    data.mkdir(parents=True, exist_ok=True)
    dbmod.init_db(data / "memora.db")
    store = Store(data / "memora.db", Vault(data / "vault"))
    workflows.seed_templates(store)
    old = store.add_memory({"title": "数据库选型（旧）", "body": "项目使用 MySQL 作为数据库。",
                            "kind": "fact", "scope_id": "global", "status": "approved",
                            "recorded_at": "2026-01-01T00:00:00Z",
                            "updated_at": "2026-01-01T00:00:00Z", "importance": 0.2})
    new = store.add_memory({"title": "数据库选型（新）", "body": "项目改用 SQLite 作为事务真源。",
                            "kind": "decision", "scope_id": "global", "status": "approved",
                            "recorded_at": "2026-10-01T00:00:00Z"})
    doc = data / "samples" / "bm25.md"
    doc.parent.mkdir(parents=True, exist_ok=True)
    doc.write_bytes("# BM25 打分\n\nBM25 按词频饱和与文档长度归一给分。RRF 融合多路召回。\n"
                    .encode("utf-8"))
    values = {
        "content": "我们决定使用 SQLite 作为事务真源。BM25 很重要。", "query": "事务真源",
        "scope": "global", "budget": 400,
        "candidate": {"title": "验收候选", "body": "BM25 打分很重要", "kind": "knowledge"},
        "memory": new["id"], "a_id": new["id"], "b_id": old["id"], "valid_from": "2026-10-01",
        "new_id": new["id"], "old_id": old["id"],
        "workspace": str(data / "workspace"), "window": "7d", "since": "2026-01-01",
        "topic": "数据库", "count": 3, "agent": "acceptance", "event_id": "acc-1",
        "text": "验收文本：先定义，再推导。", "path": str(doc), "items": [new["id"], old["id"]],
        "session": {"turns": [{"role": "user", "content": "以后默认用 SQLite。"},
                              {"role": "assistant", "content": "好的，已记录这个决定。"}]},
    }
    return store, values


def run_path(label: str, data: Path, use_gateway: bool) -> dict:
    store, values = prepare(data)
    gw = models.ModelGateway(store) if use_gateway else None
    rows = {}
    for template in workflows.list_templates(store):
        tid = template["id"]
        names = list((template.get("spec") or {}).get("inputs") or {})
        inputs = {name: values.get(name, "验收") for name in names}
        try:
            run = workflows.run_workflow(store, gw, tid, inputs, scope="global",
                                         trigger="acceptance")
            rows[tid] = {"status": run.get("status"),
                         "steps": [(s["node_id"], s["status"]) for s in run.get("steps") or []],
                         "degraded": list(run.get("degraded") or []),
                         "error": str(run.get("error") or "")[:80]}
        except Exception as exc:  # noqa: BLE001
            rows[tid] = {"status": "EXC:" + type(exc).__name__, "steps": [], "degraded": [],
                         "error": str(exc)[:80]}
    store.close()
    print("== %s  (%s)" % (label, data))
    for tid, row in rows.items():
        print("%-28s %-9s steps=%-2d degraded=%-2d %s" % (
            tid, row["status"], len(row["steps"]), len(row["degraded"]), row["error"]))
    good = sum(1 for r in rows.values() if r["status"] in ("ok", "partial"))
    print("usable=%d failed=%d total=%d" % (good, len(rows) - good, len(rows)))
    return rows


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="run_all_workflows")
    parser.add_argument("--data", default=None)
    parser.add_argument("--gateway", choices=["none", "empty", "both"], default="both")
    args = parser.parse_args(argv)
    socket.socket.connect = _no_network
    base = Path(args.data) if args.data else Path(tempfile.mkdtemp(prefix="memora-runall-"))
    results = {}
    if args.gateway in ("none", "both"):
        results["none"] = run_path("gw=None", base / "gw-none" if args.gateway == "both" else base,
                                   False)
    if args.gateway in ("empty", "both"):
        results["empty"] = run_path("ModelGateway（0 个档位）",
                                    base / "gw-empty" if args.gateway == "both" else base, True)
    failed = [tid for rows in results.values() for tid, row in rows.items()
              if row["status"] not in ("ok", "partial")]
    mismatched = []
    if len(results) == 2:
        for tid, row in results["none"].items():
            other = results["empty"].get(tid) or {}
            if (row["status"], row["steps"], row["degraded"]) != \
                    (other.get("status"), other.get("steps"), other.get("degraded")):
                mismatched.append(tid)
        print("\n两条路径逐模板比对（run 状态 + 步骤状态序列 + degraded）：%s"
              % ("完全一致" if not mismatched else "不一致：" + ", ".join(mismatched)))
    if failed:
        print("FAILED:", ", ".join(sorted(set(failed))))
        return 1
    return 2 if mismatched else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
