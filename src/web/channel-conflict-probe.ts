// Telegram 409 Conflict probe. Used by channel-monitor to confirm and LOG the
// real cause of a channel disconnect, instead of inferring it from a pane-grep.
//
// Background (2026-06-01, Szabi explicit request): the existing health monitor
// flags the plugin as "down" based on pane scanning - it does not record what
// the upstream provider actually returned. When the cause is the orphan-poller
// race fixed by PR #225 (and now stage-3 in the same PR), Telegram returns
//
//   409 Conflict
//   { "ok": false, "error_code": 409,
//     "description": "Conflict: terminated by other getUpdates request;
//       make sure that only one bot instance is running" }
//
// on every getUpdates call. Without that log line in dashboard.log, an
// operator (Szabi) cannot distinguish a real network/hardware issue from the
// orphan-poller bug. This module probes the upstream HTTP API directly with
// a short-timeout getUpdates call when the monitor first sees a down state,
// so the dashboard.log carries explicit evidence of the 409.

import { logger } from '../logger.js'

export interface TelegramConflictResult {
  conflicted: boolean
  status: number
  description: string | null
}

// Short timeout: this runs on the dashboard monitor's poll path. A network-
// hung Telegram API must NOT delay the next iteration of the check loop.
const PROBE_TIMEOUT_MS = 4_000

/**
 * Issues a single bounded getUpdates call against Telegram and reports
 * whether the upstream signalled a 409 Conflict. Used ONLY for diagnostics:
 * the result is logged, the channel state is not modified here. Returns
 * `conflicted: false` for any non-conflict outcome (success, network error,
 * other 4xx/5xx) so the caller can pick its own escalation.
 */
export async function probeTelegramConflict(token: string): Promise<TelegramConflictResult> {
  if (!token) return { conflicted: false, status: 0, description: null }

  // offset=-1 + timeout=0 = fetch the most recent update without long-poll.
  // This is the cheapest call that still triggers the 409 if another poller
  // holds the slot.
  const url = `https://api.telegram.org/bot${token}/getUpdates?offset=-1&timeout=0`

  const controller = new AbortController()
  const timeoutHandle = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)

  try {
    const res = await fetch(url, { signal: controller.signal })
    const status = res.status
    let description: string | null = null
    try {
      const body = await res.json() as { description?: string; error_code?: number }
      description = body.description ?? null
    } catch {
      // Telegram is consistent about returning JSON even on errors, but a
      // proxy/CDN interposition could yield non-JSON. Ignore and continue
      // with status alone.
    }
    return { conflicted: status === 409, status, description }
  } catch (err) {
    logger.warn({ err }, 'probeTelegramConflict: HTTP probe failed (network/timeout)')
    return { conflicted: false, status: 0, description: null }
  } finally {
    clearTimeout(timeoutHandle)
  }
}
