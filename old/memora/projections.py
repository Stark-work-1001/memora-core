"""Shared read projections for the retained 2D/3D brain components."""
from . import sessions
from .store import scope


def brain(runtime, project):
    """Two read projections; relationships always come from stored edges, never a layout guess."""
    project = scope(project)
    graph = runtime.store.graph(project, limit=400, include_user=True)
    nodes = graph['nodes']
    def clean(s):
        return ''.join(c if c.isalnum() or c in ' -_，。、' else ' ' for c in str(s)).strip()
    labels = {m['id']: clean(m['content'].splitlines()[0])[:20] + ' ' + m['id'][:8] for m in nodes}
    links = {}
    for edge in graph['edges']:
        if edge['a'] in labels and edge['b'] in labels:
            links.setdefault(edge['a'], []).append((edge['b'], edge['relation']))
    dictionary = ['# Memora · 词义与记忆关系', '这里的连线是明确存储的关系，空间距离不是语义置信度。']
    outline = ['# Memora · ' + project]
    categories = {'fact': '事实与词义', 'knowledge': '知识库', 'preference': '用户习惯',
                  'decision': '项目决策', 'procedure': '工具与步骤', 'lesson': '经验教训'}
    for category, title in categories.items():
        group = [m for m in nodes if m['category'] == category]
        if not group: continue
        dictionary.append('## ' + title); outline.append('## ' + title)
        for m in group:
            label = labels[m['id']]
            # Quote source content: its Markdown cannot forge a term or hierarchy in this projection.
            body = '\n'.join('> ' + line.replace('[', '［').replace(']', '］') for line in m['content'].splitlines())
            provenance = '\n'.join('> 来源：' + line.replace('[', '［').replace(']', '］') for line in m['source'].splitlines())
            dictionary.extend(['### ' + label, body, '\n记忆 ID：' + m['id'], provenance])
            for target, relation in links.get(m['id'], []):
                dictionary.append(relation + ' → [[' + labels[target] + ']]')
            # The copied outline parser requires notes immediately after the heading.
            outline.append('### ' + label + '\n' + body + '\n> 记忆 ID：' + m['id'] + '\n' + provenance)
            for target, relation in links.get(m['id'], []):
                outline.append('关联：' + relation + ' → [[' + labels[target] + ']]')
    hierarchy=[h for h in runtime.control.hierarchy(project) if h['parent'] in labels and h['child'] in labels]
    if hierarchy:
        outline.append('## 显式层级与学习路径')
        # Bounded projection: keep the database DAG intact; repeated descendants are references.
        children={};descendants=set()
        for h in hierarchy:
            children.setdefault(h['parent'],[]).append(h);descendants.add(h['child'])
        seen=set();node_by_id={m['id']:m for m in nodes}
        def branch(ident,depth):
            if ident in seen or depth>5:
                outline.append('> 继续查看：[['+labels[ident]+']]');return
            seen.add(ident);outline.append('#'*depth+' '+labels[ident]+'\n> 记忆 ID：'+ident+'\n> '+node_by_id[ident]['content'].replace('\n','\n> '))
            for h in children.get(ident,[]):
                outline.append('> '+h['kind']+'：'+h['evidence'].replace('\n',' '));branch(h['child'],depth+1)
        for root_id in children:
            if root_id not in descendants:branch(root_id,3)
        for root_id in children:
            if root_id not in seen:branch(root_id,3)
    archives = sessions.list_sessions(runtime.store, project, limit=40)
    if archives:
        outline.append('## 多智能体对话档案')
        agents = sorted({a['agent'] for a in archives})
        for agent_name in agents:
            outline.append('### ' + clean(agent_name))
            for a in archives:
                if a['agent'] == agent_name:
                    outline.append('#### ' + clean(a['title'] or a['external_id'] or a['id'])[:80])
                    outline.append(f"会话 ID：{a['id']} · {a['turns']} 条消息")
    document_versions = runtime.documents.list(project)
    if document_versions:
        outline.append('## Markdown 文档库')
        for d in document_versions:
            revision = runtime.documents.read(project, d['slug'], d['audience'], d['version'])
            excerpt = revision['content'][:4000]
            quoted = '\n'.join('> ' + line.replace('[', '［').replace(']', '］') for line in excerpt.splitlines())
            outline.append('### ' + clean(d['title'])[:40] + ' · ' + d['audience'] + ' v' + str(d['version']) + '\n'
                + '> 文档用途：' + d['audience'] + '；文档版本不表示已审核记忆。\n'
                + '> 文档标识：' + d['slug'] + '\n> 文档 ID：' + d['id'] + '\n' + quoted
                + ('\n> 预览已截断；完整版本见 Markdown 文档库。' if len(revision['content']) > 4000 else ''))
    if not nodes: dictionary.extend(['## 开始积累', '### 还没有已审核的记忆', '添加知识并审核后，真实条目和关联会在这里出现。'])
    if len(outline) == 1: outline.extend(['## 开始积累', '### 添加知识或导入对话'])
    return {'dictionary': '\n\n'.join(dictionary), 'outline': '\n\n'.join(outline),
            'nodes': len(nodes), 'truncated': graph.get('truncated', False)}

