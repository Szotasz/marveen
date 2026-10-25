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

// The `top - 1` narrowing above was too tight, and it cost us a 40-day outage.
//
// itzhakstern 2026-09-09: the token expired, so Claude Code answered EVERY
// incoming prompt with "Login expired · Please run /login" -- but the live
// status line kept showing an ordinary context readout (`~158k uncached`),
// because the session itself was alive and only the API calls were rejected.
// The refusal sat 4 lines above the box top (marker, `✻ Worked for 0s`, a blank
// line), so the one-line window never saw it. The healer ran, inspected the
// agent, and reported nothing wrong for 40 days.
//
// So the region has to reach back over the last transcript lines. Bounded, and
// well under the ~20-line gap the scrollback fixtures rely on, so an agent that
// merely DISCUSSES these markers higher up still does not badge.
const TRANSCRIPT_LOOKBACK = 10

// What makes the wider window safe is this, not the narrow region: proof that a
// login round-trip completed AFTER the failure.
//
// That is the actual difference between the two panes we keep confusing. Devy
// 2026-07-12 (recovered): stale refusal, then `/login`, then "Login successful".
// Itzhak 2026-09-09 (broken): the refusal, and nothing after it but a spinner.
// Position alone never distinguished them -- recovery does.
//
// Kept deliberately NARROW to one explicit string. The tempting generalisation
// is "any later tool output means the session works", but Itzhak's pane HAS
// later output (`Worked for 0s`) while being completely dead: every prompt was
// refused. A loose recovery signal would re-create exactly the blindness this
// change removes, so a new entry here needs a captured pane behind it.
//
// ANCHORED to the tool-result prefix, and that anchor is the load-bearing part
// (review 2026-09-23). A bare /Login successful/i is a suppressor: anything in
// the lookback window that merely CONTAINS the phrase -- an agent narrating
// this very fix, a healer alert quoted back, a review comment -- silently
// cancels a real badge. This file has already been bitten twice by exactly that
// (2026-06-03 reviewer's own pane, 2026-07-13 escalation self-loop), and both
// times the marker side was hardened while the recovery side stayed prose.
//
// Claude Code renders a completed /login as a tool result, so every captured
// recovery line we have carries the `⎿` prefix; narration never does.
//
// The trade-off is deliberate and asymmetric: if some future pane renders
// recovery WITHOUT the prefix, we badge an agent that already healed -- noisy,
// visible, self-correcting on the next capture. Unanchored, the failure is a
// dead agent nobody hears about, which is the 40-day outage this change exists
// to end. Prefer the false alarm.
const RECOVERY_RX = /⎿\s*Login successful/i

/**
 * The live status region: the last transcript lines + the status line + the
 * input box + the hint lines under it. Returns null when the pane has no input
 * box to anchor on.
 */
function liveStatusRegion(pane: string): string | null {
  const lines = pane.split('\n')
  const borders: number[] = []
  for (let i = lines.length - 1; i >= 0 && borders.length < 2; i--) {
    if (BOX_BORDER_RX.test(lines[i])) borders.push(i)
  }
  if (borders.length < 2) return null
  const top = Math.min(borders[0], borders[1])
  return lines.slice(Math.max(0, top - 1 - TRANSCRIPT_LOOKBACK)).join('\n')
}

// Bounded above by TRANSCRIPT_LOOKBACK, so a refusal that has scrolled further
// than that is still invisible. 10 covers the one pane we actually captured
// (distance 4) with margin, and stays under the ~20-line gap the scrollback
// fixtures rely on. It is a heuristic pending a real capture, NOT a settled
// constant: a marker at distance 11-19 would be missed today.

/**
 * Index of the LAST line matching `rx`, or -1.
 *
 * Line granularity, which relies on an invariant worth stating: in every pane
 * captured so far each auth marker and each recovery line sits alone on its own
 * line. If a future marker can share a line with a recovery string, ordering
 * within that line becomes invisible here and this needs character offsets.
 */
function lastLineMatching(lines: string[], rx: RegExp): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (rx.test(lines[i])) return i
  }
  return -1
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

  const lines = region.split('\n')

  // Where the newest auth complaint sits, across ALL markers -- not just the
  // first one that happens to match. Devy's stale line carries two of them
  // ("Not logged in" and "Please run /login"); judging recovery against only
  // the first would be arbitrary.
  let lastFailure = -1
  for (const m of REAUTH_MARKERS) {
    lastFailure = Math.max(lastFailure, lastLineMatching(lines, m.rx))
  }
  if (lastFailure < 0) return { needsReauth: false }

  // A completed login AFTER the newest complaint means the agent already healed
  // itself; the complaint is scrollback. Before the complaint it means nothing.
  if (lastLineMatching(lines, RECOVERY_RX) > lastFailure) return { needsReauth: false }

  // Reason still comes from the most-specific-first ordering, not from position,
  // so the text surfaced to the owner does not change with pane layout.
  for (const m of REAUTH_MARKERS) {
    if (m.rx.test(region)) return { needsReauth: true, reason: m.reason }
  }
  return { needsReauth: false }
}
