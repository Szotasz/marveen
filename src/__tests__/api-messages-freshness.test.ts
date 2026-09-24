import { describe, it, expect, beforeAll } from 'vitest'

// The freshness/supersession annotation belongs to the message CONTENT, not to
// one delivery path.
//
// The gap this closes: a recipient can read its OWN still-pending mailbox
// (`GET /api/messages`, `GET /api/messages/<id>`) and act on what it finds
// there, while the router injects that same row as the first and only delivery
// some minutes later. The `[!FRISSESSEG ...]` annotation is attached by the
// ROUTER at injection time, so the copy read over the API carried nothing --
// the protection sat on exactly the path the early read bypasses. Long enough
// an interval for the sender to supersede or revoke the instruction in the
// meantime, with the early reader unable to tell.
//
// The router is the REFERENCE here, not the side under change: these tests
// assert the API repeats the router's own string (formatFreshnessSuffix),
// never a second, drifting wording.

import { initDatabase, createAgentMessage, getDb } from '../db.js'
import { formatFreshnessSuffix } from '../web/agent-message-wrap.js'
import { tryHandleMessages } from '../web/routes/messages.js'

beforeAll(() => { initDatabase(':memory:') })

type Json = Record<string, unknown>

async function get(pathAndQuery: string): Promise<{ status: number; json: any }> {
  let status = 200
  let body = ''
  const res = {
    setHeader() {},
    writeHead(s: number) { status = s },
    end(b?: string) { body = b ?? '' },
  } as any
  const url = new URL(`http://localhost${pathAndQuery}`)
  const handled = await tryHandleMessages({
    // `accept-encoding` absent so jsonMaybeGzip answers in plain JSON.
    req: { headers: {} } as any, res, path: url.pathname, method: 'GET', url,
  } as any)
  return { status: handled ? status : -1, json: body ? JSON.parse(body) : null }
}

// Backdate a row so age is measurable without waiting.
function ageRow(id: number, minutes: number): void {
  getDb().prepare('UPDATE agent_messages SET created_at = ? WHERE id = ?')
    .run(Math.floor(Date.now() / 1000) - minutes * 60, id)
}

describe('GET /api/messages/:id carries the freshness signal the router attaches', () => {
  it('annotates a superseded row with the ROUTER\'s own wording, plus the raw numbers', async () => {
    const first = createAgentMessage('marveen', 'olvaso', 'Az elso utasitas.')
    ageRow(first.id, 20)
    createAgentMessage('marveen', 'olvaso', 'Masodik.')
    createAgentMessage('marveen', 'olvaso', 'Harmadik -- ez vonja vissza az elsot.')

    const { status, json } = await get(`/api/messages/${first.id}`)
    expect(status).toBe(200)
    // The row itself is unchanged -- this is an added field, not a rewrite.
    expect(json.content).toBe('Az elso utasitas.')

    expect(json.freshness).toBeDefined()
    // (b) how many newer rows arrived since, from the same sender to the same target
    expect(json.freshness.newerFromSameSender).toBe(2)
    // (a) the row's age in minutes
    expect(json.freshness.ageMinutes).toBe(20)
    // The wording is the router's, character for character -- one source, two paths.
    expect(json.freshness.note).toBe(formatFreshnessSuffix(20 * 60 * 1000, 2).trim())
    expect(json.freshness.note).toContain('!FRISSESSEG')
  })

  it('stays quiet for fresh, unsuperseded traffic so the signal never becomes noise', async () => {
    const solo = createAgentMessage('marveen', 'maganyos', 'Egyetlen, friss uzenet.')

    const { json } = await get(`/api/messages/${solo.id}`)
    expect(json.freshness.newerFromSameSender).toBe(0)
    expect(json.freshness.ageMinutes).toBe(0)
    // Empty note, exactly like the router's suffix for the same inputs.
    expect(json.freshness.note).toBe('')
  })

  it('does not count a FAILED newer row as the current truth (router rule)', async () => {
    const target = createAgentMessage('kuldo', 'cimzett', 'Erre kerdezunk ra.')
    const failed = createAgentMessage('kuldo', 'cimzett', 'Ez sosem ert celba.')
    getDb().prepare("UPDATE agent_messages SET status = 'failed' WHERE id = ?").run(failed.id)

    const { json } = await get(`/api/messages/${target.id}`)
    expect(json.freshness.newerFromSameSender).toBe(0)
  })
})

describe('GET /api/messages (the mailbox list) carries it on every row', () => {
  it('annotates each row of a pending mailbox read -- the exact call the leak was measured on', async () => {
    const a = createAgentMessage('fonok', 'dolgozo', 'Elso feladat.')
    ageRow(a.id, 45)
    const b = createAgentMessage('fonok', 'dolgozo', 'Megse, allj le.')

    const { status, json } = await get('/api/messages?agent=dolgozo&status=pending')
    expect(status).toBe(200)
    const rows = json as Json[]
    const rowA = rows.find((r) => r.id === a.id) as any
    const rowB = rows.find((r) => r.id === b.id) as any

    expect(rowA.freshness.newerFromSameSender).toBe(1)
    expect(rowA.freshness.ageMinutes).toBe(45)
    expect(rowA.freshness.note).toBe(formatFreshnessSuffix(45 * 60 * 1000, 1).trim())
    // The newest row in the thread is nobody's stale copy.
    expect(rowB.freshness.newerFromSameSender).toBe(0)
    expect(rowB.freshness.note).toBe('')
  })

  it('counts per (sender, target) pair, not per mailbox -- two senders do not supersede each other', async () => {
    const fromX = createAgentMessage('x', 'kevert', 'X egyetlen uzenete.')
    ageRow(fromX.id, 12)
    createAgentMessage('y', 'kevert', 'Y elso uzenete.')
    createAgentMessage('y', 'kevert', 'Y masodik uzenete.')

    const { json } = await get('/api/messages?agent=kevert')
    const rowX = (json as Json[]).find((r) => r.id === fromX.id) as any
    // Two newer rows exist in this mailbox, but neither is from X.
    expect(rowX.freshness.newerFromSameSender).toBe(0)
    expect(rowX.freshness.ageMinutes).toBe(12)
  })
})
