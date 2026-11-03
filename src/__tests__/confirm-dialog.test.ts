/**
 * The app's own confirmation dialog (web/app.js confirmDialog), in place of the native confirm(), and the
 * actions moved onto it, block by block: the agent's stop and delete buttons (the main-agent restart button
 * has its own handler test, marveen-restart-button-force.test.ts), then the channel page's remove, revoke
 * and disconnect.
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

// Review of #2246: the pins below prove that each button asks, not that the answer counts. With the
// `if (!confirmed) return` removed, "Mégse" would still send the request and every test stayed green.
// So for each call site: the answer of THIS confirmDialog is checked, and returns, before the first
// request the handler sends. (The main-agent restart button proves the same by running its handler:
// marveen-restart-button-force.test.ts, "the first confirm declined: no request at all".)
describe('a "no" stops the action: the answer is checked before the request', () => {
  const site = (anchor: string, request: string) => {
    const i = APP.indexOf(anchor)
    const j = i < 0 ? -1 : APP.indexOf(request, i)
    return i < 0 || j < 0 ? '' : APP.slice(i, j + request.length)
  }

  it.each([
    ['agent stop', "document.getElementById('agentStopBtn').addEventListener('click'", "/stop`, { method: 'POST' })"],
    ['agent delete', "document.getElementById('deleteAgentBtn').onclick = async () => {", "{ method: 'DELETE' })"],
    ['channel: remove a connected chat', 'async function removeAllowed(kind, id) {', "{ method: 'DELETE' })"],
    ['channel: revoke an invite link', 'async function revokeInviteToken(token) {', "{ method: 'DELETE' })"],
    ['channel: disconnect', "document.getElementById('chDisconnectBtn').addEventListener('click'", "{ method: 'DELETE' })"],
  ])('%s', (_name, anchor, request) => {
    const body = site(anchor, request)
    expect(body, 'handler or its request not found').not.toBe('')
    const ask = body.indexOf('const confirmed = await confirmDialog({')
    const guard = body.indexOf('if (!confirmed) return')
    expect(ask).toBeGreaterThan(-1)
    expect(guard).toBeGreaterThan(ask)
    expect(body.slice(0, guard)).not.toMatch(/\bfetch\(/)
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

  const REMOVE = handler('async function removeAllowed(kind, id) {', 'try {')
  const REVOKE = handler('async function revokeInviteToken(token) {', 'try {')
  const DISCONNECT = handler("document.getElementById('chDisconnectBtn').addEventListener('click'", 'catch {')

  it.each([
    ['channel: remove an allowed user or group', REMOVE, 'channel.confirm.remove'],
    ['channel: revoke an invite link', REVOKE, 'channel.confirm.revoke'],
    ['channel: disconnect the provider', DISCONNECT, 'channel.confirm.disconnect'],
  ])('%s: a danger confirmDialog with its own title and button, no native confirm()', (_name, src, key) => {
    expect(src.length).toBeGreaterThan(50)
    expect(src).toContain('await confirmDialog({')
    expect(src).toContain(`title: t('${key}_title')`)
    expect(src).toContain(`okLabel: t('${key}_ok')`)
    expect(src).toContain('danger: true')
    expect(src).not.toMatch(/(^|[^.\w])confirm\(/)
  })

  it('disconnect: the question and the toast are translated, not a hard-coded unaccented string', () => {
    expect(DISCONNECT).toContain("message: t('channel.confirm.disconnect', { provider: provLabel })")
    expect(DISCONNECT).toContain("showToast(t('channel.toast.disconnected', { provider: provLabel }))")
    expect(DISCONNECT).not.toMatch(/levalaszt/i)
  })

  it.each([
    'channel.confirm.remove_title', 'channel.confirm.remove_ok', 'channel.confirm.revoke_title', 'channel.confirm.revoke_ok',
    'channel.confirm.disconnect_title', 'channel.confirm.disconnect', 'channel.confirm.disconnect_ok', 'channel.toast.disconnected',
    'agents.confirm.hard_restart_title', 'agents.confirm.hard_restart_ok', 'agents.confirm.force_restart_ok',
    'agents.confirm.stop_title', 'agents.confirm.stop_ok', 'agents.confirm.delete_title', 'agents.confirm.delete_ok',
  ])('%s is in both languages', (key) => {
    expect(HU).toContain(`'${key}':`)
    expect(EN).toContain(`'${key}':`)
  })
})

// Third block: the kanban card and subtask delete, and the shared unsaved-input guard on every modal's
// backdrop (attachOverlayCloseGuard).
describe('the kanban deletes use it', () => {
  const handler = (anchor: string, endMarker: string) => {
    const i = APP.indexOf(anchor)
    return i < 0 ? '' : APP.slice(i, APP.indexOf(endMarker, i))
  }
  const CARD_DELETE = handler("document.getElementById('cardDeleteBtn').onclick = async () => {", 'try {')
  const SUBTASK_DELETE = handler('delBtn.onclick = async (e) => {', 'try {')

  it.each([
    ['delete a card', CARD_DELETE, 'kanban.confirm.delete'],
    ['delete a subtask', SUBTASK_DELETE, 'kanban.confirm.delete_subtask'],
  ])('%s: a danger confirmDialog with its own title and button, no native confirm()', (_name, src, key) => {
    expect(src.length).toBeGreaterThan(50)
    expect(src).toContain('await confirmDialog({')
    expect(src).toContain(`title: t('${key}_title')`)
    expect(src).toContain(`okLabel: t('${key}_ok')`)
    expect(src).toContain('danger: true')
    expect(src).not.toMatch(/(^|[^.\w])confirm\(/)
  })

  // Review of #2247: the pins above prove that each button asks, not that the answer counts. With the
  // `if (!confirmed) return` removed on the card delete, "Mégse" would still delete the card and every
  // test stayed green. So: the answer of THIS confirmDialog is checked, and returns, before the DELETE.
  it.each([
    ['delete a card', "document.getElementById('cardDeleteBtn').onclick = async () => {", "{ method: 'DELETE' })"],
    ['delete a subtask', 'delBtn.onclick = async (e) => {', "{ method: 'DELETE' })"],
  ])('%s: a "no" stops it -- the answer is checked before the request', (_name, anchor, request) => {
    const i = APP.indexOf(anchor)
    const j = i < 0 ? -1 : APP.indexOf(request, i)
    const body = i < 0 || j < 0 ? '' : APP.slice(i, j + request.length)
    expect(body, 'handler or its request not found').not.toBe('')
    const ask = body.indexOf('const confirmed = await confirmDialog({')
    const guard = body.indexOf('if (!confirmed) return')
    expect(ask).toBeGreaterThan(-1)
    expect(guard).toBeGreaterThan(ask)
    expect(body.slice(0, guard)).not.toMatch(/\bfetch\(/)
  })

  it.each([
    'kanban.confirm.delete_title', 'kanban.confirm.delete_ok', 'kanban.confirm.delete_subtask_title', 'kanban.confirm.delete_subtask_ok',
    'common.confirm.unsaved_title', 'common.confirm.unsaved', 'common.confirm.unsaved_ok',
  ])('%s is in both languages', (key) => {
    expect(HU).toContain(`'${key}':`)
    expect(EN).toContain(`'${key}':`)
  })
})

// Fifth block: the skill approval queue (Skills page, a generated skill waiting for approval). Rejecting
// deletes its files, so it is a danger dialog; installing it is not.
describe('the skill approval queue uses it', () => {
  const SITES = [
    ['install a pending skill', "approve.addEventListener('click', async () => {", 'skills.pending.confirm_approve', false],
    ['reject a pending skill', "reject.addEventListener('click', async () => {", 'skills.pending.confirm_reject', true],
  ] as const

  it.each(SITES)('%s: a confirmDialog with its own title and button, no native confirm()', (_name, anchor, key, danger) => {
    const i = APP.indexOf(anchor)
    const src = i < 0 ? '' : APP.slice(i, APP.indexOf('try {', i))
    expect(src.length).toBeGreaterThan(50)
    expect(src).toContain('await confirmDialog({')
    expect(src).toContain(`title: t('${key}_title')`)
    expect(src).toContain(`message: t('${key}'`)
    expect(src).toContain(`okLabel: t('${key}_ok')`)
    if (danger) expect(src).toContain('danger: true')
    else expect(src).not.toContain('danger:')
    expect(src).not.toMatch(/(^|[^.\w])confirm\(/)
  })

  it.each(SITES)('%s: a "no" stops it -- the answer is checked before the request', (_name, anchor) => {
    const request = 'fetch(`/api/skills/pending/'
    const i = APP.indexOf(anchor)
    const j = i < 0 ? -1 : APP.indexOf(request, i)
    const body = i < 0 || j < 0 ? '' : APP.slice(i, j + request.length)
    expect(body, 'handler or its request not found').not.toBe('')
    const ask = body.indexOf('const confirmed = await confirmDialog({')
    const guard = body.indexOf('if (!confirmed) return')
    expect(ask).toBeGreaterThan(-1)
    expect(guard).toBeGreaterThan(ask)
    expect(body.slice(0, guard)).not.toMatch(/\bfetch\(/)
  })

  it.each(SITES.flatMap(([, , key]) => [key, `${key}_title`, `${key}_ok`]))('%s is in both languages', (key) => {
    expect(HU).toContain(`'${key}':`)
    expect(EN).toContain(`'${key}':`)
  })
})

// The SHIPPED guard and overlayHasUnsavedInput, against a fake overlay, with confirmDialog injected.
describe('the unsaved-input guard on a modal backdrop', () => {
  const gStart = APP.indexOf('function overlayHasUnsavedInput(')
  const gEnd = APP.indexOf('\n}\n', APP.indexOf('function attachOverlayCloseGuard(')) + 3
  const GUARD = APP.slice(gStart, gEnd)

  async function backdropClick(fieldValue: string, answer: boolean, target: 'overlay' | 'inside' = 'overlay') {
    let listener: ((e: { target: unknown }) => Promise<void>) | null = null
    const field = { offsetParent: {}, value: fieldValue }
    const overlay = {
      querySelectorAll: () => [field],
      addEventListener: (_ev: string, fn: (e: { target: unknown }) => Promise<void>) => { listener = fn },
    }
    const asked: { title: string; okLabel: string; danger?: boolean }[] = []
    const closed: unknown[] = []
    const confirmDialog = async (o: { title: string; okLabel: string; danger?: boolean }) => { asked.push(o); return answer }
    const confirm = () => { throw new Error('native confirm() called') }
    const attach = new Function('confirmDialog', 'confirm', 'closeModal', 't', `${GUARD}\nreturn attachOverlayCloseGuard`)(
      confirmDialog, confirm, (o: unknown) => { closed.push(o) }, (k: string) => k,
    ) as (o: unknown) => void
    attach(overlay)
    await listener!({ target: target === 'overlay' ? overlay : {} })
    return { asked, closed: closed.length }
  }

  it('the guard is found in web/app.js', () => {
    expect(gStart).toBeGreaterThan(-1)
    expect(GUARD).toContain('function attachOverlayCloseGuard(')
  })

  it('an empty form closes on a backdrop click, without a dialog', async () => {
    expect(await backdropClick('', false)).toEqual({ asked: [], closed: 1 })
    expect(await backdropClick('   ', false)).toEqual({ asked: [], closed: 1 })
  })

  it('typed text asks first, with a danger button; "no" keeps the modal open', async () => {
    const r = await backdropClick('half a page of notes', false)
    expect(r.asked).toEqual([expect.objectContaining({ title: 'common.confirm.unsaved_title', okLabel: 'common.confirm.unsaved_ok', danger: true })])
    expect(r.closed).toBe(0)
  })

  it('typed text and "yes" closes the modal', async () => {
    expect((await backdropClick('half a page of notes', true)).closed).toBe(1)
  })

  it('a click inside the modal is not a backdrop click', async () => {
    expect(await backdropClick('half a page of notes', true, 'inside')).toEqual({ asked: [], closed: 0 })
  })
})

describe('kanban: the Hungarian texts say "részfeladat", not "subtask" or "alfeladat"', () => {
  it.each(['kanban.modal.subtasks_title', 'kanban.breakdown.created_count', 'kanban.breakdown.accept_btn'])('%s', (key) => {
    const line = HU.split('\n').find((l) => l.includes(`'${key}':`)) ?? ''
    expect(line).toMatch(/észfeladat/)
    expect(line.slice(line.indexOf(':'))).not.toMatch(/subtask/i)
  })

  it('no Hungarian UI text says "alfeladat" any more', () => {
    expect(HU).not.toMatch(/alfeladat/i)
  })

  // Review of #2248: the README said "alfeladat-beágyazás" too; the docs a reader opens first follow the
  // same word as the board.
  it.each(['README.md', 'docs/kanban.md', 'docs/ideabox.md'])('%s does not say "alfeladat" either', (file) => {
    expect(readFileSync(new URL(`../../${file}`, import.meta.url), 'utf-8')).not.toMatch(/alfeladat/i)
  })
})

// Fourth block: the skill, schedule and memory deletes. The memory question was hard-coded, unaccented
// Hungarian with no English; it is a lang key now.
describe('the skill, schedule and memory deletes use it', () => {
  const SITES = [
    ['delete a skill', "const delBtn = item.querySelector('.btn-icon-danger')", 'skills.confirm.delete'],
    ['delete a schedule', `row.querySelector('[data-action="delete"]').addEventListener('click'`, 'tasks.confirm.task_delete'],
    ['delete a memory', "const delBtn = item.querySelector('.btn-danger')", 'memories.confirm.delete'],
  ] as const

  it.each(SITES)('%s: a danger confirmDialog with its own title and button, no native confirm()', (_name, anchor, key) => {
    const i = APP.indexOf(anchor)
    const src = i < 0 ? '' : APP.slice(i, APP.indexOf('try {', i))
    expect(src.length).toBeGreaterThan(50)
    expect(src).toContain('await confirmDialog({')
    expect(src).toContain(`title: t('${key}_title')`)
    expect(src).toContain(`message: t('${key}'`)
    expect(src).toContain(`okLabel: t('${key}_ok')`)
    expect(src).toContain('danger: true')
    expect(src).not.toMatch(/(^|[^.\w])confirm\(/)
  })

  it.each(SITES)('%s: a "no" stops it -- the answer is checked before the request', (_name, anchor) => {
    const request = "{ method: 'DELETE' })"
    const i = APP.indexOf(anchor)
    const j = i < 0 ? -1 : APP.indexOf(request, i)
    const body = i < 0 || j < 0 ? '' : APP.slice(i, j + request.length)
    expect(body, 'handler or its request not found').not.toBe('')
    const ask = body.indexOf('const confirmed = await confirmDialog({')
    const guard = body.indexOf('if (!confirmed) return')
    expect(ask).toBeGreaterThan(-1)
    expect(guard).toBeGreaterThan(ask)
    expect(body.slice(0, guard)).not.toMatch(/\bfetch\(/)
  })

  it('the memory question is no longer hard-coded', () => {
    expect(APP).not.toContain('Biztosan torlod ezt az emleket')
  })

  it.each(SITES.flatMap(([, , key]) => [key, `${key}_title`, `${key}_ok`]))('%s is in both languages', (key) => {
    expect(HU).toContain(`'${key}':`)
    expect(EN).toContain(`'${key}':`)
  })
})

describe('the connector removes and deletes use it', () => {
  const SITES = [
    ['uninstall from the MCP catalog', 'async function catalogUninstall(item) {', 'connectors.confirm.remove', '/uninstall`, { method: \'DELETE\' })'],
    ['delete a GitHub repo', "item.querySelector('.github-repo-delete').addEventListener('click'", 'connectors.confirm.repo_delete', "{ method: 'DELETE' })"],
    ['delete a connector', "document.getElementById('connectorDeleteBtn').onclick", 'connectors.confirm.delete', "{ method: 'DELETE' })"],
  ] as const

  const handler = (anchor: string, request: string) => {
    const i = APP.indexOf(anchor)
    const j = i < 0 ? -1 : APP.indexOf(request, i)
    return i < 0 || j < 0 ? '' : APP.slice(i, j + request.length)
  }

  it.each(SITES)('%s: a danger confirmDialog with its own title and button, no native confirm()', (_name, anchor, key, request) => {
    const src = handler(anchor, request)
    expect(src, 'handler or its request not found').not.toBe('')
    expect(src).toContain('await confirmDialog({')
    expect(src).toContain(`title: t('${key}_title')`)
    expect(src).toContain(`message: t('${key}'`)
    expect(src).toContain(`okLabel: t('${key}_ok')`)
    expect(src).toContain('danger: true')
    expect(src).not.toMatch(/(^|[^.\w])confirm\(/)
  })

  it.each(SITES)('%s: a "no" stops it -- the answer is checked before the request', (_name, anchor, _key, request) => {
    const body = handler(anchor, request)
    expect(body, 'handler or its request not found').not.toBe('')
    const ask = body.indexOf('const confirmed = await confirmDialog({')
    const guard = body.indexOf('if (!confirmed) return')
    expect(ask).toBeGreaterThan(-1)
    expect(guard).toBeGreaterThan(ask)
    expect(body.slice(0, guard)).not.toMatch(/\bfetch\(/)
  })

  it('the two hard-coded, unaccented questions are gone', () => {
    expect(APP).not.toContain('`Torlod: ${r.name')
    expect(APP).not.toContain('Biztosan torlod: ${connector.name}')
  })

  it('the GitHub repo install questions have their titles and buttons in both languages', () => {
    for (const key of ['install_confirm_title', 'install_confirm_ok', 'scripts_skipped_confirm_title', 'scripts_skipped_confirm_ok', 'github_repos']) {
      expect(HU).toContain(`'connectors.${key}':`)
      expect(EN).toContain(`'connectors.${key}':`)
    }
  })

  it('a multi-paragraph question keeps its line breaks', () => {
    const CSS = readFileSync(new URL('../../web/style.css', import.meta.url), 'utf-8')
    const rule = CSS.slice(CSS.indexOf('.confirm-dialog p {'), CSS.indexOf('}', CSS.indexOf('.confirm-dialog p {')))
    expect(rule).toContain('white-space: pre-line')
  })

  it('the GitHub repo section has no unaccented labels left', () => {
    const HTML = readFileSync(new URL('../../web/index.html', import.meta.url), 'utf-8')
    for (const src of [APP, HTML]) {
      expect(src).not.toContain('Telepites')
      expect(src).not.toContain('GitHub repok')
      expect(src).not.toContain('title="Frissites"')
    }
  })

  it.each(SITES.flatMap(([, , key]) => [key, `${key}_title`, `${key}_ok`]))('%s is in both languages', (key) => {
    expect(HU).toContain(`'${key}':`)
    expect(EN).toContain(`'${key}':`)
  })
})
