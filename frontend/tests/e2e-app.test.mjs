/**
 * 端到端反馈环：真后端 + 演示数据 + 真前端 + 无头 Chrome。
 *
 *   cd frontend && npm test                      （全部前端测试，含本文件）
 *   node --test tests/e2e-app.test.mjs           （只跑本文件；先 npm run build）
 *   MEMORA_PYTHON=<python>  MEMORA_CHROME=<浏览器>  可覆盖默认解释器 / 浏览器
 *
 * 为什么有这个测试：1.0.0 的前端类型与页面代码和后端真实返回的形状漂移得面目全非——
 * 演示库 21 条记忆在总览显示 0、趋势图空白、冲突全是「缺少 A」、智能体行 "[object Object]"、
 * 模型超时设置被静默忽略、脑图页空白——而没有任何东西把真 UI 跑在真后端上。
 *
 * 做法：
 *   1. 临时目录 + tools/seed_demo.py 灌演示数据，用仓库里的后端起服务（空闲端口）；
 *   2. 无头 Chrome 依次打开 12 个路由，每页断言：没有未捕获异常 / 控制台错误，
 *      屏幕上的关键数字与同一时刻 API 的返回一致；枚举（记忆类型 / 状态 / 模型角色 / provider）
 *      直接从 memora_core 源码里的元组读取，后端改了而前端没跟上就会失败；
 *   3. 额外回归：mem:dispose 真正到达页面（resize 监听不泄漏）、"在线但降级"时不再每 8 秒
 *      轮询 /api/health、模型 timeout 以毫秒落库、Markdown 链接安全与解析代价有上限。
 * 找不到 Chrome 或 Python 时 skip 并写明原因（skip 不是通过）。
 */
import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { findChrome, launchChrome } from './cdp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const staticDir = path.join(repo, 'memora_core', 'static');
const PYTHON = process.env.MEMORA_PYTHON || 'python';
const PY_ENV = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function probePython() {
  const result = spawnSync(PYTHON, ['-c', 'import sys, sqlite3; sys.exit(0 if sys.version_info >= (3, 10) else 3)'], {
    cwd: repo, env: PY_ENV, encoding: 'utf8', timeout: 30000,
  });
  if (result.error) return 'Python 不可用（' + PYTHON + '：' + result.error.message + '）';
  if (result.status !== 0) return 'Python 无法运行或版本低于 3.10（' + PYTHON + '，exit ' + result.status + '）';
  return null;
}

const chromePath = findChrome();
const pythonProblem = chromePath ? probePython() : null;
const SKIP = chromePath === null
  ? '本机没有 Chrome/Edge（或 Node 缺少全局 WebSocket）；可用 MEMORA_CHROME 指定浏览器'
  : pythonProblem ? pythonProblem + '；可用 MEMORA_PYTHON 指定解释器' : false;

/** 从 memora_core 的 Python 源码里读一个字符串元组（后端是唯一真源）。 */
function pyTuple(file, name) {
  const text = fs.readFileSync(path.join(repo, 'memora_core', file), 'utf8');
  const found = new RegExp('^' + name + '(?:\\s*:[^=\\n]*)?\\s*=\\s*\\(([^)]*)\\)', 'm').exec(text);
  assert.ok(found, file + ' 里找不到 ' + name);
  return [...found[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]);
}

function localDayKey(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** 页面数字 → number（fmtNumber 用 zh-CN 千分位）。 */
const num = (text) => Number(String(text ?? '').replace(/[,\s]/g, ''));

let dataDir = null;
let server = null;
let serverLog = '';
let base = '';
let session = null;
let page = null;

async function api(urlPath) {
  const response = await fetch(base + urlPath);
  assert.equal(response.status, 200, 'GET ' + urlPath + ' → HTTP ' + response.status);
  return response.json();
}

before(async () => {
  if (SKIP) return;
  for (const file of ['app.js', 'app.css', 'brain.js', 'index.html', 'brain.html', 'katex.css']) {
    if (!fs.existsSync(path.join(staticDir, file))) {
      throw new Error('缺少 memora_core/static/' + file + '，请先运行 cd frontend && npm run build');
    }
  }
  dataDir = fs.mkdtempSync(path.join(tmpdir(), 'memora-e2e-'));
  const seed = spawnSync(PYTHON, ['tools/seed_demo.py', '--data', dataDir, '--reset'], {
    cwd: repo, env: PY_ENV, encoding: 'utf8', timeout: 180000,
  });
  assert.equal(seed.status, 0, 'tools/seed_demo.py 失败：' + String(seed.stderr || seed.stdout || seed.error || '').slice(-800));

  const port = await freePort();
  base = 'http://127.0.0.1:' + port;
  server = spawn(PYTHON, ['-m', 'memora_core', '--data', dataDir, 'serve', '--port', String(port)], {
    cwd: repo, env: PY_ENV, stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (chunk) => { serverLog += chunk.toString(); });
  server.stderr.on('data', (chunk) => { serverLog += chunk.toString(); });
  const started = Date.now();
  for (;;) {
    if (server.exitCode !== null) throw new Error('后端提前退出：' + serverLog.slice(-800));
    try {
      const response = await fetch(base + '/api/health');
      if (response.ok) break;
    } catch { /* 还没起来 */ }
    if (Date.now() - started > 45000) throw new Error('后端 45 秒内没有就绪：' + serverLog.slice(-800));
    await sleep(250);
  }

  session = await launchChrome(chromePath, base + '/#/overview', { match: (info) => info.url.startsWith(base) });
  page = session.page;
  await page.send('Network.enable');
  const booted = await page.until(() => !!document.querySelector('.shell') && !!document.querySelector('.page-overview'), [], 30000);
  assert.ok(booted, '首页 30 秒内没有渲染出总览');
});

after(async () => {
  if (session) await session.close();
  if (server && server.exitCode === null) {
    server.kill();
    await new Promise((resolve) => { server.once('exit', resolve); setTimeout(resolve, 5000); });
  }
  if (dataDir) {
    try { fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* Windows 上 SQLite 句柄可能稍晚释放 */ }
  }
});

/* ------------------------------------------------------------------ 页面辅助 */

/** 从某个事件下标起的所有报错（未捕获异常、console.error、控制台错误级日志）。 */
function errorsSince(mark) {
  const out = [];
  for (const event of page.events.slice(mark)) {
    if (event.method === 'Runtime.exceptionThrown') {
      const details = event.params.exceptionDetails;
      out.push('未捕获异常：' + ((details.exception && details.exception.description) || details.text));
    } else if (event.method === 'Runtime.consoleAPICalled' && event.params.type === 'error') {
      out.push('console.error：' + event.params.args.map((arg) => arg.value ?? arg.description ?? '').join(' '));
    } else if (event.method === 'Log.entryAdded' && event.params.entry.level === 'error') {
      const entry = event.params.entry;
      out.push('控制台错误：' + entry.text + ' @' + (entry.url || ''));
    }
  }
  return out;
}

async function visit(route, ready, readyArgs = []) {
  const mark = page.events.length;
  await page.run((hash) => { window.location.hash = hash; }, '#/' + route);
  const ok = await page.until(ready, readyArgs, 25000);
  if (!ok) {
    const text = await page.run(() => (document.querySelector('#content') || document.body).innerText.slice(0, 800)).catch(() => '');
    assert.fail('#/' + route + ' 25 秒内没有就绪；页面内容：' + text + '\n错误：' + errorsSince(mark).join(' | '));
  }
  return mark;
}

/** 每页通用断言：无报错、无漏渲染的占位文本、无危险 toast。 */
async function assertClean(route, mark) {
  await sleep(300);
  assert.deepEqual(errorsSince(mark), [], '#/' + route + ' 不应有报错');
  const problems = await page.run(() => {
    const text = document.querySelector('#content').innerText;
    const bad = ['[object Object]', 'undefined', 'NaN', 'Invalid Date'].filter((word) => text.includes(word));
    const danger = Array.from(document.querySelectorAll('#mem-toasts .toast-danger')).map((node) => node.textContent);
    const failed = Array.from(document.querySelectorAll('#content .error-state')).map((node) => node.textContent.slice(0, 200));
    return { bad, danger, failed };
  });
  assert.deepEqual(problems.bad, [], '#/' + route + ' 页面上出现了漏渲染的值');
  assert.deepEqual(problems.danger, [], '#/' + route + ' 弹出了错误 toast');
  assert.deepEqual(problems.failed, [], '#/' + route + ' 出现了错误态');
}

async function windowListenerCount(type) {
  const win = await page.send('Runtime.evaluate', { expression: 'window' });
  const result = await page.send('DOMDebugger.getEventListeners', { objectId: win.result.objectId });
  return result.listeners.filter((item) => item.type === type).length;
}

/* ------------------------------------------------------------------ 测试 */

test('e2e：12 个路由跑在真后端上，页面数字与 API 一致', { skip: SKIP, timeout: 300000 }, async (t) => {
  const MEMORY_KINDS = pyTuple('store.py', 'MEMORY_KINDS');
  const STATUSES = pyTuple('store.py', 'STATUSES');
  const ROLES = pyTuple('models.py', 'ROLES');
  const PROVIDERS = pyTuple('models.py', 'PROVIDERS');

  await t.test('overview：总数 / 今日 / 候选 / 作用域 / 趋势 / 智能体 / 角色', async () => {
    const mark = await visit('overview', () => !!document.querySelector('[data-stat="memories"] .stat-value')
      && !!document.querySelector('canvas.trend-canvas'));
    const ov = await api('/api/overview');
    const health = await api('/api/health');
    const shown = await page.run(() => {
      const text = (selector) => (document.querySelector(selector)?.textContent ?? '').trim();
      const dist = Array.from(document.querySelectorAll('.page-overview .dist-bars'));
      const canvas = document.querySelector('canvas.trend-canvas');
      return {
        memories: text('[data-stat="memories"] .stat-value'),
        today: text('[data-stat="today"] .stat-value'),
        candidates: text('[data-stat="candidates"] .stat-value'),
        agents: text('[data-stat="agents"] .stat-value'),
        scopes: text('.inventory-item[data-stat="scopes"] strong'),
        documents: text('.inventory-item[data-stat="documents"] strong'),
        conflicts: text('.inventory-item[data-stat="conflicts_open"] strong'),
        kindRows: dist[0] ? dist[0].querySelectorAll('.dist-row').length : -1,
        scopeRows: dist[1] ? dist[1].querySelectorAll('.dist-row').length : -1,
        scopeKeys: dist[1] ? Array.from(dist[1].querySelectorAll('.dist-label')).map((node) => node.getAttribute('title')) : [],
        trend: canvas ? {
          points: Number(canvas.dataset.points), total: Number(canvas.dataset.total),
          active: Number(canvas.dataset.active), height: canvas.getBoundingClientRect().height,
        } : null,
        agentRows: Array.from(document.querySelectorAll('.list-row[data-agent]')).map((node) => ({
          id: node.dataset.agent, sub: node.querySelector('.row-sub').textContent,
        })),
        roleChips: Array.from(document.querySelectorAll('.role-chip[data-role]')).map((node) => node.dataset.role),
      };
    });
    const totals = ov.totals;
    assert.ok(totals.memories > 0, '演示库应当有记忆');
    assert.equal(num(shown.memories), totals.memories, '记忆总数');
    assert.equal(num(shown.candidates), totals.candidates, '待审候选');
    assert.equal(num(shown.scopes), totals.scopes, '作用域数');
    assert.equal(num(shown.documents), totals.documents, '文档数');
    assert.equal(num(shown.conflicts), totals.conflicts_open, '未决冲突');
    const today = localDayKey(new Date());
    const todayBucket = (ov.daily || []).find((item) => item.day === today);
    assert.equal(num(shown.today), todayBucket ? todayBucket.count : 0, '今日新增 = daily 里本地今天那一桶');
    const scopes = ov.by_scope.filter((item) => item.count > 0);
    assert.equal(shown.scopeRows, Math.min(8, scopes.length), '按作用域的行数');
    assert.deepEqual(shown.scopeKeys, scopes.slice(0, 8).map((item) => item.scope_id), '按作用域的键');
    assert.equal(shown.kindRows, Math.min(10, Object.values(ov.by_kind).filter((count) => count > 0).length), '按类型的行数');
    const windowStart = new Date();
    windowStart.setDate(windowStart.getDate() - 29);
    const startKey = localDayKey(windowStart);
    const inWindow = ov.daily.filter((item) => item.day >= startKey);
    assert.ok(shown.trend, '应当有趋势图');
    assert.equal(shown.trend.points, 30, '趋势图 30 个点');
    assert.equal(shown.trend.total, inWindow.reduce((acc, item) => acc + item.count, 0), '趋势图总数 = 窗口内 daily 之和');
    assert.equal(shown.trend.active, inWindow.filter((item) => item.count > 0).length, '趋势图有数据的天数');
    assert.ok(shown.trend.active > 0 && shown.trend.height > 50, '趋势图应当有点、有高度');
    const online = ov.agents.filter((agent) => agent.status === 'online').length;
    assert.equal(shown.agents, online + '/' + ov.agents.length, '在线智能体');
    assert.ok(shown.agentRows.length > 0, '应当列出智能体');
    for (const row of shown.agentRows) {
      const agent = ov.agents.find((item) => item.id === row.id);
      assert.ok(agent, '未知智能体 ' + row.id);
      assert.equal(row.sub, agent.sessions.total + ' 会话 · ' + agent.memories.total + ' 记忆', '智能体行 ' + row.id);
    }
    assert.deepEqual(shown.roleChips.slice().sort(), Object.keys(health.models).sort(), '模型角色');
    assert.deepEqual(shown.roleChips.slice().sort(), ROLES.slice().sort(), '模型角色 = models.ROLES');
    await assertClean('overview', mark);
  });

  await t.test('mem:dispose 到达页面：离开总览后 resize 监听被移除', async () => {
    await visit('memories', () => !!document.querySelector('.detail-title'));
    const away = await windowListenerCount('resize');
    await visit('overview', () => !!document.querySelector('canvas.trend-canvas'));
    const onOverview = await windowListenerCount('resize');
    await visit('memories', () => !!document.querySelector('.detail-title'));
    const backAway = await windowListenerCount('resize');
    assert.equal(onOverview, away + 1, '总览挂载时应当正好多一个 resize 监听');
    assert.equal(backAway, away, '离开总览后 resize 监听应当被移除（1.0.0 会一直累积）');
  });

  await t.test('memories：列表 / 详情 / 枚举与 store 一致', async () => {
    const mark = await visit('memories', () => document.querySelectorAll('.memo-item').length > 0 && !!document.querySelector('.detail-title'));
    const list = await api('/api/memories?limit=100&sort=recorded_at&order=desc');
    const shown = await page.run(() => {
      const selects = Array.from(document.querySelectorAll('.list-toolbar select'));
      const values = (node) => (node ? Array.from(node.options).map((opt) => opt.value).filter(Boolean) : []);
      return {
        meta: document.querySelector('.list-meta').textContent,
        first: document.querySelector('.memo-item .memo-title').textContent,
        detail: document.querySelector('.detail-title').textContent,
        metaRow: document.querySelector('.detail-meta-row').textContent,
        kinds: values(selects[0]),
        statuses: values(selects[1]),
      };
    });
    assert.equal(shown.meta, Math.min(100, list.total) + ' / ' + list.total + ' 条');
    assert.equal(shown.first, list.items[0].title, '列表第一条（recorded_at 倒序）');
    assert.equal(shown.detail, list.items[0].title, '默认选中第一条');
    assert.ok(!/入库 —/.test(shown.metaRow), '入库时间应当来自 recorded_at：' + shown.metaRow);
    assert.deepEqual(shown.kinds, MEMORY_KINDS, '类型过滤 = store.MEMORY_KINDS');
    assert.deepEqual(shown.statuses, STATUSES, '状态过滤 = store.STATUSES');
    await assertClean('memories', mark);
  });

  await t.test('documents：目录树 / 原文 / 切块数', async () => {
    const docs = await api('/api/documents?limit=500');
    const mark = await visit('documents', () => document.querySelectorAll('.tree-file').length > 0
      && !!document.querySelector('.raw-pre'));
    const first = docs.items[0];
    const detail = await api('/api/documents/' + encodeURIComponent(first.id));
    const raw = await (await fetch(base + '/api/documents/' + encodeURIComponent(first.id) + '/raw')).text();
    const shown = await page.run(() => ({
      files: document.querySelectorAll('.tree-file').length,
      raw: document.querySelector('.raw-pre').textContent,
      badges: document.querySelector('.detail-badges').textContent,
    }));
    assert.equal(shown.files, docs.items.length, '目录树文件数');
    assert.equal(shown.raw, raw, '原文来自 /raw');
    assert.ok(shown.badges.includes(detail.chunks.length + ' 块'), '切块数：' + shown.badges);
    await assertClean('documents', mark);
  });

  for (const route of ['search?q=RRF', 'workflows', 'runs']) {
    await t.test(route + '：渲染且无报错', async () => {
      const id = route.split('?')[0];
      const mark = await visit(route, (pageId) => {
        const mount = document.querySelector('.page-mount[data-page="' + pageId + '"]');
        return !!mount && mount.children.length > 0 && !mount.querySelector('.skeleton');
      }, [id]);
      await sleep(1200);
      await assertClean(route, mark);
    });
  }

  await t.test('agents：卡片数与会话 / 记忆数', async () => {
    const agents = await api('/api/agents');
    const mark = await visit('agents', () => document.querySelectorAll('.agent-card[data-agent]').length > 0);
    const cards = await page.run(() => Array.from(document.querySelectorAll('.agent-card[data-agent]')).map((node) => ({
      id: node.dataset.agent,
      name: node.querySelector('.agent-name').textContent,
      sessions: node.querySelector('[data-stat="sessions"]').textContent,
      memories: node.querySelector('[data-stat="memories"]').textContent,
    })));
    assert.equal(cards.length, agents.total, '智能体卡片数');
    for (const card of cards) {
      const agent = agents.items.find((item) => item.id === card.id);
      assert.ok(agent, '未知智能体 ' + card.id);
      assert.equal(card.name, agent.display_name, '显示名');
      assert.equal(num(card.sessions), agent.sessions.total, card.id + ' 会话数');
      assert.equal(num(card.memories), agent.memories.total, card.id + ' 记忆数');
    }
    await assertClean('agents', mark);
  });

  await t.test('models：6 个角色、provider 与后端一致、timeout 以毫秒落库', async () => {
    const mark = await visit('models', () => document.querySelectorAll('.card[data-role]').length > 0);
    const shown = await page.run(() => ({
      roles: Array.from(document.querySelectorAll('.card[data-role]')).map((node) => node.dataset.role),
      providers: Array.from(document.querySelector('.card[data-role="chat"] .model-form select').options).map((opt) => opt.value),
    }));
    assert.deepEqual(shown.roles, ROLES, '角色 = models.ROLES');
    assert.deepEqual(shown.providers, PROVIDERS, 'provider = models.PROVIDERS');
    await page.run(() => {
      const card = document.querySelector('.card[data-role="chat"]');
      const field = (label) => Array.from(card.querySelectorAll('label.field'))
        .find((node) => node.querySelector('.field-label').textContent.startsWith(label)).querySelector('input, select');
      const set = (label, value) => {
        const input = field(label);
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      };
      set('base_url', 'http://127.0.0.1:9/v1');
      set('model', 'e2e-model');
      set('timeout', '7');
      Array.from(card.querySelectorAll('.card-actions button')).find((btn) => btn.textContent.includes('保存')).click();
    });
    let saved = null;
    for (let attempt = 0; attempt < 40 && !saved; attempt++) {
      const state = await api('/api/models');
      saved = state.profiles.find((item) => item.role === 'chat' && item.model === 'e2e-model') || null;
      if (!saved) await sleep(250);
    }
    assert.ok(saved, '保存后 /api/models 应当出现 chat 档位');
    assert.equal(saved.timeout_ms, 7000, 'timeout 7 秒应当落库为 timeout_ms=7000（1.0.0 发 timeout，被忽略为 60000）');
    const reloaded = await page.until(() => {
      const card = document.querySelector('.card[data-role="chat"]');
      const label = card && Array.from(card.querySelectorAll('label.field')).find((node) => node.querySelector('.field-label').textContent.startsWith('timeout'));
      return !!label && label.querySelector('input').value === '7' && (card.querySelector('.card-subtitle')?.textContent ?? '').includes('chat-e2e-model');
    });
    assert.ok(reloaded, '重新加载后表单应当回显已保存的档位与 7 秒超时');
    await assertClean('models', mark);
  });

  await t.test('algorithms：卡片数、公式真的由 KaTeX 渲染、katex.css 按需加载', async () => {
    const algos = await api('/api/algorithms');
    const mark = await visit('algorithms', () => document.querySelectorAll('.algo-card').length > 0);
    const cssReady = await page.until(() => {
      const link = document.querySelector('link[data-katex]');
      return !!link && !!link.sheet && link.sheet.cssRules.length > 50;
    });
    assert.ok(cssReady, '渲染公式后应当按需加载 /katex.css');
    const shown = await page.run(() => ({
      cards: document.querySelectorAll('.algo-card').length,
      katex: document.querySelectorAll('.algo-card .algo-formula .katex').length,
    }));
    assert.equal(shown.cards, algos.total, '算法卡片数');
    assert.equal(shown.katex, algos.items.filter((item) => item.formula).length, '每个公式都由 KaTeX 渲染');
    await assertClean('algorithms', mark);
  });

  await t.test('graph：iframe 内脑图真的画出来，?view 与 ?focus 生效', async () => {
    const semantic = await api('/api/graph?view=semantic&limit=2000');
    const hierarchy = await api('/api/graph?view=hierarchy&limit=2000');
    const brainReady = (needle) => {
      const frame = document.querySelector('iframe.brain-frame');
      if (!frame || !frame.getAttribute('src').includes(needle)) return false;
      const brain = frame.contentWindow && frame.contentWindow.__memBrain;
      return !!(brain && brain.__ready && brain.__debug.ready && brain.__debug.calls > 0);
    };
    const snapshot = () => {
      const frame = document.querySelector('iframe.brain-frame');
      const win = frame.contentWindow;
      const debug = win.__memBrain.__debug;
      const canvas = win.document.querySelector('canvas.mem-brain-canvas');
      const rect = canvas.getBoundingClientRect();
      return {
        src: frame.getAttribute('src'), view: debug.view, demo: debug.demo, nodes: debug.nodes, calls: debug.calls,
        lastFetch: debug.lastFetch, selection: debug.selection, status: debug.status,
        canvasHeight: rect.height, canvasWidth: rect.width, hash: window.location.hash,
        pixels: win.__memBrain.__exportDataUrl().length,
      };
    };
    const mark = await visit('graph', brainReady, ['view=semantic']);
    const first = await page.run(snapshot);
    assert.equal(first.view, 'semantic');
    assert.equal(first.demo, false, '后端在线时不应显示演示数据');
    assert.equal(first.lastFetch.view, 'semantic');
    assert.equal(first.lastFetch.ok, true);
    assert.equal(first.nodes, semantic.nodes.length, '语义视图节点数 = /api/graph');
    assert.ok(first.canvasHeight > 100 && first.canvasWidth > 100, '画布应当有真实尺寸（1.0.0 高度为 0）：' + first.canvasHeight);
    assert.ok(first.calls > 0 && first.pixels > 20000, '应当真的画出了东西');

    await page.run(() => {
      Array.from(document.querySelectorAll('.page-graph .chip-btn')).find((btn) => btn.textContent === '层级').click();
    });
    assert.ok(await page.until(brainReady, ['view=hierarchy'], 25000), '切到层级视图后脑图应当重新就绪');
    const second = await page.run(snapshot);
    assert.equal(second.view, 'hierarchy', '?view=hierarchy 应当生效（1.0.0 永远是 semantic）');
    assert.equal(second.lastFetch.view, 'hierarchy', '应当真的去拉 hierarchy 视图');
    assert.equal(second.lastFetch.ok, true);
    assert.equal(second.demo, false);
    assert.equal(second.nodes, hierarchy.nodes.length, '层级视图节点数 = /api/graph?view=hierarchy');
    assert.ok(second.hash.includes('view=hierarchy'), '视图应当写回地址栏：' + second.hash);

    const focusNode = semantic.nodes.find((node) => node.kind === 'memory');
    await visit('graph?focus=' + encodeURIComponent(focusNode.id), brainReady, ['focus=']);
    const focused = await page.until(() => {
      const frame = document.querySelector('iframe.brain-frame');
      return frame.contentWindow.__memBrain.__debug.selection >= 0;
    }, [], 10000);
    const third = await page.run(snapshot);
    assert.ok(focused, '?focus=<记忆 id> 应当选中该节点；状态：' + third.status);
    await assertClean('graph', mark);
  });

  await t.test('conflicts：两侧标题来自记忆、冲突分与摘要', async () => {
    const conflicts = await api('/api/conflicts?status=open&limit=200');
    const mark = await visit('conflicts', () => document.querySelectorAll('.conflict-card').length > 0
      || !!document.querySelector('.page-conflicts .empty-state'));
    const cards = await page.run(() => Array.from(document.querySelectorAll('.conflict-card')).map((node) => ({
      id: node.dataset.conflict,
      sideA: node.querySelector('[data-side="A"] .conflict-title').textContent,
      sideB: node.querySelector('[data-side="B"] .conflict-title').textContent,
      text: node.textContent,
    })));
    assert.equal(cards.length, conflicts.items.length, '冲突卡片数');
    assert.ok(cards.length > 0, '演示库应当有未决冲突');
    for (const card of cards) {
      const item = conflicts.items.find((entry) => entry.id === card.id);
      assert.ok(item, '未知冲突 ' + card.id);
      assert.equal(card.sideA, (await api('/api/memories/' + encodeURIComponent(item.a_id))).title, 'A 侧标题');
      assert.equal(card.sideB, (await api('/api/memories/' + encodeURIComponent(item.b_id))).title, 'B 侧标题');
      assert.ok(!card.text.includes('缺少'), '不应再出现「缺少 A/B」');
      assert.ok(card.text.includes('冲突分 ' + item.score.toFixed(2)), '冲突分');
      if (item.detail && item.detail.summary) assert.ok(card.text.includes(item.detail.summary), '摘要来自 detail.summary');
    }
    await assertClean('conflicts', mark);
  });

  await t.test('settings：运行参数如实展示', async () => {
    const settings = await api('/api/settings');
    const mark = await visit('settings', () => !!document.querySelector('.kv-row[data-setting="data_dir"]'));
    const shown = await page.run(() => ({
      dataDir: document.querySelector('.kv-row[data-setting="data_dir"] .kv-value').textContent,
      listen: document.querySelector('.kv-row[data-setting="listen"] .kv-value').textContent,
    }));
    assert.equal(shown.dataDir, settings.runtime.data_dir);
    assert.equal(shown.listen, settings.runtime.host + ':' + settings.runtime.port);
    await assertClean('settings', mark);
  });

  await t.test('在线但降级（未配全模型）时不再每 8 秒轮询 /api/health', async () => {
    const health = await api('/api/health');
    assert.ok(Array.isArray(health.degraded), 'health.degraded 应当是列表');
    const state = await page.run(() => document.getElementById('conn-text').textContent);
    assert.ok(/已连接|降级/.test(state), '侧栏应当显示已连接：' + state);
    const mark = page.events.length;
    await sleep(9500);
    const polls = page.events.slice(mark).filter((event) => event.method === 'Network.requestWillBeSent'
      && /\/api\/health(\?|$)/.test(event.params.request.url));
    assert.equal(polls.length, 0, '9.5 秒空闲内不应请求 /api/health（1.0.0 因 Boolean([]) 为真而每 8 秒一次）');
  });

  await t.test('markdown：链接安全、价格不是公式、行内 $$、病态输入有代价上限', async () => {
    const body = [
      '链接：[协议相对](//example.org/x) [反斜杠](/\\example.org/y) [站内](/#/overview) [外站](https://example.org/z) [脚本](javascript:alert(1))',
      '',
      '价格：$5 和 $10 都不是公式；行内公式 $a+b$ 是。',
      '',
      '行内块公式 $$x^2$$ 结束。',
      '',
      '```js 多余文字',
      '这一行曾让段落解析原地死循环',
      '',
      '>'.repeat(3000) + ' 深引用',
      '',
      '['.repeat(20000) + '*'.repeat(20000) + '$a '.repeat(8000),
    ].join('\n');
    const created = await page.run(async (payload) => {
      const response = await fetch('/api/memories', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      return { status: response.status, json: await response.json() };
    }, { title: 'e2e 渲染回归', kind: 'fact', scope_id: 'global', body });
    assert.equal(created.status, 201, '创建测试记忆：' + JSON.stringify(created.json).slice(0, 300));
    const id = created.json.id;
    const started = Date.now();
    const mark = await visit('memories?id=' + encodeURIComponent(id), (title) => {
      const node = document.querySelector('.detail-title');
      return !!node && node.textContent === title && !!document.querySelector('.detail-body-card .markdown-body p');
    }, ['e2e 渲染回归']);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 5000, '病态正文应当在 5 秒内渲染完（1.0.0 平方级扫描 + 数千个公式），实际 ' + elapsed + 'ms');
    const shown = await page.run(() => {
      const root = document.querySelector('.detail-body-card .markdown-body');
      const links = Array.from(root.querySelectorAll('a')).map((anchor) => ({
        text: anchor.textContent, href: anchor.href, target: anchor.getAttribute('target'), rel: anchor.getAttribute('rel') || '',
      }));
      const price = Array.from(root.querySelectorAll('p')).find((node) => node.textContent.includes('价格'));
      let depth = 0;
      for (let node = root.querySelector('blockquote'); node; node = node.querySelector(':scope > blockquote')) depth += 1;
      return {
        origin: window.location.origin,
        links,
        blocked: Array.from(root.querySelectorAll('.md-link-blocked')).map((node) => node.textContent),
        priceMath: price ? price.querySelectorAll('.math-inline').length : -1,
        priceText: price ? price.textContent : '',
        displayInline: root.querySelectorAll('.math-inline-display .katex-display').length,
        depth,
      };
    });
    for (const link of shown.links) {
      const sameOrigin = new URL(link.href).origin === shown.origin;
      if (!sameOrigin) {
        assert.equal(link.target, '_blank', '他源链接必须新窗口打开：' + link.href);
        assert.ok(link.rel.includes('noopener'), '他源链接必须 noopener：' + link.href);
      }
    }
    const byText = (text) => shown.links.find((link) => link.text === text);
    assert.equal(new URL(byText('协议相对').href).host, 'example.org');
    assert.equal(byText('协议相对').target, '_blank', '//example.org 不能当站内链接');
    assert.equal(new URL(byText('反斜杠').href).host, 'example.org');
    assert.equal(byText('反斜杠').target, '_blank', '/\\example.org 不能当站内链接');
    assert.equal(byText('站内').target, null, '同源链接在应用内打开');
    assert.ok(!byText('脚本') && shown.blocked.includes('脚本'), 'javascript: 链接必须禁用');
    assert.equal(shown.priceMath, 1, '只有 $a+b$ 是公式：' + shown.priceText);
    assert.ok(shown.priceText.includes('$5 和 $10'), '价格按原文显示：' + shown.priceText);
    assert.ok(shown.displayInline >= 1, '行内 $$…$$ 按 display 模式渲染');
    assert.ok(shown.depth <= 9, '引用嵌套有上限，实际 ' + shown.depth);
    await assertClean('memories?id=' + id, mark);
  });
});
