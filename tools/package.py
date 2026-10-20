#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""用 PyInstaller 把 memora_core 打成单文件后端：dist/memora-backend.exe。

    python tools/package.py                 # 完整打包
    python tools/package.py --icon-only     # 只生成 desktop/icon.png 与 ico
    python tools/package.py --clean         # 先清空中间产物

图标完全由本脚本用纯标准库（zlib + struct）程序化生成，不下载任何外部素材。
"""
from __future__ import annotations

import argparse
import math
import os
import shutil
import struct
import subprocess
import sys
import time
import zlib
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DIST = REPO / "dist"
BUILD = DIST / ".build"
ENTRY = REPO / "tools" / "entry_backend.py"
APP_NAME = "memora-backend"
ICON_PNG = REPO / "desktop" / "icon.png"
ICON_ICO = BUILD / "memora-backend.ico"
ICO_SIZES = (16, 24, 32, 48, 64, 128, 256)


# --------------------------------------------------------------------------- #
# 极小的软件光栅器：程序化生成图标（无 Pillow 依赖）
# --------------------------------------------------------------------------- #
def _lerp(a, b, t):
    return a + (b - a) * t


def _mix(c1, c2, t):
    return (_lerp(c1[0], c2[0], t), _lerp(c1[1], c2[1], t), _lerp(c1[2], c2[2], t))


def _clamp01(x):
    return 0.0 if x < 0.0 else (1.0 if x > 1.0 else x)


def _smoothstep(edge0, edge1, x):
    if edge1 == edge0:
        return 0.0
    t = _clamp01((x - edge0) / (edge1 - edge0))
    return t * t * (3.0 - 2.0 * t)


def _sd_round_rect(px, py, cx, cy, hw, hh, radius):
    qx = abs(px - cx) - (hw - radius)
    qy = abs(py - cy) - (hh - radius)
    ax, ay = max(qx, 0.0), max(qy, 0.0)
    return math.hypot(ax, ay) + min(max(qx, qy), 0.0) - radius


def _sd_segment(px, py, ax, ay, bx, by):
    vx, vy = bx - ax, by - ay
    wx, wy = px - ax, py - ay
    denom = vx * vx + vy * vy
    t = 0.0 if denom == 0 else _clamp01((wx * vx + wy * vy) / denom)
    return math.hypot(wx - vx * t, wy - vy * t)


BG_TOP = (17.0, 24.0, 34.0)
BG_BOTTOM = (7.0, 10.0, 15.0)
CYAN = (56.0, 225.0, 255.0)
VIOLET = (124.0, 92.0, 255.0)
CORE_WHITE = (236.0, 252.0, 255.0)

NODES = [
    (0.0, CYAN),
    (60.0, _mix(CYAN, VIOLET, 0.35)),
    (120.0, _mix(CYAN, VIOLET, 0.7)),
    (180.0, VIOLET),
    (240.0, _mix(VIOLET, CYAN, 0.5)),
    (300.0, _mix(CYAN, VIOLET, 0.2)),
]


def _shade(px, py):
    """返回归一化坐标下某点的 (r, g, b, a)。"""
    # 背景圆角方块
    d = _sd_round_rect(px, py, 0.5, 0.5, 0.5, 0.5, 0.225)
    bg_a = _smoothstep(0.0016, -0.0016, d)
    if bg_a <= 0.0:
        return (0.0, 0.0, 0.0, 0.0)
    col = _mix(BG_TOP, BG_BOTTOM, _clamp01(py))
    # 轻微径向提亮
    glow = math.hypot(px - 0.5, py - 0.42)
    col = _mix(col, (26.0, 46.0, 62.0), _smoothstep(0.62, 0.06, glow) * 0.55)

    # 旋转的角度色
    ang = math.atan2(py - 0.5, px - 0.5)
    t = (ang / (2.0 * math.pi) + 1.25) % 1.0
    ring_col = _mix(CYAN, VIOLET, t)

    # 辐条
    for deg, _c in NODES:
        a = math.radians(deg)
        ax, ay = 0.5 + math.cos(a) * 0.115, 0.5 + math.sin(a) * 0.115
        bx, by = 0.5 + math.cos(a) * 0.285, 0.5 + math.sin(a) * 0.285
        dseg = _sd_segment(px, py, ax, ay, bx, by)
        m = _smoothstep(0.0125, 0.005, dseg)
        col = _mix(col, ring_col, m * 0.42)

    # 外环
    dr = abs(math.hypot(px - 0.5, py - 0.5) - 0.318)
    m = _smoothstep(0.019, 0.006, dr)
    col = _mix(col, ring_col, m * 0.95)

    # 内环
    dr2 = abs(math.hypot(px - 0.5, py - 0.5) - 0.175)
    m2 = _smoothstep(0.010, 0.003, dr2)
    col = _mix(col, _mix(CYAN, VIOLET, 0.5), m2 * 0.55)

    # 轨道节点
    for deg, ncol in NODES:
        a = math.radians(deg)
        nx, ny = 0.5 + math.cos(a) * 0.318, 0.5 + math.sin(a) * 0.318
        dn = math.hypot(px - nx, py - ny)
        mn = _smoothstep(0.040, 0.028, dn)
        col = _mix(col, _mix(ncol, (255.0, 255.0, 255.0), 0.25), mn)

    # 核心
    dc = math.hypot(px - 0.5, py - 0.5)
    core = _smoothstep(0.108, 0.096, dc)
    if core > 0.0:
        k = _clamp01(dc / 0.108)
        col = _mix(col, _mix(CORE_WHITE, _mix(CYAN, VIOLET, 0.55), k * k), core)
    halo = _smoothstep(0.24, 0.10, dc) * (1.0 - core)
    col = _mix(col, _mix(CYAN, VIOLET, 0.4), halo * 0.16)

    return (col[0], col[1], col[2], bg_a * 255.0)


def _render_rgba(size: int, samples: int = 3) -> bytes:
    rows = []
    step = 1.0 / size
    off = step / (samples * 2)
    for y in range(size):
        row = bytearray()
        for x in range(size):
            r = g = b = a = 0.0
            for sy in range(samples):
                for sx in range(samples):
                    px = (x + (sx * 2 + 1) * (step / (samples * 2))) if False else (x + (sx + 0.5) / samples) * step
                    py = (y + (sy + 0.5) / samples) * step
                    cr, cg, cb, ca = _shade(px, py)
                    r += cr * ca
                    g += cg * ca
                    b += cb * ca
                    a += ca
            n = samples * samples
            if a <= 0.0:
                row += bytes((0, 0, 0, 0))
            else:
                row += bytes((min(255, int(r / a + 0.5)), min(255, int(g / a + 0.5)),
                              min(255, int(b / a + 0.5)), min(255, int(a / n + 0.5))))
        rows.append(bytes(row))
    return b"".join(rows)


def _png_bytes(size: int, raw: bytes) -> bytes:
    def chunk(tag: bytes, data: bytes) -> bytes:
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    stride = size * 4
    scanlines = b"".join(b"\x00" + raw[i * stride:(i + 1) * stride] for i in range(size))
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(scanlines, 9)) + chunk(b"IEND", b""))


def _ico_bytes(sizes=ICO_SIZES) -> bytes:
    """32bpp BMP 条目组成的 ICO（PyInstaller/Windows 都直接认）。"""
    blobs = []
    for size in sizes:
        raw = _render_rgba(size)
        # 行翻转：BMP 自下而上
        pixels = bytearray()
        stride = size * 4
        for y in range(size - 1, -1, -1):
            line = raw[y * stride:(y + 1) * stride]
            for i in range(0, len(line), 4):
                pixels += bytes((line[i + 2], line[i + 1], line[i], line[i + 3]))
        mask_stride = ((size + 31) // 32) * 4
        mask = bytes(mask_stride * size)
        header = struct.pack("<IiiHHIIiiII", 40, size, size * 2, 1, 32, 0,
                             len(pixels) + len(mask), 0, 0, 0, 0)
        blobs.append(bytes(header) + bytes(pixels) + mask)

    out = bytearray(struct.pack("<HHH", 0, 1, len(sizes)))
    offset = 6 + 16 * len(sizes)
    for size, blob in zip(sizes, blobs):
        dim = 0 if size >= 256 else size
        out += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(blob), offset)
        offset += len(blob)
    for blob in blobs:
        out += blob
    return bytes(out)


def ensure_icon(force: bool = False) -> Path:
    ICON_PNG.parent.mkdir(parents=True, exist_ok=True)
    if force or not ICON_PNG.exists() or ICON_PNG.stat().st_size < 1024:
        started = time.time()
        ICON_PNG.write_bytes(_png_bytes(256, _render_rgba(256)))
        print("[icon] 已生成 %s (%d 字节, %.1fs)"
              % (ICON_PNG, ICON_PNG.stat().st_size, time.time() - started))
    else:
        print("[icon] 复用已有 %s (%d 字节)" % (ICON_PNG, ICON_PNG.stat().st_size))
    BUILD.mkdir(parents=True, exist_ok=True)
    if force or not ICON_ICO.exists() or ICON_ICO.stat().st_size < 1024:
        ICON_ICO.write_bytes(_ico_bytes())
        print("[icon] 已生成 %s (%d 字节)" % (ICON_ICO, ICON_ICO.stat().st_size))
    return ICON_PNG


# --------------------------------------------------------------------------- #
# PyInstaller
# --------------------------------------------------------------------------- #
# 冻结时排除的包。它们是 pypdf 的**可选**附加依赖（图像、字体），memora 用不到。1.0.0 的构建环境里
# 恰好装着它们，PyInstaller 顺着可选导入把 numpy（含 20 MB OpenBLAS）、Pillow、fontTools 全打进了
# 后端：约占负载的 46%，而 THIRD-PARTY.md 写的是"后端没有第三方运行时依赖"。
EXCLUDED_MODULES = ("numpy", "PIL", "fontTools", "cryptography", "Crypto", "tkinter",
                    "IPython", "matplotlib", "pandas", "scipy")


def package(clean: bool = False) -> int:
    ensure_icon()
    if not ENTRY.exists():
        print("[错误] 缺少入口脚本 %s" % ENTRY, file=sys.stderr)
        return 2
    data_dir = REPO / "memora_core" / "data"
    static_dir = REPO / "memora_core" / "static"
    if not (data_dir / "schema.sql").exists():
        print("[错误] 缺少 memora_core/data/schema.sql", file=sys.stderr)
        return 2

    if clean and BUILD.exists():
        shutil.rmtree(BUILD, ignore_errors=True)
    DIST.mkdir(parents=True, exist_ok=True)
    (BUILD / "pyinstaller").mkdir(parents=True, exist_ok=True)

    exe = DIST / (APP_NAME + ".exe")
    if exe.exists():
        try:
            exe.unlink()
        except OSError as exc:
            print("[警告] 无法删除旧 exe：%s" % exc, file=sys.stderr)

    cmd = [
        sys.executable, "-m", "PyInstaller",
        "--noconfirm", "--clean", "--onefile", "--noconsole",
        "--name", APP_NAME,
        "--distpath", str(DIST),
        "--workpath", str(BUILD / "pyinstaller"),
        "--specpath", str(BUILD),
        "--paths", str(REPO),
        "--collect-submodules", "memora_core",
        "--add-data", "%s%s%s" % (data_dir, os.pathsep, "memora_core/data"),
        # 前端产物（index.html / app.js / app.css / brain.js / katex.css）必须打进 exe，
        # 否则 server.py 的静态托管会在打包版里 404 —— 这是"源码能跑、exe 白屏"的经典坑。
        "--add-data", "%s%s%s" % (static_dir, os.pathsep, "memora_core/static"),
    ]
    for module in EXCLUDED_MODULES:
        cmd += ["--exclude-module", module]
    try:
        import pypdf  # noqa: F401,PLC0415
        print("[信息] 构建环境有 pypdf %s：桌面版包含 PDF 吸收" % getattr(pypdf, "__version__", "?"))
    except ImportError:
        print("[信息] 构建环境没有 pypdf：桌面版的 PDF 吸收会明确报错（见 tools/requirements-desktop.txt）")
    if ICON_ICO.exists():
        cmd += ["--icon", str(ICON_ICO)]
    cmd.append(str(ENTRY))

    print("[pyinstaller] " + " ".join(cmd))
    started = time.time()
    proc = subprocess.run(cmd, cwd=str(REPO))
    if proc.returncode != 0:
        print("[错误] PyInstaller 失败，返回码 %d" % proc.returncode, file=sys.stderr)
        return proc.returncode
    elapsed = time.time() - started
    if not exe.exists():
        print("[错误] 未找到产物 %s" % exe, file=sys.stderr)
        return 1
    size = exe.stat().st_size
    print("[完成] %s" % exe)
    print("[完成] 字节数 = %d (%.1f MB)  用时 %.1fs" % (size, size / 1048576.0, elapsed))
    print("[完成] 数据资源已内嵌：memora_core/data (schema.sql + builtin/*.json)")
    # 读产物本身，确认没有未声明的第三方包被顺带打进去
    sys.path.insert(0, str(REPO / "tools"))
    import inspect_exe  # noqa: PLC0415
    return inspect_exe.main([str(exe), "--check"])


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="打包 memora 后端为单文件 exe")
    ap.add_argument("--clean", action="store_true", help="先清理中间产物")
    ap.add_argument("--icon-only", action="store_true", help="只生成图标")
    ap.add_argument("--force-icon", action="store_true", help="强制重绘图标")
    args = ap.parse_args(argv)
    if args.force_icon:
        ensure_icon(force=True)
    if args.icon_only:
        ensure_icon()
        return 0
    return package(clean=args.clean)


if __name__ == "__main__":
    sys.exit(main())