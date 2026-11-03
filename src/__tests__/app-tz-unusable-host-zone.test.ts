import { describe, it, expect, vi, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CronExpressionParser } from 'cron-parser'
import { resolveAppTz, usableHostTz } from '../config.js'

// ISSUE1895 review: with TZ='' in the environment and no SCHEDULER_TZ, Node 22
// reports the host zone as "Etc/Unknown". cron-parser schedules against it,
// Intl rejects it with a RangeError, and heartbeat-header-stamp.ts builds its
// Intl formatter with APP_TZ at module load, on the dashboard's static import
// chain (index.ts -> web.ts -> routes/messages.ts). An unvalidated host zone
// therefore stopped the dashboard from starting at all. The host zone is now
// probed with both consumers, and an unusable one becomes UTC.
const UNKNOWN = 'Etc/Unknown'

describe('the premise: the two consumers disagree on the host zone TZ="" yields', () => {
  it('Intl rejects it (cron-parser alone would let it through on Node 22)', () => {
    expect(() => new Intl.DateTimeFormat('en-US', { timeZone: UNKNOWN })).toThrow(RangeError)
  })
})

describe('an unusable host zone becomes UTC', () => {
  it('unset SCHEDULER_TZ on an Etc/Unknown host -> UTC', () => {
    expect(resolveAppTz(undefined, UNKNOWN)).toEqual({ tz: 'UTC' })
    expect(resolveAppTz('', UNKNOWN)).toEqual({ tz: 'UTC' })
  })

  it('an empty host zone -> UTC', () => {
    expect(resolveAppTz(undefined, '')).toEqual({ tz: 'UTC' })
    expect(usableHostTz('')).toBe('UTC')
  })

  it('a rejected SCHEDULER_TZ on such a host falls back to UTC too, still reporting the rejected value', () => {
    expect(resolveAppTz('Europe/Budapesst', UNKNOWN)).toEqual({ tz: 'UTC', invalid: 'Europe/Budapesst' })
  })

  it('a configured zone Intl cannot format with is rejected, even where cron-parser accepts it', () => {
    expect(resolveAppTz(UNKNOWN, 'Europe/Budapest')).toEqual({ tz: 'Europe/Budapest', invalid: UNKNOWN })
  })

  it('a usable host zone is kept as is', () => {
    expect(resolveAppTz(undefined, 'Asia/Tokyo')).toEqual({ tz: 'Asia/Tokyo' })
    expect(usableHostTz('Asia/Tokyo')).toBe('Asia/Tokyo')
  })

  it('whatever comes out, both consumers accept it', () => {
    for (const host of [UNKNOWN, '', 'Asia/Tokyo', 'Bad/Zone']) {
      const { tz } = resolveAppTz(undefined, host)
      expect(() => new Intl.DateTimeFormat('en-US', { timeZone: tz })).not.toThrow()
      expect(() => CronExpressionParser.parse('0 0 * * *', { tz }).next()).not.toThrow()
    }
  })
})

describe('the dashboard import chain loads on such a host', () => {
  afterEach(() => {
    vi.doUnmock('../config.js')
    vi.resetModules()
  })

  async function loadStampWith(appTz: string) {
    vi.resetModules()
    vi.doMock('../config.js', async (orig) => ({ ...(await orig<typeof import('../config.js')>()), APP_TZ: appTz }))
    return import('../web/heartbeat-header-stamp.js')
  }

  it('positive control: with the raw Etc/Unknown as APP_TZ the module throws at load', async () => {
    await expect(loadStampWith(UNKNOWN)).rejects.toThrow(RangeError)
  })

  it('with the APP_TZ config.ts derives from that host, it loads and stamps in UTC', async () => {
    const { stampHeartbeatHeader } = await loadStampWith(resolveAppTz(undefined, UNKNOWN).tz)
    expect(stampHeartbeatHeader('## Heartbeat 2026-09-08 18:00', new Date('2026-09-08T13:00:28Z')))
      .toBe('## Heartbeat 2026-09-08 13:00')
  })
})

describe('the startup report names the zone in effect, not the refused one', () => {
  afterEach(() => vi.restoreAllMocks())

  it('effectiveCronTz on an Etc/Unknown host reports UTC (so the UTC-fallback warning can fire)', async () => {
    const { effectiveCronTz } = await import('../web/cron.js')
    const real = Intl.DateTimeFormat.prototype.resolvedOptions
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(function (this: Intl.DateTimeFormat) {
      return { ...real.call(this), timeZone: UNKNOWN }
    })
    const r = effectiveCronTz()
    if (r.source === 'SCHEDULER_TZ') return // a pinned zone on this checkout: the host zone is not consulted
    expect(r.tz).toBe('UTC')
  })
})

describe('a real process started with TZ="" (the reported repro)', () => {
  // Subprocess on purpose: whether cron-parser accepts "Etc/Unknown" depends on
  // the PROCESS zone (measured on Node 22: rejected in a normal environment,
  // accepted under TZ=""). Only under TZ="" do the two consumers disagree, so
  // only there does a cron-only probe let the zone through. The config chain
  // and the module-load formatter are the real ones, with no mock in the path.
  const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..')
  const src = (p: string) => JSON.stringify(join(ROOT, 'src', p))
  const script = `
    const { CronExpressionParser } = await import('cron-parser')
    const raw = Intl.DateTimeFormat().resolvedOptions().timeZone
    const ok = (f) => { try { f(); return true } catch { return false } }
    const cfg = await import(${src('config.ts')})
    let loaded = true
    try { await import(${src('web/heartbeat-header-stamp.ts')}) } catch { loaded = false }
    const { effectiveCronTz } = await import(${src('web/cron.ts')})
    console.log(JSON.stringify({
      raw,
      cronAcceptsRaw: ok(() => CronExpressionParser.parse('0 0 * * *', { tz: raw }).next()),
      intlAcceptsRaw: ok(() => new Intl.DateTimeFormat('en-US', { timeZone: raw })),
      pinned: cfg.SCHEDULER_TZ_CONFIGURED ?? null,
      appTz: cfg.APP_TZ,
      loaded,
      reported: effectiveCronTz().tz,
      configuredRawHost: cfg.resolveAppTz(raw, 'Europe/Budapest'),
    }))
  `
  const out = JSON.parse(execFileSync(join(ROOT, 'node_modules', '.bin', 'tsx'), ['-e', `(async () => { ${script} })()`], {
    env: { ...process.env, TZ: '' }, encoding: 'utf-8', timeout: 30_000, cwd: ROOT,
  }).trim().split('\n').pop()!)

  it('premise: the host zone is one cron-parser accepts and Intl rejects', () => {
    expect(out.intlAcceptsRaw).toBe(false)
    expect(out.cronAcceptsRaw).toBe(true)
  })

  it('the stamp module (dashboard import chain) loads', () => {
    expect(out.loaded).toBe(true)
  })

  it('APP_TZ and the startup report are UTC, unless this checkout pins a zone', () => {
    if (out.pinned) return
    expect(out.appTz).toBe('UTC')
    expect(out.reported).toBe('UTC')
  })

  it('that zone configured as SCHEDULER_TZ is rejected too', () => {
    expect(out.configuredRawHost).toEqual({ tz: 'Europe/Budapest', invalid: out.raw })
  })
})
