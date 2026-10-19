import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';

async function load(entry) {
  const result = await build({entryPoints:[entry], bundle:true, format:'esm', platform:'node', write:false});
  return import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
}

const best = await load('best-view.ts');

/** A fake clock so the selector can be driven without waiting 12 real seconds. */
function clock() {
  let now = 0;
  const timers = [];
  return {
    now: () => now,
    setTimeoutImpl(fn, ms) { const timer = {at: now + Math.max(0, ms), fn, cancelled: false}; timers.push(timer); return timer; },
    clearTimeoutImpl(timer) { if (timer) timer.cancelled = true; },
    /** Advance the clock, firing every timer that becomes due, oldest first. */
    advance(ms) {
      const target = now + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers.find(t => !t.cancelled && t.at <= target);
        if (!next) break;
        next.cancelled = true;
        now = next.at;
        next.fn();
      }
      now = target;
    },
    pending: () => timers.filter(t => !t.cancelled).length,
  };
}

test('the automatic run waits for the layout to settle, then moves exactly once', () => {
  const time = clock();
  let settled = false;
  const calls = [];
  const seam = best.installBestView({
    settled: () => settled,
    apply: (ms) => { calls.push(ms); return {azimuth: 1.2, polar: 0.5, source: 'focus', moved: true}; },
  }, {now: time.now, setTimeoutImpl: time.setTimeoutImpl, clearTimeoutImpl: time.clearTimeoutImpl,
      delayMs: 650, reducedMotion: () => false});
  time.advance(1000);
  assert.equal(calls.length, 0, 'it must not move while the layout is still settling');
  settled = true;
  time.advance(200);
  assert.equal(calls.length, 0, 'the delay after settling has not elapsed yet');
  time.advance(700);
  assert.equal(calls.length, 1, 'exactly one automatic move');
  assert.equal(calls[0], 650, 'the configured animation duration');
  assert.equal(seam.attempts, 1);
  // Once it has run it stops: the reader owns the camera from here on.
  time.advance(5000);
  assert.equal(calls.length, 1, 'the automatic run must not repeat');
  seam.dispose();
});

test('a click on 最佳视角 can move again after the automatic run', () => {
  const time = clock();
  const calls = [];
  const seam = best.installBestView({
    settled: () => true,
    apply: (ms) => { calls.push(ms); return {azimuth: 0, polar: 0.4, source: 'focus', moved: true}; },
  }, {now: time.now, setTimeoutImpl: time.setTimeoutImpl, clearTimeoutImpl: time.clearTimeoutImpl, reducedMotion: () => false});
  time.advance(1000);
  assert.equal(calls.length, 1);
  const outcome = seam.run();
  assert.ok(outcome && outcome.polar === 0.4);
  assert.equal(calls.length, 2, 'the button searches again');
  assert.equal(seam.attempts, 2);
  seam.dispose();
});

test('an empty graph is retried until the timeout instead of latching a failure', () => {
  const time = clock();
  let nodes = 0;
  const calls = [];
  const seam = best.installBestView({
    settled: () => true,
    apply: () => { calls.push(nodes); return nodes >= 2 ? {azimuth: 1, polar: 1, source: 'focus', moved: true} : null; },
  }, {now: time.now, setTimeoutImpl: time.setTimeoutImpl, clearTimeoutImpl: time.clearTimeoutImpl,
      delayMs: 100, timeoutMs: 1000, reducedMotion: () => false});
  time.advance(400);
  assert.ok(calls.length >= 2, 'it keeps trying while the graph is empty: ' + calls.length);
  nodes = 3;
  time.advance(400);
  assert.equal(seam.attempts, 1, 'it moves as soon as there is something to frame');
  assert.equal(time.pending(), 0, 'and then stops');
  seam.dispose();
});

test('a view that never settles gives up instead of polling forever', () => {
  const time = clock();
  const seam = best.installBestView({
    settled: () => false,
    apply: () => ({azimuth: 0, polar: 0, source: 'focus', moved: true}),
  }, {now: time.now, setTimeoutImpl: time.setTimeoutImpl, clearTimeoutImpl: time.clearTimeoutImpl,
      timeoutMs: 2000, reducedMotion: () => false});
  time.advance(5000);
  assert.equal(seam.attempts, 0);
  assert.equal(time.pending(), 0, 'the watcher must release its timer');
  seam.dispose();
});

test('reduced motion still rotates, it just does not animate', () => {
  const time = clock();
  const durations = [];
  const seam = best.installBestView({
    settled: () => true,
    apply: (ms) => { durations.push(ms); return {azimuth: 1, polar: 1, source: 'focus', moved: true}; },
  }, {now: time.now, setTimeoutImpl: time.setTimeoutImpl, clearTimeoutImpl: time.clearTimeoutImpl,
      reducedMotion: () => true});
  time.advance(2000);
  assert.deepEqual(durations, [0], 'a reduced-motion reader gets the pose immediately');
  seam.dispose();
});

test('dispose stops both the automatic run and the retries', () => {
  const time = clock();
  let calls = 0;
  const seam = best.installBestView({
    settled: () => false,
    apply: () => { calls += 1; return {azimuth: 0, polar: 0, source: 'focus', moved: true}; },
  }, {now: time.now, setTimeoutImpl: time.setTimeoutImpl, clearTimeoutImpl: time.clearTimeoutImpl,
      reducedMotion: () => false});
  time.advance(500);
  seam.dispose();
  time.advance(20000);
  assert.equal(calls, 0);
  assert.equal(seam.run(), null, 'a disposed seam refuses to move');
});

test('the label the toolbar uses is stable', () => {
  assert.equal(best.BEST_VIEW_LABEL, '最佳视角');
});
