# -*- coding: utf-8 -*-
"""把 dist/ 里已构建好的桌面版组装成发布 zip，并做发布前检查。

    python tools/build_desktop.py --clean     # 先构建（前端 + 后端 + Electron 外壳）
    python tools/release.py                    # 再组装 dist/release/*.zip + SHA256SUMS.txt

1.0.0 的发布 zip 是手工拼的（仓库里没有任何脚本生成它），所以它无法从标签复现：解压出来的
app.asar 里 package.json 的许可写着 Apache-2.0，而标签与仓库都是 MIT。这个脚本让发布包可复现：

* 布局与 1.0.0 相同（MemoraCore/、start-memora-core.cmd、LICENSE、README.md、CHANGELOG.md）。
* 顶层 memora-backend.exe：docs/INDEX.md 承诺过它，可能有 MCP 宿主直接指向它，所以 1.1.0 **保留**
  并标为弃用（README-release.txt 说明迁移方法），1.2.0 移除。两份必须逐字节相同。
  它本身从 32 MB 降到了约 12 MB（不再顺带打包 numpy / Pillow / fontTools）。
* 启动脚本只启动桌面程序。1.0.0 的脚本 3 秒后还会在浏览器里打开固定的 127.0.0.1:8790：
  多一份界面，而且 8790 被占用时外壳会换端口，浏览器那份就指错了地方。
* 发布前：inspect_exe --check（后端里没有未声明的第三方包）+ desensitize_scan（没有构建机身份）。
"""
from __future__ import annotations

import argparse
import hashlib
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DIST = REPO / "dist"
OUT = DIST / "release"

LAUNCHER = "\r\n".join([
    "@echo off",
    "chcp 65001 >nul",
    "rem memora-core %(version)s - launcher (desktop)",
    "setlocal",
    'cd /d "%%~dp0"',
    'if exist "MemoraCore\\MemoraCore.exe" (',
    '  start "" "MemoraCore\\MemoraCore.exe"',
    "  exit /b 0",
    ")",
    "echo MemoraCore\\MemoraCore.exe not found - the archive may be incomplete.",
    "pause",
    "exit /b 1",
    "",
])

RELEASE_NOTE = """memora-core %(version)s (Windows x64)

Start: double-click MemoraCore\\MemoraCore.exe (or start-memora-core.cmd).

DEPRECATED in %(version)s: the top-level memora-backend.exe.
It is a byte-identical copy of MemoraCore\\resources\\backend\\memora-backend.exe and will be
removed in 1.2.0. If an MCP host points at the top-level copy, open the desktop app, use
"Copy MCP config" (tray or Help menu) and paste the new config into the host.

SHA-256 of every file in this archive: see SHA256SUMS.txt next to the zip.
"""


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def check(cmd: list[str]) -> None:
    proc = subprocess.run(cmd, cwd=str(REPO))
    if proc.returncode != 0:
        raise SystemExit("[失败] %s" % " ".join(cmd))


def main(argv=None) -> int:
    sys.path.insert(0, str(REPO))
    from memora_core import __version__  # noqa: PLC0415
    ap = argparse.ArgumentParser(description="组装发布 zip")
    ap.add_argument("--version", default=__version__)
    args = ap.parse_args(argv)
    version = args.version

    app_dir = DIST / "MemoraCore"
    backend = app_dir / "resources" / "backend" / "memora-backend.exe"
    if not (app_dir / "MemoraCore.exe").exists() or not backend.exists():
        raise SystemExit("[失败] 先运行 python tools/build_desktop.py --clean")
    locales = sorted(p.name for p in (app_dir / "locales").glob("*.pak"))
    if len(locales) > 2:
        raise SystemExit("[失败] 语言包未裁剪：%d 个" % len(locales))

    name = "memora-core-%s-windows-x64" % version
    stage = OUT / name
    if stage.exists():
        shutil.rmtree(stage)
    stage.mkdir(parents=True)
    shutil.copytree(app_dir, stage / "MemoraCore")
    shutil.copy2(backend, stage / "memora-backend.exe")  # 弃用的顶层副本，见模块说明
    for doc in ("LICENSE", "README.md", "CHANGELOG.md"):
        shutil.copy2(REPO / doc, stage / doc)
    # 二进制分发里内置的第三方组件必须附带其许可与版权声明（BSD-3 等的要求）
    shutil.copy2(REPO / "docs" / "THIRD-PARTY.md", stage / "THIRD-PARTY.md")
    shutil.copytree(REPO / "docs" / "licenses", stage / "licenses")
    (stage / "start-memora-core.cmd").write_bytes((LAUNCHER % {"version": version}).encode("utf-8"))
    (stage / "README-release.txt").write_bytes(
        (RELEASE_NOTE % {"version": version}).replace("\n", "\r\n").encode("utf-8"))
    if sha256(stage / "memora-backend.exe") != sha256(stage / "MemoraCore" / "resources" / "backend"
                                                      / "memora-backend.exe"):
        raise SystemExit("[失败] 两份后端不一致")

    check([sys.executable, str(REPO / "tools" / "inspect_exe.py"),
           str(stage / "memora-backend.exe"), "--check"])
    check([sys.executable, str(REPO / "tools" / "desensitize_scan.py"), str(stage)])

    archive = OUT / (name + ".zip")
    if archive.exists():
        archive.unlink()
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for path in sorted(stage.rglob("*")):
            if path.is_file():
                zf.write(path, Path(name) / path.relative_to(stage))
    sums = OUT / "SHA256SUMS.txt"
    sums.write_bytes(("%s  %s\n" % (sha256(archive), archive.name)).encode("utf-8"))
    unpacked = sum(p.stat().st_size for p in stage.rglob("*") if p.is_file())
    print("[完成] %s  %.1f MB（解压后 %.1f MB）" % (archive, archive.stat().st_size / 1048576.0,
                                              unpacked / 1048576.0))
    print("[完成] %s" % sums)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
