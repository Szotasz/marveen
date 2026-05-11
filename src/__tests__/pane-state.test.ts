import { describe, it, expect } from 'vitest'
import {
  detectPaneState,
  isReadyForPrompt,
  shouldRetrySubmit,
  shouldClearTruncatedPreamble,
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
