// fb79dc1f: the send windows of the reminder sender. PURE (no IO, no clock): the
// sender and the API compute the moment a reminder may go with the same rule.
//
// A window belongs to a RECIPIENT chat (the owners' quiet hours and weekend rule)
// and comes from the install's own config (store/reminder-windows.json), never
// from code: the framework carries no chat id and no person. A recipient without
// a window gets its reminder at the requested moment.
//
// The time zone is ALWAYS the window's own (e.g. Europe/Budapest), passed
// explicitly: the install's APP_TZ may be UTC (the scheduler's zone), and a quiet
// hour computed in UTC would be two hours off.

export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun'
export const WEEKDAYS: readonly Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']

export interface ReminderWindow {
  /** IANA zone the hours are in, e.g. 'Europe/Budapest'. */
  tz: string
  /** Quiet hours [start, end) in local HH:MM; a start after the end wraps midnight (23:00-07:00). */
  quiet?: { start: string; end: string }
  /** Days nothing goes, unless the reminder itself allows it (allow_weekend): it waits for `resume`. */
  weekend?: { days: Weekday[]; resume: { day: Weekday; at: string } }
}

export interface ReminderWindowsConfig {
  /** Keyed by the recipient chat id, as the reminder row stores it. */
  recipients: Record<string, ReminderWindow>
}

export const EMPTY_WINDOWS: ReminderWindowsConfig = { recipients: {} }

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/
const CHAT_ID = /^-?\d{1,20}$/

function minutesOf(hhmm: string): number {
  const m = HHMM.exec(hhmm)
  if (!m) throw new Error(`bad HH:MM ${hhmm}`)
  return Number(m[1]) * 60 + Number(m[2])
}

function validTz(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/**
 * The config file's text -> the windows, FAIL-CLOSED: anything malformed is an
 * error (the sender then sends nothing and alerts), because a silently dropped
 * window would send into an owner's quiet hours.
 */
export function parseReminderWindows(raw: string): { ok: true; config: ReminderWindowsConfig } | { ok: false; error: string } {
  let x: unknown
  try {
    x = JSON.parse(raw)
  } catch {
    return { ok: false, error: 'not JSON' }
  }
  if (!x || typeof x !== 'object' || Array.isArray(x)) return { ok: false, error: 'not an object' }
  const rec = (x as Record<string, unknown>).recipients
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return { ok: false, error: 'recipients must be an object' }
  const recipients: Record<string, ReminderWindow> = {}
  for (const [chatId, w] of Object.entries(rec as Record<string, unknown>)) {
    if (!CHAT_ID.test(chatId)) return { ok: false, error: `bad chat id key ${chatId.slice(0, 24)}` }
    if (!w || typeof w !== 'object' || Array.isArray(w)) return { ok: false, error: `${chatId}: window must be an object` }
    const o = w as Record<string, unknown>
    if (!validTz(o.tz)) return { ok: false, error: `${chatId}: bad tz` }
    const win: ReminderWindow = { tz: o.tz }
    if (o.quiet !== undefined) {
      const q = o.quiet as Record<string, unknown> | null
      if (!q || typeof q.start !== 'string' || typeof q.end !== 'string' || !HHMM.test(q.start) || !HHMM.test(q.end) || q.start === q.end) {
        return { ok: false, error: `${chatId}: quiet must be {start, end} HH:MM, not equal` }
      }
      win.quiet = { start: q.start, end: q.end }
    }
    if (o.weekend !== undefined) {
      const wk = o.weekend as Record<string, unknown> | null
      const days = wk?.days
      const resume = wk?.resume as Record<string, unknown> | undefined
      if (!Array.isArray(days) || days.length === 0 || days.length > 6 || !days.every(d => (WEEKDAYS as readonly string[]).includes(d as string))) {
        return { ok: false, error: `${chatId}: weekend.days must be 1-6 of ${WEEKDAYS.join('/')}` }
      }
      if (!resume || !(WEEKDAYS as readonly string[]).includes(resume.day as string) || typeof resume.at !== 'string' || !HHMM.test(resume.at)) {
        return { ok: false, error: `${chatId}: weekend.resume must be {day, at}` }
      }
      if ((days as string[]).includes(resume.day as string)) return { ok: false, error: `${chatId}: weekend.resume.day is itself a weekend day` }
      win.weekend = { days: days as Weekday[], resume: { day: resume.day as Weekday, at: resume.at } }
    }
    recipients[chatId] = win
  }
  return { ok: true, config: { recipients } }
}

// ---- local time in a zone ----------------------------------------------------

interface LocalParts { y: number; mo: number; d: number; h: number; mi: number; wd: Weekday }

const WD_FROM_SHORT: Record<string, Weekday> = { Mon: 'mon', Tue: 'tue', Wed: 'wed', Thu: 'thu', Fri: 'fri', Sat: 'sat', Sun: 'sun' }

export function localParts(ms: number, tz: string): LocalParts {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short',
  })
  const p: Record<string, string> = {}
  for (const part of f.formatToParts(new Date(ms))) p[part.type] = part.value
  return { y: Number(p.year), mo: Number(p.month), d: Number(p.day), h: Number(p.hour), mi: Number(p.minute), wd: WD_FROM_SHORT[p.weekday] }
}

function offsetMs(utcMs: number, tz: string): number {
  const p = localParts(utcMs, tz)
  const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi)
  return asUtc - Math.floor(utcMs / 60_000) * 60_000
}

/**
 * The UTC instant of a local wall-clock minute in `tz`. Two passes, so the
 * offset is the one in force AT the result (the DST change days). A wall time
 * that does not exist (the spring-forward hour) maps to the first minute after
 * the gap; an ambiguous one (the fall-back hour) to its first occurrence.
 */
export function zonedToUtcMs(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  const naive = Date.UTC(y, mo - 1, d, h, mi)
  let t = naive - offsetMs(naive, tz)
  const t2 = naive - offsetMs(t, tz)
  if (t2 !== t) t = Math.min(t, t2)
  const back = localParts(t, tz)
  if (back.h !== h || back.mi !== mi) {
    // in the gap: the first existing minute after it
    for (let k = 1; k <= 180; k++) {
      const c = t + k * 60_000
      const lp = localParts(c, tz)
      if (lp.h * 60 + lp.mi > h * 60 + mi || lp.d !== d) return c
    }
    return t
  }
  // the fall-back hour shows the same wall time twice: take the earlier one
  const earlier = localParts(t - 3_600_000, tz)
  if (earlier.d === back.d && earlier.h === h && earlier.mi === mi) return t - 3_600_000
  return t
}

function addLocalDays(p: LocalParts, n: number): { y: number; mo: number; d: number } {
  const dt = new Date(Date.UTC(p.y, p.mo - 1, p.d + n))
  return { y: dt.getUTCFullYear(), mo: dt.getUTCMonth() + 1, d: dt.getUTCDate() }
}

function inQuiet(minute: number, q: { start: string; end: string }): boolean {
  const s = minutesOf(q.start)
  const e = minutesOf(q.end)
  return s < e ? minute >= s && minute < e : minute >= s || minute < e
}

/**
 * The first moment at or after `ms` the window lets a reminder go. Quiet hours
 * move it to the quiet end; a weekend day (unless allowWeekend) moves it to the
 * next `resume` day and time; the rules are applied until neither moves it.
 * No window: `ms` itself.
 */
export function nextAllowedMs(ms: number, win: ReminderWindow | undefined, allowWeekend = false): number {
  if (!win) return ms
  let t = ms
  for (let guard = 0; guard < 16; guard++) {
    const p = localParts(t, win.tz)
    const minute = p.h * 60 + p.mi
    if (win.weekend && !allowWeekend && win.weekend.days.includes(p.wd)) {
      const target = WEEKDAYS.indexOf(win.weekend.resume.day)
      const today = WEEKDAYS.indexOf(p.wd)
      const ahead = ((target - today) + 7) % 7 || 7
      const day = addLocalDays(p, ahead)
      const at = minutesOf(win.weekend.resume.at)
      t = Math.max(t, zonedToUtcMs(day.y, day.mo, day.d, Math.floor(at / 60), at % 60, win.tz))
      continue
    }
    if (win.quiet && inQuiet(minute, win.quiet)) {
      const end = minutesOf(win.quiet.end)
      const day = minute < end ? { y: p.y, mo: p.mo, d: p.d } : addLocalDays(p, 1)
      t = Math.max(t, zonedToUtcMs(day.y, day.mo, day.d, Math.floor(end / 60), end % 60, win.tz))
      continue
    }
    return t
  }
  return t
}

/** May a reminder go at `ms`? (The moment is allowed iff nextAllowedMs does not move it.) */
export function allowedAt(ms: number, win: ReminderWindow | undefined, allowWeekend = false): boolean {
  return nextAllowedMs(ms, win, allowWeekend) === ms
}
