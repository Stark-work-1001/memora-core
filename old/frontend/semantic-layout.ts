/** Deterministic, bounded layout of stored relationships. Category attraction is geometry only. */
export interface LayoutNode { id: string; category: string }
export interface LayoutLink { a: string; b: string }
export interface LayoutPoint { x: number; y: number }

function hash(value: string): number {
  let result = 2166136261;
  for (const ch of value) result = Math.imul(result ^ ch.charCodeAt(0), 16777619);
  return result >>> 0;
}

export function semanticLayout(nodes: LayoutNode[], links: LayoutLink[]): Map<string, LayoutPoint> {
  const ordered = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
  const categories = [...new Set(nodes.map(n => n.category))].sort();
  const size = Math.max(260, Math.sqrt(nodes.length) * 85);
  const anchors = new Map(categories.map((category, index) => [category, {
    x: Math.cos(index / Math.max(1, categories.length) * Math.PI * 2) * size * .65,
    y: Math.sin(index / Math.max(1, categories.length) * Math.PI * 2) * size * .65,
  }]));
  const points = new Map(ordered.map(n => {
    const anchor = anchors.get(n.category)!;
    const angle = hash(n.id) / 4294967296 * Math.PI * 2;
    const radius = 30 + hash(n.id + ':r') % 150;
    return [n.id, {x: anchor.x + Math.cos(angle) * radius, y: anchor.y + Math.sin(angle) * radius}];
  }));
  const valid = links.filter(l => l.a !== l.b && points.has(l.a) && points.has(l.b));
  // 120 steps, at most the 400 nodes the map API returns: no perpetual physics worker.
  for (let step = 0; step < 120; step++) {
    const moves = ordered.map(() => ({x: 0, y: 0}));
    const byId = new Map(ordered.map((n, i) => [n.id, i]));
    for (let i = 0; i < ordered.length; i++) {
      const a = points.get(ordered[i].id)!;
      for (let j = i + 1; j < ordered.length; j++) {
        const b = points.get(ordered[j].id)!;
        let dx = a.x - b.x, dy = a.y - b.y;
        if (Math.abs(dx) + Math.abs(dy) < .01) dx = 1;
        const distance = Math.max(8, Math.hypot(dx, dy));
        const force = Math.min(18, 2000 / (distance * distance));
        const fx = dx / distance * force, fy = dy / distance * force;
        moves[i].x += fx; moves[i].y += fy; moves[j].x -= fx; moves[j].y -= fy;
      }
      const anchor = anchors.get(ordered[i].category)!;
      moves[i].x += (anchor.x - a.x) * .009;
      moves[i].y += (anchor.y - a.y) * .009;
    }
    for (const link of valid) {
      const i = byId.get(link.a)!, j = byId.get(link.b)!;
      const a = points.get(link.a)!, b = points.get(link.b)!;
      const dx = b.x - a.x, dy = b.y - a.y, distance = Math.max(1, Math.hypot(dx, dy));
      const force = (distance - 145) * .022;
      const fx = dx / distance * force, fy = dy / distance * force;
      moves[i].x += fx; moves[i].y += fy; moves[j].x -= fx; moves[j].y -= fy;
    }
    ordered.forEach((n, i) => {
      const p = points.get(n.id)!;
      const cooling = 1 - step / 145;
      p.x += Math.max(-15, Math.min(15, moves[i].x)) * cooling;
      p.y += Math.max(-15, Math.min(15, moves[i].y)) * cooling;
    });
  }
  return points;
}

export const CATEGORY_COLORS: Record<string, string> = {
  fact: '#426e8c', knowledge: '#397f68', preference: '#9b7244', decision: '#795d9c',
  procedure: '#42878c', lesson: '#a35e59',
};
