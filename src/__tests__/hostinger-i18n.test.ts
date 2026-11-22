// HOSTINGERI18N1122: the Hostinger VPS team found the sign-in page in Hungarian on an English Docker install, and
// Hungarian text left in the English dashboard. These guards pin the static half of the fix: every i18n key the page
// names exists in both languages, the English value of those keys has no Hungarian letters, no Hungarian text sits in
// the page without an i18n attribute (beyond the ones app.js translates by hand), and the sign-in page reads its
// language from the public status endpoint.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { parse } from 'parse5'

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf-8')
const APP = read('../../web/app.js')
const HTML = read('../../web/index.html')

const loadDict = (lang: 'hu' | 'en'): Record<string, string> => {
  const sandbox = { window: {} as { _i18n?: Record<string, Record<string, string>> } }
  vm.runInNewContext(read(`../../web/lang/${lang}.js`), sandbox)
  return sandbox.window._i18n![lang]
}
const HU = loadDict('hu')
const EN = loadDict('en')

const ATTRS = ['data-i18n', 'data-i18n-placeholder', 'data-i18n-title', 'data-i18n-aria-label', 'data-i18n-html']
const htmlKeys = (): Set<string> => {
  const keys = new Set<string>()
  for (const attr of ATTRS) {
    for (const m of HTML.matchAll(new RegExp(`\\s${attr}="([^"]+)"`, 'g'))) keys.add(m[1])
  }
  return keys
}
const HUNGARIAN_LETTERS = /[áéíóöőúüűÁÉÍÓÖŐÚÜŰ]/
// HOSTINGERLANGFU1122 (Samu 82940): the unaccented Hungarian "pl." (for example) slipped past the letter check.
const looksHungarian = (v: string) => HUNGARIAN_LETTERS.test(v) || /(^|[\s(])pl\.\s/.test(v)

describe('HOSTINGERI18N1122: index.html i18n keys', () => {
  const keys = htmlKeys()

  it('the page names a realistic number of keys', () => {
    expect(keys.size).toBeGreaterThan(500)
  })

  it('every key the page names exists in both dictionaries (else the raw key shows)', () => {
    const missing = [...keys].filter(k => !(k in HU) || !(k in EN)).sort()
    expect(missing).toEqual([])
  })

  it('the English value of every key the page names has no Hungarian letters', () => {
    const hungarian = [...keys].filter(k => typeof EN[k] === 'string' && HUNGARIAN_LETTERS.test(EN[k])).sort()
    expect(hungarian).toEqual([])
  })

  it('no data-i18n-ph attribute: nothing reads it, the placeholder stayed untranslated', () => {
    expect(HTML).not.toContain('data-i18n-ph=')
  })

  it('the four keys that were missing in both languages exist', () => {
    for (const k of ['connectors.tooltip.docs', 'autonomy.level.1', 'ideas.toast.score_saved_error', 'connectors.env_modal.desc']) {
      expect(HU[k], k).toBeTruthy()
      expect(EN[k], k).toBeTruthy()
    }
  })
})

// Hungarian text the page carries with no i18n attribute is shown as-is in English, unless app.js translates it by
// hand. These are the ones it does (nav labels, kanban column titles and page headers in renderNav/renderStaticI18n,
// #teamHint, #updatesSubtitle, #fedPeerModalTitle on open), measured with a runtime crawl in English. Anything else is new
// raw Hungarian: give it a data-i18n* attribute.
const TRANSLATED_BY_JS = new Set([
  'Áttekintés', 'Jóváhagyások', 'Ügynökök', 'Üzenetek', 'Ütemezések', 'Háttér', 'Memória', 'Napló', 'Ötletláda', 'Költségek',
  'Státusz', 'Frissítések', 'Beállítások', 'Föderáció', 'Költöztetés', 'Dokumentáció', 'Várakozik', 'Tesztelés', 'Kész',
  'CLI-eszközök', 'Titkosított API-kulcsok, tokenek és SSH-kulcsok', 'Marveen verzió ellenőrzés', 'Társ hozzáadása',
])
type Node5 = { nodeName: string; value?: string; attrs?: { name: string; value: string }[]; childNodes?: Node5[]; content?: Node5 }
const rawHungarian = (): string[] => {
  const out: string[] = []
  const has = (n: Node5, a: string) => (n.attrs ?? []).some(x => x.name === a)
  const walk = (n: Node5, covered: boolean) => {
    if (n.nodeName === 'script' || n.nodeName === 'style') return
    const cov = covered || has(n, 'data-i18n') || has(n, 'data-i18n-html')
    for (const a of n.attrs ?? []) {
      if (['placeholder', 'title', 'aria-label'].includes(a.name) && looksHungarian(a.value) && !has(n, `data-i18n-${a.name}`)) out.push(`${a.name}="${a.value}"`)
    }
    if (n.nodeName === '#text' && !cov && looksHungarian(n.value ?? '')) {
      const text = (n.value ?? '').trim().replace(/\s+/g, ' ')
      if (!TRANSLATED_BY_JS.has(text) && !(text.startsWith('A szerep és a beosztott'))) out.push(text)
    }
    for (const c of n.childNodes ?? []) walk(c, cov)
    if (n.content) walk(n.content, cov)
  }
  walk(parse(HTML) as unknown as Node5, false)
  return out
}

describe('HOSTINGERI18N1122: raw Hungarian in index.html', () => {
  it('no Hungarian text or placeholder/title/aria-label without an i18n attribute, beyond the JS-translated ones', () => {
    expect(rawHungarian()).toEqual([])
  })
})

describe('HOSTINGERI18N1122: the sign-in page language', () => {
  const boot = APP.slice(APP.indexOf('// === i18n runtime ==='), APP.indexOf('queueMicrotask(() => {') + 1200)

  it('the i18n bootstrap reads the server default from the public /api/auth/status, not the guarded /api/settings', () => {
    expect(boot).toContain("fetch('/api/auth/status')")
    expect(boot).toContain('data.lang')
    expect(boot).not.toContain("fetch('/api/settings')")
  })
})
