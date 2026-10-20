# -*- coding: utf-8 -*-
"""发布前脱敏扫描：产物里不得出现**构建机**的身份信息。

    python tools/desensitize_scan.py dist/                     # 扫目录（递归）
    python tools/desensitize_scan.py dist/memora-backend.exe   # 扫单个产物
    python tools/desensitize_scan.py release.zip --needle 某个额外字符串

README 承诺"构建产物已逐字节扫描，确认不含本机路径或用户名"，但 1.0.0 的仓库里没有做这件事的
工具（tools/safety.py 是另一回事）。本脚本把承诺变成可复现的命令：

* 要找的是**这台构建机**的身份：用户名、家目录、仓库绝对路径、主机名、git user.name / user.email，
  以及 --needle 给的额外字符串。按 UTF-8 与 UTF-16LE 两种编码、大小写不敏感地找。
  不用"像路径的正则"——第三方二进制里本来就有别人的构建路径（numpy 的 CI 目录、CPython 文档
  示例），那些不是泄漏，误报只会让人习惯性忽略结果。
* 会钻进容器：zip 成员、PyInstaller 产物（CArchive 条目 + 解压后的 PYZ 模块）、Electron app.asar。
* 只读，不执行被扫描的任何东西。发现即退出码 1；输出只报类别与位置，不回显具体值。
"""
from __future__ import annotations

import argparse
import getpass
import io
import json
import marshal
import os
import socket
import struct
import subprocess
import sys
import zipfile
import zlib
from pathlib import Path

MEI = b"MEI" + bytes([12, 11, 10, 11, 14])
MIN_NEEDLE = 4


def identity_needles(repo: Path, extra: list[str]) -> dict[str, str]:
    found: dict[str, str] = {}

    def add(label: str, value: str | None) -> None:
        value = (value or "").strip()
        if len(value) >= MIN_NEEDLE or (value and any(ord(ch) > 127 for ch in value)):
            found.setdefault(value, label)

    try:
        add("username", getpass.getuser())
    except Exception:  # noqa: BLE001
        pass
    home = str(Path.home())
    add("home", home)
    add("home", home.replace(os.sep, "/"))
    add("repo", str(repo))
    add("repo", str(repo).replace(os.sep, "/"))
    try:
        add("hostname", socket.gethostname())
    except OSError:
        pass
    for key in ("user.name", "user.email"):
        try:
            value = subprocess.run(["git", "config", key], cwd=str(repo), capture_output=True,
                                   text=True, timeout=10).stdout
        except (OSError, subprocess.SubprocessError):
            value = ""
        add("git " + key, value)
    for item in extra:
        add("extra", item)
    return {value: label for value, label in found.items()}


def encodings(needle: str) -> list[bytes]:
    forms = []
    for variant in {needle, needle.lower(), needle.upper()}:
        forms.append(variant.encode("utf-8"))
        forms.append(variant.encode("utf-16-le"))
    return list(dict.fromkeys(forms))


class Scanner:
    def __init__(self, needles: dict[str, str]) -> None:
        self.needles = {label_value: encodings(label_value) for label_value in needles}
        self.labels = needles
        self.findings: list[dict] = []
        self.scanned = 0

    def hit(self, where: str, data: bytes) -> None:
        self.scanned += 1
        lowered = data.lower()
        for needle, forms in self.needles.items():
            for form in forms:
                if form in data or form.lower() in lowered:
                    self.findings.append({"where": where, "kind": self.labels[needle]})
                    break

    def scan_bytes(self, where: str, data: bytes, depth: int = 0) -> None:
        self.hit(where, data)
        if depth > 2:
            return
        if data[:2] == b"PK":
            try:
                with zipfile.ZipFile(io.BytesIO(data)) as archive:
                    for info in archive.infolist():
                        if not info.is_dir():
                            self.scan_bytes(where + "!" + info.filename, archive.read(info), depth + 1)
            except zipfile.BadZipFile:
                pass
        if data.rfind(MEI) > 0:
            self.scan_pyinstaller(where, data, depth)
        if where.lower().endswith(".asar"):
            self.scan_asar(where, data, depth)

    def scan_pyinstaller(self, where: str, data: bytes, depth: int) -> None:
        pos = data.rfind(MEI)
        try:
            _m, pkg_len, toc_off, toc_len, _v, _lib = struct.unpack("!8sIIii64s", data[pos:pos + 88])
        except struct.error:
            return
        start = pos + 88 - pkg_len
        i, end = start + toc_off, start + toc_off + toc_len
        while i < end:
            entry_len, epos, dlen, _ulen, cflag, typ = struct.unpack("!IIIIBc", data[i:i + 18])
            name = data[i + 18:i + entry_len].rstrip(b"\0").decode("utf-8", "replace")
            i += entry_len
            blob = data[start + epos:start + epos + dlen]
            if cflag:
                try:
                    blob = zlib.decompress(blob)
                except zlib.error:
                    pass
            if typ == b"z":
                self.scan_pyz(where + "!" + name, blob)
            else:
                self.scan_bytes(where + "!" + name, blob, depth + 1)

    def scan_pyz(self, where: str, blob: bytes) -> None:
        try:
            (ptoc_off,) = struct.unpack("!i", blob[8:12])
            toc = marshal.loads(blob[ptoc_off:])
        except Exception:  # noqa: BLE001
            return
        items = toc.items() if isinstance(toc, dict) else toc
        for name, meta in items:
            mpos, mlen = meta[-2], meta[-1]
            try:
                self.hit(where + "!" + str(name), zlib.decompress(blob[mpos:mpos + mlen]))
            except zlib.error:
                continue

    def scan_asar(self, where: str, data: bytes, depth: int) -> None:
        try:
            header_size = struct.unpack("<I", data[12:16])[0]
            header = json.loads(data[16:16 + header_size].decode("utf-8"))
        except Exception:  # noqa: BLE001
            return
        base = 8 + struct.unpack("<I", data[4:8])[0]

        def walk(node: dict, prefix: str) -> None:
            for name, child in (node.get("files") or {}).items():
                if "files" in child:
                    walk(child, prefix + name + "/")
                elif "offset" in child and not child.get("unpacked"):
                    offset = base + int(child["offset"])
                    self.scan_bytes(where + "!" + prefix + name,
                                    data[offset:offset + int(child.get("size", 0))], depth + 1)

        walk(header, "")

    def scan_path(self, path: Path) -> None:
        if path.is_dir():
            for item in sorted(path.rglob("*")):
                if item.is_file():
                    self.scan_bytes(str(item), item.read_bytes())
        elif path.is_file():
            self.scan_bytes(str(path), path.read_bytes())


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="扫描发布产物里的构建机身份信息")
    ap.add_argument("targets", nargs="+")
    ap.add_argument("--needle", action="append", default=[], help="额外要找的字符串")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)
    repo = Path(__file__).resolve().parent.parent
    needles = identity_needles(repo, args.needle)
    scanner = Scanner(needles)
    for target in args.targets:
        scanner.scan_path(Path(target))
    report = {"scanned_blobs": scanner.scanned, "needle_kinds": sorted(set(needles.values())),
              "findings": scanner.findings}
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print("扫描了 %d 个文件/成员；查找：%s" % (scanner.scanned, ", ".join(report["needle_kinds"])))
        for item in scanner.findings[:50]:
            print("  [命中] %-12s %s" % (item["kind"], item["where"]))
        print("结论：%s" % ("干净" if not scanner.findings else "发现 %d 处" % len(scanner.findings)))
    return 1 if scanner.findings else 0


if __name__ == "__main__":
    raise SystemExit(main())
