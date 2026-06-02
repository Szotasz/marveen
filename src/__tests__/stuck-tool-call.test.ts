import { describe, expect, it } from 'vitest'
import {
  stuckToolCallSignature,
  decideStuckToolCallRecovery,
  type StuckToolCallState,
  type StuckToolCallThresholds,
} from '../pane-state.js'

// Thresholds matching the production defaults in stuck-tool-call-watcher.ts.
// Repeated here so the tests pin the contract independently of the wrapper
// module (Marveen 2026-06-02 review: every threshold change should require
// an intentional test edit, not silently relax).
const THRESHOLDS: StuckToolCallThresholds = {
  freezeSeconds: 180,
  stagnantPolls: 2,
}

const NO_STATE: StuckToolCallState = {
  tag: null,
  spellStartSeconds: null,
  firstSeenAt: null,
  lastSeconds: null,
  stagnantPolls: 0,
  stagnantSince: null,
  attempts: 0,
}

describe('stuckToolCallSignature', () => {
  it('parses "Worked for 31s" -- the 2026-06-02 incident shape', () => {
    const pane = [
      '  hírlevél-welcome-ot...',
      '',
      '✻ Worked for 31s',
      '',
      '❯ Maradjon, jó így.',
    ].join('\n')
    expect(stuckToolCallSignature(pane)).toEqual({ tag: 'worked', seconds: 31 })
  })

  it('parses all known verbs Claude Code has shipped', () => {
    expect(stuckToolCallSignature('Brewed for 42s')).toEqual({ tag: 'brewed', seconds: 42 })
    expect(stuckToolCallSignature('Baked for 7s')).toEqual({ tag: 'baked', seconds: 7 })
    expect(stuckToolCallSignature('Cooking for 12s')).toEqual({ tag: 'cooking', seconds: 12 })
    expect(stuckToolCallSignature('Simmered for 99s')).toEqual({ tag: 'simmered', seconds: 99 })
    expect(stuckToolCallSignature('Sauteed for 21s')).toEqual({ tag: 'sauteed', seconds: 21 })
  })

  it('handles the ✻ glyph prefix', () => {
    expect(stuckToolCallSignature('✻ Worked for 31s')).toEqual({ tag: 'worked', seconds: 31 })
  })

  it('returns null when no progress line is present', () => {
    expect(stuckToolCallSignature('❯ idle prompt\nbypass permissions on')).toBeNull()
    expect(stuckToolCallSignature('')).toBeNull()
  })
})

describe('decideStuckToolCallRecovery', () => {
  it('starts a fresh spell on first observation, no recovery', () => {
    const r = decideStuckToolCallRecovery({ tag: 'worked', seconds: 31 }, NO_STATE, 1_000_000, THRESHOLDS)
    expect(r.recover).toBe(false)
    expect(r.next.tag).toBe('worked')
    expect(r.next.spellStartSeconds).toBe(31)
    expect(r.next.stagnantPolls).toBe(0)
    expect(r.next.stagnantSince).toBeNull()
  })

  it('null pane ends any spell', () => {
    const prev: StuckToolCallState = {
      tag: 'worked', spellStartSeconds: 30, firstSeenAt: 1, lastSeconds: 31,
      stagnantPolls: 2, stagnantSince: 1, attempts: 0,
    }
    const r = decideStuckToolCallRecovery(null, prev, 1_000_000, THRESHOLDS)
    expect(r.recover).toBe(false)
    expect(r.next).toEqual(NO_STATE)
  })

  it('tag change resets the spell (verb change = real progress)', () => {
    const prev: StuckToolCallState = {
      tag: 'brewed', spellStartSeconds: 30, firstSeenAt: 1, lastSeconds: 200,
      stagnantPolls: 2, stagnantSince: 1, attempts: 0,
    }
    const r = decideStuckToolCallRecovery({ tag: 'worked', seconds: 5 }, prev, 1_000_000, THRESHOLDS)
    expect(r.recover).toBe(false)
    expect(r.next.tag).toBe('worked')
    expect(r.next.spellStartSeconds).toBe(5)
    expect(r.next.stagnantPolls).toBe(0)
    expect(r.next.stagnantSince).toBeNull()
  })

  it('counter increment resets stagnantPolls AND stagnantSince (real tool-call progress)', () => {
    const prev: StuckToolCallState = {
      tag: 'worked', spellStartSeconds: 30, firstSeenAt: 1, lastSeconds: 195,
      stagnantPolls: 1, stagnantSince: 1_000_000, attempts: 0,
    }
    const r = decideStuckToolCallRecovery({ tag: 'worked', seconds: 220 }, prev, 1_030_000, THRESHOLDS)
    expect(r.recover).toBe(false)
    expect(r.next.lastSeconds).toBe(220)
    expect(r.next.stagnantPolls).toBe(0)
    expect(r.next.stagnantSince).toBeNull()
  })

  it('first stagnant poll stamps stagnantSince but does NOT recover (anti-fluke gate)', () => {
    const prev: StuckToolCallState = {
      tag: 'worked', spellStartSeconds: 30, firstSeenAt: 1_000_000, lastSeconds: 31,
      stagnantPolls: 0, stagnantSince: null, attempts: 0,
    }
    const r = decideStuckToolCallRecovery({ tag: 'worked', seconds: 31 }, prev, 1_030_000, THRESHOLDS)
    expect(r.recover).toBe(false)
    expect(r.next.stagnantPolls).toBe(1)
    expect(r.next.stagnantSince).toBe(1_030_000)
  })

  it('FROZEN at 31s recovers after 180s WALL-CLOCK stagnation (the 2026-06-02 incident)', () => {
    // PR #246 review fix: a wedged TUI keeps displaying the same seconds
    // forever. Recovery must be triggered by elapsed wall-clock time since
    // the counter stopped advancing, NOT by the displayed value reaching
    // a threshold. This was the precise vacuum in the original PR.
    const t0 = 1_000_000
    let state: StuckToolCallState = NO_STATE

    // Poll 1: first observation. spellStart.
    let r = decideStuckToolCallRecovery({ tag: 'worked', seconds: 31 }, state, t0, THRESHOLDS)
    expect(r.recover).toBe(false)
    state = r.next
    expect(state.stagnantSince).toBeNull() // not stagnant yet -- just spell-start

    // Poll 2 (30s later): same 31, first stagnant observation.
    r = decideStuckToolCallRecovery({ tag: 'worked', seconds: 31 }, state, t0 + 30_000, THRESHOLDS)
    expect(r.recover).toBe(false)
    state = r.next
    expect(state.stagnantPolls).toBe(1)
    expect(state.stagnantSince).toBe(t0 + 30_000)

    // Poll 3-6 (90s, 120s, 150s, 180s later): still 31, accumulating wall-clock.
    //   90 -> stagnantPolls=2 but stagnant for 60s -> still below freezeSeconds
    //  180 -> stagnant for 150s -> still below
    for (const dt of [60_000, 90_000, 120_000, 150_000]) {
      r = decideStuckToolCallRecovery({ tag: 'worked', seconds: 31 }, state, t0 + 30_000 + dt, THRESHOLDS)
      expect(r.recover).toBe(false)
      state = r.next
    }

    // Poll 7 (30s + 180s later from t0): stagnant for exactly 180_000 ms.
    // Wall-clock gate hits, stagnantPolls already > 2, RECOVER.
    r = decideStuckToolCallRecovery({ tag: 'worked', seconds: 31 }, state, t0 + 30_000 + 180_000, THRESHOLDS)
    expect(r.recover).toBe(true)
    expect(r.next.attempts).toBe(1)
  })

  it('one-shot: once recovered, hold even if still stagnant (next sweep reads fresh pane)', () => {
    const prev: StuckToolCallState = {
      tag: 'worked', spellStartSeconds: 30, firstSeenAt: 1_000_000, lastSeconds: 31,
      stagnantPolls: 8, stagnantSince: 1_000_000, attempts: 1,
    }
    const r = decideStuckToolCallRecovery({ tag: 'worked', seconds: 31 }, prev, 2_000_000, THRESHOLDS)
    expect(r.recover).toBe(false)
    expect(r.next.attempts).toBe(1)
  })

  it('clock skew backwards: restart spell rather than stall', () => {
    const prev: StuckToolCallState = {
      tag: 'worked', spellStartSeconds: 30, firstSeenAt: 2_000_000, lastSeconds: 31,
      stagnantPolls: 1, stagnantSince: 2_000_000, attempts: 0,
    }
    const r = decideStuckToolCallRecovery({ tag: 'worked', seconds: 31 }, prev, 1_500_000, THRESHOLDS)
    expect(r.recover).toBe(false)
    expect(r.next.firstSeenAt).toBe(1_500_000)
    expect(r.next.stagnantSince).toBeNull()
    expect(r.next.stagnantPolls).toBe(0)
  })

  it('LEGITIMATE long tool-call invariant: counter increments every poll, NEVER recovers', () => {
    // 5-minute slow Anthropic call. Counter goes 30 -> 60 -> 90 -> ... -> 300s.
    // Each poll sees an increment, so stagnantSince keeps resetting to null
    // and the wall-clock duration never accumulates. Crucial invariant
    // preserved by the PR #246 review fix.
    let state: StuckToolCallState = NO_STATE
    for (let n = 30; n <= 300; n += 30) {
      const r = decideStuckToolCallRecovery(
        { tag: 'worked', seconds: n },
        state,
        1_000_000 + n * 1000,
        THRESHOLDS,
      )
      expect(r.recover).toBe(false)
      state = r.next
    }
    expect(state.stagnantSince).toBeNull()
    expect(state.stagnantPolls).toBe(0)
  })

  it('rolled-back counter: treated as stagnant -- recovers after wall-clock window', () => {
    // 199 < 200 is an unhealthy regression. We treat it as stagnant. Two
    // polls of 199, plus enough wall-clock to clear freezeSeconds, recovers.
    const prev: StuckToolCallState = {
      tag: 'worked', spellStartSeconds: 30, firstSeenAt: 1_000_000, lastSeconds: 200,
      stagnantPolls: 0, stagnantSince: null, attempts: 0,
    }
    // First stagnant poll just stamps the wall-clock start.
    let r = decideStuckToolCallRecovery({ tag: 'worked', seconds: 199 }, prev, 1_030_000, THRESHOLDS)
    expect(r.recover).toBe(false)
    // ~3 min later, still 199 (or any value <= 200): wall-clock hit.
    r = decideStuckToolCallRecovery({ tag: 'worked', seconds: 199 }, r.next, 1_030_000 + 180_000, THRESHOLDS)
    expect(r.recover).toBe(true)
  })

  it('partial freeze, recovers, then re-freezes -- accumulates fresh wall-clock', () => {
    // Counter goes 50 -> 50 (stagnant for 60s) -> 51 (progress, reset) ->
    // freeze at 51 for the full 180s wall clock. The first freeze didn't
    // qualify (only 60s stagnant), the second does. stagnantSince must have
    // been reset by the progress observation.
    let state: StuckToolCallState = NO_STATE
    state = decideStuckToolCallRecovery({ tag: 'worked', seconds: 50 }, state, 1_000_000, THRESHOLDS).next
    state = decideStuckToolCallRecovery({ tag: 'worked', seconds: 50 }, state, 1_030_000, THRESHOLDS).next
    state = decideStuckToolCallRecovery({ tag: 'worked', seconds: 50 }, state, 1_060_000, THRESHOLDS).next
    // Progress: stagnantSince should reset.
    state = decideStuckToolCallRecovery({ tag: 'worked', seconds: 51 }, state, 1_090_000, THRESHOLDS).next
    expect(state.stagnantSince).toBeNull()
    // Now refreeze. First stagnant poll stamps, second poll qualifies polls,
    // wall-clock takes a while to accumulate -- recover only after 180s.
    let r = decideStuckToolCallRecovery({ tag: 'worked', seconds: 51 }, state, 1_120_000, THRESHOLDS)
    expect(r.recover).toBe(false)
    expect(r.next.stagnantSince).toBe(1_120_000)
    state = r.next
    r = decideStuckToolCallRecovery({ tag: 'worked', seconds: 51 }, state, 1_120_000 + 180_000, THRESHOLDS)
    expect(r.recover).toBe(true)
  })
})

describe('stuck-tool-call-watcher wiring contract', () => {
  // Pin the production thresholds and the boot-time wiring so a future
  // refactor cannot silently disable the watchdog or relax the gates that
  // protect against false-positive respawns during legitimate long work.
  const watcherSrc = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '../web/stuck-tool-call-watcher.ts'),
    'utf-8',
  ) as string
  const webSrc = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '../web.ts'),
    'utf-8',
  ) as string

  it('production freezeSeconds is >= 180', () => {
    const m = watcherSrc.match(/freezeSeconds:\s*(\d+)/)
    expect(m, 'freezeSeconds constant missing').not.toBeNull()
    expect(parseInt(m![1]!, 10)).toBeGreaterThanOrEqual(180)
  })

  it('production stagnantPolls is >= 2', () => {
    const m = watcherSrc.match(/stagnantPolls:\s*(\d+)/)
    expect(m, 'stagnantPolls constant missing').not.toBeNull()
    expect(parseInt(m![1]!, 10)).toBeGreaterThanOrEqual(2)
  })

  it('the watcher hard-restarts only via hardRestartMarveenChannels', () => {
    expect(watcherSrc).toMatch(/hardRestartMarveenChannels\(\)/)
    // Defensive: must NOT call respawn-pane directly or kill processes.
    expect(watcherSrc).not.toMatch(/respawn-pane/)
    expect(watcherSrc).not.toMatch(/kill\(/)
  })

  it('the watcher logs an audit line when it acts', () => {
    expect(watcherSrc).toMatch(/stuck-tool-call-watcher:/)
    expect(watcherSrc).toMatch(/logger\.warn/)
  })

  it('web.ts boots the watcher', () => {
    expect(webSrc).toMatch(/startStuckToolCallWatcher\(\)/)
    expect(webSrc).toMatch(/Stuck-tool-call watcher started/)
  })
})
