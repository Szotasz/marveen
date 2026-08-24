// B2B Admin API: tenant and user management.
//
// All endpoints under /api/admin/tenants and /api/admin/users require
// the admin:all permission, which is enforced by the RBAC prefix rule for
// /api/v1/admin/ in rbac.ts -- no manual permission check needed here.
//
// Tenant id format: ^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$  (3-63 chars)
// Reserved ids (always rejected): default, admin, system, root
//
// PATCH cross-field validation uses FINAL STATE (DB row + submitted fields
// merged) per standard PATCH semantics -- Rick confirmed 2026-08-24.

import {
  getDb,
  createTenant,
  getTenant,
  listTenants,
  updateTenant,
  provisionDashboardUser,
  getDashboardUserById,
  listDashboardUsersFiltered,
  adminPatchDashboardUser,
  countActiveAdmins,
  type Tenant,
  type DashboardUserPublic,
} from '../../db.js'
import { readBody, json } from '../http-helpers.js'
import { hashPassword } from '../password-hash.js'
import { logger } from '../../logger.js'
import type { RouteContext } from './types.js'

// ── Constants ─────────────────────────────────────────────────────────────────

const TENANT_ID_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/
const RESERVED_TENANT_IDS = new Set(['default', 'admin', 'system', 'root'])
const VALID_ROLES = new Set(['admin', 'agent', 'read_only', 'viewer'])
const USERNAME_RE = /^[A-Za-z0-9._-]+$/

// ── Helpers ───────────────────────────────────────────────────────────────────

function userToPublic(u: { id: number; username: string; role: string; tenant_id: string | null; created_at: number; disabled: number }): {
  id: number; username: string; role: string; tenant_id: string | null; created_at: number; disabled: boolean
} {
  return { id: u.id, username: u.username, role: u.role, tenant_id: u.tenant_id, created_at: u.created_at, disabled: u.disabled !== 0 }
}

function auditAdmin(ctx: RouteContext, action: string, targetId: string | number, detail: Record<string, unknown>): void {
  const actor = ctx.auth?.user ?? 'system'
  try {
    getDb()
      .prepare('INSERT INTO agent_audit_log (agent_id, entity, action, entity_id, detail) VALUES (?, ?, ?, ?, ?)')
      .run(actor, 'admin', action, String(targetId), JSON.stringify(detail))
  } catch (err) {
    logger.warn({ err, action, targetId }, 'admin audit log write failed')
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────

export async function tryHandleAdminB2b(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  // ── Tenants ────────────────────────────────────────────────────────────────

  if (path === '/api/admin/tenants' && method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString()) as Record<string, unknown>
    const id = typeof body.id === 'string' ? body.id.trim() : ''
    const displayName = typeof body.display_name === 'string' ? body.display_name.trim() : ''

    if (!TENANT_ID_RE.test(id) || RESERVED_TENANT_IDS.has(id)) {
      json(res, { error: 'invalid_tenant_id', field: 'id' }, 400); return true
    }
    if (!displayName || displayName.length > 120) {
      json(res, { error: 'display_name_required', field: 'display_name' }, 400); return true
    }
    const existing = getTenant(id)
    if (existing) { json(res, { error: 'tenant_already_exists' }, 409); return true }

    const tenant = createTenant(id, displayName)
    auditAdmin(ctx, 'admin.tenant.create', id, { display_name: displayName })
    json(res, tenant, 201)
    return true
  }

  if (path === '/api/admin/tenants' && method === 'GET') {
    const includeDisabled = ctx.url.searchParams.get('include_disabled') === 'true'
    const items = listTenants(includeDisabled)
    json(res, { items, total: items.length })
    return true
  }

  const tenantPatchMatch = path.match(/^\/api\/admin\/tenants\/([^/]+)$/)
  if (tenantPatchMatch && method === 'PATCH') {
    const tenantId = tenantPatchMatch[1]
    const existing = getTenant(tenantId)
    if (!existing) { json(res, { error: 'tenant_not_found' }, 404); return true }

    const body = JSON.parse((await readBody(req)).toString()) as Record<string, unknown>
    const patch: { display_name?: string; disabled?: boolean } = {}
    let hasField = false

    if ('display_name' in body) {
      const dn = typeof body.display_name === 'string' ? body.display_name.trim() : ''
      if (!dn || dn.length > 120) { json(res, { error: 'display_name_required', field: 'display_name' }, 400); return true }
      patch.display_name = dn
      hasField = true
    }
    if ('disabled' in body) {
      if (body.disabled === true && tenantId === 'default') {
        json(res, { error: 'cannot_disable_default_tenant' }, 400); return true
      }
      patch.disabled = Boolean(body.disabled)
      hasField = true
    }
    if (!hasField) { json(res, { error: 'no_fields' }, 400); return true }

    const updated = updateTenant(tenantId, patch)
    auditAdmin(ctx, 'admin.tenant.update', tenantId, patch as Record<string, unknown>)
    json(res, updated)
    return true
  }

  // ── Users ──────────────────────────────────────────────────────────────────

  if (path === '/api/admin/users' && method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString()) as Record<string, unknown>
    const username = typeof body.username === 'string' ? body.username.trim() : ''
    const password = typeof body.password === 'string' ? body.password : ''
    const role = typeof body.role === 'string' ? body.role : ''
    const tenantId = 'tenant_id' in body ? (body.tenant_id === null ? null : String(body.tenant_id ?? '').trim() || null) : undefined

    if (!username || username.length < 3 || username.length > 64 || !USERNAME_RE.test(username)) {
      json(res, { error: 'username_invalid', field: 'username' }, 400); return true
    }
    if (password.length < 12) {
      json(res, { error: 'password_too_short', field: 'password' }, 400); return true
    }
    if (!VALID_ROLES.has(role)) {
      json(res, { error: 'role_invalid', field: 'role' }, 400); return true
    }

    // Final state cross-field validation.
    const finalTenantId = tenantId === undefined ? null : tenantId
    if (role !== 'admin' && finalTenantId === null) {
      json(res, { error: 'tenant_required_for_non_admin', field: 'tenant_id' }, 400); return true
    }
    if (role === 'admin' && finalTenantId !== null) {
      json(res, { error: 'admin_must_be_global', field: 'tenant_id' }, 400); return true
    }
    if (finalTenantId !== null) {
      const tenant = getTenant(finalTenantId)
      if (!tenant || tenant.disabled_at !== null) {
        json(res, { error: 'tenant_not_found', field: 'tenant_id' }, 400); return true
      }
    }

    // Duplicate check (UNIQUE on username, case-insensitive).
    const dup = getDb().prepare('SELECT id FROM dashboard_users WHERE username = ? COLLATE NOCASE').get(username)
    if (dup) { json(res, { error: 'username_taken', field: 'username' }, 409); return true }

    const hash = await hashPassword(password)
    const user = provisionDashboardUser(username, hash, role, finalTenantId)
    auditAdmin(ctx, 'admin.user.create', user.id, { username, role, tenant_id: finalTenantId })
    json(res, userToPublic(user), 201)
    return true
  }

  if (path === '/api/admin/users' && method === 'GET') {
    const tenantParam = ctx.url.searchParams.get('tenant_id') ?? undefined
    const includeDisabled = ctx.url.searchParams.get('include_disabled') === 'true'
    const items = listDashboardUsersFiltered({ tenantId: tenantParam, includeDisabled })
    json(res, { items: items.map(userToPublic), total: items.length })
    return true
  }

  const userPatchMatch = path.match(/^\/api\/admin\/users\/(\d+)$/)
  if (userPatchMatch && method === 'PATCH') {
    const userId = parseInt(userPatchMatch[1], 10)
    const existing = getDashboardUserById(userId)
    if (!existing) { json(res, { error: 'user_not_found' }, 404); return true }

    const body = JSON.parse((await readBody(req)).toString()) as Record<string, unknown>
    let hasField = false

    // Build the patch, validating each field.
    const patch: { role?: string; tenant_id?: string | null; password_hash?: string; disabled?: boolean } = {}

    if ('role' in body) {
      const newRole = typeof body.role === 'string' ? body.role : ''
      if (!VALID_ROLES.has(newRole)) { json(res, { error: 'role_invalid', field: 'role' }, 400); return true }
      patch.role = newRole
      hasField = true
    }
    if ('tenant_id' in body) {
      patch.tenant_id = body.tenant_id === null ? null : String(body.tenant_id ?? '').trim() || null
      hasField = true
    }
    if ('password' in body) {
      const pw = typeof body.password === 'string' ? body.password : ''
      if (pw.length < 12) { json(res, { error: 'password_too_short', field: 'password' }, 400); return true }
      patch.password_hash = await hashPassword(pw)
      hasField = true
    }
    if ('disabled' in body) {
      patch.disabled = Boolean(body.disabled)
      hasField = true
    }
    if (!hasField) { json(res, { error: 'no_fields' }, 400); return true }

    // Final state: merge submitted fields onto existing row, then validate.
    const finalRole = patch.role ?? existing.role
    const finalTenantId = 'tenant_id' in patch ? patch.tenant_id : existing.tenant_id

    if (finalRole !== 'admin' && finalTenantId === null) {
      json(res, { error: 'tenant_required_for_non_admin', field: 'tenant_id' }, 400); return true
    }
    if (finalRole === 'admin' && finalTenantId !== null) {
      json(res, { error: 'admin_must_be_global', field: 'tenant_id' }, 400); return true
    }
    if (finalTenantId != null) {
      const tenant = getTenant(finalTenantId)
      if (!tenant || tenant.disabled_at !== null) {
        json(res, { error: 'tenant_not_found', field: 'tenant_id' }, 400); return true
      }
    }

    // Self-disable protection: the requesting admin cannot disable themselves.
    if (patch.disabled === true) {
      const actor = ctx.auth?.user
      if (actor && existing.username.toLowerCase() === actor.toLowerCase()) {
        json(res, { error: 'cannot_disable_self' }, 400); return true
      }
      // Last-admin protection: cannot disable the last active admin.
      if (existing.role === 'admin' && countActiveAdmins() <= 1) {
        json(res, { error: 'last_admin' }, 400); return true
      }
    }

    const updated = adminPatchDashboardUser(userId, patch)
    if (!updated) { json(res, { error: 'user_not_found' }, 404); return true }
    auditAdmin(ctx, 'admin.user.update', userId, { username: existing.username, ...patch, password_hash: patch.password_hash ? '[redacted]' : undefined })
    json(res, userToPublic(updated))
    return true
  }

  return false
}
