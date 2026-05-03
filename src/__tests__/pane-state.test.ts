import { describe, it, expect } from 'vitest'
import { detectPaneState, isReadyForPrompt } from '../pane-state.js'

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
  'zino@marveen ~ $ ls',
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
  })
})
