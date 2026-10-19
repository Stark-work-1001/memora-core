"""Rewrite the agents view: show supported protocols and live agents with their project scope."""
import pathlib

DEV = pathlib.Path(__file__).resolve().parents[2]
p = DEV / 'memora/static/memory.js'
text = p.read_text('utf-8')

OLD = '''async function peers() {
  const out = await api('peers');
  const active = out.items.filter(p => p.connected);
  $('connection').textContent = active.length ? '已连接 ' + active.map(p => p.name).join('、') : '暂无智能体在线';
  $('peers').replaceChildren(...out.items.map(p => {
    const card = node('article', undefined, 'card');
    card.append(
      node('h3', p.name),
      node('p', (p.connected ? '在线' : '心跳已过期') + ' · ' + (p.model || '未报告模型') + ' · ' + p.location),
      node('small', p.id + ' · ' + p.last_seen_age_seconds + ' 秒前 · ' + p.identity)
    );
    return card;
  }));
  if (!out.items.length) {
    empty($('peers'), '尚未收到心跳。配置 MCP 并由智能体调用 memory_peer_heartbeat 后，会在此显示。');
  }
}
$('refresh-peers').onclick = () => run(peers);'''

NEW = r'''/** Protocols this build actually speaks. Written from the transports the package ships, not from a
    wish list: mcp.py serves stdio, gateway.py serves bearer-protected Streamable HTTP, and the
    lifecycle plugin talks to that HTTP endpoint. Anything not in this table is not supported, and
    the panel says so rather than implying universal compatibility. */
const AGENT_PROTOCOLS = [
  {id: 'mcp-stdio', title: 'MCP · 标准输入输出',
   how: '宿主把 memora 作为子进程启动，通过 stdin/stdout 交换 JSON-RPC。',
   entry: 'python -m memora --data <数据目录> mcp',
   note: '最适合桌面宿主（DSH、Claude Desktop 等）；无需端口，无需密钥。'},
  {id: 'mcp-http', title: 'MCP · Streamable HTTP（loopback）',
   how: '只监听 127.0.0.1，用 Bearer 令牌鉴权；令牌在 data/mcp-token。',
   entry: 'GET {base}/mcp  ·  Authorization: Bearer <token>',
   note: '供无法拉起子进程的宿主；跨机器访问不在支持范围内。'},
  {id: 'http-json', title: '工作台 HTTP · JSON',
   how: '同一套只读/写入路由，页面自己用的就是它；需要同源 X-MM-Token。',
   entry: '/api/agent/<route>?project=<项目>',
   note: '给调试脚本和自建面板；不是稳定对外契约。'},
  {id: 'lifecycle', title: '生命周期适配器（宿主插件）',
   how: '在宿主里跑一小段插件：首步召回、空闲归档、发件箱重投、心跳过期。',
   entry: 'integrations/dsh/memora-plugin.mjs',
   note: '需要宿主支持插件机制；只有 MCP 宿主才能自动沉淀。'}
];

/** Render the protocol table once. It is static per build, so there is no reason to refetch it. */
function agentProtocols() {
  const host = $('agent-protocols');
  if (!host || host.childElementCount) return;
  host.replaceChildren(...AGENT_PROTOCOLS.map(protocol => {
    const card = node('article', undefined, 'card');
    card.append(
      node('h3', protocol.title),
      node('p', protocol.how),
      node('code', protocol.entry, 'protocol-entry'),
      node('small', protocol.note)
    );
    return card;
  }));
}

async function peers() {
  // No ?project= is passed on purpose: /peers defaults to every project and reports which one each
  // agent belongs to. Scoping the read to the page's current project was the reason a user with
  // four live heartbeats under `dsh` saw "暂无智能体在线" on the `default` project — the heading
  // pill then disagreed with the agents view as well. Both now read the same unscoped list.
  const out = await api('peers');
  const items = Array.isArray(out.items) ? out.items : [];
  const active = items.filter(p => p.connected);
  agentProtocols();

  $('connection').textContent = active.length
    ? '在线 ' + active.length + ' 个智能体'
    : (items.length ? '无在线智能体（' + items.length + ' 个已过期）' : '暂无智能体在线');

  const summary = $('agent-summary');
  if (summary) {
    const projects = out.projects || [];
    summary.textContent = items.length
      ? '共记录 ' + items.length + ' 个接入方，分布在 ' + projects.length + ' 个分区：'
        + projects.join('、') + '。心跳有效期为 90 秒，超时显示为离线。'
      : '尚未收到心跳。配置 MCP 并由智能体调用 memory_peer_heartbeat 后，会在此显示。';
  }

  $('peers').replaceChildren(...items.map(p => {
    const card = node('article', undefined, 'card' + (p.connected ? ' is-online' : ''));
    const badge = node('span', p.connected ? '在线' : '离线',
      'pill' + (p.connected ? ' is-ok' : ''));
    const head = node('div', undefined, 'row');
    head.append(node('h3', p.name), badge);
    card.append(
      head,
      node('p', lines(p.model || '未报告模型', p.location,
        p.project ? '分区 ' + p.project : '')),
      node('small', lines(p.id,
        p.connected ? '刚刚心跳' : (p.last_seen_age_seconds + ' 秒前的心跳'),
        Object.keys(p.capabilities || {}).length
          ? '能力 ' + Object.keys(p.capabilities).join('/') : '',
        p.identity))
    );
    return card;
  }));
  if (!items.length) {
    empty($('peers'), '尚未收到心跳。配置 MCP 并由智能体调用 memory_peer_heartbeat 后，会在此显示。');
  }
}
$('refresh-peers').onclick = () => run(peers);'''

if OLD not in text:
    raise SystemExit('peers() anchor not found')
text = text.replace(OLD, NEW, 1)
p.write_text(text, 'utf-8')
print('peers() rewritten')
