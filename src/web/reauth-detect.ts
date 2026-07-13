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

// Self-quote guard (found 2026-07-13: 5 false escalations in ~18h, each
// shortly after the alert text was pasted back into the chat). The healer's
// own escalation message embeds the raw marker `reason` string verbatim, e.g.
// "... jelez (Please run /login) ...". Once that message is quoted back into
// the pane -- the owner forwarding it, the dashboard rendering it, or the
// agent discussing the bug -- it re-matches REAUTH_MARKERS against its own
// alert and re-fires, forever. These substrings are unique to
// buildEscalationMessage / buildQuietSummaryMessage in reauth-healer.ts and
// never appear in a real Claude Code CLI auth failure.
const ESCALATION_QUOTE_MARKERS: RegExp[] = [
  /ágens halott OAuth tokent jelez/i,
  /Manuális browser \/login kell a dashboardon/i,
]

function tailOf(pane: string, n: number): string {
  const lines = pane.split('\n')
  return lines.slice(Math.max(0, lines.length - n)).join('\n')
}

// A 15-line tail is still too coarse for a *transcript* line that scrolls with
// the conversation. Devy 2026-07-12: an agent that hit an expired token, then
// ran /login and got "Login successful", still carried the older
// "Not logged in - Please run /login" transcript result inside the tail window
// -- and the dashboard badged a healthy, logged-in agent.
//
// Claude Code renders a *live status line* directly above the input box, and
// that line -- not the scrolling transcript -- is what tracks auth state: it
// reads "Not logged in - Run /login" while broken and flips to the context
// readout once login succeeds. So when the pane has the box UI, scan only that
// live region and ignore the transcript above it. Panes without the box (print
// mode, plain captures, unit fixtures) keep the tail heuristic.
const BOX_BORDER_RX = /─{10,}/

/**
 * The live status region: the status line + the input box + the hint lines
 * under it. Returns null when the pane has no input box to anchor on.
 */
function liveStatusRegion(pane: string): string | null {
  const lines = pane.split('\n')
  const borders: number[] = []
  for (let i = lines.length - 1; i >= 0 && borders.length < 2; i--) {
    if (BOX_BORDER_RX.test(lines[i])) borders.push(i)
  }
  if (borders.length < 2) return null
  const top = Math.min(borders[0], borders[1])
  return lines.slice(Math.max(0, top - 1)).join('\n')
}

/**
 * Inspect a captured pane and decide whether the session needs re-auth.
 * Returns { needsReauth:false } for a null/empty pane (capture failed / not
 * running) -- absence of evidence is not evidence of an auth problem. Scans the
 * live status region when the pane has Claude Code's input box, else falls back
 * to the last TAIL_LINES, so scrollback that merely mentions the markers does
 * not trigger a false badge. A region that is itself a quote of a prior
 * escalation message is also excluded (see ESCALATION_QUOTE_MARKERS).
 */
export function detectReauthNeeded(pane: string | null | undefined): ReauthState {
  if (!pane) return { needsReauth: false }
  const region = liveStatusRegion(pane) ?? tailOf(pane, TAIL_LINES)
  if (ESCALATION_QUOTE_MARKERS.some((rx) => rx.test(region))) return { needsReauth: false }
  for (const m of REAUTH_MARKERS) {
    if (m.rx.test(region)) return { needsReauth: true, reason: m.reason }
  }
  return { needsReauth: false }
}
