// GROMZOOWNERQR1030 (+ MOBILRELOGINDASH1025): the dashboard's Gromzo panel.
//
//   GET  /api/gromzo/status    -> mxd's state for the panel (running / linked)
//   POST /api/gromzo/owner-qr  -> the owner's QR code: the first registration's join
//                                 code, or, once the owner is registered, the login
//                                 code for a new phone (see mxd-dash.ts requestOwnerQr)
//
// Who may ask for the QR: ONLY the owner's dashboard session. This is stricter than
// issuing a device key (routes/auth.ts mayIssueCredentials, DEVKEYMINT1022), which
// lets the shared token in before the first dashboard login exists. Here that
// first-run branch is closed on purpose (Dani's review of #2365): the shared bearer
// is held by every fleet agent, and the first owner_invite claims the owner's chat
// seat on the controller once. On a fresh install the owner first sets up the
// dashboard login, then asks for the QR.
//
// The global Origin gate (csrf-origin) refuses a foreign-origin POST before this
// runs; the POST here also refuses a non-JSON body (415), as video-review does.
//
// The secret: written into this one response, inside `uri`, with no-store. Never
// logged (only the kind and the lifetime are), never in the URL, never stored.

import type http from 'node:http'
import { logger } from '../../logger.js'
import { json, methodNotAllowed, readBody } from '../http-helpers.js'
import { parseCookies, SESSION_COOKIE_NAME } from '../auth-gate.js'
import { resolveSession } from '../auth-sessions.js'

/** The 403 body. Same code as auth.ts OWNER_SESSION_REQUIRED (the panel keys its
 *  sentence on it), but its own text: that one says the token works before the
 *  first login, which is not true here. */
export const OWNER_QR_SESSION_REQUIRED = {
  error: "The owner QR needs the owner's dashboard login. The access token never gets it, not even before the first login exists: set up the dashboard login first.",
  code: 'owner_session_required',
}
import { mxdDashCall, MxdDashError, requestOwnerQr, type MxdDashCall, type OwnerQr } from '../mxd-dash.js'
import type { RouteContext } from './types.js'

/** The owner's dashboard session, and nothing else: a session principal, or the
 *  shared token sent alongside a valid session cookie (a logged-in owner whose
 *  browser also keeps the access token). Never the bare token, not even before the
 *  first login exists; never a sub-agent token, a device key or a federation peer. */
export function isOwnerSession(auth: RouteContext['auth'], req: http.IncomingMessage): boolean {
  if (auth?.kind === 'session') return true
  if (auth?.kind !== 'token' || auth.tokenAgent) return false
  const cookie = parseCookies(req.headers.cookie)[SESSION_COOKIE_NAME]
  return !!cookie && resolveSession(cookie) !== null
}

const STATUS_PATH = '/api/gromzo/status'
const OWNER_QR_PATH = '/api/gromzo/owner-qr'

/** The dash.sock client (the socket path is read per call: MXD_DASH_SOCK or the default). */
const call: MxdDashCall = (request) => mxdDashCall(request)

/** The HTTP status for a failure code (transport or mxd). The body carries the code;
 *  the panel turns it into a sentence (web/lang gromzo.err.*). */
export function httpStatusFor(code: string): number {
  switch (code) {
    case 'rate_limited': return 429
    case 'not_running':
    case 'no_access':
    case 'forbidden':
      return 503
    case 'timeout': return 504
    case 'not_linked':
    case 'consent_required':
    case 'invite_outstanding':
    case 'owner_invite_already_issued':
    case 'owner_invite_used':
    case 'no_owner':
    case 'identity_reset_in_progress':
    case 'team_lapsed':
    case 'team_unknown':
    case 'revoked':
      return 409
    case 'test_guard': return 500
    default: return 502
  }
}

function isJsonRequest(req: http.IncomingMessage): boolean {
  const ct = String(req.headers['content-type'] ?? '').toLowerCase()
  return ct.split(';')[0]!.trim() === 'application/json'
}

/** The one response that carries a secret. Its headers are set HERE, explicitly,
 *  so no shared helper's later change can make the browser or a proxy keep it. */
function sendOwnerQr(res: http.ServerResponse, qr: OwnerQr): void {
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, max-age=0',
    Pragma: 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(JSON.stringify({ kind: qr.kind, uri: qr.uri, expires_in: qr.expires_in }))
}

function failure(res: http.ServerResponse, code: string): void {
  json(res, { error: code }, httpStatusFor(code))
}

export async function tryHandleGromzo(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, auth } = ctx
  if (path !== STATUS_PATH && path !== OWNER_QR_PATH) return false

  if (path === STATUS_PATH) {
    if (method !== 'GET') { methodNotAllowed(res, method, ['GET']); return true }
    try {
      const r = await call({ verb: 'status' })
      if (r.ok !== true) {
        const code = typeof r.error === 'string' && /^[a-z0-9_]{1,40}$/.test(r.error) ? r.error : 'refused'
        json(res, { available: false, code })
        return true
      }
      json(res, { available: true, running: r.running === true, linked: r.linked === true })
    } catch (e) {
      const code = e instanceof MxdDashError ? e.code : 'io'
      json(res, { available: false, code })
    }
    return true
  }

  // OWNER_QR_PATH
  if (method !== 'POST') { methodNotAllowed(res, method, ['POST']); return true }
  if (!isJsonRequest(req)) { json(res, { error: 'content_type_must_be_json' }, 415); return true }
  // Drain the (empty) body; nothing in it is used.
  try { await readBody(req, { maxBytes: 1024 }) } catch { json(res, { error: 'body_too_large' }, 413); return true }
  if (!isOwnerSession(auth, req)) {
    logger.warn({ kind: auth?.kind }, 'gromzo: owner QR refused (needs the owner session)')
    json(res, OWNER_QR_SESSION_REQUIRED, 403)
    return true
  }
  let result
  try {
    result = await requestOwnerQr(call)
  } catch (e) {
    const code = e instanceof MxdDashError ? e.code : 'io'
    logger.warn({ code }, 'gromzo: owner QR failed (dash.sock)')
    failure(res, code)
    return true
  }
  if (!result.ok) {
    logger.warn({ code: result.code }, 'gromzo: owner QR refused by mxd')
    failure(res, result.code)
    return true
  }
  logger.info({ kind: result.qr.kind, expires_in: result.qr.expires_in }, 'gromzo: owner QR issued (the secret is not logged)')
  sendOwnerQr(res, result.qr)
  return true
}
