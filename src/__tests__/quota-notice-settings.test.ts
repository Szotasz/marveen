// QUOTANOTICE1126: the quota notice settings are OFF by default and owner-gated: the shared fleet token
// can neither switch them nor move their thresholds; the owner session can.
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'

const settings = new Map<string, string>()
vi.mock('../settings-store.js', async (orig) => ({
  ...(await orig<typeof import('../settings-store.js')>()),
  getEffectiveSettingValue: (k: string) => settings.get(k) ?? '',
  getEffectiveSettingSource: (k: string) => ({ value: settings.get(k) ?? '', source: settings.has(k) ? 'override' : 'default' }),
  getSettingFallback: () => ({ value: '', source: 'default' }),
  setOverride: (k: string, v: unknown) => { settings.set(k, String(v)); return { ok: true } },
  clearOverride: (k: string) => { const had = settings.delete(k); return { ok: true, removed: had } },
}))
vi.mock('../db.js', async (orig) => ({ ...(await orig<typeof import('../db.js')>()), logConfigChange: () => {} }))
vi.mock('../store-watcher.js', () => ({ setStoreWriteActor: () => {} }))
vi.mock('../web/claude-rotation-heartbeat.js', () => ({ syncRotationHeartbeatTask: () => {} }))

const { tryHandleSettings } = await import('../web/routes/settings.js')
const registry = await import('../config-registry.js')
const { initDatabase, getDb, createDashboardUser } = await import('../db.js')
const { createSession, _clearSessionCacheForTest } = await import('../web/auth-sessions.js')
const { SESSION_COOKIE_NAME } = await import('../web/auth-gate.js')


type Auth = { kind: 'token' | 'session' | 'device'; scope?: 'full' | 'operator'; user?: string }
async function call(method: 'POST' | 'DELETE', path: string, body: unknown, auth: Auth, headers: Record<string, string> = {}) {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = { writeHead(s: number) { out.status = s; return res }, setHeader() {}, end(c?: string) { if (c) out.body = JSON.parse(c) } }
  const str = body === undefined ? '' : JSON.stringify(body)
  const req: any = { headers, on(ev: string, cb: (c?: Buffer) => void) { if (ev === 'data' && str) cb(Buffer.from(str)); if (ev === 'end') cb() } }
  const url = new URL(`http://localhost${path}`)
  expect(await tryHandleSettings({ req, res, path: url.pathname, method, url, auth } as any)).toBe(true)
  return out
}
let ownerId = 0
const ownerCookie = () => `${SESSION_COOKIE_NAME}=${createSession({ userId: ownerId, username: 'owner' })}`

beforeAll(() => { initDatabase(':memory:') })
beforeEach(() => {
  settings.clear()
  getDb().exec('DELETE FROM auth_sessions; DELETE FROM dashboard_users')
  _clearSessionCacheForTest()
  ownerId = createDashboardUser('owner', 'x'.repeat(60)).id
})


const QUOTA = ['QUOTA_NOTICE', 'QUOTA_NOTICE_PCT', 'QUOTA_PLAN_PROBE_MIN']
const VALUE: Record<string, string | number> = { QUOTA_NOTICE: '1', QUOTA_NOTICE_PCT: 80, QUOTA_PLAN_PROBE_MIN: 30 }

describe('registry', () => {
  it('the three keys exist in the claude-plans module, owner-gated, the switch OFF by default', () => {
    for (const k of QUOTA) {
      const def = registry.getSettingDefinition(k)!
      expect(def, k).toBeTruthy()
      expect(def.module, k).toBe('claude-plans')
      expect(def.ownerGated, k).toBe(true)
      expect(def.requiresRestart, k).toBe(false)
    }
    expect(registry.getSettingDefinition('QUOTA_NOTICE')!.default).toBe('0')
    expect(registry.getSettingDefinition('QUOTA_NOTICE_PCT')!.default).toBe(90)
    // The auto-reply was removed from this PR (maintainer review): its keys must be gone.
    for (const k of ['QUOTA_AUTOREPLY', 'QUOTA_AUTOREPLY_PCT', 'QUOTA_AUTOREPLY_GRACE_SEC']) expect(registry.getSettingDefinition(k), k).toBeUndefined()
  })
  it('a threshold outside 50..100 is refused', () => {
    expect(registry.validateSettingValue(registry.getSettingDefinition('QUOTA_NOTICE_PCT')!, 120).ok).toBe(false)
    expect(registry.validateSettingValue(registry.getSettingDefinition('QUOTA_NOTICE_PCT')!, 40).ok).toBe(false)
    expect(registry.validateSettingValue(registry.getSettingDefinition('QUOTA_NOTICE_PCT')!, 85).ok).toBe(true)
  })
})

describe('route', () => {
  it.each(QUOTA)('%s: the shared token gets 403 for a set and a reset', async (key) => {
    const r = await call('POST', '/api/settings', { key, value: VALUE[key] }, { kind: 'token' })
    expect(r.status).toBe(403)
    expect(r.body.code).toBe('owner_session_required')
    expect((await call('DELETE', `/api/settings/${key}`, undefined, { kind: 'token' })).status).toBe(403)
    expect(settings.has(key)).toBe(false)
  })
  it.each(QUOTA)('%s: the owner session may set and reset it', async (key) => {
    const owner = { kind: 'session' as const, user: 'owner' }
    expect((await call('POST', '/api/settings', { key, value: VALUE[key] }, owner, { cookie: ownerCookie() })).status).toBe(200)
    expect(String(settings.get(key))).toBe(String(VALUE[key]))
    expect((await call('DELETE', `/api/settings/${key}`, undefined, owner, { cookie: ownerCookie() })).status).toBe(200)
  })
})
