// DOCKERI18N1119 browser verification (Geri, v1.50.1): on an en install the "no channel configured" banner stayed
// Hungarian. Its text is drawn from /api/marveen with the language of that moment; on a fresh install (nothing stored in
// the browser) that answer can come before the server's DASHBOARD_LANG, and the language change that follows did not
// redraw it. Static web/ with the API stubbed: /api/marveen answers at once, /api/settings late.
import { test, expect, type Page } from '@playwright/test'

const KEY = 'a'.repeat(64)
const HU = 'Nincs beállított csatorna'
const EN = 'No channel configured'

async function open(page: Page, opts: { dashboardLang: 'en' | 'hu'; settingsDelayMs: number; stored?: 'en' | 'hu' }) {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) })
  // the catch-all FIRST: Playwright gives the last matching handler priority
  await page.route('**/api/**', (r) => r.fulfill(json({})))
  await page.route('**/api/onboarding/status', (r) => r.fulfill(json({ needsOnboarding: false })))
  await page.route('**/api/marveen', (r) => r.fulfill(json({ mainChannelUnconfigured: 'telegram', channelProvider: 'telegram' })))
  let settingsServed = false
  await page.route('**/api/settings', async (r) => {
    await new Promise((res) => setTimeout(res, opts.settingsDelayMs))
    await r.fulfill(json({ settings: [{ key: 'DASHBOARD_LANG', value: opts.dashboardLang, source: 'env' }] }))
    settingsServed = true
  })
  await page.addInitScript(([k, stored]) => {
    try {
      if (!sessionStorage.getItem('seeded')) {
        localStorage.setItem('marveen-dashboard-token', k)
        if (stored) localStorage.setItem('marveen.lang', stored)
        sessionStorage.setItem('seeded', '1')
      }
    } catch { /* ignore */ }
  }, [KEY, opts.stored ?? ''] as const)
  await page.goto('/index.html')
  const text = page.locator('#mainChannelUnconfBannerText')
  return { errors, text, settled: () => expect.poll(() => settingsServed).toBe(true) }
}

test('en install, the banner drawn before DASHBOARD_LANG arrives: it ends up English', async ({ page }) => {
  const { errors, text, settled } = await open(page, { dashboardLang: 'en', settingsDelayMs: 800 })
  // drawn first in the starting language (nothing stored in the browser)
  await expect(text).toContainText(HU)
  await settled()
  await expect(text).toContainText(EN)
  await expect(page.locator('#mainChannelUnconfBanner')).toBeVisible()
  expect(errors).toEqual([])
})

test('hu install: the banner stays Hungarian', async ({ page }) => {
  const { errors, text, settled } = await open(page, { dashboardLang: 'hu', settingsDelayMs: 300 })
  await settled()
  await expect(text).toContainText(HU)
  expect(errors).toEqual([])
})

test('the sidebar language switch redraws the banner too', async ({ page }) => {
  const { errors, text, settled } = await open(page, { dashboardLang: 'hu', settingsDelayMs: 0 })
  await settled()
  await expect(text).toContainText(HU)
  await page.evaluate(() => (window as unknown as { setLang: (l: string) => void }).setLang('en'))
  await expect(text).toContainText(EN)
  expect(errors).toEqual([])
})
