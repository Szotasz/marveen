import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const SANDBOX = mkdtempSync(join(tmpdir(), 'usage-limit-notice-route-'))
const STORE = join(SANDBOX, 'store')
const checkoutOverrides = join(__dirname, '..', '..', 'store', 'config-overrides.json')
const envFile: Record<string, string> = {}

// config.ts reads its boot-time overrides before the partial config mock can replace STORE_DIR.
// Hide that checkout path too, so importing the real constants never reads the real store.
vi.mock('node:fs', async (orig) => {
  const actual = await orig<typeof import('node:fs')>()
  return {
    ...actual,
    existsSync: (path: import('node:fs').PathLike) => String(path) === checkoutOverrides ? false : actual.existsSync(path),
  }
})
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
vi.mock('../web/claude-rotation-heartbeat.js', () => ({ syncRotationHeartbeatTask: () => 'unchanged' }))
vi.mock('../web/agent-process.js', () => ({}))

const store = await import('../settings-store.js')
const { readUsageLimitNoticeRoute } = await import('../web/schedule-runner.js')

beforeEach(() => {
  mkdirSync(STORE, { recursive: true })
  if (existsSync(store.OVERRIDES_PATH)) rmSync(store.OVERRIDES_PATH)
  store.reloadOverridesForTest()
  for (const key of Object.keys(envFile)) delete envFile[key]
})

afterEach(() => { vi.unstubAllEnvs() })
afterAll(() => { rmSync(SANDBOX, { recursive: true, force: true }) })

describe('usage-limit notice route through the real settings store', () => {
  it('ignores a loosening .env line main and uses the registry default', () => {
    envFile.USAGE_LIMIT_NOTICE_ROUTE = 'main'
    expect(readUsageLimitNoticeRoute()).toBe('both')
    expect(store.getEffectiveSettingSource('USAGE_LIMIT_NOTICE_ROUTE').source).toBe('default')
  })

  it('accepts a tightening .env line owner', () => {
    envFile.USAGE_LIMIT_NOTICE_ROUTE = 'owner'
    expect(readUsageLimitNoticeRoute()).toBe('owner')
    expect(store.getEffectiveSettingSource('USAGE_LIMIT_NOTICE_ROUTE').source).toBe('env')
  })

  it('ignores process.env main when there is no .env line', () => {
    vi.stubEnv('USAGE_LIMIT_NOTICE_ROUTE', 'main')
    expect(readUsageLimitNoticeRoute()).toBe('both')
    expect(store.getEffectiveSettingSource('USAGE_LIMIT_NOTICE_ROUTE').source).toBe('default')
  })

  it('accepts the owner override main even over a tightening .env line owner', () => {
    envFile.USAGE_LIMIT_NOTICE_ROUTE = 'owner'
    expect(store.setOverride('USAGE_LIMIT_NOTICE_ROUTE', 'main').ok).toBe(true)
    expect(readUsageLimitNoticeRoute()).toBe('main')
    expect(store.getEffectiveSettingSource('USAGE_LIMIT_NOTICE_ROUTE').source).toBe('override')
  })
})
