"""Validate frozen artifacts with disposable data and a synthetic model HTTP fixture."""
import asyncio
import hashlib
import json
import marshal
import os
import queue
import re
import socket
import subprocess
import sys as _sys
import tempfile
import threading
import types
import urllib.request
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from pathlib import Path as _Path

from artifact_integrity import tree_sha256
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from PyInstaller.archive.readers import CArchiveReader
from windows_integrity import inspect_program_labels

if str(_Path(__file__).resolve().parent) not in _sys.path: _sys.path.insert(0, str(_Path(__file__).resolve().parent))
from paths import DEV as ROOT
from paths import PRODUCT as DESKTOP
from paths import REPORTS


def binary_code_scan(executable):
    archive = CArchiveReader(str(executable)); pyz = archive.open_embedded_archive('PYZ.pyz'); count = 0
    def check(code):
        nonlocal count
        if not isinstance(code, types.CodeType): return
        count += 1
        filename = code.co_filename.lower()
        if Path.home().name.lower() in filename or str(ROOT).lower() in filename:
            raise RuntimeError('private compiler path in frozen bytecode')
        for constant in code.co_consts:
            if isinstance(constant, types.CodeType): check(constant)
    for name in pyz.toc: check(pyz.extract(name))
    for name, entry in archive.toc.items():
        if entry[-1] == 's': check(marshal.loads(archive.extract(name)))
    with zipfile.ZipFile(Path(executable).parent / '_internal/base_library.zip') as z:
        for name in z.namelist():
            if name.endswith('.pyc'): check(marshal.loads(z.read(name)[16:]))
    # Only the shipped package: `memory_merge` is a legacy alias namespace that is deliberately NOT
    # bundled (see BUILD_MANIFEST.json), so including it here would ask the smoke test to find
    # something the build was designed to omit.
    modules = {n for n in pyz.toc if n.startswith('memora')}
    # The build is deliberately full-surface: build_desktop.py stages every module under memora/ and
    # force-includes them, so "the packaged build has the same feature surface as the source tree".
    # This assertion therefore checks that nothing SILENTLY DROPPED OUT, which is the failure mode
    # that shipped a working DAG canvas that 404'd. It used to assert the opposite (that the
    # advanced/agent/local_sources components were excluded) from an earlier focused-build design;
    # that design is gone, and keeping the old assertion would fail every correct build.
    staged = {name[:-3] for name in os.listdir(ROOT / 'memora')
              if name.endswith('.py') and not name.startswith('__')}
    expected = {'memora.' + name for name in staged if name != '__main__'} | {'memora', 'memora.__main__', 'memora_native'}
    missing = sorted(expected - modules)
    assert not missing, 'modules staged but not collected into the frozen PYZ: %s' % missing
    return {'checked_code_objects': count, 'private_code_filenames': 0, 'app_modules': sorted(modules),
            'every_staged_module_collected': True}


class Models(BaseHTTPRequestHandler):
    def do_POST(self):
        payload = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        if self.path.endswith('/embeddings'):
            inputs = payload['input']; inputs = [inputs] if isinstance(inputs, str) else inputs
            data = []
            for i, value in enumerate(inputs):
                vector = [0.0] * 64
                for word in re.findall(r'\w+', value.lower()):
                    digest = int(hashlib.sha256(word.encode()).hexdigest(), 16)
                    vector[digest % 64] += 1.0
                if not any(vector): vector[0] = 1.0
                data.append({'index': i, 'embedding': vector})
            result = {'data': data}
        else:
            properties = payload.get('response_format', {}).get('json_schema', {}).get('schema', {}).get('properties', {})
            if 'memories' in properties:
                content = {'memories': [{'content': 'The user prefers concise Chinese replies.', 'category': 'preference', 'quote': 'The user prefers concise Chinese replies.'}]}
            elif 'supported' in properties: content = {'supported': True, 'reason': 'Exact synthetic source quote'}
            elif 'relation' in properties: content = {'relation': 'unrelated', 'reason': 'Separate synthetic facts'}
            else: content = {'category': 'knowledge', 'importance': 0.7,
                'reason': 'Synthetic reusable knowledge fixture', 'durability': 'durable', 'sensitive': False, 'instruction_like': False}
            result = {'choices': [{'message': {'content': json.dumps(content)}}]}
        raw = json.dumps(result).encode(); self.send_response(200); self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(raw))); self.end_headers(); self.wfile.write(raw)
    def log_message(self, *args): pass


def result(value):
    assert not value.isError, value
    return value.structuredContent or json.loads(value.content[0].text)


# The MCP surface is a contract. Declaring it once, by name, means a dropped tool fails
# loudly and names itself, while an intentional addition is a one-line change. A bare
# count (which this file used twice) breaks on every addition and reports nothing useful.
MCP_TOOLS = frozenset({
    'memory_status', 'memory_peer_heartbeat', 'memory_peers', 'memory_capture',
    'memory_recall', 'memory_classify', 'memory_queue', 'memory_index',
    'memory_document_list', 'memory_document_get', 'memory_document_put',
    'memory_absorb', 'memory_digest', 'memory_job_get', 'memory_job_retry',
    'memory_models', 'memory_workflow_list', 'memory_workflow_save',
    'memory_workflow_run', 'memory_workflow_runs',
    'memory_rag_context', 'memory_document_rag_context',
})

async def mcp_smoke(executable, data, env, post):
    params = StdioServerParameters(command=str(executable), args=['--data', str(data), 'mcp'], env=env)
    async with stdio_client(params) as (reader, writer):
        async with ClientSession(reader, writer) as session:
            await session.initialize(); names = {t.name for t in (await session.list_tools()).tools}
            # A tool COUNT is not the contract: it silently breaks on every intentional
            # addition and says nothing about which tools actually shipped. Assert the set
            # instead - a dropped tool still fails, and a new one does not require hunting
            # down a magic number. `memory_review` must never be exposed without the
            # MEMORA_ENABLE_REVIEW gate, and memory_workflow_plan never existed.
            assert MCP_TOOLS <= names, 'a shipped tool disappeared: ' + str(sorted(MCP_TOOLS - names))
            assert 'memory_review' not in names, 'the review tool leaked without its env gate'
            assert 'memory_workflow_plan' not in names, 'a tool that never existed is registered'
            assert names == MCP_TOOLS, 'unexpected extra tools: ' + str(sorted(names - MCP_TOOLS))
            assert {'memory_absorb','memory_digest','memory_workflow_run','memory_models'} <= names
            peer = result(await session.call_tool('memory_peer_heartbeat', {'project': 'smoke', 'peer': 'synthetic-peer', 'name': 'Synthetic agent', 'model': 'fixture'}))
            assert peer['connected']
            memory = result(await session.call_tool('memory_capture', {'project': 'smoke', 'content': 'SQLite authoritative storage retains durable memory', 'source': 'synthetic:mcp', 'event_id': 'fixture-1'}))
            assert memory['classification']['mode'] == 'model_advice'
            assert memory['memory']['category'] == 'knowledge'
            mid = memory['memory']['id']
            approved = post('review', {'project': 'smoke', 'id': mid, 'action': 'approve'})
            assert approved['index']['indexed'] >= 1
            recall = result(await session.call_tool('memory_recall', {'project': 'smoke', 'query': 'SQLite durable memory', 'mode': 'vector'}))
            assert recall['mode'] == 'vector' and recall['results'][0]['id'] == mid
            result(await session.call_tool('memory_document_put', {'project': 'smoke', 'slug': 'fixture-note', 'audience': 'agent',
                'title': 'Synthetic note', 'content': '# Fixture\n\nA synthetic dated knowledge document.', 'expected_version': 0, 'recorded_date': '2026-10-01'}))
            post('document-publish', {'project': 'smoke', 'slug': 'fixture-note', 'audience': 'agent', 'version': 1})
            published = result(await session.call_tool('memory_document_get', {'project': 'smoke', 'slug': 'fixture-note'}))
            assert published['recorded_date'] == '2026-10-01' and published['version'] == 1
            resources = await session.list_resources()
            assert any(str(r.uri) == 'memora://status' for r in resources.resources)
            post('accumulation-policy', {'policy': {'auto_consolidate': True, 'verify': True, 'minimum_importance': 0.65}})
            job = result(await session.call_tool('memory_absorb', {'project': 'smoke', 'agent': 'synthetic', 'session_id': 'frozen-session',
                'title': 'Frozen accumulation fixture', 'turns': [{'seq': 1, 'role': 'user', 'content': 'The user prefers concise Chinese replies.', 'created': '2026-10-01T10:00:00Z'}], 'event_id': 'one'}))
            for _ in range(100):
                state = result(await session.call_tool('memory_job_get', {'project': 'smoke', 'id': job['id']}))
                if state['status'] in ('done', 'failed', 'retry'): break
                await asyncio.sleep(.1)
            assert state['status'] == 'done', state
            assert state['output']['memories'][0]['status'] == 'approved', state
            return {'tools': len(names), 'heartbeat': True, 'judge_classification_persisted': True, 'native_vector_retrieval': True,
                    'markdown_mcp_version_date': True, 'review_not_exposed_by_default': True, 'model_fixture_only': True,
                    'durable_absorption_verified_and_indexed': True, 'resources': True}


def main():
    from memora import __version__
    desktop = DESKTOP
    executable = desktop / 'resources/backend/memora-backend.exe'
    report = {'version': subprocess.check_output([str(executable), '--version'], text=True).strip(), 'features': ['mcp-stdio-http', 'vector-retrieval', 'classification', 'markdown', '2d-3d-brain', 'durable-accumulation', 'model-workflows']}
    assert report['version'] == __version__
    report['windows_integrity'] = inspect_program_labels(desktop)
    env = {k: v for k, v in os.environ.items() if not k.startswith(('MEMORA_', 'MM_', 'ELECTRON_'))}
    system = Path(os.environ.get('SystemRoot', 'C:/Windows'))
    env['PATH'] = os.pathsep.join([str(system), str(system / 'System32')]); env.pop('PYTHONPATH', None); env.pop('PYTHONHOME', None)
    report['external_runtimes_removed_from_path'] = True
    fixture = ThreadingHTTPServer(('127.0.0.1', 0), Models)
    threading.Thread(target=fixture.serve_forever, daemon=True).start()
    try:
        with tempfile.TemporaryDirectory(prefix='memora-focused-smoke-') as tmp:
            data = Path(tmp) / 'data'; env.update(MEMORA_DATA=str(data), PYTHONUTF8='1')
            with socket.socket() as probe:
                probe.bind(('127.0.0.1', 0)); mcp_port = probe.getsockname()[1]
            process = subprocess.Popen([str(executable), '--data', str(data), 'serve', '--port', '0', '--mcp-port', str(mcp_port)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, text=True, encoding='utf-8')
            lines = queue.Queue(); threading.Thread(target=lambda: lines.put(process.stdout.readline()), daemon=True).start()
            try:
                line = lines.get(timeout=30)
                match = re.search(r'http://127\.0\.0\.1:\d+', line)
                if not match:
                    raise RuntimeError('Frozen backend failed: ' + line)
                base = match.group()
                def get(path):
                    with urllib.request.urlopen(base + path, timeout=20) as response: return response.read()
                token = json.loads(get('/api/session'))['token']
                def post(path, body):
                    req = urllib.request.Request(base + '/api/agent/' + path, data=json.dumps(body).encode(),
                        headers={'Content-Type': 'application/json', 'Origin': base, 'X-MM-Token': token})
                    with urllib.request.urlopen(req, timeout=30) as response: return json.loads(response.read())
                status = json.loads(get('/api/agent/status'))
                assert status['kernel'] == 'native' and not status['embedding']
                address = f'http://127.0.0.1:{fixture.server_port}/v1'
                post('settings', {'settings': {role: {'backend': 'openai', 'url': address, 'model': 'synthetic-fixture', 'remote': False} for role in ('embedding', 'judge')}})
                paths = ['/', '/memory.js', '/memory.css', '/orchestration.js', '/brain/dictionary/', '/brain/outline/', '/brain/plane/',
                         '/api/agent/brain?project=smoke', '/api/agent/map?project=smoke', '/api/agent/documents?project=smoke']
                for path in paths: assert get(path), path
                report['http_routes'] = len(paths)
                report['mcp'] = asyncio.run(mcp_smoke(executable, data, env, post))
                gateway = f'http://127.0.0.1:{mcp_port}/mcp'
                packet = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'tools/list', 'params': {}}).encode()
                headers = {'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream'}
                try: urllib.request.urlopen(urllib.request.Request(gateway, data=packet, headers=headers), timeout=10)
                except urllib.error.HTTPError as denied: assert denied.code == 401
                else: raise AssertionError('HTTP MCP accepted a missing bearer')
                headers['Authorization'] = 'Bearer ' + (data / 'mcp-token').read_text('utf-8').strip()
                with urllib.request.urlopen(urllib.request.Request(gateway, data=packet, headers=headers), timeout=10) as response:
                    # Compare the HTTP transport against the stdio transport rather than
                    # against a literal: what matters is that BOTH expose the same surface.
                    # A count would break on every intentional addition and would not prove
                    # the two transports agree.
                    http_tools = {t['name'] for t in json.load(response)['result']['tools']}
                    assert http_tools == MCP_TOOLS, (
                        'HTTP gateway exposes a different tool set: missing %s, extra %s'
                        % (sorted(MCP_TOOLS - http_tools), sorted(http_tools - MCP_TOOLS)))
                report['authenticated_http_mcp'] = True
                report['schema'] = json.loads(subprocess.check_output([str(executable), '--data', str(data), 'health'], env=env, text=True, encoding='utf-8'))['database']['schema']
                assert report['schema'] == 2
            finally:
                process.terminate(); process.communicate(timeout=15)
            # The desktop and its backend must launch with no external language runtimes.
            # Clear fixture bindings before launch; the app should also work offline.
            (data / 'memora.json').unlink()
            command = [str(desktop / 'Memora.exe'), '--smoke-test', '--user-data-dir=' + str(Path(tmp) / 'electron')]
            desktop_smoke = subprocess.run(command, env=env, capture_output=True, text=True, encoding='utf-8', timeout=50)
            report['desktop_default_exit_code'] = desktop_smoke.returncode
            assert desktop_smoke.returncode == 0 and 'MEMORA_DESKTOP_READY' in desktop_smoke.stdout, {'exit_code': desktop_smoke.returncode, 'stdout': desktop_smoke.stdout, 'stderr': desktop_smoke.stderr}
            report['desktop_ready'] = True
            portable_env = dict(env, MEMORA_DATA=str(Path(tmp) / 'portable-data'), MEMORA_RUNTIME_DIR=str(Path(tmp) / 'portable-runtime'))
            launcher = [str(system / 'System32/WindowsPowerShell/v1.0/powershell.exe'), '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', str(desktop / 'Launch-Memora.ps1')]
            # A background Windows child can inherit an unrelated capture pipe,
            # preventing communicate() from receiving EOF after PowerShell exits.
            # Regular files let the real launcher lifecycle be tested without it.
            with (Path(tmp) / 'portable-check.log').open('wb') as trace:
                try:
                    portable = subprocess.run([*launcher, '-Headless'], env=portable_env, stdout=trace, stderr=subprocess.STDOUT, timeout=40)
                    assert portable.returncode == 0, 'Portable launcher failed'
                    state = json.loads((Path(portable_env['MEMORA_RUNTIME_DIR']) / 'portable-host.json').read_text('utf-8-sig'))
                    with urllib.request.urlopen(state['url'] + '/api/agent/status', timeout=5) as response: portable_status = json.load(response)
                    assert portable_status['version'] == __version__ and portable_status['kernel'] == 'native'
                finally:
                    stopped = subprocess.run([*launcher, '-Stop'], env=portable_env, stdout=trace, stderr=subprocess.STDOUT, timeout=30)
                    assert stopped.returncode == 0, 'Portable launcher could not stop its own host'
            report['portable_launcher_without_language_runtimes'] = True
    finally: fixture.shutdown(); fixture.server_close()
    report['binary_scan'] = binary_code_scan(executable)
    report['backend_sha256'] = hashlib.sha256(executable.read_bytes()).hexdigest()
    report['artifact_tree_sha256'] = tree_sha256(desktop)
    report['passed'] = True
    REPORTS.mkdir(parents=True, exist_ok=True)
    (REPORTS / 'SMOKE_VALIDATION.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), 'utf-8')
    print(json.dumps(report, indent=2))


if __name__ == '__main__': main()
