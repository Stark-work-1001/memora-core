/**
 * 算法目录：34 个记忆算法卡片（名称 / 分类 / 简介 / 公式 KaTeX / 出处 / 离线可用 / 是否启用），
 * 支持按分类筛选与搜索；明确标注「未在本机启用（算力不足）」的项。
 */

import { el } from '../dom';
import { api } from '../api';
import type { Algorithm } from '../types';
import { ALGO_CATEGORY_LABELS } from '../types';
import { mathBlock } from '../markdown';
import {
  badge, button, emptyState, errorState, fmtNumber, skeleton, textInput,
} from './ui';
import type { PageModule } from './contract';

/** 已知需要较大算力、本机默认不启用的算法（后端也会用 runnable=0 标注）。 */
const KNOWN_HEAVY = new Set(['umap', 'hnsw', 'ivf-pq', 'raptor', 'contextual-prefix']);

function isRunnable(algo: Algorithm): boolean {
  if (algo.runnable !== undefined) return Boolean(algo.runnable);
  return !KNOWN_HEAVY.has(algo.id);
}

function isEnabled(algo: Algorithm): boolean {
  if (algo.enabled !== undefined) return Boolean(algo.enabled);
  if (algo.engaged !== undefined) return Boolean(algo.engaged);
  return isRunnable(algo);
}

function isOffline(algo: Algorithm): boolean {
  return algo.offline === undefined ? true : Boolean(algo.offline);
}

function categoryLabel(category: unknown): string {
  const key = String(category ?? 'other');
  return ALGO_CATEGORY_LABELS[key] ?? key;
}

function algoCard(algo: Algorithm): HTMLElement {
  const runnable = isRunnable(algo);
  const enabled = isEnabled(algo) && runnable;
  const node = el('article', { class: `algo-card ${runnable ? '' : 'is-disabled'}`.trim() });

  node.appendChild(el('div', { class: 'algo-head' },
    el('div', null,
      el('h3', { class: 'algo-name' }, algo.name ?? algo.id),
      el('div', { class: 'mono muted-text algo-id' }, algo.id)),
    el('div', { class: 'algo-badges' },
      badge(categoryLabel(algo.category), 'info'),
      enabled ? badge('已启用', 'ok') : badge('未启用', 'muted'),
      isOffline(algo) ? badge('离线可用', 'accent') : badge('需联网', 'warn'))));

  node.appendChild(el('p', { class: 'algo-summary' }, algo.summary ?? '无简介'));

  if (algo.formula) {
    const formula = el('div', { class: 'algo-formula' }, mathBlock(algo.formula));
    node.appendChild(formula);
  }

  if (!runnable) {
    node.appendChild(el('div', { class: 'algo-warning' },
      '未在本机启用（算力不足）。该算法依赖的库未随包分发，界面会如实标注，不会伪造为可用。'));
  }

  node.appendChild(el('div', { class: 'algo-foot' },
    algo.reference ? el('span', { class: 'algo-ref' }, `出处：${algo.reference}`) : el('span', { class: 'muted-text' }, '无出处'),
    algo.note ? el('span', { class: 'muted-text', title: algo.note }, algo.note) : null));

  return node;
}

export const algorithmsPage: PageModule = {
  id: 'algorithms',
  title: '算法目录',
  icon: 'algorithms',
  group: 'main',
  shortcut: 'g k',
  render(ctx) {
    let disposed = false;
    let algorithms: Algorithm[] = [];
    let category = '';
    let search = '';

    const page = el('div', { class: 'page page-algorithms' });
    ctx.mount.appendChild(page);

    const counter = el('span', { class: 'muted-text' }, '');
    const filterRow = el('div', { class: 'chip-row' });
    const searchInput = textInput({
      placeholder: '搜索算法名称、id、简介…',
      onInput: (value) => {
        search = value.trim().toLowerCase();
        render();
      },
    });
    const grid = el('div', { class: 'algo-grid' });

    page.append(
      el('div', { class: 'page-head' },
        el('div', { class: 'page-head-left' },
          el('h1', { class: 'page-title' }, '记忆算法目录'),
          el('div', { class: 'page-head-meta' },
            el('span', { class: 'muted-text' }, '34 个算法：检索 / 向量 / 融合 / 判重 / 遗忘 / 布局 …'),
            counter)),
        el('div', { class: 'page-head-actions' }, searchInput,
          button('刷新', { iconName: 'refresh', kind: 'subtle', onClick: () => void load() }))),
      filterRow,
      grid,
    );

    function renderFilters(): void {
      const categories = Array.from(new Set(algorithms.map((a) => String(a.category ?? 'other'))));
      filterRow.replaceChildren(
        el('button', {
          class: `chip-btn ${category === '' ? 'is-active' : ''}`.trim(),
          type: 'button',
          onClick: () => { category = ''; renderFilters(); render(); },
        }, `全部 ${algorithms.length}`),
        ...categories.map((key) => {
          const count = algorithms.filter((a) => a.category === key).length;
          return el('button', {
            class: `chip-btn ${category === key ? 'is-active' : ''}`.trim(),
            type: 'button',
            onClick: () => { category = key; renderFilters(); render(); },
          }, `${categoryLabel(key)} ${count}`);
        }));
    }

    function render(): void {
      const visible = algorithms.filter((algo) => {
        if (category && algo.category !== category) return false;
        if (!search) return true;
        const haystack = `${algo.id} ${algo.name ?? ''} ${algo.summary ?? ''} ${algo.category ?? ''}`.toLowerCase();
        return haystack.includes(search);
      });
      const enabled = visible.filter((a) => isEnabled(a) && isRunnable(a)).length;
      const heavy = visible.filter((a) => !isRunnable(a)).length;
      counter.textContent = `${fmtNumber(visible.length)} 个 · 启用 ${enabled} · 算力受限 ${heavy}`;

      if (!visible.length) {
        grid.replaceChildren(emptyState(
          algorithms.length ? '没有匹配的算法' : '算法目录加载失败',
          algorithms.length ? '换个分类或关键词' : '请检查后端 /api/algorithms',
        ));
        return;
      }
      const frag = document.createDocumentFragment();
      for (const algo of visible) frag.appendChild(algoCard(algo));
      grid.replaceChildren(frag);
    }

    async function load(): Promise<void> {
      grid.replaceChildren(skeleton(3), skeleton(3), skeleton(3));
      try {
        const list = await api.algorithms();
        if (disposed) return;
        algorithms = list;
        renderFilters();
        render();
      } catch (error) {
        if (disposed) return;
        grid.replaceChildren(errorState({ error, title: '算法目录加载失败', onRetry: () => void load() }));
      }
    }

    void load();

    ctx.mount.addEventListener('mem:dispose', () => {
      disposed = true;
    }, { once: true });
  },
};
