import { APP_TZ } from './config.js'

const TZ = APP_TZ  // install zone (config.APP_TZ); was hardcoded Europe/Budapest

function todayBudapest(nowSec?: number): string {
  const d = nowSec === undefined ? new Date() : new Date(nowSec * 1000)
  return new Intl.DateTimeFormat('sv-SE', { timeZone: TZ }).format(d)
}

function budapestDate(d: Date): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: TZ }).format(d)
}

function addDays(dateStr: string, days: number): string {
  const ms = new Date(`${dateStr}T12:00:00Z`).getTime() + days * 86_400_000
  return budapestDate(new Date(ms))
}

function dayOfWeekBudapest(dateStr: string): number {
  const d = new Date(`${dateStr}T12:00:00Z`)
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(d)
  const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
  return map[weekday] ?? 0
}

function startOfWeek(dateStr: string): string {
  const dow = dayOfWeekBudapest(dateStr)
  const diff = dow === 0 ? -6 : 1 - dow
  return addDays(dateStr, diff)
}

function startOfMonth(dateStr: string): string {
  return dateStr.slice(0, 8) + '01'
}

function endOfMonth(dateStr: string): string {
  const [y, m] = dateStr.split('-').map(Number)
  const last = new Date(Date.UTC(y, m, 0))
  return budapestDate(last)
}

const HU_MONTHS: Record<string, string> = {
  'januar': '01', 'februar': '02', 'marcius': '03', 'aprilis': '04',
  'majus': '05', 'junius': '06', 'julius': '07', 'augusztus': '08',
  'szeptember': '09', 'oktober': '10', 'november': '11', 'december': '12',
  'jan': '01', 'feb': '02', 'mar': '03', 'apr': '04',
  'maj': '05', 'jun': '06', 'jul': '07', 'aug': '08',
  'szept': '09', 'okt': '10', 'nov': '11', 'dec': '12',
}

const HU_DAYS: Record<string, number> = {
  'hetfo': 1, 'kedd': 2, 'szerda': 3, 'csutortok': 4,
  'pentek': 5, 'szombat': 6, 'vasarnap': 0,
}

export interface DateRange { from: string; to: string }

function stripAccents(s: string): string {
  return s
    .replace(/á/g, 'a').replace(/é/g, 'e').replace(/í/g, 'i')
    .replace(/ó/g, 'o').replace(/ö/g, 'o').replace(/ő/g, 'o')
    .replace(/ú/g, 'u').replace(/ü/g, 'u').replace(/ű/g, 'u')
}

function lastOccurrence(targetDow: number, today: string): string {
  const todayDow = dayOfWeekBudapest(today)
  let diff = todayDow - targetDow
  if (diff <= 0) diff += 7
  return addDays(today, -diff)
}

/**
 * Parses a date expression (today, yesterday, last week, an explicit day or
 * range, ...) into inclusive YYYY-MM-DD bounds on the install-zone calendar.
 * `nowSec` pins "now" for deterministic tests; production callers omit it.
 */
export function parseDateExpr(input: string, nowSec?: number): DateRange | null {
  const raw = input.trim()
  const s = stripAccents(raw.toLowerCase())
  const today = todayBudapest(nowSec)

  if (/^(\d{4})-(\d{2})-(\d{2})$/.test(raw)) {
    return { from: raw, to: raw }
  }

  const rangeMatch = raw.match(/^(\d{4}-\d{2}-\d{2})\s*[-–]\s*(\d{4}-\d{2}-\d{2})$/)
  if (rangeMatch) {
    return { from: rangeMatch[1], to: rangeMatch[2] }
  }

  if (s === 'ma' || s === 'today') return { from: today, to: today }
  if (s === 'tegnap' || s === 'yesterday') {
    const d = addDays(today, -1)
    return { from: d, to: d }
  }
  if (s === 'tegnapelott') {
    const d = addDays(today, -2)
    return { from: d, to: d }
  }

  for (const [name, dow] of Object.entries(HU_DAYS)) {
    if (s === name || s === `mult ${name}` || s === `elozo ${name}`) {
      const d = lastOccurrence(dow, today)
      return { from: d, to: d }
    }
  }

  const daysAgoMatch = s.match(/^(\d+)\s*nap(?:ja|pal?\s+ezelott)?$/)
  if (daysAgoMatch) {
    const d = addDays(today, -parseInt(daysAgoMatch[1], 10))
    return { from: d, to: d }
  }

  const weeksAgoMatch = s.match(/^(\d+)\s*het(?:e|tel?\s+ezelott)?$/)
  if (weeksAgoMatch) {
    const daysBack = parseInt(weeksAgoMatch[1], 10) * 7
    const from = addDays(today, -daysBack)
    const to = addDays(from, 6)
    return { from, to: to > today ? today : to }
  }

  if (s === 'ezen a heten' || s === 'ez a het' || s === 'this week') {
    return { from: startOfWeek(today), to: today }
  }
  if (s === 'mult heten' || s === 'elozo het' || s === 'last week') {
    const lastWeekDay = addDays(today, -7)
    const from = startOfWeek(lastWeekDay)
    return { from, to: addDays(from, 6) }
  }

  if (s === 'ebben a honapban' || s === 'ez a honap' || s === 'this month') {
    return { from: startOfMonth(today), to: today }
  }
  if (s === 'mult honapban' || s === 'elozo honap' || s === 'last month') {
    const prevMonth = addDays(startOfMonth(today), -1)
    return { from: startOfMonth(prevMonth), to: prevMonth }
  }

  const lastNDaysMatch = s.match(/^(?:utolso|elmult)\s+(\d+)\s*nap$/)
  if (lastNDaysMatch) {
    return { from: addDays(today, -parseInt(lastNDaysMatch[1], 10)), to: today }
  }

  for (const [name, num] of Object.entries(HU_MONTHS)) {
    const weekMatch = s.match(new RegExp(`${name}\\s+(elso|masodik|harmadik|negyedik|utolso)\\s+het`))
    if (weekMatch) {
      const year = today.slice(0, 4)
      const monthStart = `${year}-${num}-01`
      const monthEnd = endOfMonth(monthStart)
      const weekMap: Record<string, number> = { elso: 0, masodik: 1, harmadik: 2, negyedik: 3 }
      if (weekMatch[1] === 'utolso') {
        const to = monthEnd
        const from = addDays(to, -6)
        return { from, to }
      }
      const weekIdx = weekMap[weekMatch[1]] ?? 0
      let weekStart = startOfWeek(monthStart)
      if (weekStart < monthStart) weekStart = addDays(weekStart, 7)
      const from = addDays(weekStart, weekIdx * 7)
      const to = addDays(from, 6)
      return { from, to: to > monthEnd ? monthEnd : to }
    }

    const dayMatch = s.match(new RegExp(`${name}\\s+(\\d{1,2})`))
    if (dayMatch) {
      const year = today.slice(0, 4)
      const day = dayMatch[1].padStart(2, '0')
      const d = `${year}-${num}-${day}`
      return { from: d, to: d }
    }

    if (s === name || s === `${name}ban` || s === `${name}ben`) {
      const year = today.slice(0, 4)
      const monthStart = `${year}-${num}-01`
      return { from: monthStart, to: endOfMonth(monthStart) }
    }
  }

  return null
}

/** Unix seconds of the first/last second of a YYYY-MM-DD day in the install zone. */
export function toBudapestTs(dateStr: string, endOfDay: boolean): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: APP_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  })
  const refDate = new Date(`${dateStr}T${endOfDay ? '23:59:59' : '00:00:00'}`)
  const parts = fmt.formatToParts(refDate)
  const get = (t: string) => parts.find(p => p.type === t)?.value || '0'
  const localStr = `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`
  const localMs = new Date(localStr + 'Z').getTime()
  const offsetMs = localMs - refDate.getTime()
  const target = new Date(`${dateStr}T${endOfDay ? '23:59:59' : '00:00:00'}Z`)
  return Math.floor((target.getTime() - offsetMs) / 1000)
}

export interface TsRange { fromTs: number; toTs: number }

/** Inclusive install-zone day range -> unix-second bounds (from 00:00:00, to 23:59:59). */
export function rangeToTs(range: DateRange): TsRange {
  return { fromTs: toBudapestTs(range.from, false), toTs: toBudapestTs(range.to, true) }
}

/** The forms the date filter understands, for the 400 body. */
export const DATE_FILTER_FORMS =
  'YYYY-MM-DD, YYYY-MM-DD - YYYY-MM-DD, ma, tegnap, tegnapelott, hetfo..vasarnap, mult heten, ezen a heten, ' +
  'mult honapban, ebben a honapban, N nap, N het, utolso N nap, <honap> <nap>, <honap> (pl. oktober)'

function isRealDay(s: string): boolean {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return false
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3])
}

export interface DateFilter {
  /** Day bounds as used (YYYY-MM-DD); a side the caller left open is null. */
  from: string | null
  to: string | null
  ts: TsRange
}

/** Open-ended sides: a unix-second bound no stored row can pass. */
const TS_MIN = 0
const TS_MAX = 253_402_300_799 // 9999-12-31T23:59:59Z

/**
 * Resolves the `date=`, `since=` and `until=` query parameters of
 * GET /api/memories. `date` takes the whole expression grammar of /api/recall;
 * `since` / `until` take a day or an expression (since uses the expression's
 * first day, until its last). Nothing is ignored silently: an unknown or
 * impossible expression, a reversed range, or `date` mixed with `since` /
 * `until` is an error the caller turns into a 400. Returns `{ filter: null }`
 * when no parameter was given.
 */
export function resolveDateFilter(
  params: { date?: string | null; since?: string | null; until?: string | null },
  nowSec?: number,
): { ok: true; filter: DateFilter | null } | { ok: false; error: string } {
  const date = params.date?.trim() || ''
  const since = params.since?.trim() || ''
  const until = params.until?.trim() || ''
  if (!date && !since && !until) return { ok: true, filter: null }
  if (date && (since || until)) {
    return { ok: false, error: 'date cannot be combined with since/until: use date=<from> - <to>, or since= and until=' }
  }
  const bad = (name: string, value: string): { ok: false; error: string } => ({
    ok: false,
    error: `Invalid ${name} "${value}". Recognised forms: ${DATE_FILTER_FORMS}`,
  })
  let from: string | null = null
  let to: string | null = null
  if (date) {
    const r = parseDateExpr(date, nowSec)
    if (!r) return bad('date', date)
    from = r.from
    to = r.to
  } else {
    if (since) {
      const r = parseDateExpr(since, nowSec)
      if (!r) return bad('since', since)
      from = r.from
    }
    if (until) {
      const r = parseDateExpr(until, nowSec)
      if (!r) return bad('until', until)
      to = r.to
    }
  }
  for (const [name, value] of [['date/since', from], ['date/until', to]] as const) {
    if (value !== null && !isRealDay(value)) return bad(name, value)
  }
  if (from !== null && to !== null && from > to) {
    return { ok: false, error: `Empty range: ${from} is after ${to}` }
  }
  return {
    ok: true,
    filter: {
      from,
      to,
      ts: {
        fromTs: from === null ? TS_MIN : toBudapestTs(from, false),
        toTs: to === null ? TS_MAX : toBudapestTs(to, true),
      },
    },
  }
}
