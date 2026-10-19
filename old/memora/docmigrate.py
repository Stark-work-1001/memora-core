"""Version marker, drift detection, integrity check and backup for the DOCUMENT database.

Why this module exists (the gap it closes): `memora/docindex.py` owns the chunk tables
(`doc_chunks`, `doc_chunk_fts`, `doc_chunk_embeddings`, `doc_models`, `doc_meta`) in
`data/memora-documents.sqlite3`. Those tables are created with idempotent `CREATE TABLE IF NOT
EXISTS` and were, deliberately and with the cost named in docindex's docstring, left unversioned:
if the DDL ever changes, nothing notices that an existing database is older or different. There is
no formal migration framework here either, and there should not be one until the marker, the
integrity check and the backup prove insufficient.

The design is deliberately the smallest honest one:

* **The marker reuses `doc_meta`** (an existing key/value table in the same database) instead of
  inventing a second mechanism. Four keys: a schema version, a digest of the DDL, the timestamp the
  marker was first written and the timestamp it was last verified.
* **The digest is taken over a canonical form** of the DDL: comments stripped, whitespace collapsed,
  catalogue statements (CREATE TRIGGER) sorted. So a comment or a line break never looks like a
  schema change, while an added column, a changed type, a changed foreign key or a changed trigger
  body does. The version number is the coarse signal for humans; the digest is the fine one that
  catches an edit somebody forgot to version.
* **A mismatch is reported, never repaired silently.** This is the codebase's house style, not a
  preference: `memora/schema.py` refuses a database newer than the code and backs the database up
  before any migration; `memora/judge.py` fails closed on an unparseable model answer instead of
  guessing a default; `memora/errors.py` gives every refusal a stable code and a hint. Silently
  rewriting the shape of somebody's document index is exactly the plausible default those three
  rules exist to prevent, so `verify()` raises and the write path stops.
* **An existing, unmarked database is adopted, never rejected.** Every database created before this
  module existed has no marker; treating that as a mismatch would brick real installs. Adoption only
  records the marker, and `integrity()` then tells the operator whether the structure really is what
  the code expects.
* **Backup matches what the memory database already does** (`memora/store.py:438`): SQLite's online
  backup API into `backups/`, exclusive file creation so a backup can never overwrite another one,
  and `PRAGMA integrity_check` on the copy before it is reported as good.

What is deliberately NOT here: no migration runner, no version table with history, no automatic
upgrade. If the DDL changes, the operator restores a backup or rebuilds the chunk index with
`DocIndex.index_project`; that decision belongs to a person, not to an import.
"""
import contextlib
import hashlib
import re
import sqlite3
import uuid
from pathlib import Path

from .errors import SchemaError, SchemaTooNew
from .schema import now

# The coarse marker. Bump it whenever documents.DDL's meaning changes; `tests/test_doc_schema_versioning.py`
# fails when the DDL and this digest disagree, so the one cannot drift from the other unnoticed.
SCHEMA_VERSION = 1

VERSION_KEY = 'doc_schema_version'
DIGEST_KEY = 'doc_schema_ddl_sha256'
RECORDED_KEY = 'doc_schema_recorded'
VERIFIED_KEY = 'doc_schema_verified'
MARKER_KEYS = (VERSION_KEY, DIGEST_KEY, RECORDED_KEY, VERIFIED_KEY)

# Statements whose text is normalised per line; ordering between them carries no meaning.
_CATALOGUE = ('create trigger', 'create index', 'create unique index')

# What the chunk schema must contain for docindex's SQL to mean what it says. Column lists are the
# full published shape, not just the columns a query happens to read: a partial list would pass a
# table that has already lost a column the next release will use.
TABLES = {
    'doc_meta': ('key', 'value'),
    'doc_chunks': ('id', 'document', 'project', 'slug', 'audience', 'version', 'recorded_date',
                   'origin_uri', 'group_title', 'revision_sha256', 'seq', 'heading', 'line_start',
                   'line_end', 'tokens', 'digest', 'content', 'created'),
    'doc_chunk_fts': ('terms', 'chars', 'id'),
    'doc_chunk_embeddings': ('id', 'fingerprint', 'dim', 'digest', 'vector', 'created'),
    'doc_models': ('fingerprint', 'role', 'descriptor', 'canary', 'created'),
}

INDEXES = {
    'doc_chunks_scope': 'project/audience/slug filtering, used by every scoped query',
    'doc_chunks_rev': 'per-revision lookup and re-index',
    'doc_chunk_embeddings_fp': 'vector matrix load by model fingerprint',
}

# The generation counter is how a long-lived process notices a write made by another process; losing
# a trigger silently disables that, so each one is named here rather than assumed.
TRIGGERS = {
    'dc_gen_chunk_ins': 'chunk insert must bump doc_meta.generation',
    'dc_gen_chunk_upd': 'chunk update must bump doc_meta.generation',
    'dc_gen_chunk_del': 'chunk delete must bump doc_meta.generation',
    'dc_gen_emb_ins': 'vector insert must bump doc_meta.generation',
    'dc_gen_emb_upd': 'vector update must bump doc_meta.generation',
    'dc_gen_emb_del': 'vector delete must bump doc_meta.generation',
}

# (table, column, referenced table, referenced column, on delete). ON DELETE CASCADE is the point:
# deleting a document or a chunk must take its vectors and postings with it, or a citation survives
# the text it cites.
FOREIGN_KEYS = (
    ('doc_chunks', 'document', 'docs', 'id', 'CASCADE'),
    ('doc_chunk_embeddings', 'id', 'doc_chunks', 'id', 'CASCADE'),
)


class DocSchemaMismatch(SchemaError):
    """The document database is not the shape this code requires. Never repaired automatically."""
    code = 'doc_schema_mismatch'


class DocSchemaTooNew(SchemaTooNew):
    """The document database was written by a newer Memora. Nothing is modified."""
    code = 'doc_schema_too_new'


@contextlib.contextmanager
def connect(db):
    """Open the document database the way Documents.connect does: foreign keys on, commit on exit."""
    c = sqlite3.connect(db, timeout=15)
    c.row_factory = sqlite3.Row
    c.execute('PRAGMA foreign_keys=ON')
    try:
        with c: yield c
    finally: c.close()


def canonical(statements=()):
    """The DDL in a form that ignores formatting but not meaning.

    Comments and blank lines are dropped, runs of whitespace collapse to one space, and the
    catalogue statements (triggers, indexes) are sorted because the order they are created in says
    nothing about the schema. Two schema changes survive: a changed token sequence (a column, a type,
    a foreign key, a trigger body) changes the digest; a reflowed comment does not.
    """
    def one(statement):
        lines = []
        for raw in statement.splitlines():
            line = raw.split('--', 1)[0]      # the DDL only ever uses line comments
            line = ' '.join(line.split())
            if line:
                lines.append(line)
        return ' '.join(lines)

    body = [one(s) for s in statements if one(s)]
    plain = [s for s in body if not s.lower().startswith(_CATALOGUE)]
    catalogue = sorted(s for s in body if s.lower().startswith(_CATALOGUE))
    return '\n'.join(plain + catalogue)


def digest(statements=()):
    """Stable digest of the chunk DDL. Call with the live `docindex.DDL`; docindex re-exports it."""
    return hashlib.sha256(canonical(statements).encode('utf-8')).hexdigest()


def _meta(c, key):
    row = c.execute('SELECT value FROM doc_meta WHERE key=?', (key,)).fetchone()
    return None if row is None else row[0]


def _set_meta(c, key, value):
    c.execute('INSERT OR REPLACE INTO doc_meta VALUES(?,?)', (key, value))


def _stamp(c, version, sha, recorded=None):
    _set_meta(c, VERSION_KEY, str(version))
    _set_meta(c, DIGEST_KEY, sha)
    _set_meta(c, RECORDED_KEY, recorded or now())
    _set_meta(c, VERIFIED_KEY, now())


def marker(c):
    """The recorded marker, or None when this database predates it (or never had the chunk schema)."""
    if not c.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='doc_meta'").fetchone():
        return None
    version, sha = _meta(c, VERSION_KEY), _meta(c, DIGEST_KEY)
    if version is None and sha is None:
        return None
    return {'version': int(version) if version is not None else None,
            'ddl_sha256': sha,
            'recorded': _meta(c, RECORDED_KEY),
            'verified': _meta(c, VERIFIED_KEY)}


def preflight(c, statements=()):
    """Decide, WITHOUT writing anything, whether this database is the one this code can work with.

    Run before the DDL, so a refusal leaves the database byte-identical: the whole point of failing
    closed is that a caller who cannot trust the schema does not get to add to it. Returns one of

    * `{'status': 'created'}`     nothing here yet, or a document database that was saved before the
                                   chunk index existed -- build it;
    * `{'status': 'adopted'}`     the chunk schema exists with no marker, i.e. it was built by a
                                   Memora older than this marker. Adopt it: refusing here would brick
                                   every existing installation, and the real structural truth is
                                   reported by `integrity()` rather than assumed;
    * `{'status': 'ok'}`          the recorded marker matches this code exactly;
    * `{'status': 'incomplete'}`  a marker matching this code, but a table or trigger is missing, so
                                   the DDL below will repair it;
    * `{'status': 'empty'}`       a marker from another version, and no chunk data at all: the
                                   index is derived data, so the tables are dropped and rebuilt.

    Anything else raises `DocSchemaTooNew` or `DocSchemaMismatch`.
    """
    sha = digest(statements)
    if not c.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='doc_meta'").fetchone():
        return {'status': 'created', 'ddl_sha256': sha, 'schema_version': SCHEMA_VERSION}

    with_marker = marker(c)
    if with_marker is None:
        if c.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='doc_chunks'").fetchone():
            return {'status': 'adopted', 'marker': None, 'ddl_sha256': sha, 'schema_version': SCHEMA_VERSION}
        return {'status': 'created', 'marker': None, 'ddl_sha256': sha, 'schema_version': SCHEMA_VERSION}

    found = with_marker['version']
    if found is not None and found > SCHEMA_VERSION:
        raise DocSchemaTooNew(
            f'document chunk schema v{found} is newer than this Memora (v{SCHEMA_VERSION})',
            hint='upgrade memora; the document database was not modified',
            found=found, expected=SCHEMA_VERSION, database='memora-documents.sqlite3')

    problems = []
    if found is not None and found != SCHEMA_VERSION:
        problems.append(f'the recorded schema version is v{found} but this code writes v{SCHEMA_VERSION}')
    if with_marker['ddl_sha256'] != sha:
        problems.append('the recorded DDL digest is ' + str(with_marker['ddl_sha256'])[:12]
                        + ' but this code computes ' + sha[:12])
    if problems:
        chunks = c.execute("SELECT count(*) FROM doc_chunks").fetchone()[0] if \
            c.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='doc_chunks'").fetchone() else 0
        if chunks == 0:
            # No chunks means no citable data: the chunk index is derived from the published revisions
            # and is rebuilt by re-indexing, so dropping the tables loses nothing a user authored.
            return {'status': 'empty', 'marker': with_marker, 'ddl_sha256': sha,
                    'schema_version': SCHEMA_VERSION, 'problems': problems}
        raise DocSchemaMismatch(
            'document chunk schema does not match this Memora: ' + '; '.join(problems),
            hint='the chunk index is derived data: re-run index_project to rebuild it, or restore a '
                 'backup; nothing was modified',
            recorded_version=found, recorded_sha256=with_marker['ddl_sha256'], expected_sha256=sha,
            chunks=chunks, schema_version=SCHEMA_VERSION, database='memora-documents.sqlite3')

    objects = _objects(c)
    missing = [n for n in list(TABLES) + list(INDEXES) + list(TRIGGERS) if n not in objects]
    return {'status': 'incomplete' if missing else 'ok', 'marker': with_marker, 'ddl_sha256': sha,
            'schema_version': SCHEMA_VERSION, 'missing': missing}


def verify(c, statements=()):
    """Record the marker after the DDL ran, or confirm the one already there.

    Idempotent, and safe to call on a database `preflight` approved. It never repairs a mismatch: the
    refusal happened in `preflight`, before any write.
    """
    sha = digest(statements)
    with_marker = marker(c)
    if with_marker is None:
        _stamp(c, SCHEMA_VERSION, sha)
        return {'status': 'adopted', 'marker': marker(c), 'ddl_sha256': sha,
                'schema_version': SCHEMA_VERSION, 'adopted': True, 'integrity_checked': False}
    _stamp(c, SCHEMA_VERSION, sha, recorded=with_marker['recorded'])
    return {'status': 'ok', 'marker': marker(c), 'ddl_sha256': sha, 'schema_version': SCHEMA_VERSION,
            'adopted': False, 'integrity_checked': False}


_CREATED = re.compile(r'CREATE\s+(?:VIRTUAL\s+)?(TABLE|INDEX|TRIGGER)\s+IF\s+NOT\s+EXISTS\s+(\w+)',
                    re.I)


def created_objects(statements=()):
    """{table: [...], index: [...], trigger: [...]} parsed out of the DDL, in creation order."""
    out = {'table': [], 'index': [], 'trigger': []}
    for statement in statements:
        found = _CREATED.search(statement)
        if found:
            out[found.group(1).lower()].append(found.group(2))
    return out


def drop_chunk_schema(c, statements=()):
    """Drop the tables, indexes and triggers this DDL creates, dependants first.

    Only ever called for an EMPTY chunk index (see `preflight`): the index is derived from published
    revisions, so this discards nothing a user authored. Tables are dropped in reverse creation order
    because a later one references an earlier one.
    """
    created, objects = created_objects(statements), _objects(c)
    dropped = []
    for trigger in created['trigger']:
        if trigger in objects:
            c.execute('DROP TRIGGER IF EXISTS "%s"' % trigger)
            dropped.append(trigger)
    for index in created['index']:
        if index in objects:
            c.execute('DROP INDEX IF EXISTS "%s"' % index)
            dropped.append(index)
    for table in reversed(created['table']):
        if table in objects:
            c.execute('DROP TABLE IF EXISTS "%s"' % table)
            dropped.append(table)
    return {'dropped': dropped}


# --- structural integrity ------------------------------------------------------------------------

def _objects(c):
    # Indexes included: sqlite_master stores them as rows too, and three of them are load-bearing.
    return {r['name']: (r['sql'] or '') for r in c.execute(
        "SELECT name, sql FROM sqlite_master WHERE type IN ('table','view','trigger','index')")}


def _columns(c, table):
    return [r['name'] for r in c.execute('PRAGMA table_info("%s")' % table)]


def integrity(c, statements=(), deep=True):
    """Check the document database against the schema this code expects. Never returns 'ok' it could
    not establish: a file too corrupt to inspect raises like any other structural failure."""
    try:
        return _integrity(c, statements, deep)
    except sqlite3.DatabaseError as e:
        raise DocSchemaMismatch(
            'document database cannot be inspected: ' + str(e)[:300],
            hint='restore a backup under backups/; a database that cannot be read cannot be verified, '
                 'and guessing would be worse than refusing',
            error=str(e)[:300], database='memora-documents.sqlite3') from e


def _integrity(c, statements=(), deep=True):
    """Check the document database against the schema this code expects.

    Returns a report with 'ok' true only when every check passed. It FAILS LOUDLY: a structural
    failure raises `DocSchemaMismatch` with the list of problems, because a check that answers "ok"
    when it cannot determine the truth is worse than no check. A marker mismatch is included, so one
    call answers "is this database usable by this code, and is it intact".

    `deep` additionally runs SQLite's own page-level `PRAGMA integrity_check`. It is on by default
    because this is an operator-facing call, not a per-query one.
    """
    objects = _objects(c)
    problems = []

    missing_tables = [t for t in TABLES if t not in objects]
    for table in missing_tables:
        problems.append(f'missing table {table}')
    for table, expected in TABLES.items():
        if table in missing_tables:
            continue
        actual = _columns(c, table)
        if not actual:
            problems.append(f'table {table} exists but has no readable columns')
            continue
        missing = [col for col in expected if col not in actual]
        if missing:
            problems.append(f'table {table} is missing column(s): ' + ', '.join(missing))
        if table == 'doc_chunk_fts':
            sql = objects.get(table, '').lower()
            if 'fts5' not in sql or 'virtual table' not in sql:
                problems.append('doc_chunk_fts is not an FTS5 virtual table, so MATCH and bm25() cannot work')

    for index, why in INDEXES.items():
        if index not in objects:
            problems.append(f'missing index {index} ({why})')
    for trigger, why in TRIGGERS.items():
        if trigger not in objects:
            problems.append(f'missing trigger {trigger} ({why})')

    for table, column, ref_table, ref_column, on_delete in FOREIGN_KEYS:
        if table in missing_tables or ref_table not in objects:
            continue
        keys = [dict(r) for r in c.execute('PRAGMA foreign_key_list("%s")' % table)]
        match = [k for k in keys if k['from'] == column and k['table'] == ref_table
                 and k['to'] == ref_column]
        if not match:
            problems.append(f'{table}.{column} has no foreign key to {ref_table}.{ref_column}')
        elif str(match[0]['on_delete']).upper() != on_delete:
            problems.append(f'{table}.{column} foreign key deletes with {match[0]["on_delete"]}, not {on_delete}')

    # A table can be listed in sqlite_master and still be unreadable (corrupt pages, broken FTS
    # shadow tables). Probe each one; a failure here is a structural failure, not a warning.
    for table in TABLES:
        if table in missing_tables:
            continue
        try:
            c.execute('SELECT count(*) FROM "%s"' % table).fetchone()
        except sqlite3.DatabaseError as e:
            problems.append(f'table {table} cannot be read: {e}')

    if statements and not problems:
        try:
            recorded = marker(c)
            sha = digest(statements)
            if recorded is not None and recorded['ddl_sha256'] not in (None, sha):
                problems.append(
                    'recorded DDL digest ' + str(recorded['ddl_sha256'])[:12] + ' does not match the code ' + sha[:12])
            if recorded is not None and recorded['version'] not in (None, SCHEMA_VERSION):
                problems.append(f'recorded schema version v{recorded["version"]} is not v{SCHEMA_VERSION}')
        except sqlite3.DatabaseError as e:
            problems.append(f'doc_meta cannot be read: {e}')

    violations = []
    try:
        violations = [tuple(r) for r in c.execute('PRAGMA foreign_key_check')]
    except sqlite3.DatabaseError as e:
        problems.append(f'foreign_key_check could not run: {e}')
    if violations:
        problems.append(f'{len(violations)} foreign key violation(s), first: {violations[0]}')

    page = None
    if deep:
        try:
            page = c.execute('PRAGMA integrity_check').fetchone()[0]
        except sqlite3.DatabaseError as e:
            problems.append(f'integrity_check could not run: {e}')
        else:
            if page != 'ok':
                problems.append('integrity_check: ' + str(page)[:400])

    if problems:
        raise DocSchemaMismatch(
            'document database failed its structural check: ' + '; '.join(problems[:12]),
            hint='restore a backup under backups/ (memora.ops.restore applies to the memory database '
                 'only); the chunk index is derived data and can be rebuilt with DocIndex.index_project',
            problems=problems, database='memora-documents.sqlite3',
            checked={'tables': len(TABLES), 'indexes': len(INDEXES), 'triggers': len(TRIGGERS),
                     'foreign_keys': len(FOREIGN_KEYS), 'deep': bool(deep)})

    return {'ok': True, 'database': 'memora-documents.sqlite3', 'problems': [],
            'tables': sorted(TABLES), 'indexes': sorted(INDEXES), 'triggers': sorted(TRIGGERS),
            'foreign_keys': [list(k) for k in FOREIGN_KEYS], 'integrity_check': page, 'deep': bool(deep),
            'marker': marker(c)}


# --- backup and restore --------------------------------------------------------------------------

def backup(c, folder):
    """Online backup of the open document database into `folder`, verified before it is reported.

    The shape is `store.backup`'s: SQLite's backup API, exclusive creation so a backup never
    replaces another one, and `PRAGMA integrity_check` on the copy. A copy that fails verification
    is deleted and the error propagates: a backup nobody verified is not a backup.
    """
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    stamp_ = now().replace(':', '').replace('-', '').split('.')[0]
    target = folder / f'documents-{stamp_}Z-{uuid.uuid4().hex[:8]}.sqlite3'
    with target.open('xb'): pass      # exclusive creation: never overwrite an existing backup
    if c.in_transaction:
        # A source connection holding an open write transaction makes SQLite's backup API return
        # SQLITE_LOCKED, and Python's Connection.backup retries that forever -- a silent hang instead
        # of an error. schema._backup documents the same trap. Commit the caller's pending work so the
        # snapshot is taken from a state the caller meant to keep.
        c.commit()
    try:
        dest = sqlite3.connect(target)
        try:
            c.backup(dest)
            ok = dest.execute('PRAGMA integrity_check').fetchone()[0]
            tables = dest.execute("SELECT count(*) FROM sqlite_master WHERE type='table'").fetchone()[0]
        finally:
            dest.close()
        if ok != 'ok':
            raise DocSchemaMismatch('document backup failed integrity_check; the copy was removed',
                                    copy=str(target), integrity=ok)
    except BaseException:
        if target.exists():
            target.unlink()
        raise
    return {'backup': str(target), 'integrity': ok, 'tables': tables}


def restore(backup_path, target_dir, statements=None):
    """Restore a document backup into a NEW directory and verify it before it is handed over.

    Same contract as `memora/ops.py`'s restore for the memory database: refuse a non-empty target,
    copy, then prove the result. Nothing is switched over automatically -- the operator stops the
    writers and points the process at the restored directory.
    """
    if statements is None:
        from .docindex import DDL  # local: docindex imports this module, not the other way round
        statements = DDL
    source, target = Path(backup_path).resolve(), Path(target_dir).resolve()
    if not source.is_file():
        raise ValueError('document backup not found: ' + str(source))
    if target.exists() and any(target.iterdir()):
        raise ValueError('restore target must be a new or empty directory')
    target.mkdir(parents=True, exist_ok=True)
    # Fixed name: Documents.__init__ opens exactly <root>/memora-documents.sqlite3, so a restored copy
    # under the backup's own file name would be invisible to the application.
    destination = target / 'memora-documents.sqlite3'

    src = sqlite3.connect(f'file:{source.as_posix()}?mode=ro', uri=True)
    dst = sqlite3.connect(destination)
    try:
        if src.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise DocSchemaMismatch('document backup failed integrity_check; nothing was restored',
                                    backup=str(source))
        src.backup(dst)
    finally:
        dst.close()
        src.close()

    with connect(destination) as c:
        # The restored copy must PROVE it is the document database, not merely exist: restore is
        # where a wrong file silently becomes the live store.
        for table in ('docs', 'revisions'):
            if not c.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone():
                raise DocSchemaMismatch('the file restored is not a document database: no ' + table + ' table',
                                        backup=str(source))
        state = verify(c, statements)
        report = integrity(c, statements)
        counts = {t: c.execute('SELECT count(*) FROM "%s"' % t).fetchone()[0] for t in TABLES
                  if c.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (t,)).fetchone()}
    return {'restored_to': str(destination), 'integrity': 'ok', 'schema': state,
            'structural_check': report['ok'], 'tables': counts,
            'note': 'the restored documents database is not switched over automatically: stop the writers '
                    'and point the process at the restored directory'}
