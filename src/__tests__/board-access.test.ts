// Scoped board (board-access.ts, routes/board.ts): a colleague-facing sub-agent
// sees only the cards its person is entitled to, enforced server-side.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type http from 'node:http'

// The config goes to a scratch path, never the checkout's store/.
const CFG_FILE = vi.hoisted(() => {
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs')
  const { tmpdir } = require('node:os') as typeof import('node:os')
  const { join } = require('node:path') as typeof import('node:path')
  return join(mkdtempSync(join(tmpdir(), 'board-access-')), 'board-access.json')
})
vi.mock('../web/board-access.js', async (orig) => {
  const real = await orig<typeof import('../web/board-access.js')>()
  return { ...real, readBoardAccess: (p?: string) => real.readBoardAccess(p ?? CFG_FILE) }
})

import { initDatabase, createKanbanCard, getKanbanCard, getKanbanComments, archiveKanbanCard, getDb } from '../db.js'
import {
  normaliseBoardAccess, readBoardAccess, visibleAssignees, cardVisible, resolveBoardPerson, boardGateDecision,
  isKanbanFamilyPath, ALL_CARDS, type BoardAccessConfig,
} from '../web/board-access.js'
import { gateRequest, isAgentAllowed } from '../web/auth-gate.js'
import { tryHandleBoard, buildBoardReport, cardDueDay } from '../web/routes/board.js'
import type { RouteContext } from '../web/routes/types.js'

// ---- fixtures ---------------------------------------------------------------------

const RAW = {
  enabled: true,
  people: {
    alice: { name: 'Alice', assignees: ['alice', ' Alice A. '], role: 'self', senderIds: ['1001'] },
    bob: { name: 'Bob', assignees: ['bob'], role: 'lead', reports: ['alice', 'carol'], senderIds: [1002] },
    carol: { name: 'Carol', assignees: ['carol'], role: 'lead', reports: ['dave', 'bob'] }, // cycle bob <-> carol
    dave: { name: 'Dave', assignees: ['dave'], role: 'self' },
    erin: { name: 'Erin', assignees: ['erin'], role: 'all' },
    frank: { name: 'Frank', assignees: ['frank'], role: 'superuser' }, // unknown role -> self
  },
  agents: {
    'alice-bot': { people: ['alice'] },
    'team-bot': { people: ['alice', 'bob', 'ghost'] },
    'exec-bot': { people: ['erin'] },
    'empty-bot': { people: ['ghost'] },
  },
}
const cfg = (): BoardAccessConfig => normaliseBoardAccess(RAW)
const writeCfg = (v: unknown): void => writeFileSync(CFG_FILE, typeof v === 'string' ? v : JSON.stringify(v))

// ---- normalisation ----------------------------------------------------------------------

describe('normaliseBoardAccess (fail-closed)', () => {
  it('missing file = off, nobody scoped', () => {
    rmSync(CFG_FILE, { force: true })
    const c = readBoardAccess(CFG_FILE)
    expect(c.enabled).toBe(false)
    expect(c.broken).toBe(false)
    expect(c.agents.size).toBe(0)
  })

  it('only literal true enables', () => {
    for (const v of ['true', 1, 'yes', null, undefined, {}]) expect(normaliseBoardAccess({ ...RAW, enabled: v }).enabled).toBe(false)
    expect(cfg().enabled).toBe(true)
  })

  it('an unreadable or non-object file is broken (locks sub-agent tokens out), not off', () => {
    writeCfg('{ not json')
    expect(readBoardAccess(CFG_FILE).broken).toBe(true)
    writeCfg([1, 2])
    expect(readBoardAccess(CFG_FILE).broken).toBe(true)
    expect(normaliseBoardAccess(null).broken).toBe(true)
    expect(normaliseBoardAccess('x').broken).toBe(true)
  })

  it('unknown role -> self; unknown person ids dropped; trimmed/deduped assignees; numeric sender ids kept as strings', () => {
    const c = cfg()
    expect(c.people.get('frank')!.role).toBe('self')
    expect(c.agents.get('team-bot')).toEqual(['alice', 'bob'])
    expect(c.people.get('alice')!.assignees).toEqual(['alice', 'Alice A.'])
    expect(c.people.get('bob')!.senderIds).toEqual(['1002'])
  })

  it('a listed agent with no valid person stays listed (scoped, sees nothing)', () => {
    expect(cfg().agents.get('empty-bot')).toEqual([])
  })

  it('drops malformed person ids and prototype keys safely', () => {
    const c = normaliseBoardAccess({ enabled: true, people: { 'bad id!': { name: 'x' }, ok: 'not-an-object' }, agents: { 'a b': { people: [] } } })
    expect(c.people.size).toBe(0)
    expect(c.agents.size).toBe(0)
    // A JSON "__proto__" key is an own key; it lands in a Map and pollutes nothing.
    const p = normaliseBoardAccess(JSON.parse('{"enabled":true,"people":{"__proto__":{"assignees":["x"]}},"agents":{"__proto__":{"people":["__proto__"]}}}'))
    expect(({} as Record<string, unknown>).assignees).toBeUndefined()
    expect(p.agents.get('__proto__')).toEqual(['__proto__'])
  })
})

// ---- visibility ---------------------------------------------------------------------------

describe('visibleAssignees / cardVisible', () => {
  it('self sees own assignee strings only, case-insensitive and trimmed', () => {
    const v = visibleAssignees(cfg(), 'alice')
    expect(v).toEqual(new Set(['alice', 'alice a.']))
    expect(cardVisible(v, { assignee: '  ALICE ' })).toBe(true)
    expect(cardVisible(v, { assignee: 'bob' })).toBe(false)
    expect(cardVisible(v, { assignee: null })).toBe(false)
  })

  it('lead sees reports recursively, and a cycle terminates', () => {
    const v = visibleAssignees(cfg(), 'bob')
    expect(v).toEqual(new Set(['bob', 'alice', 'alice a.', 'carol', 'dave']))
    const c = visibleAssignees(cfg(), 'carol')
    expect(c).toEqual(new Set(['carol', 'dave', 'bob', 'alice', 'alice a.']))
  })

  it('a self role ignores its reports; unknown role reads as self', () => {
    const c = normaliseBoardAccess({ enabled: true, people: { x: { assignees: ['x'], role: 'self', reports: ['y'] }, y: { assignees: ['y'] } } })
    expect(visibleAssignees(c, 'x')).toEqual(new Set(['x']))
    expect(visibleAssignees(cfg(), 'frank')).toEqual(new Set(['frank']))
  })

  it('all sees every card, unassigned included; an unknown person sees nothing', () => {
    expect(visibleAssignees(cfg(), 'erin')).toBe(ALL_CARDS)
    expect(cardVisible(ALL_CARDS, { assignee: null })).toBe(true)
    expect(visibleAssignees(cfg(), 'nobody')).toEqual(new Set())
  })
})

// ---- person resolution ----------------------------------------------------------------------

describe('resolveBoardPerson', () => {
  it('one mapped person is implied; a header naming someone else is refused', () => {
    const r = resolveBoardPerson(cfg(), 'alice-bot', {})
    expect(r.ok && r.person.id).toBe('alice')
    expect(resolveBoardPerson(cfg(), 'alice-bot', { person: 'bob' })).toMatchObject({ ok: false, status: 403 })
    expect(resolveBoardPerson(cfg(), 'alice-bot', { sender: '1002' })).toMatchObject({ ok: false, status: 403 })
  })

  it('several people need a header; person or sender resolves within the agent only', () => {
    expect(resolveBoardPerson(cfg(), 'team-bot', {})).toMatchObject({ ok: false, status: 400 })
    const byP = resolveBoardPerson(cfg(), 'team-bot', { person: 'bob' })
    expect(byP.ok && byP.person.id).toBe('bob')
    const byS = resolveBoardPerson(cfg(), 'team-bot', { sender: '1001' })
    expect(byS.ok && byS.person.id).toBe('alice')
    // erin exists, but is not team-bot's person: spoofing refused
    expect(resolveBoardPerson(cfg(), 'team-bot', { person: 'erin' })).toMatchObject({ ok: false, status: 403 })
    expect(resolveBoardPerson(cfg(), 'team-bot', { person: 'bob', sender: '1001' })).toMatchObject({ ok: false, status: 400 })
    expect(resolveBoardPerson(cfg(), 'team-bot', { sender: '9999' })).toMatchObject({ ok: false, status: 403 })
  })

  it('an agent with no person, or not listed, resolves to nobody', () => {
    expect(resolveBoardPerson(cfg(), 'empty-bot', {})).toMatchObject({ ok: false, status: 403 })
    expect(resolveBoardPerson(cfg(), 'other', { person: 'alice' })).toMatchObject({ ok: false, status: 403 })
  })
})

// ---- gate -------------------------------------------------------------------------------------

// Every /api path the server handles, from the source (as operator-scope-gate.test.ts does).
function enumerateApiPaths(): string[] {
  const root = join(__dirname, '..')
  const files = [join(root, 'web.ts'), ...readdirSync(join(root, 'web', 'routes')).filter(f => f.endsWith('.ts')).map(f => join(root, 'web', 'routes', f))]
  const out = new Set<string>()
  for (const f of files) {
    const src = readFileSync(f, 'utf-8')
    for (const m of src.matchAll(/'(\/api\/[A-Za-z0-9/_.-]*)'/g)) out.add(m[1]!)
    for (const m of src.matchAll(/\/\^(\\\/api\\\/[^\n]*?)\$\//g)) {
      const p = m[1]!.replace(/\([^)]*\)/g, 'x').replace(/\[[^\]]*\][+*]?/g, 'x').replace(/\\\//g, '/').replace(/[?+*\\]/g, '')
      if (p.startsWith('/api/')) out.add(p)
    }
  }
  return [...out].sort()
}

describe('boardGateDecision', () => {
  const scoped = { kind: 'token', tokenAgent: 'alice-bot' }
  const unlisted = { kind: 'token', tokenAgent: 'worker' }
  const main = { kind: 'token' }
  const C = cfg

  it('a scoped agent is refused on every enumerated kanban path, and on new ones', () => {
    const kanban = enumerateApiPaths().filter((p) => p.startsWith('/api/kanban'))
    expect(kanban.length).toBeGreaterThan(20)
    expect(kanban).toContain('/api/kanban-projects')
    for (const p of [...kanban, '/api/kanban/brand-new-route', '/api/kanban-something-new', '/api//kanban', '/api/%6Banban', '/API/KANBAN']) {
      expect(boardGateDecision(scoped, p, C), p).not.toBeNull()
    }
  })

  it('a scoped agent passes on /api/board/* and on non-kanban paths (the allowlist decides those)', () => {
    for (const p of ['/api/board/cards', '/api/board/cards/x', '/api/board/report', '/api/messages', '/api/memories']) {
      expect(boardGateDecision(scoped, p, C), p).toBeNull()
    }
  })

  it('/api/board/* is refused to every principal that is not scoped', () => {
    for (const a of [main, unlisted, { kind: 'session', user: 'owner' }, { kind: 'device' }, { kind: 'federation' }]) {
      expect(boardGateDecision(a, '/api/board/cards', C), JSON.stringify(a)).not.toBeNull()
    }
  })

  it('main token and unlisted agents keep /api/kanban; the config is not even read for them on non-board paths', () => {
    const spy = vi.fn(C)
    expect(boardGateDecision(main, '/api/kanban', spy)).toBeNull()
    expect(spy).not.toHaveBeenCalled()
    expect(boardGateDecision(unlisted, '/api/kanban/x/move', C)).toBeNull()
  })

  it('feature off: nobody scoped; broken file: every sub-agent token locked out of both families, main token not', () => {
    const off = () => normaliseBoardAccess({ ...RAW, enabled: false })
    expect(boardGateDecision(scoped, '/api/kanban', off)).toBeNull()
    expect(boardGateDecision(scoped, '/api/board/cards', off)).not.toBeNull()
    const broken = () => normaliseBoardAccess('x')
    expect(boardGateDecision(unlisted, '/api/kanban', broken)).not.toBeNull()
    expect(boardGateDecision(scoped, '/api/board/cards', broken)).not.toBeNull()
    expect(boardGateDecision(main, '/api/kanban', broken)).toBeNull()
  })

  it('the sub-agent allowlist lets the board routes through to the board gate', () => {
    for (const [m, p] of [['GET', '/api/board/cards'], ['POST', '/api/board/cards'], ['GET', '/api/board/cards/a1'], ['POST', '/api/board/cards/a1/comments'], ['POST', '/api/board/cards/a1/move'], ['GET', '/api/board/report']]) {
      expect(isAgentAllowed(p!, m!), `${m} ${p}`).toBe(true)
    }
    expect(isAgentAllowed('/api/board/cards/a1', 'DELETE')).toBe(false)
  })

  it('web.ts runs the board gate before the route chain and registers the board routes', () => {
    const src = readFileSync(join(__dirname, '..', 'web.ts'), 'utf-8')
    const gate = src.indexOf('boardGateDecision(auth, path')
    expect(gate).toBeGreaterThan(src.indexOf('await gateRequest('))
    expect(gate).toBeLessThan(src.indexOf('await tryHandleAuth(routeCtx)'))
    expect(src.indexOf('await tryHandleBoard(routeCtx)')).toBeGreaterThan(0)
  })
})

// The same two steps web.ts runs, over the real gate: gateRequest, then boardGateDecision.
describe('gateRequest + board gate (as web.ts composes them)', () => {
  const MAIN = 'm'.repeat(64)
  const TOK: Record<string, string> = { ['s'.repeat(40)]: 'alice-bot', ['w'.repeat(40)]: 'worker' }
  async function through(method: string, path: string, token: string): Promise<number> {
    let status = 0
    const res = { writeHead(c: number) { status = c; return res }, end() {}, setHeader() { return res } } as unknown as http.ServerResponse
    const req = Readable.from([]) as unknown as http.IncomingMessage
    ;(req as unknown as { headers: Record<string, string> }).headers = { authorization: `Bearer ${token}` }
    const url = new URL(`http://127.0.0.1${path}`)
    const auth = await gateRequest(req, res, url, path, method, { dashboardToken: MAIN, resolveAgentToken: (t) => TOK[t] ?? null, mainAgentId: 'main' })
    if (!auth) return status
    return boardGateDecision(auth, path, cfg) ? 403 : 200
  }

  it('scoped token: kanban 403, board 200; worker token: kanban 200, board 403; main token: kanban 200, board 403', async () => {
    const s = 's'.repeat(40), w = 'w'.repeat(40)
    expect(await through('GET', '/api/kanban', s)).toBe(403)
    expect(await through('GET', '/api/kanban-projects', s)).toBe(403)
    expect(await through('GET', '/api/board/cards', s)).toBe(200)
    expect(await through('GET', '/api/kanban', w)).toBe(200)
    expect(await through('GET', '/api/board/cards', w)).toBe(403)
    expect(await through('GET', '/api/kanban', MAIN)).toBe(200)
    expect(await through('GET', '/api/board/report', MAIN)).toBe(403)
  })
})

// ---- routes over a real (in-memory) database -------------------------------------------------

interface Resp { status: number; body: any }
async function call(method: string, path: string, opts: { agent?: string; headers?: Record<string, string>; body?: unknown; bodyStream?: AsyncIterable<Buffer> } = {}): Promise<Resp> {
  const out: Resp = { status: 0, body: undefined }
  const res = {
    writeHead(c: number) { out.status = c; return res },
    setHeader() { return res },
    end(d?: unknown) { try { out.body = JSON.parse(String(d ?? '')) } catch { out.body = d } },
  } as unknown as http.ServerResponse
  const req = Readable.from(opts.bodyStream ?? (opts.body === undefined ? [] : [Buffer.from(typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body))])) as unknown as http.IncomingMessage
  ;(req as unknown as { headers: Record<string, string> }).headers = opts.headers ?? {}
  const url = new URL(`http://127.0.0.1${path}`)
  const ctx: RouteContext = {
    req, res, path: url.pathname, method, url,
    auth: opts.agent === undefined ? { kind: 'token' } : { kind: 'token', agent: opts.agent, tokenAgent: opts.agent },
  }
  const handled = await tryHandleBoard(ctx)
  expect(handled).toBe(true)
  return out
}

describe('/api/board routes', () => {
  beforeAll(() => { initDatabase(':memory:') })
  beforeEach(() => {
    getDb().prepare('DELETE FROM kanban_comments').run()
    getDb().prepare('DELETE FROM kanban_cards').run()
    writeCfg(RAW)
    createKanbanCard({ id: 'c-alice', title: 'Alice task', assignee: 'Alice', status: 'in_progress' })
    createKanbanCard({ id: 'c-bob', title: 'Bob task', assignee: 'bob' })
    createKanbanCard({ id: 'c-dave', title: 'Dave task', assignee: 'dave' })
    createKanbanCard({ id: 'c-erin', title: 'Erin task', assignee: 'erin' })
    createKanbanCard({ id: 'c-none', title: 'Unassigned' })
    createKanbanCard({ id: 'c-arch', title: 'Archived alice', assignee: 'alice' })
    archiveKanbanCard('c-arch')
  })

  const ids = (r: Resp): string[] => (r.body.cards as Array<{ id: string }>).map((c) => c.id).sort()

  it('lists only visible, non-archived cards per role', async () => {
    expect(ids(await call('GET', '/api/board/cards', { agent: 'alice-bot' }))).toEqual(['c-alice'])
    expect(ids(await call('GET', '/api/board/cards', { agent: 'team-bot', headers: { 'x-board-person': 'bob' } }))).toEqual(['c-alice', 'c-bob', 'c-dave'])
    expect(ids(await call('GET', '/api/board/cards', { agent: 'exec-bot' }))).toEqual(['c-alice', 'c-bob', 'c-dave', 'c-erin', 'c-none'])
    expect(ids(await call('GET', '/api/board/cards?status=planned', { agent: 'team-bot', headers: { 'x-board-sender': '1002' } }))).toEqual(['c-bob', 'c-dave'])
  })

  it('refuses unknown query params, bad status, unscoped principals, ambiguous and spoofed persons', async () => {
    expect((await call('GET', '/api/board/cards?assignee=bob', { agent: 'alice-bot' })).status).toBe(400)
    expect((await call('GET', '/api/board/cards?status=nope', { agent: 'alice-bot' })).status).toBe(400)
    expect((await call('GET', '/api/board/cards')).status).toBe(403) // main token
    expect((await call('GET', '/api/board/cards', { agent: 'worker' })).status).toBe(403)
    expect((await call('GET', '/api/board/cards', { agent: 'team-bot' })).status).toBe(400)
    expect((await call('GET', '/api/board/cards', { agent: 'team-bot', headers: { 'x-board-person': 'erin' } })).status).toBe(403)
    expect((await call('GET', '/api/board/cards', { agent: 'empty-bot' })).status).toBe(403)
  })

  it('an invisible card is a 404, the same as a missing or archived one, for reads and writes', async () => {
    for (const id of ['c-bob', 'does-not-exist', 'c-arch']) {
      const g = await call('GET', `/api/board/cards/${id}`, { agent: 'alice-bot' })
      expect(g.status, id).toBe(404)
      expect(g.body).toEqual({ error: 'card not found' })
      expect((await call('POST', `/api/board/cards/${id}/comments`, { agent: 'alice-bot', body: { content: 'x' } })).status).toBe(404)
      expect((await call('POST', `/api/board/cards/${id}/move`, { agent: 'alice-bot', body: { status: 'done' } })).status).toBe(404)
    }
    expect(getKanbanComments('c-bob')).toEqual([])
    expect(getKanbanCard('c-bob')!.status).toBe('planned')
  })

  it('reads a visible card with its comments', async () => {
    const r = await call('GET', '/api/board/cards/c-alice', { agent: 'alice-bot' })
    expect(r.status).toBe(200)
    expect(r.body.id).toBe('c-alice')
    expect(r.body.comments).toEqual([])
  })

  it('comment author is the person, bound server-side; author field is refused', async () => {
    expect((await call('POST', '/api/board/cards/c-alice/comments', { agent: 'alice-bot', body: { content: 'hi', author: 'Erin' } })).status).toBe(400)
    expect((await call('POST', '/api/board/cards/c-alice/comments', { agent: 'alice-bot', body: { content: '  ' } })).status).toBe(400)
    const ok = await call('POST', '/api/board/cards/c-alice/comments', { agent: 'alice-bot', body: { content: 'done soon' } })
    expect(ok.status).toBe(200)
    expect(getKanbanComments('c-alice').map((c) => [c.author, c.content])).toEqual([['Alice', 'done soon']])
  })

  it('moves a visible card (audited with the person as actor); strict body', async () => {
    expect((await call('POST', '/api/board/cards/c-dave/move', { agent: 'team-bot', headers: { 'x-board-person': 'bob' }, body: { status: 'in_progress', sort_order: 1 } })).status).toBe(400)
    expect((await call('POST', '/api/board/cards/c-dave/move', { agent: 'team-bot', headers: { 'x-board-person': 'bob' }, body: { status: 'bogus' } })).status).toBe(400)
    const r = await call('POST', '/api/board/cards/c-dave/move', { agent: 'team-bot', headers: { 'x-board-person': 'bob' }, body: { status: 'in_progress' } })
    expect(r.status).toBe(200)
    expect(getKanbanCard('c-dave')!.status).toBe('in_progress')
    const ev = getDb().prepare('SELECT actor, to_status FROM kanban_card_events WHERE card_id = ? ORDER BY id DESC LIMIT 1').get('c-dave')
    expect(ev).toEqual({ actor: 'Bob', to_status: 'in_progress' })
  })

  it('create: assignee defaults to the person, must stay within the visible set, body is strict', async () => {
    const r = await call('POST', '/api/board/cards', { agent: 'alice-bot', body: { title: 'New', due_date: '2026-11-20', priority: 'high' } })
    expect(r.status).toBe(200)
    expect(getKanbanCard(r.body.id)).toMatchObject({ assignee: 'alice', priority: 'high', status: 'planned' })
    const out = await call('POST', '/api/board/cards', { agent: 'alice-bot', body: { title: 'Sneaky', assignee: 'bob' } })
    expect(out.status).toBe(403)
    expect((await call('POST', '/api/board/cards', { agent: 'alice-bot', body: { title: 'x', status: 'done' } })).status).toBe(400)
    expect((await call('POST', '/api/board/cards', { agent: 'alice-bot', body: { title: '' } })).status).toBe(400)
    expect((await call('POST', '/api/board/cards', { agent: 'alice-bot', body: { title: 'x', due_date: '2026-02-30' } })).status).toBe(400)
    expect((await call('POST', '/api/board/cards', { agent: 'alice-bot', body: '[]' })).status).toBe(400)
    // a lead may assign to a report
    const lead = await call('POST', '/api/board/cards', { agent: 'team-bot', headers: { 'x-board-person': 'bob' }, body: { title: 'For Dave', assignee: 'Dave' } })
    expect(lead.status).toBe(200)
    const count = (getDb().prepare("SELECT COUNT(*) AS n FROM kanban_cards WHERE title = 'Sneaky'").get() as { n: number }).n
    expect(count).toBe(0)
  })

  it('report: groups the person\'s cards for the given date, with a text summary', async () => {
    createKanbanCard({ id: 'c-due', title: 'Due today', assignee: 'alice', due_date: '2026-11-14' })
    createKanbanCard({ id: 'c-late', title: 'Late one', assignee: 'alice', due_date: '2026-11-10' })
    createKanbanCard({ id: 'c-next', title: 'Next week', assignee: 'alice', due_date: '2026-11-21' })
    createKanbanCard({ id: 'c-wait', title: 'Blocked', assignee: 'alice', status: 'waiting' })
    createKanbanCard({ id: 'c-done', title: 'Finished', assignee: 'alice', status: 'done', due_date: '2026-11-14' })
    createKanbanCard({ id: 'c-other', title: 'Not mine', assignee: 'bob', due_date: '2026-11-14' })
    const r = await call('GET', '/api/board/report?date=2026-11-14', { agent: 'alice-bot' })
    expect(r.status).toBe(200)
    const g = r.body.groups as Record<string, Array<{ id: string }>>
    expect(g.due_today!.map((c) => c.id)).toEqual(['c-due'])
    expect(g.overdue!.map((c) => c.id)).toEqual(['c-late'])
    expect(g.in_progress!.map((c) => c.id)).toEqual(['c-alice'])
    expect(g.waiting!.map((c) => c.id)).toEqual(['c-wait'])
    expect(g.planned!.map((c) => c.id)).toEqual(['c-next'])
    expect(r.body.person).toEqual({ id: 'alice', name: 'Alice' })
    expect(r.body.text).toContain('Board report for Alice, 2026-11-14')
    expect(r.body.text).toContain('Due today (1):')
    expect(r.body.text).not.toContain('Not mine')
    expect(r.body.text).not.toContain('Finished')
    expect((await call('GET', '/api/board/report?date=2026-13-01', { agent: 'alice-bot' })).status).toBe(400)
    expect((await call('GET', '/api/board/report?day=2026-11-14', { agent: 'alice-bot' })).status).toBe(400)
    const today = await call('GET', '/api/board/report', { agent: 'alice-bot' })
    expect(today.status).toBe(200)
    expect(today.body.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('principal(): the route repeats the scope check itself (board-scope), not only the person lookup', async () => {
    // An unlisted agent and a listed agent with the feature off are refused by the route's own
    // scope check, whatever the person lookup would say: the route never trusts the gate before it.
    const unlisted = await call('GET', '/api/board/cards', { agent: 'worker' })
    expect(unlisted.status).toBe(403)
    expect(unlisted.body.rule).toBe('board-scope')
    writeCfg({ ...RAW, enabled: false })
    const off = await call('GET', '/api/board/cards', { agent: 'alice-bot' })
    expect(off.status).toBe(403)
    expect(off.body.rule).toBe('board-scope')
  })

  it('move to done without evidence is held at testing (the done-gate of /api/kanban); with evidence it closes', async () => {
    const held = await call('POST', '/api/board/cards/c-alice/move', { agent: 'alice-bot', body: { status: 'done' } })
    expect(held.status).toBe(200)
    expect(held.body).toMatchObject({ ok: false, status: 'testing', evidence_required: true })
    expect(getKanbanCard('c-alice')!.status).toBe('testing')
    const blank = await call('POST', '/api/board/cards/c-alice/move', { agent: 'alice-bot', body: { status: 'done', evidence: '   ' } })
    expect(blank.body).toMatchObject({ ok: false, status: 'testing' })
    const closed = await call('POST', '/api/board/cards/c-alice/move', { agent: 'alice-bot', body: { status: 'done', evidence: 'Alice confirmed on Telegram' } })
    expect(closed.status).toBe(200)
    expect(closed.body).toMatchObject({ ok: true, status: 'done' })
    expect(closed.body.evidence_required).toBeUndefined()
    expect(getKanbanCard('c-alice')!.status).toBe('done')
  })

  it('move 409 path: a card that became invisible between the read and the compare-and-set answers 404, not 409', async () => {
    // The body is read after the visibility check; while it streams in, the card is reassigned
    // away from Alice and its status changes, so the compare-and-set fails on an invisible card.
    async function* reassignWhileReading(): AsyncGenerator<Buffer> {
      getDb().prepare("UPDATE kanban_cards SET assignee = 'bob', status = 'waiting' WHERE id = 'c-alice'").run()
      yield Buffer.from(JSON.stringify({ status: 'planned' }))
    }
    const r = await call('POST', '/api/board/cards/c-alice/move', { agent: 'alice-bot', bodyStream: reassignWhileReading() })
    expect(r.status).toBe(404)
    expect(r.body).toEqual({ error: 'card not found' })
    // control: the same race on a card that stays visible is the 409 with the current status
    async function* statusOnly(): AsyncGenerator<Buffer> {
      getDb().prepare("UPDATE kanban_cards SET status = 'waiting' WHERE id = 'c-dave'").run()
      yield Buffer.from(JSON.stringify({ status: 'in_progress' }))
    }
    const c = await call('POST', '/api/board/cards/c-dave/move', { agent: 'team-bot', headers: { 'x-board-person': 'bob' }, bodyStream: statusOnly() })
    expect(c.status).toBe(409)
    expect(c.body).toEqual({ error: 'status_conflict', current_status: 'waiting' })
  })

  it('comment #hex8 references resolve to #seq only for cards the caller can see', async () => {
    createKanbanCard({ id: 'aaaa0001', title: 'Alice visible', assignee: 'alice' })
    createKanbanCard({ id: 'bbbb0002', title: 'Bob hidden', assignee: 'bob' })
    const seqOf = (id: string): number => (getDb().prepare('SELECT rowid AS seq FROM kanban_cards WHERE id = ?').get(id) as { seq: number }).seq
    const r = await call('POST', '/api/board/cards/c-alice/comments', { agent: 'alice-bot', body: { content: 'see #aaaa0001 and #bbbb0002' } })
    expect(r.status).toBe(200)
    expect(r.body.content).toBe(`see #${seqOf('aaaa0001')} and #bbbb0002`)
    // a lead who sees Bob's card gets it resolved
    const lead = await call('POST', '/api/board/cards/c-dave/comments', { agent: 'team-bot', headers: { 'x-board-person': 'bob' }, body: { content: 'ref #bbbb0002' } })
    expect(lead.body.content).toBe(`ref #${seqOf('bbbb0002')}`)
  })

  it('title is capped at 300 characters (the database trigger would cut a longer one silently)', async () => {
    const ok = await call('POST', '/api/board/cards', { agent: 'alice-bot', body: { title: 'x'.repeat(300) } })
    expect(ok.status).toBe(200)
    expect(getKanbanCard(ok.body.id)!.title).toHaveLength(300)
    const long = await call('POST', '/api/board/cards', { agent: 'alice-bot', body: { title: 'y'.repeat(301) } })
    expect(long.status).toBe(400)
    expect(long.body.error).toContain('at most 300 characters')
  })

  it('a broken config closes the routes too', async () => {
    writeCfg('{oops')
    expect((await call('GET', '/api/board/cards', { agent: 'alice-bot' })).status).toBe(403)
  })
})

describe('report helpers', () => {
  it('a date-only due date is read as its UTC calendar day, a timed one in the given zone', () => {
    expect(cardDueDay(Date.UTC(2026, 10, 14) / 1000, 'America/Los_Angeles')).toBe('2026-11-14')
    expect(cardDueDay(Date.UTC(2026, 10, 14, 23, 30) / 1000, 'Europe/Budapest')).toBe('2026-11-15')
    expect(cardDueDay(null, 'UTC')).toBeNull()
  })

  it('caps each text group and says how many more', () => {
    const cards = Array.from({ length: 13 }, (_, i) => ({ id: `p${i}`, title: `T${i}`, status: 'planned', assignee: 'a', priority: 'normal', project: null, due_date: null, archived_at: null } as any))
    const r = buildBoardReport({ id: 'a', name: 'A' }, cards, '2026-11-14', 'UTC')
    expect(r.groups.planned).toHaveLength(13)
    expect(r.text).toContain('... and 3 more')
  })
})
