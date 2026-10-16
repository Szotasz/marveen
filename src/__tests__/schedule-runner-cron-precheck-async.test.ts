import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AddressInfo } from 'node:net'
import type { ScheduledTask } from '../web/scheduled-tasks-io.js'

// CRONPRECHECKSYNC1007. The cron loop ran a task's pre-check with spawnSync on
// the dashboard's event loop. A pre-check that calls the dashboard's own API
// (e.g. POST /api/messages) could not get an answer while it ran: it stood
// until the 10 s limit, and its request was served only after it (measured on
// two community installs; on one, 6 of 12 timeouts had the message created
// 0.02-0.32 s after the timeout).
//
// Measured here through the REAL tick with a REAL child process: the pre-check
// script calls an HTTP server that lives in THIS process, the way a pre-check
// calls the dashboard. Only the clock is fake (Date / setTimeout / setInterval);
// child I/O and the server run for real.

const mockAppendTaskRun = vi.fn()
const mockSendPrompt = vi.fn((..._a: unknown[]) => 'sent')
const mockListScheduledTasks = vi.fn(() => [] as ScheduledTask[])

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))
vi.mock('../web/atomic-write.js', () => ({ atomicWriteFileSync: vi.fn() }))
vi.mock('../db.js', () => ({
  appendTaskRun: (...a: unknown[]) => mockAppendTaskRun(...a),
  listPendingTaskRetries: () => [],
  getPendingTaskRetry: () => undefined,
  deletePendingTaskRetry: vi.fn(),
  updatePendingTaskRetry: vi.fn(() => true),
  insertPendingTaskRetryIfNew: vi.fn(),
  markPendingTaskRetryAlert: vi.fn(() => false),
  clearPendingTaskRetryAlert: vi.fn(),
  markScheduledTaskKanbanWaiting: vi.fn(),
}))
vi.mock('../channel-provider.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../channel-provider.js')>()
  return {
    ...real,
    getProvider: (type: Parameters<typeof real.getProvider>[0]) => ({
      ...real.getProvider(type),
      sendMessage: vi.fn(async () => {}),
      sendPhoto: vi.fn(async () => {}),
    }),
  }
})
vi.mock('../web/scheduled-tasks-io.js', () => ({
  listScheduledTasks: () => mockListScheduledTasks(),
  readScheduledTask: (n: string) => (mockListScheduledTasks() as Array<{ name: string }>).find(t => t.name === n) ?? null,
  SCHEDULED_TASKS_DIR: '/tmp/marveen-cron-precheck-no-tasks-dir',
  SCHEDULED_TASK_INLINE_MAX_CHARS: 1_500,
  SCHEDULED_TASK_BODY_WARN_CHARS: 20_000,
  MAX_SCHEDULED_TASK_PROMPT_LEN: 50_000,
}))
vi.mock('../web/agent-process.js', () => ({
  clearFeedbackModalAndRecheck: () => false,
  agentSessionName: (name: string) => `agent-${name}`,
  isAgentRunning: () => true,
  isSessionReadyForPrompt: () => true,
  sendPromptToSession: (...a: unknown[]) => mockSendPrompt(...a),
  startAgentProcess: vi.fn(() => ({ ok: true })),
  sessionExistsOnHost: () => true,
  capturePane: () => null,
  sendEnterToSession: vi.fn(),
  clearStaleParkedInput: vi.fn(() => false),
  resolveAgentProvider: () => 'telegram',
}))

// The dashboard stand-in: answers on loopback, counts the requests, and can
// act on the task list while it answers (the operator acting mid-pre-check).
let server: Server
let port = 0
let served = 0
let onRequest: () => void = () => {}
// What the stand-in answers; "SKIP" makes the pre-check report nothing to do.
let answer: () => string = () => `msg-${served}`
const dir = mkdtempSync(join(tmpdir(), 'cron-precheck-'))
const scriptPath = join(dir, 'pre-check.sh')

beforeAll(async () => {
  server = createServer((_req, res) => {
    served++
    onRequest()
    res.end(answer())
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  port = (server.address() as AddressInfo).port
  // curl's own 3 s cap: on the synchronous form the server cannot answer, so
  // the script fails at its cap instead of waiting for the runner's 10 s.
  writeFileSync(scriptPath, [
    '#!/usr/bin/env bash',
    `r=$(curl -s --max-time 3 "http://127.0.0.1:${port}/api/messages") || exit 7`,
    'if [ "$r" = SKIP ]; then echo SKIP; else echo "dashboard said: $r"; fi',
    '',
  ].join('\n'), { mode: 0o755 })
})
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
  rmSync(dir, { recursive: true, force: true })
})

const TASK: ScheduledTask = {
  name: 'cron-precheck-daily',
  description: 'cron pre-check fixture',
  prompt: 'Do the thing.',
  // Every minute: an occurrence falls inside the first tick's window in ANY
  // host zone. The cron zone is the host's (SCHEDULER_TZ is read through
  // cfg() from the install .env, never from process.env, so a test cannot
  // stub it); a fixed hour matched on a Budapest host and never on the
  // ubuntu CI runner (UTC), which is how the first push went red.
  schedule: '* * * * *',
  agent: 'cronagent',
  enabled: true,
  createdAt: 0,
  type: 'task',
  targetSession: 'cron-test-session',
}

// Real-time wait for real I/O while the fake clock stands still.
async function until(cond: () => boolean, ms = 8_000): Promise<void> {
  const t0 = performance.now()
  while (!cond() && performance.now() - t0 < ms) await new Promise<void>((r) => setImmediate(r))
}

async function runOneTick(done: () => boolean) {
  vi.resetModules()
  const { startScheduleRunner, resetPreCheckAnswersForTests } = await import('../web/schedule-runner.js')
  resetPreCheckAnswersForTests()
  const stop = startScheduleRunner()
  await vi.advanceTimersByTimeAsync(5_001)
  await until(done)
  clearInterval(stop)
}

describe('the cron loop\'s pre-check runs off the event loop (CRONPRECHECKSYNC1007)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSendPrompt.mockImplementation(() => 'sent')
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    vi.setSystemTime(new Date('2026-07-31T06:00:30.000Z'))
    served = 0
    onRequest = () => {}
    answer = () => `msg-${served}`
    mockListScheduledTasks.mockReturnValue([{ ...TASK, preCheck: scriptPath }])
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('a pre-check that calls the dashboard gets its answer, and the answer reaches the fired prompt', async () => {
    await runOneTick(() => mockSendPrompt.mock.calls.length > 0)
    expect(served).toBe(1)
    const prompts = mockSendPrompt.mock.calls.map(c => String(c[1]))
    expect(prompts.length).toBe(1)
    expect(prompts[0]).toContain('dashboard said: msg-1')
    expect(prompts[0]).toContain('Do the thing.')
  })

  it('the task is disabled WHILE its pre-check runs -> no fire, and no run is recorded for it', async () => {
    onRequest = () => { mockListScheduledTasks.mockReturnValue([{ ...TASK, preCheck: scriptPath, enabled: false }]) }
    await runOneTick(() => served > 0)
    // Give the tick the rest of its run after the answer.
    await until(() => false, 1_500)
    expect(served).toBe(1)
    expect(mockSendPrompt).not.toHaveBeenCalled()
    expect(mockAppendTaskRun.mock.calls.filter(c => c[0] === TASK.name)).toEqual([])
  })

  it('...and when that pre-check answers SKIP: no skipped-precheck run is recorded for the task that is off now', async () => {
    answer = () => 'SKIP'
    onRequest = () => { mockListScheduledTasks.mockReturnValue([{ ...TASK, preCheck: scriptPath, enabled: false }]) }
    await runOneTick(() => served > 0)
    await until(() => false, 1_500)
    // The pre-check DID run (a tick that never fired would pass the next line vacuously).
    expect(served).toBe(1)
    expect(mockAppendTaskRun.mock.calls.filter(c => c[0] === TASK.name)).toEqual([])
  })

  it('control: a SKIP answer for a task that stays on IS recorded as skipped-precheck', async () => {
    answer = () => 'SKIP'
    await runOneTick(() => mockAppendTaskRun.mock.calls.length > 0)
    expect(mockSendPrompt).not.toHaveBeenCalled()
    expect(mockAppendTaskRun.mock.calls.filter(c => c[0] === TASK.name).map(c => c[2])).toEqual(['skipped-precheck'])
  })

  it('the task is deleted WHILE its pre-check runs -> no fire', async () => {
    onRequest = () => { mockListScheduledTasks.mockReturnValue([]) }
    await runOneTick(() => served > 0)
    await until(() => false, 1_500)
    expect(served).toBe(1)
    expect(mockSendPrompt).not.toHaveBeenCalled()
  })

  it('control, without a pre-check: the task fires as before', async () => {
    mockListScheduledTasks.mockReturnValue([{ ...TASK }])
    await runOneTick(() => mockSendPrompt.mock.calls.length > 0)
    expect(served).toBe(0)
    expect(mockSendPrompt).toHaveBeenCalledTimes(1)
  })
})

describe('the old synchronous form, on the same script and server: the dashboard cannot answer', () => {
  beforeEach(() => { served = 0; onRequest = () => {} })

  it('runPreCheck (spawnSync) gets no answer: the script fails at its own cap, the request is served only afterwards', async () => {
    const { runPreCheck } = await import('../web/schedule-runner.js')
    const t0 = performance.now()
    const r = runPreCheck({ ...TASK, preCheck: scriptPath })
    const heldMs = performance.now() - t0
    expect(r).toEqual({ skip: false })
    expect(served).toBe(0)
    expect(heldMs).toBeGreaterThan(2_500)
    await until(() => served > 0, 2_000)
    expect(served).toBe(1)
  }, 15_000)

  it('runPreCheckAsync on the same script gets the answer at once', async () => {
    const { runPreCheckAsync } = await import('../web/schedule-runner.js')
    const t0 = performance.now()
    const r = await runPreCheckAsync({ ...TASK, preCheck: scriptPath })
    expect(r).toEqual({ skip: false, prefix: 'dashboard said: msg-1' })
    expect(performance.now() - t0).toBeLessThan(2_500)
  })
})

// #1698 (sigee82): the time limit must end what the script started, not just
// bash. Measured there on the synchronous form; the async form had the same gap.
describe('runPreCheckAsync ends the script\'s whole process group', () => {
  const marks: string[] = []
  afterAll(() => { for (const m of marks) rmSync(m, { force: true }) })

  function grandchildScript(head: string): { file: string; mark: string } {
    const d = mkdtempSync(join(tmpdir(), 'precheck-group-'))
    const mark = join(d, 'grandchild-was-here')
    marks.push(mark)
    const file = join(d, 'pre-check.sh')
    // The grandchild is a separate program (not a bash builtin) that outlives bash.
    writeFileSync(file, [
      '#!/usr/bin/env bash',
      `python3 -c "import time,pathlib; time.sleep(2); pathlib.Path('${mark}').write_text('x')" &`,
      head,
      '',
    ].join('\n'), { mode: 0o755 })
    return { file, mark }
  }

  it('on the time limit: the answer comes at the limit, and the grandchild never writes its file', async () => {
    const { runPreCheckAsync } = await import('../web/schedule-runner.js')
    const { file, mark } = grandchildScript('sleep 30')
    const t0 = performance.now()
    const r = await runPreCheckAsync({ ...TASK, preCheck: file }, { timeoutMs: 500 })
    expect(r).toEqual({ skip: false })
    expect(performance.now() - t0).toBeLessThan(1_500)
    await new Promise((res) => setTimeout(res, 3_000))
    expect(existsSync(mark)).toBe(false)
  }, 10_000)

  it('a grandchild that ignores TERM is KILLed a second later', async () => {
    const { runPreCheckAsync } = await import('../web/schedule-runner.js')
    const d = mkdtempSync(join(tmpdir(), 'precheck-group-term-'))
    const mark = join(d, 'grandchild-was-here')
    marks.push(mark)
    const file = join(d, 'pre-check.sh')
    writeFileSync(file, `#!/usr/bin/env bash\nbash -c 'trap "" TERM; sleep 2.5; echo x > "${mark}"' &\nsleep 30\n`, { mode: 0o755 })
    expect(await runPreCheckAsync({ ...TASK, preCheck: file }, { timeoutMs: 300 })).toEqual({ skip: false })
    await new Promise((res) => setTimeout(res, 3_500))
    expect(existsSync(mark)).toBe(false)
  }, 10_000)

  it('on an oversized output: same, the grandchild is ended too', async () => {
    const { runPreCheckAsync } = await import('../web/schedule-runner.js')
    const { file, mark } = grandchildScript('head -c 5000 /dev/zero | tr "\\\\0" x; sleep 30')
    const r = await runPreCheckAsync({ ...TASK, preCheck: file }, { maxStdoutBytes: 1000 })
    expect(r).toEqual({ skip: false })
    await new Promise((res) => setTimeout(res, 3_000))
    expect(existsSync(mark)).toBe(false)
  }, 10_000)

  it('control: a script that finishes in time is not touched, its grandchild lives on', async () => {
    const { runPreCheckAsync } = await import('../web/schedule-runner.js')
    const d = mkdtempSync(join(tmpdir(), 'precheck-group-ctl-'))
    const mark = join(d, 'grandchild-was-here')
    marks.push(mark)
    const file = join(d, 'pre-check.sh')
    writeFileSync(file, `#!/usr/bin/env bash\npython3 -c "import time,pathlib; time.sleep(1); pathlib.Path('${mark}').write_text('x')" >/dev/null 2>&1 &\necho done\n`, { mode: 0o755 })
    expect(await runPreCheckAsync({ ...TASK, preCheck: file }, { timeoutMs: 5_000 })).toEqual({ skip: false, prefix: 'done' })
    await new Promise((res) => setTimeout(res, 2_000))
    expect(existsSync(mark)).toBe(true)
  }, 10_000)
})
