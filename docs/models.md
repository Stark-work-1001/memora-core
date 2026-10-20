# 模型网关与判定层（models / judge / secrets）

> 契约见 `docs/ARCHITECTURE.md` §4.4 §8。本文只讲**怎么配、怎么坏、怎么观测**。

## 0. 一句话

`ModelGateway` 把 chat / embedding / reranker / judge / extractor / vision 六种角色接到云端，密钥加密落盘，
每次调用留痕，**任何失败都抛** `ModelUnavailable`，由上层走确定性降级并标 `degraded=true`。
网关**永远不会**返回零向量、假 embedding 或编造的 JSON。

## 1. 配置

档位存在 `model_profile` 表（运行时真源是 SQLite；`data/models.json` 是运维侧可读副本）：

| 字段 | 说明 |
|---|---|
| id | 主键，建议 `<role>-<provider>-<model>` |
| role | chat / embedding / reranker / judge / extractor / vision |
| provider | openai / openai-compatible / dashscope / deepseek / ollama / none |
| model | 提供方模型名 |
| base_url | 服务根地址，**不要**带 `/v1` |
| api_key_ref | `env:VAR` 读环境变量；其它值视为 `secret.key` |
| priority | 越大越优先；同 role 取 enabled=1 中最大的 |
| batch / timeout_ms | 批大小（默认 16）/ 超时（默认 60000） |
| params | JSON，支持 dimensions / top_p / stop 等透传 |

`provider=none` 是**显式禁用**该 role（用户只想离线跑），health 里为 `configured=false`。

### 1.1 真实配置示例（`data/models.json`）

```json
{
  "profiles": [
    {
      "id": "chat-deepseek",
      "role": "chat",
      "label": "DeepSeek Chat",
      "provider": "openai",
      "model": "deepseek-chat",
      "base_url": "https://api.deepseek.com",
      "api_key_ref": "env:DEEPSEEK_API_KEY",
      "priority": 30,
      "batch": 16,
      "timeout_ms": 60000,
      "params": {"top_p": 0.95},
      "enabled": 1
    },
    {
      "id": "embed-dashscope",
      "role": "embedding",
      "label": "通义 text-embedding-v4",
      "provider": "dashscope",
      "model": "text-embedding-v4",
      "base_url": "https://dashscope.aliyuncs.com",
      "api_key_ref": "env:DASHSCOPE_API_KEY",
      "dim": 1024,
      "batch": 16,
      "priority": 20,
      "enabled": 1
    },
    {
      "id": "rerank-dashscope",
      "role": "reranker",
      "label": "通义 qwen3-rerank",
      "provider": "dashscope",
      "model": "qwen3-rerank",
      "base_url": "https://dashscope.aliyuncs.com",
      "api_key_ref": "env:DASHSCOPE_API_KEY",
      "priority": 20,
      "enabled": 1
    },
    {
      "id": "judge-local-vllm",
      "role": "judge",
      "label": "qwen3.8-27b（自建 vLLM）",
      "provider": "openai-compatible",
      "model": "qwen3.8-27b",
      "base_url": "http://127.0.0.1:8000",
      "api_key_ref": "",
      "priority": 10,
      "timeout_ms": 120000,
      "enabled": 1
    }
  ]
}
```

> 模型名以官方文档为准：DashScope 的 embedding 是 `text-embedding-v4`（1024 维默认），
> 重排是 `qwen3-rerank`（把候选集换成 `qwen3-reranker-8b` 只是换成自定义部署的模型名）。
> 换模型只改 `model` 与 `dim`，协议不用动。

密钥**不写在这里**。`env:DEEPSEEK_API_KEY` 表示运行时读环境变量；要落库则把 `api_key_ref`
改成 `deepseek`，再用 `gw.set_secret("deepseek", "sk-...")` 加密写入 `secret` 表。

## 2. 各 provider 的协议差异

| provider | chat | embedding | rerank |
|---|---|---|---|
| openai / openai-compatible / deepseek / 自建 vLLM | `POST {base}/v1/chat/completions` | `POST {base}/v1/embeddings` | 先 `{base}/v1/rerank`，404/405 再试 `{base}/rerank` |
| dashscope（阿里百炼） | `{base}/compatible-mode/v1/chat/completions` | `{base}/compatible-mode/v1/embeddings` | `{base}/api/v1/services/rerank/text-rerank/text-rerank`（body 为 `{model,input:{query,documents},parameters}`） |
| ollama | `{base}/api/chat` | `{base}/api/embed` | 无原生支持，抛 `ModelUnavailable` 由上层降级 |
| none | 禁用 | 禁用 | 禁用 |

响应解析做了兼容：chat 认 `choices[0].message.content` / `response` / `output_text`；
embedding 认 `data[].embedding` / `embeddings` / `output.embeddings`；
rerank 认 `results[].index` 配 `relevance_score` 或 `score`，也认顶层 `data`。

## 3. 密钥安全

- master key：`data/master.key`，首次使用时生成 32 字节随机数；1.1.0 起在 Windows 上用 DPAPI
  封装（文件以 `MKDPAPI1` 开头，绑定当前 Windows 用户）。1.0.0 留下的 32 字节明文主密钥照常可用。
  已有文件绝不覆盖：损坏或在别处封装的主密钥抛 `SecretKeyUnavailable`，说明原因（1.0.0 会静默替换）。
  首次创建用独占创建，两个进程同时首次使用不会各写一把。
- 派生：`k = HMAC-SHA256(master, "MEMORA-SECRETS-V1" | nonce | counter)`，与明文字节异或（计数器模式流密码）。
- 每条密文带 16 字节随机 nonce，同一明文两次加密结果不同。
- 完整性：`HMAC-SHA256(master, "MEMORA-SECRETS-AUTH-V1" | nonce | body)[:16]`，篡改任意一位则解密抛错。
- 密文格式：`base64("mbx1" | nonce(16) | tag(16) | body)`，存 `secret.cipher`。
- **API 永不返回明文**：`list_secrets()` 只给 key / hint / updated_at，hint 是 `****` 加后 4 位。

### 为什么不是军规级

| 缺什么 | 后果 |
|---|---|
| 没有口令 KDF（Argon2/PBKDF2 + salt） | master key 直接是 32 字节随机数，拿到 `data/` 就能解 |
| 不是认证加密（AEAD） | 完整性靠独立 HMAC，正确但非标准封装，无 associated data |
| 没有密钥轮换与版本号 | 只能一次性重加密全部密文 |
| 纯 Python 逐字节异或 | 无常数时间保证；无内存清零，密钥残留在 GC 里 |
| 非 Windows 上无系统密钥库绑定 | 文件复制到另一台机器仍然可解（Windows 上新建的主密钥由 DPAPI 绑定当前用户） |

它的定位是**防止密钥以明文出现在数据库、备份、导出包、日志和 git 里**，不是防御本机提权。

## 4. 失败语义（绝不伪造）

| 情形 | 行为 |
|---|---|
| 未配置 / provider=none | `ModelUnavailable(role, "未配置" 或 "该角色被显式禁用")` |
| 网络错误、超时、5xx | 后台调用重试 2 次（退避 0.5s / 1.5s），仍失败抛 `retryable=True` |
| 交互式调用（检索时的 embed / rerank） | `interactive()` 快速失败：只试 1 次，单次 ≤ 4 s、合计 ≤ 8 s（1.0.0 一个挂起的端点让每次搜索卡 15 s 起） |
| 熔断 | 超时、连接错误、5xx、429 之后该角色 60 s 内视为不可用，不再发网络请求；`health()` 的 `ok`/`degraded`/`last_error` 如实反映；4xx 不触发；手动「测试连接」绕过熔断 |
| 4xx | **不重试**，直接抛，并记录 `http_status` |
| 端点不存在（404/405） | rerank 先试 `/v1/rerank` 再试 `/rerank`，都 404 才失败 |
| 响应缺字段 / 向量条数不符 / 零向量 | 抛 `ModelUnavailable`，绝不补零 |
| 模型返回的不是 JSON | 抛 `JudgeFormatError`（带 `raw` 原文） |

判定层（`judge.py`）捕获这两类异常后一律走确定性规则兜底，返回 `degraded: true` 与
`reason`（形如 `规则兜底：…｜LLM：模型不可用(未配置)`）：

| 函数 | 规则兜底 |
|---|---|
| classify | 关键词判 kind/category，强/中/弱词判 importance |
| dedup_verdict | 相似度阈值 0.95 / 0.86 / 0.72 / 0.55 映射 noop / update / merge / link，否则 add，未知 ask |
| conflict_verdict | 数值差异、否定极性、推翻词（改为/不再/取代）、来源 trust 差 |
| verify_claims | 逐句 CJK bigram 重叠不低于 0.5，或原文子串命中即算支撑 |
| summarize | 抽取式：首句 + 按长度补句到预算 |
| abstraction_cues | 标题转问句 + 关键实体问句 |

## 5. 留痕与成本观测

每次调用（无论成败）写一条 `model_call`：
role / provider / model / ok / http_status / latency_ms / prompt_tokens / completion_tokens /
error / degraded / run_id / created_at。
token 优先取响应 `usage`，缺失时按「CJK 1 token，其余 1 token / 4 字符」估算。

`health()` 每个 role 固定返回 8 个字段（0 配置 / 部分配置 / 全配置结构一致）：

```python
{
  "configured": True, "model": "deepseek-chat", "provider": "openai",
  "ok": True, "degraded": False, "last_error": None,
  "calls_24h": 42, "avg_latency_ms": 830
}
```

`status()` 再聚合出 `degraded_roles`，前端直接用它显示「当前处于离线降级」。

## 6. 自测

```bash
python -m unittest tests.test_models tests.test_judge -v
```

47 项，全部走本地 `http.server` 假服务器（随机端口），覆盖：正常通路、500 重试 2 次、
401 不重试、超时、错误 JSON、密钥往返与篡改、health 三态结构一致、规则兜底六个函数。
