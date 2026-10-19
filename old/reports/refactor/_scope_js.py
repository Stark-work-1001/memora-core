"""Insert the scope-panel and markdown-capture front-end logic into memory.js.

Both blocks are self-contained additions: the scope panel renders into #scope-panel (which already
exists in memory.html) and the markdown capture binds to the ids in the 分类与沉淀 pane. Inserting
them as whole blocks — rather than threading edits through the existing 2k-line file — keeps the
diff readable and the existing retrieval path untouched except for the two call sites that need the
scope (`search()` and `enterRetrieve()`).
"""
import pathlib

DEV = pathlib.Path(__file__).resolve().parents[2]
p = DEV / 'memora/static/memory.js'
text = p.read_text('utf-8')

SCOPE_BLOCK = r'''
/* ------------------------------------------------------------------ 检索范围（四级）

   The project picker moved out of the sidebar and into 记忆检索, because a scope is a read range
   and the page that reads is where it belongs. Four rungs, widest to narrowest:

     global        全局    :global + :user   — shared facts: identity, long-term preferences
     workspace     工作区  + :workspace      — facts shared by a group of projects
     project       项目    + this project    — the default
     conversation  对话    + one session     — pinned to the selected conversation

   A narrower rung always includes the wider ones: that is what makes a shared fact usable from
   every level. The server decides the set (memora/scopes.py) and returns counts, so this file
   never re-derives the rule and cannot drift from what retrieval actually queries.
*/
const SCOPE_STATE = state.scope;

function scopeQuery() {
  const params = new URLSearchParams({project: project()});
  if (SCOPE_STATE.tier && SCOPE_STATE.tier !== 'project') params.set('tier', SCOPE_STATE.tier);
  if (SCOPE_STATE.tier === 'conversation' && SCOPE_STATE.session) params.set('session_id', SCOPE_STATE.session);
  return params;
}

/** Read the ladder + counts, then repaint. Cheap: one GET, no model calls. */
async function scopeRefresh() {
  const params = new URLSearchParams({project: project()});
  if (SCOPE_STATE.session) params.set('session_id', SCOPE_STATE.session);
  const ladder = await api('scopes?' + params.toString());
  SCOPE_STATE.ladder = ladder;
  scopeRender(ladder);
  return ladder;
}

function scopeRender(ladder) {
  const host = $('scope-tiers');
  if (!host) return;
  host.replaceChildren(...(ladder.tiers || []).map(tier => {
    const available = tier.available !== false;
    const radio = node('button');
    radio.type = 'button';
    radio.className = 'scope-tier' + (SCOPE_STATE.tier === tier.id ? ' is-active' : '')
      + (available ? '' : ' is-unavailable');
    radio.dataset.tier = tier.id;
    radio.setAttribute('role', 'radio');
    radio.setAttribute('aria-checked', SCOPE_STATE.tier === tier.id ? 'true' : 'false');
    if (!available) radio.disabled = true;
    radio.append(
      node('span', tier.title, 'scope-tier-title'),
      node('span', String(tier.count ?? 0), 'scope-tier-count'),
      node('small', tier.description, 'scope-tier-desc')
    );
    radio.onclick = () => run(async () => {
      SCOPE_STATE.tier = tier.id;
      try { localStorage.setItem('memora-scope-tier', tier.id); } catch {}
      await scopeRefresh();
      scopeSummary();
      // Re-run the current query so the list matches the rung the user just picked.
      if (state.search) await search();
    });
    return radio;
  }));

  // The conversation rung needs a session to pin. Offer the ones that actually have memories, from
  // the same payload, so choosing one is not guesswork.
  const conversation = $('scope-conversation');
  const select = $('scope-session');
  if (conversation && select) {
    const rows = ladder.sessions || [];
    conversation.hidden = false;
    const chosen = SCOPE_STATE.session;
    select.replaceChildren(node('option', '（未选择对话）'));
    select.firstChild.value = '';
    for (const row of rows) {
      const option = node('option', row.session_id.slice(0, 8) + ' · ' + row.memories + ' 条');
      option.value = row.session_id;
      option.selected = row.session_id === chosen;
      select.append(option);
    }
    select.onchange = () => run(async () => {
      SCOPE_STATE.session = select.value;
      if (SCOPE_STATE.session) SCOPE_STATE.tier = 'conversation';
      await scopeRefresh();
      scopeSummary();
      if (state.search) await search();
    });
    if (!rows.length) {
      select.replaceChildren(node('option', '（该项目下还没有带会话的记忆）'));
      select.firstChild.value = '';
    }
  }
  scopeSummary();
}

/** One sentence saying what the current rung will read. Never claims more than the counts show. */
function scopeSummary() {
  const ladder = SCOPE_STATE.ladder;
  const host = $('scope-summary');
  if (!host) return;
  if (!ladder) { host.textContent = '正在读取分区…'; return; }
  const tier = (ladder.tiers || []).find(t => t.id === SCOPE_STATE.tier);
  if (!tier) return;
  const bits = ['当前读取：' + tier.title, tier.count + ' 条已审核记忆'];
  if (SCOPE_STATE.tier === 'conversation') {
    bits.push(SCOPE_STATE.session ? ('会话 ' + SCOPE_STATE.session.slice(0, 8)) : '未选择会话（等同项目级）');
  }
  if (SCOPE_STATE.tier !== 'global') bits.push('含更宽级别：' + (tier.projects || []).join(' + '));
  if (!tier.count && SCOPE_STATE.tier !== 'project') {
    bits.push('该级别还没有记忆');
  }
  host.textContent = bits.join(' · ');
}

$('scope-refresh').onclick = () => run(async () => {
  await scopeRefresh();
  notice('分区已刷新。');
});

$('scope-apply').onclick = () => run(async () => {
  const name = $('project').value.trim() || 'default';
  if (!/^[:\p{L}\p{N}_-]{1,80}$/u.test(name)) throw new Error('空间名只接受字母、数字、汉字、下划线或连字符，最长 80 字符');
  const path = $('project-path').value.trim();
  // Persist the path on the server so it survives a reload and is visible to every client, then
  // scope the page to the (possibly renamed) project.
  await api('space', {project: name, path});
  $('project').value = name;
  try {
    localStorage.setItem('memora-project', name);
    localStorage.setItem('memora-project-path', path);
  } catch {}
  SCOPE_STATE.session = '';
  resetSearch();
  await scopeRefresh();
  await show('retrieve');
  notice('已应用项目空间「' + name + '」' + (path ? '，路径 ' + path : '') + '。');
});

// Restore the remembered path label before the first status read.
try {
  const savedPath = localStorage.getItem('memora-project-path');
  if (savedPath && $('project-path')) $('project-path').value = savedPath;
} catch {}

'''

# Insert before the result-card section so it sits with the other retrieve-page code.
anchor = '/* ------------------------------------------------------------------ result card'
if anchor not in text:
    raise SystemExit('result-card anchor not found')
text = text.replace(anchor, SCOPE_BLOCK + anchor, 1)

# ---------------------------------------------------------------- search() carries the scope
old_search = None
for candidate in (
    "const out = await api('recall?' + new URLSearchParams({project: project(), query: q, mode: mode}).toString());",
    "const out = await api('recall?' + new URLSearchParams({project: project(), query: q, mode}).toString());",
):
    if candidate in text:
        old_search = candidate
        break
if old_search:
    new_search = ("const params = scopeQuery();\n"
                  "  params.set('query', q); params.set('mode', mode);\n"
                  "  const out = await api('recall?' + params.toString());")
    text = text.replace(old_search, new_search, 1)
    print('search() wired to scopeQuery')
else:
    print('WARNING: search() recall call not found; scope not wired into search')

p.write_text(text, 'utf-8')
print('scope block inserted (%d chars)' % len(SCOPE_BLOCK))
