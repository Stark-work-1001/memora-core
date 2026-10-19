"""Review the memory upgrade with synthetic data in a new directory; no live store is opened."""
import argparse
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path: sys.path.insert(0, str(ROOT))

from memora import sessions  # noqa: E402
from memora.core import MemoryRuntime  # noqa: E402
from memora.workbench import make_server  # noqa: E402
from memora.workflow_templates import catalog, install  # noqa: E402


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=0)
    args = parser.parse_args()
    scratch = ROOT / 'runtime/tmp'; scratch.mkdir(parents=True, exist_ok=True)
    root = Path(tempfile.mkdtemp(prefix='memora-upgrade-preview-', dir=scratch))
    runtime = MemoryRuntime(root, env={})
    notes = [
        ('knowledge', 'SQLite 事务与 WAL', 'SQLite 是本地记忆的事务存储；WAL 支持读写并发。'),
        ('fact', 'Markdown 可读文档', 'Markdown 保存知识正文与来源，SQLite 保存状态、版本和检索索引。'),
        ('procedure', 'Embedding 索引流程', '审核后的记忆用 Embedding 编码；模型指纹变化后重新索引。'),
        ('procedure', 'Rerank 相关性排序', 'Rerank 对全文或向量召回结果评分，与 Judge 判定职责分开。'),
        ('decision', '来源核验', '记忆提炼要附原文引文，独立模型核验后才能依策略沉淀。'),
        ('lesson', '核验不能证明自己', '提炼和核验使用同一模型时，系统保留候选供用户审核。'),
        ('preference', '学习与复习', '学习笔记包含概念、问题、来源和复习计划。'),
        ('knowledge', '检索线索与抽象', '摘要与别名作为记忆线索；原始细节和日期仍需保留。'),
        ('procedure', 'Codex 接入', 'MCP stdio 指定解释器、工作目录与当前开发数据目录。'),
        ('procedure', 'DeepSeek Harness 接入', '生命周期连接器恢复上下文、归档轮次并定时发送心跳。'),
        ('knowledge', '二维与三维图谱', '脑图使用显式关系，空间位置不代表事实或语义置信度。'),
        ('decision', '开发与 standalone 隔离', '开发升级默认不更新独立桌面程序。'),
    ]
    memories = []
    for category, title, content in notes:
        memories.append(runtime.store.capture('default', title + '\n' + content,
            'synthetic-upgrade-preview', mode='manual', confirmed=True, category=category))
    for a, b, relation in [(0, 1, 'related'), (0, 2, 'supports'), (2, 3, 'related'), (4, 5, 'supports'),
                            (4, 2, 'related'), (6, 7, 'related'), (7, 3, 'related'), (8, 9, 'related'),
                            (9, 0, 'related'), (10, 7, 'related'), (11, 8, 'supports')]:
        runtime.store.link('default', memories[a]['id'], memories[b]['id'], relation)
    document = runtime.documents.put('default', 'sqlite-learning', 'human', 'SQLite 学习笔记',
        '# SQLite 学习笔记\n\n## 事务\nSQLite 通过事务保持一致性。\n\n## 检索\nSQLite FTS5 用于全文召回。', 0,
        source='synthetic-upgrade-preview')
    runtime.documents.publish('default', 'sqlite-learning', 'human', document['version'])
    runtime.knowledge.document_index().index_project('default', embed=False)
    sessions.import_records(runtime.store, [
        {'type': 'session', 'id': 'preview-session', 'agent': 'codex', 'project': 'default', 'title': 'SQLite 学习讨论'},
        {'type': 'turn', 'session': 'preview-session', 'seq': 1, 'role': 'user', 'content': '请解释 SQLite 与 Markdown 如何一起保存记忆。'},
        {'type': 'turn', 'session': 'preview-session', 'seq': 2, 'role': 'assistant', 'content': 'SQLite 管理事务与索引，Markdown 提供可阅读的知识文档。'}], 'default')
    runtime.model_registry.save({'models': [
        {'id': 'writer', 'name': '提炼模型（演示配置）', 'model': 'configure-your-writer', 'base': 'http://127.0.0.1:18182/v1'},
        {'id': 'verifier', 'name': '独立核验（演示配置）', 'model': 'configure-your-verifier', 'base': 'http://127.0.0.1:18183/v1'}],
        'bindings': {'curator': 'writer', 'verifier': 'verifier', 'documenter': 'writer', 'summarizer': 'writer'}})
    for recipe in catalog(runtime):
        if recipe['ready']: install(runtime, 'default', recipe['id'])
    server = make_server(runtime, args.port)
    print('Preview: http://127.0.0.1:' + str(server.server_port), flush=True)
    print('Synthetic data: ' + str(root), flush=True)
    try: server.serve_forever()
    except KeyboardInterrupt: pass
    finally: server.server_close(); runtime.close()


if __name__ == '__main__': main()
