// The last-resort Claude usage reading for scripts/usage-collect.py (#2839).
//
// usage-collect.py runs this entry ONLY when the usage endpoint, the
// statusLine side file and (after a transient failure) the fresh
// authoritative cache all gave nothing. It must never run while a fresh
// authoritative cache is usable: that cache is what the plan rotation sees,
// and a header reading would replace it (the caller enforces the order; a
// test in scripts/__tests__/usage-collect.test.py pins it).
//
// One minimal Messages call (probePlanUsage) reads the unified rate-limit
// headers; a 429 the headers do not explain goes through the rotation's own
// rule (exhaustedReadingFrom429), so both read an exhausted plan the same way.
//
// Contract: the token comes in the CLAUDE_RATELIMIT_TOKEN environment
// variable (never argv), and stdout is one JSON line:
//   {"ok":true,"windows":{"five_hour":{used_percent,resets_at,status},"seven_day":{...}}}
//   {"ok":false,"reason":"<fixed text, never the token>"}
// The exit code is 0 either way; anything else is a crash the caller reports.
//
// QUOTAHDRROT1118: under plan rotation (claude-plan-rotation-mode.ts) the token
// usage-collect.py hands over is the host's default login, which need not be
// the plan the main agent is on. A trusted 'ratelimit_headers' reading of that
// account would then stand in for the active plan in the quota gate, so the
// entry does not call the API at all there: it answers ok:false with a fixed
// reason, and usage-collect.py falls back to its estimate (an untrusted source,
// the gate stays open and says it is blind). The rotation reads the active
// plan with its own token (claude-plan-rotate-check-run.ts).
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { probePlanUsage, usageFromProbe, type ProbeResult } from './claude-plan-usage-probe.js'
import { activeReadingFromProbe, exhaustedReadingFrom429 } from './claude-plan-rotate-heartbeat.js'
import { planRotationInEffect } from './claude-plan-rotation-mode.js'
import { readClaudePlans } from './web/claude-plans.js'

export const TOKEN_ENV = 'CLAUDE_RATELIMIT_TOKEN'

interface OutWindow { used_percent: number; resets_at: number; status: string | null }
export type RateLimitReading =
  | { ok: true; windows: { five_hour: OutWindow; seven_day?: OutWindow } }
  | { ok: false; reason: string }

/** Pure: a probe result -> the reading usage-collect.py stores (window keys and units as the usage endpoint's). */
export function readingFromProbe(result: ProbeResult, nowMs: number): RateLimitReading {
  const usage = usageFromProbe(result)
  const reading = activeReadingFromProbe(usage, 'ratelimit_headers')
    ?? (!result.ok && result.error === 'rate_limited'
      ? exhaustedReadingFrom429({ usage, retryAfterSec: result.retryAfterSec, nowMs, source: 'ratelimit_headers' })
      : null)
  if (!reading) {
    return { ok: false, reason: result.ok ? 'no 5h window in the rate-limit headers' : `${result.error} (HTTP ${result.httpStatus ?? '-'})` }
  }
  const win = (w: { usedPercent: number; resetsAt: number; status?: string }): OutWindow =>
    ({ used_percent: w.usedPercent, resets_at: w.resetsAt, status: w.status ?? null })
  return { ok: true, windows: { five_hour: win(reading.fiveHour), ...(reading.sevenDay ? { seven_day: win(reading.sevenDay) } : {}) } }
}

export const ROTATION_SKIP_REASON = 'plan rotation in effect: the host login may not be the active plan'
export const PLANS_UNREADABLE_REASON = 'plan registry unreadable: plan rotation may be in effect'

/**
 * The reading for one run: no call without a token or under plan rotation, else one probe.
 * A plans read that throws counts as "rotation may be in effect" (no call): reading it as off would
 * let the host login stand in for the active plan, which is what this skip exists to prevent.
 */
export async function readRateLimits(token: string, nowMs: () => number = Date.now): Promise<RateLimitReading> {
  if (!token) return { ok: false, reason: `no token in ${TOKEN_ENV}` }
  let plans: ReturnType<typeof readClaudePlans>
  try { plans = readClaudePlans() } catch { return { ok: false, reason: PLANS_UNREADABLE_REASON } }
  if (planRotationInEffect(plans)) return { ok: false, reason: ROTATION_SKIP_REASON }
  return readingFromProbe(await probePlanUsage(token, { timeoutMs: 8_000 }), nowMs())
}

async function main(): Promise<void> {
  const token = process.env[TOKEN_ENV] ?? ''
  delete process.env[TOKEN_ENV]
  const out = await readRateLimits(token)
  process.stdout.write(JSON.stringify(out) + '\n')
}

const isMain = (() => {
  try { return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url)) } catch { return false }
})()
if (isMain) await main()
