// #1872 (external report): on a token-based macOS install the early headless probe
// ran with the operator's environment only -- the token just entered is not even
// saved yet -- failed with "Not logged in", and told the user that "Agent creation
// WILL fail later". The later service-auth gate then passed with the same token. The
// probe stays (it checks the terminal's own login, which the pairing step's `claude`
// uses), but it no longer predicts anything about the agents.
//
// The cases run the REAL probe block with a stubbed `claude` and the real strings.
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(__dirname, '..', '..')
const MACOS = readFileSync(join(ROOT, 'install-macos.sh'), 'utf-8')
const LANG = readFileSync(join(ROOT, 'install-lang.sh'), 'utf-8')

function probeBlock(): string {
  const start = MACOS.indexOf('# Pre-flight headless probe')
  const end = MACOS.indexOf('INSTALL_STEP="personal-info"', start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return MACOS.slice(start, end)
}

function runProbe(claudeExit: number, claudeOut: string, lang: 'en' | 'hu'): { out: string; code: number | null } {
  const dir = mkdtempSync(join(tmpdir(), 'earlyprobe-'))
  try {
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'claude'), `#!/bin/bash\necho "${claudeOut}"\nexit ${claudeExit}\n`)
    chmodSync(join(bin, 'claude'), 0o755)
    const script = [
      // the installer's own settings: `set -e` (no errtrace) and an ERR trap that exits
      'set -e',
      "trap 'echo ERRTRAP; exit 99' ERR",
      'RED=; GREEN=; ORANGE=; BLUE=; BOLD=; DIM=; NC=',
      'warn() { echo "WARN $*"; }',
      `. "${join(ROOT, 'install-lang.sh')}"`,
      // the token the operator just typed: present in the shell, never exported
      'MACOS_OAUTH_TOKEN_INPUT="sk-ant-oat01-' + 'x'.repeat(48) + '"',
      probeBlock(),
      'echo END',
    ].join('\n')
    const f = join(dir, 'probe.sh')
    writeFileSync(f, script)
    const r = spawnSync('bash', [f], {
      encoding: 'utf-8',
      env: { PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`, HOME: dir, MARVEEN_LANG: lang },
    })
    return { out: (r.stdout ?? '') + (r.stderr ?? ''), code: r.status }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('the early probe says what it checks (real block, stubbed claude)', () => {
  it('a failing terminal login (the reported "Not logged in"): no prediction about the agents (en)', () => {
    const r = runProbe(1, 'Not logged in', 'en')
    expect(r.code).toBe(0)
    expect(r.out).toContain('END') // the probe never stops the install
    expect(r.out).not.toContain('ERRTRAP')
    expect(r.out).not.toMatch(/Agent creation WILL fail/i)
    expect(r.out).toContain("Your terminal's Claude login did not answer")
    expect(r.out).toContain("This is NOT the agents' credential")
    expect(r.out).toContain('Not logged in') // the raw output is still shown
    expect(r.out).toContain('claude /login')
    // the remedy no longer tells the operator to set the agents' env keys in a terminal
    expect(r.out).not.toContain('ANTHROPIC_API_KEY/CLAUDE_CODE_OAUTH_TOKEN')
  })

  it('the same in Hungarian', () => {
    const r = runProbe(1, 'Not logged in', 'hu')
    expect(r.code).toBe(0)
    expect(r.out).not.toMatch(/KESOBB EL fog hasalni/)
    expect(r.out).toContain('Ez NEM az ügynökök hitelesítője')
  })

  it('a working terminal login is reported as exactly that', () => {
    const r = runProbe(0, 'pong', 'en')
    expect(r.code).toBe(0)
    expect(r.out).toContain("Your terminal's Claude login works")
    expect(r.out).not.toContain('WARN')
  })
})

describe('the binding', () => {
  it('no string predicts that agent creation will fail, in either language', () => {
    expect(LANG).not.toMatch(/Agent creation WILL fail/i)
    expect(LANG).not.toMatch(/agent-letrehozas KESOBB/i)
  })
  it("the probe still runs with the operator's environment only (the token is not exported or passed)", () => {
    const block = probeBlock()
    expect(block).toContain('CLAUDE_PROBE_OUT=$(claude --print "ping" 2>&1)')
    expect(block).not.toContain('MACOS_OAUTH_TOKEN_INPUT')
  })
  it('the service-auth gate that the message points to is still there, after the probe', () => {
    const gate = MACOS.indexOf('INSTALL_AUTH_STATE="BROKEN"')
    expect(gate).toBeGreaterThan(MACOS.indexOf('# Pre-flight headless probe'))
  })
})
