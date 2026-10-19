"""Let a workflow node be assigned a model TYPE, not just a raw pool profile.

The user asked for the roles edited in 模型配置 to become selectable parts on the canvas. The pool
profile alone is the wrong control: two roles can share one profile (this deployment binds curator,
relation and verifier to a single `memory-judge`), so "which type is this node doing?" is not
derivable from the model id. This adds an explicit role selector that, when changed, picks the
profile that role is bound to. Choosing the type never invents a model: if the role is unbound the
selector says so and the model select stays authoritative.
"""
import pathlib

DEV = pathlib.Path(__file__).resolve().parents[2]
p = DEV / 'frontend/dag-main.ts'
text = p.read_text('utf-8')

# 1. Registry carries the role titles so the canvas can label the selector.
old_iface = """interface WorkflowCanvasRegistry {
  operations: string[];
  models: WorkflowModelProfile[];
  /** role -> model profile id. Used to pick a sensible default model for a new node. */
  bindings: Record<string, string | null>;
  workflows: unknown[];
  runs: unknown[];
}"""
new_iface = """interface WorkflowRoleSpec {
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
}"""
if old_iface not in text:
    raise SystemExit('registry interface anchor not found')
text = text.replace(old_iface, new_iface, 1)

# 2. A role selector above the model select in the node inspector.
old_block = """    box.append(node('label', '模型'));
    // A node's model must be one the registry knows, because workflows.py rejects a node whose
    // model is not in the configured pool ("node needs a supported operation and configured
    // model"). A free-text box let the canvas save a workflow that could never run. The embedded
    // canvas receives the pool from orchestration.js through setRegistry(); the standalone page
    // has no registry handoff, so it falls back to free text and keeps the saved value visible.
    const registryModels = window.memoraWorkflowCanvas?.registry?.models ?? [];"""

new_block = """    // --- 模型类型 ---------------------------------------------------------------
    // The role, not the profile, is what a node "is doing". Several roles can share one profile
    // (curator/relation/verifier all point at memory-judge in this deployment), so the profile id
    // alone cannot tell the user which kind of step this is. Pick a type here and the model select
    // below is set to the profile that type is bound to; an unbound type says so instead of
    // inventing a model.
    const registryRoles = window.memoraWorkflowCanvas?.registry?.roles ?? {};
    const registryBindings = window.memoraWorkflowCanvas?.registry?.bindings ?? {};
    const roleIds = Object.keys(registryRoles).filter(
      (role) => role !== 'embedding' && role !== 'judge'
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
    const registryModels = window.memoraWorkflowCanvas?.registry?.models ?? [];"""

if old_block not in text:
    raise SystemExit('inspector anchor not found')
text = text.replace(old_block, new_block, 1)

p.write_text(text, 'utf-8')
print('dag-main.ts: role selector added')
