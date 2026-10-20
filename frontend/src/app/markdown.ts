/**
 * 极简 Markdown 渲染器（标题 / 段落 / 列表 / 代码 / 表格 / 引用 / 公式）。
 *
 * 安全模型：
 *  - 全部文本都通过 document.createTextNode 落地，绝不用 innerHTML 拼接服务端文本。
 *  - KaTeX 走 katex.render(tex, el) 直接写入 DOM 节点，不使用 renderToString + innerHTML。
 *  - 链接用 URL 解析分类（classifyHref）：同源 → 站内；他源 http(s) → 新窗口 + noopener；其余禁用。
 *
 * 代价上限（记忆正文来自智能体，必须假定可能是恶意构造的）：
 *  - 行内解析的「找闭合标记」带单调缓存，整体线性（1.0.0 每个 [ / * / $ 都从头 indexOf，可被构造成平方级）。
 *  - KaTeX 设 maxSize / maxExpand；单个公式与单篇文档的公式数量都有上限，超出按原文显示。
 *  - 引用嵌套深度有上限（逐层递归，`>>>>…` 曾可打爆调用栈）。
 *  - 段落至少消费一行（1.0.0 遇到 "```js 多余文字" 这种行会原地死循环）。
 *  - katex.css 按需加载：只有真的渲染公式时才请求（约 370 KB）。
 */

import katex from 'katex';
import { el, text, type Child } from './dom';

/** 单篇文档渲染期间共享的预算（内部使用）。 */
interface RenderBudget {
  /** 还能渲染多少个公式。 */
  math: number;
  /** 当前引用嵌套深度。 */
  depth: number;
}

export interface MarkdownOptions {
  /** 代码块最大高度（行），超出滚动。 */
  codeMaxLines?: number;
  /** 是否渲染 $...$ / $$...$$ 公式。 */
  math?: boolean;
  /** 额外 class。 */
  className?: string;
  /** 内部：本次渲染的预算（由 renderMarkdown 创建并向下传递）。 */
  budget?: RenderBudget;
}

/** 单篇文档最多渲染的公式数；超出的按原文显示。 */
const MATH_PER_DOCUMENT = 400;
/** 单个公式源码上限（字符）。 */
const MAX_TEX_LENGTH = 4000;
/** 行内 $…$ 的最大跨度（字符）。 */
const MAX_INLINE_MATH = 1000;
/** 块级 $$ 公式最多跨多少行去找闭合。 */
const MAX_MATH_LINES = 200;
/** 引用（>）最大嵌套深度。 */
const MAX_QUOTE_DEPTH = 8;

const MATH_OPTIONS = {
  throwOnError: false,
  errorColor: '#ff5c7a',
  strict: false as const,
  trust: false,
  output: 'html' as const,
  macros: { '\\R': '\\mathbb{R}' },
  // 防构造公式：\rule 等尺寸上限（em）与宏展开次数上限
  maxSize: 20,
  maxExpand: 500,
};

let katexCssRequested = false;

/** KaTeX 样式按需加载：页面第一次真正渲染公式时才插入 /katex.css。 */
export function ensureKatexCss(): void {
  if (katexCssRequested || typeof document === 'undefined') return;
  katexCssRequested = true;
  if (document.querySelector('link[data-katex]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/katex.css';
  link.setAttribute('data-katex', '1');
  document.head.appendChild(link);
}

/** 把 TeX 渲染进给定元素；失败 / 超限时降级为等宽原文，不抛异常。 */
export function renderMath(target: HTMLElement, source: string, displayMode = false, budget?: RenderBudget): void {
  const tex = source.trim();
  if (!tex) return;
  if (tex.length > MAX_TEX_LENGTH || (budget && budget.math <= 0)) {
    target.classList.add('math-skipped');
    target.title = tex.length > MAX_TEX_LENGTH ? '公式过长，按原文显示' : '本页公式过多，其余按原文显示';
    target.textContent = displayMode ? `$$${tex}$$` : `$${tex}$`;
    return;
  }
  if (budget) budget.math -= 1;
  ensureKatexCss();
  try {
    katex.render(tex, target, { ...MATH_OPTIONS, displayMode });
    target.classList.add('math');
    if (displayMode) target.classList.add('math-display');
  } catch {
    target.classList.remove('math');
    target.classList.add('math-error');
    target.textContent = tex;
  }
}

/** 独立公式块：算法目录 / 记忆详情复用。 */
export function mathBlock(source: string, budget?: RenderBudget): HTMLElement {
  const box = el('div', { class: 'math-block' });
  renderMath(box, source, true, budget);
  return box;
}

export function mathInline(source: string, budget?: RenderBudget, displayMode = false): HTMLElement {
  const box = el('span', { class: displayMode ? 'math-inline math-inline-display' : 'math-inline' });
  renderMath(box, source, displayMode, budget);
  return box;
}

/* ---------------------------------------------------------------- 链接分类 */

export interface HrefTarget {
  href: string;
  kind: 'internal' | 'external' | 'mailto';
}

/**
 * 用 URL 解析给链接分类，而不是看前缀。
 * 1.0.0 放行一切以 / 开头的值：`//evil.example/x`（协议相对）与 `/\evil.example`（浏览器把 \ 当 /）
 * 都被当成站内链接、在**当前窗口**跳到另一个源——在桌面壳里那是挂着 preload 桥的主窗口。
 */
export function classifyHref(raw: string, base: string = window.location.href): HrefTarget | null {
  const value = raw.trim();
  if (!value) return null;
  // 控制字符 / 空白会被 URL 解析器静默剔除，正好用来伪装协议
  if (/[\u0000-\u001f\u007f\s]/.test(value)) return null;
  let url: URL;
  let origin: string;
  try {
    url = new URL(value, base);
    origin = new URL(base).origin;
  } catch {
    return null;
  }
  if (url.protocol === 'mailto:') return { href: url.href, kind: 'mailto' };
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (origin !== 'null' && url.origin === origin) {
    return { href: url.pathname + url.search + url.hash, kind: 'internal' };
  }
  return { href: url.href, kind: 'external' };
}

/* ---------------------------------------------------------------- 行内解析 */

/**
 * 「从 from 起第一个合法闭合位置」的单调缓存。合法性只取决于位置本身（是否被转义等），
 * 所以查得 f→k 之后，任何 f' ∈ [f, k] 的答案仍是 k；查不到（-1）则更靠后的起点也查不到。
 * 行内解析的起点单调递增，于是每类标记的扫描总量是线性的。
 */
class CloseFinder {
  private readonly memo = new Map<string, { from: number; at: number }>();

  find(key: string, from: number, search: (start: number) => number): number {
    const hit = this.memo.get(key);
    if (hit && from >= hit.from && (hit.at === -1 || from <= hit.at)) return hit.at;
    const at = search(from);
    this.memo.set(key, { from, at });
    return at;
  }
}

/** 从 from 起下一个未被反斜杠转义的 $。 */
function nextDollar(source: string, from: number): number {
  let index = from;
  for (;;) {
    index = source.indexOf('$', index);
    if (index === -1 || source[index - 1] !== '\\') return index;
    index += 1;
  }
}

/**
 * 行内 $…$ 只认「开头之后的**第一个** $」作闭合，且它必须合法：前一个字符不是空白、
 * 后一个字符既不是数字也不是 $。第一个 $ 不合法时这个开头就按普通字符处理——
 * 于是 "$5 和 $10" 两个 $ 都是原文，而同一行里的 $a+b$ 仍是公式。
 */
function isInlineMathClose(source: string, index: number): boolean {
  const before = source[index - 1];
  const after = source[index + 1];
  return before !== undefined && !/\s/.test(before) && !(after !== undefined && /[0-9$]/.test(after));
}

interface InlineSpec {
  marker: string;
  handle: (inner: string, options: MarkdownOptions) => Child;
}

const SPECS: InlineSpec[] = [
  {
    marker: '`',
    handle: (inner) => el('code', { class: 'md-code' }, inner),
  },
  {
    marker: '**',
    handle: (inner, options) => el('strong', null, ...inlineNodes(inner, options)),
  },
  {
    marker: '~~',
    handle: (inner, options) => el('del', null, ...inlineNodes(inner, options)),
  },
  {
    marker: '*',
    handle: (inner, options) => el('em', null, ...inlineNodes(inner, options)),
  },
];

function findClosing(source: string, marker: string, from: number): number {
  let index = source.indexOf(marker, from);
  while (index !== -1) {
    // 跳过被反斜杠转义的标记
    if (index > 0 && source[index - 1] === '\\') {
      index = source.indexOf(marker, index + marker.length);
      continue;
    }
    return index;
  }
  return -1;
}

function unescapeText(value: string): string {
  return value.replace(/\\([\\`*_{}\[\]()#+\-.!|>$~])/g, '$1');
}

/** 把行内 Markdown 解析成节点数组（不产生 innerHTML）。 */
export function inlineNodes(source: string, options: MarkdownOptions = {}): Child[] {
  const out: Child[] = [];
  const mathOn = options.math !== false;
  const budget = options.budget;
  const finder = new CloseFinder();
  let buffer = '';
  let i = 0;

  const flush = (): void => {
    if (buffer) {
      out.push(text(unescapeText(buffer)));
      buffer = '';
    }
  };

  while (i < source.length) {
    const ch = source[i];

    // 公式：$$…$$ 在行内也按 display 模式渲染；$…$ 遵循 pandoc 规则（开头后、结尾前不能是空白，结尾后不能是数字）
    if (ch === '$' && mathOn && source[i - 1] !== '\\') {
      if (source[i + 1] === '$') {
        const start = i + 2;
        const end = finder.find('$$', start, (from) => findClosing(source, '$$', from));
        if (end > start && source.slice(start, end).trim()) {
          flush();
          out.push(mathInline(source.slice(start, end), budget, true));
          i = end + 2;
          continue;
        }
        buffer += '$$';
        i += 2;
        continue;
      }
      const next = source[i + 1];
      if (next !== undefined && !/\s/.test(next)) {
        const end = finder.find('$', i + 1, (from) => nextDollar(source, from));
        if (end > i + 1 && end - i <= MAX_INLINE_MATH && isInlineMathClose(source, end)) {
          flush();
          out.push(mathInline(source.slice(i + 1, end), budget));
          i = end + 1;
          continue;
        }
      }
    }

    // 行内代码
    if (ch === '`') {
      const end = finder.find('`', i + 1, (from) => findClosing(source, '`', from));
      if (end > i + 1) {
        flush();
        out.push(el('code', { class: 'md-code' }, source.slice(i + 1, end)));
        i = end + 1;
        continue;
      }
    }

    // 图片 ![alt](src) —— 只保留 alt 文本，不发外部请求
    if (ch === '!' && source[i + 1] === '[') {
      const closeBracket = finder.find(']', i + 2, (from) => source.indexOf(']', from));
      const closeParen = closeBracket >= 0 ? finder.find(')', closeBracket + 2, (from) => source.indexOf(')', from)) : -1;
      if (closeBracket > 0 && closeParen > closeBracket) {
        const alt = source.slice(i + 2, closeBracket);
        flush();
        out.push(el('span', { class: 'md-image-alt', title: '图片（离线不加载）' }, `[图] ${alt}`));
        i = closeParen + 1;
        continue;
      }
    }

    // 链接 [text](href)
    if (ch === '[') {
      const closeBracket = finder.find(']', i + 1, (from) => source.indexOf(']', from));
      const closeParen = closeBracket >= 0 ? finder.find(')', closeBracket + 2, (from) => source.indexOf(')', from)) : -1;
      if (closeBracket > 0 && closeParen > closeBracket && source[closeBracket + 1] === '(') {
        const label = source.slice(i + 1, closeBracket);
        const href = source.slice(closeBracket + 2, closeParen);
        flush();
        const target = classifyHref(href);
        if (target) {
          // 他源链接永远新窗口 + noopener（桌面壳把新窗口交给系统浏览器），绝不在当前窗口离开本源
          out.push(el('a', {
            class: target.kind === 'internal' ? 'md-link' : 'md-link is-external',
            href: target.href,
            target: target.kind === 'external' ? '_blank' : null,
            rel: target.kind === 'internal' ? null : 'noopener noreferrer',
            title: target.kind === 'external' ? `外部链接：${target.href}` : null,
          }, ...inlineNodes(label, options)));
        } else {
          out.push(el('span', { class: 'md-link-blocked', title: '不安全的链接已禁用' },
            ...inlineNodes(label, options)));
        }
        i = closeParen + 1;
        continue;
      }
    }

    // 加粗 / 斜体 / 删除线
    let matched = false;
    for (const spec of SPECS) {
      if (!source.startsWith(spec.marker, i)) continue;
      if (spec.marker === '`') continue; // 已在上方处理
      const start = i + spec.marker.length;
      const end = finder.find(spec.marker, start, (from) => findClosing(source, spec.marker, from));
      if (end <= start) continue;
      flush();
      out.push(spec.handle(source.slice(start, end), options));
      i = end + spec.marker.length;
      matched = true;
      break;
    }
    if (matched) continue;

    buffer += ch;
    i += 1;
  }

  flush();
  return out;
}

export function renderInline(source: string, options: MarkdownOptions = {}): DocumentFragment {
  const frag = document.createDocumentFragment();
  for (const node of inlineNodes(source, options)) {
    if (node === null || node === undefined || node === false) continue;
    frag.appendChild(typeof node === 'string' || typeof node === 'number'
      ? document.createTextNode(String(node))
      : node);
  }
  return frag;
}

/* ---------------------------------------------------------------- 块级解析 */

function splitTableRow(line: string): string[] {
  let body = line.trim();
  if (body.startsWith('|')) body = body.slice(1);
  if (body.endsWith('|')) body = body.slice(0, -1);
  return body.split('|').map((cell) => cell.trim());
}

function isTableDivider(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes('-')) return false;
  if (!/^\|?[\s:|-]+\|?$/.test(trimmed)) return false;
  return splitTableRow(trimmed).every((cell) => /^:?-{1,}:?$/.test(cell));
}

interface ListItem {
  indent: number;
  ordered: boolean;
  content: string;
}

function parseListItem(line: string): ListItem | null {
  const match = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
  if (!match) return null;
  return {
    indent: match[1].replace(/\t/g, '  ').length,
    ordered: /\d/.test(match[2]),
    content: match[3],
  };
}

function buildList(items: ListItem[], options: MarkdownOptions): HTMLElement {
  const root = el('ul', { class: 'md-list' });
  let current = root;
  let lastIndent = items.length ? items[0].indent : 0;

  for (const item of items) {
    if (item.indent > lastIndent + 1) {
      const nested = el('ul', { class: 'md-list md-list-nested' });
      const lastLi = current.lastElementChild;
      if (lastLi) lastLi.appendChild(nested);
      else current.appendChild(nested);
      current = nested;
      lastIndent = item.indent;
    } else if (item.indent < lastIndent) {
      current = root;
      lastIndent = items.length ? items[0].indent : 0;
    }
    if (item.ordered) root.setAttribute('data-ordered', '1');
    const li = el('li', { class: 'md-li' }, ...inlineNodes(item.content, options));
    current.appendChild(li);
  }
  if (root.getAttribute('data-ordered') === '1') {
    // 有序列表：改用 ol 外壳（保留嵌套结构）
    const ol = el('ol', { class: 'md-list' });
    while (root.firstChild) ol.appendChild(root.firstChild);
    return ol;
  }
  return root;
}

/**
 * 块级 $$ 公式的结束行：同一行闭合时只有「整行就是一个公式」才算块级（否则交给行内解析）；
 * 跨行时最多向后找 MAX_MATH_LINES 行。找不到返回 -1（按普通段落处理，不会吞掉后文）。
 */
function mathBlockEnd(lines: string[], start: number): number {
  const open = /^\s*\$\$/.exec(lines[start]);
  if (!open) return -1;
  const rest = lines[start].slice(open[0].length);
  const closeAt = rest.indexOf('$$');
  if (closeAt >= 0) return closeAt > 0 && !rest.slice(closeAt + 2).trim() ? start : -1;
  for (let j = start + 1; j < lines.length && j <= start + MAX_MATH_LINES; j += 1) {
    const at = lines[j].indexOf('$$');
    if (at >= 0) return lines[j].slice(at + 2).trim() ? -1 : j;
  }
  return -1;
}

/** 渲染 Markdown 到文档片段。 */
export function renderMarkdown(source: string, options: MarkdownOptions = {}): DocumentFragment {
  const frag = document.createDocumentFragment();
  const lines = (source ?? '').replace(/\r\n?/g, '\n').split('\n');
  const mathOn = options.math !== false;
  if (!options.budget) options = { ...options, budget: { math: MATH_PER_DOCUMENT, depth: 0 } };
  const budget = options.budget as RenderBudget;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 空行
    if (!line.trim()) {
      i += 1;
      continue;
    }

    // 围栏代码块
    const fence = /^\s*```([\w+#.-]*)\s*$/.exec(line);
    if (fence) {
      const lang = fence[1];
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1; // 跳过结束围栏
      const code = el('code', null, body.join('\n'));
      const pre = el('pre', { class: 'md-pre' }, code);
      if (lang) pre.setAttribute('data-lang', lang);
      const wrap = el('div', { class: 'md-codeblock' }, pre);
      if (options.codeMaxLines && body.length > options.codeMaxLines) {
        wrap.classList.add('is-scroll');
        wrap.style.setProperty('max-height', `${options.codeMaxLines * 1.45}em`);
      }
      frag.appendChild(wrap);
      continue;
    }

    // 独立公式块 $$...$$（必须能找到闭合；找不到就当普通段落，不吞后文）
    if (mathOn) {
      const end = mathBlockEnd(lines, i);
      if (end >= 0) {
        const first = line.replace(/^\s*\$\$/, '');
        const tex = end === i
          ? first.replace(/\$\$\s*$/, '')
          : [first, ...lines.slice(i + 1, end), lines[end].replace(/\$\$\s*$/, '')].join('\n');
        frag.appendChild(mathBlock(tex, budget));
        i = end + 1;
        continue;
      }
    }

    // 标题
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = Math.min(6, heading[1].length) as 1 | 2 | 3 | 4 | 5 | 6;
      frag.appendChild(el(`h${level}`, { class: 'md-h' }, ...inlineNodes(heading[2], options)));
      i += 1;
      continue;
    }

    // 分割线
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      frag.appendChild(el('hr', { class: 'md-hr' }));
      i += 1;
      continue;
    }

    // 引用
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        body.push(lines[i].replace(/^\s*>\s?/, ''));
        i += 1;
      }
      const quote = el('blockquote', { class: 'md-quote' });
      if (budget.depth >= MAX_QUOTE_DEPTH) {
        // 嵌套过深：剩余内容按纯文本放进最后一层，避免逐层递归打爆调用栈
        quote.appendChild(el('p', { class: 'md-p' }, body.join('\n')));
      } else {
        budget.depth += 1;
        quote.appendChild(renderMarkdown(body.join('\n'), options));
        budget.depth -= 1;
      }
      frag.appendChild(quote);
      continue;
    }

    // 表格
    if (line.includes('|') && i + 1 < lines.length && isTableDivider(lines[i + 1])) {
      const header = splitTableRow(line);
      const table = el('table', { class: 'md-table' });
      const thead = el('thead');
      const headRow = el('tr');
      for (const cell of header) {
        headRow.appendChild(el('th', null, ...inlineNodes(cell, options)));
      }
      thead.appendChild(headRow);
      table.appendChild(thead);
      i += 2;
      const tbody = el('tbody');
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        const row = el('tr');
        const cells = splitTableRow(lines[i]);
        for (let c = 0; c < header.length; c += 1) {
          row.appendChild(el('td', null, ...inlineNodes(cells[c] ?? '', options)));
        }
        tbody.appendChild(row);
        i += 1;
      }
      table.appendChild(tbody);
      frag.appendChild(el('div', { class: 'md-table-wrap' }, table));
      continue;
    }

    // 列表
    const firstItem = parseListItem(line);
    if (firstItem) {
      const items: ListItem[] = [];
      while (i < lines.length) {
        const item = parseListItem(lines[i]);
        if (!item) {
          // 允许列表项续行（缩进的非列表行）
          if (items.length && /^\s{2,}\S/.test(lines[i]) && lines[i].trim()) {
            items[items.length - 1].content += ` ${lines[i].trim()}`;
            i += 1;
            continue;
          }
          break;
        }
        items.push(item);
        i += 1;
      }
      frag.appendChild(buildList(items, options));
      continue;
    }

    // 段落：合并连续非空行。第一行无条件收下——保证每轮至少前进一行
    // （1.0.0 对 "```js 多余文字" 这类行：块级围栏不认、段落又在第一行就 break，原地死循环）。
    const para: string[] = [line.trim()];
    i += 1;
    while (i < lines.length && lines[i].trim()) {
      const current = lines[i];
      if (/^(#{1,6})\s/.test(current)) break;
      if (/^\s*```/.test(current)) break;
      if (/^\s*>/.test(current)) break;
      if (parseListItem(current)) break;
      if (mathOn && mathBlockEnd(lines, i) >= 0) break;
      if (current.includes('|') && i + 1 < lines.length && isTableDivider(lines[i + 1])) break;
      para.push(current.trim());
      i += 1;
    }
    frag.appendChild(el('p', { class: 'md-p' }, ...inlineNodes(para.join(' '), options)));
  }

  return frag;
}

/** 渲染进一个容器元素（会先清空）。 */
export function renderMarkdownInto(
  target: HTMLElement,
  source: string,
  options: MarkdownOptions = {},
): void {
  while (target.firstChild) target.removeChild(target.firstChild);
  if (options.className && !target.classList.contains(options.className)) {
    target.classList.add(options.className);
  }
  target.appendChild(renderMarkdown(source, options));
}

/** 纯文本摘要（去掉 Markdown 标记，用于列表预览）。 */
export function plainText(source: string, maxLength = 200): string {
  const stripped = (source ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_~`|-]/g, ' ')
    .replace(/\$\$?/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (stripped.length <= maxLength) return stripped;
  return `${stripped.slice(0, maxLength)}…`;
}
