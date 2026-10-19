"""Update store.recall and service.recall for the four-level scope plan."""
import pathlib
REPO = pathlib.Path(__file__).resolve().parents[2]
DATA = REPO / 'data'
RELEASE = REPO.parent / 'memora-release'

root = REPO

# ---------------------------------------------------------------- store.recall
p = root / 'memora/store.py'
text = p.read_text('utf-8')

old = '''    def recall(self, project, query, limit=10, offset=0, include_user=True, statuses=('approved',),
               category=None, tags=None, kind=None, polarity=None, stop_chars=True, unigrams=True, stop_words=True, prefix=True,
               tier='project'):
        """Lexical retrieval: FTS5 BM25 over analysed text. Not semantic: a paraphrase that shares no
        terms with a memory is not found here -- that is what the optional embedding stage is for.

        `tier` selects how wide the read is: 'project' (default) sees this project plus everything
        wider, 'workspace' sees the workspace and global rungs, 'global' sees only global facts.
        Widening is what makes a shared fact usable from every project; it is a read-time decision,
        so no row moves and no schema changes. `include_user=False` still drops `:user` for callers
        that want project data only.
        """
        scope(project)
        if not isinstance(query, str) or not 1 <= len(query.strip()) <= MAX_QUERY:
            raise InvalidInput(f'query must contain 1-{MAX_QUERY} characters')
        _limit(limit, 1, MAX_RECALL * 4, 'limit'); _limit(offset, 0, 500, 'offset')
        if set(statuses) - set(INDEXED_STATUSES): raise InvalidInput('only approved, archived or superseded memories are recallable')
        opts = dict(unigrams=unigrams, prefix=prefix)
        terms = text.query_terms(query, stop_chars=stop_chars, stop_words=stop_words, **opts)
        if not terms: terms = text.query_terms(query, stop_chars=False, stop_words=False, **opts)  # a query of only function words
        if not terms: return []
        projects, tier = scopes.scopes_for(project, tier)
        if not include_user:
            projects = [p for p in projects if p != USER_SCOPE]
        if not projects: return []
        weights = ', '.join(map(str, BM25_WEIGHTS))
        sql = (f'SELECT m.*, bm25(memory_fts, {weights}) AS rank FROM memory_fts JOIN memories m ON m.id = memory_fts.id '
               f"WHERE memory_fts MATCH ? AND m.project IN ({','.join('?' * len(projects))}) "
               f"AND m.status IN ({','.join('?' * len(statuses))})")
        args = [text.fts_query(terms)] + projects + list(statuses)'''

new = '''    def recall(self, project, query, limit=10, offset=0, include_user=True, statuses=('approved',),
               category=None, tags=None, kind=None, polarity=None, stop_chars=True, unigrams=True, stop_words=True, prefix=True,
               tier='project', session_id=None):
        """Lexical retrieval: FTS5 BM25 over analysed text. Not semantic: a paraphrase that shares no
        terms with a memory is not found here -- that is what the optional embedding stage is for.

        `tier` selects how wide the read is, from widest to narrowest:
            global        only :global and :user facts
            workspace     global + workspace
            project       global + workspace + this project   (default)
            conversation  ... + rows pinned to `session_id`
        A narrower tier always includes the wider ones, because a shared fact must stay usable from
        every level below it. It is a read-time decision: no row moves and no schema changes.
        `include_user=False` still drops `:user` for callers that want project data only.
        """
        scope(project)
        if not isinstance(query, str) or not 1 <= len(query.strip()) <= MAX_QUERY:
            raise InvalidInput(f'query must contain 1-{MAX_QUERY} characters')
        _limit(limit, 1, MAX_RECALL * 4, 'limit'); _limit(offset, 0, 500, 'offset')
        if set(statuses) - set(INDEXED_STATUSES): raise InvalidInput('only approved, archived or superseded memories are recallable')
        opts = dict(unigrams=unigrams, prefix=prefix)
        terms = text.query_terms(query, stop_chars=stop_chars, stop_words=stop_words, **opts)
        if not terms: terms = text.query_terms(query, stop_chars=False, stop_words=False, **opts)  # a query of only function words
        if not terms: return []
        plan = scopes.scopes_for(project, tier, session_id=session_id)
        projects = plan['projects']
        if not include_user:
            projects = [p for p in projects if p != USER_SCOPE]
        if not projects: return []
        weights = ', '.join(map(str, BM25_WEIGHTS))
        sql = (f'SELECT m.*, bm25(memory_fts, {weights}) AS rank FROM memory_fts JOIN memories m ON m.id = memory_fts.id '
               f"WHERE memory_fts MATCH ? AND m.project IN ({','.join('?' * len(projects))}) "
               f"AND m.status IN ({','.join('?' * len(statuses))})")
        args = [text.fts_query(terms)] + projects + list(statuses)
        if plan['session_id']:
            # Conversation tier: rows pinned to this session. Wider levels stay visible, so the
            # session filter applies only to the project-level rows it narrows.
            sql += ' AND (m.session_id=? OR m.project!=?)'
            args.extend([plan['session_id'], project])'''

assert old in text, 'store.recall anchor not found'
text = text.replace(old, new)

old2 = '''            d.update(score=round(-rank, 6), retrieval='lexical',
                     scope=scopes.tier_of(r['project']),
                     scope_name=r['project'])'''
new2 = '''            d.update(score=round(-rank, 6), retrieval='lexical',
                     scope=scopes.tier_of(r['project'], r['session_id']),
                     scope_name=r['project'],
                     session_id=r['session_id'])'''
assert old2 in text, 'recall result anchor not found'
text = text.replace(old2, new2)
p.write_text(text, 'utf-8')
print('store.py updated')

# ---------------------------------------------------------------- service.recall
p = root / 'memora/service.py'
text = p.read_text('utf-8')

old3 = ("    def recall(self, project, query, limit=10, mode='auto', include_user=True, statuses=('approved',), offset=0,\n"
        "               category=None, tags=None, kind=None, polarity=None, record_access=False, tier='project'):")
new3 = ("    def recall(self, project, query, limit=10, mode='auto', include_user=True, statuses=('approved',), offset=0,\n"
        "               category=None, tags=None, kind=None, polarity=None, record_access=False, tier='project',\n"
        "               session_id=None):")
assert old3 in text, 'service signature anchor not found'
text = text.replace(old3, new3)

old4 = ("        lexical = self.store.recall(project, query, limit=pool, include_user=include_user, statuses=statuses,\n"
        "                                   tier=tier, **filters)")
new4 = ("        lexical = self.store.recall(project, query, limit=pool, include_user=include_user, statuses=statuses,\n"
        "                                   tier=tier, session_id=session_id, **filters)")
assert old4 in text, 'service lexical anchor not found'
text = text.replace(old4, new4)

old5 = ("        # The vector stage must read exactly the same scope set as the lexical stage, or the two\n"
        "        # halves of a hybrid result would disagree about what is visible at this tier.\n"
        "        projects, _tier = scopes.scopes_for(project, tier)\n"
        "        if not include_user: projects = [p for p in projects if p != USER_SCOPE]\n"
        "        matrix, stats = self._matrix_for(fp, projects, statuses)")
new5 = ("        # The vector stage must read exactly the same scope set as the lexical stage, or the two\n"
        "        # halves of a hybrid result would disagree about what is visible at this tier. The\n"
        "        # conversation filter is applied to the fetched rows in _rows(), which also takes the\n"
        "        # plan's session_id, so both halves agree there too.\n"
        "        plan = scopes.scopes_for(project, tier, session_id=session_id)\n"
        "        projects = plan['projects']\n"
        "        if not include_user: projects = [p for p in projects if p != USER_SCOPE]\n"
        "        matrix, stats = self._matrix_for(fp, projects, statuses)")
assert old5 in text, 'service scope anchor not found'
text = text.replace(old5, new5)
p.write_text(text, 'utf-8')
print('service.py updated')
