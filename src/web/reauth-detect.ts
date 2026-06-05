// Detect whether a Claude Code agent session needs re-authentication (/login).
//
// Szabi 2026-06-03: surface a "reauth needed" badge on the dashboard agent
// card so an expired login (which silently stops the agent from working) is
// visible at a glance, with a one-click /login button next to it.
//
// We key ONLY on distinctive multi-word strings that Claude Code itself prints
// on an auth failure -- NOT a bare "/login" token, which could appear in a
// user's chat message or an assistant reply and cause a false badge. Pure +
// exported for unit testing against captured pane fixtures.

export interface ReauthState {
  needsReauth: boolean
  reason?: string
}

// Each entry: a distinctive marker Claude Code renders on an auth failure, and
// the short reason surfaced to the UI. Ordered most-specific first.
const REAUTH_MARKERS: { rx: RegExp; reason: string }[] = [
  { rx: /Invalid authentication credentials/i, reason: 'Invalid authentication credentials (401)' },
  { rx: /Please run\s+\/login/i, reason: 'Please run /login' },
  { rx: /Not logged in/i, reason: 'Not logged in' },
  { rx: /\bAPI Error:\s*401\b/i, reason: 'API Error: 401' },
  { rx: /OAuth token (?:has )?expired/i, reason: 'OAuth token expired' },
  { rx: /Invalid API key/i, reason: 'Invalid API key' },
  { rx: /session has expired.*\/login/i, reason: 'Session expired' },
]

// Only scan the live tail of the pane, not the whole scrollback. A real auth
// failure shows in the active error/prompt region at the bottom; scanning the
// full capture would false-positive whenever an agent merely *discusses* these
// strings higher up -- e.g. an agent reviewing THIS code, or a chat about a 401.
// (Caught in review 2026-06-03: the reviewer's own pane was full of these
// markers from reading reauth-detect.ts and would have falsely badged.)
const TAIL_LINES = 15

function tailOf(pane: string, n: number): string {
  const lines = pane.split('\n')
  return lines.slice(Math.max(0, lines.length - n)).join('\n')
}

/**
 * Inspect a captured pane and decide whether the session needs re-auth.
 * Returns { needsReauth:false } for a null/empty pane (capture failed / not
 * running) -- absence of evidence is not evidence of an auth problem. Only the
 * last TAIL_LINES are scanned so scrollback that merely mentions the markers
 * does not trigger a false badge.
 */
export function detectReauthNeeded(pane: string | null | undefined): ReauthState {
  if (!pane) return { needsReauth: false }
  const tail = tailOf(pane, TAIL_LINES)
  for (const m of REAUTH_MARKERS) {
    if (m.rx.test(tail)) return { needsReauth: true, reason: m.reason }
  }
  return { needsReauth: false }
}
