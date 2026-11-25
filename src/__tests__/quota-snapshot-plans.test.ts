// With Claude plan rotation on, usage-collect.py's `claude` entry is an estimate without windows, and the quota
// gate went blind ("Quota gate is blind", FAIL OPEN). The rotation side-car (store/claude-plans-state.json)
// measures every plan in use; src/quota-snapshot.ts lets those readings stand in, and only when they are real and
// fresh. Everything else keeps today's behaviour.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readQuotaSnapshot, snapshotFromPlansState, PLANS_STATE_SOURCE } from '../quota-snapshot.js'
import { decideQuotaAction, quotaBlindness } from '../quota-gate.js'
import type { ClaudePlansState } from '../web/claude-plans-state.js'

const NOW = Date.parse('2026-11-25T15:30:00Z')
const MIN = 60_000
const resets = NOW / 1000 + 3 * 3600

function plan(observedAgoMin: number, fiveHour: number, source = 'probe') {
  return { observedAt: NOW - observedAgoMin * MIN, source, windows: { five_hour: { usedPercent: fiveHour, resetsAt: resets }, seven_day: { usedPercent: 40, resetsAt: resets + 86400 } } }
}

function state(extra: Partial<ClaudePlansState> = {}): ClaudePlansState {
  return {
    activePlanByAgent: { 'etelka-ai': 'a' },
    plans: { a: plan(5, 30), b: plan(3, 91), c: plan(1, 10) },
    fleet: { fleetPlanId: 'b', rotatedAt: NOW - 60 * MIN, outcome: 'rotated', restarted: [], failed: [], notRunning: [], line: '' },
    ...extra,
  }
}

describe('snapshotFromPlansState', () => {
  it('every plan in use, the fleet\'s and each agent\'s, keyed by plan; the oldest observation dates it', () => {
    const snap = snapshotFromPlansState(state(), NOW)!
    expect(snap.source).toBe(PLANS_STATE_SOURCE)
    expect(Object.keys(snap.windows!).sort()).toEqual(['a:five_hour', 'a:seven_day', 'b:five_hour', 'b:seven_day'])   // c is not in use
    expect(snap.windows!['b:five_hour']).toEqual({ used_percent: 91, resets_at: resets })
    expect(snap.generatedAtMs).toBe(NOW - 5 * MIN)   // plans-state-oldest
    expect(quotaBlindness(snap, NOW)).toBeNull()
    // the fleet's plan at 91%: background work waits, the owner's does not
    expect(decideQuotaAction({ snapshot: snap, nowMs: NOW, workClass: 'background' })).toMatchObject({ action: 'defer', pressure: 91 })
    expect(decideQuotaAction({ snapshot: snap, nowMs: NOW, workClass: 'owner-facing' }).action).toBe('run')
  })

  it('null (today\'s behaviour) when it cannot see the whole pool', () => {
    expect(snapshotFromPlansState({ activePlanByAgent: {}, plans: { a: plan(1, 50) } }, NOW)).toBeNull()   // nothing in use
    expect(snapshotFromPlansState(state({ activePlanByAgent: { 'etelka-ai': 'missing' } }), NOW)).toBeNull()
    expect(snapshotFromPlansState(state({ plans: { a: plan(5, 30), b: { ...plan(3, 91), windows: {} } } }), NOW)).toBeNull()
    expect(snapshotFromPlansState(state({ plans: { a: plan(5, 30), b: { ...plan(3, 91), observedAt: 0 } } }), NOW)).toBeNull()   // a failed first probe
    expect(snapshotFromPlansState(state({ plans: { a: plan(5, 30), b: plan(3, 91, 'estimate') } }), NOW)).toBeNull()   // plans-state-trusted-source
    expect(snapshotFromPlansState(state({ plans: { a: plan(25, 30), b: plan(3, 91) } }), NOW)).toBeNull()   // plans-state-fresh: one plan 25 min old
  })
})

describe('readQuotaSnapshot', () => {
  let dir = ''
  let file = ''
  const usage = (claude: object) => writeFileSync(file, JSON.stringify({ generated_at: new Date(NOW - MIN).toISOString(), claude }))
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'qsnap-')); file = join(dir, 'usage-latest.json') })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('a trusted usage-latest.json reading is used as it is; the side-car is not read', () => {
    usage({ source: 'authoritative', windows: { five_hour: { used_percent: 12, resets_at: resets } } })
    const snap = readQuotaSnapshot(file, NOW, () => { throw new Error('must not be read') })!
    expect(snap.source).toBe('authoritative')
  })

  it('rotation: an estimate gives way to the fresh per-plan readings, else it goes through unchanged', () => {
    usage({ source: 'estimate' })
    expect(readQuotaSnapshot(file, NOW, () => state())!.source).toBe(PLANS_STATE_SOURCE)   // plans-state-fallback
    const blind = readQuotaSnapshot(file, NOW, () => state({ plans: {} }))!
    expect(blind.source).toBe('estimate')
    expect(quotaBlindness(blind, NOW)).toBe('untrusted-source')
    expect(readQuotaSnapshot(file, NOW, () => { throw new Error('unreadable') })!.source).toBe('estimate')
    expect(readQuotaSnapshot(join(dir, 'none.json'), NOW, () => state())).toBeNull()   // no collector: unchanged, no snapshot
  })
})
