# 目录布局 / Directory layout

本文只回答一个问题：**某个文件应该放在哪、删掉会怎样**。路径的唯一真源是
[`tools/paths.py`](../tools/paths.py)——脚本不要按 `parents[N]` 自己推项目根，用那个模块。
运行 `python tools/paths.py` 会打印它实际解析到的每个目录以及是否存在，路径推错时立刻可见。

状态基线：**1.3.0 / 2026-10-19**。历史上 `devel/` 子目录已扁平化，仓库根就是源码树；
本文旧版还在描述 `devel/` 与 `<数据目录>\`，那个布局已不存在。

---

## 1. 两个目录，两种使用者

| | 开发测试目录 | standalone 成品目录 |
|---|---|---|
| 路径 | `<项目根>`（本仓库） | `<独立版目录>` |
| 是什么 | 源码树、测试、构建脚本 | 最终用户双击运行的成品 |
| 谁用 | 开发者、CI、测试 | 用户，且是短暂使用 |
| 可执行入口 | `dev-serve.ps1`、`start-memora.ps1` | 根目录的 `Memora.exe` |
| 端口 | 8765（MCP HTTP 18184） | 18765，被占用时自动回退到 18795 |
| 数据目录 | `<仓库>/data/` | `<成品目录>/data/` |
| 数据性质 | 开发期真实记忆库 | **用户真实数据** |

两者是**兄弟目录**，不是父子。`tools/paths.py` 用 `DEV.parent` 推导出它们的共同父目录，
因此移动任何一个都会改变另一个的相对位置。

其余兄弟目录：`../memora-release/` 放安装包 zip。

### 同步规则（这是最容易造成数据损失的一步）

**必须先获得用户明确授权，才能更新 standalone。** 开发目录升级不包含同步授权。
`tools/build_desktop.py` 默认只构建开发目录 `dist/memora-backend`；`--backend-only` 明确执行同样行为。
只有用户授权之后才可使用 `--allow-standalone-update`。本文历史命令中无此参数的构建不会更新桌面成品。

重建成品时，**程序文件可以覆盖，`data/` 绝对不能被覆盖**。

- standalone 的 `data/` 是用户真实数据，不是示例数据，也不是可以重新生成的构建产物。
- 同步时逐个替换程序文件（`Memora.exe`、`resources/`、`*.dll`、运行库），**跳过 `data/`**。
- 不要用「先清空整个目录再解压」的方式更新——那会连 `data/` 一起删掉。
- 需要整体替换时，先把 `data/` 移出或改名，替换完成后再放回。
- 升级前让用户备份整个 `data/` 目录：四个 SQLite 与 Markdown 镜像都不是单库原子快照，
  见 [运行与维护](OPERATIONS.md)。

端口与数据目录的独立性不是偶然：两个程序同时运行、各自打开自己的库，是设计上允许的状态。
把两者的数据目录指到同一处会让两个写入者操作同一个 SQLite，这个失败模式不要引入。

---

## 2. 仓库内每个目录

| 目录 | 回答什么问题 | 是否可重建 | 误删后果 |
| --- | --- | --- | --- |
| `memora/` | 后端源码在哪？ | 否（原始资产） | 无法运行，无任何替代 |
| `memory_merge/` | 旧包名的兼容层在哪？ | 是（很薄） | `memory-merge` 命令消失；打包仍会用到 |
| `tools/` | 构建与验证脚本在哪？ | 否 | 无法构建、无法验收 |
| `tests/` | 单元测试在哪？ | 否 | 失去回归保护 |
| `frontend/` | TypeScript 前端源码与 esbuild 构建在哪？ | 否 | 脑图与工作台资源无法重建 |
| `desktop/` | Electron 壳源码在哪？ | 否 | 无法产出桌面程序 |
| `native/` | Rust PyO3 向量内核在哪？ | 否 | 只能退回纯 Python 向量扫描 |
| `docs/` | 设计与运维文档在哪？ | 否 | 知识丢失，不影响运行 |
| `deployment/` | 推理环境与模型部署脚本在哪？ | 否 | 新机器无法部署推理 |
| `integrations/` | DSH 等宿主适配在哪？ | 否 | 宿主接入方式丢失 |
| `bench/` | 性能与质量测量脚本在哪？ | 否 | 失去测量能力 |
| `datasets/` | 评测数据在哪？ | 否 | 评测不可复现 |
| `data/` | 开发期真实记忆库在哪？ | **否** | **开发数据不可恢复** |
| `runtime/` | 开发期运行时状态在哪？ | 是 | 丢日志与临时状态，不影响数据 |
| `dist/` | PyInstaller 后端产物在哪？ | 是（`tools/build_desktop.py`） | 需重新构建 |
| `pyinstaller/` | PyInstaller 工作区与 spec 在哪？ | 是 | 下次构建重新生成 |
| `cache/` | 下载缓存（Electron、llama.cpp 源码等）在哪？ | 是 | 下次构建重新下载 |
| `reports/` | 构建与验证证据在哪？ | 是（重跑产生） | 丢失历史证据 |
| `artifacts/` | 开发过程产物在哪？ | 部分 | 丢失截图/备份等 |
| `archive/` | 历史留存快照在哪？ | 否 | 历史版本源码丢失 |
| `preview-data/` | 界面预览用的样例库在哪？ | 是 | 预览功能无样例数据 |
| `LICENSES/` | 第三方许可原文在哪？ | 否 | 许可合规记录丢失 |
| `.venv/` | Python 3.12 解释器与依赖在哪？ | 是（`pip install`） | 需重装依赖 |
| `.github/` | CI 与仓库模板在哪？ | 否 | CI 定义丢失 |

`dist/`、`pyinstaller/`、`cache/`、`runtime/`、`reports/` 都是「可以删，删了要花时间」的一类；
`data/` 与 `archive/` 是「删了就没了」的一类。这条分界线是本文最该记住的东西。

---

## 3. 运行方式

| 目的 | 命令 |
| --- | --- |
| 源码开发（改完刷新即见） | `./dev-serve.ps1` |
| 源码 + 托管运行时 + 桌面壳 | `./start-memora.ps1` |
| 只起后台服务 | `./start-memora.ps1 -Headless` |
| 构建桌面程序 | `.venv/Scripts/python tools/build_desktop.py` |
| 冻结产物冒烟 | `.venv/Scripts/python tools/smoke_desktop.py`（需先构建） |
| 打包发布 | `.venv/Scripts/python tools/release.py` |
| 跑全部检查 | `.venv/Scripts/python tools/run_checks.py` |

---

## 4. 数据目录如何被决定

三种情形，优先级从上到下：

1. **显式覆盖**：`MEMORA_DATA` 或 `MM_DATA`（命令行 `--data` 等价）。测试与脚本用这条。
2. **打包程序**：`<exe 同级>/data/`，由 `desktop/main.cjs` 在 `app.isPackaged` 时解析。
   解压到任意位置都能自带数据库，不往 `%APPDATA%` 里散落状态。
3. **源码树**：`<仓库>/data/`。

三者都没有时，`memora/config.py::default_data_dir()` 才回退到平台目录
（`%LOCALAPPDATA%\memora`）。它**从自身位置向上遍历**，取第一个真正含有
`data/memory.sqlite3` 的祖先目录——层级是推导出来的，不是写死的。

> **这是本项目最危险的失败模式。** 回退是静默的：路径一旦算错，症状不是报错，
> 而是「我的记忆不见了」——程序安静地打开一个空库。历史上正是因为源码在 `devel/` 下更深一层，
> `parents[2]` 才对、`parents[1]` 指向空目录。改动目录深度前先读这段。

---

## 5. 成品目录为什么是扁平的

`electron-builder` 只能把 unpacked 产物输出到 `<output>\win-unpacked\`。
`tools/build_desktop.py` 在打包结束后把 `win-unpacked\` 的内容上提一层，因此
standalone 目录本身就是应用程序根：一个 `Memora.exe`、一个 `resources\`、一个 `data\`。

这条约定由 `build_desktop.py::flatten_product()` 强制，改打包流程时不要绕过它——
三层嵌套的同名产物曾经让人找不到可以直接运行的 exe。
