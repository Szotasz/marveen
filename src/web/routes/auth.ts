// Dashboard browser-login endpoints.
//
// All of these are OPTIONAL: with zero dashboard_users rows the gate behaves
// exactly like the token-only mode and only /api/auth/status is meaningful
// (setup_required:true). Login enforcement becomes available -- never required,
// the bearer token always works -- once the operator creates a user.
//
// The bearer token stays the break-glass credential: creating the FIRST user
// and resetting a password are reachable with a valid bearer, so there is never
// an unauthenticated first-run setup page (which would be a claim-the-admin race
// on loopback).

import type http from 'node:http'
import { readBody, json } from '../http-helpers.js'
import { logger } from '../../logger.js'
import { parseCookies, SESSION_COOKIE_NAME } from '../auth-gate.js'
import {
  hashPassword,
  verifyPassword,
  assertPasswordPolicy,
  PasswordPolicyError,
} from '../password-hash.js'
import {
  createSession,
  revokeSession,
  revokeAllForUser,
  listUserSessions,
} from '../auth-sessions.js'
import {
  checkThrottle,
  recordFailure,
  recordSuccess,
  runDummyVerify,
} from '../login-throttle.js'
import {
  createDashboardUser,
  getDashboardUser,
  listDashboardUsers,
  countDashboardUsers,
  updateDashboardUserPassword,
  deleteDashboardUser,
} from '../../db.js'
import type { RouteContext } from './types.js'

const LOGIN_BODY_MAX_BYTES = 8 * 1024
const USERNAME_RE = /^[a-zA-Z0-9._-]{1,64}$/
const INVALID_CREDENTIALS = { error: 'Invalid credentials' }

// Set Secure only when the request arrived over https (Tailscale Serve sets
// x-forwarded-proto). The primary transport is plain http://127.0.0.1 where an
// unconditional Secure attribute would make Safari drop the cookie (Chrome
// exempts 127.0.0.1 as trustworthy; Safari's behavior there is inconsistent).
function isHttps(req: http.IncomingMessage): boolean {
  const xf = req.headers['x-forwarded-proto']
  const v = Array.isArray(xf) ? xf[0] : xf
  return typeof v === 'string' && v.split(',')[0]!.trim().toLowerCase() === 'https'
}

function sessionCookie(token: string, req: http.IncomingMessage): string {
  const base = `${SESSION_COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`
  return isHttps(req) ? `${base}; Secure` : base
}

function clearCookie(req: http.IncomingMessage): string {
  const base = `${SESSION_COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`
  return isHttps(req) ? `${base}; Secure` : base
}

async function parseJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const raw = (await readBody(req, { maxBytes: LOGIN_BODY_MAX_BYTES })).toString().trim()
  if (!raw) return {}
  const parsed = JSON.parse(raw)
  return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

// { authenticated, method, user, login_available, setup_required }.
// authenticated keeps its exact old meaning for token callers (existing probes
// parse only that field): a valid bearer -> authenticated:true.
function statusPayload(auth: RouteContext['auth']) {
  const authenticated = auth?.kind === 'token' || auth?.kind === 'session'
  const method = auth?.kind === 'token' ? 'token' : auth?.kind === 'session' ? 'session' : null
  const user = auth?.kind === 'session' ? auth.user ?? null : null
  return {
    authenticated,
    method,
    user,
    login_available: countDashboardUsers(false) >= 1,
    setup_required: countDashboardUsers(true) === 0,
  }
}

export async function tryHandleAuth(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, auth } = ctx

  if (path === '/api/auth/status' && method === 'GET') {
    json(res, statusPayload(auth))
    return true
  }

  if (path === '/api/auth/login' && method === 'POST') {
    let body: Record<string, unknown>
    try {
      body = await parseJsonBody(req)
    } catch {
      json(res, { error: 'Invalid JSON' }, 400)
      return true
    }
    const username = str(body.username).trim()
    const password = str(body.password)
    const usernameLc = username.toLowerCase()

    const throttle = checkThrottle(usernameLc)
    if (throttle.locked) {
      if (throttle.global) logger.warn('login: global failure cap reached -- all logins throttled')
      res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': String(throttle.retryAfterS), 'Cache-Control': 'private, no-store' })
      res.end(JSON.stringify({ error: 'Too many attempts', retry_after_s: throttle.retryAfterS }))
      return true
    }

    const user = username ? getDashboardUser(username) : undefined
    let ok = false
    if (user && !user.disabled && password) {
      ok = await verifyPassword(password, user.password_hash)
    } else {
      // Unknown user / disabled / empty input: run the dummy verify so timing
      // and lockout are identical to a real wrong-password attempt.
      await runDummyVerify(password)
    }

    if (!ok || !user) {
      recordFailure(usernameLc)
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' })
      res.end(JSON.stringify(INVALID_CREDENTIALS))
      return true
    }

    recordSuccess(usernameLc)
    // Session fixation defence: if a (valid) session cookie accompanied the
    // login, revoke it -- login always mints a fresh id.
    const presented = parseCookies(req.headers.cookie)[SESSION_COOKIE_NAME]
    if (presented) revokeSession(presented)
    const token = createSession(
      { userId: user.id, username: user.username },
      { userAgent: str(req.headers['user-agent']) || null, remoteNote: isHttps(req) ? 'https' : 'loopback' },
    )
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': sessionCookie(token, req), 'Cache-Control': 'private, no-store' })
    res.end(JSON.stringify({ ok: true, user: user.username }))
    return true
  }

  if (path === '/api/auth/logout' && method === 'POST') {
    const presented = parseCookies(req.headers.cookie)[SESSION_COOKIE_NAME]
    if (presented) revokeSession(presented)
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': clearCookie(req), 'Cache-Control': 'private, no-store' })
    res.end(JSON.stringify({ ok: true }))
    return true
  }

  if (path === '/api/auth/logout-all' && method === 'POST') {
    if (auth?.kind !== 'session' || !auth.user) {
      json(res, { error: 'Session required' }, 400)
      return true
    }
    const user = getDashboardUser(auth.user)
    if (user) revokeAllForUser(user.id)
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': clearCookie(req), 'Cache-Control': 'private, no-store' })
    res.end(JSON.stringify({ ok: true }))
    return true
  }

  if (path === '/api/auth/sessions' && method === 'GET') {
    if (auth?.kind !== 'session' || !auth.user) {
      json(res, { error: 'Session required' }, 400)
      return true
    }
    const user = getDashboardUser(auth.user)
    if (!user) {
      json(res, { error: 'User not found' }, 404)
      return true
    }
    json(res, { sessions: listUserSessions(user.id) })
    return true
  }

  if (path === '/api/auth/password' && method === 'POST') {
    let body: Record<string, unknown>
    try {
      body = await parseJsonBody(req)
    } catch {
      json(res, { error: 'Invalid JSON' }, 400)
      return true
    }
    const newPassword = str(body.new_password)

    let user = undefined as ReturnType<typeof getDashboardUser>
    if (auth?.kind === 'session' && auth.user) {
      user = getDashboardUser(auth.user)
      if (!user) {
        json(res, { error: 'User not found' }, 404)
        return true
      }
      // Session callers must prove knowledge of the current password.
      const current = str(body.current_password)
      if (!(await verifyPassword(current, user.password_hash))) {
        json(res, INVALID_CREDENTIALS, 401)
        return true
      }
    } else {
      // Bearer break-glass: may omit current_password but must name the target.
      const username = str(body.username)
      user = username ? getDashboardUser(username) : undefined
      if (!user) {
        json(res, { error: 'User not found' }, 404)
        return true
      }
    }

    try {
      assertPasswordPolicy(newPassword)
    } catch (err) {
      json(res, { error: err instanceof PasswordPolicyError ? err.message : 'Invalid password' }, 400)
      return true
    }
    const hash = await hashPassword(newPassword)
    updateDashboardUserPassword(user.id, hash)
    // Revoke every other session of this user; keep the caller's own if present.
    const presented = parseCookies(req.headers.cookie)[SESSION_COOKIE_NAME]
    revokeAllForUser(user.id, presented ?? undefined)
    json(res, { ok: true })
    return true
  }

  if (path === '/api/auth/users' && method === 'GET') {
    json(res, { users: listDashboardUsers() })
    return true
  }

  if (path === '/api/auth/users' && method === 'POST') {
    let body: Record<string, unknown>
    try {
      body = await parseJsonBody(req)
    } catch {
      json(res, { error: 'Invalid JSON' }, 400)
      return true
    }
    const username = str(body.username).trim()
    const password = str(body.password)
    if (!USERNAME_RE.test(username)) {
      json(res, { error: 'Invalid username (1-64 chars: letters, digits, . _ -)' }, 400)
      return true
    }
    if (getDashboardUser(username)) {
      json(res, { error: 'User already exists' }, 409)
      return true
    }
    try {
      assertPasswordPolicy(password)
    } catch (err) {
      json(res, { error: err instanceof PasswordPolicyError ? err.message : 'Invalid password' }, 400)
      return true
    }
    const hash = await hashPassword(password)
    const created = createDashboardUser(username, hash)
    logger.info({ username: created.username }, 'dashboard user created')
    json(res, { ok: true, user: { id: created.id, username: created.username } }, 201)
    return true
  }

  const delMatch = /^\/api\/auth\/users\/([^/]+)$/.exec(path)
  if (delMatch && method === 'DELETE') {
    const username = decodeURIComponent(delMatch[1]!)
    const user = getDashboardUser(username)
    if (!user) {
      json(res, { error: 'User not found' }, 404)
      return true
    }
    deleteDashboardUser(username)
    revokeAllForUser(user.id)
    // Deleting the last user is the documented way to return to token-only mode.
    logger.info({ username, remaining: countDashboardUsers(true) }, 'dashboard user deleted')
    json(res, { ok: true })
    return true
  }

  return false
}
