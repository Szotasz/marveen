// COLLANLOCK1120: COLLEAGUE_LAN_LOCK=off (and on -> auto) loosens the colleague LAN lock, so through POST /api/settings
// only the owner's session may set it; the shared token may tighten it (on) and nothing else. Same harness as
// settings-loosen-owner-only.test.ts.
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'

const settings = new Map<string, string>()
vi.mock('../settings-store.js', () => ({
  getEffectiveSettingValue: (k: string) => settings.get(k) ?? '',
  getEffectiveSettingSource: (k: string) => ({ value: settings.get(k) ?? '', source: settings.has(k) ? 'override' : 'default' }),
  getSettingFallback: () => ({ value: 'auto', source: 'default' }),
  setOverride: (k: string, v: unknown) => { settings.set(k, String(v)); return { ok: true } },
  clearOverride: (k: string) => { const had = settings.delete(k); return { ok: true, removed: had } },
}))
vi.mock('../db.js', async (orig) => ({ ...(await orig<typeof import('../db.js')>()), logConfigChange: () => {} }))
vi.mock('../store-watcher.js', () => ({ setStoreWriteActor: () => {} }))
vi.mock('../web/claude-rotation-heartbeat.js', () => ({ syncRotationHeartbeatTask: () => {} }))

const { tryHandleSettings } = await import('../web/routes/settings.js')
const { initDatabase, getDb, createDashboardUser } = await import('../db.js')
const { _clearSessionCacheForTest } = await import('../web/auth-sessions.js')

type Auth = { kind: 'token' | 'session' | 'device'; scope?: 'full' | 'operator'; user?: string }
async function call(method: 'POST' | 'DELETE', path: string, body: unknown, auth: Auth) {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = { writeHead(s: number) { out.status = s; return res }, setHeader() {}, end(c?: string) { if (c) out.body = JSON.parse(c) } }
  const str = body === undefined ? '' : JSON.stringify(body)
  const req: any = { headers: {}, on(ev: string, cb: (c?: Buffer) => void) { if (ev === 'data' && str) cb(Buffer.from(str)); if (ev === 'end') cb() } }
  const url = new URL(`http://localhost${path}`)
  expect(await tryHandleSettings({ req, res, path: url.pathname, method, url, auth } as any)).toBe(true)
  return out
}
const set = (value: string, auth: Auth) => call('POST', '/api/settings', { key: 'COLLEAGUE_LAN_LOCK', value }, auth)

beforeAll(() => { initDatabase(':memory:') })

describe('COLLEAGUE_LAN_LOCK: the shared token may tighten it, only the owner loosens it', () => {
  beforeEach(() => {
    settings.clear()
    getDb().exec('DELETE FROM auth_sessions; DELETE FROM dashboard_users')
    _clearSessionCacheForTest()
    createDashboardUser('owner', 'x'.repeat(60))
  })

  it('the token may set on (a tightening)', async () => {
    expect((await set('on', { kind: 'token' })).status).toBe(200)
    expect(settings.get('COLLEAGUE_LAN_LOCK')).toBe('on')
  })

  it('the token may not set off, nor step on down to auto, nor reset on to the default; the value stays', async () => {
    const off = await set('off', { kind: 'token' })
    expect(off.status).toBe(403)
    expect(off.body.code).toBe('owner_session_required')
    expect(settings.has('COLLEAGUE_LAN_LOCK')).toBe(false)
    settings.set('COLLEAGUE_LAN_LOCK', 'on')
    expect((await set('auto', { kind: 'token' })).status).toBe(403)
    expect((await call('DELETE', '/api/settings/COLLEAGUE_LAN_LOCK', undefined, { kind: 'token' })).status).toBe(403)
    expect(settings.get('COLLEAGUE_LAN_LOCK')).toBe('on')
  })

  it('a device key is not the owner', async () => {
    expect((await set('off', { kind: 'device', scope: 'full' })).status).toBe(403)
  })

  it('the owner session may set off', async () => {
    expect((await set('off', { kind: 'session', user: 'owner' })).status).toBe(200)
    expect(settings.get('COLLEAGUE_LAN_LOCK')).toBe('off')
  })
})
