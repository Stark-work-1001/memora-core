/**
 * 检索：查询框、策略、作用域、预算滑块、结果卡片（命中通道徽章 / 分数 / 来源引用）、降级说明条。
 *
 * 只显示后端说实际跑了什么（1.1.0 响应字段 channels_used / vector_model / semantic /
 * reranked / score_kind）：没有 embedding 模型时 hybrid 不含向量通道；显式选 vector 时
 * 用的是本地词形草图（local-hash-256），徽章和说明条都如实标出，不叫"语义"。
 */

import { el, icon } from '../dom';
import { api, isConnectionIssue } from '../api';
import type { SearchHit, SearchResult } from '../types';
import { renderMarkdownInto } from '../markdown';
import {
  badge, button, busy, emptyState, errorState, fmtNumber,
  select, skeleton, textInput, toast,
} from './ui';
import type { PageModule } from './contract';

/** 1.1.0 起 /api/search 附带的字段（只增不改；旧后端没有时按 undefined 处理）。 */
type SearchReport = SearchResult & {
  channels_used?: string[];
  vector_model?: string | null;
  semantic?: boolean;
  reranked?: boolean;
  score_kind?: string;
};

const LOCAL_SKETCH = 'local-hash-256';

const STRATEGIES = [
  { value: 'hybrid', label: 'hybrid · 混合（BM25 + 子串 + 图；有 embedding 模型时加向量）' },
  { value: 'bm25', label: 'bm25 · 关键词（中文二元组切分 BM25）' },
  { value: 'substring', label: 'substring · 字面子串' },
  { value: 'vector', label: 'vector · 向量（无 embedding 模型时为本地词形草图）' },
  { value: 'graph', label: 'graph · 图扩展（实体 PageRank）' },
];

const CHANNEL_META: Record<string, { label: string; tone: 'ok' | 'info' | 'accent' | 'warn' | 'muted'; title: string }> = {
  bm25: { label: 'bm25', tone: 'info', title: 'BM25 关键词分（中文二元组切分）' },
  vector: { label: 'vector', tone: 'accent', title: 'embedding 模型的余弦相似度' },
  graph: { label: 'graph', tone: 'ok', title: '实体图个性化 PageRank 分' },
  substring: { label: 'substring', tone: 'muted', title: '字面子串命中分' },
  rerank: { label: 'rerank', tone: 'warn', title: '重排模型分' },
};

/** 向量徽章按实际来源标注：本地草图不是语义向量。 */
function channelMeta(key: string, report: SearchReport): { label: string; tone: 'ok' | 'info' | 'accent' | 'warn' | 'muted'; title: string } {
  if (key === 'vector' && report.vector_model === LOCAL_SKETCH) {
    return { label: 'hash 草图', tone: 'muted', title: '本地字符 n-gram 特征哈希（local-hash-256），只反映字面重叠，不是语义向量' };
  }
  if (key === 'vector' && report.vector_model) {
    return { label: 'vector', tone: 'accent', title: `embedding 模型 ${report.vector_model} 的余弦相似度` };
  }
  return CHANNEL_META[key] ?? { label: key, tone: 'muted', title: key };
}

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

/** 分数说明：RRF 原始和（约 0.01~0.05）只用于排序；条长画的是"相对本次最高分"。 */
function scoreTitle(score: number, report: SearchReport): string {
  if (report.score_kind === 'rrf+rerank') {
    return `融合 + 重排后的相对分 ${score.toFixed(3)}（0~1，相对本次结果）`;
  }
  return `RRF 融合分 ${score.toFixed(4)}：各通道名次的倒数加权和，只用于排序，不是 0~1 的相似度`;
}

function scoreBar(hit: SearchHit, top: number, report: SearchReport): HTMLElement {
  const score = Math.max(0, Number(hit.score ?? 0));
  const share = top > 0 ? Math.min(1, score / top) : 0;
  return el('span', { class: 'score-bar', title: `${scoreTitle(score, report)}；条长 = 相对本次最高分 ${Math.round(share * 100)}%` },
    el('span', { class: 'score-fill', style: { width: `${Math.round(share * 100)}%` } }));
}

function hitCard(hit: SearchHit, onOpen: (id: string) => void, top: number, report: SearchReport): HTMLElement {
  const channels = hit.channels ?? {};
  const channelNodes: HTMLElement[] = [];
  for (const key of Object.keys(channels)) {
    const value = channels[key];
    if (!value) continue;
    const meta = channelMeta(key, report);
    channelNodes.push(badge(`${meta.label} ${Number(value).toFixed(2)}`, meta.tone, meta.title));
  }

  const node = el('article', { class: 'hit-card' });
  node.appendChild(el('div', { class: 'hit-head' },
    el('button', {
      class: 'hit-title',
      type: 'button',
      onClick: () => onOpen(hit.id),
    }, hit.title ?? hit.id),
    el('div', { class: 'hit-badges' }, ...channelNodes)));
  const score = Number(hit.score ?? 0);
  node.appendChild(el('div', { class: 'hit-score' },
    scoreBar(hit, top, report),
    el('span', { class: 'mono', title: scoreTitle(score, report) },
      report.score_kind === 'rrf+rerank' ? score.toFixed(3) : `RRF ${score.toFixed(4)}`),
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

/** 说明条：标题说清楚发生了什么，下面逐条列出后端的 degraded 原因（原文）。 */
function searchNotice(report: SearchReport, reasons: string[]): HTMLElement | null {
  if (!reasons.length) return null;
  const vectorReason = reasons.find((r) => r.startsWith('vector'));
  let title = '部分能力未生效';
  if (report.vector_model === LOCAL_SKETCH) {
    title = '向量通道用的是本地词形草图（字符 n-gram 哈希），不是语义向量';
  } else if (vectorReason && !report.semantic) {
    title = '本次没有语义向量：结果只来自关键词通道（BM25 / 子串 / 图）';
  } else if (reasons.some((r) => r.startsWith('rerank'))) {
    title = '未经重排模型：保持 RRF 融合顺序';
  }
  return el('div', { class: 'degraded-banner', role: 'status' },
    icon('alert', 16),
    el('div', { class: 'degraded-body' },
      el('strong', null, title),
      ...Array.from(new Set(reasons)).map((reason) => el('span', { class: 'degraded-detail' }, reason))));
}

function channelSummary(report: SearchReport): string | null {
  if (!report.channels_used) return null;
  const used = report.channels_used.length ? report.channels_used.join(' + ') : '无';
  let vector = '向量：无';
  if (report.vector_model === LOCAL_SKETCH) vector = '向量：本地词形草图（非语义）';
  else if (report.vector_model) vector = `向量：${report.vector_model}`;
  return `通道 ${used} · ${vector}${report.reranked ? ' · 已重排' : ''}`;
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
        '混合策略同时走 BM25、字面子串与图扩展，配置了 embedding 模型时再加向量，用 RRF 融合；结果卡片会标出每条命中来自哪些通道。',
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
      const report = result as SearchReport;
      const hits = result.hits ?? [];
      const degraded = normalizeDegraded(result);
      const blocks: Node[] = [];
      const notice = searchNotice(report, degraded);
      if (notice) blocks.push(notice);

      const channelsText = channelSummary(report);
      const parts: HTMLElement[] = [
        el('span', null, `策略 ${result.strategy ?? strategySelect.value}`),
        el('span', null, `命中 ${fmtNumber(hits.length)}${result.total !== undefined ? ` / ${fmtNumber(result.total)}` : ''}`),
        el('span', null, `耗时 ${fmtNumber(result.took_ms ?? 0)} ms`),
      ];
      if (channelsText) parts.push(el('span', null, channelsText));
      summary.replaceChildren(...parts);

      if (!hits.length) {
        blocks.push(emptyState('没有命中结果', '试试更换策略、放宽作用域，或确认记忆已批准'));
        resultHost.replaceChildren(...blocks);
        return;
      }
      const top = hits.reduce((best, hit) => Math.max(best, Number(hit.score ?? 0)), 0);
      for (const hit of hits) {
        blocks.push(hitCard(hit, (id) => ctx.navigate('memories', { id }), top, report));
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
