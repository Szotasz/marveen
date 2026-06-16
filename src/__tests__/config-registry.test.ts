import { describe, it, expect } from 'vitest'
import { SETTINGS_REGISTRY, getSettingDefinition, listSettingModules, validateSettingValue } from '../config-registry.js'

describe('config-registry', () => {
  it('exposes exactly the 9 kanban WIP keys in v1', () => {
    expect(SETTINGS_REGISTRY).toHaveLength(9)
    expect(SETTINGS_REGISTRY.every((s) => s.module === 'kanban')).toBe(true)
    expect(SETTINGS_REGISTRY.every((s) => s.secret === false)).toBe(true)
    expect(SETTINGS_REGISTRY.every((s) => s.requiresRestart === false)).toBe(true)
  })

  it('getSettingDefinition finds a known key and returns undefined for unknown', () => {
    expect(getSettingDefinition('KANBAN_WIP_PLANNED')?.type).toBe('int')
    expect(getSettingDefinition('NOT_A_REAL_KEY')).toBeUndefined()
  })

  it('listSettingModules returns the distinct module list', () => {
    expect(listSettingModules()).toEqual(['kanban'])
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
