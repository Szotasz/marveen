import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// AUDITBORITEKVESZ918 -- a busy-pane delivery must not be recorded as a clean run.
//
// CORRECTED 2026-09-23 (PROMPTCSONK923): the 09-18 kanban-audit prompt cited
// below arrived INTACT -- the session transcript holds all 44448 chars with the
// envelope. The "spliced" reading came from the pane, which shows only the
// tail of an overfull input box. 'fired_busy' records the send condition; what
// actually arrived is task_runs.delivery (see delivery-integrity.test.ts).
//
// Measured 2026-09-18 on the main session: ledger-live-drain fired at 16:00:08,
// memoria-heartbeat at 16:00:13, kanban-audit at 16:00:26. The third one's
// wait-until-idle gate expired (12s budget) while the agent was mid-turn, so
// the prompt was typed into a BUSY pane best-effort -- and it arrived spliced:
// no <scheduled-task> envelope and the body starting mid-line ("en/store/...").
// task_runs recorded a plain 'fired', so from the outside a corrupted delivery
// was indistinguishable from a clean run. That false green is the defect these
// tests pin: the busy-send path is now reported back to the caller and recorded
// as 'fired_busy'.
//
// Source-level assertions, matching send-prompt-force-send-gate.test.ts: the
// delivery path needs a live tmux pane, so the contract is pinned in the text.

const AGENT_PROCESS = readFileSync(join(__dirname, '../web/agent-process.ts'), 'utf-8')
const SCHEDULE_RUNNER = readFileSync(join(__dirname, '../web/schedule-runner.ts'), 'utf-8')

describe('busy-pane scheduled-task delivery is recorded distinctly', () => {
  it('sendPromptToSession offers an onBusySend callback in its opts bag', () => {
    const sigIdx = AGENT_PROCESS.indexOf('export async function sendPromptToSession(')
    expect(sigIdx).toBeGreaterThan(0)
    expect(AGENT_PROCESS.slice(sigIdx, sigIdx + 400)).toMatch(/onBusySend\?:\s*\(\)\s*=>\s*void/)
  })

  it('the callback fires on the busy fall-through, AFTER the abort branch', () => {
    // Order matters: onBusyTimeout:'abort' callers return before any keystroke,
    // so they must NOT be told a best-effort send happened.
    const abortIdx = AGENT_PROCESS.indexOf("if (opts.onBusyTimeout === 'abort') {")
    const cbIdx = AGENT_PROCESS.indexOf('opts.onBusySend?.()')
    expect(abortIdx).toBeGreaterThan(0)
    expect(cbIdx).toBeGreaterThan(abortIdx)
    // And it sits with the best-effort warn, not somewhere on the happy path.
    const warnIdx = AGENT_PROCESS.indexOf('sending best-effort')
    expect(warnIdx).toBeGreaterThan(0)
    expect(cbIdx - warnIdx).toBeLessThan(1200)
  })

  it('a throwing callback cannot break the delivery', () => {
    const cbIdx = AGENT_PROCESS.indexOf('opts.onBusySend?.()')
    const around = AGENT_PROCESS.slice(cbIdx - 200, cbIdx + 300)
    expect(around).toContain('try {')
    expect(around).toMatch(/catch \(err\)/)
  })

  it('the scheduler passes onBusySend and keeps waitForIdle tied to forceSend', () => {
    const callIdx = SCHEDULE_RUNNER.indexOf('await sendPromptToSession(session, fullPrompt, host, {')
    expect(callIdx).toBeGreaterThan(0)
    const call = SCHEDULE_RUNNER.slice(callIdx, callIdx + 300)
    expect(call).toMatch(/waitForIdle:\s*!forceSend\b/)
    expect(call).toMatch(/onBusySend:\s*\(\)\s*=>\s*\{/)
  })

  it("records 'fired_busy' for a busy-pane send and plain 'fired' otherwise", () => {
    expect(SCHEDULE_RUNNER).toContain("appendTaskRun(task.name, agentName, 'fired_busy')")
    expect(SCHEDULE_RUNNER).toContain("appendTaskRun(task.name, agentName, 'fired')")
    // The busy branch must be checked BEFORE the plain-fired else, otherwise
    // every busy send would still be booked as a clean run.
    const busyIdx = SCHEDULE_RUNNER.indexOf("} else if (busySend) {")
    const plainIdx = SCHEDULE_RUNNER.indexOf("appendTaskRun(task.name, agentName, 'fired')")
    expect(busyIdx).toBeGreaterThan(0)
    expect(busyIdx).toBeLessThan(plainIdx)
  })

  it('the late-catch-up status still wins over the busy status', () => {
    // A catch-up run is already an anomaly with its own status; the busy branch
    // must not shadow it.
    const lateIdx = SCHEDULE_RUNNER.indexOf("appendTaskRun(task.name, agentName, 'fired_late')")
    const busyIdx = SCHEDULE_RUNNER.indexOf("} else if (busySend) {")
    expect(lateIdx).toBeGreaterThan(0)
    expect(lateIdx).toBeLessThan(busyIdx)
  })

  it("'fired_busy' counts as an OPEN run, not a terminal marker", () => {
    // The half-written patch stopped at the scheduler. appendTaskRun stamps
    // completed_at immediately for any status OUTSIDE this set, so without the
    // addition a busy-pane run would be booked as finished at injection time --
    // and the path that authenticates a wrapper-less prompt by finding an OPEN
    // task_runs row would not find it, exactly for the deliveries most likely
    // to arrive without their envelope.
    const DB = readFileSync(join(__dirname, '../db.ts'), 'utf-8')
    expect(DB).toMatch(/OPEN_TASK_RUN_STATUSES[^\n]*'fired_busy'/)
    // The historical backfill marks every non-open status closed at ts; it must
    // carry the same list, or the migration would close these rows on startup.
    const backfill = DB.slice(DB.indexOf('UPDATE task_runs SET completed_at = ts'))
    expect(backfill.slice(0, 200)).toContain("'fired_busy'")
  })

  it('busySend is declared per fire, not module-wide', () => {
    // A module-level flag would leak one task's busy state onto the next.
    expect(SCHEDULE_RUNNER).toMatch(/let busySend = false/)
    const declIdx = SCHEDULE_RUNNER.indexOf('let busySend = false')
    const callIdx = SCHEDULE_RUNNER.indexOf('await sendPromptToSession(session, fullPrompt, host, {')
    expect(declIdx).toBeLessThan(callIdx)
    expect(callIdx - declIdx).toBeLessThan(600)
  })
})
