/**
 * Integration test: verifies that the key names used in blackboard-stale-sweeper.ts
 * actually exist in the config-registry. Uses the real getEffectiveSettingValue
 * (not mocked) so a key-name mismatch causes this test to throw and fail -- the
 * mock in blackboard-stale-sweeper.test.ts cannot catch that class of bug.
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

// settings-store.js is intentionally NOT mocked here -- the real
// getEffectiveSettingValue calls the real getSettingDefinition, which throws
// for any key not present in the registry.  If a future edit renames a key
// in one place but not the other, this test fails before Boo has to notice.
const { getEffectiveSettingValue } = await import('../settings-store.js')

describe('BB_STALE_* keys exist in config-registry with correct defaults', () => {
  it.each([
    ['BB_STALE_ORCHESTRATOR_MIN', 120],
    ['BB_STALE_INTERACTIVE_MIN',  90],
    ['BB_STALE_SHORT_RUNNING_MIN', 15],
    ['BB_STALE_DEFAULT_MIN',       60],
  ] as const)('%s → default %i', (key, expected) => {
    // Throws "Unknown setting key: …" if the key is absent from the registry.
    const val = getEffectiveSettingValue(key)
    expect(val).toBe(expected)
  })
})
