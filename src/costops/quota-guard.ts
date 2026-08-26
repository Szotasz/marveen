// CostOps F3 -- subscription quota guard.
//
// The fleet runs on a Claude subscription, so there is no invoice to cap and
// the list-price-equivalent figures elsewhere in CostOps are a yardstick, not
// money owed. What actually runs out is the subscription's rolling quota, and
// that is readable directly: the OAuth usage endpoint reports how much of the
// five-hour and seven-day windows has been consumed.
//
// This watches the seven-day figure and acts on an ABSOLUTE ladder: warn at
// 70%, switch the fleet to eco mode at 85%.
//
// It deliberately does NOT trigger on "consumption is ahead of elapsed time".
// That rule fires almost always at the start of a window and almost never at
// the end: one hour into seven days, elapsed is 0.6%, so any real work is
// already "ahead". The time comparison is kept, but only as forecast text in
// the alert, where being early is informative rather than actionable.
//
// It writes configuration and never restarts an agent: a model change lands on
// the next restart, and scheduling those is an operator decision.

import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { logger } from '../logger.js'
import { PROJECT_ROOT, MAIN_AGENT_ID } from '../config.js'
import { createAgentMessage } from '../db.js'
import { applyEcoMode, readEcoState, DEFAULT_ECO_MODEL, type EcoApplyResult } from './eco-mode.js'

export const CREDENTIALS_PATH = join(homedir(), '.claude', '.credentials.json')
export const USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage'
export const QUOTA_STATE_PATH = join(PROJECT_ROOT, 'store', 'quota-guard.json')

/**
 * How often to check. The seven-day window moves slowly, so a tighter cadence
 * buys nothing and only adds calls to an undocumented endpoint.
 */
export const CHECK_INTERVAL_MS = 20 * 60 * 1000

/** Warn here; still just a message. */
export const WARN_THRESHOLD = 0.70
/** Switch the fleet to eco mode here. */
export const CRITICAL_THRESHOLD = 0.85

/** Don't repeat the same-level alert more often than this. */
export const ALERT_COOLDOWN_SECONDS = 6 * 3600

const SEVEN_DAYS_SECONDS = 7 * 24 * 3600

export type QuotaLevel = 'ok' | 'warning' | 'critical'

export interface QuotaWindow {
  /** Fraction consumed, 0..1. */
  utilization: number
  /** Epoch seconds when the window resets, or null if not reported. */
  resets_at: number | null
}

export interface QuotaUsage {
  five_hour: QuotaWindow | null
  seven_day: QuotaWindow | null
}

export interface QuotaGuardState {
  /** Level of the last alert sent, so a steady 72% does not alert every cycle. */
  last_alert_level: QuotaLevel | null
  last_alert_at: number | null
  /**
   * When the guard last SUCCEEDED at reading usage, and what it read.
   *
   * Recorded on every successful cycle, not only on alerts. Without it the log
   * cannot distinguish "running and fine" from "not running at all" -- both
   * look like silence, and only one of them is good news. That is the same
   * false-green shape we hunt elsewhere, in our own code.
   */
  last_success_at: number | null
  last_utilization: number | null
  /** Consecutive failed reads. Reset to 0 by any success. */
  consecutive_failures: number
  /** When we last alerted about failures, so a dead endpoint alerts once. */
  last_failure_alert_at: number | null
}

export const EMPTY_QUOTA_STATE: QuotaGuardState = {
  last_alert_level: null,
  last_alert_at: null,
  last_success_at: null,
  last_utilization: null,
  consecutive_failures: 0,
  last_failure_alert_at: null,
}

/**
 * Failed reads in a row before the silence itself becomes the alert.
 *
 * Three, because a single miss is ordinary (token refresh, a blip at the
 * endpoint) and 2026-08-02 saw exactly three in a row at 03:09/03:29/03:49
 * that woke nobody. At a 20-minute interval this fires about an hour into a
 * real outage, which is soon enough for a guard whose whole job is to notice.
 */
export const FAILURE_ALERT_THRESHOLD = 3

/**
 * How stale a successful reading may be before the guard is presumed dead.
 *
 * Two intervals: one missed cycle is a blip, two means it has not completed a
 * check in over 40 minutes. Exported so a health check can ask the question
 * without re-deriving the arithmetic.
 */
export function isMeasurementStale(
  state: QuotaGuardState,
  now: number,
  intervalMs = CHECK_INTERVAL_MS,
): boolean {
  if (state.last_success_at === null) return true
  return now - state.last_success_at > (2 * intervalMs) / 1000
}

/**
 * OAuth access token for the usage endpoint.
 *
 * Returns the token or null; it is never logged, never included in an error,
 * and never returned inside a result object. A failure here says only that the
 * credentials were unreadable.
 */
export function readAccessToken(path = CREDENTIALS_PATH): string | null {
  try {
    if (!existsSync(path)) return null
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as { claudeAiOauth?: { accessToken?: unknown } }
    const token = raw?.claudeAiOauth?.accessToken
    return typeof token === 'string' && token.length > 0 ? token : null
  } catch {
    // Deliberately not logging the error object: a JSON parse error can quote
    // the offending region of the file, which is the token.
    logger.warn({ context: { action: 'quota_credentials_unreadable' } }, 'Quota guard: credentials unreadable')
    return null
  }
}

/**
 * Normalise one window from the endpoint's payload.
 *
 * The endpoint is undocumented, so the shape may change without notice. Anything
 * unexpected yields null rather than a plausible-looking zero -- a quota guard
 * that silently reads 0% would keep the fleet running straight through a cap.
 * Percentages arrive as 0-100; anything outside that is rejected.
 */
export function parseWindow(raw: unknown): QuotaWindow | null {
  if (!raw || typeof raw !== 'object') return null
  const w = raw as { utilization?: unknown; resets_at?: unknown }
  const u = typeof w.utilization === 'number' ? w.utilization : NaN
  if (!Number.isFinite(u) || u < 0 || u > 100) return null
  const resets = typeof w.resets_at === 'number'
    ? w.resets_at
    : typeof w.resets_at === 'string' ? Math.floor(Date.parse(w.resets_at) / 1000) : NaN
  return { utilization: u / 100, resets_at: Number.isFinite(resets) ? resets : null }
}

export function parseUsage(raw: unknown): QuotaUsage | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as { five_hour?: unknown; seven_day?: unknown }
  const seven = parseWindow(r.seven_day)
  const five = parseWindow(r.five_hour)
  // seven_day drives every decision; without it there is nothing to act on.
  if (!seven) return null
  return { five_hour: five, seven_day: seven }
}

/**
 * Fetch current usage. Returns null on any failure, having logged it.
 *
 * Loud in the log, silent to the caller's users: an undocumented endpoint will
 * eventually change or go away, and the failure must not be mistaken for "we
 * checked and everything is fine". Neither the token nor the response body is
 * logged -- a body can echo request headers.
 */
export async function fetchUsage(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<QuotaUsage | null> {
  try {
    const res = await fetchImpl(USAGE_ENDPOINT, {
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
    })
    if (!res.ok) {
      logger.warn(
        { context: { action: 'quota_fetch_failed', status: res.status } },
        'Quota guard: usage endpoint returned a non-OK status',
      )
      return null
    }
    const parsed = parseUsage(await res.json())
    if (!parsed) {
      logger.warn(
        { context: { action: 'quota_shape_unexpected' } },
        'Quota guard: usage payload did not match the expected shape -- the endpoint is undocumented and may have changed',
      )
    }
    return parsed
  } catch {
    // The error object is not logged: a fetch error can carry the request,
    // including the Authorization header.
    logger.warn({ context: { action: 'quota_fetch_error' } }, 'Quota guard: usage endpoint unreachable')
    return null
  }
}

export function classify(utilization: number): QuotaLevel {
  if (utilization >= CRITICAL_THRESHOLD) return 'critical'
  if (utilization >= WARN_THRESHOLD) return 'warning'
  return 'ok'
}

/**
 * How far through the window we are, from its reset time. Null when the
 * endpoint did not report one.
 */
export function elapsedFraction(resetsAt: number | null, now: number): number | null {
  if (resetsAt === null) return null
  const remaining = resetsAt - now
  if (!Number.isFinite(remaining)) return null
  const elapsed = SEVEN_DAYS_SECONDS - remaining
  if (elapsed < 0 || elapsed > SEVEN_DAYS_SECONDS) return null
  return elapsed / SEVEN_DAYS_SECONDS
}

/**
 * Advisory sentence comparing consumption to elapsed time.
 *
 * Forecast only, never a trigger -- see the note at the top of the file for why
 * the comparison is unusable as a threshold.
 */
export function forecastText(utilization: number, elapsed: number | null): string {
  if (elapsed === null || elapsed <= 0) return 'No reset time reported, so no pace estimate.'
  const pace = utilization / elapsed
  const pct = (n: number) => `${Math.round(n * 100)}%`
  if (pace > 1.05) {
    return `Pace: ${pct(utilization)} used with ${pct(elapsed)} of the window elapsed -- running ahead, projected ${pct(Math.min(pace, 9.99))} of quota by reset. Forecast only, not the trigger.`
  }
  if (pace < 0.95) {
    return `Pace: ${pct(utilization)} used with ${pct(elapsed)} elapsed -- running behind, on track to finish the window under quota. Forecast only.`
  }
  return `Pace: ${pct(utilization)} used with ${pct(elapsed)} elapsed -- roughly on track. Forecast only.`
}

export interface QuotaGuardResult {
  ok: boolean
  level: QuotaLevel | null
  utilization: number | null
  /** True when this run switched eco mode on. */
  eco_enabled: boolean
  /** True when a message was sent (suppressed by cooldown otherwise). */
  alerted: boolean
  eco: EcoApplyResult | null
  reason: string
  /** Always true: this guard never restarts an agent. */
  restart_required: boolean
}

export interface QuotaGuardDeps {
  readToken?: () => string | null
  fetch?: (token: string) => Promise<QuotaUsage | null>
  enableEco?: () => EcoApplyResult
  ecoAlreadyOn?: () => boolean
  notify?: (text: string) => void
  readState?: () => QuotaGuardState
  writeState?: (s: QuotaGuardState) => void
  now?: number
  /** false = report only: classify but neither switch eco mode nor notify. */
  act?: boolean
}

/**
 * One check cycle. Never throws: this runs on a timer, and a guard that can
 * take down its scheduler is worse than no guard.
 */
export async function runQuotaGuard(deps: QuotaGuardDeps = {}): Promise<QuotaGuardResult> {
  const now = deps.now ?? Math.floor(Date.now() / 1000)
  const base: QuotaGuardResult = {
    ok: false, level: null, utilization: null, eco_enabled: false,
    alerted: false, eco: null, reason: '', restart_required: true,
  }
  try {
    const readState = deps.readState ?? (() => ({ ...EMPTY_QUOTA_STATE }))
    const writeState = deps.writeState ?? (() => {})
    const state = readState()

    const token = (deps.readToken ?? readAccessToken)()
    if (!token) {
      return { ...base, ...recordFailure(state, now, deps, 'no_credentials'), reason: 'no_credentials' }
    }

    const usage = await (deps.fetch ?? ((t: string) => fetchUsage(t)))(token)
    if (!usage?.seven_day) {
      return { ...base, ...recordFailure(state, now, deps, 'usage_unavailable'), reason: 'usage_unavailable' }
    }

    const utilization = usage.seven_day.utilization
    const level = classify(utilization)

    // Alert on a level change, or once the cooldown has passed at the same
    // level. A steady 72% must not produce a message every 15 minutes: noise is
    // how a real alert gets ignored.
    const levelChanged = state.last_alert_level !== level
    const cooledDown = state.last_alert_at === null || now - state.last_alert_at >= ALERT_COOLDOWN_SECONDS
    const shouldAlert = level !== 'ok' && (levelChanged || cooledDown)

    const act = deps.act !== false

    let eco: EcoApplyResult | null = null
    let ecoEnabled = false
    if (act && level === 'critical') {
      const alreadyOn = (deps.ecoAlreadyOn ?? (() => readEcoState().enabled))()
      if (!alreadyOn) {
        eco = (deps.enableEco ?? (() => applyEcoMode(true, DEFAULT_ECO_MODEL)))()
        ecoEnabled = true
      }
    }

    // A successful reading is recorded whether or not it alerts. This is the
    // point of the card: silence must mean "not running", never "running and
    // fine". Written before the alert branch so a notify failure cannot lose
    // the evidence that the check happened.
    const successState: QuotaGuardState = {
      ...state,
      last_success_at: now,
      last_utilization: utilization,
      consecutive_failures: 0,
    }
    writeState(successState)
    logger.info(
      {
        context: {
          action: 'quota_check_ok',
          utilization: Math.round(utilization * 1000) / 1000,
          level,
          resets_at: usage.seven_day.resets_at,
        },
      },
      'Quota guard: usage read successfully',
    )

    if (act && shouldAlert) {
      const pct = Math.round(utilization * 100)
      const forecast = forecastText(utilization, elapsedFraction(usage.seven_day.resets_at, now))
      const head = level === 'critical'
        ? `Subscription quota at ${pct}% of the seven-day window (threshold ${Math.round(CRITICAL_THRESHOLD * 100)}%).`
        : `Subscription quota at ${pct}% of the seven-day window (warning threshold ${Math.round(WARN_THRESHOLD * 100)}%).`
      const action = level === 'critical'
        ? ecoEnabled
          ? ` Eco mode switched on: ${eco?.applied.length ?? 0} agent config(s) rewritten. The change takes effect on each agent's next restart, which this guard does not perform -- scheduling those is yours.`
          : ' Eco mode was already on; nothing changed.'
        : ' No action taken.'
      ;(deps.notify ?? defaultNotify)(`${head}${action} ${forecast}`)
      // Spread over successState, never a fresh object: writing only the alert
      // fields would blank the success trace we just recorded, and the next
      // cycle would report the guard as stale.
      writeState({ ...successState, last_alert_level: level, last_alert_at: now })
    } else if (act && level === 'ok' && state.last_alert_level !== null) {
      // Recovered: clear the alert latch so the next crossing alerts again --
      // but keep the success trace, which is about liveness, not alerting.
      writeState({ ...successState, last_alert_level: null, last_alert_at: null })
    }

    return {
      ok: true, level, utilization, eco_enabled: ecoEnabled,
      alerted: act && shouldAlert, eco, reason: act ? 'checked' : 'reported', restart_required: true,
    }
  } catch (err) {
    logger.error(
      { context: { action: 'quota_guard_failed' }, err: err instanceof Error ? err.message : 'unknown' },
      'Quota guard cycle failed',
    )
    return { ...base, reason: 'error' }
  }
}

/**
 * A failed read: count it, and once the count crosses the threshold, say so.
 *
 * The failure alert is latched on `last_failure_alert_at` so a dead endpoint
 * produces ONE message rather than one every twenty minutes -- the same reason
 * the utilization alert has a cooldown. Recovery clears the counter, and the
 * next outage alerts again.
 *
 * Returns the partial result fields the caller merges in, so the failure path
 * reports what it did rather than looking identical to a silent return.
 */
function recordFailure(
  state: QuotaGuardState,
  now: number,
  deps: QuotaGuardDeps,
  cause: string,
): { alerted: boolean } {
  const writeState = deps.writeState ?? (() => {})
  const failures = (state.consecutive_failures ?? 0) + 1
  const alreadyAlerted = state.last_failure_alert_at !== null
  const shouldAlert = deps.act !== false && failures >= FAILURE_ALERT_THRESHOLD && !alreadyAlerted

  writeState({
    ...state,
    consecutive_failures: failures,
    last_failure_alert_at: shouldAlert ? now : state.last_failure_alert_at,
  })

  logger.warn(
    { context: { action: 'quota_check_failed', cause, consecutive_failures: failures } },
    'Quota guard: usage read failed',
  )

  if (shouldAlert) {
    const lastSuccess = state.last_success_at
    const since = lastSuccess === null
      ? 'there has been no successful reading at all'
      : `the last successful reading was ${Math.round((now - lastSuccess) / 60)} minutes ago`
    ;(deps.notify ?? defaultNotify)(
      `Subscription quota guard has failed ${failures} checks in a row (${cause}); ${since}. ` +
      'The quota is NOT being watched until this clears -- the guard cannot tell you it is fine, only that it cannot look.',
    )
  }

  return { alerted: shouldAlert }
}

function defaultNotify(text: string): void {
  logger.warn({ context: { action: 'quota_alert' } }, text)
  try {
    // Routed to the main agent, who relays to the operator. The guard has no
    // channel of its own and should not grow one.
    createAgentMessage('costops', MAIN_AGENT_ID, `[quota-guard] ${text}`)
  } catch (err) {
    logger.error(
      { context: { action: 'quota_alert_undeliverable' }, err: err instanceof Error ? err.message : 'unknown' },
      'Quota guard: alert could not be queued for the main agent',
    )
  }
}

export function readQuotaState(path = QUOTA_STATE_PATH): QuotaGuardState {
  try {
    if (!existsSync(path)) return { ...EMPTY_QUOTA_STATE }
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<QuotaGuardState>
    return {
      last_alert_level: raw.last_alert_level ?? null,
      last_alert_at: typeof raw.last_alert_at === 'number' ? raw.last_alert_at : null,
      last_success_at: typeof raw.last_success_at === 'number' ? raw.last_success_at : null,
      last_utilization: typeof raw.last_utilization === 'number' ? raw.last_utilization : null,
      consecutive_failures: typeof raw.consecutive_failures === 'number' ? raw.consecutive_failures : 0,
      last_failure_alert_at: typeof raw.last_failure_alert_at === 'number' ? raw.last_failure_alert_at : null,
    }
  } catch {
    return { ...EMPTY_QUOTA_STATE }
  }
}

export function writeQuotaState(state: QuotaGuardState, path = QUOTA_STATE_PATH): void {
  try {
    const tmp = `${path}.tmp`
    writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf-8')
    renameSync(tmp, path)
  } catch (err) {
    logger.warn(
      { context: { action: 'quota_state_write_failed' }, err: err instanceof Error ? err.message : 'unknown' },
      'Quota guard: could not persist alert state (it will re-alert next cycle)',
    )
  }
}

/**
 * Periodic check. Runs once at boot and then on the interval; failures are
 * contained by runQuotaGuard, which never throws.
 */
export function startQuotaGuardTask(intervalMs = CHECK_INTERVAL_MS): NodeJS.Timeout {
  const tick = () => {
    void runQuotaGuard({ readState: () => readQuotaState(), writeState: (s) => writeQuotaState(s) })
  }
  tick()
  return setInterval(tick, intervalMs).unref()
}
