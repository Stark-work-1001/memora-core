import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';

async function load(entry) {
  const result = await build({entryPoints:[entry], bundle:true, format:'esm', platform:'node', write:false});
  return import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
}

const focus = await load('focus.ts');

const WIDE = {width: 1056, height: 844};
const NARROW = {width: 520, height: 546};

/** A cluster shaped like a real parent-and-child pair, plus a busier one. */
const pair = [{x: 89.07, y: -5.55, z: -35.62, r: 3.4}, {x: -2.75, y: -133.53, z: 42.13, r: 3.4}];
const star = (() => {
  const out = [{x: 0, y: 0, z: 0, r: 12}];
  for (let i = 0; i < 5; i++) {
    const angle = (i / 5) * Math.PI * 2;
    out.push({x: Math.cos(angle) * 200, y: Math.sin(angle) * 200, z: 0, r: 7});
  }
  return out;
})();
const deep = [{x: -180, y: 60, z: -90, r: 10}, {x: 200, y: -40, z: 110, r: 9}, {x: 30, y: 220, z: -160, r: 8}];
const collinear = [{x: 0, y: 0, z: 0, r: 8}, {x: 0, y: 150, z: 0, r: 8}, {x: 0, y: 300, z: 0, r: 8}];
const single = [{x: 0, y: 0, z: 0, r: 12}];

const clusters = {pair, star, deep, collinear, single};
const viewports = {
  wide: WIDE,
  wideWithPanel: {width: 1056, height: 844, insetRight: 380},
  narrow: NARROW,
  narrowWithSheet: {width: 520, height: 546, insetBottom: 210},
  tiny: {width: 320, height: 280},
};

test('the framed cluster lands entirely inside the free window, at every shape', () => {
  for (const [clusterName, spheres] of Object.entries(clusters)) {
    for (const [viewportName, viewport] of Object.entries(viewports)) {
      const angles = focus.bestAngles(spheres, viewport, {fov: 50});
      const pose = focus.frameCluster(spheres, angles.azimuth, angles.polar, viewport, {fov: 50});
      assert.ok(pose, clusterName + '/' + viewportName + ': no pose');
      const projected = focus.projectSpheres(spheres, pose, angles.azimuth, angles.polar, viewport, {fov: 50});
      const outside = projected.filter(p => !p.inside);
      assert.equal(outside.length, 0,
        clusterName + '/' + viewportName + ' leaves ' + outside.length + ' of ' + spheres.length + ' outside: ' + JSON.stringify(projected));
    }
  }
});

test('a selected cluster is framed to fill a useful share of the window, not to a dot', () => {
  for (const [clusterName, spheres] of Object.entries(clusters)) {
    if (spheres.length < 2) continue;   // a single node is deliberately not over-zoomed
    for (const [viewportName, viewport] of Object.entries(viewports)) {
      const angles = focus.bestAngles(spheres, viewport, {fov: 50});
      const pose = focus.frameCluster(spheres, angles.azimuth, angles.polar, viewport, {fov: 50});
      // At least one axis is filled to a third, and no axis overflows.
      const best = Math.max(pose.fill.x, pose.fill.y);
      assert.ok(best > 0.33, clusterName + '/' + viewportName + ' fills only ' + JSON.stringify(pose.fill));
      assert.ok(pose.fill.x <= 1.02 && pose.fill.y <= 1.02,
        clusterName + '/' + viewportName + ' overflows: ' + JSON.stringify(pose.fill));
    }
  }
});

test('the fit is per axis: a portrait window and a wide one are framed differently', () => {
  // Fit the *same angles* in both windows, so only the aspect differs. A
  // bounding-sphere fit would produce one distance; a per-axis fit cannot.
  const spheres = [{x: 0, y: 0, z: 0, r: 6}, {x: 300, y: 0, z: 0, r: 6}];
  const angle = {azimuth: 0, polar: Math.PI / 2};
  const wide = focus.frameCluster(spheres, angle.azimuth, angle.polar, WIDE, {fov: 50});
  const narrow = focus.frameCluster(spheres, angle.azimuth, angle.polar, NARROW, {fov: 50});
  // Horizontal extent is the binding constraint in both, but the portrait
  // window is narrower, so it has to stand a little further back for the same
  // cluster. The margin is small on purpose: the narrow window is not much
  // narrower than 4:3, so the assertion is directional, not a ratio.
  assert.ok(narrow.distance > wide.distance,
    'a portrait window must stand back for a horizontal cluster: ' + JSON.stringify({wide: wide.distance, narrow: narrow.distance}));
  // ...and the cluster still fills the axis it is constrained by, rather than
  // being shrunk to a dot by a sphere fitted to the other axis.
  assert.ok(narrow.fill.x > 0.65 && wide.fill.x > 0.5,
    'a wide cluster must fill the width: ' + JSON.stringify({wide: wide.fill, narrow: narrow.fill}));
  // A vertical cluster binds on the other axis, which is the whole point of
  // fitting per axis rather than to a sphere.
  const vertical = [{x: 0, y: -300, z: 0, r: 6}, {x: 0, y: 300, z: 0, r: 6}];
  const wideV = focus.frameCluster(vertical, angle.azimuth, angle.polar, WIDE, {fov: 50});
  assert.ok(wideV.fill.y > 0.5 && wideV.fill.x < 0.1,
    'a tall cluster must fill the height: ' + JSON.stringify(wideV.fill));
});

test('a panel inset moves the cluster out from under the panel instead of behind it', () => {
  const plain = focus.bestAngles(star, WIDE, {fov: 50});
  const plainProjected = focus.projectSpheres(star,
    focus.frameCluster(star, plain.azimuth, plain.polar, WIDE, {fov: 50}), plain.azimuth, plain.polar, WIDE, {fov: 50});
  const withPanel = focus.bestAngles(star, viewports.wideWithPanel, {fov: 50});
  const panelPose = focus.frameCluster(star, withPanel.azimuth, withPanel.polar, viewports.wideWithPanel, {fov: 50});
  const panelProjected = focus.projectSpheres(star, panelPose, withPanel.azimuth, withPanel.polar, viewports.wideWithPanel, {fov: 50});
  const window = focus.freeWindow(viewports.wideWithPanel, 50);
  // The panel covers the right edge: nothing may sit under it.
  for (const point of panelProjected) {
    assert.ok(point.x + point.rX <= window.x1 + 1e-6,
      'a node reached under the panel: ' + JSON.stringify(point) + ' window=' + JSON.stringify(window));
  }
  assert.ok(panelPose.distance > 0 && plainProjected.length === panelProjected.length);
});

test('labels get a gutter, so a name is not cut off by the window edge', () => {
  // Both views draw each node's name to its right. Fitting the spheres to the
  // full width would put the rightmost names outside the stage even though
  // every sphere is technically inside it.
  const spheres = [{x: -200, y: 0, z: 0, r: 8}, {x: 200, y: 0, z: 0, r: 8}];
  // A tighter cluster than the "do not over-zoom" floor, so the fit decides.
  const tight = [{x: -120, y: 0, z: 0, r: 5}, {x: 120, y: 0, z: 0, r: 5}];
  const plain = focus.frameCluster(tight, 0, Math.PI / 2, WIDE, {fov: 50});
  const guttered = focus.frameCluster(tight, 0, Math.PI / 2, WIDE, {fov: 50, reserveRight: 180});
  assert.ok(guttered.fitted > plain.fitted, 'the gutter must increase what the fit requires');
  assert.ok(guttered.distance >= plain.distance, 'the gutter must never let the camera closer');
  // And what is left of the window really is narrower on the right.
  const withGutter = focus.freeWindow(WIDE, 50, 180);
  const withoutGutter = focus.freeWindow(WIDE, 50, 0);
  assert.ok(withGutter.x1 < withoutGutter.x1, 'the gutter must narrow the free window');
  assert.equal(withGutter.x0, withoutGutter.x0, 'a right gutter must not move the left edge');
  // The cluster is still fully inside the *guttered* window.
  const projected = focus.projectSpheres(tight, guttered, 0, Math.PI / 2, WIDE, {fov: 50, reserveRight: 180});
  for (const point of projected) {
    assert.ok(point.x + point.rX <= withGutter.x1 + 1e-6,
      'a node reached into the label gutter: ' + JSON.stringify({point, window: withGutter}));
  }
});

test('a lone node is framed at a readable size instead of filling the window', () => {
  for (const viewport of [WIDE, NARROW]) {
    const pose = focus.frameCluster(single, 0.7, 1.15, viewport, {fov: 50});
    assert.ok(pose.fill.y <= 0.8, 'single node fills ' + pose.fill.y);
    assert.ok(pose.distance > 20, 'single node framed at distance ' + pose.distance);
  }
});

test('the hierarchy direction bias only reorders readable viewpoints', () => {
  const edges = [{parent: {x: 0, y: 200, z: 0, r: 8}, child: {x: 0, y: 0, z: 0, r: 8}}];
  const bias = (azimuth, polar) => focus.downwardness(edges, azimuth, polar);
  // Find the direction that reads best without any bias...
  const readable = focus.bestAngles(star, WIDE, {fov: 50});
  const readableScore = focus.frameCluster(star, readable.azimuth, readable.polar, WIDE, {fov: 50}).fill;
  // ...then with it: still a readable frame, and pointing the right way round.
  const biased = focus.bestAngles(star, WIDE, {fov: 50, bias});
  const biasedScore = focus.frameCluster(star, biased.azimuth, biased.polar, WIDE, {fov: 50}).fill;
  const cover = fill => Math.min(1, fill.x) * 0.5 + Math.min(1, fill.y) * 0.5;
  assert.ok(cover(biasedScore) >= cover(readableScore) - 0.2,
    'the bias cost too much readability: ' + JSON.stringify({readableScore, biasedScore}));
  assert.ok(bias(biased.azimuth, biased.polar) >= bias(readable.azimuth, readable.polar),
    'the bias did not take effect');
});

test('downwardness reads the screen up-vector, not the world Y axis', () => {
  const above = [{parent: {x: 0, y: 100, z: 0, r: 8}, child: {x: 0, y: -100, z: 0, r: 8}}];
  // An orbit camera with world up cannot roll the horizon over: at every
  // azimuth and every polar the camera's up vector keeps a positive Y
  // component, so a parent that sits above the child in the world is drawn
  // above it. Orbiting changes the left/right axis, not which way is up.
  for (const azimuth of [0, 1.4, Math.PI, 5.2]) {
    for (const polar of [0.3, 1.57, 2.8]) {
      assert.ok(focus.downwardness(above, azimuth, polar) > 0,
        'azimuth ' + azimuth + ' polar ' + polar);
    }
  }
  // A pair that runs the other way in the world must read the other way.
  const below = [{parent: {x: 0, y: -100, z: 0, r: 8}, child: {x: 0, y: 100, z: 0, r: 8}}];
  assert.ok(focus.downwardness(below, 0.9, 1.1) < 0);
  // A pair laid out along the view axis has no up-or-down on screen at all, and
  // that has to score zero rather than an arbitrary sign: the hierarchy bias
  // must not prefer an unreadable direction just because its sign is positive.
  const along = [{parent: {x: 0, y: 0, z: 200, r: 8}, child: {x: 0, y: 0, z: -200, r: 8}}];
  assert.equal(focus.downwardness(along, 0, Math.PI / 2), 0);
});

test('a second click retargets from wherever the camera currently is', () => {
  // The rule the views rely on: the new move starts from the current pose, so
  // two clicks in quick succession produce one continuous motion, not a fight.
  const first = focus.frameCluster(pair, 0.5, 1.0, WIDE, {fov: 50});
  const second = focus.frameCluster(star, 2.0, 0.6, WIDE, {fov: 50});
  assert.notDeepEqual(first.target, second.target);
  const retargeted = focus.frameCluster(star, 2.0, 0.6, WIDE, {fov: 50});
  assert.deepEqual(retargeted.target, second.target);
});

test('reduced motion still frames exactly, it only skips the animation', () => {
  assert.equal(focus.focusDuration(true), 0);
  assert.ok(focus.focusDuration(false) > 0);
  const angles = focus.bestAngles(deep, WIDE, {fov: 50});
  const animated = focus.frameCluster(deep, angles.azimuth, angles.polar, WIDE, {fov: 50});
  const instant = focus.frameCluster(deep, angles.azimuth, angles.polar, WIDE, {fov: 50});
  // Nothing about the pose depends on the motion preference: the same maths
  // runs, the view just applies it with a zero duration.
  assert.deepEqual(instant.target, animated.target);
  assert.equal(instant.distance, animated.distance);
});

test('a node with no neighbours is framed with its siblings, never alone', () => {
  assert.deepEqual(focus.focusSet(3, [], [4, 5]), [3, 4]);
  assert.deepEqual(focus.focusSet(3, [1], [4, 5]), [3, 1]);
  assert.deepEqual(focus.focusSet(3, [1, 2], [4, 5]), [3, 1, 2]);
  // The selected node always leads, and duplicates never sneak in.
  assert.deepEqual(focus.focusSet(3, [3, 3, 4], [4]), [3, 4]);
});

test('lookQuaternion points the camera at the target and never rolls past the pole', () => {
  const eye = {x: 100, y: 60, z: 200};
  const target = {x: 0, y: 0, z: 0};
  const [x, y, z, w] = focus.lookQuaternion(eye, target);
  assert.ok(Math.abs(Math.hypot(x, y, z, w) - 1) < 1e-9, 'quaternion is not normalised');
  // Rotating -Z by the quaternion must give the direction from eye to target.
  const forward = rotate([x, y, z, w], [0, 0, -1]);
  const expected = normalize([-eye.x, -eye.y, -eye.z]);
  for (const axis of ['x', 'y', 'z']) {
    assert.ok(Math.abs(forward[axis] - expected[axis]) < 1e-6, axis + ': ' + JSON.stringify({forward, expected}));
  }
  // Straight down the pole must stay finite rather than producing NaN.
  const top = focus.lookQuaternion({x: 0, y: 300, z: 0}, {x: 0, y: 0, z: 0});
  assert.ok(top.every(Number.isFinite), 'pole produced ' + JSON.stringify(top));
});

test('cameraBasis matches lookQuaternion, so both views project identically', () => {
  for (const [azimuth, polar] of [[0, 0.3], [0.7, 1.15], [2.4, 1.9], [5.9, 0.5]]) {
    const basis = focus.cameraBasis(azimuth, polar);
    const eye = {x: basis.dir.x * 100, y: basis.dir.y * 100, z: basis.dir.z * 100};
    const [x, y, z, w] = focus.lookQuaternion(eye, {x: 0, y: 0, z: 0});
    for (const [name, axis] of [['right', basis.right], ['up', basis.up]]) {
      // The camera's own X/Y axes must coincide with the basis vectors.
      const rotated = name === 'right' ? rotate([x, y, z, w], [1, 0, 0]) : rotate([x, y, z, w], [0, 1, 0]);
      const dot = rotated.x * axis.x + rotated.y * axis.y + rotated.z * axis.z;
      assert.ok(dot > 0.999, name + ' disagrees at ' + azimuth + '/' + polar + ': ' + dot);
    }
  }
});

function rotate(q, v) {
  const [x, y, z, w] = q;
  const ix = w * v[0] + y * v[2] - z * v[1];
  const iy = w * v[1] + z * v[0] - x * v[2];
  const iz = w * v[2] + x * v[1] - y * v[0];
  const iw = -x * v[0] - y * v[1] - z * v[2];
  return {
    x: ix * w + iw * -x + iy * -z - iz * -y,
    y: iy * w + iw * -y + iz * -x - ix * -z,
    z: iz * w + iw * -z + ix * -y - iy * -x,
  };
}

function normalize(v) {
  const length = Math.hypot(v[0], v[1], v[2]);
  return {x: v[0] / length, y: v[1] / length, z: v[2] / length};
}