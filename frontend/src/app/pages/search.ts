/**
 * 检索：查询框、策略（hybrid/bm25/vector/graph）、作用域、预算滑块、
 * 结果卡片（命中通道徽章 / 分数 / 来源引用）、降级警告条。
 */

import { el } from '../dom';
import { api, isConnectionIssue } from '../api';
import type { SearchHit, SearchResult } from '../types';
import { renderMarkdownInto } from '../markdown';
import {
  badge, button, busy, degradedBanner, emptyState, errorState, fmtNumber,
  select, skeleton, textInput, toast,
} from './ui';
import type { PageModule } from './contract';

const STRATEGIES = [
  { value: 'hybrid', label: 'hybrid · 混合（BM25 + 向量 + 图 + RRF）' },
  { value: 'bm25', label: 'bm25 · 全文检索（FTS5）' },
  { value: 'vector', label: 'vector · 向量近邻' },
  { value: 'graph', label: 'graph · 图扩展' },
];

const CHANNEL_META: Record<string, { label: string; tone: 'ok' | 'info' | 'accent' | 'warn' | 'muted' }> = {
  bm25: { label: 'bm25', tone: 'info' },
  vector: { label: 'vector', tone: 'accent' },
  graph: { label: 'graph', tone: 'ok' },
  substring: { label: 'substring', tone: 'muted' },
  rerank: { label: 'rerank', tone: 'warn' },
};

function normalizeDegraded(raw: SearchResult): string[] {
  const out: string[] = [];
  const push = (value: unknown): void => {
    if (!value) return;
    if (typeof value === 'string') {
      out.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string') out.push(item);
        else if (item && typeof item === 'object') {
          const record = item as Record<string, unknown>;
          const role = record.role ?? record.capability ?? record.name ?? record.reason;
          if (role) out.push(String(role));
        }
      }
      return;
    }
    if (typeof value === 'object') {
      const record = value as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        if (record[key]) out.push(key);
      }
    }
  };
  push(raw.degraded);
  return out;
}

function scoreBar(hit: SearchHit): HTMLElement {
  const score = Math.max(0, Math.min(1, Number(hit.score ?? 0)));
  return el('span', { class: 'score-bar', title: `归一化分数 ${score.toFixed(3)}` },
    el('span', { class: 'score-fill', style: { width: `${Math.round(score * 100)}%` } }));
}

function hitCard(hit: SearchHit, onOpen: (id: string) => void): HTMLElement {
  const channels = hit.channels ?? {};
  const channelNodes: HTMLElement[] = [];
  for (const key of Object.keys(channels)) {
    const value = channels[key];
    if (!value) continue;
    const meta = CHANNEL_META[key] ?? { label: key, tone: 'muted' as const };
    channelNodes.push(badge(`${meta.label} ${Number(value).toFixed(2)}`, meta.tone));
  }

  const node = el('article', { class: 'hit-card' });
  node.appendChild(el('div', { class: 'hit-head' },
    el('button', {
      class: 'hit-title',
      type: 'button',
      onClick: () => onOpen(hit.id),
    }, hit.title ?? hit.id),
    el('div', { class: 'hit-badges' }, ...channelNodes)));
  node.appendChild(el('div', { class: 'hit-score' },
    scoreBar(hit),
    el('span', { class: 'mono' }, Number(hit.score ?? 0).toFixed(3)),
    hit.trust !== undefined ? el('span', { class: 'muted-text' }, `信任 ${Number(hit.trust).toFixed(2)}`) : null));

  if (hit.snippet) {
    const snippet = el('div', { class: 'hit-snippet' });
    renderMarkdownInto(snippet, hit.snippet, { math: true, codeMaxLines: 6 });
    node.appendChild(snippet);
  }

  node.appendChild(el('div', { class: 'hit-foot' },
    hit.kind ? badge(hit.kind, 'muted') : null,
    hit.scope_id ? el('span', { class: 'mono muted-text' }, hit.scope_id) : null,
    hit.citation ? el('span', { class: 'citation' }, `↳ ${hit.citation}`) : null,
    el('button', {
      class: 'link-btn',
      type: 'button',
      onClick: () => onOpen(hit.id),
    }, '打开记忆')));
  return node;
}

export const searchPage: PageModule = {
  id: 'search',
  title: '检索',
  icon: 'search',
  group: 'main',
  shortcut: 'g s',
  render(ctx) {
    let disposed = false;
    let lastQuery = '';

    const page = el('div', { class: 'page page-search' });
    ctx.mount.appendChild(page);

    const input = textInput({
      value: ctx.params.get('q') ?? '',
      placeholder: '输入自然语言问题或关键词，回车检索…',
      className: 'input-search input-lg',
      onEnter: () => void run(),
    });

    const strategySelect = select({
      items: STRATEGIES,
      value: ctx.params.get('strategy') ?? 'hybrid',
      onChange: () => void run(),
    });

    const scopeInput = textInput({
      value: ctx.params.get('scope') ?? '',
      placeholder: '作用域（可留空 = global + 继承）',
    });

    const budgetValue = el('span', { class: 'mono' }, '1200');
    const budgetSlider = el('input', {
      type: 'range',
      min: '200',
      max: '4000',
      step: '100',
      value: '1200',
      class: 'range',
      onInput: () => {
        budgetValue.textContent = budgetSlider.value;
      },
    });

    const limitSelect = select({
      items: [
        { value: '10', label: '10 条' },
        { value: '20', label: '20 条' },
        { value: '50', label: '50 条' },
      ],
      value: '20',
    });

    const submitBtn = button('检索', { kind: 'primary', iconName: 'search', onClick: () => void run() });

    page.appendChild(el('div', { class: 'search-head' },
      el('div', { class: 'search-box' }, input, submitBtn),
      el('div', { class: 'search-options' },
        el('label', { class: 'inline-field' }, el('span', null, '策略'), strategySelect),
        el('label', { class: 'inline-field' }, el('span', null, '作用域'), scopeInput),
        el('label', { class: 'inline-field' }, el('span', null, '结果数'), limitSelect),
        el('label', { class: 'inline-field inline-field-range' },
          el('span', null, '上下文预算'),
          budgetSlider,
          budgetValue,
          el('span', { class: 'muted-text' }, 'tokens')))));

    const resultHost = el('div', { class: 'search-results' });
    page.appendChild(resultHost);

    const summary = el('div', { class: 'search-summary' });
    page.appendChild(summary);

    const renderIdle = (): void => {
      resultHost.replaceChildren(emptyState(
        '开始检索',
        '混合策略会同时走 BM25、向量与图扩展，并用 RRF 融合；降级时会自动回落到确定性算法。',
        el('div', { class: 'idle-hints' },
          ...['记忆中枢作用域', '工作流 模板', 'SM-2 复习'].map((hint) =>
            el('button', {
              class: 'chip-btn',
              type: 'button',
              onClick: () => {
                input.value = hint;
                void run();
              },
            }, hint))),
      ));
    };

    const renderResults = (result: SearchResult): void => {
      const hits = result.hits ?? [];
      const degraded = normalizeDegraded(result);
      const blocks: Node[] = [];
      if (degraded.length) blocks.push(degradedBanner(degraded));

      summary.replaceChildren(
        el('span', null, `策略 ${result.strategy ?? strategySelect.value}`),
        el('span', null, `命中 ${fmtNumber(hits.length)}${result.total !== undefined ? ` / ${fmtNumber(result.total)}` : ''}`),
        el('span', null, `耗时 ${fmtNumber(result.took_ms ?? 0)} ms`),
      );

      if (!hits.length) {
        blocks.push(emptyState('没有命中结果', '试试更换策略、放宽作用域，或确认记忆已批准'));
        resultHost.replaceChildren(...blocks);
        return;
      }
      for (const hit of hits) {
        blocks.push(hitCard(hit, (id) => ctx.navigate('memories', { id })));
      }
      resultHost.replaceChildren(...blocks);
    };

    async function run(): Promise<void> {
      const q = input.value.trim();
      if (!q) {
        toast('请输入检索词', 'warn');
        input.focus();
        return;
      }
      lastQuery = q;
      resultHost.replaceChildren(el('div', { class: 'grid grid-2' }, skeleton(3), skeleton(3)));
      summary.replaceChildren();
      const done = busy(submitBtn);
      try {
        const result = await api.search({
          q,
          strategy: strategySelect.value,
          scope: scopeInput.value.trim() || undefined,
          limit: Number(limitSelect.value),
          budget: Number(budgetSlider.value),
        });
        if (disposed) return;
        renderResults(result);
      } catch (error) {
        if (disposed) return;
        resultHost.replaceChildren(errorState({
          error,
          title: isConnectionIssue(error) ? '无法连接后端' : '检索失败',
          onRetry: () => void run(),
        }));
      } finally {
        done();
      }
    }

    renderIdle();
    if (input.value.trim()) void run();

    const unsub = ctx.onEvent(['memory'], () => {
      if (lastQuery && !disposed) void run();
    });

    ctx.mount.addEventListener('mem:dispose', () => {
      disposed = true;
      unsub();
    }, { once: true });
  },
};
