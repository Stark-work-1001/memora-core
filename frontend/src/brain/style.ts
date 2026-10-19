/**
 * 运行期样式表。
 *
 * 为什么 CSS 会出现在 .ts 里：brain.html 只保证有一个 <div id="mem-brain">，
 * 而 build.mjs（不在我的可写范围内）没有配置 CSS→JS 的 loader，
 * `import './style.css'` 只会产出一个 brain.css 文件，而页面根本不会引用它。
 * 所以样式以字符串形式随 brain.js 一起发布：brain.js 自己注入 <style>，
 * 页面只需要那个 div，符合"brain.js 自己渲染所有 UI"的要求。
 *
 * style.css 是同一份内容的可读副本（人读、可单独引用），
 * 两者是否一致由 tests/brain-style.test.mjs 断言，不会悄悄漂移。
 */
export const BRAIN_CSS = String.raw`/* 记忆脑图叠加层样式。
   深色 + 青绿主色，等宽数字，卡片化；UI 全部由 brain.js 注入，不依赖任何外部样式表。
   1080p 以下自动收缩内边距，1280×800 起可用。 */

.mem-brain-root {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: #070b12;
  color: #d8e6f2;
  font: 13px/1.5 "Segoe UI", "Microsoft YaHei", system-ui, -apple-system, sans-serif;
  user-select: none;
  -webkit-font-smoothing: antialiased;
}

.mem-brain-root canvas.mem-brain-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
  touch-action: none;
  cursor: grab;
}

.mem-brain-root canvas.mem-brain-canvas:active { cursor: grabbing; }

.mem-brain-ui {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 2;
}

.mem-brain-ui > * { pointer-events: auto; }

/* ---------- 顶栏 ---------- */

.mem-topbar {
  position: absolute;
  top: 12px;
  left: 12px;
  right: 12px;
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.mem-group {
  display: inline-flex;
  background: rgba(10, 18, 28, 0.86);
  border: 1px solid rgba(96, 160, 200, 0.22);
  border-radius: 9px;
  overflow: hidden;
  backdrop-filter: blur(8px);
}

.mem-group button {
  appearance: none;
  border: 0;
  background: transparent;
  color: #9fb6cc;
  padding: 7px 13px;
  font: inherit;
  font-size: 12.5px;
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease;
  white-space: nowrap;
}

.mem-group button:hover { background: rgba(74, 163, 223, 0.14); color: #d6ecff; }

.mem-group button.is-active {
  background: linear-gradient(180deg, rgba(62, 207, 142, 0.28), rgba(74, 163, 223, 0.28));
  color: #eafcff;
  box-shadow: inset 0 -2px 0 #3ecf8e;
}

.mem-group button.is-active.is-active--alt { box-shadow: inset 0 -2px 0 #b07cf0; }

.mem-spacer { flex: 1 1 auto; min-width: 8px; }

/* ---------- 搜索 ---------- */

.mem-searchbox { position: relative; }

.mem-searchbox input {
  width: 220px;
  padding: 7px 11px;
  border-radius: 9px;
  border: 1px solid rgba(96, 160, 200, 0.22);
  background: rgba(10, 18, 28, 0.86);
  color: #e2f0ff;
  font: inherit;
  font-size: 12.5px;
  outline: none;
  backdrop-filter: blur(8px);
}

.mem-searchbox input:focus { border-color: rgba(62, 207, 142, 0.6); box-shadow: 0 0 0 2px rgba(62, 207, 142, 0.16); }
.mem-searchbox input::placeholder { color: #5d7590; }

.mem-search-list {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  width: 300px;
  max-height: 320px;
  overflow: auto;
  background: rgba(9, 16, 25, 0.97);
  border: 1px solid rgba(96, 160, 200, 0.26);
  border-radius: 9px;
  display: none;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.55);
}

.mem-search-list.is-open { display: block; }

.mem-search-list button {
  display: flex;
  width: 100%;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 11px;
  background: transparent;
  border: 0;
  border-bottom: 1px solid rgba(80, 120, 160, 0.12);
  color: #d8e6f2;
  font: inherit;
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
}

.mem-search-list button:hover { background: rgba(74, 163, 223, 0.16); }
.mem-search-list button b { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mem-search-list button span { color: #6d87a0; font-size: 11.5px; flex: 0 0 auto; }

/* ---------- 过滤面板（右上） ---------- */

.mem-filter {
  position: absolute;
  top: 58px;
  right: 12px;
  width: 208px;
  padding: 11px;
  background: rgba(10, 18, 28, 0.86);
  border: 1px solid rgba(96, 160, 200, 0.22);
  border-radius: 9px;
  backdrop-filter: blur(8px);
}

.mem-filter-title { font-size: 11.5px; letter-spacing: 0.08em; color: #6d87a0; text-transform: uppercase; margin-bottom: 8px; }

.mem-chips { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 9px; }

.mem-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 8px;
  border-radius: 999px;
  border: 1px solid rgba(96, 160, 200, 0.3);
  background: rgba(74, 163, 223, 0.1);
  color: #c7dcee;
  font: inherit;
  font-size: 11.5px;
  cursor: pointer;
  transition: opacity 120ms ease;
}

.mem-chip i { width: 7px; height: 7px; border-radius: 50%; display: block; }
.mem-chip.is-off { opacity: 0.32; filter: grayscale(1); }

.mem-filter-row { margin-top: 7px; }
.mem-filter-row label { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 12px; color: #8ba3ba; }

.mem-filter-row select {
  flex: 1 1 auto;
  min-width: 0;
  padding: 4px 6px;
  border-radius: 6px;
  border: 1px solid rgba(96, 160, 200, 0.24);
  background: rgba(7, 13, 21, 0.9);
  color: #d8e6f2;
  font: inherit;
  font-size: 12px;
  outline: none;
}

/* ---------- 水印 / loading ---------- */

.mem-watermark {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%) rotate(-18deg);
  font-size: 72px;
  font-weight: 800;
  letter-spacing: 0.12em;
  color: rgba(126, 198, 240, 0.07);
  pointer-events: none;
  white-space: nowrap;
  text-shadow: 0 0 24px rgba(74, 163, 223, 0.12);
}

.mem-loading {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  padding: 9px 18px;
  border-radius: 999px;
  background: rgba(10, 18, 28, 0.92);
  border: 1px solid rgba(62, 207, 142, 0.35);
  color: #9ff0c8;
  font-size: 12.5px;
  letter-spacing: 0.04em;
}

/* ---------- mini-map（左下） ---------- */

.mem-minimap-wrap {
  position: absolute;
  left: 12px;
  bottom: 40px;
  padding: 3px;
  border-radius: 9px;
  background: rgba(10, 18, 28, 0.86);
  border: 1px solid rgba(96, 160, 200, 0.22);
  backdrop-filter: blur(8px);
}

.mem-minimap { display: block; width: 160px; height: 160px; border-radius: 6px; cursor: crosshair; }

/* ---------- 统计（右下） ---------- */

.mem-stats {
  position: absolute;
  right: 12px;
  bottom: 40px;
  min-width: 168px;
  padding: 9px 11px;
  background: rgba(10, 18, 28, 0.86);
  border: 1px solid rgba(96, 160, 200, 0.22);
  border-radius: 9px;
  backdrop-filter: blur(8px);
  font-variant-numeric: tabular-nums;
}

.mem-stats div { display: flex; justify-content: space-between; gap: 12px; font-size: 12px; line-height: 1.75; color: #8ba3ba; }
.mem-stats b { color: #d8e6f2; font-weight: 600; font-variant-numeric: tabular-nums; }
.mem-stats b.is-warn { color: #ffb454; }

/* ---------- 图例 ---------- */

.mem-legend {
  position: absolute;
  left: 12px;
  top: 58px;
  max-width: 168px;
  padding: 9px 11px;
  background: rgba(10, 18, 28, 0.8);
  border: 1px solid rgba(96, 160, 200, 0.18);
  border-radius: 9px;
  backdrop-filter: blur(8px);
  font-size: 11.5px;
}

.mem-legend-row { display: flex; align-items: center; gap: 7px; padding: 1.5px 0; color: #9fb6cc; }
.mem-legend-row i { width: 8px; height: 8px; border-radius: 50%; display: block; flex: 0 0 auto; }
.mem-muted { color: #6d87a0; font-size: 11.5px; }

/* ---------- 状态栏 ---------- */

.mem-statusbar {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 14px;
  background: linear-gradient(180deg, rgba(7, 11, 18, 0), rgba(7, 11, 18, 0.9));
  color: #7590a8;
  font-size: 11.5px;
  pointer-events: none;
}

.mem-note { color: #5d7590; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

@media (max-width: 1280px) {
  .mem-filter { width: 184px; }
  .mem-searchbox input { width: 168px; }
  .mem-legend { max-width: 140px; }
}

@media (prefers-reduced-motion: reduce) {
  .mem-group button, .mem-chip { transition: none; }
}`;

/** 把样式注入文档（幂等：重复调用不会重复插入）。 */
export function injectStyles(doc: Document = document): void {
  const existing = doc.getElementById('mem-brain-styles');
  if (existing) return;
  const style = doc.createElement('style');
  style.id = 'mem-brain-styles';
  style.textContent = BRAIN_CSS;
  doc.head.appendChild(style);
}
