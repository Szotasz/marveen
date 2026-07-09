/**
 * PR-D smoke: the post-rollback diagnosis offer on the Updates page.
 *
 * Prerequisites: the dashboard must be running and DASHBOARD_TOKEN set.
 *   DASHBOARD_TOKEN=$(cat store/.dashboard-token) npm run smoke
 *
 * Uses route interception (never boots a second server) to feed the three
 * update states and asserts the UI offers / withholds the opt-in fixer, and
 * that clicking it POSTs to /api/updates/diagnose. The diagnose POST is
 * intercepted, so this never spawns a real agent.
 */

import { test, expect } from '@playwright/test'

const TOKEN = process.env.DASHBOARD_TOKEN || ''

// Block the service worker so our /api route overrides are not shadowed by the
// SW cache (the PR-A lesson).
test.use({ serviceWorkers: 'block' })

async function stubUpdates(page: import('@playwright/test').Page, status: Record<string, unknown>) {
  // Keep the page's own update-check cheap and deterministic.
  await page.route('**/api/updates', (r) =>
    r.fulfill({ json: { current: 'aaaaaaa', latest: 'aaaaaaa', behind: 0, remote: 'origin/develop' } }))
  await page.route('**/api/updates/status', (r) => r.fulfill({ json: status }))
}

test.describe('post-rollback diagnosis offer', () => {
  test('offers the opt-in fixer when canDiagnose and POSTs on confirm', async ({ page }) => {
    await stubUpdates(page, {
      running: false,
      result: { status: 'rolled-back', old: 'abc1234', ts: Math.floor(Date.now() / 1000) },
      canDiagnose: true,
      needsHuman: false,
    })
    let diagnosePosted = false
    await page.route('**/api/updates/diagnose', (r) => {
      diagnosePosted = true
      return r.fulfill({ json: { ok: true } })
    })
    page.on('dialog', (d) => d.accept()) // credit-consent confirm

    await page.goto(`/?token=${TOKEN}#updates`)
    await page.evaluate(() => (window as unknown as { loadUpdates: () => Promise<void> }).loadUpdates())

    const btn = page.locator('#updatesDiagnoseBtn')
    await expect(btn).toBeVisible()
    await btn.click()
    await expect.poll(() => diagnosePosted).toBe(true)
  })

  test('shows a manual-intervention note (no button) when the host lacks AVX', async ({ page }) => {
    await stubUpdates(page, {
      running: false,
      result: { status: 'failed', ts: Math.floor(Date.now() / 1000) },
      canDiagnose: false,
      needsHuman: true,
    })
    await page.goto(`/?token=${TOKEN}#updates`)
    await page.evaluate(() => (window as unknown as { loadUpdates: () => Promise<void> }).loadUpdates())

    await expect(page.locator('#updatesDiagnose.needs-human')).toBeVisible()
    await expect(page.locator('#updatesDiagnoseBtn')).toHaveCount(0)
  })

  test('offers nothing after a successful update', async ({ page }) => {
    await stubUpdates(page, {
      running: false,
      result: { status: 'success', old: 'abc1234', new: 'def5678', ts: Math.floor(Date.now() / 1000) },
      canDiagnose: false,
      needsHuman: false,
    })
    await page.goto(`/?token=${TOKEN}#updates`)
    await page.evaluate(() => (window as unknown as { loadUpdates: () => Promise<void> }).loadUpdates())
    await expect(page.locator('#updatesDiagnose')).toBeHidden()
  })
})
