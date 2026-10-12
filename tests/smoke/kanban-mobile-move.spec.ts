/**
 * Mobile kanban card-move smoke tests.
 *
 * Prerequisites: the dashboard must be running and DASHBOARD_TOKEN must be set.
 *   DASHBOARD_TOKEN=$(cat store/.dashboard-token) npx playwright test tests/smoke/kanban-mobile-move.spec.ts
 *
 * What these catch: the board being effectively read-only on a phone. HTML5
 * drag & drop never fires on touch, so BOTH paths added for mobile are
 * verified here against a real touch-enabled browser context -- a long-press
 * drag between columns, and the status dropdown in the card detail modal.
 *
 * Each test moves a card and moves it back, so the board ends as it started.
 *
 * Note the target statuses: NOT in_progress. /move fires fireKanbanDispatch()
 * on entry to in_progress, which wakes the card's assigned agent -- a test run
 * must not page a live agent, and restoring the status afterwards does not
 * un-send that message.
 */

import { test, expect, devices, type Page } from '@playwright/test'

const TOKEN = process.env.DASHBOARD_TOKEN || ''

test.use({ ...devices['Pixel 5'] })

type Card = { id: string; title: string; status: string }

async function firstPlannedCard(page: Page): Promise<Card> {
  const res = await page.request.get('/api/kanban', {
    headers: { Authorization: `Bearer ${TOKEN}` },
  })
  expect(res.ok()).toBeTruthy()
  const body = await res.json()
  const cards: Card[] = Array.isArray(body) ? body : (body.cards ?? [])
  const card = cards.find((c) => c.status === 'planned')
  expect(card, 'needs at least one planned card to move').toBeTruthy()
  return card as Card
}

async function statusOf(page: Page, id: string): Promise<string> {
  const res = await page.request.get('/api/kanban', {
    headers: { Authorization: `Bearer ${TOKEN}` },
  })
  const body = await res.json()
  const cards: Card[] = Array.isArray(body) ? body : (body.cards ?? [])
  return cards.find((c) => c.id === id)?.status ?? ''
}

async function restore(page: Page, id: string, status: string) {
  await page.request.post(`/api/kanban/${encodeURIComponent(id)}/move`, {
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    data: { status, sort_order: 0 },
  })
}

async function openKanban(page: Page) {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(`/?token=${TOKEN}`)
  await page.evaluate(() => (window as unknown as { switchPage: (p: string) => void }).switchPage('kanban'))
  await page.waitForSelector('.kanban-card', { timeout: 10_000 })
  return errors
}

test.describe('kanban card move on touch', () => {
  test('long-press drag moves a card to another column', async ({ page }) => {
    const card = await firstPlannedCard(page)
    const errors = await openKanban(page)

    const el = page.locator(`.kanban-card[data-id="${card.id}"]`)
    await expect(el).toBeVisible()
    const from = await el.boundingBox()
    expect(from).toBeTruthy()

    // Long press past TOUCH_DRAG_DELAY_MS, then drag. Movement before the
    // delay would (correctly) be handed back to the browser as a scroll.
    const cdp = await page.context().newCDPSession(page)
    const x0 = from!.x + from!.width / 2
    const y0 = from!.y + 20
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: x0, y: y0 }],
    })
    await page.waitForTimeout(400)

    // The drop bar exists only while a drag is committed -- its presence is
    // itself the proof that the long press was recognised as a drag.
    const chip = page.locator('.kanban-drop-target[data-status="testing"]')
    await expect(chip).toBeVisible()
    const to = await chip.boundingBox()
    expect(to).toBeTruthy()
    const tx = to!.x + to!.width / 2
    const ty = to!.y + to!.height / 2

    for (const f of [0.3, 0.6, 1]) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: x0 + (tx - x0) * f, y: y0 + (ty - y0) * f }],
      })
      await page.waitForTimeout(60)
    }
    await expect(chip).toHaveClass(/drag-over/)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [{ x: tx, y: ty }] })

    await expect
      .poll(() => statusOf(page, card.id), { timeout: 8_000 })
      .toBe('testing')

    expect(errors).toEqual([])
    await restore(page, card.id, card.status)
  })

  test('detail modal status dropdown moves a card', async ({ page }) => {
    const card = await firstPlannedCard(page)
    const errors = await openKanban(page)

    await page.locator(`.kanban-card[data-id="${card.id}"]`).tap()
    const statusValue = page.locator('#metaStatusValue')
    await expect(statusValue).toBeVisible()

    await statusValue.tap()
    const select = statusValue.locator('select')
    await expect(select).toBeVisible()
    await select.selectOption('waiting')

    await expect
      .poll(() => statusOf(page, card.id), { timeout: 8_000 })
      .toBe('waiting')

    expect(errors).toEqual([])
    await restore(page, card.id, card.status)
  })
})
