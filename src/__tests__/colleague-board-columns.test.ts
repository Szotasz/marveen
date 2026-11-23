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
    const body = fnBody(js, 'function render(cards)')
    // An empty status used to be skipped; an empty column must stay, it is a drop target.
    expect(body).not.toMatch(/if \(!list\.length\) continue/)
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
    const body = fnBody(js, 'function renderCard(c, statuses)')
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
