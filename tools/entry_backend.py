# -*- coding: utf-8 -*-
"""PyInstaller 入口：把 memora_core 的命令行包装成 memora-backend.exe。

打包后 sys.frozen 为真，memora_core.paths 会自动把数据目录定位到 exe 同级或
--data / MEMORA_HOME 指定的位置。源码运行时则把仓库根加入 sys.path。
"""
from __future__ import annotations

import os
import sys
from pathlib import Path


def _repo_root() -> Path:
    return Path(__file__).resolve().parent.parent


def _ensure_streams() -> None:
    """--noconsole 打包后 sys.stdout/sys.stderr 可能为 None，避免 print 崩溃。

    MEMORA_PROBE_FILE 存在时把输出重定向到该文件（冒烟自检用）。
    """
    probe = os.environ.get("MEMORA_PROBE_FILE")
    if probe:
        try:
            handle = open(probe, "w", encoding="utf-8", buffering=1)
            sys.stdout = handle
            sys.stderr = handle
            return
        except OSError:
            pass
    for name in ("stdout", "stderr"):
        if getattr(sys, name, None) is None:
            try:
                setattr(sys, name, open(os.devnull, "w", encoding="utf-8"))
            except OSError:
                pass


def _normalize_argv(argv):
    """把 --data 提到子命令之前。

    memora_core 的 argparse 把 --data 定义在根解析器上，因此
    "serve --port 8790 --data <目录>" 这种（文档里写的）顺序会让 argparse 报错。
    这里把 --data/--data= 统一挪到子命令前，两种写法都能用。
    """
    rest, data = [], []
    i = 0
    while i < len(argv):
        token = argv[i]
        if token == "--data":
            if i + 1 < len(argv):
                data = ["--data", argv[i + 1]]
                i += 2
                continue
            data = []
            i += 1
            continue
        if token.startswith("--data="):
            data = [token]
            i += 1
            continue
        rest.append(token)
        i += 1
    return data + rest if data else rest


def main() -> int:
    _ensure_streams()
    if not getattr(sys, "frozen", False):
        root = str(_repo_root())
        if root not in sys.path:
            sys.path.insert(0, root)
    from memora_core.__main__ import main as _main
    return int(_main(_normalize_argv(sys.argv[1:])) or 0)


if __name__ == "__main__":
    sys.exit(main())
