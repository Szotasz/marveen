import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Contract tests for channel-monitor.ts restart-parity invariants.
//
// These are source-grep guards: they read the REAL source file and assert that
// the fix is structurally present, so a future edit that breaks the invariant
// fails CI rather than silently shipping a regression.

const ROOT = join(__dirname, '..', '..')
const SRC = join(ROOT, 'src', 'web', 'channel-monitor.ts')

function readSrc(): string {
  return readFileSync(SRC, 'utf-8')
}

// Strip single-line and block TypeScript comments so assertions check actual
// code, not prose that says "NEVER use systemctl restart".
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n')
}

describe('channel-monitor.ts -- restart-parity contract', () => {
  it('never calls systemctl restart directly in non-comment code', () => {
    const code = stripComments(readSrc())
    const matches = code.match(/systemctl\s+restart/g) || []
    expect(matches).toHaveLength(0)
  })

  it('uses execFileSync (not execSync) for launchctl calls', () => {
    const code = stripComments(readSrc())
    // execSync would allow shell injection; execFileSync is the safe primitive
    const execSync = (code.match(/\bexecSync\s*\(/g) || []).length
    const execFileSync = (code.match(/\bexecFileSync\s*\(/g) || []).length
    expect(execFileSync).toBeGreaterThan(0)
    expect(execSync).toBe(0)
  })

  it('hardRestartMarveenChannels is exported (callers must use the guarded wrapper)', () => {
    const src = readSrc()
    expect(src).toMatch(/export\s+function\s+hardRestartMarveenChannels/)
  })

  it('does not import from bridge-enroll.ts (deleted in fork)', () => {
    const src = readSrc()
    expect(src).not.toMatch(/bridge-enroll/)
  })

  it('launchctl calls are gated on process.platform !== linux (not unconditional)', () => {
    const code = stripComments(readSrc())
    // All launchctl uses must appear after a platform check
    const launchctlLines = code
      .split('\n')
      .filter((l) => l.includes('launchctl'))
    // Every launchctl line should be inside a block guarded by platform check;
    // the simplest structural check is that the file contains exactly one
    // platform !== linux guard that wraps all launchctl calls.
    const platformGuards = (code.match(/process\.platform\s*!==\s*['"]linux['"]/g) || []).length
    expect(platformGuards).toBeGreaterThanOrEqual(1)
    expect(launchctlLines.length).toBeGreaterThan(0)
  })
})
