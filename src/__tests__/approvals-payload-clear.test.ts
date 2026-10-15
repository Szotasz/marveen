import { describe, it, expect, beforeEach } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import {
  initDatabase, getDb, createApproval, getApproval, listApprovals, resolveApproval,
  expireTimedOutApprovals, consumeApproval, setApprovalTelegramMessageId,
  setApprovalCallbackNonceHashes, resolveApprovalFromTelegram, clearSpentEmailPayloads,
  CLEARED_EMAIL_PAYLOAD,
} from '../db.js'

// An email_send action_payload is the whole letter, BCC
// included, and every bearer holder can list it. Once the letter can no longer
// be sent (rejected, timed out, consumed, or approved and left past the send
// window) the payload is replaced by a marker. A NULL payload stays NULL, and
// every other category keeps its payload exactly as before.
const HASH = 'ab'.repeat(32)
const OWNER = '1000000001'
const MSG = 4242
const NOW = Math.floor(Date.now() / 1000)
const WINDOW = 1800
const LETTER = JSON.stringify({
  envelope_v: 1, to: ['ugyfel@example.com'], cc: [], bcc: ['rejtett@example.com'], text: 'Tisztelt Ügyfelünk!',
})
const OTHER = JSON.stringify({ path: '/tmp/x', bcc: 'not a letter' })

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')
const newNonce = () => randomBytes(16).toString('base64url')
const payloadOf = (id: string) => getApproval(id)!.action_payload

function make(id: string, opts: { category?: string; payload?: string | null; timeoutAt?: number | null } = {}) {
  return createApproval({
    id,
    agent_id: 'marveen',
    category: opts.category ?? 'email_send',
    action_description: 'x',
    action_payload: opts.payload === undefined ? LETTER : opts.payload,
    content_hash: HASH,
    timeout_at: opts.timeoutAt === undefined ? NOW + 600 : opts.timeoutAt,
  })
}

function bound(id: string, payload: string | null = LETTER) {
  make(id, { payload })
  const nonce = newNonce()
  const rejectNonce = newNonce()
  expect(setApprovalCallbackNonceHashes(id, { approved: sha(nonce), rejected: sha(rejectNonce) })).toBe(true)
  expect(setApprovalTelegramMessageId(id, MSG)).toBe(true)
  return { approveHash: sha(nonce), rejectHash: sha(rejectNonce) }
}

// What the Python send gate does on an allowed send: it writes consumed_at
// directly, without passing through db.ts.
function gateConsume(id: string, at: number) {
  getDb().prepare('UPDATE approvals SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL').run(at, id)
}

beforeEach(() => {
  initDatabase(':memory:')
})

describe('email_send payload is cleared once the letter is spent', () => {
  it('the marker is the agreed summary object', () => {
    expect(JSON.parse(CLEARED_EMAIL_PAYLOAD)).toEqual({ envelope_v: 1, cleared: true })
  })

  it('legacy reject and legacy timeout clear it; legacy approve keeps it until the send', () => {
    make('r1'); make('r2'); make('r3')
    expect(resolveApproval('r1', 'rejected', 'dashboard')).toBe(true)
    expect(resolveApproval('r2', 'timeout', 'dashboard')).toBe(true)
    expect(resolveApproval('r3', 'approved', 'dashboard')).toBe(true)
    expect(payloadOf('r1')).toBe(CLEARED_EMAIL_PAYLOAD)
    expect(payloadOf('r2')).toBe(CLEARED_EMAIL_PAYLOAD)
    expect(payloadOf('r3')).toBe(LETTER)
  })

  it('a refused legacy resolve (already decided) does not touch the payload', () => {
    make('r4')
    expect(resolveApproval('r4', 'approved', 'dashboard')).toBe(true)
    expect(resolveApproval('r4', 'rejected', 'dashboard')).toBe(false)
    expect(getApproval('r4')).toMatchObject({ status: 'approved', action_payload: LETTER })
  })

  it('the Telegram reject button clears it; the approve button keeps it; a refused press changes nothing', () => {
    const a = bound('t1')
    const b = bound('t2')
    const c = bound('t3')
    const press = (id: string, status: 'approved' | 'rejected', nonceHash: string) =>
      resolveApprovalFromTelegram({ id, status, ownerId: OWNER, messageId: MSG, nonceHash, nowS: NOW })
    expect(press('t1', 'rejected', a.rejectHash).ok).toBe(true)
    expect(press('t2', 'approved', b.approveHash).ok).toBe(true)
    expect(press('t3', 'rejected', c.approveHash)).toMatchObject({ ok: false, reason: 'bad_nonce' })
    expect(payloadOf('t1')).toBe(CLEARED_EMAIL_PAYLOAD)
    expect(payloadOf('t2')).toBe(LETTER)
    expect(getApproval('t3')).toMatchObject({ status: 'pending', action_payload: LETTER })
  })

  it('a successful consume clears it in the same UPDATE; a refused consume does not', () => {
    make('c1'); make('c2')
    resolveApproval('c1', 'approved', 'dashboard')
    resolveApproval('c2', 'approved', 'dashboard')
    expect(consumeApproval({ id: 'c2', contentHash: 'cd'.repeat(32), consumer: 't', windowSeconds: WINDOW })).toMatchObject({ ok: false, reason: 'hash_mismatch' })
    expect(payloadOf('c2')).toBe(LETTER)
    expect(consumeApproval({ id: 'c1', contentHash: HASH, consumer: 't', windowSeconds: WINDOW }).ok).toBe(true)
    expect(payloadOf('c1')).toBe(CLEARED_EMAIL_PAYLOAD)
  })

  it('the timeout sweep clears the email_send rows it expires', () => {
    make('e1', { timeoutAt: NOW - 5 })
    make('e2', { timeoutAt: NOW + 600 })
    expect(expireTimedOutApprovals()).toBe(1)
    expect(getApproval('e1')).toMatchObject({ status: 'timeout', action_payload: CLEARED_EMAIL_PAYLOAD })
    expect(getApproval('e2')).toMatchObject({ status: 'pending', action_payload: LETTER })
  })

  it('a NULL payload stays NULL on every path', () => {
    make('n1', { payload: null }); make('n2', { payload: null }); make('n3', { payload: null, timeoutAt: NOW - 5 })
    make('n4', { payload: null })
    const t = bound('n5', null)
    resolveApproval('n1', 'rejected', 'dashboard')
    resolveApproval('n2', 'approved', 'dashboard')
    expireTimedOutApprovals()
    resolveApproval('n4', 'approved', 'dashboard')
    expect(consumeApproval({ id: 'n4', contentHash: HASH, consumer: 't', windowSeconds: WINDOW }).ok).toBe(true)
    expect(resolveApprovalFromTelegram({ id: 'n5', status: 'rejected', ownerId: OWNER, messageId: MSG, nonceHash: t.rejectHash, nowS: NOW }).ok).toBe(true)
    gateConsume('n2', NOW)
    expect(clearSpentEmailPayloads(WINDOW, NOW)).toBe(0)
    for (const id of ['n1', 'n2', 'n3', 'n4', 'n5']) expect(payloadOf(id)).toBeNull()
  })
})

describe('clearSpentEmailPayloads: rows closed outside db.ts', () => {
  it('clears a letter the Python gate consumed, and is idempotent', () => {
    make('g1')
    resolveApproval('g1', 'approved', 'dashboard')
    gateConsume('g1', NOW)
    expect(clearSpentEmailPayloads(WINDOW, NOW)).toBe(1)
    expect(payloadOf('g1')).toBe(CLEARED_EMAIL_PAYLOAD)
    expect(clearSpentEmailPayloads(WINDOW, NOW)).toBe(0)
  })

  it('keeps an approved, unconsumed letter inside the window and clears it past the window', () => {
    make('w1')
    resolveApproval('w1', 'approved', 'dashboard')
    const resolvedAt = getApproval('w1')!.resolved_at!
    expect(clearSpentEmailPayloads(WINDOW, resolvedAt + WINDOW)).toBe(0)
    expect(payloadOf('w1')).toBe(LETTER)
    expect(clearSpentEmailPayloads(WINDOW, resolvedAt + WINDOW + 1)).toBe(1)
    expect(payloadOf('w1')).toBe(CLEARED_EMAIL_PAYLOAD)
  })

  it('clears a rejected or timed-out row whose payload was kept by older code; never touches a pending row', () => {
    make('o1'); make('o2'); make('o3')
    getDb().prepare("UPDATE approvals SET status = 'rejected', resolved_at = ? WHERE id = 'o1'").run(NOW)
    getDb().prepare("UPDATE approvals SET status = 'timeout', resolved_at = ? WHERE id = 'o2'").run(NOW)
    expect(clearSpentEmailPayloads(WINDOW, NOW)).toBe(2)
    expect(payloadOf('o1')).toBe(CLEARED_EMAIL_PAYLOAD)
    expect(payloadOf('o2')).toBe(CLEARED_EMAIL_PAYLOAD)
    expect(payloadOf('o3')).toBe(LETTER)
  })
})

describe('clearSpentEmailPayloads: only envelope_v 1 payloads', () => {
  // Rows from older requesters: same category, spent in every way the sweep
  // looks at, but their payload is not the helper's envelope.
  const LEGACY_PAYLOADS = [
    JSON.stringify({ to: ['ugyfel@example.com'], cc: 'colleague@example.com', text: 'Tisztelt Ügyfél' }),
    JSON.stringify({ envelope_v: 2, to: ['a@example.com'], text: 'x' }),
    JSON.stringify({ envelope_v: '1', to: ['a@example.com'], text: 'x' }),
    JSON.stringify([{ envelope_v: 1 }]),
    'nem json {',
    '',
  ]

  it('leaves a spent email_send row with a non-envelope payload untouched', () => {
    LEGACY_PAYLOADS.forEach((payload, i) => {
      for (const [suffix, status, consumed] of [['c', 'approved', NOW], ['w', 'approved', null], ['r', 'rejected', null], ['t', 'timeout', null]] as const) {
        const id = `legacy-${i}-${suffix}`
        make(id, { payload })
        getDb().prepare('UPDATE approvals SET status = ?, resolved_at = ?, consumed_at = ? WHERE id = ?')
          .run(status, NOW - 10 * WINDOW, consumed, id)
      }
    })
    make('env-1')
    getDb().prepare("UPDATE approvals SET status = 'approved', resolved_at = ?, consumed_at = ? WHERE id = 'env-1'").run(NOW - 10 * WINDOW, NOW)
    expect(clearSpentEmailPayloads(WINDOW, NOW)).toBe(1)
    expect(payloadOf('env-1')).toBe(CLEARED_EMAIL_PAYLOAD)
    LEGACY_PAYLOADS.forEach((payload, i) => {
      for (const suffix of ['c', 'w', 'r', 't']) expect(payloadOf(`legacy-${i}-${suffix}`)).toBe(payload)
    })
    expect(clearSpentEmailPayloads(WINDOW, NOW)).toBe(0)
  })
})

describe('transitions clear only envelope_v 1 payloads', () => {
  const OLD_FORMATS = [
    JSON.stringify({ to: ['ugyfel@example.com'], cc: 'colleague@example.com', text: 'Tisztelt Ügyfél' }),
    JSON.stringify({ envelope_v: 2, to: ['a@example.com'], text: 'x' }),
    JSON.stringify({ envelope_v: '1', to: ['a@example.com'], text: 'x' }),
    'nem json {',
    '',
  ]

  it('legacy reject, legacy timeout, the timeout sweep and consume keep an old-format email_send payload byte for byte', () => {
    OLD_FORMATS.forEach((payload, i) => {
      make(`or-${i}`, { payload }); make(`ot-${i}`, { payload }); make(`oe-${i}`, { payload, timeoutAt: NOW - 5 })
      make(`oc-${i}`, { payload })
      resolveApproval(`or-${i}`, 'rejected', 'dashboard')
      resolveApproval(`ot-${i}`, 'timeout', 'dashboard')
      resolveApproval(`oc-${i}`, 'approved', 'dashboard')
    })
    expect(expireTimedOutApprovals()).toBe(OLD_FORMATS.length)
    OLD_FORMATS.forEach((payload, i) => {
      expect(consumeApproval({ id: `oc-${i}`, contentHash: HASH, consumer: 't', windowSeconds: WINDOW }).ok).toBe(true)
      for (const p of ['or', 'ot', 'oe', 'oc']) expect(payloadOf(`${p}-${i}`)).toBe(payload)
    })
    expect(getApproval('or-0')!.status).toBe('rejected')
    expect(getApproval('oe-0')!.status).toBe('timeout')
  })

  it('the Telegram reject button keeps an old-format payload byte for byte', () => {
    const t = bound('ob-1', OLD_FORMATS[0])
    expect(resolveApprovalFromTelegram({ id: 'ob-1', status: 'rejected', ownerId: OWNER, messageId: MSG, nonceHash: t.rejectHash, nowS: NOW }).ok).toBe(true)
    expect(getApproval('ob-1')).toMatchObject({ status: 'rejected', action_payload: OLD_FORMATS[0] })
  })
})

describe('other categories keep the legacy behaviour', () => {
  it('reject, timeout, approve, expiry and the spent sweep never touch a non-email_send payload', () => {
    make('x1', { category: 'data_delete', payload: OTHER })
    make('x2', { category: 'data_delete', payload: OTHER })
    make('x3', { category: 'email_standing_recipient', payload: OTHER })
    make('x4', { category: 'data_delete', payload: OTHER, timeoutAt: NOW - 5 })
    resolveApproval('x1', 'rejected', 'dashboard')
    resolveApproval('x2', 'timeout', 'dashboard')
    resolveApproval('x3', 'approved', 'dashboard')
    expect(expireTimedOutApprovals()).toBe(1)
    getDb().prepare("UPDATE approvals SET consumed_at = ? WHERE id = 'x3'").run(NOW)
    expect(clearSpentEmailPayloads(WINDOW, NOW + 10 * WINDOW)).toBe(0)
    for (const id of ['x1', 'x2', 'x3', 'x4']) expect(payloadOf(id)).toBe(OTHER)
  })

  it('a spent letter: the list read hands out the marker as payload, the BCC stays only in action_description', () => {
    createApproval({
      id: 'l1', agent_id: 'marveen', category: 'email_send', action_payload: LETTER, content_hash: HASH,
      action_description: 'Levél: ugyfel@example.com | BCC: rejtett@example.com', timeout_at: NOW + 600,
    })
    resolveApproval('l1', 'rejected', 'dashboard')
    const row = listApprovals({ category: 'email_send' }).find(a => a.id === 'l1')!
    expect(row.action_payload).toBe(CLEARED_EMAIL_PAYLOAD)
    expect(row.action_payload).not.toContain('rejtett@example.com')
    // Not cleared: the description is untouched (documented).
    expect(row.action_description).toContain('BCC: rejtett@example.com')
  })

  it('a non-email_send row with an envelope_v 1 payload is never cleared, on any path', () => {
    for (const id of ['d1', 'd2', 'd3', 'd4']) make(id, { category: 'data_delete', timeoutAt: id === 'd3' ? NOW - 5 : NOW + 600 })
    resolveApproval('d1', 'rejected', 'dashboard')
    resolveApproval('d2', 'timeout', 'dashboard')
    expect(expireTimedOutApprovals()).toBe(1)
    resolveApproval('d4', 'approved', 'dashboard')
    getDb().prepare("UPDATE approvals SET consumed_at = ? WHERE id = 'd4'").run(NOW)
    expect(clearSpentEmailPayloads(WINDOW, NOW + 10 * WINDOW)).toBe(0)
    for (const id of ['d1', 'd2', 'd3', 'd4']) expect(payloadOf(id)).toBe(LETTER)
  })
})
