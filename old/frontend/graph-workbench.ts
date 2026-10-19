/** Memora's own graph controls. They read projections and never mutate memory storage. */
import { memoryIdentity, rememberMemory, rememberedMemory } from './brain-selection';
export interface SearchEntry { id: string; title: string; body: string; section: string }
interface GraphHost {
  readonly searchEntries: SearchEntry[];
  overview(): void;
  /**
   * Rotate to the angle this graph reads best at (see best-view.ts). Installed by every one of the
   * three views; the button is only built when it exists, so a view without it never shows a dead
   * control.
   */
  bestView?(): { azimuth?: number; polar?: number; distance?: number } | null;
  selectBySlug?(id: string, focus?: boolean): boolean;
  selectById?(id: string, focus?: boolean): boolean;
  setSectionColors?(enabled: boolean): void;
  readonly layoutChoices?: { id: string; title: string }[];
  readonly currentLayout?: string;
  setLayout?(id: string): void;
  setFlow?(enabled: boolean): void;
  /** The direction cue the outline view installs, when it has one. */
  readonly flowOverlay?: { setEnabled(enabled: boolean): void } | null;
}

export function searchEntries(entries: SearchEntry[], query: string): SearchEntry[] {
  const words = query.normalize('NFKC').trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return entries.map((entry, index) => {
    const title = entry.title.normalize('NFKC').toLocaleLowerCase();
    const hay = `${title} ${entry.body} ${entry.section}`.normalize('NFKC').toLocaleLowerCase();
    return { entry, index, match: words.every(word => hay.includes(word)),
      rank: words.length && words.every(word => title.includes(word)) ? 0 : 1 };
  }).filter(x => x.match).sort((a, b) => a.rank - b.rank || a.index - b.index).map(x => x.entry);
}

/**
 * The switch for the parent-to-child direction cue. It starts from the motion
 * preference rather than defaulting to on, and it drives whichever cue the view
 * actually installed — the copied renderer's own flow when there is no
 * first-party overlay, so the control is never a button that does nothing.
 */
export function flowControlState(host: GraphHost): boolean {
  // Only meaningful when the view installed a cue; the motion preference, not
  // "on by default", is what decides the initial state.
  if (!host.flowOverlay && !host.setFlow) return false;
  return !matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function installWorkbench(host: GraphHost): void {
  // Renderer selection indices correspond to searchEntries. Keep the stable memory ID instead
  // of the renderer-specific slug, so a 2D/3D switch restores the same evidence.
  const selectable = host as GraphHost & { select?: (index: number, focus: boolean) => void };
  if (selectable.select) {
    const select = selectable.select.bind(host);
    selectable.select = (index, focus) => {
      select(index, focus);
      const entry = host.searchEntries[index];
      const id = entry && memoryIdentity(entry.body);
      if (id) rememberMemory(id);
    };
  }
  const remembered = rememberedMemory();
  if (remembered) {
    let attempts = 0;
    const timer = window.setInterval(() => {
      const entry = host.searchEntries.find(e => memoryIdentity(e.body) === remembered);
      if (entry) {
        if (host.selectBySlug) host.selectBySlug(entry.id, true);
        else host.selectById?.(entry.id, true);
      }
      if (entry || ++attempts >= 20) clearInterval(timer);
    }, 150);
  }
  const root = document.querySelector('.sa-root')!;
  const controls = document.createElement('section'); controls.className = 'memora-graph-controls';
  controls.setAttribute('aria-label', '图谱搜索与观察');
  const search = document.createElement('div'); search.className = 'memora-graph-search';
  const input = document.createElement('input'); input.type = 'search'; input.placeholder = '搜索节点、释义或来源…';
  input.setAttribute('aria-label', '搜索脑图节点'); input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list'); input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-controls', 'graph-search-results');
  const results = document.createElement('div'); results.className = 'memora-graph-results';
  results.id = 'graph-search-results'; results.setAttribute('role', 'listbox'); results.hidden = true;
  const count = document.createElement('span'); count.className = 'memora-graph-match-count'; count.setAttribute('aria-live', 'polite');
  search.append(input, count, results); controls.append(search);
  if (host.setSectionColors) {
    const color = document.createElement('button'); color.type = 'button'; color.textContent = '分类着色';
    color.setAttribute('aria-pressed', 'false');
    color.onclick = () => { const enabled = color.getAttribute('aria-pressed') !== 'true';
      color.setAttribute('aria-pressed', String(enabled)); host.setSectionColors!(enabled); };
    controls.append(color);
  }
  if (host.layoutChoices && host.setLayout) {
    const select = document.createElement('select'); select.setAttribute('aria-label', '脑图布局');
    for (const layout of host.layoutChoices) {
      const option = document.createElement('option'); option.value = layout.id; option.textContent = layout.title;
      option.selected = layout.id === (host.currentLayout ?? 'force'); select.append(option);
    }
    select.onchange = () => host.setLayout!(select.value); controls.append(select);
    // The explicit picker replaces a button that cycled 23 layouts without naming the next one.
    root.querySelector('.sa-actions button[aria-label="新导图使用的布局"]')?.remove();
  }
  // 最佳视角: one button for all three views, because all three install the same seam. It sits
  // before 全览 on purpose -- "look at it properly" is the first thing a reader wants, and 全览
  // then answers "take me back".
  if (host.bestView) {
    const best = document.createElement('button'); best.type = 'button'; best.textContent = '最佳视角';
    best.setAttribute('aria-label', '旋转到最佳观看视角');
    best.onclick = () => {
      const outcome = host.bestView!();
      // Announce the result for screen readers and for anyone watching the toolbar: the button
      // cannot show a pose, but it can say whether it did anything.
      const note = root.querySelector('.memora-best-view-note') as HTMLElement | null;
      if (note) note.textContent = outcome
        ? '已旋转到最佳视角（方位 ' + degrees(outcome.azimuth) + '° / 俯仰 ' + degrees(outcome.polar) + '°）'
        : '当前视图没有可用的取景角度';
    };
    controls.append(best);
  }
  const overview = document.createElement('button'); overview.type = 'button'; overview.textContent = '全览 / Esc';
  if (host.setFlow || host.flowOverlay) {
    const flow=document.createElement('button');flow.type='button';flow.textContent='层级流动';
    let enabled=flowControlState(host);
    flow.setAttribute('aria-pressed',String(enabled));
    flow.onclick=()=>{enabled=!enabled;
      if(host.flowOverlay)host.flowOverlay.setEnabled(enabled);
      if(host.setFlow)host.setFlow(enabled);
      flow.setAttribute('aria-pressed',String(enabled));};
    controls.append(flow);
  }
  overview.onclick = () => { host.overview(); close(); }; controls.append(overview);
  if (host.bestView) {
    const note = document.createElement('span');
    note.className = 'memora-graph-help memora-best-view-note';
    note.setAttribute('aria-live', 'polite');
    controls.append(note);
  }
  const help = document.createElement('span'); help.className = 'memora-graph-help';
  help.textContent = '拖动旋转 · Shift 拖动平移 · 滚轮缩放 · 点击节点追踪关联'; controls.append(help);
  root.querySelector('.sa-bar')!.after(controls);
  const measure = () => (root as HTMLElement).style.setProperty('--memora-chrome-height',
    (controls.offsetTop + controls.offsetHeight + 10) + 'px');
  new ResizeObserver(measure).observe(controls); measure();
  let matches: SearchEntry[] = [], active = 0;
  function close() { results.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); }
  function open() { results.hidden = false; input.setAttribute('aria-expanded', 'true'); }
  function choose(entry: SearchEntry) {
    if (host.selectBySlug) host.selectBySlug(entry.id, true); else host.selectById?.(entry.id, true);
    input.value = entry.title; close();
  }
  function highlight() {
    results.querySelectorAll('[role="option"]').forEach((el, i) => el.setAttribute('aria-selected', String(i === active)));
    input.setAttribute('aria-activedescendant', 'graph-match-' + active);
  }
  function render() {
    matches = searchEntries(host.searchEntries, input.value); active = 0; results.replaceChildren();
    count.textContent = matches.length + ' 项';
    if (!matches.length) { const empty = document.createElement('p'); empty.textContent = '没有匹配节点'; results.append(empty); }
    matches.slice(0, 40).forEach((entry, i) => {
      const item = document.createElement('button'); item.type = 'button'; item.id = 'graph-match-' + i;
      item.setAttribute('role', 'option');
      const title = document.createElement('strong'); title.textContent = entry.title;
      const body = document.createElement('small'); body.textContent = entry.section + ' · ' + entry.body.replace(/[>#*\[\]]/g, '').slice(0, 100);
      item.append(title, body); item.onclick = () => choose(entry); results.append(item);
    });
    highlight(); open();
  }
  input.addEventListener('input', render); input.addEventListener('focus', render);
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); const n = Math.min(matches.length, 40); if (!n) return;
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + n) % n; highlight(); open();
    } else if (e.key === 'Enter' && matches[active]) { e.preventDefault(); choose(matches[active]); }
    else if (e.key === 'Escape') { input.value = ''; close(); host.overview(); input.blur(); }
  });
  document.addEventListener('pointerdown', e => { if (!search.contains(e.target as Node)) close(); });
  document.addEventListener('keydown', e => {
    if ((e.target as HTMLElement).matches('input,textarea,select')) return;
    if (e.key === '/') { e.preventDefault(); input.focus(); }
    if (e.key === 'Escape') { close(); host.overview(); }
  });
}

/** Radians to whole degrees, for the toolbar's status line. */
function degrees(radians: number | undefined): string {
  return radians === undefined || !Number.isFinite(radians)
    ? '—'
    : String(Math.round((radians * 180) / Math.PI));
}
