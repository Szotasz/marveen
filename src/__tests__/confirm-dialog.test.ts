/**
 * The app's own confirmation dialog (web/app.js confirmDialog), in place of the native confirm(), and the
 * first actions moved onto it: the agent's stop and delete buttons (the main-agent restart button has its
 * own handler test, marveen-restart-button-force.test.ts).
 *
 * The SHIPPED function runs against a small fake DOM: only the explicit confirm button resolves true;
 * Cancel, the close button, Escape and the backdrop resolve false; Cancel holds the focus, so Enter on a
 * freshly opened dialog changes nothing; the dialog and its key listener are gone afterwards; texts go in
 * through textContent only.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const APP = readFileSync(new URL('../../web/app.js', import.meta.url), 'utf-8')
const HU = readFileSync(new URL('../../web/lang/hu.js', import.meta.url), 'utf-8')
const EN = readFileSync(new URL('../../web/lang/en.js', import.meta.url), 'utf-8')

const fnStart = APP.indexOf('function confirmDialog(')
const fnEnd = APP.indexOf('\n// The confirmation for a reset, per row and per tab.', fnStart)
const FN = APP.slice(fnStart, fnEnd)

interface FakeEl {
  tag: string
  className: string
  textContent: string
  type?: string
  attrs: Record<string, string>
  children: FakeEl[]
  listeners: Record<string, ((e: unknown) => void)[]>
  removed: boolean
  focused: boolean
  innerHTML?: string
  setAttribute: (k: string, v: string) => void
  append: (...c: FakeEl[]) => void
  appendChild: (c: FakeEl) => FakeEl
  addEventListener: (ev: string, fn: (e: unknown) => void) => void
  remove: () => void
  focus: () => void
}

function makeDom() {
  const docListeners: Record<string, ((e: unknown) => void)[]> = {}
  const body: FakeEl[] = []
  let focused: FakeEl | null = null
  const el = (tag: string): FakeEl => {
    const e: FakeEl = {
      tag, className: '', textContent: '', attrs: {}, children: [], listeners: {}, removed: false, focused: false,
      setAttribute: (k, v) => { e.attrs[k] = v },
      append: (...c) => { e.children.push(...c) },
      appendChild: (c) => { e.children.push(c); return c },
      addEventListener: (ev, fn) => { (e.listeners[ev] ??= []).push(fn) },
      remove: () => { e.removed = true },
      focus: () => { focused = e },
    }
    Object.defineProperty(e, 'innerHTML', { set: () => { throw new Error('innerHTML used') } })
    return e
  }
  const document = {
    createElement: el,
    addEventListener: (ev: string, fn: (e: unknown) => void) => { (docListeners[ev] ??= []).push(fn) },
    removeEventListener: (ev: string, fn: (e: unknown) => void) => { docListeners[ev] = (docListeners[ev] ?? []).filter((f) => f !== fn) },
    body: { appendChild: (c: FakeEl) => { body.push(c); return c } },
  }
  const all = (root: FakeEl): FakeEl[] => [root, ...root.children.flatMap(all)]
  return {
    document, body, docListeners,
    focused: () => focused,
    find: (pred: (e: FakeEl) => boolean) => all(body[0]).find(pred),
    fire: (target: FakeEl, ev: string, e: unknown = { target }) => { for (const fn of target.listeners[ev] ?? []) fn(e) },
    key: (k: string) => { for (const fn of docListeners.keydown ?? []) fn({ key: k }) },
  }
}

type DialogOpts = { title: string; message: string; okLabel: string; danger?: boolean; content?: unknown }
function open(opts: DialogOpts) {
  const dom = makeDom()
  const t = (k: string) => k
  const confirmDialog = new Function('document', 't', `${FN}\nreturn confirmDialog`)(dom.document, t) as (o: DialogOpts) => Promise<boolean>
  const answer = confirmDialog(opts)
  const overlay = dom.body[0]
  const byText = (txt: string) => dom.find((e) => e.tag === 'button' && e.textContent === txt)!
  return { dom, answer, overlay, ok: byText(opts.okLabel), cancel: byText('common.cancel'), close: byText('×') }
}

const OPTS = { title: 'Stop the agent', message: 'Stop <b>it</b>?', okLabel: 'Stop', danger: true }

describe('confirmDialog', () => {
  it('the function is found in web/app.js', () => {
    expect(fnStart).toBeGreaterThan(-1)
    expect(fnEnd).toBeGreaterThan(fnStart)
  })

  it('shows title, message and buttons as text, a danger button, and Cancel holds the focus', () => {
    const d = open(OPTS)
    expect(d.overlay.attrs).toEqual({ role: 'dialog', 'aria-modal': 'true' })
    expect(d.dom.find((e) => e.tag === 'h2')!.textContent).toBe('Stop the agent')
    expect(d.dom.find((e) => e.tag === 'p')!.textContent).toBe('Stop <b>it</b>?')
    expect(d.ok.className).toBe('btn-danger')
    expect(d.dom.focused()).toBe(d.cancel)
  })

  it('without danger the confirm button is the primary one', () => {
    expect(open({ ...OPTS, danger: false }).ok.className).toBe('btn-primary')
  })

  it('only the confirm button resolves true; the dialog and its key listener are gone afterwards', async () => {
    const d = open(OPTS)
    d.dom.fire(d.ok, 'click')
    await expect(d.answer).resolves.toBe(true)
    expect(d.overlay.removed).toBe(true)
    expect(d.dom.docListeners.keydown).toEqual([])
  })

  it.each([
    ['Cancel', (d: ReturnType<typeof open>) => d.dom.fire(d.cancel, 'click')],
    ['the close button', (d: ReturnType<typeof open>) => d.dom.fire(d.close, 'click')],
    ['Escape', (d: ReturnType<typeof open>) => d.dom.key('Escape')],
    ['the backdrop', (d: ReturnType<typeof open>) => d.dom.fire(d.overlay, 'click', { target: d.overlay })],
  ])('%s resolves false and closes the dialog', async (_name, act) => {
    const d = open(OPTS)
    act(d)
    await expect(d.answer).resolves.toBe(false)
    expect(d.overlay.removed).toBe(true)
    expect(d.dom.docListeners.keydown).toEqual([])
  })

  it('a click inside the dialog is not a backdrop click, and another key is not Escape', async () => {
    const d = open(OPTS)
    d.dom.fire(d.overlay, 'click', { target: d.ok })
    d.dom.key('Enter')
    expect(d.overlay.removed).toBe(false)
    d.dom.fire(d.cancel, 'click')
    await expect(d.answer).resolves.toBe(false)
  })
})

describe('the agent actions use it', () => {
  const handler = (anchor: string, endMarker: string) => {
    const i = APP.indexOf(anchor)
    return i < 0 ? '' : APP.slice(i, APP.indexOf(endMarker, i))
  }
  const STOP = handler("document.getElementById('agentStopBtn').addEventListener('click'", 'try {')
  const DELETE = handler("document.getElementById('deleteAgentBtn').onclick = async () => {", 'try {')
  const RESTART = handler("document.getElementById('marveenRestartBtn').addEventListener('click'", 'finally {')

  it.each([
    ['stop', STOP, 'agents.confirm.stop'],
    ['delete', DELETE, 'agents.confirm.delete'],
    ['main-agent restart', RESTART, 'agents.confirm.hard_restart'],
  ])('%s: a danger confirmDialog with its own title and button, no native confirm()', (_name, src, key) => {
    expect(src.length).toBeGreaterThan(50)
    expect(src).toContain('await confirmDialog({')
    expect(src).toContain(`title: t('${key}_title')`)
    expect(src).toContain(`okLabel: t('${key}_ok')`)
    expect(src).toContain('danger: true')
    expect(src).not.toMatch(/(^|[^.\w])confirm\(/)
  })

  it.each([
    'agents.confirm.hard_restart_title', 'agents.confirm.hard_restart_ok', 'agents.confirm.force_restart_ok',
    'agents.confirm.stop_title', 'agents.confirm.stop_ok', 'agents.confirm.delete_title', 'agents.confirm.delete_ok',
  ])('%s is in both languages', (key) => {
    expect(HU).toContain(`'${key}':`)
    expect(EN).toContain(`'${key}':`)
  })
})
