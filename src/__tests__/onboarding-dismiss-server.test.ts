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

function page(server: { dismissed: boolean; needsOnboarding?: boolean; refuse?: boolean; statusFails?: boolean; authBannerShown?: boolean }, stored: Record<string, string> = {}) {
  const calls: string[] = []
  const rendered: unknown[] = []
  const store = { ...stored }
  const localStorage = { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v }, removeItem: (k: string) => { delete store[k] } }
  const overlay = { hidden: false, classList: { remove() {}, add() {} } }
  // DOCKERFIXES1109 (2): the setup-resume banner and its two buttons are separate elements; an unknown id is null.
  const button = () => {
    const listeners: Array<() => unknown> = []
    return { addEventListener: (_t: string, f: () => unknown) => { listeners.push(f) }, click: async () => { for (const f of listeners) await f() } }
  }
  const banner = { hidden: true }
  const goBtn = button()
  const closeBtn = button()
  // The follow-up's two: the auth banner (shown or not, per case) and the resume banner's message line.
  const authBanner = { hidden: !server.authBannerShown }
  const msg = { hidden: true, textContent: '' }
  const els: Record<string, unknown> = { onboardingOverlay: overlay, setupResumeBanner: banner, setupResumeGoBtn: goBtn, setupResumeDismiss: closeBtn, authSetupBanner: authBanner, setupResumeMsg: msg }
  const t = (k: string) => `T(${k})`
  const document = { getElementById: (id: string) => els[id] ?? null, body: { style: { overflow: 'hidden' } } }
  const session: Record<string, string> = {}
  const sessionStorage = { getItem: (k: string) => session[k] ?? null, setItem: (k: string, v: string) => { session[k] = v } }
  const fetch = async (u: string, o?: { method?: string }) => {
    calls.push(`${o?.method ?? 'GET'} ${u}`)
    if (u === '/api/onboarding/dismiss') {
      if (server.refuse) return { ok: false, status: 403, json: async () => ({}) }
      server.dismissed = o?.method === 'POST'
      return { ok: true, status: 200, json: async () => ({ ok: true, dismissed: server.dismissed }) }
    }
    return { ok: true, json: async () => ({}) }
  }
  // The real fetchOnboardingStatus returns null on any failure (offline, a 5xx, bad JSON).
  const fetchOnboardingStatus = async () => { calls.push('GET status'); return server.statusFails ? null : { needsOnboarding: server.needsOnboarding ?? true, dismissed: server.dismissed } }
  const fetchOnboardingAuth = async () => ({})
  const renderOnboarding = (s: unknown) => { rendered.push(s) }
  const api = new Function('localStorage', 'sessionStorage', 'document', 'fetch', 'fetchOnboardingStatus', 'fetchOnboardingAuth', 'renderOnboarding', 't',
    `${BLOCK}\nreturn { initOnboarding, dismissOnboarding, undismissOnboarding, onboardingDismissed, showSetupResumeBanner }`)(
    localStorage, sessionStorage, document, fetch, fetchOnboardingStatus, fetchOnboardingAuth, renderOnboarding, t) as {
    initOnboarding: () => Promise<void>; dismissOnboarding: () => void; undismissOnboarding: () => void; onboardingDismissed: () => boolean
    showSetupResumeBanner: () => Promise<void>
  }
  return { api, calls, rendered, store, overlay, banner, goBtn, closeBtn, session, authBanner, msg, server }
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
    // DOCKERFIXES1109 (2): the status IS read now (it used to be skipped on a local close), on purpose: the
    // setup-resume banner needs needsOnboarding to know whether there is anything to come back to. The wizard itself
    // still does not open (rendered stays empty), which is what this case is about.
    expect(sameOrigin.calls).toContain('GET status')
    expect(sameOrigin.banner.hidden).toBe(false)
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

// DOCKERFIXES1109 (2): measured on the Docker trial (2026-11-08), whoever closed the wizard after creating the login had
// no way back (the auth banner shows only while no login exists). The setup-resume banner is that way back.
describe('the setup-resume banner (DOCKERFIXES1109)', () => {
  it('closed on the machine, setup unfinished: the banner shows and the wizard stays closed', async () => {
    const p = page({ dismissed: true })
    await p.api.initOnboarding()
    expect(p.banner.hidden).toBe(false)
    expect(p.rendered).toEqual([])
  })

  it('closed, but the setup is finished: no banner', async () => {
    const p = page({ dismissed: true, needsOnboarding: false })
    await p.api.initOnboarding()
    expect(p.banner.hidden).toBe(true)
  })

  it('not closed, setup unfinished: the wizard opens, no banner', async () => {
    const p = page({ dismissed: false })
    await p.api.initOnboarding()
    expect(p.rendered.length).toBe(1)
    expect(p.banner.hidden).toBe(true)
  })

  it('asked directly while the wizard is not closed, the banner stays hidden (no "come back" to an open wizard)', async () => {
    const p = page({ dismissed: false })
    await p.api.showSetupResumeBanner()
    expect(p.banner.hidden).toBe(true)
  })

  it('closing the wizard brings the banner up', async () => {
    const p = page({ dismissed: false })
    await p.api.initOnboarding()
    p.api.dismissOnboarding()
    await settle()
    expect(p.banner.hidden).toBe(false)
  })

  it('its button reopens the wizard and clears the close on the machine (DELETE)', async () => {
    const server = { dismissed: true }
    const p = page(server, { mvOnboardingDismissed: '1' })
    await p.api.initOnboarding()
    await p.goBtn.click()
    await settle()
    expect(p.calls).toContain('DELETE /api/onboarding/dismiss')
    expect(p.rendered.length).toBe(1)
    expect(p.banner.hidden).toBe(true)
    expect(p.api.onboardingDismissed()).toBe(false)
  })

  it('its x hides it for this browser session only, and does not touch the wizard flags', async () => {
    const p = page({ dismissed: true })
    await p.api.initOnboarding()
    await p.closeBtn.click()
    expect(p.banner.hidden).toBe(true)
    expect(p.session.mvSetupResumeHidden).toBe('1')
    await p.api.showSetupResumeBanner()
    expect(p.banner.hidden).toBe(true)
    expect(p.calls).not.toContain('DELETE /api/onboarding/dismiss')
    expect(p.calls).not.toContain('POST /api/onboarding/dismiss')
  })

  // Follow-up, Dani's review of #2649.
  it('point 1: an unreadable status on the button keeps the banner, with a message, and opens or clears nothing', async () => {
    const p = page({ dismissed: true })
    await p.api.initOnboarding()
    expect(p.banner.hidden).toBe(false)
    p.server.statusFails = true
    await p.goBtn.click()
    await settle()
    expect(p.banner.hidden).toBe(false)
    expect(p.msg.hidden).toBe(false)
    expect(p.msg.textContent).toBe('T(onboarding.resume.status_error)')
    expect(p.rendered).toEqual([])
    expect(p.calls).not.toContain('DELETE /api/onboarding/dismiss')
    // The next try, with the status readable again, clears the message and opens the wizard.
    p.server.statusFails = false
    await p.goBtn.click()
    await settle()
    expect(p.msg.hidden).toBe(true)
    expect(p.rendered.length).toBe(1)
  })

  it('point 2: while the auth banner is shown (no login yet) this one stays hidden; it is the auth banner\'s turn', async () => {
    const p = page({ dismissed: true, authBannerShown: true })
    await p.api.initOnboarding()
    expect(p.banner.hidden).toBe(true)
    // Closing the auth banner must not close the last way back: the re-check brings this one up.
    p.authBanner.hidden = true
    await p.api.showSetupResumeBanner()
    expect(p.banner.hidden).toBe(false)
  })

  it('point 2, the other side: the auth banner re-checks this one when it shows and when it is closed', () => {
    const init = APP.slice(APP.indexOf('async function initAuthBanner()'), APP.indexOf('function wireAuthBanner()'))
    expect(init).toContain('if (show) showSetupResumeBanner()')
    const wire = APP.slice(APP.indexOf('function wireAuthBanner()'), APP.indexOf("document.addEventListener('DOMContentLoaded', () => {\n  wireAuthBanner()"))
    expect(wire).toMatch(/localStorage\.setItem\(AUTH_BANNER_DISMISS_KEY, '1'\)[\s\S]{0,200}banner\.hidden = true[\s\S]{0,200}showSetupResumeBanner\(\)/)
  })
})
