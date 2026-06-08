import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Contract tests for the daily-batch-agent "never runs" fix.
//
// Root cause: a daily batch agent has no 24/7 tmux session. When its cron
// fired (e.g. a `0 2 * * *` digest), attemptFireTask found the target session
// missing and returned 'missing' -- a silent skip. The task was enabled and
// scheduled but could never fire.
//
// Fix: when the session is missing, START the agent and return a new 'starting'
// state. The caller enqueues a retry that delivers the prompt on a later tick
// once Claude has booted. Crucially this retry must bypass skipIfBusy -- the
// whole point was to wake the agent for its scheduled run, so a skipIfBusy=true
// task must NOT drop the delivery.

const SRC = readFileSync(join(__dirname, '../web/schedule-runner.ts'), 'utf-8')

describe('schedule-runner auto-starts a stopped agent for its scheduled task', () => {
  it('attemptFireTask can return a distinct "starting" state', () => {
    // The return union must carry 'starting' so the caller can tell an
    // auto-start apart from a genuine busy session.
    const sig = SRC.slice(SRC.indexOf('function attemptFireTask'))
    expect(sig.slice(0, 200)).toMatch(/'starting'/)
  })

  it('the missing-session branch auto-starts the agent instead of skipping', () => {
    // Locate the (host-aware) missing-session guard and assert it now launches the agent.
    const guardIdx = SRC.indexOf('if (!sessionExistsOnHost(')
    expect(guardIdx).toBeGreaterThan(0)
    // Window covering the missing-session block (comment + code, before the
    // real busy-check). Must launch the agent and return the 'starting' state.
    const missingBlock = SRC.slice(guardIdx, guardIdx + 1800)
    expect(missingBlock).toMatch(/startAgentProcess\(agentName\)/)
    expect(missingBlock).toMatch(/return 'starting'/)
  })

  it('the cron loop enqueues a retry for "starting" WITHOUT the skipIfBusy gate', () => {
    // Find where the cron loop handles a 'starting' result. That branch must
    // insert a pending retry, and must NOT be guarded by task.skipIfBusy
    // (otherwise a skipIfBusy=true daily digest would auto-start the agent and
    // then drop the delivery -- the original bug). Target the cron-loop's
    // standalone branch specifically (runScheduledTaskNow also references
    // 'starting', but in an `|| result === 'busy'` form).
    const startingIdx = SRC.indexOf("if (result === 'starting') {")
    expect(startingIdx).toBeGreaterThan(0)
    // Slice the starting-branch up to the next else-if / busy handling.
    const busyHandlingIdx = SRC.indexOf("result === 'busy'", startingIdx)
    expect(busyHandlingIdx).toBeGreaterThan(startingIdx)
    const startingBranch = SRC.slice(startingIdx, busyHandlingIdx)
    expect(startingBranch).toMatch(/insertPendingTaskRetryIfNew/)
    // Not gated by the skipIfBusy flag (the code form `task.skipIfBusy`); a
    // mention in an explanatory comment is fine.
    expect(startingBranch).not.toMatch(/task\.skipIfBusy/)
  })

  it('documents WHY (daily batch agent), not just what', () => {
    const guardIdx = SRC.indexOf('if (!sessionExistsOnHost(')
    const rationale = SRC.slice(guardIdx, guardIdx + 900)
    expect(rationale).toMatch(/auto-start|batch agent|digest/i)
    expect(rationale).toMatch(/skipIfBusy/i)
  })
})
