// renderSwimlaneBoard with the owner strip in place: which lanes are drawn and
// which cards land in them. The owner's open cards leave the lanes ONLY when the
// lanes are people; grouped by priority every card stays in its priority lane
// (review of #1860: an urgent owner card vanished from the priority board).
// renderSwimlaneBoard, kanbanHideFromLanes, kanbanSwimlaneKeyFor and the real
// escapeHtml are sliced out of web/app.js and run in a vm on a fake DOM.
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

// One fake element serves both escapeHtml's scratch <div> (textContent in,
// innerHTML out, escaping & < > as the browser does) and the lane markup.
class El {
  className = ''
  innerHTML = ''
  set textContent(v: unknown) { this.innerHTML = String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') }
  dataset: Record<string, string> = {}
  style: Record<string, string> = {}
  children: El[] = []
  appendChild(c: El) { this.children.push(c); return c }
  querySelector() { return new El() }
  addEventListener() {}
}

interface Card { id: string; status: string; assignee: string; priority: string }

function render(groupBy: 'assignee' | 'priority', cards: Card[], nickname = '') {
  const board = new El()
  const ctx: Record<string, unknown> = {
    document: {
      getElementById: (id: string) => (id === 'kanbanSwimlaneBoard' ? board : null),
      createElement: () => new El(),
    },
    window: {},
    t: (k: string) => k,
    kanbanGroupBy: groupBy,
    kanbanAssignees: [{ name: 'Jane Doe' }, { name: 'dev' }],
    kanbanCards: cards,
    kanbanCollapsedLanes: new Set(),
    kanbanHiddenColumns: new Set(),
    ownerAssigneeName: () => 'Jane Doe',
    kanbanSwimlaneMeta: (key: string) => ({ avatarClass: '', avatarChar: key[0], label: key, nickname }),
    kanbanDecorateAvatar: () => {},
    kanbanCardSorter: () => () => 0,
    createCardEl: (card: Card) => Object.assign(new El(), { cardId: card.id }),
    wireKanbanColumnDnD: () => {},
    updateSubtaskBadges: () => {},
    updateWipBadges: () => {},
    renderKanban: () => {},
  }
  vm.createContext(ctx)
  vm.runInContext(
    slice('function escapeHtml(str)', '\n}\n') + '\n}\n' +
      slice('const KANBAN_STATUS_DEFS', '\n// Which swimlane a card belongs to') +
      slice('function kanbanSwimlaneKeyFor(card)', '\n}\n') + '\n}\n' +
      slice('function kanbanIsOwnerOpen(card)', '\n// Map column status keys') +
      '\nglobalThis.run = (g) => renderSwimlaneBoard(g, new Set())',
    ctx,
  )
  const grouped: Record<string, Card[]> = { planned: [], in_progress: [], testing: [], waiting: [], done: [] }
  for (const c of cards) grouped[c.status].push(c)
  ;(ctx.run as (g: unknown) => void)(grouped)

  const lanes = board.children.map((lane) => {
    const ids: string[] = []
    const walk = (el: El) => { for (const ch of el.children) { const id = (ch as El & { cardId?: string }).cardId; if (id) ids.push(id); walk(ch) } }
    walk(lane)
    return { key: lane.dataset.group, header: lane.children[0]?.innerHTML ?? '', ids }
  })
  return lanes
}

const CARDS: Card[] = [
  { id: 'o-urgent', status: 'planned', assignee: 'Jane Doe', priority: 'urgent' },
  { id: 'o-normal', status: 'in_progress', assignee: 'jane doe', priority: 'normal' },
  { id: 'o-low', status: 'waiting', assignee: 'Jane Doe', priority: 'low' },
  { id: 'o-done', status: 'done', assignee: 'Jane Doe', priority: 'high' },
  { id: 'a-high', status: 'planned', assignee: 'dev', priority: 'high' },
  { id: 'a-normal', status: 'planned', assignee: 'dev', priority: 'normal' },
]

describe('renderSwimlaneBoard with the owner strip', () => {
  it("grouped by priority, every owner card stays in its priority lane and no lane goes missing", () => {
    const lanes = render('priority', CARDS)
    expect(lanes.map((l) => l.key)).toEqual(['urgent', 'high', 'normal', 'low'])
    const byKey = Object.fromEntries(lanes.map((l) => [l.key, l.ids.sort()]))
    expect(byKey.urgent).toEqual(['o-urgent'])
    expect(byKey.high).toEqual(['a-high', 'o-done'])
    expect(byKey.normal).toEqual(['a-normal', 'o-normal'])
    expect(byKey.low).toEqual(['o-low'])
  })

  it("grouped by assignee, the owner's open cards leave the lanes (the strip draws them), done ones stay", () => {
    const lanes = render('assignee', CARDS)
    const byKey = Object.fromEntries(lanes.map((l) => [l.key, l.ids.sort()]))
    expect(byKey['Jane Doe']).toEqual(['o-done'])
    expect(byKey.dev).toEqual(['a-high', 'a-normal'])
  })

  it('a nickname with markup lands in the lane header as text', () => {
    const lanes = render('assignee', CARDS, '<img src=x onerror="alert(1)">')
    for (const l of lanes) {
      expect(l.header).not.toContain('<img')
      expect(l.header).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;')
    }
  })
})

describe('nickname escaping on the other two places it is drawn', () => {
  // The card chip and the agents page build their markup inside larger
  // renderers with many collaborators; pin the escape at the source so that
  // dropping it fails here.
  it('the card chip and both agents-page rows wrap the nickname in escapeHtml', () => {
    expect(APP_JS).toContain('<span class="kanban-nickname">${escapeHtml(assignee.nickname)}</span>')
    expect(APP_JS).toContain('<span class="agent-nickname">${escapeHtml(m.nickname)}</span>')
    expect(APP_JS).toContain('<span class="agent-nickname">${escapeHtml(agent.nickname)}</span>')
    expect(APP_JS).not.toMatch(/class="(kanban|agent)-nickname">\$\{(?!escapeHtml\()/)
  })
})
