/**
 * 同源 /api/* 的 fetch 封装：统一超时、错误归一化、JSON 解析与 SSE。
 *
 * 硬性约束：
 *  - 只访问同源 /api/*，绝不发外部请求。
 *  - 任何失败都转成 ApiError，由页面渲染错误态 + 重试，而不是白屏。
 */

import type {
  AgentStatus, Algorithm, Conflict, Dict, DocumentDetail, DocumentRow, GraphData, Health,
  Job, Memory, MemoryListQuery, ModelCall, ModelProfile, ModelRole, ModelTestResult,
  Overview, Paged, RunDetail, RunSummary, SearchResult, ServerEvent, Settings, WorkflowTemplate,
} from './types';

/** 默认超时：普通 GET。 */
const TIMEOUT_READ = 12000;
/** 写操作 / 重计算（重建索引、跑工作流）放宽。 */
const TIMEOUT_WRITE = 30000;
/** 后端探活单独给一个短超时，用于快速失败展示"无法连接后端"。 */
const TIMEOUT_PING = 3500;

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail?: unknown;

  constructor(message: string, status = 0, code = 'network', detail?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }

  /** 是否属于"后端没起来"这一类（用于展示连接失败态而不是普通错误）。 */
  get isConnectionError(): boolean {
    return this.code === 'network'
      || this.code === 'timeout'
      || this.status === 0
      || this.status === 502
      || this.status === 503
      || this.status === 504;
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

function buildQuery(query?: RequestOptions['query']): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const key of Object.keys(query)) {
    const value = query[key];
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

function messageFromBody(body: unknown, fallback: string): { message: string; code: string } {
  if (body && typeof body === 'object') {
    const record = body as Dict;
    const err = record.error;
    if (typeof err === 'string') {
      return { message: err, code: typeof record.code === 'string' ? record.code : 'server' };
    }
    if (err && typeof err === 'object') {
      const detail = err as Dict;
      const msg = typeof detail.message === 'string' ? detail.message : fallback;
      const code = typeof detail.code === 'string' ? detail.code : 'server';
      return { message: msg, code };
    }
    if (typeof record.message === 'string') {
      return { message: record.message, code: typeof record.code === 'string' ? record.code : 'server' };
    }
    if (record.degraded !== undefined && Array.isArray(record.degraded)) {
      return { message: fallback, code: 'degraded' };
    }
  }
  return { message: fallback, code: 'server' };
}

async function readBody(response: Response): Promise<unknown> {
  const type = response.headers.get('content-type') ?? '';
  if (type.includes('application/json')) {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }
  try {
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return { error: text.slice(0, 400) };
    }
  } catch {
    return null;
  }
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const timeoutMs = options.timeoutMs ?? (method === 'GET' ? TIMEOUT_READ : TIMEOUT_WRITE);
  const controller = new AbortController();
  let timedOut = false;
  const timer = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const onExternalAbort = (): void => controller.abort();
  if (options.signal) options.signal.addEventListener('abort', onExternalAbort);

  const headers: Record<string, string> = { Accept: 'application/json' };
  let payload: string | undefined;
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(options.body);
  }

  const url = `/api${path}${buildQuery(options.query)}`;

  try {
    const response = await fetch(url, {
      method,
      headers,
      body: payload,
      signal: controller.signal,
      credentials: 'same-origin',
      cache: 'no-store',
    });
    const body = await readBody(response);
    if (!response.ok) {
      const parsed = messageFromBody(body, `请求失败（HTTP ${response.status}）`);
      throw new ApiError(parsed.message, response.status, parsed.code, body);
    }
    return body as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (timedOut) {
      throw new ApiError(`请求超时（${(timeoutMs / 1000).toFixed(1)} 秒）：${path}`, 0, 'timeout');
    }
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new ApiError('请求已取消', 0, 'aborted');
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new ApiError(`无法连接后端：${reason}`, 0, 'network', error);
  } finally {
    window.clearTimeout(timer);
    if (options.signal) options.signal.removeEventListener('abort', onExternalAbort);
  }
}

/* ---------------------------------------------------------------- 列表归一化 */

function toArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === 'object') {
    const record = value as Dict;
    for (const key of ['items', 'rows', 'data', 'list', 'results', 'hits', 'nodes', 'templates', 'runs']) {
      const candidate = record[key];
      if (Array.isArray(candidate)) return candidate as T[];
    }
  }
  return [];
}

export function toPaged<T>(value: unknown): Paged<T> {
  const items = toArray<T>(value);
  const record = (value && typeof value === 'object' ? value : {}) as Dict;
  const totalRaw = record.total ?? record.count;
  const total = typeof totalRaw === 'number' ? totalRaw : items.length;
  const paged: Paged<T> = { items, total };
  if (typeof record.limit === 'number') paged.limit = record.limit;
  if (typeof record.offset === 'number') paged.offset = record.offset;
  return paged;
}

/* ---------------------------------------------------------------- API 面 */

export const api = {
  /* 健康与总览 */
  ping(signal?: AbortSignal): Promise<Health> {
    return request<Health>('/health', { timeoutMs: TIMEOUT_PING, signal });
  },
  health(): Promise<Health> {
    return request<Health>('/health', { timeoutMs: TIMEOUT_PING });
  },
  overview(): Promise<Overview> {
    return request<Overview>('/overview');
  },

  /* 记忆 */
  async memories(query: MemoryListQuery = {}): Promise<Paged<Memory>> {
    const raw = await request<unknown>('/memories', {
      query: {
        q: query.q,
        scope: query.scope,
        kind: query.kind,
        status: query.status,
        agent: query.agent,
        sort: query.sort,
        limit: query.limit,
        offset: query.offset,
        include_candidates: query.include_candidates,
      },
    });
    return toPaged<Memory>(raw);
  },
  memory(id: string): Promise<Memory> {
    return request<Memory>(`/memories/${encodeURIComponent(id)}`);
  },
  createMemory(payload: Dict): Promise<Memory> {
    return request<Memory>('/memories', { method: 'POST', body: payload });
  },
  updateMemory(id: string, patch: Dict): Promise<Memory> {
    return request<Memory>(`/memories/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch });
  },
  async deleteMemory(id: string, hard = false): Promise<void> {
    await request<unknown>(`/memories/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      query: hard ? { hard: 1 } : undefined,
    });
  },
  reviewMemory(id: string, grade: number, note?: string): Promise<Memory> {
    return request<Memory>(`/memories/${encodeURIComponent(id)}/review`, {
      method: 'POST',
      body: { grade, note },
    });
  },
  approveMemory(id: string): Promise<Memory> {
    return request<Memory>(`/memories/${encodeURIComponent(id)}/approve`, { method: 'POST', body: {} });
  },
  rejectMemory(id: string): Promise<Memory> {
    return request<Memory>(`/memories/${encodeURIComponent(id)}/reject`, { method: 'POST', body: {} });
  },
  async addEvidence(id: string, payload: Dict): Promise<unknown> {
    return request<unknown>(`/memories/${encodeURIComponent(id)}/evidence`, {
      method: 'POST',
      body: payload,
    });
  },

  /* 检索 */
  search(query: { q: string; strategy?: string; scope?: string; limit?: number; budget?: number }): Promise<SearchResult> {
    return request<SearchResult>('/search', {
      query: {
        q: query.q,
        strategy: query.strategy,
        scope: query.scope,
        limit: query.limit,
        budget: query.budget,
      },
    });
  },
  recall(payload: Dict): Promise<SearchResult> {
    return request<SearchResult>('/recall', { method: 'POST', body: payload });
  },

  /* 文档 */
  async documents(query: { q?: string; kind?: string; limit?: number; offset?: number } = {}): Promise<Paged<DocumentRow>> {
    const raw = await request<unknown>('/documents', { query });
    return toPaged<DocumentRow>(raw);
  },
  document(id: string): Promise<DocumentDetail> {
    return request<DocumentDetail>(`/documents/${encodeURIComponent(id)}`);
  },
  async documentRaw(id: string): Promise<string> {
    const response = await fetch(`/api/documents/${encodeURIComponent(id)}/raw`, {
      headers: { Accept: 'text/markdown, text/plain' },
      cache: 'no-store',
    });
    if (!response.ok) {
      throw new ApiError(`读取原始文档失败（HTTP ${response.status}）`, response.status, 'server');
    }
    return await response.text();
  },
  importDocument(payload: { path: string; scope?: string }): Promise<Dict> {
    return request<Dict>('/documents/import', { method: 'POST', body: payload, timeoutMs: 60000 });
  },
  async uploadDocument(file: File, scope?: string): Promise<Dict> {
    const form = new FormData();
    form.append('file', file, file.name);
    if (scope) form.append('scope', scope);
    const response = await fetch('/api/documents/import', { method: 'POST', body: form });
    const body = await readBody(response);
    if (!response.ok) {
      const parsed = messageFromBody(body, `上传失败（HTTP ${response.status}）`);
      throw new ApiError(parsed.message, response.status, parsed.code, body);
    }
    return body as Dict;
  },
  reindexDocument(id: string): Promise<Dict> {
    return request<Dict>(`/documents/${encodeURIComponent(id)}/reindex`, {
      method: 'POST',
      body: {},
      timeoutMs: 60000,
    });
  },

  /* 图 */
  graph(view: string, scope?: string, limit = 400): Promise<GraphData> {
    return request<GraphData>('/graph', { query: { view, scope, limit } });
  },

  /* 工作流与运行 */
  async workflows(): Promise<WorkflowTemplate[]> {
    const raw = await request<unknown>('/workflows');
    return toArray<WorkflowTemplate>(raw);
  },
  workflow(id: string): Promise<WorkflowTemplate> {
    return request<WorkflowTemplate>(`/workflows/${encodeURIComponent(id)}`);
  },
  runWorkflow(id: string, inputs: Dict, scope = 'global'): Promise<RunSummary> {
    return request<RunSummary>(`/workflows/${encodeURIComponent(id)}/run`, {
      method: 'POST',
      body: { inputs, scope },
      timeoutMs: 120000,
    });
  },
  async runs(query: { limit?: number; offset?: number; status?: string } = {}): Promise<Paged<RunSummary>> {
    const raw = await request<unknown>('/runs', { query });
    return toPaged<RunSummary>(raw);
  },
  run(id: string): Promise<RunDetail> {
    return request<RunDetail>(`/runs/${encodeURIComponent(id)}`);
  },

  /* 模型 */
  async models(): Promise<ModelProfile[]> {
    const raw = await request<unknown>('/models');
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const record = raw as Dict;
      if (record.profiles) return toArray<ModelProfile>(record.profiles);
      const roles = record.roles;
      if (roles && typeof roles === 'object' && !Array.isArray(roles)) {
        // roles 可能是 {chat: {...}, embedding: {...}}
        const list: ModelProfile[] = [];
        for (const role of Object.keys(roles as Dict)) {
          const value = (roles as Dict)[role];
          if (value && typeof value === 'object') list.push({ role, ...(value as Dict) } as ModelProfile);
        }
        if (list.length) return list;
      }
    }
    return toArray<ModelProfile>(raw);
  },
  saveModel(role: ModelRole | string, profile: Dict): Promise<ModelProfile> {
    return request<ModelProfile>('/models', { method: 'POST', body: { role, ...profile } });
  },
  testModel(id: string): Promise<ModelTestResult> {
    return request<ModelTestResult>(`/models/${encodeURIComponent(id)}/test`, {
      method: 'POST',
      body: {},
      timeoutMs: 45000,
    });
  },
  async modelCalls(limit = 50): Promise<ModelCall[]> {
    const raw = await request<unknown>('/models/calls', { query: { limit } });
    return toArray<ModelCall>(raw);
  },

  /* 算法目录 */
  async algorithms(): Promise<Algorithm[]> {
    const raw = await request<unknown>('/algorithms');
    return toArray<Algorithm>(raw);
  },

  /* 智能体 */
  async agents(): Promise<AgentStatus[]> {
    const raw = await request<unknown>('/agents');
    return toArray<AgentStatus>(raw);
  },
  async probeAgents(): Promise<AgentStatus[]> {
    const raw = await request<unknown>('/agents/probe', { method: 'POST', body: {}, timeoutMs: 30000 });
    return toArray<AgentStatus>(raw);
  },

  /* 冲突与任务 */
  async conflicts(): Promise<Conflict[]> {
    const raw = await request<unknown>('/conflicts');
    return toArray<Conflict>(raw);
  },
  resolveConflict(id: string, resolution: string): Promise<Dict> {
    return request<Dict>(`/conflicts/${encodeURIComponent(id)}/resolve`, {
      method: 'POST',
      body: { resolution },
    });
  },
  async jobs(): Promise<Job[]> {
    const raw = await request<unknown>('/jobs');
    return toArray<Job>(raw);
  },

  /* 设置与交换 */
  settings(): Promise<Settings> {
    return request<Settings>('/settings');
  },
  saveSettings(patch: Dict): Promise<Settings> {
    return request<Settings>('/settings', { method: 'POST', body: patch });
  },
  exchangeExportUrl(scope?: string, status = 'approved'): string {
    const params = new URLSearchParams();
    if (scope) params.set('scope', scope);
    if (status) params.set('status', status);
    const query = params.toString();
    return `/api/exchange/export${query ? `?${query}` : ''}`;
  },
  async exchangeImport(text: string, scope = 'global'): Promise<Dict> {
    return request<Dict>('/exchange/import', {
      method: 'POST',
      body: { text, scope },
      timeoutMs: 60000,
    });
  },
};

/* ---------------------------------------------------------------- SSE */

export type EventHandler = (event: ServerEvent) => void;
export type StateHandler = (state: 'open' | 'connecting' | 'closed') => void;

/**
 * /api/events 的订阅器：指数退避自动重连。
 * 后端未启动时也不会抛异常，只会持续重试并上报连接状态。
 */
export class EventStream {
  private source: EventSource | null = null;
  private onEvent: EventHandler;
  private onState: StateHandler;
  private retry = 0;
  private timer: number | undefined;
  private disposed = false;

  constructor(onEvent: EventHandler, onState: StateHandler) {
    this.onEvent = onEvent;
    this.onState = onState;
  }

  start(): void {
    if (this.disposed) return;
    this.close();
    if (typeof EventSource === 'undefined') {
      this.onState('closed');
      return;
    }
    this.onState('connecting');
    try {
      this.source = new EventSource('/api/events');
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.source.onopen = () => {
      this.retry = 0;
      this.onState('open');
    };
    this.source.onerror = () => {
      this.onState('closed');
      // EventSource 自带重连，但后端未启动时会一直空转；这里接管，改用指数退避。
      this.close();
      this.scheduleReconnect();
    };
    this.source.onmessage = (ev: MessageEvent<string>) => {
      this.dispatch(ev.data, 'message');
    };
    for (const type of ['run', 'memory', 'agent', 'log']) {
      this.source.addEventListener(type, (ev: Event) => {
        const message = ev as MessageEvent<string>;
        this.dispatch(message.data, type);
      });
    }
  }

  private dispatch(raw: string, fallbackType: string): void {
    if (!raw) return;
    let payload: unknown = null;
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = { message: raw };
    }
    const record = (payload && typeof payload === 'object' ? payload : {}) as Dict;
    const type = typeof record.type === 'string' ? record.type : fallbackType;
    const data = (record.data && typeof record.data === 'object' ? record.data : record) as Dict;
    this.onEvent({ type, data, ts: typeof record.ts === 'string' ? record.ts : undefined });
  }

  private scheduleReconnect(): void {
    if (this.disposed) return;
    const delay = Math.min(30000, 800 * Math.pow(2, Math.min(this.retry, 5)));
    this.retry += 1;
    this.onState('connecting');
    if (this.timer !== undefined) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = undefined;
      this.start();
    }, delay);
  }

  private close(): void {
    if (this.source) {
      this.source.onopen = null;
      this.source.onerror = null;
      this.source.onmessage = null;
      this.source.close();
      this.source = null;
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined) window.clearTimeout(this.timer);
    this.timer = undefined;
    this.close();
  }
}

/* ---------------------------------------------------------------- 错误文案 */

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

export function isConnectionIssue(error: unknown): boolean {
  return error instanceof ApiError && error.isConnectionError;
}
