import { describe, it, expect } from 'vitest'
import { detectPaneState, isReadyForPrompt } from '../pane-state.js'

// HOOKPHASEBUSY1027 (measured 2026-10-27 on live fleet panes, tmux capture-pane -p, read only): while Claude Code runs
// a hook phase the spinner line reads `(running <Event> hooks… N/M · <elapsed> · ↓ N tokens)`. The parenthesis does
// not open with the elapsed time, so neither BUSY_INDICATORS pattern matches it. With a background-shell footer
// (`⏵⏵ bypass permissions on · 1 shell`) the pane then read 'idle' and ready DURING a live turn, and the router could
// deliver into it. Seen on PreToolUse, PostToolUse, Stop and UserPromptSubmit, the last one also without a token
// counter (`… 8/10 · 0s)`). The frames below are the measured bottom lines; only the session title is neutralised.
const PRE_SHELL = [
    "· Osmosing… (running PreToolUse hooks… 0/6 · 4m 49s · ↓ 23.5k tokens)",
    "  ⎿  Tip: Use /btw to ask a quick side question without interrupting Claude\'s",
    "     current work",
    "──────────────────────────────────────────────────────────────────── builder ─",
    "❯ ",
    "────────────────────────────────────────────────────────────────────────────────",
    "  [Opus 5.5] ctx 188k/1000k (19%) · $30.63 · high",
    "  ⏵⏵ bypass permissions on · 1 shell",
  ].join('\n')
const PRE_WRAPPED = [
    "· Osmosing… (running PreToolUse hooks… 0/6 · 4m 47s · ↓ 23.4k tokens ·",
    "thought for 2s)",
    "  ⎿  Tip: Use /btw to ask a quick side question without interrupting Claude\'s",
    "     current work",
    "──────────────────────────────────────────────────────────────────── builder ─",
    "❯ ",
    "────────────────────────────────────────────────────────────────────────────────",
    "  [Opus 5.5] ctx 188k/1000k (19%) · $30.63 · high",
    "  ⏵⏵ bypass permissions on · 1 shell",
  ].join('\n')
const POST = [
    "✳ Sublimating… (running PostToolUse hooks… 1/2 · 1m 21s · ↓ 7.5k tokens)",
    "  ⎿  Tip: Use /btw to ask a quick side question without interrupting Claude\'s",
    "     current work",
    "──────────────────────────────────────────────────────────────────── builder ─",
    "❯ ",
    "────────────────────────────────────────────────────────────────────────────────",
    "  [Opus 5.5] ctx 202k/1000k (20%) · $31.24 · high",
    "  ⏵⏵ bypass permissions on · 1 shell",
  ].join('\n')
const STOP_2SHELLS = [
    "✻ Osmosing… (running Stop hooks… 2/3 · 5m 11s · ↓ 24.8k tokens)",
    "  ⎿  Tip: Use /btw to ask a quick side question without interrupting Claude\'s",
    "     current work",
    "──────────────────────────────────────────────────────────────────── builder ─",
    "❯ ",
    "────────────────────────────────────────────────────────────────────────────────",
    "  [Opus 5.5] ctx 193k/1000k (19%) · $30.87 · high",
    "  ⏵⏵ bypass permissions on · 2 shells",
  ].join('\n')
const PROMPT_NOTOKENS = [
    "· Razzle-dazzling… (running UserPromptSubmit hooks… 8/10 · 0s)",
    "  ⎿  Tip: Send messages to Claude while it works to steer Claude in real-time",
    "────────────────────────────────────────────────────────────────────── builder ─",
    "❯ ",
    "────────────────────────────────────────────────────────────────────────────────",
    "  [Opus 5.5] ctx 619k/1000k (62%) · $32.48 · high",
    "  ⏵⏵ bypass permissions on · 1 shell",
  ].join('\n')
const PRE_HINTFOOTER = [
    "✢ Razzle-dazzling… (running PreToolUse hooks… 3/7 · 24s · ↓ 1.2k tokens ·",
    "thought for 13s)",
    "  ⎿  Tip: Send messages to Claude while it works to steer Claude in real-time",
    "────────────────────────────────────────────────────────────────────── builder ─",
    "❯ ",
    "────────────────────────────────────────────────────────────────────────────────",
    "  [Opus 5.5] ctx 621k/1000k (62%) · $32.62 · high",
    "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
  ].join('\n')

// Measured right after the Stop hooks of the same session finished: Claude Code replaces the spinner line with the
// completion line, so no hook-phase line stays above the input box (15 busy-to-idle transitions watched, none left one).
const AFTER_STOP = [
    "  The handoff file is updated.",
    "✻ Sautéed for 1m 16s · done 1:49 AM",
    "────────────────────────────────────────────────────────────────────── builder ─",
    "❯ ",
    "────────────────────────────────────────────────────────────────────────────────",
    "  [Opus 5.5] ctx 714k/1000k (71%) ⚠ · $39.19 · high",
    "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
  ].join('\n')

const SEP = '─'.repeat(80)
const SHELL_FOOTER = '  ⏵⏵ bypass permissions on · 1 shell'

describe('a hook phase inside a live turn is busy (HOOKPHASEBUSY1027)', () => {
  it('reads the measured PreToolUse frame with a shell footer as busy, not ready', () => {
    expect(detectPaneState(PRE_SHELL)).toBe('busy')
    expect(isReadyForPrompt(PRE_SHELL)).toBe(false)
  })

  it('reads the measured frame whose spinner line wraps onto a second line as busy', () => {
    expect(detectPaneState(PRE_WRAPPED)).toBe('busy')
    expect(isReadyForPrompt(PRE_WRAPPED)).toBe(false)
  })

  it('reads the measured PostToolUse and Stop frames as busy', () => {
    for (const [name, pane] of [['POST', POST], ['STOP_2SHELLS', STOP_2SHELLS]] as const) {
      expect(detectPaneState(pane), name).toBe('busy')
      expect(isReadyForPrompt(pane), name).toBe(false)
    }
  })

  it('reads the measured UserPromptSubmit frame without a token counter as busy', () => {
    expect(detectPaneState(PROMPT_NOTOKENS)).toBe('busy')
    expect(isReadyForPrompt(PROMPT_NOTOKENS)).toBe(false)
  })

  it('reads the measured frame under the shift+tab footer as busy', () => {
    expect(detectPaneState(PRE_HINTFOOTER)).toBe('busy')
  })

  it('reads busy when tool output sits above the spinner line inside the live region', () => {
    const pane = ['⏺ Bash(ls -la)', '  ⎿  total 8', '     drwxr-xr-x  2 user  staff  64 .', PRE_SHELL].join('\n')
    expect(detectPaneState(pane)).toBe('busy')
  })

  it('reads busy when blank rows follow the hook-phase frame', () => {
    expect(detectPaneState(PRE_SHELL + '\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n')).toBe('busy')
  })

  it('reads busy for an hour-long elapsed time and the ASCII ellipsis', () => {
    for (const spin of ['✻ Osmosing… (running PreToolUse hooks… 2/6 · 1h 2m 3s · ↓ 90.1k tokens)',
      '✻ Osmosing… (running PreToolUse hooks... 2/6 · 12s · ↓ 1.0k tokens)']) {
      const pane = [spin, SEP, '❯ ', SEP, SHELL_FOOTER].join('\n')
      expect(detectPaneState(pane), spin).toBe('busy')
    }
  })

  // INVARIANS (green on the base too): the new shape must not pin an idle pane busy.
  it('keeps an idle pane idle when a stale hook-phase line sits above the live region', () => {
    const stale = ['✻ Osmosing… (running Stop hooks… 2/3 · 5m 11s · ↓ 24.8k tokens)']
    for (let i = 0; i < 15; i++) stale.push('  scrollback line ' + i)
    const pane = [...stale, SEP, '❯ ', SEP, SHELL_FOOTER].join('\n')
    expect(detectPaneState(pane)).toBe('idle')
    expect(isReadyForPrompt(pane)).toBe(true)
  })

  it('keeps an idle pane idle when prose in the live region mentions hooks without the counter', () => {
    for (const prose of ['  the log said: running PreToolUse hooks took long',
      '  (running PreToolUse hooks… later it stopped)', '  (running PreToolUse hooks 0/6 · done)',
      '  running PreToolUse hooks… 0/6 · 4m 49s · then it stopped']) {
      const pane = [prose, SEP, '❯ ', SEP, SHELL_FOOTER].join('\n')
      expect(detectPaneState(pane), prose).toBe('idle')
    }
  })

  it('reads the measured frame after the Stop hooks finished as idle and ready', () => {
    expect(detectPaneState(AFTER_STOP)).toBe('idle')
    expect(isReadyForPrompt(AFTER_STOP)).toBe(true)
  })

  it('keeps an idle pane idle when a line in the live region quotes the full hook-phase shape', () => {
    for (const quote of ['  Example: (running PreToolUse hooks… 0/6 · 4m 49s · ↓ 23.5k tokens)',
      'log: (running Stop hooks… 2/3 · 5m 11s)', '  - the spinner said (running PostToolUse hooks… 1/2 · 1m 21s)']) {
      const pane = [quote, SEP, '❯ ', SEP, SHELL_FOOTER].join('\n')
      expect(detectPaneState(pane), quote).toBe('idle')
      expect(isReadyForPrompt(pane), quote).toBe(true)
    }
  })
})
