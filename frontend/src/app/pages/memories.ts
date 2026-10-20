/**
 * 记忆库：左侧虚拟滚动列表（q/kind/status/scope 过滤 + 排序），右侧详情
 * （Markdown 正文、证据、富块公式 KaTeX、关系入口、审核、SM-2 复习评分）。
 */

import { el, clear, debounce, icon } from '../dom';
import { api, ApiError, errorMessage, isConnectionIssue } from '../api';
import type { Didactic, Evidence, MemBlock, Memory, MemoryEdge, MemoryListQuery, Paged } from '../types';
import { KIND_LABELS, STATUS_LABELS } from '../types';
import { mathBlock, renderMarkdownInto, plainText } from '../markdown';
import {
  badge, button, busy, card, emptyState, errorState, fmtDateTime, fmtNumber, fmtPercent,
  fmtRelative, jsonBlock, modal, sectionTitle, select, skeleton, statusBadge, textInput, toast,
} from './ui';
import type { PageContext, PageModule } from './contract';

const ITEM_HEIGHT = 78;
const PAGE_SIZE = 100;

/** 排序选项 → store.SORTS 的 sort + order（1.0.0 发的 created_desc 等值后端不认，全部退回 updated_at）。 */
const SORT_OPTIONS: { value: string; label: string }[] = [
  { value: 'recorded_at:desc', label: '最新入库' },
  { value: 'recorded_at:asc', label: '最早入库' },
  { value: 'updated_at:desc', label: '最近更新' },
  { value: 'trust:desc', label: '信任度' },
  { value: 'importance:desc', label: '重要度' },
  { value: 'review_due:asc', label: '复习到期' },
];

function applySort(query: MemoryListQuery, value: string): void {
  const [sort, order] = value.split(':');
  query.sort = sort;
  query.order = order === 'asc' ? 'asc' : 'desc';
}

/* ---------------------------------------------------------------- 虚拟列表 */

interface VirtualList<T> {
  root: HTMLElement;
  setItems(items: T[]): void;
  setLoading(loading: boolean): void;
  scrollToIndex(index: number): void;
  refresh(): void;
}

function createVirtualList<T>(options: {
  render: (item: T, index: number) => HTMLElement;
  onNearEnd: () => void;
  emptyNode: () => HTMLElement;
}): VirtualList<T> {
  const root = el('div', { class: 'vlist' });
  const spacer = el('div', { class: 'vlist-spacer' });
  const viewport = el('div', { class: 'vlist-viewport' });
  const overlay = el('div', { class: 'vlist-overlay' });
  root.append(spacer, viewport, overlay);

  let items: T[] = [];

  const paint = (): void => {
    if (!items.length) {
      viewport.replaceChildren();
      spacer.style.height = '0px';
      return;
    }
    const scrollTop = root.scrollTop;
    const height = root.clientHeight || 600;
    const first = Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT) - 4);
    const visible = Math.ceil(height / ITEM_HEIGHT) + 9;
    const last = Math.min(items.length, first + visible);
    spacer.style.height = `${items.length * ITEM_HEIGHT}px`;
    viewport.style.transform = `translateY(${first * ITEM_HEIGHT}px)`;

    const frag = document.createDocumentFragment();
    for (let i = first; i < last; i += 1) {
      const node = options.render(items[i], i);
      node.style.height = `${ITEM_HEIGHT}px`;
      node.dataset.index = String(i);
      frag.appendChild(node);
    }
    viewport.replaceChildren(frag);

    if (!items.length) overlay.replaceChildren(options.emptyNode());
    else overlay.replaceChildren();
  };

  root.addEventListener('scroll', () => {
    paint();
    if (items.length && root.scrollTop + root.clientHeight > items.length * ITEM_HEIGHT - ITEM_HEIGHT * 6) {
      options.onNearEnd();
    }
  });

  const resizeObserver = new ResizeObserver(() => paint());
  resizeObserver.observe(root);

  return {
    root,
    setItems(next: T[]) {
      items = next;
      if (!items.length) {
        overlay.replaceChildren(options.emptyNode());
        paint();
        return;
      }
      paint();
    },
    setLoading(next: boolean) {
      root.classList.toggle('is-loading', next);
      root.setAttribute('aria-busy', next ? 'true' : 'false');
    },
    scrollToIndex(index: number) {
      root.scrollTop = Math.max(0, index * ITEM_HEIGHT - ITEM_HEIGHT);
      paint();
    },
    refresh() {
      paint();
    },
  };
}

/* ---------------------------------------------------------------- 过滤列 */

function kindLabel(kind: unknown): string {
  const key = String(kind ?? '');
  return KIND_LABELS[key] ?? (key || '未分类');
}

function trustTone(trust: number): 'ok' | 'warn' | 'danger' {
  if (trust >= 0.75) return 'ok';
  if (trust >= 0.5) return 'warn';
  return 'danger';
}

/* ---------------------------------------------------------------- 页面 */

export const memoriesPage: PageModule = {
  id: 'memories',
  title: '记忆库',
  icon: 'memories',
  group: 'main',
  shortcut: 'g m',
  render(ctx) {
    const query: MemoryListQuery = {
      q: ctx.params.get('q') ?? '',
      kind: ctx.params.get('kind') ?? '',
      status: ctx.params.get('status') ?? '',
      scope: ctx.params.get('scope') ?? '',
      limit: PAGE_SIZE,
      offset: 0,
    };
    const initialSort = SORT_OPTIONS.some((item) => item.value === ctx.params.get('sort'))
      ? String(ctx.params.get('sort'))
      : 'recorded_at:desc';
    applySort(query, initialSort);

    let all: Memory[] = [];
    let total = 0;
    let loading = false;
    let selectedId: string | null = ctx.params.get('id');
    let disposed = false;
    /** 最近一次复习返回的 ease（memory 行本身不存 ease）。 */
    const lastEase = new Map<string, number | undefined>();

    const page = el('div', { class: 'page page-memories' });
    const split = el('div', { class: 'split' });
    const left = el('div', { class: 'split-left' });
    const right = el('div', { class: 'split-right' });
    split.append(left, right);
    page.appendChild(split);
    ctx.mount.appendChild(page);

    /* -------- 过滤器 -------- */

    const searchInput = textInput({
      value: query.q,
      placeholder: '搜索标题、正文、标签…',
      className: 'input-search',
    });
    const debouncedReload = debounce(() => {
      query.q = searchInput.value.trim();
      void reload();
    }, 260);
    searchInput.addEventListener('input', () => debouncedReload());

    const kindSelect = select({
      items: [
        { value: '', label: '全部类型' },
        ...Object.keys(KIND_LABELS).map((key) => ({ value: key, label: `${KIND_LABELS[key]} · ${key}` })),
      ],
      value: query.kind,
      onChange: (value) => {
        query.kind = value;
        void reload();
      },
    });

    const statusSelect = select({
      items: [
        { value: '', label: '全部状态（不含归档）' },
        ...Object.keys(STATUS_LABELS).map((key) => ({ value: key, label: STATUS_LABELS[key] })),
      ],
      value: query.status,
      onChange: (value) => {
        query.status = value;
        void reload();
      },
    });

    const scopeInput = textInput({
      value: query.scope,
      placeholder: '作用域，如 workspace:demo',
      onEnter: () => {
        query.scope = scopeInput.value.trim();
        void reload();
      },
    });

    const sortSelect = select({
      items: SORT_OPTIONS,
      value: initialSort,
      onChange: (value) => {
        applySort(query, value);
        void reload();
      },
    });

    const listMeta = el('span', { class: 'list-meta' }, '—');
    const refreshBtn = button('刷新', { iconName: 'refresh', kind: 'subtle', onClick: () => void reload() });

    const toolbar = el('div', { class: 'list-toolbar' },
      searchInput,
      el('div', { class: 'filter-row' }, kindSelect, statusSelect, sortSelect),
      el('div', { class: 'filter-row' }, scopeInput,
        button('应用', { kind: 'subtle', onClick: () => { query.scope = scopeInput.value.trim(); void reload(); } })),
      el('div', { class: 'list-status' }, listMeta, refreshBtn));
    left.appendChild(toolbar);

    /* -------- 列表 -------- */

    const vlist = createVirtualList<Memory>({
      render: (memory) => renderListItem(memory),
      onNearEnd: () => {
        if (!loading && all.length < total) void loadMore();
      },
      emptyNode: () => emptyState(
        all.length ? '没有匹配的记忆' : '记忆库还是空的',
        all.length ? '试着放宽过滤条件' : '在「文档库」导入文档，或让智能体通过 MCP 写入记忆',
      ),
    });
    left.appendChild(vlist.root);

    function renderListItem(memory: Memory): HTMLElement {
      const active = memory.id === selectedId;
      const trust = Number(memory.trust ?? 0.5);
      const node = el('button', {
        class: `memo-item ${active ? 'is-active' : ''}`.trim(),
        type: 'button',
        onClick: () => void selectMemory(memory.id),
        dataset: { id: memory.id },
      });
      const title = memory.title ?? plainText(memory.body ?? '', 60) ?? memory.id;
      const snippet = plainText(memory.body ?? memory.summary ?? '', 90);
      node.append(
        el('div', { class: 'memo-item-head' },
          el('span', { class: 'memo-title', title }, title || '（无标题）'),
          statusBadge(memory.status)),
        el('div', { class: 'memo-item-sub' },
          badge(kindLabel(memory.kind), 'info'),
          badge(`信任 ${fmtPercent(trust)}`, trustTone(trust)),
          memory.scope_id ? el('span', { class: 'muted-text mono' }, memory.scope_id) : null),
        el('div', { class: 'memo-item-snippet' }, snippet || '（正文为空）'),
        el('div', { class: 'memo-item-foot' },
          el('span', { class: 'muted-text' }, fmtRelative(memory.recorded_at ?? memory.updated_at)),
          memory.review_count ? el('span', { class: 'muted-text' }, `复习 ${memory.review_count} 次`) : null));
      return node;
    }

    /* -------- 数据加载 -------- */

    async function reload(): Promise<void> {
      if (disposed) return;
      loading = true;
      query.offset = 0;
      vlist.setLoading(true);
      listMeta.textContent = '加载中…';
      try {
        const result: Paged<Memory> = await api.memories(query);
        if (disposed) return;
        all = result.items;
        total = result.total;
        vlist.setItems(all);
        listMeta.textContent = `${fmtNumber(all.length)} / ${fmtNumber(total)} 条`;
        if (!all.length && !selectedId) {
          renderEmptyDetail();
        } else if (!selectedId) {
          void selectMemory(all[0].id);
        } else {
          // 深链（#/memories?id=…）指向的记忆不一定在当前这一页：直接按 id 取；取不到再退回第一条
          void selectMemory(selectedId, all[0]?.id);
        }
      } catch (error) {
        if (disposed) return;
        all = [];
        total = 0;
        vlist.setItems([]);
        listMeta.textContent = '加载失败';
        right.replaceChildren(errorState({
          error,
          title: isConnectionIssue(error) ? '无法连接后端' : '记忆列表加载失败',
          onRetry: () => void reload(),
        }));
      } finally {
        loading = false;
        vlist.setLoading(false);
      }
    }

    async function loadMore(): Promise<void> {
      if (loading) return;
      loading = true;
      vlist.setLoading(true);
      try {
        const next: MemoryListQuery = { ...query, offset: all.length, limit: PAGE_SIZE };
        const result = await api.memories(next);
        if (disposed) return;
        all = all.concat(result.items);
        total = result.total;
        vlist.setItems(all);
        listMeta.textContent = `${fmtNumber(all.length)} / ${fmtNumber(total)} 条`;
      } catch (error) {
        toast(errorMessage(error), 'danger');
      } finally {
        loading = false;
        vlist.setLoading(false);
      }
    }

    /* -------- 详情 -------- */

    function renderEmptyDetail(): void {
      right.replaceChildren(emptyState(
        '未选择记忆',
        '在左侧列表点选一条记忆查看正文、证据与关系',
      ));
    }

    function renderDetailSkeleton(): void {
      right.replaceChildren(el('div', { class: 'detail-skeleton' },
        skeleton(2), skeleton(5), skeleton(3)));
    }

    async function selectMemory(id: string, fallbackId?: string): Promise<void> {
      selectedId = id;
      for (const node of Array.from(vlist.root.querySelectorAll<HTMLElement>('.memo-item'))) {
        node.classList.toggle('is-active', node.dataset.id === id);
      }
      renderDetailSkeleton();
      try {
        const memory = await api.memory(id);
        if (disposed || selectedId !== id) return;
        renderDetail(memory);
      } catch (error) {
        if (disposed) return;
        if (fallbackId && fallbackId !== id && error instanceof ApiError && error.status === 404) {
          toast(`记忆不存在：${id}`, 'warn');
          void selectMemory(fallbackId);
          return;
        }
        right.replaceChildren(errorState({
          error,
          title: '记忆详情加载失败',
          onRetry: () => void selectMemory(id),
        }));
      }
    }

    function renderDetail(memory: Memory): void {
      const trust = Number(memory.trust ?? 0.5);
      const evidence = memory.evidence ?? [];
      const blocks = memory.blocks ?? [];
      const edges = memory.edges ?? [];

      const head = el('div', { class: 'detail-head' },
        el('div', { class: 'detail-title-row' },
          el('h2', { class: 'detail-title' }, memory.title ?? '（无标题）'),
          statusBadge(memory.status)),
        el('div', { class: 'detail-badges' },
          badge(kindLabel(memory.kind), 'info'),
          badge(`信任 ${fmtPercent(trust)}`, trustTone(trust)),
          memory.scope_id ? badge(memory.scope_id, 'muted') : null,
          memory.agent_id ? badge(`来源 ${memory.agent_id}`, 'muted') : null,
          el('span', { class: 'mono muted-text' }, memory.id)),
        el('div', { class: 'detail-meta-row' },
          el('span', null, `入库 ${fmtDateTime(memory.recorded_at)}`),
          el('span', null, `更新 ${fmtDateTime(memory.updated_at ?? memory.recorded_at)}`),
          memory.review_count ? el('span', null, `复习 ${memory.review_count} 次`) : null,
          memory.review_due ? el('span', null, `下次复习 ${fmtDateTime(memory.review_due)}`) : null));

      // 状态机（store.STATUS_TRANSITIONS）：只有 draft / candidate 能批准或拒绝，rejected 能重新进候选
      const status = String(memory.status ?? '');
      const reviewable = status === 'draft' || status === 'candidate';
      const actions = el('div', { class: 'detail-actions' });
      const approveBtn = button('批准', {
        kind: 'primary',
        iconName: 'check',
        disabled: !reviewable,
        title: reviewable ? undefined : `当前状态 ${STATUS_LABELS[status] ?? status}，不能批准`,
      });
      approveBtn.addEventListener('click', async () => {
        const done = busy(approveBtn);
        try {
          const updated = await api.approveMemory(memory.id);
          toast('已批准', 'ok');
          renderDetail({ ...memory, ...updated, status: updated?.status ?? 'approved' });
          void reloadListOnly();
        } catch (error) {
          toast(errorMessage(error), 'danger');
        } finally {
          done();
        }
      });
      const rejectBtn = button('拒绝', {
        kind: 'danger',
        disabled: !reviewable,
        title: reviewable ? undefined : `当前状态 ${STATUS_LABELS[status] ?? status}，不能拒绝`,
      });
      rejectBtn.addEventListener('click', async () => {
        const done = busy(rejectBtn);
        try {
          const updated = await api.rejectMemory(memory.id);
          toast('已拒绝', 'ok');
          renderDetail({ ...memory, ...updated, status: updated?.status ?? 'rejected' });
          void reloadListOnly();
        } catch (error) {
          toast(errorMessage(error), 'danger');
        } finally {
          done();
        }
      });
      const relateBtn = button('关系图', {
        iconName: 'graph',
        onClick: () => ctx.navigate('graph', { focus: memory.id }),
      });
      const copyIdBtn = button('复制 ID', {
        kind: 'subtle',
        iconName: 'copy',
        onClick: async () => {
          try {
            await navigator.clipboard.writeText(memory.id);
            toast('已复制记忆 ID', 'ok');
          } catch {
            toast(memory.id, 'info');
          }
        },
      });
      actions.append(approveBtn, rejectBtn, relateBtn, copyIdBtn);

      const bodyCard = card({ title: '正文', className: 'detail-body-card' });
      const bodyBox = el('div', { class: 'markdown-body' });
      renderMarkdownInto(bodyBox, memory.body ?? memory.summary ?? '', { math: true, codeMaxLines: 24 });
      if (!(memory.body ?? memory.summary ?? '').trim()) {
        bodyBox.appendChild(emptyState('正文为空'));
      }
      bodyCard.appendChild(bodyBox);

      const evidenceCard = card({
        title: '证据',
        subtitle: evidence.length ? `${evidence.length} 条` : '尚未登记证据',
      });
      if (evidence.length) {
        const list = el('div', { class: 'evidence-list' });
        for (const item of evidence) list.appendChild(evidenceRow(item));
        evidenceCard.appendChild(list);
      } else {
        evidenceCard.appendChild(emptyState('没有证据', '只有 agent_asserted 证据的记忆不会自动批准'));
      }

      const blocksCard = blocks.length ? card({
        title: '富块',
        subtitle: `${blocks.length} 块（代码 / 公式 / 表格）`,
      }) : null;
      if (blocksCard) {
        for (const block of blocks) blocksCard.appendChild(blockView(block));
      }

      const reviewCard = card({ title: '复习评分（SM-2）', subtitle: '0-2 需要重来，3-5 掌握程度递增' });
      const reviewRow = el('div', { class: 'review-row' });
      for (let grade = 0; grade <= 5; grade += 1) {
        const btn = el('button', {
          class: `grade-btn grade-${grade}`,
          type: 'button',
          title: `评分 ${grade}`,
          onClick: async () => {
            const done = busy(btn);
            try {
              const result = await api.reviewMemory(memory.id, grade);
              lastEase.set(memory.id, result.ease);
              toast(`已记录评分 ${grade}，下次复习 ${fmtDateTime(result.due)}`, 'ok');
              // 返回的是复习结果而不是记忆：重新取一次详情
              void selectMemory(memory.id);
            } catch (error) {
              toast(errorMessage(error), 'danger');
            } finally {
              done();
            }
          },
        }, String(grade));
        reviewRow.appendChild(btn);
      }
      reviewCard.appendChild(reviewRow);
      reviewCard.appendChild(el('div', { class: 'review-stats' },
        el('span', null, `ease=${lastEase.get(memory.id) ?? '—'}`),
        el('span', null, `interval=${memory.stability ?? '—'} 天`),
        el('span', null, `difficulty=${memory.difficulty ?? '—'}`),
        el('span', null, `due=${memory.review_due ? fmtDateTime(memory.review_due) : '—'}`)));

      const didactic = didacticCard(memory.didactic);

      const edgesCard = card({
        title: '关系',
        subtitle: edges.length ? `${edges.length} 条边` : '暂无关系',
        actions: [relateBtn],
      });
      if (edges.length) {
        const list = el('div', { class: 'edge-list' });
        for (const edge of edges) list.appendChild(edgeRow(edge, memory.id));
        edgesCard.appendChild(list);
      } else {
        edgesCard.appendChild(emptyState('还没有建立关系', '可用 memory_relate 或在工作流中生成'));
      }

      const metaCard = card({ title: '原始数据' });
      metaCard.appendChild(jsonBlock(memory, '查看完整 JSON'));

      const inner = el('div', { class: 'detail-inner' },
        head, actions, bodyCard, didactic,
        el('div', { class: 'grid grid-2 align-start' }, evidenceCard, el('div', { class: 'stack' }, blocksCard, reviewCard)),
        edgesCard, metaCard);

      right.replaceChildren(inner);
    }

    function evidenceRow(item: Evidence): HTMLElement {
      const trust = Number(item.trust ?? 0.5);
      return el('div', { class: 'evidence-row' },
        el('div', { class: 'evidence-head' },
          badge(String(item.kind ?? 'unknown'), 'info'),
          badge(`信任 ${fmtPercent(trust)}`, trustTone(trust)),
          item.verified ? badge(`已核验${item.verifier ? ` · ${item.verifier}` : ''}`, 'ok') : null,
          item.document_id ? el('span', { class: 'mono muted-text' }, item.document_id) : null,
          el('span', { class: 'muted-text', style: { marginLeft: 'auto' } }, fmtRelative(item.created_at))),
        item.quote ? el('blockquote', { class: 'evidence-quote' }, item.quote) : null,
        item.uri ? el('div', { class: 'evidence-uri mono' }, item.uri) : null,
        item.note ? el('div', { class: 'muted-text' }, item.note) : null);
    }

    /** 学习型记忆的六层讲解（definition / formula / property / example …）。 */
    function didacticCard(didactic: Didactic | null | undefined): HTMLElement | null {
      if (!didactic || typeof didactic !== 'object') return null;
      const labels: Record<string, string> = { definition: '定义', formula: '公式', property: '性质', example: '例子' };
      const keys = Object.keys(didactic).filter((key) => typeof didactic[key] === 'string' && String(didactic[key]).trim());
      if (!keys.length) return null;
      const box = card({ title: '讲解', subtitle: keys.map((key) => labels[key] ?? key).join(' · ') });
      for (const key of keys) {
        const value = String(didactic[key]);
        const row = el('div', { class: 'didactic-row', dataset: { part: key } },
          el('div', { class: 'didactic-label muted-text' }, labels[key] ?? key));
        if (key === 'formula') row.appendChild(mathBlock(value));
        else {
          const target = el('div', { class: 'markdown-body' });
          renderMarkdownInto(target, value, { math: true });
          row.appendChild(target);
        }
        box.appendChild(row);
      }
      return box;
    }

    /** store.block 行：类型字段是 type，另有 caption。 */
    function blockView(block: MemBlock): HTMLElement {
      const content = block.content ?? '';
      const kind = String(block.type ?? 'text');
      const box = el('div', { class: 'block-view' });
      box.appendChild(el('div', { class: 'block-head' },
        badge(kind, kind === 'formula' ? 'accent' : 'muted'),
        block.lang ? badge(block.lang, 'muted') : null,
        block.caption ? el('span', { class: 'muted-text' }, block.caption) : null));
      if (kind === 'formula' || kind === 'math') {
        box.appendChild(mathBlock(content));
      } else if (kind === 'code') {
        const pre = el('pre', { class: 'md-pre' }, el('code', null, content));
        box.appendChild(el('div', { class: 'md-codeblock is-scroll' }, pre));
      } else if (kind === 'markdown' || kind === 'md') {
        const target = el('div', { class: 'markdown-body' });
        renderMarkdownInto(target, content, { math: true });
        box.appendChild(target);
      } else {
        const target = el('div', { class: 'markdown-body' });
        renderMarkdownInto(target, content, { math: true });
        box.appendChild(target);
      }
      return box;
    }

    function edgeRow(edge: MemoryEdge, selfId: string): HTMLElement {
      const other = edge.src === selfId ? edge.dst : edge.src;
      const otherId = String(other ?? '');
      return el('div', { class: 'edge-row' },
        badge(String(edge.rel ?? 'related'), 'accent'),
        el('span', { class: 'mono' }, otherId),
        el('span', { class: 'muted-text' }, `权重 ${edge.weight ?? '—'} · 置信 ${edge.confidence ?? '—'}`),
        el('button', {
          class: 'link-btn',
          type: 'button',
          onClick: () => ctx.navigate('memories', { id: otherId }),
        }, '打开'));
    }

    async function reloadListOnly(): Promise<void> {
      try {
        const result = await api.memories({ ...query, offset: 0 });
        if (disposed) return;
        all = result.items;
        total = result.total;
        vlist.setItems(all);
        listMeta.textContent = `${fmtNumber(all.length)} / ${fmtNumber(total)} 条`;
      } catch {
        /* 列表刷新失败不打断详情 */
      }
    }

    /* -------- 启动与订阅 -------- */

    renderEmptyDetail();
    void reload();

    const unsub = ctx.onEvent(['memory', 'run'], () => {
      void reloadListOnly();
    });

    ctx.mount.addEventListener('mem:dispose', () => {
      disposed = true;
      debouncedReload.cancel();
      unsub();
    }, { once: true });
  },
};

/** 供 main.ts 的全局搜索直接跳转用。 */
export function focusMemoryFromSearch(ctx: PageContext, id: string): void {
  ctx.navigate('memories', { id });
}

export { icon };
