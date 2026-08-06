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
  restrictOptions,
  parseKeyscanEd25519,
  resolveHostKey,
  HOST_KEY_PUB_CANDIDATES,
  dashboardTokenDecision,
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

  // INSTUX1: the permitopen MUST follow the actual dashboard port. Verifying on
  // the default (3420) proves nothing -- that case worked before the bug too.
  it('threads a NON-DEFAULT dashboard port into the permitopen, keeping it narrow', () => {
    const parsed = validatePublicKeyLine(VALID_LINE)
    const line = buildRestrictedLine(parsed, 3421)
    expect(line).toBe(
      `restrict,port-forwarding,permitopen="127.0.0.1:3421",command="/bin/false" ssh-ed25519 ${B64} marveen-remote:${UUID}`,
    )
    // Security narrowing preserved: exactly one loopback port, no wildcard/range,
    // restrict + forced command intact.
    expect(line).toContain('restrict,')
    expect(line).toContain('command="/bin/false"')
    expect(line).not.toContain('permitopen="127.0.0.1:*"')
    expect((line.match(/permitopen=/g) ?? []).length).toBe(1)
  })

  it('restrictOptions defaults to REMOTE_PORT and narrows to the given port', () => {
    expect(restrictOptions()).toBe(RESTRICT_OPTIONS)
    expect(restrictOptions(3421)).toBe(
      'restrict,port-forwarding,permitopen="127.0.0.1:3421",command="/bin/false"',
    )
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
  it('returns null for a non-ed25519 type field', () => {
    const body = makeEd25519Base64(0x11)
    expect(parseHostKeyPub(`ssh-rsa ${body} root@host`)).toBeNull()
    expect(parseHostKeyPub('garbage that is not a key line')).toBeNull()
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

  it('encodes a NON-DEFAULT webPort as the bundle remotePort (tunnel target)', () => {
    const bundle = buildBundle({
      displayName: 'my-host',
      host: '203.0.113.5',
      sshPort: 22,
      sshUser: 'operator',
      hostKey: 'HOSTKEYB64',
      installId: base.installId,
      webPort: 3421,
    })
    expect(bundle.remotePort).toBe(3421)
    expect(decodeBundle(encodeBundle(bundle)).remotePort).toBe(3421)
  })

  it('falls back to REMOTE_PORT when no webPort is given', () => {
    const bundle = buildBundle({
      displayName: 'my-host',
      host: '203.0.113.5',
      sshPort: 22,
      sshUser: 'operator',
      hostKey: 'HOSTKEYB64',
      installId: base.installId,
    })
    expect(bundle.remotePort).toBe(3420)
  })

  it('carries dashboardToken as the last field when provided', () => {
    const bundle = buildBundle({
      displayName: 'my-host',
      host: '203.0.113.5',
      sshPort: 22,
      sshUser: 'operator',
      hostKey: 'HOSTKEYB64',
      installId: base.installId,
      dashboardToken: 'a1b2c3d4-token',
    })
    const encoded = encodeBundle(bundle)
    const decoded = decodeBundle(encoded)
    expect(decoded.dashboardToken).toBe('a1b2c3d4-token')
    // Documented field order: dashboardToken after installId.
    const keys = Object.keys(JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')))
    expect(keys.indexOf('dashboardToken')).toBe(keys.length - 1)
    expect(keys.indexOf('hostKey')).toBeLessThan(keys.indexOf('installId'))
  })

  it('omits dashboardToken entirely when absent', () => {
    const bundle = buildBundle({
      displayName: 'my-host',
      host: 'my-host.local',
      sshPort: 22,
      sshUser: 'operator',
      hostKey: 'HOSTKEYB64',
      installId: base.installId,
    })
    const json = Buffer.from(encodeBundle(bundle), 'base64').toString('utf8')
    expect(json).not.toContain('dashboardToken')
  })
})

describe('parseKeyscanEd25519', () => {
  const body = makeEd25519Base64(0x51)

  it('extracts the key body from keyscan output', () => {
    const out = `# 127.0.0.1:22 SSH-2.0-OpenSSH_9.9\n127.0.0.1 ssh-ed25519 ${body}\n`
    expect(parseKeyscanEd25519(out)).toBe(body)
  })

  it('skips comment lines, blank lines, and other key types', () => {
    const out = [
      '# comment',
      '',
      `127.0.0.1 ssh-rsa ${body}`,
      `127.0.0.1 ecdsa-sha2-nistp256 ${body}`,
      `127.0.0.1 ssh-ed25519 ${body}`,
    ].join('\n')
    expect(parseKeyscanEd25519(out)).toBe(body)
  })

  it('returns null when no ed25519 line is present', () => {
    expect(parseKeyscanEd25519('')).toBeNull()
    expect(parseKeyscanEd25519('# only comments\n')).toBeNull()
    expect(parseKeyscanEd25519(`127.0.0.1 ssh-rsa ${body}`)).toBeNull()
  })

  it('rejects a non-base64 key body', () => {
    expect(parseKeyscanEd25519('127.0.0.1 ssh-ed25519 not-base64!!')).toBeNull()
  })
})

describe('resolveHostKey', () => {
  const body = makeEd25519Base64(0x52)
  const pubFile = `ssh-ed25519 ${body} root@host\n`

  it('prefers the first readable candidate path', () => {
    const reads: string[] = []
    const resolved = resolveHostKey(
      {
        readFile: (p) => {
          reads.push(p)
          return p === '/b' ? pubFile : null
        },
        keyscan: () => {
          throw new Error('keyscan must not run when a file matches')
        },
      },
      ['/a', '/b', '/c'],
    )
    expect(resolved).toEqual({ body, source: '/b' })
    // Stops at the first hit; /c is never read.
    expect(reads).toEqual(['/a', '/b'])
  })

  it('falls back to ssh-keyscan when no candidate file is readable', () => {
    const resolved = resolveHostKey(
      {
        readFile: () => null,
        keyscan: () => `127.0.0.1 ssh-ed25519 ${body}\n`,
      },
      ['/a'],
    )
    expect(resolved).toEqual({ body, source: 'ssh-keyscan' })
  })

  it('skips an unparseable candidate file and still falls back', () => {
    const resolved = resolveHostKey(
      {
        readFile: () => 'garbage that is not a key line',
        keyscan: () => `localhost ssh-ed25519 ${body}\n`,
      },
      ['/a'],
    )
    expect(resolved).toEqual({ body, source: 'ssh-keyscan' })
  })

  it('returns null when every source fails', () => {
    expect(
      resolveHostKey({ readFile: () => null, keyscan: () => null }, ['/a']),
    ).toBeNull()
    expect(
      resolveHostKey({ readFile: () => null, keyscan: () => '# nothing\n' }, ['/a']),
    ).toBeNull()
  })

  it('ships macOS locations among the default candidates', () => {
    expect(HOST_KEY_PUB_CANDIDATES).toContain('/etc/ssh/ssh_host_ed25519_key.pub')
    expect(HOST_KEY_PUB_CANDIDATES).toContain('/private/etc/ssh/ssh_host_ed25519_key.pub')
  })
})

describe('dashboardTokenDecision (INSTNODE806)', () => {
  it('includes the token when requested and present', () => {
    expect(dashboardTokenDecision(true, 'tok_abc')).toEqual({ include: true, token: 'tok_abc' })
  })

  it('deliberate token-free bundle: --no-dashboard-token skips the token, no failure', () => {
    expect(dashboardTokenDecision(false, null)).toEqual({ include: false })
    // Even if a token exists, opting out must NOT include it.
    expect(dashboardTokenDecision(false, 'tok_abc')).toEqual({ include: false })
  })

  it('FAILS HARD when a token was requested but is missing -- no silent token-free bundle', () => {
    const d = dashboardTokenDecision(true, null)
    // It MUST be the failure shape -- not a degrade to include:false (a silent
    // token-free bundle) and not an include:true with a null token. Asserting
    // `'ok' in d` (not just a falsy d.ok) is what catches those regressions.
    expect('ok' in d).toBe(true)
    expect((d as { ok: boolean }).ok).toBe(false)
    const reason = (d as { reason: string }).reason
    // The message must name the real cause (dashboard not running / no token)
    // and the deliberate escape hatch, not a generic error.
    expect(reason).toMatch(/dashboard/i)
    expect(reason).toMatch(/--no-dashboard-token/)
  })

  it('treats an empty-string token as missing (fails hard, never ships an empty token)', () => {
    const d = dashboardTokenDecision(true, '')
    expect('ok' in d).toBe(true)
    expect((d as { ok: boolean }).ok).toBe(false)
  })
})
