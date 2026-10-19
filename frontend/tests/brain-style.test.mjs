/**
 * 样式一致性护栏：node --test frontend/tests/brain-style.test.mjs
 *
 * 样式有**两份**：style.css（人读、可单独引用的源）与 style.ts 里的 BRAIN_CSS
 * 字符串（随 brain.js 发布，运行期注入 <style>）。原因见 style.ts 顶部注释：
 * build.mjs 没有配置 CSS 到 JS 的 loader，而 brain.html 只保证有一个挂载 div。
 *
 * 两份内容一旦漂移，就会出现「改了样式但页面没变」这种最难查的问题。
 * 这个测试把漂移变成一条明确的失败。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const brainDir = path.resolve(here, '..', 'src', 'brain');

test('style.css 与 style.ts 内嵌的 BRAIN_CSS 完全一致', async () => {
  const css = await readFile(path.join(brainDir, 'style.css'), 'utf8');
  const ts = await readFile(path.join(brainDir, 'style.ts'), 'utf8');
  const marker = 'export const BRAIN_CSS = String.raw';
  const start = ts.indexOf(marker);
  assert.ok(start >= 0, 'style.ts 里应当有 BRAIN_CSS 字符串');
  const tick = String.fromCharCode(96);
  const from = ts.indexOf(tick, start);
  const to = ts.lastIndexOf(tick);
  const embedded = ts.slice(from + 1, to).split('\\' + tick).join(tick);
  assert.equal(embedded.trim(), css.trim(), 'style.css 与 BRAIN_CSS 不一致：改了一边要同步另一边');
});

test('样式覆盖了全部 UI 元素', async () => {
  const css = await readFile(path.join(brainDir, 'style.css'), 'utf8');
  const ui = await readFile(path.join(brainDir, 'ui.ts'), 'utf8');
  for (const cls of [
    'mem-topbar', 'mem-filter', 'mem-watermark', 'mem-minimap', 'mem-stats',
    'mem-legend', 'mem-statusbar', 'mem-searchbox', 'mem-loading',
  ]) {
    assert.ok(ui.includes(cls), 'ui.ts 应当渲染 .' + cls);
    assert.ok(css.includes('.' + cls), 'style.css 应当有 .' + cls + ' 的样式');
  }
});
