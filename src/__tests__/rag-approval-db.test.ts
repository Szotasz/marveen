import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createHash } from 'node:crypto'
import {
  initDatabase, getDb, getApproval, resolveApproval, listApprovalEvents, isOwnerVerified,
  consumeOwnerRunApproval, createApproval, setApprovalCallbackNonceHashes, setApprovalTelegramMessageId,
  resolveApprovalFromTelegram, setPermissionBotNonceHashes,
} from '../db.js'
import { newCallbackNonce, nonceHash } from '../web/approval-callback-data.js'
import { ragPayloadContentHash } from '../web/rag-approval-payload.js'
import {
  OWNER, BOT, MAIN_BOT, MSG, PKG, RUN, pendingPermission, approvedPermission, press, payloadText,
  type Fixture,
} from './helpers/rag-approval-fixtures.js'

const T = Math.floor(Date.now() / 1000)
const START = T + 1000
const END = T + 4000
const win = { start: START, end: END, timeoutAt: T + 600 }

const consume = (f: Fixture, over: Partial<Parameters<typeof consumeOwnerRunApproval>[0]> = {}) =>
  consumeOwnerRunApproval({
    id: f.id, category: 'rag_production_d', packageSha256: PKG, runId: RUN, consumer: 'rag-prod-runner',
    expectedBotId: BOT, nowSec: START + 10, ...over,
  })
const events = (id: string) => listApprovalEvents(id)
const lastEvent = (id: string) => events(id).at(-1)

beforeEach(() => {
  initDatabase(':memory:')
})

describe('consumeOwnerRunApproval', () => {
  it('happy path: consumes once, records run_id and consumer, writes a consumed event', () => {
    const f = approvedPermission(win)
    const r = consume(f)
    expect(r.ok).toBe(true)
    expect(r.approval).toMatchObject({ consumed_at: START + 10, consumed_by: 'rag-prod-runner', consumed_ref: RUN })
    expect(r.payload).toMatchObject({ package_sha256: PKG, run_id: RUN, write_window_start: START, write_window_end: END })
    expect(events(f.id)).toEqual([expect.objectContaining({ event: 'consumed', reason: null, actor: 'rag-prod-runner', ref: RUN })])
  })

  it('double consume: the second is already_consumed and leaves the first untouched', () => {
    const f = approvedPermission(win)
    expect(consume(f).ok).toBe(true)
    const again = consume(f, { nowSec: START + 20, consumer: 'someone-else' })
    expect(again).toMatchObject({ ok: false, reason: 'already_consumed' })
    expect(getApproval(f.id)).toMatchObject({ consumed_at: START + 10, consumed_by: 'rag-prod-runner', consumed_ref: RUN })
    expect(events(f.id).map((e) => [e.event, e.reason])).toEqual([['consumed', null], ['consume_refused', 'already_consumed']])
    expect(lastEvent(f.id)).toMatchObject({ actor: 'someone-else', ref: RUN })
  })

  it('wrong package hash -> package_mismatch, nothing consumed', () => {
    const f = approvedPermission(win)
    expect(consume(f, { packageSha256: 'cd'.repeat(32) })).toMatchObject({ ok: false, reason: 'package_mismatch' })
    expect(getApproval(f.id)?.consumed_at).toBeNull()
    expect(lastEvent(f.id)).toMatchObject({ event: 'consume_refused', reason: 'package_mismatch' })
  })

  it('wrong run_id -> run_id_mismatch, nothing consumed', () => {
    const f = approvedPermission(win)
    expect(consume(f, { runId: 'f'.repeat(32) })).toMatchObject({ ok: false, reason: 'run_id_mismatch' })
    expect(getApproval(f.id)?.consumed_at).toBeNull()
    expect(lastEvent(f.id)).toMatchObject({ event: 'consume_refused', reason: 'run_id_mismatch', ref: 'f'.repeat(32) })
  })

  it('window boundaries are inclusive: start-1 not open, start ok; end ok, end+1 closed', () => {
    const early = approvedPermission(win)
    expect(consume(early, { nowSec: START - 1 })).toMatchObject({ ok: false, reason: 'window_not_open' })
    expect(lastEvent(early.id)).toMatchObject({ reason: 'window_not_open' })
    expect(consume(early, { nowSec: START }).ok).toBe(true)

    const late = approvedPermission({ ...win, run: 'a'.repeat(32) })
    expect(consume(late, { runId: 'a'.repeat(32), nowSec: END + 1 })).toMatchObject({ ok: false, reason: 'window_closed' })
    expect(lastEvent(late.id)).toMatchObject({ reason: 'window_closed' })
    expect(getApproval(late.id)?.consumed_at).toBeNull()
    expect(consume(late, { runId: 'a'.repeat(32), nowSec: END }).ok).toBe(true)
  })

  it('a PATCH-approved row is never owner-verified (not_owner_verified)', () => {
    const f = pendingPermission(win)
    expect(resolveApproval(f.id, 'approved', 'owner:telegram:' + OWNER)).toBe(true) // the same text the button writes
    expect(getApproval(f.id)?.status).toBe('approved')
    expect(isOwnerVerified(f.id, OWNER, BOT)).toBe(false)
    expect(consume(f)).toMatchObject({ ok: false, reason: 'not_owner_verified' })
    expect(getApproval(f.id)?.consumed_at).toBeNull()
    expect(lastEvent(f.id)).toMatchObject({ event: 'consume_refused', reason: 'not_owner_verified' })
  })

  it('main-bot evidence (bot_id differs) is not owner-verified', () => {
    const f = approvedPermission(win)
    expect(isOwnerVerified(f.id, OWNER, BOT)).toBe(true)
    // The same trace, but written with the main bot's id.
    getDb().prepare('UPDATE approval_owner_resolutions SET bot_id = ? WHERE approval_id = ?').run(MAIN_BOT, f.id)
    expect(isOwnerVerified(f.id, OWNER, BOT)).toBe(false)
    expect(consume(f)).toMatchObject({ ok: false, reason: 'not_owner_verified' })
    // A trace with no bot id at all (what the main bot's path writes) fails too.
    getDb().prepare('UPDATE approval_owner_resolutions SET bot_id = NULL WHERE approval_id = ?').run(f.id)
    expect(consume(f)).toMatchObject({ ok: false, reason: 'not_owner_verified' })
    // And a consume that does not know the permission bot's id never verifies.
    getDb().prepare('UPDATE approval_owner_resolutions SET bot_id = ? WHERE approval_id = ?').run(BOT, f.id)
    expect(isOwnerVerified(f.id, OWNER)).toBe(false)
    expect(consume(f).ok).toBe(true)
  })

  it('wrong category -> wrong_category (a probe row asked as rag_production_d, and an email row)', () => {
    const probe = approvedPermission({ ...win, category: 'permission_bot_probe' })
    expect(consume(probe)).toMatchObject({ ok: false, reason: 'wrong_category' })
    expect(lastEvent(probe.id)).toMatchObject({ reason: 'wrong_category' })
    expect(consume(probe, { category: 'permission_bot_probe' }).ok).toBe(true)

    createApproval({ id: '11111111-1111-4111-8111-111111111111', agent_id: 'x', category: 'email_send', action_description: 'x' })
    expect(consumeOwnerRunApproval({
      id: '11111111-1111-4111-8111-111111111111', category: 'rag_production_d', packageSha256: PKG, runId: RUN,
      consumer: 'c', expectedBotId: BOT, nowSec: START,
    })).toMatchObject({ ok: false, reason: 'wrong_category' })
  })

  it('a pending, rejected or timed-out row -> not_approved', () => {
    const pend = pendingPermission(win)
    expect(consume(pend)).toMatchObject({ ok: false, reason: 'not_approved' })
    const rej = pendingPermission({ ...win, run: 'b'.repeat(32) })
    expect(press(rej, { decision: 'rejected', nonce: rej.rejectNonce }).ok).toBe(true)
    expect(consume(rej, { runId: 'b'.repeat(32) })).toMatchObject({ ok: false, reason: 'not_approved' })
    expect(lastEvent(rej.id)).toMatchObject({ reason: 'not_approved' })
  })

  it('a payload or hash rewritten after the decision -> unbound', () => {
    const f = approvedPermission(win)
    const other = payloadText('rag_production_d', { start: START, end: END, run: 'c'.repeat(32) })
    getDb().prepare('UPDATE approvals SET action_payload = ? WHERE id = ?').run(other, f.id)
    expect(consume(f)).toMatchObject({ ok: false, reason: 'unbound' })
    // Payload and hash rewritten together: the trace's content_hash no longer matches.
    getDb().prepare('UPDATE approvals SET content_hash = ? WHERE id = ?').run(ragPayloadContentHash(other), f.id)
    expect(consume(f, { runId: 'c'.repeat(32) })).toMatchObject({ ok: false, reason: 'not_owner_verified' })
    expect(lastEvent(f.id)).toMatchObject({ event: 'consume_refused' })
  })

  it('a non-canonical payload under a matching hash -> unbound', () => {
    const f = approvedPermission(win)
    const spaced = f.payload.replace('{"kind"', '{ "kind"')
    const h = ragPayloadContentHash(spaced)
    getDb().prepare('UPDATE approvals SET action_payload = ?, content_hash = ? WHERE id = ?').run(spaced, h, f.id)
    getDb().prepare('UPDATE approval_owner_resolutions SET content_hash = ? WHERE approval_id = ?').run(h, f.id)
    expect(consume(f)).toMatchObject({ ok: false, reason: 'unbound' })
  })

  it('the same run_id on a second D approval -> run_id_already_used', () => {
    const a = approvedPermission(win)
    const b = approvedPermission(win)
    expect(consume(a).ok).toBe(true)
    expect(consume(b)).toMatchObject({ ok: false, reason: 'run_id_already_used' })
    expect(getApproval(b.id)?.consumed_at).toBeNull()
    expect(lastEvent(b.id)).toMatchObject({ event: 'consume_refused', reason: 'run_id_already_used' })
  })

  it('a well-formed unknown id -> not_found with an event row; a malformed id -> bad_request without one', () => {
    const ghost = '22222222-2222-4222-8222-222222222222'
    const r = consumeOwnerRunApproval({ id: ghost, category: 'rag_production_d', packageSha256: PKG, runId: RUN, consumer: 'c', expectedBotId: BOT, nowSec: START })
    expect(r).toMatchObject({ ok: false, reason: 'not_found' })
    expect(events(ghost)).toEqual([expect.objectContaining({ event: 'consume_refused', reason: 'not_found', actor: 'c', ref: RUN })])
    const bad = consumeOwnerRunApproval({ id: "x'; DROP TABLE approvals;--", category: 'rag_production_d', packageSha256: PKG, runId: RUN, consumer: 'c', expectedBotId: BOT })
    expect(bad).toMatchObject({ ok: false, reason: 'bad_request' })
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM approval_events').get()).toEqual({ n: 1 })
  })

  it('malformed arguments -> bad_request, no event', () => {
    const f = approvedPermission(win)
    for (const over of [
      { packageSha256: PKG.toUpperCase() }, { runId: RUN.slice(1) }, { consumer: '  ' }, { expectedBotId: 'abc' },
      { category: 'email_send' },
    ]) {
      expect(consume(f, over)).toMatchObject({ ok: false, reason: 'bad_request' })
    }
    expect(events(f.id)).toEqual([])
  })

  it('every refusal reason leaves exactly one event row', () => {
    const reasons = new Set<string>()
    const f = approvedPermission(win)
    const tries: Array<Partial<Parameters<typeof consumeOwnerRunApproval>[0]>> = [
      { packageSha256: 'cd'.repeat(32) }, { runId: 'f'.repeat(32) }, { nowSec: START - 1 }, { nowSec: END + 1 },
    ]
    for (const t of tries) {
      const before = events(f.id).length
      const r = consume(f, t)
      expect(r.ok).toBe(false)
      reasons.add(r.reason as string)
      expect(events(f.id).length).toBe(before + 1)
    }
    expect([...reasons].sort()).toEqual(['package_mismatch', 'run_id_mismatch', 'window_closed', 'window_not_open'])
  })
})

describe('resolveApprovalFromPermissionBot', () => {
  it('a win decides the row, clears both nonce hashes and writes the trace with the bot id', () => {
    const f = pendingPermission(win)
    const r = press(f)
    expect(r.ok).toBe(true)
    expect(getApproval(f.id)).toMatchObject({ status: 'approved', resolved_by: `owner:telegram:${OWNER}` })
    expect(getDb().prepare('SELECT callback_nonce_hash_approve AS a, callback_nonce_hash_reject AS r FROM approvals WHERE id = ?').get(f.id))
      .toEqual({ a: null, r: null })
    expect(getDb().prepare('SELECT owner_id, status, bot_id FROM approval_owner_resolutions WHERE approval_id = ?').get(f.id))
      .toEqual({ owner_id: OWNER, status: 'approved', bot_id: BOT })
    expect(isOwnerVerified(f.id, OWNER, BOT)).toBe(true)
    // The payload is kept for the consume.
    expect(getApproval(f.id)?.action_payload).toBe(f.payload)
  })

  it('stores only the content-bound nonce binding, never the nonce hash itself', () => {
    const f = pendingPermission(win)
    const row = getDb().prepare('SELECT callback_nonce_hash_approve AS a FROM approvals WHERE id = ?').get(f.id) as { a: string }
    expect(row.a).not.toBe(nonceHash(f.approveNonce))
    expect(row.a).toBe(createHash('sha256').update(`${nonceHash(f.approveNonce)}:${f.hash}`, 'utf8').digest('hex'))
  })

  it('refusals leave the row pending and writable: wrong nonce, other button, other message, other owner/chat, main bot, wrong bot', () => {
    const f = pendingPermission(win)
    const cases: Array<[string, Partial<Parameters<typeof press>[1]>, string]> = [
      ['wrong nonce', { nonce: newCallbackNonce() }, 'bad_nonce'],
      ['reject nonce on approve', { nonce: f.rejectNonce }, 'bad_nonce'],
      ['other message', { messageId: MSG + 1 }, 'message_mismatch'],
      ['other from', { fromId: '999' }, 'owner_mismatch'],
      ['other chat', { chatId: '999' }, 'owner_mismatch'],
      ['main bot', { botId: MAIN_BOT }, 'bot_mismatch'],
      ['unexpected bot', { botId: '7000000009' }, 'bot_mismatch'],
      ['bad nonce shape', { nonce: 'short' }, 'bad_request'],
      ['permission bot configured as main bot', { expectedBotId: MAIN_BOT, botId: MAIN_BOT }, 'bad_request'],
    ]
    for (const [label, over, reason] of cases) {
      expect(press(f, over), label).toMatchObject({ ok: false, reason })
      expect(getApproval(f.id)?.status, label).toBe('pending')
    }
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM approval_owner_resolutions').get()).toEqual({ n: 0 })
    expect(press(f).ok).toBe(true)
  })

  it('a second press (replay) is already_resolved; the spent nonce cannot decide again', () => {
    const f = pendingPermission(win)
    expect(press(f).ok).toBe(true)
    expect(press(f)).toMatchObject({ ok: false, reason: 'already_resolved' })
    expect(press(f, { decision: 'rejected', nonce: f.rejectNonce })).toMatchObject({ ok: false, reason: 'already_resolved' })
    expect(getApproval(f.id)?.status).toBe('approved')
  })

  it('expired (by deadline) and unknown, other-category rows are refused', () => {
    const f = pendingPermission(win)
    expect(press(f, { nowS: T + 601 })).toMatchObject({ ok: false, reason: 'expired' })
    expect(press({ ...f, id: '33333333-3333-4333-8333-333333333333' })).toMatchObject({ ok: false, reason: 'not_found' })
    createApproval({ id: '44444444-4444-4444-8444-444444444444', agent_id: 'x', category: 'email_send', action_description: 'x', content_hash: 'ab'.repeat(32), timeout_at: T + 600 })
    expect(press({ ...f, id: '44444444-4444-4444-8444-444444444444' })).toMatchObject({ ok: false, reason: 'wrong_category' })
  })

  it('a payload rewritten (hash kept) after the buttons went out is payload_mismatch', () => {
    const f = pendingPermission(win)
    getDb().prepare('UPDATE approvals SET action_payload = ? WHERE id = ?')
      .run(payloadText('rag_production_d', { start: START, end: END, run: 'c'.repeat(32) }), f.id)
    expect(press(f)).toMatchObject({ ok: false, reason: 'payload_mismatch' })
    expect(getApproval(f.id)?.status).toBe('pending')
  })

  it('payload and hash rewritten together fail the content-bound nonce (bad_nonce)', () => {
    const f = pendingPermission(win)
    const other = payloadText('rag_production_d', { start: START, end: END, run: 'c'.repeat(32) })
    getDb().prepare('UPDATE approvals SET action_payload = ?, content_hash = ? WHERE id = ?').run(other, ragPayloadContentHash(other), f.id)
    expect(press(f)).toMatchObject({ ok: false, reason: 'bad_nonce' })
  })

  it('the main-bot path cannot decide a permission-bot row, nor can a nonce be bound for another category', () => {
    const f = pendingPermission(win)
    expect(resolveApprovalFromTelegram({ id: f.id, status: 'approved', ownerId: OWNER, messageId: MSG, nonceHash: nonceHash(f.approveNonce) }))
      .toMatchObject({ ok: false, reason: 'wrong_category' })
    createApproval({ id: '55555555-5555-4555-8555-555555555555', agent_id: 'x', category: 'email_send', action_description: 'x', content_hash: 'ab'.repeat(32), timeout_at: T + 600 })
    expect(setPermissionBotNonceHashes('55555555-5555-4555-8555-555555555555', { approved: 'aa'.repeat(32), rejected: 'bb'.repeat(32) })).toBe(false)
    // and the other direction: the email binder does not bind a permission-bot row
    const g = pendingPermission({ ...win, run: 'd'.repeat(32) })
    expect(setApprovalCallbackNonceHashes(g.id, { approved: 'aa'.repeat(32), rejected: 'bb'.repeat(32) })).toBe(false)
    expect(setApprovalTelegramMessageId(g.id, 1)).toBe(false) // already stamped by the fixture
  })

  // Reviewer nit: the race test stays green without the conditional UPDATE as
  // long as BEGIN IMMEDIATE serialises the callers. This pins the WHERE
  // consumed_at IS NULL on its own: another writer flips consumed_at between
  // the checks and the UPDATE (injected on the same connection, right before
  // the consume's UPDATE runs). The UPDATE must then change 0 rows, the call
  // must answer already_consumed, and the other writer's values must stand.
  it('the consume UPDATE is conditional on consumed_at IS NULL by itself (independent of IMMEDIATE)', () => {
    const f = approvedPermission(win)
    const db = getDb()
    const realPrepare = db.prepare.bind(db)
    let injected = 0
    const spy = vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
      if (injected === 0 && /^\s*UPDATE approvals SET consumed_at/.test(sql)) {
        injected++
        realPrepare("UPDATE approvals SET consumed_at = ?, consumed_by = 'other-writer', consumed_ref = ? WHERE id = ?")
          .run(START + 5, RUN, f.id)
      }
      return realPrepare(sql)
    }) as typeof db.prepare)
    try {
      const r = consume(f)
      expect(injected).toBe(1)
      expect(r).toMatchObject({ ok: false, reason: 'already_consumed' })
    } finally {
      spy.mockRestore()
    }
    expect(getApproval(f.id)).toMatchObject({ consumed_at: START + 5, consumed_by: 'other-writer', consumed_ref: RUN })
    expect(lastEvent(f.id)).toMatchObject({ event: 'consume_refused', reason: 'already_consumed', actor: 'rag-prod-runner' })
    expect(events(f.id).some((e) => e.event === 'consumed')).toBe(false)
  })

  it('the owner pin: null expectedOwnerId is owner_unresolved with an event; another owner is not_owner_verified', () => {
    const f = approvedPermission(win)
    expect(consume(f, { expectedOwnerId: null })).toMatchObject({ ok: false, reason: 'owner_unresolved' })
    expect(lastEvent(f.id)).toMatchObject({ event: 'consume_refused', reason: 'owner_unresolved' })
    expect(consume(f, { expectedOwnerId: '1000000099' })).toMatchObject({ ok: false, reason: 'not_owner_verified' })
    expect(getApproval(f.id)?.consumed_at).toBeNull()
    expect(consume(f, { expectedOwnerId: OWNER }).ok).toBe(true)
  })

  it('the bot_id column migration is idempotent', () => {
    const cols = () => (getDb().prepare('PRAGMA table_info(approval_owner_resolutions)').all() as Array<{ name: string }>).map((c) => c.name)
    expect(cols()).toContain('bot_id')
    initDatabase(':memory:')
    expect(cols().filter((c) => c === 'bot_id')).toHaveLength(1)
  })
})
