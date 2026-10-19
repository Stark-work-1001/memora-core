// P4 acceptance: the reference site's nebula -- overlapping section shells, curved cross-section
// links and straight same-section links -- drawn by the copied renderer, with the switch to the
// hierarchy view left exactly as it was.
//
// SUPERSEDED BY tools/ui_validation_p6_brain.cjs. This script still opens /brain/dictionary/,
// because at P4 the nebula WAS the semantic-relation view. That substitution was rejected by the
// user: the semantic view is back to its pre-nebula behaviour and the nebula now lives in the
// separate `matt` brain type. So this file no longer describes the shipped contract -- it is kept
// only as the record of how the bake's reference rules were measured. Run the P6 script instead.
//
// Isolated on purpose, same as tools/ui_validation_p2_brain.cjs: a fresh temporary data directory,
// a dev backend on a random port, a hidden Electron window. No workspace data is touched, no user
// profile is written, no external network is called.
//
// Run:  .\desktop\node_modules\electron\dist\electron.exe tools\ui_validation_p4_matt.cjs
//   (from the repository root; clear ELECTRON_RUN_AS_NODE first if this machine sets it)
// THIS SCRIPT IS A HISTORICAL RECORD, NOT A CURRENT ACCEPTANCE CHECK.
//
// It asserts the P4 contract, which the user REJECTED: that the nebula (baked section shells and
// curved cross-section links) is what /brain/dictionary/ draws. Since P6 that path is the restored
// semantic-relation view with straight links, and the nebula lives at /brain/matt/. Running this
// script today would therefore "fail" against correct behaviour -- and, worse, anyone reading a
// green run of it would be reading the wrong contract.
//
// What it is still good for: the measurement of the reference site's rules (0.16 cross-section
// curve ratio, shell overlap, the 14-term scale comparison), which artifacts/p4-matt/ cites. Keep it
// for that; use tools/ui_validation_p6_brain.cjs and tools/ui_validation_p9_bestview.cjs for
// acceptance.
//
// It refuses to run by default so it cannot be mistaken for a passing check. Set
// MEMORA_ALLOW_SUPERSEDED_P4=1 to run the measurements anyway.
if (!process.env.MEMORA_ALLOW_SUPERSEDED_P4) {
  console.error('ui_validation_p4_matt.cjs is SUPERSEDED: it asserts the nebula in /brain/dictionary/, '
    + 'which was replaced in P6. Use tools/ui_validation_p6_brain.cjs and '
    + 'tools/ui_validation_p9_bestview.cjs. Set MEMORA_ALLOW_SUPERSEDED_P4=1 to run the historical '
    + 'measurements anyway.');
  process.exit(3);
}
const {app, BrowserWindow} = require('electron');
const {spawn, spawnSync} = require('node:child_process');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const out = path.join(root, 'artifacts', 'p4-matt');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'memora-p4-'));
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
    let text = ''; const timer = setTimeout(() => reject(new Error('backend timeout: ' + stderr)), 60000);
    backend.stdout.on('data', b => {
      text += b; const m = text.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (m) { clearTimeout(timer); resolve(m[0]); }
    });
    backend.once('exit', code => reject(new Error('backend exited ' + code + ': ' + stderr)));
  });
}

/** Start a second backend on an already-prepared data directory (used for the real project). */
let backendReal;
async function startBackendOn(dataDirectory) {
  if (!fs.existsSync(dataDirectory)) throw new Error('real-project data dir missing: ' + dataDirectory);
  backendReal = spawn(python, ['-m', 'memora', '--data', dataDirectory, 'serve', '--port', '0'],
    {cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
  let stderr = '';
  backendReal.stderr.on('data', b => { stderr += b; });
  return await new Promise((resolve, reject) => {
    let text = ''; const timer = setTimeout(() => reject(new Error('real backend timeout: ' + stderr)), 60000);
    backendReal.stdout.on('data', b => {
      text += b; const m = text.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (m) { clearTimeout(timer); resolve(m[0]); }
    });
    backendReal.once('exit', code => reject(new Error('real backend exited ' + code + ': ' + stderr)));
  });
}

/**
 * Seed a temporary project with approved memories, through the store's own API.
 *
 * Deliberately a fresh mkdtemp directory: the workspace's data/ is the user's, and this must never
 * write to it. The memories go through capture(confirmed=True) and link(), i.e. the same path a
 * real user's approved memory takes, so what the view renders is a genuine projection.
 */
function makeRealData() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memora-p4-realshot-'));
  const script = path.join(out, 'make-real-data.py');
  const result = spawnSync(python, ['-c',
    'import sys; sys.path.insert(0, ' + JSON.stringify(root) + ');'
    + 'from memora.store import Store;'
    + 'import runpy;'
    + 'ns = runpy.run_path(' + JSON.stringify(script) + ');'
    + 'ns["seed"](Store(' + JSON.stringify(directory) + '), "realp4", 60);'
    + 'print("seeded")'], {cwd: root, encoding: 'utf8'});
  if (result.status !== 0) throw new Error('seeding the real project failed: ' + result.stderr);
  return directory;
}

async function waitForFrameIn(win, fragment, timeout = 90000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const frame = win.webContents.mainFrame.frames.find(f => f.url.includes(fragment));
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
  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(out, name), image.toPNG());
  return path.join(out, name);
}

const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** How many links are visibly curved, measured from the geometry the renderer actually built. */
const CURVED_EDGE_PROBE = `(() => {
  const a = window.dictionaryGraph, g = a.graph, scene = a.scene;
  const report = window.memoraNebula && window.memoraNebula.report;
  const sameSection = g.edges.filter(e => g.nodes[e.source].section === g.nodes[e.target].section).length;
  const cross = g.edges.length - sameSection;
  const straight = g.edges.filter(e => e.control === null).length;
  // Independent of the graph objects: read the line geometry the scene published and measure how
  // far each edge's mid-sample sits from the chord. A straight edge's middle sample is on the
  // chord; a curved one is off it by half the control offset.
  const positions = scene.edges.geometry.getAttribute('position');
  const segments = positions.count / 2;
  const perEdge = Math.max(1, Math.round(segments / Math.max(1, g.edges.length)));
  let bowed = 0, maxBow = 0, sameBowed = 0;
  g.edges.forEach((edge, index) => {
    const base = index * perEdge * 2;
    if (base + 3 >= positions.count) return;
    const ax = positions.getX(base), ay = positions.getY(base), az = positions.getZ(base);
    const midIndex = base + perEdge; // the vertex where the curve's middle sample lands
    const mx = positions.getX(midIndex), my = positions.getY(midIndex), mz = positions.getZ(midIndex);
    const bIndex = Math.min(positions.count - 1, base + perEdge * 2 - 1);
    const bx = positions.getX(bIndex), by = positions.getY(bIndex), bz = positions.getZ(bIndex);
    const cx = (ax + bx) / 2, cy = (ay + by) / 2, cz = (az + bz) / 2;
    const span = Math.hypot(bx - ax, by - ay, bz - az);
    if (span < 1e-6) return;
    const bow = Math.hypot(mx - cx, my - cy, mz - cz) / span;
    maxBow = Math.max(maxBow, bow);
    if (bow > 0.02) { bowed++; if (edge.control === null) sameBowed++; }
  });
  const shells = report ? report.shells : [];
  let minOverlapFraction = 1, maxOverlapFraction = -1;
  for (let i = 0; i < shells.length; i++) for (let j = i + 1; j < shells.length; j++) {
    const A = shells[i], B = shells[j];
    const reach = A.radius + B.radius;
    const d = Math.hypot(A.centroid[0]-B.centroid[0], A.centroid[1]-B.centroid[1], A.centroid[2]-B.centroid[2]);
    const fraction = (reach - d) / reach;
    minOverlapFraction = Math.min(minOverlapFraction, fraction);
    maxOverlapFraction = Math.max(maxOverlapFraction, fraction);
  }
  // How much of the free stage the cloud actually covers, in screen pixels: project every node and
  // measure the bounding box of what is drawn against the stage. "Fills the canvas" is a measure
  // of pixels, not of world units, so it is read off the camera's own projection.
  const stageRect = a.stage.getBoundingClientRect();
  const camera = a.camera.camera;
  a.scene.update(camera);
  const points = g.nodes.map((node, i) => {
    const at = a.scene.positionOf(i).clone().project(camera);
    return {x: (at.x * 0.5 + 0.5) * stageRect.width, y: (-at.y * 0.5 + 0.5) * stageRect.height};
  });
  const left = Math.min(...points.map(p => p.x)), right = Math.max(...points.map(p => p.x));
  const top = Math.min(...points.map(p => p.y)), bottom = Math.max(...points.map(p => p.y));
  const fill = {
    stage: {width: Math.round(stageRect.width), height: Math.round(stageRect.height)},
    box: {left: Math.round(left), top: Math.round(top), right: Math.round(right), bottom: Math.round(bottom)},
    widthFraction: +((right - left) / stageRect.width).toFixed(3),
    heightFraction: +((bottom - top) / stageRect.height).toFixed(3),
    areaFraction: +(((right - left) * (bottom - top)) / (stageRect.width * stageRect.height)).toFixed(3),
    camera: {azimuth: +a.camera.azimuth.toFixed(4), polar: +a.camera.polar.toFixed(4),
      distance: +a.camera.distance.toFixed(1)},
  };
  return {
    nodes: g.nodes.length, edges: g.edges.length,
    sections: g.sections.length, sameSectionEdges: sameSection, crossSectionEdges: cross,
    straightControls: straight, nullControlSameSection: g.edges.filter(e =>
      e.control === null && g.nodes[e.source].section === g.nodes[e.target].section).length,
    nonNullControlCrossSection: g.edges.filter(e =>
      e.control !== null && g.nodes[e.source].section !== g.nodes[e.target].section).length,
    curvedInGeometry: bowed, sameSectionCurvedInGeometry: sameBowed, maxBowRatio: +maxBow.toFixed(4),
    // Read through the seam Memora installs: the copied scene keeps its own copy private, so the
    // flag has to come from the app's public surface, not from scene internals.
    sectionColours: a.sectionColors === true,
    shells: shells.map(s => ({title: s.title, members: s.members, radius: s.radius,
      centroid: s.centroid.map(v => v), radial: s.radial, nearestNeighbour: s.nearestNeighbour,
      centreDistance: s.centreDistance})),
    minOverlapFraction: +minOverlapFraction.toFixed(4),
    maxOverlapFraction: +maxOverlapFraction.toFixed(4),
    fill,
    geometry: report ? report.geometry : null,
    shellsAllIntersect: report ? report.shellsAllIntersect : false,
    controlRatio: report ? report.controlRatio : null,
    curveRatio: report ? report.curveRatio : null,
    radialRatio: report ? report.radialRatio : null,
    minNodeDistance: report ? +report.minNodeDistance.toFixed(2) : null,
    seed: report ? report.seed.slice(0, 120) : null,
  };
})()`;

async function main() {
  fs.mkdirSync(out, {recursive: true});
  app.setPath('userData', path.join(data, 'electron'));
  app.disableHardwareAcceleration();
  await app.whenReady();
  const base = await startBackend();
  console.log('backend', base, 'data', data);

  // The dictionary bundle is the one this task rebuilds; the outline bundle is the hierarchy view
  // and must be byte-identical to what it was before the change (recorded by the build step).
  const staticRoot = path.join(root, 'memora', 'static');
  const dictionaryHash = sha256(path.join(staticRoot, 'brain', 'dictionary', 'app.js'));
  const outlineHash = sha256(path.join(staticRoot, 'brain', 'outline', 'app.js'));
  const beforePath = path.join(out, 'hashes-before.txt');
  const before = fs.existsSync(beforePath) ? fs.readFileSync(beforePath, 'utf8') : '';
  // hashes-before.txt came out of Get-FileHash, which writes upper case; compare case-insensitively.
  const outlineBefore = ((before.match(/([0-9a-fA-F]{64})\s+\d+\s+memora\/static\/brain\/outline\/app\.js/) || [])[1] || '').toLowerCase();
  check('build: the outline (hierarchy) bundle is byte-identical to the pre-change build',
    !!outlineBefore && outlineBefore === outlineHash, {before: outlineBefore, after: outlineHash});
  check('build: the dictionary bundle changed (this task rebuilt it)', dictionaryHash !==
    ((before.match(/([0-9a-fA-F]{64})\s+\d+\s+memora\/static\/brain\/dictionary\/app\.js/) || [])[1] || '').toLowerCase(),
    dictionaryHash);

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
  await win.webContents.executeJavaScript("show('brain')");
  const frame = await waitForFrameIn(win, '/brain/dictionary/');
  await waitForFrame(frame,
    '!!(window.dictionaryGraph && window.dictionaryGraph.graph && window.dictionaryGraph.graph.nodes.length && window.memoraNebula)',
    'dictionary view + nebula bake');
  await delay(2600);

  const geometry = await frame.executeJavaScript(CURVED_EDGE_PROBE);
  check('nebula: the demo graph has sections to group by', geometry.sections >= 4, geometry.sections);
  check('nebula: every same-section link is straight (control === null)', geometry.straightControls === geometry.sameSectionEdges,
    {straight: geometry.straightControls, sameSection: geometry.sameSectionEdges});
  check('nebula: every cross-section link carries a control point',
    geometry.nonNullControlCrossSection === geometry.crossSectionEdges,
    {withControl: geometry.nonNullControlCrossSection, crossSection: geometry.crossSectionEdges});
  check('nebula: the curved links really are drawn as curves (geometry, not just the flag)',
    geometry.curvedInGeometry === geometry.crossSectionEdges && geometry.sameSectionCurvedInGeometry === 0,
    {curvedInGeometry: geometry.curvedInGeometry, crossSection: geometry.crossSectionEdges,
      sameSectionCurved: geometry.sameSectionCurvedInGeometry, maxBowRatio: geometry.maxBowRatio});
  check('nebula: curve strength is the reference 0.16 of the edge length',
    Math.abs(geometry.maxBowRatio - 0.08) < 0.02 && geometry.controlRatio
      && Math.abs(geometry.controlRatio.min - 0.16) < 1e-6 && Math.abs(geometry.controlRatio.max - 0.16) < 1e-6,
    {measuredBow: geometry.maxBowRatio, expectedHalfOffset: 0.08, controlRatio: geometry.controlRatio});
  // Every pair of shells must intersect: that is the reference's defining trait (all 21 of its
  // pairs overlap). The old check only looked at the *deepest* pair, which passes even when most
  // pairs have drifted apart -- so it now reads the minimum.
  check('nebula: every pair of section shells intersects (one interlocking nebula)',
    geometry.minOverlapFraction > 0 && geometry.geometry.shellOverlaps.median > 0.2,
    {shells: geometry.shells.length, minOverlapFraction: geometry.minOverlapFraction,
      maxOverlapFraction: geometry.maxOverlapFraction,
      medianOverlap: geometry.geometry.shellOverlaps.median,
      crowdingShortfall: +geometry.geometry.crowding.toFixed(2)});
  check('nebula: every term sits inside its own shell', geometry.radialRatio && geometry.radialRatio.max <= 1.05,
    geometry.radialRatio);
  check('nebula: section colouring is on, so the shells can be told apart', geometry.sectionColours === true);
  check('nebula: terms keep a readable gap', geometry.minNodeDistance > 6, geometry.minNodeDistance);
  check('nebula: the bake is deterministic (seed is the graph content)', typeof geometry.seed === 'string' && geometry.seed.length > 0,
    geometry.seed);

  // --- the reference geometry, compared number for number ------------------
  //
  // The reference site is 71 terms in 7 sections; Memora's demo projection is 14 terms in 5. The
  // comparison is therefore made on scale-free ratios and on the target band the Lead derived by
  // scaling the reference's own extent by cbrt(14/71) = 0.582.
  const target = geometry.geometry;
  check('reference: the cloud is 250-320 world units across (reference 581 scaled by cbrt(14/71))',
    target.diagonal >= 250 && target.diagonal <= 320,
    {diagonal: +target.diagonal.toFixed(1), extent: target.extent.map(v => +v.toFixed(0))});
  check('reference: the section centres form a ring 60-90 units out (the reference is 72-146 at 71 terms)',
    target.ringRadius >= 60 && target.ringRadius <= 90, +target.ringRadius.toFixed(1));
  check('reference: section radii are 45-90 units (the reference is 105-198 at 71 terms)',
    geometry.shells.every(shell => (shell.radius >= 45 && shell.radius <= 90)),
    geometry.shells.map(shell => ({title: shell.title, radius: +shell.radius.toFixed(1)})));
  check('reference: no term is closer than 30 units to another (the reference minimum is 38.5)',
    target.nearestNeighbour.min >= 30,
    {min: +target.nearestNeighbour.min.toFixed(1), median: +target.nearestNeighbour.median.toFixed(1),
      max: +target.nearestNeighbour.max.toFixed(1)});
  // The fill profile is what distinguishes the reference's solid balls from a hollow shell of dots:
  // mean distance ~0.6 of the radius, at least one member well inside, the furthest exactly on the
  // surface (that is the reference's own definition of radius). Measured over its 71 terms:
  // mean 0.60, min 0.15-0.33, max 1.00.
  // "Solid ball, not hollow shell" is a statement about the aggregate fill profile, because the
  // profile is fixed (0.15..1.0) and only the number of sample points per section varies. A
  // 2-member section has exactly two samples, so its own min/mean are quantised; the claim that
  // holds at every section size is: nothing escapes the shell, the furthest member is ON it, and
  // at least one section has a member well inside -- which is what a hollow shell cannot have.
  check('reference: members fill their shell (max = 1.0r, and some member sits near the centre)',
    geometry.shells.every(shell => shell.members < 2
      || (shell.radial.max <= 1.001 && shell.radial.max >= 0.98))
      && geometry.shells.some(shell => shell.members >= 2 && shell.radial.min <= 0.35),
    geometry.shells.map(shell => ({title: shell.title, members: shell.members,
      min: +shell.radial.min.toFixed(2), mean: +shell.radial.mean.toFixed(2),
      max: +shell.radial.max.toFixed(2)})));
  const fillMeans = geometry.shells.filter(shell => shell.members >= 2).map(shell => shell.radial.mean);
  check('reference: the mean fill sits at ~0.6 of the radius (reference mean 0.60)',
    fillMeans.length > 0 && fillMeans.reduce((a, b) => a + b, 0) / fillMeans.length >= 0.5
      && fillMeans.reduce((a, b) => a + b, 0) / fillMeans.length <= 0.8,
    {meanOfMeans: +(fillMeans.reduce((a, b) => a + b, 0) / fillMeans.length).toFixed(3),
      perSection: geometry.shells.map(shell => ({title: shell.title, mean: +shell.radial.mean.toFixed(2)}))});
  // The reference's within-section gap is 0.32-0.59 of the section radius, but that ratio is only
  // achievable with enough members to pack a ball: the radius is DEFINED as the furthest member's
  // distance, so a two-member section's one gap is necessarily close to the full radius whatever
  // the fill profile. The demo projection gives 14 terms over 5 sections (2-4 each) where the
  // reference has 71 over 7 (6-16 each), so the ratio is asserted where it is meaningful -- a
  // section with four or more members -- and every section's value is reported.
  const packed = geometry.shells.filter(shell => shell.members >= 4);
  check("reference: a packed section's nearest-neighbour gap is 0.3-0.7 of its radius (reference 0.32-0.59)",
    packed.length > 0 && packed.every(shell => shell.nearestNeighbour >= 0.3 && shell.nearestNeighbour <= 0.7),
    {sectionsWithFourOrMore: packed.length,
      all: geometry.shells.map(shell => ({title: shell.title, members: shell.members,
        nnOverRadius: +shell.nearestNeighbour.toFixed(2)}))});
  check('reference: sections read as clumps (members closer within than across)',
    target.clumpRatio > 0 && target.clumpRatio < 0.8,
    {withinMedian: +target.withinMedian.toFixed(1), betweenMedian: +target.betweenMedian.toFixed(1),
      clumpRatio: +target.clumpRatio.toFixed(2)});
  // "Fills the canvas" is judged on the dimension the fit actually works against.
  //
  // The nebula is a ring seen from above, so it projects roughly square (measured aspect here:
  // 520x463 px). On a 1.9:1 stage a square can only fill one dimension: driving the width to 60%
  // would push the height past 100% and clip. The height is therefore the binding dimension, and
  // the honest assertion is that the fit uses 60-85% of it -- which is also what the reader sees
  // as "the graph fills the window". Both fractions are recorded so the trade-off is visible.
  const fillAspect = (geometry.fill.widthFraction * geometry.fill.stage.width)
    / (geometry.fill.heightFraction * geometry.fill.stage.height);
  const bindingFill = Math.max(geometry.fill.widthFraction, geometry.fill.heightFraction);
  check('framing: the first frame fills 55-90% of the stage in the dimension it binds',
    bindingFill >= 0.55 && bindingFill <= 0.9,
    {...geometry.fill, bindingFraction: +bindingFill.toFixed(3), projectedAspect: +fillAspect.toFixed(2)});
  check('framing: the width limit is the stage aspect, not the fit (a square cloud cannot fill both)',
    fillAspect > 0.6 && fillAspect < 1.7,
    {projectedAspect: +fillAspect.toFixed(2), widthFraction: geometry.fill.widthFraction,
      heightFraction: geometry.fill.heightFraction});

  const enterShot = await shot(win, '01-enter-nebula.png');

  // A second bake of the same graph must land on bit-identical numbers: the view must not
  // reshuffle itself when a document reloads.
  const deterministic = await frame.executeJavaScript(`(() => {
    const app = window.dictionaryGraph;
    const before = app.graph.nodes.map(n => n.position.slice()).concat(app.graph.edges.map(e => e.control && e.control.slice()));
    const report = window.memoraNebula.rebake();
    const after = app.graph.nodes.map(n => n.position.slice()).concat(app.graph.edges.map(e => e.control && e.control.slice()));
    return {same: JSON.stringify(before) === JSON.stringify(after), nodes: report.nodes,
      straight: report.straightEdges, curved: report.curvedEdges};
  })()`);
  check('nebula: re-baking the same graph gives bit-identical positions and controls',
    deterministic.same === true, deterministic);
  await delay(1200);

  // The layout picker resets every control point to null by design; coming back to the network
  // layout must restore the curves, or one visit to the picker would silently flatten the view.
  const layoutRoundTrip = await frame.executeJavaScript(`(() => {
    const app = window.dictionaryGraph;
    app.setLayout('grid');
    const grid = {curves: app.graph.edges.filter(e => e.control !== null).length};
    app.setLayout('network');
    const back = {curves: app.graph.edges.filter(e => e.control !== null).length};
    return {grid, back};
  })()`);
  check('nebula: choosing another layout flattens the arcs, coming back restores them',
    layoutRoundTrip.grid.curves === 0 && layoutRoundTrip.back.curves === geometry.crossSectionEdges,
    layoutRoundTrip);
  await delay(1600);
  await shot(win, '02-nebula-layout-restored.png');

  // The full bake report, written out as evidence: which shells, how big, how deeply they
  // overlap, what the curve ratio measured, and where the cloud's extent ended up.
  const bake = await frame.executeJavaScript('window.memoraNebula.report');
  fs.writeFileSync(path.join(out, 'nebula-report.json'), JSON.stringify(bake, null, 2));

  // Selecting a vertex still works and still frames it: the nebula must not have broken the
  // click-to-best-angle behaviour that was already accepted.
  const selected = await frame.executeJavaScript(`(() => {
    const app = window.dictionaryGraph;
    const index = app.graph.nodes.findIndex((n, i) =>
      app.graph.edges.some(e => e.control !== null && (e.source === i || e.target === i)));
    app.select(index, true);
    return {index, slug: app.currentSlug, focus: window.memoraFocus ? window.memoraFocus.ids : null};
  })()`);
  await delay(1800);
  check('nebula: clicking a node on a curved link still selects and frames it',
    selected.index >= 0 && !!selected.focus && selected.focus.length >= 2, selected);
  await shot(win, '03-selected-in-nebula.png');

  // --- the hierarchy view is untouched -------------------------------------
  await win.webContents.executeJavaScript("$('brain-type').value='outline'; brain()");
  const outlineFrame = await waitForFrameIn(win, '/brain/outline/');
  await waitForFrame(outlineFrame,
    '!!(window.mindMap && window.mindMap.nodeCount && typeof window.frameOutlineNode === "function")',
    'outline view');
  await waitForFrame(outlineFrame,
    '(() => { const r = window.mindMap.rendererRef.rig; return !r.animating && !window.mindMap.engine.active; })()',
    'outline layout settle', 60000);
  await delay(1500);
  const outline = await outlineFrame.executeJavaScript(`(() => {
    const a = window.mindMap, g = a.graph;
    return {nodes: a.nodeCount, hierarchy: g.hierarchy.length, documentOrder: g.documentOrder.length,
      flow: window.memoraFlow ? window.memoraFlow.stats() : null,
      hasNebula: !!window.memoraNebula};
  })()`);
  check('hierarchy view: still has every demo node', outline.nodes >= 14, outline.nodes);
  check('hierarchy view: still has its hierarchy links', outline.hierarchy >= 20, outline.hierarchy);
  check('hierarchy view: the direction cue still draws', (outline.flow || {}).chevrons > 0, outline.flow);
  check('hierarchy view: the nebula bake never ran in this view', outline.hasNebula === false, outline.hasNebula);
  await shot(win, '04-hierarchy-unchanged.png');

  // --- a REAL project, with approved memories ---------------------------------
  //
  // Everything above ran on the demo preview, which is what an EMPTY project shows. A project with
  // stored memories renders through exactly the same view, so it is checked the same way: a second
  // backend on its own temporary data directory, seeded with approved memories (never the
  // workspace data/), and the same assertions on what that view actually draws.
  const realData = makeRealData();
  const realBase = await startBackendOn(realData);
  const realWin = new BrowserWindow({show: false, width: 1500, height: 1000, webPreferences: {
    nodeIntegration: false, contextIsolation: true, sandbox: true, offscreen: true, backgroundThrottling: false,
  }});
  await realWin.loadURL(realBase + '/?project=realp4');
  await delay(900);
  await realWin.webContents.executeJavaScript("show('brain')");
  const realFrame = await waitForFrameIn(realWin, '/brain/dictionary/');
  await waitForFrame(realFrame,
    '!!(window.dictionaryGraph && window.dictionaryGraph.graph && window.dictionaryGraph.graph.nodes.length'
    + ' && window.memoraNebula && window.memoraNebula.report)', 'real-project dictionary view');
  await delay(2600);
  const realView = await realFrame.executeJavaScript(`(() => {
    const app = window.dictionaryGraph, g = app.graph, report = window.memoraNebula.report;
    const sameSection = g.edges.filter(e => g.nodes[e.source].section === g.nodes[e.target].section).length;
    return {
      title: g.title, nodes: g.nodes.length, edges: g.edges.length, sections: g.sections.length,
      sameSectionEdges: sameSection, crossSectionEdges: g.edges.length - sameSection,
      straightControls: g.edges.filter(e => e.control === null).length,
      controlsOnCross: g.edges.filter(e =>
        e.control !== null && g.nodes[e.source].section !== g.nodes[e.target].section).length,
      sectionColours: app.sectionColors === true,
      isPreview: !!document.querySelector('.sa-brand-count') &&
        /演示/.test(document.body.textContent || ''),
      geometry: report.geometry,
      shellsIntersect: report.geometry.shellOverlaps.min > 0,
      radialMax: Math.max(...report.shells.map(s => s.radial.max)),
      curvedEdges: report.curvedEdges,
      controlRatio: report.controlRatio,
    };
  })()`);
  check('real project: the view is NOT the demo preview (real stored memories are drawn)',
    realView.nodes >= 40 && realView.isPreview === false,
    {nodes: realView.nodes, edges: realView.edges, previewBanner: realView.isPreview});
  check('real project: sections are real and coloured, as on the demo',
    realView.sections >= 5 && realView.sectionColours === true,
    {sections: realView.sections, sectionColours: realView.sectionColours});
  check('real project: every cross-section link is curved and every same-section link straight',
    realView.controlsOnCross === realView.crossSectionEdges
      && realView.straightControls === realView.sameSectionEdges
      && Math.abs(realView.controlRatio.min - 0.16) < 1e-6
      && Math.abs(realView.controlRatio.max - 0.16) < 1e-6,
    {crossSection: realView.crossSectionEdges, curved: realView.controlsOnCross,
      sameSection: realView.sameSectionEdges, straight: realView.straightControls,
      controlRatio: realView.controlRatio});
  check('real project: the section shells interlock and no term leaves its shell',
    realView.shellsIntersect && realView.radialMax <= 1.001,
    {overlap: realView.geometry.shellOverlaps, radialMax: realView.radialMax,
      diagonal: +realView.geometry.diagonal.toFixed(1),
      nearestNeighbour: realView.geometry.nearestNeighbour});
  await shot(realWin, '05-real-project-nebula.png');
  realWin.destroy();
  backendReal.kill();

  // --- the answer to "does this work on a REAL project?" --------------------
  //
  // The demo preview is only what an empty project shows. A project with approved memories gets
  // the same /brain/dictionary/ view, so the bake must work there too -- and at 100-880 terms, not
  // just at 14. artifacts/p4-matt/scale-report.json is produced by frontend/_scale.mjs, which
  // writes a seeded temporary project's real projection, then runs the very same bakeNebula over
  // it and over synthetic graphs at the larger sizes.
  const scalePath = path.join(out, 'scale-report.json');
  const scale = fs.existsSync(scalePath) ? JSON.parse(fs.readFileSync(scalePath, 'utf8')) : null;
  check('real project: the bake ran over a REAL project projection (60 approved memories)',
    !!scale && !!scale.realProject60, scale ? Object.keys(scale) : null);
  if (scale && scale.realProject60) {
    const real = scale.realProject60;
    check('real project: every section shell intersects and every member stays inside its shell',
      real.everyShellPairIntersects && !real.membersOutsideShell,
      {shells: real.sections, overlap: real.shellOverlap, radial: real.radial});
    check('real project: still deterministic, still curves the cross-section links at 0.16',
      real.deterministic === true && real.curvedEdges > 0 && real.controlRatio.min === 0.16,
      {deterministic: real.deterministic, curvedEdges: real.curvedEdges, straightEdges: real.straightEdges,
        controlRatio: real.controlRatio, clumpRatio: real.clumpRatio});
    check('real project: the bake is fast enough to run on every document open (<100 ms)',
      real.bakeMs < 100, real.bakeMs + ' ms');
  }
  for (const size of [100, 400, 880]) {
    const entry = scale && scale['synthetic' + size];
    check('scale ' + size + ': deterministic, all shells intersect, no member escapes its shell',
      !!entry && entry.deterministic === true && entry.everyShellPairIntersects && !entry.membersOutsideShell,
      entry ? {nodes: entry.nodes, bakeMs: entry.bakeMs, overlap: entry.shellOverlap,
        radial: entry.radial} : null);
    check('scale ' + size + ': bake stays under 1 s (the view has to open, not spin)',
      !!entry && entry.bakeMs < 1000, entry ? entry.bakeMs + ' ms' : null);
  }

  // The comparison table the Lead asked for: this run's value beside the reference's own.
  // The reference is 71 terms in 7 sections; Memora's demo is 14 in 5, so scale-free ratios are
  // compared directly and absolute lengths against the reference scaled by cbrt(14/71) = 0.582
  // (a cloud's linear size grows as the cube root of what it holds).
  const REFERENCE = {
    nodes: 71, sections: 7, diagonal: 581, ringRadius: 109.2,
    nearestNeighbour: {min: 38.5, median: 58.6, max: 81.1},
    shellOverlap: {min: 0.038, median: 0.457, max: 0.706},
    radial: {min: 0.15, mean: 0.60, max: 1.0},
    clumpRatio: 0.57,
  };
  const scaleFactor = Math.cbrt(14 / 71);
  const mine = {
    nodes: bake.nodes, sections: bake.shells.length,
    diagonal: +bake.geometry.diagonal.toFixed(1),
    ringRadius: +bake.geometry.ringRadius.toFixed(1),
    nearestNeighbour: {
      min: +bake.geometry.nearestNeighbour.min.toFixed(1),
      median: +bake.geometry.nearestNeighbour.median.toFixed(1),
      max: +bake.geometry.nearestNeighbour.max.toFixed(1),
    },
    shellOverlap: {
      min: +bake.geometry.shellOverlaps.min.toFixed(3),
      median: +bake.geometry.shellOverlaps.median.toFixed(3),
      max: +bake.geometry.shellOverlaps.max.toFixed(3),
    },
    radial: {
      min: +Math.min(...bake.shells.map(shell => shell.radial.min)).toFixed(3),
      mean: +(bake.shells.reduce((sum, shell) => sum + shell.radial.mean, 0) / bake.shells.length).toFixed(3),
      max: +Math.max(...bake.shells.map(shell => shell.radial.max)).toFixed(3),
    },
    clumpRatio: +bake.geometry.clumpRatio.toFixed(3),
  };
  const comparison = {
    note: 'absolute lengths are compared against the reference scaled by cbrt(14/71)=0.582; '
      + 'ratios (overlap, radial fractions, clump ratio) are compared unscaled',
    scaleFactor: +scaleFactor.toFixed(4),
    rows: [
      {metric: 'nodes', mine: mine.nodes, reference: REFERENCE.nodes},
      {metric: 'sections', mine: mine.sections, reference: REFERENCE.sections},
      {metric: 'cloud diagonal (world units)', mine: mine.diagonal,
        referenceScaled: +(REFERENCE.diagonal * scaleFactor).toFixed(1), referenceRaw: REFERENCE.diagonal},
      {metric: 'ring radius (world units)', mine: mine.ringRadius,
        referenceScaled: +(REFERENCE.ringRadius * scaleFactor).toFixed(1), referenceRaw: REFERENCE.ringRadius},
      {metric: 'nearest-neighbour min', mine: mine.nearestNeighbour.min,
        referenceScaled: +(REFERENCE.nearestNeighbour.min * scaleFactor).toFixed(1),
        referenceRaw: REFERENCE.nearestNeighbour.min},
      {metric: 'nearest-neighbour median', mine: mine.nearestNeighbour.median,
        referenceScaled: +(REFERENCE.nearestNeighbour.median * scaleFactor).toFixed(1),
        referenceRaw: REFERENCE.nearestNeighbour.median},
      {metric: 'shell overlap min', mine: mine.shellOverlap.min, reference: REFERENCE.shellOverlap.min},
      {metric: 'shell overlap median', mine: mine.shellOverlap.median, reference: REFERENCE.shellOverlap.median},
      {metric: 'shell overlap max', mine: mine.shellOverlap.max, reference: REFERENCE.shellOverlap.max},
      {metric: 'radial fill min', mine: mine.radial.min, reference: REFERENCE.radial.min},
      {metric: 'radial fill mean', mine: mine.radial.mean, reference: REFERENCE.radial.mean},
      {metric: 'radial fill max', mine: mine.radial.max, reference: REFERENCE.radial.max},
      {metric: 'clump ratio (within/between)', mine: mine.clumpRatio, reference: REFERENCE.clumpRatio},
    ],
  };
  fs.writeFileSync(path.join(out, 'reference-comparison.json'), JSON.stringify(comparison, null, 2));

  const report = {
    suite: 'P4 semantic-relation nebula acceptance',
    synthetic_data_only: true,
    command: '.\\desktop\\node_modules\\electron\\dist\\electron.exe tools\\ui_validation_p4_matt.cjs'
      + '   (run from the repository root; clear ELECTRON_RUN_AS_NODE first if this machine sets it)',
    expected: 'exit code 0, "passed": true, every assertion green, 4 PNGs + this report in artifacts/p4-matt/',
    data_directory: data,
    backend: base,
    bundles: {dictionary: dictionaryHash, outline: outlineHash, outlineUnchanged: outlineHash === outlineBefore},
    nebula: {shells: bake.shells, curvedEdges: bake.curvedEdges, straightEdges: bake.straightEdges,
      curveRatio: bake.curveRatio, controlRatio: bake.controlRatio, minShellOverlap: bake.minShellOverlap,
      shellsAllIntersect: bake.shellsAllIntersect, radialRatio: bake.radialRatio,
      geometry: bake.geometry},
    referenceComparison: comparison,
    realProjectAndScale: scale,
    assertions: checks,
    screenshots: fs.readdirSync(out).filter(f => f.endsWith('.png')).sort(),
    page_errors: pageErrors,
    passed: errors.length === 0,
  };
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log('screenshots:', [enterShot].join(' '));
  win.destroy();
  if (errors.length) throw new Error('failed assertions: ' + errors.join(', '));
}

main().then(() => { backend.kill(); app.quit(); })
  .catch(error => { console.error(error.stack); if (backend) backend.kill(); app.exit(1); });
