"""MCP smoke against the development frozen backend, using a fresh temporary data store."""
import asyncio
import json
import tempfile
from pathlib import Path

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

ROOT = Path(__file__).resolve().parents[1]


async def verify():
    with tempfile.TemporaryDirectory(prefix='memora-frozen-upgrade-', dir=ROOT / 'runtime/tmp') as data:
        backend = ROOT / 'dist/memora-backend/memora-backend.exe'
        # No TEMP/TMP override: direct MCP startup must prepare its own same-volume scratch.
        params = StdioServerParameters(command=str(backend), args=['--data', data, 'mcp'],
            cwd=str(backend.parent), env={'PYTHONUTF8': '1'})
        async with stdio_client(params) as (read, write):
            async with ClientSession(read, write) as client:
                await client.initialize()
                names = [tool.name for tool in (await client.list_tools()).tools]
                assert len(names) == 26, names
                for name, arguments in [('memory_workflow_templates', {}),
                    ('memory_knowledge_context', {'project': 'verification', 'query': 'SQLite'})]:
                    result = await client.call_tool(name, arguments)
                    assert not result.isError, result
                    value = json.loads(result.content[0].text)
                    if name == 'memory_workflow_templates': assert len(value['items']) == 8
                    else: assert value['context'] == '' and value['references'] == []
                assert (Path(data) / '.tmp').is_dir()
        report = {'mcp_tools': len(names), 'templates': 8, 'knowledge_context': 'ok',
            'same_volume_sqlite_temp': True, 'data': 'temporary-only', 'standalone_updated': False}
        output = ROOT / 'reports/memory-upgrade/frozen-smoke.json'
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(report, indent=2), 'utf-8')
        print(json.dumps(report))


if __name__ == '__main__': asyncio.run(verify())
