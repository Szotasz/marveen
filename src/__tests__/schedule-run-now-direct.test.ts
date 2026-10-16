import { beforeEach, describe, expect, it, vi } from 'vitest'

// HBFABRIC1003 follow-up (Geri's #1689 verify, mutant M10b): a manual run of a
// direct-digest task must END after the direct send. If the `return` after
// sendHeartbeatDigestDirect is lost, the digest goes out directly AND the
// session dispatch (attemptFireTask) runs too -- a double digest and a wasted
// model turn. The source-order pin in heartbeat-direct-digest.test.ts cannot
// see that, so this is a behaviour test.
//
// attemptFireTask is module-internal; its first observable step is the
// restart-lock check, so that is the probe. The stub answers "restart in
// flight", which makes attemptFireTask return 'busy' before it touches tmux:
// even under the mutant nothing reaches a live session. The tmux layer below
// it is stubbed to throw as well (see the agent-process mock).

const h = vi.hoisted(() => ({
  tasks: [] as unknown[],
  sendDirect: vi.fn(),
  restartProbe: vi.fn(() => true),
  insertRetry: vi.fn(),
}))

vi.mock('../web/scheduled-tasks-io.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/scheduled-tasks-io.js')>()),
  listScheduledTasks: () => h.tasks,
  readScheduledTask: (n: string) => (h.tasks as Array<{ name: string }>).find(t => t.name === n) ?? null,
}))

vi.mock('../web/heartbeat-direct-digest.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/heartbeat-direct-digest.js')>()),
  sendHeartbeatDigestDirect: h.sendDirect,
}))

vi.mock('../web/restart-lock.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/restart-lock.js')>()),
  isRestartInFlight: h.restartProbe,
}))

// Belt and braces (Geri's #1690 verify): the test's safety must not hang on
// attemptFireTask's internal order. If a refactor ever moves a tmux step ahead
// of the restart-lock check, these throw instead of touching a live session or
// starting the heartbeat agent on the host that runs the suite.
vi.mock('../web/agent-process.js', async (importOriginal) => {
  const unreachable = (fn: string) => () => {
    throw new Error(`schedule-run-now-direct: ${fn} must not be reached from this test`)
  }
  return {
    ...(await importOriginal<typeof import('../web/agent-process.js')>()),
    sessionExistsOnHost: unreachable('sessionExistsOnHost'),
    startAgentProcess: unreachable('startAgentProcess'),
    sendPromptToSession: unreachable('sendPromptToSession'),
    isSessionReadyForPrompt: unreachable('isSessionReadyForPrompt'),
    capturePane: unreachable('capturePane'),
  }
})

vi.mock('../db.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db.js')>()),
  insertPendingTaskRetryIfNew: h.insertRetry,
}))

const { runScheduledTaskNow } = await import('../web/schedule-runner.js')

const directTask = {
  name: 'direct-hb',
  agent: 'heartbeat',
  schedule: '0 * * * *',
  enabled: true,
  type: 'heartbeat',
  injectMetrics: true,
  sendDigestDirect: true,
}

describe('runScheduledTaskNow: a direct-digest task never reaches the session dispatch', () => {
  beforeEach(() => {
    h.sendDirect.mockReset()
    h.restartProbe.mockClear()
    h.insertRetry.mockReset()
    h.tasks = [directTask]
  })

  it('a landed direct send reports sent-direct and dispatches nothing', async () => {
    h.sendDirect.mockResolvedValue(true)
    const res = await runScheduledTaskNow('direct-hb')
    expect(res).toEqual({ ok: true, result: 'heartbeat: sent-direct' })
    expect(h.sendDirect).toHaveBeenCalledTimes(1)
    expect(h.restartProbe).not.toHaveBeenCalled()
    expect(h.insertRetry).not.toHaveBeenCalled()
  })

  it('a failed direct send is an error, and still no session dispatch', async () => {
    h.sendDirect.mockResolvedValue(false)
    const res = await runScheduledTaskNow('direct-hb')
    expect(res).toEqual({ ok: false, error: 'direct digest could not be sent' })
    expect(h.restartProbe).not.toHaveBeenCalled()
    expect(h.insertRetry).not.toHaveBeenCalled()
  })

  it('control: a non-direct heartbeat task does go through the dispatch', async () => {
    // Without this the probe could be dead (never reached on any path) and
    // the two tests above would pass for the wrong reason.
    h.tasks = [{ ...directTask, sendDigestDirect: false }]
    const res = await runScheduledTaskNow('direct-hb')
    expect(h.sendDirect).not.toHaveBeenCalled()
    expect(h.restartProbe).toHaveBeenCalledWith('heartbeat')
    expect(res).toEqual({ ok: true, result: 'heartbeat: busy' })
    expect(h.insertRetry).toHaveBeenCalledTimes(1)
  })
})
