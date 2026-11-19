// DASHBOARD_PUBLIC_URL and AGENT_API_ORIGIN are the two values the agents' dashboard origin is resolved from
// (resolveDashboardOrigin, agent-scaffold.ts). Measured 2026-11-16 on a live install: DASHBOARD_PUBLIC_URL had been
// saved as "marveen" (a name, no scheme), and every generated recipe read `curl ... marveen/api/messages`. The Settings
// route accepted it because the key was a plain string. Both keys now take an empty value or an absolute http(s) URL;
// anything else is refused with 400 before it reaches the overrides file.
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
const { getSettingDefinition, validateSettingValue, isAbsoluteHttpUrl } = await import('../config-registry.js')
const { initDatabase, getDb, createDashboardUser } = await import('../db.js')
const { createSession, _clearSessionCacheForTest } = await import('../web/auth-sessions.js')
const { SESSION_COOKIE_NAME } = await import('../web/auth-gate.js')

const KEYS = ['DASHBOARD_PUBLIC_URL', 'AGENT_API_ORIGIN']
const VALID = [
  'https://marveen.example.com',
  'https://marveen.example.com/',
  'http://localhost:3420',
  'http://127.0.0.1:3420',
  'http://[::1]:3420',
  'http://marveen-dashboard.default.svc:3420',
  'https://example.com/marveen',
  'HTTPS://Marveen.Example.com',
]
const INVALID = [
  'marveen',
  'marveen.example.com',
  'localhost:3420',
  '//marveen.example.com',
  'ftp://marveen.example.com',
  'file:///srv/marveen',
  'javascript:alert(1)',
  'http:marveen.example.com',
  'http://',
  'https:///api',
  ' https://marveen.example.com',
  'https://marveen.example.com ',
  'https://marveen example.com',
]

async function post(body: unknown) {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = { writeHead(s: number) { out.status = s; return res }, setHeader() {}, end(c?: string) { if (c) out.body = JSON.parse(c) } }
  const str = JSON.stringify(body)
  const headers = { cookie: `${SESSION_COOKIE_NAME}=${createSession({ userId: ownerId, username: 'owner' })}` }
  const req: any = { headers, on(ev: string, cb: (c?: Buffer) => void) { if (ev === 'data') cb(Buffer.from(str)); if (ev === 'end') cb() } }
  const url = new URL('http://localhost/api/settings')
  const auth = { kind: 'session', user: 'owner' }
  expect(await tryHandleSettings({ req, res, path: url.pathname, method: 'POST', url, auth } as any)).toBe(true)
  return out
}
let ownerId = 0

beforeAll(() => { initDatabase(':memory:') })
beforeEach(() => {
  settings.clear()
  getDb().exec('DELETE FROM auth_sessions; DELETE FROM dashboard_users')
  _clearSessionCacheForTest()
  ownerId = createDashboardUser('owner', 'x'.repeat(60)).id
})

describe('isAbsoluteHttpUrl', () => {
  it.each(VALID)('accepts %s', (v) => { expect(isAbsoluteHttpUrl(v)).toBe(true) })
  it.each(['', ...INVALID])('refuses %j', (v) => { expect(isAbsoluteHttpUrl(v)).toBe(false) })
})

describe.each(KEYS)('registry: %s takes an empty value or an absolute http(s) URL', (key) => {
  const def = getSettingDefinition(key)!

  it.each(VALID)('accepts %s and keeps it as written', (v) => {
    expect(validateSettingValue(def, v)).toEqual({ ok: true, value: v })
  })

  it('accepts the empty value (the key is unset)', () => {
    expect(validateSettingValue(def, '')).toEqual({ ok: true, value: '' })
  })

  it.each(INVALID)('refuses %j with a message that says what is expected', (v) => {
    const r = validateSettingValue(def, v)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('http(s) URL')
    expect(r.value).toBeUndefined()
  })
})

describe.each(KEYS)('POST /api/settings: %s', (key) => {
  it.each(INVALID)('400 for %j, and the stored value stays', async (v) => {
    settings.set(key, 'http://localhost:3420')
    const r = await post({ key, value: v })
    expect(r.status).toBe(400)
    expect(r.body.error).toContain('http(s) URL')
    expect(settings.get(key)).toBe('http://localhost:3420')
  })

  it.each(VALID)('200 for %s, stored as written', async (v) => {
    const r = await post({ key, value: v })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ ok: true, key, value: v, requiresRestart: true })
    expect(settings.get(key)).toBe(v)
  })

  it('200 for the empty value', async () => {
    settings.set(key, 'http://localhost:3420')
    expect((await post({ key, value: '' })).status).toBe(200)
    expect(settings.get(key)).toBe('')
  })
})

describe('KONTROLL: the rule is on these two keys only', () => {
  it('OLLAMA_URL, another network-target key, carries no such check', () => {
    expect(getSettingDefinition('OLLAMA_URL')!.validate).toBeUndefined()
  })
})
