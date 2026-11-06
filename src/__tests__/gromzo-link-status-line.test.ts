// GROMZOLINKCONFIRM1106: the Gromzo card's status line. On 2026-11-06 the owner typed a link code on a VPS, the card
// said only "not linked yet", and nothing said that the link waits for a confirmation on gromzo.com within 15
// minutes. gromzoStatusLine (web/app.js) picks the line from GET /api/gromzo/status; these cases run the shipped
// function itself, and check that every line it can pick exists in both languages.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const APP = readFileSync(join(__dirname, '../../web/app.js'), 'utf-8')
const HU = readFileSync(join(__dirname, '../../web/lang/hu.js'), 'utf-8')
const EN = readFileSync(join(__dirname, '../../web/lang/en.js'), 'utf-8')

type Line = { key: string; params?: Record<string, string>; until?: number }
function chooser(): (s: unknown, nowMs: number) => Line {
  const kinds = APP.match(/^const GROMZO_LINK_REFUSAL_KINDS = \[[^\n]*\]$/m)
  const fn = APP.match(/^function gromzoStatusLine\(s, nowMs\) \{[\s\S]*?\n\}$/m)
  // A missing piece must fail the test, not quietly produce a stub.
  if (!kinds || !fn) throw new Error('gromzoStatusLine not found in web/app.js')
  return new Function(`${kinds[0]}\n${fn[0]}\nreturn gromzoStatusLine`)() as (s: unknown, nowMs: number) => Line
}
const line = chooser()
const NOW = Date.UTC(2026, 10, 6, 8, 24, 12)
const UP = { available: true, running: true }

describe('gromzoStatusLine', () => {
  it('a link waiting for confirmation: the confirm line, with the deadline from the seconds left', () => {
    expect(line({ ...UP, linked: false, linkPendingExpiresIn: 900 }, NOW)).toEqual({ key: 'gromzo.status.link_pending', until: NOW + 900_000 })
  })
  it('a pending link with no time left reads as expired', () => {
    expect(line({ ...UP, linked: false, linkPendingExpiresIn: 0 }, NOW)).toEqual({ key: 'gromzo.status.link_expired' })
  })
  it('each known refusal has its own line; an unknown one names its kind', () => {
    for (const k of ['expired', 'refused', 'owner_mismatch', 'not_found']) {
      expect(line({ ...UP, linked: false, linkRefusal: k }, NOW)).toEqual({ key: `gromzo.status.link_${k}` })
    }
    expect(line({ ...UP, linked: false, linkRefusal: 'forged' }, NOW)).toEqual({ key: 'gromzo.status.link_failed', params: { kind: 'forged' } })
  })
  it('a new pending request wins over an older refusal', () => {
    expect(line({ ...UP, linked: false, linkPendingExpiresIn: 300, linkRefusal: 'expired' }, NOW).key).toBe('gromzo.status.link_pending')
  })
  it('linked wins over everything; nothing extra is the plain not-linked line', () => {
    expect(line({ ...UP, linked: true, linkPendingExpiresIn: 300, linkRefusal: 'expired' }, NOW)).toEqual({ key: 'gromzo.status.linked' })
    expect(line({ ...UP, linked: false }, NOW)).toEqual({ key: 'gromzo.status.not_linked' })
  })
  it('unavailable: not running, or the code', () => {
    expect(line({ available: false, code: 'not_running' }, NOW)).toEqual({ key: 'gromzo.status.not_running' })
    expect(line({ available: false, code: 'forbidden' }, NOW)).toEqual({ key: 'gromzo.status.unknown', params: { code: 'forbidden' } })
  })
})

describe('the lines exist in both languages', () => {
  const keys = ['link_pending', 'link_expired', 'link_refused', 'link_owner_mismatch', 'link_not_found', 'link_failed']
  it.each(keys)('%s is in hu.js and en.js, with the same placeholders', (k) => {
    const re = new RegExp(`'gromzo\\.status\\.${k}': '((?:[^'\\\\]|\\\\.)*)'`)
    const hu = HU.match(re)?.[1]
    const en = EN.match(re)?.[1]
    expect(hu, `hu ${k}`).toBeTruthy()
    expect(en, `en ${k}`).toBeTruthy()
    const ph = (x: string) => (x.match(/\{[a-z]+\}/g) ?? []).sort()
    expect(ph(hu!)).toEqual(ph(en!))
  })
  it('the pending line names the mail subject, the button and the deadline in both', () => {
    for (const src of [HU, EN]) {
      const t = src.match(/'gromzo\.status\.link_pending': '((?:[^'\\]|\\.)*)'/)?.[1] ?? ''
      expect(t).toContain('Erősítsd meg: Marveen összekötése a fiókoddal')
      expect(t).toContain('gromzo.com')
      expect(t).toContain('{until}')
    }
  })
})

// Dani's #2555 review: nothing pinned the 15 s re-read (removing it left every test green), and the deadline was
// formatted hu-HU in the English text too. Both now run from the shipped functions.
function shipped(): { untilText: (ms: number, lang: string) => string, schedule: (c: () => boolean, r: () => void, setT: typeof setTimeout) => unknown, ms: number } {
  const ms = APP.match(/^const GROMZO_STATUS_REFRESH_MS = \d+$/m)
  const until = APP.match(/^function gromzoUntilText\(untilMs, lang\) \{[\s\S]*?\n\}$/m)
  const sched = APP.match(/^function gromzoScheduleStatusRefresh\(isConnected, reload, setT\) \{[\s\S]*?\n\}$/m)
  if (!ms || !until || !sched) throw new Error('the status-refresh helpers are not in web/app.js')
  return new Function(`${ms[0]}\n${until[0]}\n${sched[0]}\nreturn { untilText: gromzoUntilText, schedule: gromzoScheduleStatusRefresh, ms: GROMZO_STATUS_REFRESH_MS }`)()
}

describe('the pending link: its deadline and its re-read', () => {
  const h = shipped()
  afterEach(() => { vi.useRealTimers() })

  it('reads the status again after 15 s, once, while the card is on the page', () => {
    vi.useFakeTimers()
    const reload = vi.fn()
    h.schedule(() => true, reload, setTimeout)
    vi.advanceTimersByTime(14_999)
    expect(reload).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(reload).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(60_000)
    expect(reload).toHaveBeenCalledTimes(1)
    expect(h.ms).toBe(15_000)
  })

  it('a card that left the page is not read again', () => {
    vi.useFakeTimers()
    const reload = vi.fn()
    h.schedule(() => false, reload, setTimeout)
    vi.advanceTimersByTime(15_000)
    expect(reload).not.toHaveBeenCalled()
  })

  it('the pending branch of loadStatus uses both helpers, and clears a running timer first', () => {
    // The Gromzo card's loadStatus (app.js has more than one): the one right after its own refresh handle.
    const at = APP.indexOf('async function loadStatus() {', APP.indexOf('  let statusRefresh = null\n'))
    expect(APP.indexOf('  let statusRefresh = null\n')).toBeGreaterThan(-1)
    const fn = APP.slice(at, at + 1200)
    expect(fn).toContain('if (statusRefresh) { clearTimeout(statusRefresh); statusRefresh = null }')
    expect(fn).toContain("t(line.key, { until: gromzoUntilText(line.until, window._lang) })")
    expect(fn).toContain('statusRefresh = gromzoScheduleStatusRefresh(() => statusEl.isConnected, () => { statusRefresh = null; loadStatus() }, setTimeout)')
  })

  // Measured 2026-11-06: for hour:minute hu-HU and en-GB print the same ("00:05", "14:05"), so the language switch
  // changes no visible output; what this pins is that English never turns into a 12-hour en-US clock ("02:05 PM").
  it('the deadline is a 24-hour clock in the UI language: hu-HU in Hungarian, en-GB in English', () => {
    const at = new Date(2026, 10, 6, 14, 5, 0).getTime()
    expect(h.untilText(at, 'hu')).toBe(new Date(at).toLocaleTimeString('hu-HU', { hour: '2-digit', minute: '2-digit' }))
    expect(h.untilText(at, 'en')).toBe(new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }))
    expect(h.untilText(at, 'en')).toBe('14:05')
    expect(h.untilText(at, 'en')).not.toMatch(/PM|AM/i)
  })
})
