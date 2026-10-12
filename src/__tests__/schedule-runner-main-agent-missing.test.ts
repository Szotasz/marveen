import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Contract tests for the main-agent transient-respawn fix.
//
// Root cause: the main agent's tmux session (`<id>-channels`) is
// service-managed, not a directory under AGENTS_BASE_DIR. When that session
// was transiently missing (e.g. mid-respawn) at the moment a cron task
// fired, attemptFireTask's session-missing branch called
// startAgentProcess(mainAgentId), which misreported 'Agent not found'
// (agentDir() has nothing to find for the main agent) -- a real
// config-error case, not a transient one. That 'missing' result then
// reached the pending-retry loop. Confirmed incident: a scheduled task was
// lost this way while the main channels session was mid-respawn; the
// session came back on its own 11 seconds later and fired a different task
// successfully -- proof a retry would have delivered had the row survived.
//
// Fix (minimal scope): the main agent gets its own branch in the
// session-missing guard, BEFORE startAgentProcess is called. It never
// reports 'missing' for a transiently-down main session -- it reuses the
// existing 'starting' state (bypasses skipIfBusy) and leaves actual
// recovery to the mechanisms that already own it (channel-monitor's
// down-cascade, watchdog.sh, the service manager) instead of calling a
// restart itself, which would race those and risk repeating a multi-actor
// restart outage.

const SRC = readFileSync(join(__dirname, '../web/schedule-runner.ts'), 'utf-8')

describe('schedule-runner treats a transiently-down main session as "starting", not "missing"', () => {
  const guardIdx = SRC.indexOf('if (!sessionExistsOnHost(')

  it('the missing-session guard exists', () => {
    expect(guardIdx).toBeGreaterThan(0)
  })

  it('branches on isMainAgent before ever calling startAgentProcess', () => {
    const startIdx = SRC.indexOf('startAgentProcess(agentName)', guardIdx)
    const mainBranchIdx = SRC.indexOf('if (isMainAgent)', guardIdx)
    expect(mainBranchIdx).toBeGreaterThan(guardIdx)
    expect(mainBranchIdx).toBeLessThan(startIdx)
  })

  it('the main-agent branch returns "starting", never "missing"', () => {
    const mainBranchIdx = SRC.indexOf('if (isMainAgent)', guardIdx)
    const startIdx = SRC.indexOf('startAgentProcess(agentName)', guardIdx)
    // Slice up to the (verified-later, non-main) startAgentProcess call
    // rather than the first '}' -- the logger.info(...) call's own object
    // literal closes with a '}' before the branch's actual closing brace.
    const mainBranch = SRC.slice(mainBranchIdx, startIdx)
    expect(mainBranch).toMatch(/return 'starting'/)
    expect(mainBranch).not.toMatch(/return 'missing'/)
  })

  it('documents why the scheduler defers instead of restarting the session itself', () => {
    const mainBranchIdx = SRC.indexOf('if (isMainAgent)', guardIdx)
    const rationale = SRC.slice(guardIdx, mainBranchIdx)
    expect(rationale).toMatch(/service-managed/i)
    expect(rationale).toMatch(/down-cascade|watchdog/i)
    expect(rationale).toMatch(/race/i)
  })

  it('a non-main agent with a genuinely missing directory still returns "missing"', () => {
    // The fix must not touch the pre-existing behaviour for real sub-agents:
    // a startAgentProcess failure for them still permanently drops the retry.
    const startIdx = SRC.indexOf('startAgentProcess(agentName)', guardIdx)
    const afterStart = SRC.slice(startIdx, startIdx + 700)
    expect(afterStart).toMatch(/return 'missing'/)
  })

  it('the pending-retry loop only permanently deletes on "fired", never "missing" or "starting"', () => {
    const deleteIdx = SRC.indexOf("if (result === 'fired') {")
    expect(deleteIdx).toBeGreaterThan(0)
    // Just the if-block body (up to its closing brace), not the explanatory
    // comment right after it -- that comment legitimately SAYS "'missing'"
    // while documenting why it no longer deletes.
    const ifBlockEnd = SRC.indexOf('}', deleteIdx)
    const deleteBlock = SRC.slice(deleteIdx, ifBlockEnd)
    expect(deleteBlock).not.toMatch(/'starting'/)
    expect(deleteBlock).not.toMatch(/'missing'/)
    // The never-abandon comment block right after it documents the policy
    // this test is guarding, so a careless revert reads as self-contradictory
    // in the diff, not just a silent test failure.
    expect(SRC.slice(deleteIdx, deleteIdx + 500)).toMatch(/never-abandon|abandonment/i)
  })
})
