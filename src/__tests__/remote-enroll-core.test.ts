import { describe, it, expect } from 'vitest'
import {
  validatePublicKeyLine,
  buildRestrictedLine,
  mergeAuthorizedKeys,
  parseHostKeyPub,
  buildBundle,
  encodeBundle,
  decodeBundle,
  RemoteEnrollError,
  RESTRICT_OPTIONS,
  type ParsedKey,
} from '../remote-enroll-core.js'

// A real ed25519 public key blob: uint32(11) | "ssh-ed25519" | uint32(32) |
// 32 key bytes. Built deterministically so the base64 is canonical.
function makeEd25519Base64(keyByte = 0x42): string {
  const type = Buffer.from('ssh-ed25519', 'utf8')
  const key = Buffer.alloc(32, keyByte)
  const buf = Buffer.concat([
    u32(type.length),
    type,
    u32(key.length),
    key,
  ])
  return buf.toString('base64')
}
function u32(n: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n, 0)
  return b
}

const UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
const B64 = makeEd25519Base64()
const VALID_LINE = `ssh-ed25519 ${B64} marveen-remote:${UUID}`

describe('validatePublicKeyLine', () => {
  it('accepts a well-formed line', () => {
    const parsed = validatePublicKeyLine(VALID_LINE)
    expect(parsed.keyType).toBe('ssh-ed25519')
    expect(parsed.base64).toBe(B64)
    expect(parsed.comment).toBe(`marveen-remote:${UUID}`)
    expect(parsed.installId).toBe(UUID)
  })

  it('tolerates surrounding whitespace', () => {
    expect(validatePublicKeyLine(`  ${VALID_LINE}  `).installId).toBe(UUID)
  })

  it('rejects a wrong key type', () => {
    const line = `ssh-rsa ${B64} marveen-remote:${UUID}`
    expect(() => validatePublicKeyLine(line)).toThrow(RemoteEnrollError)
    expect(() => validatePublicKeyLine(line)).toThrow(/key type must be exactly ssh-ed25519/)
  })

  it('rejects bad base64', () => {
    const line = `ssh-ed25519 not!valid!base64 marveen-remote:${UUID}`
    expect(() => validatePublicKeyLine(line)).toThrow(/not valid base64/)
  })

  it('rejects a blob whose embedded type is not ssh-ed25519', () => {
    const type = Buffer.from('ssh-rsa4567', 'utf8') // 11 bytes, wrong value
    const key = Buffer.alloc(32, 1)
    const b64 = Buffer.concat([u32(type.length), type, u32(32), key]).toString('base64')
    const line = `ssh-ed25519 ${b64} marveen-remote:${UUID}`
    expect(() => validatePublicKeyLine(line)).toThrow(/embedded key type/)
  })

  it('rejects a blob with the wrong key length', () => {
    const type = Buffer.from('ssh-ed25519', 'utf8')
    const key = Buffer.alloc(31, 1) // one byte short
    const b64 = Buffer.concat([u32(type.length), type, u32(31), key]).toString('base64')
    const line = `ssh-ed25519 ${b64} marveen-remote:${UUID}`
    expect(() => validatePublicKeyLine(line)).toThrow(/must be 32 bytes/)
  })

  it('rejects a blob with trailing bytes', () => {
    const type = Buffer.from('ssh-ed25519', 'utf8')
    const key = Buffer.alloc(32, 1)
    const b64 = Buffer.concat([u32(type.length), type, u32(32), key, Buffer.alloc(4)]).toString('base64')
    const line = `ssh-ed25519 ${b64} marveen-remote:${UUID}`
    expect(() => validatePublicKeyLine(line)).toThrow(/trailing or missing bytes/)
  })

  it('rejects a bad comment (missing prefix)', () => {
    const line = `ssh-ed25519 ${B64} some-other-comment`
    expect(() => validatePublicKeyLine(line)).toThrow(/must start with/)
  })

  it('rejects a comment whose id is not a uuid v4', () => {
    const line = `ssh-ed25519 ${B64} marveen-remote:not-a-uuid`
    expect(() => validatePublicKeyLine(line)).toThrow(/uuid v4/)
  })

  it('rejects a line carrying authorized_keys options', () => {
    const line = `no-pty ssh-ed25519 ${B64} marveen-remote:${UUID}`
    expect(() => validatePublicKeyLine(line)).toThrow(/exactly three fields/)
  })

  it('rejects an extra trailing field', () => {
    const line = `ssh-ed25519 ${B64} marveen-remote:${UUID} extra`
    expect(() => validatePublicKeyLine(line)).toThrow(/exactly three fields/)
  })

  it('rejects an empty line', () => {
    expect(() => validatePublicKeyLine('   ')).toThrow(/empty/)
  })

  it('rejects a multi-line input', () => {
    expect(() => validatePublicKeyLine(`${VALID_LINE}\nextra`)).toThrow(RemoteEnrollError)
  })
})

describe('buildRestrictedLine', () => {
  it('produces the verbatim restricted entry', () => {
    const parsed = validatePublicKeyLine(VALID_LINE)
    const line = buildRestrictedLine(parsed)
    expect(line).toBe(
      `restrict,port-forwarding,permitopen="127.0.0.1:3420",command="/bin/false" ssh-ed25519 ${B64} marveen-remote:${UUID}`,
    )
    // Sanity: options segment is exactly as specified.
    expect(line.startsWith(RESTRICT_OPTIONS + ' ')).toBe(true)
  })
})

describe('mergeAuthorizedKeys', () => {
  const restricted = buildRestrictedLine(validatePublicKeyLine(VALID_LINE))

  it('appends to empty content', () => {
    const { content, action } = mergeAuthorizedKeys('', restricted, UUID)
    expect(action).toBe('added')
    expect(content).toBe(restricted + '\n')
  })

  it('appends after existing unrelated lines, preserving them byte-for-byte', () => {
    const existing = 'ssh-rsa AAAA someone@host\nssh-ed25519 BBBB other-comment\n'
    const { content, action } = mergeAuthorizedKeys(existing, restricted, UUID)
    expect(action).toBe('added')
    expect(content).toBe(existing + restricted + '\n')
  })

  it('replaces exactly the matching id line and preserves others', () => {
    const otherId = '11111111-2222-4333-8444-555555555555'
    const stale = `restrict ssh-ed25519 OLDKEY marveen-remote:${UUID}`
    const keep1 = 'ssh-rsa AAAA someone@host'
    const keep2 = `restrict ssh-ed25519 KEEP marveen-remote:${otherId}`
    const existing = `${keep1}\n${stale}\n${keep2}\n`
    const { content, action } = mergeAuthorizedKeys(existing, restricted, UUID)
    expect(action).toBe('replaced')
    expect(content).toBe(`${keep1}\n${restricted}\n${keep2}\n`)
    // The other marveen-remote id must be untouched.
    expect(content).toContain(keep2)
    expect(content).not.toContain('OLDKEY')
  })

  it('handles content without a trailing newline', () => {
    const existing = 'ssh-rsa AAAA someone@host'
    const { content } = mergeAuthorizedKeys(existing, restricted, UUID)
    expect(content).toBe(`${existing}\n${restricted}\n`)
  })

  it('preserves blank lines between entries', () => {
    const existing = 'ssh-rsa AAAA a@h\n\nssh-rsa BBBB b@h\n'
    const { content } = mergeAuthorizedKeys(existing, restricted, UUID)
    expect(content).toBe(existing + restricted + '\n')
  })
})

describe('parseHostKeyPub', () => {
  it('extracts the base64 body', () => {
    const body = makeEd25519Base64(0x11)
    expect(parseHostKeyPub(`ssh-ed25519 ${body} root@host\n`)).toBe(body)
  })
  it('returns null for empty content', () => {
    expect(parseHostKeyPub('   ')).toBeNull()
  })
  it('returns null when the body is not base64', () => {
    expect(parseHostKeyPub('ssh-ed25519 %%% root@host')).toBeNull()
  })
})

describe('bundle', () => {
  const base: ParsedKey = validatePublicKeyLine(VALID_LINE)

  it('roundtrips with all fields and hostKey present', () => {
    const bundle = buildBundle({
      displayName: 'my-host',
      host: '203.0.113.5',
      sshPort: 2222,
      sshUser: 'operator',
      hostKey: 'HOSTKEYB64',
      installId: base.installId,
    })
    const decoded = decodeBundle(encodeBundle(bundle))
    expect(decoded).toEqual({
      format: 'marveen-remote/1',
      kind: 'connection',
      displayName: 'my-host',
      host: '203.0.113.5',
      sshPort: 2222,
      sshUser: 'operator',
      remotePort: 3420,
      hostKey: 'HOSTKEYB64',
      installId: base.installId,
    })
  })

  it('omits hostKey entirely when absent', () => {
    const bundle = buildBundle({
      displayName: 'my-host',
      host: 'my-host.local',
      sshPort: 22,
      sshUser: 'operator',
      installId: base.installId,
    })
    const encoded = encodeBundle(bundle)
    const decoded = decodeBundle(encoded)
    expect('hostKey' in decoded).toBe(false)
    // The raw JSON must not carry a hostKey key at all.
    const json = Buffer.from(encoded, 'base64').toString('utf8')
    expect(json).not.toContain('hostKey')
    expect(decoded.remotePort).toBe(3420)
  })
})
