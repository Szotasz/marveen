// The colleague LAN lock (COLLANLOCK1120, Refs #2929; docs/board-access.md, "LAN lock").
//
// The colleague board login (#2929) is meant to be reached from the LAN. With WEB_HOST opened for it, the owner's
// login and cookie session would cross the LAN over plain HTTP too, and anyone there could use up the owner login's
// global failure cap. While this lock is ACTIVE, a request from a non-loopback peer on the plain listener is decided
// before authentication: the colleague surface (the set the colleague gate allows a colleague session: /api/colleague/*,
// /api/board*, the colleague page and its static files) passes with only its own mv_colleague cookie (COLLCOOKIE1121: an
// owner mv_session held on the LAN would otherwise resolve as the owner on /api/board*); the browser login routes (owner password,
// TOTP, setup code, operator key) are refused, so the owner login cannot even be tried from the LAN; every other request
// goes on to the normal gate with ALL its cookies dropped, so only a credential in a header or the query (Bearer /
// agent token, device key, federation token, the Teams bot token) can authenticate it. Federation, the Teams webhook
// and Bridge devices keep working; the owner's browser does not get in from the LAN. Machine tokens still cross plain
// HTTP unencrypted: that is the TLS question, an owner decision outside this lock. The WEB_PUBLIC_PORT listener (HTTPS
// behind Caddy, cookies only) has its own protection and is not locked.
//
// Active (COLLEAGUE_LAN_LOCK):
//   on   always
//   off  never
//   auto (default) only while the colleague login is in use: WEB_HOST is not loopback, at least one colleague account
//        is enabled, and the scoped board is on. Otherwise nothing changes, so an install that opened WEB_HOST for its
//        own remote access (Docker, a VPS) keeps working until it creates a colleague account.
// off, and on -> auto, loosen the lock (config-registry `loosens`): only an owner session sets them, and a loosening
// .env line is ignored. process.env is never read for it.
//
// The peer is req.socket.remoteAddress, never a header (X-Forwarded-For and friends are written by the caller). An
// IPv4-mapped IPv6 loopback (::ffff:127.0.0.1) is loopback. A proxy on the same machine (Tailscale Serve, an SSH
// tunnel) arrives from loopback and is therefore not locked: those are the owner's ways in while the lock is active.

import type http from 'node:http'
import { getEffectiveSettingValue } from '../settings-store.js'
import { readBoardAccess } from './board-access.js'
import { readColleagueAccounts } from './colleague-accounts.js'
import { colleagueGateDecision, type ColleagueGateResult } from './colleague-gate.js'
import { parseCookies } from './auth-gate.js'
import { COLLEAGUE_COOKIE_NAME } from './colleague-sessions.js'

export type LanLockMode = 'auto' | 'on' | 'off'

/** The setting, from the settings store only (override, else a tightening .env line, else the default). Unknown -> auto. */
export function readLanLockMode(
  read: () => string | undefined = () => {
    try { return String(getEffectiveSettingValue('COLLEAGUE_LAN_LOCK') ?? '') } catch { return undefined }
  },
): LanLockMode {
  const v = (read() ?? '').trim().toLowerCase()
  return v === 'on' || v === 'off' ? v : 'auto'
}

function isLoopbackAddress(a: string): boolean {
  const v = a.trim().toLowerCase()
  if (v === '::1' || v === 'localhost') return true
  const v4 = v.startsWith('::ffff:') ? v.slice(7) : v
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4)
}

/** Is the bind address a loopback one (127.0.0.0/8, ::1, localhost)? 0.0.0.0, :: or a LAN address is not. */
export function isLoopbackHost(host: string): boolean {
  return isLoopbackAddress(host)
}

/** Is the connection's peer loopback? A missing address (a closed socket) is not. */
export function isLoopbackPeer(remoteAddress: string | undefined): boolean {
  return typeof remoteAddress === 'string' && remoteAddress !== '' && isLoopbackAddress(remoteAddress)
}

export interface LanLockInputs {
  mode: LanLockMode
  webHost: string
  /** At least one colleague account that is not disabled. */
  colleagueInUse: boolean
  /** board-access.json readable and enabled. */
  boardOn: boolean
}

export function lanLockActive(i: LanLockInputs): boolean {
  if (i.mode === 'on') return true
  if (i.mode === 'off') return false
  return !isLoopbackHost(i.webHost) && i.colleagueInUse && i.boardOn
}

/**
 * The live answer, read lazily: the setting first, then the bind address, and the accounts file and the board config
 * only when they can still decide it (auto with a non-loopback bind). Same rule as lanLockActive.
 */
export function lanLockActiveNow(webHost: string): boolean {
  const mode = readLanLockMode()
  if (mode !== 'auto') return mode === 'on'
  if (isLoopbackHost(webHost)) return false
  const accounts = readColleagueAccounts()
  const colleagueInUse = !accounts.broken && [...accounts.accounts.values()].some((a) => !a.disabled)
  if (!colleagueInUse) return false
  const board = readBoardAccess()
  return lanLockActive({ mode, webHost, colleagueInUse, boardOn: board.enabled && !board.broken })
}

/** The browser login routes: they take a password, a TOTP code, a setup code or an operator key in the body and mint a
 *  browser cookie. Refused outright from the LAN while the lock is active (the cookie would be ignored there anyway). */
export const LAN_LOCK_LOGIN_ROUTES: ReadonlySet<string> = new Set([
  '/api/auth/login',
  '/api/auth/login/totp',
  '/api/auth/setup-code',
  '/api/operator/login',
])

export interface LanLockRequest {
  req: Pick<http.IncomingMessage, 'socket'>
  path: string
  method: string
  /** The request came in on the WEB_PUBLIC_PORT listener (public-access.ts): its own protection, not locked. */
  publicListener: boolean
}

export type LanLockAction =
  | { action: 'pass' }
  | { action: 'deny'; result: Exclude<ColleagueGateResult, null> }
  | { action: 'strip-cookies' }
  | { action: 'colleague-cookie-only' }

/**
 * Decided BEFORE authentication (Samu 82477, Dani 82480), on the socket's own peer:
 *   pass           loopback, the public listener, or the lock not active
 *   colleague-cookie-only  the colleague surface: it goes on with the mv_colleague cookie alone (COLLCOOKIE1121), so an
 *                  owner, operator or setup cookie held on the LAN cannot resolve there ahead of it
 *   deny           a browser login route (password, TOTP, setup code, operator key), refused with 403
 *   strip-cookies  everything else: the request goes on to the normal gate WITHOUT any cookie, so only a credential in a
 *                  header or the query (Bearer / agent token, a device key, the ?token= SSE key, a federation token, the
 *                  Teams bot token) can authenticate it. The lock validates nothing itself; the gate does.
 * `active` is asked only when the answer could be other than pass, so a loopback request costs no file read.
 */
export function lanLockPreAuth(r: LanLockRequest, active: () => boolean): LanLockAction {
  if (r.publicListener) return { action: 'pass' }
  if (isLoopbackPeer(r.req.socket?.remoteAddress)) return { action: 'pass' }
  if (!active()) return { action: 'pass' }
  if (colleagueGateDecision({ kind: 'colleague' }, r.path, r.method) === null) return { action: 'colleague-cookie-only' }
  if (LAN_LOCK_LOGIN_ROUTES.has(r.path)) {
    return {
      action: 'deny',
      result: { status: 403, reason: 'the colleague LAN lock is active: the owner login is not available from this network' },
    }
  }
  return { action: 'strip-cookies' }
}

/** colleague-cookie-only: the Cookie header keeps the mv_colleague pair alone (the first one, as the gate reads it), or is
 *  removed when there is none. */
export function keepOnlyColleagueCookie(headers: http.IncomingHttpHeaders): void {
  const v = parseCookies(headers.cookie)[COLLEAGUE_COOKIE_NAME]
  if (v) headers.cookie = `${COLLEAGUE_COOKIE_NAME}=${v}`
  else delete headers.cookie
}

/** What an active lock takes away from a non-loopback peer on the plain listener, for the startup warning and the doc. */
export const LAN_LOCK_CUT_OFF = [
  'the owner login (password, TOTP, setup code) and the operator login',
  'every browser cookie but the colleague one: the owner session, the operator page session, the setup cookie',
  'so the owner\'s browser access to the dashboard from the LAN',
] as const
