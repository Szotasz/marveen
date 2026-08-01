// Contract tests for the daily FX refresh (kanban #167).
//
// The owner declined to maintain the rate table by hand, so these numbers now
// arrive from the network and land in a financial table unattended. Everything
// below is about the same question: what stops a bad number from getting in,
// and does a refusal leave the previous state intact?
//
// The fetch is injected, so every rule is exercised against a fixed payload
// rather than against the live ECB.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseFrankfurter,
  sanityCheck,
  shouldRefresh,
  applyFxUpdate,
  refreshFxRates,
  localDateKey,
  FX_SOURCE_URL,
  FX_SOURCE_NAME,
  MAX_DAILY_DRIFT,
} from '../costops/fx-rates.js'

// A real-shaped payload: EUR base, HUF and USD quoted against it.
const PAYLOAD = { amount: 1, base: 'EUR', date: '2026-07-31', rates: { HUF: 396.5, USD: 1.09 } }

// A Wednesday and a Saturday, for the weekday gate.
const WEDNESDAY = new Date('2026-08-05T09:00:00')
const SATURDAY = new Date('2026-08-01T09:00:00')

let dir: string
let configPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fx-test-'))
  configPath = join(dir, 'costops-config.json')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function writeConfig(extra: Record<string, unknown> = {}) {
  writeFileSync(configPath, JSON.stringify({
    version: 1, currency: 'HUF',
    fixed_costs: [{ source_id: 'vercel', name: 'Vercel', amount: 20, currency: 'USD', project: 'persistent-cart' }],
    budgets: [], ...extra,
  }, null, 2))
}

const okFetch = (payload: unknown = PAYLOAD) =>
  (async () => ({ ok: true, status: 200, json: async () => payload })) as unknown as typeof fetch

describe('parsing the source payload', () => {
  it('converts the EUR-based quotes into HUF-per-unit rates', () => {
    // EUR/HUF is quoted directly; USD/HUF is a cross rate (HUF per EUR over
    // USD per EUR). Getting the cross rate upside down is the classic way to
    // produce a plausible number that is wrong by orders of magnitude.
    const snap = parseFrankfurter(PAYLOAD)!
    expect(snap.rates.EUR).toBeCloseTo(396.5, 4)
    expect(snap.rates.USD).toBeCloseTo(396.5 / 1.09, 2)
    expect(snap.asof).toBe('2026-07-31')
  })

  it('refuses a payload on a different base rather than misreading it', () => {
    expect(parseFrankfurter({ ...PAYLOAD, base: 'USD' })).toBeNull()
  })

  it('refuses anything that is not the expected shape', () => {
    expect(parseFrankfurter(null)).toBeNull()
    expect(parseFrankfurter('<html>error</html>')).toBeNull()
    expect(parseFrankfurter({ ...PAYLOAD, rates: { HUF: 396.5 } })).toBeNull()      // USD missing
    expect(parseFrankfurter({ ...PAYLOAD, date: 'yesterday' })).toBeNull()
    expect(parseFrankfurter({ ...PAYLOAD, rates: { HUF: 0, USD: 1.09 } })).toBeNull()
  })
})

describe('sanity check', () => {
  it('accepts plausible rates', () => {
    expect(sanityCheck({ USD: 363, EUR: 396 }).ok).toBe(true)
  })

  it('rejects a rate outside the plausible band', () => {
    // What an inverted cross rate or a parsed error page looks like.
    const r = sanityCheck({ USD: 0.0027, EUR: 396 })
    expect(r.ok).toBe(false)
    expect(r.reasons[0]).toContain('USD')
  })

  it('rejects an implausible day-over-day jump even inside the band', () => {
    // Both numbers are believable on their own; the MOVE is not. This is what
    // catches a source that silently starts quoting something else.
    const jump = 400 * (1 + MAX_DAILY_DRIFT + 0.05)
    const r = sanityCheck({ USD: jump, EUR: 396 }, { USD: 400, EUR: 396 })
    expect(r.ok).toBe(false)
    expect(r.reasons.join(' ')).toContain('jump')
  })

  it('allows an ordinary daily move', () => {
    expect(sanityCheck({ USD: 366, EUR: 399 }, { USD: 363, EUR: 396 }).ok).toBe(true)
  })

  it('has nothing to compare against on the first run, and says yes on the band alone', () => {
    expect(sanityCheck({ USD: 363, EUR: 396 }, undefined).ok).toBe(true)
  })
})

describe('when to look', () => {
  it('does not fetch at the weekend, because the ECB does not publish', () => {
    expect(shouldRefresh(SATURDAY, undefined)).toBe(false)
  })

  it('fetches once on a working day', () => {
    expect(shouldRefresh(WEDNESDAY, undefined)).toBe(true)
    expect(shouldRefresh(WEDNESDAY, localDateKey(WEDNESDAY))).toBe(false)
  })

  it('separates when we LOOKED from when the rates were PUBLISHED', () => {
    // After a holiday the source legitimately returns an older date. Keying the
    // "already done today" check on the published date would retry every hour
    // forever, hammering the source and never settling.
    expect(shouldRefresh(WEDNESDAY, localDateKey(WEDNESDAY))).toBe(false)
  })
})

describe('merging into the config', () => {
  it('keeps every other key exactly as it was', () => {
    // This file holds the operator's own cost entries. A refresh that dropped
    // one would be a far worse bug than a stale rate.
    const before = { version: 1, currency: 'HUF', fixed_costs: [{ source_id: 'vercel' }], budgets: [], _doc: 'note' }
    const after = applyFxUpdate(before, { rates: { USD: 363, EUR: 396 }, asof: '2026-07-31' }, '2026-08-05')
    expect(after.fixed_costs).toEqual(before.fixed_costs)
    expect(after._doc).toBe('note')
    expect(after.fx_rates).toEqual({ USD: 363, EUR: 396 })
    expect(after.fx_asof).toBe('2026-07-31')
    expect(after.fx_checked_on).toBe('2026-08-05')
    expect(after.fx_source).toBe(FX_SOURCE_NAME)
  })

  it('preserves rates for currencies it does not fetch', () => {
    const after = applyFxUpdate({ fx_rates: { GBP: 460, USD: 1 } }, { rates: { USD: 363, EUR: 396 }, asof: '2026-07-31' }, '2026-08-05')
    expect(after.fx_rates).toEqual({ GBP: 460, USD: 363, EUR: 396 })
  })
})

describe('the refresh cycle', () => {
  it('writes rates and stamps both dates', async () => {
    writeConfig()
    const out = await refreshFxRates({ now: WEDNESDAY, fetchImpl: okFetch(), configPath })
    expect(out.status).toBe('updated')
    const written = JSON.parse(readFileSync(configPath, 'utf-8'))
    expect(written.fx_rates.EUR).toBeCloseTo(396.5, 2)
    expect(written.fx_asof).toBe('2026-07-31')
    expect(written.fx_checked_on).toBe(localDateKey(WEDNESDAY))
    expect(written.fixed_costs).toHaveLength(1)
  })

  it('leaves the file untouched when the rates fail the sanity check', async () => {
    // The whole point: a bad rate must not reach the table. Stale is visible
    // (fx_asof shows its age); wrong is invisible.
    writeConfig({ fx_rates: { USD: 363, EUR: 396 } })
    const before = readFileSync(configPath, 'utf-8')
    const out = await refreshFxRates({
      now: WEDNESDAY, configPath,
      fetchImpl: okFetch({ ...PAYLOAD, rates: { HUF: 396.5, USD: 100000 } }),
    })
    expect(out.status).toBe('rejected')
    expect(readFileSync(configPath, 'utf-8')).toBe(before)
  })

  it('does not stamp the day when it rejected, so the next tick retries', async () => {
    writeConfig({ fx_rates: { USD: 363, EUR: 396 } })
    await refreshFxRates({ now: WEDNESDAY, configPath, fetchImpl: okFetch({ ...PAYLOAD, rates: { HUF: 1, USD: 1 } }) })
    expect(JSON.parse(readFileSync(configPath, 'utf-8')).fx_checked_on).toBeUndefined()
  })

  it('survives a network failure quietly, keeping the old rates', async () => {
    writeConfig({ fx_rates: { USD: 363, EUR: 396 } })
    const failing = (async () => { throw new Error('ENOTFOUND') }) as unknown as typeof fetch
    const out = await refreshFxRates({ now: WEDNESDAY, fetchImpl: failing, configPath })
    expect(out.status).toBe('failed')
    expect(JSON.parse(readFileSync(configPath, 'utf-8')).fx_rates).toEqual({ USD: 363, EUR: 396 })
  })

  it('treats a non-200 as a failure rather than parsing the error body', async () => {
    writeConfig()
    const serverError = (async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof fetch
    const out = await refreshFxRates({ now: WEDNESDAY, fetchImpl: serverError, configPath })
    expect(out).toEqual({ status: 'failed', error: 'HTTP 503' })
  })

  it('never creates a config that does not exist', async () => {
    // A cost config conjured out of a rate fetch would look configured while
    // holding no costs at all.
    const out = await refreshFxRates({ now: WEDNESDAY, fetchImpl: okFetch(), configPath: join(dir, 'absent.json') })
    expect(out).toEqual({ status: 'skipped', reason: 'no_config' })
    expect(existsSync(join(dir, 'absent.json'))).toBe(false)
  })

  it('refuses to rewrite a config it cannot parse', async () => {
    // Half-typed JSON is the operator mid-edit. Rewriting it would destroy
    // their work; a stale rate would not.
    writeFileSync(configPath, '{ "currency": "HUF", ')
    const out = await refreshFxRates({ now: WEDNESDAY, fetchImpl: okFetch(), configPath })
    expect(out.status).toBe('failed')
    expect(readFileSync(configPath, 'utf-8')).toBe('{ "currency": "HUF", ')
  })

  it('does not go out at all when it is not due', async () => {
    writeConfig({ fx_checked_on: localDateKey(WEDNESDAY) })
    let called = false
    const spy = (async () => { called = true; return { ok: true, status: 200, json: async () => PAYLOAD } }) as unknown as typeof fetch
    const out = await refreshFxRates({ now: WEDNESDAY, fetchImpl: spy, configPath })
    expect(out).toEqual({ status: 'skipped', reason: 'not_due' })
    expect(called).toBe(false)
  })

  it('targets one fixed URL that a config edit cannot change', async () => {
    // A configurable endpoint would turn a cost feature into an arbitrary
    // outbound request.
    writeConfig()
    let seen = ''
    const spy = (async (url: string) => { seen = String(url); return { ok: true, status: 200, json: async () => PAYLOAD } }) as unknown as typeof fetch
    await refreshFxRates({ now: WEDNESDAY, fetchImpl: spy, configPath })
    expect(seen).toBe(FX_SOURCE_URL)
    expect(seen.startsWith('https://')).toBe(true)
  })
})
