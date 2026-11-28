// QUOTANOTICE1126 -- plan usage notice for the owner.
//
// The gap this closes, measured on a live install on 2026-11-26: nobody was told when the subscription's 5-hour or
// weekly window ran low. scripts/usage-collect.py prints an "ALERT:" line at 92 %, but it runs as a command task, and a
// command task only reports its own FAILURE, so the line reached no one. The owner found out from silence.
//
// What this module does, from the dashboard process (it costs no model tokens): when a window's usage reaches
// QUOTA_NOTICE_PCT (default 90), the owner gets ONE message per subscription and window (keyed by the window's reset
// instant, so the next window re-arms it), with the percentage and the local reset time. Delivered with notifyOwner(),
// so it follows the install's channel provider and owner chat.
//
// scripts/limit-monitor.sh (an optional systemd --user timer) alerts the owner on the same event for the DEFAULT plan.
// While it runs, the default plan's notice waits for its delivery stamp and is dropped when it delivered (one notice
// per event, not two); see "limit-monitor dedupe" below. Named plans are always this module's: limit-monitor reads only
// the default plan's numbers. limit-monitor itself sends through Telegram only; on any other install, and only while
// QUOTA_NOTICE is on, it queues its alert into store/owner-alert-outbox/, and this module delivers that too
// ("Owner-alert outbox" below).
//
// Sources: the same quota readers the dashboard strip uses (statusLine file, observer mod), plus the usage collector's
// store/usage-latest.json (five_hour / seven_day), which is the one that works on a setup-token install. The fresher
// reading wins. No new external call is made here.
//
// QUOTA_NOTICE_DRY_RUN=1 logs every notice instead of sending it: the safe way to try it.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from '../logger.js'
import { STORE_DIR, PROJECT_ROOT, MAIN_AGENT_ID } from '../config.js'
import { atomicWriteFileSync } from './atomic-write.js'
import { STATE_OBSERVER_STATE_DIR } from './state-observer.js'
import {
  readQuotaSnapshot, readModQuotaSnapshot, chooseQuotaSnapshot, DEFAULT_MAX_AGE_SEC, DEFAULT_FABLE_MAX_AGE_SEC,
  type QuotaSnapshot, type QuotaWindow,
} from './quota.js'
import { runQuotaPlanProbes, type QuotaPlanProbeDeps } from './quota-plan-probe.js'

export type WindowKind = 'five_hour' | 'seven_day'
export type NoticeLang = 'hu' | 'en'

export interface QuotaNoticeConfig {
  noticeEnabled: boolean
  noticePct: number
  dryRun: boolean
}

function pctFrom(raw: unknown, dflt: number): number {
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 && n <= 100 ? n : dflt
}

/** The registry keys (src/config-registry.ts, module 'claude-plans', owner-gated): the Settings page writes them. */
export const QUOTA_NOTICE_KEYS = ['QUOTA_NOTICE', 'QUOTA_NOTICE_PCT', 'QUOTA_PLAN_PROBE_MIN'] as const

/**
 * The notice is OFF unless switched on (opt-in). `read` resolves a key the settings way
 * (config-overrides.json > .env > registry default); the dry-run switch is an environment variable only, for testing.
 */
export function readQuotaNoticeConfig(
  read: (key: string) => string | number | undefined,
  env: NodeJS.ProcessEnv = process.env,
): QuotaNoticeConfig {
  const on = (k: string) => String(read(k) ?? '0').trim() === '1'
  return {
    noticeEnabled: on('QUOTA_NOTICE'),
    noticePct: pctFrom(read('QUOTA_NOTICE_PCT'), 90),
    dryRun: (env['QUOTA_NOTICE_DRY_RUN'] ?? '').trim() === '1',
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Quota reading
// ---------------------------------------------------------------------------------------------------------------

/**
 * The usage collector's snapshot (scripts/usage-collect.py -> store/usage-latest.json) as a QuotaSnapshot.
 * Shape: { claude: { ok, windows: { five_hour: { used_percent, resets_at }, seven_day: {...} }, measured_at } }.
 * Never throws; freshness is the measurement's age, with the collector's own tight bar (it runs every 15 minutes).
 */
export function readUsageCollectSnapshot(
  file: string,
  nowSec: number = Math.floor(Date.now() / 1000),
  maxAgeSec: number = DEFAULT_FABLE_MAX_AGE_SEC,
): QuotaSnapshot {
  const empty = { ageSec: null, maxAgeSec, fiveHour: null, sevenDay: null }
  let d: { claude?: { ok?: unknown; windows?: Record<string, { used_percent?: unknown; resets_at?: unknown }>; measured_at?: unknown } }
  try {
    d = JSON.parse(readFileSync(file, 'utf-8'))
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    return { status: 'missing', reason: code === 'ENOENT' ? 'no-file' : 'unreadable', ...empty }
  }
  const c = d?.claude
  if (!c || c.ok !== true || !c.windows) return { status: 'missing', reason: 'no-rate-limits', ...empty }
  const win = (raw: { used_percent?: unknown; resets_at?: unknown } | undefined): QuotaWindow | null => {
    if (!raw || typeof raw.used_percent !== 'number' || !Number.isFinite(raw.used_percent)) return null
    const resetsAt = typeof raw.resets_at === 'number' && Number.isFinite(raw.resets_at) ? raw.resets_at : null
    return { usedPercentage: raw.used_percent, resetsAt, expired: resetsAt !== null && resetsAt <= nowSec }
  }
  const fiveHour = win(c.windows['five_hour'])
  const sevenDay = win(c.windows['seven_day'])
  if (!fiveHour && !sevenDay) return { status: 'missing', reason: 'no-rate-limits', ...empty }
  const measured = typeof c.measured_at === 'string' ? Math.floor(Date.parse(c.measured_at) / 1000) : NaN
  const ageSec = Number.isFinite(measured) ? Math.max(0, nowSec - measured) : null
  return {
    status: ageSec === null || ageSec > maxAgeSec ? 'stale' : 'ok',
    ageSec, maxAgeSec, fiveHour, sevenDay,
  }
}

/** The fresher of two readings: ok over stale over missing, then the younger. */
export function fresherSnapshot(a: QuotaSnapshot, b: QuotaSnapshot): QuotaSnapshot {
  const rank = (q: QuotaSnapshot) => (q.status === 'ok' ? 2 : q.status === 'stale' ? 1 : 0)
  if (rank(a) !== rank(b)) return rank(a) > rank(b) ? a : b
  return (b.ageSec ?? Infinity) < (a.ageSec ?? Infinity) ? b : a
}

export function currentQuotaSnapshot(nowSec: number = Math.floor(Date.now() / 1000)): QuotaSnapshot {
  const dashboardPick = chooseQuotaSnapshot(
    readQuotaSnapshot(join(PROJECT_ROOT, 'store', '.claude-rate-limits.json'), nowSec, DEFAULT_MAX_AGE_SEC),
    readModQuotaSnapshot(STATE_OBSERVER_STATE_DIR, nowSec, DEFAULT_MAX_AGE_SEC),
  )
  return fresherSnapshot(dashboardPick, readUsageCollectSnapshot(join(STORE_DIR, 'usage-latest.json'), nowSec))
}

/** The open windows of a fresh snapshot, highest usage first. A stale or missing reading yields none. */
export function openWindows(snap: QuotaSnapshot): Array<{ kind: WindowKind; window: QuotaWindow }> {
  if (snap.status !== 'ok') return []
  const out: Array<{ kind: WindowKind; window: QuotaWindow }> = []
  if (snap.fiveHour && !snap.fiveHour.expired) out.push({ kind: 'five_hour', window: snap.fiveHour })
  if (snap.sevenDay && !snap.sevenDay.expired) out.push({ kind: 'seven_day', window: snap.sevenDay })
  return out.sort((x, y) => y.window.usedPercentage - x.window.usedPercentage)
}

// ---------------------------------------------------------------------------------------------------------------
// Plans (subscriptions)
// ---------------------------------------------------------------------------------------------------------------
//
// An install can register several Claude subscriptions (store/claude-plans.json, src/web/claude-plans.ts) and point
// agents at them (agent-config `claudePlan`, or the main agent's rotation: claude-plans-state.json activePlanByAgent).
// Each plan has its own 5-hour and weekly window, so the notice names the plan and fires once per plan and window.
//
// Where per-plan numbers come from (measured in the code 2026-11-26):
//   - the DEFAULT plan (the fleet token / the host login every agent without a `claudePlan` uses): the statusLine
//     block, the observer mod and usage-collect.py's store/usage-latest.json. usage-collect reads ONE token, the
//     default one; under plan rotation it gives up on purpose (QUOTAHDRROT1118).
//   - a NAMED plan: store/claude-plans-state.json `plans[id]`, written by the plan-rotation heartbeat (the active
//     plan, from usage-collect) and by its live probe of idle token plans (CLAUDE_PLAN_USAGE_REFRESH). Without
//     rotation only the per-plan probe (quota-plan-probe.ts) writes it; a named plan with no fresh numbers gets no
//     percentage notice.

export const DEFAULT_PLAN_ID = 'default'

export interface PlanQuota { planId: string; label: string; snap: QuotaSnapshot }

/** A claude-plans-state.json observation as a QuotaSnapshot (observedAt is unix ms, windows usedPercent/resetsAt). */
export function planStateSnapshot(
  observed: { observedAt?: unknown; windows?: Record<string, { usedPercent?: unknown; resetsAt?: unknown }> } | undefined,
  nowSec: number,
  maxAgeSec: number = DEFAULT_FABLE_MAX_AGE_SEC,
): QuotaSnapshot {
  const empty = { ageSec: null, maxAgeSec, fiveHour: null, sevenDay: null }
  if (!observed || !observed.windows || typeof observed.observedAt !== 'number') return { status: 'missing', reason: 'no-file', ...empty }
  const win = (raw: { usedPercent?: unknown; resetsAt?: unknown } | undefined): QuotaWindow | null => {
    if (!raw || typeof raw.usedPercent !== 'number' || !Number.isFinite(raw.usedPercent)) return null
    const resetsAt = typeof raw.resetsAt === 'number' && Number.isFinite(raw.resetsAt) ? raw.resetsAt : null
    return { usedPercentage: raw.usedPercent, resetsAt, expired: resetsAt !== null && resetsAt <= nowSec }
  }
  const fiveHour = win(observed.windows['five_hour'])
  const sevenDay = win(observed.windows['seven_day'])
  if (!fiveHour && !sevenDay) return { status: 'missing', reason: 'no-rate-limits', ...empty }
  const ageSec = Math.max(0, nowSec - Math.floor(observed.observedAt / 1000))
  return { status: ageSec > maxAgeSec ? 'stale' : 'ok', ageSec, maxAgeSec, fiveHour, sevenDay }
}

export function defaultPlanLabel(lang: NoticeLang): string {
  return lang === 'en' ? 'default (fleet)' : 'alap (flotta)'
}

// ---------------------------------------------------------------------------------------------------------------
// Threshold notice
// ---------------------------------------------------------------------------------------------------------------

/** Two reset instants this close describe the same window. */
export const RESET_TOLERANCE_SEC = 15 * 60

export interface ThresholdNotice { kind: WindowKind; pct: number; resetsAt: number | null; planLabel?: string }

/**
 * Which windows cross the threshold for the first time in their life. `notified` maps a window kind to the reset
 * instant of the window already notified, so a window is announced once and the NEXT window (a new reset instant)
 * re-arms the notice. A window without a reset instant is keyed by 0 (announced once until one appears).
 * `notifiedPct` keeps the threshold each window was announced at: raising the threshold within the same window
 * (e.g. back to 90 after a test at 50) re-arms the notice for the higher threshold, lowering it does not. A window
 * recorded without a threshold (older state) counts as announced at any threshold.
 */
export function decideThresholdNotices(
  snap: QuotaSnapshot, notified: Partial<Record<WindowKind, number>>, thresholdPct: number,
  notifiedPct: Partial<Record<WindowKind, number>> = {},
): { notices: ThresholdNotice[]; next: Partial<Record<WindowKind, number>>; nextPct: Partial<Record<WindowKind, number>> } {
  const next = { ...notified }
  const nextPct = { ...notifiedPct }
  const notices: ThresholdNotice[] = []
  for (const { kind, window } of openWindows(snap)) {
    if (window.usedPercentage < thresholdPct) continue
    const key = window.resetsAt ?? 0
    // The same window, even when two sources (or two readings) round its reset instant differently: a new window
    // resets at least an hour later than the old one (5-hour or weekly), so a 15-minute tolerance cannot merge two.
    const prev = notified[kind]
    const prevPct = notifiedPct[kind]
    const sameWindow = prev !== undefined && Math.abs(prev - key) <= RESET_TOLERANCE_SEC
    if (sameWindow && (prevPct === undefined || prevPct >= thresholdPct)) continue
    notices.push({ kind, pct: window.usedPercentage, resetsAt: window.resetsAt })
    next[kind] = key
    nextPct[kind] = thresholdPct
  }
  return { notices, next, nextPct }
}

/** Local wall-clock time of a reset: "19:20" today, "dec. 2. 00:00" / "Dec 2, 00:00" on another day. */
export function formatResetTime(resetsAtSec: number | null, lang: NoticeLang, nowSec: number = Math.floor(Date.now() / 1000)): string {
  if (resetsAtSec === null) return lang === 'en' ? 'an unknown time' : 'ismeretlen időpontban'
  const d = new Date(resetsAtSec * 1000)
  const now = new Date(nowSec * 1000)
  const locale = lang === 'en' ? 'en-GB' : 'hu-HU'
  const time = d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: false })
  if (d.toDateString() === now.toDateString()) return time
  const day = d.toLocaleDateString(locale, { month: 'short', day: 'numeric' })
  return `${day} ${time}`
}

export function formatThresholdNotice(n: ThresholdNotice, lang: NoticeLang, nowSec?: number): string {
  const pct = Math.round(n.pct)
  const at = formatResetTime(n.resetsAt, lang, nowSec)
  const plan = n.planLabel ?? defaultPlanLabel(lang)
  if (lang === 'en') {
    const name = n.kind === 'five_hour' ? 'the 5-hour window' : 'the weekly window'
    return `⚠️ AI quota, subscription "${plan}": ${name} is at ${pct}%. It resets at ${at}. Above the limit the agents on this subscription cannot answer until then.`
  }
  const name = n.kind === 'five_hour' ? 'az 5 órás ablak' : 'a heti ablak'
  return `⚠️ AI-keret, „${plan}” előfizetés: ${name} ${pct}%-on áll. Újra tele: ${at}. A keret elfogyása után az ezen futó ügynökök addig nem tudnak válaszolni.`
}

// ---------------------------------------------------------------------------------------------------------------
// limit-monitor dedupe
// ---------------------------------------------------------------------------------------------------------------
//
// scripts/limit-monitor.sh alerts the owner (Telegram Bot API only) when the DEFAULT plan's statusLine numbers cross
// its QUOTA_WARN_PCT (scripts/lib/quota-check.py). On that event both would speak, so for the default plan:
//
//   - The script's delivery signal is store/.limit-monitor-quota-state: the HIT key, written ONLY after a confirmed
//     send. Its format (quota-check.py, HIT field 2) is "<kind>:<level>:<resets_at>" per hit window, joined by "|",
//     e.g. "five_hour:90:1795710000|seven_day:100:1796000000". A stamp entry with our window's kind, a reset instant
//     within RESET_TOLERANCE_SEC of ours, and a level at or above our threshold means the owner was already told about
//     this window at this threshold: our notice is dropped (recorded as notified). This holds whether or not the
//     script still runs.
//   - The heartbeat alone proves nothing about delivery (it is written on quiet runs, and on a Discord-only install
//     the script has no bot token), so "active" only buys the script time: while it is active and has not stamped,
//     our default-plan notice is held for LIMIT_MONITOR_GRACE_SEC from the tick that first wanted to send it, then
//     sent anyway.
//   - Not active (no recent run): sent at once, as without the script.
//
// "Active" = the script ran within LIMIT_MONITOR_ACTIVE_MAX_AGE_SEC. Every run leaves a trace: a quiet run writes
// "ok <epoch>" into store/.limit-monitor-heartbeat, and a run that saw a text signal (where no heartbeat is written)
// appends to store/limit-monitor.log. The newer of the two counts.
//
// The constants: the repo ships no systemd unit or timer for limit-monitor.sh (the operator installs one, interval of
// their choice; searched 2026-11-27: no *.timer, installer or doc names it), so its interval is not knowable here.
// 30 minutes for "active" and 15 for the hold assume a tick of at most ~15 minutes; a slower timer only means our
// notice is sent after the hold and the owner may get both, never neither.

export const LIMIT_MONITOR_ACTIVE_MAX_AGE_SEC = 30 * 60
export const LIMIT_MONITOR_GRACE_SEC = 15 * 60

export interface LimitMonitorStampEntry { kind: WindowKind; level: number; resetsAt: number }
export interface LimitMonitorSignal {
  /** The newest trace of a limit-monitor run (unix seconds), or null: never ran here. */
  lastRunSec: number | null
  /** The parsed delivery stamp (store/.limit-monitor-quota-state); empty when absent or unreadable. */
  stamp: LimitMonitorStampEntry[]
}

/** quota-check.py's HIT key: "kind:level:resets_at" joined by "|". A malformed entry is skipped. */
export function parseLimitMonitorStamp(raw: string): LimitMonitorStampEntry[] {
  const out: LimitMonitorStampEntry[] = []
  for (const part of raw.trim().split('|')) {
    const m = /^(five_hour|seven_day):(\d+(?:\.\d+)?):(\d+)$/.exec(part.trim())
    if (!m) continue
    out.push({ kind: m[1] as WindowKind, level: Number(m[2]), resetsAt: Number(m[3]) })
  }
  return out
}

export function readLimitMonitorSignal(storeDir: string): LimitMonitorSignal {
  let lastRunSec: number | null = null
  const seen = (sec: number) => { if (Number.isFinite(sec) && sec > 0 && (lastRunSec === null || sec > lastRunSec)) lastRunSec = sec }
  try {
    const m = /^ok\s+(\d+)/.exec(readFileSync(join(storeDir, '.limit-monitor-heartbeat'), 'utf-8'))
    if (m) seen(Number(m[1]))
  } catch { /* no heartbeat */ }
  try { seen(Math.floor(statSync(join(storeDir, 'limit-monitor.log')).mtimeMs / 1000)) } catch { /* no log */ }
  let stamp: LimitMonitorStampEntry[] = []
  try { stamp = parseLimitMonitorStamp(readFileSync(join(storeDir, '.limit-monitor-quota-state'), 'utf-8')) } catch { /* none */ }
  return { lastRunSec, stamp }
}

export function limitMonitorActive(sig: LimitMonitorSignal, nowSec: number): boolean {
  return sig.lastRunSec !== null && nowSec - sig.lastRunSec <= LIMIT_MONITOR_ACTIVE_MAX_AGE_SEC
}

/** Did limit-monitor already deliver for this window at (at least) this threshold? A window without a reset cannot match. */
export function limitMonitorCovered(stamp: LimitMonitorStampEntry[], kind: WindowKind, resetsAt: number | null, thresholdPct: number): boolean {
  if (resetsAt === null) return false
  return stamp.some((e) => e.kind === kind && Math.abs(e.resetsAt - resetsAt) <= RESET_TOLERANCE_SEC && e.level >= thresholdPct)
}

export type DefaultPlanDecision = 'send' | 'hold' | 'covered'

/**
 * What to do with a due DEFAULT-plan notice. `heldSinceSec` is when this window's notice was first held (undefined:
 * not held yet). Named plans never come here.
 */
export function decideDefaultPlanNotice(
  sig: LimitMonitorSignal, nowSec: number, notice: { kind: WindowKind; resetsAt: number | null },
  thresholdPct: number, heldSinceSec: number | undefined,
): DefaultPlanDecision {
  if (limitMonitorCovered(sig.stamp, notice.kind, notice.resetsAt, thresholdPct)) return 'covered'
  if (!limitMonitorActive(sig, nowSec)) return 'send'
  const since = heldSinceSec ?? nowSec
  return nowSec - since < LIMIT_MONITOR_GRACE_SEC ? 'hold' : 'send'
}

// ---------------------------------------------------------------------------------------------------------------
// Owner-alert outbox (limit-monitor.sh without a Telegram bot token)
// ---------------------------------------------------------------------------------------------------------------
//
// scripts/limit-monitor.sh can only send through the Telegram Bot API. On an install without a Telegram bot token
// (Discord, Slack, ...) its send_alert writes the alert into store/owner-alert-outbox/<epoch>-<pid>-<tag>.txt instead
// (atomic rename, mode 600, at most 4000 bytes) and counts it as handled. This tick delivers each file through
// notifyOwner, the install's own owner route, and deletes it only after a confirmed delivery; a failed one stays for
// the next tick. A file older than OUTBOX_MAX_AGE_SEC is dropped with a log line (the alert is about a window that
// is likely over). The content is plain text: control characters are removed and the length is capped.
//
// The outbox follows QUOTA_NOTICE, like the rest of this module. QUOTA_NOTICE is a dashboard setting
// (config-overrides.json over .env), which limit-monitor.sh cannot resolve the same way, so the dashboard is the one
// source of truth and hands the switch over as a marker file: while QUOTA_NOTICE is on, every cycle makes sure
// store/owner-alert-outbox/.enabled exists; while it is off, the cycle removes it and delivers nothing.
// limit-monitor.sh takes the outbox path only while the marker exists; without it, it behaves as before the outbox
// (no owner chat: logs and exits; no bot token: logs the alert as undeliverable). The marker is a dot-file, so the
// delivery below never reads it as an alert.

export const OWNER_ALERT_OUTBOX = 'owner-alert-outbox'
/** The file limit-monitor.sh checks (scripts/limit-monitor.sh outbox_enabled): present only while QUOTA_NOTICE is on. */
export const OUTBOX_ENABLED_MARKER = '.enabled'
export const OUTBOX_MAX_AGE_SEC = 24 * 60 * 60
/** Under Discord's 2000-character message limit, the tightest of the owner routes. */
export const OUTBOX_MAX_CHARS = 1900
const OUTBOX_READ_BYTES = 16 * 1024

/** The text an outbox file is delivered as: control characters out (newline and tab stay), length capped. */
export function outboxText(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = raw.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '').trim()
  return clean.length > OUTBOX_MAX_CHARS ? `${clean.slice(0, OUTBOX_MAX_CHARS - 1)}…` : clean
}

export interface OutboxResult { delivered: number; kept: number; dropped: number }

/**
 * Makes the marker match the switch: created (with the outbox dir, mode 700 / 600) when on, removed when off. Returns
 * whether the marker exists afterwards. Never throws: a marker that cannot be written only means limit-monitor keeps
 * its old behaviour, which is logged.
 */
export function syncOutboxMarker(dir: string, enabled: boolean): boolean {
  const marker = join(dir, OUTBOX_ENABLED_MARKER)
  try {
    if (enabled) {
      if (!existsSync(marker)) {
        mkdirSync(dir, { recursive: true, mode: 0o700 })
        writeFileSync(marker, 'Written by the dashboard while QUOTA_NOTICE is on. scripts/limit-monitor.sh queues owner alerts here only while this file exists.\n', { mode: 0o600 })
        logger.info({ dir }, 'quota-notice: owner-alert outbox enabled for scripts/limit-monitor.sh')
      }
      return true
    }
    if (existsSync(marker)) {
      unlinkSync(marker)
      logger.info({ dir }, 'quota-notice: owner-alert outbox disabled (QUOTA_NOTICE is off)')
    }
    return false
  } catch (err) {
    logger.warn({ err: String(err).slice(0, 200), dir }, 'quota-notice: owner-alert outbox marker not synced')
    return existsSync(marker)
  }
}

export async function deliverOwnerAlertOutbox(
  dir: string, nowSec: number, send: (text: string) => Promise<boolean>,
): Promise<OutboxResult> {
  const res: OutboxResult = { delivered: 0, kept: 0, dropped: 0 }
  let names: string[]
  try { names = readdirSync(dir) } catch { return res }
  // Oldest first (the name starts with the epoch); a dot-file is a write still in progress.
  for (const name of names.filter((n) => !n.startsWith('.') && n.endsWith('.txt')).sort()) {
    const file = join(dir, name)
    let st: ReturnType<typeof statSync>
    try { st = statSync(file) } catch { continue }
    if (!st.isFile()) continue
    const m = /^(\d+)-/.exec(name)
    const writtenSec = m ? Number(m[1]) : Math.floor(st.mtimeMs / 1000)
    if (nowSec - writtenSec > OUTBOX_MAX_AGE_SEC) {
      try { unlinkSync(file) } catch { /* gone */ }
      logger.warn({ file: name, ageSec: nowSec - writtenSec }, 'quota-notice: owner-alert outbox file older than 24 h dropped undelivered')
      res.dropped++
      continue
    }
    let raw: string
    try { raw = readFileSync(file).subarray(0, OUTBOX_READ_BYTES).toString('utf-8') } catch { continue }
    const text = outboxText(raw)
    if (!text) { try { unlinkSync(file) } catch { /* gone */ } res.dropped++; continue }
    let ok = false
    try { ok = await send(text) } catch { ok = false }
    if (ok) {
      try { unlinkSync(file) } catch { /* gone */ }
      res.delivered++
    } else {
      res.kept++
    }
  }
  return res
}

// ---------------------------------------------------------------------------------------------------------------
// State + runner
// ---------------------------------------------------------------------------------------------------------------

/**
 * `notified`: per plan id, per window kind, the reset instant of the window already announced. `notifiedPct`: the
 * threshold it was announced at (absent in older state files). `heldForLimitMonitor`: a default-plan notice being held
 * for limit-monitor, per window kind (the window's reset instant and when the hold began, unix seconds).
 */
export interface QuotaNoticeState {
  notified: Record<string, Partial<Record<WindowKind, number>>>
  notifiedPct?: Record<string, Partial<Record<WindowKind, number>>>
  heldForLimitMonitor?: Partial<Record<WindowKind, { resetsAt: number; since: number }>>
}

const STATE_FILE = 'quota-notice-state.json'

/** Never throws. Fields of earlier versions (the removed `autoReplies` list) are ignored and dropped on the next save. */
export function loadQuotaNoticeState(file = join(STORE_DIR, STATE_FILE)): QuotaNoticeState {
  try {
    const d = JSON.parse(readFileSync(file, 'utf-8')) as { notified?: Record<string, unknown>; notifiedPct?: Record<string, unknown>; heldForLimitMonitor?: Record<string, unknown> }
    const notified: QuotaNoticeState['notified'] = {}
    for (const [k, v] of Object.entries(d.notified ?? {})) {
      // The first (single-plan) shape kept the window kinds at the top level: that was the default plan.
      if ((k === 'five_hour' || k === 'seven_day') && typeof v === 'number') (notified[DEFAULT_PLAN_ID] ??= {})[k] = v
      else if (v && typeof v === 'object') notified[k] = { ...(notified[k] ?? {}), ...(v as Partial<Record<WindowKind, number>>) }
    }
    const notifiedPct: NonNullable<QuotaNoticeState['notifiedPct']> = {}
    for (const [k, v] of Object.entries(d.notifiedPct ?? {})) {
      if (v && typeof v === 'object') notifiedPct[k] = { ...(v as Partial<Record<WindowKind, number>>) }
    }
    const held: NonNullable<QuotaNoticeState['heldForLimitMonitor']> = {}
    for (const [k, v] of Object.entries(d.heldForLimitMonitor ?? {})) {
      const h = v as { resetsAt?: unknown; since?: unknown } | null
      if ((k === 'five_hour' || k === 'seven_day') && h && typeof h.resetsAt === 'number' && typeof h.since === 'number') {
        held[k] = { resetsAt: h.resetsAt, since: h.since }
      }
    }
    return { notified, notifiedPct, heldForLimitMonitor: held }
  } catch {
    return { notified: {} }
  }
}

export function saveQuotaNoticeState(state: QuotaNoticeState, file = join(STORE_DIR, STATE_FILE)): void {
  try { atomicWriteFileSync(file, JSON.stringify(state, null, 2)) } catch (err) { logger.warn({ err }, 'quota-notice: state not saved') }
}

/** Everything the tick touches outside itself, so the tick is testable without a channel, a clock or the store. */
export interface QuotaNoticeDeps {
  now: () => number
  config: QuotaNoticeConfig
  lang: () => NoticeLang
  /** Every plan with its reading (the default plan always, named plans as registered). */
  plans: (nowSec: number) => PlanQuota[]
  /** scripts/limit-monitor.sh's run trace and delivery stamp (only the default plan consults it). */
  limitMonitor: () => LimitMonitorSignal
  notifyOwner: (text: string) => Promise<boolean>
  loadState: () => QuotaNoticeState
  saveState: (s: QuotaNoticeState) => void
}

export async function runQuotaNoticeTick(deps: QuotaNoticeDeps): Promise<void> {
  const cfg = deps.config
  if (!cfg.noticeEnabled) return
  const nowSec = Math.floor(deps.now() / 1000)
  const lang = deps.lang()
  const state = deps.loadState()
  let dirty = false
  let lm: LimitMonitorSignal | null = null

  for (const plan of deps.plans(nowSec)) {
    const { notices, next, nextPct } = decideThresholdNotices(
      plan.snap, state.notified[plan.planId] ?? {}, cfg.noticePct, state.notifiedPct?.[plan.planId] ?? {})
    const record = (kind: WindowKind) => {
      (state.notified[plan.planId] ??= {})[kind] = next[kind]
      ;((state.notifiedPct ??= {})[plan.planId] ??= {})[kind] = nextPct[kind]
      if (state.heldForLimitMonitor?.[kind] && plan.planId === DEFAULT_PLAN_ID) delete state.heldForLimitMonitor[kind]
      dirty = true
    }
    for (const n of notices) {
      if (plan.planId === DEFAULT_PLAN_ID) {
        lm ??= deps.limitMonitor()
        const held = state.heldForLimitMonitor?.[n.kind]
        const heldSince = held && Math.abs(held.resetsAt - (n.resetsAt ?? 0)) <= RESET_TOLERANCE_SEC ? held.since : undefined
        const decision = decideDefaultPlanNotice(lm, nowSec, n, cfg.noticePct, heldSince)
        if (decision === 'covered') {
          // Logged once: the window is recorded as notified, so it is not decided again.
          logger.info({ plan: plan.planId, kind: n.kind, resetsAt: n.resetsAt }, 'quota-notice: default plan skipped, scripts/limit-monitor.sh already alerted the owner for this window')
          record(n.kind)
          continue
        }
        if (decision === 'hold') {
          if (heldSince === undefined) {
            // Logged once per window: the hold is recorded, later ticks find it.
            (state.heldForLimitMonitor ??= {})[n.kind] = { resetsAt: n.resetsAt ?? 0, since: nowSec }
            dirty = true
            logger.info({ plan: plan.planId, kind: n.kind, graceSec: LIMIT_MONITOR_GRACE_SEC }, 'quota-notice: default plan held, scripts/limit-monitor.sh is active; sent only if it has not alerted by then')
          }
          continue
        }
      }
      const text = formatThresholdNotice({ ...n, planLabel: plan.label }, lang, nowSec)
      const ok = cfg.dryRun ? (logger.info({ plan: plan.planId, text }, 'quota-notice DRY-RUN: owner notice'), true) : await deps.notifyOwner(text)
      // Record only a delivered notice: a lost one is tried again next tick.
      if (ok) record(n.kind)
    }
  }
  if (dirty) deps.saveState(state)
}

export const QUOTA_NOTICE_INTERVAL_MS = 60 * 1000

/** Live wiring, kept apart from the deciders so the tests never load a channel. */
export async function liveQuotaNoticeDeps(): Promise<QuotaNoticeDeps> {
  const [{ notifyOwner }, textLang, settings, plansReg, plansState] = await Promise.all([
    import('../notify.js'), import('./agent-text-lang.js'), import('../settings-store.js'),
    import('./claude-plans.js'), import('./claude-plans-state.js'),
  ])
  return {
    now: () => Date.now(),
    config: readQuotaNoticeConfig((k) => settings.getEffectiveSettingValue(k)),
    lang: () => textLang.agentTextLang(),
    plans: (s) => {
      const lang = textLang.agentTextLang()
      const probeMin = Number(settings.getEffectiveSettingValue('QUOTA_PLAN_PROBE_MIN')) || 15
      const planMaxAgeSec = Math.max(DEFAULT_FABLE_MAX_AGE_SEC, 2 * probeMin * 60 + 300)
      const observed = plansState.readClaudePlansState().plans
      return [
        { planId: DEFAULT_PLAN_ID, label: defaultPlanLabel(lang), snap: currentQuotaSnapshot(s) },
        // A named plan's numbers age between two probes (QUOTA_PLAN_PROBE_MIN): stale only after two missed rounds.
        ...plansReg.readClaudePlans().map((p) => ({ planId: p.id, label: p.label || p.id, snap: planStateSnapshot(observed[p.id], s, planMaxAgeSec) })),
      ]
    },
    // The same store dir limit-monitor.sh writes ($INSTALL_DIR/store).
    limitMonitor: () => readLimitMonitorSignal(join(PROJECT_ROOT, 'store')),
    notifyOwner: (text) => notifyOwner(text, { kind: 'quota-notice' }),
    loadState: () => loadQuotaNoticeState(),
    saveState: (s) => saveQuotaNoticeState(s),
  }
}

const dryRunLogged = new Set<string>()

/** Everything one dashboard cycle touches beyond the notice tick, injectable so the off state is testable. */
export interface QuotaNoticeCycleDeps {
  notice: QuotaNoticeDeps
  /** store/owner-alert-outbox of this install. */
  outboxDir: string
  /** Delivers one limit-monitor alert on the owner route (notifyOwner with kind 'limit-monitor'). */
  ownerAlert: (text: string) => Promise<boolean>
  /** The per-plan probe wiring (quota-plan-probe.ts); `enabled` is the switch the probe round checks. */
  probeDeps: (enabled: () => boolean) => Promise<QuotaPlanProbeDeps>
}

/**
 * One cycle, in order: the outbox marker follows QUOTA_NOTICE; with the switch off nothing else happens (no outbox
 * delivery, no per-plan probe, so no API call, and no notice). With it on: the limit-monitor outbox is delivered,
 * fresh per-plan numbers are fetched (so this cycle already judges by them), then the notice tick runs.
 */
export async function runQuotaNoticeCycle(c: QuotaNoticeCycleDeps): Promise<void> {
  const cfg = c.notice.config
  syncOutboxMarker(c.outboxDir, cfg.noticeEnabled)
  if (!cfg.noticeEnabled) return
  const r = await deliverOwnerAlertOutbox(c.outboxDir, Math.floor(c.notice.now() / 1000), async (text) => {
    if (!cfg.dryRun) return c.ownerAlert(text)
    // Dry-run: logged once per text, the file stays for a real run.
    if (!dryRunLogged.has(text)) { dryRunLogged.add(text); logger.info({ text }, 'quota-notice DRY-RUN: owner-alert outbox') }
    return false
  })
  if (r.delivered || r.dropped) logger.info(r, 'quota-notice: owner-alert outbox processed')
  await runQuotaPlanProbes(await c.probeDeps(() => cfg.noticeEnabled))
  await runQuotaNoticeTick(c.notice)
}

let started = false
export function startQuotaNotice(): void {
  if (started) return
  started = true
  let running = false
  const tick = async () => {
    if (running) return
    running = true
    try {
      const deps = await liveQuotaNoticeDeps()
      const [{ notifyOwner }, { liveQuotaPlanProbeDeps }, settings, agentConfig, plansState] = await Promise.all([
        import('../notify.js'), import('./quota-plan-probe.js'), import('../settings-store.js'), import('./agent-config.js'),
        import('./claude-plans-state.js'),
      ])
      const planOf = (agent: string) =>
        plansState.readClaudePlansState().activePlanByAgent[agent] ?? agentConfig.readAgentClaudePlan(agent) ?? DEFAULT_PLAN_ID
      await runQuotaNoticeCycle({
        notice: deps,
        // The same store dir limit-monitor.sh writes ($INSTALL_DIR/store).
        outboxDir: join(PROJECT_ROOT, 'store', OWNER_ALERT_OUTBOX),
        ownerAlert: (text) => notifyOwner(text, { kind: 'limit-monitor' }),
        probeDeps: (enabled) => liveQuotaPlanProbeDeps(
          enabled, () => Number(settings.getEffectiveSettingValue('QUOTA_PLAN_PROBE_MIN')) || 15,
          planOf, () => [MAIN_AGENT_ID, ...agentConfig.listAgentNames().filter((n) => n !== MAIN_AGENT_ID)],
        ),
      })
    } catch (err) {
      logger.warn({ err: String(err).slice(0, 300) }, 'quota-notice tick failed')
    } finally {
      running = false
    }
  }
  setInterval(() => { void tick() }, QUOTA_NOTICE_INTERVAL_MS).unref?.()
}
