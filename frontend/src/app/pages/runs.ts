/**
 * 运行记录：运行列表 + 步骤时间线（状态 / 耗时 / 模型 / 降级标记 / 输入输出摘要）。
 */

import { el } from '../dom';
import { api } from '../api';
import type { RunDetail, RunStep, RunSummary } from '../types';
import {
  badge, button, card, emptyState, errorState, fmtDateTime, fmtDuration, fmtNumber,
  fmtRelative, jsonBlock, skeleton, statusBadge, toast,
} from './ui';
import type { PageModule } from './contract';

function runCard(run: RunSummary, active: boolean, onOpen: () => void): HTMLElement {
  return el('button', {
    class: `run-item ${active ? 'is-active' : ''}`.trim(),
    type: 'button',
    onClick: onOpen,
  },
    el('div', { class: 'run-item-head' },
      el('span', { class: 'run-item-title' }, run.template_name ?? run.name ?? run.template_id ?? run.id),
      statusBadge(run.status)),
    el('div', { class: 'run-item-sub' },
      el('span', { class: 'mono muted-text' }, run.id.slice(0, 12)),
      el('span', { class: 'muted-text' }, fmtRelative(run.started_at ?? run.created_at)),
      el('span', { class: 'muted-text' }, fmtDuration(run.duration_ms))),
    el('div', { class: 'run-item-foot' },
      run.steps !== undefined ? badge(`${run.steps} 步`, 'muted') : null,
      run.degraded ? badge('含降级', 'warn') : null,
      run.scope ?? run.scope_id ? el('span', { class: 'mono muted-text' }, String(run.scope ?? run.scope_id)) : null));
}

function stepNode(step: RunStep, index: number): HTMLElement {
  const degraded = Boolean(step.degraded);
  const status = String(step.status ?? 'unknown').toLowerCase();
  return el('div', { class: `timeline-step ${degraded ? 'is-degraded' : ''}`.trim() },
    el('div', { class: 'timeline-rail' },
      el('span', { class: `timeline-dot status-${status}` }),
      el('span', { class: 'timeline-line' })),
    el('div', { class: 'timeline-body' },
      el('div', { class: 'timeline-head' },
        el('span', { class: 'timeline-index mono' }, String(index + 1).padStart(2, '0')),
        el('span', { class: 'timeline-name' }, step.name ?? step.node_id ?? '未命名步骤'),
        statusBadge(step.status),
        degraded ? badge('降级执行', 'warn') : null),
      el('div', { class: 'timeline-meta' },
        step.kind ? badge(String(step.kind), 'muted') : null,
        step.role ? el('span', { class: 'muted-text' }, `role: ${step.role}`) : null,
        step.model ? el('span', { class: 'mono muted-text' }, step.model) : null,
        el('span', { class: 'mono muted-text' }, fmtDuration(step.duration_ms)),
        step.fallback ? badge(`回退 ${step.fallback}`, 'warn') : null),
      step.summary ? el('div', { class: 'timeline-summary' }, step.summary) : null,
      step.error ? el('div', { class: 'timeline-error' }, step.error) : null,
      step.input !== undefined || step.output !== undefined
        ? el('details', { class: 'json-details' },
          el('summary', null, '输入 / 输出摘要'),
          jsonBlock({ input: step.input, output: step.output }))
        : null));
}

export const runsPage: PageModule = {
  id: 'runs',
  title: '运行记录',
  icon: 'runs',
  group: 'main',
  shortcut: 'g r',
  render(ctx) {
    let disposed = false;
    let runs: RunSummary[] = [];
    let selectedId: string | null = ctx.params.get('id');
    let statusFilter = '';

    const page = el('div', { class: 'page page-runs' });
    const split = el('div', { class: 'split' });
    const left = el('div', { class: 'split-left' });
    const right = el('div', { class: 'split-right' });
    split.append(left, right);
    page.appendChild(split);
    ctx.mount.appendChild(page);

    const listHost = el('div', { class: 'run-list' });
    const meta = el('span', { class: 'list-meta' }, '—');
    const filterRow = el('div', { class: 'chip-row' });
    for (const [value, label] of [['', '全部'], ['completed', '完成'], ['partial', '部分'], ['failed', '失败'], ['running', '运行中']]) {
      filterRow.appendChild(el('button', {
        class: `chip-btn ${statusFilter === value ? 'is-active' : ''}`.trim(),
        type: 'button',
        onClick: (ev: MouseEvent) => {
          statusFilter = value;
          for (const node of Array.from(filterRow.children)) node.classList.remove('is-active');
          (ev.currentTarget as HTMLElement).classList.add('is-active');
          void load();
        },
      }, label));
    }

    left.appendChild(el('div', { class: 'list-toolbar' },
      filterRow,
      el('div', { class: 'list-status' }, meta,
        button('刷新', { iconName: 'refresh', kind: 'subtle', onClick: () => void load() }))));
    left.appendChild(listHost);

    function renderList(): void {
      if (!runs.length) {
        listHost.replaceChildren(emptyState('暂无运行记录', '到「工作流」页运行一个模板'));
        meta.textContent = '0 条';
        return;
      }
      meta.textContent = `${fmtNumber(runs.length)} 条`;
      const frag = document.createDocumentFragment();
      for (const run of runs) {
        frag.appendChild(runCard(run, run.id === selectedId, () => void select(run.id)));
      }
      listHost.replaceChildren(frag);
    }

    async function load(): Promise<void> {
      listHost.replaceChildren(skeleton(5));
      try {
        const result = await api.runs({ limit: 100, status: statusFilter || undefined });
        if (disposed) return;
        runs = result.items;
        renderList();
        if (!runs.length) {
          right.replaceChildren(emptyState('暂无运行记录'));
          return;
        }
        const target = selectedId && runs.some((r) => r.id === selectedId) ? selectedId : runs[0].id;
        void select(target);
      } catch (error) {
        if (disposed) return;
        listHost.replaceChildren();
        right.replaceChildren(errorState({ error, title: '运行记录加载失败', onRetry: () => void load() }));
      }
    }

    async function select(id: string): Promise<void> {
      selectedId = id;
      for (const node of Array.from(listHost.querySelectorAll<HTMLElement>('.run-item'))) {
        node.classList.toggle('is-active', node.dataset.id === id);
      }
      renderList();
      right.replaceChildren(el('div', { class: 'detail-skeleton' }, skeleton(2), skeleton(6)));
      try {
        const detail = await api.run(id);
        if (disposed || selectedId !== id) return;
        renderDetail(detail);
      } catch (error) {
        if (disposed) return;
        right.replaceChildren(errorState({ error, title: '运行详情加载失败', onRetry: () => void select(id) }));
      }
    }

    function renderDetail(detail: RunDetail): void {
      const steps: RunStep[] = detail.step_list ?? (detail as { steps_list?: RunStep[] }).steps_list ?? [];
      const head = el('div', { class: 'detail-head' },
        el('div', { class: 'detail-title-row' },
          el('h2', { class: 'detail-title' }, detail.template_name ?? detail.name ?? detail.template_id ?? detail.id),
          statusBadge(detail.status)),
        el('div', { class: 'detail-badges' },
          badge(fmtDuration(detail.duration_ms), 'muted'),
          badge(String(detail.trigger ?? 'manual'), 'info'),
          detail.scope ?? detail.scope_id ? badge(String(detail.scope ?? detail.scope_id), 'muted') : null,
          detail.degraded ? badge('含降级步骤', 'warn') : null),
        el('div', { class: 'detail-meta-row' },
          el('span', null, `开始 ${fmtDateTime(detail.started_at ?? detail.created_at)}`),
          el('span', null, `结束 ${fmtDateTime(detail.finished_at)}`),
          el('span', { class: 'mono' }, detail.id)));

      const actions = el('div', { class: 'detail-actions' },
        button('重新运行', {
          iconName: 'play',
          onClick: () => ctx.navigate('workflows', { id: String(detail.template_id ?? '') }),
        }),
        button('复制运行 ID', {
          kind: 'subtle',
          iconName: 'copy',
          onClick: async () => {
            try {
              await navigator.clipboard.writeText(detail.id);
              toast('已复制', 'ok');
            } catch {
              toast(detail.id, 'info');
            }
          },
        }));

      const timelineCard = card({ title: '步骤时间线', subtitle: `${steps.length} 步` });
      if (steps.length) {
        const timeline = el('div', { class: 'timeline' });
        steps.forEach((step, index) => timeline.appendChild(stepNode(step, index)));
        timelineCard.appendChild(timeline);
      } else {
        timelineCard.appendChild(emptyState('没有步骤记录', '该运行可能尚未开始或已被中断'));
      }

      const ioCard = card({ title: '输入与产出', body: [
        jsonBlock({ inputs: detail.inputs, output: detail.output, error: detail.error }, '查看 JSON'),
      ] });

      right.replaceChildren(el('div', { class: 'detail-inner' }, head, actions, timelineCard, ioCard));
    }

    void load();

    const unsub = ctx.onEvent(['run'], () => {
      void load();
    });

    ctx.mount.addEventListener('mem:dispose', () => {
      disposed = true;
      unsub();
    }, { once: true });
  },
};
