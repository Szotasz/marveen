// Web logins in the vault (VAULTLOGIN1112, plan agents/samu/work/vaultlogin-terv.md, the owner chose variant A).
//
// An entry is one exact origin with a username and a password. The password is stored in the AES-256-GCM vault as
// web-login-<id> and is read ONLY in-process, by the filler (vault-web-login-filler.ts), which types it into the
// calling agent's own browser. No generic vault path serves, resolves, binds or writes it (isWebLoginSecretId).
// The row in vault_web_logins holds what is not secret.
//
// allowed_agents: an empty list (the default) means NO agent may use the entry; the owner turns it on per entry.
// A wrong password locks the entry until the owner unlocks it (no second guess that could lock the account on the
// site); any other non-success (2FA, unknown, origin mismatch, no form) starts a 15-minute cool-down.
import { getDb } from '../db.js'
import { deleteSecret, getSecret, setSecret } from './vault.js'
import { WEB_LOGIN_SECRET_PREFIX } from './vault-acl.js'

export type LoginOutcome = 'success' | '2fa' | 'wrong' | 'unknown' | 'origin-mismatch' | 'no-form' | 'browser-unavailable'

export const WEB_LOGIN_COOLDOWN_SECONDS = 15 * 60
const SELECTOR_MAX = 200
const USERNAME_MAX = 320

export interface WebLoginRow {
  id: string
  origin: string
  username: string
  login_url: string | null
  user_selector: string | null
  pass_selector: string | null
  allowed_agents: string
  locked_at: number | null
  last_result: string | null
  last_attempt_at: number | null
  last_agent: string | null
  created_at: number
  updated_at: number
}

export interface WebLogin {
  id: string
  origin: string
  username: string
  loginUrl: string | null
  userSelector: string | null
  passSelector: string | null
  allowedAgents: string[]
  lockedAt: number | null
  lastResult: string | null
  lastAttemptAt: number | null
  lastAgent: string | null
  createdAt: number
  updatedAt: number
}

export function webLoginSecretId(id: string): string {
  return `${WEB_LOGIN_SECRET_PREFIX}${id}`
}

function parseAgents(raw: string): string[] {
  try {
    const v = JSON.parse(raw) as unknown
    return Array.isArray(v) ? v.filter((a): a is string => typeof a === 'string' && a.length > 0) : []
  } catch {
    return []
  }
}

function toWebLogin(r: WebLoginRow): WebLogin {
  return {
    id: r.id,
    origin: r.origin,
    username: r.username,
    loginUrl: r.login_url,
    userSelector: r.user_selector,
    passSelector: r.pass_selector,
    allowedAgents: parseAgents(r.allowed_agents),
    lockedAt: r.locked_at,
    lastResult: r.last_result,
    lastAttemptAt: r.last_attempt_at,
    lastAgent: r.last_agent,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export function listWebLogins(): WebLogin[] {
  return (getDb().prepare('SELECT * FROM vault_web_logins ORDER BY origin ASC, username ASC').all() as WebLoginRow[]).map(toWebLogin)
}

export function getWebLogin(id: string): WebLogin | null {
  const r = getDb().prepare('SELECT * FROM vault_web_logins WHERE id = ?').get(id) as WebLoginRow | undefined
  return r ? toWebLogin(r) : null
}

/** The password, for the filler only. Never logged, never put into a response. */
export function readWebLoginPassword(id: string): string | null {
  return getSecret(webLoginSecretId(id))
}

// ---------------------------------------------------------------------------
// Validation (pure)
// ---------------------------------------------------------------------------

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

/**
 * The exact origin (scheme, host, port), as URL.origin prints it. https only, except a loopback host (a local test
 * page), which may be http. No path, query, fragment or credentials.
 */
export function normalizeOrigin(input: unknown): string | null {
  if (typeof input !== 'string' || !input.trim()) return null
  let u: URL
  try { u = new URL(input.trim()) } catch { return null }
  if (u.username || u.password) return null
  const loopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]'
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) return null
  if ((u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) return null
  return u.origin
}

/** A login page URL on the entry's own origin, or null when it is not one. */
export function normalizeLoginUrl(input: unknown, origin: string): string | null {
  if (typeof input !== 'string' || !input.trim()) return null
  let u: URL
  try { u = new URL(input.trim()) } catch { return null }
  if (u.username || u.password || u.origin !== origin) return null
  return u.href
}

export function slugFromOrigin(origin: string): string {
  return new URL(origin).host.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 56) || 'login'
}

function optionalSelector(v: unknown): string | null | undefined {
  if (v === undefined) return undefined
  if (v === null || v === '') return null
  if (typeof v !== 'string' || v.length > SELECTOR_MAX) return undefined
  return v.trim() || null
}

export interface WebLoginInput {
  origin?: unknown
  username?: unknown
  password?: unknown
  loginUrl?: unknown
  userSelector?: unknown
  passSelector?: unknown
  allowedAgents?: unknown
}

/** Agent names the entry may list: only known sub-agents (the caller passes the roster), no duplicates. */
export function validateAllowedAgents(v: unknown, known: readonly string[]): string[] | null {
  if (v === undefined) return []
  if (!Array.isArray(v)) return null
  const out: string[] = []
  for (const a of v) {
    if (typeof a !== 'string' || !known.includes(a)) return null
    if (!out.includes(a)) out.push(a)
  }
  return out
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export type WebLoginWriteError = { error: string; status: number }

export function createWebLogin(input: WebLoginInput, knownAgents: readonly string[]): WebLogin | WebLoginWriteError {
  const origin = normalizeOrigin(input.origin)
  if (!origin) return { error: 'origin must be an exact https origin (scheme, host and port, nothing else)', status: 400 }
  const username = typeof input.username === 'string' ? input.username.trim() : ''
  if (!username || username.length > USERNAME_MAX) return { error: 'username is required', status: 400 }
  if (typeof input.password !== 'string' || input.password.length === 0) return { error: 'password is required', status: 400 }
  let loginUrl: string | null = null
  if (input.loginUrl !== undefined && input.loginUrl !== null && input.loginUrl !== '') {
    loginUrl = normalizeLoginUrl(input.loginUrl, origin)
    if (!loginUrl) return { error: 'loginUrl must be a URL on the same origin', status: 400 }
  }
  const userSelector = optionalSelector(input.userSelector)
  const passSelector = optionalSelector(input.passSelector)
  if (userSelector === undefined && input.userSelector !== undefined) return { error: 'userSelector is too long', status: 400 }
  if (passSelector === undefined && input.passSelector !== undefined) return { error: 'passSelector is too long', status: 400 }
  const allowed = validateAllowedAgents(input.allowedAgents, knownAgents)
  if (!allowed) return { error: 'allowedAgents must list known sub-agents only', status: 400 }

  const base = slugFromOrigin(origin)
  let id = base
  for (let n = 2; getWebLogin(id); n++) id = `${base}-${n}`
  if (!ID_RE.test(id)) return { error: 'Could not derive an id', status: 400 }

  setSecret(webLoginSecretId(id), `Web login: ${origin} (${username})`, input.password)
  const now = Math.floor(Date.now() / 1000)
  getDb().prepare(
    `INSERT INTO vault_web_logins (id, origin, username, login_url, user_selector, pass_selector, allowed_agents, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, origin, username, loginUrl, userSelector ?? null, passSelector ?? null, JSON.stringify(allowed), now, now)
  return getWebLogin(id)!
}

export function updateWebLogin(id: string, input: WebLoginInput, knownAgents: readonly string[]): WebLogin | WebLoginWriteError {
  const existing = getWebLogin(id)
  if (!existing) return { error: 'Not found', status: 404 }
  const sets: string[] = []
  const vals: unknown[] = []
  if (input.username !== undefined) {
    const u = typeof input.username === 'string' ? input.username.trim() : ''
    if (!u || u.length > USERNAME_MAX) return { error: 'username must not be empty', status: 400 }
    sets.push('username = ?'); vals.push(u)
  }
  if (input.loginUrl !== undefined) {
    if (input.loginUrl === null || input.loginUrl === '') { sets.push('login_url = NULL') } else {
      const l = normalizeLoginUrl(input.loginUrl, existing.origin)
      if (!l) return { error: 'loginUrl must be a URL on the same origin', status: 400 }
      sets.push('login_url = ?'); vals.push(l)
    }
  }
  for (const [key, col] of [['userSelector', 'user_selector'], ['passSelector', 'pass_selector']] as const) {
    if (input[key] === undefined) continue
    const sel = optionalSelector(input[key])
    if (sel === undefined) return { error: `${key} is too long`, status: 400 }
    sets.push(`${col} = ?`); vals.push(sel)
  }
  if (input.allowedAgents !== undefined) {
    const allowed = validateAllowedAgents(input.allowedAgents, knownAgents)
    if (!allowed) return { error: 'allowedAgents must list known sub-agents only', status: 400 }
    sets.push('allowed_agents = ?'); vals.push(JSON.stringify(allowed))
  }
  if (input.password !== undefined) {
    if (typeof input.password !== 'string' || input.password.length === 0) return { error: 'password must not be empty', status: 400 }
    const label = `Web login: ${existing.origin} (${typeof input.username === 'string' && input.username.trim() ? input.username.trim() : existing.username})`
    setSecret(webLoginSecretId(id), label, input.password)
    // A new password is a new chance: the lock from the old one is lifted.
    sets.push('locked_at = NULL')
  }
  sets.push('updated_at = ?'); vals.push(Math.floor(Date.now() / 1000))
  getDb().prepare(`UPDATE vault_web_logins SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id)
  return getWebLogin(id)!
}

export function deleteWebLogin(id: string): boolean {
  const deleted = getDb().prepare('DELETE FROM vault_web_logins WHERE id = ?').run(id).changes > 0
  if (deleted) deleteSecret(webLoginSecretId(id))
  return deleted
}

export function unlockWebLogin(id: string): boolean {
  return getDb().prepare('UPDATE vault_web_logins SET locked_at = NULL, updated_at = ? WHERE id = ?')
    .run(Math.floor(Date.now() / 1000), id).changes > 0
}

// ---------------------------------------------------------------------------
// The attempt rules (pure) and the record of an attempt
// ---------------------------------------------------------------------------

export type AttemptRefusal = 'not-allowed' | 'locked' | 'cooldown'

/** A page answered, and it was not a login: no second try for 15 minutes. A browser that did not start is not the
 *  site's answer, so it does not count (and a wrong password locks instead, see recordAttempt). */
const COOLDOWN_OUTCOMES: readonly string[] = ['2fa', 'unknown', 'origin-mismatch', 'no-form']

/** Whether this agent may try this entry now. An empty allowedAgents list allows nobody. */
export function attemptRefusal(entry: WebLogin, agent: string, nowSec: number): AttemptRefusal | null {
  if (!entry.allowedAgents.includes(agent)) return 'not-allowed'
  if (entry.lockedAt !== null) return 'locked'
  if (entry.lastResult !== null && COOLDOWN_OUTCOMES.includes(entry.lastResult) && entry.lastAttemptAt !== null
      && nowSec - entry.lastAttemptAt < WEB_LOGIN_COOLDOWN_SECONDS) return 'cooldown'
  return null
}

export function recordAttempt(id: string, agent: string, outcome: LoginOutcome, nowSec: number): void {
  getDb().prepare(
    `UPDATE vault_web_logins SET last_result = ?, last_attempt_at = ?, last_agent = ?,
       locked_at = CASE WHEN ? = 'wrong' THEN ? ELSE locked_at END
     WHERE id = ?`,
  ).run(outcome, nowSec, agent, outcome, nowSec, id)
}

/** Every sub-agent some entry allows: these get the browser and its MCP server. */
export function agentsWithWebLogins(): string[] {
  const out = new Set<string>()
  for (const e of listWebLogins()) for (const a of e.allowedAgents) out.add(a)
  return [...out].sort()
}
