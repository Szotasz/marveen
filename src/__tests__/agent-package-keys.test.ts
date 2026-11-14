import { describe, expect, it } from 'vitest'
import { RELEASED_KEYS } from '../web/agent-package/keys.js'
import { verifyDelivery } from '../web/agent-package/verify.js'
import { makeDeliveryCases } from './helpers/agent-package-delivery-cases.js'
import { makeKeyPair, makeSignedDelivery } from './helpers/make-delivery.js'

// Plan 9.1 pinning tests (1), (2) and the key-list half of (4). Changing the
// released key list is a deliberate edit of PINNED_RELEASED_KEYS below, in the
// same commit as keys.ts; nothing else should ever make this test red.

/** kid + x of every released key. EMPTY until the publisher hands over the public key (N3). */
const PINNED_RELEASED_KEYS: ReadonlyArray<{ kid: string; x: string }> = []

describe('RELEASED_KEYS', () => {
  it('(1) its kid and x pairs equal the pinned set', () => {
    const got = RELEASED_KEYS.map((k) => `${k.kid}\n${k.x}`).sort()
    const want = PINNED_RELEASED_KEYS.map((k) => `${k.kid}\n${k.x}`).sort()
    expect(got).toEqual(want)
  })

  it('every entry has the contract JWK shape and nothing else', () => {
    for (const k of RELEASED_KEYS) {
      expect(Object.keys(k).sort()).toEqual(['crv', 'kid', 'kty', 'x'])
      expect(k.kty).toBe('OKP')
      expect(k.crv).toBe('Ed25519')
    }
  })

  it('(4) every kid in the list is unique', () => {
    expect(new Set(RELEASED_KEYS.map((k) => k.kid)).size).toBe(RELEASED_KEYS.length)
  })

  it('(2) no test key is in it, and a test-signed package is refused with unknown_kid', () => {
    const { keys, signer } = makeDeliveryCases()
    const testKey = makeKeyPair()
    for (const k of [...keys, testKey.jwk]) {
      expect(RELEASED_KEYS.some((r) => r.kid === k.kid || r.x === k.x)).toBe(false)
    }
    const got = verifyDelivery(
      makeSignedDelivery({ kid: signer.kid, privateKey: signer.privateKey, slug: 'invoice-helper' }),
      'invoice-helper',
      RELEASED_KEYS,
    )
    expect(got).toEqual({ ok: false, step: 1, reason: 'unknown_kid' })
  })

  it('is frozen', () => {
    expect(Object.isFrozen(RELEASED_KEYS)).toBe(true)
  })
})
