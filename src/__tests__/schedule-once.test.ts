// A task-config "once": true schedule is switched off after its first SUCCESSFUL run (card 7d2b49b4).
//
// The fleet writes one-off wake-ups as a dated cron ("0 5 22 9 *") with "EGYSZERI" in the description. The
// runner knew no such thing as a one-off: the cron fires again every year, so every one of them had to be
// switched off by hand -- and a sub-agent cannot do that itself (the self-pace gate refuses every write to the
// schedule API, deliberately). Measured on one install: 433 of 485 schedules were date-bound, 62 still enabled.
// The fix is at the source, not at the gate: the runner switches a "once" task off itself.
//
// "Successful" is measured, not assumed: a prompt task counts when its run closed 'done' (the session worked on
// it and went idle) AND the transcript shows the prompt arrived intact; a command task counts on exit 0. A
// damaged, unverifiable, abandoned or lost run leaves the task enabled, so it stays visible.
//
// SANDBOX: os.homedir() reads $HOME and SCHEDULED_TASKS_DIR is fixed at import, so HOME points at a throwaway
// directory BEFORE any module that reaches scheduled-tasks-io is imported.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpHome = mkdtempSync(join(tmpdir(), 'schedule-once-home-'))
const realHome = process.env.HOME
process.env.HOME = tmpHome

let io: typeof import('../web/scheduled-tasks-io.js')
let route: typeof import('../web/routes/schedules.js')

beforeAll(async () => {
  io = await import('../web/scheduled-tasks-io.js')
  route = await import('../web/routes/schedules.js')
})
afterAll(() => {
  process.env.HOME = realHome
  rmSync(tmpHome, { recursive: true, force: true })
})

const dirOf = (name: string) => join(io.SCHEDULED_TASKS_DIR, name)
const cfgOf = (name: string) => JSON.parse(readFileSync(join(dirOf(name), 'task-config.json'), 'utf-8')) as Record<string, unknown>
const rawOf = (name: string, file: string) => readFileSync(join(dirOf(name), file), 'utf-8')

function fixture(name: string, config: Record<string, unknown>, withSkill = true): void {
  mkdirSync(dirOf(name), { recursive: true })
  if (withSkill) writeFileSync(join(dirOf(name), 'SKILL.md'), `---\nname: ${name}\ndescription: fixture\n---\n\nrun it\n`)
  writeFileSync(join(dirOf(name), 'task-config.json'), JSON.stringify(config, null, 2))
}

beforeEach(() => { rmSync(io.SCHEDULED_TASKS_DIR, { recursive: true, force: true }) })

describe('the sandbox holds', () => {
  it('SCHEDULED_TASKS_DIR is under the throwaway HOME', () => {
    expect(io.SCHEDULED_TASKS_DIR.startsWith(tmpHome)).toBe(true)
  })
})

describe('isOnceRunSuccess: a run closed done AND delivered intact, nothing else', () => {
  it('done + intact is a success', () => {
    expect(io.isOnceRunSuccess('done', 'intact')).toBe(true)
  })
  it('done with a damaged, unverifiable or missing verdict is not', () => {
    for (const v of ['head-lost', 'tail-lost', 'split', 'spliced', 'paste-wrapped', 'not-arrived', 'unverifiable', undefined, null]) {
      expect(io.isOnceRunSuccess('done', v as never)).toBe(false)
    }
  })
  it('abandoned and lost are never a success, even with an intact delivery', () => {
    expect(io.isOnceRunSuccess('abandoned', 'intact')).toBe(false)
    expect(io.isOnceRunSuccess('lost', 'intact')).toBe(false)
  })
})

describe('disableOnceTask: only task-config.json, only a once task that is still on', () => {
  it('a once task is switched off with a timestamp, every other field kept', () => {
    fixture('egyszeri', { schedule: '0 5 22 9 *', agent: 'proba-ugynok', enabled: true, once: true, type: 'heartbeat', createdAt: 1 })
    expect(io.disableOnceTask('egyszeri', Date.UTC(2026, 8, 22, 5, 1, 2))).toBe(true)
    expect(cfgOf('egyszeri')).toEqual({
      schedule: '0 5 22 9 *', agent: 'proba-ugynok', enabled: false, once: true, type: 'heartbeat', createdAt: 1,
      onceDisabledAt: '2026-09-22T05:01:02.000Z',
    })
  })
  it('without once: false, and the file is byte-identical (today\'s behaviour)', () => {
    fixture('ismetlodo', { schedule: '0 9 * * *', agent: 'proba-ugynok', enabled: true })
    const before = rawOf('ismetlodo', 'task-config.json')
    expect(io.disableOnceTask('ismetlodo', Date.now())).toBe(false)
    expect(rawOf('ismetlodo', 'task-config.json')).toBe(before)
  })
  it('once: false is not once', () => {
    fixture('nem-egyszeri', { schedule: '0 9 * * *', enabled: true, once: false })
    const before = rawOf('nem-egyszeri', 'task-config.json')
    expect(io.disableOnceTask('nem-egyszeri', Date.now())).toBe(false)
    expect(rawOf('nem-egyszeri', 'task-config.json')).toBe(before)
  })
  it('an already disabled once task is left as it is', () => {
    fixture('mar-ki', { schedule: '0 5 22 9 *', enabled: false, once: true })
    const before = rawOf('mar-ki', 'task-config.json')
    expect(io.disableOnceTask('mar-ki', Date.now())).toBe(false)
    expect(rawOf('mar-ki', 'task-config.json')).toBe(before)
  })
  it('SKILL.md is untouched, and a command task without SKILL.md does not get one', () => {
    fixture('prompt-egyszeri', { schedule: '0 5 22 9 *', enabled: true, once: true })
    const skill = rawOf('prompt-egyszeri', 'SKILL.md')
    fixture('parancs-egyszeri', { schedule: '0 5 22 9 *', enabled: true, once: true, type: 'command', command: 'true' }, false)
    expect(io.disableOnceTask('prompt-egyszeri', Date.now())).toBe(true)
    expect(io.disableOnceTask('parancs-egyszeri', Date.now())).toBe(true)
    expect(rawOf('prompt-egyszeri', 'SKILL.md')).toBe(skill)
    expect(existsSync(join(dirOf('parancs-egyszeri'), 'SKILL.md'))).toBe(false)
  })
  it('a corrupt task-config.json is refused, not rewritten', () => {
    mkdirSync(dirOf('romlott'), { recursive: true })
    writeFileSync(join(dirOf('romlott'), 'task-config.json'), '{"once": true, "enabled": tr')
    expect(() => io.disableOnceTask('romlott', Date.now())).toThrow(/not valid JSON; refusing to overwrite it/)
    expect(rawOf('romlott', 'task-config.json')).toBe('{"once": true, "enabled": tr')
  })
  it('a missing task is not an error and creates nothing', () => {
    expect(io.disableOnceTask('nincs-ilyen', Date.now())).toBe(false)
    expect(existsSync(dirOf('nincs-ilyen'))).toBe(false)
  })
  it('another task is not touched', () => {
    fixture('egyik', { schedule: '0 5 22 9 *', enabled: true, once: true })
    fixture('masik', { schedule: '0 5 22 9 *', enabled: true, once: true })
    const other = rawOf('masik', 'task-config.json')
    io.disableOnceTask('egyik', Date.now())
    expect(rawOf('masik', 'task-config.json')).toBe(other)
  })
})

describe('the field travels: reader, writer, API', () => {
  it('readScheduledTask reports once and onceDisabledAt; absent once reads as false', () => {
    fixture('olvasott', { schedule: '0 5 22 9 *', enabled: false, once: true, onceDisabledAt: '2026-09-22T05:01:02.000Z' })
    fixture('sima', { schedule: '0 9 * * *', enabled: true })
    expect(io.readScheduledTask('olvasott')).toMatchObject({ once: true, enabled: false, onceDisabledAt: '2026-09-22T05:01:02.000Z' })
    expect(io.readScheduledTask('sima')).toMatchObject({ once: false })
    expect(io.readScheduledTask('sima')!.onceDisabledAt).toBeUndefined()
  })

  function fakeCtx(method: string, path: string, body: unknown) {
    const req = new EventEmitter() as never as import('../web/routes/types.js').RouteContext['req'] & { destroy(): void }
    ;(req as unknown as { headers: Record<string, string> }).headers = {}
    ;(req as { destroy(): void }).destroy = () => {}
    const state = { statusCode: 0, body: '' }
    const res = {
      writeHead(code: number) { state.statusCode = code; return res },
      end(data?: unknown) { state.body = String(data ?? '') },
      setHeader() {},
    } as never
    process.nextTick(() => {
      ;(req as unknown as EventEmitter).emit('data', Buffer.from(JSON.stringify(body)))
      ;(req as unknown as EventEmitter).emit('end')
    })
    return { ctx: { req, res, path, method, url: new URL(`http://localhost${path}`), fedPeer: null } as never, state }
  }
  async function call(method: string, path: string, body: unknown) {
    const { ctx, state } = fakeCtx(method, path, body)
    expect(await route.tryHandleSchedules(ctx)).toBe(true)
    return state
  }

  it('POST /api/schedules keeps once: true; without it the config has no once', async () => {
    expect((await call('POST', '/api/schedules', { name: 'uj-egyszeri', prompt: 'p', schedule: '0 5 22 9 *', agent: 'proba-ugynok', once: true })).statusCode).toBe(200)
    expect(cfgOf('uj-egyszeri').once).toBe(true)
    expect((await call('POST', '/api/schedules', { name: 'uj-sima', prompt: 'p', schedule: '0 9 * * *', agent: 'proba-ugynok' })).statusCode).toBe(200)
    expect('once' in cfgOf('uj-sima')).toBe(false)
  })

  it('PUT /api/schedules/<name> sets and clears once', async () => {
    fixture('frissitett', { schedule: '0 5 22 9 *', agent: 'proba-ugynok', enabled: true })
    expect((await call('PUT', '/api/schedules/frissitett', { once: true })).statusCode).toBe(200)
    expect(cfgOf('frissitett').once).toBe(true)
    expect((await call('PUT', '/api/schedules/frissitett', { once: false })).statusCode).toBe(200)
    expect(cfgOf('frissitett').once).toBe(false)
  })

  it('a once that is not a boolean is refused on both routes, and nothing is written', async () => {
    const post = await call('POST', '/api/schedules', { name: 'rossz', prompt: 'p', schedule: '0 5 22 9 *', once: 'yes' })
    expect(post.statusCode).toBe(400)
    expect(existsSync(dirOf('rossz'))).toBe(false)
    fixture('rossz-put', { schedule: '0 5 22 9 *', enabled: true })
    const before = rawOf('rossz-put', 'task-config.json')
    expect((await call('PUT', '/api/schedules/rossz-put', { once: 1 })).statusCode).toBe(400)
    expect(rawOf('rossz-put', 'task-config.json')).toBe(before)
  })
})

describe('the runner and the command path call it, and only on success (source level: the sweep needs a live install)', () => {
  const SRC = join(__dirname, '..', 'web')
  const RUNNER = readFileSync(join(SRC, 'schedule-runner.ts'), 'utf-8')
  const COMMAND = readFileSync(join(SRC, 'command-task.ts'), 'utf-8')

  it("the sweep's 'done' branch settles a once task with the run's delivery verdict", () => {
    const at = RUNNER.indexOf("if (decision === 'done') {\n          lostRedeliveryCounts.delete")
    expect(at).toBeGreaterThan(-1)
    const branch = RUNNER.slice(at, RUNNER.indexOf('\n        }', at))
    expect(branch).toContain('settleOnceAfterRun(entry.taskName, decision, entry.deliveryVerdict')
  })
  it('the command path switches off only when the command succeeded', () => {
    expect(COMMAND).toMatch(/if \(ok && task\.once\) \{[\s\S]{0,400}disableOnceTask\(task\.name, now\)/)
  })
})
