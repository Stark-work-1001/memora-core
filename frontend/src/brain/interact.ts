/**
 * 交互层：拾取、选中、邻居高亮（1/2 跳）、聚焦动画、路径查找、键鼠绑定。
 *
 * 这里的"最佳视角"不是把相机怼到节点脸上，而是：
 *   1. 先解出该节点的邻居包围球（无邻居就退化成节点本身 + 一个最小半径）；
 *   2. 求一个能同时容纳"节点 + 邻居"的相机距离（按 FOV 反解，留 padding）；
 *   3. 位置沿球面插值（四元数 slerp 定向 + Vector3.lerpVectors 平移），
 *      easeOutCubic 400–600ms；
 *   4. 邻居做轻微径向外推（不改变布局拓扑，只是视觉上"让开"），
 *      选中节点放大 1.4×。
 *
 * 为什么位置用 lerpVectors 而不是直接给球坐标：转场期间用户可能还在拖拽，
 * 球坐标会被打断；用端点插值可以随时中断并平滑接管（打断时把当前值写回目标态）。
 */
import { Vector3, Vector2 } from 'three';
import type { RenderState } from './types';
import type { BrainScene } from './scene';
import type { NodeLayer } from './nodes';
import { nodeRadius } from './nodes';
import type { EdgeLayer } from './edges';

/** 邻居外推的最大距离（相对于节点半径）。 */
const NEIGHBOR_PUSH = 1.15;
/** 选中节点放大倍数。 */
export const SELECTED_SCALE = 1.4;
/** 聚焦转场时长。 */
export const FOCUS_DURATION = 520;

/** 由"看向 target 的朝向"算四元数（和 scene.ts 同一套约定，独立一份避免循环依赖）。 */
function orientationTo(from: Vector3, to: Vector3): { x: number; y: number; z: number; w: number } {
  const dir = new Vector3().subVectors(to, from);
  if (dir.lengthSq() < 1e-12) return { x: 0, y: 0, z: 0, w: 1 };
  dir.normalize();
  const up = Math.abs(dir.y) > 0.9999 ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0);
  const right = new Vector3().crossVectors(up, dir).normalize();
  const trueUp = new Vector3().crossVectors(dir, right).normalize();
  const m00 = right.x, m01 = trueUp.x, m02 = -dir.x;
  const m10 = right.y, m11 = trueUp.y, m12 = -dir.y;
  const m20 = right.z, m21 = trueUp.z, m22 = -dir.z;
  const trace = m00 + m11 + m22;
  const out = { x: 0, y: 0, z: 0, w: 1 };
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    out.w = 0.25 / s; out.x = (m21 - m12) * s; out.y = (m02 - m20) * s; out.z = (m10 - m01) * s;
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    out.w = (m21 - m12) / s; out.x = 0.25 * s; out.y = (m01 + m10) / s; out.z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    out.w = (m02 - m20) / s; out.x = (m01 + m10) / s; out.y = 0.25 * s; out.z = (m12 + m21) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    out.w = (m10 - m01) / s; out.x = (m02 + m20) / s; out.y = (m12 + m21) / s; out.z = 0.25 * s;
  }
  const len = Math.hypot(out.x, out.y, out.z, out.w) || 1;
  out.x /= len; out.y /= len; out.z /= len; out.w /= len;
  return out;
}

/** 交互层依赖的外部能力。 */
export interface InteractionHost {
  scene: BrainScene;
  nodes: NodeLayer;
  edges: EdgeLayer;
  /** 当前渲染状态（每次换布局/过滤后由 main 更新）。 */
  state(): RenderState | null;
  /** 选中变化时的回调（UI 面板刷新）。 */
  onSelect(index: number, hops: 1 | 2): void;
  /** 状态变化回调（路径结果显示等）。 */
  onStatus(text: string): void;
  /** 当前投影（正交时聚焦距离要换算）。 */
  projection(): 'perspective' | '3d-ortho' | '2d';
}

/**
 * 交互控制器。
 *
 * 事件全部绑在 canvas 上；键盘绑 window（\`/\` 输入框聚焦时不要抢键）。
 */
export class Interaction {
  private host: InteractionHost;
  private selected = -1;
  private neighbors: number[] = [];
  private hops: 1 | 2 = 1;
  /** 路径查找的两个端点（-1 表示未选）。 */
  private pathFrom = -1;
  private pathTo = -1;
  private pathHops: 1 | 2 = 1;
  private pathMode = false;
  /** 外推/缩放的当前值（每帧向目标插值，避免瞬移）。 */
  private pushAmount = new Float32Array(0);
  private scaleAmount = new Float32Array(0);
  private readonly tmp = new Vector3();
  private readonly tmp2 = new Vector3();
  private readonly ndc = new Vector2();

  /** 手动叠加的相机朝向（拖拽时由 scene 维护，聚焦时被覆盖）。 */
  private disposed = false;
  private dragMode: 'none' | 'orbit' | 'pan' = 'none';
  private lastX = 0;
  private lastY = 0;
  private downX = 0;
  private downY = 0;
  private pointerId = -1;
  /** 各事件到达次数（自检用：区分"没点到节点"和"事件没到"）。 */
  readonly eventCounts = { down: 0, up: 0, move: 0, wheel: 0, pickHit: 0, pickMiss: 0 };

  constructor(host: InteractionHost) {
    this.host = host;
    this.bind();
  }

  get selection(): number { return this.selected; }
  get selectedNeighbors(): number[] { return this.neighbors; }
  get isPathMode(): boolean { return this.pathMode; }

  /** 过滤或换图后重置（索引已经变了）。 */
  resetSelection(): void {
    this.selected = -1;
    this.neighbors = [];
    this.pathFrom = -1;
    this.pathTo = -1;
    const n = this.host.state()?.graph.nodes.length ?? 0;
    this.pushAmount = new Float32Array(n);
    this.scaleAmount = new Float32Array(n);
    this.host.edges.clearHighlight();
  }

  /* ------------------------------------------------------------------ *
   * 拾取
   * ------------------------------------------------------------------ */

  /**
   * 在屏幕点附近找最近的节点。
   *
   * 不用 Raycaster.intersectObject(InstancedMesh)：5000 个实例它要遍历全部并做
   * 三角形求交，一次点击几十毫秒。节点本质是球，直接投影到屏幕比像素距离 +
   * 半径容差更快也更符合"点得准"的手感。
   */
  /** 最近一次拾取的诊断信息（自检用：区分"点在空处"和"投影算错"）。 */
  lastPick: { px: number; py: number; best: number; bestDist: number; bestTol: number; considered: number } = {
    px: 0, py: 0, best: -1, bestDist: 0, bestTol: 0, considered: 0,
  };

  pick(clientX: number, clientY: number): number {
    const state = this.host.state();
    if (!state) return -1;
    const camera = this.host.scene.camera;
    const rect = this.host.scene.canvas.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    let best = -1;
    let bestScore = Infinity;
    this.lastPick.bestDist = -1;
    this.lastPick.bestTol = 0;
    const v = this.tmp;
    for (let i = 0; i < state.graph.nodes.length; i++) {
      v.set(state.renderPositions[i * 3], state.renderPositions[i * 3 + 1], state.renderPositions[i * 3 + 2]);
      // 背面剔除：投影后 z > 1 表示在相机后面
      const projected = v.clone().project(camera);
      if (projected.z > 1) continue;
      const sx = (projected.x * 0.5 + 0.5) * rect.width;
      const sy = (-projected.y * 0.5 + 0.5) * rect.height;
      const dx = sx - px;
      const dy = sy - py;
      const dist2 = dx * dx + dy * dy;
      // 容差 = 节点屏幕半径（最小 10px，方便点到小节点）
      const worldR = nodeRadius(state.graph.nodes[i]) * this.host.nodes.worldUnit * (this.scaleAmount[i] || 1);
      const ppr = this.host.scene.pixelsPerWorldUnit;
      const screenR = Math.max(10, worldR * ppr);
      if (dist2 > screenR * screenR) {
        // 记录"最近的落选者"，用于诊断（不影响结果）
        if (dist2 < this.lastPick.bestDist || this.lastPick.best < 0) {
          this.lastPick.bestDist = Math.sqrt(dist2);
          this.lastPick.bestTol = screenR;
        }
        continue;
      }
      const score = dist2;
      if (score < bestScore) { bestScore = score; best = i; }
    }
    this.lastPick.px = px;
    this.lastPick.py = py;
    this.lastPick.best = best;
    this.lastPick.considered = state.graph.nodes.length;
    return best;
  }

  /* ------------------------------------------------------------------ *
   * 选中 / 高亮
   * ------------------------------------------------------------------ */

  /** 选中一个节点（-1 = 取消）。会触发邻居高亮与相机转场。 */
  select(index: number, hops: 1 | 2 = this.hops, fly = true): void {
    const state = this.host.state();
    if (!state) return;
    if (index === this.selected && hops === this.hops) {
      if (fly) this.focusOn(index);
      return;
    }
    this.hops = hops;
    this.selected = index;
    if (index < 0) {
      this.neighbors = [];
      this.host.nodes.setHighlight(-1, []);
      this.host.edges.setNeighborEmphasis(-1, [], state.index);
      this.host.onSelect(-1, hops);
      return;
    }
    // BFS 跳数
    const seen = new Set<number>([index]);
    let frontier = [index];
    const collected: number[] = [];
    for (let h = 0; h < hops; h++) {
      const next: number[] = [];
      for (const f of frontier) {
        for (const nb of state.neighbors[f] ?? []) {
          if (seen.has(nb)) continue;
          seen.add(nb);
          collected.push(nb);
          next.push(nb);
        }
      }
      frontier = next;
    }
    this.neighbors = collected;
    this.host.nodes.setHighlight(index, collected);
    this.host.edges.setNeighborEmphasis(index, collected, state.index);
    this.host.onSelect(index, hops);
    if (fly) this.focusOn(index);
  }

  /**
   * 相机转到"正对该节点且能容纳其邻居"的位置。
   *
   * 距离反解：需要容纳的半径 R 一定落在视锥里，
   *   d = R / tan(fov/2)  （透视：垂直 FOV；水平方向按 aspect 修正）
   * 正交相机则是把 zoom 调到能放下 R。
   */
  focusOn(index: number): void {
    const state = this.host.state();
    if (!state || index < 0) return;
    const scene = this.host.scene;
    const node = state.graph.nodes[index];
    const center = new Vector3(
      state.renderPositions[index * 3],
      state.renderPositions[index * 3 + 1],
      state.renderPositions[index * 3 + 2],
    );

    // 1) 邻居包围球：把邻居纳入可视区域，而不是只看选中节点
    const unit = this.host.nodes.worldUnit;
    const sphere = new Vector3().copy(center);
    let radius = nodeRadius(node) * unit * 2.2;
    const neighborSet = new Set<number>([index, ...this.neighbors]);
    for (const nb of neighborSet) {
      const p = this.tmp2.set(
        state.renderPositions[nb * 3],
        state.renderPositions[nb * 3 + 1],
        state.renderPositions[nb * 3 + 2],
      );
      const dist = p.distanceTo(center);
      if (dist > radius) radius = dist;
    }
    // 包围球中心 = 选中点与最远邻居的中点（再乘一点点，偏向整体）
    if (this.neighbors.length) {
      const farthest = this.farthestNeighbor(state, index);
      if (farthest >= 0) {
        const p = new Vector3(
          state.renderPositions[farthest * 3],
          state.renderPositions[farthest * 3 + 1],
          state.renderPositions[farthest * 3 + 2],
        );
        sphere.lerpVectors(center, p, 0.35);
      }
    }
    radius = Math.max(radius * 1.15, radius + nodeRadius(node) * unit * 2);

    // 2) 目标距离
    const mode = this.host.projection();
    let distance: number;
    if (mode === 'perspective') {
      const fov = (scene.perspective.fov * Math.PI) / 180;
      const aspect = Math.max(0.2, scene.perspective.aspect);
      const vFov = fov;
      const hFov = 2 * Math.atan(Math.tan(fov / 2) * aspect);
      distance = Math.max(radius / Math.tan(vFov / 2), radius / Math.tan(hFov / 2)) * 1.05;
      distance = Math.max(distance, nodeRadius(node) * unit * 6);
      distance = Math.min(distance, 30000);
    } else {
      // 正交：以像素为单位，保证 R 占视口的一半多一点
      const height = scene.canvas.clientHeight;
      const ox = Math.max(radius / Math.max(1e-6, scene.orthographic.top), 0.001);
      distance = height * 0.5 * ox * 1.1;
    }

    // 3) 朝向：从"节点相对相机"的方向看回去，保持当前方位角、略降仰角
    const offset = new Vector3().subVectors(sphere, scene.currentPosition());
    if (offset.lengthSq() < 1e-6) offset.set(0, 0, 1);
    offset.normalize().multiplyScalar(distance);
    const cameraPos = new Vector3().addVectors(sphere, offset);
    const quat = orientationTo(cameraPos, sphere);
    scene.flyTo(sphere, distance, quat, FOCUS_DURATION);
  }

  private farthestNeighbor(state: RenderState, index: number): number {
    let best = -1;
    let bestDist = -1;
    const cx = state.renderPositions[index * 3];
    const cy = state.renderPositions[index * 3 + 1];
    const cz = state.renderPositions[index * 3 + 2];
    for (const nb of this.neighbors) {
      const dx = state.renderPositions[nb * 3] - cx;
      const dy = state.renderPositions[nb * 3 + 1] - cy;
      const dz = state.renderPositions[nb * 3 + 2] - cz;
      const d = dx * dx + dy * dy + dz * dz;
      if (d > bestDist) { bestDist = d; best = nb; }
    }
    return best;
  }

  /* ------------------------------------------------------------------ *
   * 邻居外推 + 选中放大：每帧插值到目标值
   * ------------------------------------------------------------------ */

  /**
   * 把邻居沿"从选中点指向自己"的方向外推一点。
   *
   * 为什么要做：聚焦后邻居如果贴在节点上，视觉上分不清谁是谁；
   * 外推 1.15 倍径向后层次清楚，又不会破坏整体布局形状（外推量很小）。
   */
  applyDisplacement(dt: number): void {
    const state = this.host.state();
    if (!state) return;
    const n = state.graph.nodes.length;
    if (this.pushAmount.length !== n) {
      this.pushAmount = new Float32Array(n);
      this.scaleAmount = new Float32Array(n);
    }
    // 目标值
    const targetPush = this.pushAmount;
    const k = 1 - Math.exp(-dt / 0.12); // 120ms 时间常数
    const selected = this.selected;
    const neighborSet = new Set(this.neighbors);
    const cx = selected >= 0 ? state.positions[selected * 3] : 0;
    const cy = selected >= 0 ? state.positions[selected * 3 + 1] : 0;
    const cz = selected >= 0 ? state.positions[selected * 3 + 2] : 0;

    for (let i = 0; i < n; i++) {
      const goal = selected >= 0 && neighborSet.has(i) ? 1 : 0;
      targetPush[i] += (goal - targetPush[i]) * k;
      const goalScale = i === selected ? SELECTED_SCALE : 1;
      this.scaleAmount[i] += (goalScale - this.scaleAmount[i]) * k;
      if (this.scaleAmount[i] === 0) this.scaleAmount[i] = 1;

      let x = state.positions[i * 3];
      let y = state.positions[i * 3 + 1];
      let z = state.positions[i * 3 + 2];
      const push = targetPush[i];
      if (push > 0.001 && selected >= 0) {
        const dx = x - cx, dy = y - cy, dz = z - cz;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dist > 1e-3) {
          const amount = push * NEIGHBOR_PUSH * nodeRadius(state.graph.nodes[i]) * this.host.nodes.worldUnit;
          x += (dx / dist) * amount;
          y += (dy / dist) * amount;
          z += (dz / dist) * amount;
        }
      }
      state.renderPositions[i * 3] = x;
      state.renderPositions[i * 3 + 1] = y;
      state.renderPositions[i * 3 + 2] = z;
    }
    this.host.nodes.writeMatrices(state.renderPositions, this.scaleAmount);
  }

  /* ------------------------------------------------------------------ *
   * 路径查找
   * ------------------------------------------------------------------ */

  /** 进入/退出路径查找模式（选两个节点显示最短路径）。 */
  setPathMode(on: boolean): void {
    this.pathMode = on;
    this.pathFrom = -1;
    this.pathTo = -1;
    this.host.edges.clearHighlight();
    this.host.onStatus(on ? '路径查找：依次点击两个节点（Esc 取消）' : '');
  }

  /** 路径查找模式下的点击：第一次记起点，第二次算最短路。 */
  private handlePathPick(index: number): void {
    const state = this.host.state();
    if (!state) return;
    if (this.pathFrom < 0) {
      this.pathFrom = index;
      this.host.onStatus('起点：' + state.graph.nodes[index].label + '，再点一个终点');
      return;
    }
    this.pathTo = index;
    const path = shortestPath(state.neighbors, this.pathFrom, this.pathTo);
    if (!path.length) {
      this.host.onStatus('这两个节点之间没有路径');
      this.host.edges.clearHighlight();
      this.pathFrom = -1;
      return;
    }
    this.host.edges.highlightPath(path, state.renderPositions);
    this.host.onStatus('最短路径：' + (path.length - 1) + ' 跳，' + path.length + ' 个节点');
    this.pathFrom = -1;
    this.pathTo = -1;
  }

  /* ------------------------------------------------------------------ *
   * 事件绑定
   * ------------------------------------------------------------------ */

  private bind(): void {
    const canvas = this.host.scene.canvas;
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onPointerUp);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('dblclick', this.onDoubleClick);
    canvas.addEventListener('contextmenu', this.onContextMenu);
    window.addEventListener('keydown', this.onKeyDown);
  }

  private onPointerDown = (event: PointerEvent): void => {
    this.eventCounts.down++;
    const canvas = this.host.scene.canvas;
    // setPointerCapture 在部分环境（无头、被其它元素截获）会抛异常；
    // 它只是"拖出画布也别丢事件"的优化，绝不能因为失败就让整次点击失效。
    try { canvas.setPointerCapture(event.pointerId); } catch { /* 捕获失败不影响拖拽 */ }
    this.pointerId = event.pointerId;
    this.lastX = this.downX = event.clientX;
    this.lastY = this.downY = event.clientY;
    this.dragMode = event.button === 2 || event.button === 1 ? 'pan' : 'orbit';
  };

  private onPointerMove = (event: PointerEvent): void => {
    this.eventCounts.move++;
    if (this.dragMode === 'none' || event.pointerId !== this.pointerId) return;
    const dx = event.clientX - this.lastX;
    const dy = event.clientY - this.lastY;
    this.lastX = event.clientX;
    this.lastY = event.clientY;
    if (this.dragMode === 'orbit') this.host.scene.orbit(dx, dy);
    else this.host.scene.pan(dx, dy);
  };

  private onPointerUp = (event: PointerEvent): void => {
    this.eventCounts.up++;
    // 不因为 pointerId 对不上就直接放弃：pointerdown 有可能被别的层吃掉
    // （或者 setPointerCapture 失败）。只要这一次按下-抬起移动距离够小，就当成点击，
    // 否则用户会遇到"点了没反应"这种最难查的交互 bug。
    const canvas = this.host.scene.canvas;
    try { canvas.releasePointerCapture(event.pointerId); } catch { /* 已释放 */ }
    const moved = Math.hypot(event.clientX - this.downX, event.clientY - this.downY);
    this.dragMode = 'none';
    this.pointerId = -1;
    if (moved > 5) return; // 拖拽结束不当作点击
    const index = this.pick(event.clientX, event.clientY);
    if (index < 0) {
      this.eventCounts.pickMiss++;
      this.select(-1);
      return;
    }
    this.eventCounts.pickHit++;
    if (this.pathMode) { this.handlePathPick(index); return; }
    this.select(index, event.shiftKey ? 2 : 1);
  };

  private onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    this.host.scene.zoom(event.deltaY);
  };

  private onDoubleClick = (event: MouseEvent): void => {
    const index = this.pick(event.clientX, event.clientY);
    if (index >= 0) this.select(index, this.hops, true);
    else this.host.onStatus('这里没有节点');
  };

  private onContextMenu = (event: MouseEvent): void => {
    event.preventDefault();
  };

  private onKeyDown = (event: KeyboardEvent): void => {
    const target = event.target as HTMLElement | null;
    const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
    if (typing) {
      if (event.key === 'Escape') target?.blur();
      return;
    }
    if (event.key === ' ') {
      event.preventDefault();
      this.resetView();
    } else if (event.key === 'Escape') {
      if (this.pathMode) { this.setPathMode(false); return; }
      this.select(-1);
    }
  };

  /** Space：取消选中并把相机复位。 */
  resetView(): void {
    this.select(-1);
    const state = this.host.state();
    const distance = this.host.scene.frameRadius(state?.graph ? worldRadius(state) : 500);
    this.host.scene.reset(distance);
    this.host.onStatus('已复位');
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const canvas = this.host.scene.canvas;
    canvas.removeEventListener('pointerdown', this.onPointerDown);
    canvas.removeEventListener('pointermove', this.onPointerMove);
    canvas.removeEventListener('pointerup', this.onPointerUp);
    canvas.removeEventListener('pointercancel', this.onPointerUp);
    canvas.removeEventListener('wheel', this.onWheel);
    canvas.removeEventListener('dblclick', this.onDoubleClick);
    canvas.removeEventListener('contextmenu', this.onContextMenu);
    window.removeEventListener('keydown', this.onKeyDown);
  }
}

/** 图的包围球半径（复位用）。 */
export function worldRadius(state: RenderState): number {
  let max = 1;
  const p = state.positions;
  for (let i = 0; i < state.graph.nodes.length; i++) {
    const d = Math.hypot(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
    if (d > max) max = d;
  }
  return max;
}

/** BFS 最短路（返回索引序列，找不到返回空数组）。 */
export function shortestPath(neighbors: number[][], from: number, to: number): number[] {
  if (from < 0 || to < 0) return [];
  if (from === to) return [from];
  const prev = new Int32Array(neighbors.length).fill(-1);
  const seen = new Uint8Array(neighbors.length);
  const queue: number[] = [from];
  seen[from] = 1;
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head];
    for (const nb of neighbors[cur] ?? []) {
      if (seen[nb]) continue;
      seen[nb] = 1;
      prev[nb] = cur;
      if (nb === to) {
        const path: number[] = [to];
        let walk = to;
        while (prev[walk] >= 0) { walk = prev[walk]; path.push(walk); }
        return path.reverse();
      }
      queue.push(nb);
    }
  }
  return [];
}


