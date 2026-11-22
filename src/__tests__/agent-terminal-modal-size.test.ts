// The agent terminal modal tells the server its xterm size, so the agent's tmux window (and with it the mirrored
// capture-pane) matches the modal instead of the 80x24 tmux default. The real openTerminalModal runs here, cut out of
// web/app.js, with the browser parts (xterm, FitAddon, EventSource, ResizeObserver, fetch, DOM) passed in as fakes.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const APP = readFileSync(new URL('../../web/app.js', import.meta.url), 'utf-8')

function block(start: string): string {
  const i = APP.indexOf(start)
  if (i < 0) return ''
  let depth = 0
  for (let j = APP.indexOf('{', i); j < APP.length; j++) {
    if (APP[j] === '{') depth++
    else if (APP[j] === '}' && --depth === 0) return APP.slice(i, j + 1)
  }
  return ''
}

const OPEN = block('function openTerminalModal(')

type Fetch = { url: string; init?: { method?: string; body?: string } }

function setup() {
  const fetches: Fetch[] = []
  const timers: Array<() => void> = []
  const observers: Array<() => void> = []
  let resizeHandler: ((s: { cols: number; rows: number }) => void) | null = null
  class FakeTerminal {
    cols = 80
    rows = 24
    buffer = { active: { viewportY: 0, baseY: 0 } }
    loadAddon(a: { term?: FakeTerminal }) { a.term = this }
    open() {}
    focus() {}
    write() {}
    dispose() {}
    scrollPages() {}
    onScroll() {}
    onData() {}
    onResize(fn: (s: { cols: number; rows: number }) => void) { resizeHandler = fn; return { dispose() {} } }
    resize(cols: number, rows: number) {
      if (cols === this.cols && rows === this.rows) return
      this.cols = cols; this.rows = rows
      resizeHandler?.({ cols, rows })
    }
  }
  // fit() sizes the terminal to whatever `fitTo` says the container holds (0x0 while the modal is hidden is not
  // modelled: FitAddon then keeps the old size, which is what the 80x24 default stands for).
  const fitTo = { cols: 80, rows: 24 }
  class FakeFit { term?: FakeTerminal; fit() { this.term?.resize(fitTo.cols, fitTo.rows) } }
  const el = (extra: Record<string, unknown> = {}) => ({ textContent: '', innerHTML: '', style: {}, closest: () => ({}), parentElement: {}, ...extra })
  // The overlay's `active` class is what openModal()/closeModal() toggle (Escape and click-outside use closeModal).
  const classes = new Set<string>()
  const overlay = el({ classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c), contains: (c: string) => classes.has(c) } })
  const elements: Record<string, unknown> = { terminalOverlay: overlay, terminalContainer: el(), terminalModalTitle: el() }
  const win = { Terminal: FakeTerminal, FitAddon: { FitAddon: FakeFit } }
  const doc = { getElementById: (id: string) => elements[id] ?? null }
  const fetchFn = (url: string, init?: Fetch['init']) => {
    fetches.push({ url, init })
    return Promise.resolve({ ok: true, json: async () => ({ enabled: false }) })
  }
  class FakeEventSource { onmessage: unknown = null; onerror: unknown = null; close() {} }
  class FakeResizeObserver { constructor(cb: () => void) { observers.push(cb) } observe() {} }
  const setT = (fn: () => void) => { timers.push(fn); return timers.length }
  const run = new Function(
    'window', 'document', 'fetch', 'EventSource', 'ResizeObserver', 'setTimeout', 'clearTimeout', 'localStorage',
    'openModal', 't', 'showToast', 'readActionReply', 'refusalReason', 'syncTerminalInputToggleUI',
    `let terminalInstance = null, terminalSSE = null, terminalFit = null, terminalInputEnabled = false, terminalKeysRefusalToastAt = 0
${OPEN}
return openTerminalModal`,
  )(
    win, doc, fetchFn, FakeEventSource, FakeResizeObserver, setT, () => {}, { getItem: () => '' },
    () => { classes.add('active') }, (k: string) => k, () => {}, async () => ({}), () => '', () => {},
  ) as (name: string) => void
  const closeModal = () => { classes.delete('active') }
  const flush = () => { while (timers.length) timers.shift()!() }
  const sizePosts = () => fetches
    .filter((f) => f.url.endsWith('/pane/size'))
    .map((f) => ({ url: f.url, method: f.init?.method, body: JSON.parse(f.init?.body ?? 'null') }))
  return { run, flush, fitTo, observers, sizePosts, closeModal }
}

describe('the agent terminal modal reports its size to the server', () => {
  it('openTerminalModal was found in app.js', () => {
    expect(OPEN).not.toBe('')
  })

  it('posts the fitted xterm size when the modal opens', () => {
    const s = setup()
    s.fitTo.cols = 180; s.fitTo.rows = 48
    s.run('alpha beta')
    s.flush()
    const posts = s.sizePosts()
    expect(posts.length).toBeGreaterThanOrEqual(1)
    expect(posts[posts.length - 1]).toEqual({ url: '/api/agents/alpha%20beta/pane/size', method: 'POST', body: { cols: 180, rows: 48 } })
  })

  it('posts the new size when the modal is resized', () => {
    const s = setup()
    s.fitTo.cols = 180; s.fitTo.rows = 48
    s.run('alpha')
    s.flush()
    const before = s.sizePosts().length
    s.fitTo.cols = 220; s.fitTo.rows = 60
    for (const cb of s.observers) cb()
    s.flush()
    const posts = s.sizePosts()
    expect(posts.length).toBeGreaterThan(before)
    expect(posts[posts.length - 1].body).toEqual({ cols: 220, rows: 60 })
  })

  it('a modal closed with Escape (closeModal) before the report fires posts nothing', () => {
    const s = setup()
    s.fitTo.cols = 180; s.fitTo.rows = 48
    s.run('alpha')
    s.closeModal()
    s.flush()
    expect(s.sizePosts()).toEqual([])
    // and a resize seen after the close does not post either
    s.fitTo.cols = 220; s.fitTo.rows = 60
    for (const cb of s.observers) cb()
    s.flush()
    expect(s.sizePosts()).toEqual([])
  })
})
