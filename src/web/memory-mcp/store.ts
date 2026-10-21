import { createHash } from 'node:crypto'
import { getDb } from '../../db.js'

export type Mode = 'rw' | 'r' | 'w'

export interface McpClient { client_id: string; client_name: string; redirect_uris: string[]; created_at: number }
export interface McpGrant {
  id: number; client_id: string; username: string; mode: Mode; label: string | null
  created_at: number; last_used_at: number | null; revoked_at: number | null
}
export interface McpCode {
  code_hash: string; client_id: string; username: string; mode: Mode; label: string | null
  redirect_uri: string; code_challenge: string; expires_at: number; used_at: number | null
}
export interface McpTokenRow { token_hash: string; grant_id: number; kind: 'access' | 'refresh'; expires_at: number; used_at: number | null; created_at: number }

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

export function insertClient(c: McpClient): void {
  getDb().prepare('INSERT INTO mcp_oauth_clients (client_id, client_name, redirect_uris, created_at) VALUES (?, ?, ?, ?)')
    .run(c.client_id, c.client_name, JSON.stringify(c.redirect_uris), c.created_at)
}

export function getClient(clientId: string): McpClient | undefined {
  const row = getDb().prepare('SELECT client_id, client_name, redirect_uris, created_at FROM mcp_oauth_clients WHERE client_id = ?')
    .get(clientId) as { client_id: string; client_name: string; redirect_uris: string; created_at: number } | undefined
  if (!row) return undefined
  let uris: string[] = []
  try { uris = JSON.parse(row.redirect_uris) as string[] } catch { /* corrupt row: no redirects match */ }
  return { ...row, redirect_uris: Array.isArray(uris) ? uris : [] }
}

export function insertCode(c: Omit<McpCode, 'used_at'>): void {
  getDb().prepare(
    'INSERT INTO mcp_oauth_codes (code_hash, client_id, username, mode, label, redirect_uri, code_challenge, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(c.code_hash, c.client_id, c.username, c.mode, c.label, c.redirect_uri, c.code_challenge, c.expires_at)
}

/** Look the code up and mark it used in one synchronous step. Returns the row as it was before. */
export function consumeCode(codeHash: string, now: number): McpCode | undefined {
  const db = getDb()
  return db.transaction(() => {
    const row = db.prepare('SELECT * FROM mcp_oauth_codes WHERE code_hash = ?').get(codeHash) as McpCode | undefined
    if (!row || row.used_at !== null || row.expires_at <= now) return undefined
    db.prepare('UPDATE mcp_oauth_codes SET used_at = ? WHERE code_hash = ?').run(now, codeHash)
    return row
  })()
}

export function insertGrant(g: { client_id: string; username: string; mode: Mode; label: string | null }, now: number): number {
  const info = getDb().prepare('INSERT INTO mcp_oauth_grants (client_id, username, mode, label, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(g.client_id, g.username, g.mode, g.label, now)
  return Number(info.lastInsertRowid)
}

export function getGrant(id: number): McpGrant | undefined {
  return getDb().prepare('SELECT * FROM mcp_oauth_grants WHERE id = ?').get(id) as McpGrant | undefined
}

export function revokeGrant(id: number, now: number): void {
  getDb().prepare('UPDATE mcp_oauth_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now, id)
}

export function touchGrant(id: number, now: number, last: number | null): void {
  if (last !== null && now - last < 60) return
  getDb().prepare('UPDATE mcp_oauth_grants SET last_used_at = ? WHERE id = ?').run(now, id)
}

export function insertToken(t: { token_hash: string; grant_id: number; kind: 'access' | 'refresh'; expires_at: number; created_at: number }): void {
  getDb().prepare('INSERT INTO mcp_oauth_tokens (token_hash, grant_id, kind, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(t.token_hash, t.grant_id, t.kind, t.expires_at, t.created_at)
}

export function getToken(hash: string, kind: 'access' | 'refresh'): McpTokenRow | undefined {
  return getDb().prepare('SELECT * FROM mcp_oauth_tokens WHERE token_hash = ? AND kind = ?').get(hash, kind) as McpTokenRow | undefined
}

export function markTokenUsed(hash: string, now: number): void {
  getDb().prepare('UPDATE mcp_oauth_tokens SET used_at = ? WHERE token_hash = ?').run(now, hash)
}

export interface McpPrincipal { grant: McpGrant; username: string; clientName: string }

/** Resolve an access token to its grant and (still enabled) dashboard user. */
export function authenticateAccessToken(token: string, now: number): McpPrincipal | undefined {
  const row = getDb().prepare(
    `SELECT g.id AS gid, g.client_id, g.username AS g_username, g.mode, g.label, g.created_at, g.last_used_at, g.revoked_at,
            u.username AS u_username
       FROM mcp_oauth_tokens t
       JOIN mcp_oauth_grants g ON g.id = t.grant_id
       -- Exact match: the namespace is 'mcp:' + the stored username, so a grant must not follow a case change.
       JOIN dashboard_users u ON u.username = g.username COLLATE BINARY
      WHERE t.token_hash = ? AND t.kind = 'access' AND t.expires_at > ? AND g.revoked_at IS NULL AND u.disabled = 0`
  ).get(sha256Hex(token), now) as (Record<string, any>) | undefined
  if (!row) return undefined
  const client = getClient(row.client_id)
  const grant: McpGrant = {
    id: row.gid, client_id: row.client_id, username: row.g_username, mode: row.mode, label: row.label,
    created_at: row.created_at, last_used_at: row.last_used_at, revoked_at: row.revoked_at,
  }
  return { grant, username: row.u_username, clientName: client?.client_name ?? 'MCP client' }
}

export function listGrants(username: string | null, includeRevoked = false): Array<McpGrant & { client_name: string }> {
  const sql = `SELECT g.*, COALESCE(c.client_name, 'MCP client') AS client_name
                 FROM mcp_oauth_grants g LEFT JOIN mcp_oauth_clients c ON c.client_id = g.client_id
                WHERE ${includeRevoked ? '1 = 1' : 'g.revoked_at IS NULL'} ${username === null ? '' : 'AND g.username = ? COLLATE NOCASE'}
                ORDER BY g.id`
  const st = getDb().prepare(sql)
  return (username === null ? st.all() : st.all(username)) as Array<McpGrant & { client_name: string }>
}

/** Active dashboard user lookup (missing or disabled -> undefined). */
export function getActiveUser(username: string): { id: number; username: string } | undefined {
  return getDb().prepare('SELECT id, username FROM dashboard_users WHERE username = ? COLLATE NOCASE AND disabled = 0')
    .get(username) as { id: number; username: string } | undefined
}
