// The server-side fence around a colleague session (docs/board-access.md,
// "Colleague login").
//
// Decided in web.ts right after the principal is resolved and BEFORE any
// handler runs, for EVERY path (gated or public, /api or not). A colleague
// session may reach:
//
//   /api/colleague/*   its own login, logout and "who am I" (routes/colleague.ts)
//   /api/board, /api/board/*   the scoped board, resolved to the session's person
//   a fixed set of static files: the colleague page, its script, the shared
//   stylesheet and the two language files
//
// Everything else is refused: any other /api/* path is 403, any other page
// (GET/HEAD) is a redirect to the colleague page, any other write is 403.
// Default deny by prefix on purpose: a route added later is closed to a
// colleague without anyone remembering to close it.
//
// The allow test runs on the RAW path and also requires that the raw path is
// already canonical (decoded, lower-case, single slashes). Every route handler
// matches the raw path, so a spelling variant such as /api/%62oard/cards or
// /API/BOARD/cards, which no board handler would recognise, can never be
// allowed here and then fall through to some other handler.
//
// Every other principal (token, owner session, device key, federation) is
// untouched by this gate.

import { isBoardPath } from './board-access.js'

export const COLLEAGUE_API_PREFIX = '/api/colleague/'
export const COLLEAGUE_PAGE_PATH = '/colleague'

/** Static files a colleague browser may load. Each holds no data; everything shown comes from the gated APIs. */
export const COLLEAGUE_STATIC_PATHS: ReadonlySet<string> = new Set([
  '/colleague',
  '/colleague.html',
  '/colleague.js',
  '/style.css',
  '/lang/hu.js',
  '/lang/en.js',
])

export type ColleagueGateResult =
  | null
  | { status: 403; reason: string }
  | { status: 302; location: string }

function canonicalPath(path: string): string {
  let p = path
  try { p = decodeURIComponent(path) } catch { /* keep raw */ }
  return p.toLowerCase().replace(/\/{2,}/g, '/')
}

export interface ColleagueGateAuth {
  kind: string
}

/** null = let it through; otherwise the refusal (403) or the redirect (302) to send. */
export function colleagueGateDecision(auth: ColleagueGateAuth, path: string, method: string): ColleagueGateResult {
  if (auth.kind !== 'colleague') return null
  const canonical = canonicalPath(path)
  const exact = canonical === path
  const isApi = canonical === '/api' || canonical.startsWith('/api/') || path.startsWith('/api/')
  if (isApi) {
    if (exact && (isBoardPath(path) || path.startsWith(COLLEAGUE_API_PREFIX))) return null
    return { status: 403, reason: 'a colleague session reaches only /api/board and /api/colleague' }
  }
  if (exact && COLLEAGUE_STATIC_PATHS.has(path)) return null
  const m = method.toUpperCase()
  if (m === 'GET' || m === 'HEAD') return { status: 302, location: COLLEAGUE_PAGE_PATH }
  return { status: 403, reason: 'a colleague session reaches only the colleague board page' }
}
