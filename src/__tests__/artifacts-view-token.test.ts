import { describe, it, expect, afterEach } from 'vitest'
import { signViewToken, verifyViewToken } from '../web/view-token.js'

const NOW = 1_700_000_000

afterEach(() => {
  delete process.env['ARTIFACT_HMAC_SECRET']
})

describe('signViewToken', () => {
  it('returns a 64-char hex token and an exp 5 minutes in the future', () => {
    const { token, exp } = signViewToken('artifact-id-1', NOW)
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect(exp).toBe(NOW + 300)
  })

  it('produces different tokens for different artifact IDs', () => {
    const { token: t1 } = signViewToken('artifact-id-1', NOW)
    const { token: t2 } = signViewToken('artifact-id-2', NOW)
    expect(t1).not.toBe(t2)
  })
})

describe('verifyViewToken', () => {
  it('returns true for a valid token within TTL', () => {
    const { token, exp } = signViewToken('artifact-id-1', NOW)
    expect(verifyViewToken('artifact-id-1', token, exp, NOW + 60)).toBe(true)
  })

  it('returns false for an expired token', () => {
    const { token, exp } = signViewToken('artifact-id-1', NOW)
    expect(verifyViewToken('artifact-id-1', token, exp, NOW + 301)).toBe(false)
  })

  it('returns false when the artifact ID does not match', () => {
    const { token, exp } = signViewToken('artifact-id-1', NOW)
    expect(verifyViewToken('artifact-id-DIFFERENT', token, exp, NOW + 60)).toBe(false)
  })

  it('returns false for a tampered token (wrong hex)', () => {
    const { token, exp } = signViewToken('artifact-id-1', NOW)
    const tampered = token.replace(token[0], token[0] === 'a' ? 'b' : 'a')
    expect(verifyViewToken('artifact-id-1', tampered, exp, NOW + 60)).toBe(false)
  })

  it('returns false for a token with wrong length', () => {
    const { exp } = signViewToken('artifact-id-1', NOW)
    expect(verifyViewToken('artifact-id-1', 'short', exp, NOW + 60)).toBe(false)
  })
})

describe('ARTIFACT_HMAC_SECRET env var', () => {
  it('tokens signed with a custom secret verify successfully with the same secret', () => {
    process.env['ARTIFACT_HMAC_SECRET'] = 'test-secret-alpha'
    const { token, exp } = signViewToken('artifact-id-1', NOW)
    expect(verifyViewToken('artifact-id-1', token, exp, NOW + 60)).toBe(true)
  })

  it('tokens signed with secret-A fail verification after secret changes to secret-B', () => {
    process.env['ARTIFACT_HMAC_SECRET'] = 'test-secret-alpha'
    const { token, exp } = signViewToken('artifact-id-1', NOW)

    process.env['ARTIFACT_HMAC_SECRET'] = 'test-secret-beta'
    expect(verifyViewToken('artifact-id-1', token, exp, NOW + 60)).toBe(false)
  })

  it('tokens are consistent: same inputs + same secret produce the same token', () => {
    process.env['ARTIFACT_HMAC_SECRET'] = 'test-secret-stable'
    const { token: t1 } = signViewToken('artifact-id-1', NOW)
    const { token: t2 } = signViewToken('artifact-id-1', NOW)
    expect(t1).toBe(t2)
  })
})
