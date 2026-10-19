/**
 * Diagnostics, readiness and process hygiene for the Memora desktop shell.
 *
 * Why this file exists: main.cjs used to treat a single stdout line as proof of life, a single
 * fixed port as the only option and any backend exit as fatal, so a slow machine, an occupied port
 * and a crashed child all ended in the same place -- a blank window or a startup that refused to
 * happen and said one sentence about it. The parts that make the shell self-diagnosing live here,
 * away from the window wiring, so desktop/scripts/selftest-shell.mjs can drive them without an
 * Electron process.
 *
 * Dependency free on purpose: this file ships inside app.asar next to main.cjs and has to load with
 * nothing but Node builtins.
 */
'use strict';

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const {spawn} = require('node:child_process');

// The log is diagnostics, not an archive: one megabyte is roughly a month of launches, and the
// ceiling is what keeps a backend that repeats a warning every request from filling the disk.
const MAX_LOG_BYTES = 1024 * 1024;
// Readiness budget. 45s covers a cold Python start with index rebuilds on a spinning disk; the
// 250ms poll is fast enough that a warm start feels instant and cheap enough not to matter.
const READY_TIMEOUT_MS = 45000;
const READY_POLL_MS = 250;
// One probe must not outlive a poll tick, or a hung socket would silently eat the whole budget.
const PROBE_TIMEOUT_MS = 1500;

// A diagnostics file outlives the session that produced it and gets copied into bug reports, so
// credentials are stripped on the way in rather than trusted not to appear. The backend never
// prints its token, but a Python traceback can quote a request header and stderr is logged verbatim.
const SECRETS = [
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1<redacted>'],
  [/\b(X-MM-Token\s*[:=]\s*)[^\s,;"']+/gi, '$1<redacted>'],
  [/([?&](?:token|key|secret|password|api_key|access_token)=)[^&\s"']+/gi, '$1<redacted>'],
  [/("(?:api_key|token|secret|password|access_token)"\s*:\s*")[^"]*/gi, '$1<redacted>'],
  [/\b(sk-[A-Za-z0-9_-]{8,})/g, '<redacted>'],
];

function redact(text) {
  let out = String(text);
  for (const [pattern, replacement] of SECRETS) out = out.replace(pattern, replacement);
  return out;
}

/**
 * Append-only lifecycle log next to the data directory.
 *
 * Writes are synchronous: the interesting moments are startup failures and crashes, which is
 * exactly when a buffered stream would lose the last lines it never flushed. Callers are allowed
 * to ignore this object (a logger with no file writes nothing) so startup ordering stays simple.
 */
function createLogger(file, maxBytes = MAX_LOG_BYTES) {
  let size = 0;
  let healthy = Boolean(file);
  const roll = () => {
    try {
      if (fs.statSync(file).size <= maxBytes) return true;
      // Keep the TAIL. The start of a log answers "when did this install first run"; the end
      // answers "what broke", and only one of those is worth keeping under a size ceiling.
      let tail = fs.readFileSync(file, 'utf8').slice(-Math.floor(maxBytes * 0.9));
      const newline = tail.indexOf('\n');
      if (newline >= 0) tail = tail.slice(newline + 1);
      fs.writeFileSync(file, tail);
      size = Buffer.byteLength(tail);
      return true;
    } catch { return false; }
  };
  if (healthy) {
    try {
      fs.mkdirSync(path.dirname(file), {recursive: true});
      // Create the file eagerly. A logger that only discovers it cannot write on the first
      // interesting line is a logger that loses the line that mattered, and an existing file is
      // also the cheapest health signal a support report can check.
      fs.appendFileSync(file, '');
      size = fs.statSync(file).size;
      if (!roll()) healthy = false;
    } catch { healthy = false; }
  }
  return {
    file,
    write(message) {
      if (!healthy) return;
      try {
        const line = new Date().toISOString() + ' ' + redact(String(message).replace(/\s+$/, '')) + '\n';
        fs.appendFileSync(file, line);
        // Accounting on every write rather than every N: the ceiling is what stops a backend that
        // repeats a warning per request from filling the disk, so it cannot be approximate.
        size += Buffer.byteLength(line);
        if (size > maxBytes && !roll()) healthy = false;
      } catch { healthy = false; }
    },
    enabled: () => healthy,
  };
}
/**
 * Comparison form for a directory path.
 *
 * The backend answers with its own resolve() of --data and Windows is case insensitive, so the two
 * strings differ in case and separators for the same directory. Both sides go through this.
 */
function canonicalPath(target) {
  try {
    const resolved = path.resolve(String(target));
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  } catch { return null; }
}

/** True when nothing on this machine can bind 127.0.0.1:port right now. */
function isPortFree(port, host = '127.0.0.1') {
  return new Promise(resolve => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    try { probe.listen({port, host, exclusive: true}); }
    catch { resolve(false); }
  });
}

/** First free port in [base, last], or 0 when the whole window is taken. */
async function pickPort(base, last) {
  for (let port = base; port <= last; port++) if (await isPortFree(port)) return port;
  return 0;
}

/**
 * Ask the backend who it is.
 *
 * The stdout announcement only proves a socket exists; three separate Memora stores can be listening
 * on three ports at once (development, packaged, a leftover), and attaching the window to the wrong
 * one writes into the wrong database. name/version/data_dir is the identity check, and it is also
 * what the packaged launcher already uses.
 */
async function probeStatus(origin, expected, timeoutMs = PROBE_TIMEOUT_MS) {
  // Accept-Encoding is pinned to identity on purpose. Compounded compression is a backend concern, but
  // a readiness probe that depends on it is a probe that can be failed by it: the workbench answers
  // some client-accepted bodies with a zlib stream labelled Content-Encoding: gzip, which every
  // standards-following decoder (this fetch included) rejects with "incorrect header check". The
  // probe only needs the nine hundred bytes of identity JSON, so it asks for exactly that.
  const response = await fetch(origin + '/api/agent/status', {signal: AbortSignal.timeout(timeoutMs), redirect: 'error', headers: {'accept-encoding': 'identity'}});
  if (!response.ok) throw new Error('status ' + response.status);
  const status = await response.json();
  if (!status || status.name !== 'memora') throw new Error('not a memora backend');
  if (expected && expected.version && status.version !== expected.version) {
    throw new Error('version ' + status.version + ' does not match ' + expected.version);
  }
  if (expected && expected.dataDir) {
    const reported = canonicalPath(status.data_dir);
    if (!reported || reported !== expected.dataDir) throw new Error('data_dir ' + status.data_dir + ' does not match ' + expected.dataDir);
  }
  return status;
}

/**
 * Wait until the backend answers as OUR backend, or fail.
 *
 * Two signals race and the first one wins: an active /api/agent/status probe (we chose the port, so
 * polling starts at t=0 and a slow start is just a longer wait) and the stdout line, which stays as
 * a fast path and is the only way to learn the address when the backend picks its own port.
 *
 * Returns {promise, abort}. abort() exists because a child that dies during startup must fail
 * immediately: waiting out the full budget on a process that is already gone is 45 seconds of
 * nothing happening in front of the user.
 */
function createReadiness({child, expected, log = () => {}, timeoutMs = READY_TIMEOUT_MS, intervalMs = READY_POLL_MS}) {
  let settled = false;
  let deadline = null;
  let timer = null;
  let buffer = '';
  let origin = null;
  let inFlight = false;
  let polls = 0;
  const started = Date.now();
  let finish = null;

  const promise = new Promise((resolve, reject) => {
    const close = () => {
      clearTimeout(deadline);
      clearTimeout(timer);
      if (child.stdout) child.stdout.removeListener('data', onData);
      child.removeListener('error', onError);
      child.removeListener('exit', onExit);
    };
    finish = (error, value) => {
      if (settled) return;
      settled = true;
      close();
      if (error) reject(error); else resolve(value);
    };
    const onError = error => finish(new Error('backend could not start: ' + ((error && error.message) || error)));
    const onExit = (code, signal) => finish(Object.assign(
      new Error('backend exited before it became ready (code ' + code + ', signal ' + signal + ')'),
      {exitCode: code}));
    // The announcement is the documented contract of memora/__main__.py, kept as a signal rather
    // than as proof: it says a socket was bound, not that this is our store.
    const onData = chunk => {
      buffer = (buffer + chunk.toString()).slice(-10000);
      const match = buffer.match(/Memora: (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) announce(match[1]);
    };
    const announce = url => {
      if (settled) return;
      if (!origin) {
        origin = new URL(url).origin;
        log('stdout announced ' + origin);
      }
      void attempt();
    };
    const attempt = async () => {
      if (settled || inFlight) return;
      const candidate = origin || (expected && expected.port ? 'http://127.0.0.1:' + expected.port : null);
      if (!candidate) return;
      inFlight = true;
      polls += 1;
      let failure = null;
      try { await probeStatus(candidate, expected); }
      catch (error) { failure = error; }
      finally { inFlight = false; }
      if (settled) return;
      if (!failure) { finish(null, candidate); return; }
      // One line every five seconds: enough to tell "still starting" from "wedged" in a log
      // somebody reads tomorrow, without one line per poll.
      if (polls % 20 === 0) {
        log('still waiting for ' + candidate + ' after ' + Math.round((Date.now() - started) / 1000) + 's: ' + failure.message);
      }
      schedule();
    };
    const schedule = () => {
      if (settled) return;
      clearTimeout(timer);
      timer = setTimeout(() => void attempt(), intervalMs);
    };
    deadline = setTimeout(() => finish(new Error('backend was not ready within ' + Math.round(timeoutMs / 100) / 10 + 's')), timeoutMs);
    child.stdout.on('data', onData);
    child.once('error', onError);
    child.once('exit', onExit);
    void attempt();
  });

  return {
    promise,
    abort(reason) { if (finish) finish(reason instanceof Error ? reason : new Error(String(reason))); },
  };
}

/**
 * Kill a process and everything it started.
 *
 * On Windows child.kill() signals that one process: a backend that forked a worker keeps the SQLite
 * file open through the grandchild and the next launch meets a locked database. taskkill /T walks
 * the tree. It is spawned detached so it finishes the job even if this app exits first -- Windows
 * does not take children down with their parent -- and the timeout only bounds our own wait.
 */
function killTree(pid) {
  return new Promise(resolve => {
    if (!pid || process.platform !== 'win32') { resolve(false); return; }
    let killer;
    try {
      killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {windowsHide: true, stdio: 'ignore', detached: true});
    } catch { resolve(false); return; }
    const timer = setTimeout(() => resolve(false), 5000);
    killer.once('exit', code => { clearTimeout(timer); resolve(code === 0); });
    killer.once('error', () => { clearTimeout(timer); resolve(false); });
    killer.unref();
  });
}

/** Resolve true when the child has exited (already counted), false on timeout. */
function waitForExit(child, timeoutMs) {
  return new Promise(resolve => {
    if (!child || child.exitCode !== null || child.signalCode !== null) { resolve(true); return; }
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => { clearTimeout(timer); resolve(true); });
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[character]));
}

/**
 * The page shown while the backend is being restarted.
 *
 * A blank window is indistinguishable from a hung application, and the user's only move then is to
 * kill and relaunch -- which is the exact behaviour this shell is meant to replace. The page is a
 * data: URL with no script: nothing to load, nothing to execute, and it works when the backend that
 * would serve assets is the thing that is down.
 */
function reconnectHtml(info = {}) {
  const attempt = Number(info.attempt) || 1;
  const total = Number(info.total) || 3;
  const retry = Number(info.retryInMs) || 0;
  const reason = escapeHtml(info.reason || '本地后端已退出');
  const version = escapeHtml(info.version || '');
  return [
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">',
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'">',
    '<title>Memora · 正在重连</title>',
    '<style>',
    'html,body{margin:0;height:100%;background:#f6f7f3;color:#20211d;',
    'font:15px/1.7 "Segoe UI","Microsoft YaHei",system-ui,sans-serif}',
    'main{max-width:560px;margin:0 auto;padding:18vh 28px 0}',
    'h1{font-size:20px;font-weight:600;margin:0 0 12px}',
    'p{margin:0 0 10px;color:#4a4c44}',
    'dl{margin:18px 0 0;padding:14px 16px;background:#fff;border:1px solid #e2e4dc;border-radius:10px}',
    'div{display:flex;gap:12px;padding:2px 0}',
    'dt{min-width:96px;color:#8a8c82}dd{margin:0;word-break:break-all}',
    '.hint{margin-top:18px;font-size:13px;color:#8a8c82}',
    '</style></head><body><main>',
    '<h1>本地后端正在重启</h1>',
    '<p>Memora 的本地记忆服务意外退出，外壳正在自动重启它，恢复后本页会自动加载工作台。</p>',
    '<dl>',
    '<div><dt>重试次数</dt><dd>' + attempt + ' / ' + total + '</dd></div>',
    '<div><dt>等待</dt><dd>' + Math.round(retry / 100) / 10 + ' 秒后重试</dd></div>',
    '<div><dt>原因</dt><dd>' + reason + '</dd></div>',
    version ? '<div><dt>版本</dt><dd>' + version + '</dd></div>' : '',
    '</dl>',
    '<p class="hint">连续 ' + total + ' 次失败后会提示具体错误。诊断日志：数据目录下的 desktop.log。</p>',
    '</main></body></html>',
  ].join('');
}

/**
 * Drive the bounded restart budget.
 *
 * The policy lives here rather than in main.cjs because it is the part with a shape worth testing:
 * a fixed sequence of backoffs, one attempt per step, first success wins, and a cancellation that
 * must be honoured between steps -- a user who quits during the backoff should not get a resurrected
 * backend one second later.
 *
 * `attempt` resolves on success and rejects on failure; `cancelled` is checked before and after each
 * delay. Returns what happened rather than throwing: giving up is a normal outcome, not an error.
 */
async function runRecovery({delays, attempt, cancelled = () => false, onAttempt = () => {}}) {
  let last = null;
  for (let index = 0; index < delays.length; index++) {
    if (cancelled()) return {recovered: false, attempts: index, error: last, cancelled: true};
    onAttempt({attempt: index + 1, total: delays.length, delayMs: delays[index]});
    await new Promise(resolve => setTimeout(resolve, delays[index]));
    if (cancelled()) return {recovered: false, attempts: index, error: last, cancelled: true};
    try {
      const value = await attempt({attempt: index + 1, total: delays.length});
      return {recovered: true, attempts: index + 1, value, error: null, cancelled: false};
    } catch (error) { last = error; }
  }
  return {recovered: false, attempts: delays.length, error: last, cancelled: false};
}
/** The same page as a navigable data: URL (kept in one place so main.cjs never hand-builds it). */
function reconnectUrl(info) {
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(reconnectHtml(info));
}

module.exports = {
  MAX_LOG_BYTES,
  READY_TIMEOUT_MS,
  READY_POLL_MS,
  redact,
  createLogger,
  canonicalPath,
  isPortFree,
  pickPort,
  probeStatus,
  createReadiness,
  killTree,
  waitForExit,
  reconnectHtml,
  reconnectUrl,
  runRecovery,
};
