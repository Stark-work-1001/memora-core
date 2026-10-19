"""Host-specific configuration for this exact runtime. Generating config never installs it."""
import json
import sys
from pathlib import Path


def setup(root):
    data = str(Path(root).resolve())
    source = str(Path(__file__).resolve().parents[1])
    frozen = getattr(sys, 'frozen', False)
    args = [*([] if frozen else ['-m', 'memora']), '--data', data, 'mcp']
    config = {'command': sys.executable, 'args': args, 'cwd': str(Path(sys.executable).parent) if frozen else source,
              'env': {'PYTHONUTF8': '1', 'TEMP': str(Path(data) / '.tmp'), 'TMP': str(Path(data) / '.tmp')}}
    def quote(value): return json.dumps(value, ensure_ascii=False)
    toml = '\n'.join(['[mcp_servers.memora]', 'command = ' + quote(config['command']),
        'args = ' + quote(args), 'cwd = ' + quote(config['cwd']), 'startup_timeout_sec = 30',
        'tool_timeout_sec = 180', '', '[mcp_servers.memora.env]', 'PYTHONUTF8 = "1"',
        'TEMP = ' + quote(config['env']['TEMP']), 'TMP = ' + quote(config['env']['TMP'])])
    dsh = {'insert': [{'id': 'memory-memora', 'name': '@deepseek-ai/dsh-mcp-client',
        'config': dict(config, serverName='memora', transport='stdio', toolCallTimeoutMs=180000)}]}
    lifecycle_source = Path(source) / 'integrations/dsh/memora-plugin.mjs'
    if not frozen and lifecycle_source.is_file():
        lifecycle = {'project': 'default', 'url': 'http://127.0.0.1:18184/mcp',
            'tokenFile': str(Path(data) / 'mcp-token'), 'outbox': str(Path(data) / 'integrations/dsh-outbox')}
        if Path(data) == Path(source) / 'data': lifecycle['startScript'] = str(Path(source) / 'start-memora.ps1')
        dsh['insert'].append({'id': 'memora-lifecycle', 'name': str(lifecycle_source), 'config': lifecycle})
    return {'mcpServers': {'memora': config}, 'codex_toml': toml,
            'dsh_patch': [dsh], 'data_dir': data,
            'gateway_command': {'command': sys.executable, 'cwd': config['cwd'],
                'args': [*args[:-1], 'serve', '--port', '8765', '--mcp-port', '18184']},
            'lifecycle': {'start': 'memory_digest or memory_knowledge_context',
                'heartbeat': 'memory_peer_heartbeat every 30 seconds (ttl 90)',
                'finish': 'memory_absorb with stable event_id and ordered user/assistant turns'},
            'instructions': '复制到宿主配置并重新加载 MCP。配置生成不等于连接成功；先检查 memory_status 的 data_dir，'
                '再执行一次工具调用。在线状态来自宿主心跳；Codex 不承诺自动运行会话结束钩子。'
                'DSH 自动注入/吸收使用生命周期插件，并需启动 gateway_command 对应的同库 HTTP 服务；'
                '不要挂载同名 MCP 实例两次。'}
