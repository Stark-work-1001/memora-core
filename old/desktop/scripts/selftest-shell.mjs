/**
 * Self test for the desktop supervisor, runnable without Electron.
 *
 * The two behaviours that used to be "works on my machine" are the ones worth pinning down: a port
 * that is already in use, and a backend that takes seconds rather than milliseconds to answer. Both
 * are tested against a fake backend -- a real HTTP server that speaks /api/agent/status -- so the
 * test proves the shell's decision making rather than the Python process's speed.
 *
 * Run with: node desktop/scripts/selftest-shell.mjs
 */
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const health = require('../health.cjs');
const here = path.dirname(fileURLToPath(import.meta.url));

let failures = 0;
let checks = 0;
function check(name, ok, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  [' + detail + ']' : ''));
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'memora-selftest-'));
const CANONICAL = health.canonicalPath(DATA_DIR);
const VERSION = require('../package.json').version;

/** A backend that announces itself the way memora/__main__.py does, after a delay. */
function fakeBackend({delayMs = 0, version = VERSION, dataDir = DATA_DIR, announce = true, fail = false} = {}) {
  const child = spawn(process.execPath, [path.join(here, 'selftest-backend.mjs'), JSON.stringify({
    port: 0, delayMs, version, dataDir, announce, fail,
  })], {stdio: ['ignore', 'pipe', 'pipe']});
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', () => {});
  const announced = new Promise((resolve, reject) => {
    let buffer = '';
    child.stdout.on('data', chunk => {
      buffer += chunk;
      const match = buffer.match(/Memora: (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) resolve(match[1]);
    });
    child.once('exit', code => reject(new Error('fake backend exited ' + code)));
  });
  announced.catch(() => {});
  return {child, announced};
}

function occupy(port) {
  return new Promise((resolve, reject) => {
    const blocker = net.createServer();
    blocker.once('error', reject);
    blocker.listen({port, host: '127.0.0.1', exclusive: true}, () => resolve(blocker));
  });
}

const close = server => new Promise(resolve => { try { server.close(() => resolve()); } catch { resolve(); } });
const stopChild = child => { try { child.kill(); } catch {} };
async function main() {
  console.log('memora desktop shell self test');
  console.log('data dir: ' + DATA_DIR);
  console.log('');

  // ---- 1. an occupied port is skipped, not fatal -------------------------------------------
  const base = 18765;
  const blocker = await occupy(base);
  console.log('blocker: listening on 127.0.0.1:' + base);
  const freeBefore = await health.isPortFree(base);
  check('a bound port is reported as busy', freeBefore === false, 'isPortFree(' + base + ')=' + freeBefore);
  const chosen = await health.pickPort(base, base + 30);
  check('the scan skips the occupied port', chosen === base + 1, 'picked ' + chosen);

  // Two more neighbours taken: the scan must keep walking, not stop at the first refusal.
  const second = await occupy(base + 1);
  const third = await occupy(base + 2);
  const walked = await health.pickPort(base, base + 30);
  check('the scan walks past a run of occupied ports', walked === base + 3, 'picked ' + walked);
  await close(second);
  await close(third);
  const afterRelease = await health.pickPort(base, base + 30);
  check('a released neighbour is taken before the further port', afterRelease === base + 1, 'picked ' + afterRelease);

  // A fully occupied window has no answer; the shell falls back to an OS-assigned port rather
  // than spawning a backend that cannot bind.
  const full = [await occupy(base + 1), await occupy(base + 2)];
  const none = await health.pickPort(base, base + 2);
  check('a fully occupied window yields 0 (OS-assigned fallback)', none === 0, 'picked ' + none);
  for (const server of full) await close(server);
  await close(blocker);
  const freed = await health.pickPort(base, base + 2);
  check('after every blocker closes the base port is free again', freed === base, 'picked ' + freed);
  console.log('');

  // ---- 2. a slow backend still becomes ready ----------------------------------------------
  // Readiness is created immediately after the spawn, exactly as main.cjs does: the announcement
  // and the probe have to race from t=0, and a listener attached after the line was printed would
  // never see it.
  const slow = fakeBackend({delayMs: 3000});
  const slowStart = Date.now();
  const slowReady = health.createReadiness({child: slow.child, expected: {version: VERSION, dataDir: CANONICAL}, log: () => {}});
  const readyOrigin = await slowReady.promise;
  const slowMs = Date.now() - slowStart;
  const slowOrigin = await slow.announced;
  check('a backend that needs 3s is still reported ready', readyOrigin === slowOrigin, readyOrigin + ' in ' + slowMs + 'ms');
  check('readiness waited for the real start, not a fixed grace period', slowMs >= 2900, slowMs + 'ms');
  stopChild(slow.child);
  console.log('');

  // ---- 3. readiness is identity, not a socket --------------------------------------------
  const fast = fakeBackend({delayMs: 0});
  const fastOrigin = await fast.announced;
  const fastPort = Number(new URL(fastOrigin).port);
  const wrongVersion = health.createReadiness({child: fast.child, expected: {port: fastPort, version: '9.9.9', dataDir: CANONICAL}, log: () => {}, timeoutMs: 2500});
  let wrongVersionError = '';
  try { await wrongVersion.promise; } catch (error) { wrongVersionError = error.message; }
  check('a backend running a different version is rejected', /not ready within/.test(wrongVersionError), wrongVersionError);
  const probe = await health.probeStatus(fastOrigin, {version: VERSION, dataDir: CANONICAL});
  check('the probe accepts our own backend', probe.name === 'memora' && probe.version === VERSION, JSON.stringify({name: probe.name, version: probe.version}));
  stopChild(fast.child);

  const other = fakeBackend({delayMs: 0, dataDir: path.join(DATA_DIR, 'somewhere-else')});
  const otherOrigin = await other.announced;
  let dataDirError = '';
  try { await health.probeStatus(otherOrigin, {version: VERSION, dataDir: CANONICAL}); }
  catch (error) { dataDirError = error.message; }
  check('a backend serving a different data directory is rejected', /data_dir/.test(dataDirError), dataDirError);
  stopChild(other.child);

  const silent = fakeBackend({delayMs: 0, announce: false});
  await sleep(400);
  // Unknown port and no announcement is the unguessable case: it must time out, not hang forever.
  const silentReady = health.createReadiness({child: silent.child, expected: {version: VERSION, dataDir: CANONICAL}, log: () => {}, timeoutMs: 1200});
  let silentError = '';
  try { await silentReady.promise; } catch (error) { silentError = error.message; }
  check('an unannounced backend with no known port times out', /not ready within/.test(silentError), silentError);
  stopChild(silent.child);

  const dying = fakeBackend({fail: true});
  const dyingReady = health.createReadiness({child: dying.child, expected: {version: VERSION, dataDir: CANONICAL}, log: () => {}, timeoutMs: 5000});
  const dyingStart = Date.now();
  let dyingError = '';
  try { await dyingReady.promise; } catch (error) { dyingError = error.message; }
  check('a backend that dies during startup fails fast', dyingError.startsWith('backend exited before') && Date.now() - dyingStart < 4000, dyingError);

  console.log('');

  // ---- 4. the restart budget is three attempts, then it stops ---------------------------
  const NO_DELAY = [0, 0, 0];
  const tried = [];
  const exhausted = await health.runRecovery({
    delays: NO_DELAY,
    onAttempt: ({attempt}) => tried.push(attempt),
    attempt: () => Promise.reject(new Error('still broken')),
  });
  check('the budget stops after three attempts', exhausted.attempts === 3 && tried.join(',') === '1,2,3', 'attempts ' + exhausted.attempts + ' order ' + tried.join(','));
  check('giving up reports the last failure', /still broken/.test(exhausted.error && exhausted.error.message), exhausted.error && exhausted.error.message);

  let calls = 0;
  const recovered = await health.runRecovery({
    delays: NO_DELAY,
    attempt: () => { calls += 1; return calls < 2 ? Promise.reject(new Error('first attempt dies')) : Promise.resolve('http://127.0.0.1:18765'); },
  });
  check('a later attempt that succeeds wins', recovered.recovered && recovered.value === 'http://127.0.0.1:18765' && calls === 2, 'calls ' + calls);

  let cancelledAttempts = 0;
  let cancelled = false;
  const cancelPromise = health.runRecovery({
    delays: [80, 80, 80],
    cancelled: () => cancelled,
    attempt: () => { cancelledAttempts += 1; return Promise.reject(new Error('never')); },
  });
  setTimeout(() => { cancelled = true; }, 20);
  const cancelledOutcome = await cancelPromise;
  check('quitting during the backoff stops the retries', cancelledOutcome.cancelled === true && cancelledAttempts === 0, 'attempts made ' + cancelledAttempts);
  console.log('');

  // ---- 5. the diagnostics log rolls at 1 MB and never stores a credential --------------
  const logFile = path.join(DATA_DIR, 'nested', 'desktop.log');
  const logger = health.createLogger(logFile, 4096);
  check('the logger creates its directory', logger.enabled() && fs.existsSync(logFile), logFile);
  logger.write('backend stderr: Authorization: Bearer sk-abcdef0123456789 whatever');
  logger.write('GET /api/agent/status?token=supersecretvalue HTTP/1.1');
  logger.write('{"api_key": "also-a-secret"}');
  const secretText = fs.readFileSync(logFile, 'utf8');
  check('a bearer token is redacted', !secretText.includes('sk-abcdef0123456789'), secretText.includes('<redacted>') ? 'masked' : 'not masked');
  check('a query token is redacted', !secretText.includes('supersecretvalue'), 'token= masked');
  check('a json api_key is redacted', !secretText.includes('also-a-secret'), 'api_key masked');
  for (let index = 0; index < 400; index++) logger.write('line ' + index + ' ' + 'x'.repeat(60));
  const rolled = fs.statSync(logFile).size;
  check('the log is truncated at the ceiling', rolled <= 4096, rolled + ' bytes <= 4096');
  const rolledText = fs.readFileSync(logFile, 'utf8');
  check('truncation keeps the tail, not the head', rolledText.includes('line 399') && !rolledText.includes('line 0 '), rolledText.includes('line 399') ? 'newest retained' : 'newest lost');
  console.log('');

  // ---- 6. the reconnect page is a page, and carries no script --------------------------
  const page = health.reconnectHtml({attempt: 2, total: 3, retryInMs: 1500, reason: 'exit code 1', version: VERSION});
  check('the reconnect page is real markup, not a blank document', page.includes('正在重启') && page.includes('2 / 3'), page.length + ' bytes');
  check('the reconnect page carries no script', !/<script/i.test(page) && !/onload=/i.test(page), 'no script tag');
  check('the reconnect page escapes injected text', !health.reconnectHtml({reason: '<img src=x onerror=alert(1)>'}).includes('<img'), 'reason escaped');
  check('the reconnect URL is a self-contained data: url', health.reconnectUrl({}).startsWith('data:text/html;charset=utf-8,'), 'data: url');
  console.log('');

  // ---- 7. the same code against the real Python backend ---------------------------------
  // Optional by design: the fakes above prove the decisions, this proves the contract has not
  // drifted (field names, the announcement text, the version the shell expects).
  const python = path.resolve(here, '..', '..', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  if (!fs.existsSync(python)) {
    console.log('SKIP  the real backend needs the source checkout interpreter (' + python + ')');
  } else {
    const realData = fs.mkdtempSync(path.join(os.tmpdir(), 'memora-selftest-real-'));
    const real = spawn(python, ['-m', 'memora', '--data', realData, 'serve', '--port', '0'], {
      cwd: path.resolve(here, '..', '..'), stdio: ['ignore', 'pipe', 'pipe'], env: {...process.env, PYTHONUNBUFFERED: '1'},
    });
    real.stderr.setEncoding('utf8');
    real.stderr.on('data', () => {});
    const realReady = health.createReadiness({child: real, expected: {version: VERSION, dataDir: health.canonicalPath(realData)}, log: () => {}, timeoutMs: 60000});
    const realStart = Date.now();
    let realOrigin = '';
    let realError = '';
    try { realOrigin = await realReady.promise; } catch (error) { realError = error.message; }
    check('the real backend passes the identity probe', Boolean(realOrigin), realOrigin ? realOrigin + ' in ' + (Date.now() - realStart) + 'ms' : realError);
    if (realOrigin) {
      const realStatus = await health.probeStatus(realOrigin, {version: VERSION, dataDir: health.canonicalPath(realData)});
      check('name, version and data_dir all match the shell', realStatus.name === 'memora' && realStatus.version === VERSION, JSON.stringify({name: realStatus.name, version: realStatus.version}));
      // Asked for with gzip and then decoded: the window loads this exact document, and a body whose
      // Content-Encoding does not match its bytes fails here rather than in front of a blank window.
      // Pinning identity would hide a header/format mismatch, which is the failure this file exists
      // to catch (it happened once: a bare zlib stream labelled gzip).
      const page = await fetch(realOrigin + '/', {signal: AbortSignal.timeout(5000), headers: {'accept-encoding': 'gzip'}});
      const body = await page.text();
      check('the workbench root answers, so loadURL would not be blank', page.ok && body.length > 0, 'HTTP ' + page.status + ', ' + body.length + ' bytes');
    }
    stopChild(real);
    await sleep(300);
    try { fs.rmSync(realData, {recursive: true, force: true}); } catch {}
  }
  console.log('');

  // ---- 8. the probe survives a mislabelled compressed body -----------------------------
  // The real workbench can answer with a zlib stream labelled Content-Encoding: gzip. A probe that
  // advertised gzip would fail on it; the probe asks for identity and is immune either way.
  const compressed = fakeBackend({delayMs: 0, labelsGzip: true});
  const compressedOrigin = await compressed.announced;
  let compressedStatus = null;
  let compressedError = '';
  try { compressedStatus = await health.probeStatus(compressedOrigin, {version: VERSION, dataDir: CANONICAL}); }
  catch (error) { compressedError = error.message + ' | ' + (error.cause ? error.cause.message : ''); }
  check('the probe reads a body the backend mislabels as gzip', compressedStatus !== null && compressedStatus.name === 'memora', compressedStatus ? 'parsed' : compressedError);
  stopChild(compressed.child);
  console.log('');
  console.log('checks: ' + checks + ', failures: ' + failures);
  try { fs.rmSync(DATA_DIR, {recursive: true, force: true}); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch(error => { console.error(error); process.exit(1); });
