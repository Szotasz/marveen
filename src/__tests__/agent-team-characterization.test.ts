// AGENTCREATEPR2B-1119: the behaviour of PUT /api/agents/:name/team as it is today, pinned before its logic moves into a
// function the agent-create consumer can call (the route keeps the owner gate and calls it). Owner session, real files
// under agents/ (test-named agents, removed afterwards); nothing restarts (the route never restarts).
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const { initDatabase } = await import('../db.js')
const { tryHandleAgents } = await import('../web/routes/agents.js')
const { agentDir } = await import('../web/agent-config.js')
const { PROJECT_ROOT } = await import('../config.js')

const AGENT = '__test-teamchar-a'
const PEER = '__test-teamchar-b'
const PEER2 = '__test-teamchar-c'
const DIRS = [AGENT, PEER, PEER2].map((n) => agentDir(n))
const BASE_TEAM = { role: 'member', reportsTo: null, delegatesTo: [], autoDelegation: false, trustFrom: [] }

async function put(name: string, body: unknown) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as http.IncomingMessage
  req.headers = {}
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = { writeHead(s: number) { out.status = s; return res }, setHeader() {}, end(c?: string) { if (c) out.body = JSON.parse(c) } }
  const path = `/api/agents/${name}/team`
  const url = new URL(`http://127.0.0.1:3420${path}`)
  expect(await tryHandleAgents({ req, res, path, method: 'PUT', url, auth: { kind: 'session' } } as any, join(PROJECT_ROOT, 'web'))).toBe(true)
  return { status: out.status || 200, body: out.body }
}
const config = (name: string) => JSON.parse(readFileSync(join(agentDir(name), 'agent-config.json'), 'utf-8'))
const seed = (name: string, team: object, extra: object = {}) => {
  mkdirSync(agentDir(name), { recursive: true })
  writeFileSync(join(agentDir(name), 'CLAUDE.md'), `# ${name}\n`)
  writeFileSync(join(agentDir(name), 'agent-config.json'), JSON.stringify({ model: 'claude-opus-5', team, ...extra }, null, 2))
}

beforeAll(() => { initDatabase(':memory:') })
beforeEach(() => {
  for (const d of DIRS) rmSync(d, { recursive: true, force: true })
  seed(AGENT, BASE_TEAM, { tagline: 'old line' })
  seed(PEER, BASE_TEAM)
  seed(PEER2, BASE_TEAM)
})
afterAll(() => { for (const d of DIRS) rmSync(d, { recursive: true, force: true }) })

const A = AGENT, B = PEER, C = PEER2
describe('PUT /api/agents/:name/team today', () => {
  it('a full body: unknown names and the agent itself are dropped (warned), a non-string dropped silently, the tagline written', async () => {
    const r = await put(A, { role: 'leader', reportsTo: B, delegatesTo: [B, '__ghost', A, 7], autoDelegation: true, trustFrom: [C, '__ghost', A], tagline: 'new line' })
    const team = { role: 'leader', reportsTo: B, delegatesTo: [B], autoDelegation: true, trustFrom: [C] }
    expect(r).toEqual({ status: 200, body: { ok: true, team, tagline: 'new line', warnings: { droppedSelf: ['delegatesTo', 'trustFrom'], droppedUnknown: ['__ghost', '__ghost'] }, cycleRejected: false } })
    expect(config(A).team).toEqual(team)
    expect(config(A).tagline).toBe('new line')
  })
  it('a partial body keeps every other field, and no tagline key leaves the tagline', async () => {
    seed(A, { role: 'leader', reportsTo: B, delegatesTo: [B], autoDelegation: true, trustFrom: [C] }, { tagline: 'old line' })
    const r = await put(A, { autoDelegation: false })
    expect(r.body.team).toEqual({ role: 'leader', reportsTo: B, delegatesTo: [B], autoDelegation: false, trustFrom: [C] })
    expect(r.body.tagline).toBe('old line')
    expect(config(A).tagline).toBe('old line')
  })
  it('an unknown role keeps the current one; a blank reportsTo and a null reportsTo clear it', async () => {
    seed(A, { ...BASE_TEAM, role: 'leader', reportsTo: B })
    expect((await put(A, { role: 'boss', reportsTo: '  ' })).body.team).toMatchObject({ role: 'leader', reportsTo: null })
    seed(A, { ...BASE_TEAM, reportsTo: B })
    expect((await put(A, { reportsTo: null })).body.team.reportsTo).toBeNull()
  })
  it('a reportsTo that makes a cycle (or names the agent itself) keeps the current one and says cycleRejected', async () => {
    seed(B, { ...BASE_TEAM, reportsTo: A })
    seed(A, { ...BASE_TEAM, reportsTo: C })
    const r = await put(A, { reportsTo: B })
    expect(r.body).toMatchObject({ ok: true, cycleRejected: true, team: { reportsTo: C } })
    expect(config(A).team.reportsTo).toBe(C)
    const self = await put(A, { reportsTo: A })
    expect(self.body).toMatchObject({ cycleRejected: true, team: { reportsTo: C } })
  })
  it('an unknown reportsTo is dropped with a warning (not a cycle)', async () => {
    const r = await put(A, { reportsTo: '__ghost' })
    expect(r.body).toMatchObject({ cycleRejected: false, warnings: { droppedSelf: [], droppedUnknown: ['__ghost'] }, team: { reportsTo: null } })
  })
  it('an empty body writes the current team back unchanged', async () => {
    const r = await put(A, {})
    expect(r.body).toEqual({ ok: true, team: BASE_TEAM, tagline: 'old line', warnings: { droppedSelf: [], droppedUnknown: [] }, cycleRejected: false })
  })
  it('a missing agent: 404, nothing created', async () => {
    expect(await put('__test-teamchar-none', {})).toEqual({ status: 404, body: { error: 'Agent not found' } })
    expect(existsSync(agentDir('__test-teamchar-none'))).toBe(false)
  })
})
