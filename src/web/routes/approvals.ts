import { randomUUID } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT, STORE_DIR, MAIN_AGENT_ID } from '../../config.js'
import {
  createApproval, getApproval, resolveApproval, listApprovals, expireTimedOutApprovals,
  createAgentMessage,
  type Approval,
} from '../../db.js'
import { logger } from '../../logger.js'
import { readBody, json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

const AUTONOMY_CONFIG_PATH = join(STORE_DIR, 'autonomy-config.json')

interface AutonomyCategory {
  key: string
  timeout_minutes?: number | null
}

interface AutonomyConfig {
  categories: AutonomyCategory[]
}

function getTimeoutAt(category: string): number | null {
  try {
    if (!existsSync(AUTONOMY_CONFIG_PATH)) return null
    const config = JSON.parse(readFileSync(AUTONOMY_CONFIG_PATH, 'utf-8')) as AutonomyConfig
    const cat = config.categories.find(c => c.key === category)
    if (!cat || cat.timeout_minutes == null) return null
    return Math.floor(Date.now() / 1000) + cat.timeout_minutes * 60
  } catch {
    return null
  }
}

function notifyMainAgent(approval: Approval): void {
  try {
    const content = [
      `[APPROVAL_REQUEST]`,
      `id=${approval.id}`,
      `agent=${approval.agent_id}`,
      `category=${approval.category}`,
      `action=${approval.action_description}`,
      `timeout_at=${approval.timeout_at ?? 'null'}`,
    ].join(' ')
    createAgentMessage('system', MAIN_AGENT_ID, content)
  } catch (err) {
    // Non-fatal: the approval is created regardless; main-agent notification is best-effort
    logger.warn({ err, approvalId: approval.id }, 'Failed to notify main agent of approval request')
  }
}

export function startApprovalTimeoutSweeper(): NodeJS.Timeout {
  return setInterval(() => {
    try {
      const expired = expireTimedOutApprovals()
      if (expired > 0) logger.info({ expired }, 'Approval timeout sweep: expired pending approvals')
    } catch (err) {
      logger.warn({ err }, 'Approval timeout sweep failed')
    }
  }, 60_000)
}

export async function tryHandleApprovals(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  // POST /api/approvals -- create new approval request
  if (path === '/api/approvals' && method === 'POST') {
    // Tenant users (session-auth, non-admin) cannot create approval requests;
    // only fleet agents and admins do. This prevents a coarse approvals:write
    // permission from allowing unintended creation via the dashboard.
    if (ctx.auth?.kind === 'session' && ctx.role !== 'admin') {
      json(res, { error: 'forbidden', hint: 'Tenant users cannot create approval requests' }, 403)
      return true
    }

    let body: { agent_id?: unknown; category?: unknown; action_description?: unknown; action_payload?: unknown; tenant_id?: unknown }
    try {
      body = JSON.parse((await readBody(req)).toString())
    } catch {
      json(res, { error: 'parse_error', hint: 'Invalid JSON' }, 400)
      return true
    }

    const { agent_id, category, action_description, action_payload, tenant_id } = body
    if (typeof agent_id !== 'string' || !agent_id.trim()) {
      json(res, { error: 'required', field: 'agent_id', hint: 'agent_id is required' }, 400)
      return true
    }
    if (typeof category !== 'string' || !category.trim()) {
      json(res, { error: 'required', field: 'category', hint: 'category is required' }, 400)
      return true
    }
    if (typeof action_description !== 'string' || !action_description.trim()) {
      json(res, { error: 'required', field: 'action_description', hint: 'action_description is required' }, 400)
      return true
    }
    if (action_payload !== undefined && typeof action_payload !== 'string') {
      json(res, { error: 'invalid_value', field: 'action_payload', hint: 'action_payload must be a string (JSON) if provided' }, 400)
      return true
    }
    if (tenant_id !== undefined && typeof tenant_id !== 'string') {
      json(res, { error: 'invalid_value', field: 'tenant_id', hint: 'tenant_id must be a string if provided' }, 400)
      return true
    }

    const id = randomUUID()
    const timeout_at = getTimeoutAt(category)
    const approval = createApproval({
      id,
      agent_id: agent_id.trim(),
      category: category.trim(),
      action_description: action_description.trim(),
      action_payload: typeof action_payload === 'string' ? action_payload : null,
      timeout_at,
      tenant_id: typeof tenant_id === 'string' ? tenant_id.trim() || null : null,
    })

    notifyMainAgent(approval)
    logger.info({ id, agent_id, category }, 'Approval request created')
    json(res, approval, 201)
    return true
  }

  // GET /api/approvals -- list with filters
  if (path === '/api/approvals' && method === 'GET') {
    const agent_id = url.searchParams.get('agent') ?? undefined
    const category = url.searchParams.get('category') ?? undefined
    const status = url.searchParams.get('status') ?? undefined
    const limitRaw = url.searchParams.get('limit')
    const limit = limitRaw ? Math.min(parseInt(limitRaw, 10) || 100, 500) : 100

    // Admin sees all tenants; non-admin session users are scoped to their own
    // tenant. Bearer-token (fleet agents) callers are treated as admin-equivalent
    // for reads (they use the global dashboard token, no tenant affiliation).
    // Fail-closed: a non-admin session with no tenant assignment returns 403
    // rather than silently dropping the filter and leaking all tenants' data.
    // Admin may pass ?tenant= to narrow the view to a specific tenant.
    let tenantId: string | undefined
    if (ctx.role === 'admin') {
      const tenantParam = url.searchParams.get('tenant')
      if (tenantParam) tenantId = tenantParam
    } else if (ctx.auth?.kind === 'session') {
      if (!ctx.tenantId) {
        json(res, { error: 'forbidden', hint: 'No tenant scope assigned to this session' }, 403)
        return true
      }
      tenantId = ctx.tenantId
    }

    const items = listApprovals({ agent_id, category, status, limit, tenantId })
    json(res, items)
    return true
  }

  // GET /api/approvals/:id -- status poll
  const idMatch = path.match(/^\/api\/approvals\/([^/]+)$/)
  if (idMatch && method === 'GET') {
    const approval = getApproval(idMatch[1])
    if (!approval) {
      json(res, { error: 'not_found', hint: 'Not found' }, 404)
      return true
    }
    json(res, approval)
    return true
  }

  // PATCH /api/approvals/:id -- resolve (approve/reject/timeout)
  if (idMatch && method === 'PATCH') {
    let body: { status?: unknown; resolved_by?: unknown; telegram_message_id?: unknown }
    try {
      body = JSON.parse((await readBody(req)).toString())
    } catch {
      json(res, { error: 'parse_error', hint: 'Invalid JSON' }, 400)
      return true
    }

    const { status, resolved_by, telegram_message_id } = body
    if (status !== 'approved' && status !== 'rejected' && status !== 'timeout') {
      json(res, { error: 'invalid_value', field: 'status', hint: 'status must be approved, rejected, or timeout' }, 400)
      return true
    }

    // Session-auth callers (B2B dashboard users) get their identity from the
    // authenticated session; body-supplied resolved_by is ignored. Fleet agents
    // using a bearer token must supply resolved_by in the body.
    const effectiveResolvedBy: string | undefined =
      ctx.auth?.kind === 'session' && ctx.auth.user
        ? ctx.auth.user
        : typeof resolved_by === 'string' && resolved_by.trim()
          ? resolved_by.trim()
          : undefined

    if (!effectiveResolvedBy) {
      json(res, { error: 'required', field: 'resolved_by', hint: 'resolved_by is required' }, 400)
      return true
    }
    const msgId = typeof telegram_message_id === 'number' ? telegram_message_id : null

    // Self-approval guard: the requesting agent cannot approve its own request.
    // This is a best-effort check on the self-declared resolved_by value (all fleet
    // agents share the same bearer token, so server-side identity is not enforceable).
    // It catches naive/accidental self-approvals; the real control lives on the
    // main-agent side (approval-request-handling skill).
    const target = getApproval(idMatch[1])
    if (target && effectiveResolvedBy === target.agent_id) {
      json(res, { error: 'forbidden', hint: 'The requesting agent cannot approve its own request' }, 403)
      return true
    }

    // IDOR guard: non-admin session users may only resolve approvals that belong
    // to their own tenant.
    if (ctx.auth?.kind === 'session' && ctx.role !== 'admin') {
      if (!ctx.tenantId) {
        // Session has no tenant scope -- config error, fail-closed.
        json(res, { error: 'forbidden', hint: 'No tenant scope assigned to this session' }, 403)
        return true
      }
      if (!target || target.tenant_id !== ctx.tenantId) {
        // Cross-tenant or not found -- anti-enumeration: same as kanban/memories.
        json(res, { error: 'not_found' }, 404)
        return true
      }
    }

    const updated = resolveApproval(idMatch[1], status, effectiveResolvedBy, msgId)
    if (!updated) {
      // Either not found or already resolved
      const existing = getApproval(idMatch[1])
      if (!existing) {
        json(res, { error: 'not_found', hint: 'Not found' }, 404)
      } else {
        json(res, { error: 'conflict', hint: `Already resolved as ${existing.status}` }, 409)
      }
      return true
    }

    const approval = getApproval(idMatch[1])
    logger.info({ id: idMatch[1], status, resolved_by: effectiveResolvedBy }, 'Approval resolved')
    json(res, approval)
    return true
  }

  return false
}
