import { describe, it, expect } from 'vitest'
import { shouldAutoRestartDownAgent, effectiveRestartGraceMs, parseEtimeToSeconds, decideDownAgentAction } from '../web/agent-restart-policy.js'

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

describe('decideDownAgentAction', () => {
  const MAX = 5
  // A process old enough and past back-off -> the wrapped policy says restart.
  const restartable = {
    processAgeMs: 10 * 60_000,
    msSinceLastRestart: null,
    startupGraceMs: STARTUP,
    restartGraceMs: RESTART,
  }

  it("restarts while under the cap", () => {
    expect(decideDownAgentAction({ ...restartable, consecutiveFailures: 0 }, MAX)).toBe('restart')
    expect(decideDownAgentAction({ ...restartable, consecutiveFailures: MAX - 1 }, MAX)).toBe('restart')
  })

  it("alerts exactly once when the cap is first reached", () => {
    expect(decideDownAgentAction({ ...restartable, consecutiveFailures: MAX }, MAX)).toBe('alert')
  })

  it("skips (silent) once the counter has been ticked past the cap", () => {
    expect(decideDownAgentAction({ ...restartable, consecutiveFailures: MAX + 1 }, MAX)).toBe('skip')
    expect(decideDownAgentAction({ ...restartable, consecutiveFailures: MAX + 9 }, MAX)).toBe('skip')
  })

  it("skips (does not restart) within back-off even under the cap", () => {
    // Recently restarted -> the wrapped policy returns false -> skip, not restart.
    expect(decideDownAgentAction({
      ...restartable,
      msSinceLastRestart: 1_000,
      consecutiveFailures: 1,
    }, MAX)).toBe('skip')
  })

  it("never restarts a freshly started process even at zero failures", () => {
    expect(decideDownAgentAction({
      ...restartable,
      processAgeMs: 20_000, // within startup grace
      consecutiveFailures: 0,
    }, MAX)).toBe('skip')
  })

  it("falls back to plain back-off behaviour when the cap is disabled (0)", () => {
    // No cap -> never escalates to 'alert', however high the failure count.
    expect(decideDownAgentAction({ ...restartable, consecutiveFailures: 999 }, 0)).toBe('restart')
  })
})
