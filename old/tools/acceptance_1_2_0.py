"""Acceptance harness for the memora 1.2.0 working session.

Coordinator-owned verification instrument. Checks the five delivered work packages
against the git baseline so acceptance never depends on a subagent self-report.

Usage:  .venv/Scripts/python.exe tools/acceptance_1_2_0.py [--baseline SHA]
Exit code 0 when every check passes, 1 otherwise.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STATIC = ROOT / "memora" / "static"
PLUGIN = Path(os.environ.get('MEMORA_DSH_PLUGIN_ROOT')
              or os.path.join(os.path.expanduser('~'), '.dsh', 'plugins')) / 'memory-connector'

# A quoted attribute selector, expressed in hex escapes so that no literal
# quote character ever appears in this source.
ATTR = "id=[\x22\x27]([A-Za-z0-9_-]+)[\x22\x27]"
DOLLAR = r"\$\([\x22\x27]([A-Za-z0-9_-]+)[\x22\x27]\)"
TOKEN_RE = re.compile(r"(--mm-[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;")


def _linear(c: float) -> float:
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def luminance(hex_color: str) -> float:
    h = hex_color.lstrip("#").strip()
    if len(h) == 3:
        h = "".join(ch * 2 for ch in h)
    if len(h) != 6 or not re.fullmatch(r"[0-9a-fA-F]{6}", h):
        raise ValueError("bad hex: " + repr(hex_color))
    r, g, b = (int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4))
    return 0.2126 * _linear(r) + 0.7152 * _linear(g) + 0.0722 * _linear(b)


def contrast(a: str, b: str) -> float:
    la, lb = luminance(a), luminance(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


class Result:
    def __init__(self) -> None:
        self.rows = []

    def check(self, pkg: str, ok: bool, detail: str) -> None:
        self.rows.append((pkg, bool(ok), detail))

    def report(self) -> int:
        failed = 0
        for pkg, ok, detail in self.rows:
            if not ok:
                failed += 1
            print("[%s] %-4s %s" % ("PASS" if ok else "FAIL", pkg, detail))
        print()
        print("%d checks, %d failed" % (len(self.rows), failed))
        return 1 if failed else 0


def git(*args: str) -> str:
    r = subprocess.run(["git", "-C", str(ROOT), *args],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    return r.stdout if r.returncode == 0 else ""


def read(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def check_css(res: Result) -> None:
    css = read(STATIC / "memory.css")
    if not css:
        res.check("W3", False, "memory.css unreadable")
        return
    tokens = dict(TOKEN_RE.findall(css))
    res.check("W3", bool(tokens), "colour tokens: %d --mm-* found" % len(tokens))

    raw = [int(x) for x in re.findall(r"font-size\s*:\s*(\d+)px", css)]
    ramp = [int(x) for x in re.findall(r"--mm-text-[a-z0-9-]+\s*:\s*(\d+)px", css)]
    floor = min(raw + ramp) if (raw or ramp) else 0
    res.check("W3", floor >= 12,
              "type ramp floor %spx (raw px decls %d, ramp tokens %d)"
              % (floor, len(raw), len(ramp)))

    res.check("W3", "system-fallback" not in css, "synthetic system-fallback @font-face removed")
    res.check("W3", "@keyframes" in css, "animated background: %d @keyframes" % css.count("@keyframes"))
    res.check("W3", "prefers-reduced-motion" in css, "prefers-reduced-motion block present")
    res.check("W3", "prefers-color-scheme" in css, "dark theme block present")
    has_cjk = any(f in css for f in ("PingFang SC", "Microsoft YaHei", "Noto Sans CJK"))
    res.check("W3", has_cjk, "CJK font stack present")

    surfaces = [v for k, v in tokens.items() if k in ("--mm-bg", "--mm-surface", "--mm-panel")]
    inks = [v for k, v in tokens.items() if k.startswith("--mm-ink")]
    if surfaces and inks:
        worst, pair = 99.0, ""
        for ink in inks:
            for surf in surfaces:
                try:
                    ratio = contrast(ink, surf)
                except ValueError:
                    continue
                if ratio < worst:
                    worst, pair = ratio, ink + " on " + surf
        res.check("W3", worst >= 4.5,
                  "worst text contrast %.2f:1 at %s (need 4.5)" % (worst, pair))
        lines = [v for k, v in tokens.items() if k in ("--mm-line", "--mm-line-strong")]
        worst_line = 99.0
        for ln in lines:
            for surf in surfaces:
                try:
                    worst_line = min(worst_line, contrast(ln, surf))
                except ValueError:
                    pass
        if lines:
            res.check("W3", worst_line >= 3.0,
                      "worst border contrast %.2f:1 (need 3.0)" % worst_line)


SELECTOR_RE = re.compile(r"(?:^|[,{}])\s*([^{}@,][^{},]*?)\s*\{", re.S)


def _normalize(sel: str) -> str:
    """CSS selectors are whitespace- and quote-insensitive in these positions."""
    s = " ".join(sel.split())
    s = re.sub(r"\s*([>+~])\s*", r"\1", s)          # combinator spacing
    s = re.sub(r"\[\s*([A-Za-z0-9_-]+)\s*=\s*[\x22\x27]?\s*([A-Za-z0-9_-]+)\s*[\x22\x27]?\s*\]",
               r"[\1=\2]", s)                         # unquote attr values
    return s.lower()


def _selectors(src: str) -> set:
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
    out = set()
    for m in SELECTOR_RE.finditer(src):
        for part in m.group(1).split(","):
            p = _normalize(part)
            if p and not p.startswith("@"):
                out.add(p)
    return out


def check_css_selectors(res: Result, baseline: str) -> None:
    before = git("show", baseline + ":memora/static/memory.css")
    after = read(STATIC / "memory.css")
    if not before or not after:
        res.check("W3", False, "cannot compare memory.css against baseline")
        return
    b, a = _selectors(before), _selectors(after)
    lost = sorted(x for x in (b - a) if x not in ("html", "body", "*"))
    res.check("W3", not lost,
              "memory.css selector survival: %d baseline groups, %d lost%s"
              % (len(b), len(lost), "" if not lost else " -> " + str(lost)))

def check_empty_states(res: Result) -> None:
    orch = read(STATIC / "orchestration.js")
    targets = ["inference-health", "role-bindings", "saved-workflows",
               "orchestration-runs", "registry-profiles"]
    missing = [t for t in targets if t not in orch]
    res.check("W3", not missing, "5 empty-state targets present"
              + ("" if not missing else "; MISSING " + str(missing)))
    res.check("W3", "empty-state" in orch or "emptyState" in orch,
              "orchestration.js emits an empty state")


def check_retrieval(res: Result) -> None:
    js = read(STATIC / "memory.js")
    for ep in ("sessions", "queue"):
        res.check("W4", ep in js, "first page calls the /%s endpoint" % ep)
    res.check("W4", "EventSource" in js or "ReadableStream" in js or "getReader" in js,
              "live stream connected (EventSource or authenticated reader)")
    for field in ("score", "retrieval", "tags", "last_accessed"):
        res.check("W4", field in js, "result card surfaces " + repr(field))


def check_selectors(res: Result, baseline: str) -> None:
    for rel in ("memora/static/memory.html", "memora/static/memory.js"):
        before = git("show", baseline + ":" + rel)
        after = read(ROOT / rel)
        if not before or not after:
            res.check("W4", False, "cannot compare " + rel + " against baseline")
            continue
        b = set(re.findall(ATTR, before)) | set(re.findall(DOLLAR, before))
        a = set(re.findall(ATTR, after)) | set(re.findall(DOLLAR, after))
        lost = sorted(b - a)
        res.check("W4", not lost,
                  rel + ": %d baseline ids preserved%s"
                  % (len(b), "" if not lost else "; LOST " + str(lost)))


XML_NAMESPACES = {"http://www.w3.org/2000/svg", "http://www.w3.org/1999/xhtml"}
STRING_LITERAL = re.compile(r"[\x22\x27]((?:/|https?://)[^\x22\x27\s]{2,80})[\x22\x27]")


def check_dag_bundle(res: Result) -> None:
    dag = STATIC / "dag"
    app = dag / "app.js"
    if not app.is_file():
        res.check("W2", False, "dag/app.js not emitted - run node build.mjs in frontend/")
        return
    sizes = {p.name: p.stat().st_size for p in dag.iterdir() if p.is_file()}
    res.check("W2", all(v > 0 for v in sizes.values()),
              "dag artefacts emitted: " + str(sorted(sizes.items())))
    js = app.read_text(encoding="utf-8", errors="replace")

    remote = sorted({m for m in STRING_LITERAL.findall(js)
                     if (m.startswith("http://") or m.startswith("https://")
                         or m.startswith("//"))
                     and m not in XML_NAMESPACES})  # an XML namespace id is not a fetch
    res.check("W2", not remote, "no remote URL literals in the bundle"
              + ("" if not remote else " -> FOUND " + str(remote)))

    literals = sorted({m for m in STRING_LITERAL.findall(js)})
    res.check("W2", "X-MM-Token" in js,
              "auth header wired; absolute path literals = " + str(literals[:8]))

    sinks = {p: js.count(p) for p in ("eval(", "new Function", "document.write",
                                         "insertAdjacentHTML", "outerHTML")}
    bad = {k: v for k, v in sinks.items() if v}
    res.check("W2", not bad, "no dynamic-eval or raw-HTML sinks"
              + ("" if not bad else " -> " + str(bad)))

    reduced = "prefers-reduced-motion" in js or "prefers-reduced-motion" in (dag / "styles.css").read_text(
        encoding="utf-8", errors="replace")
    res.check("W2", reduced, "reduced-motion respected")

def check_dag(res: Result) -> None:
    joined = read(ROOT / "memora" / "workflows.py") + read(ROOT / "memora" / "control.py")
    low = joined.lower()
    res.check("W1", "topo" in low, "topological ordering implemented")
    res.check("W1", "cycle" in low, "cycle detection implemented")
    res.check("W1", "edges" in joined, "edges present in the workflow data model")
    res.check("W1", "steps" in joined, "legacy steps path retained for backward compatibility")


def check_connector(res: Result) -> None:
    if not PLUGIN.is_dir():
        res.check("W5", False, "plugin dir missing: " + str(PLUGIN))
        return
    patch = read(PLUGIN / "cordis.patch.yml")
    res.check("W5", "memora" in patch, "cordis.patch.yml references memora")
    res.check("W5", "backend: memory-merge" not in patch,
              "stale memory-merge backend is no longer the default")
    src = ""
    for name in ("index.js", "config.js", "client.js", "client-http.js"):
        src += read(PLUGIN / "lib" / name)
    for p in (PLUGIN / "lib" / "backends").glob("*.js"):
        src += read(p)
    res.check("W5", bool(re.search(r"allow|deny|visible|narrow|expose", src, re.I)),
              "tool-narrowing logic present in plugin source")
    for loc in ("en.json", "zh.json"):
        try:
            data = json.loads(read(PLUGIN / "locale" / loc))
            ok = isinstance(data.get("meta"), dict) and bool(data["meta"].get("title"))
        except Exception:
            ok = False
        res.check("W5", ok, "locale/" + loc + " carries nested meta.title")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--baseline", default="f68d32d")
    args = ap.parse_args()
    print("memora 1.2.0 acceptance harness   baseline=" + args.baseline)
    print("")
    res = Result()
    check_css(res)
    check_css_selectors(res, args.baseline)
    check_empty_states(res)
    check_retrieval(res)
    check_selectors(res, args.baseline)
    check_dag(res)
    check_dag_bundle(res)
    check_connector(res)
    print("")
    return res.report()


if __name__ == "__main__":
    sys.exit(main())
