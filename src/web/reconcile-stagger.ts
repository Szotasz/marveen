// BOOTSTAGGER1007 (c): the reconcile brings sub-agents back MAIN FIRST, and
// one at a time by readiness, not on a fixed clock.
//
// MEASURED 2026-10-07 (store/dashboard.log 15:58-16:02, after a power cut): the
// reconcile started a sub-agent every 15 s (AGENT_RECONCILE_STAGGER_MS) while
// the main session was booting next to them, but a claude session with its MCP
// servers takes longer than 15 s to come up, so 15 sessions ran their boots on
// top of each other (load 21) and the main session's MCP connects were the
// ones competing for the box.
//
// Two rules, both bounded so one stuck agent never holds the rest:
//   - main first: no sub-agent starts until the main session is ready (its
//     primary channel plugin and every co-listen plugin are alive), at most
//     RECONCILE_MAIN_FIRST_MAX_WAIT_MS after the dashboard started;
//   - between sub-agents: at least RECONCILE_MIN_GAP_MS (the old 15 s, which
//     guards the resume-modal race), then go on as soon as the previous agent
//     is ready OR the box is not loaded, at most RECONCILE_MAX_GAP_MS.
//
// Pure + injectable: the caller owns the clock, the sleep and the probes.

export const RECONCILE_MAIN_FIRST_MAX_WAIT_MS = 5 * 60 * 1000
export const RECONCILE_MIN_GAP_MS = 15_000
export const RECONCILE_MAX_GAP_MS = 90_000
export const RECONCILE_GAP_POLL_MS = 3_000
/** 1-minute load average per CPU under which the box counts as not loaded. */
export const RECONCILE_LOAD_OK_PER_CPU = 1.0

/** May the reconcile start sub-agents now? */
export function mainFirstGate(mainReady: boolean, msSinceMonitorStart: number): 'go' | 'wait' {
  if (mainReady) return 'go'
  return msSinceMonitorStart >= RECONCILE_MAIN_FIRST_MAX_WAIT_MS ? 'go' : 'wait'
}

export type GapEnd = 'ready' | 'load' | 'max'

export interface GapDeps {
  now: () => number
  sleep: (ms: number) => Promise<void>
  /** Is the agent just started ready (its session at the prompt)? */
  isReady: () => Promise<boolean>
  /** 1-minute load average divided by the CPU count; null when unknown. */
  loadPerCpu: () => number | null
}

/**
 * Wait after starting one agent before the next: never less than the minimum
 * gap, then until the agent is ready or the load is low, never past the max.
 */
export async function waitReconcileGap(d: GapDeps): Promise<{ end: GapEnd; waitedMs: number }> {
  const start = d.now()
  await d.sleep(RECONCILE_MIN_GAP_MS)
  for (;;) {
    const waited = d.now() - start
    if (await d.isReady()) return { end: 'ready', waitedMs: waited }
    const load = d.loadPerCpu()
    if (load !== null && load < RECONCILE_LOAD_OK_PER_CPU) return { end: 'load', waitedMs: waited }
    if (waited >= RECONCILE_MAX_GAP_MS) return { end: 'max', waitedMs: waited }
    await d.sleep(Math.min(RECONCILE_GAP_POLL_MS, RECONCILE_MAX_GAP_MS - waited))
  }
}

export interface ReconcileBurstDeps {
  /** Desired agents that were down when the burst was decided. */
  down: string[]
  /**
   * Is the agent still desired NOW? Asked right before each start: the gaps
   * make a burst last minutes, and the dashboard's stop/delete paths rely on
   * a removed agent not being started again (an orphan session, or an rmSync
   * under a live one -- #1764 review).
   */
  isDesired: (name: string) => boolean
  /** Is the main session up for the owner (primary + every co-listen plugin)? Asked once. */
  mainReady: () => boolean
  msSinceMonitorStart: number
  isAgentRunning: (name: string) => boolean
  isRestartInFlight: (name: string) => boolean
  isWithinRestartGrace: (name: string) => boolean
  memGateAllowsStart: (name: string) => boolean
  start: (name: string) => Promise<{ ok: boolean; error?: string }>
  /** Bookkeeping right after a start attempt (the monitor's restart grace stamp). */
  afterStart: (name: string) => void
  /** The gap after a start (waitReconcileGap with the real probes). */
  gap: (name: string) => Promise<{ end: GapEnd; waitedMs: number }>
  log: (level: 'info' | 'warn' | 'error', fields: Record<string, unknown>, msg: string) => void
}

/**
 * One reconcile burst: the main-first gate, then the down agents one at a
 * time, each followed by its readiness gap. Returns the gate's answer and the
 * agents a start was attempted for. Never throws for one agent's failure.
 */
export async function runReconcileBurst(d: ReconcileBurstDeps): Promise<{ gate: 'go' | 'wait'; started: string[] }> {
  const started: string[] = []
  if (d.down.length === 0) return { gate: 'go', started }
  // Main first: after a boot the owner's channel matters more than the fleet,
  // and every sub-agent boot competes with the main session's MCP connects.
  const gate = mainFirstGate(d.mainReady(), d.msSinceMonitorStart)
  if (gate === 'wait') return { gate, started }
  for (const name of d.down) {
    if (!d.isDesired(name)) {
      d.log('info', { agent: name }, 'Reconcile: agent no longer desired (stopped or deleted during the burst) -- not starting it')
      continue
    }
    if (d.isAgentRunning(name)) continue
    // A managed restart (context guard, auto-restart, model fallback, the
    // dashboard button) is stop+start, and isAgentRunning() reports false for
    // the ~2s the stop spends waiting on tmux. Starting the agent in that
    // window does not heal a crash -- it overtakes the restarter and boots
    // the agent with OUR options instead of theirs (see restart-lock.ts).
    if (d.isRestartInFlight(name)) {
      d.log('info', { agent: name }, 'Reconcile: managed restart in flight -- leaving the start to it')
      continue
    }
    if (d.isWithinRestartGrace(name)) continue
    if (!d.memGateAllowsStart(name)) continue // safe-mode / memory gate
    d.log('warn', { agent: name }, 'Desired agent not running -- auto-starting (reconcile)')
    started.push(name)
    try {
      const r = await d.start(name)
      d.afterStart(name)
      if (!r.ok && r.error !== 'Agent is already running') d.log('error', { agent: name, error: r.error }, 'Reconcile start failed')
    } catch (err) {
      d.log('error', { err, agent: name }, 'Reconcile start threw')
    }
    const gap = await d.gap(name)
    d.log('info', { agent: name, gapEnd: gap.end, waitedMs: gap.waitedMs }, 'Reconcile: next agent may start')
  }
  return { gate, started }
}
