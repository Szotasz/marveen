// Per-secret reader allowlist for the vault (VAULTSZELES826, phase F0).
//
// F0 is AUDIT ONLY. Nothing here blocks a read: the route logs what the
// allowlist WOULD decide, so the seven-day log answers "who reads what" with
// measured rows instead of the skill_usage approximation the plan started
// from. Enforcement (403 for an agent principal that is not listed) is phase
// F2 and arrives behind a registry switch whose CODE default stays 'audit'.
//
// The allowlist lives in store/vault-acl.json, NOT inside the encrypted
// vault.json: it is not a secret, the dashboard must read and edit it without
// the master key, and every vault.json write goes through the master-key path
// (VAULTUJKULCS822). Shape: { "<secret-id>": ["agent-id", ...] }. An id with
// no entry, or an empty list, means "no agent may read it" once F2 enforces --
// a missing right shows up as one 403 line and is fixed with one click, an
// extra right shows up nowhere.
//
// Known limit, stated in the plan: the file is writable by the same OS user
// every agent runs as, so an agent could list itself. F2 adds a change log and
// a notification for that; the OS-user split (F3 prerequisite) closes it.
//
// F1 arrived with the per-agent dashboard tokens (agent-tokens.ts): a request
// on a sub-agent's own token carries an AUTHENTICATED agent name, and
// principalOf() reports it as kind 'agent', so every audit row now names the
// reading agent and the allowlist can be filled from measured rows. The code
// default stays 'audit', as planned: a sub-agent token's read is logged with
// its verdict and served. VAULT_ACL_AGENT_MODE=enforce makes the dashboard
// gate refuse an agent principal the file does not list (auth-gate.ts
// isAgentVaultReadAllowed). The owner lanes (shared token, session, device)
// stay audit-only in both modes.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { STORE_DIR } from '../config.js'
import { readEnvFile } from '../env.js'
import { logger } from '../logger.js'
import type { RouteContext } from './routes/types.js'

export const VAULT_ACL_PATH = join(STORE_DIR, 'vault-acl.json')

export type VaultAcl = Record<string, string[]>

// VAULT_ACL_AGENT_MODE: 'audit' (default) or 'enforce', for AGENT principals
// only. Read like the other rollout flags (process env first, then .env),
// cached for a few seconds because the gate asks on every agent vault read.
export type VaultAclAgentMode = 'enforce' | 'audit'
let agentModeCache: { value: VaultAclAgentMode; at: number } | null = null
export function vaultAclAgentMode(now: number = Date.now()): VaultAclAgentMode {
  if (agentModeCache && now - agentModeCache.at < 5000) return agentModeCache.value
  let raw = process.env.VAULT_ACL_AGENT_MODE
  if (raw === undefined || raw.trim() === '') {
    try { raw = readEnvFile(['VAULT_ACL_AGENT_MODE']).VAULT_ACL_AGENT_MODE } catch { raw = undefined }
  }
  const value: VaultAclAgentMode = String(raw ?? '').trim().toLowerCase() === 'enforce' ? 'enforce' : 'audit'
  agentModeCache = { value, at: now }
  return value
}
export function _resetVaultAclAgentModeCacheForTest(): void { agentModeCache = null }

// Missing file = empty allowlist. A malformed file is ALSO an empty allowlist
// (plus a warning), never a throw: a broken ACL must not take the vault route
// down with it, and in F0 an empty list changes nothing anyway.
export function readVaultAcl(path: string = VAULT_ACL_PATH): VaultAcl {
  if (!existsSync(path)) return {}
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'))
  } catch (err) {
    logger.warn({ path, err: (err as Error).message }, 'vault-acl: unreadable or malformed, treating as empty')
    return {}
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    logger.warn({ path }, 'vault-acl: top level is not an object, treating as empty')
    return {}
  }
  const acl: VaultAcl = {}
  for (const [id, agents] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(agents)) continue
    acl[id] = agents.filter((a): a is string => typeof a === 'string' && a.trim().length > 0).map(a => a.trim())
  }
  return acl
}

// The principal is the NAME of who asked, never a credential. The shared
// dashboard token has no name by design: it is one credential for everyone.
// A sub-agent's OWN token does (auth.agent, authenticated), and is reported as
// the F1 { kind: 'agent' }. The self-asserted X-Agent-Id (claimedAgent) is
// never a principal.
export function principalOf(auth: RouteContext['auth']): { kind: string; principal: string } {
  if (!auth) return { kind: 'none', principal: 'none' }
  switch (auth.kind) {
    case 'session': return { kind: 'session', principal: auth.user ?? 'session' }
    case 'device': return { kind: 'device', principal: auth.device ?? 'device' }
    case 'federation': return { kind: 'federation', principal: auth.peer ?? 'federation' }
    case 'token': return auth.agent ? { kind: 'agent', principal: auth.agent } : { kind: 'token', principal: 'token' }
    default: {
      // Forward-compatible with the F1 'agent' kind without widening the union
      // here: an unknown kind carrying an `agent` name is reported as such.
      const a = auth as { kind: string; agent?: string }
      return { kind: a.kind, principal: a.agent ?? a.kind }
    }
  }
}

// What the allowlist decides for this read. Only an AGENT principal is ever
// subject to it (owner lanes -- token, session, device -- pass in F2 too, the
// plan says so explicitly); the verdict is still computed and logged for every
// kind so the audit rows are uniform.
export type VaultAclVerdict = 'owner-lane' | 'allowed' | 'not-listed' | 'no-acl'

export function evaluateVaultRead(id: string, auth: RouteContext['auth'], acl: VaultAcl): VaultAclVerdict {
  const { kind, principal } = principalOf(auth)
  if (kind !== 'agent') return 'owner-lane'
  const listed = acl[id]
  if (!listed || listed.length === 0) return 'no-acl'
  return listed.includes(principal) ? 'allowed' : 'not-listed'
}

// The ONE audit line per value read. Fields: which secret, which credential
// kind, which principal, what the allowlist says, and whether the secret
// existed. The VALUE is never passed in and never logged -- the function
// signature has no parameter for it on purpose.
export function logVaultRead(id: string, auth: RouteContext['auth'], found: boolean, acl: VaultAcl = readVaultAcl()): void {
  const { kind, principal } = principalOf(auth)
  logger.info({
    event: 'vault-read',
    id,
    kind,
    principal,
    acl: evaluateVaultRead(id, auth, acl),
    // An agent principal is checked at the gate (auth-gate.ts); in 'enforce'
    // mode it got here only because it is listed.
    mode: kind === 'agent' ? vaultAclAgentMode() : 'audit',
    found,
  }, 'vault: secret value read')
}

// SSH private keys live in the vault as `ssh-key-<id>` and are consumed ONLY in-process by
// the SSH feature (routes/vault-ssh-keys.ts). No generic path may hand one out: not the
// value route, not a binding (env var / header), not the runtime resolvers. One predicate,
// so the concept is closed at every writer, not at one endpoint (Samu, #1512 review).
// The two .mjs resolvers cannot import TypeScript and carry the same one-line check.
export function isSshPrivateKeyId(id: string): boolean {
  return id.trim().startsWith('ssh-key-')
}
