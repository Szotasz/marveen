import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

// EMAILKAPU901 PR2: the email_send autonomy level becomes a real switch on the
// main agent (scripts/hooks/email-approval-gate.py, wired in the repo's
// .claude/settings.json). The python suite proves all three level branches,
// the one-shot + time-window approval semantics against a real SQLite store,
// the four-field anchor (an approved letter re-addressed to a different
// recipient or cc is denied), and each fail-closed branch separately (missing
// DB, missing/corrupt config, unreadable letter, missing recipient, non-dict
// input). This wrapper makes that suite a CI gate.
const ROOT = join(__dirname, '..', '..')

describe('email approval gate levels (EMAILKAPU901 PR2)', () => {
  it('the python suite passes (levels + one-shot + window + anchor + fail-closed)', () => {
    const res = spawnSync('python3', [join(ROOT, 'scripts', '__tests__', 'email-approval-gate.test.py')], {
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
