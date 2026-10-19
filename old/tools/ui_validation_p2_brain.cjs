// P2 brain-view acceptance: auto demo preview, multi-node/multi-edge in all three views,
// click-to-best-angle with a camera that actually moves.
//
// Isolated on purpose: a fresh temporary data directory, a dev backend on a random port
// (admin: only this temporary flag) and a hidden Electron window. No workspace data is
// touched, no user profile is written, no external network is called.
//
// Run:  .\desktop\node_modules\electron\dist\electron.exe tools\ui_validation_p2_brain.cjs
//   (from the repository root; artifacts/p2-brain/ is written next to this script)
const {app, BrowserWindow, nativeImage} = require('electron');
const {spawn} = require('node:child_process');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');

const root = path.resolve(__dirname, '..');
const out = path.join(root, 'artifacts', 'p2-brain');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'memora-p2-'));
const python = path.join(root, '.venv', 'Scripts', 'python.exe');
const delay = ms => new Promise(r => setTimeout(r, ms));

let backend;
const checks = [];
const errors = [];
const check = (name, value, detail) => { checks.push({name, pass: !!value, detail}); if (!value) errors.push(name); return !!value; };

async function startBackend() {
  backend = spawn(python, ['-m', 'memora', '--data', data, 'serve', '--port', '0'],
    {cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
  let stderr = '';
  backend.stderr.on('data', b => { stderr += b; });
  return await new Promise((resolve, reject) => {
    let text = ''; const timer = setTimeout(() => reject(new Error('backend timeout: ' + stderr)), 30000);
    backend.stdout.on('data', b => {
      text += b; const m = text.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (m) { clearTimeout(timer); resolve(m[0]); }
    });
    backend.once('exit', code => reject(new Error('backend exited ' + code + ': ' + stderr)));
  });
}

/** Wait until the embedded page in `frame` satisfies `expression`, returning its value. */
async function waitForFrame(frame, expression, label, timeout = 60000, interval = 250) {
  const started = Date.now(); let last;
  while (Date.now() - started < timeout) {
    try { last = await frame.executeJavaScript(expression); if (last) return last; }
    catch (error) { last = String(error.message); }
    await delay(interval);
  }
  throw new Error('timed out waiting for ' + label + '; last=' + JSON.stringify(last));
}

async function waitForFrameIn(win, fragment, timeout = 60000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const frame = win.webContents.mainFrame.frames.find(f => f.url.includes(fragment));
    if (frame) return frame;
    await delay(250);
  }
  throw new Error('no frame containing ' + fragment);
}

/** Real mouse click at a point given in the iframe's own viewport coordinates. */
async function clickFramePoint(win, frame, point) {
  const rect = await frame.executeJavaScript(
    '(() => { const r = document.querySelector(".sa-stage, .plane-stage").getBoundingClientRect();'
    + ' return {left: r.left, top: r.top}; })()');
  // The iframe sits inside the outer page; its viewport origin is offset by the element box.
  const outer = await win.webContents.executeJavaScript(
    '(() => { const f = document.getElementById("brain-frame"); const r = f.getBoundingClientRect();'
    + ' return {left: r.left, top: r.top}; })()');
  const x = Math.round(outer.left + rect.left + point.x);
  const y = Math.round(outer.top + rect.top + point.y);
  win.webContents.sendInputEvent({type: 'mouseDown', x, y, button: 'left', clickCount: 1});
  await delay(60);
  win.webContents.sendInputEvent({type: 'mouseUp', x, y, button: 'left', clickCount: 1});
  await delay(1600);
  return {x, y};
}

/**
 * Measure how far a connection stands out from the background, in luminance.
 *
 * "The links were invisible" is a claim about pixels, so the check is too: find a point on each
 * of a dozen edges, decode the captured frame, and take the darkest pixel within 3 px of that
 * point against the background luminance. A link drawn at the vendored 0.22 measured a mean
 * delta of 18 levels on this stage; the tuned value measures about twice that, which is the
 * difference between "there if you look for it" and "visible at a glance".
 */
async function edgeContrast(win, frame, inner) {
  const points = await frame.executeJavaScript(`(() => {
    const a = window.dictionaryGraph, cam = a.camera.camera, stage = a.stage.getBoundingClientRect();
    return {points: a.graph.edges.slice(0, 12).map(edge => {
      const pa = a.scene.positionOf(edge.source).clone().project(cam);
      const pb = a.scene.positionOf(edge.target).clone().project(cam);
      const ax = stage.left + (pa.x * 0.5 + 0.5) * stage.width, ay = stage.top + (-pa.y * 0.5 + 0.5) * stage.height;
      const bx = stage.left + (pb.x * 0.5 + 0.5) * stage.width, by = stage.top + (-pb.y * 0.5 + 0.5) * stage.height;
      return {x: Math.round(ax * 0.3 + bx * 0.7), y: Math.round(ay * 0.3 + by * 0.7)};
    }), stage: {height: Math.round(stage.height)}};
  })()`);
  const image = nativeImage.createFromBuffer((await win.webContents.capturePage()).toPNG());
  const bitmap = image.toBitmap();
  const size = image.getSize();
  const luminance = (x, y) => { const i = (y * size.width + x) * 4; return 0.114 * bitmap[i] + 0.587 * bitmap[i + 1] + 0.299 * bitmap[i + 2]; };
  const background = luminance(inner.left + 30, inner.top + points.stage.height - 60);
  const deltas = points.points.map(point => {
    let darkest = 255;
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      const x = point.x + inner.left + dx, y = point.y + inner.top + dy;
      if (x < 0 || y < 0 || x >= size.width || y >= size.height) continue;
      darkest = Math.min(darkest, luminance(x, y));
    }
    return Math.round(background - darkest);
  });
  return {background: Math.round(background), deltas, mean: Math.round(deltas.reduce((a, b) => a + b, 0) / Math.max(1, deltas.length)),
    minimum: Math.min(...deltas), visible: deltas.filter(d => d >= 8).length, sampled: deltas.length};
}

async function shot(win, name) {
  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(out, name), image.toPNG());
  return path.join(out, name);
}

async function main() {
  fs.mkdirSync(out, {recursive: true});
  app.setPath('userData', path.join(data, 'electron'));
  app.disableHardwareAcceleration();
  await app.whenReady();
  const base = await startBackend();
  console.log('backend', base, 'data', data);

  // The fixture is the demo graph, which the server only offers when the project is empty.
  const previewPayload = await (await fetch(base + '/api/agent/brain-preview?project=default')).json();
  check('project default has no approved memories (preview available)', previewPayload.available === true,
    {available: previewPayload.available, approved: previewPayload.approved});
  check('demo payload carries 14 nodes', (previewPayload.graph || {}).nodes?.length === 14)
  check('demo payload carries >= 20 edges', (previewPayload.graph || {}).edges?.length >= 20,
    {edges: (previewPayload.graph || {}).edges?.length});

  const win = new BrowserWindow({show: false, width: 1500, height: 1000, webPreferences: {
    nodeIntegration: false, contextIsolation: true, sandbox: true, offscreen: true, backgroundThrottling: false,
  }});
  const pageErrors = [];
  win.webContents.on('console-message', (...args) => {
    const detail = args.find(a => a && typeof a === 'object' && a.level);
    if (detail && detail.level === 'error') pageErrors.push(detail.message);
  });

  await win.loadURL(base + '/?project=default');
  await delay(900);

  // --- A. the brain view opens on the demo graph by itself ---------------------------------
  await win.webContents.executeJavaScript("show('brain')");
  const frame = await waitForFrameIn(win, '/brain/dictionary/');
  const shell = await win.webContents.executeJavaScript(
    "(() => ({preview: state.brainPreview, src: $('brain-frame').src,"
    + " noteHidden: $('brain-preview-note').hidden, note: $('brain-preview-note').textContent}))()");
  check('brain view auto-selects the demo preview (no click)', shell.preview === true, shell);
  check('iframe is loaded with preview=1', /preview=1/.test(shell.src), shell.src);
  check('demo banner is shown and says it is demo data',
    shell.noteHidden === false && /演示/.test(shell.note), shell.note.slice(0, 60));

  // --- B. 3D semantic-relation view ------------------------------------------------------
  const dictionary = await waitForFrame(frame,
    '!!(window.dictionaryGraph && window.dictionaryGraph.graph && window.dictionaryGraph.graph.nodes.length'
    + ' && typeof window.frameDictionary === "function")', 'dictionary view');
  await delay(2500);
  const dictBefore = await frame.executeJavaScript(`(() => {
    const a = window.dictionaryGraph, cam = a.camera;
    return {
      nodes: a.searchEntries.length, edges: a.graph.edges.length, title: a.graph.title,
      camera: {azimuth: +cam.azimuth.toFixed(4), polar: +cam.polar.toFixed(4), distance: +cam.distance.toFixed(2)},
      edgeOpacity: +a.scene.edges.material.opacity.toFixed(2),
      labels: [...document.querySelectorAll('.dg-label')].filter(e => e.style.display !== 'none'
        && getComputedStyle(e).visibility !== 'hidden').map(e => { const r = e.getBoundingClientRect();
        return {text: e.textContent, x: r.x, y: r.y, w: r.width, h: r.height}; }),
    };
  })()`);
  check('dictionary: >= 14 demo nodes', dictBefore.nodes >= 14, dictBefore.nodes);
  check('dictionary: >= 20 demo edges', dictBefore.edges >= 20, dictBefore.edges);
  check('dictionary: the preview title is shown', /演示/.test(dictBefore.title || ''), dictBefore.title);
  check('dictionary: resting links are visible (opacity >= 0.5)', dictBefore.edgeOpacity >= 0.5, dictBefore.edgeOpacity);
  const overlaps = (boxes) => {
    let count = 0;
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      if (Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 2
        && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 2) count++;
    }
    return count;
  };
  const dictOverlap = overlaps(dictBefore.labels);
  check('dictionary: no overlapping labels in the first frame', dictOverlap === 0,
    {overlaps: dictOverlap, labels: dictBefore.labels.length});
  // "The connections must be visible" is a pixel claim: measure contrast against the background.
  const dictionaryInner = await win.webContents.executeJavaScript(
    "(() => { const r = document.getElementById('brain-frame').getBoundingClientRect();"
    + " return {left: Math.round(r.left), top: Math.round(r.top)}; })()");
  const contrast = await edgeContrast(win, frame, dictionaryInner);
  check('dictionary: every sampled link is visible against the light background',
    contrast.visible === contrast.sampled && contrast.minimum >= 8, contrast);

  const enterShot = await shot(win, '01-enter-dictionary.png');

  // The copied label layer's own 显示标签 switch never stays off; the first-party declutter
  // honours it instead. Both directions are asserted, because a switch that only turns OFF
  // is as broken as one that only turns ON.
  const toggleLabels = async () => {
    // The button lives in the embedded view, not in the outer workbench page.
    await frame.executeJavaScript(
      "[...document.querySelectorAll('.sa-btn')].find(b => b.textContent.trim() === '显示标签').click(); true");
    await delay(700);
    return frame.executeJavaScript(`(() => {
      const shown = [...document.querySelectorAll('.dg-label')].filter(e => e.style.display !== 'none'
        && getComputedStyle(e).visibility !== 'hidden').length;
      return {shown, setting: window.dictionaryGraph.settings.labels};
    })()`);
  };
  const labelsOff = await toggleLabels();
  check('dictionary: 显示标签 switch really hides every label', labelsOff.setting === false && labelsOff.shown === 0, labelsOff);
  const labelsOn = await toggleLabels();
  check('dictionary: turning labels back on restores them', labelsOn.setting === true && labelsOn.shown > 0, labelsOn);

  // A real click on the third node, through the mouse, not through select().
  const third = await frame.executeJavaScript(`(() => {
    const a = window.dictionaryGraph; a.scene.update(a.camera.camera);
    const world = a.scene.positionOf(3).clone(); const cam = a.camera.camera;
    const stage = a.stage.getBoundingClientRect();
    const ndc = world.project(cam);
    return {x: (ndc.x * 0.5 + 0.5) * stage.width, y: (-ndc.y * 0.5 + 0.5) * stage.height,
      hit: a.scene.pick(cam, stage.left + (ndc.x * 0.5 + 0.5) * stage.width,
        stage.top + (-ndc.y * 0.5 + 0.5) * stage.height)};
  })()`);
  check('dictionary: node 3 is pickable under the cursor', third.hit === 3, third.hit);
  await clickFramePoint(win, frame, third);
  const dictAfter = await frame.executeJavaScript(`(() => {
    const a = window.dictionaryGraph, cam = a.camera, f = window.memoraFocus;
    return {camera: {azimuth: +cam.azimuth.toFixed(4), polar: +cam.polar.toFixed(4), distance: +cam.distance.toFixed(2)},
      selected: a.selected, focus: f ? {ids: f.ids, pose: f.pose, angles: f.angles} : null};
  })()`);
  const movedDictionary = dictAfter.focus !== null
    && (Math.abs(dictAfter.camera.azimuth - dictBefore.camera.azimuth) > 1e-3
      || Math.abs(dictAfter.camera.polar - dictBefore.camera.polar) > 1e-3
      || Math.abs(dictAfter.camera.distance - dictBefore.camera.distance) > 1e-3);
  check('dictionary: click selects a node', dictAfter.selected >= 0, dictAfter.selected);
  check('dictionary: click produces a memoraFocus pose', !!dictAfter.focus && !!dictAfter.focus.pose, dictAfter.focus && dictAfter.focus.ids);
  check('dictionary: the camera actually moved to the best angle', movedDictionary,
    {before: dictBefore.camera, after: dictAfter.camera});
  check('dictionary: the framed cluster has the node and its neighbours',
    !!dictAfter.focus && dictAfter.focus.ids.length >= 2, dictAfter.focus && dictAfter.focus.ids);
  const selectedShot = await shot(win, '02-selected-dictionary.png');

  // --- C. 3D hierarchy view ---------------------------------------------------------------
  await win.webContents.executeJavaScript("$('brain-type').value='outline'; brain()");
  const outlineFrame = await waitForFrameIn(win, '/brain/outline/');
  await waitForFrame(outlineFrame,
    '!!(window.mindMap && window.mindMap.nodeCount && typeof window.frameOutlineNode === "function")',
    'outline view');
  await waitForFrame(outlineFrame,
    '(() => { const r = window.mindMap.rendererRef.rig; return !r.animating && !window.mindMap.engine.active; })()',
    'outline layout settle', 45000);
  await delay(1200);
  const outlineBefore = await outlineFrame.executeJavaScript(`(() => {
    const a = window.mindMap, rig = a.rendererRef.rig, g = a.graph;
    const stage = document.querySelector('.sa-stage').getBoundingClientRect();
    return {nodes: a.nodeCount, hierarchy: g.hierarchy.length, documentOrder: g.documentOrder.length,
      flow: window.memoraFlow ? window.memoraFlow.stats() : null,
      camera: {distance: +rig.distance.toFixed(2), pivot: rig.pivot.toArray().map(v => +v.toFixed(2))},
      stage: {w: Math.round(stage.width), h: Math.round(stage.height)}};
  })()`);
  check('outline: >= 14 demo nodes', outlineBefore.nodes >= 14, outlineBefore.nodes);
  check('outline: >= 20 hierarchy edges', outlineBefore.hierarchy >= 20, outlineBefore.hierarchy);
  check('outline: the parent->child direction cue is drawing', (outlineBefore.flow || {}).chevrons > 0,
    outlineBefore.flow);
  const outlinePoint = await outlineFrame.executeJavaScript(`(() => {
    const a = window.mindMap, r = a.rendererRef;
    const stage = document.querySelector('.sa-stage').getBoundingClientRect();
    for (let i = 2; i < a.nodeCount; i++) {
      const s = a.engine.spheres([i])[0]; if (!s) continue;
      const p = r.project({x: s.x, y: s.y, z: s.z});
      if (!p) continue;
      const x = p.x, y = p.y;
      if (x > 40 && y > 40 && x < stage.width - 40 && y < stage.height - 40) return {index: i, x, y};
    }
    return null;
  })()`);
  check('outline: a node is on screen to click', !!outlinePoint, outlinePoint);
  if (outlinePoint) {
    await clickFramePoint(win, outlineFrame, outlinePoint);
    const outlineAfter = await outlineFrame.executeJavaScript(`(() => {
      const a = window.mindMap, rig = a.rendererRef.rig, f = window.memoraFocus;
      return {camera: {distance: +rig.distance.toFixed(2), pivot: rig.pivot.toArray().map(v => +v.toFixed(2))},
        focus: f ? {ids: f.ids, pose: f.pose, angles: f.angles} : null, selected: a.selectedId};
    })()`);
    const movedOutline = outlineAfter.focus !== null
      && (Math.abs(outlineAfter.camera.distance - outlineBefore.camera.distance) > 1e-3
        || outlineAfter.camera.pivot.some((v, i) => Math.abs(v - outlineBefore.camera.pivot[i]) > 1e-3));
    check('outline: click selects a node', !!outlineAfter.selected, outlineAfter.selected);
    check('outline: click produces a memoraFocus pose', !!outlineAfter.focus && !!outlineAfter.focus.pose,
      outlineAfter.focus && outlineAfter.focus.ids);
    check('outline: the camera actually moved to the best angle', movedOutline,
      {before: outlineBefore.camera, after: outlineAfter.camera});
    await shot(win, '04-selected-outline.png');
  }

  // --- D. 2D plane, both modes -------------------------------------------------------------
  await win.webContents.executeJavaScript("$('brain-dimension').value='2d'; brain()");
  const planeFrame = await waitForFrameIn(win, '/brain/plane/');
  await waitForFrame(planeFrame, '!!(window.memoraPlane && window.memoraPlane.nodes().length)', 'plane view');
  await delay(1400);
  const plane = await planeFrame.executeJavaScript(`(() => {
    const p = window.memoraPlane, t = p.transform(), nodes = p.nodes();
    const screenY = nodes.map(n => n.y * t.scale + t.oy);
    return {nodes: nodes.length, links: p.links().length,
      ySpreadPx: Math.round(Math.max(...screenY) - Math.min(...screenY)),
      xSpreadPx: Math.round((Math.max(...nodes.map(n => n.x)) - Math.min(...nodes.map(n => n.x))) * t.scale),
      transform: t, categories: [...new Set(nodes.map(n => n.category))]};
  })()`);
  check('plane 2D: nodes are drawn', plane.nodes > 0, plane.nodes);
  check('plane 2D: links are drawn', plane.links > 0, plane.links);
  check('plane 2D: the map is not flattened into one row (y spread > 100px)', plane.ySpreadPx > 100,
    {ySpreadPx: plane.ySpreadPx, xSpreadPx: plane.xSpreadPx});
  await shot(win, '03-plane-2d.png');

  // The hierarchy mode of the same 2D canvas is the one that used to collapse into a line.
  const planeOutlineFrame = await (async () => {
    await win.webContents.executeJavaScript("$('brain-type').value='outline'; brain()");
    const f = await waitForFrameIn(win, '/brain/plane/');
    await waitForFrame(f, '!!(window.memoraPlane && window.memoraPlane.nodes().length)', 'plane outline view');
    await delay(1400);
    return f;
  })();
  const planeOutline = await planeOutlineFrame.executeJavaScript(`(() => {
    const p = window.memoraPlane, t = p.transform(), nodes = p.nodes();
    const screenY = nodes.map(n => n.y * t.scale + t.oy);
    const rows = [...new Set(nodes.map(n => Math.round(n.y)))].length;
    return {nodes: nodes.length, links: p.links().length, rows,
      ySpreadPx: Math.round(Math.max(...screenY) - Math.min(...screenY))};
  })()`);
  check('plane 2D hierarchy: nodes are drawn', planeOutline.nodes > 0, planeOutline.nodes);
  check('plane 2D hierarchy: links are drawn', planeOutline.links > 0, planeOutline.links);
  check('plane 2D hierarchy: multiple rows, not one flat line', planeOutline.rows >= 3,
    {rows: planeOutline.rows, ySpreadPx: planeOutline.ySpreadPx});
  check('plane 2D hierarchy: y spread > 100px', planeOutline.ySpreadPx > 100, planeOutline.ySpreadPx);
  await shot(win, '05-plane-2d-hierarchy.png');

  const report = {
    suite: 'P2 brain view acceptance',
    synthetic_data_only: true,
    command: '.\\desktop\\node_modules\\electron\\dist\\electron.exe tools\\ui_validation_p2_brain.cjs'
      + '   (run from the repository root; on a machine where ELECTRON_RUN_AS_NODE is set, clear it first)',
    expected: 'exit code 0, "passed": true, 33 assertions all pass, 5 PNGs + this report written to artifacts/p2-brain/',
    data_directory: data,
    backend: base,
    assertions: checks,
    screenshots: fs.readdirSync(out).filter(f => f.endsWith('.png')).sort(),
    page_errors: pageErrors,
    passed: errors.length === 0,
  };
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log('screenshots:', [enterShot, selectedShot].join(' '));
  win.destroy();
  if (errors.length) throw new Error('failed assertions: ' + errors.join(', '));
}

main().then(() => { backend.kill(); app.quit(); })
  .catch(error => { console.error(error.stack); if (backend) backend.kill(); app.exit(1); });
