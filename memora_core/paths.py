# -*- coding: utf-8 -*-
"""数据目录解析。

优先级：
  1) 显式传入的 --data / MEMORA_HOME 环境变量
  2) 打包版：可执行文件同级的 data/（便于绿色迁移）
  3) 源码运行：仓库根目录的 data/
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

SUBDIRS = ("vault", "vault/daily", "vault/memories", "vault/notes", "vault/reports",
           "inbox", "exports", "heartbeat", "backups", "logs", "tmp")


def package_dir() -> Path:
    return Path(__file__).resolve().parent


def repo_root() -> Path:
    return package_dir().parent


def is_frozen() -> bool:
    return bool(getattr(sys, "frozen", False))


def default_data_dir() -> Path:
    env = os.environ.get("MEMORA_HOME")
    if env:
        return Path(env).expanduser().resolve()
    if is_frozen():
        base = Path(sys.executable).resolve().parent
        candidate = base / "data"
        if candidate.exists() or os.access(base, os.W_OK):
            return candidate
    return repo_root() / "data"


def resolve(data_arg: str | os.PathLike | None = None) -> Path:
    if data_arg:
        return Path(data_arg).expanduser().resolve()
    return default_data_dir()


class Paths:
    """一次解析、到处使用的数据目录视图。"""

    def __init__(self, root: str | os.PathLike | None = None):
        self.root = resolve(root)
        self.db = self.root / "memora.db"
        self.vault = self.root / "vault"
        self.inbox = self.root / "inbox"
        self.exports = self.root / "exports"
        self.heartbeat = self.root / "heartbeat"
        self.backups = self.root / "backups"
        self.logs = self.root / "logs"
        self.tmp = self.root / "tmp"
        self.models = self.root / "models.json"
        self.secrets = self.root / "secrets.bin"
        self.settings = self.root / "settings.json"

    def ensure(self) -> "Paths":
        for rel in SUBDIRS:
            (self.root / rel).mkdir(parents=True, exist_ok=True)
        return self

    def exists(self) -> bool:
        return self.db.exists()

    def as_dict(self) -> dict:
        return {"root": str(self.root), "db": str(self.db), "vault": str(self.vault)}

    def __repr__(self) -> str:  # pragma: no cover - debug helper
        return "Paths(root=%r)" % (str(self.root),)
