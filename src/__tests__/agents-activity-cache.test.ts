// GET /api/agents/activity shares one computed answer between callers for 2 s.
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PROJECT_ROOT } from '../config.js'
import { MAIN_CHANNELS_SESSION } from '../web/main-agent.js'
import type { RouteContext } from '../web/routes/types.js'

const SEP = '─'.repeat(80)
const IDLE = ['', SEP, '❯ ', SEP, '  ⏵⏵ bypass permissions on · ↓ to manage'].join('\n')

const paneCalls = new Map<string, number>()
let paneText = IDLE
let captureCostMs = 0

vi.mock('../web/agent-process.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../web/agent-process.js')>()
  return {
    ...actual,
    agentSessionName: (n: string) => `agent-${n}`,
    agentRunState: () => 'running',
    isAgentRunning: () => true,
    capturePane: (session: string) => {
      paneCalls.set(session, (paneCalls.get(session) ?? 0) + 1)
      if (captureCostMs > 0) vi.setSystemTime(Date.now() + captureCostMs)
      return paneText
    },
    paneCurrentCommand: () => 'claude',
  }
})

vi.mock('../web/agent-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../web/agent-config.js')>()
  return {
    ...actual,
    listAgentNames: () => ['alpha', 'beta'],
    readAgentRemoteHost: () => null,
  }
})

const { tryHandleAgents, resetAgentsActivityCacheForTests } = await import('../web/routes/agents.js')

type Entry = { name: string; state: string; tail: string[] }

async function getActivity(): Promise<Entry[]> {
  let raw = ''
  const res = {
    writeHead() { return res },
    end(chunk?: string | Buffer) { if (chunk) raw = String(chunk) },
  }
  const url = new URL('http://localhost:3420/api/agents/activity')
  const ctx = { req: { headers: {} } as RouteContext['req'], res, path: url.pathname, method: 'GET', url } as unknown as RouteContext
  expect(await tryHandleAgents(ctx, join(PROJECT_ROOT, 'web'))).toBe(true)
  return JSON.parse(raw) as Entry[]
}

const total = () => [...paneCalls.values()].reduce((a, b) => a + b, 0)
const T0 = new Date('2026-01-01T00:00:00Z').getTime()

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
  paneCalls.clear()
  paneText = IDLE
  captureCostMs = 0
  resetAgentsActivityCacheForTests()
})

afterEach(() => { vi.useRealTimers() })

describe('GET /api/agents/activity cache', () => {
  it('C1 two GETs at the same time compute once', async () => {
    const a = await getActivity()
    const b = await getActivity()
    expect(b).toEqual(a)
    expect(paneCalls.get(MAIN_CHANNELS_SESSION)).toBe(1)
    expect(paneCalls.get('agent-alpha')).toBe(1)
    expect(paneCalls.get('agent-beta')).toBe(1)
    expect(total()).toBe(3)
  })

  it('C2 served from cache until 2000 ms have passed', async () => {
    await getActivity()
    vi.setSystemTime(T0 + 1999)
    await getActivity()
    expect(total()).toBe(3)
    vi.setSystemTime(T0 + 2000)
    await getActivity()
    expect(total()).toBe(6)
  })

  it('C3 a clock that moved backwards recomputes', async () => {
    await getActivity()
    vi.setSystemTime(T0 - 5000)
    await getActivity()
    expect(total()).toBe(6)
  })

  it('C4 reset drops the cache', async () => {
    await getActivity()
    resetAgentsActivityCacheForTests()
    await getActivity()
    expect(total()).toBe(6)
  })

  it('C5 a changed pane shows up after the TTL', async () => {
    const first = await getActivity()
    paneText = ['working on the thing', '✻ Pondering… (12s · esc to interrupt)'].join('\n')
    vi.setSystemTime(T0 + 2500)
    const second = await getActivity()
    expect(second).not.toEqual(first)
    expect(second.find(e => e.name === 'alpha')?.tail).toContain('working on the thing')
  })

  it('C6 the TTL counts from the end of a slow compute', async () => {
    captureCostMs = 1000
    await getActivity()
    expect(Date.now()).toBe(T0 + 3000)
    vi.setSystemTime(T0 + 3000 + 1999)
    captureCostMs = 0
    await getActivity()
    expect(total()).toBe(3)
  })
})
