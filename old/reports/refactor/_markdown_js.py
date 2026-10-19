"""Add the 分类与沉淀 two-tab capture logic: typed text + Markdown file drop."""
import pathlib

DEV = pathlib.Path(__file__).resolve().parents[2]
p = DEV / 'memora/static/memory.js'
text = p.read_text('utf-8')

BLOCK = r'''
/* ------------------------------------------------------------------ 添加记忆：两种入口

   分类与沉淀 offers two ways in and one pipeline out:

     直接输入记忆内容   one memory per submission, the existing path
     新增 Markdown 文档  a file (dropped or pasted) parsed into many candidates at once

   Both end as PENDING memories in the same review queue. The document route deliberately does not
   use the Markdown *document* store: /document writes a versioned document, /document-index turns a
   published revision into memory rows, and neither is what a user means by "add this note as
   memories". POST /capture-markdown reuses the same ingest parser the importer uses, then calls
   runtime.capture per chunk, so heading context and front-matter titles behave identically to a
   CLI import while every chunk still goes through normal review.

   The drop zone is a <label> wrapping the file input, so clicking it opens the picker without JS.
   dragover/drop are prevented on the whole pane so a miss near the edge does not navigate the
   window to the file.
*/
const MAX_MARKDOWN_BYTES = 2 * 1024 * 1024;

function captureTab(name) {
  const typed = name === 'type';
  $('tab-type').classList.toggle('is-active', typed);
  $('tab-doc').classList.toggle('is-active', !typed);
  $('tab-type').setAttribute('aria-selected', typed ? 'true' : 'false');
  $('tab-doc').setAttribute('aria-selected', typed ? 'false' : 'true');
  $('pane-type').hidden = !typed;
  $('pane-doc').hidden = typed;
}
$('tab-type').onclick = () => captureTab('type');
$('tab-doc').onclick = () => captureTab('doc');

function markdownStatus(text) {
  const host = $('markdown-status');
  if (host) host.textContent = text;
}

/** Read a dropped/selected file into the textarea, and title the drop zone with its name. */
function acceptMarkdownFile(file) {
  if (!file) return;
  if (file.size > MAX_MARKDOWN_BYTES) {
    markdownStatus('文件过大：上限 2 MB');
    notice('Markdown 文件超过 2 MB，请拆分后再试。');
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    $('markdown-content').value = String(reader.result || '');
    $('drop-zone-title').textContent = file.name;
    $('drop-zone-hint').textContent = file.size + ' 字节 · 已载入正文，可以检查后提交';
    markdownStatus('已载入 ' + file.name);
  };
  reader.onerror = () => markdownStatus('读取失败：' + (reader.error && reader.error.message));
  reader.readAsText(file, 'utf-8');
}

const dropZone = $('markdown-drop');
if (dropZone) {
  dropZone.addEventListener('dragover', event => {
    event.preventDefault();
    dropZone.classList.add('is-over');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('is-over'));
  dropZone.addEventListener('drop', event => {
    event.preventDefault();
    dropZone.classList.remove('is-over');
    const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
    acceptMarkdownFile(file);
  });
}
$('markdown-file').onchange = event => acceptMarkdownFile(event.target.files && event.target.files[0]);

/* Dropping onto the whole view is what a user actually does when aiming at "添加记忆"; the zone is
   the visual target, the view is the forgiving one. Only intercepted for files, so dragging text
   inside a textarea still works. */
const inboxView = $('inbox');
if (inboxView) {
  inboxView.addEventListener('dragover', event => {
    if (event.dataTransfer && Array.from(event.dataTransfer.types || []).includes('Files')) {
      event.preventDefault();
    }
  });
  inboxView.addEventListener('drop', event => {
    if (!(event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files.length)) return;
    event.preventDefault();
    captureTab('doc');
    acceptMarkdownFile(event.dataTransfer.files[0]);
  });
}

$('markdown-submit').onclick = () => run(async () => {
  const content = $('markdown-content').value;
  if (!content.trim()) throw new Error('请先拖入或粘贴 Markdown 正文');
  markdownStatus('解析中…');
  const out = await api('capture-markdown', {
    content,
    filename: $('drop-zone-title').textContent || 'pasted.md',
    source: $('markdown-source').value.trim() || 'workbench-markdown'
  });
  const created = out.created || [];
  markdownStatus('解析 ' + out.parsed + ' 段，已加入 ' + created.length + ' 条待审'
    + (out.failed && out.failed.length ? '，' + out.failed.length + ' 段被拒绝' : ''));
  notice('已把《' + (out.title || out.filename) + '》解析成 ' + created.length
    + ' 条候选记忆，进入待审队列；确认后才会参与检索。');
  $('markdown-content').value = '';
  await queue();
}, $('markdown-submit'));

'''

anchor = '/* ------------------------------------------------------------------ 智能体接入 */'
if anchor not in text:
    raise SystemExit('agents section anchor not found')
text = text.replace(anchor, BLOCK + anchor, 1)
p.write_text(text, 'utf-8')
print('markdown capture block inserted (%d chars)' % len(BLOCK))
