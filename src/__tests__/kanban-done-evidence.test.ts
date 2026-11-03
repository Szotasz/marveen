// Evidence on done (one human, many agents): an AGENT closes a card only by
// saying what it checked. Without it a move to done lands in testing and the
// answer says why. A human (no agent actor) closes exactly as before.
import { describe, it, expect, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import { initDatabase, getDb } from '../db.js'
import { tryHandleKanban, KANBAN_EVIDENCE_MAX_CHARS } from '../web/routes/kanban.js'
import { MAIN_AGENT_ID } from '../config.js'
import type { RouteContext } from '../web/routes/types.js'

function fakeCtx(path: string, method: string, body?: unknown) {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) { try { out.body = JSON.parse(chunk) } catch { out.body = chunk } } },
  }
  const payload = body === undefined ? '' : JSON.stringify(body)
  const req: any = Readable.from(payload ? [Buffer.from(payload)] : [])
  req.headers = {}
  const url = new URL(`http://localhost:3420${path}`)
  return { ctx: { req, res, path: url.pathname, method, url } as RouteContext, out }
}

async function call(path: string, method: string, body?: unknown) {
  const { ctx, out } = fakeCtx(path, method, body)
  expect(await tryHandleKanban(ctx)).toBe(true)
  return out
}

const CARD = 'EVID0001'
const AGENT = MAIN_AGENT_ID
const readCard = (): any => getDb().prepare('SELECT * FROM kanban_cards WHERE id = ?').get(CARD)

function seed(status = 'in_progress') {
  const now = Math.floor(Date.now() / 1000)
  getDb().prepare(
    'INSERT INTO kanban_cards (id, title, status, assignee, priority, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(CARD, 'Card', status, AGENT, 'normal', 0, now, now)
}

describe('move to done: evidence required from an agent', () => {
  beforeEach(() => { initDatabase(':memory:'); seed() })

  it('agent + evidence: done, evidence stored', async () => {
    const out = await call(`/api/kanban/${CARD}/move`, 'POST', { status: 'done', actor: AGENT, evidence: '  vitest 12 pass, PR #1  ' })
    expect(out.body).toEqual({ ok: true })
    expect(readCard().status).toBe('done')
    expect(readCard().done_evidence).toBe('vitest 12 pass, PR #1')
  })

  it('NEGATIVE: without evidence the no-comment warning still fires for a human close', async () => {
    const out = await call(`/api/kanban/${CARD}/move`, 'POST', { status: 'done' })
    expect(out.body.evidence_warning).toBeTruthy()
  })

  it('agent without evidence: testing, and the answer says why', async () => {
    const out = await call(`/api/kanban/${CARD}/move`, 'POST', { status: 'done', actor: AGENT })
    expect(out.status).toBe(200)
    expect(out.body.status).toBe('testing')
    expect(out.body.evidence_required).toBe(true)
    expect(readCard().status).toBe('testing')
    expect(readCard().done_evidence).toBeNull()
  })

  it('agent without evidence: ok is false, so a client that only reads ok does not report a closed card', async () => {
    const out = await call(`/api/kanban/${CARD}/move`, 'POST', { status: 'done', actor: AGENT })
    expect(out.body.ok).toBe(false)
    expect(readCard().status).toBe('testing')
  })

  it('agent with blank evidence counts as none', async () => {
    const out = await call(`/api/kanban/${CARD}/move`, 'POST', { status: 'done', actor: AGENT, evidence: '   ' })
    expect(out.body.evidence_required).toBe(true)
    expect(readCard().status).toBe('testing')
  })

  it('the agent match is case-insensitive', async () => {
    await call(`/api/kanban/${CARD}/move`, 'POST', { status: 'done', actor: AGENT.toUpperCase() })
    expect(readCard().status).toBe('testing')
  })

  it('NEGATIVE: a human (no actor, or a non-agent name) closes as before', async () => {
    let out = await call(`/api/kanban/${CARD}/move`, 'POST', { status: 'done' })
    expect(out.body).toMatchObject({ ok: true })
    expect(out.body.evidence_required).toBeUndefined()
    expect(readCard().status).toBe('done')
    getDb().prepare("UPDATE kanban_cards SET status='in_progress' WHERE id=?").run(CARD)
    out = await call(`/api/kanban/${CARD}/move`, 'POST', { status: 'done', actor: 'Some Human' })
    expect(out.body).toMatchObject({ ok: true })
    expect(out.body.evidence_required).toBeUndefined()
    expect(readCard().status).toBe('done')
  })

  it('NEGATIVE: evidence on a move elsewhere is not stored', async () => {
    await call(`/api/kanban/${CARD}/move`, 'POST', { status: 'waiting', actor: AGENT, evidence: 'x' })
    expect(readCard().status).toBe('waiting')
    expect(readCard().done_evidence).toBeNull()
  })

  it('refuses a non-string or oversized evidence before writing', async () => {
    let out = await call(`/api/kanban/${CARD}/move`, 'POST', { status: 'done', actor: AGENT, evidence: 5 })
    expect(out.status).toBe(400)
    out = await call(`/api/kanban/${CARD}/move`, 'POST', { status: 'done', actor: AGENT, evidence: 'x'.repeat(KANBAN_EVIDENCE_MAX_CHARS + 1) })
    expect(out.status).toBe(400)
    expect(readCard().status).toBe('in_progress')
  })
})

describe('PUT cannot route around the rule', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('agent PUT status:done goes to testing', async () => {
    seed()
    const out = await call(`/api/kanban/${CARD}`, 'PUT', { status: 'done', actor: AGENT })
    expect(out.body.evidence_required).toBe(true)
    expect(readCard().status).toBe('testing')
  })

  it('agent PUT status:done: ok is false as well', async () => {
    seed()
    const out = await call(`/api/kanban/${CARD}`, 'PUT', { status: 'done', actor: AGENT })
    expect(out.body.ok).toBe(false)
  })

  it('NEGATIVE: agent PUT of an unrelated edit on an already-done card does not reopen it', async () => {
    seed('done')
    const out = await call(`/api/kanban/${CARD}`, 'PUT', { status: 'done', priority: 'high', actor: AGENT, done_evidence: 'ignored' })
    expect(out.body).toMatchObject({ ok: true })
    expect(out.body.evidence_required).toBeUndefined()
    expect(readCard().status).toBe('done')
    expect(readCard().priority).toBe('high')
  })

  it('NEGATIVE: human PUT to done is unchanged', async () => {
    seed()
    const out = await call(`/api/kanban/${CARD}`, 'PUT', { status: 'done' })
    expect(out.body).toMatchObject({ ok: true })
    expect(out.body.evidence_required).toBeUndefined()
    expect(readCard().status).toBe('done')
  })
})
