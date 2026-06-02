// Pure-logic detector for a tmux pane running Claude Code.
//
// Motivation: the scheduler used a single regex (`/esc to interrupt/`) to
// decide whether a target session could accept a new prompt. Between a
// user turn's submission and the spinner's first render there is a frame-
// scale window where the footer shows only `⏵⏵ bypass permissions on
// (shift+tab to cycle)` WITHOUT the `· esc to interrupt` suffix. A
// scheduler tick landing in that window mis-detected "ready", called
// sendPromptToSession, and the prompt sat in the input buffer until the
// post-send retry gave up. The new detector:
//
//   - Recognises a wider range of positive busy indicators (spinner
//     glyph labels + token-count pattern + tool-use mid-turn lines)
//     so the frame-level footer gap no longer yields a false positive.
//   - Returns a discrete state so the caller can distinguish idle /
//     busy / typing / unknown and react per state.
//
// The module has ZERO imports so it is trivially unit-testable against
// captured pane fixtures. The I/O (capture-pane + double-sample) lives
// in src/web.ts alongside the rest of the scheduler.

export type PaneState = 'idle' | 'busy' | 'typing' | 'unknown' | 'error'

// Claude Code shows the footer in one of two modes: the default "bypass"
// permissions mode (permissive) and the "strict" mode. Both are "idle"
// surfaces. If neither is visible the pane is not a recognised Claude
// Code surface and we report 'unknown' rather than guess.
//
// The bypass-mode footer has known trailing variants after the
// "bypass permissions on" prefix: the original "(shift+tab to cycle)"
// hint, and the background-shells indicator which Claude Code
// substitutes when one or more BashTool background shells are running
// in the session. The background-shells indicator itself comes in two
// shapes depending on whether the tasks panel is visible:
//   - tasks visible:  "· N shells · ctrl+t to hide tasks · ↓ to manage"
//   - tasks hidden:   "· N shells · ↓ to manage"
// All variants must classify as idle, otherwise sessions that spawn
// background shells (gh poll, file watchers, long-running build) get
// stuck pending forever.
//
// The shells-variant requires either the "· ctrl+t" marker or the
// "· ↓ to manage" tail after the shell count, rather than just the
// bare "· N shell(s)" prefix. Two reasons:
//   (a) one of these tails is always what Claude Code actually renders,
//       so insisting on either rejects malformed or mid-render frames;
//   (b) it disambiguates the footer from scrollback content that
//       happens to contain "bypass permissions on · 1 shell" verbatim
//       (an echoed log line, a quoted message, etc.) which would
//       otherwise be misread as idle.
const IDLE_FOOTER_RX = /bypass permissions on(?: \(shift\+tab to cycle\)| · \d+ shells? · (?:ctrl\+t|↓ to manage))|\? for shortcuts/

// Positive busy signals. ANY match anywhere in the pane means the turn
// is mid-flight, even if the footer looks idle for a frame.
//
// Deliberately narrow: only signals that disappear THE MOMENT a turn
// ends. Two failure modes we explicitly avoid:
//
//   (A) Scrollback persistence. Tool-use summary lines (`Searched for /
//       Listed / Read`) stay rendered above the input box after the
//       turn ends, and Claude Code never overwrites them. A regex
//       matching those would starve the scheduler forever.
//
//   (B) Prose false positive. The standalone word "Thinking…" or
//       "Crafting…" could legitimately appear in Claude's reply text
//       (Markdown headings, list items, quoted content). Matching the
//       label alone would read that prose as mid-turn. To avoid this
//       we require the label to be followed by the parenthesised
//       runtime marker `(Ns · ↓` -- an UI chrome signature that
//       cannot appear in reply text.
//
// The load-bearing signal is the tokens-down-arrow pattern `(Ns · ↓N`,
// which every extended-thinking turn renders regardless of spinner
// label. `esc to interrupt` is the footer-scoped fallback. A future
// Claude Code release that renames the spinner labels will miss the
// label regex but still be caught by the tokens pattern.
const BUSY_INDICATORS: RegExp[] = [
  /\besc to interrupt\b/,
  // Tokens-down-arrow counter: "(52s · ↓ 2.6k tokens ..." Turn-scoped,
  // overwritten with whitespace the moment the turn completes.
  /\(\s*\d+s\s*·\s*↓\s*\d/,
  // Known spinner labels paired with the turn-scoped `(Ns · ↓` tail on
  // the same line. The tail requirement kills the "Thinking…" prose
  // false positive. Non-exhaustive by design; the bare tokens pattern
  // above is the authoritative fallback.
  /\b(?:Combobulating|Beaming|Thinking|Pondering|Reticulating|Configuring|Noodling|Ruminating|Percolating|Cogitating|Deliberating|Contemplating|Musing|Brewing|Synthesizing|Distilling|Refining|Simmering|Crafting|Formulating|Consulting|Unfurling|Unspooling|Unraveling)…\s*\(\s*\d+s\s*·\s*↓/,
]

// Pasted-text placeholder. Claude Code lifts bursts of input keys into
// `[Pasted text #N +X chars]` stubs, which sit in the input buffer and
// never auto-submit on Enter. Treat as busy so the scheduler doesn't pile
// a second prompt on top.
const PENDING_PASTE_RX = /\[Pasted text #\d+/

// Input-box separator lines are made of U+2500 BOX DRAWINGS LIGHT
// HORIZONTAL. At least 10 in a run to ignore stray `-` glyphs.
const BOX_SEP_RX = /^─{10,}/

// Prompt line inside the input box. `❯` followed by at least one tab/
// space and then a non-whitespace character means the user (or a
// send-keys that didn't submit) parked text there. Single-line match
// ([ \t] not \s) to avoid crossing into the next line.
const PARKED_INPUT_RX = /❯[ \t]+\S/

// Persistent Anthropic thinking-block API error. When an assistant turn
// ends with a 400 about thinking/redacted_thinking blocks that "cannot
// be modified", the session is wedged: every subsequent prompt re-sends
// the same context and yields the identical 400. The pane shows the idle
// footer (turn "finished") plus a past-tense thinking stamp but NO live
// busy indicator, so detectPaneState would otherwise classify it 'idle'
// and the scheduler/router would keep injecting -- each injection
// another doomed 400. Surfacing this as a distinct 'error' state makes
// isReadyForPrompt() return false so injection stops, and lets the
// channel monitor alert that a manual reset is needed.
//
// Three guards, ALL required, to avoid flagging a healthy session that
// merely quotes the error text (a bug-report message, a log analysis):
//
//   (a) Position scope: only the "live tail" (the lines just above the
//       idle footer) is inspected, never deep scrollback. A long-ago
//       turn's error echo above the live region is ignored. The footer
//       is found from the BOTTOM (the live footer is always the last
//       line of the pane) so a footer-looking string quoted higher up
//       in scrollback does not shift the scope.
//   (b) Chrome glyph: the error must render as a tool-output line
//       `⎿  API Error: <code>` -- the U+23BF result glyph Claude Code
//       prints before a turn-level error. Prose that quotes "API Error
//       400" in a message body has no leading `⎿  API Error: <num>`.
//   (c) Specific phrase: the thinking-block signature `cannot be
//       modified` together with `thinking` or `redacted_thinking`. A
//       generic API error (rate limit, overloaded) is NOT this class.
//
// (b) and (c) are required WITHIN ONE CHROME BLOCK (the chrome line plus
// its wrapped continuation), not anywhere in the joined tail. Otherwise
// a benign `⎿ API Error: 429` on one line plus an unrelated "thinking
// ... cannot be modified" prose on another line would AND-combine into
// a false positive on a healthy session.
const ERROR_CHROME_RX = /⎿\s*API Error:\s*\d+/
const ERROR_THINKING_PHRASE_RX = /cannot be modified/
const ERROR_THINKING_KIND_RX = /\b(?:redacted_thinking|thinking)\b/

// How many lines above the idle footer count as the "live tail". The
// error output (the `⎿` line + its wrapped continuation), the thinking
// stamp, and the input box together span well under 20 lines; 20 gives
// margin for terminal re-flow without reaching deep scrollback.
const ERROR_LIVE_TAIL_LINES = 20

// How many lines a single API-error render spans: the `⎿` chrome line
// plus its wrapped continuation. The thinking-block message is long and
// the terminal wraps it; at ~80 cols "cannot be modified" lands on the
// 2nd line, at ~60 cols on the 3rd-4th. 4 covers narrow panes while
// staying short enough that an adjacent unrelated chrome block does not
// bleed in (the decoupled-benign test pins this boundary).
const ERROR_BLOCK_LINES = 4

/**
 * True when the pane is wedged in the persistent thinking-block API
 * error described above. Scoped to the live tail above the idle footer
 * so a quoted error string in scrollback or a message body does not
 * trigger a false positive. Returns false when there is no idle footer
 * (the pane is busy or not a recognised Claude Code surface).
 */
export function detectsThinkingBlockError(pane: string): boolean {
  if (!pane) return false
  const lines = pane.split('\n')
  // Find the footer from the bottom: the live footer is the last line of
  // the pane, so a footer-looking line quoted in scrollback must not win.
  let footerIdx = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (IDLE_FOOTER_RX.test(lines[i])) { footerIdx = i; break }
  }
  if (footerIdx < 0) return false
  const start = Math.max(0, footerIdx - ERROR_LIVE_TAIL_LINES)
  const tail = lines.slice(start, footerIdx)
  // The chrome glyph and the thinking-block phrase+kind must co-occur
  // within ONE chrome block, not be scattered across the tail.
  for (let i = 0; i < tail.length; i++) {
    if (!ERROR_CHROME_RX.test(tail[i])) continue
    const block = tail.slice(i, i + ERROR_BLOCK_LINES).join('\n')
    if (ERROR_THINKING_PHRASE_RX.test(block) && ERROR_THINKING_KIND_RX.test(block)) {
      return true
    }
  }
  return false
}

export interface DetectPaneStateOptions {
  /** If true, the 'typing' state (text parked in input box) is
   * merged into 'busy'. Default false -- callers that care about
   * "user actively composing" vs "mid-turn" can distinguish. */
  mergeTypingAsBusy?: boolean
}

/**
 * Classify a raw `tmux capture-pane -p` string into a pane state.
 *
 * Algorithm, in order:
 *   1. Empty / whitespace-only -> 'unknown'.
 *   2. Any BUSY_INDICATOR matches anywhere -> 'busy'. This includes the
 *      wider spinner/token-count fallbacks that catch the frame-level
 *      footer gap.
 *   3. No idle footer visible -> 'unknown' (pane is not Claude Code).
 *   4. Wedged thinking-block API error in the live tail -> 'error'.
 *      Checked after the busy guard (a live turn is never 'error') and
 *      after the footer guard (an 'error' surface still shows the
 *      footer) so the scheduler/router stop injecting doomed prompts.
 *   5. Pending paste placeholder -> 'busy'.
 *   6. Text parked inside the bottom input box -> 'typing'.
 *   7. Otherwise -> 'idle'.
 */
export function detectPaneState(
  pane: string,
  opts: DetectPaneStateOptions = {},
): PaneState {
  if (!pane || !pane.trim()) return 'unknown'

  for (const rx of BUSY_INDICATORS) {
    if (rx.test(pane)) return 'busy'
  }

  if (!IDLE_FOOTER_RX.test(pane)) return 'unknown'

  if (detectsThinkingBlockError(pane)) return 'error'

  if (PENDING_PASTE_RX.test(pane)) return 'busy'

  // Find the input box: two BOX_SEP_RX lines framing the current prompt.
  // Scan UPWARDS from the footer so we stay inside the live box and
  // don't pick up historical ❯ lines from scrollback.
  const lines = pane.split('\n')
  const footerIdx = lines.findIndex(l => IDLE_FOOTER_RX.test(l))
  if (footerIdx >= 0) {
    let bottomSep = -1
    for (let i = footerIdx - 1; i >= 0; i--) {
      if (BOX_SEP_RX.test(lines[i])) { bottomSep = i; break }
    }
    let topSep = -1
    if (bottomSep > 0) {
      for (let i = bottomSep - 1; i >= 0; i--) {
        if (BOX_SEP_RX.test(lines[i])) { topSep = i; break }
      }
    }
    if (topSep >= 0 && bottomSep > topSep) {
      const inputLines = lines.slice(topSep + 1, bottomSep)
      if (inputLines.some(l => PARKED_INPUT_RX.test(l))) {
        return opts.mergeTypingAsBusy ? 'busy' : 'typing'
      }
    }
  }

  return 'idle'
}

/**
 * True when the pane is in the specific "accepting a new prompt" state.
 * 'typing' counts as not-ready because the user has unsubmitted text
 * in the input box and a new prompt would concatenate into it.
 */
export function isReadyForPrompt(pane: string): boolean {
  return detectPaneState(pane) === 'idle'
}

// Locate the live Claude Code input box and return its inner content as
// one string. Bounded strictly to the region between the two most
// recent BOX_SEP_RX separators above the idle footer, so a parked input
// in scrollback (post-turn artifact) is never mistaken for live state.
//
// Returns null when the pane does not have a live input box (no idle
// footer, only one separator, etc.) -- callers should treat null as
// "not enough signal to act, do nothing".
function liveInputBox(pane: string): string | null {
  const lines = pane.split('\n')
  const footerIdx = lines.findIndex(l => IDLE_FOOTER_RX.test(l))
  if (footerIdx < 0) return null
  let bottomSep = -1
  for (let i = footerIdx - 1; i >= 0; i--) {
    if (BOX_SEP_RX.test(lines[i])) { bottomSep = i; break }
  }
  if (bottomSep <= 0) return null
  let topSep = -1
  for (let i = bottomSep - 1; i >= 0; i--) {
    if (BOX_SEP_RX.test(lines[i])) { topSep = i; break }
  }
  if (topSep < 0) return null
  return lines.slice(topSep + 1, bottomSep).join('\n')
}

// Marker strings from prompt-safety.ts preambles. We do NOT import them
// to keep this module dependency-free for unit testing; the markers
// here are stable opening phrases pinned to the first sentence of each
// preamble. A prompt-safety.ts test pins the preamble shape so a rename
// will surface as a failing test there, not here.
//
// Each regex requires an extended opening fragment so prose that
// merely echoes the marker ("Let me search for TEAM MEMBER NOTICE in
// the logs", "SECURITY NOTICE -- read carefully before deploying")
// does not trigger a false-positive clear. The longer tail
// (`<trusted-peer source` / `before acting`) is unique enough that a
// random typed sentence is implausible to reproduce it verbatim.
// Whitespace classes (`\s+`) intentionally include newline so a
// terminal-wrapped preamble (TUI re-flow at narrow widths) still
// matches -- that wrapped preamble is the genuine article, not a
// false-positive.
const TRUSTED_PREAMBLE_MARKER = /TEAM MEMBER NOTICE\s+--\s+the next\s+<trusted-peer\s+source/
const UNTRUSTED_PREAMBLE_MARKER = /SECURITY NOTICE\s+--\s+read carefully before acting/

// A "real" opening tag has source="<alphanumeric/colon/underscore/dash>",
// because sanitizeAgentSource() (prompt-safety.ts) strips every other
// character. The preambles themselves reference the tag shape with
// source="..." (three literal full stops), which sanitizeAgentSource
// would scrub -- so a literal "..." source can only originate from the
// preamble text, never from a real wrapped message. Distinguishing on
// the source content is what lets us tell a stale preamble (no real
// tag yet) from a fully-landed message (real tag with a sanitised
// source).
const REAL_OPENING_TAG_RX = /<(?:trusted-peer|untrusted)\s+source="[A-Za-z0-9:_-]+"/

/**
 * Returns true when the pane likely has just-sent text sitting in the
 * Claude Code prompt buffer that the trailing Enter never submitted --
 * i.e. a stuck-after-send-keys state from which a retry-Enter is
 * warranted.
 *
 * Two stuck signatures are handled:
 *
 *   1. A `[Pasted text #N]` placeholder visible in the input box. Claude
 *      Code's bracketed-paste detector lifts long bursts of input into
 *      stubs that do not auto-submit on the trailing Enter. The
 *      placeholder shape is unambiguous, so any occurrence inside the
 *      live input box is treated as stuck.
 *
 *   2. A verbatim payload sitting in the input box. The detector
 *      requires `payloadHint` to be a substring of the live input box's
 *      content, so a parked input the operator typed manually is not
 *      mistaken for a stuck send. The minimum hint length is
 *      configurable via opts.minHintChars (default 16) to keep short
 *      hints from false-positiving on common UI text.
 *
 * Negative cases (returns false):
 *
 *   - The pane is busy (spinner / token counter / esc-to-interrupt) --
 *     the prompt is being processed, no retry needed.
 *   - The pane is not a Claude Code surface (no idle footer found).
 *   - The input box is empty and no paste placeholder is visible.
 *   - The verbatim path is requested but `payloadHint` is shorter than
 *     `minHintChars` (caller passed a too-short hint).
 *
 * @param pane The raw `tmux capture-pane -p` output to inspect.
 * @param payloadHint A substring of the prompt just sent. Used by the
 *   verbatim-detection path; pass an empty string to limit the check
 *   to the placeholder path only.
 * @param opts.minHintChars Minimum length the hint must reach before
 *   the verbatim path is attempted. Default 16.
 */
export function shouldRetrySubmit(
  pane: string,
  payloadHint: string,
  opts: { minHintChars?: number } = {},
): boolean {
  if (!pane || !pane.trim()) return false

  // Busy pane: the turn is mid-flight, no retry needed.
  for (const rx of BUSY_INDICATORS) {
    if (rx.test(pane)) return false
  }
  // Without an idle footer the pane is either not Claude Code or in an
  // unknown render state. Be conservative and skip.
  if (!IDLE_FOOTER_RX.test(pane)) return false

  const inputBox = liveInputBox(pane)
  if (inputBox == null) return false

  // Path 1: placeholder is unambiguous, retry regardless of hint.
  if (PENDING_PASTE_RX.test(inputBox)) return true

  // Path 2: verbatim payload parked in the input box.
  // Clamp the minimum hint length to >= 1. minHintChars=0 paired with
  // an empty payloadHint would otherwise let `inputBox.includes("")`
  // return true for every non-empty box, retrying Enter on every idle
  // pane. Non-finite inputs (NaN, Infinity) fall back to the default
  // so a malformed caller can't silently disable or saturate the
  // verbatim path either.
  const rawMin = opts.minHintChars
  const safeMin = typeof rawMin === 'number' && Number.isFinite(rawMin) ? rawMin : 16
  const minHint = Math.max(safeMin, 1)
  if (payloadHint.length < minHint) return false
  return inputBox.includes(payloadHint)
}

/**
 * Returns true when the pane shows a stale preamble from a wrapped
 * message that never fully landed -- a `SECURITY NOTICE` (untrusted) or
 * `TEAM MEMBER NOTICE` (trusted-peer) preamble visible in the input
 * box without a matching real opening tag (`<untrusted source="...">`
 * or `<trusted-peer source="...">` with a sanitised source value).
 *
 * When this returns true the caller must issue a buffer-clear (Ctrl-U)
 * before sending the next message. Otherwise a fresh prompt would be
 * concatenated onto the stale preamble and the receiving agent could
 * inherit its trust semantics: e.g. an untrusted external payload
 * landing behind a stale `TEAM MEMBER NOTICE` preamble could be read
 * as if it came from a trusted peer.
 *
 * The check is scoped strictly to the live input box (between the two
 * most recent box-separators above the idle footer). A preamble in
 * deep scrollback (a long-ago turn's artifact) never triggers a clear.
 *
 * Distinguishing a stale preamble from a fully-landed message relies
 * on the source-attribute content: real wrapped messages always carry
 * a sanitised `source="agent:NAME"` (or similar) value, while the
 * preambles themselves only reference the tag shape with the literal
 * placeholder `source="..."`. The literal three full stops are
 * impossible to produce from `sanitizeAgentSource()`, so their
 * presence proves we are looking at preamble text rather than a real
 * opening tag.
 */
export function shouldClearTruncatedPreamble(pane: string): boolean {
  if (!pane) return false
  const inputBox = liveInputBox(pane)
  if (inputBox == null) return false

  const hasPreamble =
    TRUSTED_PREAMBLE_MARKER.test(inputBox) ||
    UNTRUSTED_PREAMBLE_MARKER.test(inputBox)
  if (!hasPreamble) return false

  // A real opening tag means the wrapped content landed -- not stuck.
  if (REAL_OPENING_TAG_RX.test(inputBox)) return false

  return true
}

export type SubmitFollowupAction = 'retry-enter' | 'done' | 'give-up'

/**
 * Decide what the post-send-keys loop should do next, given the
 * current pane snapshot and how many retry-Enter attempts have already
 * been made. Returns one of three discrete actions so the caller can
 * branch without re-running the detection logic itself.
 *
 *   - 'done'        -- the prompt landed (or the pane is busy
 *                      processing); no further action.
 *   - 'retry-enter' -- the pane shows a stuck send; send another Enter
 *                      and re-sample.
 *   - 'give-up'     -- the retry budget is spent, or the capture failed
 *                      and we cannot tell whether retry would help.
 *                      Caller should log a warning and move on.
 *
 * Splitting the decision out as pure logic keeps the I/O-bound loop in
 * src/web/agent-process.ts trivially testable without mocking tmux or
 * child_process: feed snapshot strings + attempt counters in, assert
 * the action out.
 *
 * @param pane         The most recent capture-pane snapshot, or null
 *                     if the capture itself failed.
 * @param payloadHint  Substring of the just-sent prompt, used for the
 *                     verbatim-stuck detection path. Pass empty to
 *                     restrict detection to the placeholder path.
 * @param attempt      How many retry-Enters have ALREADY been sent
 *                     (0 on the first decision after the initial send).
 * @param maxAttempts  How many retry-Enters the caller is willing to
 *                     send total. The decision returns 'give-up' once
 *                     attempt >= maxAttempts and the pane is still
 *                     stuck.
 */
export function decideSubmitFollowup(
  pane: string | null,
  payloadHint: string,
  attempt: number,
  maxAttempts: number,
): SubmitFollowupAction {
  if (pane == null) return 'give-up'
  if (!shouldRetrySubmit(pane, payloadHint)) return 'done'
  if (attempt >= maxAttempts) return 'give-up'
  return 'retry-enter'
}

export interface PaneErrorAlertState {
  /** When the session was first observed in the error state during the
   * current spell, or null when there is no active spell. */
  firstSeenAt: number | null
  /** When the last alert was sent for this session, or null if never. */
  lastAlertAt: number | null
  /** When the session was last observed in the error state. Used to
   * keep a spell alive across brief non-error blips (a flapping
   * capture, or a busy spinner mid-flight) so the confirm window is
   * not reset to zero by a single non-error tick. */
  lastErrorAt: number | null
}

export interface PaneErrorAlertThresholds {
  /** How long the session must stay in error before the first alert, so
   * a transient one-tick error that clears on its own is not reported. */
  confirmMs: number
  /** Minimum gap between repeated alerts within one unbroken error
   * spell, so a wedged session does not alert on every monitor tick. */
  dedupMs: number
  /** How long the session must be continuously error-free before an
   * active spell is cleared. A single non-error tick (null capture, a
   * mid-flight busy spinner) must NOT reset the spell, otherwise a
   * genuinely wedged but flapping session never reaches the confirm
   * window and never alerts. */
  clearMs: number
}

export interface PaneErrorAlertDecision {
  alert: boolean
  next: PaneErrorAlertState
}

/**
 * Pure state machine for "should the monitor alert that this session is
 * wedged in the thinking-block error". Dependency-free so it is
 * unit-testable without tmux or timers: feed the current error
 * observation, the previous persisted state and a clock, get back the
 * alert decision plus the next state to persist.
 *
 * Deliberately ALERT-only -- it never decides to reset or restart a
 * session. Auto-reset destroys the agent's in-context working memory,
 * and while the deep trigger is not fully understood a false positive
 * must not nuke a healthy agent. A human (or the hub agent) acts on the
 * alert. Guards that keep it quiet: the first sighting only records
 * (never alerts, so an error must be seen on at least two ticks even
 * when confirmMs is 0), a confirm window (the error must persist), and a
 * dedup window (one alert per spell, not per tick). A non-error tick
 * does NOT immediately end a spell -- it ends only after clearMs of
 * continuous error-free time, so a flapping capture (null / mid-flight
 * busy between error frames) cannot starve the confirm window. A
 * future-dated stored timestamp (wall-clock skew, NTP correction)
 * restarts the spell instead of stalling the deltas negative.
 */
export function decidePaneErrorAlert(
  isError: boolean,
  prev: PaneErrorAlertState,
  now: number,
  thresholds: PaneErrorAlertThresholds,
): PaneErrorAlertDecision {
  if (!isError) {
    // No active spell: nothing to track.
    if (prev.firstSeenAt === null) {
      return { alert: false, next: { firstSeenAt: null, lastAlertAt: null, lastErrorAt: null } }
    }
    // Active spell: clear only after a sustained error-free gap, so a
    // single flapping non-error tick does not reset the confirm window.
    // A future-dated lastErrorAt (clock skew) counts as "clear now".
    const errorFreeFor = prev.lastErrorAt === null ? Infinity : now - prev.lastErrorAt
    if (errorFreeFor >= thresholds.clearMs || errorFreeFor < 0) {
      return { alert: false, next: { firstSeenAt: null, lastAlertAt: null, lastErrorAt: null } }
    }
    // Hold the spell unchanged.
    return { alert: false, next: { ...prev } }
  }
  // First sighting in this spell: record only, never alert. Guarantees
  // at least two observations before any alert, independent of confirmMs.
  if (prev.firstSeenAt === null) {
    return { alert: false, next: { firstSeenAt: now, lastAlertAt: prev.lastAlertAt, lastErrorAt: now } }
  }
  // Clock skew: a stored timestamp in the future relative to now would
  // drive the deltas negative and stall the machine silently. Restart
  // the spell from now and drop the stale alert time.
  if (now < prev.firstSeenAt || (prev.lastAlertAt !== null && now < prev.lastAlertAt)) {
    return { alert: false, next: { firstSeenAt: now, lastAlertAt: null, lastErrorAt: now } }
  }
  const sustained = now - prev.firstSeenAt >= thresholds.confirmMs
  if (!sustained) {
    return { alert: false, next: { firstSeenAt: prev.firstSeenAt, lastAlertAt: prev.lastAlertAt, lastErrorAt: now } }
  }
  const dedupElapsed = prev.lastAlertAt === null || now - prev.lastAlertAt >= thresholds.dedupMs
  if (dedupElapsed) {
    return { alert: true, next: { firstSeenAt: prev.firstSeenAt, lastAlertAt: now, lastErrorAt: now } }
  }
  return { alert: false, next: { firstSeenAt: prev.firstSeenAt, lastAlertAt: prev.lastAlertAt, lastErrorAt: now } }
}

// A stable signature of the text parked in the live input box, or null
// when the pane is not in the 'typing' (parked-input) state.
//
// Used by the stuck-input watcher to decide whether a swallowed Enter on
// the channel-notification path left a message stranded in the prompt
// box. Whitespace is collapsed so a cursor blink or a terminal re-flow at
// a different width does not read as "new text" and reset the recovery
// confirm window. Returns null (not an empty string) when there is no
// parked text so callers can branch on "is anything parked at all".
export function stuckInputSignature(pane: string): string | null {
  if (detectPaneState(pane) !== 'typing') return null
  const box = liveInputBox(pane)
  if (box == null) return null
  const sig = box.replace(/\s+/g, ' ').trim()
  return sig.length > 0 ? sig : null
}

// Per-session bookkeeping for the stuck-input recovery watcher. A "spell"
// is one continuous stretch of the SAME text parked in the input box.
export interface StuckInputState {
  /** Signature of the parked text for the active spell, or null when no
   * spell is active (the box is empty / the pane is busy). */
  parkedSig: string | null
  /** When the active spell was first observed. */
  firstSeenAt: number | null
  /** When the last recovery Enter was sent in this spell, or null. */
  lastRecoverAt: number | null
  /** How many recovery Enters have been sent in the active spell. */
  attempts: number
}

export interface StuckInputThresholds {
  /** How long the SAME text must stay parked before the first recovery
   * Enter, so a turn that is about to submit on its own (frame race) is
   * not pre-empted and a human mid-typing is left alone. */
  confirmMs: number
  /** Minimum gap between recovery Enters within one spell, so a pane
   * that ignores the Enter is not hammered every tick. */
  dedupMs: number
  /** Max recovery Enters per spell before giving up (caller logs). A
   * pane still stuck after this is not the swallowed-Enter case the
   * watcher targets; further Enters would not help. */
  maxAttempts: number
}

export interface StuckInputDecision {
  recover: boolean
  next: StuckInputState
}

const NO_STUCK_INPUT: StuckInputState = {
  parkedSig: null,
  firstSeenAt: null,
  lastRecoverAt: null,
  attempts: 0,
}

/**
 * Pure decision for "should the watcher send a recovery Enter to this
 * session". Dependency-free so it is unit-testable without tmux or
 * timers: feed the current parked-input signature (from
 * stuckInputSignature), the previous persisted state and a clock, get
 * back whether to send Enter plus the next state to persist.
 *
 * The channel-notification path (inbound Telegram/Slack delivered by the
 * plugin) does not go through sendPromptToSession, so its post-send
 * Enter-retry budget cannot cover a swallowed Enter there. This watcher
 * is the backstop: it detects the symptom (text stranded in the prompt
 * box) and re-submits.
 *
 * Guards that keep it from firing on healthy panes:
 *   - A new or CHANGED parked signature restarts the confirm window
 *     (record-only), so text that is still arriving / being edited and a
 *     turn that submits on its own are never pre-empted. With confirmMs
 *     > 0 this also guarantees at least two observations before any Enter.
 *   - A confirm window: the same text must persist for confirmMs.
 *   - A dedup window between Enters, and a maxAttempts cap per spell.
 *   - Backwards clock skew (a future stored timestamp) restarts the
 *     spell instead of stalling the deltas negative.
 *
 * @param parkedSig   Signature of the parked input now, or null when the
 *                    pane is not in the parked-input state.
 * @param prev        Previously persisted state for this session.
 * @param now         Current clock (ms).
 * @param thresholds  Confirm / dedup / maxAttempts knobs.
 */
export function decideStuckInputRecovery(
  parkedSig: string | null,
  prev: StuckInputState,
  now: number,
  thresholds: StuckInputThresholds,
): StuckInputDecision {
  // Nothing parked: end any active spell.
  if (parkedSig === null) {
    return { recover: false, next: { ...NO_STUCK_INPUT } }
  }
  // New spell, or the parked text changed (still arriving / edited /
  // a different message): restart the confirm window, record only.
  if (prev.parkedSig !== parkedSig || prev.firstSeenAt === null) {
    return { recover: false, next: { parkedSig, firstSeenAt: now, lastRecoverAt: null, attempts: 0 } }
  }
  // Backwards clock skew: a stored timestamp in the future relative to
  // now would drive the deltas negative and stall. Restart the spell.
  if (now < prev.firstSeenAt || (prev.lastRecoverAt !== null && now < prev.lastRecoverAt)) {
    return { recover: false, next: { parkedSig, firstSeenAt: now, lastRecoverAt: null, attempts: 0 } }
  }
  // Retry budget spent: hold without acting.
  if (prev.attempts >= thresholds.maxAttempts) {
    return { recover: false, next: { ...prev } }
  }
  // Confirm window not yet elapsed.
  if (now - prev.firstSeenAt < thresholds.confirmMs) {
    return { recover: false, next: { ...prev } }
  }
  // Dedup gap between recovery Enters.
  if (prev.lastRecoverAt !== null && now - prev.lastRecoverAt < thresholds.dedupMs) {
    return { recover: false, next: { ...prev } }
  }
  return {
    recover: true,
    next: { parkedSig, firstSeenAt: prev.firstSeenAt, lastRecoverAt: now, attempts: prev.attempts + 1 },
  }
}

// =============================================================================
// Stuck tool-call watcher (2026-06-02 incident, Worked-for >Ns freeze)
// =============================================================================
//
// Symptom: Marveen's TUI shows "Worked for 31s" (or "Brewed for", "Baked for")
// indefinitely. The claude process is at 0.3% CPU (IO-wait, no progress), bun
// poller is alive, hasChannelPluginAlive() returns true -- so the recovery
// cascade gated on bun absence (#240) never fires. Real cause: the Telegram
// reply tool-call hung server-side without a client-side timeout, taking the
// TUI render loop with it.
//
// Detection: parse the `Worked for Ns` line. If the SAME tag+seconds is
// observed across `confirmPolls` consecutive polls AND `seconds >= freezeSeconds`,
// the tool-call is frozen and the session needs a hard restart. The tag must
// stay the same too (different verb / restart of the counter means progress).

/**
 * Parse the TUI's "Worked / Brewed / Baked / Cooking / Simmered for Ns"
 * footer if present. Returns null when the pane is not in a tool-call
 * waiting state (no tool-call line, or it just changed verb).
 *
 * The verb is part of the signature so that a TUI transition from "Brewed"
 * to "Worked" -- which actually IS progress, the tool-call moved to a new
 * phase -- resets the stuck-spell.
 */
export interface ToolCallProgressSignature {
  tag: string
  seconds: number
}

const TOOL_CALL_PROGRESS_RX = /(?:✻\s*)?(Worked|Brewed|Baked|Cooking|Simmered|Sauteed|Sauted)\s+for\s+(\d+)s/i

export function stuckToolCallSignature(pane: string): ToolCallProgressSignature | null {
  const m = pane.match(TOOL_CALL_PROGRESS_RX)
  if (!m) return null
  const tag = m[1]!.toLowerCase()
  const seconds = parseInt(m[2]!, 10)
  if (!Number.isFinite(seconds) || seconds < 0) return null
  return { tag, seconds }
}

export interface StuckToolCallState {
  /** Current tool-call tag we are watching (e.g. "worked"), or null if no spell active. */
  tag: string | null
  /** The seconds value observed when the spell started -- preserved for the
   * audit log so an operator can tell at what counter value the freeze happened. */
  spellStartSeconds: number | null
  /** When the spell was first observed (ms). */
  firstSeenAt: number | null
  /** Last observed seconds value, used to detect stagnation across polls. */
  lastSeconds: number | null
  /** Consecutive polls in which the seconds value did NOT increase. */
  stagnantPolls: number
  /** Wall-clock timestamp (ms) at which the counter first stopped advancing
   * in this spell, or null if the counter is currently progressing. This is
   * the load-bearing measurement for the freeze decision: a wedged TUI keeps
   * displaying the same `<verb> for Ns` regardless of real time, so we
   * measure freeze duration in WALL CLOCK from stagnantSince, NOT from the
   * displayed counter value. (PR #246 review fix, 2026-06-02: the prior
   * version gated on sig.seconds >= freezeSeconds and so could never fire on
   * a counter frozen at <180s -- exactly the 2026-06-02 06:41 incident shape
   * where it sat at 31s.) */
  stagnantSince: number | null
  /** Recoveries fired in this spell (cap at 1 -- a respawn is the only
   * action, and the next sweep observes the new pane fresh). */
  attempts: number
}

export interface StuckToolCallThresholds {
  /** How long the TUI counter must remain stagnant in WALL-CLOCK terms
   * before we conclude the render loop is wedged. A healthy long-running
   * tool-call increments the counter every TUI redraw (~once per second),
   * so a counter that holds the same value for >= this many ms is wedged
   * regardless of what value it holds. The previous "displayed-value
   * threshold" reading was the PR #246 review bug. */
  freezeSeconds: number
  /** How many consecutive polls of NON-INCREASING seconds count as
   * "the TUI render loop is wedged" (anti-fluke). A real tool-call
   * increments every TUI redraw, so multi-poll stagnation is conclusive.
   * Composed WITH the wall-clock freezeSeconds check -- BOTH must hold. */
  stagnantPolls: number
}

export interface StuckToolCallDecision {
  recover: boolean
  next: StuckToolCallState
}

const NO_STUCK_TOOL_CALL: StuckToolCallState = {
  tag: null,
  spellStartSeconds: null,
  firstSeenAt: null,
  lastSeconds: null,
  stagnantPolls: 0,
  stagnantSince: null,
  attempts: 0,
}

/**
 * Pure decision: should the watcher respawn this session because the TUI
 * tool-call counter has stopped advancing for too long?
 *
 * Load-bearing measurement is WALL-CLOCK stagnation duration, NOT the
 * displayed counter value. A wedged TUI keeps showing the same
 * `<verb> for Ns` regardless of real time; gating on `sig.seconds >=
 * freezeSeconds` (PR #246 review bug, 2026-06-02) would miss exactly the
 * incident shape the watchdog is built for (counter frozen at 31s, never
 * reaches 180s, never recovers).
 *
 * Guards against false positives on legitimate long tool-calls:
 *   - Wall-clock stagnation `(now - stagnantSince) >= freezeSeconds`. A
 *     healthy long-running call increments the counter every TUI redraw,
 *     so stagnantSince keeps resetting to null and the duration never
 *     accumulates. A wedged TUI lets it accumulate.
 *   - Anti-fluke: stagnantPolls >= thresholds.stagnantPolls (two
 *     consecutive non-incrementing observations), composed AND with the
 *     wall-clock check.
 *   - Recovery is one-shot per spell (attempts cap at 1). The next sweep
 *     reads a fresh pane after the respawn.
 *   - A tag change (e.g. Brewed -> Worked) or counter increment resets
 *     the spell -- both are genuine progress.
 */
export function decideStuckToolCallRecovery(
  sig: ToolCallProgressSignature | null,
  prev: StuckToolCallState,
  now: number,
  thresholds: StuckToolCallThresholds,
): StuckToolCallDecision {
  // No tool-call line: end any spell.
  if (sig === null) {
    return { recover: false, next: { ...NO_STUCK_TOOL_CALL } }
  }
  // Spell start, OR tag changed (a verb change is genuine progress).
  if (prev.tag !== sig.tag || prev.firstSeenAt === null) {
    return {
      recover: false,
      next: {
        tag: sig.tag,
        spellStartSeconds: sig.seconds,
        firstSeenAt: now,
        lastSeconds: sig.seconds,
        stagnantPolls: 0,
        stagnantSince: null,
        attempts: 0,
      },
    }
  }
  // Backwards clock skew: restart the spell rather than stall.
  if (now < prev.firstSeenAt || (prev.stagnantSince !== null && now < prev.stagnantSince)) {
    return {
      recover: false,
      next: {
        tag: sig.tag,
        spellStartSeconds: sig.seconds,
        firstSeenAt: now,
        lastSeconds: sig.seconds,
        stagnantPolls: 0,
        stagnantSince: null,
        attempts: 0,
      },
    }
  }
  // Counter advanced: real progress. Reset both the stagnant-poll counter
  // and the stagnantSince timestamp -- the TUI is alive. Keep the spell
  // open with the same tag so a LATER freeze is detected without re-running
  // the full freezeSeconds window from scratch (the wall-clock measurement
  // restarts from the next stagnation onward, which is the right thing).
  if (prev.lastSeconds !== null && sig.seconds > prev.lastSeconds) {
    return {
      recover: false,
      next: { ...prev, lastSeconds: sig.seconds, stagnantPolls: 0, stagnantSince: null },
    }
  }
  // Counter stagnant (same or rolled-back). Tick the stagnant counter and
  // stamp stagnantSince on the FIRST stagnant observation in this stretch.
  // Subsequent stagnant polls preserve the original stagnantSince so the
  // wall-clock duration accumulates correctly.
  const nextStagnant = prev.stagnantPolls + 1
  const nextStagnantSince = prev.stagnantSince ?? now
  // Recovery already fired in this spell: hold.
  if (prev.attempts >= 1) {
    return {
      recover: false,
      next: { ...prev, lastSeconds: sig.seconds, stagnantPolls: nextStagnant, stagnantSince: nextStagnantSince },
    }
  }
  // Recover only when BOTH gates hold: wall-clock freeze duration AND
  // anti-fluke poll count. A 5-minute genuine tool-call resets
  // stagnantSince on every redraw, so even though the call is long this
  // duration never accumulates.
  const stagnantMs = now - nextStagnantSince
  const freezeMs = thresholds.freezeSeconds * 1000
  if (stagnantMs < freezeMs || nextStagnant < thresholds.stagnantPolls) {
    return {
      recover: false,
      next: { ...prev, lastSeconds: sig.seconds, stagnantPolls: nextStagnant, stagnantSince: nextStagnantSince },
    }
  }
  return {
    recover: true,
    next: { ...prev, lastSeconds: sig.seconds, stagnantPolls: nextStagnant, stagnantSince: nextStagnantSince, attempts: 1 },
  }
}
