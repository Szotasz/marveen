import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chooseQuotaSnapshot, readModQuotaSnapshot, type QuotaSnapshot } from '../web/quota.js'

// QUOTAMOD1005: the overview quota strip reads the agent-state-observer mod's
// rate-limit readings when the statusLine block never arrives (setup token).

const NOW = 1_791_200_000
const iso = (sec: number) => new Date(sec * 1000).toISOString()

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'quota-mod-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function source(agent: string, limits: unknown[], aliveAgoSec = 30) {
  writeFileSync(join(dir, `${agent}.json`), JSON.stringify({
    agent, alive_at: (NOW - aliveAgoSec) * 1000, usage: { rateLimits: limits },
  }))
}
const five = (pct: number, resetSec = NOW + 3600) => ({ kind: 'five_hour', percentUsed: pct, resetsAt: iso(resetSec) })
const week = (pct: number, resetSec = NOW + 4 * 86400) => ({ kind: 'seven_day', percentUsed: pct, resetsAt: iso(resetSec) })

describe('readModQuotaSnapshot', () => {
  it('reads both windows and names the source agent', () => {
    source('alpha', [five(12), week(30)])
    const q = readModQuotaSnapshot(dir, NOW)
    expect(q.status).toBe('ok')
    expect(q.source).toBe('mod')
    expect(q.sourceAgent).toBe('alpha')
    expect(q.fiveHour).toEqual({ usedPercentage: 12, resetsAt: NOW + 3600, expired: false })
    expect(q.sevenDay?.usedPercentage).toBe(30)
    expect(q.ageSec).toBe(30)
  })

  it('takes the highest reading of the latest window, whatever order the files come in', () => {
    source('a-idle', [week(26)])
    source('z-busy', [week(72)])
    const q = readModQuotaSnapshot(dir, NOW)
    expect(q.sevenDay?.usedPercentage).toBe(72)
    expect(q.sourceAgent).toBe('z-busy')
  })

  it('a later window beats a higher reading of an earlier one', () => {
    source('old', [week(90, NOW + 3600)])
    source('new', [week(5, NOW + 7 * 86400)])
    expect(readModQuotaSnapshot(dir, NOW).sevenDay?.usedPercentage).toBe(5)
  })

  it('drops a reading whose window has already reset', () => {
    source('alpha', [five(99, NOW - 60), week(20)])
    const q = readModQuotaSnapshot(dir, NOW)
    expect(q.fiveHour).toBeNull()
    expect(q.sevenDay?.usedPercentage).toBe(20)
  })

  it('a missing five_hour is "no window open", not a failure', () => {
    source('alpha', [week(20)])
    const q = readModQuotaSnapshot(dir, NOW)
    expect(q.status).toBe('ok')
    expect(q.fiveHour).toBeNull()
  })

  it('a stale source is marked stale, not dropped', () => {
    source('alpha', [week(20)], 30_000)
    expect(readModQuotaSnapshot(dir, NOW, 21600).status).toBe('stale')
  })

  it('no state files at all -> missing / no-file; files without readings -> no-rate-limits', () => {
    expect(readModQuotaSnapshot(join(dir, 'nope'), NOW)).toMatchObject({ status: 'missing', reason: 'no-file' })
    expect(readModQuotaSnapshot(dir, NOW)).toMatchObject({ status: 'missing', reason: 'no-file' })
    source('alpha', [])
    expect(readModQuotaSnapshot(dir, NOW)).toMatchObject({ status: 'missing', reason: 'no-rate-limits' })
  })

  it('skips a half-written file instead of failing the render', () => {
    writeFileSync(join(dir, 'torn.json'), '{"agent":"torn","alive')
    source('alpha', [week(20)])
    expect(readModQuotaSnapshot(dir, NOW).sevenDay?.usedPercentage).toBe(20)
  })
})

describe('chooseQuotaSnapshot', () => {
  const missing = (reason: QuotaSnapshot['reason']): QuotaSnapshot =>
    ({ status: 'missing', reason, ageSec: null, maxAgeSec: 21600, fiveHour: null, sevenDay: null })
  const reading = (status: 'ok' | 'stale', ageSec: number, extra: Partial<QuotaSnapshot> = {}): QuotaSnapshot =>
    ({ status, ageSec, maxAgeSec: 21600, fiveHour: null, sevenDay: { usedPercentage: 10, resetsAt: NOW + 9, expired: false }, ...extra })

  it('setup-token install: no statusLine file, the mod reading is shown', () => {
    const mod = reading('ok', 40, { source: 'mod', sourceAgent: 'alpha' })
    expect(chooseQuotaSnapshot(missing('no-file'), mod)).toBe(mod)
  })

  it('a fresh reading beats a stale one, and between two fresh ones the younger wins', () => {
    const mod = reading('ok', 40, { source: 'mod' })
    expect(chooseQuotaSnapshot(reading('stale', 30_000), mod).source).toBe('mod')
    expect(chooseQuotaSnapshot(reading('ok', 10), mod).source).toBe('statusline')
    expect(chooseQuotaSnapshot(reading('ok', 100), mod).source).toBe('mod')
  })

  it('neither source -> no-source (the strip says to turn the mod on)', () => {
    expect(chooseQuotaSnapshot(missing('no-file'), missing('no-file')).reason).toBe('no-source')
  })

  it('an API-key account keeps its own answer', () => {
    expect(chooseQuotaSnapshot(missing('no-rate-limits'), missing('no-file')).reason).toBe('no-rate-limits')
  })
})

describe('the wiring', () => {
  it('the overview route feeds the strip from the chooser over both sources', () => {
    const SRC = readFileSync(join(__dirname, '../web/routes/overview.ts'), 'utf-8')
    expect(SRC).toMatch(/const quota = chooseQuotaSnapshot\(\s*readQuotaSnapshot\(/)
    expect(SRC).toMatch(/readModQuotaSnapshot\(STATE_OBSERVER_STATE_DIR, nowSec, maxAgeSec\)/)
  })

  it('every new strip message exists in both languages', () => {
    for (const lang of ['hu', 'en']) {
      const L = readFileSync(join(__dirname, `../../web/lang/${lang}.js`), 'utf-8')
      for (const key of ['overview.quota.none.no_source', 'overview.quota.source_mod', 'overview.quota.source_statusline']) {
        expect(L, `${lang}: ${key}`).toContain(`'${key}'`)
      }
    }
  })
})
