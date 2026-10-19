/**
 * 轻量 DOM 构建器。
 *
 * 设计约束：
 *  - 绝不使用 innerHTML 拼接服务端文本；所有文本走 textContent。
 *  - 属性值一律通过 setAttribute / 直接属性赋值，避免注入。
 *  - 只依赖 DOM API，无第三方运行时。
 */

export type Child = Node | string | number | null | undefined | false;
export type Props = Record<string, unknown>;

const DIRECT_PROPS = new Set([
  'value',
  'checked',
  'disabled',
  'selected',
  'readOnly',
  'multiple',
  'indeterminate',
  'scrollTop',
  'scrollLeft',
  'tabIndex',
]);

function applyStyle(elm: HTMLElement, value: unknown): void {
  if (typeof value === 'string') {
    elm.setAttribute('style', value);
    return;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      const v = record[key];
      if (v === undefined || v === null) continue;
      if (key.startsWith('--')) elm.style.setProperty(key, String(v));
      else (elm.style as unknown as Record<string, string>)[key] = String(v);
    }
  }
}

function applyProps(elm: Element, props?: Props | null): void {
  if (!props) return;
  for (const key of Object.keys(props)) {
    const value = props[key];
    if (value === undefined || value === null || value === false) continue;

    if (key === 'text') {
      elm.textContent = String(value);
      continue;
    }
    if (key === 'class' || key === 'className') {
      elm.setAttribute('class', String(value));
      continue;
    }
    if (key === 'style') {
      applyStyle(elm as HTMLElement, value);
      continue;
    }
    if (key === 'dataset') {
      const record = value as Record<string, unknown>;
      for (const key2 of Object.keys(record)) {
        const v = record[key2];
        if (v === undefined || v === null) continue;
        (elm as HTMLElement).dataset[key2] = String(v);
      }
      continue;
    }
    if (key === 'attrs') {
      const record = value as Record<string, unknown>;
      for (const key2 of Object.keys(record)) {
        const v = record[key2];
        if (v === undefined || v === null || v === false) continue;
        elm.setAttribute(key2, v === true ? '' : String(v));
      }
      continue;
    }
    if (key.startsWith('on') && typeof value === 'function') {
      elm.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
      continue;
    }
    if (DIRECT_PROPS.has(key)) {
      (elm as unknown as Record<string, unknown>)[key] = value;
      continue;
    }
    if (value === true) {
      elm.setAttribute(key, '');
      continue;
    }
    elm.setAttribute(key, String(value));
  }
}

export function append(elm: ParentNode, ...children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    elm.appendChild(typeof child === 'string' || typeof child === 'number'
      ? document.createTextNode(String(child))
      : child);
  }
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Props | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  applyProps(node, props);
  append(node, ...children);
  return node;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export function svg(tag: string, props?: Props | null, ...children: Child[]): SVGElement {
  const node = document.createElementNS(SVG_NS, tag);
  applyProps(node, props);
  append(node, ...children);
  return node;
}

export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function replace(node: Element, ...children: Child[]): void {
  clear(node);
  append(node, ...children);
}

export function text(value: string | number): Text {
  return document.createTextNode(String(value));
}

export function fragment(...children: Child[]): DocumentFragment {
  const frag = document.createDocumentFragment();
  append(frag, ...children);
  return frag;
}

/* ---------------------------------------------------------------- 图标（内联 SVG，零外部请求） */

const ICON_PATHS: Record<string, string> = {
  overview: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  memories: 'M4 5a2 2 0 0 1 2-2h11a1 1 0 0 1 1 1v16l-7-4-7 4z',
  documents: 'M6 2h8l4 4v16H6zM14 2v5h5',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
  workflows: 'M6 4a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM18 16a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM8 6h5a3 3 0 0 1 3 3v5M6 8v10',
  runs: 'M12 7v5l3 2M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18z',
  agents: 'M7 8h10v10H7zM12 3v5M5 12H3M21 12h-2M9 18v3M15 18v3M10 12h.01M14 12h.01',
  models: 'M4 7h10M18 7h2M4 17h4M12 17h8M16 5v4M10 15v4',
  algorithms: 'M5 5l14 14M19 5L5 19',
  graph: 'M12 3a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM5 17a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM19 17a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM12 7v5M12 12l-6 5M12 12l6 5',
  conflicts: 'M12 3l10 18H2zM12 9v5M12 17h.01',
  settings: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM19 12a7 7 0 0 0-.1-1l2-1.5-2-3.4-2.3 1a7 7 0 0 0-1.7-1L14.6 3H9.4l-.3 2.6a7 7 0 0 0-1.7 1l-2.3-1-2 3.4L5.1 11a7 7 0 0 0 0 2l-2 1.5 2 3.4 2.3-1a7 7 0 0 0 1.7 1l.3 2.6h5.2l.3-2.6a7 7 0 0 0 1.7-1l2.3 1 2-3.4-2-1.5c.1-.3.1-.7.1-1z',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6',
  play: 'M7 4l12 8-12 8z',
  close: 'M6 6l12 12M18 6L6 18',
  copy: 'M9 9h10v12H9zM5 15V3h10',
  check: 'M4 12l5 5L20 6',
  plus: 'M12 5v14M5 12h14',
  chevronRight: 'M9 5l7 7-7 7',
  chevronDown: 'M5 9l7 7 7-7',
  filter: 'M3 5h18l-7 8v6l-4-2v-4z',
  external: 'M14 4h6v6M20 4l-9 9M19 14v6H4V5h6',
  upload: 'M12 17V4M6 10l6-6 6 6M4 20h16',
  database: 'M12 3c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6',
  alert: 'M12 4l9 16H3zM12 10v4M12 17h.01',
  zoomIn: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4M11 8v6M8 11h6',
  zoomOut: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4M8 11h6',
  reset: 'M3 12a9 9 0 1 0 3-6.7M3 4v5h5',
  brain: 'M9 4a3 3 0 0 0-3 3 3 3 0 0 0-1 5.8V17a3 3 0 0 0 4 2.8M15 4a3 3 0 0 1 3 3 3 3 0 0 1 1 5.8V17a3 3 0 0 1-4 2.8M12 4v16',
  dot: 'M12 12h.01',
};

export type IconName = keyof typeof ICON_PATHS | string;

export function icon(name: IconName, size = 16): SVGElement {
  const d = ICON_PATHS[name] ?? ICON_PATHS.dot;
  return svg('svg', {
    class: 'icon',
    viewBox: '0 0 24 24',
    width: size,
    height: size,
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': 1.8,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
    focusable: 'false',
  }, svg('path', { d }));
}

/* ---------------------------------------------------------------- 小工具 */

export function debounce<T extends (...args: never[]) => void>(fn: T, wait = 220): T & { cancel(): void } {
  let timer: number | undefined;
  const wrapped = ((...args: never[]) => {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = undefined;
      fn(...args);
    }, wait);
  }) as T & { cancel: () => void };
  wrapped.cancel = () => {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = undefined;
  };
  return wrapped;
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function isElement(node: unknown): node is HTMLElement {
  return !!node && typeof node === 'object' && (node as Node).nodeType === 1;
}
