/**
 * The best-view seam and the link flex are wired into all three views, and the toolbar is the same
 * one in all three.
 *
 * These are source-level assertions on purpose: the behaviour is measured by
 * tools/ui_validation_p9_bestview.cjs in a real browser, but a view that silently drops the seam
 * would still render, still be screenshotted, and only fail a human looking at it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = name => readFile(path.join(root, name), 'utf8');

const VIEWS = ['dictionary.ts', 'matt.ts', 'outline.ts'];

test('every brain view installs both the best-view seam and the flex layer', async () => {
  for (const view of VIEWS) {
    const text = await source(view);
    assert.ok(/import \{[^}]*installBestView/.test(text), view + ' does not import installBestView');
    assert.ok(/installBestView\(/.test(text), view + ' imports but never calls installBestView');
    assert.ok(/\binstall(?:Dictionary|Outline)Flex\(/.test(text), view + ' never installs a link flex layer');
    // The seam has to be reachable from outside: the acceptance run and the toolbar both read it.
    assert.ok(text.includes('memoraBestView'), view + ' does not publish memoraBestView');
    assert.ok(text.includes('memoraEdgeFlex'), view + ' does not publish memoraEdgeFlex');
    // ... and it has to be handed to the toolbar, or the button never exists.
    // dictionary.ts spreads the handler over several lines, so the assertion is on the pair, not on
    // the exact formatting.
    assert.ok(/installWorkbench\(Object\.assign\(app, \{\s*bestView/.test(text),
      view + ' does not pass bestView into installWorkbench, so there is no 最佳视角 button');
  }
});

test('the dictionary and matt views share one policy call, and outline uses the vendor search', async () => {
  for (const view of ['dictionary.ts', 'matt.ts']) {
    const text = await source(view);
    // Both must go through the SAME first-frame policy (graph-look -> bestAngles -> frameCluster),
    // which is what makes their angles comparable; reimplementing a search here would drift.
    assert.ok(/frameDictionaryOverview\(/.test(text), view + ' does not use the shared framing policy');
    assert.ok(/source: 'focus'/.test(text), view + ' does not report where its angles came from');
  }
  const outline = await source('outline.ts');
  // The hierarchy view must use the host's own orientation search, not a copy of focus.ts.
  assert.ok(/\.overview\(\)/.test(outline), 'outline.ts never calls the host overview()');
  assert.ok(/source: 'vendor'/.test(outline), 'outline.ts does not label its angles as the vendor search');
  assert.ok(!/bestAngles\(/.test(outline), 'outline.ts reimplements the angle search instead of using the host');
});

test('the shared toolbar builds the 最佳视角 button and reports the pose', async () => {
  const text = await source('graph-workbench.ts');
  assert.ok(text.includes('bestView?()'), 'GraphHost lost the bestView seam');
  assert.ok(/textContent = '最佳视角'/.test(text), 'the button is gone');
  assert.ok(text.includes('memora-best-view-note'), 'the button has no status line to report the pose');
});

test('the flex layer never writes to the layout it deforms', async () => {
  const text = await source('edge-flex-dom.ts');
  // Both renderers must be derived-only: a written-back control point would corrupt the matt bake's
  // measured 0.16 ratio and the spring layout's resting shape.
  assert.ok(!/edge\.control\s*=/.test(text), 'edge-flex-dom.ts assigns edge.control');
  assert.ok(!/graph\.edges\[[^\]]+\]\.control\s*=/.test(text), 'edge-flex-dom.ts writes a control point');
  assert.ok(!/nodes\[[^\]]+\]\.position\s*=/.test(text), 'edge-flex-dom.ts moves a node');
  // The outline path has to be a shader patch on the material, not a vendor edit.
  assert.ok(/vertexShader/.test(text), 'the outline path no longer patches the shader');
  assert.ok(text.includes('cameraPosition'), 'the shader must bend from the live camera position');
});

test('the two vendors stay unedited by this task', async () => {
  // A proxy for "we only used public seams": neither vendored renderer may mention the Memora modules
  // that drive them, which is what a reverse import would look like.
  for (const vendor of ['vendor/dictionary-graph/src/render/scene.ts', 'vendor/original-dev/src/render/link-layer.ts',
    'vendor/original-dev/src/render/edge-layer.ts']) {
    const text = await source(vendor);
    assert.ok(!/memora|edge-flex|best-view/i.test(text), vendor + ' was edited to know about Memora');
  }
});

test('the built bundles carry the seams (the build is not stale)', async () => {
  const staticRoot = path.resolve(root, '..', 'memora', 'static', 'brain');
  for (const name of ['dictionary', 'matt', 'outline']) {
    const text = await readFile(path.join(staticRoot, name, 'app.js'), 'utf8');
    assert.ok(text.includes('memoraBestView'), name + '/app.js is missing the best-view seam');
    assert.ok(text.includes('memoraEdgeFlex'), name + '/app.js is missing the flex layer');
  }
});
