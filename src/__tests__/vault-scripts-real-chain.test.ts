// The REAL chain of the two Claude Code helper scripts (scripts/vault-headers-helper.mjs, scripts/vault-resolve.mjs):
// the script -> the COMPILED dist/web/vault.js (built here from src with tsc) -> the real logger (it reads LOG_LEVEL when its
// module is imported) -> the real getMasterKey() -> the Keychain failure branch. The script-level tests use a hand-written
// stub vault module that reacts to exactly the variables the fix sets; this file is the one that proves the pieces work
// TOGETHER, on the real build output.
//
// What is faked, and why it is safe: a preload (`node --import`) makes node:os report darwin and replaces
// child_process.execFileSync for /usr/bin/security with an always-failing stand-in that records the call. The real Keychain
// is NEVER touched (not even on a developer's Mac), and the macOS-without-a-GUI-session failure (the `security` call fails
// or times out) is reproduced on any platform. PATH cannot be used for this: keychain.ts calls the absolute /usr/bin/security.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { execFile, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const REPO = process.cwd()
const ROOT = mkdtempSync(join(tmpdir(), 'vault-real-chain-'))
const STORE = join(ROOT, 'store')
const SEC_LOG = join(ROOT, 'security-calls.log')
const PRELOAD = join(ROOT, 'preload.mjs')
const VALUE = 'rc-7f3a-not-a-real-secret'

type Result = { code: number; stdout: string; stderr: string }

function run(args: string[], env: Record<string, string> = {}, stdin?: string): Promise<Result> {
  return new Promise(res => {
    const child = execFile(process.execPath, ['--import', PRELOAD, ...args], {
      cwd: ROOT,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: join(ROOT, 'home'), PRELOAD_PLATFORM: 'darwin', SECURITY_CALL_LOG: SEC_LOG, ...env },
      timeout: 60_000,
    }, (error, stdout, stderr) => {
      const code = error && typeof (error as unknown as { code?: number }).code === 'number' ? (error as unknown as { code: number }).code : error ? 1 : 0
      res({ code, stdout, stderr })
    })
    if (stdin !== undefined) child.stdin?.end(stdin)
    else child.stdin?.end()
  })
}

const secCalls = (): string[] => (existsSync(SEC_LOG) ? readFileSync(SEC_LOG, 'utf-8').split('\n').filter(Boolean) : [])
const headersScript = () => join(ROOT, 'scripts', 'vault-headers-helper.mjs')
const resolveScript = () => join(ROOT, 'scripts', 'vault-resolve.mjs')

beforeAll(async () => {
  mkdirSync(join(ROOT, 'scripts'), { recursive: true })
  mkdirSync(join(ROOT, 'home'), { recursive: true })
  mkdirSync(STORE, { recursive: true })   // the dashboard always has store/; the vault module does not create it
  for (const f of ['vault-headers-helper.mjs', 'vault-resolve.mjs']) copyFileSync(join(REPO, 'scripts', f), join(ROOT, 'scripts', f))
  writeFileSync(join(ROOT, 'package.json'), '{ "type": "module" }\n')
  symlinkSync(join(REPO, 'node_modules'), join(ROOT, 'node_modules'))
  // the preload: platform = $PRELOAD_PLATFORM, and /usr/bin/security never runs (recorded, then it fails like on a Mac without a GUI)
  writeFileSync(PRELOAD, `
import os from 'node:os'
import cp from 'node:child_process'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
if (process.env.PRELOAD_PLATFORM) os.platform = () => process.env.PRELOAD_PLATFORM
const real = cp.execFileSync
cp.execFileSync = function (file, args, opts) {
  if (file === '/usr/bin/security') {
    if (process.env.SECURITY_CALL_LOG) fs.appendFileSync(process.env.SECURITY_CALL_LOG, String(args && args[0]) + '\\n')
    const e = new Error('security: stand-in, always fails'); e.status = 1; throw e
  }
  return real.apply(this, arguments)
}
syncBuiltinESMExports()
`)
  // the REAL compiled vault module: only the import graph of src/web/vault.ts is compiled, into <ROOT>/dist
  writeFileSync(join(ROOT, 'tsconfig.json'), JSON.stringify({
    extends: join(REPO, 'tsconfig.json'),
    compilerOptions: { outDir: join(ROOT, 'dist'), rootDir: join(REPO, 'src'), noEmit: false, incremental: false },
    include: [join(REPO, 'src', 'web', 'vault.ts')],
    exclude: [],
  }))
  execFileSync(process.execPath, [resolve(REPO, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(ROOT, 'tsconfig.json')], { cwd: ROOT, stdio: 'pipe' })
  expect(existsSync(join(ROOT, 'dist', 'web', 'vault.js'))).toBe(true)
  // a real vault with one secret and a file key, made as a NON-darwin process (the file-key path), the real Keychain untouched
  const seed = join(ROOT, 'seed.mjs')
  writeFileSync(seed, `const { setSecret } = await import(${JSON.stringify(join(ROOT, 'dist', 'web', 'vault.js'))})\nsetSecret('KNOWN', 'probe', ${JSON.stringify(VALUE)})\n`)
  const s = await run([seed], { PRELOAD_PLATFORM: 'linux', LOG_LEVEL: 'silent' })
  expect(s.code, s.stderr).toBe(0)
  expect(existsSync(join(STORE, '.vault-key'))).toBe(true)
  expect(secCalls()).toEqual([])
}, 240_000)
afterAll(() => { rmSync(ROOT, { recursive: true, force: true }) })
beforeEach(() => { rmSync(SEC_LOG, { force: true }) })   // every test sees only its own `security` calls

// a driver that imports the compiled module directly, with NO fix applied (the behaviour before the change)
const driver = (): string => {
  const p = join(ROOT, 'old-driver.mjs')
  writeFileSync(p, `const { getSecret } = await import(${JSON.stringify(join(ROOT, 'dist', 'web', 'vault.js'))})\nprocess.stdout.write(getSecret('KNOWN') + '\\n')\n`)
  return p
}

describe('the real chain, macOS-like (platform darwin, `security` always fails): the scripts keep stdout clean', () => {
  it('headersHelper: stdout is exactly the headers JSON (one line), stderr empty, the Keychain is never called, the key file stays', async () => {
    const r = await run([headersScript(), 'Authorization=Bearer:::KNOWN'])
    expect(r.code, r.stderr).toBe(0)
    expect(r.stdout.trim().split('\n')).toHaveLength(1)
    expect(JSON.parse(r.stdout)).toEqual({ Authorization: `Bearer ${VALUE}` })
    expect(r.stderr).toBe('')
    expect(secCalls()).toEqual([])
    expect(existsSync(join(STORE, '.vault-key'))).toBe(true)
    expect(existsSync(join(STORE, '.vault-key.migrated'))).toBe(false)
  })

  it('resolver: stdout is exactly the ENV_VAR=value line, stderr empty, the Keychain is never called', async () => {
    const r = await run([resolveScript()], {}, 'MY_TOKEN=KNOWN\n')
    expect(r.code, r.stderr).toBe(0)
    expect(r.stdout).toBe(`MY_TOKEN=${VALUE}\n`)
    expect(r.stderr).toBe('')
    expect(secCalls()).toEqual([])
    expect(existsSync(join(STORE, '.vault-key'))).toBe(true)
  })

  it('CONTROL (the old behaviour, same chain, no fix): the migration IS attempted and the logger warning reaches stdout in front of the value', async () => {
    const r = await run([driver()])
    expect(r.code, r.stderr).toBe(0)
    expect(secCalls().some(c => c === 'add-generic-password')).toBe(true)   // the Keychain was touched
    const lines = r.stdout.split('\n').filter(Boolean)
    expect(lines.length).toBeGreaterThan(1)
    expect(lines.join('\n')).toContain('Keychain migration failed')          // the warning that used to corrupt the JSON
    expect(lines).toContain(VALUE)                                           // (the pretty logger flushes from a worker thread: its lines may come after the value)
    expect(existsSync(join(STORE, '.vault-key'))).toBe(true)                // the failed migration keeps the file key
  })

  it('half-fix 1: only the logger silenced -> stdout is clean but the Keychain call STILL happens (the switch is needed)', async () => {
    const r = await run([driver()], { LOG_LEVEL: 'silent' })
    expect(r.stdout).toBe(`${VALUE}\n`)
    expect(secCalls().some(c => c === 'add-generic-password')).toBe(true)
  })

  it('half-fix 2: only the switch -> no Keychain call, but the one-time info line reaches stdout unless the logger is silent (both are needed)', async () => {
    const r = await run([driver()], { MARVEEN_VAULT_NO_KEYCHAIN_MIGRATION: '1' })
    expect(secCalls()).toEqual([])
    const lines = r.stdout.split('\n').filter(Boolean)
    expect(lines).toContain(VALUE)
    expect(lines.length).toBeGreaterThan(1)                                                         // the notice is on stdout
    expect(lines.filter(l => l.includes('MARVEEN_VAULT_NO_KEYCHAIN_MIGRATION')).length).toBe(1)   // once per process
  })

  it('the switch notice is a WARN: it stays visible at LOG_LEVEL=warn (a mistaken switch must not be silent), and the scripts\' silent level still hides it', async () => {
    const warn = await run([driver()], { MARVEEN_VAULT_NO_KEYCHAIN_MIGRATION: '1', LOG_LEVEL: 'warn' })
    expect(warn.stdout).toContain('MARVEEN_VAULT_NO_KEYCHAIN_MIGRATION')
    const silent = await run([driver()], { MARVEEN_VAULT_NO_KEYCHAIN_MIGRATION: '1', LOG_LEVEL: 'silent' })
    expect(silent.stdout).toBe(`${VALUE}\n`)
  })

  it('the switch notice is logged ONCE per process, however many secrets are read', async () => {
    const p = join(ROOT, 'many-driver.mjs')
    writeFileSync(p, `const { getSecret } = await import(${JSON.stringify(join(ROOT, 'dist', 'web', 'vault.js'))})\nfor (let i = 0; i < 4; i++) process.stdout.write(getSecret('KNOWN') + '\\n')\n`)
    const r = await run([p], { MARVEEN_VAULT_NO_KEYCHAIN_MIGRATION: '1' })
    const lines = r.stdout.split('\n').filter(Boolean)
    expect(lines.filter(l => l === VALUE)).toHaveLength(4)
    expect(lines.filter(l => l.includes('MARVEEN_VAULT_NO_KEYCHAIN_MIGRATION'))).toHaveLength(1)
    expect(secCalls()).toEqual([])
  })

  it('a wrong file key still fails closed through the real chain, and the Keychain is not touched', async () => {
    const keyFile = join(STORE, '.vault-key')
    const good = readFileSync(keyFile, 'utf-8')
    try {
      writeFileSync(keyFile, Buffer.from('x'.repeat(32)).toString('base64') + '\n')
      const wrongKey = Buffer.from('x'.repeat(32)).toString('base64')
      const r = await run([headersScript(), 'Authorization=Bearer:::KNOWN'])
      expect(r.code).not.toBe(0)
      expect(r.stdout).toBe('')                                          // no JSON, and no logger line either
      expect(r.stderr).toContain('does not decrypt vault.json')          // the loud reason is on stderr
      expect(r.stderr).not.toContain(wrongKey)                           // ... never a key value
      expect(r.stdout + r.stderr).not.toContain(VALUE)
      expect(secCalls()).toEqual([])
      // the resolver has the same contract on its failure branch
      const q = await run([resolveScript()], {}, 'MY_TOKEN=KNOWN\n')
      expect(q.code).not.toBe(0)
      expect(q.stdout).toBe('')
      expect(q.stderr).toContain('does not decrypt vault.json')
      expect(q.stderr).not.toContain(wrongKey)
      expect(q.stdout + q.stderr).not.toContain(VALUE)
      expect(secCalls()).toEqual([])
    } finally {
      writeFileSync(keyFile, good)
    }
  })
})
