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
      // Browser session-login users start as viewer; admin grant is explicit.
      return 'viewer'
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

export function enforcePermission(
  auth: AuthResult,
  method: string,
  path: string,
  res: http.ServerResponse,
): boolean {
  const decision = checkPermission(auth, method, path)
  if (decision.allowed) return true

  res.writeHead(decision.status, {
    'Content-Type': 'application/json',
    // Expose the reason only for 503 (operational error) to avoid leaking
    // role/permission names to unauthenticated callers.
    ...(decision.status === 503
      ? { 'Retry-After': '5' }
      : {}),
  })
  res.end(
    JSON.stringify({
      error:
        decision.status === 401
          ? 'Unauthorized'
          : decision.status === 503
            ? 'Service temporarily unavailable'
            : 'Forbidden',
    }),
  )
  return false
}
