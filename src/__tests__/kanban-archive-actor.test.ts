// KANBANARCHIVEACTOR1122: an archive leaves a trace of who did it (#3036 review note 2).
//
// Before this, archiveKanbanCard set archived_at and updated_at and nothing else: a card that left the
// board could not be traced to an agent, a person or the done-card sweep. Every archive path now writes
// one kanban_card_field_events row (field 'archived_at', old and new value, the actor):
//   - the dedicated archive / unarchive functions and their routes (an optional {actor} body),
//   - a PUT that sets archived_at (archived_at joined KANBAN_AUDITED_FIELDS),
//   - the done-card sweep, with the actor KANBAN_SWEEP_ACTOR.
// And the status trail (kanban_card_events) does not move: its readers take every row as a status change.

import { describe, it, expect, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import {
  initDatabase,
  getDb,
  createKanbanCard,
  updateKanbanCard,
  getKanbanCard,
  getKanbanCardEvents,
  getKanbanCardFieldEvents,
  archiveKanbanCard,
  unarchiveKanbanCard,
  sweepArchivedKanbanCards,
  KANBAN_SWEEP_ACTOR,
} from '../db.js'
import { tryHandleKanban } from '../web/routes/kanban.js'
import type { RouteContext } from '../web/routes/types.js'

function archiveRows(cardId: string) {
  return getKanbanCardFieldEvents(cardId)
    .filter(e => e.field === 'archived_at')
    .map(({ old_value, new_value, actor }) => ({ old: old_value, archived: new_value !== null, actor }))
}

beforeEach(() => {
  initDatabase(':memory:')
})

describe('archiveKanbanCard / unarchiveKanbanCard: one archived_at row each, with the actor', () => {
  it('archive then unarchive: two rows, the actor on each, no status event', () => {
    createKanbanCard({ id: 'a1', title: 'Done work', status: 'done' })
    const statusEvents = getKanbanCardEvents('a1').length

    expect(archiveKanbanCard('a1', 'elvis')).toBe(true)
    const stamped = getKanbanCard('a1')!.archived_at
    expect(stamped).not.toBeNull()
    expect(unarchiveKanbanCard('a1', 'colleague:judit')).toBe(true)

    expect(archiveRows('a1')).toEqual([
      { old: null, archived: true, actor: 'elvis' },
      { old: String(stamped), archived: false, actor: 'colleague:judit' },
    ])
    expect(getKanbanCardEvents('a1')).toHaveLength(statusEvents)
  })

  it('no actor given: the row is still written, actor null (the dashboard button sends none)', () => {
    createKanbanCard({ id: 'a2', title: 'Anonymous', status: 'done' })
    expect(archiveKanbanCard('a2')).toBe(true)
    expect(archiveRows('a2')).toEqual([{ old: null, archived: true, actor: null }])
  })

  it('a card that does not exist: false, no row; an unarchive of a live card: false, no row', () => {
    expect(archiveKanbanCard('nope', 'elvis')).toBe(false)
    expect(getKanbanCardFieldEvents('nope')).toHaveLength(0)
    createKanbanCard({ id: 'live', title: 'On the board' })
    expect(unarchiveKanbanCard('live', 'elvis')).toBe(false)
    expect(getKanbanCardFieldEvents('live')).toHaveLength(0)
  })
})

describe('the other two archive paths', () => {
  it('a PUT that sets archived_at writes the same row (archived_at is an audited field)', () => {
    createKanbanCard({ id: 'p1', title: 'Through PUT', status: 'done' })
    expect(updateKanbanCard('p1', { archived_at: 1790000000 }, 'lead')).toBe(true)
    expect(archiveRows('p1')).toEqual([{ old: null, archived: true, actor: 'lead' }])
  })

  it('the done-card sweep: one row per swept card, actor KANBAN_SWEEP_ACTOR; a fresh or open card is left alone', () => {
    createKanbanCard({ id: 's-old', title: 'Old done', status: 'done' })
    createKanbanCard({ id: 's-new', title: 'Fresh done', status: 'done' })
    createKanbanCard({ id: 's-open', title: 'Old open', status: 'in_progress' })
    getDb().prepare("UPDATE kanban_cards SET updated_at = 1 WHERE id IN ('s-old', 's-open')").run()

    expect(sweepArchivedKanbanCards()).toBe(1)

    expect(KANBAN_SWEEP_ACTOR).toBe('system:auto-archive')
    expect(archiveRows('s-old')).toEqual([{ old: null, archived: true, actor: KANBAN_SWEEP_ACTOR }])
    expect(getKanbanCard('s-new')!.archived_at).toBeNull()
    expect(getKanbanCard('s-open')!.archived_at).toBeNull()
    expect(getKanbanCardFieldEvents('s-new')).toHaveLength(0)
    expect(getKanbanCardFieldEvents('s-open')).toHaveLength(0)
  })
})

describe('the routes: POST /archive and /unarchive take an optional {actor}', () => {
  function ctx(method: string, path: string, raw?: string, auth?: RouteContext['auth']) {
    const out: { status: number; body: any } = { status: 200, body: null }
    const res: any = {
      writeHead(status: number) { out.status = status; return res },
      setHeader() { return res },
      end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
    }
    const req: any = Readable.from(raw === undefined ? [] : [Buffer.from(raw)])
    const url = new URL(`http://localhost:3420${path}`)
    return { c: { req, res, path: url.pathname, method, url, auth } as RouteContext, out }
  }
  async function call(method: string, path: string, raw?: string, auth?: RouteContext['auth']) {
    const { c, out } = ctx(method, path, raw, auth)
    expect(await tryHandleKanban(c)).toBe(true)
    return out
  }

  it('with {actor}: 200, the row names it, and /field-events returns it', async () => {
    createKanbanCard({ id: 'r1', title: 'Route', status: 'done' })
    expect((await call('POST', '/api/kanban/r1/archive', JSON.stringify({ actor: 'elvis' }))).status).toBe(200)
    const fields = await call('GET', '/api/kanban/r1/field-events')
    expect(fields.body).toHaveLength(1)
    expect(fields.body[0]).toMatchObject({ field: 'archived_at', old_value: null, actor: 'elvis' })
  })

  it('unarchive with {actor}: 200, the unarchive row names it (review point 1 on #3044)', async () => {
    createKanbanCard({ id: 'r5', title: 'Unarchive actor', status: 'done' })
    expect((await call('POST', '/api/kanban/r5/archive', JSON.stringify({ actor: 'elvis' }))).status).toBe(200)
    expect((await call('POST', '/api/kanban/r5/unarchive', JSON.stringify({ actor: 'x' }))).status).toBe(200)
    expect(archiveRows('r5')).toEqual([
      { old: null, archived: true, actor: 'elvis' },
      { old: expect.anything(), archived: false, actor: 'x' },
    ])
  })

  it('a "system:" actor is refused on every route BEFORE the write (KANBANSYSACTOR1123, review N1 on #3044)', async () => {
    createKanbanCard({ id: 'r6', title: 'Reserved actor', status: 'done' })
    for (const actor of [KANBAN_SWEEP_ACTOR, 'system:anything', 'SYSTEM:auto-archive', '  system:auto-archive']) {
      const body = JSON.stringify({ actor })
      const a = await call('POST', '/api/kanban/r6/archive', body)
      expect(a.status, actor).toBe(400)
      expect(a.body.error).toMatch(/system:/)
      expect((await call('PUT', '/api/kanban/r6', JSON.stringify({ title: 'x', actor }))).status, actor).toBe(400)
      expect((await call('POST', '/api/kanban/r6/move', JSON.stringify({ status: 'planned', actor }))).status, actor).toBe(400)
    }
    const card = getKanbanCard('r6')!
    expect(card.archived_at).toBeNull()
    expect(card.title).toBe('Reserved actor')
    expect(card.status).toBe('done')
    expect(getKanbanCardFieldEvents('r6')).toHaveLength(0)
    // an archived card: its unarchive is refused the same way
    expect((await call('POST', '/api/kanban/r6/archive', JSON.stringify({ actor: 'elvis' }))).status).toBe(200)
    expect((await call('POST', '/api/kanban/r6/unarchive', JSON.stringify({ actor: KANBAN_SWEEP_ACTOR }))).status).toBe(400)
    expect(getKanbanCard('r6')!.archived_at).not.toBeNull()
    // a name that only contains the word is fine
    expect((await call('POST', '/api/kanban/r6/unarchive', JSON.stringify({ actor: 'ops-system:x' }))).status).toBe(200)
  })

  it('an empty body still works (the dashboard button, older callers): 200, actor null', async () => {
    createKanbanCard({ id: 'r2', title: 'Button', status: 'done' })
    expect((await call('POST', '/api/kanban/r2/archive')).status).toBe(200)
    expect((await call('POST', '/api/kanban/r2/unarchive', '{}')).status).toBe(200)
    expect(archiveRows('r2').map(r => r.actor)).toEqual([null, null])
  })

  it('a browser session with no actor in the body: the session user is the actor', async () => {
    createKanbanCard({ id: 'r3', title: 'Session', status: 'done' })
    const auth = { kind: 'session', user: 'judit' } as unknown as RouteContext['auth']
    expect((await call('POST', '/api/kanban/r3/archive', '', auth)).status).toBe(200)
    expect(archiveRows('r3')).toEqual([{ old: null, archived: true, actor: 'judit' }])
  })

  it('a bad body is refused BEFORE the write: 400, card not archived, no row', async () => {
    createKanbanCard({ id: 'r4', title: 'Bad body', status: 'done' })
    for (const raw of ['{not json', '[1]', '"elvis"', JSON.stringify({ actor: 42 }), JSON.stringify({ actor: true })]) {
      const out = await call('POST', '/api/kanban/r4/archive', raw)
      expect(out.status, raw).toBe(400)
    }
    expect(getKanbanCard('r4')!.archived_at).toBeNull()
    expect(getKanbanCardFieldEvents('r4')).toHaveLength(0)
  })
})
