// Self-service profile endpoints for session-authenticated dashboard users.
//
// GET  /api/v1/me  -- own profile (username, display_name, email, role, tenant)
// PATCH /api/v1/me -- update display_name and/or email

import { readBody, json } from '../http-helpers.js'
import { getDashboardUser, getTenant, adminPatchDashboardUser } from '../../db.js'
import { listUserSessions } from '../auth-sessions.js'
import type { RouteContext } from './types.js'

const ME_BODY_MAX_BYTES = 8 * 1024
const DISPLAY_NAME_MAX = 128
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

async function parseBody(req: RouteContext['req']): Promise<Record<string, unknown>> {
  const raw = (await readBody(req, { maxBytes: ME_BODY_MAX_BYTES })).toString().trim()
  if (!raw) return {}
  const parsed = JSON.parse(raw)
  return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

export async function tryHandleMe(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, auth } = ctx

  if (path !== '/api/me') return false

  // Only session callers have a profile identity here.
  if (auth?.kind !== 'session' || !auth.user) {
    json(res, { error: 'unauthorized', hint: 'A valid session is required' }, 401)
    return true
  }

  const user = getDashboardUser(auth.user)
  if (!user) {
    json(res, { error: 'not_found', field: 'user' }, 404)
    return true
  }

  if (method === 'GET') {
    const tenant = user.tenant_id ? getTenant(user.tenant_id) : undefined
    const sessions = listUserSessions(user.id)
    json(res, {
      username: user.username,
      display_name: user.display_name ?? null,
      email: user.email ?? null,
      role: user.role,
      tenant_id: user.tenant_id ?? null,
      tenant_display_name: tenant?.display_name ?? null,
      session_count: sessions.length,
    })
    return true
  }

  if (method === 'PATCH') {
    let body: Record<string, unknown>
    try {
      body = await parseBody(req)
    } catch {
      json(res, { error: 'parse_error' }, 400)
      return true
    }

    const patch: { display_name?: string | null; email?: string | null } = {}

    if ('display_name' in body) {
      const v = body.display_name
      if (v === null || v === '') {
        patch.display_name = null
      } else if (typeof v !== 'string' || v.trim().length === 0) {
        json(res, { error: 'invalid_value', field: 'display_name', hint: 'Must be a non-empty string or null' }, 400)
        return true
      } else if (v.trim().length > DISPLAY_NAME_MAX) {
        json(res, { error: 'invalid_value', field: 'display_name', hint: `Max ${DISPLAY_NAME_MAX} characters` }, 400)
        return true
      } else {
        patch.display_name = v.trim()
      }
    }

    if ('email' in body) {
      const v = body.email
      if (v === null || v === '') {
        patch.email = null
      } else if (typeof v !== 'string' || !EMAIL_RE.test(v.trim())) {
        json(res, { error: 'invalid_value', field: 'email', hint: 'Must be a valid email address or null' }, 400)
        return true
      } else {
        patch.email = v.trim().toLowerCase()
      }
    }

    if (Object.keys(patch).length === 0) {
      json(res, { error: 'invalid_value', hint: 'No patchable fields provided (display_name, email)' }, 400)
      return true
    }

    const updated = adminPatchDashboardUser(user.id, patch)
    if (!updated) {
      json(res, { error: 'not_found', field: 'user' }, 404)
      return true
    }

    json(res, {
      username: updated.username,
      display_name: updated.display_name ?? null,
      email: updated.email ?? null,
      role: updated.role,
      tenant_id: updated.tenant_id ?? null,
    })
    return true
  }

  return false
}
