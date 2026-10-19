# -*- coding: utf-8 -*-
"""文档吸收：把外部文件变成 document + chunk + Vault 镜像。

支持 md / txt / html / json / jsonl；PDF 需要 pypdf，未安装时**明确报错**，
绝不伪造正文。

写入顺序（任何一步失败都不留下半条记录）：
  1) 解析 → 纯文本 + 标题
  2) 镜像到 vault/notes/<相对路径>
  3) upsert document 行
  4) 切块（优先 chunking.chunk_markdown / chunk_text）→ replace_chunks
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import zipfile
from html.parser import HTMLParser
from pathlib import Path
from typing import Any

from . import db as _db

SUPPORTED_EXTS = (".md", ".markdown", ".txt", ".text", ".html", ".htm", ".json", ".jsonl",
                  ".pdf")
SKIP_DIRS = {".git", "__pycache__", "node_modules", ".venv", "venv", "dist", "build"}
MAX_BYTES = 8 * 1024 * 1024

PDF_MESSAGE = "需要 pypdf，未安装"


# ============================================================
# 小工具
# ============================================================

def _con(store):
    con = getattr(store, "con", None)
    if con is not None:
        return con
    import sqlite3
    path = getattr(store, "db_path", None) or getattr(store, "db", None)
    conn = sqlite3.connect(str(path), timeout=15.0, isolation_level=None)
    conn.row_factory = sqlite3.Row
    return conn


def _audit(store, action: str, target: str | None, detail: Any = None) -> None:
    fn = getattr(store, "audit", None)
    if not callable(fn):
        return
    try:
        fn(action, target, detail=detail)
    except Exception:  # noqa: BLE001
        pass


def _sha(text: Any) -> str:
    return hashlib.sha256(str(text).encode("utf-8")).hexdigest()


def _slug(text: str, limit: int = 60) -> str:
    """安全文件名：保留中英文数字，其它压成连字符。"""
    raw = re.sub(r"[^\w\u3400-\u9fff.-]+", "-", str(text or "").strip(), flags=re.UNICODE)
    raw = re.sub(r"-+", "-", raw).strip("-.")
    return (raw[:limit] or "untitled")


def _data_root(store) -> Path:
    """推断数据目录（用于 vault/ 与 inbox/）。"""
    vault = getattr(store, "vault", None)
    for attr in ("root", "path"):
        value = getattr(vault, attr, None)
        if value:
            return Path(value).resolve().parent
    db_path = getattr(store, "db_path", None)
    if db_path:
        return Path(db_path).resolve().parent
    from .paths import default_data_dir
    return default_data_dir()


def _vault_dir(store) -> Path:
    vault = getattr(store, "vault", None)
    for attr in ("root", "path"):
        value = getattr(vault, attr, None)
        if value:
            return Path(value).resolve()
    return _data_root(store) / "vault"


# ============================================================
# HTML → Markdown
# ============================================================

class _HTMLToText(HTMLParser):
    """用标准库 html.parser 去标签；标题转 #，段落之间空行分隔。"""

    BLOCK_TAGS = {"p", "div", "section", "article", "header", "footer", "blockquote",
                  "table", "tr", "ul", "ol", "pre", "form", "aside", "nav"}
    SKIP_TAGS = {"script", "style", "noscript", "template", "svg"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self._skip_depth = 0
        self._in_pre = 0
        self._in_code = 0
        self._heading = 0
        self._list_depth = 0
        self.title = ""

    def handle_starttag(self, tag, attrs):
        tag = tag.lower()
        if tag in self.SKIP_TAGS:
            self._skip_depth += 1
            return
        if tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
            self._heading = int(tag[1])
            self._break()
            self.parts.append("#" * self._heading + " ")
        elif tag == "pre":
            self._in_pre += 1
            self._break()
            self.parts.append("\n```\n")
        elif tag == "code":
            self._in_code += 1
            if not self._in_pre:
                self.parts.append("`")
        elif tag in ("ul", "ol"):
            self._list_depth += 1
            self._break()
        elif tag == "li":
            self._break()
            self.parts.append("  " * max(0, self._list_depth - 1) + "- ")
        elif tag == "br":
            self.parts.append("\n")
        elif tag in self.BLOCK_TAGS:
            self._break()

    def handle_endtag(self, tag):
        tag = tag.lower()
        if tag in self.SKIP_TAGS:
            self._skip_depth = max(0, self._skip_depth - 1)
            return
        if tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
            self._heading = 0
            self._break()
        elif tag == "pre":
            self._in_pre = max(0, self._in_pre - 1)
            self.parts.append("\n```\n")
        elif tag == "code":
            self._in_code = max(0, self._in_code - 1)
            if not self._in_pre:
                self.parts.append("`")
        elif tag in ("ul", "ol"):
            self._list_depth = max(0, self._list_depth - 1)
            self._break()
        elif tag in self.BLOCK_TAGS:
            self._break()

    def handle_data(self, data):
        if self._skip_depth:
            return
        if not self._in_pre:
            text = re.sub(r"[ \t\r\f\v]+", " ", data)
            if not text.strip() and not text.strip("\n"):
                if text and self.parts and not self.parts[-1].endswith((" ", "\n")):
                    self.parts.append(" ")
                return
        else:
            text = data
        self.parts.append(text)

    def _break(self) -> None:
        if not self.parts:
            return
        if not self.parts[-1].endswith("\n"):
            self.parts.append("\n")
        if len(self.parts) >= 2 and not self.parts[-2].endswith("\n"):
            self.parts.append("\n")

    def text(self) -> str:
        raw = "".join(self.parts)
        raw = re.sub(r"[ \t]+\n", "\n", raw)
        raw = re.sub(r"\n{3,}", "\n\n", raw)
        return raw.strip()


def html_to_markdown(html: str) -> str:
    """HTML → Markdown 近似文本（保留标题、段落、代码块）。"""
    parser = _HTMLToText()
    try:
        parser.feed(html or "")
        parser.close()
    except Exception:  # noqa: BLE001 - 解析器异常时退化为正则去标签
        stripped = re.sub(r"<[^>]+>", " ", html or "")
        return re.sub(r"[ \t]{2,}", " ", stripped).strip()
    return parser.text()


# ============================================================
# 解析
# ============================================================

def _read_bytes(path: Path) -> bytes:
    size = path.stat().st_size
    if size > MAX_BYTES:
        raise ValueError("文件过大（%d 字节 > %d）；请先拆分" % (size, MAX_BYTES))
    return path.read_bytes()


def _decode(raw: bytes) -> str:
    for encoding in ("utf-8-sig", "utf-8", "gb18030", "latin-1"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", "replace")


def extract_pdf(path: Path) -> str:
    """PDF 正文抽取；没有 pypdf 时明确报错，绝不伪造正文。"""
    try:
        from pypdf import PdfReader  # type: ignore  # noqa: PLC0415
    except Exception:  # noqa: BLE001
        raise RuntimeError(PDF_MESSAGE) from None
    reader = PdfReader(str(path))
    chunks: list[str] = []
    for page in reader.pages:
        chunks.append(page.extract_text() or "")
    text = "\n\n".join(chunks).strip()
    if not text:
        raise RuntimeError("PDF 未提取到任何文本（可能是扫描件，需要 OCR）")
    return text


def parse_document(path: Path) -> dict:
    """解析单个文件，返回 {title, text, ext, kind}。"""
    ext = path.suffix.lower()
    if ext == ".pdf":
        text = extract_pdf(path)
        return {"title": path.stem, "text": text, "ext": ext, "kind": "source"}
    raw = _read_bytes(path)
    text = _decode(raw)
    if ext in (".html", ".htm"):
        return {"title": _html_title(text) or path.stem, "text": html_to_markdown(text),
                "ext": ext, "kind": "source"}
    if ext == ".json":
        parsed = _try_json(text)
        if isinstance(parsed, list):
            body = "\n\n".join(_json_block(item) for item in parsed)
            return {"title": path.stem, "text": body, "ext": ext, "kind": "source"}
        if isinstance(parsed, dict):
            title = str(parsed.get("title") or parsed.get("name") or path.stem)
            body = str(parsed.get("body") or parsed.get("content") or parsed.get("text") or "")
            rest = {k: v for k, v in parsed.items()
                    if k not in ("title", "name", "body", "content", "text")}
            if rest:
                body = (body + "\n\n" if body else "") + "\n".join(
                    "- %s: %s" % (k, _scalar(v)) for k, v in rest.items())
            return {"title": title, "text": body.strip(), "ext": ext, "kind": "source"}
        return {"title": path.stem, "text": text, "ext": ext, "kind": "source"}
    if ext == ".jsonl":
        lines = [_try_json(line) for line in text.splitlines() if line.strip()]
        body = "\n\n".join(_json_block(item) for item in lines if item is not None)
        return {"title": path.stem, "text": body, "ext": ext, "kind": "source"}
    return {"title": _md_title(text) or path.stem, "text": text, "ext": ext or ".txt",
            "kind": "note"}


def _try_json(text: str) -> Any:
    try:
        return json.loads(text)
    except (TypeError, ValueError):
        return None


def _scalar(value: Any) -> str:
    if isinstance(value, (str, int, float, bool)) or value is None:
        return str(value)
    return json.dumps(value, ensure_ascii=False)


def _json_block(item: Any) -> str:
    if isinstance(item, dict):
        title = item.get("title") or item.get("name") or ""
        body = item.get("body") or item.get("content") or item.get("text") or ""
        if title and body:
            return "## %s\n\n%s" % (title, body)
        return "\n".join("- %s: %s" % (k, _scalar(v)) for k, v in item.items())
    return str(item)


def _html_title(html: str) -> str:
    match = re.search(r"<title[^>]*>(.*?)</title>", html or "", re.I | re.S)
    return (match.group(1).strip() if match else "")


def _md_title(text: str) -> str:
    """取第一个 Markdown 标题或 front-matter 的 title。"""
    raw = text or ""
    if raw.startswith("---"):
        end = raw.find("\n---", 3)
        if end != -1:
            front = raw[3:end]
            match = re.search(r"^title\s*:\s*(.+)$", front, re.M)
            if match:
                return match.group(1).strip().strip("\"'")
    match = re.search(r"^#\s+(.+)$", raw, re.M)
    return match.group(1).strip() if match else ""


def chunk_text(text: str, max_tokens: int = 900, overlap: int = 120) -> list[dict]:
    """切块；优先 chunking.chunk_markdown，缺失/失败时按段落兜底。"""
    try:
        from . import chunking  # noqa: PLC0415
        fn = getattr(chunking, "chunk_markdown", None)
        if callable(fn):
            try:
                chunks = fn(text, max_tokens=max_tokens, overlap=overlap)
                if chunks:
                    return [dict(c) for c in chunks]
            except Exception:  # noqa: BLE001 - 切块器异常时用兜底
                pass
        fn2 = getattr(chunking, "chunk_text", None)
        if callable(fn2):
            try:
                chunks = fn2(text, max_tokens=max_tokens, overlap=overlap)
                if chunks:
                    return [dict(c) for c in chunks]
            except Exception:  # noqa: BLE001
                pass
    except Exception:  # noqa: BLE001 - 模块未就绪
        pass
    return _fallback_chunks(text, max_tokens=max_tokens)


def _fallback_chunks(text: str, max_tokens: int = 900) -> list[dict]:
    """无 chunking 模块时的段落切块（每块不超过 max_tokens 个近似 token）。"""
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text or "") if p.strip()]
    out: list[dict] = []
    buffer: list[str] = []
    used = 0
    heading = ""
    for para in paragraphs:
        if para.startswith("#"):
            heading = para.lstrip("#").strip()
        cost = max(1, len(para) // 3)
        if used + cost > max_tokens and buffer:
            body = "\n\n".join(buffer)
            out.append({"ordinal": len(out), "heading": heading, "level": 0, "text": body,
                        "tokens": max(1, len(body) // 3), "start_line": None,
                        "end_line": None, "hash": _sha(body)})
            buffer, used = [], 0
        buffer.append(para)
        used += cost
    if buffer:
        body = "\n\n".join(buffer)
        out.append({"ordinal": len(out), "heading": heading, "level": 0, "text": body,
                    "tokens": max(1, len(body) // 3), "start_line": None, "end_line": None,
                    "hash": _sha(body)})
    return out


# ============================================================
# 写库
# ============================================================

def _mirror(store, rel_path: str, text: str) -> str | None:
    """把原文镜像到 vault/notes/；返回 vault 相对路径。"""
    root = _vault_dir(store)
    target = (root / "notes" / rel_path)
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding="utf-8", newline="\n")
        return str(Path("notes") / rel_path).replace("\\", "/")
    except OSError:
        return None


def _upsert(store, *, rel_path: str, title: str, text: str, scope: str, agent_id: str,
            kind: str, origin: str, frontmatter: dict | None = None) -> dict:
    adder = getattr(store, "add_document", None)
    if not callable(adder):
        raise TypeError("store 缺少 add_document")
    payload = {
        "kind": kind or "note",
        "path": rel_path,
        "title": title,
        "scope_id": scope,
        "day": _db.today(),
        "hash": _sha(text),
        "bytes": len(text.encode("utf-8")),
        "frontmatter": dict(frontmatter or {}, origin=origin, agent_id=agent_id or ""),
        "origin": "import",
        "status": "active",
    }
    return adder(payload)


def ingest_text(store, text, *, title, scope="global", kind="note", origin="user") -> dict:
    """把一段文本写进文档库（document + chunk + vault 镜像）。"""
    body = str(text or "")
    if not body.strip():
        raise ValueError("正文为空，拒绝写入")
    name = _slug(title or "untitled")
    digest = _sha(body)[:10]
    rel = "%s-%s.md" % (name, digest)
    mirrored = _mirror(store, rel, body)
    document = _upsert(store, rel_path=mirrored or ("notes/" + rel), title=title or name,
                       text=body, scope=scope, agent_id="", kind=kind, origin=origin)
    chunks = chunk_text(body)
    writer = getattr(store, "replace_chunks", None)
    count = writer(document["id"], chunks) if callable(writer) else 0
    _audit(store, "ingest.text", document["id"],
           {"title": title, "chunks": count, "scope": scope, "origin": origin})
    return {"document_id": document["id"], "path": document.get("path"),
            "title": document.get("title"), "chunks": count, "bytes": len(body.encode()),
            "vault_path": mirrored, "scope": scope, "kind": kind, "origin": origin}


def ingest_file(store, path, *, scope="global", agent_id=None, kind="note") -> dict:
    """吸收单个文件；返回 {document_id, chunks, title, path, ...}。"""
    file_path = Path(path).expanduser()
    if not file_path.exists():
        raise FileNotFoundError("文件不存在: %s" % file_path)
    if not file_path.is_file():
        raise IsADirectoryError("不是文件: %s" % file_path)
    parsed = parse_document(file_path)
    text = parsed["text"]
    if not str(text).strip():
        raise ValueError("解析结果为空: %s" % file_path.name)
    title = parsed["title"] or file_path.stem
    rel = "%s-%s%s" % (_slug(file_path.stem), _sha(str(text))[:10],
                       ".md" if parsed["ext"] not in (".md", ".markdown") else ".md")
    mirrored = _mirror(store, rel, text)
    document = _upsert(store, rel_path=mirrored or ("notes/" + rel), title=title, text=text,
                       scope=scope, agent_id=str(agent_id or ""),
                       kind=kind or parsed.get("kind") or "note", origin=str(file_path),
                       frontmatter={"source": str(file_path), "ext": parsed["ext"]})
    chunks = chunk_text(text)
    writer = getattr(store, "replace_chunks", None)
    count = writer(document["id"], chunks) if callable(writer) else 0
    _audit(store, "ingest.file", document["id"],
           {"source": str(file_path), "chunks": count, "scope": scope, "agent": agent_id})
    return {"document_id": document["id"], "path": document.get("path"), "title": title,
            "chunks": count, "bytes": len(str(text).encode()), "vault_path": mirrored,
            "scope": scope, "ext": parsed["ext"], "source": str(file_path)}


def ingest_directory(store, path, *, scope="global", pattern="**/*.md") -> dict:
    """批量吸收目录；单个文件失败只记错误，不中断整批。"""
    root = Path(path).expanduser()
    if not root.exists():
        raise FileNotFoundError("目录不存在: %s" % root)
    if not root.is_dir():
        raise NotADirectoryError("不是目录: %s" % root)
    files: list[Path] = []
    for candidate in root.glob(pattern):
        if not candidate.is_file():
            continue
        if any(part in SKIP_DIRS or part.startswith(".") for part in candidate.parts):
            continue
        if candidate.suffix.lower() not in SUPPORTED_EXTS:
            continue
        files.append(candidate)
    results: list[dict] = []
    errors: list[dict] = []
    total_chunks = 0
    for file_path in sorted(files):
        try:
            item = ingest_file(store, file_path, scope=scope, kind="note")
            total_chunks += int(item.get("chunks") or 0)
            results.append(item)
        except Exception as exc:  # noqa: BLE001 - 单个文件失败不中断
            errors.append({"path": str(file_path), "error": "%s: %s" % (
                type(exc).__name__, exc)})
    return {"root": str(root), "pattern": pattern, "files": len(files),
            "ingested": len(results), "chunks": total_chunks, "errors": errors,
            "items": results}


# ============================================================
# inbox 监听
# ============================================================

def watch_inbox(store, scope="global", inbox: str | os.PathLike | None = None) -> dict:
    """扫描 data/inbox/，吸收后移动到 processed/（失败移 failed/）。"""
    root = Path(inbox).expanduser() if inbox else (_data_root(store) / "inbox")
    processed = root / "processed"
    failed = root / "failed"
    root.mkdir(parents=True, exist_ok=True)
    processed.mkdir(parents=True, exist_ok=True)
    failed.mkdir(parents=True, exist_ok=True)
    absorbed: list[dict] = []
    errors: list[dict] = []
    for entry in sorted(root.iterdir()):
        if entry.name in ("processed", "failed") or entry.name.startswith("."):
            continue
        if not entry.is_file():
            continue
        if entry.suffix.lower() not in SUPPORTED_EXTS:
            errors.append({"path": str(entry), "error": "不支持的类型: %s" % entry.suffix})
            _move(entry, failed)
            continue
        try:
            item = ingest_file(store, entry, scope=scope, kind="note")
            absorbed.append(item)
            _move(entry, processed)
        except Exception as exc:  # noqa: BLE001
            errors.append({"path": str(entry), "error": "%s: %s" % (
                type(exc).__name__, exc)})
            _move(entry, failed)
    _audit(store, "ingest.inbox", str(root),
           {"absorbed": len(absorbed), "errors": len(errors)})
    return {"inbox": str(root), "absorbed": len(absorbed), "errors": errors,
            "items": absorbed, "processed_dir": str(processed), "failed_dir": str(failed)}


def _move(source: Path, target_dir: Path) -> Path | None:
    """移动到目标目录；同名时加序号，绝不覆盖已有文件。"""
    try:
        target_dir.mkdir(parents=True, exist_ok=True)
        dest = target_dir / source.name
        index = 1
        while dest.exists():
            dest = target_dir / ("%s-%d%s" % (source.stem, index, source.suffix))
            index += 1
        shutil.move(str(source), str(dest))
        return dest
    except OSError:
        return None


# ============================================================
# 便捷入口
# ============================================================

def supported(path: str | os.PathLike) -> bool:
    return Path(path).suffix.lower() in SUPPORTED_EXTS


def search_chunks(store, query: str, *, limit: int = 20,
                  document_id: str | None = None) -> list[dict]:
    """切块检索：先走 chunk_fts，再用 LIKE 兜底中文子串。

    schema 冻结的 unicode61 分词会把连续汉字当成**单个 token**，
    所以 MATCH '降级' 命中不了 '## 三、离线降级'；这里用 LIKE 补一条通道。
    """
    text = (query or "").strip()
    if not text:
        return []
    con = _con(store)
    cap = max(1, min(200, int(limit or 20)))
    out: list[dict] = []
    seen: set[str] = set()
    sql = ("SELECT c.id, c.document_id, c.ordinal, c.heading, c.text, d.title, d.path "
           "FROM chunk_fts JOIN chunk c ON c.rowid = chunk_fts.rowid "
           "JOIN document d ON d.id = c.document_id WHERE chunk_fts MATCH ?")
    params: list[Any] = [text]
    if document_id:
        sql += " AND c.document_id = ?"
        params.append(document_id)
    sql += " ORDER BY bm25(chunk_fts) LIMIT ?"
    params.append(cap)
    try:
        rows = con.execute(sql, tuple(params)).fetchall()
    except Exception:  # noqa: BLE001 - 非法 FTS 表达式时直接走 LIKE
        rows = []
    for row in rows:
        item = dict(row)
        seen.add(str(item["id"]))
        out.append(item)
    if len(out) >= cap:
        return out
    like = "%" + text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
    sql2 = ("SELECT c.id, c.document_id, c.ordinal, c.heading, c.text, d.title, d.path "
            "FROM chunk c JOIN document d ON d.id = c.document_id "
            "WHERE (c.text LIKE ? ESCAPE '\\' OR c.heading LIKE ? ESCAPE '\\')")
    params2: list[Any] = [like, like]
    if document_id:
        sql2 += " AND c.document_id = ?"
        params2.append(document_id)
    sql2 += " ORDER BY c.ordinal LIMIT ?"
    params2.append(cap)
    for row in con.execute(sql2, tuple(params2)).fetchall():
        item = dict(row)
        if str(item["id"]) in seen:
            continue
        seen.add(str(item["id"]))
        out.append(item)
        if len(out) >= cap:
            break
    return out


def document_text(store, doc_id: str) -> str:
    """取回文档的全部 chunk 正文（索引/调试用）。"""
    con = _con(store)
    rows = con.execute(
        "SELECT text FROM chunk WHERE document_id = ? ORDER BY ordinal", (doc_id,)
    ).fetchall()
    return "\n\n".join(str(r["text"]) for r in rows)


def _zip_preview(path: str | os.PathLike) -> list[str]:
    """列 zip 内部文件名（诊断用，不解压）。"""
    try:
        with zipfile.ZipFile(path) as bundle:
            return bundle.namelist()[:50]
    except (OSError, zipfile.BadZipFile):
        return []