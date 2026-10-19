// P8 workflow-demo acceptance: prove the canvas and the run record are REAL, not a mock.
//
// The point of this script is that it reads the running page, not the source: it loads the devel
// backend, switches to 工作流可视化, reads the canvas and the run list out of the DOM, and screenshots
// both. A demo workflow that only exists in a JSON file would fail here.
//
// Run from the repository root (backend must already be up on --base):
//   .\desktop\node_modules\electron\dist\electron.exe tools\verify_workflow_demo.cjs
//   (clear ELECTRON_RUN_AS_NODE first if this shell has it set)
//
// Writes artifacts/p8-workflow/*.png and artifacts/p8-workflow/ui-report.json.
// Exit code 0 only when every assertion passes.
const {app, BrowserWindow} = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const out = path.join(root, 'artifacts', 'p8-workflow');
const base = process.env.P8_BASE || 'http://127.0.0.1:18901';
const delay = ms => new Promise(r => setTimeout(r, ms));

const checks = [];
const errors = [];
const check = (name, pass, detail) => {
  checks.push({name, pass: !!pass, detail});
  if (!pass) errors.push(name);
  return !!pass;
};

const READ_CANVAS = `(() => {
  const text = el => (el && el.textContent ? el.textContent : '').replace(/\\s+/g, ' ').trim();
  const visible = el => {
    if (!el) return false;
    const s = getComputedStyle(el), b = el.getBoundingClientRect();
    return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) !== 0 && b.width > 0 && b.height > 0;
  };
  const view = document.getElementById('workflows');
  const canvas = document.getElementById('dag-canvas');
  const nodes = [...document.querySelectorAll('#dag-canvas .dag-node, #dag-canvas [data-node-id]')];
  const cards = [...document.querySelectorAll('#orchestration-runs > *')];
  return {
    viewVisible: visible(view),
    canvasPresent: !!canvas,
    canvasVisible: visible(canvas),
    nodeCount: nodes.length,
    nodeLabels: nodes.map(n => text(n).slice(0, 80)).filter(Boolean).slice(0, 10),
    railItems: [...document.querySelectorAll('#dag-list-items > *')].map(n => text(n)).filter(Boolean),
    runCards: cards.map(c => text(c)).filter(Boolean),
    runCardsRaw: cards.map(c => c.innerText || '').filter(Boolean).slice(0, 5),
    state: text(document.getElementById('dag-state')),
    title: document.title,
  };
})()`;

async function shot(win, name) {
  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(out, name), image.toPNG());
  return name;
}

async function main() {
  fs.mkdirSync(out, {recursive: true});
  app.setPath('userData', path.join(root, 'artifacts', 'p8-workflow', 'electron-profile'));
  app.disableHardwareAcceleration();
  await app.whenReady();

  const win = new BrowserWindow({show: false, width: 1600, height: 1000, webPreferences: {
    nodeIntegration: false, contextIsolation: true, sandbox: true, offscreen: true, backgroundThrottling: false,
  }});
  const pageErrors = [];
  win.webContents.on('console-message', (...args) => {
    const detail = args.find(a => a && typeof a === 'object' && a.level);
    if (detail && detail.level === 'error') pageErrors.push(detail.message);
  });

  const status = await (await fetch(base + '/api/agent/status')).json();
  const runs = await (await fetch(base + '/api/agent/workflow-runs?project=default')).json();
  const workflows = await (await fetch(base + '/api/agent/workflows?project=default')).json();
  const liveRun = runs.items[0];

  await win.loadURL(base + '/?project=default');
  await delay(1500);
  // Open the workflow view the way a user does: click the nav entry, not a URL hack.
  await win.webContents.executeJavaScript(
    "document.querySelector('button[data-view=workflows]').click(); true");
  await delay(4000);

  // Frame the canvas before the first shot. Opening the view renders the nodes at their stored
  // coordinates, which for a wide 5-node chain is a thin strip near the top; "适应窗口" is the same
  // button a user presses, so pressing it is both more honest and more legible than a raw capture.
  await win.webContents.executeJavaScript("(() => { const b = document.getElementById('dag-fit'); if (b) b.click(); return !!b; })()");
  await delay(1200);
  const canvas = await win.webContents.executeJavaScript(READ_CANVAS);
  await shot(win, '01-workflow-canvas.png');

  const prefix = 'p8: ';
  check(prefix + 'the backend is the devel edition', status.edition === 'devel', {edition: status.edition, version: status.version});
  check(prefix + 'the demo workflow exists in the backend', workflows.items.some(w => w.title.includes('记忆处理 demo')),
    {workflows: workflows.items.map(w => w.title)});
  check(prefix + 'a completed run exists with all stages', liveRun && liveRun.status === 'done'
    && Array.isArray(liveRun.output && liveRun.output.stages) && liveRun.output.stages.length >= 4,
    {status: liveRun && liveRun.status, stages: liveRun && liveRun.output && liveRun.output.stages && liveRun.output.stages.length});
  check(prefix + 'the 工作流可视化 view is visible after clicking the nav entry', canvas.viewVisible, canvas);
  check(prefix + 'the DAG canvas rendered nodes', canvas.canvasPresent && canvas.nodeCount > 0,
    {nodeCount: canvas.nodeCount, labels: canvas.nodeLabels});
  check(prefix + 'the workflow list shows the demo', canvas.railItems.some(t => t.includes('记忆处理 demo')),
    {railItems: canvas.railItems});
  check(prefix + 'the run record is shown in 工作流运行记录',
    canvas.runCards.length > 0, {runCards: canvas.runCards.slice(0, 3)});
  // The run list lives BELOW the canvas in the same scrolling view, so scroll it into frame; a
  // screenshot of the canvas for every shot would show the same pixels twice and prove nothing.
  const scrolled = await win.webContents.executeJavaScript(`(() => {
    const target = document.getElementById('orchestration-runs');
    if (!target) return null;
    const heading = target.previousElementSibling || target;
    heading.scrollIntoView({block: 'start'});
    const box = target.getBoundingClientRect();
    return {top: Math.round(box.top), height: Math.round(box.height)};
  })()`);
  await delay(700);
  await shot(win, '02-run-records.png');

  // A second shot with the run card expanded, so the per-stage evidence is readable in the image.
  // The run card is a <details><summary> — the honest way to open it is to set the SAME attribute
  // the browser sets when a user clicks, not to click through a wrapper that may swallow the event.
  // Open the run card and MEASURE it. Setting `details.open` is not enough to trust: the run list
  // is repainted every 4 s by orchestration.js (setInterval -> refreshProcessing), which replaces the
  // cards and silently collapses them again. So the open is re-applied right before the capture, and
  // the assertion is about the rendered box height, not about the attribute we just wrote.
  const OPEN_RUN = `(() => {
    const cards = [...document.querySelectorAll('#orchestration-runs > *')];
    const first = cards[0];
    if (!first) return {opened: false, reason: 'no run cards'};
    const details = first.querySelector('details') || (first.tagName === 'DETAILS' ? first : null);
    if (!details) return {opened: false, reason: 'no <details> in the run card'};
    details.open = true;
    const pre = details.querySelector('pre');
    const box = pre ? pre.getBoundingClientRect() : null;
    if (details.open && box && box.height > 0) details.scrollIntoView({block: 'center'});
    return {opened: details.open, chars: pre ? pre.textContent.length : 0,
      preHeight: box ? Math.round(box.height) : 0,
      preview: pre ? pre.textContent.slice(0, 300) : null};
  })()`;
  let expanded = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    expanded = await win.webContents.executeJavaScript(OPEN_RUN);
    await delay(250);
    expanded = await win.webContents.executeJavaScript(OPEN_RUN);   // re-open if a repaint collapsed it
    if (expanded && expanded.preHeight > 40) break;
    await delay(400);
  }
  await shot(win, '03-run-record-detail.png');

  check(prefix + 'the run detail really expanded (the screenshot shows the stage evidence, not the list)',
    !!expanded && expanded.opened === true && expanded.preHeight > 40, expanded);
  check(prefix + 'no console errors while loading the page', pageErrors.length === 0, pageErrors.slice(0, 5));

  const report = {
    suite: 'P8 workflow demo UI acceptance',
    command: '.\\desktop\\node_modules\\electron\\dist\\electron.exe tools\\verify_workflow_demo.cjs'
      + '   (run from the repository root; clear ELECTRON_RUN_AS_NODE first if it is set)',
    backend: {base, edition: status.edition, version: status.version},
    run: liveRun ? {id: liveRun.id, status: liveRun.status,
      stages: (liveRun.output.stages || []).map(s => ({node: s.node, operation: s.operation, model: s.model,
        elapsed_seconds: s.elapsed_seconds, timeout_seconds: s.timeout_seconds,
        input_sha256: s.input_sha256, output_sha256: s.output_sha256})),
      draft: liveRun.output.draft || null} : null,
    canvas: {viewVisible: canvas.viewVisible, nodeCount: canvas.nodeCount, nodeLabels: canvas.nodeLabels,
      railItems: canvas.railItems, runCards: canvas.runCards, runSectionScrolled: scrolled},
    expandedRunCard: expanded,
    assertions: checks,
    screenshots: fs.readdirSync(out).filter(n => n.endsWith('.png')).sort(),
    page_errors: pageErrors,
    passed: errors.length === 0,
  };
  fs.writeFileSync(path.join(out, 'ui-report.json'), JSON.stringify(report, null, 2), 'utf-8');
  console.log(JSON.stringify({passed: report.passed, assertions: checks.length, failed: errors,
    screenshots: report.screenshots}, null, 2));
  win.destroy();
  if (errors.length) throw new Error('failed assertions: ' + errors.join(', '));
}

main().then(() => app.quit())
  .catch(error => { console.error(error.stack); app.exit(1); });
