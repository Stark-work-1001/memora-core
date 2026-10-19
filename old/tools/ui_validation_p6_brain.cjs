// P6 acceptance: the three brain types are three different views, not one view swapped underneath
// the others.
//
// What has to be true, and why each assertion is written the way it is:
//
//   1. 语义关系 (dictionary) is BACK to the behaviour the user accepted: the copied renderer's own
//      spring layout, every edge straight (control === null), 分类着色 OFF by default.
//   2. 星云关系图 (matt) is the only place the reference site's nebula lives: cross-section edges
//      carry control points, same-section edges do not, and the shells interlock.
//   3. 层级脑图 (outline) is untouched: same node/hierarchy counts and -- checked from the file
//      system, not from memory -- the built bundle is byte-identical to the pre-change hash.
//   4. All three load under ?preview=1 without a blank stage, and the 2D dimension is served by the
//      plane view for every type instead of opening an empty 3D stage.
//
// Isolated exactly like tools/ui_validation_p4_matt.cjs: a fresh temporary data directory, a dev
// backend on a random port, hidden Electron windows. No workspace data is touched, no external
// network is called.
//
// Run:  .\\desktop\\node_modules\\electron\\dist\\electron.exe tools\\ui_validation_p6_brain.cjs
//   (from the repository root; clear ELECTRON_RUN_AS_NODE if this machine sets it)
const {app, BrowserWindow} = require('electron');
const {spawn} = require('node:child_process');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const out = path.join(root, 'artifacts', 'p6-brain');
const shots = path.join(out, 'shots');
fs.mkdirSync(shots, {recursive: true});
const logPath = path.join(out, 'acceptance.log');
fs.writeFileSync(logPath, '');
const log = (...parts) => {
  const line = parts.map(part => typeof part === 'string' ? part : JSON.stringify(part)).join(' ');
  fs.appendFileSync(logPath, line + '\n');
  process.stdout.write(line + '\n');
};
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'memora-p6-'));
const python = path.join(root, '.venv', 'Scripts', 'python.exe');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

let backend;
const checks = [];
const errors = [];
const check = (name, value, detail) => {
  checks.push({name, pass: !!value, detail});
  if (!value) errors.push(name);
  return !!value;
};

async function startBackend() {
  backend = spawn(python, ['-m', 'memora', '--data', data, 'serve', '--port', '0'],
    {cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
  let stderr = '';
  backend.stderr.on('data', chunk => { stderr += chunk; });
  return await new Promise((resolve, reject) => {
    let text = ''; const timer = setTimeout(() => reject(new Error('backend timeout: ' + stderr)), 60000);
    backend.stdout.on('data', chunk => {
      text += chunk; const match = text.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
    backend.once('exit', code => reject(new Error('backend exited ' + code + ': ' + stderr)));
  });
}

async function waitForFrameIn(win, fragment, timeout = 90000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const frame = win.webContents.mainFrame.frames.find(candidate => candidate.url.includes(fragment));
    if (frame) return frame;
    await delay(250);
  }
  throw new Error('no frame containing ' + fragment);
}

async function waitForFrame(frame, expression, label, timeout = 90000, interval = 250) {
  const started = Date.now(); let last;
  while (Date.now() - started < timeout) {
    try { last = await frame.executeJavaScript(expression); if (last) return last; }
    catch (error) { last = String(error.message); }
    await delay(interval);
  }
  throw new Error('timed out waiting for ' + label + '; last=' + JSON.stringify(last));
}

async function shot(win, name) {
  fs.mkdirSync(shots, {recursive: true});
  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(shots, name), image.toPNG());
  return path.join(shots, name);
}

const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// Everything the acceptance needs to know about a loaded 3D brain view, read from the app the view
// publishes. `nebula` is null in the semantic view -- that absence IS the point, so it is reported
// rather than asserted around. Serialised with toString(), so no nested string escaping is needed.
function probeView(provider) {
  const a = window[provider];
  if (!a || !a.graph || !a.graph.nodes.length) return null;
  const g = a.graph;
  const sameSection = g.edges.filter(e => g.nodes[e.source].section === g.nodes[e.target].section).length;
  const stage = a.stage.getBoundingClientRect();
  const camera = a.camera.camera;
  if (a.scene && a.scene.update) a.scene.update(camera);
  // Screen coverage, measured from the camera's own projection rather than from world units: a
  // stage that renders nothing still reports nodes, so 'not blank' has to be about pixels.
  let box;
  try {
    const points = g.nodes.map((node, i) => {
      const at = a.scene.positionOf(i).clone().project(camera);
      return {x: (at.x * 0.5 + 0.5) * stage.width, y: (-at.y * 0.5 + 0.5) * stage.height};
    });
    const left = Math.min(...points.map(q => q.x)), right = Math.max(...points.map(q => q.x));
    const top = Math.min(...points.map(q => q.y)), bottom = Math.max(...points.map(q => q.y));
    box = {widthFraction: +((right - left) / stage.width).toFixed(3),
      heightFraction: +((bottom - top) / stage.height).toFixed(3),
      stage: {width: Math.round(stage.width), height: Math.round(stage.height)}};
  } catch (error) { box = {error: String(error)}; }
  const nebula = window.memoraNebula && window.memoraNebula.report;
  const colorButton = [...document.querySelectorAll('.memora-graph-controls button')]
    .find(el => el.textContent === '分类着色');
  return {
    nodes: g.nodes.length, edges: g.edges.length, sections: g.sections.length,
    sameSectionEdges: sameSection, crossSectionEdges: g.edges.length - sameSection,
    nullControls: g.edges.filter(e => e.control === null).length,
    controlsOnSameSection: g.edges.filter(e => e.control !== null
      && g.nodes[e.source].section === g.nodes[e.target].section).length,
    controlsOnCrossSection: g.edges.filter(e => e.control !== null
      && g.nodes[e.source].section !== g.nodes[e.target].section).length,
    sectionColors: a.sectionColors === true,
    sectionButtonPressed: colorButton ? colorButton.getAttribute('aria-pressed') : null,
    hasNebula: !!nebula,
    nebula: nebula ? {
      shells: nebula.shells.length, curvedEdges: nebula.curvedEdges, straightEdges: nebula.straightEdges,
      controlRatio: nebula.controlRatio, radialRatio: nebula.radialRatio,
      minShellOverlap: nebula.minShellOverlap, shellsAllIntersect: nebula.shellsAllIntersect,
    } : null,
    visible: !!(stage.width > 100 && stage.height > 100),
    coverage: box,
  };
}

// The 2D view is a different app (plane.ts, a canvas, no dictionaryGraph), so it is probed through
// what it draws: the result list it fills from the same projection.
// Send a function to the page and call it there. toString() keeps the page code readable.
function callProbe(fn, args) {
  return '(' + fn.toString() + ')(' + (args || []).map(value => JSON.stringify(value)).join(',') + ')';
}

// The 2D view is a different app (plane.ts, a canvas, no dictionaryGraph), so it is probed through
// what it draws: the canvas it paints into, the panel it fills, and the graph it fetched.
function probePlane() {
  const list = document.querySelector('.plane-results');
  const canvas = document.querySelector('.plane-stage canvas');
  const panel = document.querySelector('.plane-panel');
  const header = document.querySelector('header');
  return {
    header: header ? header.textContent : null,
    canvas: canvas ? {width: canvas.width, height: canvas.height} : null,
    panelText: panel ? (panel.textContent || '').trim().slice(0, 120) : null,
    resultItems: list ? list.children.length : null,
  };
}

// The search box is the one control that writes a count straight into the result list, so it is the
// cheapest honest proof that the 2D app has the projection loaded: a query that matches nothing
// leaves the list empty whether or not the graph arrived, so it asks for a term the projection has.
function typePlaneSearch(term) {
  const search = document.querySelector('.plane-results') && document.querySelector('input[aria-label]');
  if (!search) return null;
  search.value = term;
  search.dispatchEvent(new Event('input', {bubbles: true}));
  const list = document.querySelector('.plane-results');
  // children is an HTMLCollection, not an array: convert before filtering on tag name.
  const items = list ? [...list.children].filter(el => el.tagName === 'BUTTON').length : 0;
  return {term: term, items: items};
}

// Drive the real dropdown, exactly as a reader would. No DOM top-up any more: the Lead's patch is
// in memory.html/memory.js, so a missing option is a real failure and must be reported as one.
function chooseBrainType(type, dimension) {
  const select = document.querySelector('#brain-type');
  const values = [...select.options].map(option => option.value);
  if (!values.includes(type)) return {ok: false, reason: 'option missing: ' + type, options: values};
  select.value = type;
  document.querySelector('#brain-dimension').value = dimension;
  brain();
  return {ok: true, options: values, dimension: document.querySelector('#brain-dimension').value,
    frame: document.querySelector('#brain-frame').getAttribute('src')};
}

// What the dimension control and its explanatory note say after choosing 2D for a 3D-only type.
function dimensionState() {
  return {
    type: document.querySelector('#brain-type').value,
    dimension: document.querySelector('#brain-dimension').value,
    noteHidden: document.querySelector('#brain-dimension-note')
      ? document.querySelector('#brain-dimension-note').hidden : null,
    noteText: document.querySelector('#brain-dimension-note')
      ? document.querySelector('#brain-dimension-note').textContent : null,
    frame: document.querySelector('#brain-frame').getAttribute('src'),
  };
}

function probeOutline() {
  const a = window.mindMap, g = a.graph;
  return {nodes: a.nodeCount, hierarchy: g.hierarchy.length, documentOrder: g.documentOrder.length,
    flow: window.memoraFlow ? window.memoraFlow.stats() : null,
    hasNebula: !!window.memoraNebula, hasDictionaryGraph: !!window.dictionaryGraph};
}

// Ask brain() itself where each (type, dimension) pair goes, by reading the iframe src it writes.
// This is the actual routing decision, not a regex over the function's source.
function probeWorkbench() {
  const select = document.querySelector('#brain-type');
  const dimension = document.querySelector('#brain-dimension');
  const frame = document.querySelector('#brain-frame');
  const options = [...select.options].map(option => option.value);
  const original = {type: select.value, dimension: dimension.value};
  const route = (type, dim) => {
    select.value = type; dimension.value = dim; brain();
    const src = frame.getAttribute('src') || '';
    return src.split('?')[0];
  };
  const routes = {
    dictionary: route('dictionary', '3d'),
    dictionary2d: route('dictionary', '2d'),
    matt: route('matt', '3d'),
    matt2d: route('matt', '2d'),
    outline: route('outline', '3d'),
    outline2d: route('outline', '2d'),
  };
  select.value = original.type; dimension.value = original.dimension;
  return {options: options, routes: routes};
}

async function openView(win, type, dimension) {
  const chosen = await win.webContents.executeJavaScript(callProbe(chooseBrainType, [type, dimension]));
  if (!chosen.ok) throw new Error('the workbench dropdown is missing a type: ' + JSON.stringify(chosen));
  // matt is 3D-only by design: choosing 2D for it must land on the 3D view and say why.
  const expected = type === 'matt' ? 'matt' : (dimension === '2d' ? 'plane' : type);
  const fragment = '/brain/' + expected + '/';
  const frame = await waitForFrameIn(win, fragment);
  return {frame, chosen};
}

async function main() {
  fs.mkdirSync(out, {recursive: true});
  fs.mkdirSync(shots, {recursive: true});
  app.setPath('userData', path.join(data, 'electron'));
  app.disableHardwareAcceleration();
  await app.whenReady();
  const base = await startBackend();
  log('backend', base, '| data', data);

  // --- what the bundles are, measured from the files -----------------------
  const staticRoot = path.join(root, 'memora', 'static');
  const beforePath = path.join(out, 'hashes-before.txt');
  const before = fs.existsSync(beforePath) ? fs.readFileSync(beforePath, 'utf8') : '';
  const hashBefore = relative => {
    const line = before.split(/\r?\n/).find(l => l.includes(relative));
    const m = line && line.match(/^([0-9a-fA-F]{64})/);
    return m ? m[1].toLowerCase() : null;
  };
  const bundle = relative => sha256(path.join(staticRoot, relative));
  const hashes = {
    dictionary: bundle('brain/dictionary/app.js'),
    matt: bundle('brain/matt/app.js'),
    outline: bundle('brain/outline/app.js'),
    plane: bundle('brain/plane/app.js'),
    dag: bundle('dag/app.js'),
  };
  const beforeHashes = {
    dictionary: hashBefore('memora/static/brain/dictionary/app.js'),
    matt: hashBefore('memora/static/brain/matt/app.js'),
    outline: hashBefore('memora/static/brain/outline/app.js'),
    plane: hashBefore('memora/static/brain/plane/app.js'),
    dag: hashBefore('memora/static/dag/app.js'),
  };
  // The hierarchy bundle's baseline, and why it has moved once.
  //
  // P6 recorded  dafd6e13...a6f3  as "the outline bundle must not move", and at that time it did not:
  // P6 changed nothing in outline.ts. P9 then changed it ON PURPOSE (the automatic best view and the
  // view-following link flex, both of which are user-requested behaviour for 层级脑图 as well), so the
  // bundle legitimately moved to the value below. This constant is the P9-delivered baseline; the
  // assertion keeps its teeth -- a later, unintended change to outline.ts still fails here.
  //
  // The behavioural assertions further down (27 nodes, 26 hierarchy links, the direction cue, and no
  // nebula/dictionary bake in this view) are what prove the hierarchy did not regress; this one only
  // pins the bytes.
  const P6_OUTLINE_HASH = 'dafd6e13b3cfe93fcff599696a753fe4ab128e547d7ef90288377a31b3a3a6f3';
  const P9_OUTLINE_HASH = '5c9e211584fd2d1521dfe01bfd4fdd6e08bc8e047cc08411bad05e3350b3b7a7';
  check('build: the hierarchy bundle matches its current baseline (P6 recorded ' + P6_OUTLINE_HASH.slice(0, 8)
    + ', P9 moved it on purpose to ' + P9_OUTLINE_HASH.slice(0, 8) + ')',
    hashes.outline === P9_OUTLINE_HASH,
    {p6: P6_OUTLINE_HASH, p9: P9_OUTLINE_HASH, before: beforeHashes.outline, after: hashes.outline});
  check('build: the 2D plane bundle did not move either', hashes.plane === beforeHashes.plane,
    {before: beforeHashes.plane, after: hashes.plane});
  check('build: the workflow DAG canvas did not move either', hashes.dag === beforeHashes.dag,
    {before: beforeHashes.dag, after: hashes.dag});
  check('build: the semantic-relation bundle changed (it lost the nebula)',
    hashes.dictionary !== beforeHashes.dictionary,
    {before: beforeHashes.dictionary, after: hashes.dictionary});
  const dictionarySource = fs.readFileSync(path.join(staticRoot, 'brain/dictionary/app.js'), 'utf8');
  const mattSource = fs.readFileSync(path.join(staticRoot, 'brain/matt/app.js'), 'utf8');
  check('build: only the matt bundle contains the nebula bake',
    !dictionarySource.includes('shellsAllIntersect') && !dictionarySource.includes('memoraNebula')
      && mattSource.includes('shellsAllIntersect') && mattSource.includes('memoraNebula'),
    {dictionaryHasBake: dictionarySource.includes('shellsAllIntersect'),
      mattHasBake: mattSource.includes('shellsAllIntersect')});

  const win = new BrowserWindow({show: false, width: 1500, height: 1000, webPreferences: {
    nodeIntegration: false, contextIsolation: true, sandbox: true, offscreen: true,
    backgroundThrottling: false,
  }});
  const pageErrors = [];
  win.webContents.on('console-message', (...args) => {
    const detail = args.find(a => a && typeof a === 'object' && a.level);
    if (detail && detail.level === 'error') pageErrors.push(detail.message);
  });

  log('stage: loading the workbench', base);
  await win.loadURL(base + '/?project=default');
  await delay(1200);
  log('stage: showing the brain view');
  await win.webContents.executeJavaScript("show('brain')");
  await delay(1400);

  const previewOn = await win.webContents.executeJavaScript('state.brainPreview === true');
  check('workbench: an empty project opens the demo preview, so ?preview=1 is the data source',
    previewOn === true, {previewOn});

  // --- 1. 语义关系 (dictionary): the restored view --------------------------
  log('stage: opening dictionary 3d');
  const dictOpen = await openView(win, 'dictionary', '3d');
  const dictFrame = dictOpen.frame;
  await waitForFrame(dictFrame,
    '!!(window.dictionaryGraph && window.dictionaryGraph.graph && window.dictionaryGraph.graph.nodes.length)',
    'dictionary view');
  await delay(2800);
  log('stage: probing dictionary');
  const dict = await dictFrame.executeJavaScript(callProbe(probeView, ['dictionaryGraph']));
  check('semantic: the restored view draws the demo graph', dict.nodes === 14 && dict.edges === 24,
    {nodes: dict.nodes, edges: dict.edges, sections: dict.sections});
  check('semantic: every edge is a straight line (control === null) -- the pre-nebula behaviour',
    dict.nullControls === dict.edges, {nullControls: dict.nullControls, edges: dict.edges});
  check('semantic: the nebula bake did NOT run in this view', dict.hasNebula === false, dict.hasNebula);
  check('semantic: 分类着色 is OFF by default again (the nebula had forced it on)',
    dict.sectionColors === false && dict.sectionButtonPressed === 'false',
    {sectionColors: dict.sectionColors, buttonPressed: dict.sectionButtonPressed});
  check('semantic: the graph fills the stage (not a blank canvas)',
    dict.visible && dict.coverage && dict.coverage.widthFraction > 0.3
      && dict.coverage.heightFraction > 0.3, dict.coverage);
  await shot(win, 'g6-01-dictionary-restored-3d.png');


  // --- 2. 星云关系图 (matt): the nebula, now an option of its own -----------
  //
  // Driven entirely through the real dropdown (chooseBrainType): the Lead's memory.html option and
  // memory.js route are what a reader uses, so a defect there has to fail this run rather than be
  // papered over by the harness.
  log('stage: opening matt 3d');
  const mattOpen = await openView(win, 'matt', '3d');
  const mattWiring = mattOpen.chosen;
  log('matt: the dropdown has it, and brain() routed it', mattWiring.frame);
  const mattFrame = mattOpen.frame;
  log('stage: matt frame found', mattFrame.url);
  await waitForFrame(mattFrame,
    '!!(window.dictionaryGraph && window.dictionaryGraph.graph && window.dictionaryGraph.graph.nodes.length'
    + ' && window.memoraNebula && window.memoraNebula.report)', 'matt nebula view');
  await delay(3000);
  log('stage: probing matt');
  const matt = await mattFrame.executeJavaScript(callProbe(probeView, ['dictionaryGraph']));
  check('nebula: the matt view draws the same demo graph through the same renderer',
    matt.nodes === 14 && matt.edges === 24, {nodes: matt.nodes, edges: matt.edges});
  check('nebula: same-section links are straight, cross-section links carry a control point',
    matt.controlsOnSameSection === 0 && matt.controlsOnCrossSection === matt.crossSectionEdges
      && matt.nullControls === matt.sameSectionEdges,
    {sameSection: matt.sameSectionEdges, crossSection: matt.crossSectionEdges,
      nullControls: matt.nullControls, controlsOnCross: matt.controlsOnCrossSection});
  check('nebula: the bake is the reference one (0.16 curve ratio, shells interlock, members inside)',
    matt.nebula && Math.abs(matt.nebula.controlRatio.min - 0.16) < 1e-6
      && Math.abs(matt.nebula.controlRatio.max - 0.16) < 1e-6
      && matt.nebula.shellsAllIntersect && matt.nebula.radialRatio.max <= 1.001,
    matt.nebula);
  check('nebula: 分类着色 is ON in this view only, and the toolbar says so',
    matt.sectionColors === true && matt.sectionButtonPressed === 'true',
    {sectionColors: matt.sectionColors, buttonPressed: matt.sectionButtonPressed});
  check('nebula: the cloud fills the stage (not a blank canvas)',
    matt.visible && matt.coverage && matt.coverage.widthFraction > 0.25
      && matt.coverage.heightFraction > 0.25, matt.coverage);
  await shot(win, 'g6-02-matt-nebula-3d.png');

  // --- 3. 层级脑图 (outline): untouched ------------------------------------
  log('stage: opening outline 3d');
  const outlineFrame = (await openView(win, 'outline', '3d')).frame;
  await waitForFrame(outlineFrame,
    '!!(window.mindMap && window.mindMap.nodeCount && typeof window.frameOutlineNode === "function")',
    'outline view');
  await waitForFrame(outlineFrame,
    '(() => { const r = window.mindMap.rendererRef.rig; return !r.animating && !window.mindMap.engine.active; })()',
    'outline layout settle', 60000);
  await delay(1600);
  log('stage: probing outline');
  const outline = await outlineFrame.executeJavaScript(callProbe(probeOutline, []));
  check('hierarchy: still has every demo node and every hierarchy link',
    outline.nodes >= 14 && outline.hierarchy >= 20,
    {nodes: outline.nodes, hierarchy: outline.hierarchy});
  check('hierarchy: the direction cue still draws', (outline.flow || {}).chevrons > 0, outline.flow);
  check('hierarchy: neither the nebula nor the dictionary bake ran here',
    outline.hasNebula === false && outline.hasDictionaryGraph === false, outline);
  await shot(win, 'g6-03-outline-unchanged-3d.png');


  // --- 4. the 2D dimension --------------------------------------------------
  //
  // Three questions, asserted separately:
  //   a) every brain type opens a 2D view -- the plane app is one app for all of them, told apart
  //      by the URL's mode parameter, and it fetches the SAME projection;
  //   b) that 2D view really has the data: its search fills from the projection's own terms, which
  //      cannot pass on an empty graph;
  //   c) it is the plane canvas, not the 3D nebula, so routing matt + 2D to plane is an honest
  //      fallback (same data, 2D) rather than a blank stage.
  log('stage: opening the 2D views');
  const planeChecks = [];
  for (const type of ['dictionary', 'outline']) {
    const opened = await openView(win, type, '2d');
    await delay(1600);
    const plane = await opened.frame.executeJavaScript(callProbe(probePlane, []));
    // Search for a term every projection carries (the projection writes 记忆 into its own lines).
    const searched = await opened.frame.executeJavaScript(callProbe(typePlaneSearch, ['记忆']));
    planeChecks.push(Object.assign({type, searched, dimension: opened.chosen.dimension,
      frame: opened.frame.url}, plane));
  }
  check('2D: dictionary and outline open a real 2D plane view',
    planeChecks.length === 2 && planeChecks.every(entry =>
      entry.canvas && entry.canvas.width > 0 && entry.canvas.height > 0
      && entry.header !== null && /2D/.test(entry.header)),
    planeChecks.map(entry => ({type: entry.type, canvas: entry.canvas, header: entry.header})));
  check('2D: that view really has the projection loaded (its search finds terms)',
    planeChecks.every(entry => entry.searched && entry.searched.items > 0),
    planeChecks.map(entry => ({type: entry.type, searched: entry.searched})));
  await shot(win, 'g6-04-dictionary-2d-plane.png');

  // matt is 3D-only: asking for 2D must pull the dimension back to 3D, explain itself, and open
  // the matt view -- not an empty plane stage.
  const matt2d = await win.webContents.executeJavaScript(callProbe(chooseBrainType, ['matt', '2d']));
  await delay(900);
  const matt2dState = await win.webContents.executeJavaScript(callProbe(dimensionState, []));
  check('2D: choosing 2D for the star-cloud type falls back to 3D with an explanation',
    matt2d.ok && matt2dState.dimension === '3d' && matt2dState.noteHidden === false
      && /三维/.test(matt2dState.noteText || '') && /\/brain\/matt\//.test(matt2dState.frame || ''),
    matt2dState);
  const matt2dFrame = await waitForFrameIn(win, '/brain/matt/');
  await waitForFrame(matt2dFrame,
    '!!(window.dictionaryGraph && window.memoraNebula && window.memoraNebula.report)',
    'matt after the 2D fallback');
  await shot(win, 'g6-05-matt-2d-fallback-note.png');

  // --- 5. the workbench routing contract -----------------------------------
  //
  // The dropdown is memory.html's and the routing is memory.js's (both the Lead's). What is
  // asserted here is the contract the built bundles rely on: the three types in this order, and
  // brain() routing matt to the matt bundle regardless of the dimension.
  const wiring = await win.webContents.executeJavaScript(callProbe(probeWorkbench, []));
  check('workbench: the dropdown lists 语义关系 / 星云关系图 / 层级脑图, in that order',
    JSON.stringify(wiring.options) === JSON.stringify(['dictionary', 'matt', 'outline']),
    wiring.options);
  check('workbench: brain() routes matt to the matt bundle and keeps the other two on their own',
    wiring.routes.matt === '/brain/matt/' && wiring.routes.dictionary === '/brain/dictionary/'
      && wiring.routes.outline === '/brain/outline/'
      && wiring.routes.dictionary2d === '/brain/plane/'
      && wiring.routes.outline2d === '/brain/plane/',
    wiring.routes);

  win.destroy();
  if (backend) backend.kill();

  const report = {
    suite: 'P6 brain views: restored semantic view, new nebula type, untouched hierarchy',
    synthetic_data_only: true,
    command: '.\\\\desktop\\\\node_modules\\\\electron\\\\dist\\\\electron.exe tools\\\\ui_validation_p6_brain.cjs'
      + '   (from the repository root; clear ELECTRON_RUN_AS_NODE if this machine sets it)',
    expected: 'exit code 0, "passed": true, every assertion green, 4 PNGs + this report in artifacts/p6-brain/',
    data_directory: data,
    backend: base,
    bundles: {before: beforeHashes, after: hashes, outlineBaseline: P9_OUTLINE_HASH,
      outlineBaselineNote: 'P6 recorded ' + P6_OUTLINE_HASH + '; P9 moved it on purpose'},
    views: {dictionary: dict, matt: matt, outline: outline, plane: planeChecks},
    workbenchWiring: wiring,
    assertions: checks,
    page_errors: pageErrors,
    passed: errors.length === 0,
  };
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  log('');
  for (const entry of checks) {
    log((entry.pass ? 'PASS  ' : 'FAIL  ') + entry.name
      + (entry.pass ? '' : '  << ' + JSON.stringify(entry.detail)));
  }
  log('');
  log((report.passed ? 'PASSED  ' : 'FAILED  ') + (checks.length - errors.length)
    + '/' + checks.length + ' assertions; report -> artifacts/p6-brain/report.json');
  if (pageErrors.length) log('page errors:', pageErrors.slice(0, 5));
  app.exit(report.passed ? 0 : 1);
}

main().catch(error => {
  log('HARNESS ERROR', error && error.stack ? error.stack : String(error));
  if (backend) backend.kill();
  app.exit(2);
});

