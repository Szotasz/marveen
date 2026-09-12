// Named Claude subscription registry -- dashboard-facing CRUD (PR2b).
//
// GET was the whole surface in PR1 (moved here unchanged from agents.ts).
// PR2b adds POST/PUT/DELETE on store/claude-plans.json, plus a read-only
// GET .../state for the (not-yet-written, PR2c) rotation side-car. See
// docs/superpowers/specs/2026-09-11-claude-key-rotation-design.md section 7.
//
// Every write runs the body through validatePlan() -- the exact function
// resolveClaudePlans() uses to parse the file back -- so nothing invalid can
// reach disk through this route that the read side would then silently drop.
import { homedir } from 'node:os'
import { readBody, json } from '../http-helpers.js'
import { logger } from '../../logger.js'
import { readClaudePlans, writeClaudePlans, validatePlan } from '../claude-plans.js'
import { readClaudePlansState } from '../claude-plans-state.js'
import type { RouteContext } from './types.js'

export async function tryHandleClaudePlans(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  // Resolved + validated registry. Feeds the per-agent plan dropdown; empty
  // array when no registry file exists (opt-in feature).
  if (path === '/api/claude-plans' && method === 'GET') {
    json(res, readClaudePlans())
    return true
  }

  // Create a new plan.
  if (path === '/api/claude-plans' && method === 'POST') {
    let body: unknown
    try {
      body = JSON.parse((await readBody(req)).toString())
    } catch {
      json(res, { error: 'Invalid JSON' }, 400)
      return true
    }

    const plan = validatePlan(body, homedir())
    if (!plan) {
      json(res, {
        error: 'Invalid plan: id (letters/digits/_.- only), label, configDir (safe absolute or ~-prefixed path, no traversal/spaces), planType (personal|team) and channelsAllowed (boolean) are all required',
      }, 400)
      return true
    }

    const current = readClaudePlans()
    if (current.some((p) => p.id === plan.id)) {
      json(res, { error: `Plan id already exists: ${plan.id}` }, 409)
      return true
    }

    writeClaudePlans([...current, plan])
    logger.info({ id: plan.id }, 'Claude plan created')
    json(res, plan, 201)
    return true
  }

  // Rotation telemetry side-car (store/claude-plans-state.json). Nothing
  // writes it until PR2c ships the rotation wiring -- until then this reports
  // an honest empty state instead of 404ing, so the dashboard cards can
  // render "no rotation data yet" rather than treating the endpoint itself as
  // missing. Checked before the :id matcher below so a plan literally named
  // "state" can never shadow this route.
  if (path === '/api/claude-plans/state' && method === 'GET') {
    json(res, readClaudePlansState())
    return true
  }

  const idMatch = path.match(/^\/api\/claude-plans\/([^/]+)$/)

  // Replace an existing plan's fields. The id in the URL is authoritative --
  // a differing id in the body is discarded, so this can never rename a plan
  // into colliding with a different existing entry.
  if (idMatch && method === 'PUT') {
    let body: unknown
    try {
      body = JSON.parse((await readBody(req)).toString())
    } catch {
      json(res, { error: 'Invalid JSON' }, 400)
      return true
    }

    const current = readClaudePlans()
    const idx = current.findIndex((p) => p.id === idMatch[1])
    if (idx === -1) {
      json(res, { error: 'Not found' }, 404)
      return true
    }

    const candidate = { ...(body && typeof body === 'object' ? body : {}), id: idMatch[1] }
    const plan = validatePlan(candidate, homedir())
    if (!plan) {
      json(res, {
        error: 'Invalid plan: label, configDir (safe absolute or ~-prefixed path, no traversal/spaces), planType (personal|team) and channelsAllowed (boolean) are all required',
      }, 400)
      return true
    }

    const next = [...current]
    next[idx] = plan
    writeClaudePlans(next)
    logger.info({ id: plan.id }, 'Claude plan updated')
    json(res, plan)
    return true
  }

  // Remove a plan. An agent still pointing a claudePlan field at this id
  // simply starts reporting planUnresolved afterwards (resolveAgentConfigDir
  // already handles that) -- deleting here does not touch any agent config.
  if (idMatch && method === 'DELETE') {
    const current = readClaudePlans()
    const next = current.filter((p) => p.id !== idMatch[1])
    if (next.length === current.length) {
      json(res, { error: 'Not found' }, 404)
      return true
    }

    writeClaudePlans(next)
    logger.info({ id: idMatch[1] }, 'Claude plan deleted')
    json(res, { ok: true })
    return true
  }

  return false
}
