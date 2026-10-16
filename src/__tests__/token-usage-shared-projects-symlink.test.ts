import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// A fleet where NO agent was migrated to its own OS user: every
// agents/<name>/.claude-config/projects is a symlink back to the shared
// ~/.claude/projects. Before the fix, discoverAgentSources() walked each
// symlink and handed every agent the WHOLE fleet's transcript dirs, so the
// token monitor showed three sub-agents with byte-identical totals
// (measured on a live install 2026-09-04) while only the main agent's
// number was real.
const FIXTURE = mkdtempSync(join(tmpdir(), 'token-usage-symlink-'))
const HOME = join(FIXTURE, 'home')
const SHARED_PROJECTS = join(HOME, '.claude', 'projects')
const PROJECT_ROOT = '/Users/x/marveen'
const MAIN_DIR = join(SHARED_PROJECTS, '-Users-x-marveen')
const ALPHA_DIR = join(SHARED_PROJECTS, '-Users-x-marveen-agents-alpha')
const BETA_DIR = join(SHARED_PROJECTS, '-Users-x-marveen-agents-beta')

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return { ...actual, homedir: () => HOME }
})

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, MAIN_AGENT_ID: 'marveen', PROJECT_ROOT }
})

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

vi.mock('../web/agent-config.js', () => ({
  listAgentNames: () => ['alpha', 'beta'],
}))

vi.mock('../web/claude-plans.js', () => ({
  resolveAgentConfigDirForRead: (name: string) =>
    join(FIXTURE, 'agents', name, '.claude-config'),
}))

describe('discoverAgentSources with a symlinked isolated projects dir', () => {
  beforeAll(() => {
    for (const d of [MAIN_DIR, ALPHA_DIR, BETA_DIR]) mkdirSync(d, { recursive: true })
    for (const name of ['alpha', 'beta']) {
      const configDir = join(FIXTURE, 'agents', name, '.claude-config')
      mkdirSync(configDir, { recursive: true })
      symlinkSync(SHARED_PROJECTS, join(configDir, 'projects'))
    }
  })

  afterAll(() => {
    rmSync(FIXTURE, { recursive: true, force: true })
  })

  it('attributes each transcript dir to exactly one agent', async () => {
    const { discoverAgentSources } = await import('../web/token-usage.js')
    const sources = discoverAgentSources()

    expect(sources.map((s) => [s.agent, s.projectDir]).sort()).toEqual(
      [
        ['alpha', ALPHA_DIR],
        ['beta', BETA_DIR],
        ['marveen', MAIN_DIR],
      ].sort(),
    )
  })

  it('never hands one agent another agent\'s transcript dir', async () => {
    const { discoverAgentSources } = await import('../web/token-usage.js')
    const sources = discoverAgentSources()

    // The defect's signature: each sub-agent ending up with all three
    // dirs, which is what made their totals identical.
    for (const agent of ['alpha', 'beta']) {
      expect(sources.filter((s) => s.agent === agent)).toHaveLength(1)
    }
    expect(sources.some((s) => s.agent === 'alpha' && s.projectDir === BETA_DIR)).toBe(false)
    expect(sources.some((s) => s.agent === 'beta' && s.projectDir === MAIN_DIR)).toBe(false)
  })
})
