// The Kanban card detail speaks the dashboard language in two more places. The assignee showed a
// hardcoded "-- nincs --" (in English too), while the project and the dates next to it already used
// kanban.meta.none ("-- none --"). And the "add existing label" picker read "-- -- Meglévő címke
// hozzáadása -- --" / "-- -- Add existing label -- --": the key already carries its dashes (index.html
// shows it as is) and app.js wrapped it in a second pair.
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

// A top-level function, up to its closing brace at column 0.
function fn(name: string): string {
  const i = APP.indexOf(`\nasync function ${name}(`)
  return i < 0 ? '' : APP.slice(i + 1, APP.indexOf('\n}\n', i) + 2)
}
const LABELS = fn('renderCardLabelsSection')
const DETAIL = fn('showCardDetail')

// An element that takes any property and any method call.
function fakeEl(): Record<string, unknown> {
  const store: Record<string, unknown> = { innerHTML: '', style: { setProperty() {} } }
  return new Proxy(store, {
    get: (o, k: string) => (k in o ? o[k] : (k === 'querySelector' ? () => fakeEl() : () => {})),
    set: (o, k: string, v) => { o[k] = v; return true },
  })
}

describe('the Kanban card detail', () => {
  it('no hardcoded "-- nincs --" is left in app.js, in any case', () => {
    const code = APP.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
    expect(code).not.toMatch(/-- nincs --/i)
  })

  it.each([
    ['hu', '-- nincs --'],
    ['en', '-- none --'],
  ] as const)('the assignee pickers (new or edited card, and the inline editor) offer "none" in the dashboard language (%s)', (lang, want) => {
    const start = APP.indexOf('\nfunction populateAssigneeSelect(')
    const src = APP.slice(start + 1, APP.indexOf('\n}\n', start) + 2)
    const sel: { innerHTML: string; value: string; appendChild: (o: unknown) => void } = { innerHTML: '', value: '', appendChild: () => {} }
    const populate = new Function('document', 'kanbanAssignees', 'escapeHtml', 't', `${src}\nreturn populateAssigneeSelect`)(
      { getElementById: () => sel, createElement: () => ({}) }, [{ name: 'anna' }], (s: string) => String(s), makeT(lang),
    ) as (id: string, selected?: string) => void
    populate('cardAssignee')
    expect(sel.innerHTML).toBe(`<option value="">${want}</option>`)
    expect(DETAIL).toContain("sel.innerHTML = `<option value=\"\">${escapeHtml(t('kanban.meta.none'))}</option>`")
  })

  it('the assignee falls back to kanban.meta.none everywhere in the card detail, like the project and dates', () => {
    expect(DETAIL).not.toBe('')
    expect(DETAIL).toContain("(rawDetailAssignee || t('kanban.meta.none'))")
    // The inline assignee editor: no change, a stale version, saved, a failed save, and blur.
    expect(DETAIL.match(/assigneeValueEl\.textContent = [^\n]*t\('kanban\.meta\.none'\)/g)).toHaveLength(5)
    expect(makeT('hu')('kanban.meta.none')).toBe('-- nincs --')
    expect(makeT('en')('kanban.meta.none')).toBe('-- none --')
  })

  it.each([
    ['hu', '-- Meglévő címke hozzáadása --'],
    ['en', '-- Add existing label --'],
  ] as const)('the "add existing label" picker shows its placeholder with one pair of dashes (%s)', async (lang, want) => {
    expect(LABELS).not.toBe('')
    const els: Record<string, Record<string, unknown>> = {}
    const renderCardLabelsSection = new Function(
      'document', 'fetch', 'escapeHtml', 't', 'kanbanAllLabels', 'safeCssColor', 'loadKanban', 'showToast', 'window',
      `${LABELS}\nreturn renderCardLabelsSection`,
    )(
      { getElementById: (id: string) => (els[id] ||= fakeEl()), createElement: () => fakeEl() },
      async () => ({ json: async () => [] }), (s: string) => String(s), makeT(lang), [], (c: string) => c, () => {}, () => {}, {},
    ) as (card: { id: string }) => Promise<void>
    await renderCardLabelsSection({ id: 'c1' })
    expect(els.cardLabelAdd.innerHTML).toBe(`<option value="">${want}</option>`)
    expect(els.cardLabelAdd.innerHTML).not.toMatch(/-- --/)
  })
})
