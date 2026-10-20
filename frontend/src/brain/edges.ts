/**
 * 边层：所有边合成**一个** LineSegments（一次 draw call），弯曲与俯仰补偿在顶点着色器里算。
 *
 * 为什么不是每条边一根 Line：
 *   5000 节点 × 平均 3 条边 = 15000 条边，一根一个 draw call 直接判死刑。
 *   这里预分配 (maxEdges × SEGMENTS × 2) 个顶点，每条边展开成 SEGMENTS 段折线
 *   （每段两个端点），属性里只存端点 A/B 相同，弯曲参数在 GPU 端按 t 求值。
 *
 * 为什么在 GPU 里弯（参考实现 edge-flex.ts 的思路，但换成着色器）：
 *   一条边如果正对着相机，它在屏幕上是零长度的一个点。要让它"可见"就必须沿垂直于
 *   视线方向弓出去。这个方向依赖 cameraPosition（three 的内建 uniform），每帧都在变；
 *   放在 CPU 里算就是每帧重写 15000 条边的位置属性，白白吃 CPU 预算。
 *   放进顶点着色器后 CPU 侧每帧零成本，相机怎么转都成立。
 *
 * 淡出：视线方向与边方向的夹角越大（边越"侧对"屏幕），越接近正对相机时反而更该弯；
 *      同时按距离做雾化淡出，避免远处糊成一片噪点。
 */
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  LineBasicMaterial,
  LineSegments,
  ShaderMaterial,
  Vector3,
} from 'three';
import type { BrainGraph } from './types';

/** 每条边拆成多少段（越大越圆滑，顶点数 = SEGMENTS * 2 * 边数）。 */
export const EDGE_SEGMENTS = 8;

/** 弯曲强度：顶点着色器里 control 点沿 (axis × view) 方向弓出的比例。 */
export const BOW_STRENGTH = 0.22;

/** 关系配色（edge.rel）。 */
export const REL_COLORS: Record<string, string> = {
  semantic: '#3f8fb8',
  hypernym: '#3ecf8e',
  hyponym: '#2fb37b',
  part_of: '#57a8d0',
  instance_of: '#6f8fd0',
  causes: '#e0803f',
  contradicts: '#e05252',
  supports: '#43b581',
  supersedes: '#b07cf0',
  derived_from: '#8a7fd0',
  mentions: '#5b7f9c',
  temporal_next: '#4aa3df',
  alias: '#8899aa',
  prerequisite: '#d0a03f',
  evidence_for: '#ffd166',
  // store.graph 产生的结构关系
  contains: '#8a9bb0',
  in_scope: '#c9b46a',
  evidence: '#ffd166',
  document: '#b8a2d8',
  chunk: '#a58fc9',
  default: '#557a94',
};

/** 取 rel 的颜色。 */
export function relColor(rel: string): string {
  return REL_COLORS[rel] ?? REL_COLORS.default;
}

/**
 * 顶点着色器：把每条直线边弯成二次贝塞尔。
 *
 * 传入属性：
 *   positionA / positionB —— 边的两个端点（世界坐标）
 *   aT                    —— 本顶点在边上的参数 t ∈ [0,1]
 *   aEdgeWeight           —— 边权重（影响透明度与弯曲量）
 *   aColor                —— 边颜色
 *
 * 计算：
 *   view  = normalize(cameraPosition - mid)
 *   axis  = normalize(B - A)
 *   side  = normalize(cross(axis, view))        屏幕内最"可见"的侧向
 *   bow   = BOW * len * facing                 facing = |dot(axis, view)|
 *   C     = mid + side * bow                     控制点
 *   P     = (1-t)² A + 2(1-t)t C + t² B
 *
 * 也就是说：边正对相机时（facing→1）弓得最狠，侧对时几乎不动，
 * 与参考实现的三条规则一致，只是跑到 GPU 上了。
 */
const EDGE_VERTEX_SHADER = /* glsl */ [
  'attribute vec3 positionA;',
  'attribute vec3 positionB;',
  'attribute float aT;',
  'attribute float aEdgeWeight;',
  'attribute vec3 aColor;',
  'uniform float uBow;',
  'varying float vAlpha;',
  'varying vec3 vColor;',
  'void main() {',
  '  vec3 a = positionA;',
  '  vec3 b = positionB;',
  '  vec3 axisVec = b - a;',
  '  float len = length(axisVec);',
  '  vec3 axis = len > 1e-4 ? axisVec / len : vec3(0.0, 1.0, 0.0);',
  '  vec3 mid = (a + b) * 0.5;',
  '  vec3 view = cameraPosition - mid;',
  '  float dist = length(view);',
  '  vec3 viewDir = dist > 1e-4 ? view / dist : vec3(0.0, 0.0, 1.0);',
  '  float facing = abs(dot(axis, viewDir));',
  '  vec3 side = cross(axis, viewDir);',
  '  float sideLen = length(side);',
  '  side = sideLen > 1e-4 ? side / sideLen : vec3(1.0, 0.0, 0.0);',
  '  vec3 control = mid + side * (uBow * len * facing * facing);',
  '  float t = aT;',
  '  float it = 1.0 - t;',
  '  vec3 p = it * it * a + 2.0 * it * t * control + t * t * b;',
  '  vColor = aColor;',
  // 权重 → 透明度（0.25..1），再按距离雾化，远近都有层次
  '  float wAlpha = 0.18 + 0.62 * clamp(aEdgeWeight, 0.0, 1.0);',
  '  float fog = 1.0 - smoothstep(4000.0, 26000.0, dist);',
  '  vAlpha = wAlpha * fog;',
  '  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);',
  '}',
].join('\n');

const EDGE_FRAGMENT_SHADER = /* glsl */ [
  'varying float vAlpha;',
  'varying vec3 vColor;',
  'uniform float uOpacity;',
  'void main() {',
  '  gl_FragColor = vec4(vColor, vAlpha * uOpacity);',
  '}',
].join('\n');

/** 边层。 */
export class EdgeLayer {
  readonly group = new LineSegments(new BufferGeometry(), new ShaderMaterial());
  private readonly material: ShaderMaterial;
  private capacity = 0;
  private edgeCount = 0;
  private graph: BrainGraph | null = null;

  constructor() {
    this.material = new ShaderMaterial({
      vertexShader: EDGE_VERTEX_SHADER,
      fragmentShader: EDGE_FRAGMENT_SHADER,
      uniforms: { uBow: { value: BOW_STRENGTH }, uOpacity: { value: 1 } },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    this.group = new LineSegments(new BufferGeometry(), this.material);
    this.group.frustumCulled = false;
    this.group.renderOrder = 1;
  }

  get segments(): number { return this.edgeCount; }
  /** 顶点数（每条边 EDGE_SEGMENTS 段 × 2 端点）。 */
  get vertices(): number { return this.edgeCount * EDGE_SEGMENTS * 2; }

  /** 透明度总开关（过滤时淡出）。 */
  setOpacity(value: number): void {
    this.material.uniforms.uOpacity.value = Math.max(0, Math.min(1, value));
  }

  /** 弯曲强度（掉帧时可降到 0，省的是 GPU 顶点计算的量）。 */
  setBow(value: number): void {
    this.material.uniforms.uBow.value = value;
  }

  /**
   * 按图重建边几何。
   * @param positions 布局坐标
   * @param index     id → 索引
   * @param visibility 可选：每边可见性掩码（0 = 隐藏）
   */
  build(graph: BrainGraph, positions: Float32Array, index: Map<string, number>): void {
    this.graph = graph;
    const pairs: number[] = [];
    for (const e of graph.edges) {
      const a = index.get(e.src);
      const b = index.get(e.dst);
      if (a === undefined || b === undefined || a === b) continue;
      pairs.push(a, b);
    }
    this.edgeCount = pairs.length / 2;
    this.capacity = Math.max(this.edgeCount, 1);
    this.allocate();
    this.updateEndpoints(positions, pairs);
    void this.graph;
  }

  /** 只用现有图重建端点（布局变化后调用，不重新分配缓冲）。 */
  updateEndpoints(positions: Float32Array, pairs: number[]): void {
    const geometry = this.group.geometry;
    const posA = geometry.getAttribute('positionA') as BufferAttribute;
    const posB = geometry.getAttribute('positionB') as BufferAttribute;
    const graph = this.graph;
    if (!graph) return;
    const a = posA.array as Float32Array;
    const b = posB.array as Float32Array;
    const segVerts = EDGE_SEGMENTS * 2;
    // pairs 缺省时按当前 graph 现算（布局重算场景）
    let cursor = 0;
    if (pairs.length) {
      for (let e = 0; e < this.edgeCount; e++) {
        const ia = pairs[e * 2], ib = pairs[e * 2 + 1];
        const ax = positions[ia * 3], ay = positions[ia * 3 + 1], az = positions[ia * 3 + 2];
        const bx = positions[ib * 3], by = positions[ib * 3 + 1], bz = positions[ib * 3 + 2];
        for (let s = 0; s < segVerts; s++) {
          a[cursor * 3] = ax; a[cursor * 3 + 1] = ay; a[cursor * 3 + 2] = az;
          b[cursor * 3] = bx; b[cursor * 3 + 1] = by; b[cursor * 3 + 2] = bz;
          cursor++;
        }
      }
    }
    posA.needsUpdate = true;
    posB.needsUpdate = true;
    geometry.computeBoundingSphere();
  }

  /** 分配全部属性缓冲。 */
  private allocate(): void {
    const geometry = this.group.geometry;
    const edgeVerts = this.edgeCount * EDGE_SEGMENTS * 2;
    const posA = new Float32Array(edgeVerts * 3);
    const posB = new Float32Array(edgeVerts * 3);
    const ts = new Float32Array(edgeVerts);
    const weights = new Float32Array(edgeVerts);
    const colors = new Float32Array(edgeVerts * 3);
    const positions = new Float32Array(edgeVerts * 3); // 占位：真实位置在 GPU 里算

    const relColorCache = new Map<string, Color>();
    let v = 0;
    for (const e of this.graph?.edges ?? []) {
      let c = relColorCache.get(e.rel);
      if (!c) { c = new Color(relColor(e.rel)); relColorCache.set(e.rel, c); }
      for (let seg = 0; seg < EDGE_SEGMENTS; seg++) {
        for (let k = 0; k < 2; k++) {
          ts[v] = (seg + k) / EDGE_SEGMENTS;
          weights[v] = e.weight;
          colors[v * 3] = c.r; colors[v * 3 + 1] = c.g; colors[v * 3 + 2] = c.b;
          v++;
        }
      }
    }

    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setAttribute('positionA', new BufferAttribute(posA, 3));
    geometry.setAttribute('positionB', new BufferAttribute(posB, 3));
    geometry.setAttribute('aT', new BufferAttribute(ts, 1));
    geometry.setAttribute('aEdgeWeight', new BufferAttribute(weights, 1));
    geometry.setAttribute('aColor', new BufferAttribute(colors, 3));
    geometry.setDrawRange(0, edgeVerts);
  }

  /** 高亮某条边（路径查找结果）。用第二个 LineSegments 覆盖画，避免重建几何。 */
  private highlightLines: LineSegments | null = null;

  /** 高亮一条路径（索引序列），返回顶点数。 */
  highlightPath(path: number[], positions: Float32Array): void {
    this.clearHighlight();
    if (path.length < 2) return;
    const verts = (path.length - 1) * 2;
    const arr = new Float32Array(verts * 3);
    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i], b = path[i + 1];
      arr[i * 6] = positions[a * 3]; arr[i * 6 + 1] = positions[a * 3 + 1]; arr[i * 6 + 2] = positions[a * 3 + 2];
      arr[i * 6 + 3] = positions[b * 3]; arr[i * 6 + 4] = positions[b * 3 + 1]; arr[i * 6 + 5] = positions[b * 3 + 2];
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(arr, 3));
    this.highlightLines = new LineSegments(geometry, new LineBasicMaterial({
      color: 0x8ff0ff, transparent: true, opacity: 0.95, depthWrite: false, blending: AdditiveBlending,
    }));
    this.highlightLines.frustumCulled = false;
    this.highlightLines.renderOrder = 3;
    this.group.add(this.highlightLines);
  }

  /** 清掉路径高亮。 */
  clearHighlight(): void {
    if (!this.highlightLines) return;
    this.group.remove(this.highlightLines);
    this.highlightLines.geometry.dispose();
    (this.highlightLines.material as LineBasicMaterial).dispose();
    this.highlightLines = null;
  }

  /** 让选中节点的连边也亮起来：把它们的权重临时拉满（GPU 属性一次更新）。 */
  setNeighborEmphasis(selected: number, neighbors: number[], index: Map<string, number>): void {
    const graph = this.graph;
    if (!graph) return;
    const geometry = this.group.geometry;
    const weights = geometry.getAttribute('aEdgeWeight') as BufferAttribute;
    const arr = weights.array as Float32Array;
    const boosted = new Set(neighbors);
    const segVerts = EDGE_SEGMENTS * 2;
    let v = 0;
    for (const e of graph.edges) {
      const a = index.get(e.src);
      const b = index.get(e.dst);
      const involved = selected >= 0 && (a === selected || b === selected ||
        (a !== undefined && boosted.has(a)) && (b !== undefined && boosted.has(b)));
      const w = involved ? Math.min(1, e.weight * 1.35 + 0.4) : e.weight * 0.55;
      for (let s = 0; s < segVerts; s++) arr[v++] = w;
    }
    weights.needsUpdate = true;
  }

  dispose(): void {
    this.clearHighlight();
    this.group.geometry.dispose();
    this.material.dispose();
  }
}

export { Vector3 };
