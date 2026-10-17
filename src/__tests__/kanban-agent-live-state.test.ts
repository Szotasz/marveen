// Live agent state on in_progress kanban cards. The browser code has no module
// boundary, so the real functions are sliced out of web/app.js and run in a vm.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const APP_JS = readFileSync(join(ROOT, 'web', 'app.js'), 'utf-8')
const HU = readFileSync(join(ROOT, 'web', 'lang', 'hu.js'), 'utf-8')
const EN = readFileSync(join(ROOT, 'web', 'lang', 'en.js'), 'utf-8')

function slice(src: string, startMarker: string, endMarker: string): string {
  const a = src.indexOf(startMarker)
  const b = src.indexOf(endMarker, a)
  if (a < 0 || b < 0) throw new Error(`marker not found: ${startMarker}`)
  return src.slice(a, b)
}

type Fns = {
  set: (rows: unknown) => void
  badge: (card: unknown) => string
  level: (card: unknown) => { level: string } | null
}

function setup(): Fns {
  const ctx: Record<string, unknown> = {
    t: (k: string, p?: Record<string, unknown>) => (p ? `${k}${JSON.stringify(p)}` : k),
    escapeHtml: (s: string) => String(s).replace(/[&<>"']/g, '_'),
    escapeAttr: (s: string) => String(s).replace(/[&<>"']/g, '_'),
    formatDurationShort: (sec: number) => `${Math.floor(sec / 60)}m`,
    kanbanCards: [{ id: 'c1', seq: 1 }, { id: 'c2', seq: 2 }],
  }
  vm.createContext(ctx)
  vm.runInContext(
    slice(APP_JS, 'let kanbanAgentStatus = new Map()', 'function createCardEl(') +
      'globalThis.set = setKanbanAgentStatus; globalThis.badge = kanbanAgentLiveBadge; globalThis.level = kanbanAgentLiveLevel',
    ctx,
  )
  return ctx as unknown as Fns
}

const card = (over: Record<string, unknown> = {}) => ({ id: 'c1', status: 'in_progress', assignee: 'Cody', ...over })

describe('kanban live agent state', () => {
  it('maps each agent state to a level, matching the assignee case-insensitively', () => {
    const f = setup()
    const expect_ = { working: 'ok', idle: 'idle', stalled: 'warn', dead: 'bad', stopped: 'bad', unreachable: 'bad' }
    for (const [state, lvl] of Object.entries(expect_)) {
      f.set([{ agent: 'cody', state, lastSignalAgeSec: 120 }])
      expect(f.level(card())?.level).toBe(lvl)
      expect(f.badge(card())).toContain(`kanban-agent-live-${lvl}`)
    }
  })

  it('says nothing for an unknown state, a missing agent, or a card not in progress', () => {
    const f = setup()
    f.set([{ agent: 'cody', state: 'unknown', lastSignalAgeSec: 5 }])
    expect(f.badge(card())).toBe('')
    f.set([{ agent: 'roxy', state: 'working', lastSignalAgeSec: 5 }])
    expect(f.badge(card())).toBe('')
    f.set([{ agent: 'cody', state: 'dead', lastSignalAgeSec: 5 }])
    expect(f.badge(card({ status: 'planned' }))).toBe('')
    expect(f.badge(card({ assignee: null }))).toBe('')
  })

  it('survives a failed status fetch (non-array payload) with no markers', () => {
    const f = setup()
    f.set({ error: 'boom' })
    expect(f.badge(card())).toBe('')
  })

  it('puts the last-activity age in the tooltip only when it is known', () => {
    const f = setup()
    f.set([{ agent: 'cody', state: 'working', lastSignalAgeSec: 600 }])
    expect(f.badge(card())).toContain('kanban.agent_live.last_signal')
    f.set([{ agent: 'cody', state: 'working', lastSignalAgeSec: null }])
    expect(f.badge(card())).not.toContain('kanban.agent_live.last_signal')
  })

  it('on a card the agent is NOT on, says where it is instead of claiming work', () => {
    const f = setup()
    f.set([{ agent: 'cody', state: 'working', lastSignalAgeSec: 5, work: { kind: 'card', cardId: 'c2', text: 'x' } }])
    expect(f.level(card())?.level).toBe('idle')
    expect(f.badge(card())).toContain('kanban.agent_live.elsewhere')
    expect(f.badge(card())).toContain('#2')
    expect(f.level(card({ id: 'c2' }))?.level).toBe('ok')
    f.set([{ agent: 'cody', state: 'stopped', lastSignalAgeSec: 5, work: { kind: 'card', cardId: 'c2', text: 'x' } }])
    expect(f.level(card())?.level).toBe('bad')
  })

  it('has every label in both languages', () => {
    for (const k of ['elsewhere', 'working', 'idle', 'stalled', 'dead', 'stopped', 'unreachable', 'tooltip', 'last_signal']) {
      expect(HU).toContain(`'kanban.agent_live.${k}':`)
      expect(EN).toContain(`'kanban.agent_live.${k}':`)
    }
  })

  it('loads the status alongside the board without making the board depend on it', () => {
    const load = slice(APP_JS, 'async function loadKanban()', "document.getElementById('kanbanGroupBy').addEventListener")
    expect(load).toContain(".catch(() => [])")
    expect(load).toContain('setKanbanAgentStatus(await agentStatusP)')
  })
})
