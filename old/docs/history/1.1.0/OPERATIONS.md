# Memora 1.1.0：运行与维护

## 本地入口

根目录 `Start-Memora.cmd` 是当前部署入口。它调用 `start-memora.ps1`：启动 Rocky 两个用户服务，保持一个由本项目记录的 `wsl.exe sleep infinity` 客户端存活，启动 Windows 共享后端，再打开当前桌面构建。systemd 服务本身不足以保证 WSL 不自动关机。

启动器默认打开 `dsh` 项目空间，可用 `-Project <名称>` 改变。Web 支持 `/?project=dsh` 深链接；手工更改项目会记住该选择。项目空间控制检索范围，不是另一个数据库。

```powershell
./start-memora.ps1 -Headless
.venv/Scripts/python tools/runtime_manager.py status
# 仅停止本项目管理的 Windows 服务；不关闭整个 WSL 或 DSH
.venv/Scripts/python tools/runtime_manager.py stop
```

界面 `http://127.0.0.1:8765`；MCP HTTP `http://127.0.0.1:18184/mcp`。令牌存在 `data/mcp-token`，只提供给受信任宿主，不写入日志。stdio 宿主不依赖 HTTP 令牌，依靠本地进程权限。界面写入另有 Origin、JSON 和会话令牌检查。不要直接把这些回环端点映射到公网。

`runtime/active.json` 记录版本、URL、数据路径、管理进程；`runtime/host.*.log` 用于排查。旧桌面发行目录属于历史内容，以根目录启动器和 `desktop-standalone/` 为准。关闭桌面窗口时，已附着的共享后台服务继续为 DSH 提供记忆。

已修复程序文件继承 Low 强制完整性标签导致的 `0x80000003`。构建和启动器对程序及运行库设置 Medium，默认沙箱启动已验证；不修改 data / runtime 或普通 DACL。若 ZIP 解压目录再次继承 Low，先运行包内 `Repair-Desktop.cmd` 或 `Launch-Memora.cmd`；失败时查看 PowerShell 错误，不关闭沙箱。详见 [桌面启动修复](../../DESKTOP-STARTUP-FIX-1.1.0.md)。Web 回退仍保留作其他启动异常的应急入口。

## 模型与 Rocky

| 文件或目录 | 位置 |
|---|---|
| Embedding 权重 | `<模型目录>/Qwen3-Embedding-0.6B/` |
| Judge 权重 | `<模型目录>/Qwen3.8-2B-Q4_K_M.gguf` |
| WSL 推理私有环境 | `~/.local/share/memora/venv` |
| 固定 llama.cpp 源码和构建 | `~/.local/share/memora/source-b11695` |
| Windows 模型 API | Embedding `127.0.0.1:18181/v1`；Judge `127.0.0.1:18182/v1` |

实际使用 RTX 5080 Laptop CUDA GPU。Embedding 左 padding + last-token + FP16；每个输入最多 8,192 token、最多 32 个文本，微批 4。Judge GPU layers 99、ctx 16,384、parallel 2，关闭思考预算。不能把健康检查耗时当作真实编码／生成耗时。GGUF 的 Distill 来源未核实。

```powershell
wsl.exe -d rocky -- bash -lc 'systemctl --user status memora-embedding memora-judge --no-pager'
wsl.exe -d rocky -- bash -lc 'journalctl --user -u memora-embedding -u memora-judge -n 40 --no-pager'
./deployment/Start-Models.ps1
```

新机器需提前安装 Rocky WSL、Python 3.12、CMake、GCC、CUDA 13.0 编译工具和 NVIDIA WSL 驱动，并提供权重。本地已完成安装，无需重复下载。可重复安装脚本只创建 Memora 自己的环境／用户服务，不修改其他应用环境：

```powershell
wsl.exe -d rocky -- bash '<项目根>/deployment/install-rocky.sh'
```

`inference-rocky.lock.txt` 锁定实测 Python 推理依赖；脚本下载固定 b11695 源码（若缓存不存在），不下载任何模型。默认编译架构是本地 sm_120；其他 GPU 应调整此项。使用压缩源码构建时 llama-server 自报的 build 可能为 0 / unknown，应以固定标签、归档哈希和部署记录辨认，不能当作 Git 检出的提交证明。

## DSH 与其他宿主

`integrations/dsh/Install-Dsh.ps1` 先在 `artifacts/integration-backups/` 备份现有 profile patch；Python 只生成本地候选，PowerShell 校验原始散列和目标目录后应用。仅 Memora 标记块被改动。已安装到现有 desktop profile，通过配置热更新加载。备份和 `runtime/dsh/` 包含宿主私有配置，禁止当作示例发布。`integrations/dsh/memora.cordis.yml` 仅含本项目块。

运行中的 Node 会缓存 ESM 模块。安装器把当前插件按源码散列复制到 `runtime/dsh/adapters/` 并使用新模块路径；profile 重新加载后会换用新代码。仅写入 patch 文件不保证正在运行的宿主立即加载；不支持 profile 热更新时，下次正常重启 DSH 生效。不要手工修改这些生成副本。已重连本地 Memora stdio 子进程，使积累处理使用当前代码；DSH 旧生命周期连接仍可使用共享服务，最新插件在隔离的真实 DSH profile 中完成了验证。

生命周期插件首步召回、idle 归档。发件箱保存在 `data/integrations/dsh-outbox/`，服务暂时失败每 30 秒重送。单条超过 30,000 字符时明确停止这批归档并保留 DSH 原文；应显式分段后重送，不悄悄截断。过滤掉思考、工具输出和注入的记忆，避免递归吸收。当前没有把 DSH 所有旧历史自动导入。

其他 MCP 宿主配置使用 `python -m memora --data <同一 data> setup` 输出。任务开始调用 `memory_digest`，结束发送 `memory_absorb`。不同智能体保留 agent / session / event ID；仅添加 MCP 配置不保证宿主主动使用工具。对云端模型，先在界面显式选云端并填写 HTTPS API，密钥环境变量必须在启动服务前设置。

## 积累与工作流

“工作流与模型编排”显示实际模型可达性、策略、角色、积累任务和阶段输出。新数据目录自动沉淀关闭；本地 `data/accumulation.json` 已启用带核验政策。失败任务重试最多五次，可在页面或 `memory_job_retry` 重开。不要把小模型分数当作概率。

自动提炼默认使用现有 Judge 复用 curator / verifier / relation。可以换成独立本地／云端模型；Embedding 不能绑定生成角色。对文档工作流，每阶段显式选择模型和操作，最多 12 阶段、两项并发、源文档上限 30,000 字符。输出保留为新草稿；源文档并发修改则记录冲突，不覆盖。工作流线程中断不会自动恢复，需查运行记录后重新发起。

## 完整备份和删除

权威文件包括四个 SQLite、所有 Markdown 镜像、模型／策略 JSON、MCP token、DSH 发件箱和游标。完整备份应暂停 DSH 的 Memora 插件／所有 stdio 宿主、停止共享后端并关闭独立桌面后端，确认无写入进程后复制**整个 `data/`**。不要只复制一个正在写入的 SQLite 主文件；WAL 也是状态的一部分。现有单库 backup 工具不提供四库原子快照。

源会话和候选是不同记录；忘记某个派生记忆并不删除原始会话／文档／外部 DSH 记录或备份。需要彻底删除时必须同时处理各来源和副本；不宣称单一 purge 能清除所有外部历史。模型权重和推理环境可单独备份，运行数据库不可混入交付 ZIP。

## 桌面构建与版本

使用 `powershell -NoProfile -ExecutionPolicy Bypass -File tools/Build-Desktop.ps1` 构建，随后运行 `.venv/Scripts/python tools/smoke_desktop.py` 和 `.venv/Scripts/python tools/release.py --skip-build`。PowerShell 构建入口先修正本项目 Python 启动器的 Low 标签，避免构建子进程无权修正程序标签；它不修改系统 Python、模型环境或父目录。

`desktop-standalone/Memora.exe` 是冻结程序，`release/memora-1.1.0-windows-x64.zip` 是同一程序的压缩包。包不带私人数据库／凭据／模型权重。应用 1.1.0、原生检索内核 1.0.2、记忆 schema 2 是三个独立版本概念。

在项目树内桌面自动使用 `data/`、`runtime/desktop-userdata/`，优先附着共享运行时。在其他目录解压则默认使用 Electron 用户数据目录，可通过 `MEMORA_DATA` 指定位置。纯 ZIP 可以离线进行文档／规则／关键词功能；向量和 Judge 功能需连接已有模型端点。源码启动器和 WSL 安装脚本位于仓库，不把 ZIP 误称为自带 GPU 模型的一体镜像。

ZIP 内推荐使用 `Launch-Memora.cmd`；内置 PowerShell 启动冻结后端并尝试桌面，不需要外装语言环境。`-Headless` 仅启动服务，`-Stop` 仅停止便携启动器拥有的服务。便携启动时 data/runtime 默认在解压目录；通过环境变量 MEMORA_DATA / MEMORA_RUNTIME_DIR 可指定其他位置。在开发项目内会优先复用匹配数据目录的共享服务。直接运行 Memora.exe 的默认数据行为保持前述说明。
