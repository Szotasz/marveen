/**
 * visual-regression.js
 * Vizuális regressziós teszt a fiREG appra.
 * 
 * Futtatás:
 *   node tests/visual-regression.js [--env dev|staging|production] [--update-baseline] [--screen login]
 * 
 * Baseline: tests/visual-baselines/{env}/{screen}.png (git-tracked, soha nem ír felül automatikusan)
 * Frissítés: --update-baseline flag szükséges
 * Diff: reports/TIMESTAMP-diff-{screen}.png (ha eltérés > küszöb)
 */
import { chromium } from 'playwright'
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'
import pixelmatch from 'pixelmatch'
import { loadConfig, loginWithTwoFactor } from './helpers.js'

const __dir = dirname(fileURLToPath(import.meta.url))
const REPORTS_DIR = join(__dir, '..', 'reports')
mkdirSync(REPORTS_DIR, { recursive: true })

// CLI args
const args = process.argv.slice(2)
const UPDATE_BASELINE = args.includes('--update-baseline')
const ENV = args[args.indexOf('--env') + 1] || 'dev'
const ONLY_SCREEN = args.includes('--screen') ? args[args.indexOf('--screen') + 1] : null

const BASELINE_DIR = join(__dir, 'visual-baselines', ENV)
mkdirSync(BASELINE_DIR, { recursive: true })

// Pixel eltérés küszöb (százalék)
const DIFF_THRESHOLD_PCT = 0.3

const ts = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)

// Kulcs-képernyők definíciója
const SCREENS = [
  {
    name: 'login',
    description: 'Bejelentkezési oldal (nem bejelentkezett állapot)',
    navigate: async (page, BASE) => {
      await page.goto(`${BASE}/bejelentkezes`, { waitUntil: 'networkidle', timeout: 20_000 })
      await page.waitForTimeout(1000)
    },
    requiresLogin: false,
  },
  {
    name: 'dashboard',
    description: 'Főoldal / dashboard (bejelentkezve)',
    navigate: async (page, BASE) => {
      await page.goto(`${BASE}/`, { waitUntil: 'networkidle', timeout: 20_000 })
      await page.waitForTimeout(1500)
    },
    requiresLogin: true,
  },
  {
    name: 'tuzoltokeszulekek-lista',
    description: 'Tűzoltó készülékek lista nézet',
    navigate: async (page, BASE) => {
      await page.goto(`${BASE}/tuzoltokeszulekek`, { waitUntil: 'networkidle', timeout: 20_000 })
      await page.waitForTimeout(1500)
    },
    requiresLogin: true,
  },
  {
    name: 'tuzgatloeszkozok-lista',
    description: 'Tűzgátló eszközök lista nézet',
    navigate: async (page, BASE) => {
      await page.goto(`${BASE}/tuzgatloeszkozok`, { waitUntil: 'networkidle', timeout: 20_000 })
      await page.waitForTimeout(1500)
    },
    requiresLogin: true,
  },
  {
    name: 'tuzivizforrasok-lista',
    description: 'Tűzi vízforrások lista nézet',
    navigate: async (page, BASE) => {
      await page.goto(`${BASE}/tuzivizforrasok`, { waitUntil: 'networkidle', timeout: 20_000 })
      await page.waitForTimeout(1500)
    },
    requiresLogin: true,
  },
  {
    name: 'naplo-szerkeszto',
    description: 'Napló szerkesztő oldal (tűzoltó készülékek, napló 7345)',
    navigate: async (page, BASE) => {
      await page.goto(`${BASE}/tuzoltokeszulekek/naplo/7345`, { waitUntil: 'networkidle', timeout: 20_000 })
      await page.waitForTimeout(1500)
      // swal2 bezárása ha megjelenik
      if (await page.locator('.swal2-container').isVisible().catch(() => false)) {
        await page.locator('.swal2-confirm').click()
        await page.waitForTimeout(500)
      }
    },
    requiresLogin: true,
  },
  {
    name: 'pdf-modal',
    description: 'PDF dokumentum modal (tűzoltó készülékek napló)',
    navigate: async (page, BASE) => {
      await page.goto(`${BASE}/tuzoltokeszulekek/naplo/7345`, { waitUntil: 'networkidle', timeout: 20_000 })
      await page.waitForTimeout(1500)
      if (await page.locator('.swal2-container').isVisible().catch(() => false)) {
        await page.locator('.swal2-confirm').click()
        await page.waitForTimeout(500)
      }
      const docBtn = page.locator('button:has-text("Dokumentum"), a:has-text("Dokumentum")')
      if (await docBtn.first().isVisible().catch(() => false)) {
        await docBtn.first().click()
        await page.waitForTimeout(1500)
      }
    },
    requiresLogin: true,
  },
]

function parsePng(buffer) {
  return new Promise((resolve, reject) => {
    new PNG().parse(buffer, (err, png) => err ? reject(err) : resolve(png))
  })
}

async function compareScreenshot(currentBuf, baselinePath, screenName) {
  if (!existsSync(baselinePath)) {
    return { hasBaseline: false, diffPct: null, diffPath: null }
  }

  const baselineBuf = readFileSync(baselinePath)
  const [current, baseline] = await Promise.all([parsePng(currentBuf), parsePng(baselineBuf)])

  // Méret eltérés kezelése
  if (current.width !== baseline.width || current.height !== baseline.height) {
    console.log(`  ⚠ Méreteltérés: baseline=${baseline.width}x${baseline.height}, current=${current.width}x${current.height}`)
    return {
      hasBaseline: true,
      diffPct: 100,
      diffPath: null,
      sizeChanged: true,
      baselineSize: `${baseline.width}x${baseline.height}`,
      currentSize: `${current.width}x${current.height}`,
    }
  }

  const { width, height } = current
  const diffPng = new PNG({ width, height })
  const numDiffPixels = pixelmatch(
    current.data, baseline.data, diffPng.data,
    width, height,
    { threshold: 0.1, includeAA: false }
  )

  const totalPixels = width * height
  const diffPct = (numDiffPixels / totalPixels) * 100

  let diffPath = null
  if (diffPct > DIFF_THRESHOLD_PCT) {
    diffPath = join(REPORTS_DIR, `${ts()}-diff-${screenName}.png`)
    const diffBuf = PNG.sync.write(diffPng)
    writeFileSync(diffPath, diffBuf)
  }

  return { hasBaseline: true, diffPct, diffPath, numDiffPixels, totalPixels }
}

// ── FŐPROGRAM ──────────────────────────────────────────────────────────────────
const config = await loadConfig(ENV)
const BASE = config.baseUrl

console.log(`\nfiREG Vizuális Regresszió — ${ENV} — ${BASE}`)
console.log(UPDATE_BASELINE ? '  *** BASELINE FRISSÍTÉS MÓD ***' : '  Összehasonlítás mód')
console.log()

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  deviceScaleFactor: 1,
})
const page = await ctx.newPage()
page.on('pageerror', () => {})
page.on('requestfailed', () => {})

let loggedIn = false
const results = []

const screensToRun = ONLY_SCREEN
  ? SCREENS.filter(s => s.name === ONLY_SCREEN)
  : SCREENS

for (const screen of screensToRun) {
  console.log(`[${screen.name}] ${screen.description}`)

  // Login ha szükséges
  if (screen.requiresLogin && !loggedIn) {
    try {
      await loginWithTwoFactor(page, BASE, config.email, config.password)
      loggedIn = true
      console.log('  Bejelentkezve')
    } catch (e) {
      console.log(`  ❌ Login hiba: ${e.message?.slice(0, 60)}`)
      results.push({ screen: screen.name, status: 'login_failed' })
      continue
    }
  }

  // Navigáció
  try {
    await screen.navigate(page, BASE)
  } catch (e) {
    console.log(`  ❌ Navigációs hiba: ${e.message?.slice(0, 60)}`)
    results.push({ screen: screen.name, status: 'nav_failed', error: e.message?.slice(0, 80) })
    continue
  }

  // Screenshot
  const screenshotBuf = await page.screenshot({ fullPage: false }).catch(e => {
    console.log(`  ❌ Screenshot hiba: ${e.message?.slice(0, 60)}`)
    return null
  })
  if (!screenshotBuf) { results.push({ screen: screen.name, status: 'screenshot_failed' }); continue }

  const baselinePath = join(BASELINE_DIR, `${screen.name}.png`)

  if (UPDATE_BASELINE) {
    writeFileSync(baselinePath, screenshotBuf)
    console.log(`  ✅ Baseline mentve: ${baselinePath}`)
    results.push({ screen: screen.name, status: 'baseline_saved', path: baselinePath })
  } else {
    const cmp = await compareScreenshot(screenshotBuf, baselinePath, screen.name)

    if (!cmp.hasBaseline) {
      console.log(`  ⚠ Nincs baseline — futtasd --update-baseline kapcsolóval az étalon létrehozásához`)
      // Ideiglenes mentés referenciának
      const tmpPath = join(REPORTS_DIR, `${ts()}-nobaseline-${screen.name}.png`)
      writeFileSync(tmpPath, screenshotBuf)
      results.push({ screen: screen.name, status: 'no_baseline', tmpPath })
    } else if (cmp.sizeChanged) {
      console.log(`  ❌ MÉRETVÁLTOZÁS: ${cmp.baselineSize} → ${cmp.currentSize}`)
      const failPath = join(REPORTS_DIR, `${ts()}-sizechange-${screen.name}.png`)
      writeFileSync(failPath, screenshotBuf)
      results.push({ screen: screen.name, status: 'fail_size', ...cmp, failPath })
    } else if (cmp.diffPct > DIFF_THRESHOLD_PCT) {
      console.log(`  ❌ VIZUÁLIS ELTÉRÉS: ${cmp.diffPct.toFixed(2)}% (${cmp.numDiffPixels} pixel) → ${cmp.diffPath}`)
      results.push({ screen: screen.name, status: 'fail_visual', ...cmp })
    } else {
      console.log(`  ✅ OK — ${cmp.diffPct.toFixed(3)}% eltérés (küszöb: ${DIFF_THRESHOLD_PCT}%)`)
      results.push({ screen: screen.name, status: 'pass', diffPct: cmp.diffPct })
    }
  }
}

await browser.close()

// Összesítő
console.log('\n' + '='.repeat(60))
console.log('VIZUÁLIS REGRESSZIÓ ÖSSZESÍTŐ')
const pass = results.filter(r => r.status === 'pass').length
const fail = results.filter(r => ['fail_visual', 'fail_size'].includes(r.status)).length
const warn = results.filter(r => ['no_baseline', 'login_failed', 'nav_failed', 'screenshot_failed'].includes(r.status)).length
const saved = results.filter(r => r.status === 'baseline_saved').length

if (UPDATE_BASELINE) {
  console.log(`Baseline mentve: ${saved}/${screensToRun.length} képernyő`)
} else {
  console.log(`Átment: ${pass} | Eltérés: ${fail} | Figyelmeztetés: ${warn} | Összes: ${screensToRun.length}`)
  if (fail > 0) {
    console.log('\nELTÉRÉSEK:')
    results.filter(r => ['fail_visual', 'fail_size'].includes(r.status)).forEach(r => {
      if (r.status === 'fail_size') console.log(`  ${r.screen}: MÉRETVÁLTOZÁS ${r.baselineSize} → ${r.currentSize}`)
      else console.log(`  ${r.screen}: ${r.diffPct?.toFixed(2)}% pixel eltérés | diff: ${r.diffPath}`)
    })
  }
}

// JSON result
const resultPath = join(REPORTS_DIR, `${ts()}-visual-regression-result.json`)
writeFileSync(resultPath, JSON.stringify({ env: ENV, updateBaseline: UPDATE_BASELINE, results }, null, 2))
console.log(`\nJSON: ${resultPath}`)
console.log('VISUAL_RESULT:' + JSON.stringify({ pass, fail, warn, saved }))
