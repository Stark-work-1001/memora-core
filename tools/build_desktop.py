#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""桌面端总编排：前端构建 -> PyInstaller -> Electron 目录打包 -> 冒烟自检。

    python tools/build_desktop.py                 # 全流程
    python tools/build_desktop.py --skip-backend   # 复用已有 dist/memora-backend.exe
    python tools/build_desktop.py --skip-smoke
    python tools/build_desktop.py --manual         # 直接走降级方案

产物：dist/MemoraCore/MemoraCore.exe（绿色目录，可直接双击）。
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DIST = REPO / "dist"
OUT_DIR = DIST / "MemoraCore"
BACKEND_EXE = DIST / "memora-backend.exe"
DESKTOP = REPO / "desktop"
EB_CACHE = Path(os.environ.get("MEMORA_ELECTRON_CACHE", str(REPO / "cache" / "electron")))

# 桌面打包工具链：默认使用 desktop/ 下 npm 安装的结果，可用环境变量指向别处。
#   cd desktop && npm install      # 安装 electron + electron-builder
REF_DESKTOP = Path(os.environ.get("MEMORA_ELECTRON_HOME", str(DESKTOP)))
REF_ELECTRON_DIST = REF_DESKTOP / "node_modules" / "electron" / "dist"
REF_BUILDER_CLI = REF_DESKTOP / "node_modules" / "electron-builder" / "cli.js"

APP_FILES = ["package.json", "main.cjs", "preload.cjs", "splash.html", "error.html", "icon.png"]


def say(msg=""):
    print(msg, flush=True)


def rule(title):
    say("")
    say("=" * 70)
    say(" " + title)
    say("=" * 70)


def human(n: int) -> str:
    units = ["B", "KB", "MB", "GB"]
    size = float(n)
    for unit in units:
        if size < 1024 or unit == units[-1]:
            return "%.1f %s" % (size, unit)
        size /= 1024.0
    return "%.1f GB" % size


def dir_size(path: Path) -> int:
    total = 0
    for root, _dirs, files in os.walk(path):
        for name in files:
            try:
                total += (Path(root) / name).stat().st_size
            except OSError:
                pass
    return total


def python_bin() -> str:
    """优先使用用户指定的 venv；不存在则用当前解释器。"""
    env = os.environ.get("MEMORA_PYTHON")
    if env and Path(env).exists():
        return env
    venv = Path(os.environ.get("MEMORA_VENV", str(REPO / ".venv" / "Scripts" / "python.exe")))
    if venv.exists():
        return str(venv)
    return sys.executable


def run(cmd, cwd=None, env=None) -> int:
    say("$ " + " ".join(str(c) for c in cmd))
    proc = subprocess.run([str(c) for c in cmd], cwd=str(cwd) if cwd else None, env=env)
    return proc.returncode


# --------------------------------------------------------------------------- #
# 1. 前端
# --------------------------------------------------------------------------- #
def build_frontend(skip: bool) -> bool:
    rule("步骤 1/4 · 前端构建")
    entry = REPO / "frontend" / "src" / "app" / "main.ts"
    if skip:
        say("[跳过] --skip-frontend")
        return True
    if not entry.exists():
        say("[跳过] frontend/src/app/main.ts 尚不存在（前端由其它任务负责），"
            "沿用 memora_core/static 现有产物")
        return True
    node_modules = REPO / "frontend" / "node_modules"
    if not node_modules.exists():
        say("[跳过] 缺少 frontend/node_modules，无法离线构建")
        return True
    build_script = REPO / "frontend" / "build.mjs"
    code = run(["node", str(build_script)], cwd=REPO / "frontend")
    if code != 0:
        say("[失败] 前端构建失败，返回码 %d" % code)
        return False
    say("[完成] 前端产物已写入 memora_core/static")
    return True


# --------------------------------------------------------------------------- #
# 2. 后端 exe
# --------------------------------------------------------------------------- #
def build_backend(skip: bool) -> bool:
    rule("步骤 2/4 · PyInstaller 后端打包")
    if skip:
        if BACKEND_EXE.exists():
            say("[跳过] 复用已有 %s (%d 字节)" % (BACKEND_EXE, BACKEND_EXE.stat().st_size))
            return True
        say("[失败] --skip-backend 但 %s 不存在" % BACKEND_EXE)
        return False
    if BACKEND_EXE.exists():
        say("[复用] 已存在 %s (%d 字节)，如需重打请删除或去掉 --skip-backend"
            % (BACKEND_EXE, BACKEND_EXE.stat().st_size))
    else:
        code = run([python_bin(), str(REPO / "tools" / "package.py")], cwd=REPO)
        if code != 0:
            say("[失败] 后端打包失败，返回码 %d" % code)
            return False
    if not BACKEND_EXE.exists():
        say("[失败] 未产出 %s" % BACKEND_EXE)
        return False
    say("[完成] %s = %d 字节 (%.1f MB)"
        % (BACKEND_EXE, BACKEND_EXE.stat().st_size, BACKEND_EXE.stat().st_size / 1048576.0))
    return True


# --------------------------------------------------------------------------- #
# 3. Electron 目录
# --------------------------------------------------------------------------- #
def stage_out_dir(clean: bool) -> None:
    if OUT_DIR.exists() and clean:
        say("[清理] 移除旧输出 %s" % OUT_DIR)
        shutil.rmtree(OUT_DIR, ignore_errors=True)


def find_unpacked(root: Path):
    for candidate in (root / "win-unpacked", root):
        if candidate.is_dir():
            for exe in candidate.glob("*.exe"):
                if exe.name.lower() not in ("memora-backend.exe",):
                    return candidate, exe
    return None, None


def stage_build_resources() -> Path:
    """electron-builder 的 buildResources：只放一个 icon.ico。

    关键：app-builder 的 PNG->ICO 转换在本机总会 "Access is denied"，
    直接给它现成的 .ico（由 tools/package.py 用纯标准库生成）即可绕过。
    """
    res = DIST / ".eb-resources"
    res.mkdir(parents=True, exist_ok=True)
    src = DIST / ".build" / "memora-backend.ico"
    if not src.exists():
        src = Path(tempfile.gettempdir()) / "memora-fallback.ico"
        src.write_bytes(b"")  # 占位，后续由 package.py --icon-only 补齐
        src.unlink(missing_ok=True)
        code = run([python_bin(), str(REPO / "tools" / "package.py"), "--icon-only"], cwd=REPO)
        if code != 0 or not (DIST / ".build" / "memora-backend.ico").exists():
            return res
        src = DIST / ".build" / "memora-backend.ico"
    shutil.copy2(src, res / "icon.ico")
    return res


def pack_with_builder(stage: Path) -> tuple:
    """electron-builder --dir；成功返回 (目录, exe)。"""
    if not REF_BUILDER_CLI.exists():
        return None, None, "未找到 electron-builder：%s" % REF_BUILDER_CLI
    if not REF_ELECTRON_DIST.exists():
        return None, None, "未找到 electron dist：%s" % REF_ELECTRON_DIST
    node = shutil.which("node")
    if not node:
        return None, None, "PATH 中没有 node"
    build_res = stage_build_resources()

    env = dict(os.environ)
    if EB_CACHE.exists():
        env["ELECTRON_BUILDER_CACHE"] = str(EB_CACHE)
        say("[环境] ELECTRON_BUILDER_CACHE=%s" % EB_CACHE)
    env["CSC_IDENTITY_AUTO_DISCOVERY"] = "false"

    cmd = [
        node, str(REF_BUILDER_CLI),
        "--win", "dir",
        "--config.electronDist=" + str(REF_ELECTRON_DIST),
        "--config.electronVersion=44.7.2",
        "--config.directories.output=" + str(stage),
        "--config.directories.buildResources=" + str(build_res),
        "--config.win.icon=icon.ico",
        # 本机 app-builder 改写 exe 资源（图标/版本信息）必定 ERR_ELECTRON_BUILDER_CANNOT_EXECUTE，
        # 关闭后 builder 可完整跑通；代价是 exe 保留 Electron 默认图标（运行期窗口/托盘图标不受影响）
        "--config.win.signAndEditExecutable=false",
        "--config.asar=true",
        # extraResources / files / asar 直接取自 desktop/package.json 的 build 字段
        # （CLI 的 --config.extraResources=a:b 会被解析成对象而不是数组，故不用）
    ]
    say("[builder] buildResources=%s（内含预生成的 icon.ico）" % build_res)
    # electron-builder 输出很长，落盘后再回显尾部，避免管道提前关闭
    log_path = DIST / ".build" / "electron-builder.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with open(log_path, "w", encoding="utf-8", errors="replace") as log:
        proc = subprocess.run([str(c) for c in cmd], cwd=str(DESKTOP), env=env,
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        text = (proc.stdout or b"").decode("utf-8", "replace")
        log.write(text)
    for line in text.strip().splitlines()[-12:]:
        say("  [builder] " + line)
    say("  [builder] 完整日志：%s" % log_path)
    code = proc.returncode
    if code != 0:
        return None, None, "electron-builder 退出码 %d（日志 %s）" % (code, log_path)
    packaged, exe = find_unpacked(stage)
    if packaged is None:
        return None, None, "electron-builder 结束但未找到解包目录"
    return packaged, exe, None


def pack_manually(stage: Path) -> tuple:
    """降级方案：手工复制 electron dist + resources/app + resources/backend。"""
    say("[降级] 手工打包：复制 electron dist -> %s" % stage)
    if not REF_ELECTRON_DIST.exists():
        return None, None, "未找到 electron dist：%s" % REF_ELECTRON_DIST
    if stage.exists():
        shutil.rmtree(stage, ignore_errors=True)
    stage.mkdir(parents=True, exist_ok=True)
    shutil.copytree(REF_ELECTRON_DIST, stage, dirs_exist_ok=True)
    # 与 desktop/package.json 的 electronLanguages 保持一致：单语言产品只留 zh-CN（+ en-US 兜底）。
    # 1.0.0 带了全部 55 个 Chromium 语言包（解压后约 50 MB）。
    keep = {"zh-CN.pak", "en-US.pak"}
    for pak in (stage / "locales").glob("*.pak"):
        if pak.name not in keep:
            pak.unlink()

    source_exe = stage / "electron.exe"
    target_exe = stage / "MemoraCore.exe"
    if source_exe.exists():
        if target_exe.exists():
            target_exe.unlink()
        source_exe.rename(target_exe)
    else:
        return None, None, "electron dist 里没有 electron.exe"

    resources = stage / "resources"
    app_dir = resources / "app"
    if app_dir.exists():
        shutil.rmtree(app_dir, ignore_errors=True)
    app_dir.mkdir(parents=True, exist_ok=True)
    for name in APP_FILES:
        src = DESKTOP / name
        if not src.exists():
            return None, None, "缺少桌面资源：%s" % src
        shutil.copy2(src, app_dir / name)

    backend_dir = resources / "backend"
    backend_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(BACKEND_EXE, backend_dir / "memora-backend.exe")
    return stage, target_exe, None


def build_electron(force_manual: bool) -> tuple:
    rule("步骤 3/4 · Electron 目录打包")
    stage = DIST / ".stage"
    if stage.exists():
        shutil.rmtree(stage, ignore_errors=True)
    stage.mkdir(parents=True, exist_ok=True)

    method = "electron-builder --dir"
    reason = ""
    packaged = exe = None
    if force_manual:
        reason = "按参数指定使用降级方案"
        method = "降级方案（手工复制 electron dist）"
    else:
        packaged, exe, err = pack_with_builder(stage)
        if err:
            reason = err
            method = "降级方案（手工复制 electron dist）"
            say("[降级] electron-builder 不可用：%s" % err)
    if packaged is None:
        packaged, exe, err2 = pack_manually(stage)
        if err2:
            say("[失败] 手工打包也失败：%s" % err2)
            return None, None, method, reason
        reason = reason or "electron-builder 失败：" + str(err2)
    else:
        say("[完成] electron-builder 产出 %s" % packaged)

    # 统一收敛到 dist/MemoraCore
    if OUT_DIR.exists():
        shutil.rmtree(OUT_DIR, ignore_errors=True)
    shutil.move(str(packaged), str(OUT_DIR))
    shutil.rmtree(stage, ignore_errors=True)
    exe = OUT_DIR / exe.name if exe is not None else None
    if exe is None or not exe.exists():
        for cand in OUT_DIR.glob("*.exe"):
            if cand.name.lower() != "memora-backend.exe":
                exe = cand
                break
    say("[完成] 输出目录 %s" % OUT_DIR)
    return OUT_DIR, exe, method, reason


def verify_layout() -> tuple:
    rule("产物校验")
    problems = []
    exe = OUT_DIR / "MemoraCore.exe"
    if not exe.exists():
        cands = [p for p in OUT_DIR.glob("*.exe") if p.name.lower() != "memora-backend.exe"]
        if cands:
            exe = cands[0]
            say("  [i] 主程序名为 %s（由 electron.exe 改名）" % exe.name)
        else:
            problems.append("未找到主程序 exe")
    backend = OUT_DIR / "resources" / "backend" / "memora-backend.exe"
    app_asar = OUT_DIR / "resources" / "app.asar"
    app_dir = OUT_DIR / "resources" / "app"
    if not backend.exists():
        problems.append("缺少 resources/backend/memora-backend.exe")
    if not (app_asar.exists() or app_dir.exists()):
        problems.append("缺少 resources/app.asar 或 resources/app/")
    for item in problems:
        say("  [!] " + item)
    before = len(problems)
    locales = sorted(p.name for p in (OUT_DIR / "locales").glob("*.pak"))
    if len(locales) > 2:
        problems.append("语言包未裁剪：%d 个（应只有 zh-CN / en-US）" % len(locales))
    if exe.exists():
        say("  主程序：%s (%d 字节)" % (exe, exe.stat().st_size))
    if backend.exists():
        say("  后端  ：%s (%d 字节)" % (backend, backend.stat().st_size))
        # 读后端产物本身：不得有未声明的第三方包
        code = run([python_bin(), str(REPO / "tools" / "inspect_exe.py"), str(backend), "--check"])
        if code != 0:
            problems.append("后端 exe 里有未声明的第三方包（见上）")
    say("  app   ：%s" % ("app.asar" if app_asar.exists() else "app/ 目录（降级方案）"))
    say("  语言包：%s" % ", ".join(locales))
    # 发布前脱敏：产物里不得有构建机的用户名 / 家目录 / 仓库路径 / git 身份
    code = run([python_bin(), str(REPO / "tools" / "desensitize_scan.py"), str(OUT_DIR)])
    if code != 0:
        problems.append("脱敏扫描发现构建机身份信息（见上）")
    for item in problems[before:]:
        say("  [!] " + item)
    return exe if exe.exists() else None, len(problems) == 0


# --------------------------------------------------------------------------- #
# 4. 冒烟自检
# --------------------------------------------------------------------------- #
def run_smoke() -> int:
    rule("步骤 4/4 · 冒烟自检")
    exe = OUT_DIR / "MemoraCore.exe"
    code = run([python_bin(), str(REPO / "tools" / "smoke_desktop.py")], cwd=REPO)
    say("")
    say("[校验] 桌面主程序存在：%s -> %s" % (exe, "是" if exe.exists() else "否"))
    node = shutil.which("node")
    if node:
        chk = subprocess.run([node, "--check", str(DESKTOP / "main.cjs")],
                             stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        say("[校验] node --check desktop/main.cjs -> %s" %
            ("通过" if chk.returncode == 0 else "失败\n" + chk.stdout.decode("utf-8", "replace")))
        if chk.returncode != 0:
            return 1
    if not exe.exists():
        return 1
    return code


# --------------------------------------------------------------------------- #
def tree(root: Path, depth: int = 2) -> None:
    say("")
    say("目录树（前 %d 层）：" % depth)
    root = root.resolve()

    def walk(current: Path, level: int, prefix: str):
        try:
            entries = sorted(current.iterdir(), key=lambda p: (p.is_file(), p.name.lower()))
        except OSError:
            return
        for idx, entry in enumerate(entries):
            last = idx == len(entries) - 1
            branch = "└── " if last else "├── "
            try:
                size = entry.stat().st_size if entry.is_file() else dir_size(entry)
            except OSError:
                size = 0
            suffix = "" if entry.is_dir() else "  (%s)" % human(size)
            say("%s%s%s%s" % (prefix, branch, entry.name, suffix))
            if entry.is_dir() and level < depth:
                walk(entry, level + 1, prefix + ("    " if last else "│   "))

    say(root.name + "/")
    walk(root, 1, "")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="memora 桌面端打包总编排")
    ap.add_argument("--skip-frontend", action="store_true")
    ap.add_argument("--skip-backend", action="store_true")
    ap.add_argument("--skip-smoke", action="store_true")
    ap.add_argument("--manual", action="store_true", help="强制使用降级打包方案")
    ap.add_argument("--clean", action="store_true", help="先清理 dist/MemoraCore")
    args = ap.parse_args(argv)

    started = time.time()
    DIST.mkdir(parents=True, exist_ok=True)
    stage_out_dir(args.clean)

    if not build_frontend(args.skip_frontend):
        return 1
    if not build_backend(args.skip_backend):
        return 1

    out, exe, method, reason = build_electron(args.manual)
    if out is None:
        say("[失败] Electron 打包未产出目录")
        return 1

    main_exe, ok = verify_layout()
    if not ok:
        say("[失败] 产物结构不完整")
        return 1

    smoke_code = 0
    if args.skip_smoke:
        say("[跳过] --skip-smoke")
    else:
        smoke_code = run_smoke()

    total = dir_size(OUT_DIR)
    tree(OUT_DIR, 2)

    rule("汇总")
    say("打包方式   : %s" % method)
    if reason:
        say("降级原因   : %s" % reason)
    say("输出目录   : %s" % OUT_DIR)
    say("目录总大小 : %s (%d 字节)" % (human(total), total))
    say("主程序     : %s (%d 字节)" % (main_exe, main_exe.stat().st_size) if main_exe else "主程序     : 缺失")
    say("后端 exe   : %s" % (OUT_DIR / "resources" / "backend" / "memora-backend.exe"))
    say("耗时       : %.1fs" % (time.time() - started))
    say("冒烟自检   : %s" % ("通过" if smoke_code == 0 else "失败(%d)" % smoke_code))
    say("")
    say("运行：双击 %s" % main_exe)
    return 0 if smoke_code == 0 else smoke_code


if __name__ == "__main__":
    sys.exit(main())
