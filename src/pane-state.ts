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
// The idle footer's trailing action area is highly variable: `(shift+tab to
// cycle)`, or `· N shells · ctrl+t`, or -- when a background monitor and/or
// sub-agents are present -- `· N monitor · ← for agents · ↓ to manage`. The
// previous regex only accepted the `· \d+ shells ·` shape, so a session running
// a background monitor (footer `· 1 monitor · ← for agents · ↓ to manage`) was
// mis-read as 'unknown' and the router/scheduler silently refused to deliver to
// it -- a fleet-wide delivery hole. Match `bypass permissions on` + EITHER the
// shift+tab hint OR any `·`-separated tail ending in a known idle action (ctrl+t
// / ↓ to manage). Busy states are filtered above (esc to interrupt / busy
// indicators / paste placeholder), so this stays idle-specific.
const IDLE_FOOTER_RX = /bypass permissions on(?: \(shift\+tab to cycle\)| · [^\n]*?(?:ctrl\+t|↓ to manage))|\? for shortcuts/

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
// label. `esc to interrupt` is the footer-scoped fallback checked only
// in the live footer region (see LIVE_FOOTER_REGION_LINES below) to
// prevent prose-quoting false positives. A future Claude Code release
// that renames the spinner labels will miss the label regex but still
// be caught by the tokens pattern.
const BUSY_INDICATORS: RegExp[] = [
  // NOTE: /\besc to interrupt\b/ is NOT in this whole-pane list.
  // It is checked separately via BUSY_ESC_TO_INTERRUPT_RX scoped to the
  // bottom LIVE_FOOTER_REGION_LINES lines, because a watchdog report or
  // tool-call output that quotes the phrase in scrollback would otherwise
  // permanently pin the session as busy (81-retry starvation incident).
  // Tokens-down-arrow counter: "(52s · ↓ 2.6k tokens ..." Turn-scoped,
  // overwritten with whitespace the moment the turn completes.
  /\(\s*\d+s\s*·\s*↓\s*\d/,
  // Known spinner labels paired with the turn-scoped `(Ns · ↓` tail on
  // the same line. The tail requirement kills the "Thinking…" prose
  // false positive. Non-exhaustive by design; the bare tokens pattern
  // above is the authoritative fallback.
  /\b(?:Combobulating|Beaming|Thinking|Pondering|Reticulating|Configuring|Noodling|Ruminating|Percolating|Cogitating|Deliberating|Contemplating|Musing|Brewing|Synthesizing|Distilling|Refining|Simmering|Crafting|Formulating|Consulting|Unfurling|Unspooling|Unraveling)…\s*\(\s*\d+s\s*·\s*↓/,
]

// `esc to interrupt` is a footer-region-only busy signal: Claude Code
// appends it to the bypass-mode footer line during a live turn. Scoping
// the check to the bottom LIVE_FOOTER_REGION_LINES lines prevents a
// watchdog report or tool-call output that quotes the phrase anywhere
// in the scrollback from permanently pinning the session as busy
// (observed incident: 81 consecutive scheduler retries on a report that
// contained the phrase in its body).
const BUSY_ESC_TO_INTERRUPT_RX = /\besc to interrupt\b/
const LIVE_FOOTER_REGION_LINES = 5

// Pasted-text placeholder. Claude Code lifts a single large input write
// (empirically a tmux send-keys -l of more than ~700 chars) into a
// `[Pasted text #N]` / `[Pasted text #N +X chars]` stub that sits in the
// LIVE INPUT BOX and never auto-submits. Treat as busy so the scheduler
// doesn't pile a second prompt on top.
//
// Wrap tolerance (real-capture finding): when the input is long the stub
// renders wrapped across a terminal line break -- `...[Pasted text` at the
// end of one line and `  #3]...` at the start of the next (the digits
// themselves can also straddle the break). The opening token, the `#`, and
// the digit are therefore separated by `\s*` (which includes newlines and
// the leading indent of the wrapped continuation) rather than a single
// literal space. This still matches the unwrapped `[Pasted text #N` and
// `[Pasted text #N +X chars]` shapes.
const PENDING_PASTE_RX = /\[Pasted text\s*#\s*\d/

// How many trailing lines to inspect for the stub when no input-box
// separators are visible (a malformed / partial capture, or the older
// `paste again to expand` render with separators scrolled off). Kept tight
// so a stub quoted higher up in scrollback cannot reach the bottom region.
const PASTE_REGION_FALLBACK_LINES = 8

// Scope the placeholder match to the live input box, not the whole pane.
// The box is the region between the two most recent U+2500 separators found
// from the BOTTOM of the pane -- footer-INDEPENDENT, because the placeholder
// render is version-dependent: the current build keeps the normal
// `bypass permissions ...` idle footer below the box, while an older build
// replaced it with a `paste again to expand` hint. Anchoring on the
// separators (always present around the box) covers both. When two
// separators are not found we fall back to the last few lines.
//
// Whole-pane matching was a confirmed false-POSITIVE source: these agents
// routinely quote tmux captures and discuss this very bug, so a literal
// `[Pasted text #N` in a reply line or deep scrollback would trigger a
// destructive Ctrl-C + resend on a perfectly healthy session. Scoping to
// the box (same discipline as BUSY_ESC_TO_INTERRUPT_RX / the footer checks)
// confines the match to where a genuine parked stub actually lives.
function pastePlaceholderRegion(pane: string): string {
  const lines = pane.split('\n')
  let bottomSep = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (BOX_SEP_RX.test(lines[i])) { bottomSep = i; break }
  }
  if (bottomSep > 0) {
    let topSep = -1
    for (let i = bottomSep - 1; i >= 0; i--) {
      if (BOX_SEP_RX.test(lines[i])) { topSep = i; break }
    }
    if (topSep >= 0) return lines.slice(topSep + 1, bottomSep).join('\n')
  }
  return lines.slice(-PASTE_REGION_FALLBACK_LINES).join('\n')
}

// A placeholder pane is identified by the `[Pasted text #N]` stub IN THE LIVE
// INPUT BOX. The accompanying `paste again to expand` footer hint is
// deliberately NOT used: it is version-dependent (the current build keeps the
// normal idle footer instead) AND it empirically LINGERS for a beat after the
// message submits (the box is already empty, the stub gone, yet the hint line
// is still rendered), so keying on it would false-positive a freshly-submitted
// pane as still stuck and trigger a needless clear-and-resend. The stub itself
// appears iff a real placeholder is parked (verified across real captures:
// present in every placeholder render, absent the instant it submits). Pure +
// dependency-free so callers (detectPaneState, shouldRetrySubmit, the recovery
// decision) share ONE definition instead of re-inlining the regex.
export function detectsPastePlaceholder(pane: string): boolean {
  if (!pane) return false
  return PENDING_PASTE_RX.test(pastePlaceholderRegion(pane))
}

// Input-box separator lines are made of U+2500 BOX DRAWINGS LIGHT
// HORIZONTAL. At least 10 in a run to ignore stray `-` glyphs.
const BOX_SEP_RX = /^─{10,}/

// Prompt line inside the input box. `❯` followed by at least one
// horizontal whitespace and then a non-whitespace character means the
// user (or a send-keys that didn't submit) parked text there.
//
// The class is `[^\S\r\n]` (any whitespace EXCEPT a line break), not
// `[ \t]`: a live Claude Code pane renders the gap after the ❯ prompt
// glyph as a NON-BREAKING SPACE (U+00A0), not an ASCII space, while a
// message sits parked (delivered but not yet submitted). The ASCII-space
// form only appears in scrollback for already-submitted lines. `[ \t]`
// missed that NBSP, so an NBSP-rendered parked box read as 'idle' and the
// whole stuck-input recovery chain (stuckInputSignature, parkedChannelInput,
// parkedInputText all gate on detectPaneState === 'typing') never fired --
// the message stranded forever. Excluding only \r\n keeps the original
// single-line intent (the match must not cross into the next line) while
// admitting the NBSP and any other horizontal Unicode space the TUI emits.
const PARKED_INPUT_RX = /❯[^\S\r\n]+\S/

// Strip Claude Code's DIM (SGR 2) "ghost suggestion" autocomplete from a
// COLOURED pane capture (`tmux capture-pane -e -p`), then remove every
// remaining ANSI escape, yielding plain text equivalent to `capture-pane -p`
// MINUS the ghost. Claude Code renders a history/autocomplete hint inside an
// EMPTY input box at REDUCED intensity (`❯ ` then `ESC[2m<hint>ESC[0m`). A
// plain (`-p`) capture drops the colour, so the dim hint becomes
// indistinguishable from a genuinely parked input -- and the stuck-input
// recovery then re-types + Enter-submits it as if the agent had typed it
// (the 2026-06-26 phantom prompt-injection: it triggered a real invoice storno
// and a forged email). The discriminator is intensity: a real parked input is
// rendered at NORMAL intensity, only the ghost is dim. We track SGR dim state
// across the stream and DROP any character emitted while dim is active, so a
// pure-ghost box collapses to `❯ ` (no `\S` after the prompt) and
// PARKED_INPUT_RX / detectPaneState no longer read it as 'typing'.
//
// Pure: a string transform, unit-testable against captured `-e` fixtures.
// `38`/`48` extended-colour params (`38;5;N`, `38;2;R;G;B`) are consumed as a
// unit so a colour INDEX of 2 is never mistaken for the dim attribute.
export function stripGhostSuggestion(coloredPane: string): string {
  let out = ''
  let dim = false
  let i = 0
  const n = coloredPane.length
  while (i < n) {
    const ch = coloredPane[i]
    if (ch === '\x1b') {
      if (coloredPane[i + 1] !== '[') { i++; continue } // drop non-CSI ESC
      let j = i + 2
      while (j < n && (coloredPane[j] < '@' || coloredPane[j] > '~')) j++
      const final = coloredPane[j]
      if (final === 'm') {
        const params = coloredPane.slice(i + 2, j)
        const codes = params.length === 0 ? [''] : params.split(';')
        let k = 0
        while (k < codes.length) {
          const c = codes[k]
          if (c === '38' || c === '48') {
            const mode = codes[k + 1]
            k += mode === '5' ? 3 : mode === '2' ? 5 : 1
            continue
          }
          if (c === '2') dim = true
          else if (c === '0' || c === '22' || c === '') dim = false
          k++
        }
      }
      i = j < n ? j + 1 : n // skip the whole escape sequence
      continue
    }
    if (!dim) out += ch
    i++
  }
  return out
}

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

// Claude Code modal/overlay surfaces -- the /mcp server manager, the model/
// config/theme pickers, and permission dialogs -- replace the input box with a
// navigable list whose footer reads e.g.
//   "↑/↓ to navigate · Enter to confirm · Esc to cancel".
// A headless service session (the main --channels session, a sub-agent) parked
// in such a modal silently stops processing inbound work: it is not 'busy' (no
// spinner / token counter) and not 'idle' (the input box is gone), so
// detectPaneState classifies it 'unknown' and the scheduler/router just skip
// it. Observed 2026-06-12: the main channels session sat in /mcp for ~6h, deaf
// on Telegram, with nothing alerting. detectsBlockingMenu recognises the modal
// so the monitor can pop back to the prompt with a single Escape.
//
// Guards against a healthy session that merely quotes menu chrome in a reply
// or a log line:
//   (a) Not busy: a live turn (spinner / token counter / esc-to-interrupt) is
//       never a parked menu.
//   (b) No idle footer: a real modal hides the permission/shortcuts footer.
//       capturePane uses `capture-pane -p` (visible screen only, no
//       scrollback), so a quoted footer cannot linger from a past turn -- an
//       idle footer present means the normal prompt is live, not a menu.
//   (c) The dismiss/navigation hint must sit in the live footer region (the
//       bottom few lines), not anywhere in the pane, so a message body that
//       quotes "Esc to cancel" does not trigger it.
// `esc to interrupt` (the busy footer) is deliberately excluded from
// MENU_ESC_RX, and guard (a) rejects it anyway.
const MENU_NAV_RX = /(?:↑\/↓|↑↓)\s+to\s+(?:navigate|select|choose)/
const MENU_ESC_RX = /\besc to (?:cancel|exit|close|go back|quit)\b/i
const MENU_FOOTER_REGION_LINES = 8

/**
 * True when the pane is parked in a blocking Claude Code interactive menu /
 * modal (not busy, not at the idle prompt). Pure + dependency-free for unit
 * testing. The monitor uses this to send a recovery Escape; detectPaneState
 * intentionally still returns 'unknown' for these panes so the hot-path
 * scheduler/router behaviour is unchanged.
 */
export function detectsBlockingMenu(pane: string): boolean {
  if (!pane || !pane.trim()) return false
  for (const rx of BUSY_INDICATORS) {
    if (rx.test(pane)) return false
  }
  const lines = pane.split('\n')
  const footerRegion = lines.slice(-MENU_FOOTER_REGION_LINES).join('\n')
  if (BUSY_ESC_TO_INTERRUPT_RX.test(footerRegion)) return false
  if (IDLE_FOOTER_RX.test(pane)) return false
  return MENU_NAV_RX.test(footerRegion) || MENU_ESC_RX.test(footerRegion)
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

  // Scope `esc to interrupt` check to the live footer region only.
  // Checking the whole pane would let a scrollback quote of the phrase
  // (e.g. in a watchdog report or a log analysis) permanently classify
  // an idle session as busy.
  const paneLines = pane.split('\n')
  const footerRegion = paneLines.slice(-LIVE_FOOTER_REGION_LINES).join('\n')
  if (BUSY_ESC_TO_INTERRUPT_RX.test(footerRegion)) return 'busy'

  // Pending-paste placeholder check runs BEFORE the idle-footer gate. The
  // stub sits in the live input box; the footer below it is version-dependent
  // (the current build keeps the normal `bypass permissions ...` idle footer,
  // an older build showed `paste again to expand` instead and so failed
  // IDLE_FOOTER_RX). Running the box-scoped placeholder check first classifies
  // BOTH shapes as 'busy' -- and on the older `paste again to expand` shape it
  // also rescues the pane from being mis-read 'unknown' at the idle-footer gate
  // below. A placeholder must read 'busy' so the scheduler/router/keepalive
  // defer rather than pile a second prompt on.
  if (detectsPastePlaceholder(pane)) return 'busy'

  if (!IDLE_FOOTER_RX.test(pane)) {
    // Footer-less fresh-session / welcome-screen: a PARKED \u276F input box still
    // means the agent has a delivered message waiting to submit. Classify it
    // 'typing' (not 'unknown') so the stuck-input recovery stack can see and
    // resubmit it. An empty box / no box stays 'unknown' -- without a footer
    // there is nothing to confirm a genuine idle state.
    const box = liveInputBox(pane)
    if (box != null && box.split('\n').some(l => PARKED_INPUT_RX.test(l))) {
      return opts.mergeTypingAsBusy ? 'busy' : 'typing'
    }
    return 'unknown'
  }

  if (detectsThinkingBlockError(pane)) return 'error'

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
 * Canonical pure idle predicate: true iff the capture classifies as the
 * 'idle' pane state (input box live and empty, not busy / typing / menu /
 * error / unknown). This is the SINGLE place the "is this pane idle" rule
 * lives, so every caller -- the readiness check (isReadyForPrompt), the
 * auto-restart idle-guard (auto-restart-runner.paneIsIdle) and the
 * sendPromptToSession pre-flight wait-until-idle gate -- shares one
 * definition rather than re-inlining `detectPaneState(...) === 'idle'`
 * (and, worse, the busy regex) in several files.
 */
export function paneLooksIdle(capture: string): boolean {
  return detectPaneState(capture) === 'idle'
}

/**
 * True when the pane is in the specific "accepting a new prompt" state.
 * 'typing' counts as not-ready because the user has unsubmitted text
 * in the input box and a new prompt would concatenate into it. Thin alias
 * over paneLooksIdle kept for its existing call sites / tests.
 */
export function isReadyForPrompt(pane: string): boolean {
  return paneLooksIdle(pane)
}

// Locate the live Claude Code input box and return its inner content as
// one string. Bounded strictly to the region between the two most
// recent BOX_SEP_RX separators above the idle footer, so a parked input
// in scrollback (post-turn artifact) is never mistaken for live state.
//
// Returns null when the pane does not have a live input box (no idle
// footer, only one separator, etc.) -- callers should treat null as
// "not enough signal to act, do nothing".
// Fallback for the fresh-session / welcome-screen layout (Claude Code logo +
// model line + cwd, NO idle footer): a delivered message can sit parked in the
// input box before the footer is ever rendered, and the footer-anchored path
// would miss it entirely (return null -> the whole recovery stack goes blind).
// Anchor on the LAST TWO box separators (/^\u2500{10,}/) and treat the span
// between them as the input box ONLY when its first non-empty row starts with
// the \u276F prompt -- otherwise a pair of scrollback rules would be mis-read.
function liveInputBoxFooterless(lines: string[]): string | null {
  const seps: number[] = []
  for (let i = 0; i < lines.length; i++) {
    if (BOX_SEP_RX.test(lines[i])) seps.push(i)
  }
  if (seps.length < 2) return null
  const topSep = seps[seps.length - 2]
  const bottomSep = seps[seps.length - 1]
  const inner = lines.slice(topSep + 1, bottomSep)
  const firstNonEmpty = inner.find(l => l.trim().length > 0)
  if (firstNonEmpty == null || !/^\s*\u276F/.test(firstNonEmpty)) return null
  return inner.join('\n')
}

function liveInputBox(pane: string): string | null {
  const lines = pane.split('\n')
  const footerIdx = lines.findIndex(l => IDLE_FOOTER_RX.test(l))
  if (footerIdx < 0) return liveInputBoxFooterless(lines)
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
  // Footer-region `esc to interrupt` check (same scoping as detectPaneState).
  const retryPaneLines = pane.split('\n')
  const retryFooterRegion = retryPaneLines.slice(-LIVE_FOOTER_REGION_LINES).join('\n')
  if (BUSY_ESC_TO_INTERRUPT_RX.test(retryFooterRegion)) return false

  // Path 1: placeholder is unambiguous, retry regardless of hint -- and it is
  // checked BEFORE the idle-footer gate below. The footer beneath a placeholder
  // is version-dependent: the current build keeps the normal idle footer, an
  // older build showed `paste again to expand` (failing IDLE_FOOTER_RX). The
  // old ordering (footer gate first) therefore returned false on the older
  // shape -- the very state the recovery exists to catch. detectsPastePlaceholder
  // scopes the match to the live input box, so a `[Pasted text #N]` quoted in a
  // reply line or scrollback cannot trigger a spurious clear-and-resend.
  if (detectsPastePlaceholder(pane)) return true

  // Without an idle footer the pane is either not Claude Code or in an
  // unknown render state. Be conservative and skip.
  if (!IDLE_FOOTER_RX.test(pane)) return false

  const inputBox = liveInputBox(pane)
  if (inputBox == null) return false

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

export type SubmitFollowupAction = 'retry-enter' | 'clear-and-resend' | 'done' | 'give-up'

/**
 * Decide what the post-send-keys loop should do next, given the
 * current pane snapshot and how many retry-Enter attempts have already
 * been made. Returns one of three discrete actions so the caller can
 * branch without re-running the detection logic itself.
 *
 *   - 'done'             -- the prompt landed (or the pane is busy
 *                           processing); no further action.
 *   - 'retry-enter'      -- the pane shows a VERBATIM stuck send; send
 *                           another Enter and re-sample. (A plain Enter
 *                           submits verbatim parked text.)
 *   - 'clear-and-resend' -- the pane shows a `[Pasted text #N]`
 *                           placeholder. A plain Enter is PROVEN not to
 *                           submit it (it merely expands the stub to
 *                           parked verbatim text, still unsubmitted), so
 *                           the caller must clear the buffer and re-send
 *                           the payload defensively instead.
 *   - 'give-up'          -- the retry budget is spent, or the capture
 *                           failed and we cannot tell whether retry would
 *                           help. Caller should log a warning and move on.
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
  // A placeholder will NOT submit on a plain Enter (proven empirically: Enter
  // only expands the stub to still-parked verbatim text). Route it to the
  // clear-and-resend recovery instead of wasting a retry-Enter on it.
  if (detectsPastePlaceholder(pane)) return 'clear-and-resend'
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

export interface ParkedChannelInput {
  /** True only when the parked block is captured intact -- opening
   * <channel source="plugin:..."> tag WITH a chat_id AND a closing
   * </channel>. False when the box holds a channel block whose header has
   * scrolled/truncated out of the capture (chat_id unrecoverable), so a
   * caller must NOT verbatim re-inject it (a partial re-inject could answer
   * the wrong chat_id -- worse than a delayed submit). */
  complete: boolean
  /** The complete <channel>...</channel> block, whitespace-collapsed, when
   * complete; null when truncated. Safe to re-inject verbatim. */
  block: string | null
  /** The recovered chat_id when complete; null otherwise. */
  chatId: string | null
}

// Classify the live input box as a stranded CHANNEL notification, or null
// when it is not ours to touch. Returns null when the pane is not parked
// ('typing'), the box is empty, OR the parked text is a HUMAN's own
// hand-typed draft (no <channel source="plugin:..."> marker) -- the
// stuck-input watcher must leave a human draft alone. When a channel block
// IS parked, the `complete` flag is the truncation-guard: only a complete
// capture (header + chat_id + closing tag present) is safe to re-inject.
//
// The captured box is whitespace-collapsed first because liveInputBox()
// preserves the terminal-wrap newlines, which would otherwise split the
// <channel> tag attributes across lines and defeat the match.
export function parkedChannelInput(pane: string): ParkedChannelInput | null {
  if (detectPaneState(pane) !== 'typing') return null
  const box = liveInputBox(pane)
  if (box == null) return null
  const flat = box.replace(/\s+/g, ' ').trim()
  if (!/<channel\s+source="plugin:/.test(flat)) return null // human draft -> not ours
  const m = flat.match(/<channel\s+source="plugin:[^"]*"[^>]*>.*?<\/channel>/)
  if (!m) return { complete: false, block: null, chatId: null } // opening tag only -> truncated
  const block = m[0]
  const cm = block.match(/\bchat_id="([^"]+)"/)
  // A terminal wrap can land INSIDE chat_id="..."; whitespace-collapse then
  // yields a corrupted id with an embedded space. Reject it (stay on Enter)
  // rather than re-inject to a wrong chat_id.
  if (!cm || /\s/.test(cm[1])) return { complete: false, block, chatId: null }
  return { complete: true, block, chatId: cm[1] }
}

// The whitespace-collapsed text currently parked in the live input box when
// the pane is 'typing', or null when nothing is parked. Used by SUB-AGENT
// stuck-input recovery to re-inject a delivered message that the TUI failed to
// submit and that is NOT a <channel> block (e.g. an inter-agent notification).
// A sub-agent's input box never holds a human-typed draft -- only router- or
// plugin-delivered messages -- so re-injecting its parked text is safe there.
// The collapse mirrors parkedChannelInput(): terminal wrap is folded into
// single spaces, yielding a single-line, reliably submittable message.
export function parkedInputText(pane: string): string | null {
  if (detectPaneState(pane) !== 'typing') return null
  const box = liveInputBox(pane)
  if (box == null) return null
  // Collapse terminal wrap, then strip the leading ❯ prompt marker so the
  // re-injected text is the message itself, not the prompt glyph.
  const flat = box.replace(/\s+/g, ' ').trim().replace(/^❯\s*/, '').trim()
  return flat.length > 0 ? flat : null
}

// How many VISUAL rows the live input box content occupies, ignoring the
// bare prompt glyph and blank padding. The caller uses this to choose the
// right submit keystroke: a MULTI-row parked input must NOT be submitted with
// a bare Enter, because in the Claude TUI a plain Enter on a wrapped /
// multi-line buffer inserts a newline instead of submitting (see
// agent-process.ts:833) -- a single-row buffer submits on Enter.
//
// Counts the non-empty rows of liveInputBox() after stripping the leading `❯`
// prompt marker; an empty box (`❯ ` only) or no box at all -> 0. Pure: no
// tmux, only the captured text.
export function parkedInputRowCount(pane: string): number {
  const box = liveInputBox(pane)
  if (box == null) return 0
  return box
    .split('\n')
    .map((row) => row.replace(/^\s*❯/, '').trim())
    .filter((row) => row.length > 0).length
}

// Post-submit verification: did the parked input actually leave the box?
//
// `prevSig` is stuckInputSignature(pane) captured BEFORE the submit attempt
// (the exact text that was parked). `paneAfter` is a fresh capture taken
// AFTER the submit. Returns true when the submit LANDED -- the same parked
// signature is no longer 'typing' in the box: it cleared (pane went idle),
// the agent started processing it (pane went busy), or different text is now
// parked. Returns false when the IDENTICAL signature is still parked (the
// Enter was swallowed -> the caller should retry / escalate), or when
// paneAfter is null (no capture -> cannot confirm, treat as not-landed).
// Pure: builds on stuckInputSignature() (which gates on detectPaneState).
export function submitLanded(prevSig: string, paneAfter: string | null): boolean {
  if (paneAfter == null) return false
  return stuckInputSignature(paneAfter) !== prevSig
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
// Submit-action decision (delivery-reliability, BA56A500)
// =============================================================================
//
// Turns the parked-input facts -- built from parkedInputRowCount() and
// parkedChannelInput() above -- into a recovery MOVE. The decision is the heart
// of the fix: a plain recovery Enter on a MULTI-ROW parked message inserts a
// newline rather than submitting (corrupt), so multi-row must never bare-Enter;
// and the chat_id truncation-guard (no verbatim re-inject of an incomplete
// <channel> block) is preserved. The caller verifies the move landed with
// submitLanded() and escalates within the attempts budget if it did not.

/** A concrete recovery move for the stuck-input watcher. */
export type StuckInputAction =
  | 'reinject-block'   // clear + verbatim re-inject the COMPLETE <channel> block (chat_id-safe)
  | 'reinject-plain'   // clear + re-inject collapsed parked text (sub-agents only)
  | 'clear-preamble'   // clear a truncated/stale safety preamble, never re-inject
  | 'enter'            // a single bare Enter -- ONLY safe at rowCount <= 1
  | 'hold'             // do nothing this tick (multi-row truncated / truncation-guard)

export interface StuckInputActionFacts {
  /** attempt > MAIN_STUCK_ENTER_ATTEMPTS -- past the Enter-first budget. */
  escalate: boolean
  /** parkedInputRowCount(pane) -- >1 forbids a bare Enter. */
  rowCount: number
  /** A complete <channel> block is parked: chat_id-safe verbatim re-inject. */
  blockComplete: boolean
  /** A <channel> block is parked but truncated: chat_id unrecoverable, MUST
   * NOT re-inject (wrong chat_id) and MUST NOT corrupt via a multi-row Enter. */
  blockTruncated: boolean
  /** shouldClearTruncatedPreamble(pane): a stale safety preamble to clear. */
  truncatedPreamble: boolean
  /** Sub-agent session: re-injecting collapsed parked text is safe (no human draft). */
  allowPlainReinject: boolean
  /** parkedInputText(pane) != null -- there is collapsed text to re-inject. */
  hasPlainText: boolean
}

/**
 * Pure decision: given the parked-input facts, what recovery move to make.
 * Dependency-free so it is unit-testable without tmux.
 *
 * Invariants (the fix):
 *   - NEVER bare-Enter a multi-row box (rowCount > 1) -- it inserts a newline
 *     and corrupts the message. Multi-row escalates straight to a re-inject
 *     (when one is safe) or holds.
 *   - A complete <channel> block is the safest move (chat_id-safe re-inject);
 *     prefer it as soon as we escalate, and immediately when multi-row.
 *   - A TRUNCATED <channel> block (chat_id unrecoverable) must not be
 *     re-injected; multi-row truncated holds (awaiting the keystroke fix),
 *     single-row keeps the harmless legacy Enter.
 *   - Otherwise a bare Enter is the swallowed-Enter remedy, but only single-row.
 */
export function decideStuckInputAction(f: StuckInputActionFacts): StuckInputAction {
  const multiRow = f.rowCount > 1
  // Complete channel block: chat_id-safe verbatim re-inject. Multi-row is itself
  // a reason to escalate now (a plain Enter would corrupt it).
  if (f.blockComplete) {
    return f.escalate || multiRow ? 'reinject-block' : 'enter'
  }
  // Sub-agent non-channel parked text: clear + re-inject is safe (no human draft).
  if (f.allowPlainReinject && f.hasPlainText && !f.blockTruncated) {
    return f.escalate || multiRow ? 'reinject-plain' : 'enter'
  }
  // Truncated safety preamble: clear only (never re-inject a stale preamble).
  if (f.truncatedPreamble && f.escalate) return 'clear-preamble'
  // Truncated <channel> block: hold a multi-row (Enter would corrupt; re-inject
  // would answer the wrong chat_id), keep the harmless legacy Enter single-row.
  if (f.blockTruncated) return multiRow ? 'hold' : 'enter'
  // Default swallowed-Enter remedy -- never on multi-row.
  return multiRow ? 'hold' : 'enter'
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
  /** Highest seconds value observed in this spell. Load-bearing for the
   * spell-peak discriminator: a residual TUI footer left over from a prior
   * respawn never climbs (stays at 3-4s across every observation), while a
   * legitimately running tool-call that wedges climbed to a meaningful value
   * before stalling. Recovery is gated on spellPeakSeconds >= minPeakSeconds
   * so the residual band does not look like a wedge (2026-06-08 false-positive
   * loop: 13 self-respawns in 8h triggered by 3-4s residuals every poll). */
  spellPeakSeconds: number | null
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
  /** Spell-peak discriminator (2026-06-08 fix): the highest seconds value the
   * counter has reached in this spell must be at LEAST this many seconds for
   * the spell to qualify as a wedge. A residual TUI footer left over after a
   * prior respawn never climbs (stays at 3-4s every poll); a legitimately
   * wedged tool-call climbed to a meaningful value before freezing (the
   * 2026-06-02 incident sat at 31s). Composed AND with the wall-clock and
   * anti-fluke gates -- all three must hold. */
  minPeakSeconds: number
}

export interface StuckToolCallDecision {
  recover: boolean
  next: StuckToolCallState
}

const NO_STUCK_TOOL_CALL: StuckToolCallState = {
  tag: null,
  spellStartSeconds: null,
  spellPeakSeconds: null,
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
        spellPeakSeconds: sig.seconds,
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
        spellPeakSeconds: sig.seconds,
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
  // Also raise spellPeakSeconds -- the discriminator that separates a real
  // wedge (climbed before freezing) from a leftover residual footer.
  if (prev.lastSeconds !== null && sig.seconds > prev.lastSeconds) {
    const peak = Math.max(prev.spellPeakSeconds ?? sig.seconds, sig.seconds)
    return {
      recover: false,
      next: { ...prev, spellPeakSeconds: peak, lastSeconds: sig.seconds, stagnantPolls: 0, stagnantSince: null },
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
  // Recover only when ALL THREE gates hold: wall-clock freeze duration,
  // anti-fluke poll count, AND spell-peak discriminator. A 5-minute genuine
  // tool-call resets stagnantSince on every redraw, so even though the call
  // is long the duration never accumulates. A residual TUI footer left over
  // from a prior respawn never climbs past minPeakSeconds, so the peak gate
  // blocks the 2026-06-08 false-positive shape (3-4s residual every poll).
  const stagnantMs = now - nextStagnantSince
  const freezeMs = thresholds.freezeSeconds * 1000
  const peak = prev.spellPeakSeconds ?? sig.seconds
  if (
    stagnantMs < freezeMs ||
    nextStagnant < thresholds.stagnantPolls ||
    peak < thresholds.minPeakSeconds
  ) {
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
