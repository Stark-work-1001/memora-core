"""Authenticated stateless MCP HTTP transport for local host integrations.

This is a second, independent listener next to the workbench's own socket (web.py). It used to be
started in a daemon thread that nobody watched: a missing dependency, a port already taken or a
lifespan failure killed that thread silently while the process went on advertising itself as
healthy. A client then met "connection refused" on a port the URL line implied was open, with
nothing anywhere saying why. start_gateway therefore waits for the socket to accept a real
connection and raises a typed error when it does not, so a broken MCP transport surfaces at startup
where the desktop shell can report it, instead of later as an unexplained failure.
"""
import secrets
import threading
import time

from .bridge import BearerGate
from .errors import MemoraError
from .mcp import create_server

# A loopback bind takes milliseconds; the timeout only bounds how long a broken one delays startup,
# and the poll interval keeps a healthy start from adding measurable latency to the URL line.
GATEWAY_START_TIMEOUT = 5.0
GATEWAY_POLL = 0.02


def start_gateway(runtime, port, timeout=GATEWAY_START_TIMEOUT):
    import uvicorn
    token_path = runtime.store.root / 'mcp-token'
    if not token_path.exists():
        token_path.write_text(secrets.token_urlsafe(40), 'utf-8')
        token_path.chmod(0o600)
    token = token_path.read_text('utf-8').strip()
    server = create_server(runtime)
    server.settings.stateless_http = True
    server.settings.json_response = True
    config = uvicorn.Config(BearerGate(server.streamable_http_app(), token), host='127.0.0.1', port=port,
                            access_log=False, log_level='warning')
    runner = uvicorn.Server(config)
    failure = []

    def serve():
        # uvicorn reports a bind or lifespan failure by calling sys.exit() inside its own thread.
        # Nothing else observes that thread, so the reason is captured here and raised below; a
        # SystemExit stringifies to the exit code alone, so it is named rather than printed.
        try: runner.run()
        except SystemExit as e: failure.append(f'the MCP server exited with code {e.code}')
        except BaseException as e: failure.append(str(e) or type(e).__name__)

    thread = threading.Thread(target=serve, name='memora-mcp-http', daemon=True)
    thread.start()
    _await_listener(port, runner, thread, failure, timeout)
    # The URL line downstream reports the port; keep it here so a caller never has to know the
    # argument it passed in to say where the gateway listens.
    runner.port = port
    return runner


def _await_listener(port, runner, thread, failure, timeout):
    """Block until uvicorn reports the socket bound, or raise with the reason it never got there.

    runner.started is set by uvicorn only after bind() returned and the lifespan startup finished,
    which is the one signal that means THIS server owns the port. A successful connect would not:
    on Windows a competing listener on the same port accepts the probe just as well, so the gateway
    could be declared healthy while its own bind had already failed.
    """
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if failure:
            raise MemoraError(f'MCP gateway could not start on 127.0.0.1:{port}: {failure[0]}',
                              hint='Free the port or start with --mcp-port 0 to run without MCP HTTP')
        if getattr(runner, 'started', False): return
        if not thread.is_alive():
            raise MemoraError(f'MCP gateway stopped before listening on 127.0.0.1:{port}',
                              hint='Check the uvicorn log for the startup failure')
        time.sleep(GATEWAY_POLL)
    raise MemoraError(f'MCP gateway did not listen on 127.0.0.1:{port} within {timeout:g}s',
                      hint='Free the port or start with --mcp-port 0 to run without MCP HTTP')
