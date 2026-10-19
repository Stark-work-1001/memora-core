# memora-core 桌面外壳（Electron + PyInstaller）

把记忆中枢打包成**一个可双击运行的 Windows 程序**：Electron 负责窗口/托盘/单实例/生命周期，
Python 后端由 PyInstaller 打成单个 exe，由外壳拉起并探活。用户**不需要安装 Python**。

## 目录结构

    desktop/
      package.json     Electron 元数据 + electron-builder 配置
      main.cjs         主进程：单实例锁、窗口、托盘、后端拉起/探活/退出
      preload.cjs      最小暴露面（版本、平台、开发者工具、重启后端）
      splash.html      启动画面（内联样式，显示实时状态）
      error.html       后端启动失败页（日志路径、重试按钮）
      icon.png         256×256 图标（纯标准库程序化生成）
    tools/
      entry_backend.py PyInstaller 入口（包装 memora_core 命令行）
      package.py       后端打包：PyInstaller → dist/memora-backend.exe
      build_desktop.py 总编排：前端 → PyInstaller → Electron → 冒烟
      smoke_desktop.py 无头冒烟：启动 exe、探测 /api/health、杀进程

## 打包

前置条件（首次需要联网安装一次）：

    cd desktop && npm install        # electron 44.7.2 + electron-builder 26.0.12
    cd .. && python -m pip install pyinstaller

打包命令：

    python tools/package.py          # 只打后端 exe
    python tools/build_desktop.py    # 全流程，产出 dist/MemoraCore/

工具链位置可用环境变量覆盖：`MEMORA_ELECTRON_HOME`（electron 安装目录）、
`MEMORA_ELECTRON_CACHE`（electron dist 缓存）、`MEMORA_VENV`（打包用 Python 解释器）。

`build_desktop.py` 的选项：`--skip-frontend` / `--skip-backend` / `--skip-smoke` / `--manual` / `--clean`。

产物：

    dist/memora-backend.exe                  单文件后端（约 10 MB）
    dist/MemoraCore/MemoraCore.exe           主程序
    dist/MemoraCore/resources/app.asar       Electron 应用（asar）
    dist/MemoraCore/resources/backend/       memora-backend.exe

整个 `dist/MemoraCore/` 是绿色目录，复制走即可运行。

### 两种打包路径

1. **electron-builder --dir（默认）**：`electronDist` 直接指向已解压的 Electron 44.7.2，
   `asar:true`，`extraResources` 把后端 exe 放进 `resources/backend/`。
2. **降级方案（自动）**：builder 失败时，手工复制 electron dist、把 `electron.exe` 改名为
   `MemoraCore.exe`、应用文件放进 `resources/app/`、后端放进 `resources/backend/`。

脚本会打印最终用了哪条路径以及降级原因。

> 已知限制：部分 Windows 环境下 app-builder 改写 exe 资源会失败，因此配置了
> `win.signAndEditExecutable=false`。代价是 `MemoraCore.exe` 保留 Electron 默认文件图标；
> 运行期的窗口图标与托盘图标不受影响（来自 `icon.png`）。

## 运行

双击 `dist/MemoraCore/MemoraCore.exe`。启动流程：

1. 单实例锁（`requestSingleInstanceLock`）；已有实例时聚焦旧窗口并退出。
2. 显示启动画面，选端口（默认 8790，被占用就换随机空闲端口）。
3. 拉起后端：
   - 生产：`resources/backend/memora-backend.exe serve --port N --data <userData>/data`
   - 开发：`python -m memora_core --data <仓库>/data serve --port N`（cwd=仓库根）
4. 轮询 `http://127.0.0.1:N/api/health`（250ms 一次，最长 60s），成功后才显示主窗口。
5. 后端意外退出会自动重启一次；第二次仍失败则显示 `error.html`。

窗口 1440×900（最小 1180×760），背景 `#0b0f14`，`show:false` 直到就绪，
`contextIsolation:true` / `nodeIntegration:false`。

### 数据与日志位置

| 内容 | 生产 | 开发 |
|---|---|---|
| 数据目录 | `%APPDATA%\MemoraCore\data` | `<仓库>/data` |
| 日志 | `%APPDATA%\MemoraCore\logsackend.log` | 同左 |
| 文档 | `<数据目录>/vault` | 同左 |

可用环境变量覆盖：`MEMORA_HOME`（数据目录）、`MEMORA_PORT`（首选端口）、
`MEMORA_PYTHON`（开发模式解释器）、`MEMORA_BACKEND_EXE`（替换后端可执行文件）。

## 托盘与菜单

- **托盘**：显示/隐藏窗口、打开数据目录、打开日志、重启后端、退出。
- **文件**：显示主窗口、打开数据目录、打开日志文件、重启后端、退出。
- **视图**：重新加载、强制重新加载、开发者工具、缩放、全屏。
- **帮助**：打开文档目录、复制 MCP 配置、关于。

关闭窗口只是隐藏到托盘；真正退出走「文件 → 退出」或托盘「退出」，
`before-quit` 会先优雅结束后端，超时 3s 后强杀整棵进程树。

## 自检

    python tools/smoke_desktop.py     # 后端 exe：--version 探针 + /api/health
    node --check desktop/main.cjs     # 主进程语法

`smoke_desktop.py` 在后端服务层尚未就绪（`memora_core/server.py` 未实现）时不会报错，
而是如实打印「后端未就绪」，并以 `--version` 探针通过作为 exe 可用的证据。

## MCP 接入

「帮助 → 复制 MCP 配置」会把下面的 JSON 写入剪贴板，粘贴到客户端的 `mcpServers` 即可：

    {"mcpServers":{"memora":{
      "command":"...resources/backend/memora-backend.exe",
      "args":["--data","...data","mcp-stdio"],
      "env":{"MEMORA_HOME":"...data"}}}}
