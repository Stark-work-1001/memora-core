/**
 * SVG + vanilla DOM workflow canvas.
 *
 * Rendered as real SVG nodes rather than canvas2d on purpose: every card stays
 * inspectable, selectable, focusable and readable by assistive tech, and the
 * browser can hit-test it without us re-implementing hit testing per pixel.
 *
 * The canvas owns no application state. It renders whatever it is handed and
 * reports intent back through callbacks; every mutation therefore goes through
 * the same cycle check as every other edit.
 */

import {
  LAYOUT_DEFAULTS,
  emptyCycles,
  fitText,
  STATUS_LABELS,
  graphBounds,
  operationLabel,
  routeEdge,
  truncate,
  wrapText,
  type Bounds,
  type CycleReport,
  type DagEdge,
  type DagNode,
  type EdgeKind,
  type NodeStatus,
  type Point,
} from './dag-model';

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, String(value));
  return element;
}

export type Selection =
  | { kind: 'node'; id: string }
  | { kind: 'edge'; index: number }
  | null;

export interface CanvasState {
  nodes: DagNode[];
  edges: DagEdge[];
  statuses: Map<string, NodeStatus>;
  cycles: CycleReport;
  selected: Selection;
}

export interface CanvasHandlers {
  onSelect(selection: Selection): void;
  onMoveNode(id: string, x: number, y: number): void;
  onConnect(from: string, to: string): void;
}

const CARD = LAYOUT_DEFAULTS;
const PAD = 40;

export class DagCanvas {
  readonly svg: SVGSVGElement;
  private readonly viewport: SVGGElement;
  private readonly edgeLayer: SVGGElement;
  private readonly nodeLayer: SVGGElement;
  private readonly guide: SVGPathElement;
  private readonly groups = new Map<string, SVGGElement>();
  /** Kept in edge order so a node drag can re-route edges without rebuilding the node layer. */
  private edgePaths: Array<{ line: SVGPathElement; hit: SVGPathElement }> = [];
  /** One step of the organize transition; replaced, never queued twice. */
  private organizeFrame = 0;
  private view = { x: 0, y: 0, k: 1 };
  /** Pending deferred fit (see fit()): a canvas with no size yet cannot be framed. */
  private fitPending = 0;
  private state: CanvasState = { nodes: [], edges: [], statuses: new Map(), cycles: emptyCycles(), selected: null };
  private drag:
    | { kind: 'node'; id: string; grabX: number; grabY: number; originX: number; originY: number; moved: boolean }
    | { kind: 'connect'; from: string; pointerId: number }
    | { kind: 'pan'; startX: number; startY: number; viewX: number; viewY: number; moved: boolean }
    | null = null;

  constructor(
    private readonly host: HTMLElement,
    private readonly handlers: CanvasHandlers,
  ) {
    this.svg = svgEl('svg', {
      class: 'dag-svg',
      xmlns: SVG_NS,
      role: 'application',
      'aria-label': '工作流 DAG 画布：拖动节点排版，从节点右侧圆点拖到另一个节点建立连线',
    });
    const defs = svgEl('defs');
    defs.append(
      marker('dag-arrow', 'dag-arrow-head'),
      marker('dag-arrow-warn', 'dag-arrow-head dag-arrow-head--warn'),
    );
    this.viewport = svgEl('g', { class: 'dag-viewport' });
    this.edgeLayer = svgEl('g', { class: 'dag-edges' });
    this.nodeLayer = svgEl('g', { class: 'dag-nodes' });
    this.guide = svgEl('path', { class: 'dag-guide', fill: 'none' });
    this.viewport.append(this.edgeLayer, this.guide, this.nodeLayer);
    this.svg.append(defs, this.viewport);
    this.host.append(this.svg);
    this.bind();
  }

  /** Screen pixels -> graph units, accounting for pan and zoom. */
  project(clientX: number, clientY: number): { x: number; y: number } {
    const box = this.svg.getBoundingClientRect();
    return {
      x: (clientX - box.left - this.view.x) / this.view.k,
      y: (clientY - box.top - this.view.y) / this.view.k,
    };
  }

  /**
   * What is really under the cursor.
   *
   * Pointer capture retargets every follow-up event to the capturing element, so
   * `event.target` is useless once a drag starts; only a hit test answers honestly.
   */
  private under(event: PointerEvent): Element | null {
    return document.elementFromPoint(event.clientX, event.clientY);
  }

  /** Every node, in one array: back-edge detours need to know where the top of the graph is. */
  private get obstacles(): DagNode[] {
    return this.state.nodes;
  }

  /**
   * Re-route edges in place; used while a node is being dragged.
   *
   * The node layer is not rebuilt during a drag (that would drop the element the
   * pointer is moving), so this is the only thing that keeps an edge attached to a
   * moving card. Every edge is recomputed, not just the ones touching the dragged
   * node: a back-edge detour is routed above the whole graph, so dragging any card
   * down can change it.
   */
  private refreshEdges(): void {
    const byId = new Map(this.state.nodes.map((node) => [node.id, node]));
    this.edgePaths.forEach((paths, index) => {
      const edge = this.state.edges[index];
      if (!edge) return;
      const from = byId.get(edge.from);
      const to = byId.get(edge.to);
      if (!from || !to) return;
      const route = routeEdge(from, to, this.obstacles, undefined, index % 4);
      paths.line.setAttribute('d', route.d);
      paths.hit.setAttribute('d', route.d);
    });
  }

  private applyView(): void {
    this.viewport.setAttribute('transform', 'translate(' + this.view.x + ' ' + this.view.y + ') scale(' + this.view.k + ')');
  }

  zoomBy(factor: number, anchorX?: number, anchorY?: number): void {
    const box = this.svg.getBoundingClientRect();
    const ax = anchorX ?? box.left + box.width / 2;
    const ay = anchorY ?? box.top + box.height / 2;
    const before = this.project(ax, ay);
    this.view.k = Math.min(2.5, Math.max(0.25, this.view.k * factor));
    this.view.x = ax - box.left - before.x * this.view.k;
    this.view.y = ay - box.top - before.y * this.view.k;
    this.applyView();
  }

  /**
   * Does this browser ask for reduced motion?
   *
   * Read at call time, not at construction: the media query can change while the page
   * is open (OS setting), and a cached answer would keep animating after the user
   * turned it off.
   */
  static prefersReducedMotion(): boolean {
    try {
      return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
      return false;
    }
  }

  /**
   * Move every card from where it is now to `target` along `steps` progress values.
   *
   * The engine is the canvas's, not the caller's: a second organize cancels the first
   * instead of stacking two requestAnimationFrame loops on the same cards, and
   * `steps` is a plain array so the reduced-motion branch is one frame of [1] rather
   * than a separate code path.
   *
   * `onFrame` runs after the cards have been moved on screen but before anything is
   * handed back to the application state: during the transition the DOM and the draft
   * must not disagree about where a card is.
   */
  animateTo(
    target: Map<string, Point>,
    steps: number[],
    onFrame: (positions: Map<string, Point>) => void,
    onDone?: () => void,
  ): void {
    cancelAnimationFrame(this.organizeFrame);
    const from = new Map<string, Point>();
    for (const node of this.state.nodes) from.set(node.id, { x: node.x ?? 0, y: node.y ?? 0 });
    const schedule = steps.length > 0 ? steps : [1];
    const place = (progress: number): Map<string, Point> => {
      const positions = new Map<string, Point>();
      for (const node of this.state.nodes) {
        const origin = from.get(node.id);
        const end = target.get(node.id);
        if (!origin || !end) continue;
        positions.set(node.id, {
          x: Math.round(origin.x + (end.x - origin.x) * progress),
          y: Math.round(origin.y + (end.y - origin.y) * progress),
        });
      }
      return positions;
    };
    const apply = (positions: Map<string, Point>): void => {
      // Move the live SVG groups directly: re-rendering the whole state every frame
      // would rebuild every card 20 times a second for no visual gain.
      for (const [id, point] of positions) {
        const group = this.groups.get(id);
        if (group) group.setAttribute('transform', 'translate(' + point.x + ' ' + point.y + ')');
      }
      for (const node of this.state.nodes) {
        const point = positions.get(node.id);
        if (point) {
          node.x = point.x;
          node.y = point.y;
        }
      }
      this.refreshEdges();
      onFrame(positions);
    };
    let index = 0;
    const step = (): void => {
      apply(place(schedule[index]));
      index += 1;
      if (index < schedule.length) {
        this.organizeFrame = requestAnimationFrame(step);
      } else if (onDone) {
        onDone();
      }
    };
    if (schedule.length <= 1) step();
    else this.organizeFrame = requestAnimationFrame(step);
  }

  /** Frame the whole graph with a comfortable margin. */
  fit(): void {
    // A canvas that has not been laid out yet reports a zero-size box, and fitting against it
    // produces a transform that parks the graph outside the viewport: the user sees a blank
    // stage with the node count in the status line. This is not hypothetical -- it is exactly
    // what happened when a workflow was selected during the first render, before the layout
    // pass had given the SVG a size. Defer once instead of baking in a bad view.
    const stage = this.svg.getBoundingClientRect();
    if (this.state.nodes.length > 0 && (stage.width < 2 || stage.height < 2)) {
      if (!this.fitPending) {
        this.fitPending = requestAnimationFrame(() => { this.fitPending = 0; this.fit(); });
      }
      return;
    }
    if (this.state.nodes.length === 0) {
      this.view = { x: PAD, y: PAD, k: 1 };
      this.applyView();
      return;
    }
    // LAYOUT_DEFAULTS, not a bespoke margin: graphBounds must agree with the pitch the
    // layout actually used, or fit() frames a graph that is slightly larger than drawn.
    const bounds: Bounds = graphBounds(this.state.nodes, LAYOUT_DEFAULTS);
    const box = this.svg.getBoundingClientRect();
    const width = Math.max(1, bounds.width);
    const height = Math.max(1, bounds.height);
    const k = Math.min(2, Math.max(0.25, Math.min((box.width - PAD * 2) / width, (box.height - PAD * 2) / height)));
    this.view.k = k;
    this.view.x = (box.width - width * k) / 2 - bounds.x * k;
    this.view.y = (box.height - height * k) / 2 - bounds.y * k;
    this.applyView();
  }

  render(state: CanvasState): void {
    this.state = state;
    const byId = new Map(state.nodes.map((node) => [node.id, node]));
    const cycles = state.cycles;

    this.edgeLayer.replaceChildren();
    this.edgePaths = [];
    // Detours stack outwards in draw order; a forward edge never consumes a lane.
    let detourLane = 0;
    state.edges.forEach((edge, index) => {
      const from = byId.get(edge.from);
      const to = byId.get(edge.to);
      if (!from || !to) return;
      const route = routeEdge(from, to, state.nodes, undefined, detourLane);
      if (route.kind !== 'forward') detourLane += 1;
      const d = route.d;
      const bad = cycles.edgeKeys.has(edge.from + '\u0000' + edge.to);
      const group = svgEl('g', { class: edgeClass(route.kind, bad), 'data-index': index });
      const selected = state.selected?.kind === 'edge' && state.selected.index === index;
      if (selected) group.classList.add('dag-edge--selected');
      const title = svgEl('title');
      title.textContent = from.id + ' \u2192 ' + to.id + routeHint(route.kind);
      const hit = svgEl('path', { class: 'dag-edge-hit', d });
      const line = svgEl('path', {
        class: 'dag-edge-line',
        d,
        'marker-end': bad ? 'url(#dag-arrow-warn)' : 'url(#dag-arrow)',
      });
      group.setAttribute('role', 'button');
      group.setAttribute('tabindex', '0');
      group.setAttribute('aria-label',
        (bad ? '存在环的连线：' : '连线：') + from.id + ' 指向 ' + to.id + routeHint(route.kind));
      group.append(hit, line, title);
      this.edgeLayer.append(group);
      this.edgePaths.push({ line, hit });
    });

    this.nodeLayer.replaceChildren();
    this.groups.clear();
    for (const node of state.nodes) {
      const group = this.card(node, state);
      this.groups.set(node.id, group);
      this.nodeLayer.append(group);
    }
    this.applyView();
  }

  private card(node: DagNode, state: CanvasState): SVGGElement {
    const status = state.statuses.get(node.id) ?? 'pending';
    const bad = state.cycles.nodes.has(node.id);
    const selected = state.selected?.kind === 'node' && state.selected.id === node.id;
    const group = svgEl('g', {
      class: 'dag-node' + (bad ? ' dag-node--cycle' : '') + (selected ? ' dag-node--selected' : ''),
      transform: 'translate(' + (node.x ?? 0) + ' ' + (node.y ?? 0) + ')',
      'data-id': node.id,
      'data-status': status,
      role: 'button',
      tabindex: '0',
      'aria-label':
        '节点 ' + node.id + '：' + operationLabel(node.operation) +
        (node.model ? '，模型 ' + node.model : '') +
        (node.instruction ? '，说明 ' + truncate(node.instruction, 40) : '') +
        (bad ? '，位于环上' : ''),
    });
    const title = svgEl('title');
    title.textContent = [node.id, operationLabel(node.operation), node.model, node.instruction]
      .filter(Boolean)
      .join('\n');
    group.append(
      svgEl('rect', { class: 'dag-card', width: CARD.cardWidth, height: CARD.cardHeight, rx: 12 }),
      svgEl('rect', { class: 'dag-card-stripe', x: 0, y: 14, width: 4, height: CARD.cardHeight - 28, rx: 2 }),
      svgEl('circle', { class: 'dag-card-dot', cx: CARD.cardWidth - 18, cy: 20, r: 5 }),
    );
    const head = svgEl('text', { class: 'dag-card-op', x: 14, y: 30 });
    head.textContent = fitText(operationLabel(node.operation), 11);
    const model = svgEl('text', { class: 'dag-card-model', x: 14, y: 49 });
    model.textContent = node.model ? fitText(node.model, 24) : '\u672a\u7ed1\u5b9a\u6a21\u578b';
    const body = svgEl('text', { class: 'dag-card-instruction', x: 14, y: 67 });
    const lines = wrapText(node.instruction || '\u65e0\u8bf4\u660e', 22, 2);
    lines.forEach((line, index) => {
      const span = svgEl('tspan', { x: 14, dy: index === 0 ? 0 : 14 });
      span.textContent = line;
      body.append(span);
    });
    const statusText = svgEl('text', { class: 'dag-card-status', x: CARD.cardWidth - 18, y: 40, 'text-anchor': 'end' });
    statusText.textContent = STATUS_LABELS[status];
    group.append(
      head,
      model,
      body,
      statusText,
      svgEl('circle', { class: 'dag-port dag-port-in', cx: 0, cy: CARD.cardHeight / 2, r: 6 }),
      svgEl('circle', { class: 'dag-port dag-port-out', cx: CARD.cardWidth, cy: CARD.cardHeight / 2, r: 6 }),
      title,
    );
    return group;
  }

  private bind(): void {
    this.svg.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      const target = event.target as Element | null;
      const port = target?.closest('.dag-port-out') as SVGCircleElement | null;
      const card = target?.closest('.dag-node') as SVGGElement | null;
      const edge = target?.closest('.dag-edge') as SVGGElement | null;
      this.svg.setPointerCapture(event.pointerId);
      if (port && card) {
        this.drag = { kind: 'connect', from: card.dataset.id as string, pointerId: event.pointerId };
        this.svg.classList.add('dag-svg--connecting');
        event.preventDefault();
        return;
      }
      if (card) {
        const id = card.dataset.id as string;
        const node = this.state.nodes.find((item) => item.id === id);
        const point = this.project(event.clientX, event.clientY);
        this.drag = {
          kind: 'node',
          id,
          grabX: point.x,
          grabY: point.y,
          originX: node?.x ?? 0,
          originY: node?.y ?? 0,
          moved: false,
        };
        event.preventDefault();
        return;
      }
      if (edge) {
        this.handlers.onSelect({ kind: 'edge', index: Number(edge.dataset.index) });
        return;
      }
      this.drag = {
        kind: 'pan',
        startX: event.clientX,
        startY: event.clientY,
        viewX: this.view.x,
        viewY: this.view.y,
        moved: false,
      };
    });

    this.svg.addEventListener('pointermove', (event) => {
      const drag = this.drag;
      if (!drag) return;
      if (drag.kind === 'node') {
        const point = this.project(event.clientX, event.clientY);
        const x = Math.round(drag.originX + point.x - drag.grabX);
        const y = Math.round(drag.originY + point.y - drag.grabY);
        if (x !== drag.originX || y !== drag.originY) drag.moved = true;
        const group = this.groups.get(drag.id);
        if (group) group.setAttribute('transform', 'translate(' + x + ' ' + y + ')');
        const node = this.state.nodes.find((item) => item.id === drag.id);
        if (node) {
          node.x = x;
          node.y = y;
          this.refreshEdges();
        }
        return;
      }
      if (drag.kind === 'connect') {
        const source = this.state.nodes.find((node) => node.id === drag.from);
        if (!source) return;
        const point = this.project(event.clientX, event.clientY);
        this.guide.setAttribute(
          'd',
          'M' + (source.x ?? 0) + ' ' + ((source.y ?? 0) + CARD.cardHeight / 2) +
            ' C' + ((source.x ?? 0) + CARD.cardWidth + 60) + ' ' + ((source.y ?? 0) + CARD.cardHeight / 2) +
            ' ' + (point.x - 60) + ' ' + point.y + ' ' + point.x + ' ' + point.y,
        );
        const over = this.under(event)?.closest('.dag-node') as SVGGElement | null;
        for (const group of this.groups.values()) group.classList.remove('dag-node--drop');
        if (over && over.dataset.id !== drag.from) over.classList.add('dag-node--drop');
        return;
      }
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) drag.moved = true;
      this.view.x = drag.viewX + dx;
      this.view.y = drag.viewY + dy;
      this.applyView();
    });

    const finish = (event: PointerEvent): void => {
      const drag = this.drag;
      this.drag = null;
      if (this.svg.hasPointerCapture(event.pointerId)) this.svg.releasePointerCapture(event.pointerId);
      this.svg.classList.remove('dag-svg--connecting');
      this.guide.setAttribute('d', '');
      for (const group of this.groups.values()) group.classList.remove('dag-node--drop');
      if (!drag) return;
      if (drag.kind === 'node') {
        if (drag.moved) {
          const point = this.project(event.clientX, event.clientY);
          this.handlers.onMoveNode(drag.id, Math.round(drag.originX + point.x - drag.grabX), Math.round(drag.originY + point.y - drag.grabY));
        }
        this.handlers.onSelect({ kind: 'node', id: drag.id });
        return;
      }
      if (drag.kind === 'connect') {
        const target = this.under(event)?.closest('.dag-node') as SVGGElement | null;
        if (target && target.dataset.id && target.dataset.id !== drag.from) {
          this.handlers.onConnect(drag.from, target.dataset.id);
        }
        this.handlers.onSelect(null);
        return;
      }
      if (!drag.moved) this.handlers.onSelect(null);
    };
    this.svg.addEventListener('pointerup', finish);
    this.svg.addEventListener('pointercancel', finish);

    this.svg.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        this.zoomBy(Math.exp(-event.deltaY * 0.0015), event.clientX, event.clientY);
      },
      { passive: false },
    );

    this.svg.addEventListener('keydown', (event) => {
      const target = event.target as Element | null;
      if (target?.classList.contains('dag-node')) {
        this.handlers.onSelect({ kind: 'node', id: target.getAttribute('data-id') as string });
        return;
      }
      if (target?.classList.contains('dag-edge')) {
        this.handlers.onSelect({ kind: 'edge', index: Number(target.getAttribute('data-index')) });
      }
    });
  }
}

/**
 * Edge classes: the two detour shapes are styled apart from an ordinary edge, so a
 * cycle reads as a different kind of connection at a glance and not only in red.
 */
function edgeClass(kind: EdgeKind, bad: boolean): string {
  return 'dag-edge dag-edge--' + kind + (bad ? ' dag-edge--cycle' : '');
}

function routeHint(kind: EdgeKind): string {
  if (kind === 'self') return '（自环）';
  if (kind === 'back') return '（回边，从上方绕行）';
  return '';
}

function marker(id: string, headClass: string): SVGMarkerElement {
  const node = svgEl('marker', {
    id,
    viewBox: '0 0 10 10',
    refX: 9,
    refY: 5,
    markerWidth: 6,
    markerHeight: 6,
    orient: 'auto-start-reverse',
  });
  node.append(svgEl('path', { class: headClass, d: 'M0,1 L9,5 L0,9 z' }));
  return node;
}

/**
 * Edge routing for a card pair. The geometry lives in dag-model so it is testable
 * without a DOM; this stays exported because it is the canvas's public shape.
 */
export function edgePath(from: DagNode, to: DagNode, obstacles: DagNode[] = [from, to]): string {
  return routeEdge(from, to, obstacles).d;
}
