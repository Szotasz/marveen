import { describe, it, expect } from 'vitest'
import {
  stripGhostSuggestion,
  stuckInputSignature,
  detectPaneState,
  parkedInputText,
} from '../pane-state.js'

const ESC = '\x1b'
const SEP = '─'.repeat(80)
const FOOTER = `  ⏵⏵ bypass permissions on (shift+tab to cycle) · ↓ to manage`

// A faithful reconstruction of a real `tmux capture-pane -e -p` of a Claude
// Code pane whose input box is EMPTY but shows the editor's dim (SGR 2)
// autocomplete "ghost suggestion". This is the exact shape captured live on
// 2026-06-26 (agent-geri: "Confirm Samu got my last update"). With colour the
// hint is dim; a plain `-p` capture drops the colour and the box reads as a
// genuinely parked `❯ <text>` input -> the stuck-input recovery re-typed +
// Enter-submitted it as a forged message (phantom prompt-injection).
const GHOST_BOX = [
  `${ESC}[38;5;37m${SEP}${ESC}[39m`,
  `${ESC}[39m❯ ${ESC}[2mConfirm Samu got my last update${ESC}[0m`,
  `${ESC}[38;5;37m${SEP}${ESC}[39m`,
  FOOTER,
].join('\n')

// Same layout, but the text after the prompt is REAL typed input rendered at
// normal intensity (no SGR 2). The strip must PRESERVE this -- over-stripping
// would re-break legitimate stuck-input recovery.
const REAL_INPUT_BOX = [
  `${ESC}[38;5;37m${SEP}${ESC}[39m`,
  `${ESC}[39m❯ ${ESC}[38;5;253mFinish the migration before lunch${ESC}[39m`,
  `${ESC}[38;5;37m${SEP}${ESC}[39m`,
  FOOTER,
].join('\n')

describe('stripGhostSuggestion', () => {
  it('drops dim (SGR 2) text and strips all ANSI', () => {
    const out = stripGhostSuggestion(`${ESC}[2mghost${ESC}[0m real`)
    expect(out).toBe(' real') // dim "ghost" removed, ANSI gone, "real" kept
  })

  it('keeps normal-intensity text', () => {
    expect(stripGhostSuggestion(`${ESC}[38;5;253mhello${ESC}[39m`)).toBe('hello')
  })

  it('treats SGR 22 and SGR 0 as dim-reset', () => {
    expect(stripGhostSuggestion(`${ESC}[2mA${ESC}[22mB`)).toBe('B')
    expect(stripGhostSuggestion(`${ESC}[2mA${ESC}[0mB`)).toBe('B')
  })

  it('does NOT mistake a 256-colour INDEX of 2 for the dim attribute', () => {
    // `38;5;2` selects colour index 2 (green); the `2` is a sub-parameter of
    // the extended-colour selector, not the standalone dim code.
    expect(stripGhostSuggestion(`${ESC}[38;5;2mvisible${ESC}[39m`)).toBe('visible')
    // likewise a truecolour green `38;2;0;255;0`
    expect(stripGhostSuggestion(`${ESC}[38;2;0;255;0mvisible${ESC}[39m`)).toBe('visible')
  })

  it('collapses a dim-ghost input box to an empty prompt', () => {
    const stripped = stripGhostSuggestion(GHOST_BOX)
    expect(stripped).not.toContain('Confirm Samu got my last update')
    expect(stripped).toContain('❯ ')
  })
})

describe('ghost suggestion does not trigger stuck-input recovery', () => {
  it('a dim-ghost box is NOT classified as parked input', () => {
    const stripped = stripGhostSuggestion(GHOST_BOX)
    expect(detectPaneState(stripped)).not.toBe('typing')
    expect(stuckInputSignature(stripped)).toBeNull()
    expect(parkedInputText(stripped)).toBeNull()
  })

  it('a REAL non-dim parked input is preserved (no over-strip)', () => {
    const stripped = stripGhostSuggestion(REAL_INPUT_BOX)
    expect(stripped).toContain('Finish the migration before lunch')
    expect(detectPaneState(stripped)).toBe('typing')
    expect(stuckInputSignature(stripped)).toBe('❯ Finish the migration before lunch')
    expect(parkedInputText(stripped)).toBe('Finish the migration before lunch')
  })
})
