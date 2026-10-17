// Kanban toolbar search and sort. The browser code has no module boundary, so
// the real functions are sliced out of web/app.js and run in a vm.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const APP_JS = readFileSync(join(ROOT, 'web', 'app.js'), 'utf-8')
const INDEX_HTML = readFileSync(join(ROOT, 'web', 'index.html'), 'utf-8')
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

type Card = Record<string, unknown>

function setup() {
  const hint = { textContent: 'stale' }
  const ctx: Record<string, unknown> = {
    document: { getElementById: (id: string) => (id === 'kanbanSearchHint' ? hint : null) },
    t: (key: string, vars?: Record<string, unknown>) => (vars ? `${key} ${JSON.stringify(vars)}` : key),
  }
  vm.createContext(ctx)
  vm.runInContext(
    'let kanbanCards = []; let kanbanHiddenColumns = new Set();\n' +
      slice(APP_JS, 'let kanbanSearchQuery', '// Which swimlane keys') +
      slice(APP_JS, 'function kanbanCardMatchesSearch(card)', '// Project + assignee + label filters') +
      slice(APP_JS, 'function renderKanbanSearchHint()', 'function renderKanban()') +
      `globalThis.api = {
        setQuery: (q) => { kanbanSearchQuery = q },
        setSort: (s) => { kanbanSortBy = s },
        setCards: (c) => { kanbanCards = c },
        hide: (s) => kanbanHiddenColumns.add(s),
        matches: kanbanCardMatchesSearch,
        sorter: kanbanCardSorter,
        hint: renderKanbanSearchHint,
        sorts: KANBAN_SORTS,
      }`,
    ctx,
  )
  const api = ctx.api as {
    setQuery: (q: string) => void
    setSort: (s: string) => void
    setCards: (c: Card[]) => void
    hide: (s: string) => void
    matches: (c: Card) => boolean
    sorter: () => (a: Card, b: Card) => number
    hint: () => void
    sorts: string[]
  }
  return { api, hint }
}

describe('kanbanCardMatchesSearch', () => {
  const { api } = setup()
  const c = (seq: number | null, title: string): Card => ({ seq, title })

  it('an empty or blank query matches everything', () => {
    api.setQuery('')
    expect(api.matches(c(1, 'x'))).toBe(true)
    api.setQuery('   ')
    expect(api.matches(c(1, 'x'))).toBe(true)
  })

  it('a number, with or without #, matches the card number exactly', () => {
    for (const q of ['295', '#295', ' #295 ']) {
      api.setQuery(q)
      expect(api.matches(c(295, 'whatever'))).toBe(true)
      expect(api.matches(c(29, 'whatever'))).toBe(false)
      expect(api.matches(c(1295, 'whatever'))).toBe(false)
    }
  })

  it('a number does not fall back to the title, and a card without seq never matches it', () => {
    api.setQuery('42')
    expect(api.matches(c(7, 'Answer 42'))).toBe(false)
    expect(api.matches(c(null, '42'))).toBe(false)
  })

  it('text is a case-insensitive substring of the title', () => {
    api.setQuery('BACKUP')
    expect(api.matches(c(1, 'Weekly backup check'))).toBe(true)
    expect(api.matches(c(2, 'Inbox'))).toBe(false)
    expect(api.matches({ seq: 3 })).toBe(false)
  })
})

describe('kanbanCardSorter', () => {
  const { api } = setup()
  const cards: Card[] = [
    { id: 'a', seq: 5, sort_order: 2, created_at: 300, updated_at: 900 },
    { id: 'b', seq: 1, sort_order: 3, created_at: 100, updated_at: 500 },
    { id: 'c', seq: 9, sort_order: 1, created_at: 200, updated_at: 700 },
  ]
  const order = (sort: string, list = cards) => {
    api.setSort(sort)
    return list.slice().sort(api.sorter()).map((x) => x.id)
  }

  it('manual keeps the drag order (sort_order)', () => {
    expect(order('manual')).toEqual(['c', 'a', 'b'])
  })
  it('sorts by card number both ways', () => {
    expect(order('seq_asc')).toEqual(['b', 'a', 'c'])
    expect(order('seq_desc')).toEqual(['c', 'a', 'b'])
  })
  it('sorts by created and updated time', () => {
    expect(order('created_asc')).toEqual(['b', 'c', 'a'])
    expect(order('created_desc')).toEqual(['a', 'c', 'b'])
    expect(order('updated_desc')).toEqual(['a', 'c', 'b'])
  })
  it('a missing number or timestamp sorts last in both directions', () => {
    const withGap: Card[] = [...cards, { id: 'z', seq: null, sort_order: 0, created_at: null, updated_at: undefined }]
    for (const s of ['seq_asc', 'seq_desc', 'created_asc', 'created_desc', 'updated_desc']) {
      expect(order(s, withGap).at(-1)).toBe('z')
    }
  })
  it('equal timestamps fall back to the card number', () => {
    const tie: Card[] = [{ id: 'p', seq: 8, created_at: 50 }, { id: 'q', seq: 2, created_at: 50 }]
    expect(order('created_asc', tie)).toEqual(['q', 'p'])
    expect(order('created_desc', tie)).toEqual(['p', 'q'])
  })
  it('every non-manual sort the dropdown offers is a known sort, and vice versa', () => {
    const offered = [...INDEX_HTML.matchAll(/<select id="kanbanSortBy"[\s\S]*?<\/select>/g)][0][0]
    const values = [...offered.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1])
    expect(values[0]).toBe('manual')
    expect(values.slice(1)).toEqual([...api.sorts])
  })
})

describe('renderKanbanSearchHint', () => {
  it('is empty without a query', () => {
    const { api, hint } = setup()
    api.setQuery('')
    api.hint()
    expect(hint.textContent).toBe('')
  })
  it('says how many matched, and how many of those sit in hidden columns', () => {
    const { api, hint } = setup()
    api.setCards([
      { seq: 1, title: 'fix login', status: 'planned' },
      { seq: 2, title: 'fix logout', status: 'done' },
      { seq: 3, title: 'other', status: 'planned' },
    ])
    api.setQuery('fix')
    api.hint()
    expect(hint.textContent).toBe('kanban.filter.search_hits {"n":2}')
    api.hide('done')
    api.hint()
    expect(hint.textContent).toBe('kanban.filter.search_some_hidden {"n":2,"h":1}')
    api.hide('planned')
    api.hint()
    expect(hint.textContent).toBe('kanban.filter.search_all_hidden {"n":2}')
    api.setQuery('#77')
    api.hint()
    expect(hint.textContent).toBe('kanban.filter.search_none')
  })
  it('does not count an ongoing card as hidden: it stays visible in the strip', () => {
    const { api, hint } = setup()
    api.setCards([
      { seq: 1, title: 'weekly check', status: 'in_progress', labels: [{ name: 'Folyamatos' }] },
      { seq: 2, title: 'weekly report', status: 'in_progress' },
    ])
    api.hide('in_progress')
    api.setQuery('weekly check')
    api.hint()
    expect(hint.textContent).toBe('kanban.filter.search_hits {"n":1}')
    api.setQuery('weekly')
    api.hint()
    expect(hint.textContent).toBe('kanban.filter.search_some_hidden {"n":2,"h":1}')
  })
})

describe('wiring', () => {
  it('the search narrows the same base filter the board and the chip counts use', () => {
    const fn = slice(APP_JS, 'function kanbanCardMatchesBaseFilters(card) {', '\n}\n')
    expect(fn).toContain('if (!kanbanCardMatchesSearch(card)) return false')
  })
  it('every column sort goes through the sorter, flat board and swimlanes alike', () => {
    expect(APP_JS).not.toContain('.sort((a, b) => a.sort_order - b.sort_order)')
    const board = slice(APP_JS, 'function renderKanban()', '\nfunction kanbanSwimlaneMeta(')
    const lanes = slice(APP_JS, 'function renderSwimlaneBoard(', '\n// Map column status keys')
    expect(board.split('.sort(kanbanCardSorter())').length - 1).toBe(2)
    expect(lanes.split('.sort(kanbanCardSorter())').length - 1).toBe(2)
    expect(board).toContain('renderKanbanSearchHint()')
  })
  it('cards are draggable only in manual order, on mouse and on touch', () => {
    expect(APP_JS).toContain("el.draggable = kanbanSortBy === 'manual'")
    const touch = slice(APP_JS, 'function wireKanbanCardTouchDnD(el, card) {', 'const p = e.touches[0]')
    expect(touch).toContain('if (!el.draggable) return')
  })
  it('index.html carries the toolbar elements', () => {
    for (const id of ['kanbanSearch', 'kanbanSearchHint', 'kanbanSortBy']) {
      expect(INDEX_HTML).toContain(`id="${id}"`)
    }
  })
  it('both languages define every key the toolbar and the hint use', () => {
    const used = new Set([
      ...[...INDEX_HTML.matchAll(/data-i18n(?:-placeholder)?="(kanban\.filter\.(?:search|sort)_[a-z_]+)"/g)].map((m) => m[1]),
      ...[...APP_JS.matchAll(/t\('(kanban\.filter\.search_[a-z_]+)'/g)].map((m) => m[1]),
    ])
    expect(used.size).toBe(13)
    for (const [lang, src] of Object.entries(LANG)) {
      for (const key of used) expect(src, `${lang}: ${key}`).toContain(`'${key}':`)
    }
  })
})
