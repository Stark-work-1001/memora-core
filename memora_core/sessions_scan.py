# -*- coding: utf-8 -*-
"""会话记录定位器：在 Windows 上找到各类智能体的会话/日志文件，供"吸收"使用。

只做**只读定位**，不解析内容（解析在 ingest.py）。设计原则：
  * 路径全部可配置（settings.json 的 agents.paths 覆盖内置猜测）
  * 找不到就返回空列表，不抛异常
  * 只列文件名与大小/时间，不读取正文（避免大文件卡死）
"""
from __future__ import annotations

import os
from pathlib import Path

CANDIDATES = {
    "claude-code": [
        "~/.claude/projects", "~/.claude/history", "~/.claude/todos",
        "~/AppData/Roaming/Claude/logs",
    ],
    "codex-cli": [
        "~/.codex/sessions", "~/.codex/log", "~/.codex/history.jsonl",
    ],
    "dsh": [
        "~/.dsh/sessions", "~/AppData/Roaming/DeepSeek Harness/sessions",
        "~/AppData/Roaming/deepseek-harness/sessions",
    ],
    "cursor": [
        "~/.cursor/chats", "~/AppData/Roaming/Cursor/User/workspaceStorage",
    ],
    "claude-desktop": [
        "~/AppData/Roaming/Claude",
    ],
}

EXTS = {".jsonl", ".json", ".log", ".txt", ".md"}


def _expand(p: str) -> Path:
    return Path(os.path.expanduser(p))


def scan(agent_id: str, limit: int = 200, extra_paths=None) -> list[dict]:
    """返回该 agent 的候选会话文件（最多 limit 个），按 mtime 降序。"""
    out: list[dict] = []
    roots = list(extra_paths or []) + CANDIDATES.get(agent_id, [])
    seen = set()
    for raw in roots:
        root = _expand(raw)
        if not root.exists():
            continue
        if root.is_file():
            files = [root]
        else:
            files = []
            for dirpath, dirnames, filenames in os.walk(root):
                dirnames[:] = [d for d in dirnames if not d.startswith(".")][:40]
                for name in filenames:
                    if Path(name).suffix.lower() in EXTS:
                        files.append(Path(dirpath) / name)
                if len(files) > limit * 4:
                    break
        for f in files:
            key = str(f).lower()
            if key in seen:
                continue
            seen.add(key)
            try:
                st = f.stat()
            except OSError:
                continue
            out.append({
                "agent_id": agent_id,
                "path": str(f),
                "name": f.name,
                "bytes": st.st_size,
                "mtime": st.st_mtime,
            })
    out.sort(key=lambda x: x["mtime"], reverse=True)
    return out[:limit]


def discover(limit_per_agent: int = 50) -> dict:
    return {aid: scan(aid, limit_per_agent) for aid in CANDIDATES}


if __name__ == "__main__":  # pragma: no cover
    import json
    print(json.dumps(discover(), ensure_ascii=False, indent=2)[:4000])
