// Reads the quota snapshot scripts/usage-collect.py writes to
// store/usage-latest.json and hands it to the pure gate in quota-gate.ts.
//
// Everything here degrades to null: a missing file, a half-written file, a
// shape we do not recognise. Null means "we do not know", and the gate treats
// not-knowing as permission to run (see quota-gate.ts, FAIL OPEN).

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { STORE_DIR } from './config.js'
import { QUOTA_GATE, type QuotaSnapshot } from './quota-gate.js'
import { readClaudePlansState, type ClaudePlansState } from './web/claude-plans-state.js'

export const USAGE_SNAPSHOT_PATH = join(STORE_DIR, 'usage-latest.json')

/**
 * Map the collector's on-disk JSON onto the gate's input shape.
 * Exported separately from the file read so the mapping is unit-testable.
 */
export function parseQuotaSnapshot(raw: unknown): QuotaSnapshot | null {
  if (!raw || typeof raw !== 'object') return null
  const root = raw as Record<string, unknown>
  const claude = root.claude
  if (!claude || typeof claude !== 'object') return null
  const c = claude as Record<string, unknown>

  // generated_at is an ISO-8601 string on disk; the gate wants epoch ms.
  let generatedAtMs: number | null = null
  if (typeof root.generated_at === 'string') {
    const parsed = Date.parse(root.generated_at)
    if (!Number.isNaN(parsed)) generatedAtMs = parsed
  }

  const windows = c.windows && typeof c.windows === 'object'
    ? (c.windows as QuotaSnapshot['windows'])
    : null

  return {
    source: typeof c.source === 'string' ? c.source : null,
    generatedAtMs,
    windows,
  }
}

/** The snapshot source of a reading taken from store/claude-plans-state.json (trusted in quota-gate.ts). */
export const PLANS_STATE_SOURCE = 'plans_state'

/**
 * With Claude plan rotation on, usage-collect.py's `claude` entry is an estimate without windows (the active
 * plan is not the main login's), and the gate went blind and failed open. The rotation side-car measures every
 * plan in use (src/claude-plan-usage-probe.ts, the rotation heartbeat): this builds the gate's snapshot from it.
 * Every plan in use counts, the fleet's (`fleet.fleetPlanId`) and each agent's (`activePlanByAgent`), so the
 * gate sees the most loaded one. Null, which keeps today's behaviour, when no plan is in use, a plan in use has
 * no readable observation, its source is not a real measurement, or the OLDEST observation is older than the
 * gate's staleness bound.
 */
export function snapshotFromPlansState(state: ClaudePlansState, nowMs: number): QuotaSnapshot | null {
  const used = new Set<string>(Object.values(state.activePlanByAgent))
  if (state.fleet?.fleetPlanId) used.add(state.fleet.fleetPlanId)
  if (used.size === 0) return null
  const trusted = [...(QUOTA_GATE.trustedSources as readonly string[]), 'probe']
  const windows: NonNullable<QuotaSnapshot['windows']> = {}
  let oldestMs = Infinity
  for (const id of used) {
    const plan = state.plans[id]
    if (!plan || typeof plan.observedAt !== 'number' || !Number.isFinite(plan.observedAt) || plan.observedAt <= 0) return null
    if (!trusted.includes(String(plan.source ?? '').toLowerCase())) return null   // plans-state-trusted-source
    const entries = Object.entries(plan.windows ?? {})
    if (entries.length === 0) return null
    for (const [key, w] of entries) {
      if (typeof w?.usedPercent !== 'number' || typeof w?.resetsAt !== 'number') return null
      windows[`${id}:${key}`] = { used_percent: w.usedPercent, resets_at: w.resetsAt }
    }
    oldestMs = Math.min(oldestMs, plan.observedAt)   // plans-state-oldest
  }
  if (nowMs - oldestMs > QUOTA_GATE.staleAfterMs) return null   // plans-state-fresh
  return { source: PLANS_STATE_SOURCE, generatedAtMs: oldestMs, windows }
}

/**
 * The gate's snapshot. A trusted usage-latest.json reading is used as it is; when it is not trusted (rotation:
 * an estimate) the rotation side-car's fresh per-plan readings stand in, and when those are not usable either,
 * the usage-latest.json snapshot goes to the gate unchanged (today's behaviour: FAIL OPEN, the blind notice).
 */
export function readQuotaSnapshot(
  path: string = USAGE_SNAPSHOT_PATH,
  nowMs: number = Date.now(),
  plansState: () => ClaudePlansState = readClaudePlansState,
): QuotaSnapshot | null {
  let snapshot: QuotaSnapshot | null = null
  try {
    snapshot = parseQuotaSnapshot(JSON.parse(readFileSync(path, 'utf-8')))
  } catch {
    return null
  }
  if (snapshot && (QUOTA_GATE.trustedSources as readonly string[]).includes((snapshot.source ?? '').toLowerCase())) return snapshot
  let fromPlans: QuotaSnapshot | null = null
  try {
    fromPlans = snapshotFromPlansState(plansState(), nowMs)
  } catch {
    fromPlans = null
  }
  return fromPlans ?? snapshot   // plans-state-fallback
}
