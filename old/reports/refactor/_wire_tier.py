"""Thread the `tier` parameter through service.recall -> store.recall and the matrix scope."""
import pathlib
REPO = pathlib.Path(__file__).resolve().parents[2]
DATA = REPO / 'data'
RELEASE = REPO.parent / 'memora-release'

root = REPO
p = root / 'memora/service.py'
text = p.read_text('utf-8')

# 1. signature
old_sig = ("    def recall(self, project, query, limit=10, mode='auto', include_user=True, statuses=('approved',), offset=0,\n"
           "               category=None, tags=None, kind=None, polarity=None, record_access=False):")
new_sig = ("    def recall(self, project, query, limit=10, mode='auto', include_user=True, statuses=('approved',), offset=0,\n"
           "               category=None, tags=None, kind=None, polarity=None, record_access=False, tier='project'):")
assert old_sig in text, 'recall signature anchor not found'
text = text.replace(old_sig, new_sig)

# 2. lexical call passes tier
old_lex = ("        lexical = self.store.recall(project, query, limit=pool, include_user=include_user, statuses=statuses, **filters)")
new_lex = ("        lexical = self.store.recall(project, query, limit=pool, include_user=include_user, statuses=statuses,\n"
           "                                   tier=tier, **filters)")
assert old_lex in text, 'lexical call anchor not found'
text = text.replace(old_lex, new_lex)

# 3. the vector-stage scope set
old_scope = ("        projects = [project] + ([USER_SCOPE] if include_user and project != USER_SCOPE else [])\n"
             "        matrix, stats = self._matrix_for(fp, projects, statuses)")
new_scope = ("        # The vector stage must read exactly the same scope set as the lexical stage, or the two\n"
             "        # halves of a hybrid result would disagree about what is visible at this tier.\n"
             "        projects, _tier = scopes.scopes_for(project, tier)\n"
             "        if not include_user: projects = [p for p in projects if p != USER_SCOPE]\n"
             "        matrix, stats = self._matrix_for(fp, projects, statuses)")
assert old_scope in text, 'scope anchor not found'
text = text.replace(old_scope, new_scope)

p.write_text(text, 'utf-8')
print('service.py updated')

# 4. import scopes
if 'from . import scopes' not in text:
    lines = text.splitlines()
    for i, line in enumerate(lines):
        if line.startswith('from .') and 'import' in line:
            lines.insert(i, 'from . import scopes')
            break
    p.write_text('\n'.join(lines) + '\n', 'utf-8')
    print('scopes imported')
else:
    print('scopes already imported')
