import { describe, it, expect, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import {
  initDatabase, getDb, createKanbanCard, getKanbanCard, moveKanbanCard, updateKanbanCard,
  createLabel, listLabels, getLabelsForCard, getBlockersForCard, addLabelToCard,
  setKanbanWaitReason, validateKanbanWaitReason,
} from '../db.js'
import { tryHandleKanban } from '../web/routes/kanban.js'
import type { RouteContext } from '../web/routes/types.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

function route(method: string, path: string, body?: unknown) {
  const out: { status: number; body: any } = { status: 200, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    setHeader() { return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const payload = body === undefined ? '' : JSON.stringify(body)
  const req: any = Readable.from(payload ? [Buffer.from(payload)] : [])
  req.headers = {}
  const url = new URL(`http://localhost:3420${path}`)
  return {
    ctx: { req, res, path: url.pathname, method, url } as RouteContext,
    out,
  }
}

describe('wait-reason database contract', () => {
  beforeEach(() => initDatabase(':memory:'))

  it('creates all three columns and persists then clears a reason', () => {
    const columns = getDb().prepare('PRAGMA table_info(kanban_cards)').all() as Array<{ name: string }>
    expect(columns.map((c) => c.name)).toEqual(expect.arrayContaining(['wait_kind', 'wait_note', 'wait_until']))
    createKanbanCard({ id: 'a', title: 'A', status: 'waiting' })
    setKanbanWaitReason('a', { kind: 'date', note: 'review', until: 1_900_000_000 })
    expect(getKanbanCard('a')).toMatchObject({ wait_kind: 'date', wait_note: 'review', wait_until: 1_900_000_000 })
    setKanbanWaitReason('a', null)
    expect(getKanbanCard('a')).toMatchObject({ wait_kind: null, wait_note: null, wait_until: null })
  })

  it('validates every kind and rejects incomplete or unknown shapes', () => {
    expect(validateKanbanWaitReason({ kind: 'owner' })).toMatchObject({ ok: true, reason: { kind: 'owner' } })
    expect(validateKanbanWaitReason({ kind: 'external', note: 'Vendor' })).toMatchObject({ ok: true })
    expect(validateKanbanWaitReason({ kind: 'date', until: 123 })).toMatchObject({ ok: true })
    expect(validateKanbanWaitReason({ kind: 'card', blockerId: 'b' })).toMatchObject({ ok: true })
    for (const raw of [
      { kind: 'external' }, { kind: 'date' }, { kind: 'card' }, { kind: 'mystery' },
      { kind: 'owner', surprise: true }, { kind: 'owner', note: 'x'.repeat(201) },
    ]) expect(validateKanbanWaitReason(raw).ok).toBe(false)
  })

  it.each(['Rád vár', 'rad var'])('owner attaches the folded %s label and clearing removes it', (name) => {
    createKanbanCard({ id: 'a', title: 'A', status: 'waiting' })
    createLabel({ id: 'owner-label', name, color: '#fff' })
    setKanbanWaitReason('a', { kind: 'owner' })
    expect(getKanbanCard('a')!.wait_kind).toBe('owner')
    expect(getLabelsForCard('a').map((l) => l.id)).toEqual(['owner-label'])
    setKanbanWaitReason('a', null)
    expect(getLabelsForCard('a')).toHaveLength(0)
  })

  it('creates the Rád vár label on first owner use, then reuses it', () => {
    createKanbanCard({ id: 'a', title: 'A', status: 'waiting' })
    createKanbanCard({ id: 'b', title: 'B', status: 'waiting' })
    expect(listLabels()).toHaveLength(0)
    setKanbanWaitReason('a', { kind: 'owner' })
    expect(getKanbanCard('a')!.wait_kind).toBe('owner')
    expect(listLabels().map((l) => l.name)).toEqual(['Rád vár'])
    setKanbanWaitReason('b', { kind: 'owner' })
    expect(listLabels()).toHaveLength(1)
    const labelId = listLabels()[0].id
    expect(getLabelsForCard('a').map((l) => l.id)).toEqual([labelId])
    expect(getLabelsForCard('b').map((l) => l.id)).toEqual([labelId])
  })

  it('a non-owner reason does not create the label', () => {
    createKanbanCard({ id: 'a', title: 'A', status: 'waiting' })
    setKanbanWaitReason('a', { kind: 'external', note: 'Vendor' })
    expect(listLabels()).toHaveLength(0)
  })

  it('card reason persists and creates the blocker relationship', () => {
    createKanbanCard({ id: 'a', title: 'A', status: 'waiting' })
    createKanbanCard({ id: 'b', title: 'B' })
    setKanbanWaitReason('a', { kind: 'card', blockerId: 'b', note: 'dependency' })
    expect(getKanbanCard('a')).toMatchObject({ wait_kind: 'card', wait_note: 'dependency' })
    expect(getBlockersForCard('a').map((c) => c.id)).toEqual(['b'])
  })

  it('leaving waiting clears the reason and owner label, while reordering inside waiting keeps both', () => {
    createKanbanCard({ id: 'a', title: 'A', status: 'waiting' })
    createLabel({ id: 'owner-label', name: 'Rád vár', color: '#fff' })
    setKanbanWaitReason('a', { kind: 'owner', note: 'decision' })
    moveKanbanCard('a', 'waiting', 9)
    expect(getKanbanCard('a')).toMatchObject({ status: 'waiting', sort_order: 9, wait_kind: 'owner', wait_note: 'decision' })
    expect(getLabelsForCard('a')).toHaveLength(1)
    moveKanbanCard('a', 'in_progress', 0)
    expect(getKanbanCard('a')).toMatchObject({ status: 'in_progress', wait_kind: null, wait_note: null, wait_until: null })
    expect(getLabelsForCard('a')).toHaveLength(0)
  })

  it('the whole-card update out of waiting clears the reason and owner label too (review #1861)', () => {
    createKanbanCard({ id: 'a', title: 'A', status: 'waiting' })
    createLabel({ id: 'owner-label', name: 'Rád vár', color: '#fff' })
    setKanbanWaitReason('a', { kind: 'owner', note: 'decision' })
    // A write that leaves status alone is not a transition: the reason stays.
    expect(updateKanbanCard('a', { title: 'Renamed' })).toBe(true)
    expect(getKanbanCard('a')).toMatchObject({ status: 'waiting', wait_kind: 'owner', wait_note: 'decision' })
    expect(getLabelsForCard('a')).toHaveLength(1)
    expect(updateKanbanCard('a', { status: 'in_progress' })).toBe(true)
    expect(getKanbanCard('a')).toMatchObject({ status: 'in_progress', wait_kind: null, wait_note: null, wait_until: null })
    expect(getLabelsForCard('a')).toHaveLength(0)
    // Back to waiting later: the stale reason does not reappear.
    expect(updateKanbanCard('a', { status: 'waiting' })).toBe(true)
    expect(getKanbanCard('a')).toMatchObject({ status: 'waiting', wait_kind: null })
    expect(getLabelsForCard('a')).toHaveLength(0)
  })

  it('the whole-card update clears a non-owner reason and leaves an unrelated label alone', () => {
    createKanbanCard({ id: 'a', title: 'A', status: 'waiting' })
    createLabel({ id: 'owner-label', name: 'Rád vár', color: '#fff' })
    addLabelToCard('a', 'owner-label')
    setKanbanWaitReason('a', { kind: 'date', until: 1_900_000_000, note: 'review' })
    updateKanbanCard('a', { status: 'done' })
    expect(getKanbanCard('a')).toMatchObject({ status: 'done', wait_kind: null, wait_note: null, wait_until: null })
    expect(getLabelsForCard('a').map((l) => l.id)).toEqual(['owner-label'])
  })

  it('moving to waiting without a reason remains supported and stores NULL', () => {
    createKanbanCard({ id: 'a', title: 'A' })
    expect(moveKanbanCard('a', 'waiting', 0)).toBe(true)
    expect(getKanbanCard('a')).toMatchObject({ status: 'waiting', wait_kind: null })
  })
})

describe('wait-reason routes', () => {
  beforeEach(() => initDatabase(':memory:'))

  it('invalid /move wait returns 400 and does not move the card', async () => {
    createKanbanCard({ id: 'a', title: 'A', status: 'planned' })
    const { ctx, out } = route('POST', '/api/kanban/a/move', { status: 'waiting', wait: { kind: 'external' } })
    await tryHandleKanban(ctx)
    expect(out.status).toBe(400)
    expect(getKanbanCard('a')).toMatchObject({ status: 'planned', wait_kind: null })
  })

  it('/move rejects wait on a non-waiting target and preserves the card', async () => {
    createKanbanCard({ id: 'a', title: 'A', status: 'planned' })
    const { ctx, out } = route('POST', '/api/kanban/a/move', { status: 'done', wait: { kind: 'date', until: 123 } })
    await tryHandleKanban(ctx)
    expect(out.status).toBe(400)
    expect(getKanbanCard('a')!.status).toBe('planned')
  })

  it('valid /move wait moves the card and stores the reason with its blocker', async () => {
    createKanbanCard({ id: 'a', title: 'A', status: 'planned' })
    createKanbanCard({ id: 'b', title: 'B' })
    const { ctx, out } = route('POST', '/api/kanban/a/move', { status: 'waiting', wait: { kind: 'card', blockerId: 'b' } })
    await tryHandleKanban(ctx)
    expect(out.status).toBe(200)
    expect(getKanbanCard('a')).toMatchObject({ status: 'waiting', wait_kind: 'card' })
    expect(getBlockersForCard('a').map((c) => c.id)).toEqual(['b'])
  })

  it('/move with an owner wait on a fresh board creates the label and attaches it', async () => {
    createKanbanCard({ id: 'a', title: 'A', status: 'planned' })
    const { ctx, out } = route('POST', '/api/kanban/a/move', { status: 'waiting', wait: { kind: 'owner' } })
    await tryHandleKanban(ctx)
    expect(out.status).toBe(200)
    expect(getKanbanCard('a')).toMatchObject({ status: 'waiting', wait_kind: 'owner' })
    expect(getLabelsForCard('a').map((l) => l.name)).toEqual(['Rád vár'])
  })

  it('DELETE /wait clears the reason', async () => {
    createKanbanCard({ id: 'a', title: 'A', status: 'waiting' })
    setKanbanWaitReason('a', { kind: 'external', note: 'Vendor' })
    const { ctx, out } = route('DELETE', '/api/kanban/a/wait')
    await tryHandleKanban(ctx)
    expect(out.status).toBe(200)
    expect(getKanbanCard('a')).toMatchObject({ wait_kind: null, wait_note: null })
  })

  it('/move with a card wait that would close a cycle is 409 and does not move', async () => {
    createKanbanCard({ id: 'a', title: 'A', status: 'planned' })
    createKanbanCard({ id: 'b', title: 'B', status: 'waiting' })
    setKanbanWaitReason('b', { kind: 'card', blockerId: 'a' })
    const { ctx, out } = route('POST', '/api/kanban/a/move', { status: 'waiting', wait: { kind: 'card', blockerId: 'b' } })
    await tryHandleKanban(ctx)
    expect(out.status).toBe(409)
    expect(getKanbanCard('a')).toMatchObject({ status: 'planned', wait_kind: null })
  })

  it('PUT /wait on a non-waiting card is 409 and stores nothing', async () => {
    createKanbanCard({ id: 'a', title: 'A', status: 'planned' })
    const { ctx, out } = route('PUT', '/api/kanban/a/wait', { kind: 'date', until: 123 })
    await tryHandleKanban(ctx)
    expect(out.status).toBe(409)
    expect(getKanbanCard('a')!.wait_kind).toBeNull()
  })

  it('PUT of a whole card out of waiting clears the owner reason and the Rád vár label (review #1861)', async () => {
    createKanbanCard({ id: 'a', title: 'A', status: 'waiting' })
    setKanbanWaitReason('a', { kind: 'owner', note: 'decision' })
    expect(getLabelsForCard('a').map((l) => l.name)).toEqual(['Rád vár'])
    // The dashboard round-trips the whole card, wait_* included: the echoed
    // stale values must not survive the transition.
    const card = getKanbanCard('a')!
    const { ctx, out } = route('PUT', '/api/kanban/a', { ...card, status: 'in_progress' })
    await tryHandleKanban(ctx)
    expect(out.status).toBe(200)
    expect(getKanbanCard('a')).toMatchObject({ status: 'in_progress', wait_kind: null, wait_note: null, wait_until: null })
    expect(getLabelsForCard('a')).toHaveLength(0)
  })

  it('PUT of a whole card accepts wait_* read-only fields and still applies writable changes', async () => {
    createKanbanCard({ id: 'a', title: 'A', status: 'waiting' })
    setKanbanWaitReason('a', { kind: 'external', note: 'Vendor' })
    const card = getKanbanCard('a')!
    const { ctx, out } = route('PUT', '/api/kanban/a', { ...card, title: 'Changed' })
    await tryHandleKanban(ctx)
    expect(out.status).toBe(200)
    expect(getKanbanCard('a')).toMatchObject({ title: 'Changed', wait_kind: 'external', wait_note: 'Vendor' })
  })
})

describe('kanbanWaitReason browser inference', () => {
  const source = readFileSync(join(ROOT, 'web', 'app.js'), 'utf8')
  const start = source.indexOf("const KANBAN_OWNER_QUEUE_LABEL")
  const end = source.indexOf('function renderKanbanOwnerStrip()', start)
  const ctx: Record<string, any> = {}
  vm.createContext(ctx)
  vm.runInContext(source.slice(start, end) + '\nglobalThis.waitReason = kanbanWaitReason', ctx)
  const reason = ctx.waitReason as (card: any) => any

  it('prefers an explicit reason over label and blocker inference', () => {
    expect(reason({ wait_kind: 'external', wait_note: 'Vendor', labels: [{ name: 'Rád vár' }], blockers: [{ status: 'planned' }] }))
      .toMatchObject({ kind: 'external', note: 'Vendor', source: 'explicit' })
  })

  it('infers owner from a folded label, then card only from open blockers', () => {
    expect(reason({ labels: [{ name: 'rad VAR' }], blockers: [{ status: 'planned' }] })).toMatchObject({ kind: 'owner', source: 'label' })
    expect(reason({ labels: [], blockers: [{ status: 'planned' }] })).toMatchObject({ kind: 'card', source: 'blockers' })
    expect(reason({ labels: [], blockers: [{ status: 'done' }] })).toBeNull()
  })

  it('marks an expired explicit date', () => {
    expect(reason({ wait_kind: 'date', wait_until: 1 })).toMatchObject({ kind: 'date', until: 1, expired: true })
  })
})
