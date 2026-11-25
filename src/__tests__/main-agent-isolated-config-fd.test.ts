// ISOCFGFD3-1125: scripts/main-agent-isolated-config.mjs writes its contract line to fd 3 ONLY when the caller says
// so (MARVEEN_CONTRACT_FD=3), else to stdout. The old "does fd 3 exist" probe said yes in a hand-run on macOS (fd 3
// is libuv's own pipe there) and the write failed. Run for real against a stub dist in a throwaway project root,
// so nothing of the install is provisioned or read.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

let proj: string
beforeAll(() => {
  proj = mkdtempSync(join(tmpdir(), 'isocfg-fd-'))
  mkdirSync(join(proj, 'scripts'), { recursive: true })
  mkdirSync(join(proj, 'dist', 'web'), { recursive: true })
  copyFileSync(join(__dirname, '../../scripts/main-agent-isolated-config.mjs'), join(proj, 'scripts', 'main-agent-isolated-config.mjs'))
  // The stub logs to stdout the way pino does, then decides "explicit".
  writeFileSync(join(proj, 'dist', 'web', 'agent-process.js'), [
    "process.stdout.write('NOISE-ON-STDOUT\\n')",
    "export const resolveMainAgentConfigDir = () => '/x/explicit'",
    'export const explicitConfigDirLacksOwnLogin = () => false',
    'export const resolveMainAgentRotatedConfigDir = () => null',
    'export const resolveMainAgentRotatedTokenSecretId = () => null',
    'export const ensureMainAgentIsolatedConfigDir = () => null',
    'export const ensureMainAgentIsolatedConfigDirForRotatedToken = () => null',
  ].join('\n'))
})
afterAll(() => { rmSync(proj, { recursive: true, force: true }) })

const run = (env: Record<string, string>, fd3: boolean) => {
  const e = { ...process.env, ...env }
  if (!('MARVEEN_CONTRACT_FD' in env)) delete e.MARVEEN_CONTRACT_FD
  const r = spawnSync(process.execPath, [join(proj, 'scripts', 'main-agent-isolated-config.mjs')], {
    env: e, encoding: 'utf-8', stdio: fd3 ? ['ignore', 'pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
  })
  return { status: r.status, stdout: String(r.output[1] ?? ''), stderr: String(r.output[2] ?? ''), fd3: fd3 ? String(r.output[3] ?? '') : '' }
}

describe('main-agent-isolated-config.mjs contract descriptor', () => {
  it('a hand-run (no flag, no fd 3): the contract is on stdout', () => {
    const r = run({}, false)
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('explicit\t/x/explicit\n')
  })
  it('the callers\' form (MARVEEN_CONTRACT_FD=3 with fd 3 open): the contract is on fd 3 only, stdout carries just the noise', () => {
    const r = run({ MARVEEN_CONTRACT_FD: '3' }, true)
    expect(r.status, r.stderr).toBe(0)
    expect(r.fd3).toBe('explicit\t/x/explicit\n')
    expect(r.stdout).toBe('NOISE-ON-STDOUT\n')
  })
  it('an open fd 3 WITHOUT the flag is not taken for the contract: stdout, fd 3 stays empty', () => {
    const r = run({}, true)
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('explicit\t/x/explicit\n')
    expect(r.fd3).toBe('')
  })
})
