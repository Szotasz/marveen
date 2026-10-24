import { describe, expect, it } from 'vitest'
import { senderRoleGateEnabled } from '../web/agent-config.js'

// The wiring half of the sender-role gate: which agent-config.json values make
// the launcher wire scripts/hooks/sender-role-gate.py as a PreToolUse hook.
// Only the explicit "off" shapes (key absent, or a plain object whose
// riskyTools is missing/empty) are false; every malformed shape is TRUE so
// the hook is wired and fails closed on its side.
const CASES: ReadonlyArray<readonly [unknown, boolean]> = [
  [{}, false],
  [{ senderRoleGate: { riskyTools: [] } }, false],
  [{ senderRoleGate: {} }, false],
  [{ senderRoleGate: { riskyTools: ['Bash'] } }, true],
  [{ senderRoleGate: 'x' }, true],
  [{ senderRoleGate: null }, true],
  [{ senderRoleGate: [] }, true],
  [{ senderRoleGate: { riskyTools: 'Bash' } }, true],
  ['x', false],
  [null, false],
  [[], false],
]

describe('senderRoleGateEnabled', () => {
  it.each(CASES)('%j -> %s', (config, expected) => {
    expect(senderRoleGateEnabled(config)).toBe(expected)
  })
})
