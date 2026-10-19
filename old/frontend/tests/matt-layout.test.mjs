import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

async function load(entry) {
  const result = await build({entryPoints:[entry], bundle:true, format:'esm', platform:'node', write:false});
  return import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
}

const here = path.dirname(fileURLToPath(import.meta.url));
const layout = await load('matt-layout.ts');

/**
 * A graph shaped the way the Markdown projection produces one: four sections, dense inside each
 * section, a few bridges across. Deliberately not the reference dictionary -- the layout has to
 * work for whatever Memora's projection yields, and the reference's exact numbers are checked
 * separately below against the reference's own JSON.
 */
function fixture() {
  const nodes = [];
  const edges = [];
  const sizes = [5, 4, 6, 3];
  let at = 0;
  sizes.forEach((size, section) => {
    for (let i = 0; i < size; i++) {
      nodes.push({slug: 'term-' + at, title: 'term ' + at, section, inDegree: 0, position: [0, 0, 0]});
      at++;
    }
  });
  const ids = sizes.map((size, section) => {
    const start = sizes.slice(0, section).reduce((a, b) => a + b, 0);
    return Array.from({length: size}, (_, i) => start + i);
  });
  // A path plus a hub inside each section: enough internal structure for the density to differ.
  ids.forEach((members) => {
    for (let i = 1; i < members.length; i++) edges.push({source: members[0], target: members[i], control: null});
    for (let i = 1; i + 1 < members.length; i++) edges.push({source: members[i], target: members[i + 1], control: null});
  });
  // Bridges between consecutive sections (and one far bridge), like the projection's cross-links.
  edges.push({source: ids[0][0], target: ids[1][0], control: null});
  edges.push({source: ids[1][1], target: ids[2][0], control: null});
  edges.push({source: ids[2][1], target: ids[3][0], control: null});
  edges.push({source: ids[0][1], target: ids[3][1], control: null});
  for (const edge of edges) { nodes[edge.source].inDegree++; nodes[edge.target].inDegree++; }
  return {
    title: 'fixture', subtitle: '', orderedSlugs: nodes.map(n => n.slug),
    sections: sizes.map((_, index) => ({title: 'section-' + index, index})),
    nodes, edges,
  };
}

const clone = value => JSON.parse(JSON.stringify(value));
const midpoint = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// --- the three rules ---------------------------------------------------------

test('every same-section edge is a straight line (control === null)', () => {
  const graph = fixture();
  const report = layout.bakeNebula(graph);
  let sameSection = 0;
  for (const edge of graph.edges) {
    if (graph.nodes[edge.source].section !== graph.nodes[edge.target].section) continue;
    sameSection++;
    assert.equal(edge.control, null, 'edge ' + edge.source + '->' + edge.target + ' must be straight');
  }
  assert.ok(sameSection > 0, 'fixture has no same-section edges to check');
  assert.equal(report.straightEdges, sameSection);
});

test('every cross-section edge curves by exactly 0.16 of its own length', () => {
  const graph = fixture();
  const report = layout.bakeNebula(graph);
  let cross = 0;
  for (const edge of graph.edges) {
    const from = graph.nodes[edge.source];
    const to = graph.nodes[edge.target];
    if (from.section === to.section) continue;
    cross++;
    assert.ok(edge.control, 'edge ' + edge.source + '->' + edge.target + ' has no control point');
    const span = distance(from.position, to.position);
    const offset = distance(edge.control, midpoint(from.position, to.position));
    assert.ok(Math.abs(offset / span - 0.16) < 1e-6,
      'control offset ratio ' + (offset / span) + ' should be 0.16');
    assert.ok(Math.abs(report.controlRatio.min - 0.16) < 1e-6 && Math.abs(report.controlRatio.max - 0.16) < 1e-6,
      'reported control ratios: ' + JSON.stringify(report.controlRatio));
  }
  assert.ok(cross > 0, 'fixture has no cross-section edges to check');
  assert.equal(report.curvedEdges, cross);
  assert.equal(report.curveRatio, 0.16);
});

test('the curve bulges away from the centre of the cloud', () => {
  const graph = fixture();
  layout.bakeNebula(graph);
  const origin = layout.centreOf(graph);
  for (const edge of graph.edges) {
    if (!edge.control) continue;
    const from = graph.nodes[edge.source].position;
    const to = graph.nodes[edge.target].position;
    const mid = midpoint(from, to);
    const outward = [mid[0] - origin[0], mid[1] - origin[1], mid[2] - origin[2]];
    const push = [edge.control[0] - mid[0], edge.control[1] - mid[1], edge.control[2] - mid[2]];
    const cos = (outward[0] * push[0] + outward[1] * push[1] + outward[2] * push[2])
      / (Math.hypot(...outward) * Math.hypot(...push));
    assert.ok(cos > 0.999, 'curve direction cos ' + cos + ' should be ~1 (radially outward)');
  }
});

// --- determinism -------------------------------------------------------------

test('the same input bakes to bit-identical output', () => {
  const first = fixture();
  const second = fixture();
  const firstReport = layout.bakeNebula(first);
  const secondReport = layout.bakeNebula(second);
  assert.deepEqual(first.nodes.map(n => n.position), second.nodes.map(n => n.position));
  assert.deepEqual(first.edges.map(e => e.control), second.edges.map(e => e.control));
  assert.deepEqual(JSON.parse(JSON.stringify(firstReport)), JSON.parse(JSON.stringify(secondReport)));
});

test('baking twice into the same object is idempotent', () => {
  const graph = fixture();
  layout.bakeNebula(graph);
  const once = clone(graph);
  layout.bakeNebula(graph);
  assert.deepEqual(graph.nodes.map(n => n.position), once.nodes.map(n => n.position));
  assert.deepEqual(graph.edges.map(e => e.control), once.edges.map(e => e.control));
});

test('two graphs that differ only by a title bake differently (the seed is content)', () => {
  const first = fixture();
  const second = fixture();
  second.sections[0].title = 'a different section title';
  layout.bakeNebula(first);
  layout.bakeNebula(second);
  assert.notDeepEqual(first.nodes.map(n => n.position), second.nodes.map(n => n.position));
});

// --- the nebula, not a ball of dots and not seven separate balls -------------

test('every term stays inside its own shell (<= radius * 1.05)', () => {
  const graph = fixture();
  const report = layout.bakeNebula(graph);
  const shellOf = new Map();
  for (const shell of report.shells) for (const node of graph.nodes) if (node.section === shell.index) shellOf.set(node.slug, shell);
  for (const node of graph.nodes) {
    const shell = shellOf.get(node.slug);
    const ratio = distance(node.position, shell.centroid) / shell.radius;
    assert.ok(ratio <= 1.05, node.slug + ' sits at ' + ratio + ' of its shell radius');
  }
  assert.ok(report.radialRatio.max <= 1.05, 'reported radial ratio: ' + JSON.stringify(report.radialRatio));
});

/** Overlap of one shell pair, as a fraction of the pair's combined reach. */
function overlapFractions(shells) {
  const fractions = [];
  for (let i = 0; i < shells.length; i++) {
    for (let j = i + 1; j < shells.length; j++) {
      const reach = shells[i].radius + shells[j].radius;
      fractions.push((reach - distance(shells[i].centroid, shells[j].centroid)) / reach);
    }
  }
  return fractions.sort((a, b) => a - b);
}

test('section centres sit on one nearly flat ring, like the reference', () => {
  const graph = fixture();
  const report = layout.bakeNebula(graph);
  assert.equal(report.shells.length, 4);
  // The reference's seven centres are 72-146 units out with only -14..+25 of lift: a ring, not a
  // sphere. That is what makes the sections read as lobes beside each other under an orbit camera.
  const ringRadii = report.shells.map(shell => shell.centreDistance);
  const mean = ringRadii.reduce((a, b) => a + b, 0) / ringRadii.length;
  for (const radius of ringRadii) assert.ok(Math.abs(radius - mean) < mean * 0.45,
    'a centre leaves the ring: ' + JSON.stringify(ringRadii.map(v => +v.toFixed(1))));
  const lift = report.shells.map(shell => Math.abs(shell.centroid[1]));
  assert.ok(Math.max(...lift) < mean * 0.35, 'the ring is not flat: lifts ' + JSON.stringify(lift.map(v => +v.toFixed(1))));
  assert.ok(mean > 0, 'the ring has no radius');
});

test('the shells overlap enough to read as one nebula, and apart enough to read as lobes', () => {
  const graph = fixture();
  const report = layout.bakeNebula(graph);
  const fractions = overlapFractions(report.shells);
  const median = fractions[Math.floor(fractions.length / 2)];
  // Every pair intersects -- that is the reference's defining trait (all 21 of its pairs overlap,
  // shallowest 3.8%, median 46%). The ring is sized so that holds by construction, which is what
  // "one interlocking nebula" means and is checked here rather than assumed.
  assert.ok(fractions[0] > 0, 'a pair of shells does not intersect: ' + fractions.map(f => +f.toFixed(3)));
  assert.ok(median > 0.2, 'the typical pair of shells barely overlaps: median ' + median);
  assert.ok(report.geometry.shellOverlaps.min > 0,
    'reported overlaps disagree: ' + JSON.stringify(report.geometry.shellOverlaps));
  // The other side of it: at 2-4 members per section a deep overlap would merge two clumps into
  // one, so the report has to say how far the keep-apart floor is from being met instead of
  // pretending both constraints hold.
  assert.ok(report.geometry.crowding >= 1,
    'crowding should be a shortfall multiple >= 1: ' + report.geometry.crowding);
});

test('the cloud is three-dimensional, not a flattened disc', () => {
  const graph = fixture();
  const report = layout.bakeNebula(graph);
  const spreads = [0, 1, 2].map(axis => report.extent.max[axis] - report.extent.min[axis]);
  const smallest = Math.min(...spreads), largest = Math.max(...spreads);
  assert.ok(largest > 0, 'the cloud has no extent');
  // The ring is nearly flat by design, so the vertical extent is the smallest -- but the sections
  // are still spheres, which keeps the cloud from collapsing to a sheet.
  assert.ok(smallest > largest * 0.2, 'one axis is squashed: spreads ' + spreads.map(v => v.toFixed(1)));
});

test('sections are real clumps: members are nearer to each other than to other sections', () => {
  const graph = fixture();
  const report = layout.bakeNebula(graph);
  assert.ok(report.geometry.clumpRatio > 0 && report.geometry.clumpRatio < 0.8,
    'within-section distance ' + report.geometry.withinMedian
    + ' vs between-section ' + report.geometry.betweenMedian);
  assert.ok(report.geometry.nearestNeighbour.min > 0, 'no terms were placed');
});

test('nearestNeighbour and memberSpan are different measurements, not the same number twice', () => {
  // A two-member section has exactly one pair, so the two coincide there by arithmetic. Any section
  // with three or more members must show them as different numbers, or one of them is mislabelled.
  const graph = fixture();
  const report = layout.bakeNebula(graph);
  const large = report.shells.filter(shell => shell.members >= 3);
  assert.ok(large.length > 0, 'fixture has no section with three members');
  assert.ok(large.some(shell => Math.abs(shell.nearestNeighbour - shell.memberSpan) > 1e-9),
    'the two distance measures are identical: ' + JSON.stringify(large.map(s => [s.nearestNeighbour, s.memberSpan])));
  for (const shell of large) {
    assert.ok(shell.nearestNeighbour <= shell.memberSpan + 1e-9,
      shell.title + ': the closest-mate gap cannot exceed the median pair span');
  }
});

test('the member fill profile matches the reference (mean ~0.6 r, max 1.0 r, min >= 0.15 r)', () => {
  const graph = fixture();
  const report = layout.bakeNebula(graph);
  for (const shell of report.shells) {
    if (shell.members < 2) continue;
    assert.ok(shell.radial.max <= 1.001, shell.title + ' has a member outside its shell: ' + shell.radial.max);
    assert.ok(shell.radial.min >= 0.1, shell.title + ' has a member at the centre: ' + shell.radial.min);
    // The reference fills the ball rather than the surface: mean distance ~0.6 of the radius.
    assert.ok(shell.radial.mean > 0.35 && shell.radial.mean < 0.95,
      shell.title + ' fill profile mean ' + shell.radial.mean);
  }
});

test('terms keep a readable gap from each other', () => {
  const graph = fixture();
  const report = layout.bakeNebula(graph);
  assert.ok(report.minNodeDistance > 6, 'closest pair is ' + report.minNodeDistance + ' apart');
});

test('an empty graph bakes without throwing', () => {
  const graph = {nodes: [], edges: [], sections: [], title: 'empty', subtitle: '', orderedSlugs: []};
  const report = layout.bakeNebula(graph);
  assert.equal(report.nodes, 0);
  assert.equal(report.shells.length, 0);
  assert.equal(report.curvedEdges, 0);
});

test('a section the projection names but puts no term in gets no shell', () => {
  const graph = fixture();
  graph.sections.push({title: '显式层级与学习路径', index: 4});
  const report = layout.bakeNebula(graph);
  assert.equal(report.shells.length, 4, 'an empty section should not reserve a shell');
  assert.ok(!report.shells.some(shell => shell.title === '显式层级与学习路径'));
});

test('a single-section graph has no curved edges', () => {
  const graph = fixture();
  graph.nodes.forEach(node => { node.section = 0; });
  const report = layout.bakeNebula(graph);
  assert.equal(report.curvedEdges, 0);
  assert.ok(graph.edges.every(edge => edge.control === null));
});

// --- the reference's own numbers ---------------------------------------------

/**
 * The rules above are not an interpretation of the reference's look: they are its generator.
 *
 * `runtime/matt-dictionary-graph.json` is the AI Coding Dictionary's own baked graph (extracted
 * from its JS bundle). Re-deriving each stored control point from the stored node positions alone
 * must land on the stored value, up to the rounding bound of the JSON (coordinates are written
 * with two decimals, so a control point can be off by at most sqrt(3)/2 * 0.01 = 0.00866).
 */
const referencePath = path.resolve(here, '..', '..', 'runtime', 'matt-dictionary-graph.json');
const hasReference = fs.existsSync(referencePath);

test('the measured rules reproduce the reference site\'s own baked control points', {skip: !hasReference && 'reference JSON not present'}, () => {
  const reference = JSON.parse(fs.readFileSync(referencePath, 'utf8'));
  const bySlug = new Map(reference.nodes.map(node => [node.slug, node]));
  const graph = {
    title: 'reference', subtitle: '', orderedSlugs: reference.nodes.map(n => n.slug),
    sections: reference.sections.map(section => ({title: section.title, index: section.index})),
    nodes: reference.nodes.map(node => ({
      slug: node.slug, section: node.section, inDegree: node.inDegree,
      position: [node.layout[0], node.layout[1], node.layout[2]],
    })),
    edges: reference.edges.map(edge => ({
      source: reference.nodes.findIndex(node => node.slug === edge.source),
      target: reference.nodes.findIndex(node => node.slug === edge.target),
      control: null,
    })),
  };
  assert.ok(graph.nodes.every(node => bySlug.has(node.slug)));
  // The reference JSON sums to (0.01, 0.01, -0.04): it was centred on the origin when written.
  const origin = [0, 0, 0];
  layout.bakeControls(graph, origin);

  let worst = 0, sameSection = 0, crossSection = 0;
  reference.edges.forEach((stored, index) => {
    const from = graph.nodes[graph.edges[index].source];
    const to = graph.nodes[graph.edges[index].target];
    const expected = [stored.control[0], stored.control[1], stored.control[2]];
    if (from.section === to.section) { sameSection++; assert.equal(graph.edges[index].control, null); }
    else crossSection++;
    const actual = graph.edges[index].control ?? midpoint(from.position, to.position);
    worst = Math.max(worst, distance(actual, expected));
  });
  assert.equal(sameSection, 185);
  assert.equal(crossSection, 358);
  assert.ok(worst < 0.0088, 'worst control-point reconstruction error ' + worst + ' exceeds the two-decimal rounding bound');
});

test('the reference really does keep every pair of shells overlapping', {skip: !hasReference && 'reference JSON not present'}, () => {
  const reference = JSON.parse(fs.readFileSync(referencePath, 'utf8'));
  const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  let closest = Infinity, pairs = 0;
  for (let i = 0; i < reference.sections.length; i++) {
    for (let j = i + 1; j < reference.sections.length; j++) {
      const a = reference.sections[i], b = reference.sections[j];
      closest = Math.min(closest, a.radius + b.radius - distance(a.centroid, b.centroid));
      pairs++;
    }
  }
  assert.equal(pairs, 21);
  assert.ok(closest > 0, 'the reference has separated shells after all: ' + closest);
});
