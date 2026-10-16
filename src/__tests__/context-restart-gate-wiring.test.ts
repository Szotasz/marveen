// WHAT THIS FILE PINS: the WIRING, not the readers.
//
// Three separate reviews found the same shape of hole: the fix was correct, the
// unit tests were green, and a mutant that DISCONNECTED the fix from its caller
// survived all of them. A reader that is never reached, and a rule that is
// called with the wrong argument, both look exactly like a working gate from a
// unit test that calls them directly.
//
// So every case here goes through the production entry point
// (`gatherGateInputs` / `checkAgent`) with the production defaults, and each one
// names the mutant it kills.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const FIXTURE = mkdtempSync(join(tmpdir(), 'gate-wiring-'))
const PROJECT_ROOT = join(FIXTURE, 'marveen')
const CONFIG_DIR = join(FIXTURE, 'config')
const MAIN = 'marveen'
const SUB = 'gatewire-sub'

vi.mock('../config.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  MAIN_AGENT_ID: MAIN,
  PROJECT_ROOT,
}))
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))
// No tmux in a test run: a pane that cannot be captured is `null`, which the
// gate already treats as "unknown", so it does not decide anything here.
vi.mock('../web/agent-process.js', () => ({
  agentSessionName: (n: string) => `agent-${n}`,
  capturePane: () => { throw new Error('no tmux in tests') },
}))
vi.mock('../web/context-guard-runner.js', () => ({ getHardGuardPhase: () => null }))
vi.mock('../web/main-transcript-root.js', () => ({
  configDirFor: () => CONFIG_DIR,
  newestMainConfigRoot: () => CONFIG_DIR,
}))
vi.mock('../web/claude-plans.js', () => ({ resolveAgentConfigDirForRead: () => CONFIG_DIR }))
vi.mock('../web/agent-config.js', () => ({ listAgentNames: () => [MAIN, SUB] }))

/**
 * A transcript whose FILE is fresh but whose last real turn is old -- the exact
 * shape that made the gate block for ever: idle sessions keep growing the file
 * with untimestamped bookkeeping lines, so mtime says "busy" while the session
 * has been silent for hours.
 */
function writeTranscript(dir: string, turnAgeMs: number, mtimeAgeS: number): void {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'session.jsonl')
  const turnTs = new Date(Date.now() - turnAgeMs).toISOString()
  writeFileSync(file,
    `{"type":"assistant","timestamp":"${turnTs}","message":{"usage":{"input_tokens":1000}}}\n`
    // Untimestamped bookkeeping AFTER the last turn: this is what grows an idle file.
    + '{"type":"file-history-snapshot","snapshot":{}}\n'
    + '{"type":"atis-latch","v":1}\n')
  const when = new Date(Date.now() - mtimeAgeS * 1000)
  utimesSync(file, when, when)
}

describe('restart gate wiring: the transcript reader is actually reached', () => {
  beforeAll(async () => {
    const { encodeClaudeProjectDir } = await import('../claude-project-dir.js')
    const dir = join(CONFIG_DIR, 'projects', encodeClaudeProjectDir(PROJECT_ROOT))
    // Last real turn 3 hours ago; the FILE touched one second ago.
    writeTranscript(dir, 3 * 3600 * 1000, 1)
    const { initDatabase } = await import('../db.js')
    initDatabase(':memory:')
  })
  afterAll(() => { rmSync(FIXTURE, { recursive: true, force: true }) })

  // KILLS: a mutant that drops readLastConversationTsFromProjectDir and falls
  // back to file mtime. That mutant passed the whole suite before this test.
  it('reports the age of the last TURN, not of the file', async () => {
    const { gatherGateInputs } = await import('../web/context-restart-gate-runner.js')
    const { inputs } = gatherGateInputs(MAIN, Date.now())
    expect(inputs.msSinceTranscriptWrite).not.toBeNull()
    // Nearly 3 hours, not ~1 second. The window is wide on purpose: the claim
    // is "turns, not mtime", and a tight bound would fail on a slow runner
    // for the wrong reason.
    expect(inputs.msSinceTranscriptWrite!).toBeGreaterThan(2 * 3600 * 1000)
  })
})

describe('restart gate wiring: the report-direction rule runs with the production default', () => {
  // The unit tests for this rule pass the main agent EXPLICITLY, so they say
  // nothing about what the live caller passes. Two mutants survived them:
  // a default that is not MAIN_AGENT_ID, and a caller handing the SENDER in as
  // the main agent (which switches the exclusion off for everyone).
  beforeAll(async () => {
    const { initDatabase, createAgentMessage } = await import('../db.js')
    initDatabase(':memory:')
    // A report upward: must NOT hold a restart back.
    createAgentMessage(SUB, MAIN, 'KESZ: a meres megvan, 20/20 zold.')
    // Real dispatched work to a third party: must still count.
    createAgentMessage(SUB, 'gatewire-other', 'Most rajtad a sor: rendereld le.')
    // The main agent's own delegation: counts, and this is the row the
    // exclusion must never touch.
    createAgentMessage(MAIN, SUB, 'UJ FELADAT: nezd meg a kaput.')
  })

  it('does not count a sub-agent report to the main agent, but counts real work', async () => {
    const { gatherGateInputs } = await import('../web/context-restart-gate-runner.js')
    const { inputs } = gatherGateInputs(SUB, Date.now())
    expect(inputs.pendingOutboundCount).toBe(1)
  })

  it('still counts what the MAIN agent has dispatched downward', async () => {
    const { gatherGateInputs } = await import('../web/context-restart-gate-runner.js')
    const { inputs } = gatherGateInputs(MAIN, Date.now())
    expect(inputs.pendingOutboundCount).toBe(1)
  })

  // The default itself, read through the production call. A default that is not
  // MAIN_AGENT_ID leaves the sub-agent's report counted, which is mutant (a);
  // this is the assertion that turns red on it.
  it('the default main-agent argument is the configured MAIN_AGENT_ID', async () => {
    const { getDispatchedPendingStats } = await import('../db.js')
    const explicit = getDispatchedPendingStats(SUB, Date.now(), 2 * 3600_000, MAIN)
    const { gatherGateInputs } = await import('../web/context-restart-gate-runner.js')
    const live = gatherGateInputs(SUB, Date.now()).inputs.pendingOutboundCount
    expect(live).toBe(explicit.count)
    // ...and the two differ from the unfiltered reading, or the equality above
    // would also hold for a gate that filters nothing at all.
    const unfiltered = getDispatchedPendingStats(SUB, Date.now(), 2 * 3600_000, 'nobody-is-called-this')
    expect(unfiltered.count).toBe(2)
  })
})

// --- The alert ENVELOPE: sender, prefix, and the wording escalation ---------
// All three were reverted by mutants that the suite passed. They are only
// observable from `checkAgent`, because the alert is a side effect, so the
// tests drive that and read the row back out of the database.
describe('restart gate wiring: the persistent-block alert', () => {
  const ALERT_AGENT = 'gatewire-blocked'
  let runState: Record<string, unknown> = {}
  const cfg = {
    enabled: true,
    thresholdTokens: 1000,
    persistentBlockAlertMs: 60_000,
    staleCutoffMs: 2 * 3600_000,
    transcriptQuietMs: 60_000,
    sweepIntervalMs: 300_000,
  }

  beforeAll(async () => {
    vi.doMock('../web/context-restart-gate-store.js', () => ({
      readGateConfig: () => cfg,
      readGateRunState: () => runState,
      writeGateRunState: (_n: string, s: Record<string, unknown>) => { runState = s },
      pickGateConfig: () => cfg,
    }))
    vi.resetModules()
    // The alert only fires on a MEASURED reading: an unmeasurable context is
    // fail-closed `block`, and deliberately never escalates to `block-alert`
    // (every fresh session reads null for about a minute). So this agent needs
    // a transcript of its own, above the threshold, or the whole describe
    // block would be measuring the absence of a transcript.
    const { encodeClaudeProjectDir } = await import('../claude-project-dir.js')
    const dir = join(CONFIG_DIR, 'projects',
                     encodeClaudeProjectDir(join(PROJECT_ROOT, 'agents', ALERT_AGENT)))
    mkdirSync(dir, { recursive: true })
    const turnTs = new Date(Date.now() - 3 * 3600 * 1000).toISOString()
    writeFileSync(join(dir, 'session.jsonl'),
      `{"type":"assistant","timestamp":"${turnTs}","message":{"usage":{"input_tokens":900000}}}\n`)
    const { initDatabase } = await import('../db.js')
    initDatabase(':memory:')
  })
  afterAll(() => { vi.doUnmock('../web/context-restart-gate-store.js'); vi.resetModules() })

  async function alertRowsAfter(blockedMinutes: number): Promise<string[]> {
    const now = Date.now()
    runState = { firstBlockedAt: now - blockedMinutes * 60_000, lastAlertAt: null }
    const { createAgentMessage, getDb } = await import('../db.js')
    // A row that BLOCKS the gate: dispatched work outstanding.
    createAgentMessage(ALERT_AGENT, 'gatewire-other', `Most rajtad a sor (${blockedMinutes}).`)
    const { checkAgent } = await import('../web/context-restart-gate-runner.js')
    await checkAgent(ALERT_AGENT, now)
    // The PREFIX, not just "CONTEXT-RESTART-GATE": the wake nudge sent to a
    // freshly cleared session carries the plain prefix, and a loose LIKE picked
    // THAT row up first -- the assertion then measured the wrong message.
    return (getDb().prepare(
      "SELECT from_agent, to_agent, content FROM agent_messages"
      + " WHERE content LIKE '%CONTEXT-RESTART-GATE-RIASZTAS%'",
    ).all() as Array<{ from_agent: string, to_agent: string, content: string }>)
      .map((r) => `${r.from_agent}|${r.to_agent}|${r.content}`)
  }

  // KILLS: reverting the sender to the watched agent's name (GATESENDER922).
  // That revert is invisible to every other test, and it is the one that makes
  // a genuine supervisory alert fail the fleet's own authenticity check.
  it('is sent BY "system" TO the main agent, with its own prefix', async () => {
    const rows = await alertRowsAfter(30)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows[0].startsWith(`system|${MAIN}|`)).toBe(true)
    expect(rows[0]).toContain('[CONTEXT-RESTART-GATE-RIASZTAS]')
  })

  // KILLS: dropping the >= 120 minute wording escalation. The test file header
  // claimed this was covered; it was not, on any of the five tests there.
  it('escalates its WORDING past 120 minutes, and not before', async () => {
    const early = await alertRowsAfter(30)
    expect(early.some((r) => r.includes('NEM fog megszunni'))).toBe(false)
    const late = await alertRowsAfter(130)
    expect(late.some((r) => r.includes('NEM fog megszunni'))).toBe(true)
  })
})
