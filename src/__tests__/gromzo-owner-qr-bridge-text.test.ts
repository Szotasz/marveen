// GROMZOBRIDGEWIZARD1107 D5a: the dashboard's Gromzo card after the Bridge wizard (marveen-bridge #56, installer #145).
// The phone hookup, the owner QR and a new phone's code are the Marveen Bridge's (Menu, "Gromzo bekötése" /
// "Connect Gromzo"). The card's own owner QR is gone: since marveen-mxd #89 dash.sock never hands out the owner's codes,
// so its "Add a phone" button always ended on consent_required, and that sentence named a Bridge menu item ("Gromzo app
// a telefonra (QR)") that no Bridge main has any more. Pinned here: the card has no QR surface left, its texts point at
// the wizard, and the agents panel keeps its own consent_required sentence (DASHSOCKPEER1106, Samu 72101).
// The REAL agentErr from web/app.js runs here with a t() over the real hu/en dictionaries.
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '../..')

let hu: Record<string, string>
let en: Record<string, string>
const APP = readFileSync(join(ROOT, 'web/app.js'), 'utf8')
const INDEX = readFileSync(join(ROOT, 'web/index.html'), 'utf8')

/** A named function's full source from app.js (balanced braces from its `function name(` line). */
function fnSource(name: string): string {
  const start = APP.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`no ${name} in app.js`)
  let depth = 0
  for (let i = APP.indexOf('{', start); i < APP.length; i++) {
    if (APP[i] === '{') depth++
    else if (APP[i] === '}' && --depth === 0) return APP.slice(start, i + 1)
  }
  throw new Error(`unbalanced ${name}`)
}

/** The real function, with t() over one dictionary (unknown key -> the key, like the app's t). */
function real(name: string, dict: Record<string, string>): (code: string) => string {
  const t = (key: string, params?: Record<string, string>) => {
    let s = dict[key] ?? key
    if (params) for (const [k, v] of Object.entries(params)) s = s.replace(`{${k}}`, v)
    return s
  }
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function('t', `${fnSource(name)}; return ${name}`)(t) as (code: string) => string
}

beforeAll(async () => {
  ;(globalThis as unknown as { window: Record<string, unknown> }).window ||= {} as Record<string, unknown>
  await import(/* @vite-ignore */ '../../web/lang/hu.js' as string)
  await import(/* @vite-ignore */ '../../web/lang/en.js' as string)
  const i18n = (globalThis as unknown as { window: { _i18n: Record<string, Record<string, string>> } }).window._i18n
  hu = i18n.hu!
  en = i18n.en!
})

const OLD_HU = 'Ezen a gépen Bridge-kulcs van beállítva, ezért a dashboard most nem kérhet tulajdonosi kódot. Szólj a támogatásnak.'
const OLD_EN = 'A Bridge key is configured on this machine, so the dashboard cannot request an owner code right now. Contact support.'

describe('D5a: the card has no owner QR of its own; it points at the Bridge wizard', () => {
  it('no add-phone button, no QR area, no owner-qr call, nothing to wipe', () => {
    for (const id of ['gromzoAddPhoneBtn', 'gromzoQrArea', 'gromzoQr', 'gromzoQrClose', 'gromzoCountdown', 'gromzoError']) {
      expect(INDEX.includes(`id="${id}"`)).toBe(false)
    }
    expect(APP).not.toMatch(/\/api\/gromzo\/owner-qr/)
    expect(APP).not.toMatch(/clearGromzoQr|gromzoAddPhoneBtn/)
    // the card still shows the link status (the agents panel is its own module)
    expect(APP).toMatch(/window\.loadGromzoCard = loadStatus/)
    expect(INDEX).toMatch(/id="gromzoStatus"/)
  })

  it('no text of the old QR surface is left in either language', () => {
    for (const d of [hu, en]) {
      const left = Object.keys(d).filter((k) => k.startsWith('gromzo.qr.') || k === 'gromzo.btn.add_phone' || k === 'gromzo.btn.hide')
      expect(left).toEqual([])
    }
  })

  it('the card and the Bridge-pointing sentences name the wizard, never a retired menu item (hu, en)', () => {
    const keys = ['gromzo.card.desc', 'gromzo.status.link_expired', 'gromzo.status.link_owner_mismatch', 'gromzo.agents.main.marketplace_failed']
    for (const k of keys) {
      expect(hu[k]).toContain('Marveen Bridge')
      expect(hu[k]).toContain('Gromzo bekötése')
      expect(en[k]).toContain('Marveen Bridge')
      expect(en[k]).toContain('Connect Gromzo')
    }
    expect(hu['gromzo.card.desc']).toContain('Menü (⋮)')
    expect(en['gromzo.card.desc']).toContain('Menu (⋮)')
    const all = [...Object.entries(hu), ...Object.entries(en)].filter(([k]) => k.startsWith('gromzo.')).map(([, v]) => v).join('\n')
    for (const gone of ['Gromzo app a telefonra', 'Gromzo app on your phone', 'Gromzo-lapján', 'Gromzo tab', 'Telefon hozzáadása', 'Add a phone']) {
      expect(all).not.toContain(gone)
    }
    // the owner sign-in is for the agents only now
    expect(hu['gromzo.owner_login.info']).not.toMatch(/telefon/)
    expect(en['gromzo.owner_login.info']).not.toMatch(/phone/)
    expect(all).not.toMatch(/\u2014|\u2013/)
  })
})

describe('the agents panel on consent_required: today\'s meaning (its own key)', () => {
  it('shows the agent sentence (today\'s meaning), not a Bridge step', () => {
    const h = real('agentErr', hu)('consent_required')
    const e = real('agentErr', en)('consent_required')
    expect(h).toBe(OLD_HU)
    expect(e).toBe(OLD_EN)
    expect(h).not.toMatch(/Bridge-ben kéred/)
    expect(e).not.toMatch(/in the Marveen Bridge/)
  })

  it('the shared key is unchanged (Samu 72101: do not rewrite it)', () => {
    expect(hu['gromzo.err.consent_required']).toBe(OLD_HU)
    expect(en['gromzo.err.consent_required']).toBe(OLD_EN)
    expect(hu['gromzo.agents.err.consent_required']).toBe(OLD_HU)
    expect(en['gromzo.agents.err.consent_required']).toBe(OLD_EN)
  })
})
