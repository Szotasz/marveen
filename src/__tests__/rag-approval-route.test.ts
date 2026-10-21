import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Card 9a77b3e5, N3b: the permission bot's decision endpoint
// (POST /api/approvals/:id/permission-bot) and the run consume
// (POST /api/approvals/:id/consume-run), through the real route handler. The
// button message comes from the real sender (fake Telegram), so every nonce
// here is one the owner's chat actually carried. No network, Vault mocked.

const state = vi.hoisted(() => ({
  mainToken: '',
  allowedChatId: '',
  channelToken: null as string | null,
  permToken: null as string | null,
  pinnedId: '',
}))

vi.mock('../config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../config.js')>()
  return {
    ...real,
    MAIN_AGENT_ID: 'marveen',
    get PERMISSION_BOT_ID() { return state.pinnedId },
    get TELEGRAM_BOT_TOKEN() { return state.mainToken },
    get ALLOWED_CHAT_ID() { return state.allowedChatId },
  }
})

vi.mock('../owner-chat.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../owner-chat.js')>()
  const read = () => { throw new Error('ENOENT') }
  return {
    ...real,
    resolveOwnerChatId: vi.fn((_r?: unknown, configured?: string | null) => real.resolveOwnerChatId(read, configured)),
    resolveAlertOwnerChat: vi.fn((_r?: unknown, configured?: string | null) => real.resolveAlertOwnerChat(read, configured)),
  }
})

vi.mock('../channel-provider.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../channel-provider.js')>()
  return { ...real, readChannelToken: vi.fn(() => state.channelToken) }
})

vi.mock('../web/vault.js', () => ({
  getSecret: vi.fn((id: string) => (id === 'telegram-engedely-bot-token' ? state.permToken : null)),
}))

import { initDatabase, getApproval, getDb, listApprovalEvents } from '../db.js'
import { logger } from '../logger.js'
import { ownerNotificationsSettled } from '../web/routes/approvals.js'
import {
  OWNER, MAIN_BOT, PERM_BOT, MAIN_TOKEN, MAIN_CHANNEL_TOKEN, PERM_TOKEN, SECRET_PARTS, PKG, RUN,
  createFakeTelegram, route, canonical, requestBody, buttonsOf, dumpLogs, sha,
} from './helpers/rag-approval-route-harness.js'

const tg = createFakeTelegram()
let logged: unknown[][] = []
let responses: string[] = []
const nonces: string[] = []
const T0 = Math.floor(Date.now() / 1000)
const START = T0 - 10
const END = T0 + 3600

interface Posted { id: string; payload: string; approve: string; reject: string; messageId: number }

async function postD(opts: { start?: number; end?: number; run?: string; pkg?: string; kind?: string; timeout?: number } = {}): Promise<Posted> {
  const payload = canonical({ kind: opts.kind, start: opts.start ?? START, end: opts.end ?? END, run: opts.run, pkg: opts.pkg })
  const out = await route('POST', '/api/approvals', requestBody(payload, { timeout_seconds: opts.timeout ?? 600 }))
  responses.push(out.raw)
  expect(out.status).toBe(201)
  await ownerNotificationsSettled()
  const send = tg.sends().at(-1)!
  const { approve, reject } = buttonsOf(send, out.body.id)
  nonces.push(approve, reject)
  const row = getApproval(out.body.id)!
  return { id: out.body.id, payload, approve, reject, messageId: row.telegram_message_id! }
}

const pressBody = (p: Posted, over: Record<string, unknown> = {}) => ({
  decision: 'approved', nonce: p.approve, from_id: OWNER, chat_id: OWNER, message_id: p.messageId, bot_id: PERM_BOT, ...over,
})

async function press(p: Posted, over: Record<string, unknown> = {}) {
  const out = await route('POST', `/api/approvals/${p.id}/permission-bot`, pressBody(p, over))
  responses.push(out.raw)
  return out
}

async function approveD(p: Posted) {
  const out = await press(p)
  expect(out.status).toBe(200)
  await ownerNotificationsSettled()
  return out
}

const consumeBody = (over: Record<string, unknown> = {}) => ({
  category: 'rag_production_d', package_sha256: PKG, run_id: RUN, consumer: 'rag-prod-runner', ...over,
})

async function consume(id: string, over: Record<string, unknown> = {}) {
  const out = await route('POST', `/api/approvals/${id}/consume-run`, consumeBody(over))
  responses.push(out.raw)
  return out
}

const eventsOf = (id: string) => listApprovalEvents(id).map(e => [e.event, e.reason])
const status = (id: string) => getApproval(id)!.status

beforeEach(() => {
  initDatabase(':memory:')
  state.mainToken = MAIN_TOKEN
  state.allowedChatId = OWNER
  state.channelToken = MAIN_CHANNEL_TOKEN
  state.permToken = PERM_TOKEN
  state.pinnedId = PERM_BOT
  tg.reset()
  vi.stubGlobal('fetch', tg.fetch)
  logged = []
  responses = []
  nonces.length = 0
  for (const level of ['info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => { logged.push([level, ...args]) }) as never)
  }
})

afterEach(async () => {
  await ownerNotificationsSettled()
  vi.useRealTimers()
  // The token never appears in a log or a response; a nonce neither (it lives
  // only in the button data of the sent message).
  const logs = dumpLogs(logged)
  expect(logs).not.toContain(PERM_TOKEN)
  for (const part of SECRET_PARTS) {
    expect(logs).not.toContain(part)
    for (const r of responses) expect(r).not.toContain(part)
  }
  for (const n of nonces) {
    expect(logs).not.toContain(n)
    expect(logs).not.toContain(sha(n))
    for (const r of responses) expect(r).not.toContain(n)
  }
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('POST /api/approvals/:id/permission-bot', () => {
  it('the owner\'s approve press decides the row, takes the buttons off and makes it owner-verified', async () => {
    const p = await postD()
    const out = await press(p)
    expect(out.status).toBe(200)
    expect(out.body).toMatchObject({ ok: true, approval: { id: p.id, status: 'approved', resolved_by: `owner:telegram:${OWNER}` } })
    await ownerNotificationsSettled()
    // Buttons off: editMessageReplyMarkup on THAT message, through the permission bot.
    expect(tg.edits()).toHaveLength(1)
    expect(tg.edits()[0]!.url).toBe(`https://api.telegram.org/bot${PERM_TOKEN}/editMessageReplyMarkup`)
    expect(tg.edits()[0]!.body).toMatchObject({ chat_id: OWNER, message_id: p.messageId, reply_markup: { inline_keyboard: [] } })
    const got = await route('GET', `/api/approvals/${p.id}`)
    expect(got.body.owner_verified).toBe(true)
  })

  it('the reject press rejects; the row can then never be consumed', async () => {
    const p = await postD()
    const out = await press(p, { decision: 'rejected', nonce: p.reject })
    expect(out.status).toBe(200)
    expect(out.body.approval.status).toBe('rejected')
    expect((await consume(p.id)).body).toMatchObject({ ok: false, reason: 'not_approved' })
  })

  it('a failed "buttons off" edit does not undo the decision (best effort) and leaks no token', async () => {
    const p = await postD()
    tg.mode = 'edit500'
    expect((await press(p)).status).toBe(200)
    await ownerNotificationsSettled()
    expect(status(p.id)).toBe('approved')
    expect(logged.some(a => a[0] === 'warn' && String(a[2]).includes('buttons could not be taken off'))).toBe(true)
  })

  it('forged nonce: 403 bad_nonce, nothing decided', async () => {
    const p = await postD()
    const out = await press(p, { nonce: 'A'.repeat(22) })
    expect(out).toMatchObject({ status: 403, body: { ok: false, reason: 'bad_nonce' } })
    expect(status(p.id)).toBe('pending')
  })

  it('the reject button\'s nonce does not take the approve decision', async () => {
    const p = await postD()
    expect((await press(p, { nonce: p.reject })).status).toBe(403)
    expect(status(p.id)).toBe('pending')
  })

  const refused: Array<[string, (p: Posted) => Record<string, unknown>, number, string]> = [
    ['another from_id', () => ({ from_id: '1000000099', chat_id: '1000000099' }), 403, 'owner_mismatch'],
    ['another chat_id', () => ({ chat_id: '1000000099' }), 403, 'owner_mismatch'],
    ['a group chat id', () => ({ chat_id: '-1001234567890' }), 403, 'owner_mismatch'],
    ['another message_id', (p) => ({ message_id: p.messageId + 1 }), 403, 'message_mismatch'],
    ['another bot_id', () => ({ bot_id: '7000000099' }), 403, 'bot_mismatch'],
    ['the main bot\'s id as bot_id', () => ({ bot_id: MAIN_BOT }), 403, 'bot_mismatch'],
  ]
  for (const [name, over, code, reason] of refused) {
    it(`${code} ${reason}: ${name}`, async () => {
      const p = await postD()
      const out = await press(p, over(p))
      expect(out).toMatchObject({ status: code, body: { ok: false, reason } })
      expect(status(p.id)).toBe('pending')
      // The refused press does not burn the buttons: the real press still works.
      expect((await press(p)).status).toBe(200)
    })
  }

  it('a repeated press is refused (409 already_resolved) and decides nothing again', async () => {
    const p = await postD()
    await approveD(p)
    const again = await press(p)
    expect(again).toMatchObject({ status: 409, body: { ok: false, reason: 'already_resolved', status: 'approved' } })
    expect((await press(p, { decision: 'rejected', nonce: p.reject })).status).toBe(409)
    expect(status(p.id)).toBe('approved')
  })

  it('an expired request is refused (409 expired)', async () => {
    const p = await postD({ timeout: 60 })
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date((T0 + 61) * 1000))
    expect(await press(p)).toMatchObject({ status: 409, body: { ok: false, reason: 'expired' } })
    expect(status(p.id)).toBe('pending')
  })

  it('a row whose message was never stamped is not_bound', async () => {
    const p = await postD()
    getDb().prepare('UPDATE approvals SET telegram_message_id = NULL WHERE id = ?').run(p.id)
    expect(await press(p)).toMatchObject({ status: 409, body: { reason: 'not_bound' } })
  })

  it('a payload rewritten after the message went out is refused (payload_mismatch)', async () => {
    const p = await postD()
    getDb().prepare('UPDATE approvals SET action_payload = ? WHERE id = ?').run(canonical({ start: START, end: END, pkg: 'cd'.repeat(32) }), p.id)
    expect(await press(p)).toMatchObject({ status: 409, body: { reason: 'payload_mismatch' } })
    expect(status(p.id)).toBe('pending')
  })

  it('an email_send row cannot be decided here (409 wrong_category)', async () => {
    const out = await route('POST', '/api/approvals', { agent_id: 'x', category: 'email_send', action_description: 'y', timeout_seconds: 600 })
    const fake = { id: out.body.id, approve: 'A'.repeat(22), reject: 'B'.repeat(22), messageId: 5, payload: '' }
    expect(await press(fake)).toMatchObject({ status: 409, body: { reason: 'wrong_category' } })
    await ownerNotificationsSettled()
  })

  it('an unknown id is 404', async () => {
    const p = await postD()
    expect(await press({ ...p, id: '00000000-0000-4000-8000-000000000000' })).toMatchObject({ status: 404, body: { reason: 'not_found' } })
  })

  it('malformed bodies are 400 with the field named', async () => {
    const p = await postD()
    const cases: Array<[string, Record<string, unknown>]> = [
      ['decision', { decision: 'maybe' }],
      ['nonce', { nonce: 'short' }],
      ['from_id', { from_id: 5 }],
      ['chat_id', { chat_id: '' }],
      ['message_id', { message_id: '4242' }],
      ['bot_id', { bot_id: 'abc' }],
    ]
    for (const [field, over] of cases) {
      const out = await press(p, over)
      expect(out).toMatchObject({ status: 400, body: { ok: false, reason: 'bad_request', field } })
    }
    expect((await route('POST', `/api/approvals/${p.id}/permission-bot`, '{not json')).status).toBe(400)
    expect(await route('POST', '/api/approvals/not-an-id/permission-bot', pressBody(p))).toMatchObject({ status: 400, body: { field: 'id' } })
    expect(status(p.id)).toBe('pending')
  })

  it('fails closed: 503 when the owner or the permission bot cannot be resolved', async () => {
    const p = await postD()
    state.allowedChatId = ''
    expect(await press(p)).toMatchObject({ status: 503, body: { reason: 'owner_unresolved' } })
    state.allowedChatId = OWNER
    state.permToken = null
    expect(await press(p)).toMatchObject({ status: 503, body: { reason: 'permission_bot_unavailable' } })
    state.permToken = MAIN_TOKEN.replace('AAmainSECRETpartABC', 'AAotherSECRETpartQQQ')
    expect(await press(p)).toMatchObject({ status: 503, body: { reason: 'permission_bot_unavailable' } })
    expect(status(p.id)).toBe('pending')
  })

  it('the main bot\'s own apv: callback (POST /telegram) cannot decide a permission-bot row', async () => {
    const p = await postD()
    const out = await route('POST', `/api/approvals/${p.id}/telegram`, {
      status: 'approved',
      resolved_by: `owner:telegram:${OWNER}`,
      telegram_message_id: p.messageId,
      telegram_chat_id: OWNER,
      telegram_chat_type: 'private',
      callback_nonce: p.approve,
      callback_protocol: 1,
    })
    responses.push(out.raw)
    expect(out).toMatchObject({ status: 409, body: { ok: false, reason: 'wrong_category' } })
    expect(status(p.id)).toBe('pending')
  })
})

describe('POST /api/approvals/:id/consume-run', () => {
  it('happy path: 200 with the contract shape, one approval_events row', async () => {
    const p = await postD()
    await approveD(p)
    const out = await consume(p.id)
    expect(out.status).toBe(200)
    expect(out.body).toEqual({
      ok: true,
      approval: {
        id: p.id, category: 'rag_production_d', status: 'approved',
        consumed_at: expect.any(Number), consumed_by: 'rag-prod-runner', consumed_ref: RUN,
        package_sha256: PKG, run_id: RUN, write_window_start: START, write_window_end: END,
      },
    })
    expect(eventsOf(p.id)).toEqual([['consumed', null]])
  })

  it('the second consume is 409 already_consumed and leaves the first use alone', async () => {
    const p = await postD()
    await approveD(p)
    expect((await consume(p.id)).status).toBe(200)
    const again = await consume(p.id, { consumer: 'second-runner' })
    expect(again).toMatchObject({ status: 409, body: { ok: false, reason: 'already_consumed' } })
    expect(getApproval(p.id)).toMatchObject({ consumed_by: 'rag-prod-runner', consumed_ref: RUN })
    expect(eventsOf(p.id)).toEqual([['consumed', null], ['consume_refused', 'already_consumed']])
  })

  it('a PATCH-approved row is 409 not_owner_verified (the dashboard cannot approve a run)', async () => {
    const p = await postD()
    const patched = await route('PATCH', `/api/approvals/${p.id}`, { status: 'approved', resolved_by: 'dashboard' })
    expect(patched.status).toBe(200)
    expect(status(p.id)).toBe('approved')
    expect(await consume(p.id)).toMatchObject({ status: 409, body: { ok: false, reason: 'not_owner_verified' } })
    expect((await route('GET', `/api/approvals/${p.id}`)).body.owner_verified).toBe(false)
    expect(eventsOf(p.id)).toEqual([['consume_refused', 'not_owner_verified']])
  })

  it('a main-bot-shaped trace (right owner, wrong bot id) is not owner-verified', async () => {
    const p = await postD()
    await approveD(p)
    getDb().prepare('UPDATE approval_owner_resolutions SET bot_id = ? WHERE approval_id = ?').run(MAIN_BOT, p.id)
    expect(await consume(p.id)).toMatchObject({ status: 409, body: { reason: 'not_owner_verified' } })
  })

  it('a pending or rejected request is 409 not_approved', async () => {
    const p = await postD()
    expect(await consume(p.id)).toMatchObject({ status: 409, body: { reason: 'not_approved' } })
  })

  it('wrong category: the row is D, the caller asks for the probe', async () => {
    const p = await postD()
    await approveD(p)
    expect(await consume(p.id, { category: 'permission_bot_probe' })).toMatchObject({ status: 409, body: { reason: 'wrong_category' } })
  })

  it('a payload no longer the hash\'s is 409 unbound', async () => {
    const p = await postD()
    await approveD(p)
    getDb().prepare('UPDATE approvals SET action_payload = ? WHERE id = ?').run(canonical({ start: START, end: END, pkg: 'cd'.repeat(32) }), p.id)
    expect(await consume(p.id)).toMatchObject({ status: 409, body: { reason: 'unbound' } })
  })

  it('another package hash and another run_id are refused', async () => {
    const p = await postD()
    await approveD(p)
    expect(await consume(p.id, { package_sha256: 'cd'.repeat(32) })).toMatchObject({ status: 409, body: { reason: 'package_mismatch' } })
    expect(await consume(p.id, { run_id: 'fedcba9876543210fedcba9876543210' })).toMatchObject({ status: 409, body: { reason: 'run_id_mismatch' } })
    expect(getApproval(p.id)!.consumed_at).toBeNull()
  })

  it('before the window: 409 window_not_open; after it: 409 window_closed; the edges are inclusive', async () => {
    const p = await postD({ start: T0 + 600, end: T0 + 1200 })
    await approveD(p)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date((T0 + 599) * 1000))
    expect(await consume(p.id)).toMatchObject({ status: 409, body: { reason: 'window_not_open' } })
    vi.setSystemTime(new Date((T0 + 1201) * 1000))
    expect(await consume(p.id)).toMatchObject({ status: 409, body: { reason: 'window_closed' } })
    vi.setSystemTime(new Date((T0 + 1200) * 1000))
    expect((await consume(p.id)).status).toBe(200)
  })

  it('one run_id is used by one approval only: the second D row of the run is 409 run_id_already_used', async () => {
    const a = await postD()
    const b = await postD()
    await approveD(a)
    await approveD(b)
    expect((await consume(a.id)).status).toBe(200)
    expect(await consume(b.id)).toMatchObject({ status: 409, body: { reason: 'run_id_already_used' } })
  })

  it('unknown id: 404 not_found, with an event row for a well-formed id', async () => {
    const id = '00000000-0000-4000-8000-000000000000'
    expect(await consume(id)).toMatchObject({ status: 404, body: { ok: false, reason: 'not_found' } })
    expect(eventsOf(id)).toEqual([['consume_refused', 'not_found']])
  })

  it('503 owner_unresolved when the strict owner cannot be resolved (and the attempt is on record)', async () => {
    const p = await postD()
    await approveD(p)
    state.allowedChatId = ''
    expect(await consume(p.id)).toMatchObject({ status: 503, body: { ok: false, reason: 'owner_unresolved' } })
    expect(getApproval(p.id)!.consumed_at).toBeNull()
    expect(eventsOf(p.id)).toEqual([['consume_refused', 'owner_unresolved']])
    state.allowedChatId = OWNER
    expect((await consume(p.id)).status).toBe(200)
  })

  it('a trace of an owner who is no longer THE owner does not count', async () => {
    const p = await postD()
    await approveD(p)
    state.allowedChatId = '1000000077'
    expect(await consume(p.id)).toMatchObject({ status: 409, body: { reason: 'not_owner_verified' } })
  })

  it('503 permission_bot_unavailable when the Vault has no permission-bot token', async () => {
    const p = await postD()
    await approveD(p)
    state.permToken = null
    expect(await consume(p.id)).toMatchObject({ status: 503, body: { reason: 'permission_bot_unavailable' } })
    expect(getApproval(p.id)!.consumed_at).toBeNull()
  })

  it('B1: a swapped Vault token (another bot id) is never trusted: 503 on both endpoints, nothing sent, no owner-verified', async () => {
    const p = await postD()
    const swapped = '7000000099:AAswappedSECRETpartZZZ'
    // The attacker swaps the Vault entry; the pinned id stays PERM_BOT.
    state.permToken = swapped
    const sendsBefore = tg.calls.length
    expect(await press(p)).toMatchObject({ status: 503, body: { reason: 'permission_bot_unavailable' } })
    expect(status(p.id)).toBe('pending')
    expect(await consume(p.id)).toMatchObject({ status: 503, body: { reason: 'permission_bot_unavailable' } })
    expect((await route('GET', `/api/approvals/${p.id}`)).body.owner_verified).toBe(false)
    expect(tg.calls.length).toBe(sendsBefore)
    expect(dumpLogs(logged)).not.toContain('AAswappedSECRETpartZZZ')
    // And with the swapped bot's id as the "press": a row decided by the REAL
    // press stays unconsumable while the Vault holds the swapped token.
    state.permToken = PERM_TOKEN
    await approveD(p)
    state.permToken = swapped
    expect(await consume(p.id)).toMatchObject({ status: 503, body: { reason: 'permission_bot_unavailable' } })
    expect((await route('GET', `/api/approvals/${p.id}`)).body.owner_verified).toBe(false)
    expect(getApproval(p.id)!.consumed_at).toBeNull()
  })

  it('B1: a press carrying the swapped bot\'s id cannot decide even if the Vault token was swapped to match it', async () => {
    const p = await postD()
    state.permToken = '7000000099:AAswappedSECRETpartZZZ'
    expect(await press(p, { bot_id: '7000000099' })).toMatchObject({ status: 503 })
    expect(status(p.id)).toBe('pending')
  })

  it('B1: PERMISSION_BOT_ID missing or invalid: /permission-bot and consume-run are 503 and the owner-verified view is false', async () => {
    const p = await postD()
    await approveD(p)
    for (const bad of ['', 'not-digits', '0']) {
      state.pinnedId = bad
      expect(await press(p)).toMatchObject({ status: 503, body: { reason: 'permission_bot_unavailable' } })
      expect(await consume(p.id)).toMatchObject({ status: 503, body: { reason: 'permission_bot_unavailable' } })
      expect((await route('GET', `/api/approvals/${p.id}`)).body.owner_verified).toBe(false)
    }
    expect(getApproval(p.id)!.consumed_at).toBeNull()
  })

  it('B1: with a missing pin no D request is sent at all (fail-closed on the send side)', async () => {
    state.pinnedId = ''
    const payload = canonical({ start: START, end: END })
    const out = await route('POST', '/api/approvals', requestBody(payload))
    expect(out.status).toBe(201)
    await ownerNotificationsSettled()
    expect(tg.calls).toHaveLength(0)
  })

  it('malformed requests are 400 with the field named and write no consume', async () => {
    const p = await postD()
    await approveD(p)
    const cases: Array<[string, Record<string, unknown>]> = [
      ['category', { category: 'email_send' }],
      ['category', { category: 5 }],
      ['package_sha256', { package_sha256: 'AB'.repeat(32) }],
      ['package_sha256', { package_sha256: undefined }],
      ['run_id', { run_id: 'xyz' }],
      ['consumer', { consumer: '' }],
      ['consumer', { consumer: 'bad\nname' }],
    ]
    for (const [field, over] of cases) {
      expect(await consume(p.id, over)).toMatchObject({ status: 400, body: { ok: false, reason: 'bad_request', field } })
    }
    expect((await route('POST', `/api/approvals/${p.id}/consume-run`, 'nope')).status).toBe(400)
    expect(await consume('not-an-id')).toMatchObject({ status: 400, body: { field: 'id' } })
    expect(getApproval(p.id)!.consumed_at).toBeNull()
    expect(eventsOf(p.id)).toEqual([])
  })

  it('the e-mail /consume endpoint stays as it was (needs a content_hash, knows nothing of runs)', async () => {
    const p = await postD()
    await approveD(p)
    const out = await route('POST', `/api/approvals/${p.id}/consume`, { content_hash: 'ab'.repeat(32), consumer: 'x' })
    expect(out.status).toBe(409)
    expect(getApproval(p.id)!.consumed_at).toBeNull()
  })

  it('the probe category runs the same gate end to end', async () => {
    const p = await postD({ kind: 'permission_bot_probe' })
    await approveD(p)
    expect((await consume(p.id, { category: 'permission_bot_probe' })).status).toBe(200)
  })
})
