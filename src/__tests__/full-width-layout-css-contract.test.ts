// Contract test for the full-width dashboard layout.
//
// `main` used to cap the content at 1200px, so on a large monitor everything
// except the kanban board sat in a narrow ribbon with empty space either side.
// Removing the cap is only half the story: what makes the extra room USEFUL is
// that the card lists are `repeat(auto-fill, minmax(Npx, 1fr))` grids, which
// turn width into COLUMNS instead of stretching a fixed number of them
// (measured at a 2400px viewport: agents 3 -> 7, skills -> 5, status -> 10).
// Re-introducing a cap on `main`, or pinning one of those grids to a fixed
// column count, would each quietly undo the change -- hence both are asserted.
//
// House idiom: read the frontend files as strings and assert short,
// formatting-proof fragments.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WEB = join(__dirname, '..', '..', 'web')
// Strip comments so the explanatory comment inside the `main` rule (which
// mentions the old cap) is never mistaken for a real declaration.
const css = readFileSync(join(WEB, 'style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

/** The declarations of the first top-level `<selector> { ... }` rule. */
function ruleBody(selector: string): string {
  const re = new RegExp(`(^|\\})\\s*${selector}\\s*\\{([^}]*)\\}`, 'm')
  const m = re.exec(css)
  return m ? m[2] : ''
}

describe('full-width dashboard layout', () => {
  // Every `main { ... }` rule in the file, not just the first: the portrait
  // media query legitimately sets `max-width: 100%` (that is not a cap), so the
  // contract is specifically "no fixed pixel width".
  it('no main rule caps the content at a pixel width', () => {
    const bodies = [...css.matchAll(/(?:^|\})\s*main\s*\{([^}]*)\}/g)].map((m) => m[1])
    expect(bodies.length).toBeGreaterThan(0)
    const capped = bodies.filter((b) => /max-width\s*:\s*\d+px/.test(b))
    expect(capped).toEqual([])
  })

  // The board never had the cap; it keeps only its tighter side padding, so it
  // must not regain a max-width override that would now mean something else.
  it('the kanban override is padding only', () => {
    const body = ruleBody('main\\.kanban-active')
    expect(body).toContain('padding-left')
    expect(/max-width\s*:/.test(body)).toBe(false)
  })

  // The grids that must reflow rather than stretch. A fixed `repeat(<n>, 1fr)`
  // here would keep the old column count and just widen the cards.
  const REFLOWING = [
    'agents-grid', 'skills-grid', 'status-service-grid', 'overview-stats', 'catalog-grid',
    // The board and its swimlane rows carry five status columns in four fixed
    // tracks, so "done" wrapped onto a row of its own at EVERY window size.
    'kanban-board', 'kanban-swimlane-body',
  ]

  it.each(REFLOWING)('.%s adds columns instead of stretching', (cls) => {
    const cols = /grid-template-columns\s*:\s*([^;]+)/.exec(ruleBody(`\\.${cls}`))
    expect(cols, `.${cls} has no grid-template-columns`).not.toBeNull()
    // auto-fit and auto-fill both reflow; a literal repeat(3, ...) does not.
    expect(cols![1]).toMatch(/repeat\(\s*auto-(fill|fit)\s*,/)
  })

  // The floor is the point of the board rule: without a minimum the five
  // columns would keep fitting on one row by getting unreadably narrow.
  it('the board columns have a readable minimum width', () => {
    expect(ruleBody('\\.kanban-board')).toMatch(/--kanban-col-min:\s*(\d+)px/)
    const min = Number(/--kanban-col-min:\s*(\d+)px/.exec(ruleBody('\\.kanban-board'))![1])
    expect(min).toBeGreaterThanOrEqual(240)
  })
})
