@echo off
chcp 65001 >nul
rem memora-core / 记忆中枢 - 启动器
rem 优先启动已打包的桌面应用；没有就回退到源码模式。
setlocal
cd /d "%~dp0"

if exist "dist\MemoraCore\MemoraCore.exe" (
  echo 正在启动 记忆中枢（桌面版）...
  start "" "dist\MemoraCore\MemoraCore.exe"
  timeout /t 3 >nul
  start "" http://127.0.0.1:8790
  exit /b 0
)

echo 未找到打包产物，改用源码模式启动。
where python >nul 2>nul
if errorlevel 1 (
  echo 找不到 python，请先安装 Python 3.12 或使用 dist\MemoraCore\MemoraCore.exe。
  pause
  exit /b 1
)
python -m memora_core setup
start "" http://127.0.0.1:8790
python -m memora_core serve
endlocal
