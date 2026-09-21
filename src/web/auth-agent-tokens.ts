// Per-agent scoped dashboard tokens (TOKENSZUKITES909).
//
// The shared dashboard token is an all-or-nothing credential: whoever holds it
// can drive the terminal, read the vault, mint users. That is fine for scripts
// running on THIS machine; it is not something to hand to an agent living on a
// third party's network. An agent token is the narrow alternative:
//
//   - bound to ONE agent id, so what it writes is attributable and it cannot
//     impersonate another agent (see agentTokenIdentityViolation);
//   - bound to a named SCOPE -- a default-deny endpoint allowlist enforced in
//     the gate, not per route, so a route added tomorrow is denied by default;
//   - revocable alone, without rotating the token every fleet script embeds.
//
// Modeled on auth-device-keys.ts: only sha256(token) is stored, in the DB and
// in the cache, so neither a DB leak nor a heap dump yields a usable credential.
// Zero rows = the feature is off and the gate falls through exactly as before.

import { randomBytes, createHash } from 'node:crypto'
import { getDb } from '../db.js'
import { isAgentTokenScope, type AgentTokenScope } from './agent-token-scope.js'

const LAST_USED_DEBOUNCE_SEC = 60

// Distinct from the device-key prefix (mvdk_) and from the 64-hex dashboard
// token, so a leaked credential is recognizable on sight and in secret scanners.
const TOKEN_PREFIX = 'mvat_'

export interface AgentTokenPrincipal {
  id: number
  agent: string
  scope: AgentTokenScope
}

export interface AgentTokenInfo {
  id: number
  agentId: string
  label: string
  scope: AgentTokenScope
  createdAt: number
  lastUsedAt: number | null
  expiresAt: number | null
}

export interface MintedAgentToken extends AgentTokenInfo {
  /** The raw credential. Returned ONCE at mint time, never recoverable. */
  token: string
}

interface CachedToken {
  id: number
  agentId: string
  scope: AgentTokenScope
  lastUsedAt: number | null
  expiresAt: number | null
}

const cache = new Map<string, CachedToken>()

function sha256hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

export function createAgentToken(
  agentId: string,
  label: string,
  scope: AgentTokenScope,
  opts: { expiresInDays?: number } = {},
): MintedAgentToken {
  const raw = TOKEN_PREFIX + randomBytes(32).toString('base64url')
  const tokenHash = sha256hex(raw)
  const now = nowSec()
  const expiresAt = opts.expiresInDays ? now + Math.floor(opts.expiresInDays * 24 * 60 * 60) : null
  const info = getDb()
    .prepare('INSERT INTO agent_tokens (token_hash, agent_id, label, scope, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(tokenHash, agentId, label, scope, now, null, expiresAt)
  const id = Number(info.lastInsertRowid)
  cache.set(tokenHash, { id, agentId, scope, lastUsedAt: null, expiresAt })
  return { id, agentId, label, scope, createdAt: now, lastUsedAt: null, expiresAt, token: raw }
}

function removeByHash(tokenHash: string): void {
  cache.delete(tokenHash)
  getDb().prepare('DELETE FROM agent_tokens WHERE token_hash = ?').run(tokenHash)
}

// Validate a presented raw token. Returns the agent principal or null. A row
// whose stored scope is no longer a known profile fails CLOSED (null) rather
// than falling back to something permissive.
export function resolveAgentToken(raw: string): AgentTokenPrincipal | null {
  if (!raw || !raw.startsWith(TOKEN_PREFIX)) return null
  const tokenHash = sha256hex(raw)
  let entry = cache.get(tokenHash)
  if (!entry) {
    const row = getDb()
      .prepare('SELECT id, agent_id, scope, last_used_at, expires_at FROM agent_tokens WHERE token_hash = ?')
      .get(tokenHash) as { id: number; agent_id: string; scope: string; last_used_at: number | null; expires_at: number | null } | undefined
    if (!row) return null
    if (!isAgentTokenScope(row.scope)) return null
    entry = { id: row.id, agentId: row.agent_id, scope: row.scope, lastUsedAt: row.last_used_at, expiresAt: row.expires_at }
    cache.set(tokenHash, entry)
  }
  const now = nowSec()
  if (entry.expiresAt !== null && now > entry.expiresAt) {
    removeByHash(tokenHash)
    return null
  }
  if (entry.lastUsedAt === null || now - entry.lastUsedAt >= LAST_USED_DEBOUNCE_SEC) {
    entry.lastUsedAt = now
    const res = getDb().prepare('UPDATE agent_tokens SET last_used_at = ? WHERE token_hash = ?').run(now, tokenHash)
    // The debounced write doubles as an existence check, so a revocation made
    // in another process takes effect here within <=60s instead of lingering
    // until the next dashboard restart.
    if (res.changes === 0) {
      cache.delete(tokenHash)
      return null
    }
  }
  return { id: entry.id, agent: entry.agentId, scope: entry.scope }
}

function rowToInfo(r: { id: number; agent_id: string; label: string; scope: string; created_at: number; last_used_at: number | null; expires_at: number | null }): AgentTokenInfo {
  return {
    id: r.id,
    agentId: r.agent_id,
    label: r.label,
    scope: r.scope as AgentTokenScope,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    expiresAt: r.expires_at,
  }
}

const INFO_COLUMNS = 'id, agent_id, label, scope, created_at, last_used_at, expires_at'

export function listAgentTokens(): AgentTokenInfo[] {
  const rows = getDb()
    .prepare(`SELECT ${INFO_COLUMNS} FROM agent_tokens ORDER BY created_at DESC`)
    .all() as Parameters<typeof rowToInfo>[0][]
  return rows.map(rowToInfo)
}

export function getAgentToken(id: number): AgentTokenInfo | null {
  const row = getDb().prepare(`SELECT ${INFO_COLUMNS} FROM agent_tokens WHERE id = ?`).get(id) as Parameters<typeof rowToInfo>[0] | undefined
  return row ? rowToInfo(row) : null
}

// Revocation is immediate: the row and any cached entry go together, so the
// very next request with the token falls through the gate.
export function revokeAgentToken(id: number): boolean {
  const res = getDb().prepare('DELETE FROM agent_tokens WHERE id = ?').run(id)
  for (const [hash, entry] of cache) {
    if (entry.id === id) cache.delete(hash)
  }
  return res.changes > 0
}

// Break-glass: every remote agent loses access at once. Runs alongside the
// device-key sweep in security:reset.
export function revokeAllAgentTokens(): number {
  const res = getDb().prepare('DELETE FROM agent_tokens').run()
  cache.clear()
  return res.changes
}

// Hourly sweep of tokens past their (opt-in) expiry. Tokens without expires_at
// are never touched.
export function sweepExpiredAgentTokens(): number {
  const now = nowSec()
  const res = getDb().prepare('DELETE FROM agent_tokens WHERE expires_at IS NOT NULL AND expires_at < ?').run(now)
  for (const [hash, entry] of cache) {
    if (entry.expiresAt !== null && entry.expiresAt < now) cache.delete(hash)
  }
  return res.changes
}

// Test seam: drop the in-memory cache to simulate a process restart.
export function _clearAgentTokenCacheForTest(): void {
  cache.clear()
}
