// VAULTRESOLVECASE1105: the silent-empty paths of vault-resolve.mjs that VAULTNEMA912 left open, measured 2026-11-06.
//   - An id given as an ARGUMENT was ignored: the script read an empty stdin and exited 0 with no output.
//   - The pipe recipe `| cut -d= -f2-` hands the caller cut's exit code, so a missing label became an empty password
//     with exit 0 (srv2127946, 2026-11-05: an empty root password, two "Failed password", a false lock-out alarm).
// The new `--value <id>` form needs no pipe: the raw value on stdout, the exit code straight to the caller, and an
// EMPTY value refused. These tests run the REAL script against a stubbed dist/web/vault.js, as
// vault-resolve-loud-failures.test.ts does, and check that no value ever reaches stderr.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const ROOT = mkdtempSync(join(tmpdir(), 'vault-resolve-value-'))
const SECRET_VALUE = 'sv-7d1c-not-a-real-secret'

function run(args: string[], stdin: string | null): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = execFile(process.execPath, [join(ROOT, 'scripts', 'vault-resolve.mjs'), ...args], (error, stdout, stderr) => {
      const code = error && typeof (error as unknown as { code?: unknown }).code === 'number'
        ? (error as unknown as { code: number }).code
        : error ? 1 : 0
      resolve({ code, stdout, stderr })
    })
    if (stdin === null) child.stdin!.end()
    else child.stdin!.end(stdin)
  })
}

beforeAll(() => {
  mkdirSync(join(ROOT, 'scripts'), { recursive: true })
  mkdirSync(join(ROOT, 'dist', 'web'), { recursive: true })
  copyFileSync(join(process.cwd(), 'scripts', 'vault-resolve.mjs'), join(ROOT, 'scripts', 'vault-resolve.mjs'))
  copyFileSync(join(process.cwd(), 'scripts', 'vault-dashboard-client.mjs'), join(ROOT, 'scripts', 'vault-dashboard-client.mjs'))
  // Exact-id lookup, as the real getSecret (vault.ts: entries.find(e => e.id === id)).
  writeFileSync(join(ROOT, 'dist', 'web', 'vault.js'), `export function getSecret(id) {
  if (id === 'KNOWN-LABEL' || id === 'ssh-key-abc123') return '${SECRET_VALUE}'
  if (id === 'EMPTY-LABEL') return ''
  return null
}\n`)
})
afterAll(() => { rmSync(ROOT, { recursive: true, force: true }) })

const noValueOnStderr = (r: { stderr: string }) => expect(r.stderr).not.toContain(SECRET_VALUE)

describe('vault-resolve --value <id>: no pipe, the exit code reaches the caller', () => {
  it('a known label: exit 0, the raw value only (no prefix, no newline), silent stderr', async () => {
    const r = await run(['--value', 'KNOWN-LABEL'], null)
    expect(r).toEqual({ code: 0, stdout: SECRET_VALUE, stderr: '' })
  })

  it('an unknown label, and a wrong-case alias of a known one: exit 3, nothing on stdout, the label named', async () => {
    for (const id of ['NO-SUCH-LABEL', 'known-label']) {
      const r = await run(['--value', id], null)
      expect(r.code, id).toBe(3)
      expect(r.stdout).toBe('')
      expect(r.stderr).toContain(`no secret in the vault for label: ${id}`)
      noValueOnStderr(r)
    }
  })

  it('a label that holds an EMPTY value: exit 6, nothing on stdout (an empty password is never the answer)', async () => {
    const r = await run(['--value', 'EMPTY-LABEL'], null)
    expect(r.code).toBe(6)
    expect(r.stdout).toBe('')
    expect(r.stderr).toContain('the label holds an EMPTY value: EMPTY-LABEL')
  })

  it('an SSH private key stays refused: exit 4, no value', async () => {
    const r = await run(['--value', 'ssh-key-abc123'], null)
    expect(r.code).toBe(4)
    expect(r.stdout).toBe('')
    noValueOnStderr(r)
  })

  it('the shell recipe: a missing label stops the caller instead of giving it an empty string', async () => {
    const script = `P="$(${JSON.stringify(process.execPath)} ${JSON.stringify(join(ROOT, 'scripts', 'vault-resolve.mjs'))} --value NO-SUCH-LABEL)" || { echo "stopped rc=$?"; exit 0; }; echo "used:[$P]"`
    const out = await new Promise<string>((resolve) => execFile('/bin/bash', ['-c', script], (_e, stdout) => resolve(stdout)))
    expect(out.trim()).toBe('stopped rc=3')
  })
})

describe('the other silent paths are loud now', () => {
  it('an id given as a plain argument (the old silent exit 0): exit 2, the argument not echoed', async () => {
    const r = await run(['KNOWN-LABEL'], null)
    expect(r.code).toBe(2)
    expect(r.stdout).toBe('')
    expect(r.stderr).toContain("exactly '--value <secret_id>'")
    expect(r.stderr).not.toContain('KNOWN-LABEL')
  })

  it('--value with no id, or with extra arguments: exit 2', async () => {
    expect((await run(['--value'], null)).code).toBe(2)
    expect((await run(['--value', 'A', 'B'], null)).code).toBe(2)
    expect((await run(['--value', '  '], null)).code).toBe(2)
  })

  it('--value takes exactly ONE label: a newline, a space or an = is exit 2, nothing printed, the id not echoed (Dani #2563)', async () => {
    for (const id of ['KNOWN-LABEL\nB=KNOWN-LABEL', 'KNOWN-LABEL\n', 'KNOWN LABEL', ' KNOWN-LABEL', 'X=KNOWN-LABEL', 'KNOWN-LABEL\t']) {
      const r = await run(['--value', id], null)
      expect(r.code, JSON.stringify(id)).toBe(2)
      expect(r.stdout).toBe('')
      expect(r.stderr).not.toContain('KNOWN-LABEL')
      noValueOnStderr(r)
    }
  })

  it('an empty stdin: exit 2, not a silent success', async () => {
    for (const input of ['', '\n', '  \n\n']) {
      const r = await run([], input)
      expect(r.code, JSON.stringify(input)).toBe(2)
      expect(r.stderr).toContain('no input line')
    }
  })

  it('the line form keeps its contract; an empty value still prints for old callers, with a warning naming the label', async () => {
    expect(await run([], 'PAT=KNOWN-LABEL\n')).toEqual({ code: 0, stdout: `PAT=${SECRET_VALUE}\n`, stderr: '' })
    const r = await run([], 'PAT=EMPTY-LABEL\n')
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('PAT=\n')
    expect(r.stderr).toContain('warning: the label holds an EMPTY value: EMPTY-LABEL')
  })
})
