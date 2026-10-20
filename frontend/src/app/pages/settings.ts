/**
 * 设置：运行参数（只读，来自 /api/settings 的 runtime）、已保存的设置项、导出 / 导入（jsonl）。
 *
 * 1.0.0 在这里放了「数据目录 / 端口 / 自动备份 / 吸收策略 / 离线降级开关」的可编辑表单，
 * 但 GET /api/settings 返回的是 {values, runtime}（表单读不到任何值），后端也没有任何代码读取这些键，
 * 数据目录与端口由启动参数决定——点「保存」提示成功，实际什么都没发生。
 * 按降级契约（不为没发生的事返回成功），改为如实展示。
 */

import { el } from '../dom';
import { api, errorMessage } from '../api';
import type { Settings } from '../types';
import {
  badge, button, busy, card, errorState, skeleton, toast,
} from './ui';
import type { PageModule } from './contract';

function kv(label: string, value: string, key: string): HTMLElement {
  return el('div', { class: 'kv-row', dataset: { setting: key } },
    el('span', { class: 'kv-key muted-text' }, label),
    el('span', { class: 'kv-value mono' }, value || '—'));
}

export const settingsPage: PageModule = {
  id: 'settings',
  title: '设置',
  icon: 'settings',
  group: 'system',
  // 与 main.ts 的 SHORTCUTS 一致（g s 是检索页）
  shortcut: 'g ,',
  render(ctx) {
    let disposed = false;
    let settings: Settings = {};

    const page = el('div', { class: 'page page-settings' });
    ctx.mount.appendChild(page);

    const body = el('div', { class: 'settings-body' });
    page.append(
      el('div', { class: 'page-head' },
        el('div', { class: 'page-head-left' },
          el('h1', { class: 'page-title' }, '设置'),
          el('div', { class: 'page-head-meta' },
            el('span', { class: 'muted-text' }, '运行参数只读；导出 / 导入走 memora-exchange/1'))),
        el('div', { class: 'page-head-actions' },
          button('重新加载', { iconName: 'refresh', kind: 'subtle', onClick: () => void load() }))),
      body,
    );

    function renderForm(): void {
      const runtime = settings.runtime ?? {};
      const values = settings.values ?? {};

      const runtimeCard = card({
        title: '运行参数',
        subtitle: '本进程实际使用的值（只读）；SQLite 真源 + Markdown 镜像，仅监听回环地址',
        body: [
          kv('版本', String(runtime.version ?? ''), 'version'),
          kv('数据目录', String(runtime.data_dir ?? ''), 'data_dir'),
          kv('监听地址', runtime.host ? `${runtime.host}:${runtime.port ?? ''}` : '', 'listen'),
          el('div', { class: 'restart-note' },
            badge('启动参数', 'info'),
            el('span', null, '数据目录与端口由启动参数决定：python -m memora_core --data <目录> serve --port <端口>，改动需重启后端。')),
        ],
      });

      const policyCard = card({
        title: '降级策略',
        subtitle: '固定契约，不提供开关',
        body: [
          el('p', { class: 'muted-text' },
            '云端模型未配置或不可用时，检索 / 判定 / 向量等能力回落到本地确定性算法（BM25、字符哈希向量、规则判定），'
            + '并在界面与 API 的 degraded 字段如实标注；不会伪造模型输出。模型档位在「模型」页配置。'),
        ],
      });

      const keys = Object.keys(values).sort();
      const storedCard = card({
        title: '已保存的设置项',
        subtitle: keys.length ? `${keys.length} 项（setting 表原样）` : 'setting 表为空',
        body: keys.length
          ? keys.map((key) => kv(key, JSON.stringify(values[key]), key))
          : [el('p', { class: 'muted-text' }, '当前版本的后端不从 setting 表读取任何开关，这里只做如实展示。')],
      });

      const exportBtn = button('导出 jsonl', { kind: 'primary', iconName: 'upload' });
      exportBtn.addEventListener('click', () => {
        const url = api.exchangeExportUrl(undefined, 'approved');
        window.open(url, '_blank', 'noopener');
        toast('已开始下载导出文件', 'info');
      });

      const importArea = el('textarea', {
        class: 'textarea code-editor',
        rows: '8',
        spellcheck: 'false',
        placeholder: '粘贴 memora-exchange/1 的 jsonl 内容，或直接把文件拖进这里',
      });
      const importBtn = button('导入 jsonl', { kind: 'primary', iconName: 'upload' });
      importBtn.addEventListener('click', async () => {
        const text = importArea.value.trim();
        if (!text) {
          toast('请先粘贴要导入的 jsonl 内容', 'warn');
          return;
        }
        const done = busy(importBtn);
        try {
          const result = await api.exchangeImport(text);
          toast(`导入完成：${JSON.stringify(result).slice(0, 120)}`, 'ok');
          importArea.value = '';
        } catch (error) {
          toast(errorMessage(error), 'danger');
        } finally {
          done();
        }
      });
      importArea.addEventListener('dragover', (ev) => {
        ev.preventDefault();
        importArea.classList.add('is-over');
      });
      importArea.addEventListener('dragleave', () => importArea.classList.remove('is-over'));
      importArea.addEventListener('drop', async (ev) => {
        ev.preventDefault();
        importArea.classList.remove('is-over');
        const file = ev.dataTransfer?.files?.[0];
        if (!file) return;
        try {
          importArea.value = await file.text();
          toast(`已读取 ${file.name}`, 'ok');
        } catch (error) {
          toast(errorMessage(error), 'danger');
        }
      });

      const exchangeCard = card({
        title: '导出 / 导入',
        subtitle: '交换格式：memora-exchange/1（jsonl，一行一条）',
        actions: [exportBtn],
        body: [importArea, el('div', { class: 'form-row' }, importBtn)],
      });

      body.replaceChildren(
        el('div', { class: 'grid grid-2 align-start' }, runtimeCard, el('div', { class: 'stack' }, policyCard, storedCard)),
        exchangeCard,
      );
    }

    async function load(): Promise<void> {
      body.replaceChildren(skeleton(4), skeleton(4));
      try {
        const raw = await api.settings();
        if (disposed) return;
        settings = raw ?? {};
        renderForm();
        ctx.setStatus('设置已加载');
      } catch (error) {
        if (disposed) return;
        // 后端未提供 /api/settings 时也要可编辑：展示错误 + 允许本地查看
        body.replaceChildren(
          errorState({ error, title: '设置加载失败', onRetry: () => void load() }),
          card({
            title: '离线提示',
            body: [el('p', { class: 'muted-text' },
              '无法读取后端设置。若是后端未启动，请先运行 python -m memora_core serve；'
              + '若是后端版本较旧，/api/settings 可能尚未实现。')],
          }),
        );
      }
    }

    void load();

    ctx.mount.addEventListener('mem:dispose', () => {
      disposed = true;
    }, { once: true });
  },
};
