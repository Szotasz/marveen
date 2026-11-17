// Temporary agent lease API (AGENTLEASE1117); the state and the decisions are in src/web/agent-lease.ts.
//
//   GET    /api/agent-leases           -> { active, lease }        owner only
//   POST   /api/agent-leases           { minutes?, maxAgents?, note? } -> issue one; 409 while one is active
//   DELETE /api/agent-leases/current   -> revoke: the same cleanup as the expiry
//
// All three need the owner (mayActAsOwner), never the first-run setup: a lease is a grant TO the shared token, so the
// shared token can never issue, read or revoke one itself.
//
// The cleanup (endAgentLease) marks the lease ended FIRST, so no further create or delete passes on it, then stops and
// deletes every agent created under it through the same removal the DELETE /api/agents/:name route uses. It runs from
// the dashboard's 60-second tick (sweepAgentLease, web.ts) and on request (every lease-gated create/delete and the GET
// call it), so an expired lease grants nothing even between two ticks.
import { existsSync } from 'node:fs'
import { logConfigChange } from '../../db.js'
import { logger } from '../../logger.js'
import { notifyOwner } from '../../notify.js'
import { agentDir } from '../agent-config.js'
import {
  activeAgentLease, leaseIsOverdue, markLeaseAgentDeleted, newAgentLease, parseLeaseRequest, readAgentLease,
  writeAgentLease, type AgentLease,
} from '../agent-lease.js'
import { json, readBody } from '../http-helpers.js'
import { mayActAsOwner, ownerCookieSession, refuseOwner } from './auth.js'
import type { RouteContext } from './types.js'

const BODY_MAX_BYTES = 4 * 1024

/** The removal of one agent (the DELETE /api/agents/:name path). Injected by routes/agents.ts at import time so this
 *  module does not import that one (agents.ts imports the lease decisions from agent-lease.ts). */
let removeAgent: ((name: string) => Promise<void>) | null = null
export function setLeaseAgentRemover(fn: ((name: string) => Promise<void>) | null): void { removeAgent = fn }

function ownerActor(auth: RouteContext['auth'], req: RouteContext['req']): string {
  if (auth?.kind === 'session') return `session:${auth.user ?? '?'}`
  if (auth?.kind === 'device') return `device:${auth.device ?? '?'}`
  return `token+session:${ownerCookieSession(req) ?? '?'}`
}

/** One owner notification per lease use. Never throws, never awaited by the caller's decision. */
export function notifyLeaseUse(text: string): void {
  void notifyOwner(`[Ügynök-bérlet] ${text}`).catch(() => {})
}

let ending: Promise<AgentLease | null> | null = null

/** Ends the active lease ('expired' or 'revoked'): marks it ended, then stops and deletes every agent created under
 *  it. Concurrent callers share one run. Returns the ended lease, or null when none was active. */
export function endAgentLease(reason: 'expired' | 'revoked', by: string): Promise<AgentLease | null> {
  if (ending) return ending
  ending = (async () => {
    const lease = readAgentLease()
    if (!lease || lease.status !== 'active') return null
    lease.status = reason
    lease.endedAt = new Date().toISOString()
    writeAgentLease(lease)
    logConfigChange(`agent_lease.${reason}`, lease.id, JSON.stringify({ agents: lease.agents.filter((a) => !a.deletedAt).map((a) => a.name) }), by)
    logger.warn({ lease: lease.id, reason, by }, 'agent lease ended; deleting its agents')
    for (const a of lease.agents) {
      if (a.deletedAt) continue
      const there = existsSync(agentDir(a.name))
      try {
        if (there) {
          if (!removeAgent) throw new Error('agent remover not wired')
          await removeAgent(a.name)
        }
        markLeaseAgentDeleted(a.name, reason)
        if (there) {
          logConfigChange('agent_lease.delete', lease.id, a.name, reason)
          notifyLeaseUse(`${a.name} törölve (a bérlet ${reason === 'expired' ? 'lejárt' : 'visszavonva'}).`)
        }
      } catch (err) {
        // Left on the lease as not deleted: the GET shows it, and the owner deletes it by hand.
        logger.error({ err, agent: a.name, lease: lease.id }, 'agent lease cleanup: could not delete the agent')
        notifyLeaseUse(`${a.name} törlése NEM sikerült a bérlet végén; töröld kézzel a dashboardon.`)
      }
    }
    return readAgentLease()
  })().finally(() => { ending = null })
  return ending
}

/** The expiry check: ends an overdue lease. Called by the 60-second tick and before every lease decision. */
export async function sweepAgentLease(now: number = Date.now()): Promise<void> {
  if (leaseIsOverdue(readAgentLease(), now)) await endAgentLease('expired', 'expiry')
}

export async function tryHandleAgentLeases(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, auth } = ctx
  if (path !== '/api/agent-leases' && path !== '/api/agent-leases/current') return false
  // One owner gate for the three handlers below, before any of them reads or writes the lease.
  if ((path === '/api/agent-leases' || path === '/api/agent-leases/current') && !mayActAsOwner(auth, req)) {
    refuseOwner(res, 'Agent leases need the dashboard login (an owner session).')
    return true
  }

  if (path === '/api/agent-leases' && method === 'GET') {
    await sweepAgentLease()
    json(res, { active: activeAgentLease() !== null, lease: readAgentLease() })
    return true
  }

  if (path === '/api/agent-leases' && method === 'POST') {
    let body: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse((await readBody(req, { maxBytes: BODY_MAX_BYTES })).toString() || '{}')
      body = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
    } catch {
      json(res, { error: 'Invalid JSON' }, 400)
      return true
    }
    const p = parseLeaseRequest(body)
    if (!p.ok) { json(res, { error: p.error }, 400); return true }
    await sweepAgentLease()
    if (activeAgentLease()) { json(res, { error: 'An agent lease is already active; revoke it first.', code: 'lease_active' }, 409); return true }
    const by = ownerActor(auth, req)
    const lease = newAgentLease(p.minutes, p.maxAgents, p.note, by)
    writeAgentLease(lease)
    logConfigChange('agent_lease.create', null, JSON.stringify({ id: lease.id, minutes: lease.minutes, maxAgents: lease.maxAgents, expiresAt: lease.expiresAt, note: lease.note }), by)
    logger.warn({ lease: lease.id, minutes: lease.minutes, maxAgents: lease.maxAgents, by }, 'agent lease issued')
    json(res, { ok: true, active: true, lease })
    return true
  }

  if (path === '/api/agent-leases/current' && method === 'DELETE') {
    await sweepAgentLease()
    const ended = await endAgentLease('revoked', ownerActor(auth, req))
    if (!ended) { json(res, { error: 'No active agent lease', code: 'no_active_lease' }, 404); return true }
    json(res, { ok: true, active: false, lease: ended })
    return true
  }

  json(res, { error: 'Method not allowed' }, 405)
  return true
}
