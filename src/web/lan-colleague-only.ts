// LAN colleague-only mode (docs/board-access.md, "Reaching it from the office network").
//
// Once WEB_HOST is opened to the LAN for the colleague board login, the whole
// dashboard would be reachable from the network over plain HTTP: the owner's
// login page, the owner's session cookie, and the API for anyone holding the
// token. This gate closes that: a connection that does NOT come from this
// machine (loopback) reaches the colleague surface only:
//
//   the colleague page and its static files   (COLLEAGUE_STATIC_PATHS)
//   /api/colleague/*                           its login, logout and "who am I"
//   /api/board, /api/board/*                   the scoped board, colleague sessions only
//
// Two checks, both in web.ts:
//   1. lanPathDecision, BEFORE the CORS/CSRF handling and the auth gate: any
//      other path is refused before a handler, the owner login included, so a
//      LAN caller can neither use up the owner's login throttle nor send the
//      owner's password over the wire.
//   2. lanPrincipalDecision, right AFTER the auth gate: on an allowed path, the
//      principal must be a colleague session or nobody (the colleague login
//      itself). The shared token, a device key, a federation token or the
//      owner's own session coming over the LAN are refused, so /api/board can
//      never be driven as some other person from the network.
//
// When it applies (lanColleagueOnlyMode):
//   DASHBOARD_LAN_COLLEAGUE_ONLY=1      always (a loopback connection is never affected)
//   DASHBOARD_LAN_COLLEAGUE_ONLY=0      never (the owner's explicit choice; logged at start)
//   unset / "auto" / anything else      when WEB_HOST is not loopback AND the colleague
//                                       accounts file exists, i.e. as soon as the colleague
//                                       login is in use on a network-facing dashboard
//
// "auto" does not switch on for a WEB_HOST=0.0.0.0 install WITHOUT colleague
// accounts on purpose: the installer suggests that bind for reaching a VPS
// install remotely, and those owners would otherwise be locked out of their own
// dashboard by an update. Their exposure is unchanged by this module.
//
// Loopback is a fact of the socket (req.socket.remoteAddress), never of a
// header (X-Forwarded-For) a client could forge. A missing address counts as
// NOT loopback (fail closed). A reverse proxy on this machine (Tailscale Serve,
// a local Caddy) connects from loopback and is therefore treated as local:
// that is the owner's own, separately decided exposure. The Docker public
// listener (public-access.ts, HTTPS, cookies only) is likewise exempt.

import { isBoardPath } from './board-access.js'
import { COLLEAGUE_API_PREFIX, COLLEAGUE_PAGE_PATH, COLLEAGUE_STATIC_PATHS } from './colleague-gate.js'

export const LAN_COLLEAGUE_ONLY_ENV = 'DASHBOARD_LAN_COLLEAGUE_ONLY'

export type LanColleagueOnlySetting = 'on' | 'off' | 'auto'

export function parseLanColleagueOnlySetting(raw: string | undefined): LanColleagueOnlySetting {
  const v = (raw ?? '').trim().toLowerCase()
  if (v === '1' || v === 'true' || v === 'on' || v === 'yes') return 'on'
  if (v === '0' || v === 'false' || v === 'off' || v === 'no') return 'off'
  return 'auto'
}

/** True for a bind host that only this machine can reach. */
export function isLoopbackBindHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h === '::1') return true
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
}

/** True when the connection came from this machine. Missing or unparsable: false (fail closed). */
export function isLoopbackRemote(remoteAddress: string | undefined | null): boolean {
  if (!remoteAddress) return false
  const a = remoteAddress.trim().toLowerCase()
  if (a === '::1') return true
  const v4 = a.startsWith('::ffff:') ? a.slice('::ffff:'.length) : a
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4)
}

/** Whether non-loopback connections are confined to the colleague surface right now. */
export function lanColleagueOnlyActive(setting: LanColleagueOnlySetting, webHost: string, colleagueAccountsExist: () => boolean): boolean {
  if (setting === 'on') return true
  if (setting === 'off') return false
  if (isLoopbackBindHost(webHost)) return false
  return colleagueAccountsExist()
}

export type LanGateResult =
  | null
  | { status: 403; reason: string }
  | { status: 302; location: string }

function canonicalPath(path: string): string {
  let p = path
  try { p = decodeURIComponent(path) } catch { /* keep raw */ }
  return p.toLowerCase().replace(/\/{2,}/g, '/')
}

/**
 * Check 1, on the path alone, before CORS, CSRF and auth. Same rule as the colleague gate: the raw path must already
 * be canonical (no dot segments either), so a spelling variant no colleague handler matches can never pass here and land on another handler.
 */
export function lanPathDecision(path: string, method: string): LanGateResult {
  const canonical = canonicalPath(path)
  // web.ts takes the path from new URL(), which already resolves dot segments; refusing them here as well keeps the
  // rule safe for any caller that hands over a raw path.
  const exact = canonical === path && !/(^|\/)\.{1,2}(\/|$)/.test(canonical)
  const isApi = canonical === '/api' || canonical.startsWith('/api/') || path.startsWith('/api/')
  if (isApi) {
    if (exact && (isBoardPath(path) || path.startsWith(COLLEAGUE_API_PREFIX))) return null
    return { status: 403, reason: 'from the network, only /api/board and /api/colleague are reachable' }
  }
  if (exact && COLLEAGUE_STATIC_PATHS.has(path)) return null
  const m = method.toUpperCase()
  if (m === 'GET' || m === 'HEAD') return { status: 302, location: COLLEAGUE_PAGE_PATH }
  return { status: 403, reason: 'from the network, only the colleague board page is reachable' }
}

/** Check 2, after auth: from the network only a colleague session, or nobody (the colleague login), may proceed. */
export function lanPrincipalDecision(authKind: string): LanGateResult {
  if (authKind === 'colleague' || authKind === 'none') return null
  return { status: 403, reason: 'from the network, only a colleague board login is accepted' }
}
