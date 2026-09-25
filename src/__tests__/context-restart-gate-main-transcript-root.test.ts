// The context-restart gate reads the main agent's transcript to answer two
// questions: how big is the context, and was the session written to recently.
// Both used to be asked of the HOST DEFAULT config root (~/.claude), because
// configDirFor() returned undefined for MAIN_AGENT_ID -- while the channels
// session runs with CLAUDE_CONFIG_DIR=<PROJECT_ROOT>/.channels-config and
// writes its transcript there.
//
// MEASURED 2026-09-17 on a live install: the gate doctor reported 49,483
// context tokens from a transcript last written 2026-09-13 07:27, and 373,840
// seconds (4.3 days) since the last transcript write, while the live session
// file under .channels-config was 16.4 MB and seconds old.
//
// The token blindness only keeps the gate from firing. The staleness reading is
// worse: a huge age reads as "quiet", which is FAIL-OPEN -- the gate would judge
// a session idle while it is mid-turn and /clear it out from under running work.
// That is why this file pins the ROOT SELECTION (which both readings share) and,
// separately, the wiring of the staleness call site.
//
// Same defect class as TOKENVAK915 (1c8f4ff) in token-usage, whose sibling test
// is token-usage-main-isolated-root.test.ts.

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const FIXTURE = mkdtempSync(join(tmpdir(), 'gate-main-root-'))
const PROJECT_ROOT = '/Users/x/marveen'
const ENCODED = '-Users-x-marveen'

const SHARED_CONFIG = join(FIXTURE, 'home', '.claude')
const ISOLATED_CONFIG = join(FIXTURE, 'channels-config')
const SHARED_MAIN_DIR = join(SHARED_CONFIG, 'projects', ENCODED)
const ISOLATED_MAIN_DIR = join(ISOLATED_CONFIG, 'projects', ENCODED)
const EMPTY_CONFIG = join(FIXTURE, 'empty-config')

// Redirect the shared root-list helper at the fixture rather than re-deriving
// the list here: a second copy of that list is the drift this fix exists to
// prevent, and the test must not become one.
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

function writeTranscript(dir: string, name: string, ageSeconds: number): void {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, name)
  writeFileSync(file, '{"message":{"usage":{"input_tokens":1}}}\n')
  const when = new Date(Date.now() - ageSeconds * 1000)
  utimesSync(file, when, when)
}

describe('context-restart gate: which config root the main agent is read from', () => {
  beforeAll(() => {
    mkdirSync(EMPTY_CONFIG, { recursive: true })
    // Both roots hold a transcript, as on a real install after the migration:
    // the shared one frozen days ago, the isolated one live.
    writeTranscript(SHARED_MAIN_DIR, 'old-session.jsonl', 4 * 24 * 3600)
    writeTranscript(ISOLATED_MAIN_DIR, 'live-session.jsonl', 1)
  })

  afterAll(() => {
    roots = [SHARED_CONFIG, ISOLATED_CONFIG]
    subAgentConfigDir = null
    rmSync(FIXTURE, { recursive: true, force: true })
  })

  it('picks the isolated root when its transcript is the newer one', async () => {
    const { configDirFor } = await import('../web/context-restart-gate-runner.js')
    expect(configDirFor('marveen')).toBe(ISOLATED_CONFIG)
  })

  it('picks the shared root when THAT is the newer one (pre-migration history is real)', async () => {
    const { newestMainConfigRoot } = await import('../web/context-restart-gate-runner.js')
    writeTranscript(SHARED_MAIN_DIR, 'newer-session.jsonl', 0)
    expect(newestMainConfigRoot()).toBe(SHARED_CONFIG)
    // restore the post-migration shape for the remaining cases
    rmSync(join(SHARED_MAIN_DIR, 'newer-session.jsonl'), { force: true })
    expect(newestMainConfigRoot()).toBe(ISOLATED_CONFIG)
  })

  it('returns undefined when no candidate root holds a transcript, so the caller default still applies', async () => {
    const { newestMainConfigRoot } = await import('../web/context-restart-gate-runner.js')
    const saved = roots
    roots = [EMPTY_CONFIG]
    try {
      expect(newestMainConfigRoot()).toBeUndefined()
    } finally {
      roots = saved
    }
  })

  it('leaves sub-agents on their own resolver, not on the main-agent root list', async () => {
    const { configDirFor } = await import('../web/context-restart-gate-runner.js')
    subAgentConfigDir = '/somewhere/agents/ponder/.claude-config'
    expect(configDirFor('ponder')).toBe('/somewhere/agents/ponder/.claude-config')
    subAgentConfigDir = null
    expect(configDirFor('ponder')).toBeUndefined()
  })

  // The decision above is invisible from outside if the staleness reader is
  // still called without it. That call is the fail-open one, so pin the call
  // site itself rather than trusting that a future edit keeps passing it.
  it('asks the staleness reader for the same root, never with the working dir alone', () => {
    const src = readFileSync(
      new URL('../web/context-restart-gate-runner.ts', import.meta.url), 'utf-8')
    const calls = [...src.matchAll(/msSinceTranscriptWrite\(([^)]*)\)/g)]
      .map(m => m[1].trim())
      .filter(args => args !== '')                            // prose mentions in comments
      .filter(args => !args.includes('workingDir: string'))   // the declaration itself
    expect(calls.length).toBeGreaterThan(0)
    for (const args of calls) {
      expect(args).toContain('configDirFor(')
    }
  })
})
