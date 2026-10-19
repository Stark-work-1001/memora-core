"""Add CSS for the components introduced this round."""
import pathlib

DEV = pathlib.Path(__file__).resolve().parents[2]
p = DEV / 'memora/static/memory.css'
text = p.read_text('utf-8')

BLOCK = r'''

/* ==========================================================================
   14. 检索范围 / 添加记忆两入口 / 模型类型 / 接入协议

   These four blocks are the UI for features added after section 13, so they share one rule: every
   colour resolves through an --mm-* token, and every rule is scoped to an id or a class this file
   itself introduces. No global element selector appears here, because a bare `aside` or `button`
   rule in this file already captured the embedded canvas once and turned a whole view white.
   ========================================================================== */

/* -- 14a 检索范围 ---------------------------------------------------------- */
.scope-panel {
  margin: 0 0 var(--mm-space-8);
  padding: var(--mm-space-7);
  border: 1px solid var(--mm-line);
  border-radius: var(--mm-radius);
  background: var(--mm-panel);
}

.scope-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--mm-space-6);
  flex-wrap: wrap;
  margin-bottom: var(--mm-space-6);
}

.scope-head .eyebrow { margin: 0 0 var(--mm-space-3); }

.scope-head .muted {
  margin: 0;
  font-size: var(--mm-text-sm);
  color: var(--mm-ink-muted);
}

/* Four rungs, widest to narrowest. A grid keeps the ordinal columns aligned no matter how long a
   description runs, and wraps to two columns before it ever needs a horizontal scrollbar. */
.scope-tiers {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--mm-space-4);
  margin-bottom: var(--mm-space-6);
}

.scope-tier {
  display: grid;
  gap: var(--mm-space-2);
  padding: var(--mm-space-5);
  text-align: left;
  border: 1px solid var(--mm-line-strong);
  border-radius: var(--mm-radius-sm);
  background: var(--mm-surface);
  color: var(--mm-ink);
  cursor: pointer;
  transition: border-color .16s ease, background .16s ease;
}

.scope-tier:hover { border-color: var(--mm-accent); }

.scope-tier.is-active {
  border-color: var(--mm-accent);
  background: var(--mm-accent-soft, var(--mm-surface));
}

.scope-tier.is-unavailable {
  opacity: .5;
  cursor: not-allowed;
}

.scope-tier-title {
  font-size: var(--mm-text-base);
  font-weight: 500;
}

.scope-tier-count {
  font-family: var(--mm-font-mono);
  font-size: var(--mm-text-xl);
  color: var(--mm-accent);
}

.scope-tier-desc {
  font-size: var(--mm-text-xs);
  line-height: 1.6;
  color: var(--mm-ink-muted);
}

.scope-space,
.scope-conversation {
  display: grid;
  gap: var(--mm-space-4);
  padding-top: var(--mm-space-5);
  border-top: 1px solid var(--mm-line);
}

.scope-space { grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr); }
.scope-conversation { grid-template-columns: minmax(0, 1fr); }

@media (max-width: 1100px) {
  .scope-tiers { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .scope-space { grid-template-columns: minmax(0, 1fr); }
}

.scope-field {
  display: grid;
  gap: var(--mm-space-2);
  font-size: var(--mm-text-sm);
  color: var(--mm-ink-muted);
}

.scope-field input,
.scope-field select {
  width: 100%;
  padding: var(--mm-space-3) var(--mm-space-4);
  border: 1px solid var(--mm-line-strong);
  border-radius: var(--mm-radius-sm);
  background: var(--mm-bg);
  color: var(--mm-ink);
  font: inherit;
}

.scope-space .row { grid-column: 1 / -1; align-items: center; }

/* -- 14b 添加记忆：两个入口 ------------------------------------------------- */
.capture-tabs {
  display: flex;
  gap: var(--mm-space-2);
  margin-bottom: var(--mm-space-6);
  border-bottom: 1px solid var(--mm-line);
}

.capture-tab {
  padding: var(--mm-space-3) var(--mm-space-5);
  border: 0;
  border-bottom: 2px solid transparent;
  background: none;
  color: var(--mm-ink-muted);
  font: inherit;
  cursor: pointer;
}

.capture-tab:hover { color: var(--mm-ink); }

.capture-tab.is-active {
  border-bottom-color: var(--mm-accent);
  color: var(--mm-ink);
  font-weight: 500;
}

.capture-pane { display: block; }

/* The drop zone is a <label> around the file input, so a click opens the picker with no JS. It has
   to look like a target: dashed border, generous height, and a state that says "drop here". */
.drop-zone {
  display: grid;
  justify-items: center;
  gap: var(--mm-space-2);
  padding: var(--mm-space-9) var(--mm-space-6);
  margin-bottom: var(--mm-space-5);
  border: 1px dashed var(--mm-line-strong);
  border-radius: var(--mm-radius);
  background: var(--mm-bg);
  color: var(--mm-ink-muted);
  text-align: center;
  cursor: pointer;
  transition: border-color .16s ease, background .16s ease;
}

.drop-zone:hover,
.drop-zone.is-over {
  border-color: var(--mm-accent);
  background: var(--mm-panel);
  color: var(--mm-ink);
}

.drop-zone.is-over { box-shadow: inset 0 0 0 1px var(--mm-accent); }

.drop-zone strong {
  font-size: var(--mm-text-base);
  font-weight: 500;
  color: var(--mm-ink);
}

.drop-zone-icon {
  font-size: var(--mm-text-2xl);
  line-height: 1;
  color: var(--mm-accent);
}

/* -- 14c 模型类型 ---------------------------------------------------------- */
.model-types {
  display: grid;
  gap: var(--mm-space-3);
}

.model-type-row {
  display: grid;
  grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr) minmax(0, 1fr);
  gap: var(--mm-space-5);
  align-items: center;
  padding: var(--mm-space-5);
  border: 1px solid var(--mm-line);
  border-radius: var(--mm-radius-sm);
  background: var(--mm-surface);
}

@media (max-width: 1000px) {
  .model-type-row { grid-template-columns: minmax(0, 1fr); }
}

.model-type-title { display: grid; gap: var(--mm-space-1); }
.model-type-title strong { font-size: var(--mm-text-base); font-weight: 500; }
.model-type-title small,
.model-type-row > small {
  font-size: var(--mm-text-xs);
  line-height: 1.6;
  color: var(--mm-ink-muted);
}

.model-type-row select {
  width: 100%;
  padding: var(--mm-space-3) var(--mm-space-4);
  border: 1px solid var(--mm-line-strong);
  border-radius: var(--mm-radius-sm);
  background: var(--mm-bg);
  color: var(--mm-ink);
  font: inherit;
}

.model-type-bound { color: var(--mm-ok); }
.model-type-unbound { color: var(--mm-warn); }

/* -- 14d 接入协议 / 在线智能体 ---------------------------------------------- */
.protocol-entry {
  display: block;
  margin: var(--mm-space-3) 0;
  padding: var(--mm-space-3) var(--mm-space-4);
  border: 1px solid var(--mm-line);
  border-radius: var(--mm-radius-sm);
  background: var(--mm-bg);
  color: var(--mm-ink-muted);
  font-family: var(--mm-font-mono);
  font-size: var(--mm-text-xs);
  word-break: break-all;
}

/* An online agent is the one thing on this page a user scans for, so it gets a real marker rather
   than only a word: a left rule in the success colour, matching how the canvas marks a live node. */
.card.is-online { border-left: 2px solid var(--mm-ok); }

.card .pill.is-ok {
  border-color: var(--mm-ok);
  color: var(--mm-ok);
}

'''

if '14a 检索范围' in text:
    raise SystemExit('CSS block already present')

text = text.rstrip() + '\n' + BLOCK
p.write_text(text, 'utf-8')
print('memory.css extended (%d chars)' % len(BLOCK))

# Verify every token used in the new block is defined somewhere in the sheet.
import re
defined = set(re.findall(r'(--mm-[a-z0-9-]+)\s*:', text))
used = set(re.findall(r'var\((--mm-[a-z0-9-]+)', BLOCK))
missing = sorted(used - defined)
print('undefined tokens in the new block:', missing)
