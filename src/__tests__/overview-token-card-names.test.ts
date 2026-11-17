// Overview token card: each row shows the agent's display name, not its id.
// Sub-agent names come from /api/agents (displayName, falling back to the id);
// the main agent is not in that list and goes through mainAgentDisplayName().
// The id stays in the row's title attribute. A failed /api/agents only costs
// the names, never the card. The real function is sliced out of web/app.js and
// run in a vm with a fake document and a fake fetch.
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

const SUMMARY = [
  { agent: 'main-bot', totalCalls: 4, totalInput: 10, totalCacheRead: 900, totalCacheCreation: 0, totalOutput: 90 },
  { agent: 'dev-1', totalCalls: 2, totalInput: 5, totalCacheRead: 400, totalCacheCreation: 0, totalOutput: 95 },
  { agent: 'qa-1', totalCalls: 1, totalInput: 1, totalCacheRead: 10, totalCacheCreation: 0, totalOutput: 9 },
]

async function render(agents: unknown, agentsOk = true): Promise<string> {
  const box = { innerHTML: '' }
  const document = { getElementById: (id: string) => (id === 'overviewTokens' ? box : null) }
  const json = (body: unknown, ok = true) => Promise.resolve({ ok, status: ok ? 200 : 500, json: () => Promise.resolve(body) })
  const ctx: Record<string, unknown> = {
    document,
    Date,
    Math,
    Map,
    Array,
    fetch: (url: string) => {
      if (url.startsWith('/api/token-usage/collect')) return json({ ok: true })
      if (url.startsWith('/api/token-usage/summary')) return json(SUMMARY)
      if (url === '/api/agents') return agents instanceof Error ? Promise.reject(agents) : json(agents, agentsOk)
      throw new Error('unexpected fetch ' + url)
    },
    t: (k: string, p?: Record<string, unknown>) => (p ? `${k}${JSON.stringify(p)}` : k),
    escapeHtml: (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    tuFormatTokens: (n: number) => String(n),
    mainAgentId: () => 'main-bot',
    mainAgentDisplayName: () => 'Main Bot',
    switchPage: () => {},
  }
  vm.createContext(ctx)
  vm.runInContext(
    slice(APP_JS, '// === Overview: token usage card', 'async function loadOverview()') +
      'globalThis.__load = loadOverviewTokens',
    ctx,
  )
  await (ctx.__load as () => Promise<void>)()
  return box.innerHTML
}

const names = (html: string) => [...html.matchAll(/class="overview-token-name" title="([^"]*)">([^<]*)</g)].map((m) => [m[1], m[2]])

describe('overview token card: display names', () => {
  it('shows display names, the main agent via mainAgentDisplayName, and keeps the id in the title', async () => {
    const html = await render([
      { name: 'dev-1', displayName: 'Developer' },
      { name: 'qa-1' }, // no displayName -> its id
    ])
    expect(names(html)).toEqual([
      ['main-bot', 'Main Bot'],
      ['dev-1', 'Developer'],
      ['qa-1', 'qa-1'],
    ])
  })

  it('falls back to the ids when /api/agents fails, and still renders the card', async () => {
    for (const html of [await render(new Error('network')), await render([], false)]) {
      expect(names(html)).toEqual([
        ['main-bot', 'Main Bot'],
        ['dev-1', 'dev-1'],
        ['qa-1', 'qa-1'],
      ])
      expect(html).toContain('overview.tokens.total')
    }
  })

  it('escapes a display name', async () => {
    const html = await render([{ name: 'dev-1', displayName: '<b>x</b>' }])
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;')
    expect(html).not.toContain('<b>x</b>')
  })
})
