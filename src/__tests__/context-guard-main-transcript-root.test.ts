// The context-guard measures the main agent's transcript three ways -- tokens,
// idle time, context percent -- and those three numbers decide handoff and
// restart. Until GUARDCFGMASOLAT917 it asked them of the HOST DEFAULT config
// root, because context-guard-runner.ts kept its OWN copy of configDirFor with
// the main-agent exemption:
//
//     return name === MAIN_AGENT_ID ? undefined : (resolveAgentConfigDirForRead(name) ?? undefined)
//
// GATEVAK917 (#1382) fixed and exported the restart-gate's copy so a third
// would not appear; the guard's copy stayed on the old logic. That is worse
// than two identical wrong copies, because the next reader sees an exported,
// fixed function and concludes the subject is closed.
//
// WHY THIS FILE IS A BEHAVIOUR TEST, NOT A SOURCE-TEXT PIN: #1382 pinned its
// call site by reading the .ts and matching a regex. That catches the argument
// disappearing, but not the resolver returning the WRONG ROOT -- which is the
// actual defect. So here the two roots hold DIFFERENT, distinguishable numbers
// and each measurer is asserted on the value it returns. If the old resolver
// comes back, every assertion below flips to the shared root's number: 1_000
// tokens instead of 50_000, four days idle instead of seconds, 1% instead of
// 50%. That is the negative control, built into the fixture.
//
// MEASURED LIMIT, so nobody reads more urgency into this than it carries: on
// the owner's install the two roots are ONE directory (.channels-config/projects
// is a symlink to ~/.claude/projects, same inode, since 2026-07-22), so the old
// code read the live transcript there anyway and this fix is a no-op on that
// host. It bites where the roots genuinely diverge -- a main agent on its own
// Claude login.

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const FIXTURE = mkdtempSync(join(tmpdir(), 'guard-main-root-'))
const PROJECT_ROOT = '/Users/x/marveen'
const ENCODED = '-Users-x-marveen'

const FIXTURE_HOME = join(FIXTURE, 'home')
const SHARED_CONFIG = join(FIXTURE_HOME, '.claude')
const ISOLATED_CONFIG = join(FIXTURE, 'channels-config')
const SHARED_MAIN_DIR = join(SHARED_CONFIG, 'projects', ENCODED)
const ISOLATED_MAIN_DIR = join(ISOLATED_CONFIG, 'projects', ENCODED)

const SHARED_TOKENS = 1_000
const ISOLATED_TOKENS = 50_000
const SHARED_AGE_SECONDS = 4 * 24 * 3600

// homedir() is what the OLD code would have landed on (projectsDirFor falls back
// to <home>/.claude when no configDir is given). Pointing it at the fixture is
// what makes the negative control real instead of decorative: with the old
// resolver these tests read SHARED_MAIN_DIR, not the developer's own ~/.claude.
vi.mock('node:os', async (orig) => {
  const actual = await orig<typeof import('node:os')>()
  return { ...actual, default: { ...actual, homedir: () => FIXTURE_HOME }, homedir: () => FIXTURE_HOME }
})

let roots: string[] = [SHARED_CONFIG, ISOLATED_CONFIG]
vi.mock('../web/inbound-probe.js', () => ({ mainConfigRoots: () => roots }))

vi.mock('../config.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  MAIN_AGENT_ID: 'marveen',
  PROJECT_ROOT,
}))

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

let subAgentConfigDir: string | null = null
vi.mock('../web/claude-plans.js', () => ({
  resolveAgentConfigDirForRead: () => subAgentConfigDir,
}))

function writeTranscript(dir: string, name: string, tokens: number, ageSeconds: number): void {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, name)
  writeFileSync(file, JSON.stringify({ message: { usage: { input_tokens: tokens } } }) + '\n')
  const when = new Date(Date.now() - ageSeconds * 1000)
  utimesSync(file, when, when)
}

describe('context-guard: which config root the main agent is measured from', () => {
  beforeAll(() => {
    // The post-migration shape of a real install: the shared root frozen days
    // ago, the isolated one live. Distinguishable on purpose.
    writeTranscript(SHARED_MAIN_DIR, 'old-session.jsonl', SHARED_TOKENS, SHARED_AGE_SECONDS)
    writeTranscript(ISOLATED_MAIN_DIR, 'live-session.jsonl', ISOLATED_TOKENS, 1)
  })

  afterAll(() => {
    roots = [SHARED_CONFIG, ISOLATED_CONFIG]
    subAgentConfigDir = null
    rmSync(FIXTURE, { recursive: true, force: true })
  })

  it('measures the token count from the isolated root, not the stale shared one', async () => {
    const { measureContextTokens } = await import('../web/context-guard-runner.js')
    expect(measureContextTokens('marveen')).toBe(ISOLATED_TOKENS)
    // Stated rather than implied: this is the value the pre-fix code returned.
    expect(measureContextTokens('marveen')).not.toBe(SHARED_TOKENS)
  })

  it('measures idle time from the isolated root, so a live session never reads as quiet', async () => {
    const { measureIdleMs } = await import('../web/context-guard-runner.js')
    const idle = measureIdleMs('marveen', Date.now())
    expect(idle).not.toBeNull()
    // Seconds, not days. The pre-fix read would be ~4 days here, and a large
    // idle time is what trips the idle-flush tier.
    expect(idle as number).toBeLessThan(60_000)
    expect(idle as number).toBeLessThan(SHARED_AGE_SECONDS * 1000 / 2)
  })

  it('computes the context percent from the isolated root', async () => {
    const { measurePct } = await import('../web/context-guard-runner.js')
    // Explicit limit so the assertion is about the ROOT, not about model
    // calibration: 50_000 / 100_000 = 0.5, while the shared root would give 0.01.
    expect(measurePct('marveen', 100_000)).toBeCloseTo(0.5, 5)
  })

  it('leaves sub-agents on their own resolver', async () => {
    const { measureContextTokens } = await import('../web/context-guard-runner.js')
    const subDir = join(FIXTURE, 'agents', 'ponder', '.claude-config')
    const subWorkingDir = join(PROJECT_ROOT, 'agents', 'ponder')
    const encodedSub = subWorkingDir.replace(/[/.]/g, '-')
    writeTranscript(join(subDir, 'projects', encodedSub), 'sub.jsonl', 7_777, 1)
    subAgentConfigDir = subDir
    try {
      expect(measureContextTokens('ponder')).toBe(7_777)
    } finally {
      subAgentConfigDir = null
    }
  })

  it('shares ONE resolver with the restart gate, so the two watchdogs cannot drift apart', async () => {
    const shared = await import('../web/main-transcript-root.js')
    const gate = await import('../web/context-restart-gate-runner.js')
    // Identity, not equality of results: two copies can agree today and diverge
    // on the next edit, which is exactly how this defect was born.
    expect(gate.configDirFor).toBe(shared.configDirFor)
  })
})
