import { randomUUID } from 'node:crypto'
import {
  createApproval, setPermissionBotNonceHashes, setApprovalTelegramMessageId, resolveApprovalFromPermissionBot,
} from '../../db.js'
import { newCallbackNonce, nonceHash } from '../../web/approval-callback-data.js'
import { ragPayloadContentHash } from '../../web/rag-approval-payload.js'

// Shared fixtures of the permission-bot approval tests (card 9a77b3e5).
export const OWNER = '1000000001'
export const BOT = '7000000002' // the permission bot
export const MAIN_BOT = '7000000001' // the main bot
export const MSG = 4242
export const PKG = 'ab'.repeat(32)
export const RUN = '0123456789abcdef0123456789abcdef'

export function payloadText(kind: string, over: Partial<{ pkg: string; run: string; start: number; end: number }> = {}): string {
  return JSON.stringify({
    kind,
    package_sha256: over.pkg ?? PKG,
    run_id: over.run ?? RUN,
    write_window_start: over.start,
    write_window_end: over.end,
  })
}

export interface Fixture {
  id: string
  approveNonce: string
  rejectNonce: string
  payload: string
  hash: string
}

// A pending permission-bot approval whose buttons are bound and sent, the way
// the notifier leaves it.
export function pendingPermission(opts: {
  category?: string
  start: number
  end: number
  timeoutAt: number
  run?: string
  pkg?: string
}): Fixture {
  const category = opts.category ?? 'rag_production_d'
  const id = randomUUID()
  const payload = payloadText(category, { start: opts.start, end: opts.end, run: opts.run, pkg: opts.pkg })
  const hash = ragPayloadContentHash(payload)
  createApproval({
    id, agent_id: 'fejleszto', category, action_description: 'x',
    action_payload: payload, content_hash: hash, timeout_at: opts.timeoutAt,
  })
  const approveNonce = newCallbackNonce()
  const rejectNonce = newCallbackNonce()
  if (!setPermissionBotNonceHashes(id, { approved: nonceHash(approveNonce), rejected: nonceHash(rejectNonce) })) {
    throw new Error('fixture: nonce binding refused')
  }
  if (!setApprovalTelegramMessageId(id, MSG)) throw new Error('fixture: message id refused')
  return { id, approveNonce, rejectNonce, payload, hash }
}

export function press(f: Fixture, over: Partial<Parameters<typeof resolveApprovalFromPermissionBot>[0]> = {}) {
  return resolveApprovalFromPermissionBot({
    id: f.id, decision: 'approved', nonce: f.approveNonce, fromId: OWNER, chatId: OWNER,
    messageId: MSG, botId: BOT, ownerId: OWNER, expectedBotId: BOT, mainBotId: MAIN_BOT, ...over,
  })
}

// A pending row, pressed approved by the owner on the permission bot.
export function approvedPermission(opts: Parameters<typeof pendingPermission>[0], now?: number): Fixture {
  const f = pendingPermission(opts)
  const r = press(f, now === undefined ? {} : { nowS: now })
  if (!r.ok) throw new Error(`fixture: press refused ${r.reason}`)
  return f
}
