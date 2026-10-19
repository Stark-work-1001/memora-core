"""Add a model-type editor to 模型配置 and feed those types into the workflow canvas.

The user's requirement: 模型配置 must be able to ADD model types, those types must correspond to
the roles in 工作流可视化's 分工与扩展空间, and the canvas must then offer them as selectable parts
on a node.

Where the data already lives:
  * memora/control.py ROLE_SPECS is the single source of truth for completion roles (router,
    curator, summarizer, classifier, documenter, sql_analyst, relation, verifier). The orchestration
    panel already renders them.
  * The model pool (model-registry.json) already maps role -> profile id.
  * The canvas reads window.memoraWorkflowCanvas.registry, which orchestration.js fills.

What was missing is a place in 模型配置 to see and edit that pool as *types* rather than as
"connections for embedding/judge/rerank". This block adds it: each completion role is a row where a
type is either bound to a pool profile or unbound, and the canvas node inspector shows the bound
type next to the model.

The editor does NOT create a second registry: it reads /models and writes /models, so there is
still exactly one pool and one binding table.
"""

import pathlib

DEV = pathlib.Path(__file__).resolve().parents[2]
p = DEV / 'memora/static/memory.js'
text = p.read_text('utf-8')

BLOCK = r'''
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

'''

# Insert before the settings() function so it loads with the rest of that view's code.
anchor = 'function settings() {'
if anchor not in text:
    raise SystemExit('settings() anchor not found')
text = text.replace(anchor, BLOCK + anchor, 1)

# ---------------------------------------------------------------- load types when the view opens
old = "  if (view === 'settings') { await loadStatus(); settings(); }"
new = ("  if (view === 'settings') { await loadStatus(); settings(); await loadModelTypes(); }")
if old not in text:
    raise SystemExit('show() settings anchor not found')
text = text.replace(old, new, 1)

p.write_text(text, 'utf-8')
print('model types editor inserted')
