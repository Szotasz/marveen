// DASHSOCKPEER1106 (Samu 72098, 72101; Dani 72099): marveen-mxd #89 took the owner's codes off dash.sock, so the
// dashboard's owner QR card always gets consent_required (mxd link.rs owner_secret_gate). The SAME code still comes from
// an agent's owner approval on a machine with a Bridge key (mxd link.rs owner_qr_proof), and the agents panel used to
// fall back to the shared gromzo.err.consent_required. So the shared key stays as it was, and each surface gets its own:
//  - the owner QR card: gromzo.qr.err.consent_required, the step (the phone QR is in the Marveen Bridge, the menu item
//    named as both shipped Bridges show it, 0.3.8 and 1.0.16, measured from their app.asar);
//  - the agents panel: gromzo.agents.err.consent_required, today's meaning (mxd cannot verify a Bridge consent yet: no
//    step for the owner exists, so "contact support" stays).
// The REAL errorText and agentErr from web/app.js run here with a t() over the real hu/en dictionaries.
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '../..')

let hu: Record<string, string>
let en: Record<string, string>
const APP = readFileSync(join(ROOT, 'web/app.js'), 'utf8')

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

describe('the owner QR card on consent_required: the step is in the Bridge (its own key)', () => {
  it('the card shows its own sentence: the Bridge, its Menu and the menu item exactly as shipped (hu, en)', () => {
    const h = real('errorText', hu)('consent_required')
    const e = real('errorText', en)('consent_required')
    expect(h).toBe(hu['gromzo.qr.err.consent_required'])
    expect(e).toBe(en['gromzo.qr.err.consent_required'])
    expect(h).toContain('Marveen Bridge')
    expect(h).toContain('Menü')
    expect(h).toContain('Gromzo app a telefonra (QR)')
    expect(e).toContain('Marveen Bridge')
    expect(e).toContain('Menu')
    expect(e).toContain('Gromzo app on your phone (QR)')
    for (const s of [h, e]) {
      expect(s).not.toMatch(/támogat|support/i)
      expect(s).not.toMatch(/\u2014|\u2013/)
    }
  })

  it('every other code still reads the shared key, and an unknown one the generic sentence', () => {
    expect(real('errorText', hu)('not_linked')).toBe(hu['gromzo.err.not_linked'])
    expect(real('errorText', en)('not_linked')).toBe(en['gromzo.err.not_linked'])
    expect(real('errorText', en)('brand_new_code')).toBe(en['gromzo.err.generic']!.replace('{code}', 'brand_new_code'))
  })
})

describe('the agents panel on consent_required: today\'s meaning (its own key)', () => {
  it('shows the agent sentence, never the owner QR step', () => {
    const h = real('agentErr', hu)('consent_required')
    const e = real('agentErr', en)('consent_required')
    expect(h).toBe(OLD_HU)
    expect(e).toBe(OLD_EN)
    expect(h).not.toBe(hu['gromzo.qr.err.consent_required'])
    expect(e).not.toBe(en['gromzo.qr.err.consent_required'])
  })

  it('the shared key is unchanged (Samu 72101: do not rewrite it)', () => {
    expect(hu['gromzo.err.consent_required']).toBe(OLD_HU)
    expect(en['gromzo.err.consent_required']).toBe(OLD_EN)
    expect(hu['gromzo.agents.err.consent_required']).toBe(OLD_HU)
    expect(en['gromzo.agents.err.consent_required']).toBe(OLD_EN)
  })
})
