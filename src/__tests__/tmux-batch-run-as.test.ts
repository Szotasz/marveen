// withTmuxBatch with a fixed run-as table: one list-panes -a per tmux server.
// RUN_AS is fixed on purpose: agent-process caches the session -> user map for 5 s.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls: string[][] = []
const RUN_AS: Record<string, string> = { alpha: 'svc-one' }

function fake(file: string, args: string[]): string {
  calls.push([file, ...args])
  if (args.includes('list-panes') && args.includes('-a')) {
    if (file === 'sudo' && args.includes('svc-one')) return 'agent-alpha\t1\tclaude\n'
    return 'agent-beta\t1\tnode\nagent-gamma\t1\tbash\n'
  }
  return ''
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

const { paneCurrentCommand, withTmuxBatch } = await import('../web/agent-process.js')

const panes = () => calls.filter(c => c.includes('list-panes'))

beforeEach(() => {
  calls.length = 0
})

describe('withTmuxBatch with a run-as agent', () => {
  it('R1 one list-panes -a per tmux server', () => {
    const r = withTmuxBatch(() => [
      paneCurrentCommand('agent-alpha'),
      paneCurrentCommand('agent-beta'),
      paneCurrentCommand('agent-gamma'),
      paneCurrentCommand('agent-alpha'),
    ])
    expect(r).toEqual(['claude', 'node', 'bash', 'claude'])
    const lp = panes()
    expect(lp).toHaveLength(2)
    const sudo = lp.filter(c => c[0] === 'sudo')
    const plain = lp.filter(c => c[0] !== 'sudo')
    expect(sudo).toHaveLength(1)
    expect(sudo[0].slice(1, 4)).toEqual(['-n', '-u', 'svc-one'])
    expect(sudo[0]).toContain('-a')
    expect(plain).toHaveLength(1)
    expect(plain[0]).toContain('-a')
  })

  it('R2 a session of the default server does not query the run-as server', () => {
    expect(withTmuxBatch(() => paneCurrentCommand('agent-beta'))).toBe('node')
    const lp = panes()
    expect(lp).toHaveLength(1)
    expect(lp[0][0]).not.toBe('sudo')
  })
})
