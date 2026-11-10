// CLI_INVENTORY_DIRS decides which binaries the dashboard process STARTS with its own rights (scripts/cli-inventory.py
// runs every *-pp-cli it finds there), outside the agent hooks' gates. So the shared fleet token must not move it:
// any change through the Settings route needs the owner, and the key is overrides-only, so a .env line (a file a
// process can write without the dashboard's owner check) that differs from the default never counts. The harness is
// the real settings store and route (as in settings-overrides-only.test.ts) on an in-memory database.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const SANDBOX = mkdtempSync(join(tmpdir(), 'cli-inventory-setting-'))
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
vi.mock('../store-watcher.js', () => ({ setStoreWriteActor: () => {} }))
vi.mock('../web/claude-rotation-heartbeat.js', () => ({ syncRotationHeartbeatTask: () => 'unchanged' }))

const store = await import('../settings-store.js')
const registry = await import('../config-registry.js')
const { tryHandleSettings } = await import('../web/routes/settings.js')
const { cliDirArgs } = await import('../web/routes/cli-inventory.js')
const { initDatabase } = await import('../db.js')

const KEY = 'CLI_INVENTORY_DIRS'
// Empty: the inventory is off until the owner names a folder.
const DEFAULT = ''

type Auth = { kind: 'token' | 'device'; scope?: 'full' | 'operator' }
async function call(method: 'POST' | 'DELETE', path: string, body: unknown, auth: Auth) {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = { writeHead(s: number) { out.status = s; return res }, setHeader() {}, end(c?: string) { if (c) out.body = JSON.parse(c) } }
  const str = body === undefined ? '' : JSON.stringify(body)
  const req: any = { headers: {}, on(ev: string, cb: (c?: Buffer) => void) { if (ev === 'data' && str) cb(Buffer.from(str)); if (ev === 'end') cb() } }
  const url = new URL(`http://localhost${path}`)
  expect(await tryHandleSettings({ req, res, path: url.pathname, method, url, auth } as any)).toBe(true)
  return out
}

// The owner check reads the session tables, so the route needs a real (in-memory) database.
beforeAll(() => { initDatabase(':memory:') })
beforeEach(() => {
  mkdirSync(STORE, { recursive: true })
  if (existsSync(store.OVERRIDES_PATH)) rmSync(store.OVERRIDES_PATH)
  store.reloadOverridesForTest()
  for (const k of Object.keys(envFile)) delete envFile[k]
})

describe('CLI_INVENTORY_DIRS: only the owner chooses what the dashboard runs', () => {
  it('registry: any change loosens, so the key is overrides-only and no .env value tightens it', () => {
    const def = registry.getSettingDefinition(KEY)!
    expect(def.loosens!(DEFAULT, '/home/agent/evil')).toBe(true)
    expect(def.loosens!('/srv/trusted-clis', '/srv/trusted-clis, /opt/more')).toBe(true)
    expect(def.loosens!('/srv/trusted-clis', DEFAULT)).toBe(true)
    expect(def.loosens!(DEFAULT, DEFAULT)).toBe(false)
    expect(registry.isOverridesOnly(def)).toBe(true)
    expect(registry.envValueTightens(def, '/home/agent/evil')).toBe(false)
  })

  it('the shared token gets 403 for a set and for a reset; the owner\'s value stays', async () => {
    expect(store.setOverride(KEY, '/srv/trusted-clis').ok).toBe(true)
    const set = await call('POST', '/api/settings', { key: KEY, value: '/home/agent/evil' }, { kind: 'token' })
    expect(set.status).toBe(403)
    expect(set.body.code).toBe('owner_session_required')
    expect((await call('DELETE', `/api/settings/${KEY}`, undefined, { kind: 'token' })).status).toBe(403)
    expect((await call('POST', '/api/settings', { key: KEY, value: '/home/agent/evil' }, { kind: 'device', scope: 'operator' })).status).toBe(403)
    expect(store.getEffectiveSettingSource(KEY)).toEqual({ value: '/srv/trusted-clis', source: 'override' })
  })

  it('a .env line that differs from the default is ignored: the inventory stays off', () => {
    envFile[KEY] = '/home/agent/evil'
    expect(store.getEffectiveSettingSource(KEY)).toEqual({ value: DEFAULT, source: 'default' })
    expect(store.isEnvValueIgnored(KEY)).toBe(true)
    expect(() => cliDirArgs()).toThrow('the inventory is off')
  })

  it('the owner\'s override applies over a .env line', () => {
    envFile[KEY] = '/home/agent/evil'
    expect(store.setOverride(KEY, '/srv/trusted-clis').ok).toBe(true)
    expect(cliDirArgs()).toEqual(['--dir', '/srv/trusted-clis'])
  })

  it('KONTROLL: the token may still change a plain key', async () => {
    expect((await call('POST', '/api/settings', { key: 'KANBAN_WIP_WARN_PCT', value: 60 }, { kind: 'token' })).status).toBe(200)
  })
})
