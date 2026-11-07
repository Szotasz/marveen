/**
 * SCHEDWRITE1023, review of #2354 (point 2): SELF_PACE_SCHEDULE_WRITERS grants a deny exemption, so it LOOSENS a
 * control. Under the overrides-only rule (ENVRELAXGATE1104) its value comes from the owner's override only; a `.env`
 * line can never add a writer. Adding a name loosens; removing, reordering or spacing does not.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const SANDBOX = mkdtempSync(join(tmpdir(), 'schedule-writers-env-'))
const STORE = join(SANDBOX, 'store')
const envFile: Record<string, string> = {}

vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return { ...actual, PROJECT_ROOT: SANDBOX, STORE_DIR: STORE }
})
vi.mock('../env.js', async (orig) => {
  const actual = await orig<typeof import('../env.js')>()
  return {
    ...actual,
    readEnvFile: (keys?: string[]) => Object.fromEntries(Object.entries(envFile).filter(([k]) => !keys || keys.includes(k))),
  }
})
vi.mock('../db.js', () => ({ logConfigChange: () => {} }))
vi.mock('../store-watcher.js', () => ({ setStoreWriteActor: () => {} }))

const store = await import('../settings-store.js')
const registry = await import('../config-registry.js')
const KEY = 'SELF_PACE_SCHEDULE_WRITERS'

beforeEach(() => {
  mkdirSync(STORE, { recursive: true })
  if (existsSync(store.OVERRIDES_PATH)) rmSync(store.OVERRIDES_PATH)
  store.reloadOverridesForTest()
  for (const k of Object.keys(envFile)) delete envFile[k]
})

describe('SELF_PACE_SCHEDULE_WRITERS is an overrides-only key with a loosens rule', () => {
  it('E1: the key has a loosens function and is overrides-only', () => {
    const def = registry.getSettingDefinition(KEY)!
    expect(def, 'registered').toBeTruthy()
    expect(typeof def.loosens).toBe('function')
    expect(registry.isOverridesOnly(def)).toBe(true)
  })

  it('E2: adding a name loosens; removing, reordering and spacing do not; a case variant is a new name', () => {
    const l = registry.getSettingDefinition(KEY)!.loosens!
    expect(l('', 'trinity')).toBe(true)
    expect(l('trinity', 'trinity,neo')).toBe(true)
    expect(l('trinity', 'Trinity')).toBe(true)
    expect(l('trinity,neo', 'neo')).toBe(false)
    expect(l('trinity, neo', 'neo,trinity')).toBe(false)
    expect(l('trinity', '')).toBe(false)
    expect(l('trinity', 'trinity')).toBe(false)
  })

  it('E3: a .env line cannot add a writer: the default (empty) answers', () => {
    envFile[KEY] = 'trinity'
    expect(store.getEffectiveSettingSource(KEY)).toEqual({ value: '', source: 'default' })
    expect(store.getEffectiveSettingValue(KEY)).toBe('')
  })
})
