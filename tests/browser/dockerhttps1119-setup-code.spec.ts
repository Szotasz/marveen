// DOCKERHTTPS1119 browser verification: on the public (HTTPS) address before the first login no token exists, so a
// gated call answers 401 and the page asks for the one-time setup code. The code goes in the POST body (never in the
// URL); a wrong code says so and stays on the form; a right one reloads the page. Static web/ with the API stubbed.
import { test, expect, type Page } from '@playwright/test'

async function open(page: Page, setupAnswer: { status: number }) {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) })
  const posts: Array<{ url: string; body: string }> = []
  let redeemed = false
  // the catch-all FIRST: Playwright gives the last matching handler priority
  await page.route('**/api/**', (r) => r.fulfill(json({ error: 'Unauthorized' }, 401)))
  await page.route('**/api/auth/status', (r) => r.fulfill(json(
    redeemed
      ? { authenticated: true, method: 'setup', setup_required: true, login_available: false }
      : { authenticated: false, method: null, setup_required: true, login_available: false, setup_code: true },
  )))
  await page.route('**/api/auth/setup-code', async (r) => {
    posts.push({ url: r.request().url(), body: r.request().postData() ?? '' })
    if (setupAnswer.status === 200) redeemed = true
    await r.fulfill(json(setupAnswer.status === 200 ? { ok: true } : { error: 'Wrong or expired setup code.' }, setupAnswer.status))
  })
  await page.goto('/index.html')
  return { errors, posts }
}

test('no token, no login: the setup-code form; a wrong code says so and stays', async ({ page }) => {
  const { errors, posts } = await open(page, { status: 401 })
  const overlay = page.locator('#mv-setup-code-overlay')
  await expect(overlay).toBeVisible()
  await overlay.locator('input').fill('0123-4567')
  await overlay.locator('button[type=submit]').click()
  await expect(overlay.locator('[role=alert]')).not.toBeEmpty()
  await expect(overlay).toBeVisible()
  expect(posts).toHaveLength(1)
  expect(posts[0]!.url).not.toContain('0123')
  expect(JSON.parse(posts[0]!.body)).toEqual({ code: '0123-4567' })
  expect(errors).toEqual([])
})

test('a right code reloads the page out of the form', async ({ page }) => {
  const { errors, posts } = await open(page, { status: 200 })
  const overlay = page.locator('#mv-setup-code-overlay')
  await expect(overlay).toBeVisible()
  await overlay.locator('input').fill('abcdef0123456789abcdef0123456789')
  await Promise.all([page.waitForEvent('load'), overlay.locator('button[type=submit]').click()])
  expect(posts).toHaveLength(1)
  expect(errors).toEqual([])
})
