/**
 * 叠加 UI：视图切换 / 过滤 / 搜索 / mini-map / 统计 / 图例 / 导出 PNG。
 *
 * 为什么整个 UI 由 brain.js 自己构建：build.mjs 生成的 brain.html 只有一个
 * <div id="mem-brain">，没有别的 DOM 可依赖。所以这里用模版字符串一次性建出
 * 全部结构，样式集中在 style.css（由 main.ts 在运行时注入）。
 *
 * 三个受控约定：
 *  - 视图/过滤/搜索都只"发事件"，状态由 main.ts 持有，避免出现第二份真源；
 *  - mini-map 是独立 2D canvas，5000 个点直接投影画，比把 3D 场景渲染两遍便宜得多；
 *  - 导出 PNG 不用 preserveDrawingBuffer（three 默认会在下一帧清缓冲区），
 *    而是"立刻重绘一帧再 toDataURL"，保证导出的一定是当前画面。
 */
import type { BrainGraph, ViewKind } from './types';

/** UI 状态（由 main 持有，UI 只读）。 */
export interface UiState {
  view: ViewKind;
  dims: 2 | 3;
  demo: boolean;
  loading: boolean;
  nodeCount: number;
  edgeCount: number;
  fps: number;
  labels: number;
  layoutMode: 'worker' | 'main';
  filter: FilterState;
  note: string;
}

/** 过滤条件。 */
export interface FilterState {
  kinds: Set<string>;
  scope: string;
  range: 'all' | '7d' | '30d' | '365d';
}

/** UI 回调。 */
export interface UiHandlers {
  onView(view: ViewKind): void;
  onDims(dims: 2 | 3): void;
  onFilter(filter: FilterState): void;
  onSearch(text: string): void;
  onSearchPick(index: number): void;
  onExport(): void;
  onReset(): void;
  onPathMode(on: boolean): void;
}

/** 节点类别中文名（图例与搜索结果用）。 */
export const KIND_LABEL: Record<string, string> = {
  fact: '事实', knowledge: '知识', decision: '决策', preference: '偏好', procedure: '流程',
  experience: '经验', task: '任务', turn: '对话', tool: '工具', artifact: '产物',
  concept: '概念', entity: '实体', person: '人物', project: '项目', term: '术语',
  memory: '记忆', evidence: '证据', source: '来源', document: '文档',
};

/** 视图中文名。 */
export const VIEW_LABEL: Record<ViewKind, string> = {
  semantic: '词义脑图',
  hierarchy: '层级脑图',
  timeline: '时间线',
  evidence: '证据链',
};

/** 叠加层。 */
export class BrainUi {
  readonly root: HTMLElement;
  private readonly handlers: UiHandlers;
  private readonly els: Record<string, HTMLElement> = {};
  private readonly kindChips = new Map<string, HTMLButtonElement>();
  private minimap: HTMLCanvasElement | null = null;
  private minimapCtx: CanvasRenderingContext2D | null = null;

  constructor(mount: HTMLElement, handlers: UiHandlers) {
    this.handlers = handlers;
    this.root = document.createElement('div');
    this.root.className = 'mem-brain-ui';
    this.root.innerHTML = TEMPLATE;
    mount.appendChild(this.root);
    this.cacheElements();
    this.wire();
    this.minimap = this.els.minimap as HTMLCanvasElement;
    this.minimapCtx = this.minimap.getContext('2d');
  }

  private cacheElements(): void {
    const ids = [
      'views', 'dimsToggle', 'kindChips', 'scopeSelect', 'rangeSelect',
      'search', 'searchList', 'minimap', 'stats', 'legend', 'watermark',
      'exportBtn', 'resetBtn', 'pathBtn', 'status', 'loading', 'note',
    ];
    for (const id of ids) {
      const el = this.root.querySelector('[data-el="' + id + '"]');
      if (el) this.els[id] = el as HTMLElement;
    }
  }

  private wire(): void {
    this.els.views.addEventListener('click', (event) => {
      const btn = (event.target as HTMLElement).closest('button[data-view]') as HTMLButtonElement | null;
      if (btn && btn.dataset.view) this.handlers.onView(btn.dataset.view as ViewKind);
    });
    this.els.dimsToggle.addEventListener('click', (event) => {
      const btn = (event.target as HTMLElement).closest('button[data-dims]') as HTMLButtonElement | null;
      if (btn && btn.dataset.dims) this.handlers.onDims(Number(btn.dataset.dims) as 2 | 3);
    });
    this.els.scopeSelect.addEventListener('change', () => this.emitFilter());
    this.els.rangeSelect.addEventListener('change', () => this.emitFilter());
    this.els.kindChips.addEventListener('click', (event) => {
      const chip = (event.target as HTMLElement).closest('button[data-kind]') as HTMLButtonElement | null;
      if (!chip) return;
      chip.classList.toggle('is-off');
      this.emitFilter();
    });
    this.els.search.addEventListener('input', () => {
      this.handlers.onSearch((this.els.search as HTMLInputElement).value.trim());
    });
    this.els.searchList.addEventListener('click', (event) => {
      const item = (event.target as HTMLElement).closest('button[data-hit]') as HTMLButtonElement | null;
      if (item && item.dataset.hit !== undefined) this.handlers.onSearchPick(Number(item.dataset.hit));
    });
    this.els.exportBtn.addEventListener('click', () => this.handlers.onExport());
    this.els.resetBtn.addEventListener('click', () => this.handlers.onReset());
    this.els.pathBtn.addEventListener('click', () => {
      this.els.pathBtn.classList.toggle('is-active');
      this.handlers.onPathMode(this.els.pathBtn.classList.contains('is-active'));
    });
    // "/" 聚焦搜索框
    window.addEventListener('keydown', (event) => {
      const target = event.target as HTMLElement | null;
      const typing = target !== null && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA');
      if (event.key === '/' && !typing) {
        event.preventDefault();
        const input = this.els.search as HTMLInputElement;
        input.focus();
        input.select();
      }
    });
  }

  /** 读出当前过滤条件（kind chips + 下拉）。 */
  private emitFilter(): void {
    const kinds = new Set<string>();
    for (const entry of this.kindChips) {
      const [kind, chip] = entry;
      if (!chip.classList.contains('is-off')) kinds.add(kind);
    }
    this.handlers.onFilter({
      kinds,
      scope: (this.els.scopeSelect as HTMLSelectElement).value,
      range: (this.els.rangeSelect as HTMLSelectElement).value as FilterState['range'],
    });
  }

  /** 整体刷新（每帧最多调一次，写 DOM 的字段尽量少）。 */
  render(state: UiState): void {
    for (const btn of Array.from(this.els.views.querySelectorAll('button[data-view]'))) {
      btn.classList.toggle('is-active', (btn as HTMLButtonElement).dataset.view === state.view);
    }
    this.els.dimsToggle.style.display = state.view === 'hierarchy' ? '' : 'none';
    for (const btn of Array.from(this.els.dimsToggle.querySelectorAll('button[data-dims]'))) {
      btn.classList.toggle('is-active', Number((btn as HTMLButtonElement).dataset.dims) === state.dims);
    }
    this.els.watermark.style.display = state.demo ? '' : 'none';
    this.els.loading.style.display = state.loading ? '' : 'none';
    if (this.els.note.textContent !== state.note) this.els.note.textContent = state.note;
    this.els.stats.innerHTML =
      '<div><span>节点</span><b>' + state.nodeCount.toLocaleString() + '</b></div>' +
      '<div><span>边</span><b>' + state.edgeCount.toLocaleString() + '</b></div>' +
      '<div><span>标签</span><b>' + state.labels + '</b></div>' +
      '<div><span>帧率</span><b class="' + (state.fps > 0 && state.fps < 40 ? 'is-warn' : '') + '">' +
      (state.fps > 0 ? state.fps.toFixed(0) : '--') + '</b></div>' +
      '<div><span>布局</span><b>' + (state.layoutMode === 'worker' ? 'Worker' : '主线程') + '</b></div>';
  }

  /** 图例 + kind 过滤 chips（图变化时重建）。 */
  renderLegend(graph: BrainGraph, colors: Record<string, string>): void {
    const kinds = new Set<string>();
    for (const node of graph.nodes) kinds.add(node.kind);
    const ordered = Array.from(kinds).sort();
    this.kindChips.clear();
    this.els.kindChips.innerHTML = '';
    this.els.legend.innerHTML = '';
    for (const kind of ordered) {
      const color = colors[kind] ?? colors.default ?? '#8fa3bd';
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.dataset.kind = kind;
      chip.className = 'mem-chip';
      chip.innerHTML = '<i style="background:' + color + '"></i>' + escapeHtml(KIND_LABEL[kind] ?? kind);
      this.els.kindChips.appendChild(chip);
      this.kindChips.set(kind, chip);

      const row = document.createElement('div');
      row.className = 'mem-legend-row';
      row.innerHTML = '<i style="background:' + color + '"></i><span>' + escapeHtml(KIND_LABEL[kind] ?? kind) + '</span>';
      this.els.legend.appendChild(row);
    }
    if (!ordered.length) this.els.legend.innerHTML = '<div class="mem-muted">没有节点</div>';
  }

  /** 作用域下拉。 */
  renderScopes(scopes: string[]): void {
    const select = this.els.scopeSelect as HTMLSelectElement;
    const current = select.value;
    select.innerHTML = '<option value="">全部作用域</option>';
    for (const scope of scopes.slice(0, 200)) {
      const opt = document.createElement('option');
      opt.value = scope;
      opt.textContent = scope;
      select.appendChild(opt);
    }
    if (current) select.value = current;
  }

  /** 搜索结果下拉。 */
  renderSearch(hits: Array<{ index: number; label: string; kind: string }>): void {
    const list = this.els.searchList;
    if (!hits.length) {
      list.innerHTML = '';
      list.classList.remove('is-open');
      return;
    }
    list.innerHTML = hits.slice(0, 12).map((hit) =>
      '<button type="button" data-hit="' + hit.index + '"><b>' + escapeHtml(hit.label) +
      '</b><span>' + escapeHtml(KIND_LABEL[hit.kind] ?? hit.kind) + '</span></button>').join('');
    list.classList.add('is-open');
  }

  /** 状态栏文案。 */
  setStatus(text: string): void {
    if (this.els.status.textContent !== text) this.els.status.textContent = text;
  }

  /** mini-map：把节点投影到 2D 画布（俯视 XY 平面）。 */
  drawMinimap(positions: Float32Array, kinds: string[], colors: Record<string, string>, selected: number): void {
    const canvas = this.minimap;
    const ctx = this.minimapCtx;
    if (!canvas || !ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = canvas.clientWidth || 160;
    const h = canvas.clientHeight || 160;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(7, 13, 21, 0.72)';
    ctx.fillRect(0, 0, w, h);

    const n = kinds.length;
    if (!n) return;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = positions[i * 3];
      const y = positions[i * 3 + 1];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const spanX = Math.max(1e-3, maxX - minX);
    const spanY = Math.max(1e-3, maxY - minY);
    const pad = 6;
    const scale = Math.min((w - pad * 2) / spanX, (h - pad * 2) / spanY);
    const offX = (w - spanX * scale) / 2;
    const offY = (h - spanY * scale) / 2;
    for (let i = 0; i < n; i++) {
      const sx = offX + (positions[i * 3] - minX) * scale;
      const sy = h - (offY + (positions[i * 3 + 1] - minY) * scale);
      ctx.fillStyle = i === selected ? '#ffffff' : (colors[kinds[i]] ?? '#8fa3bd');
      const r = i === selected ? 2.6 : 1.1;
      ctx.fillRect(sx - r, sy - r, r * 2, r * 2);
    }
    ctx.strokeStyle = 'rgba(120, 200, 240, 0.45)';
    ctx.lineWidth = 1;
    ctx.strokeRect(offX, offY, spanX * scale, spanY * scale);
  }

  /** 点击 mini-map → 归一化坐标 (0..1)，调用方自己决定要不要用它移动相机。 */
  onMinimapClick(handler: (fx: number, fy: number) => void): void {
    const canvas = this.minimap;
    if (!canvas) return;
    canvas.addEventListener('click', (event) => {
      const rect = canvas.getBoundingClientRect();
      handler(
        (event.clientX - rect.left) / Math.max(1, rect.width),
        (event.clientY - rect.top) / Math.max(1, rect.height),
      );
    });
  }

  dispose(): void {
    this.root.remove();
  }
}

/** HTML 转义（节点标题来自用户数据，必须转义）。 */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => {
    if (ch === '&') return '&amp;';
    if (ch === '<') return '&lt;';
    if (ch === '>') return '&gt;';
    if (ch === '"') return '&quot;';
    return '&#39;';
  });
}

const TEMPLATE = [
  '<div class="mem-topbar">',
  '  <div class="mem-group mem-views" data-el="views">',
  '    <button type="button" data-view="semantic" class="is-active">词义脑图</button>',
  '    <button type="button" data-view="hierarchy">层级脑图</button>',
  '    <button type="button" data-view="timeline">时间线</button>',
  '    <button type="button" data-view="evidence">证据链</button>',
  '  </div>',
  '  <div class="mem-group mem-dims" data-el="dimsToggle" style="display:none">',
  '    <button type="button" data-dims="2">2D 正交</button>',
  '    <button type="button" data-dims="3">3D 径向</button>',
  '  </div>',
  '  <div class="mem-spacer"></div>',
  '  <div class="mem-searchbox">',
  '    <input data-el="search" type="search" placeholder="搜索节点（/）" autocomplete="off" spellcheck="false">',
  '    <div class="mem-search-list" data-el="searchList"></div>',
  '  </div>',
  '  <div class="mem-group">',
  '    <button type="button" data-el="resetBtn" title="复位视角（Space）">复位</button>',
  '    <button type="button" data-el="pathBtn" title="路径查找：依次点两个节点">路径</button>',
  '    <button type="button" data-el="exportBtn" title="导出当前画面为 PNG">导出 PNG</button>',
  '  </div>',
  '</div>',
  '<div class="mem-filter">',
  '  <div class="mem-filter-title">过滤</div>',
  '  <div class="mem-chips" data-el="kindChips"></div>',
  '  <div class="mem-filter-row">',
  '    <label>作用域<select data-el="scopeSelect"><option value="">全部作用域</option></select></label>',
  '  </div>',
  '  <div class="mem-filter-row">',
  '    <label>时间<select data-el="rangeSelect">',
  '      <option value="all">全部</option>',
  '      <option value="7d">近 7 天</option>',
  '      <option value="30d">近 30 天</option>',
  '      <option value="365d">近一年</option>',
  '    </select></label>',
  '  </div>',
  '</div>',
  '<div class="mem-watermark" data-el="watermark" style="display:none">演示数据</div>',
  '<div class="mem-loading" data-el="loading" style="display:none">布局计算中…</div>',
  '<div class="mem-minimap-wrap"><canvas data-el="minimap" class="mem-minimap" width="160" height="160"></canvas></div>',
  '<div class="mem-stats" data-el="stats"></div>',
  '<div class="mem-legend" data-el="legend"></div>',
  '<div class="mem-statusbar"><span data-el="status"></span><span class="mem-note" data-el="note"></span></div>',
].join('');
