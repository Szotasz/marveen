import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// ENFORCED sandbox, not an assumed one. The previous version of this file
// imported the real settings-store (STORE_DIR = <repoRoot>/store) and relied
// on a comment claiming the checkout lives under /tmp; run in a production
// checkout it rmSync'd the LIVE store/config-overrides.json (2026-07-27
// incident: the deletion dropped MAIN_AGENT_ISOLATED_CONFIG and 401'd the
// main agent that evening). STORE_DIR is baked into OVERRIDES_PATH at import
// time, so the sandbox must be mocked in before the module loads.
const SANDBOX = mkdtempSync(join(tmpdir(), 'settings-store-'))
const STORE = join(SANDBOX, 'store')

vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return { ...actual, PROJECT_ROOT: SANDBOX, STORE_DIR: STORE }
})
// The .env resolution layer reads the REAL repo-root .env (env.ts carries its
// own PROJECT_ROOT), which would leak host state into the "falls back to the
// registry default" assertion -- blank it.
vi.mock('../env.js', async (orig) => {
  const actual = await orig<typeof import('../env.js')>()
  return { ...actual, readEnvFile: () => ({}) }
})

const {
  OVERRIDES_PATH,
  getEffectiveSettingValue,
  setOverride,
  clearOverride,
  getEffectiveSettingSource,
  getOverrides,
  reloadOverridesForTest,
} = await import('../settings-store.js')

describe('settings-store', () => {
  it('resolves OVERRIDES_PATH inside the sandbox (the guard this suite relies on)', () => {
    expect(OVERRIDES_PATH).toBe(join(STORE, 'config-overrides.json'))
  })

  beforeEach(() => {
    mkdirSync(STORE, { recursive: true })
    if (existsSync(OVERRIDES_PATH)) rmSync(OVERRIDES_PATH)
    reloadOverridesForTest()
  })

  afterAll(() => {
    rmSync(SANDBOX, { recursive: true, force: true })
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

describe('clearOverride: the way back from a saved value', () => {
  beforeEach(() => {
    mkdirSync(STORE, { recursive: true })
    if (existsSync(OVERRIDES_PATH)) rmSync(OVERRIDES_PATH)
    reloadOverridesForTest()
  })

  it('removes the key, and the value falls back to the registry default', () => {
    expect(setOverride('KANBAN_WIP_WARN_PCT', 55).ok).toBe(true)
    expect(getEffectiveSettingSource('KANBAN_WIP_WARN_PCT')).toEqual({ value: 55, source: 'override' })

    expect(clearOverride('KANBAN_WIP_WARN_PCT')).toEqual({ ok: true, removed: true })
    expect(getEffectiveSettingSource('KANBAN_WIP_WARN_PCT').source).toBe('default')
    expect('KANBAN_WIP_WARN_PCT' in getOverrides()).toBe(false)
    expect('KANBAN_WIP_WARN_PCT' in JSON.parse(readFileSync(OVERRIDES_PATH, 'utf-8'))).toBe(false)
  })

  it('leaves every other override in the file alone', () => {
    setOverride('KANBAN_WIP_WARN_PCT', 55)
    setOverride('KANBAN_SWIMLANE_DEFAULT_GROUP', 'priority')
    clearOverride('KANBAN_WIP_WARN_PCT')
    expect(JSON.parse(readFileSync(OVERRIDES_PATH, 'utf-8'))).toEqual({ KANBAN_SWIMLANE_DEFAULT_GROUP: 'priority' })
  })

  it('is idempotent: nothing to remove is ok, and writes nothing', () => {
    expect(clearOverride('KANBAN_WIP_WARN_PCT')).toEqual({ ok: true, removed: false })
    expect(existsSync(OVERRIDES_PATH)).toBe(false)
  })

  it('rejects an unknown key', () => {
    const r = clearOverride('NO_SUCH_KEY')
    expect(r.ok).toBe(false)
    expect(r.removed).toBe(false)
  })

  it('refuses to rewrite an unreadable overrides file instead of emptying it', async () => {
    const { writeFileSync } = await import('node:fs')
    writeFileSync(OVERRIDES_PATH, '{ "KANBAN_WIP_WARN_PCT": 55, broken')
    const r = clearOverride('KANBAN_WIP_WARN_PCT')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('invalid-json')
    expect(readFileSync(OVERRIDES_PATH, 'utf-8')).toBe('{ "KANBAN_WIP_WARN_PCT": 55, broken')
  })
})
