import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

// The helper scripts/approval-envelope.py builds the POST /api/approvals body (content_hash,
// readable description, envelope_v:1 action_payload) from the same PreToolUse input the email
// approval gate sees. The python suite proves hash parity with the gate (MCP and Bash paths, bcc,
// --html/--attach), the refusals (exit 2, empty stdout) and that the helper only reads. This
// wrapper makes that suite a CI gate.
const ROOT = join(__dirname, '..', '..')

describe('approval envelope helper', () => {
  it('the python suite passes (gate hash parity + refusals + read-only)', () => {
    const res = spawnSync('python3', ['-I', join(ROOT, 'scripts', '__tests__', 'approval-envelope.test.py')], {
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
