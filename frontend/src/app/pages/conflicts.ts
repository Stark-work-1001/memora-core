/**
 * 冲突：待裁决的记忆矛盾列表 + 解决动作。
 * 路由上作为一级页面存在（侧边栏与 §7 页面清单对齐）。
 *
 * 后端 conflict 行只有 a_id / b_id，两侧标题要另取（/api/memories/{id}）；
 * 1.0.0 读的是不存在的 title_a / memory_a，于是每张卡都显示「（缺少 A）」。
 */

import { el } from '../dom';
import { api, ApiError, errorMessage } from '../api';
import type { Conflict } from '../types';
import {
  badge, button, busy, emptyState, errorState, fmtNumber, fmtRelative,
  select, skeleton, toast, truncate,
} from './ui';
import type { PageContext, PageModule } from './contract';

// 诚实标注：POST /api/conflicts/{id}/resolve 只记录裁决结论并关闭冲突，
// 不会改动两条记忆的状态（1.0.0 的文案写着「B 标记 superseded」，后端并不这样做）。
const RESOLUTIONS = [
  { value: 'keep_a', label: '裁决：保留 A' },
  { value: 'keep_b', label: '裁决：保留 B' },
  { value: 'merge', label: '裁决：应合并' },
  { value: 'ignore', label: '忽略（不是冲突）' },
];

interface SideInfo {
  title: string;
  missing: boolean;
}

/** 取两侧记忆标题；同一 id 只请求一次，并发不超过 6。 */
async function loadTitles(ids: string[]): Promise<Map<string, SideInfo>> {
  const out = new Map<string, SideInfo>();
  const queue = Array.from(new Set(ids.filter(Boolean)));
  const worker = async (): Promise<void> => {
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      try {
        const memory = await api.memory(id);
        out.set(id, { title: memory.title || id, missing: false });
      } catch (error) {
        const gone = error instanceof ApiError && error.status === 404;
        out.set(id, { title: gone ? '（记忆已不存在）' : `（标题读取失败：${errorMessage(error)}）`, missing: true });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, queue.length) }, () => worker()));
  return out;
}

function sideRow(
  label: 'A' | 'B',
  id: string | null | undefined,
  given: string | undefined,
  titles: Map<string, SideInfo>,
  navigate: PageContext['navigate'],
): HTMLElement {
  const info = id ? titles.get(id) : undefined;
  const title = given || info?.title || (id ? id : '（未记录）');
  return el('div', { class: 'conflict-side', dataset: { side: label, id: id ?? '' } },
    badge(label, label === 'A' ? 'info' : 'accent'),
    el('span', { class: `conflict-title ${info?.missing ? 'muted-text' : ''}`.trim() }, title),
    id ? el('span', { class: 'mono muted-text' }, id) : null,
    id && !info?.missing ? el('button', {
      class: 'link-btn',
      type: 'button',
      onClick: () => navigate('memories', { id }),
    }, '打开') : null);
}

function conflictCard(
  item: Conflict,
  titles: Map<string, SideInfo>,
  navigate: PageContext['navigate'],
  reload: () => Promise<void>,
): HTMLElement {
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

  const score = typeof item.score === 'number' ? item.score : undefined;
  const summary = item.detail && typeof item.detail.summary === 'string' ? item.detail.summary : '';
  const node = el('article', { class: 'conflict-card', dataset: { conflict: item.id } });
  node.append(
    el('div', { class: 'conflict-head' },
      el('div', { class: 'conflict-titles' },
        sideRow('A', item.a_id, item.a_title, titles, navigate),
        sideRow('B', item.b_id, item.b_title, titles, navigate)),
      el('div', { class: 'conflict-badges' },
        badge(KIND_TEXT[String(item.kind ?? '')] ?? String(item.kind ?? 'conflict'), 'warn'),
        score !== undefined ? badge(`冲突分 ${score.toFixed(2)}`, 'muted', '判定层给出的冲突强度（0–1）') : null,
        el('span', { class: 'muted-text' }, fmtRelative(item.created_at)))),
    el('div', { class: 'conflict-body' },
      summary ? el('p', { class: 'conflict-summary' }, truncate(summary, 320)) : null),
    el('div', { class: 'conflict-actions' }, resolution, applyBtn,
      el('span', { class: 'muted-text tiny' }, '只记录裁决并关闭冲突；两条记忆本身不会被自动修改')),
  );
  return node;
}

const KIND_TEXT: Record<string, string> = {
  duplicate: '重复',
  contradiction: '矛盾',
  stale: '过期',
  scope_clash: '作用域冲突',
  source_clash: '来源冲突',
  orphan: '孤立',
};

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

    let titles = new Map<string, SideInfo>();

    async function load(): Promise<void> {
      host.replaceChildren(skeleton(3), skeleton(3));
      try {
        const list = await api.conflicts('open');
        if (disposed) return;
        items = list.filter((item) => String(item.status ?? 'open') === 'open');
        titles = await loadTitles(items.flatMap((item) => [item.a_id ?? '', item.b_id ?? '']));
        if (disposed) return;
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
      for (const item of items) frag.appendChild(conflictCard(item, titles, ctx.navigate, load));
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
