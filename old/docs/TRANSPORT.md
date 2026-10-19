# Transport contract

**Read this before changing anything in `memora/web.py`, `memora/gateway.py`, `memora/__main__.py`
or `desktop/main.cjs`.** It records what a caller may rely on across the loopback boundary, and
every item below is what the code actually does in 1.3.0 — not a description of an intention.

Why a separate document: the transport failures this project has had were all *silent*. A missing
`Content-Length` does not raise, it hangs. A shallow backlog does not raise, it refuses. A wrong
compression wrapper does not raise on the server, it fails in the browser. None of them show up in a
unit test of the route handler, and all of them are one edit away.

Design rationale for these choices is in [ARCHITECTURE.md](ARCHITECTURE.md) §2.

---

## 1. Ports

Three ports, three owners. They are deliberately disjoint so that a development session and a
packaged program can run at the same time.

| Port | Owner | Source of truth |
| --- | --- | --- |
| 8765 | development workbench (`serve`) | `tools/paths.py` `DEV_PORT` |
| 18184 | development MCP HTTP gateway | `tools/paths.py` `DEV_MCP_PORT` |
| 18765 | packaged desktop backend | `tools/paths.py` `PRODUCT_PORT`, `desktop/main.cjs` |

**Port fallback.** The packaged shell scans **18765–18795** and takes the first port it can bind
exclusively. If the whole window is taken it passes `--port 0` and lets the OS assign one — which is
why the stdout announcement (not the port number) is the only way to learn the address in that case.

**Explicit port is a contract.** Setting `MEMORA_PORT` suppresses the scan entirely. If that port is
occupied the shell reports the failure and does not silently move: a caller that asked for a port
needs to know it did not get it.

`--mcp-port` is optional and defaults to 0 (disabled). When enabled the gateway starts beside the
workbench on the same runtime.

---

## 2. Readiness: three signals, one verdict

A backend is ready when it **answers as ours**, not when it announces a socket. Three signals exist
and they are not equivalent.

### 2.1 stdout — a fast path, not proof

`memora/__main__.py` prints two lines to stdout, in this order, both flushed:

```text
Memora: http://127.0.0.1:8765
{"ready": true, "url": "http://127.0.0.1:8765", "port": 8765, "pid": 1234, "mcp_port": null}
```

The first line is prose and **must not change shape**: the desktop shell matches it with
`/Memora: (http:\/\/127\.0\.0\.1:\d+)/` and `tools/verify_editions.py` parses it too. The second
line carries the same facts as one JSON object so a newer caller can read port, pid and MCP state
without re-parsing prose; a reader that does not know it simply ignores it.

Neither line proves the backend is *the right one*. It proves a socket was bound.

### 2.2 `GET /api/agent/status` — the identity check

This is the only signal that decides readiness. The response must satisfy all three:

| Field | Requirement |
| --- | --- |
| `name` | `"memora"` |
| `version` | equals the caller's expected version |
| `data_dir` | equals the caller's resolved data directory |

`data_dir` is compared after `path.resolve()` and lower-cased on Windows, because the backend
answers with its own resolve of `--data` and Windows is case-insensitive: the two strings differ in
case and separators for the same directory.

This check exists because three Memora stores can be listening on three ports at once —
development, packaged, a leftover — and attaching a window to the wrong one **writes into the wrong
database**. A wrong attachment is not a crash; it is data in the wrong store.

The probe sends `Accept-Encoding: identity`. Do not remove it. A readiness check that can be failed
by a compression bug is a readiness check with a second failure mode, and a nine-hundred-byte JSON
reply gains nothing from compression.

### 2.3 Timing budget

| Constant | Value | Meaning |
| --- | --- | --- |
| `READY_TIMEOUT_MS` | 45000 | Cold Python start with index rebuilds on a spinning disk |
| `READY_POLL_MS` | 250 | Fast enough that a warm start feels instant |
| `PROBE_TIMEOUT_MS` | 1500 | One probe must not outlive a poll tick, or a hung socket eats the whole budget |

Two signals race and the first one wins: the active status probe (polling starts at t=0, so a slow
start is just a longer wait) and the stdout line (the only way to learn the address when the backend
picked its own port).

A child that dies during startup must fail **immediately** — waiting out the full 45 seconds on a
process that is already gone is 45 seconds of nothing happening in front of the user.

### 2.4 Adopting a running backend

If `runtime/active.json` (or `MEMORA_RUNTIME_URL`) names an already-running managed backend, the
shell probes it with a 5-second deadline and adopts it instead of starting a second one. The URL is
rejected unless it is `http:`, `127.0.0.1`, and carries no credentials. A backend that is up but
slow is not the same as one that is absent, and the log says which of the two happened.

---

## 3. Concurrency and connection limits

| Constant | Value | Why |
| --- | --- | --- |
| `request_queue_size` (backlog) | 128 | A connect arriving while the accept loop is busy waits in the kernel backlog; past its depth the kernel refuses it outright. |
| `MAX_REQUESTS_PER_CONNECTION` | 100 | Bounds a socket a closed tab left open, so a thread is always reclaimed. |
| `protocol_version` | `HTTP/1.1` | Keep-alive; without it the browser re-connects for every asset. |
| `GZIP_MIN_BYTES` | 1400 | Below this, gzip framing costs more than it saves on loopback. |
| `DISCARD_MAX` | 1 MiB | Largest rejected body the server reads just to keep a keep-alive socket in sync. |
| `max_body` | 100000 (default) | Largest accepted request body. |

**Baseline to protect:** 200 concurrent requests, 0 failures. The failure this replaced was 24 of 50
concurrent GETs returning ECONNREFUSED.

---

## 4. Response invariants

Every response from `LoopbackHTTPServer`, **including error pages**, carries:

- `Content-Length` — mandatory under HTTP/1.1. Without it the client waits for a body that never
  ends: the connection hangs instead of failing, which is worse than a refused connection because
  nothing times out and nothing retries. The single exception is the SSE stream, which has no length
  by definition and ends by closing the connection.
- `Content-Type` with `charset=utf-8`.
- `Vary: Accept-Encoding` — so a cache cannot hand a gzip body to a client that asked for identity.
- `Content-Security-Policy`, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`,
  `Referrer-Policy: no-referrer`.

`send_error` is overridden because the stdlib version omits CSP and `nosniff` — and it answers the
Host-header rejection, which is exactly what a DNS-rebinding page sees.

### Request body handling

Under keep-alive, an unread request body becomes the **next request's request line**. A rejected
body is therefore drained before the next request is read, bounded by `DISCARD_MAX`. Anything larger,
or of unknown length, ends the connection instead — draining bytes it could not report on would be a
way to occupy a thread.

### Compression

Large bodies are gzipped with `zlib.compressobj(6, zlib.DEFLATED, 16 + zlib.MAX_WBITS)`.
`16 + MAX_WBITS` (= 31) selects the **gzip wrapper, RFC 1952**. The obvious `zlib.compress()` emits
the bare zlib format, **RFC 1950**, which a browser told `Content-Encoding: gzip` rejects with
"incorrect header check" — a decode error on a body that arrived perfectly intact.

Compression never fails a response: a compressor exception returns the plain body, which is valid for
a client that accepts gzip.

---

## 5. Security boundary

Unchanged by any transport work, and not negotiable:

- Binds `127.0.0.1` only. Never expose these endpoints to a network.
- The `Host` header must be `127.0.0.1:<port>` or `localhost:<port>`; anything else is rejected.
  This is what blocks DNS rebinding.
- In review mode the only write route additionally requires `Content-Type: application/json`, a
  same-origin `Origin` header, and a per-process random token that a cross-origin page cannot read.
- MCP HTTP requires a bearer token read from `<data>/mcp-token`; the token is never logged.
  stdio hosts do not depend on it and rely on local process permissions instead.

---

## 6. Failure modes and recovery

| Symptom | Cause | Recovery |
| --- | --- | --- |
| `ECONNREFUSED` under load | Backlog exhausted; the kernel refused the connect | Backlog is 128; re-check that `request_queue_size` was not lowered. |
| Connection hangs, then times out | A response without `Content-Length` under HTTP/1.1 | Every response must set it. SSE is the only exception. |
| Browser reports "incorrect header check" | RFC 1950 stream labelled `Content-Encoding: gzip` | Use `compressobj(16 + MAX_WBITS)`. |
| Window attached to the wrong store | Readiness decided by the stdout line alone | Require `name`/`version`/`data_dir` from `/api/agent/status`. |
| "unable to open database file" on first run | Data directory on one volume, `TEMP` on another | `TEMP`/`TMP` are pinned to `<data>/.tmp`. |
| Backend dies, app appears hung | Old shell treated any exit as fatal | Supervisor restarts with 500/1500/4000 ms backoff, max 3 attempts, showing a reconnect page. |
| Locked database after a crash | `child.kill()` signalled one process; a grandchild kept the file open | `taskkill /PID <pid> /T /F` on Windows. |
| "address already in use" after restart | Previous socket in `TIME_WAIT` | `allow_reuse_address = True`. |

### Restart policy

Three attempts, backoff 500 / 1500 / 4000 ms, then the user is told and the app closes. Unlimited
retries would turn a broken install into a window that flickers forever; no retries is what the shell
did before.

A deliberate quit never restarts: `before-quit` sets the flag first, so a quit during a backoff wins
and a backend that would reappear one second later has no window to serve.

The supervisor listener is attached only **after** readiness. A child that dies during startup is a
startup failure, not a crash to recover from.

---

## 7. Diagnostics

`<data>/desktop.log` is append-only, rolls at 1 MB keeping the **tail** (the start answers "when
did this install first run"; the end answers "what broke"), and redacts credentials on the way in.
Redaction is applied at write time rather than trusted not to appear, because a Python traceback can
quote a request header and stderr is logged verbatim.

A startup failure also writes `<data>/startup-error.log` **before** showing an error box: the box is
invisible in a headless, remote or sandboxed launch, and a dialog nobody sees is indistinguishable
from a silent crash.
