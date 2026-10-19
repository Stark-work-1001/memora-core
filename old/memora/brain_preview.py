"""Read-only demo graph for the brain view when a project has no memories yet.

WHY THIS EXISTS
---------------
The packaged desktop app ships a clean `data/` template (no memories), so 脑图 renders a single
placeholder node and there is nothing to look at. A user opening the app for the first time cannot
tell whether the semantic graph works at all -- and the spatial animation, edge colours and category
grouping are the part of this feature that has to be seen to be understood.

WHAT IT IS NOT
--------------
It is not memory. These nodes are literal constants in this file. They are never written to
SQLite, never indexed, never returned by recall/rag, and never counted in any status number. The
endpoint that serves them refuses once the project has approved memories, so real data always wins
and a preview can never be mistaken for it.

That separation is the whole point: a memory product that seeds fake rows to look good has broken
the one promise it makes.
"""

# Hand-written sample graph. Categories match memora's real ones (fact/knowledge/preference/
# decision/procedure/lesson) so the canvas exercises the same colour logic as real data, and
# relations match the stored vocabulary (supports/contradicts/supersedes/related + hierarchy kinds).
NODES = [
    # ── cluster 1: 分区与检索（decision / fact） ───────────────────────────────
    {'id': 'preview-0001-4a7e', 'label': '记忆按四级分区', 'category': 'decision',
     'content': '记忆按「全局 / 工作区 / 项目 / 对话」四级分区检索，更窄的级别也包含更宽的事实。'},
    {'id': 'preview-0004-4a7e', 'label': '检索保留来源与日期', 'category': 'fact',
     'content': '每条检索结果都带来源、日期与真实检索方式（词法 / 向量 / 混合）。'},
    {'id': 'preview-0005-4a7e', 'label': '两种分数不可直接比较', 'category': 'lesson',
     'content': 'BM25 相关度与向量相似度量纲不同，不能直接相加或跨方式比较名次。'},
    {'id': 'preview-0011-4a7e', 'label': '对话级别只看本次会话', 'category': 'fact',
     'content': '「对话」级别把项目记忆按 session_id 收窄，更宽的三级仍然可见。'},

    # ── cluster 2: 交付与端口（decision） ─────────────────────────────────────
    {'id': 'preview-0002-4a7e', 'label': '开发与独立版分端口', 'category': 'decision',
     'content': '开发用 8765、独立版用 18765，两者可同时运行，各自持有独立的数据目录。'},
    {'id': 'preview-0003-4a7e', 'label': '发布包解压即用', 'category': 'decision',
     'content': '发布包必须是解压即可运行的单目录应用，不写注册表，不依赖外部运行时。'},
    {'id': 'preview-0012-4a7e', 'label': '产品目录与开发目录分离', 'category': 'decision',
     'content': '打包产物放在仓库外，构建不会覆盖用户正在运行的那一份。'},

    # ── cluster 3: 沉淀流程（procedure） ──────────────────────────────────────
    {'id': 'preview-0007-4a7e', 'label': '确认后才进入长期检索', 'category': 'procedure',
     'content': '候选记忆先入待审队列，经 Judge 分类并由人确认后才参与长期检索。'},
    {'id': 'preview-0008-4a7e', 'label': '模型不可用时降级', 'category': 'procedure',
     'content': '判定模型不可用时退回规则分类，检索退回词法，并在界面上明示降级。'},
    {'id': 'preview-0010-4a7e', 'label': '同源事件幂等', 'category': 'fact',
     'content': '同一来源同一事件 id 的重复提交会去重，重试是安全的。'},
    {'id': 'preview-0013-4a7e', 'label': '抽取失败可重试', 'category': 'procedure',
     'content': '抽取任务失败保留原记录，修好模型后重试即可，不需要重新导入。'},

    # ── cluster 4: 偏好与经验（preference / lesson） ──────────────────────────
    {'id': 'preview-0006-4a7e', 'label': '偏好中文简洁回答', 'category': 'preference',
     'content': '用户偏好中文、简洁、结论先行的回答；Markdown 笔记保留原始记录日期。'},
    {'id': 'preview-0009-4a7e', 'label': '过度抽象易丢证据', 'category': 'lesson',
     'content': '把多条记忆过早合并成一句结论会丢掉每条的来源，事后无法核对。'},
    {'id': 'preview-0014-4a7e', 'label': '拒绝不可维护的改造', 'category': 'preference',
     'content': '超出使用者理解与维护范围的方案不做；必要时刻意选择原生机制。'},
]

# (source, target, relation). Dense INSIDE each cluster (so each draws as a real structure), and a
# few bridges BETWEEN clusters (so the graph is one component rather than four islands).
EDGES = [
    # cluster 1 internals
    ('preview-0001-4a7e', 'preview-0004-4a7e', 'supports'),
    ('preview-0001-4a7e', 'preview-0005-4a7e', 'supports'),
    ('preview-0001-4a7e', 'preview-0011-4a7e', 'part_of'),
    ('preview-0011-4a7e', 'preview-0004-4a7e', 'related'),
    ('preview-0005-4a7e', 'preview-0004-4a7e', 'related'),

    # cluster 2 internals
    ('preview-0002-4a7e', 'preview-0003-4a7e', 'related'),
    ('preview-0003-4a7e', 'preview-0012-4a7e', 'supports'),
    ('preview-0002-4a7e', 'preview-0012-4a7e', 'prerequisite'),

    # cluster 3 internals
    ('preview-0007-4a7e', 'preview-0010-4a7e', 'prerequisite'),
    ('preview-0007-4a7e', 'preview-0008-4a7e', 'related'),
    ('preview-0008-4a7e', 'preview-0013-4a7e', 'related'),
    ('preview-0013-4a7e', 'preview-0010-4a7e', 'supports'),

    # cluster 4 internals
    ('preview-0006-4a7e', 'preview-0014-4a7e', 'related'),
    ('preview-0009-4a7e', 'preview-0006-4a7e', 'related'),
    ('preview-0014-4a7e', 'preview-0009-4a7e', 'supports'),

    # bridges: the four groups are one memory, not four islands
    ('preview-0001-4a7e', 'preview-0007-4a7e', 'prerequisite'),
    ('preview-0002-4a7e', 'preview-0006-4a7e', 'related'),
    ('preview-0009-4a7e', 'preview-0001-4a7e', 'contradicts'),
    ('preview-0003-4a7e', 'preview-0008-4a7e', 'related'),
    ('preview-0005-4a7e', 'preview-0009-4a7e', 'supports'),
    ('preview-0010-4a7e', 'preview-0004-4a7e', 'supports'),
]

# Explicit hierarchy, which the outline view and the 3D grouping both read. The real projection
# renders these as "关联：kind → [[child]]" lines and as a nested branch under the parent.
HIERARCHY = [
    ('preview-0001-4a7e', 'preview-0011-4a7e', 'part_of', '对话级别是分区方案的一部分'),
    ('preview-0007-4a7e', 'preview-0008-4a7e', 'sequence', '先判定，再决定降级到规则分类'),
    ('preview-0007-4a7e', 'preview-0013-4a7e', 'sequence', '失败后按同一流程重试'),
]


def payload(note=None):
    """The preview envelope. Shaped like the real /brain response plus the flags a UI needs.

    `preview: true` is the load-bearing field: the page must not present these nodes as stored
    memory, and a future reader must be able to tell from the payload alone.
    """
    graph = {
        # `content` starts with the short label so every consumer that takes the first line as a
        # caption (the 3D heading line, the 2D plane's slice(0,34)) gets something legible, and the
        # prose follows on its own line. Real memories have no separate label field, so the demo
        # must not depend on one either.
        'nodes': [{**node, 'content': node['label'] + '\n' + node['content'],
                   'status': 'preview', 'source': 'preview', 'created': ''}
                  for node in NODES],
        'edges': [{'a': a, 'b': b, 'relation': relation}
                  for a, b, relation in EDGES],
    }
    graph['hierarchy'] = [{'parent': parent, 'child': child, 'kind': kind, 'evidence': evidence}
                          for parent, child, kind, evidence in HIERARCHY]
    return {
        'preview': True,
        'graph': graph,
        'note': note or '演示数据：用于预览语义关系与动效，不是已保存的记忆，不会参与任何检索。',
        'categories': sorted({node['category'] for node in NODES}),
        'relations': sorted({relation for _, _, relation in EDGES}),
    }
