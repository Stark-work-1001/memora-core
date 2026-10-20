/**
 * Markdown 渲染器的无浏览器单测：node --test frontend/tests/markdown.test.mjs
 *
 * e2e-app.test.mjs 在真 Chrome 里覆盖同样的回归；这里用一个极小的假 DOM + KaTeX 替身，
 * 让没有 Chrome 的机器也能守住：链接分类（安全）、行内公式规则（价格不是公式）、
 * 解析代价线性、段落总能前进（不死循环）、引用嵌套与公式数量有上限。
 */
import assert from 'node:assert/strict';
import { test, before } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const frontend = path.resolve(here, '..');

/* ------------------------------------------------------------------ 假 DOM（只实现渲染器用到的部分） */

class FakeText {
  constructor(value) { this.nodeType = 3; this.data = String(value); this.parent = null; }
  get textContent() { return this.data; }
}

class FakeElement {
  constructor(tag) {
    this.nodeType = 1;
    this.tagName = String(tag).toUpperCase();
    this.childNodes = [];
    this.attrs = new Map();
    this.dataset = {};
    this.parent = null;
    this.style = { setProperty() {} };
    const owner = this;
    this.classList = {
      add(...names) { const set = owner.classSet(); names.forEach((name) => set.add(name)); owner.attrs.set('class', [...set].join(' ')); },
      remove(...names) { const set = owner.classSet(); names.forEach((name) => set.delete(name)); owner.attrs.set('class', [...set].join(' ')); },
      contains(name) { return owner.classSet().has(name); },
      toggle(name, force) { if (force ?? !this.contains(name)) this.add(name); else this.remove(name); },
    };
  }
  classSet() { return new Set(String(this.attrs.get('class') || '').split(/\s+/).filter(Boolean)); }
  setAttribute(name, value) { this.attrs.set(name, String(value)); }
  getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; }
  addEventListener() {}
  appendChild(child) {
    if (child instanceof FakeFragment) {
      for (const node of child.childNodes.splice(0)) this.appendChild(node);
      return child;
    }
    if (child.parent) child.parent.childNodes.splice(child.parent.childNodes.indexOf(child), 1);
    child.parent = this;
    this.childNodes.push(child);
    return child;
  }
  removeChild(child) { this.childNodes.splice(this.childNodes.indexOf(child), 1); child.parent = null; return child; }
  get firstChild() { return this.childNodes[0] ?? null; }
  get lastElementChild() { return [...this.childNodes].reverse().find((node) => node.nodeType === 1) ?? null; }
  get textContent() { return this.childNodes.map((node) => node.textContent).join(''); }
  set textContent(value) { this.childNodes = []; this.appendChild(new FakeText(value)); }
  get className() { return this.attrs.get('class') || ''; }
}

class FakeFragment extends FakeElement {
  constructor() { super('#fragment'); }
}

globalThis.window = globalThis;
globalThis.location = new URL('http://127.0.0.1:8790/#/memories');
globalThis.document = {
  createElement: (tag) => new FakeElement(tag),
  createElementNS: (_ns, tag) => new FakeElement(tag),
  createTextNode: (value) => new FakeText(value),
  createDocumentFragment: () => new FakeFragment(),
  querySelector: () => null,
  head: new FakeElement('head'),
};

/** 深度优先列出所有元素。 */
function elements(root) {
  const out = [];
  const walk = (node) => {
    for (const child of node.childNodes || []) {
      if (child.nodeType === 1) { out.push(child); walk(child); }
    }
  };
  walk(root);
  return out;
}

let md = null;

before(async () => {
  const esbuild = await import('esbuild');
  const scratch = mkdtempSync(path.join(tmpdir(), 'memora-md-'));
  const out = path.join(scratch, 'markdown.mjs');
  await esbuild.build({
    absWorkingDir: frontend,
    entryPoints: ['src/app/markdown.ts'],
    outfile: out,
    bundle: true,
    format: 'esm',
    target: 'es2020',
    logLevel: 'warning',
    alias: { katex: path.join(here, 'katex-stub.mjs') },
  });
  md = await import(pathToFileURL(out).href);
  process.on('exit', () => { try { rmSync(scratch, { recursive: true, force: true }); } catch { /* 忽略 */ } });
});

const BASE = 'http://127.0.0.1:8790/#/memories';

test('classifyHref：同源走站内，他源 http(s) 新窗口，其余一律禁用', () => {
  const kind = (href) => { const target = md.classifyHref(href, BASE); return target ? target.kind + ' ' + target.href : null; };
  assert.equal(kind('//example.org/x'), 'external http://example.org/x', '协议相对 URL 是他源');
  assert.equal(kind('/\\example.org/y'), 'external http://example.org/y', '反斜杠被浏览器当作 /');
  assert.equal(kind('https://example.org/z'), 'external https://example.org/z');
  assert.equal(kind('/#/overview'), 'internal /#/overview');
  assert.equal(kind('../docs/a.md'), 'internal /docs/a.md');
  assert.equal(kind('http://127.0.0.1:8790/api/x'), 'internal /api/x');
  assert.equal(kind('http://127.0.0.1:9999/api/x'), 'external http://127.0.0.1:9999/api/x', '端口不同就是他源');
  assert.equal(kind('mailto:someone@example.org'), 'mailto mailto:someone@example.org');
  for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'java\tscript:alert(1)', ' javascript:x',
    'data:text/html,<b>x</b>', 'vbscript:x', 'file:///etc/passwd', '', 'http://exa mple.org']) {
    assert.equal(md.classifyHref(bad, BASE), null, '应当禁用：' + JSON.stringify(bad));
  }
});

test('链接渲染：他源 target=_blank + noopener，同源无 target，危险链接只留文字', () => {
  const frag = md.renderMarkdown('[a](//example.org/x) [b](/#/agents) [c](javascript:alert(1))');
  const anchors = elements(frag).filter((node) => node.tagName === 'A');
  assert.equal(anchors.length, 2);
  assert.equal(anchors[0].getAttribute('href'), 'http://example.org/x');
  assert.equal(anchors[0].getAttribute('target'), '_blank');
  assert.match(anchors[0].getAttribute('rel'), /noopener/);
  assert.equal(anchors[1].getAttribute('href'), '/#/agents');
  assert.equal(anchors[1].getAttribute('target'), null);
  const blocked = elements(frag).filter((node) => node.classList.contains('md-link-blocked'));
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].textContent, 'c');
});

test('行内公式：价格不是公式，$a+b$ 是，$$…$$ 以 display 模式渲染，\\$ 是字面量', () => {
  const tex = (source) => elements(md.renderMarkdown(source))
    .filter((node) => node.getAttribute('data-tex') !== null)
    .map((node) => node.getAttribute('data-tex') + '|' + node.getAttribute('data-display'));
  assert.deepEqual(tex('价格：$5 和 $10 都不是公式；行内公式 $a+b$ 是。'), ['a+b|0']);
  assert.deepEqual(tex('costs $5, $10 or $20'), []);
  assert.deepEqual(tex('行内块 $$x^2$$ 结束'), ['x^2|1']);
  assert.deepEqual(tex('转义 \\$5 与 $y$'), ['y|0']);
  assert.deepEqual(tex('$$\nE = mc^2\n$$'), ['E = mc^2|1'], '多行块级公式');
  assert.deepEqual(tex('$$E$$'), ['E|1'], '单行块级公式');
});

test('块级 $$ 没有闭合时按段落处理，不吞掉后文', () => {
  const frag = md.renderMarkdown('$$ 这里没有闭合\n\n后面的段落');
  const paragraphs = elements(frag).filter((node) => node.tagName === 'P').map((node) => node.textContent);
  assert.deepEqual(paragraphs, ['$$ 这里没有闭合', '后面的段落']);
});

test('段落总能前进：「```js 多余文字」这类行不再死循环', { timeout: 5000 }, () => {
  const frag = md.renderMarkdown('```js 多余文字\n下一行\n\n```\ncode\n```');
  const text = elements(frag).map((node) => node.tagName).join(',');
  assert.ok(text.includes('P'), '应当渲染出段落：' + text);
});

test('引用嵌套有上限，深层 > 不会打爆调用栈', () => {
  const frag = md.renderMarkdown('>'.repeat(20000) + ' 深引用');
  let depth = 0;
  let node = elements(frag).find((item) => item.tagName === 'BLOCKQUOTE');
  while (node) {
    depth += 1;
    node = node.childNodes.find((child) => child.tagName === 'BLOCKQUOTE');
  }
  assert.ok(depth >= 1 && depth <= 9, '嵌套深度应当被限制，实际 ' + depth);
});

test('单篇文档的公式数量有上限，超出按原文显示', () => {
  const frag = md.renderMarkdown(Array.from({ length: 1000 }, (_, i) => '$x_' + i + '$').join(' '));
  const all = elements(frag);
  const rendered = all.filter((node) => node.getAttribute('data-tex') !== null).length;
  const skipped = all.filter((node) => node.classList.contains('math-skipped')).length;
  assert.equal(rendered, 400);
  assert.equal(skipped, 600);
});

test('病态输入的解析代价是线性的（1.0.0 每个 [ / * / $ 都从头扫描，平方级）', { timeout: 60000 }, () => {
  const payload = (n) => '['.repeat(n) + '*'.repeat(n) + '$a '.repeat(n) + '`'.repeat(n) + '~~'.repeat(n);
  const time = (n) => {
    const started = performance.now();
    md.inlineNodes(payload(n), { math: true });
    return performance.now() - started;
  };
  time(2000); // 预热 JIT
  const small = Math.max(1, time(20000));
  const large = time(160000);
  assert.ok(large < 4000, '16 万字符的病态输入应当在 4 秒内解析完，实际 ' + large.toFixed(0) + 'ms');
  assert.ok(large / small < 24, '输入放大 8 倍，耗时应近似线性（平方级会放大 64 倍），实际 ×' + (large / small).toFixed(1));
});
