# -*- coding: utf-8 -*-
"""提示词模板：从 data/builtin/prompts.json 读取，按 {{var}} 渲染。

职责边界：
  * 只负责「读模板 + 填变量 + 宽容地解析 JSON 回复」，不发模型请求；模型调用在节点里。
  * 模板文件允许用户热改，每次读取重新解析，不做进程内缓存。
  * 未提供的占位符保留原样（与 models.render_prompt 口径一致），strict=True 时抛
    PromptVariableError，把「提示词没喂全」暴露成错误而不是静默空串。
  * builtin/prompts.json 里没有、但工作流节点需要的模板放在 DEFAULT_PROMPTS；
    文件里的同名键优先。

对外接口：
    load(name, default='') -> str
    render(template, variables_map=None, *, strict=False, **kw) -> str
    render_named(name, variables_map=None, *, strict=False, **kw) -> str
    builtin_prompts() -> dict[str, str]
    variables(template) -> list[str]
    missing(template, variables_map) -> list[str]
    parse_json(text, expect=dict)
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Mapping

__all__ = [
    "PROMPTS_FILE",
    "DEFAULT_PROMPTS",
    "PromptError",
    "PromptVariableError",
    "builtin_path",
    "builtin_prompts",
    "list_prompts",
    "load",
    "variables",
    "missing",
    "render",
    "render_named",
    "parse_json",
]

PROMPTS_FILE = "prompts.json"

#: {{var}} / {{ var }} / {{a.b}}
_VAR_RE = re.compile(r"\{\{\s*([A-Za-z0-9_.\-]+)\s*\}\}")
#: Markdown 代码围栏（用 chr(96) 拼，避免模板字面量里出现反引号）
_FENCE = chr(96) * 3
_FENCE_RE = re.compile(_FENCE + r"[A-Za-z]*\s*\n?(.*?)" + _FENCE, re.S)

#: 工作流节点用到的补充模板（builtin/prompts.json 里的同名键优先）
DEFAULT_PROMPTS: dict[str, str] = {
    "temporal_relation": (
        "比较两条记忆的时间关系，给出 before / after / overlap / unknown 之一。\n"
        "只输出 JSON：{relation, reason, confidence}。\n"
        "记忆 A（记录于 {{a_at}}）：{{a}}\n记忆 B（记录于 {{b_at}}）：{{b}}"
    ),
    "decide_action": (
        "根据证据在候选动作里选一个最合适的，并给出理由与 0-1 置信度。\n"
        "候选动作：{{actions}}\n证据：{{evidence}}\n"
        "只输出 JSON：{action, reason, confidence}。"
    ),
    "entities": (
        "抽取文本里的实体，给出 name / kind(concept|person|project|tool|term|model|file|org) "
        "/ definition。只输出 JSON 数组。\n文本：{{text}}"
    ),
    "relations": (
        "在给定实体之间建立关系，rel 只能取 {{rels}}。"
        "只输出 JSON 数组，元素为 {src, dst, rel, confidence}。\n实体：{{entities}}"
    ),
    "report": (
        "把下列工作流产物写成中文 Markdown 报告，保留来源与置信度，不要编造。\n"
        "标题：{{title}}\n产物：{{items}}"
    ),
    "grade_answer": (
        "对比标准答案与用户答案，给出 0-5 分与要点命中情况。"
        "只输出 JSON：{score, hit, missing, reason}。\n标准：{{reference}}\n作答：{{answer}}"
    ),
}


class PromptError(RuntimeError):
    """提示词层面的错误（模板缺失 / 无法解析回复）。"""


class PromptVariableError(PromptError):
    """strict 渲染时出现未提供的变量。"""


# ---------------------------------------------------------------------------
# 读取
# ---------------------------------------------------------------------------
def builtin_path() -> Path:
    """builtin/prompts.json 的绝对路径（优先走 paths.package_dir，便于打包后定位）。"""
    try:  # paths.py 可能有更权威的定位方式
        from .paths import package_dir

        base = package_dir()
    except Exception:  # pragma: no cover - paths 不可用时退回模块目录
        base = Path(__file__).resolve().parent
    return base / "data" / "builtin" / PROMPTS_FILE


def builtin_prompts() -> dict[str, str]:
    """内置模板 + 文件模板合并后的字典（文件覆盖内置）。"""
    merged: dict[str, str] = dict(DEFAULT_PROMPTS)
    path = builtin_path()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        data = None
    if isinstance(data, dict):
        for key, value in data.items():
            if isinstance(value, str) and value.strip():
                merged[str(key)] = value
    return merged


def list_prompts() -> dict[str, str]:
    """返回全部可用模板（调试 / 设置页用）。"""
    return builtin_prompts()


def load(name: str, default: str = "") -> str:
    """按名字取模板；不存在时返回 default。"""
    value = builtin_prompts().get(str(name or ""))
    if isinstance(value, str) and value.strip():
        return value
    return default


# ---------------------------------------------------------------------------
# 渲染
# ---------------------------------------------------------------------------
def variables(template: str) -> list[str]:
    """模板里出现的变量名（去重、保序）。"""
    return list(dict.fromkeys(_VAR_RE.findall(template or "")))


def missing(template: str, variables_map: Mapping[str, Any] | None) -> list[str]:
    """模板需要、但 values 里没给的变量名。"""
    provided = set((variables_map or {}).keys())
    return [name for name in variables(template) if name not in provided]


def _stringify(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, (dict, list, tuple)):
        return json.dumps(value, ensure_ascii=False)
    return str(value)


def render(
    template: str,
    variables_map: Mapping[str, Any] | None = None,
    *,
    strict: bool = False,
    **kw: Any,
) -> str:
    """把 {{var}} 替换成变量值；dict/list 按 JSON 序列化，None 渲染为空串。

    未提供的变量保持原样（不会被二次解析），strict=True 时直接抛错。
    """
    values: dict[str, Any] = {}
    if isinstance(variables_map, Mapping):
        values.update(variables_map)
    values.update(kw)
    text = template or ""
    if strict:
        lack = missing(text, values)
        if lack:
            raise PromptVariableError("提示词缺少变量: " + ", ".join(lack))

    def _sub(match: "re.Match[str]") -> str:
        name = match.group(1)
        if name not in values:
            return match.group(0)
        return _stringify(values[name])

    return _VAR_RE.sub(_sub, text)


def render_named(
    name: str,
    variables_map: Mapping[str, Any] | None = None,
    *,
    strict: bool = False,
    **kw: Any,
) -> str:
    """按名字取模板并渲染。"""
    template = load(name, DEFAULT_PROMPTS.get(str(name or ""), ""))
    return render(template, variables_map, strict=strict, **kw)


# ---------------------------------------------------------------------------
# 宽容 JSON 解析（模型回复常带解释文字 / 代码围栏）
# ---------------------------------------------------------------------------
def _balanced(text: str, open_ch: str, close_ch: str) -> str | None:
    start = text.find(open_ch)
    if start < 0:
        return None
    depth = 0
    in_str = False
    quote = ""
    escape = False
    for idx in range(start, len(text)):
        ch = text[idx]
        if in_str:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == quote:
                in_str = False
            continue
        if ch in ('"', "'"):
            in_str, quote = True, ch
            continue
        if ch == open_ch:
            depth += 1
        elif ch == close_ch:
            depth -= 1
            if depth == 0:
                return text[start:idx + 1]
    return None


def parse_json(text: Any, expect: type | tuple = dict) -> Any:
    """从模型回复里挖出 JSON；失败抛 PromptError（不返回假数据）。"""
    if isinstance(text, (dict, list)):
        payload: Any = text
    else:
        raw = str(text or "").strip()
        if not raw:
            raise PromptError("模型回复为空，无法解析 JSON")
        candidates: list[str] = [raw]
        for match in _FENCE_RE.finditer(raw):
            candidates.append(match.group(1).strip())
        for opener, closer in (("{", "}"), ("[", "]")):
            span = _balanced(raw, opener, closer)
            if span:
                candidates.append(span)
        payload = None
        for candidate in candidates:
            try:
                payload = json.loads(candidate)
                break
            except (TypeError, ValueError):
                continue
        if payload is None:
            raise PromptError("模型回复不是合法 JSON: %s" % raw[:160])
    if expect is not None and not isinstance(payload, expect):
        raise PromptError("JSON 类型不符，期望 %s，得到 %s" % (expect, type(payload).__name__))
    return payload
