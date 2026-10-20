# -*- coding: utf-8 -*-
"""Offline retrieval evaluation harness for memora-core (stdlib only).

Loads a labelled dataset with graded relevance (default: old/datasets/memory-eval-v1, read in
place, never modified) into a fresh temporary database and runs every requested strategy over the
queries of one split. Per strategy it prints:

    R@10     recall@10 over documents with grade >= 1
    MRR@10   reciprocal rank of the first relevant document within the top 10
    nDCG@10  graded nDCG@10, gain 2^grade - 1
    succ@10  share of queries with a grade-2 document in the top 10
    zero     share of queries that returned no hit at all
    p50/p95  per-query wall-clock latency of the call in milliseconds (after one warm-up call)

Strategies are memora strategies ("hybrid" = the default, "bm25", "substring", "vector",
"graph") or a "+"-joined channel combination such as "bm25+substring", plus two reference
retrievers that only use what the bundled SQLite can do natively:

    trigram        FTS5 tokenize='trigram' MATCH on terms of >= 3 characters
    trigram+like   trigram MATCH, then LIKE for 1-2 character CJK runs (which trigram cannot match)

Everything runs offline with gw=None unless --gateway-data points at a memora data directory
whose configured models should be measured (that run calls those endpoints and records
model_call rows in that data directory, like any other use of the gateway).

Dataset integrity: the SHA-256 of each dataset file, with CRLF normalised to LF so that a Windows
checkout hashes the same as the frozen file, is compared with the hashes recorded in the dataset
README. A mismatch aborts with exit status 2 unless --allow-modified is given.

Usage (from the repository root):
    python tools/eval_retrieval.py --split test
    python tools/eval_retrieval.py --split dev --strategies hybrid,bm25+substring --paired hybrid bm25+substring
    python tools/eval_retrieval.py --split test --json
    python tools/eval_retrieval.py --split dev --set MAX_LIKE_GRAMS=12      # ablation on dev only
    python tools/eval_retrieval.py --split test --code-root ../memora-core-1.0.0   # another checkout
    python tools/eval_retrieval.py --split dev --budget 1200     # like the UI: MMR + token packing
    python tools/eval_retrieval.py --latency-at 1000,10000       # default-search latency at scale

Tune on dev, report test. The dev split is also the regression gate in tests/test_retrieval_eval.py.
"""
from __future__ import annotations

import argparse
import ast
import hashlib
import importlib
import importlib.util
import json
import math
import re
import shutil
import sqlite3
import statistics
import sys
import tempfile
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DATASET = REPO_ROOT / "old" / "datasets" / "memory-eval-v1"
K = 10
DEFAULT_STRATEGIES = ("hybrid", "bm25", "substring", "bm25+substring", "vector",
                      "trigram", "trigram+like")
REFERENCE_STRATEGIES = ("trigram", "trigram+like")
METRICS = ("recall", "mrr", "ndcg", "success", "zero")
STAMP = "2026-01-01T00:00:00Z"

_HASH_RE = re.compile(r"`([\w.-]+)`\s+([0-9a-f]{64})")
_CJK = "㐀-䶿一-鿿豈-﫿぀-ヿ가-힯"
_REF_TOKEN_RE = re.compile(r"[A-Za-z0-9_][A-Za-z0-9_.'-]*|[%s]+" % _CJK)
_CJK_START_RE = re.compile("[%s]" % _CJK)


# ---------------------------------------------------------------------------
# dataset
# ---------------------------------------------------------------------------

def read_jsonl(path) -> list:
    rows = []
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        if line.strip():
            rows.append(json.loads(line))
    return rows


def file_sha256(path) -> str:
    """SHA-256 of the file with CRLF normalised to LF (git autocrlf checkouts hash the same)."""
    raw = Path(path).read_bytes().replace(b"\r\n", b"\n")
    return hashlib.sha256(raw).hexdigest()


def check_dataset(dataset) -> dict:
    """Compare file hashes with the ones frozen in README.md. ok=None when none are recorded."""
    dataset = Path(dataset)
    frozen = {}
    readme = dataset / "README.md"
    if readme.is_file():
        for name, digest in _HASH_RE.findall(readme.read_text(encoding="utf-8")):
            frozen[name] = digest
    files = {}
    for name in ("corpus.jsonl", "queries.jsonl"):
        actual = file_sha256(dataset / name)
        want = frozen.get(name)
        files[name] = {"sha256": actual, "frozen": want,
                       "ok": (actual == want) if want else None}
    states = [info["ok"] for info in files.values()]
    if all(state is None for state in states):
        ok = None
    else:
        ok = all(state is True for state in states)
    return {"files": files, "ok": ok}


def load_split(dataset, split: str) -> tuple:
    corpus = read_jsonl(Path(dataset) / "corpus.jsonl")
    queries = read_jsonl(Path(dataset) / "queries.jsonl")
    if split != "all":
        queries = [q for q in queries if q.get("split") == split]
    return corpus, queries


def scope_of(project) -> str:
    return "global" if project in (None, "", "@user") else "workspace:%s" % project


# ---------------------------------------------------------------------------
# metrics
# ---------------------------------------------------------------------------

def query_metrics(ranked, relevant: dict, k: int = K) -> dict:
    """recall / MRR / graded nDCG / success / zero-result for one query."""
    rel = {doc: int(grade) for doc, grade in (relevant or {}).items() if int(grade) >= 1}
    top = []
    for doc in list(ranked or [])[:k]:
        if doc not in top:
            top.append(doc)
    found = [doc for doc in top if doc in rel]
    rr = 0.0
    for pos, doc in enumerate(top, 1):
        if doc in rel:
            rr = 1.0 / pos
            break
    dcg = sum((2 ** rel[doc] - 1) / math.log2(pos + 1)
              for pos, doc in enumerate(top, 1) if doc in rel)
    ideal = sorted(rel.values(), reverse=True)[:k]
    idcg = sum((2 ** grade - 1) / math.log2(pos + 1) for pos, grade in enumerate(ideal, 1))
    return {
        "recall": len(found) / len(rel) if rel else 0.0,
        "mrr": rr,
        "ndcg": dcg / idcg if idcg else 0.0,
        "success": 1.0 if any(rel[doc] >= 2 for doc in found) else 0.0,
        "zero": 0.0 if ranked else 1.0,
    }


def aggregate(rows: list) -> dict:
    if not rows:
        return {"n": 0}
    out = {name: round(statistics.fmean(row[name] for row in rows), 4) for name in METRICS}
    out["n"] = len(rows)
    return out


def percentile(values, q: float) -> float:
    """Nearest-rank percentile."""
    if not values:
        return 0.0
    ordered = sorted(values)
    idx = min(len(ordered) - 1, max(0, int(math.ceil(q * len(ordered))) - 1))
    return ordered[idx]


def paired(report: dict, first: str, second: str, metric: str = "ndcg") -> dict:
    """Per-query wins / losses / ties of `first` against `second`."""
    one = report["strategies"][first]["per_query"]
    two = report["strategies"][second]["per_query"]
    wins = losses = ties = 0
    for qid, value in one.items():
        other = two.get(qid, 0.0)
        if value > other + 1e-9:
            wins += 1
        elif other > value + 1e-9:
            losses += 1
        else:
            ties += 1
    return {"first": first, "second": second, "metric": metric,
            "better": wins, "worse": losses, "tie": ties}


# ---------------------------------------------------------------------------
# code under test
# ---------------------------------------------------------------------------

def load_modules(code_root=None) -> dict:
    root = Path(code_root).resolve() if code_root else REPO_ROOT
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))
    mods = {name: importlib.import_module("memora_core." + name)
            for name in ("db", "retrieval", "store")}
    origin = Path(mods["retrieval"].__file__).resolve()
    if root not in origin.parents:
        raise SystemExit("memora_core was imported from %s, not from %s" % (origin, root))
    return mods


def apply_overrides(module, overrides) -> dict:
    """--set NAME=VALUE on module constants (existing names only). Returns the old values."""
    old = {}
    for item in overrides or []:
        name, _, raw = str(item).partition("=")
        name = name.strip()
        if not name or not hasattr(module, name):
            raise SystemExit("--set: %s has no attribute %r" % (module.__name__, name))
        old[name] = getattr(module, name)
        setattr(module, name, ast.literal_eval(raw.strip()))
    return old


def build_database(db_mod, corpus: list, db_path: Path):
    """Fresh DB with the corpus as approved memories (title rule = MCP default: first 60 chars)."""
    db_mod.init_db(db_path)
    con = db_mod.connect(db_path)
    rows = []
    for doc in corpus:
        content = doc["content"]
        title = " ".join(content.split())[:60]
        rows.append((doc["id"], scope_of(doc.get("project")), doc.get("category") or "fact",
                     title, content, "", "approved", 0.8, 0.5, STAMP, STAMP, 0))
    con.executemany(
        "INSERT INTO memory(id, scope_id, kind, title, body, summary, status, trust, importance,"
        " recorded_at, updated_at, tokens) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", rows)
    reference = True
    try:
        con.execute("CREATE VIRTUAL TABLE ref_trigram USING fts5(title, body, summary,"
                    " content='memory', content_rowid='rowid', tokenize='trigram')")
        con.execute("INSERT INTO ref_trigram(ref_trigram) VALUES('rebuild')")
    except sqlite3.Error:
        reference = False      # SQLite built without the trigram tokenizer
    return con, reference


def reference_terms(query: str) -> tuple:
    """(trigram MATCH terms, 1-2 character CJK runs)."""
    long_terms, short_runs = [], []
    for tok in _REF_TOKEN_RE.findall(query or ""):
        if _CJK_START_RE.match(tok):
            if len(tok) >= 3:
                long_terms.extend(tok[pos:pos + 3] for pos in range(len(tok) - 2))
            else:
                short_runs.append(tok)
        elif len(tok) >= 3:
            long_terms.append(tok.lower())
    return list(dict.fromkeys(long_terms))[:64], list(dict.fromkeys(short_runs))


def reference_retriever(con, with_like: bool):
    def run(project, query, k):
        scopes = list(dict.fromkeys([scope_of(project), "global"]))
        marks = ",".join("?" * len(scopes))
        long_terms, short_runs = reference_terms(query)
        out = []
        if long_terms:
            expr = " OR ".join('"%s"' % term.replace('"', '""') for term in long_terms)
            sql = ("SELECT m.id FROM ref_trigram JOIN memory m ON m.rowid = ref_trigram.rowid"
                   " WHERE ref_trigram MATCH ? AND m.status = 'approved' AND m.scope_id IN (%s)"
                   " ORDER BY bm25(ref_trigram, 3.0, 1.5, 1.0) LIMIT ?" % marks)
            out = [row[0] for row in con.execute(sql, (expr, *scopes, k))]
        if with_like:
            for run_text in short_runs:
                pattern = "%" + run_text + "%"
                sql = ("SELECT id FROM memory WHERE (title LIKE ? OR body LIKE ?)"
                       " AND status = 'approved' AND scope_id IN (%s) LIMIT ?" % marks)
                for row in con.execute(sql, (pattern, pattern, *scopes, k)):
                    if row[0] not in out:
                        out.append(row[0])
        return out[:k], None
    return run


def memora_retriever(retrieval, target, gw, strategy: str, budget=None):
    if "+" in strategy and strategy not in getattr(retrieval, "_STRATEGY_ALIASES", {}) \
            and not getattr(retrieval, "CHANNEL_COMBINATIONS", False):
        # older checkouts (1.0.0) only know named strategies: register the combination
        retrieval._STRATEGY_ALIASES[strategy] = tuple(strategy.split("+"))

    def run(project, query, k):
        res = retrieval.search(target, gw, query, scope=scope_of(project), limit=k,
                               strategy=strategy, budget=budget)
        return [hit["id"] for hit in res.get("hits") or []], res
    return run


def _describe(responses: list) -> dict:
    """What actually ran, as reported by the responses (new fields are absent in 1.0.0)."""
    seen = {"channels_used": set(), "vector_model": set(), "semantic": set(), "degraded": set()}
    for res in responses:
        if not res:
            continue
        seen["channels_used"].add(",".join(res.get("channels_used") or []) or "-")
        seen["vector_model"].add(str(res.get("vector_model")))
        seen["semantic"].add(str(res.get("semantic")))
        for reason in res.get("degraded") or []:
            seen["degraded"].add(str(reason))
    return {key: sorted(values) for key, values in seen.items()}


# ---------------------------------------------------------------------------
# run
# ---------------------------------------------------------------------------

def evaluate(dataset=DEFAULT_DATASET, split: str = "test", strategies=DEFAULT_STRATEGIES,
             code_root=None, via: str = "store", overrides=None, k: int = K,
             gateway_data=None, budget=None) -> dict:
    dataset = Path(dataset)
    mods = load_modules(code_root)
    db_mod, retrieval = mods["db"], mods["retrieval"]
    old_values = apply_overrides(retrieval, overrides)
    corpus, queries = load_split(dataset, split)
    if not queries:
        raise SystemExit("split %r has no queries in %s" % (split, dataset))
    gw = None
    if gateway_data:
        models = importlib.import_module("memora_core.models")
        gdir = Path(gateway_data)
        gw = models.ModelGateway(db_path=gdir / "memora.db", data_dir=gdir)
    tmp = Path(tempfile.mkdtemp(prefix="memora_eval_"))
    store = None
    con = None
    try:
        con, reference_ok = build_database(db_mod, corpus, tmp / "memora.db")
        target = con
        if via == "store":
            store = mods["store"].Store(tmp / "memora.db")
            target = store
        report = {
            "dataset": dataset.name, "split": split, "queries": len(queries),
            "corpus": len(corpus), "k": k, "via": via, "gateway": bool(gw),
            "sqlite": sqlite3.sqlite_version, "python": sys.version.split()[0],
            "code_root": str(Path(code_root).resolve() if code_root else REPO_ROOT),
            "overrides": list(overrides or []), "budget": budget, "strategies": {},
        }
        for name in strategies:
            if name in REFERENCE_STRATEGIES:
                if not reference_ok:
                    report["strategies"][name] = {"skipped": "SQLite has no trigram tokenizer"}
                    continue
                fn = reference_retriever(con, with_like=(name == "trigram+like"))
            else:
                fn = memora_retriever(retrieval, target, gw, name, budget=budget)
            fn(queries[0].get("project"), queries[0]["query"], k)   # warm-up, not timed
            if gw is not None and name not in REFERENCE_STRATEGIES:
                # with a model, searches backfill the vector cache in bounded slices
                # (MAX_CLOUD_EMBED / BACKFILL_SECONDS per search); fill it for the whole corpus
                # (scope=None) before timing so every query sees a fully embedded corpus
                for _attempt in range(40):
                    res = retrieval.search(target, gw, queries[0]["query"], scope=None, limit=k)
                    if not any("还没有" in str(d) for d in res.get("degraded") or []):
                        break
            rows, latencies, responses = [], [], []
            for q in queries:
                started = time.perf_counter()
                ids, res = fn(q.get("project"), q["query"], k)
                latencies.append((time.perf_counter() - started) * 1000.0)
                responses.append(res)
                row = query_metrics(ids, q.get("relevant") or {}, k)
                row.update(id=q["id"], type=q.get("type") or "-", lang=q.get("lang") or "-")
                rows.append(row)
            types = sorted({row["type"] for row in rows})
            langs = sorted({row["lang"] for row in rows})
            report["strategies"][name] = {
                "overall": aggregate(rows),
                "by_type": {t: aggregate([row for row in rows if row["type"] == t]) for t in types},
                "by_lang": {g: aggregate([row for row in rows if row["lang"] == g]) for g in langs},
                "latency_ms": {"p50": round(percentile(latencies, 0.50), 2),
                               "p95": round(percentile(latencies, 0.95), 2),
                               "max": round(max(latencies), 2)},
                "per_query": {row["id"]: round(row["ndcg"], 6) for row in rows},
                "reported": _describe(responses),
            }
        return report
    finally:
        for name, value in old_values.items():
            setattr(retrieval, name, value)
        if store is not None:
            store.close()
        if con is not None:
            con.close()
        if gw is not None:
            gw.close()
        shutil.rmtree(tmp, ignore_errors=True)


def latency_at(sizes, strategies=("hybrid",), code_root=None, reps: int = 20,
               via: str = "store") -> dict:
    """Default-search latency on synthetic corpora of the given sizes (gw=None).

    The corpus is tests/test_retrieval.py's build_corpus (30 topics x 3 writing styles, Chinese
    with filler), repeated until it reaches the size; queries are its 10 topic names. Reports the
    cold first search (in-process caches empty) and p50/p95 of `reps` warm searches.
    Note: 1.0.0 given a Store only searched the 500 most recently updated memories, so compare
    old checkouts with via="connection".
    """
    mods = load_modules(code_root)
    root = Path(code_root).resolve() if code_root else REPO_ROOT
    spec = importlib.util.spec_from_file_location("_memora_fixture",
                                                  str(root / "tests" / "test_retrieval.py"))
    fixture = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fixture)
    out = {}
    for size in sizes:
        tmp = Path(tempfile.mkdtemp(prefix="memora_lat_"))
        store = None
        con = None
        try:
            mods["db"].init_db(tmp / "memora.db")
            con = mods["db"].connect(tmp / "memora.db")
            fixture.build_corpus(con, scale=max(1, int(math.ceil(size / 300.0))))
            count = con.execute("SELECT count(*) FROM memory").fetchone()[0]
            store = mods["store"].Store(tmp / "memora.db")
            target = store if via == "store" else con
            row = {"memories": count}
            for name in strategies:
                started = time.perf_counter()
                mods["retrieval"].search(target, None, fixture.QUERIES[0], limit=20, strategy=name)
                cold = (time.perf_counter() - started) * 1000.0
                samples = []
                for i in range(reps):
                    started = time.perf_counter()
                    mods["retrieval"].search(target, None, fixture.QUERIES[i % len(fixture.QUERIES)],
                                             limit=20, strategy=name)
                    samples.append((time.perf_counter() - started) * 1000.0)
                row[name] = {"cold_ms": round(cold, 1), "p50": round(percentile(samples, 0.5), 1),
                             "p95": round(percentile(samples, 0.95), 1)}
            out[size] = row
        finally:
            if store is not None:
                store.close()
            if con is not None:
                con.close()
            shutil.rmtree(tmp, ignore_errors=True)
    return out


def format_report(report: dict, check: dict | None = None, breakdown: bool = False) -> str:
    lines = []
    lines.append("%s  split=%s  queries=%d  corpus=%d  k=%d  via=%s  gw=%s  sqlite=%s  python=%s"
                 % (report["dataset"], report["split"], report["queries"], report["corpus"],
                    report["k"], report["via"], "configured" if report["gateway"] else "None",
                    report["sqlite"], report["python"]))
    if report.get("budget"):
        lines.append("budget=%s tokens (MMR + greedy packing, as the search page does)"
                     % report["budget"])
    if check is not None:
        parts = []
        for name, info in check["files"].items():
            state = {True: "ok", False: "MISMATCH", None: "no frozen hash"}[info["ok"]]
            parts.append("%s %s (%s)" % (name, info["sha256"][:12], state))
        lines.append("dataset sha256 (LF-normalised): " + ", ".join(parts))
    if report.get("overrides"):
        lines.append("overrides: " + ", ".join(report["overrides"]))
    header = "%-22s %7s %7s %8s %8s %6s %8s %8s" % (
        "strategy", "R@10", "MRR@10", "nDCG@10", "succ@10", "zero", "p50 ms", "p95 ms")
    lines.append(header)
    lines.append("-" * len(header))
    for name, data in report["strategies"].items():
        label = name + (" (default)" if name == "hybrid" else "")
        if "skipped" in data:
            lines.append("%-22s skipped: %s" % (label, data["skipped"]))
            continue
        agg = data["overall"]
        lat = data["latency_ms"]
        lines.append("%-22s %7.3f %7.3f %8.3f %8.3f %6.3f %8.2f %8.2f" % (
            label, agg["recall"], agg["mrr"], agg["ndcg"], agg["success"], agg["zero"],
            lat["p50"], lat["p95"]))
    for name, data in report["strategies"].items():
        reported = data.get("reported") or {}
        if reported.get("channels_used") and reported["channels_used"] != ["-"]:
            lines.append("  %-20s channels_used=%s vector_model=%s semantic=%s" % (
                name, "|".join(reported["channels_used"]), "|".join(reported["vector_model"]),
                "|".join(reported["semantic"])))
    if breakdown:
        for key, title in (("by_type", "query type"), ("by_lang", "query language")):
            names = [n for n, d in report["strategies"].items() if "skipped" not in d]
            if not names:
                continue
            groups = sorted(report["strategies"][names[0]][key])
            lines.append("")
            lines.append("nDCG@10 by %s (n per group: %s)" % (title, ", ".join(
                "%s=%d" % (g, report["strategies"][names[0]][key][g]["n"]) for g in groups)))
            lines.append("%-22s " % "strategy" + " ".join("%11s" % g[:11] for g in groups))
            for name in names:
                cells = report["strategies"][name][key]
                lines.append("%-22s " % name + " ".join(
                    "%11.3f" % cells.get(g, {}).get("ndcg", 0.0) for g in groups))
    return "\n".join(lines)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Offline retrieval evaluation for memora-core.")
    parser.add_argument("--dataset", default=str(DEFAULT_DATASET),
                        help="dataset directory with corpus.jsonl / queries.jsonl")
    parser.add_argument("--split", default="test", choices=("dev", "test", "all"))
    parser.add_argument("--strategies", default=",".join(DEFAULT_STRATEGIES),
                        help="comma-separated; memora strategies, a+b channel combinations,"
                             " trigram, trigram+like")
    parser.add_argument("--via", default="store", choices=("store", "connection"),
                        help="pass a Store (what the server/MCP do) or a raw sqlite3 connection")
    parser.add_argument("--code-root", default=None,
                        help="directory containing the memora_core package to evaluate")
    parser.add_argument("--set", dest="overrides", action="append", default=[],
                        metavar="NAME=VALUE", help="override a retrieval module constant")
    parser.add_argument("--paired", nargs=2, metavar=("A", "B"), action="append", default=[],
                        help="per-query nDCG@10 wins/losses of A against B")
    parser.add_argument("--breakdown", action="store_true", help="nDCG@10 by query type / language")
    parser.add_argument("--json", action="store_true", help="print the full report as JSON")
    parser.add_argument("--allow-modified", action="store_true",
                        help="run even if the dataset hash does not match the frozen one")
    parser.add_argument("--gateway-data", default=None,
                        help="memora data directory whose configured models to use (calls them)")
    parser.add_argument("--budget", type=int, default=None,
                        help="token budget passed to search (turns on MMR and packing)")
    parser.add_argument("--latency-at", default=None, metavar="N,N",
                        help="only measure default-search latency on synthetic corpora of these sizes")
    args = parser.parse_args(argv)

    if args.latency_at:
        sizes = [int(x) for x in args.latency_at.split(",") if x.strip()]
        names = [s.strip() for s in args.strategies.split(",") if s.strip()
                 and s.strip() not in REFERENCE_STRATEGIES] if args.strategies != ",".join(
                     DEFAULT_STRATEGIES) else ["hybrid"]
        result = latency_at(sizes, names, code_root=args.code_root, via=args.via)
        if args.json:
            sys.stdout.write(json.dumps(result, ensure_ascii=False, indent=1) + "\n")
            return 0
        print("search(limit=20, gw=None) via %s; python=%s sqlite=%s"
              % (args.via, sys.version.split()[0], sqlite3.sqlite_version))
        for size, row in result.items():
            for name in names:
                cell = row[name]
                print("  %6d memories  %-16s cold %8.1f ms   warm p50 %7.1f ms   p95 %7.1f ms"
                      % (row["memories"], name, cell["cold_ms"], cell["p50"], cell["p95"]))
        return 0

    check = check_dataset(args.dataset)
    if check["ok"] is False and not args.allow_modified:
        sys.stderr.write("dataset hash mismatch: %s\n" % json.dumps(check["files"], indent=1))
        return 2
    strategies = [s.strip() for s in args.strategies.split(",") if s.strip()]
    report = evaluate(args.dataset, args.split, strategies, code_root=args.code_root,
                      via=args.via, overrides=args.overrides, gateway_data=args.gateway_data,
                      budget=args.budget)
    report["dataset_check"] = check
    report["paired"] = [paired(report, first, second) for first, second in args.paired]
    if args.json:
        sys.stdout.write(json.dumps(report, ensure_ascii=False, indent=1) + "\n")
        return 0
    print(format_report(report, check, breakdown=args.breakdown))
    for item in report["paired"]:
        print("paired nDCG@10 %s vs %s: better on %d, worse on %d, tie %d"
              % (item["first"], item["second"], item["better"], item["worse"], item["tie"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
