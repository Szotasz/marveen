// GROMZOOWNERQR1030 browser verification: the Settings page's Gromzo card asks for
// the owner QR, draws it client-side, counts down and wipes it. Static web/ with
// mocked /api (like devkeymint1022.spec.ts): a second dashboard on this host would
// take the process lock from the live one, and the real mxd must never be asked.
import { test, expect, type Page } from '@playwright/test'

const SECRET = 'moi_BROWSERSECRET_7Hq'
const LOGIN_SECRET = 'mol_BROWSERLOGIN_3Zp'
const JOIN_URI = `marveen://join?v=1&hs=https%3A%2F%2Fchat.gromzo.com&t=${SECRET}`
const LOGIN_URI = `marveen://login?v=1&hs=https%3A%2F%2Fchat.gromzo.com&s=${LOGIN_SECRET}`

async function open(page: Page, lang: 'hu' | 'en', qr: { status: number, body: Record<string, unknown> }) {
  const errors: string[] = []
  const qrCalls: Array<{ method: string, ct: string | undefined }> = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  await page.route('**/api/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }))
  await page.route('**/api/settings', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ settings: [] }) }))
  await page.route('**/api/auth/status', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ method: 'session', authenticated: true, user: 'owner', setup_required: false, login_available: true }) }))
  await page.route('**/api/gromzo/status', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ available: true, running: true, linked: true }) }))
  await page.route('**/api/gromzo/owner-qr', (r) => {
    qrCalls.push({ method: r.request().method(), ct: r.request().headers()['content-type'] })
    return r.fulfill({ status: qr.status, contentType: 'application/json', headers: { 'Cache-Control': 'no-store' }, body: JSON.stringify(qr.body) })
  })
  await page.clock.install()
  await page.addInitScript((l) => {
    try { localStorage.setItem('marveen.lang', l); localStorage.setItem('marveen-dashboard-token', 'a'.repeat(64)) } catch { /* ignore */ }
  }, lang)
  await page.goto('/index.html')
  await page.evaluate((l) => { ;(window as unknown as { _lang: string })._lang = l }, lang)
  await page.evaluate(async () => {
    const w = window as unknown as { switchPage: (p: string) => void, loadSettings: () => Promise<void> }
    w.switchPage('settings')
    await w.loadSettings()
  })
  // The card is collapsed at the bottom of Settings (owner, 2026-10-30): the
  // button is reachable only after unfolding it, as a user would.
  await expect(page.locator('#gromzoAddPhoneBtn')).toBeHidden()
  await page.locator('#gromzoCard > summary').click()
  return { errors, qrCalls }
}

/** Every place the secret could sit in the DOM: markup (attributes included) and text. */
async function domHolds(page: Page, needle: string): Promise<boolean> {
  return page.evaluate((n) => document.documentElement.outerHTML.includes(n) || document.body.innerText.includes(n), needle)
}

test.describe('GROMZOOWNERQR1030 -- Gromzo card on Settings', () => {
  test('join QR: drawn as SVG, secret nowhere in the DOM, countdown, wiped after 2 minutes', async ({ page }) => {
    const { errors, qrCalls } = await open(page, 'hu', { status: 200, body: { kind: 'join', uri: JOIN_URI, expires_in: 600 } })
    await expect(page.locator('#gromzoStatus')).toHaveText(/össze van kapcsolva/)
    const btn = page.locator('#gromzoAddPhoneBtn')
    await expect(btn).toHaveText('Telefon hozzáadása')
    await btn.click()
    await expect(page.locator('#gromzoQr svg')).toBeVisible()
    expect(qrCalls).toEqual([{ method: 'POST', ct: 'application/json' }])
    await expect(page.locator('#gromzoQrHint')).toHaveText(/regisztrációnál/)
    await expect(page.locator('#gromzoCountdown')).toHaveText(/120 másodpercig/)
    expect(await domHolds(page, SECRET)).toBe(false)
    expect(await domHolds(page, 'BROWSERSECRET')).toBe(false)
    await page.locator('#gromzoCard').scrollIntoViewIfNeeded()
    await page.screenshot({ path: 'test-results/gromzoownerqr1030-join-hu.png', fullPage: false })
    // The QR encodes exactly the URI (decoded from the drawn modules by the same library: re-encode and compare).
    const same = await page.evaluate((uri) => {
      const q = (window as unknown as { qrcode: (t: number, e: string) => { addData(s: string): void, make(): void, createSvgTag(o: unknown): string } }).qrcode(0, 'M')
      q.addData(uri); q.make()
      const want = q.createSvgTag({ cellSize: 6, margin: 4, scalable: true })
      // compare after the same DOM serialisation (the browser normalises SVG markup)
      const probe = document.createElement('div'); probe.innerHTML = want
      return document.getElementById('gromzoQr')!.innerHTML === probe.innerHTML
    }, JOIN_URI)
    expect(same).toBe(true)
    await page.clock.runFor(119_000)
    await expect(page.locator('#gromzoCountdown')).toHaveText(/1 másodpercig/)
    await page.clock.runFor(2_000)
    await expect(page.locator('#gromzoQrArea')).toBeHidden()
    expect(await page.locator('#gromzoQr').innerHTML()).toBe('')
    await expect(page.locator('#gromzoError')).toHaveText(/eltűnt/)
    expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([])
  })

  test('login QR (owner already registered): login hint, a shorter lifetime wins, close wipes it', async ({ page }) => {
    const { errors } = await open(page, 'en', { status: 200, body: { kind: 'login', uri: LOGIN_URI, expires_in: 90 } })
    await page.locator('#gromzoAddPhoneBtn').click()
    await expect(page.locator('#gromzoQr svg')).toBeVisible()
    await expect(page.locator('#gromzoQrHint')).toHaveText(/already registered/)
    await expect(page.locator('#gromzoCountdown')).toHaveText(/90 more seconds/)
    expect(await domHolds(page, LOGIN_SECRET)).toBe(false)
    await page.locator('#gromzoCard').scrollIntoViewIfNeeded()
    await page.screenshot({ path: 'test-results/gromzoownerqr1030-login-en.png', fullPage: false })
    await page.locator('#gromzoQrClose').click()
    await expect(page.locator('#gromzoQrArea')).toBeHidden()
    expect(await page.locator('#gromzoQr').innerHTML()).toBe('')
    expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([])
  })

  test('collapsed by default after the Settings tabs; folding the card away wipes the code', async ({ page }) => {
    await open(page, 'en', { status: 200, body: { kind: 'join', uri: JOIN_URI, expires_in: 600 } })
    const order = await page.evaluate(() => {
      const card = document.getElementById('gromzoCard')!
      const tabs = document.getElementById('settingsTabPanels')!
      return { isDetails: card.tagName, afterTabs: !!(tabs.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING) }
    })
    expect(order).toEqual({ isDetails: 'DETAILS', afterTabs: true })
    await page.locator('#gromzoAddPhoneBtn').click()
    await expect(page.locator('#gromzoQr svg')).toBeVisible()
    await page.locator('#gromzoCard > summary').click()
    await expect(page.locator('#gromzoAddPhoneBtn')).toBeHidden()
    // 'toggle' is dispatched as a task after the click, so poll for the wipe.
    await expect.poll(() => page.locator('#gromzoQr').innerHTML()).toBe('')
    expect(await domHolds(page, SECRET)).toBe(false)
  })

  test('leaving the Settings page wipes the code', async ({ page }) => {
    await open(page, 'en', { status: 200, body: { kind: 'join', uri: JOIN_URI, expires_in: 600 } })
    await page.locator('#gromzoAddPhoneBtn').click()
    await expect(page.locator('#gromzoQr svg')).toBeVisible()
    await page.evaluate(() => (window as unknown as { switchPage: (p: string) => void }).switchPage('overview'))
    expect(await page.locator('#gromzoQr').innerHTML()).toBe('')
  })

  test('rate limited: a readable sentence, no QR', async ({ page }) => {
    const { errors } = await open(page, 'hu', { status: 429, body: { error: 'rate_limited' } })
    await page.locator('#gromzoAddPhoneBtn').click()
    await expect(page.locator('#gromzoError')).toHaveText(/túl sok kódot/)
    await expect(page.locator('#gromzoQrArea')).toBeHidden()
    await expect(page.locator('#gromzoAddPhoneBtn')).toBeEnabled()
    await page.locator('#gromzoCard').scrollIntoViewIfNeeded()
    await page.screenshot({ path: 'test-results/gromzoownerqr1030-ratelimited-hu.png', fullPage: false })
    expect(errors.filter((e) => !/429/.test(e)), `page errors: ${errors.join(' | ')}`).toEqual([])
  })

  test('Bridge-key install and the owner-session refusal have their own sentences', async ({ page }) => {
    await open(page, 'en', { status: 409, body: { error: 'consent_required' } })
    await page.locator('#gromzoAddPhoneBtn').click()
    await expect(page.locator('#gromzoError')).toHaveText(/Bridge key/)
  })

  // GROMZORESETWAIT1031 (Samu 58730): during the identity reset lock the owner sees when to ask again; a stalled
  // reset says so; with no time the sentence stays the general one.
  for (const [lang, body, want] of [
    ['hu', { error: 'identity_reset_in_progress', retry_after: 420 }, 'Az új kódot kb. 7 perc múlva kérheted.'],
    ['hu', { error: 'identity_reset_in_progress', retry_after: 30 }, 'Az új kódot kb. 1 perc múlva kérheted.'],
    ['en', { error: 'identity_reset_in_progress', retry_after: 721 }, 'You can request a new code in about 13 min.'],
    ['hu', { error: 'identity_reset_in_progress' }, 'A kódot utána tudod kérni.'],
    ['hu', { error: 'identity_reset_in_progress', retry_after: '420' }, 'A kódot utána tudod kérni.'],
    ['hu', { error: 'identity_reset_stalled' }, 'elakadt, ezért most nem adható ki kód. Szólj a rendszergazdának.'],
    ['en', { error: 'identity_reset_stalled' }, 'is stuck, so no code can be issued right now.'],
  ] as const) {
    test(`identity reset lock ${lang} ${JSON.stringify(body)}: ${want}`, async ({ page }) => {
      const { errors } = await open(page, lang, { status: 409, body })
      await page.locator('#gromzoAddPhoneBtn').click()
      await expect(page.locator('#gromzoError')).toContainText(want)
      await expect(page.locator('#gromzoQrArea')).toBeHidden()
      await expect(page.locator('#gromzoAddPhoneBtn')).toBeEnabled()
      if (lang === 'hu' && 'retry_after' in body && body.retry_after === 420) {
        await page.locator('#gromzoCard').scrollIntoViewIfNeeded()
        await page.screenshot({ path: 'test-results/gromzoresetwait1031-wait-hu.png', fullPage: false })
      }
      if (body.error === 'identity_reset_stalled' && lang === 'hu') {
        await page.locator('#gromzoCard').scrollIntoViewIfNeeded()
        await page.screenshot({ path: 'test-results/gromzoresetwait1031-stalled-hu.png', fullPage: false })
      }
      expect(errors.filter((e) => !/409/.test(e)), `page errors: ${errors.join(' | ')}`).toEqual([])
    })
  }
})
