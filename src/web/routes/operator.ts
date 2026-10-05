// /api/operator/* -- the IT operator's surface (DASHOPERATOR1005 PR-3).
//
// What the operator can do is the OWNER's decision (store/operator-access.json,
// routes/operator-access.ts); the gate in web.ts keeps an operator credential
// on these paths and off every other one. This file is the other half:
//
// - every endpoint answers an OPERATOR credential only. The owner has the full
//   dashboard; serving the owner here as well would only blur who did what;
// - every capability endpoint re-reads the owner's switch on each call, so
//   turning a switch off takes effect on the operator's very next request;
// - responses are projections onto named fields. A field added to an agent row
//   or a status row upstream does not reach the operator until it is listed
//   here -- the same deny-by-default as the gate;
// - nothing here returns a vault VALUE; the vault is write-only for the operator;
// - every write lands in config_change_log with the operator key's name, and a
//   vault write also tells the owner (which secret, who, when -- never the value);
// - an unknown /api/operator/* path is a 404 HERE, so it can never fall
//   through to an owner route further down the dispatch chain.
//
// Where an owner endpoint already does the job (agent start/stop/restart,
// update check/apply, the pane stream), the request is forwarded to that one
// handler with a fixed path built here, so the two surfaces cannot drift. A
// forwarded WRITE carries an empty body: the owner's options on those routes
// (a fresh restart, an auto-stash update) stay the owner's.

import http from 'node:http'
import os from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { DASHBOARD_PUBLIC_URL, WEB_HOST } from '../../config.js'
import { logConfigChange } from '../../db.js'
import { logger } from '../../logger.js'
import { notifySecurityEvent } from '../../notify.js'
import { getDeviceKey, resolveDeviceKey } from '../auth-device-keys.js'
import { parseCookies } from '../auth-gate.js'
import { isKnownAgent, readAgentRemoteHost } from '../agent-config.js'
import { agentSessionName, capturePane, isAgentRunning, sendPromptToSession } from '../agent-process.js'
import { json, readBody, serveFile } from '../http-helpers.js'
import { checkThrottle, recordFailure, recordSuccess } from '../login-throttle.js'
import { isMainChannelsAgent, MAIN_CHANNELS_SESSION } from '../main-agent.js'
import { detectLanIp } from '../network-info.js'
import {
  OPERATOR_COMMANDS,
  readOperatorAccess,
  type OperatorAccess,
  type OperatorCapability,
  type OperatorCommand,
} from '../operator-access.js'
import { OPERATOR_API_PREFIX } from '../operator-gate.js'
import { createOperatorSession, OPERATOR_COOKIE_NAME, revokeOperatorSession } from '../operator-sessions.js'
import type { QuotaSnapshot, QuotaWindow } from '../quota.js'
import { getSystemStatus, type SystemStatus } from '../system-status.js'
import { getUpdateStatus, refreshUpdateStatus, type UpdateStatus } from '../update-checker.js'
import { listSecrets, setSecret } from '../vault.js'
import { syncSecret } from '../vault-bindings.js'
import { listAgentSummaries, tryHandleAgents, type AgentSummary } from './agents.js'
import { tryHandleAgentTerminal } from './agent-terminal.js'
import { isHttps } from './auth.js'
import { readFleetQuota } from './overview.js'
import { tryHandleUpdates } from './updates.js'
import type { RouteContext } from './types.js'

const LOGIN_BODY_MAX_BYTES = 8 * 1024
const VAULT_BODY_MAX_BYTES = 32 * 1024
const AGENT_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/
const VAULT_ID_RE = /^[A-Za-z0-9._-]{1,128}$/
// The SSH key pool owns these entries (routes/vault-ssh-keys.ts); the generic
// owner vault list hides them too.
const SSH_KEY_PREFIX = 'ssh-key-'

/** What the server types into the pane for each allowed command. Fixed: the operator sends a name, never text. */
export const OPERATOR_COMMAND_TEXT: Record<OperatorCommand, string> = {
  login: '/login',
  mcp: '/mcp',
}

// ---------------------------------------------------------------------------
// Projections (pure, exported for the tests)
// ---------------------------------------------------------------------------

export const OPERATOR_AGENT_FIELDS = [
  'name', 'displayName', 'running', 'runState', 'model', 'activeModel', 'runningSince', 'contextTokens', 'needsReauth',
] as const

export function projectAgentRow(a: AgentSummary): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const f of OPERATOR_AGENT_FIELDS) out[f] = a[f] ?? null
  return out
}

export function projectUpdateStatus(u: UpdateStatus): Record<string, unknown> {
  return {
    version: u.version ?? null,
    current: u.current,
    latest: u.latest,
    behind: u.behind,
    branch: u.branch ?? null,
    lastChecked: u.lastChecked,
    // The text can carry git output (remote URLs); the operator learns THAT the check failed.
    checkFailed: Boolean(u.error),
  }
}

function projectWindow(w: QuotaWindow | null): Record<string, unknown> | null {
  return w ? { usedPercentage: w.usedPercentage, resetsAt: w.resetsAt, expired: w.expired } : null
}

/** The fleet quota without the agents the readings came from (neither the list nor the per-window name). */
export function projectQuota(q: QuotaSnapshot): Record<string, unknown> {
  return { status: q.status, ageSec: q.ageSec, fiveHour: projectWindow(q.fiveHour), sevenDay: projectWindow(q.sevenDay), source: q.source ?? null }
}

// The system-status rows the operator sees, by block title and row label. Left
// out: CSATORNA/Párosítás (bot name + the owner's chat id) and
// ÜTEMEZŐ/Következő (names the owner's tasks). A new upstream row stays hidden
// until it is listed here.
export const OPERATOR_HEALTH_ROWS: Readonly<Record<string, readonly string[]>> = {
  'MARVEEN': ['Verzió', 'Fő session', 'Dashboard', 'Modell', 'Fallback', 'Auth', 'Kontextus', 'Cache'],
  'KERET': ['5 órás', 'Heti', 'Előfizetés'],
  'ÜTEMEZŐ (24 óra)': ['Körök'],
  'CSATORNA': ['Forgalom', 'Telegram plugin-patch', 'Hiba-napló (24 óra)'],
  'RENDSZER': ['Claude Code', 'Tárhely'],
}

export function projectSystemStatus(s: SystemStatus): Array<{ title: string; rows: Array<{ label: string; value: string | null; error?: string }> }> {
  const out: Array<{ title: string; rows: Array<{ label: string; value: string | null; error?: string }> }> = []
  for (const block of s.blocks) {
    const allowed = OPERATOR_HEALTH_ROWS[block.title]
    if (!allowed) continue
    const rows = block.rows
      .filter(r => allowed.includes(r.label))
      .map(r => (r.error ? { label: r.label, value: r.value, error: r.error } : { label: r.label, value: r.value }))
    if (rows.length > 0) out.push({ title: block.title, rows })
  }
  return out
}

function hostResources(): Record<string, unknown> {
  return {
    platform: process.platform,
    arch: process.arch,
    uptimeSec: Math.floor(os.uptime()),
    loadAvg: os.loadavg().map(n => Math.round(n * 100) / 100),
    cpus: os.cpus().length,
    totalMemMb: Math.round(os.totalmem() / 1048576),
    freeMemMb: Math.round(os.freemem() / 1048576),
  }
}

function networkInfo(): Record<string, unknown> {
  return {
    bindHost: WEB_HOST,
    lanIp: detectLanIp(),
    publicUrlConfigured: DASHBOARD_PUBLIC_URL !== '',
    // No Tailscale probe exists in the dashboard yet; say so rather than guess.
    tailscale: 'not-measured',
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function operatorCookie(token: string, maxAgeSec: number, req: http.IncomingMessage): string {
  const base = `${OPERATOR_COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSec}`
  return isHttps(req) ? `${base}; Secure` : base
}

function clearOperatorCookie(req: http.IncomingMessage): string {
  return operatorCookie('', 0, req)
}

function noStore(res: http.ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store', ...extra })
  res.end(JSON.stringify(body))
}

/** A request with the original headers and socket but no body (forwarded writes, see the file header). */
function emptyBodyRequest(req: http.IncomingMessage): http.IncomingMessage {
  const fake = Readable.from([]) as unknown as http.IncomingMessage
  Object.assign(fake, { headers: req.headers, method: req.method, url: req.url, socket: req.socket })
  return fake
}

function actorOf(ctx: RouteContext): string {
  return `operator:${ctx.auth?.device ?? '?'}#${ctx.auth?.deviceId ?? '?'}`
}

function audit(ctx: RouteContext, action: string, target: string): void {
  logConfigChange(`operator:${action}`, null, target, actorOf(ctx))
  logger.info({ action, target, operator: ctx.auth?.device, deviceId: ctx.auth?.deviceId }, 'operator action')
}

function requireCapability(ctx: RouteContext, access: OperatorAccess, cap: OperatorCapability): boolean {
  if (access.capabilities[cap]) return true
  json(ctx.res, { error: 'Not allowed by the owner', capability: cap }, 403)
  return false
}

/** A known agent named in the path, or null after answering 404. */
function agentFromPath(ctx: RouteContext, raw: string): string | null {
  let name: string
  try { name = decodeURIComponent(raw) } catch { name = '' }
  if (!AGENT_NAME_RE.test(name) || !isKnownAgent(name)) {
    json(ctx.res, { error: 'Agent not found' }, 404)
    return null
  }
  return name
}

async function forward(ctx: RouteContext, path: string, handler: (c: RouteContext) => Promise<boolean>, opts: { keepBody?: boolean } = {}): Promise<void> {
  const req = opts.keepBody ? ctx.req : emptyBodyRequest(ctx.req)
  const handled = await handler({ ...ctx, req, path })
  if (!handled) json(ctx.res, { error: 'Not available' }, 500)
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export async function tryHandleOperator(ctx: RouteContext, webDir: string): Promise<boolean> {
  const { req, res, path, method } = ctx

  // The operator page. Public like every static file: it holds no data, and
  // everything it shows comes from the gated endpoints below.
  if ((path === '/operator' || path === '/operator.html') && (method === 'GET' || method === 'HEAD')) {
    serveFile(req, res, join(webDir, 'operator.html'))
    return true
  }
  if (path === '/operator.js' && method === 'GET') {
    serveFile(req, res, join(webDir, 'operator.js'))
    return true
  }

  if (!path.startsWith(OPERATOR_API_PREFIX)) return false

  // --- login (public: requiresAuth lets it through without a credential) ---
  if (path === '/api/operator/login') {
    if (method !== 'POST') { json(res, { error: 'Method not allowed' }, 405); return true }
    const bucket = `operator:${req.socket?.remoteAddress ?? 'unknown'}`
    const throttle = checkThrottle(bucket)
    if (throttle.locked) {
      noStore(res, 429, { error: 'Too many attempts', retry_after_s: throttle.retryAfterS }, { 'Retry-After': String(throttle.retryAfterS) })
      return true
    }
    let key = ''
    try {
      const parsed = JSON.parse((await readBody(req, { maxBytes: LOGIN_BODY_MAX_BYTES })).toString() || '{}') as { key?: unknown }
      key = typeof parsed.key === 'string' ? parsed.key.trim() : ''
    } catch {
      json(res, { error: 'Invalid JSON' }, 400)
      return true
    }
    if (!readOperatorAccess().enabled) {
      noStore(res, 403, { error: 'Operator access is turned off by the owner' })
      return true
    }
    const dk = key ? resolveDeviceKey(key) : null
    // A full-scope key is refused here too: this login only ever mints an operator session.
    const info = dk && dk.scope === 'operator' ? getDeviceKey(dk.id) : null
    if (!dk || !info) {
      recordFailure(bucket)
      noStore(res, 401, { error: 'Invalid credentials' })
      return true
    }
    recordSuccess(bucket)
    const presented = parseCookies(req.headers.cookie)[OPERATOR_COOKIE_NAME]
    if (presented) revokeOperatorSession(presented)
    const session = createOperatorSession(info.id, info.expiresAt)
    logConfigChange('operator:login', null, info.name, `operator:${info.name}#${info.id}`)
    noStore(res, 200, { ok: true, device: info.name, expires_at: info.expiresAt }, { 'Set-Cookie': operatorCookie(session.token, session.maxAgeSec, req) })
    return true
  }

  // Everything below answers an operator credential only (see the file header).
  if (ctx.auth?.kind !== 'device' || ctx.auth.scope !== 'operator') {
    json(res, { error: 'Operator credential required' }, 403)
    return true
  }
  const access = readOperatorAccess()

  if (path === '/api/operator/logout' && method === 'POST') {
    const presented = parseCookies(req.headers.cookie)[OPERATOR_COOKIE_NAME]
    if (presented) revokeOperatorSession(presented)
    noStore(res, 200, { ok: true }, { 'Set-Cookie': clearOperatorCookie(req) })
    return true
  }

  if (path === '/api/operator/me' && method === 'GET') {
    const key = ctx.auth.deviceId !== undefined ? getDeviceKey(ctx.auth.deviceId) : null
    json(res, {
      device: ctx.auth.device ?? null,
      expires_at: key?.expiresAt ?? null,
      capabilities: access.capabilities,
      commands: access.capabilities.commands ? access.commands : [],
    })
    return true
  }

  if (path === '/api/operator/status' && method === 'GET') {
    let health: ReturnType<typeof projectSystemStatus> | { error: string }
    try {
      health = projectSystemStatus(await getSystemStatus())
    } catch (err) {
      health = { error: err instanceof Error ? err.message : String(err) }
    }
    json(res, {
      agents: listAgentSummaries().map(projectAgentRow),
      update: projectUpdateStatus(getUpdateStatus()),
      quota: projectQuota(readFleetQuota(Math.floor(Date.now() / 1000))),
      host: hostResources(),
      network: networkInfo(),
      health,
    })
    return true
  }

  // --- agent control: start / stop / restart ---
  const controlMatch = path.match(/^\/api\/operator\/agents\/([^/]+)\/(start|stop|restart)$/)
  if (controlMatch && method === 'POST') {
    if (!requireCapability(ctx, access, 'agentControl')) return true
    const name = agentFromPath(ctx, controlMatch[1]!)
    if (!name) return true
    const action = controlMatch[2]!
    audit(ctx, `agent-${action}`, name)
    await forward(ctx, `/api/agents/${encodeURIComponent(name)}/${action}`, c => tryHandleAgents(c, webDir))
    return true
  }

  // --- updates: check / apply ---
  const updateMatch = path.match(/^\/api\/operator\/updates\/(check|apply)$/)
  if (updateMatch && method === 'POST') {
    if (!requireCapability(ctx, access, 'update')) return true
    const action = updateMatch[1]!
    audit(ctx, `update-${action}`, 'dashboard')
    if (action === 'check') {
      // The owner route answers the full status (commit messages included); the operator gets the projection.
      json(res, projectUpdateStatus(await refreshUpdateStatus()))
      return true
    }
    await forward(ctx, '/api/updates/apply', tryHandleUpdates)
    return true
  }

  // --- vault: names and dates only; write-only for values ---
  if (path === '/api/operator/vault' && method === 'GET') {
    if (!requireCapability(ctx, access, 'vaultWrite')) return true
    json(res, {
      secrets: listSecrets()
        .filter(s => !s.id.startsWith(SSH_KEY_PREFIX))
        .map(s => ({ id: s.id, label: s.label, createdAt: s.createdAt, updatedAt: s.updatedAt })),
    })
    return true
  }
  const vaultMatch = path.match(/^\/api\/operator\/vault\/([^/]+)$/)
  if (vaultMatch && method === 'PUT') {
    if (!requireCapability(ctx, access, 'vaultWrite')) return true
    let id = ''
    try { id = decodeURIComponent(vaultMatch[1]!) } catch { /* rejected below */ }
    if (!VAULT_ID_RE.test(id) || id.startsWith(SSH_KEY_PREFIX)) {
      json(res, { error: 'Invalid secret id' }, 400)
      return true
    }
    let value: unknown
    let label: unknown
    try {
      const parsed = JSON.parse((await readBody(req, { maxBytes: VAULT_BODY_MAX_BYTES })).toString() || '{}') as { value?: unknown; label?: unknown }
      value = parsed.value
      label = parsed.label
    } catch {
      json(res, { error: 'Invalid JSON' }, 400)
      return true
    }
    if (typeof value !== 'string' || value.length === 0) {
      json(res, { error: 'value (non-empty string) required' }, 400)
      return true
    }
    const existing = listSecrets().find(s => s.id === id)
    const finalLabel = typeof label === 'string' && label.trim() ? label.trim().slice(0, 200) : (existing?.label ?? id)
    setSecret(id, finalLabel, value)
    const sync = syncSecret(id)
    audit(ctx, existing ? 'vault-overwrite' : 'vault-create', id)
    const when = new Date().toLocaleString('hu-HU')
    void notifySecurityEvent(`Üzemeltetői vault-írás: "${id}" ${existing ? 'felülírva' : 'létrehozva'}, kulcs: ${ctx.auth.device ?? '?'}, ${when}. (Az érték nem kerül az értesítésbe.)`)
    // The value is never echoed back.
    json(res, { ok: true, id, created: !existing, synced: sync.updated })
    return true
  }

  // --- pane view (read-only stream) ---
  const paneMatch = path.match(/^\/api\/operator\/agents\/([^/]+)\/pane\/stream$/)
  if (paneMatch && method === 'GET') {
    if (!requireCapability(ctx, access, 'paneView')) return true
    const name = agentFromPath(ctx, paneMatch[1]!)
    if (!name) return true
    audit(ctx, 'pane-view', name)
    // The stream stops on the request's close event, so the real request goes through.
    await forward(ctx, `/api/agents/${encodeURIComponent(name)}/pane/stream`, tryHandleAgentTerminal, { keepBody: true })
    return true
  }

  // --- commands: a name from the owner's list, a fixed text into the pane ---
  const cmdMatch = path.match(/^\/api\/operator\/agents\/([^/]+)\/commands\/([^/]+)$/)
  if (cmdMatch && method === 'POST') {
    if (!requireCapability(ctx, access, 'commands')) return true
    const cmd = cmdMatch[2]!
    if (!(OPERATOR_COMMANDS as readonly string[]).includes(cmd) || !access.commands.includes(cmd as OperatorCommand)) {
      json(res, { error: 'Command not allowed by the owner', command: cmd }, 403)
      return true
    }
    const name = agentFromPath(ctx, cmdMatch[1]!)
    if (!name) return true
    const isMain = isMainChannelsAgent(name)
    const session = isMain ? MAIN_CHANNELS_SESSION : agentSessionName(name)
    const host = isMain ? null : readAgentRemoteHost(name)
    const running = isMain ? capturePane(MAIN_CHANNELS_SESSION) !== null : isAgentRunning(name)
    if (!running) { json(res, { error: 'Agent is not running' }, 409); return true }
    audit(ctx, `command-${cmd}`, name)
    // 'abort' on a busy pane: a command typed into a working session would park in its input box.
    const sent = await sendPromptToSession(session, OPERATOR_COMMAND_TEXT[cmd as OperatorCommand], host, { onBusyTimeout: 'abort' })
    if (sent !== 'sent') { json(res, { error: 'The agent is busy; try again shortly', result: sent }, 409); return true }
    json(res, { ok: true, command: cmd })
    return true
  }

  json(res, { error: 'Not found' }, 404)
  return true
}
