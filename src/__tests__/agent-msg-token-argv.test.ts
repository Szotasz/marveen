// VOICETOKENLEAK1101 round 3 (#2080 review "Token on argv: what remains", Samu 65565): scripts/agent-msg.sh (the
// helper's message verb runs through it) and scripts/agent-msg-get.sh put the dashboard token on curl's argv
// (-H "Authorization: Bearer $TOKEN"), which ps shows to every process of the same user. Now curl reads the header
// from a process substitution (-H @<(printf ...), nothing on disk), TOKEN is never in a child's environment (not even
// when the caller exported a TOKEN of its own), and agent-msg.sh's JSON body (the message text) goes on stdin.
// A curl stub first on PATH records the argv and the environment it was started with and the header source it got,
// then runs the real curl, so what is checked is what a ps or a child's environment would show, and what reached a
// capture server.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createServer, type Server, type IncomingMessage } from 'node:http'
import { execFile, execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, copyFileSync, readFileSync, readdirSync, chmodSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AddressInfo } from 'node:net'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const TOKEN = 'argv-test-token-0123456789abcdef'
const CONTENT = 'titkos szoveg a torzsben 4242'
const dir = mkdtempSync(join(tmpdir(), 'agent-msg-argv-'))
const tokenFile = join(dir, '.dashboard-token')
writeFileSync(tokenFile, TOKEN + '\n', 'utf-8')
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

interface Seen { method: string; url: string; headers: IncomingMessage['headers']; body: string }
let seen: Seen[] = []
let reply = '{"id":1}'
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
        res.end(reply)
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

function run(script: string, args: string[], env: Record<string, string>): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile('bash', [script, ...args], {
      env: { PATH: `${stubDir}:${process.env.PATH}`, ...env }, timeout: 20_000,
    }, (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, out: stdout + stderr }))
  })
}

// Dani 65569/2-3: the token is neither on the argv nor in curl's environment (never exported), but the header source
// the stub read DOES carry it, so the call really authenticates; nothing goes to disk.
function expectHeaderNotArgv(argv: string, env: string, headers: string): void {
  expect(argv).not.toContain(TOKEN)
  expect(argv).not.toContain('Bearer')
  expect(env).not.toContain(TOKEN)
  expect(headers).toContain(`Authorization: Bearer ${TOKEN}`)
  expect(argv.split('\n').some((a) => /^@\/dev\/fd\/\d+$/.test(a))).toBe(true)
}

describe('agent-msg.sh: the token and the message text are not on curl\'s argv', () => {
  it('the server gets the token header and the body; the curl argv and env carry neither; nothing on disk', async () => {
    const tmp = mkdtempSync(join(dir, 'tmp-'))
    const r = await run(join(REPO, 'scripts', 'agent-msg.sh'), ['dani', 'samu', CONTENT], {
      MARVEEN_API_BASE: `http://127.0.0.1:${port()}`, MARVEEN_TOKEN_FILE: tokenFile, TMPDIR: tmp,
    })
    expect(r.code, r.out).toBe(0)
    expect(seen).toHaveLength(1)
    expect(seen[0].headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(JSON.parse(seen[0].body)).toMatchObject({ from: 'dani', to: 'samu', content: CONTENT })
    const argv = readFileSync(argvLog, 'utf-8')
    expect(argv).toContain('--data-binary') // not vacuous: the stub really ran
    expect(argv).not.toContain(CONTENT)
    expectHeaderNotArgv(argv, readFileSync(envLog, 'utf-8'), readFileSync(hdrLog, 'utf-8'))
    expect(readdirSync(tmp)).toEqual([])
  })

  // Dani 65583: an exported TOKEN in the caller's environment kept its export attribute through the plain assignment,
  // so curl's environment carried the dashboard token.
  it('a TOKEN the caller exported does not carry the dashboard token into curl\'s environment', async () => {
    const r = await run(join(REPO, 'scripts', 'agent-msg.sh'), ['dani', 'samu', 'x'], {
      MARVEEN_API_BASE: `http://127.0.0.1:${port()}`, MARVEEN_TOKEN_FILE: tokenFile, TOKEN: 'ambient-foreign-value',
    })
    expect(r.code, r.out).toBe(0)
    expect(seen[0].headers.authorization).toBe(`Bearer ${TOKEN}`)
    const env = readFileSync(envLog, 'utf-8')
    expect(env).not.toContain(TOKEN)
    expect(env).not.toMatch(/^TOKEN=/m)
  })

  it('unchanged: the exit code says what happened (an answer with no message id is a failure, not "sent")', async () => {
    reply = '{"error":"x"}'
    const before = seen.length
    const r = await run(join(REPO, 'scripts', 'agent-msg.sh'), ['dani', 'samu', 'x'], {
      MARVEEN_API_BASE: `http://127.0.0.1:${port()}`, MARVEEN_TOKEN_FILE: tokenFile,
    })
    reply = '{"id":1}'
    expect(r.code).not.toBe(0)
    expect(seen.length).toBeGreaterThan(before)
  })

  it('an empty token file stops before curl: nothing is sent, no empty Bearer', async () => {
    const empty = join(mkdtempSync(join(dir, 'e-')), '.dashboard-token')
    writeFileSync(empty, '\n')
    const r = await run(join(REPO, 'scripts', 'agent-msg.sh'), ['dani', 'samu', 'x'], {
      MARVEEN_API_BASE: `http://127.0.0.1:${port()}`, MARVEEN_TOKEN_FILE: empty,
    })
    expect(r.code).not.toBe(0)
    expect(r.out).toMatch(/is empty; nothing was sent/)
    expect(seen).toHaveLength(0)
    expect(readFileSync(argvLog, 'utf-8')).toBe('')
  })
})

describe('agent-msg-get.sh: the token is not on curl\'s argv', () => {
  it('the server gets the token header; the curl argv does not carry it; the temp files are gone', async () => {
    // The script reads the token from <its root>/store/.dashboard-token: run a copy under a temp root.
    const root = mkdtempSync(join(dir, 'root-'))
    mkdirSync(join(root, 'scripts'))
    mkdirSync(join(root, 'store'))
    copyFileSync(join(REPO, 'scripts', 'agent-msg-get.sh'), join(root, 'scripts', 'agent-msg-get.sh'))
    writeFileSync(join(root, 'store', '.dashboard-token'), TOKEN + '\n')
    const tmp = mkdtempSync(join(dir, 'tmpg-'))
    reply = JSON.stringify({ id: 7, from_agent: 'dani', to_agent: 'samu', status: 'done', content: 'c', result: 'r' })
    const r = await run(join(root, 'scripts', 'agent-msg-get.sh'), ['7'], { MARVEEN_WEB_PORT: String(port()), TMPDIR: tmp })
    reply = '{"id":1}'
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('# msg 7')
    expect(seen.map((s) => [s.method, s.url, s.headers.authorization])).toEqual([['GET', '/api/messages/7', `Bearer ${TOKEN}`]])
    const argv = readFileSync(argvLog, 'utf-8')
    expect(argv).toContain('/api/messages/7')
    expectHeaderNotArgv(argv, readFileSync(envLog, 'utf-8'), readFileSync(hdrLog, 'utf-8'))
    expect(readdirSync(tmp)).toEqual([])
    expect(existsSync(join(root, 'store', '.dashboard-token'))).toBe(true)
    // Dani 65583: the same with a TOKEN the caller exported
    writeFileSync(envLog, '')
    seen = []
    reply = JSON.stringify({ id: 7, from_agent: 'dani', to_agent: 'samu', status: 'done', content: 'c', result: 'r' })
    const r2 = await run(join(root, 'scripts', 'agent-msg-get.sh'), ['7'], {
      MARVEEN_WEB_PORT: String(port()), TMPDIR: tmp, TOKEN: 'ambient-foreign-value',
    })
    reply = '{"id":1}'
    expect(r2.code, r2.out).toBe(0)
    expect(seen[0].headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(readFileSync(envLog, 'utf-8')).not.toContain(TOKEN)
    expect(readFileSync(envLog, 'utf-8')).not.toMatch(/^TOKEN=/m)
  })
})
