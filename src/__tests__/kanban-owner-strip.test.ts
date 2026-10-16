// Owner strip ("Rád vár" / "Waiting on you"): the owner's open cards plus any
// card carrying the "Rád vár" label, above the board and outside every filter.
// The browser code has no module boundary, so the real functions are sliced out
// of web/app.js and run in a vm against a minimal fake document.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const APP_JS = readFileSync(join(ROOT, 'web', 'app.js'), 'utf-8')
const INDEX_HTML = readFileSync(join(ROOT, 'web', 'index.html'), 'utf-8')
const STYLE_CSS = readFileSync(join(ROOT, 'web', 'style.css'), 'utf-8')
const LANG = {
  en: readFileSync(join(ROOT, 'web', 'lang', 'en.js'), 'utf-8'),
  hu: readFileSync(join(ROOT, 'web', 'lang', 'hu.js'), 'utf-8'),
}

function slice(src: string, startMarker: string, endMarker: string): string {
  const a = src.indexOf(startMarker)
  const b = src.indexOf(endMarker, a)
  if (a < 0 || b < 0) throw new Error(`marker not found: ${startMarker}`)
  return src.slice(a, b)
}

class FakeEl {
  hidden = false
  textContent: unknown = ''
  className = ''
  title = ''
  children: FakeEl[] = []
  classes = new Set<string>()
  listeners: Record<string, () => void> = {}
  classList = {
    toggle: (c: string, on: boolean) => { if (on) this.classes.add(c); else this.classes.delete(c) },
    contains: (c: string) => this.classes.has(c),
  }
  set innerHTML(_v: string) { this.children = [] }
  append(...c: FakeEl[]) { this.children.push(...c) }
  appendChild(c: FakeEl) { this.children.push(c); return c }
  addEventListener(ev: string, fn: () => void) { this.listeners[ev] = fn }
  find(cls: string): FakeEl[] {
    const out: FakeEl[] = []
    for (const c of this.children) {
      if (c.className.split(' ').includes(cls)) out.push(c)
      out.push(...c.find(cls))
    }
    return out
  }
}

function setup(owner: string | null, cards: unknown[], assignees: unknown[] = []) {
  const strip = new FakeEl()
  const store = new Map<string, string>()
  const opened: unknown[] = []
  const decorated: string[] = []
  const ctx: Record<string, unknown> = {
    document: {
      getElementById: (id: string) => (id === 'kanbanOwnerStrip' ? strip : null),
      createElement: () => new FakeEl(),
    },
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) },
    t: (k: string) => k,
    ownerAssigneeName: () => owner,
    kanbanCards: cards,
    kanbanAssignees: assignees,
    KANBAN_PRIORITY_ORDER: ['urgent', 'high', 'normal', 'low'],
    kanbanDecorateAvatar: (_el: unknown, key: string) => decorated.push(key),
    kanbanSwimlaneMeta: (key: string) => ({ nickname: key === owner ? 'Grand Designer' : '' }),
    showCardDetail: (c: unknown) => opened.push(c),
  }
  vm.createContext(ctx)
  vm.runInContext(
    slice(APP_JS, 'const KANBAN_OWNER_QUEUE_LABEL', 'function renderKanban()') +
      slice(APP_JS, 'function kanbanHideFromLanes(card)', 'function renderSwimlaneBoard(') +
      'globalThis.onStrip = kanbanIsOnOwnerStrip; globalThis.hide = kanbanHideFromLanes; globalThis.render = renderKanbanOwnerStrip',
    ctx,
  )
  return {
    strip, store, opened, decorated,
    onStrip: ctx.onStrip as (c: unknown, owner: string) => boolean,
    hide: ctx.hide as (c: unknown) => boolean,
    render: ctx.render as () => void,
  }
}

const RAD_VAR = { id: 'l1', name: 'Rád vár' }

describe('kanbanIsOnOwnerStrip: assignee OR the "Rád vár" label', () => {
  const { onStrip } = setup('Jane Doe', [])
  it("takes the owner's own open card, matched case-insensitively", () => {
    expect(onStrip({ status: 'planned', assignee: ' jane doe ', labels: [] }, 'Jane Doe')).toBe(true)
  })
  it("takes an agent's card that carries the label", () => {
    expect(onStrip({ status: 'waiting', assignee: 'researcher', labels: [RAD_VAR] }, 'Jane Doe')).toBe(true)
  })
  it('folds accents and case in the label name', () => {
    expect(onStrip({ status: 'planned', assignee: 'dev', labels: [{ id: 'x', name: '  rad VAR ' }] }, 'Jane Doe')).toBe(true)
  })
  it('leaves an unlabelled agent card and every done card out', () => {
    expect(onStrip({ status: 'planned', assignee: 'dev', labels: [{ id: 'y', name: 'Bug' }] }, 'Jane Doe')).toBe(false)
    expect(onStrip({ status: 'done', assignee: 'dev', labels: [RAD_VAR] }, 'Jane Doe')).toBe(false)
    expect(onStrip({ status: 'done', assignee: 'Jane Doe', labels: [] }, 'Jane Doe')).toBe(false)
  })
  it('survives a card with no labels field, or a null label', () => {
    expect(onStrip({ status: 'planned', assignee: 'dev' }, 'Jane Doe')).toBe(false)
    expect(onStrip({ status: 'planned', assignee: 'dev', labels: [null] }, 'Jane Doe')).toBe(false)
  })
})

describe('kanbanHideFromLanes', () => {
  it("hides only the owner's OPEN cards; a labelled agent card stays in its lane", () => {
    const { hide } = setup('Jane Doe', [])
    expect(hide({ status: 'planned', assignee: 'jane doe', labels: [] })).toBe(true)
    expect(hide({ status: 'done', assignee: 'Jane Doe', labels: [] })).toBe(false)
    expect(hide({ status: 'waiting', assignee: 'researcher', labels: [RAD_VAR] })).toBe(false)
  })
  it('hides nothing when the install has no owner name', () => {
    const { hide } = setup(null, [])
    expect(hide({ status: 'planned', assignee: 'Jane Doe' })).toBe(false)
  })
})

describe('renderKanbanOwnerStrip', () => {
  const cards = [
    { id: 'a', seq: 9, title: 'Low own', status: 'planned', priority: 'low', assignee: 'Jane Doe', labels: [] },
    { id: 'b', seq: 4, title: 'Needs a decision', status: 'waiting', priority: 'high', assignee: 'researcher', labels: [RAD_VAR] },
    { id: 'c', seq: 2, title: 'Normal own', status: 'in_progress', priority: 'normal', assignee: 'Jane Doe', labels: [] },
    { id: 'd', seq: 1, title: 'Other work', status: 'planned', priority: 'urgent', assignee: 'dev', labels: [] },
    { id: 'e', seq: 3, title: 'Closed', status: 'done', priority: 'urgent', assignee: 'Jane Doe', labels: [] },
  ]
  const assignees = [{ name: 'researcher', type: 'agent', displayName: 'Researcher' }]

  it('lists the queue by priority, then card number, and says whose labelled card it is', () => {
    const { strip, render } = setup('Jane Doe', cards, assignees)
    render()
    expect(strip.hidden).toBe(false)
    const items = strip.find('kanban-owner-strip-item')
    expect(items.map((i) => i.title)).toEqual(['Needs a decision (Researcher)', 'Normal own', 'Low own'])
    expect(String(strip.find('kanban-owner-strip-count')[0].textContent)).toBe('3')
    expect(strip.find('kanban-nickname')[0].textContent).toBe('Grand Designer')
    expect(items[0].find('who-name')[0].textContent).toBe('Researcher')
    expect(items[1].find('who')).toEqual([])
  })

  it('splits the queue into urgent / when-I-have-time / can-wait groups, urgent first, empty tiers left out', () => {
    const extra = { id: 'f', seq: 7, title: 'Urgent own', status: 'planned', priority: 'urgent', assignee: 'Jane Doe', labels: [] }
    const { strip, render } = setup('Jane Doe', [...cards, extra], assignees)
    render()
    const groups = strip.find('kanban-owner-strip-group')
    expect(groups.map((g) => g.className)).toEqual([
      'kanban-owner-strip-group tier-urgent',
      'kanban-owner-strip-group tier-later',
      'kanban-owner-strip-group tier-parked',
    ])
    expect(groups.map((g) => g.find('kanban-owner-strip-group-head')[0].textContent)).toEqual([
      'kanban.owner_strip.tier_urgent · 2',
      'kanban.owner_strip.tier_later · 1',
      'kanban.owner_strip.tier_parked · 1',
    ])
    // urgent and high share the top tier, still in priority order
    expect(groups[0].find('kanban-owner-strip-item').map((i) => i.title)).toEqual(['Urgent own', 'Needs a decision (Researcher)'])
    expect(groups[2].find('kanban-owner-strip-item').map((i) => i.title)).toEqual(['Low own'])

    const onlyLow = setup('Jane Doe', [cards[0]], assignees)
    onlyLow.render()
    expect(onlyLow.strip.find('kanban-owner-strip-group').map((g) => g.className)).toEqual(['kanban-owner-strip-group tier-parked'])
  })

  it('a card with no priority falls in the middle tier', () => {
    const { strip, render } = setup('Jane Doe', [{ id: 'g', seq: 5, title: 'No priority', status: 'planned', assignee: 'Jane Doe', labels: [] }])
    render()
    expect(strip.find('kanban-owner-strip-group')[0].className).toBe('kanban-owner-strip-group tier-later')
  })

  it('a chip opens its card; the head collapses and remembers it', () => {
    const { strip, store, opened, render } = setup('Jane Doe', cards, assignees)
    render()
    strip.find('kanban-owner-strip-item')[1].listeners.click()
    expect(opened).toEqual([cards[2]])
    strip.find('kanban-owner-strip-head')[0].listeners.click()
    expect(store.get('marveen.kanbanOwnerStripCollapsed')).toBe('1')
    expect(strip.classes.has('collapsed')).toBe(true)
  })

  it('draws portraits for the owner and for the agent behind a labelled card', () => {
    const { decorated, render } = setup('Jane Doe', cards, assignees)
    render()
    expect(decorated).toEqual(['Jane Doe', 'researcher'])
  })

  it('stays hidden with nothing waiting, or without an owner name', () => {
    const empty = setup('Jane Doe', [cards[3], cards[4]], assignees)
    empty.render()
    expect(empty.strip.hidden).toBe(true)
    const noOwner = setup(null, cards, assignees)
    noOwner.render()
    expect(noOwner.strip.hidden).toBe(true)
  })
})

describe('wiring', () => {
  it('renderKanban draws the strip, and the swimlane board skips the hidden cards in both passes', () => {
    expect(slice(APP_JS, 'function renderKanban()', 'function renderSwimlaneBoard(')).toContain('renderKanbanOwnerStrip()')
    const lanes = slice(APP_JS, 'function renderSwimlaneBoard(', '\n// Map column status keys')
    expect(lanes).toContain('if (kanbanHideFromLanes(c)) continue')
    expect(lanes).toContain('!kanbanHideFromLanes(c) && kanbanSwimlaneKeyFor(c) === key')
    expect(lanes).toContain("kanbanDecorateAvatar(header.querySelector('.kanban-swimlane-avatar'), key)")
  })
  it('collapsing hides the tier groups', () => {
    expect(STYLE_CSS).toContain('.kanban-owner-strip.collapsed .kanban-owner-strip-groups { display: none; }')
  })
  it('index.html carries the strip container, and both languages its strings', () => {
    expect(INDEX_HTML).toContain('id="kanbanOwnerStrip"')
    for (const [lang, src] of Object.entries(LANG)) {
      for (const k of ['title', 'show', 'hide', 'tier_urgent', 'tier_later', 'tier_parked']) expect(src, lang).toContain(`'kanban.owner_strip.${k}':`)
    }
  })
})
