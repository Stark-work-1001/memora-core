/**
 * 工作流：模板卡片列表（18 个内置）+ DAG 画布（canvas 2D 绘制节点与有向边，
 * 支持平移 / 缩放 / 点击节点查看参数）+ 运行（JSON 输入编辑器）+ 运行结果面板。
 */

import { el } from '../dom';
import { api, errorMessage } from '../api';
import type { RunDetail, RunStep, WorkflowEdge, WorkflowNode, WorkflowTemplate } from '../types';
import { NODE_KIND_COLORS } from '../types';
import {
  badge, button, busy, card, emptyState, errorState, fmtDuration, fmtRelative,
  jsonBlock, modal, skeleton, statusBadge, textInput, toast,
} from './ui';
import type { PageModule } from './contract';
import { isLive, runDegraded, runDurationMs, runProgress, runSteps } from './runs';

/* ---------------------------------------------------------------- 布局计算 */

interface LayoutNode {
  node: WorkflowNode;
  x: number;
  y: number;
  w: number;
  h: number;
  depth: number;
  index: number;
}

interface Layout {
  nodes: LayoutNode[];
  edges: { from: LayoutNode; to: LayoutNode; edge: WorkflowEdge }[];
  width: number;
  height: number;
}

const NODE_W = 168;
const NODE_H = 58;
const GAP_X = 78;
const GAP_Y = 26;
const PAD = 40;
/** 每行最多容纳的层（列）数：保证长链模板也能在 1280 宽下可读。 */
const COLS_PER_BAND = 4;

function computeLayout(nodes: WorkflowNode[], edges: WorkflowEdge[]): Layout {
  const byId = new Map<string, WorkflowNode>();
  for (const node of nodes) byId.set(node.id, node);

  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const node of nodes) {
    indeg.set(node.id, 0);
    adj.set(node.id, []);
  }
  const validEdges = edges.filter((edge) => byId.has(edge.from) && byId.has(edge.to));
  for (const edge of validEdges) {
    adj.get(edge.from)?.push(edge.to);
    indeg.set(edge.to, (indeg.get(edge.to) ?? 0) + 1);
  }

  // 以最长路径分层：从入度为 0 的节点开始 BFS / Kahn
  const depth = new Map<string, number>();
  const queue: string[] = [];
  for (const node of nodes) {
    if ((indeg.get(node.id) ?? 0) === 0) {
      depth.set(node.id, 0);
      queue.push(node.id);
    }
  }
  if (!queue.length && nodes.length) {
    depth.set(nodes[0].id, 0);
    queue.push(nodes[0].id);
  }
  const remaining = new Map(indeg);
  while (queue.length) {
    const current = queue.shift() as string;
    const d = depth.get(current) ?? 0;
    for (const next of adj.get(current) ?? []) {
      depth.set(next, Math.max(depth.get(next) ?? 0, d + 1));
      const left = (remaining.get(next) ?? 0) - 1;
      remaining.set(next, left);
      if (left <= 0) queue.push(next);
    }
  }
  for (const node of nodes) {
    if (!depth.has(node.id)) depth.set(node.id, 0);
  }

  const columns = new Map<number, WorkflowNode[]>();
  for (const node of nodes) {
    const d = depth.get(node.id) ?? 0;
    const list = columns.get(d) ?? [];
    list.push(node);
    columns.set(d, list);
  }

  // 分带（band）：链式模板层数多时按行折返，避免整张图被压扁成一条线。
  const layoutNodes: LayoutNode[] = [];
  const maxDepth = Math.max(0, ...Array.from(columns.keys()));
  let bandBaseY = PAD;
  let rowsInBand = 0;

  for (let d = 0; d <= maxDepth; d += 1) {
    const list = columns.get(d) ?? [];
    const band = Math.floor(d / COLS_PER_BAND);
    const colInBand = d % COLS_PER_BAND;

    if (band > 0 && colInBand === 0) {
      bandBaseY += rowsInBand * (NODE_H + GAP_Y) + GAP_Y * 3;
      rowsInBand = 0;
    }

    list.forEach((node, index) => {
      const explicit = node.pos;
      const x = explicit && typeof explicit.x === 'number' ? explicit.x : PAD + colInBand * (NODE_W + GAP_X);
      const y = explicit && typeof explicit.y === 'number'
        ? explicit.y
        : bandBaseY + index * (NODE_H + GAP_Y);
      layoutNodes.push({ node, x, y, w: NODE_W, h: NODE_H, depth: d, index });
    });

    rowsInBand = Math.max(rowsInBand, list.length);
  }

  const map = new Map(layoutNodes.map((item) => [item.node.id, item]));
  const layoutEdges: Layout['edges'] = [];
  for (const edge of validEdges) {
    const from = map.get(edge.from);
    const to = map.get(edge.to);
    if (from && to) layoutEdges.push({ from, to, edge });
  }

  const width = Math.max(640, ...layoutNodes.map((item) => item.x + item.w)) + PAD;
  const height = Math.max(360, ...layoutNodes.map((item) => item.y + item.h)) + PAD;
  return { nodes: layoutNodes, edges: layoutEdges, width, height };
}

/* ---------------------------------------------------------------- 画布 */

interface CanvasView {
  canvas: HTMLCanvasElement;
  setTemplate(template: WorkflowTemplate | null): void;
  resize(): void;
  focusNode(id: string): void;
  /** 摘掉挂在 window 上的拖拽监听（页面 mem:dispose 时调用，避免切页后泄漏）。 */
  dispose(): void;
}

function createCanvas(onSelect: (node: WorkflowNode | null) => void): CanvasView {
  const canvas = el('canvas', { class: 'dag-canvas', role: 'img', 'aria-label': '工作流 DAG' });
  const ctx2d = canvas.getContext('2d');
  let layout: Layout | null = null;
  let scale = 1;
  let offsetX = 20;
  let offsetY = 20;
  let selected: string | null = null;
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  let moved = false;

  const worldToScreen = (x: number, y: number): { x: number; y: number } => ({
    x: x * scale + offsetX,
    y: y * scale + offsetY,
  });

  const screenToWorld = (x: number, y: number): { x: number; y: number } => ({
    x: (x - offsetX) / scale,
    y: (y - offsetY) / scale,
  });

  const draw = (): void => {
    if (!ctx2d) return;
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(320, Math.round(rect.width || 800));
    const height = Math.max(240, Math.round(rect.height || 460));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx2d.clearRect(0, 0, width, height);

    // 点阵背景
    ctx2d.fillStyle = '#0b0f14';
    ctx2d.fillRect(0, 0, width, height);
    ctx2d.fillStyle = 'rgba(255,255,255,0.05)';
    const step = 24 * scale;
    if (step > 8) {
      for (let x = offsetX % step; x < width; x += step) {
        for (let y = offsetY % step; y < height; y += step) {
          ctx2d.fillRect(x, y, 1, 1);
        }
      }
    }

    if (!layout) {
      ctx2d.fillStyle = 'rgba(226,235,245,0.4)';
      ctx2d.font = '13px system-ui, "Segoe UI", "Microsoft YaHei"';
      ctx2d.textAlign = 'center';
      ctx2d.fillText('选择左侧模板查看 DAG', width / 2, height / 2);
      return;
    }

    // 边
    for (const item of layout.edges) {
      const from = worldToScreen(item.from.x + item.from.w, item.from.y + item.from.h / 2);
      const to = worldToScreen(item.to.x, item.to.y + item.to.h / 2);
      const midX = (from.x + to.x) / 2;
      ctx2d.beginPath();
      ctx2d.moveTo(from.x, from.y);
      ctx2d.bezierCurveTo(midX, from.y, midX, to.y, to.x, to.y);
      ctx2d.strokeStyle = 'rgba(77,163,255,0.55)';
      ctx2d.lineWidth = Math.max(1, 1.4 * scale);
      ctx2d.stroke();

      // 箭头
      const size = Math.max(4, 6 * scale);
      ctx2d.beginPath();
      ctx2d.moveTo(to.x, to.y);
      ctx2d.lineTo(to.x - size, to.y - size * 0.6);
      ctx2d.lineTo(to.x - size, to.y + size * 0.6);
      ctx2d.closePath();
      ctx2d.fillStyle = 'rgba(77,163,255,0.85)';
      ctx2d.fill();

      // 边标签（when）
      const label = item.edge.when ?? item.edge.label;
      if (label && scale > 0.7) {
        ctx2d.fillStyle = 'rgba(226,235,245,0.45)';
        ctx2d.font = `${Math.round(10 * scale)}px ui-monospace, monospace`;
        ctx2d.textAlign = 'center';
        ctx2d.fillText(String(label), midX, (from.y + to.y) / 2 - 4);
      }
    }

    // 节点
    for (const item of layout.nodes) {
      const pos = worldToScreen(item.x, item.y);
      const w = item.w * scale;
      const h = item.h * scale;
      const kind = String(item.node.kind ?? 'input');
      const color = NODE_KIND_COLORS[kind] ?? '#8899aa';
      const isSelected = item.node.id === selected;

      ctx2d.beginPath();
      const radius = Math.max(3, 8 * scale);
      roundRect(ctx2d, pos.x, pos.y, w, h, radius);
      ctx2d.fillStyle = isSelected ? 'rgba(46,230,168,0.14)' : '#121820';
      ctx2d.fill();
      ctx2d.strokeStyle = isSelected ? '#2ee6a8' : color;
      ctx2d.lineWidth = Math.max(1, (isSelected ? 2 : 1.3) * scale);
      ctx2d.stroke();

      // kind 色条
      ctx2d.fillStyle = color;
      ctx2d.fillRect(pos.x, pos.y + radius, Math.max(2, 3 * scale), h - radius * 2);

      if (scale > 0.42) {
        ctx2d.fillStyle = '#e2ebf5';
        ctx2d.font = `${Math.round(Math.min(13, 12 * scale) + 1)}px system-ui, "Segoe UI", "Microsoft YaHei"`;
        ctx2d.textAlign = 'left';
        const label = item.node.name ?? item.node.id;
        ctx2d.fillText(fit(ctx2d, label, w - 20), pos.x + 10, pos.y + h * 0.42);
        ctx2d.fillStyle = 'rgba(226,235,245,0.45)';
        ctx2d.font = `${Math.round(Math.min(10, 9 * scale) + 1)}px ui-monospace, monospace`;
        const sub = `${kind}${item.node.role ? ` · ${item.node.role}` : ''}`;
        ctx2d.fillText(fit(ctx2d, sub, w - 20), pos.x + 10, pos.y + h * 0.72);
      }
    }
  };

  function fit(context: CanvasRenderingContext2D, text: string, maxWidth: number): string {
    if (context.measureText(text).width <= maxWidth) return text;
    let cut = text;
    while (cut.length > 1 && context.measureText(`${cut}…`).width > maxWidth) {
      cut = cut.slice(0, -1);
    }
    return `${cut}…`;
  }

  function roundRect(
    context: CanvasRenderingContext2D,
    x: number, y: number, w: number, h: number, r: number,
  ): void {
    const radius = Math.min(r, w / 2, h / 2);
    context.beginPath();
    context.moveTo(x + radius, y);
    context.lineTo(x + w - radius, y);
    context.quadraticCurveTo(x + w, y, x + w, y + radius);
    context.lineTo(x + w, y + h - radius);
    context.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
    context.lineTo(x + radius, y + h);
    context.quadraticCurveTo(x, y + h, x, y + h - radius);
    context.lineTo(x, y + radius);
    context.quadraticCurveTo(x, y, x + radius, y);
    context.closePath();
  }

  /** 适应视图：把整张图缩放到画布内（留 24px 边距），保证首屏能看到全部节点。 */
  const fitToView = (): void => {
    if (!layout) {
      scale = 1;
      offsetX = 20;
      offsetY = 20;
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const viewW = Math.max(320, rect.width || 800);
    const viewH = Math.max(240, rect.height || 460);
    const margin = 24;
    const sx = (viewW - margin * 2) / Math.max(1, layout.width);
    const sy = (viewH - margin * 2) / Math.max(1, layout.height);
    scale = Math.max(0.45, Math.min(1.1, Math.min(sx, sy)));
    offsetX = (viewW - layout.width * scale) / 2;
    offsetY = (viewH - layout.height * scale) / 2;
  };

  const hitTest = (clientX: number, clientY: number): WorkflowNode | null => {
    if (!layout) return null;
    const rect = canvas.getBoundingClientRect();
    const world = screenToWorld(clientX - rect.left, clientY - rect.top);
    for (const item of layout.nodes) {
      if (world.x >= item.x && world.x <= item.x + item.w && world.y >= item.y && world.y <= item.y + item.h) {
        return item.node;
      }
    }
    return null;
  };

  canvas.addEventListener('mousedown', (ev) => {
    dragging = true;
    moved = false;
    lastX = ev.clientX;
    lastY = ev.clientY;
    canvas.classList.add('is-dragging');
  });
  const onMouseMove = (ev: MouseEvent): void => {
    if (!dragging) return;
    const dx = ev.clientX - lastX;
    const dy = ev.clientY - lastY;
    if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
    offsetX += dx;
    offsetY += dy;
    lastX = ev.clientX;
    lastY = ev.clientY;
    draw();
  };
  const onMouseUp = (ev: MouseEvent): void => {
    if (!dragging) return;
    dragging = false;
    canvas.classList.remove('is-dragging');
    if (!moved) {
      const node = hitTest(ev.clientX, ev.clientY);
      selected = node ? node.id : null;
      onSelect(node);
      draw();
    }
  };
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
  canvas.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mx = ev.clientX - rect.left;
    const my = ev.clientY - rect.top;
    const before = screenToWorld(mx, my);
    const factor = ev.deltaY < 0 ? 1.12 : 1 / 1.12;
    scale = Math.max(0.25, Math.min(2.6, scale * factor));
    offsetX = mx - before.x * scale;
    offsetY = my - before.y * scale;
    draw();
  }, { passive: false });

  return {
    canvas,
    setTemplate(template) {
      layout = template ? computeLayout(template.nodes ?? [], template.edges ?? []) : null;
      selected = null;
      fitToView();
      draw();
    },
    resize: draw,
    dispose() {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    },
    focusNode(id) {
      if (!layout) return;
      const target = layout.nodes.find((item) => item.node.id === id);
      if (!target) return;
      selected = id;
      offsetX = 40 - target.x * scale;
      offsetY = 40 - target.y * scale;
      draw();
    },
  };
}

/* ---------------------------------------------------------------- 运行结果 */

type Loose = Record<string, unknown>;

/** 模板触发器没有任何组件会触发（cron / ingest，本版本没有调度器）时如实标出来。 */
function triggerBadge(template: WorkflowTemplate): HTMLElement | null {
  const loose = template as unknown as Loose;
  if (loose.trigger_active !== false) return null;
  return el('span', { title: String(loose.trigger_note ?? '') }, badge('触发器未激活', 'muted'));
}

function problemBadge(template: WorkflowTemplate): HTMLElement | null {
  const problems = (template as unknown as Loose).problems;
  if (!Array.isArray(problems) || !problems.length) return null;
  return el('span', { title: problems.map(String).join('\n') }, badge(`模板有 ${problems.length} 个问题`, 'danger'));
}

function stepRow(step: RunStep): HTMLElement {
  const degraded = Boolean(step.degraded);
  return el('div', { class: `timeline-step ${degraded ? 'is-degraded' : ''}`.trim() },
    el('span', { class: `timeline-dot status-${String(step.status ?? 'unknown').toLowerCase()}` }),
    el('div', { class: 'timeline-body' },
      el('div', { class: 'timeline-head' },
        el('span', { class: 'timeline-name' }, step.name ?? step.node_id ?? '未命名步骤'),
        statusBadge(step.status),
        degraded ? badge('降级', 'warn') : null,
        el('span', { class: 'muted-text mono' }, fmtDuration(step.duration_ms))),
      el('div', { class: 'timeline-meta' },
        step.kind ? badge(String(step.kind), 'muted') : null,
        step.model ? el('span', { class: 'mono muted-text' }, step.model) : null,
        step.role ? el('span', { class: 'muted-text' }, step.role) : null,
        step.fallback ? badge(`回退 ${step.fallback}`, 'warn') : null),
      step.summary ? el('div', { class: 'timeline-summary' }, step.summary) : null,
      step.error ? el('div', { class: 'timeline-error' }, step.error) : null,
      step.input !== undefined || step.output !== undefined
        ? el('details', { class: 'json-details' },
          el('summary', null, '输入 / 输出'),
          jsonBlock({ input: step.input, output: step.output }))
        : null));
}

/* ---------------------------------------------------------------- 页面 */

export const workflowsPage: PageModule = {
  id: 'workflows',
  title: '工作流',
  icon: 'workflows',
  group: 'main',
  shortcut: 'g w',
  render(ctx) {
    let disposed = false;
    let templates: WorkflowTemplate[] = [];
    let selectedTemplate: WorkflowTemplate | null = null;
    let categoryFilter = '';
    let search = '';
    let lastRun: RunDetail | null = null;
    let pollTimer: number | undefined;
    let eventTimer: number | undefined;

    const page = el('div', { class: 'page page-workflows' });
    const split = el('div', { class: 'split split-workflow' });
    const left = el('div', { class: 'split-left' });
    const right = el('div', { class: 'split-right' });
    split.append(left, right);
    page.appendChild(split);
    ctx.mount.appendChild(page);

    /* -------- 左侧模板列表 -------- */

    const listHost = el('div', { class: 'template-list' });
    const filterInput = textInput({
      placeholder: '搜索模板…',
      onInput: (value) => {
        search = value.trim().toLowerCase();
        renderList();
      },
    });
    const categoryHost = el('div', { class: 'chip-row' });

    left.appendChild(el('div', { class: 'list-toolbar' },
      filterInput,
      el('div', { class: 'list-status' },
        el('span', { class: 'list-meta' }, '—'),
        button('刷新', { iconName: 'refresh', kind: 'subtle', onClick: () => void load() }))));
    left.appendChild(categoryHost);
    left.appendChild(listHost);

    function renderList(): void {
      const categories = Array.from(new Set(templates.map((t) => String(t.category ?? 'other'))));
      categoryHost.replaceChildren(
        el('button', {
          class: `chip-btn ${categoryFilter === '' ? 'is-active' : ''}`.trim(),
          type: 'button',
          onClick: () => { categoryFilter = ''; renderList(); },
        }, `全部 ${templates.length}`),
        ...categories.map((category) => el('button', {
          class: `chip-btn ${categoryFilter === category ? 'is-active' : ''}`.trim(),
          type: 'button',
          onClick: () => { categoryFilter = category; renderList(); },
        }, `${category} ${templates.filter((t) => t.category === category).length}`)),
      );

      const visible = templates.filter((template) => {
        if (categoryFilter && template.category !== categoryFilter) return false;
        if (!search) return true;
        const haystack = `${template.id} ${template.name ?? ''} ${template.description ?? ''}`.toLowerCase();
        return haystack.includes(search);
      });

      if (!visible.length) {
        listHost.replaceChildren(emptyState(
          templates.length ? '没有匹配的模板' : '还没有工作流模板',
          templates.length ? '换个关键词或分类' : '后端启动时会自动播种 18 个内置模板',
        ));
        return;
      }

      const frag = document.createDocumentFragment();
      for (const template of visible) {
        const active = selectedTemplate?.id === template.id;
        const nodeCount = template.nodes?.length ?? 0;
        const item = el('button', {
          class: `template-card ${active ? 'is-active' : ''}`.trim(),
          type: 'button',
          onClick: () => void selectTemplate(template),
        },
          el('div', { class: 'template-card-head' },
            el('span', { class: 'template-name' }, template.name ?? template.id),
            badge(String(template.category ?? 'other'), 'info')),
          el('div', { class: 'template-desc' }, template.description ?? '无描述'),
          el('div', { class: 'template-meta' },
            el('span', { class: 'mono muted-text' }, `v${template.version ?? 1}`),
            el('span', { class: 'muted-text' }, `${nodeCount} 节点`),
            el('span', { class: 'muted-text' }, `${template.edges?.length ?? 0} 边`),
            template.last_run ? el('span', { class: 'muted-text' }, `上次 ${fmtRelative(template.last_run)}`) : null,
            triggerBadge(template),
            problemBadge(template)));
        frag.appendChild(item);
      }
      listHost.replaceChildren(frag);
    }

    /* -------- 右侧画布 -------- */

    const canvasView = createCanvas((node) => renderInspector(node));
    const inspectorHost = el('div', { class: 'inspector' });
    const runHost = el('div', { class: 'run-panel' });

    const toolbar = el('div', { class: 'dag-toolbar' });
    const canvasWrap = el('div', { class: 'dag-wrap' }, canvasView.canvas);
    const canvasCard = card({
      title: 'DAG 画布',
      subtitle: '拖拽平移 · 滚轮缩放 · 点击节点查看参数',
      actions: [toolbar],
    });
    canvasCard.appendChild(canvasWrap);
    canvasCard.appendChild(inspectorHost);

    const unsubResize = (): void => canvasView.resize();
    window.addEventListener('resize', unsubResize);

    function renderToolbar(template: WorkflowTemplate | null): void {
      toolbar.replaceChildren(
        button('适应视图', {
          kind: 'subtle',
          iconName: 'zoomIn',
          onClick: () => {
            if (!template) return;
            canvasView.setTemplate(template);
          },
        }),
        button('运行', {
          kind: 'primary',
          iconName: 'play',
          disabled: !template,
          onClick: () => template ? openRunModal(template) : undefined,
        }),
      );
    }

    function renderInspector(node: WorkflowNode | null): void {
      if (!node) {
        inspectorHost.replaceChildren(el('div', { class: 'inspector-empty' }, '点击画布中的节点查看参数'));
        return;
      }
      const kind = String(node.kind ?? 'input');
      const color = NODE_KIND_COLORS[kind] ?? '#8899aa';
      inspectorHost.replaceChildren(
        el('div', { class: 'inspector-head' },
          el('span', { class: 'kind-dot', style: { background: color } }),
          el('h3', null, node.name ?? node.id),
          badge(kind, 'info'),
          node.role ? badge(`role: ${node.role}`, 'accent') : null),
        el('div', { class: 'inspector-body' },
          el('div', { class: 'muted-text mono' }, `id: ${node.id}`),
          node.params && Object.keys(node.params).length
            ? jsonBlock(node.params, '参数 params')
            : el('div', { class: 'muted-text' }, '该节点没有参数'),
          node.fallbacks && node.fallbacks.length
            ? el('div', { class: 'fallback-row' },
              el('span', { class: 'muted-text' }, '降级实现：'),
              ...node.fallbacks.map((f) => badge(f, 'warn')))
            : null),
      );
    }

    async function selectTemplate(template: WorkflowTemplate): Promise<void> {
      selectedTemplate = template;
      renderList();
      renderToolbar(template);
      canvasView.setTemplate(template);
      renderInspector(null);
      runHost.replaceChildren();
      try {
        const detail = await api.workflow(template.id);
        if (disposed || selectedTemplate?.id !== template.id) return;
        selectedTemplate = { ...template, ...detail };
        canvasView.setTemplate(selectedTemplate);
        renderToolbar(selectedTemplate);
      } catch (error) {
        toast(`模板详情加载失败：${errorMessage(error)}`, 'warn');
      }
    }

    /* -------- 运行 -------- */

    function openRunModal(template: WorkflowTemplate): void {
      const defaultInputs: Record<string, string> = {};
      if (template.inputs) {
        for (const key of Object.keys(template.inputs)) defaultInputs[key] = '';
      }
      const editor = el('textarea', { class: 'textarea code-editor', rows: '12', spellcheck: 'false' });
      editor.value = JSON.stringify({ inputs: defaultInputs, scope: 'global' }, null, 2);
      const scopeInput = textInput({ value: 'global', placeholder: '作用域，如 workspace:demo' });
      const errorLine = el('div', { class: 'form-error' });

      const runBtn = button('开始运行', { kind: 'primary', iconName: 'play' });
      const handle = modal({
        title: `运行：${template.name ?? template.id}`,
        width: 760,
        body: [
          el('p', { class: 'modal-hint' },
            '输入为 JSON，形如 {"inputs": {...}, "scope": "global"}。只需填模板声明的输入，'
            + '说明里标了「可选」的可以留空。运行在后台执行，进度实时显示在下方，可随时取消。'),
          el('div', { class: 'field' }, el('span', { class: 'field-label' }, '作用域'), scopeInput),
          editor,
          errorLine,
        ],
        actions: [button('取消', { kind: 'ghost', onClick: () => handle.close() }), runBtn],
      });

      runBtn.addEventListener('click', async () => {
        let parsed: { inputs?: Record<string, unknown>; scope?: string };
        try {
          parsed = JSON.parse(editor.value) as { inputs?: Record<string, unknown>; scope?: string };
        } catch (error) {
          errorLine.textContent = `JSON 解析失败：${errorMessage(error)}`;
          return;
        }
        errorLine.textContent = '';
        const done = busy(runBtn);
        try {
          // 异步运行：后端立即返回 202（queued/running），不再让浏览器挂着一个 120 秒的 POST
          const run = await api.runWorkflowAsync(
            template.id,
            (parsed.inputs ?? {}) as Record<string, unknown>,
            parsed.scope ?? scopeInput.value.trim() ?? 'global',
          );
          handle.close();
          toast(`运行已开始：${run.id ?? '（无 id）'}`, 'ok');
          lastRun = run;
          renderRun(run);
          await loadRun(run.id);
        } catch (error) {
          errorLine.textContent = errorMessage(error);
          toast('运行失败', 'danger');
        } finally {
          done();
        }
      });
    }

    async function loadRun(runId: string | undefined, silent = false): Promise<void> {
      window.clearTimeout(pollTimer);
      if (!runId) {
        runHost.replaceChildren(emptyState('运行已提交', '后端没有返回运行 id，请到「运行记录」查看'));
        return;
      }
      if (!silent && !lastRun) {
        runHost.replaceChildren(card({ title: '运行结果', body: [skeleton(3)] }));
      }
      try {
        const detail = await api.run(runId);
        if (disposed || (lastRun && lastRun.id !== runId)) return;
        lastRun = detail;
        renderRun(detail);
        // 运行还没结束：每 800ms 轮询一次（SSE run 事件也会触发刷新），结束后停止
        if (isLive(detail.status)) {
          pollTimer = window.setTimeout(() => void loadRun(runId, true), 800);
        }
      } catch (error) {
        if (disposed || silent) return;
        runHost.replaceChildren(errorState({ error, title: '运行详情加载失败', onRetry: () => void loadRun(runId) }));
      }
    }

    async function cancelRun(runId: string, trigger: HTMLButtonElement): Promise<void> {
      trigger.disabled = true;
      try {
        const run = await api.cancelRun(runId);
        toast(run.status === 'cancelled' ? '运行已取消' : '已请求取消，等待当前节点结束', 'info');
      } catch (error) {
        toast(`取消失败：${errorMessage(error)}`, 'warn');
      } finally {
        if (!disposed) void loadRun(runId, true);
      }
    }

    function renderRun(detail: RunDetail): void {
      const steps = runSteps(detail);
      const degraded = runDegraded(detail);
      const live = isLive(detail.status);
      const progress = runProgress(detail);
      const loose = detail as unknown as Loose;
      const head = el('div', { class: 'run-head' },
        el('div', null,
          el('h3', { class: 'run-title' }, detail.template_name ?? detail.name ?? detail.template_id ?? detail.id),
          el('div', { class: 'muted-text mono' }, detail.id)),
        statusBadge(detail.status),
        badge(live ? `进度 ${progress.done}/${progress.total}` : fmtDuration(runDurationMs(detail)), 'muted'),
        degraded.length ? badge(`降级：${degraded.join(' / ')}`, 'warn') : null,
        loose.cancel_requested && live ? badge('已请求取消', 'warn') : null,
        live
          ? button('取消运行', {
            kind: 'danger',
            iconName: 'close',
            disabled: Boolean(loose.cancel_requested),
            onClick: (ev) => void cancelRun(detail.id, ev.currentTarget as HTMLButtonElement),
          })
          : null);

      const list = el('div', { class: 'timeline' });
      if (steps.length) {
        for (const step of steps) list.appendChild(stepRow(step));
      } else {
        list.appendChild(emptyState(live ? '排队中' : '没有步骤记录',
          live ? '运行已提交，等待执行器开始' : '可能是模板没有节点，或运行尚未产生步骤'));
      }

      const box = card({ title: '运行结果', subtitle: live ? `运行中 · ${steps.length} 步已开始` : `${steps.length} 步` });
      box.appendChild(head);
      box.appendChild(list);
      box.appendChild(el('details', { class: 'json-details' },
        el('summary', null, '完整运行 JSON'),
        jsonBlock(detail)));
      runHost.replaceChildren(box);
      ctx.setStatus(live
        ? `运行 ${detail.status ?? ''} · ${progress.done}/${progress.total}`
        : `运行 ${detail.status ?? '未知'} · ${fmtDuration(runDurationMs(detail))}`);
    }

    /* -------- 加载 -------- */

    async function load(): Promise<void> {
      listHost.replaceChildren(skeleton(5));
      try {
        const list = await api.workflows();
        if (disposed) return;
        templates = list;
        renderList();
        if (!list.length) {
          right.replaceChildren(emptyState('还没有工作流模板', '后端首次启动会播种内置模板'));
          return;
        }
        const wanted = ctx.params.get('id');
        const target = (wanted && list.find((t) => t.id === wanted)) || selectedTemplate || list[0];
        if (target) void selectTemplate(target);
      } catch (error) {
        if (disposed) return;
        listHost.replaceChildren();
        right.replaceChildren(errorState({ error, title: '工作流加载失败', onRetry: () => void load() }));
      }
    }

    right.append(canvasCard, runHost);
    renderToolbar(null);
    renderInspector(null);
    void load();
    window.requestAnimationFrame(() => canvasView.resize());

    // SSE run 事件（每一步都会发）：去抖后静默刷新当前运行
    const unsub = ctx.onEvent(['run'], () => {
      window.clearTimeout(eventTimer);
      eventTimer = window.setTimeout(() => {
        if (!disposed && lastRun?.id) void loadRun(lastRun.id, true);
      }, 200);
    });

    ctx.mount.addEventListener('mem:dispose', () => {
      disposed = true;
      window.clearTimeout(pollTimer);
      window.clearTimeout(eventTimer);
      window.removeEventListener('resize', unsubResize);
      canvasView.dispose();
      unsub();
    }, { once: true });
  },
};
