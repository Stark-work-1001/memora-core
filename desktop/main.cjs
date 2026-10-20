// -*- coding: utf-8 -*-
// memora-core 桌面外壳主进程：单实例、窗口、托盘、后端生命周期、探活、优雅退出。

'use strict';

const {
  app, BrowserWindow, Menu, Tray, ipcMain, shell, clipboard,
  nativeImage, dialog, session,
} = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');

// --------------------------------------------------------------------------- //
// 常量
// --------------------------------------------------------------------------- //
const APP_ID = 'app.memora.core';
const IS_DEV = !app.isPackaged;
const REPO_ROOT = path.resolve(__dirname, '..');
const HEALTH_INTERVAL_MS = 250;
const HEALTH_TIMEOUT_MS = 60000;
const KILL_GRACE_MS = 3000;
const DEFAULT_PORT = 8790;
const HOST = '127.0.0.1';

// --------------------------------------------------------------------------- //
// 全局状态
// --------------------------------------------------------------------------- //
let mainWindow = null;
let splashWindow = null;
let splashLoaded = false;
let pendingSplash = null;
let tray = null;
let backendPort = 0;
let backendChild = null;
let backendReady = false;
let backendCrashCount = 0;
let restarting = false;
let quitting = false;
let quitFinished = false;
let starting = null;
let startGeneration = 0;

// --------------------------------------------------------------------------- //
// 路径
// --------------------------------------------------------------------------- //
function repoRoot() {
  return REPO_ROOT;
}

/** 生产：<userData>/data；开发：仓库 data/ */
function dataDir() {
  return IS_DEV ? path.join(REPO_ROOT, 'data') : path.join(app.getPath('userData'), 'data');
}

function docsDir() {
  return path.join(dataDir(), 'vault');
}

// --------------------------------------------------------------------------- //
// 来源判定（导航闸、IPC 发送方校验、权限）
// --------------------------------------------------------------------------- //
function appOrigin() {
  return backendPort ? 'http://' + HOST + ':' + backendPort : '';
}

function isAppUrl(url) {
  try { return Boolean(appOrigin()) && new URL(url).origin === appOrigin(); } catch (err) { return false; }
}

function isErrorPage(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'file:' && decodeURIComponent(u.pathname).replace(/\\/g, '/').endsWith('/error.html');
  } catch (err) { return false; }
}

function openExternalSafe(url) {
  if (!/^(https?:|mailto:)/i.test(String(url || ''))) return;
  // 自检钩子（与 MEMORA_SELFTEST_QUIT_MS 同类）：自动化验证导航闸时只记日志，不真的打开系统浏览器
  if (process.env.MEMORA_SELFTEST_NO_EXTERNAL) { logEvent('（自检）将交给系统浏览器：' + String(url).slice(0, 200)); return; }
  shell.openExternal(url).catch(function () { /* ignore */ });
}

/** 只有本机后端页面和本外壳的错误页可以调用 preload 桥。 */
function trustedSender(event) {
  const frame = event && event.senderFrame;
  const url = frame ? frame.url : '';
  return isAppUrl(url) || isErrorPage(url);
}

function guardIpc(handler) {
  return function (event) {
    if (!trustedSender(event)) {
      logEvent('拒绝来自非本机页面的 IPC 调用：' + String(event && event.senderFrame ? event.senderFrame.url : '?').slice(0, 200));
      throw new Error('IPC 调用方不受信任');
    }
    return handler.apply(null, arguments);
  };
}

/** 主窗口的权限：只放行剪贴板写入（复制 id 用），其余一律拒绝。Electron 默认全部同意。 */
function installPermissionPolicy() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler(function (wc, permission, callback, details) {
    const url = (details && details.requestingUrl) || (wc ? wc.getURL() : '');
    callback(permission === 'clipboard-sanitized-write' && isAppUrl(url));
  });
  ses.setPermissionCheckHandler(function (_wc, permission, origin) {
    return permission === 'clipboard-sanitized-write' && isAppUrl(String(origin || '') + '/');
  });
}

function logsDir() {
  return path.join(app.getPath('userData'), 'logs');
}

function backendLogPath() {
  return path.join(logsDir(), 'backend.log');
}

function backendExePath() {
  // MEMORA_BACKEND_EXE 可指向另一个后端可执行文件（自检 / 灰度替换用）
  if (process.env.MEMORA_BACKEND_EXE) return process.env.MEMORA_BACKEND_EXE;
  return path.join(process.resourcesPath, 'backend', 'memora-backend.exe');
}

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    // 只记录，不阻断：目录不可写时由后端自己报错
    console.error('[memora] 创建目录失败:', dir, err && err.message);
  }
}

function pythonCommand() {
  if (process.env.MEMORA_PYTHON) return process.env.MEMORA_PYTHON;
  return process.platform === 'win32' ? 'python' : 'python3';
}

// --------------------------------------------------------------------------- //
// 启动画面状态
// --------------------------------------------------------------------------- //
function setSplash(text, detail) {
  const payload = { text: String(text || ''), detail: String(detail || '') };
  if (!splashWindow || splashWindow.isDestroyed()) return;
  if (!splashLoaded) {
    pendingSplash = payload;
    return;
  }
  const js = 'window.memoraSetStatus(' + JSON.stringify(payload.text) + ',' + JSON.stringify(payload.detail) + ');';
  splashWindow.webContents.executeJavaScript(js, true).catch(function () { /* 画布已销毁，忽略 */ });
}

function createSplash() {
  splashWindow = new BrowserWindow({
    width: 460,
    height: 300,
    resizable: false,
    movable: true,
    frame: false,
    show: false,
    center: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: '#0b0f14',
    title: '记忆中枢',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  splashWindow.once('ready-to-show', function () {
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.show();
  });
  splashWindow.webContents.on('did-finish-load', function () {
    splashLoaded = true;
    if (pendingSplash) {
      const p = pendingSplash;
      pendingSplash = null;
      setSplash(p.text, p.detail);
    }
  });
  splashWindow.loadFile(path.join(__dirname, 'splash.html')).catch(function (err) {
    console.error('[memora] 启动画面加载失败:', err && err.message);
  });
}

function destroySplash() {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.destroy();
  }
  splashWindow = null;
  splashLoaded = false;
  pendingSplash = null;
}

// --------------------------------------------------------------------------- //
// 端口探测与健康检查
// --------------------------------------------------------------------------- //
function isPortFree(port) {
  return new Promise(function (resolve) {
    const srv = net.createServer();
    srv.once('error', function () { resolve(false); });
    srv.once('listening', function () {
      srv.close(function () { resolve(true); });
    });
    srv.listen(port, HOST);
  });
}

function freePort() {
  return new Promise(function (resolve, reject) {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, HOST, function () {
      const port = srv.address().port;
      srv.close(function () { resolve(port); });
    });
  });
}

async function pickPort() {
  const preferred = Number(process.env.MEMORA_PORT || DEFAULT_PORT);
  if (Number.isInteger(preferred) && preferred > 0 && await isPortFree(preferred)) return preferred;
  return await freePort();
}

function checkHealth(port) {
  return new Promise(function (resolve) {
    // lite=1：就绪探针不数行、不扫完整性（1.0.0 每次探活都跑完整 integrity_check，库到 ~0.4 GB 就超时起不来）
    const req = http.get({ host: HOST, port: port, path: '/api/health?lite=1', timeout: 1500 }, function (res) {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', function () { resolve(false); });
    req.on('timeout', function () { req.destroy(); resolve(false); });
  });
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

/** 轮询 /api/health：250ms 一次，最长 60s。 */
async function waitForHealth(port, child) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (quitting) return false;
    // 进程已经退出就立刻放弃，而不是把 60s 耗满
    if (child && child.exitCode !== null) return false;
    if (await checkHealth(port)) return true;
    await sleep(HEALTH_INTERVAL_MS);
  }
  return false;
}

// --------------------------------------------------------------------------- //
// 后端进程
// --------------------------------------------------------------------------- //
function appendLog(chunk) {
  try {
    fs.appendFileSync(backendLogPath(), chunk);
  } catch (err) {
    // 日志写不进去也不能影响主流程
  }
}

/** 记录一条带时间戳的生命周期事件（便于无头排查）。 */
function logEvent(message) {
  appendLog('[memora] ' + new Date().toISOString() + ' ' + message + '\n');
}

function backendSpec(port) {
  const data = dataDir();
  if (IS_DEV) {
    // 开发模式：python -m memora_core --data <repo>/data serve --port <port>（cwd=仓库根）
    return {
      command: pythonCommand(),
      args: ['-m', 'memora_core', '--data', data, 'serve', '--port', String(port), '--host', HOST],
      cwd: REPO_ROOT,
    };
  }
  // 生产：backend/memora-backend.exe serve --port N --data <userData>/data
  // （entry_backend.py 会把 --data 归位到子命令前，两种顺序都能解析）
  return {
    command: backendExePath(),
    args: ['serve', '--port', String(port), '--data', data, '--host', HOST],
    cwd: path.dirname(backendExePath()),
  };
}

function spawnBackend(port) {
  const spec = backendSpec(port);
  if (!IS_DEV && !fs.existsSync(spec.command)) {
    throw new Error('未找到后端可执行文件：' + spec.command);
  }
  ensureDir(logsDir());
  ensureDir(dataDir());
  appendLog('\n===== ' + new Date().toISOString() + ' 启动后端 ' + spec.command + ' ' + spec.args.join(' ') + ' =====\n');

  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: Object.assign({}, process.env, {
      MEMORA_HOME: dataDir(),
      MEMORA_PORT: String(port),
      PYTHONIOENCODING: 'utf-8',
      PYTHONUNBUFFERED: '1',
    }),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', function (buf) { appendLog(buf); });
  child.stderr.on('data', function (buf) { appendLog(buf); });
  child.on('error', function (err) {
    appendLog('[memora] 后端进程错误: ' + (err && err.stack ? err.stack : String(err)) + '\n');
  });
  child.on('exit', function (code, signal) {
    appendLog('[memora] 后端退出 code=' + code + ' signal=' + signal + '\n');
    if (backendChild === child) backendChild = null;
    if (quitting || restarting) return;
    backendReady = false;
    handleBackendCrash(code, signal);
  });
  return child;
}

function handleBackendCrash(code, signal) {
  backendCrashCount += 1;
  logEvent('后端意外退出 code=' + code + (signal ? ' signal=' + signal : '') +
    '（第 ' + backendCrashCount + ' 次）');
  // 作废仍在等待中的启动流程，否则重启会复用那个悬空的 promise 而不会真正重新拉起进程
  starting = null;
  startGeneration += 1;
  if (backendCrashCount <= 1) {
    setSplash('后端意外退出，正在重启…', '退出码 ' + code + (signal ? ' / ' + signal : ''));
    statusToWindow('后端意外退出，正在自动重启…');
    setTimeout(function () {
      startBackend().then(function (baseUrl) {
        // 重启后端口可能变了：主窗口要跟过去（1.0.0 只在手动重启时这样做，自动重启后界面指向旧端口）
        if (mainWindow && !mainWindow.isDestroyed() && baseUrl) {
          return mainWindow.loadURL(baseUrl);
        }
        return null;
      }).catch(function (err) {
        if (err && err.superseded) return;
        showErrorPage(err.message || String(err));
      });
    }, 600);
    return;
  }
  showErrorPage('后端连续两次启动失败（退出码 ' + code + '）。可查看日志定位原因。');
}

async function startBackend() {
  if (starting) return starting;
  const gen = ++startGeneration;
  const run = (async function () {
    ensureDir(dataDir());
    ensureDir(logsDir());
    backendPort = await pickPort();
    const baseUrl = 'http://' + HOST + ':' + backendPort;
    setSplash('正在启动记忆中枢…', '端口 ' + backendPort);
    const child = spawnBackend(backendPort);
    backendChild = child;
    setSplash('正在等待后端就绪…', '探活 ' + baseUrl + '/api/health');
    const ok = await waitForHealth(backendPort, child);
    if (gen !== startGeneration) {
      const stale = new Error('本次启动已被新的重启取代');
      stale.superseded = true;
      throw stale;
    }
    if (!ok) {
      throw new Error('后端在 ' + Math.round(HEALTH_TIMEOUT_MS / 1000) + ' 秒内未就绪：' + baseUrl + '/api/health');
    }
    backendReady = true;
    backendCrashCount = 0;
    logEvent('后端就绪 ' + baseUrl);
    return baseUrl;
  })();
  starting = run;
  try {
    return await run;
  } finally {
    // 只清理属于自己这一代的 promise，避免抹掉后来者的启动状态
    if (gen === startGeneration && starting === run) starting = null;
  }
}

function runTaskkill(args) {
  return new Promise(function (resolve) {
    const killer = spawn('taskkill', args, { windowsHide: true, stdio: 'ignore' });
    killer.on('exit', function (code) { resolve(code === 0); });
    killer.on('error', function () { resolve(false); });
  });
}

/** 用 PowerShell 列出某进程的全部后代 PID。
 *
 * PyInstaller --onefile 的后端是「引导进程 + 应用子进程」两层：引导进程退出后，
 * 应用子进程会被悬挂，taskkill /T 此时已无可遍历的树，只能按 PID 直接清理。
 * Windows 会保留原始 ParentProcessId，所以父进程死后再枚举依然有效。
 */
function listDescendants(rootPid) {
  return new Promise(function (resolve) {
    if (process.platform !== 'win32' || !rootPid) return resolve([]);
    const ps = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress';
    const shell = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let buf = '';
    let settled = false;
    const finish = function (value) {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const timer = setTimeout(function () { try { shell.kill(); } catch (e) { /* ignore */ } finish([]); }, 5000);
    shell.stdout.on('data', function (d) { buf += d.toString(); });
    shell.on('error', function () { clearTimeout(timer); finish([]); });
    shell.on('exit', function () {
      clearTimeout(timer);
      let all;
      try { all = JSON.parse(buf); } catch (e) { return finish([]); }
      if (!Array.isArray(all)) all = [all];
      const byParent = new Map();
      for (const p of all) {
        const key = p.ParentProcessId;
        if (!byParent.has(key)) byParent.set(key, []);
        byParent.get(key).push(p.ProcessId);
      }
      const out = [];
      const stack = [rootPid];
      while (stack.length) {
        const cur = stack.pop();
        const kids = byParent.get(cur) || [];
        for (const kid of kids) {
          if (out.indexOf(kid) === -1) { out.push(kid); stack.push(kid); }
        }
      }
      finish(out);
    });
  });
}

/** 结束后端整棵进程树：先 /T，再逐个强杀已枚举出的后代。 */
async function killTreeByTaskkill(pid) {
  if (!pid) return false;
  if (process.platform !== 'win32') {
    try { process.kill(-pid, 'SIGKILL'); } catch (err) { /* ignore */ }
    return false;
  }
  const descendants = await listDescendants(pid);
  const rootOk = await runTaskkill(['/PID', String(pid), '/T', '/F']);
  let extras = 0;
  for (const childPid of descendants) {
    if (await runTaskkill(['/PID', String(childPid), '/F'])) extras += 1;
  }
  if (extras > 0) logEvent('额外清理了 ' + extras + ' 个后代进程');
  return rootOk || extras > 0;
}

/** 先优雅 child.kill()，等 3s，再 taskkill 整棵进程树强杀。
 *
 * PyInstaller --onefile 的后端是「引导进程 + 真正的应用子进程」两层结构，
 * child.kill() 只会结束引导进程，应用子进程会变成孤儿继续占着端口。
 * 因此在 Windows 上无论引导进程是否已退出，最终都要对进程树做一次 /T /F。
 */
async function stopBackend() {
  const child = backendChild;
  backendChild = null;
  if (!child || child.pid === undefined) return;
  const pid = child.pid;
  if (child.exitCode === null) {
    try { child.kill(); } catch (err) { /* ignore */ }
    const exited = await new Promise(function (resolve) {
      let done = false;
      const timer = setTimeout(function () { if (!done) { done = true; resolve(false); } }, KILL_GRACE_MS);
      child.once('exit', function () { if (!done) { done = true; clearTimeout(timer); resolve(true); } });
    });
    if (!exited) logEvent('优雅退出超时，转为强制结束进程树 pid=' + pid);
  }
  // 收尾：清理可能残留的子进程（onefile 引导进程的应用子进程）
  if (process.platform === 'win32') {
    const killed = await killTreeByTaskkill(pid);
    if (killed) logEvent('已强制清理残留进程树 pid=' + pid);
    await sleep(150);
  }
  backendReady = false;
}

async function restartBackend() {
  if (restarting) return false;
  restarting = true;
  backendCrashCount = 0;
  try {
    setSplash('正在重启后端…', '');
    await stopBackend();
    const baseUrl = await startBackend();
    if (mainWindow && !mainWindow.isDestroyed()) {
      await mainWindow.loadURL(baseUrl);
    }
    return true;
  } catch (err) {
    showErrorPage(err.message || String(err));
    return false;
  } finally {
    restarting = false;
  }
}

function statusToWindow(text) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setTitle('记忆中枢 · ' + text);
  }
}

// --------------------------------------------------------------------------- //
// 窗口
// --------------------------------------------------------------------------- //
function createMainWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1180,
    minHeight: 760,
    show: false,
    backgroundColor: '#0b0f14',
    title: '记忆中枢',
    autoHideMenuBar: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  win.once('ready-to-show', function () {
    if (!win.isDestroyed()) {
      win.show();
      logEvent('主窗口已显示');
    }
  });
  win.on('close', function (event) {
    if (quitting) return;
    // 托盘常驻：关闭窗口只是隐藏
    event.preventDefault();
    win.hide();
  });
  win.on('closed', function () {
    if (mainWindow === win) mainWindow = null;
  });
  win.webContents.setWindowOpenHandler(function (detail) {
    openExternalSafe(detail.url);
    return { action: 'deny' };
  });
  // 主窗口只允许停留在本机后端页面（或本外壳的错误页）上；其它导航一律拦下，http(s)/mailto
  // 交给系统浏览器。1.0.0 没有这道闸：记忆正文里一个 [x](//example.org) 链接就能把带
  // preload 桥的主窗口导航到外部页面。
  const guardNavigation = function (event, url) {
    if (isAppUrl(url) || isErrorPage(url)) return;
    event.preventDefault();
    logEvent('拦截主窗口导航：' + String(url).slice(0, 200));
    openExternalSafe(url);
  };
  win.webContents.on('will-navigate', guardNavigation);
  win.webContents.on('will-redirect', guardNavigation);
  win.webContents.on('did-fail-load', function (_e, code, desc, url, isMainFrame) {
    // 子框架（图谱页的脑图 iframe）失败不能把整个应用换成错误页；ERR_ABORTED（-3）是导航被取消
    if (!isMainFrame || code === -3) return;
    showErrorPage('界面加载失败（' + code + ' ' + desc + '）：' + url);
  });
  mainWindow = win;
  return win;
}

function focusMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
}

function showErrorPage(message) {
  logEvent('显示错误页：' + String(message || '').slice(0, 300));
  const payload = {
    message: String(message || '未知错误'),
    logPath: backendLogPath(),
    dataPath: dataDir(),
    dev: IS_DEV ? '1' : '0',
  };
  setSplash('启动失败', payload.message);
  if (!mainWindow || mainWindow.isDestroyed()) createMainWindow();
  destroySplash();
  const target = mainWindow;
  target.loadFile(path.join(__dirname, 'error.html'), { query: payload })
    .then(function () { if (!target.isDestroyed()) { target.show(); target.focus(); } })
    .catch(function (err) { console.error('[memora] 错误页加载失败:', err && err.message); });
}

// --------------------------------------------------------------------------- //
// 托盘与菜单
// --------------------------------------------------------------------------- //
function trayIcon() {
  const p = path.join(__dirname, 'icon.png');
  // 先按 asar 内路径读取字节（fs 已被 electron 补丁化），再退回 createFromPath
  try {
    const img = nativeImage.createFromBuffer(fs.readFileSync(p));
    if (!img.isEmpty()) return img.resize({ width: 16, height: 16 });
  } catch (err) { /* ignore */ }
  try {
    const img = nativeImage.createFromPath(p);
    if (!img.isEmpty()) return img.resize({ width: 16, height: 16 });
  } catch (err) { /* ignore */ }
  return nativeImage.createEmpty();
}

function openPathOrWarn(target, label) {
  shell.openPath(target).then(function (errText) {
    if (errText) {
      dialog.showMessageBox({
        type: 'warning',
        title: '无法打开' + label,
        message: '打不开：' + target,
        detail: errText,
        buttons: ['好的'],
      }).catch(function () { /* ignore */ });
    }
  }).catch(function () { /* ignore */ });
}

function mcpConfigObject() {
  const data = dataDir();
  if (IS_DEV) {
    return {
      mcpServers: {
        memora: {
          command: pythonCommand(),
          args: ['-m', 'memora_core', '--data', data, 'mcp-stdio'],
          env: { MEMORA_HOME: data },
        },
      },
    };
  }
  return {
    mcpServers: {
      memora: {
        command: backendExePath(),
        args: ['--data', data, 'mcp-stdio'],
        env: { MEMORA_HOME: data },
      },
    },
  };
}

function copyMcpConfig() {
  const text = JSON.stringify(mcpConfigObject(), null, 2);
  clipboard.writeText(text);
  if (tray && process.platform === 'win32' && typeof tray.displayBalloon === 'function') {
    tray.displayBalloon({ title: 'MCP 配置已复制', content: '已写入剪贴板，粘贴到客户端的 mcpServers 中即可。' });
    return;
  }
  dialog.showMessageBox({
    type: 'info',
    title: 'MCP 配置已复制',
    message: '已复制到剪贴板',
    detail: text,
    buttons: ['好的'],
  }).catch(function () { /* ignore */ });
}

function buildTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip('记忆中枢 memora-core');
  const menu = Menu.buildFromTemplate([
    { label: '显示主窗口', click: function () { focusMainWindow(); } },
    { label: '隐藏主窗口', click: function () { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide(); } },
    { type: 'separator' },
    { label: '打开数据目录', click: function () { ensureDir(dataDir()); openPathOrWarn(dataDir(), '数据目录'); } },
    { label: '打开日志', click: function () { ensureDir(logsDir()); openPathOrWarn(backendLogPath(), '日志文件'); } },
    { label: '重启后端', click: function () { restartBackend().catch(function () { /* 已在内部处理 */ }); } },
    { type: 'separator' },
    { label: '退出', click: function () { app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', function () { focusMainWindow(); });
  tray.on('double-click', function () { focusMainWindow(); });
}

function buildMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        { label: '显示主窗口', accelerator: 'CmdOrCtrl+Shift+M', click: function () { focusMainWindow(); } },
        { type: 'separator' },
        { label: '打开数据目录', click: function () { ensureDir(dataDir()); openPathOrWarn(dataDir(), '数据目录'); } },
        { label: '打开日志文件', click: function () { ensureDir(logsDir()); openPathOrWarn(backendLogPath(), '日志文件'); } },
        { label: '重启后端', click: function () { restartBackend().catch(function () { /* noop */ }); } },
        { type: 'separator' },
        { label: '退出', accelerator: 'CmdOrCtrl+Q', click: function () { app.quit(); } },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '重新加载', accelerator: 'CmdOrCtrl+R', click: function () { if (mainWindow) mainWindow.reload(); } },
        { label: '强制重新加载', accelerator: 'CmdOrCtrl+Shift+R', click: function () { if (mainWindow) mainWindow.webContents.reloadIgnoringCache(); } },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        { label: '打开文档目录', click: function () { ensureDir(docsDir()); openPathOrWarn(docsDir(), '文档目录'); } },
        { label: '复制 MCP 配置', click: function () { copyMcpConfig(); } },
        { type: 'separator' },
        {
          label: '关于记忆中枢',
          click: function () {
            dialog.showMessageBox({
              type: 'info',
              title: '关于',
              message: '记忆中枢 memora-core',
              detail: '版本 ' + app.getVersion() + '\nElectron ' + process.versions.electron +
                '\n数据目录：' + dataDir() + (IS_DEV ? '\n（开发模式：python -m memora_core）' : ''),
              buttons: ['好的'],
            }).catch(function () { /* ignore */ });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// --------------------------------------------------------------------------- //
// IPC
// --------------------------------------------------------------------------- //
function registerIpc() {
  ipcMain.handle('memora:env', guardIpc(function () {
    return {
      appVersion: app.getVersion(),
      versions: {
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
      },
      platform: process.platform,
      dev: IS_DEV,
      port: backendPort,
      ready: backendReady,
      dataDir: dataDir(),
      logPath: backendLogPath(),
    };
  }));
  ipcMain.handle('memora:open-devtools', guardIpc(function () {
    // 打包版不再允许页面自己打开 DevTools（菜单里仍可手动打开）
    if (!IS_DEV) return false;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.openDevTools({ mode: 'detach' });
    return true;
  }));
  ipcMain.handle('memora:restart-backend', guardIpc(function () { return restartBackend(); }));
  ipcMain.handle('memora:open-logs', guardIpc(function () { ensureDir(logsDir()); openPathOrWarn(backendLogPath(), '日志文件'); return true; }));
  ipcMain.handle('memora:open-data', guardIpc(function () { ensureDir(dataDir()); openPathOrWarn(dataDir(), '数据目录'); return true; }));
  ipcMain.handle('memora:copy-mcp', guardIpc(function () { copyMcpConfig(); return mcpConfigObject(); }));
}

// --------------------------------------------------------------------------- //
// 启动流程
// --------------------------------------------------------------------------- //
async function boot() {
  createSplash();
  setSplash('正在启动记忆中枢…', '');
  try {
    const baseUrl = await startBackend();
    const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : createMainWindow();
    await win.loadURL(baseUrl);
    setSplash('就绪', baseUrl);
    destroySplash();
    if (!win.isDestroyed()) { win.show(); win.focus(); }
  } catch (err) {
    if (err && err.superseded) return;   // 被崩溃自愈流程接管，交给它继续
    showErrorPage(err && err.message ? err.message : String(err));
  }
}

// --------------------------------------------------------------------------- //
// 单实例
// --------------------------------------------------------------------------- //
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', function () {
    focusMainWindow();
  });

  app.setAppUserModelId(APP_ID);

  app.whenReady().then(function () {
    installPermissionPolicy();
    registerIpc();
    buildMenu();
    buildTray();
    ensureDir(dataDir());
    ensureDir(logsDir());
    boot().catch(function (err) { showErrorPage(err && err.message ? err.message : String(err)); });
    // 自检钩子：设置 MEMORA_SELFTEST_QUIT_MS 可在指定毫秒后自动退出，
    // 供无头 CI 验证 before-quit -> 关闭后端的完整退出链路。
    const selftestQuit = Number(process.env.MEMORA_SELFTEST_QUIT_MS || 0);
    if (selftestQuit > 0) {
      setTimeout(function () {
        logEvent('自检钩子触发退出（MEMORA_SELFTEST_QUIT_MS）');
        app.quit();
      }, selftestQuit);
    }
  }).catch(function (err) {
    console.error('[memora] 启动失败:', err && err.stack ? err.stack : err);
  });

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) {
      boot().catch(function () { /* noop */ });
    } else {
      focusMainWindow();
    }
  });

  app.on('window-all-closed', function () {
    // 托盘常驻：不在这里退出（macOS 同样保留）
  });

  app.on('before-quit', function (event) {
    if (quitFinished) return;
    event.preventDefault();
    quitting = true;
    destroySplash();
    logEvent('开始退出：正在关闭后端');
    stopBackend().catch(function () { /* ignore */ }).finally(function () {
      logEvent('后端已关闭，进程退出');
      quitFinished = true;
      if (tray) { try { tray.destroy(); } catch (err) { /* ignore */ } tray = null; }
      app.quit();
    });
  });
}
