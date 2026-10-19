# Memora 1.2.0 — 交付说明（打包修复）

本版本只做一件事：让已经实现并可用的两个功能真正进入打包产物。
没有新增功能，没有改变任何 Python 行为、API 契约或前端文件。

## 1.2.0 相对 1.1.0 改变了什么

1.1.0 的 DAG 工作流画布和文档级 RAG 在源码下完全可用，但三个打包清单从未同步更新，
因此两者都没有随发布版本出货。这是纯打包缺陷，源码行为本身没有问题。

### 修复一：画布文件进入冻结包

`tools/build_desktop.py` 原来只把 `memora/static/` 下的 4 个文件和 `brain/` 目录复制进暂存树，
`memora/static/dag/`（app.js、index.html、styles.css）从未被复制。
现在 `dag/` 采用与 `brain/` 完全相同的**目录复制**方式打包。
用目录复制而不是逐个文件名，是为了让以后新增的画布文件无需再改清单就能自动出货。

### 修复二：文档级 RAG 模块进入冻结包

`memora/docindex.py` 原本不在 `MODULES` 中，整个模块（分块、嵌入、FTS、混合召回）从未被暂存。
现在 `docindex` 已加入 `MODULES`。

**同时必须加 `--hidden-import memora.docindex`，这一点是构建过程中实测发现的，不是预防性措施：**
仅把模块写进 `MODULES` 仍然不够。PyInstaller 收集的是从入口可达的 import 图，
而目前没有任何模块 import `docindex`，因此只改 `MODULES` 的那次构建，
`memora.docindex` 依然不在冻结包的 PYZ 里（已用 PyInstaller 归档读取器核对确认）。
`--hidden-import` 是强制收录机制，本项目对 `memora_native` 已经在用同一机制。

### 修复三：画布可以被 HTTP 路由取到

`memora/workbench.py` 的 `ASSETS` 原来没有 `/dag` 条目，而 `memora/web.py:54` 是**精确匹配**
（`parsed.path in assets`），不像 `/brain/` 那样有专门的前缀分支，所以即使文件出货了也会 404。
现在新增的条目为：

| 路径 | 文件 | 类型 |
| --- | --- | --- |
| `/dag` | `dag/index.html` | text/html |
| `/dag/` | `dag/index.html` | text/html |
| `/dag/index.html` | `dag/index.html` | text/html |
| `/dag/styles.css` | `dag/styles.css` | text/css |
| `/dag/app.js` | `dag/app.js` | text/javascript |

`index.html` 用的是同级相对 URL（`styles.css`、`app.js`），会相对当前页面路径解析，
所以文档本身列了 `/dag` 和 `/dag/` 两种形式，两个资源路径各自登记。

### 没有改变的路由

画布调用的接口全部是既有接口，本次没有新增任何路由：

| 画布调用 | 对应既有适配器路径 | 路由位置 |
| --- | --- | --- |
| `GET /api/session` | 内建于 web.py | `web.py:137` |
| `GET /api/agent/workflows` | `Workbench.get` | `workbench.py:21` |
| `POST /api/agent/workflows` | `Workbench.post` | `workbench.py:115` |
| `GET /api/agent/workflow-runs` | `Workbench.get` | `workbench.py:22` |
| `POST /api/agent/workflow-start` | `Workbench.post` | `workbench.py:116` |
| `POST /api/agent/workflow-cancel` | `Workbench.post` | `workbench.py:117` |

## 如何运行

- 画布地址：`http://127.0.0.1:8765/dag?project=dsh`（`/dag` 与 `/dag/` 等价）。
- 冻结后端同样可用：启动 `build/dist/memora-backend/memora-backend.exe serve` 后访问同一路径。
- 工作台首页仍是 `http://127.0.0.1:8765/?project=dsh`。
- 桌面程序：`desktop-standalone/Memora.exe`。

## 已知缺口

1. **工作台导航没有画布入口。** `memora/static/memory.html` 属于另一个工作包，本次按边界未改。
   需要补的改动：在该页面的导航区域加一个指向 `/dag?project=<当前项目>` 的链接，
   位置与现有视图切换按钮一致。改完之后画布才是用户可点击到达，而不只是可以手动输入 URL。
2. **版本号仍是 `1.1.0`。** `memora/__init__.py` 不在本次可改范围内，未做提升；
   需要版本负责人单独改动，否则 `BUILD_MANIFEST.json` 和 `--version` 仍显示 1.1.0。
3. **画布只在 workbench 模式下有路由。** 非 review 的只读服务没有 `/dag` 条目，属于预期。

## 明确不包含的内容

1. **连接器（connector）故意没有在 DSH profile 中启用。** 这是有意决定，不是缺陷。
2. **文档级 RAG 目前没有任何 MCP 工具，也没有任何界面入口。**
   `docindex.py` 本次只是被打包进冻结包，能力上没有被暴露给模型或用户；
   要真正可用还需要后续单独提供 MCP 工具或 UI。
3. 不包含任何新的 Python 行为、API 契约变更或前端文件修改。

## 验证

证据见同目录的验收记录；测试见 `tests/test_packaged_assets.py`，该文件无需构建即可运行，
针对“新增功能没有更新打包清单”这一类失败建立了通用断言：
`memora/static/` 下每个子目录都必须被目录复制，`memora/` 下每个非 dunder 模块
必须出现在 `MODULES` 或 `EXCLUDED` 中，`docindex` 必须被 `--hidden-import` 强制收录。
需要真实构建的部分（冻结包中的文件哈希、`BUILD_MANIFEST.json`）在没有构建时**跳过**而不是伪装通过。
