/**
 * Both copied 3D apps read the same projection through this source.
 *
 * Two data sources, and the URL decides which one -- never both at once:
 *
 *   /brain/<layout>/?project=X                reads /api/agent/brain (real stored memories)
 *   /brain/<layout>/?project=X&preview=1      reads /api/agent/brain-preview (demo graph)
 *
 * The preview exists because the packaged app ships a clean `data/` template: with no memories the
 * real projection renders one placeholder node and there is nothing to look at. The demo graph is
 * read-only, is never stored, and the server refuses it as soon as the project has approved
 * memories -- so it can never stand in front of real data.
 *
 * Both shapes are converted to the SAME markdown projection here, so the two 3D renderers need no
 * knowledge of the preview at all: `vendor/**` stays unedited.
 */
export class MemorySource {
  readonly capabilities = {};
  async initial() {
    const params = new URLSearchParams(location.search);
    const project = params.get('project') || 'default';
    const outline = location.pathname.includes('/outline/');
    if (params.get('preview') === '1') {
      const preview = await this.loadPreview(project, outline);
      if (preview) return preview;
      // The server refuses a preview once real memories exist. Fall back rather than show an error:
      // the user asked for a brain view, and the real one is available.
    }
    const response = await fetch('/api/agent/brain?project=' + encodeURIComponent(project));
    if (!response.ok) throw new Error('无法加载记忆脑图');
    const payload = await response.json();
    return [{path: 'memora.md', name: 'Memora · ' + project,
      markdown: outline ? payload.outline : payload.dictionary, modified: Date.now()}];
  }
  async open() { return this.initial(); }
  async watch() { /* refreshed by the host's sync button */ }
  async close() {}

  /** Demo graph -> the same markdown projection the real path returns. */
  private async loadPreview(project: string, outline: boolean) {
    const response = await fetch('/api/agent/brain-preview?project=' + encodeURIComponent(project));
    if (!response.ok) return null;
    const payload = await response.json();
    if (!payload || payload.available === false || !payload.graph) return null;
    return [{path: 'memora.md', name: 'Memora · 演示预览',
      markdown: previewMarkdown(payload, outline), modified: Date.now(), preview: true}];
  }
}

type PreviewNode = { id: string; label: string; category: string; content: string };
type PreviewEdge = { a: string; b: string; relation: string };
type PreviewHierarchy = { parent: string; child: string; kind: string; evidence: string };

const CATEGORY_TITLES: Record<string, string> = {
  fact: '事实与词义', knowledge: '知识库', preference: '用户习惯',
  decision: '项目决策', procedure: '工具与步骤', lesson: '经验教训',
};

/**
 * Render the demo graph in EXACTLY the projection format memora/projections.py produces.
 *
 * The renderer builds edges by parsing this markdown:
 *   * a node is a `### ` heading whose following block carries `记忆 ID：<id>`;
 *   * a relationship is a line `relation → [[<target heading>]]`, and the `[[...]]` wikilink is
 *     what makes it an EDGE rather than ordinary body text.
 *
 * Getting that wrong is not cosmetic: without `[[...]]` and `记忆 ID：`, the relationship lines
 * were parsed as additional NODES, which is why the first preview attempt drew a cloud of labels
 * with no visible connections. The real projection is the spec, so this mirrors it line for line.
 */
function previewMarkdown(payload: any, outline: boolean): string {
  const nodes: PreviewNode[] = payload.graph.nodes || [];
  const edges: PreviewEdge[] = payload.graph.edges || [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const outgoing = new Map<string, PreviewEdge[]>();
  for (const edge of edges) {
    if (!outgoing.has(edge.a)) outgoing.set(edge.a, []);
    outgoing.get(edge.a)!.push(edge);
  }

  // Node headings must be unique: the wikilink target is the heading text, so two nodes sharing a
  // label would collide. The sample labels are distinct; this keeps a future edit honest.
  const labelOf = (node: PreviewNode): string => `${node.label} ${node.id}`;

  const blocks: string[] = [];
  blocks.push(outline ? '# Memora · 演示预览' : '# Memora · 词义与记忆关系（演示预览）');
  blocks.push('> ' + (payload.note || '演示数据，不是已保存的记忆。'));

  for (const [category, title] of Object.entries(CATEGORY_TITLES)) {
    const group = nodes.filter((node) => node.category === category);
    if (!group.length) continue;
    blocks.push('## ' + title);
    for (const node of group) {
      const label = labelOf(node);
      // Quote the body like the real projection does, so the preview exercises the same quoting
      // path instead of taking a shortcut the real data never takes.
      const body = node.content.split('\n').map((line) => '> ' + line).join('\n');
      const provenance = '> 来源：展示样例（非真实记录）';
      if (outline) {
        // The copied outline parser requires the note immediately after the heading.
        const lines = ['### ' + label, body, '> 记忆 ID：' + node.id, provenance];
        for (const edge of outgoing.get(node.id) || []) {
          const target = byId.get(edge.b);
          if (target) lines.push('关联：' + edge.relation + ' → [[' + labelOf(target) + ']]');
        }
        blocks.push(lines.join('\n'));
      } else {
        blocks.push('### ' + label, body, '记忆 ID：' + node.id, provenance);
        for (const edge of outgoing.get(node.id) || []) {
          const target = byId.get(edge.b);
          if (!target) continue;
          // Bidirectional edges are drawn by the renderer; emitting the reverse line as well would
          // double every connection, so only the source side is written -- same as the real path.
          blocks.push(edge.relation + ' → [[' + labelOf(target) + ']]');
        }
      }
    }
  }

  // Hierarchy is a separate, explicit projection in the real path (see projections.py: it renders
  // "关联：kind → [[child]]" under the parent and a nested branch in the outline). The preview
  // carries it too, because the outline view and the 3D grouping both read it -- without this the
  // demo looked flatter than real data ever does.
  const hierarchy: PreviewHierarchy[] = payload.graph.hierarchy || [];
  if (hierarchy.length) {
    if (outline) {
      blocks.push('## 显式层级与学习路径');
      for (const link of hierarchy) {
        const parent = byId.get(link.parent);
        const child = byId.get(link.child);
        if (!parent || !child) continue;
        blocks.push('### ' + labelOf(parent), '> 记忆 ID：' + parent.id, '> ' + parent.content,
          '> ' + link.kind + '：' + link.evidence,
          '#### ' + labelOf(child), '> 记忆 ID：' + child.id, '> ' + child.content);
      }
    } else {
      blocks.push('## 显式层级与学习路径');
      for (const link of hierarchy) {
        const parent = byId.get(link.parent);
        const child = byId.get(link.child);
        if (!parent || !child) continue;
        blocks.push(link.kind + ' → [[' + labelOf(child) + ']]  （' + link.evidence + '）');
      }
    }
  }

  return blocks.join('\n\n');
}

export function fail(error: unknown) {
  const message = document.createElement('p');
  message.textContent = '脑图启动失败：' + String(error) + '。请使用支持 WebGL 的浏览器，或查看知识列表。';
  document.body.append(message);
}
