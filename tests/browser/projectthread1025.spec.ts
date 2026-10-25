// Project thread browser verification: the Projects page badge ("vár rád" /
// "új üzenet"), the thread panel (author -> addressee labels, timestamps in the
// install zone), the addressee chips with the "Marveen," auto-switch, and the
// owner's reply. Static web/ like the other specs here: the API is answered by
// routes, so no second dashboard is started on this host.
import { test, expect } from '@playwright/test'

const T0 = Date.UTC(2026, 6, 15, 10, 0, 0) / 1000 // 2026-07-15 10:00 UTC = 12:00 in Budapest (CEST); the browser here runs in UTC

async function open(page: import('@playwright/test').Page, viewport?: { width: number; height: number }) {
  if (viewport) await page.setViewportSize(viewport)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  const posts: unknown[] = []
  let reads = 0
  const messages: Array<Record<string, unknown>> = [
    { id: 1, project: 'Demo', author: 'laura', to_party: 'owner', responsible_agent: 'laura', content: 'Mehet a v2 kiadás?', needs_owner: true, created_at: T0, owner_read_at: null },
  ]
  await page.route('**/api/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }))
  await page.route('**/api/kanban/assignees', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }))
  await page.route('**/api/kanban-projects/summary', (r) => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify([
      { project: 'Demo', description: null, descriptionUpdatedAt: null, cardTotal: 3, cardDone: 1, lastActivityAt: T0, activeAssignees: ['laura'],
        thread: { messageCount: messages.length, unreadForOwner: 1, waitingOnOwner: posts.length === 0, lastMessageAt: T0, lastAuthor: 'laura' }, threadAgent: 'laura' },
      { project: 'Csendes', description: null, descriptionUpdatedAt: null, cardTotal: 1, cardDone: 0, lastActivityAt: T0, activeAssignees: [], thread: null, threadAgent: 'marveen' },
    ]),
  }))
  await page.route('**/api/project-threads/Demo/read', (r) => { reads++; return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"changed":1}' }) })
  await page.route('**/api/project-threads/Demo', async (r) => {
    if (r.request().method() === 'POST') {
      const body = JSON.parse(r.request().postData() || '{}')
      posts.push(body)
      const row = { id: messages.length + 1, project: 'Demo', author: 'owner', to_party: body.to, responsible_agent: 'laura', content: body.content, needs_owner: false, created_at: T0 + 60, owner_read_at: T0 + 60 }
      messages.push(row)
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...row, deliveries: [], ping: { attempted: false } }) })
    }
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      project: 'Demo', exists: true, responsible: { agent: 'laura', source: 'open-cards' }, override: null,
      owner: { id: 'owner', label: 'Csaba' }, main: { id: 'marveen', label: 'Marveen' }, timeZone: 'Europe/Budapest', messages,
    }) })
  })
  await page.addInitScript(() => { try { localStorage.setItem('marveen.lang', 'hu') } catch { /* ignore */ } })
  await page.goto('/index.html#projects')
  return { errors, posts, reads: () => reads }
}

test.describe('PROJECTTHREAD1025 -- the project thread', () => {
  test('badge, panel, chips with the Marveen auto-switch, and the owner reply', async ({ page }) => {
    const { errors, posts, reads } = await open(page)
    const demo = page.locator('.overview-card[data-project="Demo"]')
    await expect(demo.locator('.pt-badge.wait')).toHaveText('vár rád')
    await expect(page.locator('.overview-card[data-project="Csendes"] .pt-badge')).toHaveCount(0)

    await page.screenshot({ path: 'test-results/projectthread1025-cards.png' })
    await demo.locator('.pt-badge').click()
    const overlay = page.locator('#projectThreadOverlay')
    await expect(overlay).toHaveClass(/active/)
    await expect(page.locator('#projectThreadTitle')).toHaveText('Projekt-szál: Demo')
    const first = page.locator('.pt-msg').first()
    await expect(first.locator('.pt-msg-head strong')).toHaveText('laura → Csaba')
    await expect(first.locator('.pt-msg-head')).toContainText('12:00')
    await expect(first.locator('.pt-msg-needs')).toBeVisible()
    await expect.poll(reads).toBe(1)

    const chips = page.locator('#projectThreadTo .pt-chip')
    await expect(chips).toHaveText(['laura', 'Marveen', 'Mindkettő'])
    await expect(page.locator('#projectThreadTo .pt-chip.active')).toHaveText('laura')
    const input = page.locator('#projectThreadInput')
    await input.fill('Marveen, beszéld meg a többiekkel')
    await expect(page.locator('#projectThreadTo .pt-chip.active')).toHaveText('Marveen')
    await input.fill('Laura, mehet')
    await expect(page.locator('#projectThreadTo .pt-chip.active')).toHaveText('laura')
    await page.locator('#projectThreadTo .pt-chip', { hasText: 'Mindkettő' }).click()
    await page.locator('#projectThreadSend').click()
    await expect(page.locator('.pt-msg')).toHaveCount(2)
    expect(posts).toEqual([{ author: 'owner', content: 'Laura, mehet', to: 'both' }])
    await expect(page.locator('.pt-msg').nth(1).locator('.pt-msg-head strong')).toHaveText('Csaba → laura + Marveen')
    await expect(input).toHaveValue('')
    await page.screenshot({ path: 'test-results/projectthread1025-desktop.png' })
    expect(errors).toEqual([])
  })

  test('phone width: the panel fills the screen and the reply box stays reachable', async ({ page }) => {
    const { errors } = await open(page, { width: 390, height: 844 })
    await page.locator('.overview-card[data-project="Demo"] [data-act="thread"]').first().click()
    const modal = page.locator('.project-thread-modal')
    await expect(modal).toBeVisible()
    // the open transition scales the modal from 0.97, so wait for it to settle
    await expect.poll(async () => (await modal.boundingBox())!.width).toBeGreaterThanOrEqual(388)
    await expect(page.locator('#projectThreadSend')).toBeInViewport()
    await page.screenshot({ path: 'test-results/projectthread1025-phone.png' })
    expect(errors).toEqual([])
  })
})
