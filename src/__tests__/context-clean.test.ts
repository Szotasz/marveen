import { describe, it, expect } from 'vitest'
import {
  decideContextClean,
  normalizeContextCleanConfig,
  normalizeSignal,
  isLargeContextModel,
  defaultContextCleanForModel,
  DEFAULT_CONTEXT_CLEAN,
  DEFAULT_CONTEXT_CLEAN_LARGE,
  DEFAULT_CONTEXT_CLEAN_STANDARD,
  INITIAL_STATE,
  NO_SIGNAL,
  type ContextCleanConfig,
  type ContextCleanState,
} from '../context-clean.js'

const CFG: ContextCleanConfig = {
  enabled: true,
  softThreshold: 400_000,
  hardThreshold: 500_000,
  graceMinutes: 15,
}
const IDLE: ContextCleanState = { phase: 'idle', warnedAtMs: null }
const warned = (warnedAtMs: number): ContextCleanState => ({ phase: 'warned', warnedAtMs })

describe('normalizeContextCleanConfig', () => {
  it('fills defaults for an empty object', () => {
    expect(normalizeContextCleanConfig({})).toEqual(DEFAULT_CONTEXT_CLEAN)
  })

  it('defaults enabled to true when the field is absent', () => {
    expect(normalizeContextCleanConfig({ softThreshold: 300_000 }).enabled).toBe(true)
  })

  it('respects an explicit enabled:false', () => {
    expect(normalizeContextCleanConfig({ enabled: false }).enabled).toBe(false)
  })

  it('repairs hard < soft by lifting hard to soft', () => {
    const c = normalizeContextCleanConfig({ softThreshold: 400_000, hardThreshold: 100_000 })
    expect(c.hardThreshold).toBe(400_000)
  })

  it('rejects non-positive / non-finite numbers back to defaults', () => {
    const c = normalizeContextCleanConfig({ softThreshold: -5, hardThreshold: 'x', graceMinutes: 0 })
    expect(c.softThreshold).toBe(DEFAULT_CONTEXT_CLEAN.softThreshold)
    expect(c.hardThreshold).toBe(DEFAULT_CONTEXT_CLEAN.hardThreshold)
    expect(c.graceMinutes).toBe(DEFAULT_CONTEXT_CLEAN.graceMinutes)
  })
})

describe('model-aware defaults', () => {
  it('detects a [1m] model as large-context', () => {
    expect(isLargeContextModel('claude-opus-4-8[1m]')).toBe(true)
    expect(isLargeContextModel('claude-sonnet-5[1m]')).toBe(true)
  })

  it('treats a plain Sonnet id (no [1m]) as standard-window', () => {
    expect(isLargeContextModel('claude-sonnet-5')).toBe(false)
    expect(isLargeContextModel(null)).toBe(false)
    expect(isLargeContextModel(undefined)).toBe(false)
  })

  it('picks the large profile (400k/500k) for a [1m] model', () => {
    expect(defaultContextCleanForModel('claude-opus-4-8[1m]')).toEqual(DEFAULT_CONTEXT_CLEAN_LARGE)
    expect(DEFAULT_CONTEXT_CLEAN_LARGE.softThreshold).toBe(400_000)
    expect(DEFAULT_CONTEXT_CLEAN_LARGE.hardThreshold).toBe(500_000)
  })

  it('picks the proportionally-lower profile (120k/160k) for a standard model', () => {
    expect(defaultContextCleanForModel('claude-sonnet-5')).toEqual(DEFAULT_CONTEXT_CLEAN_STANDARD)
    expect(DEFAULT_CONTEXT_CLEAN_STANDARD.softThreshold).toBe(120_000)
    expect(DEFAULT_CONTEXT_CLEAN_STANDARD.hardThreshold).toBe(160_000)
  })

  it('standard soft/hard sit below the large soft, so the clean pre-empts native compaction', () => {
    expect(DEFAULT_CONTEXT_CLEAN_STANDARD.hardThreshold).toBeLessThan(DEFAULT_CONTEXT_CLEAN_LARGE.softThreshold)
  })

  it('normalize honours a supplied base for missing fields', () => {
    // A standard-model agent with only enabled set inherits the standard thresholds.
    const c = normalizeContextCleanConfig({ enabled: true }, DEFAULT_CONTEXT_CLEAN_STANDARD)
    expect(c.softThreshold).toBe(120_000)
    expect(c.hardThreshold).toBe(160_000)
  })
})

describe('normalizeSignal', () => {
  it('treats a missing/garbage payload as no signal', () => {
    expect(normalizeSignal(null)).toEqual(NO_SIGNAL)
    expect(normalizeSignal('nope')).toEqual(NO_SIGNAL)
    expect(normalizeSignal({})).toEqual(NO_SIGNAL)
  })

  it('reads explicit booleans', () => {
    expect(normalizeSignal({ hold: true, ready: false })).toEqual({ hold: true, ready: false })
    expect(normalizeSignal({ hold: false, ready: true })).toEqual({ hold: false, ready: true })
  })
})

describe('decideContextClean', () => {
  const now = 1_000_000_000

  it('does nothing while disabled', () => {
    expect(decideContextClean({ ...CFG, enabled: false }, IDLE, 999_999, NO_SIGNAL, now)).toBe('none')
  })

  it('does nothing when context tokens are unknown', () => {
    expect(decideContextClean(CFG, IDLE, null, NO_SIGNAL, now)).toBe('none')
  })

  it('stays idle below the soft threshold', () => {
    expect(decideContextClean(CFG, IDLE, 399_999, NO_SIGNAL, now)).toBe('none')
  })

  it('warns on crossing the soft threshold', () => {
    expect(decideContextClean(CFG, IDLE, 400_000, NO_SIGNAL, now)).toBe('warn')
  })

  it('waits after warning while the agent has not signalled', () => {
    expect(decideContextClean(CFG, warned(now), 420_000, NO_SIGNAL, now + 60_000)).toBe('wait')
  })

  it('restarts immediately on an explicit ready signal', () => {
    expect(decideContextClean(CFG, warned(now), 420_000, { hold: false, ready: true }, now + 1000)).toBe('restart')
  })

  it('does NOT restart just because the agent looks ready-via-idle (no signal)', () => {
    // The pure function has no notion of pane-idle; readiness must be explicit.
    expect(decideContextClean(CFG, warned(now), 420_000, NO_SIGNAL, now + 1000)).toBe('wait')
  })

  it('forces a restart once the grace window elapses, even without a signal', () => {
    const graceMs = CFG.graceMinutes * 60_000
    expect(decideContextClean(CFG, warned(now), 420_000, NO_SIGNAL, now + graceMs)).toBe('restart')
  })

  it('honours an active hold within the grace window', () => {
    expect(decideContextClean(CFG, warned(now), 420_000, { hold: true, ready: false }, now + 60_000)).toBe('wait')
  })

  it('overrides an active hold once the grace window elapses', () => {
    const graceMs = CFG.graceMinutes * 60_000
    expect(decideContextClean(CFG, warned(now), 420_000, { hold: true, ready: false }, now + graceMs)).toBe('restart')
  })

  it('forces on hard threshold when there is no active hold', () => {
    expect(decideContextClean(CFG, warned(now), 500_000, NO_SIGNAL, now + 60_000)).toBe('restart')
  })

  it('defers the hard-threshold force while a hold is active (until grace)', () => {
    expect(decideContextClean(CFG, warned(now), 500_000, { hold: true, ready: false }, now + 60_000)).toBe('wait')
  })

  it('resets the flow if context falls back below soft after warning', () => {
    expect(decideContextClean(CFG, warned(now), 399_999, NO_SIGNAL, now + 60_000)).toBe('reset')
  })

  it('a ready signal wins even at/above the hard threshold', () => {
    expect(decideContextClean(CFG, warned(now), 600_000, { hold: false, ready: true }, now + 1000)).toBe('restart')
  })
})

describe('INITIAL_STATE', () => {
  it('is idle with no warn timestamp', () => {
    expect(INITIAL_STATE).toEqual({ phase: 'idle', warnedAtMs: null })
  })
})
