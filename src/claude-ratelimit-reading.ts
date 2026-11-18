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
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { probePlanUsage, usageFromProbe, type ProbeResult } from './claude-plan-usage-probe.js'
import { activeReadingFromProbe, exhaustedReadingFrom429 } from './claude-plan-rotate-heartbeat.js'

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

async function main(): Promise<void> {
  const token = process.env[TOKEN_ENV] ?? ''
  delete process.env[TOKEN_ENV]
  const out: RateLimitReading = token
    ? readingFromProbe(await probePlanUsage(token, { timeoutMs: 8_000 }), Date.now())
    : { ok: false, reason: `no token in ${TOKEN_ENV}` }
  process.stdout.write(JSON.stringify(out) + '\n')
}

const isMain = (() => {
  try { return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url)) } catch { return false }
})()
if (isMain) await main()
