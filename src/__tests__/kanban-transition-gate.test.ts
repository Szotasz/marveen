// KANBANEVIDENCEWARN1120 (card 4d1e768e): "done" only with evidence, "waiting" only with a
// reason. Default `warn`: the move goes through, the answer carries `warning` and a system
// comment lands on the card. KANBAN_DONE_EVIDENCE_MODE / KANBAN_WAITING_REASON_MODE = block:
// 409, card unchanged.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Readable } from 'node:stream'
import { initDatabase, getDb, WAITING_REASON_WINDOW_SEC } from '../db.js'
import { tryHandleKanban, KANBAN_WAITING_REASON_WINDOW_SEC, kanbanGateMode } from '../web/routes/kanban.js'
import { MAIN_AGENT_ID } from '../config.js'
import { getSettingDefinition } from '../config-registry.js'
import type { RouteContext } from '../web/routes/types.js'

// The two mode keys as the settings layer would resolve them; every other key goes to the real store.
const modes = vi.hoisted(() => ({ values: {} as Record<string, string> }))
vi.mock('../settings-store.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../settings-store.js')>()
  return {
    ...real,
    getEffectiveSettingValue: (key: string) =>
      key in modes.values ? modes.values[key] : real.getEffectiveSettingValue(key),
  }
})

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

const CARD = 'GATE0001'
const AGENT = MAIN_AGENT_ID
const readCard = (): any => getDb().prepare('SELECT * FROM kanban_cards WHERE id = ?').get(CARD)
const comments = (): Array<{ author: string; content: string; created_at: number }> =>
  getDb().prepare('SELECT author, content, created_at FROM kanban_comments WHERE card_id = ? ORDER BY id').all(CARD) as any

function seed(status = 'in_progress') {
  const now = Math.floor(Date.now() / 1000)
  getDb().prepare(
    'INSERT INTO kanban_cards (id, title, status, assignee, priority, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(CARD, 'Card', status, AGENT, 'normal', 0, now - 3600, now - 3600)
}
function comment(author: string, ageSec = 0) {
  const t = Math.floor(Date.now() / 1000) - ageSec
  getDb().prepare('INSERT INTO kanban_comments (card_id, author, content, created_at) VALUES (?, ?, ?, ?)').run(CARD, author, 'megjegyzés', t)
}

beforeEach(() => {
  // The registry defaults, so the suite runs on what a fresh install resolves.
  modes.values = {
    KANBAN_DONE_EVIDENCE_MODE: String(getSettingDefinition('KANBAN_DONE_EVIDENCE_MODE')!.default),
    KANBAN_WAITING_REASON_MODE: String(getSettingDefinition('KANBAN_WAITING_REASON_MODE')!.default),
  }
  initDatabase(':memory:')
  seed()
})

describe('mode switches', () => {
  it('the registry defaults are warn, and only warn|block are accepted', () => {
    for (const k of ['KANBAN_DONE_EVIDENCE_MODE', 'KANBAN_WAITING_REASON_MODE']) {
      expect(getSettingDefinition(k)!.default).toBe('warn')
      expect(getSettingDefinition(k)!.valueSet).toEqual(['warn', 'block'])
      expect(getSettingDefinition(k)!.loosens!('block', 'warn')).toBe(true)
      expect(getSettingDefinition(k)!.loosens!('warn', 'block')).toBe(false)
    }
  })
  it('the move gate and the audit use the same waiting-reason window', () => {
    expect(KANBAN_WAITING_REASON_WINDOW_SEC).toBe(WAITING_REASON_WINDOW_SEC)
  })
  it('default is warn for both', () => {
    expect(kanbanGateMode('KANBAN_DONE_EVIDENCE_MODE')).toBe('warn')
    expect(kanbanGateMode('KANBAN_WAITING_REASON_MODE')).toBe('warn')
  })
  it('block is read from the settings layer', () => {
    modes.values.KANBAN_DONE_EVIDENCE_MODE = 'block'
    modes.values.KANBAN_WAITING_REASON_MODE = 'block'
    expect(kanbanGateMode('KANBAN_DONE_EVIDENCE_MODE')).toBe('block')
    expect(kanbanGateMode('KANBAN_WAITING_REASON_MODE')).toBe('block')
  })
  it('an unknown value reads as warn, never as a refusal', () => {
    modes.values.KANBAN_DONE_EVIDENCE_MODE = 'blokk'
    expect(kanbanGateMode('KANBAN_DONE_EVIDENCE_MODE')).toBe('warn')
  })
})

describe('done without evidence (warn, the default)', () => {
  it('human close, no evidence, no comment: done, warning no_evidence, system comment on the card', async () => {
    const out = await call(`/api/kanban/${CARD}/move`, 'POST', { status: 'done' })
    expect(out.status).toBe(200)
    expect(out.body.ok).toBe(true)
    expect(out.body.warning).toBe('no_evidence')
    expect(readCard().status).toBe('done')
    const c = comments()
    expect(c).toHaveLength(1)
    expect(c[0].author).toBe('system')
    expect(c[0].content).toContain('bizonyíték nélkül')
  })

  it('NEGATIVE: evidence in the request: no warning, no comment', async () => {
    const out = await call(`/api/kanban/${CARD}/move`, 'POST', { status: 'done', evidence: 'vitest 5/5' })
    expect(out.body).toEqual({ ok: true })
    expect(comments()).toHaveLength(0)
  })

  it('NEGATIVE: a result comment since the work started counts as evidence', async () => {
    comment('tom')
    const out = await call(`/api/kanban/${CARD}/move`, 'POST', { status: 'done' })
    expect(out.body.warning).toBeUndefined()
    expect(comments()).toHaveLength(1)
  })

  it('NEGATIVE: an agent without evidence still lands in testing (unchanged), no gate warning', async () => {
    const out = await call(`/api/kanban/${CARD}/move`, 'POST', { status: 'done', actor: AGENT })
    expect(readCard().status).toBe('testing')
    expect(out.body.evidence_required).toBe(true)
    expect(out.body.warning).toBeUndefined()
  })

  it('NEGATIVE: a reorder inside done is not a transition', async () => {
    getDb().prepare("UPDATE kanban_cards SET status = 'done' WHERE id = ?").run(CARD)
    const out = await call(`/api/kanban/${CARD}/move`, 'POST', { status: 'done', sort_order: 3 })
    expect(out.body.warning).toBeUndefined()
    expect(comments()).toHaveLength(0)
  })

  it('the gate comment does not count as evidence for the next close', async () => {
    await call(`/api/kanban/${CARD}/move`, 'POST', { status: 'done' })
    await call(`/api/kanban/${CARD}/move`, 'POST', { status: 'in_progress' })
    const out = await call(`/api/kanban/${CARD}/move`, 'POST', { status: 'done' })
    expect(out.body.warning).toBe('no_evidence')
  })

  it('PUT to done without a comment: warning and system comment too', async () => {
    const out = await call(`/api/kanban/${CARD}`, 'PUT', { status: 'done' })
    expect(out.status).toBe(200)
    expect(out.body.warning).toBe('no_evidence')
    expect(readCard().status).toBe('done')
    expect(comments().filter((c) => c.author === 'system')).toHaveLength(1)
  })
})

describe('done without evidence (block)', () => {
  beforeEach(() => { modes.values.KANBAN_DONE_EVIDENCE_MODE = 'block' })

  it('move: 409, card unchanged, no comment', async () => {
    const out = await call(`/api/kanban/${CARD}/move`, 'POST', { status: 'done' })
    expect(out.status).toBe(409)
    expect(out.body.error).toBe('evidence_required')
    expect(out.body.warning).toBe('no_evidence')
    expect(readCard().status).toBe('in_progress')
    expect(comments()).toHaveLength(0)
  })

  it('PUT: 409, card unchanged', async () => {
    const out = await call(`/api/kanban/${CARD}`, 'PUT', { status: 'done' })
    expect(out.status).toBe(409)
    expect(readCard().status).toBe('in_progress')
  })

  it('NEGATIVE: with evidence the close goes through', async () => {
    const out = await call(`/api/kanban/${CARD}/move`, 'POST', { status: 'done', evidence: 'PR #12, vitest zöld' })
    expect(out.status).toBe(200)
    expect(readCard().status).toBe('done')
  })

  it('NEGATIVE: block on done does not touch waiting', async () => {
    const out = await call(`/api/kanban/${CARD}/move`, 'POST', { status: 'waiting' })
    expect(out.status).toBe(200)
    expect(out.body.warning).toBe('no_waiting_reason')
  })

  it('NEGATIVE: an expected_status conflict is still a status_conflict, not a gate refusal', async () => {
    const out = await call(`/api/kanban/${CARD}/move`, 'POST', { status: 'done', expected_status: 'planned' })
    expect(out.status).toBe(409)
    expect(out.body.error).toBe('status_conflict')
  })
})

describe('waiting without a reason (warn, the default)', () => {
  it('no reason, no recent comment: waiting, warning no_waiting_reason, system comment', async () => {
    const out = await call(`/api/kanban/${CARD}/move`, 'POST', { status: 'waiting', actor: AGENT })
    expect(out.status).toBe(200)
    expect(out.body.ok).toBe(true)
    expect(out.body.warning).toBe('no_waiting_reason')
    expect(readCard().status).toBe('waiting')
    const c = comments()
    expect(c).toHaveLength(1)
    expect(c[0].author).toBe('system')
    expect(c[0].content).toContain('indoklás nélkül')
  })

  it('reason in the request: no warning, the reason lands as the mover\'s comment', async () => {
    const out = await call(`/api/kanban/${CARD}/move`, 'POST', { status: 'waiting', actor: AGENT, reason: '  Tom jóváhagyására vár  ' })
    expect(out.body).toEqual({ ok: true })
    const c = comments()
    expect(c).toHaveLength(1)
    expect(c[0].author).toBe(AGENT)
    expect(c[0].content).toBe('Várakozás oka: Tom jóváhagyására vár')
  })

  it('a blank reason counts as none', async () => {
    const out = await call(`/api/kanban/${CARD}/move`, 'POST', { status: 'waiting', reason: '   ' })
    expect(out.body.warning).toBe('no_waiting_reason')
  })

  it('NEGATIVE: a comment written just before the move counts as the reason (the agent recipe)', async () => {
    comment(AGENT, 60)
    const out = await call(`/api/kanban/${CARD}/move`, 'POST', { status: 'waiting', actor: AGENT })
    expect(out.body.warning).toBeUndefined()
  })

  it('a comment older than the window does not count', async () => {
    comment(AGENT, KANBAN_WAITING_REASON_WINDOW_SEC + 120)
    const out = await call(`/api/kanban/${CARD}/move`, 'POST', { status: 'waiting', actor: AGENT })
    expect(out.body.warning).toBe('no_waiting_reason')
  })

  it('a system comment does not count', async () => {
    comment('system', 10)
    const out = await call(`/api/kanban/${CARD}/move`, 'POST', { status: 'waiting' })
    expect(out.body.warning).toBe('no_waiting_reason')
  })

  it('reason must be a string', async () => {
    const out = await call(`/api/kanban/${CARD}/move`, 'POST', { status: 'waiting', reason: 42 })
    expect(out.status).toBe(400)
    expect(readCard().status).toBe('in_progress')
  })

  it('NEGATIVE: other transitions carry no gate warning', async () => {
    const out = await call(`/api/kanban/${CARD}/move`, 'POST', { status: 'planned' })
    expect(out.body).toEqual({ ok: true })
    expect(comments()).toHaveLength(0)
  })
})

describe('waiting without a reason (block)', () => {
  beforeEach(() => { modes.values.KANBAN_WAITING_REASON_MODE = 'block' })

  it('move: 409, card unchanged', async () => {
    const out = await call(`/api/kanban/${CARD}/move`, 'POST', { status: 'waiting', actor: AGENT })
    expect(out.status).toBe(409)
    expect(out.body.error).toBe('waiting_reason_required')
    expect(readCard().status).toBe('in_progress')
    expect(comments()).toHaveLength(0)
  })

  it('NEGATIVE: with a reason it goes through', async () => {
    const out = await call(`/api/kanban/${CARD}/move`, 'POST', { status: 'waiting', reason: 'a szolgáltató válaszára vár' })
    expect(out.status).toBe(200)
    expect(readCard().status).toBe('waiting')
  })

  it('PUT to waiting without a recent comment: 409', async () => {
    const out = await call(`/api/kanban/${CARD}`, 'PUT', { status: 'waiting' })
    expect(out.status).toBe(409)
    expect(readCard().status).toBe('in_progress')
  })
})
