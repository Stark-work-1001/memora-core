# 统一记忆系统开发升级验收

验收日期：2026-10-19。源码、合成数据和证据全部位于开发目录。
没有同步、修复、启动 standalone，也没有修改运行中用户的 Codex / DSH 配置。

## 验证范围

最终回归：Python 584 个用例，579 通过、5 跳过、0 失败；前端 130/130，DSH 4/4。
ruff、mypy、TypeScript、PowerShell 语法检查及冻结 MCP 冒烟均通过。

- Python 全套回归、ruff、mypy、前端 TypeScript 检查。
- 前端 130 个测试、DSH 生命周期 4 个测试。
- 8 个模板全部用可控测试模型执行完整声明阶段；另外覆盖原文引文校验、核验失败阻断、
  候选待审及 Markdown 镜像、Embedding 写索引、Rerank 单独处理全文候选、依赖分支隔离。
- 真实 MCP stdio 客户端初始化、列举工具、调用统一检索，既验证源码，也验证开发目录的冻结后端。
- 冻结后端暴露 26 个工具、返回 8 个模板；使用临时空库读取知识上下文。
- 实际浏览器操作：跨来源搜索、加载/保存并行审计模板、文档证据包、3D 选中节点切换到 2D 后保持选中，
  再切回 3D；验证清理后的可读标签仍保留完整 ID 与来源。

机器可读结果：[Python](../reports/unit/unit.json)、[冻结 MCP](../reports/memory-upgrade/frozen-smoke.json)、
[总体验收](../reports/memory-upgrade/validation.json)。
界面证据：[工作流](../reports/memory-upgrade/workflows.jpg)、[2D](../reports/memory-upgrade/brain-2d.jpg)、
[3D](../reports/memory-upgrade/brain-3d.jpg)。界面截图使用工具生成的合成资料，不是用户真实记忆。

## 本次验证发现并修复

1. 源码入口默认启动兄弟目录的桌面成品：改为源码 Electron 壳 / 开发网页。
2. 同版本号会复用旧 Python 后端：增加源码指纹与数据目录、端口一致性检查。
3. Rerank 在无向量模型、嵌入失败、没有向量索引时被跳过：改为可作用于所有第一阶段结果，分页后置。
4. 工作流所有节点都用聊天适配器：按 chat / embedding / rerank / local 能力派发并在保存、运行前验证。
5. 并行分支可能读取非祖先输出：改为按依赖可达集合传递状态。
6. 工作流取消按钮漏传运行 ID：修复前后端契约。
7. 文档证据路由存在但界面仍称缺失：接通真实 `DocIndex.rag`，保留文档引用及预算。
8. 运行中的提炼调用没有解析已保存的字面密钥：沿用角色凭据解析，凭据不进入模型池或运行轨迹。
9. 冻结 MCP 原始启动未设置同卷临时目录，无法初始化 SQLite：在 CLI / MCP 入口创建库内 `.tmp`，
   并补入生成的宿主配置；冻结后端冒烟不手动传 TEMP/TMP，用以覆盖原来的真实失败路径。

## 验证边界

没有下载新模型权重，没有调用远程付费模型，也没有测得上游论文同等质量。
8 个模板的执行测试使用可控模型；真实部署的正确率、延迟、模型血缘独立性需要另行测量。
本地缺少 DSH profile 的 4 个宿主测试和未安装可选 pypdf 的 1 个 PDF 测试会明确跳过。
DSH 接入通过原始事件接口和生命周期单测；不宣称已经重载并验证用户的真实宿主。

Windows HTTP fixture 关闭线程的 WinError 10038 日志在升级前基线已存在；全套用例结果中
不计为应用请求失败。本次保留其日志，不声称消除了这类测试清理噪声。
3D 保留现有移植渲染器和布局体系；已验证可读性与选中保持，不声称逐像素复刻参考站点。

## 复现

```powershell
.venv/Scripts/python.exe -m ruff check .
.venv/Scripts/python.exe -m mypy
node frontend/node_modules/typescript/bin/tsc --noEmit -p frontend/tsconfig.json
# 在 frontend/ 下执行 node --test tests/*.test.mjs 与 node build.mjs
node --test integrations/dsh/memora-plugin.test.mjs
.venv/Scripts/python.exe tools/build_desktop.py --backend-only
.venv/Scripts/python.exe tools/verify_memory_upgrade_frozen.py
.venv/Scripts/python.exe tools/run_checks.py
```

构建必须先结束再跑全套测试，防止产物比对在构建中途读取文件。此处所有构建命令均不更新 standalone。
