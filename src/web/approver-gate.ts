// DELEGAPPROVER1123: the server-side fence around an approver session (approver-access.ts).
//
// Decided in web.ts right after the principal is resolved and BEFORE any handler runs, for EVERY path. Default deny,
// like the colleague gate (colleague-gate.ts): a route added later is closed to an approver without anyone remembering
// to close it. An approver session may reach:
//
//   GET  /api/auth/status, POST /api/auth/login, POST /api/auth/login/totp, POST /api/auth/logout   its own sign-in
//   GET  /api/approvals/:id     a request it may decide (the route answers 404 otherwise)
//   PATCH /api/approvals/:id    the decision (mayApprove decides in the route)
//   a public page or static file (GET/HEAD of a path requiresAuth leaves open: they hold no data)
//
// Everything else is 403, including every owner route: an approver is never the owner. The allow test runs on the RAW
// path and also requires it to be canonical (decoded, lower-case, single slashes), so a spelling variant no handler
// recognises can never be allowed here and then fall through to another handler.

import { requiresAuth } from './auth-gate.js'

const APPROVER_AUTH_ROUTES: ReadonlySet<string> = new Set([
  'GET /api/auth/status',
  'POST /api/auth/login',
  'POST /api/auth/login/totp',
  'POST /api/auth/logout',
])

const APPROVAL_ID_PATH = /^\/api\/approvals\/[^/]+$/

function canonicalPath(path: string): string {
  let p = path
  try { p = decodeURIComponent(path) } catch { /* keep raw */ }
  return p.toLowerCase().replace(/\/{2,}/g, '/')
}

/** null = let it through; otherwise the reason of the 403. */
export function approverGateDecision(auth: { kind: string }, path: string, method: string): string | null {
  if (auth.kind !== 'approver') return null
  const m = method.toUpperCase()
  const canonical = canonicalPath(path)
  const exact = canonical === path
  const isApi = canonical === '/api' || canonical.startsWith('/api/') || path.startsWith('/api/')
  if (isApi) {
    if (exact && APPROVER_AUTH_ROUTES.has(`${m} ${path}`)) return null
    if (exact && APPROVAL_ID_PATH.test(path) && path !== '/api/approvals/teams-card-action' && (m === 'GET' || m === 'PATCH')) return null
    return 'an approver session reaches only its sign-in and the approval decision'
  }
  if ((m === 'GET' || m === 'HEAD') && !requiresAuth(path, m)) return null
  return 'an approver session reaches only its sign-in and the approval decision'
}
