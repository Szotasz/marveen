// Small kanban fixes, one describe each:
//  - GET /api/kanban/:id/comments 404s for a card that does not exist (the POST
//    already did); an empty array for a mistyped id looked like a real answer.
//  - breakdown/accept: a subtask without an assignee inherits the parent's.
//  - POST /api/kanban/:id/move rejects unknown keys and non-object bodies
//    instead of dropping them and answering ok:true.
//  - Static web checks: the "(optional)" hints are translatable, and a direct
//    #kanban load initialises the Board / Timeline / Archived switcher.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Readable } from 'node:stream'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type http from 'node:http'

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  MAIN_AGENT_ID: 'orin',
  BOT_NAME: 'Orin',
  OWNER_NAME: 'Owner',
}))

vi.mock('../db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db.js')>()
  return { ...actual, createAgentMessage: vi.fn() }
})

vi.mock('../web/agent-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/agent-config.js')>()),
  listAgentNames: () => ['dex'],
  readAgentDisplayName: (n: string) => n,
}))

vi.mock('../web/agent-process.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/agent-process.js')>()),
  isAgentRunning: () => true,
}))

import { initDatabase, createKanbanCard, getKanbanCard, addKanbanComment, getChildCards } from '../db.js'
import { tryHandleKanban } from '../web/routes/kanban.js'

async function call(method: string, path: string, payload?: unknown, rawBody?: string): Promise<{ status: number; body: any }> {
  const text = rawBody ?? (payload === undefined ? '' : JSON.stringify(payload))
  const req = Readable.from([Buffer.from(text)]) as unknown as http.IncomingMessage
  let status = 200
  let chunk = ''
  const res = {
    writeHead: (s: number) => { status = s; return res },
    end: (c?: unknown) => { if (c !== undefined) chunk = String(c) },
    setHeader: () => {},
  } as unknown as http.ServerResponse
  const handled = await tryHandleKanban({ req, res, path, method, url: new URL(`http://localhost${path}`) } as never)
  expect(handled).toBe(true)
  return { status, body: chunk ? JSON.parse(chunk) : undefined }
}

beforeEach(() => {
  initDatabase(':memory:')
})

describe('GET /api/kanban/:id/comments -- the card must exist', () => {
  it('404s for an id that resolves to no card, naming the id', async () => {
    const out = await call('GET', '/api/kanban/NOSUCHID/comments')
    expect(out.status).toBe(404)
    expect(out.body.error).toContain('NOSUCHID')
  })

  it('POSITIVE CONTROL: an existing card still lists its comments', async () => {
    createKanbanCard({ id: 'card-1', title: 'Real card' })
    addKanbanComment('card-1', 'dex', 'first note')
    const out = await call('GET', '/api/kanban/card-1/comments')
    expect(out.status).toBe(200)
    expect(out.body.map((c: { content: string }) => c.content)).toEqual(['first note'])
  })

  it('an existing card with no comments is still a 200 with an empty list', async () => {
    createKanbanCard({ id: 'card-2', title: 'Quiet card' })
    const out = await call('GET', '/api/kanban/card-2/comments')
    expect(out.status).toBe(200)
    expect(out.body).toEqual([])
  })
})

describe('POST /api/kanban/:id/breakdown/accept -- subtask assignee', () => {
  const accept = (subtasks: unknown[]) => call('POST', '/api/kanban/parent-1/breakdown/accept', { subtasks })

  it("a subtask with a null assignee inherits the parent's", async () => {
    createKanbanCard({ id: 'parent-1', title: 'Parent', assignee: 'dex' })
    const out = await accept([{ title: 'Child', description: '', assignee: null, priority: 'normal' }])
    expect(out.status).toBe(200)
    expect(getKanbanCard(out.body.created[0])?.assignee).toBe('dex')
  })

  it('an explicit subtask assignee is kept, not overwritten by the parent', async () => {
    createKanbanCard({ id: 'parent-1', title: 'Parent', assignee: 'dex' })
    const out = await accept([{ title: 'Child', description: '', assignee: 'orin', priority: 'normal' }])
    expect(getKanbanCard(out.body.created[0])?.assignee).toBe('orin')
  })

  it('with no assignee on either side the child stays unassigned', async () => {
    createKanbanCard({ id: 'parent-1', title: 'Parent' })
    await accept([{ title: 'Child', description: '', assignee: null, priority: 'normal' }])
    const [child] = getChildCards('parent-1')
    expect(child.assignee ?? null).toBeNull()
  })
})

describe('POST /api/kanban/:id/move -- body shape', () => {
  beforeEach(() => {
    createKanbanCard({ id: 'card-m', title: 'Movable' })
  })

  it('rejects an unknown key with 400, names it, and does not move the card', async () => {
    const out = await call('POST', '/api/kanban/card-m/move', { status: 'in_progress', sortOrder: 3 })
    expect(out.status).toBe(400)
    expect(out.body.error).toContain('sortOrder')
    expect(out.body.error).toContain('status, sort_order, actor')
    expect(getKanbanCard('card-m')?.status).toBe('planned')
  })

  it.each([
    ['an array', '[]'],
    ['null', 'null'],
    ['a string', '"done"'],
  ])('rejects %s as the body with 400', async (_label, raw) => {
    const out = await call('POST', '/api/kanban/card-m/move', undefined, raw)
    expect(out.status).toBe(400)
    expect(getKanbanCard('card-m')?.status).toBe('planned')
  })

  it('POSITIVE CONTROL: the accepted fields still move the card', async () => {
    const out = await call('POST', '/api/kanban/card-m/move', { status: 'waiting', sort_order: 0, actor: 'orin' })
    expect(out.status).toBe(200)
    expect(getKanbanCard('card-m')?.status).toBe('waiting')
  })

  it('a missing card is still a 404, not a 400', async () => {
    const out = await call('POST', '/api/kanban/NOSUCHID/move', { status: 'done' })
    expect(out.status).toBe(404)
  })
})

describe('web: static fixes', () => {
  const web = (f: string) => readFileSync(join(__dirname, '..', '..', 'web', f), 'utf8')

  it('every "(opcionális)" hint in index.html carries a data-i18n key', () => {
    const html = web('index.html')
    const hintSpans = html.match(/<span class="hint"[^>]*>\(opcionális\)<\/span>/g) ?? []
    expect(hintSpans.length).toBeGreaterThan(0)
    for (const span of hintSpans) expect(span).toContain('data-i18n="common.optional_hint"')
    // A label whose whole text is Hungarian with the hint inline must be keyed too.
    const bareLabels = html.match(/<label(?![^>]*data-i18n)[^>]*>[^<]*\(opcionális\)/g) ?? []
    expect(bareLabels).toEqual([])
  })

  it('the data-i18n sweep keeps the space between a label and its inline hint', () => {
    const sweep = web('app.js')
    const at = sweep.indexOf("document.querySelectorAll('[data-i18n]').forEach(el => {")
    const body = sweep.slice(at, sweep.indexOf('\n  })\n', at))
    // Run the real rewrite on a stand-in for <label>Leírás <span class="hint">..</span></label>
    const text = { nodeType: 3, textContent: 'Leírás ' }
    const span = { nodeType: 1, textContent: '(optional)' }
    const el = { dataset: { i18n: 'common.description' }, children: [span], childNodes: [text, span] }
    const run = new Function('document', 't', body + '\n  })')
    run({ querySelectorAll: () => [el] }, () => 'Description')
    expect(text.textContent + span.textContent).toBe(' Description (optional)')
  })

  it('common.optional_hint exists in both languages', () => {
    expect(web('lang/en.js')).toMatch(/'common\.optional_hint':\s*'\(optional\)'/)
    expect(web('lang/hu.js')).toMatch(/'common\.optional_hint':\s*'\(opcionális\)'/)
  })

  it('the view switcher catches up when the page loaded straight onto #kanban', () => {
    const app = web('app.js')
    const exportAt = app.indexOf('window._initGanttViewSwitcher = initGanttViewSwitcher')
    const catchUpAt = app.indexOf("if (document.getElementById('kanbanPage')?.hidden === false) initGanttViewSwitcher()")
    // The initial routeFromHash() call runs earlier in the file than the export,
    // which is the whole bug; the catch-up has to come after the export.
    const routeAt = app.indexOf('routeFromHash()\n})()')
    expect(routeAt).toBeGreaterThan(-1)
    expect(exportAt).toBeGreaterThan(routeAt)
    expect(catchUpAt).toBeGreaterThan(exportAt)
  })
})
