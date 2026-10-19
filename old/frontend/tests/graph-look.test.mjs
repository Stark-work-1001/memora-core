import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';

async function load(entry) {
  const result = await build({entryPoints:[entry], bundle:true, format:'esm', platform:'node', write:false});
  return import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
}

const look = await load('graph-look.ts');

/** A label box, in the units the browser reports. */
const box = (id, left, top, width = 100, height = 14, priority = 3) => ({id, left, top, width, height, priority});

test('overlapping ordinary labels are dropped, keeping the first in reading order', () => {
  const boxes = [box('a', 0, 0), box('b', 20, 5), box('c', 0, 40), box('d', 500, 400)];
  const keep = look.pickLabels(boxes);
  // 'a' is placed first; 'b' lands on it and is dropped; 'c' and 'd' do not touch anything.
  assert.deepEqual([...keep].sort(), ['a', 'c', 'd']);
});

test('a label that only touches its neighbour is kept', () => {
  // Two boxes 4 px apart vertically: touching is fine, overlapping is not.
  const keep = look.pickLabels([box('a', 0, 0, 100, 14), box('b', 0, 18, 100, 14)]);
  assert.deepEqual([...keep].sort(), ['a', 'b']);
});

test('the selected term and its neighbours are never dropped for space', () => {
  // Every box overlaps every other one: without the priority rule nothing would survive but one.
  const boxes = [box('s', 0, 0, 400, 40, 0), box('n', 10, 10, 400, 40, 1), box('o1', 20, 20, 400, 40), box('o2', 30, 30, 400, 40)];
  const keep = look.pickLabels(boxes);
  assert.ok(keep.has('s') && keep.has('n'), 'priority labels were dropped: ' + [...keep]);
  // Ordinary labels that collide with them still give way.
  assert.equal(keep.size, 2, 'an ordinary label squeezed into the same space should drop: ' + [...keep]);
});

test('a crowded first frame keeps only what fits, and that is fewer than were offered', () => {
  const boxes = [];
  for (let i = 0; i < 12; i++) boxes.push(box('label-' + i, (i % 4) * 30, Math.floor(i / 4) * 8));
  const keep = look.pickLabels(boxes);
  assert.ok(keep.size < boxes.length, 'nothing was dropped from a deliberately overlapping set');
  // Whatever survived must be pairwise disjoint, which is what the screenshot check asserts.
  const kept = boxes.filter(b => keep.has(b.id));
  for (let i = 0; i < kept.length; i++) for (let j = i + 1; j < kept.length; j++) {
    const a = kept[i], b = kept[j];
    const ox = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
    const oy = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
    assert.ok(!(ox > 2 && oy > 2), a.id + ' overlaps ' + b.id);
  }
});

test('the resting-link and label-density defaults are raised above the vendored ones', async () => {
  // The vendored dictionary defaults (edgeOpacity 0.22, labelDensity 1) were tuned for a
  // 543-term reference dictionary on a dark theme; on a light 14-term memory graph the links
  // were invisible and the names overprinted. Both tuned values must stay inside the range
  // the vendored clampSettings() accepts, or the host would silently reset them.
  assert.ok(look.RESTING_EDGE_OPACITY > 0.22 && look.RESTING_EDGE_OPACITY <= 1, look.RESTING_EDGE_OPACITY);
  assert.ok(look.MEMORY_LABEL_DENSITY < 1 && look.MEMORY_LABEL_DENSITY > 0, look.MEMORY_LABEL_DENSITY);
});
