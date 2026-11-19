// DOCKERUX1118 browser verification (owner 33327/33329, Samu 80886): the install language switch on the setup
// wizard's first screen, in the container only. Before the owner is signed in a click switches the wizard's text in
// this browser and is remembered (no request); once signed in, the remembered choice, or a click, goes to
// POST /api/onboarding/language, and the wizard says which edited files were kept. A refused switch leaves the wizard in
// the install's language. Static web/ with the API stubbed, as onboardownerpw1107.spec.ts does.
import { test, expect, type Page } from '@playwright/test'

const KEY = 'a'.repeat(64)
interface Srv { deployment: 'docker' | 'native'; installLang: 'en' | 'hu'; session: boolean; posts: string[]; answer: { status: number; body: unknown } }

async function open(page: Page, srv: Srv, seed: { uiLang?: 'en' | 'hu'; pending?: 'en' | 'hu' } = {}) {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) })
  // the catch-all FIRST: Playwright gives the last matching handler priority
  await page.route('**/api/**', (r) => r.fulfill(json({})))
  await page.route('**/api/onboarding/status', (r) => r.fulfill(json({
    needsOnboarding: true, identityConfirmed: false, claudeAuthPresent: false, agentsRunning: false, channelConfigured: false, paired: false,
    deployment: srv.deployment, installLang: srv.installLang,
  })))
  await page.route('**/api/auth/status', (r) => r.fulfill(json({ authenticated: true, method: 'token', login_available: false, setup_required: !srv.session, owner_session: srv.session })))
  await page.route('**/api/settings', (r) => r.fulfill(json({ settings: [{ key: 'DASHBOARD_LANG', value: srv.installLang, source: 'env' }] })))
  await page.route('**/api/onboarding/language', async (r) => {
    const lang = JSON.parse(r.request().postData() || '{}').lang
    srv.posts.push(lang)
    if (srv.answer.status === 200) srv.installLang = lang
    return r.fulfill(json(srv.answer.body, srv.answer.status))
  })
  await page.addInitScript(([k, ui, pending]) => {
    try {
      if (!sessionStorage.getItem('lang-seeded')) {
        localStorage.setItem('marveen-dashboard-token', k)
        if (ui) localStorage.setItem('marveen.lang', ui)
        if (pending) localStorage.setItem('marveen.onbLangPending', pending)
        sessionStorage.setItem('lang-seeded', '1')
      }
    } catch { /* ignore */ }
  }, [KEY, seed.uiLang ?? '', seed.pending ?? ''] as const)
  await page.goto('/index.html')
  await page.locator('#onboardingOverlay.active').waitFor()
  return errors
}
const fresh = (over: Partial<Srv> = {}): Srv => ({
  deployment: 'docker', installLang: 'en', session: false, posts: [],
  answer: { status: 200, body: { ok: true, lang: 'hu', previous: 'en', files: [
    { file: 'CLAUDE.md', result: 'kept_customized' }, { file: 'SOUL.md', result: 're-rendered' }, { file: '.claude/skills/a/SKILL.md', result: 're-rendered' },
  ] } },
  ...over,
})
const btn = (page: Page, lang: 'hu' | 'en') => page.locator(`#onbLang .onb-lang-btn[data-lang="${lang}"]`)
const stored = (page: Page, key: string) => page.evaluate((k) => localStorage.getItem(k), key)

test('native install: no language switch on the wizard', async ({ page }) => {
  const errors = await open(page, fresh({ deployment: 'native' }))
  await expect(page.locator('#onbLoginCreateBtn')).toHaveText('Create and sign in')
  await expect(page.locator('#onbLang')).toBeHidden()
  expect(errors).toEqual([])
})

test('container, not signed in: Magyar switches the wizard in this browser only, and is remembered', async ({ page }) => {
  const srv = fresh()
  const errors = await open(page, srv)
  await expect(page.locator('#onbLang')).toBeVisible()
  await expect(page.locator('#onbLoginCreateBtn')).toHaveText('Create and sign in')
  expect(await btn(page, 'en').getAttribute('aria-pressed')).toBe('true')
  await page.screenshot({ path: 'test-results/dockerux1118-login-en.png' })
  expect(await page.evaluate(() => document.documentElement.lang)).toBe('en')
  await btn(page, 'hu').click()
  await expect(page.locator('#onbLoginCreateBtn')).toHaveText('Létrehozás és belépés')
  expect(await btn(page, 'hu').getAttribute('aria-pressed')).toBe('true')
  expect(await page.evaluate(() => document.documentElement.lang)).toBe('hu')
  expect(srv.posts).toEqual([])
  expect(await stored(page, 'marveen.onbLangPending')).toBe('hu')
  await page.screenshot({ path: 'test-results/dockerux1118-login-hu.png' })
  expect(errors).toEqual([])
})

test('container, signed in after choosing Magyar: the remembered choice is sent once, and the kept file is named', async ({ page }) => {
  const srv = fresh({ session: true })
  const errors = await open(page, srv, { uiLang: 'hu', pending: 'hu' })
  await expect(page.locator('#onbIdentityBtn')).toHaveText('Mentés és tovább')
  await expect.poll(() => srv.posts).toEqual(['hu'])
  await expect(page.locator('#onbMsg')).toContainText('CLAUDE.md')
  await expect(page.locator('#onbMsg')).toContainText('2')
  expect(await stored(page, 'marveen.onbLangPending')).toBeNull()
  await page.screenshot({ path: 'test-results/dockerux1118-signed-in-hu.png' })
  expect(errors).toEqual([])
})

test('container, signed in: a click switches the install; the wizard follows', async ({ page }) => {
  const srv = fresh({ session: true })
  const errors = await open(page, srv)
  await expect(page.locator('#onbIdentityBtn')).toHaveText('Save and continue')
  await btn(page, 'hu').click()
  await expect.poll(() => srv.posts).toEqual(['hu'])
  await expect(page.locator('#onbIdentityBtn')).toHaveText('Mentés és tovább')
  await expect(page.locator('#onbMsg')).toContainText('testreszabtad')
  expect(await stored(page, 'marveen.lang')).toBe('hu')
  expect(errors).toEqual([])
})

test('a refused switch (409): the wizard stays in the install language and says why', async ({ page }) => {
  const srv = fresh({ session: true, answer: { status: 409, body: { error: 'The main agent is already running.', reason: 'agent_running' } } })
  const errors = await open(page, srv)
  await btn(page, 'hu').click()
  await expect.poll(() => srv.posts).toEqual(['hu'])
  await expect(page.locator('#onbIdentityBtn')).toHaveText('Save and continue')
  await expect(page.locator('#onbMsg')).toContainText('The main agent is already running.')
  expect(await btn(page, 'en').getAttribute('aria-pressed')).toBe('true')
  expect(errors).toEqual([])
})
