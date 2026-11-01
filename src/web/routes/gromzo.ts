// GROMZOOWNERQR1030 (+ MOBILRELOGINDASH1025): the dashboard's Gromzo panel.
//
//   GET  /api/gromzo/status    -> mxd's state for the panel (running / linked)
//   POST /api/gromzo/owner-qr  -> the owner's QR code: the first registration's join
//                                 code, or, once the owner is registered, the login
//                                 code for a new phone (see mxd-dash.ts requestOwnerQr)
//   GET  /api/gromzo/agents                    -> the fleet's agents and whether each is on Gromzo
//   POST /api/gromzo/agents/:slug/enable       -> asks the owner (in the app) to approve the agent
//   GET  /api/gromzo/agents/:slug/consent      -> the pending consent; once approved, mxd adds the agent
//   POST /api/gromzo/agents/:slug/disable      -> takes the agent off Gromzo
//   (GROMZOAGENTPICK1101; the rules are in ../gromzo-agents.ts. All four: the owner's session only.)
//
// Who may ask for the QR: ONLY the owner's dashboard session. This is stricter than
// issuing a device key (routes/auth.ts mayIssueCredentials, DEVKEYMINT1022), which
// lets the shared token in before the first dashboard login exists. Here that
// first-run branch is closed on purpose (Dani's review of #2365): the shared bearer
// is held by every fleet agent, and the first owner_invite claims the owner's chat
// seat on the controller once. On a fresh install the owner first sets up the
// dashboard login, then asks for the QR.
//
// The global Origin gate (csrf-origin) refuses a foreign-origin POST before this
// runs; the POST here also refuses a non-JSON body (415), as video-review does.
//
// The secret: written into this one response, inside `uri`, with no-store. Never
// logged (only the kind and the lifetime are), never in the URL, never stored.

import type http from 'node:http'
import { logger } from '../../logger.js'
import { json, methodNotAllowed, readBody } from '../http-helpers.js'
import { parseCookies, SESSION_COOKIE_NAME } from '../auth-gate.js'
import { resolveSession } from '../auth-sessions.js'

/** The 403 body. Same code as auth.ts OWNER_SESSION_REQUIRED (the panel keys its
 *  sentence on it), but its own text: that one says the token works before the
 *  first login, which is not true here. */
export const OWNER_QR_SESSION_REQUIRED = {
  error: "The owner QR needs the owner's dashboard login. The access token never gets it, not even before the first login exists: set up the dashboard login first.",
  code: 'owner_session_required',
}
import { mxdDashCall, MxdDashError, MXD_AGENT_SLUG_RE, requestOwnerQr, type MxdDashCall, type OwnerQr } from '../mxd-dash.js'
import {
  checkGromzoAgent, disableGromzoAgent, enableGromzoAgent, listGromzoAgents, type GromzoAgentDeps, type GromzoAgentOutcome,
} from '../gromzo-agents.js'
import { listAgentNames, readAgentDisplayName, readAgentGromzo, writeAgentGromzo } from '../agent-config.js'
import { isAgentRunning, restartAgentProcess } from '../agent-process.js'
import type { RouteContext } from './types.js'

/** The owner's dashboard session, and nothing else: a session principal, or the
 *  shared token sent alongside a valid session cookie (a logged-in owner whose
 *  browser also keeps the access token). Never the bare token, not even before the
 *  first login exists; never a sub-agent token, a device key or a federation peer. */
export function isOwnerSession(auth: RouteContext['auth'], req: http.IncomingMessage): boolean {
  if (auth?.kind === 'session') return true
  if (auth?.kind !== 'token' || auth.tokenAgent) return false
  const cookie = parseCookies(req.headers.cookie)[SESSION_COOKIE_NAME]
  return !!cookie && resolveSession(cookie) !== null
}

const STATUS_PATH = '/api/gromzo/status'
const OWNER_QR_PATH = '/api/gromzo/owner-qr'
const AGENTS_PATH = '/api/gromzo/agents'
const AGENT_ACTION_RE = /^\/api\/gromzo\/agents\/([^/]{1,64})\/(enable|disable|consent)$/

/** The dash.sock client (the socket path is read per call: MXD_DASH_SOCK or the default). */
const call: MxdDashCall = (request) => mxdDashCall(request)

/** The HTTP status for a failure code (transport or mxd). The body carries the code;
 *  the panel turns it into a sentence (web/lang gromzo.err.*). */
export function httpStatusFor(code: string): number {
  switch (code) {
    case 'bad_request': return 400
    case 'unknown_agent': return 404
    case 'main_agent':
    case 'no_pending':
    case 'consent_mismatch':
    case 'agent_exists':
    case 'add_in_progress':
    case 'pending_exists':
    case 'too_many_agents':
    case 'bad_slug':
    case 'reserved_slug':
    case 'bad_name':
    case 'reserved_name':
      return 409
    case 'rate_limited':
    case 'too_soon':
      return 429
    case 'agents_not_running':
    case 'not_running':
    case 'no_access':
    case 'forbidden':
      return 503
    case 'timeout': return 504
    case 'not_linked':
    case 'consent_required':
    case 'invite_outstanding':
    case 'owner_invite_already_issued':
    case 'owner_invite_used':
    case 'no_owner':
    case 'identity_reset_in_progress':
    case 'identity_reset_stalled':
    case 'team_lapsed':
    case 'team_unknown':
    case 'revoked':
      return 409
    case 'test_guard': return 500
    default: return 502
  }
}

function isJsonRequest(req: http.IncomingMessage): boolean {
  const ct = String(req.headers['content-type'] ?? '').toLowerCase()
  return ct.split(';')[0]!.trim() === 'application/json'
}

/** The one response that carries a secret. Its headers are set HERE, explicitly,
 *  so no shared helper's later change can make the browser or a proxy keep it. */
function sendOwnerQr(res: http.ServerResponse, qr: OwnerQr): void {
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, max-age=0',
    Pragma: 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(JSON.stringify({ kind: qr.kind, uri: qr.uri, expires_in: qr.expires_in }))
}

function failure(res: http.ServerResponse, code: string, retryAfter?: number): void {
  json(res, retryAfter === undefined ? { error: code } : { error: code, retry_after: retryAfter }, httpStatusFor(code))
}

/** After mxd's reload (it exits ~0.5 s after an add or a remove): wait until dash.sock answers again, up to ~60 s,
 *  then restart that ONE agent so its Gromzo plugin loads or goes. Nothing else is restarted. */
async function restartAfterMxdReload(slug: string): Promise<void> {
  await new Promise((r) => setTimeout(r, 2_000))
  for (let i = 0; i < 30; i++) {
    try {
      const r = await call({ verb: 'status' })
      if (r.ok === true && r.running === true) break
    } catch { /* still reloading */ }
    await new Promise((r) => setTimeout(r, 2_000))
  }
  const res = await restartAgentProcess(slug)
  if (res.ok) logger.info({ slug }, 'gromzo agents: the agent restarted for its Gromzo switch')
  else logger.error({ slug, error: res.error }, 'gromzo agents: the agent did NOT restart after its Gromzo switch')
}

const defaultAgentDeps: GromzoAgentDeps = {
  call: (request) => call(request),
  agents: () => listAgentNames(),
  readFlag: (slug) => readAgentGromzo(slug),
  writeFlag: (slug, on) => writeAgentGromzo(slug, on),
  displayName: (slug) => readAgentDisplayName(slug) || slug,
  isRunning: (slug) => isAgentRunning(slug),
  held: async () => {
    // dash status carries held_agents only when it is not empty (marveen-mxd link.rs status).
    try {
      const r = await call({ verb: 'status' })
      const h = r.held_agents
      return new Set(Array.isArray(h) ? h.filter((x): x is string => typeof x === 'string' && MXD_AGENT_SLUG_RE.test(x)) : [])
    } catch { return new Set() }
  },
  restartOne: (slug) => { void restartAfterMxdReload(slug).catch((e) => logger.error({ slug, err: e instanceof Error ? e.message : String(e) }, 'gromzo agents: restart failed')) },
  now: () => Date.now(),
}
let agentDeps: GromzoAgentDeps = defaultAgentDeps

/** Test seam: replace some of the agent switch's collaborators (null puts the real ones back). */
export function setGromzoAgentDepsForTest(deps: Partial<GromzoAgentDeps> | null): void {
  agentDeps = deps ? { ...defaultAgentDeps, ...deps } : defaultAgentDeps
}

function sendOutcome(res: http.ServerResponse, slug: string, action: string, o: GromzoAgentOutcome): void {
  if (o.ok) {
    logger.info({ slug, action, state: o.state }, 'gromzo agents: switch')
    json(res, o.state === 'pending' ? { state: o.state, expires_in: o.expiresIn } : { state: o.state })
    return
  }
  logger.warn({ slug, action, code: o.code }, 'gromzo agents: switch refused or failed')
  failure(res, o.code)
}

async function handleAgents(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, auth } = ctx
  const action = AGENT_ACTION_RE.exec(path)
  if (path !== AGENTS_PATH && !action) return false
  const wantMethod = path === AGENTS_PATH || action?.[2] === 'consent' ? 'GET' : 'POST'
  if (method !== wantMethod) { methodNotAllowed(res, method, [wantMethod]); return true }
  if (wantMethod === 'POST') {
    if (!isJsonRequest(req)) { json(res, { error: 'content_type_must_be_json' }, 415); return true }
    try { await readBody(req, { maxBytes: 1024 }) } catch { json(res, { error: 'body_too_large' }, 413); return true }
  }
  if (!isOwnerSession(auth, req)) {
    logger.warn({ kind: auth?.kind, path }, 'gromzo agents: refused (needs the owner session)')
    json(res, OWNER_QR_SESSION_REQUIRED, 403)
    return true
  }
  if (!action) {
    json(res, { agents: await listGromzoAgents(agentDeps) })
    return true
  }
  let slug: string
  try { slug = decodeURIComponent(action[1]!) } catch { failure(res, 'bad_request'); return true }
  try {
    const o = action[2] === 'enable' ? await enableGromzoAgent(slug, agentDeps)
      : action[2] === 'disable' ? await disableGromzoAgent(slug, agentDeps)
        : await checkGromzoAgent(slug, agentDeps)
    sendOutcome(res, slug, action[2]!, o)
  } catch (e) {
    const code = e instanceof MxdDashError ? e.code : 'io'
    logger.warn({ slug, action: action[2], code }, 'gromzo agents: dash.sock failed')
    failure(res, code)
  }
  return true
}

export async function tryHandleGromzo(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, auth } = ctx
  if (await handleAgents(ctx)) return true
  if (path !== STATUS_PATH && path !== OWNER_QR_PATH) return false

  if (path === STATUS_PATH) {
    if (method !== 'GET') { methodNotAllowed(res, method, ['GET']); return true }
    try {
      const r = await call({ verb: 'status' })
      if (r.ok !== true) {
        const code = typeof r.error === 'string' && /^[a-z0-9_]{1,40}$/.test(r.error) ? r.error : 'refused'
        json(res, { available: false, code })
        return true
      }
      json(res, { available: true, running: r.running === true, linked: r.linked === true })
    } catch (e) {
      const code = e instanceof MxdDashError ? e.code : 'io'
      json(res, { available: false, code })
    }
    return true
  }

  // OWNER_QR_PATH
  if (method !== 'POST') { methodNotAllowed(res, method, ['POST']); return true }
  if (!isJsonRequest(req)) { json(res, { error: 'content_type_must_be_json' }, 415); return true }
  // Drain the (empty) body; nothing in it is used.
  try { await readBody(req, { maxBytes: 1024 }) } catch { json(res, { error: 'body_too_large' }, 413); return true }
  if (!isOwnerSession(auth, req)) {
    logger.warn({ kind: auth?.kind }, 'gromzo: owner QR refused (needs the owner session)')
    json(res, OWNER_QR_SESSION_REQUIRED, 403)
    return true
  }
  let result
  try {
    result = await requestOwnerQr(call)
  } catch (e) {
    const code = e instanceof MxdDashError ? e.code : 'io'
    logger.warn({ code }, 'gromzo: owner QR failed (dash.sock)')
    failure(res, code)
    return true
  }
  if (!result.ok) {
    logger.warn({ code: result.code }, 'gromzo: owner QR refused by mxd')
    failure(res, result.code, result.retryAfter)
    return true
  }
  logger.info({ kind: result.qr.kind, expires_in: result.qr.expires_in }, 'gromzo: owner QR issued (the secret is not logged)')
  sendOwnerQr(res, result.qr)
  return true
}
