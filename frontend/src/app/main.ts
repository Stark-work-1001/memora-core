/**
 * memora-core 前端入口：全局布局、哈希路由、SSE 订阅、键盘快捷键、全局搜索。
 *
 * 设计原则：
 *  - 后端未启动也绝不白屏：先渲染外壳，再把内容区换成「无法连接后端」错误态。
 *  - 所有页面都在 #mem-root 内渲染；卸载时派发 mem:dispose 让页面释放订阅。
 *  - 零外部请求：不引 CDN、不引字体，图标全部内联 SVG。
 */

import './style.css';

import { el, clear, icon, type Child } from './dom';
import { EventStream, api, errorMessage, isConnectionIssue } from './api';
import type { Health, ServerEvent } from './types';
import { badge, button, errorState, fmtTime, isModalOpen, closeActiveModal, spinner, toast, trapFocus } from './pages/ui';
import type { PageContext, PageModule } from './pages/contract';

import { overviewPage } from './pages/overview';
import { memoriesPage } from './pages/memories';
import { documentsPage } from './pages/documents';
import { searchPage } from './pages/search';
import { workflowsPage } from './pages/workflows';
import { runsPage } from './pages/runs';
import { agentsPage } from './pages/agents';
import { modelsPage } from './pages/models';
import { algorithmsPage } from './pages/algorithms';
import { graphPage } from './pages/graph';
import { conflictsPage } from './pages/conflicts';
import { settingsPage } from './pages/settings';

/* ---------------------------------------------------------------- 路由表 */

const PAGES: PageModule[] = [
  overviewPage,
  memoriesPage,
  documentsPage,
  searchPage,
  workflowsPage,
  runsPage,
  agentsPage,
  modelsPage,
  algorithmsPage,
  graphPage,
  conflictsPage,
  settingsPage,
];

const GROUPS: { id: string; label: string }[] = [
  { id: 'main', label: '记忆' },
  { id: 'system', label: '系统' },
];

const BY_ID = new Map(PAGES.map((page) => [page.id, page]));
const DEFAULT_PAGE = 'overview';

/* ---------------------------------------------------------------- 应用状态 */

type Listener = (event: ServerEvent) => void;

interface AppState {
  page: PageModule;
  params: URLSearchParams;
  connection: 'online' | 'degraded' | 'offline' | 'checking';
  health: Health | null;
  lastEventAt: number;
}

const state: AppState = {
  page: BY_ID.get(DEFAULT_PAGE) as PageModule,
  params: new URLSearchParams(),
  connection: 'checking',
  health: null,
  lastEventAt: 0,
};

const listeners: Listener[] = [];

/* ---------------------------------------------------------------- 骨架 DOM */

const rootEl = document.getElementById('mem-root');

if (!rootEl) {
  // 极端兜底：连挂载点都没有时也不要白屏
  const fallback = el('div', { class: 'fatal-error' },
    el('h1', null, '页面初始化失败'),
    el('p', null, '找不到挂载点 #mem-root。请确认 index.html 未被修改。'));
  document.body.appendChild(fallback);
  throw new Error('missing #mem-root');
}

/** 挂载点（已在上面的分支中确保存在）。 */
const mountRoot: HTMLElement = rootEl;

const sidebar = el('nav', { class: 'sidebar', 'aria-label': '主导航' });
const topbar = el('header', { class: 'topbar' });
const content = el('main', { class: 'content', id: 'content' });
const shell = el('div', { class: 'shell' }, sidebar, el('div', { class: 'main-col' }, topbar, content));

const navItems = new Map<string, HTMLAnchorElement>();

function buildSidebar(): void {
  sidebar.appendChild(el('div', { class: 'brand' },
    icon('brain', 20),
    el('div', { class: 'brand-text' },
      el('strong', null, 'memora-core'),
      el('span', null, '本地记忆中枢'))));

  for (const group of GROUPS) {
    const pages = PAGES.filter((page) => page.group === group.id);
    if (!pages.length) continue;
    sidebar.appendChild(el('div', { class: 'nav-group-label' }, group.label));
    const list = el('div', { class: 'nav-group' });
    for (const page of pages) {
      const link = el('a', {
        class: 'nav-item',
        href: `#/${page.id}`,
        dataset: { page: page.id },
        title: page.shortcut ? `${page.title}（${page.shortcut}）` : page.title,
      },
        icon(page.icon, 16),
        el('span', { class: 'nav-label' }, page.title),
        page.shortcut ? el('span', { class: 'nav-key mono' }, page.shortcut) : null);
      navItems.set(page.id, link);
      list.appendChild(link);
    }
    sidebar.appendChild(list);
  }

  sidebar.appendChild(el('div', { class: 'sidebar-foot' },
    el('div', { class: 'conn-line' },
      el('span', { class: 'status-led', id: 'conn-led' }),
      el('span', { id: 'conn-text' }, '检查连接…')),
    el('div', { class: 'muted-text tiny' }, 'SQLite 真源 · Markdown 镜像 · 仅回环')));
}

/* ---------------------------------------------------------------- 顶栏 */

const pageTitle = el('h1', { class: 'topbar-title' }, '总览');
const statusText = el('span', { class: 'topbar-status' }, '');
const connBadge = el('span', { class: 'conn-badge' });
const searchTrigger = el('button', {
  class: 'search-trigger',
  type: 'button',
  title: '全局搜索（Ctrl+K）',
  onClick: () => openPalette(),
},
  icon('search', 14),
  el('span', null, '搜索记忆…'),
  el('kbd', null, 'Ctrl K'));

const refreshBtn = el('button', {
  class: 'icon-btn',
  type: 'button',
  title: '刷新当前页（F5 之外的手动刷新）',
  'aria-label': '刷新',
  onClick: () => void refreshPage(),
}, icon('refresh', 16));

function buildTopbar(): void {
  topbar.append(
    el('div', { class: 'topbar-left' }, pageTitle, statusText),
    el('div', { class: 'topbar-right' }, searchTrigger, connBadge, refreshBtn),
  );
}

function setConnection(next: AppState['connection'], health?: Health | null): void {
  state.connection = next;
  if (health !== undefined) state.health = health;
  const led = document.getElementById('conn-led');
  const text = document.getElementById('conn-text');
  const map: Record<AppState['connection'], { label: string; tone: string }> = {
    online: { label: '已连接后端', tone: 'ok' },
    degraded: { label: '连接正常 · 降级运行', tone: 'warn' },
    offline: { label: '未连接后端', tone: 'danger' },
    checking: { label: '检查连接…', tone: 'muted' },
  };
  const entry = map[next];
  if (led) led.className = `status-led tone-${entry.tone} ${next === 'online' || next === 'degraded' ? 'is-on' : ''}`;
  if (text) text.textContent = entry.label;
  clear(connBadge);
  const degradedList = Array.isArray(state.health?.degraded) ? state.health?.degraded ?? [] : [];
  connBadge.appendChild(badge(entry.label, entry.tone === 'ok' ? 'ok' : entry.tone === 'warn' ? 'warn' : entry.tone === 'danger' ? 'danger' : 'muted',
    next === 'degraded'
      ? `降级能力：${degradedList.join('、')}（未配置或不可用的模型角色由本地确定性算法兜底）`
      : undefined));
  if (next === 'offline' && state.health === null && text) {
    text.textContent = '未连接后端 · 点击重试';
  }
}

/* ---------------------------------------------------------------- 路由 */

function parseHash(): { id: string; params: URLSearchParams } {
  const raw = window.location.hash.replace(/^#\/?/, '');
  const [path, queryString] = raw.split('?');
  const id = (path || DEFAULT_PAGE).trim();
  return { id: BY_ID.has(id) ? id : DEFAULT_PAGE, params: new URLSearchParams(queryString ?? '') };
}

function navigate(route: string, params?: Record<string, string>): void {
  const id = BY_ID.has(route) ? route : DEFAULT_PAGE;
  const query = params ? new URLSearchParams(params).toString() : '';
  window.location.hash = `#/${id}${query ? `?${query}` : ''}`;
}

function highlightNav(id: string): void {
  for (const [pageId, link] of navItems) {
    link.classList.toggle('is-active', pageId === id);
    if (pageId === id) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

let disposeCurrent: (() => void) | null = null;
let currentMount: HTMLElement | null = null;

async function renderRoute(): Promise<void> {
  const { id, params } = parseHash();
  const page = BY_ID.get(id) ?? (BY_ID.get(DEFAULT_PAGE) as PageModule);
  state.page = page;
  state.params = params;

  highlightNav(page.id);
  pageTitle.textContent = page.title;
  document.title = `${page.title} · memora-core`;
  statusText.textContent = '';

  if (disposeCurrent) {
    disposeCurrent();
    disposeCurrent = null;
  }
  // 通知旧页面释放资源（SSE 订阅、resize 监听、定时器）。页面都监听在 ctx.mount 上，
  // 所以必须派发到旧 mount 本身——1.0.0 派发在 #content 且不冒泡，页面从来收不到。
  if (currentMount) currentMount.dispatchEvent(new CustomEvent('mem:dispose'));
  currentMount = null;
  content.replaceChildren();
  const mount = el('div', { class: 'page-mount', dataset: { page: page.id } });
  currentMount = mount;
  content.appendChild(mount);
  content.scrollTop = 0;

  const unsubs: (() => void)[] = [];
  const ctx: PageContext = {
    mount,
    params,
    navigate,
    setStatus(text: string) {
      statusText.textContent = text;
    },
    notify(message: string, tone = 'info') {
      toast(message, tone);
    },
    onEvent(kinds: string[], handler: () => void) {
      const listener: Listener = (event) => {
        if (kinds.includes(event.type) || kinds.includes('*')) handler();
      };
      listeners.push(listener);
      const unsub = (): void => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      };
      unsubs.push(unsub);
      return unsub;
    },
  };

  disposeCurrent = () => {
    for (const unsub of unsubs) unsub();
  };

  try {
    await page.render(ctx);
  } catch (error) {
    mount.replaceChildren(errorState({
      error,
      title: `${page.title} 渲染失败`,
      onRetry: () => void renderRoute(),
    }));
  }
}

async function refreshPage(): Promise<void> {
  await renderRoute();
}

/* ---------------------------------------------------------------- 全局搜索面板 */

let paletteEl: HTMLElement | null = null;
let paletteReturnFocus: HTMLElement | null = null;

function closePalette(): void {
  if (paletteEl) {
    paletteEl.remove();
    paletteEl = null;
    if (paletteReturnFocus && paletteReturnFocus.isConnected) paletteReturnFocus.focus();
    paletteReturnFocus = null;
  }
}

function openPalette(): void {
  if (paletteEl) return;
  paletteReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const input = el('input', {
    class: 'palette-input',
    type: 'search',
    placeholder: '搜索记忆（标题 / 正文 / 标签）…',
    'aria-label': '搜索记忆',
    autofocus: true,
  });
  const results = el('div', { class: 'palette-results' });
  const hint = el('div', { class: 'palette-hint' },
    el('kbd', null, '↑'), el('kbd', null, '↓'), ' 选择 · ',
    el('kbd', null, 'Enter'), ' 打开 · ',
    el('kbd', null, 'Esc'), ' 关闭');

  const panel = el('div', { class: 'palette', role: 'dialog', 'aria-modal': 'true', 'aria-label': '全局搜索' },
    el('div', { class: 'palette-head' }, icon('search', 16), input),
    results,
    hint);
  const overlay = el('div', { class: 'palette-overlay' }, panel);
  panel.addEventListener('keydown', (ev) => trapFocus(panel, ev));
  document.body.appendChild(overlay);
  paletteEl = overlay;
  input.focus();

  let index = 0;
  let items: { id: string; title: string; sub: string }[] = [];

  const renderResults = (): void => {
    results.replaceChildren();
    if (!items.length) {
      results.appendChild(el('div', { class: 'palette-empty' },
        input.value.trim() ? '没有命中结果' : '输入关键词开始搜索'));
      return;
    }
    items.forEach((item, i) => {
      const row = el('button', {
        class: `palette-item ${i === index ? 'is-active' : ''}`.trim(),
        type: 'button',
        onClick: () => {
          closePalette();
          navigate('memories', { id: item.id });
        },
      },
        el('span', { class: 'palette-item-title' }, item.title || item.id),
        el('span', { class: 'palette-item-sub' }, item.sub));
      results.appendChild(row);
    });
    const active = results.querySelector('.palette-item.is-active');
    if (active && 'scrollIntoView' in active) {
      (active as HTMLElement).scrollIntoView({ block: 'nearest' });
    }
  };

  let timer: number | undefined;
  const runSearch = async (): Promise<void> => {
    const q = input.value.trim();
    if (!q) {
      items = [];
      renderResults();
      return;
    }
    results.replaceChildren(el('div', { class: 'palette-loading' }, spinner('搜索中…')));
    try {
      const result = await api.search({ q, limit: 12, strategy: 'hybrid' });
      items = (result.hits ?? []).map((hit) => ({
        id: hit.id,
        title: hit.title ?? hit.id,
        sub: `${hit.kind ?? 'memory'} · ${(hit.score ?? 0).toFixed(2)}${hit.scope_id ? ` · ${hit.scope_id}` : ''}`,
      }));
      index = 0;
      renderResults();
    } catch (error) {
      results.replaceChildren(el('div', { class: 'palette-empty' }, errorMessage(error)));
    }
  };

  input.addEventListener('input', () => {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = window.setTimeout(() => void runSearch(), 220);
  });
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      index = Math.min(items.length - 1, index + 1);
      renderResults();
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      index = Math.max(0, index - 1);
      renderResults();
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      if (items[index]) {
        const target = items[index];
        closePalette();
        navigate('memories', { id: target.id });
      } else {
        const q = input.value.trim();
        if (q) {
          closePalette();
          navigate('search', { q });
        }
      }
    }
  });

  overlay.addEventListener('mousedown', (ev) => {
    if (ev.target === overlay) closePalette();
  });

  renderResults();
}

/* ---------------------------------------------------------------- 键盘 */

let gPrefixAt = 0;

const SHORTCUTS: Record<string, string> = {
  o: 'overview',
  m: 'memories',
  d: 'documents',
  s: 'search',
  w: 'workflows',
  r: 'runs',
  a: 'agents',
  l: 'models',
  k: 'algorithms',
  b: 'graph',
  c: 'conflicts',
  ',': 'settings',
};

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

function bindKeyboard(): void {
  document.addEventListener('keydown', (ev) => {
    // Ctrl/Cmd + K：全局搜索
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'k') {
      ev.preventDefault();
      openPalette();
      return;
    }
    // Ctrl/Cmd + R 交回浏览器，别抢
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'r') return;

    if (ev.key === 'Escape') {
      if (paletteEl) {
        closePalette();
        ev.preventDefault();
        return;
      }
      if (isModalOpen() && closeActiveModal()) {
        ev.preventDefault();
      }
      return;
    }

    if (isTypingTarget(ev.target) || ev.ctrlKey || ev.metaKey || ev.altKey) return;

    // g 前缀跳页
    if (ev.key === 'g') {
      gPrefixAt = Date.now();
      return;
    }
    if (Date.now() - gPrefixAt < 1200) {
      const target = SHORTCUTS[ev.key.toLowerCase()];
      if (target) {
        ev.preventDefault();
        gPrefixAt = 0;
        navigate(target);
        return;
      }
    }
    if (ev.key === '/') {
      ev.preventDefault();
      openPalette();
    }
  });
}

/* ---------------------------------------------------------------- SSE */

let stream: EventStream | null = null;

function startStream(): void {
  if (stream) stream.dispose();
  stream = new EventStream((event) => {
    state.lastEventAt = Date.now();
    // system 事件携带启停 / 降级变化：重新取一次 health，让侧栏状态如实
    if (state.connection === 'offline' || event.type === 'system') void checkHealth();
    for (const listener of listeners.slice()) {
      try {
        listener(event);
      } catch {
        /* 单个订阅者异常不影响其它页面 */
      }
    }
  }, (streamState) => {
    if (streamState === 'open') {
      // 重连成功：以 /api/health 为准（可能是在线，也可能是"在线但模型降级"）
      if (state.connection === 'offline' || state.connection === 'checking') void checkHealth();
    } else if (streamState === 'closed') {
      // SSE 断开：立刻复查一次 health。确认离线后才进入 8 秒轮询。
      void checkHealth();
    }
  });
  stream.start();
}

/* ---------------------------------------------------------------- 健康检查 */

let healthTimer: number | undefined;

async function checkHealth(): Promise<void> {
  try {
    const health = await api.ping();
    // degraded 是**列表**，[] 表示没有降级。1.0.0 写的是 Boolean(health.degraded)，
    // 而 Boolean([]) === true，于是界面永远显示"降级"、8 秒轮询永不停止。
    const degraded = Array.isArray(health.degraded) && health.degraded.length > 0;
    setConnection(degraded ? 'degraded' : 'online', health);
    if (!stream) startStream();
  } catch {
    setConnection('offline', null);
    const led = document.getElementById('conn-led');
    led?.setAttribute('title', '后端未启动：python -m memora_core serve');
  }
}

function scheduleHealth(): void {
  if (healthTimer !== undefined) window.clearInterval(healthTimer);
  healthTimer = window.setInterval(() => {
    // 只在离线时轮询。"在线但降级"（例如没配模型）是稳定状态，不需要每 8 秒问一次；
    // 连接状态由 SSE 维持，SSE 断开 / system 事件时会主动复查。
    if (state.connection === 'offline') void checkHealth();
  }, 8000);
}

/* ---------------------------------------------------------------- 启动 */

async function boot(): Promise<void> {
  buildSidebar();
  buildTopbar();
  bindKeyboard();
  mountRoot.appendChild(shell);
  setConnection('checking');

  await checkHealth();
  scheduleHealth();

  window.addEventListener('hashchange', () => {
    void renderRoute();
  });

  try {
    await renderRoute();
  } catch (error) {
    content.replaceChildren(errorState({
      error,
      title: '页面加载失败',
      onRetry: () => void renderRoute(),
    }));
  }

  window.addEventListener('error', (event) => {
    if (event.error) toast(`脚本错误：${errorMessage(event.error)}`, 'danger');
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason = (event as PromiseRejectionEvent).reason;
    if (reason) toast(`未处理的异常：${errorMessage(reason)}`, 'danger');
  });
}

void boot();

/* ---------------------------------------------------------------- 对外导出（调试用） */

export const app = {
  navigate,
  refresh: refreshPage,
  pages: PAGES.map((page) => page.id),
  get connection() {
    return state.connection;
  },
  get health() {
    return state.health;
  },
};

/** 供调试：在控制台查看当前连接状态与最后事件时间。 */
export function debugInfo(): string {
  return JSON.stringify({
    page: state.page.id,
    connection: state.connection,
    lastEventAt: state.lastEventAt ? fmtTime(state.lastEventAt) : null,
    health: state.health?.version ?? null,
  });
}

void ((): Child => null);
