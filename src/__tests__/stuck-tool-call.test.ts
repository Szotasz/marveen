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
  })

  it('null pane ends any spell', () => {
    const prev: StuckToolCallState = { tag: 'worked', spellStartSeconds: 30, firstSeenAt: 1, lastSeconds: 200, stagnantPolls: 2, attempts: 0 }
    const r = decideStuckToolCallRecovery(null, prev, 1_000_000, THRESHOLDS)
    expect(r.recover).toBe(false)
    expect(r.next).toEqual(NO_STATE)
  })

  it('tag change resets the spell (verb change = real progress)', () => {
    const prev: StuckToolCallState = { tag: 'brewed', spellStartSeconds: 30, firstSeenAt: 1, lastSeconds: 200, stagnantPolls: 2, attempts: 0 }
    const r = decideStuckToolCallRecovery({ tag: 'worked', seconds: 5 }, prev, 1_000_000, THRESHOLDS)
    expect(r.recover).toBe(false)
    expect(r.next.tag).toBe('worked')
    expect(r.next.spellStartSeconds).toBe(5)
    expect(r.next.stagnantPolls).toBe(0)
  })

  it('counter increment resets stagnantPolls (real tool-call progress)', () => {
    const prev: StuckToolCallState = { tag: 'worked', spellStartSeconds: 30, firstSeenAt: 1, lastSeconds: 195, stagnantPolls: 1, attempts: 0 }
    const r = decideStuckToolCallRecovery({ tag: 'worked', seconds: 220 }, prev, 1_000_000, THRESHOLDS)
    expect(r.recover).toBe(false)
    expect(r.next.lastSeconds).toBe(220)
    expect(r.next.stagnantPolls).toBe(0)
  })

  it('seconds<freezeSeconds + stagnant: tick counter, do NOT recover (still below threshold)', () => {
    // The 2026-06-02 incident sat at 31s -- well below 180. Even if it
    // stagnates forever there, we don't act (a legitimate user might pause
    // a tool-call briefly). Only freeze AT >= freezeSeconds matters.
    let state = NO_STATE
    for (let i = 0; i < 5; i++) {
      const r = decideStuckToolCallRecovery({ tag: 'worked', seconds: 31 }, state, 1_000_000 + i * 30_000, THRESHOLDS)
      expect(r.recover).toBe(false)
      state = r.next
    }
  })

  it('seconds>=freezeSeconds + 1 stagnant poll: tick, do NOT recover yet', () => {
    const prev: StuckToolCallState = { tag: 'worked', spellStartSeconds: 30, firstSeenAt: 1_000_000, lastSeconds: 200, stagnantPolls: 0, attempts: 0 }
    const r = decideStuckToolCallRecovery({ tag: 'worked', seconds: 200 }, prev, 1_030_000, THRESHOLDS)
    expect(r.recover).toBe(false)
    expect(r.next.stagnantPolls).toBe(1)
  })

  it('seconds>=freezeSeconds + 2 stagnant polls: RECOVER', () => {
    const prev: StuckToolCallState = { tag: 'worked', spellStartSeconds: 30, firstSeenAt: 1_000_000, lastSeconds: 200, stagnantPolls: 1, attempts: 0 }
    const r = decideStuckToolCallRecovery({ tag: 'worked', seconds: 200 }, prev, 1_060_000, THRESHOLDS)
    expect(r.recover).toBe(true)
    expect(r.next.attempts).toBe(1)
  })

  it('one-shot: once recovered, hold even if still stagnant (next sweep reads fresh pane)', () => {
    const prev: StuckToolCallState = { tag: 'worked', spellStartSeconds: 30, firstSeenAt: 1_000_000, lastSeconds: 200, stagnantPolls: 2, attempts: 1 }
    const r = decideStuckToolCallRecovery({ tag: 'worked', seconds: 200 }, prev, 1_090_000, THRESHOLDS)
    expect(r.recover).toBe(false)
    expect(r.next.attempts).toBe(1)
  })

  it('clock skew backwards: restart spell rather than stall', () => {
    const prev: StuckToolCallState = { tag: 'worked', spellStartSeconds: 30, firstSeenAt: 2_000_000, lastSeconds: 200, stagnantPolls: 1, attempts: 0 }
    const r = decideStuckToolCallRecovery({ tag: 'worked', seconds: 200 }, prev, 1_500_000, THRESHOLDS)
    expect(r.recover).toBe(false)
    expect(r.next.firstSeenAt).toBe(1_500_000)
    expect(r.next.stagnantPolls).toBe(0)
  })

  it('legitimate long tool-call: counter increments every poll, NEVER recovers', () => {
    // 5-minute slow Anthropic call. Counter goes 30s -> 60s -> 90s -> ... -> 300s.
    // Each poll observes an increment, so stagnantPolls stays 0, recover stays false.
    let state = NO_STATE
    for (let n = 30; n <= 300; n += 30) {
      const r = decideStuckToolCallRecovery({ tag: 'worked', seconds: n }, state, 1_000_000 + n * 1000, THRESHOLDS)
      expect(r.recover).toBe(false)
      state = r.next
    }
    expect(state.stagnantPolls).toBe(0)
  })

  it('rolled-back counter: treated as stagnant (a counter that goes backwards is unhealthy)', () => {
    const prev: StuckToolCallState = { tag: 'worked', spellStartSeconds: 30, firstSeenAt: 1_000_000, lastSeconds: 200, stagnantPolls: 1, attempts: 0 }
    const r = decideStuckToolCallRecovery({ tag: 'worked', seconds: 199 }, prev, 1_060_000, THRESHOLDS)
    expect(r.recover).toBe(true)
    expect(r.next.attempts).toBe(1)
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
