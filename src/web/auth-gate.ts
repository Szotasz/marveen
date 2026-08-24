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
//   1. Authorization: Bearer <api_tokens DB entry, valid>  -> { kind: 'token', role, tenantId }
//   1b. Authorization: Bearer <api_tokens DB entry, expired/revoked> -> { kind: 'none' } (no fallback)
//   2. Authorization: Bearer <file-based dashboard token>  -> { kind: 'token' } (admin+default, legacy)
//   3. Authorization: Bearer <device key>                  -> { kind: 'device', device, deviceId }
//   4. SSE pane-stream ?token=<dashboard token>            -> { kind: 'token' }  (path-scoped)
//   5. SSE pane-stream ?token=<device key>                 -> { kind: 'device' } (path-scoped)
//   6. Federation inbound token, endpoint-scoped           -> { kind: 'federation', peer }
//   7. mv_session cookie                                   -> { kind: 'session', user }
//   8. none of the above                                   -> { kind: 'none' }
//
// requiresAuth() is the separate "is this path gated at all" predicate: public
// probes (auth status, login, avatars) return false; everything under /api/ and
// the fleet manifest return true.

import type http from 'node:http'
import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { checkBearerToken } from './dashboard-auth.js'
import { identifyFederationCaller } from './federation/config.js'
import { resolveSession } from './auth-sessions.js'
import { resolveDeviceKey } from './auth-device-keys.js'
import type { Role } from './rbac.js'

export type AuthResult =
  | { kind: 'token'; role?: Role; tenantId?: string }
  | { kind: 'device'; device: string; deviceId: number }
  | { kind: 'federation'; peer: string }
  | { kind: 'session'; user: string; role?: Role; tenantId?: string | null }
  | { kind: 'none' }

// ── api_tokens DB lookup ─────────────────────────────────────────────────────
//
// Returns the token row if valid (not expired, not revoked), or a sentinel
// indicating the token is registered-but-invalid. The sentinel is critical:
// a revoked token must NOT fall through to the file-token fallback (which
// would re-grant admin and bypass revocation).

type ApiTokenResult =
  | { found: true; role: Role; tenantId: string }
  | { found: false; registeredButInvalid: boolean }

export function resolveApiToken(bearer: string, db: Database.Database): ApiTokenResult {
  const hash = createHash('sha256').update(bearer).digest('hex')
  const now = Math.floor(Date.now() / 1000)

  const validRow = db
    .prepare(
      `SELECT role, tenant_id FROM api_tokens
       WHERE token_hash = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`,
    )
    .get(hash, now) as { role: string; tenant_id: string } | undefined

  if (validRow) {
    return { found: true, role: validRow.role as Role, tenantId: validRow.tenant_id }
  }

  const anyRow = db.prepare('SELECT id FROM api_tokens WHERE token_hash = ?').get(hash)
  return { found: false, registeredButInvalid: !!anyRow }
}

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
  // Artifact view endpoint is HMAC-token gated, not Bearer; exclude from the
  // standard auth gate so the browser can open it without an Authorization header.
  if (method === 'GET' && /^\/api\/artifacts\/[^/]+\/view$/.test(path)) return false
  if (path === '/.well-known/fleetq' && method === 'GET') return true
  return path.startsWith('/api/')
}

export function resolveAuth(
  req: http.IncomingMessage,
  url: URL,
  path: string,
  method: string,
  dashboardToken: string,
  db?: Database.Database,
): AuthResult {
  const bearerHeader = req.headers.authorization
  const bearerMatch = /^Bearer\s+(.+)$/.exec(bearerHeader ?? '')
  const bearerValue = bearerMatch?.[1]?.trim()

  // 1. api_tokens DB lookup -- explicit tokens with their own role and tenant.
  //    CRITICAL: if a token is found in DB but expired/revoked, return 'none'
  //    immediately -- do NOT fall through to the file-token fallback, which would
  //    re-grant admin and bypass revocation. Only tokens absent from DB entirely
  //    may reach the legacy fallback in step 2.
  if (bearerValue && db) {
    const result = resolveApiToken(bearerValue, db)
    if (result.found) {
      return { kind: 'token', role: result.role, tenantId: result.tenantId }
    }
    if (result.registeredButInvalid) {
      return { kind: 'none' }
    }
  }

  // 2. Legacy file-token fallback: the prod dashboard bearer (store/.dashboard-token).
  //    This token is intentionally NOT enrolled in api_tokens to avoid prod disruption
  //    during rollout. It retains its original admin+default-tenant semantics.
  //    Enrolling the prod token into api_tokens is deferred to a separate task
  //    after fleet stabilisation, with a dedicated bootstrap+rollback plan.
  if (checkBearerToken(bearerHeader, dashboardToken)) return { kind: 'token' }

  // 3. Bearer device key. Runs only after the dashboard token failed to match,
  //    so the token lane stays byte-identical; resolveDeviceKey's prefix check
  //    makes this a no-op for every non-key bearer (and with zero device_keys
  //    rows the whole step never resolves -- fresh installs unaffected).
  if (bearerMatch) {
    const dk = resolveDeviceKey(bearerValue!)
    if (dk) return { kind: 'device', device: dk.name, deviceId: dk.id }
  }

  // 4. SSE pane stream ?token= (EventSource cannot set an Authorization header):
  //    dashboard token first, then device key -- a device must be able to open
  //    the pane stream too, or the dashboard would look half-broken on it.
  if (isSsePaneStream(path, method)) {
    const qtoken = url.searchParams.get('token') ?? ''
    if (checkBearerToken(`Bearer ${qtoken}`, dashboardToken)) return { kind: 'token' }
    const dk = resolveDeviceKey(qtoken)
    if (dk) return { kind: 'device', device: dk.name, deviceId: dk.id }
  }

  // 5. Scoped per-peer federation tokens: valid ONLY on the two wire endpoints,
  //    and only while federation is enabled (identifyFederationCaller fail-closes).
  if (isFederationWireEndpoint(path, method)) {
    const peer = identifyFederationCaller(req.headers.authorization, checkBearerToken)
    if (peer !== null) return { kind: 'federation', peer }
  }

  // 6. Browser-login session cookie.
  //    When the DB is available, look up the user's role and tenant scope so the
  //    RBAC gate can apply the correct permission set for session-login callers.
  const cookieValue = parseCookies(req.headers.cookie)[SESSION_COOKIE_NAME]
  if (cookieValue) {
    const session = resolveSession(cookieValue)
    if (session) {
      if (db) {
        const userRow = db
          .prepare('SELECT role, tenant_id FROM dashboard_users WHERE username = ? COLLATE NOCASE AND disabled = 0')
          .get(session.username) as { role: string; tenant_id: string | null } | undefined
        if (userRow) {
          return { kind: 'session', user: session.username, role: userRow.role as Role, tenantId: userRow.tenant_id }
        }
      }
      return { kind: 'session', user: session.username }
    }
  }

  return { kind: 'none' }
}
