import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Contract tests for auto-starting a stopped agent for its scheduled task.
//
// Without this, a daily/intermittent agent that has no 24/7 tmux session can
// never run a scheduled task: when its cron fired, attemptFireTask found the
// session missing and returned 'missing' -- a silent skip. The task was
// enabled and scheduled but could never fire.
//
// Fix: when the session is missing, START the agent and return a distinct
// 'starting' state. The caller enqueues a retry that delivers the prompt on a
// later tick once the session is ready. That retry must bypass skipIfBusy (we
// deliberately woke the agent for its run), and a global cap bounds runaway
// relaunches of a task that never reaches a ready state.

const SRC = readFileSync(join(__dirname, '../web/schedule-runner.ts'), 'utf-8')

describe('schedule-runner auto-starts a stopped agent for its scheduled task', () => {
  it('attemptFireTask can return a distinct "starting" state', () => {
    // The return union must carry 'starting' so the caller can tell an
    // auto-start apart from a genuine busy session.
    const sig = SRC.slice(SRC.indexOf('function attemptFireTask'))
    expect(sig.slice(0, 400)).toMatch(/'starting'/)
  })

  it('the missing-session branch auto-starts the agent instead of skipping', () => {
    // Locate the sessionExists guard and assert it now launches the agent.
    const guardIdx = SRC.indexOf('if (!sessionExists) {')
    expect(guardIdx).toBeGreaterThan(0)
    const missingBlock = SRC.slice(guardIdx, guardIdx + 1200)
    expect(missingBlock).toMatch(/startAgentProcess\(agentName\)/)
    expect(missingBlock).toMatch(/return 'starting'/)
    // A failed start must fall back to 'missing' (skip this tick), not throw.
    expect(missingBlock).toMatch(/return 'missing'/)
  })

  it('the cron loop enqueues a retry for "starting" WITHOUT the skipIfBusy gate', () => {
    // The cron-loop branch that handles a 'starting' result must insert a
    // pending retry, and must NOT be guarded by task.skipIfBusy (otherwise a
    // skipIfBusy=true task would auto-start the agent and then drop the
    // delivery -- defeating the whole point). runScheduledTaskNow also
    // references 'starting', but in an `|| result === 'busy'` form, so target
    // the standalone cron branch specifically.
    const startingIdx = SRC.indexOf("if (result === 'starting') {")
    expect(startingIdx).toBeGreaterThan(0)
    const busyHandlingIdx = SRC.indexOf("result === 'busy'", startingIdx)
    expect(busyHandlingIdx).toBeGreaterThan(startingIdx)
    const startingBranch = SRC.slice(startingIdx, busyHandlingIdx)
    expect(startingBranch).toMatch(/insertPendingTaskRetryIfNew/)
    // No `task.skipIfBusy` code form in this branch (a comment mention is ok).
    expect(startingBranch).not.toMatch(/task\.skipIfBusy/)
  })

  it('bounds runaway retries so a stuck task cannot perpetually relaunch its agent', () => {
    // A retry that never resolves used to relaunch the agent forever. The
    // pending-retry loop must abandon after a fixed cap.
    expect(SRC).toMatch(/MAX_RETRY_ATTEMPTS\s*=\s*\d+/)
    expect(SRC).toMatch(/attempt_count\s*>=\s*MAX_RETRY_ATTEMPTS/)
  })
})
