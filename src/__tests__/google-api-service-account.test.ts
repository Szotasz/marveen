import { describe, expect, it } from 'vitest'
import { generateKeyPairSync, createVerify } from 'node:crypto'
import { buildServiceAccountJwt } from '../google-api.js'

// Why a service-account path exists at all (2026-08-20): the OAuth app sits in
// Google's "Testing" state, where the refresh token dies every 7 days, and
// publishing it is gated behind verification because the app asks for
// RESTRICTED scopes (gmail.modify, drive.readonly). A service account has no
// consent screen and no expiry, so Calendar and Drive move onto it.
//
// The assertion is the whole contract with Google and it is checkable with no
// network at all: build it, then verify the signature with the matching public
// key and read the claims back. A test that only asserted "returns a string"
// would pass on an assertion Google rejects.

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
})

const SA = {
  client_email: 'marveen@marveen-assistant-2026.iam.gserviceaccount.com',
  private_key: privateKey,
}

const SCOPES = 'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/drive.readonly'

/** Decode a base64url JWT segment back to an object. */
function decodeSegment(segment: string): Record<string, unknown> {
  const b64 = segment.replace(/-/g, '+').replace(/_/g, '/')
  return JSON.parse(Buffer.from(b64, 'base64').toString('utf-8'))
}

describe('buildServiceAccountJwt', () => {
  const NOW = Date.UTC(2026, 7, 20, 10, 0, 0)

  it('produces a three-segment JWT', () => {
    const jwt = buildServiceAccountJwt(SA, SCOPES, NOW)
    expect(jwt.split('.')).toHaveLength(3)
  })

  it('signs with RS256 over header.claims, verifiable by the matching public key', () => {
    // The signature is the part Google actually checks. Verify it here rather
    // than asserting the string is non-empty.
    const jwt = buildServiceAccountJwt(SA, SCOPES, NOW)
    const [header, claims, signature] = jwt.split('.')
    const sig = Buffer.from(signature.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
    const ok = createVerify('RSA-SHA256').update(`${header}.${claims}`).verify(publicKey, sig)
    expect(ok).toBe(true)
  })

  it('declares RS256 in the header (Google rejects anything else here)', () => {
    const [header] = buildServiceAccountJwt(SA, SCOPES, NOW).split('.')
    expect(decodeSegment(header)).toEqual({ alg: 'RS256', typ: 'JWT' })
  })

  it('carries iss, scope and aud exactly as Google expects', () => {
    const [, claims] = buildServiceAccountJwt(SA, SCOPES, NOW).split('.')
    const payload = decodeSegment(claims)
    expect(payload.iss).toBe(SA.client_email)
    expect(payload.scope).toBe(SCOPES)
    expect(payload.aud).toBe('https://oauth2.googleapis.com/token')
  })

  it('honours a token_uri override in the key file as the audience', () => {
    // Google ships token_uri in the key JSON; if we ignore it and the value
    // ever changes, every assertion is rejected for a wrong audience.
    const jwt = buildServiceAccountJwt(
      { ...SA, token_uri: 'https://oauth2.example.test/token' },
      SCOPES,
      NOW,
    )
    expect(decodeSegment(jwt.split('.')[1]).aud).toBe('https://oauth2.example.test/token')
  })

  it('backdates iat so clock skew cannot make the assertion future-dated', () => {
    // Google rejects an assertion whose iat is in the future. A machine a few
    // seconds fast would fail every request, intermittently and confusingly.
    const payload = decodeSegment(buildServiceAccountJwt(SA, SCOPES, NOW).split('.')[1])
    expect(payload.iat).toBe(Math.floor(NOW / 1000) - 10)
    expect(payload.iat as number).toBeLessThan(Math.floor(NOW / 1000))
  })

  it('expires one hour after iat (Google caps the assertion lifetime there)', () => {
    const payload = decodeSegment(buildServiceAccountJwt(SA, SCOPES, NOW).split('.')[1])
    expect((payload.exp as number) - (payload.iat as number)).toBe(3600)
  })

  it('emits base64url, never plain base64 (a stray + or / breaks the token endpoint)', () => {
    // Run several timestamps: the padding and the alphabet only diverge for
    // some payloads, so a single sample can pass on a broken encoder.
    for (let i = 0; i < 12; i++) {
      const jwt = buildServiceAccountJwt(SA, SCOPES, NOW + i * 1000)
      expect(jwt).not.toMatch(/[+/=]/)
    }
  })
})
