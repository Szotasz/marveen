import { describe, it, expect } from 'vitest'
import {
  decideQuotaAction,
  quotaPressure,
  QUOTA_GATE,
  type QuotaSnapshot,
} from '../quota-gate.js'

const NOW = Date.UTC(2026, 7, 17, 20, 0, 0) // 2026-08-17T20:00:00Z

/** Build a snapshot; percentages in, epoch-seconds resets derived from NOW. */
function snap(
  windows: Record<string, { used: number; resetsInMin?: number }>,
  opts: { source?: string; ageMs?: number } = {},
): QuotaSnapshot & { windows: Record<string, { used_percent: number | null; resets_at: number | null }> } {
  return {
    source: opts.source ?? 'authoritative',
    generatedAtMs: NOW - (opts.ageMs ?? 60_000),
    windows: Object.fromEntries(
      Object.entries(windows).map(([k, v]) => [
        k,
        {
          used_percent: v.used,
          resets_at: v.resetsInMin == null ? null : (NOW + v.resetsInMin * 60_000) / 1000,
        },
      ]),
    ),
  }
}

const background = (snapshot: unknown) =>
  decideQuotaAction({ snapshot: snapshot as never, nowMs: NOW, workClass: 'background' })

describe('quotaPressure', () => {
  it('takes the highest utilization across windows', () => {
    expect(quotaPressure(snap({ five_hour: { used: 10 }, seven_day: { used: 62 } }))).toBe(62)
  })

  it('ignores windows without a numeric percentage', () => {
    const s = snap({ five_hour: { used: 10 } })
    s.windows.seven_day = { used_percent: null, resets_at: null }
    expect(quotaPressure(s)).toBe(10)
  })

  it('returns null when nothing reports a percentage', () => {
    expect(quotaPressure({ source: 'authoritative', windows: {} })).toBeNull()
    expect(quotaPressure(null)).toBeNull()
  })
})

describe('decideQuotaAction -- fail open', () => {
  it('runs shell-only work without even looking at the snapshot', () => {
    const d = decideQuotaAction({
      snapshot: snap({ five_hour: { used: 99 } }),
      nowMs: NOW,
      workClass: 'free',
    })
    expect(d.action).toBe('run')
    expect(d.reason).toBe('no-model-cost')
  })

  it('runs when there is no snapshot at all', () => {
    expect(background(null).action).toBe('run')
    expect(background(undefined).reason).toBe('no-snapshot')
  })

  it('runs on an estimate-only snapshot, however alarming its numbers look', () => {
    const d = background(snap({ five_hour: { used: 99 } }, { source: 'estimate' }))
    expect(d.action).toBe('run')
    expect(d.reason).toContain('untrusted-source')
  })

  it('accepts a cached authoritative snapshot as evidence', () => {
    const d = background(snap({ five_hour: { used: 95 } }, { source: 'authoritative_cached' }))
    expect(d.action).toBe('defer')
  })

  it('runs when the snapshot is too old to describe now', () => {
    const d = background(
      snap({ five_hour: { used: 99 } }, { ageMs: QUOTA_GATE.staleAfterMs + 60_000 }),
    )
    expect(d.action).toBe('run')
    expect(d.reason).toContain('stale-snapshot')
  })

  it('runs when the snapshot has no usable window', () => {
    const d = background({ source: 'authoritative', generatedAtMs: NOW - 1000, windows: {} })
    expect(d.action).toBe('run')
    expect(d.reason).toBe('no-usable-window')
  })
})

describe('decideQuotaAction -- the brake', () => {
  it('defers background work under high pressure', () => {
    const d = background(snap({ five_hour: { used: 90, resetsInMin: 180 } }))
    expect(d.action).toBe('defer')
    expect(d.reason).toBe('pressure:90%')
    expect(d.pressure).toBe(90)
  })

  it('runs background work when there is plenty left', () => {
    const d = background(snap({ five_hour: { used: 10, resetsInMin: 130 }, seven_day: { used: 13 } }))
    expect(d.action).toBe('run')
    expect(d.reason).toBe('ok@13%')
  })

  it("waits out a window that is over the line and resets shortly (the owner's own example)", () => {
    // 90% and half an hour to go: spending the tail buys nothing.
    const d = background(snap({ five_hour: { used: 75, resetsInMin: 25 } }))
    expect(d.action).toBe('defer')
    expect(d.reason).toContain('near-reset:five_hour')
  })

  it('does not wait out a reset that is still far away', () => {
    const d = background(snap({ five_hour: { used: 75, resetsInMin: 120 } }))
    expect(d.action).toBe('run')
  })

  it('does not wait out a nearly-empty window that happens to reset soon', () => {
    const d = background(snap({ five_hour: { used: 12, resetsInMin: 5 } }))
    expect(d.action).toBe('run')
  })

  it('ignores a reset timestamp that has already passed', () => {
    const d = background(snap({ five_hour: { used: 75, resetsInMin: -10 } }))
    expect(d.action).toBe('run')
  })
})

describe('decideQuotaAction -- the owner is never silenced', () => {
  it('runs owner-facing work at any pressure', () => {
    for (const used of [50, 85, 99, 100]) {
      const d = decideQuotaAction({
        snapshot: snap({ five_hour: { used, resetsInMin: 5 } }),
        nowMs: NOW,
        workClass: 'owner-facing',
      })
      expect(d.action).toBe('run')
      expect(d.reason).toBe(`owner-facing@${used}%`)
    }
  })

  it('still reports the pressure it saw, so the caller can log it', () => {
    const d = decideQuotaAction({
      snapshot: snap({ five_hour: { used: 97 } }),
      nowMs: NOW,
      workClass: 'owner-facing',
    })
    expect(d.pressure).toBe(97)
  })
})
