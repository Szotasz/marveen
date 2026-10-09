import { describe, it, expect, beforeEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  initDatabase, getDb, createApproval, resolveApproval, getApproval, consumeApproval, listApprovalEvents,
} from '../db.js'
import { tryHandleApprovals, approvalWindowSeconds, isConsumerName, isMessageId } from '../web/routes/approvals.js'
import type { RouteContext } from '../web/routes/types.js'

// f2c5edb0: a sender the email approval gate cannot see (a script that mails
// from another host) consumes its approval on its own path, BEFORE the letter
// goes out, and sends only on a yes. One conditional write decides, so one
// approval can never authorize two sends -- the double send this card is about.
const ROOT = join(__dirname, '..', '..')
const HASH = 'ab'.repeat(32)
const OTHER = 'cd'.repeat(32)
const WINDOW = 1800

function approval(id: string, opts: { category?: string; hash?: string; status?: 'pending' | 'approved' | 'rejected' } = {}) {
  createApproval({ id, agent_id: 'agent-a', category: opts.category ?? 'email_send', action_description: 'x', content_hash: opts.hash ?? HASH })
  const status = opts.status ?? 'approved'
  if (status !== 'pending') resolveApproval(id, status, 'owner-a-tg-101')
  return getApproval(id)!
}

function consumeCtx(id: string, body: unknown, raw?: string): { ctx: RouteContext; out: { status: number; body: any } } {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const path = `/api/approvals/${id}/consume`
  const url = new URL(`http://localhost:3420${path}`)
  const bodyStr = raw ?? JSON.stringify(body)
  const req: any = {
    on(event: string, cb: (chunk?: Buffer) => void) {
      if (event === 'data') cb(Buffer.from(bodyStr))
      if (event === 'end') cb()
    },
  }
  return { ctx: { req, res, path, method: 'POST', url } as RouteContext, out }
}

beforeEach(() => {
  initDatabase(':memory:')
})

describe('consumeApproval (f2c5edb0)', () => {
  it('the first consume wins and records who consumed it and which letter', () => {
    approval('a1')
    const r = consumeApproval({ id: 'a1', contentHash: HASH, consumer: 'send-tool', messageId: '<m1@example.org>', windowSeconds: WINDOW })
    expect(r.ok).toBe(true)
    const row = getApproval('a1')!
    expect(row.consumed_at).not.toBeNull()
    expect(row.consumed_by).toBe('send-tool')
    expect(row.consumed_ref).toBe('<m1@example.org>')
    expect(listApprovalEvents('a1').map(e => [e.event, e.reason, e.actor, e.ref])).toEqual([['consumed', null, 'send-tool', '<m1@example.org>']])
  })

  it('a SECOND consume of the same approval is refused as already_consumed and changes nothing', () => {
    approval('a2')
    expect(consumeApproval({ id: 'a2', contentHash: HASH, consumer: 'send-tool', messageId: '<m1@example.org>', windowSeconds: WINDOW }).ok).toBe(true)
    const first = getApproval('a2')!
    const r = consumeApproval({ id: 'a2', contentHash: HASH, consumer: 'other-tool', messageId: '<m2@example.org>', windowSeconds: WINDOW, nowS: (first.consumed_at ?? 0) + 5 })
    expect(r).toMatchObject({ ok: false, reason: 'already_consumed' })
    const after = getApproval('a2')!
    expect([after.consumed_at, after.consumed_by, after.consumed_ref]).toEqual([first.consumed_at, 'send-tool', '<m1@example.org>'])
    expect(listApprovalEvents('a2').map(e => [e.event, e.reason, e.actor])).toEqual([
      ['consumed', null, 'send-tool'],
      ['consume_refused', 'already_consumed', 'other-tool'],
    ])
  })

  it('another letter (a different anchor) is refused and leaves the approval usable for its own letter', () => {
    approval('a3')
    expect(consumeApproval({ id: 'a3', contentHash: OTHER, consumer: 'send-tool', windowSeconds: WINDOW })).toMatchObject({ ok: false, reason: 'hash_mismatch' })
    expect(getApproval('a3')!.consumed_at).toBeNull()
    expect(consumeApproval({ id: 'a3', contentHash: HASH, consumer: 'send-tool', windowSeconds: WINDOW }).ok).toBe(true)
  })

  it('a pending or a rejected approval is refused as not_approved', () => {
    approval('a4p', { status: 'pending' })
    approval('a4r', { status: 'rejected' })
    expect(consumeApproval({ id: 'a4p', contentHash: HASH, consumer: 't', windowSeconds: WINDOW })).toMatchObject({ ok: false, reason: 'not_approved' })
    expect(consumeApproval({ id: 'a4r', contentHash: HASH, consumer: 't', windowSeconds: WINDOW })).toMatchObject({ ok: false, reason: 'not_approved' })
    expect(getApproval('a4p')!.consumed_at).toBeNull()
  })

  it('the window: the last second inside still passes, one second later is expired (the gate uses the same bound)', () => {
    const edge = approval('a5e')
    const late = approval('a5l')
    expect(consumeApproval({ id: 'a5e', contentHash: HASH, consumer: 't', windowSeconds: WINDOW, nowS: edge.resolved_at! + WINDOW }).ok).toBe(true)
    expect(consumeApproval({ id: 'a5l', contentHash: HASH, consumer: 't', windowSeconds: WINDOW, nowS: late.resolved_at! + WINDOW + 1 }))
      .toMatchObject({ ok: false, reason: 'expired' })
    expect(getApproval('a5l')!.consumed_at).toBeNull()
  })

  it('another category is refused as wrong_category', () => {
    approval('a6', { category: 'file_delete' })
    expect(consumeApproval({ id: 'a6', contentHash: HASH, consumer: 't', windowSeconds: WINDOW })).toMatchObject({ ok: false, reason: 'wrong_category' })
  })

  it('an unknown id is not_found and leaves no event', () => {
    expect(consumeApproval({ id: 'nope', contentHash: HASH, consumer: 't', windowSeconds: WINDOW })).toMatchObject({ ok: false, reason: 'not_found' })
    expect(listApprovalEvents('nope')).toEqual([])
  })

  it('a row the gate already consumed (consumed_at set, no consumer) is refused here: the two paths exclude each other', () => {
    approval('a7')
    // What scripts/hooks/email-approval-gate.py find_and_consume writes on an allowed send.
    getDb().prepare('UPDATE approvals SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL').run(Math.floor(Date.now() / 1000), 'a7')
    expect(consumeApproval({ id: 'a7', contentHash: HASH, consumer: 'send-tool', windowSeconds: WINDOW })).toMatchObject({ ok: false, reason: 'already_consumed' })
    expect(getApproval('a7')!.consumed_by).toBeNull()
  })
})

describe('POST /api/approvals/:id/consume (f2c5edb0)', () => {
  it('200 for the first call, 409 already_consumed for the second, and the 409 names the first consumer', async () => {
    approval('h1')
    const c1 = consumeCtx('h1', { content_hash: HASH, consumer: 'send-tool', message_id: '<m1@example.org>' })
    expect(await tryHandleApprovals(c1.ctx)).toBe(true)
    expect(c1.out.status).toBe(200)
    expect(c1.out.body.ok).toBe(true)
    expect(c1.out.body.approval.consumed_ref).toBe('<m1@example.org>')
    const c2 = consumeCtx('h1', { content_hash: HASH, consumer: 'send-tool', message_id: '<m2@example.org>' })
    await tryHandleApprovals(c2.ctx)
    expect(c2.out.status).toBe(409)
    expect(c2.out.body).toMatchObject({ ok: false, reason: 'already_consumed', approval: { id: 'h1', consumed_by: 'send-tool', consumed_ref: '<m1@example.org>' } })
  })

  it('two concurrent calls on one approval: exactly one 200', async () => {
    approval('h2')
    const a = consumeCtx('h2', { content_hash: HASH, consumer: 'tool-a' })
    const b = consumeCtx('h2', { content_hash: HASH, consumer: 'tool-b' })
    await Promise.all([tryHandleApprovals(a.ctx), tryHandleApprovals(b.ctx)])
    expect([a.out.status, b.out.status].sort()).toEqual([200, 409])
    expect(listApprovalEvents('h2').filter(e => e.event === 'consumed')).toHaveLength(1)
  })

  it('a bad body is 400 and consumes nothing', async () => {
    approval('h3')
    const bodies: Array<[unknown, string?]> = [
      [{ content_hash: 'AB'.repeat(32), consumer: 't' }],
      [{ content_hash: HASH }],
      [{ content_hash: HASH, consumer: '   ' }],
      [{ content_hash: HASH, consumer: 'x' + String.fromCharCode(7) }],
      [{ content_hash: HASH, consumer: 'x'.repeat(121) }],
      [{ content_hash: HASH, consumer: 't', message_id: 'm1@example.org' }],
      [{ content_hash: HASH, consumer: 't', message_id: '<a b@example.org>' }],
      [null, '{not json'],
    ]
    for (const [body, raw] of bodies) {
      const c = consumeCtx('h3', body, raw)
      await tryHandleApprovals(c.ctx)
      expect(c.out.status).toBe(400)
    }
    expect(getApproval('h3')!.consumed_at).toBeNull()
    expect(listApprovalEvents('h3')).toEqual([])
  })

  it('404 for an unknown approval', async () => {
    const c = consumeCtx('no-such-id', { content_hash: HASH, consumer: 't' })
    await tryHandleApprovals(c.ctx)
    expect(c.out.status).toBe(404)
    expect(c.out.body).toEqual({ ok: false, reason: 'not_found' })
  })

  it('the plain status poll still answers for the same id (the consume route does not shadow GET)', async () => {
    approval('h4')
    const out: { status: number; body: any } = { status: 0, body: null }
    const res: any = { writeHead(s: number) { out.status = s; return res }, end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) } }
    const path = '/api/approvals/h4'
    await tryHandleApprovals({ req: {} as any, res, path, method: 'GET', url: new URL(`http://localhost:3420${path}`) } as RouteContext)
    expect(out.status).toBe(200)
    expect(out.body).toMatchObject({ id: 'h4', consumed_by: null, consumed_ref: null })
  })
})

describe('validators and the shared window (f2c5edb0)', () => {
  it('the window follows EMAIL_APPROVAL_WINDOW_S like the gate, defaulting to 1800', () => {
    expect(approvalWindowSeconds({})).toBe(1800)
    expect(approvalWindowSeconds({ EMAIL_APPROVAL_WINDOW_S: '60' })).toBe(60)
    expect(approvalWindowSeconds({ EMAIL_APPROVAL_WINDOW_S: 'x' })).toBe(1800)
    expect(approvalWindowSeconds({ EMAIL_APPROVAL_WINDOW_S: '0' })).toBe(1800)
  })

  it('the gate and the endpoint carry the same default window (a drift here would let one path accept what the other calls stale)', () => {
    const gate = readFileSync(join(ROOT, 'scripts', 'hooks', 'email-approval-gate.py'), 'utf-8')
    const m = gate.match(/EMAIL_APPROVAL_WINDOW_S", "(\d+)"/)
    expect(m).not.toBeNull()
    expect(Number(m![1])).toBe(approvalWindowSeconds({}))
  })

  it('consumer and Message-Id validators', () => {
    expect(isConsumerName('send-tool')).toBe(true)
    expect(isConsumerName('')).toBe(false)
    expect(isConsumerName('a' + String.fromCharCode(127))).toBe(false)
    expect(isMessageId('<abc.def@example.org>')).toBe(true)
    expect(isMessageId('<a@b@example.org>')).toBe(false)
    expect(isMessageId('<' + 'a'.repeat(250) + '@example.org>')).toBe(false)
  })
})

describe('send-path helper (scripts/approval-consume.py, f2c5edb0)', () => {
  it('the python suite passes (one-shot, fail-closed exits, the caller sends exactly once)', () => {
    const res = spawnSync('python3', [join(ROOT, 'scripts', '__tests__', 'approval-consume.test.py')], {
      encoding: 'utf-8',
      timeout: 120_000,
    })
    if (res.status !== 0) {
      console.error(res.stdout)
      console.error(res.stderr)
    }
    expect(res.status).toBe(0)
  })
})
