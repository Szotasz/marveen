/**
 * D1 static-assertion tests for scripts/verify-channels-health.sh
 *
 * These are STRUCTURAL tests (not behavioral) — they grep the real script file
 * for required patterns (and the absence of the old broken pattern) without
 * executing it.  Full behavioral verification requires tmux mocking and a
 * live process tree, which is out of scope for this unit layer.
 *
 * AC source: docs/channel-watchdog-prompt.md D1 — Definition of Done
 *
 *   D1-DoD-1: The global `pgrep -af 'bun server.ts'` fallback is removed entirely.
 *   D1-DoD-2: Session-absent path fails with a note and fail=1 (not silently passes).
 *   D1-DoD-3: Only descendants of the pane PID are considered — the walk uses
 *             pgrep -P rooted at #{pane_pid}.
 *   D1-DoD-4: CLAUDE_PID derivation (lines for --channels plugin:) is preserved
 *             for checks (b) and (c).
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
// PROJECT_ROOT two directories up from src/__tests__
const SCRIPT_PATH = join(__dirname, '../../scripts/verify-channels-health.sh')

function readScript(): string {
  return readFileSync(SCRIPT_PATH, 'utf-8')
}

describe('D1 — verify-channels-health.sh static assertions', () => {

  // D1-DoD-1: The old global fallback must not appear anywhere in the script.
  // Mental-revert evidence: if the old fallback were reintroduced, this test
  // would fail because the forbidden pattern would be present in the script.
  it("D1-DoD-1: does NOT contain the old global 'pgrep -af bun server.ts' fallback", () => {
    const src = readScript()
    // The old offending line was: pgrep -af 'bun server.ts' | awk '{print $1}' | head -1
    // Match broadly: any pgrep with -af and 'bun server.ts' (not rooted at a specific PID).
    expect(src).not.toMatch(/pgrep\s+-af\s+'bun server\.ts'/)
    // Also ensure the original awk extraction pattern from the global scan is gone.
    expect(src).not.toMatch(/pgrep -af.*bun server\.ts.*awk/)
  })

  // D1-DoD-2: When the session is not found, the script must fail with a note
  // and set fail=1. The pane-absent guard uses `tmux list-panes -t "$SESSION"`.
  it('D1-DoD-2: has session-absent guard that sets fail=1 when pane PID is empty', () => {
    const src = readScript()
    // The guard checks PANE_PID is empty and then notes failure and sets fail=1.
    expect(src).toMatch(/PANE_PID=.*tmux list-panes.*pane_pid/)
    expect(src).toMatch(/-z.*PANE_PID/)
    expect(src).toMatch(/fail=1/)
  })

  // D1-DoD-3: The (a)-check walks descendants of the pane PID using pgrep -P,
  // rooted at the pane shell's PID — never a global scan.
  it('D1-DoD-3: walks process tree rooted at pane PID via pgrep -P', () => {
    const src = readScript()
    // The loop uses pgrep -P $_p to walk descendants.
    expect(src).toMatch(/pgrep\s+-P/)
    // The root variable is the pane PID from tmux list-panes.
    expect(src).toMatch(/#{pane_pid}/)
  })

  // D1-DoD-4: CLAUDE_PID derivation (for checks (b)/(c)) must still be present.
  // The derivation matches '--channels plugin:' in the process list.
  it('D1-DoD-4: preserves CLAUDE_PID derivation for --channels plugin: (used by (b) and (c))', () => {
    const src = readScript()
    expect(src).toMatch(/--channels plugin:/)
    expect(src).toMatch(/CLAUDE_PID/)
  })

  // D1-DoD-5: Script exits 0 only when all checks pass; exits 1 on any failure.
  // The convention is `exit "$fail"` where fail starts at 0.
  it('D1-DoD-5: uses exit "$fail" so 0 = HEALTHY, 1 = any failure', () => {
    const src = readScript()
    expect(src).toMatch(/exit.*\$fail/)
    expect(src).toMatch(/fail=0/)
  })
})
