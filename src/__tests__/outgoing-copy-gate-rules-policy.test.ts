import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

// CLCOPYGATEHIANY902 (owner decision, TG 14442): a MISSING rules file is not
// the same as a BROKEN one. The file is deliberately unshipped (it names a
// private person), so every fresh customer install lacks it -- and the old
// email path fail-closed on that, blocking a paying customer's outbound mail
// (Nova, 2026-09-02). The python suite pins the new policy: missing/empty ->
// fail-open with a LOUD user-visible warning (the warning itself asserted);
// present-but-invalid -> stays fail-closed (negative control); valid rules
// still enforce. This wrapper makes that suite a CI gate.
const ROOT = join(__dirname, '..', '..')

describe('outgoing-copy-gate rules-file policy (CLCOPYGATEHIANY902)', () => {
  it('the python suite passes (missing=open+loud, invalid=closed, valid=enforces)', () => {
    const res = spawnSync('python3', [join(ROOT, 'scripts', '__tests__', 'outgoing-copy-gate-rules-policy.test.py')], {
      encoding: 'utf-8',
      timeout: 120_000,
    })
    if (res.status !== 0) {
      console.error(res.stdout)
      console.error(res.stderr)
    }
    expect(res.status).toBe(0)
  })
})
