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
import { isAgentTokenScope, AGENT_TOKEN_SCOPES, type AgentTokenScope } from './agent-token-scope.js'

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
  /** Set once the token was revoked; the row is kept so audit lookups resolve. */
  revokedAt: number | null
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

// The shapes an agent token accepts, owned HERE rather than at the HTTP route,
// because the route is only one of two entry points: web.ts also mounts
// createAgentToken in-process for delivery, and a guard that exists on one
// entry point is missing in practice (review request, PR #1449).
export const AGENT_TOKEN_AGENT_ID_RE = /^[a-zA-Z0-9._-]{1,64}$/
export const AGENT_TOKEN_LABEL_RE = /^[\p{L}\p{N} ._-]{1,64}$/u

/** Thrown by createAgentToken on invalid input, so an in-process caller fails
 *  loudly instead of writing a row the gate can never resolve. */
export class AgentTokenValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AgentTokenValidationError'
  }
}

export function createAgentToken(
  agentId: string,
  label: string,
  scope: AgentTokenScope,
  opts: { expiresInDays?: number } = {},
): MintedAgentToken {
  if (!AGENT_TOKEN_AGENT_ID_RE.test(agentId)) {
    throw new AgentTokenValidationError('Invalid agent_id (1-64 chars: letters, digits, . _ -)')
  }
  if (!isAgentTokenScope(scope)) {
    throw new AgentTokenValidationError(`Invalid scope '${scope}'. Allowed: ${AGENT_TOKEN_SCOPES.join(', ')}`)
  }
  if (!AGENT_TOKEN_LABEL_RE.test(label)) {
    throw new AgentTokenValidationError('Invalid label (1-64 chars: letters, digits, space, . _ -)')
  }
  const raw = TOKEN_PREFIX + randomBytes(32).toString('base64url')
  const tokenHash = sha256hex(raw)
  const now = nowSec()
  const expiresAt = opts.expiresInDays ? now + Math.floor(opts.expiresInDays * 24 * 60 * 60) : null
  const info = getDb()
    .prepare('INSERT INTO agent_tokens (token_hash, agent_id, label, scope, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(tokenHash, agentId, label, scope, now, null, expiresAt)
  const id = Number(info.lastInsertRowid)
  cache.set(tokenHash, { id, agentId, scope, lastUsedAt: null, expiresAt })
  return { id, agentId, label, scope, createdAt: now, lastUsedAt: null, expiresAt, revokedAt: null, token: raw }
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
      .prepare('SELECT id, agent_id, scope, last_used_at, expires_at, revoked_at FROM agent_tokens WHERE token_hash = ?')
      .get(tokenHash) as { id: number; agent_id: string; scope: string; last_used_at: number | null; expires_at: number | null; revoked_at: number | null } | undefined
    if (!row) return null
    // A revoked row is kept for attribution, so presence is no longer proof of
    // validity: it has to be checked explicitly, and it is never cached.
    if (row.revoked_at !== null) return null
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
    const res = getDb()
      .prepare('UPDATE agent_tokens SET last_used_at = ? WHERE token_hash = ? AND revoked_at IS NULL')
      .run(now, tokenHash)
    // The debounced write doubles as a validity check, so a revocation made in
    // another process takes effect here within <=60s instead of lingering until
    // the next dashboard restart. `AND revoked_at IS NULL` is what keeps that
    // true now that revoking no longer deletes the row -- without it the UPDATE
    // would still match and a revoked token would stay alive in this process.
    if (res.changes === 0) {
      cache.delete(tokenHash)
      return null
    }
  }
  return { id: entry.id, agent: entry.agentId, scope: entry.scope }
}

function rowToInfo(r: { id: number; agent_id: string; label: string; scope: string; created_at: number; last_used_at: number | null; expires_at: number | null; revoked_at: number | null }): AgentTokenInfo {
  return {
    id: r.id,
    agentId: r.agent_id,
    label: r.label,
    scope: r.scope as AgentTokenScope,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    expiresAt: r.expires_at,
    revokedAt: r.revoked_at,
  }
}

const INFO_COLUMNS = 'id, agent_id, label, scope, created_at, last_used_at, expires_at, revoked_at'

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

// Revocation is immediate but NOT destructive: the row stays and is stamped,
// the cached entry goes, so the very next request with the token falls through
// the gate. Keeping the row is the point -- an audit record naming a token id
// must still resolve to who held it after the token is dead (review request,
// PR #1449). `revoked_at IS NULL` in the WHERE makes a second revoke a no-op
// rather than a silent re-stamp with a later time.
export function revokeAgentToken(id: number): boolean {
  const res = getDb()
    .prepare('UPDATE agent_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
    .run(nowSec(), id)
  for (const [hash, entry] of cache) {
    if (entry.id === id) cache.delete(hash)
  }
  return res.changes > 0
}

// Break-glass: every remote agent loses access at once. Runs alongside the
// device-key sweep in security:reset.
export function revokeAllAgentTokens(): number {
  const res = getDb().prepare('UPDATE agent_tokens SET revoked_at = ? WHERE revoked_at IS NULL').run(nowSec())
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
