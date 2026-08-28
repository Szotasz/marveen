// Authorization middleware: role resolution and permission enforcement.
//
// Sits after resolveAuth() in the request pipeline and enforces the
// Role/Permission model defined in rbac.ts. Design principles:
//
//   Fail-closed: any unexpected state (unknown auth kind, DB error) resolves
//   to a denial (401, 403, or 503), never to an accidental grant.
//
//   Additive: the existing resolveAuth() gate is untouched. This layer only
//   adds role + permission checking on top of the auth result.
//
//   Backward-compat: the dashboard bearer token (kind='token') maps to
//   'admin' role so every existing fleet curl call keeps working without
//   any configuration change.

import type http from 'node:http'
import { json } from './http-helpers.js'
import { hasPermission, resolveRequiredPermission } from './rbac.js'
import type { Role, Permission } from './rbac.js'
import type { AuthResult } from './auth-gate.js'

export type { Role, Permission }

// ── Role resolution ─────────────────────────────────────────────────────────
//
// Maps an AuthResult to a Role. This is the backward-compat layer: until the
// api_tokens table is populated, every existing token kind gets a sensible
// default role so nothing breaks.
//
// When the api_tokens table lookup lands (future step) this function will
// check the table first and only fall back to these defaults if the token
// is not found there.

export function resolveRole(auth: AuthResult): Role {
  switch (auth.kind) {
    case 'token':
      // DB-registered tokens carry their own role; the legacy file-token
      // fallback (no role field) defaults to admin for backward-compat.
      return auth.role ?? 'admin'
    case 'device':
      // Per-device fleet keys have agent-level access (read+write, own tenant).
      return 'agent'
    case 'session':
      // Session callers carry the role from dashboard_users (looked up in auth-gate
      // when the DB is available). Falls back to 'viewer' for unenrolled or
      // DB-less callers (e.g. in tests that don't pass a DB to resolveAuth).
      return auth.role ?? 'viewer'
    case 'federation':
      // Federated peers can read and write messages/manifests (agent scope).
      return 'agent'
    case 'none':
      // No credential -- role is irrelevant, the gate will 401 before checking.
      return 'viewer'
  }
}

// ── Permission check result ──────────────────────────────────────────────────

export type AuthzDecision =
  | { allowed: true; role: Role }
  | { allowed: false; status: 401 | 403 | 503; reason: string }

// ── Core authorization check ─────────────────────────────────────────────────

export function checkPermission(
  auth: AuthResult,
  method: string,
  path: string,
): AuthzDecision {
  // Unauthenticated requests are rejected before role/permission lookup.
  if (auth.kind === 'none') {
    return { allowed: false, status: 401, reason: 'no credentials' }
  }

  let role: Role
  try {
    role = resolveRole(auth)
  } catch (err) {
    // resolveRole should never throw given its exhaustive switch, but if it
    // does (e.g. future auth kind added without updating this file) we must
    // not accidentally allow access.
    return { allowed: false, status: 503, reason: 'role resolution error' }
  }

  // Determine the permission this endpoint requires.
  // resolveRequiredPermission returns null when no entry matches -- treat
  // unrecognized paths as requiring admin:all (strictest default).
  const required: Permission = resolveRequiredPermission(method, path) ?? 'admin:all'

  if (!hasPermission(role, required)) {
    return {
      allowed: false,
      status: 403,
      reason: `role '${role}' lacks permission '${required}'`,
    }
  }

  return { allowed: true, role }
}

// ── HTTP middleware helper ────────────────────────────────────────────────────
//
// Call this inside the request handler after resolveAuth(). It writes the
// appropriate error response and returns false when access is denied, so the
// caller can bail out with an early return:
//
//   if (!enforcePermission(auth, method, path, res)) return
//
// On success it returns true and attaches req.__authzRole for downstream use.

// ── Tenant resolution ────────────────────────────────────────────────────────
//
// Returns the tenant scope for a request.
//   string  -- tenant-scoped: only this tenant's data is accessible
//   null    -- global (admin): all tenants are accessible (bypass scope filter)
//
// CRITICAL -- admin bypass rule (architecture spec):
//   Callers with role === 'admin' get null (global) regardless of any
//   tenant_id stored on their credential. Deciding access by tenant_id alone
//   would lock even admin users to a single tenant, breaking fleet operations.
//   The scopeToTenant wrapper must check role === 'admin' (not tenantId === null)
//   as the bypass condition, since null also covers the initial null-default
//   for non-admin viewer users before their tenant is assigned.

export function resolveTenantId(auth: AuthResult): string | null {
  if (auth.kind === 'token' && 'tenantId' in auth && typeof (auth as { tenantId?: unknown }).tenantId === 'string') {
    return (auth as { tenantId: string }).tenantId
  }
  if (auth.kind === 'session' && 'tenantId' in auth) {
    const t = (auth as { tenantId?: string | null }).tenantId
    if (t !== undefined) return t  // null = global admin; string = scoped
  }
  return 'default'
}

// ── Shadow / hard enforcement gate ──────────────────────────────────────────
//
// Centralises the RBAC_MODE branch so web.ts stays thin and the logic is
// unit-testable without spinning up an HTTP server.
//
//   shadow  -- logs a would-deny via `onWouldDeny`, never writes a 4xx response.
//              The request always proceeds. Default for safe rollout.
//   enforce -- calls enforcePermission, writes 401/403/503, returns false on deny.

export type RbacMode = 'shadow' | 'enforce'

export function applyRbacGate(
  auth: AuthResult,
  method: string,
  path: string,
  res: http.ServerResponse,
  mode: RbacMode,
  onWouldDeny?: (reason: string) => void,
): boolean {
  const decision = checkPermission(auth, method, path)
  if (decision.allowed) return true

  if (mode === 'enforce') {
    return enforcePermission(auth, method, path, res)
  }

  // shadow: never block, but surface the would-deny so Fázis 1 observation
  // can detect unexpected denials (e.g. session-login users doing writes).
  onWouldDeny?.(decision.allowed ? '' : decision.reason)
  return true
}

export function enforcePermission(
  auth: AuthResult,
  method: string,
  path: string,
  res: http.ServerResponse,
): boolean {
  const decision = checkPermission(auth, method, path)
  if (decision.allowed) return true

  // 503: role resolution threw unexpectedly (future auth kind without handler);
  // Retry-After signals transience to clients. Token intentionally internal_error
  // -- the warn-gate will flag it at 503 for catalog review in PR-B.
  if (decision.status === 503) res.setHeader('Retry-After', '5')
  json(
    res,
    {
      error:
        decision.status === 401 ? 'unauthorized'
        : decision.status === 503 ? 'internal_error'
        : 'forbidden',
    },
    decision.status,
  )
  return false
}
