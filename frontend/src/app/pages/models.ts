/**
 * 模型：六个角色（models.ROLES：chat / embedding / reranker / judge / extractor / vision）的档位表单，
 * 保存到 /api/models，单档测试，调用日志表格，健康徽章。
 *
 * 1.0.0 的漂移：只给 4 个角色；provider 选项与后端 PROVIDERS 对不上（custom 不存在）；
 * 超时以秒发 `timeout`，后端读的是毫秒 `timeout_ms` → 设置被静默忽略。
 */

import { el } from '../dom';
import { api, errorMessage } from '../api';
import type { ModelCall, ModelProfile, ModelRole, ModelRoleHealth, ModelsState, ModelTestResult } from '../types';
import { MODEL_PROVIDERS, MODEL_ROLES } from '../types';
import {
  badge, button, busy, card, emptyState, errorState, fmtDateTime, fmtDuration, fmtNumber,
  numberInput, select, skeleton, textInput, toast,
} from './ui';
import type { PageModule } from './contract';

const ROLE_TEXT: Record<ModelRole, { label: string; hint: string }> = {
  chat: { label: 'chat · 对话 / 生成', hint: '用于生成、摘要等需要自然语言输出的节点' },
  embedding: { label: 'embedding · 向量', hint: '维度 dim 必须与索引一致；不可用时回落本地 256 维字符哈希' },
  reranker: { label: 'reranker · 重排', hint: '不可用时分数透传 + FTS 加权' },
  judge: { label: 'judge · 判定', hint: '用于分类、去重裁决、冲突判定；返回必须是 JSON' },
  extractor: { label: 'extractor · 抽取', hint: '从会话 / 文档中抽取候选记忆与实体' },
  vision: { label: 'vision · 视觉', hint: '图片 / 截图理解；未配置时相关节点如实降级' },
};

const ROLES = MODEL_ROLES.map((role) => ({ role, ...ROLE_TEXT[role] }));

const PROVIDER_TEXT: Record<string, string> = {
  openai: 'OpenAI',
  'openai-compatible': 'OpenAI 兼容接口',
  dashscope: 'DashScope 原生',
  deepseek: 'DeepSeek',
  ollama: 'Ollama 本地',
  none: '禁用该角色（none）',
};

const PROVIDERS = MODEL_PROVIDERS.map((value) => ({ value, label: `${PROVIDER_TEXT[value] ?? value} · ${value}` }));

/** 后端默认超时（models.DEFAULT_TIMEOUT_MS / server 写入默认值）。 */
const DEFAULT_TIMEOUT_MS = 60000;

function emptyProfile(role: ModelRole): ModelProfile {
  return {
    role,
    provider: 'openai-compatible',
    base_url: '',
    model: '',
    dim: role === 'embedding' ? 1024 : undefined,
    batch: 16,
    timeout_ms: DEFAULT_TIMEOUT_MS,
    enabled: true,
  };
}

interface FormHandle {
  node: HTMLElement;
  collect(): Record<string, unknown>;
  setProfile(profile: ModelProfile): void;
  profileId(): string;
}

function createForm(role: ModelRole): FormHandle {
  let current: ModelProfile = emptyProfile(role);

  const provider = select({
    items: PROVIDERS,
    value: current.provider,
    onChange: (value) => { current.provider = value; },
  });
  const baseUrl = textInput({ value: current.base_url ?? '', placeholder: 'https://api.example.com/v1' });
  const model = textInput({ value: current.model ?? '', placeholder: 'gpt-4o-mini / text-embedding-3-small' });
  const apiKey = textInput({ value: '', placeholder: current.api_key_ref ? '已设置（留空表示不修改）' : 'sk-…', type: 'password' });
  const dim = numberInput({ value: current.dim, min: 1, max: 8192 });
  const batch = numberInput({ value: current.batch ?? 16, min: 1, max: 512 });
  const timeout = numberInput({ value: (current.timeout_ms ?? DEFAULT_TIMEOUT_MS) / 1000, min: 1, max: 600, step: 1 });

  const node = el('div', { class: 'model-form' },
    el('div', { class: 'form-grid' },
      el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'provider'), provider),
      el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'base_url'), baseUrl),
      el('label', { class: 'field field-wide' }, el('span', { class: 'field-label' }, 'model'), model),
      el('label', { class: 'field field-wide' }, el('span', { class: 'field-label' }, 'api_key'), apiKey),
      el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'dim'), dim),
      el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'batch'), batch),
      el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'timeout（秒）'), timeout)));

  return {
    node,
    collect() {
      const seconds = Number(timeout.value);
      const payload: Record<string, unknown> = {
        role,
        provider: provider.value,
        base_url: baseUrl.value.trim(),
        model: model.value.trim(),
        dim: dim.value ? Number(dim.value) : undefined,
        batch: batch.value ? Number(batch.value) : undefined,
        // 后端字段是毫秒 timeout_ms（1.0.0 发的是秒 timeout，被忽略）
        timeout_ms: Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : undefined,
        enabled: current.enabled ?? true,
      };
      // 已有档位：带上 id 原地更新（否则改了 model 名就会新建一条档位）
      if (current.id) payload.id = current.id;
      if (apiKey.value.trim()) payload.api_key = apiKey.value.trim();
      // 没填新密钥时必须回传原引用，否则后端会把 api_key_ref 置空、密钥失联
      else if (current.api_key_ref) payload.api_key_ref = current.api_key_ref;
      return payload;
    },
    setProfile(profile) {
      current = { ...emptyProfile(role), ...profile, role };
      if (profile.provider) provider.value = profile.provider;
      baseUrl.value = profile.base_url ?? '';
      model.value = profile.model ?? '';
      apiKey.value = '';
      apiKey.placeholder = profile.api_key_ref ? '已设置（留空表示不修改）' : 'sk-…';
      dim.value = profile.dim ? String(profile.dim) : '';
      batch.value = profile.batch === undefined ? '' : String(profile.batch);
      timeout.value = String(Math.round((profile.timeout_ms ?? DEFAULT_TIMEOUT_MS) / 1000));
    },
    profileId() {
      return String(current.id ?? '');
    },
  };
}

export const modelsPage: PageModule = {
  id: 'models',
  title: '模型',
  icon: 'models',
  group: 'main',
  shortcut: 'g l',
  render(ctx) {
    let disposed = false;
    let models: ModelsState = { roles: {}, by_role: {}, profiles: [], health: {}, degraded: [] };
    let calls: ModelCall[] = [];
    const forms = new Map<string, FormHandle>();

    const page = el('div', { class: 'page page-models' });
    ctx.mount.appendChild(page);

    const healthHost = el('div', { class: 'model-health' });
    const formsHost = el('div', { class: 'model-forms' });
    const callsHost = el('div', { class: 'model-calls' });

    page.append(
      el('div', { class: 'page-head' },
        el('div', { class: 'page-head-left' },
          el('h1', { class: 'page-title' }, '模型档位'),
          el('div', { class: 'page-head-meta' },
            el('span', { class: 'muted-text' }, '任何调用失败都会抛 ModelUnavailable 并降级，不返回假数据'))),
        el('div', { class: 'page-head-actions' },
          button('刷新', { iconName: 'refresh', onClick: () => void load() }))),
      healthHost,
      formsHost,
      callsHost,
    );

    /** 角色当前生效的档位：roles[role]（按 priority 选中）→ by_role 第一条 → profiles 里同 role 的第一条。 */
    function profileFor(role: ModelRole): ModelProfile | null {
      return models.roles[role] ?? models.by_role[role]?.[0] ?? models.profiles.find((p) => p.role === role) ?? null;
    }

    function healthFor(role: ModelRole): ModelRoleHealth {
      return models.health[role] ?? {};
    }

    function healthChips(): void {
      const chips = el('div', { class: 'role-chips' });
      for (const item of ROLES) {
        const health = healthFor(item.role);
        const configured = Boolean(health.configured);
        const ok = configured && Boolean(health.ok) && !health.degraded;
        const tone = ok ? 'ok' : configured ? 'warn' : 'muted';
        const label = ok ? '正常' : configured ? '降级' : '未配置';
        const title = [health.last_error, health.calls_24h ? `24h 调用 ${health.calls_24h} 次 · 平均 ${health.avg_latency_ms ?? 0} ms` : '']
          .filter(Boolean).join(' · ');
        chips.appendChild(el('div', { class: 'role-chip', title, dataset: { role: item.role } },
          el('span', { class: 'role-name' }, item.role),
          badge(label, tone),
          health.model ? el('span', { class: 'mono muted-text' }, String(health.model)) : null));
      }
      const notes: HTMLElement[] = [];
      if (models.note) notes.push(el('div', { class: 'form-warning' }, models.note));
      healthHost.replaceChildren(chips, ...notes);
    }

    function renderForms(): void {
      forms.clear();
      const grid = el('div', { class: 'grid grid-2 align-start' });
      for (const item of ROLES) {
        const saved = profileFor(item.role);
        const profile = saved ?? emptyProfile(item.role);
        const health = healthFor(item.role);
        const form = createForm(item.role);
        form.setProfile(profile);
        forms.set(String(item.role), form);

        const saveBtn = button('保存', { kind: 'primary' });
        const testBtn = button('测试连接', {
          iconName: 'play',
          disabled: !saved?.id,
          title: saved?.id ? `测试档位 ${saved.id}` : '先保存档位再测试',
        });
        const resultLine = el('div', { class: 'test-result', 'aria-live': 'polite' });

        saveBtn.addEventListener('click', async () => {
          const done = busy(saveBtn);
          try {
            await api.saveModel(item.role, form.collect());
            toast(`${item.role} 档位已保存`, 'ok');
            await load();
          } catch (error) {
            toast(errorMessage(error), 'danger');
          } finally {
            done();
          }
        });

        testBtn.addEventListener('click', async () => {
          const done = busy(testBtn);
          resultLine.replaceChildren(el('span', { class: 'spinner spinner-sm' }), el('span', null, ' 测试中…'));
          try {
            const result: ModelTestResult = await api.testModel(form.profileId());
            if (result.ok) {
              resultLine.replaceChildren(badge('连通', 'ok'),
                el('span', { class: 'muted-text' }, `延迟 ${fmtDuration(result.latency_ms ?? 0)} · ${result.detail ?? ''}`));
            } else {
              resultLine.replaceChildren(badge('失败', 'danger'),
                el('span', { class: 'muted-text' }, result.detail ?? '未知错误'));
            }
            void loadCalls();
          } catch (error) {
            resultLine.replaceChildren(badge('失败', 'danger'),
              el('span', { class: 'muted-text' }, errorMessage(error)));
          } finally {
            done();
          }
        });

        const box = card({
          title: item.label,
          subtitle: saved?.id ? `${item.hint} · 档位 ${saved.id}` : item.hint,
          actions: [saveBtn, testBtn],
        });
        box.dataset.role = item.role;
        box.appendChild(form.node);
        box.appendChild(resultLine);
        if (health.last_error && health.configured) {
          box.appendChild(el('div', { class: 'form-warning' }, `最近错误：${health.last_error}`));
        }
        grid.appendChild(box);
      }
      formsHost.replaceChildren(grid);
    }

    function renderCalls(): void {
      const box = card({
        title: '调用日志',
        subtitle: calls.length ? `最近 ${calls.length} 条` : '暂无调用',
        actions: [button('刷新', { kind: 'subtle', iconName: 'refresh', onClick: () => void loadCalls() })],
      });
      if (!calls.length) {
        box.appendChild(emptyState('还没有模型调用', '运行一个需要模型的工作流后会出现记录'));
      } else {
        const table = el('table', { class: 'data-table' });
        table.appendChild(el('thead', null, el('tr', null,
          ...['时间', '角色', '模型', '状态', '延迟', 'tokens', '错误'].map((h) => el('th', null, h)))));
        const tbody = el('tbody');
        for (const call of calls) {
          const ok = Boolean(call.ok);
          const failLabel = call.http_status ? `HTTP ${call.http_status}` : '失败';
          tbody.appendChild(el('tr', { class: ok ? '' : 'is-error' },
            el('td', { class: 'mono' }, fmtDateTime(call.created_at)),
            el('td', null, call.role ?? '—'),
            el('td', { class: 'mono' }, call.model ?? '—'),
            el('td', null, ok ? badge('成功', 'ok') : badge(failLabel, 'danger'), call.degraded ? badge('降级', 'warn') : null),
            el('td', { class: 'mono' }, fmtDuration(call.latency_ms ?? 0)),
            el('td', { class: 'mono' }, `${fmtNumber(call.prompt_tokens ?? 0)}/${fmtNumber(call.completion_tokens ?? 0)}`),
            el('td', { class: 'truncate', title: call.error ?? '' }, call.error ?? '')));
        }
        table.appendChild(tbody);
        box.appendChild(el('div', { class: 'table-wrap' }, table));
      }
      callsHost.replaceChildren(box);
    }

    async function loadCalls(): Promise<void> {
      try {
        calls = await api.modelCalls(50);
        if (disposed) return;
        renderCalls();
      } catch (error) {
        if (disposed) return;
        if (errorMessage(error)) {
          callsHost.replaceChildren(errorState({
            error,
            compact: true,
            title: '调用日志不可用',
            onRetry: () => void loadCalls(),
          }));
        }
      }
    }

    async function load(): Promise<void> {
      formsHost.replaceChildren(skeleton(4));
      try {
        models = await api.models();
        if (disposed) return;
        healthChips();
        renderForms();
        void loadCalls();
      } catch (error) {
        if (disposed) return;
        models = { roles: {}, by_role: {}, profiles: [], health: {}, degraded: [] };
        healthChips();
        renderForms();
        formsHost.prepend(errorState({
          error,
          compact: true,
          title: '模型档位加载失败',
          onRetry: () => void load(),
        }));
      }
    }

    void load();

    const unsub = ctx.onEvent(['run', 'log'], () => {
      void loadCalls();
    });

    ctx.mount.addEventListener('mem:dispose', () => {
      disposed = true;
      unsub();
    }, { once: true });
  },
};
