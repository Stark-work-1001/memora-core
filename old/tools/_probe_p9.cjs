
const {app, BrowserWindow} = require('electron');
const {spawn} = require('node:child_process');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const root = path.resolve(__dirname, '..');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'memora-p9probe-'));
const logPath = path.join(root, 'artifacts', 'p9-probe.log');
fs.mkdirSync(path.dirname(logPath), {recursive: true});
fs.writeFileSync(logPath, '');
const log = (...a) => { fs.appendFileSync(logPath, a.map(x => typeof x === 'string' ? x : JSON.stringify(x, null, 1)).join(' ') + '\n'); process.stdout.write(a.join(' ') + '\n'); };
const delay = ms => new Promise(r => setTimeout(r, ms));
let backend;
async function startBackend() {
  backend = spawn(path.join(root, '.venv', 'Scripts', 'python.exe'),
    ['-m', 'memora', '--data', data, 'serve', '--port', '0'],
    {cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
  let err = '';
  backend.stderr.on('data', b => { err += b; });
  return await new Promise((res, rej) => {
    let t = ''; const timer = setTimeout(() => rej(new Error('timeout ' + err)), 60000);
    backend.stdout.on('data', b => { t += b; const m = t.match(/http:\/\/127\.0\.0\.1:\d+/); if (m) { clearTimeout(timer); res(m[0]); } });
    backend.once('exit', c => rej(new Error('exit ' + c + ' ' + err)));
  });
}
async function waitFrameIn(win, frag, ms = 60000) {
  const start = Date.now();
  while (Date.now() - start < ms) { const f = win.webContents.mainFrame.frames.find(x => x.url.includes(frag)); if (f) return f; await delay(200); }
  throw new Error('no frame ' + frag);
}
async function waitFor(frame, expr, label, ms = 60000) {
  const start = Date.now(); let last;
  while (Date.now() - start < ms) { try { last = await frame.executeJavaScript(expr); if (last) return last; } catch (e) { last = String(e.message); } await delay(200); }
  throw new Error('wait ' + label + ' last=' + JSON.stringify(last));
}

function dictProbe() {
  const a = window.dictionaryGraph;
  const scene = a.scene;
  const kids = scene.scene.children.map(o => ({
    type: o.type, isLineSegments: !!o.isLineSegments, isMesh: !!o.isMesh,
    visible: o.visible, frustumCulled: o.frustumCulled,
    positionCount: o.geometry && o.geometry.attributes && o.geometry.attributes.position ? o.geometry.attributes.position.count : null,
    hasColor: !!(o.geometry && o.geometry.attributes && o.geometry.attributes.color),
  }));
  return {
    sceneKeys: Object.keys(scene).filter(k => !k.startsWith('_')),
    hasEdges: !!scene.edges, hasHot: !!scene.hot,
    edgesIsSameObjectInScene: !!(scene.edges && scene.scene.children.includes(scene.edges)),
    edgesVertexCount: scene.edges && scene.edges.geometry && scene.edges.geometry.attributes.position ? scene.edges.geometry.attributes.position.count : null,
    hotVertexCount: scene.hot && scene.hot.geometry && scene.hot.geometry.attributes.position ? scene.hot.geometry.attributes.position.count : null,
    edgeCount: a.graph.edges.length, nodeCount: a.graph.nodes.length,
    children: kids,
    cameraKeys: Object.keys(a.camera).filter(k => !k.startsWith('_')),
    cameraAz: a.camera.azimuth, cameraPolar: a.camera.polar, cameraDistance: a.camera.distance,
    selectedIsPrivate: typeof a.selected,
    appKeys: Object.getOwnPropertyNames(Object.getPrototypeOf(a)).filter(k => !k.startsWith('_') || k === '_').slice(0, 60),
  };
}

function outlineProbe() {
  const a = window.mindMap;
  const r = a.rendererRef;
  const groupKids = r.links.group.children.map(o => ({
    type: o.type, visible: o.visible, instanceCount: o.geometry ? o.geometry.instanceCount : null,
    attrs: o.geometry ? Object.keys(o.geometry.attributes) : [],
    iStartCount: o.geometry && o.geometry.attributes.iStart ? o.geometry.attributes.iStart.count : null,
    iControlCount: o.geometry && o.geometry.attributes.iControl ? o.geometry.attributes.iControl.count : null,
  }));
  return {
    rendererKeys: Object.keys(r).filter(k => !k.startsWith('_')),
    edgeLayerKeys: Object.keys(r.edges).filter(k => !k.startsWith('_')),
    edgeMeshAttrs: r.edges.mesh && r.edges.mesh.geometry ? Object.keys(r.edges.mesh.geometry.attributes) : [],
    edgeInstanceCount: r.edges.mesh ? r.edges.mesh.geometry.instanceCount : null,
    edgeCount: r.edges.edgeCount,
    linkCount: r.links.linkCount,
    linkGroupKids: groupKids,
    graphCounts: a.graph ? {
      ids: a.graph.ids.length,
      hierarchy: a.graph.hierarchy.length,
      documentOrder: a.graph.documentOrder.length,
      associations: a.graph.associations ? a.graph.associations.length : null,
      noteLinks: a.graph.noteLinks ? a.graph.noteLinks.length : null,
    } : null,
    rigKeys: Object.keys(r.rig).filter(k => !k.startsWith('_')),
    rigViewport: r.rig.viewport, rigInsets: r.rig.insets,
    spherical: r.rig.toSpherical(),
    camPos: {x: r.camera.position.x, y: r.camera.position.y, z: r.camera.position.z},
    engineCount: a.engine ? a.engine.count : null,
    appProto: Object.getOwnPropertyNames(Object.getPrototypeOf(a)).filter(k => !k.startsWith('_')).slice(0, 60),
  };
}

async function main() {
  app.setPath('userData', path.join(data, 'electron'));
  app.disableHardwareAcceleration();
  await app.whenReady();
  const base = await startBackend();
  log('backend', base);
  const win = new BrowserWindow({show: false, width: 1500, height: 1000, webPreferences: {
    nodeIntegration: false, contextIsolation: true, sandbox: true, offscreen: true, backgroundThrottling: false}});
  await win.loadURL(base + '/?project=default');
  await delay(1200);
  await win.webContents.executeJavaScript("show('brain')");
  await delay(1200);

  await win.webContents.executeJavaScript("(() => { const s = document.querySelector('#brain-type'); if (![...s.options].some(o => o.value === 'matt')) { const o = document.createElement('option'); o.value='matt'; o.textContent='星云关系图'; s.append(o); } s.value='dictionary'; document.querySelector('#brain-dimension').value='3d'; brain(); })()");
  const df = await waitFrameIn(win, '/brain/dictionary/');
  await waitFor(df, '!!(window.dictionaryGraph && window.dictionaryGraph.graph && window.dictionaryGraph.graph.nodes.length)', 'dict');
  await delay(2500);
  log('=== DICTIONARY ===');
  log(await df.executeJavaScript('(' + dictProbe.toString() + ')()'));

  await win.webContents.executeJavaScript("(() => { document.querySelector('#brain-type').value='matt'; document.querySelector('#brain-dimension').value='3d'; brain(); })()");
  const mf = await waitFrameIn(win, '/brain/matt/');
  await waitFor(mf, '!!(window.dictionaryGraph && window.memoraNebula && window.memoraNebula.report)', 'matt');
  await delay(2500);
  log('=== MATT ===');
  log(await mf.executeJavaScript('(' + dictProbe.toString() + ')()'));

  await win.webContents.executeJavaScript("(() => { document.querySelector('#brain-type').value='outline'; document.querySelector('#brain-dimension').value='3d'; brain(); })()");
  const of_ = await waitFrameIn(win, '/brain/outline/');
  await waitFor(of_, '!!(window.mindMap && window.mindMap.nodeCount)', 'outline');
  await delay(3000);
  log('=== OUTLINE ===');
  log(await of_.executeJavaScript('(' + outlineProbe.toString() + ')()'));

  win.destroy(); backend.kill(); app.exit(0);
}
main().catch(e => { log('ERR', e && e.stack || String(e)); if (backend) backend.kill(); app.exit(2); });
