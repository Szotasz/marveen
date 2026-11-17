// Temporary agent lease (AGENTLEASE1117): an owner-issued, time-boxed permission for the shared dashboard token to
// create, run and delete throwaway test agents on a LOCAL model, without the owner's session on every request.
//
// What it is NOT: authentication. The shared token (store/.dashboard-token) is readable by every process of this OS
// user, so while a lease is active ANY holder of that token can use it, not only the main agent. The design therefore
// limits what a lease can do, not who uses it:
//   - only the shared token (kind 'token' without tokenAgent) can use it: a sub-agent's own token is confined by the
//     gate's allowlist anyway, and a device key, a peer or an operator never needs it;
//   - create: the name starts with LEASE_NAME_PREFIX, the agent's customProvider is a configured provider whose base
//     URL host is LOOPBACK (isLoopbackBaseUrl), the security profile is LEASE_PROFILE_ID (strict, nothing allowed
//     outside the agent's own directory, no web tools; .mcp.json is emptied), and at most maxAgents creations per
//     lease (a deleted agent does not free its slot: a create/delete loop cannot spam the owner's notifications);
//   - delete: only an agent created under the CURRENT active lease;
//   - nothing else: channel setup, pairing, trust, plan, MCP, profile, persona and provider writes stay owner-only;
//   - expiry or revoke stops and deletes every agent created under the lease, and every use notifies the owner.
//
// The state is one small JSON file (store/agent-lease.json, atomic writes), the current or the last lease. This
// module holds the state and the pure decisions; the routes and the cleanup are in routes/agent-leases.ts.
import { existsSync, readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import { atomicWriteFileSync } from './atomic-write.js'
import { loadCustomProvider } from './custom-providers.js'
import type { RouteContext } from './routes/types.js'

export const AGENT_LEASE_PATH = join(PROJECT_ROOT, 'store', 'agent-lease.json')
export const LEASE_NAME_PREFIX = 'tmp-'
export const LEASE_PROFILE_ID = 'lease-sandbox'
export const LEASE_MINUTES_MAX = 60
export const LEASE_MAX_AGENTS_MAX = 3
export const LEASE_NOTE_MAX = 200

export type LeaseStatus = 'active' | 'expired' | 'revoked'

export interface LeaseAgent {
  name: string
  createdAt: string
  deletedAt?: string
  /** 'lease' (deleted with the lease token), 'owner', 'expired' or 'revoked' (the cleanup). */
  deletedBy?: string
}

export interface AgentLease {
  id: string
  status: LeaseStatus
  createdAt: string
  expiresAt: string
  minutes: number
  maxAgents: number
  note: string
  /** Who issued it (the owner's session user, or the Bridge device name). */
  by: string
  endedAt?: string
  agents: LeaseAgent[]
}

/** The current or the last lease, null when none was ever issued. An unreadable file is null: it grants nothing
 *  (fail-closed), and a new lease overwrites it. */
export function readAgentLease(): AgentLease | null {
  if (!existsSync(AGENT_LEASE_PATH)) return null
  try {
    const s = JSON.parse(readFileSync(AGENT_LEASE_PATH, 'utf-8')) as Partial<AgentLease>
    if (typeof s.id !== 'string' || typeof s.expiresAt !== 'string' || !Array.isArray(s.agents)) return null
    const status: LeaseStatus = s.status === 'active' || s.status === 'revoked' ? s.status : 'expired'
    return {
      id: s.id,
      status,
      createdAt: typeof s.createdAt === 'string' ? s.createdAt : '',
      expiresAt: s.expiresAt,
      minutes: Number(s.minutes) || 0,
      maxAgents: Number(s.maxAgents) || 0,
      note: typeof s.note === 'string' ? s.note : '',
      by: typeof s.by === 'string' ? s.by : '?',
      ...(typeof s.endedAt === 'string' ? { endedAt: s.endedAt } : {}),
      agents: s.agents.filter((a): a is LeaseAgent => !!a && typeof a.name === 'string'),
    }
  } catch {
    return null
  }
}

export function writeAgentLease(lease: AgentLease): void {
  atomicWriteFileSync(AGENT_LEASE_PATH, JSON.stringify(lease, null, 2))
}

/** True while the lease is marked active but its time ran out: the cleanup is due. */
export function leaseIsOverdue(lease: AgentLease | null, now: number = Date.now()): boolean {
  return !!lease && lease.status === 'active' && Date.parse(lease.expiresAt) <= now
}

/** The lease that may be used right now: marked active and not past its expiry (an unparsable expiry is past). */
export function activeAgentLease(now: number = Date.now()): AgentLease | null {
  const lease = readAgentLease()
  if (!lease || lease.status !== 'active') return null
  const exp = Date.parse(lease.expiresAt)
  if (!Number.isFinite(exp) || exp <= now) return null
  return lease
}

/** Validates the owner's POST body. minutes 1..60 (default 60), maxAgents 1..3 (default 3), note optional. */
export function parseLeaseRequest(body: Record<string, unknown>): { ok: true; minutes: number; maxAgents: number; note: string } | { ok: false; error: string } {
  const minutes = body.minutes === undefined ? LEASE_MINUTES_MAX : Number(body.minutes)
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > LEASE_MINUTES_MAX) {
    return { ok: false, error: `minutes must be an integer between 1 and ${LEASE_MINUTES_MAX}` }
  }
  const maxAgents = body.maxAgents === undefined ? LEASE_MAX_AGENTS_MAX : Number(body.maxAgents)
  if (!Number.isInteger(maxAgents) || maxAgents < 1 || maxAgents > LEASE_MAX_AGENTS_MAX) {
    return { ok: false, error: `maxAgents must be an integer between 1 and ${LEASE_MAX_AGENTS_MAX}` }
  }
  if (body.note !== undefined && typeof body.note !== 'string') return { ok: false, error: 'note must be a string' }
  const note = (typeof body.note === 'string' ? body.note : '').trim()
  if (note.length > LEASE_NOTE_MAX) return { ok: false, error: `note is too long (max ${LEASE_NOTE_MAX})` }
  return { ok: true, minutes, maxAgents, note }
}

export function newAgentLease(minutes: number, maxAgents: number, note: string, by: string, now: number = Date.now()): AgentLease {
  return {
    id: randomBytes(6).toString('hex'),
    status: 'active',
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + minutes * 60_000).toISOString(),
    minutes,
    maxAgents,
    note,
    by,
    agents: [],
  }
}

/** "Local" for a lease means exactly: the provider's base URL parses, uses http or https, and its host is loopback --
 *  the name `localhost`, an IPv4 address in 127.0.0.0/8, or the IPv6 `::1`. Nothing else: not 0.0.0.0, not a LAN
 *  address, not `*.localhost`, not a name that merely resolves to loopback. Note what this does NOT prove: a loopback
 *  endpoint can itself be a proxy that forwards to a paid cloud model (see docs/agent-lease.md). */
export function isLoopbackBaseUrl(baseUrl: string): boolean {
  let u: URL
  try { u = new URL(baseUrl) } catch { return false }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  if (u.username || u.password) return false
  const host = u.hostname.toLowerCase()
  if (host === 'localhost') return true
  if (host === '[::1]' || host === '::1') return true
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  return !!m && m.slice(1).every((o) => Number(o) <= 255)
}

/** Only the shared token may use a lease (never a sub-agent's own token, a device key, a peer or a session). */
export function mayUseLeaseCredential(auth: RouteContext['auth']): boolean {
  return auth?.kind === 'token' && !auth.tokenAgent
}

export type LeaseRefusal = { ok: false; code: string; error: string }

/** The create decision for a caller that is NOT the owner. Pure apart from reading the provider registry. */
export function leaseCreateDecision(
  lease: AgentLease | null,
  req: { name: string; customProvider: string | null; profile: string | null },
): { ok: true } | LeaseRefusal {
  if (!lease) return { ok: false, code: 'no_active_lease', error: 'Creating an agent needs the dashboard login (an owner session), or an active agent lease.' }
  if (!req.name.startsWith(LEASE_NAME_PREFIX) || req.name.length <= LEASE_NAME_PREFIX.length) {
    return { ok: false, code: 'lease_name', error: `Under an agent lease the name must start with "${LEASE_NAME_PREFIX}".` }
  }
  if (req.profile !== null && req.profile !== LEASE_PROFILE_ID) {
    return { ok: false, code: 'lease_profile', error: `Under an agent lease the security profile is always "${LEASE_PROFILE_ID}".` }
  }
  if (!req.customProvider) return { ok: false, code: 'lease_provider', error: 'Under an agent lease a customProvider with a loopback base URL is required.' }
  const def = loadCustomProvider(req.customProvider)
  if (!def) return { ok: false, code: 'lease_provider', error: `Unknown custom provider: ${req.customProvider}` }
  if (!isLoopbackBaseUrl(def.baseUrl)) {
    return { ok: false, code: 'lease_provider', error: 'Under an agent lease the custom provider must be local (its base URL host is localhost, 127.x.x.x or ::1).' }
  }
  if (lease.agents.length >= lease.maxAgents) {
    return { ok: false, code: 'lease_limit', error: `The agent lease allows ${lease.maxAgents} agent(s), all used.` }
  }
  return { ok: true }
}

/** The delete decision for a caller that is NOT the owner: only an agent created under the active lease, still there. */
export function leaseDeleteDecision(lease: AgentLease | null, name: string): { ok: true } | LeaseRefusal {
  if (!lease) return { ok: false, code: 'no_active_lease', error: 'Deleting an agent needs the dashboard login (an owner session), or an active agent lease.' }
  if (!lease.agents.some((a) => a.name === name && !a.deletedAt)) {
    return { ok: false, code: 'lease_not_owned', error: 'An agent lease may delete only an agent created under it.' }
  }
  return { ok: true }
}

/** Records a creation on the active lease (called synchronously right after the decision, before anything awaits, so
 *  two concurrent creates cannot both take the last slot). Returns false when the lease changed in between. */
export function recordLeaseAgent(leaseId: string, name: string, now: number = Date.now()): boolean {
  const lease = activeAgentLease(now)
  if (!lease || lease.id !== leaseId || lease.agents.length >= lease.maxAgents) return false
  lease.agents.push({ name, createdAt: new Date(now).toISOString() })
  writeAgentLease(lease)
  return true
}

/** Marks an agent of the current or last lease deleted (no-op when it is not on it). */
export function markLeaseAgentDeleted(name: string, by: string, now: number = Date.now()): void {
  const lease = readAgentLease()
  if (!lease) return
  const a = lease.agents.find((x) => x.name === name && !x.deletedAt)
  if (!a) return
  a.deletedAt = new Date(now).toISOString()
  a.deletedBy = by
  writeAgentLease(lease)
}

/** True when `name` was created under the current or last lease and is not marked deleted. */
export function isLeaseAgent(name: string): boolean {
  return !!readAgentLease()?.agents.some((a) => a.name === name && !a.deletedAt)
}
