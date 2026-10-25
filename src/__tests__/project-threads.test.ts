// Project threads (src/web/project-threads.ts + routes/project-threads.ts):
// a shared per-project conversation between the owner (dashboard UI), the
// project's responsible agent and the main agent. These run the real storage,
// planner and route handlers against an in-memory database seeded with the
// production schema. Session delivery is the existing inter-agent queue, so the
// assertions read agent_messages: that is exactly what the message router would
// deliver (idle-gated), and nothing here types into a tmux pane.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Readable } from 'node:stream'

const KNOWN = new Set(['laura', 'zack'])
const pingSpy = vi.fn(async (_text: string) => ({ sent: true }))
let pingSetting = true

vi.mock('../web/agent-config.js', async (orig) => {
  const real = await orig<typeof import('../web/agent-config.js')>()
  const { MAIN_AGENT_ID } = await import('../config.js')
  return { ...real, isKnownAgent: (n: string) => n === MAIN_AGENT_ID || KNOWN.has(n) }
})
vi.mock('../notify.js', async (orig) => {
  const real = await orig<typeof import('../notify.js')>()
  return { ...real, sendOwnerMessage: (text: string) => pingSpy(text) }
})
vi.mock('../setting-flag.js', async (orig) => {
  const real = await orig<typeof import('../setting-flag.js')>()
  return { ...real, isSettingOn: (key: string) => (key === 'PROJECT_THREAD_OWNER_PING' ? pingSetting : real.isSettingOn(key)) }
})

const { initDatabase, createKanbanCard, getDb } = await import('../db.js')
const { MAIN_AGENT_ID, OWNER_NAME, APP_TZ } = await import('../config.js')
const PT = await import('../web/project-threads.js')
const { tryHandleProjectThreads } = await import('../web/routes/project-threads.js')
const { tryHandleKanbanProjects } = await import('../web/routes/kanban-projects.js')

const MAIN = MAIN_AGENT_ID

beforeEach(() => {
  initDatabase(':memory:')
  pingSpy.mockClear()
  pingSetting = true
})

function queued(): Array<{ from_agent: string; to_agent: string; content: string; status: string }> {
  return getDb().prepare('SELECT from_agent, to_agent, content, status FROM agent_messages ORDER BY id').all() as never
}

async function call(
  method: string, path: string, body?: unknown, auth?: Record<string, unknown>,
  handler: (ctx: never) => Promise<boolean> = tryHandleProjectThreads as never,
): Promise<{ status: number; json: any; handled: boolean }> {
  let status = 200
  let out = ''
  const res = {
    setHeader() {}, writeHead(s: number) { status = s }, end(b?: string) { out = b ?? '' },
  } as any
  const req = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]) as any
  req.headers = {}
  const url = new URL(`http://localhost${path}`)
  const handled = await handler({ req, res, path: url.pathname, method, url, auth } as never)
  return { status, json: out ? JSON.parse(out) : null, handled }
}

const enc = (p: string) => encodeURIComponent(p)

describe('storage and summary', () => {
  it('counts unread for the owner and flags a needs_owner post as waiting until the owner replies', async () => {
    createKanbanCard({ id: 'a', title: 'A', project: 'demo', assignee: 'laura' })
    await PT.postProjectThreadMessage({ project: 'demo', author: 'laura', content: 'Mehet a v2?', needsOwner: true })
    await PT.postProjectThreadMessage({ project: 'demo', author: 'laura', content: 'Plusz egy info.' })
    let [s] = PT.listProjectThreadSummaries()
    expect(s.unreadForOwner).toBe(2)
    expect(s.waitingOnOwner).toBe(true)
    expect(s.lastAuthor).toBe('laura')

    // Opening marks read, but the question is still open.
    expect(PT.markProjectThreadRead('demo')).toBe(2)
    ;[s] = PT.listProjectThreadSummaries()
    expect(s.unreadForOwner).toBe(0)
    expect(s.waitingOnOwner).toBe(true)

    // The owner's reply clears "vár rád"; a later question raises it again.
    await PT.postProjectThreadMessage({ project: 'demo', author: 'owner', content: 'Mehet.' })
    ;[s] = PT.listProjectThreadSummaries()
    expect(s.waitingOnOwner).toBe(false)
    expect(s.messageCount).toBe(3)
    await PT.postProjectThreadMessage({ project: 'demo', author: 'laura', content: 'És a v3?', needsOwner: true })
    ;[s] = PT.listProjectThreadSummaries()
    expect(s.waitingOnOwner).toBe(true)
    expect(s.unreadForOwner).toBe(1)
  })

  it('an owner reply marks everything before it read', async () => {
    createKanbanCard({ id: 'a', title: 'A', project: 'demo', assignee: 'laura' })
    await PT.postProjectThreadMessage({ project: 'demo', author: 'laura', content: 'Kérdés' })
    await PT.postProjectThreadMessage({ project: 'demo', author: 'owner', content: 'Válasz' })
    expect(PT.listProjectThreadSummaries()[0].unreadForOwner).toBe(0)
    const msgs = PT.listProjectThread('demo')
    expect(msgs.map((m) => m.author)).toEqual(['laura', 'owner'])
    expect(msgs.every((m) => m.owner_read_at !== null)).toBe(true)
  })

  it('the owner cannot raise needs_owner on their own post', async () => {
    createKanbanCard({ id: 'a', title: 'A', project: 'demo', assignee: 'laura' })
    const r = await PT.postProjectThreadMessage({ project: 'demo', author: 'owner', content: 'x', needsOwner: true })
    expect(r.message.needs_owner).toBe(false)
    expect(pingSpy).not.toHaveBeenCalled()
  })
})

describe('resolveResponsibleAgent', () => {
  it('takes the most common fleet-agent assignee of the open cards, skipping the owner and done cards', () => {
    createKanbanCard({ id: 'a', title: 'A', project: 'demo', assignee: OWNER_NAME })
    createKanbanCard({ id: 'b', title: 'B', project: 'demo', assignee: OWNER_NAME })
    createKanbanCard({ id: 'c', title: 'C', project: 'demo', assignee: 'zack', status: 'done' })
    createKanbanCard({ id: 'd', title: 'D', project: 'demo', assignee: 'zack', status: 'done' })
    createKanbanCard({ id: 'e', title: 'E', project: 'demo', assignee: 'laura' })
    expect(PT.resolveResponsibleAgent('demo')).toEqual({ agent: 'laura', source: 'open-cards' })
  })

  it('falls back to any card, then to the main agent', () => {
    createKanbanCard({ id: 'c', title: 'C', project: 'old', assignee: 'zack', status: 'done' })
    expect(PT.resolveResponsibleAgent('old')).toEqual({ agent: 'zack', source: 'cards' })
    createKanbanCard({ id: 'x', title: 'X', project: 'nobody' })
    expect(PT.resolveResponsibleAgent('nobody')).toEqual({ agent: MAIN, source: 'fallback-main' })
  })

  it('an explicit override wins, and an override naming a gone agent is ignored', () => {
    createKanbanCard({ id: 'e', title: 'E', project: 'demo', assignee: 'laura' })
    PT.setThreadAgentOverride('demo', 'zack')
    expect(PT.resolveResponsibleAgent('demo')).toEqual({ agent: 'zack', source: 'override' })
    PT.setThreadAgentOverride('demo', 'ghost')
    expect(PT.resolveResponsibleAgent('demo').agent).toBe('laura')
    PT.setThreadAgentOverride('demo', null)
    expect(PT.getThreadAgentOverride('demo')).toBeNull()
  })
})

describe('planDeliveries: who gets what', () => {
  const deps = { mainAgentId: MAIN, ownerLabel: () => 'Csaba', mainLabel: () => 'Marveen', helperPath: '/x/marveen-api.sh' }
  const plan = (author: string, toParty: 'owner' | 'agent' | 'main' | 'both', responsibleAgent = 'laura', needsOwner = false) =>
    PT.planDeliveries({ project: 'demo', author, toParty, responsibleAgent, content: 'Szöveg', needsOwner }, deps)
      .map((d) => `${d.to}:${d.kind}`).sort()

  it('owner -> agent: the agent acts, the main agent gets an FYI', () => {
    expect(plan('owner', 'agent')).toEqual(['laura:action', `${MAIN}:fyi`].sort())
  })
  it('owner -> main: only the main agent, the agent gets nothing', () => {
    expect(plan('owner', 'main')).toEqual([`${MAIN}:action`])
  })
  it('owner -> both: both act', () => {
    expect(plan('owner', 'both')).toEqual(['laura:action', `${MAIN}:action`].sort())
  })
  it('agent -> owner: the main agent gets an FYI, the author nothing', () => {
    expect(plan('laura', 'owner')).toEqual([`${MAIN}:fyi`])
  })
  it('agent -> main and agent -> both: the main agent acts', () => {
    expect(plan('laura', 'main')).toEqual([`${MAIN}:action`])
    expect(plan('laura', 'both')).toEqual([`${MAIN}:action`])
  })
  it('main -> owner notifies nobody; main -> agent reaches the agent; never main itself', () => {
    expect(plan(MAIN, 'owner')).toEqual([])
    expect(plan(MAIN, 'agent')).toEqual(['laura:action'])
    expect(plan(MAIN, 'both')).toEqual(['laura:action'])
  })
  it('when the main agent is itself responsible, an owner post reaches it once, as an action', () => {
    expect(plan('owner', 'agent', MAIN)).toEqual([`${MAIN}:action`])
    expect(plan('owner', 'both', MAIN)).toEqual([`${MAIN}:action`])
  })
  it('formats the actionable line and the FYI line', () => {
    const ds = PT.planDeliveries({ project: "o'brien", author: 'owner', toParty: 'agent', responsibleAgent: 'laura', content: 'Nézd meg', needsOwner: false }, deps)
    const action = ds.find((d) => d.kind === 'action')!
    const fyi = ds.find((d) => d.kind === 'fyi')!
    expect(action.content.startsWith("[Projekt-szál: o'brien @Csaba -> laura]: Nézd meg")).toBe(true)
    // the project name is single-quoted for the reply command, so a quote in it cannot break out
    expect(action.content).toContain(`project-thread-post laura 'o'\\''brien' <fájl>`)
    expect(fyi.content.startsWith("[Projekt-szál FYI: o'brien @Csaba -> laura]: Nézd meg")).toBe(true)
  })
})

describe('addressing the main agent by name', () => {
  it('detects a leading "Marveen," / "@marveen" but not a longer word or a mention later on', () => {
    expect(PT.addressesMain('Marveen, beszéld meg a többiekkel', ['marveen'])).toBe(true)
    expect(PT.addressesMain('  @marveen nézd meg', ['marveen'])).toBe(true)
    expect(PT.addressesMain('Marveenke, szia', ['marveen'])).toBe(false)
    expect(PT.addressesMain('Laura, kérdezd meg Marveent', ['marveen'])).toBe(false)
  })

  it('an owner post that opens with the main agent name and no explicit addressee goes to the main agent', async () => {
    createKanbanCard({ id: 'a', title: 'A', project: 'demo', assignee: 'laura' })
    const r = await PT.postProjectThreadMessage({ project: 'demo', author: 'owner', content: `${MAIN}, beszéld meg a többiekkel` })
    expect(r.message.to_party).toBe('main')
    expect(r.deliveries.map((d) => `${d.to}:${d.kind}`)).toEqual([`${MAIN}:action`])
  })

  it('an explicit addressee is not overridden by the text', async () => {
    createKanbanCard({ id: 'a', title: 'A', project: 'demo', assignee: 'laura' })
    const r = await PT.postProjectThreadMessage({ project: 'demo', author: 'owner', content: `${MAIN}, ezt Laura csinálja`, to: 'agent' })
    expect(r.message.to_party).toBe('agent')
  })
})

describe('POST /api/project-threads/:project', () => {
  beforeEach(() => {
    createKanbanCard({ id: 'a', title: 'A', project: 'Demo projekt', assignee: 'laura' })
  })

  it('an owner post is stored and queued for the agent (actionable) and the main agent (FYI)', async () => {
    const r = await call('POST', `/api/project-threads/${enc('Demo projekt')}`, { author: 'owner', content: 'Mi a helyzet?' })
    expect(r.status).toBe(200)
    expect(r.json.id).toEqual(expect.any(Number))
    expect(r.json.to_party).toBe('agent')
    expect(r.json.responsible).toEqual({ agent: 'laura', source: 'open-cards' })
    const q = queued()
    expect(q).toHaveLength(2)
    const toAgent = q.find((m) => m.to_agent === 'laura')!
    // The owner's queued rows carry the owner sender id, the same one /api/messages accepts.
    expect(toAgent.from_agent).toBe(OWNER_NAME)
    expect(toAgent.status).toBe('pending')
    expect(toAgent.content).toMatch(/^\[Projekt-szál: Demo projekt @.+ -> laura\]: Mi a helyzet\?/)
    const toMain = q.find((m) => m.to_agent === MAIN)!
    expect(toMain.content).toMatch(/^\[Projekt-szál FYI: Demo projekt @.+ -> laura\]/)
    expect(r.json.deliveries).toHaveLength(2)
    expect(pingSpy).not.toHaveBeenCalled()
  })

  it('owner -> main ("to":"marveen" alias) reaches only the main agent', async () => {
    const r = await call('POST', `/api/project-threads/${enc('Demo projekt')}`, { author: 'owner', content: 'Beszéld meg velük', to: 'marveen' })
    expect(r.status).toBe(200)
    expect(r.json.to_party).toBe('main')
    expect(queued().map((m) => m.to_agent)).toEqual([MAIN])
    expect(queued()[0].content).toMatch(new RegExp(`^\\[Projekt-szál: Demo projekt @.+ -> ${MAIN}\\]`))
  })

  it('an agent question with needs_owner pings the owner with the project and a dashboard link', async () => {
    const r = await call('POST', `/api/project-threads/${enc('Demo projekt')}`, { author: 'laura', content: 'Melyik verzió menjen ki?', needs_owner: true })
    expect(r.status).toBe(200)
    expect(r.json.needs_owner).toBe(true)
    expect(r.json.ping).toEqual({ attempted: true, sent: true })
    expect(pingSpy).toHaveBeenCalledTimes(1)
    const text = pingSpy.mock.calls[0][0]
    expect(text).toContain('Demo projekt')
    expect(text).toContain('laura')
    expect(text).toContain(`/?thread=${enc('Demo projekt')}#projects`)
    // The supervisor sees it; the agent is never notified of its own post.
    expect(queued().map((m) => `${m.from_agent}->${m.to_agent}`)).toEqual([`laura->${MAIN}`])
  })

  it('the ping can be switched off (PROJECT_THREAD_OWNER_PING)', async () => {
    pingSetting = false
    const r = await call('POST', `/api/project-threads/${enc('Demo projekt')}`, { author: 'laura', content: 'Kérdés', needs_owner: true })
    expect(r.status).toBe(200)
    expect(r.json.ping).toEqual({ attempted: false })
    expect(pingSpy).not.toHaveBeenCalled()
  })

  it('the main agent posts into the thread without notifying itself', async () => {
    const r = await call('POST', `/api/project-threads/${enc('Demo projekt')}`, { author: MAIN, content: 'Laura, ezt nézd át', to: 'agent' })
    expect(r.status).toBe(200)
    expect(queued().map((m) => `${m.from_agent}->${m.to_agent}`)).toEqual([`${MAIN}->laura`])
    const r2 = await call('POST', `/api/project-threads/${enc('Demo projekt')}`, { author: MAIN, content: 'Összefoglaló a gazdának' })
    expect(r2.json.to_party).toBe('owner')
    expect(queued()).toHaveLength(1)
  })

  it('refuses an unknown project, an unknown author, a bad addressee and a non-boolean needs_owner', async () => {
    expect((await call('POST', `/api/project-threads/nincs`, { author: 'owner', content: 'x' })).status).toBe(404)
    expect((await call('POST', `/api/project-threads/${enc('Demo projekt')}`, { author: 'ghost', content: 'x' })).status).toBe(403)
    expect((await call('POST', `/api/project-threads/${enc('Demo projekt')}`, { author: 'owner', content: 'x', to: 'owner' })).status).toBe(400)
    expect((await call('POST', `/api/project-threads/${enc('Demo projekt')}`, { author: 'owner', content: 'x', to: 'everyone' })).status).toBe(400)
    expect((await call('POST', `/api/project-threads/${enc('Demo projekt')}`, { author: 'laura', content: 'x', needs_owner: 'true' })).status).toBe(400)
    expect((await call('POST', `/api/project-threads/${enc('Demo projekt')}`, { author: 'owner', content: '  ' })).status).toBe(400)
    expect((await call('POST', `/api/project-threads/${enc('Demo projekt')}`, 'nem json')).status).toBe(400)
    expect(PT.listProjectThread('Demo projekt')).toEqual([])
    expect(queued()).toEqual([])
  })

  it('a caller announced as an agent (X-Agent-Id) cannot post as the owner or as another agent', async () => {
    const asOwner = await call('POST', `/api/project-threads/${enc('Demo projekt')}`, { author: 'owner', content: 'x' }, { kind: 'token', agent: 'laura' })
    expect(asOwner.status).toBe(403)
    const asOther = await call('POST', `/api/project-threads/${enc('Demo projekt')}`, { author: 'zack', content: 'x' }, { kind: 'token', agent: 'laura' })
    expect(asOther.status).toBe(403)
    const self = await call('POST', `/api/project-threads/${enc('Demo projekt')}`, { author: 'laura', content: 'x' }, { kind: 'token', agent: 'laura' })
    expect(self.status).toBe(200)
  })
})

describe('GET thread, read, override and the Projects summary', () => {
  beforeEach(() => {
    createKanbanCard({ id: 'a', title: 'A', project: 'demo', assignee: 'laura' })
  })

  it('GET returns the messages, the parties and the install zone', async () => {
    await call('POST', '/api/project-threads/demo', { author: 'laura', content: 'Szia', needs_owner: true })
    const r = await call('GET', '/api/project-threads/demo')
    expect(r.status).toBe(200)
    expect(r.json.timeZone).toBe(APP_TZ)
    expect(r.json.main.id).toBe(MAIN)
    expect(r.json.responsible.agent).toBe('laura')
    expect(r.json.messages).toHaveLength(1)
    expect(r.json.messages[0]).toMatchObject({ author: 'laura', to_party: 'owner', needs_owner: true, owner_read_at: null })
  })

  it('POST /read clears the unread count; the kanban-projects summary carries the thread state', async () => {
    await call('POST', '/api/project-threads/demo', { author: 'laura', content: 'Kérdés', needs_owner: true })
    let s = await call('GET', '/api/kanban-projects/summary', undefined, undefined, tryHandleKanbanProjects as never)
    expect(s.json[0].thread).toMatchObject({ unreadForOwner: 1, waitingOnOwner: true, messageCount: 1 })
    expect(s.json[0].threadAgent).toBe('laura')
    const read = await call('POST', '/api/project-threads/demo/read')
    expect(read.json).toEqual({ ok: true, changed: 1 })
    s = await call('GET', '/api/kanban-projects/summary', undefined, undefined, tryHandleKanbanProjects as never)
    expect(s.json[0].thread).toMatchObject({ unreadForOwner: 0, waitingOnOwner: true })
    expect((await call('GET', '/api/project-threads/summary')).json[0].project).toBe('demo')
  })

  it('PUT /agent sets and clears the responsible-agent override, and routes the next owner post', async () => {
    expect((await call('PUT', '/api/project-threads/demo/agent', { agent: 'ghost' })).status).toBe(400)
    const set = await call('PUT', '/api/project-threads/demo/agent', { agent: 'zack' })
    expect(set.json.responsible).toEqual({ agent: 'zack', source: 'override' })
    await call('POST', '/api/project-threads/demo', { author: 'owner', content: 'Zack, te jössz' })
    expect(queued().find((m) => m.content.startsWith('[Projekt-szál: demo'))!.to_agent).toBe('zack')
    const cleared = await call('PUT', '/api/project-threads/demo/agent', { agent: null })
    expect(cleared.json.responsible.agent).toBe('laura')
  })

  it('leaves other paths to the next handler', async () => {
    expect((await call('GET', '/api/kanban')).handled).toBe(false)
    expect((await call('DELETE', '/api/project-threads/demo')).handled).toBe(false)
  })
})
