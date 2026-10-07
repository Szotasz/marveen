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
