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
