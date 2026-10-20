/**
 * 与 docs/ARCHITECTURE.md §5 对齐的 API 返回类型。
 *
 * 后端字段可能缺省（降级路径），因此除主键与核心文本外一律按可选处理，
 * 渲染层负责兜底，绝不在缺字段时崩掉整页。
 */

/* ------------------------------------------------------------------ 基础 */

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type Dict = Record<string, unknown>;

export interface Paged<T> {
  items: T[];
  total: number;
  limit?: number;
  offset?: number;
}

/* ------------------------------------------------------------------ 健康 / 总览 */
/*
 * 以下形状逐字段对照 memora_core/server.py 的 api_health / api_overview。
 * 后端是唯一真源：这里写的字段名必须是后端真的会发的名字，
 * tests/e2e-app.test.mjs 会把页面上的数字和 API 返回逐一比对。
 */

/** /api/health 的 models[role] 与 /api/models 的 health[role]。 */
export interface ModelRoleHealth {
  ok?: boolean;
  degraded?: boolean;
  provider?: string | null;
  model?: string | null;
  configured?: boolean;
  last_error?: string | null;
  calls_24h?: number;
  avg_latency_ms?: number;
}

export interface Health {
  ok?: boolean;
  version?: string;
  uptime_s?: number;
  started_at?: string;
  data_dir?: string;
  pid?: number;
  /** 表名 → 行数（memory / document / chunk / …）；null 表示该表计数失败。 */
  db?: Record<string, number | null>;
  db_ok?: boolean;
  db_integrity?: string | null;
  /** 角色 → 模型健康（chat / embedding / reranker / judge / extractor / vision）。 */
  models?: Record<string, ModelRoleHealth>;
  /** 降级能力**列表**：空数组表示没有降级（注意 [] 在 JS 里是真值，别用 Boolean()）。 */
  degraded?: string[];
  unavailable?: string[];
  capabilities?: Record<string, { ok?: boolean; error?: string | null }>;
  events?: Dict;
  requests?: number;
  sse_clients?: number;
  /** 后端可能追加的字段（只增不改）。 */
  [key: string]: unknown;
}

export interface DistBucket {
  key: string;
  label?: string;
  count: number;
}

export interface TrendPoint {
  date: string;
  count: number;
}

export interface OverviewTotals {
  memories?: number;
  approved?: number;
  candidates?: number;
  documents?: number;
  chunks?: number;
  evidence?: number;
  edges?: number;
  entities?: number;
  scopes?: number;
  conflicts_open?: number;
}

export interface PendingReview {
  id: string;
  title?: string;
  kind?: string;
  status?: string;
  trust?: number;
  review_due?: string | null;
  recorded_at?: string;
}

/** /api/overview（server.py api_overview）。 */
export interface Overview {
  totals?: OverviewTotals;
  /** kind → 条数。 */
  by_kind?: Record<string, number>;
  by_scope?: { scope_id: string; count: number }[];
  /** 近 30 天按日入库数；没有入库的日子不出现（前端补零）。 */
  daily?: { day: string; count: number }[];
  recent_runs?: RunSummary[];
  pending_reviews?: PendingReview[];
  agents?: AgentStatus[];
  degraded?: string[];
  generated_at?: string;
  /** 聚合失败时后端如实报告（降级契约），页面必须展示。 */
  store_error?: string;
  aggregate_error?: string;
}

/* ------------------------------------------------------------------ 记忆 */

/** 与 store.STATUSES 一致。 */
export type MemoryStatus = 'draft' | 'candidate' | 'approved' | 'rejected' | 'superseded' | 'merged' | 'archived';

export interface Evidence {
  id?: string;
  memory_id?: string;
  document_id?: string | null;
  chunk_id?: string | null;
  kind?: string;
  uri?: string | null;
  quote?: string | null;
  trust?: number;
  verified?: boolean;
  verifier?: string | null;
  note?: string | null;
  created_at?: string;
}

/** store.block 行：富块类型字段名是 `type`（formula / code / table / …）。 */
export interface MemBlock {
  id?: string;
  memory_id?: string;
  ordinal?: number;
  type?: string;
  lang?: string | null;
  caption?: string | null;
  content?: string;
  fields?: Dict;
}

export interface MemoryEdge {
  id?: string;
  src?: string;
  src_kind?: string;
  dst?: string;
  dst_kind?: string;
  rel?: string;
  weight?: number;
  confidence?: number;
  origin?: string;
}

/** 学习型记忆的六层讲解（seed / 工作流写入）。 */
export interface Didactic {
  definition?: string;
  formula?: string;
  property?: string;
  example?: string;
  [key: string]: unknown;
}

/** store.get_memory / list_memories 的行。时间字段是 recorded_at（没有 created_at）。 */
export interface Memory {
  id: string;
  title?: string;
  body?: string;
  summary?: string | null;
  kind?: string;
  category?: string | null;
  scope_id?: string;
  status?: MemoryStatus | string;
  agent_id?: string | null;
  session_id?: string | null;
  trust?: number;
  importance?: number;
  confidence?: number;
  sensitivity?: string;
  tags?: string[];
  didactic?: Didactic | null;
  recorded_at?: string;
  updated_at?: string;
  review_due?: string | null;
  review_count?: number;
  last_reviewed?: string | null;
  /** SM-2 间隔（天）。 */
  stability?: number | null;
  difficulty?: number | null;
  superseded_by?: string | null;
  merged_into?: string | null;
  source_count?: number;
  pinned?: number | boolean;
  snippet?: string;
  evidence?: Evidence[];
  blocks?: MemBlock[];
  edges?: MemoryEdge[];
  entities?: Dict[];
  documents?: Dict[];
  history?: Dict[];
  [key: string]: unknown;
}

/** POST /api/memories/{id}/review 的返回（不是 Memory）。 */
export interface ReviewResult {
  ok?: boolean;
  memory_id?: string;
  grade?: number;
  ease?: number;
  interval?: number;
  due?: string;
  difficulty?: number;
  review_count?: number;
  status?: string;
}

export interface MemoryListQuery {
  q?: string;
  scope?: string;
  kind?: string;
  status?: string;
  agent?: string;
  /** store.SORTS：updated_at / recorded_at / importance / trust / review_due。 */
  sort?: string;
  order?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
  include_candidates?: boolean;
}

/* ------------------------------------------------------------------ 检索 */

export interface SearchChannels {
  bm25?: number;
  vector?: number;
  graph?: number;
  substring?: number;
  [key: string]: number | undefined;
}

export interface SearchHit {
  id: string;
  kind?: string;
  title?: string;
  snippet?: string;
  score?: number;
  channels?: SearchChannels;
  trust?: number;
  citation?: string;
  scope_id?: string;
  status?: string;
  meta?: Dict;
}

export interface SearchResult {
  hits: SearchHit[];
  degraded?: (string | { role?: string; reason?: string })[];
  took_ms?: number;
  strategy?: string;
  total?: number;
  query?: string;
  /** 1.1.0 起：实际跑过的通道、向量来源（null = 没有向量通道）、是否语义、是否重排、分数含义 */
  channels_used?: string[];
  vector_model?: string | null;
  semantic?: boolean;
  reranked?: boolean;
  score_kind?: string;
}

/* ------------------------------------------------------------------ 文档 */

/** store.document 行（/api/documents 列表项）。路径字段是 vault 内相对路径 `path`。 */
export interface DocumentRow {
  id: string;
  kind?: string;
  path?: string;
  title?: string | null;
  scope_id?: string | null;
  day?: string | null;
  hash?: string;
  bytes?: number;
  frontmatter?: Dict;
  origin?: string;
  status?: string;
  created_at?: string;
  updated_at?: string;
  indexed_at?: string | null;
}

export interface DocumentChunk {
  id?: string;
  ordinal?: number;
  heading?: string | null;
  level?: number | null;
  tokens?: number;
  start_line?: number | null;
  end_line?: number | null;
  preview?: string;
}

/** /api/documents/{id}：chunks 是**数组**（前 400 字预览），原文走 /raw。 */
export interface DocumentDetail extends DocumentRow {
  chunks?: DocumentChunk[];
}

/* ------------------------------------------------------------------ 工作流 */

export type NodeKind =
  | 'input' | 'transform' | 'extract' | 'classify' | 'retrieve' | 'embed' | 'rerank'
  | 'fuse' | 'judge' | 'verify' | 'persist' | 'index' | 'graph' | 'generate'
  | 'decide' | 'schedule' | 'emit' | string;

export interface WorkflowNode {
  id: string;
  name?: string;
  kind: NodeKind;
  role?: string | null;
  params?: Dict;
  fallbacks?: string[];
  pos?: { x: number; y: number };
}

export interface WorkflowEdge {
  from: string;
  to: string;
  when?: string;
  label?: string;
}

export interface WorkflowTemplate {
  id: string;
  name?: string;
  category?: string;
  version?: number;
  description?: string;
  trigger?: Dict;
  inputs?: Record<string, string>;
  nodes?: WorkflowNode[];
  edges?: WorkflowEdge[];
  fallbacks?: Record<string, string>;
  last_run?: string;
  runs?: number;
}

export interface RunSummary {
  id: string;
  template_id?: string;
  workflow_id?: string;
  name?: string;
  template_name?: string;
  status?: string;
  trigger?: string;
  scope_id?: string;
  scope?: string;
  started_at?: string;
  finished_at?: string;
  created_at?: string;
  duration_ms?: number;
  steps?: number;
  degraded?: boolean | number;
  error?: string;
  inputs?: Dict;
  output?: Dict;
}

export interface RunStep {
  id?: string;
  run_id?: string;
  node_id?: string;
  name?: string;
  kind?: string;
  status?: string;
  started_at?: string;
  finished_at?: string;
  duration_ms?: number;
  model?: string;
  role?: string;
  degraded?: boolean | number;
  fallback?: string;
  input?: unknown;
  output?: unknown;
  summary?: string;
  error?: string;
}

export interface RunDetail extends RunSummary {
  step_list?: RunStep[];
}

/* ------------------------------------------------------------------ 智能体 */

/** agents._probe_summary：每类探针最新一次结果。state=found 表示命中。 */
export interface AgentProbe {
  probe?: string;
  state?: string;
  detail?: string | null;
  latency_ms?: number | null;
  at?: string;
  target?: string | null;
  found?: number;
  total?: number;
}

/** agents.agent_status 的行：sessions / memories 是**对象**不是数字。 */
export interface AgentStatus {
  id: string;
  display_name?: string;
  ecosystem?: string;
  kind?: string;
  status?: 'online' | 'idle' | 'offline' | string;
  online_since?: string | null;
  last_seen?: string | null;
  last_heartbeat?: string | null;
  heartbeat_source?: string | null;
  static_registered?: boolean;
  enabled?: boolean;
  protocols?: string[];
  config_hint?: string;
  capabilities?: Dict;
  probes?: AgentProbe[];
  sessions?: { total?: number; active?: number; recent?: Dict[] };
  memories?: { total?: number; approved?: number; last_at?: string | null };
}

/** GET /api/agents/{id}/config。 */
export interface AgentConfig {
  agent?: string;
  display_name?: string;
  ecosystem?: string;
  protocols?: string[];
  config?: Dict;
  hint?: string;
  status?: string;
}

/* ------------------------------------------------------------------ 模型 */

/** 与 memora_core/models.py 的 ROLES / PROVIDERS 一致。 */
export const MODEL_ROLES = ['chat', 'embedding', 'reranker', 'judge', 'extractor', 'vision'] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];
export const MODEL_PROVIDERS = ['openai', 'openai-compatible', 'dashscope', 'deepseek', 'ollama', 'none'] as const;

/** ModelProfile.to_dict()。超时字段是毫秒 timeout_ms；密钥只以 api_key_ref 引用出现。 */
export interface ModelProfile {
  id?: string;
  role: ModelRole | string;
  label?: string;
  provider?: string;
  model?: string;
  base_url?: string;
  api_key_ref?: string | null;
  dim?: number;
  batch?: number;
  timeout_ms?: number;
  params?: Dict;
  priority?: number;
  enabled?: boolean;
  created_at?: string;
  hint?: string;
}

/** GET /api/models 整体。 */
export interface ModelsState {
  roles: Record<string, ModelProfile | null>;
  by_role: Record<string, ModelProfile[]>;
  profiles: ModelProfile[];
  health: Record<string, ModelRoleHealth>;
  degraded: string[];
  unavailable?: string[];
  note?: string;
}

/** model_call 行（ok 是 0/1）。 */
export interface ModelCall {
  id?: string;
  role?: string;
  provider?: string;
  model?: string;
  ok?: boolean | number;
  http_status?: number | null;
  latency_ms?: number | null;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  error?: string | null;
  degraded?: boolean | number;
  run_id?: string | null;
  created_at?: string;
}

/** ModelGateway.test()。 */
export interface ModelTestResult {
  ok?: boolean;
  mode?: string;
  detail?: string;
  latency_ms?: number;
  provider?: string;
  model?: string;
}

/* ------------------------------------------------------------------ 算法目录 */

export interface Algorithm {
  id: string;
  name?: string;
  category?: string;
  summary?: string;
  formula?: string;
  reference?: string;
  offline?: boolean | number;
  runnable?: boolean | number;
  enabled?: boolean | number;
  engaged?: boolean | number;
  note?: string;
  status?: string;
}

/* ------------------------------------------------------------------ 图 */

export interface GraphNode {
  id: string;
  label?: string;
  kind?: string;
  scope_id?: string;
  weight?: number;
  size?: number;
  degree?: number;
  meta?: Dict;
}

export interface GraphEdge {
  src: string;
  dst: string;
  rel?: string;
  weight?: number;
  confidence?: number;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  meta?: Dict;
}

/* ------------------------------------------------------------------ 冲突 / 任务 */

/** conflict 行：两侧只给 id（a_id / b_id），标题需另取；detail 是对象。 */
export interface Conflict {
  id: string;
  kind?: string;
  a_id?: string | null;
  b_id?: string | null;
  score?: number;
  detail?: { summary?: string; [key: string]: unknown } | null;
  status?: string;
  resolution?: string | null;
  created_at?: string;
  resolved_at?: string | null;
  /** 若后端将来附带标题（additive），优先使用。 */
  a_title?: string;
  b_title?: string;
}

export interface Job {
  id: string;
  kind?: string;
  status?: string;
  target?: string;
  attempts?: number;
  error?: string;
  created_at?: string;
  finished_at?: string;
}

/* ------------------------------------------------------------------ 设置 / 事件 */

/** GET /api/settings：values 是 setting 表原样；runtime 是本进程真实的启动参数。 */
export interface Settings {
  values?: Record<string, unknown>;
  total?: number;
  runtime?: { version?: string; data_dir?: string; port?: number; host?: string };
}

/** events.EVENT_TYPES：run / memory / agent / log / heartbeat / system；ts 是秒级浮点。 */
export interface ServerEvent {
  type: 'run' | 'memory' | 'agent' | 'log' | 'heartbeat' | 'system' | string;
  data?: Dict;
  ts?: number | string;
}

export interface ConnectionState {
  online: boolean;
  checked_at: number;
  version?: string;
  reason?: string;
}

/** 与 store.MEMORY_KINDS 一致（顺序也一致）。 */
export const KIND_LABELS: Record<string, string> = {
  fact: '事实',
  knowledge: '知识',
  decision: '决策',
  preference: '偏好',
  procedure: '流程',
  experience: '经验',
  task: '任务',
  turn: '对话轮次',
  tool: '工具',
  artifact: '产物',
};

/** 与 store.STATUSES 一致。 */
export const STATUS_LABELS: Record<string, string> = {
  draft: '草稿',
  candidate: '待审',
  approved: '已批准',
  rejected: '已拒绝',
  superseded: '被取代',
  merged: '已合并',
  archived: '已归档',
};

export const ALGO_CATEGORY_LABELS: Record<string, string> = {
  retrieval: '检索',
  embedding: '向量',
  fusion: '融合',
  dedup: '判重',
  decay: '遗忘',
  ranking: '排序',
  graph: '图',
  layout: '布局',
  transform: '变换',
  review: '复习',
  judge: '判定',
  extract: '抽取',
  classify: '分类',
  index: '索引',
  verify: '核验',
  chunking: '切块',
  audit: '审计',
};

export const NODE_KIND_COLORS: Record<string, string> = {
  input: '#4da3ff',
  transform: '#8b7dff',
  extract: '#2ee6a8',
  classify: '#2ee6a8',
  retrieve: '#ffc857',
  embed: '#ffc857',
  rerank: '#ffc857',
  fuse: '#ffc857',
  judge: '#ff9f5c',
  verify: '#ff5c7a',
  persist: '#2ee6a8',
  index: '#4da3ff',
  graph: '#c084fc',
  generate: '#c084fc',
  decide: '#ff9f5c',
  schedule: '#8b7dff',
  emit: '#4da3ff',
};
