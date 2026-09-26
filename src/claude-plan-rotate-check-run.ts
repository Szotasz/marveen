// The body of scripts/claude-plan-rotate-check.ts (see the long header
// comment there for the ROTATE / NO_ALTERNATIVE / FLEET_* stdout contract).
// It lives here, not in the script, so a test can drive runRotateCheck() with
// its collaborators mocked (claude-plan-rotate-check-run.test.ts): the script
// itself only calls it, and a top-level `await main()` cannot be imported.
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import {
  decideAndRecord, pendingFleetReport, activeReadingNearLimit, activeReadingFromUsageCollect, activeReadingFromProbe,
  type ActiveReading,
} from './claude-plan-rotate-heartbeat.js'
import { readClaudePlans, type ClaudePlan } from './web/claude-plans.js'
import { readClaudePlansState, writeClaudePlansState, recordPlanObservation } from './web/claude-plans-state.js'
import { probePlanUsage, observationFromProbe, selectPlansToProbe, usageFromProbe, PROBE_SOURCE } from './claude-plan-usage-probe.js'
import { getSecret } from './web/vault.js'
import { getEffectiveSettingValue } from './settings-store.js'
import { MAIN_AGENT_ID, PROJECT_ROOT } from './config.js'

function settingIsOn(key: string): boolean {
  try { return String(getEffectiveSettingValue(key)) === '1' } catch { return false }
}

// On-demand refresh of IDLE plans' usage (live probe, see
// src/claude-plan-usage-probe.ts). The heartbeat below only ever observes the
// plan the main agent is on, so without this an idle plan's "last known %"
// (and estimateWindowFree's input for it) is frozen at whenever it was last
// active. selectPlansToProbe() decides who is due: 2+ plans only (single-plan
// installs: zero new calls), token-mode only, never the main agent's active
// plan, at most once per 30 min per plan. Runs BEFORE the rotation decision so
// that decision sees the fresh numbers. Prints nothing on stdout -- stdout is
// the ROTATE/NO_ALTERNATIVE channel the scheduled task's prompt parses.
// Only runs when CLAUDE_PLAN_USAGE_REFRESH=1 AND the active plan is near a
// limit (activePlanNearLimit, see runRotateCheck).
export async function refreshIdlePlans(): Promise<void> {
  const due = selectPlansToProbe({
    plans: readClaudePlans(),
    state: readClaudePlansState(),
    activeAgentId: MAIN_AGENT_ID,
    nowMs: Date.now(),
  })
  for (const plan of due) {
    let token: string | null = null
    try { token = plan.tokenSecretId ? getSecret(plan.tokenSecretId) : null } catch { token = null }
    if (!token) {
      console.error(`claude-plan-rotate-check: probe skipped for plan=${plan.id}: token missing from vault`)
      continue
    }
    const result = await probePlanUsage(token)
    token = null
    const nowMs = Date.now()
    const state = readClaudePlansState()
    writeClaudePlansState(recordPlanObservation(state, plan.id, observationFromProbe(result, state.plans[plan.id], nowMs)))
    if (!result.ok) console.error(`claude-plan-rotate-check: probe plan=${plan.id} error=${result.error} status=${result.httpStatus ?? '-'}`)
  }
}

// The main agent's active plan when it is a TOKEN-mode plan that is actually
// in effect, else null. Mirrors the launch-side gate (agent-process.ts
// resolveActiveMainPlan + main-agent-isolated-config.mjs precedence): a
// recorded plan only drives the main agent's login with
// MAIN_AGENT_ISOLATED_CONFIG=1, 2+ plans, and no explicit
// MAIN_AGENT_CONFIG_DIR. Outside that, the main agent runs on the host login,
// which is exactly what usage-collect.py reads.
export function activeTokenPlan(plans: ClaudePlan[]): ClaudePlan | null {
  if (!settingIsOn('MAIN_AGENT_ISOLATED_CONFIG')) return null
  let explicitDir = ''
  try { explicitDir = String(getEffectiveSettingValue('MAIN_AGENT_CONFIG_DIR') ?? '').trim() } catch { explicitDir = '' }
  if (explicitDir) return null
  if (plans.length < 2) return null
  const activeId = readClaudePlansState().activePlanByAgent[MAIN_AGENT_ID]
  const plan = plans.find((p) => p.id === activeId)
  return plan?.tokenSecretId ? plan : null
}

// Live usage of the ACTIVE token-mode plan, read with its own token -- the
// same probe as POST /api/claude-plans/:id/probe. Runs on every heartbeat
// tick: the per-plan probe throttles (30 min idle, 60 s manual) exist to keep
// idle plans' quota untouched, and do not apply to the plan the main agent is
// spending anyway. The outcome is recorded as that plan's observation either
// way; null (no reading) on a missing token or a probe without usage headers,
// which the decision treats as "unknown" (fail open, stay silent).
async function probeActivePlan(plan: ClaudePlan): Promise<ActiveReading | null> {
  let token: string | null = null
  try { token = plan.tokenSecretId ? getSecret(plan.tokenSecretId) : null } catch { token = null }
  if (!token) {
    console.error(`claude-plan-rotate-check: active plan=${plan.id}: token missing from vault`)
    return null
  }
  const result = await probePlanUsage(token)
  token = null
  const nowMs = Date.now()
  const state = readClaudePlansState()
  writeClaudePlansState(recordPlanObservation(state, plan.id, observationFromProbe(result, state.plans[plan.id], nowMs)))
  if (!result.ok) console.error(`claude-plan-rotate-check: active probe plan=${plan.id} error=${result.error} status=${result.httpStatus ?? '-'}`)
  return activeReadingFromProbe(usageFromProbe(result), PROBE_SOURCE)
}

export async function runRotateCheck(): Promise<void> {
  // Report a finished fleet leg once (see pendingFleetReport). Independent of
  // the usage reading below, so a failing collector never swallows the report.
  try {
    const report = pendingFleetReport(readClaudePlansState(), Date.now())
    if (report) {
      writeClaudePlansState(report.nextState)
      console.log(report.printLine)
    }
  } catch (err) {
    console.error('claude-plan-rotate-check: fleet report failed:', err instanceof Error ? err.name : 'error')
  }

  // The active plan's usage, from exactly ONE source (see ActiveReading):
  // its own probe when it is a token-mode plan in effect, otherwise
  // usage-collect.py (the host login, which is then the right account).
  const tokenPlan = activeTokenPlan(readClaudePlans())
  let reading: ActiveReading | null
  if (tokenPlan) {
    try {
      reading = await probeActivePlan(tokenPlan)
    } catch (err) {
      console.error('claude-plan-rotate-check: active plan probe failed:', err instanceof Error ? err.name : 'error')
      reading = null
    }
  } else {
    try {
      const out = execFileSync('python3', [join(PROJECT_ROOT, 'scripts', 'usage-collect.py'), '--json'], {
        cwd: PROJECT_ROOT,
        encoding: 'utf-8',
        timeout: 30_000,
      })
      reading = activeReadingFromUsageCollect(JSON.parse(out))
    } catch (err) {
      // Fail open and silent on stdout (no action taken), loud on stderr --
      // mirrors quota-snapshot.ts's "everything degrades to null" rule.
      console.error('claude-plan-rotate-check: usage-collect.py failed:', err instanceof Error ? err.message : err)
      return
    }
  }

  // Idle-plan probes happen on demand only: when the active plan is near a
  // limit (IDLE_PROBE_GATE, a little below the rotation thresholds), so the
  // decision below -- in this same tick -- ranks the candidates on fresh
  // numbers. With a healthy active plan nothing is probed: every probe spends
  // the probed plan's own quota for a decision nobody is about to make.
  // CLAUDE_PLAN_USAGE_REFRESH (default on) is the operator's off switch.
  // Independent of CLAUDE_ROTATION_ENABLED, so the Settings usage bars still
  // refresh near a limit without automatic rotation.
  try {
    if (settingIsOn('CLAUDE_PLAN_USAGE_REFRESH') && activeReadingNearLimit(reading, Date.now())) await refreshIdlePlans()
  } catch (err) {
    // Never let the probe pass take the rotation heartbeat down with it.
    console.error('claude-plan-rotate-check: idle-plan probe pass failed:', err instanceof Error ? err.name : 'error')
  }

  if (!settingIsOn('CLAUDE_ROTATION_ENABLED') || !settingIsOn('MAIN_AGENT_ISOLATED_CONFIG')) return

  const result = decideAndRecord({
    agentId: MAIN_AGENT_ID,
    plans: readClaudePlans(),
    // Read AFTER the probes, so their fresh observations are what the
    // candidates are ranked on.
    state: readClaudePlansState(),
    activeReading: reading,
    nowMs: Date.now(),
  })

  if (result.nextState) writeClaudePlansState(result.nextState)
  if (result.printLine) console.log(result.printLine)
}
