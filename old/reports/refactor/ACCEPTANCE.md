# Memora 目录重构 — 验收报告

日期：2026-10-18
项目根：`<项目根>`
版本：应用 1.3.0 / 原生内核 1.0.2 / 记忆 schema 2

---

## 一、问题陈述

重构前，项目根是一个平铺的混合目录：源码、构建中间产物、三份同名桌面程序、测试数据、
验证截图、历史快照全部混在一起。直接后果：

1. **找不到可以直接用的 electron 封装版**。同一份构建存在三个位置：
   - `desktop-standalone\win-unpacked\`（真正在用的那个）
   - `desktop-standalone\release-win-unpacked\release-win-unpacked\`（旧壳，app.asar 里的 main.cjs 是 3635 字节的旧版）
   - `desktop-standalone\desktop\`（空目录）
   三者同名、同为 404 MB 级别，没有哪一个是"显然该双击的"。
2. 源码在根目录，`data\`（914 条真实记忆 / 914 篇 markdown / 23.9 MB 主库）与源码平级，
   没有"这是用户数据、那是代码"的边界。
3. 构建原料散落：Electron zip 在 `devel\artifacts\cache`，PyInstaller 工作区在 `build\`，
   后端产物在 `dist\`，同一个"构建"概念分裂成三个位置。
4. 迁移后 `.venv` 的 editable 安装、DSH profile、全部脚本仍指向旧路径。

## 二、重构后的结构（六个顶层目录）

| 目录 | 职责 | 大小 |
| --- | --- | --- |
| `.venv\` | Python 环境依赖 | 105 MB / 7,030 文件 |
| `devel\` | 开发目录：全部源码、测试、工具、文档、Electron 外壳源码 | 1.1 GB / 11,645 文件 |
| `build\` | 构建原料 + 中间产物 + 验证证据 + 历史归档 | 393 MB / 1,211 文件 |
| `desktop-standalone\` | **免安装自包含桌面程序，根目录就是 `Memora.exe`** | 405 MB / 320 文件 |
| `data\` | 记忆数据库与 markdown（真实数据） | 53 MB / 1,485 文件 |
| `release\` | 解压即用安装包 | 1.0 GB / 14 文件 |

根目录另有 `README.md`（导航，回答"我在哪、该点哪个"）与 `.git`。

`devel\` 内部保留完整源码树形态（`memora/`、`tests/`、`tools/`、`docs/`、`desktop/` …），
因此所有既有的相对路径写法与工具链习惯不变。

### 为什么源码在 `devel/` 而不是根目录

根目录只回答"这是哪一类东西"。源码是其中一类，放进 `devel/`。这样：

- `desktop-standalone\Memora.exe` 成为唯一可执行入口，不会被源码目录稀释；
- `data\` 与 `devel\` 平级，**删代码不会删数据，备份数据不用绕代码目录**；
- 六个目录名本身就是导航，不需要读文档也知道去哪找。

## 三、关键修复

### 1. 产物扁平化（解决"找不到可运行程序"）

`electron-builder` 只能输出到 `<output>\win-unpacked\`。重构时把 `win-unpacked\` 的内容上提一层，
并在 `build_desktop.py::flatten_product()` 中固化这个行为——**下次构建也会自动扁平化**，
不会重新长出嵌套目录。同时删除旧壳输出、空输出目录、以及产物内与模板逐字节相同的第二份
`memora-data\`。

验证：产物树 271 个文件，`tree_sha256 = 847320c4…c54ce`，与重构前的 `SMOKE_VALIDATION.json`
记录值逐字节一致——**搬动过程零改动**。

### 2. 源码路径修复（最危险的一个）

`memora/config.py::default_data_dir()` 原按 `parents[1]` 找项目根的 `data\`。源码下沉一层后，
`parents[1]` 变成 `devel\`，该目录下没有 `data\`，函数**静默回退到 `%LOCALAPPDATA%\memora`**——
即打开一个空库。对记忆产品而言这与"数据丢失"无法区分。

修复为 `parents[2]`，并加注释锁定它假设的层级。验证（从不相关目录执行）：

```
$ cd <project root>
$ <项目根>\.venv\Scripts\python.exe -c "from memora.config import default_data_dir; print(default_data_dir())"
<数据目录>
```

`memora health` 显示 914 条记忆、schema 2、integrity ok。

### 3. 构建流水线重指向

全部脚本改用两个锚点（`DEVEL = parents[1]`、`PROJECT = DEVEL.parent`），不再数目录层级：

| 脚本 | 关键变化 |
| --- | --- |
| `tools/build_desktop.py` | 源码读 `devel/`；中间产物 `build/{pyinstaller,dist,cache}`；产物写 `desktop-standalone/`；新增 `flatten_product()` |
| `tools/smoke_desktop.py` | 产物路径 `desktop-standalone/`；报告写 `build/reports/`；**修正了"排除高级模块"这个已过期的断言**（现在是全量构建，改为断言"所有已暂存模块都进了 PYZ"） |
| `tools/release.py` | 打包到 `release/`；报告读 `build/reports/` |
| `tools/fetch_electron.py` | 缓存 `build/cache/`；Electron 包在 `devel/desktop/node_modules/` |
| `tools/runtime_manager.py` | 运行时状态 `devel/runtime/`；数据 `<root>/data`；解释器 `<root>/.venv` |
| `tools/install_dsh.py` | 适配器/备份/生成物在 `devel/runtime|artifacts/`；数据与解释器在根 |
| `devel/desktop/package.json` | `output: ../../desktop-standalone`；`extraResources: ../../build/dist/memora-backend` |
| `Build-Desktop.ps1`、`dev-serve.ps1`、`start-memora.ps1`、`Install-Dsh.ps1` | 显式 `$develDir` / `$projectDir` 双锚点 |

### 4. DSH 集成重指向

`devel\integrations\dsh\Install-Dsh.ps1` 重新执行后，profile 中的托管块变为新路径
（`devel/runtime/tmp`、`devel/runtime/dsh/adapters/…`、`devel/start-memora.ps1`），
`MEMORA_RUNTIME_VERSION` 从 1.1.0 更新为 1.3.0。原 profile 已备份为
`cordis.patch.yml.bak-layout-20261018-090219`。

MCP stdio 实测：0.5 秒启动，22 个工具全部就位。

## 四、验收证据

### 自动验收：43 项检查全部通过
`build\reports\refactor\acceptance.py` 是一个独立的验收脚本——它不导入项目工具来做关键判断，
而是自己从文件系统与 zip 重新推导，逐条打印 PASS/FAIL 与实测值。

```
43 checks, 0 failed
```

覆盖：六个顶层目录的精确集合、产物根即程序、无嵌套/重复产物、产物树哈希与 smoke 报告一致、
后端 sha256 一致、smoke passed、活库 integrity/914/51/914、备份归位 data/、
release zip 与侧车 sha256 一致、zip 完整性 320 项、9 个必需条目齐全、**zip 内 0 条用户记忆**、
5 个历史包保留、源码在 devel/、外壳源码在 devel/desktop、根目录无源码残留、
CI 配置在 devel/.github、可运行代码无过期路径、四个锚点解析正确、
`default_data_dir()` 从任意 cwd 解析到活库。

### 结构
```
六个顶层目录        .venv build data desktop-standalone devel release
产物根即程序        desktop-standalone\Memora.exe            True
                    desktop-standalone\resources\app.asar    True
                    desktop-standalone\data\memory.sqlite3   True
无嵌套/重复产物     win-unpacked False / release-win-unpacked False
                    memora-data False / desktop False
```

### 构建（真实执行，非声明）
```
Build-Desktop.ps1   exit 0，24 秒
  PyInstaller       236 文件 / 37.6 MB，39 个 memora 模块全部进入 PYZ
  electron-builder  输出 desktop-standalone\win-unpacked → 自动扁平化
  产物              320 文件（含新 docs 45 篇，旧包 14 篇；目录复制而非清单）
smoke_desktop.py    exit 0，9 秒
  passed=true, version=1.3.0, desktop_default_exit_code=0, desktop_ready=true
  artifact_tree_sha256 = 335fe29e…df84
  backend_sha256       = db93b023…f3c
release.py --skip-build  exit 0
  release\memora-1.3.0-windows-x64.zip  177,093,653 bytes
  sha256 a342dd0d82f9817f2435066daf191d15d9acbfd27d338328c5a70919222545ca（与 .sha256 文件一致）
```

### 解压即用（本次重构最重要的验收）
把 zip 解压到项目外的临时目录并运行：

```
zip testzip         None
zip entries         320
模板 memories       0        ← 不含任何用户记忆
启动后 status       name=memora version=1.3.0 kernel=native
data_dir            <用户目录>\Temp\memora-zip-check-d3fb40a5\data   ← 指向解压副本自身
data_dir_is_extracted_copy   True
%LOCALAPPDATA%\memora       未创建、未被写入（该目录创建于 10-16，与本次无关）
VERDICT             PASS
```

### 原地运行
```
desktop-standalone\Memora.exe  存活，拉起 memora-backend
status                         version 1.3.0, kernel native, data_dir = desktop-standalone\data
data_dir 指向正确               True
```

### 测试
```
重构前基线   437 tests, FAILED (errors=4, skipped=5)
重构后       437 tests, OK    (skipped=3)
```
4 个基线错误全部修好：
- `test_docindex_is_forced_into_the_frozen_bundle` —— 原测试切片 `build_desktop.py` 源码文本，
  改配置即抛 `ValueError`。改为断言新增的 `FORCED_HIDDEN_IMPORTS` 常量（构建实际读取的那个）。
- `test_ci_has_a_lint_job` / `test_ci_kept_its_original_jobs` / `test_the_lint_job_runs_the_configured_tools`
  —— `.github` 随源码进 `devel/`，测试的 `ROOT` 恰好指向 `devel/`，自然恢复。

### 用户数据
```
memory.sqlite3   23,916,544 bytes（重构前后一致）
memories         914
documents        51
turns            596
integrity        ok
markdown         914 篇
```

### 磁盘与归档
- `build\archive\private-public-before-1.0.1-…` 从 1.6 GB 降到 7.3 MB：
  删除的是 `.venv` / `desktop\node_modules` / `dist` / `build` 等可由该快照自带 `.git`
  重建的目录；**300 个被跟踪文件全部保留，git status 干净，两条历史提交完整**。
  第一次修剪误删了 159 个被跟踪文件，已用 `git checkout -- .` 全量恢复并复核
  （missing 0）。
- `release\` 里 1.0.0–1.2.0 的历史安装包未改动（mtime 保持原值）。

## 五、遗留与判断

1. **`release\` 现在有 1.0 GB**：1.0.0–1.2.0 五个历史 zip 各约 177 MB。它们是历史交付物，
   本次未动（mtime 保持原值）。若要回收空间，可只保留每个版本的 sha256 与交付说明——
   这是一个明确的可选动作，不是重构的一部分。
2. **`devel\` 现有 1.1 GB**：其中 `artifacts\`（验证截图与历史报告）、`frontend\node_modules`、
   `native\target` 属于开发目录的正当内容，符合新结构定义。相对重构前的 4.0 GB 已因
   `build/archive` 的按需重建处理而大幅下降。
3. **旧 `dist\` 概念已彻底消失**：所有构建产物在 `build\`，打包成品在 `desktop-standalone\`，
   安装包在 `release\`。可运行代码中不再有 `dist/` 路径（验收脚本第 6 项持续检查）。
4. **`tools\legacy\`** 保留原样：那是冻结的历史脚本，不参与当前构建，不做路径改写
   （改写反而会伪造历史）。
5. **`devel\` 的 git 工作区仍有 455 个 `D` 状态**：这是本次迁移把已跟踪文件移进 `devel\`
   造成的（旧位置的删除）。git 索引尚未 `add` 新路径。这是版本库操作，不影响任何运行时行为；
   是否重新索引由维护者决定。

## 六、给后续维护者

- 移动任何目录前读 `devel\docs\DIRECTORY-LAYOUT.md`。多个脚本按自身位置推导项目根，
  层级变了会静默失败——`default_data_dir()` 那次就是打开了空库而不是报错。
- 新模块要进打包，只看两处：`MODULES`（按目录自动发现）与
  `FORCED_HIDDEN_IMPORTS`（无 import 引用时必须列出）。测试会盯住这两点。
- 判断"程序能不能用"只需要一条命令：进入 `desktop-standalone\` 双击 `Memora.exe`。
  如果那个目录里出现第二层同名目录，说明 `flatten_product()` 被绕过了。
