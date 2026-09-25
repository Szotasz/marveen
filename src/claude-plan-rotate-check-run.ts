// The body of scripts/claude-plan-rotate-check.ts (see the long header
// comment there for the ROTATE / NO_ALTERNATIVE / FLEET_* stdout contract).
// It lives here, not in the script, so a test can drive runRotateCheck() with
// its collaborators mocked (claude-plan-rotate-check-run.test.ts): the script
// itself only calls it, and a top-level `await main()` cannot be imported.
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { decideAndRecord, pendingFleetReport } from './claude-plan-rotate-heartbeat.js'
import { readClaudePlans } from './web/claude-plans.js'
import { readClaudePlansState, writeClaudePlansState, recordPlanObservation } from './web/claude-plans-state.js'
import { probePlanUsage, observationFromProbe, selectPlansToProbe } from './claude-plan-usage-probe.js'
import { getSecret } from './web/vault.js'
import { getEffectiveSettingValue } from './settings-store.js'
import { MAIN_AGENT_ID, PROJECT_ROOT } from './config.js'

function settingIsOn(key: string): boolean {
  try { return String(getEffectiveSettingValue(key)) === '1' } catch { return false }
}

// Background refresh of IDLE plans' usage (live probe, see
// src/claude-plan-usage-probe.ts). The heartbeat below only ever observes the
// plan the main agent is on, so without this an idle plan's "last known %"
// (and estimateWindowFree's input for it) is frozen at whenever it was last
// active. selectPlansToProbe() decides who is due: 2+ plans only (single-plan
// installs: zero new calls), token-mode only, never the main agent's active
// plan, at most once per 30 min per plan. Runs BEFORE the rotation decision so
// that decision sees the fresh numbers. Prints nothing on stdout -- stdout is
// the ROTATE/NO_ALTERNATIVE channel the scheduled task's prompt parses.
// Only runs when CLAUDE_PLAN_USAGE_REFRESH=1 (see runRotateCheck).
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

export async function runRotateCheck(): Promise<void> {
  // Opt-in (CLAUDE_PLAN_USAGE_REFRESH, default off): every probe spends the
  // probed plan's own subscription quota, so nothing here calls the network
  // unless an operator turned it on. Independent of CLAUDE_ROTATION_ENABLED,
  // so the Settings usage bars can stay fresh without automatic rotation.
  try {
    if (settingIsOn('CLAUDE_PLAN_USAGE_REFRESH')) await refreshIdlePlans()
  } catch (err) {
    // Never let the probe pass take the rotation heartbeat down with it.
    console.error('claude-plan-rotate-check: idle-plan probe pass failed:', err instanceof Error ? err.name : 'error')
  }

  // Report a finished fleet leg once (see pendingFleetReport). Independent of
  // usage-collect below, so a failing collector never swallows the report.
  try {
    const report = pendingFleetReport(readClaudePlansState(), Date.now())
    if (report) {
      writeClaudePlansState(report.nextState)
      console.log(report.printLine)
    }
  } catch (err) {
    console.error('claude-plan-rotate-check: fleet report failed:', err instanceof Error ? err.name : 'error')
  }

  let raw: unknown
  try {
    const out = execFileSync('python3', [join(PROJECT_ROOT, 'scripts', 'usage-collect.py'), '--json'], {
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
      timeout: 30_000,
    })
    raw = JSON.parse(out)
  } catch (err) {
    // Fail open and silent on stdout (no action taken), loud on stderr (shows
    // up in the scheduled task's failure log) -- mirrors quota-snapshot.ts's
    // "everything degrades to null" rule.
    console.error('claude-plan-rotate-check: usage-collect.py failed:', err instanceof Error ? err.message : err)
    return
  }

  if (!settingIsOn('CLAUDE_ROTATION_ENABLED') || !settingIsOn('MAIN_AGENT_ISOLATED_CONFIG')) return

  const result = decideAndRecord({
    agentId: MAIN_AGENT_ID,
    plans: readClaudePlans(),
    state: readClaudePlansState(),
    usageCollectRaw: raw,
    nowMs: Date.now(),
  })

  if (result.nextState) writeClaudePlansState(result.nextState)
  if (result.printLine) console.log(result.printLine)
}
