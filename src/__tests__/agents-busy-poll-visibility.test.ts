// The agents busy poll (/api/agents/activity every 3s) serves the Overview and
// Agents pages. It must stop while the browser tab is hidden and come back when
// the tab is shown again, but only on one of those two pages. The browser code
// has no module boundary, so the real functions are sliced out of web/app.js and
// run in a vm with a fake document and fake timers.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const APP_JS = readFileSync(join(ROOT, 'web', 'app.js'), 'utf-8')

function slice(src: string, startMarker: string, endMarker: string): string {
  const a = src.indexOf(startMarker)
  const b = src.indexOf(endMarker, a)
  if (a < 0 || b < 0) throw new Error(`marker not found: ${startMarker}`)
  return src.slice(a, b)
}

type Harness = {
  setPage: (id: string) => void
  setHidden: (hidden: boolean) => void
  fireVisibility: () => void
  running: () => boolean
  refreshes: () => number
  start: () => void
}

function setup(): Harness {
  const pages: Record<string, { hidden: boolean }> = {
    overviewPage: { hidden: false },
    agentsPage: { hidden: true },
    kanbanPage: { hidden: true },
  }
  const listeners: Record<string, Array<() => void>> = {}
  let nextTimer = 1
  const live = new Set<number>()
  let refreshCount = 0
  const document = {
    hidden: false,
    getElementById: (id: string) => pages[id] ?? null,
    addEventListener: (type: string, fn: () => void) => { (listeners[type] ||= []).push(fn) },
  }
  const ctx: Record<string, unknown> = {
    document,
    setInterval: () => { const id = nextTimer++; live.add(id); return id },
    clearInterval: (id: number) => { live.delete(id) },
    refreshAgentTerminalBusy: () => { refreshCount++ },
  }
  vm.createContext(ctx)
  vm.runInContext(
    slice(APP_JS, 'let agentsBusyTimer = null', 'async function refreshAgentTerminalBusy(') +
      'globalThis.__timer = () => agentsBusyTimer',
    ctx,
  )
  return {
    setPage: (id) => { for (const [k, p] of Object.entries(pages)) p.hidden = k !== id },
    setHidden: (hidden) => { document.hidden = hidden },
    fireVisibility: () => { for (const fn of listeners.visibilitychange || []) fn() },
    running: () => {
      const t = (ctx.__timer as () => number | null)()
      return t !== null && live.has(t)
    },
    refreshes: () => refreshCount,
    start: () => (ctx.startAgentsBusyPoll as () => void)(),
  }
}

describe('agents busy poll: stops on a hidden tab, resumes on Overview/Agents', () => {
  it('stops when the tab is hidden and restarts, with an immediate refresh, when it is shown on the Overview', () => {
    const h = setup()
    h.setPage('overviewPage')
    h.start()
    expect(h.running()).toBe(true)

    h.setHidden(true)
    h.fireVisibility()
    expect(h.running()).toBe(false)

    const before = h.refreshes()
    h.setHidden(false)
    h.fireVisibility()
    expect(h.running()).toBe(true)
    expect(h.refreshes()).toBe(before + 1)
  })

  it('restarts on the Agents page too (same timer)', () => {
    const h = setup()
    h.setPage('agentsPage')
    h.start()
    h.setHidden(true)
    h.fireVisibility()
    expect(h.running()).toBe(false)
    h.setHidden(false)
    h.fireVisibility()
    expect(h.running()).toBe(true)
  })

  it('stays stopped when the tab comes back on any other page', () => {
    const h = setup()
    h.setPage('kanbanPage')
    h.setHidden(false)
    h.fireVisibility()
    expect(h.running()).toBe(false)
    expect(h.refreshes()).toBe(0)
  })

  it('does not start the poll at load time in a background tab', () => {
    // The landing-page start is guarded by document.hidden; the
    // visibilitychange handler above starts it once the tab is shown.
    const guarded = /if \(!document\.hidden && !document\.getElementById\('overviewPage'\)\.hidden\) startAgentsBusyPoll\(\)/
    expect(guarded.test(APP_JS), 'landing-page start of the busy poll is not guarded by document.hidden').toBe(true)
  })
})
