// ROSTERALIAS1026: a symlink agents/alias -> agents/alpha is not a second agent.
//
// statSync() follows symlinks, so one directory could sit on the roster under
// two names: the dashboard list, supervision, the boot hook-seeding loop and
// the fleet export all saw a phantom agent that was really the target agent.
// Only a REAL directory (or a link to one OUTSIDE agents/, e.g. an agent dir
// moved to another disk and linked back) is an agent.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const SANDBOX = mkdtempSync(join(tmpdir(), 'roster-alias-'))
const AGENTS = join(SANDBOX, 'agents')

vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return { ...actual, MAIN_AGENT_ID: 'mainagent', PROJECT_ROOT: SANDBOX, STORE_DIR: join(SANDBOX, 'store') }
})
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

const { logger } = await import('../logger.js')
const { listAgentNames, listAllAgentNames } = await import('../web/agent-config.js')

// Count the logger.warn calls whose first argument carries entry === <name>.
function warnCallsFor(entry: string): number {
  return vi.mocked(logger.warn).mock.calls
    .filter((call) => (call[0] as unknown as Record<string, unknown> | undefined)?.entry === entry)
    .length
}

beforeEach(() => {
  rmSync(AGENTS, { recursive: true, force: true })
  rmSync(join(SANDBOX, 'elsewhere'), { recursive: true, force: true })
  rmSync(join(SANDBOX, 'real-agents'), { recursive: true, force: true })
  mkdirSync(join(AGENTS, 'alpha'), { recursive: true })
  vi.clearAllMocks()
})
afterAll(() => rmSync(SANDBOX, { recursive: true, force: true }))

describe('a symlink into agents/ itself is an alias, not an agent', () => {
  it('an absolute-target alias is not listed by either function', () => {
    symlinkSync(join(AGENTS, 'alpha'), join(AGENTS, 'alias'))
    expect([...listAllAgentNames()].sort()).toEqual(['alpha'])
    expect([...listAgentNames()].sort()).toEqual(['alpha'])
  })

  it('a relative-target alias is not listed either', () => {
    symlinkSync('alpha', join(AGENTS, 'alias2'))
    expect([...listAllAgentNames()].sort()).toEqual(['alpha'])
  })

  it('an alias of something inside another agent dir is not listed', () => {
    mkdirSync(join(AGENTS, 'alpha', 'sub'))
    symlinkSync(join(AGENTS, 'alpha', 'sub'), join(AGENTS, 'nested'))
    expect([...listAllAgentNames()].sort()).toEqual(['alpha'])
  })

  it('a link to an agent dir outside agents/ stays a real agent', () => {
    mkdirSync(join(SANDBOX, 'elsewhere', 'gamma'), { recursive: true })
    symlinkSync(join(SANDBOX, 'elsewhere', 'gamma'), join(AGENTS, 'gamma'))
    expect([...listAllAgentNames()].sort()).toEqual(['alpha', 'gamma'])
  })

  it('a dangling link and a plain file are not agents', () => {
    symlinkSync(join(SANDBOX, 'nope'), join(AGENTS, 'dangling'))
    writeFileSync(join(AGENTS, 'plain.txt'), 'x')
    expect([...listAllAgentNames()].sort()).toEqual(['alpha'])
  })

  it('aliases are caught through a symlinked agents/ directory too', () => {
    rmSync(AGENTS, { recursive: true, force: true })
    mkdirSync(join(SANDBOX, 'real-agents', 'alpha'), { recursive: true })
    symlinkSync(join(SANDBOX, 'real-agents'), AGENTS)
    symlinkSync(join(AGENTS, 'alpha'), join(AGENTS, 'alias'))
    expect([...listAllAgentNames()].sort()).toEqual(['alpha'])
  })

  it('the alias warn fires at most once per entry per process', () => {
    symlinkSync(join(AGENTS, 'alpha'), join(AGENTS, 'alias-once'))
    listAllAgentNames()
    listAllAgentNames()
    expect(warnCallsFor('alias-once')).toBe(1)
  })

  it('a real directory beside the others is still listed', () => {
    mkdirSync(join(AGENTS, 'beta'))
    expect([...listAllAgentNames()].sort()).toEqual(['alpha', 'beta'])
  })
})
