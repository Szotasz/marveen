// ONBOARDFOLLOW1107 (Samu 72704): two loadSettings runs overlapping on the Settings page. The second run cleared
// #settingsTabPanels after its await, and with it the auth card the first run had just moved into the Security panel:
// the card left the page, and the pending renderAuthCard wrote into a detached body (renderCreateLoginForm:
// getElementById('authCreateBtn') -> null -> TypeError). Seen on a WEB_ONLY dashboard when Settings was opened twice
// while loading; never on a plain load. Static web/ with a stubbed API whose delays force the bad order every time:
// run A starts, run B starts, A's settings answer, B's settings answer, then the auth status.
import { test, expect, type Page } from '@playwright/test'

const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) })
const SETTING = { module: 'general', key: 'LOG_LEVEL', type: 'string', value: 'info', default: 'info', valueSet: false, source: 'default', requiresRestart: false, envIgnored: false }

async function open(page: Page, firstFails = false) {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  const later = (ms: number) => new Promise((r) => setTimeout(r, ms))
  let settingsCalls = 0
  let armed = false // the page's own loads during start-up answer at once and are not counted
  await page.route('**/api/**', (r) => r.fulfill(json({})))
  await page.route('**/api/onboarding/status', (r) => r.fulfill(json({ needsOnboarding: false })))
  // a fresh install: no dashboard login yet, so the auth card renders its create form
  const AUTH = { authenticated: true, method: 'token', setup_required: true, login_available: false }
  await page.route('**/api/auth/status', async (r) => { if (armed) await later(1500); await r.fulfill(json(AUTH)) })
  await page.route('**/api/settings', async (r) => {
    if (!armed) return r.fulfill(json({ settings: [SETTING], overridesFile: null }))
    const n = ++settingsCalls
    if (firstFails) {
      // the newer run B answers first and builds; the stale run A fails afterwards
      await later(n === 1 ? 800 : 300)
      return n === 1 ? r.fulfill(json({ error: 'boom' }, 500)) : r.fulfill(json({ settings: [SETTING], overridesFile: null }))
    }
    await later(n === 1 ? 300 : 800) // A answers first, B after A has built its panels
    await r.fulfill(json({ settings: [SETTING], overridesFile: null }))
  })
  await page.addInitScript(() => { try { localStorage.setItem('marveen.lang', 'en'); localStorage.setItem('marveen-dashboard-token', 'a'.repeat(64)) } catch { /* ignore */ } })
  await page.goto('/index.html')
  await page.waitForFunction(() => typeof (window as unknown as { loadSettings?: unknown }).loadSettings === 'function')
  await page.waitForLoadState('networkidle')
  armed = true
  return { errors, calls: () => settingsCalls }
}

test('two overlapping loadSettings runs keep the auth card on the page and render its form without an error', async ({ page }) => {
  const { errors, calls } = await open(page)
  await page.evaluate(() => {
    const w = window as unknown as { loadSettings: () => Promise<void> }
    void w.loadSettings()
    void w.loadSettings()
  })
  await expect.poll(calls).toBe(2)
  // after both settings answers and the auth status
  await page.waitForTimeout(2500)
  expect(errors, errors.join(' | ')).toEqual([])
  // the card is in the document, inside the Security panel, with its create form
  await expect(page.locator('#settings-panel-security #authCard')).toHaveCount(1)
  await expect(page.locator('#authCard #authCreateBtn')).toHaveCount(1)
  // one set of panels: the stale run built none
  await expect(page.locator('#settingsTabPanels > #settings-panel-security')).toHaveCount(1)
  await expect(page.locator('#settingsTabNav .tab-btn[data-tab="security"]')).toHaveCount(1)
})

test('a stale run that fails after the newer one built the panels does not wipe them', async ({ page }) => {
  const { errors, calls } = await open(page, true)
  await page.evaluate(() => {
    const w = window as unknown as { loadSettings: () => Promise<void> }
    void w.loadSettings()
    void w.loadSettings()
  })
  await expect.poll(calls).toBe(2)
  await page.waitForTimeout(2500)
  expect(errors, errors.join(' | ')).toEqual([])
  await expect(page.locator('#settings-panel-security #authCard')).toHaveCount(1)
  await expect(page.locator('#authCard #authCreateBtn')).toHaveCount(1)
  await expect(page.locator('#settingsTabPanels > #settings-panel-general')).toHaveCount(1)
})
