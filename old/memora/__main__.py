"""Default Memora application; extended commands remain in memora.advanced."""
import argparse
import json
import os
import sys
from pathlib import Path

from . import __version__
from .config import default_data_dir
from .errors import MemoraError


def prepare_sqlite_temp(root):
    """Direct MCP/CLI startup needs the same Windows SQLite temp policy as the desktop shell."""
    scratch = Path(root).expanduser().resolve() / '.tmp'
    scratch.mkdir(parents=True, exist_ok=True)
    os.environ['TEMP'] = os.environ['TMP'] = str(scratch)
    return scratch


def parser():
    p = argparse.ArgumentParser(prog='memora', description='Agent memory, retrieval, classification, Markdown and brain views')
    p.add_argument('--version', action='version', version=__version__)
    p.add_argument('--data', help='Existing memory directory (or MEMORA_DATA)')
    sub = p.add_subparsers(dest='command')
    serve = sub.add_parser('serve', aliases=['agent'], help='Focused memory workbench')
    serve.add_argument('--port', type=int, default=8765)
    serve.add_argument('--mcp-port', type=int, default=0, help='Optional authenticated loopback MCP HTTP port')
    sub.add_parser('mcp', help='MCP stdio for connecting agents')
    sub.add_parser('health')
    sub.add_parser('setup', help='Print an MCP host configuration')
    for command in ('capture', 'recall', 'classify', 'review', 'index'):
        c = sub.add_parser(command)
        c.add_argument('--project', required=True)
        if command == 'capture':
            c.add_argument('content'); c.add_argument('--source', required=True); c.add_argument('--event-id')
        if command == 'recall':
            c.add_argument('query'); c.add_argument('--mode', choices=['auto', 'vector', 'hybrid', 'lexical'], default='auto')
        if command in ('classify', 'review'): c.add_argument('id')
        if command == 'review': c.add_argument('action', choices=['approve', 'reject', 'archive', 'restore', 'forget'])
    advanced = sub.add_parser('advanced', help='Preserved full CLI (source installation)')
    advanced.add_argument('args', nargs=argparse.REMAINDER)
    return p


def main(argv=None):
    # Frozen Windows Python may ignore PYTHONUTF8. CLI JSON and MCP must remain UTF-8.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'): stream.reconfigure(encoding='utf-8')
    args = parser().parse_args(argv)
    root = args.data or default_data_dir()
    try:
        if args.command == 'advanced':
            # The packaged build carries the full application, so the extended CLI is available there
            # too; there is no reduced "focused" build to guard against any more.
            from .advanced import main as extended
            return extended(['--data', str(root), *args.args])
        if args.command == 'setup':
            from .connections import setup
            out = setup(root)
        else:
            if os.name == 'nt': prepare_sqlite_temp(root)
            from .core import MemoryRuntime
            runtime = MemoryRuntime(root)
            if args.command in (None, 'serve', 'agent'):
                from .workbench import make_server
                server = make_server(runtime, getattr(args, 'port', 8765))
                runtime.jobs.start()
                gateway = None
                if getattr(args, 'mcp_port', 0):
                    from .gateway import start_gateway
                    gateway = start_gateway(runtime, args.mcp_port)
                print(f'Memora: http://127.0.0.1:{server.server_port}', flush=True)
                # The line above stays exactly as it is: the desktop shell and
                # tools/verify_editions.py both parse it with a regex. This second line carries the
                # same facts as one JSON object so a newer shell can read port, pid and MCP state
                # without re-parsing prose; a reader that does not know it simply ignores it.
                print(json.dumps({'ready': True, 'url': f'http://127.0.0.1:{server.server_port}',
                                  'port': server.server_port, 'pid': os.getpid(),
                                  'mcp_port': gateway.port if gateway else None}, ensure_ascii=False),
                      flush=True)
                try: server.serve_forever()
                except KeyboardInterrupt: pass
                finally:
                    if gateway: gateway.should_exit = True
                    server.server_close(); runtime.close()
                return
            if args.command == 'mcp':
                from .mcp import create_server
                from .stdio import run_stdio
                runtime.jobs.start()
                try: run_stdio(create_server(runtime))
                finally: runtime.close()
                return
            if args.command == 'health': out = dict(runtime.status(), database=runtime.store.health())
            elif args.command == 'capture': out = runtime.capture(args.project, args.content, args.source, args.event_id)
            elif args.command == 'recall': out = runtime.recall(args.project, args.query, args.mode)
            elif args.command == 'classify': out = runtime.classify(args.project, args.id)
            elif args.command == 'review': out = runtime.review(args.project, args.id, args.action)
            elif args.command == 'index': out = runtime.service.index(args.project)
        print(json.dumps(out, ensure_ascii=False, indent=2))
    except MemoraError as e:
        print(e.to_json(), file=sys.stderr); raise SystemExit(e.exit_code) from None

if __name__ == '__main__': main()
