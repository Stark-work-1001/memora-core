'use strict';
/* Workflow orchestration, part 1: the model pool, role bindings and accumulation policy.
 *
 * This file used to inject its own <button data-view="workflows"> into the sidebar and its own
 * <section class="view"> into <main>. That produced a working view that was impossible to discover
 * and, worse, sat next to a SEPARATE top-level page (/dag/) whose sidebar vanished on navigation.
 * The shell now owns both the nav entry (#07 工作流可视化) and the <section id="workflows">; this
 * file only fills the panels it was always about, and dag-embed.js fills the canvas half.
 *
 * Load order: memory.js defines titles/state/node/$/run/show; this file runs second and only
 * extends them. Nothing here re-implements the view switcher.
 */

titles.workflows = '工作流可视化';

/* The section already exists in memory.html. Building the panel markup here keeps the HTML shell
 * small and guarantees the ids this file queries are the ids it creates.
 *
 * Order matters: the canvas is the primary instrument of this view, so it gets a dedicated mount
 * point directly under the intro and everything else (connection state, policy, role bindings,
 * model pool, job records) reads as supporting detail below it. dag-embed.js fills
 * #workflow-canvas-slot; it does not append to #workflow-visual, which is why the canvas used to
 * land under every panel. */
const workflowVisual = $('workflow-visual');
workflowVisual.innerHTML = `
<div class="wv-intro">
  <div>
    <p class="eyebrow">WORKFLOW / 工作流可视化</p>
    <p class="muted">在画布上把「操作 → 模型 → 提示词」连成有向图；每个节点是一次有界模型调用，结果保留输入版本与日期，产出新草稿。不执行模型生成的 SQL 或脚本。</p>
  </div>
  <div class="row"><button id="refresh-orchestration">刷新状态</button></div>
</div>

<!-- The canvas mounts here, at the top of the view. Filled by dag-embed.js. -->
<div id="workflow-canvas-slot"></div>

<article class="panel">
  <h2>真实模型连接</h2>
  <div class="row"><button type="button" id="probe-models">重新探测</button></div>
  <div id="inference-health" class="cards"></div>
  <p class="muted" id="inference-health-note">连接状态来自服务端对<strong>已保存配置</strong>的实时观测：embedding / judge / rerank 每个角色一次真实最小调用（/embeddings、/chat/completions、/rerank）。这是探测那一刻的结果，不是缓存承诺；处理记录保留每个阶段使用的模型。</p>
</article>

<div class="two-column">
  <article class="panel">
    <h2>自动积累策略</h2>
    <form id="policy-form">
      <label class="row"><input type="checkbox" id="policy-auto">对通过判定与核验的持久记忆自动沉淀</label>
      <label class="row"><input type="checkbox" id="policy-verify" checked>要求来源核验</label>
      <label>最低重要性（评分不是概率）<input type="number" id="policy-importance" min="0" max="1" step="0.05" value="0.65"></label>
      <button>保存策略</button>
    </form>
    <p class="muted">短期信息、敏感内容、指令风险与判定失败留在待审队列。模型不可用时任务可恢复。</p>
  </article>
  <article class="panel">
    <h2>分工与扩展空间</h2>
    <p class="muted">为提炼、摘要、分类、关系和核验分配模型。独立核验应使用不同于提炼侧的模型；Embedding 负责编码，Rerank 负责相关性排序。</p>
    <p class="muted" id="verification-independence"></p>
    <div id="role-bindings"></div>
  </article>
</div>

<details class="panel">
  <summary>编辑模型池与角色绑定</summary>
  <form id="registry-form">
    <div id="registry-profiles" class="cards"></div>
    <div class="row"><button type="button" id="add-registry-model">新增模型</button><button class="primary">保存模型池与分工</button></div>
  </form>
</details>

<div class="section-title"><h3>会话积累任务</h3></div><div id="accumulation-jobs" class="cards"></div>
<div class="section-title"><h3>工作流运行记录</h3></div><div id="orchestration-runs" class="cards"></div>
`;

let orchestrationRegistry = {models: [], bindings: {}, roles: {}, operations: []};
let orchestrationDocuments = [];

// Shared empty state: icon slot + primary line + muted hint (.empty-state in memory.css).
// Only fills a container that rendered nothing, so real results are never overwritten.
function renderEmptyState(target, primary, hint, icon) {
  if (!target || target.childElementCount) return;
  const box = node('div', undefined, 'empty-state');
  const mark = node('span', icon || '◇', 'empty-state-icon');
  mark.setAttribute('aria-hidden', 'true');
  box.append(mark, node('p', primary, 'empty-state-primary'));
  if (hint) box.append(node('p', hint, 'empty-state-hint'));
  target.append(box);
}

function modelSelect(selected) {
  const select = node('select');
  for (const p of orchestrationRegistry.models.filter(p => !p.capability || p.capability === 'chat')) {
    const o = node('option', p.name + ' · ' + p.model);
    o.value = p.id;
    o.selected = p.id === selected;
    select.append(o);
  }
  return select;
}

function renderRoleBindings() {
  const area = $('role-bindings');
  area.replaceChildren();
  for (const [role, detail] of Object.entries(orchestrationRegistry.roles)) {
    if (role === 'embedding' || role === 'judge' || role === 'rerank') continue;
    const l = node('label', detail.title + ' · ' + detail.description);
    const s = modelSelect(orchestrationRegistry.bindings[role]);
    s.dataset.role = role;
    const none = node('option', '未绑定');
    none.value = '';
    s.prepend(none);
    s.value = orchestrationRegistry.bindings[role] || '';
    l.append(s);
    area.append(l);
  }
}

function registryProfile(p = {}) {
  const card = node('article', undefined, 'card');
  card.dataset.profile = '1';
  const row = node('div', undefined, 'row');
  for (const [key, title] of [['id', '标识'], ['name', '名称'], ['model', '模型名称']]) {
    const l = field(title, 'registry-' + crypto.randomUUID(), p[key]);
    l.querySelector('input').dataset.field = key;
    row.append(l);
  }
  card.append(row);
  const endpoint = node('div', undefined, 'row');
  const kind = node('select');
  kind.dataset.field = 'kind';
  for (const [value, title] of [['openai', 'OpenAI 兼容 / 本地或云端'], ['ollama', 'Ollama 原生 / 本地']]) {
    const option = node('option', title);
    option.value = value;
    kind.append(option);
  }
  if (p.kind === 'gguf') {
    const option = node('option', '现有 GGUF 源码后端');
    option.value = 'gguf';
    kind.append(option);
  }
  kind.value = p.kind || 'openai';
  endpoint.append(kind);
  const capability = node('select');
  capability.dataset.field = 'capability';
  capability.setAttribute('aria-label', '模型能力');
  for (const [value, title] of [['chat', '生成 / Judge'], ['embedding', 'Embedding 向量'], ['rerank', 'Rerank 重排']]) {
    const option = node('option', title); option.value = value; capability.append(option);
  }
  capability.value = p.capability || 'chat'; endpoint.append(capability);
  for (const [key, title] of [['base', 'API 地址'], ['key_env', '密钥环境变量名']]) {
    const l = field(title, 'registry-' + crypto.randomUUID(), p[key]);
    l.querySelector('input').dataset.field = key;
    endpoint.append(l);
  }
  const remote = node('label', '云端 HTTPS 接入'), check = node('input');
  check.type = 'checkbox';
  check.checked = p.remote === true;
  check.dataset.field = 'remote';
  remote.prepend(check);
  endpoint.append(remote);
  card.append(endpoint);
  card.append(button('移除此模型', async () => card.remove()));
  return card;
}

function traceCard(title, detail, extra) {
  const card = node('article', undefined, 'card');
  card.append(node('h3', title), node('p', detail, 'muted'));
  const details = node('details');
  details.append(node('summary', '查看阶段、模型与结果'), node('pre', JSON.stringify(extra, null, 2)));
  card.append(details);
  return card;
}

/* ---------------------------------------------------------------- 真实模型连接
 *
 * The panel used to render a fixed pair of pills from a hardcoded ternary
 * (`role === 'embedding' ? 'Embedding' : role === 'rerank' ? 'Rerank' : 'Judge'`), which meant:
 *   - rerank never appeared, because memora/core.py::model_health() did not walk it;
 *   - a role the backend later added would be mislabelled Judge instead of shown by its id;
 *   - an unconfigured role vanished entirely, so "not configured" was indistinguishable from
 *     "this product has no such role".
 *
 * The panel is now entirely data-driven from two routes:
 *   GET  /api/agent/model-health   cheap reachability per role (GET /models): does the endpoint
 *                                  answer and does it advertise the configured model id?
 *   POST /api/agent/model-probe    the real thing: one minimal inference per role. Slower, so it
 *                                  runs only when the user clicks 重新探测 (or when the panel is
 *                                  painted for the first time after a save).
 * Titles come from a mapping with the role id as the fallback, never from a fixed list, so a new
 * role is displayed correctly with no edit here. A probe result is an OBSERVATION with a
 * timestamp, so it is never written back into any state that outlives the view. */

const ROLE_TITLES = {embedding: 'Embedding · 向量模型', judge: 'Judge · 判定模型',
                     rerank: 'Rerank · 重排序模型'};
const ROLE_ENDPOINTS = {embedding: '/embeddings', judge: '/chat/completions', rerank: '/rerank'};
const ROLE_ORDER = ['embedding', 'judge', 'rerank'];
// Mirrors memora/core.py PROBE_TIMEOUT: the server caps a probe at this many seconds, and the
// page must not imply a bigger budget than the server actually gives it.
const PROBE_CEILING_HINT = '15';

/** Roles in a stable order (known ones first, then whatever else the server reports). */
function orderedRoles(keys) {
  const seen = new Set();
  const out = [];
  for (const role of ROLE_ORDER) if (keys.indexOf(role) >= 0) { seen.add(role); out.push(role); }
  for (const role of keys.slice().sort()) if (!seen.has(role)) out.push(role);
  return out;
}

/** One probe observation per role keyed by role name, or null when nothing was probed yet. */
let probeState = null;
let probeBusy = false;

function probeVerdict(health, probe) {
  if (probe) {
    if (probe.ok === true) return {label: '已连通', cls: 'pill is-ok'};
    if (probe.ok === null) return {label: '进程内后端（不探测）', cls: 'pill'};
    if (probe.configured === false) return {label: '未配置', cls: 'pill'};
    return {label: '不可用', cls: 'pill is-warn'};
  }
  if (!health || health.configured === false) return {label: '未配置', cls: 'pill'};
  if (health.reachable === null) return {label: '进程内后端（不探测）', cls: 'pill'};
  if (health.reachable) return {label: '端点可达', cls: 'pill is-ok'};
  return {label: '不可达', cls: 'pill is-warn'};
}

/** The body lines: what was actually observed, with the numbers, and why it failed when it did. */
function probeDetail(role, health, probe) {
  const h = health || {};
  const p = probe || null;
  const facts = [];
  const model = (p && p.model) || h.model || '';
  if (model) facts.push('模型 ' + model);
  const latency = p && p.latency_ms !== undefined && p.latency_ms !== null ? p.latency_ms : h.latency_ms;
  if (latency !== undefined && latency !== null) facts.push(latency + 'ms');
  if (p && p.http_status) facts.push('HTTP ' + p.http_status);
  if (p && p.vector_dim) facts.push(p.vector_dim + ' 维');
  if (p && p.reply_chars !== undefined) facts.push(p.reply_chars + ' 字符回复');
  if (p && p.scored !== undefined) facts.push(p.scored + ' 条打分');
  // The /models listing is only evidence when there was no real call. Once a probe ran, the call
  // itself is the stronger proof: a provider that omits an id from GET /models while serving it is
  // common, and repeating "model not advertised" next to "已连通" would read as a contradiction.
  if (!p) {
    if (h.advertised === true) facts.push('模型在 /models 列表中');
    else if (h.advertised === false) facts.push('模型未在 /models 列表中');
  }
  const probedAt = (p && p.probed_at) || h.probed_at;
  if (probedAt) facts.push('探测于 ' + stamp(probedAt));
  // Named `out`, not `lines`: memory.js exports a `lines(...)` join helper and shadowing it here
  // would silently change what a later edit in this function could call.
  const out = [];
  if (facts.length) out.push(facts.join(' · '));
  if (p && p.error) out.push('原因：' + p.error + (p.http_status ? '（HTTP ' + p.http_status + '）' : ''));
  else if (!p && h.error) out.push('原因：' + h.error);
  if (!p) {
    out.push('尚未发起真实调用：点“重新探测”对已保存配置各做一次最小推理。');
  } else if (p.ok === true) {
    out.push('已真实调用 ' + (ROLE_ENDPOINTS[role] || '该角色的端点') + '，使用服务端已保存的配置。');
  } else if (p.ok === null || p.kind === 'in-process') {
    // An in-process backend (sentence-transformers, llama-cpp) has no HTTP endpoint, so there is
    // nothing to probe. That is neither a success nor a failure, and must not read as one.
    out.push('进程内后端没有 HTTP 端点可探测：它随进程加载，不使用网络；连通性以检索/判定的实际结果为准。');
  } else if (p.timeout === true) {
    // A timeout is not the same finding as a rejection: the endpoint answered the health check and
    // the model was simply cold (a large reranker can need >10 s on its first call). Say so, and
    // say the action: probe again. Never claim it worked.
    out.push('这次调用超时（服务端上限 ' + PROBE_CEILING_HINT + 's）：端点未必有问题，'
      + '大模型首次调用可能很慢，稍后再点一次“重新探测”。');
  }
  return out;
}

function probeCard(role, health, probe) {
  const verdict = probeVerdict(health, probe);
  const card = node('article', undefined, 'card' + (verdict.label === '已连通' ? ' is-online' : ''));
  const head = node('div', undefined, 'row');
  head.append(node('h3', ROLE_TITLES[role] || role), node('span', verdict.label, verdict.cls));
  card.append(head);
  for (const text of probeDetail(role, health, probe)) card.append(node('p', text, 'muted'));
  return card;
}

/** Paint #inference-health from the health payload plus the last probe, if any. */
function paintInferenceHealth(health) {
  const host = $('inference-health');
  if (!host) return;
  const sources = health || {};
  const probed = (probeState && probeState.roles) || {};
  const roles = orderedRoles(Array.from(new Set(
    Object.keys(sources).concat(Object.keys(probed)))));
  host.replaceChildren(...roles.map(role => probeCard(role, sources[role], probed[role] || null)));
  renderEmptyState(host, '尚未探测到推理模型。',
    '模型配置里保存接入后，这里按角色显示连通状态、模型、延迟与探测时间。', '◎');
  const note = $('inference-health-note');
  if (note) {
    const when = probeState && probeState.probed_at ? ' 最近一次真实探测：' + stamp(probeState.probed_at) + '。' : '';
    note.textContent = '连接状态来自服务端对已保存配置的实时观测：每个角色一次真实最小调用'
      + '（embedding → /embeddings、judge → /chat/completions、rerank → /rerank），'
      + '不是缓存承诺。' + when;
  }
}

/** POST model-probe and repaint. Kept out of loadOrchestration: a probe costs real tokens. */
async function probeModels(button) {
  if (probeBusy) return null;
  probeBusy = true;
  if (button) button.disabled = true;
  const host = $('inference-health');
  if (host) host.setAttribute('aria-busy', 'true');
  try {
    probeState = await api('model-probe', {});
    paintInferenceHealth(orchestrationHealth);
    const roles = (probeState && probeState.roles) || {};
    const ok = Object.keys(roles).filter(role => roles[role] && roles[role].ok === true);
    const configured = Object.keys(roles).filter(role => roles[role] && roles[role].configured !== false);
    notice('真实探测完成：' + ok.length + '/' + configured.length + ' 个已配置角色连通'
      + (ok.length ? '（' + ok.map(role => ROLE_TITLES[role] || role).join('、') + '）' : '') + '。');
    return probeState;
  } catch (error) {
    notice('探测请求失败：' + (error && error.message ? error.message : error));
    return null;
  } finally {
    probeBusy = false;
    if (button) button.disabled = false;
    if (host) host.removeAttribute('aria-busy');
  }
}

async function loadOrchestration() {
  const [registry, policy, health, jobs, workflows, runs] = await Promise.all([
    api('models'), api('accumulation-policy'), api('model-health'), api('jobs'),
    api('workflows'), api('workflow-runs')
  ]);
  orchestrationRegistry = registry;
  $('verification-independence').textContent = registry.verification?.warning || '已为提炼与核验绑定不同模型；仍需核查来源和结果。';

  // The panel reads health here and the last probe result on every repaint, so a refresh never
  // erases an observation it did not make: 'stale' is shown by its probed_at, not by forgetting it.
  orchestrationHealth = health || {};
  paintInferenceHealth(orchestrationHealth);

  $('policy-auto').checked = policy.auto_consolidate;
  $('policy-verify').checked = policy.verify;
  $('policy-importance').value = policy.minimum_importance;

  renderRoleBindings();
  renderEmptyState($('role-bindings'), '暂无可分配的角色。', '保存模型池后，除 Embedding 与 Judge 外的角色会在这里列出。', '◈');
  $('registry-profiles').replaceChildren(...registry.models.map(registryProfile));
  renderEmptyState($('registry-profiles'), '模型池为空。', '点击“新增模型”添加本地或云端接入，也可以直接用环境变量连接。', '⬡');

  renderProcessing(jobs.items, runs.items);

  // The canvas half lives in dag-embed.js; tell it the shared vocabularies so its inspector can
  // offer the same operation names and model ids instead of free-text guesses, and so a brand-new
  // node starts on a model the backend will accept.
  if (window.memoraWorkflowCanvas && typeof window.memoraWorkflowCanvas.setRegistry === 'function') {
    window.memoraWorkflowCanvas.setRegistry({
      operations: registry.operations || [],
      models: registry.workflow_models || registry.models || [],
      bindings: registry.bindings || {},
      // Role titles travel with the pool so a node can name its model TYPE. Without them the
      // canvas only knew profile ids, and two roles sharing one profile were indistinguishable.
      roles: registry.roles || {},
      workflows: workflows.items || [],
      runs: runs.items || []
    });
  }
}

/** The last health payload, kept so a probe repaint does not need to re-read it. */
let orchestrationHealth = {};

function renderProcessing(jobs, runs) {
  $('accumulation-jobs').replaceChildren(...jobs.map(j => {
    const c = traceCard(j.input.title || j.id, j.status + ' · 尝试 ' + j.attempts + ' · ' + j.created + (j.error ? ' · ' + j.error : ''), j.output);
    if (['failed', 'retry'].includes(j.status)) {
      c.append(button('重试', async () => { await api('job-retry', {id: j.id}); await refreshProcessing(); }));
    }
    return c;
  }));
  renderEmptyState($('accumulation-jobs'), '尚无积累任务。', '连接智能体后，通过 memory_absorb 接收会话。', '◷');
  $('orchestration-runs').replaceChildren(...runs.map(r => traceCard(r.workflow, r.status + ' · ' + r.updated, r.output)));
  renderEmptyState($('orchestration-runs'), '暂无工作流运行记录。', '在画布上启动一次运行后，这里记录状态、阶段与结果。', '◇');
}

async function refreshProcessing() {
  const [jobs, runs] = await Promise.all([api('jobs'), api('workflow-runs')]);
  renderProcessing(jobs.items, runs.items);
}

/* The view hook: memory.js calls state.onView(view) after switching. dag-embed.js wraps this so
 * both halves refresh, so this assignment must happen before that file loads. */
state.onView = async view => { if (view === 'workflows') await loadOrchestration(); };

$('refresh-orchestration').onclick = () => run(loadOrchestration);
// A real probe is a separate, explicit action: it calls every configured endpoint with a minimal
// inference, so it costs tokens and up to PROBE_TIMEOUT seconds. It must never be hidden inside a
// refresh, which only reads GET /models.
$('probe-models').onclick = () => run(() => probeModels($('probe-models')), $('probe-models'));
$('add-registry-model').onclick = () => { $('registry-profiles').append(registryProfile()); };

$('registry-form').onsubmit = e => {
  e.preventDefault();
  run(async () => {
    const models = [...$('registry-profiles').querySelectorAll('[data-profile]')].map(card => {
      const prior = orchestrationRegistry.models.find(p => p.id === card.querySelector('[data-field=id]').value.trim());
      const p = {...prior, kind: 'openai'};
      for (const input of card.querySelectorAll('[data-field]')) {
        p[input.dataset.field] = input.type === 'checkbox' ? input.checked : input.value.trim();
      }
      return p;
    });
    const bindings = {};
    for (const select of $('role-bindings').querySelectorAll('[data-role]')) {
      bindings[select.dataset.role] = select.value || null;
    }
    await api('models', {registry: {models, bindings}});
    await loadOrchestration();
    notice('已保存模型池与角色绑定；新增模型可在此分配到各角色。');
  }, e.submitter);
};

$('policy-form').onsubmit = e => {
  e.preventDefault();
  run(async () => {
    await api('accumulation-policy', {
      policy: {
        auto_consolidate: $('policy-auto').checked,
        verify: $('policy-verify').checked,
        minimum_importance: Number($('policy-importance').value)
      }
    });
    notice('已保存积累策略。');
  }, e.submitter);
};

// Poll the run/job lists only while this view is on screen, and never in a hidden tab.
setInterval(() => {
  if (state.view === 'workflows' && !document.hidden) run(refreshProcessing);
}, 4000);
