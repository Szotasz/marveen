// DEVKEYMINT1022 browser verification: once a dashboard login exists, a browser
// that came in with the access token (?token=, the mobile QR) is not offered the
// issuing sections (they take the owner's session now) but a way to the login:
// the button drops the stored token and reloads into the sign-in overlay.
// Static web/ like bridgehu813.spec.ts: a second dashboard on this host would
// take the process lock from the live one.
import { test, expect } from '@playwright/test'

async function open(page: import('@playwright/test').Page, status: Record<string, unknown>, lang: 'hu' | 'en') {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  // the catch-all FIRST: Playwright gives the last matching handler priority
  await page.route('**/api/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }))
  await page.route('**/api/settings', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ settings: [] }) }))
  await page.route('**/api/auth/status', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(status) }))
  await page.route('**/api/auth/device-keys', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ keys: [] }) }))
  await page.addInitScript((l) => {
    try {
      localStorage.setItem('marveen.lang', l)
      if (!sessionStorage.getItem('devkey-seeded')) {
        localStorage.setItem('marveen-dashboard-token', 'a'.repeat(64))
        sessionStorage.setItem('devkey-seeded', '1')
      }
    } catch { /* ignore */ }
  }, lang)
  await page.goto('/index.html')
  await page.evaluate((l) => { ;(window as unknown as { _lang: string })._lang = l }, lang)
  await page.evaluate(async () => {
    const w = window as unknown as { switchPage: (p: string) => void; loadSettings: () => Promise<void> }
    w.switchPage('settings')
    await w.loadSettings()
  })
  return errors
}

test.describe('DEVKEYMINT1022 -- token-mode browser on an install with a login', () => {
  test('no issuing sections; the sign-in button drops the stored token', async ({ page }) => {
    const errors = await open(page, { method: 'token', authenticated: true, setup_required: false, login_available: true }, 'hu')
    const btn = page.locator('#authTokenSignIn')
    await btn.waitFor({ state: 'visible' })
    await expect(btn).toHaveText('Belépés a dashboard-jelszóval')
    await expect(page.locator('#authBridgeKeyLine')).toHaveCount(0)
    await page.screenshot({ path: 'test-results/devkeymint1022-hu.png', fullPage: false })
    expect(await page.evaluate(() => localStorage.getItem('marveen-dashboard-token'))).toBe('a'.repeat(64))
    await Promise.all([page.waitForEvent('load'), btn.click()])
    expect(await page.evaluate(() => localStorage.getItem('marveen-dashboard-token'))).toBeNull()
    expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([])
  })

  test('CONTROL: first-run token mode still gets the issuing sections and no sign-in button', async ({ page }) => {
    const errors = await open(page, { method: 'token', authenticated: true, setup_required: true, login_available: false }, 'en')
    await page.locator('#authBridgeKeyLine').waitFor({ state: 'visible' })
    await expect(page.locator('#authTokenSignIn')).toHaveCount(0)
    expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([])
  })
})
