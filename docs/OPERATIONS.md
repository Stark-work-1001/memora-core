# 运行与维护手册

## 一、启动

### 桌面版
双击 `MemoraCore.exe`。首次启动会在用户数据目录创建 `data/`，写入 schema、18 条工作流模板、
34 条算法目录、6 个智能体登记，然后监听 `http://127.0.0.1:8790`。

数据目录位置（按优先级）：

1. 显式 `--data` 参数
2. `MEMORA_HOME` 环境变量
3. 打包版：可执行文件同级的 `data/`
4. 源码运行：仓库根目录的 `data/`

### 源码
```
python -m memora_core setup          # 建库 + 灌入内置资产（幂等）
python -m memora_core serve          # 启动界面与 API
python -m memora_core serve --port 9000 --data D:/memora-data
python -m memora_core doctor         # 打印数据库健康与内置资产计数
```

### MCP stdio（给智能体）
```
python -m memora_core --data <dir> mcp-stdio
```
stdout 只输出协议帧，所有日志走 stderr。**不要**在这个进程里 print 调试信息。

## 二、端口与网络

| 用途 | 默认 | 说明 |
|---|---|---|
| HTTP API + 界面 | 127.0.0.1:8790 | 只绑回环，校验 Host 头 |
| MCP HTTP | 127.0.0.1:8790/mcp | 与 HTTP 同端口 |
| MCP stdio | 无端口 | 由客户端拉起子进程 |

外部访问需要自己加反向代理；中枢本身**故意不支持**对外监听，避免误暴露。

## 三、目录与文件

```
data/
  memora.db            事务真源（WAL，可能伴随 -wal / -shm）。模型档位在 model_profile 表，
                       加密后的密钥在 secret 表，设置在 setting 表
  master.key           加密 secret 表用的 32 字节主密钥（见「九、隐私」）
  vault/               Markdown 镜像（派生产物，可重建；secret 记忆的正文不写进来）
    daily/YYYY-MM-DD.md   按**本地**日历日的流水（ADR-0003）
    memories/<id>.md      每条记忆一页
    notes/                吸收进来的外部文档
    reports/              审计 / 复盘 / 学习报告
  inbox/               服务运行时每 10 秒检查一次：5 秒内没再变化的文件会被吸收，
                       之后移到 inbox/processed/（失败移到 inbox/failed/）
  exports/  backups/  heartbeat/  logs/  tmp/   启动时创建的目录（backups/ 目前不会自动写入）
```

## 四、备份与恢复

- **备份**：停服后复制整个 `data/` 目录即可；或只拷 `memora.db`（先执行
  `PRAGMA wal_checkpoint(TRUNCATE);` 保证数据落盘）。
- **恢复**：把备份目录放回原位，重启。
- **重建镜像**：Markdown 是派生产物，删掉后可在设置页点「重建 Markdown 镜像」，
  由数据库重新生成；反过来用 Markdown 覆盖数据库是**不允许**的。

## 五、索引维护

| 场景 | 动作 |
|---|---|
| 导入大量文档后搜不到 | 设置页「重建索引」，或 `POST /api/documents/{id}/reindex` |
| 向量维度改了模型 | 需要重算全部向量；界面会标出维度不匹配的条目 |
| 记忆被合并/推翻 | 索引自动增量更新；若出现孤儿向量，跑「增量索引维护」工作流清理 |

## 六、模型不可用时的行为

中枢不会因为模型挂掉而拒绝服务，但会**显式降级**：

| 角色 | 降级为 |
|---|---|
| chat | 抽取式摘要（首句 + 要点） |
| embedding | 混合检索不再有向量通道，只跑 BM25 + 子串 + 图（1.0.0 用本地 hash 指纹冒充向量通道，反而拉低质量：nDCG@10 0.455 vs 0.550，见 docs/retrieval.md） |
| reranker | 不重排，保持 RRF 融合顺序 |
| judge | 阈值规则（余弦 / Jaccard / SimHash 分层） |

界面上会出现橙色的「离线降级」标识，API 返回里 `degraded` 字段非空。
**这不是错误，是设计**：记忆中枢的核心价值是本地可用。

## 七、故障排查

| 症状 | 排查 |
|---|---|
| 界面白屏 | 后端没起来。看 `data/logs/`，或命令行跑 `python -m memora_core doctor` |
| 端口被占用 | `netstat -ano | findstr 8790`，换 `--port` |
| 数据库锁住 | 有第二个进程打开了同一个 `memora.db`。WAL 允许多读单写，但不允许多写 |
| 搜索结果为空 | 先确认记忆状态是 approved（candidate 不参与默认召回）；再试「重建索引」 |
| MCP 连不上 | 用 `memory_health` 自检；检查是否把调试输出打到了 stdout |
| 桌面版启动失败 | 看 `%APPDATA%\MemoraCore\logs\backend.log`（外壳与后端共用这一份日志） |
| 后端拒绝启动：数据库结构版本比本程序新 | 数据库来自更新版本的 memora-core；用新版本打开，库文件没有被改动（ADR-0004） |

## 八、升级

1. 备份 `data/`。
2. 替换程序目录（数据目录与程序目录分离，不会被覆盖）。
3. 启动时按 `PRAGMA user_version` 执行 schema 迁移（每个版本一个事务，失败整体回滚）；遇到比
   程序更新的数据库会拒绝启动而不是改写它（ADR-0004）。`/api/health` 的 `schema_version` 给出当前版本。
4. 版本号变了但模板没变的话不需要重新灌种子数据。

## 九、隐私

- 所有数据默认只在本地。除非你**显式配置**了云端模型并触发相关工作流，不会有任何出网请求。
- 密钥加密后存进 `secret` 表，接口永远不回显明文。加密用的是 `data/master.key`：
  - **Windows 上新建的主密钥**由 DPAPI 封装（文件以 `MKDPAPI1` 开头），绑定当前 Windows 用户：
    别人拿到 `data/` 目录也解不开；代价是把 `data/` 拷到另一台电脑或另一个用户后，已保存的
    API key 要重新填写（模型页会明确提示 `master.key 由 Windows DPAPI 绑定在另一台电脑……`）。
  - **1.0.0 留下的主密钥**是 32 字节明文，照常可用、不会被自动改写；拿到整个 `data/` 目录的人
    能解密它。想换成 DPAPI：把 `master.key` 改名备份，然后在模型页重新填写 API key。
  - 主密钥文件损坏时明确报错、**不覆盖**（1.0.0 会静默替换，之前保存的密钥从此解不开且没有提示）。
- 敏感记忆可标 `sensitivity=secret`：导出默认**不包含**它们（`include_secret=1` / `--include-secret`
  才导出），Markdown 镜像里不写正文，agent 侧的召回 / 摘要不返回它们。
## 十、Windows 下的两个环境陷阱（实测记录）

### 1. cmd / PowerShell 的 curl 发中文 JSON 会被编码破坏

现象：用 `curl -X POST ... -d '{...中文...}'` 时服务端返回 `400 BAD_JSON`。
原因：Windows 控制台默认代码页不是 UTF-8，命令行参数在传给 curl 之前已被转成本地编码。

**这不是服务端的 bug** —— 它正确地拒绝了非法 JSON。正确做法是用 UTF-8 客户端：

    python -c "import json,urllib.request as u; d=json.dumps({'title':'中文'},ensure_ascii=False).encode('utf-8'); r=u.Request('http://127.0.0.1:8790/api/memories',data=d,headers={'Content-Type':'application/json'},method='POST'); print(u.urlopen(r).read().decode('utf-8'))"

### 2. MCP stdio 在 Windows 下的解码

MCP stdio 协议帧是 UTF-8。用 `subprocess.run(..., text=True)` 在中文 Windows 上会走 GBK，
遇到中文记忆内容直接 `UnicodeDecodeError`。正确做法：

    p = subprocess.run(cmd, input=payload.encode('utf-8'), capture_output=True)
    replies = [json.loads(l) for l in p.stdout.decode('utf-8').splitlines() if l.startswith('{')]

对 MCP 客户端开发者的建议：**始终用 UTF-8 字节流与 memora-core 交换**，不要依赖系统 locale。
