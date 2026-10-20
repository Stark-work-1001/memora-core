/**
 * 总览：健康徽章、记忆计数、kind/scope 分布、最近运行、待审、在线智能体、30 日趋势（canvas）。
 *
 * 字段一律按 server.py api_overview / api_health 的真实形状读取（见 types.ts）。
 * 1.0.0 读的是 total_memories / today_new / trend_7d 等后端从未发送的字段，
 * 于是演示库（21 条记忆）显示为 0；tests/e2e-app.test.mjs 现在逐项比对页面与 API。
 */

import { el, debounce } from '../dom';
import { api, errorMessage, isConnectionIssue } from '../api';
import type { AgentStatus, DistBucket, Health, ModelRoleHealth, Overview, RunSummary, TrendPoint } from '../types';
import { KIND_LABELS } from '../types';
import {
  badge, button, card, distributionBars, emptyState, errorState, fmtNumber, fmtRelative,
  fmtTime, sectionTitle, skeleton, statusBadge, statTile, toast, bucketsFrom,
} from './ui';
import type { PageContext, PageModule } from './contract';

/* ---------------------------------------------------------------- 数据归一化 */

/** 趋势窗口：与后端 daily 的 30 天一致。 */
const TREND_DAYS = 30;

/** 本地日历日 YYYY-MM-DD（后端与界面同机运行，按本地日分桶）。 */
export function localDayKey(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function dailyMap(raw: Overview): Map<string, number> {
  const map = new Map<string, number>();
  for (const item of raw.daily ?? []) {
    if (!item || typeof item.day !== 'string') continue;
    const count = Number(item.count);
    map.set(item.day.slice(0, 10), Number.isFinite(count) ? count : 0);
  }
  return map;
}

/**
 * 连续的按日序列（缺失的日子补 0）。终点取「本地今天」与后端最后一个桶中较晚者，
 * 这样即使后端仍按 UTC 分桶，也不会把最新的桶丢掉。
 */
function dailySeries(raw: Overview, days = TREND_DAYS): TrendPoint[] {
  const map = dailyMap(raw);
  const today = localDayKey(new Date());
  const lastKey = Array.from(map.keys()).sort().pop();
  const endKey = lastKey && lastKey > today ? lastKey : today;
  const [y, m, d] = endKey.split('-').map(Number);
  const end = new Date(y, (m || 1) - 1, d || 1);
  const out: TrendPoint[] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const day = new Date(end.getFullYear(), end.getMonth(), end.getDate() - i);
    const key = localDayKey(day);
    out.push({ date: key, count: map.get(key) ?? 0 });
  }
  return out;
}

/** 今日新增：memory 表没有 created_at，用 daily 里「本地今天」那一桶。 */
function todayCount(raw: Overview): number {
  return dailyMap(raw).get(localDayKey(new Date())) ?? 0;
}

type RoleEntry = ModelRoleHealth & { role: string };

function roleList(health: Health | null): RoleEntry[] {
  const models = health?.models;
  if (!models || typeof models !== 'object') return [];
  return Object.entries(models).map(([role, info]) => ({ ...(info ?? {}), role }));
}

function degradedList(raw: Overview, health: Health | null): string[] {
  const bag = new Set<string>();
  for (const source of [raw.degraded, health?.degraded]) {
    if (!Array.isArray(source)) continue;
    for (const item of source) if (typeof item === 'string' && item) bag.add(item);
  }
  return Array.from(bag).sort();
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function agentOnline(agent: AgentStatus): boolean {
  return agent.status === 'online';
}

/* ---------------------------------------------------------------- 趋势图（canvas 2D） */

interface TrendCanvas {
  node: HTMLCanvasElement;
  draw(): void;
}

function createTrend(points: TrendPoint[]): TrendCanvas {
  const total = points.reduce((acc, p) => acc + p.count, 0);
  const canvas = el('canvas', {
    class: 'trend-canvas',
    role: 'img',
    'aria-label': `近 ${points.length} 日记忆入库趋势：共 ${total} 条`,
    // 供 e2e 测试核对「趋势图真的有数据」，也方便人工调试
    dataset: { points: String(points.length), total: String(total), active: String(points.filter((p) => p.count > 0).length) },
  });
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

    if (!points.length || total === 0) {
      ctx.fillStyle = 'rgba(226,235,245,0.45)';
      ctx.font = '12px system-ui, "Segoe UI", "Microsoft YaHei"';
      ctx.textAlign = 'center';
      ctx.fillText('这段时间没有入库记录', width / 2, height / 2);
      return;
    }
    // 30 个点时日期标签会互相压住：按可用宽度抽稀，最后一天总是标出
    const labelEvery = Math.max(1, Math.ceil(points.length / Math.max(1, Math.floor(plotW / 46))));

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

      if (i % labelEvery === 0 || i === points.length - 1) {
        const label = p.date.length >= 10 ? p.date.slice(5) : p.date;
        ctx.fillStyle = 'rgba(226,235,245,0.45)';
        ctx.textAlign = 'center';
        ctx.fillText(label, x, height - 8);
      }
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
  if (degraded.length) {
    return badge('降级运行', 'warn', `降级能力：${degraded.join('、')}`);
  }
  return badge('在线', 'ok', health.version ? `版本 ${health.version}` : undefined);
}

function roleChip(role: RoleEntry): HTMLElement {
  const configured = role.configured ?? Boolean(role.model);
  const ok = Boolean(role.ok);
  const tone = ok && !role.degraded ? 'ok' : configured ? 'warn' : 'muted';
  const label = !configured ? '未配置' : ok && !role.degraded ? '正常' : '降级';
  const title = [role.provider, role.model, role.last_error].filter(Boolean).join(' · ');
  return el('div', { class: 'role-chip', title, dataset: { role: role.role } },
    el('span', { class: 'role-name' }, role.role),
    badge(label, tone));
}

function runRow(run: RunSummary, navigate: PageContext['navigate']): HTMLElement {
  const meta = [fmtRelative(run.started_at ?? run.created_at), run.trigger, run.scope_id].filter(Boolean).join(' · ');
  return el('button', {
    class: 'list-row list-row-button',
    type: 'button',
    onClick: () => navigate('runs', { id: run.id }),
  },
    el('span', { class: 'row-main' },
      el('span', { class: 'row-title' }, run.template_name ?? run.name ?? run.template_id ?? run.id),
      el('span', { class: 'row-sub' }, meta)),
    statusBadge(run.status));
}

/** sessions / memories 是对象（{total, …}），1.0.0 直接拼进字符串得到 "[object Object]"。 */
function agentRow(agent: AgentStatus): HTMLElement {
  const online = agentOnline(agent);
  return el('div', { class: 'list-row', dataset: { agent: agent.id } },
    el('span', { class: `dot dot-${online ? 'ok' : 'muted'}` }),
    el('span', { class: 'row-main' },
      el('span', { class: 'row-title' }, agent.display_name ?? agent.id),
      el('span', { class: 'row-sub' },
        `${fmtNumber(num(agent.sessions?.total))} 会话 · ${fmtNumber(num(agent.memories?.total))} 记忆`)),
    statusBadge(agent.status ?? 'offline'));
}

function statWithKey(key: string, tile: HTMLElement): HTMLElement {
  tile.dataset.stat = key;
  return tile;
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
        if (overviewRes.status === 'rejected') {
          // 统计取不到就如实报错，不能拿空对象渲染出一排 0（那等于伪造"库是空的"）
          const error = overviewRes.reason;
          root.replaceChildren(
            errorState({ error, title: '总览统计加载失败', onRetry: () => void load() }),
          );
          ctx.setStatus(isConnectionIssue(error) ? '后端不可用' : '加载失败');
          return;
        }
        const raw: Overview = overviewRes.value;
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
      const degraded = degradedList(raw, health);
      const roles = roleList(health);
      const totals = raw.totals ?? {};
      const totalMemories = num(totals.memories);
      const todayNew = todayCount(raw);
      const pending = num(totals.candidates);
      const dueReviews = (raw.pending_reviews ?? []).filter((item) => item.status !== 'candidate').length;
      const runs = raw.recent_runs ?? [];
      const agents = Array.isArray(raw.agents) ? raw.agents : [];
      const onlineAgents = agents.filter(agentOnline);
      const points = dailySeries(raw);

      const byKind: DistBucket[] = bucketsFrom(raw.by_kind ?? {})
        .sort((a, b) => b.count - a.count)
        .map((bucket) => ({ ...bucket, label: KIND_LABELS[bucket.key] ? `${KIND_LABELS[bucket.key]} ${bucket.key}` : bucket.key }));
      const byScope: DistBucket[] = bucketsFrom(raw.by_scope ?? []);
      const problems = [raw.store_error, raw.aggregate_error].filter((item): item is string => Boolean(item));

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
      if (problems.length) {
        // 降级契约：后端说统计不完整，界面就必须说出来，而不是把 0 当真
        header.appendChild(el('div', { class: 'degraded-inline', role: 'status' },
          badge('统计不完整', 'danger'),
          el('span', null, problems.join('；'))));
      }

      const stats = el('div', { class: 'grid grid-4' },
        statWithKey('memories', statTile('记忆总数', fmtNumber(totalMemories),
          `已批准 ${fmtNumber(num(totals.approved))} · 候选 ${fmtNumber(pending)}`, 'ok')),
        statWithKey('today', statTile('今日新增', fmtNumber(todayNew), '按入库时间 recorded_at 的本地日期统计', 'accent')),
        statWithKey('candidates', statTile('待审候选', fmtNumber(pending),
          pending > 0 ? '需要人工确认' : dueReviews ? `另有 ${dueReviews} 条复习到期` : '队列已清空',
          pending > 0 ? 'warn' : undefined)),
        statWithKey('agents', statTile('在线智能体', `${onlineAgents.length}/${agents.length}`, '按探针 / 心跳判定',
          onlineAgents.length ? 'ok' : 'muted')));

      const inventory = el('div', { class: 'inventory-row' },
        ...([
          ['scopes', '作用域', totals.scopes],
          ['documents', '文档', totals.documents],
          ['chunks', '切块', totals.chunks],
          ['evidence', '证据', totals.evidence],
          ['edges', '关系边', totals.edges],
          ['entities', '实体', totals.entities],
          ['conflicts_open', '未决冲突', totals.conflicts_open],
        ] as [string, string, number | undefined][]).map(([key, label, value]) => el('span', {
          class: `inventory-item ${key === 'conflicts_open' && num(value) > 0 ? 'is-warn' : ''}`.trim(),
          dataset: { stat: key },
        }, el('span', { class: 'muted-text' }, label), el('strong', { class: 'mono' }, fmtNumber(num(value))))));

      const trendSum = points.reduce((acc, p) => acc + p.count, 0);
      const trendCard = card({
        title: `近 ${points.length} 日入库趋势`,
        subtitle: '按本地自然日统计新入库的记忆（recorded_at）',
        className: 'card-trend',
        actions: [badge(`共 ${trendSum}`, trendSum ? 'info' : 'muted')],
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
          distributionBars(byKind, { max: 10, onClick: (key) => ctx.navigate('memories', { kind: key }) }),
          sectionTitle('按作用域', `${byScope.length} 个作用域有记忆 · 共 ${fmtNumber(num(totals.scopes))} 个`),
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
        subtitle: `${onlineAgents.length} / ${agents.length} 个在线`,
        actions: [button('管理', { kind: 'subtle', onClick: () => ctx.navigate('agents') })],
      });
      if (agents.length) {
        const list = el('div', { class: 'list' });
        for (const agent of agents.slice(0, 6)) list.appendChild(agentRow(agent));
        agentsCard.appendChild(list);
      } else {
        agentsCard.appendChild(emptyState('尚未登记智能体', '到「智能体」页探测一次'));
      }

      const rolesCard = card({
        title: '模型角色健康',
        subtitle: roles.length ? roles.map((role) => role.role).join(' / ') : undefined,
        actions: [button('配置', { kind: 'subtle', onClick: () => ctx.navigate('models') })],
      });
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
        inventory,
        el('div', { class: 'grid grid-main' }, trendCard, distCard),
        el('div', { class: 'grid grid-3' }, runsCard, agentsCard, el('div', { class: 'stack' }, rolesCard, actionsCard)),
      );
    };

    void load();
    // 事件常成批到达（导入一个目录会连发几十条 memory 事件）：合并成一次静默刷新
    const reloadSoon = debounce(() => {
      void load(true).catch((error) => toast(errorMessage(error), 'danger'));
    }, 400);
    const unsub = ctx.onEvent(['run', 'memory', 'agent'], () => reloadSoon());

    ctx.mount.addEventListener('mem:dispose', () => {
      disposable = false;
      window.removeEventListener('resize', onResize);
      reloadSoon.cancel();
      unsub();
    }, { once: true });
  },
};
