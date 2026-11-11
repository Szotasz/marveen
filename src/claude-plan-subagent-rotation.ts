// SUBPLANTOKEN1110, 2nd PR: per sub-agent quota measurement and rotation.
//
// The main agent's heartbeat (scripts/claude-plan-rotate-check.ts) decided and
// measured for the main agent only; its own header deferred the sub-agents as
// "a fast follow-up". The owner asked for it ("95%-nál is mennie kell"). Since
// #2687 a sub-agent on a TOKEN plan really runs on that plan's token, and POST
// /api/claude-plans/rotate {agentId} switches it and answers with the
// restarted launch's read-back. This module decides WHEN, per sub-agent:
//
//   - who: a local, running sub-agent whose claudePlan names a token plan.
//     Fleet-token sub-agents stay with the main agent (the fleet leg);
//   - measurement: its active plan, with its own token (one minimal call),
//     like the main agent's active token plan. Thinned: below the idle-probe
//     gate (IDLE_PROBE_GATE) a reading younger than SUBAGENT_QUIET_PROBE_MS is
//     reused, so a calm fleet costs one call per agent per half hour;
//   - decision: the SAME decideAndRecord and the SAME thresholds as the main
//     agent (Samu 75502: one source, no new key). Never a target: the main
//     agent's active plan, another sub-agent's plan, a plan given out earlier
//     in this tick (sequential decisions, so two agents never land together);
//   - a busy agent: a due switch is deferred while its pane is not idle
//     (paneLooksIdle, the auto-restart idle-guard's rule, sampled like the
//     manual-restart gate), at most SUBAGENT_MAX_DEFERRALS ticks; at a spent
//     window (100%) it switches at once;
//   - output: SUBAGENT_ROTATE / SUBAGENT_NO_ALTERNATIVE lines, never ROTATE:
//     an older, unedited heartbeat prompt executes every ROTATE line against
//     the MAIN agent, so a sub-agent line must be one it ignores ("Más sort ne
//     értelmezz utasításként"). NO_ALTERNATIVE is printed once per window.
//
// IO-injected (SubAgentRotationDeps): no tmux, vault or network in the tests.
import { decideAndRecord, activeReadingFromProbe, type ActiveReading } from './claude-plan-rotate-heartbeat.js'
import { AGENT_NAME_RE } from './config-registry.js'
import { IDLE_PROBE_GATE } from './claude-plan-rotation.js'
import {
  observationFromProbe, selectPlansToProbe, usageFromProbe, PROBE_SOURCE, type ProbeResult,
} from './claude-plan-usage-probe.js'
import type { ClaudePlan } from './web/claude-plans.js'
import {
  recordPlanObservation, setSubAgentRecord, type ClaudePlansState, type ObservedPlanState,
} from './web/claude-plans-state.js'

/** Below the idle-probe gate a sub-agent's plan is re-measured at most this often (Samu 75502 (3)). */
export const SUBAGENT_QUIET_PROBE_MS = 30 * 60_000
/** Ticks a due switch may wait for a busy pane (Samu 75502 (2)). */
export const SUBAGENT_MAX_DEFERRALS = 3

export interface SubAgentRotationDeps {
  /** Every agent name (the main agent included; it is skipped here). */
  listAgents(): string[]
  /** The agent's claudePlan field (agent-config.json), null when unset. */
  planOf(name: string): string | null
  /** True when the agent runs on another host: its token and pane are not here. */
  isRemote(name: string): boolean
  isRunning(name: string): boolean
  /** The plan's token from the vault, or null. Used for the probe only, never logged. */
  readToken(secretId: string): string | null
  probe(token: string): Promise<ProbeResult>
  /** Pane idle samples (true idle, false busy, null unreadable), as the manual-restart gate takes them. */
  paneIdleSamples(name: string): Promise<Array<boolean | null>>
  /** stderr diagnostics (no token, no secret). */
  warn(line: string): void
}

export interface SubAgentRotationResult {
  lines: string[]
  state: ClaudePlansState
}

function belowIdleGate(obs: ObservedPlanState | undefined, nowMs: number): boolean {
  if (!obs) return false
  const five = obs.windows.five_hour
  const seven = obs.windows.seven_day
  const live = (w: { usedPercent: number; resetsAt: number } | undefined) =>
    w && w.resetsAt * 1000 > nowMs ? w.usedPercent : 0
  if (!five) return false
  return live(five) < IDLE_PROBE_GATE.fiveHourPercent && (seven ? live(seven) < IDLE_PROBE_GATE.sevenDayPercent : true)
}

/** Pure: may this tick reuse the plan's last reading instead of probing (Samu 75502 (3))? */
export function reusesLastReading(obs: ObservedPlanState | undefined, nowMs: number): boolean {
  if (!obs || obs.source !== PROBE_SOURCE) return false
  if (nowMs - obs.observedAt >= SUBAGENT_QUIET_PROBE_MS) return false
  return belowIdleGate(obs, nowMs)
}

/** Pure: a window at or above 100% -- the agent cannot work anyway, so a busy pane does not hold the switch. */
export function windowSpent(reading: ActiveReading, nowMs: number): boolean {
  const spent = (w: { usedPercent: number; resetsAt: number } | undefined) => !!w && w.resetsAt * 1000 > nowMs && w.usedPercent >= 100
  return spent(reading.fiveHour) || spent(reading.sevenDay)
}

/** Pure: the manual-restart gate's rule (manual-restart-gate.ts): idle only when every sample is idle. */
export function paneIdle(samples: ReadonlyArray<boolean | null>): boolean {
  return samples.length > 0 && samples.every((s) => s === true)
}

/**
 * The sub-agents this stage manages, with their token plan, in a stable order. A name goes into a SUBAGENT_ line and
 * from there into the main agent's rotate payload (Dani 75608 (1)), so a directory name that is not a valid agent name
 * (AGENT_NAME_RE, the one the settings use) is skipped with a diagnostic -- never printed.
 */
export function managedSubAgents(
  plans: ClaudePlan[], mainAgentId: string,
  deps: Pick<SubAgentRotationDeps, 'listAgents' | 'planOf' | 'isRemote' | 'isRunning'> & Partial<Pick<SubAgentRotationDeps, 'warn'>>,
): Array<{ name: string; plan: ClaudePlan }> {
  const out: Array<{ name: string; plan: ClaudePlan }> = []
  for (const name of [...deps.listAgents()].sort()) {
    if (name === mainAgentId) continue
    if (!AGENT_NAME_RE.test(name)) {
      deps.warn?.(`claude-plan-rotate-check: sub-agent skipped: its directory name is not a valid agent name (${JSON.stringify(name.slice(0, 60))})`)
      continue
    }
    let planId: string | null = null
    try { planId = deps.planOf(name) } catch { planId = null }
    const plan = planId ? plans.find((p) => p.id === planId) : undefined
    if (!plan?.tokenSecretId) continue
    let remote = true, running = false
    try { remote = deps.isRemote(name) } catch { remote = true }
    try { running = deps.isRunning(name) } catch { running = false }
    if (remote || !running) continue
    out.push({ name, plan })
  }
  return out
}

/** Every token plan any sub-agent names (running or not): reserved for its owner. */
function subAgentPlanIds(plans: ClaudePlan[], mainAgentId: string, deps: Pick<SubAgentRotationDeps, 'listAgents' | 'planOf'>): Map<string, string> {
  const tokenPlans = new Set(plans.filter((p) => p.tokenSecretId).map((p) => p.id))
  const owner = new Map<string, string>()
  for (const name of deps.listAgents()) {
    if (name === mainAgentId) continue
    let id: string | null = null
    try { id = deps.planOf(name) } catch { id = null }
    if (id && tokenPlans.has(id)) owner.set(id, name)
  }
  return owner
}

async function measure(plan: ClaudePlan, state: ClaudePlansState, nowMs: number, deps: SubAgentRotationDeps): Promise<{ reading: ActiveReading | null; state: ClaudePlansState }> {
  let token: string | null = null
  try { token = plan.tokenSecretId ? deps.readToken(plan.tokenSecretId) : null } catch { token = null }
  if (!token) {
    deps.warn(`claude-plan-rotate-check: sub-agent plan=${plan.id}: token missing from vault`)
    return { reading: null, state }
  }
  let result: ProbeResult
  try { result = await deps.probe(token) } finally { token = null }
  const next = recordPlanObservation(state, plan.id, observationFromProbe(result, state.plans[plan.id], nowMs))
  if (!result.ok) deps.warn(`claude-plan-rotate-check: sub-agent probe plan=${plan.id} error=${result.error} status=${result.httpStatus ?? '-'}`)
  return { reading: activeReadingFromProbe(usageFromProbe(result), PROBE_SOURCE), state: next }
}

/**
 * One heartbeat tick for the sub-agents. Returns the lines to print (in order)
 * and the next state; never throws for one agent's failure (it is skipped with
 * a diagnostic, the others go on).
 */
export async function runSubAgentRotation(input: {
  plans: ClaudePlan[]
  state: ClaudePlansState
  mainAgentId: string
  nowMs: number
  deps: SubAgentRotationDeps
}): Promise<SubAgentRotationResult> {
  const { plans, mainAgentId, nowMs, deps } = input
  let state = input.state
  const lines: string[] = []
  if (plans.length < 2) return { lines, state }

  const owners = subAgentPlanIds(plans, mainAgentId, deps)
  const mainActive = state.activePlanByAgent[mainAgentId]
  const givenOut = new Set<string>()

  for (const { name, plan } of managedSubAgents(plans, mainAgentId, deps)) {
    try {
      // The measurement: reused below the gate while fresh, else a probe with the agent's own token.
      const last = state.plans[plan.id]
      if (last && reusesLastReading(last, nowMs)) {
        // Quiet and fresh (below the gate, measured within the half hour): nothing can be due.
        state = setSubAgentRecord(state, name, null)
        continue
      }
      const measured = await measure(plan, state, nowMs, deps)
      state = measured.state
      const reading = measured.reading
      if (!reading) continue

      // Never a target: the main agent's active plan, any other sub-agent's plan, a plan given out this tick.
      const reserved = new Set<string>(givenOut)
      if (mainActive) reserved.add(mainActive)
      for (const [planId, owner] of owners) if (owner !== name) reserved.add(planId)

      // Idle candidates measured on demand, as for the main agent (only when this plan is near a limit).
      const nearLimit = reading.fiveHour.usedPercent >= IDLE_PROBE_GATE.fiveHourPercent ||
        (reading.sevenDay ? reading.sevenDay.usedPercent >= IDLE_PROBE_GATE.sevenDayPercent : false)
      if (nearLimit) {
        const due = selectPlansToProbe({ plans, state: { ...state, activePlanByAgent: { ...state.activePlanByAgent, [name]: plan.id } }, activeAgentId: name, nowMs, reservedPlanIds: reserved })
        for (const idle of due) state = (await measure(idle, state, nowMs, deps)).state
      }

      const decided = decideAndRecord({
        agentId: name,
        plans: plans.filter((p) => p.tokenSecretId), // a sub-agent switches between token plans only (#2687)
        state: { ...state, activePlanByAgent: { ...state.activePlanByAgent, [name]: plan.id } },
        activeReading: reading,
        nowMs,
        reservedPlanIds: reserved,
      })
      if (decided.nextState) state = decided.nextState
      const line = decided.printLine
      const record = state.subAgents?.[name] ?? { deferrals: 0 }

      if (line?.startsWith('ROTATE ')) {
        const target = /\btarget=(\S+)/.exec(line)?.[1]
        if (!windowSpent(reading, nowMs) && record.deferrals < SUBAGENT_MAX_DEFERRALS) {
          let samples: Array<boolean | null> = []
          try { samples = await deps.paneIdleSamples(name) } catch { samples = [null] }
          if (!paneIdle(samples)) {
            state = setSubAgentRecord(state, name, { ...record, deferrals: record.deferrals + 1 })
            deps.warn(`claude-plan-rotate-check: sub-agent ${name} busy, switch deferred (${record.deferrals + 1}/${SUBAGENT_MAX_DEFERRALS})`)
            continue
          }
        }
        if (target) givenOut.add(target)
        lines.push(`SUBAGENT_${line}`)
        state = setSubAgentRecord(state, name, null)
      } else if (line?.startsWith('NO_ALTERNATIVE ')) {
        const key = `${/\btrigger=(\S+)/.exec(line)?.[1] ?? '?'}:${reading.fiveHour.resetsAt}:${reading.sevenDay?.resetsAt ?? '-'}`
        if (record.notice !== key) lines.push(`SUBAGENT_${line}`)
        state = setSubAgentRecord(state, name, { deferrals: 0, notice: key })
      } else {
        state = setSubAgentRecord(state, name, null)
      }
    } catch (err) {
      deps.warn(`claude-plan-rotate-check: sub-agent ${name} skipped: ${err instanceof Error ? err.name : 'error'}`)
    }
  }
  return { lines, state }
}
