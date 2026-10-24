// BASHSANDBOX1022 security review of #2149: a sandboxed agent reaches the dashboard on localhost with
// the shared fleet token, so through POST /api/settings it could take itself off BASH_SANDBOX_AGENTS.
// A setting whose registry entry says a change LOOSENS it accepts that change only from the owner,
// through the predicate that guards issuing credentials (mayIssueCredentials, #2163): the owner's
// session, also when the browser sends the stored token alongside it; the bare token only before the
// first dashboard login exists. Tightening (adding an agent) stays open to every caller.
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'

const settings = new Map<string, string>()
vi.mock('../settings-store.js', () => ({
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
const { SETTINGS_REGISTRY } = await import('../config-registry.js')
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
const set = (value: string, auth: Auth, headers: Record<string, string> = {}) => call('POST', '/api/settings', { key: 'BASH_SANDBOX_AGENTS', value }, auth, headers)
let ownerId = 0
const ownerCookie = () => `${SESSION_COOKIE_NAME}=${createSession({ userId: ownerId, username: 'owner' })}`

beforeAll(() => { initDatabase(':memory:') })

describe('BASH_SANDBOX_AGENTS: the shared token may tighten it, never loosen it', () => {
  beforeEach(() => {
    settings.clear()
    getDb().exec('DELETE FROM auth_sessions; DELETE FROM dashboard_users')
    _clearSessionCacheForTest()
    // a dashboard login exists (the normal state): the bare token is not the owner
    ownerId = createDashboardUser('owner', 'x'.repeat(60)).id
  })

  it('the token may add agents', async () => {
    expect((await set('soma', { kind: 'token' })).status).toBe(200)
    expect((await set('soma, trinity', { kind: 'token' })).status).toBe(200)
    expect(settings.get('BASH_SANDBOX_AGENTS')).toBe('soma, trinity')
  })

  it('the token may not take an agent off, by POST or by reset; the value stays', async () => {
    settings.set('BASH_SANDBOX_AGENTS', 'soma, trinity')
    const r = await set('trinity', { kind: 'token' })
    expect(r.status).toBe(403)
    expect(r.body.code).toBe('owner_session_required')
    expect((await set('', { kind: 'token' })).status).toBe(403)
    expect((await call('DELETE', '/api/settings/BASH_SANDBOX_AGENTS', undefined, { kind: 'token' })).status).toBe(403)
    expect((await set('trinity', { kind: 'token' }, { cookie: `${SESSION_COOKIE_NAME}=not-a-session` })).status).toBe(403)
    expect(settings.get('BASH_SANDBOX_AGENTS')).toBe('soma, trinity')
  })

  it('a device key is not an owner session, whatever its scope', async () => {
    settings.set('BASH_SANDBOX_AGENTS', 'soma, trinity')
    expect((await set('trinity', { kind: 'device', scope: 'operator' })).status).toBe(403)
    expect((await set('trinity', { kind: 'device', scope: 'full' })).status).toBe(403)
    expect(settings.get('BASH_SANDBOX_AGENTS')).toBe('soma, trinity')
  })

  it('the owner session may loosen it, also from a browser that sends the stored token with its session cookie', async () => {
    settings.set('BASH_SANDBOX_AGENTS', 'soma, trinity')
    expect((await set('trinity', { kind: 'session', user: 'owner' })).status).toBe(200)
    expect((await set('', { kind: 'token' }, { cookie: ownerCookie() })).status).toBe(200)
    settings.set('BASH_SANDBOX_AGENTS', 'soma')
    expect((await call('DELETE', '/api/settings/BASH_SANDBOX_AGENTS', undefined, { kind: 'session', user: 'owner' })).status).toBe(200)
  })

  it('before the first dashboard login exists, the token is the one credential there is: it may loosen', async () => {
    getDb().exec('DELETE FROM dashboard_users')
    settings.set('BASH_SANDBOX_AGENTS', 'soma')
    expect((await set('', { kind: 'token' })).status).toBe(200)
  })

  it('the loosens rule: removal loosens, reordering, spacing and case do not', () => {
    const def = SETTINGS_REGISTRY.find((d) => d.key === 'BASH_SANDBOX_AGENTS')!
    expect(def.loosens?.('soma, trinity', 'trinity')).toBe(true)
    expect(def.loosens?.('soma', '')).toBe(true)
    expect(def.loosens?.('soma', 'Trinity  SOMA')).toBe(false)
    expect(def.loosens?.('', 'soma')).toBe(false)
  })
})
