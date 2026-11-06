// GROMZOLINKCONFIRM1106: the Gromzo card's status line. On 2026-11-06 the owner typed a link code on a VPS, the card
// said only "not linked yet", and nothing said that the link waits for a confirmation on gromzo.com within 15
// minutes. gromzoStatusLine (web/app.js) picks the line from GET /api/gromzo/status; these cases run the shipped
// function itself, and check that every line it can pick exists in both languages.
import { describe, it, expect } from 'vitest'
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
