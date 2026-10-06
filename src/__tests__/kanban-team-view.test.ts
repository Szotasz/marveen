// Team view: one row per person (what they work on now, what comes next).
// The browser code has no module boundary, so renderKanbanTeamView and
// formatActiveTime are sliced out of web/app.js and run in a vm against a
// minimal fake document. Board helpers it calls (lane meta, avatar decoration,
// the owner-strip filter) are stubbed: they have their own tests.
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

class FakeEl {
  className = ''
  textContent = ''
  innerHTML = ''
  children: FakeEl[] = []
  listeners: Record<string, () => void> = {}
  append(...c: FakeEl[]) { this.children.push(...c) }
  appendChild(c: FakeEl) { this.children.push(c); return c }
  addEventListener(ev: string, fn: () => void) { this.listeners[ev] = fn }
  querySelector() { return new FakeEl() }
}

type Card = { id: string; seq: number; title: string; status: string; priority: string; assignee: string | null; updated_at?: number; created_at?: number; active_seconds?: number }

function render(cards: Card[], lang: 'en' | 'hu' = 'en') {
  const host = new FakeEl()
  const opened: string[] = []
  const ctx: Record<string, unknown> = {
    window: {},
    document: {
      getElementById: (id: string) => (id === 'kanbanTeamView' ? host : null),
      createElement: () => new FakeEl(),
    },
    kanbanCards: cards,
    kanbanAssignees: [{ name: 'ada' }, { name: 'bob' }, { name: 'cy' }, { name: 'owner' }],
    kanbanHideFromLanes: (c: Card) => c.assignee === 'owner',
    kanbanSwimlaneMeta: (key: string) => ({ label: key, avatarClass: 'agent', avatarChar: key[0], nickname: '' }),
    kanbanDecorateAvatar: () => {},
    escapeHtml: (s: unknown) => String(s),
    showCardDetail: (c: Card) => opened.push(c.id),
  }
  vm.createContext(ctx)
  vm.runInContext(LANG[lang], ctx)
  const dict = (ctx.window as { _i18n: Record<string, Record<string, string>> })._i18n[lang]
  ctx.t = (key: string, vars: Record<string, unknown> = {}) => {
    const s = dict[key]
    if (s === undefined) throw new Error(`missing i18n key ${key}`)
    return s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k]))
  }
  vm.runInContext(
    slice(APP_JS, 'function formatActiveTime(', '\nasync function showCardDetail(') +
      slice(APP_JS, 'function renderKanbanTeamView(', '\nfunction renderKanban() {') +
      '\nrenderKanbanTeamView()',
    ctx,
  )
  const rows = host.children.filter((r) => r.className.startsWith('kanban-team-row'))
  const view = rows.map((r) => {
    const [head, body] = r.children
    const [now, next] = body.children
    const items = (cell: FakeEl) => cell.children.slice(1).map((i) => (i.className === 'kanban-team-card' ? i.innerHTML : `(${i.textContent})`))
    return { cls: r.className, head: head.innerHTML, now: items(now), next: items(next) }
  })
  return { host, rows: view, opened, rowEls: rows }
}

const NOW = Math.floor(Date.now() / 1000)
const card = (id: string, seq: number, assignee: string | null, status: string, priority = 'normal', extra: Partial<Card> = {}): Card =>
  ({ id, seq, title: `T${seq}`, status, priority, assignee, updated_at: NOW - 2 * 86400, ...extra })

describe('renderKanbanTeamView', () => {
  it('puts people with work in progress first, then by open-card count, and hides done and owner cards', () => {
    const { rows } = render([
      card('a1', 1, 'ada', 'planned'), card('a2', 2, 'ada', 'planned'), card('a3', 3, 'ada', 'waiting'),
      card('b1', 4, 'bob', 'in_progress', 'normal', { active_seconds: 3 * 3600 }),
      card('c1', 5, 'cy', 'done'),
      card('o1', 6, 'owner', 'in_progress'),
      card('u1', 7, null, 'planned'),
    ])
    expect(rows.map((r) => r.head.match(/kanban-team-name">([^<]*)/)![1])).toEqual(['bob', 'ada', '__unassigned__'])
    expect(rows[0].cls).toBe('kanban-team-row')
    expect(rows[1].cls).toBe('kanban-team-row idle')
    expect(rows[1].head).toContain('3 open')
  })

  it('fills "now" from in_progress and "next" from normal/urgent cards by card number, skipping low', () => {
    const { rows } = render([
      card('x9', 9, 'ada', 'planned', 'normal'),
      card('x2', 2, 'ada', 'waiting', 'urgent'),
      card('x5', 5, 'ada', 'planned', 'low'),
      card('x1', 1, 'ada', 'in_progress', 'normal', { active_seconds: 90 * 60 }),
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0].now).toHaveLength(1)
    expect(rows[0].now[0]).toContain('#1')
    expect(rows[0].next.map((h) => h.match(/#(\d+)/)![1])).toEqual(['2', '9'])
  })

  it('shows time in progress on a running card and moved-ago on the rest', () => {
    const { rows } = render([
      card('r', 1, 'ada', 'in_progress', 'normal', { active_seconds: 2 * 86400 + 3600 }),
      card('n', 2, 'ada', 'planned', 'normal'),
      card('m', 3, 'bob', 'in_progress', 'normal'),
    ])
    expect(rows[0].now[0]).toContain('2d in progress')
    expect(rows[0].next[0]).toContain('moved 2d ago')
    // No event history: the chip falls back to moved-ago rather than inventing a zero.
    expect(rows[1].now[0]).toContain('moved 2d ago')
    expect(rows[1].now[0]).not.toContain('in progress')
  })

  it('caps each cell at three cards and says how many more', () => {
    const cards = [1, 2, 3, 4, 5].map((n) => card(`c${n}`, n, 'ada', 'planned'))
    const { rows } = render(cards)
    expect(rows[0].next).toHaveLength(4)
    expect(rows[0].next[3]).toBe('(and 2 more)')
    expect(rows[0].now).toEqual(['(not working on anything)'])
  })

  it('opens the card detail on click', () => {
    const { rowEls, opened } = render([card('a1', 1, 'ada', 'planned')])
    const item = rowEls[0].children[1].children[1].children[1]
    item.listeners.click()
    expect(opened).toEqual(['a1'])
  })

  it('renders an empty message when nothing is open', () => {
    const { host, rows } = render([card('d', 1, 'ada', 'done')])
    expect(rows).toHaveLength(0)
    expect(host.innerHTML).toContain('No open cards.')
  })

  it('works in Hungarian too (every key it renders exists)', () => {
    const { rows } = render([
      card('r', 1, 'ada', 'in_progress', 'normal', { active_seconds: 5 * 3600 }),
      card('n', 2, 'ada', 'planned', 'normal', { updated_at: NOW - 3 * 3600 }),
    ], 'hu')
    expect(rows[0].now[0]).toContain('5ó folyamatban')
    expect(rows[0].next[0]).toContain('3 órája mozdult')
  })
})

describe('team view wiring', () => {
  it('has its button and container in index.html and is rendered with the board', () => {
    expect(INDEX_HTML).toContain('id="kanbanViewTeam"')
    expect(INDEX_HTML).toContain('id="kanbanTeamView"')
    expect(slice(APP_JS, 'function renderKanban() {', '\n}\n')).toContain('renderKanbanTeamView()')
    expect(APP_JS).toContain("teamBtn.addEventListener('click', activateTeam)")
  })
})
