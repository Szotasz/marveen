// An agent deleted from its detail window stayed on the team graph until F5: the delete button only reloaded the card
// grid (loadAgents), while the same window opens from the overview card and the Agents page tree view too. And the
// handler never read the reply, so a refused delete (403 owner_session_required) still said "deleted" in green and
// closed the window. Both are run here, not only matched as text.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const APP = readFileSync(new URL('../../web/app.js', import.meta.url), 'utf-8')

const ANCHOR = "document.getElementById('deleteAgentBtn').onclick = "
function deleteHandlerSrc(): string {
  const i = APP.indexOf(ANCHOR)
  if (i < 0) return ''
  const start = i + ANCHOR.length
  const end = APP.indexOf('\n  }\n', start)
  return end < 0 ? '' : APP.slice(start, end + 4)
}
function fnSrc(name: string): string {
  const i = APP.indexOf(`function ${name}(`)
  const end = i < 0 ? -1 : APP.indexOf('\n}\n', i)
  return i < 0 || end < 0 ? '' : APP.slice(i, end + 2)
}

type Reply = { ok: boolean; status: number; json: () => Promise<unknown> }
async function runDelete(opts: { confirmed?: boolean; reply?: Reply; throws?: boolean }) {
  const log: string[] = []
  const deps = {
    currentAgent: { name: 'tete' },
    agentDetailOverlay: {},
    t: (k: string, p?: Record<string, unknown>) => (p ? `${k} ${JSON.stringify(p)}` : k),
    confirmDialog: async () => opts.confirmed ?? true,
    fetch: async (url: string, init: { method: string }) => {
      log.push(`fetch ${init.method} ${url}`)
      if (opts.throws) throw new Error('network')
      return opts.reply
    },
    showToast: (msg: string, kind?: unknown) => { log.push(`toast ${kind ?? 'neutral'} ${msg}`) },
    closeModal: () => { log.push('closeModal') },
    loadAgents: () => { log.push('loadAgents') },
    refreshVisibleTeamGraphs: () => { log.push('refreshVisibleTeamGraphs') },
    refusalReason: (r: { status: number }, body: { error?: string }) => body.error || `HTTP ${r.status}`,
  }
  const readActionReply = new Function(`async ${fnSrc('readActionReply')}; return readActionReply`)()
  const names = Object.keys(deps)
  const handler = new Function(...names, 'readActionReply', `return ${deleteHandlerSrc()}`)(
    ...names.map(n => deps[n as keyof typeof deps]), async (res: Reply) => readActionReply(res),
  )
  await handler()
  return log
}

describe('the agent delete button reads the reply and redraws the team graph', () => {
  it('the handler and the helper are found', () => {
    expect(deleteHandlerSrc()).toContain('async () => {')
    expect(fnSrc('refreshVisibleTeamGraphs')).toContain('loadTeamGraph()')
  })

  it('a delete that went through closes the window, says so in green and redraws the grid and the graph', async () => {
    const log = await runDelete({ reply: { ok: true, status: 200, json: async () => ({ ok: true }) } })
    expect(log).toEqual([
      'fetch DELETE /api/agents/tete',
      'closeModal',
      'toast success agents.toast.deleted',
      'loadAgents',
      'refreshVisibleTeamGraphs',
    ])
  })

  it('a refused delete keeps the window open and says why in red, with nothing redrawn', async () => {
    const log = await runDelete({ reply: { ok: false, status: 403, json: async () => ({ error: 'owner session required' }) } })
    expect(log).toEqual([
      'fetch DELETE /api/agents/tete',
      'toast error common.not_done {"msg":"owner session required"}',
    ])
  })

  it('a network error keeps the window open with the delete error', async () => {
    const log = await runDelete({ throws: true })
    expect(log).toEqual(['fetch DELETE /api/agents/tete', 'toast error common.error_delete'])
  })

  it('"no" sends nothing', async () => {
    expect(await runDelete({ confirmed: false })).toEqual([])
  })
})

describe('refreshVisibleTeamGraphs redraws only the graph on screen', () => {
  function run(visible: { overview: boolean; agents: boolean }, view: string) {
    const log: string[] = []
    const document = {
      getElementById: (id: string) =>
        id === 'overviewPage' ? { hidden: !visible.overview } : id === 'agentsPage' ? { hidden: !visible.agents } : null,
    }
    new Function('document', '_agentsActiveView', 'loadOverview', 'loadTeamGraph', `${fnSrc('refreshVisibleTeamGraphs')}; refreshVisibleTeamGraphs()`)(
      document, view, () => log.push('loadOverview'), () => log.push('loadTeamGraph'),
    )
    return log
  }

  it('the overview: the whole overview, so its agent count and its team card both follow', () => {
    expect(run({ overview: true, agents: false }, 'grid')).toEqual(['loadOverview'])
  })

  it('the Agents page in tree view: the tree', () => {
    expect(run({ overview: false, agents: true }, 'tree')).toEqual(['loadTeamGraph'])
  })

  it('the Agents page in card view: nothing more (loadAgents already redraws the cards)', () => {
    expect(run({ overview: false, agents: true }, 'grid')).toEqual([])
    expect(run({ overview: false, agents: true }, 'activity')).toEqual([])
  })

  it('another page: nothing (switching back loads it fresh)', () => {
    expect(run({ overview: false, agents: false }, 'tree')).toEqual([])
  })
})
