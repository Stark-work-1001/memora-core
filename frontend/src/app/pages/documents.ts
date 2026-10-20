/**
 * 文档库：vault 目录树 + 原始 Markdown 预览 + 路径导入 / 拖拽上传 + 重建索引。
 */

import { el, debounce, icon } from '../dom';
import { api, errorMessage } from '../api';
import type { DocumentDetail, DocumentRow } from '../types';
import { renderMarkdownInto } from '../markdown';
import {
  badge, button, busy, card, emptyState, errorState, fmtBytes, fmtNumber, fmtRelative,
  jsonBlock, sectionTitle, skeleton, toast,
} from './ui';
import type { PageModule } from './contract';

interface TreeNode {
  name: string;
  path: string;
  children: Map<string, TreeNode>;
  doc?: DocumentRow;
}

function buildTree(docs: DocumentRow[]): TreeNode {
  const root: TreeNode = { name: '', path: '', children: new Map() };
  for (const doc of docs) {
    const rel = docPath(doc);
    const parts = rel.split(/[\\/]/).filter(Boolean);
    let cursor = root;
    parts.forEach((part, index) => {
      const nextPath = parts.slice(0, index + 1).join('/');
      let child = cursor.children.get(part);
      if (!child) {
        child = { name: part, path: nextPath, children: new Map() };
        cursor.children.set(part, child);
      }
      cursor = child;
    });
    cursor.doc = doc;
  }
  return root;
}

/** vault 内相对路径（后端字段 path；1.0.0 读的是不存在的 rel_path）。 */
function docPath(doc: DocumentRow): string {
  return String(doc.path || doc.title || doc.id);
}

export const documentsPage: PageModule = {
  id: 'documents',
  title: '文档库',
  icon: 'documents',
  group: 'main',
  shortcut: 'g d',
  render(ctx) {
    let docs: DocumentRow[] = [];
    let selectedId: string | null = ctx.params.get('id');
    let filter = '';
    let disposed = false;

    const page = el('div', { class: 'page page-documents' });
    const split = el('div', { class: 'split split-wide-right' });
    const left = el('div', { class: 'split-left' });
    const right = el('div', { class: 'split-right' });
    split.append(left, right);
    page.appendChild(split);
    ctx.mount.appendChild(page);

    /* -------- 导入区 -------- */

    const pathInput = el('input', {
      class: 'input',
      type: 'text',
      placeholder: '本机绝对路径，例如 D:\\notes\\inbox\\a.md',
      spellcheck: 'false',
    });
    const importBtn = button('导入', { kind: 'primary', iconName: 'upload' });
    importBtn.addEventListener('click', async () => {
      const path = pathInput.value.trim();
      if (!path) {
        toast('请先填写文件或目录路径', 'warn');
        return;
      }
      const done = busy(importBtn);
      try {
        const result = await api.importDocument({ path });
        toast(`导入完成：${JSON.stringify(result).slice(0, 120)}`, 'ok');
        pathInput.value = '';
        await reload();
      } catch (error) {
        toast(errorMessage(error), 'danger');
      } finally {
        done();
      }
    });

    const dropZone = el('div', { class: 'drop-zone' },
      icon('upload', 20),
      el('div', { class: 'drop-title' }, '拖拽 Markdown / 文本文件到这里上传'),
      el('div', { class: 'drop-hint' }, '上传会写入 vault/notes，随后自动切块索引'));
    const fileInput = el('input', { type: 'file', multiple: true, class: 'hidden-input' });
    dropZone.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      if (fileInput.files) void uploadFiles(Array.from(fileInput.files));
    });
    dropZone.addEventListener('dragover', (ev) => {
      ev.preventDefault();
      dropZone.classList.add('is-over');
    });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('is-over'));
    dropZone.addEventListener('drop', (ev) => {
      ev.preventDefault();
      dropZone.classList.remove('is-over');
      const files = ev.dataTransfer ? Array.from(ev.dataTransfer.files) : [];
      if (files.length) void uploadFiles(files);
      else toast('没有检测到文件', 'warn');
    });

    async function uploadFiles(files: File[]): Promise<void> {
      let ok = 0;
      let failed = 0;
      for (const file of files) {
        try {
          await api.uploadDocument(file);
          ok += 1;
        } catch (error) {
          failed += 1;
          toast(`${file.name}：${errorMessage(error)}`, 'danger');
        }
      }
      if (ok) {
        toast(`已上传 ${ok} 个文件${failed ? `，${failed} 个失败` : ''}`, failed ? 'warn' : 'ok');
        await reload();
      }
    }

    const importCard = card({
      title: '导入文档',
      subtitle: '支持 md / txt / html / json / jsonl / pdf（文本层）',
      body: [
        el('div', { class: 'import-row' }, pathInput, importBtn),
        dropZone,
        fileInput,
      ],
    });

    left.appendChild(importCard);

    /* -------- 搜索与工具条 -------- */

    const searchInput = el('input', {
      class: 'input input-search',
      type: 'search',
      placeholder: '过滤路径…',
    });
    const applyFilter = debounce(() => {
      filter = searchInput.value.trim().toLowerCase();
      renderTree();
    }, 180);
    searchInput.addEventListener('input', () => applyFilter());

    const listMeta = el('span', { class: 'list-meta' }, '—');
    const rebuildAllBtn = button('重建全部索引', { kind: 'subtle', iconName: 'refresh' });
    rebuildAllBtn.addEventListener('click', async () => {
      const done = busy(rebuildAllBtn);
      try {
        // 对每个文档逐个重建，避免后端缺批量接口时静默失败。
        let ok = 0;
        for (const doc of docs) {
          try {
            await api.reindexDocument(doc.id);
            ok += 1;
          } catch {
            /* 单个失败继续 */
          }
        }
        toast(`已重建 ${ok} / ${docs.length} 个文档索引`, ok === docs.length ? 'ok' : 'warn');
        await reload();
      } catch (error) {
        toast(errorMessage(error), 'danger');
      } finally {
        done();
      }
    });

    left.appendChild(el('div', { class: 'list-toolbar' },
      searchInput,
      el('div', { class: 'list-status' }, listMeta,
        button('刷新', { iconName: 'refresh', kind: 'subtle', onClick: () => void reload() }),
        rebuildAllBtn)));

    const treeHost = el('div', { class: 'tree-host' });
    left.appendChild(treeHost);

    /* -------- 树渲染 -------- */

    function renderTree(): void {
      const visible = filter
        ? docs.filter((doc) => `${docPath(doc)} ${doc.title ?? ''}`.toLowerCase().includes(filter))
        : docs;
      if (!visible.length) {
        treeHost.replaceChildren(emptyState(
          docs.length ? '没有匹配的文档' : '文档库为空',
          docs.length ? '换个关键词试试' : '用上面的路径导入或拖拽上传文件',
        ));
        listMeta.textContent = '0 个文档';
        return;
      }
      listMeta.textContent = `${fmtNumber(visible.length)} 个文档`;
      const tree = buildTree(visible);
      const host = el('div', { class: 'doc-tree' });
      renderNode(tree, host, 0);
      treeHost.replaceChildren(host);
    }

    function renderNode(node: TreeNode, host: HTMLElement, depth: number): void {
      const entries = Array.from(node.children.values()).sort((a, b) => {
        const aDir = a.children.size > 0;
        const bDir = b.children.size > 0;
        if (aDir !== bDir) return aDir ? -1 : 1;
        return a.name.localeCompare(b.name, 'zh-CN');
      });
      for (const entry of entries) {
        const isDir = entry.children.size > 0;
        if (isDir) {
          const group = el('details', { class: 'tree-dir', open: depth < 2 });
          group.appendChild(el('summary', { class: 'tree-dir-label' },
            icon('chevronRight', 12),
            el('span', null, entry.name)));
          const inner = el('div', { class: 'tree-children' });
          renderNode(entry, inner, depth + 1);
          group.appendChild(inner);
          host.appendChild(group);
        } else if (entry.doc) {
          const doc = entry.doc;
          const active = doc.id === selectedId;
          host.appendChild(el('button', {
            class: `tree-file ${active ? 'is-active' : ''}`.trim(),
            type: 'button',
            title: doc.title ? `${doc.title}\n${docPath(doc)}` : docPath(doc),
            onClick: () => void select(doc.id),
            dataset: { doc: doc.id },
          },
            icon('documents', 12),
            el('span', { class: 'tree-file-name' }, entry.name),
            el('span', { class: 'tree-file-meta' }, doc.kind ?? '')));
        }
      }
    }

    /* -------- 预览 -------- */

    async function select(id: string): Promise<void> {
      selectedId = id;
      for (const node of Array.from(treeHost.querySelectorAll<HTMLElement>('.tree-file'))) {
        node.classList.toggle('is-active', false);
      }
      renderTree();
      right.replaceChildren(el('div', { class: 'detail-skeleton' }, skeleton(2), skeleton(6)));
      try {
        // 详情接口只给元数据与切块预览；原文必须走 /raw（1.0.0 读 detail.raw，永远是空）
        const [detail, raw] = await Promise.all([
          api.document(id),
          api.documentRaw(id).then((text) => ({ text, error: '' }), (error: unknown) => ({ text: '', error: errorMessage(error) })),
        ]);
        if (disposed || selectedId !== id) return;
        renderPreview(detail, raw.text, raw.error);
      } catch (error) {
        if (disposed) return;
        right.replaceChildren(errorState({ error, onRetry: () => void select(id) }));
      }
    }

    function renderPreview(detail: DocumentDetail, raw: string, rawError: string): void {
      const chunks = Array.isArray(detail.chunks) ? detail.chunks : [];
      const head = el('div', { class: 'detail-head' },
        el('div', { class: 'detail-title-row' },
          el('h2', { class: 'detail-title' }, detail.title || docPath(detail))),
        el('div', { class: 'detail-badges' },
          badge(detail.kind ?? 'markdown', 'info'),
          badge(`${fmtBytes(detail.bytes)}`, 'muted'),
          badge(`${chunks.length} 块`, 'muted'),
          detail.origin ? badge(`来源 ${detail.origin}`, 'muted') : null,
          detail.scope_id ? badge(detail.scope_id, 'muted') : null,
          el('span', { class: 'mono muted-text' }, docPath(detail))),
        el('div', { class: 'detail-meta-row' },
          el('span', null, `更新 ${fmtRelative(detail.updated_at ?? detail.indexed_at)}`),
          el('span', null, `索引 ${fmtRelative(detail.indexed_at)}`)));

      const actions = el('div', { class: 'detail-actions' });
      const reindexBtn = button('重建索引', { kind: 'primary', iconName: 'refresh' });
      reindexBtn.addEventListener('click', async () => {
        const done = busy(reindexBtn);
        try {
          const result = await api.reindexDocument(detail.id);
          toast(`重建完成：${JSON.stringify(result).slice(0, 100)}`, 'ok');
          await reload();
          await select(detail.id);
        } catch (error) {
          toast(errorMessage(error), 'danger');
        } finally {
          done();
        }
      });
      actions.append(
        button('原始文件', {
          iconName: 'external',
          onClick: () => window.open(`/api/documents/${encodeURIComponent(detail.id)}/raw`, '_blank', 'noopener'),
        }),
        reindexBtn,
      );

      const rawCard = card({ title: '原始 Markdown', subtitle: docPath(detail) });
      const pre = el('pre', { class: 'raw-pre' }, raw || (rawError ? `无法读取原文：${rawError}` : '（空文件）'));
      rawCard.appendChild(pre);

      const renderCard = card({ title: '渲染预览', subtitle: '本地渲染，不请求外部资源' });
      const body = el('div', { class: 'markdown-body' });
      renderMarkdownInto(body, raw, { math: true, codeMaxLines: 40 });
      renderCard.appendChild(body);

      const chunksCard = chunks.length ? card({
        title: '切块',
        subtitle: `${chunks.length} 块（每块预览前 400 字）`,
      }) : null;
      if (chunksCard) {
        for (const chunk of chunks) {
          chunksCard.appendChild(el('div', { class: 'chunk-row' },
            el('span', { class: 'mono muted-text' }, `#${chunk.ordinal ?? '—'}`),
            el('span', { class: 'chunk-text' },
              chunk.heading ? el('strong', null, `${chunk.heading} · `) : null,
              (chunk.preview ?? '').slice(0, 400)),
            el('span', { class: 'muted-text' }, chunk.tokens ? `${chunk.tokens} tok` : '')));
        }
      }

      right.replaceChildren(
        el('div', { class: 'detail-inner' },
          head, actions, rawCard, renderCard,
          chunksCard ?? el('div'),
          card({ title: '元数据', body: [jsonBlock(detail, '查看完整 JSON')] })),
      );
    }

    /* -------- 加载 -------- */

    async function reload(): Promise<void> {
      try {
        const result = await api.documents({ limit: 500 });
        if (disposed) return;
        docs = result.items;
        renderTree();
        if (!docs.length) {
          right.replaceChildren(emptyState('文档库为空', '导入 Markdown 后即可在这里浏览与检索'));
          return;
        }
        if (!selectedId || !docs.some((d) => d.id === selectedId)) {
          void select(docs[0].id);
        } else {
          void select(selectedId);
        }
      } catch (error) {
        if (disposed) return;
        treeHost.replaceChildren();
        listMeta.textContent = '加载失败';
        right.replaceChildren(errorState({ error, title: '文档库加载失败', onRetry: () => void reload() }));
      }
    }

    right.replaceChildren(el('div', { class: 'detail-skeleton' }, skeleton(3), skeleton(6)));
    void reload();

    const unsub = ctx.onEvent(['run', 'memory'], () => {
      void reload();
    });

    ctx.mount.addEventListener('mem:dispose', () => {
      disposed = true;
      applyFilter.cancel();
      unsub();
    }, { once: true });
  },
};

export { sectionTitle };
