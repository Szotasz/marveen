import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Contract tests for Finding 4: forceSend must skip the pre-flight
// wait-until-idle gate inside sendPromptToSession.
//
// Root cause: the wait-until-idle gate (added to fix the busy-stuck class) was
// made unconditional in sendPromptToSession. But a scheduled task with
// forceSend=true is documented to BYPASS the busy-state check so it does not
// pile up retries against a session that stays busy for hours (the overnight
// 275-retry loop). An unconditional 12s idle wait silently re-introduces that
// per-tick block. The fix threads an optional waitForIdle flag (default true,
// gate ON for every other caller) and the forceSend path opts out.

const AGENT_PROCESS = readFileSync(join(__dirname, '../web/agent-process.ts'), 'utf-8')
const SCHEDULE_RUNNER = readFileSync(join(__dirname, '../web/schedule-runner.ts'), 'utf-8')

describe('sendPromptToSession waitForIdle gate', () => {
  it('sendPromptToSession accepts a waitForIdle option', () => {
    const sigIdx = AGENT_PROCESS.indexOf('export async function sendPromptToSession(')
    expect(sigIdx).toBeGreaterThan(0)
    const sig = AGENT_PROCESS.slice(sigIdx, sigIdx + 300)
    // The opts bag grew onBusyTimeout/idleTimeoutMs for the inbox-nudge
    // watcher (an OPTIONAL prompt aborts instead of best-effort-typing into a
    // busy pane); waitForIdle stays the first, default-ON member.
    expect(sig).toMatch(/opts:\s*\{\s*waitForIdle\?:\s*boolean;\s*onBusyTimeout\?:\s*'send'\s*\|\s*'abort';\s*idleTimeoutMs\?:\s*number\s*\}/)
  })

  it('the gate defaults ON (waitForIdle !== false) so all other callers keep it', () => {
    // The default must be ON: only an explicit waitForIdle:false opts out.
    expect(AGENT_PROCESS).toMatch(/const waitForIdle = opts\.waitForIdle !== false/)
    // And the wait is guarded by that flag, not called unconditionally.
    // waitForPaneIdle is async now (off the event loop), so the gate awaits it.
    expect(AGENT_PROCESS).toMatch(/if \(waitForIdle && !\(await waitForPaneIdle\(session, host, opts\.idleTimeoutMs\)\)\)/)
    // No unconditional `if (!waitForPaneIdle(` remains.
    expect(AGENT_PROCESS).not.toMatch(/^\s*if \(!\(?await waitForPaneIdle\(session, host\)\)?\) \{/m)
  })

  it('onBusyTimeout defaults to the historical best-effort send; abort is explicit opt-in', () => {
    // The abort branch must be gated on the EXPLICIT 'abort' value so every
    // existing caller (router, scheduler, monitors) keeps must-deliver
    // semantics, and it must return before any keystroke reaches the pane.
    const abortIdx = AGENT_PROCESS.indexOf("if (opts.onBusyTimeout === 'abort') {")
    expect(abortIdx).toBeGreaterThan(0)
    expect(AGENT_PROCESS.slice(abortIdx, abortIdx + 300)).toContain("return 'aborted-busy'")
  })

  it('the forceSend scheduled-task path opts out of the idle wait', () => {
    const callIdx = SCHEDULE_RUNNER.indexOf('sendPromptToSession(session, fullPrompt, host')
    expect(callIdx).toBeGreaterThan(0)
    const call = SCHEDULE_RUNNER.slice(callIdx, callIdx + 120)
    // waitForIdle is the negation of forceSend: ON for normal tasks, OFF for
    // forceSend so a long-busy session is not blocked on the 12s gate.
    expect(call).toMatch(/\{\s*waitForIdle:\s*!task\.forceSend\s*\}/)
  })

  it('documents WHY forceSend skips the gate', () => {
    const callIdx = SCHEDULE_RUNNER.indexOf('sendPromptToSession(session, fullPrompt, host')
    const rationale = SCHEDULE_RUNNER.slice(Math.max(0, callIdx - 500), callIdx)
    expect(rationale).toMatch(/forceSend/)
    expect(rationale).toMatch(/idle|busy|queue/i)
  })
})
