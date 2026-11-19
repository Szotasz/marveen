// The colleague board login (docs/board-access.md, "Colleague login").
//
// Two halves in one file, so the whole surface is reviewed together:
//
// 1. The colleague's own surface (a colleague session, kind 'colleague'):
//      GET  /colleague, /colleague.html, /colleague.js   the board page (static, holds no data)
//      POST /api/colleague/login    public (requiresAuth), throttled; mints a colleague session only
//      POST /api/colleague/logout   the caller's own colleague session
//      GET  /api/colleague/me       who the session is, and as which board person
//    The board itself is /api/board/* (routes/board.ts), which resolves a
//    colleague session to its account's person.
//
// 2. The owner's account administration, owner session only (mayActAsOwner):
//      GET    /api/colleague-accounts                     list (never a password hash)
//      POST   /api/colleague-accounts                     create { username, person, password }
//      POST   /api/colleague-accounts/:u/password         reset  { password }
//      POST   /api/colleague-accounts/:u/disable          disable (ends its sessions)
//      POST   /api/colleague-accounts/:u/enable           enable
//      DELETE /api/colleague-accounts/:u                  delete (ends its sessions)
//    The machine-local CLI (scripts/colleague-account.ts) does the same.
//
// An unknown /api/colleague/* path is a 404 HERE, so it never falls through to
// another handler further down the dispatch chain.

import type http from 'node:http'
import { join } from 'node:path'
import { KANBAN_STATUSES, logConfigChange } from '../../db.js'
import { logger } from '../../logger.js'
import { parseCookies } from '../auth-gate.js'
import { readBoardAccess } from '../board-access.js'
import {
  ColleagueAccountError,
  createColleagueAccount,
  deleteColleagueAccount,
  listColleagueAccounts,
  normaliseUsername,
  readColleagueAccounts,
  resetColleaguePassword,
  setColleagueDisabled,
} from '../colleague-accounts.js'
import { COLLEAGUE_API_PREFIX } from '../colleague-gate.js'
import {
  COLLEAGUE_ABSOLUTE_TTL_SEC,
  COLLEAGUE_COOKIE_NAME,
  createColleagueSession,
  revokeColleagueSession,
  revokeColleagueSessionsFor,
} from '../colleague-sessions.js'
import { json, readBody, serveFile } from '../http-helpers.js'
import { createLoginThrottle, runDummyVerify } from '../login-throttle.js'
import { PasswordPolicyError, verifyPassword } from '../password-hash.js'
import { isHttps, mayActAsOwner, ownerCookieSession, refuseOwner } from './auth.js'
import type { RouteContext } from './types.js'

const LOGIN_BODY_MAX_BYTES = 8 * 1024
const ADMIN_BODY_MAX_BYTES = 8 * 1024
const INVALID_CREDENTIALS = { error: 'Invalid credentials' }
export const COLLEAGUE_ACCOUNTS_API = '/api/colleague-accounts'

/** Its own instance: colleague login failures never count toward the owner login's global cap. */
export const colleagueLoginThrottle = createLoginThrottle()

function colleagueCookie(token: string, maxAgeSec: number, req: http.IncomingMessage): string {
  const base = `${COLLEAGUE_COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSec}`
  return isHttps(req) ? `${base}; Secure` : base
}

function noStore(res: http.ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store', ...extra })
  res.end(JSON.stringify(body))
}

async function jsonBody(req: http.IncomingMessage, maxBytes: number): Promise<Record<string, unknown> | null> {
  try {
    const raw = (await readBody(req, { maxBytes })).toString().trim()
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function ownerActor(ctx: RouteContext): string {
  const a = ctx.auth
  if (a?.kind === 'session') return `session:${a.user ?? '?'}`
  return `owner:${ownerCookieSession(ctx.req) ?? '?'}`
}

function sendAccountError(res: http.ServerResponse, err: unknown): void {
  if (err instanceof PasswordPolicyError) { json(res, { error: err.message }, 400); return }
  if (err instanceof ColleagueAccountError) { json(res, { error: err.message }, err.status); return }
  throw err
}

async function handleLogin(ctx: RouteContext): Promise<void> {
  const { req, res } = ctx
  const body = await jsonBody(req, LOGIN_BODY_MAX_BYTES)
  if (!body) { json(res, { error: 'Invalid JSON' }, 400); return }
  const password = typeof body.password === 'string' ? body.password : ''
  const rawName = typeof body.username === 'string' ? body.username.trim().toLowerCase().slice(0, 64) : ''
  const bucket = rawName || '(empty)'
  const throttle = colleagueLoginThrottle.checkThrottle(bucket)
  if (throttle.locked) {
    noStore(res, 429, { error: 'Too many attempts', retry_after_s: throttle.retryAfterS }, { 'Retry-After': String(throttle.retryAfterS) })
    return
  }
  const username = normaliseUsername(rawName)
  const accounts = readColleagueAccounts()
  const account = username && !accounts.broken ? accounts.accounts.get(username) : undefined
  // An unknown name costs the same KDF run as a wrong password, so timing does not enumerate accounts.
  const ok = account ? await verifyPassword(password, account.passwordHash) : (await runDummyVerify(password), false)
  if (!account || !ok) {
    colleagueLoginThrottle.recordFailure(bucket)
    if (colleagueLoginThrottle.isGlobalLimited()) logger.warn('colleague login: global failure cap reached, every colleague login is throttled')
    noStore(res, 401, INVALID_CREDENTIALS)
    return
  }
  // A disabled account answers like a wrong password: the owner knows they disabled it, nobody else needs to.
  if (account.disabled) { noStore(res, 401, INVALID_CREDENTIALS); return }
  colleagueLoginThrottle.recordSuccess(bucket)
  const cfg = readBoardAccess()
  const person = cfg.people.get(account.person)
  if (cfg.broken || !cfg.enabled || !person) {
    logger.warn({ username: account.username, person: account.person, enabled: cfg.enabled, broken: cfg.broken }, 'colleague login: the account\'s person is not on the board')
    noStore(res, 403, { error: 'the board is not available for this account' })
    return
  }
  const presented = parseCookies(req.headers.cookie)[COLLEAGUE_COOKIE_NAME]
  if (presented) revokeColleagueSession(presented)
  const ua = req.headers['user-agent']
  const token = createColleagueSession(account.username, account.generation, { userAgent: typeof ua === 'string' ? ua : null })
  logConfigChange('colleague:login', null, account.username, `colleague:${account.username}`)
  logger.info({ username: account.username, person: account.person }, 'colleague login')
  noStore(res, 200, { ok: true, username: account.username, person: { id: person.id, name: person.name } },
    { 'Set-Cookie': colleagueCookie(token, COLLEAGUE_ABSOLUTE_TTL_SEC, req) })
}

/** The owner gate of every account route: true when the caller is the owner, else the 403 is written. */
function ownerOnly(ctx: RouteContext): boolean {
  if (mayActAsOwner(ctx.auth, ctx.req)) return true
  refuseOwner(ctx.res, 'Colleague board accounts are managed with the dashboard login (an owner session).')
  return false
}

function usernameFrom(m: RegExpMatchArray): string {
  try { return decodeURIComponent(m[1]!) } catch { return '' }
}

async function handleAccounts(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx
  if (path !== COLLEAGUE_ACCOUNTS_API && !path.startsWith(`${COLLEAGUE_ACCOUNTS_API}/`)) return false
  // Owner only, reads included (the list names who can sign in to the board). Asked here for every path under the
  // prefix, and again in each handler, so no handler depends on its position.
  if (!ownerOnly(ctx)) return true
  const accountMatch = path.match(/^\/api\/colleague-accounts\/([^/]+)$/)
  const passwordMatch = path.match(/^\/api\/colleague-accounts\/([^/]+)\/password$/)
  const toggleMatch = path.match(/^\/api\/colleague-accounts\/([^/]+)\/(disable|enable)$/)
  try {
    if (path === '/api/colleague-accounts' && method === 'GET') {
      if (!ownerOnly(ctx)) return true
      json(res, { accounts: listColleagueAccounts() })
      return true
    }
    if (path === '/api/colleague-accounts' && method === 'POST') {
      if (!ownerOnly(ctx)) return true
      const body = await jsonBody(req, ADMIN_BODY_MAX_BYTES)
      if (!body) { json(res, { error: 'Invalid JSON' }, 400); return true }
      const cfg = readBoardAccess()
      const account = await createColleagueAccount(
        { username: body.username, person: body.person, password: body.password },
        (pid) => !cfg.broken && cfg.people.has(pid),
      )
      logConfigChange('colleague-account:create', null, `${account.username} -> ${account.person}`, ownerActor(ctx))
      json(res, { ok: true, account })
      return true
    }
    if (passwordMatch && method === 'POST') {
      if (!ownerOnly(ctx)) return true
      const body = await jsonBody(req, ADMIN_BODY_MAX_BYTES)
      if (!body) { json(res, { error: 'Invalid JSON' }, 400); return true }
      const account = await resetColleaguePassword(usernameFrom(passwordMatch), body.password)
      revokeColleagueSessionsFor(account.username)
      logConfigChange('colleague-account:password', null, account.username, ownerActor(ctx))
      json(res, { ok: true, account })
      return true
    }
    if (toggleMatch && method === 'POST') {
      if (!ownerOnly(ctx)) return true
      const disable = toggleMatch[2] === 'disable'
      const account = setColleagueDisabled(usernameFrom(toggleMatch), disable)
      if (disable) revokeColleagueSessionsFor(account.username)
      logConfigChange(`colleague-account:${toggleMatch[2]}`, null, account.username, ownerActor(ctx))
      json(res, { ok: true, account })
      return true
    }
    if (accountMatch && method === 'DELETE') {
      if (!ownerOnly(ctx)) return true
      const raw = usernameFrom(accountMatch)
      const username = normaliseUsername(raw)
      deleteColleagueAccount(raw)
      if (username) revokeColleagueSessionsFor(username)
      logConfigChange('colleague-account:delete', username, null, ownerActor(ctx))
      json(res, { ok: true })
      return true
    }
    if (accountMatch || passwordMatch || toggleMatch || path === '/api/colleague-accounts') {
      json(res, { error: 'Method not allowed' }, 405)
      return true
    }
    json(res, { error: 'not found' }, 404)
    return true
  } catch (err) {
    sendAccountError(res, err)
    return true
  }
}

export async function tryHandleColleague(ctx: RouteContext, webDir: string): Promise<boolean> {
  const { req, res, path, method } = ctx

  if ((path === '/colleague' || path === '/colleague.html') && (method === 'GET' || method === 'HEAD')) {
    serveFile(req, res, join(webDir, 'colleague.html'))
    return true
  }
  if (path === '/colleague.js' && (method === 'GET' || method === 'HEAD')) {
    serveFile(req, res, join(webDir, 'colleague.js'))
    return true
  }

  if (await handleAccounts(ctx)) return true

  if (!path.startsWith(COLLEAGUE_API_PREFIX)) return false

  if (path === '/api/colleague/login') {
    if (method !== 'POST') { json(res, { error: 'Method not allowed' }, 405); return true }
    await handleLogin(ctx)
    return true
  }

  // Everything below answers a colleague session only.
  if (ctx.auth?.kind !== 'colleague' || !ctx.auth.colleague) {
    json(res, { error: 'Colleague session required' }, 403)
    return true
  }

  if (path === '/api/colleague/logout' && method === 'POST') {
    const presented = parseCookies(req.headers.cookie)[COLLEAGUE_COOKIE_NAME]
    if (presented) revokeColleagueSession(presented)
    noStore(res, 200, { ok: true }, { 'Set-Cookie': colleagueCookie('', 0, req) })
    return true
  }

  if (path === '/api/colleague/me' && method === 'GET') {
    const cfg = readBoardAccess()
    const person = ctx.auth.person ? cfg.people.get(ctx.auth.person) : undefined
    noStore(res, 200, {
      username: ctx.auth.colleague,
      person: person ? { id: person.id, name: person.name, role: person.role } : null,
      board_available: !!person && cfg.enabled && !cfg.broken,
      statuses: [...KANBAN_STATUSES],
    })
    return true
  }

  json(res, { error: 'not found' }, 404)
  return true
}
