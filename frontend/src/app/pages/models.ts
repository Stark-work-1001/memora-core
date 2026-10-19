/**
 * 模型：四个角色（chat / embedding / reranker / judge）的档位表单，
 * 保存到 /api/models，单档测试，调用日志表格，健康徽章。
 */

import { el } from '../dom';
import { api, errorMessage } from '../api';
import type { ModelCall, ModelProfile, ModelRole, ModelTestResult } from '../types';
import {
  badge, button, busy, card, emptyState, errorState, fmtDateTime, fmtDuration, fmtNumber,
  numberInput, select, skeleton, textInput, toast,
} from './ui';
import type { PageModule } from './contract';

const ROLES: { role: ModelRole; label: string; hint: string }[] = [
  { role: 'chat', label: 'chat · 对话 / 生成', hint: '用于抽取、生成、摘要等需要自然语言输出的节点' },
  { role: 'embedding', label: 'embedding · 向量', hint: '维度 dim 必须与索引一致；不可用时回落本地 256 维字符哈希' },
  { role: 'reranker', label: 'reranker · 重排', hint: '不可用时分数透传 + FTS 加权' },
  { role: 'judge', label: 'judge · 判定', hint: '用于分类、去重裁决、冲突判定；返回必须是 JSON' },
];

const PROVIDERS = [
  { value: 'openai', label: 'OpenAI 兼容' },
  { value: 'dashscope', label: 'DashScope 原生' },
  { value: 'ollama', label: 'Ollama 本地' },
  { value: 'custom', label: '自定义' },
];

function emptyProfile(role: ModelRole): ModelProfile {
  return {
    role,
    provider: role === 'embedding' ? 'openai' : 'openai',
    base_url: '',
    model: '',
    api_key: '',
    dim: role === 'embedding' ? 1024 : undefined,
    batch: 16,
    timeout: 30,
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
  const apiKey = textInput({ value: '', placeholder: current.api_key_set ? '已设置（留空表示不修改）' : 'sk-…', type: 'password' });
  const dim = numberInput({ value: current.dim, min: 1, max: 8192 });
  const batch = numberInput({ value: current.batch ?? 16, min: 1, max: 512 });
  const timeout = numberInput({ value: current.timeout ?? 30, min: 1, max: 600 });

  const node = el('div', { class: 'model-form' },
    el('div', { class: 'form-grid' },
      el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'provider'), provider,
        role === 'embedding' ? null : el('span', { class: 'field-hint' }, 'OpenAI 兼容 / DashScope / Ollama')),
      el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'base_url'), baseUrl),
      el('label', { class: 'field field-wide' }, el('span', { class: 'field-label' }, 'model'), model),
      el('label', { class: 'field field-wide' }, el('span', { class: 'field-label' }, 'api_key'), apiKey),
      el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'dim'), dim),
      el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'batch'), batch),
      el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'timeout（秒）'), timeout)));

  return {
    node,
    collect() {
      const payload: Record<string, unknown> = {
        role,
        provider: provider.value,
        base_url: baseUrl.value.trim(),
        model: model.value.trim(),
        dim: dim.value ? Number(dim.value) : undefined,
        batch: batch.value ? Number(batch.value) : undefined,
        timeout: timeout.value ? Number(timeout.value) : undefined,
        enabled: true,
      };
      if (apiKey.value.trim()) payload.api_key = apiKey.value.trim();
      return payload;
    },
    setProfile(profile) {
      current = { ...emptyProfile(role), ...profile, role };
      if (profile.provider) provider.value = profile.provider;
      baseUrl.value = profile.base_url ?? '';
      model.value = profile.model ?? '';
      apiKey.value = '';
      apiKey.placeholder = profile.api_key_set ? '已设置（留空表示不修改）' : 'sk-…';
      dim.value = profile.dim === undefined ? '' : String(profile.dim);
      batch.value = profile.batch === undefined ? '' : String(profile.batch);
      timeout.value = profile.timeout === undefined ? '' : String(profile.timeout);
    },
    profileId() {
      return String(current.id ?? current.role ?? role);
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
    let profiles: ModelProfile[] = [];
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

    function healthChips(): void {
      const chips = el('div', { class: 'role-chips' });
      for (const item of ROLES) {
        const profile = profiles.find((p) => p.role === item.role);
        const ok = profile?.ok ?? (profile?.enabled ?? Boolean(profile));
        const degraded = profile?.degraded ?? !profile;
        const tone = degraded ? 'warn' : ok ? 'ok' : 'muted';
        const label = degraded ? '降级 / 未配置' : ok ? '正常' : '异常';
        chips.appendChild(el('div', { class: 'role-chip', title: profile?.last_error ?? '' },
          el('span', { class: 'role-name' }, item.role),
          badge(label, tone),
          profile?.model ? el('span', { class: 'mono muted-text' }, profile.model) : null));
      }
      healthHost.replaceChildren(chips);
    }

    function renderForms(): void {
      forms.clear();
      const grid = el('div', { class: 'grid grid-2 align-start' });
      for (const item of ROLES) {
        const profile = profiles.find((p) => p.role === item.role) ?? emptyProfile(item.role);
        const form = createForm(item.role);
        form.setProfile(profile);
        forms.set(String(item.role), form);

        const saveBtn = button('保存', { kind: 'primary' });
        const testBtn = button('测试连接', { iconName: 'play' });
        const resultLine = el('div', { class: 'test-result' });

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
                el('span', { class: 'muted-text' }, `延迟 ${fmtDuration(result.latency_ms ?? 0)}`));
            } else {
              resultLine.replaceChildren(badge('失败', 'danger'),
                el('span', { class: 'muted-text' }, result.error ?? result.detail ?? '未知错误'));
            }
          } catch (error) {
            resultLine.replaceChildren(badge('失败', 'danger'),
              el('span', { class: 'muted-text' }, errorMessage(error)));
          } finally {
            done();
          }
        });

        const box = card({
          title: item.label,
          subtitle: item.hint,
          actions: [saveBtn, testBtn],
        });
        box.appendChild(form.node);
        box.appendChild(resultLine);
        if (profile.last_error) {
          box.appendChild(el('div', { class: 'form-warning' }, `最近错误：${profile.last_error}`));
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
          const ok = call.ok ?? String(call.status ?? '').toLowerCase() === 'ok';
          tbody.appendChild(el('tr', { class: ok ? '' : 'is-error' },
            el('td', { class: 'mono' }, fmtDateTime(call.created_at)),
            el('td', null, call.role ?? '—'),
            el('td', { class: 'mono' }, call.model ?? '—'),
            el('td', null, ok ? badge('成功', 'ok') : badge(String(call.status ?? '失败'), 'danger')),
            el('td', { class: 'mono' }, fmtDuration(call.latency_ms ?? 0)),
            el('td', { class: 'mono' }, `${fmtNumber(call.tokens_in ?? 0)}/${fmtNumber(call.tokens_out ?? 0)}`),
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
        profiles = await api.models();
        if (disposed) return;
        healthChips();
        renderForms();
        void loadCalls();
      } catch (error) {
        if (disposed) return;
        profiles = [];
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
