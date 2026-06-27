import { describe, it, expect } from 'vitest'
import { shouldAutoRestartDownAgent, effectiveRestartGraceMs, parseEtimeToSeconds } from '../web/agent-restart-policy.js'

const STARTUP = 180_000
const RESTART = 90_000

describe('shouldAutoRestartDownAgent', () => {
  it('restarts an old process that was never restarted by the watchdog', () => {
    expect(shouldAutoRestartDownAgent({
      processAgeMs: 5 * 60_000,
      msSinceLastRestart: null,
      startupGraceMs: STARTUP,
      restartGraceMs: RESTART,
    })).toBe(true)
  })

  it('does NOT restart a freshly started process (within startup grace)', () => {
    expect(shouldAutoRestartDownAgent({
      processAgeMs: 20_000,
      msSinceLastRestart: null,
      startupGraceMs: STARTUP,
      restartGraceMs: RESTART,
    })).toBe(false)
  })

  it('does NOT restart exactly at the startup-grace boundary minus one', () => {
    expect(shouldAutoRestartDownAgent({
      processAgeMs: STARTUP - 1,
      msSinceLastRestart: null,
      startupGraceMs: STARTUP,
      restartGraceMs: RESTART,
    })).toBe(false)
  })

  it('restarts exactly at the startup-grace boundary', () => {
    expect(shouldAutoRestartDownAgent({
      processAgeMs: STARTUP,
      msSinceLastRestart: null,
      startupGraceMs: STARTUP,
      restartGraceMs: RESTART,
    })).toBe(true)
  })

  it('does NOT restart when recently restarted by the watchdog', () => {
    expect(shouldAutoRestartDownAgent({
      processAgeMs: 10 * 60_000,
      msSinceLastRestart: 10_000,
      startupGraceMs: STARTUP,
      restartGraceMs: RESTART,
    })).toBe(false)
  })

  it('restarts when the restart grace has elapsed', () => {
    expect(shouldAutoRestartDownAgent({
      processAgeMs: 10 * 60_000,
      msSinceLastRestart: RESTART + 1,
      startupGraceMs: STARTUP,
      restartGraceMs: RESTART,
    })).toBe(true)
  })

  it('does NOT restart at the restart-grace boundary minus one', () => {
    expect(shouldAutoRestartDownAgent({
      processAgeMs: 10 * 60_000,
      msSinceLastRestart: RESTART - 1,
      startupGraceMs: STARTUP,
      restartGraceMs: RESTART,
    })).toBe(false)
  })

  it('does NOT restart when the process age is unknown (negative)', () => {
    expect(shouldAutoRestartDownAgent({
      processAgeMs: -1,
      msSinceLastRestart: null,
      startupGraceMs: STARTUP,
      restartGraceMs: RESTART,
    })).toBe(false)
  })

  it('does NOT restart when the process age is NaN', () => {
    expect(shouldAutoRestartDownAgent({
      processAgeMs: Number.NaN,
      msSinceLastRestart: null,
      startupGraceMs: STARTUP,
      restartGraceMs: RESTART,
    })).toBe(false)
  })

  it('startup grace takes precedence over an elapsed restart grace', () => {
    // Young process, but msSinceLastRestart already past restart grace:
    // still must not restart, because it is within startup grace.
    expect(shouldAutoRestartDownAgent({
      processAgeMs: 5_000,
      msSinceLastRestart: RESTART + 100_000,
      startupGraceMs: STARTUP,
      restartGraceMs: RESTART,
    })).toBe(false)
  })

  it('handles a realistic Opus-1M startup that previously crash-looped', () => {
    // The agent has been up 45s (plugin not yet spawned), never watchdog-restarted.
    // Old behaviour: restart. New behaviour: defer.
    expect(shouldAutoRestartDownAgent({
      processAgeMs: 45_000,
      msSinceLastRestart: null,
      startupGraceMs: STARTUP,
      restartGraceMs: RESTART,
    })).toBe(false)
  })

  it('restarts a genuinely dead long-running agent', () => {
    expect(shouldAutoRestartDownAgent({
      processAgeMs: 3 * 60 * 60_000,
      msSinceLastRestart: 30 * 60_000,
      startupGraceMs: STARTUP,
      restartGraceMs: RESTART,
    })).toBe(true)
  })
})

describe('parseEtimeToSeconds', () => {
  it('parses MM:SS', () => {
    expect(parseEtimeToSeconds('05:23')).toBe(5 * 60 + 23)
  })

  it('parses HH:MM:SS', () => {
    expect(parseEtimeToSeconds('01:05:23')).toBe(3600 + 5 * 60 + 23)
  })

  it('parses DD-HH:MM:SS', () => {
    expect(parseEtimeToSeconds('2-03:04:05')).toBe(2 * 86400 + 3 * 3600 + 4 * 60 + 5)
  })

  it('parses a leading-space single-digit minute (BSD ps padding)', () => {
    expect(parseEtimeToSeconds('  5:23')).toBe(5 * 60 + 23)
  })

  it('parses 00:00', () => {
    expect(parseEtimeToSeconds('00:00')).toBe(0)
  })

  it('returns -1 for an empty string', () => {
    expect(parseEtimeToSeconds('')).toBe(-1)
  })

  it('returns -1 for non-numeric junk', () => {
    expect(parseEtimeToSeconds('not-a-time')).toBe(-1)
  })

  it('returns -1 for a single bare number (no colon)', () => {
    expect(parseEtimeToSeconds('42')).toBe(-1)
  })

  it('returns -1 for too many segments', () => {
    expect(parseEtimeToSeconds('1:2:3:4')).toBe(-1)
  })

  it('returns -1 for an out-of-range seconds field', () => {
    expect(parseEtimeToSeconds('05:99')).toBe(-1)
  })

  it('returns -1 for an out-of-range minutes field', () => {
    expect(parseEtimeToSeconds('99:30')).toBe(-1)
  })

  it('allows large hour and day counts', () => {
    expect(parseEtimeToSeconds('5-23:59:59')).toBe(5 * 86400 + 23 * 3600 + 59 * 60 + 59)
  })

  it('returns -1 for a bare colon (empty segments)', () => {
    expect(parseEtimeToSeconds(':')).toBe(-1)
  })

  it('returns -1 for a leading dash with no day count', () => {
    expect(parseEtimeToSeconds('-05:30')).toBe(-1)
  })

  it('returns -1 for an empty day segment before the dash', () => {
    expect(parseEtimeToSeconds('-01:02:03')).toBe(-1)
  })

  it('returns -1 for a trailing colon', () => {
    expect(parseEtimeToSeconds('05:')).toBe(-1)
  })

  it('returns -1 for the DD-MM:SS shape ps never emits (days require hours)', () => {
    expect(parseEtimeToSeconds('5-23:59')).toBe(-1)
  })
})

describe('effectiveRestartGraceMs (exponential back-off)', () => {
  it('returns the base grace with zero failures', () => {
    expect(effectiveRestartGraceMs(RESTART, 0)).toBe(RESTART)
  })

  it('doubles per consecutive failure', () => {
    expect(effectiveRestartGraceMs(RESTART, 1)).toBe(RESTART * 2)
    expect(effectiveRestartGraceMs(RESTART, 2)).toBe(RESTART * 4)
    expect(effectiveRestartGraceMs(RESTART, 3)).toBe(RESTART * 8)
  })

  it('caps at maxRestartGraceMs once the back-off would exceed it', () => {
    const cap = 60 * 60 * 1000 // 1h
    // RESTART(90s) * 2^5 = 48min < cap; * 2^6 = 96min -> capped to 1h
    expect(effectiveRestartGraceMs(RESTART, 6, cap)).toBe(cap)
    expect(effectiveRestartGraceMs(RESTART, 20, cap)).toBe(cap)
  })

  it('treats negative / non-finite failure counts as zero', () => {
    expect(effectiveRestartGraceMs(RESTART, -3)).toBe(RESTART)
    expect(effectiveRestartGraceMs(RESTART, Number.NaN)).toBe(RESTART)
  })
})

describe('shouldAutoRestartDownAgent with back-off', () => {
  it('defers a restart that would fire under base grace but not under the backed-off grace', () => {
    // 100s since last restart: past the 90s base grace, but with 1 prior
    // failure the grace is 180s -> still deferred.
    expect(shouldAutoRestartDownAgent({
      processAgeMs: 10 * 60_000,
      msSinceLastRestart: 100_000,
      startupGraceMs: STARTUP,
      restartGraceMs: RESTART,
      consecutiveFailures: 1,
    })).toBe(false)
  })

  it('restarts once the backed-off grace has elapsed', () => {
    expect(shouldAutoRestartDownAgent({
      processAgeMs: 10 * 60_000,
      msSinceLastRestart: RESTART * 2 + 1, // past the 1-failure (180s) grace
      startupGraceMs: STARTUP,
      restartGraceMs: RESTART,
      consecutiveFailures: 1,
    })).toBe(true)
  })

  it('a perpetually-failing plugin is retried at most at the cap, not the base grace', () => {
    const cap = 60 * 60 * 1000
    // 10 failures would be 90s*2^10 ~ 25h without a cap; capped to 1h.
    // 50min since last restart -> still within the 1h cap -> deferred.
    expect(shouldAutoRestartDownAgent({
      processAgeMs: 30 * 60_000,
      msSinceLastRestart: 50 * 60_000,
      startupGraceMs: STARTUP,
      restartGraceMs: RESTART,
      consecutiveFailures: 10,
      maxRestartGraceMs: cap,
    })).toBe(false)
    // 61min since last restart -> past the cap -> retried.
    expect(shouldAutoRestartDownAgent({
      processAgeMs: 30 * 60_000,
      msSinceLastRestart: 61 * 60_000,
      startupGraceMs: STARTUP,
      restartGraceMs: RESTART,
      consecutiveFailures: 10,
      maxRestartGraceMs: cap,
    })).toBe(true)
  })

  it('preserves the original behaviour when consecutiveFailures is omitted', () => {
    expect(shouldAutoRestartDownAgent({
      processAgeMs: 10 * 60_000,
      msSinceLastRestart: RESTART + 1,
      startupGraceMs: STARTUP,
      restartGraceMs: RESTART,
    })).toBe(true)
  })
})

// 2026-06-27 follow-up: faster first retry on a flaky --channels plugin-load
// miss. When the pane has SETTLED at the idle prompt the agent finished cold-
// starting, so a still-absent channel poller is a definitive flaky miss (the
// bun poller attaches within ~10s when it works) -- not a slow boot. In that
// state we may relaunch without waiting out the full (5min) startup grace, and
// the first couple of relaunch failures stay at the base grace instead of
// doubling, so the common ~2-3 try convergence is not slowed.
const FAST = 45_000
describe('shouldAutoRestartDownAgent: settled-pane fast retry', () => {
  it('restarts a SETTLED young process past the fast grace (definitive flaky miss)', () => {
    // 60s old: well within the 180s startup grace, but pane is settled and the
    // 45s fast grace has elapsed -> relaunch now instead of waiting 5 minutes.
    expect(shouldAutoRestartDownAgent({
      processAgeMs: 60_000,
      msSinceLastRestart: null,
      startupGraceMs: STARTUP,
      restartGraceMs: RESTART,
      paneSettled: true,
      fastRetryGraceMs: FAST,
    })).toBe(true)
  })

  it('does NOT restart a settled process still within the fast grace', () => {
    expect(shouldAutoRestartDownAgent({
      processAgeMs: 30_000,
      msSinceLastRestart: null,
      startupGraceMs: STARTUP,
      restartGraceMs: RESTART,
      paneSettled: true,
      fastRetryGraceMs: FAST,
    })).toBe(false)
  })

  it('does NOT use the fast grace when the pane is NOT settled (still booting)', () => {
    // Same young age, but the pane has not reached idle -> it may genuinely be
    // booting (large-context model); keep the conservative startup grace.
    expect(shouldAutoRestartDownAgent({
      processAgeMs: 60_000,
      msSinceLastRestart: null,
      startupGraceMs: STARTUP,
      restartGraceMs: RESTART,
      paneSettled: false,
      fastRetryGraceMs: FAST,
    })).toBe(false)
  })

  it('ignores the fast path when fastRetryGraceMs is omitted', () => {
    expect(shouldAutoRestartDownAgent({
      processAgeMs: 60_000,
      msSinceLastRestart: null,
      startupGraceMs: STARTUP,
      restartGraceMs: RESTART,
      paneSettled: true,
    })).toBe(false)
  })

  it('never LENGTHENS the grace if fastRetryGraceMs exceeds the startup grace', () => {
    // min(startup, fast) keeps the smaller; a bogus large fast value is ignored.
    expect(shouldAutoRestartDownAgent({
      processAgeMs: STARTUP - 1,
      msSinceLastRestart: null,
      startupGraceMs: STARTUP,
      restartGraceMs: RESTART,
      paneSettled: true,
      fastRetryGraceMs: STARTUP + 100_000,
    })).toBe(false)
  })
})

describe('effectiveRestartGraceMs: free fast retries before back-off', () => {
  it('keeps the base grace for the first freeFastRetries failures', () => {
    expect(effectiveRestartGraceMs(RESTART, 1, undefined, 2)).toBe(RESTART)
    expect(effectiveRestartGraceMs(RESTART, 2, undefined, 2)).toBe(RESTART)
  })

  it('starts doubling only after the free retries are spent', () => {
    expect(effectiveRestartGraceMs(RESTART, 3, undefined, 2)).toBe(RESTART * 2)
    expect(effectiveRestartGraceMs(RESTART, 4, undefined, 2)).toBe(RESTART * 4)
  })

  it('preserves original doubling when freeFastRetries omitted/zero', () => {
    expect(effectiveRestartGraceMs(RESTART, 1)).toBe(RESTART * 2)
    expect(effectiveRestartGraceMs(RESTART, 1, undefined, 0)).toBe(RESTART * 2)
  })

  it('still honours the cap with free retries', () => {
    const cap = 60 * 60 * 1000
    expect(effectiveRestartGraceMs(RESTART, 30, cap, 2)).toBe(cap)
  })
})

describe('shouldAutoRestartDownAgent: free fast retries end-to-end', () => {
  it('a settled agent relaunches at base grace for the first failures (no doubling)', () => {
    // 1 prior failure, 100s since last restart: original behaviour would defer
    // (180s grace); with 2 free retries the grace stays 90s -> relaunch now.
    expect(shouldAutoRestartDownAgent({
      processAgeMs: 60_000,
      msSinceLastRestart: 100_000,
      startupGraceMs: STARTUP,
      restartGraceMs: RESTART,
      consecutiveFailures: 1,
      maxRestartGraceMs: 60 * 60 * 1000,
      paneSettled: true,
      fastRetryGraceMs: FAST,
      freeFastRetries: 2,
    })).toBe(true)
  })

  it('on a SETTLED pane the relaunch window also shrinks to the fast grace', () => {
    // 50s since last restart: under the 90s base (would defer without the
    // settled fast path), but a settled+deaf agent uses the 45s relaunch base.
    expect(shouldAutoRestartDownAgent({
      processAgeMs: 50_000,
      msSinceLastRestart: 50_000,
      startupGraceMs: STARTUP,
      restartGraceMs: RESTART,
      consecutiveFailures: 1,
      maxRestartGraceMs: 60 * 60 * 1000,
      paneSettled: true,
      fastRetryGraceMs: FAST,
      freeFastRetries: 2,
    })).toBe(true)
    // Same timing but NOT settled (still booting): keep the conservative window.
    expect(shouldAutoRestartDownAgent({
      processAgeMs: 50_000,
      msSinceLastRestart: 50_000,
      startupGraceMs: STARTUP,
      restartGraceMs: RESTART,
      consecutiveFailures: 1,
      maxRestartGraceMs: 60 * 60 * 1000,
      paneSettled: false,
      fastRetryGraceMs: FAST,
      freeFastRetries: 2,
    })).toBe(false)
  })

  it('a genuinely-broken settled plugin still backs off after the free retries', () => {
    // failures past the free window: doubling resumes (from the fast base),
    // so a plugin that never comes up is not relaunched every 45s forever.
    // 5 failures, 45s base, 2 free -> 45s * 2^3 = 360s grace; 200s since last
    // restart is still within it -> defer.
    expect(shouldAutoRestartDownAgent({
      processAgeMs: 5 * 60_000,
      msSinceLastRestart: 200_000,
      startupGraceMs: STARTUP,
      restartGraceMs: RESTART,
      consecutiveFailures: 5,
      maxRestartGraceMs: 60 * 60 * 1000,
      paneSettled: true,
      fastRetryGraceMs: FAST,
      freeFastRetries: 2,
    })).toBe(false)
  })
})
