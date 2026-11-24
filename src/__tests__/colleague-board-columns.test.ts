import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The colleague page (docs/board-access.md, "Colleague login") shows the person's cards as a kanban: one column per
// status, side by side, and a card can be dragged to another column. The drop goes through the same move() as the
// status select, so the select's refusal handling (409, soft ok:false) covers a drag too.

const web = (f: string) => readFileSync(join(__dirname, '..', '..', 'web', f), 'utf-8')
const js = web('colleague.js')
const html = web('colleague.html')

function fnBody(src: string, signature: string): string {
  const start = src.indexOf(signature)
  expect(start, signature).toBeGreaterThan(-1)
  return src.slice(start, src.indexOf('\n  }\n', start))
}

describe('colleague board columns', () => {
  it('renders every status as a column, the empty ones too', () => {
    const body = fnBody(js, 'function renderColumns(root, cards, statuses)')
    // An empty status used to be skipped; an empty column must stay, it is a drop target.
    expect(body).not.toMatch(/continue/)
    expect(body).toContain("'cb-col'")
    expect(body).toContain("'cb-col-body'")
    expect(body).toContain('wireDrop(body, s)')
  })

  it('a drop moves the card through move(), with the card\'s own select', () => {
    const body = fnBody(js, 'function wireDrop(body, status)')
    expect(body).toContain('d.sel.value = status')
    expect(body).toContain('move(d.card, status, d.sel)')
    // Dropping into the card's own column is not a move.
    expect(body).toContain('d.card.status === status')
  })

  it('a card is draggable, but not while the pointer is on one of its controls', () => {
    const body = fnBody(js, 'function wireDrag(box, c, sel)')
    expect(body).toContain('box.draggable = true')
    expect(body).toMatch(/closest\('select, input, textarea, button, a, \.cb-detail'\)/)
    expect(body).toContain("addEventListener('dragstart'")
    expect(body).toContain("addEventListener('dragend'")
  })

  it('the page lays the columns out side by side and has the board container', () => {
    expect(html).toMatch(/\.cb-board \{[^}]*display: grid;[^}]*grid-template-columns: repeat\(auto-fit, minmax\(/)
    expect(html).toContain('id="cb-groups" class="cb-board"')
    expect(html).toContain('id="cb-empty"')
    expect(html).toContain('.cb-col-body.drag-over')
  })
})

// The colleague chooses the view: the column board (with drag) or the status-grouped list (select only). The choice
// is a per-browser convenience in localStorage; blocked storage or an unknown value falls back to the columns.
describe('colleague board view switch', () => {
  it('the page has the two view buttons, labelled through i18n', () => {
    expect(html).toContain('id="cb-view-columns"')
    expect(html).toContain('id="cb-view-list"')
    expect(html).toContain('data-i18n="colleague.view.columns"')
    expect(html).toContain('data-i18n="colleague.view.list"')
    expect(html).toContain('data-i18n-aria="colleague.view.label"')
    expect(html).toContain('.cb-board.cb-list { display: block; }')
  })

  it('both language files carry the view strings', () => {
    for (const f of ['lang/en.js', 'lang/hu.js']) {
      const src = web(f)
      for (const k of ['colleague.view.label', 'colleague.view.columns', 'colleague.view.list']) {
        expect(src, `${f} ${k}`).toContain(`'${k}':`)
      }
    }
  })

  it('render() picks the list or the columns by the current view, and marks the pressed button', () => {
    const body = fnBody(js, 'function render(cards)')
    expect(body).toContain("if (view === 'list') renderList(root, cards, statuses)")
    expect(body).toContain('else renderColumns(root, cards, statuses)')
    expect(body).toContain("root.classList.toggle('cb-list', view === 'list')")
    expect(body).toContain("$('cb-view-list').setAttribute('aria-pressed', String(view === 'list'))")
  })

  it('the list view has no drag: its cards are rendered without it, and empty statuses are skipped', () => {
    const list = fnBody(js, 'function renderList(root, cards, statuses)')
    expect(list).toContain('renderCard(c, statuses, false)')
    expect(list).not.toContain('wireDrop')
    expect(list).toContain('if (list.length === 0) continue')
    const cols = fnBody(js, 'function renderColumns(root, cards, statuses)')
    expect(cols).toContain('renderCard(c, statuses, true)')
    const card = fnBody(js, 'function renderCard(c, statuses, canDrag)')
    expect(card).toContain('if (canDrag) wireDrag(box, c, sel)')
  })

  it('the choice is stored, guarded, and only "list" selects the list', () => {
    expect(js).toContain("const VIEW_KEY = 'marveen.colleague.view'")
    expect(js).toContain("try { if (localStorage.getItem(VIEW_KEY) === 'list') view = 'list' } catch")
    const set = fnBody(js, 'function setView(v)')
    expect(set).toContain("view = v === 'list' ? 'list' : 'columns'")
    expect(set).toMatch(/try \{ localStorage\.setItem\(VIEW_KEY, view\) \} catch/)
    expect(set).toContain('render(lastCards)')
    expect(js).toContain("$('cb-view-columns').addEventListener('click', () => setView('columns'))")
    expect(js).toContain("$('cb-view-list').addEventListener('click', () => setView('list'))")
  })
})
