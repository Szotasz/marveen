// CODEXEVID d72ba2bd: probeTurnEvidence must ALSO weigh the Codex rollout
// mtime. Measured 2026-11-15 on this install: 38 "Scheduled injection never
// started a turn ... recording as lost" redeliveries in one day (webesdavid
// 18, tenderbot 10, bence 8, guszti 2), 58 since 11-14, every one a DUPLICATE
// task run -- the scheduled-injection watchdog judged "did a turn start" from
// the Claude-Code transcript alone, and for an agent whose tmux pane runs
// OpenAI Codex that transcript never moves. The running session's rollout
// file under <CODEX_HOME>/sessions/YYYY/MM/DD/ does.
//
// These cases extend schedule-task-timeout.test.ts (which stays untouched and
// covers the Claude-only behaviour); probeTurnEvidence stays PURE -- the codex
// reader is an injected dep exactly like readLocal/readRemote.
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  probeTurnEvidence,
  decideTaskTimeout,
  TASK_FIRE_GRACE_MS,
  type TaskInflightEntry,
} from '../web/schedule-runner.js'
import { OWNER_ESCALATION_EXTRA_MS } from '../pending-retries.js'

const GRACE = TASK_FIRE_GRACE_MS
const BASE_OPTS = { graceMs: GRACE, timeoutMs: 2_700_000, maxTrackMs: 6 * 60 * 60_000, ownerExtraMs: OWNER_ESCALATION_EXTRA_MS }

type ProbeFields = Pick<TaskInflightEntry, 'injectedAt' | 'sawTurn' | 'host' | 'workingDir' | 'configDirs' | 'remoteWorkdir'>

// A local codex-motor agent entry: injected at T, no turn observed yet.
const T = Date.parse('2026-11-15T11:07:00.000Z')
function makeEntry(over: Partial<ProbeFields> = {}): ProbeFields {
  return { injectedAt: T, sawTurn: false, host: null, workingDir: '/workdirs/dex', configDirs: [], remoteWorkdir: undefined, ...over }
}

describe('probeTurnEvidence: codex rollout mtime as turn evidence', () => {
  it('(d) idle pane, Claude mtime stale, rollout mtime past the injection => sawTurn, decision done not lost', async () => {
    const entry = makeEntry()
    const probed = probeTurnEvidence(entry, 'idle', {
      readLocal: () => T - 60_000,   // the Claude transcript last moved BEFORE the send
      codexMtime: () => T + 5_000,   // the running rollout file advanced after it
    })
    expect(probed.sawTurn).toBe(true)
    // ...and that evidence flips the sweep's verdict from a lost-redelivery to a finished run.
    const decided = decideTaskTimeout({ ...entry, sawTurn: probed.sawTurn } as TaskInflightEntry, 'idle', T + GRACE + 1, BASE_OPTS)
    expect(decided).toBe('done')
    expect(decided).not.toBe('lost')
  })

  it('(e) no codex evidence => exactly today’s lost verdict', () => {
    const entry = makeEntry()
    const probed = probeTurnEvidence(entry, 'idle', { readLocal: () => T - 60_000 })
    expect(probed.sawTurn).toBe(false)
    expect(decideTaskTimeout({ ...entry, sawTurn: probed.sawTurn } as TaskInflightEntry, 'idle', T + GRACE + 1, BASE_OPTS)).toBe('lost')
  })

  it('a codex reader that reports nothing (null) changes nothing', () => {
    const probed = probeTurnEvidence(makeEntry(), 'idle', { readLocal: () => T - 60_000, codexMtime: () => null })
    expect(probed.sawTurn).toBe(false)
  })

  it('only a rollout mtime STRICTLY newer than the injection counts (stale is not a turn)', () => {
    expect(probeTurnEvidence(makeEntry(), 'idle', { readLocal: () => null, codexMtime: () => T }).sawTurn).toBe(false)
    expect(probeTurnEvidence(makeEntry(), 'idle', { readLocal: () => null, codexMtime: () => T - 1 }).sawTurn).toBe(false)
    expect(probeTurnEvidence(makeEntry(), 'idle', { readLocal: () => null, codexMtime: () => T + 1 }).sawTurn).toBe(true)
  })

  it('codex evidence is consulted for LOCAL hosts only, like readLocal', () => {
    const codexMtime = vi.fn(() => T + 5_000)
    const probed = probeTurnEvidence(makeEntry({ host: 'laptop.local', remoteWorkdir: '/remote/workdirs/dex' }), 'idle', { codexMtime })
    expect(probed.sawTurn).toBe(false)
    expect(codexMtime).not.toHaveBeenCalled()
  })

  it('a busy pane still short-circuits to sawTurn without any mtime reader', () => {
    expect(probeTurnEvidence(makeEntry({ sawTurn: false }), 'busy', {}).sawTurn).toBe(true)
    expect(probeTurnEvidence(makeEntry({ sawTurn: true }), 'idle', {}).sawTurn).toBe(true)
  })

  it('the Claude transcript alone still works: fresh claude mtime, no codex reader', () => {
    expect(probeTurnEvidence(makeEntry(), 'idle', { readLocal: () => T + 1_000 }).sawTurn).toBe(true)
  })

  it('mtimeSeen keeps reporting the CLAUDE transcript mtime (what the sweep logs)', () => {
    const probed = probeTurnEvidence(makeEntry(), 'idle', { readLocal: () => T - 60_000, codexMtime: () => T + 5_000 })
    expect(probed.mtimeSeen).toBe(T - 60_000)
  })
})

// SUPPLEMENT (d72ba2bd): measured on this install 2026-11-15, the 21 scheduled
// Codex-agent tasks of the day were ALL redelivered as duplicate runs after a
// false "never started a turn" verdict -- the exact regression this PR fixes
// at the evidence level. The unit tests above pin decideTaskTimeout's verdict;
// these guard the SWEEP that consumes it, so a run PROVEN done stays a dead
// end for retries: the done/abandoned branch must not enqueue a pending retry
// or record a 'lost' run, and the lost-redelivery enqueue must stay inside the
// lost branch (a misplaced one is what turns a proven run into a second
// injection). Source-text-guard style, same as the 'lost-redelivery wiring'
// suite in schedule-task-timeout.test.ts -- the sweep owns in-memory state a
// unit harness cannot reach.
describe('done-run wiring in the watchdog sweep: no second injection after proven evidence', () => {
  const SRC = readFileSync(join(__dirname, '../web/schedule-runner.ts'), 'utf-8')
  const doneBranchIdx = SRC.indexOf("if (decision === 'done' || decision === 'abandoned') {")
  const alertBranchIdx = SRC.indexOf("} else if (decision === 'alert') {", doneBranchIdx)
  const lostBranchIdx = SRC.indexOf("} else if (decision === 'lost') {", alertBranchIdx)
  // The sweep's decision chain ENDS at the lost branch (done -> alert ->
  // escalate -> lost&&parked -> lost). The later "if (decision === 'stale')"
  // in this file belongs to the catch-up scan's own decision variable, not to
  // this chain, so it is deliberately NOT an anchor here (round-4 finding:
  // bounding the lost branch by it left everything after the chain's real end
  // unchecked, and the anchor itself was the wrong mechanism's).
  const lostEndIdx = SRC.indexOf('taskInflightMap.delete(key)', lostBranchIdx)
  const enqueueRe = /insertPendingTaskRetryIfNew\([^)]*'lost-injection'/
  const giveupIdx = SRC.indexOf("decideLostRedeliveryAction(priorAttempts) === 'giveup'", lostBranchIdx)

  it('branch anchors line up: done -> alert -> lost, the lost branch bounded by its terminal delete', () => {
    expect(doneBranchIdx).toBeGreaterThan(0)
    expect(alertBranchIdx).toBeGreaterThan(doneBranchIdx)
    expect(lostBranchIdx).toBeGreaterThan(alertBranchIdx)
    expect(lostEndIdx).toBeGreaterThan(lostBranchIdx)
  })

  it('the done/abandoned branch enqueues NO pending retry', () => {
    const doneBranch = SRC.slice(doneBranchIdx, alertBranchIdx)
    expect(doneBranch).not.toMatch(/insertPendingTaskRetryIfNew/)
  })

  it("the done/abandoned branch records NO 'lost' task run", () => {
    const doneBranch = SRC.slice(doneBranchIdx, alertBranchIdx)
    expect(doneBranch).not.toMatch(/appendTaskRun\([^)]*'lost'/)
  })

  it("the 'lost-injection' retry enqueue exists EXACTLY ONCE, inside the lost branch", () => {
    // Exactly one lost-injection enqueue in the whole sweep source: a second
    // one ANYWHERE -- before the branch, in a later section, or in the
    // catch-up scan -- must fail here. Checking only the prefix before the
    // branch was the round-4 blocker: everything after the lost branch was
    // unchecked.
    expect(SRC.match(/insertPendingTaskRetryIfNew\([^)]*'lost-injection'/g)).toHaveLength(1)
    // ...and that one call sits inside the lost branch: after the branch
    // opens, before its own terminal taskInflightMap.delete(key) statement.
    const enqueueIdx = SRC.search(enqueueRe)
    expect(enqueueIdx).toBeGreaterThan(lostBranchIdx)
    expect(enqueueIdx).toBeLessThan(lostEndIdx)
    // ...past the give-up check of this branch: a retry is enqueued only
    // where the sweep decided NOT to give up on the occurrence.
    expect(giveupIdx).toBeGreaterThan(lostBranchIdx)
    expect(enqueueIdx).toBeGreaterThan(giveupIdx)
  })
})
