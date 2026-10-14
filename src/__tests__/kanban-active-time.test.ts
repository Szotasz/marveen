// Time in progress (active_seconds): wall-clock seconds a card has stood in the
// in_progress column, summed over every stay, read off kanban_card_events.
//
// The db half runs the real entry points (createKanbanCard, moveKanbanCard,
// listKanbanCards, sumInProgressSeconds) on an in-memory database with a fake
// clock. The browser half slices formatActiveTime out of web/app.js and runs it
// in a vm, because app.js has no module boundary.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import {
  initDatabase, createKanbanCard, moveKanbanCard, listKanbanCards,
  sumInProgressSeconds, getKanbanCardEvents,
} from '../db.js'

const T0 = Date.UTC(2026, 0, 5, 9, 0, 0)

function at(offsetSec: number) {
  vi.setSystemTime(T0 + offsetSec * 1000)
}

function activeOf(id: string): number | undefined {
  const card = listKanbanCards().find((c) => c.id === id)
  if (!card) throw new Error(`no card ${id}`)
  return card.active_seconds
}

describe('sumInProgressSeconds / listKanbanCards active_seconds', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    at(0)
    initDatabase(':memory:')
  })
  afterEach(() => { vi.useRealTimers() })

  it('leaves active_seconds absent for a card with no event rows (unknown, not zero)', () => {
    createKanbanCard({ id: 'never-moved', title: 'Never moved' })
    const card = listKanbanCards().find((c) => c.id === 'never-moved')!
    expect('active_seconds' in card).toBe(false)
    expect(sumInProgressSeconds(['never-moved']).has('never-moved')).toBe(false)
  })

  it('reports a measured zero for a card that moved but never entered in_progress', () => {
    createKanbanCard({ id: 'c', title: 'Waited only' })
    at(60); moveKanbanCard('c', 'waiting', 0, 'tester')
    at(600)
    expect(activeOf('c')).toBe(0)
  })

  it('sums every separate stay in in_progress', () => {
    createKanbanCard({ id: 'c', title: 'Two stays' })
    at(100); moveKanbanCard('c', 'in_progress', 0, 'tester')
    at(400); moveKanbanCard('c', 'waiting', 0, 'tester') // stay 1: 300 s
    at(1000); moveKanbanCard('c', 'in_progress', 0, 'tester')
    at(1500); moveKanbanCard('c', 'done', 0, 'tester') // stay 2: 500 s
    at(9999)
    expect(activeOf('c')).toBe(800)
  })

  it('charges an open stay up to now', () => {
    createKanbanCard({ id: 'c', title: 'Still going' })
    at(100); moveKanbanCard('c', 'in_progress', 0, 'tester')
    at(100 + 3 * 3600)
    expect(activeOf('c')).toBe(3 * 3600)
    at(100 + 5 * 3600)
    expect(activeOf('c')).toBe(5 * 3600)
  })

  it('keeps cards apart and only returns the requested ids', () => {
    createKanbanCard({ id: 'a', title: 'A' })
    createKanbanCard({ id: 'b', title: 'B' })
    at(10); moveKanbanCard('a', 'in_progress', 0, 'tester')
    at(20); moveKanbanCard('b', 'in_progress', 0, 'tester')
    at(70); moveKanbanCard('a', 'done', 0, 'tester')
    at(220); moveKanbanCard('b', 'done', 0, 'tester')
    const m = sumInProgressSeconds(['a'])
    expect(m.get('a')).toBe(60)
    expect(m.has('b')).toBe(false)
    expect(sumInProgressSeconds(['a', 'b']).get('b')).toBe(200)
    expect(sumInProgressSeconds([]).size).toBe(0)
  })

  it('gives a card born in in_progress an opening event, so its time is measured', () => {
    at(50)
    createKanbanCard({ id: 'born', title: 'Created in progress', status: 'in_progress', assignee: 'tester' })
    const ev = getKanbanCardEvents('born')
    expect(ev).toHaveLength(1)
    expect(ev[0].from_status).toBeNull()
    expect(ev[0].to_status).toBe('in_progress')
    expect(ev[0].actor).toBe('tester')
    at(50 + 1200)
    expect(activeOf('born')).toBe(1200)
  })

  it('writes no opening event for a card born in planned (the default)', () => {
    createKanbanCard({ id: 'p', title: 'Planned' })
    expect(getKanbanCardEvents('p')).toHaveLength(0)
  })
})

// ---------- browser: formatActiveTime ----------

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const APP_JS = readFileSync(join(ROOT, 'web', 'app.js'), 'utf-8')
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

function loadFormatter(lang: 'en' | 'hu') {
  const ctx: Record<string, unknown> = { window: {} }
  vm.createContext(ctx)
  vm.runInContext(LANG[lang], ctx)
  const dict = (ctx.window as { _i18n: Record<string, Record<string, string>> })._i18n[lang]
  ctx.t = (key: string, vars: Record<string, unknown> = {}) => {
    const s = dict[key]
    if (s === undefined) throw new Error(`missing i18n key ${key}`)
    return s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k]))
  }
  vm.runInContext(slice(APP_JS, 'function formatActiveTime(', '\nasync function showCardDetail(') + '\nthis.formatActiveTime = formatActiveTime', ctx)
  return ctx.formatActiveTime as (sec: unknown) => string | null
}

describe('formatActiveTime (card detail)', () => {
  const en = loadFormatter('en')
  const hu = loadFormatter('hu')

  it('returns null for an unmeasured card instead of a fake zero', () => {
    expect(en(undefined)).toBeNull()
    expect(en(null)).toBeNull()
  })

  it('distinguishes a measured zero from unknown', () => {
    expect(en(0)).toBe('never been in progress')
    expect(hu(0)).toBe('még nem volt folyamatban')
  })

  it('picks the unit by size', () => {
    expect(en(59)).toBe('0m')
    expect(en(25 * 60)).toBe('25m')
    expect(en(3 * 3600 + 7 * 60)).toBe('3h 7m')
    expect(en(2 * 86400 + 5 * 3600 + 59 * 60)).toBe('2d 5h')
    expect(hu(3 * 3600 + 7 * 60)).toBe('3 óra 7 perc')
    expect(hu(2 * 86400 + 5 * 3600)).toBe('2 nap 5 óra')
  })

  it('every key the detail panel renders exists in both languages', () => {
    const keys = ['kanban.meta.active', 'kanban.active.none', 'kanban.active.tooltip', 'kanban.active.tooltip_none']
    for (const lang of ['en', 'hu'] as const) {
      for (const k of keys) expect(LANG[lang]).toContain(`'${k}':`)
    }
    expect(APP_JS).toContain("t('kanban.meta.active')")
  })
})
