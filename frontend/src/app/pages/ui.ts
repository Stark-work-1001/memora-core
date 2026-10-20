/**
 * 页面共享视图组件：卡片、徽章、空状态、骨架屏、错误态、弹层、Toast、数字格式化。
 * 所有组件都返回真实 DOM 节点，文本一律 textContent。
 */

import { el, clear, icon, type Child } from '../dom';
import { ApiError, errorMessage } from '../api';

/* ---------------------------------------------------------------- 格式化 */

export function fmtNumber(value: unknown): string {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('zh-CN');
}

export function fmtPercent(value: unknown, digits = 0): string {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return '—';
  return `${(n * 100).toFixed(digits)}%`;
}

export function fmtBytes(value: unknown): string {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function fmtDuration(ms: unknown): string {
  const n = typeof ms === 'number' ? ms : Number(ms);
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1000) return `${Math.round(n)} ms`;
  if (n < 60000) return `${(n / 1000).toFixed(2)} s`;
  const min = Math.floor(n / 60000);
  const sec = Math.round((n % 60000) / 1000);
  return `${min}m ${sec}s`;
}

function parseDate(value: unknown): Date | null {
  if (!value) return null;
  if (typeof value === 'number') {
    const date = new Date(value > 1e12 ? value : value * 1000);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value !== 'string') return null;
  const normalized = value.includes('T') || value.includes(' ') ? value.replace(' ', 'T') : value;
  const date = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(normalized) ? normalized : `${normalized}Z`);
  if (!Number.isNaN(date.getTime())) return date;
  const fallback = new Date(value);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}

export function fmtDateTime(value: unknown): string {
  const date = parseDate(value);
  if (!date) return '—';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function fmtRelative(value: unknown): string {
  const date = parseDate(value);
  if (!date) return '—';
  const diff = Date.now() - date.getTime();
  if (diff < 0) return '刚刚';
  const minute = 60000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 30 * day) return `${Math.floor(diff / day)} 天前`;
  return fmtDateTime(value);
}

export function fmtTime(value: unknown): string {
  const date = parseDate(value);
  if (!date) return '—';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 截断长文本（用于证据/参数预览）。 */
export function truncate(value: unknown, max = 160): string {
  const text = typeof value === 'string' ? value : value === undefined || value === null ? '' : JSON.stringify(value);
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/* ---------------------------------------------------------------- 基础块 */

export type Tone = 'ok' | 'warn' | 'danger' | 'info' | 'muted' | 'accent';

export function badge(label: string, tone: Tone = 'muted', title?: string): HTMLElement {
  return el('span', { class: `badge badge-${tone}`, title: title ?? null }, label);
}

export function statusBadge(status: unknown): HTMLElement {
  const key = String(status ?? '').toLowerCase();
  const map: Record<string, { tone: Tone; label: string }> = {
    draft: { tone: 'muted', label: '草稿' },
    approved: { tone: 'ok', label: '已批准' },
    candidate: { tone: 'warn', label: '待审' },
    rejected: { tone: 'danger', label: '已拒绝' },
    superseded: { tone: 'muted', label: '被取代' },
    merged: { tone: 'info', label: '已合并' },
    archived: { tone: 'muted', label: '已归档' },
    success: { tone: 'ok', label: '成功' },
    ok: { tone: 'ok', label: '成功' },
    completed: { tone: 'ok', label: '完成' },
    done: { tone: 'ok', label: '完成' },
    partial: { tone: 'warn', label: '部分完成' },
    degraded: { tone: 'warn', label: '降级' },
    running: { tone: 'info', label: '运行中' },
    pending: { tone: 'warn', label: '等待中' },
    queued: { tone: 'muted', label: '排队' },
    failed: { tone: 'danger', label: '失败' },
    cancelled: { tone: 'muted', label: '已取消' },
    error: { tone: 'danger', label: '错误' },
    open: { tone: 'warn', label: '待处理' },
    resolved: { tone: 'ok', label: '已裁决' },
    ignored: { tone: 'muted', label: '已忽略' },
    found: { tone: 'ok', label: '命中' },
    absent: { tone: 'muted', label: '未命中' },
    online: { tone: 'ok', label: '在线' },
    idle: { tone: 'info', label: '空闲' },
    offline: { tone: 'muted', label: '离线' },
  };
  const entry = map[key] ?? { tone: 'muted' as Tone, label: String(status ?? '未知') };
  return badge(entry.label, entry.tone);
}

export function card(options: {
  title?: string;
  subtitle?: string;
  actions?: Child[];
  className?: string;
  body?: Child[];
} = {}): HTMLElement {
  const head = options.title || options.subtitle || options.actions
    ? el('div', { class: 'card-head' },
      el('div', { class: 'card-title-wrap' },
        options.title ? el('h2', { class: 'card-title' }, options.title) : null,
        options.subtitle ? el('p', { class: 'card-subtitle' }, options.subtitle) : null),
      options.actions ? el('div', { class: 'card-actions' }, ...options.actions) : null)
    : null;
  const node = el('section', { class: `card ${options.className ?? ''}`.trim() }, head);
  if (options.body) node.appendChild(el('div', { class: 'card-body' }, ...options.body));
  return node;
}

export function statTile(label: string, value: Child, hint?: string, tone?: Tone): HTMLElement {
  return el('div', { class: `stat-tile ${tone ? `stat-${tone}` : ''}`.trim() },
    el('div', { class: 'stat-label' }, label),
    el('div', { class: 'stat-value' }, value),
    hint ? el('div', { class: 'stat-hint' }, hint) : null);
}

export function button(
  label: string,
  options: {
    onClick?: (ev: MouseEvent) => void;
    kind?: 'primary' | 'ghost' | 'danger' | 'subtle';
    iconName?: string;
    disabled?: boolean;
    title?: string;
    loading?: boolean;
  } = {},
): HTMLButtonElement {
  const btn = el('button', {
    class: `btn btn-${options.kind ?? 'ghost'}`,
    type: 'button',
    disabled: options.disabled ?? false,
    title: options.title ?? null,
    onClick: options.onClick ?? null,
  });
  if (options.iconName) btn.appendChild(icon(options.iconName, 14));
  if (options.loading) btn.appendChild(el('span', { class: 'spinner spinner-sm' }));
  if (label) btn.appendChild(el('span', null, label));
  if (options.loading) btn.classList.add('is-busy');
  return btn;
}

/** 按钮进入 loading 状态，返回恢复函数。 */
export function busy(btn: HTMLButtonElement): () => void {
  const wasDisabled = btn.disabled;
  btn.disabled = true;
  btn.classList.add('is-busy');
  const spinner = el('span', { class: 'spinner spinner-sm' });
  btn.appendChild(spinner);
  return () => {
    spinner.remove();
    btn.classList.remove('is-busy');
    btn.disabled = wasDisabled;
  };
}

export function spinner(label?: string): HTMLElement {
  return el('div', { class: 'spinner-wrap' }, el('span', { class: 'spinner' }),
    label ? el('span', { class: 'spinner-label' }, label) : null);
}

/** 加载骨架：行数可配。 */
export function skeleton(rows = 4, className = ''): HTMLElement {
  const box = el('div', { class: `skeleton ${className}`.trim(), 'aria-busy': 'true' });
  for (let i = 0; i < rows; i += 1) {
    box.appendChild(el('div', { class: 'skeleton-line', style: { width: `${55 + ((i * 17) % 40)}%` } }));
  }
  return box;
}

export function emptyState(title: string, hint?: string, action?: Child): HTMLElement {
  return el('div', { class: 'empty-state' },
    el('div', { class: 'empty-title' }, title),
    hint ? el('div', { class: 'empty-hint' }, hint) : null,
    action ? el('div', { class: 'empty-action' }, action) : null);
}

export interface ErrorStateOptions {
  error: unknown;
  onRetry?: () => void;
  title?: string;
  compact?: boolean;
}

/** 错误态：连接失败与普通错误给不同文案，必须带重试。 */
export function errorState(options: ErrorStateOptions): HTMLElement {
  const message = errorMessage(options.error);
  const isConn = options.error instanceof ApiError && options.error.isConnectionError;
  const title = options.title ?? (isConn ? '无法连接后端' : '加载失败');
  const box = el('div', { class: `error-state ${options.compact ? 'is-compact' : ''}`.trim() },
    el('div', { class: 'error-head' },
      icon('alert', 16),
      el('span', { class: 'error-title' }, title)),
    el('p', { class: 'error-message' }, message),
    isConn
      ? el('p', { class: 'error-hint' },
        '请确认后端已启动：在项目根目录执行 `python -m memora_core serve`（默认 127.0.0.1:8790）。')
      : null);
  if (options.onRetry) {
    box.appendChild(el('div', { class: 'error-actions' },
      button('重试', { kind: 'primary', iconName: 'refresh', onClick: () => options.onRetry?.() })));
  }
  return box;
}

export function degradedBanner(items: string[], title = '当前处于离线降级'): HTMLElement {
  const unique = Array.from(new Set(items.filter(Boolean)));
  return el('div', { class: 'degraded-banner', role: 'status' },
    icon('alert', 16),
    el('div', { class: 'degraded-body' },
      el('strong', null, title),
      el('span', { class: 'degraded-detail' },
        unique.length ? `受影响能力：${unique.join('、')}；结果来自本地确定性算法，不代表语义模型输出。`
          : '云端模型不可用，已切换到本地确定性算法。'))); 
}

export function sectionTitle(text: string, hint?: string): HTMLElement {
  return el('div', { class: 'section-title' },
    el('h3', null, text),
    hint ? el('span', { class: 'section-hint' }, hint) : null);
}

/* ---------------------------------------------------------------- 表单控件 */

export function field(label: string, control: Child, hint?: string): HTMLElement {
  return el('label', { class: 'field' },
    el('span', { class: 'field-label' }, label),
    control,
    hint ? el('span', { class: 'field-hint' }, hint) : null);
}

export function textInput(options: {
  value?: string;
  placeholder?: string;
  type?: string;
  onInput?: (value: string) => void;
  onChange?: (value: string) => void;
  onEnter?: () => void;
  className?: string;
  disabled?: boolean;
} = {}): HTMLInputElement {
  const input = el('input', {
    class: `input ${options.className ?? ''}`.trim(),
    type: options.type ?? 'text',
    value: options.value ?? '',
    placeholder: options.placeholder ?? '',
    disabled: options.disabled ?? false,
    autocomplete: 'off',
    spellcheck: 'false',
  });
  if (options.onInput) input.addEventListener('input', () => options.onInput?.(input.value));
  if (options.onChange) input.addEventListener('change', () => options.onChange?.(input.value));
  if (options.onEnter) {
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        options.onEnter?.();
      }
    });
  }
  return input;
}

export function numberInput(options: {
  value?: number;
  min?: number;
  max?: number;
  step?: number;
  onChange?: (value: number) => void;
} = {}): HTMLInputElement {
  const input = el('input', {
    class: 'input input-num',
    type: 'number',
    value: options.value === undefined ? '' : String(options.value),
    min: options.min,
    max: options.max,
    step: options.step,
  });
  if (options.onChange) {
    input.addEventListener('change', () => options.onChange?.(Number(input.value)));
  }
  return input;
}

export function select(options: {
  items: { value: string; label: string }[];
  value?: string;
  onChange?: (value: string) => void;
  className?: string;
}): HTMLSelectElement {
  const node = el('select', { class: `select ${options.className ?? ''}`.trim() });
  for (const item of options.items) {
    const opt = el('option', { value: item.value }, item.label);
    if (item.value === options.value) opt.selected = true;
    node.appendChild(opt);
  }
  if (options.onChange) node.addEventListener('change', () => options.onChange?.(node.value));
  return node;
}

export function checkbox(label: string, options: {
  checked?: boolean;
  onChange?: (checked: boolean) => void;
} = {}): HTMLElement {
  const input = el('input', { type: 'checkbox', checked: options.checked ?? false });
  if (options.onChange) input.addEventListener('change', () => options.onChange?.(input.checked));
  return el('label', { class: 'checkbox' }, input, el('span', null, label));
}

/** 可折叠的 JSON / 文本预览。 */
export function jsonBlock(value: unknown, label = 'JSON'): HTMLElement {
  let text: string;
  if (typeof value === 'string') text = value;
  else {
    try {
      text = JSON.stringify(value, null, 2);
    } catch {
      text = String(value);
    }
  }
  if (text === undefined) text = '';
  const pre = el('pre', { class: 'json-block' }, text || '（空）');
  const details = el('details', { class: 'json-details' },
    el('summary', null, label),
    pre);
  return details;
}

/* ---------------------------------------------------------------- 弹层 */

export interface ModalHandle {
  close(): void;
  root: HTMLElement;
}

let activeModal: ModalHandle | null = null;
let modalSeq = 0;

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), '
  + 'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** root 内可聚焦且可见的控件（模态框、全局搜索面板共用）。 */
export function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE))
    .filter((node) => node.getClientRects().length > 0);
}

/** 焦点陷阱：Tab / Shift+Tab 在 root 内循环，不让焦点漏到被遮住的页面上。 */
export function trapFocus(root: HTMLElement, ev: KeyboardEvent): void {
  if (ev.key !== 'Tab') return;
  const items = focusableIn(root);
  if (!items.length) {
    ev.preventDefault();
    root.focus();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  if (ev.shiftKey && (active === first || !root.contains(active))) {
    ev.preventDefault();
    last.focus();
  } else if (!ev.shiftKey && (active === last || !root.contains(active))) {
    ev.preventDefault();
    first.focus();
  }
}

export function isModalOpen(): boolean {
  return activeModal !== null;
}

export function closeActiveModal(): boolean {
  if (!activeModal) return false;
  activeModal.close();
  return true;
}

export function modal(options: {
  title: string;
  body: Child[];
  actions?: Child[];
  width?: number;
  onClose?: () => void;
}): ModalHandle {
  closeActiveModal();

  // a11y：对话框语义挂在面板上并由标题命名；打开时把焦点移进来，Tab 不外漏，关闭时还给原来的控件。
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const titleId = `mem-modal-title-${(modalSeq += 1)}`;
  const root = el('div', { class: 'modal-backdrop' });
  const panel = el('div', {
    class: 'modal-panel',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-labelledby': titleId,
    tabindex: '-1',
    style: { width: `min(${options.width ?? 640}px, calc(100vw - 32px))` },
  });
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    root.remove();
    document.removeEventListener('keydown', onKey);
    if (activeModal === handle) activeModal = null;
    options.onClose?.();
    if (previous && previous.isConnected) previous.focus();
  };
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') {
      ev.stopPropagation();
      close();
      return;
    }
    trapFocus(panel, ev);
  };

  panel.appendChild(el('div', { class: 'modal-head' },
    el('h2', { class: 'modal-title', id: titleId }, options.title),
    el('button', {
      class: 'icon-btn',
      type: 'button',
      'aria-label': '关闭',
      onClick: close,
    }, icon('close', 16))));
  panel.appendChild(el('div', { class: 'modal-body' }, ...options.body));
  if (options.actions && options.actions.length) {
    panel.appendChild(el('div', { class: 'modal-actions' }, ...options.actions));
  }
  root.appendChild(panel);
  root.addEventListener('mousedown', (ev) => {
    if (ev.target === root) close();
  });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(root);

  const handle: ModalHandle = { close, root };
  activeModal = handle;
  // 初始焦点：正文/操作区第一个控件（跳过右上角关闭按钮），没有就聚焦面板本身。
  const initial = focusableIn(panel).find((node) => !node.closest('.modal-head')) ?? panel;
  initial.focus();
  return handle;
}

export function toast(message: string, tone: Tone = 'info', timeoutMs = 3200): void {
  let host = document.getElementById('mem-toasts');
  if (!host) {
    // aria-live：读屏软件会播报 toast；危险提示单独用 role=alert 立即打断。
    host = el('div', { id: 'mem-toasts', class: 'toast-host', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(host);
  }
  const node = el('div', { class: `toast toast-${tone}`, role: tone === 'danger' ? 'alert' : null }, message);
  host.appendChild(node);
  window.setTimeout(() => {
    node.classList.add('is-leaving');
    window.setTimeout(() => node.remove(), 240);
  }, timeoutMs);
}

/* ---------------------------------------------------------------- 复制 */

export async function copyText(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    /* 回退到 execCommand */
  }
  try {
    const area = el('textarea', { class: 'copy-trap' });
    area.value = value;
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

export function copyButton(getValue: () => string, label = '复制'): HTMLButtonElement {
  const btn = button(label, { kind: 'subtle', iconName: 'copy' });
  btn.addEventListener('click', async () => {
    const ok = await copyText(getValue());
    toast(ok ? '已复制到剪贴板' : '复制失败，请手动选择文本', ok ? 'ok' : 'danger');
  });
  return btn;
}

/* ---------------------------------------------------------------- 分布条 */

export function distributionBars(
  buckets: { key: string; label?: string; count: number }[],
  options: { max?: number; onClick?: (key: string) => void } = {},
): HTMLElement {
  const box = el('div', { class: 'dist-bars' });
  const items = buckets.filter((b) => b.count > 0).slice(0, options.max ?? 12);
  if (!items.length) {
    box.appendChild(el('div', { class: 'dist-empty' }, '暂无数据'));
    return box;
  }
  const max = items.reduce((acc, item) => Math.max(acc, item.count), 0) || 1;
  for (const item of items) {
    const pct = Math.max(2, Math.round((item.count / max) * 100));
    const row = el('button', {
      class: 'dist-row',
      type: 'button',
      onClick: options.onClick ? () => options.onClick?.(item.key) : null,
      disabled: !options.onClick,
    },
      el('span', { class: 'dist-label', title: item.key }, item.label ?? item.key),
      el('span', { class: 'dist-track' }, el('span', { class: 'dist-fill', style: { width: `${pct}%` } })),
      el('span', { class: 'dist-count' }, fmtNumber(item.count)));
    box.appendChild(row);
  }
  return box;
}

/** 把 Record 形状的分布转成数组。 */
export function bucketsFrom(value: unknown): { key: string; count: number }[] {
  const out: { key: string; count: number }[] = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!item || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;
      const key = String(record.key ?? record.scope_id ?? record.kind ?? record.scope ?? record.name ?? record.label ?? '');
      const count = Number(record.count ?? record.n ?? record.value ?? 0);
      if (key) out.push({ key, count: Number.isFinite(count) ? count : 0 });
    }
    return out;
  }
  if (value && typeof value === 'object') {
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      const count = Number(typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>).count ?? 0 : raw);
      out.push({ key, count: Number.isFinite(count) ? count : 0 });
    }
  }
  return out;
}

export function clearNode(node: Element): void {
  clear(node);
}
