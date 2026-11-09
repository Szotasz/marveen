// ONBOARDOWNERPW1107 browser verification: on a fresh install the onboarding wizard's FIRST step is the dashboard
// login (owner decision, 11-07), so a Bridge window (a full device key) never stops on the owner gate of a later step.
// Static web/ with the API answered by a small stateful stub (a second dashboard on this host would take the live
// one's lock); the server side of the same chain is measured on a real WEB_ONLY instance in the PR, and the gates by
// the unit tests. This file proves what the page does with those answers.
import { test, expect, type Page } from '@playwright/test'

const KEY = 'a'.repeat(64)
type Kind = 'device' | 'operator' | 'token'
interface Srv { users: number; disabledOnly: boolean; session: boolean; kind: Kind; logins: string[]; creates: string[] }

function authStatus(s: Srv) {
  const out: Record<string, unknown> = {
    authenticated: true,
    method: s.session && s.kind === 'token' ? 'token' : s.kind === 'operator' ? 'device' : s.kind,
    login_available: s.users > 0 && !s.disabledOnly,
    setup_required: s.users === 0 && !s.disabledOnly,
  }
  // like statusPayload: only a caller that could hold the owner session gets owner_session
  if (s.kind !== 'operator') out.owner_session = s.session
  return out
}

async function open(page: Page, srv: Srv, lang: 'hu' | 'en') {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) })
  // the catch-all FIRST: Playwright gives the last matching handler priority
  await page.route('**/api/**', (r) => r.fulfill(json({})))
  await page.route('**/api/onboarding/status', (r) => r.fulfill(json({ needsOnboarding: true, identityConfirmed: false, claudeAuthPresent: false, agentsRunning: false, channelConfigured: false, paired: false })))
  await page.route('**/api/auth/status', (r) => r.fulfill(json(authStatus(srv))))
  await page.route('**/api/auth/users', async (r) => {
    const b = JSON.parse(r.request().postData() || '{}')
    srv.creates.push(b.username)
    if (srv.users > 0) return r.fulfill(json({ code: 'owner_session_required', error: 'This needs the dashboard login (an owner session).' }, 403))
    srv.users = 1
    return r.fulfill(json({ ok: true, user: { id: 1, username: b.username } }, 201))
  })
  await page.route('**/api/auth/login', async (r) => {
    const b = JSON.parse(r.request().postData() || '{}')
    srv.logins.push(b.username)
    if (srv.users === 0 || b.password !== 'good-password-1') return r.fulfill(json({ error: 'Invalid credentials' }, 401))
    srv.session = true
    return r.fulfill(json({ ok: true, user: b.username }))
  })
  await page.route('**/api/onboarding/identity', (r) => r.fulfill(srv.session
    ? json({ ok: true })
    : json({ code: 'owner_session_required', error: 'Changing the owner and agent names needs the dashboard login (an owner session).' }, 403)))
  await page.addInitScript(([l, k]) => {
    try {
      localStorage.setItem('marveen.lang', l)
      if (!sessionStorage.getItem('onb-seeded')) {
        localStorage.setItem('marveen-dashboard-token', k)
        sessionStorage.setItem('onb-seeded', '1')
      }
    } catch { /* ignore */ }
  }, [lang, KEY] as const)
  await page.goto('/index.html')
  await page.locator('#onboardingOverlay.active').waitFor()
  return errors
}
const activeStep = (page: Page) => page.locator('#onboardingSteps .onboarding-step.active').getAttribute('data-ostep')
const wizardOpen = (page: Page) => page.locator('#onboardingOverlay.active').count()
const fresh = (kind: Kind = 'device'): Srv => ({ users: 0, disabledOnly: false, session: false, kind, logins: [], creates: [] })

for (const lang of ['hu', 'en'] as const) {
  test(`fresh Bridge window (${lang}): step 1 creates the login, signs in, and the wizard goes on to the name step`, async ({ page }) => {
    const srv = fresh()
    const errors = await open(page, srv, lang)
    expect(await activeStep(page)).toBe('1')
    await expect(page.locator('#onboardingSteps .onboarding-step')).toHaveCount(5)
    await expect(page.locator('#onbLoginCreateBtn')).toHaveText(lang === 'hu' ? 'Létrehozás és belépés' : 'Create and sign in')
    await page.screenshot({ path: `test-results/onboardownerpw1107-step1-${lang}.png` })
    await page.locator('#onbLoginUser').fill('szabolcs')
    await page.locator('#onbLoginPass').fill('good-password-1')
    await page.locator('#onbLoginPass2').fill('good-password-1')
    await Promise.all([page.waitForEvent('load'), page.locator('#onbLoginCreateBtn').click()])
    await page.locator('#onboardingOverlay.active').waitFor()
    await expect.poll(() => activeStep(page)).toBe('2')
    await expect(page.locator('#onbIdentityBtn')).toBeVisible()
    expect(srv.creates).toEqual(['szabolcs'])
    expect(srv.logins).toEqual(['szabolcs'])
    expect(await page.evaluate(() => localStorage.getItem('marveen-dashboard-token'))).toBe(KEY)
    await page.screenshot({ path: `test-results/onboardownerpw1107-step2-${lang}.png` })
    expect(errors, errors.join(' | ')).toEqual([])
  })
}

test('an owner refusal on the name step goes back to the login step; Settings never opens, no second login form', async ({ page }) => {
  const srv = { ...fresh(), users: 1, session: true }
  const errors = await open(page, srv, 'hu')
  expect(await activeStep(page)).toBe('2')
  srv.session = false // the session ended meanwhile
  await page.locator('#onbAgentName').fill('Marveen')
  await page.locator('#onbOwnerName').fill('Szabolcs')
  await page.locator('#onbIdentityBtn').click()
  await expect.poll(() => activeStep(page)).toBe('1')
  await expect(page.locator('#onbLoginSignInBtn')).toBeVisible()
  expect(await wizardOpen(page)).toBe(1)
  await expect(page.locator('#mv-login-overlay')).toHaveCount(0)
  expect(await page.evaluate(() => document.querySelector('.sb-link.active')?.getAttribute('data-page') ?? null)).not.toBe('settings')
  expect(errors, errors.join(' | ')).toEqual([])
})

test('an existing login, a wrong password: the error shows, the Bridge key stays, no full-screen login', async ({ page }) => {
  const srv = { ...fresh(), users: 1 }
  const errors = await open(page, srv, 'hu')
  expect(await activeStep(page)).toBe('1')
  await page.locator('#onbLoginUser').fill('szabolcs')
  await page.locator('#onbLoginPass').fill('wrong')
  await page.locator('#onbLoginSignInBtn').click()
  await expect(page.locator('#onbMsg')).toHaveText('Hibás belépési adatok.')
  await expect(page.locator('#onbLoginPass')).toHaveValue('')
  expect(await page.evaluate(() => localStorage.getItem('marveen-dashboard-token'))).toBe(KEY)
  await expect(page.locator('#mv-login-overlay')).toHaveCount(0)
  await page.screenshot({ path: 'test-results/onboardownerpw1107-signin-error-hu.png' })
  await page.locator('#onbLoginPass').fill('good-password-1')
  await Promise.all([page.waitForEvent('load'), page.locator('#onbLoginSignInBtn').click()])
  await page.locator('#onboardingOverlay.active').waitFor()
  await expect.poll(() => activeStep(page)).toBe('2')
  expect(errors, errors.join(' | ')).toEqual([])
})

test('an operator key gets no login step; its refusal is shown as text and nothing jumps (Dani 72424 2)', async ({ page }) => {
  const srv = fresh('operator')
  const errors = await open(page, srv, 'en')
  expect(await activeStep(page)).toBe('2')
  await page.locator('#onbAgentName').fill('Marveen')
  await page.locator('#onbOwnerName').fill('Owner')
  await page.locator('#onbIdentityBtn').click()
  await expect(page.locator('#onbMsg')).toContainText('needs the dashboard login')
  expect(await activeStep(page)).toBe('2')
  expect(await wizardOpen(page)).toBe(1)
  expect(errors, errors.join(' | ')).toEqual([])
})

test('a token browser on a fresh install starts on the login step too', async ({ page }) => {
  const errors = await open(page, fresh('token'), 'hu')
  expect(await activeStep(page)).toBe('1')
  await expect(page.locator('#onbLoginCreateBtn')).toBeVisible()
  expect(errors, errors.join(' | ')).toEqual([])
})

test('only disabled logins: the step says to restore one on the machine, no form', async ({ page }) => {
  const errors = await open(page, { ...fresh(), users: 1, disabledOnly: true }, 'hu')
  expect(await activeStep(page)).toBe('1')
  await expect(page.locator('#onboardingBody')).toContainText('npm run dashboard-user')
  await expect(page.locator('#onbLoginUser')).toHaveCount(0)
  expect(errors, errors.join(' | ')).toEqual([])
})

test('Samu 72423: closed on the login step, the banner shows, and one click brings the wizard back on that step', async ({ page }) => {
  const errors = await open(page, fresh(), 'hu')
  expect(await activeStep(page)).toBe('1')
  await page.locator('#onboardingClose').click()
  expect(await wizardOpen(page)).toBe(0)
  const go = page.locator('#authBannerGoBtn')
  await go.waitFor({ state: 'visible' })
  await page.screenshot({ path: 'test-results/onboardownerpw1107-banner-hu.png' })
  await go.click()
  await page.locator('#onboardingOverlay.active').waitFor()
  expect(await activeStep(page)).toBe('1')
  await expect(page.locator('#onbLoginCreateBtn')).toBeVisible()
  expect(errors, errors.join(' | ')).toEqual([])
})
