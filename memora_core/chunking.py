# -*- coding: utf-8 -*-
"""Markdown / 纯文本切块：标题路径、代码块/公式块/表格整块保留、token 预算 + 重叠。

对应 data/builtin/algorithms.json 的 semantic-chunking（标题边界优先）与
greedy-budget-pack（预算内的贪心装入）。

设计要点：
- **原子块**：围栏代码块、$$ 公式块、Markdown 表格永远不切断，哪怕超过 max_tokens
  （宁可超预算也不产出半截代码 —— 半截代码对下游模型是纯噪声）。
- **标题路径**：chunk 带 "# A > ## B" 形式的路径，检索时可作为上下文前缀（contextual-prefix）。
- **行号**：start_line/end_line 为 1-based 的原文行号，供前端定位与引用。
- **hash**：blake2b(text)[:16]，用于内容寻址与幂等重切块。
"""
from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field

from .vectors import estimate_tokens

__all__ = ["chunk_markdown", "chunk_text", "estimate_tokens", "split_blocks"]

_HEADING_RE = re.compile(r"^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$")
_FENCE_RE = re.compile(r"^ {0,3}(`{3,}|~{3,})(.*)$")
_TABLE_RE = re.compile(r"^ {0,3}\|")
_SENTENCE_RE = re.compile(r"[^。！？!?\.\n]+[。！？!?\.]*|\n")


@dataclass
class Block:
    """一个不可再分的文本单元。kind: heading|para|code|formula|table。"""
    kind: str
    text: str
    start: int
    end: int
    level: int = 0
    atomic: bool = False
    lang: str = ""
    extra: dict = field(default_factory=dict)


def _hash(text: str) -> str:
    return hashlib.blake2b(text.encode("utf-8"), digest_size=8).hexdigest()


# ---------------------------------------------------------------------------
# 块扫描
# ---------------------------------------------------------------------------

def split_blocks(text: str) -> list[Block]:
    """把文本切成块：标题 / 段落 / 代码 / 公式 / 表格。代码、公式、表格标记 atomic。"""
    lines = (text or "").replace("\r\n", "\n").replace("\r", "\n").split("\n")
    blocks: list[Block] = []
    i = 0
    total = len(lines)
    while i < total:
        line = lines[i]
        # --- 围栏代码块：必须整块吃掉，内部 # 不是标题
        fence = _FENCE_RE.match(line)
        if fence:
            marker = fence.group(1)
            lang = (fence.group(2) or "").strip()
            start = i
            i += 1
            while i < total:
                closing = lines[i].strip()
                if closing.startswith(marker[0] * len(marker)):
                    i += 1
                    break
                i += 1
            blocks.append(Block("code", "\n".join(lines[start:i]), start + 1, i,
                                atomic=True, lang=lang))
            continue
        # --- 公式块 $$ ... $$
        stripped = line.strip()
        if stripped.startswith("$$"):
            start = i
            if stripped != "$$" and stripped.endswith("$$") and len(stripped) > 4:
                i += 1  # 单行 $$...$$
            else:
                i += 1
                while i < total and not lines[i].strip().endswith("$$"):
                    i += 1
                if i < total:
                    i += 1
            blocks.append(Block("formula", "\n".join(lines[start:i]), start + 1, i, atomic=True))
            continue
        # --- 表格：连续的 | 行整块保留
        if _TABLE_RE.match(line):
            start = i
            while i < total:
                if _TABLE_RE.match(lines[i]):
                    i += 1
                    continue
                if (lines[i].strip() == "" and i + 1 < total
                        and _TABLE_RE.match(lines[i + 1])):
                    i += 1
                    continue
                break
            blocks.append(Block("table", "\n".join(lines[start:i]), start + 1, i, atomic=True))
            continue
        # --- 标题
        heading = _HEADING_RE.match(line)
        if heading:
            marker = "#" * len(heading.group(1))
            blocks.append(Block("heading", heading.group(2).strip(), i + 1, i + 1,
                                level=len(heading.group(1)), extra={"marker": marker}))
            i += 1
            continue
        # --- 空行 = 段落分隔
        if not stripped:
            i += 1
            continue
        # --- 普通段落
        start = i
        while i < total:
            cur = lines[i]
            if not cur.strip():
                break
            if _FENCE_RE.match(cur) or _TABLE_RE.match(cur) or _HEADING_RE.match(cur):
                break
            if cur.strip().startswith("$$"):
                break
            i += 1
        blocks.append(Block("para", "\n".join(lines[start:i]), start + 1, i))
    return blocks


# ---------------------------------------------------------------------------
# 文本切分（段落内部 / 纯文本）
# ---------------------------------------------------------------------------

def _split_units(block_text: str) -> list[str]:
    """把一段话按句子切开，保留标点。"""
    units = [u for u in _SENTENCE_RE.findall(block_text) if u.strip()]
    return units or ([block_text] if block_text.strip() else [])


def split_blocks_by_tokens(text: str, max_tokens: int, overlap: int = 0) -> list[str]:
    """纯文本切分：段落优先，超长段落按句子切，带 token 重叠。"""
    max_tokens = max(1, int(max_tokens or 1))
    units: list[str] = []
    for block in split_blocks(text):
        if block.kind == "heading":
            units.append(block.extra.get("marker", "#") + " " + block.text)
        elif block.atomic:
            units.append(block.text)
        else:
            units.extend(_split_units(block.text))
    return _pack_units(units, max_tokens, overlap)


def _tail_by_tokens(text: str, overlap: int) -> str:
    """取文本尾部约 overlap 个 token。"""
    if overlap <= 0 or not text:
        return ""
    sentences = _split_units(text)
    tail: list[str] = []
    used = 0
    for unit in reversed(sentences):
        cost = estimate_tokens(unit)
        if used + cost > overlap and tail:
            break
        tail.append(unit)
        used += cost
        if used >= overlap:
            break
    return "".join(reversed(tail)).strip()


def _joined(units: list[str]) -> str:
    return "\n\n".join(units).strip()


def _pack_units(units: list[str], max_tokens: int, overlap: int) -> list[str]:
    """贪心装入。预算按**拼接后的真实文本**计量 —— 逐条求和会因为圆整而溢出 1~2 token。"""
    chunks: list[str] = []
    current: list[str] = []
    for unit in units:
        if not current:
            if estimate_tokens(unit) > max_tokens:
                chunks.append(unit.strip())   # 原子块超预算：单独成块，绝不切
                continue
            current = [unit]
            continue
        trial = current + [unit]
        if estimate_tokens(_joined(trial)) > max_tokens:
            packed = _joined(current)
            chunks.append(packed)
            carried = _tail_by_tokens(packed, overlap)
            current = ([carried] if carried else []) + [unit]
            if estimate_tokens(_joined(current)) > max_tokens:
                current = [unit]
        else:
            current = trial
    if current:
        joined = _joined(current)
        if joined:
            chunks.append(joined)
    return [c for c in chunks if c.strip()]


# ---------------------------------------------------------------------------
# Markdown 切块
# ---------------------------------------------------------------------------

def _heading_path(stack: list[tuple[int, str]]) -> str:
    return " > ".join(title for _, title in stack)


def chunk_markdown(text: str, max_tokens: int = 900, overlap: int = 120) -> list[dict]:
    """按标题层级切块，保留 heading 路径；代码/公式/表格整块保留。

    返回 [{ordinal, heading, level, text, tokens, start_line, end_line, hash}]
    """
    max_tokens = max(1, int(max_tokens or 900))
    overlap = max(0, int(overlap or 0))
    blocks = split_blocks(text)
    if not blocks:
        return []

    # 1) 按标题分组
    sections: list[dict] = []
    stack: list[tuple[int, str]] = []
    current = {"path": "", "level": 0, "blocks": [], "heading_block": None}
    for block in blocks:
        if block.kind == "heading":
            if current["blocks"] or current["heading_block"]:
                sections.append(current)
            while stack and stack[-1][0] >= block.level:
                stack.pop()
            stack.append((block.level, block.extra.get("marker", "#") + " " + block.text))
            current = {"path": _heading_path(stack), "level": block.level,
                       "blocks": [], "heading_block": block}
        else:
            current["blocks"].append(block)
    if current["blocks"] or current["heading_block"]:
        sections.append(current)

    # 2) 逐段切块
    out: list[dict] = []
    for section in sections:
        blocks_ = section["blocks"]
        if not blocks_:
            continue
        heading_path = section["path"]
        level = section["level"]
        head_block = section["heading_block"]
        base_start = head_block.start if head_block else blocks_[0].start

        units: list[tuple[str, int, int]] = []   # (text, start_line, end_line)
        for block in blocks_:
            if block.atomic:
                units.append((block.text, block.start, block.end))
                continue
            cost = estimate_tokens(block.text)
            if cost <= max_tokens:
                units.append((block.text, block.start, block.end))
                continue
            # 段落本身超预算：先按句子切成带重叠的片，再进 section 打包
            for piece in _pack_units(_split_units(block.text), max_tokens, overlap):
                units.append((piece, block.start, block.end))

        current_units: list[tuple[str, int, int]] = []

        def fits(extra: tuple[str, int, int]) -> bool:
            trial = [u[0] for u in current_units] + [extra[0]]
            return estimate_tokens(_joined(trial)) <= max_tokens

        for text_, start, end in units:
            if not current_units:
                if estimate_tokens(text_) > max_tokens:
                    # 单块就超预算：独立成块，绝不切碎代码/公式/表格
                    out.append(_make_chunk(heading_path, level, base_start,
                                           [(text_, start, end)]))
                    continue
                current_units = [(text_, start, end)]
                continue
            if not fits((text_, start, end)):
                packed_text = _joined([u[0] for u in current_units])
                out.append(_make_chunk(heading_path, level, base_start, current_units))
                tail = _tail_by_tokens(packed_text, overlap)
                current_units = ([(tail, start, end)] if tail else []) + [(text_, start, end)]
                if estimate_tokens(_joined([u[0] for u in current_units])) > max_tokens:
                    current_units = [(text_, start, end)]
            else:
                current_units.append((text_, start, end))
        if current_units:
            out.append(_make_chunk(heading_path, level, base_start, current_units))

    for idx, chunk in enumerate(out):
        chunk["ordinal"] = idx
    return out


def _make_chunk(heading_path: str, level: int, base_start: int,
                units: list[tuple[str, int, int]]) -> dict:
    text = "\n\n".join(u[0] for u in units).strip()
    start = min([base_start] + [u[1] for u in units])
    end = max([base_start] + [u[2] for u in units])
    return {
        "ordinal": 0,
        "heading": heading_path,
        "level": level,
        "text": text,
        "tokens": estimate_tokens(text),
        "start_line": start,
        "end_line": end,
        "hash": _hash(text),
    }


def chunk_text(text: str, max_tokens: int = 900, overlap: int = 120) -> list[dict]:
    """纯文本切块（无标题语义），返回结构同 chunk_markdown。"""
    max_tokens = max(1, int(max_tokens or 900))
    overlap = max(0, int(overlap or 0))
    pieces = split_blocks_by_tokens(text, max_tokens, overlap)
    out: list[dict] = []
    for idx, piece in enumerate(pieces):
        body = piece.strip()
        out.append({
            "ordinal": idx,
            "heading": "",
            "level": 0,
            "text": body,
            "tokens": estimate_tokens(body),
            "start_line": 0,
            "end_line": 0,
            "hash": _hash(body),
        })
    return out
