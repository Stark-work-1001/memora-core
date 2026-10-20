/**
 * 节点层：InstancedMesh 球体（一次 draw call）+ 屏幕空间标签层 + 选中光环。
 *
 * 三个关键决定：
 *
 * 1) **InstancedMesh，不是一堆 Mesh。** 5000 个 Mesh 就是 5000 次 draw call，
 *    每帧 CPU 侧光矩阵上传就够把帧率打到个位数。InstancedMesh 把每实例的矩阵与颜色
 *    塞进 attribute，整层 1 次 draw call。
 *
 * 2) **标签画在独立的像素空间正交场景里（HUD 层），不是 3D 空间里的 Sprite。**
 *    3D Sprite 要做"贴着节点、屏幕尺寸恒定、不被球体遮挡、还能做避让"四件事，
 *    就得把像素偏移反投影回世界坐标，缩放与 DPR 反复换算，极易出错且文字会糊。
 *    这里换成：另一台正交相机，坐标单位就是像素（0..width, 0..height），
 *    sprite 的 position 直接就是屏幕像素点，scale 直接就是标签的像素尺寸——
 *    1:1 清晰，避让在像素空间里做也是精确的。主渲染器开 autoClear=false 画第二遍。
 *
 * 3) **标签避让用 8 方向候选 + 均匀网格包围盒。** 5000 节点两两比较是 O(n²)，
 *    网格把每次落位降到 O(1)。每帧只重算一部分（默认 20%），滚动窗口，
 *    但选中节点与它的最高优先邻居永远重算。
 */
import {
  AdditiveBlending,
  BufferGeometry,
  CanvasTexture,
  Color,
  DynamicDrawUsage,
  Frustum,
  IcosahedronGeometry,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  Object3D,
  OrthographicCamera,
  Scene,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  Vector2,
  Vector3,
} from 'three';
import type { Camera } from 'three';
import type { BrainGraph, BrainNode } from './types';

/** 节点配色：键是 memory.kind / entity.kind / evidence / source。 */
export const KIND_COLORS: Record<string, string> = {
  fact: '#4aa3df',
  knowledge: '#3ecf8e',
  decision: '#b07cf0',
  preference: '#f0b24a',
  procedure: '#35c9c1',
  experience: '#f07c7c',
  task: '#8aa0b8',
  turn: '#6b7c93',
  tool: '#7fb4d8',
  artifact: '#c9a227',
  concept: '#6dd3ff',
  entity: '#6dd3ff',
  person: '#e08ac0',
  project: '#63b3ed',
  term: '#7ee0c8',
  memory: '#4aa3df',
  evidence: '#ffd166',
  source: '#9aa7b8',
  document: '#b8a2d8',
  // 后端图视图实际会出现的结构节点（store.graph：hierarchy 的 scope、timeline 的 day、evidence 的 chunk）
  scope: '#e6c86e',
  day: '#7aa2c8',
  chunk: '#a58fc9',
  default: '#8fa3bd',
};

/** 取某个 kind 的颜色（未知 kind 落到 default）。 */
export function kindColor(kind: string): string {
  return KIND_COLORS[kind] ?? KIND_COLORS.default;
}

/**
 * 节点的**相对**半径：按 degree / importance 放大，但对数压缩，
 * 避免高度数节点吃掉整个屏幕。
 *
 * 注意这是无量纲的相对值（2.2 ~ 12），真正渲染时还要乘上世界单位
 * {@link worldUnitFor}——否则布局尺度一变（60 节点 vs 5000 节点，
 * 云半径能差 20 倍），节点要么看不见（3px），要么糊满屏幕。
 */
export function nodeRadius(node: BrainNode): number {
  const deg = Math.max(0, node.degree);
  const imp = Math.max(0, Math.min(1, node.importance));
  return 2.2 + Math.min(9, Math.log1p(deg) * 2.6) + imp * 3.4;
}

/**
 * 由布局半径推出"一个相对单位"等于多少世界单位。
 *
 * 标定过程（别随手改这个数，它决定了整张图能不能看懂）：
 *   适配取景时相机距离 d ≈ 1.35R / tan(fov/2) ≈ 2.8R，视口高约 800px，
 *   于是屏幕上 1 像素 ≈ (2·d·tan(fov/2)) / 800 ≈ 0.0068·R 个世界单位。
 *   相对半径 2.2~12 的节点要落在 4~22px 之间：
 *      最小：2.2 · u ≈ 4px   → u ≈ 0.0027R
 *      最大：12  · u ≈ 22px  → u ≈ 0.0027R
 *   两边一致，取 u = R/370。之前用 R/165 时最大节点有 80px、整屏都是球，
 *   什么都看不清。
 */
export function worldUnitFor(layoutRadius: number): number {
  return Math.max(0.2, layoutRadius / 370);
}

/** 标签避让的 8 个候选方位（相对节点中心的像素偏移方向）。 */
const LABEL_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [1, 0], [1, -1], [0, -1], [-1, -1], [-1, 0], [-1, 1], [0, 1], [1, 1],
];

/** 屏幕矩形（像素）。 */
interface Rect { x: number; y: number; w: number; h: number }

/** 均匀网格：把屏幕切成 32px 单元，落位时只和同格/邻格矩形比较。 */
class OccupancyGrid {
  private readonly cell = 32;
  private readonly map = new Map<number, number[]>();

  clear(): void { this.map.clear(); }

  private static key(cx: number, cy: number): number {
    return (cx + 512) * 4096 + (cy + 512);
  }

  private bucket(cx: number, cy: number): number[] {
    const k = OccupancyGrid.key(cx, cy);
    const found = this.map.get(k);
    if (found) return found;
    const created: number[] = [];
    this.map.set(k, created);
    return created;
  }

  hits(x: number, y: number, w: number, h: number): boolean {
    const x0 = Math.floor(x / this.cell), x1 = Math.floor((x + w) / this.cell);
    const y0 = Math.floor(y / this.cell), y1 = Math.floor((y + h) / this.cell);
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        const list = this.map.get(OccupancyGrid.key(cx, cy));
        if (!list) continue;
        for (let i = 0; i < list.length; i += 4) {
          if (x < list[i] + list[i + 2] && list[i] < x + w && y < list[i + 1] + list[i + 3] && list[i + 1] < y + h) return true;
        }
      }
    }
    return false;
  }

  add(x: number, y: number, w: number, h: number): void {
    const x0 = Math.floor(x / this.cell), x1 = Math.floor((x + w) / this.cell);
    const y0 = Math.floor(y / this.cell), y1 = Math.floor((y + h) / this.cell);
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) this.bucket(cx, cy).push(x, y, w, h);
    }
  }
}

/** 一个标签池槽位。 */
interface LabelSlot {
  sprite: Sprite;
  material: SpriteMaterial;
  /** 节点索引，-1 = 空闲。 */
  index: number;
  /** 标签中心相对节点屏幕点的像素偏移（8 方向候选里选中的那个）。 */
  offX: number;
  offY: number;
  /** 标签的像素尺寸。 */
  w: number;
  h: number;
  /** 上一次放置的屏幕矩形（重建占位网格时要用）。 */
  rect: Rect;
}

export interface NodeLayerOptions {
  /** 标签上限（默认 120）。 */
  maxLabels?: number;
  /** 每帧重算的标签比例（默认 0.2）。 */
  labelChurn?: number;
}

/**
 * 节点层。
 *
 * 对外暴露两个"场景"：
 *  - group  ：3D 主场景里的内容（球体 + 光环）
 *  - overlay：像素空间标签层（主渲染器第二遍画，autoClear=false）
 */
export class NodeLayer {
  /** 实例化网格；节点数变化时会被重建（见 ensureCapacity），所以不是 readonly。 */
  mesh: InstancedMesh;
  readonly halo: Sprite;
  readonly group = new Object3D();
  readonly overlayScene = new Scene();
  readonly overlayCamera = new OrthographicCamera(0, 1, 0, 1, -10, 10);

  private readonly spritePool: LabelSlot[] = [];
  private readonly textureCache = new Map<string, CanvasTexture>();
  private readonly grid = new OccupancyGrid();
  private maxLabels: number;
  private readonly churn: number;
  private labelCursor = 0;
  private labelsShown = 0;
  /** 本轮各节点的优先级排名（下一帧据此决定谁该重排）。 */
  private readonly rankOf = new Map<number, number>();
  /** 永远重排的节点（选中 + 最高优先邻居）。 */
  private readonly forcedSet = new Set<number>();

  private readonly dummy = new Object3D();
  private readonly scratchColor = new Color();
  private readonly baseColors: Float32Array = new Float32Array(0);
  private readonly haloTexture: CanvasTexture;

  private nodeCount = 0;
  /** 世界单位（由布局半径推出，见 worldUnitFor）。 */
  private unit = 1;
  private graph: BrainGraph | null = null;
  /** 0 正常 / 1 邻居 / 2 选中。 */
  private highlightLevel = new Uint8Array(0);
  private selected = -1;

  private readonly iGeometryHi: IcosahedronGeometry;
  private readonly iGeometryLo: IcosahedronGeometry;
  private readonly material: MeshBasicMaterial;

  constructor(options: NodeLayerOptions = {}) {
    this.maxLabels = Math.max(8, options.maxLabels ?? 120);
    this.churn = Math.min(1, Math.max(0.05, options.labelChurn ?? 0.2));

    this.iGeometryHi = new IcosahedronGeometry(1, 1); // 80 面
    this.iGeometryLo = new IcosahedronGeometry(1, 0); // 20 面（LOD 低档）
    // 注意：这里**不能**开 vertexColors。开了会引入 USE_COLOR，着色器就会去乘以
    // geometry 的 color 属性——而我们没有这个属性，它默认是 (0,0,0)，于是所有实例
    // 都被乘成纯黑（节点变成黑洞）。实例颜色走 instanceColor 就够了：
    // three 在 mesh.instanceColor != null 时自动定义 USE_INSTANCING_COLOR。
    const material = new MeshBasicMaterial({ toneMapped: false });
    this.material = material;
    this.mesh = makeInstancedMesh(this.iGeometryHi, material, 1);

    this.haloTexture = radialTexture(128, 'rgba(200,245,255,0.95)', 'rgba(80,190,255,0)');
    this.halo = new Sprite(new SpriteMaterial({
      map: this.haloTexture,
      blending: AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      transparent: true,
      toneMapped: false,
    }));
    this.halo.visible = false;
    this.halo.renderOrder = 5;

    this.group.add(this.mesh);
    this.group.add(this.halo);

    // 标签层必须让 three 正常更新世界矩阵：曾经把它关掉（matrixWorldAutoUpdate=false）
    // 想省一点 CPU，结果 sprite 的 matrixWorld 永远是单位矩阵——所有标签都堆在原点，
    // 屏幕上看起来就是"一个标签都没有"。
    this.overlayCamera.position.set(0, 0, 5);
    this.overlayCamera.updateMatrixWorld();
  }

  get labelCount(): number { return this.labelsShown; }
  get count(): number { return this.nodeCount; }

  /** 标签预算（掉帧时降低）。 */
  setLabelBudget(n: number): void {
    this.maxLabels = Math.max(8, Math.floor(n));
  }

  /** LOD：高档 80 面，低档 20 面（顶点数差 4 倍，掉帧时先降这里）。 */
  setLod(level: 'high' | 'low'): void {
    const wanted = level === 'high' ? this.iGeometryHi : this.iGeometryLo;
    if (this.mesh.geometry === wanted) return;
    // 每实例颜色挂在 mesh 上（不是 geometry），换 geometry 不会丢颜色。
    this.mesh.geometry = wanted;
  }

  /** 布局尺度变了：更新世界单位并重写矩阵。 */
  setWorldUnit(unit: number): void {
    this.unit = Math.max(0.5, unit);
  }

  /** 当前世界单位（交互层算拾取容差要用）。 */
  get worldUnit(): number { return this.unit; }

  /**
   * 保证实例缓冲至少有 n 个槽位。
   *
   * 这是本项目最容易踩的坑：InstancedMesh **只在构造时**按 count 分配
   * instanceMatrix（n×16）与 instanceColor（n×3）。之后写 `mesh.count = n`
   * 只是改"画多少个"，不会扩容缓冲——`setMatrixAt(i>0)` 会静默写越界
   * （TypedArray 越界赋值不报错，直接丢弃），于是所有实例都读到第 0 个矩阵：
   * 452 个球全叠在一个点上，屏幕上就是一个巨大的黑团。节点数一变必须重建网格。
   */
  private ensureCapacity(n: number): void {
    const capacity = this.mesh.instanceMatrix.count;
    if (capacity >= n && capacity > 1) {
      this.mesh.count = n;
      return;
    }
    const geometry = this.mesh.geometry;
    this.group.remove(this.mesh);
    this.mesh.dispose();
    this.mesh = makeInstancedMesh(geometry, this.material, Math.max(n, 1));
    this.group.add(this.mesh);
  }

  /** 图变化时重建实例。 */
  build(graph: BrainGraph, positions: Float32Array): void {
    this.graph = graph;
    this.nodeCount = graph.nodes.length;
    this.ensureCapacity(this.nodeCount);
    this.mesh.count = this.nodeCount;

    // 每实例颜色必须挂在 **mesh.instanceColor** 上（three 靠这个字段决定是否
    // 打开 USE_INSTANCING_COLOR）；挂到 geometry 上的同名 attribute 是无效的，
    // 着色器里没有这个声明，结果就是节点画不出来（或用错颜色）。
    const colorAttr = this.mesh.instanceColor
      ?? new InstancedBufferAttribute(new Float32Array(Math.max(1, this.nodeCount) * 3), 3);
    for (let i = 0; i < this.nodeCount; i++) {
      this.scratchColor.set(kindColor(graph.nodes[i].kind));
      colorAttr.setXYZ(i, this.scratchColor.r, this.scratchColor.g, this.scratchColor.b);
    }
    colorAttr.setUsage(DynamicDrawUsage);
    colorAttr.needsUpdate = true;
    this.mesh.instanceColor = colorAttr;
    this.material.needsUpdate = true;

    this.highlightLevel = new Uint8Array(this.nodeCount);
    this.selected = -1;
    this.halo.visible = false;
    this.invalidateLabels();
    this.writeMatrices(positions, null);
  }

  /**
   * 重写实例矩阵。
   * @param positions 渲染坐标（已含选中外推）
   * @param scaleBoost 可选：每节点额外缩放（选中 = 1.4）
   */
  writeMatrices(positions: Float32Array, scaleBoost: Float32Array | null): void {
    const graph = this.graph;
    if (!graph) return;
    const d = this.dummy;
    d.updateMatrix();
    for (let i = 0; i < this.nodeCount; i++) {
      const base = nodeRadius(graph.nodes[i]) * this.unit;
      const s = scaleBoost ? base * scaleBoost[i] : base;
      d.position.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
      d.scale.setScalar(s);
      d.rotation.set(0, 0, 0);
      d.updateMatrix();
      this.mesh.setMatrixAt(i, d.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.computeBoundingSphere();
  }

  /** 高亮：只改受影响的实例颜色（O(changed)），不动整张颜色表。 */
  setHighlight(selected: number, neighbors: number[]): void {
    const graph = this.graph;
    if (!graph) return;
    const attr = this.mesh.instanceColor;
    if (!attr) return;
    for (let i = 0; i < this.highlightLevel.length; i++) {
      const lvl = this.highlightLevel[i];
      if (!lvl) continue;
      this.scratchColor.set(kindColor(graph.nodes[i].kind));
      attr.setXYZ(i, this.scratchColor.r, this.scratchColor.g, this.scratchColor.b);
      this.highlightLevel[i] = 0;
    }
    if (selected >= 0 && selected < this.nodeCount) {
      const white = new Color('#ffffff');
      for (const n of neighbors) {
        if (n < 0 || n >= this.nodeCount) continue;
        this.scratchColor.set(kindColor(graph.nodes[n].kind)).lerp(white, 0.28);
        attr.setXYZ(n, this.scratchColor.r, this.scratchColor.g, this.scratchColor.b);
        this.highlightLevel[n] = 1;
      }
      this.scratchColor.set(kindColor(graph.nodes[selected].kind)).lerp(white, 0.5);
      attr.setXYZ(selected, this.scratchColor.r, this.scratchColor.g, this.scratchColor.b);
      this.highlightLevel[selected] = 2;
      this.selected = selected;
    } else {
      this.selected = -1;
    }
    attr.needsUpdate = true;
  }

  /** 光环跟随选中节点（带呼吸）。 */
  updateHalo(now: number, renderPositions: Float32Array): void {
    const graph = this.graph;
    if (!graph || this.selected < 0 || this.selected * 3 + 2 >= renderPositions.length) {
      this.halo.visible = false;
      return;
    }
    const i = this.selected;
    const r = nodeRadius(graph.nodes[i]) * this.unit * 1.4;
    const pulse = 1 + Math.sin(now * 0.0035) * 0.07;
    this.halo.visible = true;
    this.halo.position.set(renderPositions[i * 3], renderPositions[i * 3 + 1], renderPositions[i * 3 + 2]);
    // 光环只是"一圈光晕"，直径约节点的 2.6 倍：再大就会盖住整个屏幕
    this.halo.scale.setScalar(r * 2.6 * pulse);
  }

  /* ------------------------------------------------------------------ *
   * 标签（像素空间）
   * ------------------------------------------------------------------ */

  private invalidateLabels(): void {
    this.grid.clear();
    for (const slot of this.spritePool) { slot.sprite.visible = false; slot.index = -1; }
    this.labelCursor = 0;
    this.labelsShown = 0;
  }

  /** 文本 → 贴图（带缓存；标签数量有上限，缓存自然有界）。 */
  private textureFor(text: string, emphasis: boolean): CanvasTexture {
    const key = (emphasis ? 'E|' : 'N|') + text;
    const cached = this.textureCache.get(key);
    if (cached) return cached;
    if (this.textureCache.size > this.maxLabels * 4) {
      const keys = Array.from(this.textureCache.keys()).slice(0, this.maxLabels * 2);
      for (const k of keys) {
        this.textureCache.get(k)?.dispose();
        this.textureCache.delete(k);
      }
    }
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const fontPx = 15 * dpr;
    const font = '600 ' + fontPx + 'px "Segoe UI", "Microsoft YaHei", system-ui, sans-serif';
    const shown = text.length > 24 ? text.slice(0, 23) + '…' : text;
    const canvas = document.createElement('canvas');
    const probe = canvas.getContext('2d');
    let width = 32;
    if (probe) {
      probe.font = font;
      width = Math.ceil(probe.measureText(shown).width);
    }
    const padX = Math.ceil(fontPx * 0.55);
    canvas.width = Math.max(8, width + padX * 2);
    canvas.height = Math.ceil(fontPx * 1.9);
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.font = font;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      const r = canvas.height * 0.34;
      ctx.fillStyle = emphasis ? 'rgba(12, 26, 40, 0.92)' : 'rgba(6, 11, 18, 0.74)';
      roundRect(ctx, 1, 1, canvas.width - 2, canvas.height - 2, r);
      ctx.fill();
      ctx.strokeStyle = emphasis ? 'rgba(130, 220, 255, 0.75)' : 'rgba(110, 170, 210, 0.28)';
      ctx.lineWidth = Math.max(1, dpr);
      roundRect(ctx, 1, 1, canvas.width - 2, canvas.height - 2, r);
      ctx.stroke();
      ctx.fillStyle = emphasis ? '#f2fbff' : '#cfe4f5';
      ctx.fillText(shown, padX, canvas.height / 2 + 1);
    }
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    texture.needsUpdate = true;
    this.textureCache.set(key, texture);
    return texture;
  }

  private acquireSlot(): LabelSlot | null {
    for (const slot of this.spritePool) if (slot.index < 0) return slot;
    if (this.spritePool.length >= this.maxLabels) return null;
    const material = new SpriteMaterial({ transparent: true, depthTest: false, depthWrite: false, toneMapped: false });
    const sprite = new Sprite(material);
    sprite.renderOrder = 10;
    sprite.visible = false;
    this.overlayScene.add(sprite);
    const slot: LabelSlot = {
      sprite, material, index: -1, offX: 0, offY: 0, w: 0, h: 0,
      rect: { x: 0, y: 0, w: 0, h: 0 },
    };
    this.spritePool.push(slot);
    return slot;
  }

  /**
   * 每帧更新标签。
   *
   * 三级成本控制：
   *  1. **投影**：所有已放置的标签每帧重新投影（O(visible)，≤120 次）——相机一动，
   *     标签必须跟着节点走，否则看起来就是一堆飘在半空的文字。
   *  2. **碰撞求解**（选 8 个候选方位中的哪一个）：这是真正贵的那一步，只对
   *     滚动窗口里的 20% 重做；其余沿用上一帧的偏移量。相机小幅移动时完全看不出来，
   *     而每帧成本恒定。
   *  3. **排序**：候选按优先级排序，排在前面的是选中节点与其邻居，永远优先落位。
   *
   * @param frustum         主相机视锥（已 update）
   * @param project         世界坐标 → 屏幕像素
   * @param priority        优先级（越大越先占位）
   * @param renderPositions 渲染坐标（含选中外推）
   * @param viewport        视口像素尺寸
   */
  updateLabels(
    frustum: Frustum,
    project: (i: number, out: Vector2) => Vector2,
    priority: Float32Array,
    renderPositions: Float32Array,
    viewport: { width: number; height: number },
  ): void {
    const graph = this.graph;
    if (!graph) { this.labelsShown = 0; return; }
    const n = this.nodeCount;
    const world = new Vector3();
    const point = new Vector2();
    const dpr = Math.min(2, window.devicePixelRatio || 1);

    // 1) 视锥测试 + 优先级排序
    const candidates: number[] = [];
    for (let i = 0; i < n; i++) {
      world.set(renderPositions[i * 3], renderPositions[i * 3 + 1], renderPositions[i * 3 + 2]);
      if (frustum.containsPoint(world)) candidates.push(i);
    }
    candidates.sort((a, b) => priority[b] - priority[a]);
    const limit = Math.min(this.maxLabels, candidates.length);

    const visible = new Set<number>();
    for (let k = 0; k < limit; k++) visible.add(candidates[k]);

    // 2) 先把上一帧保留下来的标签重新投影（贴合节点）
    this.evictCounter = 0;
    for (const slot of this.spritePool) {
      if (slot.index < 0) continue;
      if (!visible.has(slot.index)) {
        // 已经不在可见集里（移出视锥或掉出优先级窗口）→ 收掉
        slot.sprite.visible = false;
        slot.index = -1;
        this.evictCounter++;
        continue;
      }
      const px = project(slot.index, point).x;
      const py = point.y;
      slot.rect.x = px + slot.offX - slot.w / 2;
      slot.rect.y = py + slot.offY - slot.h / 2;
      slot.sprite.position.set(px + slot.offX, viewport.height - (py + slot.offY), 0);
    }

    if (!limit) { this.labelsShown = 0; return; }

    // 3) 滚动窗口：本轮只重新求解这一段 rank 的方位
    const perFrame = Math.max(1, Math.round(limit * this.churn));
    this.labelCursor = (this.labelCursor + perFrame) % limit;
    const windowStart = this.labelCursor;
    const windowEnd = Math.min(limit, windowStart + perFrame);

    // 窗口内的节点（以及永远重排的前两名）让出槽位重新求解
    const redo = new Set<number>();
    for (let rank = 0; rank < limit; rank++) {
      if (rank < 2 || (rank >= windowStart && rank < windowEnd)) redo.add(candidates[rank]);
    }
    for (const slot of this.spritePool) {
      if (slot.index >= 0 && redo.has(slot.index)) {
        slot.sprite.visible = false;
        slot.index = -1;
      }
    }

    // 重建占位网格（O(visible)）
    this.grid.clear();
    for (const slot of this.spritePool) {
      if (slot.sprite.visible) this.grid.add(slot.rect.x, slot.rect.y, slot.rect.w, slot.rect.h);
    }

    // 4) 为 redo 集合里的节点求一个新方位（8 候选 + 包围盒碰撞）
    let solved = 0;
    for (let rank = 0; rank < limit; rank++) {
      const i = candidates[rank];
      if (!redo.has(i)) continue;
      if (solved > perFrame + 2) break;
      solved++;
      const node = graph.nodes[i];
      const p = project(i, point);
      if (p.x < -400 || p.y < -120 || p.x > viewport.width + 400 || p.y > viewport.height + 120) continue;
      const slot = this.acquireSlot();
      if (!slot) break;
      const texture = this.textureFor(node.label, rank < 2);
      const img = texture.image as HTMLCanvasElement;
      const w = img.width / dpr;
      const h = img.height / dpr;
      let placed = false;
      let offX = 0, offY = 0;
      for (const [ox, oy] of LABEL_OFFSETS) {
        const cx = p.x + ox * (w * 0.5 + 14);
        const cy = p.y + oy * (h * 0.62 + 12);
        const rx = cx - w / 2;
        const ry = cy - h / 2;
        if (rx < 2 || ry < 2 || rx + w > viewport.width - 2 || ry + h > viewport.height - 2) continue;
        if (this.grid.hits(rx, ry, w, h)) continue;
        this.grid.add(rx, ry, w, h);
        offX = cx - p.x;
        offY = cy - p.y;
        slot.rect.x = rx; slot.rect.y = ry; slot.rect.w = w; slot.rect.h = h;
        slot.sprite.position.set(cx, viewport.height - cy, 0);
        placed = true;
        break;
      }
      if (!placed) continue;
      slot.index = i;
      slot.offX = offX;
      slot.offY = offY;
      slot.w = w;
      slot.h = h;
      slot.sprite.visible = true;
      slot.material.map = texture;
      slot.material.needsUpdate = true;
      slot.sprite.scale.set(w, h, 1);
    }

    // 5) 补位：滚动窗口只重排一段 rank，被碰撞淘汰的槽位如果不再补，
    //    标签数会稳定在"远小于预算"的低位（实测 120 的预算只显示 18~24 个）。
    //    这里按优先级把空槽补满，仍然只做 O(limit) 次尝试。
    for (let rank = 0; rank < limit; rank++) {
      const i = candidates[rank];
      const taken = this.spritePool.some((slot) => slot.index === i);
      if (taken) continue;
      const p = project(i, point);
      if (p.x < -400 || p.y < -120 || p.x > viewport.width + 400 || p.y > viewport.height + 120) continue;
      const slot = this.acquireSlot();
      if (!slot) break;
      const node = graph.nodes[i];
      const texture = this.textureFor(node.label, rank < 2);
      const img = texture.image as HTMLCanvasElement;
      const w = img.width / dpr;
      const h = img.height / dpr;
      let placed = false;
      for (const [ox, oy] of LABEL_OFFSETS) {
        const cx = p.x + ox * (w * 0.5 + 14);
        const cy = p.y + oy * (h * 0.62 + 12);
        const rx = cx - w / 2;
        const ry = cy - h / 2;
        if (rx < 2 || ry < 2 || rx + w > viewport.width - 2 || ry + h > viewport.height - 2) continue;
        if (this.grid.hits(rx, ry, w, h)) continue;
        this.grid.add(rx, ry, w, h);
        slot.index = i;
        slot.offX = cx - p.x;
        slot.offY = cy - p.y;
        slot.w = w;
        slot.h = h;
        slot.rect.x = rx; slot.rect.y = ry; slot.rect.w = w; slot.rect.h = h;
        slot.sprite.visible = true;
        slot.material.map = texture;
        slot.material.needsUpdate = true;
        slot.sprite.position.set(cx, viewport.height - cy, 0);
        slot.sprite.scale.set(w, h, 1);
        placed = true;
        break;
      }
      // 放不下就把槽位还回去（index 已经是 -1，visible 已经是 false），
      // 但不能让这次失败阻断后续节点继续尝试——所以这里 continue 而不是 break。
      if (!placed) { slot.index = -1; slot.sprite.visible = false; continue; }
    }

    let shown = 0;
    for (const s of this.spritePool) if (s.sprite.visible) shown++;
    this.labelsShown = shown;
    this.labelStats = {
      candidates: candidates.length,
      limit,
      pool: this.spritePool.length,
      shown,
      evicted: this.evictCounter,
      viewport: Math.round(viewport.width) + 'x' + Math.round(viewport.height),
    };
  }

  /** 最近一帧的标签统计（自检用）。 */
  labelStats: Record<string, unknown> = {};
  /** 本帧因离开可见集而收掉的标签数。 */
  private evictCounter = 0;

  /** 让标签层正交相机跟着视口走（像素单位）。 */
  resizeOverlay(width: number, height: number): void {
    this.overlayCamera.left = 0;
    this.overlayCamera.right = Math.max(1, width);
    this.overlayCamera.top = Math.max(1, height);
    this.overlayCamera.bottom = 0;
    this.overlayCamera.updateProjectionMatrix();
    this.overlayCamera.updateMatrixWorld(true);
  }

  dispose(): void {
    this.mesh.dispose();
    this.material.dispose();
    this.iGeometryHi.dispose();
    this.iGeometryLo.dispose();
    for (const t of this.textureCache.values()) t.dispose();
    this.textureCache.clear();
    this.haloTexture.dispose();
    this.halo.material.dispose();
  }

  /** 供测试/UI 读取当前图。 */
  get currentGraph(): BrainGraph | null { return this.graph; }
  /** 供交互层读取节点数。 */
  get nodeTotal(): number { return this.nodeCount; }
  /** 供渲染层读取矩阵（复用 dummy 对象，不要持有引用）。 */
  get matrixDummy(): Matrix4 { return this.dummy.matrix; }
}

/** 建一个可动态改写的实例化网格。 */
function makeInstancedMesh(
  geometry: BufferGeometry, material: MeshBasicMaterial, count: number,
): InstancedMesh {
  const mesh = new InstancedMesh(geometry, material, Math.max(1, count));
  mesh.frustumCulled = false; // 视锥剔除按节点自己算，整块不做粗剔除
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  mesh.count = count;
  return mesh;
}

/** 圆角矩形路径（老 Chromium 没有 ctx.roundRect）。 */
function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

/** 径向渐变贴图（光环用）。 */
function radialTexture(size: number, inner: string, outer: string): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const g = ctx.createRadialGradient(size / 2, size / 2, size * 0.15, size / 2, size / 2, size / 2);
    g.addColorStop(0, inner);
    g.addColorStop(0.55, 'rgba(120,210,255,0.28)');
    g.addColorStop(1, outer);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}
