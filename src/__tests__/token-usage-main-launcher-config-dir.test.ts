import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest'
import { mkdirSync, rmSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'

// Measured on a live install: the token monitor held ONE row for the main
// agent, days old -- the single stale file in ~/.claude/projects -- while the main channels session had been
// writing 171 MB of transcript under <PROJECT_ROOT>/.channels-config/projects
// ever since. The biggest spender of the fleet was missing from cost reporting.
//
// Everything here runs END TO END -- collectTokenUsage() into an in-memory DB,
// then getTokenSummary() -- because "the directory was discovered" and "the
// dashboard shows the tokens" are different claims, and only the second one is
// what this is about. The config roots come from the REAL resolvers
// (mainConfigRoots and the launcher's resolveMainAgentRotatedConfigDir), driven
// through the settings store and the plan files, not from a stubbed list.

// vi.hoisted: the mock factories below run when the hoisted imports load, which
// is before any plain top-level const of this file exists.
const { FIX, HOME, PROJECT_ROOT, ORIGINAL_HOME } = await vi.hoisted(async () => {
  const fs = await import('node:fs')
  const path = await import('node:path')
  // Not os.tmpdir(): node:os is mocked below, and its factory needs HOME.
  const fix = fs.realpathSync(fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'token-usage-main-launcher-')))
  const home = path.join(fix, 'home')
  // mainConfigRoots() reads process.env.HOME before homedir(); both must point
  // at the fixture or the real ~/.claude leaks into the test.
  const originalHome = process.env.HOME
  process.env.HOME = home
  return { FIX: fix, HOME: home, PROJECT_ROOT: path.join(fix, 'proj'), ORIGINAL_HOME: originalHome }
})
const SHARED_PROJECTS = join(HOME, '.claude', 'projects')
const CHANNELS_CONFIG = join(PROJECT_ROOT, '.channels-config')
// Same rule as src/claude-project-dir.ts; spelled out so the fixture does not
// depend on the module under test for its own layout.
const ENCODED = PROJECT_ROOT.replace(/[^a-zA-Z0-9-]/g, '-')

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

vi.mock('../web/agent-config.js', async () => {
  const actual = await vi.importActual<typeof import('../web/agent-config.js')>('../web/agent-config.js')
  return { ...actual, listAgentNames: () => [] }
})

// The one seam: the setting values. Everything that reads them -- the probe's
// root list and the launcher's rotation gate -- is the production code.
const settings: Record<string, string> = {}
vi.mock('../settings-store.js', async () => {
  const actual = await vi.importActual<typeof import('../settings-store.js')>('../settings-store.js')
  return { ...actual, getEffectiveSettingValue: (key: string) => settings[key] ?? '' }
})

import { getDb, initDatabase } from '../db.js'
import { collectTokenUsage, discoverAgentSources, getTokenSummary } from '../web/token-usage.js'

let seq = 0
function assistantLine(sessionId: string, ts: string, usage: { in: number; cr: number; cc: number; out: number }): string {
  seq++
  return JSON.stringify({
    type: 'assistant',
    sessionId,
    timestamp: ts,
    message: {
      id: `msg_${seq}`,
      model: 'claude-opus-5-5',
      usage: {
        input_tokens: usage.in,
        cache_read_input_tokens: usage.cr,
        cache_creation_input_tokens: usage.cc,
        output_tokens: usage.out,
      },
      content: [{ type: 'text', text: `turn ${seq}` }],
    },
  })
}

/** Two assistant turns with usage, plus a user line that must be ignored. */
function writeTwoTurns(dir: string, file: string, sessionId: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, file), [
    JSON.stringify({ type: 'user', sessionId, timestamp: '2026-09-23T08:00:00Z', message: { content: 'hi' } }),
    assistantLine(sessionId, '2026-09-23T08:00:05Z', { in: 10, cr: 1000, cc: 200, out: 30 }),
    assistantLine(sessionId, '2026-09-23T08:01:05Z', { in: 5, cr: 3000, cc: 100, out: 70 }),
  ].join('\n') + '\n')
}

function mainRow() {
  return getTokenSummary().find((r) => r.agent === 'marveen')
}

function mainDirs(): string[] {
  return discoverAgentSources().filter((s) => s.agent === 'marveen').map((s) => s.projectDir)
}

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
})

beforeEach(() => {
  rmSync(HOME, { recursive: true, force: true })
  rmSync(PROJECT_ROOT, { recursive: true, force: true })
  rmSync(join(FIX, 'plans'), { recursive: true, force: true })
  rmSync(join(FIX, 'bot'), { recursive: true, force: true })
  mkdirSync(HOME, { recursive: true })
  mkdirSync(join(PROJECT_ROOT, 'store'), { recursive: true })
  for (const k of Object.keys(settings)) delete settings[k]
  const db = getDb()
  db.exec('DELETE FROM token_usage')
  db.exec('DELETE FROM token_usage_cursors')
})

afterAll(() => {
  process.env.HOME = ORIGINAL_HOME
  rmSync(FIX, { recursive: true, force: true })
})

describe('token usage: the main agent under its launcher-resolved config dir', () => {
  it('books .channels-config transcripts to the main agent next to the stale shared-root file (the live shape)', async () => {
    // The live install: one frozen file left in the shared root from before the
    // move, the live session under .channels-config.
    mkdirSync(join(SHARED_PROJECTS, ENCODED), { recursive: true })
    writeFileSync(join(SHARED_PROJECTS, ENCODED, 'old.jsonl'),
      assistantLine('sess-old', '2026-09-18T13:17:00Z', { in: 1, cr: 0, cc: 0, out: 1 }) + '\n')
    writeTwoTurns(join(CHANNELS_CONFIG, 'projects', ENCODED), 'live.jsonl', 'sess-live')

    await collectTokenUsage()
    const row = mainRow()

    expect(row).toBeDefined()
    expect(row!.totalCalls).toBe(3)
    expect(row!.totalInput).toBe(16)
    expect(row!.totalCacheRead).toBe(4000)
    expect(row!.totalCacheCreation).toBe(300)
    expect(row!.totalOutput).toBe(101)
  })

  it('still reads .channels-config when the shared ~/.claude/projects does not exist at all', async () => {
    // A main agent that has run isolated from day one never creates the shared
    // projects dir. discoverAgentSources() used to return early on that, before
    // it ever reached the isolated roots.
    writeTwoTurns(join(CHANNELS_CONFIG, 'projects', ENCODED), 'live.jsonl', 'sess-live')

    await collectTokenUsage()
    const row = mainRow()

    expect(row).toBeDefined()
    expect(row!.totalCalls).toBe(2)
    expect(row!.totalCacheRead).toBe(4000)
  })

  it('books every project dir of the main agent\'s OWN config root to it, not only the PROJECT_ROOT one', async () => {
    // Measured on the live install: .channels-config/projects/-tmp holds three
    // sessions the main agent's login ran from /tmp. Attribution by owner, the
    // same rule the sub-agent loop applies to an isolated root.
    writeTwoTurns(join(CHANNELS_CONFIG, 'projects', '-tmp'), 'tmp.jsonl', 'sess-tmp')

    await collectTokenUsage()

    expect(mainRow()?.totalCalls).toBe(2)
  })

  it('keeps the shared root name-attributed: only the main agent\'s encoded dir is booked to it, also through a symlinked .channels-config/projects', async () => {
    // The shared ~/.claude/projects holds everyone's work: the main agent's
    // encoded dir next to unrelated ones (a worker's project, a /tmp session).
    // A root that resolves to it must never be booked to the main agent whole.
    writeTwoTurns(join(SHARED_PROJECTS, ENCODED), 'main.jsonl', 'sess-main')
    writeTwoTurns(join(SHARED_PROJECTS, '-home-someone-worker-proj'), 'worker.jsonl', 'sess-worker')
    writeTwoTurns(join(SHARED_PROJECTS, '-tmp'), 'tmp.jsonl', 'sess-tmp')
    expect(mainDirs()).toEqual([join(SHARED_PROJECTS, ENCODED)])

    // The same root reached as the main agent's own config dir (the live shape
    // on installs where .channels-config/projects is a symlink to the shared root).
    mkdirSync(CHANNELS_CONFIG, { recursive: true })
    symlinkSync(SHARED_PROJECTS, join(CHANNELS_CONFIG, 'projects'))
    expect(mainDirs().map((d) => realpathSync(d))).toEqual([realpathSync(join(SHARED_PROJECTS, ENCODED))])

    await collectTokenUsage()
    expect(mainRow()?.totalCalls).toBe(2)
  })

  it('follows the launcher onto a rotated plan config dir (resolveMainAgentRotatedConfigDir)', async () => {
    const planA = join(FIX, 'plans', 'a')
    const planB = join(FIX, 'plans', 'b')
    mkdirSync(planA, { recursive: true })
    mkdirSync(planB, { recursive: true })
    settings.MAIN_AGENT_ISOLATED_CONFIG = '1'
    writeFileSync(join(PROJECT_ROOT, 'store', 'claude-plans.json'), JSON.stringify([
      { id: 'a', label: 'A', configDir: planA, planType: 'personal', channelsAllowed: true },
      { id: 'b', label: 'B', configDir: planB, planType: 'personal', channelsAllowed: true },
    ]))
    writeFileSync(join(PROJECT_ROOT, 'store', 'claude-plans-state.json'),
      JSON.stringify({ activePlanByAgent: { marveen: 'b' }, plans: {} }))
    writeTwoTurns(join(planB, 'projects', ENCODED), 'rotated.jsonl', 'sess-rotated')
    // A plan is a pooled dir: a sub-agent assigned to it (now or earlier) leaves
    // its own project dir there. That one is never the main agent's.
    writeTwoTurns(join(planB, 'projects', '-somewhere-agents-other'), 'other.jsonl', 'sess-other')

    await collectTokenUsage()

    expect(mainRow()?.totalCalls).toBe(2)
    expect(mainDirs()).not.toContain(join(planB, 'projects', '-somewhere-agents-other'))
  })

  it('reads a directory reached through two config roots ONCE (symlinked MAIN_AGENT_CONFIG_DIR)', async () => {
    // An operator-set MAIN_AGENT_CONFIG_DIR whose projects/ is a symlink to the
    // .channels-config one: two roots, one store. Parsing it twice would not
    // show up in the row counts (the upsert absorbs identical rows), so the
    // assertion is on the sources and on how many files were parsed.
    writeTwoTurns(join(CHANNELS_CONFIG, 'projects', ENCODED), 'live.jsonl', 'sess-live')
    writeTwoTurns(join(CHANNELS_CONFIG, 'projects', '-tmp'), 'tmp.jsonl', 'sess-tmp')
    const bot = join(FIX, 'bot')
    mkdirSync(bot, { recursive: true })
    symlinkSync(join(CHANNELS_CONFIG, 'projects'), join(bot, 'projects'))
    settings.MAIN_AGENT_CONFIG_DIR = bot

    const dirs = mainDirs()
    const reals = dirs.map((d) => realpathSync(d))
    expect(new Set(reals).size).toBe(reals.length)
    expect(reals.sort()).toEqual([
      join(CHANNELS_CONFIG, 'projects', '-tmp'),
      join(CHANNELS_CONFIG, 'projects', ENCODED),
    ].sort())

    const res = await collectTokenUsage()
    expect(res.files).toBe(2)
    expect(res.inserted).toBe(4)
    expect(mainRow()?.totalCalls).toBe(4)
  })
})
