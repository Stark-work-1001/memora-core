# -*- coding: utf-8 -*-
"""memora-core / 记忆中枢。

把多个智能体的记忆收敛到一处的本地记忆中枢：SQLite 事务真源 + Markdown 可读镜像，
云端模型（chat / embedding / reranker / judge）驱动的记忆工作流，
以及 2D/3D 脑图查看与学习。
"""
from __future__ import annotations

__all__ = ["__version__", "APP_NAME", "APP_NAME_ZH"]
__version__ = "1.0.0"
APP_NAME = "memora-core"
APP_NAME_ZH = "记忆中枢"
