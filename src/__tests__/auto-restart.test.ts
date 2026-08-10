import { describe, it, expect } from 'vitest'
import {
  parseHHMM,
  normalizeAutoRestartConfig,
  restartDue,
  dailyDueAtMs,
  shouldRestartOnCard,
  shouldStartFresh,
  DEFAULT_AUTO_RESTART,
} from '../auto-restart.js'

describe('parseHHMM', () => {
  it('parses valid times to minutes since midnight', () => {
    expect(parseHHMM('00:00')).toBe(0)
    expect(parseHHMM('03:00')).toBe(180)
    expect(parseHHMM('23:59')).toBe(23 * 60 + 59)
    expect(parseHHMM('9:30')).toBe(570)
  })
  it('rejects malformed or out-of-range values', () => {
    for (const bad of ['', '3', '24:00', '12:60', '-1:00', 'aa:bb', '12:5', 12 as unknown, null]) {
      expect(parseHHMM(bad as unknown)).toBeNull()
    }
  })
})

describe('normalizeAutoRestartConfig', () => {
  it('returns safe defaults for junk input', () => {
    expect(normalizeAutoRestartConfig(null)).toEqual(DEFAULT_AUTO_RESTART)
    expect(normalizeAutoRestartConfig('nope')).toEqual(DEFAULT_AUTO_RESTART)
    expect(normalizeAutoRestartConfig({})).toEqual(DEFAULT_AUTO_RESTART)
  })
  it('keeps a valid daily config and clears interval (daily wins)', () => {
    const c = normalizeAutoRestartConfig({ enabled: true, mode: 'fresh', dailyTime: '03:00', intervalHours: 6, handoff: true })
    expect(c).toEqual({ enabled: true, mode: 'fresh', dailyTime: '03:00', intervalHours: null, handoff: true, onCardStart: false })
  })
  it('keeps a valid interval config when no daily time', () => {
    const c = normalizeAutoRestartConfig({ enabled: true, mode: 'continue', intervalHours: 8 })
    expect(c).toEqual({ enabled: true, mode: 'continue', dailyTime: null, intervalHours: 8, handoff: false, onCardStart: false })
  })
  it('drops an invalid dailyTime and non-positive interval', () => {
    const c = normalizeAutoRestartConfig({ enabled: true, dailyTime: '99:99', intervalHours: 0 })
    expect(c.dailyTime).toBeNull()
    expect(c.intervalHours).toBeNull()
  })
  it('defaults mode to continue for an unknown mode', () => {
    expect(normalizeAutoRestartConfig({ mode: 'wild' }).mode).toBe('continue')
  })

  // The schedule is a three-way exclusive choice -- daily time / every N hours /
  // per card. Storing two of them at once would make "when does this restart?"
  // unanswerable from the config alone, which is exactly the ambiguity the
  // existing dailyTime-wins-over-intervalHours rule already prevents.
  it('defaults onCardStart to false so existing stores are unchanged', () => {
    expect(normalizeAutoRestartConfig({}).onCardStart).toBe(false)
    expect(normalizeAutoRestartConfig({ enabled: true, intervalHours: 1 }).onCardStart).toBe(false)
  })
  it('keeps a valid per-card config', () => {
    expect(normalizeAutoRestartConfig({ enabled: true, onCardStart: true }).onCardStart).toBe(true)
  })
  it('requires a real boolean for onCardStart (no truthy coercion)', () => {
    expect(normalizeAutoRestartConfig({ onCardStart: 'igen' }).onCardStart).toBe(false)
    expect(normalizeAutoRestartConfig({ onCardStart: 1 }).onCardStart).toBe(false)
  })
  it('clears both time schedules when onCardStart wins', () => {
    const c = normalizeAutoRestartConfig({ enabled: true, onCardStart: true, dailyTime: '03:00', intervalHours: 6 })
    expect(c.onCardStart).toBe(true)
    expect(c.dailyTime).toBeNull()
    expect(c.intervalHours).toBeNull()
  })
})

describe('shouldRestartOnCard', () => {
  const NOW = 1_700_000_000_000
  const MIN = 5 * 60_000

  const input = (o: Partial<Parameters<typeof shouldRestartOnCard>[0]> = {}) => ({
    onCardStart: true,
    pendingCardAt: NOW,
    lastRestartAtMs: null,
    nowMs: NOW,
    minIntervalMs: MIN,
    ...o,
  })

  it('does not fire when the agent is not on the per-card schedule', () => {
    expect(shouldRestartOnCard(input({ onCardStart: false }))).toBe(false)
  })
  it('does not fire without a pending card request', () => {
    expect(shouldRestartOnCard(input({ pendingCardAt: null }))).toBe(false)
  })
  it('fires for a pending card when the agent has never been restarted', () => {
    expect(shouldRestartOnCard(input())).toBe(true)
  })
  // Restart storm guard: several cards moved to in_progress within a minute must
  // not each cost a restart -- the first one already gave a clean context.
  it('does not fire again inside the minimum interval', () => {
    expect(shouldRestartOnCard(input({ lastRestartAtMs: NOW - 2 * 60_000 }))).toBe(false)
  })
  it('fires again once the minimum interval has passed', () => {
    expect(shouldRestartOnCard(input({ lastRestartAtMs: NOW - 10 * 60_000 }))).toBe(true)
  })
})

describe('shouldStartFresh', () => {
  // A card-triggered restart exists to drop the accumulated context; keeping the
  // conversation would make it pointless. A scheduled restart keeps whatever the
  // operator chose in the separate mode control.
  it('always drops the conversation for a card-triggered restart', () => {
    expect(shouldStartFresh('card', 'continue')).toBe(true)
    expect(shouldStartFresh('card', 'fresh')).toBe(true)
  })
  it('honours the configured mode for a scheduled restart', () => {
    expect(shouldStartFresh('schedule', 'continue')).toBe(false)
    expect(shouldStartFresh('schedule', 'fresh')).toBe(true)
  })
})

describe('restartDue', () => {
  const DUE = 1_000_000

  it('is not due before the scheduled time', () => {
    expect(restartDue(null, DUE - 1, DUE)).toBe(false)
  })
  it('is due at/after the scheduled time when never restarted', () => {
    expect(restartDue(null, DUE, DUE)).toBe(true)
    expect(restartDue(null, DUE + 5_000, DUE)).toBe(true)
  })
  it('does not re-fire once restarted at/after the due point', () => {
    expect(restartDue(DUE, DUE + 5_000, DUE)).toBe(false)
    expect(restartDue(DUE + 1, DUE + 5_000, DUE)).toBe(false)
  })
  it('fires again for a later due point even if restarted at an earlier one', () => {
    const earlier = DUE - 86_400_000 // yesterday's restart
    expect(restartDue(earlier, DUE + 1, DUE)).toBe(true)
  })
  it('is never due for a non-finite dueAt', () => {
    expect(restartDue(null, DUE, Number.NaN)).toBe(false)
    expect(restartDue(null, DUE, Number.POSITIVE_INFINITY)).toBe(false)
  })
})

describe('dailyDueAtMs', () => {
  it('adds the minutes-since-midnight offset to local midnight', () => {
    const midnight = 1_700_000_000_000
    expect(dailyDueAtMs(midnight, 0)).toBe(midnight)
    expect(dailyDueAtMs(midnight, 180)).toBe(midnight + 180 * 60_000) // 03:00
  })
})
