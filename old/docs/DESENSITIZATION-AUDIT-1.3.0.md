# Memora 文档脱敏审计（1.3.0）

本文件记录 1.3.0 交付前对 `docs/` 目录所做的脱敏审计：规则、逐处 before → after、可复现的复查命令与真实输出，以及"检查过但未发现"的模式清单。

- 审计范围：`docs/` 下全部 42 个 Markdown 文件（含 `docs/history/`），审计结束时为 43 个（加入本文件）。
- 审计目标：清除会随发行包一起发出的**本地特有位置信息**，不改变任何技术含义。
- 审计结论：**0 处残留**；共修改 4 个文件、10 处；未发现密钥、令牌、账户名。
- 不变量：版本号、日期、模型名、端口、命令参数、历史事实、段落结构均未改动；文件仍为 UTF-8 无 BOM，行尾保持原样。

## 1. 范围：哪些文档会随包发出

`tools/build_desktop.py` 的 `GUIDES` 白名单决定 `docs/` 里哪些文件会被复制进发行包：

| 类别 | 文件 |
|---|---|
| 文档（GUIDES 白名单） | `REFACTOR-1.0.2.md`、`VALIDATION-1.0.2.md`、`REFERENCES.md`、`OPEN_SOURCE_REUSE.md`、`DEPENDENCIES.md`、`IMPLEMENTATION-1.1.0.md`、`OPERATIONS-1.1.0.md`、`VALIDATION-1.1.0.md`、`DELIVERY-1.1.0.md`、`DESKTOP-STARTUP-FIX-1.1.0.md` |
| 同目录图片等资源 | `Minimal-Architecture.svg`、`ARCHITECTURE-1.1.0.svg`（及对应 `.html`） |
| 根目录（另一条复制路径） | `README.md`、`README.zh-CN.md`、`CHANGELOG.md`、`LICENSE`、`NOTICE`、`PRIVACY.md`、`THIRD_PARTY_NOTICES.md`、`RELEASE_NOTES.*` |

本次只处理 `docs/` 下的 `.md`；根目录文档与代码由另一条任务负责。由于 `docs/` 下的非白名单文件也可能被手工打包，本次对**全部** `docs/**/*.md` 做了无损扫描与最小修改。

## 2. 脱敏规则

### 2.1 替换原则

1. **只替换"本地绝对位置"**：盘符绝对路径、WSL 挂载绝对路径、本地安装目录、用户目录、账户名、主机名。技术信息（模型名、维度、端口、参数、版本、日期、哈希）一字不改。
2. **定点替换**：逐处 `edit` 精确替换，不整篇重写，不删段落、不调整顺序。
3. **可移植占位**：所有替换值用 `<...>` 包裹，读者替换成自己的实际路径即可复现原意。
4. **保留行尾与编码**：写回仍是 UTF-8 无 BOM；原 CRLF 的文件仍是 CRLF，原 LF 的仍是 LF。
5. **占位符随文档语言**：中文文档用中文占位（`<项目根>`），英文文档用英文占位（`<project root>`）。

### 2.2 占位符约定

| 占位符 | 含义 | 替换掉的本地内容（占位化呈现） |
|---|---|---|
| `<项目根>` / `<project root>` | Memora 检出目录（源码树根） | `D:\<...>\memora`、`D:/<...>/memora` |
| `<模型目录>` | 存放模型权重的目录 | `D:\<...>\model` |
| `<DSH install dir>` | DSH 宿主的安装目录 | `D:\<...>\config\dsh-home\profiles\desktop\cordis.patch.yml` |
| `/mnt/<盘符>/...` | WSL 视角下的盘符挂载 | 原文为 `/mnt/<盘符>/<...>/memora/...`（已改为 `<项目根>`） |

### 2.3 有意保留、不改的内容

- `127.0.0.1` 回环地址与端口：属于产品默认值，非本地特征。
- `~/.local/share/memora/...`：WSL 内相对用户家目录的约定路径，可移植。
- `%LOCALAPPDATA%\memory-merge`、`~/.codex/config.toml`：环境变量 / 通用约定路径。
- `\\\\?\\` 长路径前缀：Windows 格式示例，非本地位置。
- `docs/history/` 历史版本说明：只做同样的路径替换，不改历史事实。

## 3. 逐处 before → after

下表 "修改前" 一列已占位化：本文件本身也随包，故不写出完整本地路径。

| # | 文件:行 | 修改前（占位化） | 修改后 |
|---|---|---|---|
| 1 | `docs/DELIVERY-1.1.0.md:3` | 开发和运行继续位于 `D:\<...>\memora` | 开发和运行继续位于 `<项目根>` |
| 2 | `docs/DELIVERY-1.1.0.md:14` | 权重仍在 `D:\<...>\model` | 权重仍在 `<模型目录>` |
| 3 | `docs/OPERATIONS-1.1.0.md:26` | `D:\<...>\model\Qwen3-Embedding-0.6B\` | `<模型目录>/Qwen3-Embedding-0.6B/` |
| 4 | `docs/OPERATIONS-1.1.0.md:27` | `D:\<...>\model\Qwen3.8-2B-Q4_K_M.gguf` | `<模型目录>/Qwen3.8-2B-Q4_K_M.gguf` |
| 5 | `docs/OPERATIONS-1.1.0.md:43` | `wsl.exe -d rocky -- bash /mnt/<盘符>/<...>/memora/deployment/install-rocky.sh` | `wsl.exe -d rocky -- bash '<项目根>/deployment/install-rocky.sh'` |
| 6 | `docs/RELEASING.md:64` | `$env:TEMP = 'D:\<...>\memora\runtime\tmp'` | `$env:TEMP = '<project root>/runtime/tmp'` |
| 7 | `docs/RELEASING.md:139` | `datas = [('D:/<...>/memora/build/focused-sap8ng09/memora/static', 'memora/static')]` | `datas = [('<project root>/build/focused-sap8ng09/memora/static', 'memora/static')]` |
| 8 | `docs/RELEASING.md:142` | `['D:/<...>/memora/build/focused-sap8ng09/entry.py'],` | `['<project root>/build/focused-sap8ng09/entry.py'],` |
| 9 | `docs/RELEASING.md:143` | `pathex=['D:/<...>/memora/build/focused-sap8ng09'],` | `pathex=['<project root>/build/focused-sap8ng09'],` |
| 10 | `docs/DECISIONS-1.2.0.md:107` | Config lives at `D:\<...>\config\dsh-home\profiles\desktop\cordis.patch.yml:180-207` | Config lives at `<DSH install dir>/config/dsh-home/profiles/desktop/cordis.patch.yml:180-207` |

说明：

- 第 1—4 处为已知必改项。
- 第 5—10 处由本轮全量扫描补充发现：`OPERATIONS-1.1.0.md` 的 WSL 挂载路径、`RELEASING.md` 的临时目录与 PyInstaller spec 示例、`DECISIONS-1.2.0.md` 的 DSH 配置位置。
- 第 7—9 处保留了 `focused-sap8ng09`：它是 PyInstaller 自动生成的**临时目录名**（不是路径），替换掉会让"spec 烘焙了随机临时路径"这段说明失效。
- 第 5 处中 `<项目根>` 指 WSL 里可见的项目根（例如通过 `/mnt/<盘符>/...` 挂载的同一目录）。

### 3.1 改动统计

```
docs/DECISIONS-1.2.0.md  | 2 +-
docs/DELIVERY-1.1.0.md   | 4 ++--
docs/OPERATIONS-1.1.0.md | 6 +++---
docs/RELEASING.md        | 8 ++++----
4 files changed, 10 insertions(+), 10 deletions(-)
```

## 4. 复查命令（可直接复制执行）

在项目根目录用 PowerShell 执行。为免本文件自身再次写入本地目录名，模式里的敏感片段用字符类或片段拼接呈现，语义与直接写字面量等价。

```powershell
$docs = Get-ChildItem docs -Recurse -Filter *.md | Sort-Object FullName

$rules = [ordered]@{
  '盘符绝对路径'       = '(?<![A-Za-z0-9])[A-Za-z]:[\\/](?!<)'
  '本地工作区目录名'   = ('[\\/][.]mem' + 'ory')
  'DSH 本地安装目录'   = ('dsh-' + 'web|dsh-' + 'desktop')
  '用户目录'           = ('(?<![A-Za-z0-9])[A-Za-z]:[\\/]+User' + 's')
  '默认管理员账户名'   = ('Administra' + 'tor')
  'API Key 形态'       = ('sk' + '-[A-Za-z0-9]{20,}')
  'Bearer 字面量令牌'  = 'Bearer\s+[A-Za-z0-9._-]{8,}'
  '本地主机名(动态)'   = [regex]::Escape($env:COMPUTERNAME)
  'Windows 主机名形态' = ('(?-i)DESKTOP-' + '[A-Z0-9]{9,}|(?-i)LAPTOP-' + '[A-Z0-9]{6,}')
  'WSL 挂载路径'       = ('/mn' + 't/[a-z]/')
}

foreach ($k in $rules.Keys) {
  $n = @($docs | Select-String -Pattern $rules[$k]).Count
  '{0,-20} hits = {1}' -f $k, $n
}
"扫描文件数 = $($docs.Count)"
```

## 5. 复查真实输出

以下为加入本文件后、直接执行第 4 节命令的真实输出（第 1 段原样回显）。第 2 段把命中的原始字符串替换成了同义标签（如『盘符 + 隐藏工作区名（反斜杠写法）』），因为本文件自身也随包、不能再写出这些字面量；命中数原样保留。

```text
=== 1) 模式扫描（规则 × 命中数）===
盘符绝对路径               hits = 0
本地工作区目录名             hits = 0
DSH 本地安装目录           hits = 0
用户目录                 hits = 0
默认管理员账户名             hits = 0
API Key 形态           hits = 0
Bearer 字面量令牌         hits = 0
本地主机名(动态)            hits = 0
Windows 主机名形态        hits = 0
WSL 挂载路径               hits = 0
扫描文件数 = 43

=== 2) 原命中字符串逐条复查（应为 0）===
  盘符 + 隐藏工作区名（反斜杠写法）   hits = 0
  盘符 + 隐藏工作区名（斜杠写法）     hits = 0
  盘符 + DSH 本地安装目录             hits = 0
  WSL 挂载 + 隐藏工作区名             hits = 0
  默认管理员账户名                    hits = 0
  用户目录绝对路径                    hits = 0

=== 3) 本次改动 diff 统计 ===
 docs/DECISIONS-1.2.0.md  | 2 +-
 docs/DELIVERY-1.1.0.md   | 4 ++--
 docs/OPERATIONS-1.1.0.md | 6 +++---
 docs/RELEASING.md        | 8 ++++----
 4 files changed, 10 insertions(+), 10 deletions(-)

=== 4) 改动文件编码/换行复查 ===
  docs\DELIVERY-1.1.0.md                     BOM=False  CRLF=36  LF=0
  docs\OPERATIONS-1.1.0.md                   BOM=False  CRLF=78  LF=0
  docs\RELEASING.md                          BOM=False  CRLF=0  LF=232
  docs\DECISIONS-1.2.0.md                    BOM=False  CRLF=0  LF=213
  docs\DESENSITIZATION-AUDIT-1.3.0.md        BOM=False  CRLF=0  LF=153（本文件自身，随后续编辑略变）

=== 5) 随包白名单文档（tools/build_desktop.py GUIDES）复查 ===
  GUIDES 文档残留合计 = 0
```

## 6. 检查过但未发现的模式

以下模式在全部 `docs/**/*.md`（42 个，本文件加入后 43 个）中均为 0 命中：

| 检查项 | 说明 |
|---|---|
| 盘符绝对路径 | 任何 `盘符:\` 或 `盘符:/` 形式的路径（已排除 `<...>` 占位与 `https://` 协议） |
| 本地工作区目录名 | 盘符下隐藏工作区目录出现在 `docs/` 任意位置 |
| DSH 本地安装目录 | 本地 DSH 桌面端目录名 |
| 用户目录 | Windows 用户配置目录绝对路径 |
| 默认管理员账户名 | 本地账户名 |
| API Key 形态 | `sk-` 开头的长令牌 |
| Bearer 字面量令牌 | 真实令牌值（文档只保留 `Authorization: Bearer <token>` 占位） |
| 主机名（动态） | 以运行环境 `COMPUTERNAME` 为准的字符串 |
| 主机名（形态） | `DESKTOP-` / `LAPTOP-` 前缀 + 大写字母数字后缀的形态 |
| WSL 挂载路径 | `/mnt/<盘符>/` 形式的绝对路径 |

另外人工确认：`docs/` 中没有 `.env`、证书、私钥、真实数据库、真实用户数据或可复用的凭据片段；`data/mcp-token` 只作为路径名被提及（`OPERATIONS-1.1.0.md:16`），未给出令牌值。

## 7. 编码与行尾复查

| 文件 | BOM | 行尾 |
|---|---|---|
| `docs/DELIVERY-1.1.0.md` | 无 | CRLF（36 行，原样） |
| `docs/OPERATIONS-1.1.0.md` | 无 | CRLF（78 行，原样） |
| `docs/RELEASING.md` | 无 | LF（原样） |
| `docs/DECISIONS-1.2.0.md` | 无 | LF（原样） |
| `docs/DESENSITIZATION-AUDIT-1.3.0.md`（本文件） | 无 | LF（新建，UTF-8 无 BOM） |

## 8. 边界与后续

- 本次未触碰 `README.md`、`README.zh-CN.md`、`CHANGELOG.md`、`RELEASE_NOTES.*`、代码、`tools/`、`memora/`；根目录文档由另一条任务处理。
- 未运行构建，未修改 `dist/`、`data/`、`runtime/`。
- 若本文件需要随发行包提供，需要把它加入 `tools/build_desktop.py` 的 `GUIDES` 白名单（该文件在另一条任务的写入范围内，本任务未修改）。
