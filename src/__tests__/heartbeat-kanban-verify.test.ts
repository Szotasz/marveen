import { describe, it, expect, beforeAll } from 'vitest'
import { EventEmitter } from 'node:events'
import { initDatabase, getDb, getHeartbeatKanbanLive } from '../db.js'
import { MAIN_AGENT_ID } from '../config.js'
import { tryHandleMessages } from '../web/routes/messages.js'
import { parseKanbanClaims, verifyHeartbeatKanban, HEARTBEAT_KANBAN_WINDOW_SEC } from '../web/heartbeat-kanban-verify.js'
import type { RouteContext } from '../web/routes/types.js'

// HBFABRIC1003 (measured 2026-10-03, EGRESSPHANTOM1003): the 17:00 digest named a
// card that never existed (EGRESSFP1003) and counts off by one (414/696 against a
// live 415/695), with zero cards moving in that hour. The send-time check must
// refuse exactly that, and must still let a real digest and an honest
// "could not measure" line through.

function fakeCtx(body: unknown): { ctx: RouteContext; res: { statusCode: number; body: string } } {
  const req = new EventEmitter() as unknown as RouteContext['req'] & { destroy(): void }
  ;(req as unknown as { headers: Record<string, string> }).headers = {}
  ;(req as { destroy(): void }).destroy = () => { /* readBody over-limit hook */ }
  const state = { statusCode: 0, body: '' }
  const res = {
    writeHead(code: number) { state.statusCode = code; return res },
    end(data?: unknown) { state.body = String(data ?? '') },
    setHeader() { /* not used by json() */ },
  } as unknown as RouteContext['res']
  process.nextTick(() => {
    ;(req as unknown as EventEmitter).emit('data', Buffer.from(JSON.stringify(body)))
    ;(req as unknown as EventEmitter).emit('end')
  })
  const path = '/api/messages'
  return { ctx: { req, res, path, method: 'POST', url: new URL(`http://localhost${path}`), fedPeer: null }, res: state }
}

async function post(content: string): Promise<{ statusCode: number; json: Record<string, unknown> }> {
  const { ctx, res } = fakeCtx({ from: MAIN_AGENT_ID, to: MAIN_AGENT_ID, content })
  expect(await tryHandleMessages(ctx)).toBe(true)
  return { statusCode: res.statusCode, json: res.body ? JSON.parse(res.body) : {} }
}

const rows = (needle: string) =>
  (getDb().prepare('SELECT count(*) AS n FROM agent_messages WHERE content LIKE ?').get(`%${needle}%`) as { n: number }).n

const HOUR_AGO = () => Math.floor(Date.now() / 1000) - 3600

function card(id: string, status: string, priority = 'normal', archived = false, updatedAt = HOUR_AGO()) {
  getDb().prepare(
    'INSERT INTO kanban_cards (id, title, status, priority, created_at, updated_at, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(id, `card ${id}`, status, priority, updatedAt, updatedAt, archived ? updatedAt : null)
}

// The board: nothing moved in the last hour, so the tolerance is 0 -- the 17:00 situation.
// urgent 2 (U1, U2 are planned+urgent), in_progress 1, waiting 3, planned 4 (P1, P2, U1, U2).
beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
  card('U1-HBF', 'planned', 'urgent')
  card('U2-HBF', 'planned', 'urgent')
  card('I1-HBF', 'in_progress')
  card('W1-HBF', 'waiting')
  card('W2-HBF', 'waiting')
  card('W3-HBF', 'waiting')
  card('P1-HBF', 'planned')
  card('P2-HBF', 'planned')
  card('OLD-HBF', 'waiting', 'normal', true)
})

function digest(kanban: string, marker: string): string {
  return [
    '## Heartbeat 2026-10-03 17:00 (Europe/Budapest)',
    'merve: 2026-10-03 17:00',
    '',
    '### Calendar (next 2h)',
    '- no upcoming events',
    '',
    '### Kanban',
    kanban,
    '',
    '### Tasks',
    '- enabled schedules: 39',
    marker,
  ].join('\n')
}

const REAL = [
  '- urgent: 2 (U1-HBF, U2-HBF)',
  '- in_progress: 1',
  '- waiting: 3 (8 legfrissebb: W1-HBF, W2-HBF, W3-HBF)',
  '- planned: 4',
].join('\n')

describe('the live board the check reads', () => {
  it('counts the seeded cards and sees no movement in the window', () => {
    const live = getHeartbeatKanbanLive(HEARTBEAT_KANBAN_WINDOW_SEC)
    expect(live.counts).toEqual({ urgent: 2, in_progress: 1, waiting: 3, planned: 4 })
    expect(live.movedInWindow).toBe(0)
    expect(live.card('NOPE-HBF')).toBeNull()
    expect(live.card('OLD-HBF')?.archived).toBe(true)
  })
})

describe('parseKanbanClaims', () => {
  it('reads the 2026-10-03 17:00 digest as sent (msg 33659)', () => {
    const sent = [
      '## Heartbeat 2026-10-03 17:00 (Europe/Budapest)',
      '### Kanban',
      '- urgent: 2 (VAULTSZELES826, SEMPELIOROOM917)',
      '- in_progress: 3',
      '- waiting: 414 (8 legfrissebb: EGRESSFP1003, PR1682PERSONAFU1003, MIOIOSINSTALLUX1003)',
      '- planned: 696',
      '',
      '### Tasks',
      '- waiting: 9999 (NOT-KANBAN)',
    ].join('\n')
    expect(parseKanbanClaims(sent)).toEqual([
      { key: 'urgent', count: 2, ids: ['VAULTSZELES826', 'SEMPELIOROOM917'] },
      { key: 'in_progress', count: 3, ids: [] },
      { key: 'waiting', count: 414, ids: ['EGRESSFP1003', 'PR1682PERSONAFU1003', 'MIOIOSINSTALLUX1003'] },
      { key: 'planned', count: 696, ids: [] },
    ])
  })

  it('a non-numeric value is not a count claim', () => {
    expect(parseKanbanClaims('## Heartbeat x\n### Kanban\n- waiting: meresi hiba')).toEqual([{ key: 'waiting', count: null, ids: [] }])
  })
})

describe('POST /api/messages checks a digest against the live board (HBFABRIC1003)', () => {
  it('the 17:00 shape -- a card that never existed at the head of the waiting list: 422, nothing written', async () => {
    const r = await post(digest(REAL.replace('W1-HBF, W2-HBF', 'EGRESSFP1003, W1-HBF'), 'fab-id-marker-41a7'))
    expect(r.statusCode).toBe(422)
    expect(String(r.json.error)).toMatch(/heartbeat_kanban_mismatch/)
    expect(r.json.problems).toEqual(['waiting: card EGRESSFP1003 does not exist'])
    expect(rows('fab-id-marker-41a7')).toBe(0)
  })

  it('the 17:00 counts -- off by ONE with nothing moved (tolerance 0): 422 for each wrong line', async () => {
    const off = REAL.replace('- waiting: 3', '- waiting: 2').replace('- planned: 4', '- planned: 5')
    const r = await post(digest(off, 'fab-count-marker-82c3'))
    expect(r.statusCode).toBe(422)
    expect(r.json.problems).toEqual([
      'waiting: sent 2, live 3 (tolerance 0)',
      'planned: sent 5, live 4 (tolerance 0)',
    ])
    expect(rows('fab-count-marker-82c3')).toBe(0)
  })

  it('a real card on the wrong line, and an archived card: 422', async () => {
    const r = await post(digest(REAL.replace('W3-HBF', 'P1-HBF, OLD-HBF'), 'fab-state-marker-19e0'))
    expect(r.statusCode).toBe(422)
    expect(r.json.problems).toEqual([
      'waiting: card P1-HBF is planned, not waiting',
      'waiting: card OLD-HBF is archived',
    ])
    expect(rows('fab-state-marker-19e0')).toBe(0)
  })

  // POSITIVE CONTROL for every "nothing written" above: the same route and
  // sender with the true lines writes the row.
  it('the real digest is accepted and written', async () => {
    const r = await post(digest(REAL, 'real-digest-marker-6d2b'))
    expect(r.statusCode).toBe(200)
    expect(rows('real-digest-marker-6d2b')).toBe(1)
  })

  it('an honest "could not measure" line is not refused', async () => {
    const r = await post(digest('- waiting: meresi hiba (a vegpont nem valaszolt)\n- planned: 4', 'honest-marker-3e88'))
    expect(r.statusCode).toBe(200)
    expect(rows('honest-marker-3e88')).toBe(1)
  })

  it('a message that is not a digest (no "## Heartbeat " first line) is not checked', async () => {
    const r = await post(`[Samu] a 17:00-s digest ezt irta:\n### Kanban\n- waiting: 414 (EGRESSFP1003)\nquote-marker-7b51`)
    expect(r.statusCode).toBe(200)
    expect(rows('quote-marker-7b51')).toBe(1)
  })
})

describe('the tolerance is the movement the board really had', () => {
  it('cards moved in the window: an off-by-one count and a just-moved card are accepted', () => {
    const now = Math.floor(Date.now() / 1000)
    const live = {
      counts: { urgent: 2, in_progress: 1, waiting: 3, planned: 4 },
      movedInWindow: 1,
      card: (id: string) => (id === 'W9-JUST' ? { status: 'planned', priority: 'normal', archived: false, movedInWindow: true } : null),
    }
    const content = digest('- waiting: 4 (W9-JUST)\n- planned: 4', `m${now}`)
    expect(verifyHeartbeatKanban(content, live)).toEqual({ ok: true })
    expect(verifyHeartbeatKanban(content.replace('- waiting: 4', '- waiting: 5'), live)).toEqual({
      ok: false, problems: ['waiting: sent 5, live 3 (tolerance 1)'],
    })
  })

  it('a card touched inside the window counts toward the live tolerance', () => {
    card('MOVED-HBF', 'waiting', 'normal', false, Math.floor(Date.now() / 1000))
    const live = getHeartbeatKanbanLive(HEARTBEAT_KANBAN_WINDOW_SEC)
    expect(live.movedInWindow).toBe(1)
    expect(live.card('MOVED-HBF')?.movedInWindow).toBe(true)
    getDb().prepare("DELETE FROM kanban_cards WHERE id = 'MOVED-HBF'").run()
  })
})
