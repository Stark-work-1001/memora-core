#!/usr/bin/env node
/**
 * Raw MCP evidence: speak JSON-RPC to the packaged standalone backend and call
 * memory_peer_heartbeat. No connector plugin, no HTTP, no web port.
 *
 * WHY A SECOND SCRIPT: tools/verify_dsh_presence.mjs proves the *periodic timer* works, but
 * it does so through the connector module, which could in principle hide a broken backend
 * behind its own logging. This one talks to the exe with nothing in between, so the claim
 * "the backend supports MCP initialize + tools/call memory_peer_heartbeat" is evidenced on
 * its own terms -- the same claim the profile depends on.
 *
 * The probe registers under its own peer id (p1-verify-probe) and deletes that row again, so
 * it can never make the real connector look alive. Nothing else in the store is touched.
 *
 * Usage:
 *   node tools/dsh_mcp_heartbeat_probe.mjs [--exe <path>] [--data <dir>] [--json <file>]
 */
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const standalone = path.resolve(here, '..', '..', 'memora-desktop-standalone')
const argv = process.argv.slice(2)
const option = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback)
const exe = option('--exe', path.join(standalone, 'resources', 'backend', 'memora-backend.exe'))
const data = option('--data', path.join(standalone, 'data'))
const jsonOut = option('--json', null)
const PROBE_PEER = 'p1-verify-probe'

const report = { started_at: new Date().toISOString(), exe, data, steps: {} }
const log = (name, value) => { report.steps[name] = value; console.log(`[${name}]`, JSON.stringify(value)) }

const child = spawn(exe, ['--data', data, 'mcp'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, PYTHONUTF8: '1' } })
const pending = new Map()
let nextId = 1
let buffer = ''
const stderr = []
child.stderr.on('data', (chunk) => stderr.push(String(chunk)))
child.stdout.on('data', (chunk) => {
  buffer += String(chunk)
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (!line.startsWith('{')) continue
    let message
    try { message = JSON.parse(line) } catch { continue }
    const waiter = pending.get(message.id)
    if (!waiter) continue
    pending.delete(message.id)
    message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result)
  }
})
const rpc = (method, params) => new Promise((resolve, reject) => {
  const id = nextId++
  pending.set(id, { resolve, reject })
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
})
const notify = (method, params) => child.stdin.write(
  JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')

try {
  const init = await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: { roots: { listChanged: false } },
    clientInfo: { name: 'memora-p1-probe', version: '1.0.0' },
  })
  log('initialize', {
    protocolVersion: init.protocolVersion,
    serverInfo: init.serverInfo,
    instructions: typeof init.instructions === "string" ? init.instructions.slice(0, 120) : null,
  })
  notify('notifications/initialized', {})
  const listed = await rpc('tools/list', {})
  const names = (listed.tools || []).map((tool) => tool.name)
  log('tools/list', { count: names.length, has_heartbeat: names.includes('memory_peer_heartbeat'), names })
  if (!names.includes('memory_peer_heartbeat')) throw new Error('backend does not expose memory_peer_heartbeat')
  const called = await rpc('tools/call', {
    name: 'memory_peer_heartbeat',
    arguments: { project: 'default', peer: PROBE_PEER, name: 'P1 verification probe', model: 'probe', location: 'local', ttl: 60, capabilities: { verification: true } },
  })
  const text = (called.content || []).map((block) => block.text).join('\n')
  log('tools/call', { isError: called.isError === true, text })
  const payload = JSON.parse(text)
  log('peer_row', payload)
  if (payload.connected !== true) throw new Error('heartbeat row is not connected')
  if (payload.id !== PROBE_PEER) throw new Error('heartbeat row carries the wrong peer id')
  const peers = await rpc('tools/call', { name: 'memory_peers', arguments: { project: 'default' } })
  const peersText = (peers.content || []).map((block) => block.text).join('\n')
  log('memory_peers', JSON.parse(peersText))
  report.ok = true
} catch (error) {
  report.ok = false
  report.error = String(error?.message ?? error)
  report.stderr = stderr.join('').slice(-2000)
  console.error('PROBE FAILED:', report.error)
  if (report.stderr) console.error(report.stderr)
} finally {
  // delete only the probe row this script created
  try {
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')
    const db = new DatabaseSync(path.join(data, 'memora-control.sqlite3'))
    const removed = db.prepare('DELETE FROM peers WHERE id = ?').run(PROBE_PEER)
    db.close()
    log('cleanup', { removed_probe_rows: Number(removed.changes) })
  } catch (error) {
    log('cleanup', { error: String(error?.message ?? error) })
  }
  try { child.stdin.end() } catch {}
  await new Promise((resolve) => {
    const timer = setTimeout(() => { try { child.kill() } catch {}; resolve() }, 5000)
    child.once('exit', () => { clearTimeout(timer); resolve() })
  })
  report.finished_at = new Date().toISOString()
  if (jsonOut) {
    mkdirSync(path.dirname(jsonOut), { recursive: true })
    writeFileSync(jsonOut, JSON.stringify(report, null, 2), 'utf8')
    console.log('report:', jsonOut)
  }
  if (!report.ok) process.exitCode = 1
}
