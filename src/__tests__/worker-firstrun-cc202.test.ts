import { describe, it, expect } from 'vitest'
import { idleConsideringDimGhost, paneLooksIdle, detectPaneState } from '../pane-state.js'
import { stampWorkerFirstRun } from '../web/agent-worker.js'

// Regression tests for the CC >=2.1.202 first-run breakage that made
// dashboard agent creation fail with "worker session not ready":
//  1. the "Try the new fullscreen renderer?" upsell parks the worker before
//     its first idle prompt -> stampWorkerFirstRun pre-accepts it;
//  2. the new dim empty-input placeholder reads as parked text in a plain
//     capture -> idleConsideringDimGhost consults the dim-stripped view.

const SEP = '─'.repeat(80)

// Plain (`capture-pane -p`) view of an EMPTY box showing the new dim
// placeholder: escape codes are not part of -p output, so the hint reads as
// literal parked text.
const PLAIN_WITH_PLACEHOLDER = [
  '',
  SEP,
  '❯ Try refactor src/utils.ts to use the new API',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

// The SAME pane read through captureParkedInputView (-e capture with dim spans
// stripped): the placeholder was SGR-2 faint, so the box reads empty -> idle.
const DIM_STRIPPED_EMPTY = [
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

// REAL typed input: normal intensity, so it survives the dim strip too.
const DIM_STRIPPED_REAL_TEXT = [
  '',
  SEP,
  '❯ deploy the thing please',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

// A genuinely busy pane (spinner + esc-to-interrupt footer).
const BUSY = [
  '✻ Baking… (12s · 1.2k tokens · esc to interrupt)',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

describe('idleConsideringDimGhost', () => {
  it('fixture sanity: the placeholder pane classifies as typing on the plain view', () => {
    expect(detectPaneState(PLAIN_WITH_PLACEHOLDER)).toBe('typing')
    expect(paneLooksIdle(DIM_STRIPPED_EMPTY)).toBe(true)
  })

  it('treats a dim-placeholder-only box as idle (the CC 2.1.202 readiness fix)', () => {
    expect(idleConsideringDimGhost(PLAIN_WITH_PLACEHOLDER, DIM_STRIPPED_EMPTY)).toBe(true)
  })

  it('still refuses when REAL typed text is parked (survives the dim strip)', () => {
    expect(idleConsideringDimGhost(PLAIN_WITH_PLACEHOLDER, DIM_STRIPPED_REAL_TEXT)).toBe(false)
  })

  it('refuses a busy pane without even consulting the dim view', () => {
    expect(idleConsideringDimGhost(BUSY, DIM_STRIPPED_EMPTY)).toBe(false)
  })

  it('fails safe when the dim-stripped capture is unavailable', () => {
    expect(idleConsideringDimGhost(PLAIN_WITH_PLACEHOLDER, null)).toBe(false)
  })

  it('a plainly idle pane is idle regardless of the dim view', () => {
    expect(idleConsideringDimGhost(DIM_STRIPPED_EMPTY, null)).toBe(true)
  })
})

describe('stampWorkerFirstRun', () => {
  it('stamps onboarding and the fullscreen upsell counter on a fresh config', () => {
    const parsed: Record<string, unknown> = {}
    stampWorkerFirstRun(parsed)
    expect(parsed.hasCompletedOnboarding).toBe(true)
    expect(parsed.fullscreenUpsellSeenCount).toBe(99)
  })

  it('never lowers an already-higher seen count', () => {
    const parsed: Record<string, unknown> = { fullscreenUpsellSeenCount: 250 }
    stampWorkerFirstRun(parsed)
    expect(parsed.fullscreenUpsellSeenCount).toBe(250)
  })

  it('repairs a non-numeric counter and preserves unrelated keys', () => {
    const parsed: Record<string, unknown> = { fullscreenUpsellSeenCount: 'nope', projects: { '/x': { hasTrustDialogAccepted: true } } }
    stampWorkerFirstRun(parsed)
    expect(parsed.fullscreenUpsellSeenCount).toBe(99)
    expect(parsed.projects).toEqual({ '/x': { hasTrustDialogAccepted: true } })
  })

  it('is idempotent', () => {
    const parsed: Record<string, unknown> = {}
    stampWorkerFirstRun(parsed)
    stampWorkerFirstRun(parsed)
    expect(parsed.fullscreenUpsellSeenCount).toBe(99)
    expect(parsed.hasCompletedOnboarding).toBe(true)
  })
})
