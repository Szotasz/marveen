// Dashboard browser-login endpoints.
//
// All of these are OPTIONAL: with zero dashboard_users rows the gate behaves
// exactly like the token-only mode and only /api/auth/status is meaningful
// (setup_required:true). Login enforcement becomes available -- never required,
// the bearer token always works -- once the operator creates a user.
//
// The bearer token creates the FIRST user, so there is never an unauthenticated
// first-run setup page (which would be a claim-the-admin race on loopback).
// Resetting a password without the current one is NOT reachable over HTTP: the
// owner's recovery path is the machine-local CLI, npm run dashboard-user --
// reset-password <username> (DEVKEYMINT1022).
// Once a user exists, issuing credentials and adding or removing users take the
// owner's session instead (mayActAsOwner, DEVKEYMINT1022; the first login and the first
// device stay on the first-run setup, mayActAsOwnerOrFirstRun, OWNERGATE4-1104).
//
// Principal discipline: every handler that grants or removes access checks the
// caller's auth kind against an EXPLICIT allowlist. Only 'token' and 'session'
// can reach these paths today (federation tokens are endpoint-scoped inside
// resolveAuth and never resolve here), but the allowlists exist so any future
// AuthResult kind -- e.g. per-device keys -- is denied by default. What a new
// credential type may do here must be a review decision, not the accident of
// an else-branch.

import type http from 'node:http'
import { readBody, json } from '../http-helpers.js'
import { logger } from '../../logger.js'
import { notifySecurityEvent } from '../../notify.js'
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
  resolveSession,
} from '../auth-sessions.js'
import {
  checkThrottle,
  recordFailure,
  recordSuccess,
  runDummyVerify,
} from '../login-throttle.js'
import {
  createDeviceKey,
  deviceKeyEverIssued,
  listDeviceKeys,
  revokeDeviceKey,
  getDeviceKey,
  DEVICE_KEY_SCOPES,
  OPERATOR_KEY_DEFAULT_EXPIRY_DAYS,
  OPERATOR_KEY_MAX_EXPIRY_DAYS,
  type DeviceKeyScope,
} from '../auth-device-keys.js'
import { removeBridgeSshAccess, sshDirOverride } from '../bridge-enroll.js'
import {
  createDashboardUser,
  getDashboardUser,
  listDashboardUsers,
  countDashboardUsers,
  updateDashboardUserPassword,
  deleteDashboardUser,
  logConfigChange,
} from '../../db.js'
import type { RouteContext } from './types.js'

const LOGIN_BODY_MAX_BYTES = 8 * 1024
const USERNAME_RE = /^[a-zA-Z0-9._-]{1,64}$/
const INVALID_CREDENTIALS = { error: 'Invalid credentials' }

// Set Secure only when the request arrived over https (Tailscale Serve sets
// x-forwarded-proto). The primary transport is plain http://127.0.0.1 where an
// unconditional Secure attribute would make Safari drop the cookie (Chrome
// exempts 127.0.0.1 as trustworthy; Safari's behavior there is inconsistent).
export function isHttps(req: http.IncomingMessage): boolean {
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

// Explicit principal allowlist. Compares on the kind string so tests can
// exercise kinds the AuthResult union does not carry yet; anything not listed
// (including undefined auth, which the gate should have 401'd already) fails.
//
// Exported (2026-09-03) because the transcript route needs the same predicate:
// a caller-side gate duplicated in two files is exactly the kind of security
// check that drifts apart. One definition, one place to audit.
export function kindAllowed(auth: RouteContext['auth'], kinds: readonly string[]): boolean {
  return auth !== undefined && kinds.includes(auth.kind)
}

export const FORBIDDEN_KIND = { error: 'Forbidden for this credential type' }

// Who may manage dashboard users (list/create/delete). 'session' is included
// deliberately: a logged-in operator managing users is the existing behavior.
// A device key only as the Bridge, beside the owner's cookie (bridgeOwner below).
const USER_ADMIN_KINDS = ['token', 'session'] as const

// Who may mint/list/revoke device keys. The same operator set. A device key ALONE
// never: a key that could mint further keys would turn one leaked device into
// unlimited, unexpiring access. BRIDGEPWLOGIN1101 PR-2 (Dani 65623 (2)): a FULL key
// beside a valid owner session cookie may, because the proof there is the cookie,
// which a leaked key does not carry: the owner signed in with the password in that
// window, and logging out or the session's expiry ends it.
const DEVICE_KEY_ADMIN_KINDS = ['token', 'session'] as const

/** The Bridge as the owner: a FULL device key with a valid owner session cookie beside it. No audit line here; the
 *  owner gate that follows (mayActAsOwner) writes it. */
export function bridgeOwner(auth: RouteContext['auth'], req?: http.IncomingMessage): boolean {
  return auth?.kind === 'device' && auth.scope === 'full' && ownerCookieSession(req) !== null
}

/** The owner's password-login session riding on this request as its cookie: its user name, or null. The ONE place
 *  the cookie branch is decided (BRIDGEPWLOGIN1101, Dani 65623 (a)): isOwnerSession (gromzo.ts), mayActAsOwner and
 *  mayActAsOwnerOrFirstRun all read it, so expiry, idle limit and logout (resolveSession) are the same for every gate. */
export function ownerCookieSession(req?: http.IncomingMessage): string | null {
  const cookie = req ? parseCookies(req.headers.cookie)[SESSION_COOKIE_NAME] : undefined
  if (!cookie) return null
  return resolveSession(cookie)?.username ?? null
}

/** OWNERGATE4-1104: the owner gate of every owner action. It needs the owner's proof on every request: a session
 *  principal; the shared token (never a sub-agent's own token) only with a valid owner session cookie beside it (a
 *  logged-in owner whose browser also keeps the access token sends both, and the gate resolves the bearer first); a
 *  FULL device key only with that cookie (the Bridge, whose webview sends its key on every call while the owner signed
 *  in with the password inside it; the cookie is the proof, the key adds nothing; one audit line naming the owner).
 *  Never a bare device key, an operator key, a peer or a sub-agent token.
 *  There is NO first-run branch here: the shared token is readable by every sub-agent, so letting it act as the owner
 *  while no dashboard login exists opened every owner gate to the whole fleet on an install without a login. Before
 *  the first login it refuses everything (refuseOwner then says to create one), except the closed list of paths a
 *  fresh install needs, which call mayActAsOwnerOrFirstRun instead. */
export function mayActAsOwner(auth: RouteContext['auth'], req?: http.IncomingMessage): boolean {
  if (auth?.kind === 'session') return true
  if (auth?.kind === 'token') return !auth.tokenAgent && ownerCookieSession(req) !== null
  return bridgeOwnerAudited(auth, req)
}

/** The device-key branch of the owner gate: a FULL key with a valid owner session cookie beside it, and on a pass the
 *  one audit line naming the owner. */
function bridgeOwnerAudited(auth: RouteContext['auth'], req?: http.IncomingMessage): boolean {
  if (auth?.kind !== 'device' || auth.scope !== 'full') return false
  const owner = ownerCookieSession(req)
  if (owner === null) return false
  logger.info({ owner, auth: 'device', device: auth.device, method: req?.method, path: req?.url?.split('?')[0] }, 'owner action on a Bridge key: the owner session beside it')
  return true
}

/** OWNERGATE4-1104: the closed list of paths a fresh install needs before any dashboard login exists, and why each is
 *  on it. Only these may call mayActAsOwnerOrFirstRun; a source-scan test (owner-gate-first-run-pin.test.ts) pins
 *  every call and its reason to this list, so a new first-run caller cannot appear without editing it.
 *   - 'agent-create': POST /api/agents. The customer install creates its first agent in the onboarding wizard.
 *   - 'channel-setup': POST /api/agents/:name/channels/:provider (and the legacy /telegram). Onboarding step 2: the
 *     bot token and the owner's chat id, so the owner can reach the agent at all. ONLY while that agent's that channel
 *     is unconfigured (the call site checks channelIsUnconfigured: no setting in its .env and no approved sender;
 *     unreadable counts as configured); re-setting a configured channel is strict.
 *   - 'first-pairing': the channel pairing approve, ONLY while the channel has no approved sender yet (the call site
 *     checks channelHasNoApprovedSender). Onboarding step 3: the owner pairs themself; a second sender is strict.
 *   - 'onboarding-identity': POST /api/onboarding/identity. The wizard's first step (owner and agent names).
 *   - 'onboarding-claude-auth': POST /api/onboarding/claude-auth. The wizard stores the Claude credential the fleet
 *     runs on; nothing works before it. ONLY while no Claude credential is stored yet (the call site checks
 *     noClaudeCredentialYet: none where claudeAuthPresent looks, none of its files unreadable); replacing one is strict.
 *   - 'claude-plans-login': the plan login (routes/claude-plans-login.ts). The first Claude login of the install.
 *     ONLY while the install has no plan at all yet, the first plan (the call site checks noPlanExistsYet: no registry
 *     entry, no plan token in the vault; unreadable counts as one). A further plan could be the rotate target.
 *   - 'first-login': POST /api/auth/users. Creating the FIRST dashboard login; without this path a login could
 *     never be created from the dashboard, and every refuseOwner answer sends the user here.
 *   - 'first-device': POST /api/security/bridge-enroll and POST /api/auth/device-keys (mint). Pairing the owner's
 *     first device (the Bridge); only while no device key was ever issued on this install (deviceKeyEverIssued). */
export const FIRST_RUN_PATHS = [
  'agent-create',
  'channel-setup',
  'first-pairing',
  'onboarding-identity',
  'onboarding-claude-auth',
  'claude-plans-login',
  'first-login',
  'first-device',
] as const

export type FirstRunPath = (typeof FIRST_RUN_PATHS)[number]

/** OWNERGATE4-1104: the shared token as the owner while no dashboard login exists. Only the shared token (never a
 *  sub-agent's own token), only with zero dashboard users (counted with the disabled ones: a disabled account still
 *  means a login was set up, so it must not reopen this path). Its single caller is mayActAsOwnerOrFirstRun. */
function firstRunSharedToken(auth: RouteContext['auth']): boolean {
  if (auth?.kind !== 'token' || auth.tokenAgent) return false
  return countDashboardUsers(true) === 0
}

/** OWNERGATE4-1104: mayActAsOwner, plus the first-run setup for the closed list of paths in FIRST_RUN_PATHS.
 *  Why first-run exists: on a fresh customer install no dashboard login exists yet, so no request can carry the
 *  owner's proof, and the shared token is the one credential there is. The onboarding wizard (identity, Claude
 *  credential, first agent, its channel, the owner's pairing), creating the first login and pairing the first device
 *  must work then. Everything else waits for the login (mayActAsOwner, refuseOwner says to create one).
 *  Passes when mayActAsOwner passes; or when the caller is the shared token (kind 'token', not a sub-agent's token)
 *  and no dashboard user exists. For 'first-device' additionally no device key may ever have been issued on this
 *  install (revoked and expired ones count: a key that existed means a device was already paired; fail closed).
 *  For 'first-login' also a FULL device key while no dashboard user exists: the window the first device pairing
 *  opened (the Bridge) holds that key and no token, and it is where the dashboard offers to create the login. The
 *  key could only be issued by the first-device path or by the owner, so it adds nothing the token cannot already do
 *  here. Each first-run pass writes one audit line { why, path, method } (no credential in it). */
export function mayActAsOwnerOrFirstRun(auth: RouteContext['auth'], req: http.IncomingMessage | undefined, why: FirstRunPath): boolean {
  if (mayActAsOwner(auth, req)) return true
  let firstRun = firstRunSharedToken(auth)
  if (!firstRun && why === 'first-login') {
    firstRun = auth?.kind === 'device' && auth.scope === 'full' && countDashboardUsers(true) === 0
  }
  if (firstRun && why === 'first-device' && deviceKeyEverIssued()) firstRun = false
  if (!firstRun) return false
  logger.info({ why, path: req?.url?.split('?')[0], method: req?.method, auth: auth?.kind }, 'owner action on the first-run setup: no dashboard login exists yet')
  return true
}

/** BRIDGEFIRSTLOGIN1106: the owner's notice when the first dashboard login is created with a device key. Names the
 *  login and the device, never a credential. */
export function firstLoginNotice(username: string, device: string): string {
  return `[Biztonság] Létrejött az első dashboard-belépés (${username}) egy eszközkulccsal${device ? ` (eszköz: ${device})` : ''}. ` +
    'Ha nem te hoztad létre a Bridge-ből, a géphez férő valaki tette: a gépen töröld a belépést ' +
    `(npm run dashboard-user -- remove ${username}), és vond vissza az eszközkulcsokat (npm run dashboard-user -- security:reset).`
}

export const CLI_RECOVERY_ONLY = {
  error: 'Resetting a password needs the dashboard login and the current password. Without them, recover on the machine itself: npm run dashboard-user -- reset-password <username>.',
  code: 'cli_recovery_only',
}

export const OWNER_SESSION_REQUIRED = {
  error: 'This needs the dashboard login (an owner session). The access token can do it only before the first login exists; on the machine itself, npm run dashboard-user is the break-glass.',
  code: 'owner_session_required',
}

/** OWNERGATE2-1104: the error text when a strict owner gate refuses and no dashboard login exists yet. Then no
 *  request can carry the owner's proof, so the per-route text ("needs the dashboard login") would send the user to a
 *  login that is not there: the login has to be created first. */
export const OWNER_LOGIN_SETUP_REQUIRED_ERROR = 'This needs the dashboard login (an owner session), and no dashboard login exists yet. Create one first: Settings, Security, dashboard login. Then sign in and try again.'

/** OWNERGATE2-1104: the 403 an owner gate (mayActAsOwner) answers with. Always code owner_session_required,
 *  so every client that keys on the code keeps working; the per-route error text unless no dashboard login exists, in
 *  which case setup_required: true and OWNER_LOGIN_SETUP_REQUIRED_ERROR say to create one first. `extra` carries
 *  route-specific fields (e.g. `fields`). */
export function refuseOwner(res: http.ServerResponse, msg: string = OWNER_SESSION_REQUIRED.error, extra: Record<string, unknown> = {}): void {
  const setup = countDashboardUsers(true) === 0
  json(res, {
    ...OWNER_SESSION_REQUIRED,
    error: msg,
    ...extra,
    ...(setup ? { setup_required: true, error: OWNER_LOGIN_SETUP_REQUIRED_ERROR } : {}),
  }, 403)
}

const DEVICE_KEY_NAME_RE = /^[\p{L}\p{N} ._-]{1,64}$/u
const DEVICE_KEY_MAX_EXPIRY_DAYS = 3650

// { authenticated, method, user, device, login_available, setup_required }.
// authenticated keeps its exact old meaning for token callers (existing probes
// parse only that field): a valid bearer -> authenticated:true. A device key is
// an authenticated principal too (method:'device', device:<key name>).
// owner_session (BRIDGEPWLOGIN1101, Samu 64763): whether the owner's password session rides on THIS request (a
// session principal, or a valid owner cookie beside the bearer). A bool only (no id, no expiry), and only for a caller
// that could hold one: absent for an anonymous caller, an operator key and a sub-agent token. The Bridge reads it to
// offer the password login once per run.
function statusPayload(auth: RouteContext['auth'], req?: http.IncomingMessage) {
  const authenticated = auth?.kind === 'token' || auth?.kind === 'session' || auth?.kind === 'device'
  const method = authenticated ? auth!.kind : null
  const user = auth?.kind === 'session' ? auth.user ?? null : null
  const device = auth?.kind === 'device' ? auth.device ?? null : null
  const mayHoldOwner = auth?.kind === 'session' || (auth?.kind === 'token' && !auth.tokenAgent) || (auth?.kind === 'device' && auth.scope === 'full')
  return {
    authenticated,
    method,
    user,
    device,
    ...(mayHoldOwner ? { owner_session: auth?.kind === 'session' || ownerCookieSession(req) !== null } : {}),
    login_available: countDashboardUsers(false) >= 1,
    setup_required: countDashboardUsers(true) === 0,
  }
}

export async function tryHandleAuth(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, auth } = ctx

  if (path === '/api/auth/status' && method === 'GET') {
    json(res, statusPayload(auth, req))
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
    } else if (auth?.kind === 'token') {
      // The token cannot reset a password: it cannot tell the owner apart from
      // anything else that holds it. Recovery is the machine-local CLI.
      logger.warn({ agent: auth.agent }, 'password reset via bearer token refused (recovery is the CLI)')
      json(res, CLI_RECOVERY_ONLY, 403)
      return true
    } else {
      json(res, FORBIDDEN_KIND, 403)
      return true
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
    if (!kindAllowed(auth, USER_ADMIN_KINDS) && !bridgeOwner(auth, req)) {
      json(res, FORBIDDEN_KIND, 403)
      return true
    }
    // The usernames are the first half of a password guess, so the list takes the owner's session too
    // (DEVKEYFOLLOW1022). OWNERGATE4-1104: before the first login there is no user to list, and refuseOwner says so.
    if (!mayActAsOwner(auth, req)) {
      refuseOwner(res, 'Listing the dashboard logins needs the dashboard login (an owner session).')
      return true
    }
    json(res, { users: listDashboardUsers() })
    return true
  }

  if (path === '/api/auth/users' && method === 'POST') {
    // OWNERGATE4-1104: before the first login a FULL device key may create it (the Bridge window the first pairing
    // opened holds no token); the kind check lets it through to the owner gate, which decides ('first-login').
    const firstLoginKey = auth?.kind === 'device' && auth.scope === 'full' && countDashboardUsers(true) === 0
    if (!kindAllowed(auth, USER_ADMIN_KINDS) && !bridgeOwner(auth, req) && !firstLoginKey) {
      json(res, FORBIDDEN_KIND, 403)
      return true
    }
    // ONBOARDOWNERPW1107: which branch let the request through is decided ONCE, here (mayActAsOwner writes its audit
    // line on a pass, so it is not asked twice): the owner's proof, or the first-run pass, which holds only while no
    // login exists and is counted again right before the insert below.
    const asOwner = mayActAsOwner(auth, req)
    if (!asOwner && !mayActAsOwnerOrFirstRun(auth, req, 'first-login')) {
      json(res, OWNER_SESSION_REQUIRED, 403)
      return true
    }
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
    // ONBOARDOWNERPW1107: the first-run pass was decided when the request arrived; the body read and the hash were
    // awaited since. It holds only while no login exists, so count again here, AFTER the last await and right before
    // the (synchronous, better-sqlite3) insert: two racing windows create one first login, and a request that held
    // its body open is refused once a login exists. The owner's proof (asOwner) needs no recount.
    if (!asOwner && countDashboardUsers(true) !== 0) {
      json(res, OWNER_SESSION_REQUIRED, 403)
      return true
    }
    let created: ReturnType<typeof createDashboardUser>
    try {
      created = createDashboardUser(username, hash)
    } catch (err) {
      // The same name added twice at once: the UNIQUE index answers, as a 409 like the check above, not a 500.
      if ((err as { code?: string })?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        json(res, { error: 'User already exists' }, 409)
        return true
      }
      throw err
    }
    logger.info({ username: created.username }, 'dashboard user created')
    // BRIDGEFIRSTLOGIN1106: the first login made with a device key (the first-run branch: a key, no owner session) is
    // told to the owner's channel, Slack first (notifySecurityEvent -> notifyOwner). With no channel set up yet (a
    // fresh install often has none) the notice is silent by design and the audit lines are the record: the first-run
    // one (mayActAsOwnerOrFirstRun) and this one.
    if (auth?.kind === 'device' && ownerCookieSession(req) === null) {
      logger.info({ username: created.username, device: auth.device }, 'the first dashboard login was created with a device key')
      void notifySecurityEvent(firstLoginNotice(created.username, String(auth.device ?? '')))
    }
    json(res, { ok: true, user: { id: created.id, username: created.username } }, 201)
    return true
  }

  if (path === '/api/auth/device-keys' && method === 'GET') {
    if (!kindAllowed(auth, DEVICE_KEY_ADMIN_KINDS) && !bridgeOwner(auth, req)) {
      json(res, FORBIDDEN_KIND, 403)
      return true
    }
    json(res, { keys: listDeviceKeys() })
    return true
  }

  if (path === '/api/auth/device-keys' && method === 'POST') {
    if (!kindAllowed(auth, DEVICE_KEY_ADMIN_KINDS) && !bridgeOwner(auth, req)) {
      json(res, FORBIDDEN_KIND, 403)
      return true
    }
    // OWNERGATE4-1104: before the first login the shared token mints only the FIRST device key ('first-device').
    if (!mayActAsOwnerOrFirstRun(auth, req, 'first-device')) {
      refuseOwner(res, 'Issuing a device key needs the dashboard login (an owner session).')
      return true
    }
    let body: Record<string, unknown>
    try {
      body = await parseJsonBody(req)
    } catch {
      json(res, { error: 'Invalid JSON' }, 400)
      return true
    }
    const name = str(body.name).trim()
    if (!DEVICE_KEY_NAME_RE.test(name)) {
      json(res, { error: 'Invalid device name (1-64 chars: letters, digits, space, . _ -)' }, 400)
      return true
    }
    // DASHOPERATOR1005: an 'operator' key reaches /api/operator/* only and MUST
    // expire (90 days unless set); asking for one without an end date is a 400.
    const scope = body.scope === undefined ? 'full' : body.scope
    if (!(DEVICE_KEY_SCOPES as readonly unknown[]).includes(scope)) {
      json(res, { error: `Invalid scope (${DEVICE_KEY_SCOPES.join(' | ')})` }, 400)
      return true
    }
    if (scope === 'operator' && (body.expires_in_days === 0 || body.expires_in_days === null)) {
      json(res, { error: 'An operator key must expire' }, 400)
      return true
    }
    // Expiry is opt-in for a full key: absent/0 means it lives until revoked.
    let expiresInDays: number | undefined = scope === 'operator' ? OPERATOR_KEY_DEFAULT_EXPIRY_DAYS : undefined
    if (body.expires_in_days !== undefined && body.expires_in_days !== null && body.expires_in_days !== 0) {
      const n = Number(body.expires_in_days)
      // An operator key has its own, shorter ceiling (a year); a full key keeps 3650.
      const maxDays = scope === 'operator' ? OPERATOR_KEY_MAX_EXPIRY_DAYS : DEVICE_KEY_MAX_EXPIRY_DAYS
      if (!Number.isFinite(n) || n <= 0 || n > maxDays) {
        json(res, { error: `Invalid expires_in_days (1-${maxDays})` }, 400)
        return true
      }
      expiresInDays = n
    }
    const minted = createDeviceKey(name, { expiresInDays, scope: scope as DeviceKeyScope })
    logger.info({ id: minted.id, name: minted.name, expiresAt: minted.expiresAt, scope: minted.scope }, 'device key minted')
    // `key` is the one and only disclosure of the raw credential.
    json(res, { ok: true, id: minted.id, name: minted.name, key: minted.key, created_at: minted.createdAt, expires_at: minted.expiresAt, scope: minted.scope }, 201)
    return true
  }

  const deviceKeyMatch = /^\/api\/auth\/device-keys\/(\d+)$/.exec(path)
  if (deviceKeyMatch && method === 'DELETE') {
    if (!kindAllowed(auth, DEVICE_KEY_ADMIN_KINDS) && !bridgeOwner(auth, req)) {
      json(res, FORBIDDEN_KIND, 403)
      return true
    }
    // Every lane passes the owner gate (DEVKEYREVOKETOKEN1104). Revoking a key can lock the owner out of their own
    // Bridge (and drops its SSH line), so the shared access token alone is not enough once a dashboard login exists:
    // every sub-agent can read that token. The browser login (session), the token with the owner's session cookie
    // beside it, and the Bridge's full key with that cookie pass; before the first login nothing does
    // (OWNERGATE4-1104, refuseOwner says to create the login). On the device lane it also writes the audit line
    // naming the owner (Dani 65912 (2)).
    if (!mayActAsOwner(auth, req)) {
      refuseOwner(res, 'Revoking a device key needs the dashboard login (an owner session).')
      return true
    }
    const id = Number(deviceKeyMatch[1])
    const key = getDeviceKey(id)
    if (!key || !revokeDeviceKey(id)) {
      json(res, { error: 'Device key not found' }, 404)
      return true
    }
    // Bridge-paired key: revoke means BOTH halves at once -- the dashboard
    // key (above) and the SSH authorized_keys line. Idempotent on the SSH
    // side; a failure there must not resurrect the already-revoked key, so it
    // is reported, not rolled back.
    let sshRemoved: boolean | undefined
    if (key.installId) {
      try {
        sshRemoved = await removeBridgeSshAccess(key.installId)
      } catch (err) {
        logger.error({ err, id, installId: key.installId }, 'device key revoked but authorized_keys removal failed')
        sshRemoved = false
      }
      logConfigChange('security.bridge_revoke', null, `${key.name} (${key.installId}) ssh_removed=${sshRemoved}${sshDirOverride() ? ' sshdir_override=1' : ''}`, auth!.kind === 'device' ? `bridge:${ownerCookieSession(req) ?? '?'}` : auth!.kind)
    }
    logger.info({ id, name: key.name, installId: key.installId ?? undefined, sshRemoved }, 'device key revoked')
    json(res, { ok: true, ...(key.installId ? { ssh_removed: sshRemoved } : {}) })
    return true
  }

  const delMatch = /^\/api\/auth\/users\/([^/]+)$/.exec(path)
  if (delMatch && method === 'DELETE') {
    if (!kindAllowed(auth, USER_ADMIN_KINDS) && !bridgeOwner(auth, req)) {
      json(res, FORBIDDEN_KIND, 403)
      return true
    }
    if (!mayActAsOwner(auth, req)) {
      refuseOwner(res, 'Removing a dashboard login needs the dashboard login (an owner session).')
      return true
    }
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
