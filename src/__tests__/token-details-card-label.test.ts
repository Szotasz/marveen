// DBSIZE1111 step 2: the Token Monitor details row shows the card from taskCards (read-time attribution), not
// the stored task_title. One card -> its title; overlapping cards -> all of them plus a tooltip that says the
// call does not tell which one; none -> no label. The real render code is sliced out of web/app.js and run in a
// vm with a fake document.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const APP_JS = readFileSync(join(ROOT, 'web', 'app.js'), 'utf-8')
const a = APP_JS.indexOf('let tuDetailData = []')
const b = APP_JS.indexOf('function renderTuDetails(data)', a)
if (a < 0 || b < 0) throw new Error('render markers not found in web/app.js')
const SLICE = APP_JS.slice(a, b)

function render(rows: unknown[]): string {
  const tbody = { innerHTML: '' }
  const ctx: Record<string, unknown> = {
    document: { getElementById: (id: string) => (id === 'tuDetailsTbody' ? tbody : id === 'tuDetailsCount' ? { textContent: '' } : null) },
    t: (k: string, p?: Record<string, unknown>) => `${k}${p ? JSON.stringify(p) : ''}`,
    escapeHtml: (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    tuFormatLocalDate: () => 'T',
    tuGetColor: () => '#000',
    tuFormatTokens: (n: number) => String(n),
    ROWS: rows,
  }
  vm.createContext(ctx)
  vm.runInContext(`${SLICE}\ntuDetailData = ROWS; renderTuDetailsTable()`, ctx)
  return tbody.innerHTML
}

const base = { timestamp: 1, agent: 'samu', input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 }

describe('Token Monitor details: the card label (DBSIZE1111)', () => {
  it('one card: its title, no overlap tooltip', () => {
    const html = render([{ ...base, taskCards: [{ id: 'c1', title: 'Fix the router' }], taskTitle: 'Fix the router' }])
    expect(html).toContain('[Fix the router]')
    expect(html).not.toContain('tokenUsage.cards_overlap')
  })

  it('overlapping cards: all titles and the tooltip that says none was picked', () => {
    const html = render([{ ...base, taskCards: [{ id: 'c1', title: 'First' }, { id: 'c2', title: 'Second' }], taskTitle: null }])
    expect(html).toContain('[First / Second]')
    expect(html).toContain('tokenUsage.cards_overlap')
    expect(html).toContain('&quot;n&quot;:2')
  })

  it('no card: no label, and a stale stored task_title is not shown', () => {
    const html = render([{ ...base, taskCards: [], taskTitle: null, task_title: 'stale' }])
    expect(html).not.toContain('[')
    expect(html).not.toContain('stale')
  })

  it('a card title is escaped', () => {
    const html = render([{ ...base, taskCards: [{ id: 'c1', title: '<b>x</b>' }] }])
    expect(html).toContain('[&lt;b&gt;x&lt;/b&gt;]')
    expect(html).not.toContain('<b>x</b>')
  })
})
