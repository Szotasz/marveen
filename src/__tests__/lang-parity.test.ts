// Guards the bilingual contract of the dashboard. Nothing enforced hu/en
// parity before this test: a key added to only one file silently rendered as
// the raw key string in the other language (t() falls back hu->en->key).
// The loader shim is the brand-completeness idiom: shim window, import the
// classic scripts for their window._i18n side effect.
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

let hu: Record<string, string>
let en: Record<string, string>

beforeAll(async () => {
  ;(globalThis as unknown as { window: Record<string, unknown> }).window ||= {} as Record<string, unknown>
  await import(/* @vite-ignore */ '../../web/lang/hu.js' as string)
  await import(/* @vite-ignore */ '../../web/lang/en.js' as string)
  const i18n = (globalThis as unknown as { window: { _i18n: Record<string, Record<string, string>> } }).window._i18n
  hu = i18n.hu
  en = i18n.en
})

describe('lang parity (hu.js vs en.js)', () => {
  it('the two files define the exact same key set', () => {
    const huKeys = new Set(Object.keys(hu))
    const enKeys = new Set(Object.keys(en))
    const huOnly = [...huKeys].filter((k) => !enKeys.has(k))
    const enOnly = [...enKeys].filter((k) => !huKeys.has(k))
    expect(huOnly, 'keys missing from en.js').toEqual([])
    expect(enOnly, 'keys missing from hu.js').toEqual([])
  })

  it('matching keys carry the same {placeholder} token sets', () => {
    const tokens = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',')
    const mismatches: string[] = []
    for (const key of Object.keys(hu)) {
      if (!(key in en)) continue
      if (tokens(hu[key]) !== tokens(en[key])) mismatches.push(`${key}: hu[${tokens(hu[key])}] vs en[${tokens(en[key])}]`)
    }
    expect(mismatches).toEqual([])
  })

  it('no duplicate key literals within either source file (object-literal last-wins hides them)', () => {
    for (const lang of ['hu', 'en']) {
      const src = readFileSync(join(__dirname, `../../web/lang/${lang}.js`), 'utf-8')
      const keys = [...src.matchAll(/^\s*'([^']+)':/gm)].map((m) => m[1])
      const seen = new Set<string>()
      const dupes: string[] = []
      for (const k of keys) {
        if (seen.has(k)) dupes.push(k)
        seen.add(k)
      }
      expect(dupes, `${lang}.js duplicate keys`).toEqual([])
    }
  })

  it('no empty values', () => {
    for (const [k, v] of Object.entries(hu)) expect(v, `hu ${k}`).toBeTruthy()
    for (const [k, v] of Object.entries(en)) expect(v, `en ${k}`).toBeTruthy()
  })
})
