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

test('operationLabel localizes known operations and never invents one for an unknown id', () => {
  assert.equal(m.operationLabel('verify'), '\u6838\u5bf9\u8bc1\u636e');
  assert.equal(m.operationLabel('classify'), '\u5224\u5b9a\u5206\u7c7b');
  assert.equal(m.operationLabel('organize_markdown'), '\u6574\u7406 Markdown');
  // An unknown id must stay visible rather than being papered over by a wrong label.
  assert.equal(m.operationLabel('summon_oracle'), 'summon_oracle');
});

test('truncate flattens whitespace and marks the cut', () => {
  assert.equal(m.truncate('a  \n b', 10), 'a b');
  assert.equal(m.truncate('abcdef', 4), 'abc\u2026');
  assert.equal(m.truncate('', 4), '');
});

test('text fitting measures CJK as double width and wraps without splitting latin words', () => {
  assert.equal(m.textUnits('\u8fc7\u786e'), 2);
  assert.equal(m.textUnits('ab'), 1);
  assert.equal(m.fitText('\u8fc7\u786e\u76ee\u5f55', 3), '\u8fc7\u786e\u2026');
  const wrapped = m.wrapText('extract durable relations from the quoted source record', 14, 2);
  assert.ok(wrapped.length <= 2, JSON.stringify(wrapped));
  assert.ok(!wrapped.some((line) => line.startsWith(' ') || line.endsWith(' ')), JSON.stringify(wrapped));
});

test('edgeKey separates an edge from its reverse, which matters for cycle attribution', () => {
  assert.notEqual(m.edgeKey('a', 'b'), m.edgeKey('b', 'a'));
  assert.equal(m.edgeKey('a', 'b'), m.edgeKey('a', 'b'));
});

test('buildGraph drops dangling endpoints and de-duplicates while keeping input order', () => {
  const graph = m.buildGraph([node('a'), node('b')], [edge('a', 'b'), edge('a', 'b'), edge('a', 'ghost')]);
  assert.deepEqual(graph.nodeIds, ['a', 'b']);
  assert.equal(graph.edges.length, 1);
  assert.deepEqual(graph.outgoing.get('a'), ['b']);
  assert.deepEqual(graph.incoming.get('b'), ['a']);
});

test('an acyclic graph reports no cycle nodes and no cycle edges', () => {
  const nodes = [node('a'), node('b'), node('c'), node('d')];
  const report = m.detectCycles(nodes, [edge('a', 'b'), edge('a', 'c'), edge('b', 'd'), edge('c', 'd')]);
  assert.equal(report.nodes.size, 0);
  assert.equal(report.edges.length, 0);
  assert.equal(report.edgeKeys.size, 0);
});

test('a self loop is a cycle', () => {
  const report = m.detectCycles([node('a')], [edge('a', 'a')]);
  assert.deepEqual([...report.nodes], ['a']);
  assert.deepEqual(report.edges, [edge('a', 'a')]);
});

test('both edges of a two node cycle are flagged, and only one is needed to break it', () => {
  const report = m.detectCycles([node('a'), node('b')], [edge('a', 'b'), edge('b', 'a')]);
  assert.deepEqual([...report.nodes].sort(), ['a', 'b']);
  assert.deepEqual(report.edges, [edge('a', 'b'), edge('b', 'a')]);
  assert.equal(report.feedbackEdges.length, 1);
});

test('a cycle does not drag its downstream tail into the highlight', () => {
  // d hangs off the cycle but is not on it: marking it would blame the wrong node.
  const report = m.detectCycles(
    [node('a'), node('b'), node('c'), node('d')],
    [edge('a', 'b'), edge('b', 'c'), edge('c', 'a'), edge('c', 'd')],
  );
  assert.deepEqual([...report.nodes].sort(), ['a', 'b', 'c']);
  assert.ok(!report.nodes.has('d'));
  // The three cycle edges are flagged; the tail edge c->d is not.
  assert.equal(report.edges.length, 3);
  assert.ok(!report.edgeKeys.has(m.edgeKey('c', 'd')));
});

test('disjoint cycles are both reported and both have a closing edge', () => {
  const report = m.detectCycles(
    [node('a'), node('b'), node('c'), node('d')],
    [edge('a', 'b'), edge('b', 'a'), edge('c', 'd'), edge('d', 'c')],
  );
  assert.equal(report.nodes.size, 4);
  assert.equal(report.edges.length, 4);
  assert.equal(report.feedbackEdges.length, 2);
});

test('every edge that lies on some cycle is reported, not just the DFS back edges', () => {
  const report = m.detectCycles(
    [node('a'), node('b'), node('c')],
    [edge('a', 'b'), edge('b', 'c'), edge('c', 'a'), edge('c', 'b')],
  );
  // a->b, b->c, c->a and the extra c->b all close a cycle: none of them can stay unflagged.
  assert.equal(report.edges.length, 4);
  for (const [from, to] of [['a','b'],['b','c'],['c','a'],['c','b']]) {
    assert.ok(report.edgeKeys.has(m.edgeKey(from, to)), from + '->' + to);
  }
});

test('longest-path layering puts a chain in consecutive columns', () => {
  const ids = ['a', 'b', 'c', 'd'];
  const layers = m.layerNodes(ids, [edge('a', 'b'), edge('b', 'c'), edge('c', 'd')], new Set());
  assert.deepEqual(ids.map((id) => layers.get(id)), [0, 1, 2, 3]);
});

test('longest-path layering sends a diamond join past both branches', () => {
  const layers = m.layerNodes(
    ['a', 'b', 'c', 'd'],
    [edge('a', 'b'), edge('a', 'c'), edge('b', 'd'), edge('c', 'd')],
    new Set(),
  );
  assert.deepEqual([...layers].map(([id, layer]) => [id, layer]), [['a', 0], ['b', 1], ['c', 1], ['d', 2]]);
});

test('layering drops only the feedback edges, so a cycle still spans columns', () => {
  const cycles = m.detectCycles(
    [node('a'), node('b'), node('c'), node('d')],
    [edge('a', 'b'), edge('b', 'c'), edge('c', 'a'), edge('c', 'd')],
  );
  const layers = m.layerNodes(
    ['a', 'b', 'c', 'd'],
    [edge('a', 'b'), edge('b', 'c'), edge('c', 'a'), edge('c', 'd')],
    cycles.feedbackEdgeKeys,
  );
  assert.deepEqual([...layers].map(([id, layer]) => [id, layer]), [['a', 0], ['b', 1], ['c', 2], ['d', 3]]);
});

test('barycenter ordering reorders a column so it follows its parent column', () => {
  // p hangs off y and q off x, but p was drawn first: the sweep must swap them.
  const graph = m.buildGraph([node('x'), node('y'), node('p'), node('q')], [edge('y', 'p'), edge('x', 'q')]);
  const layers = m.layerNodes(graph.nodeIds, graph.edges, new Set());
  const columns = m.columnsOf(graph.nodeIds, layers);
  assert.deepEqual(columns.get(1), ['p', 'q']);
  m.orderColumns(graph, columns, 4);
  assert.deepEqual(columns.get(1), ['q', 'p']);
});

test('layoutGraph places nodes on the configured grid and is deterministic', () => {
  const options = {cardWidth:100, cardHeight:40, columnGap:20, rowGap:10, originX:0, originY:0};
  const nodes = [node('1'), node('2'), node('3'), node('4')];
  const edges = [edge('1', '2'), edge('1', '3'), edge('2', '4'), edge('3', '4')];
  const first = m.layoutGraph(nodes, edges, options);
  const second = m.layoutGraph(nodes, edges, options);
  const at = (id) => first.positions.get(id);
  // Column 0 holds one card, column 1 holds two: the tallest column is centred on the origin.
  assert.deepEqual(at('1'), {x:0, y:-45});
  assert.equal(at('2').x, 120);
  assert.equal(at('4').x, 240);
  assert.deepEqual([at('2').y, at('3').y].sort((x, y) => x - y), [-45, 5]);
  assert.deepEqual([...first.positions], [...second.positions]);
  assert.equal(first.depth, 2);
  assert.equal(first.width, 2);
});

test('layoutGraph never returns NaN even for a fully cyclic graph', () => {
  const result = m.layoutGraph(
    [node('a'), node('b'), node('c')],
    [edge('a', 'b'), edge('b', 'c'), edge('c', 'a')],
  );
  for (const point of result.positions.values()) {
    assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y), JSON.stringify(point));
  }
  assert.equal(result.cycleNodes.size, 3);
  assert.equal(result.cycleEdges.length, 3);
});

test('layoutGraph on an empty graph returns empty maps instead of throwing', () => {
  const result = m.layoutGraph([], []);
  assert.equal(result.positions.size, 0);
  assert.equal(result.depth, -1);
  assert.equal(result.width, 0);
});

test('wouldCycle predicts whether a proposed connection is safe', () => {
  const nodes = [node('1'), node('2'), node('3')];
  const edges = [edge('1', '2'), edge('2', '3')];
  assert.equal(m.wouldCycle(nodes, edges, '3', '1'), true);
  assert.equal(m.wouldCycle(nodes, edges, '1', '3'), false);
  assert.equal(m.wouldCycle(nodes, edges, '2', '2'), true);
});

test('graphBounds covers the current manual positions', () => {
  const bounds = m.graphBounds([node('a', {x:10, y:20}), node('b', {x:210, y:140})]);
  assert.deepEqual(bounds, {x:10, y:20, width:224 + 200, height:96 + 120});
});

test('no run means every node is pending', () => {
  const nodes = [node('1'), node('2')];
  const statuses = m.nodeStatuses([], 'wf', nodes);
  assert.deepEqual([...statuses.values()], ['pending', 'pending']);
});

test('a finished run marks every node succeeded', () => {
  const nodes = [node('1'), node('2')];
  const statuses = m.nodeStatuses([{workflow:'wf', status:'done', output:{stages:[]}}], 'wf', nodes);
  assert.deepEqual([...statuses.values()], ['succeeded', 'succeeded']);
});

test('a failed or blocked run marks every node failed', () => {
  const nodes = [node('1'), node('2')];
  for (const status of ['failed', 'blocked', 'cancelled']) {
    const statuses = m.nodeStatuses([{workflow:'wf', status}], 'wf', nodes);
    assert.deepEqual([...statuses.values()], ['failed', 'failed'], status);
  }
});

test('a live run shows the finished stages done and the unblocked next node running', () => {
  const nodes = [node('1'), node('2'), node('3')];
  const runs = [{workflow:'wf', status:'running', output:{stages:[{stage:'1'}]}}];
  const statuses = m.nodeStatuses(runs, 'wf', nodes);
  assert.deepEqual([...statuses.values()], ['succeeded', 'running', 'pending']);
});

test('a live run leaves later nodes pending while an upstream one is still running', () => {
  const nodes = [node('1'), node('2'), node('3')];
  const runs = [{workflow:'wf', status:'running', output:{stages:[]}}];
  const statuses = m.nodeStatuses(runs, 'wf', nodes);
  assert.deepEqual([...statuses.values()], ['running', 'pending', 'pending']);
});

test('a failed run keeps the stages it did finish marked succeeded', () => {
  const nodes = [node('1'), node('2')];
  const runs = [{workflow:'wf', status:'failed', output:{stages:[{stage:'1'}]}}];
  const statuses = m.nodeStatuses(runs, 'wf', nodes);
  assert.deepEqual([...statuses.values()], ['succeeded', 'failed']);
});

test('runs belonging to another workflow never paint this one', () => {
  const nodes = [node('1')];
  const statuses = m.nodeStatuses([{workflow:'other', status:'done', output:{stages:[{stage:'1'}]}}], 'wf', nodes);
  assert.deepEqual([...statuses.values()], ['pending']);
});
