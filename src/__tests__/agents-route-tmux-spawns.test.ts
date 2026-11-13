// Counts the REAL tmux invocations of the agents read paths (agent-process is not mocked).
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAIN_AGENT_ID, PROJECT_ROOT } from '../config.js'
import { MAIN_CHANNELS_SESSION } from '../web/main-agent.js'
import type { RouteContext } from '../web/routes/types.js'

const SEP = '─'.repeat(80)
const IDLE_PLAIN = ['', SEP, '❯ ', SEP, '  ⏵⏵ bypass permissions on · ↓ to manage'].join('\n')

const SESSIONS = [MAIN_CHANNELS_SESSION, 'agent-alpha', 'agent-beta', 'agent-gamma']
const calls: string[][] = []
let panes: Record<string, string> = {}
let timeoutBatch = false
let runAs = false
let remote = false
let clock = Date.UTC(2026, 0, 1)

function fake(file: string, args: string[]): string {
  calls.push([file, ...args])
  if (args.some(a => a.includes('list-sessions'))) return SESSIONS.join('\n') + '\n'
  if (args.some(a => a.includes('list-panes'))) {
    return args.includes('-a') ? SESSIONS.map(s => `${s}\t1\tclaude`).join('\n') : 'claude\n'
  }
  if (args.includes('capture-pane') || file === 'ssh' && args.at(-1)?.includes('capture-pane')) {
    if (timeoutBatch && args.includes(';')) throw new Error('timeout')
    const commands: string[][] = [[]]
    for (const arg of args) {
      if (arg === ';') commands.push([])
      else commands.at(-1)!.push(arg)
    }
    let out = ''
    for (const command of commands) {
      if (command[0] === 'display-message') out += command[2] + '\n'
      else {
        const target = command[command.indexOf('-t') + 1]
        const session = file === 'ssh' ? 'agent-gamma' : target.slice(1, -1)
        if (!(session in panes)) throw Object.assign(new Error('missing session'), {
          status: 1, stdout: out, stderr: `can't find session: ${session}`,
        })
        out += panes[session]
      }
    }
    return out
  }
  return ''
}

const SANDBOX = mkdtempSync(join(tmpdir(), 'tmuxspawns-'))
for (const n of ['alpha', 'beta', 'gamma']) mkdirSync(join(SANDBOX, 'agents', n), { recursive: true })

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execFileSync: (file: string, args: string[]) => fake(file, args) }
})

vi.mock('../web/agent-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../web/agent-config.js')>()
  return {
    ...actual,
    listAgentNames: () => ['alpha', 'beta', 'gamma'],
    readAgentRemoteHost: (name: string) => remote && name === 'gamma' ? 'remote-box' : null,
    readAgentRunAsUser: (name: string) => runAs && name === 'gamma' ? 'svc-test' : null,
    agentDir: (name: string) => join(SANDBOX, 'agents', name),
  }
})

vi.mock('../web/ssh-tmux.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../web/ssh-tmux.js')>()
  return { ...actual, ensureControlDir: () => {} }
})

// The status route reads its kanban, message and tool rows from the database; no
// rows is enough here, only the tmux calls are counted.
vi.mock('../db.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db.js')>()
  return {
    ...actual,
    getAgentCurrentCards: () => ({}),
    getAgentMessageActivity: () => ({}),
    getAgentToolActivity: () => ({}),
  }
})

const { tryHandleAgents, listAgentSummaries, resetAgentsActivityCacheForTests } = await import('../web/routes/agents.js')

async function get(path: string): Promise<unknown> {
  let raw = ''
  const res = {
    writeHead() { return res },
    end(chunk?: string | Buffer) { if (chunk) raw = String(chunk) },
  }
  const url = new URL(`http://localhost:3420${path}`)
  const ctx = { req: { headers: {} } as RouteContext['req'], res, path: url.pathname, method: 'GET', url } as unknown as RouteContext
  const handled = await tryHandleAgents(ctx, join(PROJECT_ROOT, 'web'))
  expect(handled).toBe(true)
  return JSON.parse(raw)
}

const count = (sub: string) => calls.filter(c => c.includes(sub)).length

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  clock += 10_000
  vi.setSystemTime(clock)
  panes = Object.fromEntries(SESSIONS.map(s => [s, `${s} output\n\n${IDLE_PLAIN}\n\n`]))
  timeoutBatch = false
  runAs = false
  remote = false
  calls.length = 0
  resetAgentsActivityCacheForTests()
})

afterEach(() => vi.useRealTimers())

afterAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true })
})

function expectedActivity() {
  return [MAIN_AGENT_ID, 'alpha', 'beta', 'gamma'].map((name, i) => ({
    name, isMain: i === 0, running: true, state: 'idle', mode: 'bypass permissions', bgAgents: null,
    tail: [`${SESSIONS[i]} output`, SEP, '❯', SEP, '  ⏵⏵ bypass permissions on · ↓ to manage'],
  }))
}

function expectedStatus() {
  return [MAIN_AGENT_ID, 'alpha', 'beta', 'gamma'].map((agent, i) => ({
    agent, isMain: i === 0, running: true, state: 'idle',
    work: { kind: 'none', text: '', cardId: null }, sinceSec: null,
    lastSignalAgeSec: null, lastSignalSource: null, permissionMode: 'bypass permissions', toolCalls: null, degraded: true,
  }))
}

describe('tmux spawns of the agents read paths', () => {
  for (const endpoint of ['activity', 'status']) {
    it(`${endpoint}: preserves the individual-capture response in one capture invocation`, async () => {
      expect(await get(`/api/agents/${endpoint}`)).toEqual(endpoint === 'activity' ? expectedActivity() : expectedStatus())
      expect(count('list-sessions')).toBe(1)
      expect(count('list-panes')).toBe(1)
      expect(calls.find(c => c.includes('list-panes'))).toContain('-a')
      expect(count('capture-pane')).toBe(1)
    })

    it(`${endpoint}: stops at a vanished session and prefetches the remainder`, async () => {
      delete panes['agent-alpha']
      const expected = endpoint === 'activity' ? expectedActivity() : expectedStatus()
      Object.assign(expected[1], endpoint === 'activity'
        ? { state: 'unknown', mode: null, tail: [] }
        : { state: 'unknown', permissionMode: null })
      expect(await get(`/api/agents/${endpoint}`)).toEqual(expected)
      expect(count('capture-pane')).toBe(2)
    })

    it(`${endpoint}: a batch timeout falls back to four individual captures`, async () => {
      timeoutBatch = true
      expect(await get(`/api/agents/${endpoint}`)).toEqual(endpoint === 'activity' ? expectedActivity() : expectedStatus())
      expect(count('capture-pane')).toBe(5)
    })
  }

  it('preserves blank lines, trailing newlines and a marker with another nonce', async () => {
    const marker = '__marveen_capture_0123456789abcdef0123456789abcdef_2__'
    panes['agent-beta'] = `${marker}\n\n${IDLE_PLAIN}\n\n`
    const expected = expectedActivity()
    expected[2].tail[0] = marker
    expect(await get('/api/agents/activity')).toEqual(expected)
    expect(count('capture-pane')).toBe(1)
  })

  for (const kind of ['run-as', 'remote']) {
    it(`${kind} captures stay outside the local batch`, async () => {
      runAs = kind === 'run-as'
      remote = kind === 'remote'
      expect(await get('/api/agents/activity')).toEqual(expectedActivity())
      const batch = calls.find(c => c.includes(';'))!
      expect(batch).not.toContain('=agent-gamma:')
      const individual = calls.find(c => c[0] === (runAs ? 'sudo' : 'ssh') && c.some(a => a.includes('capture-pane')))
      expect(individual).toBeDefined()
      expect(individual).not.toContain(';')
    })
  }

  it('listAgentSummaries lists exactly once', () => {
    const rows = listAgentSummaries()
    expect(count('list-sessions')).toBe(1)
    expect(rows.map(r => r.name)).toEqual(expect.arrayContaining(['alpha', 'beta', 'gamma']))
  })

  it('a second activity request is served from the cache', async () => {
    await get('/api/agents/activity')
    await get('/api/agents/activity')
    expect(count('capture-pane')).toBe(1)
  })
})
