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
  memora.db            事务真源（WAL，可能伴随 -wal / -shm）
  vault/               Markdown 镜像
    daily/YYYY-MM-DD.md   按日期的流水
    memories/<id>.md      每条记忆一页
    notes/                吸收进来的外部文档
    reports/              审计 / 复盘 / 学习报告
    README.md             自动生成的库索引
  inbox/               把文件丢这里会被自动吸收
  exports/             导出产物
  heartbeat/           外部智能体写心跳的目录
  backups/             自动备份
  models.json          模型档位配置（不含密钥）
  secrets.bin          加密后的密钥
  logs/                运行日志
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
| embedding | 本地字符 n-gram 哈希向量（256 维，确定性） |
| reranker | 分数透传 + FTS 加权 |
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
| 桌面版启动失败 | 看 `%APPDATA%\memora-core\logs\backend.log` |

## 八、升级

1. 备份 `data/`。
2. 替换程序目录（数据目录与程序目录分离，不会被覆盖）。
3. 启动时自动执行 schema 迁移（幂等 `CREATE TABLE IF NOT EXISTS` + `meta.schema_version`）。
4. 版本号变了但模板没变的话不需要重新灌种子数据。

## 九、隐私

- 所有数据默认只在本地。除非你**显式配置**了云端模型并触发相关工作流，不会有任何出网请求。
- 密钥用本机派生的主密钥加密后存 `secrets.bin`，接口永远不回显明文。
- 敏感记忆可标 `sensitivity=secret`，导出时会脱敏。
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
