// Pure decision logic for quota-aware work dispatch.
//
// The Claude subscription quota is ONE pool for the whole fleet, not a
// per-agent budget: every heartbeat, every scheduled task and every agent turn
// draws from the same 5-hour and 7-day windows. Nothing used to look at that
// pool before starting work, so the fleet's cheapest, most frequent consumers
// (background heartbeats, one per agent every 30 minutes) could burn the last
// percent of a window minutes before the owner needed it for real work.
//
// This module answers one question -- "should this piece of work start right
// now?" -- from the snapshot scripts/usage-collect.py writes to
// store/usage-latest.json. Kept pure so the thresholds are unit-tested without
// a network call or a filesystem read; the caller supplies the snapshot.
//
// Two design rules, both deliberate:
//
//   FAIL OPEN. A missing, stale, unparseable or estimate-only snapshot means we
//   do not know the quota state, and "unknown" must never silence the fleet.
//   Every uncertain path returns 'run'. The gate can only ever stop work when
//   it has fresh, authoritative evidence of real pressure.
//
//   ONLY BACKGROUND WORK IS DEFERRED. Anything the owner sees or waits for runs
//   regardless of pressure -- a quota window that is nearly full is not a
//   reason to go silent on the person paying for it. Skipping one background
//   heartbeat costs nothing; skipping the owner's answer costs everything.

/** One quota window as scripts/usage-collect.py records it. */
export interface QuotaWindow {
  /** 0..100, or null when the source could not report a percentage. */
  used_percent?: number | null
  /** Unix epoch SECONDS (float ok), or null. */
  resets_at?: number | null
}

/** The `claude` section of store/usage-latest.json. */
export interface QuotaSnapshot {
  /** 'authoritative' | 'authoritative_cached' | 'estimate' | ... */
  source?: string | null
  generatedAtMs?: number | null
  windows?: Record<string, QuotaWindow> | null
}

// What the work costs us, NOT how important it feels.
//   free         -- consumes no model tokens at all (type='command' shell tasks)
//   owner-facing -- the owner sees the result or is waiting for it
//   background   -- nobody is waiting; skipping one occurrence is invisible
export type QuotaWorkClass = 'free' | 'owner-facing' | 'background'

export type QuotaAction = 'run' | 'defer'

export interface QuotaDecision {
  action: QuotaAction
  /** Short machine-ish reason, safe to log. */
  reason: string
  /** Highest used_percent across the windows, or null when unknown. */
  pressure: number | null
}

export const QUOTA_GATE = {
  /** A snapshot older than this tells us nothing about now. */
  staleAfterMs: 20 * 60_000,
  /** Background work stops at or above this utilization. */
  deferAtPercent: 85,
  /** ... and also stops above this, if the window is about to reset anyway. */
  nearResetPercent: 70,
  /** "About to reset": waiting this long is cheaper than spending the tail. */
  nearResetMs: 30 * 60_000,
  /** Sources whose numbers are real. Anything else is a guess -- fail open. */
  trustedSources: ['authoritative', 'authoritative_cached'],
} as const

/** Highest utilization across all windows, or null when none reports one. */
export function quotaPressure(snapshot: QuotaSnapshot | null | undefined): number | null {
  const windows = snapshot?.windows
  if (!windows) return null
  let max: number | null = null
  for (const w of Object.values(windows)) {
    const used = w?.used_percent
    if (typeof used !== 'number' || Number.isNaN(used)) continue
    if (max === null || used > max) max = used
  }
  return max
}

/**
 * The window we would be waiting for: the one under pressure that resets
 * soonest. Returns null when nothing is close to a reset.
 */
function windowResettingSoon(
  snapshot: QuotaSnapshot,
  nowMs: number,
): { key: string; usedPercent: number; msUntilReset: number } | null {
  const windows = snapshot.windows ?? {}
  let best: { key: string; usedPercent: number; msUntilReset: number } | null = null
  for (const [key, w] of Object.entries(windows)) {
    const used = w?.used_percent
    const resets = w?.resets_at
    if (typeof used !== 'number' || typeof resets !== 'number') continue
    const msUntilReset = resets * 1000 - nowMs
    if (msUntilReset <= 0 || msUntilReset > QUOTA_GATE.nearResetMs) continue
    if (used < QUOTA_GATE.nearResetPercent) continue
    if (!best || msUntilReset < best.msUntilReset) best = { key, usedPercent: used, msUntilReset }
  }
  return best
}

export function decideQuotaAction(input: {
  snapshot: QuotaSnapshot | null | undefined
  nowMs: number
  workClass: QuotaWorkClass
}): QuotaDecision {
  const { snapshot, nowMs, workClass } = input

  // Shell commands cost no tokens -- the gate has no business touching them.
  if (workClass === 'free') return { action: 'run', reason: 'no-model-cost', pressure: null }

  if (!snapshot) return { action: 'run', reason: 'no-snapshot', pressure: null }

  const source = (snapshot.source ?? '').toLowerCase()
  if (!(QUOTA_GATE.trustedSources as readonly string[]).includes(source)) {
    return { action: 'run', reason: `untrusted-source:${source || 'none'}`, pressure: null }
  }

  const generatedAtMs = snapshot.generatedAtMs
  if (typeof generatedAtMs !== 'number' || Number.isNaN(generatedAtMs)) {
    return { action: 'run', reason: 'no-snapshot-timestamp', pressure: null }
  }
  const ageMs = nowMs - generatedAtMs
  if (ageMs > QUOTA_GATE.staleAfterMs) {
    return { action: 'run', reason: `stale-snapshot:${Math.round(ageMs / 60_000)}m`, pressure: null }
  }

  const pressure = quotaPressure(snapshot)
  if (pressure === null) return { action: 'run', reason: 'no-usable-window', pressure: null }

  // The owner is waiting, or will read the result. Pressure is not a reason to
  // go quiet on them -- report it in the reason and run.
  if (workClass === 'owner-facing') {
    return { action: 'run', reason: `owner-facing@${pressure}%`, pressure }
  }

  if (pressure >= QUOTA_GATE.deferAtPercent) {
    return { action: 'defer', reason: `pressure:${pressure}%`, pressure }
  }

  const soon = windowResettingSoon(snapshot, nowMs)
  if (soon) {
    return {
      action: 'defer',
      reason: `near-reset:${soon.key}@${soon.usedPercent}%/${Math.round(soon.msUntilReset / 60_000)}m`,
      pressure,
    }
  }

  return { action: 'run', reason: `ok@${pressure}%`, pressure }
}
