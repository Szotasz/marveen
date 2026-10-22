// The letter envelope an email_send approval carries in its action_payload,
// and its binding to the approval's content_hash.
//
// The owner's Telegram notification may show a letter, and offer buttons for
// it, ONLY when what it shows is the letter the send gate will let through.
// The gate (scripts/hooks/email-approval-gate.py, content_anchor) releases a
// send whose envelope hashes to the approved content_hash; the requester's
// action_description is free text the server never checked against that hash.
// So the requester also sends the structured envelope (envelope_v: 1), and the
// server recomputes the gate's anchor from it: only on an exact match is the
// envelope "bound", and only a bound envelope is ever displayed as the letter.
//
// computeContentAnchor is a byte-for-byte port of content_anchor:
//   json.dumps({to, cc, text[, bcc][, html_sha256][, attachments]},
//              ensure_ascii=False, sort_keys=True, separators=(",", ":"))
// hashed as UTF-8 with sha256. bcc, html_sha256 and attachments join ONLY when
// truthy, exactly like the gate's env.get(...) tests. The parity suite
// (src/__tests__/approval-envelope.test.ts) runs the gate's own function on the
// same vectors. A port mismatch can only cost the buttons (no match -> the
// plain notification), never bind a different letter: that would need a
// sha256 collision.
//
// A lone UTF-16 surrogate cannot be hashed by the gate (str.encode("utf-8")
// raises), so an envelope carrying one is never bound: both the parser and the
// anchor return null for it.

import { createHash } from 'node:crypto'

export const ENVELOPE_VERSION = 1

export interface EnvelopeAttachment {
  name: string
  sha256: string
  size: number
}

export interface EnvelopeV1 {
  envelope_v: 1
  to: string[]
  cc: string[]
  // Always a list after parsing (absent or null in the payload -> []).
  bcc: string[]
  // Subject and body exactly as the gate hashes them (joined by "\n").
  text: string
  // Display hint only, NOT part of the anchor: the gate's text does not keep
  // the subject separable (the MCP path orders it after the body).
  subject?: string
  html_sha256?: string
  // Present only when non-empty; order is kept as sent (the extractor sorts).
  attachments?: EnvelopeAttachment[]
}

// What the anchor covers. EnvelopeV1 is assignable to it.
export interface AnchorFields {
  to: readonly string[]
  cc: readonly string[]
  text: string
  bcc?: readonly string[] | null
  html_sha256?: string | null
  attachments?: readonly EnvelopeAttachment[] | null
}

const SHA256_HEX_RE = /^[0-9a-f]{64}$/
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
const ENVELOPE_KEYS = new Set(['envelope_v', 'to', 'cc', 'bcc', 'text', 'subject', 'html_sha256', 'attachments'])
const ATTACHMENT_KEYS = new Set(['name', 'sha256', 'size'])

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isWellFormedString(v: unknown): v is string {
  return typeof v === 'string' && !LONE_SURROGATE_RE.test(v)
}

function stringList(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null
  for (const item of v) if (!isWellFormedString(item)) return null
  return [...v] as string[]
}

function onlyKeys(obj: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(obj).every(k => allowed.has(k))
}

function parseAttachment(v: unknown): EnvelopeAttachment | null {
  if (!isPlainObject(v) || !onlyKeys(v, ATTACHMENT_KEYS)) return null
  const { name, sha256, size } = v
  if (!isWellFormedString(name)) return null
  if (typeof sha256 !== 'string' || !SHA256_HEX_RE.test(sha256)) return null
  // A Python int prints as its decimal digits; beyond 2^53 a JS number does not.
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) return null
  return { name, sha256, size }
}

/**
 * Strictly parse an approval's action_payload into an envelope, or null.
 * Unknown keys, wrong types, a missing or other envelope_v, a malformed digest,
 * an empty `to`, a blank `text` (the gate denies both) and any lone surrogate
 * all yield null. Optional fields may be absent or null.
 */
export function parseEnvelopePayload(raw: string | null | undefined): EnvelopeV1 | null {
  if (typeof raw !== 'string' || raw === '') return null
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isPlainObject(obj) || !onlyKeys(obj, ENVELOPE_KEYS)) return null
  if (obj['envelope_v'] !== ENVELOPE_VERSION) return null

  const to = stringList(obj['to'])
  const cc = stringList(obj['cc'])
  const bcc = obj['bcc'] === undefined || obj['bcc'] === null ? [] : stringList(obj['bcc'])
  if (!to || !cc || !bcc || to.length === 0) return null

  const text = obj['text']
  if (!isWellFormedString(text) || text.trim() === '') return null

  const env: EnvelopeV1 = { envelope_v: 1, to, cc, bcc, text }

  const subject = obj['subject']
  if (subject !== undefined && subject !== null) {
    if (!isWellFormedString(subject)) return null
    env.subject = subject
  }

  const html = obj['html_sha256']
  if (html !== undefined && html !== null) {
    if (typeof html !== 'string' || !SHA256_HEX_RE.test(html)) return null
    env.html_sha256 = html
  }

  const atts = obj['attachments']
  if (atts !== undefined && atts !== null) {
    if (!Array.isArray(atts)) return null
    const parsed: EnvelopeAttachment[] = []
    for (const a of atts) {
      const p = parseAttachment(a)
      if (!p) return null
      parsed.push(p)
    }
    if (parsed.length > 0) env.attachments = parsed
  }

  return env
}

// Python's json encoder with ensure_ascii=False escapes exactly these:
// backslash, double quote, and U+0000..U+001F (\b \f \n \r \t by name, the
// rest as \u00xx with lowercase hex). Everything else, DEL, C1 controls,
// U+2028/U+2029 and astral characters included, is written raw.
const PY_ESCAPE_RE = /[\\"\u0000-\u001f]/g
const PY_NAMED_ESCAPES: Record<string, string> = {
  '\\': '\\\\', '"': '\\"', '\b': '\\b', '\f': '\\f', '\n': '\\n', '\r': '\\r', '\t': '\\t',
}

function pyJsonString(s: string): string {
  return '"' + s.replace(PY_ESCAPE_RE, c => PY_NAMED_ESCAPES[c] ?? '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')) + '"'
}

// Only the value shapes the anchor can hold: strings, non-negative safe
// integers, lists, and objects. Object keys are the fixed ASCII names above, so
// the default (UTF-16) sort equals Python's code-point sort_keys order.
function pyCanonical(v: unknown): string | null {
  if (typeof v === 'string') return isWellFormedString(v) ? pyJsonString(v) : null
  if (typeof v === 'number') return Number.isSafeInteger(v) && v >= 0 ? String(v) : null
  if (Array.isArray(v)) {
    const parts: string[] = []
    for (const item of v) {
      const p = pyCanonical(item)
      if (p === null) return null
      parts.push(p)
    }
    return '[' + parts.join(',') + ']'
  }
  if (isPlainObject(v)) {
    const parts: string[] = []
    for (const k of Object.keys(v).sort()) {
      const p = pyCanonical(v[k])
      if (p === null) return null
      parts.push(pyJsonString(k) + ':' + p)
    }
    return '{' + parts.join(',') + '}'
  }
  return null
}

function isStringList(v: unknown): boolean {
  return Array.isArray(v) && v.every(x => typeof x === 'string')
}

// The value shapes the extractor produces (email_extract.collect_email_envelope):
// string lists, a string text, and {name, sha256, size} attachments. Anything
// else is not a letter the gate could have anchored, so it is not hashed.
function isAnchorShape(env: AnchorFields): boolean {
  if (!isStringList(env.to) || !isStringList(env.cc) || typeof env.text !== 'string') return false
  if (env.bcc != null && !isStringList(env.bcc)) return false
  if (env.html_sha256 != null && typeof env.html_sha256 !== 'string') return false
  if (env.attachments != null) {
    if (!Array.isArray(env.attachments)) return false
    for (const a of env.attachments as unknown[]) {
      if (!isPlainObject(a) || Object.keys(a).length !== ATTACHMENT_KEYS.size || !onlyKeys(a, ATTACHMENT_KEYS)) return false
      if (typeof a['name'] !== 'string' || typeof a['sha256'] !== 'string' || typeof a['size'] !== 'number') return false
    }
  }
  return true
}

/** The exact JSON text the gate hashes for this envelope, or null if it cannot be hashed. */
export function canonicalAnchorJson(env: AnchorFields): string | null {
  if (!isAnchorShape(env)) return null
  const fields: Record<string, unknown> = { to: env.to, cc: env.cc, text: env.text }
  if (env.bcc && env.bcc.length > 0) fields['bcc'] = env.bcc
  if (env.html_sha256) fields['html_sha256'] = env.html_sha256
  if (env.attachments && env.attachments.length > 0) fields['attachments'] = env.attachments
  return pyCanonical(fields)
}

/** sha256 hex of the gate's canonical envelope JSON, or null (lone surrogate, unsupported value). */
export function computeContentAnchor(env: AnchorFields): string | null {
  const canon = canonicalAnchorJson(env)
  if (canon === null) return null
  return createHash('sha256').update(canon, 'utf8').digest('hex')
}

// Structural, so this module does not depend on db.ts; an Approval fits.
export interface BindableApproval {
  category: string
  content_hash: string | null
  action_payload: string | null
}

// The reason carries no hash and no letter content: it is safe to log.
export type EnvelopeUnboundReason = 'not_email_send' | 'no_content_hash' | 'no_payload' | 'bad_payload' | 'hash_mismatch'

export type EnvelopeBinding =
  | { bound: true; envelope: EnvelopeV1 }
  | { bound: false; reason: EnvelopeUnboundReason }

/** Whether the approval's payload is the very letter its content_hash approves. */
export function envelopeBinding(approval: BindableApproval): EnvelopeBinding {
  if (approval.category !== 'email_send') return { bound: false, reason: 'not_email_send' }
  if (typeof approval.content_hash !== 'string' || !SHA256_HEX_RE.test(approval.content_hash)) {
    return { bound: false, reason: 'no_content_hash' }
  }
  if (typeof approval.action_payload !== 'string' || approval.action_payload === '') {
    return { bound: false, reason: 'no_payload' }
  }
  const envelope = parseEnvelopePayload(approval.action_payload)
  if (!envelope) return { bound: false, reason: 'bad_payload' }
  if (computeContentAnchor(envelope) !== approval.content_hash) return { bound: false, reason: 'hash_mismatch' }
  return { bound: true, envelope }
}

/** The bound envelope, or null when the approval must get the plain notification. */
export function isEnvelopeBound(approval: BindableApproval): EnvelopeV1 | null {
  const b = envelopeBinding(approval)
  return b.bound ? b.envelope : null
}
