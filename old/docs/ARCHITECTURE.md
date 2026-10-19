# Architecture

Memora is a local-first agent memory application. One source tree produces one desktop build; the
same `memora/` package answers the MCP surface, the workbench UI and the CLI. This document
describes the layers as they exist in **1.3.0**, the decisions that fix each boundary, and the
lifecycle of the desktop shell that owns the backend process.

Transport contracts live in [TRANSPORT.md](TRANSPORT.md). This file explains *why* the layers are
shaped this way; that one explains *what a caller can rely on*.

Development upgrade: `knowledge.py` fuses approved memory, published document chunks and archived
turns with typed trust and citations, optional stored-edge expansion, then optional Rerank.
`workflow_templates.py` supplies eight editable recipes. Model profiles declare chat / embedding /
rerank capability; workflow execution calls the matching provider interface. The MCP surface now has
26 tools. Source launch and default backend builds stay inside this checkout; standalone updates
require separate user authorization. See [UPGRADE-MEMORY-SYSTEM.md](UPGRADE-MEMORY-SYSTEM.md).

---

## 1. Layers

```text
  TRANSPORT        http.server (loopback only)        MCP stdio / Streamable HTTP
                   LoopbackHTTPServer, HTTP/1.1,       gateway.py on 18184
                   keep-alive, gzip, 100 req/conn
                        |                                       |
  ADAPTER          workbench.py  (Workbench: /api/agent/*)  |  mcp.py (22 tools)
                        |                                       |
  SERVICE          core.py    MemoryRuntime - settings, providers, lifecycle
                   service.py retrieval, evidence packs       accumulation.py durable extraction
                   workflows.py document stages              jobs.py leased queue
                        |
  STORE            SQLite (WAL), schema v2 - the single source of truth
                   memories, documents, sessions, edges, embeddings, judgements, audit, outbox
                        |
  PROVIDERS        embedding / judge over OpenAI-compatible HTTP (llama.cpp, vLLM, cloud)
                        |
  NATIVE           memora_native (Rust / PyO3) - exact top-k and RRF hot loops
```

Each layer may call the one below it and must not reach past it. `workbench.py` and `mcp.py` are
siblings: both are adapters over the same runtime, which is why a feature added to one is not
automatically present in the other.

### Layer responsibilities

| Layer | Files | Responsibility |
| --- | --- | --- |
| Transport | `web.py`, `gateway.py`, `stdio.py` | Sockets, HTTP semantics, MCP wire protocol. No product decisions. |
| Adapter | `workbench.py`, `mcp.py` | Route/tool tables, argument parsing, error-to-JSON mapping. |
| Service | `core.py`, `service.py`, `accumulation.py`, `workflows.py`, `jobs.py`, `docindex.py` | Lifecycle, retrieval fusion, model orchestration, document indexing. |
| Store | `store.py`, `schema.py`, `text.py`, `vectors.py`, `mirror.py` | Transactions, DDL and migration, analysis, embedding codec, Markdown mirror. |
| Providers | `providers.py`, `judge.py`, `model_registry.py`, `chat_models.py` | HTTP model clients, fingerprints, prompt schemas. |
| Native | `native/` | Compiled top-k and fusion. Optional: a pure-Python path covers its absence. |

---

## 2. Transport layer

The workbench used to be a bare `ThreadingHTTPServer`, i.e. the stdlib defaults: a listen backlog of
5 and HTTP/1.0. A single page load opens more sockets than that at once (static assets, the
`/api/agent/*` polls, the SSE stream). Measured failure: **24 of 50 concurrent GETs to
`/api/agent/status` returned ECONNREFUSED while 200 sequential ones all succeeded.**

The server is now `LoopbackHTTPServer` in `memora/web.py`. Four decisions follow from that.

### 2.1 Backlog 128

A connect that arrives while the accept loop is busy in another handler waits in the kernel backlog;
past its depth the kernel refuses it outright. That refusal *is* the ECONNREFUSED above.

128 because one page offers more than six simultaneous connects, and several tabs plus their SSE
streams plus a burst of status polls must fit. An unaccepted connection costs a socket, not a thread,
so a generous backlog is cheap — and a backlog that fills up is exactly the failure being fixed.

`allow_reuse_address` is already the `HTTPServer` default, but it is restated: restarting the
workbench while the previous socket sits in `TIME_WAIT` must not fail with "address already in use".
`daemon_threads` keeps a request thread from blocking interpreter exit.

### 2.2 HTTP/1.1, and why every response needs a Content-Length

HTTP/1.0 closed the connection after every response, so the browser could not reuse a socket and kept
offering new ones — it made the backlog problem worse. HTTP/1.1 keeps the connection open, which is
what stops the re-connection storm.

It is only safe **because every response carries an explicit `Content-Length`**. Under 1.1 a response
without one leaves the client waiting for a body that never ends: the connection hangs instead of
failing, which is strictly worse than a refused connection because nothing times out and nothing
retries. The one deliberate exception is the SSE stream, which has no length by definition and ends
by closing the connection.

Consequences that are not optional:

- `send_error` is overridden. The inherited one writes `Connection: close` and a length but no CSP
  and no `nosniff`, so an error page was the one response served without them — and it answers the
  Host-header rejection, i.e. exactly what a DNS-rebinding page sees.
- A rejected request body must be **drained** before the next request is read, or it becomes that
  request's request line. `DISCARD_MAX` (1 MB) bounds what the server will read just to stay in
  sync; anything larger, or of unknown length, ends the connection instead — draining bytes it could
  not report on would be a way to occupy a thread.

### 2.3 gzip with `compressobj(16 + MAX_WBITS)`

Large bodies are gzipped when the client offers it, above `GZIP_MIN_BYTES = 1400`. Below that,
gzip framing (header plus 18 bytes of deflate overhead) costs more than it saves on a loopback
socket: the workbench's own assets are 3 KB and up and cross the line, while small JSON status
replies stay uncompressed.

The compressor is built as `zlib.compressobj(6, zlib.DEFLATED, 16 + zlib.MAX_WBITS)` rather than
the obvious `zlib.compress()`:

- `zlib.compress()` emits the **bare zlib format, RFC 1950** — a 2-byte header and an Adler-32
  trailer. It is not gzip.
- `16 + MAX_WBITS` (= 31) asks zlib for the **gzip wrapper, RFC 1952**, which is what
  `Content-Encoding: gzip` promises.
- A browser handed an RFC 1950 stream labelled as gzip fails with "incorrect header check", which
  is a decode error on a body that arrived perfectly intact.

Compression never fails a response: a compressor exception returns the plain body, which is valid
for a client that accepts gzip. Every response also carries `Vary: Accept-Encoding` so a cache can
never hand a gzip body to a client that asked for identity (or the reverse).

### 2.4 100 requests per connection

Keep-alive means a closed tab can leave a socket open until its FIN/RST arrives. Capping the requests
served on one connection at `MAX_REQUESTS_PER_CONNECTION = 100` guarantees the handler loop exits
and its thread is reclaimed, so a page that holds a socket open cannot pin a thread for the lifetime
of the process.

### 2.5 What did not change

The 127.0.0.1 bind and the Host-header allowlist (`127.0.0.1:port`, `localhost:port`) are untouched;
they are what blocks DNS rebinding. CSP, `nosniff`, `no-store` and `Referrer-Policy` are still on
every response, now including error pages. Measured after the change: **200 concurrent requests,
0 failures**; `memory.js` dropped from 148,191 to 50,125 bytes with gzip enabled.

---

## 3. Desktop shell lifecycle

The shell used to be a one-shot launcher: read one stdout line, load the window, treat any backend
exit as fatal. On a machine where nothing goes wrong that is fine; an occupied port, a cold start
slower than the timeout, or a backend that dies twenty minutes later all produced the same outcome —
a dialog with one sentence and no record of what happened.

`desktop/main.cjs` is now a supervisor. `desktop/health.cjs` holds everything testable without
Electron, so `desktop/scripts/selftest-shell.mjs` can drive it directly.

```text
  START      data dir resolved -> logger opened -> adopt managed backend if one is running
                |
  SPAWN      port chosen (18765..18795) -> backend spawned -> TEMP/TMP pinned inside <data>/.tmp
                |
  READY      stdout /^Memora: (http:\/\/127\.0\.0\.1:\d+)/  OR  GET /api/agent/status
             first signal that validates name/version/data_dir wins; 45s budget, 250ms poll
                |
  SERVE      BrowserWindow loads the workbench; supervisor armed on the child's exit event
                |
  SUPERVISE  unexpected exit -> reconnect page -> restart with backoff 500 / 1500 / 4000 ms
             (max 3 attempts); deliberate quit sets the flag first and never restarts
                |
  EXIT       will-quit defers once -> taskkill /T /F the process tree (2.5s budget) -> quit
```

### Why each step exists

**Port selection.** The packaged app uses 18765 (falls back to 18795), outside the ranges
`dev-serve.ps1` and `runtime_manager.py` use, so a dev session and a packaged copy can run
together. `health.pickPort` binds each candidate with `exclusive: true` to find the first free one.
An explicitly requested `MEMORA_PORT` is treated as a contract: if it is taken the shell reports it
rather than silently moving.

**Readiness is a probe, not an announcement.** The stdout line only proves a socket was bound. Three
Memora stores can be listening on three ports at once — development, packaged, a leftover — and
attaching the window to the wrong one writes into the wrong database. So readiness means
`GET /api/agent/status` returns `name == "memora"`, the `version` matches the shell's own, and
`data_dir` matches the directory this shell resolved (compared case-insensitively on Windows).
The stdout line stays as a fast path and as the only way to learn the address when the backend picks
its own port.

The probe pins `Accept-Encoding: identity` on purpose: it needs nine hundred bytes of JSON, and a
readiness check that can be failed by a compression bug is a readiness check with a second failure
mode.

**Startup failure is not a crash.** The supervisor listener is attached only *after* readiness. A
child that dies during startup is a startup failure handled by `startBackend`, not something to
recover from.

**Restart is bounded.** Three attempts with growing backoff ride out a transient failure (a locked
database during a backup, a slow antivirus scan) without hiding a permanent one behind a loop.
Unlimited retries would turn a broken install into a window that flickers forever.

**The reconnect page is a `data:` URL with no script.** A blank window is indistinguishable from a
hung application, and the user's only move then is to kill and relaunch — the behaviour this
supervisor exists to replace. A data URL works precisely when the process that would serve assets is
the thing that is down.

**Process tree, not process.** On Windows `child.kill()` signals one process. A backend that forked
a worker keeps the SQLite file open through the grandchild, and the next launch meets a locked
database. `killTree` runs `taskkill /PID <pid> /T /F` detached so it finishes even if the shell
exits first.

**`TEMP`/`TMP` pinned inside the data directory.** SQLite spills temporary files during
`ALTER TABLE` / `CREATE INDEX` and on Windows cannot do that across volumes: a data directory on
`D:` with `TEMP` on `C:` fails with the bare "unable to open database file" on first run.

**Diagnostics outlive the session.** `<data>/desktop.log` is append-only, rolls at 1 MB keeping the
tail, and redacts credentials on the way in — a Python traceback can quote a request header and
stderr is logged verbatim. A support report that says "it did not start" is unactionable; one that
says "port 18765 busy, 18766 chosen, backend rejected the status probe after 45s" is a fix.

**Security boundaries are unchanged.** `contextIsolation`/`sandbox` on, `nodeIntegration` off,
only the origin this shell launched is navigable, every permission request is denied, external links
are https-only with no credentials, query or fragment. None of that is relaxed for diagnostics; the
log strips credentials instead.

---

## 4. Data model highlights

- **Memories** carry `kind` (memory/chunk), `polarity`, `norm_digest`, `doc_id`, `session_id`,
  `locator` (citable provenance), `access_count`, `last_accessed` and `valid_until`. Columns were
  added with `ALTER TABLE`, so older rows migrate in place.
- **Scopes.** A project is a namespace. The reserved scope `:user` holds durable personal
  preferences and is searched together with every project; project results are marked
  `scope: project` and take precedence in the profile.
- **Sightings** record each additional source that captured the same normalised content. `support`
  (distinct sources) is a corroboration signal shown to reviewers, not a truth score.
- **Edges** are explicit and typed. `supersedes` is enforced; `contradicts` is surfaced for a human
  to resolve and never auto-resolved.
- **Documents** group chunks for per-document review; re-importing a changed file creates a new
  version that supersedes the old one on approval.
- **Sessions/turns** are an archive, redacted and searchable, kept apart from curated memory.

---

## 5. Retrieval

1. **Lexical.** `text.analyze` applies NFKC + casefold; runs of unspaced scripts (Han, kana,
   Hangul, Thai, ...) become overlapping bigrams plus unigrams in a separate column; other text
   stays as words. FTS5 with `porter unicode61` indexes these terms. Queries are analysed the same
   way, drop function words, add a prefix match for Latin words, and are OR-ed as quoted phrases so
   user input is inert as FTS syntax. BM25 ranks with column weights terms 1.0, chars 0.4, tags 1.5.
2. **Vector** (when configured). The query is embedded with the model's query template (Qwen3:
   `Instruct: {task}\nQuery:{text}`) and compared exactly against the cached matrix of vectors
   whose fingerprint matches the configured model and whose digest matches the memory.
3. **Fusion.** RRF (k = 60) with weights lexical 0.01, vector 1.0 — effectively vector order, with
   lexical breaking ties and backfilling memories that have no vector yet. Each result reports
   `signals` (lexical rank, vector rank, similarity).
4. **Degradation is explicit.** If embeddings are unavailable, drifted, or cover only part of the
   scope, the response says so (`mode`, `warning`, `coverage`, `model_drift`) and lexical results
   are still returned.

Document-level retrieval (`docindex.py`) is a second pipeline over document chunks sharing the same
nonce, RRF and BM25 conventions but not the code. Unifying the two entry points is an open item; see
[ROADMAP.md](ROADMAP.md).

---

## 6. Model identity

A vector space is identified by `emb-` + SHA-256 of the backend's descriptor (backend, model,
revision, pooling, normalisation, document template, configured dimension) plus the observed output
dimension. Query templates are recorded but not part of the fingerprint: they change query quality,
not stored-vector compatibility.

On first use per process, two canary texts (English and Chinese) are re-embedded and compared with
the vectors stored at first index (cosine >= 0.995). A mismatch means a different model is being
served under the same name, and the vector stage is disabled with a warning instead of mixing two
incomparable spaces.

---

## 7. What was not built, on purpose

Graph-walk retrieval, a reranking stage, automatic consolidation and automatic conflict resolution
are absent by decision, not by omission; see [DECISIONS.md](DECISIONS.md). Salience and decay are
recorded (access counts, dates) and reported, but not used in ranking.

The native kernel is optional on the same principle: it is a speed boundary, not a correctness one,
and a pure-Python path covers its absence.
