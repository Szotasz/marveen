// The board's assignee filter listed the owner, the bot and the agents only, so a
// colleague from store/board-access.json could not be selected, and one person
// written two ways ("Kovács Éva" / "kovacs-eva") showed up as two names.
// withBoardColleagues() adds the colleagues with their aliases; web/app.js folds
// separators in assigneeKey() and matches the aliases of the selected entry.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { withBoardColleagues, assigneeMatchKey } from '../web/routes/kanban.js'
import { normaliseBoardAccess } from '../web/board-access.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(__dirname, '../../web/app.js'), 'utf-8')

function loadFn(name: string, deps = ''): (...a: any[]) => any {
  const m = APP.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`))
  if (!m) throw new Error(`${name}() not found in web/app.js`)
  return new Function('kanbanAssignees', 'kanbanAssigneeFilter', `${deps}; ${m[0]}; return ${name}`) as any
}

const cfg = normaliseBoardAccess({
  enabled: true,
  people: {
    'kovacs-eva': { name: 'Kovács Éva', assignees: ['Kovács Éva', 'kovacs-eva'], role: 'all' },
    'szabo-toth-anna': { name: 'Szabó-Tóth Anna', assignees: ['Szabó-Tóth Anna', 'Tóth Anna', 'szabo-toth-anna'] },
    'fekete-reka': { name: 'Fekete Réka', assignees: ['Fekete Réka', 'reka'] },
  },
  agents: {},
})

const base = [
  { name: 'Kovács Éva', type: 'owner' },
  { name: 'Marveen', type: 'bot' },
  { name: 'reka', type: 'agent', displayName: 'Segéd' },
]

describe('withBoardColleagues', () => {
  it('adds each colleague once, typed colleague, with the other names as aliases', () => {
    const out = withBoardColleagues(base, cfg)
    const anna = out.find((e) => e.name === 'Szabó-Tóth Anna')
    expect(anna?.type).toBe('colleague')
    expect(anna?.aliases).toEqual(['Tóth Anna'])
    expect(out.filter((e) => e.name === 'Szabó-Tóth Anna')).toHaveLength(1)
  })

  it('merges a person who is already listed (the owner) instead of a second entry', () => {
    const out = withBoardColleagues(base, cfg)
    expect(out.filter((e) => assigneeMatchKey(e.name) === 'kovacs-eva')).toHaveLength(1)
    expect(out[0].type).toBe('owner')
  })

  it('an alias that is also an agent id does not swallow the agent entry', () => {
    const out = withBoardColleagues(base, cfg)
    const agent = out.find((e) => e.name === 'reka')
    expect(agent?.type).toBe('agent')
    expect(agent?.aliases).toBeUndefined()
    expect(out.find((e) => e.name === 'Fekete Réka')?.aliases).toEqual(['reka'])
  })

  it('a person whose id equals an agent id gets an entry of their own, the agent stays clean', () => {
    const clash = normaliseBoardAccess({
      enabled: true,
      people: { reka: { name: 'Kiss Réka', assignees: ['Kiss Réka', 'reka'] } },
      agents: {},
    })
    const out = withBoardColleagues(base, clash)
    const agent = out.find((e) => e.name === 'reka')
    expect(agent?.type).toBe('agent')
    expect(agent?.aliases).toBeUndefined()
    const person = out.find((e) => e.name === 'Kiss Réka')
    expect(person?.type).toBe('colleague')
    expect(person?.aliases).toEqual(['reka'])
  })

  it('a person whose NAME folds to an agent id is named after another spelling, not listed twice', () => {
    const clash = normaliseBoardAccess({
      enabled: true,
      people: { reka: { assignees: ['reka', 'Réka K.'] } },
      agents: {},
    })
    const out = withBoardColleagues(base, clash)
    expect(out.filter((e) => assigneeMatchKey(e.name) === 'reka')).toHaveLength(1)
    expect(out.find((e) => e.name === 'reka')?.type).toBe('agent')
    expect(out.find((e) => e.name === 'reka')?.aliases).toBeUndefined()
    const person = out.find((e) => e.name === 'Réka K.')
    expect(person?.type).toBe('colleague')
    expect(person?.aliases).toEqual(['reka'])
  })

  it('a person with no spelling of their own beside an agent of that id is left out', () => {
    const bare = normaliseBoardAccess({ enabled: true, people: { reka: {} }, agents: {} })
    const out = withBoardColleagues(base, bare)
    expect(out.filter((e) => assigneeMatchKey(e.name) === 'reka')).toHaveLength(1)
    expect(out).toEqual(base)
  })

  it('a person named like the bot merges into the bot entry', () => {
    const botLike = normaliseBoardAccess({
      enabled: true,
      people: { marveen: { name: 'Marveen', assignees: ['Marveen', 'Marveen bot'] } },
      agents: {},
    })
    const out = withBoardColleagues(base, botLike)
    expect(out.filter((e) => assigneeMatchKey(e.name) === 'marveen')).toHaveLength(1)
    const bot = out.find((e) => e.name === 'Marveen')
    expect(bot?.type).toBe('bot')
    expect(bot?.aliases).toEqual(['Marveen bot'])
  })

  it('a second colleague of the same name merges into the earlier colleague', () => {
    const twice = normaliseBoardAccess({
      enabled: true,
      people: {
        'nagy-anna': { name: 'Nagy Anna', assignees: ['Nagy Anna', 'nagy-anna'] },
        'anna-n': { name: 'Nagy Anna', assignees: ['Nagy Anna', 'Anna N.'] },
      },
      agents: {},
    })
    const out = withBoardColleagues(base, twice)
    const annas = out.filter((e) => assigneeMatchKey(e.name) === 'nagy-anna')
    expect(annas).toHaveLength(1)
    expect(annas[0].type).toBe('colleague')
    expect(annas[0].aliases).toEqual(['Anna N.'])
  })

  it('leaves the list untouched when board access is off or broken', () => {
    const off = normaliseBoardAccess({ enabled: false, people: { a: { name: 'A' } } })
    expect(withBoardColleagues(base, off)).toEqual(base)
    expect(withBoardColleagues(base, normaliseBoardAccess('x'))).toEqual(base)
  })

  it('does not mutate the input entries', () => {
    const copy = JSON.parse(JSON.stringify(base))
    withBoardColleagues(base, cfg)
    expect(base).toEqual(copy)
  })
})

describe('web/app.js assignee matching', () => {
  const key = loadFn('assigneeKey')()

  it('folds the display name and the slug of one person to one key', () => {
    expect(key('Kovács Éva')).toBe(key('kovacs-eva'))
    expect(key('Szabó-Tóth  Anna')).toBe(key('szabo_toth_anna'))
  })

  it('the server and the board fold names the same way', () => {
    for (const n of ['Kovács Éva', 'kovacs-eva', 'Szabó-Tóth Anna', ' reka ', 'Balázs']) {
      expect(assigneeMatchKey(n)).toBe(key(n))
    }
  })

  it('a selected colleague matches its aliases, not only its name', () => {
    const src = APP.match(/function assigneeKey\(name\) \{[\s\S]*?\n\}/)![0]
    const entries = [{ name: 'Szabó-Tóth Anna', type: 'colleague', aliases: ['Tóth Anna'] }]
    const keysFn = loadFn('kanbanAssigneeFilterKeys', src)(entries, 'Szabó-Tóth Anna')
    const keys: Set<string> = keysFn(key('Szabó-Tóth Anna'))
    expect(keys.has(key('szabo-toth-anna'))).toBe(true)
    expect(keys.has(key('Tóth Anna'))).toBe(true)
    expect(keys.has(key('Kispál Tibor'))).toBe(false)
  })
})
