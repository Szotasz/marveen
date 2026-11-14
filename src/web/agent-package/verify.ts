// Agent package verifier (MIOAGENTINSTALL1114, PR-I1).
//
// Pure: no network, no disk, no environment. `verifyDelivery` runs steps 1-6
// of the contract's B-side check (Sz-4.4) in order, and the first failure
// stops it. The patterns and limits are the contract's, letter for letter
// (Sz-3.1, Sz-4.5). The text rules are copied from the reference scanner of
// the publishing side (marveen-io PR 371, head 4d9b9e99, package-scan.ts), and
// the shared text vector pins both sides to the same bytes: a text rule exists
// here only if the plan names it AND that vector has cases for it.
//
// A refusal's `detail` never carries file content: only a validated path, a
// line number, a rule name, a manifest field name or a limit name.

import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto'
import { frontmatterFindings } from './frontmatter.js'

// ---------------------------------------------------------------------------
// Text rules (S10, S11 with its extension, S17 exec tokens; frontmatter in
// frontmatter.ts)
// ---------------------------------------------------------------------------

export type TextReason =
  | 'bad_text'
  | 'forbidden_import_token'
  | 'forbidden_exec_token'
  | 'forbidden_frontmatter_key'

export interface TextFinding {
  reason: TextReason
  /** The rule's name (never the matched text). */
  rule: string
  /** 1 + the number of LF characters before the match; invalid UTF-8 is line 1. */
  line: number
}

/** The S11 table: [id, first, last], inclusive. Copied from the reference scanner; changes only with the contract. */
export const FORBIDDEN_RANGES: ReadonlyArray<readonly [string, number, number]> = [
  ['c0a', 0x0000, 0x0008],
  ['c0b', 0x000b, 0x000d],
  ['c0c', 0x000e, 0x001f],
  ['del', 0x007f, 0x009f],
  ['shy', 0x00ad, 0x00ad],
  ['cgj', 0x034f, 0x034f],
  ['arf', 0x0600, 0x0605],
  ['alm', 0x061c, 0x061c],
  ['ar2', 0x06dd, 0x06dd],
  ['syr', 0x070f, 0x070f],
  ['ar3', 0x0890, 0x0891],
  ['ar4', 0x08e2, 0x08e2],
  ['hf1', 0x115f, 0x1160],
  ['khm', 0x17b4, 0x17b5],
  ['mvs', 0x180b, 0x180f],
  ['zw', 0x200b, 0x200f],
  ['bidi', 0x2028, 0x202e],
  ['wj', 0x2060, 0x206f],
  ['brl', 0x2800, 0x2800],
  ['hf2', 0x3164, 0x3164],
  ['nch', 0xfdd0, 0xfdef],
  ['vs', 0xfe00, 0xfe0f],
  ['bom', 0xfeff, 0xfeff],
  // S11 extension (v1.2.6): compatibility forms of the three trigger characters.
  ['sxm', 0xfe57, 0xfe57], // small exclamation mark
  ['sat', 0xfe6b, 0xfe6b], // small commercial at
  ['fex', 0xff01, 0xff01], // full-width exclamation mark
  ['fat', 0xff20, 0xff20], // full-width commercial at
  ['fgr', 0xff40, 0xff40], // full-width grave accent
  ['hf3', 0xffa0, 0xffa0],
  ['spc', 0xfff0, 0xfffb],
  // nc2: the last two code points of EVERY plane are noncharacters.
  ...Array.from({ length: 17 }, (_, p) =>
    [`nc2-${p.toString(16)}`, p * 0x10000 + 0xfffe, p * 0x10000 + 0xffff] as const),
  ['kth1', 0x110bd, 0x110bd],
  ['kth2', 0x110cd, 0x110cd],
  ['egy', 0x13430, 0x1343f],
  ['shf', 0x1bca0, 0x1bca3],
  ['mus', 0x1d173, 0x1d17a],
  ['tag', 0xe0000, 0xe0fff],
]

const SORTED_RANGES = [...FORBIDDEN_RANGES].sort((a, b) => a[1] - b[1])

/** True when the code point is in the S11 table (binary search). */
export function isForbiddenCodePoint(cp: number): boolean {
  let lo = 0
  let hi = SORTED_RANGES.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const [, first, last] = SORTED_RANGES[mid]
    if (cp < first) hi = mid - 1
    else if (cp > last) lo = mid + 1
    else return true
  }
  return false
}

/** S10: an at sign not IMMEDIATELY preceded by an ASCII letter or digit. No code-block exception. */
const IMPORT_TOKEN_RE = /(?<![A-Za-z0-9])@/gu
/** S17 (1): the inline pre-run shape, a bang right before a backtick. */
const EXEC_TOKEN_RE = /!`/gu
/** S17 (1): the fenced pre-run shape, three backticks and a bang, anywhere. */
const FENCE_BANG_RE = /```!/gu
/**
 * S11 extension (v1.2.6): the HTML-entity forms of the at sign, the bang and
 * the backtick: decimal and hex (either x, any leading zeros, with or without
 * the closing semicolon, no digit after), and named.
 */
const TRIGGER_ENTITY_RE =
  /&#0*(?:64|33|96)(?![0-9])|&#[xX]0*(?:40|21|60)(?![0-9A-Fa-f])|&(?:commat|excl|grave|DiacriticalGrave);/gu

/** Which reason wins when one text breaks more than one rule (the reference scanner's order). */
const PRECEDENCE: Record<TextReason, number> = {
  bad_text: 0,
  forbidden_import_token: 1,
  forbidden_exec_token: 2,
  forbidden_frontmatter_key: 3,
}

function lineIndexer(text: string): (index: number) => number {
  const lfs: number[] = []
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 0x0a) lfs.push(i)
  return (index) => {
    let lo = 0
    let hi = lfs.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (lfs[mid] < index) lo = mid + 1
      else hi = mid
    }
    return lo + 1
  }
}

/** S11 and S10 over one text: forbidden code points, trigger entities, word-initial at signs. */
function charAndImportFindings(text: string, lineOf: (i: number) => number): TextFinding[] {
  const out: TextFinding[] = []
  let i = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    // By code point, so a lone surrogate shows as itself. A file text cannot
    // hold one (it is decoded from strict UTF-8 bytes); a manifest text can,
    // through a JSON escape in a payload whose bytes are well formed.
    if (cp >= 0xd800 && cp <= 0xdfff) {
      out.push({ reason: 'bad_text', rule: 'invalid-utf16', line: lineOf(i) })
    } else if (isForbiddenCodePoint(cp)) {
      out.push({ reason: 'bad_text', rule: 'forbidden-char', line: lineOf(i) })
    }
    i += ch.length
  }
  for (const m of text.matchAll(TRIGGER_ENTITY_RE)) {
    out.push({ reason: 'bad_text', rule: 'trigger-entity', line: lineOf(m.index!) })
  }
  for (const m of text.matchAll(IMPORT_TOKEN_RE)) {
    out.push({ reason: 'forbidden_import_token', rule: 'at-sign', line: lineOf(m.index!) })
  }
  return out
}

/** The first finding: the winning reason by precedence, then the lowest line, then the rule name. */
function firstFinding(findings: TextFinding[]): TextFinding | null {
  let best: TextFinding | null = null
  for (const f of findings) {
    if (
      best === null ||
      PRECEDENCE[f.reason] < PRECEDENCE[best.reason] ||
      (PRECEDENCE[f.reason] === PRECEDENCE[best.reason] &&
        (f.line < best.line || (f.line === best.line && f.rule < best.rule)))
    ) {
      best = f
    }
  }
  return best
}

const strictUtf8 = (): TextDecoder =>
  // ignoreBOM: the default decoder silently drops a leading BOM, and the
  // forbidden-char rule would never see it (measured by the publishing side).
  new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/**
 * Every text rule over one package text file, given as its bytes. Returns the
 * first finding (see `firstFinding`), or null when the file passes.
 */
export function scanPackageText(bytes: Uint8Array): TextFinding | null {
  let text: string
  try {
    text = strictUtf8().decode(bytes)
  } catch {
    return { reason: 'bad_text', rule: 'invalid-utf8', line: 1 }
  }
  const lineOf = lineIndexer(text)
  const findings = charAndImportFindings(text, lineOf)
  for (const m of text.matchAll(EXEC_TOKEN_RE)) {
    findings.push({ reason: 'forbidden_exec_token', rule: 'bang-backtick', line: lineOf(m.index!) })
  }
  for (const m of text.matchAll(FENCE_BANG_RE)) {
    findings.push({ reason: 'forbidden_exec_token', rule: 'fence-bang', line: lineOf(m.index!) })
  }
  for (const f of frontmatterFindings(text)) {
    findings.push({ reason: 'forbidden_frontmatter_key', rule: f.rule, line: f.line })
  }
  return firstFinding(findings)
}

/**
 * D10 and S18 point 1 over one manifest free text: one line only, then the S11
 * and S10 rules (not the exec or frontmatter rules: the plan names S10 and S11
 * for manifest texts). Returns the refusal, or null when the text passes.
 */
export function scanManifestText(text: string): { reason: VerifyReason; rule: string } | null {
  if (/[\n\r]/.test(text)) {
    return { reason: N21B_PROVISIONAL_REASONS.manifestLineBreak, rule: 'manifest-line-break' }
  }
  const f = firstFinding(charAndImportFindings(text, () => 1))
  return f === null ? null : { reason: N21B_PROVISIONAL_REASONS.manifestText(f.reason), rule: f.rule }
}

// ---------------------------------------------------------------------------
// Fixed patterns and limits (Sz-3.1, Sz-4.3, Sz-4.5)
// ---------------------------------------------------------------------------

/** Sz-3.1 slug. The stricter shape (N9/a) is the installer's pre-download filter, not this module's. */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,39}$/
/** Sz-3.1 version and min_marveen_version. */
export const VERSION_RE = /^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$/
/** Sz-4.5 text path, the one-line form the contract names authoritative. */
export const TEXT_PATH_RE =
  /^(CLAUDE\.md|SOUL\.md|skills\/[a-z0-9][a-z0-9-]{0,63}\/SKILL\.md|skills\/[a-z0-9][a-z0-9-]{0,63}\/references\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.md)$/
/** Sz-4.5 avatar path. */
export const AVATAR_PATH_RE = /^avatar\.(png|webp)$/

export const MAX_TEXT_FILES = 64
export const MAX_TOTAL_TEXT_BYTES = 1024 * 1024
export const MAX_TEXT_FILE_BYTES = 256 * 1024
export const MAX_AVATAR_BYTES = 512 * 1024
/** Sz-4.3: the whole delivery document. Enforced while reading (remote.ts, step 0), not here. */
export const MAX_DELIVERY_BYTES = 3 * 1024 * 1024

export const PACKAGE_FORMAT = 'mio-agent-package/1'
export const JWS_ALG = 'EdDSA'
export const JWS_TYP = 'mio-agent-package+jws'
/** Both are required (Mira 77384, S15); missing either is missing_required_file with the path. */
export const REQUIRED_FILES = ['CLAUDE.md', 'SOUL.md'] as const
/** Sz-4.3: the two values a connector's level may take, letter for letter. */
export const CONNECTOR_LEVELS = ['required', 'recommended'] as const
export type ConnectorLevel = (typeof CONNECTOR_LEVELS)[number]
/** Contract decision (Mira 77967): a connector name has the slug's strict grammar, 2 to 40 characters. */
export const CONNECTOR_NAME_RE = /^(?=.{2,40}$)[a-z0-9]+(-[a-z0-9]+)*$/
/** Contract decision (Mira 77967): a model hint has a model id's shape (or it is null or absent, Sz-4.3). */
export const MODEL_HINT_RE = /^[a-z0-9][a-z0-9.-]{1,63}$/

const AVATAR_CONTENT_TYPES: Readonly<Record<string, string>> = {
  'avatar.png': 'image/png',
  'avatar.webp': 'image/webp',
}

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

/** A public key of the list, in the contract's JWK shape (Sz-4.6). */
export interface Jwk {
  readonly kty: 'OKP'
  readonly crv: 'Ed25519'
  readonly x: string
  readonly kid: string
}

export type VerifyReason =
  | 'bad_document'
  | 'unknown_kid'
  | 'header_mismatch'
  | 'bad_signature'
  | 'bad_payload'
  | 'unknown_format'
  | 'slug_mismatch'
  | 'file_set_mismatch'
  | 'missing_required_file'
  | 'path_not_allowed'
  | 'case_collision'
  | 'hash_mismatch'
  | 'size_mismatch'
  | 'bad_text'
  | 'forbidden_import_token'
  | 'forbidden_exec_token'
  | 'forbidden_frontmatter_key'
  | 'bad_avatar'
  | 'limit_exceeded'

export type VerifyStep = 1 | 2 | 3 | 4 | 5 | 6

/** Never file content: a validated path, a line, a rule name, a manifest field name, a limit name. */
export interface VerifyDetail {
  path?: string
  line?: number
  rule?: string
  field?: string
  limit?: 'file_count' | 'total_text_bytes' | 'text_file_bytes' | 'avatar_bytes'
}

export type VerifyResult =
  | { ok: true; pkg: VerifiedPackage }
  | { ok: false; step: VerifyStep; reason: VerifyReason; detail?: VerifyDetail }

/**
 * PROVISIONAL (open contract point N21/b): the refusal codes of D10 (manifest
 * texts, avatar blocks) and S18 point 1 (one-line manifest texts) are not
 * decided yet. Until they are, they map to EXISTING codes, here and only
 * here: a manifest text breaking a text rule gets the reason that rule gives a
 * file, a line break in a manifest text is bad_text, and an avatar block that
 * is not allowed, out of place or truncated is bad_avatar.
 */
export const N21B_PROVISIONAL_REASONS = Object.freeze({
  manifestText: (fileRuleReason: TextReason): VerifyReason => fileRuleReason,
  manifestLineBreak: 'bad_text' as VerifyReason,
  avatarBlockNotAllowed: 'bad_avatar' as VerifyReason,
  avatarBlockStructure: 'bad_avatar' as VerifyReason,
  avatarTruncatedBlock: 'bad_avatar' as VerifyReason,
})

// ---------------------------------------------------------------------------
// VerifiedPackage: only verifyDelivery can create one
// ---------------------------------------------------------------------------

export interface VerifiedFile {
  readonly path: string
  readonly sha256: string
  readonly size: number
  /** The file's text, decoded from exactly the bytes that were hashed and scanned. */
  readonly text: string
}

export interface VerifiedAvatar {
  readonly path: string
  readonly contentType: 'image/png' | 'image/webp'
  readonly sha256: string
  readonly size: number
}

export interface VerifiedConnector {
  readonly name: string
  readonly level: ConnectorLevel
  readonly reason: string
}

interface VerifiedFields {
  slug: string
  version: string
  minMarveenVersion: string
  kid: string
  payloadSha256: string
  payloadBytes: Uint8Array
  title: string
  description: string
  displayName: string
  modelHint: string | null
  connectors: VerifiedConnector[]
  files: VerifiedFile[]
  avatar: VerifiedAvatar | null
  avatarBytes: Uint8Array | null
}

/** Module-private: not exported, and not a property of the class or of anything else. */
const MINT_TOKEN: unique symbol = Symbol('VerifiedPackage.mint')
/** Assigned from the class's static initialisation block; the only way to an instance. */
let mintVerifiedPackage: (f: VerifiedFields) => VerifiedPackage

/**
 * A delivery that passed steps 1-6. The code that writes to disk accepts only
 * this class. At type level the constructor is private, so a raw document is a
 * type error (npm run typecheck). At run time the constructor checks a token
 * that no property leads to, the class and its prototype are frozen, and
 * instanceof is true only for an object the constructor built (it asks for
 * the private field, so an object that merely has this prototype fails).
 * Every string PROPERTY of an instance passed a closed pattern (slug,
 * versions, paths, hashes, connector name and level, model hint) or the
 * manifest text rules (title, description, display name, connector reason;
 * D10); the installer reads them from here, never from the raw payload.
 * The raw signed payload is NOT a property: it holds unknown keys and values
 * no rule has seen, so it is handed out only as bytes, by a method whose name
 * says so (`unverifiedPayloadBytes`), for the record the installer keeps of
 * what was signed.
 */
export class VerifiedPackage {
  readonly slug: string
  readonly version: string
  readonly minMarveenVersion: string
  /** The kid that signed it. */
  readonly kid: string
  /** sha256 of the base64url-decoded JWS payload segment bytes (contract B5/S7). */
  readonly payloadSha256: string
  readonly title: string
  readonly description: string
  readonly displayName: string
  readonly modelHint: string | null
  readonly connectors: ReadonlyArray<VerifiedConnector>
  readonly files: ReadonlyArray<VerifiedFile>
  readonly avatar: VerifiedAvatar | null
  readonly #avatarBytes: Uint8Array | null
  readonly #payloadBytes: Uint8Array

  private constructor(token: typeof MINT_TOKEN, f: VerifiedFields) {
    if (token !== MINT_TOKEN) throw new TypeError('VerifiedPackage is created by verifyDelivery only')
    this.slug = f.slug
    this.version = f.version
    this.minMarveenVersion = f.minMarveenVersion
    this.kid = f.kid
    this.payloadSha256 = f.payloadSha256
    this.#payloadBytes = Uint8Array.from(f.payloadBytes)
    this.title = f.title
    this.description = f.description
    this.displayName = f.displayName
    this.modelHint = f.modelHint
    this.connectors = Object.freeze(f.connectors.map((c) => Object.freeze({ ...c })))
    this.files = Object.freeze(f.files.map((x) => Object.freeze({ ...x })))
    this.avatar = f.avatar === null ? null : Object.freeze({ ...f.avatar })
    this.#avatarBytes = f.avatarBytes === null ? null : Uint8Array.from(f.avatarBytes)
    Object.freeze(this)
  }

  static [Symbol.hasInstance](value: unknown): boolean {
    return typeof value === 'object' && value !== null && #avatarBytes in value
  }

  static {
    mintVerifiedPackage = (f) => new VerifiedPackage(MINT_TOKEN, f)
    Object.freeze(VerifiedPackage.prototype)
    Object.freeze(VerifiedPackage)
  }

  /** A copy of the verified avatar bytes, or null. */
  avatarBytes(): Uint8Array | null {
    return this.#avatarBytes === null ? null : Uint8Array.from(this.#avatarBytes)
  }

  /**
   * A copy of the signed payload bytes, exactly as signed: the bytes
   * `payloadSha256` is the hash of. UNVERIFIED beyond the fields this class
   * names: unknown payload keys pass step 2, and no text rule ran on them.
   * For storing what was signed; never a source of a text to show or to write
   * into a file the CLI reads.
   */
  unverifiedPayloadBytes(): Uint8Array {
    return Uint8Array.from(this.#payloadBytes)
  }
}

// ---------------------------------------------------------------------------
// verifyDelivery: Sz-4.4 steps 1-6
// ---------------------------------------------------------------------------

type Obj = Record<string, unknown>

const isPlainObject = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k)
const B64URL_SEGMENT_RE = /^[A-Za-z0-9_-]+$/
const B64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const SHA256_HEX_RE = /^[0-9a-f]{64}$/
const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const isSize = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0

function fail(step: VerifyStep, reason: VerifyReason, detail?: VerifyDetail): VerifyResult {
  return detail === undefined ? { ok: false, step, reason } : { ok: false, step, reason, detail }
}

/** base64url segment -> JSON object, or null (strict UTF-8, no BOM tolerance). */
function decodeJsonSegment(segment: string): { obj: Obj; bytes: Buffer; text: string } | null {
  try {
    const bytes = Buffer.from(segment, 'base64url')
    const text = strictUtf8().decode(bytes)
    const obj: unknown = JSON.parse(text)
    return isPlainObject(obj) ? { obj, bytes, text } : null
  } catch {
    return null
  }
}

interface PayloadFile {
  path: string
  sha256: string
  size: number
}

interface PayloadAvatar extends PayloadFile {
  content_type: string
}

interface OuterAvatar {
  path: string
  content_type: string
  base64: string
}

function payloadFileOf(v: unknown): PayloadFile | null {
  if (!isPlainObject(v)) return null
  if (typeof v.path !== 'string' || typeof v.sha256 !== 'string' || !SHA256_HEX_RE.test(v.sha256)) return null
  if (!isSize(v.size)) return null
  return { path: v.path, sha256: v.sha256, size: v.size }
}

/**
 * Verify a delivery document (the bytes as read, at most MAX_DELIVERY_BYTES)
 * for the slug the owner asked for, against the given public keys. Steps 1-6
 * of Sz-4.4, in order; the first failure stops.
 */
export function verifyDelivery(bytes: Uint8Array, requestedSlug: string, keys: readonly Jwk[]): VerifyResult {
  // ---- Step 1: document, JWS header, kid, signature. The payload is NOT interpreted here.
  let doc: unknown
  try {
    doc = JSON.parse(strictUtf8().decode(bytes))
  } catch {
    return fail(1, 'bad_document')
  }
  if (!isPlainObject(doc) || typeof doc.manifest_jws !== 'string') return fail(1, 'bad_document')
  const outerFiles = doc.files
  if (!isPlainObject(outerFiles) || !Object.values(outerFiles).every((v) => typeof v === 'string')) {
    return fail(1, 'bad_document')
  }
  let outerAvatar: OuterAvatar | null
  if (doc.avatar === null) outerAvatar = null
  else if (
    isPlainObject(doc.avatar) &&
    typeof doc.avatar.path === 'string' &&
    typeof doc.avatar.content_type === 'string' &&
    typeof doc.avatar.base64 === 'string'
  ) {
    outerAvatar = { path: doc.avatar.path, content_type: doc.avatar.content_type, base64: doc.avatar.base64 }
  } else return fail(1, 'bad_document')

  const segments = doc.manifest_jws.split('.')
  if (segments.length !== 3 || !segments.every((s) => B64URL_SEGMENT_RE.test(s))) return fail(1, 'bad_document')
  const [headerSeg, payloadSeg, signatureSeg] = segments
  const header = decodeJsonSegment(headerSeg)
  if (header === null) return fail(1, 'bad_document')

  // The kid picks the key and the algorithm; an unknown kid is refused, no other key is tried.
  const kid = header.obj.kid
  const key = typeof kid === 'string' ? keys.find((k) => k.kid === kid) : undefined
  if (key === undefined) return fail(1, 'unknown_kid')

  // S13: exactly alg, kid and typ, with the fixed values.
  const headerKeys = Object.keys(header.obj).sort()
  if (
    headerKeys.length !== 3 ||
    headerKeys[0] !== 'alg' ||
    headerKeys[1] !== 'kid' ||
    headerKeys[2] !== 'typ' ||
    header.obj.alg !== JWS_ALG ||
    header.obj.typ !== JWS_TYP
  ) {
    return fail(1, 'header_mismatch')
  }

  let signatureOk = false
  if (key.kty === 'OKP' && key.crv === 'Ed25519' && typeof key.x === 'string') {
    try {
      const publicKey = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: key.x }, format: 'jwk' })
      signatureOk = verifySignature(
        null,
        Buffer.from(`${headerSeg}.${payloadSeg}`, 'ascii'),
        publicKey,
        Buffer.from(signatureSeg, 'base64url'),
      )
    } catch {
      signatureOk = false
    }
  }
  if (!signatureOk) return fail(1, 'bad_signature')

  // ---- Step 2: the signed payload. Unknown payload keys pass on purpose (a
  // later contract version may add fields); the header, by S13, may have none.
  const decoded = decodeJsonSegment(payloadSeg)
  if (decoded === null) return fail(2, 'bad_payload')
  const payload = decoded.obj
  if (payload.format !== PACKAGE_FORMAT) return fail(2, 'unknown_format')
  if (payload.slug !== requestedSlug) return fail(2, 'slug_mismatch')

  if (typeof payload.slug !== 'string' || !SLUG_RE.test(payload.slug)) return fail(2, 'bad_payload')
  if (typeof payload.version !== 'string' || !VERSION_RE.test(payload.version)) return fail(2, 'bad_payload')
  if (typeof payload.min_marveen_version !== 'string' || !VERSION_RE.test(payload.min_marveen_version)) {
    return fail(2, 'bad_payload')
  }
  if (typeof payload.title !== 'string' || typeof payload.description !== 'string') return fail(2, 'bad_payload')
  const agent = payload.agent
  if (!isPlainObject(agent) || typeof agent.display_name !== 'string') return fail(2, 'bad_payload')
  const modelHint = agent.model_hint
  if (modelHint !== undefined && modelHint !== null) {
    if (typeof modelHint !== 'string' || !MODEL_HINT_RE.test(modelHint)) return fail(2, 'bad_payload')
  }
  if (!Array.isArray(payload.connectors)) return fail(2, 'bad_payload')
  const connectors: VerifiedConnector[] = []
  for (const c of payload.connectors) {
    if (!isPlainObject(c) || typeof c.name !== 'string' || typeof c.level !== 'string' || typeof c.reason !== 'string') {
      return fail(2, 'bad_payload')
    }
    if (!CONNECTOR_NAME_RE.test(c.name)) return fail(2, 'bad_payload')
    const level = CONNECTOR_LEVELS.find((l) => l === c.level)
    if (level === undefined) return fail(2, 'bad_payload')
    connectors.push({ name: c.name, level, reason: c.reason })
  }
  if (!Array.isArray(payload.files)) return fail(2, 'bad_payload')
  const files: PayloadFile[] = []
  for (const f of payload.files) {
    const pf = payloadFileOf(f)
    if (pf === null) return fail(2, 'bad_payload')
    files.push(pf)
  }
  if (!hasOwn(payload, 'avatar')) return fail(2, 'bad_payload')
  let avatar: PayloadAvatar | null = null
  if (payload.avatar !== null) {
    const pa = payloadFileOf(payload.avatar)
    const ct = isPlainObject(payload.avatar) ? payload.avatar.content_type : undefined
    if (pa === null || typeof ct !== 'string') return fail(2, 'bad_payload')
    avatar = { ...pa, content_type: ct }
  }

  // ---- Step 3: the file set.
  const paths = new Set<string>()
  for (const f of files) {
    if (paths.has(f.path)) return fail(3, 'file_set_mismatch')
    paths.add(f.path)
  }
  const outerPaths = Object.keys(outerFiles)
  if (outerPaths.length !== paths.size || !outerPaths.every((p) => paths.has(p))) {
    return fail(3, 'file_set_mismatch')
  }
  for (const required of REQUIRED_FILES) {
    if (!paths.has(required)) return fail(3, 'missing_required_file', { path: required })
  }
  if (avatar !== null && paths.has(avatar.path)) return fail(3, 'file_set_mismatch')
  if ((outerAvatar === null) !== (avatar === null)) return fail(3, 'file_set_mismatch')
  if (outerAvatar !== null && avatar !== null && outerAvatar.path !== avatar.path) {
    return fail(3, 'file_set_mismatch')
  }

  // ---- Step 4: paths.
  for (const f of files) {
    if (!TEXT_PATH_RE.test(f.path)) return fail(4, 'path_not_allowed')
  }
  if (avatar !== null && !AVATAR_PATH_RE.test(avatar.path)) return fail(4, 'path_not_allowed')
  const lowered = new Set<string>()
  for (const p of [...files.map((f) => f.path), ...(avatar === null ? [] : [avatar.path])]) {
    const l = p.toLowerCase()
    if (lowered.has(l)) return fail(4, 'case_collision')
    lowered.add(l)
  }

  // ---- Step 5: content. Files in payload order, then the manifest texts, then the avatar.
  const verifiedFiles: VerifiedFile[] = []
  for (const f of files) {
    const fileBytes = Buffer.from(outerFiles[f.path] as string, 'utf8')
    if (sha256Hex(fileBytes) !== f.sha256) return fail(5, 'hash_mismatch', { path: f.path })
    if (fileBytes.length !== f.size) return fail(5, 'size_mismatch', { path: f.path })
    const finding = scanPackageText(fileBytes)
    if (finding !== null) {
      return fail(5, finding.reason, { path: f.path, line: finding.line, rule: finding.rule })
    }
    verifiedFiles.push({ path: f.path, sha256: f.sha256, size: f.size, text: strictUtf8().decode(fileBytes) })
  }

  const manifestTexts: Array<[string, string]> = [
    ['title', payload.title],
    ['description', payload.description],
    ['agent.display_name', agent.display_name],
    ...connectors.map((c, i): [string, string] => [`connectors[${i}].reason`, c.reason]),
  ]
  for (const [field, text] of manifestTexts) {
    const refusal = scanManifestText(text)
    if (refusal !== null) return fail(5, refusal.reason, { field, rule: refusal.rule })
  }

  let avatarBytes: Buffer | null = null
  if (avatar !== null && outerAvatar !== null) {
    if (!B64_RE.test(outerAvatar.base64)) return fail(5, 'bad_avatar', { path: avatar.path, rule: 'base64' })
    avatarBytes = Buffer.from(outerAvatar.base64, 'base64')
    if (sha256Hex(avatarBytes) !== avatar.sha256) return fail(5, 'hash_mismatch', { path: avatar.path })
    if (avatarBytes.length !== avatar.size) return fail(5, 'size_mismatch', { path: avatar.path })
    const expectedType = AVATAR_CONTENT_TYPES[avatar.path]
    if (avatar.content_type !== expectedType || !hasMagic(avatarBytes, expectedType)) {
      return fail(5, 'bad_avatar', { path: avatar.path, rule: 'content-type' })
    }
    const block = avatarBlockRefusal(avatarBytes, expectedType)
    if (block !== null) return fail(5, block.reason, { path: avatar.path, rule: block.rule })
  }

  // ---- Step 6: limits (Sz-4.5), by the payload's sizes, which step 5 proved.
  if (files.length > MAX_TEXT_FILES) return fail(6, 'limit_exceeded', { limit: 'file_count' })
  const total = files.reduce((n, f) => n + f.size, 0)
  if (total > MAX_TOTAL_TEXT_BYTES) return fail(6, 'limit_exceeded', { limit: 'total_text_bytes' })
  for (const f of files) {
    if (f.size > MAX_TEXT_FILE_BYTES) return fail(6, 'limit_exceeded', { limit: 'text_file_bytes', path: f.path })
  }
  if (avatar !== null && avatar.size > MAX_AVATAR_BYTES) {
    return fail(6, 'limit_exceeded', { limit: 'avatar_bytes', path: avatar.path })
  }

  return {
    ok: true,
    pkg: mintVerifiedPackage({
      slug: payload.slug,
      version: payload.version,
      minMarveenVersion: payload.min_marveen_version,
      kid: key.kid,
      payloadSha256: sha256Hex(decoded.bytes),
      payloadBytes: decoded.bytes,
      title: payload.title,
      description: payload.description,
      displayName: agent.display_name,
      modelHint: typeof modelHint === 'string' ? modelHint : null,
      connectors,
      files: verifiedFiles,
      avatar:
        avatar === null
          ? null
          : {
              path: avatar.path,
              contentType: avatar.content_type as VerifiedAvatar['contentType'],
              sha256: avatar.sha256,
              size: avatar.size,
            },
      avatarBytes,
    }),
  }
}

// ---------------------------------------------------------------------------
// Avatar container checks (step 5): leading bytes, and the allowed blocks (D10).
// Only the block headers are read (type and length); the image is never decoded.
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
/**
 * Contract decision (Mira 77967): an allowlist, not a denylist. A PNG avatar
 * may carry these chunks only; every other one (text, ICC, private, a
 * different letter case) is refused.
 */
const PNG_ALLOWED_CHUNKS: ReadonlySet<string> = new Set(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND'])
/** The only WebP chunks, and the only orders they may come in (simple lossy, simple lossless, extended). */
const WEBP_ALLOWED_CHUNKS: ReadonlySet<string> = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH'])
const WEBP_ALLOWED_LAYOUTS: ReadonlySet<string> = new Set([
  'VP8 ',
  'VP8L',
  'VP8X,VP8 ',
  'VP8X,VP8L',
  'VP8X,ALPH,VP8 ',
  'VP8X,ALPH,VP8L',
])

const ascii = (b: Uint8Array, start: number, end: number): string => Buffer.from(b.subarray(start, end)).toString('latin1')

function hasMagic(b: Uint8Array, contentType: string | undefined): boolean {
  if (contentType === 'image/png') return b.length >= 8 && PNG_SIGNATURE.every((x, i) => b[i] === x)
  if (contentType === 'image/webp') return b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP'
  return false
}

/**
 * Walk every block of the container to the end of the bytes. Refused: a block
 * whose header or length runs past the end, a block type outside the
 * allowlist, and a block order the contract does not name (PNG: IHDR first
 * and once, at least one IDAT, IEND last and once, PLTE and tRNS at most
 * once; WebP: one of the layouts, so ALPH at most once and one image).
 */
function avatarBlockRefusal(b: Buffer, contentType: string): { reason: VerifyReason; rule: string } | null {
  const truncated = { reason: N21B_PROVISIONAL_REASONS.avatarTruncatedBlock, rule: 'truncated-block' }
  const notAllowed = { reason: N21B_PROVISIONAL_REASONS.avatarBlockNotAllowed, rule: 'block-not-allowed' }
  const structure = { reason: N21B_PROVISIONAL_REASONS.avatarBlockStructure, rule: 'block-structure' }
  const types: string[] = []
  if (contentType === 'image/png') {
    let off = 8
    while (off < b.length) {
      if (off + 8 > b.length) return truncated
      const len = b.readUInt32BE(off)
      const type = ascii(b, off + 4, off + 8)
      const end = off + 12 + len
      if (end > b.length) return truncated
      if (!PNG_ALLOWED_CHUNKS.has(type)) return notAllowed
      types.push(type)
      off = end
    }
    const count = (t: string): number => types.filter((x) => x === t).length
    if (types[0] !== 'IHDR' || count('IHDR') !== 1) return structure
    if (count('IDAT') < 1) return structure
    if (types[types.length - 1] !== 'IEND' || count('IEND') !== 1) return structure
    // Contract decision (Mira 78020): the palette and the transparency block at most once.
    if (count('PLTE') > 1 || count('tRNS') > 1) return structure
    return null
  }
  // WebP: the RIFF size must not point past the end; then every chunk, padded to an even length.
  if (8 + b.readUInt32LE(4) > b.length) return truncated
  let off = 12
  while (off < b.length) {
    if (off + 8 > b.length) return truncated
    const fourcc = ascii(b, off, off + 4)
    const len = b.readUInt32LE(off + 4)
    const end = off + 8 + len + (len % 2)
    if (end > b.length) return truncated
    if (!WEBP_ALLOWED_CHUNKS.has(fourcc)) return notAllowed
    types.push(fourcc)
    off = end
  }
  return WEBP_ALLOWED_LAYOUTS.has(types.join(',')) ? null : structure
}

// ---------------------------------------------------------------------------
// Sz-4.4 step 7 (run by the route, not by verifyDelivery)
// ---------------------------------------------------------------------------

/** The three numbers of a contract version, or null when it does not match VERSION_RE. */
export function parseVersion(v: string): [number, number, number] | null {
  const m = VERSION_RE.exec(v)
  return m === null ? null : [Number(m[1]), Number(m[2]), Number(m[3])]
}

/** Number by number (1.10.0 > 1.9.0). Throws RangeError on a version that is not the contract's shape. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (pa === null || pb === null) throw new RangeError('not a contract version')
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1
  }
  return 0
}

export type VersionClass = 'upgrade' | 'repair' | 'version_conflict' | 'downgrade_refused'

export interface VersionedPackage {
  version: string
  /** sha256 of the decoded JWS payload bytes (B5): a re-signed, byte-identical payload has the same one. */
  payloadSha256: string
}

/**
 * Sz-4.4/7 (plan 8.1): a higher version is an upgrade; the same version with
 * the same payload hash is a repair reinstall; the same version with a
 * different payload hash is version_conflict; a lower one is downgrade_refused.
 */
export function classifyVersion(installed: VersionedPackage, available: VersionedPackage): VersionClass {
  const c = compareVersions(available.version, installed.version)
  if (c > 0) return 'upgrade'
  if (c < 0) return 'downgrade_refused'
  return available.payloadSha256 === installed.payloadSha256 ? 'repair' : 'version_conflict'
}

/** Sz-4.4/7: the own Marveen version is at least the package's min_marveen_version. */
export function meetsMinMarveenVersion(ownVersion: string, minMarveenVersion: string): boolean {
  return compareVersions(ownVersion, minMarveenVersion) >= 0
}
