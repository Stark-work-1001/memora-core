/**
 * 设置：数据目录、端口、自动备份、吸收策略、离线降级开关、
 * 导出 / 导入（jsonl）、重启后端提示。
 */

import { el } from '../dom';
import { api, errorMessage } from '../api';
import type { Settings } from '../types';
import {
  badge, button, busy, card, checkbox, errorState,
  numberInput, sectionTitle, select, skeleton, textInput, toast,
} from './ui';
import type { PageModule } from './contract';

const ABSORB_STRATEGIES = [
  { value: 'candidate', label: '候选：全部先进候选队列，人工审核' },
  { value: 'auto-approved', label: '自动批准：来源可信时直接 approved' },
  { value: 'readonly', label: '只读：只建索引，不产生记忆' },
];

interface FormState {
  data_dir: string;
  port: number;
  auto_backup: boolean;
  backup_interval_h: number;
  absorb_strategy: string;
  offline_fallback: boolean;
}

function readSettings(raw: Settings): FormState {
  return {
    data_dir: String(raw.data_dir ?? raw.vault_dir ?? ''),
    port: Number(raw.port ?? 8790),
    auto_backup: Boolean(raw.auto_backup ?? true),
    backup_interval_h: Number(raw.backup_interval_h ?? 24),
    absorb_strategy: String(raw.absorb_strategy ?? 'candidate'),
    offline_fallback: Boolean(raw.offline_fallback ?? raw.offline_mode ?? true),
  };
}

export const settingsPage: PageModule = {
  id: 'settings',
  title: '设置',
  icon: 'settings',
  group: 'system',
  shortcut: 'g s',
  render(ctx) {
    let disposed = false;
    let form: FormState = {
      data_dir: '',
      port: 8790,
      auto_backup: true,
      backup_interval_h: 24,
      absorb_strategy: 'candidate',
      offline_fallback: true,
    };
    let lastSavedAt = '';

    const page = el('div', { class: 'page page-settings' });
    ctx.mount.appendChild(page);

    const body = el('div', { class: 'settings-body' });
    page.append(
      el('div', { class: 'page-head' },
        el('div', { class: 'page-head-left' },
          el('h1', { class: 'page-title' }, '设置'),
          el('div', { class: 'page-head-meta' },
            el('span', { class: 'muted-text' }, '修改后部分项需要重启后端才生效'))),
        el('div', { class: 'page-head-actions' },
          button('重新加载', { iconName: 'refresh', kind: 'subtle', onClick: () => void load() }))),
      body,
    );

    function renderForm(): void {
      const dirInput = textInput({ value: form.data_dir, placeholder: 'D:\\memora-data' });
      const portInput = numberInput({ value: form.port, min: 1024, max: 65535 });
      const backupToggle = checkbox('启用自动备份', {
        checked: form.auto_backup,
        onChange: (v) => { form.auto_backup = v; },
      });
      const intervalInput = numberInput({ value: form.backup_interval_h, min: 1, max: 720 });
      const absorbSelect = select({
        items: ABSORB_STRATEGIES,
        value: form.absorb_strategy,
        onChange: (v) => { form.absorb_strategy = v; },
      });
      const offlineToggle = checkbox('云端不可用时使用本地确定性降级', {
        checked: form.offline_fallback,
        onChange: (v) => { form.offline_fallback = v; },
      });

      const saveBtn = button('保存设置', { kind: 'primary' });
      saveBtn.addEventListener('click', async () => {
        const done = busy(saveBtn);
        try {
          form.data_dir = dirInput.value.trim();
          form.port = Number(portInput.value) || 8790;
          form.backup_interval_h = Number(intervalInput.value) || 24;
          const saved = await api.saveSettings({ ...form });
          lastSavedAt = new Date().toLocaleTimeString('zh-CN');
          toast(saved ? '设置已保存' : '设置已提交', 'ok');
          if (saved && typeof saved === 'object') form = readSettings(saved);
        } catch (error) {
          toast(errorMessage(error), 'danger');
        } finally {
          done();
        }
      });

      const storageCard = card({
        title: '存储与网络',
        subtitle: 'SQLite 真源 + Markdown 镜像；仅监听回环地址',
        actions: [saveBtn],
        body: [
          el('div', { class: 'form-grid' },
            el('label', { class: 'field field-wide' },
              el('span', { class: 'field-label' }, '数据目录'),
              dirInput,
              el('span', { class: 'field-hint' }, '存放 memora.db / vault / backups / logs；修改需重启后端')),
            el('label', { class: 'field' },
              el('span', { class: 'field-label' }, '端口'),
              portInput,
              el('span', { class: 'field-hint' }, '默认 8790，仅本机可访问'))),
          el('div', { class: 'restart-note' },
            badge('需重启', 'warn'),
            el('span', null, '数据目录与端口修改后需要重启后端进程：python -m memora_core serve')),
        ],
      });

      const backupCard = card({
        title: '备份与吸收',
        subtitle: '自动备份会写入 backups/，保留最近 N 份',
        body: [
          el('div', { class: 'form-row' }, backupToggle),
          el('label', { class: 'field' },
            el('span', { class: 'field-label' }, '备份间隔（小时）'),
            intervalInput),
          sectionTitle('吸收策略', '文档导入后如何产生记忆'),
          absorbSelect,
          el('div', { class: 'field-hint' }, '候选模式下所有导入先进候选队列，必须人工或第二条证据后才能批准。'),
        ],
      });

      const offlineCard = card({
        title: '降级与离线',
        subtitle: '无云凭据时必须确定性地工作，并在界面如实标注',
        body: [
          el('div', { class: 'form-row' }, offlineToggle),
          el('p', { class: 'muted-text' },
            '关闭后，模型不可用时相关节点会直接失败（run 标记 failed），不再走确定性兜底实现。'),
        ],
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

      const savedNote = lastSavedAt
        ? el('div', { class: 'muted-text' }, `最近保存：${lastSavedAt}`)
        : null;

      body.replaceChildren(
        el('div', { class: 'grid grid-2 align-start' }, storageCard, el('div', { class: 'stack' }, backupCard, offlineCard)),
        exchangeCard,
        savedNote ?? el('div'),
      );
    }

    async function load(): Promise<void> {
      body.replaceChildren(skeleton(4), skeleton(4));
      try {
        const raw = await api.settings();
        if (disposed) return;
        form = readSettings(raw ?? {});
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
