// BRIDGEHU813 browser verification. The card's acceptance is explicit: the
// error branch must be SEEN in Hungarian in a browser, not merely present in a
// language file, and an English install must be unchanged.
//
// Why this serves web/ statically instead of booting a dashboard: a second
// `dist/index.js` on this host takes the process lock and kills the owner's
// live dashboard (measured, 2026-07-13). The pieces under test here are the
// static front-end ones -- app.js and the language files -- so serving them is
// the honest target. The response body is not invented: it is built from the
// REAL RemoteEnrollError thrown by the REAL validator, in the exact three-field
// shape that routes/security.ts serialises (asserted separately in
// bridge-pairing-i18n.test.ts).
import { test, expect } from '@playwright/test'
import { RemoteEnrollError, validatePublicKeyLine } from '../../src/remote-enroll-core.js'

/** Provoke a real failure and serialise it the way the route does. */
function realErrorBody(badLine: string): { error: string; code: string; params: Record<string, unknown> } {
  try {
    validatePublicKeyLine(badLine)
    throw new Error('expected the validator to reject this line')
  } catch (err) {
    if (!(err instanceof RemoteEnrollError)) throw err
    return { error: err.message, code: err.code, params: err.params }
  }
}

const BAD_LINE = 'ssh-ed25519 AAAA not-the-right-comment'

/** Reach the panel the way the product does: the app's own router, its own
 * settings-tab builder, its own auth-card renderer. Nothing here rebuilds the
 * form -- a hand-built copy would keep passing after the shipped one broke. */
async function showPairingPanel(page: import('@playwright/test').Page) {
  await page.evaluate(async () => {
    const w = window as unknown as {
      switchPage?: (p: string) => void
      loadSettings?: () => Promise<void>
      activateSettingsTab?: (t: string) => void
      renderAuthCard?: () => Promise<void>
    }
    for (const fn of ['switchPage', 'loadSettings', 'activateSettingsTab', 'renderAuthCard'] as const) {
      if (typeof w[fn] !== 'function') throw new Error(`${fn} is not a function`)
    }
    w.switchPage!('settings')
    // loadSettings calls renderAuthCard itself. Calling it a second time here
    // races that one: both run renderTokenModePanel, whose `innerHTML =` wipes
    // the sections the other just appended (measured, 2026-09-04).
    await w.loadSettings!()
  })
  // renderAuthCard renders the pairing section itself when the credential is a
  // token or a session: if this input is here, the real render path ran.
  await page.locator('#authBridgeKeyLine').waitFor({ state: 'visible' })
}

async function openPairingPanel(page: import('@playwright/test').Page, lang: 'hu' | 'en') {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => {
    // The 400 is the subject of the test, and the browser logs every failed
    // response as a console error. Filter that one line only: a real script
    // error still lands here, and pageerror is not filtered at all.
    if (m.type() === 'error' && !/Failed to load resource.*400/.test(m.text())) errors.push(m.text())
  })

  // ORDER MATTERS: Playwright gives the LAST matching handler priority, so the
  // catch-all is registered FIRST and the specific routes after it. Registered
  // the other way round, the catch-all swallows /api/auth/status, the panel
  // never renders, and the test fails for a reason that has nothing to do with
  // the change under test (measured, 2026-09-04).
  await page.route('**/api/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }))
  await page.route('**/api/settings', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ settings: [] }) }))
  await page.route('**/api/auth/status', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ method: 'token', authenticated: true }) }))
  await page.route('**/api/auth/device-keys', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ keys: [] }) }))
  await page.route('**/api/security/bridge-enroll', (r) =>
    r.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify(realErrorBody(BAD_LINE)) }))

  await page.addInitScript((l) => {
    try { localStorage.setItem('marveen.lang', l) } catch { /* ignore */ }
  }, lang)
  await page.goto('/index.html')
  await page.evaluate((l) => {
    ;(window as unknown as { _lang: string })._lang = l
  }, lang)
  await showPairingPanel(page)
  return errors
}

test.describe('BRIDGEHU813 -- the pairing error in a real browser', () => {
  test('a Hungarian install shows the Hungarian sentence, not the English one', async ({ page }) => {
    const errors = await openPairingPanel(page, 'hu')

    await page.fill('#authBridgeKeyLine', BAD_LINE)
    await page.fill('#authBridgeName', 'Szabi laptopja')
    page.once('dialog', (d) => d.accept())
    await page.click('#authBridgeEnrollBtn')

    const msg = page.locator('#authBridgeMsg')
    await expect(msg).toHaveClass(/err/)
    const text = (await msg.innerText()).trim()
    // The card's point: the English sentence must not be what the user reads.
    expect(text).not.toContain('comment must')
    expect(text).not.toContain('marveen-remote:<uuid v4>')
    // Hungarian, with its accents intact (a mojibake render would fail here).
    expect(text).toContain('Másold ki újra a teljes sort a Bridge alkalmazásból')
    expect(text).not.toContain('auth.bridge.err.')
    await page.screenshot({ path: 'test-results/bridgehu813-hu.png', fullPage: false })
    expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([])
  })

  test('an English install is unchanged', async ({ page }) => {
    const errors = await openPairingPanel(page, 'en')

    await page.fill('#authBridgeKeyLine', BAD_LINE)
    await page.fill('#authBridgeName', 'Szabi laptop')
    page.once('dialog', (d) => d.accept())
    await page.click('#authBridgeEnrollBtn')

    const msg = page.locator('#authBridgeMsg')
    await expect(msg).toHaveClass(/err/)
    const text = (await msg.innerText()).trim()
    expect(text).toContain('Copy the whole line again from the Bridge app')
    expect(text).not.toContain('Másold')
    await page.screenshot({ path: 'test-results/bridgehu813-en.png', fullPage: false })
    expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([])
  })

  test('CONTROL: an unknown code still shows the server sentence in the browser', async ({ page }) => {
    await page.route('**/api/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }))
    await page.route('**/api/settings', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ settings: [] }) }))
    await page.route('**/api/auth/status', (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ method: 'token', authenticated: true }) }))
    await page.route('**/api/security/bridge-enroll', (r) =>
      r.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'a sentence no language file knows', code: 'invented_later' }),
      }))
    await page.goto('/index.html')
    await showPairingPanel(page)
    await page.fill('#authBridgeKeyLine', BAD_LINE)
    await page.fill('#authBridgeName', 'Teszt')
    page.once('dialog', (d) => d.accept())
    await page.click('#authBridgeEnrollBtn')
    const msg = page.locator('#authBridgeMsg')
    await expect(msg).toHaveClass(/err/)
    expect((await msg.innerText()).trim()).toBe('a sentence no language file knows')
  })
})
