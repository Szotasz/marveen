// Unified auth resolution for the dashboard HTTP gate.
//
// Extracted from the inline gate that used to live in src/web.ts so the
// precedence is unit-testable (auth-gate.test.ts is the fleet-regression
// contract). The BEARER path is checked first and is byte-for-byte unchanged:
// every fleet curl call, notify.sh, the channels auth probe and the federation
// wire endpoints keep working with zero change, whether or not any dashboard
// user exists.
//
// Precedence (first match wins):
//   1. Authorization: Bearer <dashboard token>   -> { kind: 'token', claimedAgent? }
//   1b. Authorization: Bearer <sub-agent token>  -> { kind: 'token', agent }
//   2. Authorization: Bearer <device key>        -> { kind: 'device', device, deviceId }
//   3. SSE pane-stream ?token=<dashboard token>   -> { kind: 'token' }  (path-scoped)
//   4. SSE pane-stream ?token=<device key>        -> { kind: 'device' } (path-scoped)
//   5. Federation inbound token, endpoint-scoped  -> { kind: 'federation', peer }
//   6. mv_session cookie                          -> { kind: 'session', user }
//   7. none of the above                          -> { kind: 'none' }
//
// requiresAuth() is the separate "is this path gated at all" predicate: public
// probes (auth status, login, avatars) return false; everything under /api/ and
// the fleet manifest return true.
//
// Two different agent names ride on the 'token' kind, and they must never be
// confused:
//   - claimedAgent: the SELF-ASSERTED X-Agent-Id header on the shared token
//     (see resolveAgentClaim). Advisory: routes may warn and attribute with it,
//     never authorize or restrict.
//   - agent: AUTHENTICATED, set only when the Authorization bearer was a
//     sub-agent's own token (agents/<name>/.dashboard-token, see
//     agent-tokens.ts for the threat model; never on the SSE ?token= lane, a
//     sub-agent has no business reading a pane stream). gateRequest()
//     restricts this principal (agentScopeDenial). A
//     per-agent token ignores the X-Agent-Id header: the token already names
//     the caller, and a typed header must not override it.
// The shared token (no `agent`) is the main/admin principal and is
// byte-identical to before.

import type http from 'node:http'
import { checkBearerToken } from './dashboard-auth.js'
import { identifyFederationCaller } from './federation/config.js'
import { resolveSession } from './auth-sessions.js'
import { resolveDeviceKey, type DeviceKeyScope } from './auth-device-keys.js'
import { OPERATOR_COOKIE_NAME, resolveOperatorSession } from './operator-sessions.js'
import { sanitizeAgentIdent } from '../prompt-safety.js'
import { isKnownAgent } from './agent-config.js'
import { agentTokensEnabled, type AgentTokenResolver } from './agent-tokens.js'
import { logger } from '../logger.js'

export type AuthResult =
  | { kind: 'token'; agent?: string; claimedAgent?: string }
  | { kind: 'device'; device: string; deviceId: number; scope: DeviceKeyScope }
  | { kind: 'federation'; peer: string }
  | { kind: 'session'; user: string }
  | { kind: 'none' }

export const SESSION_COOKIE_NAME = 'mv_session'

// Minimal, allocation-light cookie parser. Only the values we look up matter;
// malformed pairs are skipped rather than throwing.
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    const name = part.slice(0, eq).trim()
    if (!name) continue
    const value = part.slice(eq + 1).trim()
    if (out[name] === undefined) out[name] = value
  }
  return out
}

// Self-asserted caller identity for fleet callers (card 29c8cf33, option A).
//
// The whole fleet shares ONE dashboard token, so a request carries no identity:
// every agent's curl is byte-identical to every other's. This header lets a
// caller SAY which agent it is, and routes may use it to WARN -- never to
// authorize.
//
// Why a claim and not a credential. Measured 2026-09-14 on this install: all
// seven agents run as the same UNIX user (uid 1000), can read each other's
// files (agents/*/ is drwxrwxr-x) and each other's /proc/<pid>/environ, there
// is no vault (store/vault.json absent) and no OS keyring (keychain.ts gates on
// darwin; this host is Linux). Any per-agent secret written to disk or to the
// environment is therefore readable by every other agent, so a per-agent token
// would not be forgery-proof either -- only more expensive, and 119 files carry
// the shared-token idiom. Meanwhile the measured risk is an ACCIDENT, not an
// attack: of 8 destructive memory calls over two days, zero touched another
// agent's row. An accident tells the truth about its own name, which is exactly
// what this header captures. Real enforcement needs OS-level separation
// (one UNIX user per agent); see docs/agens-azonositas-api.md.
//
// A sub-agent now also gets its own token (option B of that document, see
// agent-tokens.ts). It does not change the paragraph above: that token is not
// forgery-proof either. What it adds is a server-side place for the policies a
// hook cannot enforce on every client. The claim stays what it was for every
// caller on the SHARED token, and lands in `claimedAgent`, never in `agent`.
//
// Validation mirrors the `from` check on POST /api/messages: the claim must
// name a registered fleet agent, otherwise it is DROPPED. Never a 403 -- the
// header is advisory, and a request that was valid without it stays valid with
// a bad one.
const AGENT_HEADER = 'x-agent-id'
const AGENT_CLAIM_MAX = 64

function resolveAgentClaim(req: http.IncomingMessage): string | undefined {
  const raw = req.headers[AGENT_HEADER]
  const value = Array.isArray(raw) ? raw[0] : raw
  if (!value) return undefined
  // Cap BEFORE the filesystem check: isKnownAgent stats agents/<name>, and an
  // unbounded header would turn every request into a long-path stat.
  const name = sanitizeAgentIdent(value.trim().slice(0, AGENT_CLAIM_MAX))
  if (!name || !isKnownAgent(name)) return undefined
  return name
}

function isSsePaneStream(path: string, method: string): boolean {
  return method === 'GET' && /^\/api\/agents\/[^/]+\/pane\/stream$/.test(path)
}

export function isFederationWireEndpoint(path: string, method: string): boolean {
  return (
    (path === '/api/federation/manifest' && method === 'GET') ||
    (path === '/api/federation/inbox' && method === 'POST')
  )
}

// Public (ungated) surfaces. These mirror the old inline exceptions exactly,
// plus the new POST /api/auth/login (public + throttled) so the login form can
// reach the server before a session exists.
export function requiresAuth(path: string, method: string): boolean {
  if (path === '/api/auth/status' && method === 'GET') return false
  if (path === '/api/auth/login' && method === 'POST') return false
  // DASHOPERATOR1005: the operator page signs in with its key here, before any
  // cookie exists. The handler checks the key, the scope and the owner switch.
  if (path === '/api/operator/login' && method === 'POST') return false
  if (method === 'GET' && (path === '/api/marveen/avatar' || /^\/api\/agents\/[^/]+\/avatar$/.test(path))) return false
  if (path === '/.well-known/fleetq' && method === 'GET') return true
  // VIDEOREVIEW1002: <video src> cannot send a bearer header. The stream is
  // authorised by a single-file, short-lived ticket instead, which the handler
  // checks itself (routes/video-review.ts); without a valid ticket it is 403.
  if (path === '/api/video-review/file' && (method === 'GET' || method === 'HEAD')) return false
  return path.startsWith('/api/')
}

// A matched per-agent token. With AGENT_DASHBOARD_TOKENS off (the rollback
// switch) it still authenticates -- a running agent must not start getting
// 401 -- but as the plain shared-token principal, i.e. the rights every agent
// had before per-agent tokens existed.
function agentTokenPrincipal(agent: string): AuthResult {
  return agentTokensEnabled() ? { kind: 'token', agent } : { kind: 'token' }
}

export function resolveAuth(
  req: http.IncomingMessage,
  url: URL,
  path: string,
  method: string,
  dashboardToken: string,
  resolveAgentToken?: AgentTokenResolver,
): AuthResult {
  // 1. Bearer header -- unchanged, highest precedence. The optional agent claim
  //    rides along: it never affects WHETHER the request is authenticated, only
  //    what the routes can say about who asked.
  if (checkBearerToken(req.headers.authorization, dashboardToken)) {
    // The claim is SELF-ASSERTED (one shared token, anyone can type the header):
    // it lands in claimedAgent, never in `agent`. `agent` is reserved for the
    // AUTHENTICATED per-agent token below, because the scope/binding gates
    // restrict by it -- a typed header must neither restrict the main lane nor
    // stand in for a credential.
    const claimedAgent = resolveAgentClaim(req)
    return claimedAgent ? { kind: 'token', claimedAgent } : { kind: 'token' }
  }

  // 1b. A sub-agent's own token (agents/<name>/.dashboard-token). Only after
  //     the shared token failed, so the main lane stays byte-identical.
  if (resolveAgentToken) {
    const m = /^Bearer\s+(.+)$/.exec(req.headers.authorization ?? '')
    if (m) {
      const agent = resolveAgentToken(m[1]!.trim())
      if (agent) return agentTokenPrincipal(agent)
    }
  }

  // 2. Bearer device key. Runs only after the dashboard token failed to match,
  //    so the token lane stays byte-identical; resolveDeviceKey's prefix check
  //    makes this a no-op for every non-key bearer (and with zero device_keys
  //    rows the whole step never resolves -- fresh installs unaffected).
  const bearerMatch = /^Bearer\s+(.+)$/.exec(req.headers.authorization ?? '')
  if (bearerMatch) {
    const dk = resolveDeviceKey(bearerMatch[1]!.trim())
    if (dk) return { kind: 'device', device: dk.name, deviceId: dk.id, scope: dk.scope }
  }

  // 3. SSE pane stream ?token= (EventSource cannot set an Authorization header):
  //    dashboard token first, then device key -- a device must be able to open
  //    the pane stream too, or the dashboard would look half-broken on it.
  if (isSsePaneStream(path, method)) {
    const qtoken = url.searchParams.get('token') ?? ''
    if (checkBearerToken(`Bearer ${qtoken}`, dashboardToken)) return { kind: 'token' }
    const dk = resolveDeviceKey(qtoken)
    if (dk) return { kind: 'device', device: dk.name, deviceId: dk.id, scope: dk.scope }
  }

  // 4. Scoped per-peer federation tokens: valid ONLY on the two wire endpoints,
  //    and only while federation is enabled (identifyFederationCaller fail-closes).
  if (isFederationWireEndpoint(path, method)) {
    const peer = identifyFederationCaller(req.headers.authorization, checkBearerToken)
    if (peer !== null) return { kind: 'federation', peer }
  }

  // 5. Browser-login session cookie.
  const cookieValue = parseCookies(req.headers.cookie)[SESSION_COOKIE_NAME]
  if (cookieValue) {
    const session = resolveSession(cookieValue)
    if (session) return { kind: 'session', user: session.username }
  }

  // 6. Operator browser session (DASHOPERATOR1005). Resolves to the operator
  //    key it was minted from, so the operator gate fences it exactly like the
  //    key itself; last, so an owner session in the same browser always wins.
  const operatorCookie = parseCookies(req.headers.cookie)[OPERATOR_COOKIE_NAME]
  if (operatorCookie) {
    const op = resolveOperatorSession(operatorCookie)
    if (op) return { kind: 'device', device: op.device, deviceId: op.deviceId, scope: 'operator' }
  }

  return { kind: 'none' }
}

// ---- Sub-agent scope ---------------------------------------------------------

// Every method except GET/HEAD on /api/schedules or anything below it counts as
// a schedule write: create (POST), update (PUT/PATCH), delete (DELETE), and the
// POST side-effects (toggle, run-now, pending-retry cancel, the LLM
// expand-* helpers the schedule editor uses). Fail-closed on purpose: a new
// write route added under /api/schedules later is covered without touching
// this list. Matched on a decoded, lower-cased, slash-collapsed copy so no
// spelling variant slips past (the router itself is exact-match, so such
// variants 404 anyway -- this is belt and braces).
export function isScheduleWrite(path: string, method: string): boolean {
  const m = method.toUpperCase()
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return false
  let p = path
  try { p = decodeURIComponent(path) } catch { /* keep raw */ }
  p = p.toLowerCase().replace(/\/{2,}/g, '/')
  return p === '/api/schedules' || p.startsWith('/api/schedules/')
}

export function scheduleWriteDeniedMessage(mainAgentId: string): string {
  return `only the main agent writes schedules; send the request to ${mainAgentId} via /api/messages`
}

/**
 * The per-principal scope check that runs right after authentication.
 * Returns null when the request may proceed, or the 403 to send. Only a
 * sub-agent token (kind 'token' WITH an agent tag) is ever restricted; the
 * shared/main token, browser sessions, device keys and federation peers are
 * untouched. The rule is the one scripts/self-pace-gate.mjs already applies to
 * a sub-agent's shell commands, now enforced where every client lands.
 */
export function agentScopeDenial(
  auth: AuthResult,
  path: string,
  method: string,
  mainAgentId: string,
): { status: 403; body: { error: string; rule: string; agent: string; main_agent: string } } | null {
  if (auth.kind !== 'token' || !auth.agent) return null
  if (!isScheduleWrite(path, method)) return null
  return {
    status: 403,
    body: {
      error: scheduleWriteDeniedMessage(mainAgentId),
      rule: 'schedule-writes-main-agent-only',
      agent: auth.agent,
      main_agent: mainAgentId,
    },
  }
}

/**
 * The whole request gate as web.ts runs it: resolve the principal, answer 401
 * for a gated path with no principal (unchanged behaviour), then apply the
 * sub-agent scope (403). Returns the principal when the request may proceed,
 * or null once a response has been written. Extracted so the HTTP-level test
 * drives the exact code path the dashboard runs.
 */
export function gateRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  path: string,
  method: string,
  opts: { dashboardToken: string; resolveAgentToken?: AgentTokenResolver; mainAgentId: string },
): AuthResult | null {
  const auth = resolveAuth(req, url, path, method, opts.dashboardToken, opts.resolveAgentToken)
  if (requiresAuth(path, method) && auth.kind === 'none') {
    if (isFederationWireEndpoint(path, method)) {
      // 401s are otherwise silent; federation-endpoint auth failures are the
      // brute-force surface -- make them visible (round-2 scoped-token gate).
      logger.warn({ path, method }, 'federation: rejected wire-endpoint auth')
    }
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Unauthorized' }))
    return null
  }
  const denial = agentScopeDenial(auth, path, method, opts.mainAgentId)
  if (denial) {
    // The agent NAME is logged, never the token.
    logger.warn({ agent: denial.body.agent, method, path }, 'agent token: sub-agent schedule write refused (403)')
    res.writeHead(denial.status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(denial.body))
    return null
  }
  return auth
}
