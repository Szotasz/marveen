import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  VerifiedPackage,
  classifyVersion,
  compareVersions,
  hasEdgeWhiteSpace,
  meetsMinMarveenVersion,
  verifyDelivery,
  type Jwk,
} from '../web/agent-package/verify.js'
import { makeDeliveryCases } from './helpers/agent-package-delivery-cases.js'
import { DEFAULT_FILES, makeKeyPair, makePng, makeSignedDelivery } from './helpers/make-delivery.js'
import { isInstallCase, loadTextVector } from './helpers/package-text-vector.js'

const { keys, signer, cases } = makeDeliveryCases()

describe('verifyDelivery: the delivery-level case list (Sz-4.4 steps 1-6, S13)', () => {
  it('covers every step and both outcomes', () => {
    const steps = new Set(cases.flatMap((c) => ('ok' in c.expect ? [] : [c.expect.step])))
    expect([...steps].sort()).toEqual([1, 2, 3, 4, 5, 6])
    expect(cases.some((c) => 'ok' in c.expect)).toBe(true)
  })

  it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const got = verifyDelivery(c.delivery, c.requestedSlug, keys)
    if ('ok' in c.expect) {
      expect(got.ok, JSON.stringify(got)).toBe(true)
      return
    }
    expect(got.ok).toBe(false)
    if (got.ok) return
    expect({ step: got.step, reason: got.reason }).toEqual({ step: c.expect.step, reason: c.expect.reason })
    if (c.expect.detail) expect(got.detail).toMatchObject(c.expect.detail)
  })
})

describe('verifyDelivery: the shared text vector inside a signed delivery, at each case path', () => {
  // The scanner test runs the bytes alone; this one proves the rules run on
  // EVERY text file of a delivery (CLAUDE.md, SOUL.md and skill files), with
  // the path and line in the refusal. A case whose bytes are not valid UTF-8
  // cannot travel inside a JSON string, so it runs only in the scanner test.
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  const runnable = loadTextVector()
    .cases.filter(isInstallCase)
    .flatMap((c) => {
      try {
        return [[c.name, c, decoder.decode(Buffer.from(c.bytes_b64, 'base64'))] as const]
      } catch {
        return []
      }
    })

  it('runs all but the invalid UTF-8 case', () => {
    const all = loadTextVector().cases.filter(isInstallCase).length
    expect(runnable.length).toBe(all - 1)
  })

  it.each(runnable)('%s', (_name, c, text) => {
    const files: Record<string, string> = { ...DEFAULT_FILES, [c.path]: text }
    const got = verifyDelivery(
      makeSignedDelivery({ kid: signer.kid, privateKey: signer.privateKey, slug: 'invoice-helper', files }),
      'invoice-helper',
      keys,
    )
    if ('ok' in c.expect) {
      expect(got.ok, JSON.stringify(got)).toBe(true)
      return
    }
    expect(got.ok).toBe(false)
    if (got.ok) return
    expect(got.step).toBe(5)
    expect(got.reason).toBe(c.expect.reason)
    expect(got.detail).toMatchObject({ path: c.path, line: c.expect.findings[0].line })
  })
})

describe('verifyDelivery: a refusal never carries file content', () => {
  const MARKER = 'ZEBRAQUOKKA'
  const leaky: Array<[string, Record<string, string>]> = [
    ['S10', { ...DEFAULT_FILES, 'SOUL.md': `ok\n@${MARKER}\n` }],
    ['S11', { ...DEFAULT_FILES, 'SOUL.md': `${MARKER}​\n` }],
    ['S17 exec', { ...DEFAULT_FILES, 'CLAUDE.md': `!\`${MARKER}\`\n` }],
    ['S17 frontmatter', { ...DEFAULT_FILES, 'skills/a/SKILL.md': `---\n${MARKER}: x\n---\n` }],
  ]
  it.each(leaky)('%s', (_name, files) => {
    const got = verifyDelivery(
      makeSignedDelivery({ kid: signer.kid, privateKey: signer.privateKey, slug: 'invoice-helper', files }),
      'invoice-helper',
      keys,
    )
    expect(got.ok).toBe(false)
    expect(JSON.stringify(got)).not.toContain(MARKER)
  })

  it('manifest text', () => {
    const got = verifyDelivery(
      makeSignedDelivery({ kid: signer.kid, privateKey: signer.privateKey, slug: 'invoice-helper', displayName: `@${MARKER}` }),
      'invoice-helper',
      keys,
    )
    expect(got.ok).toBe(false)
    expect(JSON.stringify(got)).not.toContain(MARKER)
  })

  it.each([
    ['connector name', { connectors: [{ name: `@${MARKER}`, level: 'required', reason: 'ok' }] }],
    ['connector level', { connectors: [{ name: 'billing', level: MARKER, reason: 'ok' }] }],
    ['model hint', { modelHint: `@${MARKER}` }],
  ])('manifest %s', (_name, over) => {
    const got = verifyDelivery(
      makeSignedDelivery({ kid: signer.kid, privateKey: signer.privateKey, slug: 'invoice-helper', ...over }),
      'invoice-helper',
      keys,
    )
    expect(got.ok).toBe(false)
    expect(JSON.stringify(got)).not.toContain(MARKER)
  })
})

describe('hasEdgeWhiteSpace: the set is the Unicode White_Space property (Mira, card comment 32004)', () => {
  // The 25 code points of the property, written out, so the test does not ask the engine what the engine says.
  const WHITE_SPACE = new Set<number>([
    0x0009, 0x000a, 0x000b, 0x000c, 0x000d, 0x0020, 0x0085, 0x00a0, 0x1680,
    0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
    0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
  ])
  const u = (cp: number) => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`

  it('decides every code point by that list, at the start and at the end of a text', () => {
    expect(WHITE_SPACE.size).toBe(25)
    const wrong: string[] = []
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue
      const ch = String.fromCodePoint(cp)
      const want = WHITE_SPACE.has(cp)
      if (hasEdgeWhiteSpace(`${ch}x`) !== want) wrong.push(`start ${u(cp)}`)
      if (hasEdgeWhiteSpace(`x${ch}`) !== want) wrong.push(`end ${u(cp)}`)
    }
    expect(wrong).toEqual([])
  })

  it('is not the built-in white space: U+0085 counts, U+FEFF does not', () => {
    // The two code points where `\s` and trim() differ from the property (measured by the reviewer, card comment 32005).
    expect('\u0085x\u0085'.trim()).toBe('\u0085x\u0085')
    expect(hasEdgeWhiteSpace('\u0085x')).toBe(true)
    expect(hasEdgeWhiteSpace('x\u0085')).toBe(true)
    expect('﻿x﻿'.trim()).toBe('x')
    expect(hasEdgeWhiteSpace('﻿x')).toBe(false)
    expect(hasEdgeWhiteSpace('x﻿')).toBe(false)
  })

  it('looks at the two ends only, and an empty text has none', () => {
    expect(hasEdgeWhiteSpace('a b c　d\te')).toBe(false)
    expect(hasEdgeWhiteSpace('')).toBe(false)
    expect(hasEdgeWhiteSpace(' ')).toBe(true)
    // Without the m flag the end is the end of the text, not the end of a line.
    expect(hasEdgeWhiteSpace('a \nb')).toBe(false)
    expect(hasEdgeWhiteSpace('a\n b')).toBe(false)
  })
})

describe('VerifiedPackage', () => {
  const avatarBytes = makePng()
  const delivery = makeSignedDelivery({
    kid: signer.kid,
    privateKey: signer.privateKey,
    slug: 'invoice-helper',
    version: '1.2.3',
    minMarveenVersion: '1.40.0',
    displayName: 'Invoice helper',
    modelHint: 'claude-sonnet-5',
    avatar: { path: 'avatar.png', contentType: 'image/png', bytes: avatarBytes },
  })
  const result = verifyDelivery(delivery, 'invoice-helper', keys)

  it('carries the verified fields', () => {
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const pkg = result.pkg
    expect(pkg).toBeInstanceOf(VerifiedPackage)
    expect(pkg.slug).toBe('invoice-helper')
    expect(pkg.version).toBe('1.2.3')
    expect(pkg.minMarveenVersion).toBe('1.40.0')
    expect(pkg.kid).toBe(signer.kid)
    expect(pkg.displayName).toBe('Invoice helper')
    expect(pkg.modelHint).toBe('claude-sonnet-5')
    expect(pkg.files.map((f) => [f.path, f.text])).toEqual(Object.entries(DEFAULT_FILES))
    expect(pkg.avatar).toMatchObject({ path: 'avatar.png', contentType: 'image/png', size: avatarBytes.length })
    expect(Buffer.from(pkg.avatarBytes()!).equals(avatarBytes)).toBe(true)
  })

  it('payloadSha256 is the sha256 of the decoded JWS payload segment', () => {
    if (!result.ok) throw new Error('expected ok')
    const doc = JSON.parse(Buffer.from(delivery).toString('utf8')) as { manifest_jws: string }
    const payloadBytes = Buffer.from(doc.manifest_jws.split('.')[1], 'base64url')
    expect(result.pkg.payloadSha256).toBe(createHash('sha256').update(payloadBytes).digest('hex'))
    expect(Buffer.from(result.pkg.unverifiedPayloadBytes()).equals(payloadBytes)).toBe(true)
  })

  it('the raw payload is not a property: only checked fields are, and the bytes come from a method, as a copy', () => {
    if (!result.ok) throw new Error('expected ok')
    const pkg = result.pkg
    // Pinned: a new property has to be added here, with the pattern or the rule it passed (review of d021f7f2b).
    expect(Object.keys(pkg).sort()).toEqual(
      ['avatar', 'connectors', 'description', 'displayName', 'files', 'kid', 'minMarveenVersion', 'modelHint', 'payloadSha256', 'slug', 'title', 'version'],
    )
    expect(Reflect.ownKeys(pkg).every((k) => typeof k === 'string')).toBe(true)
    expect('payloadText' in pkg).toBe(false)
    const copy = pkg.unverifiedPayloadBytes()
    const first = copy[0]
    copy[0] = first ^ 0xff
    expect(pkg.unverifiedPayloadBytes()[0]).toBe(first)
    expect(createHash('sha256').update(pkg.unverifiedPayloadBytes()).digest('hex')).toBe(pkg.payloadSha256)
  })

  it('is immutable, and avatarBytes() hands out a copy', () => {
    if (!result.ok) throw new Error('expected ok')
    const pkg = result.pkg
    expect(Object.isFrozen(pkg)).toBe(true)
    expect(Object.isFrozen(pkg.files)).toBe(true)
    const copy = pkg.avatarBytes()!
    copy[0] = 0
    expect(pkg.avatarBytes()![0]).toBe(0x89)
  })

  it('cannot be constructed outside verifyDelivery', () => {
    expect(() => Reflect.construct(VerifiedPackage, [Symbol('forged'), {}])).toThrow(TypeError)
    expect(() => Reflect.construct(VerifiedPackage, [])).toThrow(TypeError)
    // A symbol with the same description is not the module's token.
    expect(() => Reflect.construct(VerifiedPackage, [Symbol('VerifiedPackage.mint'), {}])).toThrow(TypeError)
  })

  // Hand-made fields a forger would want on an "instance".
  const forgedFields = {
    slug: 'x',
    version: '1.0.0',
    minMarveenVersion: '1.0.0',
    kid: 'k',
    payloadSha256: 'a'.repeat(64),
    payloadBytes: new Uint8Array([0x7b, 0x7d]),
    title: 't',
    description: 'd',
    displayName: 'n',
    modelHint: null,
    connectors: [],
    files: [{ path: '../../x', sha256: 'a'.repeat(64), size: 1, text: 'x' }],
    avatar: null,
    avatarBytes: null,
  }
  const isInstance = (v: unknown): boolean => v instanceof VerifiedPackage

  it('no own property of the class, string or symbol, creates an instance', () => {
    const keys = Reflect.ownKeys(VerifiedPackage)
    // The only symbol-keyed own property is the instanceof hook; the mint is not a property.
    expect(keys.filter((k) => typeof k === 'symbol')).toEqual([Symbol.hasInstance])
    for (const key of keys) {
      const member = (VerifiedPackage as unknown as Record<PropertyKey, unknown>)[key]
      if (typeof member !== 'function') continue
      let made: unknown
      try {
        made = (member as (...a: unknown[]) => unknown).call(VerifiedPackage, forgedFields)
      } catch {
        made = undefined
      }
      expect(isInstance(made), String(key)).toBe(false)
    }
    for (const sym of Object.getOwnPropertySymbols(VerifiedPackage)) {
      expect(() => Reflect.construct(VerifiedPackage, [sym, forgedFields])).toThrow(TypeError)
    }
  })

  it('an object that only has the prototype is not an instance', () => {
    if (!result.ok) throw new Error('expected ok')
    expect(isInstance(result.pkg)).toBe(true)
    // defineProperties, not assign: the frozen prototype's avatarBytes method makes a plain assignment throw.
    const bare = Object.create(VerifiedPackage.prototype, Object.getOwnPropertyDescriptors(forgedFields)) as { files: Array<{ path: string }> }
    expect(bare.files[0].path).toBe('../../x')
    expect(isInstance(bare)).toBe(false)
    expect(isInstance(Reflect.construct(Object, [], VerifiedPackage))).toBe(false)
    expect(isInstance({ ...result.pkg })).toBe(false)
    expect(isInstance(null)).toBe(false)
    expect(isInstance('x')).toBe(false)
    class Sub extends (VerifiedPackage as unknown as new (...a: unknown[]) => object) {}
    expect(() => new Sub(forgedFields)).toThrow(TypeError)
  })

  it('the class and its prototype are frozen, so the instanceof hook and the methods cannot be replaced', () => {
    expect(Object.isFrozen(VerifiedPackage)).toBe(true)
    expect(Object.isFrozen(VerifiedPackage.prototype)).toBe(true)
    expect(() => Object.defineProperty(VerifiedPackage, Symbol.hasInstance, { value: () => true })).toThrow(TypeError)
    expect(isInstance(Object.create(VerifiedPackage.prototype))).toBe(false)
  })

  it('every string field of an instance passed a closed pattern or the manifest text rules', () => {
    // The fields the earlier head let through unchecked (review of d021f7f2b).
    const hostile = verifyDelivery(
      makeSignedDelivery({
        kid: signer.kid,
        privateKey: signer.privateKey,
        slug: 'invoice-helper',
        modelHint: '@a\nb',
        connectors: [{ name: '@notes/x.md ‮', level: 'required\u0000', reason: 'ok' }],
      }),
      'invoice-helper',
      keys,
    )
    expect(hostile.ok).toBe(false)
    if (!result.ok) throw new Error('expected ok')
    for (const c of result.pkg.connectors) expect(['required', 'recommended']).toContain(c.level)
  })

  it('a raw document is not a VerifiedPackage (type level, enforced by npm run typecheck)', () => {
    function typeOnly(): void {
      // @ts-expect-error the constructor is private
      new VerifiedPackage()
      // @ts-expect-error a plain object of the same shape is not assignable (private member)
      const raw: VerifiedPackage = { slug: 'x', version: '1.0.0', files: [], avatar: null }
      void raw
    }
    expect(typeof typeOnly).toBe('function')
  })
})

describe('classifyVersion (Sz-4.4/7, plan 8.1)', () => {
  const h1 = 'a'.repeat(64)
  const h2 = 'b'.repeat(64)

  it('compares number by number, not as text: 1.10.0 > 1.9.0', () => {
    expect(compareVersions('1.10.0', '1.9.0')).toBe(1)
    expect(classifyVersion({ version: '1.9.0', payloadSha256: h1 }, { version: '1.10.0', payloadSha256: h2 })).toBe('upgrade')
    expect(classifyVersion({ version: '1.10.0', payloadSha256: h1 }, { version: '1.9.0', payloadSha256: h2 })).toBe('downgrade_refused')
    expect(classifyVersion({ version: '0.0.9', payloadSha256: h1 }, { version: '0.0.10', payloadSha256: h2 })).toBe('upgrade')
    expect(classifyVersion({ version: '2.0.0', payloadSha256: h1 }, { version: '10.0.0', payloadSha256: h2 })).toBe('upgrade')
  })

  it('same version and same payload hash is a repair', () => {
    expect(classifyVersion({ version: '1.2.3', payloadSha256: h1 }, { version: '1.2.3', payloadSha256: h1 })).toBe('repair')
  })

  it('same version and a different payload hash is version_conflict', () => {
    expect(classifyVersion({ version: '1.2.3', payloadSha256: h1 }, { version: '1.2.3', payloadSha256: h2 })).toBe('version_conflict')
  })

  it('a lower version is downgrade_refused, even with the same hash', () => {
    expect(classifyVersion({ version: '1.2.3', payloadSha256: h1 }, { version: '1.2.2', payloadSha256: h1 })).toBe('downgrade_refused')
    expect(classifyVersion({ version: '2.0.0', payloadSha256: h1 }, { version: '1.99.99', payloadSha256: h2 })).toBe('downgrade_refused')
  })

  it('the own version must be at least min_marveen_version', () => {
    expect(meetsMinMarveenVersion('1.49.1', '1.49.1')).toBe(true)
    expect(meetsMinMarveenVersion('1.49.1', '1.9.0')).toBe(true)
    expect(meetsMinMarveenVersion('1.9.0', '1.49.1')).toBe(false)
    expect(meetsMinMarveenVersion('1.49.1', '1.49.2')).toBe(false)
  })

  it('a version outside the contract shape throws instead of comparing', () => {
    expect(() => compareVersions('1.02.0', '1.2.0')).toThrow(RangeError)
    expect(() => compareVersions('1.2', '1.2.0')).toThrow(RangeError)
  })
})

describe('pinning tests of plan 9.1 that need no web.ts wiring', () => {
  it('(4) with a two-key list, a package signed by either key is valid, and the kids are unique', () => {
    const a = makeKeyPair()
    const b = makeKeyPair()
    const list: Jwk[] = [a.jwk, b.jwk]
    expect(new Set(list.map((k) => k.kid)).size).toBe(list.length)
    for (const k of [a, b]) {
      const got = verifyDelivery(makeSignedDelivery({ kid: k.kid, privateKey: k.privateKey }), 'invoice-helper', list)
      expect(got.ok).toBe(true)
      if (got.ok) expect(got.pkg.kid).toBe(k.kid)
    }
  })

  it('(5) a byte-identical payload with a new signature classifies as repair, not upgrade', () => {
    const a = makeKeyPair()
    const b = makeKeyPair()
    const list: Jwk[] = [a.jwk, b.jwk]
    // Same payload bytes: the kid is in the header, not in the payload.
    const first = verifyDelivery(makeSignedDelivery({ kid: a.kid, privateKey: a.privateKey }), 'invoice-helper', list)
    const second = verifyDelivery(makeSignedDelivery({ kid: b.kid, privateKey: b.privateKey }), 'invoice-helper', list)
    if (!first.ok || !second.ok) throw new Error('expected both to verify')
    expect(second.pkg.payloadSha256).toBe(first.pkg.payloadSha256)
    expect(classifyVersion(first.pkg, second.pkg)).toBe('repair')
  })
})
