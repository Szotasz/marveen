// Overview -> subscription quota: the weekly bar is split into the days of
// the CURRENT window, with day names underneath and a "now" marker (Tom,
// 2026-09-29, kanban a646a038). The window is not a calendar week: it ends at
// resetsAt and began 7 days earlier (measured: Monday 09:00 CEST on
// 2026-09-29, Friday 22:00 CEST on 2026-10-20), so a Monday-first hard-code
// would be right only by coincidence. The segments are CALENDAR days cut at
// local midnight (Guido, 2026-10-20): 24 h segments named by their start day
// put Tuesday morning under "Monday" with a Friday 22:00 reset.
// Evaluated from web/app.js, not a copy.
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

type Week = { starts: number[]; widths: number[]; labels: string[]; shortLabels: string[]; narrowLabels: string[] | null; nowPct: number } | null
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

const H = 3600
const pct = (h: number) => (h * H / (7 * 86400)) * 100
// The live reading of 2026-10-20: resets Friday 2026-10-23 22:00 CEST.
const FRIDAY_RESET = 1792785600
// Tuesday 2026-10-20 10:22 CEST = 08:22 UTC.
const TUE_1022 = Date.UTC(2026, 9, 20, 8, 22) / 1000

describe('weekSegments', () => {
  it('Monday 09:00 reset: a 15 h Monday, six whole days cut at midnight, a 9 h Monday', () => {
    const w = weekSegments(MONDAY_RESET, TUE_2317, 'hu', TZ)!
    expect(w.labels).toEqual(['Hétfő', 'Kedd', 'Szerda', 'Csütörtök', 'Péntek', 'Szombat', 'Vasárnap', 'Hétfő'])
    expect(w.starts.map(localHm)).toEqual(['09:00', ...Array(7).fill('00:00')])
    expect(w.widths[0]).toBeCloseTo(pct(15), 6)
    expect(w.widths.slice(1, 7).every((x) => Math.abs(x - pct(24)) < 1e-6)).toBe(true)
    expect(w.widths[7]).toBeCloseTo(pct(9), 6)
    expect(w.widths.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 6)
  })

  it('Friday 22:00 reset (the 2026-10-20 bug): Tuesday 10:22 falls in the Kedd segment, not Hétfő', () => {
    const w = weekSegments(FRIDAY_RESET, TUE_1022, 'hu', TZ)!
    expect(w.labels).toEqual(['Péntek', 'Szombat', 'Vasárnap', 'Hétfő', 'Kedd', 'Szerda', 'Csütörtök', 'Péntek'])
    expect(w.widths[0]).toBeCloseTo(pct(2), 6)
    expect(w.widths[7]).toBeCloseTo(pct(22), 6)
    let left = 0
    let i = 0
    while (left + w.widths[i] <= w.nowPct) left += w.widths[i++]
    expect(w.labels[i]).toBe('Kedd')
    // 10 h 22 m into a 24 h Tuesday
    expect((w.nowPct - left) / w.widths[i]).toBeCloseTo((10 + 22 / 60) / 24, 6)
  })

  it('midnight reset: exactly 7 whole days', () => {
    const midnight = Date.UTC(2026, 9, 22, 22, 0) / 1000 // Friday 2026-10-23 00:00 CEST
    const w = weekSegments(midnight, TUE_1022, 'hu', TZ)!
    expect(w.labels).toEqual(['Péntek', 'Szombat', 'Vasárnap', 'Hétfő', 'Kedd', 'Szerda', 'Csütörtök'])
    expect(w.starts.map(localHm)).toEqual(Array(7).fill('00:00'))
  })

  it('DST end inside the window: Sunday 2026-10-25 is a 25 h segment, every cut still at local midnight', () => {
    const reset = Date.UTC(2026, 9, 30, 21, 0) / 1000 // Friday 2026-10-30 22:00 CET
    const now = Date.UTC(2026, 9, 27, 9, 0) / 1000
    const w = weekSegments(reset, now, 'hu', TZ)!
    expect(w.starts.slice(1).map(localHm)).toEqual(Array(w.starts.length - 1).fill('00:00'))
    expect(w.widths[w.labels.indexOf('Vasárnap')]).toBeCloseTo(pct(25), 6)
    expect(w.widths.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 6)
  })

  it('Thursday reset: the labels follow the window, not the calendar', () => {
    const thuReset = MONDAY_RESET - 4 * 86400 // Thursday 2026-10-01 09:00
    const w = weekSegments(thuReset, TUE_2317, 'hu', TZ)!
    expect(w.labels).toEqual(['Csütörtök', 'Péntek', 'Szombat', 'Vasárnap', 'Hétfő', 'Kedd', 'Szerda', 'Csütörtök'])
  })

  it('English day names', () => {
    expect(weekSegments(MONDAY_RESET, TUE_2317, 'en', TZ)!.labels)
      .toEqual(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday', 'Monday'])
  })

  it('short and narrow labels: hu H K Sze Cs P Szo V and no narrow tier (never a bare "Sz"), en Mon..Sun / M T W T F S S', () => {
    const hu = weekSegments(MONDAY_RESET, TUE_2317, 'hu', TZ)!
    expect(hu.shortLabels).toEqual(['H', 'K', 'Sze', 'Cs', 'P', 'Szo', 'V', 'H'])
    expect(new Set(hu.shortLabels).size).toBe(7)
    expect(hu.narrowLabels).toBeNull()
    const en = weekSegments(MONDAY_RESET, TUE_2317, 'en', TZ)!
    expect(en.shortLabels).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun', 'Mon'])
    expect(en.narrowLabels).toEqual(['M', 'T', 'W', 'T', 'F', 'S', 'S', 'M'])
    // a Thursday window keeps the short forms in window order too
    expect(weekSegments(MONDAY_RESET - 4 * 86400, TUE_2317, 'hu', TZ)!.shortLabels)
      .toEqual(['Cs', 'P', 'Szo', 'V', 'H', 'K', 'Sze', 'Cs'])
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
function render(quota: Record<string, unknown>, lang = 'hu'): string[] {
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
  )(document, { _lang: lang }, (k: string) => k, (s: string) => String(s), () => '1n', () => 'most')
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
    // hu has no narrow form: below 180 px its whole day-name row hides
    expect(block(180)).toContain('.quota-bar-days.no-narrow > span { display: none; }')
    expect(css).toMatch(/\.day-short,\s*\.quota-bar-days \.day-narrow \{ display: none; \}/)
  })
})

describe('renderQuotaStrip weekly row', () => {
  const now = Math.floor(Date.now() / 1000)
  const reset = now + 3 * 86400

  it('weekly row gets separators, each weekday named once and a now marker; 5-hour row does not', () => {
    const [five, week] = render({ status: 'ok', ageSec: 5,
      fiveHour: { usedPercentage: 26, resetsAt: now + 3600 },
      sevenDay: { usedPercentage: 34, resetsAt: reset } })
    expect(week).toContain('quota-bar-track week')
    expect(week).toContain('class="quota-bar-now"')
    // 7 or 8 calendar-day columns; the partial first and last day share one
    // weekday and only the one of at least half a day is named
    const cols = (week.match(/<span>/g) || []).length // labelled and empty columns alike
    expect([7, 8]).toContain(cols)
    expect((week.match(/class="quota-bar-sep"/g) || []).length).toBe(cols - 1)
    expect(week).toMatch(/grid-template-columns:[\d.]+fr( [\d.]+fr){6,7}"/)
    expect([7, 8]).toContain((week.match(/class="day-full"/g) || []).length)
    expect(week).toContain('<span class="day-full">Hétfő</span><span class="day-short">H</span></span>')
    expect(week).toContain('<span class="day-full">Szerda</span><span class="day-short">Sze</span>')
    expect(five).not.toContain('quota-bar-days')
    expect(five).not.toContain('quota-bar-now')
  })

  // Szotasz's review of #1703: at 390 px the hu short forms (~140 px) ran
  // together in a ~100 px track ("SzeCs"), at 320 px they spilled under the
  // value. hu therefore has no narrow tier: the row is marked no-narrow (the
  // 180 px container rule hides it) and carries no day-narrow spans that
  // could show instead. The track, separators and now marker stay.
  it('hu narrow tier: day row marked no-narrow, no day-narrow spans; separators and marker stay', () => {
    const [, week] = render({ status: 'ok', ageSec: 5,
      fiveHour: { usedPercentage: 26, resetsAt: now + 3600 },
      sevenDay: { usedPercentage: 34, resetsAt: reset } }, 'hu')
    expect(week).toContain('class="quota-bar-days no-narrow"')
    expect(week).not.toContain('day-narrow')
    expect(week).toContain('quota-bar-track week')
    expect(week).toContain('class="quota-bar-now"')
  })

  it('en narrow tier: day row NOT marked no-narrow, one-letter day-narrow spans', () => {
    const [, week] = render({ status: 'ok', ageSec: 5,
      fiveHour: { usedPercentage: 26, resetsAt: now + 3600 },
      sevenDay: { usedPercentage: 34, resetsAt: reset } }, 'en')
    expect(week).toContain('class="quota-bar-days"')
    expect(week).not.toContain('no-narrow')
    expect([7, 8]).toContain((week.match(/class="day-narrow">[A-Z]<\/span>/g) || []).length)
  })

  it('missing / null resetsAt: plain bar, no division, no marker', () => {
    for (const sevenDay of [{ usedPercentage: 34 }, { usedPercentage: 34, resetsAt: null }]) {
      const [week] = render({ status: 'ok', ageSec: 5, sevenDay })
      expect(week).toContain('class="quota-bar-track"')
      expect(week).toContain('width:34%')
      expect(week).not.toContain('quota-bar-days')
      expect(week).not.toContain('quota-bar-now')
      expect(week).not.toContain('track week')
      expect(week).not.toContain('quota-bar-sep')
    }
  })

  it('expired window: plain bar, no division, no marker', () => {
    const [week] = render({ status: 'ok', ageSec: 5, sevenDay: { usedPercentage: 90, resetsAt: reset, expired: true } })
    expect(week).not.toContain('quota-bar-days')
    expect(week).not.toContain('quota-bar-now')
  })
})
