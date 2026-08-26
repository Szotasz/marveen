import { describe, it, expect } from 'vitest'
import {
  detectsUsageLimit,
  detectsModelUnavailable,
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

  it('does nothing when limited at the bottom of the chain', () => {
    expect(decideModelAction({ ...base, limitDetected: true, currentModel: HAIKU, downgradedAt: 500_000 }))
      .toEqual({ kind: 'none' })
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

describe('detectsModelUnavailable', () => {
  it('matches the "model unavailable" banner phrases', () => {
    expect(detectsModelUnavailable("There's an issue with the selected model")).toBe(true)
    expect(detectsModelUnavailable("There’s an issue with the selected model")).toBe(true)
    expect(detectsModelUnavailable('Run /model to pick a different model')).toBe(true)
  })

  it('matches only in the live region (bottom 15 lines)', () => {
    const banner = "There's an issue with the selected model"
    const scrollback = [banner, ...Array(40).fill('normal output')].join('\n')
    expect(detectsModelUnavailable(scrollback)).toBe(false)
    const live = [...Array(40).fill('normal output'), banner].join('\n')
    expect(detectsModelUnavailable(live)).toBe(true)
  })

  it('returns false for empty / whitespace panes', () => {
    expect(detectsModelUnavailable('')).toBe(false)
    expect(detectsModelUnavailable('   \n  ')).toBe(false)
  })

  it('does NOT match usage-limit or generic API errors', () => {
    expect(detectsModelUnavailable('You hit your session limit · resets 5:50pm')).toBe(false)
    expect(detectsModelUnavailable('API Error: 429 rate_limit_error')).toBe(false)
  })
})

describe('DEFAULT_MODEL_CHAIN sanity', () => {
  const RETIRED_MODELS = ['claude-opus-4-8[1m]', 'claude-opus-4.8', 'claude-opus-4-8']

  it('chain contains no known-retired model IDs', () => {
    for (const model of DEFAULT_MODEL_CHAIN) {
      expect(RETIRED_MODELS).not.toContain(model)
    }
  })

  it('chain[0] (primary / revert target) is not a retired model', () => {
    expect(RETIRED_MODELS).not.toContain(DEFAULT_MODEL_CHAIN[0])
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
