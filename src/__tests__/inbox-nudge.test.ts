import { describe, it, expect } from 'vitest'
import {
  decideNudgePreflight,
  recordNudge,
  nudgeText,
  INITIAL_NUDGE_STATE,
  NUDGE_MAX_CHARS,
  MIN_PENDING_AGE_MS,
  NUDGE_DEBOUNCE_MS,
  STALE_NUDGE_COOLDOWN_MS,
  MAX_STALE_NUDGES,
  MAX_NUDGES_PER_HOUR,
  type NudgeState,
} from '../web/inbox-nudge-watcher.js'

const NOW = 1_750_000_000_000

function st(overrides: Partial<NudgeState> = {}): NudgeState {
  return { ...INITIAL_NUDGE_STATE, ...overrides }
}

describe('nudgeText -- single visual row invariant', () => {
  it('stays within one 80-col input-box row in BOTH languages', () => {
    // The headless channels pane is tmux-default 80 columns (channels.sh
    // new-session has no -x/-y). MAIN's only parked-plain-text recovery is a
    // bare Enter, which submits SINGLE-row text but permanently holds
    // multi-row text (pane-state decideStuckInputAction default branch) --
    // a longer nudge would turn a parked nudge into an unrecoverable wedge.
    expect(nudgeText('hu').length).toBeLessThanOrEqual(NUDGE_MAX_CHARS)
    expect(nudgeText('en').length).toBeLessThanOrEqual(NUDGE_MAX_CHARS)
  })

  it('is static, conditional, and accent-free for tmux send-keys', () => {
    for (const lang of ['hu', 'en'] as const) {
      expect(nudgeText(lang)).not.toMatch(/[{}$]/) // no interpolation slots
      // tmux-injected text follows the accent-less channel-monitor precedent
      expect(nudgeText(lang)).toMatch(/^[\x20-\x7E[\]]+$/)
    }
    // Conditional wording: must not assert that blocks exist above (a
    // competing prompt may have already drained everything).
    expect(nudgeText('hu')).toContain('Ha ')
    expect(nudgeText('en')).toContain('If ')
  })
})

describe('decideNudgePreflight', () => {
  it('empty inbox ends the spell but keeps the global debounce floor', () => {
    const dirty = st({
      lastNudgeAt: NOW - 5_000,
      lastNudgeOldestId: 42,
      staleNudges: 2,
      staleAlerted: true,
      lastBusyLogAt: NOW - 1000,
      absenceLogged: true,
      recentNudges: [NOW - 5_000],
    })
    const r = decideNudgePreflight({ now: NOW, oldestId: null, oldestAgeMs: 0 }, dirty)
    expect(r.proceed).toBe(false)
    expect(r.state.lastNudgeOldestId).toBeNull()
    expect(r.state.staleNudges).toBe(0)
    expect(r.state.staleAlerted).toBe(false)
    expect(r.state.absenceLogged).toBe(false)
    // lastNudgeAt survives: a message stream must not re-nudge faster than
    // the debounce just because the drain emptied the inbox in between.
    expect(r.state.lastNudgeAt).toBe(NOW - 5_000)
    expect(r.state.recentNudges).toEqual([NOW - 5_000])
  })

  it('leaves a too-young message alone', () => {
    const r = decideNudgePreflight({ now: NOW, oldestId: 1, oldestAgeMs: MIN_PENDING_AGE_MS - 1 }, st())
    expect(r.proceed).toBe(false)
  })

  it('enforces the wall-clock debounce across spells', () => {
    const r = decideNudgePreflight(
      { now: NOW, oldestId: 7, oldestAgeMs: 60_000 },
      st({ lastNudgeAt: NOW - NUDGE_DEBOUNCE_MS + 1 }),
    )
    expect(r.proceed).toBe(false)
    const r2 = decideNudgePreflight(
      { now: NOW, oldestId: 7, oldestAgeMs: 60_000 },
      st({ lastNudgeAt: NOW - NUDGE_DEBOUNCE_MS - 1 }),
    )
    expect(r2.proceed).toBe(true)
  })

  it('stale spell: same oldest id after a nudge requires the long cooldown', () => {
    const afterOne = recordNudge(st(), NOW - NUDGE_DEBOUNCE_MS - 1000, 7)
    // Debounce passed but stale cooldown not yet:
    const r = decideNudgePreflight({ now: NOW, oldestId: 7, oldestAgeMs: 300_000 }, afterOne)
    expect(r.proceed).toBe(false)
    // After the stale cooldown it may retry:
    const later = NOW + STALE_NUDGE_COOLDOWN_MS
    const r2 = decideNudgePreflight({ now: later, oldestId: 7, oldestAgeMs: 600_000 }, afterOne)
    expect(r2.proceed).toBe(true)
  })

  it('stops after MAX_STALE_NUDGES for the same oldest id and alerts exactly once', () => {
    let s = st()
    let t = NOW
    for (let i = 0; i < MAX_STALE_NUDGES; i++) {
      t += STALE_NUDGE_COOLDOWN_MS + 1000
      s = recordNudge(s, t, 7)
    }
    expect(s.staleNudges).toBe(MAX_STALE_NUDGES)
    const r = decideNudgePreflight({ now: t + STALE_NUDGE_COOLDOWN_MS + 1, oldestId: 7, oldestAgeMs: 10 ** 7 }, s)
    expect(r.proceed).toBe(false)
    expect('staleAlert' in r && r.staleAlert).toBe(true)
    // Second tick: no repeat alert.
    const r2 = decideNudgePreflight({ now: t + STALE_NUDGE_COOLDOWN_MS + 30_000, oldestId: 7, oldestAgeMs: 10 ** 7 }, r.state)
    expect(r2.proceed).toBe(false)
    expect('staleAlert' in r2 && r2.staleAlert).toBeFalsy()
  })

  it('a NEW oldest id ends the stale spell and resumes nudging', () => {
    let s = st()
    let t = NOW
    for (let i = 0; i < MAX_STALE_NUDGES; i++) {
      t += STALE_NUDGE_COOLDOWN_MS + 1000
      s = recordNudge(s, t, 7)
    }
    const r = decideNudgePreflight({ now: t + NUDGE_DEBOUNCE_MS + 1, oldestId: 8, oldestAgeMs: 60_000 }, s)
    expect(r.proceed).toBe(true)
    const after = recordNudge(r.state, t + NUDGE_DEBOUNCE_MS + 1, 8)
    expect(after.staleNudges).toBe(1)
    expect(after.staleAlerted).toBe(false)
  })

  it('enforces the rolling hourly budget and logs the exhaustion once per spell', () => {
    const recent = Array.from({ length: MAX_NUDGES_PER_HOUR }, (_, i) => NOW - (i + 1) * 60_000)
    const r = decideNudgePreflight(
      { now: NOW, oldestId: 9, oldestAgeMs: 60_000 },
      st({ recentNudges: recent, lastNudgeAt: NOW - NUDGE_DEBOUNCE_MS - 1 }),
    )
    expect(r.proceed).toBe(false)
    expect('budgetLog' in r && r.budgetLog).toBe(true)
    const r2 = decideNudgePreflight({ now: NOW + 20_000, oldestId: 9, oldestAgeMs: 80_000 }, r.state)
    expect(r2.proceed).toBe(false)
    expect('budgetLog' in r2 && r2.budgetLog).toBeFalsy()
    // Window slides: an hour later the budget is free again.
    const r3 = decideNudgePreflight({ now: NOW + 3_600_000, oldestId: 9, oldestAgeMs: 3_700_000 }, r2.state)
    expect(r3.proceed).toBe(true)
    expect(r3.state.budgetLogged).toBe(false)
  })
})

describe('recordNudge', () => {
  it('advances the debounce, counts stale repeats, prunes the budget window', () => {
    const first = recordNudge(st({ recentNudges: [NOW - 3_700_000] }), NOW, 5)
    expect(first.lastNudgeAt).toBe(NOW)
    expect(first.lastNudgeOldestId).toBe(5)
    expect(first.staleNudges).toBe(1)
    expect(first.recentNudges).toEqual([NOW]) // hour-old entry pruned

    const second = recordNudge(first, NOW + 400_000, 5)
    expect(second.staleNudges).toBe(2)

    const fresh = recordNudge(second, NOW + 800_000, 6)
    expect(fresh.staleNudges).toBe(1)
    expect(fresh.recentNudges).toHaveLength(3)
  })
})
