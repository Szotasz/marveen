// Review of #2003, point 2: the runner's two registry checks, held by
// behaviour rather than by source text. Driven through the REAL tick
// (startScheduleRunner + fake timers), the REAL task reader on a sandbox HOME
// and the REAL registry on an in-memory SQLite; only tmux (agent-process), the
// outbound alert sink and the logger are mocked.
//
//   * the tick gate (filterRegisteredTasks at the start of the tick): a
//     planted task and a registered task edited on disk produce no send, and
//     their preCheck script never runs (the cron path runs a task's preCheck
//     from the tick's list, before the per-fire re-read);
//   * the fire-time re-check (verifyScheduledTask in currentEnabledTask): a
//     task whose files change after the tick's check, while an earlier fire of
//     the same tick awaits, is not sent -- on the cron path and on the
//     pending-retry path.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const { tmpHome, realHome } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os') as typeof import('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'schedtick-home-'))
  const prev = process.env.HOME
  process.env.HOME = dir
  return { tmpHome: dir, realHome: prev }
})

const sent = vi.hoisted(() => [] as Array<{ session: string; prompt: string }>)
// What a send does before it returns: the window between the tick's check and
// a later fire of the same tick.
const hooks = vi.hoisted(() => ({ duringSend: (_session: string) => {} }))
const mockWarn = vi.hoisted(() => vi.fn())

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: (...a: unknown[]) => mockWarn(...a), debug: vi.fn(), error: vi.fn() },
}))

vi.mock('../web/atomic-write.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../web/atomic-write.js')>()
  return {
    ...real,
    atomicWriteFileSync: (p: string, ...rest: unknown[]) => {
      if (typeof p === 'string' && p.startsWith(tmpHome)) {
        return (real.atomicWriteFileSync as (...a: unknown[]) => unknown)(p, ...rest)
      }
      return undefined
    },
  }
})

vi.mock('../channel-provider.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../channel-provider.js')>()
  return {
    ...real,
    readChannelToken: () => null,
    getProvider: (type: Parameters<typeof real.getProvider>[0]) => ({
      ...real.getProvider(type),
      sendMessage: vi.fn(async () => {}),
      sendPhoto: vi.fn(async () => {}),
    }),
  }
})

vi.mock('../web/agent-process.js', () => ({
  clearFeedbackModalAndRecheck: vi.fn(async () => false),
  agentSessionName: (name: string) => `agent-${name}`,
  isAgentRunning: () => true,
  isSessionReadyForPrompt: vi.fn(async () => true),
  sendPromptToSession: async (session: string, prompt: string) => {
    sent.push({ session, prompt })
    hooks.duringSend(session)
    return 'sent'
  },
  startAgentProcess: vi.fn(async () => ({ ok: true })),
  sessionExistsOnHost: () => true,
  capturePane: () => null,
  sendEnterToSession: vi.fn(),
  clearStaleParkedInput: vi.fn(async () => false),
  resolveAgentProvider: () => 'telegram',
  saturationRefusesDispatch: () => false,
}))

import { initDatabase, insertPendingTaskRetryIfNew, getDb } from '../db.js'
import { SCHEDULED_TASKS_DIR } from '../web/scheduled-tasks-io.js'
import { backfillScheduledTaskRegistryOnce, _resetRegistryWarningsForTest } from '../web/schedule-registry.js'
import { tryHandleSchedules } from '../web/routes/schedules.js'
import type { RouteContext } from '../web/routes/types.js'

const AGENT = 'tickagent'

function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const bodyStr = body === undefined ? '' : JSON.stringify(body)
  const req: any = {
    headers: {},
    on(event: string, cb: (chunk?: Buffer) => void) {
      if (event === 'data' && bodyStr) cb(Buffer.from(bodyStr))
      if (event === 'end') cb()
      return req
    },
  }
  const url = new URL(`http://localhost:3420${path}`)
  return tryHandleSchedules({ req, res, path: url.pathname, method, url } as RouteContext).then(handled => {
    expect(handled).toBe(true)
    return out
  })
}

async function createViaApi(name: string, prompt: string, schedule = '* * * * *'): Promise<void> {
  const r = await call('POST', '/api/schedules', {
    name, description: 'tick fixture', prompt, schedule, agent: AGENT, targetSession: `sess-${name}`,
  })
  expect(r.status).toBe(200)
}

const dirOf = (name: string) => join(SCHEDULED_TASKS_DIR, name)

// Edit a task's prompt on disk, outside the API.
function editPromptOnDisk(name: string, from: string, to: string): void {
  const p = join(dirOf(name), 'SKILL.md')
  writeFileSync(p, readFileSync(p, 'utf-8').replace(from, to))
}

// A preCheck that leaves a marker when it runs, and lets the task fire.
function addMarkerPreCheck(name: string, marker: string): void {
  writeFileSync(join(dirOf(name), 'check.sh'), `touch "${marker}"\nexit 0\n`)
  const cfgPath = join(dirOf(name), 'task-config.json')
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'))
  cfg.preCheck = 'check.sh'
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2))
}

function plant(name: string, prompt: string): void {
  mkdirSync(dirOf(name), { recursive: true })
  writeFileSync(join(dirOf(name), 'SKILL.md'), `---\nname: ${name}\ndescription: planted\n---\n\n${prompt}\n`)
  writeFileSync(join(dirOf(name), 'task-config.json'), JSON.stringify(
    { schedule: '* * * * *', agent: AGENT, enabled: true, targetSession: `sess-${name}`, createdAt: 1 }, null, 2))
}

async function runOneTick(): Promise<void> {
  const { startScheduleRunner } = await import('../web/schedule-runner.js')
  const stop = startScheduleRunner()
  // Only the startup tick (+5 s).
  await vi.advanceTimersByTimeAsync(6_000)
  clearInterval(stop)
  // The runner module (and its last-run map) lives across the tests of this
// file, so every test uses task names of its own.
// A preCheck runs as a real child process: give it real time to leave its
  // marker, so a script that did start is seen.
  vi.useRealTimers()
  await new Promise(r => setTimeout(r, 1_500))
}

const sentTo = (name: string) => sent.filter(s => s.session === `sess-${name}`)
const resetTasks = () => {
  rmSync(SCHEDULED_TASKS_DIR, { recursive: true, force: true })
  mkdirSync(SCHEDULED_TASKS_DIR, { recursive: true })
  getDb().prepare('DELETE FROM scheduled_task_registry').run()
  getDb().prepare('DELETE FROM pending_task_retries').run()
}

beforeAll(() => {
  initDatabase(':memory:')
  // The one-time upgrade backfill would trust whatever is on disk at the first
  // runner start; run it on the empty dir so it never fires inside a test.
  mkdirSync(SCHEDULED_TASKS_DIR, { recursive: true })
  expect(backfillScheduledTaskRegistryOnce().ran).toBe(true)
})

afterAll(() => {
  process.env.HOME = realHome
  rmSync(tmpHome, { recursive: true, force: true })
})

beforeEach(() => {
  vi.stubEnv('SCHEDULER_TZ', 'Europe/Budapest')
  vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date'] })
  // 10:30:00 UTC; the startup tick runs at 10:30:05 and an every-minute task is due.
  vi.setSystemTime(new Date('2026-07-31T10:30:00.000Z'))
  sent.length = 0
  hooks.duringSend = () => {}
  mockWarn.mockClear()
  _resetRegistryWarningsForTest()
  resetTasks()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe('runner tick x registry (real tick, real registry)', () => {
  it('the tick gate: a planted task and an edited registered task are not sent, and their preCheck never runs', async () => {
    await createViaApi('tick-ok', 'Registered and untouched.')
    plant('tick-planted', 'PLANTED prompt.')
    addMarkerPreCheck('tick-planted', join(tmpHome, 'planted-precheck-ran'))
    await createViaApi('tick-edited', 'Registered original.')
    editPromptOnDisk('tick-edited', 'Registered original.', 'EDITED on disk.')
    addMarkerPreCheck('tick-edited', join(tmpHome, 'edited-precheck-ran'))

    await runOneTick()

    expect(sentTo('tick-ok')).toHaveLength(1)          // control: the tick does fire
    expect(sentTo('tick-planted')).toHaveLength(0)
    expect(sentTo('tick-edited')).toHaveLength(0)
    expect(sent.some(s => s.prompt.includes('PLANTED') || s.prompt.includes('EDITED'))).toBe(false)
    expect(existsSync(join(tmpHome, 'planted-precheck-ran'))).toBe(false)
    expect(existsSync(join(tmpHome, 'edited-precheck-ran'))).toBe(false)
    const notFiring = mockWarn.mock.calls.map(c => String(c[1])).filter(m => m.includes('NOT firing'))
    expect(notFiring.some(m => m.includes('"tick-planted"'))).toBe(true)
    expect(notFiring.some(m => m.includes('"tick-edited"'))).toBe(true)
  })

  it('cron path control: two registered tasks, nothing changes -> both are sent', async () => {
    await createViaApi('cron-a', 'Prompt A original.')
    await createViaApi('cron-b', 'Prompt B original.')
    await runOneTick()
    expect(sentTo('cron-a')).toHaveLength(1)
    expect(sentTo('cron-b')).toHaveLength(1)
  })

  it('cron path: the task not yet sent is edited on disk while the first fire awaits -> it is not sent', async () => {
    await createViaApi('cronx-a', 'Prompt A original.')
    await createViaApi('cronx-b', 'Prompt B original.')
    hooks.duringSend = (session) => {
      hooks.duringSend = () => {}
      const other = session === 'sess-cronx-a' ? 'cronx-b' : 'cronx-a'
      editPromptOnDisk(other, other === 'cronx-a' ? 'Prompt A original.' : 'Prompt B original.', 'EDITED between check and fire.')
    }
    await runOneTick()
    expect(sent).toHaveLength(1)
    expect(sent.some(s => s.prompt.includes('EDITED'))).toBe(false)
  })

  it('retry path control: two pending retries, nothing changes -> both are sent', async () => {
    await createViaApi('retry-a', 'Retry A original.', '0 8 * * *')
    await createViaApi('retry-b', 'Retry B original.', '0 8 * * *')
    const t0 = Date.now() - 120_000
    insertPendingTaskRetryIfNew('retry-a', AGENT, t0, 'busy')
    insertPendingTaskRetryIfNew('retry-b', AGENT, t0 + 1, 'busy')
    await runOneTick()
    expect(sentTo('retry-a')).toHaveLength(1)
    expect(sentTo('retry-b')).toHaveLength(1)
  })

  it('retry path: the retry not yet sent is edited on disk while the first retry fire awaits -> it is not sent', async () => {
    await createViaApi('retryx-a', 'Retry A original.', '0 8 * * *')
    await createViaApi('retryx-b', 'Retry B original.', '0 8 * * *')
    const t0 = Date.now() - 120_000
    insertPendingTaskRetryIfNew('retryx-a', AGENT, t0, 'busy')
    insertPendingTaskRetryIfNew('retryx-b', AGENT, t0 + 1, 'busy')
    hooks.duringSend = (session) => {
      hooks.duringSend = () => {}
      const other = session === 'sess-retryx-a' ? 'retryx-b' : 'retryx-a'
      editPromptOnDisk(other, other === 'retryx-a' ? 'Retry A original.' : 'Retry B original.', 'EDITED between check and retry.')
    }
    await runOneTick()
    expect(sent).toHaveLength(1)
    expect(sent.some(s => s.prompt.includes('EDITED'))).toBe(false)
  })

  // The registry hash and the runner read a task's preCheck by one path rule
  // (precheck-path.ts). A non-string preCheck is no script for the hash, so it
  // is none for the runner either. Before, the runner took any truthy value
  // for a path and its `.replace` threw inside the tick: a retry of such a
  // task rejected the whole tick, and no other task fired.
  it('a registered task whose preCheck is not a string does not stop the tick', async () => {
    await createViaApi('badpc', 'Non-string preCheck.', '0 8 * * *')
    const put = await call('PUT', '/api/schedules/badpc', { preCheck: true })
    expect(put.status).toBe(200)
    await createViaApi('badpc-ctrl', 'Control prompt.')
    insertPendingTaskRetryIfNew('badpc', AGENT, Date.now() - 120_000, 'busy')

    await runOneTick()

    expect(sentTo('badpc')).toHaveLength(1)
    expect(sentTo('badpc-ctrl')).toHaveLength(1)
  })
})
