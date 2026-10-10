// Board totals: "{open} open / {all} on the board" next to the view switcher,
// plus "({n} shown)" while a filter hides part of the board. renderKanbanTotals
// is sliced out of web/app.js (no module boundary) and run in a vm against the
// real lang files and a fake #kanbanTotals element.
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

const card = (id: string, status: string) => ({ id, status })

function totals(cards: { id: string; status: string }[], visible: string[] | undefined, lang: 'en' | 'hu' = 'en', withEl = true) {
  const el = { textContent: '' }
  const ctx: Record<string, unknown> = {
    window: {},
    document: { getElementById: (id: string) => (withEl && id === 'kanbanTotals' ? el : null) },
    kanbanCards: cards,
  }
  vm.createContext(ctx)
  vm.runInContext(LANG[lang], ctx)
  const dict = (ctx.window as { _i18n: Record<string, Record<string, string>> })._i18n[lang]
  ctx.t = (key: string, vars: Record<string, unknown> = {}) => {
    const s = dict[key]
    if (s === undefined) throw new Error(`missing i18n key ${key}`)
    return s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k]))
  }
  ctx.visible = visible ? new Set(visible) : undefined
  vm.runInContext(slice(APP_JS, 'function renderKanbanTotals(', '\nfunction renderKanban() {') + '\nrenderKanbanTotals(visible)', ctx)
  return el.textContent
}

const BOARD = [card('a', 'planned'), card('b', 'in_progress'), card('c', 'waiting'), card('d', 'testing'), card('e', 'done')]

describe('renderKanbanTotals', () => {
  it('counts every non-done card as open, out of all cards on the board', () => {
    expect(totals(BOARD, BOARD.map((c) => c.id))).toBe('4 open / 5 on the board')
  })

  it('adds the shown count only while a filter hides cards', () => {
    expect(totals(BOARD, ['a', 'e'])).toBe('4 open / 5 on the board (2 shown)')
    expect(totals(BOARD, [])).toBe('4 open / 5 on the board (0 shown)')
  })

  it('works without a visible set and on an empty board', () => {
    expect(totals(BOARD, undefined)).toBe('4 open / 5 on the board')
    expect(totals([], [])).toBe('0 open / 0 on the board')
  })

  it('is translated', () => {
    expect(totals(BOARD, ['a'], 'hu')).toBe('4 nyitott / 5 a táblán (1 látszik)')
  })

  it('does nothing when the element is absent', () => {
    expect(() => totals(BOARD, undefined, 'en', false)).not.toThrow()
  })
})

describe('wiring', () => {
  it('renderKanban refreshes the totals with the filtered set', () => {
    const body = slice(APP_JS, 'function renderKanban() {', '\nfunction ')
    expect(body).toContain('renderKanbanTotals(visibleCardIds)')
  })

  it('the totals element sits in the view-switcher row', () => {
    const row = slice(INDEX_HTML, 'id="kanbanViewBoard"', '</div>')
    expect(row).toContain('id="kanbanTotals"')
  })
})
