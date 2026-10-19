import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';

async function loadModel() {
  const result = await build({entryPoints:['dag-model.ts'], bundle:true, format:'esm', platform:'node', write:false});
  return import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
}

const m = await loadModel();

const node = (id, extra = {}) => ({id, operation:'summarize', model:'local-small', instruction:'', ...extra});
const edge = (from, to) => ({from, to});
const placed = (id, x, y) => node(id, {x, y});

/** Position map as plain [id, {x,y}] pairs, which is what a saved workflow would carry. */
const saved = (result) => [...result.positions].map(([id, point]) => [id, point.x, point.y]);

// ---------------------------------------------------------------- auto-layout rule

test('a graph with no stored coordinates is laid out instead of piled at the origin', () => {
  const nodes = [node('1'), node('2'), node('3')];
  const edges = [edge('1', '2'), edge('1', '3')];
  assert.equal(m.shouldAutoLayout(nodes, edges), true);
  // The same nodes after layout carry real positions and must then be honoured.
  const laid = m.layoutGraph(nodes, edges);
  const positioned = nodes.map((item) => ({...item, ...laid.positions.get(item.id)}));
  assert.equal(m.shouldAutoLayout(positioned, edges), false);
});

test('nodes all persisted at one single point are not a layout', () => {
  // This is the shape a backend default produces: coordinates exist, but they say
  // nothing, and painting them is the pile-at-the-origin bug the rule exists to stop.
  const nodes = [placed('1', 0, 0), placed('2', 0, 0), placed('3', 0, 0)];
  assert.equal(m.hasStoredLayout(nodes), false);
  assert.equal(m.shouldAutoLayout(nodes, [edge('1', '2'), edge('2', '3')]), true);
});

test('a single positioned card is a real arrangement and is left alone', () => {
  const nodes = [placed('1', 300, 240)];
  assert.equal(m.hasStoredLayout(nodes), true);
  assert.equal(m.shouldAutoLayout(nodes, []), false);
});

test('hand-dragged positions survive a reload: an edge source that is placed wins', () => {
  const nodes = [placed('1', 120, 400), placed('2', 480, 200), node('3')];
  assert.equal(m.shouldAutoLayout(nodes, [edge('1', '2')]), false);
});

test('a half-written coordinate is not a placement', () => {
  assert.equal(m.isPositioned(node('1', {x: 10})), false);
  assert.equal(m.isPositioned(node('1', {x: 10, y: 4})), true);
  // Only x on the source: nothing in the graph is properly placed, so lay it out.
  const nodes = [node('a', {x: 40}), node('b', {x: 90})];
  assert.equal(m.hasStoredLayout(nodes), true); // they do differ...
  assert.equal(m.shouldAutoLayout(nodes, [edge('a', 'b')]), true); // ...but no source is placed
});

test('unconnected cards keep the arrangement they were dragged into', () => {
  const nodes = [placed('a', 100, 100), placed('b', 500, 300)];
  assert.equal(m.shouldAutoLayout(nodes, []), false);
});

test('an empty graph is never laid out', () => {
  assert.equal(m.shouldAutoLayout([], []), false);
  assert.equal(m.hasStoredLayout([]), false);
});

// ---------------------------------------------------------------- layout quality

test('organising twice in a row produces identical positions', () => {
  const nodes = [
    node('a'), node('b'), node('c'), node('d'), node('e'), node('f'),
  ];
  const edges = [
    edge('a', 'b'), edge('a', 'c'), edge('b', 'd'), edge('c', 'd'),
    edge('d', 'e'), edge('d', 'f'), edge('e', 'f'),
  ];
  const first = m.layoutGraph(nodes, edges);
  // Feed the result back in the way the app does: as node coordinates.
  const afterFirst = nodes.map((item) => ({...item, ...first.positions.get(item.id)}));
  const second = m.layoutGraph(afterFirst, edges);
  assert.deepEqual(saved(second), saved(first));
  // And a third pass over the second result still cannot move anything.
  const afterSecond = afterFirst.map((item) => ({...item, ...second.positions.get(item.id)}));
  assert.deepEqual(saved(m.layoutGraph(afterSecond, edges)), saved(first));
});

test('the ordering phase actually removes crossings rather than only averaging', () => {
  // Two parents, two children, wired straight through and declared in the crossing order.
  // A pure barycenter pass leaves this at a fixed point; the transposition polish does not.
  const nodes = [node('p1'), node('p2'), node('c1'), node('c2')];
  const edges = [edge('p1', 'c2'), edge('p2', 'c1')];
  const graph = m.buildGraph(nodes, edges);
  const layers = m.layerNodes(graph.nodeIds, graph.edges, new Set());
  const columns = m.columnsOf(graph.nodeIds, layers);
  const before = m.countCrossings(graph, columns);
  assert.equal(before, 1, 'the declared order crosses once');
  m.orderColumns(graph, columns, 4);
  m.transposeColumns(graph, columns, 4);
  assert.equal(m.countCrossings(graph, columns), 0);
});

test('countCrossings counts inverted pairs between one column pair', () => {
  const graph = m.buildGraph([node('a'), node('b'), node('c'), node('d')], [
    edge('a', 'd'), edge('b', 'c'),
  ]);
  const columns = new Map([[0, ['a', 'b']], [1, ['c', 'd']]]);
  // a->d and b->c cross; c is above d.
  assert.equal(m.countCrossings(graph, columns), 1);
  assert.equal(m.countCrossings(graph, new Map([[0, ['a', 'b']], [1, ['d', 'c']]])), 0);
});

test('edges inside a layer keep a uniform length from card to card', () => {
  const options = {cardWidth: 100, cardHeight: 40, columnGap: 20, rowGap: 10, originX: 0, originY: 0, orderRounds: 4};
  const nodes = [node('a'), node('b'), node('c'), node('d'), node('e')];
  // a fans out to three; the far column holds two. Every forward edge is one column wide.
  const edges = [edge('a', 'b'), edge('a', 'c'), edge('a', 'd'), edge('b', 'e'), edge('c', 'e')];
  const result = m.layoutGraph(nodes, edges, options);
  const xs = [...result.positions.values()].map((point) => point.x);
  for (const x of xs) assert.equal((x - Math.min(...xs)) % 120, 0, 'columns are exactly one pitch apart');
  const pitches = new Set([...result.positions.values()].map((point) => point.y));
  const sorted = [...pitches].sort((left, right) => left - right);
  for (let index = 1; index < sorted.length; index += 1) {
    assert.equal((sorted[index] - sorted[index - 1]) % 50, 0, 'row offsets are whole pitches');
  }
});

test('a column slides towards the parent that feeds it without breaking the pitch', () => {
  const graph = m.buildGraph(
    [node('a'), node('b'), node('c'), node('d'), node('e')],
    [edge('a', 'b'), edge('a', 'c'), edge('a', 'd'), edge('c', 'e')],
  );
  const layers = m.layerNodes(graph.nodeIds, graph.edges, new Set());
  const columns = m.columnsOf(graph.nodeIds, layers);
  m.orderColumns(graph, columns, 4);
  m.transposeColumns(graph, columns, 4);
  const rows = m.assignRows(graph, columns);
  // e hangs off the middle of three parents, so it must land on that middle row.
  assert.equal(rows.get('e'), rows.get('c'), JSON.stringify([...rows]));
});

test('layoutGraph stays deterministic for a cyclic graph too', () => {
  const nodes = [node('a'), node('b'), node('c'), node('d')];
  const edges = [edge('a', 'b'), edge('b', 'c'), edge('c', 'a'), edge('c', 'd'), edge('d', 'b')];
  const first = m.layoutGraph(nodes, edges);
  const second = m.layoutGraph(nodes.map((item) => ({...item, ...first.positions.get(item.id)})), edges);
  assert.deepEqual(saved(second), saved(first));
});

// ---------------------------------------------------------------- edge routing

const CARD = m.LAYOUT_DEFAULTS;
/** Separator-free path text, so an assertion can talk about coordinates, not commas. */
const norm = (d) => d.replace(/,/g, ' ');
const endsAt = (d, x, y) => norm(d).trim().endsWith(x + ' ' + y);

/** Every absolute coordinate pair in a path, commands discarded. */
const routePoints = (d) => [...norm(d).matchAll(/(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g)]
  .map((hit) => ({x: Number(hit[1]), y: Number(hit[2])}));

test('a forward edge is a cubic that leaves the right port and enters the left port', () => {
  const from = node('a', {x: 0, y: 0});
  const to = node('b', {x: 400, y: 200});
  const route = m.routeEdge(from, to, [from, to]);
  assert.equal(route.kind, 'forward');
  assert.ok(norm(route.d).startsWith('M' + CARD.cardWidth + ' ' + CARD.cardHeight / 2), route.d);
  assert.ok(route.d.includes('C'), route.d);
  // The end point is the target's left port, not its centre: the arrow must not sit on the card.
  assert.ok(endsAt(route.d, 400, 200 + CARD.cardHeight / 2), route.d);
});

test('a back edge detours above every card instead of driving through them', () => {
  const from = node('c', {x: 800, y: 300});
  const to = node('a', {x: 100, y: 120});
  const route = m.routeEdge(from, to, [node('a', {x: 100, y: 120}), node('b', {x: 450, y: 420}), from]);
  assert.equal(route.kind, 'back');
  const cards = [
    {left: 100, top: 120},
    {left: 450, top: 420},
    {left: 800, top: 300},
  ].map((card) => ({...card, right: card.left + CARD.cardWidth, bottom: card.top + CARD.cardHeight}));
  const topMost = Math.min(...cards.map((card) => card.top));
  const points = routePoints(route.d);
  // Nothing may pass through the middle of a card. The two endpoints sit on card
  // borders by design (that is where a port is), so they are excluded.
  const inside = (point) => cards.some((card) =>
    point.x > card.left + 1 && point.x < card.right - 1 && point.y > card.top + 1 && point.y < card.bottom - 1);
  const travelling = points.slice(1, -1);
  for (const point of travelling) {
    assert.ok(!inside(point), 'path point ' + JSON.stringify(point) + ' is inside a card: ' + route.d);
  }
  // And the detour really goes over the top rather than squeezing between columns.
  assert.ok(Math.min(...points.map((point) => point.y)) < topMost, 'the detour clears the highest card: ' + route.d);
  assert.ok(Math.min(...points.map((point) => point.x)) < 100 + CARD.cardWidth, 'the detour travels back: ' + route.d);
  assert.ok(endsAt(route.d, 100, 120 + CARD.cardHeight / 2), route.d);
});

test('a self loop leaves the card and comes back as a visible ring', () => {
  const only = node('solo', {x: 200, y: 200});
  const route = m.routeEdge(only, only, [only]);
  assert.equal(route.kind, 'self');
  assert.ok(route.d.includes('Q'), 'corners are rounded so the ring reads as a loop: ' + route.d);
  // It starts at the right port and ends at the left port of the same card.
  assert.ok(norm(route.d).startsWith('M' + (200 + CARD.cardWidth) + ' ' + (200 + CARD.cardHeight / 2)), route.d);
  assert.ok(endsAt(route.d, 200, 200 + CARD.cardHeight / 2), route.d);
  // The loop must actually be wider than zero: two distinct x values outside the card.
  const numbers = [...route.d.matchAll(/(\d+(?:\.\d+)?)/g)].map((hit) => Number(hit[1]));
  assert.ok(Math.max(...numbers) > 200 + CARD.cardWidth, 'the ring protrudes: ' + route.d);
});

test('rotating a card pair never emits NaN and always produces a drawable path', () => {
  const positions = [0, 150, 400, 900];
  for (const ax of positions) {
    for (const bx of positions) {
      for (const ay of [0, 210]) {
        const from = node('a', {x: ax, y: ay});
        const to = node('b', {x: bx, y: 60});
        const route = m.routeEdge(from, to, [from, to]);
        assert.ok(route.d.startsWith('M'), route.d);
        assert.ok(!route.d.includes('NaN'), route.d);
        assert.ok(!route.d.includes('undefined'), route.d);
      }
    }
  }
});

test('orthPath drops repeated points and rounds real corners', () => {
  assert.equal(m.orthPath([{x: 0, y: 0}], 8), 'M0 0');
  assert.equal(m.orthPath([{x: 0, y: 0}, {x: 0, y: 0}, {x: 10, y: 0}], 8), 'M0 0 L10 0');
  const rounded = m.orthPath([{x: 0, y: 0}, {x: 10, y: 0}, {x: 10, y: 10}], 4);
  assert.ok(rounded.includes('Q10 0'), rounded);
});

// ---------------------------------------------------------------- reduced motion

test('reduced motion collapses the organize transition to one frame', () => {
  assert.deepEqual(m.organizeSchedule(true), [1]);
});

test('the animated organize transition eases out and lands exactly on 1', () => {
  const steps = m.organizeSchedule(false, 320);
  assert.ok(steps.length > 1);
  assert.equal(steps[steps.length - 1], 1);
  // Monotone: the cards never move backwards during the transition.
  for (let index = 1; index < steps.length; index += 1) {
    assert.ok(steps[index] >= steps[index - 1], JSON.stringify(steps));
  }
  // Ease-out: most of the distance is covered early.
  assert.ok(steps[0] > 0 && steps[Math.floor(steps.length / 2)] > 0.5, JSON.stringify(steps));
});
