import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

/**
 * The build.mjs list and the web.py whitelist have to agree.
 *
 * A view missing from build.mjs is never built, and a view missing from web.py's `/brain/`
 * whitelist 404s at request time even though its files exist on disk. The two lists are in
 * different languages and different directories, so the failure they share is silent: the
 * workbench's iframe simply shows nothing. This test is the only thing tying them together.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repository = path.resolve(root, '..');

const BUILT = ['dictionary', 'matt', 'outline'];
const SERVED = [...BUILT, 'plane'];

test('every built brain view exists on disk with the three files the route serves', () => {
  for (const name of BUILT) {
    for (const file of ['app.js', 'index.html', 'styles.css']) {
      const target = path.join(repository, 'memora', 'static', 'brain', name, file);
      assert.ok(existsSync(target), 'missing built view file: ' + target);
    }
  }
});

test('build.mjs builds exactly the views the whitelist serves (plane is built separately)', () => {
  const build = readFileSync(path.join(root, 'build.mjs'), 'utf8');
  const listed = [...build.matchAll(/\['([a-z]+)',\s*'(dictionary-graph|original-dev)'\]/g)]
    .map(match => match[1]);
  assert.deepEqual(listed, BUILT, 'build.mjs builds ' + JSON.stringify(listed));
  // The 2D plane is built outside the loop, but it is served from the same whitelist.
  assert.ok(build.includes("entryPoints:['plane.ts']"), 'build.mjs no longer builds plane.ts');
});

test("web.py's /brain/ whitelist serves every built view plus the 2D plane", () => {
  const web = readFileSync(path.join(repository, 'memora', 'web.py'), 'utf8');
  const whitelist = web.match(/parts\[1\] not in \{([^}]*)\}/);
  assert.ok(whitelist, 'web.py no longer has a /brain/ subpath whitelist');
  const served = whitelist[1].split(',').map(entry => entry.trim().replace(/^'|'$/g, '')).filter(Boolean);
  assert.deepEqual(served.sort(), [...SERVED].sort(),
    'web.py serves ' + JSON.stringify(served) + ', build.mjs produces ' + JSON.stringify(SERVED));
});
