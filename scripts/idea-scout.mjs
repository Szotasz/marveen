// Daily idea-scout: IdeaBrowser today + browse top items, per the
// negative-review-mining-product-discovery skill login recipe (2026-07-24).
// Password comes from the vault API at runtime and is never printed.
import { chromium } from '/home/viktor/Projects/marveen/node_modules/playwright/index.mjs'
import { readFileSync } from 'node:fs'

const token = readFileSync('/home/viktor/Projects/marveen/store/.dashboard-token', 'utf8').trim()
const jitter = (min = 900, max = 2400) => new Promise(r => setTimeout(r, min + Math.random() * (max - min)))

async function vaultSecret(id) {
  const res = await fetch(`http://localhost:3420/api/vault/${id}`, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error(`vault ${id}: ${res.status}`)
  const j = await res.json()
  return j.value ?? j.secret ?? j.plaintext ?? (typeof j === 'string' ? j : null)
}

async function main() {
  const password = await vaultSecret('ideabrowser-password')
  if (!password) throw new Error('vault: ideabrowser-password not resolvable')
  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  try {
    await page.goto('https://www.ideabrowser.com/login', { waitUntil: 'domcontentloaded', timeout: 60000 })
    await page.waitForTimeout(4000) // Vercel checkpoint settle
    await page.locator('input[type=email]:visible').first().fill('viktor.tolnai@gmail.com')
    await jitter()
    await page.locator('button:visible', { hasText: 'Sign in with Password' }).first().click()
    await jitter()
    await page.locator('input[type=password]:visible').first().fill(password)
    await jitter()
    await page.keyboard.press('Enter')
    await page.waitForURL('**/hub**', { timeout: 30000 })
    console.log('LOGIN OK:', page.url())

    await jitter()
    await page.goto('https://www.ideabrowser.com/hub/ideas/today', { waitUntil: 'domcontentloaded', timeout: 60000 })
    await page.waitForTimeout(3500)
    await page.mouse.wheel(0, 900); await jitter()
    const todayText = (await page.locator('main').innerText().catch(() => page.locator('body').innerText())).catch ? '' : await page.locator('main').innerText().catch(async () => await page.locator('body').innerText())
    console.log('===== TODAY (/hub/ideas/today) =====')
    console.log((todayText || '').slice(0, 4000))

    await jitter()
    // A "legnepszerubb UJ tetelek" URL-je MERVE (2026-08-05): a UI "New" fule
    // NEM ujdonsagot jelent, hanem status=no_reaction-t (amire meg nem
    // reagaltunk) -- ezert a sima most_popular minden ejjel ugyanazokat a
    // 2025-os evergreen teteleket adta vissza. A tenyleges frissesseg a
    // sort=newest. A ketto egyutt: amit meg nem lattunk, idorendben.
    await page.goto('https://www.ideabrowser.com/hub/ideas/browse?sort=newest&status=no_reaction',
      { waitUntil: 'domcontentloaded', timeout: 60000 })
    await page.waitForTimeout(3500)
    await page.mouse.wheel(0, 1200); await jitter()
    console.log('===== BROWSE (newest, meg nem ertekelt) =====')
    const browseText = await page.locator('main').innerText().catch(async () => await page.locator('body').innerText())
    console.log((browseText || '').slice(0, 5000))

    // Hetfonkent (vagy --market-insights kapcsoloval) a beepitett Market
    // Insights fajdalompont-kutatast is kiirjuk -- ez a Pro-ban benne van,
    // nem fogyaszt Research Agent kvotat.
    const monday = new Date().getDay() === 1
    if (monday || process.argv.includes('--market-insights')) {
      await jitter()
      await page.goto('https://www.ideabrowser.com/hub/market-insights',
        { waitUntil: 'domcontentloaded', timeout: 60000 })
      await page.waitForTimeout(3500)
      await page.mouse.wheel(0, 1200); await jitter()
      console.log('===== MARKET INSIGHTS (heti kor) =====')
      const insightsText = await page.locator('main').innerText().catch(async () => await page.locator('body').innerText())
      console.log((insightsText || '').slice(0, 5000))
    }
  } finally {
    await browser.close()
  }
}

main().catch(e => { console.error('SCOUT FAILED:', e.message); process.exit(1) })
