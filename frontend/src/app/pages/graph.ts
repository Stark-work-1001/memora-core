/**
 * 脑图入口：iframe 嵌入 /brain.html?view=<view>&focus=<id>，并提供视图切换
 * （语义 / 层级 / 时间线 / 证据）与独立打开。brain.js 读取这两个参数
 * （brain/main.ts readLaunchParams），服务端对同源 iframe 放行（frame-ancestors 'self'）。
 */

import { el } from '../dom';
import { badge, button, emptyState, toast } from './ui';
import type { PageModule } from './contract';

const VIEWS: { value: string; label: string; hint: string }[] = [
  { value: 'semantic', label: '语义', hint: '按向量相似度聚类，看主题簇' },
  { value: 'hierarchy', label: '层级', hint: '作用域 → 记忆的父子结构' },
  { value: 'timeline', label: '时间线', hint: '按创建时间排列，看演进' },
  { value: 'evidence', label: '证据', hint: '记忆与其证据来源的连边' },
];

export const graphPage: PageModule = {
  id: 'graph',
  title: '脑图',
  icon: 'graph',
  group: 'main',
  shortcut: 'g b',
  render(ctx) {
    const initial = ctx.params.get('view') ?? 'semantic';
    let view = VIEWS.some((v) => v.value === initial) ? initial : 'semantic';
    const focus = ctx.params.get('focus') ?? '';

    const page = el('div', { class: 'page page-graph' });
    ctx.mount.appendChild(page);

    const chipRow = el('div', { class: 'chip-row' });
    const frameHost = el('div', { class: 'frame-host' });

    const src = (): string => {
      const params = new URLSearchParams({ view });
      if (focus) params.set('focus', focus);
      return `/brain.html?${params.toString()}`;
    };

    function renderChips(): void {
      chipRow.replaceChildren(
        ...VIEWS.map((item) => el('button', {
          class: `chip-btn ${view === item.value ? 'is-active' : ''}`.trim(),
          type: 'button',
          title: item.hint,
          onClick: () => {
            view = item.value;
            // 把视图写回地址栏（不触发 hashchange 重渲染），刷新 / 分享链接时保持当前视图
            const params = new URLSearchParams({ view });
            if (focus) params.set('focus', focus);
            history.replaceState(null, '', `#/graph?${params.toString()}`);
            renderChips();
            mountFrame();
          },
          'aria-pressed': view === item.value ? 'true' : 'false',
        }, item.label)),
        el('span', { class: 'muted-text' }, VIEWS.find((v) => v.value === view)?.hint ?? ''),
      );
    }

    function mountFrame(): void {
      const iframe = el('iframe', {
        class: 'brain-frame',
        src: src(),
        title: '脑图',
        loading: 'lazy',
        sandbox: 'allow-scripts allow-same-origin allow-popups allow-downloads',
      });
      const overlay = el('div', { class: 'frame-overlay' },
        el('div', { class: 'muted-text' }, '正在加载脑图…'));
      let settled = false;
      iframe.addEventListener('load', () => {
        settled = true;
        overlay.remove();
      });
      iframe.addEventListener('error', () => {
        if (settled) return;
        overlay.replaceChildren(emptyState(
          '脑图加载失败',
          '没有取到 brain.html / brain.js；请确认前端已构建（cd frontend && npm run build）。',
        ));
      });
      // 兜底：iframe 已同源加载完成但 load 事件因缓存未触发时不至于一直显示遮罩
      window.setTimeout(() => {
        if (!settled && overlay.isConnected) overlay.remove();
      }, 3000);
      frameHost.replaceChildren(iframe, overlay);
    }

    page.append(
      el('div', { class: 'page-head' },
        el('div', { class: 'page-head-left' },
          el('h1', { class: 'page-title' }, '脑图'),
          el('div', { class: 'page-head-meta' },
            badge('three.js · 2D/3D', 'info'),
            el('span', { class: 'muted-text' }, '节点点击可转场到最佳视角；本页仅做嵌入与视图切换'))),
        el('div', { class: 'page-head-actions' },
          button('独立打开', {
            iconName: 'external',
            onClick: () => {
              window.open(src(), '_blank', 'noopener');
              toast('已在新标签打开脑图', 'info');
            },
          }),
          button('刷新', {
            iconName: 'refresh',
            kind: 'subtle',
            onClick: () => mountFrame(),
          }))),
      chipRow,
      frameHost,
    );

    renderChips();
    mountFrame();

    ctx.mount.addEventListener('mem:dispose', () => {
      /* iframe 随 DOM 一起移除 */
    }, { once: true });
  },
};
