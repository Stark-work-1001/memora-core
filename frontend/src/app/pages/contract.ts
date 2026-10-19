/**
 * 页面模块契约。每个页面导出一个 PageModule，由 main.ts 的 router 挂载。
 * 这里只放类型，避免页面反向依赖入口造成运行时循环。
 */

import type { Tone } from './ui';

export interface PageContext {
  /** 页面唯一挂载点，路由切换时整体替换。 */
  mount: HTMLElement;
  /** 跳转到其它路由，可带查询参数（如 { id }）。 */
  navigate(route: string, params?: Record<string, string>): void;
  /** 当前路由参数。 */
  params: URLSearchParams;
  /** 顶部提示条文案（右侧全局状态区）。 */
  setStatus(text: string): void;
  /** Toast。 */
  notify(message: string, tone?: Tone): void;
  /**
   * 订阅 SSE 事件：kind 命中时调用 handler。
   * 返回取消订阅函数；页面卸载时会被自动调用。
   */
  onEvent(kinds: string[], handler: () => void): () => void;
  /** 全局刷新计数（SSE 或手动刷新时递增），页面可据此重载。 */
  readonly refreshTick: number;
  /** 当前选择的智能体（如需联动）。 */
  readonly agentId: string | null;
}

export interface PageModule {
  id: string;
  title: string;
  /** 侧边栏图标名（dom.ts 的 ICON_PATHS）。 */
  icon: string;
  /** 侧边栏分组。 */
  group: string;
  /** 侧边栏快捷键提示，如 'g m'。 */
  shortcut?: string;
  render(ctx: PageContext): void | Promise<void>;
}
