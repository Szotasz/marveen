// The Notes page renders text any token caller can write (an agent included),
// so every stored field must reach the page as text, never as markup. The
// render code has no module boundary: loadNotesPage and the real escapeHtml are
// sliced out of web/app.js and run in a vm. The fake <div> escapes the way a
// browser's textContent -> innerHTML round trip does (& < > only), so the test
// measures app.js's own escaping, not a stand-in that is stricter than the DOM.
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

const PAYLOAD = '<img src=x onerror="alert(1)"><script>alert(2)</script>'
// The tags the two tables are built from; anything else came out of the data.
const PAGE_TAGS = new Set(['tr', 'td', 'span', 'button'])

function fakeElement() {
  return { innerHTML: '', textContent: '' }
}

async function renderNotes(rows: unknown[]) {
  const els: Record<string, ReturnType<typeof fakeElement>> = {
    notesTbody: fakeElement(),
    notesDeletedTbody: fakeElement(),
  }
  const document = {
    getElementById: (id: string) => els[id] ?? null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => {
      let html = ''
      return {
        set textContent(v: unknown) {
          html = String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        },
        get innerHTML() { return html },
      }
    },
  }
  const ctx: Record<string, unknown> = {
    document,
    window: { _lang: 'en' },
    ['fe' + 'tch']: async () => ({ ok: true, json: async () => rows }),
    t: (k: string) => k,
    wireNotesPage: () => {},
    ensureMarveenLoaded: async () => {},
    loadNotesAssignees: async () => {},
  }
  vm.createContext(ctx)
  vm.runInContext(
    'let notesAssigneesLoaded = true\n' +
      slice('function escapeHtml(str)', '\n}\n') + '\n}\n' +
      slice('function notesLocalToday()', '\nasync function loadNotesAssignees(') +
      slice('async function loadNotesPage()', '\nlet notesPageWired') +
      '\nglobalThis.run = () => loadNotesPage()',
    ctx,
  )
  await (ctx.run as () => Promise<void>)()
  return { active: els.notesTbody.innerHTML, deleted: els.notesDeletedTbody.innerHTML }
}

function tagsIn(html: string): string[] {
  return [...html.matchAll(/<([a-zA-Z][a-zA-Z0-9-]*)/g)].map((m) => m[1].toLowerCase())
}

describe('Notes page: stored text renders as text', () => {
  it('markup in content, created_by, deleted_by and delete_reason creates no element and shows up escaped', async () => {
    const { active, deleted } = await renderNotes([
      { id: 'a1', assignee: 'cody', content: PAYLOAD, created_by: PAYLOAD, created_at: 1790000000, due_date: null, deleted_at: null },
      { id: 'd1', assignee: 'cody', content: PAYLOAD, created_by: 'x', created_at: 1790000000, due_date: null,
        deleted_at: 1790000100, deleted_by: PAYLOAD, delete_reason: PAYLOAD },
    ])

    for (const html of [active, deleted]) {
      const stray = tagsIn(html).filter((tag) => !PAGE_TAGS.has(tag))
      expect(stray).toEqual([])
      expect(html).not.toContain('<img')
      expect(html).not.toContain('<script')
    }
    const escaped = '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&lt;script&gt;alert(2)&lt;/script&gt;'
    // content + created_by in the active table; content, deleted_by, delete_reason in the deleted one.
    expect(active.split(escaped).length - 1).toBe(2)
    expect(deleted.split(escaped).length - 1).toBe(3)
  })

  it('a quote in an id cannot break out of the data attribute', async () => {
    const { active } = await renderNotes([
      { id: 'x" onclick="alert(3)', assignee: 'cody', content: 'ok', created_by: 'x', created_at: 1790000000, due_date: null, deleted_at: null },
    ])
    expect(active).not.toContain('onclick="alert(3)"')
    expect(active).toContain('data-note-done="x&quot; onclick=&quot;alert(3)"')
  })
})
