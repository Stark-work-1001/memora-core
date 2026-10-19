/**
 * 总览：健康徽章、记忆计数、kind/scope 分布、最近运行、待审、在线智能体、7 日趋势（canvas）。
 */

import { el } from '../dom';
import { api, errorMessage, isConnectionIssue } from '../api';
import type { AgentStatus, DistBucket, Health, Overview, RoleHealth, RunSummary, TrendPoint } from '../types';
import {
  badge, button, card, distributionBars, emptyState, errorState, fmtNumber, fmtRelative,
  fmtTime, sectionTitle, skeleton, statusBadge, statTile, toast, bucketsFrom,
} from './ui';
import type { PageContext, PageModule } from './contract';

/* ---------------------------------------------------------------- 数据归一化 */

function pickTrend(raw: Overview): TrendPoint[] {
  const source = raw.trend_7d ?? raw.trend ?? [];
  if (Array.isArray(source) && source.length) {
    return source.map((point) => {
      const record = point as unknown as Record<string, unknown>;
      return {
        date: String(record.date ?? record.day ?? record.d ?? ''),
        count: Number(record.count ?? record.n ?? record.value ?? 0) || 0,
      };
    });
  }
  // 也可能给的是 { '2024-01-01': 3 } 形状
  const bag = (raw as unknown as Record<string, unknown>).trend_by_day;
  if (bag && typeof bag === 'object') {
    return Object.entries(bag as Record<string, unknown>).map(([date, count]) => ({
      date,
      count: Number(count) || 0,
    }));
  }
  return [];
}

function normalizeRoles(raw: Overview, health?: Health | null): RoleHealth[] {
  const source = raw.roles ?? health?.roles;
  if (!source) return [];
  if (Array.isArray(source)) return source;
  const list: RoleHealth[] = [];
  for (const [role, value] of Object.entries(source as Record<string, unknown>)) {
    if (value && typeof value === 'object') list.push({ ...(value as RoleHealth), role });
    else list.push({ role, ok: Boolean(value), configured: true });
  }
  return list;
}

function normalizeDegraded(raw: Overview, health?: Health | null): string[] {
  const bag = new Set<string>();
  const push = (value: unknown): void => {
    if (!value) return;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string') bag.add(item);
        else if (item && typeof item === 'object') {
          const record = item as Record<string, unknown>;
          const role = record.role ?? record.capability ?? record.name;
          if (role) bag.add(String(role));
        }
      }
      return;
    }
    if (typeof value === 'string') bag.add(value);
  };
  push(raw.degraded);
  push(health?.degraded_running);
  if (health?.degraded) bag.add('模型网关');
  for (const role of normalizeRoles(raw, health)) {
    if (role.degraded) bag.add(role.role);
  }
  return Array.from(bag);
}

function countOf(raw: Overview, health: Health | null, key: string): number {
  const counts = (raw.counts ?? health?.counts ?? {}) as Record<string, unknown>;
  const direct = (raw as unknown as Record<string, unknown>)[key];
  if (typeof direct === 'number') return direct;
  const value = counts[key];
  return typeof value === 'number' ? value : 0;
}

/* ---------------------------------------------------------------- 趋势图（canvas 2D） */

interface TrendCanvas {
  node: HTMLCanvasElement;
  draw(): void;
}

function createTrend(points: TrendPoint[]): TrendCanvas {
  const canvas = el('canvas', { class: 'trend-canvas', role: 'img', 'aria-label': '近 7 日记忆入库趋势' });
  const draw = (): void => {
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(280, Math.round(rect.width || 640));
    const height = Math.max(120, Math.round(rect.height || 180));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const padTop = 16;
    const padBottom = 26;
    const padLeft = 34;
    const padRight = 12;
    const plotW = width - padLeft - padRight;
    const plotH = height - padTop - padBottom;

    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i += 1) {
      const y = padTop + (plotH * i) / 4;
      ctx.beginPath();
      ctx.moveTo(padLeft, y);
      ctx.lineTo(width - padRight, y);
      ctx.stroke();
    }

    if (!points.length) {
      ctx.fillStyle = 'rgba(226,235,245,0.45)';
      ctx.font = '12px system-ui, "Segoe UI", "Microsoft YaHei"';
      ctx.textAlign = 'center';
      ctx.fillText('暂无入库数据', width / 2, height / 2);
      return;
    }

    const maxValue = Math.max(1, ...points.map((p) => p.count));
    const stepX = points.length > 1 ? plotW / (points.length - 1) : 0;
    const xAt = (i: number): number => padLeft + (points.length > 1 ? stepX * i : plotW / 2);
    const yAt = (value: number): number => padTop + plotH - (value / maxValue) * plotH;

    // 面积
    const gradient = ctx.createLinearGradient(0, padTop, 0, padTop + plotH);
    gradient.addColorStop(0, 'rgba(46,230,168,0.32)');
    gradient.addColorStop(1, 'rgba(46,230,168,0.02)');
    ctx.beginPath();
    ctx.moveTo(xAt(0), padTop + plotH);
    points.forEach((p, i) => ctx.lineTo(xAt(i), yAt(p.count)));
    ctx.lineTo(xAt(points.length - 1), padTop + plotH);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();

    // 折线
    ctx.beginPath();
    points.forEach((p, i) => {
      const x = xAt(i);
      const y = yAt(p.count);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = '#2ee6a8';
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.stroke();

    // 点与数值
    ctx.font = '11px ui-monospace, SFMono-Regular, Consolas, monospace';
    ctx.textAlign = 'center';
    points.forEach((p, i) => {
      const x = xAt(i);
      const y = yAt(p.count);
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fillStyle = '#0b0f14';
      ctx.fill();
      ctx.strokeStyle = '#2ee6a8';
      ctx.lineWidth = 1.8;
      ctx.stroke();

      if (p.count > 0) {
        ctx.fillStyle = '#e2ebf5';
        ctx.fillText(String(p.count), x, Math.max(12, y - 9));
      }

      const label = p.date.length >= 10 ? p.date.slice(5) : p.date;
      ctx.fillStyle = 'rgba(226,235,245,0.45)';
      ctx.textAlign = 'center';
      ctx.fillText(label, x, height - 8);
      ctx.textAlign = 'center';
    });

    // Y 轴刻度
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(226,235,245,0.4)';
    for (let i = 0; i <= 4; i += 1) {
      const value = Math.round((maxValue * (4 - i)) / 4);
      const y = padTop + (plotH * i) / 4;
      ctx.fillText(String(value), padLeft - 6, y + 4);
    }
  };

  return { node: canvas, draw };
}

/* ---------------------------------------------------------------- 页面 */

function healthBadge(health: Health | null, degraded: string[]): HTMLElement {
  if (!health) return badge('后端未连接', 'danger', '无法访问 /api/health');
  if (degraded.length || health.degraded) {
    return badge('降级运行', 'warn', degraded.length ? `降级能力：${degraded.join('、')}` : '云端模型不可用');
  }
  return badge('在线', 'ok', health.version ? `版本 ${health.version}` : undefined);
}

function roleChip(role: RoleHealth): HTMLElement {
  const ok = role.ok ?? (role.configured && !role.degraded);
  const tone = role.degraded ? 'warn' : ok ? 'ok' : 'muted';
  const label = role.degraded ? '降级' : ok ? '正常' : role.configured ? '异常' : '未配置';
  return el('div', { class: 'role-chip', title: role.last_error ?? role.model ?? '' },
    el('span', { class: 'role-name' }, role.role),
    badge(label, tone));
}

function runRow(run: RunSummary, navigate: PageContext['navigate']): HTMLElement {
  return el('button', {
    class: 'list-row list-row-button',
    type: 'button',
    onClick: () => navigate('runs', { id: run.id }),
  },
    el('span', { class: 'row-main' },
      el('span', { class: 'row-title' }, run.template_name ?? run.name ?? run.template_id ?? run.id),
      el('span', { class: 'row-sub' }, `${fmtRelative(run.started_at ?? run.created_at)} · ${run.steps ?? '—'} 步`)),
    statusBadge(run.status));
}

function agentRow(agent: AgentStatus): HTMLElement {
  const online = agent.online ?? agent.status === 'online';
  const status = agent.status ?? (online ? 'online' : 'offline');
  return el('div', { class: 'list-row' },
    el('span', { class: `dot dot-${online ? 'ok' : 'muted'}` }),
    el('span', { class: 'row-main' },
      el('span', { class: 'row-title' }, agent.name ?? agent.id),
      el('span', { class: 'row-sub' }, `${agent.sessions ?? 0} 会话 · ${agent.memories ?? 0} 记忆`)),
    statusBadge(status));
}

export const overviewPage: PageModule = {
  id: 'overview',
  title: '总览',
  icon: 'overview',
  group: 'main',
  shortcut: 'g o',
  render(ctx) {
    const root = el('div', { class: 'page page-overview' });
    ctx.mount.appendChild(root);
    let disposable = true;
    let trend: TrendCanvas | null = null;

    const onResize = (): void => trend?.draw();
    window.addEventListener('resize', onResize);

    const load = async (silent = false): Promise<void> => {
      if (!silent) {
        ctx.setStatus('加载总览…');
        root.replaceChildren(el('div', { class: 'grid grid-3' },
          card({ body: [skeleton(3)] }),
          card({ body: [skeleton(3)] }),
          card({ body: [skeleton(3)] })));
      }
      try {
        const [overviewRes, healthRes] = await Promise.allSettled([api.overview(), api.health()]);
        if (!disposable) return;
        if (overviewRes.status === 'rejected' && healthRes.status === 'rejected') {
          const error = overviewRes.reason;
          root.replaceChildren(
            errorState({ error, onRetry: () => void load() }),
          );
          ctx.setStatus('后端不可用');
          return;
        }
        const raw: Overview = overviewRes.status === 'fulfilled' ? overviewRes.value : {};
        const health: Health | null = healthRes.status === 'fulfilled' ? healthRes.value : null;
        render(raw, health);
        ctx.setStatus(`更新于 ${fmtTime(Date.now())}`);
      } catch (error) {
        if (!disposable) return;
        root.replaceChildren(errorState({ error, onRetry: () => void load() }));
        ctx.setStatus(isConnectionIssue(error) ? '后端不可用' : '加载失败');
      }
    };

    const render = (raw: Overview, health: Health | null): void => {
      const degraded = normalizeDegraded(raw, health);
      const roles = normalizeRoles(raw, health);
      const totalMemories = countOf(raw, health, 'memories') || Number(raw.total_memories ?? 0);
      const todayNew = Number(raw.today_new ?? 0) || 0;
      const pending = Number(raw.pending_candidates ?? 0) || countOf(raw, health, 'candidates');
      const runs = raw.recent_runs ?? [];
      const agents = raw.agents_online ?? raw.agents ?? [];
      const onlineAgents = agents.filter((a) => a.online ?? a.status === 'online');
      const points = pickTrend(raw);

      const byKind: DistBucket[] = bucketsFrom(raw.by_kind ?? raw.counts?.by_kind ?? []);
      const byScope: DistBucket[] = bucketsFrom(raw.by_scope ?? raw.counts?.by_scope ?? []);

      // 头部：健康徽章 + 角色状态
      const header = el('div', { class: 'page-head' },
        el('div', { class: 'page-head-left' },
          el('h1', { class: 'page-title' }, '记忆中枢总览'),
          el('div', { class: 'page-head-meta' },
            healthBadge(health, degraded),
            health?.version ? el('span', { class: 'muted-text' }, `v${health.version}`) : null,
            health?.uptime_s ? el('span', { class: 'muted-text' }, `运行 ${Math.floor(health.uptime_s / 60)} 分钟`) : null)),
        el('div', { class: 'page-head-actions' },
          button('刷新', { iconName: 'refresh', onClick: () => void load() })));

      if (degraded.length) {
        header.appendChild(el('div', { class: 'degraded-inline' },
          badge('离线降级', 'warn'),
          el('span', null, `受影响：${degraded.join('、')}`)));
      }

      const stats = el('div', { class: 'grid grid-4' },
        statTile('记忆总数', fmtNumber(totalMemories), `已批准与候选合计`, 'ok'),
        statTile('今日新增', fmtNumber(todayNew), '按 created_at 当日统计', 'accent'),
        statTile('待审候选', fmtNumber(pending), pending > 0 ? '需要人工确认' : '队列已清空', pending > 0 ? 'warn' : undefined),
        statTile('在线智能体', `${onlineAgents.length}/${agents.length}`, '按探针判定', onlineAgents.length ? 'ok' : 'muted'));

      const trendCard = card({
        title: '近 7 日入库趋势',
        subtitle: '按自然日统计新建记忆',
        className: 'card-trend',
        actions: points.length ? [badge(`共 ${points.reduce((a, p) => a + p.count, 0)}`, 'info')] : [],
      });
      const canvasWrap = el('div', { class: 'trend-wrap' });
      trend = createTrend(points);
      canvasWrap.appendChild(trend.node);
      trendCard.appendChild(canvasWrap);
      window.requestAnimationFrame(() => trend?.draw());

      const distCard = card({
        title: '分布',
        subtitle: '按 kind / scope 统计',
        body: [
          sectionTitle('按类型', `${byKind.length} 类`),
          distributionBars(byKind, { max: 8, onClick: (key) => ctx.navigate('memories', { kind: key }) }),
          sectionTitle('按作用域', `${byScope.length} 个`),
          distributionBars(byScope, { max: 8, onClick: (key) => ctx.navigate('memories', { scope: key }) }),
        ],
      });

      const runsCard = card({
        title: '最近工作流运行',
        subtitle: runs.length ? `共 ${runs.length} 条` : undefined,
        actions: [button('全部', { kind: 'subtle', onClick: () => ctx.navigate('runs') })],
      });
      if (runs.length) {
        const list = el('div', { class: 'list' });
        for (const run of runs.slice(0, 6)) list.appendChild(runRow(run, ctx.navigate.bind(ctx)));
        runsCard.appendChild(list);
      } else {
        runsCard.appendChild(emptyState('还没有运行记录', '到「工作流」页选择一个模板并运行'));
      }

      const agentsCard = card({
        title: '智能体在线',
        subtitle: `${onlineAgents.length} 个在线`,
        actions: [button('管理', { kind: 'subtle', onClick: () => ctx.navigate('agents') })],
      });
      if (agents.length) {
        const list = el('div', { class: 'list' });
        for (const agent of agents.slice(0, 6)) list.appendChild(agentRow(agent));
        agentsCard.appendChild(list);
      } else {
        agentsCard.appendChild(emptyState('尚未登记智能体', '到「智能体」页探测一次'));
      }

      const rolesCard = card({ title: '模型角色健康', subtitle: 'chat / embedding / reranker / judge' });
      if (roles.length) {
        const chips = el('div', { class: 'role-chips' });
        for (const role of roles) chips.appendChild(roleChip(role));
        rolesCard.appendChild(chips);
      } else {
        rolesCard.appendChild(emptyState('未配置模型档位', '到「模型」页填写 provider 与 model'));
      }

      const actionsCard = card({
        title: '快捷操作',
        body: [
          el('div', { class: 'quick-actions' },
            button('检索记忆', { kind: 'primary', iconName: 'search', onClick: () => ctx.navigate('search') }),
            button('导入文档', { iconName: 'upload', onClick: () => ctx.navigate('documents') }),
            button('运行工作流', { iconName: 'workflows', onClick: () => ctx.navigate('workflows') }),
            button('打开脑图', { iconName: 'brain', onClick: () => ctx.navigate('graph') })),
        ],
      });

      root.replaceChildren(
        header,
        stats,
        el('div', { class: 'grid grid-main' }, trendCard, distCard),
        el('div', { class: 'grid grid-3' }, runsCard, agentsCard, el('div', { class: 'stack' }, rolesCard, actionsCard)),
      );
    };

    void load();
    const unsub = ctx.onEvent(['run', 'memory', 'agent'], () => {
      void load(true).catch((error) => toast(errorMessage(error), 'danger'));
    });

    ctx.mount.addEventListener('mem:dispose', () => {
      disposable = false;
      window.removeEventListener('resize', onResize);
      unsub();
    }, { once: true });
  },
};
