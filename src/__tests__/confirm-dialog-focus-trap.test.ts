// The app's own confirmation dialog keeps the keyboard inside itself and hands the focus back. Before,
// Tab could walk out of an open dialog onto the page behind its backdrop (aria-modal said otherwise),
// and after the dialog closed the focus was nowhere, so a keyboard user had to start over from the
// top of the page. Now Tab goes from the dialog's last focusable element on to the first, Shift+Tab
// back, a focus outside the dialog is pulled in, and closing puts the focus back where it was.
// The SHIPPED confirmDialog runs against a small fake DOM with focus, containment and visibility.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const APP = readFileSync(new URL('../../web/app.js', import.meta.url), 'utf-8')
const fnStart = APP.indexOf('function confirmDialog(')
const FN = APP.slice(fnStart, APP.indexOf('\n// The confirmation for a reset, per row and per tab.', fnStart))

const FOCUSABLE_TAGS = new Set(['button', 'input', 'select', 'textarea'])

interface El {
  tag: string
  className: string
  textContent: string
  type?: string
  disabled: boolean
  hidden: boolean
  isConnected: boolean
  parent: El | null
  children: El[]
  attrs: Record<string, string>
  listeners: Record<string, ((e: unknown) => void)[]>
  readonly offsetParent: object | null
  setAttribute(k: string, v: string): void
  append(...c: El[]): void
  appendChild(c: El): El
  addEventListener(ev: string, fn: (e: unknown) => void): void
  remove(): void
  focus(): void
  contains(o: unknown): boolean
  querySelectorAll(sel: string): El[]
}

function makeDom() {
  const docListeners: Record<string, ((e: unknown) => void)[]> = {}
  let active: El | null = null
  const descendants = (e: El): El[] => e.children.flatMap(c => [c, ...descendants(c)])
  const el = (tag: string): El => {
    const e: El = {
      tag, className: '', textContent: '', disabled: false, hidden: false, isConnected: true, parent: null, children: [], attrs: {}, listeners: {},
      get offsetParent() { let x: El | null = e; while (x) { if (x.hidden) return null; x = x.parent } return {} },
      setAttribute(k, v) { e.attrs[k] = v },
      append(...c) { for (const x of c) e.appendChild(x) },
      appendChild(c) { c.parent = e; e.children.push(c); return c },
      addEventListener(ev, fn) { (e.listeners[ev] ??= []).push(fn) },
      remove() { e.isConnected = false; for (const d of descendants(e)) d.isConnected = false },
      focus() { active = e },
      contains(o) { return o === e || descendants(e).includes(o as El) },
      querySelectorAll() { return descendants(e).filter(d => FOCUSABLE_TAGS.has(d.tag) || ('tabindex' in d.attrs && d.attrs.tabindex !== '-1')) },
    }
    return e
  }
  const page = el('button') // the button on the page that opened the dialog
  page.textContent = 'Delete'
  active = page
  const document = {
    createElement: el,
    get activeElement() { return active },
    addEventListener: (ev: string, fn: (e: unknown) => void) => { (docListeners[ev] ??= []).push(fn) },
    removeEventListener: (ev: string, fn: (e: unknown) => void) => { docListeners[ev] = (docListeners[ev] ?? []).filter(f => f !== fn) },
    body: { appendChild: (c: El) => c },
  }
  const key = (k: string, shiftKey = false) => {
    const e = { key: k, shiftKey, prevented: false, preventDefault() { e.prevented = true } }
    for (const fn of docListeners.keydown ?? []) fn(e)
    return e.prevented
  }
  return { document, el, page, key, active: () => active, setActive: (x: El) => { active = x } }
}

function open(content?: (dom: ReturnType<typeof makeDom>) => El) {
  const dom = makeDom()
  const confirmDialog = new Function('document', 't', `${FN}\nreturn confirmDialog`)(dom.document, (k: string) => k) as (o: object) => Promise<boolean>
  let overlay: El | null = null
  const realCreate = dom.document.createElement
  dom.document.createElement = (tag: string) => { const x = realCreate(tag); if (!overlay) overlay = x; return x }
  const answer = confirmDialog({ title: 'Delete it', message: 'Sure?', okLabel: 'Delete', danger: true, content: content ? content(dom) : null })
  const buttons = overlay!.querySelectorAll('button')
  const by = (txt: string) => buttons.find(b => b.textContent === txt)!
  return { dom, answer, overlay: overlay!, close: by('×'), cancel: by('common.cancel'), ok: by('Delete') }
}

describe('confirmDialog keeps the focus inside and gives it back', () => {
  it('opens with Cancel focused', () => {
    const d = open()
    expect(d.dom.active()).toBe(d.cancel)
  })

  it('Tab on the last element goes on to the first; Shift+Tab on the first goes back to the last', () => {
    const d = open()
    d.dom.setActive(d.ok)
    expect(d.dom.key('Tab')).toBe(true)
    expect(d.dom.active()).toBe(d.close)
    expect(d.dom.key('Tab', true)).toBe(true)
    expect(d.dom.active()).toBe(d.ok)
  })

  it('Tab in the middle is left to the browser', () => {
    const d = open()
    d.dom.setActive(d.cancel)
    expect(d.dom.key('Tab')).toBe(false)
    expect(d.dom.key('Tab', true)).toBe(false)
    expect(d.dom.active()).toBe(d.cancel)
  })

  it('a focus that got outside the dialog is pulled back in', () => {
    const d = open()
    d.dom.setActive(d.dom.page)
    expect(d.dom.key('Tab')).toBe(true)
    expect(d.dom.active()).toBe(d.close)
    d.dom.setActive(d.dom.page)
    expect(d.dom.key('Tab', true)).toBe(true)
    expect(d.dom.active()).toBe(d.ok)
  })

  it('a disabled or hidden element is skipped', () => {
    const d = open()
    d.ok.disabled = true
    d.dom.setActive(d.cancel)
    expect(d.dom.key('Tab')).toBe(true)
    expect(d.dom.active()).toBe(d.close)
    d.ok.disabled = false
    d.close.hidden = true
    // With the close button hidden, Cancel is the first: Shift+Tab on it goes to the last.
    d.dom.setActive(d.cancel)
    expect(d.dom.key('Tab', true)).toBe(true)
    expect(d.dom.active()).toBe(d.ok)
  })

  it('the caller\'s own fields in the dialog are part of the loop', () => {
    let field: { focus(): void } | null = null
    const d = open((dom) => {
      const wrap = dom.el('div')
      const input = dom.el('input')
      wrap.appendChild(input)
      field = input
      return wrap
    })
    d.dom.setActive(d.ok)
    d.dom.key('Tab')
    expect(d.dom.active()).toBe(d.close)
    d.dom.setActive(field as unknown as typeof d.ok)
    expect(d.dom.key('Tab')).toBe(false)
  })

  it.each([
    ['Cancel', (d: ReturnType<typeof open>) => { for (const fn of d.cancel.listeners.click) fn({}) }, false],
    ['the confirm button', (d: ReturnType<typeof open>) => { for (const fn of d.ok.listeners.click) fn({}) }, true],
    ['Escape', (d: ReturnType<typeof open>) => { d.dom.key('Escape') }, false],
  ] as const)('%s closes it and the focus goes back to the button that opened it', async (_n, act, want) => {
    const d = open()
    act(d)
    await expect(d.answer).resolves.toBe(want)
    expect(d.dom.active()).toBe(d.dom.page)
  })

  it('if that button is gone meanwhile, the focus is not sent to a removed element', async () => {
    const d = open()
    d.dom.page.isConnected = false
    for (const fn of d.cancel.listeners.click) fn({})
    await d.answer
    expect(d.dom.active()).not.toBe(d.dom.page)
  })

  it('Enter and other keys still do nothing', () => {
    const d = open()
    expect(d.dom.key('Enter')).toBe(false)
    expect(d.dom.key('a')).toBe(false)
    expect(d.overlay.isConnected).toBe(true)
  })
})
