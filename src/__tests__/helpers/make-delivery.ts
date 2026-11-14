// Test helper: signed agent package deliveries (MIOAGENTINSTALL1114, plan 10.1).
//
// Keys are generated at run time; no private key lives in the repo. A delivery
// is built in the contract's shape (Sz-4.3): an outer document with
// manifest_jws, files and avatar, where the JWS payload lists every file with
// its sha256 and UTF-8 size. The `tamper` hooks bend one thing at a time, at
// the stage named by the hook, so a test can break exactly one rule.
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import type { Jwk } from '../../web/agent-package/verify.js'

export interface TestKeyPair {
  kid: string
  privateKey: KeyObject
  jwk: Jwk
}

let keyCounter = 0

export function makeKeyPair(kid?: string): TestKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const exported = publicKey.export({ format: 'jwk' }) as { x?: string }
  const useKid = kid ?? `test-kid-${process.pid}-${++keyCounter}`
  return {
    kid: useKid,
    privateKey,
    jwk: { kty: 'OKP', crv: 'Ed25519', x: String(exported.x), kid: useKid },
  }
}

export interface TestAvatar {
  path: string
  contentType: string
  bytes: Uint8Array
}

type Obj = Record<string, unknown>

export interface DeliveryInput {
  kid: string
  privateKey: KeyObject
  slug?: string
  version?: string
  minMarveenVersion?: string
  /** path -> UTF-8 text, in payload order. Default: a minimal CLAUDE.md and SOUL.md. */
  files?: Record<string, string>
  avatar?: TestAvatar | null
  title?: string
  description?: string
  displayName?: string
  modelHint?: string | null
  connectors?: Array<{ name: string; level: string; reason: string }>
  tamper?: {
    /** The JWS header before it is encoded. */
    header?: (h: Obj) => Obj
    /** The payload object before it is encoded and signed. */
    payload?: (p: Obj) => Obj
    /** The payload segment text before signing (for a payload that is not JSON). */
    payloadText?: (s: string) => string
    /** The compact JWS after signing (to break the signature or the segments). */
    jws?: (jws: string) => string
    /** The outer document after signing. */
    document?: (d: Obj) => Obj
    /** The serialized document text. */
    text?: (s: string) => string
  }
}

export const DEFAULT_FILES: Readonly<Record<string, string>> = Object.freeze({
  'CLAUDE.md': '# Agent\n\nYou help with invoices.\n',
  'SOUL.md': 'Calm, precise, brief.\n',
})

export const sha256Hex = (bytes: Uint8Array | string): string =>
  createHash('sha256').update(bytes).digest('hex')

const b64url = (s: string | Uint8Array): string => Buffer.from(s).toString('base64url')

/** A signed delivery document as bytes, ready for verifyDelivery. */
export function makeSignedDelivery(input: DeliveryInput): Uint8Array {
  const files = input.files ?? DEFAULT_FILES
  const avatar = input.avatar === undefined ? null : input.avatar
  const slug = input.slug ?? 'invoice-helper'

  let header: Obj = { alg: 'EdDSA', kid: input.kid, typ: 'mio-agent-package+jws' }
  if (input.tamper?.header) header = input.tamper.header(header)

  let payload: Obj = {
    format: 'mio-agent-package/1',
    slug,
    version: input.version ?? '1.0.0',
    min_marveen_version: input.minMarveenVersion ?? '1.0.0',
    published_at: '2026-11-14T12:00:00Z',
    title: input.title ?? 'Invoice helper',
    description: input.description ?? 'Keeps the invoices in order.',
    agent: {
      display_name: input.displayName ?? 'Invoice helper',
      model_hint: input.modelHint === undefined ? null : input.modelHint,
    },
    connectors: input.connectors ?? [{ name: 'billing', level: 'recommended', reason: 'Reads the invoices.' }],
    files: Object.entries(files).map(([path, text]) => ({
      path,
      sha256: sha256Hex(Buffer.from(text, 'utf8')),
      size: Buffer.byteLength(text, 'utf8'),
    })),
    avatar: avatar
      ? {
          path: avatar.path,
          sha256: sha256Hex(avatar.bytes),
          size: avatar.bytes.length,
          content_type: avatar.contentType,
        }
      : null,
  }
  if (input.tamper?.payload) payload = input.tamper.payload(payload)

  let payloadText = JSON.stringify(payload)
  if (input.tamper?.payloadText) payloadText = input.tamper.payloadText(payloadText)

  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(payloadText)}`
  const signature = sign(null, Buffer.from(signingInput, 'ascii'), input.privateKey)
  let jws = `${signingInput}.${b64url(signature)}`
  if (input.tamper?.jws) jws = input.tamper.jws(jws)

  let document: Obj = {
    format: 'mio-agent-package/1',
    manifest_jws: jws,
    files: { ...files },
    avatar: avatar
      ? { path: avatar.path, content_type: avatar.contentType, base64: Buffer.from(avatar.bytes).toString('base64') }
      : null,
  }
  if (input.tamper?.document) document = input.tamper.document(document)

  let text = JSON.stringify(document)
  if (input.tamper?.text) text = input.tamper.text(text)
  return new Uint8Array(Buffer.from(text, 'utf8'))
}

// ---------------------------------------------------------------------------
// Minimal images: only the container structure, never a real picture.
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** A PNG chunk: length, type, data, and a CRC field (not computed; the verifier does not read it). */
export function pngChunk(type: string, data: Uint8Array = new Uint8Array(0)): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  return Buffer.concat([head, Buffer.from(data), Buffer.alloc(4)])
}

/** A PNG made of the signature and the given chunks (default: IHDR, IDAT, IEND). */
export function makePng(chunks?: Buffer[]): Buffer {
  const body = chunks ?? [pngChunk('IHDR', new Uint8Array(13)), pngChunk('IDAT', new Uint8Array(4)), pngChunk('IEND')]
  return Buffer.concat([Buffer.from(PNG_SIGNATURE), ...body])
}

/** A RIFF chunk: FourCC, little-endian size, data, and a pad byte for an odd size. */
export function webpChunk(fourcc: string, data: Uint8Array = new Uint8Array(0)): Buffer {
  const head = Buffer.alloc(8)
  head.write(fourcc, 0, 'latin1')
  head.writeUInt32LE(data.length, 4)
  const pad = data.length % 2 === 1 ? Buffer.alloc(1) : Buffer.alloc(0)
  return Buffer.concat([head, Buffer.from(data), pad])
}

/** A WebP container (RIFF....WEBP) around the given chunks (default: one VP8L chunk). */
export function makeWebp(chunks?: Buffer[]): Buffer {
  const body = Buffer.concat(chunks ?? [webpChunk('VP8L', new Uint8Array(6))])
  const head = Buffer.alloc(12)
  head.write('RIFF', 0, 'latin1')
  head.writeUInt32LE(4 + body.length, 4)
  head.write('WEBP', 8, 'latin1')
  return Buffer.concat([head, body])
}
