// Every scripts/__tests__ suite runs in CI, discovered, not enumerated.
//
// Measured 2026-09-05: scripts/__tests__ held 29 executable suites and only 4
// were reachable from the vitest run -- the other 25 had never been executed by
// anything but a human typing their path. Among the dead ones were the gate's
// own fail-closed exit-code contract (outgoing-copy-gate-failclosed), the shell
// portability suite written the night before, and the hook double-run audit.
// Two of the 25 were in fact FAILING: seed-skills asserted a template sentence
// that 827491c rewrote away, and stop-start-system-unit asserted the systemd
// branch on a machine that has no systemd. Nobody could know, because nothing
// ran them.
//
// Enumerating them here would rot the same way, so the list is discovered from
// disk: a new scripts/__tests__/*.test.sh is in CI the moment it is written.
// The four suites with their own dedicated wrapper run twice; that is the cheap
// direction of the trade, because deleting a wrapper must not silently retire a
// suite.
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', '..')
const DIR = join(ROOT, 'scripts', '__tests__')

// `*-test.py` is the older naming; both spellings are real suites in this tree.
const SUITES = readdirSync(DIR)
  .filter((f) => /\.test\.(sh|py)$/.test(f) || /-test\.py$/.test(f))
  .sort()

describe('scripts/__tests__ suites', () => {
  it('finds the suites on disk (a rename must not silently empty this run)', () => {
    expect(SUITES.length).toBeGreaterThan(20)
  })

  it.each(SUITES)('%s passes', (name) => {
    const runner = name.endsWith('.py') ? 'python3' : 'bash'
    const res = spawnSync(runner, [join(DIR, name)], {
      encoding: 'utf-8',
      timeout: 300_000,
      cwd: ROOT,
    })
    if (res.status !== 0) {
      console.error(`--- ${name} stdout ---\n${res.stdout ?? ''}`)
      console.error(`--- ${name} stderr ---\n${res.stderr ?? ''}`)
    }
    expect(res.status).toBe(0)
  }, 310_000)
})
