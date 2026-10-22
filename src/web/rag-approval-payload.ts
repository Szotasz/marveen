import { createHash } from 'node:crypto'

// Card 9a77b3e5: the bound payload of a RAG production run approval (category
// rag_production_d) and of its live-trial twin (permission_bot_probe). The
// payload is ONE canonical JSON text -- keys in a fixed order, no whitespace,
// integers only -- and the approval's content_hash is the sha256 of that exact
// text, so the owner's button press is bound to one package, one run and one
// write window. Nothing here touches the database; src/db.ts and the route
// import these checks.

// The categories decided by the SEPARATE permission bot (not the main bot's
// TELEGRAM_BUTTON_CATEGORIES, which stays as it is). The first is the real
// gate, the second is the trial that authorises nothing.
export const PERMISSION_BOT_CATEGORIES: readonly string[] = ['rag_production_d', 'permission_bot_probe']

// Any other category under this prefix is refused at request time: the prefix
// is reserved for the gate above, so a look-alike cannot be requested.
export const RAG_RESERVED_PREFIX = 'rag_production_'

export const RAG_MAX_WINDOW_SECONDS = 21600 // 6 hours

const SHA256_HEX = /^[0-9a-f]{64}$/
const RUN_ID = /^[0-9a-f]{32}$/
const KEY_ORDER = ['kind', 'package_sha256', 'run_id', 'write_window_start', 'write_window_end'] as const

export interface RagApprovalPayload {
  kind: string
  package_sha256: string
  run_id: string
  write_window_start: number
  write_window_end: number
}

export type RagPayloadResult =
  | { ok: true; payload: RagApprovalPayload; canonical: string }
  | { ok: false; field: string; error: string }

const fail = (field: string, error: string): RagPayloadResult => ({ ok: false, field, error })

export function isPermissionBotCategory(category: unknown): boolean {
  return typeof category === 'string' && PERMISSION_BOT_CATEGORIES.includes(category)
}

// True when the category sits under the reserved prefix but is not one the gate
// defines (rag_production_x, rag_production_, ...).
export function isReservedForeignCategory(category: unknown): boolean {
  return typeof category === 'string' && category.startsWith(RAG_RESERVED_PREFIX) && !PERMISSION_BOT_CATEGORIES.includes(category)
}

// The canonical text of a payload: fixed key order, no spaces.
export function canonicalRagPayload(p: RagApprovalPayload): string {
  return JSON.stringify({
    kind: p.kind,
    package_sha256: p.package_sha256,
    run_id: p.run_id,
    write_window_start: p.write_window_start,
    write_window_end: p.write_window_end,
  })
}

// content_hash = sha256 of the UTF-8 payload text.
export function ragPayloadContentHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0

// Parses and validates a payload text for `category`. Structure and window
// rules only; the "end is still in the future" rule is request-time only
// (validateRagApprovalRequest), because a consume legitimately sees a window
// that is already half over.
export function parseRagApprovalPayload(text: unknown, category: string): RagPayloadResult {
  if (!isPermissionBotCategory(category)) return fail('category', 'not a permission-bot category')
  if (typeof text !== 'string' || text === '') return fail('action_payload', 'payload must be a non-empty string')
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return fail('action_payload', 'payload is not valid JSON') }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return fail('action_payload', 'payload must be a JSON object')
  const obj = raw as Record<string, unknown>
  const keys = Object.keys(obj)
  if (keys.length !== KEY_ORDER.length || keys.some((k, i) => k !== KEY_ORDER[i])) {
    return fail('action_payload', `keys must be exactly, in this order: ${KEY_ORDER.join(', ')}`)
  }
  if (obj.kind !== category) return fail('kind', 'kind must equal the category')
  if (typeof obj.package_sha256 !== 'string' || !SHA256_HEX.test(obj.package_sha256)) {
    return fail('package_sha256', 'must be 64 lowercase hex characters')
  }
  if (typeof obj.run_id !== 'string' || !RUN_ID.test(obj.run_id)) return fail('run_id', 'must be 32 lowercase hex characters')
  if (!isInt(obj.write_window_start)) return fail('write_window_start', 'must be a positive integer (unix seconds)')
  if (!isInt(obj.write_window_end)) return fail('write_window_end', 'must be a positive integer (unix seconds)')
  if (obj.write_window_end <= obj.write_window_start) return fail('write_window_end', 'must be after write_window_start')
  if (obj.write_window_end - obj.write_window_start > RAG_MAX_WINDOW_SECONDS) {
    return fail('write_window_end', `window must not exceed ${RAG_MAX_WINDOW_SECONDS} seconds`)
  }
  const payload: RagApprovalPayload = {
    kind: obj.kind,
    package_sha256: obj.package_sha256,
    run_id: obj.run_id,
    write_window_start: obj.write_window_start,
    write_window_end: obj.write_window_end,
  }
  // The text must BE the canonical text: this rejects whitespace, escaped
  // characters, a float spelling of an integer and anything else that parses to
  // the same values but is not byte-identical to what the hash was taken over.
  const canonical = canonicalRagPayload(payload)
  if (text !== canonical) return fail('action_payload', 'payload is not in canonical form')
  return { ok: true, payload, canonical }
}

// The whole request-time check of POST /api/approvals for a permission-bot
// category: reserved prefix, canonical payload, matching content_hash, and a
// window that has not already ended.
export function validateRagApprovalRequest(params: {
  category: string
  actionPayload: unknown
  contentHash: unknown
  nowSec: number
}): RagPayloadResult {
  if (isReservedForeignCategory(params.category)) return fail('category', `${RAG_RESERVED_PREFIX} is a reserved prefix`)
  const parsed = parseRagApprovalPayload(params.actionPayload, params.category)
  if (!parsed.ok) return parsed
  if (typeof params.contentHash !== 'string' || !SHA256_HEX.test(params.contentHash)) {
    return fail('content_hash', 'must be 64 lowercase hex characters')
  }
  if (params.contentHash !== ragPayloadContentHash(parsed.canonical)) return fail('content_hash', 'does not match the payload')
  if (parsed.payload.write_window_end <= params.nowSec) return fail('write_window_end', 'window has already ended')
  return parsed
}
