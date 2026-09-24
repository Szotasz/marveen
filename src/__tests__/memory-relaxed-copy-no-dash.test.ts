// UIDASH924: the relaxed-search explanation under "Ez mentett közelítés, nem
// találat." shipped a double hyphen as a dash (#1383), on a surface every
// owner sees. House rule: no dash of any kind in user-facing copy. This pins
// the two strings that carried it, in both languages; the loader is the
// lang-parity idiom (shim window, import the classic scripts).
import { describe, it, expect, beforeAll } from 'vitest'

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

const KEYS = ['memories.relaxed.title', 'memories.relaxed.body']
const DASH = /\s--\s|—|–/

describe('memory search relaxed-result copy carries no dash (UIDASH924)', () => {
  for (const key of KEYS) {
    it(`hu ${key}`, () => {
      expect(hu[key], `missing hu ${key}`).toBeTypeOf('string')
      expect(hu[key]).not.toMatch(DASH)
    })
    it(`en ${key}`, () => {
      expect(en[key], `missing en ${key}`).toBeTypeOf('string')
      expect(en[key]).not.toMatch(DASH)
    })
  }
})
