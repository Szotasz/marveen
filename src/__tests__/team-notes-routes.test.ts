// Team notes ("Jegyzetek"): /api/notes CRUD with soft delete. Covers create,
// list ordering, the assignee filter (which must also return 'mindenki' lines),
// edit, soft delete + include_deleted, and the 400/404/405 edges.
import { describe, it, expect, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import { initDatabase, getDb, getTeamNote } from '../db.js'
import { tryHandleNotes } from '../web/routes/notes.js'
import type { RouteContext } from '../web/routes/types.js'

async function call(method: string, pathAndQuery: string, payload?: unknown): Promise<{ handled: boolean; status: number; body: any }> {
  const out = { status: 200, body: null as any }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    setHeader() { return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const raw = payload === undefined ? '' : typeof payload === 'string' ? payload : JSON.stringify(payload)
  const req: any = Readable.from(raw ? [Buffer.from(raw)] : [])
  const url = new URL(`http://localhost:3420${pathAndQuery}`)
  const handled = await tryHandleNotes({ req, res, path: url.pathname, method, url } as RouteContext)
  return { handled, ...out }
}

async function create(fields: Record<string, unknown>): Promise<string> {
  const r = await call('POST', '/api/notes', { created_by: 'gazda', ...fields })
  expect(r.status).toBe(200)
  expect(r.body.ok).toBe(true)
  return r.body.id
}

describe('/api/notes', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('creates a note with a 6-hex id and lists it', async () => {
    const id = await create({ assignee: 'forgacs', content: 'Check the invoice tomorrow', due_date: '2026-09-27' })
    expect(id).toMatch(/^[0-9a-f]{6}$/)
    const r = await call('GET', '/api/notes')
    expect(r.status).toBe(200)
    expect(r.body).toHaveLength(1)
    expect(r.body[0]).toMatchObject({
      id, assignee: 'forgacs', content: 'Check the invoice tomorrow', due_date: '2026-09-27',
      created_by: 'gazda', deleted_at: null, deleted_by: null, delete_reason: null,
    })
    expect(typeof r.body[0].created_at).toBe('number')
  })

  it('sorts by due_date ascending, undated notes last', async () => {
    const late = await create({ assignee: 'cody', content: 'late', due_date: '2026-10-05' })
    const none = await create({ assignee: 'cody', content: 'no date' })
    const early = await create({ assignee: 'cody', content: 'early', due_date: '2026-09-28' })
    const r = await call('GET', '/api/notes')
    expect(r.body.map((n: any) => n.id)).toEqual([early, late, none])
  })

  it('assignee filter returns that assignee plus mindenki, nobody else', async () => {
    const mine = await create({ assignee: 'roxy', content: 'mine' })
    const all = await create({ assignee: 'mindenki', content: 'everyone' })
    await create({ assignee: 'margo', content: 'not mine' })
    const r = await call('GET', '/api/notes?assignee=roxy')
    expect(r.status).toBe(200)
    expect(r.body.map((n: any) => n.id).sort()).toEqual([mine, all].sort())
  })

  it('rejects an unknown query parameter', async () => {
    const r = await call('GET', '/api/notes?asignee=roxy')
    expect(r.status).toBe(400)
    expect(r.body.unknown).toEqual(['asignee'])
  })

  it('edits an active note', async () => {
    const id = await create({ assignee: 'cody', content: 'old', due_date: '2026-09-30' })
    const r = await call('PUT', `/api/notes/${id}`, { content: 'new', assignee: 'margo', due_date: null })
    expect(r.status).toBe(200)
    expect(r.body.note).toMatchObject({ content: 'new', assignee: 'margo', due_date: null })
    expect(getTeamNote(id)!.content).toBe('new')
  })

  it('PUT: 404 on missing and on deleted note, 400 on unknown field', async () => {
    expect((await call('PUT', '/api/notes/abcdef', { content: 'x' })).status).toBe(404)
    const id = await create({ assignee: 'cody', content: 'x' })
    const unknown = await call('PUT', `/api/notes/${id}`, { content: 'y', status: 'done' })
    expect(unknown.status).toBe(400)
    expect(unknown.body.error).toContain('status')
    expect(unknown.body.error).toContain('Accepted: content, assignee, due_date')
    expect(getTeamNote(id)!.content).toBe('x')
    await call('DELETE', `/api/notes/${id}`, { by: 'cody' })
    expect((await call('PUT', `/api/notes/${id}`, { content: 'z' })).status).toBe(404)
  })

  it('soft-deletes: hidden from the default list, kept with deleted_* under include_deleted=1', async () => {
    const id = await create({ assignee: 'anorak', content: 'done soon' })
    const keep = await create({ assignee: 'anorak', content: 'still open' })
    const d = await call('DELETE', `/api/notes/${id}`, { by: 'anorak', reason: 'done' })
    expect(d.status).toBe(200)
    expect(d.body).toEqual({ ok: true })
    // The row is still in the table: deletion is soft.
    expect(getTeamNote(id)).toMatchObject({ deleted_by: 'anorak', delete_reason: 'done' })
    expect((await call('GET', '/api/notes')).body.map((n: any) => n.id)).toEqual([keep])
    const withDeleted = await call('GET', '/api/notes?include_deleted=1')
    const deleted = withDeleted.body.find((n: any) => n.id === id)
    expect(deleted).toMatchObject({ deleted_by: 'anorak', delete_reason: 'done' })
    expect(typeof deleted.deleted_at).toBe('number')
  })

  it('include_deleted=1 leaves out deletions older than 7 days', async () => {
    const id = await create({ assignee: 'anorak', content: 'old' })
    await call('DELETE', `/api/notes/${id}`, { by: 'anorak' })
    getDb().prepare('UPDATE team_notes SET deleted_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000) - 8 * 86400, id)
    expect((await call('GET', '/api/notes?include_deleted=1')).body).toEqual([])
  })

  it('DELETE: by is required, 404 on missing or already deleted', async () => {
    const id = await create({ assignee: 'cody', content: 'x' })
    const noBy = await call('DELETE', `/api/notes/${id}`, { reason: 'x' })
    expect(noBy.status).toBe(400)
    expect(noBy.body.error).toContain('by')
    expect((await call('DELETE', `/api/notes/${id}`)).status).toBe(400)
    expect((await call('DELETE', '/api/notes/000000', { by: 'cody' })).status).toBe(404)
    expect((await call('DELETE', `/api/notes/${id}`, { by: 'cody' })).status).toBe(200)
    expect((await call('DELETE', `/api/notes/${id}`, { by: 'cody' })).status).toBe(404)
  })

  it('POST validation: 400 on missing/empty fields, bad date, unknown field, bad JSON', async () => {
    const cases: Array<[unknown, string]> = [
      [{ content: 'x', created_by: 'gazda' }, 'assignee'],
      [{ assignee: 'cody', created_by: 'gazda' }, 'content'],
      [{ assignee: 'cody', content: '   ', created_by: 'gazda' }, 'content'],
      [{ assignee: 'cody', content: 'x' }, 'created_by'],
      [{ assignee: 'cody', content: 'x', created_by: 'gazda', due_date: '27/09/2026' }, 'YYYY-MM-DD'],
      [{ assignee: 'cody', content: 'x', created_by: 'gazda', due_date: '2026-02-30' }, 'YYYY-MM-DD'],
      [{ assignee: 'cody', content: 'x', created_by: 'gazda', priority: 'high' }, 'Accepted: assignee, content, due_date, created_by'],
      ['{not json', 'JSON'],
    ]
    for (const [payload, needle] of cases) {
      const r = await call('POST', '/api/notes', payload)
      expect(r.status, JSON.stringify(payload)).toBe(400)
      expect(r.body.error).toContain(needle)
    }
    expect((await call('GET', '/api/notes')).body).toEqual([])
  })

  it('405 for an unsupported method, false for foreign paths', async () => {
    expect((await call('PATCH', '/api/notes/abc123', {})).status).toBe(405)
    expect((await call('DELETE', '/api/notes')).status).toBe(405)
    expect((await call('GET', '/api/notesx')).handled).toBe(false)
    expect((await call('GET', '/api/notes/abc/extra')).handled).toBe(false)
  })
})
