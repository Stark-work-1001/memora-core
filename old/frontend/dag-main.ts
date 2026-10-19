/**
 * Workflow DAG canvas entry point.
 *
 * Owns the draft being edited and re-renders from it after every mutation. All
 * network access goes through DagApi; the complete call surface is session token,
 * workflows read/write, runs read, start and cancel.
 */

import { DagApi, currentProject, type Workflow, type WorkflowDraft } from './dag-api';
import { DagCanvas, type Selection } from './dag-canvas';
import {
  LAYOUT_DEFAULTS,
  OPERATION_IDS,
  emptyCycles,
  OPERATION_LABELS,
  STATUS_LABELS,
  detectCycles,
  layoutGraph,
  nodeStatuses,
  organizeSchedule,
  shouldAutoLayout,
  wouldCycle,
  type DagEdge,
  type DagNode,
  type Point,
  type RunLike,
} from './dag-model';

/** Registry handoff published by dag-embed.js (the workbench-embedded canvas).
 *
 *  The canvas itself owns node editing; this is the only value that crosses from the shell into
 *  the bundle. It exists so a node's model can be chosen from the configured pool, because
 *  workflows.py rejects a node whose model is not in that pool. */
interface WorkflowModelProfile {
  id: string;
  name: string;
  model: string;
  capability?: 'chat' | 'embedding' | 'rerank' | 'local';
}

interface WorkflowRoleSpec {
  title?: string;
  description?: string;
}

interface WorkflowCanvasRegistry {
  operations: string[];
  models: WorkflowModelProfile[];
  /** role -> model profile id. Used to pick a sensible default model for a new node. */
  bindings: Record<string, string | null>;
  /** role -> {title, description}. Lets the node editor name a type the user already knows from
   *  模型配置 and 分工与扩展空间, instead of showing a bare role key. */
  roles?: Record<string, WorkflowRoleSpec>;
  workflows: unknown[];
  runs: unknown[];
}

interface WorkflowCanvasBridge {
  booted: boolean;
  registry: WorkflowCanvasRegistry;
  setRegistry(next: Partial<WorkflowCanvasRegistry>): void;
}

declare global {
  interface Window {
    memoraWorkflowCanvas?: WorkflowCanvasBridge;
  }
}

const api = new DagApi(currentProject());
const draft: { current: WorkflowDraft | null } = { current: null };
let workflows: Workflow[] = [];
let runs: RunLike[] = [];
let selection: Selection = null;
let dirty = false;
let pollTimer = 0;

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const node = <T extends HTMLElement = HTMLElement>(tag: string, text?: string, cls?: string): T => {
  const element = document.createElement(tag) as T;
  if (text !== undefined) element.textContent = text;
  if (cls) element.className = cls;
  return element;
};

const btn = (id: string): HTMLButtonElement => el<HTMLButtonElement>(id);
const field = (id: string): HTMLInputElement => el<HTMLInputElement>(id);

const canvas = new DagCanvas(el('dag-canvas'), {
  onSelect(next) {
    selection = next;
    render();
  },
  onMoveNode(id, x, y) {
    const target = draft.current?.nodes.find((item) => item.id === id);
    if (!target) return;
    target.x = x;
    target.y = y;
    dirty = true;
    render();
  },
  onConnect(from, to) {
    const value = draft.current;
    if (!value) return;
    if (value.edges.some((edge) => edge.from === from && edge.to === to)) {
      notice('\u8fd9\u4e24\u4e2a\u8282\u70b9\u4e4b\u95f4\u5df2\u7ecf\u6709\u8fde\u7ebf\u3002', 'warn');
      return;
    }
    value.edges.push({ from, to });
    dirty = true;
    if (wouldCycle(value.nodes, value.edges.slice(0, -1), from, to)) {
      notice('\u8fde\u7ebf\u4f1a\u5f62\u6210\u73af\uff0c\u5df2\u963b\u6b62\u4fdd\u5b58\uff1a\u8bf7\u5220\u9664\u8be5\u8fde\u7ebf\u6216\u6539\u53d8\u5176\u4e00\u7aef\u3002', 'warn');
    }
    render();
  },
});

function notice(text: string, kind: 'ok' | 'warn' | 'error' | 'quiet' = 'quiet'): void {
  const bar = el('dag-notice');
  bar.textContent = text;
  bar.className = 'dag-notice dag-notice--' + kind;
  bar.hidden = !text;
}

function safe(action: () => Promise<void>, button?: HTMLButtonElement): void {
  const run = async (): Promise<void> => {
    if (button) button.disabled = true;
    try {
      await action();
    } catch (error) {
      notice(String((error as Error)?.message ?? error), 'error');
    } finally {
      if (button) button.disabled = false;
    }
  };
  void run();
}

/** Smallest unused positive integer id; the backend stores stage ids as short strings. */
function nextNodeId(nodes: DagNode[]): string {
  const used = new Set(nodes.map((item) => item.id));
  for (let candidate = 1; ; candidate += 1) if (!used.has(String(candidate))) return String(candidate);
  return '1';
}

function freeSpot(nodes: DagNode[]): Point {
  if (nodes.length === 0) return { x: LAYOUT_DEFAULTS.originX, y: LAYOUT_DEFAULTS.originY };
  const x = Math.max(...nodes.map((item) => item.x ?? LAYOUT_DEFAULTS.originX)) + LAYOUT_DEFAULTS.cardWidth + LAYOUT_DEFAULTS.columnGap;
  const y = nodes.reduce((sum, item) => sum + (item.y ?? 0), 0) / nodes.length;
  return { x, y: Math.round(y) };
}

function cyclesOf(value: WorkflowDraft) {
  return detectCycles(value.nodes, value.edges);
}

/**
 * Load a workflow into the draft, laying it out when the stored coordinates are not a
 * layout (see shouldAutoLayout).
 *
 * Auto-layout is a *view* decision, not an edit: it never sets `dirty`, so opening a
 * workflow whose nodes were stored without positions does not silently queue a save.
 * The positions become real the moment the user moves something, adds a node, organizes
 * or saves -- which is the same moment the canvas already tells the backend "this is the
 * arrangement I mean".
 *
 * Returns true when it laid the graph out, so the caller can say so in the notice bar.
 */
function loadDraft(id: string): boolean {
  const found = workflows.find((item) => item.id === id);
  if (!found) return false;
  const nodes = (found.nodes ?? []).map((item) => ({ ...item }));
  const edges = (found.edges ?? []).map((edge) => ({ from: edge.from, to: edge.to }));
  let arranged = false;
  if (shouldAutoLayout(nodes, edges)) {
    const result = layoutGraph(nodes, edges);
    for (const node of nodes) {
      const point = result.positions.get(node.id);
      if (!point) continue;
      node.x = point.x;
      node.y = point.y;
    }
    arranged = true;
  }
  draft.current = {
    id: found.id,
    title: found.title || found.id,
    dispatcher: found.dispatcher ?? '',
    nodes,
    edges,
  };
  selection = null;
  dirty = false;
  notice('');
  return arranged;
}

function selectWorkflow(id: string): void {
  const found = workflows.find((item) => item.id === id);
  if (!found) return;
  const arranged = loadDraft(id);
  if (arranged) autoLayoutNotice();
}

function autoLayoutNotice(): void {
  notice('\u8fd9\u4e2a\u5de5\u4f5c\u6d41\u6ca1\u6709\u4fdd\u5b58\u8fc7\u4f4d\u7f6e\uff0c\u5df2\u81ea\u52a8\u6309\u5206\u5c42\u6392\u597d\u3002\u7f16\u8f91\u5e76\u4fdd\u5b58\u540e\u4f4d\u7f6e\u5c31\u4f1a\u88ab\u8bb0\u4f4f\u3002', 'quiet');
}

function renderWorkflowList(): void {
  const list = el('dag-list-items');
  list.replaceChildren();
  for (const item of workflows) {
    const entry = node<HTMLButtonElement>('button', undefined, 'dag-workflow' + (item.id === draft.current?.id ? ' dag-workflow--active' : ''));
    entry.type = 'button';
    entry.dataset.wid = item.id;
    entry.append(node('strong', item.title || item.id));
    entry.append(
      node(
        'small',
        (item.nodes?.length ?? 0) + ' \u4e2a\u8282\u70b9 \u00b7 ' + (item.edges?.length ?? 0) + ' \u6761\u8fde\u7ebf' +
          (item.updated ? ' \u00b7 ' + String(item.updated).slice(0, 10) : '') +
          (item.dispatcher ? ' \u00b7 \u8c03\u5ea6\uff1a' + item.dispatcher : ''),
      ),
    );
    entry.onclick = () => {
      selectWorkflow(item.id);
      render();
      canvas.fit();
    };
    list.append(entry);
  }
  if (workflows.length === 0) {
    list.append(node('p', '\u5c1a\u65e0\u5de5\u4f5c\u6d41\u3002', 'dag-muted'));
  }
}

function renderInspector(value: WorkflowDraft, cycles: ReturnType<typeof cyclesOf>): void {
  const box = el('dag-inspector-body');
  box.replaceChildren();
  const pickedId = selection?.kind === 'node' ? selection.id : '';
  const picked = pickedId ? value.nodes.find((item) => item.id === pickedId) : undefined;
  if (selection?.kind === 'edge') {
    const edge = value.edges[selection.index];
    box.append(node('h2', '\u8fde\u7ebf'));
    if (!edge) {
      box.append(node('p', '\u8fd9\u6761\u8fde\u7ebf\u5df2\u88ab\u5220\u9664\u3002', 'dag-muted'));
    } else {
      const bad = cycles.edgeKeys.has(edge.from + '\u0000' + edge.to);
      box.append(node('p', edge.from + ' \u2192 ' + edge.to, bad ? 'dag-bad' : ''));
      if (bad) box.append(node('p', '\u8fd9\u6761\u8fde\u7ebf\u5728\u73af\u4e0a\uff0c\u5220\u9664\u5b83\u624d\u80fd\u4fdd\u5b58\u3002', 'dag-bad'));
      const remove = node<HTMLButtonElement>('button', '\u5220\u9664\u8fde\u7ebf', 'dag-danger');
      remove.type = 'button';
      remove.onclick = () => { if (selection?.kind === 'edge') removeEdge(selection.index); };
      box.append(remove);
    }
  } else if (picked) {
    box.append(node('h2', '\u8282\u70b9 ' + picked.id));
    box.append(node('label', '\u64cd\u4f5c'));
    const op = document.createElement('select');
    for (const id of OPERATION_IDS) {
      const option = node<HTMLOptionElement>('option', OPERATION_LABELS[id]);
      option.value = id;
      option.selected = id === picked.operation;
      op.append(option);
    }
    if (!OPERATION_IDS.includes(picked.operation)) {
      const option = node<HTMLOptionElement>('option', picked.operation + '\uff08\u672a\u77e5\u64cd\u4f5c\uff09');
      option.value = picked.operation;
      option.selected = true;
      op.append(option);
    }
    op.onchange = () => {
      picked.operation = op.value;
      dirty = true;
      render();
    };
    // --- 模型类型 ---------------------------------------------------------------
    // The role, not the profile, is what a node "is doing". Several roles can share one profile
    // (curator/relation/verifier all point at memory-judge in this deployment), so the profile id
    // alone cannot tell the user which kind of step this is. Pick a type here and the model select
    // below is set to the profile that type is bound to; an unbound type says so instead of
    // inventing a model.
    const registryRoles = window.memoraWorkflowCanvas?.registry?.roles ?? {};
    const registryBindings = window.memoraWorkflowCanvas?.registry?.bindings ?? {};
    const roleIds = Object.keys(registryRoles).filter(
      (role) => role !== 'embedding' && role !== 'judge' && role !== 'rerank'
    );
    if (roleIds.length) {
      box.append(node('label', '模型类型'));
      const roleSelect = document.createElement('select');
      roleSelect.setAttribute('aria-label', '节点模型类型');
      const noneRole = node<HTMLOptionElement>('option', '（不限类型 · 直接用模型池配置）');
      noneRole.value = '';
      roleSelect.append(noneRole);
      // The node does not store a role: a workflow is a graph of operations, and adding a field
      // the server does not validate would drift. Instead the currently bound profile is mapped
      // back to the roles that share it, so re-opening a saved node highlights the type it
      // effectively uses.
      const matching = roleIds.filter((role) => registryBindings[role] === picked.model);
      for (const role of roleIds) {
        const spec = registryRoles[role] ?? {};
        const option = node<HTMLOptionElement>('option', (spec.title || role) + (spec.description ? ' · ' + spec.description : ''));
        option.value = role;
        option.selected = matching.length === 1 && matching[0] === role;
        roleSelect.append(option);
      }
      roleSelect.onchange = () => {
        const profileId = registryBindings[roleSelect.value];
        if (!roleSelect.value) return;             // "不限类型" only clears the type hint
        if (!profileId) {
          // Say it in the canvas rather than silently leaving the old model in place: an unbound
          // type is a real configuration gap the user has to fix in 模型配置.
          roleSelect.title = '这个类型在「模型配置」里还没有绑定模型';
          return;
        }
        picked.model = profileId;
        dirty = true;
        render();
      };
      box.append(roleSelect);
    }

    box.append(node('label', '模型'));
    // A node's model must be one the registry knows, because workflows.py rejects a node whose
    // model is not in the configured pool ("node needs a supported operation and configured
    // model"). A free-text box let the canvas save a workflow that could never run. The embedded
    // canvas receives the pool from orchestration.js through setRegistry(); the standalone page
    // has no registry handoff, so it falls back to free text and keeps the saved value visible.
    const registryModels = window.memoraWorkflowCanvas?.registry?.models ?? [];
    if (registryModels.length) {
      const select = document.createElement('select');
      select.setAttribute('aria-label', '节点模型');
      const blank = node<HTMLOptionElement>('option', '（未绑定模型）');
      blank.value = '';
      blank.selected = !picked.model;
      select.append(blank);
      const needed = ({retrieve: 'local', embed_index: 'embedding', rerank: 'rerank'} as Record<string, string>)[picked.operation] || 'chat';
      for (const profile of registryModels.filter(p => (p.capability || 'chat') === needed)) {
        const option = node<HTMLOptionElement>('option', profile.name + ' · ' + profile.model);
        option.value = profile.id;
        option.selected = profile.id === picked.model;
        select.append(option);
      }
      // A workflow saved before the pool changed can point at an id that is gone; show it rather
      // than silently rewriting the node to "unbound".
      if (picked.model && !registryModels.some((profile) => profile.id === picked.model)) {
        const stale = node<HTMLOptionElement>('option', picked.model + '（已不在模型池）');
        stale.value = picked.model;
        stale.selected = true;
        select.append(stale);
      }
      select.onchange = () => {
        picked.model = select.value;
        dirty = true;
        render();
      };
      box.append(select);
    } else {
      const model = document.createElement('input');
      model.value = picked.model ?? '';
      model.placeholder = '模型配置 id';
      model.setAttribute('aria-label', '节点模型');
      model.oninput = () => {
        picked.model = model.value;
        dirty = true;
        render();
      };
      box.append(model);
    }
    box.append(node('label', '\u8bf4\u660e'));
    const instruction = document.createElement('textarea');
    instruction.rows = 4;
    instruction.value = picked.instruction ?? '';
    instruction.setAttribute('aria-label', '\u8282\u70b9\u8bf4\u660e');
    instruction.oninput = () => {
      picked.instruction = instruction.value;
      dirty = true;
      render();
    };
    box.append(op, instruction);
    const status = nodeStatuses(runs, value.id, value.nodes).get(picked.id) ?? 'pending';
    box.append(node('p', '\u72b6\u6001\uff1a' + STATUS_LABELS[status], 'dag-muted'));
    if (cycles.nodes.has(picked.id)) box.append(node('p', '\u8be5\u8282\u70b9\u5728\u73af\u4e0a\u3002', 'dag-bad'));
    const remove = node<HTMLButtonElement>('button', '\u5220\u9664\u8282\u70b9', 'dag-danger');
    remove.type = 'button';
    remove.onclick = () => removeNode(picked.id);
    box.append(remove);
  } else {
    box.append(node('h2', value.title || '\u5de5\u4f5c\u6d41'));
    box.append(node('p', '\u9009\u4e2d\u4e00\u4e2a\u8282\u70b9\u6216\u8fde\u7ebf\u5373\u53ef\u7f16\u8f91\u3002', 'dag-muted'));
    const title = document.createElement('input');
    title.value = value.title;
    title.setAttribute('aria-label', '\u5de5\u4f5c\u6d41\u6807\u9898');
    title.oninput = () => {
      value.title = title.value;
      dirty = true;
      render();
    };
    const dispatcher = document.createElement('input');
    dispatcher.value = value.dispatcher;
    dispatcher.placeholder = '\u8c03\u5ea6\u667a\u80fd\u4f53\uff08\u53ef\u9009\uff09';
    dispatcher.setAttribute('aria-label', '\u8c03\u5ea6\u667a\u80fd\u4f53');
    dispatcher.oninput = () => {
      value.dispatcher = dispatcher.value;
      dirty = true;
    };
    box.append(node('label', '\u6807\u9898'), title, node('label', '\u8c03\u5ea6\u667a\u80fd\u4f53'), dispatcher);
  }
}

function renderRunPanel(value: WorkflowDraft): void {
  const panel = el('dag-run-body');
  panel.replaceChildren();
  const latest = runs.find((run) => run.workflow === value.id);
  panel.append(
    node(
      'p',
      latest
        ? '\u6700\u8fd1\u4e00\u6b21\u8fd0\u884c\uff1a' + latest.status +
          (latest.updated ? ' \u00b7 ' + String(latest.updated).slice(0, 19).replace('T', ' ') : '')
        : '\u5c1a\u672a\u8fd0\u884c\u8fc7\u3002',
      'dag-muted',
    ),
  );
}

function render(): void {
  const value = draft.current;
  const empty = el('dag-empty');
  const cycles = value ? cyclesOf(value) : emptyCycles();
  if (!value) {
    empty.hidden = false;
    empty.replaceChildren(
      node('h2', '\u8fd8\u6ca1\u6709\u5de5\u4f5c\u6d41'),
      node('p', '\u5f53\u524d\u9879\u76ee\u4e0b\u6ca1\u6709\u4efb\u4f55\u5de5\u4f5c\u6d41\u3002\u65b0\u5efa\u4e00\u4e2a\u540e\u5c31\u53ef\u4ee5\u5728\u753b\u5e03\u4e0a\u6392\u7248\u8282\u70b9\u4e0e\u8fde\u7ebf\u3002'),
    );
    const create = node<HTMLButtonElement>('button', '\u65b0\u5efa\u5de5\u4f5c\u6d41');
    create.type = 'button';
    create.onclick = () => safe(createWorkflow, create);
    empty.append(create);
    canvas.render({ nodes: [], edges: [], statuses: new Map(), cycles, selected: null });
    el('dag-inspector-body').replaceChildren(
      node('h2', '\u5de5\u4f5c\u6d41'),
      node('p', '\u5148\u9009\u62e9\u6216\u65b0\u5efa\u4e00\u4e2a\u5de5\u4f5c\u6d41\u3002', 'dag-muted'),
    );
    el('dag-run-body').replaceChildren();
  } else {
    empty.hidden = value.nodes.length > 0;
    if (value.nodes.length === 0) {
      empty.replaceChildren(
        node('h2', value.title || '\u5de5\u4f5c\u6d41'),
        node('p', '\u8fd9\u4e2a\u5de5\u4f5c\u6d41\u8fd8\u6ca1\u6709\u8282\u70b9\u3002\u70b9\u51fb\u201c\u6dfb\u52a0\u8282\u70b9\u201d\u5f00\u59cb\u7f16\u6392\u3002'),
      );
    }
    canvas.render({
      nodes: value.nodes,
      edges: value.edges,
      statuses: nodeStatuses(runs, value.id, value.nodes),
      cycles,
      selected: selection,
    });
    renderInspector(value, cycles);
    renderRunPanel(value);
  }

  renderWorkflowList();
  const blocked = value !== null && cycles.nodes.size > 0;
  btn('dag-save').disabled = !value || blocked || !dirty;
  btn('dag-save').title = blocked ? '\u5b58\u5728\u73af\uff0c\u65e0\u6cd5\u4fdd\u5b58' : '';
  btn('dag-add-node').disabled = !value;
  btn('dag-remove-node').disabled = !value || selection?.kind !== 'node';
  btn('dag-remove-edge').disabled = !value || selection?.kind !== 'edge';
  btn('dag-organize').disabled = !value || value.nodes.length === 0;
  btn('dag-run').disabled = !value || !field('dag-slug').value.trim();
  btn('dag-cancel').disabled = !value || !runs.some((run) => run.workflow === value.id && run.status === 'running');
  const status = el('dag-state');
  if (!value) status.textContent = '';
  else if (blocked) status.textContent = '\u5b58\u5728\u73af\uff1a' + cycles.edges.length + ' \u6761\u8fde\u7ebf\u3001' + cycles.nodes.size + ' \u4e2a\u8282\u70b9\u5df2\u6807\u7ea2\uff0c\u4fdd\u5b58\u5df2\u7981\u7528';
  else status.textContent = '\u5df2\u4fdd\u5b58 ' + value.nodes.length + ' \u4e2a\u8282\u70b9' + (dirty ? ' \u00b7 \u6709\u672a\u4fdd\u5b58\u7684\u66f4\u6539' : '');
  status.className = blocked ? 'dag-state dag-state--warn' : 'dag-state';
}

function removeNode(id: string): void {
  const value = draft.current;
  if (!value) return;
  value.nodes = value.nodes.filter((item) => item.id !== id);
  value.edges = value.edges.filter((edge) => edge.from !== id && edge.to !== id);
  selection = null;
  dirty = true;
  render();
}

function removeEdge(index: number): void {
  const value = draft.current;
  if (!value || index < 0) return;
  value.edges.splice(index, 1);
  selection = null;
  dirty = true;
  render();
}

/** The model a brand-new node should start on.
 *
 *  control.save_workflow validates every node against the configured model pool, so a node saved
 *  with an empty model is rejected outright ("node needs a supported operation and configured
 *  model"). The canvas used to default to '' and rely on the user to type an id, which made
 *  "新建工作流" fail before it existed -- the first save is the creation, so there was nothing to
 *  edit yet. Prefer the registry's first profile, then the bindings, and only fall back to empty
 *  when the pool really is empty (nothing can run then, and the inspector says so).
 */
function defaultModel(): string {
  const registry = window.memoraWorkflowCanvas?.registry;
  const models = (registry?.models ?? []).filter(p => !p.capability || p.capability === 'chat');
  if (!models.length) return '';
  const bound = registry?.bindings as Record<string, string | null> | undefined;
  const preferred = bound && (bound.curator || bound.summarizer || bound.verifier);
  return preferred && models.some((profile) => profile.id === preferred) ? preferred : models[0].id;
}

function addNode(): void {
  const value = draft.current;
  if (!value) return;
  const spot = freeSpot(value.nodes);
  const fresh: DagNode = {
    id: nextNodeId(value.nodes),
    operation: OPERATION_IDS[0],
    model: defaultModel(),
    instruction: '',
    x: spot.x,
    y: spot.y,
  };
  value.nodes.push(fresh);
  selection = { kind: 'node', id: fresh.id };
  dirty = true;
  render();
}

/**
 * "Organize layout": snap the draft onto the layered layout.
 *
 * Idempotent by construction. layoutGraph reads only the node ids and the edges, so the
 * second run computes exactly the positions the first run produced, and animating from
 * those to those moves nothing. The transition runs through the canvas, which owns the
 * requestAnimationFrame handle: organizing twice in a row replaces the running
 * transition instead of racing a second one.
 */
function organize(options: { announce?: boolean; animate?: boolean } = {}): void {
  const value = draft.current;
  if (!value || value.nodes.length === 0) return;
  const { announce = true, animate = true } = options;
  const result = layoutGraph(value.nodes, value.edges);
  const steps = organizeSchedule(!animate || DagCanvas.prefersReducedMotion());
  const settle = (): void => {
    dirty = true;
    render();
    if (announce) notice('\u5df2\u6309\u6700\u957f\u8def\u5f84\u5206\u5c42\u91cd\u65b0\u6392\u7248\u3002', 'ok');
  };
  // The canvas writes the new coordinates straight into the draft's node objects and
  // repaints the SVG it already owns, so nothing else has to run per frame: a full
  // render() mid-transition would rebuild every card twenty times a second to show
  // the same thing. One repaint when the cards have landed.
  canvas.animateTo(result.positions, steps, () => undefined, () => {
    settle();
    canvas.fit();
  });
}
/**
 * Reload the workflow list and re-select the draft.
 *
 * The reload is the one place every entry path funnels through -- first load, saving and
 * creating -- so this is where the auto-layout has to live; a rule wired only into the
 * rail's click handler lays out the first workflow and then piles up every later one.
 *
 * An already-selected draft is never re-selected here: the user may have unsaved edits,
 * and re-selecting would throw them away to re-run the layout rule on stale rows.
 */
async function loadWorkflows(): Promise<void> {
  workflows = await api.workflows();
  if (draft.current && !workflows.some((item) => item.id === draft.current?.id)) draft.current = null;
  if (!draft.current && workflows.length > 0) selectWorkflow(workflows[0].id);
  render();
  if (draft.current) canvas.fit();
}

async function save(): Promise<void> {
  const value = draft.current;
  if (!value) return;
  if (cyclesOf(value).nodes.size > 0) {
    notice('\u5b58\u5728\u73af\uff0c\u8bf7\u5148\u5220\u9664\u5faa\u73af\u8fde\u7ebf\u3002', 'warn');
    return;
  }
  const result = await api.save(value);
  if (result && typeof result.id === 'string' && result.id !== value.id) value.id = result.id;
  dirty = false;
  notice('\u5df2\u4fdd\u5b58\u5de5\u4f5c\u6d41\u3002', 'ok');
  await loadWorkflows();
}

async function createWorkflow(): Promise<void> {
  const value: WorkflowDraft = {
    id: '',
    title: '\u65b0\u5de5\u4f5c\u6d41',
    dispatcher: '',
    nodes: [
      {
        id: '1',
        operation: OPERATION_IDS[0],
        model: defaultModel(),
        instruction: '',
        x: LAYOUT_DEFAULTS.originX,
        y: LAYOUT_DEFAULTS.originY,
      },
    ],
    edges: [],
  };
  draft.current = value;
  dirty = true;
  render();
  canvas.fit();
  notice('\u5df2\u65b0\u5efa\u5de5\u4f5c\u6d41\uff0c\u53ef\u7ee7\u7eed\u6dfb\u52a0\u8282\u70b9\u3002', 'ok');
}

async function refreshRuns(): Promise<void> {
  runs = await api.runs();
  const value = draft.current;
  const active = value ? runs.some((run) => run.workflow === value.id && run.status === 'running') : false;
  window.clearInterval(pollTimer);
  // Poll only while something is actually in flight; an idle canvas makes no calls.
  if (active && !document.hidden) pollTimer = window.setInterval(() => safe(refreshRuns), 5000);
  render();
}

async function startRun(button: HTMLButtonElement): Promise<void> {
  const value = draft.current;
  const slug = field('dag-slug').value.trim();
  if (!value || !slug) return;
  await api.start({ workflow: value.id, slug, audience: field('dag-slug').dataset.audience ?? 'human' });
  notice('\u5df2\u63d0\u4ea4\u8fd0\u884c\uff0c\u8bf7\u89c2\u5bdf\u8282\u70b9\u72b6\u6001\u3002', 'ok');
  await refreshRuns();
  button.disabled = true;
}

async function cancelRun(button: HTMLButtonElement): Promise<void> {
  const active = runs.find(run => run.workflow === draft.current?.id && run.status === 'running');
  if (!active?.id) return;
  await api.cancel(active.id);
  notice('\u5df2\u8bf7\u6c42\u53d6\u6d88\u3002', 'ok');
  await refreshRuns();
  button.disabled = true;
}

function bindToolbar(): void {
  btn('dag-add-node').onclick = addNode;
  btn('dag-remove-node').onclick = () => {
    if (selection?.kind === 'node') removeNode(selection.id);
  };
  btn('dag-remove-edge').onclick = () => {
    if (selection?.kind === 'edge') removeEdge(selection.index);
  };
  btn('dag-organize').onclick = () => organize();
  el('dag-fit').onclick = () => canvas.fit();
  el('dag-zoom-in').onclick = () => canvas.zoomBy(1.2);
  el('dag-zoom-out').onclick = () => canvas.zoomBy(1 / 1.2);
  btn('dag-save').onclick = (event) => safe(save, event.currentTarget as HTMLButtonElement);
  btn('dag-run').onclick = (event) => safe(() => startRun(event.currentTarget as HTMLButtonElement), event.currentTarget as HTMLButtonElement);
  btn('dag-cancel').onclick = (event) => safe(() => cancelRun(event.currentTarget as HTMLButtonElement), event.currentTarget as HTMLButtonElement);
  el('dag-refresh-runs').onclick = () => safe(refreshRuns);
  field('dag-slug').oninput = render;
  el<HTMLSelectElement>('dag-audience').onchange = (event) => {
    field('dag-slug').dataset.audience = (event.currentTarget as HTMLSelectElement).value;
  };
  el('dag-new-workflow').onclick = (event) => safe(createWorkflow, event.currentTarget as HTMLButtonElement);
  document.addEventListener('keydown', (event) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
    if (event.key === 'Delete' || event.key === 'Backspace') {
      if (selection?.kind === 'node') removeNode(selection.id);
      else if (selection?.kind === 'edge') removeEdge(selection.index);
      event.preventDefault();
      return;
    }
    if (event.key === 'Escape') {
      selection = null;
      render();
    }
  });
  window.addEventListener('resize', () => render());
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) safe(refreshRuns);
  });
}

bindToolbar();
safe(async () => {
  await api.open();
  // The same template picker is mounted in both the embedded and direct canvas.
  const rail = el('dag-list-items').parentElement!;
  const picker = node<HTMLSelectElement>('select');
  picker.id = 'dag-template'; picker.setAttribute('aria-label', '记忆工作流模板');
  picker.append(node<HTMLOptionElement>('option', '选择记忆工作流模板…'));
  const templates = await api.templates();
  for (const template of templates) {
    const option = node<HTMLOptionElement>('option', template.title + (template.ready ? '' : ' · 需配置模型'));
    option.value = template.id; picker.append(option);
  }
  const useTemplate = node<HTMLButtonElement>('button', '从模板编排');
  useTemplate.id = 'dag-use-template'; useTemplate.type = 'button';
  useTemplate.onclick = () => {
    const template = templates.find(t => t.id === picker.value);
    if (!template) return;
    if (dirty && !window.confirm('当前工作流有未保存修改，是否载入模板？')) return;
    draft.current = {id: '', title: template.title, dispatcher: '',
      nodes: template.nodes.map(n => ({...n})), edges: template.edges.map(e => ({...e}))};
    dirty = true; selection = null; render(); canvas.fit();
    notice(template.description + (template.ready ? ' · 保存后可运行。' : ' · 请为节点配置：' + template.missing_roles.join('、')), template.ready ? 'ok' : 'warn');
  };
  const templateBox = node('div', undefined, 'dag-template-box');
  templateBox.append(picker, useTemplate); rail.insertBefore(templateBox, el('dag-list-items'));
  const registry = await api.registry();
  if (window.memoraWorkflowCanvas) window.memoraWorkflowCanvas.setRegistry({
    ...registry, models: registry.workflow_models || registry.models || []});
  else window.memoraWorkflowCanvas = {booted: true, registry: {...registry,
    models: registry.workflow_models || registry.models || [], workflows: [], runs: []},
    setRegistry(next) { Object.assign(this.registry, next); render(); }};
  await loadWorkflows();
  await refreshRuns();
  render();
});
