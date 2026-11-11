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

describe('the Claude plan delete uses it', () => {
  const between = (from: string, to: string) => {
    const i = APP.indexOf(from)
    const j = i < 0 ? -1 : APP.indexOf(to, i)
    return i < 0 || j < 0 ? '' : APP.slice(i, j)
  }
  const DEL = between('async function deleteClaudePlan(', '\n}\n')
  const USERS = between('async function claudePlanUsers(', '\n}\n')

  it('the handler was found', () => {
    expect(DEL).not.toBe('')
    expect(USERS).not.toBe('')
  })

  // The real deleteClaudePlan and claudePlanUsers, with the dialog captured and the Hungarian texts filled in.
  function load(agentList: unknown, answer = false) {
    const asked: string[] = []
    const calls: Array<{ url: string; method: string }> = []
    const tr = (key: string, vars: Record<string, string> = {}) => {
      const line = HU.split('\n').find(l => l.includes(`'${key}':`)) ?? ''
      const text = line.slice(line.indexOf(':') + 1).trim().replace(/^'|',?$/g, '')
      return text.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '')
    }
    const fetchStub = async (url: string, init: { method?: string } = {}) => {
      calls.push({ url, method: init.method || 'GET' })
      if (url === '/api/agents') {
        if (agentList instanceof Error) throw agentList
        return { ok: true, json: async () => agentList }
      }
      return { ok: true, json: async () => ({ ok: true }) }
    }
    const run = new Function('confirmDialog', 't', 'fetch', 'showToast', 'loadClaudePlansList',
      `${USERS}\n}\n${DEL}\n}\nreturn deleteClaudePlan`)(
      async (o: { message: string }) => { asked.push(o.message); return answer },
      tr, fetchStub, () => {}, async () => {},
    ) as (plan: Record<string, unknown>, rotationUsers?: string[]) => Promise<void>
    return { run, asked, calls }
  }

  it('the Vault sentence only for a token-mode plan: a configDir plan has no token there', async () => {
    const h = load([])
    await h.run({ id: 'p1', label: 'Mappás', configDir: '/home/x/.claude-p1' })
    await h.run({ id: 'p2', label: 'Tokenes', tokenSecretId: 'claude-plan-token-p2' })
    expect(h.asked[0]).toContain('"Mappás"?')
    expect(h.asked[0]).not.toContain('Vault')
    expect(h.asked[1]).toContain('"Tokenes"? A tokenje a Vaultból is törlődik.')
  })

  it('the agents set to the plan in the agent editor are named too, next to the rotation record, once each', async () => {
    const h = load([
      { name: 'kutato', claudePlan: 'p1' },
      { name: 'irnok', claudePlan: 'p1' },
      { name: 'masik', claudePlan: 'p9' },
      { name: 'semmi', claudePlan: null },
    ])
    await h.run({ id: 'p1', label: 'Mappás', configDir: '/x' }, ['fo', 'irnok'])
    expect(h.asked[0]).toContain('\n\nEzek az ügynökök erre a planre vannak állítva: "fo", "irnok", "kutato".')
    expect(h.asked[0]).not.toMatch(/masik|semmi/)
  })

  it('no agent on the plan: no second paragraph; an unreadable agent list still names the rotation record', async () => {
    const none = load([{ name: 'masik', claudePlan: 'p9' }])
    await none.run({ id: 'p1', label: 'Mappás', configDir: '/x' })
    expect(none.asked[0]).not.toContain('\n\n')
    const broken = load(new Error('network'))
    await broken.run({ id: 'p1', label: 'Mappás', configDir: '/x' }, ['fo'])
    expect(broken.asked[0]).toContain('"fo"')
  })

  it('a "no" sends no DELETE, a "yes" sends it after the question', async () => {
    const no = load([])
    await no.run({ id: 'p1', label: 'Mappás', configDir: '/x' })
    expect(no.calls.filter(c => c.method === 'DELETE')).toEqual([])
    const yes = load([], true)
    await yes.run({ id: 'p1', label: 'Mappás', configDir: '/x' })
    expect(yes.calls.filter(c => c.method === 'DELETE')).toEqual([{ url: '/api/claude-plans/p1', method: 'DELETE' }])
  })

  it('a danger confirmDialog with its own title and button, naming the plan by its label, no native confirm()', () => {
    expect(DEL).toContain('const confirmed = await confirmDialog({')
    expect(DEL).toContain("title: t('settings.claude_plans.confirm_delete_title')")
    expect(DEL).toContain("t('settings.claude_plans.confirm_delete', { label: plan.label || id })")
    expect(DEL).toContain("okLabel: t('settings.claude_plans.confirm_delete_ok')")
    expect(DEL).toContain('danger: true')
    expect(DEL).not.toMatch(/(^|[^.\w])(confirm|alert)\(/)
  })

  it('a "no" stops it, before the request', () => {
    const ask = DEL.indexOf('const confirmed = await confirmDialog({')
    const guard = DEL.indexOf('if (!confirmed) return')
    expect(ask).toBeGreaterThan(-1)
    expect(guard).toBeGreaterThan(ask)
    expect(DEL.slice(0, guard)).not.toMatch(/\bfetch\(/)
  })

  it('the agents on the plan are named in a second paragraph, from the rotation state and the agent list', () => {
    expect(APP).toContain("const planUsers = Object.entries(state.activePlanByAgent || {}).filter(([, id]) => id === plan.id).map(([agent]) => agent)")
    expect(APP).toContain("delBtn.addEventListener('click', () => deleteClaudePlan(plan, planUsers))")
    expect(DEL).toContain('const users = await claudePlanUsers(id, rotationUsers)')
    expect(DEL).toContain("if (plan.tokenSecretId) message += ' ' + t('settings.claude_plans.confirm_delete_token')")
    expect(DEL).toContain("if (users.length) message += '\\n\\n' + t('settings.claude_plans.confirm_delete_used_by', { agents: ")
  })

  it('the old texts are gone, and the keys are in both languages with their placeholders', () => {
    for (const lang of [HU, EN]) {
      expect(lang.split('\n').find(l => l.includes("'settings.claude_plans.confirm_delete':"))).not.toContain('regisztry')
      for (const key of ['settings.claude_plans.confirm_delete', 'settings.claude_plans.confirm_delete_title', 'settings.claude_plans.confirm_delete_ok',
        'settings.claude_plans.confirm_delete_used_by', 'settings.claude_plans.confirm_delete_token', 'settings.claude_plans.confirm_switch', 'settings.claude_plans.confirm_switch_title', 'settings.claude_plans.confirm_switch_ok']) {
        expect(lang, key).toContain(`'${key}':`)
      }
      expect(lang.split('\n').find(l => l.includes("'settings.claude_plans.confirm_delete':"))).toContain('{label}')
      // The Vault is its own sentence, added only for a token-mode plan.
      expect(lang.split('\n').find(l => l.includes("'settings.claude_plans.confirm_delete':"))).not.toContain('Vault')
      expect(lang.split('\n').find(l => l.includes("'settings.claude_plans.confirm_delete_used_by':"))).toContain('{agents}')
      expect(lang.split('\n').find(l => l.includes("'settings.claude_plans.confirm_switch':"))).toContain('{label}')
    }
    expect(HU.split('\n').find(l => l.includes("'settings.claude_plans.confirm_switch':"))).not.toMatch(/agent|session/)
  })
})

describe('the update questions use it', () => {
  const fn = (name: string) => {
    const m = new RegExp(`async function ${name}\\(`).exec(APP)
    if (!m) return ''
    let depth = 0
    for (let j = APP.indexOf('{', m.index); j < APP.length; j++) {
      if (APP[j] === '{') depth++
      else if (APP[j] === '}' && --depth === 0) return APP.slice(m.index, j + 1)
    }
    return ''
  }
  const CLI = fn('applyCliUpdate')
  const DIAG = fn('runDiagnose')
  const RUN = fn('runUpdate')
  const APPLY = (() => {
    const i = APP.indexOf("document.getElementById('updatesApplyBtn').addEventListener('click'")
    const j = i < 0 ? -1 : APP.indexOf('\n})\n', i)
    return i < 0 || j < 0 ? '' : APP.slice(i, j)
  })()

  // A button stub that runUpdate and the others can disable, hide and query.
  const button = () => {
    const part = { hidden: false }
    return { disabled: false, hidden: false, querySelector: () => part }
  }
  function load(body: string, name: string, answer: boolean, responses: Array<{ ok: boolean; body: unknown }>) {
    const dialogs: Array<Record<string, unknown>> = []
    const calls: Array<{ url: string; body?: string }> = []
    const toasts: string[] = []
    const queue = [...responses]
    const run = new Function(
      'confirmDialog', 't', 'fetch', 'showToast', 'document', 'renderCliUpdateOffer', 'pollUpdateOutcome',
      `${body}\nreturn ${name}`,
    )(
      async (o: Record<string, unknown>) => { dialogs.push(o); return answer },
      (key: string, vars?: Record<string, string>) => (vars ? `${key} ${JSON.stringify(vars)}` : key),
      async (url: string, init: { body?: string } = {}) => {
        calls.push({ url, body: init.body })
        const r = queue.shift() ?? { ok: true, body: {} }
        return { ok: r.ok, status: r.ok ? 200 : 409, json: async () => r.body }
      },
      (m: string) => { toasts.push(m) },
      { getElementById: () => button() },
      () => {}, async () => {},
    ) as (arg?: unknown) => Promise<void>
    return { run, dialogs, calls, toasts }
  }

  it('the handlers were found, with no native confirm() left', () => {
    for (const part of [CLI, DIAG, RUN, APPLY]) {
      expect(part).not.toBe('')
      expect(part).not.toMatch(/(^|[^.\w])(confirm|alert)\(/)
    }
  })

  it('the CLI update asks in its own dialog naming the version; a "no" sends nothing, a "yes" the apply', async () => {
    const no = load(CLI, 'applyCliUpdate', false, [])
    await no.run('2.1.320')
    expect(no.dialogs).toEqual([{
      title: 'updates.cli.confirm_title',
      message: 'updates.cli.confirm {"v":"2.1.320"}',
      okLabel: 'updates.cli.confirm_ok',
    }])
    expect(no.calls).toEqual([])
    const yes = load(CLI, 'applyCliUpdate', true, [{ ok: true, body: {} }])
    await yes.run('2.1.320')
    expect(yes.calls).toEqual([{ url: '/api/updates/cli/apply', body: '{"target":"2.1.320"}' }])
  })

  it('the diagnosis asks in its own dialog; a "no" starts nothing, a "yes" the diagnosis', async () => {
    const no = load(DIAG, 'runDiagnose', false, [])
    await no.run()
    expect(no.dialogs).toEqual([{
      title: 'updates.diagnose.consent_title',
      message: 'updates.diagnose.consent',
      okLabel: 'updates.diagnose.consent_ok',
    }])
    expect(no.calls).toEqual([])
    const yes = load(DIAG, 'runDiagnose', true, [{ ok: true, body: {} }])
    await yes.run()
    expect(yes.calls.map(c => c.url)).toEqual(['/api/updates/diagnose'])
  })

  it('a dirty tree offers the stash in a danger dialog; a "no" stops, a "yes" retries with autoStash', async () => {
    const dirty = { ok: false, body: { reason: 'dirty-tree', error: 'Working tree has uncommitted changes' } }
    const no = load(RUN, 'runUpdate', false, [dirty])
    await no.run(false)
    expect(no.dialogs).toEqual([{
      title: 'updates.confirm.stash_title',
      message: 'updates.confirm.stash',
      okLabel: 'updates.confirm.stash_ok',
      danger: true,
    }])
    expect(no.calls.map(c => c.body)).toEqual(['{"autoStash":false}'])
    const yes = load(RUN, 'runUpdate', true, [dirty, { ok: true, body: {} }])
    await yes.run(false)
    expect(yes.calls.map(c => c.body)).toEqual(['{"autoStash":false}', '{"autoStash":true}'])
    // Already with autoStash: no second question.
    const again = load(RUN, 'runUpdate', true, [dirty])
    await again.run(true)
    expect(again.dialogs).toEqual([])
  })

  it('the update button asks in its own dialog before runUpdate', () => {
    expect(APPLY).toContain("title: t('updates.confirm.apply_title')")
    expect(APPLY).toContain("message: t('updates.confirm.apply')")
    expect(APPLY).toContain("okLabel: t('updates.confirm.apply_ok')")
    const ask = APPLY.indexOf('await confirmDialog({')
    const guard = APPLY.indexOf('if (!confirmed) return')
    expect(ask).toBeGreaterThan(-1)
    expect(guard).toBeGreaterThan(ask)
    expect(APPLY.indexOf('await runUpdate(false)')).toBeGreaterThan(guard)
  })

  it('the keys are in both languages; the texts say what the update does', () => {
    const line = (lang: string, key: string) => lang.split('\n').find(l => l.includes(`'${key}':`)) ?? ''
    for (const lang of [HU, EN]) {
      for (const key of ['updates.confirm.apply', 'updates.confirm.stash', 'updates.cli.confirm', 'updates.diagnose.consent']) {
        for (const suffix of ['', '_title', '_ok']) expect(line(lang, key + suffix), key + suffix).not.toBe('')
      }
      expect(line(lang, 'updates.cli.confirm')).toContain('{v}')
    }
    // update.sh restarts the channels unit too (a fresh conversation) and rolls a dashboard that does not come up back.
    expect(line(HU, 'updates.confirm.apply')).toContain('új beszélgetéssel')
    expect(line(HU, 'updates.confirm.apply')).toContain('visszaáll az előző verzióra')
    // A conflicting restore leaves the local change in the stash only.
    expect(line(HU, 'updates.confirm.stash')).toContain('csak a stash-ben')
    // The diagnosis is a task on the main agent, not a new agent; it never restarts the services.
    expect(line(HU, 'updates.diagnose.consent')).toContain('A fő ügynök feladatot kap')
    expect(line(HU, 'updates.diagnose.consent')).toContain('nem indítja újra')
    for (const key of ['updates.cli.confirm', 'updates.diagnose.consent', 'updates.confirm.stash']) {
      expect(line(HU, key)).not.toMatch(/session|agenst|working tree/)
    }
  })
})

describe('the Vault deletes use it', () => {
  const SITES = [
    ['delete a secret from the Connectors list', "<span class=\"github-repo-date\">${escapeHtml(s.id)} &middot; ${date}</span>", 'vault.confirm.delete', "{ method: 'DELETE' })"],
    ['delete an SSH key', "tbody.querySelectorAll('.ssh-key-delete-btn').forEach", 'vault.ssh.confirm.key_delete', "{ method: 'DELETE' })"],
    ['delete an SSH server', "document.querySelectorAll('.ssh-delete-btn').forEach", 'vault.ssh.confirm.server_delete', "{ method: 'DELETE' })"],
    ['delete a secret from the Vault page', "list.querySelectorAll('.vault-card-delete').forEach", 'vault.confirm.delete', "{ method: 'DELETE' })"],
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
    expect(src).toContain(`t('${key}', { name: `)
    expect(src).toMatch(/\bmessage(: t\(|,)/)
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

  it('the SSH key question names the servers that lose the key, and both lists reload after it', () => {
    const src = handler("tbody.querySelectorAll('.ssh-key-delete-btn').forEach", 'await loadSshServers()')
    expect(src, 'handler or its server reload not found').not.toBe('')
    expect(src, 'the server reload must be in this handler').not.toContain('function _refreshKeySelects')
    expect(src).toContain('_sshServers')
    expect(src).toContain("if (servers.length) message += '\\n\\n' + t('vault.ssh.confirm.key_delete_servers', { servers: ")
    expect(src).toContain('if (!res.ok) showToast(')
    expect(src).toContain('await loadSshKeys()')
    for (const lang of [HU, EN]) {
      const line = lang.split('\n').find(l => l.includes("'vault.ssh.confirm.key_delete_servers':")) || ''
      expect(line).toContain('{servers}')
    }
  })

  it('the hard-coded questions and the "Törlés sikertelen" toast are gone', () => {
    expect(APP).not.toContain('`Torlod: ${s.label}?`')
    expect(APP).not.toContain('`Torlod: ${id}?`')
    expect(APP).not.toContain('`Törlöd: ${id}?`')
    expect(APP).not.toContain('Biztosan törlöd ezt a kulcsot?')
    expect(APP).not.toContain("showToast('Törlés sikertelen')")
  })

  it('no unaccented "Torles" tooltip is left', () => {
    const HTML = readFileSync(new URL('../../web/index.html', import.meta.url), 'utf-8')
    expect(APP).not.toContain('title="Torles"')
    expect(HTML).not.toContain('title="Torles"')
  })

  it('the Vault and Paths sections have no unaccented labels left, and they translate', () => {
    const HTML = readFileSync(new URL('../../web/index.html', import.meta.url), 'utf-8')
    for (const gone of ['titkositott', 'Kulcs nev ', 'placeholder="Ertek"', '>Hozzaad<', ' Utvonalak ']) expect(HTML).not.toContain(gone)
    for (const key of ['connectors.vault_section', 'connectors.vault_id_ph', 'connectors.vault_value_ph', 'connectors.external_paths']) {
      expect(HTML).toContain(`"${key}"`)
      expect(HU).toContain(`'${key}':`)
      expect(EN).toContain(`'${key}':`)
    }
  })

  it.each([...new Set(SITES.flatMap(([, , key]) => [key, `${key}_title`, `${key}_ok`]))])('%s is in both languages and names the item', (key) => {
    expect(HU).toContain(`'${key}':`)
    expect(EN).toContain(`'${key}':`)
    if (!key.endsWith('_title') && !key.endsWith('_ok')) {
      for (const lang of [HU, EN]) {
        const line = lang.split('\n').find(l => l.includes(`'${key}':`)) || ''
        expect(line).toContain('{name}')
      }
    }
  })
})

describe('the pending retry cancel and the background task stop use it', () => {
  const between = (from: string, to: string) => {
    const i = APP.indexOf(from)
    const j = i < 0 ? -1 : APP.indexOf(to, i)
    return i < 0 || j < 0 ? '' : APP.slice(i, j)
  }
  const PENDING = between("container.querySelectorAll('[data-action=\"cancel-pending\"]').forEach", '\n}\n')
  const BG = between('async function cancelBgTask(', '\n}\n')
  const VIEW = between('async function viewBgTask(', '\n}\n')

  it('the handlers were found', () => {
    for (const part of [PENDING, BG, VIEW]) expect(part).not.toBe('')
  })

  it('the pending retry cancel: a danger confirmDialog naming the task and its agent, no native confirm()', () => {
    expect(PENDING).toContain('const confirmed = await confirmDialog({')
    expect(PENDING).toContain("title: t('tasks.confirm.cancel_pending_title')")
    expect(PENDING).toContain("t('tasks.confirm.cancel_pending', { name: r.taskName || id, agent: r.agentName })")
    expect(PENDING).toContain("t('tasks.confirm.cancel_pending_no_agent', { name: (r && r.taskName) || id })")
    expect(PENDING).toContain("okLabel: t('tasks.confirm.cancel_pending_ok')")
    expect(PENDING).toContain('danger: true')
    expect(PENDING).not.toMatch(/(^|[^.\w])(confirm|alert)\(/)
  })

  it('a failed cancel says so in a translated toast instead of only the console, and the list is reloaded', () => {
    expect(PENDING).toContain("if (!res.ok) showToast(t('tasks.toast.cancel_pending_error'))")
    expect(PENDING).toContain("catch {\n        showToast(t('tasks.toast.cancel_pending_error'))")
    expect(PENDING).not.toContain('console.error')
  })

  it('the background task stop: a danger confirmDialog naming the task and its agent, no native confirm()', () => {
    expect(BG).toContain('const confirmed = await confirmDialog({')
    expect(BG).toContain("title: t('bgTasks.cancel.title')")
    expect(BG).toContain("t('bgTasks.cancel.confirm', { id, agent })")
    expect(BG).toContain("okLabel: t('bgTasks.cancel.ok')")
    expect(BG).toContain('danger: true')
    expect(BG).not.toMatch(/(^|[^.\w])(confirm|alert)\(/)
    expect(APP).toContain('onclick="cancelBgTask(${jsArg(task.id)}, ${jsArg(task.agent_id)})"')
  })

  it('without an agent name the question has no empty parentheses', async () => {
    // The real cancelBgTask, with the dialog captured and "no" answered.
    const asked: string[] = []
    const tr = (key: string, vars: Record<string, string> = {}) => {
      const line = HU.split('\n').find(l => l.includes(`'${key}':`)) ?? ''
      const text = line.slice(line.indexOf(':') + 1).trim().replace(/^'|',?$/g, '')
      return text.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '')
    }
    const run = new Function('confirmDialog', 't', 'fetch', `${BG}\n}\nreturn cancelBgTask`)(
      async (o: { message: string }) => { asked.push(o.message); return false },
      tr,
      () => { throw new Error('no request after a "no"') },
    )
    await run('bg-1', 'marketing')
    await run('bg-2', '')
    await run('bg-3', undefined)
    expect(asked[0]).toContain('bg-1 (marketing)?')
    for (const m of asked.slice(1)) {
      expect(m).not.toContain('()')
      expect(m).toMatch(/bg-\d\? A futó munka megszakad/)
    }
    expect(PENDING).toContain('message: (r && r.agentName)\n')
  })

  it('a "no" stops both, before the request', () => {
    for (const handler of [PENDING, BG]) {
      const ask = handler.indexOf('const confirmed = await confirmDialog({')
      const guard = handler.indexOf('if (!confirmed) return')
      expect(ask).toBeGreaterThan(-1)
      expect(guard).toBeGreaterThan(ask)
      expect(handler.slice(0, guard)).not.toMatch(/\bfetch\(/)
    }
  })

  it('the hard-coded "Hiba" toasts are gone from the background task section', () => {
    expect(BG).not.toContain("showToast('Hiba')")
    expect(VIEW).not.toContain("showToast('Hiba')")
    expect(BG).toContain("showToast(t('bgTasks.toast.stop_error'))")
    expect(VIEW).toContain("showToast(t('bgTasks.load_error'))")
  })

  it('the keys are in both languages, with their placeholders', () => {
    for (const key of ['tasks.confirm.cancel_pending', 'tasks.confirm.cancel_pending_title', 'tasks.confirm.cancel_pending_ok', 'tasks.toast.cancel_pending_error',
      'tasks.confirm.cancel_pending_no_agent', 'bgTasks.cancel.confirm_no_agent',
      'bgTasks.cancel.confirm', 'bgTasks.cancel.title', 'bgTasks.cancel.ok', 'bgTasks.toast.stop_error', 'bgTasks.load_error']) {
      for (const lang of [HU, EN]) expect(lang, key).toContain(`'${key}':`)
    }
    for (const lang of [HU, EN]) {
      const pending = lang.split('\n').find(l => l.includes("'tasks.confirm.cancel_pending':")) ?? ''
      expect(pending).toContain('{name}')
      expect(pending).toContain('{agent}')
      const bg = lang.split('\n').find(l => l.includes("'bgTasks.cancel.confirm':")) ?? ''
      expect(bg).toContain('{id}')
      expect(bg).toContain('{agent}')
      for (const key of ['tasks.confirm.cancel_pending_no_agent', 'bgTasks.cancel.confirm_no_agent']) {
        const line = lang.split('\n').find(l => l.includes(`'${key}':`)) ?? ''
        expect(line, key).not.toContain('{agent}')
        expect(line, key).not.toContain('(')
      }
    }
  })
})

describe('the auth and device questions use it', () => {
  const fn = (name: string) => {
    const m = new RegExp(`(?:async )?function ${name}\\(`).exec(APP)
    if (!m) return ''
    let depth = 0
    for (let j = APP.indexOf('{', m.index); j < APP.length; j++) {
      if (APP[j] === '{') depth++
      else if (APP[j] === '}' && --depth === 0) return APP.slice(m.index, j + 1)
    }
    return ''
  }
  const BRIDGE = fn('bridgeEnrollFromUi')
  const DEVICES = fn('refreshDeviceKeyList')
  const OPERATOR = fn('saveOperatorAccess')
  const FAILURE = fn('handleAuthFailure')
  const NOTICE = fn('showAuthFailedNotice')
  const tr = (key: string, vars?: Record<string, string>) => (vars ? `${key} ${JSON.stringify(vars)}` : key)

  it('the handlers were found, with no native confirm() or alert() left', () => {
    for (const part of [BRIDGE, DEVICES, OPERATOR, FAILURE, NOTICE]) {
      expect(part).not.toBe('')
      expect(part).not.toMatch(/(^|[^.\w])(confirm|alert)\(/)
    }
  })

  it('the Bridge pairing asks in its own dialog naming the device; a "no" sends nothing', async () => {
    const dialogs: Array<Record<string, unknown>> = []
    const calls: string[] = []
    const fields: Record<string, { value: string; className?: string; textContent?: string; hidden?: boolean; classList?: { add: () => void } }> = {
      authBridgeKeyLine: { value: 'ssh-ed25519 AAAA bridge-x' },
      authBridgeName: { value: 'Laptop' },
      authBridgeHost: { value: '' },
      authBridgeMsg: { value: '', classList: { add: () => {} } },
      authBridgeBundle: { value: '' },
    }
    const run = new Function('confirmDialog', 't', 'fetch', 'document', `${BRIDGE}\nreturn bridgeEnrollFromUi`)(
      async (o: Record<string, unknown>) => { dialogs.push(o); return false },
      tr,
      async (url: string) => { calls.push(url); return { ok: true, json: async () => ({}) } },
      { getElementById: (id: string) => fields[id] },
    ) as () => Promise<void>
    await run()
    expect(dialogs).toEqual([{
      title: 'auth.bridge.confirm_title',
      message: 'auth.bridge.confirm {"name":"Laptop"}',
      okLabel: 'auth.bridge.confirm_ok',
    }])
    expect(calls).toEqual([])
  })

  it('the device key revoke names the device in a danger dialog, says a Bridge loses its tunnel too, and a "no" sends nothing', async () => {
    async function revoke(key: Record<string, unknown>, answer: boolean) {
      const dialogs: Array<Record<string, unknown>> = []
      const calls: Array<{ url: string; method: string }> = []
      let onClick: (() => Promise<void>) | null = null
      const btn = { dataset: { keyId: String(key.id) }, addEventListener: (_: string, f: () => Promise<void>) => { onClick = f } }
      const list = { innerHTML: '', querySelectorAll: () => [btn] }
      const run = new Function('confirmDialog', 't', 'fetch', 'document', 'escapeHtml', `${DEVICES}\nreturn refreshDeviceKeyList`)(
        async (o: Record<string, unknown>) => { dialogs.push(o); return answer },
        tr,
        async (url: string, init: { method?: string } = {}) => {
          calls.push({ url, method: init.method || 'GET' })
          return { ok: true, json: async () => (url === '/api/auth/device-keys' ? { keys: [{ createdAt: 1, ...key }] } : {}) }
        },
        { getElementById: (id: string) => (id === 'authDeviceKeyList' ? list : null) },
        (x: string) => x,
      ) as () => Promise<void>
      await run()
      await onClick!()
      return { dialogs, deletes: calls.filter(c => c.method === 'DELETE') }
    }
    const plain = await revoke({ id: 7, name: 'Telefon' }, false)
    expect(plain.dialogs).toEqual([{
      title: 'auth.devices.revoke_confirm_title',
      message: 'auth.devices.revoke_confirm {"name":"Telefon"}',
      okLabel: 'auth.devices.revoke_confirm_ok',
      danger: true,
    }])
    expect(plain.deletes).toEqual([])
    const bridge = await revoke({ id: 8, name: 'Laptop', installId: 'abc' }, false)
    expect(bridge.dialogs[0].message).toBe('auth.devices.revoke_confirm {"name":"Laptop"} auth.devices.revoke_confirm_bridge')
    const yes = await revoke({ id: 7, name: 'Telefon' }, true)
    expect(yes.deletes).toEqual([{ url: '/api/auth/device-keys/7', method: 'DELETE' }])
  })

  it('turning on the pane view asks in its own dialog, naming the allowed commands; a "no" leaves it unticked and saves nothing', async () => {
    async function turnOn(answer: boolean) {
      const dialogs: Array<Record<string, unknown>> = []
      const puts: Array<Record<string, any>> = []
      const boxes: Record<string, { dataset: Record<string, string>; checked: boolean }> = {
        paneView: { dataset: { opCap: 'paneView' }, checked: true },
        update: { dataset: { opCap: 'update' }, checked: false },
      }
      let duringDialog: boolean | null = null
      let save: (ev: unknown) => Promise<void> = async () => {}
      save = new Function('confirmDialog', 't', 'fetch', 'document', 'OPERATOR_CAPS', 'OPERATOR_CMDS', 'CSS', 'applyOperatorAccess', `${OPERATOR}\nreturn saveOperatorAccess`)(
        async (o: Record<string, unknown>) => {
          dialogs.push(o)
          duringDialog = boxes.paneView.checked
          // Behind the open dialog, another switch is toggled from the keyboard and saves.
          boxes.update.checked = true
          await save({ target: boxes.update })
          return answer
        },
        tr,
        async (_url: string, init: { body?: string } = {}) => { if (init.body) puts.push(JSON.parse(init.body)); return { ok: true, json: async () => ({}) } },
        {
          getElementById: () => ({ className: '', checked: true, classList: { add: () => {} } }),
          querySelector: (sel: string) => {
            const m = /data-op-cap="([^"]+)"/.exec(sel)
            return (m && boxes[m[1]]) || { checked: false }
          },
        },
        ['paneView', 'update'], ['login', 'mcp'], { escape: (x: string) => x }, () => {},
      ) as (ev: unknown) => Promise<void>
      await save({ target: boxes.paneView })
      return { dialogs, puts, duringDialog, box: boxes.paneView }
    }
    const no = await turnOn(false)
    expect(no.dialogs).toEqual([{
      title: 'auth.operator.pane_warning_title',
      message: 'auth.operator.pane_warning {"cmds":"/login, /mcp"}',
      okLabel: 'auth.operator.pane_warning_ok',
    }])
    // While the dialog is open the box is unticked, so the save behind it does not carry paneView=true.
    expect(no.duringDialog).toBe(false)
    expect(no.puts.map(b => b.capabilities.paneView)).toEqual([false])
    expect(no.box.checked).toBe(false)
    const yes = await turnOn(true)
    expect(yes.box.checked).toBe(true)
    expect(yes.puts.map(b => b.capabilities.paneView)).toEqual([false, true])
  })

  it('a failed token login without a password login shows a translated notice instead of the English alert', () => {
    expect(FAILURE).toContain('showAuthFailedNotice()')
    expect(APP).not.toContain('Dashboard authentication failed.')
    for (const key of ['auth.failed.title', 'auth.failed.desc', 'auth.failed.close']) expect(NOTICE).toContain(`tr('${key}', `)
    expect(NOTICE).toContain("close.addEventListener('click', () => overlay.remove())")
    expect(NOTICE).not.toContain('innerHTML')
  })

  it('the keys are in both languages; the texts say what the server does', () => {
    const line = (lang: string, key: string) => lang.split('\n').find(l => l.includes(`'${key}':`)) ?? ''
    for (const lang of [HU, EN]) {
      for (const key of ['auth.bridge.confirm', 'auth.devices.revoke_confirm', 'auth.operator.pane_warning']) {
        for (const suffix of ['', '_title', '_ok']) expect(line(lang, key + suffix), key + suffix).not.toBe('')
      }
      for (const key of ['auth.devices.revoke_confirm_bridge', 'auth.failed.title', 'auth.failed.desc', 'auth.failed.close']) expect(line(lang, key), key).not.toBe('')
      expect(line(lang, 'auth.bridge.confirm')).toContain('"{name}"')
      expect(line(lang, 'auth.devices.revoke_confirm')).toContain('"{name}"')
      expect(line(lang, 'auth.failed.desc')).toContain('?token=')
    }
    // At pairing the tunnel opens to the dashboard port only (permitopen); later the Bridge may ask for further
    // local ports with its own key, with a notification (bridge-service-ports.ts). A re-paired Bridge loses its old key.
    expect(line(HU, 'auth.bridge.confirm')).toContain('párosításkor csak a dashboardhoz')
    expect(line(HU, 'auth.bridge.confirm')).toContain('további helyi portokat kérhet, ezekről értesítést kapsz')
    expect(line(EN, 'auth.bridge.confirm')).toContain('at pairing opens to the dashboard only')
    expect(line(EN, 'auth.bridge.confirm')).toContain('further local ports')
    expect(line(HU, 'auth.bridge.confirm')).toContain('a régi kulcsa megszűnik')
    expect(line(HU, 'auth.devices.revoke_confirm_bridge')).toContain('SSH-alagútja is megszűnik')
    expect(line(HU, 'auth.operator.pane_warning')).toContain('Írni nem tud bele')
    // Even the commands right sends only the fixed commands (OPERATOR_COMMANDS); the list comes from the code.
    expect(line(HU, 'auth.operator.pane_warning')).toContain('a parancsküldés jogával is csak az általad engedélyezett fix parancsokat')
    expect(line(EN, 'auth.operator.pane_warning')).toContain('even with the commands permission they can only send the fixed commands')
    for (const lang of [HU, EN]) {
      expect(line(lang, 'auth.operator.pane_warning')).toContain('({cmds})')
      expect(line(lang, 'auth.operator.pane_warning')).not.toContain('/login')
    }
  })
})

describe('the custom provider delete uses it', () => {
  const anchor = "tbody.querySelectorAll('[data-provider-delete]').forEach"
  const handler = (() => {
    const i = APP.indexOf(anchor)
    const end = "catch { showToast(t('providers.toast.delete_error')) }"
    const j = i < 0 ? -1 : APP.indexOf(end, i)
    return i < 0 || j < 0 ? '' : APP.slice(i, j + end.length)
  })()

  it('a danger confirmDialog with its own title and button, naming the provider, no native confirm()', () => {
    expect(handler, 'handler not found').not.toBe('')
    expect(handler).toContain('const confirmed = await confirmDialog({')
    expect(handler).toContain("title: t('providers.confirm.delete_title')")
    expect(handler).toContain("t('providers.confirm.delete', { name: (p && p.label) || id })")
    expect(handler).toContain("okLabel: t('providers.confirm.delete_ok')")
    expect(handler).toContain('danger: true')
    expect(handler).not.toMatch(/(^|[^.\w])(confirm|alert)\(/)
  })

  it('a "no" stops it -- the answer is checked before the request', () => {
    const ask = handler.indexOf('const confirmed = await confirmDialog({')
    const guard = handler.indexOf('if (!confirmed) return')
    expect(ask).toBeGreaterThan(-1)
    expect(guard).toBeGreaterThan(ask)
    expect(handler.slice(0, guard)).not.toMatch(/\bfetch\(/)
  })

  it('the question names the agents that use the provider, from the list\'s usedBy', () => {
    expect(handler).toContain('const users = (p && p.usedBy) || []')
    expect(handler).toContain("if (users.length) message += '\\n\\n' + t('providers.confirm.delete_used_by', { agents: ")
  })

  it('a failed delete shows a translated toast, or the server\'s reason', () => {
    expect(handler).toContain("showToast(err.error || t('providers.toast.delete_error'))")
    expect(handler).toContain('loadAvailableModels()')
  })

  it('the hard-coded question and error are gone, and the keys are in both languages', () => {
    expect(APP).not.toContain('providert?`')
    expect(APP).not.toContain("alert('Hiba a törléskor.')")
    for (const key of ['providers.confirm.delete_title', 'providers.confirm.delete', 'providers.confirm.delete_used_by', 'providers.confirm.delete_ok', 'providers.toast.delete_error']) {
      for (const lang of [HU, EN]) expect(lang, key).toContain(`'${key}':`)
    }
    for (const lang of [HU, EN]) {
      expect(lang.split('\n').find(l => l.includes("'providers.confirm.delete':"))).toContain('{name}')
      expect(lang.split('\n').find(l => l.includes("'providers.confirm.delete_used_by':"))).toContain('{agents}')
    }
  })
})

describe('the idea and idea attachment deletes use it', () => {
  const between = (from: string, to: string) => {
    const i = APP.indexOf(from)
    const j = i < 0 ? -1 : APP.indexOf(to, i)
    return i < 0 || j < 0 ? '' : APP.slice(i, j)
  }
  const IDEA = between('async function deleteIdeaItem(', '\n}\n')
  const ATTACH = between('async function deleteIdeaAttachmentItem(', '\n}\n')

  it('the handlers were found', () => {
    expect(IDEA).not.toBe('')
    expect(ATTACH).not.toBe('')
  })

  it('the idea delete: a danger confirmDialog with its own title and button, naming the idea, no native confirm()', () => {
    expect(IDEA).toContain('const confirmed = await confirmDialog({')
    expect(IDEA).toContain("title: t('ideas.confirm.delete_title')")
    expect(IDEA).toContain("t('ideas.confirm.delete', { title: (idea && idea.title) || id })")
    expect(IDEA).toContain("okLabel: t('ideas.confirm.delete_ok')")
    expect(IDEA).toContain('danger: true')
    expect(IDEA).not.toMatch(/(^|[^.\w])(confirm|alert)\(/)
    // it borrowed the Kanban card's question before
    expect(IDEA).not.toContain('kanban.confirm.delete')
  })

  it('the idea delete says that its attachments and comments go with it', () => {
    expect(IDEA).toContain("'\\n\\n' + t('ideas.confirm.delete_children')")
  })

  it('the attachment delete: a danger confirmDialog naming the file, no native confirm()', () => {
    expect(ATTACH).toContain('const confirmed = await confirmDialog({')
    expect(ATTACH).toContain("title: t('ideas.detail.attach.confirm_delete_title')")
    expect(ATTACH).toContain("t('ideas.detail.attach.confirm_delete', { name: filename || '' })")
    expect(ATTACH).toContain("okLabel: t('ideas.detail.attach.confirm_delete_ok')")
    expect(ATTACH).toContain('danger: true')
    expect(ATTACH).not.toMatch(/(^|[^.\w])(confirm|alert)\(/)
    expect(APP).toContain('onclick="deleteIdeaAttachmentItem(${jsArg(encodeURIComponent(a.id))}, ${jsArg(a.filename)})"')
  })

  it('a "no" stops both, before the request', () => {
    for (const handler of [IDEA, ATTACH]) {
      const ask = handler.indexOf('const confirmed = await confirmDialog({')
      const guard = handler.indexOf('if (!confirmed) return')
      expect(ask).toBeGreaterThan(-1)
      expect(guard).toBeGreaterThan(ask)
      expect(handler.slice(0, guard)).not.toMatch(/\bfetch\(/)
    }
  })

  it('a failed idea delete shows the server\'s reason or a translated toast, and the list is not reloaded as if it worked', () => {
    expect(IDEA).toContain("showToast(err.error || t('ideas.toast.delete_error'), 'error')")
    expect(IDEA).toContain("catch { showToast(t('ideas.toast.delete_error'), 'error'); return }")
    expect(IDEA).toContain("showToast(err.error || t('ideas.toast.delete_error'), 'error')\n      return\n    }")
    expect(IDEA.indexOf('loadIdeasPage()')).toBeGreaterThan(IDEA.indexOf('if (!res.ok) {'))
  })

  it('the keys are in both languages, with their placeholders', () => {
    for (const key of ['ideas.confirm.delete_title', 'ideas.confirm.delete', 'ideas.confirm.delete_children', 'ideas.confirm.delete_ok',
      'ideas.detail.attach.confirm_delete', 'ideas.detail.attach.confirm_delete_title', 'ideas.detail.attach.confirm_delete_ok', 'ideas.toast.delete_error']) {
      for (const lang of [HU, EN]) expect(lang, key).toContain(`'${key}':`)
    }
    for (const lang of [HU, EN]) {
      expect(lang.split('\n').find(l => l.includes("'ideas.confirm.delete':"))).toContain('{title}')
      expect(lang.split('\n').find(l => l.includes("'ideas.detail.attach.confirm_delete':"))).toContain('{name}')
    }
  })
})

describe('the Gromzo agent switches use it', () => {
  // The bodies sit inside the Gromzo page's closure: cut each by its braces and run it with that closure's names handed in.
  const fn = (name: string) => {
    const m = new RegExp(`async function ${name}\\(row\\) \\{`).exec(APP)
    if (!m) return ''
    let depth = 0
    for (let j = APP.indexOf('{', m.index); j < APP.length; j++) {
      if (APP[j] === '{') depth++
      else if (APP[j] === '}' && --depth === 0) return APP.slice(m.index, j + 1)
    }
    return ''
  }
  const ON = fn('switchOn')
  const OFF = fn('switchOff')
  const RESTART = fn('restartMain')

  function load(body: string, name: string, answer: boolean) {
    const dialogs: Array<Record<string, unknown>> = []
    const posts: string[] = []
    const run = new Function(
      'confirmDialog', 't', 'post', 'local', 'render', 'loadAgents', 'codeOf', 'agentErr', 'nameFieldShown', 'nameFor', 'nameAsk', 'NAME_CODES', 'nameRefused', 'setTimeout',
      `${body}\nreturn ${name}`,
    )(
      async (o: Record<string, unknown>) => { dialogs.push(o); return answer },
      (key: string, vars?: Record<string, string>) => (vars ? `${key} ${JSON.stringify(vars)}` : key),
      async (slug: string, action: string) => { posts.push(`${slug}/${action}`); return { ok: true, json: async () => ({ state: 'removed' }) } },
      new Map(), () => {}, async () => {}, async () => 'x', (c: string) => c,
      () => false, () => '', new Set(), [], () => {}, () => 0,
    ) as (row: Record<string, unknown>) => Promise<void>
    return { run, dialogs, posts }
  }

  it('the handlers were found, with no native confirm() left', () => {
    for (const part of [ON, OFF, RESTART]) {
      expect(part).not.toBe('')
      expect(part).not.toMatch(/(^|[^.\w])(confirm|alert)\(/)
    }
  })

  it('the main agent switch-on asks in its own dialog; a "no" sends nothing, a "yes" the enable', async () => {
    const no = load(ON, 'switchOn', false)
    await no.run({ slug: 'main', main: true })
    expect(no.dialogs).toEqual([{
      title: 'gromzo.agents.main.confirm_on_title',
      message: 'gromzo.agents.main.confirm_on',
      okLabel: 'gromzo.agents.main.confirm_on_ok',
    }])
    expect(no.posts).toEqual([])
    const yes = load(ON, 'switchOn', true)
    await yes.run({ slug: 'main', main: true })
    expect(yes.posts).toEqual(['main/enable'])
  })

  it('a sub-agent switch-on asks nothing (the approval on Gromzo is the question)', async () => {
    const h = load(ON, 'switchOn', false)
    await h.run({ slug: 'kutato', name: 'Kutató' })
    expect(h.dialogs).toEqual([])
    expect(h.posts).toEqual(['kutato/enable'])
  })

  it('the switch-off: the main agent in its own dialog, a sub-agent in a danger one naming it; a "no" sends nothing', async () => {
    const main = load(OFF, 'switchOff', false)
    await main.run({ slug: 'main', main: true, name: 'Fő' })
    expect(main.dialogs).toEqual([{
      title: 'gromzo.agents.main.confirm_off_title',
      message: 'gromzo.agents.main.confirm_off',
      okLabel: 'gromzo.agents.main.confirm_off_ok',
    }])
    const sub = load(OFF, 'switchOff', false)
    await sub.run({ slug: 'kutato', name: 'Kutató' })
    expect(sub.dialogs).toEqual([{
      title: 'gromzo.agents.confirm_off_title',
      message: 'gromzo.agents.confirm_off {"name":"Kutató"}',
      okLabel: 'gromzo.agents.confirm_off_ok',
      danger: true,
    }])
    const unnamed = load(OFF, 'switchOff', false)
    await unnamed.run({ slug: 'kutato' })
    expect(unnamed.dialogs[0].message).toBe('gromzo.agents.confirm_off {"name":"kutato"}')
    expect([...main.posts, ...sub.posts, ...unnamed.posts]).toEqual([])
    const yes = load(OFF, 'switchOff', true)
    await yes.run({ slug: 'kutato', name: 'Kutató' })
    expect(yes.posts).toEqual(['kutato/disable'])
  })

  it('the main restart asks in its own dialog; a "no" sends nothing, a "yes" the restart', async () => {
    const no = load(RESTART, 'restartMain', false)
    await no.run({ slug: 'main', main: true })
    expect(no.dialogs).toEqual([{
      title: 'gromzo.agents.main.confirm_restart_title',
      message: 'gromzo.agents.main.confirm_restart',
      okLabel: 'gromzo.agents.main.confirm_restart_ok',
    }])
    expect(no.posts).toEqual([])
    const yes = load(RESTART, 'restartMain', true)
    await yes.run({ slug: 'main', main: true })
    expect(yes.posts).toEqual(['main/restart'])
  })

  it('the keys are in both languages; the texts say what the server does', () => {
    const line = (lang: string, key: string) => lang.split('\n').find(l => l.includes(`'${key}':`)) ?? ''
    for (const lang of [HU, EN]) {
      for (const key of ['main.confirm_on', 'main.confirm_off', 'main.confirm_restart', 'confirm_off']) {
        for (const suffix of ['', '_title', '_ok']) expect(line(lang, `gromzo.agents.${key}${suffix}`), key + suffix).not.toBe('')
      }
      expect(line(lang, 'gromzo.agents.confirm_off')).toContain('"{name}"')
    }
    // The main agent's restart is a fresh one (hardRestartMarveenChannels), and a busy pane is not cut off.
    for (const key of ['main.confirm_on', 'main.confirm_off', 'main.confirm_restart']) {
      expect(line(HU, `gromzo.agents.${key}`)).toMatch(/új beszélgetés/iu)
      expect(line(HU, `gromzo.agents.${key}`)).toMatch(/[ns]em szakítjuk meg/u)
    }
    // A sub-agent's switch-off removes it from mxd: on again only with a new approval. The old text said "chat service".
    expect(line(HU, 'gromzo.agents.confirm_off')).toContain('új jóváhagyással')
    expect(line(HU, 'gromzo.agents.confirm_off')).not.toContain('chat-szolgáltatás')
    expect(line(HU, 'gromzo.agents.main.confirm_off')).toContain('új jóváhagyás nélkül')
  })
})
