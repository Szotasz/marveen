// The filler of a vault web login (VAULTLOGIN1112). It runs in the DASHBOARD process: it attaches to the calling
// agent's own browser over CDP (127.0.0.1), opens a new tab, checks the origin, types the username and the password,
// submits, classifies the result, clears any password field still on the page, and closes the tab unless a second
// factor is waiting for the owner. The password reaches the page only here: never an argv, a log line, a response or
// the agent's process.
//
// The limit, stated (owner decision A, Samu 83561): the agent's own browser tool can read the page while the password
// is in the field: from the fill to the clearing right after the submit (the first request the submit sends, at most
// SUBMIT_GRACE_MS). The guarantee is that the model does not get the password through its own path; it is not absolute.
//
// Errors are never passed on: a Playwright error message can quote what it was doing, so every failure is reduced to
// an outcome here, and only the outcome leaves this module.
import type { Browser, Frame, Locator, Page } from 'playwright-core'
import type { LoginOutcome } from './vault-web-logins.js'

export interface FillRequest {
  cdpEndpoint: string
  origin: string
  loginUrl: string
  username: string
  password: string
  userSelector?: string | null
  passSelector?: string | null
  /** Upper bound for the whole attempt. */
  timeoutMs?: number
}

export interface FillResult {
  outcome: LoginOutcome
}

/**
 * Whether the dashboard runs with DEBUG set at all. Playwright's debug log (DEBUG=pw:*, *, pw*, ...) writes the typed
 * text to stderr, and the debug package's pattern language is not imitated here: any non-empty DEBUG refuses the run
 * (Samu 83645, Dani #3071 B2). A live dashboard has no reason to run with DEBUG.
 */
export function playwrightDebugOn(debug: string | undefined): boolean {
  return (debug ?? '').trim() !== ''
}

/**
 * The request a submit sends: a page load, or a non-GET XHR/fetch (a form POST, an XHR login). A favicon, an image or a
 * beacon is not one (Dani #3071): emptying the field on those would hand a slower script handler an empty password.
 */
export function isSubmitRequest(resourceType: string, method: string): boolean {
  return resourceType === 'document' || ((resourceType === 'xhr' || resourceType === 'fetch') && method !== 'GET')
}

/** How long the filler waits after the submit for the submit's request before it empties the field. */
export const SUBMIT_GRACE_MS = 300
const PASSWORD_SELECTOR = 'input[type="password"]'
const USERNAME_SELECTOR = [
  'input[autocomplete="username"]',
  'input[type="email"]',
  'input[name*="user" i]',
  'input[name*="email" i]',
  'input[name*="login" i]',
  'input[id*="user" i]',
  'input[id*="email" i]',
  'input[type="text"]',
].join(', ')
const OTP_SELECTOR = [
  'input[autocomplete="one-time-code"]',
  'input[name*="otp" i]',
  'input[name*="totp" i]',
  'input[id*="otp" i]',
  'input[name*="2fa" i]',
  'iframe[src*="recaptcha"]',
  'iframe[src*="hcaptcha"]',
  'iframe[src*="challenges.cloudflare.com"]',
].join(', ')
const OTP_TEXT = /two[- ]factor|2fa|verification code|security code|one[- ]time|ellenőrző kód|biztonsági kód|hitelesítő kód|kétlépcsős|captcha/i
const ERROR_TEXT = /incorrect|invalid|wrong|failed|not match|hibás|helytelen|érvénytelen|nem megfelelő|sikertelen/i

function originOf(url: string): string | null {
  try { return new URL(url).origin } catch { return null }
}

/** The first VISIBLE match in the frame, or null. */
async function firstVisible(frame: Frame, selector: string): Promise<Locator | null> {
  const all = frame.locator(selector)
  const n = Math.min(await all.count().catch(() => 0), 20)
  for (let i = 0; i < n; i++) {
    const l = all.nth(i)
    if (await l.isVisible().catch(() => false)) return l
  }
  return null
}

/**
 * Where the password field is, judged by frame origin: a field in a frame of the entry's origin (the top page, or a
 * same-origin frame) is usable; a field only in a frame of another origin is refused, never filled.
 */
async function findPasswordField(page: Page, origin: string, selector: string): Promise<{ field: Locator; frame: Frame } | 'foreign' | null> {
  let foreign = false
  for (const frame of page.frames()) {
    const field = await firstVisible(frame, selector)
    if (!field) continue
    if (originOf(frame.url()) === origin) return { field, frame }
    foreign = true
  }
  return foreign ? 'foreign' : null
}

/** Empty every password field of the page, in every frame. Best effort, never throws. */
async function clearPasswordFields(page: Page): Promise<void> {
  for (const frame of page.frames()) {
    const fields = frame.locator(PASSWORD_SELECTOR)
    const n = await fields.count().catch(() => 0)
    for (let i = 0; i < n; i++) await fields.nth(i).fill('').catch(() => undefined)
  }
}

async function settle(page: Page, ms: number): Promise<void> {
  await page.waitForLoadState('domcontentloaded', { timeout: ms }).catch(() => undefined)
  await page.waitForTimeout(Math.min(ms, 1500)).catch(() => undefined)
}

async function secondFactorShown(page: Page): Promise<boolean> {
  for (const frame of page.frames()) {
    if (await firstVisible(frame, OTP_SELECTOR)) return true
  }
  const text = await page.locator('body').innerText({ timeout: 2000 }).catch(() => '')
  return OTP_TEXT.test(text)
}

async function classifyAfterSubmit(page: Page, origin: string, passSelector: string): Promise<LoginOutcome> {
  if (page.isClosed()) return 'unknown'
  const top = originOf(page.url())
  const pw = await findPasswordField(page, top ?? origin, passSelector)
  if (await secondFactorShown(page)) return '2fa'
  if (pw && pw !== 'foreign') {
    const text = await page.locator('body').innerText({ timeout: 2000 }).catch(() => '')
    const alert = await page.locator('[role="alert"], .error, .alert-danger, .invalid-feedback').first().isVisible().catch(() => false)
    return alert || ERROR_TEXT.test(text) ? 'wrong' : 'unknown'
  }
  return 'success'
}

/** Attach, fill, submit, classify, clear. The browser connection is dropped at the end; the browser keeps running. */
export async function fillWebLogin(req: FillRequest, connect?: (endpoint: string, timeoutMs: number) => Promise<Browser>): Promise<FillResult> {
  const deadline = Date.now() + (req.timeoutMs ?? 45_000)
  const left = (): number => Math.max(1000, deadline - Date.now())
  const passSelector = req.passSelector || PASSWORD_SELECTOR
  const userSelector = req.userSelector || USERNAME_SELECTOR

  // Any DEBUG at all: Playwright's own debug log would write the typed text to the dashboard's stderr.
  if (playwrightDebugOn(process.env.DEBUG)) return { outcome: 'browser-unavailable' }

  let browser: Browser
  try {
    const doConnect = connect ?? (async (endpoint: string, timeout: number) => (await import('playwright-core')).chromium.connectOverCDP(endpoint, { timeout }))
    browser = await doConnect(req.cdpEndpoint, Math.min(left(), 15_000))
  } catch {
    return { outcome: 'browser-unavailable' }
  }

  let page: Page | null = null
  let keepOpen = false
  try {
    const context = browser.contexts()[0] ?? await browser.newContext()
    page = await context.newPage()
    await page.goto(req.loginUrl, { waitUntil: 'domcontentloaded', timeout: left() })
    await settle(page, Math.min(left(), 3000))
    // ORIGIN GATE: the top page, after every redirect, must be the entry's exact origin.
    if (originOf(page.url()) !== req.origin) return { outcome: 'origin-mismatch' }

    let pw = await findPasswordField(page, req.origin, passSelector)
    if (pw === 'foreign') return { outcome: 'origin-mismatch' }
    if (pw === null) {
      // A two-step login: the username first, then the password on the next view.
      const user = await firstVisible(page.mainFrame(), userSelector)
      if (!user) return { outcome: 'no-form' }
      await user.fill(req.username, { timeout: left() })
      await user.press('Enter', { timeout: left() })
      await settle(page, Math.min(left(), 5000))
      if (originOf(page.url()) !== req.origin) return { outcome: 'origin-mismatch' }
      if (await secondFactorShown(page)) { keepOpen = true; return { outcome: '2fa' } }
      pw = await findPasswordField(page, req.origin, passSelector)
      if (pw === 'foreign') return { outcome: 'origin-mismatch' }
      if (pw === null) return { outcome: 'no-form' }
    } else {
      const user = await firstVisible(pw.frame, userSelector)
      if (user) await user.fill(req.username, { timeout: left() })
    }
    // The last check before the password goes in: the field's frame is still on the entry's origin.
    if (originOf(pw.frame.url()) !== req.origin || originOf(page.url()) !== req.origin) return { outcome: 'origin-mismatch' }
    await pw.field.fill(req.password, { timeout: left() })
    // The field is emptied right after the submit, before any settling (Samu #3071 M1): a submit that does not
    // navigate (a wrong password on a script-driven page, client validation, an XHR login) would otherwise leave the
    // value in the page for the whole settle. A native submit and a script handler have sent the value by the time the
    // submit's request leaves (isSubmitRequest); without one, SUBMIT_GRACE_MS bounds the wait.
    const firstRequest = page.waitForEvent('request', { predicate: (r) => isSubmitRequest(r.resourceType(), r.method()), timeout: SUBMIT_GRACE_MS }).catch(() => null)
    await pw.field.press('Enter', { timeout: left() })
    await firstRequest
    if (!page.isClosed()) await clearPasswordFields(page)
    await settle(page, Math.min(left(), 8000))
    const outcome = await classifyAfterSubmit(page, req.origin, passSelector)
    if (outcome === '2fa') keepOpen = true
    return { outcome }
  } catch {
    return { outcome: 'unknown' }
  } finally {
    if (page && !page.isClosed()) {
      await clearPasswordFields(page)
      if (!keepOpen) await page.close().catch(() => undefined)
    }
    // Dropping the CDP connection does not stop a browser we attached to.
    await browser.close().catch(() => undefined)
  }
}
