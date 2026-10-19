import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const result = await build({entryPoints: ['memory-presentation.ts'], bundle: true, platform: 'node', format: 'esm', write: false});
const { displayMemoryTitle, installMemoryPresentation } = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));

test('only generated identity suffixes are removed; provenance stays in the body', () => {
  const body = '> 记忆 ID：ab123456-7890-abcd-1234-123456789abc';
  assert.equal(displayMemoryTitle('事务 ab123456', body), '事务');
  assert.equal(displayMemoryTitle('事务 v2026', body), '事务 v2026');
  assert.equal(displayMemoryTitle('ordinary ab123456', 'no locator'), 'ordinary ab123456');
});

test('labels refresh but stable renderer slugs, edge endpoints and evidence remain intact', () => {
  const node = {slug:'stable-renderer-slug', title:'事务 ab123456', body:'记忆 ID：ab123456-7890'};
  const edges = [{a:'stable-renderer-slug',b:'other'}]; let refresh=0;
  const host = {graph:{nodes:[node],edges}, index:{}, labels:{setGraph(){refresh++;}}, needsDraw:false};
  installMemoryPresentation(host);
  assert.equal(node.title, '事务'); assert.equal(node.slug, 'stable-renderer-slug');
  assert.equal(node.body, '记忆 ID：ab123456-7890'); assert.deepEqual(host.graph.edges, edges);
  assert.equal(refresh,1); assert.equal(host.needsDraw,true);
});
