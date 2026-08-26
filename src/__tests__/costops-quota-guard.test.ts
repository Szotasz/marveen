import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { logger } from '../logger.js'
import {
  readAccessToken,
  parseWindow,
  parseUsage,
  fetchUsage,
  classify,
  elapsedFraction,
  forecastText,
  runQuotaGuard,
  WARN_THRESHOLD,
  CRITICAL_THRESHOLD,
  ALERT_COOLDOWN_SECONDS,
  EMPTY_QUOTA_STATE,
  type QuotaGuardState,
  type QuotaUsage,
} from '../costops/quota-guard.js'

/**
 * F3 (kanban #132): act on the subscription's rolling quota.
 *
 * The absolute ladder (70% warn / 85% eco mode) is deliberate. A
 * "consumption ahead of elapsed time" rule fires almost always at the start of
 * a seven-day window -- one hour in, elapsed is 0.6% -- and almost never at the
 * end. The pace comparison survives only as forecast text.
 */

const NOW = 1_785_000_000
const TOKEN = 'sk-ant-oat01-SECRET-TOKEN-VALUE-do-not-log'

function usage(sevenDayPct: number, resetsAt: number | null = NOW + 3 * 86400): QuotaUsage {
  return {
    five_hour: { utilization: 0.18, resets_at: null },
    seven_day: { utilization: sevenDayPct, resets_at: resetsAt },
  }
}

function deps(over: Parameters<typeof runQuotaGuard>[0] = {}) {
  return {
    readToken: () => TOKEN,
    fetch: async () => usage(0.5),
    enableEco: () => ({ ok: true, enabled: true, plan: { target: 'claude-sonnet-5', changes: [], unchanged: [], needsRestart: [] }, applied: ['(main)'], failed: [], restart_required: true, note: 'x' }),
    ecoAlreadyOn: () => false,
    notify: () => {},
    readState: () => ({ ...EMPTY_QUOTA_STATE }),
    writeState: () => {},
    now: NOW,
    ...over,
  }
}

describe('reading the token', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'qg-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('reads the OAuth access token', () => {
    const p = join(dir, 'creds.json')
    writeFileSync(p, JSON.stringify({ claudeAiOauth: { accessToken: TOKEN, refreshToken: 'other' } }))
    expect(readAccessToken(p)).toBe(TOKEN)
  })

  it('returns null instead of throwing when the file is missing or malformed', () => {
    expect(readAccessToken(join(dir, 'nope.json'))).toBeNull()
    const bad = join(dir, 'bad.json')
    writeFileSync(bad, '{ not json')
    expect(readAccessToken(bad)).toBeNull()
  })

  it('does not put the file contents into the log when parsing fails', () => {
    // A JSON parse error quotes the offending region -- which is the token.
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger)
    const bad = join(dir, 'bad2.json')
    writeFileSync(bad, `{"claudeAiOauth":{"accessToken":"${TOKEN}"` )
    readAccessToken(bad)
    expect(JSON.stringify(warn.mock.calls)).not.toContain(TOKEN)
    warn.mockRestore()
  })
})

describe('parsing an undocumented payload', () => {
  it('converts a 0-100 percentage to a fraction', () => {
    expect(parseWindow({ utilization: 42, resets_at: NOW })).toEqual({ utilization: 0.42, resets_at: NOW })
  })

  it('accepts an ISO reset time', () => {
    const w = parseWindow({ utilization: 10, resets_at: '2026-08-01T00:00:00Z' })!
    expect(w.resets_at).toBe(Math.floor(Date.parse('2026-08-01T00:00:00Z') / 1000))
  })

  it('rejects a shape it does not recognise rather than reading it as zero', () => {
    // A guard that silently reads 0% would run the fleet straight through a cap.
    expect(parseWindow({ utilization: 'lots' })).toBeNull()
    expect(parseWindow({ utilization: -1 })).toBeNull()
    expect(parseWindow({ utilization: 101 })).toBeNull()
    expect(parseWindow(null)).toBeNull()
    expect(parseUsage({ five_hour: { utilization: 5 } })).toBeNull() // no seven_day
    expect(parseUsage('nope')).toBeNull()
  })

  it('tolerates a missing five_hour window', () => {
    expect(parseUsage({ seven_day: { utilization: 20 } })?.seven_day?.utilization).toBe(0.2)
  })
})

describe('fetching', () => {
  it('never logs the token or the response body', async () => {
    // The sabotage target: if either reaches a log line, this fails.
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger)
    const body = { secret_echo: TOKEN }
    const res = await fetchUsage(TOKEN, (async () => ({
      ok: false, status: 401, json: async () => body,
    })) as unknown as typeof fetch)
    expect(res).toBeNull()
    const logged = JSON.stringify(warn.mock.calls)
    expect(logged, 'the token reached a log line').not.toContain(TOKEN)
    warn.mockRestore()
  })

  it('is loud in the log when the endpoint fails', async () => {
    // Silent to users, loud to the log. A failure that looks like "checked and
    // fine" is the exact silent no-op this whole subsystem exists to avoid.
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger)
    await fetchUsage(TOKEN, (async () => { throw new Error('network down') }) as unknown as typeof fetch)
    expect(warn).toHaveBeenCalled()
    expect(JSON.stringify(warn.mock.calls)).toContain('quota_fetch_error')
    warn.mockRestore()
  })

  it('reports an unexpected payload shape rather than passing it on', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger)
    const r = await fetchUsage(TOKEN, (async () => ({ ok: true, status: 200, json: async () => ({ nonsense: 1 }) })) as unknown as typeof fetch)
    expect(r).toBeNull()
    expect(JSON.stringify(warn.mock.calls)).toContain('quota_shape_unexpected')
    warn.mockRestore()
  })
})

describe('the absolute ladder', () => {
  it('classifies at the agreed thresholds', () => {
    expect(classify(0.69)).toBe('ok')
    expect(classify(WARN_THRESHOLD)).toBe('warning')
    expect(classify(0.84)).toBe('warning')
    expect(classify(CRITICAL_THRESHOLD)).toBe('critical')
    expect(classify(1)).toBe('critical')
  })

  it('warns without touching any config', async () => {
    const enableEco = vi.fn()
    const r = await runQuotaGuard(deps({ fetch: async () => usage(0.72), enableEco }))
    expect(r.level).toBe('warning')
    expect(r.alerted).toBe(true)
    expect(enableEco).not.toHaveBeenCalled()
    expect(r.eco_enabled).toBe(false)
  })

  it('switches eco mode on at the critical threshold', async () => {
    const enableEco = vi.fn(() => deps().enableEco())
    const r = await runQuotaGuard(deps({ fetch: async () => usage(0.9), enableEco }))
    expect(r.level).toBe('critical')
    expect(enableEco).toHaveBeenCalledTimes(1)
    expect(r.eco_enabled).toBe(true)
  })

  it('does not re-enable eco mode that is already on', async () => {
    const enableEco = vi.fn()
    const r = await runQuotaGuard(deps({ fetch: async () => usage(0.9), enableEco, ecoAlreadyOn: () => true }))
    expect(enableEco).not.toHaveBeenCalled()
    expect(r.eco_enabled).toBe(false)
  })

  it('never restarts an agent', async () => {
    const r = await runQuotaGuard(deps({ fetch: async () => usage(0.9) }))
    expect(r.restart_required).toBe(true)
  })
})

describe('not shouting every cycle', () => {
  it('stays quiet at a steady level inside the cooldown', async () => {
    // At a 15-minute cadence a steady 72% would otherwise alert 96 times a day,
    // and noise is how a real alert gets ignored.
    const notify = vi.fn()
    const state: QuotaGuardState = { last_alert_level: 'warning', last_alert_at: NOW - 60 }
    const r = await runQuotaGuard(deps({ fetch: async () => usage(0.72), notify, readState: () => state }))
    expect(notify).not.toHaveBeenCalled()
    expect(r.alerted).toBe(false)
  })

  it('speaks again once the cooldown has passed', async () => {
    const notify = vi.fn()
    const state: QuotaGuardState = { last_alert_level: 'warning', last_alert_at: NOW - ALERT_COOLDOWN_SECONDS - 1 }
    await runQuotaGuard(deps({ fetch: async () => usage(0.72), notify, readState: () => state }))
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('speaks immediately when the level gets worse, cooldown or not', async () => {
    const notify = vi.fn()
    const state: QuotaGuardState = { last_alert_level: 'warning', last_alert_at: NOW - 60 }
    await runQuotaGuard(deps({ fetch: async () => usage(0.9), notify, readState: () => state }))
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('clears the latch after recovery so the next crossing alerts', async () => {
    const writeState = vi.fn()
    const state: QuotaGuardState = { last_alert_level: 'critical', last_alert_at: NOW - 60 }
    await runQuotaGuard(deps({ fetch: async () => usage(0.2), writeState, readState: () => state }))
    expect(writeState).toHaveBeenCalledWith(EMPTY_QUOTA_STATE)
  })
})

describe('the pace comparison is forecast, never a trigger', () => {
  it('does not alert early in a window just because consumption is ahead', async () => {
    // One hour into seven days: 0.6% elapsed, 15% used -- 25x "ahead", and far
    // past any plausible margin. A time-proportional rule fires here every
    // cycle; the absolute ladder correctly says nothing, because 15% of a
    // seven-day quota is not a problem.
    const notify = vi.fn()
    const r = await runQuotaGuard(deps({
      fetch: async () => usage(0.15, NOW + 7 * 86400 - 3600),
      notify,
    }))
    expect(r.level).toBe('ok')
    expect(notify).not.toHaveBeenCalled()
  })

  it('describes running ahead in the alert text', () => {
    expect(forecastText(0.8, 0.4)).toContain('ahead')
    expect(forecastText(0.8, 0.4)).toContain('Forecast only')
  })

  it('describes running behind, and says so is only a forecast', () => {
    expect(forecastText(0.2, 0.9)).toContain('behind')
    expect(forecastText(0.2, 0.9)).toContain('Forecast only')
  })

  it('says plainly when there is no reset time to reason from', () => {
    expect(forecastText(0.8, null)).toContain('No reset time')
  })

  it('computes elapsed fraction from the reset time', () => {
    expect(elapsedFraction(NOW + 7 * 86400, NOW)).toBeCloseTo(0, 6)
    expect(elapsedFraction(NOW, NOW)).toBeCloseTo(1, 6)
    expect(elapsedFraction(null, NOW)).toBeNull()
  })
})

describe('report-only mode', () => {
  it('classifies without switching eco mode or alerting', async () => {
    // The read-only endpoint uses this. A dashboard refresh must never be able
    // to trip the fleet into eco mode.
    const enableEco = vi.fn()
    const notify = vi.fn()
    const r = await runQuotaGuard(deps({ fetch: async () => usage(0.95), enableEco, notify, act: false }))
    expect(r.level).toBe('critical')
    expect(r.reason).toBe('reported')
    expect(enableEco).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
    expect(r.alerted).toBe(false)
  })
})

describe('failing safe', () => {
  it('does nothing and says why when there are no credentials', async () => {
    const enableEco = vi.fn()
    const r = await runQuotaGuard(deps({ readToken: () => null, enableEco }))
    expect(r).toMatchObject({ ok: false, reason: 'no_credentials', eco_enabled: false })
    expect(enableEco).not.toHaveBeenCalled()
  })

  it('does nothing and says why when usage is unavailable', async () => {
    // Critically: it must NOT read an unavailable quota as a low one.
    const enableEco = vi.fn()
    const r = await runQuotaGuard(deps({ fetch: async () => null, enableEco }))
    expect(r).toMatchObject({ ok: false, reason: 'usage_unavailable' })
    expect(r.level).toBeNull()
    expect(enableEco).not.toHaveBeenCalled()
  })

  it('never throws into its scheduler', async () => {
    const r = await runQuotaGuard(deps({ fetch: async () => { throw new Error('boom') } }))
    expect(r.reason).toBe('error')
    expect(r.ok).toBe(false)
  })

  it('keeps the token out of the alert text', async () => {
    let sent = ''
    await runQuotaGuard(deps({ fetch: async () => usage(0.9), notify: (t) => { sent = t } }))
    expect(sent).not.toContain(TOKEN)
    expect(sent).toContain('90%')
    expect(sent).toContain('does not perform')
  })
})
