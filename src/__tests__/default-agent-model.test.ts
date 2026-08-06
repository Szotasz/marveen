import { describe, it, expect } from 'vitest'
import {
  SETTINGS_REGISTRY,
  getSettingDefinition,
  validateSettingValue,
  DISTRIBUTION_DEFAULT_AGENT_MODEL,
} from '../config-registry.js'
import { DEFAULT_AGENT_MODEL } from '../config.js'
import { DEFAULT_MODEL, MODEL_ALIASES, resolveModelId } from '../web/agent-config.js'
import { defaultChainForInstall } from '../web/model-fallback-store.js'
import { DEFAULT_MODEL_CHAIN } from '../model-fallback.js'

// Every assertion here is RELATIONAL, never "the default is <some model id>":
// these tests run both on a fresh checkout (no .env -> distribution default)
// and on a configured install (DEFAULT_AGENT_MODEL set -> that model), and must
// pass in both.
describe('DEFAULT_AGENT_MODEL', () => {
  it('is registered as a restart-scoped, non-secret agents setting', () => {
    const def = getSettingDefinition('DEFAULT_AGENT_MODEL')
    expect(def).toBeDefined()
    expect(def!.type).toBe('string')
    expect(def!.module).toBe('agents')
    expect(def!.secret).toBe(false)
    // Consumed at import time by config.ts, so a change cannot hot-reload.
    expect(def!.requiresRestart).toBe(true)
    expect(SETTINGS_REGISTRY.filter((s) => s.key === 'DEFAULT_AGENT_MODEL')).toHaveLength(1)
  })

  it('keeps the registry default and the boot constant on one literal', () => {
    // The whole point of DISTRIBUTION_DEFAULT_AGENT_MODEL living in the
    // zero-import registry module: these two can never drift.
    expect(getSettingDefinition('DEFAULT_AGENT_MODEL')!.default).toBe(DISTRIBUTION_DEFAULT_AGENT_MODEL)
  })

  it('offers the distribution default among the selectable values', () => {
    const def = getSettingDefinition('DEFAULT_AGENT_MODEL')!
    expect(def.valueSet).toBeDefined()
    expect(def.valueSet).toContain(DISTRIBUTION_DEFAULT_AGENT_MODEL)
    expect(def.valueSet).toContain('claude-opus-5')
    // The worker drives the `claude` CLI, so only Claude ids are admissible.
    expect(def.valueSet!.every((m) => m.startsWith('claude-'))).toBe(true)
  })

  it('validates against the value set', () => {
    const def = getSettingDefinition('DEFAULT_AGENT_MODEL')!
    expect(validateSettingValue(def, 'claude-opus-5')).toEqual({ ok: true, value: 'claude-opus-5' })
    expect(validateSettingValue(def, 'gpt-4').ok).toBe(false)
  })

  it('resolves to the configured value, defaulting to the distribution literal', () => {
    const def = getSettingDefinition('DEFAULT_AGENT_MODEL')!
    // Either an operator set it (then it must be a selectable id), or it fell
    // through to the distribution default.
    expect(def.valueSet).toContain(DEFAULT_AGENT_MODEL)
  })
})

describe('agent-config default wiring', () => {
  it('re-exports the install default under the historical DEFAULT_MODEL name', () => {
    expect(DEFAULT_MODEL).toBe(DEFAULT_AGENT_MODEL)
  })

  it("resolves the 'inherit' alias to the install default", () => {
    expect(resolveModelId('inherit')).toBe(DEFAULT_AGENT_MODEL)
  })

  it("resolves the bare 'opus' alias to Opus 5 (MODELMIGRATE806)", () => {
    // Szabi's "everything on Opus 5" applies here too. Measured before the
    // change: ZERO live callers use the bare 'opus' alias -- all 10 fleet
    // agent-configs carry a full model id, and the UI picks from the valueSet
    // (full ids), never an alias. So the change is zero-risk, and a dead alias
    // still pointing at the OLD model is exactly the silent trap we spent a day
    // on: whoever writes 'opus' gets 4.8 with nothing warning them.
    expect(MODEL_ALIASES['opus']).toBe('claude-opus-5[1m]')
    expect(resolveModelId('opus')).toBe('claude-opus-5[1m]')
  })
})

describe('defaultChainForInstall', () => {
  it('puts the install default first so a revert lands on the model actually run', () => {
    expect(defaultChainForInstall()[0]).toBe(DEFAULT_AGENT_MODEL)
  })

  it('never repeats a model, even when the default is already on the ladder', () => {
    const chain = defaultChainForInstall()
    expect(new Set(chain).size).toBe(chain.length)
  })

  it('keeps a usable ladder: primary plus at least one downgrade target', () => {
    const chain = defaultChainForInstall()
    // normalizeModelFallbackConfig() ignores any chain shorter than 2.
    expect(chain.length).toBeGreaterThanOrEqual(2)
    // Every distribution rung except the promoted primary survives, in order.
    expect(chain.slice(1)).toEqual(DEFAULT_MODEL_CHAIN.filter((m) => m !== DEFAULT_AGENT_MODEL))
  })
})
