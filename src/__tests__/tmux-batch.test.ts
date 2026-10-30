// withTmuxBatch: per-call memo for read-only tmux queries. execFileSync is faked,
// so no tmux server is touched.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const calls: string[][] = []
let table: Record<string, string | { status: number }> = {}
const RUN_AS: Record<string, string> = {}

function fake(file: string, args: string[]): string {
  calls.push([file, ...args])
  const joined = args.includes('list-sessions') ? 'list-sessions' : args.includes('list-panes') ? (args.includes('-a') ? 'list-panes-a' : 'list-panes-t') : 'other'
  const hit = table[joined]
  if (hit === undefined) return ''
  if (typeof hit === 'object') {
    const e = new Error('tmux failed') as Error & { status: number }
    e.status = hit.status
    throw e
  }
  return hit
}

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execFileSync: (file: string, args: string[]) => fake(file, args) }
})

vi.mock('../web/agent-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../web/agent-config.js')>()
  return {
    ...actual,
    readAgentRemoteHost: () => null,
    readAgentRunAsUser: (n: string) => RUN_AS[n] ?? null,
    listAgentNames: () => ['alpha', 'beta', 'gamma'],
  }
})

const { agentRunState, paneCurrentCommand, withTmuxBatch } = await import('../web/agent-process.js')

const LS = (c: string[]) => c.includes('list-sessions')
const ALL_ARGS = ['list-panes', '-a', '-F', '#{session_name}\t#{window_active}\t#{pane_current_command}']
const states = () => ['alpha', 'beta', 'gamma'].map(n => agentRunState(n))

// The run-as map behind resolveTarget is cached for 5 s, and RUN_AS changes between tests. Each
// test gets a clock 10 s past the previous one, so the map is always rebuilt from this test's
// RUN_AS -- whatever the wall clock does on a slow run.
let clock = Date.UTC(2026, 0, 1)

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  clock += 10_000
  vi.setSystemTime(clock)
  calls.length = 0
  table = {}
  for (const k of Object.keys(RUN_AS)) delete RUN_AS[k]
})

afterEach(() => { vi.useRealTimers() })

describe('withTmuxBatch', () => {
  it('T1 outside a batch every agentRunState runs list-sessions', () => {
    table['list-sessions'] = 'agent-alpha\nagent-gamma\n'
    expect(states()).toEqual(['running', 'stopped', 'running'])
    expect(calls.filter(LS)).toHaveLength(3)
  })

  it('T2 inside a batch list-sessions runs once', () => {
    table['list-sessions'] = 'agent-alpha\nagent-gamma\n'
    expect(withTmuxBatch(states)).toEqual(['running', 'stopped', 'running'])
    expect(calls.filter(LS)).toHaveLength(1)
  })

  it('T3 a failing list-sessions is memoized too', () => {
    table['list-sessions'] = { status: 1 }
    expect(withTmuxBatch(states)).toEqual(['stopped', 'stopped', 'stopped'])
    expect(calls.filter(LS)).toHaveLength(1)
  })

  it('T4 agents with different run-as users get their own list-sessions', () => {
    RUN_AS.alpha = 'svc-one'
    RUN_AS.beta = 'svc-two'
    table['list-sessions'] = 'agent-alpha\nagent-gamma\n'
    expect(withTmuxBatch(states)).toEqual(['running', 'stopped', 'running'])
    const ls = calls.filter(LS)
    expect(ls).toHaveLength(3)
    const sudo = ls.filter(c => c[0] === 'sudo')
    expect(sudo).toHaveLength(2)
    expect(sudo.map(c => c.slice(1, 4)).sort()).toEqual([['-n', '-u', 'svc-one'], ['-n', '-u', 'svc-two']])
  })

  it('T5 outside a batch paneCurrentCommand uses list-panes -t', () => {
    table['list-panes-t'] = '\n  claude \nbash\n'
    expect(paneCurrentCommand('agent-alpha')).toBe('claude')
    expect(calls).toHaveLength(1)
    expect(calls[0].slice(-5)).toEqual(['list-panes', '-t', '=agent-alpha:', '-F', '#{pane_current_command}'])
  })

  it('T6 inside a batch one list-panes -a answers every session', () => {
    table['list-panes-a'] = 'agent-alpha\t0\tbash\nagent-alpha\t1\tclaude\nagent-beta\t1\tnode\nagent-empty\t1\t\n'
    const r = withTmuxBatch(() => [
      paneCurrentCommand('agent-alpha'),
      paneCurrentCommand('agent-beta'),
      paneCurrentCommand('agent-zeta'),
      paneCurrentCommand('agent-empty'),
    ])
    expect(r).toEqual(['claude', 'node', null, null])
    expect(calls).toHaveLength(1)
    expect(calls[0].slice(-ALL_ARGS.length)).toEqual(ALL_ARGS)
  })

  it('T12 a target that names a window keeps the unbatched query', () => {
    table['list-panes-t'] = 'node\n'
    table['list-panes-a'] = 'agent-alpha\t1\tclaude\n'
    expect(withTmuxBatch(() => paneCurrentCommand('agent-alpha:1'))).toBe('node')
    expect(calls).toHaveLength(1)
    expect(calls[0].slice(-5)).toEqual(['list-panes', '-t', '=agent-alpha:1', '-F', '#{pane_current_command}'])
  })

  it('T7 a failing list-panes -a gives null for all, one call', () => {
    table['list-panes-a'] = { status: 1 }
    const r = withTmuxBatch(() => [paneCurrentCommand('agent-alpha'), paneCurrentCommand('agent-beta')])
    expect(r).toEqual([null, null])
    expect(calls).toHaveLength(1)
  })

  it('T8 the memo ends with the batch, also when fn throws', () => {
    table['list-sessions'] = 'agent-alpha\n'
    withTmuxBatch(() => agentRunState('alpha'))
    expect(calls.filter(LS)).toHaveLength(1)
    agentRunState('alpha')
    expect(calls.filter(LS)).toHaveLength(2)
    expect(() => withTmuxBatch(() => { agentRunState('alpha'); throw new Error('boom') })).toThrow('boom')
    expect(calls.filter(LS)).toHaveLength(3)
    agentRunState('alpha')
    expect(calls.filter(LS)).toHaveLength(4)
  })

  it('T9 a nested batch does not clear the outer memo', () => {
    table['list-sessions'] = 'agent-alpha\n'
    withTmuxBatch(() => {
      agentRunState('alpha')
      withTmuxBatch(() => agentRunState('beta'))
      agentRunState('gamma')
    })
    expect(calls.filter(LS)).toHaveLength(1)
  })

  it('T10 an async fn is rejected and leaves no memo behind', () => {
    table['list-sessions'] = 'agent-alpha\n'
    expect(() => withTmuxBatch(() => Promise.resolve(1))).toThrow(TypeError)
    agentRunState('alpha')
    agentRunState('alpha')
    expect(calls.filter(LS)).toHaveLength(2)
  })

  it('T10b a rejecting async fn is refused without leaving an unhandled rejection', async () => {
    expect(() => withTmuxBatch(() => Promise.reject(new Error('late')))).toThrow(TypeError)
    await new Promise(r => setTimeout(r, 0))
  })

  it('T11 a nested async fn is rejected too, and the outer batch still clears', () => {
    table['list-sessions'] = 'agent-alpha\n'
    expect(() => withTmuxBatch(() => {
      void withTmuxBatch(async () => 1)
      return 'ok'
    })).toThrow(TypeError)
    agentRunState('alpha')
    agentRunState('alpha')
    expect(calls.filter(LS)).toHaveLength(2)
  })
})
