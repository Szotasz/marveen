// Admin token management routes.
//
// Provides CRUD over the api_tokens table:
//   GET    /api/admin/tokens               -- list all tokens (hashes omitted)
//   POST   /api/admin/tokens               -- create a new token
//   POST   /api/admin/tokens/:id/rotate    -- rotate: new token, old one revoked
//   DELETE /api/admin/tokens/:id/revoke    -- revoke without rotation
//
// Callers address /api/v1/admin/tokens (canonical) or /api/admin/tokens (legacy).
// The versioning normaliser in web.ts strips the /v1 segment, so ctx.path always
// arrives here as /api/admin/tokens regardless of which form the caller used.
//
// All routes require admin:all permission (enforced by the RBAC layer via the
// /api/v1/admin/ prefix rule in rbac.ts). Token hashes are never returned in
// responses; raw token values are returned ONLY at creation/rotation time.

import { randomBytes, createHash } from 'node:crypto'
import { getDb } from '../../db.js'
import { logger } from '../../logger.js'
import { readBody, json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

// ── Schema types ─────────────────────────────────────────────────────────────

interface TokenRow {
  id: number
  token_hash: string
  name: string
  role: string
  tenant_id: string
  created_at: number
  expires_at: number | null
  revoked_at: number | null
  last_used_at: number | null
  rotated_from: number | null
}

interface TokenPublic {
  id: number
  name: string
  role: string
  tenant_id: string
  created_at: number
  expires_at: number | null
  revoked_at: number | null
  last_used_at: number | null
  rotated_from: number | null
}

function toPublic(row: TokenRow): TokenPublic {
  const { token_hash: _hash, ...rest } = row
  return rest
}

function sha256hex(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

function generateToken(): string {
  return randomBytes(32).toString('hex')
}

const VALID_ROLES = new Set(['admin', 'agent', 'read_only', 'viewer'])

// ── Route handler ─────────────────────────────────────────────────────────────

export async function tryHandleAdminTokens(ctx: RouteContext): Promise<boolean> {
  const { path, method, res } = ctx

  // GET /api/admin/tokens
  if (method === 'GET' && path === '/api/admin/tokens') {
    const db = getDb()
    const rows = db.prepare('SELECT * FROM api_tokens ORDER BY created_at DESC').all() as TokenRow[]
    json(res, rows.map(toPublic))
    return true
  }

  // POST /api/admin/tokens -- create
  if (method === 'POST' && path === '/api/admin/tokens') {
    let parsed: { name?: unknown; role?: unknown; tenant_id?: unknown; expires_in_days?: unknown }
    try {
      const buf = await readBody(ctx.req)
      parsed = JSON.parse(buf.toString())
    } catch {
      json(res, { error: 'invalid body' }, 400)
      return true
    }

    const name = typeof parsed.name === 'string' ? parsed.name.trim() : ''
    const role = typeof parsed.role === 'string' ? parsed.role.trim() : ''
    const tenantId = typeof parsed.tenant_id === 'string' ? parsed.tenant_id.trim() : 'default'

    if (!name) { json(res, { error: 'name is required' }, 400); return true }
    if (!VALID_ROLES.has(role)) {
      json(res, { error: `role must be one of: ${[...VALID_ROLES].join(', ')}` }, 400)
      return true
    }

    const now = Math.floor(Date.now() / 1000)
    const expiresInDays = typeof parsed.expires_in_days === 'number' ? parsed.expires_in_days : null
    const expiresAt = expiresInDays !== null ? now + expiresInDays * 86400 : null

    const rawToken = generateToken()
    const hash = sha256hex(rawToken)

    const db = getDb()
    try {
      const result = db.prepare(
        `INSERT INTO api_tokens (token_hash, name, role, tenant_id, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(hash, name, role, tenantId, now, expiresAt)

      const row = db.prepare('SELECT * FROM api_tokens WHERE id = ?').get(result.lastInsertRowid) as TokenRow
      logger.info({ tokenId: row.id, name, role, tenantId }, 'api_token created')
      // Return the raw token value ONCE -- it cannot be recovered after this response.
      json(res, { token: rawToken, ...toPublic(row) }, 201)
    } catch (e) {
      logger.error({ err: e }, 'api_token create failed')
      json(res, { error: 'failed to create token' }, 500)
    }
    return true
  }

  // POST /api/admin/tokens/:id/rotate
  const rotateMatch = /^\/api\/admin\/tokens\/(\d+)\/rotate$/.exec(path)
  if (method === 'POST' && rotateMatch) {
    const id = Number(rotateMatch[1])

    let parsed: { expires_in_days?: unknown } = {}
    try {
      const buf = await readBody(ctx.req)
      const str = buf.toString().trim()
      if (str) parsed = JSON.parse(str)
    } catch {
      json(res, { error: 'invalid body' }, 400)
      return true
    }

    const db = getDb()
    const old = db.prepare('SELECT * FROM api_tokens WHERE id = ?').get(id) as TokenRow | undefined
    if (!old) { json(res, { error: 'token not found' }, 404); return true }
    if (old.revoked_at !== null) { json(res, { error: 'token already revoked' }, 409); return true }

    const now = Math.floor(Date.now() / 1000)
    const expiresInDays = typeof parsed.expires_in_days === 'number' ? parsed.expires_in_days : null
    const expiresAt = expiresInDays !== null ? now + expiresInDays * 86400 : old.expires_at

    const rawToken = generateToken()
    const hash = sha256hex(rawToken)

    try {
      db.transaction(() => {
        // Revoke the old token atomically with creating the replacement.
        db.prepare('UPDATE api_tokens SET revoked_at = ? WHERE id = ?').run(now, id)
        db.prepare(
          `INSERT INTO api_tokens (token_hash, name, role, tenant_id, created_at, expires_at, rotated_from)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(hash, old.name, old.role, old.tenant_id, now, expiresAt, id)
      })()

      const newRow = db.prepare('SELECT * FROM api_tokens WHERE token_hash = ?').get(hash) as TokenRow
      logger.info({ oldId: id, newId: newRow.id, name: old.name }, 'api_token rotated')
      json(res, { token: rawToken, ...toPublic(newRow) })
    } catch (e) {
      logger.error({ err: e }, 'api_token rotate failed')
      json(res, { error: 'failed to rotate token' }, 500)
    }
    return true
  }

  // DELETE /api/admin/tokens/:id/revoke
  const revokeMatch = /^\/api\/admin\/tokens\/(\d+)\/revoke$/.exec(path)
  if (method === 'DELETE' && revokeMatch) {
    const id = Number(revokeMatch[1])
    const db = getDb()
    const row = db.prepare('SELECT * FROM api_tokens WHERE id = ?').get(id) as TokenRow | undefined
    if (!row) { json(res, { error: 'token not found' }, 404); return true }
    if (row.revoked_at !== null) { json(res, { error: 'token already revoked' }, 409); return true }

    const now = Math.floor(Date.now() / 1000)
    db.prepare('UPDATE api_tokens SET revoked_at = ? WHERE id = ?').run(now, id)
    logger.info({ tokenId: id, name: row.name }, 'api_token revoked')
    json(res, { revoked: true, id })
    return true
  }

  return false
}
