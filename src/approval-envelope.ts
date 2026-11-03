/**
 * The letter an email_send approval is for, as the server can CHECK it (APPROVALSLACK1030 (2), Samu 65945).
 *
 * An approval request carries content_hash, the sha256 anchor scripts/hooks/email-approval-gate.py computes over the
 * letter's envelope (content_anchor). The server used to take that hash unchecked and show the requesting agent's own
 * description, so a harmless description could stand over another letter's hash. Here the request's action_payload
 * may carry the envelope itself ({"envelope": {...}}); the server recomputes the anchor with the same canonical rule
 * and only an envelope whose anchor equals content_hash counts as the letter. Anything else is "no verified letter".
 *
 * The rule is the Python one, byte for byte (shared test vectors: src/__tests__/approval-envelope.test.ts runs both):
 * fields to, cc, text always; bcc, render, html_sha256, attachments, account, reply_to, body_format only when Python
 * would call them truthy; canonical JSON with sorted keys, "," and ":" separators, non-ASCII as is; sha256 hex.
 */
import { createHash } from 'node:crypto'

export interface MailAttachment { name: string; sha256: string }

export interface MailEnvelope {
  to: string[]
  cc: string[]
  text: string
  bcc?: string[]
  render?: string
  html_sha256?: string
  attachments?: MailAttachment[]
  account?: string
  reply_to?: Array<string | number>
  body_format?: string
}

const OPTIONAL = ['bcc', 'render', 'html_sha256', 'attachments', 'account', 'reply_to', 'body_format'] as const
const KNOWN = new Set<string>(['to', 'cc', 'text', ...OPTIONAL])

/** A string Python can encode as UTF-8 (no lone surrogate: there Python raises and no anchor exists). */
function isEncodable(s: string): boolean {
  return !/(?:[\uD800-\uDBFF](?![\uDC00-\uDFFF]))|(?:(?<![\uD800-\uDBFF])[\uDC00-\uDFFF])/.test(s)
}

const isStr = (v: unknown): v is string => typeof v === 'string' && isEncodable(v)
const isStrList = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr)

/** Python's truthiness for the values an envelope holds. */
function truthy(v: unknown): boolean {
  if (v === undefined || v === null || v === false || v === 0 || v === '') return false
  if (Array.isArray(v)) return v.length > 0
  if (typeof v === 'object') return Object.keys(v as object).length > 0
  return true
}

/**
 * The envelope, strictly: only the known fields, each of its own shape. Null for anything else (an unknown field, a
 * wrong type, a float, a lone surrogate), so a value the Python rule would serialise differently never gets an anchor.
 */
export function parseEnvelope(raw: unknown): MailEnvelope | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  if (Object.keys(o).some((k) => !KNOWN.has(k))) return null
  if (!isStrList(o.to) || !isStrList(o.cc) || !isStr(o.text)) return null
  const env: MailEnvelope = { to: o.to, cc: o.cc, text: o.text }
  if (o.bcc !== undefined) { if (!isStrList(o.bcc)) return null; env.bcc = o.bcc }
  for (const k of ['render', 'html_sha256', 'account', 'body_format'] as const) {
    if (o[k] !== undefined) { const v = o[k]; if (!isStr(v)) return null; env[k] = v }
  }
  if (o.attachments !== undefined) {
    const a = o.attachments
    if (!Array.isArray(a)) return null
    const list: MailAttachment[] = []
    for (const x of a) {
      if (!x || typeof x !== 'object' || Array.isArray(x)) return null
      const e = x as Record<string, unknown>
      if (Object.keys(e).length !== 2 || !isStr(e.name) || !isStr(e.sha256)) return null
      list.push({ name: e.name, sha256: e.sha256 })
    }
    env.attachments = list
  }
  if (o.reply_to !== undefined) {
    const r = o.reply_to
    if (!Array.isArray(r) || !r.every((x) => isStr(x) || Number.isSafeInteger(x))) return null
    env.reply_to = r as Array<string | number>
  }
  return env
}

/** Python's json.dumps(v, ensure_ascii=False, sort_keys=True, separators=(",", ":")) for envelope values. */
export function canonicalJson(v: unknown): string {
  if (typeof v === 'string' || typeof v === 'number') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']'
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + canonicalJson(o[k])).join(',') + '}'
  }
  throw new Error('canonicalJson: unsupported value')
}

/** content_anchor of email-approval-gate.py. */
export function contentAnchor(env: MailEnvelope): string {
  const fields: Record<string, unknown> = { to: env.to, cc: env.cc, text: env.text }
  for (const k of OPTIONAL) if (truthy(env[k])) fields[k] = env[k]
  return createHash('sha256').update(canonicalJson(fields), 'utf8').digest('hex')
}

/** The envelope a request's action_payload carries ({"envelope": {...}}), or null. */
export function envelopeOfPayload(actionPayload: string | null | undefined): MailEnvelope | null {
  if (!actionPayload) return null
  try {
    const p = JSON.parse(actionPayload) as unknown
    if (!p || typeof p !== 'object' || Array.isArray(p)) return null
    return parseEnvelope((p as Record<string, unknown>).envelope)
  } catch {
    return null
  }
}

/** The letter an email_send request is for, ONLY when its envelope's anchor equals the request's content_hash. */
export function verifiedEnvelope(r: { category: string; action_payload: string | null; content_hash: string | null }): MailEnvelope | null {
  if (r.category !== 'email_send' || !r.content_hash) return null
  const env = envelopeOfPayload(r.action_payload)
  return env && contentAnchor(env) === r.content_hash ? env : null
}

/** The letter as the owner reads it before deciding: every field the anchor covers, the full text. */
export function envelopeText(env: MailEnvelope, contentHash: string): string {
  const lines = [`Címzett: ${env.to.join(', ') || '(nincs)'}`, `Másolat: ${env.cc.join(', ') || '-'}`]
  if (truthy(env.bcc)) lines.push(`Titkos másolat: ${env.bcc!.join(', ')}`)
  if (truthy(env.account)) lines.push(`Fiók: ${env.account}`)
  if (truthy(env.reply_to)) lines.push(`Válasz erre: ${env.reply_to!.join(' / ')}`)
  if (truthy(env.render)) lines.push(`Megjelenítés: ${env.render}`)
  if (truthy(env.body_format)) lines.push(`Formátum: ${env.body_format}`)
  if (truthy(env.html_sha256)) lines.push(`HTML sha256: ${env.html_sha256}`)
  if (truthy(env.attachments)) lines.push(`Csatolmány: ${env.attachments!.map((a) => `${a.name} (sha256 ${a.sha256})`).join(', ')}`)
  lines.push('Szöveg:', env.text, `Horgony (sha256): ${contentHash}`)
  return lines.join('\n')
}
