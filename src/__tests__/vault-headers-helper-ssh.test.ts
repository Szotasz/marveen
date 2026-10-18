// VAULTSZELES826: vault-headers-helper.mjs puts vault secrets into HTTP headers for REMOTE
// MCP servers. An SSH private key must never leave that way. The REAL script runs as a child
// process against a stubbed dist/web/vault.js, the same layout trick as
// vault-resolve-loud-failures.test.ts (the script derives its root from its own path).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const ROOT = mkdtempSync(join(tmpdir(), 'vault-headers-helper-test-'))
const VALUE = 'hv-9a1c-not-a-real-secret'

function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    execFile(process.execPath, [join(ROOT, 'scripts', 'vault-headers-helper.mjs'), ...args], (error, stdout, stderr) => {
      const code = error && typeof (error as unknown as { code?: number }).code === 'number' ? (error as unknown as { code: number }).code : error ? 1 : 0
      resolve({ code, stdout, stderr })
    })
  })
}

beforeAll(() => {
  mkdirSync(join(ROOT, 'scripts'), { recursive: true })
  mkdirSync(join(ROOT, 'dist', 'web'), { recursive: true })
  copyFileSync(join(process.cwd(), 'scripts', 'vault-headers-helper.mjs'), join(ROOT, 'scripts', 'vault-headers-helper.mjs'))
  // The stub behaves like the real vault module on macOS without a GUI session: unless the helper silenced the logger
  // it logs a Keychain-migration warning to STDOUT, and unless it switched the migration off it "tries" it (a line on stderr).
  writeFileSync(join(ROOT, 'dist', 'web', 'vault.js'),
    `// the real logger reads LOG_LEVEL when its module is IMPORTED, so the stub decides at import time too
const noisy = process.env.LOG_LEVEL !== 'silent'
export function getSecret(id) {
  if (noisy) process.stdout.write('{"level":40,"msg":"Keychain migration failed, keeping file-based key"}\\n')
  if (process.env.MARVEEN_VAULT_NO_KEYCHAIN_MIGRATION !== '1') process.stderr.write('KEYCHAIN-MIGRATION-ATTEMPT\\n')
  return id === 'KNOWN' || id === 'ssh-key-abc123' ? '${VALUE}' : null
}\n`)
})
afterAll(() => { rmSync(ROOT, { recursive: true, force: true }) })

describe('vault-headers-helper: an SSH private key is never sent as a header', () => {
  it('refuses the ssh-key id: no header on stdout, the refusal on stderr, no value anywhere', async () => {
    const r = await run(['Authorization=Bearer:::ssh-key-abc123'])
    expect(JSON.parse(r.stdout)).toEqual({})
    expect(r.stderr).toContain('refused, SSH private keys are not sent as headers')
    expect(r.stdout + r.stderr).not.toContain(VALUE)
  })
  it('ORDER control: a refused ssh-key header does not take the headers AFTER it down (continue, not break)', async () => {
    const r = await run(['Authorization=Bearer:::ssh-key-abc123', 'X-Api-Key=KNOWN'])
    expect(JSON.parse(r.stdout)).toEqual({ 'X-Api-Key': VALUE })
    expect(r.stderr).toContain('refused, SSH private keys are not sent as headers')
  })
  it('control: an ordinary secret still becomes the header', async () => {
    const r = await run(['Authorization=Bearer:::KNOWN'])
    expect(JSON.parse(r.stdout)).toEqual({ Authorization: `Bearer ${VALUE}` })
  })
})

// The headersHelper stdout is the JSON object and nothing else. The vault module's Keychain-migration warning
// (a LaunchDaemon has no GUI session, so `security` times out on every call) used to be printed in front of it.
describe('vault-headers-helper: stdout is only the headers JSON', () => {
  it('the logger noise does not reach stdout: the output parses as the JSON object', async () => {
    const r = await run(['Authorization=Bearer:::KNOWN'])
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual({ Authorization: `Bearer ${VALUE}` })
    expect(r.stdout.trim().split('\n')).toHaveLength(1)
  })
  it('the helper does not attempt the Keychain migration (a read-only consumer)', async () => {
    const r = await run(['Authorization=Bearer:::KNOWN', 'X-Api-Key=KNOWN'])
    expect(r.stderr).not.toContain('KEYCHAIN-MIGRATION-ATTEMPT')
  })
  it('a missing secret still gives a clean stdout (the not-found line stays on stderr)', async () => {
    const r = await run(['X-Missing=NOPE'])
    expect(JSON.parse(r.stdout)).toEqual({})
    expect(r.stderr).toContain('not found')
  })
})
