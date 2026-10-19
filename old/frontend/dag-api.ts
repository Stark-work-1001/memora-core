/**
 * The one place that talks to the network. Every call the canvas can make is
 * declared here so the surface stays auditable: session token, workflows read,
 * workflows write, runs read, start, cancel. Nothing else.
 *
 * Auth mirrors memora/static/memory.js: the app reads its session token from
 * /api/session and sends it as X-MM-Token on every mutating request.
 */

import type { DagEdge, DagNode, RunLike } from './dag-model';

export interface Workflow {
  id: string;
  title: string;
  dispatcher?: string;
  updated?: string;
  nodes: DagNode[];
  edges: DagEdge[];
}

export interface WorkflowsResponse {
  items: Workflow[];
}

export interface WorkflowTemplate extends Workflow {
  description: string;
  ready: boolean;
  missing_roles: string[];
}

/** A workflow as the canvas keeps it while editing. */
export interface WorkflowDraft {
  id: string;
  title: string;
  dispatcher: string;
  nodes: DagNode[];
  edges: DagEdge[];
}

export class DagApi {
  private token = '';

  constructor(private readonly project: string) {}

  private url(path: string): URL {
    const url = new URL('/api/agent/' + path, location.origin);
    url.searchParams.set('project', this.project);
    return url;
  }

  private async parse(response: Response): Promise<any> {
    let payload: any;
    try {
      payload = await response.json();
    } catch {
      throw new Error('服务响应异常：HTTP ' + response.status);
    }
    if (!response.ok || (payload && payload.error && typeof payload.error === 'object')) {
      throw new Error(payload?.error?.message || '请求失败：HTTP ' + response.status);
    }
    return payload;
  }

  /** One GET, no token: the app's own session endpoint. */
  async open(): Promise<void> {
    const response = await fetch(new URL('/api/session', location.origin));
    this.token = String((await this.parse(response)).token ?? '');
  }

  private async get(path: string): Promise<any> {
    return this.parse(await fetch(this.url(path)));
  }

  private async post(path: string, body: Record<string, unknown>): Promise<any> {
    return this.parse(await fetch(this.url(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-MM-Token': this.token },
      body: JSON.stringify({ project: this.project, ...body }),
    }));
  }

  async workflows(): Promise<Workflow[]> {
    const payload = (await this.get('workflows')) as WorkflowsResponse;
    return Array.isArray(payload?.items) ? payload.items : [];
  }

  async templates(): Promise<WorkflowTemplate[]> {
    return (await this.get('workflow-templates')).items || [];
  }

  async registry(): Promise<any> { return this.get('models'); }

  async save(draft: WorkflowDraft): Promise<any> {
    return this.post('workflows', {
      ...(draft.id ? { id: draft.id } : {}),
      title: draft.title,
      dispatcher: draft.dispatcher,
      nodes: draft.nodes.map((node) => ({
        id: node.id,
        operation: node.operation,
        model: node.model,
        instruction: node.instruction,
        // Positions round-trip verbatim: the store keeps floats, so re-rounding here would drift.
        ...(Number.isFinite(node.x) ? { x: node.x } : {}),
        ...(Number.isFinite(node.y) ? { y: node.y } : {}),
      })),
      edges: draft.edges.map((edge) => ({ from: edge.from, to: edge.to })),
    });
  }

  async runs(): Promise<RunLike[]> {
    const payload = (await this.get('workflow-runs')) as { items?: RunLike[] };
    return Array.isArray(payload?.items) ? payload.items : [];
  }

  async start(body: { workflow: string; slug: string; audience?: string; version?: number }): Promise<any> {
    return this.post('workflow-start', body);
  }

  async cancel(id: string): Promise<any> {
    return this.post('workflow-cancel', {id});
  }
}

/** Same precedence as the main workbench: query string, then the stored project. */
export function currentProject(): string {
  const params = new URLSearchParams(location.search);
  let stored = '';
  try {
    stored = localStorage.getItem('memora-project') ?? '';
  } catch {
    stored = '';
  }
  return params.get('project') || stored || 'default';
}
