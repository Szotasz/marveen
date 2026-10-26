// Schedule-runner routing for the local helper (src/web/helper/dispatch.ts),
// and the flag-off guarantee: with HELPER_ENABLED unset nothing changes --
// the router reads nothing else, the runner gets `false` for every task, the
// task files carry no new keys, and POST /api/schedules stores the same config.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import type { ScheduledTask } from '../web/scheduled-tasks-io.js'
import type { CustomProviderDef } from '../web/custom-providers.js'

// The registry gate has its own tests; here it is a passthrough (schedule-once.test.ts pattern).
vi.mock('../web/schedule-registry.js', () => ({
  filterRegisteredTasks: <T,>(tasks: T[]) => tasks,
  backfillScheduledTaskRegistryOnce: () => ({ ran: false, registered: [] }),
  verifyScheduledTask: () => ({ ok: true }),
  describeVerdict: () => '',
  registerScheduledTask: () => 'test-hash',
  unregisterScheduledTask: () => true,
}))

const __dirname = dirname(fileURLToPath(import.meta.url))
const tmpHome = mkdtempSync(join(tmpdir(), 'helper-dispatch-home-'))
const realHome = process.env.HOME
process.env.HOME = tmpHome
delete process.env.HELPER_ENABLED
delete process.env.HELPER_PROVIDER_ID

let d: typeof import('../web/helper/dispatch.js')
let io: typeof import('../web/scheduled-tasks-io.js')
let routes: typeof import('../web/routes/schedules.js')

beforeAll(async () => {
  d = await import('../web/helper/dispatch.js')
  io = await import('../web/scheduled-tasks-io.js')
  routes = await import('../web/routes/schedules.js')
})
afterAll(() => {
  process.env.HOME = realHome
  rmSync(tmpHome, { recursive: true, force: true })
})

const local: CustomProviderDef = { id: 'ollama', label: 'Ollama', baseUrl: 'http://127.0.0.1:11434', authHeader: 'none', vaultKey: null, helperModel: 'qwen3:14b' }
const task = (over: Partial<ScheduledTask> = {}): ScheduledTask => ({ name: 't', description: '', prompt: 'p', schedule: '* * * * *', agent: 'marveen', enabled: true, createdAt: 1, type: 'heartbeat', ...over })
const watchTask = () => task({ name: 'w', watch: { kind: 'kanban-comment', target: 'abc', match: 'KIADVA' } })
const rotationTask = () => task({ name: 'claude-plan-rotate-check' })

function routeDeps(over: Partial<{ enabled: boolean; id: string; provider: CustomProviderDef | null }> = {}) {
  const providerId = vi.fn(() => over.id ?? 'ollama')
  const loadProvider = vi.fn(() => (over.provider === undefined ? local : over.provider))
  return { enabled: () => over.enabled ?? true, providerId, loadProvider }
}

describe('flag off (default): byte-identical behaviour', () => {
  it('the router reads nothing beyond the flag', () => {
    const rd = routeDeps({ enabled: false })
    for (const t of [watchTask(), rotationTask(), task()]) expect(d.resolveHelperRoute(t, rd)).toEqual({ handled: false, reason: 'disabled' })
    expect(rd.providerId).not.toHaveBeenCalled()
    expect(rd.loadProvider).not.toHaveBeenCalled()
  })

  it('with the real settings (HELPER_ENABLED default 0) the runner keeps every task, no fallback fired', () => {
    expect(d.isHelperEnabled()).toBe(false)
    const fallbackRun = vi.fn(async () => {})
    for (const t of [watchTask(), rotationTask(), task(), task({ type: 'command', command: 'true' })]) {
      expect(d.helperDispatch(t, Date.now(), { fallbackRun })).toBe(false)
    }
    expect(fallbackRun).not.toHaveBeenCalled()
  })

  it('a task written without helper fields has no helper keys on disk or after reading', () => {
    io.writeScheduledTask('plain', { description: 'x', prompt: 'p', schedule: '0 9 * * *', agent: 'marveen', enabled: true, type: 'heartbeat' })
    const cfg = JSON.parse(readFileSync(join(io.SCHEDULED_TASKS_DIR, 'plain', 'task-config.json'), 'utf-8'))
    expect(Object.keys(cfg).sort()).toEqual(['agent', 'createdAt', 'description', 'enabled', 'schedule', 'type'])
    const read = io.readScheduledTask('plain')!
    expect('helperType' in read).toBe(false)
    expect('watch' in read).toBe(false)
  })

  it('a watch is carried through write and read when set', () => {
    io.writeScheduledTask('watched', { prompt: 'p', schedule: '* * * * *', type: 'heartbeat', helperType: 'watch', watch: { kind: 'kanban-comment', target: 'abc', match: 'KIADVA' } })
    expect(io.readScheduledTask('watched')).toMatchObject({ helperType: 'watch', watch: { kind: 'kanban-comment', target: 'abc', match: 'KIADVA' } })
  })

  it('an invalid watch on disk reads as no watch (the task keeps its old path)', () => {
    io.writeScheduledTask('badwatch', { prompt: 'p', schedule: '* * * * *', watch: { kind: 'nope', target: 'x' } as any })
    expect('watch' in io.readScheduledTask('badwatch')!).toBe(false)
  })
})

describe('resolveHelperRoute matrix (flag on)', () => {
  it('routes a watch and the seeded rotation heartbeat to the ticking provider', () => {
    expect(d.resolveHelperRoute(watchTask(), routeDeps())).toMatchObject({ handled: true, type: 'watch' })
    expect(d.resolveHelperRoute(task({ watch: { kind: 'time', target: '2026-10-27T08:00:00Z' } }), routeDeps())).toMatchObject({ handled: true, type: 'wake' })
    expect(d.resolveHelperRoute(rotationTask(), routeDeps())).toMatchObject({ handled: true, type: 'rotationDecision' })
  })
  it('leaves everything else on the old path', () => {
    expect(d.resolveHelperRoute(task(), routeDeps())).toMatchObject({ handled: false, reason: 'not-helper-task' })
    expect(d.resolveHelperRoute(watchTask(), routeDeps({ provider: null }))).toMatchObject({ handled: false, reason: 'no-provider' })
    expect(d.resolveHelperRoute(watchTask(), routeDeps({ provider: { ...local, taskTypes: { watch: false } } }))).toMatchObject({ handled: false, reason: 'not-ticked' })
    expect(d.resolveHelperRoute(watchTask(), routeDeps({ provider: { ...local, baseUrl: 'https://remote.example.com' } }))).toMatchObject({ handled: false, reason: 'not-ticked' })
    expect(d.resolveHelperRoute(task({ helperType: 'quietHeartbeat' }), routeDeps())).toMatchObject({ handled: false, reason: 'not-implemented' })
    expect(d.resolveHelperRoute(task({ helperType: 'watch' }), routeDeps())).toMatchObject({ handled: false, reason: 'no-watch-spec' })
    // A rotation task the operator already turned into something else is not taken over by name.
    expect(d.resolveHelperRoute(task({ name: 'claude-plan-rotate-check', type: 'command' }), routeDeps())).toMatchObject({ handled: false, reason: 'not-helper-task' })
  })
})

describe('validateHelperTaskFields', () => {
  it('absent fields -> nothing to add', () => expect(d.validateHelperTaskFields({}, 'marveen')).toEqual({}))
  it('refuses a watch the helper would not take (409), accepts it when it would', () => {
    const w = { kind: 'kanban-comment', target: 'abc', match: 'KIADVA' }
    expect(d.validateHelperTaskFields({ watch: w }, 'marveen', routeDeps({ enabled: false }))).toMatchObject({ status: 409 })
    expect(d.validateHelperTaskFields({ watch: w }, 'marveen', routeDeps())).toMatchObject({ helperType: 'watch', watch: w })
  })
  it('rejects a mismatched or unknown helperType', () => {
    expect(d.validateHelperTaskFields({ helperType: 'wake', watch: { kind: 'kanban-comment', target: 'a', match: 'x' } }, 'm', routeDeps()).error).toMatch(/does not match/)
    expect(d.validateHelperTaskFields({ helperType: 'nope' }, 'm', routeDeps()).error).toMatch(/helperType must be/)
    expect(d.validateHelperTaskFields({ helperType: 'watch' }, 'm', routeDeps()).error).toMatch(/needs a watch/)
  })
})

describe('resolveEscalationTarget', () => {
  const known = (id: string) => ['marveen', 'fejlesztes-vezeto', 'c3po'].includes(id)
  it('takes the first known candidate and never system', () => {
    expect(d.resolveEscalationTarget('fejlesztes-vezeto', 'c3po', undefined, known)).toBe('fejlesztes-vezeto')
    expect(d.resolveEscalationTarget('ghost', 'c3po', undefined, known)).toBe('c3po')
    expect(d.resolveEscalationTarget('system', 'ghost', 'c3po', (id) => id !== 'ghost' && known(id))).toBe('c3po')
  })
})

describe('POST /api/schedules with the helper off', () => {
  async function post(body: unknown) {
    const out: { status: number; body: any } = { status: 200, body: null }
    const res: any = { writeHead(s: number) { out.status = s; return res }, setHeader() { return res }, end(c?: string) { if (c) out.body = JSON.parse(c) } }
    const req: any = Readable.from([Buffer.from(JSON.stringify(body))])
    req.headers = {}
    const url = new URL('http://localhost:3420/api/schedules')
    await routes.tryHandleSchedules({ req, res, path: url.pathname, method: 'POST', url } as any)
    return out
  }
  it('an ordinary create stores exactly the keys it always did', async () => {
    const r = await post({ name: 'ordinary', description: 'd', prompt: 'p', schedule: '0 9 * * *', agent: 'marveen', type: 'heartbeat' })
    expect(r.status).toBe(200)
    const cfg = JSON.parse(readFileSync(join(io.SCHEDULED_TASKS_DIR, 'ordinary', 'task-config.json'), 'utf-8'))
    expect(Object.keys(cfg).sort()).toEqual(['agent', 'createdAt', 'description', 'enabled', 'forceSend', 'schedule', 'skipIfBusy', 'type'])
  })
  it('a watch create is refused with 409 and writes nothing', async () => {
    const r = await post({ name: 'watcher', description: 'd', prompt: 'p', schedule: '* * * * *', watch: { kind: 'kanban-comment', target: 'abc', match: 'KIADVA' } })
    expect(r.status).toBe(409)
    expect(r.body.error).toMatch(/helper_not_active/)
    expect(existsSync(join(io.SCHEDULED_TASKS_DIR, 'watcher'))).toBe(false)
  })
})

describe('schedule-runner wiring', () => {
  it('the helper branch sits right before the command branch, after the stale/catch-up decision', () => {
    const src = readFileSync(join(__dirname, '../web/schedule-runner.ts'), 'utf-8')
    const helper = src.indexOf('if (helperDispatch(task, now,')
    const command = src.indexOf("if (task.type === 'command') {\n        runCommandTask(task, now)")
    const stale = src.indexOf("const decision = decideCatchUp(task, ageMs)")
    expect(helper).toBeGreaterThan(stale)
    expect(command).toBeGreaterThan(helper)
    expect(src.slice(helper, command)).toContain('continue')
  })
})
