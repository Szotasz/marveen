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
import { SKIP_REASON, hasSkipReason, suiteOutcome } from './setup/suite-outcome.js'

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

  // it.for, not it.each: the case function gets the test context, and ctx.skip() makes the
  // outcome a SKIPPED test that the reporter counts and shows. An early `return` from an `it`
  // titled "passes" is counted as a pass, which is the silent skip this branch exists to prevent.
  it.for(SUITES)('%s passes', { timeout: 310_000 }, (name, ctx) => {
    const runner = name.endsWith('.py') ? 'python3' : 'bash'
    const res = spawnSync(runner, [join(DIR, name)], {
      encoding: 'utf-8',
      timeout: 300_000,
      cwd: ROOT,
    })
    if (suiteOutcome(res.status) === 'skip') {
      // A suite whose positive control cannot be met on this platform has
      // measured NOTHING here. Failing it is a false alarm (see wait-for on
      // macOS); passing it silently is worse, because a skip would then be
      // indistinguishable from a green run. So it is a counted skip, and the
      // reason is required to be there -- a bare 77 with no explanation is a
      // failure. The streams are joined with a newline so that the marker on
      // stderr starts a line even when stdout did not end with one.
      const why = `${res.stdout ?? ''}\n${res.stderr ?? ''}`
      expect(hasSkipReason(why), `${name} exited 77 without a "SKIP (control unmet)" line:\n${why}`).toBe(true)
      const line = why.split('\n').find((l) => SKIP_REASON.test(l)) ?? 'control unmet'
      ctx.skip(`${name}: ${line}`)
      return
    }
    if (res.status !== 0) {
      console.error(`--- ${name} stdout ---\n${res.stdout ?? ''}`)
      console.error(`--- ${name} stderr ---\n${res.stderr ?? ''}`)
    }
    expect(res.status).toBe(0)
  })
})
