import { describe, it, expect } from 'vitest'
import { SETTINGS_REGISTRY, getSettingDefinition, listSettingModules, validateSettingValue } from '../config-registry.js'

describe('config-registry', () => {
  it('registers the kanban WIP keys as non-secret, hot-reloadable, module=kanban', () => {
    // Robust to later registry growth (system/heartbeat/ideabox modules etc.):
    // assert the kanban WIP subset's invariants, not the registry's exact size.
    const kanban = SETTINGS_REGISTRY.filter((s) => s.module === 'kanban')
    // the original v1 kanban WIP keys must all still be present
    expect(kanban.length).toBeGreaterThanOrEqual(9)
    // kanban WIP settings are user-tunable: never secret, hot-reloadable (no restart)
    expect(kanban.every((s) => s.secret === false)).toBe(true)
    expect(kanban.every((s) => s.requiresRestart === false)).toBe(true)
    // registry-wide invariant: the Settings UI must never surface a secret key
    expect(SETTINGS_REGISTRY.every((s) => s.secret === false)).toBe(true)
    expect(getSettingDefinition('KANBAN_WIP_PLANNED')?.module).toBe('kanban')
  })

  it('getSettingDefinition finds a known key and returns undefined for unknown', () => {
    expect(getSettingDefinition('KANBAN_WIP_PLANNED')?.type).toBe('int')
    expect(getSettingDefinition('NOT_A_REAL_KEY')).toBeUndefined()
  })

  it('listSettingModules returns the distinct modules present in the registry', () => {
    // Robust: derive the expected module set from the registry rather than
    // pinning a hard-coded list, so it survives new modules being added.
    const mods = listSettingModules()
    expect(new Set(mods).size).toBe(mods.length) // distinct, no duplicates
    expect(new Set(mods)).toEqual(new Set(SETTINGS_REGISTRY.map((s) => s.module)))
    expect(mods).toContain('kanban')
  })

  describe('validateSettingValue', () => {
    it('accepts a valid int within bounds', () => {
      const def = getSettingDefinition('KANBAN_WIP_PLANNED')!
      const result = validateSettingValue(def, '5')
      expect(result).toEqual({ ok: true, value: 5 })
    })

    it('rejects a non-integer', () => {
      const def = getSettingDefinition('KANBAN_WIP_PLANNED')!
      expect(validateSettingValue(def, 'abc').ok).toBe(false)
    })

    it('rejects below min', () => {
      const def = getSettingDefinition('KANBAN_WIP_PLANNED')!
      expect(validateSettingValue(def, -1).ok).toBe(false)
    })

    it('rejects 0 for WARN_PCT (min 1, meaningless at 0)', () => {
      const def = getSettingDefinition('KANBAN_WIP_WARN_PCT')!
      expect(validateSettingValue(def, 0).ok).toBe(false)
    })

    it('rejects WARN_PCT above 100', () => {
      const def = getSettingDefinition('KANBAN_WIP_WARN_PCT')!
      expect(validateSettingValue(def, 101).ok).toBe(false)
    })

    describe('opt-in table retention (0 = keep forever)', () => {
      const keys = [
        ['CONVERSATION_LOG_RETENTION_DAYS', 90],
        ['OTEL_SPAN_RETENTION_DAYS', 14],
        ['AGENT_MESSAGE_RETENTION_DAYS', 30],
        ['TOOL_CALL_LOG_RETENTION_DAYS', 30],
      ] as const

      it.each(keys)('%s defaults to 0, accepts 0 and its suggested window, rejects negatives', (key, suggested) => {
        const def = getSettingDefinition(key)!
        expect(def.default).toBe(0)
        expect(validateSettingValue(def, 0)).toEqual({ ok: true, value: 0 })
        expect(validateSettingValue(def, '0')).toEqual({ ok: true, value: 0 })
        expect(validateSettingValue(def, suggested)).toEqual({ ok: true, value: suggested })
        expect(validateSettingValue(def, -1).ok).toBe(false)
        // The dashboard shows this text; it has to explain the 0 and name the window.
        expect(def.description).toContain('0 = örökre megőrzi')
        expect(def.description).toContain(`${suggested} nap`)
      })
    })

    it('accepts a valid hex color', () => {
      const def = getSettingDefinition('KANBAN_WIP_OK_COLOR')!
      expect(validateSettingValue(def, '#123abc')).toEqual({ ok: true, value: '#123abc' })
    })

    it('rejects a malformed color', () => {
      const def = getSettingDefinition('KANBAN_WIP_OK_COLOR')!
      expect(validateSettingValue(def, 'red').ok).toBe(false)
      expect(validateSettingValue(def, '#fff').ok).toBe(false)
    })

    it('enforces an explicit valueSet over type-based validation', () => {
      const def = { key: 'X', type: 'string' as const, default: 'a', description: '', module: 'm', secret: false, requiresRestart: false, valueSet: ['a', 'b'] }
      expect(validateSettingValue(def, 'a').ok).toBe(true)
      expect(validateSettingValue(def, 'c').ok).toBe(false)
    })
  })
})
