// KILLSWITCH1022 browser verification: the red button in the sidebar, the frozen
// banner, and the owner-only lift (a 403 from the server becomes a toast that
// points to the dashboard-password sign-in). Static web/ like the other specs
// here: a second dashboard on this host would take the process lock from the
// live one, so the API is answered by routes.
import { test, expect } from '@playwright/test'

type Freeze = { frozen: boolean; state: Record<string, unknown> | null }

async function open(page: import('@playwright/test').Page, lang: 'hu' | 'en', initial: Freeze) {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  let freeze: Freeze = initial
  const calls: Array<{ path: string; body: unknown }> = []
  await page.route('**/api/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }))
  await page.route('**/api/fleet/freeze', async (r) => {
    if (r.request().method() === 'POST') {
      const body = JSON.parse(r.request().postData() || '{}')
      calls.push({ path: 'freeze', body })
      freeze = { frozen: true, state: { mode: body.mode, reason: body.reason, by: 'session:owner', at: '2026-10-22T10:00:00.000Z' } }
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, ...freeze }) })
    }
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(freeze) })
  })
  await page.route('**/api/fleet/unfreeze', async (r) => {
    calls.push({ path: 'unfreeze', body: null })
    return r.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'x', code: 'owner_session_required' }) })
  })
  await page.addInitScript((l) => { try { localStorage.setItem('marveen.lang', l) } catch { /* ignore */ } }, lang)
  await page.goto('/index.html')
  return { errors, calls }
}

test.describe('KILLSWITCH1022 -- the red button', () => {
  test('not frozen: the button is there, the banner is not; pulling it freezes and shows the banner', async ({ page }) => {
    const { errors, calls } = await open(page, 'hu', { frozen: false, state: null })
    const btn = page.locator('#fleetFreezeBtn')
    await expect(btn).toBeVisible()
    await expect(page.locator('#fleetFreezeBanner')).toBeHidden()
    // reason prompt, then "stop the sessions too?" -> Cancel = freeze only
    const answers = ['furcsa levelek', false]
    page.on('dialog', (d) => {
      const a = answers.shift()
      if (typeof a === 'string') void d.accept(a)
      else if (a) void d.accept()
      else void d.dismiss()
    })
    await btn.click()
    await expect(page.locator('#fleetFreezeBanner')).toBeVisible()
    await expect(page.locator('#fleetFreezeBannerText')).toContainText('FAGYASZTVA')
    await expect(page.locator('#fleetFreezeBannerText')).toContainText('furcsa levelek')
    expect(calls[0]).toEqual({ path: 'freeze', body: { reason: 'furcsa levelek', mode: 'freeze' } })
    await page.screenshot({ path: 'test-results/killswitch1022-frozen-hu.png', fullPage: false })
    expect(errors).toEqual([])
  })

  test('frozen on load: the banner shows; a 403 on lift keeps it and says only the owner can lift it', async ({ page }) => {
    const { errors, calls } = await open(page, 'en', { frozen: true, state: { mode: 'stop', reason: 'runaway', by: 'token:iris', at: '2026-10-22T10:00:00.000Z' } })
    await expect(page.locator('#fleetFreezeBanner')).toBeVisible()
    await expect(page.locator('#fleetFreezeBannerText')).toContainText('STOPPED')
    await expect(page.locator('#fleetFreezeBtn')).toBeDisabled()
    page.on('dialog', (d) => void d.accept())
    await page.locator('#fleetUnfreezeBtn').click()
    await expect(page.locator('.toast, #toast').first()).toContainText('Only the owner can lift it')
    await expect(page.locator('#fleetFreezeBanner')).toBeVisible()
    expect(calls.map((c) => c.path)).toEqual(['unfreeze'])
    expect(errors).toEqual([])
  })
})
