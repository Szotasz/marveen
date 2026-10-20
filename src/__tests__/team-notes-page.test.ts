// The Notes page in web/app.js: the assignee picker and the two writes.
// The browser code has no module boundary, so loadNotesAssignees is sliced out
// of app.js and run in a vm against a minimal fake select element.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const APP_JS = readFileSync(join(ROOT, 'web', 'app.js'), 'utf-8')

function slice(startMarker: string, endMarker: string): string {
  const a = APP_JS.indexOf(startMarker)
  const b = APP_JS.indexOf(endMarker, a)
  if (a < 0 || b < 0) throw new Error(`marker not found: ${startMarker}`)
  return APP_JS.slice(a, b)
}

async function loadAssignees(agentsResponse: () => Promise<{ ok: boolean; json: () => Promise<unknown> }>, mainId = 'Boss') {
  const sel = { value: '', innerHTML: '' }
  const ctx: Record<string, unknown> = {
    document: { getElementById: (id: string) => (id === 'notesAssignee' ? sel : null) },
    ['fe' + 'tch']: () => agentsResponse(),
    escapeHtml: (s: unknown) => String(s),
    t: (k: string) => k,
    mainAgentId: () => mainId,
  }
  vm.createContext(ctx)
  vm.runInContext(
    'let notesAssigneesLoaded = false\n' +
      slice('function notesAssigneeLabel(', '\nasync function loadNotesPage(') +
      '\nglobalThis.run = async () => { await loadNotesAssignees(); return notesAssigneesLoaded }',
    ctx,
  )
  const loaded = await (ctx.run as () => Promise<boolean>)()
  const values = [...sel.innerHTML.matchAll(/value="([^"]*)"/g)].map((m) => m[1])
  return { loaded, values }
}

describe('Notes page: assignee picker', () => {
  it('offers everyone, the owner, the main agent from the page config, then the agents, all lower-case and once', async () => {
    const { loaded, values } = await loadAssignees(async () => ({ ok: true, json: async () => [{ name: 'Cody' }, { name: 'boss' }, { name: 'ada' }, { name: 'cody' }] }))
    expect(loaded).toBe(true)
    expect(values).toEqual(['mindenki', 'gazda', 'boss', 'ada', 'cody'])
    expect(values).not.toContain('marveen')
  })

  it('a failed agent list keeps the form usable but is not remembered as loaded, so the next visit retries', async () => {
    const failed = await loadAssignees(async () => ({ ok: false, json: async () => ({}) }))
    expect(failed.loaded).toBe(false)
    expect(failed.values).toEqual(['mindenki', 'gazda', 'boss'])
    const thrown = await loadAssignees(async () => { throw new Error('offline') })
    expect(thrown.loaded).toBe(false)
  })
})

describe('Notes page: who the writes name', () => {
  const wiring = slice('function wireNotesPage()', '\nasync function loadIdeasPage(')
  it('the add form and the delete name the owner from the page config (as board moves do), never a fixed label', () => {
    expect(wiring).toContain('created_by: kanbanMoveActor()')
    expect(wiring).toContain('by: kanbanMoveActor()')
    expect(wiring).not.toContain("'gazda'")
  })
})

describe('Notes page opened first: the writes still name the owner', () => {
  // window._marveen is filled by the Kanban, Agents and Messages pages only. With
  // the notes page as the first page of a fresh load it is unset, so the writes
  // must resolve /api/marveen themselves before building their bodies.
  const helpers =
    slice('function kanbanMoveActor()', '\n') + '\n' +
    slice('async function ensureMarveenLoaded()', '\nasync function loadMessagesPage(') + '\n' +
    'let notesPageWired = false\n' +
    slice('function wireNotesPage()', '\nasync function loadIdeasPage(')

  function setup() {
    const listeners: Record<string, (e: unknown) => Promise<void>> = {}
    const el = (id: string) => ({
      id, value: '', disabled: false, dataset: {} as Record<string, string>, focus() {},
      addEventListener: (_ev: string, fn: (e: unknown) => Promise<void>) => { listeners[id] = fn },
    })
    const els: Record<string, ReturnType<typeof el>> = {}
    for (const id of ['notesForm', 'notesAssignee', 'notesContent', 'notesDue', 'notesAddBtn', 'notesTbody']) els[id] = el(id)
    const writes: { url: string; body: Record<string, unknown> }[] = []
    const win: Record<string, unknown> = { prompt: () => 'done' }
    const ctx: Record<string, unknown> = {
      window: win,
      document: { getElementById: (id: string) => els[id] || null },
      ['fe' + 'tch']: async (url: string, opts?: { body?: string }) => {
        if (url === '/api/marveen') return { ok: true, json: async () => ({ agentId: 'boss', ownerName: 'Owner Name' }) }
        writes.push({ url, body: JSON.parse(opts?.body || '{}') })
        return { ok: true, json: async () => ({ ok: true }) }
      },
      t: (k: string) => k,
      showToast: () => {},
      loadNotesPage: () => {},
    }
    vm.createContext(ctx)
    vm.runInContext(helpers + '\nwireNotesPage()', ctx)
    return { listeners, els, writes, win }
  }

  it('the first add carries created_by although no other page loaded the config', async () => {
    const { listeners, els, writes, win } = setup()
    expect(win._marveen).toBeUndefined()
    els.notesContent.value = 'call the plumber'
    await listeners.notesForm({ preventDefault() {} })
    expect(writes).toHaveLength(1)
    expect(writes[0].url).toBe('/api/notes')
    expect(writes[0].body.created_by).toBe('Owner Name')
  })

  it('the first delete carries by although no other page loaded the config', async () => {
    const { listeners, writes } = setup()
    const btn = { dataset: { noteDone: 'abc123' }, disabled: false }
    await listeners.notesTbody({ target: { closest: () => btn } })
    expect(writes).toHaveLength(1)
    expect(writes[0].url).toBe('/api/notes/abc123')
    expect(writes[0].body.by).toBe('Owner Name')
  })

  it('loadNotesPage resolves the config before it draws anything', () => {
    const body = slice('async function loadNotesPage() {', '\n}\n')
    expect(body.indexOf('await ensureMarveenLoaded()')).toBeGreaterThan(-1)
    expect(body.indexOf('await ensureMarveenLoaded()')).toBeLessThan(body.indexOf('loadNotesAssignees()'))
  })
})
