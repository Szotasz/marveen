// Overview -> subscription quota: the weekly bar is split into the 7 days of
// the CURRENT window, with day names underneath and a "now" marker (Tom,
// 2026-09-29, kanban a646a038). The window is not a calendar week: it ends at
// resetsAt and began 7 days earlier (measured: Monday 09:00 CEST for both the
// previous and the current window), so a Monday-first hard-code would be
// right today only by coincidence. Evaluated from web/app.js, not a copy.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(__dirname, '../../web/app.js'), 'utf-8')
const CSS = readFileSync(join(__dirname, '../../web/style.css'), 'utf-8')

function extractFn(name: string): string {
  const re = new RegExp(`(?:async )?function ${name}\\s*\\([^)]*\\)\\s*\\{`)
  const m = re.exec(APP)
  if (!m) throw new Error(`${name} missing from web/app.js`)
  let depth = 0
  for (let j = APP.indexOf('{', m.index); j < APP.length; j++) {
    if (APP[j] === '{') depth++
    else if (APP[j] === '}' && --depth === 0) return APP.slice(m.index, j + 1)
  }
  throw new Error(`${name}: unbalanced braces`)
}

type Week = { starts: number[]; labels: string[]; shortLabels: string[]; narrowLabels: string[]; nowPct: number } | null
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const weekSegments = new Function(`${extractFn('weekSegments')}; return weekSegments`)() as (
  resetsAt: unknown, nowSec: unknown, lang: string, timeZone?: string,
) => Week

const TZ = 'Europe/Budapest'
// The live reading of 2026-09-29: resets Monday 2026-10-05 09:00 CEST.
const MONDAY_RESET = 1791183600
// Tuesday 2026-09-29 23:17 CEST = 21:17 UTC.
const TUE_2317 = Date.UTC(2026, 8, 29, 21, 17) / 1000

const localHm = (sec: number) =>
  new Date(sec * 1000).toLocaleTimeString('hu-HU', { timeZone: TZ, hour: '2-digit', minute: '2-digit' })

describe('weekSegments', () => {
  it('Monday reset: Hétfő..Vasárnap, every boundary at 09:00', () => {
    const w = weekSegments(MONDAY_RESET, TUE_2317, 'hu', TZ)!
    expect(w.labels).toEqual(['Hétfő', 'Kedd', 'Szerda', 'Csütörtök', 'Péntek', 'Szombat', 'Vasárnap'])
    expect(w.starts.map(localHm)).toEqual(Array(7).fill('09:00'))
  })

  it('Thursday reset: the labels follow the window, not the calendar', () => {
    const thuReset = MONDAY_RESET - 4 * 86400 // Thursday 2026-10-01 09:00
    const w = weekSegments(thuReset, TUE_2317, 'hu', TZ)!
    expect(w.labels).toEqual(['Csütörtök', 'Péntek', 'Szombat', 'Vasárnap', 'Hétfő', 'Kedd', 'Szerda'])
  })

  it('English day names', () => {
    expect(weekSegments(MONDAY_RESET, TUE_2317, 'en', TZ)!.labels)
      .toEqual(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'])
  })

  it('short and narrow labels: hu H K Sze Cs P Szo V (never a bare "Sz"), en Mon..Sun / M T W T F S S', () => {
    const hu = weekSegments(MONDAY_RESET, TUE_2317, 'hu', TZ)!
    expect(hu.shortLabels).toEqual(['H', 'K', 'Sze', 'Cs', 'P', 'Szo', 'V'])
    expect(hu.narrowLabels).toEqual(hu.shortLabels)
    expect(new Set(hu.narrowLabels).size).toBe(7)
    const en = weekSegments(MONDAY_RESET, TUE_2317, 'en', TZ)!
    expect(en.shortLabels).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'])
    expect(en.narrowLabels).toEqual(['M', 'T', 'W', 'T', 'F', 'S', 'S'])
    // a Thursday window keeps the short forms in window order too
    expect(weekSegments(MONDAY_RESET - 4 * 86400, TUE_2317, 'hu', TZ)!.shortLabels)
      .toEqual(['Cs', 'P', 'Szo', 'V', 'H', 'K', 'Sze'])
  })

  it('now marker: Tuesday 23:17 is 1d 14h 17m into the window, ~22.8%', () => {
    const w = weekSegments(MONDAY_RESET, TUE_2317, 'hu', TZ)!
    const expected = ((TUE_2317 - (MONDAY_RESET - 7 * 86400)) / (7 * 86400)) * 100
    expect(w.nowPct).toBeCloseTo(expected, 6)
    expect(w.nowPct).toBeCloseTo(22.8, 1)
  })

  it('no usable window -> null (the row keeps the plain bar)', () => {
    for (const bad of [null, undefined, NaN, Infinity, '1791183600', {}]) {
      expect(weekSegments(bad, TUE_2317, 'hu', TZ)).toBeNull()
    }
    expect(weekSegments(TUE_2317 - 1, TUE_2317, 'hu', TZ)).toBeNull() // already reset
    expect(weekSegments(TUE_2317 + 8 * 86400, TUE_2317, 'hu', TZ)).toBeNull() // window not started
  })
})

// The rendered row, with the DOM and helpers stubbed: the week pieces appear on
// the weekly row only, and a missing resetsAt leaves the old bar untouched.
function render(quota: Record<string, unknown>): string[] {
  const els: Record<string, { hidden: boolean; innerHTML: string; textContent: string; className: string; children: string[]; appendChild: (c: { innerHTML: string }) => void }> = {}
  for (const id of ['quotaStrip', 'quotaBars', 'quotaStripNote', 'quotaStripAge']) {
    const el = { hidden: true, innerHTML: '', textContent: '', className: '', children: [] as string[],
      appendChild(c: { innerHTML: string }) { this.children.push(c.innerHTML) } }
    els[id] = el
  }
  const document = { getElementById: (id: string) => els[id], createElement: () => ({ className: '', innerHTML: '' }) }
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = new Function('document', 'window', 't', 'escapeHtml', 'formatDurationShort', 'formatRelative',
    `${extractFn('quotaLevelClass')}; ${extractFn('quotaMeasuredText')}; ${extractFn('weekSegments')}; ${extractFn('renderQuotaStrip')}; return renderQuotaStrip`,
  )(document, { _lang: 'hu' }, (k: string) => k, (s: string) => String(s), () => '1n', () => 'most')
  fn(quota, null)
  return els.quotaBars.children
}

// The portrait-phone fix: the day row must never fall back to an ellipsis
// ("Hé… Ke… Sz…"); it swaps to shorter names by its own width instead.
function daysCss(): string {
  const from = CSS.indexOf('.quota-bar-days {')
  const to = CSS.indexOf('.quota-bar-fill {', from)
  if (from < 0 || to < 0) throw new Error('.quota-bar-days rules missing from web/style.css')
  return CSS.slice(from, to)
}

describe('day-name CSS', () => {
  it('no ellipsis anywhere in the day-name rules', () => {
    expect(daysCss()).not.toMatch(/text-overflow/)
  })
  it('the label row is a size container and swaps full -> short -> narrow by its width', () => {
    const css = daysCss()
    expect(css).toMatch(/container-type:\s*inline-size/)
    const block = (w: number) => {
      const i = css.indexOf(`@container quota-days (max-width: ${w}px) {`)
      if (i < 0) throw new Error(`no ${w}px container rule`)
      return css.slice(i, css.indexOf('\n}', i))
    }
    expect(block(440)).toContain('.day-full { display: none; }')
    expect(block(440)).toContain('.day-short { display: inline; }')
    expect(block(180)).toContain('.day-short { display: none; }')
    expect(block(180)).toContain('.day-narrow { display: inline; }')
    expect(css).toMatch(/\.day-short,\s*\.quota-bar-days \.day-narrow \{ display: none; \}/)
  })
})

describe('renderQuotaStrip weekly row', () => {
  const now = Math.floor(Date.now() / 1000)
  const reset = now + 3 * 86400

  it('weekly row gets separators, 7 day names and a now marker; 5-hour row does not', () => {
    const [five, week] = render({ status: 'ok', ageSec: 5,
      fiveHour: { usedPercentage: 26, resetsAt: now + 3600 },
      sevenDay: { usedPercentage: 34, resetsAt: reset } })
    expect(week).toContain('quota-bar-track week')
    expect(week).toContain('class="quota-bar-now"')
    expect((week.match(/<span>/g) || []).length).toBe(7)
    expect(week).toContain('<span class="day-full">Hétfő</span><span class="day-short">H</span><span class="day-narrow">H</span>')
    expect(week).toContain('<span class="day-full">Szerda</span><span class="day-short">Sze</span>')
    expect(five).not.toContain('quota-bar-days')
    expect(five).not.toContain('quota-bar-now')
  })

  it('missing / null resetsAt: plain bar, no division, no marker', () => {
    for (const sevenDay of [{ usedPercentage: 34 }, { usedPercentage: 34, resetsAt: null }]) {
      const [week] = render({ status: 'ok', ageSec: 5, sevenDay })
      expect(week).toContain('class="quota-bar-track"')
      expect(week).toContain('width:34%')
      expect(week).not.toContain('quota-bar-days')
      expect(week).not.toContain('quota-bar-now')
      expect(week).not.toContain('track week')
    }
  })

  it('expired window: plain bar, no division, no marker', () => {
    const [week] = render({ status: 'ok', ageSec: 5, sevenDay: { usedPercentage: 90, resetsAt: reset, expired: true } })
    expect(week).not.toContain('quota-bar-days')
    expect(week).not.toContain('quota-bar-now')
  })
})
