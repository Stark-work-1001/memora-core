# Memora 目录布局规格（重构后唯一权威定义）

项目根：`<项目根>\`

## 1. 六个顶层目录的职责

| 路径 | 职责 | 是否可重建 | 是否纳入 git |
| --- | --- | --- | --- |
| `.venv\` | Python 环境依赖（解释器 + 已装包） | 可（pip） | 否 |
| `devel\` | 开发目录：全部源码、开发工具、测试、开发文档、Electron 外壳源码 | 否（原始资产） | **是** |
| `build\` | 构建原料 + 构建中间产物 + 构建证据 | 可 | 否 |
| `desktop-standalone\` | 免安装、自包含、解压即用的桌面程序（根目录就是 `Memora.exe`） | 可 | 否 |
| `data\` | 开发/测试/运行产生的记忆数据库与 markdown（用户真实数据） | **否** | 否 |
| `release\` | 解压即用安装包（zip + sha256 + 交付说明） | 可 | 否 |

## 2. `devel\` 内部结构

```
devel\
├── memora\               Python 包源码（含 static\ 前端资产）
├── memory_merge\         memory_merge 包源码
├── native\               Rust 向量内核源码
├── frontend\             前端 TypeScript 源码 + vendor + node_modules
├── desktop\              Electron 外壳源码（main.cjs / package.json / 启动与修复脚本）
├── tests\                单元与集成测试
├── tools\                构建、发布、校验、集成脚本
├── docs\                 开发文档
├── bench\  datasets\     基准与数据集
├── deployment\           模型服务部署脚本
├── integrations\         对外集成样例与 DSH 适配器源码
├── LICENSES\ .github\    合规与 CI
├── pyproject.toml  README*  CHANGELOG.md  LICENSE  NOTICE  ...
├── dev-serve.ps1         源码模式启动（热改可见）
├── start-memora.ps1      本地开发运行时 + 桌面壳启动
├── Start-Memora.cmd
├── runtime\              开发运行时状态（active.json / 日志 / tmp / userdata）  [gitignore]
└── artifacts\            开发期验证产物（截图、报告、历史快照）              [gitignore]
```

## 3. `build\` 内部结构

```
build\
├── cache\            下载的原始原料（Electron 官方 zip、gh、llama 源码、electron-builder 缓存）
├── pyinstaller\      PyInstaller 工作区（workpath + memora-backend.spec）
├── dist\             已构建的后端 onedir（memora-backend\），是 Electron 打包的 extraResources 输入
├── reports\          构建与验证证据（SMOKE_VALIDATION.json、基线、报告、legacy 1.0.x 证据）
└── archive\          不参与构建的冻结历史快照（1.0.1 私有→公开快照）
```

## 4. `desktop-standalone\` 内部结构（产物，不是源码）

```
desktop-standalone\
├── Memora.exe                       Electron 外壳（245 MB）
├── resources\
│   ├── app.asar                     外壳代码（main.cjs + package.json 打包）
│   └── backend\                     冻结后端（memora-backend.exe + _internal + docs + LICENSES）
├── data\                            本程序自带数据目录（空 schema 模板 + markdown\ + memora.json={}）
├── locales\  *.dll  *.pak  *.bin      Electron 运行时
├── Launch-Memora.cmd / .ps1          便携启动器（含 Web 回退、-Stop 只停自己）
├── Repair-Desktop.cmd / .ps1         只修复完整性标签，不动 ACL、不关沙箱
├── 使用说明.md / DESKTOP_GUIDE.md
└── runtime\                           首次运行时由启动器创建（便携宿主记录）——不属于构建产物
```

## 5. 路径约定（代码必须遵守）

脚本内一律用两个锚点，不要用 `parents[N]` 猜层级：

```python
# devel/tools/*.py
DEVEL   = Path(__file__).resolve().parents[1]      # devel
PROJECT = DEVEL.parent                              # 项目根
```
```powershell
# devel/tools/*.ps1 与 devel/*.ps1
$develDir   = Split-Path -Parent $PSScriptRoot   # tools 脚本取 devel；devel 下的脚本直接 $PSScriptRoot
$projectDir = Split-Path -Parent $develDir        # 项目根
```

- 源码路径：`DEVEL/memora`、`DEVEL/frontend`、`DEVEL/docs`、`DEVEL/tests`、`DEVEL/desktop`
- 环境路径：`PROJECT/.venv/Scripts/python.exe`
- 构建路径：`PROJECT/build/pyinstaller`、`PROJECT/build/dist`、`PROJECT/build/cache`、`PROJECT/build/reports`
- 产物路径：`PROJECT/desktop-standalone`
- 数据路径：`PROJECT/data`
- 发布路径：`PROJECT/release`

## 6. Electron 外壳的两条解析路径

- **打包态**（`app.isPackaged`）：数据目录 = `dirname(process.execPath)/data`；后端 = `process.resourcesPath/backend/memora-backend.exe`。
- **源码态**（`electron devel/desktop`）：项目根由「向上找 `devel/pyproject.toml` + `devel/memora/core.py`」确定；数据 = `<根>/data`；运行时 = `<根>/devel/runtime`；解释器 = `<根>/.venv/Scripts/python.exe`。

## 7. 不变量（重构不得破坏）

1. `desktop-standalone` 的 271 个文件内容与 smoke 报告记录的 `artifact_tree_sha256` 一致。
2. `resources\backend\memora-backend.exe` 的 sha256 = `3766e1325b9d9520e91f5643cd7a9fab0fcd788303a3aa11e71a1031f7f5df13`。
3. `data\` 内的数据库与 markdown 一个字节都不改。
4. `.venv` 的 editable 安装指向 `devel`（`memora` 与 `memory_merge` 均可 import）。
5. `Memora.exe` 双击后能拉起自带后端并显示工作台。
