import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Readable } from 'node:stream'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { setTimeout as sleep } from 'node:timers/promises'

// Under a git hook GIT_DIR / GIT_INDEX_FILE / GIT_WORK_TREE would point this
// test's git commands (and the route's) at the developer's real repository.
const savedGitEnv: Record<string, string> = {}
for (const k of Object.keys(process.env)) {
  if (k.startsWith('GIT_')) {
    savedGitEnv[k] = process.env[k]!
    delete process.env[k]
  }
}
afterAll(() => { Object.assign(process.env, savedGitEnv) })

const H = vi.hoisted(() => ({ root: '' }))
vi.mock('../config.js', async (orig) => {
  const a = await orig<typeof import('../config.js')>()
  return { ...a, PROJECT_ROOT: H.root, STORE_DIR: `${H.root}/store-dir` }
})

const tmpRoot = mkdtempSync(join(tmpdir(), 'upd-preflight-'))
H.root = tmpRoot
// Registered after tmpRoot exists; independent of the git env restore above.
afterAll(() => { rmSync(tmpRoot, { recursive: true, force: true }) })
const { tryHandleUpdates } = await import('../web/routes/updates.js')
const config = await import('../config.js')
if (config.PROJECT_ROOT !== tmpRoot) throw new Error('refusing to run: PROJECT_ROOT is not the temporary root')

const STALL_MAX_MS = 750
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.test',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.test',
}
const git = (...args: string[]) => execFileSync('/usr/bin/git', args, { cwd: tmpRoot, env, stdio: 'ignore' })

// A stall that starts right at enable() goes unseen, so the meter gets a few samples in first.
async function stallDuring(fn: () => Promise<unknown>): Promise<number> {
  const h = monitorEventLoopDelay({ resolution: 10 })
  h.enable()
  try { await sleep(30); await fn(); await sleep(50) } finally { h.disable() }
  return h.max / 1e6
}

async function post(body: unknown = {}): Promise<{ status: number; json: any }> {
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
    headers: { 'content-type': 'application/json' },
  })
  let status = 0
  let out = ''
  const res = {
    setHeader() {},
    writeHead(s: number) { status = s },
    end(b?: string) { out = b ?? '' },
  }
  await tryHandleUpdates({
    req, res, path: '/api/updates/apply', method: 'POST',
    url: new URL('http://localhost/api/updates/apply'),
  } as any)
  return { status, json: JSON.parse(out) }
}

describe('POST /api/updates/apply pre-check is asynchronous', () => {
  it('runs against the temporary root, not a real checkout', () => {
    expect(config.PROJECT_ROOT).toBe(tmpRoot)
  })

  beforeAll(() => {
    execFileSync('/usr/bin/git', ['init', '-q', '-b', 'main', tmpRoot], { cwd: tmpRoot, env })
    writeFileSync(join(tmpRoot, 'a.txt'), 'a\n')
    git('add', 'a.txt')
    git('commit', '-q', '-m', 'init')
    git('config', 'protocol.ext.allow', 'always')
    git('remote', 'add', 'origin', 'ext::sleep 1.5')
    mkdirSync(join(tmpRoot, 'store-dir'), { recursive: true })
    mkdirSync(join(tmpRoot, 'store'), { recursive: true })
  })

  it('the stall meter sees a synchronous busy-wait', async () => {
    const stall = await stallDuring(async () => {
      const end = Date.now() + 300
      while (Date.now() < end) { /* busy */ }
    })
    expect(stall).toBeGreaterThanOrEqual(250)
  })

  it('refuses a dirty tree after the slow origin probe, without stalling', async () => {
    writeFileSync(join(tmpRoot, 'a.txt'), 'changed\n')
    try {
      const t0 = Date.now()
      let r!: { status: number; json: any }
      const stall = await stallDuring(async () => { r = await post() })
      expect(r.status).toBe(409)
      expect(r.json.reason).toBe('dirty-tree')
      expect(Date.now() - t0).toBeGreaterThanOrEqual(1400)
      expect(stall).toBeLessThan(STALL_MAX_MS)
      expect(existsSync(join(tmpRoot, 'store', 'update.pid'))).toBe(false)
    } finally {
      writeFileSync(join(tmpRoot, 'a.txt'), 'a\n')
    }
  })

  it('refuses a body that did not arrive in full before any pre-check (400 incomplete-body)', async () => {
    // Dirty tree: had the route carried on with autoStash=false it would answer 409 dirty-tree.
    writeFileSync(join(tmpRoot, 'a.txt'), 'changed\n')
    try {
      const req = Object.assign(new Readable({ read() {} }), { headers: { 'content-type': 'application/json' } })
      req.push(Buffer.from('{"autoStash":tr'))
      setImmediate(() => req.destroy())
      let status = 0
      let out = ''
      const res = { setHeader() {}, writeHead(s: number) { status = s }, end(b?: string) { out = b ?? '' } }
      const t0 = Date.now()
      await tryHandleUpdates({ req, res, path: '/api/updates/apply', method: 'POST', url: new URL('http://localhost/api/updates/apply') } as any)
      expect(status).toBe(400)
      expect(JSON.parse(out).code).toBe('incomplete-body')
      expect(Date.now() - t0).toBeLessThan(1000)
      expect(existsSync(join(tmpRoot, 'store', 'update.pid'))).toBe(false)
    } finally {
      writeFileSync(join(tmpRoot, 'a.txt'), 'a\n')
    }
  })

  it('refuses a detached HEAD before any origin probe', async () => {
    git('checkout', '-q', '--detach')
    try {
      const t0 = Date.now()
      const r = await post()
      expect(r.status).toBe(409)
      expect(r.json.reason).toBe('detached-head')
      expect(Date.now() - t0).toBeLessThan(1000)
    } finally {
      git('checkout', '-q', 'main')
    }
  })

  it('a diverged history is refused after the slow probe, with the ahead/behind counts computed', async () => {
    // main: init -> b ; origin/main: init -> c  (one ahead, one behind)
    const base = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: tmpRoot, env, encoding: 'utf-8' }).trim()
    try {
      writeFileSync(join(tmpRoot, 'b.txt'), 'b\n')
      git('add', 'b.txt')
      git('commit', '-q', '-m', 'b')
      git('checkout', '-q', '--detach', base)
      writeFileSync(join(tmpRoot, 'c.txt'), 'c\n')
      git('add', 'c.txt')
      git('commit', '-q', '-m', 'c')
      const c = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: tmpRoot, env, encoding: 'utf-8' }).trim()
      git('update-ref', 'refs/remotes/origin/main', c)
      git('checkout', '-q', 'main')
      const r = await post()
      expect(r.status).toBe(409)
      expect(r.json.reason).toBe('local-commits')
      // the route does not forward preflight.ahead; the message carries both counts
      expect(r.json.error).toMatch(/1 commit\(s\) ahead and 1 behind/)
    } finally {
      git('checkout', '-q', 'main')
      git('reset', '-q', '--hard', base)
      try { git('update-ref', '-d', 'refs/remotes/origin/main') } catch { /* not created */ }
      for (const f of ['b.txt', 'c.txt']) rmSync(join(tmpRoot, f), { force: true })
    }
  })

  it('a branch origin does not have is refused: ls-remote exit 2 reads as no such branch', async () => {
    // A local bare origin that has main only; the checkout moves to a branch it lacks.
    const bare = mkdtempSync(join(tmpdir(), 'upd-preflight-origin-'))
    try {
      execFileSync('/usr/bin/git', ['init', '-q', '--bare', bare], { env, stdio: 'ignore' })
      git('push', '-q', bare, 'main')
      git('remote', 'set-url', 'origin', bare)
      git('checkout', '-q', '-b', 'local-only')
      const r = await post()
      expect(r.status).toBe(409)
      expect(r.json.reason).toBe('branch-not-on-origin')
    } finally {
      git('checkout', '-q', 'main')
      try { git('branch', '-q', '-D', 'local-only') } catch { /* not created */ }
      git('remote', 'set-url', 'origin', 'ext::sleep 1.5')
      rmSync(bare, { recursive: true, force: true })
    }
  })
})
