// Ongoing tasks strip: open cards labelled "Folyamatos" leave their status
// column and show as chips in a strip above the board. The browser code has no
// module boundary, so the real functions are sliced out of web/app.js and run
// in a vm against a minimal fake document.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const APP_JS = readFileSync(join(ROOT, 'web', 'app.js'), 'utf-8')
const INDEX_HTML = readFileSync(join(ROOT, 'web', 'index.html'), 'utf-8')

function slice(src: string, startMarker: string, endMarker: string): string {
  const a = src.indexOf(startMarker)
  const b = src.indexOf(endMarker, a)
  if (a < 0 || b < 0) throw new Error(`marker not found: ${startMarker}`)
  return src.slice(a, b)
}

class FakeEl {
  hidden = false
  textContent = ''
  className = ''
  title = ''
  type = ''
  children: FakeEl[] = []
  listeners: Record<string, () => void> = {}
  set innerHTML(_v: string) { this.children = [] }
  appendChild(c: FakeEl) { this.children.push(c); return c }
  addEventListener(ev: string, fn: () => void) { this.listeners[ev] = fn }
  get text(): string { return String(this.textContent) + this.children.map((c) => c.text).join('') }
}

function setup() {
  const els: Record<string, FakeEl> = {
    kanbanOngoing: new FakeEl(), kanbanOngoingBody: new FakeEl(), countOngoing: new FakeEl(),
  }
  const opened: unknown[] = []
  const ctx: Record<string, unknown> = {
    document: {
      getElementById: (id: string) => els[id] ?? null,
      createElement: () => new FakeEl(),
      createTextNode: (t: string) => Object.assign(new FakeEl(), { textContent: t }),
    },
    showCardDetail: (c: unknown) => opened.push(c),
  }
  vm.createContext(ctx)
  vm.runInContext(
    slice(APP_JS, 'const KANBAN_ONGOING_LABEL', 'function renderKanban()') +
      'globalThis.isOngoing = kanbanIsOngoing; globalThis.render = renderKanbanOngoing',
    ctx,
  )
  return { els, opened, isOngoing: ctx.isOngoing as (c: unknown) => boolean, render: ctx.render as (c: unknown[]) => void }
}

const ONGOING = { id: 'l1', name: 'Folyamatos' }
const OTHER = { id: 'l2', name: 'Rád vár' }

describe('kanbanIsOngoing', () => {
  const { isOngoing } = setup()
  it('takes an open card carrying the label, in any open status', () => {
    for (const status of ['planned', 'in_progress', 'waiting', 'testing']) {
      expect(isOngoing({ status, labels: [ONGOING] })).toBe(true)
    }
  })
  it('leaves a done card in Done, even with the label', () => {
    expect(isOngoing({ status: 'done', labels: [ONGOING] })).toBe(false)
  })
  it('also takes the English name and ignores case and padding', () => {
    expect(isOngoing({ status: 'planned', labels: [{ id: 'l9', name: 'Ongoing' }] })).toBe(true)
    expect(isOngoing({ status: 'planned', labels: [{ id: 'l9', name: ' folyamatos ' }] })).toBe(true)
    expect(isOngoing({ status: 'planned', labels: [{ id: 'l9', name: 'Ongoing work' }] })).toBe(false)
  })
  it('ignores cards without the label, or with no labels at all', () => {
    expect(isOngoing({ status: 'in_progress', labels: [OTHER] })).toBe(false)
    expect(isOngoing({ status: 'in_progress' })).toBe(false)
    expect(isOngoing({ status: 'in_progress', labels: [null] })).toBe(false)
  })
})

describe('renderKanbanOngoing', () => {
  it('hides the strip when there is nothing to show', () => {
    const { els, render } = setup()
    render([])
    expect(els.kanbanOngoing.hidden).toBe(true)
    expect(String(els.countOngoing.textContent)).toBe('0')
  })

  it('shows one chip per card, ordered by number, and a chip opens its card', () => {
    const { els, opened, render } = setup()
    const a = { id: 'a', seq: 12, title: 'Weekly backup check' }
    const b = { id: 'b', seq: 3, title: 'Watch the inbox' }
    render([a, b])
    expect(els.kanbanOngoing.hidden).toBe(false)
    expect(String(els.countOngoing.textContent)).toBe('2')
    const chips = els.kanbanOngoingBody.children
    expect(chips.map((c) => c.text)).toEqual(['#3 Watch the inbox', '#12 Weekly backup check'])
    chips[1].listeners.click()
    expect(opened).toEqual([a])
  })

  it('does not reorder the array it was given', () => {
    const { render } = setup()
    const cards = [{ id: 'x', seq: 9, title: 'x' }, { id: 'y', seq: 1, title: 'y' }]
    render(cards)
    expect(cards.map((c) => c.id)).toEqual(['x', 'y'])
  })
})

describe('wiring', () => {
  it('renderKanban routes an ongoing card to the strip before it reaches a status column', () => {
    const body = slice(APP_JS, 'function renderKanban()', 'function renderSwimlaneBoard(')
    const route = body.indexOf('if (kanbanIsOngoing(card)) { ongoing.push(card); continue }')
    const push = body.indexOf('if (grouped[card.status]) grouped[card.status].push(card)')
    expect(route).toBeGreaterThan(0)
    expect(push).toBeGreaterThan(route)
    expect(body).toContain('renderKanbanOngoing(ongoing)')
  })

  it('index.html carries every element the renderer looks up', () => {
    for (const id of ['kanbanOngoing', 'kanbanOngoingBody', 'countOngoing']) {
      expect(INDEX_HTML).toContain(`id="${id}"`)
    }
  })
})
