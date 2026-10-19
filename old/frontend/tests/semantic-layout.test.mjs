import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const output = await build({entryPoints: ['semantic-layout.ts'], bundle: true, platform: 'node', format: 'esm', write: false});
const { semanticLayout } = await import('data:text/javascript;base64,' + Buffer.from(output.outputFiles[0].text).toString('base64'));

test('relationship layout is deterministic independent of node input order and never mutates evidence', () => {
  const nodes = Array.from({length: 30}, (_, i) => ({id: 'node-' + i, category: 'group-' + (i % 3)}));
  const links = [{a: 'node-1', b: 'node-4'}, {a: 'missing', b: 'node-3'}];
  const snapshot = JSON.stringify({nodes, links});
  const a = semanticLayout(nodes, links), b = semanticLayout([...nodes].reverse(), links);
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify({nodes, links}), snapshot);
  assert.equal(a.size, 30);
  assert.ok([...a.values()].every(p => Number.isFinite(p.x) && Number.isFinite(p.y)));
  assert.ok(new Set([...a.values()].map(p => p.x.toFixed(2) + ',' + p.y.toFixed(2))).size > 28);
});

test('stored links pull endpoints together without inventing a relationship', () => {
  const nodes = Array.from({length: 15}, (_, i) => ({id: 'n-' + i, category: 'same'}));
  const free = semanticLayout(nodes, []);
  const distance = (map, a, b) => Math.hypot(map.get(a).x - map.get(b).x, map.get(a).y - map.get(b).y);
  const pairs = nodes.flatMap(a => nodes.filter(b => a.id < b.id).map(b => [a.id, b.id]));
  const [a, b] = pairs.sort((x, y) => distance(free, ...y) - distance(free, ...x))[0];
  assert.ok(distance(semanticLayout(nodes, [{a, b}]), a, b) < distance(free, a, b));
});

test('empty and single-node maps remain valid', () => {
  assert.equal(semanticLayout([], []).size, 0);
  assert.equal(semanticLayout([{id:'one', category:'fact'}], []).size, 1);
});
