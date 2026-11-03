import { describe, it, expect, beforeEach, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Same enforced sandbox as settings-store.test.ts: STORE_DIR is baked into the
// store at import time, so it has to be mocked in before anything loads.
const SANDBOX = mkdtempSync(join(tmpdir(), 'settings-reset-route-'))
const STORE = join(SANDBOX, 'store')

const envFile: Record<string, string> = {}
const configChanges: Array<{ key: string; oldValue: unknown; newValue: unknown; actor: string }> = []
const rotationSyncs: string[] = []

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
vi.mock('../db.js', () => ({
  logConfigChange: (key: string, oldValue: unknown, newValue: unknown, actor: string) => { configChanges.push({ key, oldValue, newValue, actor }) },
}))
vi.mock('../store-watcher.js', () => ({ setStoreWriteActor: () => {} }))
vi.mock('../web/claude-rotation-heartbeat.js', () => ({
  syncRotationHeartbeatTask: () => { rotationSyncs.push('sync'); return 'unchanged' },
}))

const { OVERRIDES_PATH, setOverride, reloadOverridesForTest } = await import('../settings-store.js')
const { tryHandleSettings } = await import('../web/routes/settings.js')

function call(method: string, path: string, body?: unknown): { ctx: any; out: { status: number; body: any } } {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const bodyStr = body === undefined ? '' : JSON.stringify(body)
  const req: any = {
    on(event: string, cb: (chunk?: Buffer) => void) {
      if (event === 'data' && bodyStr) cb(Buffer.from(bodyStr))
      if (event === 'end') cb()
    },
  }
  return { ctx: { req, res, path, method, url: new URL(`http://localhost${path}`) }, out }
}

async function listed(key: string): Promise<any> {
  const { ctx, out } = call('GET', '/api/settings')
  await tryHandleSettings(ctx)
  return out.body.settings.find((s: any) => s.key === key)
}

beforeEach(() => {
  mkdirSync(STORE, { recursive: true })
  if (existsSync(OVERRIDES_PATH)) rmSync(OVERRIDES_PATH)
  reloadOverridesForTest()
  for (const k of Object.keys(envFile)) delete envFile[k]
  configChanges.length = 0
  rotationSyncs.length = 0
})

describe('GET /api/settings names the layer that answers', () => {
  it('default, then override once a value is saved', async () => {
    expect((await listed('KANBAN_WIP_WARN_PCT')).source).toBe('default')
    setOverride('KANBAN_WIP_WARN_PCT', 55)
    expect(await listed('KANBAN_WIP_WARN_PCT')).toMatchObject({ value: 55, source: 'override' })
  })

  it('env when .env carries the key', async () => {
    envFile.KANBAN_WIP_WARN_PCT = '70'
    expect(await listed('KANBAN_WIP_WARN_PCT')).toMatchObject({ value: 70, source: 'env' })
  })
})

// Review of #1908: a confirmation that lists only key names cannot show that a
// reset switches a notification back on. The page needs, before the reset, the
// value that will answer afterwards and the layer it comes from.
describe('GET /api/settings says what a reset would turn each value into', () => {
  it('an overridden key with nothing in .env falls back to the registry default', async () => {
    setOverride('KANBAN_WIP_WARN_PCT', 55)
    const row = await listed('KANBAN_WIP_WARN_PCT')
    expect(row).toMatchObject({ value: 55, source: 'override', resetValue: row.default, resetSource: 'default' })
  })

  it('an overridden key that is also in .env falls back to the .env value, and says so', async () => {
    envFile.KANBAN_WIP_WARN_PCT = '70'
    setOverride('KANBAN_WIP_WARN_PCT', 55)
    expect(await listed('KANBAN_WIP_WARN_PCT')).toMatchObject({ value: 55, source: 'override', resetValue: 70, resetSource: 'env' })
  })

  it('the preview is what the reset then actually answers', async () => {
    envFile.KANBAN_WIP_WARN_PCT = '70'
    setOverride('KANBAN_WIP_WARN_PCT', 55)
    const before = await listed('KANBAN_WIP_WARN_PCT')
    const { ctx, out } = call('DELETE', '/api/settings/KANBAN_WIP_WARN_PCT')
    await tryHandleSettings(ctx)
    expect(out.body).toMatchObject({ value: before.resetValue, source: before.resetSource })
  })

  it('a key that is not overridden previews its own current value', async () => {
    const row = await listed('KANBAN_WIP_WARN_PCT')
    expect(row).toMatchObject({ source: 'default', resetValue: row.value, resetSource: 'default' })
  })
})

describe('DELETE /api/settings/<KEY>', () => {
  it('refuses a body that did not arrive in full: 400 incomplete-body, the override stays', async () => {
    setOverride('KANBAN_WIP_WARN_PCT', 55)
    const { ctx, out } = call('DELETE', '/api/settings/KANBAN_WIP_WARN_PCT')
    // Some bytes, then the request closes without 'end' (a cut-off client).
    const listeners: Record<string, Array<(c?: Buffer) => void>> = {}
    ctx.req = { on(event: string, cb: (c?: Buffer) => void) { (listeners[event] ??= []).push(cb) } }
    const done = tryHandleSettings(ctx)
    for (const cb of listeners.data ?? []) cb(Buffer.from('{"actor":"ops'))
    for (const cb of listeners.close ?? []) cb()
    expect(await done).toBe(true)
    expect(out.status).toBe(400)
    expect(out.body?.code).toBe('incomplete-body')
    expect(JSON.parse(readFileSync(OVERRIDES_PATH, 'utf-8')).KANBAN_WIP_WARN_PCT).toBe(55)
    expect(configChanges).toEqual([])
  })

  it('removes the override: the registry default answers again, and the change is logged', async () => {
    setOverride('KANBAN_WIP_WARN_PCT', 55)
    const def = await listed('KANBAN_WIP_WARN_PCT')

    const { ctx, out } = call('DELETE', '/api/settings/KANBAN_WIP_WARN_PCT')
    expect(await tryHandleSettings(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body).toMatchObject({ ok: true, key: 'KANBAN_WIP_WARN_PCT', removed: true, value: def.default, source: 'default' })
    expect('KANBAN_WIP_WARN_PCT' in JSON.parse(readFileSync(OVERRIDES_PATH, 'utf-8'))).toBe(false)
    expect(configChanges).toEqual([{ key: 'KANBAN_WIP_WARN_PCT', oldValue: 55, newValue: def.default, actor: 'dashboard' }])
  })

  it('lands on the .env value when .env carries the key, and says so', async () => {
    envFile.KANBAN_WIP_WARN_PCT = '70'
    setOverride('KANBAN_WIP_WARN_PCT', 55)
    const { ctx, out } = call('DELETE', '/api/settings/KANBAN_WIP_WARN_PCT')
    await tryHandleSettings(ctx)
    expect(out.body).toMatchObject({ removed: true, value: 70, source: 'env' })
  })

  it('is idempotent: no override -> 200, removed:false, and nothing is logged', async () => {
    const { ctx, out } = call('DELETE', '/api/settings/KANBAN_WIP_WARN_PCT')
    await tryHandleSettings(ctx)
    expect(out.status).toBe(200)
    expect(out.body).toMatchObject({ ok: true, removed: false, source: 'default' })
    expect(configChanges).toEqual([])
  })

  it('records the actor from the body when one is given', async () => {
    setOverride('KANBAN_WIP_WARN_PCT', 55)
    await tryHandleSettings(call('DELETE', '/api/settings/KANBAN_WIP_WARN_PCT', { actor: 'suzy' }).ctx)
    expect(configChanges[0].actor).toBe('suzy')
  })

  it('an unknown key is 404 and touches nothing', async () => {
    setOverride('KANBAN_WIP_WARN_PCT', 55)
    const { ctx, out } = call('DELETE', '/api/settings/NO_SUCH_KEY')
    expect(await tryHandleSettings(ctx)).toBe(true)
    expect(out.status).toBe(404)
    expect(JSON.parse(readFileSync(OVERRIDES_PATH, 'utf-8'))).toEqual({ KANBAN_WIP_WARN_PCT: 55 })
  })

  it('an unreadable overrides file is 409, and the file is left byte-identical', async () => {
    const broken = '{ "KANBAN_WIP_WARN_PCT": 55, broken'
    writeFileSync(OVERRIDES_PATH, broken)
    reloadOverridesForTest()
    const { ctx, out } = call('DELETE', '/api/settings/KANBAN_WIP_WARN_PCT')
    expect(await tryHandleSettings(ctx)).toBe(true)
    expect(out.status).toBe(409)
    expect(out.body.error).toContain('invalid-json')
    expect(readFileSync(OVERRIDES_PATH, 'utf-8')).toBe(broken)
    expect(configChanges).toEqual([])
  })

  it('does not swallow other paths or methods', async () => {
    expect(await tryHandleSettings(call('DELETE', '/api/settings').ctx)).toBe(false)
    expect(await tryHandleSettings(call('DELETE', '/api/settings/lowercase').ctx)).toBe(false)
    expect(await tryHandleSettings(call('PUT', '/api/settings/KANBAN_WIP_WARN_PCT').ctx)).toBe(false)
  })

  it('resetting the rotation switch re-syncs its heartbeat task, like saving it does', async () => {
    setOverride('CLAUDE_ROTATION_ENABLED', '1')
    await tryHandleSettings(call('DELETE', '/api/settings/CLAUDE_ROTATION_ENABLED').ctx)
    expect(rotationSyncs).toEqual(['sync'])
  })
})
