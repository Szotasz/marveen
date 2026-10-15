import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createHash, randomBytes, randomUUID } from 'node:crypto'

// POST /api/approvals/:id/telegram -- the server-side gate behind
// the owner's approve/reject buttons, the only place the reserved
// `owner:telegram:` attribution is valid. Order: shape -> owner -> chat -> one
// conditional UPDATE (db.resolveApprovalFromTelegram). The legacy PATCH stays as
// it was, except that it now REFUSES the reserved attribution (a press
// sent there, by an older plugin or by anyone, is never a decision), and each
// button has its own nonce (the reject nonce cannot approve).

// The owner is resolved by the real resolveAlertOwnerChat; only its inputs are
// controlled here: the .env value (ALLOWED_CHAT_ID) and the access.json read.
const state = vi.hoisted(() => ({ allowedChatId: '1000000001', accessJson: null as string | null }))

vi.mock('../config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../config.js')>()
  return {
    ...real,
    MAIN_AGENT_ID: 'agent-a',
    TELEGRAM_BOT_TOKEN: '',
    get ALLOWED_CHAT_ID() { return state.allowedChatId },
  }
})

vi.mock('../owner-chat.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../owner-chat.js')>()
  return {
    ...real,
    // The live access.json must never decide a test: the read is replaced,
    // the rule (.env first, then exactly one DM entry) is the real one.
    resolveAlertOwnerChat: vi.fn((_read?: unknown, configured?: string | null) =>
      real.resolveAlertOwnerChat(() => {
        if (state.accessJson == null) throw new Error('ENOENT')
        return state.accessJson
      }, configured)),
  }
})

vi.mock('../db.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../db.js')>()
  return {
    ...real,
    getApproval: vi.fn(real.getApproval),
    resolveApprovalFromTelegram: vi.fn(real.resolveApprovalFromTelegram),
  }
})

import {
  initDatabase, getDb, createApproval, getApproval, resolveApproval,
  setApprovalCallbackNonceHashes, setApprovalTelegramMessageId, resolveApprovalFromTelegram,
  expireTimedOutApprovals, consumeApproval,
} from '../db.js'
import { logger } from '../logger.js'
import { tryHandleApprovals, claimsTelegramOwner, isAttributionText } from '../web/routes/approvals.js'
import { formatOutcomeText } from '../web/approval-telegram-text.js'
import type { RouteContext } from '../web/routes/types.js'

const OWNER = '1000000001'
const STRANGER = '777000111'
const MSG = 4242
const HASH = 'ab'.repeat(32)

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')
const newNonce = () => randomBytes(16).toString('base64url')
const storedHashes = (id: string) =>
  getDb().prepare('SELECT callback_nonce_hash_approve AS approved, callback_nonce_hash_reject AS rejected FROM approvals WHERE id = ?')
    .get(id) as { approved: string | null; rejected: string | null } | undefined
const UNBOUND = { approved: null, rejected: null }
const LEGACY_RESERVED = { error: 'resolved_by may not use the reserved owner:telegram: prefix' }

function fakeCall(method: string, path: string, rawBody: string): { ctx: RouteContext; out: { status: number; body: any; raw: string } } {
  const out: { status: number; body: any; raw: string } = { status: 0, body: null, raw: '' }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) { out.raw = chunk; out.body = JSON.parse(chunk) } },
  }
  const url = new URL(`http://localhost:3420${path}`)
  const req: any = {
    on(event: string, cb: (chunk?: Buffer) => void) {
      if (event === 'data') cb(Buffer.from(rawBody))
      if (event === 'end') cb()
    },
  }
  return { ctx: { req, res, path, method, url } as RouteContext, out }
}

function fakePatch(id: string, body: unknown) {
  return fakeCall('PATCH', `/api/approvals/${id}`, JSON.stringify(body))
}

// The button press as the plugin sends it: POST /api/approvals/:id/telegram.
async function decide(id: string, body: unknown, raw?: string) {
  const { ctx, out } = fakeCall('POST', `/api/approvals/${id}/telegram`, raw ?? JSON.stringify(body))
  expect(await tryHandleApprovals(ctx)).toBe(true)
  return out
}

async function post(body: unknown): Promise<{ status: number; body: any }> {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const path = '/api/approvals'
  const bodyStr = JSON.stringify(body)
  const req: any = {
    on(event: string, cb: (chunk?: Buffer) => void) {
      if (event === 'data') cb(Buffer.from(bodyStr))
      if (event === 'end') cb()
    },
  }
  expect(await tryHandleApprovals({ req, res, path, method: 'POST', url: new URL(`http://localhost:3420${path}`) } as RouteContext)).toBe(true)
  return out
}

async function patch(id: string, body: unknown) {
  const { ctx, out } = fakePatch(id, body)
  expect(await tryHandleApprovals(ctx)).toBe(true)
  return out
}

function pending(opts: { category?: string; timeoutAt?: number | null; agentId?: string } = {}) {
  const id = randomUUID()
  createApproval({
    id,
    agent_id: opts.agentId ?? 'marveen',
    category: opts.category ?? 'email_send',
    action_description: 'Levél: teszt',
    content_hash: HASH,
    timeout_at: opts.timeoutAt === undefined ? Math.floor(Date.now() / 1000) + 600 : opts.timeoutAt,
  })
  return id
}

// A pending email_send with its buttons bound to it, as the notifier leaves
// it: `nonce` is the approve button's, `rejectNonce` the reject button's.
function bound(opts: { timeoutAt?: number } = {}) {
  const id = pending({ timeoutAt: opts.timeoutAt })
  const nonce = newNonce()
  const rejectNonce = newNonce()
  expect(setApprovalCallbackNonceHashes(id, { approved: sha(nonce), rejected: sha(rejectNonce) })).toBe(true)
  expect(setApprovalTelegramMessageId(id, MSG)).toBe(true)
  return { id, nonce, rejectNonce, hashes: { approved: sha(nonce), rejected: sha(rejectNonce) } }
}

// The body the plugin sends for a press by `from` in the owner's DM.
function press(nonce: string, over: Record<string, unknown> = {}) {
  return {
    status: 'approved',
    resolved_by: `owner:telegram:${OWNER}`,
    telegram_message_id: MSG,
    telegram_chat_id: OWNER,
    telegram_chat_type: 'private',
    callback_nonce: nonce,
    callback_protocol: 1,
    ...over,
  }
}

beforeEach(() => {
  initDatabase(':memory:')
  state.allowedChatId = OWNER
  state.accessJson = null
  vi.mocked(resolveApprovalFromTelegram).mockClear()
  vi.mocked(getApproval).mockClear()
})

describe('owner button: success', () => {
  it('approve: 200, approved by owner:telegram:<id>, outcome_text, the nonce hash is spent', async () => {
    const { id, nonce } = bound()
    const out = await decide(id, press(nonce))
    expect(out.status).toBe(200)
    expect(out.body.ok).toBe(true)
    expect(out.body.approval.status).toBe('approved')
    expect(out.body.approval.resolved_by).toBe(`owner:telegram:${OWNER}`)
    expect(out.body.approval.telegram_message_id).toBe(MSG)
    expect(out.body.outcome_text).toBe(formatOutcomeText('approved', out.body.approval.resolved_at, 30))
    expect(out.body.outcome_text).toMatch(/^✅ Jóváhagyva: .* \(Budapest\)\. A levél 30 percen belül, egyszer küldhető el\.$/)
    expect(storedHashes(id)).toEqual(UNBOUND)
    expect(getApproval(id)?.status).toBe('approved')
  })

  it('reject with the reject button\'s nonce: 200, rejected, the reject outcome text, both hashes spent', async () => {
    const { id, rejectNonce } = bound()
    const out = await decide(id, press(rejectNonce, { status: 'rejected' }))
    expect(out.status).toBe(200)
    expect(out.body.approval.status).toBe('rejected')
    expect(out.body.approval.resolved_by).toBe(`owner:telegram:${OWNER}`)
    expect(out.body.outcome_text).toBe(formatOutcomeText('rejected', out.body.approval.resolved_at))
    expect(out.body.outcome_text).toMatch(/^❌ Elutasítva: /)
  })

  it('the owner resolved from the one DM entry of access.json is accepted (empty .env value)', async () => {
    state.allowedChatId = ''
    state.accessJson = JSON.stringify({ dmPolicy: 'allowlist', allowFrom: [OWNER] })
    const { id, nonce } = bound()
    const out = await decide(id, press(nonce))
    expect(out.status).toBe(200)
  })

  it('the outcome text follows EMAIL_APPROVAL_WINDOW_S', async () => {
    const prev = process.env.EMAIL_APPROVAL_WINDOW_S
    process.env.EMAIL_APPROVAL_WINDOW_S = '600'
    try {
      const { id, nonce } = bound()
      const out = await decide(id, press(nonce))
      expect(out.body.outcome_text).toContain('A levél 10 percen belül')
    } finally {
      if (prev === undefined) delete process.env.EMAIL_APPROVAL_WINDOW_S
      else process.env.EMAIL_APPROVAL_WINDOW_S = prev
    }
  })
})

describe('owner button: repeated and raced presses', () => {
  const budapest = (s: number) => new Date(s * 1000).toLocaleString('hu-HU', { timeZone: 'Europe/Budapest' })
  const setResolvedAt = (id: string, at: number) =>
    getDb().prepare('UPDATE approvals SET resolved_at = ? WHERE id = ?').run(at, id)

  it('the second press of the same button: 409 already_resolved, the window stated as a deadline, not "30 minutes"', async () => {
    const { id, nonce } = bound()
    const first = await decide(id, press(nonce))
    expect(first.status).toBe(200)
    const at = first.body.approval.resolved_at as number
    const second = await decide(id, press(nonce))
    expect(second.status).toBe(409)
    expect(second.body).toEqual({
      ok: false,
      reason: 'already_resolved',
      status: 'approved',
      outcome_text: `✅ Jóváhagyva: ${budapest(at)} (Budapest). A levél ${budapest(at + 1800)}-ig, egyszer küldhető el.`,
    })
    expect(second.body.outcome_text).not.toContain('30 percen belül')
    expect(second.body.outcome_text).not.toContain('nem gombbal')
  })

  it('a press long after a button approval: the send window is reported closed', async () => {
    const { id, nonce } = bound()
    await decide(id, press(nonce))
    const at = Math.floor(Date.now() / 1000) - 3600
    setResolvedAt(id, at)
    const out = await decide(id, press(nonce))
    expect(out.status).toBe(409)
    expect(out.body.outcome_text).toBe(`✅ Jóváhagyva: ${budapest(at)} (Budapest). A küldési ablak lejárt (${budapest(at + 1800)}).`)
  })

  it('a press after the approval was used by a send: says it was used', async () => {
    const { id, nonce } = bound()
    await decide(id, press(nonce))
    expect(consumeApproval({ id, contentHash: HASH, consumer: 'test', windowSeconds: 1800 }).ok).toBe(true)
    const out = await decide(id, press(nonce))
    expect(out.body.outcome_text).toMatch(/^✅ Jóváhagyva: .* \(Budapest\)\. A jóváhagyást egy küldés már felhasználta\.$/)
  })

  it('reject after approve does not flip the decision', async () => {
    const { id, nonce, rejectNonce } = bound()
    await decide(id, press(nonce))
    const out = await decide(id, press(rejectNonce, { status: 'rejected' }))
    expect(out.status).toBe(409)
    expect(out.body.reason).toBe('already_resolved')
    expect(out.body.status).toBe('approved')
    expect(getApproval(id)?.status).toBe('approved')
  })

  it('rejected on the dashboard first (legacy PATCH): the press says it was not decided by the button', async () => {
    const { id, nonce } = bound()
    const legacy = await patch(id, { status: 'rejected', resolved_by: 'dashboard' })
    expect(legacy.status).toBe(200)
    const out = await decide(id, press(nonce))
    expect(out.status).toBe(409)
    expect(out.body.reason).toBe('already_resolved')
    expect(out.body.status).toBe('rejected')
    expect(out.body.outcome_text).toBe(`Már eldöntve, nem gombbal: ❌ Elutasítva: ${budapest(legacy.body.resolved_at)} (Budapest).`)
    expect(getApproval(id)?.resolved_by).toBe('dashboard')
  })

  it.each([['dashboard'], ['telegram_text'], ['Tulajdonos (Telegram 1537, Marveen rögzítette)']])(
    'approved by %j, then pressed: "Már eldöntve, nem gombbal" plus the real window', async (resolvedBy) => {
      const { id, rejectNonce } = bound()
      const legacy = await patch(id, { status: 'approved', resolved_by: resolvedBy })
      expect(legacy.status).toBe(200)
      const at = legacy.body.resolved_at as number
      const out = await decide(id, press(rejectNonce, { status: 'rejected' }))
      expect(out.status).toBe(409)
      expect(out.body.outcome_text).toBe(
        `Már eldöntve, nem gombbal: ✅ Jóváhagyva: ${budapest(at)} (Budapest). A levél ${budapest(at + 1800)}-ig, egyszer küldhető el.`)
      expect(out.body.outcome_text.length).toBeLessThanOrEqual(300) // the plugin's outcome cap
    })
})

describe('owner button: refusals that carry no approval state', () => {
  it('a stranger user id: 403 not_owner, the approval stays pending', async () => {
    const { id, nonce } = bound()
    const out = await decide(id, press(nonce, { resolved_by: `owner:telegram:${STRANGER}`, telegram_chat_id: STRANGER }))
    expect(out.status).toBe(403)
    expect(out.body).toEqual({ ok: false, reason: 'not_owner' })
    expect(getApproval(id)?.status).toBe('pending')
    expect(storedHashes(id)?.approved).toBe(sha(nonce))
  })

  it('not_owner is identical for a pending, a decided and a nonexistent id, and reads no approval', async () => {
    const live = bound()
    const decided = bound()
    await decide(decided.id, press(decided.nonce))
    vi.mocked(getApproval).mockClear()
    vi.mocked(resolveApprovalFromTelegram).mockClear()
    const stranger = { resolved_by: `owner:telegram:${STRANGER}`, telegram_chat_id: STRANGER }
    const outs = [
      await decide(live.id, press(live.nonce, stranger)),
      await decide(decided.id, press(decided.nonce, stranger)),
      await decide(randomUUID(), press(newNonce(), stranger)),
    ]
    for (const o of outs) {
      expect(o.status).toBe(403)
      expect(o.raw).toBe(JSON.stringify({ ok: false, reason: 'not_owner' }))
    }
    expect(getApproval).not.toHaveBeenCalled()
    expect(resolveApprovalFromTelegram).not.toHaveBeenCalled()
  })

  it.each([
    ['the installer placeholder 0, no access.json', '0', null],
    ['empty .env, no access.json', '', null],
    ['a negative (group) id in .env', '-1001000000001', null],
    ['empty .env, two DM entries', '', JSON.stringify({ allowFrom: [OWNER, STRANGER] })],
    ['empty .env, only a group entry', '', JSON.stringify({ allowFrom: ['-100123'] })],
  ])('an unresolvable owner (%s): 403 not_owner, nothing read', async (_label, allowed, access) => {
    state.allowedChatId = allowed
    state.accessJson = access
    const { id, nonce } = bound()
    vi.mocked(getApproval).mockClear()
    const outs = [await decide(id, press(nonce)), await decide(randomUUID(), press(newNonce()))]
    for (const o of outs) {
      expect(o.status).toBe(403)
      expect(o.raw).toBe(JSON.stringify({ ok: false, reason: 'not_owner' }))
    }
    expect(getApproval).not.toHaveBeenCalled()
    expect(resolveApprovalFromTelegram).not.toHaveBeenCalled()
    expect(getDb().prepare('SELECT status FROM approvals WHERE id = ?').get(id)).toEqual({ status: 'pending' })
  })

  it.each([
    ['chat id differs from the presser', { telegram_chat_id: STRANGER }],
    ['a group chat id', { telegram_chat_id: '-1001000000001' }],
    ['chat type group', { telegram_chat_type: 'group' }],
    ['chat type supergroup', { telegram_chat_type: 'supergroup' }],
    ['chat type channel', { telegram_chat_type: 'channel' }],
  ])('%s: 403 chat_mismatch, identical for any id, nothing read', async (_label, over) => {
    const live = bound()
    const decided = bound()
    await decide(decided.id, press(decided.nonce))
    vi.mocked(getApproval).mockClear()
    vi.mocked(resolveApprovalFromTelegram).mockClear()
    const outs = [
      await decide(live.id, press(live.nonce, over)),
      await decide(decided.id, press(decided.nonce, over)),
      await decide(randomUUID(), press(newNonce(), over)),
    ]
    for (const o of outs) {
      expect(o.status).toBe(403)
      expect(o.raw).toBe(JSON.stringify({ ok: false, reason: 'chat_mismatch' }))
    }
    expect(getApproval).not.toHaveBeenCalled()
    expect(resolveApprovalFromTelegram).not.toHaveBeenCalled()
    expect(getApproval(live.id)?.status).toBe('pending')
  })
})

describe('owner button: malformed requests are 400 bad_request, before any lookup', () => {
  const nonce = 'A'.repeat(22)
  it.each([
    ['status timeout', { status: 'timeout' }],
    ['status pending', { status: 'pending' }],
    ['status missing', { status: undefined }],
    ['message id as a string', { telegram_message_id: String(MSG) }],
    ['message id 0', { telegram_message_id: 0 }],
    ['message id negative', { telegram_message_id: -1 }],
    ['message id fractional', { telegram_message_id: 1.5 }],
    ['message id unsafe', { telegram_message_id: 2 ** 53 }],
    ['message id missing', { telegram_message_id: undefined }],
    ['nonce of 21 chars', { callback_nonce: 'A'.repeat(21) }],
    ['nonce of 23 chars', { callback_nonce: 'A'.repeat(23) }],
    ['nonce with padding', { callback_nonce: `${'A'.repeat(21)}=` }],
    ['nonce with a space', { callback_nonce: `${'A'.repeat(21)} ` }],
    ['nonce as a number', { callback_nonce: 12345 }],
    ['nonce missing', { callback_nonce: undefined }],
    ['protocol 2', { callback_protocol: 2 }],
    ['protocol "1"', { callback_protocol: '1' }],
    ['protocol missing', { callback_protocol: undefined }],
    ['chat id as a number', { telegram_chat_id: Number(OWNER) }],
    ['chat id with a leading zero', { telegram_chat_id: `0${OWNER}` }],
    ['chat id missing', { telegram_chat_id: undefined }],
    ['chat type missing', { telegram_chat_type: undefined }],
    ['chat type not a word', { telegram_chat_type: 'Private ' }],
    ['owner id empty', { resolved_by: 'owner:telegram:' }],
    ['owner id 0', { resolved_by: 'owner:telegram:0' }],
    ['owner id negative', { resolved_by: 'owner:telegram:-5' }],
    ['owner id leading zero', { resolved_by: `owner:telegram:0${OWNER}` }],
    ['owner id with letters', { resolved_by: `owner:telegram:${OWNER}x` }],
    ['owner id with a trailing space', { resolved_by: `owner:telegram:${OWNER} ` }],
    ['owner prefix with a leading space', { resolved_by: ` owner:telegram:${OWNER}` }],
    ['owner prefix upper case', { resolved_by: `OWNER:TELEGRAM:${OWNER}` }],
  ])('%s', async (_label, over) => {
    const live = bound()
    vi.mocked(getApproval).mockClear()
    const out = await decide(live.id, press(nonce, over))
    expect(out.status).toBe(400)
    expect(out.raw).toBe(JSON.stringify({ ok: false, reason: 'bad_request' }))
    expect(getApproval).not.toHaveBeenCalled()
    expect(resolveApprovalFromTelegram).not.toHaveBeenCalled()
    expect(getApproval(live.id)?.status).toBe('pending')
  })

  it('an approval id that is not a UUID: 400', async () => {
    const out = await decide('not-a-uuid', press(nonce))
    expect(out.status).toBe(400)
    expect(out.body).toEqual({ ok: false, reason: 'bad_request' })
    const upper = await decide(randomUUID().toUpperCase(), press(nonce))
    expect(upper.status).toBe(400)
  })
})

describe('the legacy PATCH refuses the reserved owner:telegram: attribution', () => {
  it('owner:telegram:<owner> with no Telegram fields (forged attribution): 400, still pending, resolved_by unset', async () => {
    const { id } = bound()
    const out = await patch(id, { status: 'approved', resolved_by: `owner:telegram:${OWNER}` })
    expect(out.status).toBe(400)
    expect(out.body).toEqual(LEGACY_RESERVED)
    const row = getApproval(id)
    expect(row?.status).toBe('pending')
    expect(row?.resolved_by).toBeNull()
  })

  it('the forged attribution with only the legacy telegram_message_id: 400, the stored message id unchanged', async () => {
    const { id } = bound()
    const out = await patch(id, { status: 'approved', resolved_by: `owner:telegram:${OWNER}`, telegram_message_id: 9999 })
    expect(out.status).toBe(400)
    expect(out.body).toEqual(LEGACY_RESERVED)
    expect(getApproval(id)?.telegram_message_id).toBe(MSG)
    expect(getApproval(id)?.status).toBe('pending')
  })

  // What an older plugin (or anyone with the dashboard token) would send: the
  // complete, valid button press, to the PATCH. It is never a decision there,
  // and it burns nothing: the same press on the Telegram endpoint still works.
  it('a COMPLETE valid press sent to the PATCH: 400, nothing read, still pending, both nonces intact; the endpoint then decides it', async () => {
    const { id, nonce, hashes } = bound()
    vi.mocked(getApproval).mockClear()
    vi.mocked(resolveApprovalFromTelegram).mockClear()
    for (const status of ['approved', 'rejected']) {
      const out = await patch(id, press(nonce, { status }))
      expect(out.status).toBe(400)
      expect(out.body).toEqual(LEGACY_RESERVED)
    }
    expect(getApproval).not.toHaveBeenCalled()
    expect(resolveApprovalFromTelegram).not.toHaveBeenCalled()
    expect(getApproval(id)).toMatchObject({ status: 'pending', resolved_by: null, resolved_at: null, telegram_message_id: MSG })
    expect(storedHashes(id)).toEqual(hashes)
    const ok = await decide(id, press(nonce))
    expect(ok.status).toBe(200)
    expect(ok.body.approval.resolved_by).toBe(`owner:telegram:${OWNER}`)
  })

  // Inside the allowlist: recognised as the claim in any case and with any
  // whitespace, and refused on the PATCH.
  it.each([
    ['exact', `owner:telegram:${OWNER}`],
    ['a leading space', ` owner:telegram:${OWNER}`],
    ['a leading tab and newline', `\t\nowner:telegram:${OWNER}`],
    ['a space inside', `owner: telegram:${OWNER}`],
    ['upper case', `OWNER:TELEGRAM:${OWNER}`],
    ['mixed case', `Owner:Telegram:${OWNER}`],
    ['a leading BOM (trimmed like whitespace)', `\uFEFFowner:telegram:${OWNER}`],
    ['a stranger id', `owner:telegram:${STRANGER}`],
    ['just the prefix', 'owner:telegram:'],
  ])('a claim (%s) on the PATCH: 400 in the legacy shape, not stored', async (_label, resolvedBy) => {
    const id = pending()
    const out = await patch(id, { status: 'approved', resolved_by: resolvedBy })
    expect(out.status).toBe(400)
    expect(out.body).toEqual(LEGACY_RESERVED)
    expect(getApproval(id)?.status).toBe('pending')
    expect(getApproval(id)?.resolved_by).toBeNull()
  })

  it('the refusal is logged with the reason, never with the body', async () => {
    const lines: unknown[][] = []
    const spy = vi.spyOn(logger, 'warn').mockImplementation(((...args: unknown[]) => { lines.push(args) }) as never)
    try {
      const { id, nonce } = bound()
      await patch(id, press(nonce))
      expect(lines).toHaveLength(1)
      expect(lines[0]?.[0]).toEqual({ id, reason: 'reserved_attribution' })
      expect(JSON.stringify(lines)).not.toContain(nonce)
    } finally {
      spy.mockRestore()
    }
  })

  // Look-alike vectors: look-alikes outside the allowlist. Folding never caught all
  // of these; the allowlist refuses them on the legacy branch, in its shape.
  it.each([
    ['full-width colon', `owner\uFF1Atelegram:${OWNER}`],
    ['zero-width space', `own\u200Ber:telegram:${OWNER}`],
    ['Cyrillic o', `\u043Ewner:telegram:${OWNER}`],
    ['Cyrillic e', `owner:t\u0435legram:${OWNER}`],
    ['Greek omicron', `\u03BFwner:telegram:${OWNER}`],
    ['combining grapheme joiner prefix', `\u034Fowner:telegram:${OWNER}`],
    ['variation selector inside', `o\uFE0Fwner:telegram:${OWNER}`],
    ['ratio colon', `owner\u2236telegram\u2236${OWNER}`],
    ['modifier letter colon', `owner\uA789telegram\uA789${OWNER}`],
    ['Hangul filler prefix', `\u3164owner:telegram:${OWNER}`],
    ['full-width letters', `\uFF4F\uFF57\uFF4E\uFF45\uFF52:telegram:${OWNER}`],
  ])('a look-alike (%s) is refused by the legacy allowlist: 400, not stored', async (_label, resolvedBy) => {
    const id = pending()
    const out = await patch(id, { status: 'approved', resolved_by: resolvedBy })
    expect(out.status).toBe(400)
    expect(out.body).toEqual({ error: 'resolved_by may only contain printable ASCII and Hungarian letters' })
    expect(getApproval(id)?.status).toBe('pending')
    expect(getApproval(id)?.resolved_by).toBeNull()
  })

  it('claimsTelegramOwner: case and whitespace do not matter; other characters are the allowlist\'s job', () => {
    for (const v of [`owner:telegram:${OWNER}`, ' owner:telegram:1', 'OWNER:TELEGRAM:', 'owner : telegram : 1', '\towner:telegram:']) {
      expect(claimsTelegramOwner(v)).toBe(true)
    }
    for (const v of ['telegram_text', 'dashboard', 'owner', 'owner:telegram', 'owner:dashboard:1', 'telegram:owner:1', 'marveen', '', null, undefined, 42, {}]) {
      expect(claimsTelegramOwner(v)).toBe(false)
    }
  })
})

describe('the attribution allowlist (legacy resolved_by, POST agent_id)', () => {
  it('accepts exactly printable ASCII and the 18 Hungarian accented letters, one code point at a time', () => {
    const accepted: number[] = []
    for (let cp = 0; cp <= 0x10FFFF; cp++) {
      if (cp >= 0xD800 && cp <= 0xDFFF) continue
      if (isAttributionText(String.fromCodePoint(cp))) accepted.push(cp)
    }
    const expected: number[] = []
    for (let cp = 0x20; cp <= 0x7E; cp++) expected.push(cp)
    for (const ch of 'áéíóöőúüűÁÉÍÓÖŐÚÜŰ'.normalize('NFC')) expected.push(ch.codePointAt(0) as number)
    expect(accepted).toEqual(expected.sort((a, b) => a - b))
  })

  it('refuses a decomposed (NFD) accent and a lone surrogate', () => {
    expect(isAttributionText('rögzítette'.normalize('NFD'))).toBe(false)
    expect(isAttributionText('a\uD800b')).toBe(false)
  })

  it.each([
    ['dashboard'],
    ['telegram_text'],
    ['Tulajdonos (Telegram 1537, Marveen rögzítette)'],
    ['ÁRVÍZTŰRŐ TÜKÖRFÚRÓGÉP árvíztűrő tükörfúrógép'],
    ['\tdashboard\n'],
  ])('the legitimate writer %j still resolves through the legacy PATCH', async (resolvedBy) => {
    const id = pending()
    const out = await patch(id, { status: 'approved', resolved_by: resolvedBy })
    expect(out.status).toBe(200)
    expect(out.body.resolved_by).toBe(resolvedBy.trim())
  })

  it.each([
    ['an emoji', 'Tulajdonos \u{1F44D}'],
    ['a tab inside', 'Tulajdonos\t(Telegram)'],
    ['a newline inside', 'dash\nboard'],
    ['a decomposed accent', 'Marveen rögzítette'.normalize('NFD')],
    ['a German sharp s', 'Gro\u00DF'],
    ['a right-to-left override', 'dash\u202Eboard'],
  ])('legacy resolved_by with %s: 400 in the legacy shape, not stored', async (_label, resolvedBy) => {
    const id = pending()
    const out = await patch(id, { status: 'approved', resolved_by: resolvedBy })
    expect(out.status).toBe(400)
    expect(out.body).toEqual({ error: 'resolved_by may only contain printable ASCII and Hungarian letters' })
    expect(getApproval(id)?.status).toBe('pending')
  })

  it.each([
    [`owner:telegram:${OWNER}`, 'agent_id may not use the reserved owner:telegram: prefix'],
    [` OWNER:Telegram:${OWNER}`, 'agent_id may not use the reserved owner:telegram: prefix'],
    ['owner:telegram:', 'agent_id may not use the reserved owner:telegram: prefix'],
    [`\u043Ewner:telegram:${OWNER}`, 'agent_id may only contain printable ASCII and Hungarian letters'],
    ['marveen\u200B', 'agent_id may only contain printable ASCII and Hungarian letters'],
  ])('POST with agent_id %j: 400 (%s), nothing created', async (agentId, error) => {
    const out = await post({ agent_id: agentId, category: 'email_send', action_description: 'x', content_hash: HASH })
    expect(out.status).toBe(400)
    expect(out.body).toEqual({ error })
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM approvals').get()).toEqual({ n: 0 })
  })

  it.each([['marveen'], ['agent-b'], ['agent-c'], ['seeme_sms'], ['Tulajdonos kézi kérése']])('POST with agent_id %j: 201', async (agentId) => {
    const out = await post({ agent_id: agentId, category: 'skill_patch', action_description: 'x' })
    expect(out.status).toBe(201)
    expect(out.body.agent_id).toBe(agentId)
  })
})

describe('owner button: refusals from the conditional UPDATE', () => {
  it('a wrong message id: 403 message_mismatch; the real press still decides afterwards', async () => {
    const { id, nonce } = bound()
    const out = await decide(id, press(nonce, { telegram_message_id: MSG + 1 }))
    expect(out.status).toBe(403)
    expect(out.body).toEqual({ ok: false, reason: 'message_mismatch' })
    expect(getApproval(id)?.status).toBe('pending')
    expect(storedHashes(id)?.approved).toBe(sha(nonce))
    expect((await decide(id, press(nonce))).status).toBe(200)
  })

  it('a wrong nonce (forged callback): 403 bad_nonce, still pending, the real press still decides', async () => {
    const { id, rejectNonce, hashes } = bound()
    const out = await decide(id, press(newNonce()))
    expect(out.status).toBe(403)
    expect(out.body).toEqual({ ok: false, reason: 'bad_nonce' })
    expect(getApproval(id)?.status).toBe('pending')
    expect(storedHashes(id)).toEqual(hashes)
    expect((await decide(id, press(rejectNonce, { status: 'rejected' }))).status).toBe(200)
  })

  // One nonce per button. Whoever holds the data of one button (a leak of
  // the reject button, say) cannot take the other decision with it.
  it('the REJECT button\'s nonce with status approved: 403 bad_nonce, the row stays pending, nothing spent', async () => {
    const { id, nonce, rejectNonce, hashes } = bound()
    const out = await decide(id, press(rejectNonce, { status: 'approved' }))
    expect(out.status).toBe(403)
    expect(out.body).toEqual({ ok: false, reason: 'bad_nonce' })
    expect(getApproval(id)).toMatchObject({ status: 'pending', resolved_by: null, resolved_at: null })
    expect(storedHashes(id)).toEqual(hashes)
    // the approve button itself still works
    expect((await decide(id, press(nonce))).status).toBe(200)
  })

  it('the APPROVE button\'s nonce with status rejected: 403 bad_nonce, the row stays pending', async () => {
    const { id, nonce, rejectNonce, hashes } = bound()
    const out = await decide(id, press(nonce, { status: 'rejected' }))
    expect(out.status).toBe(403)
    expect(out.body).toEqual({ ok: false, reason: 'bad_nonce' })
    expect(getApproval(id)?.status).toBe('pending')
    expect(storedHashes(id)).toEqual(hashes)
    expect((await decide(id, press(rejectNonce, { status: 'rejected' }))).status).toBe(200)
  })

  it('past the deadline, before the sweeper ran: 409 expired, no outcome_text, row untouched', async () => {
    const { id, nonce } = bound({ timeoutAt: Math.floor(Date.now() / 1000) - 1 })
    const out = await decide(id, press(nonce))
    expect(out.status).toBe(409)
    expect(out.body).toEqual({ ok: false, reason: 'expired' })
    expect(getApproval(id)?.status).toBe('pending')
  })

  it('after the sweeper set timeout: 409 expired', async () => {
    const { id, nonce } = bound({ timeoutAt: Math.floor(Date.now() / 1000) - 1 })
    expect(expireTimedOutApprovals()).toBe(1)
    const out = await decide(id, press(nonce))
    expect(out.status).toBe(409)
    expect(out.body).toEqual({ ok: false, reason: 'expired' })
  })

  it('no button bound (no message id, no nonce hash): 409 not_bound', async () => {
    const id = pending()
    const out = await decide(id, press(newNonce()))
    expect(out.status).toBe(409)
    expect(out.body).toEqual({ ok: false, reason: 'not_bound' })
    expect(getApproval(id)?.status).toBe('pending')
  })

  it('a message id but no nonce hash (the notifier stamped without binding): 409 not_bound', async () => {
    const id = pending()
    expect(setApprovalTelegramMessageId(id, MSG)).toBe(true)
    const out = await decide(id, press(newNonce()))
    expect(out.status).toBe(409)
    expect(out.body.reason).toBe('not_bound')
  })

  it('not an email_send approval: 409 wrong_category', async () => {
    const id = pending({ category: 'skill_patch' })
    setApprovalTelegramMessageId(id, MSG)
    const out = await decide(id, press(newNonce()))
    expect(out.status).toBe(409)
    expect(out.body).toEqual({ ok: false, reason: 'wrong_category' })
    expect(getApproval(id)?.status).toBe('pending')
  })

  it('an unknown approval id: 404 not_found', async () => {
    const out = await decide(randomUUID(), press(newNonce()))
    expect(out.status).toBe(404)
    expect(out.body).toEqual({ ok: false, reason: 'not_found' })
  })

  it.each([
    ['bad_request', 400],
    ['not_found', 404],
    ['wrong_category', 409],
    ['already_resolved', 409],
    ['expired', 409],
    ['not_bound', 409],
    ['message_mismatch', 403],
    ['bad_nonce', 403],
  ] as const)('the DB refusal %s maps to HTTP %i', async (reason, httpStatus) => {
    const { id, nonce } = bound()
    vi.mocked(resolveApprovalFromTelegram).mockReturnValueOnce({ ok: false, reason })
    const out = await decide(id, press(nonce))
    expect(out.status).toBe(httpStatus)
    expect(out.body).toEqual({ ok: false, reason })
  })
})

describe('Look-alike vectors on the strict branch and after a button decision', () => {
  it.each([
    ['message id 1e21', { telegram_message_id: 1e21 }],
    ['message id 4242.5', { telegram_message_id: 4242.5 }],
    ['message id "4242"', { telegram_message_id: '4242' }],
    ['protocol "1"', { callback_protocol: '1' }],
    ['protocol true', { callback_protocol: true }],
    ['chat id with a leading space', { telegram_chat_id: ` ${OWNER}` }],
    ['nonce with a trailing newline', { callback_nonce: 'NONCE\n' }],
    ['status timeout', { status: 'timeout' }],
    ['owner id with a leading zero, chat to match', { resolved_by: `owner:telegram:0${OWNER}`, telegram_chat_id: `0${OWNER}` }],
  ])('%s: 400 bad_request, still pending', async (_label, over) => {
    const { id, nonce } = bound()
    const body = press(nonce, over)
    if (body.callback_nonce === 'NONCE\n') body.callback_nonce = `${nonce}\n`
    const out = await decide(id, body)
    expect(out.status).toBe(400)
    expect(out.body).toEqual({ ok: false, reason: 'bad_request' })
    expect(getApproval(id)?.status).toBe('pending')
  })

  it('a "__proto__" key in the body changes nothing: the real press decides (200)', async () => {
    const { id, nonce } = bound()
    const raw = JSON.stringify(press(nonce)).replace('{', '{"__proto__":{"callback_protocol":2},')
    const out = await decide(id, null, raw)
    expect(out.status).toBe(200)
    expect(out.body.approval.status).toBe('approved')
  })

  it('a button approval is consumed once, bound to the content hash, inside the window', async () => {
    const { id, nonce } = bound()
    const ok = await decide(id, press(nonce))
    expect(ok.status).toBe(200)
    const at = ok.body.approval.resolved_at as number
    expect((await decide(id, press(nonce, { status: 'rejected' }))).status).toBe(409)
    expect((await patch(id, { status: 'rejected', resolved_by: 'dashboard' })).status).toBe(409)
    const consume = (hash: string, nowS: number) => consumeApproval({ id, contentHash: hash, consumer: 't', windowSeconds: 1800, nowS })
    expect(consume('00'.repeat(32), at + 60).reason).toBe('hash_mismatch')
    expect(consume(HASH, at + 31 * 60).reason).toBe('expired')
    expect(consume(HASH, at + 60).ok).toBe(true)
    expect(consume(HASH, at + 61).reason).toBe('already_consumed')
  })

  it('a button rejection cannot be consumed', async () => {
    const { id, rejectNonce } = bound()
    expect((await decide(id, press(rejectNonce, { status: 'rejected' }))).status).toBe(200)
    expect(consumeApproval({ id, contentHash: HASH, consumer: 't', windowSeconds: 1800 }).reason).toBe('not_approved')
  })
})

describe('owner button: the nonce never leaves the request', () => {
  let calls: unknown[][] = []
  let spies: { mockRestore(): void }[] = []
  beforeEach(() => {
    calls = []
    spies = (['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const).map(level =>
      vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => { calls.push(args) }) as never))
  })
  afterEach(() => {
    for (const s of spies) s.mockRestore()
  })

  it('no response and no log line carries the nonce or its hash, on any path', async () => {
    const { id, nonce } = bound()
    const wrong = newNonce()
    const secrets = [nonce, sha(nonce), wrong, sha(wrong)]
    const outs = [
      await decide(id, press(wrong)), // bad_nonce
      await decide(id, press(nonce, { telegram_message_id: MSG + 1 })), // message_mismatch
      await decide(id, press(nonce, { callback_protocol: 2 })), // bad_request
      await decide(id, press(nonce, { resolved_by: `owner:telegram:${STRANGER}`, telegram_chat_id: STRANGER })), // not_owner
      await decide(id, press(nonce, { telegram_chat_type: 'group' })), // chat_mismatch
      await decide(id, press(nonce)), // 200
      await decide(id, press(nonce)), // already_resolved
      await decide(randomUUID(), press(nonce)), // not_found
    ]
    expect(outs.map(o => o.status)).toEqual([403, 403, 400, 403, 403, 200, 409, 404])
    const logged = calls.map(args => JSON.stringify(args)).join('\n')
    expect(calls.length).toBeGreaterThanOrEqual(outs.length)
    for (const s of secrets) {
      for (const o of outs) expect(o.raw).not.toContain(s)
      expect(logged).not.toContain(s)
    }
    for (const o of outs) expect(o.raw).not.toContain('callback_nonce')
    // The success response hands out the public approval only.
    expect(Object.keys(outs[5].body.approval)).not.toContain('callback_nonce_hash')
  })

  it('a refusal log line names the reason and the bad FIELD, not its value', async () => {
    const { id } = bound()
    const badNonce = `${'Q'.repeat(21)}=`
    await decide(id, press(badNonce))
    const line = calls.find(args => JSON.stringify(args).includes('bad_request'))
    expect(line).toBeDefined()
    expect(line?.[0]).toEqual({ id, reason: 'bad_request', field: 'callback_nonce' })
    expect(JSON.stringify(calls)).not.toContain(badNonce)
  })
})

describe('the Telegram decision endpoint: POST /api/approvals/:id/telegram only', () => {
  it('an unreadable body: 400 bad_request in the strict shape, nothing read', async () => {
    const { id } = bound()
    vi.mocked(getApproval).mockClear()
    for (const raw of ['{not json', '', 'null', '[]', '"x"', '42', 'true']) {
      const out = await decide(id, null, raw)
      expect(out.status).toBe(400)
      expect(out.raw).toBe(JSON.stringify({ ok: false, reason: 'bad_request' }))
    }
    expect(getApproval).not.toHaveBeenCalled()
    expect(resolveApprovalFromTelegram).not.toHaveBeenCalled()
    expect(getApproval(id)?.status).toBe('pending')
  })

  it.each([['GET'], ['PATCH'], ['PUT'], ['DELETE']])('%s on the endpoint path is not handled here (the server answers 404)', async (method) => {
    const { id, nonce } = bound()
    const { ctx } = fakeCall(method, `/api/approvals/${id}/telegram`, JSON.stringify(press(nonce)))
    expect(await tryHandleApprovals(ctx)).toBe(false)
    expect(getApproval(id)?.status).toBe('pending')
  })

  it('a deeper or a different suffix is not the endpoint', async () => {
    const { id, nonce } = bound()
    for (const path of [`/api/approvals/${id}/telegram/x`, `/api/approvals/${id}/telegramx`, `/api/approvals/${id}/Telegram`]) {
      const { ctx } = fakeCall('POST', path, JSON.stringify(press(nonce)))
      expect(await tryHandleApprovals(ctx)).toBe(false)
    }
    expect(getApproval(id)?.status).toBe('pending')
  })
})

describe('legacy PATCH branch is unchanged', () => {
  it('resolved_by telegram_text: 200 with the bare approval row (no ok/outcome_text wrapper)', async () => {
    const id = pending({ agentId: 'agent-b' })
    const out = await patch(id, { status: 'approved', resolved_by: 'telegram_text' })
    expect(out.status).toBe(200)
    expect(out.body.status).toBe('approved')
    expect(out.body.resolved_by).toBe('telegram_text')
    expect(out.body.id).toBe(id)
    expect(out.body).not.toHaveProperty('ok')
    expect(out.body).not.toHaveProperty('outcome_text')
    expect(resolveApprovalFromTelegram).not.toHaveBeenCalled()
  })

  it('resolved_by dashboard: 200; the legacy telegram_message_id still overwrites (COALESCE)', async () => {
    const id = pending()
    setApprovalTelegramMessageId(id, MSG)
    const out = await patch(id, { status: 'rejected', resolved_by: 'dashboard', telegram_message_id: 9999 })
    expect(out.status).toBe(200)
    expect(out.body.status).toBe('rejected')
    expect(out.body.telegram_message_id).toBe(9999)
  })

  it('legacy timeout status is still accepted, and resolved_by is trimmed as before', async () => {
    const id = pending()
    const out = await patch(id, { status: 'timeout', resolved_by: '  dashboard  ' })
    expect(out.status).toBe(200)
    expect(out.body.status).toBe('timeout')
    expect(out.body.resolved_by).toBe('dashboard')
  })

  it('the self-approval guard: 403 with the same error text', async () => {
    const id = pending({ agentId: 'agent-b' })
    const out = await patch(id, { status: 'approved', resolved_by: 'agent-b' })
    expect(out.status).toBe(403)
    expect(out.body).toEqual({ error: 'The requesting agent cannot approve its own request' })
    expect(getApproval(id)?.status).toBe('pending')
  })

  it('legacy errors keep their shapes: 400 status, 400 resolved_by, 404, 409, invalid JSON', async () => {
    const id = pending()
    expect(await patch(id, { status: 'maybe', resolved_by: 'dashboard' })).toMatchObject({
      status: 400, body: { error: 'status must be approved, rejected, or timeout' },
    })
    expect(await patch(id, { status: 'approved', resolved_by: '   ' })).toMatchObject({
      status: 400, body: { error: 'resolved_by is required' },
    })
    expect(await patch(randomUUID(), { status: 'approved', resolved_by: 'dashboard' })).toMatchObject({
      status: 404, body: { error: 'Not found' },
    })
    resolveApproval(id, 'approved', 'dashboard')
    expect(await patch(id, { status: 'rejected', resolved_by: 'dashboard' })).toMatchObject({
      status: 409, body: { error: 'Already resolved as approved' },
    })
    const { ctx, out } = fakePatch(id, null)
    ;(ctx.req as any).on = (event: string, cb: (chunk?: Buffer) => void) => {
      if (event === 'data') cb(Buffer.from('{not json'))
      if (event === 'end') cb()
    }
    await tryHandleApprovals(ctx)
    expect(out).toMatchObject({ status: 400, body: { error: 'Invalid JSON' } })
  })

  it('a legacy decision on a button-bound approval leaves the nonce hash; a later press is already_resolved', async () => {
    const { id, nonce } = bound()
    expect((await patch(id, { status: 'approved', resolved_by: 'telegram_text' })).status).toBe(200)
    const out = await decide(id, press(nonce, { status: 'rejected' }))
    expect(out.status).toBe(409)
    expect(out.body.reason).toBe('already_resolved')
    expect(getApproval(id)?.status).toBe('approved')
  })
})
