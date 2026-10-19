/**
 * 布局算法（纯函数，无 DOM/three 依赖，可被 Node 单测直接调用）：
 *   semantic  力导向 + Barnes-Hut 八叉树近似（θ 可调，每轮 O(n log n + m)）
 *   hierarchy Reingold-Tilford 变体（叶子槽位 + 父节点居中 + 同层防重叠），2D 正交 / 3D 径向
 *   timeline  按天分带的 Z 向时间轴（X 严格随时间单调，带内蛇形分层）
 *   evidence  记忆 → 证据 → 来源 的三层结构，层内按父节点聚类成扇区
 *
 * 三条实现约束：
 *  1. 内核写成自包含函数 {@link layoutKernel}：worker.ts 用 toString() 把它的源码塞进
 *     Blob 脚本，让主线程与 Worker 跑**同一份算法**而不需要 eval（页面 CSP 是
 *     script-src 'self'，blob: worker 继承该 CSP，eval/new Function 会被拒绝）。
 *     因此内核函数体内**不得**引用模块作用域的运行时变量，只能用参数、局部变量与内建对象。
 *  2. 全部随机性来自 mulberry32(seed)，同图同坐标，测试可复现。
 *  3. 坐标 y 轴朝上；hierarchy 的 2D 模式 z 恒为 0（正交相机下像素级清晰）。
 */
import type { LayoutEdge, LayoutNode, LayoutResult, ViewKind } from './types';

/** 布局参数（全部可选，缺省值在内核里）。 */
export interface LayoutOptions {
  /** 投影维度。hierarchy 可传 2；其余视图内部强制 3。 */
  dims?: 2 | 3;
  /** 力导向迭代轮数。 */
  iterations?: number;
  /** 期望边长（世界单位）。 */
  spacing?: number;
  /** 随机种子。 */
  seed?: number;
  /** Barnes-Hut 张角：0 表示精确 O(n²)，0.9 为常规精度。 */
  theta?: number;
  /** 层次布局：叶子槽间距。 */
  slotGap?: number;
  /** 层次布局：层间距。 */
  levelGap?: number;
  /** 层次布局：是否径向（3D 时默认 true）。 */
  radial?: boolean;
  /** 时间线：每天占用的 Z 向宽度。 */
  bandGap?: number;
  /** 证据视图：层间距。 */
  layerGap?: number;
  /** 本次布局声明的最小节点宽度；层次布局保证同层相邻节点 x 差 ≥ 该值。 */
  nodeWidth?: number;
}

/** 默认节点宽度（世界单位）：层次布局同层相邻节点的最小 x 间隔。 */
export const DEFAULT_NODE_WIDTH = 1;

/** 内核形状（主线程 / Worker / Node 测试三方共用）。 */
export interface LayoutKernel {
  semantic(nodes: LayoutNode[], edges: LayoutEdge[], opts: LayoutOptions): LayoutResult;
  hierarchy(nodes: LayoutNode[], edges: LayoutEdge[], opts: LayoutOptions): LayoutResult;
  timeline(nodes: LayoutNode[], edges: LayoutEdge[], opts: LayoutOptions): LayoutResult;
  evidence(nodes: LayoutNode[], edges: LayoutEdge[], opts: LayoutOptions): LayoutResult;
  /** 当前坐标下的平均残余力平方（与力导向迭代同口径）。 */
  energy(positions: ArrayLike<number>, nodes: LayoutNode[], edges: LayoutEdge[], opts: LayoutOptions): number;
}

/**
 * 自包含布局内核。
 *
 * ⚠️ 函数体会被 toString() 成源码在 Worker 里执行：只能使用参数、局部变量与 JS 内建对象。
 * 不要引用本模块的其它常量或函数，否则 Worker 侧会 ReferenceError。
 */
export function layoutKernel(): LayoutKernel {
  const EPS = 1e-9;
  const DAY_MS = 86400000;

  function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return function random(): number {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** id → 稳定种子：同一节点在任何进程里得到同一初始方向。 */
  function hash32(text: string): number {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
    return h >>> 0;
  }

  function optNum(value: number | undefined, fallback: number): number {
    return typeof value === 'number' && isFinite(value) && value > 0 ? value : fallback;
  }

  function emptyResult(dims: 2 | 3): LayoutResult {
    return { positions: new Float32Array(0), dims, meta: { radius: 1 } };
  }

  function center(px: Float64Array, py: Float64Array, pz: Float64Array, n: number): void {
    let cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < n; i++) { cx += px[i]; cy += py[i]; cz += pz[i]; }
    cx /= n; cy /= n; cz /= n;
    for (let i = 0; i < n; i++) { px[i] -= cx; py[i] -= cy; pz[i] -= cz; }
  }

  function pack(
    px: Float64Array, py: Float64Array, pz: Float64Array, n: number, dims: 2 | 3,
    extra: Record<string, unknown>,
  ): LayoutResult {
    const out = new Float32Array(n * 3);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < n; i++) {
      out[i * 3] = px[i]; out[i * 3 + 1] = py[i]; out[i * 3 + 2] = pz[i];
      if (px[i] < minX) minX = px[i];
      if (px[i] > maxX) maxX = px[i];
      if (py[i] < minY) minY = py[i];
      if (py[i] > maxY) maxY = py[i];
      if (pz[i] < minZ) minZ = pz[i];
      if (pz[i] > maxZ) maxZ = pz[i];
    }
    if (!n) { minX = maxX = minY = maxY = minZ = maxZ = 0; }
    const span = Math.max(maxX - minX, maxY - minY, dims === 3 ? maxZ - minZ : 0);
    const meta: LayoutResult['meta'] = {
      radius: Math.max(1, span * 0.5),
      bounds: { minX, maxX, minY, maxY, minZ, maxZ },
      ...extra,
    };
    return { positions: out, dims, meta };
  }

  /* ================================================================== *
   * Barnes-Hut 八叉树
   *  - 扁平 typed array；存储对象在多次迭代间复用，只扩容不重分配；
   *  - partition 构建（每层把成员重排进 8 个桶），O(n log n)，无递归；
   *  - 查询显式栈 + 预分配 scratch，避免每点分配。
   * ================================================================== */
  interface TreeStore {
    mass: Float64Array;
    comX: Float64Array; comY: Float64Array; comZ: Float64Array;
    half: Float64Array;
    child: Int32Array;
    start: Int32Array; count: Int32Array;
    points: Int32Array;
    root: number;
    cells: number;
    /** 双缓冲索引（partition 构建用），随容量复用。 */
    bufA: Int32Array;
    bufB: Int32Array;
    /** 显式栈：8 个 float 一帧（lo/hi/cx/cy/cz/half + 填充），2 个 int 一帧（cell/depth）。 */
    stackF: Float64Array;
    stackI: Int32Array;
  }

  function createTreeStore(): TreeStore {
    return {
      mass: new Float64Array(0),
      comX: new Float64Array(0), comY: new Float64Array(0), comZ: new Float64Array(0),
      half: new Float64Array(0),
      child: new Int32Array(0), start: new Int32Array(0), count: new Int32Array(0),
      points: new Int32Array(0),
      root: 0, cells: 0,
      bufA: new Int32Array(0), bufB: new Int32Array(0),
      stackF: new Float64Array(0), stackI: new Int32Array(0),
    };
  }

  /**
   * 构建八叉树。T 的缓冲区按需扩容；返回 T（复用同一对象）。
   * 质量/质心在构建时自底向上算好，查询阶段只读。
   */
  function buildTree(
    T: TreeStore, px: Float64Array, py: Float64Array, pz: Float64Array, n: number,
  ): TreeStore {
    if (!n) { T.cells = 0; T.root = -1; return T; }
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < n; i++) {
      if (px[i] < minX) minX = px[i];
      if (py[i] < minY) minY = py[i];
      if (pz[i] < minZ) minZ = pz[i];
      if (px[i] > maxX) maxX = px[i];
      if (py[i] > maxY) maxY = py[i];
      if (pz[i] > maxZ) maxZ = pz[i];
    }
    const rootX = (minX + maxX) / 2, rootY = (minY + maxY) / 2, rootZ = (minZ + maxZ) / 2;
    const rootHalf = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1e-6) / 2;

    const cap = Math.max(64, n * 2 + 8);
    if (T.mass.length < cap) {
      T.mass = new Float64Array(cap);
      T.comX = new Float64Array(cap); T.comY = new Float64Array(cap); T.comZ = new Float64Array(cap);
      T.half = new Float64Array(cap);
      T.child = new Int32Array(cap * 8);
      T.start = new Int32Array(cap); T.count = new Int32Array(cap);
    }
    if (T.points.length < n) T.points = new Int32Array(n);

    const { mass, comX, comY, comZ, half, child, start, count, points } = T;
    let cells = 0;
    let cursor = 0;

    if (T.bufA.length < n) { T.bufA = new Int32Array(n); T.bufB = new Int32Array(n); }
    let src = T.bufA, dst = T.bufB;
    for (let i = 0; i < n; i++) src[i] = i;

    // 显式栈：每条 push 一帧，partition 阶段最多堆到 n+8 帧。
    const stackCap = Math.max(64, n + 8);
    if (T.stackF.length < stackCap * 8) {
      T.stackF = new Float64Array(stackCap * 8);
      T.stackI = new Int32Array(stackCap * 2);
    }
    const stF = T.stackF;
    const stI = T.stackI;
    let sp = 0;

    function alloc(h: number, cx: number, cy: number, cz: number): number {
      const id = cells++;
      half[id] = h;
      comX[id] = cx; comY[id] = cy; comZ[id] = cz;
      mass[id] = 0; start[id] = -1; count[id] = 0;
      const base = id * 8;
      child[base] = -1; child[base + 1] = -1; child[base + 2] = -1; child[base + 3] = -1;
      child[base + 4] = -1; child[base + 5] = -1; child[base + 6] = -1; child[base + 7] = -1;
      return id;
    }

    const root = alloc(rootHalf, rootX, rootY, rootZ);
    // 栈帧：cell, lo, hi, cx, cy, cz, half, depth
    stI[sp * 2] = root; stI[sp * 2 + 1] = 0;
    stF[sp * 8] = 0; stF[sp * 8 + 1] = n;
    stF[sp * 8 + 2] = rootX; stF[sp * 8 + 3] = rootY; stF[sp * 8 + 4] = rootZ;
    stF[sp * 8 + 5] = rootHalf; stF[sp * 8 + 6] = 0;
    sp++;

    const counts = new Int32Array(8);
    const offsets = new Int32Array(8);
    const cursors = new Int32Array(8);

    while (sp > 0) {
      sp--;
      const cell = stI[sp * 2];
      const depth = stI[sp * 2 + 1];
      const lo = stF[sp * 8], hi = stF[sp * 8 + 1];
      const ccx = stF[sp * 8 + 2], ccy = stF[sp * 8 + 3], ccz = stF[sp * 8 + 4];
      const ch = stF[sp * 8 + 5];
      const cnt = hi - lo;
      let sx = 0, sy = 0, sz = 0;
      for (let k = lo; k < hi; k++) { const i = src[k]; sx += px[i]; sy += py[i]; sz += pz[i]; }
      mass[cell] = cnt;
      comX[cell] = sx / cnt; comY[cell] = sy / cnt; comZ[cell] = sz / cnt;
      count[cell] = cnt;
      if (cnt <= 1 || depth >= 20) {
        start[cell] = cursor;
        for (let k = lo; k < hi; k++) points[cursor++] = src[k];
        continue;
      }
      counts[0] = counts[1] = counts[2] = counts[3] = 0;
      counts[4] = counts[5] = counts[6] = counts[7] = 0;
      for (let k = lo; k < hi; k++) {
        const i = src[k];
        const o = (px[i] >= ccx ? 1 : 0) | (py[i] >= ccy ? 2 : 0) | (pz[i] >= ccz ? 4 : 0);
        counts[o]++;
      }
      let acc = lo;
      for (let o = 0; o < 8; o++) { offsets[o] = acc; cursors[o] = acc; acc += counts[o]; }
      for (let k = lo; k < hi; k++) {
        const i = src[k];
        const o = (px[i] >= ccx ? 1 : 0) | (py[i] >= ccy ? 2 : 0) | (pz[i] >= ccz ? 4 : 0);
        dst[cursors[o]++] = i;
      }
      const h2 = ch * 0.5;
      for (let o = 0; o < 8; o++) {
        if (!counts[o]) continue;
        const ncx = ccx + ((o & 1) ? h2 : -h2);
        const ncy = ccy + ((o & 2) ? h2 : -h2);
        const ncz = ccz + ((o & 4) ? h2 : -h2);
        const id = alloc(h2, ncx, ncy, ncz);
        child[cell * 8 + o] = id;
        stI[sp * 2] = id; stI[sp * 2 + 1] = depth + 1;
        stF[sp * 8] = offsets[o]; stF[sp * 8 + 1] = offsets[o] + counts[o];
        stF[sp * 8 + 2] = ncx; stF[sp * 8 + 3] = ncy; stF[sp * 8 + 4] = ncz;
        stF[sp * 8 + 5] = h2;
        sp++;
      }
      const swapBuf = src; src = dst; dst = swapBuf;
      T.bufA = src; T.bufB = dst;
    }

    T.root = root; T.cells = cells;
    return T;
  }

  /**
   * 点 i 受到的总斥力（k²/d²，方向 j→i）。内部节点在 s/d < θ 时用质心近似。
   * scratch: 长度 3 的输出；stack: 复用的访问栈。
   */
  function repulsion(
    T: TreeStore, i: number, k2: number, theta: number,
    px: Float64Array, py: Float64Array, pz: Float64Array,
    out: Float64Array, stack: Int32Array,
  ): void {
    const x = px[i], y = py[i], z = pz[i];
    let fx = 0, fy = 0, fz = 0;
    let sp = 0;
    stack[sp++] = T.root;
    const { mass, comX, comY, comZ, half, child, start, count, points } = T;
    while (sp > 0) {
      const cell = stack[--sp];
      const s0 = start[cell];
      if (s0 >= 0) {
        const c = count[cell];
        for (let t = s0; t < s0 + c; t++) {
          const j = points[t];
          if (j === i) continue;
          const dx = x - px[j], dy = y - py[j], dz = z - pz[j];
          let d2 = dx * dx + dy * dy + dz * dz;
          if (d2 < EPS) d2 = EPS;
          const d = Math.sqrt(d2);
          // Fruchterman-Reingold 斥力：k²/d（不是库仑的 k²/d²——后者会在 6 个邻居时
          // 把平衡边长压到 k^0.75 ≈ spacing 的三分之一，图缩成一团）。
          const f = k2 / d;
          fx += (dx / d) * f; fy += (dy / d) * f; fz += (dz / d) * f;
        }
        continue;
      }
      const dx = x - comX[cell], dy = y - comY[cell], dz = z - comZ[cell];
      let d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < EPS) d2 = EPS;
      const d = Math.sqrt(d2);
      if ((2 * half[cell]) / d < theta) {
        const f = (k2 * mass[cell]) / d;
        fx += (dx / d) * f; fy += (dy / d) * f; fz += (dz / d) * f;
      } else {
        for (let o = 0; o < 8; o++) {
          const c = child[cell * 8 + o];
          if (c >= 0 && sp < stack.length) stack[sp++] = c;
        }
      }
    }
    out[0] = fx; out[1] = fy; out[2] = fz;
  }

  /* ================================================================== *
   * semantic：FR 力导向 + Barnes-Hut 近似
   * ================================================================== */

  /**
   * 把 (nodes, edges) 预处理成索引化的力模型。
   *
   * 单独抽出来的原因：迭代与能量度量**必须**用完全相同的力公式，否则
   * "布局在收敛"与"能量在下降"会各自成立却互相矛盾（曾经踩过：
   * energy() 用固定弹簧长度、迭代用逐节点理想长度，θ 对比测试因此假阳性 28%）。
   */
  function prepare(nodes: LayoutNode[], edges: LayoutEdge[]) {
    const n = nodes.length;
    const byId = new Map<string, number>();
    for (let i = 0; i < n; i++) byId.set(nodes[i].id, i);
    const es = new Int32Array(edges.length);
    const et = new Int32Array(edges.length);
    const ew = new Float64Array(edges.length);
    let m = 0;
    for (let e = 0; e < edges.length; e++) {
      const a = byId.get(edges[e].src), b = byId.get(edges[e].dst);
      if (a === undefined || b === undefined || a === b) continue;
      es[m] = a; et[m] = b; ew[m] = edges[e].weight > 0 ? edges[e].weight : 1;
      m++;
    }
    const degree = new Float64Array(n);
    for (let e = 0; e < m; e++) { degree[es[e]] += 1; degree[et[e]] += 1; }
    const nodeMass = new Float64Array(n);
    const ideal = new Float64Array(n);
    return { n, byId, es, et, ew, m, degree, nodeMass, ideal, fillIdeal(K: number) {
      for (let i = 0; i < n; i++) {
        const imp = Math.max(0, Math.min(1, nodes[i].importance || 0));
        nodeMass[i] = 1 + Math.min(6, Math.sqrt(degree[i]));
        ideal[i] = K * (0.9 + 0.6 * imp + 0.2 * Math.log1p(degree[i]));
      }
    } };
  }

  function semantic(nodes: LayoutNode[], edges: LayoutEdge[], opts: LayoutOptions): LayoutResult {
    const n = nodes.length;
    if (!n) return emptyResult(3);
    const spacing = optNum(opts.spacing, 60);
    const iterations = Math.max(1, Math.floor(optNum(opts.iterations, 160)));
    const theta = optNum(opts.theta, 0.9);
    const random = mulberry32(optNum(opts.seed, 1));
    const K = spacing;
    const k2 = K * K;

    const px = new Float64Array(n), py = new Float64Array(n), pz = new Float64Array(n);

    // 初始位置：黄金螺旋球面 + 抖动（中心对称的初始分布会让力导向卡在鞍点）
    const golden = Math.PI * (3 - Math.sqrt(5));
    const spread = K * Math.cbrt(Math.max(1, n)) * 0.55;
    for (let i = 0; i < n; i++) {
      const t = n === 1 ? 0.5 : i / (n - 1);
      const v = 1 - 2 * t;
      const r = Math.sqrt(Math.max(0, 1 - v * v));
      const a = golden * i + (hash32(nodes[i].id) % 1000) * 1e-3;
      px[i] = Math.cos(a) * r * spread + (random() - 0.5) * K * 0.2;
      py[i] = v * spread + (random() - 0.5) * K * 0.2;
      pz[i] = Math.sin(a) * r * spread + (random() - 0.5) * K * 0.2;
    }

    // 边表 + 逐节点质量/理想边长（与能量度量共用同一份公式）
    const model = prepare(nodes, edges);
    model.fillIdeal(K);
    const { es, et, ew, m, nodeMass, ideal } = model;

    const disp = new Float64Array(n * 3);
    const scratch = new Float64Array(3);
    const visitStack = new Int32Array(Math.max(64, n + 8) * 8);
    const tree = createTreeStore();
    const energies: number[] = [];

    // 自适应步长（FR / ForceAtlas2 的做法）：每个节点记住上一次的步长，
    // 方向没变就放大 1.2，掉头就砍半再走（退火）。比全局线性降温收敛快一个量级：
    // 全局降温在"整体还在膨胀"和"局部精细调整"之间只能二选一。
    const step = new Float64Array(n);
    const lastDir = new Float64Array(n * 3);
    for (let i = 0; i < n; i++) step[i] = spread * 0.02;
    const STEP_MAX = K * 2;
    const STEP_MIN = K * 1e-4;

    for (let it = 0; it < iterations; it++) {
      disp.fill(0);
      buildTree(tree, px, py, pz, n);
      for (let i = 0; i < n; i++) {
        repulsion(tree, i, k2, theta, px, py, pz, scratch, visitStack);
        disp[i * 3] += scratch[0];
        disp[i * 3 + 1] += scratch[1];
        disp[i * 3 + 2] += scratch[2];
      }
      for (let e = 0; e < m; e++) {
        const a = es[e], b = et[e];
        let vx = px[b] - px[a], vy = py[b] - py[a], vz = pz[b] - pz[a];
        let d = Math.sqrt(vx * vx + vy * vy + vz * vz);
        if (d < 1e-6) {
          vx = random() - 0.5; vy = random() - 0.5; vz = random() - 0.5;
          d = Math.sqrt(vx * vx + vy * vy + vz * vz) || 1;
        }
        const target = (ideal[a] + ideal[b]) * 0.5;
        const f = (d * d / target) * ew[e];
        const ux = vx / d, uy = vy / d, uz = vz / d;
        disp[a * 3] += ux * f; disp[a * 3 + 1] += uy * f; disp[a * 3 + 2] += uz * f;
        disp[b * 3] -= ux * f; disp[b * 3 + 1] -= uy * f; disp[b * 3 + 2] -= uz * f;
      }
      let total = 0;
      for (let i = 0; i < n; i++) {
        const ix = i * 3;
        const mx = disp[ix] / nodeMass[i], my = disp[ix + 1] / nodeMass[i], mz = disp[ix + 2] / nodeMass[i];
        const len = Math.sqrt(mx * mx + my * my + mz * mz);
        total += disp[ix] * disp[ix] + disp[ix + 1] * disp[ix + 1] + disp[ix + 2] * disp[ix + 2];
        if (len <= 0) continue;
        const ux = mx / len, uy = my / len, uz = mz / len;
        // 方向与上次同向 → 加速；反向 → 减速（自适应步长的核心）。
        if (ux * lastDir[ix] + uy * lastDir[ix + 1] + uz * lastDir[ix + 2] > 0) {
          step[i] = Math.min(STEP_MAX, step[i] * 1.2);
        } else {
          step[i] *= 0.5;
        }
        if (step[i] < STEP_MIN) step[i] = STEP_MIN;
        lastDir[ix] = ux; lastDir[ix + 1] = uy; lastDir[ix + 2] = uz;
        const move = Math.min(step[i], len);
        px[i] += ux * move; py[i] += uy * move; pz[i] += uz * move;
      }
      energies.push(total);
    }

    center(px, py, pz, n);
    return pack(px, py, pz, n, 3, { energy: energies, iterations, theta });
  }

  /** 残余能量：平均合力平方（与迭代同口径），收敛时应 → 0。 */
  function energy(
    positions: ArrayLike<number>, nodes: LayoutNode[], edges: LayoutEdge[], opts: LayoutOptions,
  ): number {
    const n = nodes.length;
    if (!n) return 0;
    const spacing = optNum(opts.spacing, 60);
    const theta = optNum(opts.theta, 0.9);
    const k2 = spacing * spacing;
    const px = new Float64Array(n), py = new Float64Array(n), pz = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      px[i] = positions[i * 3] || 0;
      py[i] = positions[i * 3 + 1] || 0;
      pz[i] = positions[i * 3 + 2] || 0;
    }
    const model = prepare(nodes, edges);
    model.fillIdeal(spacing);
    const { es, et, ew, m, ideal } = model;
    const fx = new Float64Array(n), fy = new Float64Array(n), fz = new Float64Array(n);
    const scratch = new Float64Array(3);
    const visitStack = new Int32Array(Math.max(64, n + 8) * 8);
    const tree = buildTree(createTreeStore(), px, py, pz, n);
    for (let i = 0; i < n; i++) {
      repulsion(tree, i, k2, theta, px, py, pz, scratch, visitStack);
      fx[i] += scratch[0]; fy[i] += scratch[1]; fz[i] += scratch[2];
    }
    for (let e = 0; e < m; e++) {
      const a = es[e], b = et[e];
      const vx = px[b] - px[a], vy = py[b] - py[a], vz = pz[b] - pz[a];
      const d = Math.sqrt(vx * vx + vy * vy + vz * vz) + 1e-6;
      const f = (d * d / ((ideal[a] + ideal[b]) * 0.5)) * ew[e];
      const ux = vx / d, uy = vy / d, uz = vz / d;
      fx[a] += ux * f; fy[a] += uy * f; fz[a] += uz * f;
      fx[b] -= ux * f; fy[b] -= uy * f; fz[b] -= uz * f;
    }
    let total = 0;
    for (let i = 0; i < n; i++) total += fx[i] * fx[i] + fy[i] * fy[i] + fz[i] * fz[i];
    return total / n;
  }

  /* ------------------------------------------------------------------ *
   * 由 parent 字段建森林（容错：悬空父 → 根；环 → 断开）
   * ------------------------------------------------------------------ */
  function buildForest(nodes: LayoutNode[]) {
    const n = nodes.length;
    const index = new Map<string, number>();
    for (let i = 0; i < n; i++) index.set(nodes[i].id, i);
    const parent = new Int32Array(n).fill(-1);
    const children: number[][] = new Array(n);
    for (let i = 0; i < n; i++) children[i] = [];
    for (let i = 0; i < n; i++) {
      const p = nodes[i].parent;
      if (!p) continue;
      const pi = index.get(p);
      if (pi === undefined || pi === i) continue;
      parent[i] = pi;
    }
    for (let i = 0; i < n; i++) {
      let cur = parent[i], hops = 0;
      while (cur >= 0 && hops <= n) {
        if (cur === i) { parent[i] = -1; break; }
        cur = parent[cur]; hops++;
      }
    }
    const roots: number[] = [];
    for (let i = 0; i < n; i++) {
      if (parent[i] < 0) roots.push(i);
      else children[parent[i]].push(i);
    }
    return { parent, children, roots };
  }

  /* ================================================================== *
   * hierarchy：Reingold-Tilford 变体
   *  1) 先序给叶子分配槽位，内部节点取子节点槽位均值；
   *  2) 同层按槽位排序后向右推挤，保证相邻 x 差 ≥ nodeWidth（防重叠）；
   *  3) 2D 用 (slot, -depth*levelGap, 0)；3D 径向用 (cos, sin) × 半径。
   * ================================================================== */
  function hierarchy(nodes: LayoutNode[], _edges: LayoutEdge[], opts: LayoutOptions): LayoutResult {
    const n = nodes.length;
    if (!n) return emptyResult(2);
    const dims: 2 | 3 = opts.dims === 2 ? 2 : 3;
    const radial = opts.radial !== undefined ? opts.radial : dims === 3;
    const slotGap = optNum(opts.slotGap, 1);
    const nodeWidth = optNum(opts.nodeWidth, 1);

    const { parent, children, roots } = buildForest(nodes);
    const depth = new Int32Array(n).fill(-1);
    const order: number[] = [];
    const stack: number[] = [];
    for (let r = roots.length - 1; r >= 0; r--) stack.push(roots[r]);
    while (stack.length) {
      const v = stack.pop() as number;
      if (depth[v] >= 0) continue;
      depth[v] = parent[v] < 0 ? 0 : depth[parent[v]] + 1;
      order.push(v);
      const kids = children[v];
      for (let k = kids.length - 1; k >= 0; k--) if (depth[kids[k]] < 0) stack.push(kids[k]);
    }
    for (let i = 0; i < n; i++) {
      if (depth[i] < 0) { depth[i] = 0; order.push(i); }
    }

    const slot = new Float64Array(n);
    let nextSlot = 0;
    for (let oi = 0; oi < order.length; oi++) {
      const v = order[oi];
      if (!children[v].length) { slot[v] = nextSlot; nextSlot += slotGap; }
    }
    for (let oi = order.length - 1; oi >= 0; oi--) {
      const v = order[oi];
      const kids = children[v];
      if (!kids.length) continue;
      let sum = 0;
      for (let k = 0; k < kids.length; k++) sum += slot[kids[k]];
      slot[v] = sum / kids.length;
    }

    let maxDepth = 0;
    for (let i = 0; i < n; i++) if (depth[i] > maxDepth) maxDepth = depth[i];
    const layers: number[][] = new Array(maxDepth + 1);
    for (let d = 0; d <= maxDepth; d++) layers[d] = [];
    for (let i = 0; i < n; i++) layers[depth[i]].push(i);
    for (let d = 0; d <= maxDepth; d++) {
      const layer = layers[d];
      layer.sort((a, b) => slot[a] - slot[b] || (nodes[a].id < nodes[b].id ? -1 : 1));
      for (let k = 1; k < layer.length; k++) {
        const prev = slot[layer[k - 1]];
        if (slot[layer[k]] - prev < nodeWidth) slot[layer[k]] = prev + nodeWidth;
      }
    }

    // 层间距必须跟着树的**宽度**走：一棵 300 个叶子、只有 3 层的树，
    // 如果层间距还是 3.2 个槽位，垂直方向就被压成一条带子，层级完全看不出来
    // （这正是"层级图挤成一根油条"的原因）。取最宽层的槽数的 0.9 倍作基准，
    // 再夹到 [2.4, 48] 之间，保证又扁又宽 / 又窄又深的树都好看。
    let widestLayer = 1;
    for (let d = 0; d <= maxDepth; d++) widestLayer = Math.max(widestLayer, layers[d].length);
    const autoLevelGap = Math.min(48, Math.max(2.4, widestLayer * 0.9));
    const levelGap = opts.levelGap !== undefined && opts.levelGap > 0
      ? Math.max(autoLevelGap, opts.levelGap)
      : autoLevelGap;

    const px = new Float64Array(n), py = new Float64Array(n), pz = new Float64Array(n);
    if (radial) {
      const span = Math.max(1, nextSlot);
      const total = span * Math.PI * 2 / Math.max(1, maxDepth + 1);
      for (let i = 0; i < n; i++) {
        const d = depth[i];
        const radius = d === 0 ? 0 : d * levelGap;
        const angle = (slot[i] / span) * Math.PI * 2;
        const sway = d % 2 ? Math.PI / Math.max(8, span) : 0;
        const rr = d === 0 ? 0 : radius;
        px[i] = Math.cos(angle + sway) * rr;
        pz[i] = Math.sin(angle + sway) * rr;
        py[i] = -d * levelGap * 0.3;
      }
      void total;
    } else {
      for (let i = 0; i < n; i++) {
        px[i] = slot[i];
        py[i] = -depth[i] * levelGap;
        pz[i] = 0;
      }
    }

    let minX = Infinity, maxX = -Infinity;
    for (let i = 0; i < n; i++) {
      if (px[i] < minX) minX = px[i];
      if (px[i] > maxX) maxX = px[i];
    }
    const mid = (minX + maxX) / 2;
    for (let i = 0; i < n; i++) px[i] -= mid;

    return pack(px, py, pz, n, dims, { maxDepth, radial, layers: maxDepth + 1, nodeWidth });
  }

  /* ================================================================== *
   * timeline：X 随时间单调递增，Z 按天分带，带内蛇形错开
   * ================================================================== */
  function timeline(nodes: LayoutNode[], _edges: LayoutEdge[], opts: LayoutOptions): LayoutResult {
    const n = nodes.length;
    if (!n) return emptyResult(3);
    const bandGap = optNum(opts.bandGap, 4);
    const lane = optNum(opts.spacing, 2.4);

    const order: number[] = new Array(n);
    for (let i = 0; i < n; i++) order[i] = i;
    order.sort((a, b) => {
      const ta = nodes[a].time || 0, tb = nodes[b].time || 0;
      if (ta !== tb) return ta - tb;
      return nodes[a].id < nodes[b].id ? -1 : nodes[a].id > nodes[b].id ? 1 : 0;
    });

    let t0 = Infinity;
    for (let i = 0; i < n; i++) if (nodes[i].time > 0 && nodes[i].time < t0) t0 = nodes[i].time;
    if (!isFinite(t0)) t0 = 0;

    const px = new Float64Array(n), py = new Float64Array(n), pz = new Float64Array(n);
    let band = 0, inBand = 0;
    for (let k = 0; k < n; k++) {
      const i = order[k];
      const t = nodes[i].time || 0;
      const b = t > 0 ? Math.floor((t - t0) / DAY_MS) : band;
      if (b !== band) { band = b; inBand = 0; }
      px[i] = t > 0 ? (t - t0) / 3600000 : 0;
      pz[i] = b * bandGap;
      const laneIndex = inBand % 4;
      py[i] = (laneIndex === 0 || laneIndex === 3 ? 1 : -1) * lane * (1 + Math.floor(inBand / 4) * 0.15);
      inBand++;
    }

    center(px, py, pz, n);
    return pack(px, py, pz, n, 3, { bands: band + 1, dayMs: DAY_MS });
  }

  /* ================================================================== *
   * evidence：记忆 → 证据 → 来源 三层，层内按父节点聚类成扇区
   * ================================================================== */
  function evidence(nodes: LayoutNode[], _edges: LayoutEdge[], opts: LayoutOptions): LayoutResult {
    const n = nodes.length;
    if (!n) return emptyResult(3);
    const layerGap = optNum(opts.layerGap, 26);
    const lane = optNum(opts.spacing, 7);

    const index = new Map<string, number>();
    for (let i = 0; i < n; i++) index.set(nodes[i].id, i);
    const layer = new Int32Array(n);
    let anyLayer = false;
    for (let i = 0; i < n; i++) {
      const explicit = nodes[i].layer;
      if (typeof explicit === 'number') { layer[i] = explicit; if (explicit > 0) anyLayer = true; }
    }
    if (!anyLayer) {
      layer.fill(0);
      for (let i = 0; i < n; i++) {
        const p = nodes[i].parent;
        const pi = p ? index.get(p) : undefined;
        layer[i] = pi === undefined ? 0 : Math.min(2, layer[pi] + 1);
      }
    }

    const groups = new Map<string, number[]>();
    for (let i = 0; i < n; i++) {
      const key = (nodes[i].parent || ('kind:' + nodes[i].kind)) + '#L' + layer[i];
      const list = groups.get(key);
      if (list) list.push(i); else groups.set(key, [i]);
    }
    const keys = Array.from(groups.keys()).sort();

    const px = new Float64Array(n), py = new Float64Array(n), pz = new Float64Array(n);
    let maxLayer = 0;
    for (let i = 0; i < n; i++) if (layer[i] > maxLayer) maxLayer = layer[i];

    for (let L = 0; L <= maxLayer; L++) {
      const cellsInLayer: string[] = [];
      for (let k = 0; k < keys.length; k++) {
        const list = groups.get(keys[k]) as number[];
        if (list.length && layer[list[0]] === L) cellsInLayer.push(keys[k]);
      }
      if (!cellsInLayer.length) continue;
      const radius = L * layerGap;
      for (let g = 0; g < cellsInLayer.length; g++) {
        const list = groups.get(cellsInLayer[g]) as number[];
        const baseAngle = (g / cellsInLayer.length) * Math.PI * 2;
        const perRing = Math.max(1, Math.floor(Math.max(3, 8 - L)));
        for (let s = 0; s < list.length; s++) {
          const i = list[s];
          const ring = Math.floor(s / perRing);
          const off = (s % perRing) - (perRing - 1) / 2;
          const rr = radius + ring * lane;
          const tangent = off * lane * 0.62;
          px[i] = Math.cos(baseAngle) * rr - Math.sin(baseAngle) * tangent;
          pz[i] = Math.sin(baseAngle) * rr + Math.cos(baseAngle) * tangent;
          py[i] = -L * lane * 0.55;
        }
      }
    }

    let orphan = 0;
    for (let i = 0; i < n; i++) {
      if (px[i] === 0 && pz[i] === 0) {
        const a = (orphan++ / Math.max(1, n)) * Math.PI * 2;
        px[i] = Math.cos(a) * lane;
        pz[i] = Math.sin(a) * lane;
      }
    }

    center(px, py, pz, n);
    return pack(px, py, pz, n, 3, { layers: maxLayer + 1 });
  }

  return { semantic, hierarchy, timeline, evidence, energy };
}

/** 按视图分发（主线程与 Worker 共用）。 */
export function runLayout(
  view: ViewKind, nodes: LayoutNode[], edges: LayoutEdge[], opts: LayoutOptions, kernel?: LayoutKernel,
): LayoutResult {
  const k = kernel ?? layoutKernel();
  switch (view) {
    case 'hierarchy': return k.hierarchy(nodes, edges, opts);
    case 'timeline': return k.timeline(nodes, edges, opts);
    case 'evidence': return k.evidence(nodes, edges, opts);
    case 'semantic':
    default: return k.semantic(nodes, edges, opts);
  }
}

/** 默认参数：按规模自动降迭代数，保证首屏 ≤ ~2s。 */
export function defaultOptions(view: ViewKind, count: number, dims: 2 | 3): LayoutOptions {
  const iterations = count > 4000 ? 80 : count > 1500 ? 120 : 180;
  return {
    dims,
    iterations,
    spacing: view === 'hierarchy' ? 1 : 60,
    slotGap: 1,
    levelGap: 3.2,
    nodeWidth: DEFAULT_NODE_WIDTH,
    bandGap: 4,
    layerGap: 26,
    radial: view === 'hierarchy' ? dims === 3 : undefined,
    seed: 20240517,
    theta: 0.9,
  };
}
