// Card 12b0f698: GET /api/schedules leaves the prompts out unless asked (?include=prompt); about
// 2338 tasks travel on every read and most readers want a name, a cron or a flag. The prompt's
// length and sha256 stay in the list form. The dashboard's schedule editor fills its prompt
// from the list, so the UI asks for the prompts.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import type { RouteContext } from '../web/routes/types.js'

// os.homedir() reads $HOME on POSIX and SCHEDULED_TASKS_DIR is computed at import, so HOME
// points at a temp dir BEFORE the modules load (the #796 tombstone test's pattern).
const tmpHome = mkdtempSync(join(tmpdir(), 'schedules-list-home-'))
const realHome = process.env.HOME
process.env.HOME = tmpHome

let routes: typeof import('../web/routes/schedules.js')
let io: typeof import('../web/scheduled-tasks-io.js')

const PROMPT = 'Ellenorizd a napi T1-sort, es irj egy sort a lapra. Ekezet: árvíztűrő tükörfúrógép.'

beforeAll(async () => {
  io = await import('../web/scheduled-tasks-io.js')
  routes = await import('../web/routes/schedules.js')
  io.writeScheduledTask('lista-proba', { description: 'proba', prompt: PROMPT, schedule: '5 4 * * *', agent: 'marveen', enabled: true })
})

afterAll(() => {
  process.env.HOME = realHome
  rmSync(tmpHome, { recursive: true, force: true })
})

async function get(query: string) {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    setHeader() { return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const req: any = Readable.from([])
  req.headers = {}
  const url = new URL(`http://localhost:3420/api/schedules${query}`)
  expect(await routes.tryHandleSchedules({ req, res, path: url.pathname, method: 'GET', url } as RouteContext)).toBe(true)
  return out
}

describe('GET /api/schedules: prompts only on request (card 12b0f698)', () => {
  it('by default no task carries its prompt; its length and sha256 do', async () => {
    const r = await get('')
    expect(r.status).toBe(200)
    const task = (r.body as any[]).find((t) => t.name === 'lista-proba')
    expect(task).toBeDefined()
    expect('prompt' in task).toBe(false)
    expect(task.promptLength).toBe(io.listScheduledTasks().find((t) => t.name === 'lista-proba')!.prompt.length)
    expect(task.promptSha256).toBe(createHash('sha256').update(io.listScheduledTasks().find((t) => t.name === 'lista-proba')!.prompt).digest('hex'))
    expect(task.schedule).toBe('5 4 * * *')
    expect(task.agent).toBe('marveen')
    expect(task.enabled).toBe(true)
    expect((r.body as any[]).every((t) => !('prompt' in t))).toBe(true)
  })

  it('?include=prompt gives the tasks exactly as stored, plus the registry verdict', async () => {
    const r = await get('?include=prompt')
    expect(r.status).toBe(200)
    // Every row carries the schedule-registry verdict; the rest is the stored task.
    expect((r.body as any[]).every((t) => typeof t.registry === 'string')).toBe(true)
    const stored = (r.body as any[]).map(({ registry: _r, ...t }) => t)
    expect(stored).toEqual(JSON.parse(JSON.stringify(io.listScheduledTasks())))
    expect((r.body as any[]).find((t) => t.name === 'lista-proba').prompt).toContain('árvíztűrő')
  })

  it('any other include value is a 400 that names the accepted one', async () => {
    const r = await get('?include=description')
    expect(r.status).toBe(400)
    expect(r.body.accepted).toEqual(['prompt'])
  })

  it('withoutPrompt keeps every other field', () => {
    const task = io.listScheduledTasks().find((t) => t.name === 'lista-proba')!
    const slim = routes.withoutPrompt(task)
    const { prompt: _drop, ...rest } = task
    expect(slim).toEqual({ ...rest, promptLength: task.prompt.length, promptSha256: createHash('sha256').update(task.prompt).digest('hex') })
  })
})

describe('the dashboard schedule editor still gets the prompt (card 12b0f698)', () => {
  // The editor fills its prompt field from the loaded list (openEditSchedule reads
  // task.prompt); without the prompts there it would open empty, and a save would write
  // the empty prompt back. web/app.js has no browser harness here, so this pins the call.
  it('loadSchedules asks for include=prompt, the idle-flush hint does not need it', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
    const app = readFileSync(join(root, 'web', 'app.js'), 'utf-8')
    const load = app.slice(app.indexOf('async function loadSchedules()'), app.indexOf('async function loadPendingRetries()'))
    expect(load).toContain("fetch('/api/schedules?include=prompt')")
    const edit = app.slice(app.indexOf('function openEditSchedule(task)'), app.indexOf('// Save schedule (create or update)'))
    expect(edit).toContain("document.getElementById('schedulePrompt').value = task.prompt || ''")
  })
})
