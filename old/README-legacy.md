# old/ — 旧项目 `memora` 1.3.0 的交付结果（仅作参考）

> **一句话**：`old/` 目录是**旧项目 `memora` 1.x 的最终交付结果**，按当时的形态原样保留在
> 仓库中，**仅供查阅与参考**。它**不是**当前产品——当前维护的发布版是仓库根目录的
> **memora-core**。
>
> 旧版代码为 Apache-2.0。公开前**只做了脱敏**（移除本地绝对路径与个人标识），
> 代码、测试、文档与许可均未改动。
>
> 本文档在 `old/README-legacy.md` 与仓库根目录的 `README-legacy.md` 各有一份，
> **内容完全相同**；文中所有路径均**相对于仓库根目录**。

---

## 这是什么

`memora` 1.x 是一个面向智能体的本地优先记忆中枢。会话经 MCP 进入，落地为 Markdown 与
SQLite 归档；小模型产出有出处的候选记忆，Judge 判定持久性与风险，规则路由与来源核验决定
沉淀路径，Embedding 加 Rust 内核负责召回。Markdown 文档库与二维／三维脑图属于同一个应用。

| | |
|---|---|
| 版本 | 1.3.0 |
| 许可 | Memora 自身贡献为 Apache-2.0；继承的 Memory Merge（MIT）与 vendored 组件保留各自许可，详见 `old/LICENSE`、`old/NOTICE`、`old/LICENSE-STATUS.md`、`old/THIRD_PARTY_NOTICES.md`、`old/LICENSES/` |
| 定位 | **归档 / 参考**。不是当前产品，不接受功能更新与缺陷修复 |
| 语言 | Python（后端）+ TypeScript（前端）+ Electron（桌面外壳） |

## 与 memora-core 的关系：重写，不是分叉

这是读这份文档最容易搞混的一点。

| | `old/`（memora 1.3.0） | 仓库根目录（memora-core） |
|---|---|---|
| 性质 | 重写**之前**的代码 | 当前维护的发布版 |
| 许可 | Apache-2.0 | MIT |
| 运行时依赖 | 需 `mcp` 等第三方包 | **只用 Python 标准库** |
| 架构 | 独立应用，代码体量大 | 另起炉灶重写 |
| 状态 | 冻结归档 | 持续演进 |

**两者的目录、数据目录与配置请勿混用**——它们是不同的代码，数据库格式、配置项与
数据目录约定都不通用。`old/` 的数据目录在旧版约定下是 `<项目根>/data`，或经 `--data` /
`MM_DATA` 指定。

## 目录里有什么

| 路径 | 内容 |
|---|---|
| `old/memora/` | 后端 Python 包（43 个模块）：记忆模型、工作流、检索、MCP 服务端、HTTP 接口 |
| `old/desktop/` | Electron 桌面外壳（`main.cjs`、`package.json`、自检脚本） |
| `old/frontend/` | 前端源码：脑图视图、索引与详情页、构建脚本 |
| `old/native/` | Rust 向量内核（PyO3 绑定） |
| `old/memory_merge/` | 继承自 Memory Merge 的记忆内核（MIT） |
| `old/tests/` | 584 项单元与集成测试 |
| `old/tools/` | 构建、验收、DSH 集成与自检脚本 |
| `old/docs/` | 架构、决策、验收与**两份脱敏审计**（见下） |
| `old/reports/` | 历次重构的验收记录与证据 |
| `old/deployment/` `old/bench/` `old/datasets/` `old/integrations/` | 推理部署脚本、基准、评测集、外部接入示例 |
| `old/LICENSES/` | 第三方许可证全文 |
| `old/release/` | 本旧版本线的两个发布包（见下） |

## 跑起来看看（仅供参考）

后端需 Python 3.11+，运行时依赖只有 `mcp`。

```bash
cd old
python -m venv .venv
.venv/Scripts/pip install -e .          # Windows
# .venv/bin/pip install -e .             # Linux / macOS

python -m memora health                 # 打印运行状态
python -m memora serve                  # 界面 http://127.0.0.1:8765
python -m memora mcp                    # MCP stdio，供客户端接入
```

务必用 `--data <目录>`（或 `MM_DATA`）显式指定数据目录：不指定时会回落到平台数据目录，
这对发布包而言并不可取。

接入任意 MCP 客户端：

```json
{
  "mcpServers": {
    "memora": {
      "command": "python",
      "args": ["-m", "memora", "--data", "<data dir>", "mcp"]
    }
  }
}
```

## 发布包

| 文件 | 说明 |
|---|---|
| `old/release/memora-legacy-1.3.0-source.zip` | 本目录的脱敏源码包，解压即可读或安装 |
| `old/release/memora-legacy-1.3.0-windows-x64.zip` | 1.3.0 的 Windows x64 解压即用包，**已重新打包**：原包内 3 个随附文本文件仍写着已退役的本地根目录，已按同一替换表脱敏；后端可执行文件与全部内嵌模块经逐字节扫描，未发现任何本地路径 |
| `old/release/SHA256SUMS.txt` | 两个包的 sha256 |

## 公开前做了什么

**只有脱敏**，没有别的。数量如下：

- **86 个文件**做了 172 处表驱动的全局替换（本地绝对路径 → 统一占位符；同一原值全库一致）
- **49 个文件**做了 49 处语义改写：占位符不能直接留在代码里，改为可运行的写法
  （`SPECPATH` 推导、`os.homedir()`、环境变量），保证脚本仍可执行
- **20 个**历史一次性脚本（`old/reports/refactor/`）改为由仓库自身推导路径
- **排除 1 份**第三方数据：其上游无开源许可，不得再分发
- **改名 3 张**截图：内容本是 JPEG，扩展名写的是 PNG

代码、测试、文档、许可、版本号、命令与端口**一律未改**。冻结源全程只读，
584 个复制文件在复制前后逐字节校验一致。

占位符沿用本项目 1.3.0 自带审计已确立的词表（`<项目根>`、`<数据目录>`、`<DSH install dir>` 等），
保证新旧两版审计可对照。

## 验证

| 检查 | 结果 |
|---|---|
| 单元与集成测试 | 584 项全部通过；与脱敏前的冻结源逐项对照，**新增失败 0** |
| 在解压出的源码包内重跑 | 584 项全部通过 |
| Python 编译 | 190 个文件，exit 0 |
| `python -m memora health` | exit 0 |
| MCP stdio 握手 | 服务名 `memora`，**26 个工具** |
| Windows 后端 | `--version` 输出 1.3.0，`/api/agent/status` 返回真实数据 |
| 行尾与 BOM | 580 个文件与源比对，**0 处漂移** |
| 交付树中的本地路径 | **0** |
| 两个发布包中的本地路径 | **0**（重新打包后） |

## 两份脱敏审计

| 文件 | 内容 |
|---|---|
| `old/docs/DESENSITIZATION-AUDIT-public.md` | **本次公开**的脱敏审计：范围、规则、逐类 before → after、可复现的复查命令与真实输出、每一项"有意保留"的理由 |
| `old/docs/DESENSITIZATION-AUDIT-1.3.0.md` | 旧版 1.3.0 自带的审计（当时只处理了 `docs/`），保留以供对照 |

## 边界

- `old/` 是**冻结归档**：只读，不接受功能更新与缺陷修复。发现问题请去当前发布版。
- 本文档与其在仓库根目录的副本内容相同；树内引用一律相对于仓库根目录。
- 复现本次审计所用的脚本未随包分发（其匹配规则含本地路径特征），按需另行获取。
- 当前产品是仓库根目录的 **memora-core**；其许可（MIT）与架构与 `old/` 不同。

---

# old/ — the delivered result of the old `memora` 1.3.0 project (reference only)

> **In one line**: `old/` is the **final delivered result of the previous `memora` 1.x
> project**, kept in the repository exactly as it stood, **for reference and study**.
> It is **not** the current product — the maintained release is **memora-core** in the
> repository root.
>
> The legacy code is Apache-2.0. Publication changed **desensitization only** (local
> absolute paths and personal identifiers removed); code, tests, documentation and
> licence are untouched.
>
> This document exists in two identical copies — `old/README-legacy.md` and
> `README-legacy.md` at the repository root. **Every path below is relative to the
> repository root.**

## What it is

`memora` 1.x is a local-first memory hub for agents. Sessions arrive over MCP and land as
Markdown plus SQLite archives; a small model proposes sourced candidate memories, a Judge
decides durability and risk, deterministic routing and source verification decide what is
kept, and Embedding plus a Rust kernel power retrieval. Markdown management and the 2D/3D
brain views are part of the same application.

| | |
|---|---|
| Version | 1.3.0 |
| Licence | Apache-2.0 for the Memora contributions; the inherited Memory Merge (MIT) and the vendored components keep their own licences — see `old/LICENSE`, `old/NOTICE`, `old/LICENSE-STATUS.md`, `old/THIRD_PARTY_NOTICES.md`, `old/LICENSES/` |
| Status | **Archived / reference**. Not the current product; no feature work, no bug fixes |
| Stack | Python (backend) + TypeScript (frontend) + Electron (desktop shell) |

## Relationship to memora-core: a rewrite, not a fork

This is the point people most often get wrong.

| | `old/` (memora 1.3.0) | repository root (memora-core) |
|---|---|---|
| Nature | the code **before** the rewrite | the maintained release |
| Licence | Apache-2.0 | MIT |
| Runtime dependencies | needs `mcp` and other third-party packages | **Python standard library only** |
| Architecture | a standalone application, much larger | rebuilt from scratch |
| Status | frozen archive | actively developed |

**Do not mix their directories, data directories or configuration** — they are different
code, with incompatible database formats, configuration keys and data-directory
conventions. Under the legacy convention the data directory is `<project root>/data`, or
whatever you pass to `--data` / `MM_DATA`.

## What is in the directory

| Path | Contents |
|---|---|
| `old/memora/` | the backend Python package (43 modules): memory model, workflows, retrieval, MCP server, HTTP interface |
| `old/desktop/` | the Electron desktop shell (`main.cjs`, `package.json`, self-test scripts) |
| `old/frontend/` | frontend sources: brain views, index and detail pages, build scripts |
| `old/native/` | the Rust vector kernel (PyO3 bindings) |
| `old/memory_merge/` | the memory core inherited from Memory Merge (MIT) |
| `old/tests/` | 584 unit and integration tests |
| `old/tools/` | build, acceptance, DSH integration and self-test scripts |
| `old/docs/` | architecture, decisions, acceptance records and **two desensitization audits** (below) |
| `old/reports/` | acceptance records and evidence from the successive refactors |
| `old/deployment/` `old/bench/` `old/datasets/` `old/integrations/` | inference deployment scripts, benchmarks, evaluation sets, external integration examples |
| `old/LICENSES/` | full third-party licence texts |
| `old/release/` | the two release packages of this legacy line (below) |

## Running it (for reference)

The backend needs Python 3.11+; the only runtime dependency is `mcp`.

```bash
cd old
python -m venv .venv
.venv/Scripts/pip install -e .          # Windows
# .venv/bin/pip install -e .             # Linux / macOS

python -m memora health                 # prints the runtime state
python -m memora serve                  # UI on http://127.0.0.1:8765
python -m memora mcp                    # MCP stdio, for a client
```

Always pass `--data <dir>` (or `MM_DATA`) explicitly: without it the package falls back to
the platform data directory, which is not what a published package should do.

To connect any MCP client:

```json
{
  "mcpServers": {
    "memora": {
      "command": "python",
      "args": ["-m", "memora", "--data", "<data dir>", "mcp"]
    }
  }
}
```

## Release packages

| File | What it is |
|---|---|
| `old/release/memora-legacy-1.3.0-source.zip` | the desensitized source of this directory — unpack and read or install |
| `old/release/memora-legacy-1.3.0-windows-x64.zip` | the 1.3.0 Windows x64 unzip-and-run build, **repacked**: three bundled text files still carried a retired local directory and were desensitized with the same table; the backend executable and every embedded module were scanned byte by byte and contain no local paths |
| `old/release/SHA256SUMS.txt` | sha256 of both packages |

## What was changed for publication

**Desensitization only**, nothing else:

- **86 files** received 172 table-driven global replacements (local absolute paths → uniform
  placeholders; the same original value always maps to the same placeholder)
- **49 files** received 49 semantic fixes: a placeholder cannot be left in executable
  position, so it was rewritten into a working form (`SPECPATH` derivation,
  `os.homedir()`, environment variables) and the scripts still run
- **20** historical one-off scripts (`old/reports/refactor/`) now derive their paths from
  the repository itself
- **1 third-party dataset excluded**: its upstream carries no open licence, so it may not
  be redistributed
- **3 screenshots renamed**: the content was JPEG, the extension said PNG

Code, tests, documentation, licence, version numbers, commands and ports are **unchanged**.
The frozen source was read-only throughout, and the 584 copied files were verified
byte-identical before and after.

The placeholder vocabulary is inherited from the project's own 1.3.0 audit
(`<project root>`, `<data dir>`, `<DSH install dir>`, …) so the two audits can be read
side by side.

## Verification

| Check | Result |
|---|---|
| Unit + integration tests | 584 pass; compared item by item against the pre-publication source, **zero new failures** |
| Re-run inside the unpacked source package | 584 pass |
| Python compile | 190 files, exit 0 |
| `python -m memora health` | exit 0 |
| MCP stdio handshake | server `memora`, **26 tools** |
| Windows backend | `--version` reports 1.3.0; `/api/agent/status` returns real data |
| Line endings / BOM | 580 files compared, **0 drift** |
| Local paths in the delivered tree | **0** |
| Local paths in either package | **0** (after the repack) |

## The two desensitization audits

| File | Contents |
|---|---|
| `old/docs/DESENSITIZATION-AUDIT-public.md` | **this publication's** audit: scope, rules, before → after per category, the reproducible re-scan command with its real output, and the reason for every item kept on purpose |
| `old/docs/DESENSITIZATION-AUDIT-1.3.0.md` | the audit that shipped with 1.3.0 itself (it covered `docs/` only), kept for comparison |

## Boundaries

- `old/` is a **frozen archive**: read-only, no feature work and no bug fixes. Report
  problems against the current release instead.
- This document and its copy at the repository root are identical; in-tree references are
  always relative to the repository root.
- The scripts used to reproduce this audit are not shipped with the package (their matching
  rules encode local path characteristics).
- The current product is **memora-core** in the repository root; its licence (MIT) and
  architecture differ from `old/`.
