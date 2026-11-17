// AUTOUPDATEDIVERG1110: update.sh replays local commits onto the new upstream ONLY after the owner's approval for
// exactly that rebase has been consumed, once (scripts/lib/update-rebase-go.sh says why and how).
//
// Measured, not mocked: update.sh's divergence block is extracted VERBATIM and run in bash, with real git on a
// throwaway origin/install pair, against a real HTTP server that runs the real auth gate (gateRequest) and the
// real approvals route on an in-memory database. The owner approves through the real PATCH with an owner
// session cookie, exactly as the dashboard does. The bash run is asynchronous so the server can answer it.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { execFile, execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../config.js')>()
  return { ...real, MAIN_AGENT_ID: 'fo-agens', TELEGRAM_BOT_TOKEN: '' }
})
vi.mock('../web/telegram.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../web/telegram.js')>()
  return { ...real, sendTelegramMessage: vi.fn(async () => null) }
})

import { initDatabase, getApproval, createDashboardUser } from '../db.js'
import { gateRequest, SESSION_COOKIE_NAME } from '../web/auth-gate.js'
import { createSession, _clearSessionCacheForTest } from '../web/auth-sessions.js'
import { tryHandleApprovals } from '../web/routes/approvals.js'
import type { RouteContext } from '../web/routes/types.js'

const ROOT = join(__dirname, '..', '..')
const UPDATE_SH = readFileSync(join(ROOT, 'update.sh'), 'utf-8')
const LIB = join(ROOT, 'scripts', 'lib', 'update-rebase-go.sh')
const MAIN = 'fo-agens'
const TOKEN = 'f'.repeat(64)

function extractBlock(): string {
  const start = UPDATE_SH.indexOf('DIVERGENCE_REF="FETCH_HEAD"')
  expect(start, 'divergence block not found in update.sh').toBeGreaterThan(-1)
  const end = UPDATE_SH.indexOf('\nif [ "${AHEAD:-0}" -gt 0 ]; then', start)
  expect(end, 'block end marker not found').toBeGreaterThan(start)
  return UPDATE_SH.slice(start, end)
}

// ---- the real dashboard routes, on a real port ----------------------------------------------------------------
let ownerCookie = ''
let server: http.Server
let port = 0
let fake: http.Server
let fakePort = 0
let fakeHits = 0

beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const method = req.method ?? 'GET'
    const auth = await gateRequest(req, res, url, url.pathname, method, { dashboardToken: TOKEN, resolveAgentToken: () => null, mainAgentId: MAIN })
    if (auth === null) return
    const ctxAuth = auth.kind === 'token' ? { kind: 'token' as const, agent: auth.agent, ...(auth.tokenAgent ? { tokenAgent: auth.tokenAgent } : {}) } : auth as RouteContext['auth']
    const ctx: RouteContext = { req, res, path: url.pathname, method, url, auth: ctxAuth }
    if (!(await tryHandleApprovals(ctx))) { res.writeHead(404); res.end('{}') }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  port = (server.address() as AddressInfo).port
  // A server of the caller's own that says yes to everything: the check must never ask it.
  fake = http.createServer((_req, res) => { fakeHits++; res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}') })
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', () => r()))
  fakePort = (fake.address() as AddressInfo).port
})
afterAll(async () => {
  await new Promise((r) => server.close(r))
  await new Promise((r) => fake.close(r))
})
beforeEach(() => {
  initDatabase(':memory:')
  _clearSessionCacheForTest()
  const owner = createDashboardUser('owner', 'x'.repeat(60))
  ownerCookie = createSession({ userId: owner.id, username: 'owner' })
  fakeHits = 0
})

async function api(method: string, path: string, body: unknown, asOwner: boolean): Promise<{ status: number; body: any }> {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...(asOwner ? { cookie: `${SESSION_COOKIE_NAME}=${ownerCookie}` } : {}) },
    body: JSON.stringify(body),
  })
  return { status: r.status, body: await r.json().catch(() => null) }
}

/** The agent files the request (shared token), the owner approves it (owner session), as on the dashboard. */
async function ownerGo(hash: string, approve = true): Promise<string> {
  const f = await api('POST', '/api/approvals', { agent_id: 'geri', category: 'update_rebase', action_description: 'rebase', content_hash: hash }, false)
  expect(f.status, JSON.stringify(f.body)).toBe(201)
  if (approve) {
    const a = await api('PATCH', `/api/approvals/${f.body.id}`, { status: 'approved', resolved_by: 'owner' }, true)
    expect(a.status, JSON.stringify(a.body)).toBe(200)
  }
  return f.body.id as string
}

// ---- a throwaway diverged install ----------------------------------------------------------------------------
const g = (cwd: string, ...args: string[]) => execFileSync('git',
  ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args],
  { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const commit = (cwd: string, file: string, msg: string) => {
  writeFileSync(join(cwd, file), msg + '\n', { flag: 'a' })
  g(cwd, 'add', file); g(cwd, 'commit', '-qm', msg)
}

/** Install with one local commit; upstream has a new commit on another file: diverged, no conflict. */
function divergedInstall(envPort: number): { inst: string; head: string; target: string } {
  const dir = mkdtempSync(join(tmpdir(), 'update-rebase-go-'))
  g(dir, 'init', '-q', '--bare', 'origin.git')
  g(dir, 'clone', '-q', join(dir, 'origin.git'), 'seed')
  const seed = join(dir, 'seed')
  commit(seed, 'base', 'c1'); g(seed, 'push', '-q', 'origin', 'main')
  g(dir, 'clone', '-q', join(dir, 'origin.git'), 'inst')
  const inst = join(dir, 'inst')
  commit(inst, 'local', 'local-fix')
  commit(seed, 'upstream', 'c2'); g(seed, 'push', '-q', 'origin', 'main')
  mkdirSync(join(inst, 'store')); mkdirSync(join(inst, 'scripts', 'lib'), { recursive: true })
  copyFileSync(LIB, join(inst, 'scripts', 'lib', 'update-rebase-go.sh'))
  writeFileSync(join(inst, 'scripts', 'notify.sh'), '#!/bin/bash\nexit 0\n', { mode: 0o755 })
  writeFileSync(join(inst, 'store', '.dashboard-token'), TOKEN + '\n')
  writeFileSync(join(inst, '.env'), `WEB_PORT=${envPort}\n`)
  writeFileSync(join(inst, '.git', 'info', 'exclude'), 'store/\nscripts/\n.env\n')
  return { inst, head: g(inst, 'rev-parse', 'HEAD'), target: g(seed, 'rev-parse', 'HEAD') }
}

/** sha256 of the binding, computed by the shipped lib itself. */
function hashFor(branch: string, head: string, target: string): string {
  return execFileSync('/bin/bash', ['-c', `. "${LIB}"; update_rebase_hash "$1" "$2" "$3"`, 'x', branch, head, target], { encoding: 'utf-8' })
}

async function runBlock(inst: string, env: Record<string, string>): Promise<{ code: number; out: string; log: string }> {
  const script = `
set -u
INSTALL_DIR="${inst}"
CURRENT_BRANCH="main"
RED=''; NC=''; ORANGE=''; GREEN=''
RESULT_MSG=""
restore_stash_before_exit() { :; }
${extractBlock()}
echo "REACHED_END"
echo "RESULT_MSG=$RESULT_MSG"
`
  const r = await new Promise<{ code: number; out: string }>((resolve) => {
    execFile('/bin/bash', ['-c', script], { cwd: inst, encoding: 'utf-8', env: { ...process.env, UPDATE_AUTO_REBASE: '', UPDATE_REBASE_APPROVAL: '', WEB_PORT: '', ...env } },
      (err, stdout) => resolve({ code: err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : -1) : 0, out: String(stdout) }))
  })
  let log = ''
  try { log = readFileSync(join(inst, 'store', 'update.log'), 'utf-8') } catch { /* none */ }
  return { ...r, log }
}

const behind = (inst: string) => g(inst, 'rev-list', '--count', 'HEAD..origin/main')

describe('update.sh auto-rebase needs the owner GO (AUTOUPDATEDIVERG1110)', () => {
  it('UPDATE_AUTO_REBASE=1 alone is refused: exit 5, HEAD unchanged, the reason says an approval is needed', async () => {
    const { inst, head } = divergedInstall(port)
    const r = await runBlock(inst, { UPDATE_AUTO_REBASE: '1' })
    expect(r.code).toBe(5)
    expect(r.out).not.toContain('REACHED_END')
    // 2nd PR: UPDATE_AUTO_REBASE is no longer read; alone it is the plain diverged refusal, no helper run
    expect(r.out).toContain('fast-forward nem lehetseges')
    expect(g(inst, 'rev-parse', 'HEAD')).toBe(head)
    expect(r.log).not.toContain('update_rebase:')
  })

  it('a valid owner GO bound to this HEAD and target: consumed once, the rebase runs, the install is no longer behind', async () => {
    const { inst, head, target } = divergedInstall(port)
    const id = await ownerGo(hashFor('main', head, target))
    const r = await runBlock(inst, { UPDATE_REBASE_APPROVAL: id })
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('Rebase kesz: 1 helyi modositas atrakva')
    expect(r.out).toContain('REACHED_END')
    expect(behind(inst)).toBe('0')
    expect(g(inst, 'log', '-1', '--format=%s')).toBe('local-fix')
    // the committer is the explicit one, not read from any config file (Dani, second delta review)
    expect(g(inst, 'log', '-1', '--format=%cn <%ce>')).toBe('Marveen update <update@marveen.invalid>')
    const row = getApproval(id)!
    expect(row.consumed_by).toBe('update.sh auto-rebase')
    expect(row.consumed_ref).toBe(`main ${head}..${target}`)
    expect(r.log).toContain(`update_rebase: rc=0 consumed id=${id} head=${head} target=${target} rebased=${g(inst, 'rev-parse', 'HEAD')} backup=refs/marveen/pre-update/`)
  })

  it('the same GO a second time (after resetting the install back) is refused: already_consumed', async () => {
    const { inst, head, target } = divergedInstall(port)
    const id = await ownerGo(hashFor('main', head, target))
    expect((await runBlock(inst, { UPDATE_REBASE_APPROVAL: id })).code).toBe(0)
    g(inst, 'reset', '-q', '--hard', head)
    const r = await runBlock(inst, { UPDATE_REBASE_APPROVAL: id })
    expect(r.code).toBe(5)
    expect(r.out).toContain('(already_consumed)')
    expect(g(inst, 'rev-parse', 'HEAD')).toBe(head)
  })

  it('a GO bound to another target (upstream moved after the approval) is refused: hash_mismatch, nothing consumed', async () => {
    const { inst, head } = divergedInstall(port)
    const stale = g(inst, 'rev-parse', 'HEAD~1')
    const id = await ownerGo(hashFor('main', head, stale))
    const r = await runBlock(inst, { UPDATE_REBASE_APPROVAL: id })
    expect(r.code).toBe(5)
    expect(r.out).toContain('(hash_mismatch)')
    expect(g(inst, 'rev-parse', 'HEAD')).toBe(head)
    expect(getApproval(id)!.consumed_at).toBeNull()
  })

  it('a GO bound to another HEAD (a new local commit after the approval) is refused: hash_mismatch', async () => {
    const { inst, head, target } = divergedInstall(port)
    const id = await ownerGo(hashFor('main', head, target))
    commit(inst, 'local', 'later-local')
    const now = g(inst, 'rev-parse', 'HEAD')
    const r = await runBlock(inst, { UPDATE_REBASE_APPROVAL: id })
    expect(r.code).toBe(5)
    expect(r.out).toContain('(hash_mismatch)')
    expect(g(inst, 'rev-parse', 'HEAD')).toBe(now)
  })

  it('a request the owner has not approved is refused: not_approved', async () => {
    const { inst, head, target } = divergedInstall(port)
    const id = await ownerGo(hashFor('main', head, target), false)
    const r = await runBlock(inst, { UPDATE_REBASE_APPROVAL: id })
    expect(r.code).toBe(5)
    expect(r.out).toContain('(not_approved)')
    expect(g(inst, 'rev-parse', 'HEAD')).toBe(head)
  })

  it('a GO approved more than 30 minutes ago is refused: expired', async () => {
    const { inst, head, target } = divergedInstall(port)
    const id = await ownerGo(hashFor('main', head, target))
    const realNow = Date.now
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 31 * 60 * 1000)
    try {
      const r = await runBlock(inst, { UPDATE_REBASE_APPROVAL: id })
      expect(r.code).toBe(5)
      expect(r.out).toContain('(expired)')
      expect(g(inst, 'rev-parse', 'HEAD')).toBe(head)
    } finally { spy.mockRestore() }
  })

  it('the shared token cannot approve its own request: the PATCH without an owner session is refused', async () => {
    const { head, target } = divergedInstall(port)
    const f = await api('POST', '/api/approvals', { agent_id: 'geri', category: 'update_rebase', action_description: 'rebase', content_hash: hashFor('main', head, target) }, false)
    const a = await api('PATCH', `/api/approvals/${f.body.id}`, { status: 'approved', resolved_by: 'owner' }, false)
    expect(a.status).toBe(403)
    expect(getApproval(f.body.id)!.status).toBe('pending')
  })

  it('WEB_PORT in the environment cannot point the check at a server of the caller own: the install config wins', async () => {
    const { inst, head } = divergedInstall(port)
    const r = await runBlock(inst, { UPDATE_REBASE_APPROVAL: '00000000-0000-4000-8000-000000000000', WEB_PORT: String(fakePort) })
    expect(fakeHits).toBe(0)
    expect(r.code).toBe(5)
    expect(r.out).toContain('(not_found)')
    expect(g(inst, 'rev-parse', 'HEAD')).toBe(head)
  })

  it('no dashboard on the configured port (an install without one): refused, HEAD unchanged', async () => {
    const closed = http.createServer()
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', () => r()))
    const dead = (closed.address() as AddressInfo).port
    await new Promise((r) => closed.close(r))
    const { inst, head } = divergedInstall(dead)
    const r = await runBlock(inst, { UPDATE_REBASE_APPROVAL: '00000000-0000-4000-8000-000000000000' })
    expect(r.code).toBe(5)
    expect(r.out).toContain('(dashboard-unreachable)')
    expect(g(inst, 'rev-parse', 'HEAD')).toBe(head)
  })

  // Dani's review of #2676 (c), measured there: the caller's PATH and EXPORTED shell functions decided the
  // in-process check (a fake node/sed gave a consumed GO with no approval). The check and the rebase now run
  // in a clean process; these pin that no PATH tool and no exported function reaches them.
  it('fake node, sed, grep and curl first on the PATH: refused by the real dashboard, the fake server never asked', async () => {
    const { inst, head } = divergedInstall(port)
    const bin = join(inst, '..', 'evilbin')
    mkdirSync(bin)
    for (const t of ['node', 'sed', 'grep', 'curl', 'tr', 'head']) {
      writeFileSync(join(bin, t), `#!/bin/bash\necho ${fakePort}\nexit 0\n`, { mode: 0o755 })
    }
    const r = await runBlock(inst, { UPDATE_REBASE_APPROVAL: '00000000-0000-4000-8000-000000000000', PATH: `${bin}:${process.env.PATH}` })
    expect(fakeHits).toBe(0)
    expect(r.code).toBe(5)
    expect(r.out).toContain('(not_found)')
    expect(g(inst, 'rev-parse', 'HEAD')).toBe(head)
  })

  it('exported sed, grep, node, curl and helper functions: refused by the real dashboard, the fake server never asked', async () => {
    const { inst, head } = divergedInstall(port)
    const fn = (body: string) => `() {  ${body}\n}`
    const r = await runBlock(inst, {
      UPDATE_REBASE_APPROVAL: '00000000-0000-4000-8000-000000000000',
      'BASH_FUNC_sed%%': fn(`echo ${fakePort}`),
      'BASH_FUNC_node%%': fn(`echo ${fakePort}`),
      'BASH_FUNC_grep%%': fn('return 0'),
      'BASH_FUNC_curl%%': fn('echo \'{"ok":true}\'; echo 200'),
      'BASH_FUNC_update_rebase_consume%%': fn('return 0'),
      'BASH_FUNC_update_rebase_main%%': fn('echo consumed; return 0'),
    })
    expect(fakeHits).toBe(0)
    expect(r.code).toBe(5)
    expect(r.out).toContain('(not_found)')
    expect(g(inst, 'rev-parse', 'HEAD')).toBe(head)
  })

  it('even with `exit` and `[` replaced by exported functions, nothing is rebased without the GO', async () => {
    const { inst, head } = divergedInstall(port)
    const r = await runBlock(inst, {
      UPDATE_REBASE_APPROVAL: '00000000-0000-4000-8000-000000000000',
      'BASH_FUNC_exit%%': '() {  return 0\n}',
      'BASH_FUNC_[%%': '() {  return 0\n}',
      'BASH_FUNC_sed%%': `() {  echo ${fakePort}\n}`,
    })
    expect(fakeHits).toBe(0)
    expect(g(inst, 'rev-parse', 'HEAD')).toBe(head)
    expect(behind(inst)).not.toBe('0')
    expect(r.log).toContain('update_rebase: rc=1 refused reason=not_found')
  })

  it("a .curlrc in the caller's HOME (connect-to the caller's own server) does not reach the consume", async () => {
    const { inst, head } = divergedInstall(port)
    const home = join(inst, '..', 'evilhome')
    mkdirSync(home)
    // quoted: curl does not parse an unquoted value that starts with ':' (measured, curl 8.7.1)
    writeFileSync(join(home, '.curlrc'), `connect-to = "::127.0.0.1:${fakePort}"\n`)
    writeFileSync(join(home, '.gitconfig'), '[user]\n  name = evil\n  email = evil@example.invalid\n')
    const r = await runBlock(inst, { UPDATE_REBASE_APPROVAL: '00000000-0000-4000-8000-000000000000', HOME: home })
    expect(fakeHits).toBe(0)
    expect(r.code).toBe(5)
    expect(r.out).toContain('(not_found)')
    expect(g(inst, 'rev-parse', 'HEAD')).toBe(head)
  })

  it('a non-diverged install (ahead only) is untouched by all this: no approval asked, the update continues', async () => {
    const { inst } = divergedInstall(port)
    g(inst, 'fetch', '-q', 'origin'); g(inst, 'reset', '-q', '--hard', 'origin/main')
    commit(inst, 'local', 'ahead-only')
    const r = await runBlock(inst, {})
    expect(r.code).toBe(0)
    expect(r.out).toContain('REACHED_END')
    expect(r.log).not.toContain('update_rebase:')
  })
})

// ---- AUTOUPDATEDIVERG1110 2nd PR: the F4 order, the recovery ref, the git-config lock, the conflict report ----
/** A diverged install whose local and upstream commits are chosen per case. */
function install(opts: { local: [string, string]; upstream: [string, string]; envPort: number }): { inst: string; head: string; target: string } {
  const dir = mkdtempSync(join(tmpdir(), 'update-rebase-pr2-'))
  g(dir, 'init', '-q', '--bare', 'origin.git')
  g(dir, 'clone', '-q', join(dir, 'origin.git'), 'seed')
  const seed = join(dir, 'seed')
  writeFileSync(join(seed, 'shared.txt'), 'line 1\nline 2\n')
  writeFileSync(join(seed, 'package.json'), '{"name":"t","version":"1.0.0"}\n')
  writeFileSync(join(seed, 'package-lock.json'), '{"lockfileVersion":3}\n')
  g(seed, 'add', '-A'); g(seed, 'commit', '-qm', 'c1'); g(seed, 'push', '-q', 'origin', 'main')
  g(dir, 'clone', '-q', join(dir, 'origin.git'), 'inst')
  const inst = join(dir, 'inst')
  writeFileSync(join(inst, opts.local[0]), opts.local[1]); g(inst, 'add', '-A'); g(inst, 'commit', '-qm', 'local: "quoted" <b>subject</b> & <https://x.example|link>')
  writeFileSync(join(seed, opts.upstream[0]), opts.upstream[1]); g(seed, 'add', '-A'); g(seed, 'commit', '-qm', 'c2'); g(seed, 'push', '-q', 'origin', 'main')
  mkdirSync(join(inst, 'store')); mkdirSync(join(inst, 'scripts', 'lib'), { recursive: true })
  copyFileSync(LIB, join(inst, 'scripts', 'lib', 'update-rebase-go.sh'))
  writeFileSync(join(inst, 'scripts', 'notify.sh'), '#!/bin/bash\nprintf "%s\\n" "$*" >> "$(dirname "$0")/../store/notify.log"\n', { mode: 0o755 })
  writeFileSync(join(inst, 'store', '.dashboard-token'), TOKEN + '\n')
  writeFileSync(join(inst, '.env'), `WEB_PORT=${opts.envPort}\n`)
  writeFileSync(join(inst, '.git', 'info', 'exclude'), 'store/\nscripts/\n.env\n')
  return { inst, head: g(inst, 'rev-parse', 'HEAD'), target: g(seed, 'rev-parse', 'HEAD') }
}
const backups = (inst: string) => g(inst, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/marveen/pre-update/').split('\n').filter(Boolean)

describe('2nd PR: the F4 order, the recovery ref, the git-config lock, the conflict report', () => {
  it('a local package.json change without the lock is refused BEFORE the consume: the GO stays unspent, no recovery ref', async () => {
    const { inst, head, target } = install({ local: ['package.json', '{"name":"t","version":"1.0.0","dependencies":{"x":"1"}}\n'], upstream: ['other.txt', 'u\n'], envPort: port })
    const id = await ownerGo(hashFor('main', head, target))
    const r = await runBlock(inst, { UPDATE_REBASE_APPROVAL: id })
    expect(r.code).toBe(5)
    expect(r.log).toContain('refused reason=local-dependency-without-lock')
    expect(getApproval(id)!.consumed_at).toBeNull()
    expect(backups(inst)).toEqual([])
    expect(g(inst, 'rev-parse', 'HEAD')).toBe(head)
  })

  it('a recovery ref that cannot be written stops the run BEFORE the consume: the GO stays unspent', async () => {
    const { inst, head, target } = install({ local: ['local.txt', 'l\n'], upstream: ['other.txt', 'u\n'], envPort: port })
    g(inst, 'update-ref', 'refs/marveen/pre-update', head) // a ref at the namespace itself: no ref can be created under it
    const id = await ownerGo(hashFor('main', head, target))
    const r = await runBlock(inst, { UPDATE_REBASE_APPROVAL: id })
    expect(r.code).toBe(5)
    expect(r.log).toContain('refused reason=backup-failed')
    expect(getApproval(id)!.consumed_at).toBeNull()
    expect(g(inst, 'rev-parse', 'HEAD')).toBe(head)
  })

  it('a successful run leaves a recovery ref on the pre-rebase HEAD (UTC name), and a rollback reset does not move it (N1)', async () => {
    const { inst, head, target } = install({ local: ['local.txt', 'l\n'], upstream: ['other.txt', 'u\n'], envPort: port })
    const id = await ownerGo(hashFor('main', head, target))
    const r = await runBlock(inst, { UPDATE_REBASE_APPROVAL: id })
    expect(r.code).toBe(0)
    const refs = backups(inst)
    expect(refs.length).toBe(1)
    const [ref, sha] = refs[0].split(' ')
    expect(ref).toMatch(/^refs\/marveen\/pre-update\/\d{8}T\d{6}Z$/)
    expect(sha).toBe(head)
    expect(r.log).toContain(`backup=${ref}`)
    g(inst, 'reset', '-q', '--hard', head) // what update.sh's rollback does (OLD_VERSION_FULL)
    expect(backups(inst)).toEqual(refs)
  })

  it('retention: the newest 5 recovery refs stay, older ones are deleted one by one', async () => {
    const { inst, head, target } = install({ local: ['local.txt', 'l\n'], upstream: ['other.txt', 'u\n'], envPort: port })
    for (let d = 1; d <= 7; d++) g(inst, 'update-ref', `refs/marveen/pre-update/2026010${d}T000000Z`, head)
    const id = await ownerGo(hashFor('main', head, target))
    expect((await runBlock(inst, { UPDATE_REBASE_APPROVAL: id })).code).toBe(0)
    const names = backups(inst).map((l) => l.split(' ')[0].replace('refs/marveen/pre-update/', ''))
    expect(names.length).toBe(5)
    expect(names).toContain('20260107T000000Z')
    expect(names).toContain('20260104T000000Z')
    expect(names).not.toContain('20260103T000000Z')
    expect(names.some((n) => n.startsWith('2026111') || n.startsWith('2026') && !n.startsWith('202601'))).toBe(true)
  })

  it('a .gitconfig in the fixed HOME (store/, caller-writable) is not read: its hook does not run', async () => {
    const { inst, head, target } = install({ local: ['local.txt', 'l\n'], upstream: ['other.txt', 'u\n'], envPort: port })
    const home = join(inst, 'store', '.update-rebase-home-unused')
    const hooks = join(inst, 'store', 'evilhooks')
    mkdirSync(home, { recursive: true }); mkdirSync(hooks)
    const marker = join(inst, 'store', 'HOOK_RAN')
    writeFileSync(join(hooks, 'post-rewrite'), `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 })
    writeFileSync(join(home, '.gitconfig'), `[core]\n\thooksPath = ${hooks}\n`)
    const id = await ownerGo(hashFor('main', head, target))
    expect((await runBlock(inst, { UPDATE_REBASE_APPROVAL: id })).code).toBe(0)
    expect(existsSync(marker)).toBe(false)
  })

  it('a conflict: GO spent once, rebase aborted, HEAD unchanged; the report names the commit and the file, in the install language', async () => {
    for (const lang of ['hu', 'en']) {
      const { inst, head, target } = install({ local: ['shared.txt', 'line 1 LOCAL\nline 2\n'], upstream: ['shared.txt', 'line 1 UPSTREAM\nline 2\n'], envPort: port })
      const id = await ownerGo(hashFor('main', head, target))
      const r = await runBlock(inst, { UPDATE_REBASE_APPROVAL: id, MARVEEN_LANG: lang })
      expect(r.code, lang).toBe(5)
      expect(g(inst, 'rev-parse', 'HEAD')).toBe(head)
      expect(existsSync(join(inst, '.git', 'rebase-merge')) || existsSync(join(inst, '.git', 'rebase-apply'))).toBe(false)
      expect(getApproval(id)!.consumed_at).not.toBeNull()
      const notify = readFileSync(join(inst, 'store', 'notify.log'), 'utf-8')
      expect(notify).toContain('shared.txt')
      expect(notify).toContain(g(inst, 'rev-parse', '--short', head))
      // notify.sh feeds Telegram HTML and Slack mrkdwn: & < > escaped once, nothing raw left (Dani 74994 N5).
      expect(notify).toContain('local: "quoted" &lt;b&gt;subject&lt;/b&gt; &amp; &lt;https://x.example|link&gt;')
      expect(notify).not.toMatch(/[<>]/)
      expect(notify).not.toContain('&amp;lt;')
      expect(notify).toContain(lang === 'en' ? 'The update did not run, nothing changed.' : 'A frissítés nem futott le, semmi nem változott.')
    }
  })

  it('the result file gets the rebase object, JSON-escaped, with rollback true only on a rolled-back run', () => {
    const fn = (name: string) => { const m = new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}\\n`, 'm').exec(UPDATE_SH); expect(m, name).not.toBeNull(); return m![0] }
    const script = `_json_escape() { printf '%s' "$1" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))' 2>/dev/null || printf '"%s"' "$1"; }
${fn('rebase_json')}
UPDATE_REBASE_APPROVAL=id-1 REBASE_HEAD=h REBASE_TARGET=t REBASE_NEW=n REBASE_BACKUP=refs/marveen/pre-update/x REBASE_OUTCOME=conflict REBASE_WHY='a "q" <x>'
RESULT_STATUS=failed; rebase_json; echo
RESULT_STATUS=rolled-back; rebase_json; echo
REBASE_OUTCOME=''; printf '[%s]' "$(rebase_json)"`
    const out = execFileSync('/bin/bash', ['-c', script], { encoding: 'utf-8' }).split('\n')
    const a = JSON.parse(out[0]); const b = JSON.parse(out[1])
    expect(a).toEqual({ approval: 'id-1', head: 'h', target: 't', rebased_head: 'n', backup_ref: 'refs/marveen/pre-update/x', outcome: 'conflict', reason: 'a "q" <x>', rollback: false })
    expect(b.rollback).toBe(true)
    expect(out[2]).toBe('[]')
  })
})
