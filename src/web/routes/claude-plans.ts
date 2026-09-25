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
import { readClaudePlans, writeClaudePlans, validatePlan, PLAN_ID_ALLOWED, tokenSecretIdFor } from '../claude-plans.js'
import { setSecret, deleteSecret } from '../vault.js'
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

// A raw `token` combined with configDir or tokenSecretId is ambiguous -- the
// caller almost certainly meant only one of them. Rejected explicitly rather
// than silently dropping `token` (which would otherwise sail through as an
// unrecognized field while validatePlan happily accepts the configDir/
// tokenSecretId that WAS present, masking the caller's mistake).
function hasAmbiguousTokenField(raw: Record<string, unknown>): boolean {
  return typeof raw.token === 'string' && raw.token.trim().length > 0
    && (Boolean(raw.configDir) || Boolean(raw.tokenSecretId))
}

// Token-mode convenience: the caller sends a raw `token` field (the literal
// `claude setup-token` output) instead of pre-populating the vault and
// passing tokenSecretId directly -- this is the whole point of token-mode
// (see ClaudePlan.tokenSecretId): no separate vault-management step, paste
// the token and go.
//
// PURE -- writes NOTHING to the vault. It only builds the candidate object
// validatePlan() will see (tokenSecretId swapped in, raw `token` stripped so
// it never reaches store/claude-plans.json or a GET response) plus what
// WOULD be written if the caller commits it later. The caller must run
// validatePlan() (and any other rejection check, e.g. a duplicate id) FIRST,
// and only setSecret() the pendingToken once everything else has already
// succeeded.
//
// PR #1304 review (a): the previous version wrote to the vault right here,
// before validation. On a PUT that reuses an existing token-mode plan's id,
// the write landed on that plan's EXISTING vault entry (same derived id) --
// so an invalid PUT (bad token plus some unrelated bad field) overwrote the
// live secret, validation then failed, and the failure-path cleanup deleted
// the same id -- destroying a working credential on a 400 response.
function prepareTokenCandidate(
  raw: Record<string, unknown>,
  planId: string,
): { candidate: Record<string, unknown>; pendingToken: { secretId: string; label: string; value: string } | null } {
  if (typeof raw.token !== 'string' || !raw.token.trim()) {
    return { candidate: raw, pendingToken: null }
  }
  if (!planId || !PLAN_ID_ALLOWED.test(planId)) return { candidate: raw, pendingToken: null }
  const secretId = tokenSecretIdFor(planId)
  const { token: _discard, ...rest } = raw
  return {
    candidate: { ...rest, tokenSecretId: secretId },
    pendingToken: {
      secretId,
      label: `Claude plan token: ${typeof raw.label === 'string' ? raw.label : planId}`,
      value: raw.token.trim(),
    },
  }
}

// Defense in depth beyond validatePlan's own derived-form check (PR #1304
// review (b)): deleteSecret must never fire on anything but the plan's OWN
// tokenSecretId, even if a caller somehow got a different id attached to it
// (e.g. a hand-edited store/claude-plans.json -- validatePlan on read would
// normally just drop such an entry, but this keeps the deletion call sites
// safe independently of that, rather than relying on a single upstream gate
// for a primitive this destructive).
// Exported for a direct unit test: with validatePlan now also enforcing the
// derived-form-only rule, a foreign tokenSecretId can no longer reach disk
// through this route at all, so the "DELETE never removes a non-prefixed
// secret" guarantee has no route-level path left to exercise it through --
// this function IS the guarantee, and is tested directly.
export function deleteOwnTokenSecret(planId: string, secretId: string | null | undefined): void {
  if (secretId && secretId === tokenSecretIdFor(planId)) deleteSecret(secretId)
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

    const rawBody = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
    if (hasAmbiguousTokenField(rawBody)) {
      json(res, { error: 'Invalid plan: token cannot be combined with configDir or tokenSecretId' }, 400)
      return true
    }
    const rawId = typeof rawBody.id === 'string' ? rawBody.id.trim() : ''
    const { candidate, pendingToken } = prepareTokenCandidate(rawBody, rawId)

    const plan = validatePlan(candidate, homedir())
    if (!plan) {
      json(res, {
        error: 'Invalid plan: id (letters/digits/_.- only), label, exactly one of configDir (safe absolute or ~-prefixed path, no traversal/spaces) or token (raw claude setup-token output), planType (personal|team) and channelsAllowed (boolean) are all required',
      }, 400)
      return true
    }

    const current = readClaudePlans()
    if (current.some((p) => p.id === plan.id)) {
      json(res, { error: `Plan id already exists: ${plan.id}` }, 409)
      return true
    }

    // Vault write happens only now, after every rejection check has already
    // passed -- see prepareTokenCandidate's header.
    if (pendingToken) setSecret(pendingToken.secretId, pendingToken.label, pendingToken.value)
    writeClaudePlans([...current, plan])
    logger.info({ id: plan.id, mode: plan.tokenSecretId ? 'token' : 'configDir' }, 'Claude plan created')
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

    const rawBody = { ...(body && typeof body === 'object' ? body : {}), id: idMatch[1] } as Record<string, unknown>
    if (hasAmbiguousTokenField(rawBody)) {
      json(res, { error: 'Invalid plan: token cannot be combined with configDir or tokenSecretId' }, 400)
      return true
    }
    const { candidate, pendingToken } = prepareTokenCandidate(rawBody, idMatch[1])
    const plan = validatePlan(candidate, homedir())
    if (!plan) {
      // Vault untouched -- an invalid PUT (even one carrying a fresh raw
      // token) never writes or deletes anything, so this plan's existing
      // token-mode secret (if any) survives exactly as it was.
      json(res, {
        error: 'Invalid plan: label, exactly one of configDir (safe absolute or ~-prefixed path, no traversal/spaces) or token (raw claude setup-token output), planType (personal|team) and channelsAllowed (boolean) are all required',
      }, 400)
      return true
    }

    // Vault write happens only now, after validation succeeded. For an
    // existing token-mode plan this overwrites the SAME derived id in place
    // (setSecret upserts), which is why the orphan-check below compares
    // against plan.tokenSecretId rather than skipping when pendingToken is set.
    if (pendingToken) setSecret(pendingToken.secretId, pendingToken.label, pendingToken.value)

    // Switching a plan OUT of token-mode (or dropping it via a PUT that omits
    // `token`) must not orphan the old secret -- the vault-hygiene guarantee
    // the SSH-key store already gives (docs/vault.md).
    const previousTokenSecretId = current[idx].tokenSecretId
    if (previousTokenSecretId && previousTokenSecretId !== plan.tokenSecretId) {
      deleteOwnTokenSecret(idMatch[1], previousTokenSecretId)
    }

    const next = [...current]
    next[idx] = plan
    writeClaudePlans(next)
    logger.info({ id: plan.id, mode: plan.tokenSecretId ? 'token' : 'configDir' }, 'Claude plan updated')
    json(res, plan)
    return true
  }

  // Remove a plan. An agent still pointing a claudePlan field at this id
  // simply starts reporting planUnresolved afterwards (resolveAgentConfigDir
  // already handles that) -- deleting here does not touch any agent config.
  if (idMatch && method === 'DELETE') {
    const current = readClaudePlans()
    const removed = current.find((p) => p.id === idMatch[1])
    const next = current.filter((p) => p.id !== idMatch[1])
    if (next.length === current.length) {
      json(res, { error: 'Not found' }, 404)
      return true
    }

    if (removed) deleteOwnTokenSecret(removed.id, removed.tokenSecretId)
    writeClaudePlans(next)
    logger.info({ id: idMatch[1] }, 'Claude plan deleted')
    json(res, { ok: true })
    return true
  }

  return false
}
