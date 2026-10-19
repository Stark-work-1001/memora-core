"""Focused UI adapter over the existing hardened loopback HTTP server."""
from .errors import InvalidInput, LimitExceeded, MemoraError, NotFound
from .store import scope
from .web import make_server as http_server

ASSETS = {'/': ('memory.html', 'text/html'), '/memory.js': ('memory.js', 'text/javascript'),
          '/memory.css': ('memory.css', 'text/css'), '/orchestration.js': ('orchestration.js', 'text/javascript'),
          # The canvas is embedded in the workbench view now (see dag-embed.js), but its static
          # files are still addressed under /dag/ and the standalone page below is kept so an old
          # bookmark or a shared link does not 404. memora/web.py matches `parsed.path in assets`
          # EXACTLY, so every concrete path the page can request must be listed here -- there is no
          # prefix branch for /dag, unlike /brain/.
          '/dag-embed.js': ('dag-embed.js', 'text/javascript'),
          '/dag': ('dag/index.html', 'text/html'), '/dag/': ('dag/index.html', 'text/html'),
          '/dag/index.html': ('dag/index.html', 'text/html'),
          '/dag/styles.css': ('dag/styles.css', 'text/css'), '/dag/app.js': ('dag/app.js', 'text/javascript')}


class Workbench:
    def __init__(self, runtime):
        self.runtime = runtime
        # See document_chunks(): one DocIndex for this process, rebuilt when runtime.service changes.
        self._index = {'service': None, 'index': None}

    # --- document CHUNK index (memora/docindex.py) ------------------------------------------------
    # Deliberately NOT core.document_index(), which is what POST /document-index already calls:
    # that exports a revision and runs ingest.import_file into the MEMORY store, producing MEMORY
    # rows the owner confirms through review. These routes do the other thing -- published Markdown
    # chunked into doc_chunks / doc_chunk_fts / doc_chunk_embeddings in the DOCUMENT database --
    # which is the only thing that makes memora/docindex.py's retrieval (the MCP tool
    # memory_document_rag_context) able to return anything at all. Two stores, two purposes:
    # neither route is renamed, merged with, or substituted for the other.

    def document_chunks(self):
        """The one DocIndex this process uses, rebound whenever runtime.service is replaced.

        mcp.py keeps the identical cache for its own tool (memora/mcp.py:35-42), but it lives in
        the create_server() closure and is not reachable from here without editing mcp.py, which
        this package may not do. So this applies the same mechanism a second time rather than
        sharing one object: both rebuild from runtime.service the moment its identity changes, and
        that is the property that actually matters -- a DocIndex holds its embedding provider by
        direct reference (memora/docindex.py:158) and refresh_settings() swaps runtime.service on a
        model rebind, so a cache that ignored the swap would keep indexing against the old model
        while looking current. Two instances cost one extra cached vector matrix each, which is
        safe because both key that matrix on doc_meta.generation (docindex.py:437-439), so a write
        through one instance is observed by the other.
        """
        r = self.runtime
        if self._index['service'] is not r.service:
            from .docindex import DocIndex
            self._index['index'] = DocIndex.from_service(r.documents, r.service)
            self._index['service'] = r.service
        return self._index['index']

    @staticmethod
    def _generation(index):
        """The monotonic counter docindex's triggers bump on every chunk/vector row write."""
        with index.connect() as c:
            row = c.execute("SELECT value FROM doc_meta WHERE key='generation'").fetchone()
        return int(row[0]) if row else 0

    @staticmethod
    def _counts(index, project):
        """Project-scoped corpus totals. The scalars only: the per-revision breakdown belongs on
        GET /document-chunks-status, where a caller goes looking for it rather than on every write."""
        s = index.status(project)
        return {'chunks': s['chunks'], 'vectors': s['vectors'],
                'embedding_configured': s['embedding_configured']}

    @staticmethod
    def _embed_report(embed, r, skipped=None):
        """What actually happened to the vector half. mode='disabled' means no provider was
        configured and NO vectors were written; mode='skipped' means the caller asked for a lexical
        pass, or that nothing was indexed at all. Neither is ever reported as a full index."""
        out = {'requested': embed, 'mode': r.get('mode', 'skipped'), 'embedded': r.get('embedded', 0),
               'pending': r.get('pending', 0)}
        for key in ('fingerprint', 'dim', 'skipped_changed', 'warning'):
            if key in r:
                out[key] = r[key]
        if skipped is not None:
            out['message'] = skipped          # nothing was indexed, so say that, not a mode note
        elif out['mode'] != 'vector':
            out['message'] = ('no embedding provider configured: chunks are indexed and FTS-searchable, '
                              'but no vectors were written, so vector and hybrid retrieval stay empty'
                              if out['mode'] == 'disabled' else
                              'embedding was not requested: chunks are indexed and FTS-searchable only')
        return out

    def _index_one(self, index, project, slug, audience, version, embed):
        """Index exactly one document. Every outcome is a reported result, never a bare success."""
        try:
            r = index.index_document(project, slug, audience, version, embed=embed)
        except NotFound:
            # index_document reads published revisions only (docindex.py:332, drafts defaults off),
            # so a draft raises NotFound. That is NOT a 404: the document exists and the owner just
            # has to publish it, so say so and write nothing. A missing row must never read as
            # "indexed". A document that is genuinely absent still gets its NotFound, below.
            try:
                draft = self.runtime.documents.read(project, slug, audience, version, drafts=True)
            except NotFound:
                raise
            return {'slug': slug, 'audience': audience, 'version': draft['version'], 'result': 'skipped',
                    'reason': 'draft', 'published': False, 'chunks': 0, 'written': 0, 'removed': 0,
                    'embedding': self._embed_report(embed, {'mode': 'skipped'},
                                                 skipped='nothing was indexed: the document is an '
                                                          'unpublished draft, so there is nothing to embed'),
                    'message': (f"'{slug}' / {audience} v{draft['version']} is an unpublished draft; only "
                                'PUBLISHED revisions are indexable. Publish it, then index again.')}
        except LimitExceeded as e:      # before InvalidInput: it is a subclass of it
            return {'slug': slug, 'audience': audience, 'version': version, 'result': 'error',
                    'error': getattr(e, 'code', 'limit_exceeded'), 'chunks': 0, 'written': 0, 'removed': 0,
                    'embedding': self._embed_report(embed, {'mode': 'skipped'},
                                                 skipped='nothing was indexed: the revision was rejected'),
                    'message': str(e)[:200]}
        except InvalidInput:
            raise                        # a bad slug/audience/version is a caller bug: 400, not a report
        except (MemoraError, Exception) as e:   # noqa: B014 - one bad revision must not lose the report
            return {'slug': slug, 'audience': audience, 'version': version, 'result': 'error',
                    'error': getattr(e, 'code', type(e).__name__), 'chunks': 0, 'written': 0, 'removed': 0,
                    'embedding': self._embed_report(embed, {'mode': 'skipped'},
                                                 skipped='nothing was indexed: indexing failed'),
                    'message': str(e)[:200]}
        return {'slug': r['slug'], 'audience': r['audience'], 'version': r['version'],
                'document': r['document'], 'result': r['result'], 'published': True,
                'chunks': r['chunks'], 'written': r['written'], 'removed': r['removed'],
                'embedding': self._embed_report(embed, r)}

    @staticmethod
    def _summary(documents):
        """Roll the per-document results up, so a caller never has to count them itself. written /
        embedded are the two numbers that say whether the corpus actually moved."""
        counts = {'indexed': 0, 'unchanged': 0, 'skipped': 0, 'error': 0}
        for d in documents:
            counts[d['result']] = counts.get(d['result'], 0) + 1
        return {'documents': len(documents), 'indexed': counts['indexed'], 'unchanged': counts['unchanged'],
                'skipped': counts['skipped'], 'errors': counts['error'],
                'chunks_written': sum(d.get('written', 0) for d in documents),
                'vectors_written': sum(d['embedding'].get('embedded', 0) for d in documents),
                'vectors_pending': sum(d['embedding'].get('pending', 0) for d in documents)}

    @staticmethod
    def _embed_flag(b):
        """embed defaults to TRUE, matching DocIndex.index_document/index_project.

        The point of this entry point is to make a corpus retrievable through memory_document_
        rag_context, and that tool's vector/hybrid stage needs stored vectors: a lexical-only
        default would leave the corpus permanently in the state this package exists to fix, and a
        caller has no way to discover a flag they never saw documented. Callers who want a fast
        offline pass pass embed=false, and either way the response reports which half ran. A
        non-boolean is a caller bug rather than a silent default.
        """
        embed = b.get('embed', True)
        if type(embed) is not bool:
            raise InvalidInput('embed must be a boolean')
        return embed

    def _write(self, index, operation, project, embed, counts_before, gen_before, documents,
               extra=None):
        """The shape both write routes return: what ran, what happened per document, and the two
        independent proofs that the corpus did or did not change -- row counts and the generation
        counter. They are redundant on purpose: a caller that trusts only one of them is still right.
        """
        gen_after = self._generation(index)
        out = {'operation': operation, 'project': project, 'embed': embed,
               'corpus': {'before': counts_before, 'after': self._counts(index, project)},
               'generation': {'before': gen_before, 'after': gen_after, 'changed': gen_before != gen_after},
               'documents': documents, 'summary': self._summary(documents)}
        if extra:
            out.update(extra)
        return out


    # --- archived sessions: the two READ routes the archive only had over MCP ---------------------
    # memora/sessions.py already answers both questions -- show():167 for one transcript, search():183
    # for a full-text query -- and the workbench already lists the archive (GET /sessions ->
    # list_sessions():176). The pair of read routes in between never existed, so the page had to
    # reconstruct a transcript by parsing the Markdown mirror memory_absorb writes and scan it in the
    # browser. Both routes below are GET, read-only, and add no auth of their own: web.py:49 validates
    # the Host header and nothing else, exactly as it does for /sessions.
    #
    # Neither route ever logs. Turn text is user content: it was redacted for secrets when it was
    # ARCHIVED (sessions.py:56) and this file neither re-redacts it nor prints it anywhere -- the only
    # strings that reach a log from here are session ids.

    SESSION_TURN_LIMIT = 200         # default page for GET /session
    SESSION_TURN_MAX = 1000          # hard cap: a page above this is a caller bug, not a big session
    # Default for GET /session-search. Its cap is sessions.search's own: sessions.py:184 accepts
    # 1..100 and rejects anything else, which is why no upper constant is repeated here.
    SESSION_SEARCH_LIMIT = 20

    def session_turns(self, project, sid, limit=None, after=None):
        """GET /api/agent/session -- one archived session with its turns, in seq order.

        The ONE response shape this route returns:

            {"project": "demo",
             "session": {"id", "agent", "external_id", "title", "started", "ended", "created",
                         "meta", "turns"},   # turns = TOTAL turn count for this session, the same
                                             # field GET /api/agent/sessions reports per row
             "turns": [{"seq", "role", "created", "content", "redactions"}, ...],
             "memories": ["<memory id>", ...],   # curated memories that point at this session
             "page": {"limit", "cursor", "returned", "total", "next_cursor"}}

        `turns` is ordered by seq ascending; `content` is stored text, verbatim.

        IDENTIFIER: `id` is the session ROW id -- sessions.id, the `id` field of
        GET /api/agent/sessions -- NOT external_id. sessions.show (sessions.py:169) matches either,
        but this route is project-scoped: the row id is a UUID and unique across the whole file, so a
        project-scoped lookup can never be ambiguous, whereas external_id is only unique per
        (project, agent) and across projects is not unique at all. An external_id passed here is
        simply a session that does not exist -- the client already has the row id in the list it read.

        NOT FOUND is a real answer, not an empty conversation: NotFound is both a MemoraError and a
        KeyError, and web.py:143 maps exactly that combination to HTTP 404 with the standard
        {"error": {"code": "not_found", "message": ..., "retryable": false, "details": {...}}}
        envelope. A missing session and a session that belongs to another project are reported
        identically -- one project's archive is not another project's business.

        PAGINATION: `limit` (default 200, 1..1000) caps one page and `cursor` is an EXCLUSIVE
        seq cursor -- "give me turns after this seq" -- so a long conversation is read in stable
        chunks instead of being silently truncated at the cap. `page.next_cursor` is the seq to send
        back as `cursor`, or None when this page was the last one. seq is dense and monotonic per
        session (sessions.py:57), which makes it a better cursor than an offset: a turn archived
        between two requests cannot shift a later page.
        """
        project = scope(project)
        if not isinstance(sid, str) or not sid:
            raise InvalidInput('id is required: the session row id from GET /api/agent/sessions')
        limit = int(limit) if limit not in (None, '') else self.SESSION_TURN_LIMIT
        if not 1 <= limit <= self.SESSION_TURN_MAX:
            raise InvalidInput('limit must be 1..%d' % self.SESSION_TURN_MAX)
        # 0 is a legitimate exclusive cursor ("everything"), so '' and None are the only "no cursor".
        cursor = None if after in (None, '') else int(after)
        store = self.runtime.store
        with store.connect() as c:
            s = c.execute('SELECT * FROM sessions WHERE id=? AND project=?', (sid, project)).fetchone()
            if s is None: raise NotFound('session not found', id=sid)
            total = c.execute('SELECT count(*) FROM turns WHERE session_id=?', (s['id'],)).fetchone()[0]
            sql, args = 'SELECT seq, role, created, content, redactions FROM turns WHERE session_id=?', [s['id']]
            if cursor is not None:
                sql += ' AND seq>?'
                args.append(cursor)
            # limit+1 rows: the extra one is how "there is another page" is known without a second
            # count, and it is never returned.
            rows = c.execute(sql + ' ORDER BY seq LIMIT ?', (*args, limit + 1)).fetchall()
            mems = [m['id'] for m in c.execute('SELECT id FROM memories WHERE session_id=?', (s['id'],))]
        import json
        turns = [dict(row) for row in rows[:limit]]
        return {'project': project,
                'session': {'id': s['id'], 'agent': s['agent'], 'external_id': s['external_id'],
                            'title': s['title'], 'started': s['started'], 'ended': s['ended'],
                            'created': s['created'],
                            # Parsed here, unlike GET /sessions, which hands back the stored TEXT:
                            # sessions.show():173 parses it, and an object is what a reader wants.
                            'meta': json.loads(s['meta']), 'turns': total},
                'turns': turns,
                'memories': mems,
                'page': {'limit': limit, 'cursor': cursor, 'returned': len(turns), 'total': total,
                         'next_cursor': turns[-1]['seq'] if len(rows) > limit else None}}

    def session_search(self, project, query, limit=None):
        """GET /api/agent/session-search -- full-text search across the archive's TURNS.

        WHAT IT SEARCHES, quoted from the only implementation (sessions.search, sessions.py:189):

            SELECT t.session_id, t.seq, t.role, t.content, bm25(turns_fts) AS rank FROM turns_fts
                JOIN turns t ON t.session_id=turns_fts.session_id AND t.seq=turns_fts.seq
                JOIN sessions s ON s.id=t.session_id
                WHERE turns_fts MATCH ? AND s.project=? ORDER BY rank LIMIT ?

        So: the FTS5 index over archived turn TEXT -- its two indexed columns, terms (words plus CJK
        bigrams) and chars (CJK unigrams), both built by text.analyze():83 -- ranked by bm25 and
        filtered to this project through the session join. What it does NOT search matters just as
        much: session titles, session meta and curated memories are not in turns_fts, so a title-only
        match is a miss. A hit is a TURN, and one session can appear several times.

        The query is segmented by text.query_terms(): stop words are dropped, Latin words of 3+
        characters also match by prefix, and the terms are OR-joined into the FTS5 expression this
        route reports back as searched.match. A query made only of stop words analyzes to nothing,
        and sessions.py:187 answers [] -- an empty result, not an error -- which searched.reason
        explains rather than leaving it to look like a broken index.

        Response shape (the ONE shape this route returns):

            {"project", "query", "engine": "sqlite fts5 (bm25)",
             "searched": {"index", "columns", "engine", "scope", "terms", "match", "limit",
                          "reason"?},
             "coverage": {"sessions", "sessions_with_turns", "turns",
                          "sessions_matched", "turns_returned"},
             "items": [{"session", "seq", "role", "content", "score",
                        "session_title", "session_agent", "session_external_id"}, ...],
             "count"}

        coverage.sessions and coverage.turns are the project's own totals, so a zero-hit answer is
        distinguishable from a project with nothing archived in it -- the difference the page could
        not draw while it was scanning only the rows it happened to have loaded.

        content is the 500-character excerpt sessions.search itself returns (sessions.py:192), not
        the whole turn: enough context to recognise the hit, never re-redacted or re-escaped.
        """
        from . import text
        from .sessions import search as session_search_fn
        project = scope(project)
        limit = int(limit) if limit not in (None, '') else self.SESSION_SEARCH_LIMIT
        # sessions.search validates the query and the limit itself (sessions.py:184-185), and its
        # InvalidInput arrives as the standard 400 envelope. Nothing is re-validated here, so the two
        # cannot drift apart.
        hits = session_search_fn(self.runtime.store, project, query, limit)
        ids = sorted({h['session'] for h in hits})
        meta, counts = {}, {}
        with self.runtime.store.connect() as c:
            for sid in ids:
                row = c.execute('SELECT title, agent, external_id FROM sessions WHERE id=? AND project=?',
                                (sid, project)).fetchone()
                if row is not None:
                    meta[sid] = {'session_title': row['title'], 'session_agent': row['agent'],
                                 'session_external_id': row['external_id']}
            counts['sessions'] = c.execute('SELECT count(*) FROM sessions WHERE project=?',
                                           (project,)).fetchone()[0]
            counts['sessions_with_turns'] = c.execute(
                'SELECT count(*) FROM sessions s WHERE s.project=? AND EXISTS'
                '(SELECT 1 FROM turns t WHERE t.session_id=s.id)', (project,)).fetchone()[0]
            counts['turns'] = c.execute('SELECT count(*) FROM turns t JOIN sessions s ON s.id=t.session_id'
                                        ' WHERE s.project=?', (project,)).fetchone()[0]
        terms = text.query_terms(query) if isinstance(query, str) else []
        searched = {'index': 'turns_fts', 'columns': ['terms', 'chars'],
                    'engine': 'sqlite fts5 (bm25)',
                    'scope': "archived turn text in project '%s'; session titles, session meta and "
                             "curated memories are not indexed" % project,
                    'terms': sorted({term for _, term in terms}),
                    # The literal FTS5 expression handed to MATCH. None, never '', when the analyzer
                    # produced no term: '' would read as a malformed query rather than an empty one.
                    'match': text.fts_query(terms) if terms else None,
                    'limit': limit}
        if not terms:
            searched['reason'] = ('the query has no searchable term after stop-word removal, so '
                                  'nothing was matched (this is an empty result, not an error)')
        return {'project': project, 'query': query, 'engine': 'sqlite fts5 (bm25)',
                'searched': searched,
                'coverage': dict(counts, sessions_matched=len(ids), turns_returned=len(hits)),
                'items': [dict(h, **meta.get(h['session'], {})) for h in hits],
                'count': len(hits)}

    def get(self, path, q):
        r, project = self.runtime, q.get('project', 'default')
        r.refresh_settings()
        if path == '/status': return r.status()
        if path == '/model-health':
            # Per-role connectivity AT THE MOMENT OF THE CALL: embedding, judge AND rerank, read
            # off the saved settings. It is not a cache and not a promise -- a role being reachable
            # here only says the endpoint answered a GET /models just now; the real inference probe
            # is POST /model-probe below. Keys are role names, so a role added to core.ROLES shows
            # up here without changing this route.
            return r.model_health()
        if path == '/models': return r.model_registry.describe()
        if path == '/workflow-templates':
            from .workflow_templates import catalog
            return {'items': catalog(r)}
        if path == '/knowledge-search':
            return r.knowledge.search(project, q.get('query', ''), limit=int(q.get('limit', 10)),
                mode=q.get('mode', 'auto'), graph_hops=int(q.get('graph_hops', 1)))
        if path == '/knowledge-context':
            return r.knowledge.context(project, q.get('query', ''), budget=int(q.get('budget', 6000)),
                mode=q.get('mode', 'auto'), limit=int(q.get('limit', 10)))
        if path == '/jobs': return {'items': r.jobs.list(project)}
        if path == '/accumulation-policy': return r.accumulation.policy()
        if path == '/workflows': return {'items': r.control.workflows(project)}
        if path == '/workflow-runs': return {'items': r.workflows.runs(project)}
        if path == '/sessions':
            from .sessions import list_sessions
            return {'items': list_sessions(r.store, project)}
        if path == '/session':
            # One archived session with its turns. Placed beside /sessions because they answer the
            # same question at two depths and a client that found one must find the other; see
            # session_turns() for the identifier, the response shape and the pagination contract.
            return self.session_turns(project, q.get('id'), q.get('limit'), q.get('cursor'))
        if path == '/session-search':
            # The server-side half of the panel's search box: sessions.search(), previously reachable
            # only as the MCP tool memory_session_search. What she searched is reported back; see
            # session_search().
            return self.session_search(project, q.get('query', ''), q.get('limit'))
        if path == '/peers':
            # Scope matters here in a way that bit a real user: peers are recorded per project, the
            # page defaults to `default`, and every connected agent lived under `dsh`. The agents
            # view therefore showed "no agent online" while four heartbeats existed. The default
            # read now spans all projects and reports which project each peer belongs to.
            #
            # It keys off ?scope=, NOT off the presence of ?project=. Every workbench fetch carries
            # ?project= automatically (memory.js api() adds it), so "has a project" cannot mean
            # "wants only this project" -- treating it that way made this route silently return an
            # empty list, which is exactly the bug this change was meant to fix.
            if q.get('scope') == 'project':
                return {'items': r.control.peers(project), 'scope': 'project', 'project': project}
            return dict(r.control.peers_everywhere(), scope='all')
        if path == '/queue': return r.queue(project, q.get('status', 'pending'), q.get('cursor'))
        if path == '/recall':
            return r.recall(project, q.get('query', ''), q.get('mode', 'auto'),
                            tier=q.get('tier', 'project'), session_id=q.get('session_id') or None)
        if path == '/scopes': return r.scopes(project, session_id=q.get('session_id') or None)
        if path == '/rag':
            # Evidence-pack preview: exactly the envelope service.rag() would hand a calling
            # model (context with the per-response nonce, references, retrieval_mode, the warning
            # when there is one, generation). The retrieve page renders it verbatim so the owner
            # can see the real wrappers. GET, like every other read route: web.py:48 validates the
            # Host header and nothing else, so this adds no auth of its own.
            #
            # service.rag() calls recall(record_access=False) (service.py:231,147), so building a
            # preview never bumps access_count -- the same protection recall() gets by explicit
            # opt-in (core.py:261) comes here from the default. `r.lock` guards the shared
            # service/vector state the same way recall() and index() do. Only context and
            # references are load-bearing downstream; the rest is optional so a future envelope
            # change cannot break the page.
            with r.lock:
                return r.service.rag(project, q.get('query', ''), mode=q.get('mode', 'auto'),
                                      limit=int(q['limit']) if q.get('limit') else 10)
        if path == '/document-rag':
            # Document-level evidence pack: the DOCUMENTS layer, not the approved-memory layer
            # /rag above serves. Two different stores with two different envelopes (references
            # here are [chunk:...] ids from doc_chunks; /rag's are memory ids), so this route is
            # additive and /rag is untouched -- a page must never be able to render one under the
            # other's heading.
            #
            # Read-only, and deliberately so: DocIndex.rag() is retrieval only. Indexing has its
            # own POST routes (/document-chunks, /document-chunks-project); a GET that quietly
            # chunked a corpus would make a page load a write. An unindexed corpus is therefore a
            # well-formed EMPTY envelope (context '', references []), never an error -- the same
            # answer memory_document_rag_context gives, and /document-chunks-status is where a
            # caller establishes which of the two an empty pack means.
            #
            # The envelope is returned verbatim (context, citations, references, generation,
            # retrieval_mode, audience_filter, audience_rule, versions, slug, nonce, omitted,
            # truncated, warnings, budget, trust, instruction, plus retrieval_warning when a
            # degraded stage ran), so the page renders exactly what a calling model receives.
            #
            # The lock and document_chunks() are copied from the /rag branch and the chunk routes:
            # r.lock guards the shared service/embedding state rag() reads, and document_chunks()
            # is the SAME cached DocIndex POST /document-chunks writes through, so a pack requested
            # right after an index sees it rather than a second, stale object.
            #
            # Validation is DocIndex's, not a second opinion invented here: each parameter is
            # forwarded only when the caller actually supplied it, so an absent budget/max_tokens/
            # limit reaches docindex.py's own defaults. int() is applied only because a query string
            # is text; a non-numeric value raises ValueError, which web.py:143 turns into the
            # standard 400 error envelope. Out-of-range values raise LimitExceeded / InvalidInput
            # from docindex.py:627-630,545 -- also ValueError subclasses -- so those arrive as the
            # same envelope, never a stack trace.
            index = self.document_chunks()
            args = {k: int(q[k]) for k in ('budget', 'max_tokens', 'limit') if q.get(k)}
            with r.lock:
                pack = index.rag(project, q.get('query', ''), mode=q.get('mode', 'auto'),
                                 audience=q.get('audience') or None,
                                 versions=q.get('versions', 'latest'), slug=q.get('slug') or None,
                                 **args)
            return {'project': project, **pack}
        if path == '/brain': return r.brain(project)
        if path == '/brain-preview':
            # Demo graph for an EMPTY project only. It refuses once real memories exist, so the
            # preview can never stand in front of, or be confused with, stored data. Read-only:
            # nothing here writes to any database.
            from . import brain_preview
            with r.store.connect() as c:
                approved = c.execute(
                    "SELECT count(*) FROM memories WHERE project=? AND status='approved'",
                    (project,)).fetchone()[0]
            if approved:
                return {'preview': False, 'available': False, 'approved': approved,
                        'note': '该项目已有 %d 条已审核记忆，脑图会显示真实数据，因此不提供演示预览。'
                                % approved}
            return dict(brain_preview.payload(), available=True, project=project)
        if path == '/map':
            # The 2D plane reads a STRUCTURED graph (nodes + links), not the markdown projection the
            # 3D views parse. Preview support therefore has to live here too, or the preview toggle
            # fills the 3D views and leaves the 2D one blank -- which is what happened first.
            if q.get('preview') == '1':
                from . import brain_preview
                with r.store.connect() as c:
                    approved = c.execute(
                        "SELECT count(*) FROM memories WHERE project=? AND status='approved'",
                        (project,)).fetchone()[0]
                if not approved:
                    preview = brain_preview.payload()
                    graph = preview['graph']
                    # The plane computes its own x/y from the layout selector, so zeroed coordinates
                    # are correct here and keep this route from inventing a layout the view would
                    # then override anyway.
                    #
                    # Field names must match the REAL /map payload (core.graph): the plane reads
                    # `.edges` in semantic mode and `.hierarchy` in outline mode. Returning only
                    # `links` made `g.edges` undefined and the stage threw "w is not iterable".
                    nodes = [{**node, 'x': 0, 'y': 0} for node in graph['nodes']]
                    return {'preview': True, 'nodes': nodes,
                            'edges': graph['edges'],
                            'hierarchy': graph.get('hierarchy', []),
                            'links': graph['edges'],
                            'truncated': False}
            return r.graph(project)
        if path == '/documents': return {'items': r.documents.list(project, drafts=True)}
        if path == '/document-chunks-status':
            # The read-only half of the chunk index, and the answer to "is my corpus indexed at
            # all?". memory_document_rag_context returns an empty pack for an unindexed corpus and
            # cannot tell that apart from a query that simply matched nothing; this route can,
            # because it reports rows rather than results. Read-only like every other GET route:
            # web.py:48 validates the Host header and nothing else, so it adds no auth of its own.
            index = self.document_chunks()
            with r.lock:
                status = index.status(project, q.get('audience'))
            return {'project': project, 'generation': self._generation(index), **status}
        if path == '/document': return r.documents.read(project, q.get('slug'), q.get('audience', 'human'),
                                                      int(q['version']) if q.get('version') else None, drafts=True)
        if path == '/setup':
            from .connections import setup
            return setup(r.store.root)
        raise InvalidInput('unknown memory endpoint')

    def snapshot(self, jid=None, project='default'):
        """Live workbench state for GET /api/agent/events (web.py:68).

        Mirrors Agent.snapshot (agent.py:267): an object with a status field that reads 'running'
        while the work it describes is outstanding, so the client's final-frame-then-close
        behaviour (memory.js subscribeLive, web.py:83) works on this server too. The payload is
        real state the retrieve page already displays -- peers, pending queue, accumulation jobs,
        sessions -- so a frame can drive a reconciliation instead of only a liveness ping.

        No wall-clock value may appear here: web.py writes a frame only when the JSON differs from
        the previous one, so a timestamp or a peer age would defeat that change detection.
        """
        from .sessions import list_sessions
        r, project = self.runtime, scope(project)
        r.refresh_settings()
        peers = r.control.peers(project)
        jobs = r.jobs.list(project)
        counts = {}
        for job in jobs:
            counts[job['status']] = counts.get(job['status'], 0) + 1
        # The same pending queue loadProcessing() renders, counted on the (project,status) index.
        with r.store.connect() as c:
            pending = c.execute('SELECT count(*) FROM memories WHERE project=? AND status=?',
                                (project, 'pending')).fetchone()[0]
        sessions = list_sessions(r.store, project)          # newest 100, as the page lists them
        waiting = counts.get('queued', 0) + counts.get('running', 0) + counts.get('retry', 0)
        out = {'kind': 'workbench', 'project': project, 'id': jid,
               # A memory waiting for review is the user's work, not the system's, so only
               # accumulation work keeps the stream open.
               'status': 'running' if waiting else 'idle',
               'queue': {'pending': pending},
               'jobs': {'listed': len(jobs), 'by_status': counts, 'waiting': waiting,
                        'stuck': counts.get('retry', 0) + counts.get('failed', 0)},
               'peers': {'total': len(peers), 'connected': sum(1 for p in peers if p['connected']),
                         'items': [{'id': p['id'], 'name': p['name'], 'model': p['model'],
                                    'connected': p['connected']} for p in peers]},
               'sessions': {'listed': len(sessions), 'turns': sum(s['turns'] for s in sessions)}}
        if jid:
            # subscribeLive() passes a job id. When it is a real accumulation task, add that task's
            # own state next to the aggregate.
            for job in jobs:
                if job['id'] == jid:
                    out['job'] = {'id': job['id'], 'kind': job['kind'], 'status': job['status'],
                                  'attempts': job['attempts'], 'error': job['error']}
                    if job['status'] in {'queued', 'running', 'retry'}: out['status'] = 'running'
                    break
        return out

    def post(self, path, b):
        r, project = self.runtime, b.get('project', 'default')
        r.refresh_settings()
        if path == '/capture': return r.capture(project, b.get('content'), b.get('source', 'workbench'), b.get('event_id'), b.get('category'))
        if path == '/capture-markdown': return self._capture_markdown(b, project)
        if path == '/space': return r.control.save_space(dict(b, project=project))
        if path == '/classify': return r.classify(project, b.get('id'))
        if path == '/category': return r.set_category(project, b.get('id'), b.get('category'))
        if path == '/review': return r.review(project, b.get('id'), b.get('action'))
        if path == '/index':
            with r.lock: return r.service.index(project, max_items=1000)
        if path == '/settings': return r.save_settings(b.get('settings'))
        if path == '/model-probe':
            # POST /api/agent/model-probe -- the 测试连接 button. One REAL minimal inference per
            # saved role (/embeddings, /chat/completions, /rerank), reporting HTTP status, latency,
            # model and the actual error. Read-only:
            #   * it writes nothing (no settings, no cache -- every call is a fresh observation);
            #   * it accepts no endpoint, key or model from the request. The destination is the
            #     saved memora.json and nothing else, so this route is not an SSRF hop and cannot
            #     be pointed at a caller-chosen host;
            #   * the only input is an optional role list (validated against core.ROLES) and the
            #     per-request timeout is capped by core.PROBE_TIMEOUT.
            # A failure is data here, not an exception: the caller needs every role's status in one
            # response, so ok=False plus error/http_status is returned with HTTP 200. Only bad
            # ARGUMENTS (an unknown role) raise, and they raise InvalidInput like every route.
            return r.model_probe(roles=b.get('roles'), timeout=b.get('timeout_s'))
        if path == '/models': return r.model_registry.save(b.get('registry'))
        if path == '/workflows': return r.control.save_workflow(b, r.profiles)
        if path == '/workflow-template-install':
            from .workflow_templates import install
            return install(r, project, b.get('template'), b.get('bindings'))
        if path == '/workflow-start': return r.workflows.start(b)
        if path == '/workflow-cancel': return r.workflows.cancel(project, b.get('id'))
        if path == '/job-retry': return r.jobs.retry(project, b.get('id'))
        if path == '/accumulation-policy':
            import json
            import os
            value = b.get('policy')
            if not isinstance(value, dict) or set(value) - {'auto_consolidate', 'minimum_importance', 'verify'}:
                raise InvalidInput('invalid accumulation policy')
            if type(value.get('auto_consolidate')) is not bool or type(value.get('verify')) is not bool:
                raise InvalidInput('policy flags must be booleans')
            if type(value.get('minimum_importance')) not in (int, float) or not 0 <= value['minimum_importance'] <= 1:
                raise InvalidInput('minimum_importance must be 0..1')
            path = r.store.root / 'accumulation.json'; temporary = path.with_suffix('.tmp')
            temporary.write_text(json.dumps(value, indent=2), 'utf-8'); os.replace(temporary, path)
            return r.accumulation.policy()
        if path == '/absorb': return r.accumulation.absorb(project, b.get('agent'), b.get('session_id'), b.get('title'), b.get('turns'), b.get('event_id'))
        if path == '/document':
            return r.documents.put(project, b.get('slug'), b.get('audience', 'human'), b.get('title'), b.get('content'),
                                   b.get('expected_version'), source='workbench', recorded_date=b.get('recorded_date'),
                                   origin_uri=b.get('origin_uri'), group_title=b.get('group_title'))
        if path == '/document-publish': return r.documents.publish(project, b.get('slug'), b.get('audience', 'human'), b.get('version'))
        if path == '/document-index': return r.document_index(project, b.get('slug'), b.get('audience', 'human'), b.get('version'))
        if path == '/document-chunks': return self._index_document(b, project)
        if path == '/document-chunks-project': return self._index_project(b, project)
        if path == '/document-repair': return r.documents.repair(project)
        if path == '/link': return r.store.link(project, b.get('a'), b.get('b'), b.get('relation'), actor='memora-user')
        if path == '/hierarchy': return r.control.hierarchy_link(project, b.get('parent'), b.get('child'), b.get('kind'), b.get('evidence'))
        raise InvalidInput('unknown memory endpoint')

    def _capture_markdown(self, b, project):
        """POST /api/agent/capture-markdown -- turn a Markdown document into pending memories.

        This is the "新增 Markdown 文档" path in 分类与沉淀: the user drops or pastes a .md file and
        expects it to go through the SAME review pipeline as a typed memory, not to bypass it. So it
        reuses ingest.parse_markdown (the same parser the file importer uses, so heading context and
        front-matter titles behave identically) and then calls runtime.capture once per chunk.

        Deliberately NOT /document (which writes a versioned Markdown document) and NOT
        /document-index (which turns a published revision into memory rows): those are the
        document store's own lifecycle and would create a document the user never asked for. Here
        the file is only a convenient way to supply many memory candidates at once; the source
        string records the filename so the provenance survives review.

        Request  {project, content, filename?, source?}
        Response {parsed, created:[...], failed:[...], title, filename}
        """
        from . import ingest

        content = b.get('content')
        if not isinstance(content, str) or not content.strip():
            raise InvalidInput('markdown content required')
        if len(content) > 200000:
            raise InvalidInput('markdown content is limited to 200000 characters per submission')
        filename = (b.get('filename') or 'pasted.md')
        if not isinstance(filename, str) or len(filename) > 200:
            raise InvalidInput('filename must be text, max 200 characters')
        source = b.get('source') or 'workbench-markdown'

        title, chunks = ingest.parse_markdown(content)
        if not chunks:
            raise InvalidInput('the document produced no text; nothing was added')
        created, failed = [], []
        for index, (body, meta) in enumerate(chunks):
            if not body.strip():
                continue
            heading = ' > '.join(meta.get('heading') or [])
            # The stored content keeps its heading trail so a reviewed memory still says where in
            # the document it came from; the filename makes the file itself traceable.
            text = ((heading + '\n' + body) if heading else body).strip()
            event_id = 'md:' + str(abs(hash((filename, index, text))) % (10 ** 16))
            try:
                row = self.runtime.capture(project, text, source,
                                           event_id=event_id, category=None)
                created.append({'index': index, 'id': (row.get('memory') or {}).get('id'),
                                'heading': heading, 'chars': len(text)})
            except MemoraError as e:
                failed.append({'index': index, 'heading': heading, 'error': e.message})
        if not created:
            raise InvalidInput('every section was rejected; nothing entered the queue')
        return {'parsed': len(chunks), 'created': created, 'failed': failed,
                'title': title, 'filename': filename, 'source': source}

    def _index_document(self, b, project):
        """POST /api/agent/document-chunks -- chunk ONE published revision into the document index.

        Distinct from POST /document-index above, which this does not touch: that one exports a
        revision into the MEMORY store and builds memory rows; this one writes doc_chunks /
        doc_chunk_fts / doc_chunk_embeddings rows, which is what memory_document_rag_context
        actually searches. Request {project, slug, audience?, version?, embed?}; respond with one
        document result plus corpus row counts and the generation counter.
        """
        embed = self._embed_flag(b)
        index = self.document_chunks()
        with self.runtime.lock:
            counts_before, gen_before = self._counts(index, project), self._generation(index)
            document = self._index_one(index, project, b.get('slug'), b.get('audience', 'human'),
                                       b.get('version'), embed)
            return self._write(index, 'document-chunks', project, embed, counts_before, gen_before,
                               [document])

    def _index_project(self, b, project):
        """POST /api/agent/document-chunks-project -- every published revision in the project.

        index_project already reports one bad revision instead of failing the batch; this adds the
        two things a caller cannot infer from it: whether the corpus actually moved (row counts and
        the generation counter), and which (slug, audience) pairs were skipped because they are
        still drafts. audience is passed through to index_project unchanged -- a retrieval FILTER,
        never a permission boundary.
        """
        embed = self._embed_flag(b)
        index = self.document_chunks()
        r = self.runtime
        with r.lock:
            counts_before, gen_before = self._counts(index, project), self._generation(index)
            report = index.index_project(project, embed=embed, audiences=b.get('audience'))
            documents = [{'slug': e['slug'], 'audience': e['audience'], 'version': e['version'],
                          'result': result, 'published': True, 'chunks': e['chunks'], 'written': 0,
                          'removed': 0,
                          'embedding': self._embed_report(embed, {'mode': report.get('mode'),
                                                                   'embedded': e.get('embedded', 0)})}
                         for result in ('indexed', 'unchanged')
                         for e in report.get(result, [])]
            documents += [{'slug': e.get('slug'), 'audience': e.get('audience'), 'version': None,
                           'result': 'error', 'published': True, 'chunks': 0, 'written': 0,
                           'removed': 0,
                           'embedding': self._embed_report(embed, {'mode': 'skipped'}),
                           'error': e.get('error'), 'message': e.get('message', '')}
                          for e in report.get('errors', [])]
            published = {(d['slug'], d['audience']) for d in r.documents.list(project)}
            drafts = [{'slug': d['slug'], 'audience': d['audience'], 'version': d['version'],
                       'result': 'skipped', 'reason': 'draft', 'published': False, 'chunks': 0,
                       'written': 0, 'removed': 0,
                       'embedding': self._embed_report(embed, {'mode': 'skipped'}),
                       'message': f"'{d['slug']}' / {d['audience']} v{d['version']} is an unpublished "
                                  'draft; only PUBLISHED revisions are indexable. Publish it, then '
                                  'index again.'}
                      for d in r.documents.list(project, drafts=True)
                      if (d['slug'], d['audience']) not in published]
            extra = {'skipped_drafts': len(drafts)}
            if report.get('warning'):
                extra['warning'] = report['warning']
            elif embed and not index.embedding:
                extra['warning'] = ('no embedding provider configured: chunks are indexed and '
                                    'FTS-searchable, but no vectors were written, so vector and '
                                    'hybrid retrieval stay empty')
            return self._write(index, 'document-chunks-project', project, embed, counts_before,
                               gen_before, documents + drafts, extra)


def make_server(runtime, port=8765):
    return http_server(runtime.store, port, review=True, agent=Workbench(runtime), assets=ASSETS, max_body=500000)
