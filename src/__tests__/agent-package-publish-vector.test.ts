import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { N21B_PROVISIONAL_REASONS, SLUG_RE, verifyDelivery } from '../web/agent-package/verify.js'
import { makeKeyPair, makeSignedDelivery } from './helpers/make-delivery.js'
import { isInstallCase } from './helpers/package-text-vector.js'
import {
  PACKAGE_PUBLISH_VECTOR_SHA256,
  loadPublishVector,
  publishVectorBytes,
  type PublishManifestCase,
} from './helpers/package-publish-vector.js'

// The shared publish vector binds the installer to what the publisher signs
// (MIOAGENTPUBVEC1122): every install-stage case runs through verifyDelivery,
// inside a signed delivery, so the installer decides it the way it decides a
// real package. A case the installer decides differently is a contract finding
// for the publishing side, not something to change here quietly.

const vector = loadPublishVector()
const imageCases = vector.image_cases.filter(isInstallCase)
const manifestCases = vector.manifest_cases.filter(isInstallCase)
const signer = makeKeyPair()
const keys = [signer.jwk]

/**
 * The vector names the publisher's refusal; the installer refuses the same
 * manifest at its own step. A pattern rule fails the signed payload's shape
 * (step 2, bad_payload, no detail); a free-text rule fails at step 5 with the
 * field and the rule, under the provisional N21/b reason. A rule missing here
 * fails the test, so a new rule in the next vector needs a decision.
 */
const PAYLOAD_SHAPE_RULES = new Set(['bad-version', 'bad-connector-name', 'bad-connector-level', 'bad-model-hint'])
const TEXT_RULES: Record<string, string> = {
  'manifest-line-break': N21B_PROVISIONAL_REASONS.manifestLineBreak,
  'manifest-text-length': N21B_PROVISIONAL_REASONS.manifestTextLength,
  'manifest-edge-whitespace': N21B_PROVISIONAL_REASONS.manifestEdgeWhiteSpace,
}

function avatarOf(bytes: Buffer): { path: string; contentType: string } {
  if (bytes.subarray(1, 4).toString('latin1') === 'PNG') return { path: 'avatar.png', contentType: 'image/png' }
  return { path: 'avatar.webp', contentType: 'image/webp' }
}

describe('shared package publish vector: the copy', () => {
  it('is byte-identical to the pinned sha256', () => {
    expect(createHash('sha256').update(publishVectorBytes()).digest('hex')).toBe(PACKAGE_PUBLISH_VECTOR_SHA256)
  })

  it('has install cases of both kinds, and every install image case is an avatar', () => {
    expect(imageCases.length).toBeGreaterThan(0)
    expect(manifestCases.length).toBeGreaterThan(0)
    expect(imageCases.every((c) => c.kind === 'avatar')).toBe(true)
  })

  it('every install manifest refusal names exactly one refusal (the installer stops at the first)', () => {
    for (const c of manifestCases) {
      if ('ok' in c.expect) continue
      expect(c.expect.refusals, c.name).toHaveLength(1)
    }
  })
})

describe('shared package publish vector: every install-stage image case, as the avatar of a signed delivery', () => {
  it.each(imageCases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const bytes = Buffer.from(c.bytes_b64, 'base64')
    const { path, contentType } = avatarOf(bytes)
    const got = verifyDelivery(
      makeSignedDelivery({ kid: signer.kid, privateKey: signer.privateKey, avatar: { path, contentType, bytes } }),
      'invoice-helper',
      keys,
    )
    if ('ok' in c.expect) {
      expect(got.ok, JSON.stringify(got)).toBe(true)
      return
    }
    expect(got.ok).toBe(false)
    if (got.ok) return
    expect({ step: got.step, reason: got.reason }).toEqual({ step: 5, reason: 'bad_avatar' })
    expect(got.detail).toEqual({ path, rule: c.expect.rule })
  })
})

describe('shared package publish vector: every install-stage manifest case, as the payload of a signed delivery', () => {
  function deliver(c: PublishManifestCase): ReturnType<typeof verifyDelivery> {
    const manifest = JSON.parse(Buffer.from(c.bytes_b64, 'base64').toString('utf8')) as Record<string, unknown>
    const slug = typeof manifest.slug === 'string' ? manifest.slug : 'invoice-helper'
    return verifyDelivery(
      makeSignedDelivery({
        kid: signer.kid,
        privateKey: signer.privateKey,
        slug,
        tamper: { payload: (p) => ({ ...p, ...manifest }) },
      }),
      slug,
      keys,
    )
  }

  it.each(manifestCases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const got = deliver(c)
    if ('ok' in c.expect) {
      expect(got.ok, JSON.stringify(got)).toBe(true)
      return
    }
    expect(got.ok).toBe(false)
    if (got.ok) return
    const refusal = c.expect.refusals[0]
    if (refusal.reason === 'invalid_slug' || PAYLOAD_SHAPE_RULES.has(refusal.rule ?? '')) {
      expect({ step: got.step, reason: got.reason }).toEqual({ step: 2, reason: 'bad_payload' })
      return
    }
    expect(refusal.rule !== undefined && refusal.rule in TEXT_RULES, `no installer mapping for ${JSON.stringify(refusal)}`).toBe(true)
    expect({ step: got.step, reason: got.reason }).toEqual({ step: 5, reason: TEXT_RULES[refusal.rule!] })
    expect(got.detail).toEqual({ field: refusal.field, rule: refusal.rule })
  })

  it('the slug cases are refused by the one slug pattern itself, not only by the delivery check', () => {
    const slugCases = manifestCases.filter((c) => !('ok' in c.expect) && c.expect.refusals[0].reason === 'invalid_slug')
    expect(slugCases.length).toBeGreaterThan(0)
    for (const c of slugCases) {
      const slug = (JSON.parse(Buffer.from(c.bytes_b64, 'base64').toString('utf8')) as { slug: string }).slug
      expect(SLUG_RE.test(slug), c.name).toBe(false)
    }
  })
})

// Dani's nit on #3069 (84060): with title-edge-nel an upload-only case, nothing on the installer side pinned how a
// U+0085 title is refused. It is a C1 control, so the installer's character rule (S11) refuses it in step 5 before
// the edge rule runs (scanManifestText checks the edge last on purpose).
describe('installer: a U+0085 title', () => {
  it('is refused in step 5 as bad_text under forbidden-char, field title', () => {
    const bytes = makeSignedDelivery({ kid: signer.kid, privateKey: signer.privateKey, slug: 'nel-case', version: '1.0.0', title: 'Invoice helper\u0085' })
    const got = verifyDelivery(bytes, 'nel-case', [signer.jwk])
    expect(got.ok).toBe(false)
    if (got.ok) return
    expect({ step: got.step, reason: got.reason, detail: got.detail }).toEqual({ step: 5, reason: 'bad_text', detail: { field: 'title', rule: 'forbidden-char' } })
  })
})
