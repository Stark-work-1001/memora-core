#!/usr/bin/env node
/**
 * Verify that the installed DSH connector actually keeps a peer alive in the standalone
 * application's memory store -- through the same code path the host uses, not a simulation.
 *
 * WHAT IT DOES
 *   1. loads the installed connector backend module from <plugin dir>/memory-connector
 *      and applies it with the *installed profile's* connector config (parsed out of the DSH
 *      profile patch, so the check cannot silently drift from what the host will run);
 *   2. waits for the periodic heartbeat tick -- it deliberately does NOT call the heartbeat
 *      tool itself, because the open question is whether presence refreshes with nobody
 *      calling it;
 *   3. reads data/memora-control.sqlite3 (read-only) to prove peers.seen advances;
 *   4. asserts the whitelist gate still refuses tools outside ALLOWED_TOOLS, and that
 *      dispose() stops the timer.
 *
 * WHY NOT HTTP: the standalone backend is driven over stdio. Nothing here needs a web port,
 * and nothing here needs the desktop app to be running.
 *
 * Usage:
 *   node tools/verify_dsh_presence.mjs [--intervals 2] [--json report.json]
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import os from 'node:os'

const here = path.dirname(fileURLToPath(import.meta.url))
const dshRoot = process.env.MEMORA_DSH_ROOT || path.join(os.homedir(), '.dsh')
const pluginRoot = process.env.MEMORA_DSH_PLUGIN_ROOT || path.join(os.homedir(), '.dsh', 'plugins')
const profile = path.join(dshRoot, 'profiles', 'desktop', 'cordis.patch.yml')
const controlDb = path.join(here, '..', '..', 'memora-desktop-standalone', 'data', 'memora-control.sqlite3')

const argv = process.argv.slice(2)
const jsonOut = argv.includes('--json') ? argv[argv.indexOf('--json') + 1] : null

// -- the installed connector config, read from the installed profile ------------------------
// Parsed with a tiny purpose-built reader instead of a YAML dependency: the values that
// matter here are plain scalars, and a checklist that hides a wrong path behind a parser
// error would defeat the point.
function connectorConfigFromPatch(rawText) {
  // Normalize CRLF first: the profile is edited on Windows, and a regex anchored on `\n` would
  // silently find nothing in a CRLF file (that failure reads as "heartbeat not configured",
  // which is the wrong conclusion about the wrong thing).
  const text = rawText.replace(/\r\n/g, '\n')
  const start = text.indexOf('- id: memory-connector')
  if (start < 0) throw new Error('profile patch has no memory-connector row')
  const end = text.indexOf('\n- ', start)
  const block = start >= 0 ? text.slice(start, end < 0 ? undefined : end) : ''
  // Values are quoted either way in this profile dialect (rendered paths use JSON double
  // quotes, hand-written labels use single quotes), so every reader here accepts both.
  const unquote = (value) => value.trim().replace(/^['"]|['"]$/g, '')
  const scalar = (re) => {
    const found = block.match(re)
    return found ? unquote(found[1]) : undefined
  }
  const command = scalar(/^\s*command:\s*(.+)$/m)
  const dataArg = scalar(/^\s*-\s*['"]--data['"]\s*\n\s*-\s*(.+)$/m)
  const defaultProject = scalar(/^\s*defaultProject:\s*(.+)$/m)
  const heartbeat = {}
  const at = block.indexOf('heartbeat:')
  if (at >= 0) {
    for (const line of block.slice(at).split('\n')) {
      const m = line.match(/^\s+([a-zA-Z]+):\s*(.+)$/)
      if (m) heartbeat[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
    }
  }
  return { command, dataArg, defaultProject, heartbeat }
}

// -- read the peers table without touching anything else ----------------------------------
async function readPeer(dbPath, peerId) {
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const row = db.prepare('SELECT * FROM peers WHERE id = ?').get(peerId)
    if (!row) return null
    const now = Date.now() / 1000
    return {
      id: row.id, project: row.project, name: row.name, seen: row.seen, ttl: row.ttl,
      seen_iso: new Date(row.seen * 1000).toISOString(),
      age_seconds: Math.max(0, Math.round((now - row.seen) * 10) / 10),
      connected: now - row.seen <= row.ttl,
    }
  } finally { db.close() }
}

const report = { started_at: new Date().toISOString(), steps: [] }
const step = (name, data) => {
  report.steps.push({ name, at: new Date().toISOString(), ...data })
  console.log(`[${name}]`, JSON.stringify(data))
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const patchText = readFileSync(profile, 'utf8')
const config = connectorConfigFromPatch(patchText)
const heartbeat = {
  enabled: config.heartbeat.enabled === 'true',
  intervalMs: Number(config.heartbeat.intervalMs),
  ttl: Number(config.heartbeat.ttl),
  peer: config.heartbeat.peer,
  project: config.heartbeat.project,
  name: config.heartbeat.name,
}
step('profile', { profile, backend: config.command, data: config.dataArg, heartbeat })
if (!heartbeat.enabled) throw new Error('heartbeat.enabled is not true in the installed profile')
if (!heartbeat.intervalMs) throw new Error('heartbeat.intervalMs missing')

// -- drive the real connector module, with the real config, against the real exe ----------
const backend = await import(pathToFileURL(path.join(pluginRoot, 'memory-connector', 'lib', 'backends', 'memora.js')).href)
const registered = []
const logs = []
const ctx = {
  logger: {
    info: (m) => logs.push(['info', String(m)]),
    warn: (m) => logs.push(['warn', String(m)]),
    error: (m) => logs.push(['error', String(m)]),
    debug: (m) => logs.push(['debug', String(m)]),
  },
  tools: { register: (tool) => { registered.push(tool.name); return () => {} } },
}
const cfg = {
  backend: 'memora',
  backends: {
    memora: {
      command: config.command,
      args: ['--data', config.dataArg, 'mcp'],
      defaultProject: config.defaultProject,
      label: 'memora (desktop-standalone)',
      env: { PYTHONUTF8: '1' },
    },
  },
  localOnly: true,
  timeoutMs: 120000,
  bootTimeoutMs: 180000,
  heartbeat,
}
const dispose = backend.activate(ctx, cfg)
step('activate', { registered, logs: logs.map(([, m]) => m) })
if (!registered.includes('memory_peer_heartbeat')) throw new Error('heartbeat tool not registered')

// Wait for the timer's first tick instead of calling the tool: that is the whole question.
const waitMs = heartbeat.intervalMs + 8000
console.log(`waiting ${Math.round(waitMs / 1000)}s for the periodic heartbeat (interval ${heartbeat.intervalMs}ms) ...`)
await sleep(waitMs)

const first = await readPeer(controlDb, heartbeat.peer)
step('after_first_tick', { peer: first })
if (!first) throw new Error('no peers row: the periodic heartbeat did not reach the store')
if (!first.connected) throw new Error('peers row exists but is not connected (stale seen)')

await sleep(heartbeat.intervalMs)
const second = await readPeer(controlDb, heartbeat.peer)
step('after_second_tick', { peer: second, advanced_by_seconds: Math.round((second.seen - first.seen) * 10) / 10 })
if (!(second.seen > first.seen)) throw new Error('seen did not advance: the timer is not periodic')
if (!second.connected) throw new Error('peers row expired again after one interval')

// -- the whitelist gate is unchanged ------------------------------------------------------
const gate = {
  memory_review_callable: backend.isCallableTool('memory_review'),
  memory_document_put_callable: backend.isCallableTool('memory_document_put'),
  memory_peer_heartbeat_callable: backend.isCallableTool('memory_peer_heartbeat'),
}
step('gate', gate)
if (!gate.memory_peer_heartbeat_callable) throw new Error('heartbeat is not callable — the gate is wrong, not the timer')
if (gate.memory_review_callable || gate.memory_document_put_callable) throw new Error('whitelist gate regressed')

// -- dispose must stop the timer ---------------------------------------------------------
dispose()
const beforeDispose = await readPeer(controlDb, heartbeat.peer)
await sleep(heartbeat.intervalMs + 2000)
const afterDispose = await readPeer(controlDb, heartbeat.peer)
step('dispose', { seen_before: beforeDispose.seen, seen_after: afterDispose.seen, timer_stopped: afterDispose.seen === beforeDispose.seen })
if (afterDispose.seen !== beforeDispose.seen) throw new Error('timer still running after dispose()')

report.ok = true
report.finished_at = new Date().toISOString()
if (jsonOut) {
  mkdirSync(path.dirname(jsonOut), { recursive: true })
  writeFileSync(jsonOut, JSON.stringify(report, null, 2), 'utf8')
  console.log('report:', jsonOut)
}
console.log('PRESENCE OK: periodic heartbeat keeps peers.seen fresh, gate intact, timer stopped on dispose.')