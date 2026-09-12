// VAULTNEMA912: vault-resolve.mjs closed three different worlds with the same
// outcome -- exit 0, empty stdout: a correct call, an unknown label, and a
// malformed line (missing '='). Measured harm: a community-watch round called
// it with the third shape, read the silence as "the vault gives no output",
// and reported a nonexistent outage while the vault was healthy.
//
// These tests run the REAL script as a child process against a stubbed
// dist/web/vault.js, because the script derives its project root from its own
// file path (__dirname/..) -- so the fixture rebuilds that layout in a temp
// dir rather than importing the script's internals. What is pinned:
//   - the three worlds get three DISTINGUISHABLE outcomes (0 / 2 / 3),
//   - stderr names the malformed line and the missing LABEL,
//   - no secret VALUE ever reaches stderr, on any path,
//   - the success path stays silent on stderr (no logging),
//   - a mixed batch still resolves the good lines and malformed wins the exit.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const ROOT = mkdtempSync(join(tmpdir(), 'vault-resolve-test-'))
const SECRET_VALUE = 'sv-3f6f1e2b-not-a-real-secret'

function run(stdin: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = execFile(
      process.execPath,
      [join(ROOT, 'scripts', 'vault-resolve.mjs')],
      (error, stdout, stderr) => {
        const code = error && typeof (error as NodeJS.ErrnoException & { code?: number }).code === 'number'
          ? ((error as unknown as { code: number }).code)
          : error ? 1 : 0
        resolve({ code, stdout, stderr })
      },
    )
    child.stdin!.end(stdin)
  })
}

beforeAll(() => {
  mkdirSync(join(ROOT, 'scripts'), { recursive: true })
  mkdirSync(join(ROOT, 'dist', 'web'), { recursive: true })
  copyFileSync(
    join(process.cwd(), 'scripts', 'vault-resolve.mjs'),
    join(ROOT, 'scripts', 'vault-resolve.mjs'),
  )
  // The stub mirrors the real contract: a known label resolves, anything
  // else returns null. The value is a fixture string, not vault content.
  writeFileSync(
    join(ROOT, 'dist', 'web', 'vault.js'),
    `export function getSecret(id) { return id === 'KNOWN-LABEL' ? '${SECRET_VALUE}' : null }\n`,
  )
})

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true })
})

describe('vault-resolve: the three worlds are distinguishable', () => {
  it('world 1 -- correct call: exit 0, the pair on stdout, SILENT stderr', async () => {
    const r = await run('PAT=KNOWN-LABEL\n')
    expect(r.code).toBe(0)
    expect(r.stdout).toBe(`PAT=${SECRET_VALUE}\n`)
    expect(r.stderr).toBe('')
  })

  it('world 2 -- malformed line (no =): exit 2, the line named on stderr', async () => {
    const r = await run('KNOWN-LABEL\n')
    expect(r.code).toBe(2)
    expect(r.stdout).toBe('')
    expect(r.stderr).toContain("malformed line (no '=')")
    expect(r.stderr).toContain('KNOWN-LABEL')
  })

  it('world 3 -- unknown label: exit 3, the LABEL named on stderr', async () => {
    const r = await run('PAT=NO-SUCH-LABEL\n')
    expect(r.code).toBe(3)
    expect(r.stdout).toBe('')
    expect(r.stderr).toContain('no secret in the vault for label: NO-SUCH-LABEL')
  })

  it('no path ever writes a secret VALUE to stderr', async () => {
    for (const stdin of ['PAT=KNOWN-LABEL\n', 'KNOWN-LABEL\n', 'PAT=NO-SUCH-LABEL\n',
                         'A=KNOWN-LABEL\nbad-line\nB=NO-SUCH-LABEL\n']) {
      const r = await run(stdin)
      expect(r.stderr).not.toContain(SECRET_VALUE)
    }
  })

  it('mixed batch: good lines still resolve, every failure is reported, malformed wins the exit', async () => {
    const r = await run('A=KNOWN-LABEL\nbad-line\nB=NO-SUCH-LABEL\n')
    expect(r.code).toBe(2)
    expect(r.stdout).toBe(`A=${SECRET_VALUE}\n`)
    expect(r.stderr).toContain('bad-line')
    expect(r.stderr).toContain('NO-SUCH-LABEL')
  })

  it('blank lines stay ignored (not promoted to malformed)', async () => {
    const r = await run('\nPAT=KNOWN-LABEL\n\n')
    expect(r.code).toBe(0)
    expect(r.stderr).toBe('')
  })
})
