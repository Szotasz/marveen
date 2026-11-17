// The AI breakdown of a Kanban card and of an idea speaks the dashboard language: its toasts, the
// "include" checkbox and the "unassigned" option of the breakdown modal. They used to be Hungarian
// strings in app.js ("Breakdown hiba", "Hiba", "Bele", "-- nincs --"), so an English dashboard showed
// them in Hungarian. The card's breakdown button also got its label back as a hardcoded
// "Breakdown", losing its icon and its translation after every run.
// The real handlers run here against the real t() and both language files.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const APP = readFileSync(new URL('../../web/app.js', import.meta.url), 'utf-8')
const HU_SRC = readFileSync(new URL('../../web/lang/hu.js', import.meta.url), 'utf-8')
const EN_SRC = readFileSync(new URL('../../web/lang/en.js', import.meta.url), 'utf-8')

const I18N = (() => {
  const window: { _i18n?: Record<string, Record<string, string>> } = {}
  new Function('window', `${HU_SRC}\n${EN_SRC}`)(window)
  return window._i18n!
})()

// The real t() from the top of app.js, with the language picked per call.
const T_SRC = (() => {
  const i = APP.indexOf('window.t = function t(')
  const end = APP.indexOf('\n  }\n', i)
  return APP.slice(APP.indexOf('function t(', i), end + 4)
})()
type T = (k: string, p?: Record<string, unknown>) => string
function makeT(lang: 'hu' | 'en'): T {
  const window = { _lang: lang, _i18n: I18N, _brandTokens: { brand: 'Marveen', bot: 'Marveen', agentId: 'marveen' } }
  return new Function('window', 'localStorage', `return ${T_SRC}`)(window, { getItem: () => null }) as T
}

// From `anchor` (where `opener` starts) up to the matching closing brace of the body.
function block(anchor: string, opener: string): string {
  const i = APP.indexOf(anchor)
  if (i < 0) return ''
  const start = APP.indexOf(opener, i)
  let depth = 0
  // An arrow's body starts at its `=> {`; a function's after its parameter list.
  const body = opener.endsWith('=> {') ? start + opener.length - 1 : APP.indexOf(') {', start) + 2
  for (let j = body; j < APP.length; j++) {
    if (APP[j] === '{') depth++
    else if (APP[j] === '}' && --depth === 0) return APP.slice(start, j + 1)
  }
  return ''
}
const CARD_BREAKDOWN = block("document.getElementById('cardBreakdownBtn').onclick = ", 'async () => {')
const TRIGGER = block('\nasync function triggerBreakdown(', 'async function')
const ACCEPT = block("document.getElementById('breakdownAcceptBtn').addEventListener('click', ", 'async () => {')
const IDEA = block('\nasync function openIdeaBreakdown(', 'async function')
const MODAL = block('\nfunction showBreakdownModal(', 'function')
const HANDLERS = { CARD_BREAKDOWN, TRIGGER, ACCEPT, IDEA, MODAL }

const errorText = (lang: 'hu' | 'en') => makeT(lang)('kanban.breakdown.failed')
const reply = (status: number, data: Record<string, unknown>) => async () => ({ ok: status < 300, status, json: async () => data })
const throws = async () => { throw new Error('net') }

describe('the AI breakdown speaks the dashboard language', () => {
  it('the handlers were found, and none of them holds a Hungarian string any more', () => {
    for (const [name, src] of Object.entries(HANDLERS)) {
      expect(src, name).not.toBe('')
      const code = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
      expect(code, name).not.toMatch(/[áéíóöőúüű]/i)
      expect(code, name).not.toMatch(/'Hiba'|Breakdown hiba|'Breakdown'|-- nincs --|> Bele/)
    }
  })

  it('the new keys exist in both languages', () => {
    expect(errorText('hu')).toBe('Hiba a feladat szétbontása során')
    expect(errorText('en')).toBe('Error while breaking down the task')
    expect(makeT('hu')('kanban.breakdown.include')).toBe('Bele')
    expect(makeT('en')('kanban.breakdown.include')).toBe('Include')
  })

  describe("the card's breakdown button", () => {
    async function run(lang: 'hu' | 'en', fetchImpl: () => Promise<unknown>) {
      const toasts: string[] = []
      const shown: unknown[] = []
      const icon = { kind: 'text', value: '⚡ ' }
      const span = { kind: 'span', key: 'kanban.modal.breakdown_btn' }
      const btn = {
        disabled: false,
        children: [icon, span] as unknown[],
        get childNodes() { return this.children },
        set textContent(v: string) { this.children = [{ kind: 'text', value: v }] },
        replaceChildren(...nodes: unknown[]) { this.children = nodes },
      }
      const handler = new Function(
        'card', 'document', 't', 'fetch', 'showToast', 'showBreakdownModal',
        'breakdownMode', 'breakdownCardId', 'breakdownSubtasks', `return ${CARD_BREAKDOWN}`,
      )(
        { id: 'c1', title: 'Card' }, { getElementById: (id: string) => (id === 'cardBreakdownBtn' ? btn : null) },
        makeT(lang), fetchImpl, (m: string) => { toasts.push(m) }, (s: unknown) => { shown.push(s) }, null, null, null,
      ) as () => Promise<void>
      await handler()
      return { toasts, shown, children: btn.children, icon, span, disabled: btn.disabled }
    }

    it('a failure without a server error says so in the dashboard language; the server error still wins', async () => {
      expect((await run('hu', reply(500, {}))).toasts).toEqual([errorText('hu')])
      expect((await run('en', reply(500, {}))).toasts).toEqual([errorText('en')])
      expect((await run('en', reply(500, { error: 'No model' }))).toasts).toEqual(['No model'])
      expect((await run('en', throws)).toasts).toEqual([errorText('en')])
    })

    it('gets its own icon and translated label back after a run, success or failure', async () => {
      for (const f of [reply(200, { subtasks: [{ title: 'a' }] }), reply(500, {}), throws]) {
        const r = await run('en', f)
        expect(r.children).toEqual([r.icon, r.span])
        expect(r.children[0]).toBe(r.icon)
        expect(r.children[1]).toBe(r.span)
        expect(r.disabled).toBe(false)
      }
    })
  })

  it.each(['hu', 'en'] as const)('the board card breakdown (%s): the error, and a server error still wins', async (lang) => {
    async function run(fetchImpl: () => Promise<unknown>) {
      const toasts: string[] = []
      const btn = { disabled: false, textContent: '⚡' }
      const handler = new Function(
        'document', 'CSS', 'fetch', 't', 'showToast', 'showBreakdownModal',
        'breakdownMode', 'breakdownCardId', 'breakdownSubtasks', `return ${TRIGGER}`,
      )(
        { querySelector: () => btn }, { escape: (s: string) => s }, fetchImpl, makeT(lang),
        (m: string) => { toasts.push(m) }, () => {}, null, null, null,
      ) as (card: { id: string }) => Promise<void>
      await handler({ id: 'c1' })
      return toasts
    }
    expect(await run(reply(500, {}))).toEqual([errorText(lang)])
    expect(await run(throws)).toEqual([errorText(lang)])
    expect(await run(reply(500, { error: 'No model' }))).toEqual(['No model'])
  })

  it.each(['hu', 'en'] as const)('the idea breakdown (%s): no subtasks, the error, and a server error still wins', async (lang) => {
    async function run(fetchImpl: () => Promise<unknown>) {
      const toasts: string[] = []
      const handler = new Function(
        'ideas', 'kanbanAssignees', 'fetch', 'showToast', 't', 'document', 'showBreakdownModal',
        'breakdownMode', 'breakdownIdeaId', 'breakdownSubtasks', `return ${IDEA}`,
      )(
        [{ id: 7, title: 'Idea' }], [{ name: 'anna' }], fetchImpl, (m: string) => { toasts.push(m) }, makeT(lang),
        { getElementById: () => null }, () => {}, null, null, null,
      ) as (id: number) => Promise<void>
      await handler(7)
      // The first toast is the "AI is elaborating" notice, already a key.
      return toasts.slice(1)
    }
    expect(await run(reply(200, { subtasks: [] }))).toEqual([makeT(lang)('ideas.toast.no_subtasks')])
    expect(await run(reply(200, { subtasks: [] }))).toEqual([lang === 'hu' ? 'Az AI nem adott vissza részfeladatot' : 'AI returned no subtasks'])
    expect(await run(reply(500, {}))).toEqual([errorText(lang)])
    expect(await run(throws)).toEqual([errorText(lang)])
    expect(await run(reply(500, { error: 'No model' }))).toEqual(['No model'])
  })

  it.each([
    ['kanban', 'hu'], ['kanban', 'en'], ['idea', 'hu'], ['idea', 'en'],
  ] as const)('accepting the subtasks (%s, %s): a refusal without a server error reads "error while saving"', async (mode, lang) => {
    async function run(fetchImpl: () => Promise<unknown>) {
      const toasts: string[] = []
      const item = {
        dataset: { idx: '0' },
        querySelector: (sel: string) => (sel === '.breakdown-check' ? { checked: true } : { value: sel === '.breakdown-title-input' ? 'Sub' : '' }),
      }
      const handler = new Function(
        'document', 'breakdownSubtasks', 'showToast', 't', 'breakdownMode', 'breakdownIdeaId', 'breakdownCardId',
        'fetch', 'closeModal', 'breakdownOverlay', 'cardDetailOverlay', 'loadIdeasPage', 'loadKanban', `return ${ACCEPT}`,
      )(
        { querySelectorAll: () => [item], getElementById: () => null }, [{ title: 'Sub', priority: 'normal' }],
        (m: string) => { toasts.push(m) }, makeT(lang), mode, 7, 'c1', fetchImpl, () => {}, {}, {}, () => {}, () => {},
      ) as () => Promise<void>
      await handler()
      return toasts
    }
    expect(await run(reply(400, {}))).toEqual([makeT(lang)('common.error_save')])
    expect(await run(reply(400, { error: 'Card is closed' }))).toEqual(['Card is closed'])
  })

  it.each([
    ['hu', 'Bele', 'Nincs hozzárendelve'],
    ['en', 'Include', 'Unassigned'],
  ] as const)('the breakdown modal labels its checkbox and its empty assignee in the dashboard language (%s)', (lang, include, unassigned) => {
    const rows: Array<{ innerHTML: string }> = []
    const list = { innerHTML: '', appendChild: (r: { innerHTML: string }) => { rows.push(r) } }
    const showBreakdownModal = new Function(
      'document', 't', 'kanbanAssignees', 'escapeHtml', 'openModal', 'breakdownOverlay', `return ${MODAL}`,
    )(
      {
        getElementById: (id: string) => (id === 'breakdownList' ? list : { textContent: '' }),
        createElement: () => ({ className: '', dataset: {}, style: {}, innerHTML: '', querySelector: () => ({ value: '' }) }),
      },
      makeT(lang), [{ name: 'anna' }], (s: string) => String(s), () => {}, {},
    ) as (subtasks: unknown[], parent: { title: string }) => void
    showBreakdownModal([{ title: 'Sub', priority: 'normal' }], { title: 'Card' })
    expect(rows).toHaveLength(1)
    expect(rows[0].innerHTML).toContain(`checked> ${include}`)
    expect(rows[0].innerHTML).toContain(`<option value="">${unassigned}</option>`)
    expect(rows[0].innerHTML).not.toContain('-- nincs --')
  })
})
