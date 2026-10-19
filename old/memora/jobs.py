"""Durable accumulation queue with leases, idempotency and recoverable failures."""
import contextlib
import hashlib
import json
import sqlite3
import threading
import time
import uuid

from .errors import Conflict, InvalidInput, NotFound
from .schema import now
from .store import scope


class Jobs:
    def __init__(self, runtime):
        self.runtime = runtime
        self.db = runtime.store.root / 'memora-jobs.sqlite3'
        self.stop = threading.Event(); self.thread = None
        with self.connect() as c:
            c.executescript('''CREATE TABLE IF NOT EXISTS jobs(
              id TEXT PRIMARY KEY,project TEXT NOT NULL,kind TEXT NOT NULL,event_key TEXT NOT NULL,
              input TEXT NOT NULL,digest TEXT NOT NULL,status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,
              available REAL NOT NULL,lease REAL NOT NULL DEFAULT 0,owner TEXT NOT NULL DEFAULT '',
              output TEXT NOT NULL DEFAULT '{}',error TEXT NOT NULL DEFAULT '',created TEXT NOT NULL,updated TEXT NOT NULL,
              UNIQUE(project,kind,event_key));
              CREATE INDEX IF NOT EXISTS jobs_ready ON jobs(status,available,lease);''')

    @contextlib.contextmanager
    def connect(self):
        c = sqlite3.connect(self.db, timeout=15); c.row_factory = sqlite3.Row
        try:
            with c: yield c
        finally: c.close()

    @staticmethod
    def public(row):
        value = dict(row); value['input'] = json.loads(value['input']); value['output'] = json.loads(value['output'])
        return value

    def enqueue(self, project, kind, event_key, body):
        project = scope(project)
        if kind != 'absorb' or not isinstance(event_key, str) or not 1 <= len(event_key) <= 240: raise InvalidInput('invalid job kind or event key')
        raw = json.dumps(body, sort_keys=True, ensure_ascii=False, allow_nan=False)
        if len(raw) > 20000: raise InvalidInput('job metadata too large')
        digest = hashlib.sha256(raw.encode()).hexdigest()
        with self.connect() as c:
            c.execute('BEGIN IMMEDIATE')
            old = c.execute('SELECT * FROM jobs WHERE project=? AND kind=? AND event_key=?', (project, kind, event_key)).fetchone()
            if old:
                if old['digest'] != digest: raise Conflict('event_id already refers to different input')
                return self.public(old)
            ident = str(uuid.uuid4()); stamp = now()
            c.execute('INSERT INTO jobs(id,project,kind,event_key,input,digest,status,available,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?)',
                      (ident, project, kind, event_key, raw, digest, 'queued', time.time(), stamp, stamp))
        return self.get(project, ident)

    def get(self, project, id):
        with self.connect() as c: row = c.execute('SELECT * FROM jobs WHERE id=? AND project=?', (id, scope(project))).fetchone()
        if row is None: raise NotFound('job not found')
        return self.public(row)

    def list(self, project):
        with self.connect() as c: rows = c.execute('SELECT * FROM jobs WHERE project=? ORDER BY created DESC LIMIT 100', (scope(project),)).fetchall()
        return [self.public(row) for row in rows]

    def retry(self, project, id):
        with self.connect() as c:
            c.execute('BEGIN IMMEDIATE'); row = c.execute('SELECT * FROM jobs WHERE id=? AND project=?', (id, scope(project))).fetchone()
            if row is None: raise NotFound('job not found')
            if row['status'] == 'running' and row['lease'] > time.time(): raise Conflict('job is active')
            if row['status'] == 'done': raise Conflict('completed job does not need a retry')
            c.execute("UPDATE jobs SET status='queued',attempts=0,available=0,lease=0,owner='',error='',updated=? WHERE id=?", (now(), id))
        return self.get(project, id)

    def run_one(self):
        owner = str(uuid.uuid4()); current = time.time()
        with self.connect() as c:
            c.execute('BEGIN IMMEDIATE')
            c.execute("UPDATE jobs SET status='failed',error='lease_expired',lease=0,updated=? WHERE status='running' AND lease<? AND attempts>=5", (now(), current))
            row = c.execute("SELECT * FROM jobs WHERE ((status IN ('queued','retry') AND available<=?) OR (status='running' AND lease<?)) AND attempts<5 ORDER BY created LIMIT 1", (current, current)).fetchone()
            if row is None: return None
            c.execute("UPDATE jobs SET status='running',attempts=attempts+1,lease=?,owner=?,updated=? WHERE id=?", (current + 180, owner, now(), row['id']))
        # A heartbeat extends the lease while a slow model is working.
        finished = threading.Event()
        def renew():
            while not finished.wait(30):
                with self.connect() as c: c.execute('UPDATE jobs SET lease=? WHERE id=? AND owner=?', (time.time() + 180, row['id'], owner))
        threading.Thread(target=renew, daemon=True).start()
        try:
            output = self.runtime.accumulation.process(row['project'], json.loads(row['input']), row['id'])
            status, error, delay = 'done', '', 0
        except Exception as exc:
            output = {}; status = 'retry' if row['attempts'] < 4 else 'failed'
            error = getattr(exc, 'code', type(exc).__name__); delay = min(300, 10 * 2 ** row['attempts'])
        finally: finished.set()
        with self.connect() as c:
            c.execute('UPDATE jobs SET status=?,output=?,error=?,available=?,lease=0,updated=? WHERE id=? AND owner=?',
                      (status, json.dumps(output, ensure_ascii=False), error, time.time() + delay, now(), row['id'], owner))
        return self.get(row['project'], row['id'])

    def start(self):
        if self.thread and self.thread.is_alive(): return
        def loop():
            while not self.stop.is_set():
                try: worked = self.run_one()
                except Exception: worked = None
                if not worked: self.stop.wait(1)
        self.thread = threading.Thread(target=loop, name='memora-accumulation', daemon=True); self.thread.start()

    def close(self):
        self.stop.set()
        if self.thread: self.thread.join(timeout=3)
