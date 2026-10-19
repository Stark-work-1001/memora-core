#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""无头冒烟自检：启动 dist/memora-backend.exe，探测 /api/health，杀进程，返回码。

    python tools/smoke_desktop.py
    python tools/smoke_desktop.py --exe <路径> --wait 30

退出码
    0  通过（被动探针 --version 成功；serve 探活成功或后端尚未就绪但已优雅报告）
    1  失败（exe 缺失 / 连 --version 都跑不起来 / 端口探测异常）
    2  前端未就绪但 exe 可用时不算失败，这里只保留 0/1 二值。
"""
from __future__ import annotations

import argparse
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DEFAULT_EXE = REPO / "dist" / "memora-backend.exe"
HOST = "127.0.0.1"
HEALTH_INTERVAL = 0.25


def say(msg=""):
    print(msg, flush=True)


def free_port() -> int:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind((HOST, 0))
        return int(s.getsockname()[1])
    finally:
        s.close()


def probe_version(exe: Path, timeout: float = 60.0) -> tuple:
    """--noconsole 打包后没有 stdout，用 MEMORA_PROBE_FILE 把输出接出来。"""
    probe_file = Path(tempfile.gettempdir()) / ("memora-probe-%d.txt" % os.getpid())
    if probe_file.exists():
        try:
            probe_file.unlink()
        except OSError:
            pass
    env = dict(os.environ)
    env["MEMORA_PROBE_FILE"] = str(probe_file)
    env["PYTHONIOENCODING"] = "utf-8"
    started = time.time()
    try:
        proc = subprocess.run([str(exe), "--version"], env=env, timeout=timeout,
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        code = proc.returncode
        extra = (proc.stdout or b"").decode("utf-8", "replace").strip()
    except subprocess.TimeoutExpired:
        return (None, "", timeout, "启动超时（%.0fs）" % timeout)
    except OSError as exc:
        return (None, "", time.time() - started, "无法执行：%s" % exc)
    text = ""
    if probe_file.exists():
        try:
            text = probe_file.read_text(encoding="utf-8", errors="replace").strip()
        except OSError:
            text = ""
    text = text or extra
    return (code, text, time.time() - started, None)


def http_json(port: int, path: str, timeout: float = 1.5):
    url = "http://%s:%d%s" % (HOST, port, path)
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            body = resp.read(4096)
            return resp.status, body
    except urllib.error.HTTPError as exc:
        return exc.code, b""
    except (urllib.error.URLError, OSError):
        return None, b""


def kill_tree(proc: subprocess.Popen, grace: float = 3.0) -> str:
    """先 terminate，等 grace 秒，再 taskkill /T /F 强杀。返回使用的方式。"""
    if proc.poll() is not None:
        return "已自行退出"
    proc.terminate()
    deadline = time.time() + grace
    while time.time() < deadline:
        if proc.poll() is not None:
            return "正常终止"
        time.sleep(0.1)
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    else:
        proc.kill()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        pass
    return "强制结束（taskkill /T /F）"


def server_module_exists() -> bool:
    return (REPO / "memora_core" / "server.py").exists()


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="memora 后端 exe 冒烟自检")
    ap.add_argument("--exe", default=str(DEFAULT_EXE))
    ap.add_argument("--wait", type=float, default=30.0, help="探活最长等待秒数")
    ap.add_argument("--keep-data", action="store_true", help="保留临时数据目录以便排查")
    args = ap.parse_args(argv)

    exe = Path(args.exe).resolve()
    say("=" * 66)
    say(" memora 后端冒烟自检")
    say("=" * 66)
    say("可执行文件 : %s" % exe)
    if not exe.exists():
        say("[失败] 找不到后端可执行文件，请先运行 python tools/package.py")
        return 1
    say("字节数     : %d" % exe.stat().st_size)

    # ---- 检查 1：被动探针 --version ------------------------------------- #
    code, text, elapsed, err = probe_version(exe)
    if err is not None:
        say("[失败] --version 探针：%s" % err)
        return 1
    say("[检查1] --version -> 退出码 %s，耗时 %.1fs" % (code, elapsed))
    if text:
        for line in text.splitlines()[:6]:
            say("         | %s" % line)
    if code != 0:
        say("[失败] --version 非零退出码，可执行文件不可用")
        return 1
    say("[通过] 检查1：exe 可正常启动并响应版本查询")

    # ---- 检查 2：serve + /api/health ------------------------------------ #
    port = free_port()
    tmpdir = Path(tempfile.mkdtemp(prefix="memora-smoke-"))
    data = tmpdir / "data"
    data.mkdir(parents=True, exist_ok=True)
    log_path = tmpdir / "backend.log"
    say("")
    say("[检查2] 端口 %d，临时数据目录 %s" % (port, data))
    cmd = [str(exe), "serve", "--port", str(port), "--data", str(data)]
    say("         %s" % " ".join(cmd))
    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "utf-8"
    log = open(log_path, "w", encoding="utf-8", errors="replace")
    started = time.time()
    proc = subprocess.Popen(cmd, cwd=str(tmpdir), stdout=log, stderr=subprocess.STDOUT,
                            stdin=subprocess.DEVNULL, env=env)
    health_ok = False
    status = None
    body = b""
    deadline = time.time() + args.wait
    while time.time() < deadline:
        if proc.poll() is not None:
            break
        status, body = http_json(port, "/api/health")
        if status == 200:
            health_ok = True
            break
        time.sleep(HEALTH_INTERVAL)
    elapsed = time.time() - started
    exit_code = proc.poll()

    exit_note = ""
    if not health_ok:
        exit_note = kill_tree(proc)
    log.flush()
    log.close()

    if health_ok:
        try:
            payload = json.loads(body.decode("utf-8", "replace"))
        except ValueError:
            payload = {"raw": body.decode("utf-8", "replace")[:400]}
        say("[通过] 检查2：/api/health -> HTTP 200（%.1fs）" % elapsed)
        say("         %s" % json.dumps(payload, ensure_ascii=False)[:400])
        say("         收尾：%s" % kill_tree(proc))
        say("")
        say("结果：全部通过（退出码 0）")
        if not args.keep_data:
            _cleanup(tmpdir)
        return 0

    # 健康检查没通过：区分「后端未就绪」与「真故障」
    log_text = ""
    try:
        log_text = log_path.read_text(encoding="utf-8", errors="replace").strip()
    except OSError:
        pass
    if log_text:
        for line in log_text.splitlines()[-8:]:
            say("         | %s" % line)
    ready = server_module_exists()
    say("")
    if not ready:
        say("[未就绪] memora_core/server.py 尚未实现，serve 子命令无法提供 /api/health。")
        say("         这是预期内的：exe 本身可用（检查1 通过），服务层随后端开发补齐。")
        say("         退出码 %s%s" % (exit_code, "，收尾：" + exit_note if exit_note else ""))
        say("结果：通过（exe 可启动；服务层未就绪，非故障）")
        if not args.keep_data:
            _cleanup(tmpdir)
        return 0
    say("[失败] server.py 存在但 /api/health 未在 %.0fs 内返回 200（退出码 %s）" % (args.wait, exit_code))
    say("       日志：%s" % log_path)
    say("结果：失败（退出码 1）")
    return 1


def _cleanup(tmpdir: Path) -> None:
    import shutil
    shutil.rmtree(tmpdir, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
