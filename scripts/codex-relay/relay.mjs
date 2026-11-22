#!/usr/bin/env node
// CARD 2436459e -- dashboard relay daemon for codexSandbox=relay.
//
// Runs OUTSIDE the Codex workspace-write sandbox, spawned by the dashboard host
// (startAgentProcess). Codex also starts the MCP shim outside the command sandbox
// (measured on Codex 0.163.0, Linux). The shim holds no secret and writes one JSON
// request file per dashboard call into <relay-dir>/requests and polls for the
// matching responses/<id>.json; this daemon is the ONLY side that holds the
// agent's dashboard token, and it references that token exclusively as a FILE
// PATH -- the token's content never appears in argv, in stdout logs, or in any
// file under the relay dir. The spool lives under store/, which the relay
// profile hides from the sandbox. Plain node, no npm dependencies.

import { appendFileSync, closeSync, constants, fstatSync, lstatSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const USAGE = 'usage: relay.mjs --agent <name> --relay-dir <dir> --token-file <path> --dashboard-url <url> --audit-log <path>'
const FLAGS = ['--agent', '--relay-dir', '--token-file', '--dashboard-url', '--audit-log']
const MAX_REQUEST_FILE_BYTES = 131072
const MAX_BODY_BYTES = 65536
const RATE_WINDOW_MS = 60_000
const WRITE_LIMIT = 30
const READ_LIMIT = 60
const POLL_MS = 250
const REQUEST_TIMEOUT_MS = 30_000
const RESPONSE_TTL_MS = 10 * 60 * 1000
const REQUEST_ID = /^[A-Za-z0-9-]{1,128}$/
const METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE'])

// Request-entry names (directories the relay could not remove because they are not empty, and files the relay
// cannot claim): denied and audited once, then skipped while they stay; forgotten once they disappear from requests/.
const stuckDirs = new Set()

function parseArgv(argv) {
  const values = {}
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (!FLAGS.includes(flag)) return { error: `unknown argument: ${flag}\n${USAGE}` }
    const value = argv[i + 1]
    if (value === undefined || value === '' || FLAGS.includes(value)) return { error: `${flag} needs a value\n${USAGE}` }
    values[flag] = value
    i++
  }
  const missing = FLAGS.filter(flag => values[flag] === undefined)
  if (missing.length) return { error: `missing argument: ${missing.join(' ')}\n${USAGE}` }
  return { values }
}

const parsed = parseArgv(process.argv.slice(2))
if (parsed.error) {
  process.stderr.write(`${parsed.error}\n`)
  process.exit(2)
}

// The audit log lives OUTSIDE the sandbox; its parent directory must already exist.
const auditLogPath = parsed.values['--audit-log']
try {
  if (!statSync(dirname(auditLogPath)).isDirectory()) throw new Error('not a directory')
} catch {
  process.stderr.write(`relay: audit log directory does not exist: ${dirname(auditLogPath)}\n`)
  process.exit(1)
}

// One startup line, so an operator can tie a running relay process to its
// agent and spool from ps/log output alone. Never the token.
process.stdout.write(`relay: agent=${parsed.values['--agent']} relay-dir=${parsed.values['--relay-dir']} pid=${process.pid}\n`)

const AGENT = parsed.values['--agent']
const relayDir = parsed.values['--relay-dir']
const tokenFile = parsed.values['--token-file']
// Trailing slashes trimmed once so each request path can be appended plainly.
const dashboardUrl = parsed.values['--dashboard-url'].replace(/\/+$/, '')
const requestsDir = join(relayDir, 'requests')
const responsesDir = join(relayDir, 'responses')
// The claim directory of THIS daemon. A request is claimed by MOVING its entry here (claimRequest): the
// rename is the one step two daemons on one spool cannot both succeed at, and it happens BEFORE the
// entry is read -- the request bytes are read from the claimed copy, never from the requests/ name.
// The copy is removed again at once after the raw read, so nothing rests in here while a request is
// parsed or forwarded; the directory is removed at shutdown.
const claimedRootDir = join(relayDir, 'claimed')
const claimedDir = join(claimedRootDir, String(process.pid))

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// The spool directories must be REAL directories, never symlinks: mkdirSync
// succeeds silently when the path is an existing symlink to a directory, and
// a host process could swap responses/ (or requests/, or the relay dir
// itself) for a symlink -- every tmp-write + rename would then land outside
// the spool. The 'wx' flags protect only the final/temp NAMES, never the
// parent directory, so this is checked at startup AND at the top of every
// poll tick: any violation exits before this tick reads or writes anything.
// Fail-closed: uncollected requests then time out at the shim side, which is
// the intended availability trade.
function lstatExists(path) {
  try { lstatSync(path); return true } catch { return false }
}

function isRealDir(path) {
  try {
    const st = lstatSync(path)
    return !st.isSymbolicLink() && st.isDirectory()
  } catch {
    return false
  }
}

function assertRealDir(label, path) {
  const fail = detail => {
    process.stderr.write(`relay: ${label} is not a real directory (${detail}): ${path}\n`)
    process.exit(1)
  }
  let st
  try {
    st = lstatSync(path)
  } catch (err) {
    fail(err && err.code ? err.code : 'unreachable')
    return
  }
  if (st.isSymbolicLink()) fail('symlink')
  if (!st.isDirectory()) fail('not a directory')
}

// Atomic outcome writes: the shim polls for the file's existence, so it must
// never observe a half-written response. The temp name is unique per call and
// created EXCLUSIVELY ('wx'): even though store/ is hidden from the sandbox, a
// guessed or pre-planted path (a symlink to an outside file, say) must be
// refused, never written through. renameSync then replaces the final path's
// directory entry itself, so a symlink planted THERE is swapped out, not
// followed. On refusal this response is skipped (fail-closed): the shim times
// out and reports it, which is the safe direction.
let tmpSeq = 0
function atomicWriteJson(path, value) {
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}.${tmpSeq++}`
  try {
    writeFileSync(tmp, JSON.stringify(value), { flag: 'wx' })
  } catch (err) {
    process.stderr.write(`relay: refusing pre-existing temp path ${tmp}: ${err.message}\n`)
    return // fail-closed: skip this response, never follow a guessed path
  }
  renameSync(tmp, path)
}

// One line per request: ISO timestamp, id, method, path, status, elapsed ms.
// Never the token, the Authorization header, or the body. Method/path of an
// INVALID request are attacker-controlled text, so whitespace is collapsed to
// keep a forged newline out of the log.
function logLine(id, method, path, status, elapsedMs) {
  const flatten = value => (typeof value === 'string' ? value.replace(/\s+/g, ' ').slice(0, 200) : '-')
  const parts = [
    new Date().toISOString(),
    id ?? 'invalid',
    flatten(method),
    flatten(path),
    String(status),
    `${elapsedMs}ms`,
  ]
  process.stdout.write(`${parts.join(' ')}\n`)
}

// A request is answerable only when its id is filename-safe, its method is one
// of the four, and its path stays inside the dashboard's /api/ surface with no
// '..' anywhere. Everything else is refused before any fetch.
function parseRequest(raw) {
  let request
  try {
    request = JSON.parse(raw)
  } catch {
    return null
  }
  if (request === null || typeof request !== 'object' || Array.isArray(request)) return null
  if (typeof request.id !== 'string' || !REQUEST_ID.test(request.id)) return null
  if (!METHODS.has(request.method)) return null
  if (typeof request.path !== 'string' || !request.path.startsWith('/api/') || request.path.includes('..')) return null
  // The literal '..' check above is bypassable by percent-encoding (measured:
  // new URL('http://h/api/%2e%2e/admin').pathname === '/admin'), so the path is
  // also round-tripped through the WHATWG URL parser, which resolves encoded
  // dot segments: anything that normalizes into a DIFFERENT path is refused.
  // The query is split off first, because the shim sends path+query in one
  // field ('/api/memories?agent=x') while URL keeps only the path in
  // .pathname -- a query is not traversal, and both parts must round-trip.
  const queryAt = request.path.indexOf('?')
  const pathOnly = queryAt === -1 ? request.path : request.path.slice(0, queryAt)
  const query = queryAt === -1 ? '' : request.path.slice(queryAt)
  let normalized
  try { normalized = new URL(dashboardUrl + request.path) } catch { return null }
  if (normalized.pathname !== pathOnly || normalized.search !== query || !normalized.pathname.startsWith('/api/')) return null
  return request
}

// For the invalid-response filename: the parsed id only when it is a clean
// ^[A-Za-z0-9-]+$ string (anything else could carry a path separator), else
// 'invalid'. The response body carries the same id, or null when unusable.
function recoverId(raw) {
  try {
    const probe = JSON.parse(raw)
    if (probe !== null && typeof probe === 'object' && typeof probe.id === 'string' && REQUEST_ID.test(probe.id)) {
      return probe.id
    }
  } catch { /* no usable id */ }
  return null
}

// ---- route table / enforcement ---------------------------------------------

const STATUSES = ['planned', 'in_progress', 'waiting', 'done']
const TIERS = ['hot', 'warm', 'cold', 'shared']
const CARD_ID = /^[A-Za-z0-9_-]{1,64}$/
const MEMORY_ID = /^[1-9][0-9]{0,9}$/
const AGENT_ADDR = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}(\/[A-Za-z0-9][A-Za-z0-9_.-]{0,63})?$/
const WRITE_ROUTES = new Set(['kanban.comment', 'kanban.move', 'memory.save', 'memory.retract', 'daily.log', 'message.send'])

// Injectable clock for the limiter.
const now = () => Date.now()
const rateWindows = new Map()
function rateAllow(route) {
  const t = now()
  const limit = WRITE_ROUTES.has(route) ? WRITE_LIMIT : READ_LIMIT
  const stamps = (rateWindows.get(route) ?? []).filter(ts => ts > t - RATE_WINDOW_MS)
  rateWindows.set(route, stamps)
  if (stamps.length >= limit) return false
  stamps.push(t)
  return true
}

const bytes = value => Buffer.byteLength(value, 'utf8')
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v)

class Deny extends Error {
  constructor(status, error, reason) {
    super(error)
    this.status = status
    this.error = error
    this.reason = reason
  }
}
const schemaErr = field => new Deny(400, `schema: ${field}`, 'schema')
const tooLarge = field => new Deny(413, `too large: ${field}`, 'schema')

// Row definitions. identity: the field that must equal AGENT.
// fields: name -> check(value) that returns undefined, or throws via schemaErr/tooLarge.
const text = (max, { unit = 'bytes', required = false, nonEmpty = false } = {}) => ({
  required,
  check(name, v) {
    if (typeof v !== 'string') throw schemaErr(name)
    if (nonEmpty && v === '') throw schemaErr(name)
    if ((unit === 'bytes' ? bytes(v) : v.length) > max) throw tooLarge(name)
  },
})
const oneOf = (list, required = false) => ({
  required,
  check(name, v) { if (typeof v !== 'string' || !list.includes(v)) throw schemaErr(name) },
})
const ROWS = {
  'kanban.list': { method: 'GET', kind: 'query' },
  'kanban.comment': {
    method: 'POST', identity: 'author', exact: true,
    fields: { author: { required: true, check() {} }, content: text(8192, { required: true, nonEmpty: true }) },
  },
  'kanban.move': {
    method: 'POST', identity: 'actor',
    fields: {
      status: oneOf(STATUSES, true), actor: { required: true, check() {} },
      expected_status: oneOf(STATUSES), evidence: text(2000, { unit: 'chars' }),
    },
  },
  'memory.save': {
    method: 'POST', identity: 'agent_id',
    fields: {
      agent_id: { required: true, check() {} }, content: text(8192, { required: true, nonEmpty: true }),
      category: oneOf(TIERS), keywords: text(1024),
      supersedes: { check(name, v) {
        if (!Array.isArray(v) || v.length < 1 || v.length > 20 || !v.every(n => Number.isInteger(n) && n >= 1)) throw schemaErr(name)
      } },
      allow_duplicate: { check(name, v) { if (v !== true) throw schemaErr(name) } },
    },
  },
  'memory.search': { method: 'GET', kind: 'query' },
  'memory.retract': {
    method: 'POST', identity: 'agent_id', exact: true,
    fields: { agent_id: { required: true, check() {} } },
  },
  'daily.log': {
    method: 'POST', identity: 'agent_id', exact: true,
    fields: { agent_id: { required: true, check() {} }, content: text(8192, { required: true, nonEmpty: true }) },
  },
  'message.send': {
    method: 'POST', identity: 'from', exact: true,
    fields: {
      from: { required: true, check() {} },
      to: { required: true, check(name, v) { if (typeof v !== 'string' || !AGENT_ADDR.test(v)) throw schemaErr(name) } },
      content: text(16384, { required: true, nonEmpty: true }),
    },
  },
}

function matchRoute(method, pathname) {
  let m
  if (method === 'GET' && pathname === '/api/kanban') return { key: 'kanban.list' }
  if (method === 'GET' && pathname === '/api/memories') return { key: 'memory.search' }
  if (method === 'POST' && pathname === '/api/memories') return { key: 'memory.save' }
  if (method === 'POST' && pathname === '/api/daily-log') return { key: 'daily.log' }
  if (method === 'POST' && pathname === '/api/messages') return { key: 'message.send' }
  if (method === 'POST' && (m = /^\/api\/kanban\/([^/]+)\/comments$/.exec(pathname)) && CARD_ID.test(m[1])) return { key: 'kanban.comment', cardId: m[1] }
  if (method === 'POST' && (m = /^\/api\/kanban\/([^/]+)\/move$/.exec(pathname)) && CARD_ID.test(m[1])) return { key: 'kanban.move', cardId: m[1] }
  if (method === 'POST' && (m = /^\/api\/memories\/([^/]+)\/retract$/.exec(pathname)) && MEMORY_ID.test(m[1])) return { key: 'memory.retract', memoryId: m[1] }
  return null
}

// Identity check: a present identity field that is not AGENT.
function checkIdentity(route, query) {
  if (route.key === 'memory.search') {
    if (query.has('agent') && query.get('agent') !== AGENT) throw new Deny(403, 'identity mismatch', 'identity')
    return
  }
  const row = ROWS[route.key]
  if (!row.identity || !isObj(route.body)) return
  if (Object.hasOwn(route.body, row.identity) && route.body[row.identity] !== AGENT) throw new Deny(403, 'identity mismatch', 'identity')
}

function parseIntParam(name, raw, min, max) {
  if (!/^[0-9]{1,9}$/.test(raw)) throw schemaErr(name)
  const n = Number(raw)
  if (n < min || n > max) throw schemaErr(name)
  return n
}

// Returns { upstream: {method, path, body?}, limit? }
function validate(route, query, hasQuery) {
  const key = route.key
  const row = ROWS[key]
  const body = route.body
  if (key === 'kanban.list' || key === 'memory.search') {
    if (body !== undefined) throw schemaErr('body')
    const seen = new Set()
    for (const k of query.keys()) {
      if (seen.has(k)) throw schemaErr(k)
      seen.add(k)
    }
    const allowed = key === 'kanban.list' ? ['status', 'limit'] : ['agent', 'q', 'mode', 'category', 'limit']
    for (const k of seen) if (!allowed.includes(k)) throw schemaErr(k)
    if (key === 'kanban.list') {
      const status = query.get('status')
      if (status !== null && !STATUSES.includes(status)) throw schemaErr('status')
      const limit = query.has('limit') ? parseIntParam('limit', query.get('limit'), 1, 500) : undefined
      const qs = new URLSearchParams({ assignee: AGENT })
      if (status !== null) qs.set('status', status)
      return { upstream: { method: 'GET', path: `/api/kanban?${qs.toString()}` }, limit }
    }
    if (!query.has('agent')) throw schemaErr('agent')
    const out = new URLSearchParams()
    out.set('agent', AGENT)
    if (query.has('q')) {
      if (bytes(query.get('q')) > 512) throw tooLarge('q')
      out.set('q', query.get('q'))
    }
    if (query.has('mode')) {
      if (!['fts', 'hybrid'].includes(query.get('mode'))) throw schemaErr('mode')
      out.set('mode', query.get('mode'))
    }
    if (query.has('category')) {
      if (!TIERS.includes(query.get('category'))) throw schemaErr('category')
      out.set('category', query.get('category'))
    }
    if (query.has('limit')) out.set('limit', String(parseIntParam('limit', query.get('limit'), 1, 200)))
    return { upstream: { method: 'GET', path: `/api/memories?${out.toString()}` } }
  }
  // write rows
  if (hasQuery) throw schemaErr('query')
  if (!isObj(body)) throw schemaErr('body')
  for (const k of Object.keys(body)) if (!Object.hasOwn(row.fields, k)) throw schemaErr(k)
  for (const [name, def] of Object.entries(row.fields)) {
    if (!Object.hasOwn(body, name)) {
      if (def.required) throw schemaErr(name)
      continue
    }
    def.check(name, body[name])
  }
  const clean = {}
  for (const k of Object.keys(body)) clean[k] = body[k]
  let path
  switch (key) {
    case 'kanban.comment': path = `/api/kanban/${route.cardId}/comments`; break
    case 'kanban.move': path = `/api/kanban/${route.cardId}/move`; break
    case 'memory.save': path = '/api/memories'; break
    case 'memory.retract': path = `/api/memories/${route.memoryId}/retract`; break
    case 'daily.log': path = '/api/daily-log'; break
    default: path = key === 'message.send' ? '/api/messages' : ''
  }
  return { upstream: { method: 'POST', path, body: clean } }
}

function readToken() {
  // Read FRESH each request, so token rotation needs no restart.
  try {
    return readFileSync(tokenFile, 'utf-8').trim()
  } catch { return '' /* unreachable token file: the dashboard answers 401 */ }
}

// One upstream call with the shared timeout/abort/504/status-0 handling.
async function callDashboard(method, path, body) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(dashboardUrl + path, {
      method,
      headers: { Authorization: `Bearer ${readToken()}`, 'Content-Type': 'application/json' },
      body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify(body),
      signal: controller.signal,
    })
    const text = await response.text()
    let parsedBody = text
    try { parsedBody = JSON.parse(text) } catch { /* raw text */ }
    return { status: response.status, body: parsedBody }
  } catch (err) {
    if (controller.signal.aborted || (err && err.name === 'AbortError')) return { status: 504, error: 'timeout' }
    return { status: 0, error: err instanceof Error ? err.message : String(err) }
  } finally {
    clearTimeout(timer)
  }
}

function auditLine(entry) {
  const flat = typeof entry.path === 'string' ? entry.path.replace(/\s+/g, ' ').slice(0, 200) : null
  const line = {
    ts: new Date().toISOString(),
    agent: AGENT,
    id: typeof entry.id === 'string' && REQUEST_ID.test(entry.id) ? entry.id : null,
    method: METHODS.has(entry.method) ? entry.method : null,
    route: entry.route ?? null,
    path: flat,
    decision: entry.reason ? 'denied' : 'forwarded',
    reason: entry.reason ?? null,
    status: entry.status,
    ms: entry.ms,
  }
  try {
    appendFileSync(auditLogPath, `${JSON.stringify(line)}\n`, { mode: 0o600 })
  } catch (err) {
    process.stderr.write(`relay: cannot write audit log: ${err instanceof Error ? err.message : String(err)}\n`)
  }
}

const pathnameOf = p => (typeof p === 'string' ? p.split('?')[0] : null)

async function handleRequestFile(fileName) {
  const requestPath = join(requestsDir, fileName)
  const claimedPath = join(claimedDir, fileName)
  const started = Date.now()
  // Removes the CLAIMED copy only. After a successful claim the requests/ name was consumed by the claim
  // rename itself and may already hold a NEWER request: nothing in this handler ever unlinks that name again.
  const removeClaimed = () => {
    try {
      unlinkSync(claimedPath)
    } catch (err) {
      if (err && err.code !== 'ENOENT') {
        if (!stuckDirs.has(fileName)) process.stderr.write(`relay: cannot remove claimed request ${fileName}: ${err instanceof Error ? err.message : String(err)}\n`)
      }
    }
  }
  // An entry the relay cannot remove keeps resting at its requests/ name: the claimed copy is moved BACK.
  // The restore never forwards anything, so it cannot reintroduce the stale-read race, and it is
  // NON-DESTRUCTIVE by construction (dual review R2 blocker): a plain renameSync would silently REPLACE
  // a request a writer re-created at the freed requests/<fileName> name in the window (renaming a file
  // onto a file overwrites the destination). A regular file therefore goes back by hard link:
  // linkSync refuses (EEXIST) when the name is already taken -- the writer's entry keeps the name and
  // the copy stays in the claimed directory (one stderr line, gated by stuckDirs). A directory cannot
  // be hard-linked, but renaming one cannot destroy data either: onto a re-created FILE the rename
  // fails with ENOTDIR, onto a non-empty directory with ENOTEMPTY.
  const restoreClaimed = () => {
    try {
      let isDir = false
      try { isDir = lstatSync(claimedPath).isDirectory() } catch { return /* the copy is gone: nothing to restore */ }
      if (isDir) {
        renameSync(claimedPath, requestPath)
      } else {
        linkSync(claimedPath, requestPath)
        unlinkSync(claimedPath)
      }
    } catch (err) {
      if (!stuckDirs.has(fileName)) process.stderr.write(`relay: cannot restore request ${fileName}: ${err instanceof Error ? err.message : String(err)}\n`)
    }
  }
  // The claim MOVES the request entry into this daemon's claimed directory, and it is the FIRST action of
  // this handler -- before a single byte of the request is read. rename is atomic on every platform;
  // unlink is not (PR #2652 review C2: two daemons on one spool on macOS both got the claim of one name
  // and both forwarded). Of two renames of one name exactly one succeeds, the loser gets ENOENT. Taking
  // ownership of the NAME before reading is what closes the stale-read ABA hole of the old
  // read-then-claim order (#2652 review C2 / dual-review R1 blocker A3): the read pipeline below takes
  // the bytes from the CLAIMED copy -- the entry this renamer owns -- so a writer re-creating
  // requests/<fileName> the instant the claim frees that name only ever places a NEW entry at that name.
  // Reading strictly after the claim, from the copy, makes a stale read of a since-replaced requests/
  // entry impossible; the old order let the claim loser forward bytes it had read from the ORIGINAL
  // entry while holding the NEW one (original forwarded twice, new one lost).
  // claimedPath = claimed, null = lost (another handler owns the request), false = the relay cannot move the entry.
  const claimRequest = () => {
    try {
      renameSync(requestPath, claimedPath)
    } catch (err) {
      if (err && err.code === 'ENOENT') return null // another handler owns the request
      // One rename failure is not worth an operator line: Linux refuses to rename a DIRECTORY the
      // relay cannot write (the rename must update the moved directory's own `..` entry), so a
      // mode-000 directory cannot be claimed even though requests/ itself is writable. The caller
      // denies such an entry in place, silently -- and an entry that vanished with the attempt is
      // equally not reportable.
      let st = null
      try { st = lstatSync(requestPath) } catch { /* gone: nothing to report */ }
      if (!st || st.isDirectory()) return false
      if (!stuckDirs.has(fileName)) process.stderr.write(`relay: cannot claim request ${fileName}: ${err.message}\n`)
      return false
    }
    return claimedPath
  }
  const writeResponse = (name, value) => {
    try {
      atomicWriteJson(join(responsesDir, `${name}.json`), value)
    } catch (err) {
      process.stderr.write(`relay: cannot write response ${name}: ${err instanceof Error ? err.message : String(err)}\n`)
    }
  }
  const finishDenied = (id, method, path, routeKey, status, error, reason) => {
    writeResponse(id || 'invalid', { id: id ?? null, status, error })
    removeClaimed() // the CLAIMED COPY, never the requests/ name: the claim rename already consumed it
    logLine(id, method, path, status, Date.now() - started)
    auditLine({ id, method, route: routeKey, path: pathnameOf(path), reason, status, ms: Date.now() - started })
  }

  const stem = fileName.replace(/\.json$/, '')
  const stemId = REQUEST_ID.test(stem) ? stem : null

  // Claim FIRST (see claimRequest above): only the winner of the rename may read the entry.
  const claimOk = claimRequest()
  if (claimOk === null) return // the name is another handler's: skip silently, no response, no audit
  if (!claimOk) {
    // A DIRECTORY the rename cannot take (see claimRequest above) is the one entry kind that was never
    // claimable at all, before the claim-first order or now: it is denied IN PLACE, at its requests/
    // name -- removed when empty, otherwise denied and audited once, then skipped while it stays. It is
    // never forwarded, so this lane cannot reintroduce the stale-read race the claim-first order fixes.
    let entry = null
    try { entry = lstatSync(requestPath) } catch { /* vanished with the rename attempt */ }
    if (!entry) return // nothing there anymore: nothing to deny
    if (entry.isDirectory()) {
      if (stuckDirs.has(fileName)) return // denied and audited on an earlier tick: skip while it stays
      try {
        rmdirSync(requestPath)
      } catch {
        stuckDirs.add(fileName)
      }
      finishDenied(stemId, null, null, null, 400, 'invalid request', 'invalid')
      return
    }
    // The relay cannot move the request: never forward it (it would be forwarded again on every tick); deny and
    // audit it once, then skip it while it stays.
    if (stuckDirs.has(fileName)) return
    stuckDirs.add(fileName)
    finishDenied(stemId, null, null, null, 500, 'request not claimable', 'unclaimable')
    return
  }

  // Everything below reads the CLAIMED copy, never the requests/ name: the bytes answered are exactly
  // the bytes the claim rename took ownership of.
  let fd
  try {
    fd = openSync(claimedPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (err) {
    if (err && err.code === 'ENOENT') return // already gone
    if (stuckDirs.has(fileName)) {
      // Denied and audited on an earlier tick: put the entry back and skip it while it stays.
      restoreClaimed()
      return
    }
    try {
      unlinkSync(claimedPath)
    } catch (err2) {
      if (err2 && err2.code === 'ENOENT') return
      if (!(err2 && (err2.code === 'EISDIR' || err2.code === 'EPERM'))) {
        process.stderr.write(`relay: cannot remove request ${fileName}: ${err2 instanceof Error ? err2.message : String(err2)}\n`)
        restoreClaimed()
        return
      }
      // A directory the relay cannot open (e.g. mode 000): the same rule as a readable one -- removed when empty,
      // otherwise denied and audited once, then skipped while it stays (resting at its requests/ name again).
      try {
        rmdirSync(claimedPath)
      } catch {
        stuckDirs.add(fileName)
        restoreClaimed()
        finishDenied(stemId, null, null, null, 400, 'invalid request', 'invalid')
        return
      }
    }
    finishDenied(stemId, null, null, null, 400, 'invalid request', 'invalid')
    return
  }
  let raw
  try {
    const st = fstatSync(fd)
    if (!st.isFile() || st.nlink !== 1) {
      closeSync(fd)
      fd = undefined
      if (st.isDirectory()) {
        // A directory entry: removed when empty, otherwise denied and audited once, then skipped while
        // it rests at its requests/ name.
        try {
          rmdirSync(claimedPath)
        } catch {
          if (stuckDirs.has(fileName)) {
            restoreClaimed()
            return
          }
          stuckDirs.add(fileName)
          restoreClaimed()
          finishDenied(stemId, null, null, null, 400, 'invalid request', 'invalid')
          return
        }
        finishDenied(stemId, null, null, null, 400, 'invalid request', 'invalid')
        return
      }
      // Hard link, FIFO, ... : the claimed copy is unlinked best effort (finishDenied's removal step);
      // an outside original a hard link points at survives with its own name.
      finishDenied(stemId, null, null, null, 400, 'invalid request', 'invalid')
      return
    }
    if (st.size > MAX_REQUEST_FILE_BYTES) {
      closeSync(fd)
      fd = undefined
      finishDenied(stemId, null, null, null, 413, 'request too large', 'too-large')
      return
    }
    const buf = Buffer.alloc(MAX_REQUEST_FILE_BYTES + 1)
    let n = 0
    while (n < buf.length) {
      const got = readSync(fd, buf, n, buf.length - n, null)
      if (got === 0) break
      n += got
    }
    if (n > MAX_REQUEST_FILE_BYTES) {
      closeSync(fd)
      fd = undefined
      finishDenied(stemId, null, null, null, 413, 'request too large', 'too-large')
      return
    }
    raw = buf.toString('utf8', 0, n)
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
  // The raw bytes are in hand: the claimed copy is removed AT ONCE, before parse/forward, so nothing
  // rests in the claimed directory while the request is in flight (every removal step of the deny and
  // success paths below is a no-op). The requests/ name is never touched again: the claim already
  // consumed it, and it may already hold a NEWER request.
  removeClaimed()
  const request = parseRequest(raw)
  if (!request) {
    let method = null
    let path = null
    try {
      const probe = JSON.parse(raw)
      if (probe !== null && typeof probe === 'object') {
        if (typeof probe.method === 'string') method = probe.method
        if (typeof probe.path === 'string') path = probe.path
      }
    } catch { /* log placeholders */ }
    finishDenied(recoverId(raw), method, path, null, 400, 'invalid request', 'invalid')
    return
  }

  const queryAt = request.path.indexOf('?')
  const pathname = queryAt === -1 ? request.path : request.path.slice(0, queryAt)
  const hasQuery = queryAt !== -1
  const query = new URLSearchParams(hasQuery ? request.path.slice(queryAt + 1) : '')
  const deny = (routeKey, status, error, reason) => finishDenied(request.id, request.method, pathname, routeKey, status, error, reason)

  const route = matchRoute(request.method, pathname)
  if (!route) return deny(null, 403, 'endpoint not allowed', 'off-list')
  route.body = request.body
  let bodyTooBig = false
  try {
    bodyTooBig = bytes(JSON.stringify(request.body ?? null)) > MAX_BODY_BYTES
  } catch {
    bodyTooBig = true
  }
  if (bodyTooBig) return deny(route.key, 413, 'body too large', 'too-large')
  if (!rateAllow(route.key)) return deny(route.key, 429, 'rate limited', 'rate')

  let plan
  try {
    checkIdentity(route, query)
    plan = validate(route, query, hasQuery)
  } catch (err) {
    if (err instanceof Deny) return deny(route.key, err.status, err.error, err.reason)
    throw err
  }

  if (route.cardId) {
    const card = await callDashboard('GET', `/api/kanban/${route.cardId}`)
    const own = card.status === 200 && isObj(card.body) && String(card.body.assignee).toLowerCase() === AGENT.toLowerCase()
    if (!own) return deny(route.key, 403, 'not your card', 'not-own-card')
  }

  const result = await callDashboard(plan.upstream.method, plan.upstream.path, plan.upstream.body)
  const outcome = { id: request.id, ...result }
  if (route.key === 'kanban.list' && result.status === 200 && Array.isArray(result.body)) {
    let items = result.body.filter(item => isObj(item) && String(item.assignee).toLowerCase() === AGENT.toLowerCase())
    if (plan.limit !== undefined) items = items.slice(0, plan.limit)
    outcome.body = items
  }
  writeResponse(request.id, outcome)
  // Nothing left to remove: the claimed copy went away right after the raw read, and the requests/
  // name was consumed by the claim rename itself.
  const ms = Date.now() - started
  logLine(request.id, request.method, request.path, outcome.status, ms)
  auditLine({ id: request.id, method: request.method, route: route.key, path: pathname, reason: null, status: outcome.status, ms })
}

// Once per loop: responses the shim never collected must not pile up forever.
function cleanStaleResponses() {
  let files
  try {
    files = readdirSync(responsesDir)
  } catch {
    return
  }
  const cutoff = Date.now() - RESPONSE_TTL_MS
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    const path = join(responsesDir, file)
    try {
      if (statSync(path).mtimeMs < cutoff) unlinkSync(path)
    } catch { /* ENOENT: raced with the shim collecting it */ }
  }
}

function shutdown() {
  try {
    unlinkSync(join(relayDir, 'relay.ready'))
  } catch (err) {
    if (err && err.code !== 'ENOENT') throw err
  }
  // The claimed directory is empty by now; it is removed so the directories of stopped daemons do not pile
  // up. lstat first: a swapped path is left alone, never followed.
  if (isRealDir(claimedRootDir) && isRealDir(claimedDir)) {
    try {
      rmdirSync(claimedDir)
    } catch { /* not empty or already gone: inert, nothing in it is read */ }
  }
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

assertRealDir('relay root', dirname(relayDir))
// A not-yet-created relay dir is fine here (the mkdir below makes it, then the gate re-checks).
if (lstatExists(relayDir)) assertRealDir('relay dir', relayDir)
mkdirSync(requestsDir, { recursive: true })
mkdirSync(responsesDir, { recursive: true })
// Unlike requests/ and responses/, the claimed spool dir sits one level BELOW its root (claimed/<pid>/), and
// mkdirSync recursive happily creates through a symlinked root. The per-pid dir is therefore only made
// inside a real claimed root: a swapped root is never written through, the gate below refuses it instead.
if (!lstatExists(claimedRootDir) || isRealDir(claimedRootDir)) {
  mkdirSync(claimedDir, { recursive: true, mode: 0o700 })
}
// Startup sanity gate: every spool dir must be a real directory BEFORE the
// ready marker is written -- a symlinked spool never becomes "ready".
// The relay root (parent of the relay dir) is checked too.
assertRealDir('relay dir', relayDir)
assertRealDir('requests dir', requestsDir)
assertRealDir('responses dir', responsesDir)
assertRealDir('claimed root', claimedRootDir)
assertRealDir('claimed dir', claimedDir)
// Ready marker: drop any stale one, then create ours EXCLUSIVELY, with this
// daemon's pid as the content -- the starter counts the marker as proof of
// readiness only when it names the pid it spawned. 'wx' refuses a marker
// somebody pre-created in the relay dir (a plain file or a
// symlink), which fail-closes the daemon instead of silently adopting it.
try { unlinkSync(join(relayDir, 'relay.ready')) } catch { /* ENOENT fine */ }
try {
  writeFileSync(join(relayDir, 'relay.ready'), String(process.pid), { flag: 'wx' })
} catch (err) {
  process.stderr.write(`relay: cannot create relay.ready: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
}

for (;;) {
  // Re-verify on EVERY tick, before this tick reads or writes anything: the
  // host could swap a spool dir for a symlink at any moment, and a single
  // unchecked tick would write outside the spool.
  assertRealDir('relay root', dirname(relayDir))
  assertRealDir('relay dir', relayDir)
  assertRealDir('requests dir', requestsDir)
  assertRealDir('responses dir', responsesDir)
  assertRealDir('claimed root', claimedRootDir)
  assertRealDir('claimed dir', claimedDir)
  let files = []
  try {
    files = readdirSync(requestsDir).filter(file => file.endsWith('.json')).sort()
  } catch { /* requests dir vanished; retry next tick */ }
  for (const name of stuckDirs) if (!files.includes(name)) stuckDirs.delete(name)
  for (const file of files) {
    try {
      await handleRequestFile(file)
    } catch (err) {
      process.stderr.write(`relay: handling ${file} failed: ${err instanceof Error ? err.message : String(err)}\n`)
    }
  }
  cleanStaleResponses()
  await sleep(POLL_MS)
}
