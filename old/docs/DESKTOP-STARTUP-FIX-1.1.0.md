# Memora 1.1.0：封装后无法启动的修复

2026-10-16。在当前 Windows 主机定位并修复 `desktop-standalone/Memora.exe` 的启动问题，应用版本仍为 1.1.0。

## 原因与复现实验

打包输出继承了开发目录的 **Low（低完整性）Windows 强制标签**。这与普通文件读写权限（DACL）、下载文件的 Zone.Identifier 是不同机制。低完整性 EXE 会让新进程以低完整性启动，导致本地 Electron 在进入主程序和创建窗口前退出。单独修正 EXE 后，低完整性的运行库又阻止页面正常加载。

| 隔离实验 | 结果 |
|---|---|
| 原始程序和运行库均为 Low，默认沙箱 | 窗口出现前退出：`0x80000003`，十进制 `-2147483645` |
| 临时增加受限应用包读取权限 | 仍失败；该临时权限已撤销，不属于修复方案 |
| 只把 Memora.exe 改为 Medium | 能进入主程序，但 `loadURL` 报 `ERR_FAILED (-2)`；网络日志显示本地后端实际返回 HTTP 200 |
| 程序、DLL、resources 和 locales 均为 Medium，保留原 DACL | 默认沙箱 smoke 退出 0，输出 `MEMORA_DESKTOP_READY memora · 记忆体` |

这些对照确认了完整性标签是当前机器上的直接原因。此前文档把它笼统归为“自动化环境限制”，并使用关闭沙箱的隔离测试，判断不充分；本次以默认沙箱成功启动替代该结论。运行库问题与 Windows 阻止 Low 标签镜像的缓解策略一致，但没有把网络正常返回当作渲染成功。

## 修复与防复发

- 已就地修正用户指定的 unpacked 程序及其运行库；不依赖 `--no-sandbox` 或管理员兼容模式。
- `desktop/Repair-Desktop.ps1` 仅修正应用根目录、根文件、resources / locales 的强制标签到 Medium；不重置 DACL，不递归处理 data / runtime，不修改模型、共享数据库、其他软件或磁盘父目录。遇到程序路径中的重解析点拒绝操作。
- 构建结尾执行并检查标签；开发用 Electron 解压后同样处理，避免源码 UI 验证继续掩盖问题。
- 开发树内的 `.venv/Scripts/python.exe` 也继承了 Low，其子进程无法给构建产物设置更高标签。已单独修正该启动器；以后使用 `tools/Build-Desktop.ps1` 从正常 Windows 会话构建，脚本先准备本项目 Python 启动器，再运行构建。Python 构建脚本发现解释器为 Low 时会明确拒绝，而不是继续产出坏包。
- 源码启动器和包内 `Launch-Memora.cmd` 在启动前调用修复。ZIP 不携带 NTFS 强制标签；如果再次解压到会继承 Low 的目录，先运行 `Launch-Memora.cmd` 或 `Repair-Desktop.cmd`，之后可直接打开 Memora.exe。修复失败会报告原因，不自动提权或关闭沙箱。
- 冻结包 smoke 必须在默认沙箱下成功。发布打包器拒绝默认启动非零、缺少标签检查或使用过沙箱绕过的验证报告。内容 SHA 与 Windows 标签分别检查，因为 SHA 不涵盖 NTFS 安全元数据。

## 验证与证据

原始故障及分阶段日志位于开发目录 `artifacts/startup-investigation/`，包括 baseline、medium、medium-all 的 stdout / stderr 和仅包含合成数据的网络日志；这些本地诊断材料不打入 ZIP。早期失败的 smoke 报告另存 `smoke-before-fix.json`。

修复脚本以隔离应用树验证：代码变为 Medium，data / runtime 的合成哨兵文件仍为 Low，内容保留。最终冻结包验证见 `build/reports/SMOKE_VALIDATION.json`，其中 `desktop_default_exit_code` 必须为 0，`windows_integrity` 记录程序路径检查数。实际可见窗口检查另见 `artifacts/startup-investigation/visible-launch.json`。本次只修复桌面封装与启动流程，既有模型部署和记忆功能的业务验证见 `VALIDATION-1.1.0.md`。

## 官方参考

- [Microsoft Mandatory Integrity Control](https://learn.microsoft.com/en-us/windows/win32/secauthz/mandatory-integrity-control)：可执行文件标签与新进程完整性之间的关系。
- [Microsoft PROCESS_MITIGATION_IMAGE_LOAD_POLICY](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-process_mitigation_image_load_policy)：阻止加载 Low 标签运行库的策略。
- [Microsoft TOKEN_MANDATORY_POLICY](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-token_mandatory_policy)：新进程最小完整性策略。
- [Electron Windows sandbox issue #51761](https://github.com/electron/electron/issues/51761)：用于对照调查 DACL 问题；本地该方向的读取权限实验未解决故障，未采用其权限变更方案。
