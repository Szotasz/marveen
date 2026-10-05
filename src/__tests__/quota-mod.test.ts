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

// A mod state file. By default an idle agent whose last turn completed
// `turnAgoSec` ago; its alive_at keeps ticking regardless (aliveAgoSec).
function source(agent: string, limits: unknown[], o: {
  turnAgoSec?: number | null; aliveAgoSec?: number; state?: string; updatedAgoSec?: number; history?: unknown[]
} = {}) {
  const turnAgo = o.turnAgoSec === undefined ? 30 : o.turnAgoSec
  const history = o.history ?? (turnAgo === null ? [{ ts: (NOW - 999) * 1000, from: 'starting', to: 'idle', reason: 'session.start' }]
    : [{ ts: (NOW - turnAgo) * 1000, from: 'working', to: 'idle', reason: 'turn.complete:answer' }])
  writeFileSync(join(dir, `${agent}.json`), JSON.stringify({
    agent, state: o.state ?? 'idle', alive_at: (NOW - (o.aliveAgoSec ?? 5)) * 1000,
    updated_at: (NOW - (o.updatedAgoSec ?? o.aliveAgoSec ?? 5)) * 1000, history, usage: { rateLimits: limits },
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
    expect(q.sourceAgents).toEqual(['alpha'])
    expect(q.fiveHour).toEqual({ usedPercentage: 12, resetsAt: NOW + 3600, expired: false, sourceAgent: 'alpha' })
    expect(q.sevenDay?.usedPercentage).toBe(30)
    expect(q.ageSec).toBe(30)
  })

  it('takes the highest reading of the latest window, whatever order the files come in', () => {
    source('a-idle', [week(26)])
    source('z-busy', [week(72)])
    const q = readModQuotaSnapshot(dir, NOW)
    expect(q.sevenDay?.usedPercentage).toBe(72)
    expect(q.sevenDay?.sourceAgent).toBe('z-busy')
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

  it('each window names its own agent (Geri #1693: the 5-hour reading is not labelled with the weekly one)', () => {
    source('samu', [five(91), week(10)])
    source('dani', [week(44)])
    const q = readModQuotaSnapshot(dir, NOW)
    expect(q.fiveHour?.sourceAgent).toBe('samu')
    expect(q.sevenDay?.sourceAgent).toBe('dani')
    expect(q.sourceAgents?.sort()).toEqual(['dani', 'samu'])
  })

  it('the age is that of the NUMBERS (last turn), not of the ticking alive_at', () => {
    source('alpha', [week(20)], { turnAgoSec: 3 * 3600, aliveAgoSec: 10 })
    const q = readModQuotaSnapshot(dir, NOW, 21600)
    expect(q.ageSec).toBe(3 * 3600)
    expect(q.status).toBe('ok')
    source('alpha', [week(20)], { turnAgoSec: 8 * 3600, aliveAgoSec: 10 })
    expect(readModQuotaSnapshot(dir, NOW, 21600).status).toBe('stale')
  })

  it('a working agent counts from its last event (updated_at), not the minute tick', () => {
    source('alpha', [week(20)], { turnAgoSec: 8 * 3600, aliveAgoSec: 7, updatedAgoSec: 7, state: 'working' })
    expect(readModQuotaSnapshot(dir, NOW, 21600)).toMatchObject({ ageSec: 7, status: 'ok' })
    // inside a 27-minute tool call: alive_at ticks, the last event is 27 minutes old
    source('alpha', [week(20)], { aliveAgoSec: 20, updatedAgoSec: 27 * 60, state: 'working' })
    expect(readModQuotaSnapshot(dir, NOW, 21600).ageSec).toBe(27 * 60)
  })

  it('a session parked on an approval prompt for 3 hours is NOT "just now" (Geri #1693)', () => {
    source('zara', [week(20)], { aliveAgoSec: 20, updatedAgoSec: 3 * 3600, state: 'awaiting_approval' })
    expect(readModQuotaSnapshot(dir, NOW, 21600).ageSec).toBe(3 * 3600)
  })

  it('the LAST completed turn counts, not the first', () => {
    source('alpha', [week(20)], { history: [
      { ts: (NOW - 7200) * 1000, from: 'working', to: 'idle', reason: 'turn.complete:answer' },
      { ts: (NOW - 7100) * 1000, from: 'idle', to: 'working', reason: 'turn.start' },
      { ts: (NOW - 600) * 1000, from: 'working', to: 'idle', reason: 'turn.complete:answer' },
    ] })
    expect(readModQuotaSnapshot(dir, NOW).ageSec).toBe(600)
  })

  it('if ANY chosen window has an unknown age, the snapshot age is unknown (stale)', () => {
    source('samu', [five(50)], { turnAgoSec: 60 })
    source('dani', [week(40)], { turnAgoSec: null })
    const q = readModQuotaSnapshot(dir, NOW)
    expect(q.ageSec).toBeNull()
    expect(q.status).toBe('stale')
  })

  it('no completed turn since the session started: unknown age, stale', () => {
    source('alpha', [week(20)], { turnAgoSec: null })
    const q = readModQuotaSnapshot(dir, NOW)
    expect(q.ageSec).toBeNull()
    expect(q.status).toBe('stale')
  })

  it('the age is the OLDEST among the chosen windows', () => {
    source('samu', [five(50)], { turnAgoSec: 60 })
    source('dani', [week(40)], { turnAgoSec: 7200 })
    expect(readModQuotaSnapshot(dir, NOW).ageSec).toBe(7200)
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
    const mod = reading('ok', 40, { source: 'mod', sourceAgents: ['alpha'] })
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

  it('the strip uses the source-aware stale text, the per-window agent and the "just now" wording', () => {
    const APP = readFileSync(join(__dirname, '../../web/app.js'), 'utf-8')
    const fn = APP.slice(APP.indexOf('function renderQuotaStrip('), APP.indexOf('async function loadOverview('))
    expect(fn).toMatch(/q\.source === 'mod'\s*\?\s*t\(typeof q\.ageSec === 'number' \? 'overview\.quota\.stale_mod' : 'overview\.quota\.stale_mod_unknown'\)/)
    expect(fn).toMatch(/q\.source === 'mod' && w\.sourceAgent/)
    expect(fn).toMatch(/source_mod_many/)
    expect(fn).not.toMatch(/t\('overview\.quota\.measured', \{ age/)
    expect(APP).toMatch(/if \(ageSec < 60\) return t\('overview\.quota\.measured_now'\)/)
  })

  it('every new strip message exists in both languages', () => {
    for (const lang of ['hu', 'en']) {
      const L = readFileSync(join(__dirname, `../../web/lang/${lang}.js`), 'utf-8')
      for (const key of ['overview.quota.none.no_source', 'overview.quota.source_mod', 'overview.quota.source_statusline',
        'overview.quota.source_mod_many', 'overview.quota.measured_now', 'overview.quota.stale_mod', 'overview.quota.stale_mod_unknown']) {
        expect(L, `${lang}: ${key}`).toContain(`'${key}'`)
      }
    }
  })
})
