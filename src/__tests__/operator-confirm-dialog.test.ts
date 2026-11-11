// The IT operator's page (web/operator.js) asks in its own dialog instead of the native confirm():
// the main agent's restart, an agent's stop and the update. The page does not load app.js, so it
// has a small askConfirm of its own with the dashboard confirmDialog's markup and classes.
// The real askConfirm runs here against a fake DOM; the three call sites are checked in place.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const JS = readFileSync(new URL('../../web/operator.js', import.meta.url), 'utf-8')
const CSS = readFileSync(new URL('../../web/style.css', import.meta.url), 'utf-8')

// A function's text, from `function <name>(` to the brace that closes its body (the parameter list may
// hold a destructuring brace of its own).
function fnBlock(name: string): string {
  const m = new RegExp(`function ${name}\\(`).exec(JS)
  if (!m) return ''
  let depth = 0
  for (let j = JS.indexOf(') {', m.index) + 2; j < JS.length; j++) {
    if (JS[j] === '{') depth++
    else if (JS[j] === '}' && --depth === 0) return JS.slice(m.index, j + 1)
  }
  return ''
}
// The handler that starts at `anchor`, up to the brace that closes it.
function handlerAt(anchor: string): string {
  const i = JS.indexOf(anchor)
  if (i < 0) return ''
  const start = JS.indexOf('async () => {', i)
  let depth = 0
  for (let j = JS.indexOf('{', start); j < JS.length; j++) {
    if (JS[j] === '{') depth++
    else if (JS[j] === '}' && --depth === 0) return JS.slice(start, j + 1)
  }
  return ''
}

const ASK = fnBlock('askConfirm')
const EL = fnBlock('el')
const RESTART_MAIN = handlerAt("row.append(actionButton('Újraindítás', async () => {")
const STOP = handlerAt("row.append(actionButton('Leállítás', async () => {")
const UPDATE = handlerAt("$('op-update-apply').addEventListener('click', ")

type Node = {
  tag: string; className: string; textContent: string; type: string; children: Node[]; attrs: Record<string, string>
  listeners: Record<string, (e: unknown) => void>; removed: boolean; focused: boolean
  append(...c: Node[]): void; setAttribute(k: string, v: string): void
  addEventListener(t: string, f: (e: unknown) => void): void; remove(): void; focus(): void
}
function makeDom() {
  const docListeners: Record<string, ((e: unknown) => void) | undefined> = {}
  const mounted: Node[] = []
  const create = (tag: string): Node => ({
    tag, className: '', textContent: '', type: '', children: [], attrs: {}, listeners: {}, removed: false, focused: false,
    append(...c) { this.children.push(...c) },
    setAttribute(k, v) { this.attrs[k] = v },
    addEventListener(t, f) { this.listeners[t] = f },
    remove() { this.removed = true },
    focus() { this.focused = true },
  })
  const document = {
    createElement: create,
    addEventListener: (t: string, f: (e: unknown) => void) => { docListeners[t] = f },
    removeEventListener: (t: string, f: (e: unknown) => void) => { if (docListeners[t] === f) docListeners[t] = undefined },
    body: { append: (n: Node) => { mounted.push(n) } },
  }
  return { document, docListeners, mounted }
}
function open(opts: Record<string, unknown>) {
  const dom = makeDom()
  const ask = new Function('document', `${EL}\n${ASK}\nreturn askConfirm`)(dom.document) as (o: Record<string, unknown>) => Promise<boolean>
  const answer = ask(opts)
  const overlay = dom.mounted[0]!
  const modal = overlay.children[0]!
  const [header, body] = modal.children as [Node, Node]
  const [titleEl, closeBtn] = header.children as [Node, Node]
  const [messageEl, actions] = body.children as [Node, Node]
  const [cancelBtn, okBtn] = actions.children as [Node, Node]
  return { answer, dom, overlay, titleEl, closeBtn, messageEl, cancelBtn, okBtn }
}

describe('the operator page asks in its own dialog', () => {
  it('the helper and the three handlers were found, and no native confirm(), alert() or prompt() is left', () => {
    for (const part of [ASK, EL, RESTART_MAIN, STOP, UPDATE]) expect(part).not.toBe('')
    const code = JS.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
    expect(code).not.toMatch(/(^|[^.\w])(confirm|alert|prompt)\(/)
  })

  it('builds the dashboard dialog markup with textContent only; Cancel holds the focus', () => {
    const d = open({ title: 'Cím', message: 'Kérdés <b>x</b>', okLabel: 'Mehet' })
    expect(d.overlay.className).toBe('modal-overlay active')
    expect(d.overlay.attrs).toEqual({ role: 'dialog', 'aria-modal': 'true' })
    expect(d.titleEl).toMatchObject({ tag: 'h2', textContent: 'Cím' })
    expect(d.messageEl).toMatchObject({ tag: 'p', textContent: 'Kérdés <b>x</b>' })
    expect(d.cancelBtn).toMatchObject({ textContent: 'Mégse', className: 'btn-secondary', type: 'button', focused: true })
    expect(d.okBtn).toMatchObject({ textContent: 'Mehet', className: 'btn-primary', type: 'button', focused: false })
    expect(d.closeBtn.className).toBe('modal-close')
    expect(open({ title: 'T', message: 'M', okLabel: 'Törlés', danger: true }).okBtn.className).toBe('btn-danger')
  })

  it('only the OK button answers yes; Cancel, the close button, Escape and a click beside it answer no', async () => {
    const ok = open({ title: 'T', message: 'M', okLabel: 'O' })
    ok.okBtn.listeners.click!({})
    expect(await ok.answer).toBe(true)
    expect(ok.overlay.removed).toBe(true)
    expect(ok.dom.docListeners.keydown).toBeUndefined()

    for (const how of ['cancel', 'close', 'escape', 'beside'] as const) {
      const d = open({ title: 'T', message: 'M', okLabel: 'O' })
      if (how === 'cancel') d.cancelBtn.listeners.click!({})
      if (how === 'close') d.closeBtn.listeners.click!({})
      if (how === 'escape') { d.dom.docListeners.keydown!({ key: 'Enter' }); expect(d.overlay.removed).toBe(false); d.dom.docListeners.keydown!({ key: 'Escape' }) }
      if (how === 'beside') { d.overlay.listeners.click!({ target: d.messageEl }); expect(d.overlay.removed).toBe(false); d.overlay.listeners.click!({ target: d.overlay }) }
      expect(await d.answer, how).toBe(false)
      expect(d.overlay.removed, how).toBe(true)
      expect(d.dom.docListeners.keydown, how).toBeUndefined()
    }
  })

  it.each([
    ['the main restart', () => RESTART_MAIN, '/restart'],
    ['the stop', () => STOP, '/stop'],
    ['the update', () => UPDATE, "'/api/operator/updates/apply'"],
  ])('%s: the answer is checked before the request', (_name, part, request) => {
    const src = part()
    const ask = src.indexOf('const confirmed = await askConfirm({')
    const guard = src.indexOf('if (!confirmed) return')
    const call = src.indexOf(request)
    expect(ask).toBeGreaterThan(-1)
    expect(guard).toBeGreaterThan(ask)
    expect(call).toBeGreaterThan(guard)
  })

  it('a "no" on the update sends nothing and says nothing', async () => {
    const calls: string[] = []
    const msgs: string[] = []
    const handler = new Function('askConfirm', 'api', 'msg', `return ${UPDATE}`)(
      async () => false,
      async (_m: string, path: string) => { calls.push(path); return { ok: true, data: {} } },
      (_id: string, text: string) => { msgs.push(text) },
    ) as () => Promise<void>
    await handler()
    expect(calls).toEqual([])
    expect(msgs).toEqual([])
  })

  it('the texts say what the server does; only the stop is a danger dialog', () => {
    // The main restart is the owner route's gated hard restart; an operator cannot force it (OPERRESTART409_1018).
    expect(RESTART_MAIN).toContain('Új beszélgetéssel indul')
    expect(RESTART_MAIN).toContain('a futó kört csak a gazda szakíthatja meg')
    expect(RESTART_MAIN).not.toContain('danger')
    // A stop takes the agent off the desired run-state: a restart refuses it, only Start runs it.
    expect(STOP).toContain('az újraindítás sem hozza vissza, csak az Indítás gomb')
    expect(STOP).toContain("'Leállítod ezt az ágenst: \"' + (a.displayName || a.name) + '\"?")
    expect(STOP).toContain('danger: true')
    // update.sh restarts the dashboard and the channels and rolls back a dashboard that does not come up;
    // the operator session lives in memory (operator-sessions.ts), so it ends with the restart.
    expect(UPDATE).toContain('A dashboard és a csatornák újraindulnak, a fő ágens új beszélgetéssel indul.')
    expect(UPDATE).toContain('a frissítés visszaáll')
    expect(UPDATE).toContain('Utána újra be kell lépned')
    expect(UPDATE).not.toContain('danger')
    expect(readFileSync(new URL('../web/operator-sessions.ts', import.meta.url), 'utf-8')).toContain('Held in memory on purpose')
  })

  it('the classes it uses exist in the shared style.css', () => {
    for (const cls of ['.modal-overlay', '.modal-close', '.confirm-dialog-actions', '.btn-danger', '.btn-primary', '.btn-secondary']) {
      expect(CSS, cls).toContain(cls)
    }
  })
})
