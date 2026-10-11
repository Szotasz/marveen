// Team notes ("Jegyzetek"): /api/notes CRUD with soft delete. Covers create,
// list ordering, the assignee filter (which must also return 'mindenki' lines,
// case-insensitively), soft delete + include_deleted, who wrote or deleted a
// line (body, else the session user, never a guess), and the 400/404/405 edges.
// There is no edit (PUT): every change to the list is a create or a delete.
import { describe, it, expect, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import { initDatabase, getDb, getTeamNote } from '../db.js'
import { tryHandleNotes } from '../web/routes/notes.js'
import type { RouteContext } from '../web/routes/types.js'

async function call(method: string, pathAndQuery: string, payload?: unknown, auth?: RouteContext['auth']): Promise<{ handled: boolean; status: number; body: any }> {
  const out = { status: 200, body: null as any }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    setHeader() { return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const raw = payload === undefined ? '' : typeof payload === 'string' ? payload : JSON.stringify(payload)
  const req: any = Readable.from(raw ? [Buffer.from(raw)] : [])
  const url = new URL(`http://localhost:3420${pathAndQuery}`)
  const handled = await tryHandleNotes({ req, res, path: url.pathname, method, url, auth } as RouteContext)
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

  it('stores the assignee lower-case and filters case-insensitively, old mixed-case rows included', async () => {
    const mine = await create({ assignee: 'Roxy ', content: 'mine' })
    expect(getTeamNote(mine)!.assignee).toBe('roxy')
    // A row written before the API lower-cased (or straight into the table).
    getDb().prepare("INSERT INTO team_notes (id, assignee, content, created_at, created_by) VALUES ('0ld001', 'ROXY', 'old row', 1, 'x'), ('0ld002', 'Mindenki', 'old all', 1, 'x')").run()
    const r = await call('GET', '/api/notes?assignee=RoXy')
    expect(r.body.map((n: any) => n.id).sort()).toEqual([mine, '0ld001', '0ld002'].sort())
  })

  it('an empty assignee filter is a 400, not every note', async () => {
    await create({ assignee: 'roxy', content: 'x' })
    for (const q of ['assignee=', 'assignee=%20']) {
      const r = await call('GET', `/api/notes?${q}`)
      expect(r.status, q).toBe(400)
      expect(r.body.error).toContain('assignee')
    }
    expect((await call('GET', '/api/notes?include_deleted=yes')).body.error).toContain('1, 0, true or false')
  })

  it('PUT is not offered: 405, the note unchanged', async () => {
    const id = await create({ assignee: 'cody', content: 'x' })
    const r = await call('PUT', `/api/notes/${id}`, { content: 'y' })
    expect(r.status).toBe(405)
    expect(getTeamNote(id)!.content).toBe('x')
  })

  it('a browser session or device names the author whatever the body says; a token caller must name itself', async () => {
    const session = { kind: 'session', user: 'alex' } as RouteContext['auth']
    const post = await call('POST', '/api/notes', { assignee: 'cody', content: 'from the page' }, session)
    expect(post.status).toBe(200)
    expect(getTeamNote(post.body.id)!.created_by).toBe('alex')
    expect((await call('POST', '/api/notes', { assignee: 'cody', content: 'x' }, { kind: 'token' } as RouteContext['auth'])).status).toBe(400)
    const del = await call('DELETE', `/api/notes/${post.body.id}`, { reason: 'done' }, session)
    expect(del.status).toBe(200)
    expect(getTeamNote(post.body.id)).toMatchObject({ deleted_by: 'alex', delete_reason: 'done' })
    const device = await call('POST', '/api/notes', { assignee: 'cody', content: 'from a phone' }, { kind: 'device', device: 'Alex phone', deviceId: 1 } as RouteContext['auth'])
    expect(getTeamNote(device.body.id)!.created_by).toBe('Alex phone')
    // The signed-in user wins over a name in the body (the page sends the owner name).
    const named = await call('POST', '/api/notes', { assignee: 'cody', content: 'y', created_by: 'margo' }, session)
    expect(getTeamNote(named.body.id)!.created_by).toBe('alex')
    // A token caller is named by the body.
    const agent = await call('POST', '/api/notes', { assignee: 'cody', content: 'z', created_by: 'margo' }, { kind: 'token' } as RouteContext['auth'])
    expect(getTeamNote(agent.body.id)!.created_by).toBe('margo')
  })

  it('DELETE: a too-long reason is a 400 (not cut short) and a malformed id a 400 (not a 500)', async () => {
    const id = await create({ assignee: 'cody', content: 'x' })
    const long = await call('DELETE', `/api/notes/${id}`, { by: 'cody', reason: 'r'.repeat(2001) })
    expect(long.status).toBe(400)
    expect(getTeamNote(id)!.deleted_at).toBeNull()
    expect((await call('DELETE', '/api/notes/%E0%A4%A', { by: 'cody' })).status).toBe(400)
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
      [{ assignee: 'cody', content: 'x', created_by: 'gazda', due_date: '0000-01-01' }, 'YYYY-MM-DD'],
      [{ assignee: 'cody', content: 'x', created_by: 'gazda', due_date: '1969-12-31' }, 'YYYY-MM-DD'],
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
