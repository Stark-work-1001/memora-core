'use strict';
// memora workbench. Vanilla ES2020, no build step, no runtime dependency: this file is served
// straight from the Python stdlib server.
// Read order: helpers -> transport -> shared chrome -> result card -> retrieval -> recent
// sessions -> processing status -> live updates -> inbox -> agents -> documents -> brain ->
// settings -> background -> bootstrap.
// orchestration.js loads after this file and reuses `titles`, `node`, `$`, `run`, `state` and
// `state.onView`; none of those names or the view-switching mechanism are changed here.

/* ------------------------------------------------------------------ helpers */

const $ = id => document.getElementById(id);
const state = {
  view: 'retrieve', config: null, token: '', cursor: null, document: null, latest: 0,
  // retrieve page
  sessions: null, sessionsCache: null, jobs: null, search: null, refreshing: false,
  // live updates. `want` is what this page is asking for: false = no stream, null = the
  // workbench-wide stream (no id), or a generation job id. `job` is the id of the connection
  // currently open, null for the workbench-wide one; `applied` is the last frame acted on, so a
  // frame only refreshes the blocks it actually changed.
  live: {stream: null, job: null, want: false, project: '', status: 'idle', detail: '',
         last: null, applied: null, timer: 0, retry: 0, watchdog: 0, flush: 0,
         proven: false, dirty: new Set()}
};
const titles = {
  retrieve: '记忆检索', inbox: '分类与沉淀', agents: '智能体接入',
  documents: 'Markdown 文档', brain: '脑图', settings: '模型配置'
};
const project = () => $('project').value.trim() || 'default';
try {
  const initial = new URL(location.href).searchParams.get('project')
    || localStorage.getItem('memora-project');
  if (initial && /^[:\p{L}\p{N}_-]{1,80}$/u.test(initial)) $('project').value = initial;
} catch {}

/* ------------------------------------------------------------------ read scope

   The project picker used to be a bare text box in the sidebar. A scope is a READ RANGE, so it
   moved into 记忆检索 and grew the four rungs the store actually supports. The state lives here:
     state.scope.tier        'global' | 'workspace' | 'project' | 'conversation'
     state.scope.session     session id for the conversation rung, or ''
   Every recall call sends both, so a result list can never quietly disagree with the selected
   rung. `scopeRefresh()` re-reads the counts so the panel shows "global: 0" instead of leaving the
   user guessing why a shared fact does not appear. */
const TIER_LABELS = { global: '全局', workspace: '工作区', project: '项目', conversation: '对话' };
state.scope = { tier: 'project', session: '', ladder: null, path: '' };
try {
  const savedTier = localStorage.getItem('memora-scope-tier');
  if (savedTier && TIER_LABELS[savedTier]) state.scope.tier = savedTier;
} catch {}

const node = (tag, text, cls) => {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = String(text);
  if (cls) e.className = cls;
  return e;
};
const empty = (target, text) => { target.replaceChildren(node('div', text, 'empty')); };

/** Join only the parts that carry a value, so a card can never print "undefined". */
const lines = (...parts) => parts
  .filter(p => p !== undefined && p !== null && p !== '' && p !== false)
  .join(' · ');
const shown = v => (v === undefined || v === null || v === '' ? ''
  : (typeof v === 'object' ? JSON.stringify(v) : String(v)));
const pad = n => String(n).padStart(2, '0');

/** ISO timestamp -> local "YYYY-MM-DD HH:MM", or the raw value when it will not parse. */
function stamp(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
       + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}
/** Coarse "how long ago", for access times and job updates. */
function ago(iso) {
  const t = new Date(iso || '').getTime();
  if (!iso || Number.isNaN(t)) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return '刚刚';
  if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
  if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
  return Math.floor(s / 86400) + ' 天前';
}

function notice(text) { $('notice').textContent = text; $('notice').hidden = !text; }

/* ------------------------------------------------------------------ transport */

// Unchanged contract: POST bodies carry X-MM-Token, GETs do not need it. do_GET only validates
// the Host header (memora/web.py:48); the token / Origin / Content-Type check is in do_POST
// (memora/web.py:127).
async function api(path, body) {
  const url = new URL('/api/agent/' + path, location.origin);
  url.searchParams.set('project', project());
  const options = body === undefined ? {} : {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'X-MM-Token': state.token},
    body: JSON.stringify({project: project(), ...body})
  };
  const response = await fetch(url, options);
  let result;
  try { result = await response.json(); } catch { throw new Error('服务响应异常：' + response.status); }
  if (!response.ok || (result.error && typeof result.error === 'object')) {
    throw new Error(result.error?.message || '请求失败：' + response.status);
  }
  return result;
}
async function query(path, params) {
  const url = new URL('/api/agent/' + path, location.origin);
  url.searchParams.set('project', project());
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== null && v !== undefined) url.searchParams.set(k, String(v));
  }
  const r = await fetch(url);
  const out = await r.json();
  if (!r.ok) throw new Error(out.error?.message || '读取失败');
  return out;
}
async function run(action, button) {
  if (button) button.disabled = true;
  try { return await action(); }
  catch (e) { notice(e.message); return null; }
  finally { if (button) button.disabled = false; }
}
function button(text, action) {
  const b = node('button', text);
  b.type = 'button';
  b.onclick = () => run(action, b);
  return b;
}

/* ------------------------------------------------------------------ shared chrome */

/**
 * The edition banner under the wordmark: which copy of the application this window is, and which
 * version. The edition is decided by the BACKEND (frozen build -> standalone, source -> devel), so
 * the same page source renders the truth for whichever copy is running; a hardcoded label would
 * keep saying "devel" in the packaged app, which is the exact mix-up this banner prevents.
 *
 * Absent edition is its own state: an older backend that does not report it must not be labelled
 * either edition, because a wrong label is worse than an honest "未知".
 */
function paintEdition(config) {
  const host = $('edition');
  const mark = $('edition-mark');
  const version = $('edition-version');
  if (!mark || !version) return;
  const reported = config && typeof config.edition === 'string' ? config.edition : '';
  // Only the two editions this banner can vouch for get their own styling. Anything else -- a field
  // the backend does not send, or a value a future build invents -- collapses to 'unknown' in the
  // DOM as well as in the text, so the CSS can never paint it with a real edition's colour.
  const edition = reported === 'standalone' || reported === 'devel' ? reported : '';
  const label = edition === 'standalone' ? 'standalone' : edition === 'devel' ? 'devel' : '版本未知';
  if (mark) mark.textContent = label;
  if (version) version.textContent = config && config.version ? 'v' + config.version : '';
  if (host) {
    // Set the ATTRIBUTE, not the dataset object. In a real browser they are the same thing, but
    // dataset is a live reflection this page does not otherwise need, and writing through it made
    // the whole bootstrap depend on a DOM feature that the static-UI harnesses had to stub -- a
    // product code path should not be shaped by a test double. data-edition is what the CSS reads.
    host.setAttribute('data-edition', edition || 'unknown');
    host.title = edition === 'standalone'
      ? '独立可运行桌面程序：用户实际使用的那一份，数据目录与开发测试目录相互独立。'
      : edition === 'devel'
        ? '开发测试目录：正在改动与审查的那一份，界面改动在此验收后再同步到独立版。'
        : '后端没有上报 edition 字段，无法判断这是开发版还是独立版。';
  }
}

async function loadStatus() {
  state.config = await api('status');
  // The version now lives once, in the banner under the wordmark (see paintEdition); this line used
  // to write a second copy at the bottom of the sidebar, which said the same thing in a different
  // place and made the two disagree whenever one of them was missed.
  paintEdition(state.config);
  $('kernel').textContent = '检索内核 · ' + (state.config.kernel === 'native' ? 'Rust' : state.config.kernel);
  $('role-status').textContent = 'Embedding ' + (state.config.embedding ? '已配置' : '未配置')
    + ' / Judge ' + (state.config.judge ? '已配置' : '规则分类');
}
async function show(view) {
  state.view = view;
  // No stream behind another page: its frames describe blocks this view does not render.
  if (view !== 'retrieve') wantLive(false);
  document.querySelectorAll('.view').forEach(e => { e.hidden = e.id !== view; });
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  $('heading').textContent = titles[view] || view;
  notice('');
  if (view === 'inbox') await queue();
  if (view === 'agents') {
    await peers(); const setup = await api('setup');
    $('mcp-config').textContent = JSON.stringify({mcpServers: setup.mcpServers}, null, 2);
    $('codex-config').textContent = setup.codex_toml || '';
    $('dsh-config').textContent = JSON.stringify(setup.dsh_patch, null, 2);
    $('connection-instructions').textContent = setup.instructions || '';
  }
  if (view === 'documents') await documents();
  // 脑图 first decides WHERE its data comes from, then loads it. Doing the decision here (and not
  // in brain()) keeps the data-source question out of the renderer, which the layout selectors call
  // on every change.
  if (view === 'brain') { await decideBrainSource(); brain(); }
  if (view === 'settings') { await loadStatus(); settings(); await loadModelTypes(); }
  if (view === 'retrieve') await enterRetrieve();
  if (state.onView) await state.onView(view);
}
document.querySelectorAll('nav button').forEach(b => { b.onclick = () => run(() => show(b.dataset.view), b); });

// The workflow canvas is a standalone top-level page (workbench.ASSETS['/dag']), not a view, so
// it is an <a> and never a <button data-view>: the binding above and show()'s .active toggle both
// select 'nav button' only, so an <a> cannot be mistaken for a view that does not exist.
// The scope is read at click time, not at load time -- #project can hold an uncommitted edit
// (onchange only fires on blur), and the canvas must open over the project actually on screen.
// This lives here rather than inline in memory.html because web.py:23 sets script-src 'self'.
// The trailing slash is load-bearing: dag/index.html loads styles.css and app.js as SIBLING
// RELATIVE urls, so they resolve against this path's directory. At '/dag?project=x' they
// become /styles.css and /app.js, which nothing serves -- verified in a real browser: the page
// arrived unstyled with a dead script and an empty rail. At '/dag/?project=x' they resolve to
// the /dag/styles.css and /dag/app.js that ASSETS does serve. Do not 'tidy' the slash away.
const canvasLink = document.querySelector('nav a[data-canvas]');
if (canvasLink) canvasLink.onclick = () => {
  canvasLink.href = '/dag/?project=' + encodeURIComponent(project());
};

$('project').onchange = () => run(async () => {
  if (!/^[:\p{L}\p{N}_-]{1,80}$/u.test(project())) throw new Error('项目名称使用字母、数字、汉字、下划线或连字符');
  try { localStorage.setItem('memora-project', project()); } catch {}
  $('results').replaceChildren();
  $('search-info').textContent = '只检索已审核的记忆';
  setWarning('');
  resetRag();                       // a pack from the old project must not label the new one
  resetDocumentChunks();            // and neither must a corpus count: clear it, do not refetch
  resetSessionCache();              // and neither must an archived-conversation list
  resetSessionSearch();             // nor must a search summary from the previous project
  wantLive(false);                  // and so must a stream: its frames carry the old project
  state.document = null;
  state.latest = 0;
  state.search = null;
  // The preview decision belongs to ONE project: another project may have approved memories, so
  // the choice (and the note that explains it) has to be made again for the new scope.
  state.brainPreview = false;
  state.brainPreviewDecided = false;
  await show(state.view);
  await peers();
});



/** Query parameters carrying the current read scope.

    A narrower rung includes the wider ones, which is decided server-side; the page only says WHERE
    to read. Conversation adds the session pin. Kept as one helper so no call site can forget half
    of the scope and silently read the wrong set. */
function scopeParams(base) {
  const out = Object.assign({}, base || {});
  if (SCOPE_STATE.tier && SCOPE_STATE.tier !== 'project') out.tier = SCOPE_STATE.tier;
  if (SCOPE_STATE.tier === 'conversation' && SCOPE_STATE.session) out.session_id = SCOPE_STATE.session;
  return out;
}

/* ------------------------------------------------------------------ 检索范围（四级）

   The project picker moved out of the sidebar and into 记忆检索, because a scope is a read range
   and the page that reads is where it belongs. Four rungs, widest to narrowest:

     global        全局    :global + :user   — shared facts: identity, long-term preferences
     workspace     工作区  + :workspace      — facts shared by a group of projects
     project       项目    + this project    — the default
     conversation  对话    + one session     — pinned to the selected conversation

   A narrower rung always includes the wider ones: that is what makes a shared fact usable from
   every level. The server decides the set (memora/scopes.py) and returns counts, so this file
   never re-derives the rule and cannot drift from what retrieval actually queries.
*/
const SCOPE_STATE = state.scope;

function scopeQuery() {
  const params = new URLSearchParams({project: project()});
  for (const [k, v] of Object.entries(scopeParams({}))) params.set(k, String(v));
  return params;
}

/** Read the ladder + counts, then repaint. Cheap: one GET, no model calls. */
async function scopeRefresh() {
  const params = new URLSearchParams({project: project()});
  if (SCOPE_STATE.session) params.set('session_id', SCOPE_STATE.session);
  const ladder = await api('scopes?' + params.toString());
  SCOPE_STATE.ladder = ladder;
  scopeRender(ladder);
  return ladder;
}

function scopeRender(ladder) {
  const host = $('scope-tiers');
  if (!host) return;
  host.replaceChildren(...(ladder.tiers || []).map(tier => {
    const available = tier.available !== false;
    const radio = node('button');
    radio.type = 'button';
    radio.className = 'scope-tier' + (SCOPE_STATE.tier === tier.id ? ' is-active' : '')
      + (available ? '' : ' is-unavailable');
    radio.dataset.tier = tier.id;
    radio.setAttribute('role', 'radio');
    radio.setAttribute('aria-checked', SCOPE_STATE.tier === tier.id ? 'true' : 'false');
    if (!available) radio.disabled = true;
    radio.append(
      node('span', tier.title, 'scope-tier-title'),
      node('span', String(tier.count ?? 0), 'scope-tier-count'),
      node('small', tier.description, 'scope-tier-desc')
    );
    radio.onclick = () => run(async () => {
      SCOPE_STATE.tier = tier.id;
      try { localStorage.setItem('memora-scope-tier', tier.id); } catch {}
      await scopeRefresh();
      scopeSummary();
      // Re-run the current query so the list matches the rung the user just picked.
      if (state.search) await search();
    });
    return radio;
  }));

  // The conversation rung needs a session to pin. Offer the ones that actually have memories, from
  // the same payload, so choosing one is not guesswork.
  const conversation = $('scope-conversation');
  const select = $('scope-session');
  if (conversation && select) {
    const rows = ladder.sessions || [];
    conversation.hidden = false;
    const chosen = SCOPE_STATE.session;
    select.replaceChildren(node('option', '（未选择对话）'));
    select.firstChild.value = '';
    for (const row of rows) {
      const option = node('option', row.session_id.slice(0, 8) + ' · ' + row.memories + ' 条');
      option.value = row.session_id;
      option.selected = row.session_id === chosen;
      select.append(option);
    }
    select.onchange = () => run(async () => {
      SCOPE_STATE.session = select.value;
      if (SCOPE_STATE.session) SCOPE_STATE.tier = 'conversation';
      await scopeRefresh();
      scopeSummary();
      if (state.search) await search();
    });
    if (!rows.length) {
      select.replaceChildren(node('option', '（该项目下还没有带会话的记忆）'));
      select.firstChild.value = '';
    }
  }
  scopeSummary();
}

/** One sentence saying what the current rung will read. Never claims more than the counts show. */
function scopeSummary() {
  const ladder = SCOPE_STATE.ladder;
  const host = $('scope-summary');
  if (!host) return;
  if (!ladder) { host.textContent = '正在读取分区…'; return; }
  const tier = (ladder.tiers || []).find(t => t.id === SCOPE_STATE.tier);
  if (!tier) return;
  const bits = ['当前读取：' + tier.title, tier.count + ' 条已审核记忆'];
  if (SCOPE_STATE.tier === 'conversation') {
    bits.push(SCOPE_STATE.session ? ('会话 ' + SCOPE_STATE.session.slice(0, 8)) : '未选择会话（等同项目级）');
  }
  if (SCOPE_STATE.tier !== 'global') bits.push('含更宽级别：' + (tier.projects || []).join(' + '));
  if (!tier.count && SCOPE_STATE.tier !== 'project') {
    bits.push('该级别还没有记忆');
  }
  host.textContent = bits.join(' · ');
}

$('scope-refresh').onclick = () => run(async () => {
  await scopeRefresh();
  notice('分区已刷新。');
});

$('scope-apply').onclick = () => run(async () => {
  const name = $('project').value.trim() || 'default';
  if (!/^[:\p{L}\p{N}_-]{1,80}$/u.test(name)) throw new Error('空间名只接受字母、数字、汉字、下划线或连字符，最长 80 字符');
  const path = $('project-path').value.trim();
  // Persist the path on the server so it survives a reload and is visible to every client, then
  // scope the page to the (possibly renamed) project.
  await api('space', {project: name, path});
  $('project').value = name;
  try {
    localStorage.setItem('memora-project', name);
    localStorage.setItem('memora-project-path', path);
  } catch {}
  SCOPE_STATE.session = '';
  resetSearch();
  await scopeRefresh();
  await show('retrieve');
  notice('已应用项目空间「' + name + '」' + (path ? '，路径 ' + path : '') + '。');
});

// Restore the remembered path label before the first status read.
try {
  const savedPath = localStorage.getItem('memora-project-path');
  if (savedPath && $('project-path')) $('project-path').value = savedPath;
} catch {}

/* ------------------------------------------------------------------ result card

   The recall response carries about twenty fields per hit and the previous card showed five.
   What each field means, read from the server rather than guessed:

     score      three different units share this name:
                  lexical  BM25 relevance, unbounded positive   (memora/store.py:357)
                  vector   cosine similarity in (0,1]           (memora/service.py:181)
                  rrf      reciprocal-rank fusion, about 0-0.03  (memora/service.py:217)
                so every score is labelled with its own unit and never presented as a bare
                number that a reader could compare across hits of different provenance.
     retrieval  per-hit origin: 'lexical' | 'vector' | 'rrf'. This is not the response's
                aggregate `mode`, which names the requested strategy, not the hit's source.
     signals    fused rows only: which stage found the row and at which rank (service.py:211-215).
     locator    a decoded JSON object (store.py:108), never a string to print blindly.
*/

const RETRIEVAL = {lexical: '关键词', vector: '向量', rrf: '融合'};
const SCORE_NOTE = {
  lexical: 'BM25 关键词相关度：只在本列表内可比，不能与向量相似度比较',
  vector: '余弦相似度 0-1：越大越接近问题',
  rrf: 'RRF 融合分：只表示词法与向量的名次组合，不代表相似程度'
};
const KIND_LABEL = {decision: '决策', rule: '规则', lesson: '经验', task: '待办', memory: '记忆', preference: '偏好'};
const POLARITY_LABEL = {positive: '正面', negative: '负面', neutral: '中立'};

function locatorText(locator) {
  if (locator === undefined || locator === null || locator === '') return '';
  if (typeof locator === 'string') return locator;
  if (typeof locator === 'object') {
    const parts = Object.entries(locator).map(([k, v]) => k + ' ' + shown(v));
    return parts.length ? parts.join(' / ') : JSON.stringify(locator);
  }
  return String(locator);
}
function signalText(m) {
  const s = m.signals;
  if (!s || typeof s !== 'object') return '';
  return lines(
    s.lexical_rank ? '词法第 ' + s.lexical_rank + ' 位' : '',
    s.vector_rank ? '向量第 ' + s.vector_rank + ' 位' : '',
    typeof s.similarity === 'number' ? '相似度 ' + s.similarity : ''
  );
}
function scoreChip(m) {
  if (typeof m.score !== 'number') return null;           // never invent a zero; queue rows carry none
  const kind = m.retrieval || 'lexical';
  const text = kind === 'vector' ? '相似度 ' + m.score.toFixed(3)
              : kind === 'rrf' ? '融合分 ' + m.score.toFixed(4)
              : '关键词相关度 ' + m.score.toFixed(2);
  const chip = node('span', text, 'tag');
  chip.title = SCORE_NOTE[kind] || '';
  return chip;
}
function provenanceText(m) {
  return lines(
    m.session_id ? '来自会话 ' + String(m.session_id).slice(0, 8) : '',
    m.doc_id ? '来自文档 ' + shown(m.doc_id) : '',
    m.locator ? '定位 ' + locatorText(m.locator) : ''
  );
}

function memoryCard(m) {
  const card = node('article', undefined, 'card');
  const categories = (state.config && state.config.categories) || {};

  const head = node('div', undefined, 'row');
  head.append(node('span', categories[m.category] || shown(m.category), 'tag'));
  if (m.status) head.append(node('small', shown(m.status)));
  for (const tag of (Array.isArray(m.tags) ? m.tags : [])) head.append(node('span', shown(tag), 'tag'));
  card.append(head);

  card.append(node('p', m.content, 'content'));

  // Relevance and provenance of the hit. Each part is appended only when the backend actually
  // sent it, so a sparse row renders a smaller card instead of empty labels.
  const facts = node('div', undefined, 'row');
  const chip = scoreChip(m);
  if (chip) facts.append(chip);
  const origin = m.retrieval;                      // only retrieval hits carry it
  if (origin && RETRIEVAL[origin]) {
    const how = node('small', '命中 ' + RETRIEVAL[origin]);
    how.title = origin === 'lexical' ? '这条结果来自关键词匹配，没有向量参与'
      : origin === 'vector' ? '这条结果来自向量相似度检索'
      : '这条结果由词法与向量结果融合排序得到';
    facts.append(how);
  }
  const signals = signalText(m);
  if (signals) facts.append(node('small', signals));
  if (m.kind) facts.append(node('small', '类型 ' + (KIND_LABEL[m.kind] || shown(m.kind))));
  if (m.polarity && m.polarity !== 'positive') facts.append(node('small', '倾向 ' + (POLARITY_LABEL[m.polarity] || shown(m.polarity))));
  if (m.scope === 'user') facts.append(node('small', '用户空间'));
  if (facts.children.length) card.append(facts);

  card.append(node('p', lines(
    '来源 ' + shown(m.source || '未记录'),
    m.created ? stamp(m.created) : '',
    m.valid_until ? '有效期至 ' + stamp(m.valid_until) : ''
  ), 'meta'));

  const usage = lines(
    typeof m.access_count === 'number' ? '被检索 ' + m.access_count + ' 次' : '',
    m.last_accessed ? '最近访问 ' + stamp(m.last_accessed) : ''
  );
  if (usage) card.append(node('p', usage, 'meta'));

  const provenance = provenanceText(m);
  if (provenance) card.append(node('p', provenance, 'meta'));

  if (m.event_id) card.append(node('p', '事件 ' + shown(m.event_id), 'meta'));
  card.append(node('p', 'ID ' + shown(m.id), 'meta'));
  return card;
}

/* ------------------------------------------------------------------ retrieval */

function setWarning(text) {
  const box = $('search-warning');
  box.textContent = text ? '⚠ ' + text : '';
  box.hidden = !text;
}

/** Report what the server actually did, including any warning it attached to the response. */
function retrievalInfo(out) {
  const rows = Array.isArray(out.results) ? out.results : [];
  const origins = [...new Set(rows.map(r => RETRIEVAL[r.retrieval] || '未标注'))];
  const bits = [
    '实际检索：' + shown(out.mode || '未标注'),
    rows.length + ' 条结果',
    out.coverage
      ? '索引覆盖 ' + out.coverage.indexed + '/' + out.coverage.recallable + '（未建索引 ' + out.coverage.unindexed + '）'
      : '',
    out.incompatible_vectors ? '向量不匹配 ' + out.incompatible_vectors + ' 条' : '',
    origins.length > 1 ? '结果混合来源：' + origins.join(' + ') : ''
  ];
  $('search-info').textContent = lines(...bits);
  // The service attaches `warning` when the embedder is missing (service.py:157), drifted (166),
  // unreachable (168) or the index is incomplete (174/184). It belongs next to the results, not
  // only in the shared banner that every other action overwrites.
  setWarning(out.warning || '');
  if (out.warning || out.incompatible_vectors) {
    notice(lines(out.warning || '', out.incompatible_vectors ? out.incompatible_vectors + ' 条记忆的向量属于其它模型，请补建索引' : ''));
  }
}

async function search(submitter) {
  const mode = $('search-mode').value;
  const text = $('query').value;
  // The scope is part of the query, not a display filter: the server decides which tiers a
  // rung reads (memora/scopes.py), so passing it here is what makes the rung real.
  const out = await query('recall', scopeParams({query: text, mode}));
  state.search = {query: text, mode};
  retrievalInfo(out);
  const rows = Array.isArray(out.results) ? out.results : [];
  if (!rows.length) {
    empty($('results'), out.warning
      ? '没有结果，而且向量阶段没有参与：' + out.warning
      : '未找到已审核的记忆。可先在“分类与沉淀”中添加并确认。');
    return out;
  }
  $('results').replaceChildren(...rows.map(memoryCard));
  return out;
}

$('search-form').onsubmit = e => { e.preventDefault(); run(() => search(e.submitter), e.submitter); };

/* ------------------------------------------------------------------ 证据包预览

   GET /api/agent/rag -> memora/workbench.py /rag -> service.rag (memora/service.py:224).
   This is the exact envelope a calling model receives: the nonce-wrapped `context`, the
   `references` list, the real `retrieval_mode`, the `retrieval_warning` when there is one, and
   `generation` ('client_required' -- memora supplies material, the calling model writes the
   answer). Seeing the raw <<<evidence NONCE>>> wrappers is the point, so the context is shown
   verbatim in a <pre>, never trimmed.

   Trigger: an explicit button only, never on page load. service.rag() builds its pack through
   recall(record_access=False) (service.py:231 with the default at 147), so a preview never
   inflates access_count -- that is why recall() on this same page is gated behind an explicit
   search instead (see refreshRetrieve). Even so, an automatic call would re-run the pipeline on
   every visit for material nobody asked to see, so the owner asks once, deliberately.

   Rendering is defensive: only `context` and `references` are treated as required; every other
   field is printed only when the server actually sent it, so a future envelope (for example
   document-level packs) cannot blank the panel.
*/

const RAG_GENERATION = {
  client_required: '生成方式：client_required —— memora 只提供材料，答案由调用方模型根据证据包自己写。'
};

function ragStatus(text) {
  const box = $('rag-status');
  if (!box) return;
  box.textContent = text;
}

/** Clear the preview so a stale pack is never read as the current project's. */
function resetRag() {
  const target = $('rag-content');
  if (target) target.replaceChildren();
  ragStatus('尚未请求');
}

/** Render one rag envelope. Only context + references are required; the rest is optional. */
function renderRag(pack, mode) {
  const target = $('rag-content');
  if (!target) return;
  if (!pack || typeof pack !== 'object') {
    empty(target, '证据包响应不是一个对象，无法显示。');
    return;
  }
  const refs = Array.isArray(pack.references) ? pack.references : null;
  if (refs === null) {
    // Only references is load-bearing; context may legitimately be missing in a future shape.
    empty(target, '证据包没有引用列表，无法确认返回了什么。');
    return;
  }
  if (!refs.length) {
    // An empty pack is a real answer, not a failure: say so explicitly instead of a blank box.
    empty(target, '没有匹配的证据：本次检索没有返回任何已审核的记忆。' +
      (pack.retrieval_warning ? '（注意：' + pack.retrieval_warning + '）' : ''));
    return;
  }

  const card = node('article', undefined, 'card');
  const head = node('div', undefined, 'row');
  head.append(node('span', '实际检索：' + shown(pack.retrieval_mode || '未标注'), 'tag'));
  head.append(node('small', refs.length + ' 条证据'));
  card.append(head);

  // The retrieval warning is the whole point of showing the real mode: when the vector stage
  // did not run, say it in plain language and never hide it behind a neutral label.
  if (pack.retrieval_warning) {
    card.append(node('p', '⚠ 检索退化：' + shown(pack.retrieval_warning), 'muted'));
  }

  const budget = pack.budget && typeof pack.budget === 'object' ? pack.budget : null;
  if (budget) {
    card.append(node('p', lines(
      '预算单位 ' + shown(budget.unit),
      '上限 ' + shown(budget.limit),
      '已用 ' + shown(budget.used)
    ), 'meta'));
  }
  if (pack.nonce) card.append(node('p', 'nonce ' + shown(pack.nonce), 'meta'));

  // The raw context, wrappers and all: this is what the calling model literally receives.
  if (typeof pack.context === 'string') {
    const raw = node('pre', pack.context);
    card.append(raw);
  } else {
    card.append(node('p', '（服务端没有返回 context 字段。）', 'muted'));
  }

  if (pack.generation) {
    card.append(node('p', RAG_GENERATION[pack.generation]
      || ('生成方式：' + shown(pack.generation)), 'muted'));
  }
  if (pack.instruction) card.append(node('p', '给调用方的指令：' + shown(pack.instruction), 'meta'));

  const omitted = Array.isArray(pack.omitted) ? pack.omitted : [];
  const truncated = Array.isArray(pack.truncated) ? pack.truncated : [];
  if (omitted.length || truncated.length) {
    card.append(node('p', lines(
      omitted.length ? '因预算未纳入 ' + omitted.length + ' 条' : '',
      truncated.length ? '截断 ' + truncated.length + ' 条' : ''
    ), 'meta'));
  }
  const warnings = Array.isArray(pack.warnings) ? pack.warnings : [];
  for (const w of warnings) {
    if (w && typeof w === 'object' && w.warning) {
      card.append(node('p', '内容风险 ' + shown(w.id) + '：' + shown(w.warning), 'muted'));
    }
  }

  const refList = node('div', undefined, 'row');
  for (const id of refs) refList.append(node('span', shown(id), 'tag'));
  card.append(node('h3', '引用列表'));
  card.append(refList);

  target.replaceChildren(card);
  return card;
}

async function ragPreview() {
  const text = $('query').value.trim();
  if (!text) { ragStatus('请先在检索框输入一个问题。'); return null; }
  const mode = $('search-mode').value;
  ragStatus('正在请求证据包…');
  try {
    const pack = await query('rag', {query: text, mode});
    renderRag(pack, mode);
    ragStatus('已显示本次证据包（真实检索方式与原文见下）。');
    return pack;
  } catch (err) {
    // A 404 or any other failure is reported, never papered over with an empty box.
    empty($('rag-content'), '证据包预览失败：' + (err && err.message ? err.message : String(err)) +
      '。服务端可能没有部署 /rag 路由。');
    ragStatus('请求失败。');
    return null;
  }
}

$('rag-button').onclick = () => run(ragPreview);

/* ------------------------------------------------------------------ 最近发生的对话

   GET /api/agent/sessions -> memora/sessions.py:176 list_sessions(): id, agent, external_id,
   title, started, ended, created, meta and a turns count, newest first.

   What this page can and cannot reach, read off the server rather than guessed:

     list          GET /api/agent/sessions            memora/workbench.py:182
     per-session   NO HTTP ROUTE. memora/agent.py:350-354 exposes /archives and /archive, but
                   those belong to the ADVANCED deployment's Agent handler; the workbench adapter
                   (Workbench.get, memora/workbench.py:172-223) has no such path, and the live
                   server answers 'unknown memory endpoint' for every candidate shape (archive,
                   session, conversation, turns, archives, session-search). sessions.show()
                   (memora/sessions.py:167) exists but nothing HTTP exposes it. The browser
                   therefore cannot read a session's turns, and this file does not pretend to.
     session search NO HTTP ROUTE either: sessions.search (memora/sessions.py:183) is reachable
                   only through the MCP tool memory_session_search (memora/server.py:142).
     transcript    The turns ARE readable indirectly, and only because memory_absorb mirrors the
                   conversation into a shared document (memora/accumulation.py:68-73). That body
                   is reachable through the EXISTING GET /api/agent/document
                   (memora/workbench.py:217) with the slug + audience from GET /api/agent/documents
                   (memora/workbench.py:206), matched by origin_uri 'agent-session:<external_id>'.
                   So expanding a session is answered from the archive itself, never invented.

   Caching. Opening the panel used to refetch on every enterRetrieve(), i.e. on every return to
   the retrieve view plus every 12s/60s reconcile tick. The list is now kept for SESSION_CACHE_MS
   and reused while it is fresh, so returning to the page paints the cached rows immediately and
   only says when they were read. The refresh button and any live frame that reports the archive
   changed force a real read; a project switch clears the cache and never refetches.
*/

const SESSION_SHOWN = 8;          // the page shows the 8 most recent; the endpoint returns up to 100
const SESSION_CACHE_MS = 60000;   // how long a session list stays fresh without a forced read
const SESSION_NOTE = 'GET /api/agent/sessions 只返回会话列表（标题、智能体、轮数、起止时间）。'
  + '工作台没有返回单条会话各轮内容的 HTTP 路由：memora/sessions.py:167 的 sessions.show() '
  + '只通过 MCP 可达，浏览器页面调不到。展开时读的是 memory_absorb 归档时写入的那份共享文档，'
  + '它是同一批轮次的原文（GET /api/agent/document），不是另编的内容。';

/** Cache key: the archive is per project, so a project switch must never serve the old rows. */
function sessionKey() { return project(); }

/** Read the list once per SESSION_CACHE_MS unless the caller forces it. Reports its own state. */
async function sessionList(force) {
  const key = sessionKey();
  const cache = state.sessionsCache;
  if (!force && cache && cache.project === key
      && (Date.now() - cache.at) < SESSION_CACHE_MS && Array.isArray(cache.items)) {
    return {items: cache.items, cached: true, at: cache.at};
  }
  const out = await query('sessions');
  const items = Array.isArray(out.items) ? out.items : [];
  state.sessions = items;
  state.sessionsCache = {project: key, at: Date.now(), items};
  return {items, cached: false, at: state.sessionsCache.at};
}

/** When the rows on screen were read, said out loud so a cached list cannot look like a live one. */
function sessionAge(at) {
  const age = ago(new Date(at).toISOString());
  return '列表读取于 ' + (age || '刚刚');
}

function sessionCard(s) {
  const card = node('article', undefined, 'card');
  card.append(node('h3', s.title || '未命名会话'));
  const head = node('div', undefined, 'row');
  if (s.agent) head.append(node('span', shown(s.agent), 'tag'));
  if (typeof s.turns === 'number') head.append(node('small', s.turns + ' 轮对话'));
  head.append(node('small', s.ended ? '已结束 ' + stamp(s.ended)
    : (s.started ? '进行中' : '未记录结束时间')));
  card.append(head);
  card.append(node('p', lines(
    '开始 ' + (stamp(s.started) || stamp(s.created) || '未记录'),
    s.ended ? '结束 ' + stamp(s.ended) : '',
    '归档于 ' + (ago(s.created) || '未知')
  ), 'meta'));
  card.append(node('p', '会话 ' + shown(s.id), 'meta'));
  // The toggle is a real <button> so it is reachable by keyboard; the transcript target is a
  // sibling, so opening a conversation re-renders nothing that is already on screen.
  const toggle = node('button', '展开对话原文');
  toggle.type = 'button';
  const body = node('div', undefined, 'session-body');
  body.hidden = true;
  toggle.onclick = () => run(() => toggleSession(s, toggle, body), toggle);
  card.append(toggle);
  card.append(body);
  return card;
}

/**
 * Open or close one session's transcript.
 *
 * Two hops, both existing routes, both GET: find the mirrored document for this session
 * (GET /api/agent/documents, matched on origin_uri 'agent-session:<external_id>'), then read it
 * (GET /api/agent/document). The body is the archive's own Markdown: a '# title' line, then one
 * '## <seq> · <role> · <created>' heading per turn followed by its text. It is parsed back into
 * turns so the panel can show role, order and time per turn instead of one wall of Markdown.
 *
 * A session with no mirror is stated as such; a failed read is stated as a failure. Neither is
 * ever rendered as an empty conversation.
 */
async function toggleSession(s, toggle, body) {
  if (!body.hidden) {
    body.hidden = true;
    toggle.textContent = '展开对话原文';
    return null;
  }
  toggle.disabled = true;
  toggle.textContent = '正在读取…';
  try {
    const source = await sessionTranscript(s);
    renderSessionTurns(body, source, s);
    body.hidden = false;
    toggle.textContent = '收起对话原文';
    return source;
  } catch (err) {
    const card = node('article', undefined, 'card');
    card.append(node('h3', '对话原文读取失败'));
    card.append(node('p', '读取失败：' + failureText(err) + '。下面没有任何轮次，因为这次没有读到，'
      + '不代表这个会话是空的。', 'error'));
    card.append(node('p', SESSION_NOTE, 'meta'));
    body.replaceChildren(card);
    body.hidden = false;
    toggle.textContent = '收起对话原文';
    return null;
  } finally {
    toggle.disabled = false;
  }
}

/** The mirrored archive body for one session, found by origin_uri. Throws when absent. */
async function sessionTranscript(s) {
  const external = s.external_id || '';
  const listing = await query('documents');
  const items = Array.isArray(listing.items) ? listing.items : [];
  const mirror = external
    ? items.find(d => d && d.origin_uri === 'agent-session:' + external)
    : null;
  if (!mirror) {
    throw new Error('这个会话没有归档镜像文档：记忆吸收把对话写成共享文档之后才读得到原文。'
      + (external ? '（按 origin_uri = agent-session:' + external + ' 查找，没有找到）'
                  : '（这个会话没有 external_id，无法定位镜像）'));
  }
  const doc = await query('document', {slug: mirror.slug, audience: mirror.audience});
  return {markdown: String(doc.content || ''), slug: mirror.slug,
          audience: mirror.audience, version: doc.version, title: doc.title};
}

/**
 * Parse the archive's own Markdown back into turns. The writer is memora/accumulation.py:68,
 * so the shape is fixed: '# title', then per turn '## <seq> · <role> · <created>' followed by
 * a blank line and the turn text. Text that is not a heading stays with the previous turn, and
 * text before the first heading is treated as the title, so nothing is silently dropped.
 */
function parseTurns(markdown) {
  const turns = [];
  let title = '';
  let current = null;
  for (const line of String(markdown || '').split('\n')) {
    if (/^#\s+/.test(line) && !current) { title = line.replace(/^#\s+/, '').trim(); continue; }
    const heading = /^##\s+(\d+)\s*·\s*([^·]+?)\s*·\s*(.*)$/.exec(line);
    if (heading) {
      current = {seq: Number(heading[1]), role: heading[2].trim(), created: heading[3].trim(), lines: []};
      turns.push(current);
      continue;
    }
    if (current) current.lines.push(line);
  }
  return {title, turns: turns.map(t => ({seq: t.seq, role: t.role, created: t.created,
                                         content: t.lines.join('\n').trim()}))};
}

const ROLE_LABEL = {user: '提问', assistant: '回答', system: '系统', tool: '工具'};

function renderSessionTurns(target, source, session) {
  const parsed = parseTurns(source.markdown);
  const card = node('article', undefined, 'card');
  const head = node('div', undefined, 'row');
  head.append(node('span', parsed.turns.length + ' 轮 · 原文', 'tag'));
  if (source.slug) head.append(node('span', '镜像文档 ' + shown(source.slug), 'tag'));
  card.append(node('h3', parsed.title || session.title || '对话原文'));
  card.append(head);

  if (!parsed.turns.length) {
    card.append(node('p', '镜像文档里没有解析出轮次：归档文档的格式和这里预期的'
      + '「## 序号 · 角色 · 时间」不一致，所以不显示任何"原文"。', 'error'));
    card.append(node('p', SESSION_NOTE, 'meta'));
    target.replaceChildren(card);
    return card;
  }

  const list = node('ol', undefined, 'session-turns');
  for (const turn of parsed.turns) {
    const item = node('li', undefined, 'session-turn');
    const meta = node('div', undefined, 'row');
    meta.append(node('span', ROLE_LABEL[turn.role] || shown(turn.role), 'tag'));
    meta.append(node('small', lines('#' + turn.seq,
      stamp(turn.created) || shown(turn.created))));
    item.append(meta);
    item.append(node('p', turn.content || '（这一轮没有正文）', 'content'));
    list.append(item);
  }
  card.append(list);
  card.append(node('p', lines(
    '来源 GET /api/agent/document · 镜像文档 ' + shown(source.slug) + ' v' + shown(source.version),
    '项目 ' + shown(project())
  ), 'meta'));
  card.append(node('p', '这里没有单条会话的 HTTP 路由，所以原文来自 memory_absorb 归档时写下的共享文档；'
    + '会话列表本身来自 GET /api/agent/sessions。', 'muted'));
  target.replaceChildren(card);
  return card;
}

/**
 * Search a session's turns in this browser.
 *
 * There is no session-search HTTP route (see the block comment above): sessions.search() is
 * MCP-only, reachable as memory_session_search. What can still be answered honestly is a search
 * over the transcripts this page is already allowed to read, so that is what this does -- and it
 * says so, and how many sessions it actually covered, instead of implying a server-side index ran.
 * Only the sessions the panel has loaded are searched.
 */
async function sessionSearch(term) {
  // Keep the term as typed for everything the owner reads; only the comparison is case-folded,
  // so a zero-hit message can never quote back a term the owner did not type.
  const asked = String(term || '').trim();
  const needle = asked.toLowerCase();
  const target = $('sessions');
  const label = $('session-search-info');
  if (!needle) {
    if (label) label.textContent = '请输入要搜索的关键词。';
    return null;
  }
  const known = (state.sessionsCache && Array.isArray(state.sessionsCache.items))
    ? state.sessionsCache.items.slice(0, SESSION_SHOWN) : [];
  if (!known.length) {
    if (label) label.textContent = '还没有会话可搜索：先让智能体把对话归档，或者点上面的「刷新」。';
    return null;
  }
  if (label) label.textContent = '正在读取 ' + known.length + ' 个会话的原文…';
  const hits = [];
  const problems = [];
  for (const one of known) {
    try {
      const parsed = parseTurns((await sessionTranscript(one)).markdown);
      for (const turn of parsed.turns) {
        const at = turn.content.toLowerCase().indexOf(needle);
        if (at < 0) continue;
        const from = Math.max(0, at - 40);
        hits.push({session: one, turn,
                   excerpt: (from ? '…' : '') + turn.content.slice(from, at + needle.length + 60) + '…'});
      }
    } catch (err) {
      problems.push((one.title || one.external_id || one.id) + '：' + (err.message || String(err)));
    }
  }
  if (label) {
    label.textContent = lines(
      '在 ' + known.length + ' 个会话的原文里搜到 ' + hits.length + ' 处匹配',
      problems.length ? problems.length + ' 个会话读不到原文' : '',
      '浏览器内搜索，不是服务端索引：工作台没有会话检索的 HTTP 路由'
    );
  }
  if (!hits.length) {
    const card = node('article', undefined, 'card');
    card.append(node('h3', '没有匹配的轮次'));
    card.append(node('p', holes(known.length, problems.length, asked), 'warn'));
    card.append(node('p', SESSION_NOTE, 'meta'));
    if (problems.length) {
      const list = node('div', undefined, 'row');
      for (const p of problems) list.append(node('span', p, 'tag'));
      card.append(list);
    }
    target.replaceChildren(card);
    return [];
  }
  const cards = hits.slice(0, 30).map(hit => {
    const card = node('article', undefined, 'card');
    card.append(node('h3', hit.session.title || '未命名会话'));
    const head = node('div', undefined, 'row');
    head.append(node('span', ROLE_LABEL[hit.turn.role] || shown(hit.turn.role), 'tag'));
    head.append(node('small', lines('#' + hit.turn.seq, stamp(hit.turn.created) || '')));
    if (hit.session.agent) head.append(node('small', '智能体 ' + shown(hit.session.agent)));
    card.append(head);
    card.append(node('p', hit.excerpt, 'content'));
    card.append(node('p', '会话 ' + shown(hit.session.id), 'meta'));
    return card;
  });
  if (problems.length) {
    const card = node('article', undefined, 'card');
    card.append(node('h3', '部分会话读不到原文'));
    card.append(node('p', '下面这些会话没有读到原文，所以它们的轮次没有参与这次搜索：', 'warn'));
    const list = node('div', undefined, 'row');
    for (const p of problems) list.append(node('span', p, 'tag'));
    card.append(list);
    cards.push(card);
  }
  target.replaceChildren(...cards);
  return hits;
}

/** What a zero-hit search did and did not cover, in words rather than a bare "0". */
function holes(searched, failed, needle) {
  return '在 ' + searched + ' 个会话的原文里没有找到「' + needle + '」。'
    + (failed ? '其中 ' + failed + ' 个会话没有读到原文，没有被搜索。' : '')
    + '这不代表整个档案里没有这个词：只搜索了面板上列出的这 ' + searched + ' 个会话。';
}

/** A list from another project must never sit under the new one: clear it, do not refetch. */
function resetSessionCache() {
  state.sessions = null;
  state.sessionsCache = null;
}

const SESSION_SEARCH_HINT = '会话列表来自 GET /api/agent/sessions（归档的会话与轮数）。'
  + '这里只读已归档的会话，不涉及已审核记忆。';

/**
 * Put the search line back to what it says before any search. Refreshing the list while a search
 * summary is still on screen would leave a line describing a result set that is no longer shown.
 */
function resetSessionSearch() {
  const input = $('session-search');
  if (input) input.value = '';
  const info = $('session-search-info');
  if (info) info.textContent = SESSION_SEARCH_HINT;
}

/** Read the newest list. Called by any live frame that reports the archive changed. */
async function loadSessions(force) {
  const read = await sessionList(force);
  const items = read.items;
  const recent = items.slice(0, SESSION_SHOWN);
  const seen = read.cached ? '（' + sessionAge(read.at) + '）' : '';
  $('sessions-info').textContent = items.length
    ? ('最近 ' + recent.length + ' 个 / 共 ' + items.length + ' 个会话' + seen)
    : '会话档案';
  if (!recent.length) {
    empty($('sessions'), '还没有会话记录。智能体通过 MCP 的 memory_absorb 把对话归档之后，'
      + '这里会显示每个会话的标题、智能体、轮数和起止时间；在此之前这个面板只能是空的，'
      + '因为数据库里确实没有会话。');
    return items;
  }
  $('sessions').replaceChildren(...recent.map(sessionCard));
  return items;
}

/** The refresh button is a deliberate read: it must not be answered from the cache. */
$('refresh-sessions').onclick = () => run(async () => {
  const items = await loadSessions(true);
  resetSessionSearch();     // the list is back, so the old search summary no longer describes it
  return items;
});
$('session-search-form').onsubmit = e => {
  e.preventDefault();
  return run(() => sessionSearch($('session-search').value), e.submitter);
};

/* ------------------------------------------------------------------ 记忆处理状态

   Two already-implemented endpoints, because "how are conversations becoming memory" has two
   halves:
     GET  /api/agent/queue -> memora/core.py:227  memories waiting for review
     GET  /api/agent/jobs  -> memora/jobs.py:62   durable accumulation jobs with the status and
                              error a retry can address; POST /api/agent/job-retry
                              (memora/workbench.py:53) re-queues one.
*/

const JOB_LABEL = {queued: '排队中', running: '处理中', retry: '等待重试', failed: '失败', done: '已完成'};

function jobCard(job) {
  const card = node('article', undefined, 'card');
  const head = node('div', undefined, 'row');
  head.append(node('span', JOB_LABEL[job.status] || shown(job.status), 'tag'));
  head.append(node('small', lines(
    shown(job.kind) + ' 任务',
    '第 ' + shown(job.attempts) + ' 次尝试',
    ago(job.updated) ? ago(job.updated) + '更新' : ''
  )));
  card.append(head);
  const input = (job.input && typeof job.input === 'object') ? job.input : {};
  card.append(node('p', input.title || input.external_id || shown(job.event_key) || '未命名任务', 'content'));
  card.append(node('p', lines(
    input.agent ? '来源 ' + shown(input.agent) : '',
    job.error ? '失败原因 ' + shown(job.error) : '',
    '任务 ' + shown(job.id)
  ), 'meta'));
  if (job.status !== 'done') {
    const actions = node('footer');
    actions.append(button('重试该任务', async () => {
      await api('job-retry', {id: job.id});
      await loadProcessing();
      notice('已重新排队：' + (input.title || job.id));
    }));
    card.append(actions);
  }
  return card;
}

function processingSummary(queueOut, jobs, counts, queueError, jobsError) {
  const card = node('article', undefined, 'card');
  const pending = queueOut && Array.isArray(queueOut.items) ? queueOut.items.length : null;
  const more = queueOut ? !!queueOut.next_cursor : false;
  const head = node('div', undefined, 'row');
  head.append(node('span', '处理概览', 'tag'));
  head.append(node('small', '来自待审队列与会话积累任务'));
  card.append(head);

  const waiting = (counts.queued || 0) + (counts.running || 0) + (counts.retry || 0);
  const stuck = (counts.retry || 0) + (counts.failed || 0);
  card.append(node('p', lines(
    pending === null ? '待审记忆：读取失败' : '待审记忆 ' + pending + ' 条' + (more ? '（还有更多未显示）' : ''),
    '积累任务 ' + jobs.length + ' 个'
  ), 'meta'));
  card.append(node('p', lines(
    counts.queued ? '排队 ' + counts.queued : '',
    counts.running ? '处理中 ' + counts.running : '',
    counts.retry ? '等待重试 ' + counts.retry : '',
    counts.failed ? '失败 ' + counts.failed : '',
    counts.done ? '已完成 ' + counts.done : '',
    !jobs.length ? '暂无积累任务' : ''
  ), 'meta'));

  // The verdict is stated even when it is "nothing is wrong".
  let verdict = '';
  if (jobsError) verdict = '积累任务读取失败：' + jobsError.message;
  else if (queueError) verdict = '待审队列读取失败：' + queueError.message;
  else if (stuck) verdict = stuck + ' 个任务尚未完成，重试可以让它们继续；失败原因列在下方。';
  else if (waiting) verdict = waiting + ' 个任务正在处理，完成后会自动进入记忆。';
  else if (jobs.length) verdict = '积累任务全部完成，没有需要重试的失败。';
  else verdict = '暂无待处理的对话积累任务。智能体归档对话之后，任务会出现在这里。';
  card.append(node('p', verdict, 'muted'));
  return card;
}

async function loadProcessing() {
  const [queueResult, jobsResult] = await Promise.allSettled([
    query('queue', {status: 'pending'}),
    query('jobs')
  ]);
  const queueOut = queueResult.status === 'fulfilled' ? queueResult.value : null;
  const jobsOut = jobsResult.status === 'fulfilled' ? jobsResult.value : null;
  const jobs = jobsOut && Array.isArray(jobsOut.items) ? jobsOut.items : [];
  const counts = {};
  for (const job of jobs) counts[job.status] = (counts[job.status] || 0) + 1;
  state.jobs = jobs;

  const cards = [processingSummary(
    queueOut, jobs, counts,
    queueResult.status === 'rejected' ? queueResult.reason : null,
    jobsResult.status === 'rejected' ? jobsResult.reason : null
  )];
  // What needs attention first: unfinished and failed jobs, newest update on top.
  const unfinished = jobs.filter(j => j.status !== 'done')
    .sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
  for (const job of unfinished.slice(0, 6)) cards.push(jobCard(job));
  $('processing').replaceChildren(...cards);
  $('processing-info').textContent = jobsOut
    ? '待审队列与积累任务 · 更新于 ' + stamp(new Date().toISOString())
    : '对话如何变成记忆';
  return jobs;
}
$('refresh-processing').onclick = () => run(loadProcessing);

/* ------------------------------------------------------------------ live updates

   SSE contract, read off the server rather than guessed:

     memora/web.py:68-110   GET /api/agent/events?project=<p>[&id=<job id>]
       200 with Content-Type: text/event-stream; charset=utf-8, Cache-Control: no-store.
       Frames are "data: <json>" pairs. No event id is sent, so there is no Last-Event-ID
       resume. The handler writes a frame only when the JSON differs from the previous one, and
       it leaves the loop as soon as snap['status'] !== 'running' (web.py:106) - one final frame,
       then the connection closes. That close makes EventSource fire onerror, so a one-shot probe
       can never be evidence that a stream still works; only an open connection can.

     The id is OPTIONAL, and which frames arrive depends on it:
       * no id  -> Workbench.snapshot(None, project) (workbench.py:56). A frame carries the state
         this page already renders: status, queue.pending, jobs.{listed,by_status,waiting,stuck},
         peers.{total,connected,items}, sessions.{listed,turns}, and status 'running' only while
         accumulation work is outstanding (workbench.py:85) - so the connection is held exactly
         as long as there is something to watch, then one terminal frame and close.
       * id     -> agent.snapshot(job_id): a generation job (POST /api/agent/generate). This page
         never starts one, but a caller that holds an id must keep working, so that path is
         unchanged and stays job-scoped.

   Authentication: none is needed, and EventSource cannot set headers anyway. do_GET validates
   only the Host header (web.py:48-50); the X-MM-Token / Origin / Content-Type check lives in
   do_POST (web.py:127-130). memora/static/agent.js:27 opens this very URL with no credentials.

   So subscribeLive() now opens the id-less stream by default. It previously demanded an id this
   page can never have, returned false immediately and left the capability unused. A frame is a
   diff source, not content: it carries counts and aggregates, so it is never dumped as JSON.
   Instead each section that changed names the renderer its block already uses (loadProcessing /
   loadSessions / peers) and only that block is refetched. The 12s reconciliation pass is kept as
   the cross-process backstop and drops to RECONCILE_LIVE_MS while a stream is proven live, since a
   stream only reports what the server itself observed.
*/

const RECONCILE_MS = 12000;           // no stream: the only safety net, so it stays at 12s
const RECONCILE_LIVE_MS = 60000;      // stream open: a slow backstop, not a second poller
const LIVE_RETRY_MS = 4000;           // after an idle close, re-open the workbench stream
const LIVE_SILENT_MS = 45000;         // no frame for this long while status is running = not live
const LIVE_TEXT = {
  idle: '实时更新：等待页面可见',
  connecting: '实时更新：正在连接事件流',
  streaming: '实时更新：事件流已连接',
  fallback: '实时更新：事件流不可用 · 已改用可见性同步'
};

function paintLive(status, detail) {
  state.live.status = status;
  if (detail !== undefined) state.live.detail = detail;
  const pill = $('live-state');
  if (!pill) return;
  const base = LIVE_TEXT[status] || ('实时更新：' + status);
  pill.textContent = base + (status === 'fallback' && detail ? '（' + detail + '）' : '');
  pill.title = detail || '';
}

/**
 * Which already-rendered blocks a frame touches. Sections are compared one by one against the
 * previous frame, so an unchanged section costs nothing, and each result names the renderer its
 * block already uses instead of rendering the frame itself: a frame holds counts, and printing
 * counts where the cards belong would be exactly the raw JSON dump this must not do.
 */
function changedBlocks(snap, before) {
  const same = key => JSON.stringify(snap[key]) === JSON.stringify(before[key]);
  const changed = [];
  // loadProcessing() renders BOTH the pending queue count and the accumulation job cards, so a
  // change in either is one call rather than two competing writes into #processing.
  if (!before || !same('queue') || !same('jobs')) changed.push('processing');
  if (!before || !same('sessions')) changed.push('sessions');
  // peers() writes #connection and #peers. #connection is in the header, which every view
  // shares, and #peers is rendered whether or not the agents view is on screen.
  if (!before || !same('peers')) changed.push('peers');
  return changed;
}

/** The existing renderer for each block, so no rendering logic is duplicated here. */
const LIVE_BLOCK_LOADER = {processing: loadProcessing, peers,
  // A frame that carries a changed sessions section is the server saying the archive itself moved,
  // so that path forces a real read; the cached list is only reused by the passive enterRetrieve()
  // path and by the reconcile backstop, which must not turn a cache into a second poller.
  sessions: () => loadSessions(true)};

/**
 * Apply one frame's worth of blocks. A burst can still overlap a fetch in flight, so blocks are
 * coalesced into one animation frame and de-duplicated: at most one refetch per block per burst,
 * never a pile of racing requests.
 */
function applyBlocks(blocks) {
  for (const block of blocks) state.live.dirty.add(block);
  if (state.live.flush || !blocks.length) return;
  // The generation stamps the project these blocks were collected for; a project switch bumps it,
  // so a flush scheduled before the switch is dropped instead of refetching the new project early.
  const generation = state.live.project;
  state.live.flush = requestAnimationFrame(() => {
    state.live.flush = 0;
    if (state.live.project !== generation) { state.live.dirty.clear(); return; }
    const pending = Array.from(state.live.dirty);
    state.live.dirty.clear();
    for (const block of pending) {
      // Each renderer reports its own failure into its own block; a dead stream must not throw here.
      Promise.resolve(LIVE_BLOCK_LOADER[block]()).catch(() => {});
    }
  });
}

/** Pill detail: which project, which stream, what it last reported, and when. */
function liveDetail(snap) {
  const scope = state.live.job === null ? '工作台（无任务 id）' : '任务 ' + state.live.job;
  const frame = snap || {};
  return lines(
    '项目 ' + shown(frame.project || state.live.project),
    scope,
    frame.status ? '状态 ' + shown(frame.status) : '',
    typeof (frame.queue || {}).pending === 'number' ? '待审 ' + frame.queue.pending : '',
    typeof (frame.jobs || {}).waiting === 'number' ? '处理中 ' + frame.jobs.waiting : '',
    state.live.lastAt ? '最近一帧 ' + stamp(state.live.lastAt) : ''
  );
}

/**
 * Open the documented stream. A truthy jobId is job-scoped, exactly as before; omitted means the
 * workbench-wide stream, which is the only stream this page has an id for. False is returned only
 * when the browser has no EventSource, so a caller can tell "no capability" from "connecting".
 */
function subscribeLive(jobId) {
  if (typeof EventSource === 'undefined') return false;
  const id = jobId || null;                     // null = send no id parameter at all
  if (state.live.stream && state.live.job === id) return true;
  state.live.proven = false;
  closeLive();
  const url = new URL('/api/agent/events', location.origin);
  url.searchParams.set('project', project());   // the current project, never a remembered one
  if (id) url.searchParams.set('id', id);
  paintLive('connecting', 'GET ' + url.pathname + url.search);
  let stream;
  try { stream = new EventSource(url.href); }
  catch { paintLive('fallback', '无法创建 EventSource'); return false; }
  state.live.stream = stream;
  state.live.job = id;
  state.live.project = project();
  state.live.applied = null;                    // the first frame is entirely new
  stream.onopen = () => {
    state.live.proven = true;             // an open connection is the only proof of a live stream
    paintLive('streaming', lines('事件流已连接', liveDetail(state.live.last)));
    syncReconcile();                      // proven live: the backstop steps back, it does not quit
    armWatchdog();
  };
  stream.onmessage = event => {
    // A frame may only act while its own connection is still the current one. closeLive() nulls
    // the handlers, but a frame already queued for dispatch still runs, and after a project
    // change it would refresh the new project from the old project's diff.
    if (state.live.stream !== stream) return;
    let snap = null;
    try { snap = JSON.parse(event.data); } catch { return; }
    state.live.last = snap;
    state.live.lastAt = new Date().toISOString();
    armWatchdog();                              // a frame is proof the stream is alive
    if (snap && snap.status === 'error') {
      // web.py:99-101: a failing snapshot is reported as a final frame instead of a dead stream.
      closeLive();
      paintLive('fallback', lines('服务端报告快照失败',
        snap.error ? snap.error.message : '未知原因', '已改用定时同步'));
      return;
    }
    const blocks = changedBlocks(snap, state.live.applied);
    state.live.applied = snap;
    paintLive('streaming', liveDetail(snap));
    applyBlocks(blocks);
    // A finished generation may have written memories, so re-run the visible search once. The
    // stream itself is left to the server's close (web.py:106), which onerror reports honestly.
    if (id && snap.status !== 'running') refreshRetrieve({search: true});
  };
  stream.onerror = () => {
    // A rejected or missing stream leaves readyState CLOSED and never retries; a dropped
    // connection leaves it CONNECTING and the browser reconnects on its own.
    if (stream.readyState === EventSource.CLOSED) {
      closeLive();
      paintLive('fallback', id ? '事件流已被服务端关闭' : '事件流已结束，正在重连');
      // The workbench closes its own stream after a terminal frame (workbench.py:85), so a close is
      // the normal end of a cycle, not a failure: re-open instead of falling back to polling.
      if (!id && state.live.want === null) {
        clearTimeout(state.live.retry);
        state.live.retry = setTimeout(() => {
          if (state.live.want === null && state.live.stream === null) subscribeLive(null);
        }, LIVE_RETRY_MS);
      }
    } else {
      paintLive('connecting', '事件流中断，浏览器正在重连');
    }
  };
  return true;
}

/**
 * A stream that is open must receive frames within the server's own change cadence, so silence
 * past LIVE_SILENT_MS while the pill claims live is a claim this page cannot back up. The watchdog
 * closes the connection and restores the 12s backstop rather than only repainting the pill, so the
 * fallback it announces is the fallback it actually runs on.
 */
function armWatchdog() {
  clearTimeout(state.live.watchdog);
  state.live.watchdog = setTimeout(() => {
    state.live.watchdog = 0;
    if (!state.live.stream) return;
    closeLive();                                                 // back to the 12s backstop
    paintLive('fallback', '事件流长时间没有新帧，已改用定时同步');
    refreshRetrieve();                                           // and catch up now, not at the tick
  }, LIVE_SILENT_MS);
}

/** Close the connection and forget the project it belonged to. Never touches `want`. */
function closeLive() {
  clearTimeout(state.live.watchdog);
  clearTimeout(state.live.retry);
  state.live.watchdog = 0;
  state.live.retry = 0;
  const open = state.live.stream;
  if (open) {
    open.onopen = open.onmessage = open.onerror = null;
    open.close();
  }
  // Everything that describes the connection is cleared before the backstop is re-armed, because
  // startReconcile() reads `proven`. Clearing it afterwards would let a close re-arm the 60s
  // cadence, which is the exact state this function exists to end.
  state.live.stream = null;
  state.live.job = null;
  state.live.project = '';
  state.live.applied = null;
  state.live.proven = false;             // nothing is open, so nothing has proved itself live
  if (open || state.live.timer) startReconcile();      // 12s again: the only net is left
}
/**
 * Declare what this page wants from the stream and act on it: null for the workbench-wide stream,
 * an id for a job, false for none. Taking the value as a single argument is what lets the
 * project-change and view-change callers pass false and be unable to resubscribe a stale project
 * by forgetting to pass the new one.
 */
function wantLive(jobId) {
  state.live.want = jobId || null;
  state.live.failures = 0;
  if (jobId === false) { closeLive(); paintLive('idle', '等待页面可见'); return false; }
  // Off-page or hidden, nothing is subscribed: visibilitychange re-opens it on the way back.
  if (state.view !== 'retrieve' || document.hidden) return false;
  return subscribeLive(jobId || null);
}

/**
 * The single refresh path for the first page: sessions, processing state, and optionally the
 * visible search. `search` is opt-in because recall records access (core.py:261), so silently
 * re-running it would inflate the very access_count the cards display.
 */
async function refreshRetrieve(options) {
  if (state.refreshing) return null;
  state.refreshing = true;
  try {
    if (options && options.search && state.search) await search();
    await Promise.allSettled([loadSessions(), loadProcessing()]);
  } catch (e) {
    notice(e.message);
  } finally {
    state.refreshing = false;
  }
  return null;
}

/** One reconciliation tick, shared by both cadences so the two cannot drift apart. */
function reconcileTick() {
  if (document.hidden || state.view !== 'retrieve') return;     // no work off-page or hidden
  refreshRetrieve();
}

/**
 * The cross-process backstop, never removed. A stream can only report what the server itself
 * observed, so a change made by another process behind an unchanged snapshot would never reach
 * this page without it. What a live stream changes is the cadence: 60s instead of 12s, because the
 * stream already covers the same-process case, plus one immediate catch-up read whenever the
 * connection drops, so falling back is never slower than the behaviour this replaced.
 */
function startReconcile() {
  clearInterval(state.live.timer);
  // No timer at all off-page: the reconcile pass only has work to do while this view is up.
  if (state.view !== 'retrieve') { state.live.timer = 0; return; }
  // The cadence follows `proven`: set only once a connection has actually opened, cleared the
  // moment one closes. Reading `stream` here would be wrong in both directions - closeLive() arms
  // this while the stream it is closing is still attached, and a stream that is merely CONNECTING
  // has proved nothing yet. `proven` is the only honest signal, so the backstop steps back to 60s
  // on a genuinely live stream and returns to 12s the moment there is not one.
  state.live.timer = setInterval(reconcileTick,
    state.live.proven ? RECONCILE_LIVE_MS : RECONCILE_MS);
}
function syncReconcile() {
  startReconcile();
  if (!state.live.stream) refreshRetrieve();                    // a drop must not wait 12s
}

/**
 * Visibility: a hidden tab holds no stream, the same rule the reconcile tick, the backdrop canvas
 * and the peers poller already follow. Returning to the page reconnects first and reads once, so
 * the blocks are current on the first painted frame instead of at the next tick.
 */
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    closeLive();                                                // nothing to watch unseen
    paintLive('idle', '页面不可见，已暂停事件流');
    return;
  }
  if (state.view !== 'retrieve') return;
  if (state.live.want !== false && !subscribeLive(state.live.want)) return;
  refreshRetrieve();
});

async function enterRetrieve() {
  // The scope panel is part of this page, and its counts go stale as soon as a memory is
  // approved elsewhere. Read them on entry (one cheap GET), then repaint.
  try { await scopeRefresh(); } catch (e) { /* a scope read must not block retrieval */ }

  paintLive('idle', '正在进入检索页');
  await refreshRetrieve();
  startReconcile();
  wantLive(null);                        // the workbench stream needs no id: it is the real state
}

/* ------------------------------------------------------------------ 分类与沉淀 */

$('capture-form').onsubmit = e => {
  e.preventDefault();
  run(async () => {
    const out = await api('capture', {
      content: $('capture-content').value,
      source: $('capture-source').value,
      event_id: crypto.randomUUID()
    });
    $('capture-content').value = '';
    await queue();
    await refreshRetrieve();
    notice(out.classification?.mode === 'failed_closed'
      ? '已保存。Judge 判定失败，记忆仍在待审队列，可重试或手工分类。'
      : '已保存，分类结果已记录，等待确认沉淀。');
  }, e.submitter);
};

async function queue(append) {
  const out = await query('queue', {status: $('queue-status').value, cursor: append ? state.cursor : null});
  if (!append) $('queue').replaceChildren();
  state.cursor = out.next_cursor;
  $('queue-more').hidden = !state.cursor;
  for (const m of out.items) {
    const card = memoryCard(m);
    const route = m.classification;
    if (route) {
      card.append(node('p', '分类方式：' + route.mode + ' · 去向：'
        + ((state.config.categories && state.config.categories[route.destination]) || route.destination)
        + (route.proposal?.reason ? ' · ' + route.proposal.reason : ''), 'muted'));
    }
    const actions = node('footer');
    // Every mutation here can change what the first page shows, so each one refreshes it.
    const done = async () => { await queue(); await refreshRetrieve(); };
    if (m.status === 'pending') {
      const select = node('select');
      select.setAttribute('aria-label', '记忆类别');
      for (const [key, title] of Object.entries(state.config.categories)) {
        const option = node('option', title);
        option.value = key;
        option.selected = key === m.category;
        select.append(option);
      }
      actions.append(
        select,
        button('保存分类', async () => { await api('category', {id: m.id, category: select.value}); await done(); }),
        button('重新判定', async () => {
          const result = await api('classify', {id: m.id});
          await done();
          if (result.mode === 'failed_closed') notice('Judge 仍不可用：' + result.error);
        }),
        button('确认沉淀', async () => {
          if (select.value !== m.category) await api('category', {id: m.id, category: select.value});
          const result = await api('review', {id: m.id, action: 'approve'});
          await done();
          notice(result.index.mode === 'pending_retry'
            ? '记忆已沉淀；向量索引失败，可点击补建索引。'
            : result.index.mode === 'disabled'
              ? '记忆已沉淀并导出 Markdown；尚未配置向量模型，目前可关键词检索。'
              : '已沉淀并建立向量索引。');
        }),
        button('拒绝', async () => { await api('review', {id: m.id, action: 'reject'}); await done(); })
      );
    } else if (m.status === 'approved') {
      actions.append(button('归档', async () => { await api('review', {id: m.id, action: 'archive'}); await done(); }));
    } else if (m.status === 'rejected' || m.status === 'archived') {
      actions.append(button('恢复沉淀', async () => {
        await api('review', {id: m.id, action: m.status === 'rejected' ? 'approve' : 'restore'});
        await done();
      }));
    }
    card.append(actions);
    $('queue').append(card);
  }
  if (!$('queue').children.length) empty($('queue'), '当前队列为空。');
}

$('queue-more').onclick = () => run(() => queue(true));
$('refresh-queue').onclick = () => run(() => queue());
$('queue-status').onchange = () => run(() => queue());
$('reindex').onclick = () => run(async () => {
  notice('索引结果：' + JSON.stringify(await api('index', {})));
  await refreshRetrieve();
});


/* ------------------------------------------------------------------ 添加记忆：两种入口

   分类与沉淀 offers two ways in and one pipeline out:

     直接输入记忆内容   one memory per submission, the existing path
     新增 Markdown 文档  a file (dropped or pasted) parsed into many candidates at once

   Both end as PENDING memories in the same review queue. The document route deliberately does not
   use the Markdown *document* store: /document writes a versioned document, /document-index turns a
   published revision into memory rows, and neither is what a user means by "add this note as
   memories". POST /capture-markdown reuses the same ingest parser the importer uses, then calls
   runtime.capture per chunk, so heading context and front-matter titles behave identically to a
   CLI import while every chunk still goes through normal review.

   The drop zone is a <label> wrapping the file input, so clicking it opens the picker without JS.
   dragover/drop are prevented on the whole pane so a miss near the edge does not navigate the
   window to the file.
*/
const MAX_MARKDOWN_BYTES = 2 * 1024 * 1024;

function captureTab(name) {
  const typed = name === 'type';
  $('tab-type').classList.toggle('is-active', typed);
  $('tab-doc').classList.toggle('is-active', !typed);
  $('tab-type').setAttribute('aria-selected', typed ? 'true' : 'false');
  $('tab-doc').setAttribute('aria-selected', typed ? 'false' : 'true');
  $('pane-type').hidden = !typed;
  $('pane-doc').hidden = typed;
}
$('tab-type').onclick = () => captureTab('type');
$('tab-doc').onclick = () => captureTab('doc');

function markdownStatus(text) {
  const host = $('markdown-status');
  if (host) host.textContent = text;
}

/** Read a dropped/selected file into the textarea, and title the drop zone with its name. */
function acceptMarkdownFile(file) {
  if (!file) return;
  if (file.size > MAX_MARKDOWN_BYTES) {
    markdownStatus('文件过大：上限 2 MB');
    notice('Markdown 文件超过 2 MB，请拆分后再试。');
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    $('markdown-content').value = String(reader.result || '');
    $('drop-zone-title').textContent = file.name;
    $('drop-zone-hint').textContent = file.size + ' 字节 · 已载入正文，可以检查后提交';
    markdownStatus('已载入 ' + file.name);
  };
  reader.onerror = () => markdownStatus('读取失败：' + (reader.error && reader.error.message));
  reader.readAsText(file, 'utf-8');
}

const dropZone = $('markdown-drop');
if (dropZone) {
  dropZone.addEventListener('dragover', event => {
    event.preventDefault();
    dropZone.classList.add('is-over');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('is-over'));
  dropZone.addEventListener('drop', event => {
    event.preventDefault();
    dropZone.classList.remove('is-over');
    const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
    acceptMarkdownFile(file);
  });
}
$('markdown-file').onchange = event => acceptMarkdownFile(event.target.files && event.target.files[0]);

/* Dropping onto the whole view is what a user actually does when aiming at "添加记忆"; the zone is
   the visual target, the view is the forgiving one. Only intercepted for files, so dragging text
   inside a textarea still works. */
const inboxView = $('inbox');
if (inboxView) {
  inboxView.addEventListener('dragover', event => {
    if (event.dataTransfer && Array.from(event.dataTransfer.types || []).includes('Files')) {
      event.preventDefault();
    }
  });
  inboxView.addEventListener('drop', event => {
    if (!(event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files.length)) return;
    event.preventDefault();
    captureTab('doc');
    acceptMarkdownFile(event.dataTransfer.files[0]);
  });
}

$('markdown-submit').onclick = () => run(async () => {
  const content = $('markdown-content').value;
  if (!content.trim()) throw new Error('请先拖入或粘贴 Markdown 正文');
  markdownStatus('解析中…');
  const out = await api('capture-markdown', {
    content,
    filename: $('drop-zone-title').textContent || 'pasted.md',
    source: $('markdown-source').value.trim() || 'workbench-markdown'
  });
  const created = out.created || [];
  markdownStatus('解析 ' + out.parsed + ' 段，已加入 ' + created.length + ' 条待审'
    + (out.failed && out.failed.length ? '，' + out.failed.length + ' 段被拒绝' : ''));
  notice('已把《' + (out.title || out.filename) + '》解析成 ' + created.length
    + ' 条候选记忆，进入待审队列；确认后才会参与检索。');
  $('markdown-content').value = '';
  await queue();
}, $('markdown-submit'));

/* ------------------------------------------------------------------ 智能体接入 */

/** Protocols this build actually speaks. Written from the transports the package ships, not from a
    wish list: mcp.py serves stdio, gateway.py serves bearer-protected Streamable HTTP, and the
    lifecycle plugin talks to that HTTP endpoint. Anything not in this table is not supported, and
    the panel says so rather than implying universal compatibility. */
const AGENT_PROTOCOLS = [
  {id: 'mcp-stdio', title: 'MCP · 标准输入输出',
   how: '宿主把 memora 作为子进程启动，通过 stdin/stdout 交换 JSON-RPC。',
   entry: 'python -m memora --data <数据目录> mcp',
   note: '最适合桌面宿主（DSH、Claude Desktop 等）；无需端口，无需密钥。'},
  {id: 'mcp-http', title: 'MCP · Streamable HTTP（loopback）',
   how: '只监听 127.0.0.1，用 Bearer 令牌鉴权；令牌在 data/mcp-token。',
   entry: 'GET {base}/mcp  ·  Authorization: Bearer <token>',
   note: '供无法拉起子进程的宿主；跨机器访问不在支持范围内。'},
  {id: 'http-json', title: '工作台 HTTP · JSON',
   how: '同一套只读/写入路由，页面自己用的就是它；需要同源 X-MM-Token。',
   entry: '/api/agent/<route>?project=<项目>',
   note: '给调试脚本和自建面板；不是稳定对外契约。'},
  {id: 'lifecycle', title: '生命周期适配器（宿主插件）',
   how: '在宿主里跑一小段插件：首步召回、空闲归档、发件箱重投、心跳过期。',
   entry: 'integrations/dsh/memora-plugin.mjs',
   note: '需要宿主支持插件机制；只有 MCP 宿主才能自动沉淀。'}
];

/** Render the protocol table once. It is static per build, so there is no reason to refetch it. */
function agentProtocols() {
  const host = $('agent-protocols');
  if (!host || host.childElementCount) return;
  host.replaceChildren(...AGENT_PROTOCOLS.map(protocol => {
    const card = node('article', undefined, 'card');
    card.append(
      node('h3', protocol.title),
      node('p', protocol.how),
      node('code', protocol.entry, 'protocol-entry'),
      node('small', protocol.note)
    );
    return card;
  }));
}

/** "42 秒前" / "3 分钟前" -- one place that formats an age, so the pill and the cards agree. */
function secondsAgo(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s < 90) return s + ' 秒前';
  if (s < 5400) return Math.round(s / 60) + ' 分钟前';
  if (s < 172800) return Math.round(s / 3600) + ' 小时前';
  return Math.round(s / 86400) + ' 天前';
}

async function peers() {
  // No ?project= is passed on purpose: /peers defaults to every project and reports which one each
  // agent belongs to. Scoping the read to the page's current project was the reason a user with
  // four live heartbeats under `dsh` saw "暂无智能体在线" on the `default` project — the heading
  // pill then disagreed with the agents view as well. Both now read the same unscoped list.
  const out = await api('peers');
  const items = Array.isArray(out.items) ? out.items : [];
  const active = items.filter(p => p.connected);
  agentProtocols();

  // The header pill is the product's first claim about connected agents, so it states the two
  // counts separately instead of one ambiguous sentence:
  //   · there are no recorded peers at all          -> 暂无智能体接入
  //   · peers exist, none inside its ttl            -> names the count AND what to do about it
  //   · at least one peer inside its ttl            -> 在线 N（其余 M 未在线）
  // "已过期" used to stand for "this page has a stale row", which read like an error the user could
  // not act on; a peer going offline is normal and the fix is a heartbeat, so the words say that.
  const stale = items.length - active.length;
  const ttl = items.length ? Math.round(Math.min(...items.map(p => Number(p.ttl) || 0).filter(Boolean)) || 0) : 0;
  // The pill may not say more than the page knows, and it must not say LESS either. A stale row
  // has three genuinely different causes that look identical from here, and their fixes have
  // nothing in common: a connector the host never loaded, one it loaded but whose entry point
  // bailed out before registering anything, and one that works but is not reaching this store.
  // Naming only '心跳已失效' once started a whole investigation in the wrong place, so the wording
  // separates what this page can prove (the row is older than its own ttl) from what it cannot
  // (why), and points at the one command that does know.
  const freshest = items.length
    ? Math.min.apply(null, items.map(p => Number(p.last_seen_age_seconds) || 0)) : 0;
  $('connection').textContent = active.length
    ? ('在线 ' + active.length + ' 个智能体' + (stale ? '（' + stale + ' 个未在线）' : ''))
    : (items.length
      ? ('无在线智能体（' + stale + ' 个接入方最近一次心跳在 ' + secondsAgo(freshest)
         + '，已超过 ' + (ttl || 90) + ' 秒有效期）')
      : '暂无智能体接入');
  $('connection').className = 'pill' + (active.length ? ' is-ok' : items.length ? ' is-warn' : '');

  const summary = $('agent-summary');
  if (summary) {
    const projects = out.projects || [];
    summary.textContent = items.length
      ? '共记录 ' + items.length + ' 个接入方，分布在 ' + projects.length + ' 个分区：'
        + projects.join('、') + '。心跳有效期由接入方自报（本地记录为 ' + (ttl || 90) + ' 秒），'
        + '超时即显示为未在线——接入方需要周期性调用 memory_peer_heartbeat。'
        + '若本地 DSH 连接器长期不刷新，运行 node tools/verify_agent_presence.mjs 可分辨是「未加载」'
        + '「已加载但入口未注册工具」还是「心跳未发出」——这三种原因的现象相同，修法完全不同。'
      : '尚未收到心跳。配置 MCP 并由智能体调用 memory_peer_heartbeat 后，会在此显示。';
  }

  $('peers').replaceChildren(...items.map(p => {
    const card = node('article', undefined, 'card' + (p.connected ? ' is-online' : ''));
    const badge = node('span', p.connected ? '在线' : '离线',
      'pill' + (p.connected ? ' is-ok' : ''));
    const head = node('div', undefined, 'row');
    head.append(node('h3', p.name), badge);
    card.append(
      head,
      node('p', lines(p.model || '未报告模型', p.location,
        p.project ? '分区 ' + p.project : '')),
      node('small', lines(p.id,
        p.connected ? '刚刚心跳' : ('最近一次心跳在 ' + secondsAgo(p.last_seen_age_seconds)),
        Object.keys(p.capabilities || {}).length
          ? '能力 ' + Object.keys(p.capabilities).join('/') : '',
        p.identity))
    );
    return card;
  }));
  if (!items.length) {
    empty($('peers'), '尚未收到心跳。配置 MCP 并由智能体调用 memory_peer_heartbeat 后，会在此显示。');
  }
}
$('refresh-peers').onclick = () => run(peers);
$('copy-config').onclick = () => run(async () => {
  await navigator.clipboard.writeText($('mcp-config').textContent);
  notice('已复制 MCP 配置。');
});

/* ------------------------------------------------------------------ Markdown 文档 */

function resetDocument() {
  state.document = null;
  state.latest = 0;
  for (const id of ['doc-slug', 'doc-title', 'doc-content', 'doc-date']) $(id).value = '';
  $('doc-history').replaceChildren();
  $('doc-version').textContent = '新文档 · 尚未保存';
}
async function documents() {
  const out = await api('documents');
  $('document-list').replaceChildren(...out.items.map(d => {
    const card = node('article', undefined, 'card');
    card.append(
      button(d.title, () => openDocument(d.slug, d.audience)),
      node('p', d.audience + ' · v' + d.version + ' · ' + (d.recorded_date || d.created.slice(0, 10))),
      node('small', d.published ? '已发布' : '草稿')
    );
    return card;
  }));
  if (!out.items.length) empty($('document-list'), '尚无文档，可新建或导入 Markdown。');
}
async function openDocument(slug, audience, version) {
  const d = await query('document', {slug, audience, version});
  state.document = d;
  state.latest = Math.max(...d.history.map(x => x.version));
  $('doc-slug').value = d.slug;
  $('doc-audience').value = d.audience;
  $('doc-title').value = d.title;
  $('doc-content').value = d.content;
  $('doc-date').value = d.recorded_date || '';
  $('doc-version').textContent = '正在查看 v' + d.version + ' / 最新 v' + state.latest
    + ' · ' + (d.published ? '已发布' : '草稿') + ' · 保存会建立新版本';
  $('doc-history').replaceChildren(...d.history.map(
    v => button('v' + v.version + (v.published ? ' 已发布' : ''), () => openDocument(d.slug, d.audience, v.version))
  ));
}
$('new-document').onclick = resetDocument;
$('doc-audience').onchange = () => run(async () => {
  const audience = $('doc-audience').value;
  const slug = $('doc-slug').value;
  const docs = await api('documents');
  if (docs.items.some(d => d.slug === slug && d.audience === audience)) {
    await openDocument(slug, audience);
  } else {
    state.document = null;
    state.latest = 0;
    $('doc-history').replaceChildren();
    $('doc-version').textContent = '此用途尚无版本，将创建 v1';
  }
});
$('document-file').onchange = e => run(async () => {
  const file = e.target.files[0];
  if (!file) return;
  if (file.size > 250000) throw new Error('请将大文档分成小于 250 KB 的片段');
  resetDocument();
  $('doc-content').value = await file.text();
  $('doc-title').value = file.name.replace(/\.[^.]+$/, '');
  $('doc-slug').value = file.name.replace(/\.[^.]+$/, '').replace(/[^\p{L}\p{N}_-]/gu, '-').slice(0, 80);
  const date = file.name.match(/\d{4}-\d{2}-\d{2}/);
  if (date) $('doc-date').value = date[0];
  notice('已读取文件，保存后建立版本。原文件保持不变。');
  e.target.value = '';
});
$('document-form').onsubmit = e => {
  e.preventDefault();
  run(async () => {
    const slug = $('doc-slug').value, audience = $('doc-audience').value;
    const same = state.document?.slug === slug && state.document?.audience === audience;
    const d = await api('document', {
      slug, audience, title: $('doc-title').value, content: $('doc-content').value,
      recorded_date: $('doc-date').value || null,
      origin_uri: same ? state.document.origin_uri : '',
      group_title: same ? state.document.group_title : '',
      expected_version: same ? state.latest : 0
    });
    await documents();
    await openDocument(d.slug, d.audience);
    notice('已保存 v' + d.version + '；旧版本与原始日期已保留。');
  }, e.submitter);
};
async function selectedDocumentAction(path) {
  if (!state.document) throw new Error('请先保存或选择一个文档版本');
  const d = state.document;
  const out = await api(path, {slug: d.slug, audience: d.audience, version: d.version});
  await documents();
  await openDocument(d.slug, d.audience, d.version);
  return out;
}
$('publish-document').onclick = () => run(async () => {
  await selectedDocumentAction('document-publish');
  notice('所选版本已发布。文档发布与记忆沉淀是两个步骤。');
});
$('index-document').onclick = () => run(async () => {
  await selectedDocumentAction('document-index');
  notice('已分段加入待审记忆；在分类与沉淀中确认后可检索。');
  await refreshRetrieve();
});

/* ------------------------------------------------- document chunk index (POST /document-chunks)

   Distinct from #index-document above and deliberately NOT merged with it. That button POSTs
   /document-index, which exports a revision into the MEMORY store and builds pending memory rows
   -- a different pipeline with a different outcome. This one POSTs /document-chunks (memora/
   workbench.py:307,314), which writes doc_chunks / doc_chunk_fts / doc_chunk_embeddings rows: the
   corpus memory_document_rag_context actually searches.

   The message therefore names the REAL outcome, never a generic 'done'. The backend already
   returns exactly one of indexed / unchanged / skipped / error per document (workbench.py:88-125),
   and two independent proofs that the corpus moved or did not: `corpus` row counts and
   `generation.changed`. Someone clicking this has to be able to tell whether the document became
   searchable, so every branch below says which of the four it was and what it means for retrieval
   -- and the vector half is called out whenever embedding.mode did not write vectors, because an
   FTS-only corpus still leaves vector/hybrid retrieval empty. */
function documentChunkMessage(out) {
  const d = (out.documents || [])[0];
  if (!d) return '文档分块索引没有返回结果，请重试。';
  const e = d.embedding || {};
  // The vector half, described only when it did NOT happen -- appending a mode note to a success
  // line would drown the chunk count, which is the number this click was actually about.
  const noVectors = e.mode === 'disabled'
    ? ' 未写入向量：本项目未配置 embedding 服务，关键词检索可用，向量与混合检索仍为空。'
    : e.mode === 'skipped'
      ? ' 未写入向量：本次只做关键词分块，向量与混合检索仍为空。'
      : '';
  if (d.result === 'indexed') {
    const n = d.written != null ? d.written : (d.chunks || 0);
    return '已索引到文档检索：写入 ' + n + ' 个分块'
      + (d.removed ? '，移除旧分块 ' + d.removed + ' 个' : '')
      + (e.mode === 'vector' ? '，并写入 ' + (e.embedded || 0) + ' 个向量。' : '。')
      + noVectors;
  }
  if (d.result === 'unchanged') {
    return '该文档此前已索引，内容无变化，没有重新写入任何分块。'
      + (e.pending ? ' 待补向量 ' + e.pending + ' 个。' : '')
      + noVectors;
  }
  if (d.result === 'skipped') {
    return '已跳过：' + (d.slug || '') + ' / ' + (d.audience || '')
      + (d.version ? ' v' + d.version : '')
      + ' 是未发布草稿；只有已发布版本才能建立文档检索索引，请先发布，再重新索引。';
  }
  if (d.result === 'error') {
    return '索引失败（错误码 ' + (d.error || 'unknown') + '）：' + (d.message || '未知原因')
      + ' 本次没有写入任何分块。';
  }
  return '返回了无法识别的结果：' + String(d.result);
}
$('index-document-chunks').onclick = () => run(async () => {
  // Same guard as the other per-document actions: with no document open there is nothing to
  // index, and the helper raises before any request is made, so this no-ops instead of
  // posting a wrong slug.
  const out = await selectedDocumentAction('document-chunks');
  notice(documentChunkMessage(out));
  // The corpus just changed (or provably did not), so the status panel is now stale: re-read it
  // rather than leave a count that contradicts the notice above. refreshDocumentChunks() reports
  // its own failure in its own panel and never throws, so a read failure cannot swallow the
  // index result this click was actually about.
  await refreshDocumentChunks();
});

/* ----------------------------------------- document chunk corpus: status panel

   GET /api/agent/document-chunks-status (memora/workbench.py:207) returns
   DocIndex.status() verbatim (memora/docindex.py:639): project-scoped ROW COUNTS,
   the per-revision breakdown, whether an embedding provider is configured, the
   kernel and the fusion weights. That is a different question from the one the
   MCP tool memory_document_rag_context answers, and it is the one this page could
   not answer: the evidence tool returns an EMPTY PACK both for "this project was
   never indexed" and for "the query matched nothing", so an owner could not tell
   a corpus that does not exist from a question that did not land. Counts can,
   because they count rows rather than results -- and that distinction is the
   whole reason this panel exists, so it is rendered in words, not only digits.

   Trigger: an explicit button only, plus one automatic refresh after
   #index-document-chunks succeeds -- that click is the event that changes the
   answer. Opening the view or switching projects fetches nothing: show() already
   calls documents() there, and adding a second request to every visit is a cost
   nobody asked for. A project switch CLEARS the panel instead (see
   resetDocumentChunks), because a count from another project is worse than none.

   Rendering is defensive: only chunks/vectors are load-bearing. A response
   missing them is reported as a response that could not be read -- never as an
   empty corpus. Those two cases are exactly what this panel exists to separate.
*/

const AUDIENCE_LABEL = {human: '用户', agent: '智能体', shared: '共享'};
const audienceText = a => AUDIENCE_LABEL[a] || shown(a) || '未标注';

function documentChunkStatusText(text) {
  const box = $('document-chunks-status-text');
  if (box) box.textContent = text;
}

/** Why a fetch failed, in the terms the owner needs: a 404 means the route is not deployed. */
function failureText(err) {
  const raw = err && err.message ? err.message : String(err);
  return /404|unknown memory endpoint|not found/i.test(raw)
    ? raw + '（404：这个服务端没有部署该路由，或工作台版本比页面旧）'
    : raw;
}

/** The per-revision breakdown. Rows are the backend's own grouping, printed as sent. */
function revisionTable(revisions) {
  const table = node('table');
  table.append(node('caption', '各版本分块数（文档标识 / 用途 / 版本 / 分块）'));
  const head = node('tr');
  for (const label of ['文档标识', '用途', '版本', '分块']) head.append(node('th', label));
  const thead = node('thead');
  thead.append(head);
  table.append(thead);
  const body = node('tbody');
  for (const r of revisions) {
    const tr = node('tr');
    tr.append(node('td', shown(r.slug)));
    tr.append(node('td', audienceText(r.audience)));
    tr.append(node('td', r.version === undefined || r.version === null ? '未标注' : 'v' + r.version));
    tr.append(node('td', typeof r.chunks === 'number' ? r.chunks : '未标注', 'count'));
    body.append(tr);
  }
  table.append(body);
  return table;
}

/** Render one /document-chunks-status envelope. Returns the card, or null when unreadable. */
function renderDocumentChunks(status) {
  const target = $('document-chunks-status');
  if (!target) return null;
  const card = node('article', undefined, 'card');
  if (!status || typeof status !== 'object') {
    card.append(node('h3', '文档分块索引状态'));
    card.append(node('p', '状态响应不是一个对象，无法判断语料里有什么。', 'error'));
    target.replaceChildren(card);
    return card;
  }
  if (typeof status.chunks !== 'number' || typeof status.vectors !== 'number') {
    // Not zero: unreadable. Printing "0 分块" here is the exact false claim this panel prevents.
    card.append(node('h3', '文档分块索引状态'));
    card.append(node('p', '状态响应里没有 chunks / vectors 计数，无法判断语料是否已建立。', 'error'));
    target.replaceChildren(card);
    return card;
  }

  const revisions = Array.isArray(status.revisions) ? status.revisions : [];
  const models = Array.isArray(status.models) ? status.models : [];
  const empty = status.chunks === 0;

  card.append(node('h3', empty ? '这个项目还没有建立文档分块索引' : '文档分块索引状态'));

  const totals = node('div', undefined, 'row');
  totals.append(node('b', status.chunks, 'count'), node('span', ' 个分块'));
  totals.append(node('b', status.vectors, 'count'), node('span', ' 个向量'));
  card.append(totals);

  const facts = node('div', undefined, 'row');
  facts.append(node('span', '项目 ' + shown(status.project), 'tag'));
  if (status.generation !== undefined) facts.append(node('span', 'generation ' + shown(status.generation), 'tag'));
  facts.append(node('span', status.embedding_configured ? '向量模型 已配置' : '向量模型 未配置', 'tag'));
  if (status.kernel) facts.append(node('span', '内核 ' + shown(status.kernel), 'tag'));
  card.append(facts);

  if (empty) {
    // The distinction counts cannot express on their own: zero ROWS, not zero RESULTS.
    card.append(node('p', '索引里一行都没有：这不是「查询没有匹配到」，而是语料从来没有建立过。'
      + '先发布文档，再点上面的「索引到文档检索」，这里才会出现分块。', 'warn'));
  } else {
    card.append(revisionTable(revisions));
    if (!revisions.length) {
      card.append(node('p', '有分块但没有按版本分组的结果，服务端返回的 revisions 为空。', 'warn'));
    }
  }

  // The vector half is never implied: a corpus with chunks but no vectors searches lexically only.
  // One warning per fact -- with no provider configured the vector count is zero by construction,
  // so reporting both would state the same thing twice and make the actionable half look like two
  // separate problems.
  if (!status.embedding_configured) {
    card.append(node('p', empty
      ? '本项目未配置 embedding 服务：分块可以建立，但向量与混合检索会一直是空的。'
      : '本项目未配置 embedding 服务：这 ' + status.chunks
        + ' 个分块只有关键词检索可用，向量与混合检索会一直是空的。', 'warn'));
  } else if (!empty && status.vectors === 0) {
    card.append(node('p', '还没有任何向量：向量与混合检索会返回空，只有关键词检索可用。重新索引一次即可补上向量。', 'warn'));
  } else if (!empty && status.vectors < status.chunks) {
    card.append(node('p', '向量数少于分块数（' + status.vectors + ' / ' + status.chunks
      + '），部分分块只能被关键词检索命中。', 'warn'));
  }

  const fusion = status.fusion && typeof status.fusion === 'object' ? status.fusion : null;
  card.append(node('p', lines(
    models.length ? '已登记向量模型 ' + models.length + ' 个' : '尚未登记向量模型',
    fusion && Array.isArray(fusion.weights) ? '融合权重 ' + fusion.weights.join(' / ') : '',
    fusion && fusion.rrf_k !== undefined ? 'RRF k=' + fusion.rrf_k : '',
    status.audience_filter ? '用途过滤 ' + shown(status.audience_filter) : '用途过滤 未设置'
  ), 'meta'));

  target.replaceChildren(card);
  return card;
}

/** Read the corpus status once. Every failure is shown as a failure, never as an empty corpus. */
async function refreshDocumentChunks() {
  const target = $('document-chunks-status');
  documentChunkStatusText('正在读取索引状态…');
  try {
    const status = await query('document-chunks-status', {});
    renderDocumentChunks(status);
    documentChunkStatusText('已读取 · ' + stamp(new Date().toISOString())
      + ' · 项目「' + shown(status && status.project) + '」');
    return status;
  } catch (err) {
    if (target) {
      const card = node('article', undefined, 'card');
      card.append(node('h3', '文档分块索引状态'));
      card.append(node('p', '读取失败：' + failureText(err) + '。下面没有任何计数，因为这次没有读到语料，'
        + '不代表语料是空的。', 'error'));
      target.replaceChildren(card);
    }
    documentChunkStatusText('读取失败');
    return null;
  }
}

/** A count from another project must never sit under the new one: clear, do not refetch. */
function resetDocumentChunks() {
  const target = $('document-chunks-status');
  if (target) target.replaceChildren();
  documentChunkStatusText('尚未请求（项目已切换）');
}

$('refresh-document-chunks').onclick = () => run(refreshDocumentChunks);

/* Document evidence uses the same read-only DocIndex envelope as the MCP tool. */
function resetDocumentEvidence() {
  $('document-evidence-status').textContent = '通过 document-rag 读取真实文档证据；不会以记忆结果替代文档。';
  $('document-evidence').replaceChildren();
  $('document-evidence-button').disabled = false;
}
resetDocumentEvidence();
$('document-evidence-button').onclick = () => run(async () => {
  const question = $('document-evidence-query').value.trim();
  if (!question) { notice('请先输入文档证据问题。'); return; }
  $('document-evidence-status-text').textContent = '正在读取…';
  const pack = await query('document-rag', {query: question, budget: 6000,
    audience: $('doc-audience').value || 'all'});
  const card = node('article', undefined, 'card');
  card.append(node('h3', pack.references.length + ' 条文档证据 · ' + pack.retrieval_mode),
    node('pre', pack.context || '未找到匹配文档块：请确认已发布并索引文档。'));
  card.append(node('pre', JSON.stringify({citations: pack.citations, omitted: pack.omitted,
    truncated: pack.truncated, budget: pack.budget, warning: pack.retrieval_warning}, null, 2)));
  $('document-evidence').replaceChildren(card);
  $('document-evidence-status-text').textContent = '已读取 · ' + pack.references.length + ' 条引用';
});

$('repair-documents').onclick = () => run(async () => notice('镜像修复：' + JSON.stringify(await api('document-repair', {}))));

/* ------------------------------------------------------------------ 脑图 */

/* 脑图有两个数据来源，必须能一眼分清：
     - 真实：/brain/<layout>/ 自己按项目读取已审核记忆与存储关系。
     - 预览：项目里一条已审核记忆都没有时，读 /brain-preview 的只读演示图，让人先看见
       语义关联与动效长什么样。演示节点不写库、不参与检索；一旦有真实记忆，后端会拒绝预览
       （返回 available:false），这里就把开关关掉并说明原因。
   互斥而不是叠加：真实数据和演示数据同时出现在同一张图里，比没有预览更糟。 */
state.brainPreview = false;
/* Whether the auto-preview decision has been made for the CURRENT project. A project switch has to
   be able to make it again, so this resets with the rest of the per-project state; and a manual
   toggle must win over it, so a manual choice sets it too (otherwise a refresh would re-decide). */
state.brainPreviewDecided = false;

async function brainPreviewPayload() {
  const out = await api('brain-preview');
  if (!out || out.available === false) {
    const why = (out && out.note) || '项目已有真实记忆，脑图直接显示真实数据。';
    return {ok: false, why, approved: (out && out.approved) || 0};
  }
  return {ok: true, data: out};
}

function paintBrainPreviewState() {
  const toggle = $('brain-preview-toggle');
  if (toggle) {
    toggle.classList.toggle('is-active', state.brainPreview);
    toggle.setAttribute('aria-pressed', state.brainPreview ? 'true' : 'false');
    // The preview is the default when a project has no approved memory, so the control is a way
    // OUT of the demo rather than a way in, and its label has to say what the click will do.
    toggle.textContent = state.brainPreview ? '关闭演示数据' : '演示数据';
    toggle.title = state.brainPreview
      ? '回到真实投影：这个项目还没有已审核记忆，因此真实投影只有一个占位节点。'
      : '项目已有真实记忆时不可用：演示数据不会与真实数据混在同一张图里。';
  }
  const note = $('brain-preview-note');
  if (note) {
    note.hidden = !state.brainPreview;
    if (state.brainPreview) {
      note.textContent = '正在显示演示数据：这些是内置样例，用于预览语义关联、连线与自动视角，'
        + '不是已保存的记忆，也不会参与检索。项目里有一条已审核记忆后，脑图会自动改回真实数据。';
    }
  }
}

/**
 * Decide the data source for this project, once per project.
 *
 * The packaged app ships an EMPTY store, so before this the first thing a user saw in 脑图 was one
 * placeholder dot -- they could not tell a working graph from a broken one, which is exactly why
 * the demo graph exists. Requiring a click on 预览语义关系 to see it made the demo effectively
 * invisible. So: with no approved memory the preview is the DEFAULT, and the banner says so; with
 * anything approved the real projection is used and the preview is refused by the server anyway.
 *
 * The decision is made by asking the server, not by guessing from a node count: /brain-preview is
 * the same endpoint the toggle uses and it already refuses once real memories exist, so the two
 * paths can never disagree.
 */
async function decideBrainSource() {
  if (state.brainPreviewDecided) return;
  state.brainPreviewDecided = true;
  const toggle = $('brain-preview-toggle');
  try {
    const probe = await brainPreviewPayload();
    if (probe.ok) {
      state.brainPreview = true;
      if (toggle) { toggle.disabled = false; toggle.hidden = false; }
    } else {
      state.brainPreview = false;
      if (toggle) {
        // A project WITH memories gets a permanent, disabled toggle: there is nothing to preview.
        toggle.disabled = (probe.approved || 0) > 0;
        toggle.hidden = !toggle.disabled;
      }
      const note = $('brain-preview-note');
      if (note && probe.approved > 0) { note.hidden = false; note.textContent = probe.why; }
    }
  } catch {
    // An unreachable preview route must not block the real brain view.
    state.brainPreview = false;
  }
  paintBrainPreviewState();
}

function brain() {
  const type = $('brain-type').value, dimension = $('brain-dimension').value;
  // The three types are not the same kind of thing, so the 2D/3D switch cannot be applied blindly:
  //   dictionary / outline -> 2D is a real second rendering of the same data (the plane stage)
  //   matt                 -> the star-cloud bake is inherently 3D; there is no 2D variant. Showing
  //                           an empty plane frame would look like a broken view, so the dimension is
  //                           forced back to 3D and the note says why. The select is restored too, or
  //                           the next click would look like it did nothing.
  const type3dOnly = type === 'matt';
  const forcedTo3d = type3dOnly && dimension === '2d';
  if (forcedTo3d) { $('brain-dimension').value = '3d'; }
  const path = type3dOnly ? 'matt' : (dimension === '2d' ? 'plane' : type);
  // The note explains a choice that was just overruled, so it is shown ONLY when the user asked for
  // 2D and we had to fall back. Leaving it up merely because matt is selected would keep explaining
  // a conflict that is not happening.
  const note = $('brain-dimension-note');
  if (note) {
    note.hidden = !forcedTo3d;
    note.textContent = forcedTo3d
      ? '星云关系图只有三维形态：它的分区球壳与跨区弧线本身就是三维结构，这里已按三维显示。'
      : '';
  }
  const base = '/brain/' + path + '/?project=' + encodeURIComponent(project()) + '&mode=' + type;
  $('brain-frame').src = state.brainPreview ? base + '&preview=1' : base;
}
$('brain-type').onchange = brain;
$('brain-dimension').onchange = brain;
$('refresh-brain').onclick = brain;

/* Manual override of the automatic choice above. It still asks the server for permission when it
   turns the preview ON, because the server is the one authority on whether real data exists; the
   wording lives in paintBrainPreviewState() so the auto path and this one cannot drift apart. */
$('brain-preview-toggle').onclick = () => run(async () => {
  const toggle = $('brain-preview-toggle');
  const wanted = !state.brainPreview;
  if (wanted) {
    const probe = await brainPreviewPayload();
    if (!probe.ok) {
      state.brainPreview = false;
      state.brainPreviewDecided = true;
      toggle.disabled = probe.approved > 0;
      const note = $('brain-preview-note');
      if (note) { note.hidden = false; note.textContent = probe.why; }
      paintBrainPreviewState();
      brain();
      return;
    }
  }
  state.brainPreview = wanted;
  state.brainPreviewDecided = true;
  paintBrainPreviewState();
  brain();
});

$('link-form').onsubmit = e => {
  e.preventDefault();
  run(async () => {
    const kind = $('edge-kind').value;
    const hierarchy = ['part_of', 'prerequisite', 'sequence'].includes(kind);
    await api(hierarchy ? 'hierarchy' : 'link', hierarchy
      ? {parent: $('edge-a').value, child: $('edge-b').value, kind, evidence: $('edge-evidence').value}
      : {a: $('edge-a').value, b: $('edge-b').value, relation: kind});
    brain();
    notice('已保存关系。图中仅显示已沉淀的记忆。');
  }, e.submitter);
};

/* ------------------------------------------------------------------ 模型连接 */

function field(label, id, value, type, placeholder) {
  const l = node('label', label);
  const input = node('input');
  input.id = id;
  input.type = type || 'text';
  input.value = value || '';
  if (placeholder) input.placeholder = placeholder;
  l.append(input);
  l.input = input;            // so callers can reach the control without re-walking children
  return l;
}

/* ------------------------------------------------------------------ 模型服务商预设

   Every endpoint this page can prefill lives in this one block, so correcting a URL is a
   single edit and never a hunt through the render function.

   base        candidate OpenAI-compatible base URL. NOT verified against the provider's own
               documentation from this repository, so the UI labels it 需用户确认 and the user
               confirms it before saving. Do not treat it as a measured fact.
   baseVerified false = 需用户确认.
   roles       one entry per role this preset can fill. ready:false means the backend does not
               accept that role yet: the card says so, and the save never submits it.
   model       supplied by the project owner for this release. Never infer or invent ids here.

   URL convention when adding a provider: base already ends at the version segment (/v1), which
   is what MM_*_URL expects (memora/config.py passes it straight to providers.Provider).

   不确定的基址一律标注需用户确认，不要编造模型 ID。 */
const MODEL_PRESETS = [
  {
    id: 'siliconflow',
    label: '硅基流动 SiliconFlow',
    base: 'https://api.siliconflow.cn/v1',
    baseVerified: false,
    note: '基址需用户确认；模型 ID 由本项目指定。',
    roles: {
      embedding: {model: 'Qwen/Qwen3-VL-Embedding-8B'},
      // rerank is a real, saved, server-accepted role (memora/core.py ROLES): the card and the probe
      // treat it exactly like the other two. It used to be marked ready:false here, which made the
      // preset button claim the backend could not accept it and left the role unsubmitted.
      rerank: {model: 'Qwen/Qwen3-VL-Reranker-8B'},
      judge: {model: 'Qwen/Qwen3.8-27B'}
    }
  }
];

/* Role cards in render order. rerank is drawn now because the presets name it, but a role the
   server's own settings object does not contain is never submitted: POST /api/agent/settings
   validates its role set (memora/core.py:131), so sending one it does not know would fail the
   whole save rather than just that card. */
const MODEL_ROLES = [
  {role: 'embedding', title: 'Embedding · 向量模型',
   note: '将记忆与问题编码为向量，Rust 完成相似度排序。'},
  {role: 'judge', title: 'Judge · 判定分类模型',
   note: '输出类别、持久性、重要性和风险，再映射至分类或待审队列。'},
  {role: 'rerank', title: 'Rerank · 重排序模型',
   note: '对首轮候选做第二段相关性重排；与 Judge 不同，它只给相关度分数，不做分类。未配置时检索跳过一次重排。'}
];

/** Roles the server actually accepts right now, read off its own status payload. */
const serverRoles = () => new Set(Object.keys((state.config && state.config.settings) || {}));

/** The stored secret is never sent back, so the only thing a card can report is whether one
    exists. Absent report != "no key", and the words have to say which of the two it is.
    status() reports this as `keys[role] = {key_set, source}`; the settings payload repeats
    `key_set` per role for convenience. Read `keys` first, fall back to the per-role flag. */
function keyStateLine(role) {
  const byRole = (state.config && state.config.keys) || null;
  const perSetting = (state.config && state.config.settings && state.config.settings[role]) || null;
  let known = null, isSet = null;
  if (byRole && (role in byRole)) { isSet = Boolean(byRole[role] && byRole[role].key_set); known = true; }
  else if (perSetting && ('key_set' in perSetting)) { isSet = Boolean(perSetting.key_set); known = true; }
  const line = node('small');
  line.className = 'mm-key-state';
  line.id = role + '-key-state';
  if (!known) {
    line.className = 'mm-key-state is-unknown';
    line.textContent = '密钥状态未知：服务端未上报 key_set';
  } else if (isSet) {
    line.className = 'mm-key-state is-set';
    line.textContent = '已配置：服务端已保存密钥，输入框保持为空';
  } else {
    line.className = 'mm-key-state is-unset';
    line.textContent = '未配置：服务端还没有保存该角色的密钥';
  }
  line.title = '页面永远拿不回密钥原文，只显示服务端上报的布尔状态。';
  return line;
}

/** A write-only secret box: masked first, revealed only by an explicit toggle, never prefilled. */
function secretField(role) {
  const l = node('label', '字面密钥（服务端保存，永不回传）');
  const row = node('div');
  row.className = 'mm-key-row';
  const input = node('input');
  input.id = role + '-api-key';
  input.type = 'password';                 // masked until the toggle says otherwise
  input.value = '';                        // never prefilled, even when key_set is true
  input.autocomplete = 'new-password';     // keep password managers out of a settings form
  input.placeholder = '留空表示不改动已保存的密钥';
  input.setAttribute('aria-describedby', role + '-key-state');
  const toggle = node('button', '显示');
  toggle.id = role + '-key-toggle';
  toggle.className = 'mm-key-toggle';
  toggle.type = 'button';                  // a reveal control must never submit the form
  toggle.setAttribute('aria-controls', input.id);
  toggle.setAttribute('aria-pressed', 'false');
  toggle.setAttribute('aria-label', '显示密钥');
  const flip = reveal => {
    input.type = reveal ? 'text' : 'password';
    toggle.setAttribute('aria-pressed', reveal ? 'true' : 'false');
    toggle.setAttribute('aria-label', reveal ? '隐藏密钥' : '显示密钥');
    toggle.textContent = reveal ? '隐藏' : '显示';
  };
  toggle.onclick = () => flip(input.type === 'password');
  row.append(input, toggle);
  l.append(row, keyStateLine(role));
  return l;
}

/** Prefill url/model from the constant block. Buttons, not a form control: filling a draft is
    not a save, and nothing here reaches the network. */
/** Local vs cloud, in words. The stored field is a boolean (remote), so the badge is the only
    place the distinction is readable without decoding the select. */
function modeBadge(role, select) {
  const badge = node('small');
  badge.id = role + '-mode';
  badge.className = 'mm-mode';
  const paint = () => {
    const mode = select.value;
    badge.className = 'mm-mode' + (mode === 'cloud' ? ' is-cloud' : mode === 'local' ? ' is-local' : ' is-off');
    badge.textContent = mode === 'cloud' ? '云端：请求会离开本地，需要密钥'
      : mode === 'local' ? '本地：请求只发往本地服务，通常不需要密钥'
      : '未配置：没有后端设置，密钥无处提交';
  };
  select.addEventListener('change', paint);
  paint();
  return badge;
}

function presetRow(role, urlInput, modelInput, select, badge) {
  const l = node('label', '服务商预设（填充 API 地址与模型名称）');
  const row = node('div');
  row.className = 'mm-presets';
  const notes = [];
  for (const preset of MODEL_PRESETS) {
    const spec = preset.roles && preset.roles[role];
    if (!spec) continue;
    const b = node('button', preset.label);
    b.type = 'button';
    b.className = 'mm-preset';
    b.id = role + '-preset-' + preset.id;
    b.setAttribute('title', lines(preset.base, preset.note,
      spec.ready === false ? '后端未就绪：保存不会提交该角色' : ''));
    b.onclick = () => {
      // A cloud preset fills a cloud connection: leaving the select on "local" would submit
      // remote:false against an https endpoint. The switch runs FIRST because the connection
      // handler deliberately clears the URL when it moves to cloud -- filling first would wipe
      // the endpoint this button just wrote.
      if (select && select.value !== 'cloud') {
        select.value = 'cloud';
        select.dispatchEvent(new Event('change'));
      }
      urlInput.value = preset.base;
      modelInput.value = spec.model;
      notice('已填入 ' + preset.label + ' 的地址与模型名称，并把接入方式切到云端；基址需用户确认后再保存。');
    };
    row.append(b);
    notes.push(preset.label + '：' + preset.base
      + (preset.baseVerified === false ? '（需用户确认）' : '')
      + (spec.ready === false ? '，后端未就绪' : ''));
  }
  if (!row.children.length) return null;
  const note = node('small', notes.join(' · '));
  note.className = 'mm-preset-note';
  l.append(row, note);
  return l;
}


/* ------------------------------------------------------------------ 模型配置：新增模型类型

   Embedding / Judge / Rerank are the three roles that run the retrieval pipeline, and they own
   real connection cards. The completion roles (router, curator, summarizer, classifier, documenter,
   sql_analyst, relation, verifier) are what 工作流可视化's 分工与扩展空间 binds, and until now they
   could only be edited over there. They are edited here too, as "模型类型":

     each type is one completion role
     each row binds that type to a profile in the model pool, or leaves it unbound
     the workflow canvas reads the same table, so a type bound here is selectable on a node there

   Nothing is duplicated: this reads and writes POST /models (the same model-registry.json the
   orchestration panel uses). The table is rendered from whatever the server reports, so a role
   added to memora/control.py ROLE_SPECS appears here without editing this file.
*/
const MODEL_TYPE_HINT = {
  router: '在用户允许的模型或工作流中选择目标；与 Judge 分开。',
  curator: '从会话提取有来源的长期记忆候选。',
  summarizer: '按大标题生成项目到条目的两层摘要。',
  classifier: '建议学科、资源类型、知识层级。',
  documenter: '重组文档并保存为新草稿，保留原版本。',
  sql_analyst: '解释只读查询结果；不执行模型生成的 SQL。',
  relation: '提出支持、矛盾、组成、前置等关系。',
  verifier: '检查输出与来源的一致性，报告缺证与冲突。'
};

/** The completion roles, in the ladder order the server reports. */
function modelTypes(registry) {
  const roles = Object.keys((registry && registry.roles) || {});
  return roles.filter(role => role !== 'embedding' && role !== 'judge');
}

function renderModelTypes(registry) {
  const host = $('model-types');
  if (!host) return;
  const models = (registry && registry.models) || [];
  const bindings = (registry && registry.bindings) || {};
  const types = modelTypes(registry);
  host.replaceChildren();

  if (!types.length) {
    empty(host, '后端没有报告任何可分配的角色；/models 未返回 roles。');
    return;
  }

  for (const role of types) {
    const detail = (registry.roles || {})[role] || {};
    const row = node('div', undefined, 'model-type-row');
    row.dataset.role = role;

    const title = node('div', undefined, 'model-type-title');
    title.append(
      node('strong', detail.title || role),
      node('small', MODEL_TYPE_HINT[role] || detail.description || '')
    );

    const select = node('select');
    select.dataset.modelType = role;
    select.setAttribute('aria-label', (detail.title || role) + ' 绑定的模型');
    const none = node('option', '未绑定');
    none.value = '';
    select.append(none);
    for (const profile of models) {
      const option = node('option', profile.name + ' · ' + profile.model);
      option.value = profile.id;
      option.selected = bindings[role] === profile.id;
      select.append(option);
    }
    select.value = bindings[role] || '';

    const state = node('small', bindings[role]
      ? ('已绑定到 ' + (models.find(m => m.id === bindings[role]) || {}).name)
      : '未绑定：工作流里选不到这个类型',
      bindings[role] ? 'model-type-bound' : 'model-type-unbound');

    row.append(title, select, state);
    host.append(row);
  }

  const note = $('model-types-note');
  if (note) {
    note.textContent = models.length
      ? ('共 ' + models.length + ' 个模型池配置，' + types.length + ' 个可分配类型。'
         + '工作流可视化里的节点部件读的就是这张表。')
      : '模型池为空：先在「工作流可视化」的模型池里新增一个配置，这里才能绑定类型。';
  }
}

/** Load /models and paint. Called on entering 模型配置 and after saving types. */
async function loadModelTypes() {
  const registry = await api('models');
  state.modelRegistry = registry;
  renderModelTypes(registry);
  return registry;
}

$('model-types-save').onclick = () => run(async () => {
  const registry = state.modelRegistry || await api('models');
  const bindings = Object.assign({}, registry.bindings || {});
  for (const select of document.querySelectorAll('#model-types select[data-model-type]')) {
    const role = select.dataset.modelType;
    bindings[role] = select.value || null;
  }
  // Keep the pool exactly as the server reported it: this editor only re-binds types.
  await api('models', {registry: {models: registry.models || [], bindings}});
  await loadModelTypes();
  notice('模型类型已保存。工作流可视化里的节点部件会同步出现这些类型。');
}, $('model-types-save'));

function settings() {
  const area = $('model-settings');
  area.replaceChildren();
  const known = serverRoles();
  for (const spec of MODEL_ROLES) {
    const role = spec.role;
    const ready = known.has(role);
    const p = (state.config.settings && state.config.settings[role])
      || {backend: '', url: '', model: '', key_env: '', preset: 'none', remote: false, response_format: 'json_schema'};
    const card = node('article', undefined, ready ? 'panel' : 'panel mm-role-pending');
    card.append(node('h2', spec.title), node('p', spec.note));
    if (!ready) {
      const pending = node('small', '这个角色还没进入后端设置：卡片可以预置连接信息，但保存不会提交它。');
      pending.className = 'mm-field-note';
      card.append(pending);
    }
    const label = node('label', '接入方式'), select = node('select');
    select.id = role + '-connection';
    for (const [v, t] of [['environment', '环境变量 / 未配置'], ['local', '本地 OpenAI 兼容'], ['cloud', '云端 OpenAI 兼容']]) {
      const o = node('option', t); o.value = v; select.append(o);
    }
    select.value = p.backend ? (p.remote ? 'cloud' : 'local') : 'environment';
    label.append(select);
    const badge = modeBadge(role, select);
    const urlField = field('API 地址（含 /v1）', role + '-url', p.url);
    const modelField = field('模型名称', role + '-model', p.model);
    const urlInput = urlField.children[urlField.children.length - 1];
    const modelInput = modelField.children[modelField.children.length - 1];
    card.append(
      label,
      badge,
      urlField,
      modelField,
      field('密钥环境变量名（可选）', role + '-key', p.key_env,
            'text', '服务端在调用时从这个环境变量读取密钥')
    );
    card.append(secretField(role));
    const presets = presetRow(role, urlInput, modelInput, select, badge);
    if (presets) card.append(presets);
    if (role === 'embedding') {
      const l = node('label', '输入模板'), s = node('select');
      s.id = 'embedding-preset';
      for (const value of ['none', 'qwen3-embedding']) { const o = node('option', value); o.value = value; s.append(o); }
      s.value = p.preset;
      l.append(s);
      card.append(l);
    } else if (role === 'judge') {
      const l = node('label', '结构化输出'), s = node('select');
      s.id = 'judge-format';
      for (const value of ['json_schema', 'json_object', 'none']) { const o = node('option', value); o.value = value; s.append(o); }
      s.value = p.response_format;
      l.append(s);
      card.append(l);
    }
    select.onchange = () => {
      const cloud = select.value === 'cloud';
      urlInput.value = cloud ? '' : select.value === 'local' ? 'http://127.0.0.1:11434/v1' : '';
      urlInput.placeholder = cloud ? 'https://provider.example/v1' : 'http://127.0.0.1:1234/v1';
    };
    area.append(card);
  }
}
$('settings-form').onsubmit = e => {
  e.preventDefault();
  run(async () => {
    const next = {};
    const known = serverRoles();
    const secretSent = [];
    for (const role of Object.keys(state.config.settings || {})) {
      const connection = $(role + '-connection').value;
      // `stored` is the payload the server sent back from status(): the public projection of the
      // saved settings. It carries `key_set` (a boolean the server DERIVES) and must never be
      // echoed back: validate_settings rejects unknown keys, so spreading it wholesale made every
      // save fail with HTTP 400 "model settings: backend, url, model, key_env, api_key, remote,
      // preset, response_format" -- and because the form re-renders from the unchanged stored
      // settings, the visible symptom was "my configuration was cleared".
      const stored = state.config.settings[role] || {};
      next[role] = {
        backend: connection === 'environment' ? '' : 'openai',
        url: $(role + '-url').value.trim(),
        model: $(role + '-model').value.trim(),
        key_env: $(role + '-key').value.trim(),
        remote: connection === 'cloud',
        preset: role === 'embedding' && $('embedding-preset') ? $('embedding-preset').value : 'none',
        response_format: role === 'judge' && $('judge-format') ? $('judge-format').value : 'json_schema'
      };
      // Round-trip the optional fields the server itself may have stored, and only those: an
      // absent key must stay absent so validate_settings keeps its own default.
      for (const optional of ('revision', 'timeout')) {
        if (optional in stored) next[role][optional] = stored[optional];
      }
      // The secret box starts empty and stays empty unless the user types in it. An empty box
      // means "leave the stored secret alone", never "erase it": the page cannot read the old
      // value back, so it must not claim to know it.
      const secret = $(role + '-api-key');
      const typed = secret ? secret.value.trim() : '';
      if (typed) { next[role].api_key = typed; secretSent.push(role); }
    }
    const skipped = MODEL_ROLES.map(s => s.role).filter(role => !known.has(role));
    await api('settings', {settings: next});
    await loadStatus();
    settings();                    // re-render: the boxes go back to empty, key_set is re-read
    notice('已保存。'
      + (secretSent.length ? '已提交 ' + secretSent.join('、') + ' 的新密钥（服务端只回传布尔状态，不回传原文）。' : '未改动已保存的密钥。')
      + (skipped.length ? ' 未提交 ' + skipped.join('、') + '：后端设置里还没有这个角色。' : '')
      + ' 向量模型切换后，请补建索引；不同模型的向量不会混用。MCP 客户端独立进程会在下次调用时刷新配置。');
  }, e.submitter);
};


/* ------------------------------------------------------------------ 真实连接探测

   模型配置页的两个问题，一个是能力缺口、一个是叙述缺口：

   1. 保存成功只代表配置写进了 memora.json（core.py 的 validate_settings 只校验形状），
      从来不代表端点真的可用。以前页面只能让用户"保存后去看检索结果"来间接判断，而
      检索还会因为词法回退看起来"能用"。所以这里加一次真实探测：对**已保存配置**分别
      发一个最小请求（embedding=/embeddings、judge=/chat/completions、rerank=/rerank），
      把 HTTP 状态、延迟、模型名和错误原样显示。探测对象是已保存配置而不是页面草稿——
      这正是按钮文案要说清楚的边界，也是服务端只接受已保存配置的原因（不允许拿任意
      URL 当探测跳板）。
   2. 三个角色（含 rerank）都要显示，不能只显示写死的两个。结果按服务端返回的角色键
      逐一渲染，角色名用本地标题，未知角色用原 id——新增角色不需要改这个文件。

   失败必须看起来像失败：HTTP 状态、异常类型、超时都要显示，绝不把 5xx 或空结果渲染成
   "已连通"。探测结果不写入任何存储，只活在页面状态里（它是那一刻的观测，不是配置）。 */
state.probe = null;

const PROBE_TITLES = {embedding: 'Embedding · 向量模型', judge: 'Judge · 判定模型', rerank: 'Rerank · 重排序模型'};

/** The results panel, created on first use so memory.html does not need to declare it. */
function probeResultsHost() {
  let host = $('model-probe-results');
  if (host) return host;
  host = node('div', undefined, 'cards');
  host.id = 'model-probe-results';
  const form = $('settings-form');
  if (form && form.parentElement) form.parentElement.insertBefore(host, form.nextElementSibling);
  else if (form) form.append(host);
  return host;
}

function probeLine(role, r) {
  const title = PROBE_TITLES[role] || role;
  const card = node('article', undefined, 'card' + (r.ok ? ' is-online' : ''));
  const head = node('div', undefined, 'row');
  const badge = node('span', r.ok ? '已连通' : r.configured === false ? '未配置' : '不可用',
    'pill' + (r.ok ? ' is-ok' : r.configured === false ? '' : ' is-warn'));
  head.append(node('h3', title), badge);
  card.append(head);
  if (r.ok) {
    card.append(node('p', lines(r.model || '未报告模型', (r.latency_ms === undefined ? '' : r.latency_ms + 'ms'),
      r.probed_at ? '探测于 ' + stamp(r.probed_at) : '')));
    // A successful call proves the endpoint AND the credential: say which one was exercised.
    card.append(node('small', (role === 'embedding' ? '已真实调用 /embeddings 并取回向量'
      : role === 'rerank' ? '已真实调用 /rerank 并取回相关度'
      : '已真实调用 /chat/completions 并取回回复') + '（服务端已保存的配置）', 'muted'));
  } else if (r.configured === false) {
    card.append(node('p', '该角色还没有保存可探测的接入配置（环境变量或未配置）。配置并保存后可以再探测。', 'muted'));
  } else if (r.ok === null || r.kind === 'in-process') {
    // An in-process backend has no endpoint to call. Reporting it as "不可用" would blame a
    // working model for a probe that cannot exist, so this is its own state.
    card.append(node('p', '进程内后端（sentence-transformers / llama-cpp）没有 HTTP 端点可探测：'
      + '它随进程加载，不使用网络。连通性以检索/判定的实际结果为准。', 'muted'));
  } else if (r.timeout === true) {
    // A timeout is not the same finding as a rejection: the server answered and the model was cold
    // (a large reranker can need >10 s on its first call). Say so and say the action.
    card.append(node('p', lines('这次调用超时（服务端上限 15s）：端点未必有问题，大模型首次调用可能很慢。',
      r.latency_ms !== undefined ? r.latency_ms + 'ms' : ''), 'warn'));
    card.append(node('small', '稍后再点一次「测试连接」；第二次通常只需数百毫秒。', 'muted'));
  } else {
    // The backend error already carries the HTTP status in parentheses ("ProviderError (HTTP 401)"),
    // so appending a raw "HTTP 401" again would print it twice -- the duplication is what makes an
    // honest failure look like a template bug.
    const detail = String(r.error || '探测失败');
    const hasStatus = /HTTP\s*\d{3}/i.test(detail);
    card.append(node('p', lines(detail, r.http_status && !hasStatus ? 'HTTP ' + r.http_status : '',
      r.latency_ms !== undefined && r.latency_ms !== null ? r.latency_ms + 'ms' : ''), 'warn'));
    card.append(node('small', '这是真实请求的结果：端点不可达、鉴权失败或响应不合约定都会显示在这里，不会伪装成成功。', 'muted'));
  }
  return card;
}

function paintProbe() {
  const host = probeResultsHost();
  if (!host) return;
  if (!state.probe) { host.replaceChildren(); return; }
  const roles = state.probe.roles || {};
  const order = Object.keys(roles);
  host.replaceChildren(...order.map(role => probeLine(role, roles[role] || {})));
}

const probeButton = $('model-probe');
if (probeButton) {
  // The button ships disabled with a title explaining that no route existed. The route now exists,
  // so the page enables it -- but only after the save/status path has run, so a click always probes
  // the configuration the server actually holds. A backend that does not serve the route answers
  // with an error envelope, which is shown verbatim rather than hidden.
  probeButton.disabled = false;
  probeButton.title = '对服务端**已保存**的每个角色发起一次真实最小调用（embedding / embeddings、judge / chat、'
    + 'rerank / rerank），显示 HTTP 状态、延迟与错误。不会探测页面上未保存的草稿。';
  probeButton.onclick = () => run(async () => {
    const out = await api('model-probe', {});
    state.probe = out;
    paintProbe();
    const roles = (out && out.roles) || {};
    const ok = Object.values(roles).filter(r => r && r.ok).length;
    const configured = Object.values(roles).filter(r => r && r.configured !== false).length;
    notice('真实探测完成：' + ok + '/' + configured + ' 个已配置角色连通'
      + (out && out.probed_at ? '（' + stamp(out.probed_at) + '）' : '') + '。');
  }, probeButton);
}

/* ------------------------------------------------------------------ background

   The stylesheet already animates the backdrop with CSS alone; body::before/::after drift two
   gradient layers under prefers-reduced-motion. This adds a sparse constellation on the
   optional canvas: few particles, ~12 fps, idle-gated startup, no per-frame layout reads (size
   and colour are read once), and no animation loop at all when reduced motion is requested.
   One static frame is still painted, because it costs nothing and is not motion.
*/

function backdrop() {
  const canvas = document.querySelector('.mm-backdrop-canvas');
  if (!canvas || !canvas.getContext) return;
  let reduced = false;
  try { reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch {}
  const context = canvas.getContext('2d');
  if (!context) return;

  // One colour read, so the field follows the light/dark tokens instead of hard-coding a hue.
  let ink = 'rgba(95,109,94,0.10)';
  try {
    const value = getComputedStyle(document.documentElement).getPropertyValue('--mm-ink-faint').trim();
    if (value) ink = value;
  } catch {}

  let width = 1, height = 1, dots = [];
  const measure = () => {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);   // cap: keeps the fill rate low
    width = Math.max(1, canvas.clientWidth);
    height = Math.max(1, canvas.clientHeight);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    const count = Math.round(Math.min(34, Math.max(12, width * height / 46000)));
    dots = Array.from({length: count}, () => ({
      x: Math.random() * width,
      y: Math.random() * height,
      vx: (Math.random() - 0.5) * 0.09,
      vy: (Math.random() - 0.5) * 0.09,
      r: 0.8 + Math.random() * 1.1
    }));
  };
  const paint = () => {
    context.clearRect(0, 0, width, height);
    context.fillStyle = ink;
    for (const d of dots) {
      context.beginPath();
      context.arc(d.x, d.y, d.r, 0, Math.PI * 2);
      context.fill();
    }
    context.strokeStyle = ink;
    context.lineWidth = 0.6;
    for (let i = 0; i < dots.length; i++) {
      for (let j = i + 1; j < dots.length; j++) {
        const dx = dots[i].x - dots[j].x, dy = dots[i].y - dots[j].y;
        if (dx * dx + dy * dy > 14400) continue;               // beyond 120px: leave it clear
        context.beginPath();
        context.moveTo(dots[i].x, dots[i].y);
        context.lineTo(dots[j].x, dots[j].y);
        context.stroke();
      }
    }
  };
  const step = () => {
    for (const d of dots) {
      d.x += d.vx;
      d.y += d.vy;
      if (d.x < -10) d.x = width + 10;
      if (d.x > width + 10) d.x = -10;
      if (d.y < -10) d.y = height + 10;
      if (d.y > height + 10) d.y = -10;
    }
    paint();
  };
  const init = () => { measure(); paint(); };
  try {
    (window.requestIdleCallback || (fn => setTimeout(fn, 200)))(init);
  } catch { init(); }
  window.addEventListener('resize', () => {
    clearTimeout(canvas.mmResize);
    canvas.mmResize = setTimeout(init, 250);
  });
  if (reduced) return;                                         // honour the preference
  let last = 0;
  const frame = now => {
    if (document.hidden) last = now;                           // idle while hidden
    else if (now - last >= 80) { last = now; step(); }         // ~12 fps
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

/* ------------------------------------------------------------------ bootstrap */

$('knowledge-form').onsubmit = event => {
  event.preventDefault();
  run(async () => {
    $('knowledge-status').textContent = '正在查找各类来源…';
    const pack = await api('knowledge-context?query=' + encodeURIComponent($('knowledge-query').value));
    const trust = {approved: '已审核记忆', published_document: '已发布文档', unverified_transcript: '未核验会话'};
    $('knowledge-results').replaceChildren(...pack.results.map(item => {
      const card = node('article', undefined, 'card');
      card.append(node('small', trust[item.trust] || item.trust, 'muted'),
        node('p', item.content), node('small', '[' + item.reference + ']', 'muted'));
      if (item.graph_path) card.append(node('small', '关系补充：' + item.graph_path.relation, 'muted'));
      return card;
    }));
    $('knowledge-status').textContent = pack.results.length + ' 条结果 · ' + pack.stages.map(s => s.corpus + ': ' + s.mode).join(' / ')
      + (pack.rerank?.applied ? ' · Rerank 已应用' : '')
      + (pack.warning ? ' · ' + pack.warning : '')
      + (pack.warnings.length ? ' · ' + pack.warnings.map(w => w.message).join('；') : '');
    $('knowledge-context').textContent = JSON.stringify({context: pack.context, references: pack.references,
      omitted: pack.omitted, truncated: pack.truncated, stages: pack.stages, budget: pack.budget}, null, 2);
  });
};

run(async () => {
  const response = await fetch('/api/session');
  state.token = (await response.json()).token;
  await loadStatus();
  await peers();
  backdrop();
  await enterRetrieve();
});

// The agents view keeps its own heartbeat polling, untouched: this page does not change it.
setInterval(() => { if (!document.hidden) run(peers); }, 15000);
