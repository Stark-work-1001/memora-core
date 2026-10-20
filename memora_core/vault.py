# -*- coding: utf-8 -*-
"""Markdown 文档库（vault）：SQLite 真源的人类可读镜像。

设计三原则：
  1. 镜像只读回真源：Markdown 不是第二个写入者，任何内容都能由 Store 重放生成。
  2. 所有写入原子：先写同目录 .tmp，fsync 后 os.replace 覆盖，断电不留半个文件。
  3. 每个镜像文件都在 document 表留一行（path/hash/bytes/updated_at），
     保证「镜像可追溯到真源」，索引页与文档库页面都从这张表取数。
"""
from __future__ import annotations

import hashlib
import os
import re
import tempfile
import time
import unicodedata
from pathlib import Path
from typing import TYPE_CHECKING, Any, Iterable

from .db import local_clock, local_day, now

if TYPE_CHECKING:  # pragma: no cover - 仅用于类型检查
    from .store import Store

FRONTMATTER_FIELDS: tuple[str, ...] = (
    "id", "title", "kind", "status", "scope", "agent", "trust", "importance",
    "tags", "recorded_at", "updated_at", "sources",
)
AUTOGEN_BANNER = (
    "> 本文件由 memora-core 自动生成并持续追加，**请勿手工修改**；"
    "真源是 SQLite（memora.db），手改内容会在下次镜像时被覆盖。"
)
ILLEGAL_FILENAME = '<>:"/\\|?*'
RESERVED_NAMES = frozenset(
    ["con", "prn", "aux", "nul"] + ["com%d" % i for i in range(1, 10)]
    + ["lpt%d" % i for i in range(1, 10)]
)
MAX_STEM = 64


# ---------------------------------------------------------------- 文件名


def safe_filename(name: Any, max_len: int = MAX_STEM, default: str = "untitled") -> str:
    """文件名安全化：保留中文/字母/数字，非法字符换成 '-'，
    控制字符丢弃，超长截断。"""
    text = unicodedata.normalize("NFKC", str(name or "")).strip()
    out: list[str] = []
    for ch in text:
        if ch in ILLEGAL_FILENAME or ord(ch) < 32 or ch == "\x7f":
            out.append("-")
        else:
            out.append(ch)
    stem = "".join(out)
    stem = re.sub(r"[\s\-_]+", "-", stem).strip("-.")
    stem = stem.strip()
    if len(stem) > max_len:
        stem = stem[:max_len].rstrip("-.")
    if not stem:
        stem = default
    if stem.lower() in RESERVED_NAMES:
        stem = "x-" + stem
    return stem


def unique_path(path: Path) -> Path:
    """冲突加后缀：a.md 已存在则 a-2.md、a-3.md …"""
    if not path.exists():
        return path
    stem, suffix, parent = path.stem, path.suffix, path.parent
    for index in range(2, 1000):
        candidate = parent / ("%s-%d%s" % (stem, index, suffix))
        if not candidate.exists():
            return candidate
    return parent / ("%s-%d%s" % (stem, int(time.time()), suffix))


# ---------------------------------------------------------------- YAML front-matter

_PLAIN_RE = re.compile(r"^[A-Za-z0-9_\-./@][A-Za-z0-9_\-./@ ]*$")


def _yaml_value(value: Any) -> str:
    """极简 YAML 标量输出：数字/布尔原样，字符串按需加双引号。"""
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        if isinstance(value, float) and value != value:  # NaN
            return "0.0"
        return repr(value) if isinstance(value, float) else str(value)
    if isinstance(value, (list, tuple)):
        return "[" + ", ".join(_yaml_value(v) for v in value) + "]"
    text = str(value).replace("\r", " ").replace("\n", " ")
    if _PLAIN_RE.match(text) and text.strip():
        return text
    escaped = text.replace("\\", "\\\\").replace('"', '\\"')
    return '"%s"' % escaped


def dump_frontmatter(data: dict) -> str:
    """生成 --- 包裹的 YAML front-matter。"""
    lines = ["---"]
    for key, value in data.items():
        lines.append("%s: %s" % (key, _yaml_value(value)))
    lines.append("---")
    return "\n".join(lines) + "\n"


def _unquote(raw: str) -> str:
    text = raw.strip()
    if len(text) >= 2 and text[0] == '"' and text[-1] == '"':
        inner = text[1:-1]
        return inner.replace('\\\\', '\\').replace('\\"', '"')
    if len(text) >= 2 and text[0] == "'" and text[-1] == "'":
        return text[1:-1].replace("''", "'")
    return text


def _parse_scalar(raw: str) -> Any:
    text = raw.strip()
    if text == "":
        return ""
    if text.startswith("[") and text.endswith("]"):
        inner = text[1:-1].strip()
        if not inner:
            return []
        items: list[str] = []
        buffer = ""
        quoted = False
        for ch in inner:
            if ch == '"':
                quoted = not quoted
                buffer += ch
            elif ch == "," and not quoted:
                items.append(_unquote(buffer))
                buffer = ""
            else:
                buffer += ch
        if buffer.strip():
            items.append(_unquote(buffer))
        return items
    if text in ("true", "false"):
        return text == "true"
    if text in ("null", "~"):
        return None
    try:
        if re.match(r"^-?\d+$", text):
            return int(text)
        if re.match(r"^-?\d+\.\d+$", text):
            return float(text)
    except ValueError:  # pragma: no cover
        pass
    return _unquote(text)


def parse_frontmatter(text: str) -> tuple[dict, str]:
    """把 Markdown 拆成 (front-matter dict, 正文)。没有 front-matter 时返回 ({}, 全文)。"""
    if not text.startswith("---"):
        return {}, text
    end = text.find("\n---", 3)
    if end < 0:
        return {}, text
    block = text[3:end]
    rest = text[end + 4:]
    if rest.startswith("\n"):
        rest = rest[1:]
    data: dict[str, Any] = {}
    for line in block.splitlines():
        line = line.rstrip()
        if not line or line.lstrip().startswith("#") or ":" not in line:
            continue
        key, _, value = line.partition(":")
        data[key.strip()] = _parse_scalar(value)
    return data, rest


# ---------------------------------------------------------------- Vault


class Vault:
    """Markdown 文档库。

    root 是 vault 目录（data/vault）。构造时不建目录，首次写入时惰性创建；
    attach(store) 之后每次写入都会在 document 表 upsert 一行。
    """

    def __init__(self, root: str | Path) -> None:
        self.root = Path(root)
        self.store: "Store | None" = None
        self._paths: dict[str, str] = {}  # 未绑定 Store 时的内存回退索引（id → 相对路径）

    # ------------------------------------------------------------ 基础设施

    def attach(self, store: "Store") -> None:
        """绑定 Store：镜像写入会同步 document 行。"""
        self.store = store

    def path(self, rel_path: str) -> Path:
        """把 vault 相对路径解析成绝对路径，并保证不逃逸出 root。"""
        rel = str(rel_path or "").replace("\\", "/").lstrip("/")
        target = (self.root / rel).resolve()
        root = self.root.resolve()
        if target != root and root not in target.parents:
            raise ValueError("路径越界: %s" % rel_path)
        return target

    def _ensure_dirs(self) -> None:
        for sub in ("", "daily", "memories", "notes", "reports"):
            (self.root / sub).mkdir(parents=True, exist_ok=True)

    def _write_atomic(self, target: Path, text: str) -> int:
        """先写同目录 .tmp，fsync 后 os.replace；返回字节数。"""
        target.parent.mkdir(parents=True, exist_ok=True)
        data = text.encode("utf-8")
        handle, tmp_name = tempfile.mkstemp(
            prefix="." + target.name + ".", suffix=".tmp", dir=str(target.parent)
        )
        try:
            with os.fdopen(handle, "wb") as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(tmp_name, str(target))
        except BaseException:
            try:
                os.unlink(tmp_name)
            except OSError:
                pass
            raise
        return len(data)

    @staticmethod
    def _hash(text: str) -> str:
        return hashlib.sha256(text.encode("utf-8")).hexdigest()

    def _upsert_document(
        self,
        rel_path: str,
        text: str,
        *,
        doc_id: str | None = None,
        kind: str = "note",
        title: str = "",
        scope_id: str | None = None,
        frontmatter: dict | None = None,
        origin: str = "memora",
    ) -> dict | None:
        """把镜像文件登记进 document 表（hash/bytes/updated_at 与磁盘一致）。"""
        if self.store is None:
            return None
        day = ""
        if rel_path.startswith("daily/"):
            day = Path(rel_path).stem
        stamp = now()
        payload: dict[str, Any] = {
            "kind": kind,
            "path": rel_path,
            "title": title or Path(rel_path).stem,
            "scope_id": scope_id,
            "day": day or None,
            "hash": self._hash(text),
            "bytes": len(text.encode("utf-8")),
            "frontmatter": frontmatter or {},
            "origin": origin,
            "status": "active",
            "text": text,
        }
        if doc_id:
            payload["id"] = doc_id
        return self.store.add_document(payload)

    # ------------------------------------------------------------ 记忆镜像

    def _memory_rel(self, memory: dict) -> str:
        """记忆镜像的相对路径：memories/<id>-<标题>.md。

        id 放在前面：文件名主键稳定，标题变了也不会产生新文件；
        同目录下靠标题区分。
        """
        mid = str(memory.get("id") or "")
        title = str(memory.get("title") or "memory")
        stem = safe_filename("%s-%s" % (mid, title), max_len=90)
        return "memories/%s.md" % stem

    def write_memory(
        self, memory: dict, evidence: Iterable[dict] | None = None,
        blocks: Iterable[dict] | None = None,
    ) -> str:
        """写单条记忆的 Markdown 镜像，返回 vault 相对路径。"""
        self._ensure_dirs()
        mid = str(memory.get("id") or "")
        if not mid:
            raise ValueError("memory.id 不能为空")
        evidence = list(evidence or [])
        blocks = list(blocks or [])
        rel_path = self._memory_rel(memory)
        doc_id = "mem:" + mid
        previous = self._document(doc_id) or {"path": self._paths.get(mid)}
        previous_path = previous.get("path") if previous else None
        if previous_path and previous_path != rel_path:
            if self.path(str(previous_path)).exists():
                # 标题变了也沿用已有文件名，避免产生孤儿镜像
                rel_path = str(previous_path)
        self._paths[mid] = rel_path
        target = self.path(rel_path)
        text = self.render_memory(memory, evidence, blocks)
        self._write_atomic(target, text)
        front = self._frontmatter(memory, evidence)
        self._upsert_document(
            rel_path, text, doc_id=doc_id, kind="memory",
            title=str(memory.get("title") or mid),
            scope_id=memory.get("scope_id"), frontmatter=front,
        )
        return rel_path

    def _document(self, doc_id: str) -> dict | None:
        if self.store is None:
            return None
        return self.store.get_document(doc_id)

    def _frontmatter(self, memory: dict, evidence: Iterable[dict]) -> dict:
        metadata = memory.get("metadata") or {}
        tags = list(metadata.get("tags") or [])
        sources: list[str] = []
        for item in evidence:
            ref = item.get("uri") or item.get("document_id") or ""
            kind = str(item.get("kind") or "")
            label = ("%s:%s" % (kind, ref)) if ref else str(item.get("quote") or kind)
            label = " ".join(str(label).split())
            if label and label not in sources:
                sources.append(label[:120])
        for doc in memory.get("documents") or []:
            ref = str(doc.get("path") or "")
            if ref and ref not in sources:
                sources.append(ref)
        return {
            "id": str(memory.get("id") or ""),
            "title": str(memory.get("title") or ""),
            "kind": str(memory.get("kind") or ""),
            "status": str(memory.get("status") or ""),
            "scope": str(memory.get("scope_id") or ""),
            "agent": str(memory.get("agent_id") or ""),
            "trust": round(float(memory.get("trust") or 0.0), 3),
            "importance": round(float(memory.get("importance") or 0.0), 3),
            "tags": tags,
            "recorded_at": str(memory.get("recorded_at") or ""),
            "updated_at": str(memory.get("updated_at") or ""),
            "sources": sources,
        }

    # ------------------------------------------------------------ 渲染

    def render_memory(
        self, memory: dict, evidence: Iterable[dict] | None = None,
        blocks: Iterable[dict] | None = None,
    ) -> str:
        """渲染单条记忆的 Markdown（front-matter + 正文 + 证据 + 块 + 反向链接）。"""
        evidence = list(evidence or [])
        blocks = list(blocks or [])
        front = self._frontmatter(memory, evidence)
        parts: list[str] = [dump_frontmatter(front), "\n"]
        parts.append("# %s\n\n" % (memory.get("title") or memory.get("id") or "未命名记忆"))
        parts.append(self._meta_line(memory))
        parts.append("\n")
        body = str(memory.get("body") or "").strip()
        summary = str(memory.get("summary") or "").strip()
        if summary and summary not in body:
            parts.append("> %s\n\n" % summary.replace("\n", " "))
        if body:
            parts.append("%s\n" % body)
        didactic = memory.get("didactic") or {}
        if isinstance(didactic, dict) and didactic:
            parts.append(self._render_didactic(didactic))
        if evidence:
            parts.append("\n## 证据\n\n")
            for index, item in enumerate(evidence, 1):
                parts.append(self._render_evidence(index, item))
        if blocks:
            parts.append("\n## 富形式\n")
            for item in blocks:
                parts.append(self._render_block(item))
        related = self._related(memory)
        if related:
            parts.append("\n## 相关记忆\n\n")
            for other in related:
                parts.append("- [[%s]] · %s\n" % (other["id"], other["rel"]))
        parts.append("\n---\n\n")
        parts.append(
            "> 由 memora-core 自动镜像（真源 %s），请勿手工编辑。\n"
            % str(memory.get("id") or "")
        )
        return "".join(parts)

    @staticmethod
    def _meta_line(memory: dict) -> str:
        bits = [
            "`%s`" % (memory.get("id") or ""),
            "状态 **%s**" % (memory.get("status") or ""),
            "类型 *%s*" % (memory.get("kind") or ""),
            "作用域 `%s`" % (memory.get("scope_id") or ""),
            "信任 %.2f" % float(memory.get("trust") or 0.0),
            "重要度 %.2f" % float(memory.get("importance") or 0.0),
        ]
        tags = list((memory.get("metadata") or {}).get("tags") or [])
        if tags:
            bits.append("标签 " + " ".join("#%s" % t for t in tags))
        return " · ".join(bits) + "\n"

    def _render_didactic(self, didactic: dict) -> str:
        """把 didactic JSON（定义/定理/特征/公式/推导/例题）摊平成人读小节。"""
        out: list[str] = ["\n## 教学要点\n"]
        labels = (
            ("definition", "定义"), ("theorem", "定理"), ("properties", "性质"),
            ("formula", "公式"), ("derivation", "推导"), ("examples", "例题"),
        )
        for key, label in labels:
            value = didactic.get(key)
            if not value:
                continue
            if isinstance(value, (list, tuple)):
                out.append("\n**%s**\n\n" % label)
                for item in value:
                    out.append("- %s\n" % " ".join(str(item).split()))
            elif key == "formula":
                out.append("\n**%s**\n\n$$\n%s\n$$\n" % (label, str(value).strip()))
            else:
                out.append("\n**%s**：%s\n" % (label, " ".join(str(value).split())))
        return "".join(out)

    @staticmethod
    def _render_evidence(index: int, item: dict) -> str:
        kind = item.get("kind") or "unknown"
        trust = float(item.get("trust") or 0.0)
        head = "%d. **%s** · 信任 %.2f" % (index, kind, trust)
        if item.get("verified"):
            head += " · 已核验"
        if item.get("verifier"):
            head += "（%s）" % item["verifier"]
        lines = [head + "\n"]
        quote = " ".join(str(item.get("quote") or "").split())
        if quote:
            lines.append("   > %s\n" % quote)
        refs = []
        if item.get("uri"):
            refs.append(str(item["uri"]))
        if item.get("document_id"):
            refs.append("document:%s" % item["document_id"])
        if item.get("chunk_id"):
            refs.append("chunk:%s" % item["chunk_id"])
        if item.get("session_id"):
            refs.append("session:%s" % item["session_id"])
        if refs:
            lines.append("   来源：%s\n" % " · ".join(refs))
        if item.get("note"):
            lines.append("   备注：%s\n" % " ".join(str(item["note"]).split()))
        return "".join(lines)

    def _render_block(self, block: dict) -> str:
        """按块类型渲染：公式 $$、代码围栏、表格管道表、图片、数据库引用。"""
        btype = str(block.get("type") or "")
        caption = str(block.get("caption") or "").strip()
        content = str(block.get("content") or "")
        fields = block.get("fields") or {}
        out: list[str] = ["\n"]
        if caption:
            out.append("**%s**\n\n" % caption)
        if btype == "formula":
            out.append("$$\n%s\n$$\n" % content.strip())
        elif btype in ("code", "database"):
            lang = str(block.get("lang") or ("sql" if btype == "database" else "")).strip()
            out.append("```%s\n%s\n```\n" % (lang, content.rstrip()))
        elif btype == "table":
            out.append(self._render_table(content, fields))
        elif btype == "image":
            url = fields.get("url") or fields.get("path") or content.strip()
            out.append("![%s](%s)\n" % (caption or "image", url))
        elif btype == "list":
            for line in content.splitlines():
                text = line.strip()
                if text:
                    out.append("- %s\n" % text.lstrip("-* "))
        elif btype == "quote":
            for line in content.splitlines():
                out.append("> %s\n" % line)
        else:
            out.append("%s\n" % content.rstrip())
        return "".join(out)

    @staticmethod
    def _render_table(content: str, fields: dict) -> str:
        """表格块：优先用 fields.columns/fields.rows，退化为把 content 当 CSV/管道文本。"""
        columns = list(fields.get("columns") or [])
        rows = list(fields.get("rows") or [])
        if not columns or not rows:
            lines = [line for line in content.splitlines() if line.strip()]
            if not lines:
                return ""
            if lines[0].lstrip().startswith("|"):
                return "\n".join(lines) + "\n"
            cells = [c.strip() for c in lines[0].split("|") if c.strip()]
            if not cells:
                return ""
            columns = cells
            rows = [[c.strip() for c in line.split("|")] for line in lines[1:]]
        header = "| " + " | ".join(str(c) for c in columns) + " |"
        divider = "| " + " | ".join("---" for _ in columns) + " |"
        body = [
            "| " + " | ".join(
                str(cell) for cell in (list(row) + [""] * len(columns))[: len(columns)]
            ) + " |"
            for row in rows
        ]
        return "\n".join([header, divider] + body) + "\n"

    @staticmethod
    def _related(memory: dict) -> list[dict]:
        """反向链接：与当前记忆相连的其它记忆（去重，最多 20 条）。"""
        mid = str(memory.get("id") or "")
        out: list[dict] = []
        seen = {mid}
        for edge in memory.get("edges") or []:
            src, dst = str(edge.get("src") or ""), str(edge.get("dst") or "")
            other = dst if src == mid else src
            if not other or other in seen or other.startswith(("en-", "doc-", "ch-")):
                continue
            seen.add(other)
            out.append({"id": other, "rel": str(edge.get("rel") or "related")})
            if len(out) >= 20:
                break
        return out

    # ------------------------------------------------------------ 日更 / 文档 / 报告

    def append_daily(self, entry: dict) -> str:
        """按**本地**日历日追加到 daily/YYYY-MM-DD.md；同日多次追加带分隔与本地时间。

        1.0.0 按 UTC 日期切页：东八区早上 8 点前的工作会写进前一天的日记。
        """
        self._ensure_dirs()
        payload = dict(entry or {})
        stamp = str(payload.get("at") or now())
        day = str(payload.get("day") or local_day(stamp))[:10] or local_day(now())
        rel_path = "daily/%s.md" % day
        target = self.path(rel_path)
        existing = ""
        if target.exists():
            existing = target.read_text(encoding="utf-8")
        head = self._daily_header(day) if not existing else ""
        block = self._daily_entry(payload, stamp)
        text = existing + block if existing else head + block
        self._write_atomic(target, text)
        self._upsert_document(
            rel_path, text, doc_id="daily:%s" % day, kind="daily",
            title="%s 每日记忆" % day, frontmatter={"day": day, "generated_by": "memora-core"},
        )
        return rel_path

    @staticmethod
    def _daily_header(day: str) -> str:
        return "\n".join([
            "---",
            "day: %s" % day,
            "kind: daily",
            "generated_by: memora-core",
            "---",
            "# %s · 每日记忆" % day,
            "",
            AUTOGEN_BANNER,
            "",
            "<!-- memora:daily:begin -->",
            "",
        ]) + "\n"

    @staticmethod
    def _daily_entry(entry: dict, stamp: str) -> str:
        clock = local_clock(stamp) or (stamp[11:19] if len(stamp) >= 19 else stamp)
        title = str(entry.get("title") or entry.get("summary") or "记录").strip()
        bits: list[str] = []
        if entry.get("kind"):
            bits.append("类型 *%s*" % entry["kind"])
        if entry.get("memory_id") or entry.get("id"):
            bits.append("记忆 `%s`" % (entry.get("memory_id") or entry.get("id")))
        if entry.get("scope") or entry.get("scope_id"):
            bits.append("作用域 `%s`" % (entry.get("scope") or entry.get("scope_id")))
        if entry.get("agent") or entry.get("agent_id"):
            bits.append("智能体 `%s`" % (entry.get("agent") or entry.get("agent_id")))
        body = str(entry.get("body") or entry.get("text") or "").strip()
        lines = [
            "<!-- memora:entry -->",
            "",
            "## %s · %s" % (clock, title),
            "",
        ]
        if bits:
            lines.extend([" · ".join(bits), ""])
        if body:
            lines.extend([body, ""])
        tags = list(entry.get("tags") or [])
        if tags:
            lines.extend([" ".join("#%s" % t for t in tags), ""])
        lines.append("---")
        lines.append("")
        return "\n".join(lines)

    def write_document(self, rel_path: str, text: str) -> str:
        """写 vault 内任意文档（保留相对路径，逐段安全化），
        返回实际相对路径。"""
        self._ensure_dirs()
        rel = self._safe_rel(rel_path)
        target = self.path(rel)
        self._write_atomic(target, text)
        self._upsert_document(
            rel, text, doc_id="file:%s" % rel, kind="note",
            title=Path(rel).stem, frontmatter={}, origin="import",
        )
        return rel

    @staticmethod
    def _safe_rel(rel_path: str) -> str:
        """逐段安全化相对路径；拒绝空路径与越界片段。"""
        raw = str(rel_path or "").replace("\\", "/").strip().lstrip("/")
        segments = [s for s in raw.split("/") if s not in ("", ".", "..")]
        if not segments:
            raise ValueError("rel_path 不能为空")
        last = segments[-1]
        suffix = ""
        if "." in last.lstrip("."):
            stem, dot, ext = last.rpartition(".")
            if ext and len(ext) <= 8 and ext.isalnum():
                suffix = "." + ext.lower()
                last = stem
        safe_last = safe_filename(last) + suffix
        head = [safe_filename(s, max_len=48) for s in segments[:-1]]
        return "/".join(head + [safe_last])

    def write_report(self, name: str, markdown: str) -> str:
        """写 reports/<name>.md；同名覆盖（报告是可重放的派生产物）。"""
        self._ensure_dirs()
        stem = safe_filename(name, max_len=80, default="report")
        if not stem.lower().endswith(".md"):
            stem += ".md"
        rel = "reports/%s" % stem
        target = self.path(rel)
        self._write_atomic(target, markdown)
        self._upsert_document(
            rel, markdown, doc_id="report:%s" % stem, kind="report",
            title=Path(stem).stem, frontmatter={},
        )
        return rel

    def remove_memory(self, mid: str) -> bool:
        """删除某条记忆的镜像文件与 document 行（硬删除时调用）。"""
        doc_id = "mem:" + str(mid)
        doc = self._document(doc_id)
        removed = False
        if doc and doc.get("path"):
            target = self.path(str(doc["path"]))
            if target.exists():
                target.unlink()
                removed = True
        if self.store is not None and doc is not None:
            with self.store._txn() as con:
                con.execute("DELETE FROM document WHERE id = ?", (doc_id,))
                self.store.audit("vault.remove", doc_id, detail={"path": doc.get("path")})
        return removed

    # ------------------------------------------------------------ 索引与读取

    def rebuild_index(self, store: "Store | None" = None) -> str:
        """生成 vault/README.md：按 kind / scope / 月份统计 + 最近 50 条链接。"""
        self._ensure_dirs()
        st = store or self.store
        if st is None:
            raise ValueError("rebuild_index 需要 Store")
        stats = st.stats()
        items = st.list_memories({"limit": 500, "sort": "updated_at", "order": "desc"})
        all_items = list(items.get("items") or [])
        by_kind: dict[str, int] = {}
        by_scope: dict[str, int] = {}
        by_month: dict[str, int] = {}
        for item in all_items:
            by_kind[str(item.get("kind"))] = by_kind.get(str(item.get("kind")), 0) + 1
            by_scope[str(item.get("scope_id"))] = by_scope.get(str(item.get("scope_id")), 0) + 1
            month = str(item.get("recorded_at") or "")[:7] or "unknown"
            by_month[month] = by_month.get(month, 0) + 1
        total = int((stats.get("memories") or {}).get("total") or len(all_items))
        lines = [
            "# memora-core 记忆库索引",
            "",
            AUTOGEN_BANNER,
            "",
            "- 生成时间：%s" % now(),
            "- 记忆总数：%d（本页统计覆盖最近 %d 条）" % (total, len(all_items)),
            "- 证据 %d 条 · 块 %d 个 · 实体 %d 个 · 关系 %d 条 · 文档 %d 篇" % (
                stats.get("evidence", 0), stats.get("blocks", 0), stats.get("entities", 0),
                stats.get("edges", 0), stats.get("documents", 0),
            ),
            "",
            "## 按类型",
            "",
        ]
        lines.extend(_count_rows(by_kind, "kind"))
        lines.extend(["", "## 按作用域", ""])
        lines.extend(_count_rows(by_scope, "scope"))
        lines.extend(["", "## 按月份（recorded_at）", ""])
        lines.extend(_count_rows(by_month, "month"))
        lines.extend(["", "## 最近 50 条记忆", ""])
        for item in all_items[:50]:
            path = self.relative_memory_path(str(item.get("id") or "")) or ""
            link = "[%s](%s)" % (str(item.get("title") or item.get("id")), path) if path else str(
                item.get("title") or item.get("id")
            )
            lines.append(
                "- %s · %s · %s · 信任 %.2f · %s" % (
                    link, item.get("kind") or "", item.get("status") or "",
                    float(item.get("trust") or 0.0), str(item.get("updated_at") or "")[:10],
                )
            )
        lines.append("")
        text = "\n".join(lines)
        rel = "README.md"
        self._write_atomic(self.path(rel), text)
        self._upsert_document(
            rel, text, doc_id="index:README", kind="index", title="记忆库索引",
            frontmatter={"generated_by": "memora-core"},
        )
        return rel

    def relative_memory_path(self, mid: str) -> str | None:
        """查某条记忆的镜像相对路径（document 表是真源）。"""
        doc = self._document("mem:" + str(mid))
        return str(doc["path"]) if doc and doc.get("path") else None

    def read(self, rel_path: str) -> str:
        """读 vault 内文件；不存在抛 FileNotFoundError。"""
        target = self.path(rel_path)
        if not target.exists():
            raise FileNotFoundError(str(rel_path))
        return target.read_text(encoding="utf-8")

    def list_files(self, kind: str = "") -> list[dict]:
        """列出 vault 内文件。kind: memory|daily|note|report|index（按路径前缀过滤）。"""
        self._ensure_dirs()
        prefixes = {
            "memory": "memories/", "daily": "daily/", "note": "notes/",
            "report": "reports/", "index": "README.md",
        }
        want = prefixes.get(str(kind or "").strip())
        out: list[dict] = []
        for path in sorted(self.root.rglob("*")):
            if not path.is_file() or path.name.startswith(".") or path.suffix == ".tmp":
                continue
            rel = path.relative_to(self.root).as_posix()
            if want and not (rel == want or rel.startswith(want)):
                continue
            stat = path.stat()
            out.append({
                "path": rel,
                "name": path.name,
                "kind": kind or _kind_of(rel),
                "bytes": stat.st_size,
                "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(stat.st_mtime)),
            })
        return out


def _count_rows(counter: dict[str, int], label: str) -> list[str]:
    if not counter:
        return ["- （空）"]
    return ["- %s：%d" % (key, counter[key]) for key in sorted(counter, key=lambda k: (-counter[k], k))]


def _kind_of(rel: str) -> str:
    if rel.startswith("memories/"):
        return "memory"
    if rel.startswith("daily/"):
        return "daily"
    if rel.startswith("notes/"):
        return "note"
    if rel.startswith("reports/"):
        return "report"
    if rel == "README.md":
        return "index"
    return "other"
