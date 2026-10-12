import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The MAIN agent runs with its own CLAUDE_CONFIG_DIR (<PROJECT_ROOT>/.channels-config),
// so its transcripts are NOT under ~/.claude/projects. discoverAgentSources() used to
// look for the main agent in the shared root only, which meant its rows stopped the
// moment the session moved -- silently, because the stale shared directory still
// exists and still parses.
//
// MEASURED 2026-09-15 on a live install: the newest file in the shared root was frozen
// at 2026-09-13 07:27 (288 KB) while the live one under .channels-config was 5.0 MB and
// minutes old; token_usage's last row carried exactly that frozen timestamp.
const FIXTURE = mkdtempSync(join(tmpdir(), 'token-usage-main-root-'))
const HOME = join(FIXTURE, 'home')
const SHARED_PROJECTS = join(HOME, '.claude', 'projects')
const PROJECT_ROOT = '/Users/x/marveen'
const ENCODED = '-Users-x-marveen'
const SHARED_MAIN_DIR = join(SHARED_PROJECTS, ENCODED)

const ISOLATED_CONFIG = join(FIXTURE, 'channels-config')
const ISOLATED_MAIN_DIR = join(ISOLATED_CONFIG, 'projects', ENCODED)

// A second install shape: the isolated config dir is only a SYMLINK back to the
// shared root. Then the two candidates are the same directory and must not be
// pushed twice -- the same transcript reaching the parser under two paths is how
// the sub-agent loop once triple-counted the whole fleet.
const SYMLINKED_CONFIG = join(FIXTURE, 'symlinked-config')

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

vi.mock('../web/agent-config.js', () => ({ listAgentNames: () => [] }))
vi.mock('../web/claude-plans.js', () => ({ resolveAgentConfigDirForRead: () => null }))

// The roots come from the one helper the scheduler probe and the channel
// watchdogs already share; the test redirects it at the fixture rather than
// re-deriving the list, which is the drift this fix exists to prevent.
let roots: string[] = [join(HOME, '.claude'), ISOLATED_CONFIG]
vi.mock('../web/inbound-probe.js', () => ({ mainConfigRoots: () => roots }))

describe('discoverAgentSources and the main agent isolated config dir', () => {
  beforeAll(() => {
    mkdirSync(SHARED_MAIN_DIR, { recursive: true })
    mkdirSync(ISOLATED_MAIN_DIR, { recursive: true })
    mkdirSync(SYMLINKED_CONFIG, { recursive: true })
    symlinkSync(SHARED_PROJECTS, join(SYMLINKED_CONFIG, 'projects'))
  })

  afterAll(() => {
    rmSync(FIXTURE, { recursive: true, force: true })
  })

  it('finds the live isolated dir as well as the shared one, both booked to the main agent', async () => {
    const { discoverAgentSources } = await import('../web/token-usage.js')
    const dirs = discoverAgentSources()
      .filter((s) => s.agent === 'marveen')
      .map((s) => s.projectDir)
      .sort()

    // Both roots are kept: the pre-migration history lives only in the shared one.
    expect(dirs).toEqual([SHARED_MAIN_DIR, ISOLATED_MAIN_DIR].sort())
  })

  it('does not add the same directory twice when the isolated projects dir is a symlink', async () => {
    roots = [join(HOME, '.claude'), SYMLINKED_CONFIG]
    vi.resetModules()
    const { discoverAgentSources } = await import('../web/token-usage.js')
    const dirs = discoverAgentSources().filter((s) => s.agent === 'marveen')

    expect(dirs).toHaveLength(1)
    expect(dirs[0].projectDir).toBe(SHARED_MAIN_DIR)
  })
})
