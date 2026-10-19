/**
 * Pure graph core for the workflow DAG canvas.
 *
 * Everything here is deterministic: no clock, no randomness, no DOM, no network.
 * Same input -> same output, which is what makes the unit tests meaningful and
 * what lets "organize layout" be replayed without shuffling the user's manual
 * positions on every render.
 *
 * Geometry convention: a layer is an execution *column*. x grows with the layer
 * index (left -> right is the run order), y grows with the position of a node
 * inside its column (parallel siblings).
 */

export interface DagNode {
  id: string;
  operation: string;
  model: string;
  instruction: string;
  /** Optional canvas position; absent until the backend persists one. */
  x?: number;
  y?: number;
}

export interface DagEdge {
  from: string;
  to: string;
}

export interface Point {
  x: number;
  y: number;
}

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type NodeStatus = 'pending' | 'running' | 'succeeded' | 'failed';

/** Localized labels for the operations memora's control plane accepts. */
export const OPERATION_LABELS: Readonly<Record<string, string>> = {
  summarize: '概括要点',
  organize_markdown: '整理 Markdown',
  classify: '判定分类',
  extract_relations: '抽取关联',
  analyze_records: '解读记录',
  verify: '核对证据',
  assess_memory: '评估记忆',
  extract_memories: '提炼长期记忆',
  build_cues: '摘要与检索线索',
  learning_plan: '学习路径与复习',
  retrieve: '统一证据召回',
  rerank: '相关性重排序',
  embed_index: '向量与全文索引',
};

export const OPERATION_IDS: readonly string[] = Object.keys(OPERATION_LABELS);

export const STATUS_LABELS: Readonly<Record<NodeStatus, string>> = {
  pending: '待运行',
  running: '运行中',
  succeeded: '已完成',
  failed: '失败',
};

/** An unknown operation keeps its raw id: a wrong label would hide a real problem. */
export function operationLabel(operation: string): string {
  return OPERATION_LABELS[operation] ?? operation;
}

/** Single-line, length-capped text for a card body. */
export function truncate(text: string, limit: number): string {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length <= limit ? flat : flat.slice(0, Math.max(0, limit - 1)) + '\u2026';
}

/** True for characters that render roughly one em wide (CJK, kana, full-width forms). */
const WIDE = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/;

/** Approximate display width in em units; SVG has no text metrics to ask. */
export function textUnits(text: string): number {
  let units = 0;
  for (const char of String(text ?? '')) units += WIDE.test(char) ? 1 : 0.5;
  return units;
}

/** Clip to a width budget, appending an ellipsis when anything was dropped. */
export function fitText(text: string, maxUnits: number): string {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (textUnits(flat) <= maxUnits) return flat;
  let units = 0;
  let out = '';
  for (const char of flat) {
    const next = units + textUnits(char);
    if (next > maxUnits - 0.5) break;
    units = next;
    out += char;
  }
  return out + '\u2026';
}

/**
 * Greedy wrap into at most `maxLines` lines.
 *
 * Latin runs stay whole (words are not split), wide characters break anywhere
 * because Chinese has no spaces. Overflow is folded into the last line.
 */
export function wrapText(text: string, maxUnits: number, maxLines: number): string[] {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!flat) return [''];
  const atoms: string[] = [];
  let latin = '';
  for (const char of flat) {
    if (WIDE.test(char) || char === ' ') {
      if (latin) { atoms.push(latin); latin = ''; }
      atoms.push(char);
    } else {
      latin += char;
    }
  }
  if (latin) atoms.push(latin);
  const lines: string[] = [];
  let line = '';
  for (const atom of atoms) {
    const candidate = line + atom;
    if (line && textUnits(candidate.trim()) > maxUnits) {
      lines.push(line.trim());
      line = atom === ' ' ? '' : atom;
    } else {
      line = candidate;
    }
  }
  if (line.trim()) lines.push(line.trim());
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = fitText(kept[maxLines - 1] + ' ' + lines.slice(maxLines).join(' '), maxUnits);
  return kept;
}

/** Stable identity for an edge. The graph contract carries no edge id. */
export function edgeKey(from: string, to: string): string {
  return from + '\u0000' + to;
}

export interface DagGraph {
  nodeIds: string[];
  outgoing: Map<string, string[]>;
  incoming: Map<string, string[]>;
  /** Edges with both endpoints known, de-duplicated, input order preserved. */
  edges: DagEdge[];
}

/** Adjacency built from a node/edge pair; edges with a dangling endpoint are dropped. */
export function buildGraph(nodes: DagNode[], edges: DagEdge[]): DagGraph {
  const nodeIds = (nodes ?? []).map((n) => n.id);
  const known = new Set(nodeIds);
  const outgoing = new Map<string, string[]>(nodeIds.map((id) => [id, []]));
  const incoming = new Map<string, string[]>(nodeIds.map((id) => [id, []]));
  const seen = new Set<string>();
  const kept: DagEdge[] = [];
  for (const edge of edges ?? []) {
    if (!edge || !known.has(edge.from) || !known.has(edge.to)) continue;
    const key = edgeKey(edge.from, edge.to);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push({ from: edge.from, to: edge.to });
    outgoing.get(edge.from)!.push(edge.to);
    incoming.get(edge.to)!.push(edge.from);
  }
  return { nodeIds, outgoing, incoming, edges: kept };
}

/** Iterative reachability restricted to `allowed`; no recursion, so deep graphs are safe. */
function reaches(graph: DagGraph, from: string, goal: string, allowed: Set<string>): boolean {
  if (from === goal) return allowed.has(from);
  const seen = new Set<string>([from]);
  const stack = [from];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    for (const next of graph.outgoing.get(id) ?? []) {
      if (!allowed.has(next) || seen.has(next)) continue;
      if (next === goal) return true;
      seen.add(next);
      stack.push(next);
    }
  }
  return false;
}

export interface CycleScan {
  /** Nodes on at least one cycle. */
  nodes: Set<string>;
  /** DFS back edges: removing all of them leaves an acyclic graph. */
  feedback: DagEdge[];
}

/**
 * Three-colour DFS over the graph, iterative so a deep chain cannot blow the stack.
 *
 * Three colours rather than "topological sort did not finish": that approximation
 * also swallows every node *downstream* of a cycle, which would paint far more of
 * the canvas red than the user's actual mistake. A grey back edge marks exactly the
 * nodes between the back edge's target and the node that closed it.
 *
 * The back edges double as a feedback arc set: dropping them is what lets the
 * layered layout make progress on a cyclic graph.
 */
export function scanCycles(graph: DagGraph): CycleScan {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>(graph.nodeIds.map((id) => [id, WHITE]));
  const nodes = new Set<string>();
  const feedback: DagEdge[] = [];
  for (const start of graph.nodeIds) {
    if (color.get(start) !== WHITE) continue;
    const stack: Array<{ id: string; next: number }> = [{ id: start, next: 0 }];
    color.set(start, GRAY);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const neighbours = graph.outgoing.get(frame.id) ?? [];
      if (frame.next >= neighbours.length) {
        color.set(frame.id, BLACK);
        stack.pop();
        continue;
      }
      const next = neighbours[frame.next];
      frame.next += 1;
      const state = color.get(next);
      if (state === GRAY) {
        let marking = false;
        for (const item of stack) {
          if (item.id === next) marking = true;
          if (marking) nodes.add(item.id);
        }
        nodes.add(next);
        feedback.push({ from: frame.id, to: next });
        continue;
      }
      if (state === WHITE) {
        color.set(next, GRAY);
        stack.push({ id: next, next: 0 });
      }
    }
  }
  return { nodes, feedback };
}

export interface CycleReport {
  /** Nodes on at least one cycle. */
  nodes: Set<string>;
  /** Every edge that lies on some cycle -- the set the canvas highlights. */
  edges: DagEdge[];
  /** `edgeKey` set for those edges, for cheap membership tests while highlighting. */
  edgeKeys: Set<string>;
  /** Minimal DFS back edges; dropping these is what makes layering terminate. */
  feedbackEdges: DagEdge[];
  /** `edgeKey` set for `feedbackEdges`. */
  feedbackEdgeKeys: Set<string>;
}

/** The neutral cycle report: nothing flagged. Used before any graph is loaded. */
export function emptyCycles(): CycleReport {
  return {
    nodes: new Set<string>(),
    edges: [],
    edgeKeys: new Set<string>(),
    feedbackEdges: [],
    feedbackEdgeKeys: new Set<string>(),
  };
}

/**
 * Locate the cycles a proposed edit would create.
 *
 * An edge u -> v lies on a cycle exactly when v can still reach u, so the highlight
 * set is derived from reachability rather than from the DFS back edges. The two
 * sets differ on purpose: highlighting wants every offending edge, while layering
 * only needs enough edges removed to become acyclic, and removing the back edges
 * alone keeps the rest of a cycle spread across columns instead of stacking it.
 */
export function detectCycles(nodes: DagNode[], edges: DagEdge[]): CycleReport {
  const graph = buildGraph(nodes, edges);
  const scan = scanCycles(graph);
  const closing = graph.edges.filter(
    (edge) => scan.nodes.has(edge.from) && scan.nodes.has(edge.to) && reaches(graph, edge.to, edge.from, scan.nodes),
  );
  return {
    nodes: scan.nodes,
    edges: closing,
    edgeKeys: new Set(closing.map((edge) => edgeKey(edge.from, edge.to))),
    feedbackEdges: scan.feedback,
    feedbackEdgeKeys: new Set(scan.feedback.map((edge) => edgeKey(edge.from, edge.to))),
  };
}
/**
 * Longest-path layering: layer(v) = max(layer(u) + 1) over every incoming edge.
 *
 * The `ignored` set is what guarantees termination -- callers pass the feedback
 * edge set from detectCycles(), which is exactly enough to make the graph acyclic.
 * Cycle nodes still receive a layer from their surviving in-edges, so they stay on
 * the canvas instead of collapsing into an undefined column.
 */
export function layerNodes(nodeIds: string[], edges: DagEdge[], ignored: Set<string>): Map<string, number> {
  const layers = new Map<string, number>(nodeIds.map((id) => [id, 0]));
  const usable = edges.filter(
    (edge) => layers.has(edge.from) && layers.has(edge.to) && !ignored.has(edgeKey(edge.from, edge.to)),
  );
  // A DAG settles within |V|-1 relaxation rounds; the bound is belt and braces.
  for (let round = 0; round < nodeIds.length; round += 1) {
    let changed = false;
    for (const edge of usable) {
      const candidate = (layers.get(edge.from) as number) + 1;
      if ((layers.get(edge.to) as number) < candidate) {
        layers.set(edge.to, candidate);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return layers;
}

/** Group node ids by layer, preserving input order inside each column. */
export function columnsOf(nodeIds: string[], layers: Map<string, number>): Map<number, string[]> {
  const columns = new Map<number, string[]>();
  for (const id of nodeIds) {
    const layer = layers.get(id) ?? 0;
    const bucket = columns.get(layer);
    if (bucket) bucket.push(id);
    else columns.set(layer, [id]);
  }
  return columns;
}

/**
 * Barycenter ordering: repeatedly place each node at the average position of its
 * neighbours in the adjacent column, alternating sweep direction. Only edges that
 * span exactly one column count -- a longer edge would otherwise drag a column's
 * whole ordering toward a column it is not adjacent to.
 *
 * `columns` is mutated in place and the id -> rank map is returned.
 */
export function orderColumns(
  graph: DagGraph,
  columns: Map<number, string[]>,
  rounds = 4,
): Map<string, number> {
  const rank = new Map<string, number>();
  for (const bucket of columns.values()) bucket.forEach((id, index) => rank.set(id, index));
  const layerOf = new Map<string, number>();
  for (const [layer, bucket] of columns) for (const id of bucket) layerOf.set(id, layer);
  const sweep = (direction: 1 | -1): void => {
    const layers = [...columns.keys()].sort((a, b) => (direction === 1 ? a - b : b - a));
    for (const layer of layers) {
      const bucket = columns.get(layer) as string[];
      const source = layer - direction;
      const scored = bucket.map((id, index) => {
        const all = (direction === 1 ? graph.incoming.get(id) : graph.outgoing.get(id)) ?? [];
        const positions = all.filter((n) => layerOf.get(n) === source).map((n) => rank.get(n) as number);
        const barycenter = positions.length > 0
          ? positions.reduce((sum, value) => sum + value, 0) / positions.length
          : (rank.get(id) as number);
        return { id, barycenter, index };
      });
      // Stable: equal barycenters keep their previous relative order.
      scored.sort((a, b) => a.barycenter - b.barycenter || a.index - b.index);
      const next = scored.map((entry) => entry.id);
      columns.set(layer, next);
      next.forEach((id, position) => rank.set(id, position));
    }
  };
  for (let round = 0; round < Math.max(1, rounds); round += 1) {
    sweep(1);
    sweep(-1);
  }
  return rank;
}

/**
 * Count edge crossings, column pair by column pair.
 *
 * Two edges between the same pair of adjacent columns cross exactly when their
 * endpoint ranks are in opposite order, so the count is the number of inverted pairs.
 * This is the objective the ordering phase minimises: barycenter suggests an order,
 * this measures whether it actually improved anything.
 */
export function countCrossings(graph: DagGraph, columns: Map<number, string[]>): number {
  const rank = new Map<string, number>();
  const layerOf = new Map<string, number>();
  for (const [layer, bucket] of columns) {
    bucket.forEach((id, index) => {
      rank.set(id, index);
      layerOf.set(id, layer);
    });
  }
  const pairs = new Map<number, Array<[number, number]>>();
  for (const [layer, bucket] of columns) {
    for (const id of bucket) {
      for (const to of graph.outgoing.get(id) ?? []) {
        const targetLayer = layerOf.get(to);
        if (targetLayer === undefined || targetLayer === layer) continue;
        // Key on the left column so every edge is counted against its own gap once.
        const left = layer < targetLayer ? layer : targetLayer;
        const pair: [number, number] = layer < targetLayer
          ? [rank.get(id) as number, rank.get(to) as number]
          : [rank.get(to) as number, rank.get(id) as number];
        const bucketPairs = pairs.get(left);
        if (bucketPairs) bucketPairs.push(pair);
        else pairs.set(left, [pair]);
      }
    }
  }
  let total = 0;
  for (const bucket of pairs.values()) {
    for (let i = 0; i < bucket.length; i += 1) {
      for (let j = i + 1; j < bucket.length; j += 1) {
        if ((bucket[i][0] - bucket[j][0]) * (bucket[i][1] - bucket[j][1]) < 0) total += 1;
      }
    }
  }
  return total;
}

/**
 * Adjacent-pair transposition, the local improvement the barycenter sweep cannot do.
 *
 * A barycenter average leaves a column at a fixed point where a pair of cards simply
 * wants swapping; trying every adjacent swap and keeping the ones that lower the
 * crossing count removes those. Progress is measured on the crossing count alone, so
 * the loop terminates instead of oscillating, and a swap that does not help is undone
 * (which is what keeps the result deterministic).
 */
export function transposeColumns(graph: DagGraph, columns: Map<number, string[]>, rounds = 4): number {
  let best = countCrossings(graph, columns);
  for (let round = 0; round < Math.max(0, rounds) && best > 0; round += 1) {
    let improved = false;
    for (const layer of [...columns.keys()].sort((a, b) => a - b)) {
      const bucket = columns.get(layer) as string[];
      for (let i = 0; i + 1 < bucket.length; i += 1) {
        const left = bucket[i];
        const right = bucket[i + 1];
        bucket[i] = right;
        bucket[i + 1] = left;
        const tried = countCrossings(graph, columns);
        if (tried < best) {
          best = tried;
          improved = true;
        } else {
          bucket[i] = left;
          bucket[i + 1] = right;
        }
      }
    }
    if (!improved) break;
  }
  return best;
}

/**
 * Row index per node: uniform pitch, then shifted so each column lines up with the
 * column that feeds it.
 *
 * Uniform pitch is what makes edge lengths uniform inside a layer. On its own it also
 * makes a three-card column sit opposite a one-card column with one row of slack at
 * each end, so the straight edge into the middle card becomes two rows long. Shifting
 * the whole column towards the centroid of its incoming neighbours fixes that without
 * ever breaking the uniform pitch -- every row stays an integer multiple of the pitch.
 */
export function assignRows(
  graph: DagGraph,
  columns: Map<number, string[]>,
): Map<string, number> {
  const rows = new Map<string, number>();
  const layerOf = new Map<string, number>();
  for (const [layer, bucket] of columns) for (const id of bucket) layerOf.set(id, layer);
  let lastCentre = 0;
  for (const layer of [...columns.keys()].sort((a, b) => a - b)) {
    const bucket = columns.get(layer) as string[];
    // Baseline: one row per card, in the order the ordering phase settled on.
    bucket.forEach((id, index) => rows.set(id, index));
    const parents: number[] = [];
    for (const id of bucket) {
      for (const parent of graph.incoming.get(id) ?? []) {
        if (layerOf.get(parent) === layer - 1 && rows.has(parent)) parents.push(rows.get(parent) as number);
      }
    }
    const target = parents.length > 0
      ? parents.reduce((sum, value) => sum + value, 0) / parents.length
      : lastCentre;
    const centre = (bucket.length - 1) / 2;
    if (bucket.length > 0) {
      const shift = Math.round(target - centre);
      if (shift !== 0) for (const id of bucket) rows.set(id, (rows.get(id) as number) + shift);
      lastCentre = centre + shift;
    }
  }
  return rows;
}

export interface LayoutOptions {
  cardWidth: number;
  cardHeight: number;
  columnGap: number;
  rowGap: number;
  originX: number;
  originY: number;
  orderRounds: number;
}

export const LAYOUT_DEFAULTS: LayoutOptions = {
  cardWidth: 224,
  cardHeight: 96,
  columnGap: 96,
  rowGap: 28,
  originX: 80,
  originY: 420,
  orderRounds: 4,
};

/** Uniform card pitch: the row stride the layout aims for, and the height of one empty row. */
export function rowPitch(config: LayoutOptions = LAYOUT_DEFAULTS): number {
  return config.cardHeight + config.rowGap;
}

/** Both axes present and finite; a half-written coordinate is not a placement. */
export function isPositioned(node: DagNode): boolean {
  return Number.isFinite(node.x) && Number.isFinite(node.y);
}

/**
 * Do the stored coordinates actually describe a layout?
 *
 * Deliberately stricter than "every node carries a number": a graph whose nodes were
 * all persisted at one single point carries coordinates that say nothing about where
 * anything belongs -- that is exactly the pile-at-the-origin the canvas must not paint.
 */
export function hasStoredLayout(nodes: DagNode[]): boolean {
  const list = nodes ?? [];
  if (list.length === 0) return false;
  if (list.length === 1) return isPositioned(list[0]);
  const distinct = new Set(list.map((node) => String(node.x ?? 0) + ',' + String(node.y ?? 0)));
  return distinct.size > 1;
}

/**
 * Decide between honouring the stored arrangement and laying the graph out.
 *
 * The rule (all three clauses are checked in order):
 *  1. No stored positions at all  -> lay out. This is the pile-at-the-origin case.
 *  2. Stored positions but no edges at all -> honour them; unconnected cards have no
 *     order to infer, so the arrangement the user dragged out is the only layout there is.
 *  3. Edges exist -> lay out unless at least one edge *source* carries a position.
 *     A source is the author's statement of run order; when none of them was ever
 *     placed, the coordinates in the store are leftovers rather than a layout.
 *
 * Clause 3 keeps hand-dragged graphs untouched on reload: every graph built by the
 * canvas has positioned sources (a fresh node is placed before it can gain an edge).
 */
export function shouldAutoLayout(nodes: DagNode[], edges: DagEdge[]): boolean {
  const list = nodes ?? [];
  if (list.length === 0) return false;
  if (!hasStoredLayout(list)) return true;
  const edgeList = edges ?? [];
  if (edgeList.length === 0) return false;
  const sources = new Set(edgeList.map((edge) => edge.from));
  return !list.some((node) => sources.has(node.id) && isPositioned(node));
}

export interface LayoutResult {
  positions: Map<string, Point>;
  layers: Map<string, number>;
  columns: Map<number, string[]>;
  cycleNodes: Set<string>;
  cycleEdges: DagEdge[];
  /** Highest layer index, -1 for an empty graph. */
  depth: number;
  /** Widest column, 0 for an empty graph. */
  width: number;
  /** Bounding box of the laid-out graph. */
  bounds: Bounds;
}

function boundsOf(nodes: DagNode[], positions: Map<string, Point>, config: LayoutOptions): Bounds {
  const points = nodes.map((node) => positions.get(node.id) ?? { x: node.x ?? 0, y: node.y ?? 0 });
  if (points.length === 0) return { x: config.originX, y: config.originY, width: 0, height: 0 };
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return {
    x,
    y,
    width: Math.max(...xs) + config.cardWidth - x,
    height: Math.max(...ys) + config.cardHeight - y,
  };
}

/** Share of the barycenter improvement that must survive; see layoutGraph. */
function tryPolish(graph: DagGraph, columns: Map<number, string[]>, rounds: number): number {
  orderColumns(graph, columns, rounds);
  return transposeColumns(graph, columns, Math.max(2, rounds));
}

/**
 * Longest-path layering + barycenter ordering (with a transposition polish and a
 * uniform-pitch row placement) -> canvas positions.
 *
 * Manual drag positions are never fed back in: the same node/edge pair always maps to
 * the same coordinates, which is what makes the result idempotent -- organising twice
 * in a row cannot move anything the second time, because the second call starts from
 * the same inputs as the first.
 */
export function layoutGraph(
  nodes: DagNode[],
  edges: DagEdge[],
  options: Partial<LayoutOptions> = {},
): LayoutResult {
  const config = { ...LAYOUT_DEFAULTS, ...options };
  const graph = buildGraph(nodes, edges);
  const cycles = detectCycles(nodes, edges);
  const layers = layerNodes(graph.nodeIds, graph.edges, cycles.feedbackEdgeKeys);
  const columns = columnsOf(graph.nodeIds, layers);
  // Order first, then polish: the barycenter pass is what puts related cards near each
  // other, the transposition pass is what removes the crossings an average cannot see.
  tryPolish(graph, columns, config.orderRounds);

  const rows = assignRows(graph, columns);
  const pitch = rowPitch(config);
  const lowest = rows.size > 0 ? Math.max(...rows.values()) : -1;
  const highest = rows.size > 0 ? Math.min(...rows.values()) : 0;
  // Centring uses the occupied band, not "how many rows the tallest column has": after
  // the per-column shift those two are no longer the same thing.
  const usedHeight = lowest >= 0 ? (lowest - highest) * pitch + config.cardHeight : 0;
  const startY = config.originY - usedHeight / 2 - highest * pitch;
  const positions = new Map<string, Point>();
  for (const [layer, bucket] of columns) {
    for (const id of bucket) {
      positions.set(id, {
        x: config.originX + layer * (config.cardWidth + config.columnGap),
        y: startY + (rows.get(id) ?? 0) * pitch,
      });
    }
  }
  return {
    positions,
    layers,
    columns,
    cycleNodes: cycles.nodes,
    cycleEdges: cycles.edges,
    depth: columns.size === 0 ? -1 : Math.max(...columns.keys()),
    width: columns.size === 0 ? 0 : Math.max(...[...columns.values()].map((bucket) => bucket.length)),
    bounds: boundsOf(nodes, positions, config),
  };
}

/**
 * Progress values for the "organize layout" transition, or a single 1 when the user
 * asked for reduced motion.
 *
 * The canvas reads prefers-reduced-motion, but the decision has to be testable without
 * a browser, so the schedule lives here as plain numbers: ease-out cubic, and exactly
 * [1] (one instantaneous frame, no animation) under reduced motion.
 */
export function organizeSchedule(reduced: boolean, durationMs = 320): number[] {
  if (reduced) return [1];
  const frames = Math.max(1, Math.round(durationMs / 16));
  const steps: number[] = [];
  for (let index = 1; index <= frames; index += 1) {
    steps.push(1 - (1 - index / frames) ** 3);
  }
  steps[steps.length - 1] = 1;
  return steps;
}

/** How an edge leaves and re-enters the cards it connects. */
export type EdgeKind = 'forward' | 'back' | 'self';

export interface EdgeRoute {
  /** SVG path data. */
  d: string;
  kind: EdgeKind;
}

/** Clearance used by every detour: card edge -> line -> corner arc. */
const ROUTE_GAP = 16;

/** One decimal at most; keeps the emitted path stable and diffable. */
function num(value: number): string {
  return String(Math.round(value * 10) / 10);
}

/**
 * Rounded orthogonal polyline.
 *
 * Corners are cut with a quadratic through the corner point, clamped to half of the
 * shorter adjacent segment so a tight corner cannot overshoot the run it belongs to.
 * Repeated points are dropped first, otherwise a zero-length segment would produce a
 * degenerate control point.
 */
export function orthPath(points: Point[], radius: number): string {
  const cleaned: Point[] = [];
  for (const point of points) {
    const last = cleaned[cleaned.length - 1];
    if (last && Math.abs(last.x - point.x) < 0.001 && Math.abs(last.y - point.y) < 0.001) continue;
    cleaned.push(point);
  }
  if (cleaned.length === 0) return '';
  if (cleaned.length < 3 || radius <= 0) {
    return 'M' + cleaned.map((point) => num(point.x) + ' ' + num(point.y)).join(' L');
  }
  let d = 'M' + num(cleaned[0].x) + ' ' + num(cleaned[0].y);
  for (let index = 1; index < cleaned.length - 1; index += 1) {
    const previous = cleaned[index - 1];
    const corner = cleaned[index];
    const next = cleaned[index + 1];
    const inLength = Math.hypot(corner.x - previous.x, corner.y - previous.y);
    const outLength = Math.hypot(next.x - corner.x, next.y - corner.y);
    const cut = Math.min(radius, inLength / 2, outLength / 2);
    if (cut <= 0.001) {
      d += ' L' + num(corner.x) + ' ' + num(corner.y);
      continue;
    }
    const inUnit = { x: (corner.x - previous.x) / inLength, y: (corner.y - previous.y) / inLength };
    const outUnit = { x: (next.x - corner.x) / outLength, y: (next.y - corner.y) / outLength };
    d += ' L' + num(corner.x - inUnit.x * cut) + ' ' + num(corner.y - inUnit.y * cut);
    d += ' Q' + num(corner.x) + ' ' + num(corner.y) + ' ' + num(corner.x + outUnit.x * cut) + ' ' + num(corner.y + outUnit.y * cut);
  }
  const last = cleaned[cleaned.length - 1];
  d += ' L' + num(last.x) + ' ' + num(last.y);
  return d;
}

/**
 * Route one edge between two cards.
 *
 * Three shapes, chosen by geometry rather than by graph theory, because what has to be
 * legible is the drawing:
 *
 *  - **forward** (the target starts to the right of the source): a plain cubic out of
 *    the right port into the left port. Straight lines through the gap are what make a
 *    layered graph readable, so ordinary edges stay ordinary.
 *  - **back** (the target sits left of -- or barely right of -- the source): the edge
 *    would otherwise be a single line driven straight through both cards. It instead
 *    leaves the right port, climbs above every card in the graph, runs back over the
 *    top and comes down into the target's left port. Nothing it crosses is a card.
 *  - **self** (both endpoints are the same card): out of the right port, up over the
 *    top and back into the left port, so the loop is a visible ring rather than a dot.
 *
 * `obstacles` is every node on the canvas: the detour is placed above the highest one,
 * which is the only way to guarantee it clears columns it does not belong to.
 */
export function routeEdge(
  from: DagNode,
  to: DagNode,
  obstacles: DagNode[] = [from, to],
  config: LayoutOptions = LAYOUT_DEFAULTS,
  lane = 0,
): EdgeRoute {
  const width = config.cardWidth;
  const height = config.cardHeight;
  const fromX = from.x ?? 0;
  const fromY = from.y ?? 0;
  const toX = to.x ?? 0;
  const toY = to.y ?? 0;
  const sx = fromX + width;
  const sy = fromY + height / 2;
  const tx = toX;
  const ty = toY + height / 2;
  const topOf = (nodes: DagNode[]): number => {
    let top = Math.min(fromY, toY);
    for (const node of nodes) top = Math.min(top, node.y ?? 0);
    return top;
  };

  // Each detour gets its own height band so two back edges never collapse onto one line;
  // the lane is passed by the renderer from the edge's index, never guessed in here.
  const band = (index: number): number => ROUTE_GAP * 2 + (index % 4) * (ROUTE_GAP - 4);

  if (from.id === to.id) {
    const ceiling = fromY - band(lane);
    const right = sx + ROUTE_GAP;
    const left = fromX;
    return {
      kind: 'self',
      d: orthPath(
        [
          { x: sx, y: sy },
          { x: right, y: sy },
          { x: right, y: ceiling },
          { x: left - ROUTE_GAP, y: ceiling },
          { x: left - ROUTE_GAP, y: ty },
          { x: tx, y: ty },
        ],
        ROUTE_GAP,
      ),
    };
  }

  if (tx - sx >= 32) {
    const bend = (tx - sx) / 2;
    return {
      kind: 'forward',
      d: 'M' + num(sx) + ',' + num(sy) +
        ' C' + num(sx + bend) + ',' + num(sy) + ' ' + num(tx - bend) + ',' + num(ty) + ' ' + num(tx) + ',' + num(ty),
    };
  }

  const ceiling = topOf(obstacles) - band(lane);
  const exit = sx + ROUTE_GAP;
  const entry = tx - ROUTE_GAP;
  return {
    kind: 'back',
    d: orthPath(
      [
        { x: sx, y: sy },
        { x: exit, y: sy },
        { x: exit, y: ceiling },
        { x: entry, y: ceiling },
        { x: entry, y: ty },
        { x: tx, y: ty },
      ],
      ROUTE_GAP,
    ),
  };
}

/** Convenience wrapper: the path data alone. */
export function edgePathBetween(
  from: DagNode,
  to: DagNode,
  obstacles: DagNode[] = [from, to],
  config: LayoutOptions = LAYOUT_DEFAULTS,
  lane = 0,
): string {
  return routeEdge(from, to, obstacles, config, lane).d;
}

/** Bounding box of whatever positions the nodes currently carry (manual or laid out). */
export function graphBounds(nodes: DagNode[], config: LayoutOptions = LAYOUT_DEFAULTS): Bounds {
  const positions = new Map<string, Point>();
  for (const node of nodes) {
    positions.set(node.id, { x: node.x ?? config.originX, y: node.y ?? config.originY });
  }
  return boundsOf(nodes, positions, config);
}

/** Would adding from -> to close a cycle in the current graph? Pure check, no mutation. */
export function wouldCycle(nodes: DagNode[], edges: DagEdge[], from: string, to: string): boolean {
  if (from === to) return true;
  const graph = buildGraph(nodes, edges);
  return reaches(graph, to, from, new Set(graph.nodeIds));
}

export interface RunLike {
  id?: string;
  workflow?: string;
  status?: string;
  updated?: string;
  output?: { stages?: Array<{ stage?: string; operation?: string }> };
}

/**
 * Per-node status overlay derived from the workflow-runs feed.
 *
 * The executor walks a workflow\u2019s stages in declared order, so a live run has
 * exactly one active stage: the first node in declaration order that the run trace
 * has not recorded yet. A terminal run paints its recorded stages succeeded and the
 * rest failed (or succeeded, for a run that completed).
 */
export function nodeStatuses(runs: RunLike[], workflowId: string, nodes: DagNode[]): Map<string, NodeStatus> {
  const order = nodes.map((node) => node.id);
  const statuses = new Map<string, NodeStatus>(order.map((id) => [id, 'pending' as NodeStatus]));
  const run = (runs ?? []).find((item) => item && item.workflow === workflowId);
  if (!run) return statuses;
  const finished = new Set(
    (Array.isArray(run.output?.stages) ? run.output.stages : [])
      .map((stage) => String(stage?.stage ?? ''))
      .filter((id) => id !== ''),
  );
  const live = run.status === 'running';
  const failed = run.status !== 'done';
  const active = live ? order.find((id) => !finished.has(id)) : undefined;
  for (const id of order) {
    if (id === active) {
      statuses.set(id, 'running');
    } else if (finished.has(id)) {
      statuses.set(id, 'succeeded');
    } else {
      statuses.set(id, live ? 'pending' : failed ? 'failed' : 'succeeded');
    }
  }
  return statuses;
}
