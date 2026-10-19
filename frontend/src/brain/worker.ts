/**
 * 布局 Worker：用 Blob URL 起线程，主线程只做渲染。
 *
 * 为什么不是 \`new Worker(new URL('./worker.ts', import.meta.url))\`：
 * 打包产物是 IIFE，esbuild 对 worker 入口会生成**第二个文件**，而 build.mjs 只产出
 * brain.js 一个文件（页面也只加载它）。Blob URL 把 worker 内嵌进同一个 bundle，
 * 符合"brain.js 自己渲染一切"的要求。
 *
 * 为什么 Blob 里没有 eval：页面 CSP 是 \`script-src 'self'\`（无 unsafe-eval），
 * blob: worker 继承该 CSP，所以 \`new Function()\` / \`eval()\` 会被拒绝。这里把
 * layoutKernel() 的**源码文本**拼进 Blob 脚本，由浏览器按正常脚本解析执行——
 * 不触发 CSP，也不需要维护第二份算法副本。
 *
 * 失败兜底：CSP、Safari 旧版、创建 worker 抛错时，主线程用同一份 kernel 同步算，
 * 界面只是短暂卡一下，功能不丢。
 */
import { layoutKernel, runLayout, type LayoutKernel, type LayoutOptions } from './layout';
import type { LayoutEdge, LayoutNode, LayoutResult, ViewKind } from './types';

/** 主线程 → Worker。 */
interface LayoutRequest {
  type: 'layout';
  requestId: number;
  view: ViewKind;
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  opts: LayoutOptions;
}

/** Worker → 主线程（成功）。 */
export interface LayoutDone {
  type: 'done';
  requestId: number;
  positions: Float32Array;
  dims: 2 | 3;
  meta: LayoutResult['meta'];
}

/** Worker → 主线程（失败）。 */
export interface LayoutFailed {
  type: 'error';
  requestId: number;
  message: string;
}

export type LayoutReply = LayoutDone | LayoutFailed;

/**
 * Worker 侧的完整脚本。
 *
 * \`kernelFactory\` 是 layoutKernel 的源码：一个自包含函数字面量。
 * 把它包在 \`(<source>)\` 里就是合法的函数表达式，浏览器直接解析，全程无 eval。
 */
function buildWorkerSource(): string {
  return [
    'const layoutKernel = (' + layoutKernel.toString() + ');',
    'const kernel = layoutKernel();',
    'self.onmessage = function (event) {',
    '  var msg = event.data;',
    '  if (!msg || msg.type !== "layout") return;',
    '  try {',
    '    var fn = kernel[msg.view] || kernel.semantic;',
    '    var result = fn(msg.nodes, msg.edges, msg.opts || {});',
    '    var positions = result.positions;',
    '    self.postMessage({',
    '      type: "done", requestId: msg.requestId, positions: positions,',
    '      dims: result.dims, meta: result.meta',
    '    }, [positions.buffer]);',
    '  } catch (err) {',
    '    self.postMessage({',
    '      type: "error", requestId: msg.requestId,',
    '      message: String((err && err.message) || err)',
    '    });',
    '  }',
    '};',
  ].join('\n');
}

/** 布局客户端：一个在飞的请求 + 一个排队的最新请求（只保留最新的，旧结果直接丢弃）。 */
export class LayoutWorkerClient {
  private worker: Worker | null = null;
  private objectUrl: string | null = null;
  private nextId = 1;
  private pending = new Map<number, {
    resolve: (r: LayoutResult) => void;
    reject: (e: Error) => void;
  }>();
  /** Worker 不可用时的同步兜底 kernel。 */
  private fallback: LayoutKernel | null = null;
  /** 是否真的跑在 worker 里（性能面板会显示）。 */
  readonly mode: 'worker' | 'main';
  /** 最近一次失败的创建原因，供 UI 提示。 */
  readonly unavailableReason: string | null = null;

  constructor() {
    let reason: string | null = null;
    try {
      const source = buildWorkerSource();
      const blob = new Blob([source], { type: 'text/javascript' });
      this.objectUrl = URL.createObjectURL(blob);
      this.worker = new Worker(this.objectUrl);
      this.worker.onmessage = (event: MessageEvent<LayoutReply>) => this.onMessage(event.data);
      this.worker.onerror = () => {
        // worker 运行时崩了：把在飞的请求全部退化成主线程计算，而不是永远挂着。
        this.demote('worker 运行时报错');
      };
    } catch (err) {
      reason = err instanceof Error ? err.message : String(err);
      this.worker = null;
    }
    this.mode = this.worker ? 'worker' : 'main';
    this.unavailableReason = this.worker ? null : (reason ?? 'worker 不可用');
  }

  private demote(reason: string): void {
    if (this.worker) {
      try { this.worker.terminate(); } catch { /* 已终止 */ }
      this.worker = null;
    }
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
    this.fallback = this.fallback ?? layoutKernel();
    const pending = Array.from(this.pending.values());
    this.pending.clear();
    for (const p of pending) p.reject(new Error(reason));
  }

  private onMessage(reply: LayoutReply): void {
    const entry = this.pending.get(reply.requestId);
    if (!entry) return; // 过期请求：结果被丢弃
    this.pending.delete(reply.requestId);
    if (reply.type === 'error') {
      entry.reject(new Error(reply.message));
      return;
    }
    entry.resolve({
      positions: reply.positions,
      dims: reply.dims,
      meta: reply.meta,
    });
  }

  /** 请求一次布局。旧的未完成请求会被 reject，从而丢弃过期结果。 */
  run(view: ViewKind, nodes: LayoutNode[], edges: LayoutEdge[], opts: LayoutOptions): Promise<LayoutResult> {
    if (!this.worker) {
      // 同步兜底：在同一帧里算完，界面卡顿一下但结果正确。
      try {
        return Promise.resolve(runLayout(view, nodes, edges, opts, this.fallback ?? layoutKernel()));
      } catch (err) {
        return Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }
    }
    // 只保留最新一次：视图切换时旧的布局结果已经没意义了。
    for (const [id, entry] of this.pending) {
      this.pending.delete(id);
      entry.reject(new Error('superseded'));
    }
    const requestId = this.nextId++;
    const message: LayoutRequest = { type: 'layout', requestId, view, nodes, edges, opts };
    return new Promise<LayoutResult>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.worker?.postMessage(message);
    });
  }

  dispose(): void {
    this.demote('disposed');
    this.fallback = null;
  }
}
