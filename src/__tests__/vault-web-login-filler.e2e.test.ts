// VAULTLOGIN1112: the filler against a REAL Chrome and local test pages (two loopback origins). What is pinned:
//   - success: the site gets the password once, the tab is closed, the session cookie stays in the profile;
//   - origin gate: a login page that redirects to another origin, and a password field only inside a foreign-origin
//     iframe, are refused without typing anything (the other origin receives no POST at all);
//   - 2FA / captcha: the outcome is 2fa, the tab stays open for the owner, and every password field in it is EMPTY;
//   - a wrong password: the outcome is wrong, the field is emptied, the tab is closed;
//   - a two-step login (username, then password); a page with no form;
//   - leak search: the password is not in the result, and not in any file of the browser profile after the browser
//     has closed.
// Skipped (visibly) where no Chrome or Chromium is installed.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer as netServer } from 'node:net'
import { chromium, type Browser } from 'playwright-core'
import { chromeExecutable, agentBrowserArgs } from '../web/agent-browser.js'
import { fillWebLogin } from '../web/vault-web-login-filler.js'

const CHROME = chromeExecutable()
const SECRET = 'pw-' + Math.random().toString(36).slice(2) + '-Zq9'
const USER = 'probe-user'

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = netServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)) })
  })
}

const html = (title: string, body: string): string => `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`
const form = (action: string, extra = ''): string =>
  `<form action="${action}" method="post"><label>User <input name="u" autocomplete="username"></label><label>Password <input type="password" name="p"></label><button>Sign in</button></form>${extra}`

const posts: Array<{ site: 'A' | 'B'; path: string; body: string }> = []
let A = '', B = ''

function siteA(): Server {
  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    res.setHeader('content-type', 'text/html')
    if (req.method === 'POST') {
      let body = ''
      req.on('data', (d) => (body += d))
      req.on('end', () => {
        posts.push({ site: 'A', path: url.pathname, body })
        const f = new URLSearchParams(body)
        if (url.pathname === '/login') {
          if (f.get('p') === SECRET && f.get('u') === USER) { res.writeHead(303, { location: '/app', 'set-cookie': 'sid=ok; Path=/; HttpOnly' }); res.end(); return }
          res.end(html('Login', '<p role="alert">Wrong password</p>' + form('/login')))
          return
        }
        if (url.pathname === '/login-2fa') { res.end(html('Verify', '<p>Enter the verification code</p><input autocomplete="one-time-code" name="otp">')); return }
        if (url.pathname === '/login-captcha') { res.end(html('Login', form('/login-captcha', `<iframe src="${B}/recaptcha/frame"></iframe>`))); return }
        if (url.pathname === '/two-step-user') { res.end(html('Password', `<form action="/login" method="post"><input type="hidden" name="u" value="${USER}"><input type="password" name="p"><button>Go</button></form>`)); return }
        res.end(html('?', 'unknown'))
      })
      return
    }
    if (url.pathname === '/login') { res.end(html('Login', form('/login'))); return }
    if (url.pathname === '/login-2fa-page') { res.end(html('Login', form('/login-2fa'))); return }
    if (url.pathname === '/captcha') { res.end(html('Login', form('/login-captcha'))); return }
    if (url.pathname === '/redirect') { res.writeHead(302, { location: `${B}/login` }); res.end(); return }
    if (url.pathname === '/framed') { res.end(html('Framed', `<h1>Shop</h1><iframe src="${B}/login" width="600" height="300"></iframe>`)); return }
    if (url.pathname === '/two-step') { res.end(html('User', '<form action="/two-step-user" method="post"><input name="u" autocomplete="username"><button>Next</button></form>')); return }
    if (url.pathname === '/noform') { res.end(html('Nothing', '<h1>No form here</h1>')); return }
    if (url.pathname === '/app') { res.end(html('App', '<h1>Signed in</h1>')); return }
    res.end(html('Home', '<h1>Home</h1>'))
  })
}
function siteB(): Server {
  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    res.setHeader('content-type', 'text/html')
    if (req.method === 'POST') {
      let body = ''
      req.on('data', (d) => (body += d))
      req.on('end', () => { posts.push({ site: 'B', path: url.pathname, body }); res.end(html('B', 'ok')) })
      return
    }
    if (url.pathname === '/login') { res.end(html('Other origin', form('/login'))); return }
    res.end(html('B', '<p>recaptcha</p>'))
  })
}

let servers: Server[] = []
let chrome: ChildProcess | null = null
let profile = ''
let cdp = ''
let observer: Browser | null = null

async function openPages(): Promise<Array<{ url: string; passwordValues: string[] }>> {
  const out: Array<{ url: string; passwordValues: string[] }> = []
  for (const ctx of observer!.contexts()) {
    for (const p of ctx.pages()) {
      const vals: string[] = []
      for (const f of p.frames()) {
        vals.push(...await f.locator('input[type="password"]').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value)).catch(() => []))
      }
      out.push({ url: p.url(), passwordValues: vals })
    }
  }
  return out
}

const run = (path: string, extra: Partial<Parameters<typeof fillWebLogin>[0]> = {}) =>
  fillWebLogin({ cdpEndpoint: cdp, origin: A, loginUrl: `${A}${path}`, username: USER, password: SECRET, timeoutMs: 30_000, ...extra })

describe.skipIf(!CHROME)('vault web login filler against a real Chrome', () => {
  beforeAll(async () => {
    const [pa, pb, pc] = [await freePort(), await freePort(), await freePort()]
    A = `http://127.0.0.1:${pa}`
    B = `http://localhost:${pb}`
    servers = [siteA().listen(pa, '127.0.0.1'), siteB().listen(pb, '127.0.0.1')]
    profile = mkdtempSync(join(tmpdir(), 'vl-filler-profile-'))
    // The product's own launch arguments, headless here and without the sandbox (CI runners).
    const args = agentBrowserArgs(profile, pc, {}, 'darwin').filter((a) => a !== 'about:blank')
    chrome = spawn(CHROME!, [...args, '--headless=new', '--no-sandbox', 'about:blank'], { stdio: 'ignore' })
    cdp = `http://127.0.0.1:${pc}`
    for (let i = 0; i < 80; i++) {
      try { if ((await fetch(`${cdp}/json/version`)).ok) break } catch { /* not yet */ }
      await new Promise((r) => setTimeout(r, 250))
    }
    observer = await chromium.connectOverCDP(cdp)
  }, 60_000)

  afterAll(async () => {
    await observer?.close().catch(() => undefined)
    chrome?.kill('SIGTERM')
    await new Promise((r) => setTimeout(r, 1500))
    // Leak search over the closed profile: no file holds the password.
    const hits: string[] = []
    const walk = (d: string): void => {
      for (const n of readdirSync(d)) {
        const p = join(d, n)
        let st
        try { st = statSync(p) } catch { continue }
        if (st.isDirectory()) walk(p)
        else if (st.size < 20 * 1024 * 1024) { try { if (readFileSync(p).includes(SECRET)) hits.push(p) } catch { /* locked */ } }
      }
    }
    try { walk(profile) } finally { rmSync(profile, { recursive: true, force: true }) }
    for (const s of servers) s.close()
    expect(hits).toEqual([])
  }, 30_000)

  it('success: one POST with the password, the tab closed, the session cookie in the profile', async () => {
    posts.length = 0
    const r = await run('/login')
    expect(r).toEqual({ outcome: 'success' })
    expect(JSON.stringify(r)).not.toContain(SECRET)
    expect(posts.filter((p) => p.body.includes(SECRET))).toHaveLength(1)
    expect((await openPages()).filter((p) => p.url.startsWith(A))).toEqual([])
    const cookies = await observer!.contexts()[0]!.cookies(A)
    expect(cookies.map((c) => c.name)).toContain('sid')
  }, 60_000)

  it('origin gate: a redirect to another origin is refused, nothing typed, no POST anywhere', async () => {
    posts.length = 0
    expect(await run('/redirect')).toEqual({ outcome: 'origin-mismatch' })
    expect(posts).toEqual([])
  }, 60_000)

  it('origin gate: a password field only in a foreign-origin iframe is refused, nothing typed', async () => {
    posts.length = 0
    expect(await run('/framed')).toEqual({ outcome: 'origin-mismatch' })
    expect(posts).toEqual([])
    for (const p of await openPages()) expect(p.passwordValues.every((v) => v === '')).toBe(true)
  }, 60_000)

  it('2FA: the outcome is 2fa and the tab stays open for the owner', async () => {
    const r = await run('/login-2fa-page')
    expect(r).toEqual({ outcome: '2fa' })
    expect((await openPages()).some((p) => p.url === `${A}/login-2fa`)).toBe(true)
  }, 60_000)

  it('captcha on the login page: 2fa, the tab stays open, and its password field is EMPTY', async () => {
    const r = await run('/captcha')
    expect(r).toEqual({ outcome: '2fa' })
    const open = (await openPages()).filter((p) => p.url === `${A}/login-captcha`)
    expect(open.length).toBeGreaterThan(0)
    for (const p of open) {
      expect(p.passwordValues.length).toBeGreaterThan(0)
      expect(p.passwordValues.every((v) => v === '')).toBe(true)
    }
  }, 60_000)

  it('a wrong password: the outcome is wrong, the tab is closed, nothing left in a field', async () => {
    posts.length = 0
    const r = await run('/login', { password: 'not-the-password' })
    expect(r).toEqual({ outcome: 'wrong' })
    expect(posts).toHaveLength(1)
    for (const p of await openPages()) expect(p.passwordValues.every((v) => v === '')).toBe(true)
    expect((await openPages()).filter((p) => p.url === `${A}/login`)).toEqual([])
  }, 60_000)

  it('a two-step login: the username first, then the password', async () => {
    posts.length = 0
    expect(await run('/two-step')).toEqual({ outcome: 'success' })
    expect(posts.map((p) => p.path)).toEqual(['/two-step-user', '/login'])
  }, 60_000)

  it('a page with no login form: no-form, nothing typed', async () => {
    posts.length = 0
    expect(await run('/noform')).toEqual({ outcome: 'no-form' })
    expect(posts).toEqual([])
  }, 60_000)

  it('no browser on the endpoint: browser-unavailable', async () => {
    const dead = await freePort()
    expect(await fillWebLogin({ cdpEndpoint: `http://127.0.0.1:${dead}`, origin: A, loginUrl: `${A}/login`, username: USER, password: SECRET, timeoutMs: 5000 }))
      .toEqual({ outcome: 'browser-unavailable' })
  }, 30_000)
})
