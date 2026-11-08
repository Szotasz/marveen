// VAULTWRAPMULTI1108: a MULTI-LINE secret (an APNs .p8 PEM key) through the REAL chain, vault-env-wrapper.sh ->
// vault-resolve.mjs --escaped -> a stubbed vault (the fixture layout of vault-resolve-loud-failures.test.ts: the script
// derives its project root from its own path). Measured before the fix (2026-10-31, GROMZOPUSH1031): the wrapper read
// the resolver line by line, a line of the key became a "name", export refused it, and bash printed it into stderr.
// What is pinned: the value arrives byte for byte (line feeds, a trailing line feed, backslashes, '='), and no byte of
// it reaches stderr; the default (unescaped) resolver output is unchanged for its other callers.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const ROOT = mkdtempSync(join(tmpdir(), 'vault-wrap-multi-'))
// Fixture strings, not real keys. The base64-looking lines carry '+' and '/', as a real PEM does: those make a line
// an invalid shell name, which is what put it into bash's error message.
const PEM = '-----BEGIN FIXTURE BLOCK-----\nMIGTAgEA+MBMG/FIXTUREONLY0123\nZZQU+JV/FIXTUREONLY4567==\n-----END FIXTURE BLOCK-----\n'
const ODD = 'a\\nb\\\\c\\ =x\r\ny'

function run(file: string, args: string[], env: Record<string, string>, stdin = ''): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(file, args, { env: { PATH: process.env.PATH ?? '', HOME: ROOT, ...env } }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1) : 0
      resolve({ code, stdout, stderr })
    })
    child.stdin!.end(stdin)
  })
}

beforeAll(() => {
  mkdirSync(join(ROOT, 'scripts'), { recursive: true })
  mkdirSync(join(ROOT, 'dist', 'web'), { recursive: true })
  for (const f of ['vault-resolve.mjs', 'vault-dashboard-client.mjs', 'vault-env-wrapper.sh']) {
    copyFileSync(join(process.cwd(), 'scripts', f), join(ROOT, 'scripts', f))
  }
  writeFileSync(join(ROOT, 'dist', 'web', 'vault.js'),
    `export function getSecret(id) { return id === 'PEM-LABEL' ? ${JSON.stringify(PEM)} : id === 'ODD-LABEL' ? ${JSON.stringify(ODD)} : id === 'PLAIN-LABEL' ? 'plain' : null }\n`)
})

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true })
})

const DUMP = 'process.stdout.write(JSON.stringify({ PEM: process.env.PEM ?? null, ODD: process.env.ODD ?? null, PLAIN: process.env.PLAIN ?? null }))'

describe('a multi-line secret through vault-env-wrapper.sh (VAULTWRAPMULTI1108)', () => {
  it('arrives byte for byte, and nothing of it reaches stderr', async () => {
    const r = await run('bash', [join(ROOT, 'scripts', 'vault-env-wrapper.sh'), process.execPath, '-e', DUMP],
      { PEM: 'vault:PEM-LABEL', ODD: 'vault:ODD-LABEL', PLAIN: 'vault:PLAIN-LABEL' })
    expect(r.code, r.stderr).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual({ PEM, ODD, PLAIN: 'plain' })
    expect(r.stderr).toBe('')
  })

  it('a missing label still starts the server with the resolved subset, and stderr names labels only', async () => {
    const r = await run('bash', [join(ROOT, 'scripts', 'vault-env-wrapper.sh'), process.execPath, '-e', DUMP],
      { PEM: 'vault:PEM-LABEL', PLAIN: 'vault:NO-SUCH-LABEL' })
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout).PEM).toBe(PEM)
    expect(r.stderr).toContain('NO-SUCH-LABEL')
    expect(r.stderr).not.toContain('FIXTUREONLY')
  })

  it('vault-resolve --escaped: one line per value; the default form is unchanged', async () => {
    const esc = await run(process.execPath, [join(ROOT, 'scripts', 'vault-resolve.mjs'), '--escaped'], {}, 'PEM=PEM-LABEL\nODD=ODD-LABEL\n')
    expect(esc.code).toBe(0)
    const lines = esc.stdout.split('\n').filter(Boolean)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe('PEM=' + PEM.replace(/\\/g, '\\\\').replace(/\n/g, '\\n'))
    expect(lines[1]).toBe('ODD=a\\\\nb\\\\\\\\c\\\\ =x\\r\\ny')
    const plain = await run(process.execPath, [join(ROOT, 'scripts', 'vault-resolve.mjs')], {}, 'PEM=PEM-LABEL\n')
    expect(plain.stdout).toBe(`PEM=${PEM}\n`)
    const bad = await run(process.execPath, [join(ROOT, 'scripts', 'vault-resolve.mjs'), '--escaped', 'x'], {}, 'PEM=PEM-LABEL\n')
    expect(bad.code).toBe(2)
    expect(bad.stdout).toBe('')
  })
})
