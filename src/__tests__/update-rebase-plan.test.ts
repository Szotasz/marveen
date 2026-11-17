// AUTOUPDATEDIVERG1110 2nd PR: the server side of the owner-approved rebase, measured on real git in a temporary
// root (PROJECT_ROOT is mocked to it, as updates-preflight-async.test.ts does), with a real in-memory database.
//  - the plan's hash is the shell's hash (parity with scripts/lib/update-rebase-go.sh);
//  - GET /api/updates/rebase-plan writes nothing (Dani F3): refs and FETCH_HEAD are byte-identical before/after;
//  - POST /api/updates/rebase-approve is owner-only, binds what the dialog showed (Dani F2), one-step row;
//  - POST /api/updates/apply with rebaseApproval: every refusal is a 409 before anything runs; a valid one starts
//    update.sh with the approval id as the only rebase input (Dani F1).
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Readable } from 'node:stream'
import { setTimeout as sleep } from 'node:timers/promises'

const savedGitEnv: Record<string, string> = {}
for (const k of Object.keys(process.env)) {
  if (k.startsWith('GIT_')) { savedGitEnv[k] = process.env[k]!; delete process.env[k] }
}
afterAll(() => { Object.assign(process.env, savedGitEnv) })

const H = vi.hoisted(() => ({ root: '' }))
vi.mock('../config.js', async (orig) => {
  const a = await orig<typeof import('../config.js')>()
  return { ...a, PROJECT_ROOT: H.root, STORE_DIR: `${H.root}/store-dir`, MAIN_AGENT_ID: 'fo-agens' }
})
const base = mkdtempSync(join(tmpdir(), 'upd-rebase-plan-'))
H.root = join(base, 'inst')
afterAll(() => { rmSync(base, { recursive: true, force: true }) })

const { tryHandleUpdates } = await import('../web/routes/updates.js')
const { initDatabase, getApproval, createApproval, resolveApproval } = await import('../db.js')
const { rebaseHash, computeRebasePlan } = await import('../update-rebase-plan.js')
const config = await import('../config.js')
if (config.PROJECT_ROOT !== H.root) throw new Error('refusing to run: PROJECT_ROOT is not the temporary root')

const ROOT = join(__dirname, '..', '..')
const LIB = join(ROOT, 'scripts', 'lib', 'update-rebase-go.sh')
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const g = (cwd: string, ...args: string[]) => execFileSync('/usr/bin/git', args, { cwd, env, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const inst = H.root
const seed = join(base, 'seed')
const commit = (cwd: string, file: string, text: string, msg: string) => { writeFileSync(join(cwd, file), text); g(cwd, 'add', '-A'); g(cwd, 'commit', '-qm', msg) }

beforeAll(() => {
  g(base, 'init', '-q', '--bare', '-b', 'main', 'origin.git')
  g(base, 'clone', '-q', join(base, 'origin.git'), 'seed')
  g(seed, 'checkout', '-q', '-b', 'main')
  commit(seed, 'a.txt', 'a\n', 'c1')
  writeFileSync(join(seed, 'package.json'), '{"name":"t"}\n'); writeFileSync(join(seed, 'package-lock.json'), '{}\n')
  g(seed, 'add', '-A'); g(seed, 'commit', '-qm', 'pkg'); g(seed, 'push', '-q', 'origin', 'main')
  g(base, 'clone', '-q', join(base, 'origin.git'), 'inst')
  mkdirSync(join(inst, 'store'), { recursive: true }); mkdirSync(join(inst, 'store-dir'), { recursive: true })
  writeFileSync(join(inst, '.git', 'info', 'exclude'), 'store/\nstore-dir/\nupdate.sh\nENV.out\n')
  commit(inst, 'local.txt', 'l\n', 'local: our fix')
  commit(seed, 'b.txt', 'b\n', 'c2'); g(seed, 'push', '-q', 'origin', 'main')   // upstream moved, NOT fetched
  // a stub update.sh: records what the route passes, then exits (no real update runs)
  writeFileSync(join(inst, 'update.sh'), '#!/bin/bash\nenv | grep -E "^UPDATE_(REBASE_APPROVAL|AUTO_REBASE)=" > "$(dirname "$0")/ENV.out"; echo done >> "$(dirname "$0")/ENV.out"\n', { mode: 0o755 })
})

let owner = ''
beforeEach(async () => {
  initDatabase(':memory:')
  owner = 'tulaj'
})

type Out = { status: number; json: any }
async function call(method: string, path: string, body?: unknown, auth?: { kind: 'session'; user: string } | { kind: 'token' }): Promise<Out> {
  const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), { headers: { 'content-type': 'application/json' } })
  let status = 0; let out = ''
  const res = { setHeader() {}, writeHead(s: number) { status = s }, end(b?: string) { out = b ?? '' } }
  const handled = await tryHandleUpdates({ req, res, path, method, url: new URL(`http://localhost${path}`), auth } as any)
  expect(handled).toBe(true)
  return { status, json: out ? JSON.parse(out) : null }
}
const AS_OWNER = { kind: 'session' as const, user: 'tulaj' }
const snapshot = () => [g(inst, 'for-each-ref', '--format=%(refname) %(objectname)'), existsSync(join(inst, '.git', 'FETCH_HEAD')) ? statSync(join(inst, '.git', 'FETCH_HEAD')).mtimeMs : 'none', existsSync(join(inst, '.git', 'packed-refs')) ? readFileSync(join(inst, '.git', 'packed-refs'), 'utf-8') : 'none'].join('\n---\n')

describe('the rebase plan', () => {
  it('its hash is the shell lib hash for the same branch, head and target', () => {
    const h = 'a'.repeat(40); const t = 'b'.repeat(40)
    const shell = execFileSync('/bin/bash', ['-c', `. "${LIB}"; update_rebase_hash "$1" "$2" "$3"`, 'x', 'main', h, t], { encoding: 'utf-8' })
    expect(rebaseHash('main', h, t)).toBe(shell)
  })

  it('GET /api/updates/rebase-plan: diverged, the upstream from ls-remote, the local commit listed; NOTHING written', async () => {
    const before = snapshot()
    const r = await call('GET', '/api/updates/rebase-plan')
    expect(snapshot()).toBe(before)
    expect(r.status).toBe(200)
    expect(r.json.diverged).toBe(true)
    expect(r.json.targetSource).toBe('ls-remote')
    expect(r.json.target).toBe(g(seed, 'rev-parse', 'HEAD'))
    expect(r.json.head).toBe(g(inst, 'rev-parse', 'HEAD'))
    expect(r.json.commits.map((c: any) => c.subject)).toEqual(['local: our fix'])
    expect(r.json.behind).toBeNull() // the target was not fetched: the plan does not fetch it
    expect(r.json.willFail).toBeNull()
    expect(r.json.hash).toBe(rebaseHash('main', r.json.head, r.json.target))
    expect(r.json.windowS).toBe(1800)
  })

  it('a local package.json change without the lock is willFail, and the approve refuses it', async () => {
    const before = g(inst, 'rev-parse', 'HEAD')
    commit(inst, 'package.json', '{"name":"t","dependencies":{"x":"1"}}\n', 'local: dep without lock')
    try {
      const r = await call('GET', '/api/updates/rebase-plan')
      expect(r.json.willFail).toBe('local-dependency-without-lock')
      const a = await call('POST', '/api/updates/rebase-approve', { hash: r.json.hash }, AS_OWNER)
      expect([a.status, a.json.reason]).toEqual([409, 'rebase-will-fail'])
    } finally { g(inst, 'reset', '-q', '--hard', before) }
  })
})

describe('POST /api/updates/rebase-approve', () => {
  it('without an owner session: refused, no row', async () => {
    const plan = (await call('GET', '/api/updates/rebase-plan')).json
    for (const auth of [undefined, { kind: 'token' as const }]) {
      const r = await call('POST', '/api/updates/rebase-approve', { hash: plan.hash }, auth)
      expect(r.status).toBe(403)
    }
  })

  it('a hash other than the current plan: 409 plan_changed, no row created', async () => {
    const r = await call('POST', '/api/updates/rebase-approve', { hash: 'c'.repeat(64) }, AS_OWNER)
    expect([r.status, r.json.reason]).toEqual([409, 'plan_changed'])
    expect(r.json.plan.hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('the shown hash: a row created AND approved by the owner session in one step, bound to the plan hash', async () => {
    const plan = (await call('GET', '/api/updates/rebase-plan')).json
    const r = await call('POST', '/api/updates/rebase-approve', { hash: plan.hash }, AS_OWNER)
    expect(r.status).toBe(201)
    const row = getApproval(r.json.id)!
    expect([row.category, row.status, row.content_hash, row.agent_id, row.resolved_by]).toEqual(['update_rebase', 'approved', plan.hash, 'owner:tulaj', 'owner:tulaj'])
    expect(row.consumed_at ?? null).toBeNull()
  })
})

describe('POST /api/updates/apply with rebaseApproval', () => {
  const approve = async (hash: string, approved = true): Promise<string> => {
    const id = crypto.randomUUID()
    createApproval({ id, agent_id: 'geri', category: 'update_rebase', action_description: 't', content_hash: hash })
    if (approved) resolveApproval(id, 'approved', 'owner:tulaj')
    return id
  }
  const planHash = async () => (await call('GET', '/api/updates/rebase-plan')).json.hash as string

  it('a malformed id is 400; unknown, unapproved, used, expired or bound to another plan is 409, and nothing starts', async () => {
    rmSync(join(inst, 'ENV.out'), { force: true })
    expect((await call('POST', '/api/updates/apply', { rebaseApproval: 'nope' })).status).toBe(400)
    const unknown = await call('POST', '/api/updates/apply', { rebaseApproval: crypto.randomUUID() })
    expect([unknown.status, unknown.json.reason]).toEqual([409, 'rebase-approval-not-found'])
    const pending = await call('POST', '/api/updates/apply', { rebaseApproval: await approve(await planHash(), false) })
    expect([pending.status, pending.json.reason]).toEqual([409, 'rebase-approval-not-approved'])
    const other = await call('POST', '/api/updates/apply', { rebaseApproval: await approve('d'.repeat(64)) })
    expect([other.status, other.json.reason]).toEqual([409, 'rebase-plan-changed'])
    const db = (await import('../db.js')) as any
    const usedId = await approve(await planHash())
    db.consumeCategoryApproval({ id: usedId, category: 'update_rebase', contentHash: await planHash(), consumer: 't', windowSeconds: 1800 })
    const used = await call('POST', '/api/updates/apply', { rebaseApproval: usedId })
    expect([used.status, used.json.reason]).toEqual([409, 'rebase-approval-used'])
    const oldId = await approve(await planHash())
    const realNow = Date.now
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 31 * 60 * 1000)
    try {
      const expired = await call('POST', '/api/updates/apply', { rebaseApproval: oldId })
      expect([expired.status, expired.json.reason]).toEqual([409, 'rebase-approval-expired'])
    } finally { spy.mockRestore() }
    await sleep(300)
    expect(existsSync(join(inst, 'ENV.out'))).toBe(false)
  })

  it('without an approval the diverged install still gets the 409 local-commits, now pointing at the plan', async () => {
    g(inst, 'fetch', '-q', 'origin') // the preflight measures against the last fetched origin/<branch>
    rmSync(join(inst, 'store', 'update.pid'), { force: true })
    const r = await call('POST', '/api/updates/apply', {})
    expect([r.status, r.json.reason, r.json.rebasePlan]).toEqual([409, 'local-commits', '/api/updates/rebase-plan'])
  })

  it('a valid approval starts update.sh with the id as the ONLY rebase input; UPDATE_AUTO_REBASE from the dashboard env does not pass', async () => {
    rmSync(join(inst, 'ENV.out'), { force: true })
    rmSync(join(inst, 'store', 'update.pid'), { force: true })
    // preflight compares with origin/<branch>: fetch so the local ref sees the divergence (update.sh does the same)
    g(inst, 'fetch', '-q', 'origin')
    const id = await approve(await planHash())
    process.env.UPDATE_AUTO_REBASE = '1'
    process.env.UPDATE_REBASE_APPROVAL = 'from-the-dashboard-env'
    try {
      const r = await call('POST', '/api/updates/apply', { rebaseApproval: id })
      expect(r.status, JSON.stringify(r.json)).toBe(200)
    } finally { delete process.env.UPDATE_AUTO_REBASE; delete process.env.UPDATE_REBASE_APPROVAL }
    for (let i = 0; i < 50 && !existsSync(join(inst, 'ENV.out')); i++) await sleep(100)
    const out = readFileSync(join(inst, 'ENV.out'), 'utf-8')
    expect(out).toBe(`UPDATE_REBASE_APPROVAL=${id}\ndone\n`)
    expect(getApproval(id)!.consumed_at ?? null).toBeNull() // the route only checks; update.sh consumes
  })
})
