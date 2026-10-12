import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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

  // Opt-in operator switches consumed as boot-time consts in src/config.ts.
  // Default must stay '0' (config.ts resolves an unset key to false), and the
  // UI must flag the restart, since the value is read once at module load.
  it.each(['SUBAGENT_INBOX_TEE', 'SUBAGENT_TELEGRAM_WAKE_ENABLED', 'VOICE_TRANSCRIBE_INBOUND'])(
    'registers %s as an off-by-default boolean that requires a restart',
    (key) => {
      const def = getSettingDefinition(key)
      expect(def).toBeDefined()
      expect(def!.type).toBe('boolean')
      expect(def!.default).toBe('0')
      expect(def!.module).toBe('channels')
      expect(def!.secret).toBe(false)
      expect(def!.requiresRestart).toBe(true)
      expect(def!.description.length).toBeGreaterThan(0)
      // the boolean validator persists canonical '1'/'0'
      expect(validateSettingValue(def!, true)).toEqual({ ok: true, value: '1' })
      expect(validateSettingValue(def!, 'false')).toEqual({ ok: true, value: '0' })
    },
  )

  // The canonical '1' the Settings page writes must be a value the consumer
  // accepts. Pin the parser in src/config.ts: if it ever stops accepting '1',
  // a switch saved as on would silently stay off.
  it.each(['SUBAGENT_INBOX_TEE', 'SUBAGENT_TELEGRAM_WAKE_ENABLED', 'VOICE_TRANSCRIBE_INBOUND'])(
    'src/config.ts parses %s so that the saved "1" means on',
    (key) => {
      const code = readFileSync(join(process.cwd(), 'src', 'config.ts'), 'utf-8')
      const parse = new RegExp(
        String.raw`export const ${key} =\s*\['1', 'true', 'yes', 'on'\]\.includes\(\(cfg\('${key}'\) \?\? ''\)\.trim\(\)\.toLowerCase\(\)\)`,
      )
      expect(code).toMatch(parse)
    },
  )

  it('registers each key at most once', () => {
    const keys = SETTINGS_REGISTRY.map((s) => s.key)
    expect(new Set(keys).size).toBe(keys.length)
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
