// VOICETOKENLEAK1101 round 3, PR 3 (Samu 65565/65800): scripts/channels.sh's two shared-root guard alerts put the
// dashboard token on curl's argv (-H "Authorization: Bearer $(cat ...)"), which ps shows to every process of the
// same user. Both now hand curl the header from a process substitution (-H @<(printf ...): printf is a builtin, so no
// child's argv carries it, and nothing goes to disk), as #2439 and #2445 did for the other scripts.
//
// channels.sh boots the main agent and is not run whole here: the resolver _guard_sender and the two trigger blocks
// are lifted out of the real file (as channels-guard-sender.test.ts lifts the resolver) and run with the variables
// they read. A curl stub first on PATH records the argv, the environment and the header source, then runs the real
// curl against a capture server.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createServer, type Server, type IncomingMessage } from 'node:http'
import { execFile, execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, chmodSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AddressInfo } from 'node:net'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'channels.sh')
const src = readFileSync(SCRIPT, 'utf-8')
const TOKEN = 'channels-argv-token-0123456789abcdef'
const dir = mkdtempSync(join(tmpdir(), 'channels-argv-'))
const REAL_CURL = execFileSync('/bin/sh', ['-c', 'command -v curl'], { encoding: 'utf-8' }).trim()
const stubDir = join(dir, 'bin')
mkdirSync(stubDir)
const argvLog = join(dir, 'curl-argv.log')
const hdrLog = join(dir, 'curl-headers.log')
const envLog = join(dir, 'curl-env.log')
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

/** The text between [start] (included) and [end] (excluded) in channels.sh; both exactly once. */
function lift(start: string, end: string): string {
  const a = src.indexOf(start)
  expect(a, start).toBeGreaterThanOrEqual(0)
  expect(src.indexOf(start, a + 1), `${start} twice`).toBe(-1)
  const b = src.indexOf(end, a + start.length)
  expect(b, end).toBeGreaterThan(a)
  return src.slice(a, b)
}
const resolver = () => lift('_guard_sender() {', '\n}\n') + '\n}\n'
const triggers = () => lift('  if [ -z "$CFG_ENV" ] && [ ! -d "$INSTALL_DIR/.channels-config" ] && [ -s "$INSTALL_DIR/store/.claude-oauth-token" ]; then',
  '  # Custom provider env for the main agent')

interface Seen { method: string; url: string; headers: IncomingMessage['headers']; body: string }
let seen: Seen[] = []
let api: Server
const port = () => (api.address() as AddressInfo).port

beforeAll(async () => {
  api = await new Promise((resolve) => {
    const s = createServer((req, res) => {
      let b = ''
      req.on('data', (c) => { b += c })
      req.on('end', () => {
        seen.push({ method: req.method!, url: req.url!, headers: req.headers, body: b })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('{"id":1}')
      })
    })
    s.listen(0, '127.0.0.1', () => resolve(s))
  })
})
afterAll(() => { api.close() })
beforeEach(() => {
  seen = []
  writeFileSync(argvLog, '')
  writeFileSync(hdrLog, '')
  writeFileSync(envLog, '')
})

/** An install root: .env with the capture server's port, the token, and what the trigger looks at. */
function install(kind: 'fresh' | 'lost'): string {
  const r = mkdtempSync(join(dir, `${kind}-`))
  mkdirSync(join(r, 'store'))
  writeFileSync(join(r, '.env'), `WEB_PORT=${port()}\nMAIN_AGENT_ID=main-x\n`)
  writeFileSync(join(r, 'store', '.dashboard-token'), TOKEN + '\n')
  if (kind === 'fresh') writeFileSync(join(r, 'store', '.claude-oauth-token'), 'not-a-real-setup-token\n')
  else mkdirSync(join(r, '.channels-config'))
  return r
}

function run(r: string, env: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  const h = join(r, 'guards.sh')
  writeFileSync(h, [`INSTALL_DIR="${r}"`, 'CFG_ENV=""', 'MAIN_AGENT_ID=main-x', resolver(), triggers(), 'echo "guards done"'].join('\n') + '\n')
  return new Promise((resolve) => {
    execFile('bash', [h], { env: { PATH: `${stubDir}:${process.env.PATH}`, ...env }, timeout: 20_000 },
      (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, out: stdout + stderr }))
  })
}

function expectHeaderNotArgv(): void {
  const argv = readFileSync(argvLog, 'utf-8')
  expect(argv).not.toBe('') // not vacuous: the stub ran
  expect(argv).not.toContain(TOKEN)
  expect(argv).not.toContain('Bearer')
  expect(readFileSync(envLog, 'utf-8')).not.toContain(TOKEN)
  expect(readFileSync(hdrLog, 'utf-8')).toContain(`Authorization: Bearer ${TOKEN}`)
  expect(argv.split('\n').some((a) => /^@\/dev\/fd\/\d+$/.test(a))).toBe(true)
}

describe('channels.sh shared-root guard alerts: the token is not on curl\'s argv', () => {
  it('trigger 1 (a fresh install with a fleet setup-token): the alert gets the token header; argv and env do not carry it', async () => {
    const r = install('fresh')
    const res = await run(r)
    expect(res.code, res.out).toBe(0)
    expect(res.out).toContain('guards done')
    expect(seen.map((s) => [s.method, s.url, s.headers.authorization])).toEqual([['POST', '/api/messages', `Bearer ${TOKEN}`]])
    expect(JSON.parse(seen[0].body).content).toContain('flotta setup-token')
    expectHeaderNotArgv()
    // Unchanged: the delivery is checked (no "POST failed" line on a 200) and the temp status file is gone.
    expect(readFileSync(join(r, 'store', 'channels-failures.log'), 'utf-8')).not.toContain('guard alert POST failed')
    expect(readdirSync(join(r, 'store')).filter((f) => f.startsWith('.channels-guard-http.'))).toEqual([])
  })

  it('trigger 2 (an isolated dir left, the setting lost): the alert gets the token header; argv and env do not carry it', async () => {
    const r = install('lost')
    const res = await run(r)
    expect(res.code, res.out).toBe(0)
    expect(seen.map((s) => [s.method, s.url, s.headers.authorization])).toEqual([['POST', '/api/messages', `Bearer ${TOKEN}`]])
    expect(JSON.parse(seen[0].body).content).toContain('.channels-config')
    expectHeaderNotArgv()
  })

  it('an exported TOKEN in the caller\'s environment does not change it (the token is read from the file, inline)', async () => {
    const res = await run(install('lost'), { TOKEN: 'ambient-foreign-value' })
    expect(res.code, res.out).toBe(0)
    expect(seen[0].headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(readFileSync(envLog, 'utf-8')).not.toContain(TOKEN)
  })

  it('unchanged: without a dashboard token file the guard only logs, nothing is sent', async () => {
    const r = install('lost')
    execFileSync('rm', [join(r, 'store', '.dashboard-token')])
    const res = await run(r)
    expect(res.code, res.out).toBe(0)
    expect(seen).toHaveLength(0)
    expect(readFileSync(argvLog, 'utf-8')).toBe('')
    expect(readFileSync(join(r, 'store', 'channels-failures.log'), 'utf-8')).toContain('starting on SHARED')
  })

  it('channels.sh names bash (the process substitution is bash), and the argv form is gone from both alerts', () => {
    expect(src.split('\n')[0]).toBe('#!/bin/bash')
    expect(src).not.toContain('-H "Authorization: Bearer $(cat "$INSTALL_DIR/store/.dashboard-token")"')
    expect(src.split(`-H @<(printf 'Authorization: Bearer %s\\n' "$(cat "$INSTALL_DIR/store/.dashboard-token")")`).length - 1).toBe(2)
  })
})
