/**
 * Integration test: verifies that every key name in the sweeper's TIER_CONFIG_KEY
 * map actually exists in the config-registry with the expected default value.
 *
 * The key source is the sweeper itself (imported TIER_CONFIG_KEY), NOT a hand-written
 * list in this file. If a future edit renames a key in one place but not the other,
 * getEffectiveSettingValue throws "Unknown setting key: …" and this test fails.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))
vi.mock('../config.js', () => ({
  STORE_DIR: '/tmp/bb-keycheck-' + process.pid,
  OLLAMA_URL: 'http://localhost:11434',
  APP_TZ: 'Europe/Budapest',
  MAIN_AGENT_ID: 'agent-a',
  ALLOWED_CHAT_ID: '123456',
}))

// settings-store is intentionally NOT mocked: the real getEffectiveSettingValue
// calls the real getSettingDefinition and throws for any unknown key.
const { getEffectiveSettingValue } = await import('../settings-store.js')
const { TIER_CONFIG_KEY } = await import('../web/blackboard-stale-sweeper.js')

const EXPECTED_DEFAULTS: Record<string, number> = {
  BB_STALE_ORCHESTRATOR_MIN: 120,
  BB_STALE_INTERACTIVE_MIN:   90,
  BB_STALE_SHORT_RUNNING_MIN: 15,
  BB_STALE_DEFAULT_MIN:       60,
}

describe('TIER_CONFIG_KEY values exist in config-registry with correct defaults', () => {
  for (const [tier, key] of Object.entries(TIER_CONFIG_KEY)) {
    it(`tier "${tier}" → key "${key}" resolves without error`, () => {
      // Throws "Unknown setting key: …" if the key is absent from the registry.
      expect(() => getEffectiveSettingValue(key)).not.toThrow()
    })

    it(`tier "${tier}" → key "${key}" has expected default`, () => {
      const val = getEffectiveSettingValue(key)
      expect(val).toBe(EXPECTED_DEFAULTS[key])
    })
  }
})
