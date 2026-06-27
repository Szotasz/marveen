// Nagy teszt -- minden eszköztípus Karbantartás rögzítés + napló PDF generálás
// Scroll-to-saved-row verify screenshotok + PDF lapok beágyazva a jelentésbe
import { chromium } from 'playwright'
import { mkdirSync, copyFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import { loadConfig, loginWithTwoFactor } from './helpers.js'

const __dir = dirname(fileURLToPath(import.meta.url))
const REPORTS_DIR = join(__dir, '..', 'reports')
mkdirSync(REPORTS_DIR, { recursive: true })

const ts = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)

const scr = async (page, label) => {
  const f = join(REPORTS_DIR, `${ts()}-nagy-${label.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 60)}.png`)
  await page.screenshot({ path: f, fullPage: false })
  console.log(`  📸 ${f.split('/').pop()}`)
  return f
}

const config = await loadConfig('dev')
const BASE = config.baseUrl
const TODAY = new Date().toISOString().slice(0, 10).split('-').reverse().join('.')

// ─── PDF generálás + minden lap renderelése ──────────────────────────────────
async function generateNaplopdf(page, slug, naploId) {
  await page.goto(`${BASE}/${slug}/naplo/${naploId}`, { waitUntil: 'networkidle', timeout: 20_000 }).catch(() => {})
  await page.waitForTimeout(2000)
  if (await page.locator('.swal2-container').isVisible().catch(() => false)) {
    await page.locator('.swal2-confirm').click().catch(() => {})
    await page.waitForTimeout(500)
  }

  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(b => /dokumentum/i.test(b.innerText))
    btn?.click()
  })
  await page.waitForTimeout(1500)

  // Különböző típusoknál különböző modal ID:
  // printOrSendDeviceDiary, printOrSendFireDoorDiary, printOrSendDocument, printOrSendSprinklerDiary
  const DIARY_MODAL_SEL = '[id^="printOrSend"]'
  if (!(await page.locator(DIARY_MODAL_SEL).first().isVisible().catch(() => false))) {
    return { ok: false, pages: [], reason: 'Dokumentum modal nem nyílt meg' }
  }

  const modalDomId = await page.locator(DIARY_MODAL_SEL).first().getAttribute('id').catch(() => null)

  await page.evaluate((mid) => {
    const modal = document.getElementById(mid)
    const sels = [...(modal?.querySelectorAll('select') || [])]
    // Letöltés opciót tartalmazó select
    const actionSel = sels.find(s => [...s.options].some(o => /letölt/i.test(o.text)))
    if (actionSel) {
      const opt = [...actionSel.options].find(o => /letölt/i.test(o.text))
      if (opt) { actionSel.value = opt.value; actionSel.dispatchEvent(new Event('change', { bubbles: true })) }
      if (window.$ && window.$(actionSel).data('select2')) window.$(actionSel).val(opt?.value).trigger('change')
    }
    // date_type = 1 = legutóbbi generálás óta (biztonságosabb mint 0/mai nap a /printReport végpontnál)
    const dateSel = sels.find(s => s.id === 'date_type')
    if (dateSel) { dateSel.value = '1'; dateSel.dispatchEvent(new Event('change', { bubbles: true })) }
    // calendar_year = aktuális év (fallback az összes rekordhoz)
    const yearSel = sels.find(s => s.id === 'calendar_year')
    if (yearSel) {
      const curYear = String(new Date().getFullYear())
      const yearOpt = [...yearSel.options].find(o => o.value === curYear)
      if (yearOpt) { yearSel.value = curYear; yearSel.dispatchEvent(new Event('change', { bubbles: true })) }
    }
  }, modalDomId)
  await page.waitForTimeout(500)

  const dlPromise = page.waitForEvent('download', { timeout: 30_000 }).catch(() => null)
  await page.evaluate((mid) => {
    const modal = document.getElementById(mid)
    const btns = [...(modal?.querySelectorAll('button[type="submit"], button.btn-dark, button.btn-primary') || [])]
    const dlBtn = btns.find(b => !/küldés|email/i.test(b.innerText)) || btns[0]
    dlBtn?.click()
  }, modalDomId)

  const dl = await dlPromise
  if (!dl) return { ok: false, pages: [], reason: 'PDF letöltés timeout' }

  const dlPath = await dl.path()
  const fname = dl.suggestedFilename()
  if (!dlPath) return { ok: false, pages: [], reason: 'PDF útvonal null' }

  const pdfDest = join(REPORTS_DIR, `${ts()}-nagy-${slug}-naplo${naploId}.pdf`)
  copyFileSync(dlPath, pdfDest)

  const pdfBase = pdfDest.replace(/\.pdf$/i, '')
  try {
    execSync(`pdftoppm -r 120 -png "${pdfDest}" "${pdfBase}-p"`, { timeout: 30000 })
  } catch (e) {
    return { ok: true, pages: [], pdfPath: pdfDest, fname, reason: `PDF OK, render hiba: ${e.message.slice(0, 60)}` }
  }

  const pdfBaseName = pdfBase.split('/').pop()
  const pages = readdirSync(REPORTS_DIR)
    .filter(f => f.startsWith(pdfBaseName) && f.endsWith('.png'))
    .sort()
    .map(f => join(REPORTS_DIR, f))

  console.log(`  📄 PDF: ${fname} -- ${pages.length} lap`)
  pages.forEach(p => console.log(`  📄 ${p.split('/').pop()}`))
  return { ok: true, pages, pdfPath: pdfDest, fname, reason: `${pages.length} lap` }
}

// ─── Scroll a mentett sorra ───────────────────────────────────────────────────
async function scrSavedRow(page, label, cbIdx) {
  await page.evaluate(({ today, i }) => {
    const dateBtns = [...document.querySelectorAll('.service-btn, [class*=service]')]
      .filter(el => el.innerText?.includes(today))
    const last = dateBtns[dateBtns.length - 1]
    if (last) { last.scrollIntoView({ behavior: 'instant', block: 'center' }); return }
    const cbs = [...document.querySelectorAll('input[type="checkbox"]:not([disabled])')]
      .filter(c => !c.id?.includes('control') && !c.id?.includes('qr') && !c.id?.includes('all'))
    const row = cbs[i]?.closest('tr') || cbs[i]?.closest('.row') || cbs[i]?.parentElement
    row?.scrollIntoView({ behavior: 'instant', block: 'center' })
  }, { today: TODAY, i: cbIdx }).catch(() => {})
  await page.waitForTimeout(300)
  return scr(page, label)
}

// ─── Karbantartás rögzítése ───────────────────────────────────────────────────
async function recordKarbantartas(page, slug, naploId, cbIdx, modalId, selectId, karbValue) {
  await page.goto(`${BASE}/${slug}/naplo/${naploId}`, { waitUntil: 'networkidle', timeout: 20_000 }).catch(() => {})
  await page.waitForTimeout(2000)
  if (await page.locator('.swal2-container').isVisible().catch(() => false)) {
    await page.locator('.swal2-confirm').click().catch(() => {})
    await page.waitForTimeout(500)
  }

  const CB_SEL = 'input[type="checkbox"]:not([disabled]):not([id*=control]):not([id*=qr]):not([id*=all])'
  const cbs = await page.locator(CB_SEL).all()
  if (cbs.length <= cbIdx) {
    return { ok: false, label: `Berendezés #${cbIdx + 1}`, reason: `Nincs ${cbIdx + 1}. checkbox (${cbs.length} db)` }
  }

  await cbs[cbIdx].evaluate(el => { el.checked = false })
  await cbs[cbIdx].check({ force: true }).catch(async () => {
    await page.evaluate((i) => {
      const cbs = [...document.querySelectorAll('input[type="checkbox"]:not([disabled])')]
        .filter(c => !c.id?.includes('control') && !c.id?.includes('qr') && !c.id?.includes('all'))
      if (cbs[i]) { cbs[i].checked = true; cbs[i].dispatchEvent(new Event('change', { bubbles: true })) }
    }, cbIdx)
  })
  await page.waitForTimeout(500)

  const cbLabel = await page.evaluate((i) => {
    const cbs = [...document.querySelectorAll('input[type="checkbox"]:not([disabled])')]
      .filter(c => !c.id?.includes('control') && !c.id?.includes('qr') && !c.id?.includes('all'))
    return cbs[i]?.closest('tr')?.innerText?.replace(/\s+/g, ' ').trim().slice(0, 60) || `Berendezés #${i + 1}`
  }, cbIdx)

  // deviceService modalhoz a wrench gombra kell kattintani, nem modal('show')
  // -- a modal('show') bypass-olja a Vue kontextust, ezért nincs device_id a POST-ban
  if (modalId === 'deviceService') {
    const wrenchBtn = await page.evaluate((i) => {
      const CB_SEL = 'input[type="checkbox"]:not([disabled]):not([id*=control]):not([id*=qr]):not([id*=all])'
      const cb = [...document.querySelectorAll(CB_SEL)][i]
      const row = cb?.closest('tr') || cb?.closest('[class*=row]') || cb?.parentElement
      const wrench = row?.querySelector('button i.fa-wrench, button .fa-wrench')
      return wrench ? true : false
    }, cbIdx)
    if (wrenchBtn) {
      const CB_SEL = 'input[type="checkbox"]:not([disabled]):not([id*=control]):not([id*=qr]):not([id*=all])'
      const cb = page.locator(CB_SEL).nth(cbIdx)
      const row = cb.locator('xpath=ancestor::tr[1]')
      await row.locator('button:has(i.fa-wrench)').first().click().catch(async () => {
        await page.evaluate((i) => {
          const cb = [...document.querySelectorAll('input[type="checkbox"]:not([disabled])')]
            .filter(c => !c.id?.includes('control') && !c.id?.includes('qr') && !c.id?.includes('all'))[i]
          const row = cb?.closest('tr') || cb?.parentElement
          const btn = row?.querySelector('button i.fa-wrench, button .fa-wrench')?.closest('button')
          btn?.click()
        }, cbIdx)
      })
    } else {
      await page.evaluate((mid) => { if (window.$) window.$(`#${mid}`).modal('show') }, modalId)
    }
  } else {
    await page.evaluate((mid) => { if (window.$) window.$(`#${mid}`).modal('show') }, modalId)
  }
  await page.waitForTimeout(2000)
  if (!(await page.locator(`#${modalId}`).isVisible().catch(() => false))) {
    return { ok: false, label: cbLabel, reason: `#${modalId} nem nyílt meg` }
  }

  // Típus Select2
  await page.evaluate(({ sid, kv, mid }) => {
    const sel = document.getElementById(sid) || document.querySelector(`#${mid} select`)
    if (sel) { sel.value = kv; sel.dispatchEvent(new Event('change', { bubbles: true })) }
    if (window.$) {
      if (window.$('#' + sid).data('select2')) window.$('#' + sid).val(kv).trigger('change')
      else window.$('#' + sid).trigger('change')
    }
  }, { sid: selectId, kv: karbValue, mid: modalId })
  await page.waitForTimeout(1500)

  // sub_type -- minden látható üres select kitöltése
  await page.evaluate((mid) => {
    const modal = document.getElementById(mid)
    modal?.querySelectorAll('select').forEach(s => {
      if (s.offsetParent !== null && (!s.value || s.value === '')) {
        s.value = s.options[0]?.value || '0'
        s.dispatchEvent(new Event('change', { bubbles: true }))
        if (window.$ && window.$(s).data('select2')) window.$(s).val(s.value).trigger('change')
      }
    })
  }, modalId)
  await page.waitForTimeout(400)

  // Dátum
  await page.evaluate(({ mid, today }) => {
    const modal = document.getElementById(mid)
    const el = modal?.querySelector('#created_at, input[name="created_at"], input.datepicker')
    if (el) {
      el.value = today
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
      if (window.$ && window.$(el).data('datepicker')) window.$(el).datepicker('setDate', today)
    }
  }, { mid: modalId, today: TODAY })

  await page.locator(`#${modalId} textarea, #${modalId} #comment, #${modalId} #service-comment`).first().fill('Automatizált karbantartás').catch(() => {})
  await scr(page, `${slug}_cb${cbIdx + 1}_filled`)

  // Submit -- Playwright .click() kell (isTrusted:true), page.evaluate .click() Vue @click handlert nem triggerel
  const saveSelectors = [
    `#demoDeviceServiceSaveButton`,
    `#demoSetServiceSaveButton`,
    `#saveButton`,
    `#${modalId} .modal-footer a.btn-success`,
    `#${modalId} .modal-footer a:not(.btn-danger)`,
    `#${modalId} button[type="submit"]`,
    `#${modalId} button.btn-success`,
  ]
  let clicked = false
  for (const sel of saveSelectors) {
    const loc = page.locator(sel).first()
    if (await loc.isVisible().catch(() => false)) {
      await loc.click()
      clicked = true
      break
    }
  }
  if (!clicked) {
    const mentesLoc = page.locator(`#${modalId} button, #${modalId} a`).filter({ hasText: /mentés|megfelelt/i }).first()
    if (await mentesLoc.isVisible().catch(() => false)) await mentesLoc.click()
  }
  await page.waitForTimeout(4000)

  const stillOpen = await page.locator(`#${modalId}`).isVisible().catch(() => false)
  const hasSwal = await page.locator('.swal2-container').isVisible().catch(() => false)
  if (hasSwal) { await page.locator('.swal2-confirm').click().catch(() => {}); await page.waitForTimeout(500) }

  if (!stillOpen || hasSwal) {
    await page.goto(`${BASE}/${slug}/naplo/${naploId}`, { waitUntil: 'networkidle', timeout: 15_000 }).catch(() => {})
    await page.waitForTimeout(1500)
    if (await page.locator('.swal2-container').isVisible().catch(() => false)) {
      await page.locator('.swal2-confirm').click().catch(() => {})
      await page.waitForTimeout(500)
    }
    await scrSavedRow(page, `${slug}_cb${cbIdx + 1}_verify`, cbIdx)
    return { ok: true, label: cbLabel, reason: 'Mentve' }
  }
  return { ok: false, label: cbLabel, reason: 'Modal nyitva maradt' }
}

// ─── Karbantartás opció felfedezése ──────────────────────────────────────────
async function discoverKarb(page, slug, naploId) {
  await page.goto(`${BASE}/${slug}/naplo/${naploId}`, { waitUntil: 'networkidle', timeout: 20_000 }).catch(() => {})
  await page.waitForTimeout(2000)
  if (await page.locator('.swal2-container').isVisible().catch(() => false)) {
    await page.locator('.swal2-confirm').click().catch(() => {})
    await page.waitForTimeout(500)
  }
  for (const mid of ['deviceService', 'setService']) {
    await page.evaluate((m) => { if (window.$) window.$(`#${m}`).modal('show') }, mid)
    await page.waitForTimeout(1500)
    if (!(await page.locator(`#${mid}`).isVisible().catch(() => false))) {
      await page.evaluate((m) => { if (window.$) window.$(`#${m}`).modal('hide') }, mid)
      continue
    }
    const result = await page.evaluate((m) => {
      const modal = document.getElementById(m)
      for (const sel of [...(modal?.querySelectorAll('select') || [])]) {
        const karbOpt = [...sel.options].find(o => /karbantart/i.test(o.text))
        if (karbOpt) return { modalId: m, selectId: sel.id, karbValue: karbOpt.value }
      }
      return { modalId: m, selectId: null, karbValue: null }
    }, mid)
    await page.evaluate((m) => { if (window.$) window.$(`#${m}`).modal('hide') }, mid)
    await page.waitForTimeout(500)
    if (result?.selectId) return result
  }
  return null
}

// ─── FŐ LOGIKA ───────────────────────────────────────────────────────────────

const TARGETS = [
  // Ismert modal konfig (korábbi tesztek alapján)
  { name: 'Tűzoltó készülékek', slug: 'tuzoltokeszulekek', modalId: 'deviceService', selectId: 'type',                karbValue: '2' },
  { name: 'Tűzgátló eszközök',  slug: 'tuzgatloeszkozok',  modalId: 'setService',    selectId: 'select_service_type', karbValue: '2' },
  { name: 'Defibrillátorok',    slug: 'defibrillatorok',   modalId: 'setService',    selectId: 'select_service_type', karbValue: '2' },
  { name: 'Aggregátorok',       slug: 'aggregatorok',      modalId: 'setService',    selectId: 'select_service_type', karbValue: '1' },
  { name: 'Tűzi vízforrások',   slug: 'tuzivizforrasok',   modalId: 'setService',    selectId: 'select_service_type', karbValue: '2' },
  { name: 'Füstgátló eszközök', slug: 'fustgatloeszkozok', modalId: 'setService',    selectId: 'select_service_type', karbValue: '2' },
  { name: 'Vészkijáratok',      slug: 'veszkijaratok',     modalId: null },
  { name: 'Világítások',        slug: 'vilagitasok',       modalId: null },
  // Oltórendszerek: "Időszakos felülvizsgálat és karbantartás" = value 0
  { name: 'Oltórendszerek',     slug: 'oltorendszerek',    modalId: 'setService',    selectId: 'select_service_type', karbValue: '0' },
]

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
const page = await ctx.newPage()
page.on('pageerror', () => {})
page.on('requestfailed', () => {})

console.log('Login...')
const loggedInUrl = await loginWithTwoFactor(page, BASE, config.email, config.password)
console.log(`Bejelentkezve: ${loggedInUrl}\n`)

const matrix = []
let totalOk = 0, totalAll = 0
const allPdfPages = []

for (const target of TARGETS) {
  console.log(`\n${'='.repeat(65)}`)
  console.log(`TÍPUS: ${target.name}`)
  console.log('='.repeat(65))

  // Napló linkek keresése
  await page.goto(`${BASE}/${target.slug}`, { waitUntil: 'networkidle', timeout: 20_000 }).catch(() => {})
  await page.waitForTimeout(2000)
  const naploLinks = await page.evaluate((s) =>
    [...new Set([...document.querySelectorAll(`a[href*="/${s}/naplo/"], a[href*="/naplo/"]`)].map(a => a.href))]
      .filter(h => /\/naplo\/\d+/.test(h))
  , target.slug)

  if (naploLinks.length === 0) {
    console.log('  ⚠️  Nincs napló link')
    matrix.push({ name: target.name, devices: [], error: 'Nincs napló' })
    continue
  }

  const naploId = naploLinks[0].match(/\/naplo\/(\d+)/)?.[1]

  // Modal konfig (felfedezés ha ismeretlen)
  let { modalId, selectId, karbValue } = target
  if (!modalId) {
    const disc = await discoverKarb(page, target.slug, naploId)
    if (!disc) {
      console.log('  ⚠️  Nincs Karbantartás opció')
      matrix.push({ name: target.name, devices: [], error: 'Nincs Karbantartás opció' })
      continue
    }
    modalId = disc.modalId; selectId = disc.selectId; karbValue = disc.karbValue
  }
  console.log(`  Modal: #${modalId} | select: ${selectId} | value: ${karbValue}`)

  // Checkboxok száma + napló screenshot
  await page.goto(`${BASE}/${target.slug}/naplo/${naploId}`, { waitUntil: 'networkidle', timeout: 20_000 }).catch(() => {})
  await page.waitForTimeout(2000)
  if (await page.locator('.swal2-container').isVisible().catch(() => false)) {
    await page.locator('.swal2-confirm').click().catch(() => {})
    await page.waitForTimeout(500)
  }
  const cbs = await page.locator('input[type="checkbox"]:not([disabled]):not([id*=control]):not([id*=qr]):not([id*=all])').all()
  console.log(`  Checkboxok: ${cbs.length}`)
  await scr(page, `${target.slug}_naplo_elott`)

  if (cbs.length === 0) {
    matrix.push({ name: target.name, devices: [], error: 'Nincs checkbox' })
    continue
  }

  // 2 berendezés Karbantartás rögzítése
  const typeResult = { name: target.name, devices: [], pdfPages: [] }
  const count = Math.min(cbs.length, 2)
  for (let i = 0; i < count; i++) {
    console.log(`  Berendezés #${i + 1}...`)
    const res = await recordKarbantartas(page, target.slug, naploId, i, modalId, selectId, karbValue)
    console.log(`  ${res.ok ? '✅' : '❌'} ${res.label?.slice(0, 50)} -- ${res.reason}`)
    typeResult.devices.push(res)
    totalAll++
    if (res.ok) totalOk++
  }

  // Napló PDF generálása RÖGZÍTÉS UTÁN (az új bejegyzések benne lesznek)
  console.log(`  📄 Napló PDF generálása...`)
  const pdfResult = await generateNaplopdf(page, target.slug, naploId)
  console.log(`  PDF: ${pdfResult.reason}`)
  typeResult.pdfPages = pdfResult.pages
  typeResult.pdfOk = pdfResult.ok
  typeResult.pdfFname = pdfResult.fname
  allPdfPages.push(...pdfResult.pages)

  matrix.push(typeResult)
}

await browser.close()

// ─── KONZOL ÖSSZESÍTŐ ─────────────────────────────────────────────────────────
console.log('\n\n' + '='.repeat(70))
console.log('NAGY TESZT ÖSSZESÍTŐ -- DEV PORTÁL')
console.log('='.repeat(70))
for (const t of matrix) {
  console.log(`\n${t.name}`)
  if (t.error) { console.log(`  ⚠️  ${t.error}`); continue }
  t.devices.forEach(d => console.log(`  ${d.ok ? '✅' : '❌'} ${d.label?.slice(0, 55)} -- ${d.reason}`))
  if (t.pdfOk) console.log(`  📄 PDF: ${t.pdfFname} (${t.pdfPages.length} lap)`)
}
console.log(`\n${'='.repeat(70)}`)
console.log(`ÖSSZESÍTŐ: ${totalOk}/${totalAll} berendezés rögzítve`)
console.log(`PDF lapok összesen: ${allPdfPages.length}`)
// Elválasztó a Telegram küldő scriptnek
console.log('ALL_PDF_PAGES:' + JSON.stringify(allPdfPages))
console.log('MATRIX_JSON:' + JSON.stringify(matrix.map(t => ({
  name: t.name,
  error: t.error,
  devices: t.devices?.map(d => ({ ok: d.ok, label: d.label?.slice(0, 50), reason: d.reason })),
  pdfOk: t.pdfOk,
  pdfPages: t.pdfPages?.length,
}))))
