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
//   1. Authorization: Bearer <dashboard token>   -> { kind: 'token', agent? }
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

import type http from 'node:http'
import { checkBearerToken } from './dashboard-auth.js'
import { identifyFederationCaller } from './federation/config.js'
import { resolveSession } from './auth-sessions.js'
import { resolveDeviceKey } from './auth-device-keys.js'
import { sanitizeAgentIdent } from '../prompt-safety.js'
import { isKnownAgent } from './agent-config.js'

export type AuthResult =
  | { kind: 'token'; agent?: string }
  | { kind: 'device'; device: string; deviceId: number }
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
  if (method === 'GET' && (path === '/api/marveen/avatar' || /^\/api\/agents\/[^/]+\/avatar$/.test(path))) return false
  if (path === '/.well-known/fleetq' && method === 'GET') return true
  return path.startsWith('/api/')
}

export function resolveAuth(
  req: http.IncomingMessage,
  url: URL,
  path: string,
  method: string,
  dashboardToken: string,
): AuthResult {
  // 1. Bearer header -- unchanged, highest precedence. The optional agent claim
  //    rides along: it never affects WHETHER the request is authenticated, only
  //    what the routes can say about who asked.
  if (checkBearerToken(req.headers.authorization, dashboardToken)) {
    return { kind: 'token', agent: resolveAgentClaim(req) }
  }

  // 2. Bearer device key. Runs only after the dashboard token failed to match,
  //    so the token lane stays byte-identical; resolveDeviceKey's prefix check
  //    makes this a no-op for every non-key bearer (and with zero device_keys
  //    rows the whole step never resolves -- fresh installs unaffected).
  const bearerMatch = /^Bearer\s+(.+)$/.exec(req.headers.authorization ?? '')
  if (bearerMatch) {
    const dk = resolveDeviceKey(bearerMatch[1]!.trim())
    if (dk) return { kind: 'device', device: dk.name, deviceId: dk.id }
  }

  // 3. SSE pane stream ?token= (EventSource cannot set an Authorization header):
  //    dashboard token first, then device key -- a device must be able to open
  //    the pane stream too, or the dashboard would look half-broken on it.
  if (isSsePaneStream(path, method)) {
    const qtoken = url.searchParams.get('token') ?? ''
    if (checkBearerToken(`Bearer ${qtoken}`, dashboardToken)) return { kind: 'token' }
    const dk = resolveDeviceKey(qtoken)
    if (dk) return { kind: 'device', device: dk.name, deviceId: dk.id }
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

  return { kind: 'none' }
}
