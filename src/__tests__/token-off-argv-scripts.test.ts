// VOICETOKENLEAK1101 round 3, PR 2 (Samu 65565/65800): four more scripts put the dashboard token on curl's argv, which
// ps shows to every process of the same user: scripts/doctor.sh (the Dashboard API probe), scripts/migrate.sh (every
// import, through AUTH_HEADER), scripts/watchdog.sh (the replay's message list, through TOKEN) and the post-checkout
// hook scripts/install-prod-tree-guard-hook.sh writes. Each now hands curl the header from a process substitution
// (-H @<(printf ...): printf is a builtin, so no child's argv carries it, and nothing goes to disk), as #2439 did for
// agent-msg.sh. Where the token sits in a shell variable (watchdog's TOKEN, migrate's AUTH_HEADER) the variable is
// never exported, not even when the caller exported one of the same name (the #2439 lesson, Dani 65583).
//
// A curl stub first on PATH records the argv and the environment it was started with and the header source it got,
// then runs the real curl, so what is checked is what ps or a child's environment would show, and what reached a
// capture server. doctor.sh and watchdog.sh are not run whole (doctor reads services, watchdog restarts a dashboard
// and tmux sessions): the section that makes the call is cut out of the real file and run with the variables it needs,
// so an edit to that section is what the test runs. migrate.sh runs whole, answering its questions on stdin; the hook
// runs from a throwaway repo on a real checkout.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createServer, type Server, type IncomingMessage } from 'node:http'
import { execFile, execFileSync, spawnSync } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, writeFileSync, mkdirSync, copyFileSync, readFileSync, chmodSync, realpathSync, cpSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AddressInfo } from 'node:net'

const execFileAsync = promisify(execFile)
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const TOKEN = 'argv4-test-token-0123456789abcdef'
// realpath: on macOS tmpdir() is a symlink, and the post-checkout hook compares physical paths (see
// prod-tree-guard-alert-payload.test.ts).
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'token-argv4-')))
const REAL_CURL = execFileSync('/bin/sh', ['-c', 'command -v curl'], { encoding: 'utf-8' }).trim()
const stubDir = join(dir, 'bin')
mkdirSync(stubDir)
const argvLog = join(dir, 'curl-argv.log')
const hdrLog = join(dir, 'curl-headers.log')
const envLog = join(dir, 'curl-env.log')
// The stub records its argv and its environment, reads each @/dev/fd/N header source (a process substitution) and
// records what it held, then hands that header to the real curl again on fd 3.
writeFileSync(join(stubDir, 'curl'), [
  '#!/bin/bash',
  `printf '%s\\n' "$@" >> "${argvLog}"`,
  `env >> "${envLog}"`,
  'args=()',
  'for a in "$@"; do',
  '  case "$a" in',
  `    @/dev/fd/*) h="$(cat "\${a#@}")"; printf '%s\\n' "$h" >> "${hdrLog}"; exec 3< <(printf '%s\\n' "$h"); args+=("@/dev/fd/3") ;;`,
  '    *) args+=("$a") ;;',
  '  esac',
  'done',
  `exec "${REAL_CURL}" "\${args[@]}"`,
].join('\n') + '\n')
chmodSync(join(stubDir, 'curl'), 0o755)
const PATH = `${stubDir}:${process.env.PATH}`

interface Seen { method: string; url: string; headers: IncomingMessage['headers']; body: string }
let seen: Seen[] = []
let reply = (_req: Seen): string => '{"id":1}'
let api: Server
const port = () => (api.address() as AddressInfo).port

beforeAll(async () => {
  api = await new Promise((resolve) => {
    const s = createServer((req, res) => {
      let b = ''
      req.on('data', (c) => { b += c })
      req.on('end', () => {
        const one = { method: req.method!, url: req.url!, headers: req.headers, body: b }
        seen.push(one)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(reply(one))
      })
    })
    s.listen(0, '127.0.0.1', () => resolve(s))
  })
})
afterAll(() => { api.close() })
beforeEach(() => {
  seen = []
  reply = () => '{"id":1}'
  writeFileSync(argvLog, '')
  writeFileSync(hdrLog, '')
  writeFileSync(envLog, '')
})

const logs = () => ({ argv: readFileSync(argvLog, 'utf-8'), env: readFileSync(envLog, 'utf-8'), headers: readFileSync(hdrLog, 'utf-8') })

// The token is neither on the argv nor in curl's environment, but the header source the stub read DOES carry it, so
// the call really authenticates; and the argv names a /dev/fd header, so the stub really saw the new shape.
function expectHeaderNotArgv(): void {
  const { argv, env, headers } = logs()
  expect(argv).not.toBe('') // not vacuous: the stub ran
  expect(argv).not.toContain(TOKEN)
  expect(argv).not.toContain('Bearer')
  expect(env).not.toContain(TOKEN)
  expect(headers).toContain(`Authorization: Bearer ${TOKEN}`)
  expect(argv.split('\n').some((a) => /^@\/dev\/fd\/\d+$/.test(a))).toBe(true)
}

/** A fresh install root with the token file. */
function root(name: string): string {
  const r = mkdtempSync(join(dir, `${name}-`))
  mkdirSync(join(r, 'scripts'))
  mkdirSync(join(r, 'store'))
  writeFileSync(join(r, 'store', '.dashboard-token'), TOKEN + '\n')
  return r
}

/** The real file's text from [start] (included) to [end] (excluded); both must be there exactly once. */
function cut(file: string, start: string, end: string): string {
  const s = readFileSync(join(REPO, 'scripts', file), 'utf-8')
  const a = s.indexOf(start)
  expect(a, `${file}: ${start}`).toBeGreaterThanOrEqual(0)
  expect(s.indexOf(start, a + 1), `${file}: ${start} twice`).toBe(-1)
  const b = s.indexOf(end, a + start.length)
  expect(b, `${file}: ${end}`).toBeGreaterThan(a)
  return s.slice(a, b)
}

function bash(script: string, env: Record<string, string>, input = ''): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = execFile('bash', [script], { env: { PATH, ...env }, timeout: 30_000 },
      (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, out: stdout + stderr }))
    child.stdin?.end(input)
  })
}

describe('doctor.sh: the Dashboard API probe', () => {
  // The "# --- Dashboard API ---" section of the real file, run in an install root with its helpers.
  function harness(r: string): string {
    const section = cut('doctor.sh', '# --- Dashboard API ---', '# --- Database ---')
    const h = join(r, 'doctor-dashboard.sh')
    writeFileSync(h, ['set -u', 'ok() { echo "OK: $1"; }', 'fail() { echo "FAIL: $1"; }', 'RESET=""; BOLD=""',
      `WEB_PORT=${port()}`, `cd "${r}"`, section].join('\n') + '\n')
    return h
  }

  it('the server gets the token header; curl\'s argv and environment do not carry it', async () => {
    const r = root('doctor')
    const res = await bash(harness(r), {})
    expect(res.code, res.out).toBe(0)
    expect(res.out).toContain('OK: Dashboard API: responding (HTTP 200)')
    expect(seen.map((s) => [s.method, s.url, s.headers.authorization])).toEqual([['GET', '/api/agents', `Bearer ${TOKEN}`]])
    expectHeaderNotArgv()
  })

  it('unchanged: no token file is a failure line, and nothing is sent', async () => {
    const r = root('doctor-none')
    execFileSync('rm', [join(r, 'store', '.dashboard-token')])
    const res = await bash(harness(r), {})
    expect(res.out).toContain('FAIL: store/.dashboard-token missing')
    expect(seen).toHaveLength(0)
    expect(logs().argv).toBe('')
  })
})

describe('migrate.sh: every import call', () => {
  function install(name: string): { r: string; src: string } {
    const r = root(name)
    copyFileSync(join(REPO, 'scripts', 'migrate.sh'), join(r, 'scripts', 'migrate.sh'))
    copyFileSync(join(REPO, 'install-lang.sh'), join(r, 'install-lang.sh'))
    writeFileSync(join(r, '.env'), `WEB_PORT=${port()}\n`)
    writeFileSync(join(r, '.lang'), 'en')
    const src = mkdtempSync(join(dir, `${name}-src-`))
    writeFileSync(join(src, 'SOUL.md'), 'a calm soul\n')
    writeFileSync(join(src, 'USER.md'), 'the user profile\n')
    writeFileSync(join(src, 'MEMORY.md'), '# Memory\n\nOne thing worth keeping, long enough to be a chunk of its own here.\n')
    return { r, src }
  }
  const answer = (path: string) => (s: Seen) => s.url === '/api/memories/import' ? '{"ok":true,"imported":1,"stats":{"warm":1}}' : '{"id":1}'
  // xterm, not dumb: migrate.sh's `clear` fails under TERM=dumb and set -e ends the script there (as it is today).
  const env = { TERM: 'xterm' }

  it('the soul, the user and the chunk import all get the token header; curl\'s argv and environment do not carry it', async () => {
    const { r, src } = install('migrate')
    reply = answer(src)
    const res = await bash(join(r, 'scripts', 'migrate.sh'), env, `1\n${src}\n\n`)
    expect(res.code, res.out).toBe(0)
    expect(seen.map((s) => [s.method, s.url, s.headers.authorization])).toEqual([
      ['POST', '/api/memories', `Bearer ${TOKEN}`],
      ['POST', '/api/memories', `Bearer ${TOKEN}`],
      ['POST', '/api/memories/import', `Bearer ${TOKEN}`],
    ])
    expect(res.out).toContain('Imported: 1 memories')
    expectHeaderNotArgv()
    expect(logs().env).not.toMatch(/^AUTH_HEADER=/m)
  })

  it('an AUTH_HEADER the caller exported does not carry the token into curl\'s environment', async () => {
    const { r, src } = install('migrate-env')
    reply = answer(src)
    const res = await bash(join(r, 'scripts', 'migrate.sh'), { ...env, AUTH_HEADER: 'X-Ambient: foreign-value' }, `1\n${src}\n\n`)
    expect(res.code, res.out).toBe(0)
    expect(seen.every((s) => s.headers.authorization === `Bearer ${TOKEN}`)).toBe(true)
    expect(logs().env).not.toContain(TOKEN)
    expect(logs().env).not.toMatch(/^AUTH_HEADER=/m)
  })

  it('unchanged: without a token file the calls carry "X-No-Auth: 1" and no Authorization header', async () => {
    const { r, src } = install('migrate-none')
    execFileSync('rm', [join(r, 'store', '.dashboard-token')])
    reply = answer(src)
    const res = await bash(join(r, 'scripts', 'migrate.sh'), env, `1\n${src}\n\n`)
    expect(res.code, res.out).toBe(0)
    expect(seen.length).toBe(3)
    expect(seen.every((s) => s.headers.authorization === undefined && s.headers['x-no-auth'] === '1')).toBe(true)
  })
})

describe('watchdog.sh: the replay\'s message list', () => {
  // From the token's read to the end of replay_unfinished_messages in the real file, then one replay.
  function harness(r: string): string {
    const body = cut('watchdog.sh', 'TOKEN=""\n', '\n# ── Dashboard')
    const h = join(r, 'watchdog-replay.sh')
    writeFileSync(h, [`INSTALL_DIR="${r}"`, `LOG="${r}/watchdog.log"`, `WEB_PORT=${port()}`,
      "timestamp() { date '+%Y-%m-%d %H:%M:%S'; }", body, 'replay_unfinished_messages agent-a session-a', 'echo "replay done"'].join('\n') + '\n')
    return h
  }

  it('the server gets the token header; curl\'s argv and environment do not carry it', async () => {
    const r = root('watchdog')
    reply = () => '[]'
    const res = await bash(harness(r), {})
    expect(res.code, res.out).toBe(0)
    expect(res.out).toContain('replay done')
    expect(seen.map((s) => [s.method, s.url, s.headers.authorization])).toEqual([['GET', '/api/messages?agent=agent-a&limit=200', `Bearer ${TOKEN}`]])
    expectHeaderNotArgv()
  })

  it('a TOKEN the caller exported does not carry the dashboard token into curl\'s environment', async () => {
    const r = root('watchdog-env')
    reply = () => '[]'
    const res = await bash(harness(r), { TOKEN: 'ambient-foreign-value' })
    expect(res.code, res.out).toBe(0)
    expect(seen[0].headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(logs().env).not.toContain(TOKEN)
    expect(logs().env).not.toMatch(/^TOKEN=/m)
  })

  it('unchanged: without a token file the replay sends nothing', async () => {
    const r = root('watchdog-none')
    execFileSync('rm', [join(r, 'store', '.dashboard-token')])
    const res = await bash(harness(r), {})
    expect(res.code, res.out).toBe(0)
    expect(seen).toHaveLength(0)
    expect(logs().argv).toBe('')
  })
})

describe('install-prod-tree-guard-hook.sh: the generated post-checkout hook\'s alert', () => {
  let n = 0
  /** A throwaway repo with the installer run in it, as prod-tree-guard-alert-payload.test.ts does. */
  function makeRepo(): string {
    const repo = join(dir, `guard-${n++}`)
    mkdirSync(join(repo, 'scripts'), { recursive: true })
    mkdirSync(join(repo, 'store'), { recursive: true })
    execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'develop'])
    writeFileSync(join(repo, 'x.txt'), 'x')
    execFileSync('git', ['-C', repo, 'add', '.'])
    execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'])
    cpSync(join(REPO, 'scripts', 'install-prod-tree-guard-hook.sh'), join(repo, 'scripts', 'install-prod-tree-guard-hook.sh'))
    writeFileSync(join(repo, 'store', '.dashboard-token'), TOKEN + '\n')
    const r = spawnSync('/bin/bash', [join(repo, 'scripts', 'install-prod-tree-guard-hook.sh')], { cwd: repo, encoding: 'utf-8', timeout: 20000 })
    expect(r.status, r.stderr).toBe(0)
    return repo
  }

  it('the alert gets the token header; curl\'s argv and environment do not carry it', async () => {
    const repo = makeRepo()
    execFileSync('git', ['-C', repo, 'branch', 'feature-x'])
    // Async: the capture server lives in this worker (a synchronous checkout would block its answer).
    await execFileAsync('git', ['-C', repo, 'checkout', '-q', 'feature-x'], {
      timeout: 20000, env: { ...process.env, PATH, MARVEEN_DASHBOARD_ORIGIN: `http://127.0.0.1:${port()}`, MARVEEN_GUARD_ALERT_TO: 'alert-recipient' },
    })
    for (let i = 0; i < 100 && seen.length === 0; i++) await new Promise((r) => setTimeout(r, 20))
    expect(seen.map((s) => [s.method, s.url, s.headers.authorization])).toEqual([['POST', '/api/messages', `Bearer ${TOKEN}`]])
    expect(JSON.parse(seen[0].body).content).toContain('feature-x')
    expectHeaderNotArgv()
  })

  it('the installed hook file holds the process-substitution form, not the argv form', () => {
    const repo = makeRepo()
    const hook = readFileSync(join(repo, '.git', 'hooks', 'post-checkout'), 'utf-8')
    expect(hook).toContain(`-H @<(printf 'Authorization: Bearer %s\\n' "$(cat "$TOKEN_FILE")")`)
    expect(hook).not.toContain('-H "Authorization: Bearer')
  })
})

// Dani 65802 (3)-(5), Samu 65806: an installed hook changes only when the installer runs again. On an update that
// pulls new code, update.sh runs scripts/sync-hooks.sh, which runs every scripts/install-*-hook.sh, this installer
// among them (the call goes through a glob, so a grep for the installer's name does not find it). These pin that
// path and show what it does to an old hook of ours and to a foreign one. A host updated by a bare git pull (not
// update.sh) still needs the installer run by hand.
describe('the update path refreshes an installed post-checkout hook', () => {
  const NEW_LINE = `-H @<(printf 'Authorization: Bearer %s\\n' "$(cat "$TOKEN_FILE")") \\`
  const OLD_LINE = '-H "Authorization: Bearer $(cat "$TOKEN_FILE")" \\'
  let n = 0
  function repoWith(installer: string): string {
    const repo = join(dir, `sync-${n++}`)
    mkdirSync(join(repo, 'scripts'), { recursive: true })
    mkdirSync(join(repo, 'store'), { recursive: true })
    execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'develop'])
    writeFileSync(join(repo, 'x.txt'), 'x')
    execFileSync('git', ['-C', repo, 'add', '.'])
    execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'])
    writeFileSync(join(repo, 'store', '.dashboard-token'), TOKEN + '\n')
    writeFileSync(join(repo, 'scripts', 'install-prod-tree-guard-hook.sh'), installer)
    return repo
  }
  const realInstaller = () => readFileSync(join(REPO, 'scripts', 'install-prod-tree-guard-hook.sh'), 'utf-8')
  /** The installer as it was before this change: the generated hook puts the token on curl's argv. */
  function oldInstaller(): string {
    const s = realInstaller()
    expect(s.split(NEW_LINE).length - 1).toBe(1)
    return s.replace(NEW_LINE, OLD_LINE)
  }
  function syncHooks(repo: string): void {
    // The update's own step: the real sync-hooks.sh next to the real installer.
    copyFileSync(join(REPO, 'scripts', 'sync-hooks.sh'), join(repo, 'scripts', 'sync-hooks.sh'))
    writeFileSync(join(repo, 'scripts', 'install-prod-tree-guard-hook.sh'), realInstaller())
    const r = spawnSync('bash', [join(repo, 'scripts', 'sync-hooks.sh')], { cwd: repo, encoding: 'utf-8', timeout: 20000 })
    expect(r.status, r.stdout + r.stderr).toBe(0)
    expect(r.stdout).toContain('install-prod-tree-guard-hook.sh')
  }
  const hookPath = (repo: string) => join(repo, '.git', 'hooks', 'post-checkout')

  it('update.sh runs scripts/sync-hooks.sh, and sync-hooks.sh runs every scripts/install-*-hook.sh', () => {
    const update = readFileSync(join(REPO, 'update.sh'), 'utf-8')
    expect(update).toContain('bash "$INSTALL_DIR/scripts/sync-hooks.sh"')
    const sync = readFileSync(join(REPO, 'scripts', 'sync-hooks.sh'), 'utf-8')
    expect(sync).toContain('for installer in "$SCRIPT_DIR"/install-*-hook.sh; do')
    expect(sync).toContain('bash "$installer"')
  })

  it('an old hook of ours (the token on curl\'s argv) becomes the new form, and stays executable', () => {
    const repo = repoWith(oldInstaller())
    const first = spawnSync('bash', [join(repo, 'scripts', 'install-prod-tree-guard-hook.sh')], { cwd: repo, encoding: 'utf-8', timeout: 20000 })
    expect(first.status, first.stderr).toBe(0)
    expect(readFileSync(hookPath(repo), 'utf-8')).toContain(OLD_LINE) // not vacuous: the old form was installed
    const mode = statSync(hookPath(repo)).mode & 0o777
    syncHooks(repo)
    const hook = readFileSync(hookPath(repo), 'utf-8')
    expect(hook).toContain(NEW_LINE)
    expect(hook).not.toContain(OLD_LINE)
    expect(statSync(hookPath(repo)).mode & 0o777).toBe(mode)
    expect(mode & 0o100).toBe(0o100)
    // Our own old copy is replaced, never kept as a backup.
    expect(existsSync(hookPath(repo) + '.pre-prod-guard.bak')).toBe(false)
  })

  it('a foreign post-checkout is not overwritten: it is kept, byte for byte, as post-checkout.pre-prod-guard.bak', () => {
    const repo = repoWith(realInstaller())
    const foreign = '#!/bin/sh\n# someone else\'s hook\necho foreign\n'
    mkdirSync(join(repo, '.git', 'hooks'), { recursive: true })
    writeFileSync(hookPath(repo), foreign, { mode: 0o755 })
    syncHooks(repo)
    expect(readFileSync(hookPath(repo) + '.pre-prod-guard.bak', 'utf-8')).toBe(foreign)
    expect(readFileSync(hookPath(repo), 'utf-8')).toContain(NEW_LINE)
  })

  it('the generated hook carries no token and no "Bearer $": the quoted heredoc writes the text as it is', () => {
    const repo = repoWith(realInstaller())
    syncHooks(repo)
    const hook = readFileSync(hookPath(repo), 'utf-8')
    expect(hook).not.toContain(TOKEN)
    expect(hook).not.toContain('Bearer $')
  })

  // The process substitution is bash: run under sh it is a syntax error and the alert would never go. Every one of
  // these runs under the interpreter its first line names (git runs the hook by its shebang).
  it('interpreter: the four scripts and the generated hook name bash', () => {
    for (const s of ['doctor.sh', 'migrate.sh', 'watchdog.sh']) expect(readFileSync(join(REPO, 'scripts', s), 'utf-8').split('\n')[0], s).toBe('#!/bin/bash')
    const repo = repoWith(realInstaller())
    syncHooks(repo)
    expect(readFileSync(hookPath(repo), 'utf-8').split('\n')[0]).toBe('#!/usr/bin/env bash')
  })
})
