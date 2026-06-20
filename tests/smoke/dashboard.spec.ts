/**
 * Dashboard smoke tests.
 *
 * Prerequisites: the dashboard must be running and DASHBOARD_TOKEN must be set.
 *   DASHBOARD_TOKEN=$(cat store/.dashboard-token) npm run smoke
 *
 * What these tests catch: a single JS syntax error or undefined global that
 * silently breaks the entire dashboard (blank page / stuck UI).
 * They are NOT a full functional harness -- they verify the minimum viable
 * page health at the point of merge.
 */

import { test, expect } from '@playwright/test'

const TOKEN = process.env.DASHBOARD_TOKEN || ''

test.describe('Dashboard smoke', () => {
  test.beforeEach(async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (err) => errors.push(err.message))
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text())
    })
    ;(page as unknown as { _smokeErrors: string[] })._smokeErrors = errors
  })

  test('loads with token and returns HTTP 200', async ({ page }) => {
    const response = await page.goto(`/?token=${TOKEN}`)
    expect(response?.status()).toBe(200)
  })

  test('navigation sidebar links are visible', async ({ page }) => {
    await page.goto(`/?token=${TOKEN}`)
    const navLinks = page.locator('.sb-link[data-page]')
    await expect(navLinks.first()).toBeVisible()
    const count = await navLinks.count()
    expect(count).toBeGreaterThanOrEqual(4)
  })

  test('switchPage is callable without throwing', async ({ page }) => {
    await page.goto(`/?token=${TOKEN}`)
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.evaluate(() => {
      if (typeof (window as unknown as Record<string, unknown>).switchPage !== 'function') {
        throw new Error('switchPage is not a function')
      }
    })
    expect(errors).toHaveLength(0)
  })

  test('no JS errors on page load', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (err) => errors.push(err.message))
    await page.goto(`/?token=${TOKEN}`)
    // brief wait for any deferred init errors
    await page.waitForTimeout(500)
    expect(errors).toHaveLength(0)
  })

  test('kanban page loads without errors', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (err) => errors.push(err.message))
    await page.goto(`/?token=${TOKEN}#kanban`)
    await page.waitForTimeout(500)
    expect(errors).toHaveLength(0)
  })
})
