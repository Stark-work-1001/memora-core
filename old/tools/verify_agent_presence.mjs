#!/usr/bin/env node
/**
 * Verify that the DSH memory connector is BOTH loaded and actually working in the live host.
 *
 * WHY THIS SCRIPT EXISTS
 * ----------------------
 * "The connector is broken" and "the connector never ran" look identical in the UI: both show
 * 无在线智能体, both leave peers.seen stale, and both leave the tool surface empty. The two
 * failures have completely different fixes, so this script answers the four questions
 * separately instead of reporting one ambiguous verdict:
 *
 *   1. IS IT IN THE HOST'S LOADER?          pluginInventory/list -> entry include:memory-connector
 *      (fiberPhase) crosses from "active" to proof that the plugin's apply() ran.
 *   2. DID apply() REGISTER ITS TOOLS?      the entry being active does NOT mean it registered
 *      anything; a plugin that returns early is still active. Only a live tool call proves this.
 *   3. DID IT SPAWN ITS MCP CHILD?          a working connector holds "memora-backend.exe ... mcp"
 *      for its whole lifetime; without that child no heartbeat can be sent.
 *   4. IS THE PEER FRESH?                   peers.seen inside ttl in the standalone app's control
 *      database is the only thing the UI actually reads.
 *
 * It also proves the duplicate-Loader-row defect directly: the bundle patch
 * (<plugin dir>\memory-connector\cordis.patch.yml) and the profile patch each insert a
 * row with id "memory-connector". cordis's applyEntryPatches only APPENDS inserts and never
 * de-duplicates by id, so the composed tree carries the same id twice; whatever the Loader's
 * EntryGroup.update happens to keep is then a property of map ordering rather than a decision.
 *
 * READ-ONLY WITH ONE EXCEPTION: it never writes the profile, never restarts or kills the host,
 * and never touches business data. The only write is the heartbeat row that the connector itself
 * sends (that row is presence bookkeeping, which the product is designed to carry).
 *
 * Usage:
 *   node tools/verify_agent_presence.mjs                 # full check, one heartbeat interval
 *   node tools/verify_agent_presence.mjs --json out.json # also save the report
 *   node tools/verify_agent_presence.mjs --no-wait       # skip the interval wait (fast triage)
 *   node tools/verify_agent_presence.mjs --profile <dir> # non-default DSH profile
 *
 * Exit code: 0 all checks pass, 1 a check failed, 2 could not run (missing host / dependency).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

const here = path.dirname(fileURLToPath(import.meta.url))
const dshRoot = process.env.MEMORA_DSH_ROOT || path.join(os.homedir(), '.dsh')
const pluginRoot = process.env.MEMORA_DSH_PLUGIN_ROOT || path.join(os.homedir(), '.dsh', 'plugins')
const dev = path.resolve(here, '..')

// ── arguments ────────────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const option = (name, fallback) => {
  const at = argv.indexOf(name)
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback
}
const jsonOut = option('--json', null)
const noWait = flag('--no-wait')
const profileDir = option(
  '--profile',
  process.env.DSH_PROFILE_DIR ?? path.join(os.homedir(), '.dsh', 'profiles', 'desktop'),
)
const PATCH = path.join(profileDir, 'cordis.patch.yml')
const BUNDLE_PATCH = option(
  '--bundle-patch',
  path.join(os.homedir(), '.dsh', 'plugins', 'memory-connector', 'cordis.patch.yml'),
)
const CONTROL_DB = option(
  '--control-db',
  path.join(dev, '..', 'memora-desktop-standalone', 'data', 'memora-control.sqlite3'),
)
const HOST_URL = option('--host', process.env.DSH_WEB_URL ?? 'http://127.0.0.1:57278')
const CREDENTIALS = option('--credentials', path.join(os.homedir(), '.dsh', '.credentials.yaml'))

const report = { started_at: new Date().toISOString(), profile_dir: profileDir, steps: [], checks: [] }
const step = (name, data) => {
  report.steps.push({ name, at: new Date().toISOString(), ...data })
  console.log('[' + name + '] ' + JSON.stringify(data))
}
const check = (id, ok, detail) => {
  report.checks.push({ id, ok: Boolean(ok), detail })
  console.log((ok ? '  PASS  ' : '  FAIL  ') + id + (detail === undefined ? '' : ' — ' + JSON.stringify(detail)))
  return ok
}

// ── 1. static composition: the duplicate-id defect, proven with the host's own patch code ────
// applyEntryPatches is imported from the SHIPPED runtime (not reimplemented), so this cannot
// drift from what the host actually does at boot.
// The shipped runtime lives inside app.asar, which only Electron's patched fs can read. A plain
// node process therefore falls back to the same package from the source tree the desktop build
// was produced from; the version is reported so a reader can tell which copy answered.
const INCLUDE_CANDIDATES = [
  { dir: path.join(dshRoot, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'cordis-plugin-include'), label: 'shipped (app.asar)' },
  { dir: path.join(dshRoot, 'app', 'src', 'packages', 'boot', 'app-boot', 'node_modules', '@deepseek-ai', 'cordis-plugin-include'), label: 'source tree (app-boot)' },
  { dir: path.join(dshRoot, 'app', 'src', 'vendor', 'cordis', 'node_modules', '@deepseek-ai', 'cordis-plugin-include'), label: 'source tree (vendor/cordis)' },
  { dir: path.join(pluginRoot, 'memory-connector', 'node_modules', '@deepseek-ai', 'cordis-plugin-include'), label: 'connector vendored' },
]

async function loadInclude() {
  const attempts = []
  for (const candidate of INCLUDE_CANDIDATES) {
    try {
      const manifest = JSON.parse(readFileSync(candidate.dir + '/package.json', 'utf8'))
      const module = await import('file:///' + candidate.dir + '/lib/index.js')
      let yaml
      for (const yamlDir of [
        candidate.dir + '/node_modules/js-yaml',
        path.join(dev, 'desktop/node_modules/js-yaml'),
        path.join(dshRoot, 'app', 'src', 'vendor', 'cordis', 'node_modules', '@deepseek-ai', 'cordis-plugin-include', 'node_modules', 'js-yaml'),
      ]) {
        try { yaml = createRequire(import.meta.url)(yamlDir); break } catch {}
      }
      if (yaml === undefined) throw new Error('js-yaml not found beside ' + candidate.dir)
      return { module, yaml, provenance: { source: candidate.label, version: manifest.version } }
    } catch (error) {
      attempts.push(candidate.label + ': ' + String(error && error.message ? error.message : error))
    }
  }
  throw new Error('no readable cordis-plugin-include: ' + attempts.join(' | '))
}

/**
 * Resolve a bundle's patch files exactly like the host's `resolveBundleDir`: the installation
 * anchor first, then the profile directory. `createRequire(...).resolve.paths()` is Node's own
 * lookup order, so a name resolves through the profile's pnpm links the same way the Loader's
 * import would.
 */
function resolveBundleDir(name) {
  for (const anchor of [path.join(dshRoot, 'resources', 'app.asar', 'dsh', 'package.json'), path.join(profileDir, 'package.json')]) {
    let searchPaths
    try { searchPaths = createRequire(anchor).resolve.paths(name) ?? [] } catch { continue }
    for (const searchPath of searchPaths) {
      const candidate = path.join(searchPath, name)
      if (existsSync(path.join(candidate, 'package.json'))) return candidate
    }
  }
  return null
}

/** The ordered patch layers of the profile's bundles, concatenated in `dsh.profile.bundles` order. */
function bundleLayers() {
  const manifest = JSON.parse(readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
  const names = manifest.dsh?.profile?.bundles ?? []
  const layers = []
  const skipped = []
  for (const name of names) {
    const dir = resolveBundleDir(name)
    if (dir === null) { skipped.push({ bundle: name, reason: 'unresolved' }); continue }
    let bundleManifest
    try { bundleManifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) } catch (error) {
      skipped.push({ bundle: name, reason: 'unreadable manifest: ' + String(error.message) }); continue
    }
    const declared = bundleManifest.dsh?.bundle?.patch
    if (declared === undefined) { skipped.push({ bundle: name, reason: 'no dsh.bundle' }); continue }
    const files = typeof declared === 'string' ? [declared] : declared
    layers.push({ bundle: name, files: files.map((file) => path.join(dir, file)) })
  }
  return { layers, skipped }
}

async function composeLikeTheHost() {
  const { module, yaml, provenance } = await loadInclude()
  const readPatches = (file) => yaml.load(readFileSync(file, 'utf8'), { schema: module.entryListSchema }) ?? []
  const { layers, skipped } = bundleLayers()
  const bundlePatches = []
  const failedLayers = []
  for (const layer of layers) {
    try {
      for (const file of layer.files) bundlePatches.push(...readPatches(file))
    } catch (error) {
      failedLayers.push({ bundle: layer.bundle, reason: String(error && error.message ? error.message : error) })
    }
  }
  const profilePatches = readPatches(PATCH)
  const warnings = []
  // composeEntries() exactly: ONE applyEntryPatches call over all layers in application order.
  const composed = module.applyEntryPatches([], structuredClone([...bundlePatches, ...profilePatches]), (message, ...args) => {
    let index = 0
    warnings.push(String(message).replace(/%C/g, () => JSON.stringify(args[index++])))
  })
  // Starting from an EMPTY root means the returned rows ARE the composed tree, with the patch
  // wrappers already consumed — which is what the Loader mounts.
  const counts = new Map()
  for (const row of composed) counts.set(row.id, (counts.get(row.id) ?? 0) + 1)
  const duplicates = [...counts].filter(([, n]) => n > 1).map(([id, n]) => ({ id, rows: n }))
  // A row duplicated across bundle layers is the same defect as a bundle/profile duplicate: the
  // Loader keeps one and the choice is map order, not intent. Report where each duplicate CAME
  // from so the report says what to delete, not just that something is wrong.
  const origins = new Map()
  for (const [index, file] of layers.flatMap((layer) => layer.files.map((file) => [layer.bundle, file]))) {
    let rows = []
    try { rows = readPatches(file) } catch { continue }
    for (const patch of rows) {
      for (const row of patch.insert ?? []) {
        if (!origins.has(row.id)) origins.set(row.id, [])
        origins.get(row.id).push({ bundle: index, file, name: row.name, heartbeat: Boolean(row.config?.heartbeat) })
      }
    }
  }
  // An override row for an id that nothing inserted is silently dropped by applyEntryPatches
  // ("patch: entry not found"), so a typo in the target id is exactly as invisible as the
  // duplicate it replaced.
  const overrideIds = profilePatches
    .filter((patch) => patch.insert === undefined && typeof patch.id === 'string')
    .map((patch) => patch.id)
  // Rows from an unreadable bundle layer are absent from `counts` for a reason that has nothing
  // to do with the profile: app.asar bundles cannot be read by a plain node process, so their
  // rows are simply not in this composition. Reporting those as dangling would be a false alarm,
  // so the check is only decisive when every bundle layer was read.
  const complete = skipped.length === 0 && failedLayers.length === 0
  const danglingOverrides = complete ? overrideIds.filter((id) => !counts.has(id)) : []
  const unverifiedOverrides = complete ? [] : overrideIds.filter((id) => !counts.has(id))
  const connector = composed.find((row) => row.id === 'memory-connector') ?? null
  return {
    provenance,
    bundleCount: layers.length,
    bundlePatches: bundlePatches.length,
    profilePatches: profilePatches.length,
    rows: composed.length,
    duplicates: duplicates.map((duplicate) => ({ ...duplicate, origins: origins.get(duplicate.id) ?? [] })),
    danglingOverrides,
    unverifiedOverrides,
    layersComplete: complete,
    skippedBundles: skipped.length,
    failedLayers,
    connectorRow: connector === null ? null : {
      name: connector.name,
      heartbeat: Boolean(connector.config?.heartbeat?.enabled),
      backendCommand: connector.config?.backends?.memora?.command ?? null,
      defaultProject: connector.config?.backends?.memora?.defaultProject ?? null,
    },
    warnings,
  }
}

// ── 2. is the connector in the LIVE host's Loader, and still enabled? ────────────────────────
// The host authenticates every request. The launch token is per-process and not readable from
// outside, but the durable browser-session cookie secret IS on disk, and the host accepts a
// cookie signed with it -- that is what the desktop shell's own window uses. Minting one is a
// local, read-only use of a secret this profile already owns.
function mintCookie(authority) {
  const text = readFileSync(CREDENTIALS, 'utf8')
  const match = text.match(/client-connection\/browser-session:[\s\S]*?secret:\s*([A-Za-z0-9_-]+)/)
  if (!match) throw new Error('no browser-session secret in ' + CREDENTIALS)
  const pad = '='.repeat((4 - (match[1].length % 4)) % 4)
  const secret = Buffer.from(match[1].replaceAll('-', '+').replaceAll('_', '/') + pad, 'base64')
  const enc = (s) => Buffer.from(s).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
  const issuedAt = Date.now()
  const payload = { version: 1, authority, issuedAt, expiresAt: issuedAt + 86400000 }
  const body = enc(JSON.stringify(payload))
  const crypto = createRequire(import.meta.url)('node:crypto')
  const signature = crypto.createHmac('sha256', secret).update(body).digest()
  const name = 'dsh-auth-' + enc(crypto.createHash('sha256').update(authority).digest())
  return { name, value: 'v1.' + body + '.' + enc(signature) }
}

async function rpc(method, args) {
  const url = new URL(HOST_URL)
  const cookie = mintCookie(url.host)
  const body = {
    type: 'client-request',
    rpcId: 'verify-' + Math.random().toString(36).slice(2, 10),
    method,
    params: {},
    payload: { args: args ?? {} },
  }
  const response = await fetch(HOST_URL + '/api/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: cookie.name + '=' + cookie.value },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  let parsed
  try { parsed = JSON.parse(text) } catch { throw new Error(method + ' returned non-JSON: ' + text.slice(0, 200)) }
  if (parsed.result?.ok !== true) {
    throw new Error(method + ' failed: ' + JSON.stringify(parsed.result?.error ?? parsed).slice(0, 400))
  }
  return parsed.result.value
}

async function liveLoaderRow() {
  const value = await rpc('pluginInventory/list', {})
  const rows = value.entries ?? []
  return {
    entries: rows.length,
    row: rows.find((row) => row.entryId === 'include:memory-connector') ?? null,
    phases: rows.reduce((acc, row) => {
      const key = row.fiberPhase ?? 'null'
      acc[key] = (acc[key] ?? 0) + 1
      return acc
    }, {}),
  }
}

// ── 3. the MCP child: a connector that never applied has no child; one that applied does ─────
function connectorChildren() {
  let listing = ''
  try {
    listing = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command',
       'Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress'],
      { encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
    )
  } catch (error) {
    // A failure here means powershell itself was unavailable, not that the child is absent.
    listing = error.stdout ? error.stdout.toString() : ''
  }
  let processes = []
  try {
    const parsed = JSON.parse(listing.trim() || '[]')
    processes = Array.isArray(parsed) ? parsed : [parsed]
  } catch {
    return { available: false, matches: [] }
  }
  // Match the command line, not the image name: both the connector's "memora-backend.exe ... mcp"
  // and the standalone app's own "memora-backend.exe ... serve" are the same image.
  const matches = processes.filter((p) =>
    typeof p.CommandLine === 'string'
    && /memora-backend\.exe/i.test(p.CommandLine)
    && /\smcp\s*$/i.test(p.CommandLine.trim()))
    .map((p) => ({ pid: p.ProcessId, command: p.CommandLine }))
  return { available: true, matches, total: processes.length }
}

// ── 4. the only thing the UI reads: peers.seen inside ttl ─────────────────────────────────────
async function readPeer(peerId) {
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')
  const db = new DatabaseSync(CONTROL_DB, { readOnly: true })
  try {
    const row = db.prepare('SELECT * FROM peers WHERE id = ?').get(peerId)
    if (!row) return null
    const now = Date.now() / 1000
    return {
      id: row.id,
      project: row.project,
      name: row.name,
      seen: Number(row.seen),
      seen_iso: new Date(Number(row.seen) * 1000).toISOString(),
      ttl: Number(row.ttl),
      age_seconds: Math.round((now - Number(row.seen)) * 10) / 10,
      connected: now - Number(row.seen) <= Number(row.ttl),
    }
  } finally {
    db.close()
  }
}

function configuredHeartbeat() {
  // Read the values out of the profile text without a YAML dependency: this is a triage tool and
  // must still answer when the host's own parser is unavailable.
  const text = readFileSync(PATCH, 'utf8').replace(/\r\n/g, '\n')
  const at = text.indexOf('- id: memory-connector')
  const end = at < 0 ? -1 : text.indexOf('\n- ', at)
  const block = at < 0 ? '' : text.slice(at, end < 0 ? text.length : end)
  const heartbeatAt = block.indexOf('heartbeat:')
  if (heartbeatAt < 0) return { present: false }
  const heartbeatBlock = block.slice(heartbeatAt)
  const scalar = (key) => {
    const match = heartbeatBlock.match(new RegExp('^\\s+' + key + ':\\s*(.+)$', 'm'))
    return match ? match[1].trim().replace(/^['"]|['"]$/g, '') : undefined
  }
  const intervalMs = Number(scalar('intervalMs'))
  const ttl = Number(scalar('ttl'))
  return {
    present: true,
    enabled: scalar('enabled') === 'true',
    intervalMs: Number.isFinite(intervalMs) ? intervalMs : undefined,
    ttl: Number.isFinite(ttl) ? ttl : undefined,
    peer: scalar('peer'),
    project: scalar('project'),
  }
}

// ── main ─────────────────────────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let failed = false

if (!existsSync(PATCH)) {
  console.error('cannot run: profile patch not found at ' + PATCH)
  process.exit(2)
}

// (a) duplicate Loader row: static, never needs a host.
try {
  const composition = await composeLikeTheHost()
  step('composition', composition)
  failed = !check(
    'single-insert-row-per-id',
    composition.duplicates.length === 0,
    composition.duplicates.length === 0
      ? { rows: composition.rows, ids: 'every id appears once' }
      : {
          duplicates: composition.duplicates,
          why: 'cordis append-only inserts mean the same id reaches the Loader twice; '
             + 'the surviving row is decided by Map order, not by intent',
        },
  ) || failed
  failed = !check(
    'no-dangling-id-override',
    composition.danglingOverrides.length === 0,
    composition.layersComplete === false
      ? {
          layers: 'partial: ' + composition.skippedBundles + ' bundle layer(s) unreadable from plain node '
                + '(they live in app.asar), so override targets that live there were not judged',
          unverified: composition.unverifiedOverrides,
        }
      : composition.danglingOverrides.length === 0
        ? { overrides: 'every id-targeted override matched an inserted row' }
        : {
            dangling: composition.danglingOverrides,
            why: 'an override whose id nothing inserted is dropped with a Loader warning; '
               + 'the config silently never applies',
          },
  ) || failed
  // The composed row is what the Loader runs, so it — not the profile text — is the claim worth
  // asserting: a correct profile plus a wrong merge is still broken.
  failed = !check(
    'composed-connector-row-correct',
    composition.connectorRow !== null
      && composition.connectorRow.heartbeat === true
      && typeof composition.connectorRow.backendCommand === 'string'
      && composition.connectorRow.backendCommand.length > 0,
    composition.connectorRow,
  ) || failed
} catch (error) {
  step('composition', { error: String(error && error.message ? error.message : error) })
}

// (b) live Loader membership. This is the one question the "no child process" reasoning got
//     wrong: an entry can be enabled+active while its apply() returned before doing anything.
let live = null
try {
  live = await liveLoaderRow()
  step('live_loader', live)
  failed = !check(
    'connector-entry-in-live-loader',
    live.row !== null,
    live.row === null ? { entries: live.entries } : { entryId: live.row.entryId, enabled: live.row.enabled, fiberPhase: live.row.fiberPhase },
  ) || failed
  failed = !check(
    'connector-entry-active',
    live.row !== null && live.row.fiberPhase === 'active' && live.row.enabled === true,
    live.row === null ? null : { enabled: live.row.enabled, fiberPhase: live.row.fiberPhase },
  ) || failed
} catch (error) {
  step('live_loader', { error: String(error && error.message ? error.message : error), host: HOST_URL })
  console.log('  (host not reachable at ' + HOST_URL + '; live Loader checks were not run)')
}

// (c) MCP child process.
const children = connectorChildren()
step('mcp_child', { available: children.available, matches: children.matches })
if (children.available) {
  failed = !check(
    'connector-mcp-child-running',
    children.matches.length > 0,
    children.matches.length > 0 ? children.matches : { hint: 'the connector spawns this on its first heartbeat/call' },
  ) || failed
}

// (d) presence freshness. Read before, then after one interval when the timer is configured.
const heartbeat = configuredHeartbeat()
step('configured_heartbeat', heartbeat)
failed = !check(
  'heartbeat-configured-in-profile',
  heartbeat.present === true && heartbeat.enabled === true && Boolean(heartbeat.peer) && Boolean(heartbeat.project)
    && Number.isFinite(heartbeat.ttl) && heartbeat.ttl * 1000 > heartbeat.intervalMs,
  heartbeat,
) || failed

const peerId = heartbeat.peer ?? 'dsh-memory-connector'
const peer = await readPeer(peerId)
step('peer_before', peer ?? null)
failed = !check(
  'peer-row-exists',
  peer !== null,
  peer === null ? { peer: peerId, db: CONTROL_DB } : { seen_iso: peer.seen_iso, age_seconds: peer.age_seconds, ttl: peer.ttl },
) || failed

if (noWait) {
  console.log('( --no-wait: freshness after one interval was not observed )')
} else {
  const interval = Number.isFinite(heartbeat.intervalMs) && heartbeat.intervalMs > 0 ? heartbeat.intervalMs : 30000
  const waitMs = interval + 8000
  console.log('waiting ' + Math.round(waitMs / 1000) + 's for one heartbeat interval (' + interval + 'ms) ...')
  await sleep(waitMs)
  const after = await readPeer(peerId)
  step('peer_after', after ?? null)
  failed = !check(
    'peer-seen-advances',
    after !== null && peer !== null && after.seen > peer.seen,
    after === null || peer === null ? null : { before: peer.seen_iso, after: after.seen_iso, advanced_seconds: Math.round((after.seen - peer.seen) * 10) / 10 },
  ) || failed
  failed = !check(
    'peer-connected',
    after !== null && after.connected === true,
    after === null ? null : { age_seconds: after.age_seconds, ttl: after.ttl },
  ) || failed
}

report.failed = failed
report.finished_at = new Date().toISOString()
if (jsonOut) {
  mkdirSync(path.dirname(jsonOut), { recursive: true })
  writeFileSync(jsonOut, JSON.stringify(report, null, 2), 'utf8')
  console.log('report: ' + jsonOut)
}

console.log('')
if (failed) {
  console.log('PRESENCE FAILED — see the FAIL lines above; each names one distinct cause.')
  process.exit(1)
}
console.log('PRESENCE OK: one insert row per id, connector active in the live Loader, MCP child running, peers.seen advancing.')
