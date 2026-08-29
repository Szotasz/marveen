import { describe, expect, it } from 'vitest'
import {
  stuckToolCallSignature,
  decideStuckToolCallRecovery,
  type StuckToolCallState,
  type StuckToolCallThresholds,
} from '../pane-state.js'
import { shouldDeferForRecentRespawn, confirmsWedgeProfile } from '../web/stuck-tool-call-watcher.js'

// Thresholds matching the production defaults in stuck-tool-call-watcher.ts.
// Repeated here so the tests pin the contract independently of the wrapper
// module (Marveen 2026-06-02 review: every threshold change should require
// an intentional test edit, not silently relax).
const THRESHOLDS: StuckToolCallThresholds = {
  freezeSeconds: 180,
  stagnantPolls: 2,
  minPeakSeconds: 20,
}

const NO_STATE: StuckToolCallState = {
  tag: null,
  spellStartSeconds: null,
  spellPeakSeconds: null,
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
      tag: 'worked', spellStartSeconds: 30, spellPeakSeconds: 31, firstSeenAt: 1, lastSeconds: 31,
      stagnantPolls: 2, stagnantSince: 1, attempts: 0,
    }
    const r = decideStuckToolCallRecovery(null, prev, 1_000_000, THRESHOLDS)
    expect(r.recover).toBe(false)
    expect(r.next).toEqual(NO_STATE)
  })

  it('tag change resets the spell (verb change = real progress)', () => {
    const prev: StuckToolCallState = {
      tag: 'brewed', spellStartSeconds: 30, spellPeakSeconds: 200, firstSeenAt: 1, lastSeconds: 200,
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
      tag: 'worked', spellStartSeconds: 30, spellPeakSeconds: 195, firstSeenAt: 1, lastSeconds: 195,
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
      tag: 'worked', spellStartSeconds: 30, spellPeakSeconds: 31, firstSeenAt: 1_000_000, lastSeconds: 31,
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
      tag: 'worked', spellStartSeconds: 30, spellPeakSeconds: 31, firstSeenAt: 1_000_000, lastSeconds: 31,
      stagnantPolls: 8, stagnantSince: 1_000_000, attempts: 1,
    }
    const r = decideStuckToolCallRecovery({ tag: 'worked', seconds: 31 }, prev, 2_000_000, THRESHOLDS)
    expect(r.recover).toBe(false)
    expect(r.next.attempts).toBe(1)
  })

  it('clock skew backwards: restart spell rather than stall', () => {
    const prev: StuckToolCallState = {
      tag: 'worked', spellStartSeconds: 30, spellPeakSeconds: 31, firstSeenAt: 2_000_000, lastSeconds: 31,
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
      tag: 'worked', spellStartSeconds: 30, spellPeakSeconds: 200, firstSeenAt: 1_000_000, lastSeconds: 200,
      stagnantPolls: 0, stagnantSince: null, attempts: 0,
    }
    // First stagnant poll just stamps the wall-clock start.
    let r = decideStuckToolCallRecovery({ tag: 'worked', seconds: 199 }, prev, 1_030_000, THRESHOLDS)
    expect(r.recover).toBe(false)
    // ~3 min later, still 199 (or any value <= 200): wall-clock hit.
    r = decideStuckToolCallRecovery({ tag: 'worked', seconds: 199 }, r.next, 1_030_000 + 180_000, THRESHOLDS)
    expect(r.recover).toBe(true)
  })

  // Spell-peak discriminator (2026-06-08 fix): a residual TUI footer left over
  // after a prior respawn sits at 3-4s forever -- the counter never advances
  // because the new claude is not running that tool-call, the TUI just kept the
  // stale string. Before the fix this looked exactly like a wedge (counter
  // never increments) and triggered 13 self-respawns in 8h. The discriminator:
  // a real wedge climbed to a meaningful seconds value (31s in the 2026-06-02
  // incident); a residual never does.
  it('residual TUI counter (3-4s never climbing) does NOT recover even after full freeze window', () => {
    const t0 = 1_000_000
    let state: StuckToolCallState = NO_STATE
    // Poll 1: residual sits at 4s -- this is the spell-start observation.
    let r = decideStuckToolCallRecovery({ tag: 'worked', seconds: 4 }, state, t0, THRESHOLDS)
    expect(r.recover).toBe(false)
    expect(r.next.spellPeakSeconds).toBe(4)
    state = r.next
    // Pile on many stagnant polls past the wall-clock freeze window.
    // spellPeak stays at 4, well below minPeakSeconds=20, so recovery is
    // blocked despite the wall-clock+anti-fluke gates being fully satisfied.
    for (let dt = 30_000; dt <= 30 * 60_000; dt += 30_000) {
      r = decideStuckToolCallRecovery({ tag: 'worked', seconds: 4 }, state, t0 + dt, THRESHOLDS)
      expect(r.recover).toBe(false)
      state = r.next
    }
    expect(state.spellPeakSeconds).toBe(4)
    expect(state.attempts).toBe(0)
  })

  it('residual that flickers 3 -> 4 -> 3 -> 4 still does NOT recover (peak stays at 4)', () => {
    // Mirrors the kanban diagnosis "seconds=3-4" -- the residual jiggles
    // by one across polls. The 3 -> 4 step is technically a counter advance
    // (resets stagnantSince once) but the peak only climbs to 4, still well
    // under minPeakSeconds, so the discriminator continues to block.
    const t0 = 1_000_000
    let state: StuckToolCallState = NO_STATE
    state = decideStuckToolCallRecovery({ tag: 'worked', seconds: 3 }, state, t0, THRESHOLDS).next
    state = decideStuckToolCallRecovery({ tag: 'worked', seconds: 4 }, state, t0 + 30_000, THRESHOLDS).next
    expect(state.spellPeakSeconds).toBe(4)
    for (let dt = 60_000; dt <= 20 * 60_000; dt += 30_000) {
      const r = decideStuckToolCallRecovery({ tag: 'worked', seconds: 4 }, state, t0 + dt, THRESHOLDS)
      expect(r.recover).toBe(false)
      state = r.next
    }
    expect(state.spellPeakSeconds).toBe(4)
  })

  it('counter that climbed above minPeakSeconds before freezing DOES recover (real wedge shape)', () => {
    // 2026-06-02 incident shape: counter climbed to 31s, then the render loop
    // wedged. spellPeak reaches 31, clears the discriminator gate, and the
    // wall-clock + anti-fluke gates fire as before.
    const t0 = 1_000_000
    let state: StuckToolCallState = NO_STATE
    // Counter climbs 5 -> 18 -> 31 across three polls.
    state = decideStuckToolCallRecovery({ tag: 'worked', seconds: 5 }, state, t0, THRESHOLDS).next
    state = decideStuckToolCallRecovery({ tag: 'worked', seconds: 18 }, state, t0 + 30_000, THRESHOLDS).next
    state = decideStuckToolCallRecovery({ tag: 'worked', seconds: 31 }, state, t0 + 60_000, THRESHOLDS).next
    expect(state.spellPeakSeconds).toBe(31)
    // Then it wedges. Drive enough stagnant polls + wall-clock to clear all gates.
    let r = decideStuckToolCallRecovery({ tag: 'worked', seconds: 31 }, state, t0 + 90_000, THRESHOLDS)
    expect(r.recover).toBe(false) // first stagnant poll
    state = r.next
    r = decideStuckToolCallRecovery({ tag: 'worked', seconds: 31 }, state, t0 + 60_000 + 30_000 + 180_000, THRESHOLDS)
    expect(r.recover).toBe(true)
    expect(r.next.spellPeakSeconds).toBe(31) // preserved across stagnation
  })

  it('spellPeakSeconds is preserved when counter goes stagnant after a climb', () => {
    // Peak rises with each advance; later stagnation must not erase it.
    const t0 = 1_000_000
    let state: StuckToolCallState = NO_STATE
    state = decideStuckToolCallRecovery({ tag: 'worked', seconds: 10 }, state, t0, THRESHOLDS).next
    state = decideStuckToolCallRecovery({ tag: 'worked', seconds: 25 }, state, t0 + 30_000, THRESHOLDS).next
    expect(state.spellPeakSeconds).toBe(25)
    state = decideStuckToolCallRecovery({ tag: 'worked', seconds: 25 }, state, t0 + 60_000, THRESHOLDS).next
    state = decideStuckToolCallRecovery({ tag: 'worked', seconds: 25 }, state, t0 + 90_000, THRESHOLDS).next
    expect(state.spellPeakSeconds).toBe(25)
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

  it('production minPeakSeconds blocks the residual band (2026-06-08 fix)', () => {
    // Spell-peak discriminator must sit above the residual TUI band (3-4s
    // observed in the 2026-06-08 false-positive loop) and below the real
    // wedge floor (31s from the 2026-06-02 incident). Anywhere in (4, 31)
    // is safe; the production default lives at 20s.
    const m = watcherSrc.match(/minPeakSeconds:\s*(\d+)/)
    expect(m, 'minPeakSeconds constant missing').not.toBeNull()
    const v = parseInt(m![1]!, 10)
    expect(v).toBeGreaterThan(4)
    expect(v).toBeLessThan(31)
  })

  it('recovers via the respawn-pane path (resumeMarveenSession), NOT the launchctl hard-restart (#248)', () => {
    // #248: the launchctl hard-restart -> channels.sh -> `tmux kill-session`
    // kicked the attached client ([exited]). Recovery now delegates to
    // resumeMarveenSession (respawn-pane -k + pane-attribution reap), which
    // replaces only the pane's claude and never kills the session.
    expect(watcherSrc).toMatch(/resumeMarveenSession\(\)/)
    // Import-level (comment-proof): the launchctl hard-restart is no longer
    // wired into the watcher, so it cannot kick an attached client.
    expect(watcherSrc).not.toMatch(/import[^\n]*hardRestartMarveenChannels/)
  })

  it('confirms the idle wedge profile before recovering (CPU-load false-positive guard, #248)', () => {
    expect(watcherSrc).toMatch(/confirmsWedgeProfile\(/)
  })

  it('skips recovery while an inbound channel message is parked in the prompt (2026-08-15)', () => {
    // Owner-observed false positive: the idle-prompt guard is the only thing
    // holding back a residual footer, and it stops applying the moment an
    // inbound message is injected (detectPaneState reads 'typing', not 'idle').
    // Measured that day: counter frozen at 49s and correctly skipped as
    // residual at 14:52/14:56/15:00; the owner's message landed 15:03:06; at
    // 15:04:05 the guard no longer applied and the pane was respawned, taking
    // the not-yet-processed message with it. A parked channel block belongs to
    // stuck-input-watcher, so this watcher must stand down.
    expect(watcherSrc).toMatch(/parkedChannelInput\(pane\)\s*!=\s*null/)
    // Ordering matters: the parked-input guard must be evaluated BEFORE the
    // CPU-profile guard, otherwise a freshly-arrived message (turn not started,
    // CPU still low) walks straight through to the respawn.
    // Anchor on the CALL SITE, not the exported definition (which sits near the
    // top of the file and would make any ordering assertion vacuously false).
    const cpuGuardCall = watcherSrc.indexOf('!confirmsWedgeProfile(cpuPercent, WEDGE_MAX_CPU_PERCENT)')
    expect(cpuGuardCall, 'CPU guard call site not found').toBeGreaterThan(-1)
    expect(watcherSrc.indexOf('parkedChannelInput(pane)')).toBeLessThan(cpuGuardCall)
  })

  it('the owner-facing alert does not present the frozen counter as a duration', () => {
    // The number in the message is the FROZEN COUNTER value, not how long the
    // session has been stuck; the acting threshold is freezeSeconds. The old
    // wording ("49s óta nem haladt") made the owner read it as a 49-second hair
    // trigger and ask about it (2026-08-15).
    expect(watcherSrc).not.toMatch(/s óta nem haladt/)
    expect(watcherSrc).toMatch(/THRESHOLDS\.freezeSeconds/)
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

// Post-respawn grace: the watcher must NOT hard-restart a session that was just
// respawned (by any source: itself, channel-monitor, channel-watchdog.sh, or
// the #264 stuck-modal-guard on Linux) -- avoids boot-churn + double-respawn.
describe('shouldDeferForRecentRespawn', () => {
  const GRACE = 360_000
  const now = 1_000_000_000

  it('no respawn recorded (0) -> do not defer', () => {
    expect(shouldDeferForRecentRespawn(0, now)).toBe(false)
  })

  it('respawn just now -> defer', () => {
    expect(shouldDeferForRecentRespawn(now, now)).toBe(true)
  })

  it('respawn 5 min ago (< 6 min grace) -> defer', () => {
    expect(shouldDeferForRecentRespawn(now - 5 * 60_000, now)).toBe(true)
  })

  it('respawn exactly at the grace boundary -> do not defer (>= grace fires)', () => {
    expect(shouldDeferForRecentRespawn(now - GRACE, now)).toBe(false)
  })

  it('respawn 10 min ago (> grace) -> do not defer (a genuine re-wedge is caught)', () => {
    expect(shouldDeferForRecentRespawn(now - 10 * 60_000, now)).toBe(false)
  })

  it('default grace matches the shared MARVEEN_POST_RESPAWN_GRACE_MS (360s)', () => {
    // 359s defers, 361s does not, with the default arg.
    expect(shouldDeferForRecentRespawn(now - 359_000, now)).toBe(true)
    expect(shouldDeferForRecentRespawn(now - 361_000, now)).toBe(false)
  })
})

describe('confirmsWedgeProfile (#248 CPU-profile guard)', () => {
  const MAX = 30

  it('confirms the idle stdio-wedge profile (CPU ~0.3%, IO-wait)', () => {
    expect(confirmsWedgeProfile(0.3, MAX)).toBe(true)
    expect(confirmsWedgeProfile(0, MAX)).toBe(true)
    expect(confirmsWedgeProfile(MAX, MAX)).toBe(true) // boundary inclusive
  })

  it('does NOT confirm when the process is still burning CPU (heavy work / starvation, not a wedge)', () => {
    expect(confirmsWedgeProfile(31, MAX)).toBe(false)
    expect(confirmsWedgeProfile(95.5, MAX)).toBe(false)
  })

  it('fails OPEN on a null sample (ps failed) -- never blocks recovery on a missing reading', () => {
    expect(confirmsWedgeProfile(null, MAX)).toBe(true)
  })
})

// STUCKFREEZE819: both false kills of 2026-08-19 hit a LIVE session with a
// STALE verdict -- stagnation accrued in a parked/idle stretch, and the kill
// executed ~2 minutes after the verdict's inputs, right as the session woke
// (measured transcript ages at the two kills: ~2s and ~9s; the 20:23:19 kill
// landed ONE second after a healthy tool_result). The gate below re-checks
// validity at KILL time via the session transcript's mtime; a genuinely
// wedged TUI writes nothing, so its transcript is >= freezeSeconds old by
// construction.
import { verdictStaleByTranscript, STALE_VERDICT_FRESH_MS } from '../web/stuck-tool-call-watcher.js'
import { readFileSync as rfs, writeFileSync as wfs, mkdtempSync as mkdt, statSync as st } from 'node:fs'
import { join as pjoin } from 'node:path'
import { tmpdir as ostmp } from 'node:os'
import { spawn as pspawn } from 'node:child_process'

describe('verdictStaleByTranscript (pure) -- STUCKFREEZE819', () => {
  const NOW = 10_000_000
  it('a transcript written moments ago marks the verdict stale (both measured false-kill ages abort)', () => {
    expect(verdictStaleByTranscript(NOW - 2_000, NOW)).toBe(true)   // 20:23:19 shape (~2s)
    expect(verdictStaleByTranscript(NOW - 9_400, NOW)).toBe(true)   // 14:08:59 shape (~9s)
  })

  it('a real wedge does not abort: by construction its transcript is at least freezeSeconds old', () => {
    expect(verdictStaleByTranscript(NOW - THRESHOLDS.freezeSeconds * 1000, NOW)).toBe(false)
    expect(verdictStaleByTranscript(NOW - STALE_VERDICT_FRESH_MS, NOW)).toBe(false) // boundary: exactly N -> proceed
  })

  it('null mtime (dir unreadable) fails OPEN -- the stagnation signal stands, same rule as the CPU guard', () => {
    expect(verdictStaleByTranscript(null, NOW)).toBe(false)
  })

  it('the threshold is derived, not round: above the 9s measured false-kill maximum with margin, well below the 180s wedge floor', () => {
    expect(STALE_VERDICT_FRESH_MS).toBeGreaterThan(9_400 * 2)
    expect(STALE_VERDICT_FRESH_MS).toBeLessThanOrEqual((THRESHOLDS.freezeSeconds * 1000) / 3)
  })
})

describe('negative control: a stopped process writes nothing, so the mtime signal cannot mask a real wedge', () => {
  it('SIGSTOP freezes the writer and its file mtime stands still', async () => {
    const dir = mkdt(pjoin(ostmp(), 'wedge-sim-'))
    const f = pjoin(dir, 'transcript.jsonl')
    wfs(f, '')
    // A writer that appends every 100ms -- the healthy-session analogue.
    const child = pspawn('/bin/sh', ['-c', `while :; do echo line >> ${JSON.stringify(f)}; sleep 0.1; done`], { stdio: 'ignore' })
    try {
      await new Promise(r => setTimeout(r, 500))
      const liveAge = Date.now() - st(f).mtimeMs
      expect(liveAge).toBeLessThan(STALE_VERDICT_FRESH_MS) // alive -> gate would abort a kill
      // The simulated wedge: stop the process (the stdio-blocked render loop's analogue).
      process.kill(child.pid!, 'SIGSTOP')
      const mtimeAtStop = st(f).mtimeMs
      await new Promise(r => setTimeout(r, 1200))
      expect(st(f).mtimeMs).toBe(mtimeAtStop) // the mtime STANDS: a wedge ages past N and recovery proceeds
      expect(verdictStaleByTranscript(mtimeAtStop, mtimeAtStop + STALE_VERDICT_FRESH_MS + 1)).toBe(false)
    } finally {
      try { process.kill(child.pid!, 'SIGKILL') } catch { /* gone */ }
    }
  })
})

describe('wiring: the stale-verdict gate sits at the KILL boundary, not in verdict formation', () => {
  const SRC = rfs(pjoin(__dirname, '..', 'web', 'stuck-tool-call-watcher.ts'), 'utf-8')

  it('checkSession calls the gate after the CPU guard and before resumeMarveenSession', () => {
    // Window: the checkSession function's own structural bounds.
    const start = SRC.indexOf('async function checkSession')
    expect(start).toBeGreaterThanOrEqual(0)
    const body = SRC.slice(start, SRC.indexOf('\n}', start))
    // Comment lines dropped, and the guard pinned as the EXACT live line --
    // a bare indexOf would stay green with the call neutered (`false && ...`),
    // which is precisely the declaration-vs-reachability trap: the text is
    // present, the gate never runs. Caught by mutation on the first version.
    const code = body.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
    const cpuIdx = code.indexOf('confirmsWedgeProfile(')
    const gateIdx = code.indexOf('if (verdictStaleByTranscript(transcriptMtime, Date.now())) {')
    const killIdx = code.indexOf('resumeMarveenSession()')
    expect(cpuIdx).toBeGreaterThanOrEqual(0)
    expect(gateIdx).toBeGreaterThan(cpuIdx)
    expect(killIdx).toBeGreaterThan(gateIdx)
  })

  it('an abort logs loudly and names the incident, so a suppressed kill is findable, not a hole', () => {
    expect(SRC).toContain('ABORTING recovery (STUCKFREEZE819)')
  })
})
