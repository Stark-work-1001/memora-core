/**
 * 数据层：/api/graph 拉取 + 规范化 + 内置演示数据。
 *
 * 契约见 docs/ARCHITECTURE.md §5：
 *   GET /api/graph?view=semantic|hierarchy|timeline|evidence&scope&limit
 *   → { nodes, edges, meta }
 *
 * 后端可能还没起来（T5/T6 并行开发中），也可能字段拼写略有出入，
 * 所以这里做两件事：
 *   1. 规范化：把 src/source/from、dst/target/to、label/title/name 等常见别名收敛到
 *      统一模型（BrainNode/BrainEdge），渲染层只认规范化后的模型。
 *   2. 兜底：请求失败、返回空图、字段完全对不上时，用内置演示数据渲染，
 *      并把 graph.demo 置 true —— 界面显示"演示数据"水印，绝不假装是真数据。
 */
import { kindColor } from './nodes';
import type {
  BrainEdge, BrainGraph, BrainNode, GraphMeta, RawEdge, RawGraph, RawNode, ViewKind,
} from './types';

/** 关系词表（schema.sql 的 edge.rel）。用于判断字段是否对得上契约。 */
const KNOWN_RELS = new Set([
  'semantic', 'hypernym', 'hyponym', 'part_of', 'instance_of', 'causes', 'contradicts',
  'supports', 'supersedes', 'derived_from', 'mentions', 'temporal_next', 'alias', 'prerequisite',
  // store.graph 的结构关系（层级 / 时间线 / 证据视图）
  'contains', 'in_scope', 'evidence', 'document', 'chunk',
]);

/** 从若干候选字段里取第一个非空字符串。 */
function pickString(raw: RawNode | RawEdge, keys: string[], fallback = ''): string {
  for (const key of keys) {
    const value = (raw as Record<string, unknown>)[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number') return String(value);
  }
  return fallback;
}

/** 从若干候选字段里取第一个有限数字。 */
function pickNumber(raw: RawNode | RawEdge, keys: string[], fallback = 0): number {
  for (const key of keys) {
    const value = (raw as Record<string, unknown>)[key];
    if (typeof value === 'number' && isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() && isFinite(Number(value))) return Number(value);
  }
  return fallback;
}

/** 时间字符串/数字 → 毫秒时间戳（0 表示无时间）。 */
function pickTime(raw: RawNode): number {
  for (const key of ['time', 'recorded_at', 'created_at', 'valid_from', 'updated_at']) {
    const value = (raw as Record<string, unknown>)[key];
    if (typeof value === 'number' && isFinite(value)) {
      // 秒级时间戳（10 位）自动升级成毫秒
      return value < 1e12 ? value * 1000 : value;
    }
    if (typeof value === 'string' && value.trim()) {
      const parsed = Date.parse(value);
      if (!Number.isNaN(parsed)) return parsed;
    }
  }
  return 0;
}

/** 节点标题裁剪：超过 24 个字符截断（中文按字符算）。 */
function trimLabel(text: string, max = 24): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return clean.slice(0, max - 1) + '…';
}

/**
 * 规范化图数据。
 *
 * @param raw   /api/graph 的原始 JSON
 * @param view  当前视图（写入结果，避免渲染层再传一遍）
 */
export function normalizeGraph(raw: RawGraph, view: ViewKind): BrainGraph {
  const rawNodes: RawNode[] = Array.isArray(raw.nodes) ? raw.nodes : [];
  const nodes: BrainNode[] = [];
  const idMap = new Map<string, string>();
  for (let i = 0; i < rawNodes.length; i++) {
    const node = rawNodes[i];
    const id = pickString(node, ['id', 'node_id', 'key'], 'node-' + i);
    if (idMap.has(id)) continue;
    idMap.set(id, id);
    const label = trimLabel(pickString(node, ['label', 'title', 'name', 'summary'], id));
    const kind = pickString(node, ['kind', 'type', 'category'], 'default');
    const scope = pickString(node, ['scope', 'scope_id', 'workspace'], '');
    nodes.push({
      id,
      label,
      kind,
      scope,
      degree: pickNumber(node, ['degree', 'weight', 'in_degree', 'connections'], 0),
      importance: clamp01(pickNumber(node, ['importance', 'weight', 'score'], 0.5)),
      time: pickTime(node),
      parent: pickString(node, ['parent', 'parent_id', 'group'], '') || null,
    });
  }

  const rawEdges: RawEdge[] = Array.isArray(raw.edges) ? raw.edges : [];
  const edges: BrainEdge[] = [];
  const seen = new Set<string>();
  const degree = new Map<string, number>();
  for (let i = 0; i < rawEdges.length; i++) {
    const edge = rawEdges[i];
    const src = pickString(edge, ['src', 'source', 'from', 'a']);
    const dst = pickString(edge, ['dst', 'target', 'to', 'b']);
    if (!src || !dst || src === dst) continue;
    if (!idMap.has(src) || !idMap.has(dst)) continue;
    const rel = pickString(edge, ['rel', 'relation', 'type', 'kind'], 'semantic');
    const key = src + '|' + dst + '|' + rel;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({
      id: pickString(edge, ['id', 'edge_id'], 'e' + i),
      src,
      dst,
      rel,
      weight: clamp01(pickNumber(edge, ['weight', 'strength', 'score'], 0.6)),
      confidence: clamp01(pickNumber(edge, ['confidence'], 0.5)),
    });
    degree.set(src, (degree.get(src) ?? 0) + 1);
    degree.set(dst, (degree.get(dst) ?? 0) + 1);
  }
  // 后端没给 degree 时按边表补上（渲染节点大小要用）
  for (const node of nodes) {
    const computed = degree.get(node.id) ?? 0;
    if (!node.degree) node.degree = computed;
    else node.degree = Math.max(node.degree, computed);
  }

  const meta: GraphMeta = (raw.meta && typeof raw.meta === 'object') ? { ...(raw.meta as GraphMeta) } : {};
  // 关系词表自检：完全对不上时，说明后端可能换了字段名，标记出来供 UI 提示
  const relsOk = edges.length === 0 || edges.some((e) => KNOWN_RELS.has(e.rel));
  if (!relsOk) meta.unknownRelations = true;

  return { view, nodes, edges, meta, demo: false };
}

function clamp01(value: number): number {
  if (!isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/** 拉取结果。 */
export interface FetchOutcome {
  graph: BrainGraph;
  /** 失败原因（成功时为 null）。 */
  error: string | null;
  /** 从请求到拿到数据的毫秒数。 */
  tookMs: number;
}

/**
 * 拉取 /api/graph。
 *
 * 失败不抛：返回演示数据 + error，让界面能画出东西并明确标注。
 * 3.5s 超时：本地回环都拿不到就说明后端没起，继续等只会让用户看着空白。
 */
export async function fetchGraph(view: ViewKind, scope: string, limit = 2000): Promise<FetchOutcome> {
  const started = performance.now();
  const params = new URLSearchParams({ view, limit: String(limit) });
  if (scope) params.set('scope', scope);
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), 3500) : null;
  try {
    const response = await fetch('/api/graph?' + params.toString(), {
      headers: { Accept: 'application/json' },
      signal: controller?.signal,
    });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const raw = (await response.json()) as RawGraph;
    const graph = normalizeGraph(raw, view);
    if (!graph.nodes.length) throw new Error('图数据为空');
    return { graph, error: null, tookMs: performance.now() - started };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      graph: demoGraph(view, 460),
      error: reason,
      tookMs: performance.now() - started,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* ==================================================================== *
 * 演示数据
 *
 * 目标不是"随便画几个点"，而是让四种视图各自都能看出结构：
 *  - 词义网络：几个主题簇 + 跨簇的语义边（能看出社区结构）
 *  - 层级：三棵有真实深度的树（概念 → 子概念 → 例子）
 *  - 时间线：跨 40 天、分布不均的记忆
 *  - 证据：记忆 → 证据 → 来源 三层，来源被多条证据共享（能看出汇聚）
 * ==================================================================== */

/** 演示主题（名称都跟记忆中枢自己的领域相关，读起来像真的）。 */
const DEMO_TOPICS: Array<{ name: string; kind: string; children: string[] }> = [
  {
    name: '记忆召回', kind: 'concept',
    children: ['混合检索', 'RRF 融合', '预算打包', '重排序', 'MMR 去冗余', '作用域继承'],
  },
  {
    name: '证据与信任', kind: 'concept',
    children: ['证据类型', '信任权重', '交叉验证', '冲突检测', '来源核验', '引用片段'],
  },
  {
    name: '智能体协作', kind: 'concept',
    children: ['MCP 协议', '会话生命周期', '心跳探针', '任务委派', '共享工作区', '写入确认'],
  },
  {
    name: '工作流引擎', kind: 'concept',
    children: ['DAG 执行器', '节点处理器', '降级策略', '步骤记录', '重试语义', '触发条件'],
  },
  {
    name: '文档与切块', kind: 'concept',
    children: ['语义切块', '标题树', '代码块识别', '公式解析', '索引重建', '原路径保留'],
  },
];

const DEMO_KINDS = ['fact', 'knowledge', 'decision', 'preference', 'procedure', 'experience', 'task'];

/**
 * 生成演示图。
 * @param count 目标节点数（含记忆/证据/来源三层）
 */
export function demoGraph(view: ViewKind, count = 460): BrainGraph {
  const nodes: BrainNode[] = [];
  const edges: BrainEdge[] = [];
  const now = Date.now();

  // 1) 概念层：主题 → 子概念 → 例子（层级视图的核心结构）
  const conceptIds: string[] = [];
  const childIds: string[] = [];
  DEMO_TOPICS.forEach((topic, ti) => {
    const id = 'concept-' + ti;
    conceptIds.push(id);
    nodes.push({
      id, label: topic.name, kind: 'concept', scope: 'workspace:memora',
      degree: 0, importance: 0.9, time: now - (ti + 1) * 86400000 * 3, parent: null,
    });
    topic.children.forEach((child, ci) => {
      const cid = 'concept-' + ti + '-' + ci;
      childIds.push(cid);
      nodes.push({
        id: cid, label: child, kind: 'term', scope: 'workspace:memora',
        degree: 0, importance: 0.55, time: now - (ti * 6 + ci * 3 + 2) * 86400000,
        parent: id,
      });
      edges.push({ id: 'h-' + cid, src: id, dst: cid, rel: 'hyponym', weight: 0.8, confidence: 0.9 });
    });
  });

  // 2) 来源层：少量共享来源，让证据视图有汇聚感
  const sourceNames = [
    'docs/ARCHITECTURE.md', 'tools/control.py', 'tests/unit/test_retrieval.py',
    '会话记录 2024-11-05', '官方 MCP 规范', '用户口述', '运行日志 run#118',
  ];
  const sourceIds = sourceNames.map((name, i) => {
    const id = 'src-' + i;
    nodes.push({
      id, label: name, kind: 'source', scope: 'global',
      degree: 0, importance: 0.35, time: now - (10 + i) * 86400000, parent: null,
    });
    return id;
  });

  // 3) 记忆层：按剩余预算铺开，挂到子概念下（层级视图有真实深度）
  const memoryTarget = Math.max(60, Math.floor((count - nodes.length) * 0.62));
  const relationPool = ['semantic', 'supports', 'derived_from', 'causes', 'contradicts', 'prerequisite', 'mentions'];
  const memoryIds: string[] = [];
  let seed = 20240517;
  const rnd = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < memoryTarget; i++) {
    const id = 'mem-' + i;
    memoryIds.push(id);
    const parent = childIds[Math.floor(rnd() * childIds.length)];
    const kind = DEMO_KINDS[Math.floor(rnd() * DEMO_KINDS.length)];
    nodes.push({
      id, label: shortMemoryLabel(i, kind),
      kind, scope: 'workspace:memora',
      degree: 0, importance: 0.25 + rnd() * 0.6,
      // 时间线：40 天跨度，分布不均（近几天更密，像真实使用）
      time: now - Math.floor(Math.pow(rnd(), 1.8) * 40) * 86400000 - Math.floor(rnd() * 86400000),
      parent,
    });
    edges.push({
      id: 'pe-' + i, src: parent, dst: id, rel: 'mentions',
      weight: 0.4 + rnd() * 0.4, confidence: 0.6,
    });
    // 语义边：让主图出现社区结构而不是一棵树
    const links = 1 + Math.floor(rnd() * 3);
    for (let k = 0; k < links; k++) {
      const target = memoryIds[Math.floor(rnd() * Math.max(1, memoryIds.length - 1))];
      if (!target || target === id) continue;
      edges.push({
        id: 'se-' + i + '-' + k, src: id, dst: target,
        rel: relationPool[Math.floor(rnd() * relationPool.length)],
        weight: 0.25 + rnd() * 0.7, confidence: 0.4 + rnd() * 0.5,
      });
    }
  }

  // 4) 证据层：每条记忆挂 1–3 条证据，证据挂到共享来源
  const evidenceTarget = Math.max(40, count - nodes.length - 8);
  for (let i = 0; i < evidenceTarget; i++) {
    const id = 'ev-' + i;
    const owner = memoryIds[Math.floor(rnd() * memoryIds.length)];
    const source = sourceIds[Math.floor(rnd() * sourceIds.length)];
    const kindPool = ['user_stated', 'agent_asserted', 'tool_output', 'document', 'web', 'verification'];
    nodes.push({
      id, label: '证据 ' + (i + 1) + ' · ' + kindShort(kindPool[Math.floor(rnd() * kindPool.length)]),
      kind: 'evidence', scope: 'workspace:memora',
      degree: 0, importance: 0.3 + rnd() * 0.3,
      time: now - Math.floor(rnd() * 40) * 86400000,
      parent: owner,
    });
    edges.push({ id: 'ev-e-' + i, src: owner, dst: id, rel: 'evidence_for', weight: 0.7, confidence: 0.8 });
    edges.push({ id: 'ev-s-' + i, src: id, dst: source, rel: 'derived_from', weight: 0.6, confidence: 0.7 });
  }

  // 度统计（演示数据也要算，节点大小才合理）
  const degree = new Map<string, number>();
  for (const edge of edges) {
    degree.set(edge.src, (degree.get(edge.src) ?? 0) + 1);
    degree.set(edge.dst, (degree.get(edge.dst) ?? 0) + 1);
  }
  for (const node of nodes) node.degree = degree.get(node.id) ?? 0;

  return {
    view,
    nodes,
    edges,
    meta: { total: nodes.length, source: 'demo', generatedAt: Date.now() },
    demo: true,
  };
}

/** 演示记忆标题（按 kind 造句，读起来像真实记忆条目）。 */
function shortMemoryLabel(index: number, kind: string): string {
  const pools: Record<string, string[]> = {
    fact: ['SQLite 是事务真源', 'Markdown 是可读镜像', '向量维度固定 256', 'WAL 模式下并发读安全'],
    knowledge: ['BM25 与向量分数的量纲不同', 'RRF 只依赖排名', '图召回沿边扩散 2 跳', '重排模型吃 cross-encoder'],
    decision: ['选择标准库实现后端', '脑图用 three.js 而非 canvas2d', '降级必须可观测', '工作流节点缺失记为 noop'],
    preference: ['用户强调中文文案', '偏好深色界面', '拒绝伪造成功状态', '导出要能直接分享'],
    procedure: ['先切块再入库', '导入后重建索引', '审核后写镜像', '冲突先标记录后裁决'],
    experience: ['5000 节点必须走实例化', '标签避让要在像素空间做', 'BH 近似误差 10% 量级', '布局放 Worker 不卡 UI'],
    task: ['补齐脑图四视图', '接入 MCP HTTP 传输', '实现复习 SM-2', '完成离线降级矩阵'],
  };
  const pool = pools[kind] ?? pools.fact;
  return pool[index % pool.length] + ' #' + (index + 1);
}

/** 证据类型短名。 */
function kindShort(kind: string): string {
  const map: Record<string, string> = {
    user_stated: '用户陈述', agent_asserted: '智能体断言', tool_output: '工具输出',
    document: '文档', web: '网页', verification: '核验', derived: '推导', code_run: '代码运行',
  };
  return map[kind] ?? kind;
}

/** 演示图里出现过的 kind → 颜色（图例用）。 */
export function colorsForKinds(kinds: Iterable<string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const kind of kinds) out[kind] = kindColor(kind);
  out.default = kindColor('default');
  return out;
}
