import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  parseHHMM,
  normalizeAutoRestartConfig,
  restartDue,
  dailyDueAtMs,
  restartBlockedBy,
  deferralOverride,
  OPEN_QUESTION_DEFERRAL_CAP_MS,
  DEFAULT_AUTO_RESTART,
} from '../auto-restart.js'

// Repo root from this test file: src/__tests__ -> ../..
const ROOT = join(__dirname, '..', '..')

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
    const c = normalizeAutoRestartConfig({ enabled: true, mode: 'fresh', dailyTime: '03:00', intervalHours: 6 })
    expect(c).toEqual({ enabled: true, mode: 'fresh', dailyTime: '03:00', intervalHours: null, openQuestionDeferralCapHours: 24 })
  })
  it('keeps a valid interval config when no daily time', () => {
    const c = normalizeAutoRestartConfig({ enabled: true, mode: 'continue', intervalHours: 8 })
    expect(c).toEqual({ enabled: true, mode: 'continue', dailyTime: null, intervalHours: 8, openQuestionDeferralCapHours: 24 })
  })
  it('drops an invalid dailyTime and non-positive interval', () => {
    const c = normalizeAutoRestartConfig({ enabled: true, dailyTime: '99:99', intervalHours: 0 })
    expect(c.dailyTime).toBeNull()
    expect(c.intervalHours).toBeNull()
  })
  it('defaults mode to continue for an unknown mode', () => {
    expect(normalizeAutoRestartConfig({ mode: 'wild' }).mode).toBe('continue')
  })
  it('keeps a valid open-question deferral cap and defaults invalid ones', () => {
    expect(normalizeAutoRestartConfig({ openQuestionDeferralCapHours: 6 }).openQuestionDeferralCapHours).toBe(6)
    expect(normalizeAutoRestartConfig({ openQuestionDeferralCapHours: 0 }).openQuestionDeferralCapHours).toBe(24)
    expect(normalizeAutoRestartConfig({ openQuestionDeferralCapHours: -1 }).openQuestionDeferralCapHours).toBe(24)
    expect(normalizeAutoRestartConfig({ openQuestionDeferralCapHours: 'lots' }).openQuestionDeferralCapHours).toBe(24)
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

describe('restartBlockedBy', () => {
  // Regression guard: paneIsIdle used to be the ONLY pre-restart check, and an
  // agent waiting on the owner's answer is idle precisely then -- so a due
  // restart swallowed the pending exchange (for a channel agent even a
  // "continue" restart is effectively fresh).
  it('an unanswered inbound question defers even an idle pane', () => {
    expect(restartBlockedBy({ paneIdle: true, openQuestion: true })).toBe('open-question')
  })
  it('a busy pane defers, and wins the ordering over an open question', () => {
    expect(restartBlockedBy({ paneIdle: false, openQuestion: false })).toBe('busy-pane')
    expect(restartBlockedBy({ paneIdle: false, openQuestion: true })).toBe('busy-pane')
  })
  it('idle pane and no open question proceeds', () => {
    expect(restartBlockedBy({ paneIdle: true, openQuestion: false })).toBeNull()
  })
})

describe('deferralOverride', () => {
  const now = 1_700_000_000_000
  const day = 24 * 60 * 60 * 1000

  // Regression guard: the open-question signal is clockless (a question the
  // owner never answers stays open forever), so before the cap an agent with
  // one stale question had its nightly restart silently deferred for months --
  // a live ledger showed a streak of 72.6 days.
  it('overrides an open-question deferral once the streak reaches the cap', () => {
    expect(deferralOverride('open-question', now - OPEN_QUESTION_DEFERRAL_CAP_MS, now)).toBe(true)
    expect(deferralOverride('open-question', now - Math.round(72.6 * day), now)).toBe(true)
  })
  it('keeps deferring while the streak is under the cap', () => {
    expect(deferralOverride('open-question', now - OPEN_QUESTION_DEFERRAL_CAP_MS + 1, now)).toBe(false)
    expect(deferralOverride('open-question', now, now)).toBe(false)
  })
  it('never overrides a busy pane, no matter how long the streak', () => {
    expect(deferralOverride('busy-pane', now - 100 * day, now)).toBe(false)
  })
  it('does nothing without a block or without a streak', () => {
    expect(deferralOverride(null, now - 100 * day, now)).toBe(false)
    expect(deferralOverride('open-question', null, now)).toBe(false)
  })
  it('respects an explicit cap argument', () => {
    expect(deferralOverride('open-question', now - 2 * day, now, 3 * day)).toBe(false)
    expect(deferralOverride('open-question', now - 3 * day, now, 3 * day)).toBe(true)
  })
})


// The `handoff` field was declared here as "Phase 2" and never wired: it sat in
// every agent's stored config, the PUT accepted it and a GET echoed it back,
// while the restart path never read it. It has been removed, and these
// guard the removal from both directions -- that the key is gone, and that no
// key like it can quietly come back and be believed.
describe('the auto-restart config carries no unwired handoff switch', () => {
  it('drops a legacy handoff key instead of storing it', () => {
    const c = normalizeAutoRestartConfig({ enabled: true, mode: 'fresh', dailyTime: '04:00', handoff: true })
    expect('handoff' in c).toBe(false)
    // The rest of the config still normalizes exactly as before.
    expect(c).toEqual({ enabled: true, mode: 'fresh', dailyTime: '04:00', intervalHours: null, openQuestionDeferralCapHours: 24 })
  })

  it('has no handoff-shaped key under ANY name in the defaults', () => {
    expect(Object.keys(DEFAULT_AUTO_RESTART).filter((k) => /handoff/i.test(k))).toEqual([])
  })

  // The claim this file cannot make from behavior: a config field can only
  // influence the restart if some code on the restart path READS it, and there
  // is no runtime path here to observe its absence. So assert the absence
  // structurally, on the executable source with comments stripped -- the prose
  // above deliberately says "handoff" many times, and only code counts.
  it('no code on the restart path reads a handoff field', () => {
    const stripComments = (src: string): string =>
      src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
    const files = [
      'src/auto-restart.ts',
      'src/web/auto-restart-runner.ts',
      'src/web/agent-process.ts',
    ]
    for (const f of files) {
      const code = stripComments(readFileSync(join(ROOT, f), 'utf-8'))
      // The one allowed mention is the legacy-key list itself, which exists to
      // ACCEPT the field at the API edge and then throw it away.
      const hits = code.split('\n').filter((l) => /handoff/i.test(l) && !l.includes('LEGACY_AUTO_RESTART_FIELDS'))
      expect(hits, `${f} references handoff on the restart path`).toEqual([])
    }
  })
})
