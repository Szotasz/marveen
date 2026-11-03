// POST /api/kanban with an id that already exists answers 409, not 500.
//
// Callers may supply their own id (readable slugs, or ids a sync script derives
// from another system). A taken id used to surface as the raw SQLite UNIQUE
// error from the INSERT -- a 500 that a script cannot tell apart from a server
// fault. GET /api/kanban hides archived cards, so "not in the list" was not
// "free": a sync script that re-created archived cards failed on every run.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Readable } from 'node:stream'

// Lets one test force a generated-id collision; every other test gets the real one.
const uuid = vi.hoisted(() => ({ next: null as string | null }))
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  return {
    ...actual,
    randomUUID: () => {
      const forced = uuid.next
      uuid.next = null
      return forced ?? actual.randomUUID()
    },
  }
})
import { initDatabase, getKanbanCard, archiveKanbanCard } from '../db.js'
import { tryHandleKanban } from '../web/routes/kanban.js'
import type { RouteContext } from '../web/routes/types.js'

async function post(payload: unknown): Promise<{ status: number; body: any }> {
  const out: { status: number; body: any } = { status: 200, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    setHeader() { return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const req: any = Readable.from([Buffer.from(JSON.stringify(payload))])
  const url = new URL('http://localhost:3420/api/kanban')
  expect(await tryHandleKanban({ req, res, path: url.pathname, method: 'POST', url } as RouteContext)).toBe(true)
  return out
}

describe('POST /api/kanban with a taken id', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('answers 409 with the id, and leaves the existing card untouched', async () => {
    expect((await post({ id: 'sync-42', title: 'First' })).status).toBe(200)
    const before = getKanbanCard('sync-42')
    const again = await post({ id: 'sync-42', title: 'Second', description: 'other' })
    expect(again.status).toBe(409)
    expect(again.body).toMatchObject({ id: 'sync-42', archived: false })
    expect(typeof again.body.error).toBe('string')
    expect(getKanbanCard('sync-42')).toEqual(before)
  })

  it('says when the existing card is archived (it is not in the board list)', async () => {
    await post({ id: 'sync-43', title: 'Old' })
    expect(archiveKanbanCard('sync-43')).toBe(true)
    const before = getKanbanCard('sync-43')
    const again = await post({ id: 'sync-43', title: 'Old' })
    expect(again.status).toBe(409)
    expect(again.body).toMatchObject({ id: 'sync-43', archived: true })
    expect(getKanbanCard('sync-43')).toEqual(before)
  })

  it('the supplied id is compared after trimming, as it is stored', async () => {
    await post({ id: 'sync-44', title: 'First' })
    expect((await post({ id: '  sync-44 ', title: 'Second' })).status).toBe(409)
  })

  it('any other insert error is still an error, not a 409 (here: a status the table refuses)', async () => {
    await expect(post({ id: 'sync-45', title: 'Bad', status: 'nonsense' })).rejects.toThrow(/CHECK constraint/)
    expect(getKanbanCard('sync-45')).toBeUndefined()
  })

  it('a GENERATED id that collides is not the caller\'s conflict: still an error, not a 409', async () => {
    await post({ id: 'abcd1234', title: 'Holder' })
    uuid.next = 'abcd1234-0000-4000-8000-000000000000'
    await expect(post({ title: 'Unlucky' })).rejects.toThrow(/UNIQUE constraint/)
    expect(getKanbanCard('abcd1234')?.title).toBe('Holder')
  })

  it('control: cards without a supplied id still get fresh ids', async () => {
    const a = await post({ title: 'A' })
    const b = await post({ title: 'B' })
    expect([a.status, b.status]).toEqual([200, 200])
    expect(a.body.id).not.toBe(b.body.id)
  })
})
