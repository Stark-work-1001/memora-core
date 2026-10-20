/**
 * 运行记录：运行列表 + 步骤时间线（状态 / 耗时 / 模型 / 降级标记 / 输入输出摘要）。
 */

import { el } from '../dom';
import { api, errorMessage } from '../api';
import type { RunDetail, RunStep, RunSummary } from '../types';
import {
  badge, button, card, emptyState, errorState, fmtDateTime, fmtDuration, fmtNumber,
  fmtRelative, jsonBlock, skeleton, statusBadge, toast,
} from './ui';
import type { PageModule } from './contract';

/* ---------------------------------------------------------------- 运行数据归一化（工作流页共用） */

type Loose = Record<string, unknown>;

/** 后端 run 的步骤字段叫 steps（1.0.0 前端读 step_list，时间线永远是 0 步）；两者都认。 */
export function runSteps(detail: RunDetail | null | undefined): RunStep[] {
  if (!detail) return [];
  const raw = (detail as unknown as Loose).steps;
  const list = Array.isArray(raw) ? raw : (detail.step_list ?? []);
  return (list as Loose[]).map(normalizeStep);
}

function normalizeStep(step: Loose): RunStep {
  const out = { ...step } as RunStep & Loose;
  if (out.duration_ms === undefined && typeof step.ms === 'number') out.duration_ms = step.ms;
  const output = (step.output && typeof step.output === 'object' ? step.output : {}) as Loose;
  if (!out.fallback && typeof output.fallback === 'string') out.fallback = output.fallback;
  // 跳过 / 取消 / 降级的原因写在 output.reason；与 error 相同时不重复显示
  if (!out.summary && typeof output.reason === 'string' && output.reason && output.reason !== step.error) {
    out.summary = output.reason;
  }
  return out;
}

/** 后端给 started_at / finished_at（没有 duration_ms）。 */
export function runDurationMs(detail: RunSummary): number | undefined {
  const start = Date.parse(String(detail.started_at ?? ''));
  const end = Date.parse(String(detail.finished_at ?? ''));
  if (Number.isFinite(start) && Number.isFinite(end)) return Math.max(0, end - start);
  return detail.duration_ms;
}

/** degraded 是能力名列表；空列表不算降级（1.0.0 把 [] 当真值，永远显示「含降级」）。 */
export function runDegraded(detail: RunSummary): string[] {
  const value = (detail as unknown as Loose).degraded;
  if (Array.isArray(value)) return value.map(String);
  return value ? ['degraded'] : [];
}

export function isLive(status: unknown): boolean {
  return status === 'queued' || status === 'running';
}

export function runProgress(detail: RunDetail): { done: number; total: number } {
  const steps = runSteps(detail);
  const meta = ((detail as unknown as Loose).meta ?? {}) as Loose;
  const total = typeof meta.steps_total === 'number' ? meta.steps_total : steps.length;
  const done = steps.filter((s) => !isLive(s.status) && s.status !== 'pending').length;
  return { done, total };
}

function runStepCount(run: RunSummary): number | undefined {
  const meta = ((run as unknown as Loose).meta ?? {}) as Loose;
  if (typeof meta.step_count === 'number') return meta.step_count;
  if (typeof meta.steps_total === 'number') return meta.steps_total;
  return typeof run.steps === 'number' ? run.steps : undefined;
}

function runCard(run: RunSummary, active: boolean, onOpen: () => void): HTMLElement {
  const stepCount = runStepCount(run);
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
      el('span', { class: 'muted-text' }, fmtDuration(runDurationMs(run)))),
    el('div', { class: 'run-item-foot' },
      stepCount !== undefined ? badge(`${stepCount} 步`, 'muted') : null,
      runDegraded(run).length ? badge('含降级', 'warn') : null,
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
    let pollTimer: number | undefined;
    let eventTimer: number | undefined;

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
    // 后端状态：queued | running | ok | partial | failed | cancelled（1.0.0 的「完成」筛选发的是 completed，永远 0 条）
    for (const [value, label] of [['', '全部'], ['ok', '成功'], ['partial', '部分'], ['failed', '失败'],
      ['running', '运行中'], ['queued', '排队'], ['cancelled', '已取消']]) {
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

    async function load(silent = false): Promise<void> {
      if (!silent) listHost.replaceChildren(skeleton(5));
      try {
        const result = await api.runs({ limit: 100, status: statusFilter || undefined });
        if (disposed) return;
        runs = result.items;
        renderList();
        if (!runs.length) {
          if (!silent) right.replaceChildren(emptyState('暂无运行记录'));
          return;
        }
        if (silent) return;
        const target = selectedId && runs.some((r) => r.id === selectedId) ? selectedId : runs[0].id;
        void select(target);
      } catch (error) {
        if (disposed || silent) return;
        listHost.replaceChildren();
        right.replaceChildren(errorState({ error, title: '运行记录加载失败', onRetry: () => void load() }));
      }
    }

    async function select(id: string, silent = false): Promise<void> {
      window.clearTimeout(pollTimer);
      selectedId = id;
      if (!silent) {
        renderList();
        right.replaceChildren(el('div', { class: 'detail-skeleton' }, skeleton(2), skeleton(6)));
      }
      try {
        const detail = await api.run(id);
        if (disposed || selectedId !== id) return;
        renderDetail(detail);
        // 运行还没结束：每秒轮询一次（SSE run 事件也会触发刷新），结束后停止
        if (isLive(detail.status)) {
          pollTimer = window.setTimeout(() => void select(id, true), 1000);
        }
      } catch (error) {
        if (disposed || silent) return;
        right.replaceChildren(errorState({ error, title: '运行详情加载失败', onRetry: () => void select(id) }));
      }
    }

    async function cancel(id: string, trigger: HTMLButtonElement): Promise<void> {
      trigger.disabled = true;
      try {
        const run = await api.cancelRun(id);
        toast(run.status === 'cancelled' ? '运行已取消' : '已请求取消，等待当前节点结束', 'info');
      } catch (error) {
        toast(`取消失败：${errorMessage(error)}`, 'warn');
      } finally {
        if (!disposed) void select(id, true);
      }
    }

    function renderDetail(detail: RunDetail): void {
      const steps = runSteps(detail);
      const degraded = runDegraded(detail);
      const progress = runProgress(detail);
      const live = isLive(detail.status);
      const loose = detail as unknown as Record<string, unknown>;
      const head = el('div', { class: 'detail-head' },
        el('div', { class: 'detail-title-row' },
          el('h2', { class: 'detail-title' }, detail.template_name ?? detail.name ?? detail.template_id ?? detail.id),
          statusBadge(detail.status)),
        el('div', { class: 'detail-badges' },
          badge(live ? `进度 ${progress.done}/${progress.total}` : fmtDuration(runDurationMs(detail)), 'muted'),
          badge(String(detail.trigger ?? 'manual'), 'info'),
          detail.scope ?? detail.scope_id ? badge(String(detail.scope ?? detail.scope_id), 'muted') : null,
          degraded.length ? badge(`降级：${degraded.join(' / ')}`, 'warn') : null,
          loose.cancel_requested && live ? badge('已请求取消', 'warn') : null),
        el('div', { class: 'detail-meta-row' },
          el('span', null, `开始 ${fmtDateTime(detail.started_at ?? detail.created_at)}`),
          el('span', null, `结束 ${fmtDateTime(detail.finished_at)}`),
          el('span', { class: 'mono' }, detail.id)));

      const actions = el('div', { class: 'detail-actions' },
        live
          ? button('取消运行', {
            iconName: 'close',
            kind: 'danger',
            disabled: Boolean(loose.cancel_requested),
            onClick: (ev) => void cancel(detail.id, ev.currentTarget as HTMLButtonElement),
          })
          : null,
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
        timelineCard.appendChild(emptyState('没有步骤记录', live ? '运行在排队，还没开始执行' : '该运行可能尚未开始或已被中断'));
      }

      const ioCard = card({ title: '输入与产出', body: [
        jsonBlock({ inputs: detail.inputs ?? loose.input, output: detail.output, error: detail.error }, '查看 JSON'),
      ] });

      right.replaceChildren(el('div', { class: 'detail-inner' }, head, actions, timelineCard, ioCard));
    }

    void load();

    // SSE run 事件（每一步都会发）：去抖后静默刷新列表与当前运行，不再整页重载
    const unsub = ctx.onEvent(['run'], () => {
      window.clearTimeout(eventTimer);
      eventTimer = window.setTimeout(() => {
        if (disposed) return;
        void load(true);
        if (selectedId) void select(selectedId, true);
      }, 300);
    });

    ctx.mount.addEventListener('mem:dispose', () => {
      disposed = true;
      window.clearTimeout(pollTimer);
      window.clearTimeout(eventTimer);
      unsub();
    }, { once: true });
  },
};
