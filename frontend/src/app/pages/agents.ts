/**
 * 智能体：卡片展示在线状态、探针证据、会话数 / 记忆数 / 最近心跳；
 * 「探测一次」按钮；接入配置片段（可复制）。
 */

import { el } from '../dom';
import { api, errorMessage } from '../api';
import type { AgentProbe, AgentStatus } from '../types';
import {
  badge, button, busy, copyButton, emptyState, errorState, fmtNumber, fmtRelative,
  skeleton, statusBadge, toast,
} from './ui';
import type { PageModule } from './contract';

const ECOSYSTEM_LABELS: Record<string, string> = {
  dsh: 'DSH',
  'claude-code': 'Claude Code',
  codex: 'Codex CLI',
  cursor: 'Cursor',
  claude: 'Claude Desktop',
  'generic-mcp': '通用 MCP',
};

interface ProbeLike extends AgentProbe {
  match?: unknown;
}

function probeRow(probe: ProbeLike): HTMLElement {
  const detail = probe.detail ?? probe.evidence ?? probe.target ?? '';
  return el('div', { class: `probe-row ${probe.ok ? 'is-ok' : ''}`.trim() },
    el('span', { class: `dot dot-${probe.ok ? 'ok' : 'muted'}` }),
    el('span', { class: 'probe-type mono' }, String(probe.type ?? 'probe')),
    el('span', { class: 'probe-detail', title: detail }, detail || '无输出'));
}

function configSnippet(agent: AgentStatus): string {
  if (agent.config_snippet) return agent.config_snippet;
  const id = agent.id;
  if (agent.ecosystem === 'claude-code' || agent.ecosystem === 'claude') {
    return JSON.stringify({
      mcpServers: {
        memora: { command: 'python', args: ['-m', 'memora_core', '--data', '<数据目录>', 'mcp-stdio'] },
      },
    }, null, 2);
  }
  if (agent.ecosystem === 'codex') {
    return `[mcp_servers.memora]\ncommand = "python"\nargs = ["-m", "memora_core", "--data", "<数据目录>", "mcp-stdio"]`;
  }
  if (agent.ecosystem === 'cursor') {
    return JSON.stringify({
      mcpServers: {
        memora: { url: 'http://127.0.0.1:8790/mcp', transport: 'http' },
      },
    }, null, 2);
  }
  if (agent.ecosystem === 'generic-mcp') {
    return `# stdio\ncommand: python -m memora_core --data <数据目录> mcp-stdio\n# http\nendpoint: POST http://127.0.0.1:8790/mcp`;
  }
  return `# ${agent.name ?? id}\nMCP: POST http://127.0.0.1:8790/mcp\nREST: http://127.0.0.1:8790/api/*`;
}

function agentCard(agent: AgentStatus, onProbe: (id: string) => void): HTMLElement {
  const online = agent.online ?? agent.status === 'online';
  const status = agent.status ?? (online ? 'online' : 'offline');
  const probes = (agent.probes ?? []) as ProbeLike[];
  const node = el('article', { class: `agent-card ${online ? 'is-online' : ''}`.trim() });

  const snippet = configSnippet(agent);
  const snippetPre = el('pre', { class: 'config-snippet' }, snippet);

  node.append(
    el('div', { class: 'agent-head' },
      el('div', { class: 'agent-title-wrap' },
        el('span', { class: `status-led ${online ? 'is-on' : ''}`.trim() }),
        el('div', null,
          el('h3', { class: 'agent-name' }, agent.name ?? agent.id),
          el('div', { class: 'agent-sub' },
            badge(ECOSYSTEM_LABELS[String(agent.ecosystem ?? '')] ?? String(agent.ecosystem ?? 'mcp'), 'info'),
            el('span', { class: 'mono muted-text' }, agent.id)))),
      statusBadge(status)),
    el('div', { class: 'agent-stats' },
      el('div', { class: 'agent-stat' }, el('span', { class: 'muted-text' }, '会话'), el('strong', null, fmtNumber(agent.sessions ?? 0))),
      el('div', { class: 'agent-stat' }, el('span', { class: 'muted-text' }, '记忆'), el('strong', null, fmtNumber(agent.memories ?? 0))),
      el('div', { class: 'agent-stat' }, el('span', { class: 'muted-text' }, '心跳'), el('strong', null, fmtRelative(agent.heartbeat_at ?? agent.last_seen)))),
  );

  const probeSection = el('div', { class: 'agent-probes' },
    el('div', { class: 'probe-head' }, el('span', null, '探针证据'), badge(`${probes.filter((p) => p.ok).length}/${probes.length} 通过`, probes.some((p) => p.ok) ? 'ok' : 'muted')));
  if (probes.length) {
    for (const probe of probes) probeSection.appendChild(probeRow(probe));
  } else {
    probeSection.appendChild(el('div', { class: 'muted-text' }, '还没有探针结果，点右侧「探测」'));
  }
  node.appendChild(probeSection);

  node.appendChild(el('div', { class: 'agent-config' },
    el('div', { class: 'config-head' },
      el('span', null, '接入配置'),
      copyButton(() => snippet, '复制片段')),
    snippetPre));

  node.appendChild(el('div', { class: 'agent-actions' },
    button('探测一次', { kind: 'subtle', iconName: 'refresh', onClick: () => onProbe(agent.id) }),
    agent.config_hint ? el('span', { class: 'muted-text agent-hint' }, agent.config_hint) : null,
  ));
  return node;
}

export const agentsPage: PageModule = {
  id: 'agents',
  title: '智能体',
  icon: 'agents',
  group: 'main',
  shortcut: 'g a',
  render(ctx) {
    let disposed = false;
    let agents: AgentStatus[] = [];

    const page = el('div', { class: 'page page-agents' });
    ctx.mount.appendChild(page);

    const probeAllBtn = button('全部探测', { kind: 'primary', iconName: 'refresh' });
    const head = el('div', { class: 'page-head' },
      el('div', { class: 'page-head-left' },
        el('h1', { class: 'page-title' }, '智能体接入'),
        el('div', { class: 'page-head-meta' },
          el('span', { class: 'muted-text' }, '进程 / 端口 / 心跳文件 / MCP 四种探针'))),
      el('div', { class: 'page-head-actions' },
        button('刷新', { kind: 'subtle', iconName: 'refresh', onClick: () => void load() }),
        probeAllBtn));
    page.appendChild(head);

    const grid = el('div', { class: 'agent-grid' });
    page.appendChild(grid);

    async function probeOne(id: string): Promise<void> {
      try {
        await api.probeAgents();
        toast('探测完成', 'ok');
        await load();
      } catch (error) {
        toast(`探测失败（${id}）：${errorMessage(error)}`, 'danger');
      }
    }

    probeAllBtn.addEventListener('click', async () => {
      const done = busy(probeAllBtn);
      try {
        await api.probeAgents();
        toast('全部探测完成', 'ok');
        await load();
      } catch (error) {
        toast(errorMessage(error), 'danger');
      } finally {
        done();
      }
    });

    async function load(): Promise<void> {
      grid.replaceChildren(skeleton(4), skeleton(4));
      try {
        const list = await api.agents();
        if (disposed) return;
        agents = list;
        render();
      } catch (error) {
        if (disposed) return;
        grid.replaceChildren(errorState({ error, title: '智能体列表加载失败', onRetry: () => void load() }));
      }
    }

    function render(): void {
      if (!agents.length) {
        grid.replaceChildren(emptyState(
          '尚未登记智能体',
          '后端启动时会从 builtin/agents.json 播种 DSH / Claude Code / Codex / Cursor / Claude Desktop / 通用 MCP',
          button('探测一次', { kind: 'primary', iconName: 'refresh', onClick: () => void probeOne('all') }),
        ));
        return;
      }
      const online = agents.filter((a) => a.online ?? a.status === 'online');
      const summary = el('div', { class: 'agent-summary' },
        badge(`${online.length} / ${agents.length} 在线`, online.length ? 'ok' : 'muted'),
        el('span', { class: 'muted-text' }, `总会话 ${fmtNumber(agents.reduce((acc, a) => acc + Number(a.sessions ?? 0), 0))}`),
        el('span', { class: 'muted-text' }, `总记忆 ${fmtNumber(agents.reduce((acc, a) => acc + Number(a.memories ?? 0), 0))}`));

      const cards = agents.map((agent) => agentCard(agent, (id) => void probeOne(id)));
      grid.replaceChildren(summary, ...cards);
    }

    void load();

    const unsub = ctx.onEvent(['agent'], () => {
      void load();
    });

    ctx.mount.addEventListener('mem:dispose', () => {
      disposed = true;
      unsub();
    }, { once: true });
  },
};
