import { memoryIdentity } from './brain-selection';

/** Generated locator suffixes belong in provenance, not in every visible 3D node label. */
export function displayMemoryTitle(title: string, body: string): string {
  const id = memoryIdentity(body);
  if (!id) return title;
  for (const suffix of [' ' + id, ' ' + id.slice(0, 8)]) {
    if (title.endsWith(suffix)) return title.slice(0, -suffix.length);
  }
  return title;
}

interface MemoryGraph { nodes: Array<{title: string; body: string}> }
export interface MemoryPresentationHost {
  graph: MemoryGraph;
  index: unknown;
  setGraph?(graph: MemoryGraph): void;
  labels: {setGraph(graph: MemoryGraph, index: unknown): void} | null;
  needsDraw: boolean;
}

export function installMemoryPresentation(host: MemoryPresentationHost): void {
  const clean = (graph: MemoryGraph): void => {
    for (const node of graph.nodes) node.title = displayMemoryTitle(node.title, node.body);
  };
  const original = host.setGraph?.bind(host);
  if (original) host.setGraph = graph => {clean(graph); original(graph);};
  if (host.graph?.nodes?.length) {
    clean(host.graph); host.labels?.setGraph(host.graph, host.index); host.needsDraw = true;
  }
}
