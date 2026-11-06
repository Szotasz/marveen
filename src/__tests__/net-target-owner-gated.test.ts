// NETTARGETENV1104: the five network-target keys choose where the shared token, a whole prompt or every memory text
// is sent. Through POST/DELETE /api/settings any change needs the owner (ownerGated), not the shared fleet token; unlike
// `loosens` the flag does NOT make them overrides-only, so their documented .env line keeps working. A loosens key keeps
// #2500's behaviour (regression). A host change since the last boot is told to the owner once (net-target-notice).
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
const notice = await import('../net-target-notice.js')

const TARGETS = ['DASHBOARD_PUBLIC_URL', 'AGENT_API_ORIGIN', 'AGENT_LOCAL_BASE_URL', 'OLLAMA_URL', 'EMBED_URL']

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

describe('registry: the five targets are ownerGated, NOT loosens (their .env stays)', () => {
  it('exactly the five network targets carry the flag', () => {
    expect(registry.SETTINGS_REGISTRY.filter((d) => d.ownerGated).map((d) => d.key).sort()).toEqual([...TARGETS].sort())
  })
  it('none of them is loosens or overrides-only', () => {
    for (const k of TARGETS) {
      const def = registry.getSettingDefinition(k)!
      expect(def.loosens, k).toBeUndefined()
      expect(registry.isOverridesOnly(def), k).toBe(false)
    }
  })
})

describe('route: any change of a target needs the owner', () => {
  it.each(TARGETS)('%s: the shared token gets 403 for a set and a reset; the value stays', async (key) => {
    settings.set(key, 'http://127.0.0.1:1')
    const r = await call('POST', '/api/settings', { key, value: 'http://example.test:9' }, { kind: 'token' })
    expect(r.status).toBe(403)
    expect(r.body.code).toBe('owner_session_required')
    expect((await call('DELETE', `/api/settings/${key}`, undefined, { kind: 'token' })).status).toBe(403)
    expect((await call('POST', '/api/settings', { key, value: 'http://example.test:9' }, { kind: 'device', scope: 'full' })).status).toBe(403)
    expect(settings.get(key)).toBe('http://127.0.0.1:1')
  })

  it.each(TARGETS)('%s: the owner session may set and reset it', async (key) => {
    const owner = { kind: 'session' as const, user: 'owner' }
    expect((await call('POST', '/api/settings', { key, value: 'http://example.test:9' }, owner, { cookie: ownerCookie() })).status).toBe(200)
    expect(settings.get(key)).toBe('http://example.test:9')
    expect((await call('DELETE', `/api/settings/${key}`, undefined, owner, { cookie: ownerCookie() })).status).toBe(200)
  })

  it('REGRESSION: a loosens key is unchanged (the token may tighten, not loosen)', async () => {
    expect((await call('POST', '/api/settings', { key: 'BASH_SANDBOX_AGENTS', value: 'soma' }, { kind: 'token' })).status).toBe(200)
    expect((await call('POST', '/api/settings', { key: 'BASH_SANDBOX_AGENTS', value: '' }, { kind: 'token' })).status).toBe(403)
  })

  it('KONTROLL: a plain key stays open to the token', async () => {
    expect((await call('POST', '/api/settings', { key: 'KANBAN_WIP_WARN_PCT', value: 60 }, { kind: 'token' })).status).toBe(200)
  })
})

describe('net-target notice: the owner is told once when a target origin changed or is first seen off its default', () => {
  const DEF = { OLLAMA_URL: 'http://localhost:11434', EMBED_URL: '(nincs)', AGENT_API_ORIGIN: '(nincs)' }
  function harness(prev: Record<string, string> | null, now: Record<string, string>) {
    const rec = { stored: prev, notices: [] as string[], sent: true as unknown }
    const deps = {
      current: () => now,
      defaults: () => DEF,
      read: () => rec.stored,
      write: (r: Record<string, string>) => { rec.stored = r },
      notify: async (t: string) => { rec.notices.push(t); return rec.sent },
    }
    return { rec, deps }
  }

  it('originOf keeps scheme + host + port only: no path, query or user:password; empty and invalid are named', () => {
    expect(notice.originOf('https://user:secret@api.example.test:8443/x/y?token=abc')).toBe('https://api.example.test:8443')
    expect(notice.originOf('http://localhost:11434/api')).toBe('http://localhost:11434')
    expect(notice.originOf('')).toBe('(nincs)')
    expect(notice.originOf('not a url')).toBe('(érvénytelen)')
    expect(notice.originOf('localhost:11434')).toBe('(érvénytelen)')
  })

  it('the registry defaults, as origins: the shipped OLLAMA_URL, empty for the rest', () => {
    expect(notice.defaultOrigins()).toEqual({
      DASHBOARD_PUBLIC_URL: '(nincs)', AGENT_API_ORIGIN: '(nincs)', OLLAMA_URL: 'http://localhost:11434', EMBED_URL: '(nincs)', AGENT_LOCAL_BASE_URL: '(nincs)',
    })
  })

  it('the first sight at the default only records (and logs)', async () => {
    const { rec, deps } = harness(null, { OLLAMA_URL: 'http://localhost:11434', EMBED_URL: '(nincs)' })
    expect(await notice.noticeNetTargetDrift(deps)).toEqual([])
    expect(rec.notices).toEqual([])
    expect(rec.stored).toEqual({ OLLAMA_URL: 'http://localhost:11434', EMBED_URL: '(nincs)' })
  })

  it('the first sight OFF the default: ONE notice marked as a first record, recorded after delivery', async () => {
    const { rec, deps } = harness(null, { OLLAMA_URL: 'http://localhost:11434', EMBED_URL: 'https://embed.evil.test' })
    rec.sent = false
    expect(await notice.noticeNetTargetDrift(deps)).toEqual(['EMBED_URL'])
    expect(rec.stored).toBeNull()
    rec.sent = true
    expect(await notice.noticeNetTargetDrift(deps)).toEqual(['EMBED_URL'])
    expect(rec.notices).toHaveLength(2)
    expect(rec.notices[1]).toContain('EMBED_URL: https://embed.evil.test (első rögzítés, nem alapérték)')
    expect(rec.notices[1]).not.toContain('OLLAMA_URL')
    expect(rec.stored).toEqual({ OLLAMA_URL: 'http://localhost:11434', EMBED_URL: 'https://embed.evil.test' })
    expect(await notice.noticeNetTargetDrift(deps)).toEqual([])
    expect(rec.notices).toHaveLength(2)
  })

  it('a deleted record is a first sight again: an off-default target is told, not silently re-baselined', async () => {
    const { rec, deps } = harness({ EMBED_URL: 'https://embed.evil.test' }, { EMBED_URL: 'https://embed.evil.test' })
    expect(await notice.noticeNetTargetDrift(deps)).toEqual([])
    rec.stored = null
    expect(await notice.noticeNetTargetDrift(deps)).toEqual(['EMBED_URL'])
    expect(rec.notices).toHaveLength(1)
  })

  it('a changed host: ONE notice with the key and both origins, then silence', async () => {
    const { rec, deps } = harness({ OLLAMA_URL: 'http://localhost:11434', EMBED_URL: '(nincs)' }, { OLLAMA_URL: 'http://evil.test:11434', EMBED_URL: '(nincs)' })
    expect(await notice.noticeNetTargetDrift(deps)).toEqual(['OLLAMA_URL'])
    expect(rec.notices).toHaveLength(1)
    expect(rec.notices[0]).toContain('OLLAMA_URL: http://localhost:11434 -> http://evil.test:11434')
    expect(rec.notices[0]).not.toContain('EMBED_URL')
    expect(await notice.noticeNetTargetDrift(deps)).toEqual([])
    expect(rec.notices).toHaveLength(1)
  })

  it('a scheme step (https -> http) and a port change on the same host are told; a path change is not', async () => {
    const was = notice.originOf('https://api.example.test/v1')
    for (const to of ['http://api.example.test/v1', 'https://api.example.test:8443/v1']) {
      const { rec, deps } = harness({ AGENT_API_ORIGIN: was }, { AGENT_API_ORIGIN: notice.originOf(to) })
      expect(await notice.noticeNetTargetDrift(deps)).toEqual(['AGENT_API_ORIGIN'])
      expect(rec.notices).toHaveLength(1)
    }
    const { rec, deps } = harness({ AGENT_API_ORIGIN: was }, { AGENT_API_ORIGIN: notice.originOf('https://api.example.test/v2/other?x=1') })
    expect(await notice.noticeNetTargetDrift(deps)).toEqual([])
    expect(rec.notices).toEqual([])
  })

  it('an undelivered notice is not recorded, so the next boot tells again', async () => {
    const { rec, deps } = harness({ AGENT_API_ORIGIN: '(nincs)' }, { AGENT_API_ORIGIN: 'https://other.test' })
    rec.sent = false
    await notice.noticeNetTargetDrift(deps)
    expect(rec.stored).toEqual({ AGENT_API_ORIGIN: '(nincs)' })
    rec.sent = true
    await notice.noticeNetTargetDrift(deps)
    expect(rec.notices).toHaveLength(2)
    expect(rec.stored).toEqual({ AGENT_API_ORIGIN: 'https://other.test' })
  })

  it('a key new to the record: recorded silently at its default, told when off it', async () => {
    const a = harness({ OLLAMA_URL: 'http://localhost:11434' }, { OLLAMA_URL: 'http://localhost:11434', EMBED_URL: '(nincs)' })
    expect(await notice.noticeNetTargetDrift(a.deps)).toEqual([])
    expect(a.rec.notices).toEqual([])
    expect(a.rec.stored).toEqual({ OLLAMA_URL: 'http://localhost:11434', EMBED_URL: '(nincs)' })
    const b = harness({ OLLAMA_URL: 'http://localhost:11434' }, { OLLAMA_URL: 'http://localhost:11434', EMBED_URL: 'https://x.test' })
    expect(await notice.noticeNetTargetDrift(b.deps)).toEqual(['EMBED_URL'])
    expect(b.rec.notices[0]).toContain('EMBED_URL: https://x.test (első rögzítés, nem alapérték)')
  })

  it('the record file is on the db-write-gate protected list', async () => {
    // @ts-expect-error -- plain .mjs hook script, no types
    const gate = await import('../../scripts/hooks/db-write-gate.mjs')
    expect(gate.PROTECTED_INSTALL_PATHS.map((t: { rel?: string }) => t.rel)).toContain('store/.net-target-hosts.json')
  })

  it('the boot starts the check', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const src = readFileSync(join(__dirname, '..', 'index.ts'), 'utf-8')
    expect(src).toMatch(/\n\s+void noticeNetTargetDrift\(\)\n/)
  })
})
