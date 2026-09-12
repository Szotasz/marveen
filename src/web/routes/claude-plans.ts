// Named Claude subscription registry -- dashboard-facing CRUD (PR2b), plus
// the rotation trigger (PR2c). See
// docs/superpowers/specs/2026-09-11-claude-key-rotation-design.md sections 6
// and 7.
//
// GET was the whole surface in PR1 (moved here unchanged from agents.ts).
// PR2b added POST/PUT/DELETE on store/claude-plans.json plus a read-only
// GET .../state. PR2c adds the write side of the state side-car
// (POST .../rotate) -- the one code path both the (not-yet-built) manual
// dashboard button and the automatic heartbeat decision (design 6.3, wired in
// scripts/claude-plan-rotate-check.ts) call.
//
// Every plan write runs the body through validatePlan() -- the exact function
// resolveClaudePlans() uses to parse the file back -- so nothing invalid can
// reach disk through this route that the read side would then silently drop.
import { homedir } from 'node:os'
import { existsSync } from 'node:fs'
import { readBody, json } from '../http-helpers.js'
import { logger } from '../../logger.js'
import { MAIN_AGENT_ID } from '../../config.js'
import { getEffectiveSettingValue } from '../../settings-store.js'
import { readClaudePlans, writeClaudePlans, validatePlan } from '../claude-plans.js'
import { readClaudePlansState, writeClaudePlansState, applyRotation } from '../claude-plans-state.js'
import { agentDir, writeAgentClaudePlan } from '../agent-config.js'
import { restartAgentProcess } from '../agent-process.js'
import { hardRestartMarveenChannels } from '../channel-monitor.js'
import type { RouteContext } from './types.js'

function isRotationEnabled(): boolean {
  try { return String(getEffectiveSettingValue('CLAUDE_ROTATION_ENABLED')) === '1' } catch { return false }
}

function isMainAgentIsolated(): boolean {
  try { return String(getEffectiveSettingValue('MAIN_AGENT_ISOLATED_CONFIG')) === '1' } catch { return false }
}

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

  // Rotation telemetry side-car (store/claude-plans-state.json). An honest
  // empty state ({activePlanByAgent:{}, plans:{}}) when nothing has rotated
  // yet, rather than 404ing, so the dashboard cards can render "no rotation
  // data yet" instead of treating the endpoint itself as missing. Checked
  // before the :id matcher below so a plan literally named "state" can never
  // shadow this route.
  if (path === '/api/claude-plans/state' && method === 'GET') {
    json(res, readClaudePlansState())
    return true
  }

  // Trigger a rotation for one agent (PR2c, design 6.5/5). Body:
  // { agentId?: string, targetPlanId: string }. agentId defaults to the main
  // channels agent -- the only caller today is the heartbeat script, and a
  // manual dashboard button (not yet built) would default the same way.
  //
  // This is ALSO how an agent's very first plan assignment happens: there is
  // no separate "bootstrap" endpoint. applyRotation() just adds an entry when
  // none existed (design 6.5/4's open bootstrap question -- resolved this
  // way because a first assignment and a later rotation are the same
  // operation: "agentId is now on targetPlanId").
  if (path === '/api/claude-plans/rotate' && method === 'POST') {
    let body: unknown
    try {
      body = JSON.parse((await readBody(req)).toString())
    } catch {
      json(res, { error: 'Invalid JSON' }, 400)
      return true
    }
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
    const agentId = typeof b.agentId === 'string' && b.agentId.trim() ? b.agentId.trim() : MAIN_AGENT_ID
    const targetPlanId = typeof b.targetPlanId === 'string' ? b.targetPlanId.trim() : ''
    if (!targetPlanId) {
      json(res, { error: 'targetPlanId is required' }, 400)
      return true
    }

    if (!isRotationEnabled()) {
      json(res, { error: 'Rotation is disabled (CLAUDE_ROTATION_ENABLED=0)' }, 409)
      return true
    }

    const plans = readClaudePlans()
    const target = plans.find((p) => p.id === targetPlanId)
    if (!target) {
      json(res, { error: `Unknown target plan id: ${targetPlanId}` }, 400)
      return true
    }
    // Guardrail from design decision #5: a plan not marked channelsAllowed is
    // not a rotation candidate, whatever the caller asks for.
    if (!target.channelsAllowed) {
      json(res, { error: `Plan ${targetPlanId} does not allow channels use (channelsAllowed=false)` }, 400)
      return true
    }

    if (agentId === MAIN_AGENT_ID) {
      // Design 6.2: rotation is only meaningful on the isolated-config path,
      // and only once 2+ plans exist -- otherwise there is nothing to
      // resolve a "rotated" configDir against (agent-process.js:
      // resolveMainAgentRotatedConfigDir has the same gate, so a stale state
      // entry can never silently take effect if the operator turns isolation
      // back off or drops to one plan).
      if (!isMainAgentIsolated() || plans.length < 2) {
        json(res, {
          error: 'Rotation not applicable: main agent needs MAIN_AGENT_ISOLATED_CONFIG=1 and at least 2 registered plans',
        }, 409)
        return true
      }

      // Record the decision BEFORE restarting: the next launch resolves its
      // CLAUDE_CONFIG_DIR by reading this file back
      // (main-agent-isolated-config.mjs -> resolveMainAgentRotatedConfigDir),
      // so the state has to be on disk before the process that will read it
      // comes up.
      writeClaudePlansState(applyRotation(readClaudePlansState(), MAIN_AGENT_ID, targetPlanId))

      const result = hardRestartMarveenChannels()
      if (!result.ok) {
        json(res, { error: result.error || 'Main agent restart failed' }, 500)
        return true
      }
      logger.info({ agentId, targetPlanId }, 'Claude plan rotation: main agent restarted')
      json(res, { ok: true, agentId, activePlanId: targetPlanId })
      return true
    }

    // Sub-agent path: point its claudePlan field at the target and restart it
    // through the same primitive the dashboard's own restart button uses --
    // no separate sub-agent rotation mechanism to keep in sync.
    if (!existsSync(agentDir(agentId))) {
      json(res, { error: `Agent not found: ${agentId}` }, 404)
      return true
    }
    writeClaudePlansState(applyRotation(readClaudePlansState(), agentId, targetPlanId))
    writeAgentClaudePlan(agentId, targetPlanId)
    const result = await restartAgentProcess(agentId)
    if (!result.ok) {
      json(res, { error: result.error || `Restart failed for agent ${agentId}` }, 500)
      return true
    }
    logger.info({ agentId, targetPlanId }, 'Claude plan rotation: agent restarted')
    json(res, { ok: true, agentId, activePlanId: targetPlanId })
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
