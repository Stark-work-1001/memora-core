"""Editable recipes, resolved against available capabilities; never silently bind wrong models."""
from .errors import InvalidInput, ProviderConfigError

# (operation, preferred role). Fan-out / joins are explicit for the audit recipe.
RECIPES = (
    ('agent-distill', '智能体会话沉淀', '从归档会话提取有精确引文的长期事实、决策和经验。',
     [('retrieve', 'local'), ('extract_memories', 'curator'), ('assess_memory', 'judge'), ('verify', 'verifier')]),
    ('study-notes', '学习笔记与复习', '将学习输入整理成笔记、检索线索、复习问题与学习路径。',
     [('retrieve', 'local'), ('organize_markdown', 'documenter'), ('build_cues', 'summarizer'), ('learning_plan', 'documenter'), ('verify', 'verifier')]),
    ('document-knowledge', '外部文档知识化', '保留原文来源，提取事实与层级，生成可审核的 Markdown 草稿。',
     [('classify', 'classifier'), ('extract_memories', 'curator'), ('organize_markdown', 'documenter'), ('verify', 'verifier')]),
    ('hybrid-recall', '混合召回与重排序', '全文、向量和显式关系召回，Rerank 排序后按证据归纳。',
     [('retrieve', 'local'), ('rerank', 'rerank'), ('summarize', 'summarizer'), ('verify', 'verifier')]),
    ('conflict-audit', '冲突与来源审计', '并行评估质量和关系，再汇合核验；提出冲突而不覆盖历史事实。',
     [('retrieve', 'local'), ('assess_memory', 'judge'), ('extract_relations', 'relation'), ('verify', 'verifier')]),
    ('project-recap', '项目决策与经验复盘', '从已有证据整理决定、适用条件、失败原因与可复用步骤。',
     [('retrieve', 'local'), ('summarize', 'summarizer'), ('extract_memories', 'curator'), ('organize_markdown', 'documenter'), ('verify', 'verifier')]),
    ('abstract-cues', '细节与抽象线索', '保留来源细节，另建主题摘要、别名与问题线索，便于下一次召回。',
     [('retrieve', 'local'), ('build_cues', 'summarizer'), ('organize_markdown', 'documenter'), ('verify', 'verifier')]),
    ('index-maintenance', '增量索引维护', '用指定 Embedding 模型索引已审核记忆与已发布文档；原稿仍保留。',
     [('embed_index', 'embedding')]),
)


def catalog(runtime):
    registry = runtime.model_registry
    value = registry.snapshot()
    models = registry.profiles()
    chat = [p['id'] for p in value['models'] if p.get('capability', 'chat') == 'chat']
    fallback = chat[0] if chat else ('builtin-judge' if 'builtin-judge' in models else None)
    out = []
    for ident, title, description, steps in RECIPES:
        nodes, missing = [], []
        for index, (operation, role) in enumerate(steps):
            if role in ('embedding', 'rerank', 'local'):
                pid = 'builtin-' + ('retrieval' if role == 'local' else role)
                if pid not in models:
                    pid = next((p['id'] for p in models.values() if p.get('capability') == role), None)
            elif role == 'judge': pid = 'builtin-judge' if 'builtin-judge' in models else fallback
            else: pid = value['bindings'].get(role) or fallback
            if not pid: missing.append(role)
            nodes.append({'id': str(index + 1), 'operation': operation, 'model': pid or '',
                'instruction': '', 'x': 40 + index * 300, 'y': 80})
        edges = [{'from': str(i), 'to': str(i + 1)} for i in range(1, len(nodes))]
        if ident == 'conflict-audit':
            edges = [{'from': '1', 'to': '2'}, {'from': '1', 'to': '3'}, {'from': '2', 'to': '4'}, {'from': '3', 'to': '4'}]
            nodes[2]['x'], nodes[2]['y'] = 340, 280
            nodes[3]['x'] = 640
        out.append({'id': ident, 'title': title, 'description': description, 'nodes': nodes, 'edges': edges,
                    'ready': not missing, 'missing_roles': sorted(set(missing)),
                    'verification': registry.describe()['verification']})
    return out


def install(runtime, project, template, bindings=None):
    recipe = next((r for r in catalog(runtime) if r['id'] == template), None)
    if recipe is None: raise InvalidInput('unknown workflow template')
    if bindings is not None and (not isinstance(bindings, dict) or any(n not in {s['id'] for s in recipe['nodes']} for n in bindings)):
        raise InvalidInput('template bindings must map node ids to model profile ids')
    for node in recipe['nodes']:
        node['model'] = (bindings or {}).get(node['id'], node['model'])
    if any(not n['model'] for n in recipe['nodes']):
        raise ProviderConfigError('configure template models: ' + ', '.join(recipe['missing_roles']))
    return runtime.control.save_workflow({'project': project, 'title': recipe['title'],
        'nodes': recipe['nodes'], 'edges': recipe['edges']}, runtime.profiles)
