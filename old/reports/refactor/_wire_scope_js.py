"""Wire the scope tier into the two read call sites, and add the markdown capture handlers."""
import pathlib

DEV = pathlib.Path(__file__).resolve().parents[2]
p = DEV / 'memora/static/memory.js'
text = p.read_text('utf-8')

# ---------------------------------------------------------------- search() sends the tier
old = ("async function search(submitter) {\n"
       "  const mode = $('search-mode').value;\n"
       "  const text = $('query').value;\n"
       "  const out = await query('recall', {query: text, mode});")
new = ("async function search(submitter) {\n"
       "  const mode = $('search-mode').value;\n"
       "  const text = $('query').value;\n"
       "  // The scope is part of the query, not a display filter: the server decides which tiers a\n"
       "  // rung reads (memora/scopes.py), so passing it here is what makes the rung real.\n"
       "  const out = await query('recall', scopeParams({query: text, mode}));")
if old not in text:
    raise SystemExit('search() anchor not found')
text = text.replace(old, new, 1)
print('search() wired')

# ---------------------------------------------------------------- scopeParams helper
helper = r'''
/** Query parameters carrying the current read scope.

    A narrower rung includes the wider ones, which is decided server-side; the page only says WHERE
    to read. Conversation adds the session pin. Kept as one helper so no call site can forget half
    of the scope and silently read the wrong set. */
function scopeParams(base) {
  const out = Object.assign({}, base || {});
  if (SCOPE_STATE.tier && SCOPE_STATE.tier !== 'project') out.tier = SCOPE_STATE.tier;
  if (SCOPE_STATE.tier === 'conversation' && SCOPE_STATE.session) out.session_id = SCOPE_STATE.session;
  return out;
}
'''
anchor = '/* ------------------------------------------------------------------ 检索范围（四级）'
if anchor not in text:
    raise SystemExit('scope block anchor not found')
text = text.replace(anchor, helper + '\n' + anchor, 1)
print('scopeParams helper added')

# ---------------------------------------------------------------- scopeQuery uses it
old_q = ("function scopeQuery() {\n"
         "  const params = new URLSearchParams({project: project()});\n"
         "  if (SCOPE_STATE.tier && SCOPE_STATE.tier !== 'project') params.set('tier', SCOPE_STATE.tier);\n"
         "  if (SCOPE_STATE.tier === 'conversation' && SCOPE_STATE.session) params.set('session_id', SCOPE_STATE.session);\n"
         "  return params;\n"
         "}")
new_q = ("function scopeQuery() {\n"
         "  const params = new URLSearchParams({project: project()});\n"
         "  for (const [k, v] of Object.entries(scopeParams({}))) params.set(k, String(v));\n"
         "  return params;\n"
         "}")
if old_q in text:
    text = text.replace(old_q, new_q, 1)
    print('scopeQuery simplified')

# ---------------------------------------------------------------- enterRetrieve refreshes the ladder
old_enter = 'async function enterRetrieve() {'
if old_enter not in text:
    raise SystemExit('enterRetrieve anchor not found')
index = text.index(old_enter)
brace = text.index('{', index)
# insert a scope refresh as the first statement inside the function
insert_at = brace + 1
snippet = ("\n  // The scope panel is part of this page, and its counts go stale as soon as a memory is\n"
           "  // approved elsewhere. Read them on entry (one cheap GET), then repaint.\n"
           "  try { await scopeRefresh(); } catch (e) { /* a scope read must not block retrieval */ }\n")
text = text[:insert_at] + snippet + text[insert_at:]
print('enterRetrieve refreshes scope')

p.write_text(text, 'utf-8')
print('memory.js scope wiring complete')
