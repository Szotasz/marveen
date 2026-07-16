import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SETTINGS_REGISTRY, getSettingDefinition, validateSettingValue } from '../config-registry.js'

describe('heartbeat calendar settings', () => {
  it('HEARTBEAT_CALENDAR_ACCOUNT is in the registry under the heartbeat module', () => {
    const def = getSettingDefinition('HEARTBEAT_CALENDAR_ACCOUNT')
    expect(def).toBeDefined()
    expect(def?.module).toBe('heartbeat')
    expect(def?.type).toBe('string')
    expect(def?.secret).toBe(false)
    expect(def?.requiresRestart).toBe(true)
    expect(def?.default).toBe('')
  })

  it('HEARTBEAT_CALENDAR_ID is in the registry under the heartbeat module', () => {
    const def = getSettingDefinition('HEARTBEAT_CALENDAR_ID')
    expect(def).toBeDefined()
    expect(def?.module).toBe('heartbeat')
    expect(def?.type).toBe('string')
    expect(def?.secret).toBe(false)
    expect(def?.requiresRestart).toBe(true)
    expect(def?.default).toBe('')
  })

  it('HEARTBEAT_CALENDAR_ACCOUNT accepts any string value including empty', () => {
    const def = getSettingDefinition('HEARTBEAT_CALENDAR_ACCOUNT')!
    expect(validateSettingValue(def, '').ok).toBe(true)
    expect(validateSettingValue(def, 'user@example.com').ok).toBe(true)
    expect(validateSettingValue(def, 'My Calendar Account').ok).toBe(true)
  })

  it('HEARTBEAT_CALENDAR_ID accepts any string value including empty', () => {
    const def = getSettingDefinition('HEARTBEAT_CALENDAR_ID')!
    expect(validateSettingValue(def, '').ok).toBe(true)
    expect(validateSettingValue(def, 'primary').ok).toBe(true)
    expect(validateSettingValue(def, 'abc123@group.calendar.google.com').ok).toBe(true)
  })

  it('heartbeat module contains all expected keys in correct order', () => {
    const heartbeatKeys = SETTINGS_REGISTRY
      .filter((s) => s.module === 'heartbeat')
      .map((s) => s.key)
    expect(heartbeatKeys).toContain('HEARTBEAT_START_HOUR')
    expect(heartbeatKeys).toContain('HEARTBEAT_END_HOUR')
    expect(heartbeatKeys).toContain('HEARTBEAT_AGENT_ENABLED')
    expect(heartbeatKeys).toContain('HEARTBEAT_CALENDAR_ACCOUNT')
    expect(heartbeatKeys).toContain('HEARTBEAT_CALENDAR_ID')
    // calendar keys appear after the agent enabled key
    const agentIdx = heartbeatKeys.indexOf('HEARTBEAT_AGENT_ENABLED')
    const accountIdx = heartbeatKeys.indexOf('HEARTBEAT_CALENDAR_ACCOUNT')
    const calIdIdx = heartbeatKeys.indexOf('HEARTBEAT_CALENDAR_ID')
    expect(accountIdx).toBeGreaterThan(agentIdx)
    expect(calIdIdx).toBeGreaterThan(accountIdx)
  })

  it('neither calendar key is marked secret (UI must be able to show them)', () => {
    const calKeys = ['HEARTBEAT_CALENDAR_ACCOUNT', 'HEARTBEAT_CALENDAR_ID']
    for (const key of calKeys) {
      expect(getSettingDefinition(key)?.secret, `${key} must not be secret`).toBe(false)
    }
  })
})

// Wiring regression guard: the two calendar keys are consumed as boot-time
// consts, so they MUST resolve through cfg() (config-overrides.json layer) --
// a bare env[] read makes the Settings UI a dead control (the dashboard shows
// the saved value while the heartbeat never sees it).
describe('heartbeat calendar settings wiring (config.ts)', () => {
  it('both keys read through cfg(), not bare env[]', () => {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
    const src = readFileSync(join(repoRoot, 'src', 'config.ts'), 'utf8')
    expect(src).toMatch(/HEARTBEAT_CALENDAR_ACCOUNT\s*=\s*\(cfg\('HEARTBEAT_CALENDAR_ACCOUNT'\)/)
    expect(src).toMatch(/HEARTBEAT_CALENDAR_ID\s*=\s*\(cfg\('HEARTBEAT_CALENDAR_ID'\)/)
    expect(src).not.toMatch(/env\['HEARTBEAT_CALENDAR_ACCOUNT'\]/)
    expect(src).not.toMatch(/env\['HEARTBEAT_CALENDAR_ID'\]/)
  })
})
