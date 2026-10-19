import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';

async function load(entry) {
  const result = await build({entryPoints:[entry], bundle:true, format:'esm', platform:'node', write:false});
  return import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
}

const flex = await load('edge-flex.ts');

const v = (x, y, z) => ({x, y, z});
/** A link along +x with no baked curve, seen from a camera looking down -z. */
const straight = (len = 100) => ({a: v(0, 0, 0), b: v(len, 0, 0), control: null});
const VIEW_FACE_ON = v(0, 0, -1);   // the link lies across the screen
const VIEW_ALONG = v(-1, 0, 0);     // the camera looks straight down the link

test('a link seen face-on keeps the layout shape and bows only a little', () => {
  const edge = straight();
  const result = flex.flexControl(edge, VIEW_FACE_ON);
  assert.ok(result.facing < 1e-9, 'a link across the screen has facing 0, got ' + result.facing);
  // The resting bow is the base fraction of the length, nothing more.
  assert.ok(Math.abs(result.sagitta - flex.BASE_BOW) < 1e-9, 'resting sagitta ' + result.sagitta);
  // ... and it lies in the screen plane, which is exactly "perpendicular to the view direction".
  const offset = {x: result.control.x - 50, y: result.control.y, z: result.control.z};
  const alongView = Math.abs(offset.x * VIEW_FACE_ON.x + offset.y * VIEW_FACE_ON.y + offset.z * VIEW_FACE_ON.z);
  assert.ok(alongView < 1e-6 * Math.hypot(offset.x, offset.y, offset.z) + 1e-9,
    'the bow must not point into the screen: ' + JSON.stringify(offset));
});

test('a link pointing at the camera bows far more -- the foreshortened case the eye cannot read', () => {
  const edge = straight();
  const faceOn = flex.flexControl(edge, VIEW_FACE_ON);
  const along = flex.flexControl(edge, VIEW_ALONG);
  assert.ok(along.facing > 0.999, 'facing ' + along.facing);
  assert.ok(along.sagitta > faceOn.sagitta * 3,
    'the end-on link must bow visibly more: ' + faceOn.sagitta + ' vs ' + along.sagitta);
  // The configured maximum: base + facing, as a fraction of the link's own length.
  assert.ok(Math.abs(along.sagitta - (flex.BASE_BOW + flex.FACING_BOW)) < 1e-9, String(along.sagitta));
});

test('the bow is continuous in the viewing angle (nothing snaps)', () => {
  const edge = straight();
  let previous = null;
  // Sweep the camera from straight-on to along the link in 1-degree steps.
  for (let degrees = 0; degrees <= 90; degrees += 1) {
    const angle = (degrees * Math.PI) / 180;
    const view = v(-Math.sin(angle), 0, -Math.cos(angle));
    const result = flex.flexControl(edge, view);
    if (previous !== null) {
      assert.ok(Math.abs(result.sagitta - previous) < 0.004,
        'sagitta jumped at ' + degrees + 'deg: ' + previous + ' -> ' + result.sagitta);
    }
    previous = result.sagitta;
  }
});

test('a baked curve survives at rest and only bends towards the screen as the view turns', () => {
  // matt's own shape: a control point 0.16 of the length away from the midpoint, along +z.
  const edge = {a: v(0, 0, 0), b: v(100, 0, 0), control: v(50, 0, 16)};
  const faceOn = flex.flexControl(edge, VIEW_FACE_ON);
  // Seen from that direction the authored arc is still worth exactly 0.16 of the edge length.
  assert.ok(Math.abs(faceOn.sagitta - 0.16) < 1e-9, 'the reference ratio must survive: ' + faceOn.sagitta);
  assert.ok(Math.abs(faceOn.control.z - 16) < 1e-6, 'the authored direction is kept at rest');
  // Turned end-on, the bow swings into the screen plane rather than staying hidden behind the line.
  const along = flex.flexControl(edge, VIEW_ALONG);
  assert.ok(along.sagitta > faceOn.sagitta, 'the end-on view must bow more: ' + along.sagitta);
  assert.ok(along.arcRatio > 1, 'a bowed link is longer than its chord');
});

test('arc length grows with the bow, which is the 伸缩 the reader sees', () => {
  const edge = straight();
  const faceOn = flex.flexControl(edge, VIEW_FACE_ON);
  const along = flex.flexControl(edge, VIEW_ALONG);
  assert.ok(faceOn.arcRatio >= 1 && faceOn.arcRatio < 1.005, 'resting stretch ' + faceOn.arcRatio);
  assert.ok(along.arcRatio > faceOn.arcRatio, 'end-on stretch ' + along.arcRatio);
  // A quadratic with geometric sagitta d is about 1 + (8/3)(d/L)^2 longer than its chord. The
  // sampled measurement has to agree with that closed form, which is what makes the reported
  // number trustworthy -- and it is the check that catches a "bow" that never reaches the curve.
  const closed = 1 + (8 / 3) * along.sagitta * along.sagitta / 4;
  assert.ok(Math.abs(along.arcRatio - closed) < 0.01, 'arcRatio ' + along.arcRatio + ' vs ' + closed);
  assert.ok(Math.abs(along.depth - along.bow / 2) < 1e-12, 'depth is half the control offset');
});

test('a degenerate link (zero length) is reported, not left as NaN', () => {
  const result = flex.flexControl({a: v(5, 5, 5), b: v(5, 5, 5), control: null}, VIEW_ALONG);
  assert.equal(result.bow, 0);
  assert.ok(Number.isFinite(result.control.x) && Number.isFinite(result.control.y));
  assert.equal(result.arcRatio, 1);
});

test('the same input always gives the same control point', () => {
  const edge = {a: v(1, 2, 3), b: v(-4, 5, 6), control: v(0, 0, 0)};
  const view = v(0.3, -0.4, 0.86);
  const first = flex.flexControl(edge, view);
  const second = flex.flexControl(edge, view);
  assert.deepEqual(first, second);
});

test('the update interval is bounded, so a large graph cannot rewrite every frame', () => {
  assert.ok(flex.updateInterval(5000) <= 30, 'small graphs may go near 30 fps');
  assert.ok(flex.updateInterval(25000) >= flex.updateInterval(5000), 'larger graphs must be slower');
  assert.ok(flex.updateInterval(200000) >= 90, 'the largest graphs get the slowest tick');
});

test('cameraForward reads a three.js camera the way the renderers do', async () => {
  const {PerspectiveCamera, Vector3} = await import('three');
  const camera = new PerspectiveCamera();
  camera.position.set(0, 0, 10);
  camera.lookAt(new Vector3(0, 0, 0));
  camera.updateMatrixWorld(true);
  const forward = flex.cameraForward(camera);
  assert.ok(Math.abs(forward.x) < 1e-6 && Math.abs(forward.y) < 1e-6, JSON.stringify(forward));
  assert.ok(forward.z < -0.99, 'a camera on +z looking at the origin faces -z: ' + JSON.stringify(forward));
});

test('the GLSL bend uses the same two constants as the TypeScript path', async () => {
  // The outline renderer bends on the GPU; if these drift apart, the two views stop agreeing about
  // what "the same rule" means -- and that is invisible in a screenshot.
  const dom = await load('edge-flex-dom.ts');
  const glsl = dom.FLEX_SHADERS.FLEX_GLSL;
  assert.ok(glsl.includes('MEMORA_BASE_BOW = ' + flex.BASE_BOW.toFixed(2)), glsl.slice(0, 200));
  assert.ok(glsl.includes('MEMORA_FACING_BOW = ' + flex.FACING_BOW.toFixed(2)), glsl.slice(0, 200));
  // Both programs must define main() and read cameraPosition (the per-frame view direction source).
  assert.ok(dom.FLEX_SHADERS.HIERARCHY_EDGE_VERTEX.includes('cameraPosition'));
  assert.ok(dom.FLEX_SHADERS.CURVED_LINK_VERTEX.includes('cameraPosition'));
  assert.ok(dom.FLEX_SHADERS.HIERARCHY_EDGE_VERTEX.includes('void main()'));
  assert.ok(dom.FLEX_SHADERS.CURVED_LINK_VERTEX.includes('void main()'));
});
