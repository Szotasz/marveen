import { describe, it, expect } from 'vitest'
import { CronExpressionParser } from 'cron-parser'
import { resolveAppTz } from '../config.js'
import { cronDueBetween } from '../web/cron.js'

// Regression for the failure mode one layer below the 2026-07-13..15 outage:
// a MISSPELLED SCHEDULER_TZ ("Europe/Budapesst") used to flow straight into
// APP_TZ -> CRON_TZ. cron-parser throws on an unknown zone, cronDueBetween
// catches the throw and reports "not due", and so every scheduled task stops
// firing -- total, silent, and with a startup report that still looks healthy
// because the configured value "won" its resolution layer.
//
// resolveAppTz validates the configured zone at boot and degrades to the
// process zone (the same behaviour as leaving SCHEDULER_TZ unset) instead of
// scheduling into a void, keeping the rejected value for the startup warn.
//
// The validity probe is cron-parser itself, NOT Intl. These tests therefore
// assert agreement with the consumer rather than with a particular ICU
// version: `+02:00` is accepted here because cron-parser schedules against it
// correctly, even though older ICU builds reject it as a zone name. Asserting
// the Intl answer instead made this suite engine-dependent (red on Node 22).

const SYSTEM = 'Europe/Budapest'

describe('resolveAppTz', () => {
  it('accepts a valid configured zone and reports it as configured', () => {
    expect(resolveAppTz('America/New_York', SYSTEM)).toEqual({
      tz: 'America/New_York',
      configured: 'America/New_York',
    })
  })

  it('falls back to the system zone when unset, with no configured marker', () => {
    expect(resolveAppTz(undefined, SYSTEM)).toEqual({ tz: SYSTEM })
    expect(resolveAppTz('', SYSTEM)).toEqual({ tz: SYSTEM })
  })

  it('rejects a misspelled zone and reports the rejected value', () => {
    expect(resolveAppTz('Europe/Budapesst', SYSTEM)).toEqual({
      tz: SYSTEM,
      invalid: 'Europe/Budapesst',
    })
  })

  it('does not report a rejected zone as configured (the reporter must not claim it won)', () => {
    expect(resolveAppTz('Europe/Budapesst', SYSTEM).configured).toBeUndefined()
  })

  it('uses the real process zone as the default second argument', () => {
    const r = resolveAppTz('Europe/Budapesst')
    expect(r.invalid).toBe('Europe/Budapesst')
    expect(r.tz).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone)
  })
})

describe('the probe agrees with the consumer', () => {
  // The whole point of probing with cron-parser: whatever the scheduler can
  // actually schedule against must survive validation, and nothing else.
  for (const tz of ['Europe/Budapest', 'UTC', 'Etc/GMT-2']) {
    it(`accepts "${tz}" because cron-parser does`, () => {
      expect(() => CronExpressionParser.parse('0 0 * * *', { tz }).next()).not.toThrow()
      expect(resolveAppTz(tz, SYSTEM).tz).toBe(tz)
    })
  }

  it('rejects what cron-parser rejects', () => {
    expect(() => CronExpressionParser.parse('0 0 * * *', { tz: 'Europe/Budapesst' }).next()).toThrow()
    expect(resolveAppTz('Europe/Budapesst', SYSTEM).invalid).toBe('Europe/Budapesst')
  })

  // "+02:00" is an OFFSET, not a zone name, and whether it works is decided by
  // the host's ICU build: cron-parser accepts it on Node 22 and rejects it on
  // Node 20. Asserting either verdict pins the suite to one engine -- which is
  // how the previous version of this test landed red on the maintainer's host.
  //
  // So do not assert the verdict. Assert the INVARIANT that the fix is actually
  // about: whatever the consumer decides, the guard decides the same. That
  // holds on every engine by construction, and it is the only property whose
  // violation would reintroduce the bug.
  it('matches cron-parser on an engine-dependent input, whichever way it goes', () => {
    const OFFSET = '+02:00'
    let consumerAccepts = true
    try {
      CronExpressionParser.parse('0 0 * * *', { tz: OFFSET }).next()
    } catch {
      consumerAccepts = false
    }

    const resolved = resolveAppTz(OFFSET, SYSTEM)
    if (consumerAccepts) {
      expect(resolved).toEqual({ tz: OFFSET, configured: OFFSET })
    } else {
      expect(resolved).toEqual({ tz: SYSTEM, invalid: OFFSET })
    }
  })
})

describe('the outage the validation prevents', () => {
  it('cronDueBetween swallows an unknown-zone throw into a permanent "not due"', () => {
    // 2026-07-27 08:00 Budapest == 06:00 UTC -- an occurrence that IS due.
    const at = Date.parse('2026-07-27T06:00:00Z')
    expect(cronDueBetween('0 8 * * 1', at - 60000, at, 'Europe/Budapest')).toBe(true)
    expect(cronDueBetween('0 8 * * 1', at - 60000, at, 'Europe/Budapesst')).toBe(false)
  })

  it('the validated zone keeps that same occurrence firing', () => {
    const at = Date.parse('2026-07-27T06:00:00Z')
    const { tz } = resolveAppTz('Europe/Budapesst', 'Europe/Budapest')
    expect(cronDueBetween('0 8 * * 1', at - 60000, at, tz)).toBe(true)
  })
})
