/**
 * 极简 Markdown 渲染器（标题 / 段落 / 列表 / 代码 / 表格 / 引用 / 公式）。
 *
 * 安全模型：
 *  - 全部文本都通过 document.createTextNode 落地，绝不用 innerHTML 拼接服务端文本。
 *  - KaTeX 走 katex.render(tex, el) 直接写入 DOM 节点，不使用 renderToString + innerHTML。
 *  - 链接只允许 http(s) 与站内相对路径，其余一律降级为纯文本。
 */

import katex from 'katex';
import { el, text, type Child } from './dom';

export interface MarkdownOptions {
  /** 代码块最大高度（行），超出滚动。 */
  codeMaxLines?: number;
  /** 是否渲染 $...$ / $$...$$ 公式。 */
  math?: boolean;
  /** 额外 class。 */
  className?: string;
}

const MATH_OPTIONS = {
  throwOnError: false,
  errorColor: '#ff5c7a',
  strict: false as const,
  trust: false,
  output: 'html' as const,
  macros: { '\\R': '\\mathbb{R}' },
};

/** 把 TeX 渲染进给定元素；失败时降级为等宽文本，不抛异常。 */
export function renderMath(target: HTMLElement, source: string, displayMode = false): void {
  const tex = source.trim();
  if (!tex) return;
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
export function mathBlock(source: string): HTMLElement {
  const box = el('div', { class: 'math-block' });
  renderMath(box, source, true);
  return box;
}

export function mathInline(source: string): HTMLElement {
  const box = el('span', { class: 'math-inline' });
  renderMath(box, source, false);
  return box;
}

/* ---------------------------------------------------------------- 行内解析 */

function isSafeHref(href: string): boolean {
  const value = href.trim().toLowerCase();
  if (!value) return false;
  if (value.startsWith('http://') || value.startsWith('https://')) return true;
  if (value.startsWith('/') || value.startsWith('./') || value.startsWith('../')) return true;
  if (value.startsWith('#')) return true;
  if (value.startsWith('mailto:')) return true;
  return false;
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

    // 公式 $...$ / $$...$$
    if (ch === '$' && mathOn) {
      const display = source[i + 1] === '$';
      const open = display ? '$$' : '$';
      const start = i + open.length;
      const end = findClosing(source, open, start);
      if (end > start) {
        const tex = source.slice(start, end);
        if (tex.trim()) {
          flush();
          out.push(display ? mathInline(tex) : mathInline(tex));
          i = end + open.length;
          continue;
        }
      }
    }

    // 行内代码
    if (ch === '`') {
      const end = findClosing(source, '`', i + 1);
      if (end > i + 1) {
        flush();
        out.push(el('code', { class: 'md-code' }, source.slice(i + 1, end)));
        i = end + 1;
        continue;
      }
    }

    // 图片 ![alt](src) —— 只保留 alt 文本，不发外部请求
    if (ch === '!' && source[i + 1] === '[') {
      const closeBracket = source.indexOf(']', i + 2);
      const closeParen = closeBracket >= 0 ? source.indexOf(')', closeBracket + 2) : -1;
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
      const closeBracket = source.indexOf(']', i + 1);
      const closeParen = closeBracket >= 0 ? source.indexOf(')', closeBracket + 2) : -1;
      if (closeBracket > 0 && closeParen > closeBracket && source[closeBracket + 1] === '(') {
        const label = source.slice(i + 1, closeBracket);
        const href = source.slice(closeBracket + 2, closeParen);
        flush();
        if (isSafeHref(href)) {
          out.push(el('a', {
            class: 'md-link',
            href,
            target: href.startsWith('http') ? '_blank' : null,
            rel: 'noreferrer noopener',
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
      const end = findClosing(source, spec.marker, start);
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

/** 渲染 Markdown 到文档片段。 */
export function renderMarkdown(source: string, options: MarkdownOptions = {}): DocumentFragment {
  const frag = document.createDocumentFragment();
  const lines = (source ?? '').replace(/\r\n?/g, '\n').split('\n');
  const mathOn = options.math !== false;
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

    // 独立公式块 $$...$$
    if (mathOn && /^\s*\$\$/.test(line)) {
      const single = /^\s*\$\$(.+)\$\$\s*$/.exec(line);
      if (single) {
        frag.appendChild(mathBlock(single[1]));
        i += 1;
        continue;
      }
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/\$\$\s*$/.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) {
        body.push(lines[i].replace(/\$\$\s*$/, ''));
        i += 1;
      }
      frag.appendChild(mathBlock(body.join('\n')));
      continue;
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
      quote.appendChild(renderMarkdown(body.join('\n'), options));
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

    // 段落：合并连续非空行
    const para: string[] = [];
    while (i < lines.length && lines[i].trim()) {
      const current = lines[i];
      if (/^(#{1,6})\s/.test(current)) break;
      if (/^\s*```/.test(current)) break;
      if (/^\s*>/.test(current)) break;
      if (parseListItem(current)) break;
      if (mathOn && /^\s*\$\$/.test(current)) break;
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
