import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import {
  SUPPORT_CONSENT_LANGS,
  SUPPORT_CONSENT_LAUNCHER_LANG,
  SUPPORT_CONSENT_TEXTS,
  supportConsentLangOf,
  supportConsentSha256,
  supportConsentText,
} from '../support-consent-text.js'
import { SUPPORT_CONSENT_VERSION } from '../support-standby-enable.js'

// The marveen.io server accepts these sha256 values for '2:hu' and '2:en' (supabase/functions/_shared/
// support-consent.ts, Tomi 79448): the machine's version 2 is the same text in each language, so the values must stay
// equal (Mira 79456, Samu 79453). If either side moves, this fails.
const SERVER_SHA256_V2 = {
  hu: '1edde713149d360f3aef27d51e3e379557ece268f8716380acbfee7621e1152b',
  en: '77decc75121d9a0aaf22a0a63983488574dd122320def7d363a2ecce04a80703',
} as const
const BYTES_V2 = { hu: 1477, en: 1344 } as const
const HEADINGS_V2 = {
  hu: ['Mit tehetünk a gépeden', 'Mit látunk', 'Nyom és ellenőrzés'],
  en: ['What we can do on your machine', 'What we see', 'Record and control'],
} as const

describe('the consent text by version (Geri 78479)', () => {
  it('has a place for every version this release knows, and none past it', () => {
    expect(Object.keys(SUPPORT_CONSENT_TEXTS).map(Number)).toEqual(Array.from({ length: SUPPORT_CONSENT_VERSION }, (_, i) => i + 1))
  })

  it('refuses a version it does not know, and a known one whose approved text is not in the source', () => {
    for (const v of [0, -1, 1.5, SUPPORT_CONSENT_VERSION + 1, Number.NaN]) expect(supportConsentText(v)).toEqual({ ok: false, problem: 'consent_invalid' })
    expect(SUPPORT_CONSENT_TEXTS[1]).toBeNull()
    expect(supportConsentText(1)).toEqual({ ok: false, problem: 'consent_text_unset' })
    expect(supportConsentText(1, 'en')).toEqual({ ok: false, problem: 'consent_text_unset' })
  })

  it('the launcher speaks Hungarian, and its text is the default', () => {
    expect(SUPPORT_CONSENT_LAUNCHER_LANG).toBe('hu')
    expect(supportConsentText(2)).toEqual(supportConsentText(2, 'hu'))
  })

  it('a locale is a consent language only when it is exactly hu or en', () => {
    expect(supportConsentLangOf('hu')).toBe('hu')
    expect(supportConsentLangOf('en')).toBe('en')
    for (const x of ['HU', 'de', 'hu-HU', '', null, undefined, 1]) expect(supportConsentLangOf(x)).toBeNull()
  })
})

describe('consent version 2: the approved text in both languages, the same as marveen.io shows (Mira 79450 / 79456, Tomi 79448)', () => {
  it('this release enables version 2, in hu and en', () => {
    expect(SUPPORT_CONSENT_VERSION).toBe(2)
    expect(Object.keys(SUPPORT_CONSENT_TEXTS[2] ?? {}).sort()).toEqual([...SUPPORT_CONSENT_LANGS].sort())
  })

  for (const lang of SUPPORT_CONSENT_LANGS) {
    describe(lang, () => {
      const text = (SUPPORT_CONSENT_TEXTS[2] as Record<string, string>)[lang]

      it('is the dictionary shape: 9 lines joined with LF, no CR, no empty line, no line end at the end, NFC', () => {
        expect(typeof text).toBe('string')
        expect(text.split('\n')).toHaveLength(9)
        expect(text).not.toContain('\r')
        expect(text.split('\n').every((l) => l.length > 0)).toBe(true)
        expect(text.endsWith('\n')).toBe(false)
        expect(text.normalize('NFC')).toBe(text)
        expect(Buffer.byteLength(text, 'utf8')).toBe(BYTES_V2[lang])
        expect(text.split('\n').filter((_, i) => i === 0 || i === 3 || i === 6)).toEqual([...HEADINGS_V2[lang]])
      })

      it("its sha256 is the server's value, computed from the bytes without a line end", () => {
        expect(createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')).toBe(SERVER_SHA256_V2[lang])
        expect(supportConsentSha256(2, lang)).toBe(SERVER_SHA256_V2[lang])
      })

      it('prints with exactly one line end, and the printed form is not what is hashed', () => {
        expect(supportConsentText(2, lang)).toEqual({ ok: true, text: text + '\n' })
        expect(createHash('sha256').update(text + '\n').digest('hex')).not.toBe(SERVER_SHA256_V2[lang])
      })

      it('carries no draft marker', () => {
        for (const marker of ['[', ']', '**', 'JELÖLT', 'GAZDA-DÖNTÉS']) expect(text).not.toContain(marker)
      })
    })
  }

  it('no sha256 without an approved text, an unknown version, or without a language', () => {
    for (const v of [1, 0, 3, Number.NaN]) for (const l of SUPPORT_CONSENT_LANGS) expect(supportConsentSha256(v, l)).toBeNull()
    expect(supportConsentSha256(2, null)).toBeNull()
  })

  it('the Hungarian text carries the owner-decided sentences, and not the command list on the Profile', () => {
    const hu = (SUPPORT_CONSENT_TEXTS[2] as Record<string, string>).hu
    expect(hu).toContain('ennél több jogot nem szerzünk')
    expect(hu).toContain('Egy kapcsolaton legfeljebb 60 percig adhatunk ki parancsot')
    expect(hu).toContain('Az engedett belépésekről e-mailt kapsz.')
    expect(hu).not.toContain('Profil oldaladon is látod')
  })
})
