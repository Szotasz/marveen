import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

// LEDGERCWD828: the outbound ledger derived agent_id from the session's shell
// cwd, which is MUTABLE -- the main agent stepping into agents/<x>/ for a
// measurement re-attributed its own replies to <x> (51 rows under 7 names on
// the owner chat, several of them plain directory names), and the reply guard
// then triple-sent an already-answered link. The python suite asserts the
// transcript-anchored resolver: the incident shape as a known positive, a real
// sub-agent as the negative control, and an end-to-end run of the actual
// ledger-outbound hook into a temp DB. This wrapper makes that suite a CI
// gate -- before it, nothing executed scripts/__tests__/ledger-agent-id.test.py.
const ROOT = join(__dirname, '..', '..')

describe('ledger agent identity is anchored to the session, not the cwd', () => {
  it('the python suite passes (resolver cases + end-to-end outbound rows)', () => {
    const res = spawnSync('python3', [join(ROOT, 'scripts', '__tests__', 'ledger-agent-id.test.py')], {
      encoding: 'utf-8',
      timeout: 120_000,
    })
    if (res.status !== 0) {
      // Surface the python output so a failure names the exact case.
      console.error(res.stdout)
      console.error(res.stderr)
    }
    expect(res.status).toBe(0)
  })
})
