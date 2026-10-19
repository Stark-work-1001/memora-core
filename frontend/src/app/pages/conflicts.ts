/**
 * 冲突：待裁决的记忆矛盾列表 + 解决动作。
 * 路由上作为一级页面存在（侧边栏与 §7 页面清单对齐）。
 */

import { el } from '../dom';
import { api, errorMessage } from '../api';
import type { Conflict } from '../types';
import {
  badge, button, busy, emptyState, errorState, fmtNumber, fmtPercent, fmtRelative,
  select, skeleton, toast, truncate,
} from './ui';
import type { PageModule } from './contract';

const RESOLUTIONS = [
  { value: 'keep_a', label: '保留 A（B 标记 superseded）' },
  { value: 'keep_b', label: '保留 B（A 标记 superseded）' },
  { value: 'merge', label: '合并为一条新记忆' },
  { value: 'ignore', label: '忽略（标记已处理）' },
];

function conflictCard(item: Conflict, reload: () => Promise<void>): HTMLElement {
  const resolution = select({ items: RESOLUTIONS, value: 'keep_a' });
  const applyBtn = button('应用裁决', { kind: 'primary' });

  applyBtn.addEventListener('click', async () => {
    const done = busy(applyBtn);
    try {
      await api.resolveConflict(item.id, resolution.value);
      toast('已提交裁决', 'ok');
      await reload();
    } catch (error) {
      toast(errorMessage(error), 'danger');
    } finally {
      done();
    }
  });

  const similarity = item.similarity !== undefined ? Number(item.similarity) : undefined;
  const node = el('article', { class: 'conflict-card' });
  node.append(
    el('div', { class: 'conflict-head' },
      el('div', { class: 'conflict-titles' },
        el('div', { class: 'conflict-side' },
          badge('A', 'info'),
          el('span', { class: 'conflict-title' }, item.title_a ?? item.memory_a ?? '（缺少 A）')),
        el('div', { class: 'conflict-side' },
          badge('B', 'accent'),
          el('span', { class: 'conflict-title' }, item.title_b ?? item.memory_b ?? '（缺少 B）'))),
      el('div', { class: 'conflict-badges' },
        badge(String(item.kind ?? 'conflict'), 'warn'),
        similarity !== undefined ? badge(`相似 ${fmtPercent(similarity, 1)}`, 'muted') : null,
        el('span', { class: 'muted-text' }, fmtRelative(item.created_at)))),
    el('div', { class: 'conflict-body' },
      item.summary ? el('p', { class: 'conflict-summary' }, truncate(item.summary, 320)) : null),
    el('div', { class: 'conflict-actions' }, resolution, applyBtn),
  );
  return node;
}

export const conflictsPage: PageModule = {
  id: 'conflicts',
  title: '冲突',
  icon: 'conflicts',
  group: 'main',
  shortcut: 'g c',
  render(ctx) {
    let disposed = false;
    let items: Conflict[] = [];

    const page = el('div', { class: 'page page-conflicts' });
    ctx.mount.appendChild(page);

    const host = el('div', { class: 'conflict-list' });
    page.append(
      el('div', { class: 'page-head' },
        el('div', { class: 'page-head-left' },
          el('h1', { class: 'page-title' }, '记忆冲突'),
          el('div', { class: 'page-head-meta' },
            el('span', { class: 'muted-text' }, '判定层发现的矛盾记忆，需要人工裁决'))),
        el('div', { class: 'page-head-actions' },
          button('刷新', { iconName: 'refresh', onClick: () => void load() }))),
      host,
    );

    async function load(): Promise<void> {
      host.replaceChildren(skeleton(3), skeleton(3));
      try {
        const list = await api.conflicts();
        if (disposed) return;
        items = list.filter((item) => String(item.status ?? 'open') !== 'resolved');
        render();
      } catch (error) {
        if (disposed) return;
        host.replaceChildren(errorState({ error, title: '冲突列表加载失败', onRetry: () => void load() }));
      }
    }

    function render(): void {
      if (!items.length) {
        host.replaceChildren(emptyState(
          '没有待处理的冲突',
          '判定层在写入时会自动比对相似记忆并登记矛盾；这里为空说明当前一致。',
        ));
        return;
      }
      const summary = el('div', { class: 'list-status' },
        badge(`${fmtNumber(items.length)} 个待裁决`, 'warn'));
      const frag = document.createDocumentFragment();
      frag.appendChild(summary);
      for (const item of items) frag.appendChild(conflictCard(item, load));
      host.replaceChildren(frag);
    }

    void load();

    const unsub = ctx.onEvent(['memory'], () => {
      void load();
    });

    ctx.mount.addEventListener('mem:dispose', () => {
      disposed = true;
      unsub();
    }, { once: true });
  },
};
