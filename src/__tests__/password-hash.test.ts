import { describe, it, expect } from 'vitest'
import {
  hashPassword,
  verifyPassword,
  assertPasswordPolicy,
  PasswordPolicyError,
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_LENGTH,
} from '../web/password-hash.js'

describe('hashPassword / verifyPassword', () => {
  it('produces a PHC scrypt string and round-trips', async () => {
    const phc = await hashPassword('correct horse battery')
    expect(phc).toMatch(/^\$scrypt\$ln=16,r=8,p=1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/)
    expect(await verifyPassword('correct horse battery', phc)).toBe(true)
  })

  it('rejects the wrong password', async () => {
    const phc = await hashPassword('correct horse battery')
    expect(await verifyPassword('Correct horse battery', phc)).toBe(false)
    expect(await verifyPassword('', phc)).toBe(false)
  })

  it('uses a unique salt per hash (no deterministic output)', async () => {
    const a = await hashPassword('same-password-here')
    const b = await hashPassword('same-password-here')
    expect(a).not.toBe(b)
    expect(await verifyPassword('same-password-here', a)).toBe(true)
    expect(await verifyPassword('same-password-here', b)).toBe(true)
  })

  it('verifies against the STORED params, not the current defaults', async () => {
    // A hash minted with a different (valid) work factor must still verify: the
    // verifier must read ln/r/p from the PHC string. Hand-craft a low-cost hash.
    const { scryptSync } = await import('node:crypto')
    const salt = Buffer.from('0123456789abcdef')
    const key = scryptSync('legacy-pass-01', salt, 32, { N: 2 ** 14, r: 8, p: 1, maxmem: 128 * 1024 * 1024 })
    const phc = `$scrypt$ln=14,r=8,p=1$${salt.toString('base64')}$${key.toString('base64')}`
    expect(await verifyPassword('legacy-pass-01', phc)).toBe(true)
    expect(await verifyPassword('nope', phc)).toBe(false)
  })

  it('returns false (no throw) for malformed or unknown-prefix hashes', async () => {
    expect(await verifyPassword('x', '')).toBe(false)
    expect(await verifyPassword('x', 'not-a-phc')).toBe(false)
    expect(await verifyPassword('x', '$scrypt$ln=16$onlytwo')).toBe(false)
    expect(await verifyPassword('x', '$scrypt$ln=16,r=8,p=1$@@@$@@@')).toBe(false)
    // argon2 prefix under node (no Bun) -> false, no throw
    expect(await verifyPassword('x', '$argon2id$v=19$m=65536,t=2,p=1$abc$def')).toBe(false)
  })

  it('rejects out-of-range ln params (guards against OOM/hang)', async () => {
    expect(await verifyPassword('x', '$scrypt$ln=99,r=8,p=1$c2FsdA==$a2V5')).toBe(false)
  })
})

describe('assertPasswordPolicy', () => {
  it('accepts a length within bounds', () => {
    expect(() => assertPasswordPolicy('x'.repeat(MIN_PASSWORD_LENGTH))).not.toThrow()
    expect(() => assertPasswordPolicy('x'.repeat(MAX_PASSWORD_LENGTH))).not.toThrow()
  })
  it('rejects too-short and too-long passwords', () => {
    expect(() => assertPasswordPolicy('x'.repeat(MIN_PASSWORD_LENGTH - 1))).toThrow(PasswordPolicyError)
    expect(() => assertPasswordPolicy('x'.repeat(MAX_PASSWORD_LENGTH + 1))).toThrow(PasswordPolicyError)
  })
  it('rejects a non-string', () => {
    expect(() => assertPasswordPolicy(undefined as unknown)).toThrow(PasswordPolicyError)
  })
  it('hashPassword enforces the policy', async () => {
    await expect(hashPassword('short')).rejects.toBeInstanceOf(PasswordPolicyError)
  })
})
