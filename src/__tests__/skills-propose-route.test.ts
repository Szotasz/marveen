// D4: POST /api/skills/propose queues a complete SKILL.md for the GLOBAL root; approval stays owner-only.
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpHome = mkdtempSync(join(tmpdir(), 'skills-propose-home-'))
const tmpRoot = mkdtempSync(join(tmpdir(), 'skills-propose-root-'))
const realHome = process.env.HOME
process.env.HOME = tmpHome
afterAll(() => { process.env.HOME = realHome; rmSync(tmpHome, { recursive: true, force: true }); rmSync(tmpRoot, { recursive: true, force: true }) })

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  PROJECT_ROOT: tmpRoot, STORE_DIR: join(tmpRoot, 'store'), MAIN_AGENT_ID: 'host-main',
}))

const q = await import('../web/skill-quarantine.js')
const { tryHandleSkills } = await import('../web/routes/skills.js')
const { tryHandleAuth } = await import('../web/routes/auth.js')
const { initDatabase, getDb } = await import('../db.js')
const { _clearSessionCacheForTest } = await import('../web/auth-sessions.js')
type Auth = import('../web/routes/types.js').RouteContext['auth']

async function call(method: string, path: string, body: unknown, auth: Auth, handler = tryHandleSkills) {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = { writeHead(s: number) { out.status = s; return res }, setHeader() {}, end(c?: string) { if (c) try { out.body = JSON.parse(c) } catch { out.body = c } } }
  const raw = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
  const req = Readable.from(raw) as unknown as http.IncomingMessage
  req.headers = {}
  const url = new URL(`http://localhost${path}`)
  expect(await handler({ req, res, path: url.pathname, method, url, auth } as any)).toBe(true)
  return out
}
const TOKEN: Auth = { kind: 'token', agent: 'soma' }
const GLOBAL = join(tmpHome, '.claude', 'skills')
const MD = '---\nname: good-skill\ndescription: x\n---\n# x\n'
const propose = (body: unknown) => call('POST', '/api/skills/propose', body, TOKEN)

beforeAll(() => { process.env.NODE_ENV = 'test'; initDatabase(':memory:') })
beforeEach(() => {
  rmSync(GLOBAL, { recursive: true, force: true })
  rmSync(join(tmpRoot, 'store'), { recursive: true, force: true })
  getDb().exec('DELETE FROM auth_sessions; DELETE FROM dashboard_users')
  _clearSessionCacheForTest()
})

describe('POST /api/skills/propose', () => {
  it('R1: queues the proposal, nothing goes live', async () => {
    const r = await propose({ name: 'good-skill', skill_md: MD, reason: 'why' })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ ok: true, pending: true, replaces: false })
    expect(typeof r.body.id).toBe('string')
    expect(q.getPending(r.body.id)!.reason).toBe('why')
    expect(q.getPending(r.body.id)!.proposedBy).toBe('soma')
    expect(existsSync(join(GLOBAL, 'good-skill'))).toBe(false)
  })

  it('R2: 400 for bad input', async () => {
    for (const b of [
      { name: 'Bad_Name', skill_md: MD },
      { name: '../x', skill_md: MD },
      { name: 'good-skill' },
      { name: 'good-skill', skill_md: '   ' },
      { name: 'good-skill', skill_md: 'a'.repeat(q.MAX_PROPOSED_SKILL_BYTES + 1) },
      'not json',
    ]) expect((await propose(b)).status).toBe(400)
  })

  it('R3: the same name twice is 409', async () => {
    expect((await propose({ name: 'good-skill', skill_md: MD })).status).toBe(200)
    expect((await propose({ name: 'good-skill', skill_md: MD })).status).toBe(409)
  })

  it('R4: a live name is a replacement', async () => {
    mkdirSync(join(GLOBAL, 'good-skill'), { recursive: true })
    writeFileSync(join(GLOBAL, 'good-skill', 'SKILL.md'), 'old')
    const r = await propose({ name: 'good-skill', skill_md: MD })
    expect(r.status).toBe(200)
    expect(r.body.replaces).toBe(true)
  })

  it('R5: the shared token cannot approve a proposed skill', async () => {
    await call('POST', '/api/auth/users', { username: 'owner', password: 'super-secret-pw' }, TOKEN, tryHandleAuth)
    const r = await propose({ name: 'good-skill', skill_md: MD })
    const hash = (await call('GET', `/api/skills/pending/${r.body.id}`, undefined, TOKEN)).body.hash
    const a = await call('POST', `/api/skills/pending/${r.body.id}/approve`, { hash }, TOKEN)
    expect(a.status).toBe(403)
    expect(existsSync(join(GLOBAL, 'good-skill'))).toBe(false)
  })
})
