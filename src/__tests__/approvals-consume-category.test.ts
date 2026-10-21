import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  initDatabase, getDb, createApproval, resolveApproval, getApproval, consumeApproval, consumeCategoryApproval,
  listApprovalEvents, CATEGORY_CONSUME_DEFAULT_WINDOW_S, CATEGORY_CONSUME_MAX_WINDOW_S,
} from '../db.js'
import { tryHandleApprovals, isCategoryKey, isConsumeRef, categoryWindowSeconds } from '../web/routes/approvals.js'
import type { RouteContext } from '../web/routes/types.js'

// Until now only email_send approvals were consumed by the server (and
// data_delete by the memory DELETE route). A tool acting on any other category
// could only check the row with GET /api/approvals/:id and keep its own
// "already used" list, so one approved row could authorize a second action
// (another tool, a lost log, a second checkout). The consume route now takes a
// category and consumes such a row once, in one conditional write.
const ROOT = join(__dirname, '..', '..')
const HASH = 'ab'.repeat(32)
const OTHER = 'cd'.repeat(32)
const CAT = 'ad_launch'

function approval(id: string, opts: { category?: string; hash?: string | null; status?: 'pending' | 'approved' | 'rejected' } = {}) {
  createApproval({
    id, agent_id: 'agent-a', category: opts.category ?? CAT, action_description: 'x',
    content_hash: opts.hash === undefined ? HASH : opts.hash,
  })
  const status = opts.status ?? 'approved'
  if (status !== 'pending') resolveApproval(id, status, 'owner-tg-101')
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

async function post(id: string, body: unknown, raw?: string) {
  const c = consumeCtx(id, body, raw)
  expect(await tryHandleApprovals(c.ctx)).toBe(true)
  return c.out
}

const W = CATEGORY_CONSUME_DEFAULT_WINDOW_S

beforeEach(() => {
  initDatabase(':memory:')
})

describe('consumeCategoryApproval', () => {
  it('the first consume wins; a REPLAY of the same approval is refused as already_consumed and changes nothing', () => {
    approval('c1')
    const r1 = consumeCategoryApproval({ id: 'c1', category: CAT, contentHash: HASH, consumer: 'launcher.py', ref: 'plan-1', windowSeconds: W })
    expect(r1.ok).toBe(true)
    const first = getApproval('c1')!
    expect(first.consumed_at).not.toBeNull()
    expect([first.consumed_by, first.consumed_ref]).toEqual(['launcher.py', 'plan-1'])
    const r2 = consumeCategoryApproval({ id: 'c1', category: CAT, contentHash: HASH, consumer: 'other-tool', ref: 'plan-2', windowSeconds: W, nowS: first.consumed_at! + 5 })
    expect(r2).toMatchObject({ ok: false, reason: 'already_consumed' })
    const after = getApproval('c1')!
    expect([after.consumed_at, after.consumed_by, after.consumed_ref]).toEqual([first.consumed_at, 'launcher.py', 'plan-1'])
    expect(listApprovalEvents('c1').map(e => [e.event, e.reason, e.actor, e.ref])).toEqual([
      ['consumed', null, 'launcher.py', 'plan-1'],
      ['consume_refused', 'already_consumed', 'other-tool', 'plan-2'],
    ])
  })

  it('an anchored row needs exactly its anchor: another hash or no hash is hash_mismatch and leaves the row usable', () => {
    approval('c2')
    expect(consumeCategoryApproval({ id: 'c2', category: CAT, contentHash: OTHER, consumer: 't', windowSeconds: W })).toMatchObject({ ok: false, reason: 'hash_mismatch' })
    expect(consumeCategoryApproval({ id: 'c2', category: CAT, contentHash: null, consumer: 't', windowSeconds: W })).toMatchObject({ ok: false, reason: 'hash_mismatch' })
    expect(getApproval('c2')!.consumed_at).toBeNull()
    expect(consumeCategoryApproval({ id: 'c2', category: CAT, contentHash: HASH, consumer: 't', windowSeconds: W }).ok).toBe(true)
  })

  it('an unanchored row (e.g. external_message) is consumed once by a caller that sends no hash, and never by one that sends a hash', () => {
    approval('c3', { category: 'external_message', hash: null })
    expect(consumeCategoryApproval({ id: 'c3', category: 'external_message', contentHash: HASH, consumer: 't', windowSeconds: W })).toMatchObject({ ok: false, reason: 'hash_mismatch' })
    expect(consumeCategoryApproval({ id: 'c3', category: 'external_message', contentHash: null, consumer: 't', windowSeconds: W }).ok).toBe(true)
    expect(consumeCategoryApproval({ id: 'c3', category: 'external_message', contentHash: null, consumer: 't', windowSeconds: W })).toMatchObject({ ok: false, reason: 'already_consumed' })
  })

  it('the category must match: a site_write approval cannot be spent as ad_launch (and vice versa)', () => {
    approval('c4', { category: 'site_write' })
    expect(consumeCategoryApproval({ id: 'c4', category: CAT, contentHash: HASH, consumer: 't', windowSeconds: W })).toMatchObject({ ok: false, reason: 'wrong_category' })
    expect(getApproval('c4')!.consumed_at).toBeNull()
    expect(consumeCategoryApproval({ id: 'c4', category: 'site_write', contentHash: HASH, consumer: 't', windowSeconds: W }).ok).toBe(true)
  })

  it('an email_send row is NEVER consumed here, not even when the caller names email_send: the letter path stays the only one', () => {
    approval('c5', { category: 'email_send' })
    expect(consumeCategoryApproval({ id: 'c5', category: 'email_send', contentHash: HASH, consumer: 't', windowSeconds: W })).toMatchObject({ ok: false, reason: 'wrong_category' })
    expect(consumeCategoryApproval({ id: 'c5', category: CAT, contentHash: HASH, consumer: 't', windowSeconds: W })).toMatchObject({ ok: false, reason: 'wrong_category' })
    expect(getApproval('c5')!.consumed_at).toBeNull()
    // ...and the letter path still consumes it as before.
    expect(consumeApproval({ id: 'c5', contentHash: HASH, consumer: 'send-tool', windowSeconds: 1800 }).ok).toBe(true)
  })

  it('a data_delete row is NEVER consumed here: the memory DELETE route is its only consumer', () => {
    approval('c5d', { category: 'data_delete' })
    expect(consumeCategoryApproval({ id: 'c5d', category: 'data_delete', contentHash: HASH, consumer: 't', windowSeconds: W })).toMatchObject({ ok: false, reason: 'wrong_category' })
    expect(consumeCategoryApproval({ id: 'c5d', category: CAT, contentHash: HASH, consumer: 't', windowSeconds: W })).toMatchObject({ ok: false, reason: 'wrong_category' })
    expect(getApproval('c5d')!.consumed_at).toBeNull()
    // ...and the memory delete path (consumeApproval with category data_delete) still consumes it.
    expect(consumeApproval({ id: 'c5d', category: 'data_delete', contentHash: HASH, consumer: 'memory-delete', windowSeconds: 1800 }).ok).toBe(true)
  })

  it('the letter path still refuses a non-email row (wrong_category), so the two paths exclude each other', () => {
    approval('c6')
    expect(consumeApproval({ id: 'c6', contentHash: HASH, consumer: 'send-tool', windowSeconds: 1800 })).toMatchObject({ ok: false, reason: 'wrong_category' })
    expect(getApproval('c6')!.consumed_at).toBeNull()
  })

  it('a pending or a rejected approval is not_approved', () => {
    approval('c7p', { status: 'pending' })
    approval('c7r', { status: 'rejected' })
    expect(consumeCategoryApproval({ id: 'c7p', category: CAT, contentHash: HASH, consumer: 't', windowSeconds: W })).toMatchObject({ ok: false, reason: 'not_approved' })
    expect(consumeCategoryApproval({ id: 'c7r', category: CAT, contentHash: HASH, consumer: 't', windowSeconds: W })).toMatchObject({ ok: false, reason: 'not_approved' })
  })

  it('the window: the last second inside passes, one second later is expired', () => {
    const edge = approval('c8e')
    const late = approval('c8l')
    expect(consumeCategoryApproval({ id: 'c8e', category: CAT, contentHash: HASH, consumer: 't', windowSeconds: 7200, nowS: edge.resolved_at! + 7200 }).ok).toBe(true)
    expect(consumeCategoryApproval({ id: 'c8l', category: CAT, contentHash: HASH, consumer: 't', windowSeconds: 7200, nowS: late.resolved_at! + 7201 }))
      .toMatchObject({ ok: false, reason: 'expired' })
    expect(getApproval('c8l')!.consumed_at).toBeNull()
  })

  it('a row a tool consumed directly in the DB (consumed_at set, no consumer) is refused: every consumer reads the same column', () => {
    approval('c9', { category: 'site_write' })
    // What a tool that marks its approval used by writing the column directly does.
    getDb().prepare('UPDATE approvals SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL').run(Math.floor(Date.now() / 1000), 'c9')
    expect(consumeCategoryApproval({ id: 'c9', category: 'site_write', contentHash: HASH, consumer: 't', windowSeconds: W })).toMatchObject({ ok: false, reason: 'already_consumed' })
  })

  it('an unknown id is not_found and leaves no event', () => {
    expect(consumeCategoryApproval({ id: 'nope', category: CAT, contentHash: HASH, consumer: 't', windowSeconds: W })).toMatchObject({ ok: false, reason: 'not_found' })
    expect(listApprovalEvents('nope')).toEqual([])
  })
})

describe('POST /api/approvals/:id/consume with a category', () => {
  it('200 for the first call, 409 already_consumed for the replay, and the 409 names the first consumer', async () => {
    approval('r1')
    const o1 = await post('r1', { category: CAT, content_hash: HASH, consumer: 'launcher.py', ref: 'plan-1', max_age_seconds: 7200 })
    expect(o1.status).toBe(200)
    expect(o1.body).toMatchObject({ ok: true, approval: { id: 'r1', consumed_by: 'launcher.py', consumed_ref: 'plan-1' } })
    const o2 = await post('r1', { category: CAT, content_hash: HASH, consumer: 'launcher.py', max_age_seconds: 7200 })
    expect(o2.status).toBe(409)
    expect(o2.body).toMatchObject({ ok: false, reason: 'already_consumed', approval: { id: 'r1', consumed_by: 'launcher.py', consumed_ref: 'plan-1' } })
  })

  it('two concurrent calls on one approval: exactly one 200', async () => {
    approval('r2', { category: 'site_write' })
    const calls = Array.from({ length: 8 }, (_, i) => consumeCtx('r2', { category: 'site_write', content_hash: HASH, consumer: `tool-${i}` }))
    await Promise.all(calls.map(c => tryHandleApprovals(c.ctx)))
    const statuses = calls.map(c => c.out.status).sort()
    expect(statuses).toEqual([200, 409, 409, 409, 409, 409, 409, 409])
    expect(listApprovalEvents('r2').filter(e => e.event === 'consumed')).toHaveLength(1)
  })

  it('a non-email category on an email_send row is 409 wrong_category and the letter stays consumable', async () => {
    approval('r3', { category: 'email_send' })
    const o = await post('r3', { category: CAT, content_hash: HASH, consumer: 't' })
    expect(o.status).toBe(409)
    expect(o.body.reason).toBe('wrong_category')
    expect(getApproval('r3')!.consumed_at).toBeNull()
  })

  it('a data_delete row named by its own category is 409 wrong_category and stays unconsumed', async () => {
    approval('r3d', { category: 'data_delete' })
    const o = await post('r3d', { category: 'data_delete', content_hash: HASH, consumer: 't' })
    expect(o.status).toBe(409)
    expect(o.body.reason).toBe('wrong_category')
    expect(getApproval('r3d')!.consumed_at).toBeNull()
  })

  it('a body that is not a JSON object is 400', async () => {
    for (const raw of ['null', '[]', '7', '"x"']) {
      const o = await post('any', undefined, raw)
      expect(o.status, raw).toBe(400)
    }
  })

  it('email_send stays on the letter path: no category, category null and category "email_send" give the same answers as before', async () => {
    for (const [i, extra] of [{}, { category: null }, { category: 'email_send' }].entries()) {
      approval(`e${i}`, { category: 'email_send' })
      const ok = await post(`e${i}`, { content_hash: HASH, consumer: 'send-tool', message_id: '<m1@example.org>', ...extra })
      expect(ok.status).toBe(200)
      expect(ok.body.approval).toMatchObject({ consumed_by: 'send-tool', consumed_ref: '<m1@example.org>' })
      const again = await post(`e${i}`, { content_hash: HASH, consumer: 'send-tool', ...extra })
      expect(again.status).toBe(409)
      expect(again.body.reason).toBe('already_consumed')
      // The letter path keeps requiring the anchor and refusing a bad Message-Id.
      expect((await post(`e${i}`, { consumer: 'send-tool', ...extra })).status).toBe(400)
      expect((await post(`e${i}`, { content_hash: HASH, consumer: 'send-tool', message_id: 'no-brackets@x', ...extra })).status).toBe(400)
    }
    // The letter path ignores max_age_seconds exactly as it ignored every unknown field: its window is the env one.
    const row = approval('e9', { category: 'email_send' })
    getDb().prepare('UPDATE approvals SET resolved_at = ? WHERE id = ?').run(row.resolved_at! - 3600, 'e9')
    const stale = await post('e9', { content_hash: HASH, consumer: 'send-tool', max_age_seconds: 86400 })
    expect(stale.status).toBe(409)
    expect(stale.body.reason).toBe('expired')
  })

  it('max_age_seconds is enforced by the server: older than the asked window is 409 expired', async () => {
    const row = approval('r4')
    getDb().prepare('UPDATE approvals SET resolved_at = ? WHERE id = ?').run(row.resolved_at! - 3000, 'r4')
    expect((await post('r4', { category: CAT, content_hash: HASH, consumer: 't' })).body.reason).toBe('expired')        // default 1800
    expect((await post('r4', { category: CAT, content_hash: HASH, consumer: 't', max_age_seconds: 2000 })).body.reason).toBe('expired')
    expect((await post('r4', { category: CAT, content_hash: HASH, consumer: 't', max_age_seconds: 7200 })).status).toBe(200)
  })

  it('an unanchored row is consumable without content_hash (null or absent)', async () => {
    approval('r5', { category: 'external_message', hash: null })
    expect((await post('r5', { category: 'external_message', consumer: 'notify-send.py', content_hash: null })).status).toBe(200)
    expect((await post('r5', { category: 'external_message', consumer: 'notify-send.py' })).status).toBe(409)
  })

  it('a bad body is 400 and consumes nothing', async () => {
    approval('r6')
    const bad: unknown[] = [
      { category: 'AdLaunch', content_hash: HASH, consumer: 't' },
      { category: 'a b', content_hash: HASH, consumer: 't' },
      { category: 7, content_hash: HASH, consumer: 't' },
      { category: 'x'.repeat(65), content_hash: HASH, consumer: 't' },
      { category: CAT, content_hash: 'AB'.repeat(32), consumer: 't' },
      { category: CAT, content_hash: 'ab', consumer: 't' },
      { category: CAT, content_hash: HASH },
      { category: CAT, content_hash: HASH, consumer: '  ' },
      { category: CAT, content_hash: HASH, consumer: 't', ref: '' },
      { category: CAT, content_hash: HASH, consumer: 't', ref: 'x'.repeat(251) },
      { category: CAT, content_hash: HASH, consumer: 't', ref: 'a' + String.fromCharCode(10) + 'b' },
      { category: CAT, content_hash: HASH, consumer: 't', max_age_seconds: 0 },
      { category: CAT, content_hash: HASH, consumer: 't', max_age_seconds: CATEGORY_CONSUME_MAX_WINDOW_S + 1 },
      { category: CAT, content_hash: HASH, consumer: 't', max_age_seconds: 1.5 },
      { category: CAT, content_hash: HASH, consumer: 't', max_age_seconds: '7200' },
    ]
    for (const body of bad) {
      const o = await post('r6', body)
      expect(o.status, JSON.stringify(body)).toBe(400)
    }
    expect(getApproval('r6')!.consumed_at).toBeNull()
    expect(listApprovalEvents('r6')).toEqual([])
  })

  it('404 for an unknown approval', async () => {
    const o = await post('no-such-id', { category: CAT, content_hash: HASH, consumer: 't' })
    expect(o.status).toBe(404)
    expect(o.body).toEqual({ ok: false, reason: 'not_found' })
  })
})

describe('validators', () => {
  it('category key, ref and window', () => {
    expect(isCategoryKey('ad_launch')).toBe(true)
    expect(isCategoryKey('data_delete')).toBe(true)
    expect(isCategoryKey('_x')).toBe(false)
    expect(isCategoryKey('')).toBe(false)
    expect(isConsumeRef('change-list-2026-10-18')).toBe(true)
    expect(isConsumeRef('a' + String.fromCharCode(127))).toBe(false)
    expect(categoryWindowSeconds(undefined)).toBe(CATEGORY_CONSUME_DEFAULT_WINDOW_S)
    expect(categoryWindowSeconds(null)).toBe(CATEGORY_CONSUME_DEFAULT_WINDOW_S)
    expect(categoryWindowSeconds(86400)).toBe(86400)
    expect(categoryWindowSeconds(86401)).toBeNull()
  })
})

// The in-process test above runs on one connection, where better-sqlite3 is
// synchronous anyway. This one races SEPARATE processes, each with its own
// connection to the same WAL file, released at the same instant: the only
// thing deciding who wins is the conditional UPDATE inside SQLite.
describe('cross-process double consume', () => {
  const dir = mkdtempSync(join(tmpdir(), 'appr-race-'))
  afterAll(() => { rmSync(dir, { recursive: true, force: true }) })

  function runChild(script: string, args: string[]): Promise<{ code: number | null; out: string; err: string }> {
    return new Promise((resolve) => {
      const p = spawn(process.execPath, ['--import', 'tsx', script, ...args], { cwd: ROOT, env: { ...process.env, LOG_LEVEL: 'silent' } })
      let out = ''
      let err = ''
      p.stdout.on('data', (d) => { out += d })
      p.stderr.on('data', (d) => { err += d })
      p.on('close', (code) => resolve({ code, out, err }))
    })
  }

  it('six processes consume one approval at the same instant: exactly one wins, five get already_consumed', async () => {
    const dbPath = join(dir, 'race.db')
    initDatabase(dbPath)
    approval('race-1', { category: CAT })
    const script = join(dir, 'child.ts')
    writeFileSync(script, [
      `import { initDatabase, consumeCategoryApproval } from ${JSON.stringify(join(ROOT, 'src', 'db.ts'))}`,
      `const [dbPath, startAt, who] = process.argv.slice(2)`,
      `initDatabase(dbPath)`,
      `const late = Date.now() > Number(startAt)`,
      `while (Date.now() < Number(startAt)) { /* barrier */ }`,
      `const r = consumeCategoryApproval({ id: 'race-1', category: ${JSON.stringify(CAT)}, contentHash: ${JSON.stringify(HASH)}, consumer: who, windowSeconds: 1800 })`,
      `console.log(JSON.stringify({ ok: r.ok, reason: r.reason ?? null, late }))`,
    ].join('\n'))
    const startAt = Date.now() + 8000
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => runChild(script, [dbPath, String(startAt), `proc-${i}`])))
    const parsed = results.map((r) => {
      if (r.code !== 0) throw new Error(`child failed (${r.code}): ${r.err.slice(-500)}`)
      return JSON.parse(r.out.trim().split('\n').pop()!) as { ok: boolean; reason: string | null; late: boolean }
    })
    // Every child reached the barrier before the release, so they really raced.
    expect(parsed.map(p => p.late)).toEqual([false, false, false, false, false, false])
    expect(parsed.filter(p => p.ok)).toHaveLength(1)
    expect(parsed.filter(p => !p.ok).map(p => p.reason)).toEqual(Array(5).fill('already_consumed'))
    initDatabase(dbPath)
    expect(listApprovalEvents('race-1').filter(e => e.event === 'consumed')).toHaveLength(1)
    expect(getApproval('race-1')!.consumed_at).not.toBeNull()
  }, 60_000)
})
