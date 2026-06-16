import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import {
  OVERRIDES_PATH,
  getEffectiveSettingValue,
  setOverride,
  getOverrides,
  reloadOverridesForTest,
} from '../settings-store.js'

// This worktree's PROJECT_ROOT resolves under /tmp/marveen-dashboard-settings
// (see config.ts: PROJECT_ROOT = join(__dirname, '..')), so OVERRIDES_PATH
// here is isolated from any real fleet install -- safe to write/delete.
describe('settings-store', () => {
  beforeEach(() => {
    if (existsSync(OVERRIDES_PATH)) rmSync(OVERRIDES_PATH)
    reloadOverridesForTest()
  })

  afterAll(() => {
    if (existsSync(OVERRIDES_PATH)) rmSync(OVERRIDES_PATH)
    reloadOverridesForTest()
  })

  it('falls back to the registry default when no override and no .env value exist', () => {
    expect(getEffectiveSettingValue('KANBAN_WIP_WARN_PCT')).toBe(80)
    expect(getEffectiveSettingValue('KANBAN_WIP_OK_COLOR')).toBe('#6b7280')
  })

  it('throws for a key not in the registry', () => {
    expect(() => getEffectiveSettingValue('NOT_A_REAL_KEY')).toThrow()
  })

  it('persists a valid override and resolves it ahead of the default', () => {
    const result = setOverride('KANBAN_WIP_WARN_PCT', 42)
    expect(result.ok).toBe(true)
    expect(getEffectiveSettingValue('KANBAN_WIP_WARN_PCT')).toBe(42)
  })

  it('writes the overrides file atomically (content matches what was set)', () => {
    setOverride('KANBAN_WIP_OK_COLOR', '#112233')
    expect(existsSync(OVERRIDES_PATH)).toBe(true)
    const onDisk = JSON.parse(readFileSync(OVERRIDES_PATH, 'utf-8'))
    expect(onDisk.KANBAN_WIP_OK_COLOR).toBe('#112233')
  })

  it('rejects an invalid value and does not write or change the cache', () => {
    setOverride('KANBAN_WIP_WARN_PCT', 50) // baseline valid override
    const result = setOverride('KANBAN_WIP_WARN_PCT', 0) // 0 disallowed (min: 1)
    expect(result.ok).toBe(false)
    // rollback: the earlier valid override must still be in effect, not 0
    // and not silently reset to the registry default either.
    expect(getEffectiveSettingValue('KANBAN_WIP_WARN_PCT')).toBe(50)
  })

  it('rejects an unknown key without touching the file', () => {
    const before = existsSync(OVERRIDES_PATH) ? readFileSync(OVERRIDES_PATH, 'utf-8') : null
    const result = setOverride('NOT_A_REAL_KEY', 'x')
    expect(result.ok).toBe(false)
    const after = existsSync(OVERRIDES_PATH) ? readFileSync(OVERRIDES_PATH, 'utf-8') : null
    expect(after).toBe(before)
  })

  it('merges multiple overrides instead of clobbering previously set keys', () => {
    setOverride('KANBAN_WIP_WARN_PCT', 60)
    setOverride('KANBAN_WIP_OK_COLOR', '#abcdef')
    const overrides = getOverrides()
    expect(overrides.KANBAN_WIP_WARN_PCT).toBe(60)
    expect(overrides.KANBAN_WIP_OK_COLOR).toBe('#abcdef')
  })
})
