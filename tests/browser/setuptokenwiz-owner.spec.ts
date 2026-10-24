// SETUPTOKENWIZ1022 follow-up: the login mode of Settings -> Claude plans answers 403
// owner_session_required to a token or Bridge device-key window. The page must say how
// to sign in, in the page language, not show the server's English sentence. Static web/,
// the API answered by routes (a second dashboard here would take the live one's lock).
import { test, expect } from '@playwright/test'

const SERVER_SENTENCE = 'This needs the dashboard login (an owner session).'

for (const lang of ['hu', 'en'] as const) {
  test(`login mode, 403 owner_session_required: the ${lang} text says how to sign in`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.route('**/api/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }))
    await page.route('**/api/claude-plans/login/start', (r) => r.fulfill({
      status: 403, contentType: 'application/json',
      body: JSON.stringify({ error: `${SERVER_SENTENCE} The access token can do it only before the first login exists.`, code: 'owner_session_required' }),
    }))
    await page.addInitScript((l) => { try { localStorage.setItem('marveen.lang', l) } catch { /* ignore */ } }, lang)
    await page.goto('/index.html')
    await page.evaluate(() => {
      const host = document.createElement('div')
      host.id = 'cpProbeHost'
      document.body.prepend(host)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (window as any).renderClaudePlansPanel(host)
    })
    await page.locator('#cpFormMode').selectOption('login')
    await page.locator('#cpFormId').fill('second-pro')
    await page.locator('#cpFormLabel').fill('Second Pro')
    await page.locator('#cpFormAddBtn').click()
    const err = page.locator('#cpFormError')
    await expect(err).toBeVisible()
    await expect(err).not.toContainText(SERVER_SENTENCE)
    await expect(err).toContainText(lang === 'hu' ? 'Belépés a dashboard-jelszóval' : 'Sign in with the dashboard password')
    await page.screenshot({ path: `test-results/setuptokenwiz-owner-${lang}.png`, clip: (await err.boundingBox()) ?? undefined })
    expect(errors).toEqual([])
  })
}
