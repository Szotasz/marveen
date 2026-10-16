import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

// EMAILKAPU901 PR1: collect_bash_body/collect_mcp_body moved from
// outgoing-copy-gate.py into the shared scripts/hooks/email_extract.py, so the
// level-2 email approval gate (PR2) can hash the SAME letter the copy gate
// audits -- one extraction implementation, two consumers. The python suite
// pins byte-parity against a golden captured from the pre-move code (four
// mandated forms + MCP + exact unreadable_reason strings), runs mutation
// canaries so a non-looking comparison fails loudly, and proves the gate
// stays fail-closed (exit 2) when the module itself is missing. This wrapper
// makes that suite a CI gate.
const ROOT = join(__dirname, '..', '..')

describe('email extraction module parity (EMAILKAPU901 PR1)', () => {
  it('the python suite passes (golden parity + canaries + import fail-closed)', () => {
    const res = spawnSync('python3', [join(ROOT, 'scripts', '__tests__', 'email-extract-parity.test.py')], {
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
