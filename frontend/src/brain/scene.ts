/**
 * three.js 场景 / 渲染器 / 双相机 / 自写轨道控制。
 *
 * 不用 examples/jsm 的 OrbitControls：
 *  1. 它把"相机放在球面上绕 target 转"写死在透视相机上，正交相机需要另一套缩放语义；
 *     本文件用同一个球坐标同时驱动两台相机（正交靠 zoom 换算）。
 *  2. 我们的聚焦动画要按四元数 slerp 走球面插值，并与阻尼、双击、Space 复位共享
 *     同一套状态机；外部控件反而要再拆一次状态。
 *  3. 右键平移、惯性阻尼、边界钳制这些都要按脑图需要调，自己写更短。
 *
 * 坐标约定：y 轴朝上；相机位置 = target + 球坐标偏移。
 */
import {
  MOUSE,
  OrthographicCamera,
  PerspectiveCamera,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
  Color,
  Fog,
} from 'three';
import type { Camera } from 'three';

/** 背景与雾色（深色主题，与 style.css 的 --brain-bg 一致）。 */
export const BG_COLOR = 0x070b12;
export const FOG_COLOR = 0x070b12;

const MIN_POLAR = 0.08;
const MAX_POLAR = Math.PI - 0.08;
const MIN_DISTANCE = 0.5;

/** 一次相机转场（聚焦动画）的状态。 */
export interface Flight {
  active: boolean;
  startedAt: number;
  duration: number;
  fromTarget: Vector3;
  toTarget: Vector3;
  fromDistance: number;
  toDistance: number;
  fromQuat: { x: number; y: number; z: number; w: number };
  toQuat: { x: number; y: number; z: number; w: number };
}

/** 由"看向 target 的朝向"构造相机四元数（over the shoulder，无 roll）。 */
function lookQuaternion(from: Vector3, to: Vector3, out: { x: number; y: number; z: number; w: number }): void {
  const dir = new Vector3().subVectors(to, from);
  if (dir.lengthSq() < 1e-12) { out.x = 0; out.y = 0; out.z = 0; out.w = 1; return; }
  dir.normalize();
  // 与世界上方向共线时换一个参考轴，避免 lookAt 奇异。
  const up = Math.abs(dir.y) > 0.9999 ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0);
  const right = new Vector3().crossVectors(up, dir).normalize();
  const trueUp = new Vector3().crossVectors(dir, right).normalize();
  // 由正交基构造四元数：列向量 = (right, trueUp, -dir)
  const m00 = right.x, m01 = trueUp.x, m02 = -dir.x;
  const m10 = right.y, m11 = trueUp.y, m12 = -dir.y;
  const m20 = right.z, m21 = trueUp.z, m22 = -dir.z;
  const trace = m00 + m11 + m22;
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
}

/** 四元数 slerp（球面线性插值，走短弧）。 */
function slerp(a: { x: number; y: number; z: number; w: number }, b: typeof a, t: number, out: typeof a): void {
  let cos = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  let bx = b.x, by = b.y, bz = b.z, bw = b.w;
  if (cos < 0) { cos = -cos; bx = -bx; by = -by; bz = -bz; bw = -bw; }
  if (cos > 0.9995) {
    out.x = a.x + (bx - a.x) * t; out.y = a.y + (by - a.y) * t;
    out.z = a.z + (bz - a.z) * t; out.w = a.w + (bw - a.w) * t;
    const len = Math.hypot(out.x, out.y, out.z, out.w) || 1;
    out.x /= len; out.y /= len; out.z /= len; out.w /= len;
    return;
  }
  const theta = Math.acos(Math.min(1, Math.max(-1, cos)));
  const sinTheta = Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) / sinTheta;
  const wb = Math.sin(t * theta) / sinTheta;
  out.x = a.x * wa + bx * wb; out.y = a.y * wa + by * wb;
  out.z = a.z * wa + bz * wb; out.w = a.w * wa + bw * wb;
}

/** easeOutCubic：转场尾段减速，视觉上"稳稳停住"。 */
export function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

/** 场景 + 双相机 + 自写轨道控制。 */
export class BrainScene {
  readonly scene: Scene;
  readonly renderer: WebGLRenderer;
  readonly perspective: PerspectiveCamera;
  readonly orthographic: OrthographicCamera;
  /** 当前生效的相机（永远是上面两个之一的**同一个对象**，不能是副本）。 */
  camera: Camera;
  readonly canvas: HTMLCanvasElement;

  /** 轨道状态：球坐标（围绕 target）。 */
  private azimuth = Math.PI * 0.25;
  private polar = Math.PI * 0.36;
  private distance = 800;
  private target = new Vector3(0, 0, 0);
  /** 目标状态（阻尼趋近）。 */
  private targetAzimuth = Math.PI * 0.25;
  private targetPolar = Math.PI * 0.36;
  private targetDistance = 800;
  private targetPoint = new Vector3(0, 0, 0);
  private projection: 'perspective' | '3d-ortho' | '2d' = 'perspective';
  private orthoZoom = 1;

  readonly flight: Flight = {
    active: false, startedAt: 0, duration: 520,
    fromTarget: new Vector3(), toTarget: new Vector3(),
    fromDistance: 800, toDistance: 800,
    fromQuat: { x: 0, y: 0, z: 0, w: 1 }, toQuat: { x: 0, y: 0, z: 0, w: 1 },
  };

  private readonly tmpDir = new Vector3();
  private readonly tmpQuat = { x: 0, y: 0, z: 0, w: 1 };
  private readonly raycaster = new Raycaster();

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(BG_COLOR, 1);
    this.renderer.outputColorSpace = 'srgb' as never;

    this.scene = new Scene();
    this.scene.background = new Color(BG_COLOR);
    this.scene.fog = new Fog(FOG_COLOR, 2500, 12000);

    this.perspective = new PerspectiveCamera(52, 1, 0.5, 40000);
    this.orthographic = new OrthographicCamera(-1, 1, 1, -1, -20000, 40000);
    this.camera = this.perspective;

    this.resize();
  }

  /** 当前投影模式：perspective（3D）/ 3d-ortho / 2d（正交，像素清晰）。 */
  get projectionMode(): 'perspective' | '3d-ortho' | '2d' { return this.projection; }

  /** 切投影。返回实际生效的投影（hierarchy 2D 才允许正交对齐）。 */
  /**
   * 切换投影。
   *
   * 关键：这里直接**换引用**，而不是把另一台相机 copy() 过来再继续用副本。
   * 曾经用 copy() 的写法，导致 resize()/setOrthoHalfHeight() 更新的是
   * this.orthographic 这个"模板对象"，而真正参与渲染的 this.camera 是一个
   * 早已脱离关系的快照——切到 2D 后画面直接空白（矩阵还停在旧值）。
   */
  setProjection(mode: 'perspective' | '3d-ortho' | '2d'): void {
    if (this.projection === mode) return;
    this.projection = mode;
    this.camera = mode === 'perspective' ? this.perspective : this.orthographic;
    this.scene.fog = mode === 'perspective' ? new Fog(FOG_COLOR, 2500, 12000) : null;
    this.resize();
    this.applyCamera();
  }

  /** 视口尺寸变化：两台相机都更新（正交用窗口像素当世界单位）。 */
  resize(): void {
    const width = Math.max(1, this.canvas.clientWidth || window.innerWidth);
    const height = Math.max(1, this.canvas.clientHeight || window.innerHeight);
    this.renderer.setSize(width, height, false);
    const aspect = width / height;
    this.perspective.aspect = aspect;
    this.perspective.updateProjectionMatrix();
    // orthoZoom 是"放大倍数"（越大越近），所以半高要**除以**它。
    // 之前写成乘，等于把正交相机放大了 orthoZoom² 倍——2D 层级图直接被怼到脸上。
    const halfH = height * 0.5 / this.orthoZoom;
    this.orthographic.left = -halfH * aspect;
    this.orthographic.right = halfH * aspect;
    this.orthographic.top = halfH;
    this.orthographic.bottom = -halfH;
    this.orthographic.updateProjectionMatrix();
  }

  /** 正交相机的一个世界单位对应多少像素（标签精灵按它缩放，保证 1:1 清晰）。 */
  get pixelsPerWorldUnit(): number {
    if (this.projection === 'perspective') {
      const h = Math.max(1, this.canvas.clientHeight);
      const fov = (this.perspective.fov * Math.PI) / 180;
      return h / (2 * Math.tan(fov / 2) * Math.max(1e-3, this.distance));
    }
    return this.canvas.clientHeight / Math.max(1e-3, this.orthographic.top - this.orthographic.bottom);
  }

  /** 拖拽旋转（像素增量 → 角度）。 */
  orbit(dx: number, dy: number): void {
    const speed = 2 * Math.PI / Math.max(240, this.canvas.clientHeight);
    this.targetAzimuth -= dx * speed * 1.6;
    this.targetPolar = Math.min(MAX_POLAR, Math.max(MIN_POLAR, this.targetPolar - dy * speed));
    this.flight.active = false;
  }

  /** 滚轮缩放：透视改距离，正交改缩放（像素级清晰，不改变视角）。 */
  zoom(deltaY: number): void {
    // 统一手感：滚轮向下（deltaY > 0）= 拉远 / 缩小
    const factor = Math.exp(deltaY * 0.0012);
    if (this.projection === 'perspective') {
      this.targetDistance = Math.min(30000, Math.max(MIN_DISTANCE, this.targetDistance * factor));
    } else {
      this.orthoZoom = Math.min(400, Math.max(0.002, this.orthoZoom / factor));
      this.resize();
      this.applyCamera();
    }
    this.flight.active = false;
  }

  /** 右键平移：沿相机的右/上方向移动 target。 */
  pan(dx: number, dy: number): void {
    const perPixel = this.projection === 'perspective'
      ? (2 * Math.tan((this.perspective.fov * Math.PI) / 360) * this.distance) / Math.max(1, this.canvas.clientHeight)
      : (this.orthographic.top - this.orthographic.bottom) / Math.max(1, this.canvas.clientHeight);
    const right = new Vector3().setFromMatrixColumn(this.camera.matrix, 0);
    const up = new Vector3().setFromMatrixColumn(this.camera.matrix, 1);
    this.targetPoint.addScaledVector(right, -dx * perPixel).addScaledVector(up, dy * perPixel);
    this.flight.active = false;
  }

  /** 立即把相机放到某个球坐标（不做动画），用于首帧与复位。 */
  setPose(target: Vector3, distance: number, azimuth?: number, polar?: number): void {
    this.targetPoint.copy(target);
    this.target.copy(target);
    if (azimuth !== undefined) { this.azimuth = azimuth; this.targetAzimuth = azimuth; }
    if (polar !== undefined) { this.polar = polar; this.targetPolar = polar; }
    this.distance = distance; this.targetDistance = distance;
    this.flight.active = false;
    this.applyCamera();
  }

  /** 正交取景：让世界半高恰好等于 halfHeight（像素级取景，等价于透视的 fit）。 */
  fitOrtho(halfHeight: number): void {
    const height = Math.max(1, this.canvas.clientHeight || window.innerHeight);
    this.orthoZoom = (height * 0.5) / Math.max(1e-3, halfHeight);
    this.resize();
    this.applyCamera();
  }



  /** 复位到默认视角（Space）。 */
  reset(distance: number): void {
    this.flight.active = false;
    this.targetPoint.set(0, 0, 0);
    this.targetAzimuth = Math.PI * 0.25;
    this.targetPolar = Math.PI * 0.36;
    this.targetDistance = distance;
    this.orthoZoom = 1;
    this.resize();
  }

  /** 当前 target（聚焦动画起点）。 */
  get focusPoint(): Vector3 { return this.targetPoint.clone(); }
  get currentDistance(): number { return this.distance; }

  /**
   * 启动一次聚焦转场：目标点 + 目标距离 + 目标朝向。
   * 朝向用四元数 slerp、位置用球面插值，duration 由调用方给（400–600ms）。
   */
  flyTo(toTarget: Vector3, toDistance: number, toQuat: { x: number; y: number; z: number; w: number }, duration = 520): void {
    this.flight.fromTarget.copy(this.targetPoint);
    this.flight.toTarget.copy(toTarget);
    this.flight.fromDistance = this.projection === 'perspective'
      ? this.distance
      : (this.orthographic.top - this.orthographic.bottom);
    this.flight.toDistance = toDistance;
    lookQuaternion(this.currentPosition(), this.targetPoint, this.flight.fromQuat);
    this.flight.toQuat.x = toQuat.x; this.flight.toQuat.y = toQuat.y;
    this.flight.toQuat.z = toQuat.z; this.flight.toQuat.w = toQuat.w;
    this.flight.startedAt = performance.now();
    this.flight.duration = Math.max(1, duration);
    this.flight.active = true;
  }

  /** 当前相机世界位置。 */
  currentPosition(): Vector3 {
    const p = new Vector3();
    this.camera.getWorldPosition(p);
    return p;
  }

  /** 每帧更新：阻尼趋近 + 转场插值，然后写回相机。 */
  update(now: number): void {
    if (this.flight.active) {
      const raw = (now - this.flight.startedAt) / this.flight.duration;
      const t = easeOutCubic(Math.min(1, Math.max(0, raw)));
      // 位置：两个端点做 lerpVectors，再用 slerp 出的朝向把相机放到球面上
      this.targetPoint.lerpVectors(this.flight.fromTarget, this.flight.toTarget, t);
      slerp(this.flight.fromQuat, this.flight.toQuat, t, this.tmpQuat);
      this.camera.quaternion.set(this.tmpQuat.x, this.tmpQuat.y, this.tmpQuat.z, this.tmpQuat.w);
      if (this.projection === 'perspective') {
        this.distance = this.flight.fromDistance + (this.flight.toDistance - this.flight.fromDistance) * t;
        this.camera.position.copy(this.targetPoint).addScaledVector(this.tmpDir.set(0, 0, 1).applyQuaternion(this.camera.quaternion), this.distance);
        this.targetDistance = this.distance;
      } else {
        const halfH = this.flight.fromDistance + (this.flight.toDistance - this.flight.fromDistance) * t;
        this.orthoZoom = (this.canvas.clientHeight * 0.5) / Math.max(1e-3, halfH);
        this.resize();
        this.camera.position.copy(this.targetPoint).addScaledVector(this.tmpDir.set(0, 0, 1).applyQuaternion(this.camera.quaternion), 4000);
      }
      this.camera.updateMatrixWorld();
      if (raw >= 1) this.flight.active = false;
      return;
    }
    if (this.projection === 'perspective') {
      // 指数阻尼：与帧率无关，60Hz 和 144Hz 手感一致
      const k = 1 - Math.exp(-1 / 8);
      this.azimuth += (this.targetAzimuth - this.azimuth) * k;
      this.polar += (this.targetPolar - this.polar) * k;
      this.distance += (this.targetDistance - this.distance) * k;
      this.target.lerp(this.targetPoint, k);
      this.applyCamera();
    } else {
      const k = 1 - Math.exp(-1 / 8);
      this.azimuth += (this.targetAzimuth - this.azimuth) * k;
      this.polar += (this.targetPolar - this.polar) * k;
      this.target.lerp(this.targetPoint, k);
      this.applyCamera();
    }
  }

  private applyCamera(): void {
    const sinPolar = Math.sin(this.polar);
    const dir = new Vector3(
      sinPolar * Math.sin(this.azimuth),
      Math.cos(this.polar),
      sinPolar * Math.cos(this.azimuth),
    );
    if (this.projection === 'perspective') {
      this.camera.position.copy(this.target).addScaledVector(dir, this.distance);
      this.camera.lookAt(this.target);
      this.camera.updateMatrixWorld();
    } else {
      // 正交：拉远到不会裁剪的距离，用 zoom 表达缩放
      this.camera.position.copy(this.target).addScaledVector(dir, 8000);
      this.camera.lookAt(this.target);
      this.camera.updateMatrixWorld();
    }
  }

  /** 屏幕坐标 → 归一化设备坐标。 */
  toNdc(clientX: number, clientY: number, out = new Vector2()): Vector2 {
    const rect = this.canvas.getBoundingClientRect();
    out.x = ((clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
    out.y = -((clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1;
    return out;
  }

  /** 供拾取使用（一次点击一条射线）。 */
  makeRaycaster(clientX: number, clientY: number): Raycaster {
    this.raycaster.setFromCamera(this.toNdc(clientX, clientY), this.camera);
    return this.raycaster;
  }

  /** 世界坐标 → 屏幕像素（标签与 mini-map 用）。 */
  project(point: Vector3, out = new Vector2()): Vector2 {
    const v = point.clone().project(this.camera);
    const rect = this.canvas.getBoundingClientRect();
    out.x = (v.x * 0.5 + 0.5) * rect.width;
    out.y = (-v.y * 0.5 + 0.5) * rect.height;
    return out;
  }

  /**
   * 让相机恰好容纳一个包围球。
   *
   * 透视返回"相机距离"，正交返回"半高"——两者单位不同，调用方必须按
   * projectionMode 决定往哪儿塞（塞错了就是正交下画面被放大 100 倍的经典事故）。
   */
  frameRadius(radius: number, padding = 1.35): number {
    if (this.projection === 'perspective') {
      const fov = (this.perspective.fov * Math.PI) / 180;
      return Math.max(MIN_DISTANCE, (radius * padding) / Math.tan(fov / 2));
    }
    // 正交：返回**世界半高**，让半径乘上 padding 后正好铺满视口短边
    const height = Math.max(1, this.canvas.clientHeight || window.innerHeight);
    const width = Math.max(1, this.canvas.clientWidth || window.innerWidth);
    const aspect = width / height;
    const halfHeight = radius * padding;
    const halfWidth = halfHeight * aspect;
    void height; void width;
    return Math.max(halfHeight, halfWidth / aspect);
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.renderer.dispose();
  }
}
