/**
 * 无头 Chrome + CDP 的极简工具（e2e-app.test.mjs 用；不是测试文件本身）。
 *
 * 浏览器查找顺序与 brain-render.test.mjs 一致：MEMORA_CHROME → 系统级 Chrome →
 * 「仅为我安装」的 %LOCALAPPDATA% Chrome → Edge → Linux / macOS 常见路径。
 * 需要 Node 22+（全局 WebSocket）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';

const CHROME_CANDIDATES = [
  ...(process.env.MEMORA_CHROME ? [process.env.MEMORA_CHROME] : []),
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ...(process.env.LOCALAPPDATA ? [path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')] : []),
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

export function findChrome() {
  if (typeof WebSocket === 'undefined') return null;
  for (const candidate of CHROME_CANDIDATES) {
    try { if (fs.existsSync(candidate)) return candidate; } catch { /* 无权限就跳过 */ }
  }
  return null;
}

export class Cdp {
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

  /** 在页面里求值并拿回 JSON（支持 Promise）。 */
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

  /** 把一个普通函数连同 JSON 参数送进页面执行。 */
  run(fn, ...args) {
    return this.evaluate('(' + fn.toString() + ')(' + args.map((arg) => JSON.stringify(arg)).join(',') + ')');
  }

  /** 轮询直到 fn(...args) 为真；超时返回 false。 */
  async until(fn, args = [], timeoutMs = 20000, interval = 150) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      try {
        if (await this.run(fn, ...args)) return true;
      } catch { /* 页面可能正在切换 */ }
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
    return false;
  }
}

/**
 * 启动无头 Chrome 打开 url，并接到匹配的 page target 上。
 * SwiftShader 软件光栅化：headless 没有真 GPU，脑图的 WebGL 走真实的 GL 管线。
 */
export async function launchChrome(chromePath, url, { match = () => true, windowSize = '1440,900' } = {}) {
  const userDataDir = fs.mkdtempSync(path.join(tmpdir(), 'memora-cdp-'));
  const args = [
    '--headless=new',
    '--remote-debugging-port=0',
    '--user-data-dir=' + userDataDir,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--window-size=' + windowSize,
    '--hide-scrollbars',
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
      const found = buffer.match(/DevTools listening on (ws:\/\/\S+)/);
      if (found) { clearTimeout(timer); resolve(found[1]); }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error('Chrome 提前退出 code=' + code + ' ' + buffer.slice(-600)));
    });
  });
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  const browser = new Cdp(ws, null);
  let target = null;
  for (let attempt = 0; attempt < 80 && !target; attempt++) {
    const targets = await browser.send('Target.getTargets');
    target = targets.targetInfos.find((info) => info.type === 'page' && match(info));
    if (!target) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!target) throw new Error('找不到目标页面: ' + url);
  const attached = await browser.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  const page = new Cdp(ws, attached.sessionId);
  page.events = browser.events;
  await page.send('Runtime.enable');
  await page.send('Log.enable');
  await page.send('Page.enable');
  return {
    child,
    browser,
    page,
    async close() {
      try { ws.close(); } catch { /* 已关闭 */ }
      if (child.exitCode === null) {
        child.kill();
        await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 3000); });
      }
      try { fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* Windows 句柄可能还没释放 */ }
    },
  };
}
