import { describe, it, expect } from 'vitest'
import {
  detectsUsageLimit,
  nextFallbackModel,
  decideModelAction,
  normalizeModelFallbackConfig,
  DEFAULT_MODEL_CHAIN,
  DEFAULT_MODEL_FALLBACK,
} from '../model-fallback.js'

const CHAIN = [...DEFAULT_MODEL_CHAIN]
const PRIMARY = CHAIN[0]
const SONNET = CHAIN[1]
const HAIKU = CHAIN[2]

describe('detectsUsageLimit', () => {
  it('matches Claude plan usage-limit banners in the live region', () => {
    expect(detectsUsageLimit('You have reached your usage limit. Try again later.')).toBe(true)
    expect(detectsUsageLimit('5-hour limit reached ∙ resets 3pm')).toBe(true)
    expect(detectsUsageLimit('Approaching usage limit')).toBe(true)
    expect(detectsUsageLimit('Your limit will reset at 18:00')).toBe(true)
    expect(detectsUsageLimit('/upgrade to increase your usage limit')).toBe(true)
    // "session limit" variant observed 2026-08-08 -- was missing from the original regex
    expect(detectsUsageLimit('You hit your session limit · resets 5:50pm')).toBe(true)
    expect(detectsUsageLimit('You hit the session limit')).toBe(true)
  })

  it('matches the weekly and session wordings too', () => {
    // The owner asks about "the weekly or the 5-hour limit", so both have to be
    // caught; these three were measured silent before 2026-08-18.
    expect(detectsUsageLimit("You've reached your weekly limit for Opus.")).toBe(true)
    expect(detectsUsageLimit('Approaching Opus weekly limit ∙ 5% left')).toBe(true)
    expect(detectsUsageLimit('Session limit reached ∙ resets at 2am')).toBe(true)
  })

  it('matches the exhausted-extra-usage reply, in the verbatim wordings measured live', () => {
    // 2798 scheduled turns answered with these between 2026-09-20T02:19Z and
    // 2026-09-21T03:59Z; the detector was silent on every one of them.
    expect(detectsUsageLimit("You're out of extra usage · resets 6am (Europe/Budapest)")).toBe(true)
    expect(detectsUsageLimit("You're out of extra usage · resets Sep 21, 6am (Europe/Budapest)")).toBe(true)
    // As the pane renders it: the API-error glyph, then prompt box + footer below.
    const pane = [
      '> SCHEDULED TASK NOTICE -- the next <scheduled-task source="scheduled-task:morning-digest">',
      "  ⎿  You're out of extra usage · resets 6am (Europe/Budapest)",
      '',
      '────────────────────────────────────────',
      '> ',
      '────────────────────────────────────────',
      '  ? for shortcuts',
    ].join('\n')
    expect(detectsUsageLimit(pane)).toBe(true)
    // Without the reset tail, and with a typographic apostrophe.
    expect(detectsUsageLimit('  ⎿  You’re out of extra usage')).toBe(true)
  })

  it('does NOT match a sentence that merely mentions running out of extra usage', () => {
    expect(detectsUsageLimit('The heartbeat got "You\'re out of extra usage" 2800 times overnight.')).toBe(false)
    expect(detectsUsageLimit("● You're out of extra usage, so the scheduler kept injecting prompts.")).toBe(false)
    expect(detectsUsageLimit('Check whether we are out of extra usage before the next run.')).toBe(false)
    expect(detectsUsageLimit('Extra usage is enabled on this plan.')).toBe(false)
  })

  it('does NOT match a mid-line quote that carries the full banner shape (the line-start anchor)', () => {
    // Without the ^ anchor this line matches: the quoted tail is exactly the
    // banner, "· resets ..." included, and it runs to the end of the line.
    expect(detectsUsageLimit("● The heartbeat's answer was: You're out of extra usage · resets 6am")).toBe(false)
    expect(detectsUsageLimit("  ⎿  Reply: You're out of extra usage")).toBe(false)
  })

  it('does NOT match a transient API 429 / generic rate limit', () => {
    expect(detectsUsageLimit('  ⎿  API Error: 429 rate_limit_error: too many requests')).toBe(false)
    expect(detectsUsageLimit('  ⎿  API Error: 429 overloaded_error: server busy, retrying')).toBe(false)
  })

  it('ignores the phrase when it is only up in scrollback, not the live region', () => {
    const scrollback = ['you reached your usage limit', ...Array(40).fill('normal output line')].join('\n')
    expect(detectsUsageLimit(scrollback)).toBe(false)
  })

  it('returns false for empty / whitespace panes', () => {
    expect(detectsUsageLimit('')).toBe(false)
    expect(detectsUsageLimit('   \n  ')).toBe(false)
  })
})

describe('nextFallbackModel', () => {
  it('walks one step down the chain', () => {
    expect(nextFallbackModel(PRIMARY, CHAIN)).toBe(SONNET)
    expect(nextFallbackModel(SONNET, CHAIN)).toBe(HAIKU)
  })
  it('returns null at the bottom', () => {
    expect(nextFallbackModel(HAIKU, CHAIN)).toBeNull()
  })
  it('treats an unknown current model as the primary', () => {
    expect(nextFallbackModel('some-unknown-model', CHAIN)).toBe(SONNET)
  })
  it('returns null for a degenerate chain', () => {
    expect(nextFallbackModel(PRIMARY, [PRIMARY])).toBeNull()
    expect(nextFallbackModel(PRIMARY, [])).toBeNull()
  })
})

describe('decideModelAction', () => {
  const base = { chain: CHAIN, now: 1_000_000, revertAfterMs: 60_000 }

  it('downgrades when a limit is detected and a lower model exists', () => {
    expect(decideModelAction({ ...base, limitDetected: true, currentModel: PRIMARY, downgradedAt: null }))
      .toEqual({ kind: 'downgrade', model: SONNET })
    expect(decideModelAction({ ...base, limitDetected: true, currentModel: SONNET, downgradedAt: 500_000 }))
      .toEqual({ kind: 'downgrade', model: HAIKU })
  })

  it('does nothing when limited at the bottom of the chain inside the revert window', () => {
    expect(decideModelAction({ ...base, limitDetected: true, currentModel: HAIKU, downgradedAt: 1_000_000 - 59_999 }))
      .toEqual({ kind: 'none' })
    // never downgraded by us (an agent whose intended model is the bottom one)
    expect(decideModelAction({ ...base, limitDetected: true, currentModel: HAIKU, downgradedAt: null }))
      .toEqual({ kind: 'none' })
  })

  // FALLBACKSTUCK924: a stale limit banner re-rendered by --continue kept a
  // downgraded agent pinned at the bottom forever.
  it('reverts past the window even if a (possibly stale) banner is still on screen at the bottom', () => {
    expect(decideModelAction({ ...base, limitDetected: true, currentModel: HAIKU, downgradedAt: 500_000 }))
      .toEqual({ kind: 'revert', model: PRIMARY })
  })

  it('reverts to the primary after the window once limit-free', () => {
    expect(decideModelAction({ ...base, limitDetected: false, currentModel: HAIKU, downgradedAt: 1_000_000 - 60_000 }))
      .toEqual({ kind: 'revert', model: PRIMARY })
  })

  it('does not revert before the window elapses', () => {
    expect(decideModelAction({ ...base, limitDetected: false, currentModel: SONNET, downgradedAt: 1_000_000 - 59_999 }))
      .toEqual({ kind: 'none' })
  })

  it('does nothing when on the primary and limit-free', () => {
    expect(decideModelAction({ ...base, limitDetected: false, currentModel: PRIMARY, downgradedAt: null }))
      .toEqual({ kind: 'none' })
  })

  it('does not re-revert when already back on the primary', () => {
    expect(decideModelAction({ ...base, limitDetected: false, currentModel: PRIMARY, downgradedAt: 0 }))
      .toEqual({ kind: 'none' })
  })
})

describe('normalizeModelFallbackConfig', () => {
  it('defaults on junk input', () => {
    expect(normalizeModelFallbackConfig(null)).toEqual(DEFAULT_MODEL_FALLBACK)
    expect(normalizeModelFallbackConfig('nope')).toEqual(DEFAULT_MODEL_FALLBACK)
    expect(normalizeModelFallbackConfig({})).toEqual(DEFAULT_MODEL_FALLBACK)
  })

  it('honors a valid override', () => {
    const cfg = normalizeModelFallbackConfig({ enabled: true, chain: ['a', 'b', 'c'], revertAfterMinutes: 120 })
    expect(cfg).toEqual({ enabled: true, chain: ['a', 'b', 'c'], revertAfterMinutes: 120 })
  })

  it('rejects a too-short chain and non-string entries', () => {
    expect(normalizeModelFallbackConfig({ chain: ['only-one'] }).chain).toEqual(DEFAULT_MODEL_FALLBACK.chain)
    expect(normalizeModelFallbackConfig({ chain: ['a', 2, '', 'b'] }).chain).toEqual(['a', 'b'])
  })

  it('rejects a non-positive revert window', () => {
    expect(normalizeModelFallbackConfig({ revertAfterMinutes: 0 }).revertAfterMinutes).toBe(DEFAULT_MODEL_FALLBACK.revertAfterMinutes)
    expect(normalizeModelFallbackConfig({ revertAfterMinutes: -5 }).revertAfterMinutes).toBe(DEFAULT_MODEL_FALLBACK.revertAfterMinutes)
  })
})
