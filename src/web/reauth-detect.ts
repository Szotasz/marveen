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
  // Not a token failure: Claude Code's FIRST-RUN picker, shown when
  // ~/.claude.json lost hasCompletedOnboarding. It blocks the TUI exactly like
  // a dead login (2026-07-15 bootcamp "mass /login": the on-disk credential was
  // valid the whole time) and needs the same owner-visible badge/escalation.
  // A monitored respawn self-heals it via ensureSharedClaudeOnboarded().
  { rx: /Select login method/i, reason: 'First-run onboarding picker (Select login method)' },
  // The state the picker advances into when something blindly hits Enter on it
  // (e.g. channels.sh's first-run guard): a browser OAuth prompt no headless
  // box can complete. Same first-run-gate family, same restart heal.
  { rx: /Use the url below to sign in|Paste code here if prompted/i, reason: 'Browser sign-in screen (first-run gate)' },
  { rx: /Invalid authentication credentials/i, reason: 'Invalid authentication credentials (401)' },
  // ISSUE2817 (marveen#2817, measured on a customer install): the main session failed ~10 h with
  // "OAuth token revoked · Please run /login". Ahead of the generic "/login" marker, so the reason names the cause
  // (a revoked token needs a new setup-token, not a quota wait).
  { rx: /OAuth token (?:has been )?revoked/i, reason: 'OAuth token revoked' },
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
  return lastTurnErrorLine(pane)
}

// ISSUE2817 (3), measured 2026-11-16 on Claude Code 2.1.325 with an invalid OAuth token in a throwaway config: a
// turn that fails on auth renders its error as the reply, and the completed-turn line sits between it and the box:
//   ❯ say hi
//   (blank)
//   ⏺ Please run /login · API Error: 401 OAuth access token is invalid.
//   (blank)
//   ✻ Worked for 2s · done 9:55 AM
//   (blank)
//   ──────── (the input box)
// liveStatusRegion() reads only the one line above the box (here a blank), so the failure was invisible and a
// customer's main session failed ~10 h with no owner alert (marveen#2817). So the LAST turn's reply (the lines
// between the last submitted prompt and the box) is read too, under two conditions together (Dani's review of
// #2823: an agent's own reply line such as "⏺ API Error: 401 came back from Stripe" or a "● Not logged in: ..."
// bullet must not count):
//  1. the error IS the whole reply: its first content line is the error, and no other reply line opens with a
//     content glyph (⏺ / ●); only the "✻ ..." completed-turn line and wrapped continuation lines may follow;
//  2. that line is Claude Code's own error composite: "Please run /login", "OAuth token revoked/expired", or
//     "API Error: 401" followed by Claude Code's own continuation ("OAuth access token is invalid", {"type":"error").
// A stale failure above a newer prompt (e.g. "❯ /login" and its "Login successful") is outside the block.
const LAST_TURN_MAX_LINES = 40
const PROMPT_LINE_RX = /^[❯>]\s+\S/
const CONTENT_GLYPH_RX = /^\s*[⏺●]/
const DONE_LINE_RX = /^\s*✻ /
const LAST_TURN_ERROR_MARKERS: { rx: RegExp; reason: string }[] = [
  { rx: /^[\s⏺●⎿]*OAuth token (?:has been )?revoked\b/i, reason: 'OAuth token revoked' },
  { rx: /^[\s⏺●⎿]*OAuth token (?:has )?expired\b/i, reason: 'OAuth token expired' },
  { rx: /^[\s⏺●⎿]*(?:Not logged in\s*[·∙•]\s*)?Please run\s+\/login\b/i, reason: 'Please run /login' },
  { rx: /^[\s⏺●⎿]*API Error:\s*401\b.*(?:OAuth access token is invalid|\{"type":"error")/i, reason: 'API Error: 401' },
]

function lastTurnErrorLine(pane: string): ReauthState {
  const lines = pane.split('\n')
  const borders: number[] = []
  for (let i = lines.length - 1; i >= 0 && borders.length < 2; i--) {
    if (BOX_BORDER_RX.test(lines[i])) borders.push(i)
  }
  if (borders.length < 2) return { needsReauth: false }
  const top = Math.min(borders[0], borders[1])
  let start = -1
  for (let i = top - 1; i >= Math.max(0, top - LAST_TURN_MAX_LINES); i--) {
    if (PROMPT_LINE_RX.test(lines[i])) { start = i; break }
  }
  if (start < 0) return { needsReauth: false }
  const block = lines.slice(start + 1, top)
  if (ESCALATION_QUOTE_MARKERS.some((rx) => block.some((l) => rx.test(l)))) return { needsReauth: false }
  const content = block.filter((l) => l.trim() !== '' && !DONE_LINE_RX.test(l))
  if (content.length === 0) return { needsReauth: false }
  // Condition 1: the error is the whole reply (no second content-glyph line after it).
  if (content.slice(1).some((l) => CONTENT_GLYPH_RX.test(l))) return { needsReauth: false }
  // Condition 2: the first line is Claude Code's own error composite.
  for (const m of LAST_TURN_ERROR_MARKERS) {
    if (m.rx.test(content[0])) return { needsReauth: true, reason: m.reason }
  }
  return { needsReauth: false }
}
