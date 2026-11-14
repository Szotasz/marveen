// The main agent's card in the hierarchy graph (the overview's team card and the Agents page's org
// chart) opens its detail view on click, like every other card. It used to get no click handler
// (from before the main agent had a detail view), so the card looked clickable but did nothing.
// The real renderTeamGraph() runs here against a small fake DOM.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const APP = readFileSync(new URL('../../web/app.js', import.meta.url), 'utf-8')

const RENDER_SRC = (() => {
  const start = APP.indexOf('\nfunction renderTeamGraph(')
  if (start < 0) return ''
  let depth = 0
  // The body starts after the parameter list, which holds an `opts = {}` default.
  for (let j = APP.indexOf(') {', start) + 2; j < APP.length; j++) {
    if (APP[j] === '{') depth++
    else if (APP[j] === '}' && --depth === 0) return APP.slice(start + 1, j + 1)
  }
  return ''
})()

type FakeEl = {
  className: string
  innerHTML: string
  title: string
  textContent: string
  draggable: boolean
  dataset: Record<string, string>
  children: FakeEl[]
  listeners: Record<string, Array<(e: unknown) => void>>
  classList: { add(c: string): void; remove(c: string): void; toggle(c: string, on?: boolean): void; contains(c: string): boolean }
  appendChild(c: FakeEl): FakeEl
  addEventListener(type: string, fn: (e: unknown) => void): void
}

function el(): FakeEl {
  const classes = new Set<string>()
  const e: FakeEl = {
    get className() { return [...classes].join(' ') },
    set className(v: string) { classes.clear(); for (const c of v.split(/\s+/).filter(Boolean)) classes.add(c) },
    innerHTML: '', title: '', textContent: '', draggable: false, dataset: {}, children: [], listeners: {},
    classList: {
      add: (c) => { classes.add(c) },
      remove: (c) => { classes.delete(c) },
      toggle: (c, on) => { if (on ?? !classes.has(c)) classes.add(c); else classes.delete(c) },
      contains: (c) => classes.has(c),
    },
    appendChild(c) { e.children.push(c); return c },
    addEventListener(type, fn) { (e.listeners[type] ||= []).push(fn) },
  } as FakeEl
  return e
}

function render(editable: boolean) {
  const created: FakeEl[] = []
  const opened: string[] = []
  const renderTeamGraph = new Function(
    'document', 't', 'escapeHtml', 'avatarBust', 'openAgentDetail', 'saveTeamReportsTo',
    `${RENDER_SRC}\nreturn renderTeamGraph`,
  )(
    { createElement: () => { const x = el(); created.push(x); return x } },
    (k: string) => k, (s: string) => s, () => '', (id: string) => { opened.push(id) }, () => {},
  ) as (c: FakeEl, d: unknown, o?: unknown) => void
  renderTeamGraph(el(), {
    nodes: [
      { id: 'suzy', label: 'Suzy', role: 'main', running: true },
      { id: 'anna', label: 'Anna', role: 'member', running: false },
    ],
    edges: [{ from: 'suzy', to: 'anna' }],
    mainAgentId: 'suzy',
  }, { editable })
  const nodes = created.filter(x => x.classList.contains('team-node'))
  const byId = (id: string) => nodes.find(n => n.dataset.agentId === id)!
  const click = (id: string) => { for (const fn of byId(id).listeners.click || []) fn({}) }
  return { byId, click, opened }
}

describe('the main agent card in the hierarchy graph', () => {
  it('renderTeamGraph was found', () => {
    expect(RENDER_SRC).toContain('function renderTeamGraph(')
  })

  it.each([
    ['the overview card (read-only)', false],
    ['the org chart (editable)', true],
  ])('%s: a click on the main agent opens its detail, as for any other agent', (_n, editable) => {
    const g = render(editable)
    g.click('suzy')
    g.click('anna')
    expect(g.opened).toEqual(['suzy', 'anna'])
  })

  it('the main agent still cannot be dragged in the org chart', () => {
    const g = render(true)
    expect(g.byId('suzy').draggable).toBe(false)
    expect(g.byId('anna').draggable).toBe(true)
  })

  it('openAgentDetail() hands the main agent to its own detail view', () => {
    const i = APP.indexOf('async function openAgentDetail(agentName) {')
    expect(i).toBeGreaterThan(-1)
    expect(APP.slice(i, i + 200)).toMatch(/if \(agentName === mainAgentId\(\)\) \{\s*return openMarveenDetail\(\)/)
  })
})
