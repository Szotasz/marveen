// Team view: one row per person (what they work on now, what comes next).
// The browser code has no module boundary, so renderKanbanTeamView and
// formatActiveTime are sliced out of web/app.js and run in a vm against a
// minimal fake document. The owner-strip filter and avatar decoration are
// stubbed (they have their own tests); the priority order, the ongoing-label
// check and the person meta are the real ones, sliced from app.js too.
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
  attrs: Record<string, string> = {}
  tabIndex = -1
  addEventListener(ev: string, fn: () => void) { this.listeners[ev] = fn }
  setAttribute(k: string, v: string) { this.attrs[k] = v }
  querySelector() { return new FakeEl() }
}

type Card = {
  id: string; seq: number; title: string; status: string; priority: string; assignee: string | null
  updated_at?: number; created_at?: number; last_status_at?: number; active_seconds?: number
  parent_id?: string | null; labels?: { name: string }[]
}
type Assignee = { name: string; type?: string; displayName?: string; nickname?: string }

const DEFAULT_ASSIGNEES: Assignee[] = [
  { name: 'ada', type: 'agent' }, { name: 'bob', type: 'agent' }, { name: 'cy', type: 'agent' }, { name: 'owner', type: 'owner' },
]

// Same output as app.js escapeHtml (text escaping plus both quotes), without a DOM.
const escapeHtml = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))

function render(cards: Card[], lang: 'en' | 'hu' = 'en', opts: { assignees?: Assignee[]; groupBy?: string } = {}) {
  const host = new FakeEl()
  const opened: string[] = []
  const ctx: Record<string, unknown> = {
    window: {},
    document: {
      getElementById: (id: string) => (id === 'kanbanTeamView' ? host : null),
      createElement: () => new FakeEl(),
    },
    kanbanCards: cards,
    kanbanAssignees: opts.assignees ?? DEFAULT_ASSIGNEES,
    kanbanGroupBy: opts.groupBy ?? 'assignee',
    kanbanHideFromLanes: (c: Card) => c.assignee === 'owner',
    // The team view must never go through the lane meta: grouped by priority
    // it returns the raw key. A stub that throws proves it is not called.
    kanbanSwimlaneMeta: () => { throw new Error('team view must use kanbanPersonMeta') },
    kanbanDecorateAvatar: () => {},
    escapeHtml,
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
    slice(APP_JS, 'const KANBAN_ONGOING_LABELS =', '\n') + '\n' +
      slice(APP_JS, 'function kanbanIsOngoing(', '\n}\n') + '\n}\n' +
      slice(APP_JS, 'const KANBAN_PRIORITY_ORDER =', '\n') + '\n' +
      slice(APP_JS, 'function kanbanPersonMeta(', '\n}\n') + '\n}\n' +
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
    expect(rows.map((r) => r.head.match(/kanban-team-name">([^<]*)/)![1])).toEqual(['bob', 'ada', 'Unassigned'])
    expect(rows[0].cls).toBe('kanban-team-row')
    expect(rows[1].cls).toBe('kanban-team-row idle')
    expect(rows[1].head).toContain('3 open')
  })

  it('fills "now" from in_progress and "next" from planned cards, most urgent first, then by card number', () => {
    const { rows } = render([
      card('x9', 9, 'ada', 'planned', 'normal'),
      card('x8', 8, 'ada', 'planned', 'high'),
      card('x7', 7, 'ada', 'planned', 'urgent'),
      card('x3', 3, 'ada', 'planned', 'normal'),
      card('x5', 5, 'ada', 'planned', 'low'),
      card('x1', 1, 'ada', 'in_progress', 'normal', { active_seconds: 90 * 60 }),
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0].now).toHaveLength(1)
    expect(rows[0].now[0]).toContain('#1')
    // high is listed (it was dropped once), low is not, urgent leads.
    expect(rows[0].next.slice(0, 3).map((h) => h.match(/#(\d+)/)![1])).toEqual(['7', '8', '3'])
    expect(rows[0].next[3]).toBe('(and 1 more)')
    expect(rows[0].head).toContain('6 open')
  })

  it('does not offer waiting or testing cards as next, but still counts them as open', () => {
    const { rows } = render([
      card('w', 2, 'ada', 'waiting', 'urgent'),
      card('t', 3, 'ada', 'testing', 'high'),
      card('p', 9, 'ada', 'planned', 'normal'),
    ])
    expect(rows[0].next.map((h) => h.match(/#(\d+)/)![1])).toEqual(['9'])
    expect(rows[0].head).toContain('3 open')
  })

  it('leaves out subtasks drawn inside their parent and ongoing cards, like the board does', () => {
    const { rows } = render([
      card('p', 1, 'ada', 'planned', 'normal'),
      card('s-same', 2, 'ada', 'planned', 'normal', { parent_id: 'p' }),
      card('s-moved', 3, 'ada', 'in_progress', 'normal', { parent_id: 'p' }),
      card('on', 4, 'bob', 'in_progress', 'normal', { labels: [{ name: ' Ongoing ' }] }),
      card('on-hu', 5, 'bob', 'planned', 'normal', { labels: [{ name: 'folyamatos' }] }),
    ])
    // The subtask in another column is a card of its own on the board, so it counts.
    expect(rows.map((r) => r.head.match(/kanban-team-name">([^<]*)/)![1])).toEqual(['ada'])
    expect(rows[0].head).toContain('2 open')
    expect(rows[0].now[0]).toContain('#3')
    expect(rows[0].next.map((h) => h.match(/#(\d+)/)![1])).toEqual(['1'])
  })

  it('measures moved-ago from the last column change, not from the last edit', () => {
    const { rows } = render([
      card('a', 1, 'ada', 'planned', 'normal', { last_status_at: NOW - 3 * 86400, updated_at: NOW - 60 }),
      card('b', 2, 'ada', 'planned', 'normal', { last_status_at: NOW - 5 * 60 }),
      card('c', 3, 'ada', 'planned', 'normal', { last_status_at: NOW - 5 }),
    ])
    expect(rows[0].next[0]).toContain('moved 3d ago')
    // Under an hour is minutes, under a minute is "just now": no invented 1h floor.
    expect(rows[0].next[1]).toContain('moved 5m ago')
    expect(rows[0].next[2]).toContain('moved just now')
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

  it('opens the card detail on click, and on Enter or Space from the keyboard', () => {
    const { rowEls, opened } = render([card('a1', 1, 'ada', 'planned')])
    const item = rowEls[0].children[1].children[1].children[1]
    expect(item.tabIndex).toBe(0)
    expect(item.attrs.role).toBe('button')
    item.listeners.click()
    const key = item.listeners.keydown as unknown as (e: { key: string; preventDefault: () => void }) => void
    let prevented = 0
    key({ key: 'Enter', preventDefault: () => prevented++ })
    key({ key: ' ', preventDefault: () => prevented++ })
    key({ key: 'a', preventDefault: () => prevented++ })
    expect(opened).toEqual(['a1', 'a1', 'a1'])
    expect(prevented).toBe(2)
  })

  it('shows people by name and nickname even when the board is grouped by priority, and escapes them', () => {
    const { rows } = render([
      card('a', 1, 'ada', 'planned'),
      card('e', 2, 'x"><img src=y>', 'planned'),
      card('u', 3, null, 'planned'),
    ], 'en', {
      groupBy: 'priority',
      assignees: [{ name: 'ada', type: 'agent', displayName: 'Ada L', nickname: 'Countess' }, { name: 'owner', type: 'owner' }],
    })
    const heads = rows.map((r) => r.head)
    const ada = heads.find((h) => h.includes('Ada L'))!
    expect(ada).toContain('kanban-team-avatar agent')
    expect(ada).toContain('<span class="kanban-nickname">Countess</span>')
    const evil = heads.find((h) => h.includes('&lt;img'))!
    expect(evil).not.toContain('"><img')
    expect(evil).toContain('kanban-team-avatar unknown')
    expect(heads.some((h) => h.includes('>Unassigned<'))).toBe(true)
    expect(heads.join('')).not.toContain('__unassigned__')
  })

  it('keeps a subtask whose parent is someone else\'s, the owner\'s or ongoing: this row is the only place it shows', () => {
    const { rows } = render([
      card('pb', 1, 'bob', 'planned'),
      card('c1', 2, 'ada', 'planned', 'normal', { parent_id: 'pb' }),
      card('po', 3, 'owner', 'planned'),
      card('c2', 4, 'ada', 'planned', 'normal', { parent_id: 'po' }),
      card('pg', 5, 'ada', 'planned', 'normal', { labels: [{ name: 'ongoing' }] }),
      card('c3', 6, 'ada', 'planned', 'normal', { parent_id: 'pg' }),
    ])
    const ada = rows.find((r) => r.head.includes('kanban-team-name">ada<'))!
    expect(ada.head).toContain('3 open')
    expect(ada.next.map((h) => h.match(/#(\d+)/)![1])).toEqual(['2', '4', '6'])
    const bob = rows.find((r) => r.head.includes('kanban-team-name">bob<'))!
    expect(bob.head).toContain('1 open')
  })

  it('escapes the avatar class, which comes from the assignee list', () => {
    const { rows } = render([card('a', 1, 'ada', 'planned')], 'en', {
      assignees: [{ name: 'ada', type: 'agent" onmouseover="x' }],
    })
    expect(rows[0].head).toContain('kanban-team-avatar agent&quot; onmouseover=&quot;x"')
    expect(rows[0].head).not.toContain('onmouseover="x')
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
    expect(rows[0].now[0]).toContain('5 óra folyamatban')
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

  it('gives a person a portrait whatever the board grouping; the priority lane header skips it at its call site', () => {
    const ctx: Record<string, unknown> = {
      kanbanGroupBy: 'priority',
      kanbanAssignees: [{ name: 'ada', type: 'agent' }, { name: 'owner', type: 'owner' }],
      avatarBust: () => '',
    }
    vm.createContext(ctx)
    vm.runInContext(slice(APP_JS, 'function kanbanAvatarUrlFor(', '\n}\n') + '\n}\nthis.url = [kanbanAvatarUrlFor("ada"), kanbanAvatarUrlFor("owner"), kanbanAvatarUrlFor("__unassigned__")]', ctx)
    expect(ctx.url).toEqual(['/api/agents/ada/avatar', '/api/marveen/owner-avatar', null])
    expect(APP_JS).toContain("if (kanbanGroupBy !== 'priority') kanbanDecorateAvatar(header.querySelector('.kanban-swimlane-avatar'), key)")
    expect(APP_JS).toContain('<span class="kanban-swimlane-avatar ${escapeHtml(meta.avatarClass)}">')
  })
})
