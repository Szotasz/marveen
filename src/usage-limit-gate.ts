// Pure decision logic for the scheduler's pre-injection usage-limit check.
//
// Why it exists: between 2026-09-20T02:19Z and 2026-09-21T03:59Z the main
// session answered 2798 scheduled prompts with "You're out of extra usage ·
// resets 6am (Europe/Budapest)". Claude Code leaves an exhausted session at an
// idle prompt, so the scheduler's readiness check passed every time and the
// prompts kept being typed into a session that could not run any of them. The
// quota gate (quota-gate.ts) could not help: it reads a usage snapshot, and
// there was none. The pane itself was the only evidence, and it was readable.
//
// So before injecting, the runner captures the target pane and asks this
// module. Two rules shape the answer:
//
//   A STALE BANNER MUST NOT STARVE THE SESSION. The banner stays on screen
//   after the window resets, until new output pushes it up. A session that
//   only receives scheduled prompts would then never receive another one: the
//   gate would keep reading the old banner and nothing would ever push it off.
//   So a skip is never open-ended: it lasts USAGE_LIMIT_PROBE_INTERVAL_MS, then
//   ONE prompt goes through as a probe and the window re-arms. A stale banner
//   costs at most one probe interval of skipped rounds; a live limit costs at
//   most one wasted prompt per probe interval, not one per tick.
//
//   The banner's own "resets 6am (...)" tail is deliberately NOT used to size
//   the skip. The gate cannot tell a live banner from a stale one, and a stale
//   "resets 6am" first read at 7am (e.g. after a dashboard restart) names the
//   NEXT 6am: that would hold the session back for 23 hours. A prompt answered
//   by the limit costs no tokens (the reply is synthetic), so an occasional
//   probe is cheap and a day of silence is not.
//
//   FAIL OPEN. No pane (capture failed) means we know nothing, and not knowing
//   never silences the scheduler.
//
// "Approaching ... limit" is a warning with budget still left. It is matched
// by detectsUsageLimit() (the model-fallback runner wants it), but it is not a
// reason to stop the scheduler, so it is let through here.

import { usageLimitBannerLine } from './model-fallback.js'

/** How long one sighting holds injection back before a single probe goes through. */
export const USAGE_LIMIT_PROBE_INTERVAL_MS = 30 * 60_000

/** Per-session memory of one limit episode (one banner wording). */
export interface UsageLimitEpisode {
  /** The banner line that opened the episode; a new wording is a new episode. */
  banner: string
  /** First time this wording was seen on this session (ms). */
  firstSeenAtMs: number
  /** No injection before this moment (ms). */
  skipUntilMs: number
  /** Whether the owner has already been told about this episode. */
  notified: boolean
}

export type UsageLimitGateDecision =
  | { action: 'inject'; reason: 'no-pane' | 'no-banner' | 'warning-only' | 'probe'; episode: UsageLimitEpisode | null }
  | { action: 'skip'; reason: 'usage-limit-screen'; banner: string; skipUntilMs: number; notify: boolean; episode: UsageLimitEpisode }

/**
 * Should a scheduled prompt be injected into this pane right now?
 * `pane` null means the capture failed. `episode` is what the caller kept for
 * this session from the previous decision (null if none); the returned
 * `episode` replaces it.
 */
export function decideUsageLimitGate(input: {
  pane: string | null
  nowMs: number
  episode: UsageLimitEpisode | null
}): UsageLimitGateDecision {
  const { pane, nowMs, episode } = input
  if (pane == null) return { action: 'inject', reason: 'no-pane', episode }

  const banner = usageLimitBannerLine(pane)
  // Banner gone: the episode is over, forget it so a later one notifies again.
  if (!banner) return { action: 'inject', reason: 'no-banner', episode: null }
  if (/approaching/i.test(banner)) return { action: 'inject', reason: 'warning-only', episode: null }

  if (!episode || episode.banner !== banner) {
    const skipUntilMs = nowMs + USAGE_LIMIT_PROBE_INTERVAL_MS
    const fresh: UsageLimitEpisode = { banner, firstSeenAtMs: nowMs, skipUntilMs, notified: true }
    return { action: 'skip', reason: 'usage-limit-screen', banner, skipUntilMs, notify: true, episode: fresh }
  }

  if (nowMs >= episode.skipUntilMs) {
    // Let one prompt through: either the limit has lifted and the banner is
    // stale (the prompt's own output will push it off), or it has not and this
    // is the only prompt wasted until the next probe.
    return { action: 'inject', reason: 'probe', episode: { ...episode, skipUntilMs: nowMs + USAGE_LIMIT_PROBE_INTERVAL_MS } }
  }

  return {
    action: 'skip', reason: 'usage-limit-screen', banner, skipUntilMs: episode.skipUntilMs,
    notify: !episode.notified, episode: { ...episode, notified: true },
  }
}
