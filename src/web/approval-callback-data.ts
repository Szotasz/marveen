// callback_data of the owner's approve/reject buttons on an email_send
// approval notification.
//
//   apv:<a|r>:<id32>:<nonce22>      61 bytes; Telegram allows at most 64
//
// id32 is the approval UUID without its dashes (lowercase hex). nonce22 is 16
// random bytes, base64url without padding, minted once per BUTTON: the approve
// and the reject button of one notification carry different nonces, so the
// data of one button never takes the other decision. Only their sha256s are
// stored, and the request a press turns into (POST /api/approvals/:id/telegram)
// must carry the pressed button's nonce itself. Everything else
// in that request -- the owner's user id, the chat, the notification's message
// id -- can be read by any holder of the shared dashboard token; the nonce is
// the part only the button has.
//
// The channel plugin parses the same shape with its own copy of this regex (the
// patched block imports nothing); the integration suite checks that the two
// agree. The parser is exact: no case folding, no trimming, no prefix match.

import { createHash, randomBytes } from 'node:crypto'

export const CALLBACK_DATA_MAX_BYTES = 64

export const APPROVAL_CALLBACK_RE = /^apv:([ar]):([0-9a-f]{32}):([A-Za-z0-9_-]{22})$/
export const CALLBACK_NONCE_RE = /^[A-Za-z0-9_-]{22}$/

// randomUUID() output: the only id form a button is ever built for.
const APPROVAL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export type ApprovalCallbackDecision = 'approved' | 'rejected'

export interface ParsedApprovalCallback {
  decision: ApprovalCallbackDecision
  // The UUID with its dashes restored, as stored in approvals.id.
  approvalId: string
  nonce: string
}

/** A fresh 128-bit nonce: 16 random bytes, base64url, no padding (22 chars). */
export function newCallbackNonce(): string {
  return randomBytes(16).toString('base64url')
}

/** sha256 hex of the nonce text; the only form of the nonce that may be stored. */
export function nonceHash(nonce: string): string {
  return createHash('sha256').update(nonce, 'utf8').digest('hex')
}

export function isCallbackNonce(v: unknown): v is string {
  return typeof v === 'string' && CALLBACK_NONCE_RE.test(v)
}

/**
 * The callback_data for one button. Throws on a malformed input: that is a
 * caller bug, and the message deliberately names no input (it would carry the
 * nonce into a log).
 */
export function buildCallbackData(decision: ApprovalCallbackDecision, approvalId: string, nonce: string): string {
  if (decision !== 'approved' && decision !== 'rejected') throw new TypeError('approval callback: bad decision')
  if (typeof approvalId !== 'string' || !APPROVAL_UUID_RE.test(approvalId)) throw new TypeError('approval callback: bad approval id')
  if (!isCallbackNonce(nonce)) throw new TypeError('approval callback: bad nonce')
  const data = `apv:${decision === 'approved' ? 'a' : 'r'}:${approvalId.replace(/-/g, '')}:${nonce}`
  if (Buffer.byteLength(data, 'utf8') > CALLBACK_DATA_MAX_BYTES) throw new TypeError('approval callback: data too long')
  return data
}

/** The decoded button, or null for anything that is not exactly an apv callback. */
export function parseCallbackData(data: unknown): ParsedApprovalCallback | null {
  if (typeof data !== 'string') return null
  const m = APPROVAL_CALLBACK_RE.exec(data)
  if (!m) return null
  const [, code, id32, nonce] = m as unknown as [string, string, string, string]
  const approvalId = `${id32.slice(0, 8)}-${id32.slice(8, 12)}-${id32.slice(12, 16)}-${id32.slice(16, 20)}-${id32.slice(20)}`
  return { decision: code === 'a' ? 'approved' : 'rejected', approvalId, nonce }
}
