/**
 * fit() must never frame a graph against a canvas that has no size yet.
 *
 * The defect this pins: selectWorkflow() + render() + canvas.fit() run during the first paint, and at
 * that instant the SVG has not been laid out, so getBoundingClientRect() is 0x0. The old code divided
 * by a zero-size box, produced a tiny scale with a large negative translate, and parked the whole
 * workflow outside the viewport. The stage looked EMPTY while the status line said 已保存 5 个节点 --
 * a demo workflow the user could not see. Pressing 适应窗口 appeared to "fix" it, which is what made
 * it look like a rendering glitch instead of a fit bug.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';

// Minimal DOM: only what DagCanvas touches on the fit path.
class El {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.attrs = {};
    this.style = {};
    this.width = 0;
    this.height = 0;
    this.parent = null;
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  append(...kids) { for (const k of kids) { k.parent = this; this.children.push(k); } }
  replaceChildren(...kids) { this.children = []; this.append(...kids); }
  addEventListener() {}
  removeEventListener() {}
  setPointerCapture() {}
  releasePointerCapture() {}
  getBoundingClientRect() { return {left: 0, top: 0, width: this.width, height: this.height, right: this.width, bottom: this.height}; }
  querySelector() { return null; }
  get childElementCount() { return this.children.length; }
  get firstElementChild() { return this.children[0] ?? null; }
}

function installDom() {
  const doc = {
    createElementNS: (_ns, tag) => new El(tag),
    createElement: (tag) => new El(tag),
    addEventListener() {},
    removeEventListener() {},
    body: new El('body'),
  };
  globalThis.document = doc;
  globalThis.window = {addEventListener() {}, removeEventListener() {}, devicePixelRatio: 1};
  globalThis.requestAnimationFrame = (fn) => { pending.push(fn); return pending.length; };
  globalThis.cancelAnimationFrame = () => {};
  globalThis.SVGElement = El;
  globalThis.getComputedStyle = () => ({getPropertyValue: () => ''});
}
const pending = [];

async function loadCanvas() {
  const result = await build({entryPoints: ['dag-canvas.ts'], bundle: true, format: 'esm', platform: 'node', write: false});
  return import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
}

installDom();
const {DagCanvas} = await loadCanvas();

function makeCanvas(size) {
  const host = new El('div');
  const canvas = new DagCanvas(host, {onSelect() {}, onChange() {}, onNotice() {}});
  // getBoundingClientRect reads these off the <svg> the canvas built for itself.
  canvas.svg.width = size;
  canvas.svg.height = size;
  return canvas;
}

/** The transform is committed on the inner <g class="dag-viewport">, not on the <svg>. */
function viewTransform(canvas) {
  const viewport = canvas.svg.children.find((c) => c.attrs && c.attrs.class === 'dag-viewport');
  return viewport ? (viewport.attrs.transform ?? undefined) : undefined;
}

const NODES = [
  {id: 'a', operation: 'extract_relations', model: 'memory-judge', instruction: '', x: 80, y: 200},
  {id: 'b', operation: 'classify', model: 'memory-judge', instruction: '', x: 340, y: 200},
];

/** Every test starts with an empty frame queue; a stale callback would look like this test's own. */
function fresh() {
  pending.length = 0;
}

test('fit() defers instead of framing against a zero-sized canvas', () => {
  fresh();
  const canvas = makeCanvas(0);
  canvas.render({nodes: NODES, edges: [], statuses: new Map(), cycles: {nodes: new Set(), edges: new Set()}, selected: null});
  canvas.fit();
  // Nothing may be committed from a 0x0 box; a frame is queued instead.
  assert.equal(canvas.svg.attrs.transform, undefined, 'a 0x0 canvas must not produce a transform');
  assert.ok(pending.length >= 1, 'fit() must schedule itself once the canvas has a size');
});

test('the deferred fit frames the graph once the canvas has a size', () => {
  fresh();
  const canvas = makeCanvas(0);
  canvas.render({nodes: NODES, edges: [], statuses: new Map(), cycles: {nodes: new Set(), edges: new Set()}, selected: null});
  canvas.fit();
  assert.ok(pending.length >= 1, 'expected a deferred fit');
  // The canvas gets laid out before the frame runs, as in a browser.
  canvas.svg.width = 747;
  canvas.svg.height = 480;
  const queued = pending.splice(0, pending.length);
  for (const fn of queued) fn();
  const transform = viewTransform(canvas);
  assert.ok(transform, 'the deferred fit must commit a transform');
  const scale = Number(/scale\(([-\d.]+)\)/.exec(transform)[1]);
  assert.ok(scale >= 0.25 && scale <= 2, 'scale ' + scale + ' must be inside the documented clamp');
});

test('a canvas that already has a size commits the fit immediately', () => {
  fresh();
  const canvas = makeCanvas(747);
  canvas.render({nodes: NODES, edges: [], statuses: new Map(), cycles: {nodes: new Set(), edges: new Set()}, selected: null});
  canvas.fit();
  const transform = viewTransform(canvas);
  assert.ok(transform, 'a laid-out canvas must be framed synchronously');
  assert.equal(pending.length, 0, 'no frame should be queued when the canvas is already measurable');
});

test('an empty graph still resets the view without waiting for a size', () => {
  fresh();
  const canvas = makeCanvas(0);
  canvas.render({nodes: [], edges: [], statuses: new Map(), cycles: {nodes: new Set(), edges: new Set()}, selected: null});
  canvas.fit();
  const transform = viewTransform(canvas);
  assert.ok(transform, 'the empty-state view must be committed even on a 0x0 canvas');
  assert.equal(pending.length, 0, 'the empty graph needs no deferral');
});
