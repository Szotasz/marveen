import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import {
  initDatabase, getDb, createApproval, getApproval, listApprovals, resolveApproval,
  expireTimedOutApprovals, consumeApproval, setApprovalTelegramMessageId,
  setApprovalCallbackNonceHashes, resolveApprovalFromTelegram, isOwnerVerified,
} from '../db.js'

// The DB side of the Telegram approve/reject buttons. Each button
// carries its own one-time nonce; the row keeps only the two sha256s,
// and a press decides the approval through ONE conditional UPDATE that also
// checks the deadline, the stored message id and the hash of THAT decision's
// nonce, then clears both hashes.
const HASH = 'ab'.repeat(32)
const OWNER = '1000000001'
const MSG = 4242
const NOW = Math.floor(Date.now() / 1000)

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')
const newNonce = () => randomBytes(16).toString('base64url')
const HASH_COLUMNS = ['callback_nonce_hash_approve', 'callback_nonce_hash_reject']
const storedHashes = (id: string) =>
  getDb().prepare('SELECT callback_nonce_hash_approve AS approved, callback_nonce_hash_reject AS rejected FROM approvals WHERE id = ?')
    .get(id) as { approved: string | null; rejected: string | null } | undefined
const unbound = { approved: null, rejected: null }
const twoHashes = () => ({ approved: sha(newNonce()), rejected: sha(newNonce()) })

function pending(id: string, opts: { category?: string; hash?: string | null; timeoutAt?: number | null } = {}) {
  return createApproval({
    id,
    agent_id: 'marveen',
    category: opts.category ?? 'email_send',
    action_description: 'x',
    content_hash: opts.hash === undefined ? HASH : opts.hash,
    timeout_at: opts.timeoutAt === undefined ? NOW + 600 : opts.timeoutAt,
  })
}

// A pending approval with its buttons bound to it, the way the notifier
// leaves it: both nonce hashes first, then the message id of the button
// message. `nonceHash` is the approve button's, `rejectHash` the reject one's.
function bound(id: string, opts: { timeoutAt?: number } = {}) {
  pending(id, { timeoutAt: opts.timeoutAt })
  const nonce = newNonce()
  const rejectNonce = newNonce()
  expect(setApprovalCallbackNonceHashes(id, { approved: sha(nonce), rejected: sha(rejectNonce) })).toBe(true)
  expect(setApprovalTelegramMessageId(id, MSG)).toBe(true)
  return { nonce, nonceHash: sha(nonce), rejectNonce, rejectHash: sha(rejectNonce), hashes: { approved: sha(nonce), rejected: sha(rejectNonce) } }
}

function press(id: string, nonceHash: string, over: Partial<Parameters<typeof resolveApprovalFromTelegram>[0]> = {}) {
  return resolveApprovalFromTelegram({ id, status: 'approved', ownerId: OWNER, messageId: MSG, nonceHash, nowS: NOW, ...over })
}

beforeEach(() => {
  initDatabase(':memory:')
})

describe('migration', () => {
  let dir: string | null = null
  afterEach(() => {
    initDatabase(':memory:') // release the file handle before removing it
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = null
  })

  it('adds both nonce-hash columns to an existing pre-button DB, keeps its rows, and is a no-op the second time', () => {
    dir = mkdtempSync(join(tmpdir(), 'approvals-nonce-mig-'))
    const file = join(dir, 'legacy.db')
    // The approvals table as it was first created, before any later column.
    const legacy = new Database(file)
    legacy.exec(`
      CREATE TABLE approvals (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, category TEXT NOT NULL,
        action_description TEXT NOT NULL, action_payload TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','timeout')),
        timeout_at INTEGER, telegram_message_id INTEGER,
        requested_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
        resolved_at INTEGER, resolved_by TEXT
      )
    `)
    legacy.prepare(`INSERT INTO approvals (id, agent_id, category, action_description, timeout_at, telegram_message_id) VALUES ('old-1', 'marveen', 'email_send', 'old row', ?, 77)`).run(NOW + 600)
    legacy.close()

    initDatabase(file)
    initDatabase(file)
    const cols = (getDb().prepare('PRAGMA table_info(approvals)').all() as { name: string }[]).map(c => c.name)
    for (const col of HASH_COLUMNS) expect(cols.filter(c => c === col)).toHaveLength(1)
    expect(cols).not.toContain('callback_nonce_hash')
    expect(getApproval('old-1')).toMatchObject({ id: 'old-1', status: 'pending', telegram_message_id: 77, content_hash: null })
    expect(storedHashes('old-1')).toEqual(unbound)
  })
})

describe('approval reads never carry a nonce hash', () => {
  it('getApproval returns exactly the table columns minus the two nonce-hash columns, in table order', () => {
    // Pins the public column list against the table: a column added later must
    // be listed (or left out) on purpose.
    bound('p1')
    const tableCols = (getDb().prepare('PRAGMA table_info(approvals)').all() as { name: string }[]).map(c => c.name)
    for (const col of HASH_COLUMNS) expect(tableCols).toContain(col)
    expect(Object.keys(getApproval('p1')!)).toEqual(tableCols.filter(c => !HASH_COLUMNS.includes(c)))
  })

  it('no create, get, list, consume or Telegram-resolve result has the keys or a hash value', () => {
    const created = pending('p2')
    const { nonce, nonceHash, rejectNonce, rejectHash } = bound('p3')
    const refused = press('p3', sha('wrong'))
    const results: unknown[] = [
      created,
      getApproval('p3'),
      ...listApprovals({}),
      ...listApprovals({ status: 'pending' }),
      refused.approval,
    ]
    const ok = press('p3', nonceHash)
    expect(ok.ok).toBe(true)
    results.push(ok.approval, consumeApproval({ id: 'p3', contentHash: HASH, consumer: 't', windowSeconds: 1800, nowS: NOW }).approval)
    for (const r of results) {
      expect(r).toBeTruthy()
      for (const col of HASH_COLUMNS) expect(Object.keys(r as object)).not.toContain(col)
      const s = JSON.stringify(r)
      for (const secret of [nonce, nonceHash, rejectNonce, rejectHash]) expect(s).not.toContain(secret)
    }
    expect(JSON.stringify(refused)).not.toContain(nonceHash)
    expect(JSON.stringify(refused)).not.toContain(rejectHash)
  })

  it('the raw nonces are never stored: only their sha256s land in the row', () => {
    const nonce = newNonce()
    const rejectNonce = newNonce()
    pending('p4')
    expect(setApprovalCallbackNonceHashes('p4', { approved: sha(nonce), rejected: sha(rejectNonce) })).toBe(true)
    const raw = getDb().prepare('SELECT * FROM approvals WHERE id = ?').get('p4') as Record<string, unknown>
    expect(raw.callback_nonce_hash_approve).toBe(sha(nonce))
    expect(raw.callback_nonce_hash_reject).toBe(sha(rejectNonce))
    expect(Object.values(raw).some(v => typeof v === 'string' && (v.includes(nonce) || v.includes(rejectNonce)))).toBe(false)
  })
})

describe('setApprovalCallbackNonceHashes', () => {
  it('binds both at once, once: the second call is refused and the stored hashes do not change', () => {
    pending('n1')
    const a = twoHashes()
    expect(setApprovalCallbackNonceHashes('n1', a)).toBe(true)
    expect(setApprovalCallbackNonceHashes('n1', twoHashes())).toBe(false)
    expect(storedHashes('n1')).toEqual(a)
  })

  it('refuses anything that is not a lowercase sha256 hex (a raw nonce, upper case, empty) on either side and stores nothing', () => {
    pending('n2')
    const good = sha(newNonce())
    for (const bad of [newNonce(), HASH.toUpperCase(), '', 'ab'.repeat(31), 'ab'.repeat(33), ` ${HASH}`, `${HASH}\n`, null, undefined, 42]) {
      expect(setApprovalCallbackNonceHashes('n2', { approved: bad as string, rejected: good })).toBe(false)
      expect(setApprovalCallbackNonceHashes('n2', { approved: good, rejected: bad as string })).toBe(false)
    }
    expect(setApprovalCallbackNonceHashes('n2', null as unknown as { approved: string; rejected: string })).toBe(false)
    expect(storedHashes('n2')).toEqual(unbound)
  })

  it('refuses ONE hash for both buttons: each button must prove its own press', () => {
    pending('n8')
    const h = sha(newNonce())
    expect(setApprovalCallbackNonceHashes('n8', { approved: h, rejected: h })).toBe(false)
    expect(storedHashes('n8')).toEqual(unbound)
  })

  it('refuses a row whose button message is already stamped', () => {
    pending('n3')
    expect(setApprovalTelegramMessageId('n3', MSG)).toBe(true)
    expect(setApprovalCallbackNonceHashes('n3', twoHashes())).toBe(false)
    expect(storedHashes('n3')).toEqual(unbound)
  })

  it('refuses a row with either hash already set (a half-bound row is not re-bound)', () => {
    pending('n9')
    getDb().prepare('UPDATE approvals SET callback_nonce_hash_reject = ? WHERE id = ?').run(HASH, 'n9')
    expect(setApprovalCallbackNonceHashes('n9', twoHashes())).toBe(false)
    expect(storedHashes('n9')).toEqual({ approved: null, rejected: HASH })
  })

  it('refuses a row a button could never decide: resolved, not email_send, no content anchor, no deadline, unknown', () => {
    pending('n4'); resolveApproval('n4', 'rejected', 'dashboard')
    pending('n5', { category: 'kanban_move' })
    pending('n6', { hash: null })
    pending('n7', { timeoutAt: null })
    for (const id of ['n4', 'n5', 'n6', 'n7', 'nope']) {
      expect(setApprovalCallbackNonceHashes(id, twoHashes())).toBe(false)
    }
    for (const id of ['n4', 'n5', 'n6', 'n7']) expect(storedHashes(id)).toEqual(unbound)
  })
})

describe('setApprovalTelegramMessageId: the first stamp wins', () => {
  it('a second stamp is refused and the stored id stays', () => {
    pending('m1')
    expect(setApprovalTelegramMessageId('m1', 100)).toBe(true)
    expect(setApprovalTelegramMessageId('m1', 200)).toBe(false)
    expect(getApproval('m1')!.telegram_message_id).toBe(100)
  })

  it('an unknown id is refused', () => {
    expect(setApprovalTelegramMessageId('nope', 100)).toBe(false)
  })
})

describe('resolveApprovalFromTelegram', () => {
  it('approve: one UPDATE sets status, resolved_at, the owner attribution, and clears BOTH nonce hashes', () => {
    const { nonceHash } = bound('t1')
    const r = press('t1', nonceHash)
    expect(r.ok).toBe(true)
    expect(r.reason).toBeUndefined()
    expect(r.approval).toMatchObject({
      id: 't1', status: 'approved', resolved_at: NOW, resolved_by: `owner:telegram:${OWNER}`, telegram_message_id: MSG,
    })
    expect(storedHashes('t1')).toEqual(unbound)
  })

  it('reject with the reject button\'s own nonce: status rejected, both hashes cleared', () => {
    const { rejectHash } = bound('t2')
    const r = press('t2', rejectHash, { status: 'rejected' })
    expect(r.ok).toBe(true)
    expect(getApproval('t2')).toMatchObject({ status: 'rejected', resolved_by: `owner:telegram:${OWNER}` })
    expect(storedHashes('t2')).toEqual(unbound)
  })

  it('the reject button\'s nonce cannot approve -- bad_nonce, still pending, both hashes kept; the approve nonce still approves', () => {
    const { nonceHash, rejectHash, hashes } = bound('t22')
    expect(press('t22', rejectHash, { status: 'approved' })).toMatchObject({ ok: false, reason: 'bad_nonce', approval: { status: 'pending' } })
    expect(getApproval('t22')).toMatchObject({ status: 'pending', resolved_by: null, resolved_at: null })
    expect(storedHashes('t22')).toEqual(hashes)
    expect(press('t22', nonceHash).ok).toBe(true)
  })

  it('the approve button\'s nonce cannot reject -- bad_nonce, still pending; the reject nonce still rejects', () => {
    const { nonceHash, rejectHash, hashes } = bound('t23')
    expect(press('t23', nonceHash, { status: 'rejected' })).toMatchObject({ ok: false, reason: 'bad_nonce', approval: { status: 'pending' } })
    expect(storedHashes('t23')).toEqual(hashes)
    expect(press('t23', rejectHash, { status: 'rejected' }).ok).toBe(true)
    expect(getApproval('t23')!.status).toBe('rejected')
  })

  it('a second press with either nonce is already_resolved and changes nothing (approve then approve, approve then reject)', () => {
    const { nonceHash, rejectHash } = bound('t3')
    expect(press('t3', nonceHash).ok).toBe(true)
    const after = getApproval('t3')
    expect(press('t3', nonceHash, { nowS: NOW + 5 })).toMatchObject({ ok: false, reason: 'already_resolved', approval: { status: 'approved' } })
    expect(press('t3', rejectHash, { status: 'rejected', nowS: NOW + 5 })).toMatchObject({ ok: false, reason: 'already_resolved' })
    expect(press('t3', nonceHash, { status: 'rejected', nowS: NOW + 5 })).toMatchObject({ ok: false, reason: 'already_resolved' })
    expect(getApproval('t3')).toEqual(after)
  })

  it('a legacy resolve first: the button press is already_resolved and the legacy decision stands', () => {
    const { nonceHash } = bound('t4')
    expect(resolveApproval('t4', 'rejected', 'dashboard')).toBe(true)
    expect(press('t4', nonceHash)).toMatchObject({ ok: false, reason: 'already_resolved', approval: { status: 'rejected', resolved_by: 'dashboard' } })
    expect(getApproval('t4')!.status).toBe('rejected')
  })

  it('a button press first: a later legacy resolve is refused and the button decision stands', () => {
    const { nonceHash } = bound('t5')
    expect(press('t5', nonceHash).ok).toBe(true)
    expect(resolveApproval('t5', 'rejected', 'dashboard', 9999)).toBe(false)
    expect(getApproval('t5')).toMatchObject({ status: 'approved', resolved_by: `owner:telegram:${OWNER}`, telegram_message_id: MSG })
  })

  it('a past deadline is expired WITHOUT the sweeper: timeout_at == now and timeout_at < now both refuse, the row stays pending', () => {
    const a = bound('t6', { timeoutAt: NOW })
    const b = bound('t7', { timeoutAt: NOW - 1 })
    expect(press('t6', a.nonceHash)).toMatchObject({ ok: false, reason: 'expired', approval: { status: 'pending' } })
    expect(press('t7', b.nonceHash)).toMatchObject({ ok: false, reason: 'expired' })
    expect(getApproval('t6')!.status).toBe('pending')
    expect(storedHashes('t6')).toEqual(a.hashes)
  })

  it('one second before the deadline still decides', () => {
    const { nonceHash } = bound('t8', { timeoutAt: NOW + 1 })
    expect(press('t8', nonceHash).ok).toBe(true)
  })

  it('after the sweeper (status timeout) the press is expired too', () => {
    const { nonceHash } = bound('t9', { timeoutAt: NOW - 10 })
    expect(expireTimedOutApprovals()).toBe(1)
    expect(press('t9', nonceHash)).toMatchObject({ ok: false, reason: 'expired', approval: { status: 'timeout' } })
  })

  it('a wrong message id is message_mismatch; the stored id is not overwritten and the right press still works', () => {
    const { nonceHash, hashes } = bound('t10')
    expect(press('t10', nonceHash, { messageId: MSG + 1 })).toMatchObject({ ok: false, reason: 'message_mismatch', approval: { status: 'pending' } })
    expect(getApproval('t10')!.telegram_message_id).toBe(MSG)
    expect(storedHashes('t10')).toEqual(hashes)
    expect(press('t10', nonceHash).ok).toBe(true)
  })

  it('a wrong nonce is bad_nonce; the row stays pending with its hash, and the right nonce still works', () => {
    const { nonceHash, hashes } = bound('t11')
    expect(press('t11', sha(newNonce()))).toMatchObject({ ok: false, reason: 'bad_nonce', approval: { status: 'pending' } })
    expect(storedHashes('t11')).toEqual(hashes)
    expect(press('t11', nonceHash).ok).toBe(true)
  })

  it('no stamp, no nonce, or neither: not_bound', () => {
    pending('t12') // neither
    pending('t13'); setApprovalTelegramMessageId('t13', MSG) // stamp, no nonce
    pending('t14'); const h = sha(newNonce()); setApprovalCallbackNonceHashes('t14', { approved: h, rejected: sha(newNonce()) }) // nonces, no stamp
    expect(press('t12', h)).toMatchObject({ ok: false, reason: 'not_bound' })
    expect(press('t13', h)).toMatchObject({ ok: false, reason: 'not_bound' })
    expect(press('t14', h)).toMatchObject({ ok: false, reason: 'not_bound' })
    for (const id of ['t12', 't13', 't14']) expect(getApproval(id)!.status).toBe('pending')
  })

  it('a half-bound row: the pressed button without a hash is not_bound, even with the other button\'s hash in hand', () => {
    const h = sha(newNonce())
    pending('t24')
    getDb().prepare('UPDATE approvals SET callback_nonce_hash_approve = ?, telegram_message_id = ? WHERE id = ?').run(h, MSG, 't24')
    expect(press('t24', h, { status: 'rejected' })).toMatchObject({ ok: false, reason: 'not_bound', approval: { status: 'pending' } })
    expect(getApproval('t24')!.status).toBe('pending')
  })

  it('a row with no content anchor or no deadline cannot be decided by a button (not_bound)', () => {
    // Set up past the binder's own checks, to prove the UPDATE refuses by itself.
    const h = sha(newNonce())
    pending('t15', { hash: null })
    pending('t16', { timeoutAt: null })
    for (const id of ['t15', 't16']) {
      getDb().prepare('UPDATE approvals SET callback_nonce_hash_approve = ?, callback_nonce_hash_reject = ?, telegram_message_id = ? WHERE id = ?').run(h, sha(newNonce()), MSG, id)
      expect(press(id, h)).toMatchObject({ ok: false, reason: 'not_bound', approval: { status: 'pending' } })
    }
  })

  it('a category other than email_send is wrong_category, even with a matching nonce and message id', () => {
    const h = sha(newNonce())
    pending('t17', { category: 'kanban_move' })
    getDb().prepare('UPDATE approvals SET callback_nonce_hash_approve = ?, callback_nonce_hash_reject = ?, telegram_message_id = ? WHERE id = ?').run(h, sha(newNonce()), MSG, 't17')
    expect(press('t17', h)).toMatchObject({ ok: false, reason: 'wrong_category' })
    expect(getApproval('t17')!.status).toBe('pending')
  })

  it('an unknown id is not_found, without an approval', () => {
    const r = press('nope', sha(newNonce()))
    expect(r).toEqual({ ok: false, reason: 'not_found', approval: undefined })
  })

  it('malformed arguments are bad_request and touch nothing', () => {
    const { nonceHash, hashes } = bound('t18')
    const bads: Partial<Parameters<typeof resolveApprovalFromTelegram>[0]>[] = [
      { ownerId: '0' }, { ownerId: '-5' }, { ownerId: '01' }, { ownerId: '' }, { ownerId: 'abc' },
      { ownerId: '12345678901234567' }, { ownerId: `${OWNER} ` }, { ownerId: 1000000001 as unknown as string },
      { messageId: 0 }, { messageId: -1 }, { messageId: 1.5 }, { messageId: Number.NaN }, { messageId: String(MSG) as unknown as number },
      { nonceHash: 'x' }, { nonceHash: nonceHash.toUpperCase() }, { nonceHash: '' }, { nonceHash: newNonce() },
      { status: 'timeout' as unknown as 'approved' }, { status: 'pending' as unknown as 'approved' },
    ]
    for (const over of bads) expect(press('t18', nonceHash, over)).toEqual({ ok: false, reason: 'bad_request' })
    expect(getApproval('t18')).toMatchObject({ status: 'pending', resolved_by: null, telegram_message_id: MSG })
    expect(storedHashes('t18')).toEqual(hashes)
  })

  it('the attribution is built from the owner id only', () => {
    const { nonceHash } = bound('t19')
    expect(press('t19', nonceHash, { ownerId: '42' }).approval!.resolved_by).toBe('owner:telegram:42')
  })

  it('a Telegram approval is consumable once by the unchanged consume path; a Telegram rejection is not', () => {
    const a = bound('t20')
    const b = bound('t21')
    expect(press('t20', a.nonceHash).ok).toBe(true)
    expect(press('t21', b.rejectHash, { status: 'rejected' }).ok).toBe(true)
    expect(consumeApproval({ id: 't20', contentHash: HASH, consumer: 't', windowSeconds: 1800, nowS: NOW + 1 }).ok).toBe(true)
    expect(consumeApproval({ id: 't20', contentHash: HASH, consumer: 't', windowSeconds: 1800, nowS: NOW + 2 })).toMatchObject({ ok: false, reason: 'already_consumed' })
    expect(consumeApproval({ id: 't21', contentHash: HASH, consumer: 't', windowSeconds: 1800, nowS: NOW + 1 })).toMatchObject({ ok: false, reason: 'not_approved' })
  })
})

// The trace of the owner's own button decision (approval_owner_resolutions) and
// isOwnerVerified, which reads it.
describe('isOwnerVerified: only the owner\'s button press leaves the trace', () => {
  const STRANGER = '2000000002'
  const traceOf = (id: string) =>
    getDb().prepare('SELECT owner_id, status, nonce_hash, content_hash, resolved_at FROM approval_owner_resolutions WHERE approval_id = ?').get(id)

  it('true after the owner\'s approve button, for that owner only; the trace names owner, status, nonce hash, content hash, time', () => {
    const { nonceHash } = bound('o1')
    expect(isOwnerVerified('o1')).toBe(false)
    expect(press('o1', nonceHash).ok).toBe(true)
    expect(isOwnerVerified('o1')).toBe(true)
    expect(isOwnerVerified('o1', OWNER)).toBe(true)
    expect(isOwnerVerified('o1', STRANGER)).toBe(false)
    expect(traceOf('o1')).toEqual({ owner_id: OWNER, status: 'approved', nonce_hash: nonceHash, content_hash: HASH, resolved_at: NOW })
  })

  it('false after the owner\'s reject button (the trace says rejected)', () => {
    const { rejectHash } = bound('o2')
    expect(press('o2', rejectHash, { status: 'rejected' }).ok).toBe(true)
    expect(traceOf('o2')).toMatchObject({ owner_id: OWNER, status: 'rejected' })
    expect(isOwnerVerified('o2')).toBe(false)
    expect(isOwnerVerified('o2', OWNER)).toBe(false)
  })

  it('false after a legacy resolve, whatever attribution it claims: no trace, no verification', () => {
    pending('o3')
    expect(resolveApproval('o3', 'approved', `owner:telegram:${OWNER}`)).toBe(true)
    expect(getApproval('o3')).toMatchObject({ status: 'approved', resolved_by: `owner:telegram:${OWNER}` })
    expect(traceOf('o3')).toBeUndefined()
    expect(isOwnerVerified('o3')).toBe(false)
    expect(isOwnerVerified('o3', OWNER)).toBe(false)
  })

  it('false for a row approved as owner:telegram: by a direct write, i.e. before the trace existed', () => {
    pending('o4')
    getDb().prepare("UPDATE approvals SET status = 'approved', resolved_by = ?, resolved_at = ? WHERE id = ?")
      .run(`owner:telegram:${OWNER}`, NOW, 'o4')
    expect(isOwnerVerified('o4')).toBe(false)
    expect(isOwnerVerified('o4', OWNER)).toBe(false)
  })

  it('refused presses leave no trace; a later valid one writes exactly one', () => {
    const { nonceHash, rejectHash } = bound('o5')
    expect(press('o5', rejectHash).reason).toBe('bad_nonce')
    expect(press('o5', nonceHash, { messageId: MSG + 1 }).reason).toBe('message_mismatch')
    expect(press('o5', nonceHash, { nowS: NOW + 601 }).reason).toBe('expired')
    expect(traceOf('o5')).toBeUndefined()
    expect(press('o5', nonceHash).ok).toBe(true)
    expect(press('o5', nonceHash, { ownerId: STRANGER }).reason).toBe('already_resolved')
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM approval_owner_resolutions WHERE approval_id = ?').get('o5')).toEqual({ n: 1 })
    expect(traceOf('o5')).toMatchObject({ owner_id: OWNER })
  })

  it('the trace is written in the decision\'s transaction: a failing trace write rolls the decision back', () => {
    const { nonceHash, hashes } = bound('o6')
    getDb().prepare(`INSERT INTO approval_owner_resolutions (approval_id, owner_id, status, nonce_hash, content_hash, resolved_at)
      VALUES ('o6', ?, 'approved', ?, ?, ?)`).run(OWNER, nonceHash, HASH, NOW)
    expect(() => press('o6', nonceHash)).toThrow()
    expect(getApproval('o6')).toMatchObject({ status: 'pending', resolved_by: null, resolved_at: null })
    expect(storedHashes('o6')).toEqual(hashes)
  })

  it('a verified approval stops being verified when the row no longer matches its trace', () => {
    for (const [id, change] of [
      ['o7a', "resolved_by = 'dashboard'"],
      ['o7b', `content_hash = '${'cd'.repeat(32)}'`],
      ['o7c', `resolved_at = ${NOW + 5}`],
      ['o7d', "status = 'rejected'"],
    ] as const) {
      const { nonceHash } = bound(id)
      expect(press(id, nonceHash).ok).toBe(true)
      expect(isOwnerVerified(id, OWNER)).toBe(true)
      getDb().prepare(`UPDATE approvals SET ${change} WHERE id = ?`).run(id)
      expect(isOwnerVerified(id, OWNER)).toBe(false)
    }
  })

  it('a trace naming a malformed owner id is never verified', () => {
    const { nonceHash } = bound('o8')
    expect(press('o8', nonceHash).ok).toBe(true)
    getDb().prepare("UPDATE approval_owner_resolutions SET owner_id = '0x1' WHERE approval_id = 'o8'").run()
    getDb().prepare("UPDATE approvals SET resolved_by = 'owner:telegram:0x1' WHERE id = 'o8'").run()
    expect(isOwnerVerified('o8')).toBe(false)
  })

  it('malformed arguments are false, an unknown id is false', () => {
    const { nonceHash } = bound('o9')
    expect(press('o9', nonceHash).ok).toBe(true)
    for (const bad of ['', 'nope', null, undefined, 7]) expect(isOwnerVerified(bad as unknown as string)).toBe(false)
    for (const bad of ['', '0', 'abc', '1 2', 42, null]) expect(isOwnerVerified('o9', bad as unknown as string)).toBe(false)
    expect(isOwnerVerified('o9', OWNER)).toBe(true)
  })

  it('no route and no module but db.ts names the trace table; db.ts inserts into it exactly once', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name)
        if (name === '__tests__' || name === 'node_modules') continue
        if (statSync(p).isDirectory()) walk(p)
        else if (/\.(ts|mjs|js)$/.test(name) && p !== join(root, 'db.ts') && readFileSync(p, 'utf-8').includes('approval_owner_resolutions')) offenders.push(p)
      }
    }
    walk(root)
    expect(offenders).toEqual([])
    expect(readFileSync(join(root, 'db.ts'), 'utf-8').match(/INSERT INTO approval_owner_resolutions/g)).toHaveLength(1)
  })
})

describe('legacy paths are unchanged', () => {
  it('resolveApproval still overwrites telegram_message_id via COALESCE and leaves the nonce hashes alone', () => {
    const { hashes } = bound('l1')
    expect(resolveApproval('l1', 'approved', 'telegram_text', 9001)).toBe(true)
    expect(getApproval('l1')).toMatchObject({ status: 'approved', resolved_by: 'telegram_text', telegram_message_id: 9001 })
    expect(storedHashes('l1')).toEqual(hashes)
  })

  it('expireTimedOutApprovals still expires every pending past-due row, bound or not', () => {
    bound('l2', { timeoutAt: NOW - 5 })
    pending('l3', { timeoutAt: NOW - 5 })
    bound('l4', { timeoutAt: NOW + 600 })
    expect(expireTimedOutApprovals()).toBe(2)
    expect(getApproval('l2')!.status).toBe('timeout')
    expect(getApproval('l3')!.status).toBe('timeout')
    expect(getApproval('l4')!.status).toBe('pending')
  })
})
