import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SKIP_EXIT, suiteOutcome } from './setup/suite-outcome.js'

// WAITFORSKIP925. A suite whose positive control cannot be met on this platform
// has measured NOTHING. Both obvious answers are wrong:
//
//   fail  -- a red that means "could not measure here" is a false alarm, and a
//            false alarm costs the same attention as a real one. Measured by
//            the reviewer on macOS: wait-for.test.sh exited 2 at its own
//            control (pgrep does not see the calling shell there), the runner
//            requires 0, and the whole vitest run went red on a platform where
//            the script under test is CORRECT.
//   pass  -- then a skip is indistinguishable from a green run, which is the
//            silent-skip shape this fleet keeps paying for.
//
// So there is a third answer, and this file pins it rather than trusting the
// loop in script-tests-runner.test.ts to keep getting it right.

describe('the suite runner tells a SKIP apart from a pass and from a failure', () => {
  it('0 is a pass, 77 is a skip, anything else is a failure', () => {
    expect(suiteOutcome(0)).toBe('pass')
    expect(suiteOutcome(SKIP_EXIT)).toBe('skip')
    expect(suiteOutcome(1)).toBe('fail')
    expect(suiteOutcome(2)).toBe('fail')   // the instrument codes stay failures
    expect(suiteOutcome(null)).toBe('fail') // killed / timed out
  })

  it('77 is NOT 0: the two answers must not collapse into one', () => {
    // The whole point. If someone "simplifies" SKIP_EXIT to 0, this fails
    // before the silent skip can reach a real suite.
    expect(SKIP_EXIT).not.toBe(0)
  })

  it('a shell suite really can produce the skip code (end to end, not just the constant)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skipcode-'))
    try {
      const f = join(dir, 'x.test.sh')
      writeFileSync(f, '#!/usr/bin/env bash\necho "SKIP (control unmet): nothing to measure here" >&2\nexit 77\n')
      const res = spawnSync('bash', [f], { encoding: 'utf-8' })
      expect(suiteOutcome(res.status)).toBe('skip')
      expect(res.stderr).toMatch(/SKIP/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('wait-for.test.sh says SKIP out loud when its control is unmet', () => {
    // The reason is required by the runner, so it is required here too: a bare
    // 77 with no explanation is a failure, not a skip.
    const src = spawnSync('grep', ['-c', 'SKIP (control unmet)', 'scripts/__tests__/wait-for.test.sh'], {
      encoding: 'utf-8',
    })
    expect(Number(src.stdout.trim())).toBeGreaterThan(0)
  })
})
