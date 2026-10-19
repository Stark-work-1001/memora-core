-- memora-core / 记忆中枢 · SQLite schema v1
-- 事务真源：所有记忆、证据、关系、工作流运行、模型观测都在这里。
-- Markdown 是人类的可读镜像，不是第二个写入者。
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ============================================================
-- 1. 智能体：静态登记 + 运行在场 + 会话
-- ============================================================
CREATE TABLE IF NOT EXISTS agent (
  id                TEXT PRIMARY KEY,           -- slug: dsh-desktop / claude-code / codex-cli
  display_name      TEXT NOT NULL,
  ecosystem         TEXT NOT NULL,              -- dsh | codex | claude-code | cursor | generic-mcp | custom
  kind              TEXT NOT NULL DEFAULT 'unknown', -- chat | coding | plugin | mcp-client | unknown
  status            TEXT NOT NULL DEFAULT 'offline', -- online | idle | offline
  first_seen        TEXT NOT NULL,
  last_seen         TEXT NOT NULL,
  last_heartbeat    TEXT,
  heartbeat_source  TEXT,                       -- process | port | mcp | file | manual
  capabilities      TEXT NOT NULL DEFAULT '{}', -- JSON
  metadata          TEXT NOT NULL DEFAULT '{}', -- JSON
  static_registered INTEGER NOT NULL DEFAULT 0,
  enabled           INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS agent_probe (
  id         TEXT PRIMARY KEY,
  agent_id   TEXT,
  probe      TEXT NOT NULL,        -- process | port | heartbeat-file | mcp-handshake
  target     TEXT,
  state      TEXT NOT NULL,        -- found | absent | error
  detail     TEXT,
  latency_ms INTEGER,
  at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_session (
  id           TEXT PRIMARY KEY,
  agent_id     TEXT NOT NULL,
  external_id  TEXT,
  title        TEXT,
  cwd          TEXT,
  scope_id     TEXT,
  status       TEXT NOT NULL DEFAULT 'active',  -- active | ended | abandoned
  started_at   TEXT NOT NULL,
  ended_at     TEXT,
  spec         TEXT NOT NULL DEFAULT '{}',
  UNIQUE(agent_id, external_id)
);

-- ============================================================
-- 2. 作用域：全局 / 工作区 / 智能体 / 任务 / 对话 / 文档
-- ============================================================
CREATE TABLE IF NOT EXISTS scope (
  id         TEXT PRIMARY KEY,          -- 'global' | 'agent:claude-code' | 'workspace:<slug>'
  kind       TEXT NOT NULL,             -- global|workspace|agent|task|conversation|document
  parent_id  TEXT,
  path       TEXT NOT NULL UNIQUE,      -- 斜杠路径，父在前
  name       TEXT,
  metadata   TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

-- ============================================================
-- 3. 文档库（Markdown 镜像 + 外部吸收）
-- ============================================================
CREATE TABLE IF NOT EXISTS document (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,            -- daily|note|source|index|report|review
  path        TEXT NOT NULL UNIQUE,     -- vault 相对路径
  title       TEXT,
  scope_id    TEXT,
  day         TEXT,                     -- YYYY-MM-DD
  hash        TEXT NOT NULL,
  bytes       INTEGER NOT NULL DEFAULT 0,
  frontmatter TEXT NOT NULL DEFAULT '{}',
  origin      TEXT NOT NULL DEFAULT 'memora', -- memora|import|agent
  status      TEXT NOT NULL DEFAULT 'active',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  indexed_at  TEXT
);

CREATE TABLE IF NOT EXISTS chunk (
  id          TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES document(id) ON DELETE CASCADE,
  ordinal     INTEGER NOT NULL,
  heading     TEXT,
  level       INTEGER,
  text        TEXT NOT NULL,
  tokens      INTEGER NOT NULL DEFAULT 0,
  start_line  INTEGER,
  end_line    INTEGER,
  hash        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS chunk_doc ON chunk(document_id);

CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(
  text, heading, content='chunk', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2'
);

-- ============================================================
-- 4. 记忆原子
-- ============================================================
CREATE TABLE IF NOT EXISTS memory (
  id            TEXT PRIMARY KEY,
  scope_id      TEXT NOT NULL,
  agent_id      TEXT,
  session_id    TEXT,
  kind          TEXT NOT NULL,          -- fact|knowledge|decision|preference|procedure|experience|task|turn|tool|artifact
  category      TEXT,
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,
  summary       TEXT,
  didactic      TEXT NOT NULL DEFAULT '{}',  -- 定义/定理/特征/公式/推导/例题 JSON
  status        TEXT NOT NULL DEFAULT 'candidate', -- candidate|approved|rejected|draft|superseded|merged|archived
  trust         REAL NOT NULL DEFAULT 0.5,
  importance    REAL NOT NULL DEFAULT 0.5,
  confidence    REAL NOT NULL DEFAULT 0.5,
  sensitivity   TEXT NOT NULL DEFAULT 'normal',  -- normal|private|secret
  stability     REAL,
  difficulty    REAL,
  review_due    TEXT,
  review_count  INTEGER NOT NULL DEFAULT 0,
  last_reviewed TEXT,
  valid_from    TEXT,
  valid_to      TEXT,
  recorded_at   TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  superseded_by TEXT,
  merged_into   TEXT,
  lang          TEXT,
  source_count  INTEGER NOT NULL DEFAULT 0,
  tokens        INTEGER NOT NULL DEFAULT 0,
  pinned        INTEGER NOT NULL DEFAULT 0,
  metadata      TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS memory_scope  ON memory(scope_id, status);
CREATE INDEX IF NOT EXISTS memory_kind   ON memory(kind, status);
CREATE INDEX IF NOT EXISTS memory_agent  ON memory(agent_id);
CREATE INDEX IF NOT EXISTS memory_due    ON memory(review_due);
CREATE INDEX IF NOT EXISTS memory_record ON memory(recorded_at);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  title, body, summary, content='memory', content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);

-- ============================================================
-- 5. 证据 / 实证（"怎么知道的"）
-- ============================================================
CREATE TABLE IF NOT EXISTS evidence (
  id          TEXT PRIMARY KEY,
  memory_id   TEXT REFERENCES memory(id) ON DELETE CASCADE,
  document_id TEXT,
  chunk_id    TEXT,
  session_id  TEXT,
  turn_id     TEXT,
  kind        TEXT NOT NULL,   -- user_stated|agent_asserted|tool_output|document|web|derived|verification|code_run
  quote       TEXT,
  uri         TEXT,
  hash        TEXT,
  trust       REAL NOT NULL DEFAULT 0.5,
  verified    INTEGER NOT NULL DEFAULT 0,
  verifier    TEXT,
  note        TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS evidence_memory ON evidence(memory_id);

-- ============================================================
-- 6. 富形式块：公式 / 图片 / 代码 / 表格 / 数据库引用
-- ============================================================
CREATE TABLE IF NOT EXISTS block (
  id        TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL REFERENCES memory(id) ON DELETE CASCADE,
  ordinal   INTEGER NOT NULL DEFAULT 0,
  type      TEXT NOT NULL,        -- formula|image|code|table|database|list|quote|derivation
  lang      TEXT,
  caption   TEXT,
  content   TEXT NOT NULL DEFAULT '',
  fields    TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS block_memory ON block(memory_id);

-- ============================================================
-- 7. 实体与关系（词义脑图 / 层级脑图的数据基础）
-- ============================================================
CREATE TABLE IF NOT EXISTS entity (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  kind       TEXT,                 -- concept|person|project|tool|term|model|file|org
  definition TEXT,
  scope_id   TEXT,
  importance REAL NOT NULL DEFAULT 0.5,
  created_at TEXT NOT NULL,
  UNIQUE(name, kind)
);

CREATE TABLE IF NOT EXISTS memory_entity (
  memory_id TEXT NOT NULL REFERENCES memory(id) ON DELETE CASCADE,
  entity_id TEXT NOT NULL REFERENCES entity(id) ON DELETE CASCADE,
  role      TEXT NOT NULL DEFAULT 'mention',
  PRIMARY KEY (memory_id, entity_id, role)
);

CREATE TABLE IF NOT EXISTS edge (
  id         TEXT PRIMARY KEY,
  src        TEXT NOT NULL,
  src_kind   TEXT NOT NULL,      -- memory|entity|chunk|document
  dst        TEXT NOT NULL,
  dst_kind   TEXT NOT NULL,
  rel        TEXT NOT NULL,      -- semantic|hypernym|hyponym|part_of|instance_of|causes|contradicts|supports|supersedes|derived_from|mentions|temporal_next|alias|prerequisite
  weight     REAL NOT NULL DEFAULT 1.0,
  confidence REAL NOT NULL DEFAULT 0.5,
  origin     TEXT NOT NULL DEFAULT 'explicit', -- explicit|inferred|llm|cooccurrence
  valid_from TEXT,
  valid_to   TEXT,
  metadata   TEXT NOT NULL DEFAULT '{}',
  UNIQUE(src, src_kind, dst, dst_kind, rel)
);
CREATE INDEX IF NOT EXISTS edge_src ON edge(src);
CREATE INDEX IF NOT EXISTS edge_dst ON edge(dst);

-- ============================================================
-- 8. 向量缓存（离线可算，云端可灌）
-- ============================================================
CREATE TABLE IF NOT EXISTS vector (
  owner_kind TEXT NOT NULL,      -- memory|chunk|entity|query
  owner_id   TEXT NOT NULL,
  model      TEXT NOT NULL,
  dim        INTEGER NOT NULL,
  vec        BLOB NOT NULL,      -- float32 little-endian
  norm       REAL NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_kind, owner_id, model)
);

-- ============================================================
-- 9. 候选 / 去重 / 冲突（判定层）
-- ============================================================
CREATE TABLE IF NOT EXISTS candidate (
  id          TEXT PRIMARY KEY,
  batch_id    TEXT,
  memory_id   TEXT,
  scope_id    TEXT,
  action      TEXT NOT NULL DEFAULT 'add', -- add|update|supersede|merge|link|noop|ask
  target_id   TEXT,
  payload     TEXT NOT NULL DEFAULT '{}',
  dedup       TEXT NOT NULL DEFAULT '{}',
  judge       TEXT NOT NULL DEFAULT '{}',
  status      TEXT NOT NULL DEFAULT 'pending', -- pending|auto_applied|needs_review|applied|rejected
  run_id      TEXT,
  created_at  TEXT NOT NULL,
  decided_at  TEXT
);
CREATE INDEX IF NOT EXISTS candidate_status ON candidate(status);

CREATE TABLE IF NOT EXISTS conflict (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,        -- duplicate|contradiction|stale|scope_clash|source_clash|orphan
  a_id        TEXT,
  b_id        TEXT,
  score       REAL NOT NULL DEFAULT 0,
  detail      TEXT NOT NULL DEFAULT '{}',
  status      TEXT NOT NULL DEFAULT 'open',  -- open|resolved|ignored
  resolution  TEXT,
  created_at  TEXT NOT NULL,
  resolved_at TEXT
);

-- ============================================================
-- 10. 工作流（模板 + 运行 + 步骤）
-- ============================================================
CREATE TABLE IF NOT EXISTS workflow_template (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  category    TEXT,
  version     INTEGER NOT NULL DEFAULT 1,
  spec        TEXT NOT NULL,          -- JSON DAG
  builtin     INTEGER NOT NULL DEFAULT 1,
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_run (
  id           TEXT PRIMARY KEY,
  template_id  TEXT,
  template_name TEXT,
  scope_id     TEXT,
  trigger      TEXT,                 -- manual|ingest|session-end|schedule|agent
  status       TEXT NOT NULL,        -- queued|running|ok|failed|partial|cancelled
  input        TEXT NOT NULL DEFAULT '{}',
  output       TEXT NOT NULL DEFAULT '{}',
  error        TEXT,
  parent_run_id TEXT,
  created_at   TEXT NOT NULL,
  started_at   TEXT,
  finished_at  TEXT,
  metadata     TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS workflow_step (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES workflow_run(id) ON DELETE CASCADE,
  ordinal     INTEGER NOT NULL,
  node_id     TEXT NOT NULL,
  name        TEXT,
  kind        TEXT,                  -- retrieve|classify|extract|embed|rerank|judge|merge|verify|persist|review|emit|branch|degrade
  status      TEXT NOT NULL DEFAULT 'pending',
  model       TEXT,
  input       TEXT NOT NULL DEFAULT '{}',
  output      TEXT NOT NULL DEFAULT '{}',
  error       TEXT,
  degraded    INTEGER NOT NULL DEFAULT 0,
  started_at  TEXT,
  finished_at TEXT,
  tokens      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS step_run ON workflow_step(run_id);

-- ============================================================
-- 11. 模型接入（对话 / 向量 / 重排 / 判定）
-- ============================================================
CREATE TABLE IF NOT EXISTS model_profile (
  id          TEXT PRIMARY KEY,
  role        TEXT NOT NULL,     -- chat|embedding|reranker|judge|extractor|vision|ocr
  label       TEXT,
  provider    TEXT NOT NULL,     -- openai-compatible|dashscope|deepseek|ollama|custom
  model       TEXT NOT NULL,
  base_url    TEXT,
  api_key_ref TEXT,              -- 指向 secrets 表的键名，绝不存明文
  dim         INTEGER,
  batch       INTEGER NOT NULL DEFAULT 16,
  timeout_ms  INTEGER NOT NULL DEFAULT 60000,
  params      TEXT NOT NULL DEFAULT '{}',
  priority    INTEGER NOT NULL DEFAULT 0,
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS secret (
  key        TEXT PRIMARY KEY,
  cipher     TEXT NOT NULL,      -- base64(DERIVED) 由本机 key 派生的异或/流密码
  hint       TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS model_call (
  id                TEXT PRIMARY KEY,
  role              TEXT,
  provider          TEXT,
  model             TEXT,
  ok                INTEGER NOT NULL,
  http_status       INTEGER,
  latency_ms        INTEGER,
  prompt_tokens     INTEGER,
  completion_tokens INTEGER,
  error             TEXT,
  degraded          INTEGER NOT NULL DEFAULT 0,
  run_id            TEXT,
  created_at        TEXT NOT NULL
);

-- ============================================================
-- 12. 召回日志 / 学习 / 算法目录 / 任务 / 审计
-- ============================================================
CREATE TABLE IF NOT EXISTS recall_log (
  id         TEXT PRIMARY KEY,
  query      TEXT NOT NULL,
  scope_id   TEXT,
  agent_id   TEXT,
  strategy   TEXT,
  hit_ids    TEXT NOT NULL DEFAULT '[]',
  scores     TEXT NOT NULL DEFAULT '{}',
  latency_ms INTEGER,
  tokens     INTEGER,
  degraded   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS review_log (
  id          TEXT PRIMARY KEY,
  memory_id   TEXT NOT NULL,
  grade       INTEGER NOT NULL,     -- 0..5
  algorithm   TEXT NOT NULL DEFAULT 'sm2',
  interval    REAL,
  ease        REAL,
  due         TEXT,
  at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_algo (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  category   TEXT NOT NULL,     -- retrieval|fusion|dedup|decay|layout|review|deduction|rerank
  summary    TEXT NOT NULL,
  detail     TEXT NOT NULL DEFAULT '',
  formula    TEXT,
  reference  TEXT,
  offline    INTEGER NOT NULL DEFAULT 1,
  runnable   INTEGER NOT NULL DEFAULT 0,  -- 未在本机启用（算力不足）时保持 0
  params     TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS job (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'queued', -- queued|running|ok|failed|cancelled
  payload      TEXT NOT NULL DEFAULT '{}',
  attempts     INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  run_after    TEXT,
  last_error   TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
  id     TEXT PRIMARY KEY,
  at     TEXT NOT NULL,
  actor  TEXT,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS setting (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ============================================================
-- FTS 同步触发器
-- ============================================================
CREATE TRIGGER IF NOT EXISTS memory_ai AFTER INSERT ON memory BEGIN
  INSERT INTO memory_fts(rowid, title, body, summary) VALUES (new.rowid, new.title, new.body, coalesce(new.summary,''));
END;
CREATE TRIGGER IF NOT EXISTS memory_ad AFTER DELETE ON memory BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, title, body, summary) VALUES ('delete', old.rowid, old.title, old.body, coalesce(old.summary,''));
END;
CREATE TRIGGER IF NOT EXISTS memory_au AFTER UPDATE ON memory BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, title, body, summary) VALUES ('delete', old.rowid, old.title, old.body, coalesce(old.summary,''));
  INSERT INTO memory_fts(rowid, title, body, summary) VALUES (new.rowid, new.title, new.body, coalesce(new.summary,''));
END;

CREATE TRIGGER IF NOT EXISTS chunk_ai AFTER INSERT ON chunk BEGIN
  INSERT INTO chunk_fts(rowid, text, heading) VALUES (new.rowid, new.text, coalesce(new.heading,''));
END;
CREATE TRIGGER IF NOT EXISTS chunk_ad AFTER DELETE ON chunk BEGIN
  INSERT INTO chunk_fts(chunk_fts, rowid, text, heading) VALUES ('delete', old.rowid, old.text, coalesce(old.heading,''));
END;
CREATE TRIGGER IF NOT EXISTS chunk_au AFTER UPDATE ON chunk BEGIN
  INSERT INTO chunk_fts(chunk_fts, rowid, text, heading) VALUES ('delete', old.rowid, old.text, coalesce(old.heading,''));
  INSERT INTO chunk_fts(rowid, text, heading) VALUES (new.rowid, new.text, coalesce(new.heading,''));
END;
