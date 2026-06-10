import { describe, it, expect } from 'vitest'
import {
  detectPaneState,
  detectsThinkingBlockError,
  isReadyForPrompt,
  shouldRetrySubmit,
  shouldClearTruncatedPreamble,
  decideSubmitFollowup,
  decidePaneErrorAlert,
  stuckInputSignature,
  decideStuckInputRecovery,
  parkedChannelInput,
  parkedInputText,
} from '../pane-state.js'

// Realistic pane fixtures modelled on actual `tmux capture-pane -p`
// output from shipping Claude Code builds. Whitespace and box-drawing
// characters (U+2500 ─, U+276F ❯, U+23F5 ⏵) preserved exactly so the
// regex matches exercise the same byte sequences they would in prod.

const SEP = '─'.repeat(80)

const IDLE_BYPASS = [
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

const IDLE_STRICT = [
  '',
  SEP,
  '❯ ',
  SEP,
  '  ? for shortcuts',
].join('\n')

const BUSY_FULL_FOOTER = [
  '✢ Combobulating… (52s · ↓ 2.6k tokens · thinking some more)',
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt',
].join('\n')

// The smoke-test bug scenario: spinner rendered, but the footer is still
// in its one-frame idle state before `· esc to interrupt` is appended.
const BUSY_FOOTER_FRAME_GAP = [
  '✢ Combobulating… (52s · ↓ 2.6k tokens · thinking some more)',
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

// Spinner label missing (older/newer Claude Code build). Only the
// token-count pattern is present. Must still classify as busy.
const BUSY_TOKENS_ONLY = [
  '✶ (4s · ↓ 120 tokens)',
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

// Tool-use summary lines persist in the scrollback AFTER a turn ends --
// Claude Code does not overwrite them. Including them as busy signals
// would classify an otherwise idle agent as busy forever, starving
// the scheduler. This fixture models the post-turn idle state: the tool
// summary is on screen but no spinner, no tokens, no esc-to-interrupt.
const IDLE_AFTER_TOOL_USE = [
  '  Searched for 3 patterns, listed 4 directories (ctrl+o to expand)',
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

// Real busy-with-tool-use: spinner line present alongside the tool summary.
const BUSY_TOOL_USE_ACTIVE = [
  '  Searched for 3 patterns, listed 4 directories (ctrl+o to expand)',
  '✢ Combobulating… (12s · ↓ 480 tokens)',
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt',
].join('\n')

const TYPING_PARKED = [
  '',
  SEP,
  '❯ Valami amit a felhasznalo elkezdett geppelni, meg nem kuldte el',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

const PENDING_PASTE = [
  '',
  SEP,
  '❯ [Pasted text #1 +234 chars]',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

// Historical ❯ above the separators (scrollback). Must NOT count as
// parked input -- the input box is strictly the region between the two
// most recent separators.
const IDLE_WITH_SCROLLBACK_CARET = [
  '  ❯ some old echoed command from scrollback',
  '  output of that command',
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

// A pane that is not Claude Code at all (regular shell).
const NON_CLAUDE = [
  'user@host ~ $ ls',
  'README.md  src/  test/',
].join('\n')

// Background-shells footer variant. Claude Code rewrites the bypass-mode
// footer when the session has one or more BashTool background shells
// running: the "(shift+tab to cycle)" hint is replaced with the
// "· N shells · ctrl+t to hide tasks · ↓ to manage" indicator. The pane
// is still idle and must accept a new prompt -- otherwise inter-agent
// messages and scheduled tasks pile up in pending forever for any agent
// that polls (gh run list, watchers, etc.) in the background.
const IDLE_BACKGROUND_SHELLS = [
  '  85 tasks (84 done, 1 in progress, 0 open)',
  '   … +80 completed',
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on · 3 shells · ctrl+t to hide tasks · ↓ to manage',
].join('\n')

// Same variant with a single shell (singular form). Defensive: the regex
// must accept both "shell" and "shells" so a 1-shell session is not stuck.
const IDLE_BACKGROUND_ONE_SHELL = [
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on · 1 shell · ctrl+t to hide tasks · ↓ to manage',
].join('\n')

// Background-shells footer with the tasks panel HIDDEN. When the
// operator (or the agent) presses ctrl+t to hide the tasks panel,
// Claude Code drops the "ctrl+t to hide tasks" segment and renders a
// shorter footer: "· N shells · ↓ to manage". The pane is still idle;
// the only difference is that the toggle hint is gone because the panel
// it would toggle is already hidden. Observed in production on a sub-
// agent session where the operator had hidden the tasks panel.
const IDLE_BACKGROUND_SHELLS_HIDDEN = [
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on · 3 shells · ↓ to manage',
].join('\n')

// Same hidden-tasks variant with a single shell (singular form).
// Defensive: covers the corner where a session has exactly one
// background shell AND the tasks panel is hidden, so neither the
// plural form nor the ctrl+t segment is present.
const IDLE_BACKGROUND_ONE_SHELL_HIDDEN = [
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on · 1 shell · ↓ to manage',
].join('\n')

// Wedged thinking-block API error. An assistant turn ended with the
// 400 about thinking blocks that "cannot be modified"; the pane shows
// the tool-output chrome (`⎿  API Error: ...`), a past-tense thinking
// stamp, an empty input box and the idle footer. The U+23BF result
// glyph and the full phrase are reproduced exactly so the regex sees
// the same bytes it would in prod. Sanitised: no internal names/paths.
const ERROR_THINKING_BLOCK = [
  '  ⎿  API Error: 400 messages.55.content.19: `thinking` or `redacted_thinking` blocks in the latest assistant message',
  '      cannot be modified. These blocks must remain as they were in the original response.',
  '',
  '✻ Sauteed for 1s',
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

// A message body that QUOTES "API Error 400" in prose (an instruction
// to report if the error recurs). No `⎿  API Error: <num>` chrome and
// no "cannot be modified" phrase -- must NOT be read as a wedged error.
const ERROR_ECHO_IN_MESSAGE = [
  '  HA a session-history korrupt es ismet API Error 400 jon a feldolgozas',
  '  elejen, AZONNAL jelezd vissza inter-agent uzenetben.',
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

// A reply that quotes the FULL phrase ("thinking ... cannot be
// modified") in prose, e.g. a bug analysis, but WITHOUT the
// `⎿  API Error: <num>` chrome glyph. The chrome guard must keep this
// out of the 'error' class.
const ERROR_FULL_PHRASE_PROSE = [
  '  A hiba lenyege: a thinking vagy redacted_thinking blocks cannot be',
  '  modified ket API-hivas kozott. Ezt most csak elemzem, nem elo hiba.',
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

// An old error far up in scrollback (above the live tail), with a fresh
// idle turn below it. The position scope must ignore the stale error so
// a recovered session is not stuck classified as 'error'.
const ERROR_DEEP_SCROLLBACK = [
  '  ⎿  API Error: 400 messages.55.content.19: `thinking` blocks cannot be modified.',
  ...Array(24).fill('  (normal output line after the session recovered)'),
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

// Error chrome present BUT a live spinner is also rendered: the turn is
// running again, not wedged. The busy guard must win so we do not stop
// injecting into a session that is actually working.
const ERROR_DURING_BUSY = [
  '  ⎿  API Error: 400 messages.55.content.19: `thinking` blocks cannot be modified.',
  '✻ Combobulating… (12s · ↓ 480 tokens)',
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt',
].join('\n')

// A BENIGN chrome error (429) on one line AND an unrelated "thinking ...
// cannot be modified" prose several lines below it (outside the chrome
// block). The guards are required WITHIN one chrome block, so this must
// NOT be flagged -- otherwise a healthy session that hits a rate limit
// and elsewhere mentions the phrase would be wrongly reset.
const ERROR_DECOUPLED_BENIGN = [
  '  ⎿  API Error: 429 overloaded_error: server busy, retrying',
  '  retry succeeded, continuing the task',
  '  finished that step',
  '',
  '  Note: the thinking-block error is when a block cannot be modified.',
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

// A real wedged error with a STRAY footer-looking line ("? for
// shortcuts") quoted higher up in scrollback. The footer must be found
// from the bottom, otherwise the scope locks onto the stray line and the
// real error below it is missed (false negative).
const ERROR_WITH_STRAY_FOOTER_ABOVE = [
  '  Use the ? for shortcuts hint mentioned in the docs',
  '  (a scrollback message that quotes help text)',
  '  ⎿  API Error: 400 messages.55.content.19: `thinking` or `redacted_thinking` blocks in the latest assistant message',
  '      cannot be modified. These blocks must remain as they were in the original response.',
  '✻ Sauteed for 1s',
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

// Narrow terminal: the long error message wraps so "cannot be modified"
// lands on the 4th line of the chrome block (chrome + 3 continuations).
// A 3-line window would miss it (false negative); the 4-line block
// catches it. The thinking kind is on the chrome line, redacted_thinking
// on the 2nd, the phrase on the 4th.
const ERROR_NARROW_WRAP = [
  '  ⎿  API Error: 400 messages.55.content.19: `thinking`',
  '      or `redacted_thinking` blocks in the latest assistant',
  '      message. These response',
  '      blocks cannot be modified and must remain unchanged.',
  '✻ Sauteed for 1s',
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

describe('detectPaneState', () => {
  it('returns unknown for empty input', () => {
    expect(detectPaneState('')).toBe('unknown')
    expect(detectPaneState('   \n\n  ')).toBe('unknown')
  })

  it('detects idle on bypass-mode footer with empty input box', () => {
    expect(detectPaneState(IDLE_BYPASS)).toBe('idle')
  })

  it('detects idle on strict-mode footer ("? for shortcuts")', () => {
    expect(detectPaneState(IDLE_STRICT)).toBe('idle')
  })

  it('detects idle when the footer shows the multi-shell indicator', () => {
    // Regression: Claude Code rewrites "(shift+tab to cycle)" to
    // "· N shells · ctrl+t to hide tasks · ↓ to manage" when the session
    // has BashTool background shells running. The old strict regex did
    // not match this variant, so any session with a background poll
    // was classified 'unknown' and never received inter-agent messages.
    expect(detectPaneState(IDLE_BACKGROUND_SHELLS)).toBe('idle')
  })

  it('detects idle when the footer shows the singular "1 shell" form', () => {
    // The footer uses the singular "1 shell" (not "1 shells") for a
    // single background shell. Split from the multi-shell test so a
    // future regression on either form fails with a precise signal.
    expect(detectPaneState(IDLE_BACKGROUND_ONE_SHELL)).toBe('idle')
  })

  it('detects idle when the tasks panel is HIDDEN (no "ctrl+t" segment)', () => {
    // Claude Code drops the "ctrl+t to hide tasks" segment when the
    // tasks panel is already hidden, leaving "· N shells · ↓ to manage"
    // as the only suffix. The pane is still idle, just with a shorter
    // footer. The previous regex only matched the "ctrl+t" form, so
    // sessions with the tasks panel hidden were classified 'unknown'
    // and inter-agent messages stalled until the next manual toggle.
    expect(detectPaneState(IDLE_BACKGROUND_SHELLS_HIDDEN)).toBe('idle')
    expect(detectPaneState(IDLE_BACKGROUND_ONE_SHELL_HIDDEN)).toBe('idle')
  })

  it('does NOT classify a truncated "· N shell" prefix as idle', () => {
    // Defense in depth: the shells-variant requires either the
    // "· N shells · ctrl+t" marker or the "· N shells · ↓ to manage"
    // marker, not just the bare "· N shell(s)" prefix. Two reasons we
    // pin this down with an explicit negative test:
    //   1. A malformed or partially rendered footer (terminal
    //      corruption, mid-render frame) must classify as 'unknown'
    //      so we do not deliver a prompt into a pane that is not
    //      really ready.
    //   2. The "bypass permissions on · 1 shell" substring could
    //      appear in scrollback as quoted log output or an echoed
    //      message, and the regex must not be tricked into treating
    //      that as a live footer.
    // The fixture is deliberately minimal: no other idle markers
    // (no "(shift+tab to cycle)", no "? for shortcuts") so the
    // assertion isolates the truncated-shells path specifically.
    const truncated = [
      '',
      SEP,
      '❯ ',
      SEP,
      '  ⏵⏵ bypass permissions on · 1 shell',
    ].join('\n')
    expect(detectPaneState(truncated)).toBe('unknown')
  })

  it('detects busy when "esc to interrupt" footer marker is present', () => {
    expect(detectPaneState(BUSY_FULL_FOOTER)).toBe('busy')
  })

  it('detects busy even when the footer frame-gap hides "esc to interrupt"', () => {
    // Regression for the smoke-test-11-10 bug: spinner + tokens visible,
    // footer still shows plain idle. Old single-regex detector said idle
    // (false positive). New detector catches via BUSY_INDICATORS.
    expect(detectPaneState(BUSY_FOOTER_FRAME_GAP)).toBe('busy')
  })

  it('detects busy from the token-count pattern alone (unknown spinner label)', () => {
    // A Claude Code release could rename "Combobulating" to anything. The
    // (Ns · ↓N tokens) pattern is the load-bearing fallback.
    expect(detectPaneState(BUSY_TOKENS_ONLY)).toBe('busy')
  })

  it('detects busy when a tool-use summary is paired with a live spinner', () => {
    expect(detectPaneState(BUSY_TOOL_USE_ACTIVE)).toBe('busy')
  })

  it('detects error when wedged on the thinking-block 400', () => {
    // The wedged state: idle footer (turn finished) + past-tense
    // thinking stamp, no live busy signal, but the live tail shows the
    // `⎿  API Error: ... thinking ... cannot be modified` output. Old
    // detector said 'idle' here, so the scheduler kept injecting doomed
    // prompts. Must now be 'error' so isReadyForPrompt() returns false.
    expect(detectPaneState(ERROR_THINKING_BLOCK)).toBe('error')
  })

  it('does NOT classify a prose "API Error 400" mention as error', () => {
    // A message body quoting "API Error 400" (an instruction to report
    // recurrence) has no `⎿  API Error: <num>` chrome and no
    // "cannot be modified" phrase. Must stay idle.
    expect(detectPaneState(ERROR_ECHO_IN_MESSAGE)).toBe('idle')
  })

  it('does NOT classify the full phrase in prose (no chrome) as error', () => {
    // A bug-analysis reply quoting "thinking ... cannot be modified" in
    // prose, without the tool-output chrome glyph, must not trip the
    // detector. The chrome guard is what discriminates a real wedged
    // turn from a quote.
    expect(detectPaneState(ERROR_FULL_PHRASE_PROSE)).toBe('idle')
  })

  it('does NOT classify a stale error in deep scrollback as error', () => {
    // Once a session recovers, its old error scrolls up out of the live
    // tail. The position scope must ignore it so a healthy session is
    // not stuck flagged. Below the stale error the pane is plainly idle.
    expect(detectPaneState(ERROR_DEEP_SCROLLBACK)).toBe('idle')
  })

  it('prefers busy over error when a live spinner is rendered', () => {
    // Error chrome on screen but the turn is running again (spinner +
    // token tail). The busy guard precedes the error guard so we do not
    // stop injecting into a session that is actually working.
    expect(detectPaneState(ERROR_DURING_BUSY)).toBe('busy')
  })

  it('does NOT flag a benign chrome + decoupled phrase as error', () => {
    // A 429 chrome on one line and an unrelated "cannot be modified"
    // prose several lines below (outside the chrome block) must not
    // AND-combine into a false positive. This is the per-block guard.
    expect(detectPaneState(ERROR_DECOUPLED_BENIGN)).toBe('idle')
  })

  it('detects error even when a stray footer line sits in scrollback', () => {
    // The footer is found from the bottom, so a "? for shortcuts" string
    // quoted higher up does not steal the scope from the real wedged
    // error sitting just above the live footer.
    expect(detectPaneState(ERROR_WITH_STRAY_FOOTER_ABOVE)).toBe('error')
  })

  it('detects error when a narrow terminal wraps the message onto 4 lines', () => {
    // The phrase "cannot be modified" wraps to the 4th line of the
    // chrome block. The 4-line block window must still catch it.
    expect(detectPaneState(ERROR_NARROW_WRAP)).toBe('error')
  })

  it('does NOT classify idle-with-stale-tool-use-scrollback as busy', () => {
    // Tool-use summary lines survive into the scrollback after the turn
    // ends. Classifying them as busy would starve the scheduler after
    // any agent's tool call. Only active-turn signals (spinner, tokens,
    // esc-to-interrupt, footer-scoped) count.
    expect(detectPaneState(IDLE_AFTER_TOOL_USE)).toBe('idle')
  })

  it('detects typing when text is parked in the input box', () => {
    expect(detectPaneState(TYPING_PARKED)).toBe('typing')
  })

  it('merges typing into busy when mergeTypingAsBusy is set', () => {
    expect(detectPaneState(TYPING_PARKED, { mergeTypingAsBusy: true })).toBe('busy')
  })

  it('treats a pending-paste placeholder as busy', () => {
    expect(detectPaneState(PENDING_PASTE)).toBe('busy')
  })

  it('does NOT confuse a historical ❯ in scrollback for a parked input', () => {
    expect(detectPaneState(IDLE_WITH_SCROLLBACK_CARET)).toBe('idle')
  })

  it('returns unknown for a pane that is not a Claude Code surface', () => {
    expect(detectPaneState(NON_CLAUDE)).toBe('unknown')
  })

  it.each([
    'Pondering…',
    'Beaming…',
    'Thinking…',
    'Reticulating…',
    'Configuring…',
    'Noodling…',
    'Ruminating…',
    'Percolating…',
    'Cogitating…',
    'Deliberating…',
    'Contemplating…',
    'Musing…',
    'Brewing…',
    'Synthesizing…',
    'Distilling…',
    'Refining…',
    'Simmering…',
    'Crafting…',
    'Formulating…',
    'Consulting…',
    'Unfurling…',
    'Unspooling…',
    'Unraveling…',
  ])('matches a busy spinner label paired with the runtime tail: %s', (label) => {
    // The label regex requires the `(Ns · ↓` tail on the same line so
    // prose like a Markdown heading `# Thinking…` does not false-positive.
    const snap = [
      `✢ ${label} (3s · ↓ 42 tokens)`,
      '',
      SEP,
      '❯ ',
      SEP,
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n')
    expect(detectPaneState(snap)).toBe('busy')
  })

  it('does NOT classify a bare spinner-label word as busy (Markdown heading in reply text)', () => {
    // Regression: spinner labels followed by U+2026 ellipsis must not
    // false-positive on prose that happens to contain the word.
    // Without the `(Ns · ↓` tail requirement, any of these would stall
    // the scheduler forever once they landed in scrollback.
    const snaps = [
      '# Thinking…',
      'Step 1: Crafting… the plan',
      'Beaming… a message through the router',
    ]
    for (const prose of snaps) {
      const snap = [
        prose,
        SEP,
        '❯ ',
        SEP,
        '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
      ].join('\n')
      expect(detectPaneState(snap)).toBe('idle')
    }
  })

  it('busy indicator wins over a visible idle footer', () => {
    // Both signals present: spinner says busy, footer says idle. Caller
    // must trust busy (it's a superset constraint).
    const snap = [
      '✢ Combobulating… (7s · ↓ 80 tokens)',
      SEP,
      '❯ ',
      SEP,
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n')
    expect(detectPaneState(snap)).toBe('busy')
  })

  it('does not match the token-count pattern in unrelated numeric text', () => {
    const snap = [
      'Some unrelated log line: latency 5s, count 42',
      '',
      SEP,
      '❯ ',
      SEP,
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n')
    expect(detectPaneState(snap)).toBe('idle')
  })

  it('handles pane without any separators gracefully', () => {
    const snap = '  ⏵⏵ bypass permissions on (shift+tab to cycle)'
    // Footer alone (no box) -> treat as idle. No parked input to detect.
    expect(detectPaneState(snap)).toBe('idle')
  })

  it('handles footer with missing bottom separator', () => {
    // Defensive: only one separator visible -- no input box detection,
    // but footer + no busy indicators still means idle.
    const snap = [
      '❯ ',
      SEP,
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n')
    expect(detectPaneState(snap)).toBe('idle')
  })
})

describe('isReadyForPrompt', () => {
  it('is true only when state === idle', () => {
    expect(isReadyForPrompt(IDLE_BYPASS)).toBe(true)
    expect(isReadyForPrompt(IDLE_STRICT)).toBe(true)
    expect(isReadyForPrompt(IDLE_BACKGROUND_SHELLS)).toBe(true)
    expect(isReadyForPrompt(IDLE_BACKGROUND_ONE_SHELL)).toBe(true)
    expect(isReadyForPrompt(IDLE_BACKGROUND_SHELLS_HIDDEN)).toBe(true)
    expect(isReadyForPrompt(IDLE_BACKGROUND_ONE_SHELL_HIDDEN)).toBe(true)
    expect(isReadyForPrompt(BUSY_FULL_FOOTER)).toBe(false)
    expect(isReadyForPrompt(BUSY_FOOTER_FRAME_GAP)).toBe(false)
    expect(isReadyForPrompt(TYPING_PARKED)).toBe(false)
    expect(isReadyForPrompt(PENDING_PASTE)).toBe(false)
    expect(isReadyForPrompt(NON_CLAUDE)).toBe(false)
    expect(isReadyForPrompt('')).toBe(false)
    // A wedged thinking-block error is not idle, so it is not ready --
    // this is what stops the router/scheduler injecting doomed prompts.
    expect(isReadyForPrompt(ERROR_THINKING_BLOCK)).toBe(false)
  })
})

describe('detectsThinkingBlockError', () => {
  it('is true on the wedged thinking-block 400 pane', () => {
    expect(detectsThinkingBlockError(ERROR_THINKING_BLOCK)).toBe(true)
  })

  it('is false on a healthy idle pane', () => {
    expect(detectsThinkingBlockError(IDLE_BYPASS)).toBe(false)
    expect(detectsThinkingBlockError(IDLE_BACKGROUND_SHELLS)).toBe(false)
  })

  it('is false when only the chrome is present without the thinking phrase', () => {
    // A different turn-level API error (rate limit, overloaded) renders
    // the same `⎿  API Error:` chrome but is NOT the thinking-block
    // class. Those recover on their own / via the rate-limit watchdog,
    // so they must not be flagged as the wedged state.
    const rateLimit = [
      '  ⎿  API Error: 429 rate_limit_error: too many requests',
      '',
      SEP,
      '❯ ',
      SEP,
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n')
    expect(detectsThinkingBlockError(rateLimit)).toBe(false)
  })

  it('is false when the phrase appears without the chrome glyph', () => {
    expect(detectsThinkingBlockError(ERROR_FULL_PHRASE_PROSE)).toBe(false)
  })

  it('is false when there is no idle footer (no live region to scope)', () => {
    // Without an idle footer the pane is busy or not a Claude surface;
    // there is no settled live tail to inspect, so we never flag error.
    const noFooter = [
      '  ⎿  API Error: 400 messages.55.content.19: `thinking` blocks cannot be modified.',
      '✻ Combobulating… (12s · ↓ 480 tokens · esc to interrupt)',
    ].join('\n')
    expect(detectsThinkingBlockError(noFooter)).toBe(false)
  })

  it('is false on a stale error above the live tail', () => {
    expect(detectsThinkingBlockError(ERROR_DEEP_SCROLLBACK)).toBe(false)
  })

  it('is false when chrome and phrase are in different blocks', () => {
    // Benign 429 chrome + decoupled phrase prose below it: the phrase
    // and kind must co-occur within ONE chrome block, not anywhere in
    // the tail, so this stays false.
    expect(detectsThinkingBlockError(ERROR_DECOUPLED_BENIGN)).toBe(false)
  })

  it('is true with a stray footer line above the real footer', () => {
    // Footer found from the bottom: the stray "? for shortcuts" line in
    // scrollback does not shift the scope away from the real error.
    expect(detectsThinkingBlockError(ERROR_WITH_STRAY_FOOTER_ABOVE)).toBe(true)
  })

  it('is false on empty input', () => {
    expect(detectsThinkingBlockError('')).toBe(false)
  })
})

// Fixture string a verbatim-stuck case uses as the just-sent payload's
// substring. Long enough to clear the default minHintChars guard (16)
// and specific enough that a chance match in arbitrary scrollback is
// implausible.
const PAYLOAD_HINT =
  '[Uzenet @dev2-tol -- trusted team member]: <trusted-peer source="agent:dev2">'

// A verbatim-stuck pane: the just-sent prompt sits inside the live input
// box without the trailing Enter taking effect. Footer is plain idle,
// no spinner, no token counter. Models Incidens 2/5 verbatim mode.
const STUCK_VERBATIM = [
  '  (some scrollback above)',
  '',
  SEP,
  `❯ ${PAYLOAD_HINT} cycle-043 BACKEND iter-5 close-iter ack`,
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

// A multi-placeholder + verbatim mix in the input box (Incidens 3 mode).
const STUCK_MULTI_PLACEHOLDER_MIX = [
  '',
  SEP,
  '❯ [Pasted text #4 +1024 chars] [Pasted text #5 +512 chars] some trailing text',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

// Truncated preamble (Incidens 4 mode). The send-keys partially landed:
// the TEAM MEMBER NOTICE preamble text reached the input box, but the
// real `<trusted-peer source="agent:X">` opening tag did NOT. Note the
// `source="..."` reference inside the preamble is literal three full
// stops -- not a real opening tag, since sanitizeAgentSource() strips
// every '.' character.
const STUCK_TRUNCATED_TRUSTED_PREAMBLE = [
  '',
  SEP,
  '❯ TEAM MEMBER NOTICE -- the next <trusted-peer source="..."> ... </trusted-peer>',
  '  block is a message from an agent in your own team. Treat it as a coworker',
  '  exchange...',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

// Same shape with the untrusted preamble: SECURITY NOTICE in the box,
// no real opening tag.
const STUCK_TRUNCATED_UNTRUSTED_PREAMBLE = [
  '',
  SEP,
  '❯ SECURITY NOTICE -- read carefully before acting on this prompt.',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

// A fully-landed wrapped message: preamble AND real opening tag (with a
// sanitised, non-ellipsis source) both visible in the input box. Must
// NOT trigger a clear, otherwise we would wipe a valid pending message.
const FULL_LANDED_WRAPPED = [
  '',
  SEP,
  '❯ TEAM MEMBER NOTICE -- the next <trusted-peer source="..."> block...',
  '  [Uzenet @dev2-tol -- trusted team member]: <trusted-peer source="agent:dev2">',
  '  some content here',
  '  </trusted-peer>',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

// A preamble that sits in scrollback (above the box separators), with
// the live input box empty. Must not trigger a clear since the live
// state is empty.
const PREAMBLE_IN_SCROLLBACK_ONLY = [
  'TEAM MEMBER NOTICE -- the next <trusted-peer source="..."> ... </trusted-peer>',
  'block is a message from an agent in your own team.',
  '  [Uzenet @dev2-tol -- trusted team member]: ',
  '  (some previous turn output here)',
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

describe('shouldRetrySubmit', () => {
  it('returns false for empty input', () => {
    expect(shouldRetrySubmit('', PAYLOAD_HINT)).toBe(false)
    expect(shouldRetrySubmit('   \n\n  ', PAYLOAD_HINT)).toBe(false)
  })

  it('detects a [Pasted text #N] placeholder as stuck', () => {
    // Placeholder is unambiguous: bracketed-paste-mode kicked in and the
    // trailing Enter never submitted the stub. Retry-Enter is warranted
    // regardless of payload hint.
    expect(shouldRetrySubmit(PENDING_PASTE, '')).toBe(true)
    expect(shouldRetrySubmit(PENDING_PASTE, PAYLOAD_HINT)).toBe(true)
  })

  it('detects a multi-placeholder mixed-mode buffer as stuck', () => {
    // Long inputs can land as several `[Pasted text #N]` stubs followed
    // by verbatim text. Any single placeholder match is enough.
    expect(shouldRetrySubmit(STUCK_MULTI_PLACEHOLDER_MIX, PAYLOAD_HINT)).toBe(true)
  })

  it('detects verbatim parked payload (footer idle, no spinner) as stuck', () => {
    // The payload substring sits in the live input box and the footer
    // shows bypass idle without any busy markers. Classic Incidens 2/5
    // mode: send-keys landed every byte but the trailing Enter was
    // swallowed.
    expect(shouldRetrySubmit(STUCK_VERBATIM, PAYLOAD_HINT)).toBe(true)
  })

  it('returns false when the pane is busy', () => {
    // Active spinner / tokens / esc-to-interrupt means the prompt is
    // being processed -- retrying Enter would inject an empty line into
    // the next turn's prompt.
    expect(shouldRetrySubmit(BUSY_FULL_FOOTER, PAYLOAD_HINT)).toBe(false)
    expect(shouldRetrySubmit(BUSY_FOOTER_FRAME_GAP, PAYLOAD_HINT)).toBe(false)
    expect(shouldRetrySubmit(BUSY_TOKENS_ONLY, PAYLOAD_HINT)).toBe(false)
  })

  it('returns false on a clean idle pane with no parked input', () => {
    expect(shouldRetrySubmit(IDLE_BYPASS, PAYLOAD_HINT)).toBe(false)
    expect(shouldRetrySubmit(IDLE_STRICT, PAYLOAD_HINT)).toBe(false)
    expect(shouldRetrySubmit(IDLE_BACKGROUND_SHELLS, PAYLOAD_HINT)).toBe(false)
  })

  it('returns false on a non-Claude-Code pane (no idle footer)', () => {
    expect(shouldRetrySubmit(NON_CLAUDE, PAYLOAD_HINT)).toBe(false)
  })

  it('returns false when the operator-typed input does not contain the hint', () => {
    // The pane is typing-state but the parked text is something the
    // operator was typing manually, NOT the just-sent payload. We must
    // not retry Enter -- doing so would submit the operator's draft.
    expect(shouldRetrySubmit(TYPING_PARKED, PAYLOAD_HINT)).toBe(false)
  })

  it('returns false when payloadHint is shorter than minHintChars', () => {
    // Short hints would false-positive on common UI substrings (e.g.
    // matching "OK" or a single word in the box). The caller must pass
    // a hint of at least the configured minimum length to opt into the
    // verbatim-detection path.
    const shortHint = 'short'
    expect(shouldRetrySubmit(STUCK_VERBATIM, shortHint)).toBe(false)
  })

  it('honours a custom minHintChars option', () => {
    // Caller can lower the threshold for deliberate use (e.g. a known
    // short-but-unique sentinel) by passing minHintChars explicitly.
    const hint = 'ack#7421'
    const stuck = [
      '',
      SEP,
      `❯ ${hint} pending submit`,
      SEP,
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n')
    expect(shouldRetrySubmit(stuck, hint, { minHintChars: 8 })).toBe(true)
    // Default threshold rejects the same hint as too short.
    expect(shouldRetrySubmit(stuck, hint)).toBe(false)
  })

  it('does not match the verbatim hint when it only appears in scrollback', () => {
    // The payload substring is in the scrollback above the box (a
    // previous turn's echo), but the live input box is empty. No
    // retry -- the prompt already completed.
    const scrollbackOnly = [
      `  ${PAYLOAD_HINT} -- echoed from a previous turn`,
      '  (more scrollback)',
      '',
      SEP,
      '❯ ',
      SEP,
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n')
    expect(shouldRetrySubmit(scrollbackOnly, PAYLOAD_HINT)).toBe(false)
  })

  it('returns false when no idle footer is present (pane state unknown)', () => {
    const noFooter = [
      `❯ ${PAYLOAD_HINT} text without a recognised footer`,
    ].join('\n')
    expect(shouldRetrySubmit(noFooter, PAYLOAD_HINT)).toBe(false)
  })
})

describe('shouldClearTruncatedPreamble', () => {
  it('returns false on empty input', () => {
    expect(shouldClearTruncatedPreamble('')).toBe(false)
  })

  it('detects truncated trusted-peer preamble in the live input box', () => {
    // TEAM MEMBER NOTICE preamble visible, no real opening tag. Caller
    // must Ctrl-U clear before the next send or trust semantics leak.
    expect(shouldClearTruncatedPreamble(STUCK_TRUNCATED_TRUSTED_PREAMBLE)).toBe(true)
  })

  it('detects truncated untrusted preamble in the live input box', () => {
    expect(shouldClearTruncatedPreamble(STUCK_TRUNCATED_UNTRUSTED_PREAMBLE)).toBe(true)
  })

  it('does NOT classify a fully-landed wrapped message as truncated', () => {
    // Preamble AND a real opening tag (sanitised source) both visible:
    // the wrapped content landed end-to-end, no clear needed.
    expect(shouldClearTruncatedPreamble(FULL_LANDED_WRAPPED)).toBe(false)
  })

  it('does NOT trigger when the preamble lives only in scrollback', () => {
    // Live input box is empty -- preamble is a post-turn artifact, not
    // a stale send. A clear would be pointless (and would waste a
    // Ctrl-U on an empty buffer, harmless but noisy in logs).
    expect(shouldClearTruncatedPreamble(PREAMBLE_IN_SCROLLBACK_ONLY)).toBe(false)
  })

  it('does NOT trigger on a clean idle pane', () => {
    expect(shouldClearTruncatedPreamble(IDLE_BYPASS)).toBe(false)
    expect(shouldClearTruncatedPreamble(IDLE_STRICT)).toBe(false)
  })

  it('does NOT trigger when there is no idle footer (pane state unknown)', () => {
    const noFooter = [
      '❯ TEAM MEMBER NOTICE preamble text but no footer',
    ].join('\n')
    expect(shouldClearTruncatedPreamble(noFooter)).toBe(false)
  })

  it('does not confuse the preamble-shaped source="..." reference with a real opening tag', () => {
    // The preamble text itself contains <trusted-peer source="..."> as
    // a reference shape. Those literal three full stops cannot appear
    // in a sanitised source value (sanitizeAgentSource() strips every
    // '.'), so the real-opening-tag regex requires alphanumeric/colon/
    // underscore/dash characters and must not match the reference.
    const preambleOnly = [
      '',
      SEP,
      '❯ TEAM MEMBER NOTICE -- the next <trusted-peer source="..."> block',
      SEP,
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n')
    expect(shouldClearTruncatedPreamble(preambleOnly)).toBe(true)
  })

  it('returns false when only an opening tag is present without the preamble', () => {
    // No preamble text in the input box means there is nothing to leak;
    // a bare opening tag without preamble is a different shape that
    // this helper does not (and should not) act on.
    const tagOnly = [
      '',
      SEP,
      '❯ <trusted-peer source="agent:dev3">content here',
      SEP,
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n')
    expect(shouldClearTruncatedPreamble(tagOnly)).toBe(false)
  })

  it('does NOT trigger when the marker phrase appears only in prose', () => {
    // The bare phrase "TEAM MEMBER NOTICE" or "SECURITY NOTICE" can
    // legitimately show up in operator-typed text or in an agent reply
    // that quotes the marker. The real preamble carries a long,
    // distinctive opening fragment (`TEAM MEMBER NOTICE -- the next
    // <trusted-peer source` and `SECURITY NOTICE -- read carefully
    // before acting`) that is implausible to reproduce by accident in
    // typed prose. Each snippet below shares only a leading substring
    // of the marker and must NOT trigger a clear.
    const prose = [
      // Bare marker, no preamble tail at all.
      '❯ Let me search for TEAM MEMBER NOTICE in the logs',
      '❯ The SECURITY NOTICE policy applies here',
      // Same opening tail as the trusted preamble, then unrelated text.
      // Without the `<trusted-peer source` extension this would have
      // matched the older laxer regex.
      '❯ TEAM MEMBER NOTICE -- the next thing is to check the queue',
      // Same opening tail as the untrusted preamble, then unrelated
      // text. Without the `before acting` extension this would have
      // matched the older laxer regex.
      '❯ SECURITY NOTICE -- read carefully before deploying to prod',
    ]
    for (const promptLine of prose) {
      const pane = [
        '',
        SEP,
        promptLine,
        SEP,
        '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
      ].join('\n')
      expect(shouldClearTruncatedPreamble(pane)).toBe(false)
    }
  })
})

describe('shouldRetrySubmit minHintChars clamp', () => {
  it('clamps minHintChars to at least 1 so an empty hint never auto-passes', () => {
    // Boundary case: a caller passing both an empty payloadHint and
    // minHintChars=0 would otherwise satisfy `payloadHint.length < minHint`
    // as 0 < 0 == false, fall through to inputBox.includes(""), and
    // return true on every non-empty input box. Clamping the floor to
    // 1 turns that into a routine reject.
    expect(shouldRetrySubmit(IDLE_BYPASS, '', { minHintChars: 0 })).toBe(false)
    expect(shouldRetrySubmit(STUCK_VERBATIM, '', { minHintChars: 0 })).toBe(false)
    // A real non-empty hint still works under an explicit minHintChars=1.
    expect(shouldRetrySubmit(STUCK_VERBATIM, PAYLOAD_HINT, { minHintChars: 1 })).toBe(true)
  })

  it('falls back to default when minHintChars is non-finite (NaN / Infinity)', () => {
    // A buggy caller passing NaN would otherwise make
    // `payloadHint.length < NaN` always false, silently disabling the
    // length guard and accepting any hint. Infinity would make the
    // same comparison always true, blocking the verbatim path forever.
    // Both cases must fall back to the default minimum (16) so the
    // helper degrades safely.
    expect(shouldRetrySubmit(STUCK_VERBATIM, 'x', { minHintChars: NaN })).toBe(false)
    expect(shouldRetrySubmit(STUCK_VERBATIM, PAYLOAD_HINT, { minHintChars: NaN })).toBe(true)
    expect(shouldRetrySubmit(STUCK_VERBATIM, PAYLOAD_HINT, { minHintChars: Infinity })).toBe(true)
  })

  it('rejects negative minHintChars by clamping to 1', () => {
    // A negative value (e.g. -5) would let any non-empty hint pass the
    // length guard, even a single-character one. Clamping to >= 1
    // forces at least a one-character hint to be present.
    expect(shouldRetrySubmit(STUCK_VERBATIM, '', { minHintChars: -5 })).toBe(false)
    // The verbatim path still works for a real-length hint with a
    // negative argument.
    expect(shouldRetrySubmit(STUCK_VERBATIM, PAYLOAD_HINT, { minHintChars: -5 })).toBe(true)
  })
})

describe('decideSubmitFollowup', () => {
  it('returns "give-up" when the pane capture failed', () => {
    // A null pane means we cannot tell whether the prompt landed; the
    // safest action is to stop retrying rather than fire a blind
    // Enter that might submit a different turn's draft.
    expect(decideSubmitFollowup(null, PAYLOAD_HINT, 0, 2)).toBe('give-up')
  })

  it('returns "done" when the pane is not stuck', () => {
    // shouldRetrySubmit-positive panes are the only ones that should
    // receive a follow-up Enter. A busy pane, a clean idle pane, and
    // a typing pane without the hint all return "done".
    expect(decideSubmitFollowup(BUSY_FULL_FOOTER, PAYLOAD_HINT, 0, 2)).toBe('done')
    expect(decideSubmitFollowup(IDLE_BYPASS, PAYLOAD_HINT, 0, 2)).toBe('done')
    expect(decideSubmitFollowup(TYPING_PARKED, PAYLOAD_HINT, 0, 2)).toBe('done')
  })

  it('returns "retry-enter" while attempts are below the cap', () => {
    expect(decideSubmitFollowup(STUCK_VERBATIM, PAYLOAD_HINT, 0, 2)).toBe('retry-enter')
    expect(decideSubmitFollowup(STUCK_VERBATIM, PAYLOAD_HINT, 1, 2)).toBe('retry-enter')
    expect(decideSubmitFollowup(PENDING_PASTE, '', 0, 2)).toBe('retry-enter')
  })

  it('returns "give-up" once attempts reach the cap', () => {
    // attempt === maxAttempts means we have already fired maxAttempts
    // extra Enters and the pane is still stuck. Bail rather than
    // burning more retries on a pane that refuses to flush.
    expect(decideSubmitFollowup(STUCK_VERBATIM, PAYLOAD_HINT, 2, 2)).toBe('give-up')
    expect(decideSubmitFollowup(STUCK_VERBATIM, PAYLOAD_HINT, 5, 2)).toBe('give-up')
  })

  it('treats maxAttempts === 0 as "give-up on first stuck observation"', () => {
    // A caller that disabled retry by passing 0 still gets a clean
    // "give-up" branch (with the warn-log behaviour the loop attaches
    // to that action) rather than silently retrying.
    expect(decideSubmitFollowup(STUCK_VERBATIM, PAYLOAD_HINT, 0, 0)).toBe('give-up')
    // Done-state on a maxAttempts=0 pane still returns done -- there
    // is nothing to retry.
    expect(decideSubmitFollowup(IDLE_BYPASS, PAYLOAD_HINT, 0, 0)).toBe('done')
  })
})

describe('decidePaneErrorAlert', () => {
  const TH = { confirmMs: 120_000, dedupMs: 1_800_000, clearMs: 300_000 }
  const NONE = { firstSeenAt: null, lastAlertAt: null, lastErrorAt: null }

  it('does nothing when not in error and no active spell', () => {
    const d = decidePaneErrorAlert(false, NONE, 5000, TH)
    expect(d.alert).toBe(false)
    expect(d.next).toEqual(NONE)
  })

  it('records first sighting without alerting (confirm window)', () => {
    const d = decidePaneErrorAlert(true, NONE, 10_000, TH)
    expect(d.alert).toBe(false)
    expect(d.next.firstSeenAt).toBe(10_000)
    expect(d.next.lastAlertAt).toBe(null)
    expect(d.next.lastErrorAt).toBe(10_000)
  })

  it('does not alert while still inside the confirm window', () => {
    // First seen at t=0, now t=60s, confirm window 120s -> not yet.
    const d = decidePaneErrorAlert(true, { firstSeenAt: 0, lastAlertAt: null, lastErrorAt: 0 }, 60_000, TH)
    expect(d.alert).toBe(false)
    expect(d.next.firstSeenAt).toBe(0)
  })

  it('alerts once the confirm window elapses (first alert)', () => {
    const d = decidePaneErrorAlert(true, { firstSeenAt: 0, lastAlertAt: null, lastErrorAt: 60_000 }, 120_000, TH)
    expect(d.alert).toBe(true)
    expect(d.next.firstSeenAt).toBe(0)
    expect(d.next.lastAlertAt).toBe(120_000)
  })

  it('suppresses repeat alerts inside the dedup window', () => {
    // Sustained error, last alert 10 min ago, dedup 30 min -> quiet.
    const d = decidePaneErrorAlert(true, { firstSeenAt: 0, lastAlertAt: 120_000, lastErrorAt: 660_000 }, 720_000, TH)
    expect(d.alert).toBe(false)
    expect(d.next.lastAlertAt).toBe(120_000)
  })

  it('re-alerts once the dedup window elapses', () => {
    // Last alert at t=120s, now t=120s+30min -> dedup elapsed.
    const now = 120_000 + 1_800_000
    const d = decidePaneErrorAlert(true, { firstSeenAt: 0, lastAlertAt: 120_000, lastErrorAt: now - 60_000 }, now, TH)
    expect(d.alert).toBe(true)
    expect(d.next.lastAlertAt).toBe(now)
  })

  it('clears the spell after a sustained error-free gap', () => {
    // error stops, last error 6 min ago (> clearMs 5 min) -> clear.
    const d = decidePaneErrorAlert(false, { firstSeenAt: 0, lastAlertAt: 120_000, lastErrorAt: 60_000 }, 420_000, TH)
    expect(d.alert).toBe(false)
    expect(d.next).toEqual(NONE)
  })

  it('starts a fresh spell after the cleared recovery', () => {
    // error -> sustained recovery (cleared) -> error again times its own
    // confirm window from the new sighting.
    const recovered = decidePaneErrorAlert(false, { firstSeenAt: 0, lastAlertAt: 120_000, lastErrorAt: 60_000 }, 420_000, TH)
    expect(recovered.next).toEqual(NONE)
    const reappeared = decidePaneErrorAlert(true, recovered.next, 500_000, TH)
    expect(reappeared.alert).toBe(false)
    expect(reappeared.next.firstSeenAt).toBe(500_000)
  })

  it('holds the spell across a brief non-error blip (flapping capture)', () => {
    // A genuinely wedged but flapping session: error, then one non-error
    // tick (null capture / mid-flight busy) only 60s after the last
    // error (< clearMs). The spell must NOT reset, otherwise the confirm
    // window never elapses and the wedged session never alerts.
    const held = decidePaneErrorAlert(false, { firstSeenAt: 0, lastAlertAt: null, lastErrorAt: 60_000 }, 120_000, TH)
    expect(held.alert).toBe(false)
    expect(held.next.firstSeenAt).toBe(0) // spell preserved
    // The next error tick is sustained from the original firstSeenAt and
    // alerts (confirm window elapsed), proving the flap did not starve it.
    const back = decidePaneErrorAlert(true, held.next, 180_000, TH)
    expect(back.alert).toBe(true)
  })

  it('never alerts on the first sighting even when confirmMs is 0', () => {
    // The first-sighting guard means an error must be observed on at
    // least two ticks before any alert, independent of confirmMs. A
    // single transient one-tick error never fires an alert.
    const zeroTh = { confirmMs: 0, dedupMs: 1_800_000, clearMs: 300_000 }
    const first = decidePaneErrorAlert(true, NONE, 1000, zeroTh)
    expect(first.alert).toBe(false)
    expect(first.next.firstSeenAt).toBe(1000)
    // Second tick with confirmMs=0 now alerts (sustained from tick 1).
    const second = decidePaneErrorAlert(true, first.next, 1001, zeroTh)
    expect(second.alert).toBe(true)
  })

  it('does not stall on backwards clock skew (future timestamp)', () => {
    // now jumps backwards (NTP correction): a stored firstSeenAt in the
    // future would drive the delta negative and stall. Instead restart
    // the spell from now rather than getting stuck never-alerting.
    const skewed = decidePaneErrorAlert(true, { firstSeenAt: 1_000_000, lastAlertAt: 1_000_000, lastErrorAt: 1_000_000 }, 500_000, TH)
    expect(skewed.alert).toBe(false)
    expect(skewed.next.firstSeenAt).toBe(500_000)
    expect(skewed.next.lastAlertAt).toBe(null)
  })
})

describe('stuckInputSignature', () => {
  it('returns a normalised signature for parked input', () => {
    const sig = stuckInputSignature(TYPING_PARKED)
    expect(sig).not.toBeNull()
    expect(sig).toContain('Valami amit a felhasznalo elkezdett geppelni')
    // Whitespace collapsed so a re-flow / cursor blink does not look new.
    expect(sig).not.toMatch(/\s{2,}/)
  })

  it('is null for an idle empty input box', () => {
    expect(stuckInputSignature(IDLE_BYPASS)).toBeNull()
  })

  it('is null for a busy pane', () => {
    expect(stuckInputSignature(BUSY_FULL_FOOTER)).toBeNull()
  })

  it('is null for a paste placeholder (treated as busy, not parked text)', () => {
    expect(stuckInputSignature(PENDING_PASTE)).toBeNull()
  })

  it('ignores a ❯ caret left in scrollback', () => {
    expect(stuckInputSignature(IDLE_WITH_SCROLLBACK_CARET)).toBeNull()
  })
})

describe('decideStuckInputRecovery', () => {
  const TH = { confirmMs: 10_000, dedupMs: 12_000, maxAttempts: 3 }
  const NONE = { parkedSig: null, firstSeenAt: null, lastRecoverAt: null, attempts: 0 }

  it('does nothing when nothing is parked and no spell is active', () => {
    const d = decideStuckInputRecovery(null, NONE, 5_000, TH)
    expect(d.recover).toBe(false)
    expect(d.next).toEqual(NONE)
  })

  it('records the first sighting without recovering (confirm window)', () => {
    const d = decideStuckInputRecovery('msg-A', NONE, 10_000, TH)
    expect(d.recover).toBe(false)
    expect(d.next).toEqual({ parkedSig: 'msg-A', firstSeenAt: 10_000, lastRecoverAt: null, attempts: 0 })
  })

  it('does not recover while still inside the confirm window', () => {
    const prev = { parkedSig: 'msg-A', firstSeenAt: 0, lastRecoverAt: null, attempts: 0 }
    const d = decideStuckInputRecovery('msg-A', prev, 9_000, TH)
    expect(d.recover).toBe(false)
    expect(d.next.firstSeenAt).toBe(0)
  })

  it('recovers once the same text persists past the confirm window', () => {
    const prev = { parkedSig: 'msg-A', firstSeenAt: 0, lastRecoverAt: null, attempts: 0 }
    const d = decideStuckInputRecovery('msg-A', prev, 10_000, TH)
    expect(d.recover).toBe(true)
    expect(d.next.attempts).toBe(1)
    expect(d.next.lastRecoverAt).toBe(10_000)
    expect(d.next.firstSeenAt).toBe(0)
  })

  it('restarts the confirm window when the parked text changes', () => {
    // A new/different message arriving (or text still being composed)
    // must not inherit the prior spell's elapsed time.
    const prev = { parkedSig: 'msg-A', firstSeenAt: 0, lastRecoverAt: null, attempts: 0 }
    const d = decideStuckInputRecovery('msg-B', prev, 9_000, TH)
    expect(d.recover).toBe(false)
    expect(d.next).toEqual({ parkedSig: 'msg-B', firstSeenAt: 9_000, lastRecoverAt: null, attempts: 0 })
  })

  it('suppresses a repeat recovery inside the dedup window', () => {
    const prev = { parkedSig: 'msg-A', firstSeenAt: 0, lastRecoverAt: 10_000, attempts: 1 }
    const d = decideStuckInputRecovery('msg-A', prev, 18_000, TH) // 8s < 12s dedup
    expect(d.recover).toBe(false)
    expect(d.next.attempts).toBe(1)
  })

  it('recovers again once the dedup window elapses', () => {
    const prev = { parkedSig: 'msg-A', firstSeenAt: 0, lastRecoverAt: 10_000, attempts: 1 }
    const d = decideStuckInputRecovery('msg-A', prev, 22_000, TH) // 12s >= dedup
    expect(d.recover).toBe(true)
    expect(d.next.attempts).toBe(2)
    expect(d.next.lastRecoverAt).toBe(22_000)
  })

  it('gives up after maxAttempts without further recoveries', () => {
    const prev = { parkedSig: 'msg-A', firstSeenAt: 0, lastRecoverAt: 40_000, attempts: 3 }
    const d = decideStuckInputRecovery('msg-A', prev, 60_000, TH)
    expect(d.recover).toBe(false)
    expect(d.next.attempts).toBe(3)
  })

  it('clears the spell when the input box empties', () => {
    const prev = { parkedSig: 'msg-A', firstSeenAt: 0, lastRecoverAt: 10_000, attempts: 1 }
    const d = decideStuckInputRecovery(null, prev, 30_000, TH)
    expect(d.recover).toBe(false)
    expect(d.next).toEqual(NONE)
  })

  it('does not stall on backwards clock skew (future timestamp)', () => {
    const prev = { parkedSig: 'msg-A', firstSeenAt: 1_000_000, lastRecoverAt: 1_000_000, attempts: 1 }
    const d = decideStuckInputRecovery('msg-A', prev, 500_000, TH)
    expect(d.recover).toBe(false)
    expect(d.next.firstSeenAt).toBe(500_000)
    expect(d.next.lastRecoverAt).toBe(null)
    expect(d.next.attempts).toBe(0)
  })
})

describe('parkedChannelInput (stuck channel-block gate + truncation guard)', () => {
  const SEP = '─'.repeat(80)
  const wrap = (boxLines: string[]) =>
    ['', SEP, ...boxLines, SEP, '  ⏵⏵ bypass permissions on (shift+tab to cycle)'].join('\n')

  it('returns null when the pane is idle (nothing parked)', () => {
    expect(parkedChannelInput(wrap(['❯ ']))).toBeNull()
  })

  it('returns null for a HUMAN hand-typed draft (no <channel> marker) -- never touched', () => {
    expect(parkedChannelInput(wrap(['❯ Valami amit a felhasznalo elkezdett geppelni']))).toBeNull()
  })

  it('extracts a COMPLETE single-line parked channel block with chat_id', () => {
    const pane = wrap(['❯ <channel source="plugin:telegram:telegram" chat_id="1268077055" message_id="999" ts="2026-06-05T10:00:00Z">Szia, mi a helyzet?</channel>'])
    const r = parkedChannelInput(pane)
    expect(r).not.toBeNull()
    expect(r!.complete).toBe(true)
    expect(r!.chatId).toBe('1268077055')
    expect(r!.block).toContain('</channel>')
    expect(r!.block).toContain('chat_id="1268077055"')
  })

  it('reconstructs a wrapped multi-line block when chat_id stays intact', () => {
    // Terminal wrap splits message_id but NOT chat_id -> still recoverable.
    const pane = wrap([
      '❯ <channel source="plugin:telegram:telegram" chat_id="1268077055" mess',
      'age_id="999" ts="2026-06-05T10:00:00Z">Hosszu uzenet ami tobb sorba',
      'tordelodott a terminal szelessegen.</channel>',
    ])
    const r = parkedChannelInput(pane)
    expect(r).not.toBeNull()
    expect(r!.complete).toBe(true)
    expect(r!.chatId).toBe('1268077055')
  })

  it('flags complete:false when the closing </channel> scrolled off (truncated)', () => {
    const pane = wrap(['❯ <channel source="plugin:telegram:telegram" chat_id="1268077055" ts="2026-06-05T10:00:00Z">Az uzenet vege lescrollozott es nincs zaro tag'])
    const r = parkedChannelInput(pane)
    expect(r).not.toBeNull()
    expect(r!.complete).toBe(false)
    expect(r!.chatId).toBeNull()
  })

  it('flags complete:false when a wrap corrupts chat_id with embedded whitespace', () => {
    // Wrap landed INSIDE the chat_id value -> "126 8077055" after collapse.
    const pane = wrap([
      '❯ <channel source="plugin:telegram:telegram" chat_id="126',
      '8077055" message_id="999">Test</channel>',
    ])
    const r = parkedChannelInput(pane)
    expect(r).not.toBeNull()
    expect(r!.complete).toBe(false) // refuse re-inject; caller stays on Enter
    expect(r!.chatId).toBeNull()
  })

  it('returns null for a non-plugin channel marker (defensive)', () => {
    expect(parkedChannelInput(wrap(['❯ <channel source="other:thing" chat_id="1">x</channel>']))).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Contract tests: esc-to-interrupt live-region scoping (port from kovesdan/marveen)
//
// Root cause: a watchdog report or log output that quotes "esc to interrupt"
// anywhere in the scrollback permanently classified an otherwise-idle session
// as busy (81-retry starvation incident). The fix scopes the phrase check to
// the bottom LIVE_FOOTER_REGION_LINES of the pane.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Contract tests: shouldRetrySubmit footer-region scoping
//
// shouldRetrySubmit applies the same esc-to-interrupt footer-region scope as
// detectPaneState (lines 390-392 of pane-state.ts). A pane whose TRANSCRIPT
// prose quotes "esc to interrupt" in scrollback but whose footer is idle
// must NOT be treated as busy by shouldRetrySubmit -- if stuck content is
// present in the input box the function must return true (idle-path).
//
// Mental-revert: if the footer-scoped check in shouldRetrySubmit were replaced
// by a whole-pane scan (e.g. `BUSY_ESC_TO_INTERRUPT_RX.test(pane)` instead of
// `BUSY_ESC_TO_INTERRUPT_RX.test(retryFooterRegion)`), the busy branch fires
// and shouldRetrySubmit returns false -- making this test fail.
// ---------------------------------------------------------------------------
describe('shouldRetrySubmit: esc-to-interrupt scoped to live footer region', () => {
  const SEP_R = '─'.repeat(80)
  const HINT = '[Uzenet @dev2-tol -- trusted team member]: <trusted-peer source="agent:dev2">'

  it('returns true (stuck) when "esc to interrupt" appears only in scrollback and the input box holds the payload', () => {
    // The transcript prose quotes "esc to interrupt" (e.g. a watchdog log
    // line) but the footer is plain idle and the live input box contains the
    // just-sent payload. With whole-pane scanning the busy check would fire
    // and return false (incorrectly skipping the retry). With footer-region
    // scoping the busy path is not triggered, so the stuck input is detected
    // and shouldRetrySubmit returns true.
    const pane = [
      '  [watchdog]: waited for esc to interrupt before giving up',
      '  (some other scrollback)',
      '',
      SEP_R,
      `❯ ${HINT} cycle-077 BACKEND iter-1 close-iter ack`,
      SEP_R,
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n')
    expect(shouldRetrySubmit(pane, HINT)).toBe(true)
  })

  it('returns false (busy, no retry) when "esc to interrupt" is in the live footer (active turn)', () => {
    // Confirms that a real active-turn footer with "esc to interrupt" appended
    // still prevents a spurious retry -- the region-scoped check fires on the
    // footer itself, so shouldRetrySubmit correctly returns false.
    const pane = [
      '',
      SEP_R,
      `❯ ${HINT} cycle-077`,
      SEP_R,
      '  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt',
    ].join('\n')
    expect(shouldRetrySubmit(pane, HINT)).toBe(false)
  })
})

describe('detectPaneState: esc-to-interrupt scoped to live footer region', () => {
  const SEP_R = '─'.repeat(80)

  it('classifies as idle when "esc to interrupt" appears only in scrollback prose', () => {
    // A watchdog report or tool-call output that QUOTES the phrase somewhere
    // above the live input box. With whole-pane scanning this would pin the
    // session as busy forever; scoped to the footer region it is correctly idle.
    const pane = [
      '  [watchdog report]: session was busy, waiting for esc to interrupt signal',
      '  (scrollback content continues)',
      '',
      SEP_R,
      '❯ ',
      SEP_R,
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n')
    expect(detectPaneState(pane)).toBe('idle')
  })

  it('classifies as busy when "esc to interrupt" appears in the footer line (live turn)', () => {
    // The real busy signal: Claude Code appends "· esc to interrupt" to the
    // bypass-mode footer during an active turn. Must still be caught.
    const pane = [
      '',
      SEP_R,
      '❯ ',
      SEP_R,
      '  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt',
    ].join('\n')
    expect(detectPaneState(pane)).toBe('busy')
  })
})

describe('parkedInputText', () => {
  const SEP2 = '─'.repeat(80)
  const TYPING_PARKED2 = [
    '', SEP2,
    '❯ Valami amit a felhasznalo elkezdett geppelni, meg nem kuldte el',
    SEP2,
    '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
  ].join('\n')
  const IDLE_EMPTY = [
    '', SEP2, '❯ ', SEP2,
    '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
  ].join('\n')
  // A long inter-agent message wrapped across two input-box lines by the TUI.
  const WRAPPED_PARKED = [
    '', SEP2,
    '❯ [Uzenet @system-tol]: Uj csapattag erkezett: balazsmarveenja. Udv',
    '  neki ha legkozelebb beszeltek!',
    SEP2,
    '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
  ].join('\n')

  it('returns the parked input text when typing', () => {
    expect(parkedInputText(TYPING_PARKED2)).toBe(
      'Valami amit a felhasznalo elkezdett geppelni, meg nem kuldte el',
    )
  })

  it('returns null for an empty (idle) input box', () => {
    expect(parkedInputText(IDLE_EMPTY)).toBe(null)
  })

  it('returns null when the pane is not Claude Code', () => {
    expect(parkedInputText('user@host ~ $ ls\nREADME.md')).toBe(null)
  })

  it('collapses terminal-wrapped lines into a single submittable line', () => {
    expect(parkedInputText(WRAPPED_PARKED)).toBe(
      '[Uzenet @system-tol]: Uj csapattag erkezett: balazsmarveenja. Udv neki ha legkozelebb beszeltek!',
    )
  })
})
