import { describe, it, expect } from 'vitest'
import { shouldAutoRestartDownAgent, parseEtimeToSeconds } from '../web/agent-restart-policy.js'

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
