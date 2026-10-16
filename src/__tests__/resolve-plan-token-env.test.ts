// PR #1304 review (c): the old inline
//   printf 'T=%s' '<id>' | node vault-resolve.mjs | cut -d= -f2-
// swallowed a missing secret's exit 3 and exported CLAUDE_CODE_OAUTH_TOKEN
// EMPTY, launching exactly the unauthenticated session token-mode plans exist
// to prevent. scripts/resolve-plan-token-env.mjs replaces that pipeline: it
// resolves the plan's own vault secret, falls back to the fleet token when
// the secret is missing, and only fails loudly (exit 1, nothing on stdout)
// when NEITHER is available -- see the script's own header for the full
// contract.
//
// These tests run the REAL script as a child process against a stubbed
// dist/web/vault.js, same approach as vault-resolve-loud-failures.test.ts and
// for the same reason (the script derives its project root from its own file
// path).

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const ROOT = mkdtempSync(join(tmpdir(), 'resolve-plan-token-env-test-'))
const PLAN_TOKEN_VALUE = 'test-fixture-not-a-real-plan-token-oat01'
const FLEET_TOKEN_VALUE = 'test-fixture-not-a-real-fleet-token-oat01'
const FLEET_TOKEN_PATH = join(ROOT, 'store', '.claude-oauth-token')
const FAILURES_LOG_PATH = join(ROOT, 'store', 'channels-failures.log')

function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    execFile(
      process.execPath,
      [join(ROOT, 'scripts', 'resolve-plan-token-env.mjs'), ...args],
      (error, stdout, stderr) => {
        const code = error && typeof (error as NodeJS.ErrnoException & { code?: number }).code === 'number'
          ? ((error as unknown as { code: number }).code)
          : error ? 1 : 0
        resolve({ code, stdout, stderr })
      },
    )
  })
}

function failuresLog(): string {
  return existsSync(FAILURES_LOG_PATH) ? readFileSync(FAILURES_LOG_PATH, 'utf-8') : ''
}

beforeAll(() => {
  mkdirSync(join(ROOT, 'scripts'), { recursive: true })
  mkdirSync(join(ROOT, 'dist', 'web'), { recursive: true })
  mkdirSync(join(ROOT, 'store'), { recursive: true })
  copyFileSync(
    join(process.cwd(), 'scripts', 'resolve-plan-token-env.mjs'),
    join(ROOT, 'scripts', 'resolve-plan-token-env.mjs'),
  )
  // Stub: only KNOWN-PLAN-ID resolves; anything else is "missing" (getSecret
  // returns null, mirroring vault.ts's real contract).
  writeFileSync(
    join(ROOT, 'dist', 'web', 'vault.js'),
    `export function getSecret(id) { return id === 'KNOWN-PLAN-ID' ? '${PLAN_TOKEN_VALUE}' : null }\n`,
  )
})

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true })
})

beforeEach(() => {
  try { rmSync(FLEET_TOKEN_PATH) } catch { /* may not exist */ }
  try { rmSync(FAILURES_LOG_PATH) } catch { /* may not exist */ }
})

describe('resolve-plan-token-env: the plan secret, the fleet fallback, and the loud failure', () => {
  it('resolves the plan\'s own vault secret when it exists -- no fallback, no log line', async () => {
    const r = await run(['KNOWN-PLAN-ID', FLEET_TOKEN_PATH, FAILURES_LOG_PATH])
    expect(r.code).toBe(0)
    expect(r.stdout).toBe(PLAN_TOKEN_VALUE)
    expect(failuresLog()).toBe('')
  })

  // The required negative test: a missing secret must NOT start the session
  // with an empty token.
  it('a missing secret falls back to the fleet token instead of exporting empty', async () => {
    writeFileSync(FLEET_TOKEN_PATH, FLEET_TOKEN_VALUE)
    const r = await run(['MISSING-PLAN-ID', FLEET_TOKEN_PATH, FAILURES_LOG_PATH])
    expect(r.code).toBe(0)
    expect(r.stdout).toBe(FLEET_TOKEN_VALUE)
    expect(r.stdout).not.toBe('')
  })

  it('a missing secret with no fleet token either: exits 1, prints NOTHING (never an empty-but-exported token)', async () => {
    // FLEET_TOKEN_PATH deliberately not created.
    const r = await run(['MISSING-PLAN-ID', FLEET_TOKEN_PATH, FAILURES_LOG_PATH])
    expect(r.code).toBe(1)
    expect(r.stdout).toBe('')
  })

  it('an empty (blank) fleet-token file counts as unavailable, same as a missing one', async () => {
    writeFileSync(FLEET_TOKEN_PATH, '   \n')
    const r = await run(['MISSING-PLAN-ID', FLEET_TOKEN_PATH, FAILURES_LOG_PATH])
    expect(r.code).toBe(1)
    expect(r.stdout).toBe('')
  })

  it('the failures log names the plan secret id but never any secret value', async () => {
    writeFileSync(FLEET_TOKEN_PATH, FLEET_TOKEN_VALUE)
    await run(['MISSING-PLAN-ID', FLEET_TOKEN_PATH, FAILURES_LOG_PATH])
    const log = failuresLog()
    expect(log).toContain('MISSING-PLAN-ID')
    expect(log).not.toContain(FLEET_TOKEN_VALUE)
    expect(log).not.toContain(PLAN_TOKEN_VALUE)
  })

  it('the FATAL failures-log line also never leaks a value, even though there is none to leak', async () => {
    const r = await run(['MISSING-PLAN-ID', FLEET_TOKEN_PATH, FAILURES_LOG_PATH])
    expect(r.code).toBe(1)
    const log = failuresLog()
    expect(log).toContain('FATAL')
    expect(log).toContain('MISSING-PLAN-ID')
    expect(log).not.toContain(PLAN_TOKEN_VALUE)
  })

  it('the success path (plan secret resolves) never touches the failures log', async () => {
    const r = await run(['KNOWN-PLAN-ID', FLEET_TOKEN_PATH, FAILURES_LOG_PATH])
    expect(r.code).toBe(0)
    expect(existsSync(FAILURES_LOG_PATH)).toBe(false)
  })
})
