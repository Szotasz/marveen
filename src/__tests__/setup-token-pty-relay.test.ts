// SETUPTOKENWIZ1022: the real python PTY relay (scripts/setup-token-pty.py) and
// launchSetupTokenRelay, end to end, against a STUB claude -- never the real
// binary, so no login link is ever made. The stub behaves like the measured
// prompt: it refuses to run without a terminal, prints the link inside an OSC 8
// hyperlink, ignores Ctrl-C, reads the code up to Enter, prints a coloured
// token and then stays open. It also writes down what environment it got, so
// the isolation is checked from the child's side.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { launchSetupTokenRelay, SetupTokenLogin } from '../web/setup-token-login.js'

const TOKEN = 'sk-ant-oat01-' + 'Zx9_-q'.repeat(16)
const LOGIN_URL = 'https://claude.com/cai/oauth/authorize?code=true&state=' + 'r'.repeat(43)

let dir: string
let stub: string
let report: string
let codeFile: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'marveen-stw-relay-test-'))
  stub = join(dir, 'claude')
  report = join(dir, 'env.json')
  codeFile = join(dir, 'code.txt')
  writeFileSync(stub, `#!/usr/bin/env node
const fs = require('fs')
if (!process.stdin.isTTY || !process.stdout.isTTY) { process.stdout.write('NO TTY\\n'); process.exit(3) }
const e = process.env
const tgDir = e.TELEGRAM_STATE_DIR
fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify({
  argv: process.argv.slice(2), cols: process.stdout.columns,
  keys: Object.keys(e).sort(), configDir: e.CLAUDE_CONFIG_DIR, tgDir,
  tgEmpty: tgDir ? fs.readdirSync(tgDir).length === 0 : null,
  browserExecutable: (() => { try { fs.accessSync(e.BROWSER, fs.constants.X_OK); return true } catch { return false } })(),
}))
process.on('SIGINT', () => {})
process.stdin.setRawMode(true)
process.stdout.write('\\x1b]8;;${LOGIN_URL}\\x07${LOGIN_URL}\\x1b]8;;\\x07\\r\\nPaste code here if prompted > ')
let code = ''
process.stdin.on('data', (b) => {
  for (const ch of b.toString()) {
    if (ch === '\\x03') continue
    if (ch === '\\r') {
      fs.writeFileSync(${JSON.stringify(codeFile)}, code)
      process.stdout.write('\\r\\n\\x1b[33m${TOKEN}\\x1b[39m\\r\\n\\r\\nStore this token securely.\\r\\n')
      return
    }
    code += ch
  }
})
setInterval(() => {}, 1000)
`, { mode: 0o755 })
})

afterAll(() => { rmSync(dir, { recursive: true, force: true }) })

function waitFor(cond: () => boolean, ms = 8000): Promise<void> {
  const t0 = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (cond()) return resolve()
      if (Date.now() - t0 > ms) return reject(new Error('timed out'))
      setTimeout(tick, 50)
    }
    tick()
  })
}

const tempRoots = () => readdirSync(tmpdir()).filter((n) => n.startsWith('marveen-setup-token-'))

describe('setup-token PTY relay (real python3, stub claude)', () => {
  it('gives the stub a terminal, catches link and token, isolates the env, and cleans up', async () => {
    const before = new Set(tempRoots())
    const parentToken = process.env.CLAUDE_CODE_OAUTH_TOKEN
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-' + 'oat01-PARENT-MUST-NOT-LEAK'
    let login: SetupTokenLogin
    try {
      login = new SetupTokenLogin(() => launchSetupTokenRelay(stub))
      const started = await login.start()
      expect(started).toEqual({ ok: true, url: LOGIN_URL })
    } finally {
      if (parentToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = parentToken
    }

    const env = JSON.parse(readFileSync(report, 'utf-8'))
    expect(env.argv).toEqual(['setup-token'])
    expect(env.cols).toBe(512)
    expect(env.keys).not.toContain('CLAUDE_CODE_OAUTH_TOKEN')
    expect(env.keys).not.toContain('ANTHROPIC_API_KEY')
    expect(env.configDir).toMatch(/marveen-setup-token-[^/]+\/config$/)
    expect(env.tgDir).toMatch(/marveen-setup-token-[^/]+\/telegram$/)
    expect(env.tgEmpty).toBe(true)
    expect(env.browserExecutable).toBe(true)
    const root = dirname(env.configDir)
    expect(existsSync(root)).toBe(true)

    let caught = ''
    const r = await login!.submitCode('Code123_abc#state456', async (token) => { caught = token; return 'stored' })
    expect(r).toEqual({ ok: true, result: 'stored' })
    expect(caught).toBe(TOKEN)
    expect(readFileSync(codeFile, 'utf-8')).toBe('Code123_abc#state456')

    // The stub stays open after the token; closing the PTY must still end it,
    // and the temp root goes with it -- well inside the 5 s SIGKILL net, so it
    // is the stdin EOF that ends it, not the net.
    await waitFor(() => !existsSync(root), 3000)
    expect(tempRoots().filter((n) => !before.has(n))).toEqual([])
  }, 20_000)

  it('cancel ends a prompt that ignores Ctrl-C, and removes the temp root', async () => {
    rmSync(report, { force: true })
    const login = new SetupTokenLogin(() => launchSetupTokenRelay(stub))
    expect((await login.start()).ok).toBe(true)
    const root = dirname(JSON.parse(readFileSync(report, 'utf-8')).configDir)
    login.cancel()
    expect(login.getError()).toBe('cancelled')
    await waitFor(() => !existsSync(root), 3000)
  }, 20_000)

  it('a missing claude binary is a launch failure, not a hang', async () => {
    const login = new SetupTokenLogin(() => launchSetupTokenRelay(join(dir, 'no-such-claude')))
    const r = await login.start()
    expect(r).toEqual({ ok: false, code: 'exited' })
  }, 20_000)
})
