// MARVEENGAPS1020 (a): below data_delete level 3 a memory DELETE runs only with
// an approved, unused data_delete approval bound to that memory in that content
// state. Without one the server files the request itself (owner notified, its
// own wording) and answers 409. Real route, real in-memory DB, real approvals
// table; only the outbound owner message is captured.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { RouteContext } from '../web/routes/types.js'

const level = { value: 1 as 1 | 2 | 3 }
const ownerTexts: string[] = []

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, MAIN_AGENT_ID: 'lean-chief', CHANNEL_PROVIDER: 'slack', TELEGRAM_BOT_TOKEN: '' }
})
vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }))
vi.mock('../notify.js', () => ({
  // APPROVALSLACK1030: no Slack target on this install, the provider path is what these tests pin.
  sendOwnerSlackDm: async () => ({ attempted: false, sent: false }),
  sendOwnerMessage: vi.fn(async (text: string) => { ownerTexts.push(text); return { sent: true } }),
}))
vi.mock('../web/autonomy-level.js', async (orig) => {
  const actual = await orig<typeof import('../web/autonomy-level.js')>()
  return { ...actual, readAutonomyLevel: () => ({ level: level.value, source: 'config' }) }
})

const { initDatabase, saveAgentMemory, getMemoryById, getApproval, resolveApproval, listApprovals, createApproval, updateMemory, getDb } = await import('../db.js')
const { tryHandleMemories } = await import('../web/routes/memories.js')

async function del(id: number, approvalId?: string, caller = 'leanscout') {
  const url = new URL(`http://localhost:3420/api/memories/${id}`)
  if (approvalId) url.searchParams.set('approval_id', approvalId)
  let status = 200
  let body = ''
  const res = { writeHead: (c: number) => { status = c }, end: (b?: string) => { body = b || '' } }
  const ctx: RouteContext = { req: Readable.from([]) as any, res: res as any, path: url.pathname, method: 'DELETE', url, auth: { kind: 'token', agent: caller } }
  expect(await tryHandleMemories(ctx)).toBe(true)
  return { status, body: body ? JSON.parse(body) : null }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  initDatabase(':memory:')
  level.value = 1
  ownerTexts.length = 0
})

describe('data_delete below level 3: the delete needs an approval', () => {
  it('no approval: 409, the memory stays, and ONE server-worded request reaches the owner', async () => {
    const { id } = saveAgentMemory('leanscout', 'Stale note about the old deploy runbook', 'hot')
    const r = await del(id)
    expect(r.status).toBe(409)
    expect(r.body).toMatchObject({ error: 'approval_required', status: 'pending', level: 1 })
    expect(getMemoryById(id)).toBeDefined()
    const a = getApproval(r.body.approval_id)!
    expect(a).toMatchObject({ category: 'data_delete', agent_id: 'leanscout', status: 'pending' })
    expect(a.action_description).toContain(`#${id}`)
    expect(a.action_description).toContain('Stale note about the old deploy runbook')
    expect(JSON.parse(a.action_payload!)).toMatchObject({ memory_id: id })
    await flush()
    expect(ownerTexts).toHaveLength(1)
    expect(ownerTexts[0]).toContain(`#${id}`)
    // a retry answers with the same request instead of filing another
    const again = await del(id)
    expect(again.body.approval_id).toBe(r.body.approval_id)
    expect(listApprovals({ category: 'data_delete' })).toHaveLength(1)
    await flush()
    expect(ownerTexts).toHaveLength(1)
  })

  it('level 2 behaves the same way', async () => {
    level.value = 2
    const { id } = saveAgentMemory('leanscout', 'x', 'cold')
    const r = await del(id)
    expect(r.status).toBe(409)
    expect(r.body.error).toBe('approval_required')
    expect(getMemoryById(id)).toBeDefined()
  })

  it('a pending approval does not delete; an approved one deletes once, and only once', async () => {
    const { id } = saveAgentMemory('leanscout', 'to go', 'hot')
    const approvalId = (await del(id)).body.approval_id
    const pending = await del(id, approvalId)
    expect(pending).toMatchObject({ status: 409, body: { error: 'approval_not_usable', reason: 'not_approved' } })
    expect(getMemoryById(id)).toBeDefined()

    resolveApproval(approvalId, 'approved', 'owner')
    const told = await del(id)
    expect(told.body).toMatchObject({ error: 'approval_required', status: 'approved', approval_id: approvalId })
    const ok = await del(id, approvalId)
    expect(ok.status).toBe(200)
    expect(getMemoryById(id)).toBeUndefined()
    expect(getApproval(approvalId)!.consumed_by).toBe('memory-delete')

    // the same id cannot delete another memory
    const { id: other } = saveAgentMemory('leanscout', 'keep me', 'hot')
    const reuse = await del(other, approvalId)
    expect(reuse.status).toBe(409)
    expect(getMemoryById(other)).toBeDefined()
  })

  it('an owner-approved delete of a long warm memory needs no confirm_overwrite on top', async () => {
    const { id } = saveAgentMemory('leanscout', 'W'.repeat(1900), 'warm')
    const approvalId = (await del(id)).body.approval_id
    resolveApproval(approvalId, 'approved', 'owner')
    const r = await del(id, approvalId)
    expect(r.status).toBe(200)
    expect(getMemoryById(id)).toBeUndefined()
  })

  it('an edit after the approval voids it: the anchor is the content version', async () => {
    const { id } = saveAgentMemory('leanscout', 'version one', 'hot')
    const approvalId = (await del(id)).body.approval_id
    resolveApproval(approvalId, 'approved', 'owner')
    updateMemory(id, 'version two')
    const r = await del(id, approvalId)
    expect(r).toMatchObject({ status: 409, body: { reason: 'hash_mismatch' } })
    expect(getMemoryById(id)!.content).toBe('version two')
  })

  it('an approval of another category, or an unknown id, does not delete', async () => {
    const { id } = saveAgentMemory('leanscout', 'x', 'hot')
    const anchor = getApproval((await del(id)).body.approval_id)!.content_hash!
    createApproval({ id: 'mail-1', agent_id: 'leanscout', category: 'email_send', action_description: 'a letter', content_hash: anchor })
    resolveApproval('mail-1', 'approved', 'owner')
    expect((await del(id, 'mail-1')).body.reason).toBe('wrong_category')
    expect((await del(id, 'no-such-id')).status).toBe(404)
    expect(getMemoryById(id)).toBeDefined()
  })

  it('an approved request older than the consume window is not offered again; a fresh one is filed', async () => {
    const { id } = saveAgentMemory('leanscout', 'x', 'hot')
    const first = (await del(id)).body.approval_id
    resolveApproval(first, 'approved', 'owner')
    getDb().prepare('UPDATE approvals SET resolved_at = resolved_at - 100000 WHERE id = ?').run(first)
    const r = await del(id)
    expect(r.body.approval_id).not.toBe(first)
    expect(r.body.status).toBe('pending')
    expect((await del(id, first)).body.reason).toBe('expired')
    expect(getMemoryById(id)).toBeDefined()
  })

  it('the anchor includes the memory id: an approval for one memory cannot delete another with the same content', async () => {
    const { id: a } = saveAgentMemory('leanscout', 'same words', 'hot')
    const { id: b } = saveAgentMemory('leanscout', 'same words', 'hot')
    const approvalId = (await del(a)).body.approval_id
    resolveApproval(approvalId, 'approved', 'owner')
    expect((await del(b, approvalId)).body.reason).toBe('hash_mismatch')
    expect(getMemoryById(b)).toBeDefined()
    expect((await del(a, approvalId)).status).toBe(200)
  })

  it('ABA: a row restored with the same id and content gets a fresh request; the consumed approval is not offered or usable', async () => {
    const { id } = saveAgentMemory('leanscout', 'restorable', 'hot')
    const before = getDb().prepare('SELECT * FROM memories WHERE id = ?').get(id) as Record<string, unknown>
    const first = (await del(id)).body.approval_id
    resolveApproval(first, 'approved', 'owner')
    expect((await del(id, first)).status).toBe(200)
    const cols = Object.keys(before)
    getDb().prepare(`INSERT INTO memories (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((c) => before[c]))
    expect(getMemoryById(id)!.content).toBe('restorable')
    const again = await del(id)
    expect(again.body.error).toBe('approval_required')
    expect(again.body.approval_id).not.toBe(first)
    expect(again.body.status).toBe('pending')
    expect((await del(id, first)).body.reason).toBe('already_consumed')
    expect(getMemoryById(id)).toBeDefined()
  })

  it('more than 500 data_delete requests on the table: a retry still finds its open request', async () => {
    const { id } = saveAgentMemory('leanscout', 'x', 'hot')
    const first = (await del(id)).body.approval_id
    const insert = getDb().prepare("INSERT INTO approvals (id, agent_id, category, action_description, requested_at, content_hash) VALUES (?, 'other', 'data_delete', 'other row', ?, ?)")
    const now = Math.floor(Date.now() / 1000)
    for (let i = 0; i < 600; i++) insert.run(`other-${i}`, now + 1 + i, `${i}`.padStart(64, '0'))
    const again = await del(id)
    expect(again.body.approval_id).toBe(first)
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM approvals WHERE category = 'data_delete' AND agent_id = 'leanscout'").get()).toEqual({ n: 1 })
  })

  it('level 3 keeps the old behaviour: the delete runs without an approval', async () => {
    level.value = 3
    const { id } = saveAgentMemory('leanscout', 'x', 'hot')
    const r = await del(id)
    expect(r.status).toBe(200)
    expect(getMemoryById(id)).toBeUndefined()
    expect(listApprovals({ category: 'data_delete' })).toHaveLength(0)
  })
})

describe('readAutonomyLevel: a missing config or key is level 1', async () => {
  const { readAutonomyLevel } = await vi.importActual<typeof import('../web/autonomy-level.js')>('../web/autonomy-level.js')
  const dir = mkdtempSync(join(tmpdir(), 'autonomy-level-'))
  const file = join(dir, 'autonomy-config.json')
  const put = (o: unknown) => writeFileSync(file, typeof o === 'string' ? o : JSON.stringify(o))

  it('reads the level, capped by maxLevel; every unusable input falls back to 1', () => {
    expect(readAutonomyLevel('data_delete', join(dir, 'absent.json'))).toEqual({ level: 1, source: 'missing-config' })
    put('{not json')
    expect(readAutonomyLevel('data_delete', file)).toEqual({ level: 1, source: 'unreadable' })
    put({ categories: [{ key: 'other', level: 3 }] })
    expect(readAutonomyLevel('data_delete', file)).toEqual({ level: 1, source: 'missing-key' })
    put({ categories: [{ key: 'data_delete', level: 3, maxLevel: 1 }] })
    expect(readAutonomyLevel('data_delete', file)).toEqual({ level: 1, source: 'config' })
    put({ categories: [{ key: 'data_delete', level: 2, maxLevel: 3 }] })
    expect(readAutonomyLevel('data_delete', file)).toEqual({ level: 2, source: 'config' })
    put({ categories: [{ key: 'data_delete', level: 'x' }] })
    expect(readAutonomyLevel('data_delete', file).level).toBe(1)
    rmSync(dir, { recursive: true, force: true })
  })
})
