import { describe, it, expect } from 'vitest'
import {
  parseIdleContextTokensK,
  decideContextCompaction,
  type ContextCompactionState,
  type ContextCompactionThresholds,
} from '../pane-state.js'

const T: ContextCompactionThresholds = {
  compactK: 400,
  ceilingK: 480,
  confirmMs: 60_000,
  compactDedupMs: 300_000,
  alertDedupMs: 1_800_000,
}
const EMPTY: ContextCompactionState = { firstOverAt: null, lastCompactAt: null, lastAlertAt: null }

describe('parseIdleContextTokensK', () => {
  it('parses the idle /clear hint', () => {
    const pane = 'Churned for 4m 3s\n            new task? /clear to save 292.3k tokens\n❯'
    expect(parseIdleContextTokensK(pane)).toBeCloseTo(292.3)
  })
  it('returns null when the hint is absent (busy / small context)', () => {
    expect(parseIdleContextTokensK('❯ esc to interrupt')).toBeNull()
    expect(parseIdleContextTokensK(null)).toBeNull()
    expect(parseIdleContextTokensK('')).toBeNull()
  })
})

describe('decideContextCompaction', () => {
  it('does nothing below the compact threshold and resets state', () => {
    const d = decideContextCompaction(292.3, { firstOverAt: 5, lastCompactAt: 5, lastAlertAt: 5 }, 1000, T)
    expect(d.action).toBe('none')
    expect(d.next).toEqual(EMPTY)
  })

  it('null reading (busy tick) HOLDS the spell unchanged so the window survives busy gaps', () => {
    const prev: ContextCompactionState = { firstOverAt: 100, lastCompactAt: 200, lastAlertAt: 300 }
    const d = decideContextCompaction(null, prev, 1000, T)
    expect(d.action).toBe('none')
    expect(d.next).toEqual(prev)
  })

  it('accumulates the confirm window across intermittent busy (null) ticks, then compacts', () => {
    const t0 = 1_000_000
    // idle over-threshold sighting anchors the spell
    const s1 = decideContextCompaction(420, EMPTY, t0, T)
    expect(s1.action).toBe('none')
    expect(s1.next.firstOverAt).toBe(t0)
    // agent goes busy (null) mid-window -> spell must be held, not reset
    const s2 = decideContextCompaction(null, s1.next, t0 + 30_000, T)
    expect(s2.next.firstOverAt).toBe(t0)
    // idle again past the confirm window -> compact
    const s3 = decideContextCompaction(420, s2.next, t0 + 61_000, T)
    expect(s3.action).toBe('compact')
    expect(s3.next.lastCompactAt).toBe(t0 + 61_000)
  })

  it('records but does not compact until the confirm window passes', () => {
    const t0 = 1_000_000
    const first = decideContextCompaction(420, EMPTY, t0, T)
    expect(first.action).toBe('none')
    const soon = decideContextCompaction(420, first.next, t0 + 30_000, T)
    expect(soon.action).toBe('none')
    const later = decideContextCompaction(420, first.next, t0 + 61_000, T)
    expect(later.action).toBe('compact')
  })

  it('COMPACTS (not alerts) on first encounter with an already-huge context', () => {
    const t0 = 5_000_000
    // huge (>= ceiling) but never compacted this spell: rescue via /compact first
    const first = decideContextCompaction(941, EMPTY, t0, T)
    expect(first.action).toBe('none') // confirm window
    const act = decideContextCompaction(941, first.next, t0 + 61_000, T)
    expect(act.action).toBe('compact')
    expect(act.next.lastCompactAt).toBe(t0 + 61_000)
  })

  it('dedups /compact within the compaction window, re-fires after', () => {
    const t0 = 2_000_000
    const prev: ContextCompactionState = { firstOverAt: t0 - 100_000, lastCompactAt: t0, lastAlertAt: null }
    const blocked = decideContextCompaction(420, prev, t0 + 100_000, T)
    expect(blocked.action).toBe('none')
    const refire = decideContextCompaction(420, prev, t0 + 300_001, T)
    expect(refire.action).toBe('compact')
  })

  it('escalates to ALERT only after a prior /compact failed to bring it below the ceiling', () => {
    const t0 = 3_000_000
    // already compacted this spell, dedup window elapsed, still >= ceiling -> alert
    const prev: ContextCompactionState = { firstOverAt: t0 - 400_000, lastCompactAt: t0 - 300_001, lastAlertAt: null }
    const alert = decideContextCompaction(490, prev, t0, T)
    expect(alert.action).toBe('alert')
    expect(alert.next.lastAlertAt).toBe(t0)
    // deduped within alert window
    const blocked = decideContextCompaction(490, alert.next, t0 + 60_000, T)
    expect(blocked.action).toBe('none')
    // re-alert after the alert dedup window (still no fresh compact possible)
    const reAlert = decideContextCompaction(490, alert.next, t0 + 1_800_001, T)
    expect(reAlert.action).toBe('alert')
  })

  it('treats future-dated timestamps (clock skew) as elapsed', () => {
    const now = 1_000
    const prev: ContextCompactionState = { firstOverAt: 999_999, lastCompactAt: 999_999, lastAlertAt: null }
    const d = decideContextCompaction(420, prev, now, T)
    expect(d.action).toBe('none')
    expect(d.next.firstOverAt).toBe(now)
  })
})
