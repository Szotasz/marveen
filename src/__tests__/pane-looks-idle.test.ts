import { describe, it, expect } from 'vitest'
import { paneLooksIdle, isReadyForPrompt } from '../pane-state.js'

// Unit tests for paneLooksIdle -- the pure idle predicate extracted as the
// SINGLE source of truth for "is this pane idle / safe to send a prompt into".
// It backs three call sites: the readiness check (isReadyForPrompt), the
// auto-restart idle-guard (auto-restart-runner.paneIsIdle), and the
// sendPromptToSession pre-flight wait-until-idle gate (waitForPaneIdle).
//
// These assertions are on DETERMINISTIC string->bool output only; no LLM
// behaviour, no tmux, no timers. Fixtures reproduce real `tmux capture-pane -p`
// bytes (U+2500 ─ box separators, U+276F ❯ prompt, U+23F5 ⏵ footer chevrons,
// U+00B7 · footer dot). Sanitised: no internal names/paths.

const SEP = '─'.repeat(80)

// --- Idle surfaces (predicate must be TRUE) ---

// Default bypass-permissions footer with the shift+tab-cycle hint, empty box.
const IDLE_BYPASS = [
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

// Strict-mode footer ("? for shortcuts"), empty box -- also idle.
const IDLE_STRICT = [
  '',
  SEP,
  '❯ ',
  SEP,
  '  ? for shortcuts',
].join('\n')

// Background-shells footer variant. A session with a BashTool background shell
// rewrites the footer to "· N shells · ... · ↓ to manage" but is still idle and
// MUST accept a prompt, else its scheduled tasks / inbox pile up forever.
const IDLE_BACKGROUND_SHELLS = [
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on · 3 shells · ctrl+t to hide tasks · ↓ to manage',
].join('\n')

// Post-tool-use idle: a "Searched / Listed" summary persists in scrollback
// after the turn ended, but no spinner / tokens / esc-to-interrupt. Idle.
const IDLE_AFTER_TOOL_USE = [
  '  Searched for 3 patterns, listed 4 directories (ctrl+o to expand)',
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

// Multibyte / non-ASCII content sitting in scrollback above an empty, idle
// input box. The idle classification must not be perturbed by wide glyphs,
// accented Latin, CJK or emoji in the reply text above.
const IDLE_MULTIBYTE_SCROLLBACK = [
  '⏺ Kész: az árvíztűrő tükörfúrógép működik. 完了しました 🚀 -- ✅',
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

// --- Busy surfaces (predicate must be FALSE) ---

// Full busy footer: spinner + token counter + `esc to interrupt`.
const BUSY_FULL_FOOTER = [
  '✢ Combobulating… (52s · ↓ 2.6k tokens · thinking some more)',
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt',
].join('\n')

// The frame-gap: spinner rendered but the footer is momentarily still in its
// idle shape (no `· esc to interrupt` yet). The token/spinner signal must keep
// this classified busy -- this is the exact false-positive the predicate
// closes (a tick here previously sent a prompt into a mid-turn pane).
const BUSY_FOOTER_FRAME_GAP = [
  '✢ Combobulating… (52s · ↓ 2.6k tokens · thinking some more)',
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

// Only the `esc to interrupt` footer marker present (no visible spinner line).
const BUSY_ESC_ONLY = [
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt',
].join('\n')

// --- Not-ready non-idle surfaces (predicate must be FALSE) ---

// Text parked in the live input box (user composing, or a swallowed send) ->
// 'typing', not idle: a new prompt would concatenate onto it.
const TYPING_PARKED = [
  '',
  SEP,
  '❯ egy felig begepelt sor amit meg nem kuldtek el',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

// `[Pasted text #N]` placeholder in the input box -- the bracketed-paste stub
// that does not auto-submit; classified busy (not idle) so nothing piles on.
const PENDING_PASTE = [
  '',
  SEP,
  '❯ [Pasted text #1 +234 chars]',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

// A blocking interactive menu / modal (e.g. the /mcp manager or a picker):
// the input box is replaced by a nav list with "↑/↓ to navigate · Esc to
// cancel". No idle footer -> not idle.
const MODAL_BLOCKING_MENU = [
  '  Select an MCP server to manage:',
  '   1. alpha',
  '   2. bravo',
  '',
  '  ↑/↓ to navigate · Enter to confirm · Esc to cancel',
].join('\n')

// Resume-from-summary modal shown near the context limit: numbered options +
// "Enter to confirm", no bypass/strict footer -> not idle.
const MODAL_RESUME_SUMMARY = [
  '  Resume from summary',
  '   1. Resume from summary (recommended)',
  '   2. Start fresh',
  '',
  '  Enter to confirm',
].join('\n')

// Empty / whitespace-only capture (capture race, blank pane) -> not idle.
const EMPTY_CAPTURE = ''
const WHITESPACE_CAPTURE = '   \n  \n\t\n'

// A plain shell pane (not Claude Code at all) -> 'unknown', not idle.
const NON_CLAUDE = [
  'user@host project $ ls',
  'README.md  src  test',
  'user@host project $ ',
].join('\n')

describe('paneLooksIdle', () => {
  describe('idle surfaces -> true', () => {
    it('default bypass footer (shift+tab to cycle), empty box', () => {
      expect(paneLooksIdle(IDLE_BYPASS)).toBe(true)
    })
    it('strict-mode footer (? for shortcuts)', () => {
      expect(paneLooksIdle(IDLE_STRICT)).toBe(true)
    })
    it('background-shells footer variant', () => {
      expect(paneLooksIdle(IDLE_BACKGROUND_SHELLS)).toBe(true)
    })
    it('post-tool-use idle (summary in scrollback, no live busy signal)', () => {
      expect(paneLooksIdle(IDLE_AFTER_TOOL_USE)).toBe(true)
    })
    it('multibyte / emoji content in scrollback above an empty idle box', () => {
      expect(paneLooksIdle(IDLE_MULTIBYTE_SCROLLBACK)).toBe(true)
    })
  })

  describe('busy surfaces -> false', () => {
    it('full busy footer (spinner + tokens + esc to interrupt)', () => {
      expect(paneLooksIdle(BUSY_FULL_FOOTER)).toBe(false)
    })
    it('frame-gap: spinner present, footer momentarily idle-shaped', () => {
      expect(paneLooksIdle(BUSY_FOOTER_FRAME_GAP)).toBe(false)
    })
    it('esc to interrupt footer marker alone', () => {
      expect(paneLooksIdle(BUSY_ESC_ONLY)).toBe(false)
    })
  })

  describe('non-idle / not-ready surfaces -> false', () => {
    it('text parked in the live input box (typing)', () => {
      expect(paneLooksIdle(TYPING_PARKED)).toBe(false)
    })
    it('[Pasted text #N] placeholder in the input box', () => {
      expect(paneLooksIdle(PENDING_PASTE)).toBe(false)
    })
    it('blocking interactive menu / modal', () => {
      expect(paneLooksIdle(MODAL_BLOCKING_MENU)).toBe(false)
    })
    it('resume-from-summary modal', () => {
      expect(paneLooksIdle(MODAL_RESUME_SUMMARY)).toBe(false)
    })
    it('empty capture', () => {
      expect(paneLooksIdle(EMPTY_CAPTURE)).toBe(false)
    })
    it('whitespace-only capture', () => {
      expect(paneLooksIdle(WHITESPACE_CAPTURE)).toBe(false)
    })
    it('non-Claude shell pane', () => {
      expect(paneLooksIdle(NON_CLAUDE)).toBe(false)
    })
  })

  describe('isReadyForPrompt is a thin alias over paneLooksIdle', () => {
    const cases: Array<[string, string]> = [
      ['IDLE_BYPASS', IDLE_BYPASS],
      ['BUSY_FULL_FOOTER', BUSY_FULL_FOOTER],
      ['BUSY_FOOTER_FRAME_GAP', BUSY_FOOTER_FRAME_GAP],
      ['TYPING_PARKED', TYPING_PARKED],
      ['PENDING_PASTE', PENDING_PASTE],
      ['MODAL_BLOCKING_MENU', MODAL_BLOCKING_MENU],
      ['EMPTY_CAPTURE', EMPTY_CAPTURE],
      ['NON_CLAUDE', NON_CLAUDE],
    ]
    for (const [name, fixture] of cases) {
      it(`agrees with isReadyForPrompt on ${name}`, () => {
        expect(isReadyForPrompt(fixture)).toBe(paneLooksIdle(fixture))
      })
    }
  })
})
