/**
 * T8 2D/3D 记忆脑图 — 共享类型。
 *
 * 数据来源是 GET /api/graph?view=semantic|hierarchy|timeline|evidence，契约见
 * docs/ARCHITECTURE.md §5 / §7：{ nodes, edges, meta }。后端尚未落地时字段拼写
 * 可能有出入，所以这里同时提供"宽松入参"与"规范化模型"两层：
 *
 *   RawGraph  —— 线上原样 JSON（字段可有可无）
 *   BrainGraph—— 规范化后的图（视图、布局、渲染只认这一层）
 *
 * 词表来自 memora_core/data/schema.sql 的 memory / evidence / entity / edge 表：
 *   node.kind ∈ memory.kind | entity.kind | 'evidence' | 'source' | 'document'
 *   edge.rel  ∈ semantic|hypernym|hyponym|part_of|instance_of|causes|contradicts|
 *               supports|supersedes|derived_from|mentions|temporal_next|alias|prerequisite
 */

/** 四种脑图视图。 */
export type ViewKind = 'semantic' | 'hierarchy' | 'timeline' | 'evidence';

/** 投影方式：hierarchy 支持 2D（正交）/ 3D（径向）。 */
export type Projection = '2d' | '3d';

/** 线上原样节点（宽松）。 */
export interface RawNode {
  id?: string;
  label?: string;
  title?: string;
  name?: string;
  kind?: string;
  type?: string;
  scope?: string;
  scope_id?: string;
  degree?: number;
  importance?: number;
  weight?: number;
  time?: string | number;
  recorded_at?: string;
  created_at?: string;
  valid_from?: string;
  parent?: string;
  parent_id?: string;
  group?: string;
  layer?: number;
  [key: string]: unknown;
}

/** 线上原样边（宽松）。 */
export interface RawEdge {
  id?: string;
  src?: string;
  source?: string;
  from?: string;
  dst?: string;
  target?: string;
  to?: string;
  rel?: string;
  relation?: string;
  type?: string;
  weight?: number;
  confidence?: number;
  [key: string]: unknown;
}

/** 线上原样 payload。 */
export interface RawGraph {
  view?: string;
  nodes?: RawNode[];
  edges?: RawEdge[];
  meta?: Record<string, unknown>;
  [key: string]: unknown;
}

/** 规范化节点。 */
export interface BrainNode {
  /** 稳定 id，用于索引、拾取、路径查找。 */
  id: string;
  /** 显示名（截断后的短标签）。 */
  label: string;
  /** 语义类别：memory.kind / entity.kind / evidence / source。用于上色与图例。 */
  kind: string;
  /** 作用域 id（global / workspace:x / agent:y ...）。用于过滤。 */
  scope: string;
  /** 布局输入：度（后端口径，缺失时前端按边统计）。 */
  degree: number;
  /** 布局输入：重要性 0..1。 */
  importance: number;
  /** 布局输入：时间戳 ms（0 表示无时间）。 */
  time: number;
  /** 层级视图的父节点 id（可为空）。 */
  parent: string | null;
}

/** 规范化边。 */
export interface BrainEdge {
  id: string;
  src: string;
  dst: string;
  /** 关系类型，决定边的颜色。 */
  rel: string;
  /** 0..1，决定透明度与布局权重。 */
  weight: number;
  confidence: number;
}

/** 图元信息（统计、是否被截断、生成时间）。 */
export interface GraphMeta {
  total?: number;
  truncated?: boolean;
  generatedAt?: number;
  source?: string;
  [key: string]: unknown;
}

/** 规范化图。 */
export interface BrainGraph {
  view: ViewKind;
  nodes: BrainNode[];
  edges: BrainEdge[];
  meta: GraphMeta;
  /** true 表示后端不可用、正在渲染内置演示数据（界面显示水印）。 */
  demo: boolean;
}

/** 布局结果：统一用 count*3 的 Float32Array。 */
export interface LayoutResult {
  positions: Float32Array;
  /** 实际使用的维度：层次 2D = 2，其余 3。渲染时 z 为 0 即正交。 */
  dims: 2 | 3;
  meta: {
    /** 力导向每轮能量（仅 semantic）。 */
    energy?: number[];
    /** 布局跨度半径，用于相机 fit。 */
    radius: number;
    /** 层次/时间线/证据的包围盒。 */
    bounds?: { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number };
    [key: string]: unknown;
  };
}

/** 布局用的最小节点形状（避免 layout 依赖渲染字段）。 */
export interface LayoutNode {
  id: string;
  degree: number;
  importance: number;
  time: number;
  kind: string;
  parent: string | null;
  layer?: number;
}

/** 布局用的最小边形状。 */
export interface LayoutEdge {
  src: string;
  dst: string;
  weight: number;
}

/** 视图一次的渲染状态（主线程持有，各图层只读）。 */
export interface RenderState {
  graph: BrainGraph;
  /** 布局坐标（count*3）。 */
  positions: Float32Array;
  /** 叠加了选中外推的渲染坐标（count*3），节点与边共用。 */
  renderPositions: Float32Array;
  /** id -> 索引。 */
  index: Map<string, number>;
  /** 邻接表（索引）。 */
  neighbors: number[][];
  dims: 2 | 3;
}
