import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  stripGhostSuggestion,
  stuckInputSignature,
  detectPaneState,
  parkedInputText,
  paneLooksIdle,
  paneShowsContextSaturation,
} from '../pane-state.js'

const ESC = '\x1b'
const NBSP = ' ' // the gap Claude Code renders after the ❯ prompt glyph
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

// A FRESH Claude Code >= v2.1.201 session: the empty input box shows a dim
// (SGR 2) EXAMPLE-SUGGESTION placeholder `Try "..."`, and the gap after the ❯
// glyph is a NON-BREAKING SPACE (U+00A0) -- exactly like a genuinely parked
// message. Captured live 2026-07-07 from marveen-worker (footer `bypass
// permissions on`, ghost preceded by SGR `39;2`, footer by `38;5;211`). On a
// plain `-p` capture the dim is gone, so this reads as parked input ('typing')
// and a fresh session whose only prompts arrive through the readiness gate can
// never receive its first prompt. Only the ghost-stripped view reads it idle.
const V2_1_201_FRESH_GHOST_BOX = [
  `${ESC}[38;5;37m${SEP}${ESC}[39m`,
  `${ESC}[39m❯${NBSP}${ESC}[2mTry "how do I log an error?"${ESC}[0m`,
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

// Regression: Claude Code >= v2.1.201 renders a dim example-suggestion in a
// fresh session's empty input box, which a plain `-p` capture cannot tell from
// parked text. isSessionReadyForPrompt must read the GHOST-STRIPPED view so a
// fresh worker/agent is not judged "not ready" forever (chicken-and-egg).
describe('v2.1.201 fresh-session readiness (ghost example-suggestion)', () => {
  it('a fresh dim example-suggestion box reads IDLE once the ghost is stripped', () => {
    const stripped = stripGhostSuggestion(V2_1_201_FRESH_GHOST_BOX)
    expect(stripped).not.toContain('Try "how do I log an error?"')
    expect(detectPaneState(stripped)).toBe('idle') // NOT 'typing'
    expect(paneLooksIdle(stripped)).toBe(true)
    expect(parkedInputText(stripped)).toBeNull()
  })

  it('documents the bug: the SAME box on a plain (dim-lost) capture mis-reads as typing', () => {
    // A plain `-p` capture = colour already gone, so the dim ghost survives as
    // apparent parked text -- this is precisely why the readiness gate must use
    // the ghost-stripped view instead.
    const plain = [SEP, `❯${NBSP}Try "how do I log an error?"`, SEP, FOOTER].join('\n')
    expect(detectPaneState(plain)).toBe('typing')
    expect(paneLooksIdle(plain)).toBe(false)
  })

  it('a REAL parked message with an NBSP gap still reads typing after strip (security)', () => {
    // The NBSP gap alone must NOT be treated as "ghost" -- only the DIM
    // intensity distinguishes a ghost from a real parked message. A normal-
    // intensity parked line survives the strip and stays 'typing'.
    const realNbspParked = [
      `${ESC}[38;5;37m${SEP}${ESC}[39m`,
      `${ESC}[39m❯${NBSP}${ESC}[38;5;253mstorno the last invoice${ESC}[39m`,
      `${ESC}[38;5;37m${SEP}${ESC}[39m`,
      FOOTER,
    ].join('\n')
    const stripped = stripGhostSuggestion(realNbspParked)
    expect(stripped).toContain('storno the last invoice')
    expect(detectPaneState(stripped)).toBe('typing')
    expect(paneLooksIdle(stripped)).toBe(false)
  })

  it('a DIM saturation banner is LOST by the strip but caught on the plain capture', () => {
    // Rationale for the two-capture split: context-saturation must be scanned on
    // the PLAIN capture, never the ghost-stripped view. If a Claude Code build
    // renders the "100% context used" banner dim (SGR 2), stripGhostSuggestion
    // deletes it -- so a readiness check that scanned saturation on the stripped
    // view would silently no-op and dispatch into a saturated pane.
    const coloredSaturated = [
      `${ESC}[38;5;37m${SEP}${ESC}[39m`,
      `${ESC}[39m❯ ${ESC}[0m`,
      `${ESC}[38;5;37m${SEP}${ESC}[39m`,
      `  ${ESC}[2m100% context used${ESC}[0m`,
      FOOTER,
    ].join('\n')
    const plain = coloredSaturated.replace(/\x1b\[[0-9;]*m/g, '') // `capture-pane -p`: colour dropped, TEXT kept
    expect(paneShowsContextSaturation(plain)).toBe(true) // plain scan refuses it
    expect(paneShowsContextSaturation(stripGhostSuggestion(coloredSaturated))).toBe(false) // stripped view LOSES it
  })
})

// Wiring guard: the readiness gate must resolve typing-vs-idle through the
// dim-ghost-tolerant idleOrGhost path (which only scrapes the ghost-STRIPPED
// captureParkedInputView when the plain view looks like typing) -- otherwise the
// v2.1.202 fresh-session dim ghost re-breaks first-prompt delivery.
describe('isSessionReadyForPrompt wiring (dim-ghost tolerant idle)', () => {
  it('resolves idle through idleOrGhost/captureParkedInputView and saturation on the plain capture', () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../web/agent-process.ts'),
      'utf-8',
    )
    const start = src.indexOf('export async function isSessionReadyForPrompt')
    expect(start).toBeGreaterThan(-1)
    const fn = src.slice(start, start + 2600)
    // typing-vs-idle-box is decided through the dim-ghost-tolerant path, which
    // scrapes the GHOST-STRIPPED captureParkedInputView (so the dim
    // example-suggestion never reads as parked):
    expect(fn).toContain('captureParkedInputView(session, host)')
    expect(fn).toMatch(/idleOrGhost\((?:first|second)\)/)
    // context-saturation is scanned on the PLAIN capture (a dim banner cannot be
    // masked -> the refusal stays robust):
    expect(fn).toContain('capturePane(session, host)')
    expect(fn).toMatch(/paneShowsContextSaturation\((?:first|second)\)/)
  })
})
