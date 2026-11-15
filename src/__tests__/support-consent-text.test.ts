import { describe, it, expect } from 'vitest'
import { SUPPORT_CONSENT_TEXTS, supportConsentText } from '../support-consent-text.js'
import { SUPPORT_CONSENT_VERSION } from '../support-standby-enable.js'

describe('the consent text by version (Geri 78479)', () => {
  it('has a place for every version this release knows, and none past it', () => {
    expect(Object.keys(SUPPORT_CONSENT_TEXTS).map(Number)).toEqual(Array.from({ length: SUPPORT_CONSENT_VERSION }, (_, i) => i + 1))
  })

  it('refuses a version it does not know, and a known one whose approved text is not in the source', () => {
    for (const v of [0, -1, 1.5, SUPPORT_CONSENT_VERSION + 1, Number.NaN]) expect(supportConsentText(v)).toEqual({ ok: false, problem: 'consent_invalid' })
    expect(SUPPORT_CONSENT_TEXTS[1]).toBeNull()
    expect(supportConsentText(1)).toEqual({ ok: false, problem: 'consent_text_unset' })
  })
})
