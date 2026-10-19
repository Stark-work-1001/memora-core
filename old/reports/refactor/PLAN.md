# Memora 目录重构方案（执行前固定版）

## 目标（按用户定义）
| 目录 | 唯一含义 |
| --- | --- |
| `.venv\` | 环境依赖（Python 解释器 + 已装依赖） |
| `devel\` | 开发目录：源码 + 开发工具 + 测试 + 开发文档 + Electron 外壳源码 |
| `build\` | 构建所需的原料：下载缓存、PyInstaller 工作区、构建报告、历史归档 |
| `desktop-standalone\` | 免安装、自包含、解压即用的桌面程序（**根目录直接是 Memora.exe**） |
| `data\` | 开发/测试/运行过程中产生的记忆数据库与 markdown |
| `release\` | 解压即用安装包（zip + sha256） |

## 关键判断（为什么这么改）
1. **`desktop-standalone` 必须"根目录即程序"**：现状是 `desktop-standalone\win-unpacked\Memora.exe` 且同层还躺着三份候选产物（`win-unpacked\`、`release-win-unpacked\release-win-unpacked\`、空 `desktop\`），这正是"找不到能直接用的 electron 封装版"的直接原因。
2. **Electron 外壳源码归 `devel\desktop\`**：`main.cjs`/`package.json`/启动脚本是源码（git HEAD 原本就跟踪在 `desktop/`），不属于"产物"。
3. **`node_modules` 跟着源码走**：electron-builder 的 `electronDist`、`extraResources` 都相对 app 目录解析，搬到别处会让构建配置指向计算路径，徒增脆弱性。
4. **构建原料与构建产物分开**：Electron zip（157MB）等下载物 → `build\cache\`；PyInstaller 工作区 → `build\pyinstaller\`；已验证的后端产物 → `build\dist\memora-backend\`（作为下次打包的现成输入）。
5. **删除与 `data\` 无关的重复品**：`memora-data\`（与产物 data 模板重复）、`release-win-unpacked\`（旧 main.cjs 的过期输出）、空 `desktop\`、`memora-backend\`（与产物内后端逐字节相同）。
6. **不可动的对象**：`data\`（914 条记忆 / 914 篇 markdown / 239MB 主库）——只读保留，不重命名、不清理。

## 现状证据（重构前）
- 产物树 `win-unpacked` = 271 文件，tree_sha256 `847320c426699392ef6e235a54bd78fd6ee7acbbd5cb8a42ea5edc39111c54ce`，与 `SMOKE_VALIDATION.json` 一致（版本 1.3.0，passed）。
- 后端 `memora-backend.exe` sha256 `3766e132...f13`，与 smoke 报告一致。
- 实测启动：`Memora.exe` 拉起 `memora-backend`，`/api/agent/status` 返回 200，`data_dir` 指向自身 `data\`。
- 测试基线：437 tests，4 errors（均为重构前既有的路径漂移：`.github` 与 `dist` 位置）。
