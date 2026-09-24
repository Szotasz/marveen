// LANGDASH924: no customer-visible language value carries a dash, in either
// language. House rule: no dash of any kind in user-facing copy. UIDASH924
// (#1538) pinned two strings; Geri's sweep then found 26 more per language
// using ' -- ' as a dash (federation, onboarding, settings, auth...). This pins
// EVERY value, so a new string with a dash fails here instead of shipping.
//
// What counts as a dash: an em dash, an en dash, or a double hyphen WITH
// whitespace on both sides. A CLI flag (`--channels`) or a CSS variable
// (`var(--text-muted)`) is not a dash and stays allowed.
import { describe, it, expect, beforeAll } from 'vitest'

let hu: Record<string, unknown>
let en: Record<string, unknown>

beforeAll(async () => {
  ;(globalThis as unknown as { window: Record<string, unknown> }).window ||= {} as Record<string, unknown>
  await import(/* @vite-ignore */ '../../web/lang/hu.js' as string)
  await import(/* @vite-ignore */ '../../web/lang/en.js' as string)
  const i18n = (globalThis as unknown as { window: { _i18n: Record<string, Record<string, unknown>> } }).window._i18n
  hu = i18n.hu
  en = i18n.en
})

const DASH = /\s--\s|\u2014|\u2013/

function offenders(dict: Record<string, unknown>): string[] {
  return Object.entries(dict)
    .filter(([, v]) => typeof v === 'string' && DASH.test(v))
    .map(([k]) => k)
}

describe('language values carry no dash (LANGDASH924)', () => {
  it('the dictionaries loaded and are non-trivial (the scan below is not empty by accident)', () => {
    expect(Object.keys(hu).length).toBeGreaterThan(500)
    expect(Object.keys(en).length).toBeGreaterThan(500)
  })

  it('hu: no value carries an em dash, an en dash or a spaced double hyphen', () => {
    expect(offenders(hu)).toEqual([])
  })

  it('en: no value carries an em dash, an en dash or a spaced double hyphen', () => {
    expect(offenders(en)).toEqual([])
  })

  it('the pattern flags a dash and leaves flags and CSS variables alone', () => {
    expect(DASH.test('Mentve -- újraindítás')).toBe(true)
    expect(DASH.test('Saved \u2014 restart')).toBe(true)
    expect(DASH.test('1\u20132')).toBe(true)
    expect(DASH.test('runs in the --channels session')).toBe(false)
    expect(DASH.test('<p style="color:var(--text-muted)">')).toBe(false)
  })
})
