import { describe, it, expect } from 'vitest'
import {
  SUPPORT_KEYS,
  SUPPORT_FROM_CIDRS,
  SUPPORT_KEY_TYPE,
  parseSkEd25519Blob,
  fingerprintOfBlob,
  isExactHostCidr,
  validateSupportPins,
  type SupportKeyPin,
} from '../support-access-pins.js'
import {
  skBlob,
  TEST_ONLY_BLOB_1,
  TEST_ONLY_BLOB_2,
  TEST_ONLY_FINGERPRINT_1,
  TEST_ONLY_KEYS,
  TEST_ONLY_FROM,
  TEST_ONLY_FROM_V6,
} from './helpers/sk-test-keys.js'

function ed25519Blob(): string {
  const type = Buffer.from('ssh-ed25519', 'latin1')
  const len = (n: number) => {
    const b = Buffer.alloc(4)
    b.writeUInt32BE(n, 0)
    return b
  }
  return Buffer.concat([len(type.length), type, len(32), Buffer.alloc(32, 7)]).toString('base64')
}

describe('the shipped pins', () => {
  it('are unset or valid, never malformed', () => {
    const check = validateSupportPins(SUPPORT_KEYS, SUPPORT_FROM_CIDRS)
    if (!check.ok) expect(['support_keys_unset', 'support_from_unset']).toContain(check.code)
  })

  it('never contain a TEST ONLY fixture key', () => {
    const shipped = new Set(SUPPORT_KEYS.map((k) => k.pub))
    expect(shipped.has(TEST_ONLY_BLOB_1)).toBe(false)
    expect(shipped.has(TEST_ONLY_BLOB_2)).toBe(false)
    const shippedPrints = new Set(SUPPORT_KEYS.map((k) => k.fingerprint))
    for (const k of TEST_ONLY_KEYS) expect(shippedPrints.has(k.fingerprint)).toBe(false)
  })

  it('never contain a documentation-range source address', () => {
    for (const cidr of SUPPORT_FROM_CIDRS) {
      expect(cidr.startsWith('203.0.113.')).toBe(false)
      expect(cidr.startsWith('2001:db8:')).toBe(false)
    }
  })
})

describe('parseSkEd25519Blob', () => {
  it('accepts an sk-ssh-ed25519 blob and returns its application', () => {
    expect(parseSkEd25519Blob(TEST_ONLY_BLOB_1)).toEqual({ ok: true, application: 'ssh:marveen-support-test' })
  })

  it('rejects a plain ssh-ed25519 blob', () => {
    expect(parseSkEd25519Blob(ed25519Blob()).ok).toBe(false)
  })

  it('rejects an sk-ecdsa blob type', () => {
    expect(parseSkEd25519Blob(skBlob({ type: 'sk-ecdsa-sha2-nistp256@openssh.com' })).ok).toBe(false)
  })

  it('rejects a key that is not 32 bytes', () => {
    expect(parseSkEd25519Blob(skBlob({ key: Buffer.alloc(31, 1) })).ok).toBe(false)
    expect(parseSkEd25519Blob(skBlob({ key: Buffer.alloc(33, 1) })).ok).toBe(false)
  })

  it('rejects a blob without an application field', () => {
    expect(parseSkEd25519Blob(skBlob({ application: null })).ok).toBe(false)
  })

  it('rejects an application that is not an ssh: application', () => {
    expect(parseSkEd25519Blob(skBlob({ application: 'https://example.com' })).ok).toBe(false)
    expect(parseSkEd25519Blob(skBlob({ application: 'ssh:with space' })).ok).toBe(false)
  })

  it('rejects trailing bytes', () => {
    expect(parseSkEd25519Blob(skBlob({ trailing: Buffer.from([0, 0, 0]) })).ok).toBe(false)
  })

  it('rejects text that is not canonical base64', () => {
    expect(parseSkEd25519Blob(TEST_ONLY_BLOB_1 + '!').ok).toBe(false)
    expect(parseSkEd25519Blob(TEST_ONLY_BLOB_1.slice(0, -1)).ok).toBe(false)
    expect(parseSkEd25519Blob('').ok).toBe(false)
  })
})

describe('fingerprintOfBlob', () => {
  it('matches what ssh-keygen -l prints for the same blob', () => {
    // Independent vector: `ssh-keygen -l -f` (OpenSSH 10.2) on this exact blob.
    expect(fingerprintOfBlob(TEST_ONLY_BLOB_1)).toBe(TEST_ONLY_FINGERPRINT_1)
  })

  it('differs for a different key', () => {
    expect(fingerprintOfBlob(TEST_ONLY_BLOB_2)).not.toBe(TEST_ONLY_FINGERPRINT_1)
  })
})

describe('isExactHostCidr', () => {
  it('accepts one IPv4 host and one IPv6 host', () => {
    expect(isExactHostCidr('203.0.113.7/32')).toBe(true)
    expect(isExactHostCidr(TEST_ONLY_FROM_V6)).toBe(true)
  })

  it.each([
    ['a range', '203.0.113.0/24'],
    ['an IPv4 with an IPv6 prefix length', '203.0.113.7/128'],
    ['an IPv6 with an IPv4 prefix length', '2001:db8::7/32'],
    ['no prefix length', '203.0.113.7'],
    ['a wildcard', '203.0.113.*/32'],
    ['a negation', '!203.0.113.7/32'],
    ['a host name', 'support.example.com/32'],
    ['a quote', '203.0.113.7/32"'],
    ['a space', '203.0.113.7/32 '],
    ['a list', '203.0.113.7/32,203.0.113.8/32'],
    ['a leading zero', '203.0.113.07/32'],
    ['an empty string', ''],
    ['a zone id', 'fe80::1%eth0/128'],
  ])('refuses %s', (_label, value) => {
    expect(isExactHostCidr(value)).toBe(false)
  })

  // An address that names no machine, or names one in a second spelling,
  // would make a line that never matches: refused like any other dead line.
  it.each([
    ['the unspecified IPv4 address', '0.0.0.0/32'],
    ['the unspecified IPv6 address', '::/128'],
    ['the unspecified IPv6 address written out', '0:0:0:0:0:0:0:0/128'],
    ['an IPv4 address written as IPv6', '::ffff:203.0.113.7/128'],
    ['the same in upper case', '::FFFF:203.0.113.7/128'],
    ['the same in hexadecimal groups', '::ffff:cb00:7107/128'],
    ['the same written out', '0:0:0:0:0:ffff:cb00:7107/128'],
  ])('refuses %s', (_label, value) => {
    expect(isExactHostCidr(value)).toBe(false)
  })

  it.each([
    ['an address with ffff in the sixth group and a non-zero start', '2001:db8::ffff:cb00:7107/128'],
    ['an address with a dotted tail that is not a mapped one', '64:ff9b::203.0.113.7/128'],
    ['an address that is zero up to the sixth group', '::fffe:cb00:7107/128'],
    ['an address that is zero except its last group', '::7/128'],
    ['an address with a gap in the middle', '2001:db8::1:0:7/128'],
    ['an address with no gap', '2001:db8:0:0:0:0:0:7/128'],
    ['an address that ends in a gap', '2001:db8:7::/128'],
  ])('still accepts %s', (_label, value) => {
    expect(isExactHostCidr(value)).toBe(true)
  })
})

describe('validateSupportPins', () => {
  const key1 = TEST_ONLY_KEYS[0]
  const key2 = TEST_ONLY_KEYS[1]

  it('passes two valid keys and one exact source', () => {
    expect(validateSupportPins(TEST_ONLY_KEYS, TEST_ONLY_FROM)).toEqual({ ok: true })
  })

  it('reports unset keys and an unset source separately', () => {
    expect(validateSupportPins([], TEST_ONLY_FROM)).toMatchObject({ ok: false, code: 'support_keys_unset' })
    expect(validateSupportPins(TEST_ONLY_KEYS, [])).toMatchObject({ ok: false, code: 'support_from_unset' })
  })

  it('validates EVERY key, not only the first', () => {
    const bad: SupportKeyPin = { name: 'key2', pub: ed25519Blob(), fingerprint: fingerprintOfBlob(ed25519Blob()) }
    expect(validateSupportPins([key1, bad], TEST_ONLY_FROM)).toMatchObject({ ok: false, code: 'support_pins_invalid' })
  })

  it('refuses a third key', () => {
    const third: SupportKeyPin = {
      name: 'key3',
      pub: skBlob({ key: Buffer.alloc(32, 9) }),
      fingerprint: fingerprintOfBlob(skBlob({ key: Buffer.alloc(32, 9) })),
    }
    expect(validateSupportPins([key1, key2, third], TEST_ONLY_FROM)).toMatchObject({
      ok: false,
      code: 'support_pins_invalid',
    })
  })

  it('refuses a fingerprint that does not belong to its key', () => {
    const lying: SupportKeyPin = { ...key1, fingerprint: key2.fingerprint }
    expect(validateSupportPins([lying], TEST_ONLY_FROM)).toMatchObject({ ok: false, code: 'support_pins_invalid' })
  })

  it('refuses a duplicate name and a repeated key', () => {
    expect(validateSupportPins([key1, { ...key2, name: 'key1' }], TEST_ONLY_FROM)).toMatchObject({
      ok: false,
      code: 'support_pins_invalid',
    })
    expect(validateSupportPins([key1, { ...key1, name: 'key2' }], TEST_ONLY_FROM)).toMatchObject({
      ok: false,
      code: 'support_pins_invalid',
    })
  })

  it('refuses a name that could not sit in a bound command', () => {
    expect(validateSupportPins([{ ...key1, name: 'key 1' }], TEST_ONLY_FROM)).toMatchObject({
      ok: false,
      code: 'support_pins_invalid',
    })
    expect(validateSupportPins([{ ...key1, name: 'Key1' }], TEST_ONLY_FROM)).toMatchObject({
      ok: false,
      code: 'support_pins_invalid',
    })
  })

  it('refuses a range, a third source and a duplicate source', () => {
    expect(validateSupportPins(TEST_ONLY_KEYS, ['203.0.113.0/24'])).toMatchObject({
      ok: false,
      code: 'support_pins_invalid',
    })
    expect(
      validateSupportPins(TEST_ONLY_KEYS, ['203.0.113.7/32', '203.0.113.8/32', '203.0.113.9/32']),
    ).toMatchObject({ ok: false, code: 'support_pins_invalid' })
    expect(validateSupportPins(TEST_ONLY_KEYS, ['203.0.113.7/32', '203.0.113.7/32'])).toMatchObject({
      ok: false,
      code: 'support_pins_invalid',
    })
  })

  it('reports a malformed pin as invalid even when the other list is empty', () => {
    expect(validateSupportPins([{ ...key1, fingerprint: 'SHA256:nope' }], [])).toMatchObject({
      ok: false,
      code: 'support_pins_invalid',
    })
  })

  it('names the one accepted key type', () => {
    expect(SUPPORT_KEY_TYPE).toBe('sk-ssh-ed25519@openssh.com')
  })
})
