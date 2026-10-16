// GET /api/agents/activity must carry each entry's background-agent count
// (`bgAgents`) computed from that entry's own pane. The detector itself is
// covered in pane-background-agents.test.ts; this file pins the WIRING: a
// route that dropped the field, or always sent null, would leave every
// detector test green while the dashboard never showed "sub-agents working".
//
// The pane reads and the agent list are mocked, so no tmux session is touched.
// Agent names are neutral fixtures.
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { PROJECT_ROOT } from '../config.js'
import { MAIN_CHANNELS_SESSION } from '../web/main-agent.js'
import type { RouteContext } from '../web/routes/types.js'

const SEP = '─'.repeat(80)

// Idle main thread with two running background agents below the footer
// (shape from pane-background-agents.test.ts, a real capture with neutral labels).
const IDLE_WITH_AGENTS = [
  '✻ Waiting for 2 background agents to finish',
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on · 1 shell, 1 monitor · ↓ to manage',
  '',
  '  ⏺ main',
  '  ◯ general-purpose  First task 17m 23s · ↓ 171.9k tokens · 1 queued',
  '  ◯ general-purpose  Second task 16m 30s · ↓ 319.7k tokens',
].join('\n')

// Plain idle footer, no agent block.
const IDLE_PLAIN = ['', SEP, '❯ ', SEP, '  ⏵⏵ bypass permissions on · ↓ to manage'].join('\n')

const PANES: Record<string, string> = {
  [MAIN_CHANNELS_SESSION]: IDLE_PLAIN,
  'agent-agentone': IDLE_WITH_AGENTS,
  'agent-agenttwo': IDLE_PLAIN,
}

vi.mock('../web/agent-process.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../web/agent-process.js')>()
  return {
    ...actual,
    agentSessionName: (n: string) => `agent-${n}`,
    agentRunState: () => 'running',
    isAgentRunning: () => true,
    capturePane: (session: string) => PANES[session] ?? null,
  }
})

vi.mock('../web/agent-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../web/agent-config.js')>()
  return {
    ...actual,
    listAgentNames: () => ['agentone', 'agenttwo'],
    readAgentRemoteHost: () => null,
  }
})

const { tryHandleAgents } = await import('../web/routes/agents.js')

type Entry = { name: string; isMain: boolean; state: string; bgAgents: { total: number; running: number; queued: number } | null }

async function getActivity(): Promise<Entry[]> {
  let raw = ''
  const res = {
    writeHead() { return res },
    end(chunk?: string | Buffer) { if (chunk) raw = String(chunk) },
  }
  const url = new URL('http://localhost:3420/api/agents/activity')
  const ctx = { req: { headers: {} } as RouteContext['req'], res, path: url.pathname, method: 'GET', url } as unknown as RouteContext
  const handled = await tryHandleAgents(ctx, join(PROJECT_ROOT, 'web'))
  expect(handled).toBe(true)
  return JSON.parse(raw) as Entry[]
}

describe('GET /api/agents/activity carries bgAgents from each pane', () => {
  it('an idle agent with a background-agent block gets its counts', async () => {
    const one = (await getActivity()).find(e => e.name === 'agentone')
    expect(one?.state).toBe('idle')
    expect(one?.bgAgents).toEqual({ total: 2, running: 2, queued: 1 })
  })

  it('an agent without a block gets null, not a zero count', async () => {
    const two = (await getActivity()).find(e => e.name === 'agenttwo')
    expect(two?.state).toBe('idle')
    expect(two?.bgAgents).toBeNull()
  })

  it('the main agent entry carries the field too', async () => {
    const main = (await getActivity()).find(e => e.isMain)
    expect(main).toBeDefined()
    expect(main).toHaveProperty('bgAgents', null)
  })
})
