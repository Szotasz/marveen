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
// merged) per standard PATCH semantics -- confirmed 2026-08-24.

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
  listPartnerSenders,
  createPartnerSender,
  disablePartnerSender,
  listTenantAgentAvailability,
  setTenantAgentAvailability,
  type Tenant,
  type DashboardUserPublic,
  type PartnerSender,
} from '../../db.js'
import { listDeviceKeys, assignDeviceKeyTenant } from '../auth-device-keys.js'
import { readBody, json } from '../http-helpers.js'
import { hashPassword } from '../password-hash.js'
import { sanitizeAgentIdent } from '../../prompt-safety.js'
import { isKnownAgent, listAgentNames } from '../agent-config.js'
import { logger } from '../../logger.js'
import type { RouteContext } from './types.js'

// ── Constants ─────────────────────────────────────────────────────────────────

const TENANT_ID_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/
const RESERVED_TENANT_IDS = new Set(['default', 'admin', 'system', 'root'])
const VALID_ROLES = new Set(['admin', 'agent', 'read_only', 'viewer'])
const USERNAME_RE = /^[A-Za-z0-9._-]+$/
// sender_id must be a valid sanitized agent ident (sanitizeAgentIdent strips everything else)
const SENDER_ID_RE = /^[a-zA-Z0-9_-]+$/

// ── Helpers ───────────────────────────────────────────────────────────────────

function userToPublic(u: { id: number; username: string; role: string; tenant_id: string | null; email?: string | null; display_name?: string | null; created_at: number; disabled: number }): {
  id: number; username: string; role: string; tenant_id: string | null; email: string | null; display_name: string | null; created_at: number; disabled: boolean
} {
  return { id: u.id, username: u.username, role: u.role, tenant_id: u.tenant_id, email: u.email ?? null, display_name: u.display_name ?? null, created_at: u.created_at, disabled: u.disabled !== 0 }
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
      json(res, { error: 'invalid_value', field: 'id', hint: 'Tenant ID must match [a-z0-9_-] and not be a reserved identifier' }, 400); return true
    }
    if (!displayName || displayName.length > 120) {
      json(res, { error: 'required', field: 'display_name', hint: 'Display name is required and must be ≤120 chars' }, 400); return true
    }
    const existing = getTenant(id)
    if (existing) { json(res, { error: 'conflict', hint: 'Tenant ID already exists' }, 409); return true }

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
    if (!existing) { json(res, { error: 'not_found', field: 'id', hint: 'Tenant not found' }, 404); return true }

    const body = JSON.parse((await readBody(req)).toString()) as Record<string, unknown>
    const patch: { display_name?: string; disabled?: boolean } = {}
    let hasField = false

    if ('display_name' in body) {
      const dn = typeof body.display_name === 'string' ? body.display_name.trim() : ''
      if (!dn || dn.length > 120) { json(res, { error: 'required', field: 'display_name', hint: 'Display name is required and must be ≤120 chars' }, 400); return true }
      patch.display_name = dn
      hasField = true
    }
    if ('disabled' in body) {
      if (body.disabled === true && tenantId === 'default') {
        json(res, { error: 'forbidden', hint: 'Default tenant cannot be disabled' }, 403); return true
      }
      patch.disabled = Boolean(body.disabled)
      hasField = true
    }
    if (!hasField) { json(res, { error: 'required', hint: 'At least one field must be provided' }, 400); return true }

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
    const email = typeof body.email === 'string' ? body.email.trim() || null : null
    const displayName = typeof body.display_name === 'string' ? body.display_name.trim() || null : null

    if (!username || username.length < 3 || username.length > 64 || !USERNAME_RE.test(username)) {
      json(res, { error: 'invalid_value', field: 'username', hint: 'Username must be 3-64 chars, letters/digits/underscores/hyphens only' }, 400); return true
    }
    if (password.length < 12) {
      json(res, { error: 'invalid_value', field: 'password', hint: 'Password must be at least 12 characters' }, 400); return true
    }
    if (!VALID_ROLES.has(role)) {
      json(res, { error: 'invalid_value', field: 'role', hint: `Role must be one of: ${Array.from(VALID_ROLES).join(', ')}` }, 400); return true
    }

    // Final state cross-field validation.
    const finalTenantId = tenantId === undefined ? null : tenantId
    if (role !== 'admin' && finalTenantId === null) {
      json(res, { error: 'forbidden', field: 'tenant_id', hint: 'Non-admin requests must specify a tenant' }, 403); return true
    }
    if (role === 'admin' && finalTenantId !== null) {
      json(res, { error: 'forbidden', field: 'tenant_id', hint: 'Action requires a global admin account' }, 403); return true
    }
    if (finalTenantId !== null) {
      const tenant = getTenant(finalTenantId)
      if (!tenant || tenant.disabled_at !== null) {
        json(res, { error: 'not_found', field: 'tenant_id', hint: 'Tenant not found or disabled' }, 404); return true
      }
    }

    if (email && !email.includes('@')) {
      json(res, { error: 'invalid_value', field: 'email', hint: 'Email must contain @' }, 400); return true
    }

    // Duplicate check (UNIQUE on username, case-insensitive).
    const dup = getDb().prepare('SELECT id FROM dashboard_users WHERE username = ? COLLATE NOCASE').get(username)
    if (dup) { json(res, { error: 'conflict', field: 'username', hint: 'Username already exists' }, 409); return true }

    const hash = await hashPassword(password)
    const user = provisionDashboardUser(username, hash, role, finalTenantId, email, displayName)
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
    if (!existing) { json(res, { error: 'not_found', field: 'userId', hint: 'User not found' }, 404); return true }

    const body = JSON.parse((await readBody(req)).toString()) as Record<string, unknown>
    let hasField = false

    // Build the patch, validating each field.
    const patch: { role?: string; tenant_id?: string | null; password_hash?: string; disabled?: boolean; email?: string | null; display_name?: string | null } = {}

    if ('role' in body) {
      const newRole = typeof body.role === 'string' ? body.role : ''
      if (!VALID_ROLES.has(newRole)) { json(res, { error: 'invalid_value', field: 'role', hint: `Role must be one of: ${Array.from(VALID_ROLES).join(', ')}` }, 400); return true }
      patch.role = newRole
      hasField = true
    }
    if ('tenant_id' in body) {
      patch.tenant_id = body.tenant_id === null ? null : String(body.tenant_id ?? '').trim() || null
      hasField = true
    }
    if ('password' in body) {
      const pw = typeof body.password === 'string' ? body.password : ''
      if (pw.length < 12) { json(res, { error: 'invalid_value', field: 'password', hint: 'Password must be at least 12 characters' }, 400); return true }
      patch.password_hash = await hashPassword(pw)
      hasField = true
    }
    if ('disabled' in body) {
      patch.disabled = Boolean(body.disabled)
      hasField = true
    }
    if ('email' in body) {
      patch.email = typeof body.email === 'string' ? body.email.trim() || null : null
      if (patch.email && !patch.email.includes('@')) {
        json(res, { error: 'invalid_value', field: 'email', hint: 'Email must contain @' }, 400); return true
      }
      hasField = true
    }
    if ('display_name' in body) {
      patch.display_name = typeof body.display_name === 'string' ? body.display_name.trim() || null : null
      hasField = true
    }
    if (!hasField) { json(res, { error: 'required', hint: 'At least one field must be provided' }, 400); return true }

    // Final state: merge submitted fields onto existing row, then validate.
    const finalRole = patch.role ?? existing.role
    const finalTenantId = 'tenant_id' in patch ? patch.tenant_id : existing.tenant_id

    if (finalRole !== 'admin' && finalTenantId === null) {
      json(res, { error: 'forbidden', field: 'tenant_id', hint: 'Non-admin requests must specify a tenant' }, 403); return true
    }
    if (finalRole === 'admin' && finalTenantId !== null) {
      json(res, { error: 'forbidden', field: 'tenant_id', hint: 'Action requires a global admin account' }, 403); return true
    }
    if (finalTenantId != null) {
      const tenant = getTenant(finalTenantId)
      if (!tenant || tenant.disabled_at !== null) {
        json(res, { error: 'not_found', field: 'tenant_id', hint: 'Tenant not found or disabled' }, 404); return true
      }
    }

    // Self-disable protection: the requesting admin cannot disable themselves.
    if (patch.disabled === true) {
      const actor = ctx.auth?.user
      if (actor && existing.username.toLowerCase() === actor.toLowerCase()) {
        json(res, { error: 'forbidden', hint: 'Cannot disable your own account' }, 403); return true
      }
      // Last-admin protection: cannot disable the last active admin.
      if (existing.role === 'admin' && countActiveAdmins() <= 1) {
        json(res, { error: 'forbidden', hint: 'Cannot remove the last administrator' }, 403); return true
      }
    }

    const updated = adminPatchDashboardUser(userId, patch)
    if (!updated) { json(res, { error: 'not_found', field: 'userId', hint: 'User not found' }, 404); return true }
    auditAdmin(ctx, 'admin.user.update', userId, { username: existing.username, ...patch, password_hash: patch.password_hash ? '[redacted]' : undefined })
    json(res, userToPublic(updated))
    return true
  }

  // ── Partner Senders ────────────────────────────────────────────────────────

  if (path === '/api/admin/partner-senders' && method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString()) as Record<string, unknown>
    const senderId = typeof body.sender_id === 'string' ? body.sender_id.trim() : ''
    const tenantId = typeof body.tenant_id === 'string' ? body.tenant_id.trim() : ''
    const displayName = typeof body.display_name === 'string' ? body.display_name.trim() : ''

    if (!SENDER_ID_RE.test(senderId) || senderId.length > 63) {
      json(res, { error: 'invalid_value', field: 'sender_id',
        hint: 'sender_id must match [a-zA-Z0-9_-] and be 1-63 chars' }, 400)
      return true
    }
    if (!tenantId || RESERVED_TENANT_IDS.has(tenantId)) {
      json(res, { error: 'invalid_value', field: 'tenant_id', hint: 'Tenant ID is invalid or reserved' }, 400); return true
    }
    const tenant = getTenant(tenantId)
    if (!tenant || tenant.disabled_at !== null) {
      json(res, { error: 'not_found', field: 'tenant_id', hint: 'Tenant not found or disabled' }, 404); return true
    }
    // Block fleet agent names: a partner sender with the same id as a fleet
    // agent would be confusing and could mask routing bugs.
    if (isKnownAgent(sanitizeAgentIdent(senderId))) {
      json(res, { error: 'forbidden',
        hint: 'Sender ID matches a fleet agent identifier' }, 403)
      return true
    }
    // Check for existing (active or soft-disabled) entry
    const existing = listPartnerSenders(tenantId).find((s) => s.sender_id === sanitizeAgentIdent(senderId))
    if (existing) {
      json(res, { error: 'conflict', hint: 'Sender already registered' }, 409); return true
    }

    const createdBy = ctx.auth?.user ?? 'system'
    const record = createPartnerSender(sanitizeAgentIdent(senderId), tenantId, displayName, createdBy)
    auditAdmin(ctx, 'admin.partner_sender.create', `${tenantId}/${sanitizeAgentIdent(senderId)}`,
      { sender_id: record.sender_id, tenant_id: tenantId, display_name: displayName })
    json(res, record, 201)
    return true
  }

  if (path === '/api/admin/partner-senders' && method === 'GET') {
    const tenantId = ctx.url.searchParams.get('tenant_id') ?? undefined
    const items = listPartnerSenders(tenantId)
    json(res, { items, total: items.length })
    return true
  }

  // DELETE /api/admin/partner-senders/:sender_id?tenant_id=<id>
  const partnerSenderDeleteMatch = path.match(/^\/api\/admin\/partner-senders\/([^/]+)$/)
  if (partnerSenderDeleteMatch && method === 'DELETE') {
    const senderId = decodeURIComponent(partnerSenderDeleteMatch[1])
    const tenantId = ctx.url.searchParams.get('tenant_id') ?? ''
    if (!tenantId) {
      json(res, { error: 'required', field: 'tenantId', hint: 'pass ?tenant_id=<id>' }, 400); return true
    }
    const disabled = disablePartnerSender(sanitizeAgentIdent(senderId), tenantId)
    if (!disabled) {
      json(res, { error: 'not_found', field: 'senderId', hint: 'Partner sender not found or already disabled' }, 404); return true
    }
    auditAdmin(ctx, 'admin.partner_sender.disable', `${tenantId}/${sanitizeAgentIdent(senderId)}`,
      { sender_id: sanitizeAgentIdent(senderId), tenant_id: tenantId })
    json(res, { ok: true })
    return true
  }

  // ── Agent availability matrix ─────────────────────────────────────────────
  // GET  /api/admin/agent-availability?tenant_id=<id>
  // PUT  /api/admin/agent-availability   {tenant_id, agent_id, enabled}
  //
  // Deny-by-default: a (tenant, agent) pair is disabled unless an enabled=1
  // row exists in tenant_agent_availability. The GET response always includes
  // ALL known agents, not just those with rows, so the frontend can render the
  // full matrix without a separate fleet-agents call.

  if (path === '/api/admin/agent-availability' && method === 'GET') {
    const tenantId = ctx.url.searchParams.get('tenant_id') ?? ''
    if (!tenantId) {
      json(res, { error: 'required', field: 'tenant_id', hint: 'pass ?tenant_id=<id>' }, 400); return true
    }
    const tenant = getTenant(tenantId)
    if (!tenant) { json(res, { error: 'not_found', field: 'tenant_id', hint: 'Tenant not found' }, 404); return true }

    const rows = listTenantAgentAvailability(tenantId)
    const rowMap = new Map(rows.map(r => [r.agent_id, r]))
    const allAgents = listAgentNames()
    const items = allAgents.map(agentId => {
      const row = rowMap.get(agentId)
      return { agent_id: agentId, enabled: row ? row.enabled === 1 : false, updated_at: row?.updated_at ?? null }
    })
    json(res, { tenant_id: tenantId, items })
    return true
  }

  if (path === '/api/admin/agent-availability' && method === 'PUT') {
    const body = JSON.parse((await readBody(req)).toString()) as Record<string, unknown>
    const tenantId = typeof body.tenant_id === 'string' ? body.tenant_id.trim() : ''
    const agentId = typeof body.agent_id === 'string' ? body.agent_id.trim() : ''
    const enabled = Boolean(body.enabled)

    if (!tenantId) { json(res, { error: 'required', field: 'tenant_id' }, 400); return true }
    if (!agentId) { json(res, { error: 'required', field: 'agent_id' }, 400); return true }

    const tenant = getTenant(tenantId)
    if (!tenant || tenant.disabled_at !== null) {
      json(res, { error: 'not_found', field: 'tenant_id', hint: 'Tenant not found or disabled' }, 404); return true
    }
    if (!isKnownAgent(sanitizeAgentIdent(agentId))) {
      json(res, { error: 'not_found', field: 'agent_id', hint: 'Unknown agent' }, 404); return true
    }

    const row = setTenantAgentAvailability(tenantId, sanitizeAgentIdent(agentId), enabled)
    auditAdmin(ctx, 'admin.agent_availability.set', `${tenantId}/${agentId}`, { enabled })
    json(res, { tenant_id: row.tenant_id, agent_id: row.agent_id, enabled: row.enabled === 1, updated_at: row.updated_at })
    return true
  }

  // ── Device keys ───────────────────────────────────────────────────────────
  // GET   /api/admin/device-keys                      list all keys (with tenant_id)
  // PATCH /api/admin/device-keys/:id  {tenant_id}    assign/clear tenant

  if (path === '/api/admin/device-keys' && method === 'GET') {
    const keys = listDeviceKeys()
    json(res, { items: keys, total: keys.length })
    return true
  }

  const deviceKeyPatchMatch = path.match(/^\/api\/admin\/device-keys\/(\d+)$/)
  if (deviceKeyPatchMatch && method === 'PATCH') {
    const keyId = parseInt(deviceKeyPatchMatch[1], 10)
    const body = JSON.parse((await readBody(req)).toString()) as Record<string, unknown>

    if (!('tenant_id' in body)) {
      json(res, { error: 'required', field: 'tenant_id', hint: 'Pass tenant_id (string or null)' }, 400); return true
    }
    const newTenantId = body.tenant_id === null ? null : typeof body.tenant_id === 'string' ? body.tenant_id.trim() || null : null

    if (newTenantId !== null) {
      const tenant = getTenant(newTenantId)
      if (!tenant || tenant.disabled_at !== null) {
        json(res, { error: 'not_found', field: 'tenant_id', hint: 'Tenant not found or disabled' }, 404); return true
      }
    }

    const ok = assignDeviceKeyTenant(keyId, newTenantId)
    if (!ok) { json(res, { error: 'not_found', field: 'id', hint: 'Device key not found' }, 404); return true }
    auditAdmin(ctx, 'admin.device_key.assign_tenant', keyId, { tenant_id: newTenantId })
    json(res, { ok: true, id: keyId, tenant_id: newTenantId })
    return true
  }

  return false
}
