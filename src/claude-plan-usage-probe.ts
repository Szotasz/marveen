// Live per-plan usage probe (Settings -> Claude plans, "Check now").
//
// Why a probe at all: the rotation heartbeat (claude-plan-rotate-heartbeat.ts)
// only ever observes the plan an agent is CURRENTLY on, via usage-collect.py.
// An idle plan's "last known %" is therefore frozen at whatever it was when it
// was last active -- possibly days ago -- and estimateWindowFree() has to guess
// from that. A token-mode plan's raw CLAUDE_CODE_OAUTH_TOKEN is in the vault,
// so its live state can be read directly: one minimal Messages API call
// returns the account's unified rate-limit headers.
//
// MEASURED 2026-09-24 against real tokens: a POST /v1/messages with
// `Authorization: Bearer <oauth token>` + `anthropic-beta: oauth-2025-04-20`
// answers with
//   anthropic-ratelimit-unified-status              allowed | ...
//   anthropic-ratelimit-unified-5h-utilization      "0.35"   (0..1 fraction)
//   anthropic-ratelimit-unified-5h-reset            unix seconds
//   anthropic-ratelimit-unified-5h-status
//   anthropic-ratelimit-unified-7d-utilization / -reset / -status
//   anthropic-ratelimit-unified-representative-claim
// An exhausted key answers with an error (HTTP 429); its headers are parsed
// too when present, because "this key is at 100% until X" is exactly the
// state the operator wants to see.
//
// Token hygiene: the token only ever travels in the outgoing request's
// Authorization header. It is never part of a returned value, an error
// message, or a log line -- every error below is a fixed string plus an HTTP
// status, and a caught fetch exception's own message is deliberately dropped
// (not inspected, not forwarded).
//
// Split in two like quota-snapshot.ts: a pure header parser (unit-tested with
// plain header maps) and a thin IO function with an injectable fetch.
import type { ClaudePlan } from './web/claude-plans.js'
import type { ClaudePlansState, ObservedPlanState } from './web/claude-plans-state.js'

export interface UsageWindow {
  /** 0..100 (the header's 0..1 fraction x 100), same unit as ObservedPlanWindow. */
  usedPercent: number
  /** Unix epoch SECONDS. */
  resetsAt: number
  /** Per-window status header verbatim (e.g. "allowed", "rejected"), or null. */
  status: string | null
}

export interface PlanUsage {
  fiveHour: UsageWindow | null
  sevenDay: UsageWindow | null
  /** anthropic-ratelimit-unified-status verbatim, or null when absent. */
  overallStatus: string | null
  representativeClaim: string | null
}

/** Anything with a case-insensitive `get` -- the fetch Headers object, or a
 *  test's plain Map wrapper. */
export interface HeaderLookup {
  get(name: string): string | null
}

const H = 'anthropic-ratelimit-unified-'

function finiteNumber(raw: string | null): number | null {
  if (raw === null || raw.trim() === '') return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

function nonEmpty(raw: string | null): string | null {
  return raw !== null && raw.trim() !== '' ? raw.trim() : null
}

function parseWindow(headers: HeaderLookup, key: '5h' | '7d'): UsageWindow | null {
  const utilization = finiteNumber(headers.get(`${H}${key}-utilization`))
  const resetsAt = finiteNumber(headers.get(`${H}${key}-reset`))
  // Both are required: a percentage without its reset boundary cannot feed
  // estimateWindowFree() (it would never "expire"), and a reset without a
  // percentage says nothing about headroom.
  if (utilization === null || resetsAt === null) return null
  return {
    // Rounded to 0.01 to shed float noise (0.35 * 100 = 35.00000000000001).
    usedPercent: Math.round(utilization * 100 * 100) / 100,
    resetsAt: Math.floor(resetsAt),
    status: nonEmpty(headers.get(`${H}${key}-status`)),
  }
}

/**
 * Pure: unified rate-limit headers -> PlanUsage, or null when the response
 * carries none of them (an API-key account, a proxy that strips them, a
 * non-Anthropic error page) -- "no data" must never read as "0% used".
 */
export function parseUnifiedRateLimitHeaders(headers: HeaderLookup): PlanUsage | null {
  const fiveHour = parseWindow(headers, '5h')
  const sevenDay = parseWindow(headers, '7d')
  const overallStatus = nonEmpty(headers.get(`${H}status`))
  if (!fiveHour && !sevenDay && overallStatus === null) return null
  return {
    fiveHour,
    sevenDay,
    overallStatus,
    representativeClaim: nonEmpty(headers.get(`${H}representative-claim`)),
  }
}

export type ProbeErrorKind =
  | 'invalid_token' // 401
  | 'rate_limited' // 429 -- `usage` is still filled when headers were present
  | 'network' // fetch threw, or the timeout fired
  | 'http_error' // any other non-2xx
  | 'no_usage_headers' // 2xx but no unified headers at all

export type ProbeResult =
  | { ok: true; httpStatus: number; usage: PlanUsage }
  | { ok: false; error: ProbeErrorKind; message: string; httpStatus?: number; usage?: PlanUsage }

export const PROBE_URL = 'https://api.anthropic.com/v1/messages'
export const PROBE_MODEL = 'claude-haiku-4-5-20251001'
export const PROBE_TIMEOUT_MS = 15_000

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

/**
 * One minimal Messages API call with `token`, returning the parsed usage or a
 * typed error. Never throws. Never puts the token in the result.
 */
export async function probePlanUsage(
  token: string,
  opts: { fetchImpl?: FetchLike; timeoutMs?: number } = {},
): Promise<ProbeResult> {
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((url, init) => fetch(url, init))
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? PROBE_TIMEOUT_MS)
  let res: Response
  try {
    res = await fetchImpl(PROBE_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'oauth-2025-04-20',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: PROBE_MODEL,
        max_tokens: 5,
        messages: [{ role: 'user', content: 'hi' }],
      }),
      signal: controller.signal,
    })
  } catch {
    // The exception's own message is dropped on purpose: nothing about it is
    // needed to act, and forwarding third-party error text is how secrets
    // leak into logs.
    return {
      ok: false,
      error: 'network',
      message: controller.signal.aborted ? 'Probe timed out' : 'Network error while probing',
    }
  } finally {
    clearTimeout(timer)
  }

  // The body (a 5-token reply, or an error JSON) is not needed; release the
  // connection without reading it.
  try { await res.body?.cancel() } catch { /* already consumed/closed */ }

  const usage = parseUnifiedRateLimitHeaders(res.headers)
  const httpStatus = res.status

  if (httpStatus === 401) {
    return { ok: false, error: 'invalid_token', message: 'Token rejected (401)', httpStatus }
  }
  if (httpStatus === 429) {
    return {
      ok: false,
      error: 'rate_limited',
      message: 'Plan is rate limited (429)',
      httpStatus,
      ...(usage ? { usage } : {}),
    }
  }
  if (httpStatus < 200 || httpStatus >= 300) {
    return {
      ok: false,
      error: 'http_error',
      message: `Unexpected HTTP ${httpStatus}`,
      httpStatus,
      ...(usage ? { usage } : {}),
    }
  }
  if (!usage) {
    return { ok: false, error: 'no_usage_headers', message: 'Response carried no rate-limit headers', httpStatus }
  }
  return { ok: true, httpStatus, usage }
}

/** The usage a probe result carries, if any (success, or a 429 with headers). */
export function usageFromProbe(result: ProbeResult): PlanUsage | null {
  return result.ok ? result.usage : (result.usage ?? null)
}

export const PROBE_SOURCE = 'probe'

/**
 * Pure: turn a probe result into the ObservedPlanState to store for that plan.
 *
 * - With usage: a fresh observation (windows from the headers), lastProbe ok
 *   or rate_limited.
 * - Without usage (401, network, ...): the PREVIOUS observation's windows are
 *   kept untouched -- a failed check is not evidence the quota changed -- and
 *   only `lastProbe` records the failure, so the dashboard can say "token
 *   rejected" and the throttle still counts the attempt.
 */
export function observationFromProbe(
  result: ProbeResult,
  previous: ObservedPlanState | undefined,
  nowMs: number,
): ObservedPlanState {
  const usage = usageFromProbe(result)
  const lastProbe = {
    at: nowMs,
    ok: result.ok,
    ...(result.ok ? {} : { error: result.error }),
    ...(result.ok || result.httpStatus === undefined ? {} : { httpStatus: result.httpStatus }),
  }
  if (!usage) {
    return {
      observedAt: previous?.observedAt ?? 0,
      source: previous?.source ?? PROBE_SOURCE,
      windows: previous?.windows ?? {},
      ...(previous?.overallStatus ? { overallStatus: previous.overallStatus } : {}),
      lastProbe,
    }
  }
  const windows: ObservedPlanState['windows'] = {}
  if (usage.fiveHour) {
    windows.five_hour = {
      usedPercent: usage.fiveHour.usedPercent,
      resetsAt: usage.fiveHour.resetsAt,
      ...(usage.fiveHour.status ? { status: usage.fiveHour.status } : {}),
    }
  }
  if (usage.sevenDay) {
    windows.seven_day = {
      usedPercent: usage.sevenDay.usedPercent,
      resetsAt: usage.sevenDay.resetsAt,
      ...(usage.sevenDay.status ? { status: usage.sevenDay.status } : {}),
    }
  }
  return {
    observedAt: nowMs,
    source: PROBE_SOURCE,
    windows,
    ...(usage.overallStatus ? { overallStatus: usage.overallStatus } : {}),
    lastProbe,
  }
}

/** Minimum gap between two background probes of the same plan. */
export const PROBE_MIN_INTERVAL_MS = 30 * 60_000

/** Most recent time anything (heartbeat observation or probe attempt) looked
 *  at this plan, epoch ms; 0 when never. */
export function lastCheckedAt(observed: ObservedPlanState | undefined): number {
  if (!observed) return 0
  return Math.max(observed.observedAt || 0, observed.lastProbe?.at || 0)
}

/**
 * Pure: which plans the background refresh should probe this tick.
 *
 * - Fewer than 2 plans: none. A single-plan install has nothing to rotate to,
 *   so it gets exactly zero new network calls from this (design 6.2).
 * - Only token-mode plans: a configDir plan has no token this code may read.
 * - Never the plan `activeAgentId` is currently on: the heartbeat already
 *   observes that one through usage-collect.py every tick.
 * - Throttled: skipped while its last check (success OR failure) is younger
 *   than `minIntervalMs`, so an invalid token is not retried every tick.
 */
export function selectPlansToProbe(input: {
  plans: ClaudePlan[]
  state: ClaudePlansState
  activeAgentId: string
  nowMs: number
  minIntervalMs?: number
}): ClaudePlan[] {
  const { plans, state, activeAgentId, nowMs } = input
  const minIntervalMs = input.minIntervalMs ?? PROBE_MIN_INTERVAL_MS
  if (plans.length < 2) return []
  const activePlanId = state.activePlanByAgent[activeAgentId]
  return plans.filter((p) => {
    if (!p.tokenSecretId) return false
    if (p.id === activePlanId) return false
    return nowMs - lastCheckedAt(state.plans[p.id]) >= minIntervalMs
  })
}
