'use strict';
/* Workflow orchestration, part 2: the DAG canvas, embedded in the workbench shell.
 *
 * WHY THIS EXISTS
 * The canvas used to be a separate top-level page (/dag/). Clicking 工作流画布 left the workbench
 * entirely: the sidebar disappeared, the only way back was the browser Back button or one link
 * that the page itself had to provide, and the canvas had no relationship to the model pool and
 * role bindings that decide what its nodes actually run. The nav entry, the section and this
 * adapter now live inside the shell, so switching view keeps the sidebar and the project scope.
 *
 * HOW
 * dag-app.js is a self-contained IIFE built from frontend/dag-main.ts. It binds by id on load and
 * expects the whole `.dag` skeleton to exist. This file injects that skeleton into #workflow-visual,
 * loads the stylesheet once, then evaluates the built bundle. The bundle keeps its own internal
 * state; the only thing crossing the boundary is setRegistry(), which hands it the operation names
 * and model ids that orchestration.js fetched, so the inspector offers real choices instead of
 * free-text ids.
 *
 * Ids are pre-fixed `dag-` in the bundle, so the embedded skeleton keeps them verbatim: the bundle
 * is used as shipped and is not forked for embedding.
 */

(function embedWorkflowCanvas() {
  // orchestration.js owns #workflow-visual's markup and reserves #workflow-canvas-slot at the TOP
  // of the view, so the canvas reads as the primary instrument and the panels below it as detail.
  // Mounting into the slot (not appending to the view) is what keeps that order stable.
  const host = $('workflow-canvas-slot') || $('workflow-visual');
  if (!host) return;

  // ---------------------------------------------------------------- stylesheet, once
  if (!document.getElementById('dag-embed-css')) {
    const link = document.createElement('link');
    link.id = 'dag-embed-css';
    link.rel = 'stylesheet';
    link.href = '/dag/styles.css';
    document.head.append(link);
  }

  // ---------------------------------------------------------------- skeleton
  // Scoped inside #workflow-visual, and .dag-embed replaces the full-viewport .dag layout with a
  // fixed-height panel so it can live in a scrolling page.
  const shell = node('div', undefined, 'dag dag-embed');
  shell.innerHTML = `
  <header class="dag-bar">
    <h2 class="dag-title">工作流可视化</h2>
    <span class="dag-spacer"></span>
    <button type="button" id="dag-add-node">添加节点</button>
    <button type="button" id="dag-remove-node">删除节点</button>
    <button type="button" id="dag-remove-edge">删除连线</button>
    <button type="button" id="dag-organize">整理布局</button>
    <span class="dag-group">
      <button type="button" id="dag-zoom-out" aria-label="缩小">−</button>
      <button type="button" id="dag-zoom-in" aria-label="放大">+</button>
      <button type="button" id="dag-fit">适应窗口</button>
    </span>
    <button type="button" id="dag-save" class="dag-primary">保存</button>
  </header>
  <div class="dag-body">
    <nav class="dag-rail" aria-label="工作流列表">
      <div class="dag-rail-head">
        <strong>工作流</strong>
        <button type="button" id="dag-new-workflow">新建</button>
      </div>
      <div id="dag-list-items" class="dag-list-items"></div>
    </nav>
    <section class="dag-stage">
      <div id="dag-canvas" class="dag-canvas-host"></div>
      <div id="dag-empty" class="dag-empty" hidden></div>
      <p class="dag-hint">拖动卡片排版 · 从卡片右侧圆点拖到另一张卡片建立连线 · 滚轮缩放 · 空白处拖动平移 · Delete 删除所选</p>
    </section>
    <aside class="dag-inspector">
      <div id="dag-inspector-body" class="dag-inspector-body"></div>
      <div class="dag-run">
        <h2>运行</h2>
        <label for="dag-slug">运行于文档</label>
        <input id="dag-slug" data-audience="human" placeholder="文档 slug" autocomplete="off">
        <label for="dag-audience">读取用途</label>
        <select id="dag-audience">
          <option value="human">面向人（human）</option>
          <option value="agent">面向智能体（agent）</option>
        </select>
        <div class="dag-run-actions">
          <button type="button" id="dag-run">运行</button>
          <button type="button" id="dag-cancel">取消</button>
          <button type="button" id="dag-refresh-runs">刷新状态</button>
        </div>
        <div id="dag-run-body" class="dag-run-body"></div>
      </div>
    </aside>
  </div>
  <footer class="dag-foot">
    <span id="dag-state" class="dag-state"></span>
    <span id="dag-notice" class="dag-notice" hidden></span>
  </footer>`;
  host.append(shell);

  // ---------------------------------------------------------------- bundle
  // One load per document: the bundle boots immediately on evaluation and binds every id inside
  // .dag, so loading it twice would double-bind handlers.
  if (window.memoraWorkflowCanvas && window.memoraWorkflowCanvas.booted) return;
  const script = document.createElement('script');
  script.src = '/dag/app.js';
  script.defer = true;
  script.onerror = () => {
    shell.querySelector('.dag-stage').append(
      node('p', '画布脚本未能加载：请确认 /dag/app.js 可访问。', 'dag-notice dag-notice--error'));
  };
  document.body.append(script);

  // ---------------------------------------------------------------- handoff surface
  /* orchestration.js calls this after it has fetched the registry. The bundle owns node editing,
     so the shared vocabularies are pushed onto a module-scope hook the inspector reads when it
     builds its selects. Until then the canvas works with whatever the saved workflows contain. */
  window.memoraWorkflowCanvas = {
    booted: true,
    registry: {operations: [], models: [], bindings: {}, workflows: [], runs: []},
    setRegistry(next) {
      Object.assign(this.registry, next || {});
      // The inspector is rebuilt on selection, and a new node picks its default model from here,
      // so pushing the registry is enough: the next render reads it.
      if (typeof window.dagRefreshInspector === 'function') window.dagRefreshInspector();
    }
  };
})();
