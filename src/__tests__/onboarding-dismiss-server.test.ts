// ONBOARDNOTG1108 (b): the setup wizard's close ("x") is remembered on the machine, not only in the browser. The
// dashboard kept it in localStorage, which is bound to the origin; the Bridge opens the dashboard on a new local tunnel
// port on every connect, so the close was lost and the wizard came back on every Bridge open. The routes and the status
// field are measured here on a throwaway store; the dashboard's side is the extracted web/app.js block below.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, existsSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

const H = vi.hoisted(() => ({ root: '' }))
vi.mock('../config.js', async (orig) => {
  const a = await orig<typeof import('../config.js')>()
  return { ...a, PROJECT_ROOT: H.root, STORE_DIR: `${H.root}/store-dir`, CHANNEL_PROVIDER: 'telegram' as const }
})
vi.mock('node:os', async (orig) => {
  const a = await orig<typeof import('node:os')>()
  const homedir = () => `${H.root}/fakehome`
  return { ...a, homedir, default: { ...a, homedir } }
})

const tmpRoot = mkdtempSync(join(tmpdir(), 'onb-dismiss-'))
H.root = tmpRoot
mkdirSync(join(tmpRoot, 'fakehome'), { recursive: true })
// The status probes must not read the host's tmux: a fake that knows no session.
const binDir = join(tmpRoot, 'bin')
mkdirSync(binDir, { recursive: true })
writeFileSync(join(binDir, 'tmux'), '#!/bin/sh\nexit 1\n')
chmodSync(join(binDir, 'tmux'), 0o755)
const origPath = process.env.PATH
process.env.PATH = `${binDir}:${origPath ?? ''}`

const { tryHandleOnboarding, onboardingDismissedOnServer } = await import('../web/routes/onboarding.js')
const FLAG = join(tmpRoot, 'store-dir', '.onboarding-dismissed')

// The Keychain probe would answer from the host's own Claude login on macOS: the route sees Linux.
const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
beforeAll(() => { Object.defineProperty(process, 'platform', { ...realPlatform, value: 'linux' }) })
afterAll(() => {
  Object.defineProperty(process, 'platform', realPlatform)
  process.env.PATH = origPath
  rmSync(tmpRoot, { recursive: true, force: true })
})

async function call(method: string, path: string, auth?: unknown) {
  let status = 0
  let out = ''
  const req = Object.assign(Readable.from([]), { headers: {} })
  const res = { setHeader() {}, writeHead(s: number) { status = s }, end(b?: string) { out = b ?? '' } }
  const url = new URL(`http://localhost${path}`)
  const handled = await tryHandleOnboarding({ req, res, path: url.pathname, method, url, auth } as any)
  return { handled, status, json: out ? JSON.parse(out) : null }
}
const OWNER = { kind: 'session', user: 'owner' }
// The shared token with no owner cookie beside it, and a bare full Bridge key: neither is the owner (mayActAsOwner).
const NOT_OWNER = [{ kind: 'token' }, { kind: 'device', scope: 'full', device: 'Bridge' }, { kind: 'device', scope: 'operator', device: 'Op' }]

describe('the wizard close on the machine (ONBOARDNOTG1108 b)', () => {
  it('a fresh install: no flag, the status says dismissed: false and still needs the wizard', async () => {
    expect(existsSync(FLAG)).toBe(false)
    const r = await call('GET', '/api/onboarding/status')
    expect(r.status).toBe(200)
    expect(r.json.dismissed).toBe(false)
    expect(r.json.needsOnboarding).toBe(true)
  })

  it('a caller that is not the owner sets nothing (403, no flag)', async () => {
    for (const auth of NOT_OWNER) {
      const r = await call('POST', '/api/onboarding/dismiss', auth)
      expect([JSON.stringify(auth), r.status, r.json.code]).toEqual([JSON.stringify(auth), 403, 'owner_session_required'])
    }
    expect(existsSync(FLAG)).toBe(false)
    expect((await call('POST', '/api/onboarding/dismiss')).status).toBe(403)
  })

  it('the owner closes the wizard: the flag is written (0600), and the status says dismissed: true on any origin', async () => {
    const r = await call('POST', '/api/onboarding/dismiss', OWNER)
    expect(r.status).toBe(200)
    expect(r.json).toEqual({ ok: true, dismissed: true })
    expect(existsSync(FLAG)).toBe(true)
    expect(statSync(FLAG).mode & 0o777).toBe(0o600)
    expect(Object.keys(JSON.parse(readFileSync(FLAG, 'utf-8')))).toEqual(['dismissedAt'])
    expect(onboardingDismissedOnServer()).toBe(true)
    const s = await call('GET', '/api/onboarding/status')
    expect(s.json.dismissed).toBe(true)
    // the setup itself is still unfinished: the flag hides the wizard, it does not fake the steps
    expect(s.json.needsOnboarding).toBe(true)
    // a second close is idempotent
    expect((await call('POST', '/api/onboarding/dismiss', OWNER)).json).toEqual({ ok: true, dismissed: true })
  })

  it('a caller that is not the owner clears nothing either', async () => {
    for (const auth of NOT_OWNER) expect((await call('DELETE', '/api/onboarding/dismiss', auth)).status).toBe(403)
    expect(existsSync(FLAG)).toBe(true)
  })

  it('the owner reopens the wizard: DELETE clears the flag (and again without one)', async () => {
    expect((await call('DELETE', '/api/onboarding/dismiss', OWNER)).json).toEqual({ ok: true, dismissed: false })
    expect(existsSync(FLAG)).toBe(false)
    expect((await call('GET', '/api/onboarding/status')).json.dismissed).toBe(false)
    expect((await call('DELETE', '/api/onboarding/dismiss', OWNER)).json).toEqual({ ok: true, dismissed: false })
  })

  it('other methods on the path are not this route', async () => {
    expect((await call('GET', '/api/onboarding/dismiss', OWNER)).handled).toBe(false)
    expect((await call('PUT', '/api/onboarding/dismiss', OWNER)).handled).toBe(false)
  })
})

// The dashboard side: the block from ONBOARDING_DISMISS_KEY to initOnboarding, run with a fake fetch, localStorage and
// document. Each "page load" is a fresh evaluation with its own localStorage, as on a new Bridge tunnel origin.
const APP = readFileSync(join(__dirname, '..', '..', 'web', 'app.js'), 'utf-8')
const BLOCK = (() => {
  const from = APP.indexOf("const ONBOARDING_DISMISS_KEY = 'mvOnboardingDismissed'")
  const to = APP.indexOf('async function refreshOnboarding()')
  if (from < 0 || to < from) throw new Error('the onboarding dismiss block moved in web/app.js')
  return APP.slice(from, to)
})()

function page(server: { dismissed: boolean; needsOnboarding?: boolean; refuse?: boolean }, stored: Record<string, string> = {}) {
  const calls: string[] = []
  const rendered: unknown[] = []
  const store = { ...stored }
  const localStorage = { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v }, removeItem: (k: string) => { delete store[k] } }
  const overlay = { hidden: false, classList: { remove() {}, add() {} } }
  const document = { getElementById: () => overlay, body: { style: { overflow: 'hidden' } } }
  const fetch = async (u: string, o?: { method?: string }) => {
    calls.push(`${o?.method ?? 'GET'} ${u}`)
    if (u === '/api/onboarding/dismiss') {
      if (server.refuse) return { ok: false, status: 403, json: async () => ({}) }
      server.dismissed = o?.method === 'POST'
      return { ok: true, status: 200, json: async () => ({ ok: true, dismissed: server.dismissed }) }
    }
    return { ok: true, json: async () => ({}) }
  }
  const fetchOnboardingStatus = async () => { calls.push('GET status'); return { needsOnboarding: server.needsOnboarding ?? true, dismissed: server.dismissed } }
  const fetchOnboardingAuth = async () => ({})
  const renderOnboarding = (s: unknown) => { rendered.push(s) }
  const api = new Function('localStorage', 'document', 'fetch', 'fetchOnboardingStatus', 'fetchOnboardingAuth', 'renderOnboarding',
    `${BLOCK}\nreturn { initOnboarding, dismissOnboarding, undismissOnboarding, onboardingDismissed }`)(
    localStorage, document, fetch, fetchOnboardingStatus, fetchOnboardingAuth, renderOnboarding) as {
    initOnboarding: () => Promise<void>; dismissOnboarding: () => void; undismissOnboarding: () => void; onboardingDismissed: () => boolean
  }
  return { api, calls, rendered, store, overlay }
}
const settle = () => new Promise((r) => setTimeout(r, 0))

describe('the dashboard reads and writes the machine flag (ONBOARDNOTG1108 b)', () => {
  it('THE BUG: a new origin (empty localStorage) with the machine flag set does not open the wizard', async () => {
    const p = page({ dismissed: true })
    await p.api.initOnboarding()
    expect(p.rendered).toEqual([])
    expect(p.api.onboardingDismissed()).toBe(true)
  })

  it('no flag anywhere: the wizard opens as before', async () => {
    const p = page({ dismissed: false })
    await p.api.initOnboarding()
    expect(p.rendered.length).toBe(1)
  })

  it('the close writes the machine flag and the browser one; the next Bridge open (a new origin) stays closed', async () => {
    const server = { dismissed: false }
    const first = page(server)
    await first.api.initOnboarding()
    first.api.dismissOnboarding()
    await settle()
    expect(first.calls).toContain('POST /api/onboarding/dismiss')
    expect(first.store.mvOnboardingDismissed).toBe('1')
    expect(first.overlay.hidden).toBe(true)
    const next = page(server)
    await next.api.initOnboarding()
    expect(next.rendered).toEqual([])
  })

  it('a refused close (no owner session yet) still holds on this origin, as before', async () => {
    const server = { dismissed: false, refuse: true }
    const first = page(server)
    first.api.dismissOnboarding()
    await settle()
    const sameOrigin = page(server, first.store)
    await sameOrigin.api.initOnboarding()
    expect(sameOrigin.rendered).toEqual([])
    expect(sameOrigin.calls).not.toContain('GET status')
  })

  it('the owner reopens it: DELETE, both records cleared, and the next load opens the wizard again', async () => {
    const server = { dismissed: true }
    const p = page(server, { mvOnboardingDismissed: '1' })
    p.api.undismissOnboarding()
    await settle()
    expect(p.calls).toContain('DELETE /api/onboarding/dismiss')
    expect(p.store.mvOnboardingDismissed).toBeUndefined()
    expect(p.api.onboardingDismissed()).toBe(false)
    const next = page(server)
    await next.api.initOnboarding()
    expect(next.rendered.length).toBe(1)
  })

  it('a finished setup: no wizard whatever the flag says', async () => {
    const p = page({ dismissed: false, needsOnboarding: false })
    await p.api.initOnboarding()
    expect(p.rendered).toEqual([])
  })
})
