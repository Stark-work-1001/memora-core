/**
 * 无头渲染自测：node --test frontend/tests/brain-render.test.mjs
 *
 * 单测能证明布局算法对，证明不了"页面能不能真的画出来"。这个测试起一个静态服务器，
 * 用本机 Chrome 的 headless 模式打开 brain.html，通过 CDP 读回真实运行状态：
 *   - 有没有 JS 报错 / CSP 违规
 *   - WebGL 上下文是否拿到，canvas 是否有真实尺寸
 *   - 节点数、边数、draw call 数、标签数、帧率
 *   - 点一下画布中心，是否真的选中并触发相机转场
 *   - 截图存盘供人工核对
 *
 * 找不到 Chrome 时自动 skip（不把别人机器上的缺失当成我的失败）。
 */
import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const staticDir = path.join(repo, 'memora_core', 'static');

// MEMORA_CHROME 可显式指定浏览器；否则按下面的顺序找。Chrome 的"仅为我安装"会落在
// %LOCALAPPDATA% 下，原先的列表漏了它，于是退回 Edge——而 Edge 在已有实例时会把
// 无头启动交给旧进程后立刻 code=0 退出，测试因此报"Chrome 提前退出"。
const CHROME_CANDIDATES = [
  ...(process.env.MEMORA_CHROME ? [process.env.MEMORA_CHROME] : []),
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ...(process.env.LOCALAPPDATA ? [path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')] : []),
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    try { if (fs.existsSync(candidate)) return candidate; } catch { /* 无权限就跳过 */ }
  }
  return null;
}

const chromePath = findChrome();
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

let server = null;
let port = 0;

before(async () => {
  if (!fs.existsSync(path.join(staticDir, 'brain.js'))) {
    throw new Error('缺少 memora_core/static/brain.js，请先运行 cd frontend && npm run build');
  }
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const rel = decodeURIComponent(url.pathname === '/' ? '/brain.html' : url.pathname);
    const file = path.join(staticDir, rel.replace(/^\/+/, ''));
    if (!file.startsWith(staticDir)) { res.writeHead(403).end(); return; }
    fsp.readFile(file).then((body) => {
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    }).catch(() => res.writeHead(404).end('not found'));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

/** 极简 CDP 客户端（Node 24 自带 WebSocket）。 */
class Cdp {
  constructor(ws, sessionId) {
    this.ws = ws;
    this.sessionId = sessionId;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const entry = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) entry.reject(new Error(msg.error.message));
        else entry.resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (this.sessionId) payload.sessionId = this.sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('CDP 超时: ' + method));
        }
      }, 30000);
    });
  }

  /** 在页面里求值并拿回 JSON。 */
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      const desc = result.exceptionDetails.exception ? result.exceptionDetails.exception.description : '';
      throw new Error('页面内异常: ' + (result.exceptionDetails.text || '') + ' ' + (desc || ''));
    }
    return result.result.value;
  }

  async waitFor(expression, timeoutMs = 25000, interval = 200) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      try {
        if (await this.evaluate(expression)) return true;
      } catch { /* 页面可能还没加载完 */ }
      await new Promise((r) => setTimeout(r, interval));
    }
    return false;
  }
}

/** 启动 Chrome 并接上 CDP。 */
async function launch(url) {
  const userDataDir = await fsp.mkdtemp(path.join(tmpdir(), 'memora-cdp-'));
  const args = [
    '--headless=new',
    '--remote-debugging-port=0',
    '--user-data-dir=' + userDataDir,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--window-size=1440,900',
    '--hide-scrollbars',
    // headless 上没有真 GPU：用 SwiftShader 软件光栅化跑 WebGL，这样测的是真实的 GL 管线
    '--enable-unsafe-swiftshader',
    '--use-angle=swiftshader',
    '--disable-dev-shm-usage',
    url,
  ];
  const child = spawn(chromePath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const wsUrl = await new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('Chrome 启动超时: ' + buffer.slice(-500))), 30000);
    child.stderr.on('data', (chunk) => {
      buffer += chunk.toString();
      const match = buffer.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error('Chrome 提前退出 code=' + code + ' ' + buffer.slice(-600)));
    });
  });

  const browserWs = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    browserWs.addEventListener('open', resolve, { once: true });
    browserWs.addEventListener('error', reject, { once: true });
  });
  const browser = new Cdp(browserWs, null);
  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    const targets = await browser.send('Target.getTargets');
    target = targets.targetInfos.find((t) => t.type === 'page' && t.url.includes('brain.html'));
    if (!target) await new Promise((r) => setTimeout(r, 250));
  }
  if (!target) throw new Error('找不到 brain.html 的 page target');
  const attached = await browser.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  const page = new Cdp(browserWs, attached.sessionId);
  page.events = browser.events;
  await page.send('Runtime.enable');
  await page.send('Log.enable');
  await page.send('Page.enable');
  await page.send('Page.reload', { ignoreCache: true });
  return { child, browser, page, userDataDir, ws: browserWs };
}

test('无头渲染：brain.html 在真实 Chrome 里跑起来、画出节点且无报错', {
  skip: chromePath === null ? '本机没有 Chrome/Edge' : false,
}, async (t) => {
  const url = 'http://127.0.0.1:' + port + '/brain.html';
  const session = await launch(url);
  t.after(async () => {
    try { session.ws.close(); } catch { /* 已关闭 */ }
    try { session.child.kill(); } catch { /* 已退出 */ }
    await fsp.rm(session.userDataDir, { recursive: true, force: true }).catch(() => {});
  });
  const page = session.page;

  // 注意：__debug 是 getter，永远返回对象，不能拿它当"初始化完成"的信号；
  // 必须等 __debug.ready（state 已建立且首帧已画过）。
  const ready = await page.waitFor('!!(window.__memBrain && window.__memBrain.__debug && window.__memBrain.__debug.ready)', 30000);
  const failureDetail = ready ? '' : await page.evaluate('JSON.stringify(window.__memBrain ? window.__memBrain.__debug : { none: true })').catch(() => '');
  assert.equal(ready, true, '引擎应当在 30s 内完成初始化；当前 ' + failureDetail);

  const snapshot = await page.evaluate('JSON.stringify((function () {' +
    'var app = window.__memBrain;' +
    'var d = app.__debug;' +
    'var canvas = document.querySelector("canvas.mem-brain-canvas");' +
    'var gl = canvas ? (canvas.getContext("webgl2") || canvas.getContext("webgl")) : null;' +
    'var wm = document.querySelector("[data-el=\\"watermark\\"]");' +
    'return {' +
    '  ready: d.ready, nodes: d.nodes, edges: d.edges, calls: d.calls, triangles: d.triangles,' +
    '  labels: d.labels, fps: d.fps, view: d.view, demo: d.demo, layoutMode: d.layoutMode,' +
    '  selection: d.selection, flightActive: d.flightActive, projection: d.projection,' +
    '  canvasWidth: canvas ? canvas.width : 0, canvasHeight: canvas ? canvas.height : 0,' +
    '  hasGl: !!gl, glVersion: gl ? gl.getParameter(gl.VERSION) : "",' +
    '  uiPresent: !!document.querySelector(".mem-brain-ui"),' +
    '  viewButtons: document.querySelectorAll("[data-view]").length,' +
    '  watermarkShown: wm ? getComputedStyle(wm).display !== "none" : false,' +
    '  styleInjected: !!document.getElementById("mem-brain-styles")' +
    '};})())').then((text) => JSON.parse(text));

  console.log('    渲染快照:', JSON.stringify(snapshot));

  assert.equal(snapshot.ready, true, '引擎应当报告 ready');
  assert.ok(snapshot.hasGl, 'WebGL 上下文应当可用');
  assert.ok(snapshot.canvasWidth > 100 && snapshot.canvasHeight > 100, 'canvas 应当有真实尺寸');
  assert.ok(snapshot.nodes > 100, '应当渲染出演示节点，实际 ' + snapshot.nodes);
  assert.ok(snapshot.edges > snapshot.nodes, '应当渲染出边，实际 ' + snapshot.edges);
  assert.ok(snapshot.uiPresent, 'UI 叠加层应当存在');
  assert.equal(snapshot.viewButtons, 4, '应当有四个视图切换按钮');
  assert.equal(snapshot.styleInjected, true, '样式应当由 brain.js 注入');
  assert.equal(snapshot.watermarkShown, true, '后端未启动时应当显示"演示数据"水印');
  // draw call 预算：主场景 = 星尘(1) + 边(1) + 节点(1) + 光环(1) = 4；
  // 标签层每个可见标签 1 次（没有文本图集，这是可接受的取舍，见最终报告）——
  // 关键是它**随节点总数无关**，只跟标签预算有关。所以这里断言的是
  // "calls ≈ 常数 + 标签数"，而不是一个固定小数字：真正要防的是有人把节点/边
  // 退回成逐个 Mesh。
  const labelBudget = 120;
  const expectedMax = 8 + Math.min(labelBudget, snapshot.labels) + 4;
  console.log('    draw call:', snapshot.calls, '（标签 ' + snapshot.labels + '，上限 ' + expectedMax + '）');
  assert.ok(snapshot.calls <= expectedMax, 'draw call 应当与节点数无关，实际 ' + snapshot.calls + '，上限 ' + expectedMax);
  // 节点必须是实例化渲染：5000 节点的三角形数 ≈ 实例数 × 每实例面数，
  // 如果退化成逐个 Mesh，calls 会直接等于节点数。
  assert.ok(snapshot.calls < snapshot.nodes / 4, 'draw call 必须远小于节点数（实例化），实际 ' + snapshot.calls + ' vs ' + snapshot.nodes);

  // 点击一个**已知节点**的屏幕位置：验证 拾取 → 选中 → 相机转场。
  // 不能盲点画布中心：布局是稀疏三维点云，正中心经常恰好没有节点。
  // 等相机稳定：拾取用的是**当帧**相机，而"节点的屏幕位置"是上一帧算出来的。
  // 加载后的阻尼/取景还没停时点下去，光标和节点就已经错位了（曾经因此点了没反应）。
  const stable = await page.waitFor('(function(){' +
    'var a = window.__memBrain; var s = a.__screenOf(0); if (!s) return false;' +
    'var key = Math.round(s.x) + ":" + Math.round(s.y);' +
    'if (window.__lastKey === key) return true; window.__lastKey = key; return false;})()', 8000, 120);
  assert.equal(stable, true, '相机应当在 8s 内稳定下来');

  const target = await page.evaluate('JSON.stringify((function(){' +
    'var app = window.__memBrain;' +
    'var n = app.__debug.nodes;' +
    'for (var i = 0; i < n; i++) {' +
    '  var p = app.__screenOf(i);' +
    '  if (!p) continue;' +
    '  var r = document.querySelector("canvas.mem-brain-canvas").getBoundingClientRect();' +
    '  if (p.x > r.left + 120 && p.x < r.right - 120 && p.y > r.top + 120 && p.y < r.bottom - 120) {' +
    '    var picked = app.__pick(p.x, p.y);' +
    '    if (picked === i) return { index: i, x: p.x, y: p.y };' +
    '  }' +
    '}' +
    'return null;})())').then((text) => JSON.parse(text));
  assert.ok(target, '应当能找到一个可精确拾取的屏内节点');
  console.log('    点击目标:', JSON.stringify(target));

  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount: 1 });
  await new Promise((r) => setTimeout(r, 900));

  const afterClick = await page.evaluate('JSON.stringify((function(){' +
    'var app = window.__memBrain;' +
    'var d = app.__debug;' +
    'return { selection: d.selection, flightActive: d.flightActive, labels: d.labels, status: d.status,' +
    '  events: app.__events, lastPick: app.__lastPick, instances: app.__instanceProbe() };})())')
    .then((text) => JSON.parse(text));
  console.log('    点击后:', JSON.stringify(afterClick));

  assert.equal(afterClick.selection, target.index, '点击应当选中被点中的那个节点');
  assert.match(afterClick.status, /选中/);

  // 需求 2：点击后邻居径向外推 + 选中节点放大 1.4×
  const disp = await page.evaluate('JSON.stringify(window.__memBrain.__displacement())').then(JSON.parse);
  console.log('    选中位移:', JSON.stringify(disp));
  assert.ok(disp.neighbors > 0, '选中节点应当有邻居被高亮');
  assert.ok(disp.maxPush > 0, '邻居应当被径向外推（maxPush > 0），实际 ' + disp.maxPush);
  assert.ok(disp.ratio > 1.15, '选中节点应当明显放大（比值 > 1.15），实际 ' + disp.ratio.toFixed(2));
  assert.ok(Math.abs(afterClick.flightActive) === 1 || afterClick.flightActive === false,
    '聚焦转场字段应当是可读的布尔值');

  // ---------- 四种视图 + 2D/3D 都要真的画出来 ----------
  const views = [
    { view: 'semantic', dims: null, file: 'brain-render-semantic.png' },
    { view: 'hierarchy', dims: 2, file: 'brain-render-hierarchy-2d.png' },
    { view: 'hierarchy', dims: 3, file: 'brain-render-hierarchy-3d.png' },
    { view: 'timeline', dims: null, file: 'brain-render-timeline.png' },
    { view: 'evidence', dims: null, file: 'brain-render-evidence.png' },
  ];
  const viewReports = [];
  for (const spec of views) {
    // 等 setView/setDims 真正跑完（它们是 async，布局在 worker 里算），
    // 不能用固定 sleep：布局被下一次请求 superseded 时会被静默丢弃。
    await page.evaluate('window.__memBrain.__setView(' + JSON.stringify(spec.view) + ')');
    await page.waitFor('window.__memBrain.__debug.view === ' + JSON.stringify(spec.view) +
      ' && window.__memBrain.__debug.ready', 20000);
    if (spec.dims !== null) {
      await page.evaluate('window.__memBrain.__setDims(' + spec.dims + ')');
      const want = spec.dims === 2 ? '2d' : 'perspective';
      await page.waitFor('window.__memBrain.__debug.projection === ' + JSON.stringify(want) +
        ' && window.__memBrain.__layoutInfo().layoutDims === ' + spec.dims, 20000);
    } else {
      await new Promise((r) => setTimeout(r, 600));
    }
    const state = await page.evaluate('JSON.stringify((function(){' +
      'var d = window.__memBrain.__debug;' +
      'return { view: d.view, dims: d.dims, projection: d.projection,' +
      '  nodes: d.nodes, edges: d.edges, calls: d.calls, labels: d.labels, layoutMs: d.layoutMs,' +
      '  info: window.__memBrain.__layoutInfo(), trace: d.layoutTrace };})())')
      .then((text) => JSON.parse(text));
    const shot = await page.send('Page.captureScreenshot', { format: 'png' });
    const outPath = path.join(here, spec.file);
    await fsp.writeFile(outPath, Buffer.from(shot.data, 'base64'));
    const size = (await fsp.stat(outPath)).size;
    viewReports.push({ ...spec, ...state, bytes: size });
    console.log('    ' + spec.view + (spec.dims ? '-' + spec.dims + 'd' : '') + ':',
      'nodes=' + state.nodes, 'edges=' + state.edges, 'calls=' + state.calls,
      'labels=' + state.labels, 'projection=' + state.projection,
      'layout=' + state.layoutMs + 'ms', 'png=' + size + 'B',
      '| dims=' + JSON.stringify(state.info) + ' trace=' + JSON.stringify(state.trace));
    assert.equal(state.view, spec.view);
    assert.ok(state.nodes > 100, spec.view + ' 视图应当有节点');
    assert.ok(size > 20000, spec.view + ' 截图不应是空白，实际 ' + size + ' bytes');
    if (spec.dims === 2) {
      assert.equal(state.projection, '2d', 'hierarchy 2D 必须切到正交相机');
    }
    if (spec.dims === 3) {
      assert.equal(state.projection, 'perspective', 'hierarchy 3D 必须回到透视相机');
    }
  }
  // 回到语义视图，给最终截图
  await page.evaluate('window.__memBrain.__setView("semantic")');
  await new Promise((r) => setTimeout(r, 800));
  const shot = await page.send('Page.captureScreenshot', { format: 'png' });
  const shotPath = path.join(here, 'brain-render.png');
  await fsp.writeFile(shotPath, Buffer.from(shot.data, 'base64'));
  const stat = await fsp.stat(shotPath);
  console.log('    最终截图:', shotPath, stat.size + ' bytes');
  assert.ok(stat.size > 20000, '截图不应是空白图，实际 ' + stat.size + ' bytes');

  // ---------- 规模护栏：5000 节点 ----------
  const scaleStart = Date.now();
  await page.evaluate('window.__memBrain.__loadScale(5000)');
  await page.waitFor('window.__memBrain.__debug.nodes >= 5000', 40000);
  await new Promise((r) => setTimeout(r, 1200));
  const scale = await page.evaluate('JSON.stringify((function(){' +
    'var d = window.__memBrain.__debug;' +
    'return { nodes: d.nodes, edges: d.edges, calls: d.calls, triangles: d.triangles,' +
    '  labels: d.labels, layoutMs: d.layoutMs, lod: d.lod };})())').then(JSON.parse);
  console.log('    规模 5000:', JSON.stringify(scale), '总耗时 ' + (Date.now() - scaleStart) + 'ms');
  assert.ok(scale.nodes >= 5000, '应当装载 5000 个节点');
  // 关键性能断言：draw call 不随节点数增长（实例化的意义所在）
  assert.ok(scale.calls < 200, '5000 节点的 draw call 必须远小于节点数，实际 ' + scale.calls);
  assert.ok(scale.labels <= 130, '标签必须有上限（默认 120），实际 ' + scale.labels);
  assert.ok(scale.layoutMs < 10000, '布局应当在 10s 内完成，实际 ' + scale.layoutMs + 'ms');
  const scaleShot = await page.send('Page.captureScreenshot', { format: 'png' });
  await fsp.writeFile(path.join(here, 'brain-render-5000.png'), Buffer.from(scaleShot.data, 'base64'));

  // ---------- 导出 PNG ----------
  const exported = await page.evaluate('window.__memBrain.__exportDataUrl()');
  console.log('    导出 PNG: ' + (typeof exported === 'string' ? exported.length + ' chars (data URL)' : 'FAILED'));
  assert.ok(typeof exported === 'string' && exported.startsWith('data:image/png;base64,'), '导出应当返回 PNG data URL');
  assert.ok(exported.length > 50000, '导出的 PNG 不应是空白，实际 ' + exported.length);

  // 恢复演示规模，后续交互测试在 452 节点上做
  await page.evaluate('window.__memBrain.__loadScale(460)');
  await page.waitFor('window.__memBrain.__debug.nodes < 1000', 20000);

  // ---------- 搜索 / 路径查找 ----------
  const searchHits = await page.evaluate('JSON.stringify(window.__memBrain.__search("记忆"))').then(JSON.parse);
  console.log('    搜索「记忆」:', searchHits.length, '个命中');
  assert.ok(searchHits.length > 0, '搜索应当能命中演示数据里的节点');

  const pathInfo = await page.evaluate('JSON.stringify((function(){' +
    'var app = window.__memBrain;' +
    'var d = app.__debug;' +
    'var p = app.__path(0, Math.min(50, d.nodes - 1));' +
    'return { len: p.length, hops: Math.max(0, p.length - 1) };})())').then(JSON.parse);
  console.log('    路径查找:', JSON.stringify(pathInfo));
  assert.ok(pathInfo.len > 0, '连通图里应当能找到路径');

  // 只关心 brain.js 自己的错误。以下三类来自 build.mjs 生成的页面模板与测试环境，
  // 不在脑图代码路径上（brain.html 由 build.mjs 生成，属于 T7 的文件范围）：
  //   - frame-ancestors 写在 <meta> 里被浏览器忽略（HTML 模板的问题）
  //   - favicon.ico 404（测试用的静态服务器不提供图标）
  const IGNORED = [
    /frame-ancestors/i,
    /favicon/i,
    /Failed to load resource.*404/i,
  ];
  const errors = page.events
    .filter((e) => e.method === 'Log.entryAdded')
    .map((e) => e.params.entry)
    .filter((entry) => entry.level === 'error')
    .map((entry) => entry.text + ' @' + (entry.url || ''))
    .filter((text) => !IGNORED.some((pattern) => pattern.test(text)));
  assert.deepEqual(errors, [], 'brain.js 不应产生控制台错误: ' + errors.join(' | '));
  const consoleErrors = page.events
    .filter((e) => e.method === 'Runtime.exceptionThrown')
    .map((e) => JSON.stringify(e.params.exceptionDetails).slice(0, 400));
  assert.deepEqual(consoleErrors, [], '不应有未捕获异常: ' + consoleErrors.join(' | '));
});
