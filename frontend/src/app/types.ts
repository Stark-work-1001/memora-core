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

export interface HealthCounts {
  memories?: number;
  documents?: number;
  agents?: number;
  runs?: number;
  candidates?: number;
  conflicts?: number;
  edges?: number;
  entities?: number;
  [key: string]: number | undefined;
}

export interface RoleHealth {
  role: string;
  configured?: boolean;
  ok?: boolean;
  degraded?: boolean;
  last_error?: string | null;
  model?: string;
  provider?: string;
}

export interface Health {
  version?: string;
  ok?: boolean;
  uptime_s?: number;
  started_at?: string;
  db_path?: string;
  vault_path?: string;
  degraded?: boolean;
  degraded_running?: string[];
  counts?: HealthCounts;
  roles?: RoleHealth[] | Record<string, RoleHealth>;
  fts_ok?: boolean;
  ts?: string;
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

export interface Overview {
  health?: Health;
  counts?: HealthCounts;
  total_memories?: number;
  today_new?: number;
  week_new?: number;
  pending_candidates?: number;
  by_kind?: DistBucket[];
  by_scope?: DistBucket[];
  by_status?: DistBucket[];
  trend?: TrendPoint[];
  trend_7d?: TrendPoint[];
  recent_runs?: RunSummary[];
  agents_online?: AgentStatus[];
  agents?: AgentStatus[];
  degraded?: string[];
  roles?: RoleHealth[];
}

/* ------------------------------------------------------------------ 记忆 */

export type MemoryStatus = 'candidate' | 'approved' | 'rejected' | 'superseded' | 'merged' | 'archived';

export interface Evidence {
  id?: string;
  memory_id?: string;
  kind?: string;
  source?: string;
  uri?: string;
  quote?: string;
  trust?: number;
  weight?: number;
  created_at?: string;
  meta?: Dict;
}

export interface MemBlock {
  id?: string;
  memory_id?: string;
  kind?: string;
  lang?: string | null;
  content?: string;
  text?: string;
  ordinal?: number;
  meta?: Dict;
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

export interface Memory {
  id: string;
  title?: string;
  body?: string;
  summary?: string;
  kind?: string;
  scope_id?: string;
  scope?: string;
  status?: MemoryStatus | string;
  agent_id?: string;
  trust?: number;
  confidence?: number;
  tags?: string[];
  created_at?: string;
  updated_at?: string;
  reviewed_at?: string;
  review_count?: number;
  ease?: number;
  interval_days?: number;
  due_at?: string;
  evidence?: Evidence[];
  blocks?: MemBlock[];
  edges?: MemoryEdge[];
  related?: Memory[];
  source_document_id?: string;
  path?: string;
  [key: string]: unknown;
}

export interface MemoryListQuery {
  q?: string;
  scope?: string;
  kind?: string;
  status?: string;
  agent?: string;
  sort?: string;
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
}

/* ------------------------------------------------------------------ 文档 */

export interface DocumentRow {
  id: string;
  title?: string;
  rel_path?: string;
  path?: string;
  kind?: string;
  bytes?: number;
  chunks?: number;
  memories?: number;
  updated_at?: string;
  created_at?: string;
  indexed_at?: string;
  hash?: string;
  source?: string;
}

export interface DocumentDetail extends DocumentRow {
  raw?: string;
  markdown?: string;
  preview?: string;
  chunk_list?: { id?: string; ordinal?: number; text?: string; tokens?: number }[];
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

export interface AgentProbe {
  type?: string;
  target?: string;
  ok?: boolean;
  detail?: string;
  evidence?: string;
  match?: unknown;
}

export interface AgentStatus {
  id: string;
  name?: string;
  ecosystem?: string;
  kind?: string;
  status?: 'online' | 'idle' | 'offline' | string;
  online?: boolean;
  last_seen?: string;
  heartbeat_at?: string;
  sessions?: number;
  memories?: number;
  probes?: AgentProbe[];
  evidence?: string[];
  protocols?: string[];
  config_hint?: string;
  config_snippet?: string;
  confidence?: number;
}

/* ------------------------------------------------------------------ 模型 */

export type ModelRole = 'chat' | 'embedding' | 'reranker' | 'judge';

export interface ModelProfile {
  id?: string;
  role: ModelRole | string;
  provider?: string;
  base_url?: string;
  model?: string;
  api_key?: string;
  api_key_set?: boolean;
  dim?: number;
  batch?: number;
  timeout?: number;
  enabled?: boolean;
  temperature?: number;
  max_tokens?: number;
  last_ok?: string;
  last_error?: string | null;
  degraded?: boolean;
  ok?: boolean;
}

export interface ModelCall {
  id?: string | number;
  role?: string;
  model?: string;
  provider?: string;
  status?: string;
  ok?: boolean;
  latency_ms?: number;
  tokens_in?: number;
  tokens_out?: number;
  cost?: number;
  error?: string | null;
  created_at?: string;
  purpose?: string;
}

export interface ModelTestResult {
  ok?: boolean;
  role?: string;
  model?: string;
  latency_ms?: number;
  status?: string;
  error?: string;
  detail?: string;
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

export interface Conflict {
  id: string;
  status?: string;
  kind?: string;
  memory_a?: string;
  memory_b?: string;
  title_a?: string;
  title_b?: string;
  summary?: string;
  detail?: string;
  similarity?: number;
  created_at?: string;
  resolution?: string;
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

export interface Settings {
  data_dir?: string;
  vault_dir?: string;
  port?: number;
  host?: string;
  auto_backup?: boolean | number;
  backup_interval_h?: number;
  absorb_strategy?: string;
  offline_fallback?: boolean | number;
  offline_mode?: boolean | number;
  [key: string]: unknown;
}

export interface ServerEvent {
  type: 'run' | 'memory' | 'agent' | 'log' | string;
  data?: Dict;
  ts?: string;
}

export interface ConnectionState {
  online: boolean;
  checked_at: number;
  version?: string;
  reason?: string;
}

export const KIND_LABELS: Record<string, string> = {
  fact: '事实',
  knowledge: '知识',
  decision: '决策',
  preference: '偏好',
  procedure: '流程',
  experience: '经验',
  task: '任务',
  tool: '工具',
  insight: '洞察',
  context: '上下文',
};

export const STATUS_LABELS: Record<string, string> = {
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
