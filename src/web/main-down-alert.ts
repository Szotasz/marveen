// MAINDOWNALERT1124: tell the owner, in plain words, that the main session is
// NOT coming back up -- not just that a restart happened.
//
// Measured 2026-11-24 18:13-21:33: the main claude died 5 s after each of 25
// launches (pane status 126, a half-replaced binary). channels.sh logged every
// one as a `rapid-exit` line in store/channels-failures.log and backed off, but
// the only owner messages in those 3 h 20 min were four "restart happened"
// routine alerts. Nothing ever said "the main session is down and is not
// recovering", so the owner learned it from a stalled scheduled task.
//
// The signal is the rapid-exit streak channels.sh already writes. The file is
// cleared only on a NORMAL exit, so after a recovery the old streak stays in
// it until the next clean restart: "ongoing" therefore also needs the newest
// rapid-exit to be recent. The supervisor cycles every ~8 min at full backoff
// (300 s sleep + launch + the post-spawn watch), so a 15 min freshness window
// keeps a live streak "ongoing" and lets a recovered one go quiet.

export const MAIN_DOWN_MIN_STREAK = 3
export const MAIN_DOWN_FRESH_MS = 15 * 60 * 1000

export type RapidExit = { at: number, reason: string, paneStatus: string | null }

const LINE = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) rapid-exit after \d+s reason=(\S+)(?: pane_status=(\S+))?/

// Local time, the same clock channels.sh's `date` wrote with.
export function parseRapidExits(text: string): RapidExit[] {
  const out: RapidExit[] = []
  for (const line of text.split('\n')) {
    const m = LINE.exec(line)
    if (!m) continue
    const at = new Date(`${m[1]}T${m[2]}`).getTime()
    if (Number.isNaN(at)) continue
    out.push({ at, reason: m[3], paneStatus: m[4] ?? null })
  }
  return out
}

export type MainDownState = { alerted: boolean, firstAt: number | null }

export type MainDownDecision =
  | { action: 'none', next: MainDownState }
  | { action: 'down', next: MainDownState, streak: number, firstAt: number, last: RapidExit }
  | { action: 'recovered', next: MainDownState, downMinutes: number }

export function decideMainDown(
  exits: RapidExit[],
  now: number,
  prev: MainDownState,
  opts: { minStreak?: number, freshMs?: number } = {},
): MainDownDecision {
  const minStreak = opts.minStreak ?? MAIN_DOWN_MIN_STREAK
  const freshMs = opts.freshMs ?? MAIN_DOWN_FRESH_MS
  const last = exits[exits.length - 1]
  const ongoing = !!last && exits.length >= minStreak && now - last.at <= freshMs
  if (ongoing) {
    const firstAt = exits[0].at
    // 'down' on every ongoing tick: the caller's owner-action cooldown turns
    // that into one message now and a "still down, N times" reminder later.
    return { action: 'down', next: { alerted: true, firstAt }, streak: exits.length, firstAt, last }
  }
  if (prev.alerted) {
    const downMinutes = prev.firstAt !== null ? Math.round((now - prev.firstAt) / 60000) : 0
    return { action: 'recovered', next: { alerted: false, firstAt: null }, downMinutes }
  }
  return { action: 'none', next: prev }
}

function hhmm(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function mainDownText(session: string, streak: number, firstAt: number, last: RapidExit, now: number): string {
  const mins = Math.round((now - firstAt) / 60000)
  const status = last.paneStatus ? `, kilépési kód ${last.paneStatus}` : ''
  const hint = last.paneStatus === '126' || last.paneStatus === '127'
    ? '\nA claude program nem indítható (sérült vagy félbemaradt telepítés). Kézi javítás: npm install -g @anthropic-ai/claude-code'
    : ''
  return `🚨 A fő session (${session}) NEM áll fel: ${hhmm(firstAt)} óta ${streak} indítás halt el pár másodperc után (${mins} perce${status}, ok: ${last.reason}).\nAmíg ez tart, nem kapom meg az üzeneteidet, és az ütemezett feladatok sem futnak.${hint}\nRészletek: store/channels.error.log, store/channels-failures.log`
}

export function mainRecoveredText(session: string, downMinutes: number): string {
  return `✅ A fő session (${session}) újra fut (kb. ${downMinutes} perc kiesés után).`
}
