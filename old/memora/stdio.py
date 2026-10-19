"""Keep host standard streams alive across MCP SDK transport shutdown."""
import contextlib
import io
import os
import sys


def run_stdio(server):
    original_in, original_out = sys.stdin, sys.stdout
    streams = (io.TextIOWrapper(os.fdopen(os.dup(original_in.fileno()), 'rb'), encoding='utf-8', errors='replace'),
               io.TextIOWrapper(os.fdopen(os.dup(original_out.fileno()), 'wb'), encoding='utf-8'))
    try:
        sys.stdin, sys.stdout = streams
        server.run(transport='stdio')
    finally:
        sys.stdin, sys.stdout = original_in, original_out
        for stream in streams:
            with contextlib.suppress(OSError, ValueError): stream.close()
