/**
 * Which brain types exist, and what each one is allowed to draw.
 *
 * WHY THIS TEST EXISTS
 * --------------------
 * The previous round replaced the 语义关系 view's layout with the reference site's nebula (baked
 * section shells + curved cross-section links) and the user rejected the swap. The rule that came
 * out of it is structural, not cosmetic:
 *
 *   * `dictionary` (语义关系) must NOT install the nebula: its edges stay `control === null` and the
 *     copied spring layout draws them, which is the behaviour the user asked to have restored.
 *   * `matt` (星云关系图) is the ONLY entry that installs it.
 *   * `outline` (层级脑图) touches neither.
 *
 * These are source-level assertions on purpose. A byte-level check of the built bundles is also
 * done (build: the outline bundle is byte-identical), but the built output would still be green if
 * someone re-wired the entries and rebuilt both: the wiring itself has to be asserted where it is
 * written. The build wiring assertions read build.mjs, because a view missing from that list is
 * built never and 404s only at runtime.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = name => readFile(path.join(root, name), 'utf8');

/** The static site the backend serves; `../memora/static` from frontend/. */
const staticRoot = path.resolve(root, '..', 'memora', 'static');

test('the semantic-relation entry no longer installs the nebula', async () => {
  const text = await source('dictionary.ts');
  assert.ok(!/installNebulaLayout/.test(text),
    'dictionary.ts installs installNebulaLayout again: 语义关系 must keep its spring layout, '
    + 'the nebula belongs to the separate matt view');
  // A comment may name the module; an import may not.
  assert.ok(!/from\s+'[^']*matt-layout'/.test(text), 'dictionary.ts still imports the nebula module');
  // The rest of the accepted view has to stay: these were readability fixes, not part of the swap.
  for (const kept of ['tuneDictionaryLook', 'installLabelDeclutter', 'frameDictionaryOverview',
    'installDictionaryFocus', 'installWorkbench']) {
    assert.ok(text.includes(kept), 'dictionary.ts lost ' + kept + ', which the restored view needs');
  }
});

test('the matt entry is the one that installs the nebula', async () => {
  const text = await source('matt.ts');
  assert.ok(/import \{[^}]*installNebulaLayout/.test(text), 'matt.ts does not import installNebulaLayout');
  assert.ok(/installNebulaLayout\(/.test(text), 'matt.ts imports but never calls installNebulaLayout');
  // Same seams as the dictionary entry: this is the same renderer with a different layout.
  for (const kept of ['DictionaryGraphApp', 'MemorySource', 'installWorkbench',
    'installDictionaryFocus', 'tuneDictionaryLook', 'installLabelDeclutter']) {
    assert.ok(text.includes(kept), 'matt.ts is missing ' + kept);
  }
  // Section colour is the nebula's default (the shells are unreadable without it). It is set on
  // the nebula install only -- doing it globally would flip it in the other two views as well.
  assert.ok(/sectionColors:\s*true/.test(text), 'matt.ts does not turn section colour on for the nebula');
});

test('the hierarchy entry is untouched by either layout', async () => {
  const text = await source('outline.ts');
  assert.ok(!/installNebulaLayout|matt-layout|NebulaHost/.test(text),
    'outline.ts picked up the nebula: 层级脑图 must not change');
  assert.ok(!/tuneDictionaryLook|installLabelDeclutter|frameDictionaryOverview/.test(text),
    'outline.ts picked up dictionary-only tuning');
});

test('the build emits all three 3D brain types and the 2D plane', async () => {
  const text = await source('build.mjs');
  // The list the build loops over, as written: [['dictionary', ...], ['matt', ...], ['outline', ...]]
  const listed = [...text.matchAll(/\['(dictionary|matt|outline)',\s*'(dictionary-graph|original-dev)'\]/g)]
    .map(match => [match[1], match[2]]);
  assert.deepEqual(listed, [['dictionary', 'dictionary-graph'], ['matt', 'dictionary-graph'],
    ['outline', 'original-dev']],
    'build.mjs must build dictionary, matt and outline (matt from the dictionary renderer)');
  assert.ok(/entryPoints:\['plane\.ts'\]/.test(text), 'build.mjs no longer builds the 2D plane');
  // A view the build never writes is served as a 503 "build the brain views" page at runtime.
  for (const name of ['dictionary', 'matt', 'outline', 'plane']) {
    const dir = path.join(staticRoot, 'brain', name);
    assert.ok(existsSync(path.join(dir, 'app.js')), 'brain/' + name + '/app.js was never built');
    assert.ok(existsSync(path.join(dir, 'index.html')), 'brain/' + name + '/index.html was never built');
    assert.ok(existsSync(path.join(dir, 'styles.css')), 'brain/' + name + '/styles.css was never built');
  }
});

test('the built bundles carry the layout they are supposed to', async () => {
  // Built output, not source: this catches a build that silently reused a stale cache. The nebula
  // report's own field names are the marker; they are minified-internal names nothing else uses.
  const dictionary = await readFile(path.join(staticRoot, 'brain', 'dictionary', 'app.js'), 'utf8');
  const matt = await readFile(path.join(staticRoot, 'brain', 'matt', 'app.js'), 'utf8');
  assert.ok(!dictionary.includes('shellsAllIntersect'),
    'the semantic-relation bundle contains the nebula bake after all');
  assert.ok(!dictionary.includes('memoraNebula'), 'the semantic-relation bundle still publishes memoraNebula');
  assert.ok(matt.includes('shellsAllIntersect'), 'the matt bundle does not contain the nebula bake');
  assert.ok(matt.includes('memoraNebula'), 'the matt bundle does not publish memoraNebula');
});
