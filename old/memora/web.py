"""Loopback-only viewer. Read-only unless started with --review.

Defences: binds 127.0.0.1 only; rejects any Host header but 127.0.0.1:port / localhost:port (blocks
DNS rebinding); strict CSP, nosniff, no-store, no referrer; the page never uses innerHTML for memory
content. In review mode the only write route is POST /api/review, which additionally requires
Content-Type application/json, a same-origin Origin header and a per-process random token that a
cross-origin page cannot read (same-origin policy) -- so a malicious website cannot approve memories
through the user's browser.

Transport: the server used to be a bare ThreadingHTTPServer, i.e. the stdlib defaults -- a listen
backlog of 5 and HTTP/1.0. A single page load opens more sockets than that at once (static files,
/api/agent/* polls, the SSE stream), and a connect that arrives while the accept loop is still busy
in another handler waits in the kernel backlog; past its depth the kernel refuses it outright. That
is the "unstable communication": 24 of 50 concurrent GETs to /api/agent/status came back
ECONNREFUSED while 200 sequential ones all succeeded. HTTP/1.0 made it worse by closing the
connection after every response, so the browser could not reuse a socket and kept offering new ones.
Everything here is transport only: a backlog sized for a browser, keep-alive under HTTP/1.1, an
explicit Content-Length on every response (mandatory once connections are reused -- a missing length
hangs the client instead of failing it), gzip for large bodies, and a cap on requests per connection.
The 127.0.0.1 bind and the Host-header check are unchanged.
"""
import json
import secrets
import time
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from .errors import InvalidInput, MemoryMergeError
from .schema import INDEXED_STATUSES
from .store import TRANSITIONS, scope

STATIC = Path(__file__).parent / 'static'
FILES = {'/': ('index.html', 'text/html'), '/app.js': ('app.js', 'text/javascript'), '/style.css': ('style.css', 'text/css')}
CSP = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
BRAIN_CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:; connect-src 'self'; font-src 'self' data:; img-src 'self' data:; frame-ancestors 'self'; base-uri 'none'; form-action 'none'"

# One page offers more than six connects at once, and a connect that arrives while the accept loop is
# busy sits in the kernel backlog until the loop comes back for it. The stdlib default of 5 was
# already too small for a single page load; 128 leaves room for several tabs, their SSE streams and a
# burst of /api/agent polls. An unaccepted connection costs a socket, not a thread, so a generous
# backlog is cheap -- and a backlog that fills up is exactly the ECONNREFUSED this fixes.
BACKLOG = 128
# Keep-alive means a closed tab can leave a socket open until its FIN/RST arrives. Capping the
# requests served on one connection guarantees the handler loop exits and its thread is reclaimed, so
# a page that holds a socket open cannot pin a thread for the lifetime of the process.
MAX_REQUESTS_PER_CONNECTION = 100
# Below this size gzip framing (its header plus 18 bytes of deflate overhead) costs more than it saves
# on a loopback socket. The workbench's own assets are 3 KB and up, so they all cross the line, while
# the small JSON status replies stay uncompressed.
GZIP_MIN_BYTES = 1400
# The largest rejected request body this server will read just to keep a keep-alive socket in sync.
# Anything bigger, or of unknown length, ends the connection instead: draining bytes it could not
# report on would be a way to occupy a thread. The largest legal body here is max_body (500 KB).
DISCARD_MAX = 1 << 20


class LoopbackHTTPServer(ThreadingHTTPServer):
    """The only server this module starts: loopback bound, deep backlog, reusable address.

    Named rather than tuned inline so the numbers live in one place. allow_reuse_address is already
    the HTTPServer default, but it is stated here because restarting the workbench while the previous
    socket sits in TIME_WAIT must not fail with "address already in use"; daemon_threads keeps a
    request thread from blocking interpreter exit.
    """
    request_queue_size = BACKLOG
    allow_reuse_address = True
    daemon_threads = True


def make_server(store, port=8765, review=False, agent=None, assets=None, max_body=100000):
    token = secrets.token_urlsafe(24)

    class Handler(BaseHTTPRequestHandler):
        # HTTP/1.1 keeps the connection open between requests, which is what stops a browser from
        # re-connecting (and re-offering the kernel backlog) for every asset. It is only safe because
        # every response below carries a Content-Length: under 1.1 a response without one leaves the
        # client waiting for a body that never ends, which is worse than a refused connection. The
        # one deliberate exception is the SSE stream, which ends by closing the connection.
        protocol_version = 'HTTP/1.1'
        # Per connection, not per process: the server hands one Handler to one socket.
        _requests = 0

        def _allowed_hosts(self):
            p = self.server.server_port
            return {f'127.0.0.1:{p}', f'localhost:{p}'}

        def _send(self, code, body, mime):
            body, encoding = self._encoded(body)
            self.send_response(code)
            self.send_header('Content-Type', mime + '; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            if encoding: self.send_header('Content-Encoding', encoding)
            # Vary belongs on every response whose representation depends on a request header, so a
            # cache never hands a gzip body to a client that asked for identity (or the reverse).
            self.send_header('Vary', 'Accept-Encoding')
            self.send_header('Content-Security-Policy', BRAIN_CSP if self.path.startswith('/brain/') else CSP)
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Referrer-Policy', 'no-referrer')
            self.end_headers(); self.wfile.write(body)

        def _encoded(self, body):
            """Gzip a large body when the client offered it; never fail a response over compression."""
            if len(body) < GZIP_MIN_BYTES or 'gzip' not in self.headers.get('Accept-Encoding', ''):
                return body, None
            try:
                # wbits=31 asks zlib for the gzip wrapper; zlib.compress() alone would emit the bare
                # zlib format (RFC 1950), which a browser told "Content-Encoding: gzip" cannot read.
                pump = zlib.compressobj(6, zlib.DEFLATED, 16 + zlib.MAX_WBITS)
                return pump.compress(body) + pump.flush(), 'gzip'
            except Exception:
                # Losing bytes to a compressor is not worth a 500: the plain body is valid for a
                # client that accepts gzip, so there is nothing to report and nothing to retry.
                return body, None

        def _json(self, obj, code=200):
            self._send(code, json.dumps(obj, ensure_ascii=False).encode(), 'application/json')

        def send_error(self, code, message=None, explain=None):
            """The stdlib error page plus the headers this server's security model requires.

            The inherited send_error writes Connection: close and a Content-Length, but no CSP and no
            nosniff, so an error page was the one response served without them -- and it answers the
            Host-check rejection below, i.e. exactly what a DNS-rebinding page sees.
            """
            try: shortmsg, longmsg = self.responses[code]
            except KeyError: shortmsg, longmsg = '???', '???'
            if message is None: message = shortmsg
            if explain is None: explain = longmsg
            self.log_error("code %d, message %s", code, message)
            # The stdlib announces the close on the header without ever acting on it, so a keep-alive
            # loop would go on reading a stream that the client was told was over. The flag makes the
            # announcement true, and end_headers writes the header from it.
            self.close_connection = True
            self.send_response(code, message)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Security-Policy', CSP)
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Referrer-Policy', 'no-referrer')
            body = (self.error_message_format % {'code': code,
                                                 'message': message.replace('<', '&lt;').replace('>', '&gt;'),
                                                 'explain': explain.replace('<', '&lt;').replace('>', '&gt;')}
                    ).encode('utf-8', 'replace')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            if self.command != 'HEAD': self.wfile.write(body)

        def end_headers(self):
            """Announce the fate of the connection, then send the head.

            A response that carries no length is delimited only by the close, so the close has to be
            advertised. On a normal response the same header is what stops a client at the request cap
            from writing a request into a socket that is about to be shut.
            """
            if self.close_connection or self._requests >= MAX_REQUESTS_PER_CONNECTION:
                self.close_connection = True
                self.send_header('Connection', 'close')
            super().end_headers()

        def handle_one_request(self):
            # The cap is enforced before the next request is read, not after the socket is already
            # being reused: a connection that helped MAX_REQUESTS_PER_CONNECTION times is closed here.
            if self._requests >= MAX_REQUESTS_PER_CONNECTION:
                self.close_connection = True
                return
            self._requests += 1
            super().handle_one_request()

        def _drain_request_body(self):
            """Drop a body that was never parsed, or end the connection instead.

            With keep-alive on, an unread body is the next request's request line: the client would
            get a 400 for a request it never sent, or an error page built out of its own JSON. Reading
            the declared length keeps the socket in sync; an unknown or unbelievable length means the
            connection cannot be trusted any more and is closed.
            """
            if self.headers.get('Transfer-Encoding'):
                self.close_connection = True; return
            declared = self.headers.get('Content-Length')
            if not declared: return
            try: n = int(declared)
            except (TypeError, ValueError): n = -1
            if not 0 <= n <= DISCARD_MAX:
                self.close_connection = True; return
            try:
                while n > 0:
                    chunk = self.rfile.read(min(n, 65536))
                    if not chunk: self.close_connection = True; return
                    n -= len(chunk)
            except OSError: self.close_connection = True

        def do_GET(self):
            # A GET may carry a body no route below reads, and a GET is answered on a kept-alive
            # connection: leaving the body unread would parse it as the next request line.
            self._drain_request_body()
            if self.headers.get('Host') not in self._allowed_hosts():
                self.send_error(403); return
            parsed = urlsplit(self.path)
            q = {k: v[0] for k, v in parse_qs(parsed.query).items()}
            try:
                if assets and parsed.path in assets:
                    name, mime = assets[parsed.path]
                    self._send(200, (STATIC / name).read_bytes(), mime); return
                if agent and parsed.path.startswith('/brain/'):
                    parts = parsed.path.strip('/').split('/')
                    # Three 3D brain types (dictionary/语义关系, matt/星云关系图, outline/层级脑图)
                    # plus the 2D plane. A new view must be added here as well as to build.mjs, or
                    # the workbench's iframe gets a 404 the build would never reveal.
                    if len(parts) not in {2, 3} or parts[1] not in {'dictionary', 'matt', 'outline', 'plane'}:
                        self.send_error(404); return
                    name = parts[2] if len(parts) == 3 else 'index.html'
                    if name not in {'index.html', 'app.js', 'styles.css'}: self.send_error(404); return
                    mime = {'index.html': 'text/html', 'app.js': 'text/javascript', 'styles.css': 'text/css'}[name]
                    target = STATIC / 'brain' / parts[1] / name
                    if not target.is_file():
                        self._json({'error': {'message': 'Build brain views: cd frontend && npm ci && npm run build'}}, 503); return
                    self._send(200, target.read_bytes(), mime); return
                if agent and parsed.path == '/api/agent/events':
                    job_id, project = q.get('id'), scope(q.get('project', 'default'))
                    # Agent.snapshot(id) is the advanced deployment's contract; the workbench adapter
                    # also takes the project. Try the wider call first, so the bound call is the only
                    # one that runs a snapshot body.
                    def snapshot():
                        try: return agent.snapshot(job_id, project)
                        except TypeError: return agent.snapshot(job_id)
                    try:
                        snapshot()  # validate before the response becomes a stream, as before
                    except (MemoryMergeError, ValueError): raise
                    except Exception as e:
                        # The caller is owed a response: a dead connection reports nothing at all.
                        self._json({'error': {'code': 'snapshot_failed', 'message': str(e)[:200]}}, 503); return
                    # No Content-Length can describe a stream, so the close is what delimits this
                    # response -- and end_headers announces exactly that, because the flag is set
                    # before the head goes out. Under HTTP/1.1 a close the client was not told about
                    # reads as a truncated body.
                    self.close_connection = True
                    self.send_response(200)
                    self.send_header('Content-Type', 'text/event-stream; charset=utf-8')
                    self.send_header('Cache-Control', 'no-store')
                    self.send_header('X-Content-Type-Options', 'nosniff')
                    self.end_headers()
                    previous = None
                    try:
                        while True:
                            try:
                                snap = snapshot()
                                if not isinstance(snap, dict) or not isinstance(snap.get('status'), str):
                                    raise InvalidInput('snapshot must be an object with a status')
                                data = json.dumps(snap, ensure_ascii=False)
                            except Exception as e:
                                # The status line is already on the wire, so a final frame saying
                                # so is the only honest report left; it beats a silent dead stream.
                                snap = {'status': 'error'}
                                data = json.dumps({'status': 'error',
                                                   'error': {'code': getattr(e, 'code', 'snapshot_failed'),
                                                             'message': str(e)[:200]}}, ensure_ascii=False)
                            if data != previous:
                                # One write of a complete frame, then a flush: never half a frame.
                                self.wfile.write(('data: ' + data + '\n\n').encode()); self.wfile.flush()
                                previous = data
                            if snap['status'] != 'running': break
                            time.sleep(0.15)
                    except (BrokenPipeError, ConnectionError): pass
                    # Stated again after the loop so the contract survives a future edit above.
                    self.close_connection = True
                    return
                if agent and parsed.path.startswith('/api/agent/'):
                    self._json(agent.get(parsed.path[len('/api/agent'):], q)); return
                if agent and parsed.path in {'/', '/agent.js', '/agent-next.js', '/agent.css', '/architecture', '/architecture.svg'}:
                    name, mime = {'/': ('agent.html', 'text/html'), '/agent.js': ('agent.js', 'text/javascript'),
                        '/agent-next.js': ('agent-next.js','text/javascript'), '/agent.css': ('agent.css', 'text/css'), '/architecture': ('architecture.html', 'text/html'),
                        '/architecture.svg': ('architecture.svg', 'image/svg+xml')}[parsed.path]
                    self._send(200, (STATIC / name).read_bytes(), mime); return
                if agent and parsed.path == '/graph':
                    self._send(200, (STATIC / 'index.html').read_bytes(), 'text/html'); return
                if parsed.path in FILES:
                    name, mime = FILES[parsed.path]
                    self._send(200, (STATIC / name).read_bytes(), mime); return
                project = scope(q.get('project', 'default'))
                if parsed.path == '/api/graph':
                    limit = int(q.get('limit', 1000))
                    out = store.graph(project, limit=limit, category=q.get('category') or None, tag=q.get('tag') or None,
                                      include_user=q.get('include_user') == '1')
                elif parsed.path == '/api/search':
                    out = {'results': store.recall(project, q.get('q', ''), limit=min(int(q.get('limit', 20)), 50))}
                elif parsed.path == '/api/timeline':
                    out = store.page(project, status='approved', limit=min(int(q.get('limit', 100)), 500), cursor=q.get('cursor') or None)
                elif parsed.path == '/api/memory':
                    m = store.get(project, q.get('id', ''))
                    visible = INDEXED_STATUSES + (('pending',) if review else ())
                    if m['status'] not in visible: self.send_error(404); return  # never forgotten/rejected text
                    out = dict(m, edges=store.edges_of(project, [m['id']]), support=store.support(m['id']))
                elif parsed.path == '/api/session':  # same-origin pages only can read this
                    out = {'review': review, 'token': token if review else None}
                elif parsed.path == '/api/queue' and review:
                    out = store.page(project, status='pending', limit=200)
                else:
                    self.send_error(404); return
            except (MemoryMergeError, ValueError) as e:
                self._json({'error': {'code': getattr(e, 'code', 'invalid_input'), 'message': str(e)[:200]}}, 400 if not isinstance(e, KeyError) else 404); return
            self._json(out)

        def do_POST(self):
            # Every refusal below answers without reading the body, and every one of them ends the
            # connection (see send_error): an unread body on a kept-alive socket is the next request
            # line, so the client would be answered out of its own payload.
            if not review: self.send_error(501); return
            p = self.server.server_port
            if (self.headers.get('Host') not in self._allowed_hosts()
                    or self.headers.get('Origin') not in {f'http://127.0.0.1:{p}', f'http://localhost:{p}'}
                    or not secrets.compare_digest(self.headers.get('X-MM-Token', ''), token)
                    or (self.headers.get('Content-Type') or '').split(';')[0].strip() != 'application/json'):
                self.send_error(403); return
            path = urlsplit(self.path).path
            if path != '/api/review' and not (agent and path.startswith('/api/agent/')):
                self.send_error(404); return
            # This path answers with a JSON body instead of an error page, so a failure before the
            # body was read has to close the connection itself.
            read = False
            try:
                n = int(self.headers.get('Content-Length') or 0)
                if not 0 < n <= (max_body if agent else 4096): raise InvalidInput('bad request body')
                payload = self.rfile.read(n)
                read = True
                if len(payload) != n: raise InvalidInput('request body was cut short')
                body = json.loads(payload)
                if not isinstance(body, dict): raise InvalidInput('request must be an object')
                if agent and path.startswith('/api/agent/'):
                    self._json(agent.post(path[len('/api/agent'):], body)); return
                if body.get('action') not in TRANSITIONS: raise InvalidInput('bad action')
                r = store.review(body.get('project'), str(body.get('id')), body['action'], actor='web-review')
                store.flush()
            except (MemoryMergeError, ValueError) as e:
                if not read: self.close_connection = True
                self._json({'error': {'code': getattr(e, 'code', 'invalid_input'), 'message': str(e)[:200]}}, 400); return
            self._json({'memory': r})

        def log_message(self, *args): pass

    return LoopbackHTTPServer(('127.0.0.1', port), Handler)
