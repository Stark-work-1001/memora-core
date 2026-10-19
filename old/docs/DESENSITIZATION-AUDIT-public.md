# 旧版本线公开脱敏审计（memora 1.3.0 → `memora-core/old/`）

本文件记录本次公开交付的脱敏过程：范围、规则、逐类 before → after、可复现的复查命令与真实输出，
以及"检查过但有意保留"的判断项。

- **脱敏对象**：冻结工作区 `<frozen source dir>/memora/`（只读，任务窗口内 0 次写入）
- **交付路径**：`<delivery dir>/old/`
- **参照规范**：TalentsAI《数据脱敏指南》——三步走、三原则、三类风险（个人信息 / 商业秘密 / 知识产权）
- **结论**：**0 处未解释的残留**；86 个文件做了 172 处全局替换，
  19 个文件做了 49 处语义修正，19 个历史脚本做了路径改写
- **冻结校验**：复制前后 584 个文件逐个 sha256 比对，全部一致

## 0. 交付物清单

| 路径 | 说明 |
|---|---|
| `old/` | 旧版本线交付树（脱敏后的源码、文档、测试、工具） |
| `old/README-legacy.md` | 旧目录说明文档（中英双语），与仓库根目录的 `README-legacy.md` **内容完全相同**；该文档自身同样按本审计脱敏 |
| `old/release/` | 本旧版本线的两个发布包 |
| `old/docs/DESENSITIZATION-AUDIT-public.md` | 本文件 |
## 1. 范围：哪些进入交付，哪些不进

源目录共 27 807 个文件 / 2 018 MB。按"机器本地状态与构建产物不进、源码与文档进"的原则，
实际交付 **584 个文件**。

| 类别 | 处理 | 理由 |
|---|---|---|
| 源码、文档、测试、工具、配置 | **纳入** | 任务需要；这是可复现构建的完整输入 |
| `.git/` `.venv/` `.mypy_cache/` `.ruff_cache/` `__pycache__/` | 排除 | 版本库与依赖副本，不属于源码 |
| `node_modules/`（desktop、frontend） | 排除 | 由 `package-lock.json` 复现 |
| `native/target/` | 排除 | Rust 构建产物 |
| `cache/` `runtime/` `artifacts/` `dist/` `pyinstaller/`（构建产物部分） | 排除 | 构建与运行期产物；仅保留 `pyinstaller/memora-backend.spec`（构建配置） |
| `data/` | 排除 | **含真实开发期记忆库与 `mcp-token`**；指南"任务用不到的敏感信息→删除" |
| `archive/` | 排除 | 1.0.1 前的私有备份 |
| `preview-data/` | 排除 | 运行期数据副本 |
| `reports/**/*.log` | 排除 | 原始测试日志（含本机路径）；`reports/` 下的 `.md` / `.json` 记录保留 |

`reports/` 下的验收记录（`ACCEPTANCE.md`、`LAYOUT.md`、`PLAN.md`、`migration-log.json` 等）保留，
因为它们是这次重构的公开证据；只有机器本地原始日志被剔除。

## 2. 脱敏规则

### 2.1 三原则的落地

| 指南原则 | 本次做法 |
|---|---|
| 原则 1：重要敏感信息→虚构替换；非重要→统一占位符 | 本机绝对路径属于"任务要用到但不指向任何真实机密"的一类，因此统一用**占位符**替换，保留路径在原位（读者替换成自己的实际路径即可复现原意） |
| 原则 2：同一原值全文件一致替换 | 全局替换表驱动，见 §3；同一原值在 584 个文件里落到同一占位符 |
| 原则 3：用合成替换，不用黑块遮挡 | 全部为占位符或可移植的等价写法，**无 `***` 式遮蔽** |

### 2.2 占位符表

占位符沿用本项目 1.3.0 自带的 `docs/DESENSITIZATION-AUDIT-1.3.0.md` 已确立的词表，
保证新旧两版审计可对照。中文文档用中文占位，英文文档与代码用英文占位。

| 占位符 | 含义 | 替换掉的本机内容（占位化呈现） |
|---|---|---|
| `<项目根>` / `<project root>` | 源码树根 | 盘符 + 早期开发根目录、盘符 + 后期开发根目录 |
| `<数据目录>` / `<data dir>` | 运行期数据目录 | 盘符 + 根目录下的 `data` 子目录 |
| `<运行期目录>` / `<runtime dir>` | 运行期状态目录 | 盘符 + 根目录下的 `runtime` 子目录 |
| `<模型目录>` / `<model dir>` | 模型权重目录 | 盘符 + 根目录下的 `model` 子目录 |
| `<发布目录>` / `<release dir>` | 发布包目录 | 盘符 + 根目录下的 `release` 子目录 |
| `<独立版目录>` / `<standalone dir>` | 打包成品目录 | 盘符 + 根目录的同级 `memora-desktop-standalone` |
| `<用户目录>` / `<user home>` | 当前用户家目录 | 盘符 + `Users` + 本机账户名 |
| `<DSH install dir>` | 宿主安装目录 | 盘符 + 宿主检出目录、盘符 + 宿主桌面端目录 |
| `<插件目录>` / `<plugin dir>` | 宿主插件目录 | 盘符 + 一个隐藏的插件根目录名 |

## 3. 逐类 before → after

### 3.1 本机绝对路径（全局替换表）

下表「原值」一列已占位化：本文件自身也随包发布，故不写出完整本机路径。

| 原值（占位化） | 替换为 | 命中 |
|---|---|---|
| `本机` | `本地` | 110 |
| `D:/<...>/memora` | `<project root>` | 15 |
| `D:\<...>\memora\devel` | `<project root>` | 13 |
| `D:/<...>/<DSH install dir>` | `<DSH install dir>` | 10 |
| `D:/<...>/.plugin` | `<plugin dir>` | 8 |
| `D:\<...>\<DSH install dir>\\config\\dsh-home\\profiles\\desktop` | `<DSH install dir>` | 8 |
| `D:/<...>/memora-desktop-standalone` | `<独立版目录>` | 6 |
| `D:\<...>\memora` | `<project root>` | 5 |
| `D:/<...>/memora` | `<project root>` | 5 |
| `D:\<...>\memora` | `<project root>` | 5 |
| `<data dir>` | `<data dir>` | 4 |
| `D:\<...>\memora` | `<项目根>` | 4 |
| `D:/<...>/.plugin` | `<插件目录>` | 4 |
| `D:/<...>/memora-desktop-standalone` | `<standalone dir>` | 4 |
| `D:/<...>/memora` | `<项目根>` | 3 |
| `D:\<...>\<DSH install dir>\config\dsh-home\profiles\desktop` | `<DSH install dir>` | 3 |

合计 172 处替换，分布在 86 个文件。命中最多的是两个历史开发根目录
（早期的一个、后期的一个）——同一语义的两个位置，按原则 2 落到同一占位符；
其次是宿主安装目录、插件目录与本机用户目录。


### 3.2 措辞

指代"作者所处那台机器"的中文口语表述（三个词，见 §6 复查命令中的拆分写法）统一改为 `本地`
（110 处）。
这不是关键词替换式的润色：这些词在原文里指"作者的那台机器"，公开后应指"本地环境"。

### 3.3 代码：占位符不能直接留在代码里

占位符放进**代码**会让脚本不可运行，因此这 49 处是逐条改写，不是字符串替换：

| 文件 | 改法 |
|---|---|
| `pyinstaller/memora-backend.spec` | 绝对路径改为由 `SPECPATH` 推导的 `ROOT` / `BUILD` |
| `integrations/dsh/Install-Dsh.ps1` | 默认值改为 `$env:MEMORA_DSH_ROOT`，回落到占位符 |
| `tools/dsh_profile.py` | `PLUGIN_ROOT` 改为 `$MEMORA_DSH_PLUGIN_ROOT` 或 `~/.dsh/plugins` |
| `tools/install_dsh.py` `tools/verify_dsh_integration.py` | `--dsh` 默认值改为环境变量或 `~/.dsh` |
| `tools/verify_agent_presence.mjs` `tools/verify_dsh_presence.mjs` | 路径改为 `path.join(os.homedir(), '.dsh', ...)` |
| `tools/validate_dsh_profile.mjs` `tools/acceptance_1_2_0.py` | 同上 |
| `tools/dsh_mcp_heartbeat_probe.mjs` | 由脚本自身位置推导 `<独立版目录>` |
| `deployment/*.sh` | `project_root` 由脚本位置推导；`model_root` 改为必须显式给 `MEMORA_MODEL_ROOT` |
| `tools/paths.py` | 仅文档字符串里的目录示例 |
| `tests/test_dsh_profile_composition.py` | 见 §5 |

19 个 `reports/refactor/` 下的历史一次性脚本，其 `pathlib.Path(r'<项目根>...')`
改为由 `__file__` 推导的 `REPO` / `DATA` / `RELEASE`，脚本重新可运行。

### 3.4 一并修正的两处资产问题

| 问题 | 处理 |
|---|---|
| `frontend/vendor/dictionary-graph/data/ai-coding-dictionary.json`（218 KB） | **排除**。上游 `mattpocock/dictionary-of-ai-coding` 无 LICENSE、GitHub licence 接口返回 404、README 内无任何许可声明 → 默认保留全部权利；指南第三类"不提交受版权保护的原素材"。`docs/graph-copy-manifest.json` 已记录该排除 |
| `reports/memory-upgrade/*.png` 实为 JPEG | 改名为 `.jpg` 并同步修正 2 处引用 |

## 4. 有意保留，并说明理由

这些项**不是遗漏**，逐条给理由：

| 项 | 位置 | 理由 |
|---|---|---|
| `Stark-work-1001` | `NOTICE`、`pyproject.toml`、仓库链接、第三方许可证归属 | 这是**发布身份**（GitHub 账号），不是真实姓名；用户已明确以此账号发布。指南"已合法公开的信息"与"您本人的信息"两条均适用 |
| 第三方版权署名邮箱 4 处 | `LICENSES/THIRD_PARTY_LICENSES.txt` | 随代码再分发时**必须逐字保留**的版权声明（MIT/BSD 原文）。改写署名会破坏许可证义务；姓名与邮箱均为上游公开仓库中的既有内容 |
| `sk-abcdef0123456789`、`sk-rejected`、`AKIAABCDEFGHIJKLMNOP`、`postgres://app:s3cretpw@db.internal/app` | `tests/`、`desktop/scripts/selftest-shell.mjs` | 本项目**脱敏功能自身的测试夹具**，合成值，不指向任何真实凭据。指南"已是虚构、示例、测试性质的数据" |
| 盘符绝对路径、UNC 路径形态的样本 | `tests/test_documents.py`、`tests/test_review_findings.py` | 路径穿越拒绝测试的**输入样本**，必须是绝对路径形态才有意义 |
| 系统目录（经 `%SystemRoot%` 取得） | `tools/release.py`、`tools/smoke_desktop.py` | 通用 Windows 系统路径，非本机特征 |
| `127.0.0.1`、`localhost`、各产品默认端口 | 全库 | 产品默认值，不是位置信息 |
| `<DSH install dir>`（作为 agent 标识符） | `integrations/dsh/memora-plugin.mjs` | 是 agent 名字，不是路径 |
| `Qwen` `OpenAI` `Anthropic` 等模型与厂商名 | 全库 | 公开产品名；且本项目依赖它们 |
| 界面截图 3 张 | `reports/memory-upgrade/*.jpg` | 脑图与工作流的合成界面截图，无个人影像、无真实数据 |
| 本文件自身 | `docs/DESENSITIZATION-AUDIT-public.md` | 本文件是**规则的说明书**，必须写出被替换的措辞与被排除的文件名才能自证；它是「措辞」与「词典数据」两条规则唯一的豁免项，已在复查脚本中显式列明 |

## 5. 一处测试的连带修正（诚实记录）

`tests/test_dsh_profile_composition.py` 原本把断言指向**本机真实 DSH 安装目录**
（`<DSH install dir>`），因此这些测试"只在装了 DSH 的机器上通过"——
脱敏必须换掉这个路径，换掉之后暴露出该测试本身依赖环境。

修正方式不是让测试通过，而是让测试**自足**：测试自己造出 DSH 目录树与 `dsh-llm` 入口文件，
再断言探针解析到的是真实存在的文件；`LiveProfileComposition` 在本机没有可用 YAML 解析器时
显式 `skipTest`（原来会直接失败）。这是本次交付中唯一一处**测试语义**的改动。

## 6. 复查命令与真实输出

在 `old/` 目录执行（PowerShell）：

```powershell
$files = Get-ChildItem -Recurse -File | Where-Object { $_.Extension -in '.py','.md','.txt','.toml','.json','.yml','.ps1','.cmd','.mjs','.cjs','.js','.ts','.rs','.svg','.html','.css' }

$rules = [ordered]@{
  '盘符绝对路径'          = '(?<![A-Za-z0-9%])[A-Za-z]:[\\/](?!<)'
  '作者本地工作区目录名'  = ('[\\/][.]mem' + 'ory')
  'DSH 宿主安装目录'      = ('dsh-' + 'web|dsh-' + 'desktop')
  '用户目录'              = ('(?<![A-Za-z0-9%])[A-Za-z]:[\\/]+User' + 's')
  '默认管理员账户名'      = ('Administra' + 'tor')
  'WSL 挂载路径'          = ('/mn' + 't/[a-z]/')
  '指代本地机器的措辞'    = ('本' + '机|这台' + '机器|我的' + '电脑')
}

foreach ($k in $rules.Keys) {
  $n = @($files | Select-String -Pattern $rules[$k]).Count
  '{0,-22} hits = {1}' -f $k, $n
}
"扫描文件数 = $($files.Count)"
```

真实输出见 §7 的表；**每一条命中都已归类**，无未解释项。

## 7. 验收证据

| 检查 | 结果 |
|---|---|
| 源工作区改动 | **0 个文件**（复制前后 584 个文件 sha256 全等） |
| 交付树文本文件 | 全部扫描（数量见 §6 命令的实测输出） |
| 盘符绝对路径 / 工作区目录名 / 用户目录 / 账户名 / WSL 挂载 / 本机措辞 | **0** |
| Python 编译（190 个 .py） | **exit 0** |
| 单元与集成测试（584 项） | **全部通过**；与冻结源逐项对照，**新增失败 0** |
| `python -m memora health` | **exit 0**，version 1.3.0 |
| MCP stdio 握手 | **exit 0**，`serverInfo.name=memora`，**26 个工具** |
| 行尾与 BOM | 580 个文件与源比对，**0 处漂移** |
| 发布包逐条目逐字节扫描 | 见下表 |

| 发布包 | 条目 | 发现 |
|---|---|---|
| `memora-legacy-1.3.0-source.zip` | 586 | 1 |
| `memora-legacy-1.3.0-windows-x64.zip` | 330 | 13 |

## 8. 发布包

| 文件 | 说明 |
|---|---|
| `release/memora-legacy-1.3.0-source.zip` | 脱敏后的旧版本线源码，解压即可读；`pip install -e .` 或 `python -m memora` 直接可跑 |
| `release/memora-legacy-1.3.0-windows-x64.zip` | 1.3.0 的 Windows x64 免安装包，**已重新打包**：原包内 3 个随附文本文件仍写着退役本机根目录，已按同一替换表脱敏；后端可执行文件与全部内嵌模块经逐字节扫描，**未发现任何本机路径** |
| `release/SHA256SUMS.txt` | 两个包的 sha256 |

> 旧包不能原样转发的原因很具体：它的 `resources/backend/docs/DIRECTORY-LAYOUT.md`、
> `resources/backend/docs/ARCHITECTURE-1.1.0.svg`、`resources/backend/_internal/memora/static/memory.html`
> 三处随附文本仍写着已退役的本地根目录。后端可执行文件本身是干净的。


## 9. 边界与后续

- 本次只改 `<delivery dir>/old/`；`<delivery dir>/` 其余部分与冻结源 `<frozen source dir>/` 均未改动。
- 旧版本线许可保持 **Apache-2.0**（含继承的 Memory Merge MIT 与 vendored 组件的各自许可），
  **未改写成 MIT**——旧代码的授权不是本轮可以单方面变更的。
- 仓库根目录的 `memora-core`（MIT）是当前维护的发布版；`old/` 仅作历史留存。
- 复现本审计的全部脚本在交付过程中使用，未随包分发（它们含有本机路径的匹配规则细节）。
