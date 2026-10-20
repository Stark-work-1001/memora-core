# -*- coding: utf-8 -*-
"""只读检查 PyInstaller 产物：里面到底打进了哪些 Python 包与数据文件。

    python tools/inspect_exe.py dist/memora-backend.exe            # 人读摘要
    python tools/inspect_exe.py dist/memora-backend.exe --json     # 机器读
    python tools/inspect_exe.py dist/memora-backend.exe --check    # 有未声明的第三方包则退出码 1

为什么需要它：1.0.0 的后端 exe 里有 numpy（含 20 MB OpenBLAS）、Pillow、fontTools、pypdf，
约占负载的一半，而 THIRD-PARTY.md 写的是"后端没有运行时第三方依赖"。tools/verify.py 只检查
源码里的 import 语句，看不到构建环境顺着可选导入带进来的东西。这个脚本读的是 exe 本身。
只解析字节（CArchive + PYZ 目录），不执行产物里的任何代码。
"""
from __future__ import annotations

import argparse
import json
import marshal
import struct
import sys
from pathlib import Path

MAGIC = b"MEI" + bytes([12, 11, 10, 11, 14])

# 允许出现在桌面版后端里的非标准库顶层包（见 docs/THIRD-PARTY.md）
DECLARED_THIRD_PARTY = frozenset({"memora_core", "pypdf"})
# PyInstaller 自己的引导模块
BOOTSTRAP = frozenset({"pyimod01_archive", "pyimod02_importers", "pyimod03_ctypes",
                       "pyimod04_pywin32", "pyiboot01_bootstrap", "pyi_rth_inspect",
                       "pyi_rth_pkgutil", "pyi_rth_multiprocessing", "pyi_rth__tkinter",
                       "pyi_rth_pkgres", "pyi_rth_setuptools", "struct"})


def read_toc(exe: Path) -> dict:
    data = exe.read_bytes()
    pos = data.rfind(MAGIC)
    if pos < 0:
        raise SystemExit("不是 PyInstaller 产物（找不到 cookie）：%s" % exe)
    _magic, pkg_len, toc_off, toc_len, pyvers, _pylib = struct.unpack("!8sIIii64s", data[pos:pos + 88])
    start = pos + 88 - pkg_len
    entries, i = [], start + toc_off
    end = i + toc_len
    while i < end:
        entry_len, epos, dlen, ulen, _cflag, typ = struct.unpack("!IIIIBc", data[i:i + 18])
        name = data[i + 18:i + entry_len].rstrip(b"\0").decode("utf-8", "replace")
        entries.append({"name": name, "pos": epos, "dlen": dlen, "ulen": ulen, "type": typ.decode()})
        i += entry_len
    modules: list[str] = []
    for entry in entries:
        if entry["type"] != "z":
            continue
        blob = data[start + entry["pos"]:start + entry["pos"] + entry["dlen"]]
        (ptoc_off,) = struct.unpack("!i", blob[8:12])
        ptoc = marshal.loads(blob[ptoc_off:])
        items = ptoc.items() if isinstance(ptoc, dict) else ptoc
        modules.extend(str(name) for name, _meta in items)
    return {"python": "%d.%d" % divmod(pyvers, 100) if pyvers >= 100 else str(pyvers),
            "entries": entries, "modules": sorted(modules), "bytes": len(data)}


def summarize(exe: Path) -> dict:
    toc = read_toc(exe)
    stdlib = set(getattr(sys, "stdlib_module_names", ()))
    tops: dict[str, int] = {}
    for name in toc["modules"]:
        top = name.split(".", 1)[0]
        tops[top] = tops.get(top, 0) + 1
    binaries: dict[str, int] = {}
    for entry in toc["entries"]:
        if entry["type"] in ("b", "x", "d", "o") or entry["name"].endswith((".pyd", ".dll")):
            top = entry["name"].replace("\\", "/").split("/", 1)[0]
            if "/" in entry["name"].replace("\\", "/"):
                binaries[top] = binaries.get(top, 0) + entry["ulen"]
    third_party = sorted(t for t in tops if t not in stdlib and t not in BOOTSTRAP
                         and not t.startswith(("pyi_", "pyimod", "_pyi")))
    third_party_dirs = sorted(t for t in binaries if t.split(".", 1)[0] not in stdlib
                              and not t.startswith(("memora_core", "base_library")))
    undeclared = sorted(set(third_party) - DECLARED_THIRD_PARTY)
    undeclared += sorted(d for d in third_party_dirs
                         if d.split(".", 1)[0] not in DECLARED_THIRD_PARTY and d not in undeclared)
    return {"exe": str(exe), "bytes": toc["bytes"], "python": toc["python"],
            "modules": len(toc["modules"]), "packages": dict(sorted(tops.items())),
            "third_party": third_party, "binary_dirs": binaries, "undeclared": undeclared,
            "data_files": sorted(e["name"] for e in toc["entries"] if e["type"] == "x")}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="检查 PyInstaller 产物里打进了什么")
    ap.add_argument("exe")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--check", action="store_true", help="有未声明的第三方包时返回 1")
    args = ap.parse_args(argv)
    info = summarize(Path(args.exe))
    if args.json:
        print(json.dumps(info, ensure_ascii=False, indent=2))
    else:
        print("%s  %.1f MB  python %s  %d 个模块" % (info["exe"], info["bytes"] / 1048576.0,
                                                  info["python"], info["modules"]))
        print("第三方顶层包：%s" % (", ".join("%s(%d)" % (t, info["packages"][t])
                                         for t in info["third_party"]) or "无"))
        if info["binary_dirs"]:
            print("二进制目录：%s" % ", ".join("%s %.1f MB" % (k, v / 1048576.0)
                                          for k, v in sorted(info["binary_dirs"].items())))
        print("未声明：%s" % (", ".join(info["undeclared"]) or "无"))
    if args.check and info["undeclared"]:
        print("[失败] 产物里有未在 docs/THIRD-PARTY.md 声明的第三方包：%s"
              % ", ".join(info["undeclared"]), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
