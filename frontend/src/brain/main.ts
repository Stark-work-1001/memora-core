/**
 * 脑图入口：挂载到 #mem-brain，构建场景、跑布局、驱动渲染循环。
 *
 * 帧预算（每帧 CPU 上限 ~6ms，60fps 下 16.7ms 的 1/3）：
 *   - 布局          → Web Worker（Blob URL），主线程零成本
 *   - 相机/阻尼     → <0.1ms
 *   - 邻居外推+矩阵 → O(n) 纯算术，5000 节点约 0.5ms
 *   - 标签避让      → 每帧只重算 20%（默认 120 × 0.2 = 24 个），其余保持
 *   - 边弯曲        → 顶点着色器，CPU 零成本
 * 掉帧自动降 LOD：连续 20 帧低于 45fps → 标签预算减半 + 节点换 20 面几何；
 * 恢复后 60 帧高于 55fps 再升回去。降级是"状态机"，不会来回抖。
 */
import { injectStyles } from './style';
import { Frustum, Matrix4, Vector2, Vector3, Points, PointsMaterial, BufferAttribute, BufferGeometry } from 'three';
import { BrainScene } from './scene';
import { NodeLayer, kindColor, worldUnitFor } from './nodes';
import { EdgeLayer } from './edges';
import { Interaction, shortestPath, worldRadius } from './interact';
import { BrainUi, KIND_LABEL, VIEW_LABEL, type FilterState, type UiState } from './ui';
import { LayoutWorkerClient } from './worker';
import { fetchGraph } from './data';
import { defaultOptions, runLayout } from './layout';
import type { BrainGraph, LayoutEdge, LayoutNode, RenderState, ViewKind } from './types';

/** 帧预算：标签重算占总标签数的比例。 */
const LABEL_CHURN = 0.2;
/** 标签默认上限。 */
const DEFAULT_LABEL_BUDGET = 120;
/** 掉帧判定阈值。 */
const LOW_FPS = 45;
/** 恢复判定阈值。 */
const HIGH_FPS = 55;
/** 连续多少帧才切换 LOD（防抖）。 */
const LOD_WINDOW = 20;

const VIEWS: readonly ViewKind[] = ['semantic', 'hierarchy', 'timeline', 'evidence'];

/**
 * brain.html?view=<视图>&focus=<节点 id>。
 * 图页的 iframe、视图切换按钮与记忆详情的「关系图」都靠这两个参数；
 * 1.0.0 完全不读它们（永远拉 semantic），所以那些按钮看起来"什么都没发生"。
 */
export function readLaunchParams(search: string): { view: ViewKind; focus: string } {
  const params = new URLSearchParams(search);
  const raw = params.get('view') ?? '';
  const view = (VIEWS as readonly string[]).includes(raw) ? (raw as ViewKind) : 'semantic';
  return { view, focus: (params.get('focus') ?? '').trim() };
}

/** 一次渲染会话。 */
class BrainApp {
  private mount: HTMLElement;
  private root: HTMLElement;
  private canvas: HTMLCanvasElement;
  private scene: BrainScene;
  private nodes: NodeLayer;
  private edges: EdgeLayer;
  private ui: BrainUi;
  private interaction: Interaction;
  private layoutClient: LayoutWorkerClient;

  private view: ViewKind = 'semantic';
  private dims: 2 | 3 = 3;
  private state: RenderState | null = null;
  private filter: FilterState = { kinds: new Set(), scope: '', range: 'all' };
  private fullGraph: BrainGraph | null = null;

  private readonly frustum = new Frustum();
  private readonly projScreen = new Matrix4();
  private readonly tmpVec = new Vector3();
  private readonly tmp2 = new Vector2();

  /** 视口像素尺寸缓存。 */
  private viewport = { width: 1, height: 1 };
  /** 帧率统计。 */
  private fps = 0;
  private frameCount = 0;
  private fpsWindowStart = 0;
  private lowStreak = 0;
  private highStreak = 0;
  private lodLevel: 'high' | 'low' = 'high';
  private labelBudget = DEFAULT_LABEL_BUDGET;

  /** 星尘粒子。 */
  private stardust: Points | null = null;
  /** 状态栏文案。 */
  private statusText = '';
  /** 演示数据说明。 */
  private note = '';
  /** 是否已销毁。 */
  private disposed = false;
  private rafId = 0;
  /** 最后一次布局耗时（状态栏显示）。 */
  private lastLayoutMs = 0;
  private lastMinimapAt = 0;
  private lastPanelAt = 0;
  /** 最近一次布局失败的原因（null 表示正常）。 */
  private layoutError: string | null = null;
  /** 最近几次 rebuild 的轨迹（自检用）。 */
  private layoutTrace: Array<Record<string, unknown>> = [];
  /** 整帧（主场景 + 标签层）的 draw call / 三角形数。 */
  private lastCalls = 0;
  private lastTriangles = 0;
  /** 视图切换序号：慢请求晚到时不覆盖较新的视图。 */
  private viewSeq = 0;
  /** 最近一次 /api/graph 拉取（自检 / e2e 用）。 */
  private lastFetch: { view: ViewKind; ok: boolean; nodes: number; error: string | null } | null = null;
  /** 启动参数里的聚焦节点（找到并选中后清空）。 */
  private focusId = '';

  constructor(mount: HTMLElement) {
    this.mount = mount;
    mount.innerHTML = '';
    this.root = document.createElement('div');
    this.root.className = 'mem-brain-root';
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'mem-brain-canvas';
    this.root.appendChild(this.canvas);
    mount.appendChild(this.root);

    this.scene = new BrainScene(this.canvas);
    this.nodes = new NodeLayer({ maxLabels: DEFAULT_LABEL_BUDGET, labelChurn: LABEL_CHURN });
    this.edges = new EdgeLayer();
    this.layoutClient = new LayoutWorkerClient();

    this.scene.scene.add(this.nodes.group);
    this.scene.scene.add(this.edges.group);
    this.stardust = this.createStardust();
    this.scene.scene.add(this.stardust);
    injectStyles();

    this.interaction = new Interaction({
      scene: this.scene,
      nodes: this.nodes,
      edges: this.edges,
      state: () => this.state,
      onSelect: (index) => this.onSelect(index),
      onStatus: (text) => this.setStatus(text),
      projection: () => this.scene.projectionMode,
    });

    this.ui = new BrainUi(this.root, {
      onView: (view) => void this.setView(view),
      onDims: (dims) => void this.setDims(dims),
      onFilter: (filter) => this.applyFilter(filter),
      onSearch: (text) => this.runSearch(text),
      onSearchPick: (index) => this.pickSearchHit(index),
      onExport: () => this.exportPng(),
      onReset: () => this.interaction.resetView(),
      onPathMode: (on) => this.interaction.setPathMode(on),
    });
    this.ui.onMinimapClick((fx, fy) => this.minimapClick(fx, fy));

    this.bindResize();
    this.startClock();
  }

  /* ------------------------------------------------------------------ *
   * 启动
   * ------------------------------------------------------------------ */

  /** 加载数据 + 首次布局。 */
  async boot(): Promise<void> {
    const launch = readLaunchParams(window.location.search);
    this.view = launch.view;
    this.focusId = launch.focus;
    this.setStatus('正在加载图数据…');
    const outcome = await this.load(this.view);
    this.setStatus(outcome.error ? '已切换到演示数据' : '加载完成，耗时 ' + outcome.tookMs.toFixed(0) + 'ms');
    await this.rebuild(true);
    this.applyFocus();
  }

  /** 拉取某个视图的数据；失败时 fetchGraph 已给出带水印的演示数据。 */
  private async load(view: ViewKind): Promise<{ error: string | null; tookMs: number }> {
    const outcome = await fetchGraph(view, this.filter.scope, 2000);
    this.lastFetch = { view, ok: !outcome.error, nodes: outcome.graph.nodes.length, error: outcome.error };
    this.fullGraph = outcome.graph;
    this.note = outcome.error
      ? '后端 /api/graph 不可用（' + outcome.error + '），当前为内置演示数据'
      : '数据来自 /api/graph';
    return { error: outcome.error, tookMs: outcome.tookMs };
  }

  /** 启动参数 focus=<id>：在当前视图里找到该节点并选中（带相机转场）。 */
  private applyFocus(): void {
    const id = this.focusId;
    if (!id || !this.state) return;
    const index = this.state.graph.nodes.findIndex((node) => node.id === id);
    if (index >= 0) {
      this.focusId = '';
      this.interaction.select(index, 1, true);
    } else {
      this.setStatus('当前视图里没有节点 ' + id);
    }
  }

  /**
   * 视图切换：**每次**都向后端要该视图的数据。
   * 1.0.0 一旦落到演示数据就不再请求（后端起来了也看不到真数据），
   * 而在真数据模式下请求失败又会悄悄换成演示图——两种都不如实。
   */
  async setView(view: ViewKind): Promise<void> {
    if (this.view === view && this.state) return;
    this.view = view;
    const seq = ++this.viewSeq;
    // 进入层级视图时**先**把投影定下来再重建布局：布局的 dims 与相机是一对，
    // 顺序反了会先按 3D 布局建好图、再切成 2D 正交，画面就成了"从正面看的 3D 树"。
    this.dims = view === 'hierarchy' ? (this.dims === 2 ? 2 : 3) : 3;
    this.scene.setProjection(view === 'hierarchy' && this.dims === 2 ? '2d' : 'perspective');
    this.setStatus('正在加载' + (VIEW_LABEL[view] ?? view) + '…');
    const outcome = await this.load(view);
    if (seq !== this.viewSeq) return;
    await this.rebuild(true);
    this.interaction.resetSelection();
    this.applyFocus();
    this.setStatus((VIEW_LABEL[view] ?? view) + (outcome.error ? '（演示数据）' : ''));
  }

  /** 2D / 3D 切换（仅 hierarchy）。 */
  async setDims(dims: 2 | 3): Promise<void> {
    // 即使 dims 没变也要重跑：用户可能在 3D 视图下切回 2D 想"重新按 2D 布局"。
    this.dims = dims;
    if (this.view === 'hierarchy') {
      // 先切投影再重建：布局维度与相机必须同步，取景也要按目标相机算。
      this.scene.setProjection(dims === 2 ? '2d' : 'perspective');
      await this.rebuild(true);
      this.interaction.resetSelection();
    }
  }

  /* ------------------------------------------------------------------ *
   * 布局 + 重建
   * ------------------------------------------------------------------ */

  /** 重新布局并重建所有图层。 */
  private async rebuild(refit: boolean): Promise<void> {
    const graph = this.fullGraph;
    if (!graph) return;
    const filtered = this.filterGraph(graph);
    this.ui.renderLegend(filtered, this.colorMap(filtered));
    this.ui.renderScopes(Array.from(new Set(graph.nodes.map((n) => n.scope).filter(Boolean))));
    this.ui.render(this.uiState(true, 0, 0));

    const layoutNodes: LayoutNode[] = filtered.nodes.map((node) => ({
      id: node.id,
      degree: node.degree,
      importance: node.importance,
      time: node.time,
      kind: node.kind,
      parent: node.parent,
      // 证据视图的三层：记忆(0) → 证据(1) → 来源(2)
      layer: filtered.view === 'evidence' ? evidenceLayer(node.kind) : undefined,
    }));
    const layoutEdges: LayoutEdge[] = filtered.edges.map((edge) => ({
      src: edge.src, dst: edge.dst, weight: edge.weight,
    }));
    const opts = defaultOptions(filtered.view, filtered.nodes.length, this.dims);
    if (filtered.view === 'hierarchy') {
      // 层级视图必须真的走 2D 布局（z 恒为 0）：否则正交相机只是从正面看一棵
      // 3D 径向树，"2D 正交"就名不副实，节点也会在深度方向叠在一起。
      opts.dims = this.dims;
      opts.radial = this.dims === 3;
    }

    const started = performance.now();
    let result;
    try {
      result = await this.layoutClient.run(filtered.view, layoutNodes, layoutEdges, opts);
      this.layoutError = null;
    } catch (err) {
      // worker 失败（被 superseded 或崩了）：主线程同步兜底，保证界面不空白。
      // 但**必须记录**失败原因，否则"视图切了却没反应"会变成一个查不出的哑谜。
      this.layoutError = err instanceof Error ? err.message : String(err);
      result = runLayout(filtered.view, layoutNodes, layoutEdges, opts);
    }
    if (this.disposed) return;
    this.lastLayoutMs = performance.now() - started;
    this.layoutTrace.push({
      view: filtered.view, dims: opts.dims, radial: opts.radial,
      resultDims: result.dims, n: filtered.nodes.length,
    });
    if (this.layoutTrace.length > 6) this.layoutTrace.shift();

    // 索引 + 邻接表
    const index = new Map<string, number>();
    filtered.nodes.forEach((node, i) => index.set(node.id, i));
    const neighbors: number[][] = new Array(filtered.nodes.length);
    for (let i = 0; i < neighbors.length; i++) neighbors[i] = [];
    for (const edge of filtered.edges) {
      const a = index.get(edge.src);
      const b = index.get(edge.dst);
      if (a === undefined || b === undefined || a === b) continue;
      neighbors[a].push(b);
      neighbors[b].push(a);
    }

    const renderPositions = new Float32Array(result.positions);
    this.state = {
      graph: filtered,
      positions: result.positions,
      renderPositions,
      index,
      neighbors,
      dims: result.dims,
    };

    // 图层重建。世界单位必须先于矩阵写入定下来：布局半径差异能到 20 倍，
    // 节点大小必须跟着缩放，否则小图看不见、大图糊屏。
    const layoutRadius = worldRadius(this.state);
    // 层级的槽间距是 1 个"世界单位"（layout.ts 的 nodeWidth），跨度是按节点数
    // 算出来的，跟力导向的球形半径不是一个量纲；直接套 worldUnitFor 会让节点
    // 挤成一片。这里按"同一层能放下的节点数"推到像素上标定。
    const unit = filtered.view === 'hierarchy'
      ? hierarchyUnit()
      : worldUnitFor(layoutRadius);
    this.nodes.setWorldUnit(unit);
    this.nodes.build(filtered, renderPositions);
    this.edges.setOpacity(1);
    this.edges.build(
      filtered,
      renderPositions,
      index,
    );
    this.interaction.resetSelection();
    this.updateViewport(true);

    if (refit) {
      // 首帧必须**直接就位**（setPose 同时写当前值与目标值），不能从默认机位
      // 阻尼滑过来：那样加载后的头半秒画面还在飞，用户点哪都点不准（拾取用的是
      // 当帧相机，而眼睛看到的是下一帧）。
      // 层级 2D 是一张平铺的树（z=0）：必须正对着看，否则默认的俯仰角会把整棵树
      // 压成一条斜线，节点在屏幕上挤成一团、标签无处可放。
      const flat = filtered.view === 'hierarchy' && this.dims === 2;
      if (flat) {
        // 极角 ≈ 90°（在赤道面上平视）+ 方位角 0：屏幕 x = 世界 x，屏幕 y = 世界 y
        this.scene.setPose(new Vector3(0, 0, 0), this.scene.frameRadius(layoutRadius), 0, Math.PI / 2);
      } else {
        this.scene.setPose(new Vector3(0, 0, 0), this.scene.frameRadius(layoutRadius));
      }
      if (this.scene.projectionMode !== 'perspective') {
        // 正交取景必须按**真实包围盒**算：层级树是宽扁的（x 跨度大、y 只有几层），
        // 只按半径取景会把垂直方向压扁成一条带子，层级完全看不出来。
        const b = boundingBox(this.state.positions, filtered.nodes.length);
        const halfW = Math.max(1, (b.maxX - b.minX) / 2);
        const halfHWorld = Math.max(1, (b.maxY - b.minY) / 2);
        const aspect = Math.max(0.2, this.viewport.width / Math.max(1, this.viewport.height));
        // 视口半高（世界单位）要同时容纳：垂直半高，以及水平半高换算过来的高度
        const halfH = Math.max(halfHWorld, halfW / aspect) * 1.16;
        this.scene.setPose(new Vector3((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, 0),
          this.scene.frameRadius(layoutRadius), 0, Math.PI / 2);
        this.scene.fitOrtho(halfH);
      }
    }
    this.ui.render(this.uiState(false, filtered.nodes.length, filtered.edges.length));
    this.setStatus(
      '布局 ' + this.lastLayoutMs.toFixed(0) + 'ms · ' +
      filtered.nodes.length + ' 节点 / ' + filtered.edges.length + ' 边',
    );
  }

  /** 过滤：kind / scope / 时间范围。 */
  /**
   * 按当前过滤条件裁剪图，并把 **view 改写为当前视图**。
   *
   * 这个 bug 很隐蔽：filterGraph 在没有过滤时会直接把原始 graph 返回，而那个对象的
   * view 永远是"第一次拉取时的视图"（semantic）。于是切到层级/时间线后，
   * 重算的仍然是词义力导向布局——四种视图看着一模一样，而且没有任何报错。
   */
  private filterGraph(graph: BrainGraph): BrainGraph {
    const { kinds, scope, range } = this.filter;
    const cutoff = range === 'all' ? 0 : Date.now() - Number(range.replace('d', '')) * 86400000;
    const keep = (node: BrainGraph['nodes'][number]): boolean => {
      if (kinds.size && !kinds.has(node.kind)) return false;
      if (scope && node.scope !== scope) return false;
      if (cutoff && node.time && node.time < cutoff) return false;
      return true;
    };
    const nodes = graph.nodes.filter(keep);
    const ids = new Set(nodes.map((n) => n.id));
    const edges = graph.edges.filter((e) => ids.has(e.src) && ids.has(e.dst));
    return { ...graph, view: this.view, nodes, edges };
  }

  /** 应用过滤（事件触发）。 */
  private applyFilter(filter: FilterState): void {
    this.filter = filter;
    void this.rebuild(false);
  }

  private colorMap(graph: BrainGraph): Record<string, string> {
    const out: Record<string, string> = {};
    for (const node of graph.nodes) out[node.kind] = kindColor(node.kind);
    out.default = kindColor('default');
    return out;
  }

  /* ------------------------------------------------------------------ *
   * 渲染循环
   * ------------------------------------------------------------------ */

  private startClock(): void {
    this.fpsWindowStart = performance.now();
    const loop = (now: number): void => {
      if (this.disposed) return;
      this.rafId = requestAnimationFrame(loop);
      this.frame(now);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  private frame(now: number): void {
    const state = this.state;
    // 帧率统计（每 500ms 刷新一次，避免数字乱跳）
    this.frameCount++;
    if (now - this.fpsWindowStart >= 500) {
      this.fps = (this.frameCount * 1000) / (now - this.fpsWindowStart);
      this.frameCount = 0;
      this.fpsWindowStart = now;
      this.adjustLod();
    }

    if (state) {
      // 1) 相机（阻尼/转场）
      this.scene.update(now);
      // 2) 邻居外推 + 选中放大 + 实例矩阵（O(n)）
      this.interaction.applyDisplacement(1 / 60);
      // 3) 选中光环
      this.nodes.updateHalo(now, state.renderPositions);
      // 4) 相机每帧都在动 → 视锥必须每帧重算，否则标签会按上一帧的视野做剔除
      this.refreshFrustum();
      // 5) 标签：视锥 + 优先级 + 避让
      this.updateLabels(now);
    }
    // 5) 渲染：主场景 + 标签叠加层（autoClear=false，同一个 renderer 画两遍）
    //
    //    注意 renderer.info 每次 render() 都会重置，所以必须自己把两遍的计数加起来，
    //    否则统计面板显示的是"最后一遍"的 draw call（标签层），数字没有意义。
    const renderer = this.scene.renderer;
    renderer.autoClear = true;
    renderer.render(this.scene.scene, this.scene.camera);
    const mainCalls = renderer.info.render.calls;
    const mainTriangles = renderer.info.render.triangles;
    renderer.autoClear = false;
    renderer.render(this.nodes.overlayScene, this.nodes.overlayCamera);
    renderer.autoClear = true;
    this.lastCalls = mainCalls + renderer.info.render.calls;
    this.lastTriangles = mainTriangles + renderer.info.render.triangles;

    // 6) UI 低频刷新：mini-map 5Hz、面板 2Hz（用累计时间而不是取模，帧对齐才可靠）
    if (state && now - this.lastMinimapAt > 200) {
      this.lastMinimapAt = now;
      this.ui.drawMinimap(
        state.renderPositions,
        state.graph.nodes.map((n) => n.kind),
        this.colorMap(state.graph),
        this.interaction.selection,
      );
    }
    if (state && now - this.lastPanelAt > 500) {
      this.lastPanelAt = now;
      this.ui.render(this.uiState(false, state.graph.nodes.length, state.graph.edges.length));
    }
  }

  /** 标签更新：优先选中 → 邻居 → 度数。 */
  private updateLabels(now: number): void {
    const state = this.state;
    if (!state) return;
    const selected = this.interaction.selection;
    const neighborSet = new Set(this.interaction.selectedNeighbors);
    const priority = new Float32Array(state.graph.nodes.length);
    for (let i = 0; i < state.graph.nodes.length; i++) {
      let p = state.graph.nodes[i].degree + state.graph.nodes[i].importance * 3;
      if (neighborSet.has(i)) p += 1000;
      if (i === selected) p += 10000;
      priority[i] = p;
    }
    this.nodes.updateLabels(
      this.frustum,
      (i, out) => {
        this.tmpVec.set(state.renderPositions[i * 3], state.renderPositions[i * 3 + 1], state.renderPositions[i * 3 + 2]);
        this.tmpVec.project(this.scene.camera);
        out.x = (this.tmpVec.x * 0.5 + 0.5) * this.viewport.width;
        out.y = (-this.tmpVec.y * 0.5 + 0.5) * this.viewport.height;
        return out;
      },
      priority,
      state.renderPositions,
      this.viewport,
    );
    void now;
    void this.tmp2;
  }

  /* ------------------------------------------------------------------ *
   * LOD / 视口 / 交互
   * ------------------------------------------------------------------ */

  /** 掉帧降级 / 恢复升级（带防抖的状态机）。 */
  private adjustLod(): void {
    if (this.fps <= 0) return;
    if (this.fps < LOW_FPS) {
      this.lowStreak++;
      this.highStreak = 0;
    } else if (this.fps > HIGH_FPS) {
      this.highStreak++;
      this.lowStreak = 0;
    } else {
      this.lowStreak = 0;
      this.highStreak = 0;
    }
    if (this.lodLevel === 'high' && this.lowStreak >= LOD_WINDOW) {
      this.lodLevel = 'low';
      this.labelBudget = Math.max(24, Math.floor(DEFAULT_LABEL_BUDGET / 2));
      this.nodes.setLabelBudget(this.labelBudget);
      this.nodes.setLod('low');
      this.edges.setBow(0.1);
      this.setStatus('帧率 ' + this.fps.toFixed(0) + ' fps，已降到低 LOD（标签 ' + this.labelBudget + '）');
    } else if (this.lodLevel === 'low' && this.highStreak >= LOD_WINDOW * 3) {
      this.lodLevel = 'high';
      this.labelBudget = DEFAULT_LABEL_BUDGET;
      this.nodes.setLabelBudget(this.labelBudget);
      this.nodes.setLod('high');
      this.edges.setBow(0.22);
      this.setStatus('帧率恢复，已升回高 LOD');
    }
  }

  /** 只重算视锥（每帧调用：相机一直在动）。 */
  private refreshFrustum(): void {
    const camera = this.scene.camera;
    camera.updateMatrixWorld();
    this.projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projScreen);
  }

  /** 视口与相机矩阵同步（窗口变化 / 切投影时调用）。 */
  private updateViewport(resetCamera: boolean): void {
    const width = this.root.clientWidth || window.innerWidth;
    const height = this.root.clientHeight || window.innerHeight;
    this.viewport = { width, height };
    this.scene.resize();
    this.nodes.resizeOverlay(width, height);
    const camera = this.scene.camera;
    camera.updateMatrixWorld();
    if (camera instanceof Object && 'updateProjectionMatrix' in camera) {
      (camera as { updateProjectionMatrix: () => void }).updateProjectionMatrix();
    }
    this.projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projScreen);
    if (resetCamera) this.scene.update(performance.now());
  }

  private bindResize(): void {
    let pending = false;
    const handler = (): void => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        this.updateViewport(false);
        if (this.state) {
          const radius = worldRadius(this.state);
          this.scene.reset(this.scene.frameRadius(radius));
        }
      });
    };
    window.addEventListener('resize', handler);
    this.resizeHandler = handler;
  }

  private resizeHandler: (() => void) | null = null;

  private onSelect(index: number): void {
    const state = this.state;
    if (!state || index < 0) {
      this.setStatus('未选中');
      return;
    }
    const node = state.graph.nodes[index];
    this.setStatus(
      '选中：' + node.label + '（' + (KIND_LABEL[node.kind] ?? node.kind) + '）· ' +
      (state.neighbors[index]?.length ?? 0) + ' 条直连 · ' +
      this.interaction.selectedNeighbors.length + ' 个高亮',
    );
  }

  /* ------------------------------------------------------------------ *
   * 搜索 / mini-map / 导出
   * ------------------------------------------------------------------ */

  private runSearch(text: string): void {
    const state = this.state;
    if (!state) return;
    if (!text) { this.ui.renderSearch([]); return; }
    const needle = text.toLowerCase();
    const hits: Array<{ index: number; label: string; kind: string }> = [];
    for (let i = 0; i < state.graph.nodes.length && hits.length < 40; i++) {
      const node = state.graph.nodes[i];
      if (node.label.toLowerCase().includes(needle) || node.id.toLowerCase().includes(needle)) {
        hits.push({ index: i, label: node.label, kind: node.kind });
      }
    }
    this.ui.renderSearch(hits);
    this.ui.setStatus(hits.length ? '找到 ' + hits.length + ' 个节点' : '没有匹配的节点');
  }

  private pickSearchHit(index: number): void {
    if (index < 0) return;
    this.interaction.select(index, 1, true);
    this.ui.renderSearch([]);
  }

  /** mini-map 点击 → 把 target 平移到对应位置。 */
  private minimapClick(fx: number, fy: number): void {
    const state = this.state;
    if (!state) return;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < state.graph.nodes.length; i++) {
      const x = state.renderPositions[i * 3];
      const y = state.renderPositions[i * 3 + 1];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const target = new Vector3(
      minX + (maxX - minX) * fx,
      minY + (maxY - minY) * (1 - fy),
      0,
    );
    this.scene.setPose(target, this.scene.currentDistance);
  }

  /** 导出当前画面为 PNG。重绘一帧再取图，避免空白。 */
  private exportPng(): void {
    const renderer = this.scene.renderer;
    renderer.autoClear = true;
    renderer.render(this.scene.scene, this.scene.camera);
    renderer.autoClear = false;
    renderer.render(this.nodes.overlayScene, this.nodes.overlayCamera);
    renderer.autoClear = true;
    const url = this.canvas.toDataURL('image/png');
    const link = document.createElement('a');
    link.href = url;
    link.download = 'memora-brain-' + this.view + '-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '') + '.png';
    link.click();
    this.setStatus('已导出 PNG');
  }

  /* ------------------------------------------------------------------ *
   * 杂项
   * ------------------------------------------------------------------ */

  private setStatus(text: string): void {
    if (this.statusText === text) return;
    this.statusText = text;
    this.ui.setStatus(text);
  }

  /**
   * 对外自检接口（window.__memBrain.__debug）。
   *
   * 无头测试要靠它读回真实运行状态：draw call 数、标签数、选中项、转场是否在跑。
   * 这些"只有跑起来才知道"的事实，单测推断不出来。
   */
  get __debug(): Record<string, unknown> {
    return {
      ready: this.state !== null,
      nodes: this.nodes.count,
      edges: this.edges.segments,
      calls: this.lastCalls,
      triangles: this.lastTriangles,
      labels: this.nodes.labelCount,
      fps: Math.round(this.fps),
      view: this.view,
      dims: this.dims,
      demo: this.fullGraph?.demo === true,
      lastFetch: this.lastFetch,
      layoutMode: this.layoutClient.mode,
      layoutMs: Math.round(this.lastLayoutMs),
      layoutError: this.layoutError,
      layoutTrace: this.layoutTrace,
      labelStats: this.nodes.labelStats,
      selection: this.interaction.selection,
      flightActive: this.scene.flight.active,
      projection: this.scene.projectionMode,
      lod: this.lodLevel,
      labelBudget: this.labelBudget,
      status: this.statusText,
      uiState: this.uiState(false, 0, 0),
    };
  }

  /** 自检用：交互层收到的事件计数（验证 DOM 事件真的到达了）。 */
  get __events(): Record<string, number> {
    return this.interaction.eventCounts;
  }

  /** 自检用：最近一次拾取的诊断。 */
  get __lastPick(): Record<string, number> {
    return this.interaction.lastPick;
  }

  /** 自检用：实例矩阵抽样（找出异常大的实例）。 */
  __instanceProbe(): Record<string, unknown> {
    const state = this.state;
    if (!state) return { none: true };
    const mesh = this.nodes.mesh;
    const matrices: Array<Record<string, number>> = [];
    let maxWorldRadius = 0;
    let maxIndex = -1;
    const m = new Matrix4();
    for (let i = 0; i < state.graph.nodes.length; i++) {
      mesh.getMatrixAt(i, m);
      const scale = Math.max(
        Math.hypot(m.elements[0], m.elements[1], m.elements[2]),
        Math.hypot(m.elements[4], m.elements[5], m.elements[6]),
        Math.hypot(m.elements[8], m.elements[9], m.elements[10]),
      );
      if (scale > maxWorldRadius) { maxWorldRadius = scale; maxIndex = i; }
      if (i < 4) matrices.push({ i, scale, tx: m.elements[12], ty: m.elements[13], tz: m.elements[14] });
    }
    return {
      worldUnit: this.nodes.worldUnit,
      drawCount: this.nodes.count,
      instanceCount: mesh.instanceMatrix.count,
      layoutRadius: worldRadius(state),
      maxWorldRadius,
      maxIndex,
      maxDegree: maxIndex >= 0 ? state.graph.nodes[maxIndex].degree : -1,
      maxImportance: maxIndex >= 0 ? state.graph.nodes[maxIndex].importance : -1,
      samples: matrices,
    };
  }

  /** 自检用：投影诊断（前几个节点的 clip 空间坐标与相机状态）。 */
  __projectionProbe(): Record<string, unknown> {
    const state = this.state;
    if (!state) return { none: true };
    const camera = this.scene.camera;
    const samples: Array<Record<string, number>> = [];
    for (let i = 0; i < Math.min(3, state.graph.nodes.length); i++) {
      const v = new Vector3(
        state.renderPositions[i * 3],
        state.renderPositions[i * 3 + 1],
        state.renderPositions[i * 3 + 2],
      ).project(camera);
      samples.push({ x: v.x, y: v.y, z: v.z });
    }
    return {
      samples,
      camPos: [camera.position.x, camera.position.y, camera.position.z],
      camNear: (camera as unknown as { near: number }).near,
      camFar: (camera as unknown as { far: number }).far,
      isPerspective: (camera as unknown as { isPerspectiveCamera?: boolean }).isPerspectiveCamera === true,
      mwi: camera.matrixWorldInverse.elements.slice(12, 15),
      mw: camera.matrixWorld.elements.slice(12, 15),
      proj: camera.projectionMatrix.elements.slice(10, 15),
    };
  }

  /** 自检用：装载一份指定规模的图（性能护栏测试用）。 */
  __loadScale(count: number): Promise<void> {
    this.fullGraph = scaleGraph(count);
    this.note = '规模自检：' + count + ' 个合成节点';
    return this.rebuild(true);
  }

  /** 自检用：选中外推的位移量（验证"邻居径向外推 + 选中放大"真的发生了）。 */
  __displacement(): Record<string, unknown> {
    const state = this.state;
    if (!state) return { none: true };
    const sel = this.interaction.selection;
    const nbs = this.interaction.selectedNeighbors;
    if (sel < 0) return { selected: -1, maxPush: 0, selectedScale: 0 };
    let maxPush = 0;
    for (const nb of nbs.slice(0, 50)) {
      const dx = state.renderPositions[nb * 3] - state.positions[nb * 3];
      const dy = state.renderPositions[nb * 3 + 1] - state.positions[nb * 3 + 1];
      const dz = state.renderPositions[nb * 3 + 2] - state.positions[nb * 3 + 2];
      maxPush = Math.max(maxPush, Math.hypot(dx, dy, dz));
    }
    const m = new Matrix4();
    this.nodes.mesh.getMatrixAt(sel, m);
    const scale = Math.hypot(m.elements[0], m.elements[1], m.elements[2]);
    const m2 = new Matrix4();
    const other = nbs.length ? nbs[0] : 0;
    this.nodes.mesh.getMatrixAt(other, m2);
    const otherScale = Math.hypot(m2.elements[0], m2.elements[1], m2.elements[2]);
    return {
      selected: sel, neighbors: nbs.length, maxPush,
      selectedScale: scale, neighborScale: otherScale,
      ratio: otherScale > 0 ? scale / otherScale : 0,
    };
  }

  /** 自检用：缩放（验证标签预算随可见度变化）。 */
  __zoomForTest(deltaY: number): void {
    this.scene.zoom(deltaY);
  }

  /** 自检用：导出 PNG（返回 data URL 长度，避免真的触发下载）。 */
  __exportDataUrl(): string {
    const renderer = this.scene.renderer;
    renderer.autoClear = true;
    renderer.render(this.scene.scene, this.scene.camera);
    renderer.autoClear = false;
    renderer.render(this.nodes.overlayScene, this.nodes.overlayCamera);
    renderer.autoClear = true;
    return this.canvas.toDataURL('image/png');
  }

  /** 自检用：当前状态摘要（布局维度 / 投影 / 包围盒）。 */
  __layoutInfo(): Record<string, unknown> {
    const state = this.state;
    if (!state) return { none: true };
    let minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < state.graph.nodes.length; i++) {
      minY = Math.min(minY, state.positions[i * 3 + 1]);
      maxY = Math.max(maxY, state.positions[i * 3 + 1]);
      minZ = Math.min(minZ, state.positions[i * 3 + 2]);
      maxZ = Math.max(maxZ, state.positions[i * 3 + 2]);
    }
    return {
      view: this.view,
      dimsOption: this.dims,
      layoutDims: state.dims,
      projection: this.scene.projectionMode,
      ySpan: maxY - minY,
      zSpan: maxZ - minZ,
      orthoZoom: (this.scene as unknown as { orthoZoom: number }).orthoZoom,
      parented: state.graph.nodes.filter((n) => n.parent).length,
    };
  }

  /** 自检用：切视图（走和 UI 按钮完全相同的路径）。 */
  async __setView(view: ViewKind): Promise<void> {
    await this.setView(view);
  }

  /** 自检用：切 2D/3D。 */
  async __setDims(dims: 2 | 3): Promise<void> {
    await this.setDims(dims);
  }

  /** 自检用：跑一次搜索。 */
  __search(text: string): Array<{ index: number; label: string }> {
    const state = this.state;
    if (!state) return [];
    const needle = text.toLowerCase();
    const hits: Array<{ index: number; label: string }> = [];
    for (let i = 0; i < state.graph.nodes.length && hits.length < 10; i++) {
      const node = state.graph.nodes[i];
      if (node.label.toLowerCase().includes(needle)) hits.push({ index: i, label: node.label });
    }
    return hits;
  }

  /** 自检用：路径查找（返回跳数）。 */
  __path(from: number, to: number): number[] {
    const state = this.state;
    if (!state) return [];
    return shortestPath(state.neighbors, from, to);
  }

  /** 自检用：按屏幕坐标拾取（和交互层同一套逻辑）。 */
  __pick(clientX: number, clientY: number): number {
    return this.interaction.pick(clientX, clientY);
  }

  /** 自检用：选中某个节点。 */
  __select(index: number, hops: 1 | 2 = 1): void {
    this.interaction.select(index, hops, true);
  }

  /**
   * 自检用：把某个节点的世界坐标投到**页面视口**像素坐标。
   *
   * 无头测试必须知道"点哪里"才能验证拾取——盲点画布中心是不行的：
   * 布局是稀疏三维点云，正中心常常恰好没有节点。
   */
  __screenOf(index: number): { x: number; y: number } | null {
    const state = this.state;
    if (!state || index < 0 || index >= state.graph.nodes.length) return null;
    const rect = this.canvas.getBoundingClientRect();
    const v = new Vector3(
      state.renderPositions[index * 3],
      state.renderPositions[index * 3 + 1],
      state.renderPositions[index * 3 + 2],
    ).project(this.scene.camera);
    return { x: rect.left + (v.x * 0.5 + 0.5) * rect.width, y: rect.top + (-v.y * 0.5 + 0.5) * rect.height };
  }

  private uiState(loading: boolean, nodeCount: number, edgeCount: number): UiState {
    return {
      view: this.view,
      dims: this.dims,
      demo: this.fullGraph?.demo === true,
      loading,
      nodeCount: nodeCount || (this.state?.graph.nodes.length ?? 0),
      edgeCount: edgeCount || (this.state?.graph.edges.length ?? 0),
      fps: this.fps,
      labels: this.nodes.labelCount,
      layoutMode: this.layoutClient.mode,
      filter: this.filter,
      note: this.note || '',
    };
  }

  /**
   * 深空星尘：低密度 Points，提供空间参照（旋转时能感知景深）。
   * 数量刻意压到 1400：再多就会在深色背景上糊成噪点，反而掩盖节点。
   */
  private createStardust(): Points {
    const count = 1400;
    const positions = new Float32Array(count * 3);
    let seed = 987654321;
    const rnd = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let i = 0; i < count; i++) {
      // 球壳分布，半径 3200..13000：永远在布局主体之外，不参与拾取
      const u = rnd() * 2 - 1;
      const theta = rnd() * Math.PI * 2;
      const r = 3200 + rnd() * 9800;
      const s = Math.sqrt(1 - u * u);
      positions[i * 3] = Math.cos(theta) * s * r;
      positions[i * 3 + 1] = u * r;
      positions[i * 3 + 2] = Math.sin(theta) * s * r;
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    const material = new PointsMaterial({
      color: 0x86b8dc,
      size: 2.4,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
    });
    const points = new Points(geometry, material);
    points.frustumCulled = false;
    points.renderOrder = -1;
    return points;
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.rafId);
    if (this.resizeHandler) window.removeEventListener('resize', this.resizeHandler);
    this.interaction.dispose();
    this.ui.dispose();
    this.layoutClient.dispose();
    this.nodes.dispose();
    this.edges.dispose();
    this.scene.dispose();
  }
}

/**
 * 生成 N 个合成节点的图，用于规模护栏（5000 节点）验证。
 * 结构与演示数据一致：概念 → 术语 → 记忆，再叠加随机语义边。
 */
function scaleGraph(count: number): BrainGraph {
  const nodes: BrainGraph['nodes'] = [];
  const edges: BrainGraph['edges'] = [];
  const now = Date.now();
  let seed = 1234567;
  const rnd = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const terms: string[] = [];
  for (let t = 0; t < 40; t++) {
    const cid = 'c-' + t;
    nodes.push({ id: cid, label: '主题 ' + t, kind: 'concept', scope: 'synthetic', degree: 0, importance: 0.9, time: now, parent: null });
    for (let c = 0; c < 5; c++) {
      const tid = cid + '-' + c;
      terms.push(tid);
      nodes.push({ id: tid, label: '子主题 ' + t + '.' + c, kind: 'term', scope: 'synthetic', degree: 0, importance: 0.5, time: now, parent: cid });
      edges.push({ id: 'e-' + tid, src: cid, dst: tid, rel: 'hyponym', weight: 0.8, confidence: 0.9 });
    }
  }
  const remaining = Math.max(0, count - nodes.length);
  for (let i = 0; i < remaining; i++) {
    const id = 'm-' + i;
    const kind = ['fact', 'knowledge', 'decision', 'preference', 'procedure', 'experience', 'task'][i % 7];
    nodes.push({
      id, label: '记忆条目 ' + i, kind, scope: 'synthetic',
      degree: 0, importance: 0.2 + rnd() * 0.7,
      time: now - Math.floor(rnd() * 40) * 86400000,
      parent: terms[i % terms.length],
    });
    edges.push({ id: 'pe-' + i, src: terms[i % terms.length], dst: id, rel: 'mentions', weight: 0.5, confidence: 0.6 });
    for (let k = 0; k < 2; k++) {
      const target = 'm-' + Math.floor(rnd() * Math.max(1, remaining));
      if (target !== id) {
        edges.push({ id: 'se-' + i + '-' + k, src: id, dst: target, rel: 'semantic', weight: 0.3 + rnd() * 0.6, confidence: 0.5 });
      }
    }
  }
  const degree = new Map<string, number>();
  for (const e of edges) {
    degree.set(e.src, (degree.get(e.src) ?? 0) + 1);
    degree.set(e.dst, (degree.get(e.dst) ?? 0) + 1);
  }
  for (const n of nodes) n.degree = degree.get(n.id) ?? 0;
  return { view: 'semantic', nodes, edges, meta: { source: 'synthetic' }, demo: true };
}

/** 计算 positions 的轴对齐包围盒。 */
function boundingBox(positions: Float32Array, count: number) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < count; i++) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (!count) return { minX: 0, maxX: 0, minY: 0, maxY: 0 };
  return { minX, maxX, minY, maxY };
}

/**
 * 层级视图的世界单位。
 *
 * 层级布局的坐标里，同一层相邻节点的 x 间隔**恒为 1**（layout.ts 的 nodeWidth），
 * 所以"一个相对半径 = 多少世界单位"必须直接由这个 1 推出来：
 * 节点直径（≈ 2×相对半径 2.2~12）要明显小于槽距 1，否则球会糊在一起、
 * 层级关系完全看不出来。取槽距的 0.16 倍作为单位：
 *   最小节点 2.2×0.16 ≈ 0.35 单位（槽距的 35%）——看得见且有留白
 *   最大节点 12×0.16 ≈ 1.9 单位——会略微超过槽距，但高度数节点本来就该显眼
 * 之前按"布局半径 / sqrt(n)"估算，在 452 节点时得到 0.32 倍槽距，直接糊成一片。
 */
function hierarchyUnit(): number {
  return 0.16;
}

/** 证据视图的三层映射。 */
function evidenceLayer(kind: string): number {
  if (kind === 'source' || kind === 'document' || kind === 'chunk') return 2;
  if (kind === 'evidence') return 1;
  return 0;
}

/**
 * 找到（或造出）挂载点。
 *
 * 约定是 brain.html 提供 <div id="mem-brain">，但 build.mjs 当前生成的模板里有
 * 一个共享的 <div id="mem-root">（T7 的 app 也有），并且没有任何样式把 body 撑满。
 * 为了做到"只要有一个 div 就能跑"，这里按 #mem-brain → #mem-root → 自造节点
 * 依次尝试，并保证挂载节点是满视口的——否则 canvas 会按 300×150 的默认尺寸画。
 */
function resolveMount(): HTMLElement {
  const existing = document.getElementById('mem-brain')
    ?? document.getElementById('mem-root')
    ?? document.body.appendChild(Object.assign(document.createElement('div'), { id: 'mem-brain' }));
  if (existing.classList) existing.classList.add('mem-brain-host');
  return existing as HTMLElement;
}

/** 保证 body / html 也是满视口，否则客户端尺寸算出来是 0。 */
function ensureFullViewport(): void {
  const style = document.documentElement.style;
  style.height = '100%';
  style.margin = '0';
  style.background = '#070b12';
  const body = document.body.style;
  body.height = '100%';
  body.margin = '0';
  body.overflow = 'hidden';
  body.background = '#070b12';
}

/** 引导：等待 DOM 就绪后挂载。 */
function boot(): void {
  ensureFullViewport();
  void start(resolveMount());
}

async function start(mount: HTMLElement): Promise<void> {
  const app = new BrainApp(mount);
  const handle = app as unknown as { __ready?: boolean; __debug: unknown };
  (window as unknown as { __memBrain?: unknown }).__memBrain = handle;
  await app.boot();
  handle.__ready = true;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
